import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyCodemod, applyCodemodToSource, validateCampaign, type Codemod } from '@sluice-dev/plugin-campaign';

const GO_MOD: Codemod = {
  language: 'go',
  rules: [
    // most specific first: later rules see earlier rewrites
    { pattern: 'money.FormatDollars($A, $OPTS)', rewrite: 'cents.Format(cents.FromDollars($A), $OPTS)' },
    { pattern: 'money.FormatDollars($A)', rewrite: 'cents.Format(cents.FromDollars($A))' },
    { pattern: '"example.com/shared/money"', rewrite: '"example.com/shared/cents"' },
  ],
};

const GO_SRC = `package invoice

import (
\t"fmt"

\t"example.com/shared/money"
)

var header = money.FormatDollars(0)

func Line(total float64, opts money.Opts) string {
\t// money.FormatDollars(total) in a comment
\ts := "money.FormatDollars(total)"
\ta := money.FormatDollars(total * 1.2)
\tb := money.FormatDollars(total, opts)
\treturn fmt.Sprint(s, a, b)
}
`;

const CS_MOD: Codemod = {
  language: 'csharp',
  rules: [
    { pattern: '$S.CancelNow($$$ARGS)', rewrite: '$S.Cancel($$$ARGS, new CancelOptions { AtPeriodEnd = true })' },
    { pattern: 'using Legacy.Billing;', rewrite: 'using Billing.V2;' },
    { pattern: 'new LegacyClient($$$ARGS)', rewrite: 'new BillingClient($$$ARGS)' },
  ],
};

const CS_SRC = `using System;
using Legacy.Billing;

class Subs {
  void Run(string id) {
    // svc.CancelNow(id) in a comment
    var svc = new LegacyClient(key, 3);
    svc.CancelNow(id);
    var r = svc.CancelNow(id, "reason");
  }
}
`;

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
  it('Go: renames calls with argument rewrites and rewrites the import path', () => {
    const r = applyCodemodToSource(GO_SRC, GO_MOD, 'invoice/line.go');
    expect(r.edits).toBe(4);
    expect(r.text).toBe(
      GO_SRC.replace('"example.com/shared/money"', '"example.com/shared/cents"')
        .replace('money.FormatDollars(0)', 'cents.Format(cents.FromDollars(0))')
        .replace('a := money.FormatDollars(total * 1.2)', 'a := cents.Format(cents.FromDollars(total * 1.2))')
        .replace('b := money.FormatDollars(total, opts)', 'b := cents.Format(cents.FromDollars(total), opts)'),
    );
    expect(r.text).not.toContain(';');
    expect(r.text).toContain('// money.FormatDollars(total) in a comment');
  });
  it('Go: statement patterns get no semicolons; $$$ARGS expands across commas', () => {
    const src = 'package p\n\nfunc f() {\n\tdefer conn.Close()\n\tlog.Printf("%s %d", a, b)\n}\n';
    const r = applyCodemodToSource(src, {
      language: 'go',
      rules: [
        { pattern: 'defer $X.Close()', rewrite: 'defer closeQuietly($X)' },
        { pattern: 'log.Printf($$$ARGS)', rewrite: 'slog.Info(fmt.Sprintf($$$ARGS))' },
      ],
    });
    expect(r.text).toBe(
      'package p\n\nfunc f() {\n\tdefer closeQuietly(conn)\n\tslog.Info(fmt.Sprintf("%s %d", a, b))\n}\n',
    );
  });
  it('C#: renames a method keeping arguments, rewrites using and constructors', () => {
    const r = applyCodemodToSource(CS_SRC, CS_MOD, 'src/Subs.cs');
    expect(r.edits).toBe(4);
    expect(r.text).toBe(`using System;
using Billing.V2;

class Subs {
  void Run(string id) {
    // svc.CancelNow(id) in a comment
    var svc = new BillingClient(key, 3);
    svc.Cancel(id, new CancelOptions { AtPeriodEnd = true });
    var r = svc.Cancel(id, "reason", new CancelOptions { AtPeriodEnd = true });
  }
}
`);
  });
  it('C#: statement patterns keep their semicolon when the template omits it', () => {
    const r = applyCodemodToSource('class A { void M() { Legacy.Flush(); var y = a * b; } }\n', {
      language: 'csharp',
      rules: [
        { pattern: 'Legacy.Flush();', rewrite: 'await Modern.FlushAsync()' },
        { pattern: '$A * $B', rewrite: 'Math.Multiply($A, $B)' },
      ],
    });
    expect(r.text).toBe('class A { void M() { await Modern.FlushAsync(); var y = Math.Multiply(a, b); } }\n');
  });
  it('only touches files of the codemod language family', () => {
    const d = mkdtempSync(join(tmpdir(), 'sluice-codemod-'));
    const files: Record<string, string> = {
      'invoice/line.go': GO_SRC,
      'vendor/example.com/x/x.go': GO_SRC,
      'src/Subs.cs': CS_SRC,
      'web/fmt.ts': 'money.FormatDollars(total);\nsvc.CancelNow(id);\n',
      'web/fmt.js': 'money.FormatDollars(total);\n',
    };
    for (const [f, t] of Object.entries(files)) {
      mkdirSync(join(d, f, '..'), { recursive: true });
      writeFileSync(join(d, f), t);
    }
    expect(applyCodemod(d, GO_MOD)).toEqual([{ file: 'invoice/line.go', edits: 4 }]);
    expect(applyCodemod(d, CS_MOD)).toEqual([{ file: 'src/Subs.cs', edits: 4 }]);
    const js = applyCodemod(d, {
      language: 'javascript',
      rules: [{ pattern: 'money.FormatDollars($A)', rewrite: 'money.formatCents($A)' }],
    });
    expect(js).toEqual([
      { file: 'web/fmt.js', edits: 1 },
      { file: 'web/fmt.ts', edits: 1 },
    ]);
    for (const f of ['vendor/example.com/x/x.go', 'web/fmt.ts'])
      expect(readFileSync(join(d, f), 'utf8')).toContain(f.endsWith('.go') ? 'money.FormatDollars' : 'svc.CancelNow');
    expect(readFileSync(join(d, 'invoice/line.go'), 'utf8')).toContain('"example.com/shared/cents"');
    expect(applyCodemodToSource(CS_SRC, GO_MOD, 'src/Subs.cs')).toEqual({ text: CS_SRC, edits: 0 });
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
    const rule = (language: string, pattern: string) => ({
      ...base,
      steps: [{ ...base.steps[0], evidence: [{ rule: { language, pattern, expect: 'none' } }] }],
    });
    expect(validateCampaign(rule('go', 'money.FormatDollars($$$)')).id).toBe('c');
    expect(validateCampaign(rule('csharp', '$S.CancelNow($$$)')).id).toBe('c');
    expect(() => validateCampaign(rule('rust', 'x'))).toThrow(/language must be/);
    expect(() => applyCodemodToSource('x', { language: 'rust' as never, rules: [] })).toThrow(/codemod language/);
  });
});
