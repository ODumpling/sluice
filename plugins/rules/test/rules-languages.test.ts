// Go and C#: a review comment becomes a rule proven on the bad commit and clean on main.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCli, type HostIO } from '@sluice-dev/cli';
import rulesPlugin, { proposeFromComment, proveRule } from '@sluice-dev/plugin-rules';

function io(cwd: string): HostIO & { out: () => string; err: () => string } {
  let out = '';
  let err = '';
  return {
    cwd,
    env: {},
    stdout: { write: (t) => void (out += t) },
    stderr: { write: (t) => void (err += t) },
    out: () => out,
    err: () => err,
  };
}

const git = (repo: string, ...args: string[]) =>
  execFileSync('git', args, { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] })
    .toString()
    .trim();

function write(repo: string, files: Record<string, string>): void {
  for (const [f, t] of Object.entries(files)) {
    mkdirSync(join(repo, f, '..'), { recursive: true });
    writeFileSync(join(repo, f), t);
  }
}

/** main + a `bad` branch (one commit) + a `good` branch. */
function repoWith(main: Record<string, string>, bad: Record<string, string>, good: Record<string, string>) {
  const repo = mkdtempSync(join(tmpdir(), 'sluice-rules-lang-'));
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'dev@acme.test');
  git(repo, 'config', 'user.name', 'Acme Dev');
  git(repo, 'config', 'commit.gpgsign', 'false');
  write(repo, main);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'main');
  const branch = (name: string, files: Record<string, string>) => {
    git(repo, 'checkout', '-q', '-b', name, 'main');
    write(repo, files);
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', name);
    const sha = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'checkout', '-q', 'main');
    return sha;
  };
  return { repo, bad: branch('agent/bad', bad), good: branch('agent/good', good) };
}

const goCancel = (body: string) => `package billing

import "github.com/acme/stripe"

// Cancel ends a subscription.
func Cancel(id string) error {
${body}
}
`;

const GO = {
  main: {
    'go.mod': 'module github.com/acme/billing\n\ngo 1.27\n',
    'billing/cancel.go': goCancel('\treturn nil'),
    // vendored copies of the SDK call it; never scanned
    'vendor/github.com/acme/stripe/sub.go': 'package stripe\n\nfunc x() { stripe.CancelNow("a", nil) }\n',
  },
  bad: { 'billing/cancel.go': goCancel('\t_, err := stripe.CancelNow(id, nil)\n\treturn err') },
  good: {
    'billing/cancel.go': goCancel(
      '\t_, err := stripe.Update(id, &stripe.Params{CancelAtPeriodEnd: true})\n\treturn err',
    ),
  },
};
const GO_COMMENT =
  "Don't call `stripe.CancelNow(...)` here: CANCEL-1 says cancellation takes effect at period end. Use `stripe.Update(id, params)` instead.";

const csCancel = (body: string) => `using Acme.Stripe;

namespace Billing;

public class Subscriptions
{
    public async Task Cancel(string id)
    {
${body}
    }
}
`;

const CS = {
  main: {
    'Billing.csproj': '<Project Sdk="Microsoft.NET.Sdk"></Project>\n',
    'src/Subscriptions.cs': csCancel('        await Task.CompletedTask;'),
    'src/Admin.cs': 'class Admin { object Svc() => new SubscriptionService(); }\n',
    'obj/Generated.cs': 'class G { void M() { new SubscriptionService().CancelAsync("x"); } }\n',
  },
  bad: {
    'src/Subscriptions.cs': csCancel(
      '        var service = new SubscriptionService();\n        await service.CancelAsync(id);',
    ),
  },
  good: {
    'src/Subscriptions.cs': csCancel(
      '        var service = new SubscriptionService();\n        await service.UpdateAsync(id, new() { CancelAtPeriodEnd = true });',
    ),
  },
};
const CS_COMMENT =
  'Never `await service.CancelAsync(id)` on this path; CANCEL-1 cancels at period end. Prefer `service.UpdateAsync(id, options)`.';

describe('rules: Go', () => {
  it('proposes from code spans (selector calls, `(...)` for any args)', () => {
    const rules = proposeFromComment({ body: GO_COMMENT, path: 'billing/cancel.go' });
    expect(rules.map((r) => [r.id, r.language, r.pattern])).toEqual([
      ['review-stripe-cancelnow', 'go', 'stripe.CancelNow($$$)'],
      ['review-stripe-update', 'go', 'stripe.Update($$$)'],
    ]);
    expect(rules[0]!.message).toBe(
      "Don't call `stripe.CancelNow(...)` here: CANCEL-1 says cancellation takes effect at period end.",
    );
  });

  it('single-argument selector calls and bare selectors', () => {
    expect(
      proposeFromComment({ body: 'no `stripe.CancelNow(id)` or `stripe.Key` or `x := 1`', path: 'a.go' }).map(
        (r) => r.pattern,
      ),
    ).toEqual(['stripe.CancelNow($$$)', 'stripe.Key']);
  });

  it('falls back to the call at the commented line', () => {
    const src = GO.bad['billing/cancel.go'];
    const line = src.split('\n').findIndex((l) => l.includes('CancelNow')) + 1;
    expect(
      proposeFromComment(
        { body: 'This cancels immediately!', path: 'billing/cancel.go', line },
        { sourceAtPath: src },
      ).map((r) => r.pattern),
    ).toEqual(['stripe.CancelNow($$$)']);
  });

  it('proves the right candidate on the bad commit and rejects the others', async () => {
    const { repo, bad } = repoWith(GO.main, GO.bad, GO.good);
    const [cancel, update] = proposeFromComment({ body: GO_COMMENT, path: 'billing/cancel.go' });
    const proof = await proveRule(cancel!, { repo, bad, main: 'main' });
    expect(proof).toMatchObject({ proven: true, main: { findings: [] } });
    expect(proof.bad.findings.map((f) => `${f.file}:${f.line}:${f.text}`)).toEqual([
      'billing/cancel.go:7:stripe.CancelNow(id, nil)',
    ]);
    expect(await proveRule(update!, { repo, bad, main: 'main' })).toMatchObject({
      proven: false,
      reason: 'does not flag anything the commit changed',
    });
  });

  it('CLI + MCP: propose -> prove -> check blocks the bad branch, passes the good one', async () => {
    const { repo, bad } = repoWith(GO.main, GO.bad, GO.good);
    const p = io(repo);
    expect(await runCli(['rules', 'propose', '--comment', GO_COMMENT, '--path', 'billing/cancel.go'], p)).toBe(0);
    expect(p.out()).toContain('proposed review-stripe-cancelnow (go): stripe.CancelNow($$$)');
    const proved = io(repo);
    expect(await runCli(['rules', 'prove', 'review-stripe-cancelnow', '--bad', bad], proved)).toBe(0);
    expect(proved.out()).toContain('PROVEN review-stripe-cancelnow');
    const checkBad = io(repo);
    expect(await runCli(['rules', 'check', '--base', 'main', '--head', 'agent/bad'], checkBad)).toBe(1);
    expect(checkBad.out()).toContain('billing/cancel.go:7:');
    expect(await runCli(['rules', 'check', '--base', 'main', '--head', 'agent/good'], io(repo))).toBe(0);
    const tool = rulesPlugin.tools!.find((t) => t.name === 'sluice_rules_check')!;
    const res = await tool.run({ base: 'main', head: 'agent/bad' }, io(repo) as never);
    expect(res).toMatchObject({ isError: true, content: { findings: [{ file: 'billing/cancel.go', line: 7 }] } });
  });

  it('CLI: without --path the project toolchain picks the language; --language is validated', async () => {
    const { repo } = repoWith(GO.main, GO.bad, GO.good);
    const p = io(repo);
    expect(await runCli(['rules', 'propose', '--comment', 'avoid `stripe.CancelNow(id, nil)`'], p)).toBe(0);
    expect(p.out()).toContain('(go): stripe.CancelNow($$$)');
    const bad = io(repo);
    await expect(runCli(['rules', 'propose', '--comment', 'x `a.b()`', '--language', 'rust'], bad)).resolves.not.toBe(
      0,
    );
    expect(bad.err()).toMatch(/--language must be javascript\|typescript\|go\|csharp/);
  });
});

describe('rules: C#', () => {
  it('proposes from code spans (await, invocations, object creation)', () => {
    expect(
      proposeFromComment({ body: CS_COMMENT, path: 'src/Subscriptions.cs' }).map((r) => [r.language, r.pattern]),
    ).toEqual([
      ['csharp', 'service.CancelAsync($$$)'],
      ['csharp', 'service.UpdateAsync($$$)'],
    ]);
    expect(
      proposeFromComment({ body: "don't `new SubscriptionService(...)` here", path: 'A.cs' }).map((r) => r.pattern),
    ).toEqual(['new SubscriptionService($$$)']);
  });

  it('falls back to the call at the commented line', () => {
    const src = CS.bad['src/Subscriptions.cs'];
    const line = src.split('\n').findIndex((l) => l.includes('CancelAsync')) + 1;
    expect(
      proposeFromComment({ body: 'Cancels now!', path: 'src/Subscriptions.cs', line }, { sourceAtPath: src }).map(
        (r) => r.pattern,
      ),
    ).toEqual(['service.CancelAsync($$$)']);
  });

  it('proves on the bad commit, clean on main; CLI check blocks bad and passes good', async () => {
    const { repo, bad } = repoWith(CS.main, CS.bad, CS.good);
    const [cancel, update] = proposeFromComment({ body: CS_COMMENT, path: 'src/Subscriptions.cs' });
    const proof = await proveRule(cancel!, { repo, bad, main: 'main' });
    expect(proof).toMatchObject({ proven: true, main: { findings: [] } });
    expect(proof.bad.findings.map((f) => `${f.file}:${f.line}:${f.text}`)).toEqual([
      'src/Subscriptions.cs:10:service.CancelAsync(id)',
    ]);
    expect(await proveRule(update!, { repo, bad, main: 'main' })).toMatchObject({ proven: false });
    const noisy = proposeFromComment({ body: 'avoid `new SubscriptionService()` here', path: 'a.cs' })[0]!;
    expect(await proveRule(noisy, { repo, bad, main: 'main' })).toMatchObject({
      proven: false,
      reason: expect.stringMatching(/fires 1 time\(s\) on main/),
    });

    expect(
      await runCli(['rules', 'propose', '--comment', CS_COMMENT, '--path', 'src/Subscriptions.cs'], io(repo)),
    ).toBe(0);
    expect(await runCli(['rules', 'prove', 'review-service-cancelasync', '--bad', bad], io(repo))).toBe(0);
    const checkBad = io(repo);
    expect(await runCli(['rules', 'check', '--base', 'main', '--head', 'agent/bad'], checkBad)).toBe(1);
    expect(checkBad.out()).toContain('src/Subscriptions.cs:10:');
    expect(await runCli(['rules', 'check', '--base', 'main', '--head', 'agent/good'], io(repo))).toBe(0);
  });
});
