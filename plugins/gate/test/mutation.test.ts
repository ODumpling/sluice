import { describe, expect, it } from 'vitest';
import { applyMutant, generateMutants, selectMutants } from '../src/mutation.js';

const SRC = `import x from 'x';
export function f(a, b) {
  if (a === b && !a.done) {
    return { ok: true, status: 'active', n: 1 };
  }
  call(a);
  return a > b ? a + b : null;
}
`;

describe('mutation', () => {
  it('generates mutants only on changed lines', () => {
    const all = generateMutants('f.js', SRC, [[3, 4]]);
    const ops = all.map((m) => `${m.line}:${m.operator}:${m.original}->${m.replacement}`);
    expect(ops).toEqual([
      '3:negate-condition:a === b && !a.done->!(a === b && !a.done)',
      '3:binary-operator:===->!==',
      '3:binary-operator:&&->||',
      '3:remove-negation:!->',
      "4:return-value:{ ok: true, status: 'active', n: 1 }->undefined",
      '4:boolean-literal:true->false',
      "4:string-literal:'active'->''",
      '4:numeric-literal:1->2',
    ]);
    expect(generateMutants('f.js', SRC, [[1, 1]])).toEqual([]); // import specifier untouched
  });
  it('applies mutants and the result still parses', () => {
    for (const m of generateMutants('f.js', SRC, [[1, 8]])) {
      const out = applyMutant(SRC, m);
      expect(out).not.toBe(SRC);
      expect(() => new Function(out.replace(/^import.*$/m, '').replace('export ', ''))).not.toThrow();
    }
  });
  it('selects a deterministic spread', () => {
    const all = generateMutants('f.js', SRC, [[1, 8]]);
    expect(selectMutants(all, 3)).toEqual(selectMutants(all, 3));
    expect(selectMutants(all, 3)).toHaveLength(3);
    expect(selectMutants(all, 100)).toEqual(all);
  });
});
