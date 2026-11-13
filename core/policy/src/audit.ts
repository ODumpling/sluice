/**
 * Append-only, tamper-evident audit log. Each JSONL entry carries the hash of
 * the previous entry; `verifyAuditLog` recomputes the chain so any edit,
 * deletion or reordering is detected.
 */
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface AuditEntry {
  seq: number;
  at: string;
  type: string;
  [k: string]: unknown;
  prev: string;
  hash: string;
}

const GENESIS = '0'.repeat(64);

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

function hashEntry(e: Omit<AuditEntry, 'hash'>): string {
  return createHash('sha256').update(canonical(e)).digest('hex');
}

export class AuditLog {
  private last = GENESIS;
  private seq = 0;
  private readonly memory: AuditEntry[] = [];

  /** `file` undefined = in-memory only. */
  constructor(
    readonly file?: string,
    private readonly now: () => number = Date.now,
  ) {
    if (file && existsSync(file)) {
      const entries = readAuditLog(file);
      const v = verifyEntries(entries);
      if (!v.ok) throw new Error(`audit log ${file} is corrupt at entry ${v.brokenAt}: ${v.reason}`);
      const tail = entries[entries.length - 1];
      if (tail) {
        this.last = tail.hash;
        this.seq = tail.seq;
      }
    }
    if (file) mkdirSync(dirname(file), { recursive: true });
  }

  append(type: string, data: Record<string, unknown> = {}): AuditEntry {
    const base = { ...data, seq: ++this.seq, at: new Date(this.now()).toISOString(), type, prev: this.last };
    const entry = { ...base, hash: hashEntry(base) } as AuditEntry;
    this.last = entry.hash;
    if (this.file) appendFileSync(this.file, JSON.stringify(entry) + '\n');
    else this.memory.push(entry);
    return entry;
  }

  entries(): AuditEntry[] {
    return this.file ? readAuditLog(this.file) : [...this.memory];
  }
}

export function readAuditLog(file: string): AuditEntry[] {
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as AuditEntry);
}

export function verifyEntries(entries: AuditEntry[]): { ok: true } | { ok: false; brokenAt: number; reason: string } {
  let prev = GENESIS;
  for (const [i, e] of entries.entries()) {
    if (e.prev !== prev)
      return { ok: false, brokenAt: i + 1, reason: 'previous-hash mismatch (entry removed or reordered)' };
    const { hash, ...rest } = e;
    if (hashEntry(rest) !== hash) return { ok: false, brokenAt: i + 1, reason: 'content hash mismatch (entry edited)' };
    if (e.seq !== i + 1) return { ok: false, brokenAt: i + 1, reason: 'sequence gap' };
    prev = hash;
  }
  return { ok: true };
}

export function verifyAuditLog(file: string) {
  return verifyEntries(readAuditLog(file));
}
