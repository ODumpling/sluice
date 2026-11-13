import type { Sandbox } from '@sluice-dev/sandbox';
import { describe, expect, it } from 'vitest';
import {
  headline,
  renderHtml,
  renderMarkdown,
  renderText,
  mutationOutcome,
  runMutantScenario,
  type GateReport,
  type MutantReport,
  type Scenario,
} from '../src/index.js';

/** Just enough of a Sandbox for runScript: no database, no fakes, no deterministic services. */
function fakeSandbox(reset: () => Promise<void>): Sandbox & { resets: unknown[] } {
  let now = 0;
  const resets: unknown[] = [];
  return {
    resets,
    spec: { seed: 1 },
    fakes: new Map(),
    deterministicServices: [],
    clock: { now: () => now },
    async reset(o: unknown) {
      resets.push(o);
      await reset();
    },
    async advance(ms: number) {
      now += ms;
    },
  } as unknown as Sandbox & { resets: unknown[] };
}

const scenario: Scenario = { id: 'ticks', title: 'time passes', steps: [{ advance: '1d' }] };
const failing: Scenario = {
  id: 'needs-egress',
  title: 'calls out',
  steps: [{ advance: '1d' }, { assert: { egress: { some: { fake: 'stripe' } } } }],
};

describe('runMutantScenario', () => {
  it('runs the scenario against the mutant tree', async () => {
    const sb = fakeSandbox(async () => {});
    const r = await runMutantScenario(sb, scenario, '/tmp/mutant', 'mutant m1');
    expect(r.kind).toBe('ran');
    expect(r.kind === 'ran' && r.run.passed).toBe(true);
    expect(sb.resets).toEqual([{ sourceRoot: '/tmp/mutant', seed: undefined }]);
    const f = await runMutantScenario(sb, failing, '/tmp/mutant', 'mutant m1');
    expect(f.kind === 'ran' && f.run.passed).toBe(false);
  });

  const exited = (...log: string[]) => ['service app exited during startup:', ...log].join('\n');
  const failingReset = (msg: string) =>
    fakeSandbox(async () => {
      throw new Error(msg);
    });

  it('a Go mutant that does not compile is invalid, with the compiler output', async () => {
    const log = [
      ...Array.from({ length: 40 }, (_, i) => `log ${i}`),
      '# billing-demo/src',
      './main.go:12:2: declared and not used: x',
    ];
    const r = await runMutantScenario(failingReset(exited(...log)), scenario, '/t', 'm', { language: 'go' });
    expect(r.kind).toBe('invalid');
    if (r.kind !== 'invalid') return;
    expect(r.detail.split('\n')[0]).toBe('service app exited during startup:');
    expect(r.detail).toContain('declared and not used: x');
    expect(r.detail.split('\n').length).toBeLessThanOrEqual(26);
  });

  it('a C# mutant that does not compile is invalid', async () => {
    const out = exited('/app/src/Billing.cs(12,9): error CS0103: The name x does not exist [/app/BillingDemo.csproj]');
    expect((await runMutantScenario(failingReset(out), scenario, '/t', 'm', { language: 'csharp' })).kind).toBe(
      'invalid',
    );
    // compiler output of another language does not count
    expect((await runMutantScenario(failingReset(out), scenario, '/t', 'm', { language: 'go' })).kind).toBe('broken');
  });

  it('JS/TS startup failures, crashes and readiness timeouts are killed, not invalid', async () => {
    const cases: [string, Parameters<typeof runMutantScenario>[4]][] = [
      [exited('/app/src/x.ts:3:5: SyntaxError: Unexpected token'), { language: 'typescript' }],
      [exited('panic: runtime error: invalid memory address', 'main.go:40 +0x1d'), { language: 'go' }],
      [exited('2026/01/01 00:00:00 listen: address in use'), { language: 'go' }],
      [exited('Unhandled exception. System.NullReferenceException'), { language: 'csharp' }],
      ['timed out after 90000ms waiting for app (http /health)', { language: 'go' }],
    ];
    for (const [msg, opts] of cases) {
      const r = await runMutantScenario(failingReset(msg), scenario, '/t', 'm', opts);
      expect(r.kind, msg).toBe('broken');
      expect(r.kind === 'broken' && r.detail).toMatch(/^app did not start: /);
    }
  });

  it('a startup sandbox error is retried once, then counted as killed', async () => {
    let n = 0;
    const flaky = fakeSandbox(async () => {
      if (n++ === 0) throw new Error('docker run failed: Cannot connect to the Docker daemon');
    });
    const logs: string[] = [];
    expect(
      (await runMutantScenario(flaky, scenario, '/t', 'm', { language: 'go', log: (l) => logs.push(l) })).kind,
    ).toBe('ran');
    expect(flaky.resets).toHaveLength(2);
    expect(logs[0]).toContain('sandbox error, retrying ticks');
    const down = failingReset('docker run failed: Cannot connect to the Docker daemon');
    const r = await runMutantScenario(down, scenario, '/t', 'm', { language: 'go' });
    expect(r).toEqual({
      kind: 'broken',
      detail: 'sandbox error (after retry): docker run failed: Cannot connect to the Docker daemon',
    });
    expect(down.resets).toHaveLength(2);
  });

  it('after startup: the app breaking a request is killed at once; other errors are retried', async () => {
    const sb = fakeSandbox(async () => {});
    const reset = Object.assign(new TypeError('fetch failed'), {
      cause: { code: 'ECONNRESET', message: 'read ECONNRESET' },
    });
    (sb as unknown as { advance: () => Promise<void> }).advance = async () => {
      throw reset;
    };
    expect(await runMutantScenario(sb, scenario, '/t', 'm')).toEqual({
      kind: 'broken',
      detail: 'scenario errored: fetch failed ECONNRESET read ECONNRESET',
    });
    expect(sb.resets).toHaveLength(1);

    const timeout = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    (sb as unknown as { advance: () => Promise<void> }).advance = async () => {
      throw timeout;
    };
    expect((await runMutantScenario(sb, scenario, '/t', 'm')).kind).toBe('broken');

    let calls = 0;
    (sb as unknown as { advance: () => Promise<void> }).advance = async () => {
      if (calls++ === 0) throw new Error('events from app: HTTP 404');
    };
    sb.resets.length = 0;
    const r = await runMutantScenario(sb, scenario, '/t', 'm');
    expect(r.kind === 'ran' && r.run.passed).toBe(true);
    expect(sb.resets).toHaveLength(2);
  });
});

describe('mutationOutcome', () => {
  const st = (...s: MutantReport['status'][]) => s.map((status) => ({ status }));
  it('scores valid mutants only', () => {
    expect(mutationOutcome(st('killed', 'survived', 'invalid'), 0.4)).toEqual({ killed: 1, invalid: 1, score: 0.5 });
    expect(mutationOutcome([], 0.8)).toEqual({ killed: 0, invalid: 0, score: null });
  });
  it('too weak only when nothing else fails the gate', () => {
    expect(mutationOutcome(st('killed', 'survived', 'invalid'), 0.8).reason).toBe(
      'checks too weak: only 1/2 deliberately broken versions were caught (threshold 80%; 1 mutant did not compile and is excluded)',
    );
    expect(mutationOutcome(st('survived'), 0.8, { othersFailing: true }).reason).toBeUndefined();
  });
  it('all invalid is inconclusive: the gate fails', () => {
    expect(mutationOutcome(st('invalid', 'invalid'), 0.8)).toEqual({
      killed: 0,
      invalid: 2,
      score: null,
      reason: 'mutation proof inconclusive: all 2 mutants failed to compile',
    });
  });
});

const mutant = (status: MutantReport['status'], extra: Partial<MutantReport> = {}): MutantReport => ({
  id: `main.go:3:${status}`,
  file: 'main.go',
  line: 3,
  operator: 'binary-operator',
  original: '<',
  replacement: '<=',
  status,
  killed: status === 'killed',
  ...extra,
});

/** A report as runGate assembles it (verdict from the mutation outcome alone). */
function report(mutants: MutantReport[]): GateReport {
  const { killed, invalid, score, reason } = mutationOutcome(mutants, 0.4);
  return {
    format: 'sluice-gate-report/1',
    ticket: { id: 'T', title: 'Title', spec: 's' },
    verdict: reason ? 'fail' : 'pass',
    reasons: reason ? [reason] : [],
    base: { ref: 'main', sha: 'a'.repeat(40) },
    head: { ref: 'pr', sha: 'b'.repeat(40) },
    approvals: [],
    integrity: { gateFilesModified: [] },
    scenarios: [],
    mutation: {
      enabled: true,
      threshold: 0.8,
      total: mutants.length,
      killed,
      invalid,
      score,
      mutants,
    },
    contractViolations: [],
    durationMs: 1,
  };
}

describe('report: invalid mutants', () => {
  const r = report([
    mutant('killed', { killedBy: 'ticks' }),
    mutant('survived'),
    mutant('invalid', { detail: 'service api exited during startup:\n./main.go:3: invalid operation' }),
  ]);

  it('excludes them from the score in every format', () => {
    expect(headline(r)).toContain('mutation 1/2');
    expect(renderText(r)).toContain(
      'mutation proof: 1/2 deliberately broken versions caught (1 more did not compile, not scored)',
    );
    const md = renderMarkdown(r);
    expect(md.summary).toContain('1/2 deliberately broken versions');
    expect(md.text).toContain('⛔ invalid — did not compile (not scored)');
    expect(md.text).toContain('✅ `ticks`');
    expect(md.text).toContain('⚠️ survived');
    const html = renderHtml(r);
    expect(html).toContain('<span class="invalid">invalid</span>');
    expect(html).toContain('./main.go:3: invalid operation');
    expect(html).toContain('1 more mutant did not compile and is not scored');
  });

  it('all invalid: no score, and the gate fails as inconclusive', () => {
    const all = report([mutant('invalid'), mutant('invalid')]);
    expect(all.mutation.score).toBeNull();
    expect(all.verdict).toBe('fail');
    expect(headline(all)).toBe('Sluice Gate failed: mutation proof inconclusive: all 2 mutants failed to compile');
    expect(r.verdict).toBe('pass');
    expect(renderText(all)).toContain('0/0 deliberately broken versions caught (2 more did not compile, not scored)');
  });

  it('reads reports written before mutant status existed', () => {
    const old = report([mutant('killed', { killedBy: 'ticks' })]);
    delete (old.mutation.mutants[0] as Partial<MutantReport>).status;
    delete old.mutation.invalid;
    expect(renderMarkdown(old).text).toContain('✅ `ticks`');
    expect(headline(old)).toContain('mutation 1/1');
  });
});
