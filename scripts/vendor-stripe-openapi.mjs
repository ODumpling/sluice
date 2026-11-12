#!/usr/bin/env node
// Regenerates core/fakes/vendor/stripe/* from Stripe's published OpenAPI spec and
// fixtures (https://github.com/stripe/openapi). Run manually when upgrading:
//   curl -sLO https://raw.githubusercontent.com/stripe/openapi/master/openapi/spec3.json
//   curl -sLO https://raw.githubusercontent.com/stripe/openapi/master/openapi/fixtures3.json
//   node scripts/vendor-stripe-openapi.mjs spec3.json fixtures3.json
// Only the operations the fake implements (+ transitively referenced schemas) are kept;
// descriptions are stripped to keep the vendored file small.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [specPath, fixturesPath] = process.argv.slice(2);
if (!specPath || !fixturesPath) {
  console.error('usage: vendor-stripe-openapi.mjs <spec3.json> <fixtures3.json>');
  process.exit(2);
}
const OPERATIONS = {
  '/v1/customers': ['get', 'post'],
  '/v1/customers/{customer}': ['get', 'post', 'delete'],
  '/v1/products': ['post'],
  '/v1/products/{id}': ['get'],
  '/v1/prices': ['get', 'post'],
  '/v1/prices/{price}': ['get'],
  '/v1/subscriptions': ['get', 'post'],
  '/v1/subscriptions/{subscription_exposed_id}': ['get', 'post', 'delete'],
  '/v1/invoices': ['get'],
  '/v1/events': ['get'],
};
const FIXTURES = ['customer', 'product', 'price', 'subscription', 'invoice', 'event'];

const raw = readFileSync(specPath);
const spec = JSON.parse(raw);
const fixtures = JSON.parse(readFileSync(fixturesPath, 'utf8'));

function strip(o) {
  if (Array.isArray(o)) return o.map(strip);
  if (o && typeof o === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(o)) {
      if (k === 'description' && typeof v === 'string') continue;
      out[k] = strip(v);
    }
    return out;
  }
  return o;
}
function refs(o, acc) {
  if (Array.isArray(o)) o.forEach((v) => refs(v, acc));
  else if (o && typeof o === 'object')
    for (const [k, v] of Object.entries(o)) {
      if (k === '$ref') acc.add(v.split('/').pop());
      else refs(v, acc);
    }
  return acc;
}

const paths = {};
const todo = new Set();
for (const [p, methods] of Object.entries(OPERATIONS)) {
  paths[p] = {};
  for (const m of methods) {
    const op = spec.paths[p]?.[m];
    if (!op) throw new Error(`operation ${m.toUpperCase()} ${p} not in spec`);
    const kept = {
      operationId: op.operationId,
      parameters: op.parameters ?? [],
      requestBody: op.requestBody,
      responses: { 200: op.responses['200'], default: op.responses.default },
    };
    paths[p][m] = strip(kept);
    refs(kept, todo);
  }
}
const schemas = {};
while (todo.size) {
  const [n] = todo;
  todo.delete(n);
  if (schemas[n]) continue;
  schemas[n] = strip(spec.components.schemas[n]);
  for (const r of refs(spec.components.schemas[n], new Set())) if (!schemas[r]) todo.add(r);
}
const out = {
  openapi: spec.openapi,
  info: { title: 'Stripe API (subset vendored by Sluice)', version: spec.info.version },
  'x-sluice': {
    source: 'https://github.com/stripe/openapi/blob/master/openapi/spec3.json',
    sourceSha256: createHash('sha256').update(raw).digest('hex'),
    operations: OPERATIONS,
  },
  paths,
  components: { schemas: Object.fromEntries(Object.entries(schemas).sort(([a], [b]) => a.localeCompare(b))) },
};
const dir = join(import.meta.dirname, '..', 'core', 'fakes', 'vendor', 'stripe');
writeFileSync(join(dir, 'openapi.json'), JSON.stringify(out));
writeFileSync(
  join(dir, 'fixtures.json'),
  JSON.stringify(
    {
      'x-sluice': {
        source: 'https://github.com/stripe/openapi/blob/master/openapi/fixtures3.json',
        apiVersion: spec.info.version,
      },
      resources: Object.fromEntries(FIXTURES.map((f) => [f, fixtures.resources[f]])),
    },
    null,
    1,
  ),
);
console.log(`vendored ${Object.keys(schemas).length} schemas for Stripe API ${spec.info.version}`);
