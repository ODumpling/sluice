/**
 * M3 exit — the north-star demo as an automated e2e test:
 *  1. a human approves 5 acceptance scenarios for "cancellation takes effect next cycle";
 *  2. an agent PR cancels immediately (with passing unit tests);
 *  3. `sluice gate run` FAILS it, showing the violated scenarios, a behavior diff
 *     (API response + DB writes vs base) and a mutation proof;
 *  4. a correct PR PASSES; both reports are posted as GitHub checks + HTML artifacts.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runCli, type HostIO } from '@sluice-dev/cli';
import { FakeServer, GitHubFake, SimClock } from '@sluice-dev/fakes';
import type { GateReport } from '@sluice-dev/plugin-gate';
// @ts-expect-error -- plain ESM helper shared with `pnpm demo`
import { PRS, commitAll, createPrBranch, initDemoRepo } from '../../scripts/demo/demo-repo.mjs';

const clock = new SimClock(Date.UTC(2030, 0, 15, 12));
const github = new GitHubFake({ clock });
const ghServer = new FakeServer(github, { clock });

function io(cwd: string, env: Record<string, string> = {}): HostIO & { out: () => string } {
  let out = '';
  return {
    cwd,
    env,
    stdout: { write: (t) => void (out += t) },
    stderr: { write: (t) => void process.stderr.write(t) },
    out: () => out,
  };
}

describe('north-star demo (M3)', () => {
  let repo: string;
  let env: Record<string, string>;
  const reports: Record<'bad' | 'good', GateReport> = {} as never;
  const html: Record<'bad' | 'good', string> = {} as never;
  const exit: Record<'bad' | 'good', number> = {} as never;

  beforeAll(async () => {
    await ghServer.start();
    github.createRepo({ owner: 'acme', name: 'billing-demo' });
    github.issueToken('ghs_ci_token', {
      login: 'github-actions[bot]',
      repos: ['acme/billing-demo'],
      permissions: { checks: 'write', metadata: 'read' },
    });
    env = { GITHUB_API_URL: ghServer.url, GITHUB_TOKEN: 'ghs_ci_token', GITHUB_REPOSITORY: 'acme/billing-demo' };
    repo = initDemoRepo() as string;
  });
  afterAll(() => ghServer.stop());

  it('1. a human reviews and approves the 5 proposed scenarios', async () => {
    const status = io(repo);
    expect(await runCli(['gate', 'status', 'CANCEL-1'], status)).toBe(0);
    expect(status.out().match(/\[unapproved\]/g)).toHaveLength(5);
    const approve = io(repo);
    expect(await runCli(['gate', 'approve', 'CANCEL-1', '--as', 'po@acme.test'], approve)).toBe(0);
    expect(approve.out()).toContain('po@acme.test approved 5 scenario(s)');
    commitAll(repo, 'CANCEL-1: approve acceptance scenarios');
    const after = io(repo);
    await runCli(['gate', 'status', 'CANCEL-1'], after);
    expect(after.out().match(/\[approved\]/g)).toHaveLength(5);
  });

  it('2. agents open two PRs, both with passing unit tests', () => {
    for (const k of ['bad', 'good'] as const) createPrBranch(repo, PRS[k]);
  });

  it('3+4. the gate runs on both PRs and posts GitHub checks + HTML reports', async () => {
    for (const k of ['bad', 'good'] as const) {
      const t = io(repo, env);
      exit[k] = await runCli(
        ['gate', 'run', '--ticket', 'CANCEL-1', '--base', 'main', '--head', PRS[k].branch, '--github-check', '--json'],
        t,
      );
      reports[k] = JSON.parse(t.out()) as GateReport;
      const file = join(repo, '.sluice', 'reports', `gate-CANCEL-1-${reports[k].head.sha.slice(0, 8)}.html`);
      expect(existsSync(file)).toBe(true);
      html[k] = readFileSync(file, 'utf8');
    }
  });

  it('3. the immediate-cancel PR FAILS, naming the violated scenarios', () => {
    const r = reports.bad;
    expect(exit.bad).toBe(1);
    expect(r.verdict).toBe('fail');
    expect(r.unitTests).toMatchObject({ passed: true }); // its own unit tests pass…
    const failed = r.scenarios.filter((s) => !s.passed).map((s) => s.id);
    expect(failed).toEqual([
      'access-continues-until-period-end',
      'cancel-keeps-subscription-active',
      'stripe-cancels-at-period-end',
    ]);
    const cancel = r.scenarios.find((s) => s.id === 'cancel-keeps-subscription-active')!;
    expect(cancel.failures[0]!.message).toContain('body.status expected "active", got "canceled"');
    const stripe = r.scenarios.find((s) => s.id === 'stripe-cancels-at-period-end')!;
    expect(stripe.failures.map((f) => f.message).join('\n')).toMatch(
      /the app called stripe DELETE \/v1\/subscriptions\//,
    );
  });

  it('3. …with a behavior diff vs base: API response and DB writes', () => {
    const diff = reports.bad.scenarios.find((s) => s.id === 'cancel-keeps-subscription-active')!.diff;
    // base has no cancel endpoint (404); the PR returns a canceled subscription
    expect(diff).toContainEqual(
      expect.objectContaining({ step: 2, channel: 'response', path: 'status', before: 404, after: 200 }),
    );
    expect(diff).toContainEqual(
      expect.objectContaining({ step: 2, channel: 'response', path: 'body.status', kind: 'added', after: 'canceled' }),
    );
    // DB write: the PR sets status=canceled right away
    expect(diff).toContainEqual(
      expect.objectContaining({
        step: 2,
        channel: 'db',
        kind: 'added',
        after: expect.objectContaining({
          table: 'subscriptions',
          op: 'UPDATE',
          new: expect.objectContaining({ status: 'canceled' }),
        }),
      }),
    );
    // egress: an immediate cancel call to Stripe that base never made
    expect(diff).toContainEqual(
      expect.objectContaining({
        step: 2,
        channel: 'egress',
        kind: 'added',
        after: expect.objectContaining({ method: 'DELETE' }),
      }),
    );
  });

  it('3. …and proof the checks catch deliberately broken versions of the code', () => {
    const m = reports.bad.mutation;
    expect(m.total).toBeGreaterThan(0);
    expect(m.killed).toBeGreaterThan(0);
    expect(m.mutants.filter((x) => x.killed).every((x) => typeof x.killedBy === 'string')).toBe(true);
  });

  it('4. the correct PR PASSES with a strong mutation score', () => {
    const r = reports.good;
    expect(exit.good).toBe(0);
    expect(r.verdict).toBe('pass');
    expect(r.reasons).toEqual([]);
    expect(r.scenarios.every((s) => s.passed)).toBe(true);
    expect(r.scenarios).toHaveLength(5);
    expect(r.mutation.total).toBeGreaterThanOrEqual(5);
    expect(r.mutation.score!).toBeGreaterThanOrEqual(0.8);
    expect(r.contractViolations).toEqual([]);
  });

  it('4. both results are GitHub checks on the PR head commits, and HTML artifacts', () => {
    const runs = github.checkRuns('acme/billing-demo');
    const bad = runs.find((c) => c.head_sha === reports.bad.head.sha)!;
    const good = runs.find((c) => c.head_sha === reports.good.head.sha)!;
    expect(bad).toMatchObject({ name: 'Sluice Gate', status: 'completed', conclusion: 'failure' });
    expect(bad.output.title).toContain('3/5 approved scenarios violated');
    expect(bad.output.summary).toContain('cancel-keeps-subscription-active');
    expect(good).toMatchObject({ name: 'Sluice Gate', status: 'completed', conclusion: 'success' });
    expect(ghServer.violations).toEqual([]);
    expect(html.bad).toContain('Gate closed');
    expect(html.bad).toContain('Behavior diff vs base');
    expect(html.bad).toContain('Mutation proof');
    expect(html.good).toContain('Gate open');
  });

  it('a PR that edits its own gate definitions is rejected', async () => {
    const { git } = await import('../../scripts/demo/demo-repo.mjs' as string);
    git(repo, 'checkout', '-q', '-b', 'agent/sneaky', PRS.good.branch);
    const f = join(repo, '.sluice', 'gate', 'CANCEL-1', 'approvals.json');
    const { writeFileSync } = await import('node:fs');
    writeFileSync(f, readFileSync(f, 'utf8').replace('po@acme.test', 'agent@acme.test'));
    commitAll(repo, 'tweak');
    git(repo, 'checkout', '-q', 'main');
    const t = io(repo, env);
    expect(
      await runCli(['gate', 'run', '--ticket', 'CANCEL-1', '--base', 'main', '--head', 'agent/sneaky', '--json'], t),
    ).toBe(1);
    const r = JSON.parse(t.out()) as GateReport;
    expect(r.reasons[0]).toContain('modifies gate definitions');
  });
});
