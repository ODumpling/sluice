/**
 * Behavior diff between two sessions of the same script.
 *
 * Pipeline: normalize (project to the observable channels) -> canonicalize
 * generated ids (by first appearance, so a shifted id sequence is not noise) ->
 * drop ignored paths (noise filters) -> diff. Record lists (egress calls, DB
 * writes, events, table rows) are aligned with LCS so one extra write shows up
 * as one addition, not a cascade of changes.
 */
import type { Json } from '@sluice-dev/fakes';
import type { Session } from './session.js';

export type Channel = 'response' | 'egress' | 'db' | 'events' | 'final';

export interface DiffEntry {
  /** Step index, or -1 for final state. */
  step: number;
  stepName: string;
  channel: Channel;
  /** Path within the channel, e.g. "body.plan" or "[1].new.status". */
  path: string;
  kind: 'added' | 'removed' | 'changed';
  before?: Json;
  after?: Json;
}

export interface DiffResult {
  equal: boolean;
  entries: DiffEntry[];
}

export interface DiffOptions {
  /**
   * Noise filters: dot paths with `*` (one segment) and `**` (any depth),
   * rooted at a channel, e.g. "db.*.new.updated_at", "response.body.created",
   * "egress.*.response.created", "final.db.*.*.updated_at".
   */
  ignore?: string[];
  /** Canonicalize generated ids matching these regexes (default: Stripe-style ids). */
  idPatterns?: RegExp[];
  /** Compare final fake/DB state (default true). */
  final?: boolean;
}

export const DEFAULT_ID_PATTERNS = [/\b([a-z]{2,6})_[A-Za-z0-9]{14,}\b/g];

type Tree = Json;

function canonicalizeIds(tree: Tree, patterns: RegExp[]): Tree {
  const map = new Map<string, string>();
  const counters = new Map<string, number>();
  const rewrite = (s: string) => {
    let out = s;
    for (const re of patterns) {
      out = out.replace(
        new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g'),
        (id: string, prefix?: string) => {
          let c = map.get(id);
          if (!c) {
            const p = prefix ?? 'id';
            const n = (counters.get(p) ?? 0) + 1;
            counters.set(p, n);
            c = `${p}_#${n}`;
            map.set(id, c);
          }
          return c;
        },
      );
    }
    return out;
  };
  const walk = (v: Tree): Tree => {
    if (typeof v === 'string') return rewrite(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const o: Record<string, Json> = {};
      for (const k of Object.keys(v)) o[rewrite(k)] = walk(v[k]!);
      return o;
    }
    return v;
  };
  return walk(tree);
}

export function compileGlob(pattern: string): RegExp {
  const segs = pattern.split('.');
  let re = '^';
  segs.forEach((seg, i) => {
    const last = i === segs.length - 1;
    if (seg === '**') {
      re += last ? '.*' : '(?:[^.]+\\.)*';
      return;
    }
    re += seg.replace(/[$()+?^{}|[\]\\]/g, '\\$&').replace(/\*/g, '[^.]*') + (last ? '' : '\\.');
  });
  return new RegExp(re + '$');
}

function stripIgnored(v: Tree, path: string, globs: RegExp[]): Tree | undefined {
  if (path && globs.some((g) => g.test(path))) return undefined;
  if (Array.isArray(v)) {
    return v
      .map((x, i) => stripIgnored(x, path ? `${path}.${i}` : String(i), globs))
      .filter((x) => x !== undefined) as Json;
  }
  if (v && typeof v === 'object') {
    const o: Record<string, Json> = {};
    for (const k of Object.keys(v).sort()) {
      const r = stripIgnored(v[k]!, path ? `${path}.${k}` : k, globs);
      if (r !== undefined) o[k] = r;
    }
    return o;
  }
  return v;
}

interface NormalStep {
  name: string;
  response: Json;
  egress: Json[];
  db: Json[];
  events: Json[];
}

interface Normal {
  steps: NormalStep[];
  final: Json;
}

export function normalizeSession(s: Session, opts: DiffOptions = {}): Normal {
  const raw: Json = {
    steps: s.steps.map((st) => ({
      name: st.name,
      response: (st.response ?? null) as Json,
      egress: st.egress as unknown as Json[],
      db: st.db as unknown as Json[],
      events: st.events,
    })),
    final: opts.final === false ? null : (s.final as unknown as Json),
  };
  const canon = canonicalizeIds(raw, opts.idPatterns ?? DEFAULT_ID_PATTERNS) as unknown as Normal;
  const globs = (opts.ignore ?? []).map(compileGlob);
  return {
    steps: canon.steps.map((st) => ({
      name: st.name,
      response: stripIgnored(st.response, 'response', globs) as Json,
      egress: stripIgnored(st.egress, 'egress', globs) as Json[],
      db: stripIgnored(st.db, 'db', globs) as Json[],
      events: stripIgnored(st.events, 'events', globs) as Json[],
    })),
    final: stripIgnored(canon.final, 'final', globs) ?? null,
  };
}

function stable(v: Json): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable(v[k]!)}`)
      .join(',')}}`;
  }
  return JSON.stringify(v);
}

function lcs(a: string[], b: string[]): [number, number][] {
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const pairs: [number, number][] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      pairs.push([i, j]);
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) i++;
    else j++;
  }
  return pairs;
}

type Emit = (path: string, kind: DiffEntry['kind'], before?: Json, after?: Json) => void;

function identity(v: Json): string {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const o = v as Record<string, Json>;
    if ('table' in o && 'op' in o) {
      const row = (o.new ?? o.old) as Record<string, Json> | null;
      return `db:${String(o.table)}:${String(o.op)}:${stable(row?.id ?? null)}`;
    }
    if ('fake' in o && 'method' in o) return `egress:${String(o.fake)}:${String(o.method)}:${String(o.path)}`;
    if ('event' in o) return `event:${String(o.event)}`;
    if ('id' in o) return `id:${stable(o.id!)}`;
  }
  return `v:${typeof v}`;
}

function diffValue(a: Json | undefined, b: Json | undefined, path: string, emit: Emit, listMode: boolean): void {
  if (a === undefined && b === undefined) return;
  if (a === undefined) return emit(path, 'added', undefined, b);
  if (b === undefined) return emit(path, 'removed', a, undefined);
  if (Array.isArray(a) && Array.isArray(b)) {
    if (listMode) return diffList(a, b, path, emit);
    const n = Math.max(a.length, b.length);
    for (let i = 0; i < n; i++) diffValue(a[i], b[i], `${path}[${i}]`, emit, false);
    return;
  }
  if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
    for (const k of keys) diffValue(a[k], b[k], path ? `${path}.${k}` : k, emit, false);
    return;
  }
  if (stable(a) !== stable(b)) emit(path, 'changed', a, b);
}

/** LCS-aligned diff of record lists; unmatched neighbours with the same identity are diffed field-by-field. */
function diffList(a: Json[], b: Json[], path: string, emit: Emit): void {
  const sa = a.map(stable);
  const sb = b.map(stable);
  const pairs = lcs(sa, sb);
  let i = 0;
  let j = 0;
  const flush = (ai: number, bj: number) => {
    const removed: number[] = [];
    const added: number[] = [];
    for (; i < ai; i++) removed.push(i);
    for (; j < bj; j++) added.push(j);
    const usedAdded = new Set<number>();
    for (const r of removed) {
      const match = added.find((x) => !usedAdded.has(x) && identity(b[x]!) === identity(a[r]!));
      if (match !== undefined) {
        usedAdded.add(match);
        diffValue(a[r], b[match], `${path}[${match}]`, emit, false);
      } else emit(`${path}[${r}]`, 'removed', a[r], undefined);
    }
    for (const x of added) if (!usedAdded.has(x)) emit(`${path}[${x}]`, 'added', undefined, b[x]);
  };
  for (const [pi, pj] of pairs) {
    flush(pi, pj);
    i = pi + 1;
    j = pj + 1;
  }
  flush(a.length, b.length);
}

export function diffSessions(a: Session, b: Session, opts: DiffOptions = {}): DiffResult {
  const na = normalizeSession(a, opts);
  const nb = normalizeSession(b, opts);
  const entries: DiffEntry[] = [];
  const steps = Math.max(na.steps.length, nb.steps.length);
  for (let i = 0; i < steps; i++) {
    const sa = na.steps[i];
    const sb = nb.steps[i];
    const stepName = sa?.name ?? sb?.name ?? `step ${i}`;
    const emitter =
      (channel: Channel): Emit =>
      (path, kind, before, after) =>
        entries.push({ step: i, stepName, channel, path, kind, before, after });
    if (!sa || !sb) {
      entries.push({
        step: i,
        stepName,
        channel: 'response',
        path: '',
        kind: sa ? 'removed' : 'added',
        before: sa?.response,
        after: sb?.response,
      });
      continue;
    }
    diffValue(sa.response, sb.response, '', emitter('response'), false);
    diffValue(sa.egress, sb.egress, '', emitter('egress'), true);
    diffValue(sa.db, sb.db, '', emitter('db'), true);
    diffValue(sa.events, sb.events, '', emitter('events'), true);
  }
  if (opts.final !== false) {
    const emit: Emit = (path, kind, before, after) =>
      entries.push({ step: -1, stepName: 'final state', channel: 'final', path, kind, before, after });
    const fa = (na.final ?? {}) as Record<string, Json>;
    const fb = (nb.final ?? {}) as Record<string, Json>;
    // final.db.<table> and final.fakes.<fake>.<collection> are record lists
    for (const section of ['db', 'fakes'] as const) {
      const a2 = (fa[section] ?? {}) as Record<string, Json>;
      const b2 = (fb[section] ?? {}) as Record<string, Json>;
      for (const k of [...new Set([...Object.keys(a2), ...Object.keys(b2)])].sort()) {
        const av = a2[k];
        const bv = b2[k];
        if (
          section === 'fakes' &&
          av &&
          bv &&
          typeof av === 'object' &&
          !Array.isArray(av) &&
          typeof bv === 'object' &&
          !Array.isArray(bv)
        ) {
          for (const c of [...new Set([...Object.keys(av), ...Object.keys(bv)])].sort()) {
            diffValue(av[c], (bv as Record<string, Json>)[c], `${section}.${k}.${c}`, emit, true);
          }
        } else diffValue(av, bv, `${section}.${k}`, emit, true);
      }
    }
  }
  return { equal: entries.length === 0, entries };
}

function short(v: Json | undefined): string {
  const s = JSON.stringify(v);
  return s === undefined ? 'undefined' : s.length > 160 ? s.slice(0, 157) + '...' : s;
}

export function formatDiff(d: DiffResult): string {
  if (d.equal) return 'no behavior differences\n';
  const lines: string[] = [];
  let last = '';
  for (const e of d.entries) {
    const head = e.step >= 0 ? `step ${e.step + 1}: ${e.stepName}` : 'final state';
    if (head !== last) {
      lines.push(head);
      last = head;
    }
    const loc = `${e.channel}${e.path.startsWith('[') || !e.path ? '' : '.'}${e.path}`;
    if (e.kind === 'changed') lines.push(`  ~ ${loc}: ${short(e.before)} -> ${short(e.after)}`);
    else if (e.kind === 'added') lines.push(`  + ${loc}: ${short(e.after)}`);
    else lines.push(`  - ${loc}: ${short(e.before)}`);
  }
  return lines.join('\n') + '\n';
}
