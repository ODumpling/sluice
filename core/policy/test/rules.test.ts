import { describe, expect, it } from 'vitest';
import { onChangedLines, scanSource, validateRule } from '@sluice-dev/policy';

const rule = validateRule({
  id: 'no-immediate-cancel',
  message: 'cancel at period end',
  severity: 'error',
  language: 'javascript',
  pattern: 'stripe.subscriptions.cancel($$$)',
});

describe('rule engine', () => {
  it('finds structural matches, not text matches', () => {
    const src = `// stripe.subscriptions.cancel(id) in a comment\nconst s = 'stripe.subscriptions.cancel(x)';\nawait stripe.subscriptions.cancel(row.stripe_subscription_id);\n`;
    const f = scanSource([rule], 'src/billing.js', src);
    expect(f).toEqual([
      expect.objectContaining({
        rule: 'no-immediate-cancel',
        line: 3,
        text: 'stripe.subscriptions.cancel(row.stripe_subscription_id)',
      }),
    ]);
    expect(onChangedLines(f, { 'src/billing.js': [[1, 2]] })).toEqual([]);
    expect(onChangedLines(f, { 'src/billing.js': [[3, 3]] })).toHaveLength(1);
    expect(scanSource([rule], 'README.md', src)).toEqual([]);
  });
  it('supports full ast-grep rules and validates', () => {
    const r = validateRule({
      id: 'no-date-now',
      message: 'use the clock',
      severity: 'warning',
      language: 'typescript',
      rule: {
        pattern: 'Date.now()',
        not: { inside: { kind: 'function_declaration', stopBy: 'end', has: { field: 'name', regex: '^clock' } } },
      },
    });
    expect(
      scanSource([r], 'a.ts', 'function clockNow(){ return Date.now() }\nconst t = Date.now();\n').map((x) => x.line),
    ).toEqual([2]);
    expect(() => validateRule({ id: 'x', message: 'm', severity: 'error', language: 'javascript' })).toThrow();
    expect(() => validateRule({ ...rule, id: 'Bad' })).toThrow(/id/);
  });
});
