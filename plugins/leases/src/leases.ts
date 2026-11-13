/**
 * Symbol-level leases. An agent working on a task leases the symbols its
 * change touches (`src/types.ts#Invoice`); a second agent touching a leased
 * symbol gets a conflict *before merge* instead of a semantic merge conflict
 * after. When a change alters an exported symbol's public shape, agents whose
 * leased code depends on it are notified (interface-change broadcast).
 */
import { randomBytes } from 'node:crypto';
import { changedLines, checkoutRef, git, type Checkout } from '@sluice-dev/sandbox';
import type { Db } from '@sluice-dev/work';
import { SymbolIndex, interfaceChanges, type InterfaceChange, type SymbolInfo } from './symbols.js';

export interface Lease {
  id: string;
  symbol: string;
  agent: string;
  task: string;
  acquiredAt: number;
  expiresAt: number;
}

export interface Conflict {
  symbol: string;
  heldBy: string;
  task: string;
  expiresAt: number;
}

export interface Notification {
  toAgent: string;
  task?: string;
  kind: 'interface_changed';
  message: string;
  data: Record<string, unknown>;
}

/** Where broadcasts go (the inbox plugin provides one). */
export interface Notifier {
  notify(n: Notification): Promise<void>;
}

const SCHEMA = `CREATE TABLE IF NOT EXISTS leases (
  id TEXT PRIMARY KEY, symbol TEXT NOT NULL, agent TEXT NOT NULL, task TEXT NOT NULL,
  acquired_at BIGINT NOT NULL, expires_at BIGINT NOT NULL, released INTEGER NOT NULL DEFAULT 0)`;

function toLease(r: Record<string, unknown>): Lease {
  return {
    id: String(r.id),
    symbol: String(r.symbol),
    agent: String(r.agent),
    task: String(r.task),
    acquiredAt: Number(r.acquired_at),
    expiresAt: Number(r.expires_at),
  };
}

export class LeaseManager {
  private constructor(
    private readonly db: Db,
    private readonly now: () => number,
  ) {}

  static async open(db: Db, opts: { now?: () => number } = {}): Promise<LeaseManager> {
    await db.exec(SCHEMA);
    return new LeaseManager(db, opts.now ?? Date.now);
  }

  async active(): Promise<Lease[]> {
    const rows = await this.db.all(
      'SELECT * FROM leases WHERE released = 0 AND expires_at > ? ORDER BY acquired_at, symbol',
      [this.now()],
    );
    return rows.map(toLease);
  }

  private conflictsIn(leases: Lease[], agent: string, task: string, symbols: string[]): Conflict[] {
    const want = new Set(symbols);
    return leases
      .filter((l) => want.has(l.symbol) && !(l.agent === agent && l.task === task))
      .map((l) => ({ symbol: l.symbol, heldBy: l.agent, task: l.task, expiresAt: l.expiresAt }));
  }

  async check(agent: string, task: string, symbols: string[]): Promise<Conflict[]> {
    return this.conflictsIn(await this.active(), agent, task, symbols);
  }

  /** All-or-nothing: either every symbol is leased (or renewed) or nothing changes and conflicts are returned. */
  async acquire(
    agent: string,
    task: string,
    symbols: string[],
    ttlSec = 3600,
  ): Promise<{ leases: Lease[]; conflicts: Conflict[] }> {
    return this.db.tx(async (db) => {
      const now = this.now();
      const active = (await db.all('SELECT * FROM leases WHERE released = 0 AND expires_at > ?', [now])).map(toLease);
      const conflicts = this.conflictsIn(active, agent, task, symbols);
      if (conflicts.length) return { leases: [], conflicts };
      const out: Lease[] = [];
      for (const symbol of [...new Set(symbols)].sort()) {
        const mine = active.find((l) => l.symbol === symbol && l.agent === agent && l.task === task);
        if (mine) {
          await db.run('UPDATE leases SET expires_at = ? WHERE id = ?', [now + ttlSec * 1000, mine.id]);
          out.push({ ...mine, expiresAt: now + ttlSec * 1000 });
        } else {
          const l: Lease = {
            id: `lease_${randomBytes(5).toString('hex')}`,
            symbol,
            agent,
            task,
            acquiredAt: now,
            expiresAt: now + ttlSec * 1000,
          };
          await db.run('INSERT INTO leases (id, symbol, agent, task, acquired_at, expires_at) VALUES (?,?,?,?,?,?)', [
            l.id,
            l.symbol,
            l.agent,
            l.task,
            l.acquiredAt,
            l.expiresAt,
          ]);
          out.push(l);
        }
      }
      return { leases: out, conflicts: [] };
    });
  }

  async release(agent: string, task: string): Promise<number> {
    return (
      await this.db.run('UPDATE leases SET released = 1 WHERE agent = ? AND task = ? AND released = 0', [agent, task])
    ).changes;
  }
}

export interface ChangeAnalysis {
  base: string;
  head: string;
  /** Symbols the change touches (changed lines, plus removed/added exports). */
  touched: SymbolInfo[];
  interfaceChanges: InterfaceChange[];
  /** For each changed interface: dependent symbols in head. */
  dependents: Record<string, string[]>;
}

/** Map a git change to the symbols it touches, using the language-service index of both sides. */
export async function analyzeChange(repo: string, base: string, head: string): Promise<ChangeAnalysis> {
  const cos: Checkout[] = [];
  try {
    const b = await checkoutRef(repo, base);
    cos.push(b);
    const h = await checkoutRef(repo, head);
    cos.push(h);
    const bi = SymbolIndex.build(b.dir);
    const hi = SymbolIndex.build(h.dir);
    const ranges = await changedLines(repo, b.sha, h.sha);
    const touched = new Map<string, SymbolInfo>();
    for (const [file, r] of Object.entries(ranges)) for (const s of hi.symbolsAt(file, r)) touched.set(s.id, s);
    const changes = interfaceChanges(bi, hi);
    for (const c of changes) {
      const s = hi.get(c.id) ?? bi.get(c.id);
      if (s) touched.set(c.id, s);
    }
    const dependents: Record<string, string[]> = {};
    for (const c of changes)
      dependents[c.id] = [...new Set([...hi.dependents(c.id), ...bi.dependents(c.id)].map((s) => s.id))].sort();
    return {
      base: b.sha,
      head: h.sha,
      touched: [...touched.values()].sort((x, y) => x.id.localeCompare(y.id)),
      interfaceChanges: changes,
      dependents,
    };
  } finally {
    for (const c of cos.reverse()) await c.remove();
  }
}

export interface SyncResult {
  analysis: ChangeAnalysis;
  leases: Lease[];
  conflicts: Conflict[];
  notified: Notification[];
}

/**
 * Lease everything a branch touches for (agent, task). On success, broadcast
 * interface changes to other agents holding leases on dependent symbols.
 */
export async function syncLeases(
  mgr: LeaseManager,
  o: { repo: string; base: string; head: string; agent: string; task: string; ttlSec?: number; notifier?: Notifier },
): Promise<SyncResult> {
  const analysis = await analyzeChange(o.repo, o.base, o.head);
  const { leases, conflicts } = await mgr.acquire(
    o.agent,
    o.task,
    analysis.touched.map((s) => s.id),
    o.ttlSec,
  );
  const notified: Notification[] = [];
  if (!conflicts.length && analysis.interfaceChanges.length) {
    const active = await mgr.active();
    const subject = (await git(['log', '-1', '--format=%s', analysis.head], o.repo)).trim();
    for (const change of analysis.interfaceChanges) {
      const deps = new Set(analysis.dependents[change.id] ?? []);
      const holders = new Map<string, Lease>();
      for (const l of active) if (deps.has(l.symbol) && l.agent !== o.agent) holders.set(`${l.agent}|${l.task}`, l);
      for (const l of holders.values()) {
        const n: Notification = {
          toAgent: l.agent,
          task: l.task,
          kind: 'interface_changed',
          message: `${change.id} ${change.kind} by ${o.agent} (${o.task}: ${subject}); your ${l.symbol} depends on it`,
          data: {
            symbol: change.id,
            change: change.kind,
            before: change.before,
            after: change.after,
            by: o.agent,
            byTask: o.task,
            dependent: l.symbol,
            head: analysis.head,
          },
        };
        await o.notifier?.notify(n);
        notified.push(n);
      }
    }
  }
  return { analysis, leases, conflicts, notified };
}
