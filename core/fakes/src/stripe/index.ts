/**
 * Stateful Stripe fake. Objects are synthesized from the vendored Stripe
 * OpenAPI contract and every response is contract-validated by FakeServer.
 *
 * Implemented semantics (the subset billing apps rely on):
 *  - customers, products, prices (CRUD subset)
 *  - subscriptions: create (immediately active, first invoice paid), retrieve,
 *    list (default excludes canceled, like Stripe), update (cancel_at_period_end,
 *    cancel_at, metadata), cancel (DELETE: immediate)
 *  - clock-driven lifecycle: when the shared SimClock passes a period end the
 *    subscription renews (new period + paid invoice) or, if scheduled, cancels
 *  - invoices (list), events (list) with Stripe event types
 *  - auth (Bearer sk_test_*), idempotency keys, Stripe error shapes, expand[]
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Contract, type Json, type OpenApiDoc } from '../contract.js';
import type { SimClock } from '../clock.js';
import { IdGenerator } from '../ids.js';
import type { Fake, FakeRequest, FakeResponse } from '../server.js';

// Stripe objects are dynamic JSON; the contract validator (not the type system) guards their shape.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Obj = Record<string, any>;

const VENDOR = new URL('../../vendor/stripe/', import.meta.url);

let cachedContract: Contract | undefined;
export function stripeContract(): Contract {
  cachedContract ??= new Contract(
    JSON.parse(readFileSync(fileURLToPath(new URL('openapi.json', VENDOR)), 'utf8')) as OpenApiDoc,
  );
  return cachedContract;
}

export function stripeFixtures(): Record<string, Obj> {
  const f = JSON.parse(readFileSync(fileURLToPath(new URL('fixtures.json', VENDOR)), 'utf8')) as {
    resources: Record<string, Obj>;
  };
  return f.resources;
}

const PREFIX: Record<string, string> = {
  cus: 'customers',
  prod: 'products',
  price: 'prices',
  sub: 'subscriptions',
  si: 'subscriptionItems',
  in: 'invoices',
  evt: 'events',
  il: 'lines',
};

function addInterval(sec: number, interval: string, count: number): number {
  const d = new Date(sec * 1000);
  switch (interval) {
    case 'day':
      d.setUTCDate(d.getUTCDate() + count);
      break;
    case 'week':
      d.setUTCDate(d.getUTCDate() + 7 * count);
      break;
    case 'month': {
      const day = d.getUTCDate();
      d.setUTCDate(1);
      d.setUTCMonth(d.getUTCMonth() + count);
      const dim = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
      d.setUTCDate(Math.min(day, dim));
      break;
    }
    case 'year':
      d.setUTCFullYear(d.getUTCFullYear() + count);
      break;
    default:
      throw new Error(`unsupported interval ${interval}`);
  }
  return Math.floor(d.getTime() / 1000);
}

function clone<T>(v: T): T {
  return structuredClone(v);
}

interface State {
  customers: Map<string, Obj>;
  products: Map<string, Obj>;
  prices: Map<string, Obj>;
  subscriptions: Map<string, Obj>;
  invoices: Map<string, Obj>;
  events: Map<string, Obj>;
  idempotency: Map<string, { path: string; response: FakeResponse }>;
}

function emptyState(): State {
  return {
    customers: new Map(),
    products: new Map(),
    prices: new Map(),
    subscriptions: new Map(),
    invoices: new Map(),
    events: new Map(),
    idempotency: new Map(),
  };
}

export interface StripeFakeOptions {
  clock: SimClock;
  seed?: number;
}

export class StripeFake implements Fake {
  readonly name = 'stripe';
  readonly contract: Contract;
  private readonly clock: SimClock;
  private readonly ids: IdGenerator;
  private s: State = emptyState();
  /** Stripe-Version headers seen from clients (drift signal when != contract version). */
  readonly apiVersionsSeen = new Set<string>();

  constructor(opts: StripeFakeOptions) {
    this.contract = stripeContract();
    this.clock = opts.clock;
    this.ids = new IdGenerator(opts.seed ?? 1);
    this.clock.onChange((now) => this.tick(Math.floor(now / 1000)));
  }

  reset(seed: number): void {
    this.s = emptyState();
    this.ids.reset(seed);
    this.apiVersionsSeen.clear();
  }

  state(): Json {
    const dump = (m: Map<string, Obj>) => [...m.values()].map(clone);
    return {
      customers: dump(this.s.customers),
      products: dump(this.s.products),
      prices: dump(this.s.prices),
      subscriptions: dump(this.s.subscriptions),
      invoices: dump(this.s.invoices),
      events: dump(this.s.events),
    };
  }

  error(status: number, message: string, extra: Record<string, Json> = {}): FakeResponse {
    const type = status === 401 ? 'invalid_request_error' : status >= 500 ? 'api_error' : 'invalid_request_error';
    return { status, body: { error: { type, message, ...extra } } };
  }

  preflight(req: FakeRequest): FakeResponse | undefined {
    const auth = req.headers.authorization ?? '';
    const key = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!key) {
      return this.error(401, 'You did not provide an API key. Provide it in the Authorization header as Bearer <key>.');
    }
    if (!key.startsWith('sk_test_') && !key.startsWith('rk_test_')) {
      return this.error(401, `Invalid API Key provided: ${key.slice(0, 8)}… (the Stripe fake only accepts test keys)`);
    }
    const v = req.headers['stripe-version'];
    if (v) this.apiVersionsSeen.add(v);
    return undefined;
  }

  // ---------------------------------------------------------------- helpers

  private now(): number {
    return this.clock.nowSeconds();
  }

  private make(schema: string, fields: Obj): Obj {
    const base = this.contract.synthesize(schema) as Obj;
    const props = (this.contract.schema(schema).properties ?? {}) as Record<string, unknown>;
    return { ...base, ...('livemode' in props ? { livemode: false } : {}), ...fields };
  }

  private missing(kind: string, id: string, param = 'id'): FakeResponse {
    return this.error(404, `No such ${kind}: '${id}'`, { code: 'resource_missing', param });
  }

  private event(type: string, object: Obj, previous?: Obj): void {
    const id = this.ids.next('evt');
    const data: Obj = { object: clone(object) };
    if (previous) data.previous_attributes = previous;
    this.s.events.set(
      id,
      this.make('event', {
        id,
        object: 'event',
        type,
        created: this.now(),
        api_version: this.contract.version,
        data,
        pending_webhooks: 0,
        request: { id: null, idempotency_key: null },
      }),
    );
  }

  private list(items: Obj[], url: string, query: Record<string, unknown>): Obj {
    const limit = typeof query.limit === 'number' ? Math.min(Math.max(query.limit, 1), 100) : 10;
    // Stripe lists are newest first.
    let sorted = [...items].reverse();
    if (typeof query.starting_after === 'string') {
      const i = sorted.findIndex((o) => o.id === query.starting_after);
      sorted = i >= 0 ? sorted.slice(i + 1) : [];
    }
    return { object: 'list', data: sorted.slice(0, limit).map(clone), has_more: sorted.length > limit, url };
  }

  private lookup(id: string): Obj | undefined {
    const kind = PREFIX[id.split('_')[0]!];
    if (!kind || !(kind in this.s)) return undefined;
    return (this.s as unknown as Record<string, Map<string, Obj>>)[kind]!.get(id);
  }

  private expand(obj: Obj, paths: string[]): Obj {
    const out = clone(obj);
    for (const p of paths) {
      const segs = p.split('.');
      const walk = (node: Json, i: number): Json => {
        if (i === segs.length) return node;
        if (Array.isArray(node)) return node.map((n) => walk(n, i));
        if (!node || typeof node !== 'object') return node;
        const o = node as Obj;
        const k = segs[i]!;
        let v = o[k];
        if (v === undefined) return o;
        if (i === segs.length - 1 && typeof v === 'string') v = clone(this.lookup(v) ?? v);
        o[k] = walk(v, i + 1);
        return o;
      };
      walk(out, 0);
    }
    return out;
  }

  private ok(body: Obj, req: FakeRequest): FakeResponse {
    const exp = req.method === 'GET' ? req.query.expand : (req.body.expand ?? req.query.expand);
    return { status: 200, body: Array.isArray(exp) ? this.expand(body, exp as string[]) : body };
  }

  private metadata(input: unknown, current: Json = {}): Obj {
    if (input === '' || input === undefined) return input === '' ? {} : (current as Obj);
    const out: Obj = { ...(current as Obj) };
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
      if (v === '') delete out[k];
      else out[k] = String(v);
    }
    return out;
  }

  // ---------------------------------------------------------------- lifecycle

  private invoiceFor(sub: Obj, periodStart: number, periodEnd: number, reason: string): Obj {
    const item = ((sub.items as Obj).data as Obj[])[0]!;
    const price = item.price as Obj;
    const amount = (price.unit_amount as number) * ((item.quantity as number) ?? 1);
    const id = this.ids.next('in');
    const lineId = this.ids.next('il');
    const now = this.now();
    const invoice = this.make('invoice', {
      id,
      object: 'invoice',
      customer: sub.customer,
      currency: sub.currency,
      created: now,
      period_start: periodStart,
      period_end: periodEnd,
      status: 'paid',
      amount_due: amount,
      amount_paid: amount,
      amount_remaining: 0,
      subtotal: amount,
      total: amount,
      billing_reason: reason,
      collection_method: 'charge_automatically',
      attempted: true,
      attempt_count: 1,
      parent: {
        type: 'subscription_details',
        quote_details: null,
        subscription_details: { subscription: sub.id, metadata: null },
      },
      lines: {
        object: 'list',
        has_more: false,
        url: `/v1/invoices/${id}/lines`,
        data: [
          this.make('line_item', {
            id: lineId,
            object: 'line_item',
            amount,
            subtotal: amount,
            currency: sub.currency,
            invoice: id,
            discountable: true,
            discounts: [],
            metadata: {},
            period: { start: periodStart, end: periodEnd },
          }),
        ],
      },
      status_transitions: { finalized_at: now, marked_uncollectible_at: null, paid_at: now, voided_at: null },
    });
    this.s.invoices.set(id, invoice);
    sub.latest_invoice = id;
    this.event('invoice.paid', invoice);
    return invoice;
  }

  private cancelNow(sub: Obj, at: number, reason: string): void {
    sub.status = 'canceled';
    sub.ended_at = at;
    if (sub.canceled_at === null) sub.canceled_at = at;
    sub.cancellation_details = { comment: null, feedback: null, reason };
    this.event('customer.subscription.deleted', sub);
  }

  /** Advance every live subscription to `now` (renew or cancel at period end). */
  private tick(now: number): void {
    for (const sub of this.s.subscriptions.values()) {
      for (let guard = 0; guard < 1000 && sub.status !== 'canceled'; guard++) {
        const item = ((sub.items as Obj).data as Obj[])[0]!;
        const end = item.current_period_end as number;
        const cancelAt = sub.cancel_at as number | null;
        if (cancelAt !== null && cancelAt <= now && cancelAt <= end) {
          this.cancelNow(sub, cancelAt, 'cancellation_requested');
          break;
        }
        if (end > now) break;
        const price = item.price as Obj;
        const rec = price.recurring as Obj;
        const next = addInterval(end, rec.interval as string, rec.interval_count as number);
        for (const it of (sub.items as Obj).data as Obj[]) {
          it.current_period_start = end;
          it.current_period_end = next;
        }
        this.invoiceFor(sub, end, next, 'subscription_cycle');
        this.event('customer.subscription.updated', sub, { items: null });
      }
    }
  }

  // ---------------------------------------------------------------- routing

  handle(req: FakeRequest): FakeResponse {
    const idem = req.method === 'POST' ? req.headers['idempotency-key'] : undefined;
    if (idem) {
      const prior = this.s.idempotency.get(idem);
      if (prior) {
        if (prior.path !== req.path) {
          return this.error(400, `Keys for idempotent requests can only be used for the same endpoint.`, {
            code: 'idempotency_key_in_use',
          });
        }
        return clone(prior.response);
      }
    }
    const res = this.route(req);
    if (idem && res.status < 500) this.s.idempotency.set(idem, { path: req.path, response: clone(res) });
    return res;
  }

  private route(req: FakeRequest): FakeResponse {
    const key = `${req.method} ${req.route}`;
    const b = req.body;
    const q = req.query;
    switch (key) {
      case 'POST /v1/customers':
        return this.createCustomer(req);
      case 'GET /v1/customers': {
        let items = [...this.s.customers.values()];
        if (typeof q.email === 'string') items = items.filter((c) => c.email === q.email);
        return this.ok(this.list(items, '/v1/customers', q), req);
      }
      case 'GET /v1/customers/{customer}': {
        const c = this.s.customers.get(req.params.customer!);
        return c ? this.ok(c, req) : this.missing('customer', req.params.customer!);
      }
      case 'POST /v1/customers/{customer}': {
        const c = this.s.customers.get(req.params.customer!);
        if (!c) return this.missing('customer', req.params.customer!);
        for (const f of ['email', 'name', 'description', 'phone'] as const) if (f in b) c[f] = b[f] as Json;
        if ('metadata' in b) c.metadata = this.metadata(b.metadata, c.metadata);
        this.event('customer.updated', c);
        return this.ok(c, req);
      }
      case 'DELETE /v1/customers/{customer}': {
        const id = req.params.customer!;
        const c = this.s.customers.get(id);
        if (!c) return this.missing('customer', id);
        for (const sub of this.s.subscriptions.values()) {
          if (sub.customer === id && sub.status !== 'canceled')
            this.cancelNow(sub, this.now(), 'cancellation_requested');
        }
        this.s.customers.delete(id);
        this.event('customer.deleted', c);
        return { status: 200, body: { id, object: 'customer', deleted: true } };
      }
      case 'POST /v1/products': {
        const id = typeof b.id === 'string' ? b.id : this.ids.next('prod');
        const p = this.make('product', {
          id,
          object: 'product',
          name: b.name as string,
          active: b.active === undefined ? true : (b.active as boolean),
          created: this.now(),
          updated: this.now(),
          images: [],
          marketing_features: [],
          metadata: this.metadata(b.metadata),
          description: (b.description as string) ?? null,
        });
        this.s.products.set(id, p);
        this.event('product.created', p);
        return this.ok(p, req);
      }
      case 'GET /v1/products/{id}': {
        const p = this.s.products.get(req.params.id!);
        return p ? this.ok(p, req) : this.missing('product', req.params.id!);
      }
      case 'POST /v1/prices':
        return this.createPrice(req);
      case 'GET /v1/prices': {
        let items = [...this.s.prices.values()];
        if (typeof q.product === 'string') items = items.filter((p) => p.product === q.product);
        if (Array.isArray(q.lookup_keys)) items = items.filter((p) => (q.lookup_keys as Json[]).includes(p.lookup_key));
        return this.ok(this.list(items, '/v1/prices', q), req);
      }
      case 'GET /v1/prices/{price}': {
        const p = this.s.prices.get(req.params.price!);
        return p ? this.ok(p, req) : this.missing('price', req.params.price!);
      }
      case 'POST /v1/subscriptions':
        return this.createSubscription(req);
      case 'GET /v1/subscriptions': {
        let items = [...this.s.subscriptions.values()];
        if (typeof q.customer === 'string') items = items.filter((s) => s.customer === q.customer);
        const status = typeof q.status === 'string' ? q.status : undefined;
        if (status === undefined) items = items.filter((s) => s.status !== 'canceled');
        else if (status !== 'all') items = items.filter((s) => s.status === status);
        if (typeof q.price === 'string') {
          items = items.filter((s) => ((s.items as Obj).data as Obj[]).some((i) => (i.price as Obj).id === q.price));
        }
        return this.ok(this.list(items, '/v1/subscriptions', q), req);
      }
      case 'GET /v1/subscriptions/{subscription_exposed_id}': {
        const s = this.s.subscriptions.get(req.params.subscription_exposed_id!);
        return s ? this.ok(s, req) : this.missing('subscription', req.params.subscription_exposed_id!);
      }
      case 'POST /v1/subscriptions/{subscription_exposed_id}':
        return this.updateSubscription(req);
      case 'DELETE /v1/subscriptions/{subscription_exposed_id}': {
        const id = req.params.subscription_exposed_id!;
        const s = this.s.subscriptions.get(id);
        if (!s) return this.missing('subscription', id);
        if (s.status === 'canceled') {
          return this.error(400, `A canceled subscription can only update its cancellation_details and metadata.`, {
            code: 'resource_missing',
          });
        }
        this.cancelNow(s, this.now(), 'cancellation_requested');
        const details = b.cancellation_details as Obj | undefined;
        if (details) s.cancellation_details = { ...(s.cancellation_details as Obj), ...details };
        return this.ok(s, req);
      }
      case 'GET /v1/invoices': {
        let items = [...this.s.invoices.values()];
        if (typeof q.customer === 'string') items = items.filter((i) => i.customer === q.customer);
        if (typeof q.subscription === 'string') {
          items = items.filter(
            (i) => ((i.parent as Obj | null)?.subscription_details as Obj | undefined)?.subscription === q.subscription,
          );
        }
        if (typeof q.status === 'string') items = items.filter((i) => i.status === q.status);
        return this.ok(this.list(items, '/v1/invoices', q), req);
      }
      case 'GET /v1/events': {
        let items = [...this.s.events.values()];
        if (typeof q.type === 'string') {
          const t = q.type;
          items = items.filter((e) => (t.endsWith('.*') ? String(e.type).startsWith(t.slice(0, -1)) : e.type === t));
        }
        return this.ok(this.list(items, '/v1/events', q), req);
      }
      default:
        return this.error(404, `The Stripe fake does not implement ${req.method} ${req.route ?? req.path} yet.`);
    }
  }

  private createCustomer(req: FakeRequest): FakeResponse {
    const b = req.body;
    const id = this.ids.next('cus');
    const c = this.make('customer', {
      id,
      object: 'customer',
      created: this.now(),
      email: (b.email as string) ?? null,
      name: (b.name as string) ?? null,
      description: (b.description as string) ?? null,
      phone: (b.phone as string) ?? null,
      metadata: this.metadata(b.metadata),
      balance: 0,
      currency: null,
      delinquent: false,
      invoice_prefix: id.slice(4, 12).toUpperCase(),
    });
    this.s.customers.set(id, c);
    this.event('customer.created', c);
    return this.ok(c, req);
  }

  private createPrice(req: FakeRequest): FakeResponse {
    const b = req.body;
    if (typeof b.product !== 'string' || !this.s.products.has(b.product)) {
      return this.missing('product', String(b.product ?? ''), 'product');
    }
    const id = this.ids.next('price');
    const rec = b.recurring as Record<string, unknown> | undefined;
    const p = this.make('price', {
      id,
      object: 'price',
      active: true,
      billing_scheme: 'per_unit',
      created: this.now(),
      currency: b.currency as string,
      product: b.product,
      type: rec ? 'recurring' : 'one_time',
      unit_amount: (b.unit_amount as number) ?? null,
      unit_amount_decimal: b.unit_amount === undefined ? null : String(b.unit_amount),
      lookup_key: (b.lookup_key as string) ?? null,
      nickname: (b.nickname as string) ?? null,
      metadata: this.metadata(b.metadata),
      tax_behavior: 'unspecified',
      recurring: rec
        ? {
            interval: rec.interval as string,
            interval_count: (rec.interval_count as number) ?? 1,
            meter: null,
            usage_type: 'licensed',
          }
        : null,
    });
    this.s.prices.set(id, p);
    this.event('price.created', p);
    return this.ok(p, req);
  }

  private createSubscription(req: FakeRequest): FakeResponse {
    const b = req.body;
    const customer = b.customer as string;
    if (!this.s.customers.has(customer)) return this.missing('customer', customer, 'customer');
    const items = (b.items as Record<string, unknown>[] | undefined) ?? [];
    if (items.length === 0) return this.error(400, 'Missing required param: items.', { param: 'items' });
    const id = this.ids.next('sub');
    const now = this.now();
    let currency: string | undefined;
    const subItems: Obj[] = [];
    let end = now;
    for (const [i, it] of items.entries()) {
      const price = this.s.prices.get(it.price as string);
      if (!price) return this.missing('price', String(it.price), `items[${i}][price]`);
      if (price.type !== 'recurring') {
        return this.error(
          400,
          `The price specified is set to \`type=one_time\` but this field only accepts prices with \`type=recurring\`.`,
          {
            param: `items[${i}][price]`,
          },
        );
      }
      currency ??= price.currency as string;
      const rec = price.recurring as Obj;
      end = addInterval(now, rec.interval as string, rec.interval_count as number);
      subItems.push(
        this.make('subscription_item', {
          id: this.ids.next('si'),
          object: 'subscription_item',
          created: now,
          current_period_start: now,
          current_period_end: end,
          discounts: [],
          metadata: {},
          price: clone(price),
          quantity: (it.quantity as number) ?? 1,
          subscription: id,
          tax_rates: [],
        }),
      );
    }
    const sub = this.make('subscription', {
      id,
      object: 'subscription',
      customer,
      currency: currency!,
      created: now,
      start_date: now,
      billing_cycle_anchor: now,
      status: 'active',
      cancel_at_period_end: false,
      cancel_at: null,
      canceled_at: null,
      ended_at: null,
      cancellation_details: { comment: null, feedback: null, reason: null },
      collection_method: 'charge_automatically',
      metadata: this.metadata(b.metadata),
      items: { object: 'list', data: subItems, has_more: false, url: `/v1/subscription_items?subscription=${id}` },
      latest_invoice: null,
      description: (b.description as string) ?? null,
    });
    this.s.subscriptions.set(id, sub);
    this.invoiceFor(sub, now, end, 'subscription_create');
    this.event('customer.subscription.created', sub);
    if (b.cancel_at_period_end === true) {
      sub.cancel_at_period_end = true;
      sub.cancel_at = end;
      sub.canceled_at = now;
    }
    return this.ok(sub, req);
  }

  private updateSubscription(req: FakeRequest): FakeResponse {
    const id = req.params.subscription_exposed_id!;
    const sub = this.s.subscriptions.get(id);
    if (!sub) return this.missing('subscription', id);
    const b = req.body;
    if (sub.status === 'canceled') {
      const allowed = new Set(['metadata', 'cancellation_details', 'expand']);
      if (Object.keys(b).some((k) => !allowed.has(k))) {
        return this.error(400, 'A canceled subscription can only update its cancellation_details and metadata.');
      }
    }
    const previous: Obj = {};
    const end = ((sub.items as Obj).data as Obj[])[0]!.current_period_end as number;
    if (b.cancel_at_period_end !== undefined) {
      previous.cancel_at_period_end = sub.cancel_at_period_end;
      previous.cancel_at = sub.cancel_at;
      if (b.cancel_at_period_end === true) {
        sub.cancel_at_period_end = true;
        sub.cancel_at = end;
        sub.canceled_at = this.now();
      } else {
        sub.cancel_at_period_end = false;
        sub.cancel_at = null;
        sub.canceled_at = null;
      }
    }
    if (b.cancel_at !== undefined) {
      previous.cancel_at = sub.cancel_at;
      if (b.cancel_at === '') {
        sub.cancel_at = null;
        sub.canceled_at = null;
        sub.cancel_at_period_end = false;
      } else {
        sub.cancel_at = b.cancel_at as number;
        sub.canceled_at = this.now();
        sub.cancel_at_period_end = b.cancel_at === end;
      }
    }
    if (b.metadata !== undefined) {
      previous.metadata = sub.metadata;
      sub.metadata = this.metadata(b.metadata, sub.metadata);
    }
    if (b.cancellation_details !== undefined) {
      sub.cancellation_details = { ...(sub.cancellation_details as Obj), ...(b.cancellation_details as Obj) };
    }
    if (b.description !== undefined) sub.description = b.description === '' ? null : (b.description as string);
    this.event('customer.subscription.updated', sub, previous);
    // A cancel_at in the past/now takes effect immediately.
    this.tick(this.now());
    return this.ok(sub, req);
  }
}
