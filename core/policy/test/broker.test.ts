// M5 exit: an agent is denied an out-of-scope GitHub write (and every decision is audited).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Stripe from 'stripe';
import { FakeServer, GitHubFake, SimClock, StripeFake, stripeContract } from '@sluice-dev/fakes';
import { GitHubApiError, GitHubClient } from '@sluice-dev/github-api';
import { AuditLog, CredentialBroker, covers, githubRequiredScope, parseScope } from '@sluice-dev/policy';

const clock = new SimClock(Date.UTC(2030, 0, 15, 12));
const gh = new GitHubFake({ clock });
const ghServer = new FakeServer(gh, { clock });
const stripeFake = new StripeFake({ clock });
const stripeServer = new FakeServer(stripeFake, { clock });
let broker: CredentialBroker;
let brokerUrl: string;
const audit = new AuditLog(undefined, () => clock.now());

beforeAll(async () => {
  await ghServer.start();
  await stripeServer.start();
  gh.createRepo({ owner: 'acme', name: 'billing', files: { 'README.md': '# billing' } });
  gh.createRepo({ owner: 'acme', name: 'payroll' });
  gh.setBranch('acme/billing', 'agent/x', 'a'.repeat(40), { 'README.md': '# agent' });
  // the broker holds a broad credential; agents never see it
  gh.issueToken('ghp_broker_upstream', {
    login: 'sluice-broker',
    repos: '*',
    permissions: { metadata: 'read', contents: 'write', pull_requests: 'write', issues: 'write', checks: 'write' },
  });
  broker = new CredentialBroker({
    audit,
    now: () => clock.now(),
    upstreams: {
      github: { baseUrl: ghServer.url, token: 'ghp_broker_upstream' },
      stripe: { baseUrl: stripeServer.url, token: 'sk_test_broker' },
    },
    stepUp: ['github:acme/*:merge:write'],
  });
  brokerUrl = await broker.listen();
});
afterAll(async () => {
  await broker.close();
  await ghServer.stop();
  await stripeServer.stop();
});

describe('scopes', () => {
  it('parses and matches', () => {
    expect(covers(parseScope('github:acme/*:contents:write'), parseScope('github:acme/billing:contents:read'))).toBe(
      true,
    );
    expect(
      covers(parseScope('github:acme/billing:contents:read'), parseScope('github:acme/billing:contents:write')),
    ).toBe(false);
    expect(
      covers(parseScope('github:acme/billing:contents:write'), parseScope('github:acme/payroll:contents:write')),
    ).toBe(false);
    expect(() => parseScope('github:acme/billing:admin:write')).toThrow(/unknown GitHub permission/);
    expect(githubRequiredScope('PUT', '/repos/acme/billing/pulls/3/merge')).toMatchObject({
      permission: 'merge',
      level: 'write',
    });
    expect(githubRequiredScope('DELETE', '/repos/acme/billing')).toBeUndefined();
  });
});

describe('credential broker', () => {
  const agentClient = (token: string) => new GitHubClient({ baseUrl: `${brokerUrl}/github`, token });

  it('denies an out-of-scope GitHub write, allows in-scope calls, injects the real credential', async () => {
    const { token, grant } = broker.issue({
      task: 'CANCEL-1',
      agent: 'codex',
      scopes: ['github:acme/billing:contents:read', 'github:acme/billing:pull_requests:write'],
      ttlSec: 900,
    });
    expect(token).toMatch(/^slc_/);
    const agent = agentClient(token);
    expect((await agent.getFile('acme', 'billing', 'README.md')).text).toBe('# billing'); // read: in scope
    await agent.request('POST', '/repos/acme/billing/pulls', {
      title: 'cancel at period end',
      head: 'agent/x',
      base: 'main',
    }); // in scope

    const write = agent.putFile('acme', 'billing', 'src/hack.js', 'x', 'sneaky write');
    await expect(write).rejects.toBeInstanceOf(GitHubApiError);
    await expect(write).rejects.toMatchObject({
      status: 403,
      body: { message: 'Sluice broker: out of scope: requires github:acme/billing:contents:write' },
    });
    await expect(agent.getRepo('acme', 'payroll')).rejects.toMatchObject({ status: 403 }); // other repo
    await expect(agent.createCheckRun('acme', 'billing', { name: 'x', head_sha: 'a' })).rejects.toMatchObject({
      status: 403,
    });
    expect(gh.file('acme/billing', 'main', 'src/hack.js')).toBeUndefined(); // nothing reached GitHub

    const denied = audit.entries().filter((e) => e.type === 'request' && e.decision === 'deny' && e.grant === grant.id);
    expect(denied.map((e) => `${e.method} ${e.path}`)).toEqual([
      'PUT /repos/acme/billing/contents/src/hack.js',
      'GET /repos/acme/payroll',
      'POST /repos/acme/billing/check-runs',
    ]);
    expect(denied[0]).toMatchObject({ task: 'CANCEL-1', agent: 'codex', scope: 'github:acme/billing:contents:write' });
    expect(broker.grants().find((g) => g.id === grant.id)!.usage).toEqual({ requests: 2, writes: 1, usd: 0 });
    expect(ghServer.violations).toEqual([]);
  });

  it('rejects unknown, expired and revoked tokens and raw upstream tokens', async () => {
    const { token, grant } = broker.issue({
      task: 't',
      agent: 'a',
      scopes: ['github:acme/billing:metadata:read'],
      ttlSec: 60,
    });
    await agentClient(token).getRepo('acme', 'billing');
    clock.advance(61_000);
    await expect(agentClient(token).getRepo('acme', 'billing')).rejects.toMatchObject({
      status: 401,
      body: { message: 'Sluice broker: grant expired' },
    });
    const second = broker.issue({ task: 't', agent: 'a', scopes: ['github:acme/billing:metadata:read'], ttlSec: 60 });
    broker.revoke(second.grant.id, 'admin');
    await expect(agentClient(second.token).getRepo('acme', 'billing')).rejects.toMatchObject({ status: 401 });
    await expect(agentClient('ghp_broker_upstream').getRepo('acme', 'billing')).rejects.toMatchObject({ status: 401 });
    expect(() =>
      broker.issue({ task: 't', agent: 'a', scopes: ['github:acme/billing:metadata:read'], ttlSec: 999_999 }),
    ).toThrow(/ttl/);
    void grant;
  });

  it('enforces request and write caps', async () => {
    const { token } = broker.issue({
      task: 't',
      agent: 'a',
      scopes: ['github:acme/billing:issues:write', 'github:acme/billing:pull_requests:read'],
      ttlSec: 600,
      caps: { requests: 3, writes: 1 },
    });
    const c = agentClient(token);
    await c.createComment('acme', 'billing', 1, 'one');
    await expect(c.createComment('acme', 'billing', 1, 'two')).rejects.toMatchObject({ status: 429 });
    await c.getPull('acme', 'billing', 1);
    await c.getPull('acme', 'billing', 1);
    await expect(c.getPull('acme', 'billing', 1)).rejects.toMatchObject({ status: 429 });
  });

  it('merging requires a human step-up approval, which is single-use', async () => {
    const { token } = broker.issue({
      task: 'CANCEL-1',
      agent: 'codex',
      scopes: ['github:acme/billing:merge:write'],
      ttlSec: 900,
    });
    const c = agentClient(token);
    const first = await c.mergePull('acme', 'billing', 1).catch((e: GitHubApiError) => e);
    expect(first).toMatchObject({
      status: 403,
      body: { message: 'Sluice broker: step-up approval required for github:acme/billing:merge:write' },
    });
    const approvalId = (first as GitHubApiError & { body: { approval_id: string } }).body.approval_id;
    expect(broker.approvals('pending').map((a) => a.id)).toEqual([approvalId]);
    // retrying does not create a second request
    await c.mergePull('acme', 'billing', 1).catch(() => undefined);
    expect(broker.approvals('pending')).toHaveLength(1);
    broker.decide(approvalId, 'approved', 'po@acme.test');
    expect((await c.mergePull('acme', 'billing', 1)).merged).toBe(true);
    await expect(c.mergePull('acme', 'billing', 1)).rejects.toMatchObject({ status: 403 }); // single use
    const types = audit.entries().map((e) => e.type);
    expect(types).toContain('stepup.requested');
    expect(types).toContain('stepup.approved');
  });

  it('enforces Stripe spend caps through the broker', async () => {
    const admin = new Stripe('sk_test_admin', {
      host: '127.0.0.1',
      port: stripeServer.port,
      protocol: 'http',
      maxNetworkRetries: 0,
      apiVersion: stripeContract().version as Stripe.LatestApiVersion,
    });
    const product = await admin.products.create({ name: 'Pro' });
    const price = await admin.prices.create({
      product: product.id,
      currency: 'usd',
      unit_amount: 2000,
      recurring: { interval: 'month' },
    });
    const customer = await admin.customers.create({ email: 'cap@example.com' });
    const { token } = broker.issue({
      task: 't',
      agent: 'a',
      scopes: ['stripe:subscriptions:write', 'stripe:prices:read'],
      ttlSec: 600,
      caps: { usd: 30 },
    });
    const u = new URL(brokerUrl);
    const agent = new Stripe(token, {
      host: u.hostname,
      port: Number(u.port),
      protocol: 'http',
      maxNetworkRetries: 0,
      apiVersion: stripeContract().version as Stripe.LatestApiVersion,
    });
    await agent.subscriptions.create({ customer: customer.id, items: [{ price: price.id }] }); // $20
    await expect(
      agent.subscriptions.create({ customer: customer.id, items: [{ price: price.id }] }),
    ).rejects.toMatchObject({ statusCode: 402 }); // would be $40
    await expect(agent.customers.create({ email: 'x@y.z' })).rejects.toMatchObject({ statusCode: 403 }); // out of scope
    expect((stripeFake.state() as { subscriptions: unknown[] }).subscriptions).toHaveLength(1);
  });
});
