/**
 * Scripts are the replayable inputs of a session: HTTP calls against the
 * ingress, and clock moves. Values captured from responses (`save`) can be
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
export type Step = HttpStep | AdvanceStep | ClockStep;

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

export function stepName(step: Step, i: number): string {
  if (step.name) return step.name;
  if ('http' in step) return `${step.http.method.toUpperCase()} ${step.http.path}`;
  if ('advance' in step) return `advance ${step.advance}`;
  return `clock ${step.clock}`;
}

export function validateScript(raw: unknown, source = 'script'): Script {
  const s = raw as Script;
  if (!s || typeof s !== 'object' || typeof s.name !== 'string' || !Array.isArray(s.steps)) {
    throw new Error(`${source}: a script needs a name and a steps list`);
  }
  s.steps.forEach((st, i) => {
    const kinds = ['http', 'advance', 'clock'].filter((k) => k in (st as object));
    if (kinds.length !== 1) throw new Error(`${source}: step ${i + 1} must have exactly one of http/advance/clock`);
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
