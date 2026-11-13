// M5 exit: a review comment becomes a rule that is proven on the seeded bad commit and clean on main.
import { describe, expect, it } from 'vitest';
import { runCli, type HostIO } from '@sluice-dev/cli';
import { proposeFromComment, proveRule } from '@sluice-dev/plugin-rules';
// @ts-expect-error -- plain ESM helper shared with `pnpm demo`
import { PRS, createPrBranch, git, initDemoRepo } from '../../../scripts/demo/demo-repo.mjs';

const COMMENT =
  "Don't call `stripe.subscriptions.cancel()` here — CANCEL-1 says cancellation takes effect at period end. Use `stripe.subscriptions.update(id, { cancel_at_period_end: true })` instead.";

function io(cwd: string): HostIO & { out: () => string } {
  let out = '';
  return { cwd, env: {}, stdout: { write: (t) => void (out += t) }, stderr: { write: () => {} }, out: () => out };
}

describe('rules: review comment -> proven rule (M5)', () => {
  it('proposes candidates from code spans in the comment', () => {
    const rules = proposeFromComment({ body: COMMENT, path: 'src/billing.js' });
    expect(rules.map((r) => r.pattern)).toEqual([
      'stripe.subscriptions.cancel($$$)',
      'stripe.subscriptions.update($$$)',
    ]);
    expect(rules[0]!.message).toBe(
      "Don't call `stripe.subscriptions.cancel()` here — CANCEL-1 says cancellation takes effect at period end.",
    );
  });

  it('falls back to the commented line when the comment has no code', () => {
    const src = 'const a = 1;\nawait stripe.subscriptions.cancel(row.stripe_subscription_id);\n';
    expect(
      proposeFromComment(
        { body: 'This ends the subscription immediately!', path: 'src/billing.js', line: 2 },
        { sourceAtPath: src },
      ).map((r) => r.pattern),
    ).toEqual(['stripe.subscriptions.cancel($$$)']);
  });

  it('proves the right candidate on the seeded bad commit and rejects the others', async () => {
    const repo = initDemoRepo() as string;
    const { sha: bad } = createPrBranch(repo, PRS.bad) as { sha: string };
    const [cancelRule, updateRule] = proposeFromComment({ body: COMMENT, path: 'src/billing.js' });
    const proof = await proveRule(cancelRule!, { repo, bad, main: 'main' });
    expect(proof).toMatchObject({ proven: true, bad: { sha: bad }, main: { ref: 'main', findings: [] } });
    expect(proof.bad.findings.map((f) => `${f.file}:${f.text}`)).toEqual([
      'src/billing.js:stripe.subscriptions.cancel(row.stripe_subscription_id)',
    ]);
    const wrong = await proveRule(updateRule!, { repo, bad, main: 'main' });
    expect(wrong).toMatchObject({ proven: false, reason: 'does not flag anything the commit changed' });
    // a rule that fires on main is noise
    const noisy = proposeFromComment({ body: 'avoid `db.query()` here' })[0]!;
    expect(await proveRule(noisy, { repo, bad, main: 'main' })).toMatchObject({
      proven: false,
      reason: expect.stringMatching(/fires \d+ time\(s\) on main/),
    });
  });

  it('CLI: propose -> prove -> adopted rule blocks the bad PR and passes the good one', async () => {
    const repo = initDemoRepo() as string;
    const { sha: bad } = createPrBranch(repo, PRS.bad) as { sha: string };
    createPrBranch(repo, PRS.good);
    const p = io(repo);
    expect(await runCli(['rules', 'propose', '--comment', COMMENT, '--path', 'src/billing.js'], p)).toBe(0);
    expect(p.out()).toContain('proposed review-stripe-subscriptions-cancel');
    const proved = io(repo);
    expect(await runCli(['rules', 'prove', 'review-stripe-subscriptions-cancel', '--bad', bad], proved)).toBe(0);
    expect(proved.out()).toContain('PROVEN review-stripe-subscriptions-cancel');
    expect(await runCli(['rules', 'prove', 'review-stripe-subscriptions-update', '--bad', bad], io(repo))).toBe(1);
    const checkBad = io(repo);
    expect(await runCli(['rules', 'check', '--base', 'main', '--head', PRS.bad.branch], checkBad)).toBe(1);
    expect(checkBad.out()).toContain('src/billing.js:');
    expect(await runCli(['rules', 'check', '--base', 'main', '--head', PRS.good.branch], io(repo))).toBe(0);
    void git;
  });
});
