/**
 * The north-star demo as an e2e suite, parameterized by the language of the
 * demo app (examples/billing-demo, -go, -dotnet). Every port ships the same
 * ticket, scenarios and PR overlays, so every port must produce the same
 * verdicts: the immediate-cancel PR (passing unit tests) FAILS naming the same
 * 3 scenarios with a behavior diff and mutation proof; the period-end PR PASSES.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runCli, type HostIO } from '@sluice-dev/cli';
import { FakeServer, GitHubFake, SimClock } from '@sluice-dev/fakes';
import type { GateReport } from '@sluice-dev/plugin-gate';
// @ts-expect-error -- plain ESM helper shared with `pnpm demo`
import { commitAll, createPrBranch, initDemoRepo, prsFor } from '../../scripts/demo/demo-repo.mjs';

export type DemoLang = 'node' | 'go' | 'dotnet';

interface Pr {
  branch: string;
  overlay: string;
  title: string;
}

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

export interface NorthStarOptions {
  /** Timeout for the step that runs the gate on both PRs. */
  gateTimeoutMs?: number;
}

export function northStarSuite(lang: DemoLang, opts: NorthStarOptions = {}): void {
  const PRS = prsFor(lang) as Record<'bad' | 'good', Pr>;
  const clock = new SimClock(Date.UTC(2030, 0, 15, 12));
  const github = new GitHubFake({ clock });
  const ghServer = new FakeServer(github, { clock });

  describe(`north-star demo (${lang})`, () => {
    let repo: string;
    let env: Record<string, string>;
    const reports: Record<'bad' | 'good', GateReport> = {} as never;
    const html: Record<'bad' | 'good', string> = {} as never;
    const exit: Record<'bad' | 'good', number> = {} as never;
    const durations: Record<string, number> = {};

    beforeAll(async () => {
      await ghServer.start();
      github.createRepo({ owner: 'acme', name: 'billing-demo' });
      github.issueToken('ghs_ci_token', {
        login: 'github-actions[bot]',
        repos: ['acme/billing-demo'],
        permissions: { checks: 'write', metadata: 'read' },
      });
      env = { GITHUB_API_URL: ghServer.url, GITHUB_TOKEN: 'ghs_ci_token', GITHUB_REPOSITORY: 'acme/billing-demo' };
      repo = initDemoRepo(undefined, lang) as string;
    });
    afterAll(async () => {
      await ghServer.stop();
      if (Object.keys(durations).length)
        process.stderr.write(
          `north-star (${lang}) gate durations: ${Object.entries(durations)
            .map(([k, v]) => `${k} ${(v / 1000).toFixed(1)}s`)
            .join(', ')}\n`,
        );
    });

    it('1. a human reviews and approves the 5 proposed scenarios', async () => {
      const status = io(repo);
      expect(await runCli(['gate', 'status', 'CANCEL-1'], status)).toBe(0);
      expect(status.out().match(/\[unapproved\]/g)).toHaveLength(5);
      const approve = io(repo);
      expect(await runCli(['gate', 'approve', 'CANCEL-1', '--as', 'po@acme.test'], approve)).toBe(0);
      expect(approve.out()).toContain('po@acme.test approved 5 scenario(s)');
      commitAll(repo, 'CANCEL-1: approve acceptance scenarios');
    });

    it('2. agents open two PRs, both with passing unit tests', () => {
      for (const k of ['bad', 'good'] as const) createPrBranch(repo, PRS[k]);
    });

    it(
      '3+4. the gate runs on both PRs and posts GitHub checks + HTML reports',
      async () => {
        for (const k of ['bad', 'good'] as const) {
          const t = io(repo, env);
          const started = Date.now();
          exit[k] = await runCli(
            [
              'gate',
              'run',
              '--ticket',
              'CANCEL-1',
              '--base',
              'main',
              '--head',
              PRS[k].branch,
              '--github-check',
              '--json',
            ],
            t,
          );
          durations[k] = Date.now() - started;
          reports[k] = JSON.parse(t.out()) as GateReport;
          const file = join(repo, '.sluice', 'reports', `gate-CANCEL-1-${reports[k].head.sha.slice(0, 8)}.html`);
          expect(existsSync(file)).toBe(true);
          html[k] = readFileSync(file, 'utf8');
        }
      },
      opts.gateTimeoutMs ?? 1_800_000,
    );

    it('3. the immediate-cancel PR FAILS, naming the violated scenarios', () => {
      const r = reports.bad;
      expect(exit.bad).toBe(1);
      expect(r.verdict).toBe('fail');
      expect(r.unitTests, r.unitTests?.outputTail).toMatchObject({ passed: true }); // its own unit tests pass…
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

    it('3. …with a behavior diff vs base: API response, DB writes and Stripe egress', () => {
      const diff = reports.bad.scenarios.find((s) => s.id === 'cancel-keeps-subscription-active')!.diff;
      expect(diff).toContainEqual(
        expect.objectContaining({ step: 2, channel: 'response', path: 'status', before: 404, after: 200 }),
      );
      expect(diff).toContainEqual(
        expect.objectContaining({
          step: 2,
          channel: 'response',
          path: 'body.status',
          kind: 'added',
          after: 'canceled',
        }),
      );
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
      const survivors = r.mutation.mutants
        .filter((m) => !m.killed)
        .map((m) => `${m.file}:${m.line} ${m.operator} ${m.original} -> ${m.replacement}`);
      expect(r.reasons).toEqual([]);
      expect(exit.good).toBe(0);
      expect(r.verdict).toBe('pass');
      expect(r.unitTests, r.unitTests?.outputTail).toMatchObject({ passed: true });
      expect(r.scenarios.every((s) => s.passed)).toBe(true);
      expect(r.scenarios).toHaveLength(5);
      expect(r.mutation.total).toBeGreaterThanOrEqual(5);
      expect(r.mutation.score!, `survivors:\n${survivors.join('\n')}`).toBeGreaterThanOrEqual(0.8);
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
  });
}
