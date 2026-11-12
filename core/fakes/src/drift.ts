/**
 * Drift detection — is the fake still faithful to the real API?
 *  1. spec drift: a newer OpenAPI document vs the vendored one, restricted to
 *     the operations the fake implements and the schemas they reach.
 *  2. traffic drift: replay recorded real traffic (cassette) against a fresh
 *     fake; recorded responses that violate the contract mean the API moved,
 *     and fake responses whose status/shape differ mean the fake is wrong.
 *  3. client drift: clients pinned to an API version other than the contract.
 */
import type { Contract, Json, OpenApiDoc } from './contract.js';
import type { CassetteEntry } from './recorder.js';
import { encodeForm } from './form.js';
import type { FakeServer } from './server.js';

export type DriftSeverity = 'breaking' | 'warning' | 'info';

export interface DriftItem {
  severity: DriftSeverity;
  kind: 'operation' | 'schema' | 'parameter' | 'traffic' | 'version';
  location: string;
  message: string;
}

export interface DriftReport {
  items: DriftItem[];
  breaking: number;
  warnings: number;
}

function report(items: DriftItem[]): DriftReport {
  return {
    items,
    breaking: items.filter((i) => i.severity === 'breaking').length,
    warnings: items.filter((i) => i.severity === 'warning').length,
  };
}

type Schema = Record<string, unknown>;

function refName(s: unknown): string | undefined {
  const r = (s as Schema | undefined)?.$ref;
  return typeof r === 'string' ? r.split('/').pop() : undefined;
}

function typeOf(s: Schema | undefined): string {
  if (!s) return 'missing';
  const r = refName(s);
  if (r) return `ref:${r}`;
  if (Array.isArray(s.anyOf)) return `anyOf(${(s.anyOf as Schema[]).map(typeOf).sort().join('|')})`;
  return `${String(s.type ?? 'any')}${s.nullable ? '?' : ''}`;
}

function collectRefs(o: unknown, acc: Set<string>): Set<string> {
  if (Array.isArray(o)) o.forEach((v) => collectRefs(v, acc));
  else if (o && typeof o === 'object') {
    for (const [k, v] of Object.entries(o)) {
      if (k === '$ref' && typeof v === 'string') acc.add(v.split('/').pop()!);
      else collectRefs(v, acc);
    }
  }
  return acc;
}

/** Compare the vendored contract against a newer spec, for the operations the fake implements. */
export function detectSpecDrift(current: OpenApiDoc, next: OpenApiDoc): DriftReport {
  const items: DriftItem[] = [];
  if (current.info.version !== next.info.version) {
    items.push({
      severity: 'info',
      kind: 'version',
      location: 'info.version',
      message: `API version ${current.info.version} -> ${next.info.version}`,
    });
  }
  const reachable = new Set<string>();
  for (const [path, methods] of Object.entries(current.paths)) {
    for (const [method, op] of Object.entries(methods)) {
      const loc = `${method.toUpperCase()} ${path}`;
      const nextOp = next.paths[path]?.[method];
      if (!nextOp) {
        items.push({ severity: 'breaking', kind: 'operation', location: loc, message: 'operation removed upstream' });
        continue;
      }
      collectRefs(op, reachable);
      const params = (o: typeof op) => new Map((o.parameters ?? []).map((p) => [p.name, p]));
      const cur = params(op);
      const nxt = params(nextOp);
      for (const [n, p] of nxt) {
        if (!cur.has(n)) {
          items.push({
            severity: p.required ? 'breaking' : 'info',
            kind: 'parameter',
            location: `${loc} ?${n}`,
            message: p.required ? 'new required parameter' : 'new optional parameter',
          });
        }
      }
      for (const n of cur.keys()) {
        if (!nxt.has(n))
          items.push({
            severity: 'warning',
            kind: 'parameter',
            location: `${loc} ?${n}`,
            message: 'parameter removed',
          });
      }
      const bodyProps = (o: typeof op) =>
        (o.requestBody?.content?.['application/x-www-form-urlencoded']?.schema?.properties ?? {}) as Record<
          string,
          Schema
        >;
      const cb = bodyProps(op);
      const nb = bodyProps(nextOp);
      for (const k of Object.keys(nb)) {
        if (!(k in cb))
          items.push({
            severity: 'info',
            kind: 'parameter',
            location: `${loc} body.${k}`,
            message: 'new body parameter',
          });
      }
      for (const k of Object.keys(cb)) {
        if (!(k in nb))
          items.push({
            severity: 'breaking',
            kind: 'parameter',
            location: `${loc} body.${k}`,
            message: 'body parameter removed',
          });
      }
    }
  }
  // transitive closure of schemas reachable from implemented operations
  const todo = [...reachable];
  while (todo.length) {
    const n = todo.pop()!;
    for (const r of collectRefs(current.components?.schemas?.[n], new Set())) {
      if (!reachable.has(r)) {
        reachable.add(r);
        todo.push(r);
      }
    }
  }
  for (const name of [...reachable].sort()) {
    const a = current.components?.schemas?.[name];
    const b = next.components?.schemas?.[name];
    if (!a) continue;
    if (!b) {
      items.push({ severity: 'breaking', kind: 'schema', location: name, message: 'schema removed upstream' });
      continue;
    }
    const ap = (a.properties ?? {}) as Record<string, Schema>;
    const bp = (b.properties ?? {}) as Record<string, Schema>;
    const areq = new Set((a.required as string[] | undefined) ?? []);
    const breq = new Set((b.required as string[] | undefined) ?? []);
    for (const k of Object.keys(bp)) {
      if (!(k in ap)) {
        items.push({
          severity: breq.has(k) ? 'breaking' : 'warning',
          kind: 'schema',
          location: `${name}.${k}`,
          message: breq.has(k) ? 'new required field: the fake does not produce it' : 'new optional field',
        });
      }
    }
    for (const k of Object.keys(ap)) {
      if (!(k in bp)) {
        items.push({
          severity: 'breaking',
          kind: 'schema',
          location: `${name}.${k}`,
          message: 'field removed upstream',
        });
      } else if (typeOf(ap[k]) !== typeOf(bp[k])) {
        items.push({
          severity: 'breaking',
          kind: 'schema',
          location: `${name}.${k}`,
          message: `type changed ${typeOf(ap[k])} -> ${typeOf(bp[k])}`,
        });
      } else if (!areq.has(k) && breq.has(k)) {
        items.push({
          severity: 'breaking',
          kind: 'schema',
          location: `${name}.${k}`,
          message: 'field became required',
        });
      }
      const ae = ap[k]?.enum as Json[] | undefined;
      const be = bp[k]?.enum as Json[] | undefined;
      if (ae && be) {
        for (const v of be)
          if (!ae.includes(v))
            items.push({
              severity: 'warning',
              kind: 'schema',
              location: `${name}.${k}`,
              message: `new enum value ${JSON.stringify(v)}`,
            });
      }
    }
  }
  return report(items);
}

/** Structural shape of a JSON value: keys + primitive types, arrays by first element. */
export function shapeOf(v: Json): Json {
  if (v === null) return 'null';
  if (Array.isArray(v)) return v.length ? [shapeOf(v[0]!)] : [];
  if (typeof v === 'object') {
    return Object.fromEntries(
      Object.keys(v)
        .sort()
        .map((k) => [k, shapeOf(v[k]!)]),
    );
  }
  return typeof v;
}

function shapeDiff(recorded: Json, fake: Json, path: string, out: string[]): void {
  if (recorded === null || fake === null) return; // nullability differences are state, not shape
  if (Array.isArray(recorded) || Array.isArray(fake)) {
    if (Array.isArray(recorded) && Array.isArray(fake) && recorded.length && fake.length) {
      shapeDiff(recorded[0]!, fake[0]!, `${path}[]`, out);
    } else if (Array.isArray(recorded) !== Array.isArray(fake)) out.push(`${path}: array vs ${typeof fake}`);
    return;
  }
  if (typeof recorded === 'object' && typeof fake === 'object') {
    for (const k of Object.keys(recorded)) {
      if (!(k in fake)) out.push(`${path}.${k}: present in recorded traffic, missing from fake`);
      else shapeDiff(recorded[k]!, fake[k]!, `${path}.${k}`, out);
    }
    return;
  }
  if (typeof recorded !== typeof fake)
    out.push(`${path}: ${typeof recorded} in recorded traffic, ${typeof fake} from fake`);
}

function collectIds(v: Json, acc: string[]): string[] {
  if (Array.isArray(v)) v.forEach((x) => collectIds(x, acc));
  else if (v && typeof v === 'object') {
    if (typeof v.id === 'string') acc.push(v.id);
    for (const x of Object.values(v)) collectIds(x, acc);
  }
  return acc;
}

function substitute(v: unknown, map: Map<string, string>): unknown {
  if (typeof v === 'string') return map.get(v) ?? v;
  if (Array.isArray(v)) return v.map((x) => substitute(x, map));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, substitute(x, map)]));
  return v;
}

/**
 * Replays a cassette against a freshly reset fake. Ids in later requests are
 * rewritten from recorded ids to the fake's ids (matched by position).
 */
export async function detectTrafficDrift(
  contract: Contract,
  server: FakeServer,
  cassette: CassetteEntry[],
  opts: { apiKey?: string; seed?: number } = {},
): Promise<DriftReport> {
  const items: DriftItem[] = [];
  server.reset(opts.seed ?? 1);
  const idMap = new Map<string, string>();
  for (const [i, entry] of cassette.entries()) {
    const loc = `#${i + 1} ${entry.method} ${entry.path}`;
    const matched = contract.match(entry.method, entry.path);
    if (!matched) {
      items.push({ severity: 'warning', kind: 'traffic', location: loc, message: 'recorded route not in contract' });
      continue;
    }
    if (entry.status < 400) {
      for (const e of contract.validateResponse(matched, entry.status, entry.response)) {
        items.push({
          severity: 'breaking',
          kind: 'traffic',
          location: loc,
          message: `real response violates contract: ${e}`,
        });
      }
    }
    const path = entry.path
      .split('/')
      .map((seg) => idMap.get(seg) ?? seg)
      .join('/');
    const query = substitute(entry.query, idMap) as Record<string, unknown>;
    const body = substitute(entry.body, idMap) as Record<string, unknown>;
    const qs = encodeForm(query);
    const res = await server.request(entry.method, qs ? `${path}?${qs}` : path, encodeForm(body), {
      authorization: `Bearer ${opts.apiKey ?? 'sk_test_drift'}`,
      'content-type': 'application/x-www-form-urlencoded',
    });
    if (res.status !== entry.status) {
      items.push({
        severity: 'breaking',
        kind: 'traffic',
        location: loc,
        message: `status differs: recorded ${entry.status}, fake ${res.status}`,
      });
      continue;
    }
    const diffs: string[] = [];
    shapeDiff(entry.response, res.body, '$', diffs);
    for (const d of diffs) items.push({ severity: 'warning', kind: 'traffic', location: loc, message: d });
    const recIds = collectIds(entry.response, []);
    const fakeIds = collectIds(res.body, []);
    recIds.forEach((id, j) => {
      if (fakeIds[j] && !idMap.has(id)) idMap.set(id, fakeIds[j]!);
    });
  }
  return report(items);
}

/** Clients that pin a different API version than the contract. */
export function detectClientVersionDrift(contract: Contract, versionsSeen: Iterable<string>): DriftReport {
  const items: DriftItem[] = [];
  for (const v of versionsSeen) {
    if (v !== contract.version) {
      items.push({
        severity: 'warning',
        kind: 'version',
        location: 'Stripe-Version',
        message: `client pinned ${v}; fake contract is ${contract.version}`,
      });
    }
  }
  return report(items);
}

/**
 * Compare recorded objects (e.g. Stripe's published fixtures) with component
 * schemas: fields the API returns that the contract does not document, and
 * required fields that are absent.
 */
export function detectFixtureDrift(contract: Contract, fixtures: Record<string, Json>): DriftReport {
  const items: DriftItem[] = [];
  for (const [name, obj] of Object.entries(fixtures)) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) continue;
    let schema: Schema;
    try {
      schema = contract.schema(name);
    } catch {
      items.push({
        severity: 'warning',
        kind: 'schema',
        location: name,
        message: 'recorded object has no schema in contract',
      });
      continue;
    }
    const props = (schema.properties ?? {}) as Record<string, Schema>;
    for (const k of Object.keys(obj).sort()) {
      if (!(k in props)) {
        items.push({
          severity: 'warning',
          kind: 'schema',
          location: `${name}.${k}`,
          message: 'recorded field not in contract',
        });
      }
    }
    for (const k of (schema.required as string[] | undefined) ?? []) {
      if (!(k in obj))
        items.push({
          severity: 'breaking',
          kind: 'schema',
          location: `${name}.${k}`,
          message: 'required field missing from recorded object',
        });
    }
  }
  return report(items);
}
