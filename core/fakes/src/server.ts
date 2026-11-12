import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Contract, ContractViolation, Json } from './contract.js';
import type { SimClock } from './clock.js';
import { decodeForm } from './form.js';

export interface FakeRequest {
  method: string;
  path: string;
  query: Record<string, unknown>;
  body: Record<string, unknown>;
  headers: Record<string, string | undefined>;
  /** Path params from the contract route, when the fake has a contract. */
  params: Record<string, string>;
  /** Contract route template (e.g. /v1/subscriptions/{subscription_exposed_id}). */
  route?: string;
}

export interface FakeResponse {
  status: number;
  body: Json;
  headers?: Record<string, string>;
}

export interface Fake {
  readonly name: string;
  readonly contract?: Contract;
  handle(req: FakeRequest): FakeResponse | Promise<FakeResponse>;
  /** Restore initial state; ids/randomness re-seeded. */
  reset(seed: number): void;
  /** JSON snapshot of all state (for evidence and assertions). */
  state(): Json;
  /** Shape of an error response for this API. */
  error(status: number, message: string, extra?: Record<string, Json>): FakeResponse;
  /** Optional hook: run before contract validation (e.g. auth). Return a response to short-circuit. */
  preflight?(req: FakeRequest): FakeResponse | undefined;
}

export interface JournalEntry {
  seq: number;
  fake: string;
  at: number;
  method: string;
  path: string;
  query: Record<string, unknown>;
  body: Record<string, unknown>;
  status: number;
  response: Json;
  violations: ContractViolation[];
}

export interface FakeServerOptions {
  clock: SimClock;
  /** Contract enforcement: strict turns response violations into HTTP 500 (default true). */
  strict?: boolean;
  host?: string;
  port?: number;
}

function parseBody(raw: string, contentType: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  if (contentType?.includes('application/json')) {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : { _: v };
  }
  return decodeForm(raw);
}

/** Serves one fake over HTTP with contract enforcement, a request journal and admin endpoints. */
export class FakeServer {
  readonly fake: Fake;
  readonly journal: JournalEntry[] = [];
  private seq = 0;
  private server: http.Server | undefined;
  private readonly opts: Required<Omit<FakeServerOptions, 'port' | 'host'>> & { port: number; host: string };

  constructor(fake: Fake, opts: FakeServerOptions) {
    this.fake = fake;
    this.opts = { strict: true, host: '127.0.0.1', port: 0, ...opts };
  }

  get clock(): SimClock {
    return this.opts.clock;
  }

  get violations(): ContractViolation[] {
    return this.journal.flatMap((j) => j.violations);
  }

  async start(): Promise<string> {
    this.server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        this.dispatch(req, Buffer.concat(chunks).toString('utf8')).then(
          (r) => {
            res.writeHead(r.status, { 'content-type': 'application/json', ...r.headers });
            res.end(JSON.stringify(r.body));
          },
          (err: unknown) => {
            res.writeHead(500, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: { message: `fake crashed: ${(err as Error).message}` } }));
          },
        );
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(this.opts.port, this.opts.host, resolve));
    return this.url;
  }

  get port(): number {
    return (this.server!.address() as AddressInfo).port;
  }

  get url(): string {
    const host = this.opts.host === '0.0.0.0' ? '127.0.0.1' : this.opts.host;
    return `http://${host}:${this.port}`;
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((r) => this.server!.close(() => r()));
    this.server = undefined;
  }

  reset(seed: number): void {
    this.fake.reset(seed);
    this.journal.length = 0;
    this.seq = 0;
  }

  /** In-process request (used by tests and by the sandbox without HTTP). */
  async request(
    method: string,
    pathWithQuery: string,
    body = '',
    headers: Record<string, string> = {},
  ): Promise<FakeResponse> {
    const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
    return this.handle(method, pathWithQuery, body, lower);
  }

  private dispatch(req: http.IncomingMessage, raw: string): Promise<FakeResponse> {
    const headers: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(req.headers)) headers[k] = Array.isArray(v) ? v.join(',') : v;
    return this.handle(req.method ?? 'GET', req.url ?? '/', raw, headers);
  }

  private async handle(
    method: string,
    pathWithQuery: string,
    raw: string,
    headers: Record<string, string | undefined>,
  ): Promise<FakeResponse> {
    const url = new URL(pathWithQuery, 'http://fake');
    const path = url.pathname;
    if (path.startsWith('/_sluice/')) return this.admin(method, path, raw);

    let query: Record<string, unknown> = decodeForm(url.searchParams);
    let body: Record<string, unknown>;
    try {
      body = parseBody(raw, headers['content-type']);
    } catch {
      return this.fake.error(400, 'Invalid request body');
    }
    const req: FakeRequest = { method: method.toUpperCase(), path, query, body, headers, params: {} };
    const violations: ContractViolation[] = [];
    const record = (r: FakeResponse) => {
      this.journal.push({
        seq: ++this.seq,
        fake: this.fake.name,
        at: this.opts.clock.now(),
        method: req.method,
        path,
        query,
        body,
        status: r.status,
        response: r.body,
        violations,
      });
      return r;
    };

    const pre = this.fake.preflight?.(req);
    if (pre) return record(pre);

    const contract = this.fake.contract;
    let matched;
    if (contract) {
      matched = contract.match(req.method, path);
      if (!matched) {
        violations.push({
          kind: 'route',
          operation: `${req.method} ${path}`,
          message: 'route is not part of the contract',
        });
        return record(this.fake.error(404, `Unrecognized request URL (${req.method}: ${path}).`));
      }
      const v = contract.validateRequest(matched, query, body);
      if (v.errors.length) {
        // Real APIs reject invalid requests; the fake does too (this is not a fake defect).
        return record(this.fake.error(400, `Invalid request: ${v.errors.join('; ')}`));
      }
      query = v.query;
      body = v.body;
      req.query = query;
      req.body = body;
      req.params = matched.pathParams;
      req.route = matched.template;
    }

    const res = await this.fake.handle(req);
    if (contract && matched) {
      const errs = contract.validateResponse(matched, res.status, res.body);
      for (const e of errs) {
        violations.push({ kind: 'response', operation: `${req.method} ${matched.template}`, message: e });
      }
      if (errs.length && this.opts.strict) {
        return record({
          status: 500,
          body: { error: { type: 'sluice_contract_violation', message: errs.join('; ') } },
        });
      }
    }
    return record(res);
  }

  private admin(method: string, path: string, raw: string): FakeResponse {
    const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    if (method === 'GET' && path === '/_sluice/state') return { status: 200, body: this.fake.state() };
    if (method === 'GET' && path === '/_sluice/journal') return { status: 200, body: this.journal as unknown as Json };
    if (method === 'POST' && path === '/_sluice/reset') {
      this.reset(typeof body.seed === 'number' ? body.seed : 1);
      return { status: 200, body: { ok: true } };
    }
    if (method === 'POST' && path === '/_sluice/clock') {
      if (typeof body.nowMs !== 'number') return { status: 400, body: { error: 'nowMs required' } };
      this.opts.clock.set(body.nowMs);
      return { status: 200, body: { nowMs: this.opts.clock.now() } };
    }
    return { status: 404, body: { error: `unknown admin route ${method} ${path}` } };
  }
}
