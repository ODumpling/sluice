/**
 * Acceptance scenarios: black-box checks written against the app's public
 * surface (HTTP ingress, fake third parties, the database), approved by a
 * human before any code is judged by them.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { validateScript, type Script, type Step } from '@sluice-dev/evidence';
import type { Json } from '@sluice-dev/fakes';

export interface HttpExpect {
  status?: number;
  body?: Json;
}

export type Assertion =
  | { fake: string; path?: string; matches: Json }
  | { sql: string; params?: Json[]; rows: Json }
  | { egress: { none?: Json; some?: Json; count?: { match: Json; equals: number } } }
  | { events: { none?: Json; some?: Json } };

export type ScenarioStep = (Step & { expect?: HttpExpect }) | { name?: string; assert: Assertion };

export interface Scenario {
  id: string;
  title: string;
  /** Free text: the behaviour this scenario pins down. */
  rationale?: string;
  steps: ScenarioStep[];
}

const ID_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;

export function validateScenario(raw: unknown, source = 'scenario'): Scenario {
  const s = raw as Scenario;
  if (!s || typeof s !== 'object') throw new Error(`${source}: not an object`);
  if (typeof s.id !== 'string' || !ID_RE.test(s.id)) throw new Error(`${source}: id must match ${ID_RE}`);
  if (typeof s.title !== 'string' || !s.title.trim()) throw new Error(`${source}: title required`);
  if (!Array.isArray(s.steps) || s.steps.length === 0) throw new Error(`${source}: steps required`);
  let checks = 0;
  for (const [i, st] of s.steps.entries()) {
    if ('assert' in st) {
      const a = st.assert as Record<string, unknown>;
      const kinds = ['fake', 'sql', 'egress', 'events'].filter((k) => k in a);
      if (kinds.length !== 1)
        throw new Error(`${source}: step ${i + 1} assert needs exactly one of fake/sql/egress/events`);
      if ('fake' in a && !('matches' in a)) throw new Error(`${source}: step ${i + 1} fake assertion needs matches`);
      if ('sql' in a && !('rows' in a)) throw new Error(`${source}: step ${i + 1} sql assertion needs rows`);
      checks++;
    } else if ('expect' in st && st.expect) {
      if (!('http' in st)) throw new Error(`${source}: step ${i + 1} expect is only valid on http steps`);
      checks++;
    }
  }
  if (checks === 0) throw new Error(`${source}: a scenario must check something (expect or assert)`);
  validateScript(toScript(s), source);
  return s;
}

export function parseScenarios(text: string, source = 'scenarios'): Scenario[] {
  const docs = text
    .split(/^---\s*$/m)
    .map((d) => d.trim())
    .filter(Boolean)
    .map((d) => parseYaml(d) as unknown);
  const flat = docs.flatMap((d) => (Array.isArray(d) ? d : [d]));
  return flat.map((d, i) => validateScenario(d, `${source}#${i + 1}`));
}

export function loadScenarioFile(file: string): Scenario {
  return validateScenario(parseYaml(readFileSync(file, 'utf8')), file);
}

/** Script for evidence collection: assertion steps become no-op check markers. */
export function toScript(s: Scenario): Script {
  return {
    name: s.id,
    steps: s.steps.map((st, i): Step => {
      if ('assert' in st) return { name: st.name ?? `assert #${i + 1}`, check: s.id };
      const { expect: _expect, ...rest } = st as Step & { expect?: HttpExpect };
      return rest;
    }),
  };
}

function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v)
      .sort()
      .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v);
}

/** Content hash an approval is bound to. Formatting/comments do not matter; any semantic edit does. */
export function scenarioHash(s: Scenario): string {
  return createHash('sha256').update(canonical(s)).digest('hex');
}
