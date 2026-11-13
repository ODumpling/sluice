/**
 * Task-scoped credential broker. Agents never see real credentials: they get
 * a short-lived opaque token bound to a task, an agent, a set of scopes and
 * spend caps, and call third-party APIs *through* the broker, which checks
 * every request, injects the real credential, enforces caps and step-up
 * approvals, and writes every decision to the tamper-evident audit log.
 *
 * Scopes:
 *   github:<owner>/<repo|*>:<permission>:<read|write>
 *     permission ∈ metadata | contents | pull_requests | issues | checks | merge
 *   stripe:<resource|*>:<read|write>          e.g. stripe:subscriptions:write
 * write implies read. `merge` is separate from contents so merging can require
 * step-up approval even when pushing commits does not.
 */
import { createHash, randomBytes } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import type { AuditLog } from './audit.js';

export type Level = 'read' | 'write';

export interface Scope {
  provider: 'github' | 'stripe';
  /** github: owner/repo (repo may be *); stripe: resource (or *). */
  target: string;
  /** github permission; stripe: same as target. */
  permission: string;
  level: Level;
}

const GITHUB_PERMS = new Set(['metadata', 'contents', 'pull_requests', 'issues', 'checks', 'merge']);

export function parseScope(s: string): Scope {
  const parts = s.split(':');
  if (parts[0] === 'github' && parts.length === 4) {
    const [, target, permission, level] = parts as [string, string, string, string];
    if (!/^[\w.-]+\/([\w.-]+|\*)$/.test(target))
      throw new Error(`invalid scope ${s}: target must be owner/repo or owner/*`);
    if (!GITHUB_PERMS.has(permission)) throw new Error(`invalid scope ${s}: unknown GitHub permission ${permission}`);
    if (level !== 'read' && level !== 'write') throw new Error(`invalid scope ${s}: level must be read or write`);
    return { provider: 'github', target, permission, level };
  }
  if (parts[0] === 'stripe' && parts.length === 3) {
    const [, target, level] = parts as [string, string, string];
    if (!/^([a-z_]+|\*)$/.test(target)) throw new Error(`invalid scope ${s}: bad Stripe resource`);
    if (level !== 'read' && level !== 'write') throw new Error(`invalid scope ${s}: level must be read or write`);
    return { provider: 'stripe', target, permission: target, level };
  }
  throw new Error(
    `invalid scope ${JSON.stringify(s)} (github:<owner>/<repo>:<perm>:<read|write> or stripe:<resource>:<read|write>)`,
  );
}

export function formatScope(s: Scope): string {
  return s.provider === 'github' ? `github:${s.target}:${s.permission}:${s.level}` : `stripe:${s.target}:${s.level}`;
}

/** Does granted scope `g` cover required scope `r`? (`*` targets, write ⊇ read) */
export function covers(g: Scope, r: Scope): boolean {
  if (g.provider !== r.provider) return false;
  if (g.level === 'read' && r.level === 'write') return false;
  if (g.provider === 'github') {
    const [go, gr] = g.target.split('/');
    const [ro, rr] = r.target.split('/');
    return go === ro && (gr === '*' || gr === rr) && g.permission === r.permission;
  }
  return g.target === '*' || g.target === r.target;
}

/** Scope needed for a GitHub REST call, or undefined if the broker does not proxy that endpoint. */
export function githubRequiredScope(method: string, path: string): Scope | undefined {
  const m = method.toUpperCase();
  const write: Level = m === 'GET' || m === 'HEAD' ? 'read' : 'write';
  const r = /^\/repos\/([\w.-]+)\/([\w.-]+)(\/.*)?$/.exec(path);
  if (!r) return undefined;
  const target = `${r[1]}/${r[2]}`;
  const rest = r[3] ?? '';
  const s = (permission: string, level: Level = write): Scope => ({ provider: 'github', target, permission, level });
  if (rest === '') return m === 'GET' ? s('metadata', 'read') : undefined;
  if (/^\/pulls\/\d+\/merge$/.test(rest)) return s('merge', m === 'GET' ? 'read' : 'write');
  if (/^\/contents\//.test(rest) || /^\/branches\//.test(rest) || /^\/git\//.test(rest)) return s('contents');
  if (/^\/pulls(\/\d+(\/files)?)?$/.test(rest)) return s('pull_requests');
  if (/^\/issues\/\d+\/comments$/.test(rest)) return s('issues');
  if (/^\/check-runs(\/\d+)?$/.test(rest) || /^\/commits\/[^/]+\/check-runs$/.test(rest)) return s('checks');
  return undefined;
}

export function stripeRequiredScope(method: string, path: string): Scope | undefined {
  const r = /^\/v1\/([a-z_]+)/.exec(path);
  if (!r) return undefined;
  return {
    provider: 'stripe',
    target: r[1]!,
    permission: r[1]!,
    level: method.toUpperCase() === 'GET' ? 'read' : 'write',
  };
}

export interface Caps {
  /** Max proxied requests over the grant's lifetime. */
  requests?: number;
  /** Max mutating requests. */
  writes?: number;
  /** Max money moved (USD) for spend-bearing APIs (Stripe subscriptions/invoices). */
  usd?: number;
}

export interface Usage {
  requests: number;
  writes: number;
  usd: number;
}

export interface Grant {
  id: string;
  task: string;
  agent: string;
  scopes: string[];
  issuedAt: number;
  expiresAt: number;
  caps: Caps;
  usage: Usage;
  revoked: boolean;
}

export interface Approval {
  id: string;
  grantId: string;
  task: string;
  agent: string;
  scope: string;
  method: string;
  path: string;
  status: 'pending' | 'approved' | 'denied' | 'consumed';
  requestedAt: number;
  decidedBy?: string;
}

export interface Upstream {
  baseUrl: string;
  /** Real credential; never leaves the broker. */
  token: string;
}

export interface BrokerOptions {
  /** SQLite file for grants/approvals (":memory:" for tests). */
  db?: string;
  audit: AuditLog;
  upstreams: Partial<Record<'github' | 'stripe', Upstream>>;
  /** Scope patterns that need human step-up approval per request, e.g. "github:acme/*:merge:write". */
  stepUp?: string[];
  maxTtlSec?: number;
  now?: () => number;
}

export interface Decision {
  allow: boolean;
  status: number;
  reason: string;
  grant?: Grant;
  scope?: string;
  approvalId?: string;
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

export class CredentialBroker {
  private readonly db: DatabaseSync;
  private readonly now: () => number;
  private readonly stepUp: Scope[];
  private server: http.Server | undefined;

  constructor(private readonly opts: BrokerOptions) {
    this.now = opts.now ?? Date.now;
    this.stepUp = (opts.stepUp ?? []).map(parseScope);
    this.db = new DatabaseSync(opts.db ?? ':memory:');
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS grants (
        token_hash TEXT PRIMARY KEY, id TEXT UNIQUE NOT NULL, task TEXT NOT NULL, agent TEXT NOT NULL,
        scopes TEXT NOT NULL, issued_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
        caps TEXT NOT NULL, usage TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS approvals (
        id TEXT PRIMARY KEY, grant_id TEXT NOT NULL, scope TEXT NOT NULL, method TEXT NOT NULL, path TEXT NOT NULL,
        status TEXT NOT NULL, requested_at INTEGER NOT NULL, decided_by TEXT);
    `);
  }

  get audit(): AuditLog {
    return this.opts.audit;
  }

  // ------------------------------------------------------------------ grants

  issue(o: { task: string; agent: string; scopes: string[]; ttlSec: number; caps?: Caps }): {
    token: string;
    grant: Grant;
  } {
    if (!o.task || !o.agent) throw new Error('task and agent are required');
    if (!o.scopes.length) throw new Error('at least one scope is required');
    o.scopes.forEach(parseScope);
    const max = this.opts.maxTtlSec ?? 3600;
    if (!(o.ttlSec > 0) || o.ttlSec > max) throw new Error(`ttl must be between 1 and ${max} seconds`);
    const token = `slc_${randomBytes(24).toString('hex')}`;
    const grant: Grant = {
      id: `grant_${randomBytes(6).toString('hex')}`,
      task: o.task,
      agent: o.agent,
      scopes: [...o.scopes].sort(),
      issuedAt: this.now(),
      expiresAt: this.now() + o.ttlSec * 1000,
      caps: o.caps ?? {},
      usage: { requests: 0, writes: 0, usd: 0 },
      revoked: false,
    };
    this.db
      .prepare(
        'INSERT INTO grants (token_hash, id, task, agent, scopes, issued_at, expires_at, caps, usage) VALUES (?,?,?,?,?,?,?,?,?)',
      )
      .run(
        sha(token),
        grant.id,
        grant.task,
        grant.agent,
        JSON.stringify(grant.scopes),
        grant.issuedAt,
        grant.expiresAt,
        JSON.stringify(grant.caps),
        JSON.stringify(grant.usage),
      );
    this.audit.append('grant.issued', {
      grant: grant.id,
      task: grant.task,
      agent: grant.agent,
      scopes: grant.scopes,
      expiresAt: new Date(grant.expiresAt).toISOString(),
      caps: grant.caps,
    });
    return { token, grant };
  }

  revoke(grantId: string, by: string): void {
    this.db.prepare('UPDATE grants SET revoked = 1 WHERE id = ?').run(grantId);
    this.audit.append('grant.revoked', { grant: grantId, by });
  }

  private rowToGrant(r: Record<string, unknown>): Grant {
    return {
      id: String(r.id),
      task: String(r.task),
      agent: String(r.agent),
      scopes: JSON.parse(String(r.scopes)) as string[],
      issuedAt: Number(r.issued_at),
      expiresAt: Number(r.expires_at),
      caps: JSON.parse(String(r.caps)) as Caps,
      usage: JSON.parse(String(r.usage)) as Usage,
      revoked: Number(r.revoked) === 1,
    };
  }

  grantForToken(token: string): Grant | undefined {
    const r = this.db.prepare('SELECT * FROM grants WHERE token_hash = ?').get(sha(token)) as
      Record<string, unknown> | undefined;
    return r ? this.rowToGrant(r) : undefined;
  }

  grants(): Grant[] {
    return (this.db.prepare('SELECT * FROM grants ORDER BY issued_at').all() as Record<string, unknown>[]).map((r) =>
      this.rowToGrant(r),
    );
  }

  private saveUsage(g: Grant): void {
    this.db.prepare('UPDATE grants SET usage = ? WHERE id = ?').run(JSON.stringify(g.usage), g.id);
  }

  // ------------------------------------------------------------------ approvals

  approvals(status?: Approval['status']): Approval[] {
    const rows = (
      status
        ? this.db
            .prepare(
              'SELECT a.*, g.task, g.agent FROM approvals a JOIN grants g ON g.id = a.grant_id WHERE a.status = ? ORDER BY requested_at',
            )
            .all(status)
        : this.db
            .prepare(
              'SELECT a.*, g.task, g.agent FROM approvals a JOIN grants g ON g.id = a.grant_id ORDER BY requested_at',
            )
            .all()
    ) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: String(r.id),
      grantId: String(r.grant_id),
      task: String(r.task),
      agent: String(r.agent),
      scope: String(r.scope),
      method: String(r.method),
      path: String(r.path),
      status: r.status as Approval['status'],
      requestedAt: Number(r.requested_at),
      decidedBy: r.decided_by ? String(r.decided_by) : undefined,
    }));
  }

  /** Human decision on a step-up request. Approval is single-use. */
  decide(id: string, decision: 'approved' | 'denied', by: string): Approval {
    const a = this.approvals().find((x) => x.id === id);
    if (!a) throw new Error(`no approval ${id}`);
    if (a.status !== 'pending') throw new Error(`approval ${id} is already ${a.status}`);
    if (!by.trim()) throw new Error('approver identity required');
    this.db.prepare('UPDATE approvals SET status = ?, decided_by = ? WHERE id = ?').run(decision, by, id);
    this.audit.append(`stepup.${decision}`, {
      approval: id,
      grant: a.grantId,
      scope: a.scope,
      method: a.method,
      path: a.path,
      by,
    });
    return { ...a, status: decision, decidedBy: by };
  }

  // ------------------------------------------------------------------ authorization

  authorize(token: string | undefined, provider: 'github' | 'stripe', method: string, path: string): Decision {
    const deny = (status: number, reason: string, extra: Partial<Decision> = {}): Decision => ({
      allow: false,
      status,
      reason,
      ...extra,
    });
    if (!token) return deny(401, 'missing broker token');
    const g = this.grantForToken(token);
    if (!g) return deny(401, 'unknown broker token');
    if (g.revoked) return deny(401, 'grant revoked', { grant: g });
    if (this.now() >= g.expiresAt) return deny(401, 'grant expired', { grant: g });
    const required = provider === 'github' ? githubRequiredScope(method, path) : stripeRequiredScope(method, path);
    if (!required) return deny(403, `endpoint ${method} ${path} is not brokered`, { grant: g });
    const scope = formatScope(required);
    const granted = g.scopes.map(parseScope);
    if (!granted.some((s) => covers(s, required)))
      return deny(403, `out of scope: requires ${scope}`, { grant: g, scope });
    const writes = required.level === 'write';
    if (g.caps.requests !== undefined && g.usage.requests >= g.caps.requests)
      return deny(429, `request cap ${g.caps.requests} reached`, { grant: g, scope });
    if (writes && g.caps.writes !== undefined && g.usage.writes >= g.caps.writes)
      return deny(429, `write cap ${g.caps.writes} reached`, { grant: g, scope });
    if (this.stepUp.some((p) => covers(p, required))) {
      const approved = this.approvals('approved').find(
        (a) => a.grantId === g.id && a.scope === scope && a.method === method.toUpperCase() && a.path === path,
      );
      if (!approved) {
        const pending = this.approvals('pending').find(
          (a) => a.grantId === g.id && a.scope === scope && a.method === method.toUpperCase() && a.path === path,
        );
        const id = pending?.id ?? `apr_${randomBytes(5).toString('hex')}`;
        if (!pending) {
          this.db
            .prepare(
              'INSERT INTO approvals (id, grant_id, scope, method, path, status, requested_at) VALUES (?,?,?,?,?,?,?)',
            )
            .run(id, g.id, scope, method.toUpperCase(), path, 'pending', this.now());
          this.audit.append('stepup.requested', {
            approval: id,
            grant: g.id,
            task: g.task,
            agent: g.agent,
            scope,
            method: method.toUpperCase(),
            path,
          });
        }
        return deny(403, `step-up approval required for ${scope}`, { grant: g, scope, approvalId: id });
      }
      this.db.prepare("UPDATE approvals SET status = 'consumed' WHERE id = ?").run(approved.id);
    }
    return { allow: true, status: 200, reason: 'allowed', grant: g, scope };
  }

  // ------------------------------------------------------------------ proxy

  private async stripeSpend(up: Upstream, method: string, path: string, body: string): Promise<number> {
    if (method !== 'POST' || path !== '/v1/subscriptions') return 0;
    const form = new URLSearchParams(body);
    let cents = 0;
    for (let i = 0; form.has(`items[${i}][price]`); i++) {
      const price = form.get(`items[${i}][price]`)!;
      const qty = Number(form.get(`items[${i}][quantity]`) ?? 1);
      const res = await fetch(`${up.baseUrl}/v1/prices/${encodeURIComponent(price)}`, {
        headers: { authorization: `Bearer ${up.token}` },
      });
      if (!res.ok) continue;
      const p = (await res.json()) as { unit_amount?: number };
      cents += (p.unit_amount ?? 0) * qty;
    }
    return cents / 100;
  }

  /** Handle one proxied request: `/github/<api path>`, `/stripe/<api path>` or bare `/v1/...` (Stripe). */
  async proxy(req: {
    method: string;
    url: string;
    headers: Record<string, string | undefined>;
    body: string;
  }): Promise<{ status: number; headers: Record<string, string>; body: string }> {
    // Stripe SDKs cannot add a path prefix, so bare /v1/* is routed to Stripe.
    const m = req.url.startsWith('/v1/')
      ? (['', 'stripe', req.url] as const)
      : /^\/(github|stripe)(\/.*)$/.exec(req.url);
    if (!m)
      return {
        status: 404,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ error: 'unknown provider route' }),
      };
    const provider = m[1] as 'github' | 'stripe';
    const fullPath = m[2]!;
    const path = fullPath.split('?')[0]!;
    const method = req.method.toUpperCase();
    const auth = req.headers.authorization ?? '';
    const token = /^(?:Bearer|token)\s+(slc_[0-9a-f]+)$/i.exec(auth)?.[1];
    const d = this.authorize(token, provider, method, path);
    const log = (decision: string, extra: Record<string, unknown> = {}) =>
      this.audit.append('request', {
        decision,
        provider,
        method,
        path,
        grant: d.grant?.id,
        task: d.grant?.task,
        agent: d.grant?.agent,
        scope: d.scope,
        reason: d.reason,
        ...extra,
      });
    if (!d.allow) {
      log('deny', { status: d.status, approval: d.approvalId });
      const body =
        provider === 'github'
          ? { message: `Sluice broker: ${d.reason}`, approval_id: d.approvalId }
          : {
              error: { type: 'sluice_policy_error', message: `Sluice broker: ${d.reason}`, approval_id: d.approvalId },
            };
      return { status: d.status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
    }
    const up = this.opts.upstreams[provider];
    if (!up) {
      log('deny', { status: 502, reason: 'no upstream configured' });
      return {
        status: 502,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ error: `no upstream for ${provider}` }),
      };
    }
    const g = d.grant!;
    const isWrite = method !== 'GET' && method !== 'HEAD';
    if (provider === 'stripe' && g.caps.usd !== undefined) {
      const spend = await this.stripeSpend(up, method, path, req.body);
      if (g.usage.usd + spend > g.caps.usd) {
        log('deny', {
          status: 402,
          reason: `spend cap $${g.caps.usd} would be exceeded ($${g.usage.usd} + $${spend})`,
        });
        return {
          status: 402,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            error: {
              type: 'sluice_policy_error',
              message: `Sluice broker: spend cap $${g.caps.usd} would be exceeded`,
            },
          }),
        };
      }
      g.usage.usd = Math.round((g.usage.usd + spend) * 100) / 100;
    }
    g.usage.requests++;
    if (isWrite) g.usage.writes++;
    this.saveUsage(g);
    const headers: Record<string, string> = { authorization: `Bearer ${up.token}` };
    for (const h of [
      'content-type',
      'accept',
      'x-github-api-version',
      'stripe-version',
      'idempotency-key',
      'user-agent',
    ]) {
      const v = req.headers[h];
      if (v) headers[h] = v;
    }
    const res = await fetch(up.baseUrl.replace(/\/$/, '') + fullPath, {
      method,
      headers,
      body: isWrite ? req.body : undefined,
    });
    const text = await res.text();
    log('allow', { status: res.status });
    return {
      status: res.status,
      headers: { 'content-type': res.headers.get('content-type') ?? 'application/json' },
      body: text,
    };
  }

  async listen(port = 0, host = '127.0.0.1'): Promise<string> {
    this.server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const headers: Record<string, string | undefined> = {};
        for (const [k, v] of Object.entries(req.headers)) headers[k] = Array.isArray(v) ? v[0] : v;
        this.proxy({
          method: req.method ?? 'GET',
          url: req.url ?? '/',
          headers,
          body: Buffer.concat(chunks).toString('utf8'),
        }).then(
          (r) => {
            res.writeHead(r.status, r.headers);
            res.end(r.body);
          },
          (e: unknown) => {
            res.writeHead(502, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: `broker upstream error: ${(e as Error).message}` }));
          },
        );
      });
    });
    await new Promise<void>((r) => this.server!.listen(port, host, r));
    return `http://${host}:${(this.server.address() as AddressInfo).port}`;
  }

  async close(): Promise<void> {
    if (this.server) await new Promise<void>((r) => this.server!.close(() => r()));
    this.db.close();
  }
}
