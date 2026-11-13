import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  GateStore,
  match,
  parseScenarios,
  renderMarkdown,
  scenarioHash,
  validateScenario,
  type GateReport,
} from '@sluice-dev/plugin-gate';

describe('matchers', () => {
  it('partial objects, exact arrays, operators', () => {
    expect(match({ a: 1 }, { a: 1, b: 2 })).toEqual([]);
    expect(match([{ a: 1 }], [{ a: 1 }, { a: 2 }])[0]!.message).toMatch(/1 item\(s\), got 2/);
    expect(match({ $len: 2 }, [1, 2])).toEqual([]);
    expect(match({ $contains: { a: 2 } }, [{ a: 1 }, { a: 2 }])).toEqual([]);
    expect(match({ $gt: '2030-01-01T00:00:00Z' }, '2030-02-01T00:00:00Z')).toEqual([]);
    expect(match({ $regex: '^sub_' }, 'sub_x')).toEqual([]);
    expect(match({ $ne: 'canceled' }, 'canceled')).toHaveLength(1);
    expect(match({ $exists: false }, null)).toEqual([]);
    expect(match({ $in: [1, 2] }, 3)).toHaveLength(1);
    // same instant, different ISO spelling (Postgres vs JS)
    expect(match('2030-02-15T12:00:00.000Z', '2030-02-15T12:00:00+00:00')).toEqual([]);
    expect(match({ a: 'x' }, { a: 'y' })[0]!.message).toBe('$.a expected "x", got "y"');
  });
});

const scenario = {
  id: 'health',
  title: 'health ok',
  steps: [{ http: { method: 'GET', path: '/health' }, expect: { status: 200 } }],
};

describe('scenarios + approvals', () => {
  it('validates scenarios', () => {
    expect(() => validateScenario({ ...scenario, id: 'Bad Id' })).toThrow(/id must match/);
    expect(() => validateScenario({ ...scenario, steps: [{ http: { method: 'GET', path: '/' } }] })).toThrow(
      /must check something/,
    );
    expect(() => validateScenario({ ...scenario, steps: [{ assert: { fake: 'stripe' } }] })).toThrow(/needs matches/);
    expect(
      parseScenarios(
        `id: a1\ntitle: t\nsteps: [{ http: { method: GET, path: / }, expect: { status: 200 } }]\n---\nid: a2\ntitle: t\nsteps: [{ assert: { sql: select 1, rows: [] } }]\n`,
      ),
    ).toHaveLength(2);
  });
  it('hash ignores formatting but not semantics', () => {
    expect(scenarioHash(structuredClone(scenario))).toBe(scenarioHash(scenario));
    expect(scenarioHash({ ...scenario, title: 'other' })).not.toBe(scenarioHash(scenario));
  });
  it('approvals bind to content: editing an approved scenario makes it stale', () => {
    const root = mkdtempSync(join(tmpdir(), 'sluice-gate-'));
    const st = new GateStore(root);
    st.writeTicket({ id: 'T-1', title: 'Ticket', spec: 'spec' });
    st.propose('T-1', [scenario]);
    expect(st.state('T-1')[0]!.status).toBe('unapproved');
    st.approve('T-1', 'po@acme.test');
    expect(st.state('T-1')[0]).toMatchObject({ status: 'approved', approval: { approvedBy: 'po@acme.test' } });
    const f = join(st.ticketDir('T-1'), 'scenarios', 'health.yaml');
    writeFileSync(f, readFileSync(f, 'utf8').replace('status: 200', 'status: 201'));
    expect(st.state('T-1')[0]!.status).toBe('stale');
    expect(() => st.approve('T-1', 'po', ['nope'])).toThrow(/unknown scenario/);
    expect(() => st.approve('T-1', ' ')).toThrow(/approver/);
    expect(() => st.propose('T-1', [scenario, scenario])).toThrow(/duplicate/);
  });
});

describe('report rendering', () => {
  it('markdown summary for a GitHub check stays within limits', () => {
    const r: GateReport = {
      format: 'sluice-gate-report/1',
      ticket: { id: 'T', title: 'Title', spec: 's' },
      verdict: 'fail',
      reasons: ['scenario a failed: x'],
      base: { ref: 'main', sha: 'a'.repeat(40) },
      head: { ref: 'pr', sha: 'b'.repeat(40) },
      approvals: [],
      integrity: { gateFilesModified: [] },
      scenarios: [
        {
          id: 'a',
          title: 'A | pipe',
          passed: false,
          failures: [{ step: 0, stepName: 'GET /', message: 'x'.repeat(100_000) }],
          diff: [],
          basePassed: false,
          durationMs: 1,
        },
      ],
      mutation: { enabled: true, threshold: 0.8, total: 0, killed: 0, score: null, mutants: [] },
      contractViolations: [],
      durationMs: 1,
    };
    const md = renderMarkdown(r);
    expect(md.title).toBe('Sluice Gate failed: 1/1 approved scenarios violated');
    expect(md.summary).toContain('A \\| pipe');
    expect(md.text.length).toBeLessThanOrEqual(65_000);
  });
});
