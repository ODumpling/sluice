/**
 * Expectation matching for scenarios. Objects match partially (listed keys
 * only); arrays match element-wise with equal length; operators:
 *   $exists, $ne, $in, $regex, $gt/$gte/$lt/$lte (numbers or ISO dates),
 *   $contains (array has an element matching), $len (array/string length), $any.
 */
import type { Json } from '@sluice-dev/fakes';

export interface Mismatch {
  path: string;
  expected: Json;
  actual: Json | undefined;
  message: string;
}

const OPS = new Set(['$exists', '$ne', '$in', '$regex', '$gt', '$gte', '$lt', '$lte', '$contains', '$len', '$any']);

function isOperator(v: Json): v is Record<string, Json> {
  return (
    !!v &&
    typeof v === 'object' &&
    !Array.isArray(v) &&
    Object.keys(v).length > 0 &&
    Object.keys(v).every((k) => OPS.has(k))
  );
}

function cmpValue(v: Json | undefined): number | undefined {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)) {
    const t = Date.parse(v);
    return Number.isNaN(t) ? undefined : t;
  }
  return undefined;
}

function sameScalar(a: Json | undefined, b: Json | undefined): boolean {
  if (a === b) return true;
  // equal instants in different ISO spellings (e.g. "…Z" vs "…+00:00") match
  const ta = typeof a === 'string' ? cmpValue(a) : undefined;
  const tb = typeof b === 'string' ? cmpValue(b) : undefined;
  return ta !== undefined && ta === tb;
}

function show(v: Json | undefined): string {
  return v === undefined ? 'undefined' : JSON.stringify(v);
}

export function match(expected: Json, actual: Json | undefined, path = '$'): Mismatch[] {
  const out: Mismatch[] = [];
  const fail = (message: string) => out.push({ path, expected, actual, message });
  if (isOperator(expected)) {
    for (const [op, arg] of Object.entries(expected)) {
      switch (op) {
        case '$any':
          break;
        case '$exists':
          if ((actual !== undefined && actual !== null) !== arg)
            fail(`${path} should ${arg ? '' : 'not '}exist, got ${show(actual)}`);
          break;
        case '$ne':
          if (match(arg, actual, path).length === 0) fail(`${path} should not equal ${show(arg)}`);
          break;
        case '$in':
          if (!Array.isArray(arg) || !arg.some((x) => match(x, actual, path).length === 0))
            fail(`${path} should be one of ${show(arg)}, got ${show(actual)}`);
          break;
        case '$regex':
          if (typeof actual !== 'string' || !new RegExp(String(arg)).test(actual))
            fail(`${path} should match /${String(arg)}/, got ${show(actual)}`);
          break;
        case '$gt':
        case '$gte':
        case '$lt':
        case '$lte': {
          const a = cmpValue(actual);
          const b = cmpValue(arg);
          const ok =
            a !== undefined &&
            b !== undefined &&
            (op === '$gt' ? a > b : op === '$gte' ? a >= b : op === '$lt' ? a < b : a <= b);
          if (!ok) fail(`${path} should be ${op.slice(1)} ${show(arg)}, got ${show(actual)}`);
          break;
        }
        case '$contains':
          if (!Array.isArray(actual) || !actual.some((x) => match(arg, x, path).length === 0)) {
            fail(`${path} should contain an element matching ${show(arg)}`);
          }
          break;
        case '$len': {
          const len = Array.isArray(actual) || typeof actual === 'string' ? actual.length : undefined;
          if (len !== arg)
            fail(`${path} should have length ${show(arg)}, got ${len === undefined ? show(actual) : len}`);
          break;
        }
      }
    }
    return out;
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual))
      return [{ path, expected, actual, message: `${path} should be an array, got ${show(actual)}` }];
    if (actual.length !== expected.length) {
      out.push({
        path,
        expected,
        actual,
        message: `${path} should have ${expected.length} item(s), got ${actual.length}`,
      });
    }
    expected.forEach((e, i) => out.push(...match(e, actual[i], `${path}[${i}]`)));
    return out;
  }
  if (expected && typeof expected === 'object') {
    if (!actual || typeof actual !== 'object' || Array.isArray(actual)) {
      return [{ path, expected, actual, message: `${path} should be an object, got ${show(actual)}` }];
    }
    for (const [k, e] of Object.entries(expected as Record<string, Json>))
      out.push(...match(e, (actual as Record<string, Json>)[k], `${path}.${k}`));
    return out;
  }
  if (!sameScalar(expected, actual)) fail(`${path} expected ${show(expected)}, got ${show(actual)}`);
  return out;
}
