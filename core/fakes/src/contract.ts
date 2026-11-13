/**
 * OpenAPI 3.0 contract: route matching, request coercion + validation,
 * response validation (strict: no undocumented fields), and synthesis of
 * minimal spec-valid objects. Fakes are "generated from OpenAPI" through this:
 * every object a fake returns starts as `synthesize(schema)` and every response
 * is validated before it leaves the fake.
 */
import { Ajv, type ValidateFunction, type ErrorObject } from 'ajv';

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
type Schema = Record<string, unknown>;

export interface OpenApiDoc {
  openapi: string;
  info: { title: string; version: string };
  paths: Record<string, Record<string, Operation>>;
  components?: { schemas?: Record<string, Schema> };
  [k: string]: unknown;
}

export interface Operation {
  operationId?: string;
  parameters?: Parameter[];
  requestBody?: { content?: Record<string, { schema?: Schema }> };
  responses: Record<string, { content?: Record<string, { schema?: Schema }> } | undefined>;
}

export interface Parameter {
  name: string;
  in: 'query' | 'path' | 'header' | 'cookie';
  required?: boolean;
  schema?: Schema;
}

export interface MatchedOperation {
  method: string;
  template: string;
  operation: Operation;
  pathParams: Record<string, string>;
}

export interface ContractViolation {
  kind: 'request' | 'response' | 'route';
  operation: string;
  message: string;
  path?: string;
}

const DOC_ID = 'openapi-doc';

function rewriteRefs(o: unknown): unknown {
  if (Array.isArray(o)) return o.map(rewriteRefs);
  if (o && typeof o === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(o)) {
      out[k] = k === '$ref' && typeof v === 'string' && v.startsWith('#/') ? `${DOC_ID}${v}` : rewriteRefs(v);
    }
    return out;
  }
  return o;
}

/** OpenAPI 3.0 -> JSON Schema: `nullable: true` becomes an explicit null alternative. */
function normalizeNullable(o: unknown): unknown {
  if (Array.isArray(o)) return o.map(normalizeNullable);
  if (o && typeof o === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(o)) out[k] = k === 'enum' || k === 'required' ? v : normalizeNullable(v);
    if (out.nullable === true) {
      delete out.nullable;
      if (Array.isArray(out.enum)) out.enum = [...(out.enum as unknown[]), null];
      if (typeof out.type === 'string') return { ...out, type: [out.type, 'null'] };
      if (Array.isArray(out.anyOf)) return { ...out, anyOf: [...(out.anyOf as unknown[]), { type: 'null' }] };
      return { anyOf: [out, { type: 'null' }] };
    }
    if (out.nullable === false) delete out.nullable;
    // Response shapes are checked for conformance, not for branch exclusivity:
    // loose sibling schemas (e.g. GitHub error objects) would make oneOf fail.
    if (Array.isArray(out.oneOf)) {
      out.anyOf = out.oneOf;
      delete out.oneOf;
      delete out.discriminator;
    }
    return out;
  }
  return o;
}

/** Close every object schema that lists properties but does not say anything about extras. */
function closeObjects(o: unknown, inAllOf = false): unknown {
  if (Array.isArray(o)) return o.map((v) => closeObjects(v, inAllOf));
  if (o && typeof o === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(o)) {
      // allOf branches each see only part of the object; closing them would reject the rest.
      out[k] =
        k === 'enum' || k === 'required' || k === 'examples' || k === 'example' ? v : closeObjects(v, k === 'allOf');
    }
    if (
      !inAllOf &&
      !('allOf' in out) &&
      out.properties &&
      typeof out.properties === 'object' &&
      !('additionalProperties' in out)
    ) {
      out.additionalProperties = false;
    }
    return out;
  }
  return o;
}

function formatErrors(errors: ErrorObject[] | null | undefined): string[] {
  return (errors ?? []).slice(0, 10).map((e) => {
    const where = e.instancePath || '(root)';
    if (e.keyword === 'additionalProperties') {
      return `${where}: undocumented property "${(e.params as { additionalProperty: string }).additionalProperty}"`;
    }
    return `${where}: ${e.message}`;
  });
}

export class Contract {
  readonly doc: OpenApiDoc;
  private readonly lenient: Ajv;
  private readonly strict: Ajv;
  private readonly routes: { method: string; template: string; re: RegExp; keys: string[]; op: Operation }[] = [];
  private readonly cache = new Map<string, ValidateFunction>();

  constructor(doc: OpenApiDoc) {
    this.doc = doc;
    const opts = { strict: false, allErrors: true, validateFormats: false } as const;
    this.lenient = new Ajv(opts);
    this.strict = new Ajv(opts);
    const components = normalizeNullable(doc.components ?? {}) as object;
    this.lenient.addSchema({ $id: DOC_ID, components });
    this.strict.addSchema({ $id: DOC_ID, components: closeObjects(components) as object });
    for (const [template, methods] of Object.entries(doc.paths)) {
      const keys: string[] = [];
      const re = new RegExp(
        '^' +
          template.replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/\\?\{([^}]+)\\?\}/g, (_m, k: string) => {
            keys.push(k);
            // a trailing {path} parameter (e.g. GitHub contents) may contain slashes
            return k === 'path' ? '(.+)' : '([^/]+)';
          }) +
          '$',
      );
      for (const [method, op] of Object.entries(methods)) {
        this.routes.push({ method: method.toUpperCase(), template, re, keys, op });
      }
    }
    // Prefer literal routes over templated ones ("/v1/customers/search" before "/v1/customers/{id}").
    this.routes.sort((a, b) => a.keys.length - b.keys.length);
  }

  get version(): string {
    return this.doc.info.version;
  }

  operations(): { method: string; template: string; operationId?: string }[] {
    return this.routes.map((r) => ({ method: r.method, template: r.template, operationId: r.op.operationId }));
  }

  match(method: string, path: string): MatchedOperation | undefined {
    const m = method.toUpperCase();
    for (const r of this.routes) {
      if (r.method !== m) continue;
      const res = r.re.exec(path);
      if (!res) continue;
      const pathParams: Record<string, string> = {};
      r.keys.forEach((k, i) => (pathParams[k] = decodeURIComponent(res[i + 1]!)));
      return { method: m, template: r.template, operation: r.op, pathParams };
    }
    return undefined;
  }

  schema(name: string): Schema {
    const s = this.doc.components?.schemas?.[name];
    if (!s) throw new Error(`schema ${name} not in contract`);
    return s;
  }

  private compile(key: string, schema: unknown, strict: boolean): ValidateFunction {
    const k = `${strict ? 's' : 'l'}:${key}`;
    let fn = this.cache.get(k);
    if (!fn) {
      const normalized = normalizeNullable(schema);
      const prepared = rewriteRefs(strict ? closeObjects(normalized) : normalized) as object;
      fn = (strict ? this.strict : this.lenient).compile(prepared);
      this.cache.set(k, fn);
    }
    return fn;
  }

  private resolve(schema: Schema | undefined, depth = 0): Schema | undefined {
    if (!schema || depth > 20) return schema;
    const ref = schema.$ref;
    if (typeof ref === 'string') {
      const name = ref.split('/').pop()!;
      return this.resolve(this.doc.components?.schemas?.[name], depth + 1);
    }
    return schema;
  }

  /** Coerce form/query strings into the types the schema expects (Stripe sends everything as strings). */
  coerce(schema: Schema | undefined, value: unknown, depth = 0): unknown {
    const s = this.resolve(schema);
    if (!s || depth > 30) return value;
    if (Array.isArray(s.anyOf)) {
      const branches = (s.anyOf as Schema[]).map((b) => this.resolve(b)!).filter(Boolean);
      const pick = (pred: (b: Schema) => boolean) => branches.find(pred);
      if (typeof value === 'string') {
        if (value === '' && pick((b) => Array.isArray(b.enum) && b.enum.includes(''))) return '';
        if ((value === 'true' || value === 'false') && pick((b) => b.type === 'boolean')) return value === 'true';
        if (/^-?\d+(\.\d+)?$/.test(value)) {
          const num = pick((b) => b.type === 'integer' || b.type === 'number');
          if (num) return Number(value);
        }
        return value;
      }
      if (Array.isArray(value))
        return this.coerce(
          pick((b) => b.type === 'array'),
          value,
          depth + 1,
        );
      if (value && typeof value === 'object') {
        return this.coerce(
          pick((b) => b.type === 'object' || !!b.properties),
          value,
          depth + 1,
        );
      }
      return value;
    }
    switch (s.type) {
      case 'boolean':
        return value === 'true' ? true : value === 'false' ? false : value;
      case 'integer':
      case 'number':
        return typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value) ? Number(value) : value;
      case 'array': {
        const arr = Array.isArray(value) ? value : value === undefined ? value : [value];
        return Array.isArray(arr) ? arr.map((v) => this.coerce(s.items as Schema, v, depth + 1)) : arr;
      }
      default: {
        if (value && typeof value === 'object' && !Array.isArray(value)) {
          const props = (s.properties ?? {}) as Record<string, Schema>;
          const extra = typeof s.additionalProperties === 'object' ? (s.additionalProperties as Schema) : undefined;
          const out: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(value)) out[k] = this.coerce(props[k] ?? extra, v, depth + 1);
          return out;
        }
        return value;
      }
    }
  }

  /** Validates (and coerces) query + body against the operation; returns coerced copies. */
  validateRequest(
    m: MatchedOperation,
    query: Record<string, unknown>,
    body: Record<string, unknown>,
  ): { query: Record<string, unknown>; body: Record<string, unknown>; errors: string[] } {
    const errors: string[] = [];
    const qParams = this.parameters(m.operation).filter((p) => p.in === 'query');
    const qSchema: Schema = {
      type: 'object',
      properties: Object.fromEntries(qParams.map((p) => [p.name, p.schema ?? {}])),
      required: qParams.filter((p) => p.required).map((p) => p.name),
      additionalProperties: false,
    };
    const q = this.coerce(qSchema, query) as Record<string, unknown>;
    const qv = this.compile(`${m.method} ${m.template} query`, qSchema, false);
    if (!qv(q)) errors.push(...formatErrors(qv.errors).map((e) => `query ${e}`));

    const content = m.operation.requestBody?.content ?? {};
    const bSchema = (content['application/x-www-form-urlencoded'] ?? content['application/json'])?.schema;
    let b = body;
    if (bSchema) {
      b = this.coerce(bSchema, body) as Record<string, unknown>;
      const bv = this.compile(`${m.method} ${m.template} body`, bSchema, false);
      if (!bv(b)) errors.push(...formatErrors(bv.errors).map((e) => `body ${e}`));
    } else if (Object.keys(body).length > 0) {
      errors.push('body: operation takes no request body');
    }
    return { query: q, body: b, errors };
  }

  /** Operation parameters with component $refs resolved. */
  parameters(op: Operation): Parameter[] {
    return (op.parameters ?? []).map((p) => {
      const ref = (p as unknown as { $ref?: string }).$ref;
      if (!ref) return p;
      const name = ref.split('/').pop()!;
      const resolved = (this.doc.components as Record<string, Record<string, Parameter>> | undefined)?.parameters?.[
        name
      ];
      if (!resolved) throw new Error(`unresolved parameter ${ref}`);
      return resolved;
    });
  }

  private response(op: Operation, status: number | 'default') {
    let r = op.responses[String(status)] as Record<string, unknown> | undefined;
    const ref = r?.$ref;
    if (typeof ref === 'string') {
      r = (this.doc.components as Record<string, Record<string, Record<string, unknown>>> | undefined)?.responses?.[
        ref.split('/').pop()!
      ];
    }
    return r as { content?: Record<string, { schema?: Schema }> } | undefined;
  }

  /** Strict response validation: wrong types, missing required fields and undocumented fields all fail. */
  validateResponse(m: MatchedOperation, status: number, body: unknown): string[] {
    const r = this.response(m.operation, status) ?? (status >= 400 ? this.response(m.operation, 'default') : undefined);
    const documented = String(status) in m.operation.responses;
    const schema = r?.content?.['application/json']?.schema;
    if (!schema) {
      if (status >= 400) return [];
      if (!documented) return [`status ${status} is not documented`];
      return body === null || body === undefined || body === '' ? [] : [`status ${status} documents no body`];
    }
    const v = this.compile(`${m.method} ${m.template} ${status}`, schema, true);
    return v(body) ? [] : formatErrors(v.errors);
  }

  /** Validate an arbitrary value against a named component schema (strict). */
  validateSchema(name: string, value: unknown): string[] {
    const v = this.compile(`component ${name}`, { $ref: `#/components/schemas/${name}` }, true);
    return v(value) ? [] : formatErrors(v.errors);
  }

  /**
   * Build the minimal spec-valid value for a schema: nullable -> null, enums
   * -> first value, objects -> all required properties synthesized.
   */
  synthesize(schemaOrName: Schema | string, depth = 0): Json {
    const s = this.resolve(typeof schemaOrName === 'string' ? this.schema(schemaOrName) : schemaOrName);
    if (!s) return null;
    if (s.nullable === true) return null;
    if (Array.isArray(s.anyOf)) {
      const branches = s.anyOf as Schema[];
      if (branches.some((b) => this.resolve(b)?.nullable === true)) return null;
      const prim = branches.find((b) => {
        const r = this.resolve(b);
        return r?.type === 'string' && !r.enum;
      });
      return this.synthesize(prim ?? branches[0]!, depth + 1);
    }
    if (Array.isArray(s.allOf)) {
      const merged: Record<string, Json> = {};
      for (const b of s.allOf as Schema[]) {
        const part = this.synthesize(b, depth + 1);
        if (part && typeof part === 'object' && !Array.isArray(part)) Object.assign(merged, part);
      }
      return merged;
    }
    if (Array.isArray(s.oneOf) && s.oneOf.length) return this.synthesize((s.oneOf as Schema[])[0]!, depth + 1);
    if (Array.isArray(s.enum) && s.enum.length) return s.enum[0] as Json;
    switch (s.type) {
      case 'string':
        return '';
      case 'integer':
      case 'number':
        return 0;
      case 'boolean':
        return false;
      case 'array':
        return [];
      default: {
        if (depth > 12) return {};
        const out: Record<string, Json> = {};
        const props = (s.properties ?? {}) as Record<string, Schema>;
        for (const k of (s.required as string[] | undefined) ?? []) {
          out[k] = props[k] ? this.synthesize(props[k], depth + 1) : null;
        }
        return out;
      }
    }
  }
}
