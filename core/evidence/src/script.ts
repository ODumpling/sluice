/**
 * Scripts are the replayable inputs of a session: HTTP calls against the
 * ingress, browser actions on the app's frontend, and clock moves. Values captured from responses (`save`) can be
 * referenced later as ${name}.
 */
import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import type { Json } from '@sluice-dev/fakes';

export interface HttpStep {
  name?: string;
  http: { method: string; path: string; body?: Json; headers?: Record<string, string> };
  /** var name -> dot path into the response ({status, body}). */
  save?: Record<string, string>;
}
export interface AdvanceStep {
  name?: string;
  /** Duration: number of ms or "35d" / "12h" / "30m" / "10s". */
  advance: string | number;
}
export interface ClockStep {
  name?: string;
  /** Absolute ISO instant to move to. */
  clock: string;
}
/** A no-op marker step; hosts (e.g. the gate) evaluate assertions here via RunOptions.afterStep. */
export interface CheckStep {
  name?: string;
  check: string;
}
/** One Playwright action; selectors are Playwright selectors (CSS, `text=…`, `role=button[name="…"]`, …). */
export type BrowserAction =
  | { goto: string }
  | { click: string }
  | { fill: string; value: string }
  | { press: string; key: string }
  | { select: string; value: string }
  | { check: string }
  | { uncheck: string }
  | { waitFor: string };
export const BROWSER_ACTIONS = ['goto', 'click', 'fill', 'press', 'select', 'check', 'uncheck', 'waitFor'] as const;
/** Drive the sandbox browser (needs `sandbox.browser` in sluice.yaml). */
export interface BrowserStep {
  name?: string;
  browser: BrowserAction;
  /** var name -> selector: saves the element's trimmed text. */
  save?: Record<string, string>;
}
export type Step = HttpStep | BrowserStep | AdvanceStep | ClockStep | CheckStep;
export const STEP_KINDS = ['http', 'browser', 'advance', 'clock', 'check'] as const;

export interface Script {
  name: string;
  steps: Step[];
}

const UNITS: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };

export function parseDuration(v: string | number): number {
  if (typeof v === 'number') return v;
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d|w)$/.exec(v.trim());
  if (!m) throw new Error(`invalid duration ${JSON.stringify(v)} (use e.g. 35d, 12h, 90s)`);
  return Math.round(Number(m[1]) * UNITS[m[2]!]!);
}

export function stepName(step: Step): string {
  if (step.name) return step.name;
  if ('http' in step) return `${step.http.method.toUpperCase()} ${step.http.path}`;
  if ('browser' in step) {
    const a = step.browser as Record<string, string>;
    const verb = BROWSER_ACTIONS.find((k) => k in a)!;
    return `browser ${verb} ${a[verb]}`;
  }
  if ('advance' in step) return `advance ${step.advance}`;
  if ('check' in step) return `check ${step.check}`;
  return `clock ${step.clock}`;
}

export function validateScript(raw: unknown, source = 'script'): Script {
  const s = raw as Script;
  if (!s || typeof s !== 'object' || typeof s.name !== 'string' || !Array.isArray(s.steps)) {
    throw new Error(`${source}: a script needs a name and a steps list`);
  }
  s.steps.forEach((st, i) => {
    const kinds = STEP_KINDS.filter((k) => k in (st as object));
    if (kinds.length !== 1)
      throw new Error(`${source}: step ${i + 1} must have exactly one of ${STEP_KINDS.join('/')}`);
    if ('browser' in st) validateBrowserAction(st.browser, `${source}: step ${i + 1}`);
    if ('http' in st) {
      if (typeof st.http.method !== 'string' || typeof st.http.path !== 'string' || !st.http.path.startsWith('/')) {
        throw new Error(`${source}: step ${i + 1} http needs method and an absolute path`);
      }
    }
    if ('advance' in st) parseDuration(st.advance);
    if ('clock' in st && Number.isNaN(Date.parse(st.clock)))
      throw new Error(`${source}: step ${i + 1} has invalid clock`);
  });
  return s;
}

function validateBrowserAction(a: unknown, where: string): void {
  if (!a || typeof a !== 'object') throw new Error(`${where}: browser needs an action (${BROWSER_ACTIONS.join('/')})`);
  const o = a as Record<string, unknown>;
  const verbs = BROWSER_ACTIONS.filter((k) => k in o);
  if (verbs.length !== 1)
    throw new Error(
      `${where}: browser needs exactly one of ${BROWSER_ACTIONS.join('/')}, got ${JSON.stringify(Object.keys(o))}`,
    );
  const verb = verbs[0]!;
  if (typeof o[verb] !== 'string' || !o[verb]) throw new Error(`${where}: browser ${verb} needs a string`);
  const extra: Record<string, string[]> = { fill: ['value'], select: ['value'], press: ['key'] };
  for (const k of extra[verb] ?? [])
    if (o[k] === undefined || o[k] === null) throw new Error(`${where}: browser ${verb} needs ${k}`);
  const allowed = new Set([verb, ...(extra[verb] ?? [])]);
  for (const k of Object.keys(o)) if (!allowed.has(k)) throw new Error(`${where}: browser ${verb}: unknown key ${k}`);
}

export function loadScript(file: string): Script {
  return validateScript(parseYaml(readFileSync(file, 'utf8')), file);
}

export function getPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const seg of path.split('.').filter(Boolean)) {
    if (cur === null || cur === undefined) return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

/** Replace ${var} in strings (whole-string references keep the value's type). */
export function interpolate(v: Json | undefined, vars: Record<string, Json>): Json | undefined {
  if (typeof v === 'string') {
    const whole = /^\$\{([a-zA-Z_][\w]*)\}$/.exec(v);
    if (whole) {
      if (!(whole[1]! in vars)) throw new Error(`undefined variable \${${whole[1]}}`);
      return vars[whole[1]!]!;
    }
    return v.replace(/\$\{([a-zA-Z_][\w]*)\}/g, (_m, k: string) => {
      if (!(k in vars)) throw new Error(`undefined variable \${${k}}`);
      return String(vars[k]);
    });
  }
  if (Array.isArray(v)) return v.map((x) => interpolate(x, vars)!) as Json;
  if (v && typeof v === 'object')
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, interpolate(x, vars)!]));
  return v;
}
