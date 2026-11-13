import type { Sandbox } from '@sluice-dev/sandbox';
import { describe, expect, it } from 'vitest';
import {
  headline,
  renderHtml,
  renderMarkdown,
  renderText,
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

  it('a mutant that does not build/start is invalid, with the startup output', async () => {
    const out = ['service api exited during startup:', ...Array.from({ length: 40 }, (_, i) => `log ${i}`)];
    out.push('./main.go:12:2: declared and not used: x');
    const sb = fakeSandbox(async () => {
      throw new Error(out.join('\n'));
    });
    const r = await runMutantScenario(sb, scenario, '/tmp/mutant', 'mutant m1');
    expect(r.kind).toBe('invalid');
    if (r.kind !== 'invalid') return;
    expect(r.detail.split('\n')[0]).toBe('service api exited during startup:');
    expect(r.detail).toContain('declared and not used: x');
    expect(r.detail.split('\n').length).toBeLessThanOrEqual(26);
  });

  it('an error after startup is a behaviour change, not invalid', async () => {
    const sb = fakeSandbox(async () => {});
    (sb as unknown as { advance: () => Promise<void> }).advance = async () => {
      throw new Error('fetch failed: socket hang up');
    };
    const r = await runMutantScenario(sb, scenario, '/tmp/mutant', 'mutant m1');
    expect(r).toEqual({ kind: 'error', detail: 'fetch failed: socket hang up' });
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

function report(mutants: MutantReport[]): GateReport {
  const killed = mutants.filter((m) => m.status === 'killed').length;
  const invalid = mutants.filter((m) => m.status === 'invalid').length;
  return {
    format: 'sluice-gate-report/1',
    ticket: { id: 'T', title: 'Title', spec: 's' },
    verdict: 'pass',
    reasons: [],
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
      score: mutants.length - invalid ? killed / (mutants.length - invalid) : null,
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
      'mutation proof: 1/2 deliberately broken versions caught (1 more did not build/start, not scored)',
    );
    const md = renderMarkdown(r);
    expect(md.summary).toContain('1/2 deliberately broken versions');
    expect(md.text).toContain('⛔ invalid — did not build/start (not scored)');
    expect(md.text).toContain('✅ `ticks`');
    expect(md.text).toContain('⚠️ survived');
    const html = renderHtml(r);
    expect(html).toContain('<span class="invalid">invalid</span>');
    expect(html).toContain('./main.go:3: invalid operation');
    expect(html).toContain('1 more mutant did not build/start and is not scored');
  });

  it('all invalid: no score', () => {
    const all = report([mutant('invalid'), mutant('invalid')]);
    expect(all.mutation.score).toBeNull();
    expect(headline(all)).not.toContain('mutation');
    expect(renderText(all)).toContain(
      '0/0 deliberately broken versions caught (2 more did not build/start, not scored)',
    );
  });

  it('reads reports written before mutant status existed', () => {
    const old = report([mutant('killed', { killedBy: 'ticks' })]);
    delete (old.mutation.mutants[0] as Partial<MutantReport>).status;
    delete old.mutation.invalid;
    expect(renderMarkdown(old).text).toContain('✅ `ticks`');
    expect(headline(old)).toContain('mutation 1/1');
  });
});
