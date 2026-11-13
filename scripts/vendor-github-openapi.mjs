#!/usr/bin/env node
// Regenerates core/fakes/vendor/github/* from GitHub's published REST OpenAPI
// description (https://github.com/github/rest-api-description). Run manually:
//   curl -sLO https://raw.githubusercontent.com/github/rest-api-description/main/descriptions/api.github.com/api.github.com.json
//   node scripts/vendor-github-openapi.mjs api.github.com.json
// Keeps only the operations the GitHub fake implements and what they reference.
// The spec's response examples are kept as recorded traffic for drift checks.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const [specPath] = process.argv.slice(2);
if (!specPath) {
  console.error('usage: vendor-github-openapi.mjs <api.github.com.json>');
  process.exit(2);
}
const OPERATIONS = {
  '/repos/{owner}/{repo}': ['get'],
  '/repos/{owner}/{repo}/installation': ['get'],
  '/app/installations/{installation_id}/access_tokens': ['post'],
  '/repos/{owner}/{repo}/check-runs': ['post'],
  '/repos/{owner}/{repo}/check-runs/{check_run_id}': ['get', 'patch'],
  '/repos/{owner}/{repo}/commits/{ref}/check-runs': ['get'],
  '/repos/{owner}/{repo}/pulls': ['get', 'post'],
  '/repos/{owner}/{repo}/pulls/{pull_number}': ['get'],
  '/repos/{owner}/{repo}/pulls/{pull_number}/merge': ['put'],
  '/repos/{owner}/{repo}/pulls/{pull_number}/files': ['get'],
  '/repos/{owner}/{repo}/issues/{issue_number}/comments': ['get', 'post'],
  '/repos/{owner}/{repo}/contents/{path}': ['get', 'put'],
  '/repos/{owner}/{repo}/branches/{branch}': ['get'],
};
const raw = readFileSync(specPath);
const spec = JSON.parse(raw);

function strip(o) {
  if (Array.isArray(o)) return o.map(strip);
  if (o && typeof o === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(o)) {
      if ((k === 'description' || k === 'summary') && typeof v === 'string') continue;
      if (k === 'externalDocs' || k === 'x-github') continue;
      out[k] = strip(v);
    }
    return out;
  }
  return o;
}
function refs(o, acc) {
  if (Array.isArray(o)) o.forEach((v) => refs(v, acc));
  else if (o && typeof o === 'object') {
    for (const [k, v] of Object.entries(o)) {
      if (k === '$ref' && typeof v === 'string') acc.add(v);
      else refs(v, acc);
    }
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
    const kept = strip({
      operationId: op.operationId,
      parameters: op.parameters ?? [],
      requestBody: op.requestBody,
      responses: op.responses,
    });
    paths[p][m] = kept;
    refs(kept, todo);
  }
}
const components = {};
const seen = new Set();
while (todo.size) {
  const [r] = todo;
  todo.delete(r);
  if (seen.has(r)) continue;
  seen.add(r);
  const [, , section, name] = r.split('/');
  const value = spec.components[section]?.[name];
  if (value === undefined) throw new Error(`dangling ref ${r}`);
  (components[section] ??= {})[name] = strip(value);
  for (const x of refs(value, new Set())) if (!seen.has(x)) todo.add(x);
}
for (const section of Object.keys(components)) {
  components[section] = Object.fromEntries(Object.entries(components[section]).sort(([a], [b]) => a.localeCompare(b)));
}
const out = {
  openapi: spec.openapi,
  info: { title: 'GitHub REST API (subset vendored by Sluice)', version: spec.info.version },
  'x-sluice': {
    source: 'https://github.com/github/rest-api-description/blob/main/descriptions/api.github.com/api.github.com.json',
    sourceSha256: createHash('sha256').update(raw).digest('hex'),
    operations: OPERATIONS,
  },
  paths,
  components,
};
const dir = join(import.meta.dirname, '..', 'core', 'fakes', 'vendor', 'github');
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, 'openapi.json'), JSON.stringify(out));
console.log(
  `vendored GitHub API ${spec.info.version}: ${Object.entries(components)
    .map(([k, v]) => `${Object.keys(v).length} ${k}`)
    .join(', ')}`,
);
