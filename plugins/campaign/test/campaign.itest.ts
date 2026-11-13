// M7 exit: an e2e campaign drives a 3-repo migration to completion; an injected failure blocks the destructive step.
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCli, type HostIO } from '@sluice-dev/cli';
import { loadCampaign, readState } from '@sluice-dev/plugin-campaign';

const EXAMPLE = join(import.meta.dirname, '..', '..', '..', 'examples', 'campaign');

function workspace(): string {
  const dir = join(mkdtempSync(join(tmpdir(), 'sluice-campaign-e2e-')), 'campaign');
  cpSync(EXAMPLE, dir, { recursive: true, filter: (s) => !s.includes('.sluice') });
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
