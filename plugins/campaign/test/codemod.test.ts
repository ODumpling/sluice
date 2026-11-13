import { describe, expect, it } from 'vitest';
import { applyCodemodToSource, validateCampaign } from '@sluice-dev/plugin-campaign';

describe('codemod', () => {
  it('rewrites with metavariables, in rule order', () => {
    const src =
      "import { formatDollars } from '../../shared-money/index.js';\nconst a = formatDollars(x.total);\nconst b = formatDollars(tax, { symbol: false });\n// formatDollars(y) in a comment\n";
    const r = applyCodemodToSource(src, {
      language: 'javascript',
      rules: [
        { pattern: 'formatDollars($A, $OPTS)', rewrite: 'formatCents(Math.round($A * 100), $OPTS)' },
        { pattern: 'formatDollars($A)', rewrite: 'formatCents(Math.round($A * 100))' },
        { pattern: 'import { formatDollars } from $SRC', rewrite: 'import { formatCents } from $SRC' },
      ],
    });
    expect(r.edits).toBe(3);
    expect(r.text).toBe(
      "import { formatCents } from '../../shared-money/index.js';\nconst a = formatCents(Math.round(x.total * 100));\nconst b = formatCents(Math.round(tax * 100), { symbol: false });\n// formatDollars(y) in a comment\n",
    );
  });
  it('validates campaigns: every step must be evidence-gated', () => {
    const base = {
      id: 'c',
      title: 't',
      repos: [{ name: 'a', path: 'a' }],
      steps: [{ id: 's', repos: ['a'], apply: { command: 'true' }, evidence: [{ tests: 'true' }] }],
    };
    expect(validateCampaign(base).id).toBe('c');
    expect(() => validateCampaign({ ...base, steps: [{ ...base.steps[0], evidence: [] }] })).toThrow(/evidence-gated/);
    expect(() => validateCampaign({ ...base, steps: [{ ...base.steps[0], repos: ['zzz'] }] })).toThrow(/unknown repo/);
  });
});
