import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeServer, GitHubFake, SimClock } from '@sluice-dev/fakes';
import { signWebhook } from '@sluice-dev/github-api';
import { createGateApp, extractTicket } from '@sluice-dev/github';

export const clock = new SimClock(Date.UTC(2030, 0, 15, 12));
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
export const keys = {
  privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
};

export function prEvent(over: { title?: string; body?: string; head?: string; base?: string } = {}) {
  return {
    action: 'opened',
    installation: { id: 7 },
    repository: { name: 'billing-demo', owner: { login: 'acme' } },
    pull_request: {
      number: 1,
      title: over.title ?? 'Cancel at period end [CANCEL-1]',
      body: over.body ?? null,
      head: { sha: over.head ?? 'h'.repeat(40), ref: 'agent/x' },
      base: { sha: over.base ?? 'b'.repeat(40), ref: 'main' },
    },
  };
}

describe('Sluice Gate GitHub App', () => {
  const gh = new GitHubFake({ clock });
  const server = new FakeServer(gh, { clock });
  beforeAll(async () => {
    await server.start();
    gh.createRepo({ owner: 'acme', name: 'billing-demo' });
    gh.registerApp(42, 'sluice-gate', keys.publicKeyPem);
    gh.installApp(7, 42, 'acme', ['acme/billing-demo'], {
      checks: 'write',
      contents: 'read',
      metadata: 'read',
      pull_requests: 'read',
    });
  });
  afterAll(() => server.stop());
  const app = () =>
    createGateApp({
      appId: 42,
      privateKeyPem: keys.privateKeyPem,
      webhookSecret: 'whsec',
      apiBaseUrl: server.url,
      workDir: mkdtempSync(join(tmpdir(), 'sluice-app-')),
      nowSec: () => clock.nowSeconds(),
    });

  it('extracts ticket ids', () => {
    expect(extractTicket('Fix [CANCEL-1] thing')).toBe('CANCEL-1');
    expect(extractTicket(null, 'Ticket: billing.42')).toBe('billing.42');
    expect(extractTicket('nothing')).toBeUndefined();
  });

  it('rejects unsigned webhooks and answers pings', async () => {
    const a = app();
    expect(a.handle({ 'x-github-event': 'pull_request' }, '{}').status).toBe(401);
    const ping = '{"zen":"x"}';
    expect(a.handle({ 'x-github-event': 'ping', 'x-hub-signature-256': signWebhook('whsec', ping) }, ping).status).toBe(
      200,
    );
  });

  it('PR without a ticket gets a neutral check, via an installation token', async () => {
    const raw = JSON.stringify(prEvent({ title: 'no ticket here', head: 'n'.repeat(40) }));
    const r = app().handle({ 'x-github-event': 'pull_request', 'x-hub-signature-256': signWebhook('whsec', raw) }, raw);
    expect(r.status).toBe(202);
    await r.job;
    const run = gh.checkRuns('acme/billing-demo').find((c) => c.head_sha === 'n'.repeat(40))!;
    expect(run).toMatchObject({ conclusion: 'neutral', output: { title: 'No ticket referenced' } });
    expect(server.violations).toEqual([]);
  });

  it('served over HTTP', async () => {
    const { url, close } = await app().listen();
    const res = await fetch(`${url}/webhook`, {
      method: 'POST',
      body: '{}',
      headers: { 'x-github-event': 'pull_request' },
    });
    expect(res.status).toBe(401);
    await close();
  });
});
