import { generateKeyPairSync } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FakeServer, GitHubFake, SimClock } from '@sluice-dev/fakes';
import {
  GitHubApiError,
  GitHubClient,
  installationToken,
  signWebhook,
  verifyWebhookSignature,
} from '@sluice-dev/github-api';

const clock = new SimClock(Date.UTC(2030, 0, 15, 12));
const fake = new GitHubFake({ clock });
const server = new FakeServer(fake, { clock });
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

function seed() {
  server.reset(1);
  fake.createRepo({ owner: 'acme', name: 'billing', files: { 'README.md': '# billing' } });
  fake.setBranch('acme/billing', 'feature', 'f'.repeat(40), { 'README.md': '# billing v2' });
  fake.issueToken('tok_rw', {
    login: 'ci',
    repos: ['acme/billing'],
    permissions: { metadata: 'read', checks: 'write', contents: 'write', pull_requests: 'write', issues: 'write' },
  });
  fake.issueToken('tok_ro', {
    login: 'agent',
    repos: ['acme/billing'],
    permissions: { metadata: 'read', contents: 'read', pull_requests: 'read' },
  });
  fake.registerApp(42, 'sluice-gate', publicKey.export({ type: 'spki', format: 'pem' }).toString());
  fake.installApp(7, 42, 'acme', ['acme/billing'], { checks: 'write', metadata: 'read', pull_requests: 'read' });
}

describe('GitHub fake + client', () => {
  beforeAll(async () => {
    await server.start();
  });
  afterAll(() => server.stop());
  beforeEach(seed);

  const client = (token: string) => new GitHubClient({ baseUrl: server.url, token });

  it('creates, updates and lists check runs (contract-valid)', async () => {
    const gh = client('tok_rw');
    const run = await gh.createCheckRun('acme', 'billing', {
      name: 'Sluice Gate',
      head_sha: 'f'.repeat(40),
      status: 'in_progress',
    });
    await gh.updateCheckRun('acme', 'billing', run.id, {
      conclusion: 'failure',
      output: { title: 'Gate failed', summary: '3/5 scenarios violated' },
    });
    const list = await gh.listCheckRuns('acme', 'billing', 'feature');
    expect(list.total_count).toBe(1);
    expect(list.check_runs[0]).toMatchObject({
      name: 'Sluice Gate',
      conclusion: 'failure',
      output: { title: 'Gate failed', summary: '3/5 scenarios violated' },
    });
    expect(server.violations).toEqual([]);
  });

  it('pull requests, comments, contents and merge', async () => {
    const gh = client('tok_rw');
    const pr = await gh.request<{ number: number }>('POST', '/repos/acme/billing/pulls', {
      title: 'Cancel',
      head: 'feature',
      base: 'main',
    });
    expect((await gh.getPull('acme', 'billing', pr.number)).head.ref).toBe('feature');
    await gh.createComment('acme', 'billing', pr.number, 'hello');
    expect(fake.comments('acme/billing', pr.number)).toHaveLength(1);
    const f = await gh.getFile('acme', 'billing', 'README.md');
    expect(f.text).toBe('# billing');
    await gh.putFile('acme', 'billing', 'docs/a.md', 'new', 'add a');
    await expect(gh.putFile('acme', 'billing', 'README.md', 'x', 'stale', { sha: 'nope' })).rejects.toMatchObject({
      status: 409,
    });
    await gh.putFile('acme', 'billing', 'README.md', 'x', 'update', { sha: f.sha });
    expect(fake.file('acme/billing', 'main', 'docs/a.md')).toBe('new');
    expect((await gh.mergePull('acme', 'billing', pr.number)).merged).toBe(true);
    expect(fake.file('acme/billing', 'main', 'README.md')).toBe('# billing v2');
    expect(server.violations).toEqual([]);
  });

  it('enforces token permissions like GitHub', async () => {
    const ro = client('tok_ro');
    await ro.getRepo('acme', 'billing');
    await expect(ro.createCheckRun('acme', 'billing', { name: 'x', head_sha: 'a' })).rejects.toMatchObject({
      status: 403,
    });
    await expect(ro.putFile('acme', 'billing', 'x.md', 'x', 'm')).rejects.toBeInstanceOf(GitHubApiError);
    await expect(client('nope').getRepo('acme', 'billing')).rejects.toMatchObject({ status: 401 });
    await expect(ro.getRepo('acme', 'other')).rejects.toMatchObject({ status: 404 });
  });

  it('GitHub App: JWT -> installation token -> scoped access', async () => {
    const nowSec = Math.floor(clock.now() / 1000);
    const { token } = await installationToken({
      appId: 42,
      privateKeyPem: pem,
      installationId: 7,
      baseUrl: server.url,
      nowSec,
    });
    const gh = client(token);
    await gh.createCheckRun('acme', 'billing', {
      name: 'Sluice Gate',
      head_sha: 'abc',
      conclusion: 'success',
      output: { title: 'ok', summary: 'ok' },
    });
    await expect(gh.putFile('acme', 'billing', 'x', 'y', 'z')).rejects.toMatchObject({ status: 403 });
    await expect(
      installationToken({
        appId: 42,
        privateKeyPem: pem,
        installationId: 7,
        baseUrl: server.url,
        nowSec,
        permissions: { contents: 'write' },
      }),
    ).rejects.toMatchObject({ status: 422 });
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 })
      .privateKey.export({ type: 'pkcs8', format: 'pem' })
      .toString();
    await expect(
      installationToken({ appId: 42, privateKeyPem: other, installationId: 7, baseUrl: server.url, nowSec }),
    ).rejects.toMatchObject({ status: 401 });
    expect(server.violations).toEqual([]);
  });

  it('webhook signatures', () => {
    const sig = signWebhook('s3cret', '{"a":1}');
    expect(verifyWebhookSignature('s3cret', '{"a":1}', sig)).toBe(true);
    expect(verifyWebhookSignature('s3cret', '{"a":2}', sig)).toBe(false);
    expect(verifyWebhookSignature('s3cret', '{"a":1}', undefined)).toBe(false);
  });
});
