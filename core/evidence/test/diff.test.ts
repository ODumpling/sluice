import { describe, expect, it } from 'vitest';
import {
  compileGlob,
  diffSessions,
  formatDiff,
  parseDuration,
  interpolate,
  validateScript,
  type Session,
} from '@sluice-dev/evidence';

function session(
  over: Partial<Session['steps'][number]>[] = [],
  final: Session['final'] = { fakes: {}, db: {} },
): Session {
  return {
    format: 'sluice-session/1',
    label: 't',
    script: { name: 's', steps: [] },
    seed: 1,
    startMs: 0,
    contractViolations: [],
    steps: over.map((o, index) => ({
      index,
      name: `step${index}`,
      kind: 'http',
      egress: [],
      db: [],
      events: [],
      ...o,
    })),
    final,
  };
}

describe('globs', () => {
  it('matches * and **', () => {
    expect(compileGlob('db.*.new.updated_at').test('db.3.new.updated_at')).toBe(true);
    expect(compileGlob('db.*.new.updated_at').test('db.3.old.updated_at')).toBe(false);
    expect(compileGlob('final.**.updated_at').test('final.db.public.subs.0.updated_at')).toBe(true);
    expect(compileGlob('final.**.updated_at').test('final.updated_at')).toBe(true);
    expect(compileGlob('response.body.*').test('response.body.x')).toBe(true);
  });
});

describe('diffSessions', () => {
  it('identical sessions are equal', () => {
    const a = session([{ response: { status: 200, body: { a: 1 } } }]);
    expect(diffSessions(a, structuredClone(a))).toEqual({ equal: true, entries: [] });
  });

  it('reports field changes in responses', () => {
    const a = session([{ response: { status: 200, body: { plan: 'pro', n: 1 } } }]);
    const b = session([{ response: { status: 201, body: { plan: 'PRO', n: 1 } } }]);
    const d = diffSessions(a, b);
    expect(d.entries.map((e) => `${e.channel}:${e.path}:${e.kind}`)).toEqual([
      'response:body.plan:changed',
      'response:status:changed',
    ]);
    expect(formatDiff(d)).toContain('~ response.body.plan: "pro" -> "PRO"');
  });

  it('aligns record lists with LCS: one extra write is one addition', () => {
    const w = (id: number) => ({ table: 't', op: 'INSERT' as const, old: null, new: { id } });
    const a = session([{ db: [w(1), w(2), w(3)] }]);
    const b = session([{ db: [w(1), w(9), w(2), w(3)] }]);
    const d = diffSessions(a, b);
    expect(d.entries).toHaveLength(1);
    expect(d.entries[0]).toMatchObject({ channel: 'db', path: '[1]', kind: 'added', after: w(9) });
  });

  it('pairs same-identity records and diffs them field by field', () => {
    const a = session([{ db: [{ table: 's', op: 'UPDATE', old: { id: 1 }, new: { id: 1, status: 'active' } }] }]);
    const b = session([{ db: [{ table: 's', op: 'UPDATE', old: { id: 1 }, new: { id: 1, status: 'canceled' } }] }]);
    const d = diffSessions(a, b);
    expect(d.entries).toEqual([
      {
        step: 0,
        stepName: 'step0',
        channel: 'db',
        path: '[0].new.status',
        kind: 'changed',
        before: 'active',
        after: 'canceled',
      },
    ]);
  });

  it('canonicalizes generated ids by first appearance (shifted id sequences are not noise)', () => {
    const a = session([{ response: { status: 200, body: { id: 'sub_AAAAAAAAAAAAAAAA' } } }]);
    const b = session([{ response: { status: 200, body: { id: 'sub_BBBBBBBBBBBBBBBB' } } }]);
    expect(diffSessions(a, b).equal).toBe(true);
    expect(diffSessions(a, b, { idPatterns: [] }).equal).toBe(false);
  });

  it('noise filters drop ignored paths', () => {
    const a = session([{ db: [{ table: 's', op: 'INSERT', old: null, new: { id: 1, updated_at: 'x' } }] }], {
      fakes: {},
      db: { s: [{ id: 1, updated_at: 'x' }] },
    });
    const b = session([{ db: [{ table: 's', op: 'INSERT', old: null, new: { id: 1, updated_at: 'y' } }] }], {
      fakes: {},
      db: { s: [{ id: 1, updated_at: 'y' }] },
    });
    expect(diffSessions(a, b).entries).toHaveLength(2);
    expect(diffSessions(a, b, { ignore: ['db.*.new.updated_at', 'final.db.*.*.updated_at'] }).equal).toBe(true);
  });
});

describe('scripts', () => {
  it('parses durations', () => {
    expect(parseDuration('35d')).toBe(35 * 86_400_000);
    expect(parseDuration('90s')).toBe(90_000);
    expect(() => parseDuration('soon')).toThrow();
  });
  it('validates steps', () => {
    expect(() => validateScript({ name: 'x', steps: [{ http: { method: 'GET', path: 'nope' } }] })).toThrow(
      /absolute path/,
    );
    expect(() => validateScript({ name: 'x', steps: [{ advance: '1d', clock: '2030-01-01' }] })).toThrow(/exactly one/);
  });
  it('interpolates variables, preserving types for whole-string refs', () => {
    expect(interpolate({ id: '${c}', p: '/x/${c}' }, { c: 5 })).toEqual({ id: 5, p: '/x/5' });
    expect(() => interpolate('${nope}', {})).toThrow(/undefined variable/);
  });
});
