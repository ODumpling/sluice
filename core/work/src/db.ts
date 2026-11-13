/**
 * Minimal async SQL adapter so the same queries run on SQLite (node:sqlite,
 * default, zero-dependency) and Postgres (pg). Queries use `?` placeholders;
 * the Postgres adapter rewrites them to `$n`.
 */
import { DatabaseSync } from 'node:sqlite';
import pg from 'pg';

export type Row = Record<string, unknown>;

export interface Db {
  readonly dialect: 'sqlite' | 'postgres';
  exec(sql: string): Promise<void>;
  all<T extends Row = Row>(sql: string, params?: unknown[]): Promise<T[]>;
  get<T extends Row = Row>(sql: string, params?: unknown[]): Promise<T | undefined>;
  run(sql: string, params?: unknown[]): Promise<{ changes: number }>;
  /** Serializable unit of work; `fn` gets a Db bound to the transaction. */
  tx<T>(fn: (db: Db) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export class SqliteDb implements Db {
  readonly dialect = 'sqlite' as const;
  private readonly d: DatabaseSync;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(file = ':memory:') {
    this.d = new DatabaseSync(file);
    this.d.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  }
  async exec(sql: string) {
    this.d.exec(sql);
  }
  async all<T extends Row>(sql: string, params: unknown[] = []) {
    return this.d.prepare(sql).all(...(params as never[])) as T[];
  }
  async get<T extends Row>(sql: string, params: unknown[] = []) {
    return this.d.prepare(sql).get(...(params as never[])) as T | undefined;
  }
  async run(sql: string, params: unknown[] = []) {
    const r = this.d.prepare(sql).run(...(params as never[]));
    return { changes: Number(r.changes) };
  }
  tx<T>(fn: (db: Db) => Promise<T>): Promise<T> {
    // node:sqlite is synchronous; serialize async transactions within this
    // process; BEGIN IMMEDIATE serializes against other processes on the file.
    const work = async () => {
      this.d.exec('BEGIN IMMEDIATE');
      try {
        const r = await fn(this);
        this.d.exec('COMMIT');
        return r;
      } catch (e) {
        this.d.exec('ROLLBACK');
        throw e;
      }
    };
    const p = this.chain.then(work, work);
    this.chain = p.catch(() => undefined);
    return p;
  }
  async close() {
    this.d.close();
  }
}

const toPg = (sql: string) => {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
};

class PgClientDb implements Db {
  readonly dialect = 'postgres' as const;
  constructor(private readonly c: pg.PoolClient) {}
  async exec(sql: string) {
    await this.c.query(sql);
  }
  async all<T extends Row>(sql: string, params: unknown[] = []) {
    return (await this.c.query(toPg(sql), params)).rows as T[];
  }
  async get<T extends Row>(sql: string, params: unknown[] = []) {
    return (await this.c.query(toPg(sql), params)).rows[0] as T | undefined;
  }
  async run(sql: string, params: unknown[] = []) {
    return { changes: (await this.c.query(toPg(sql), params)).rowCount ?? 0 };
  }
  tx<T>(fn: (db: Db) => Promise<T>): Promise<T> {
    return fn(this);
  }
  async close() {}
}

export class PostgresDb implements Db {
  readonly dialect = 'postgres' as const;
  private readonly pool: pg.Pool;
  constructor(url: string) {
    this.pool = new pg.Pool({ connectionString: url, max: 5, connectionTimeoutMillis: 10_000 });
  }
  async exec(sql: string) {
    await this.pool.query(sql);
  }
  async all<T extends Row>(sql: string, params: unknown[] = []) {
    return (await this.pool.query(toPg(sql), params)).rows as T[];
  }
  async get<T extends Row>(sql: string, params: unknown[] = []) {
    return (await this.pool.query(toPg(sql), params)).rows[0] as T | undefined;
  }
  async run(sql: string, params: unknown[] = []) {
    return { changes: (await this.pool.query(toPg(sql), params)).rowCount ?? 0 };
  }
  async tx<T>(fn: (db: Db) => Promise<T>): Promise<T> {
    // SERIALIZABLE + retry on serialization failure keeps claims atomic across workers.
    for (let attempt = 0; ; attempt++) {
      const c = await this.pool.connect();
      try {
        await c.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
        const r = await fn(new PgClientDb(c));
        await c.query('COMMIT');
        return r;
      } catch (e) {
        await c.query('ROLLBACK').catch(() => undefined);
        if ((e as { code?: string }).code === '40001' && attempt < 5) continue;
        throw e;
      } finally {
        c.release();
      }
    }
  }
  async close() {
    await this.pool.end();
  }
}

/** `sqlite:<file>`, a file path or `:memory:` → SQLite; `postgres://…` → Postgres. */
export function openDb(url: string): Db {
  if (url.startsWith('postgres://') || url.startsWith('postgresql://')) return new PostgresDb(url);
  return new SqliteDb(url.replace(/^sqlite:/, ''));
}
