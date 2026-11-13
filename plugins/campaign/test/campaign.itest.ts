// M7 exit: an e2e campaign drives a 3-repo migration to completion; an injected failure blocks the destructive step.
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCli, type HostIO } from '@sluice-dev/cli';
import { loadCampaign, readState } from '@sluice-dev/plugin-campaign';

const EXAMPLES = join(import.meta.dirname, '..', '..', '..', 'examples');

function workspace(example = 'campaign'): string {
  const dir = join(mkdtempSync(join(tmpdir(), 'sluice-campaign-e2e-')), 'campaign');
  cpSync(join(EXAMPLES, example), dir, { recursive: true, filter: (s) => !s.includes('.sluice') });
  for (const r of ['shared-money', 'checkout', 'invoices']) {
    const g = (...a: string[]) =>
      execFileSync('git', a, { cwd: join(dir, 'repos', r), stdio: 'pipe' })
        .toString()
        .trim();
    g('init', '-q', '-b', 'main');
    g('add', '-A');
    g(
      '-c',
      'user.email=dev@acme.test',
      '-c',
      'user.name=dev',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-qm',
      'initial',
    );
  }
  return dir;
}

async function cli(cwd: string, ...args: string[]) {
  let out = '';
  const io: HostIO = { cwd, env: {}, stdout: { write: (t) => void (out += t) }, stderr: { write: () => {} } };
  return { code: await runCli(args, io), out };
}

const read = (dir: string, repo: string, f: string) => readFileSync(join(dir, 'repos', repo, f), 'utf8');
const gitIn = (dir: string, repo: string, ...a: string[]) =>
  execFileSync('git', a, { cwd: join(dir, 'repos', repo) })
    .toString()
    .trim();

describe('campaign (M7)', () => {
  it('drives the 3-repo migration to completion with evidence at every step', async () => {
    const dir = workspace();
    const r = await cli(dir, 'campaign', 'run', 'campaign.yaml');
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain('campaign money-to-cents completed');
    const s = readState(loadCampaign(join(dir, 'campaign.yaml')))!;
    expect(s.status).toBe('completed');
    for (const [step, repos] of [
      ['expand', ['shared-money']],
      ['migrate', ['checkout', 'invoices']],
      ['contract', ['shared-money']],
    ] as const) {
      for (const repo of repos) {
        const run = s.steps[step]![repo]!;
        expect(run.status).toBe('passed');
        expect(run.evidence.length).toBeGreaterThan(0);
        expect(run.evidence.every((e) => e.passed)).toBe(true);
      }
    }
    // contract ran tests in ALL repos against the library without formatDollars
    expect(s.steps.contract!['shared-money']!.evidence.map((e) => e.repo)).toEqual([
      'shared-money',
      'checkout',
      'invoices',
    ]);
    expect(read(dir, 'shared-money', 'index.js')).not.toContain('formatDollars');
    expect(read(dir, 'invoices', 'src/invoice.js')).toContain(
      'formatCents(Math.round(inv.tax * 100), { symbol: false })',
    );
    expect(gitIn(dir, 'shared-money', 'log', '--format=%s')).toBe(
      'campaign money-to-cents: contract — Remove the deprecated API\ncampaign money-to-cents: expand — Add formatCents next to the deprecated API\ninitial',
    );
    // resuming a completed campaign is a no-op
    expect((await cli(dir, 'campaign', 'run', 'campaign.yaml')).code).toBe(0);
  });

  it('an injected failure rolls the failing step back and blocks the destructive step', async () => {
    const dir = workspace();
    // inject: the codemod misses the two-argument call form
    const yaml = readFileSync(join(dir, 'campaign.yaml'), 'utf8');
    writeFileSync(
      join(dir, 'campaign.yaml'),
      yaml.replace(/^\s+- \{ pattern: 'formatDollars\(\$A, \$OPTS\)'.*\n/m, ''),
    );
    const invoicesBefore = gitIn(dir, 'invoices', 'rev-parse', 'HEAD');
    const r = await cli(dir, 'campaign', 'run', 'campaign.yaml');
    expect(r.code).toBe(1);
    const s = readState(loadCampaign(join(dir, 'campaign.yaml')))!;
    expect(s.status).toBe('failed');
    expect(s.reason).toMatch(/^migrate failed in invoices: .*\(rolled back\)$/);
    expect(s.steps.migrate!.checkout!.status).toBe('passed');
    expect(s.steps.migrate!.invoices).toMatchObject({ status: 'rolled_back' });
    expect(s.steps.migrate!.invoices!.evidence.some((e) => !e.passed)).toBe(true);
    expect(s.steps.contract!['shared-money']).toMatchObject({
      status: 'blocked',
      reason: 'blocked: invoices/migrate did not pass',
    });
    // rollback: invoices is back where it started; the destructive change never happened
    expect(gitIn(dir, 'invoices', 'rev-parse', 'HEAD')).toBe(invoicesBefore);
    expect(read(dir, 'invoices', 'src/invoice.js')).toContain('formatDollars(inv.total)');
    expect(read(dir, 'shared-money', 'index.js')).toContain('export function formatDollars');
    expect((await cli(dir, 'campaign', 'status', 'campaign.yaml')).out).toContain(
      'contract (destructive): shared-money=blocked',
    );

    // fix the campaign (restore the rule) and resume: it completes from where it stopped
    writeFileSync(join(dir, 'campaign.yaml'), yaml);
    const resumed = await cli(dir, 'campaign', 'run', 'campaign.yaml');
    expect(resumed.code, resumed.out).toBe(0);
    expect(resumed.out).not.toContain('expand @ shared-money'); // already passed, not re-run
    expect(readState(loadCampaign(join(dir, 'campaign.yaml')))!.status).toBe('completed');
  });
});

describe('campaign for Go modules', () => {
  it('expand/migrate (go codemod)/contract across three Go modules, evidence offline after prepare', async () => {
    const dir = workspace('campaign-go');
    const r = await cli(dir, 'campaign', 'run', 'campaign.yaml');
    expect(r.code, r.out).toBe(0);
    const s = readState(loadCampaign(join(dir, 'campaign.yaml')))!;
    expect(s.status).toBe('completed');
    expect(s.steps.migrate!.invoices!.changed).toEqual(['invoice.go']);
    expect(s.steps.contract!['shared-money']!.evidence.map((e) => [e.kind, e.repo, e.passed])).toEqual([
      ['tests', 'shared-money', true],
      ['tests', 'checkout', true],
      ['tests', 'invoices', true],
    ]);
    expect(read(dir, 'invoices', 'invoice.go')).toContain(
      'money.FormatCents(money.ToCents(inv.Total)), money.FormatCents(money.ToCents(inv.Tax))',
    );
    expect(read(dir, 'checkout', 'checkout.go')).toContain('money.FormatCents(money.ToCents(sum))');
    expect(read(dir, 'shared-money', 'money.go')).not.toContain('FormatDollars');
  });

  it('a codemod that misses a call site fails the rule evidence and blocks the contract', async () => {
    const dir = workspace('campaign-go');
    const yaml = readFileSync(join(dir, 'campaign.yaml'), 'utf8');
    // inject: only rewrite calls whose argument is a plain identifier (misses inv.Total / inv.Tax)
    writeFileSync(
      join(dir, 'campaign.yaml'),
      yaml.replace("'money.FormatDollars($A)'", "'money.FormatDollars(sum)'").replace('ToCents($A)', 'ToCents(sum)'),
    );
    const r = await cli(dir, 'campaign', 'run', 'campaign.yaml');
    expect(r.code).toBe(1);
    const s = readState(loadCampaign(join(dir, 'campaign.yaml')))!;
    expect(s.steps.migrate!.checkout!.status).toBe('passed');
    expect(s.steps.migrate!.invoices!.status).toBe('rolled_back');
    expect(s.steps.contract!['shared-money']!.status).toBe('blocked');
    expect(read(dir, 'shared-money', 'money.go')).toContain('func FormatDollars');
  });
});

describe('campaign for .NET solutions', () => {
  it('expand/migrate (C# codemod)/contract across three solutions, evidence offline after restore', async () => {
    const dir = workspace('campaign-dotnet');
    const r = await cli(dir, 'campaign', 'run', 'campaign.yaml');
    const s = readState(loadCampaign(join(dir, 'campaign.yaml')))!;
    expect(r.code, r.out + JSON.stringify(s.steps, null, 1)).toBe(0);
    expect(s.status).toBe('completed');
    expect(s.steps.contract!['shared-money']!.evidence.every((e) => e.passed)).toBe(true);
    expect(s.steps.contract!['shared-money']!.evidence.map((e) => e.repo)).toEqual([
      'shared-money',
      'checkout',
      'invoices',
    ]);
    expect(read(dir, 'invoices', 'Invoices/Invoice.cs')).toContain(
      '{Money.FormatCents(Money.ToCents(Total))} (tax {Money.FormatCents(Money.ToCents(Tax))})',
    );
    expect(read(dir, 'checkout', 'Checkout/Cart.cs')).toContain(
      'Money.FormatCents(Money.ToCents(lines.Sum(l => l.Price * l.Qty)))',
    );
    expect(read(dir, 'shared-money', 'Money/Money.cs')).not.toContain('FormatDollars');
  });
});
