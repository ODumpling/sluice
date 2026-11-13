// The "Sluice Gate" GitHub App end to end: signed webhook -> installation token -> clone -> gate -> check run.
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeServer, GitHubFake, SimClock } from '@sluice-dev/fakes';
import { signWebhook } from '@sluice-dev/github-api';
import { createGateApp } from '@sluice-dev/github';
import { GateStore } from '@sluice-dev/plugin-gate';
// @ts-expect-error -- plain ESM helper shared with `pnpm demo`
import { PRS, commitAll, createPrBranch, git, initDemoRepo } from '../../scripts/demo/demo-repo.mjs';

const clock = new SimClock(Date.UTC(2030, 0, 15, 12));
const gh = new GitHubFake({ clock });
const server = new FakeServer(gh, { clock });
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });

describe('Sluice Gate GitHub App (e2e)', () => {
  let repo: string;
  beforeAll(async () => {
    await server.start();
    gh.createRepo({ owner: 'acme', name: 'billing-demo' });
    gh.registerApp(42, 'sluice-gate', publicKey.export({ type: 'spki', format: 'pem' }).toString());
    gh.installApp(7, 42, 'acme', ['acme/billing-demo'], { checks: 'write', contents: 'read', metadata: 'read' });
    repo = initDemoRepo() as string;
    new GateStore(repo).approve('CANCEL-1', 'po@acme.test');
    commitAll(repo, 'approve');
    createPrBranch(repo, PRS.bad);
  });
  afterAll(() => server.stop());

  it('runs the gate on a pull_request webhook and fails the check', async () => {
    const app = createGateApp({
      appId: 42,
      privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      webhookSecret: 'whsec',
      apiBaseUrl: server.url,
      workDir: mkdtempSync(join(tmpdir(), 'sluice-app-')),
      cloneUrl: () => repo,
      nowSec: () => clock.nowSeconds(),
    });
    const head = git(repo, 'rev-parse', PRS.bad.branch);
    const base = git(repo, 'rev-parse', 'main');
    const raw = JSON.stringify({
      action: 'opened',
      installation: { id: 7 },
      repository: { name: 'billing-demo', owner: { login: 'acme' } },
      pull_request: {
        number: 1,
        title: `${PRS.bad.title}`,
        body: 'Implements [CANCEL-1]',
        head: { sha: head, ref: PRS.bad.branch },
        base: { sha: base, ref: 'main' },
      },
    });
    const r = app.handle({ 'x-github-event': 'pull_request', 'x-hub-signature-256': signWebhook('whsec', raw) }, raw);
    expect(r.status).toBe(202);
    const report = await r.job;
    expect(report?.verdict).toBe('fail');
    const run = gh.checkRuns('acme/billing-demo').find((c) => c.head_sha === head)!;
    expect(run).toMatchObject({ name: 'Sluice Gate', status: 'completed', conclusion: 'failure' });
    expect(run.output.title).toContain('3/5 approved scenarios violated');
    expect(server.violations).toEqual([]);
  });
});
