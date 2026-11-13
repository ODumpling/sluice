import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compilePattern, scanSource, scanTree, validateRule, type Rule } from '@sluice-dev/policy';

const mk = (language: Rule['language'], pattern: string, id = `r-${language}`): Rule =>
  validateRule({ id, message: 'm', severity: 'error', language, pattern });

const GO = `package billing

import "github.com/stripe/stripe-go/v82/subscription"

var direct = subscription.Cancel(seed, nil)

func Cancel(id string) error {
	// subscription.Cancel(id, nil) in a comment
	_ = "subscription.Cancel(x, nil)"
	_, err := subscription.Cancel(id, nil)
	subscription.Cancel(id)
	defer f.Close()
	return err
}
`;

const CS = `using Stripe;
using Stripe.Checkout;

class Billing {
  async Task Cancel(string id) {
    // service.Cancel(id) in a comment
    var s = "service.Cancel(id)";
    var service = new SubscriptionService();
    await service.CancelAsync(id);
    service.Cancel(id, null);
    var total = price * qty;
    var key = StripeConfiguration.ApiKey;
  }
}
`;

describe('rule engine: Go', () => {
  it('matches calls structurally, any arity, at package level and in functions', () => {
    const f = scanSource([mk('go', 'subscription.Cancel($$$)')], 'billing/cancel.go', GO);
    expect(f.map((x) => [x.line, x.text])).toEqual([
      [5, 'subscription.Cancel(seed, nil)'],
      [10, 'subscription.Cancel(id, nil)'],
      [11, 'subscription.Cancel(id)'],
    ]);
  });
  it('single-argument selector calls are calls, not type conversions', () => {
    expect(scanSource([mk('go', 'subscription.Cancel($A)')], 'a.go', GO).map((x) => x.line)).toEqual([11]);
    expect(compilePattern('go', 'pkg.Fn($A)')).toEqual({
      context: 'package _\nfunc _() {\npkg.Fn($A)\n}',
      selector: 'call_expression',
    });
  });
  it('statements, selectors and top-level declarations', () => {
    const rules = [
      mk('go', 'defer $X.Close()', 'go-defer'),
      mk('go', 'import "github.com/stripe/stripe-go/v82/subscription"', 'go-import'),
      mk('go', '$A, $B := subscription.Cancel($$$)', 'go-short-var'),
    ];
    expect(scanSource(rules, 'a.go', GO).map((x) => `${x.rule}:${x.line}`)).toEqual([
      'go-import:3',
      'go-short-var:10',
      'go-defer:12',
    ]);
  });
  it('bare selectors (package-qualified identifiers)', () => {
    const src = 'package p\n\nfunc f() { k := stripe.Key; stripe.Key = "x" }\n';
    expect(scanSource([mk('go', 'stripe.Key')], 'a.go', src).map((x) => x.column)).toEqual([17, 29]);
  });
  it('full rule objects get the same pattern handling', () => {
    const r = validateRule({
      id: 'go-no-cancel-in-func',
      message: 'm',
      severity: 'warning',
      language: 'go',
      rule: { pattern: 'subscription.Cancel($$$)', inside: { kind: 'function_declaration', stopBy: 'end' } },
    });
    expect(scanSource([r], 'a.go', GO).map((x) => x.line)).toEqual([10, 11]);
  });
  it('applies only to .go files', () => {
    const r = mk('go', 'subscription.Cancel($$$)');
    expect(scanSource([r], 'a.ts', 'subscription.Cancel(a, b);\n')).toEqual([]);
    expect(scanSource([mk('javascript', 'subscription.Cancel($$$)')], 'a.go', GO)).toEqual([]);
  });
});

describe('rule engine: C#', () => {
  it('matches invocations, object creation and member access', () => {
    const rules = [
      mk('csharp', '$S.Cancel($$$)', 'cs-cancel'),
      mk('csharp', 'await $S.CancelAsync($$$)', 'cs-await'),
      mk('csharp', 'new SubscriptionService($$$)', 'cs-new'),
      mk('csharp', 'StripeConfiguration.ApiKey', 'cs-key'),
    ];
    expect(scanSource(rules, 'src/Billing.cs', CS).map((x) => `${x.rule}:${x.line}:${x.text}`)).toEqual([
      'cs-new:8:new SubscriptionService()',
      'cs-await:9:await service.CancelAsync(id)',
      'cs-cancel:10:service.Cancel(id, null)',
      'cs-key:12:StripeConfiguration.ApiKey',
    ]);
  });
  it('binary `$A * $B` is an expression, not a pointer declaration', () => {
    expect(scanSource([mk('csharp', '$A * $B')], 'a.cs', CS).map((x) => x.text)).toEqual(['price * qty']);
  });
  it('using directives', () => {
    expect(scanSource([mk('csharp', 'using Stripe.Checkout;')], 'a.cs', CS).map((x) => x.line)).toEqual([2]);
  });
  it('applies only to .cs files', () => {
    expect(scanSource([mk('csharp', '$S.Cancel($$$)')], 'a.js', 'service.Cancel(id);\n')).toEqual([]);
  });
});

describe('rule engine: languages', () => {
  it('validates the language', () => {
    expect(() => validateRule({ id: 'xx', message: 'm', severity: 'error', language: 'rust', pattern: 'a' })).toThrow(
      /language must be javascript\|typescript\|go\|csharp/,
    );
  });
  it('scanTree scans each language with its rules and skips vendored code', () => {
    const d = mkdtempSync(join(tmpdir(), 'sluice-rules-'));
    for (const [f, t] of Object.entries({
      'billing/cancel.go': GO,
      'vendor/x/cancel.go': GO,
      'billing/cancel_test.go': 'package billing\nfunc T() { subscription.Cancel(a, b) }\n',
      'src/Billing.cs': CS,
      'src/obj/Gen.cs': CS,
      'web/a.ts': 'service.Cancel(id);\n',
    })) {
      mkdirSync(join(d, f, '..'), { recursive: true });
      writeFileSync(join(d, f), t);
    }
    const f = scanTree([mk('go', 'subscription.Cancel($$$)'), mk('csharp', '$S.Cancel($$$)')], d);
    expect(f.map((x) => `${x.file}:${x.line}`)).toEqual([
      'billing/cancel.go:5',
      'billing/cancel.go:10',
      'billing/cancel.go:11',
      'billing/cancel_test.go:2',
      'src/Billing.cs:10',
    ]);
  });
});
