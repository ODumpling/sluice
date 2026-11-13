/**
 * Task/dependency state machine for multi-agent work.
 *
 *   pending ──deps done──▶ ready ──claim──▶ claimed ──start──▶ in_progress ──submit──▶ review ──approve──▶ done
 *                            ▲               │release           │  ▲ block/unblock        │request changes
 *                            └───────────────┘                  ▼  │                       ▼
 *                                                             blocked                  in_progress
 *   any non-terminal ──cancel──▶ canceled          in_progress ──fail──▶ failed
 *
 * Every transition is validated, done in a transaction, and recorded in
 * task_events. Dependents are promoted to `ready` when their last dependency
 * reaches `done`. Tasks block on decision ids (see the inbox plugin); resolving
 * a decision attaches the answer and resumes every task waiting on it.
 */
import { randomBytes } from 'node:crypto';
import type { Db } from './db.js';

export type TaskStatus =
  'pending' | 'ready' | 'claimed' | 'in_progress' | 'blocked' | 'review' | 'done' | 'failed' | 'canceled';

export interface Task {
  id: string;
  title: string;
  status: TaskStatus;
  priority: number;
  deps: string[];
  assignee: string | null;
  blockedOn: string[];
  /** Status to return to when unblocked. */
  resumeStatus: TaskStatus | null;
  data: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

export interface TaskEvent {
  seq: number;
  task: string;
  from: TaskStatus | null;
  to: TaskStatus;
  actor: string;
  at: number;
  note: string | null;
}

export class TransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TransitionError';
  }
}

const TERMINAL: TaskStatus[] = ['done', 'failed', 'canceled'];

const SCHEMA = `
CREATE TABLE IF NOT EXISTS work_tasks (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, status TEXT NOT NULL, priority INTEGER NOT NULL DEFAULT 0,
  deps TEXT NOT NULL, assignee TEXT, blocked_on TEXT NOT NULL, resume_status TEXT, data TEXT NOT NULL,
  created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL, seq BIGINT NOT NULL);
CREATE TABLE IF NOT EXISTS work_events (
  seq BIGINT NOT NULL, task TEXT NOT NULL, from_status TEXT, to_status TEXT NOT NULL,
  actor TEXT NOT NULL, at BIGINT NOT NULL, note TEXT);
CREATE INDEX IF NOT EXISTS work_tasks_status ON work_tasks (status, priority, seq);
CREATE TABLE IF NOT EXISTS work_counter (name TEXT PRIMARY KEY, value BIGINT NOT NULL);
`;

type TaskRow = {
  id: string;
  title: string;
  status: TaskStatus;
  priority: number | string;
  deps: string;
  assignee: string | null;
  blocked_on: string;
  resume_status: TaskStatus | null;
  data: string;
  created_at: number | string;
  updated_at: number | string;
};

function fromRow(r: TaskRow): Task {
  return {
    id: r.id,
    title: r.title,
    status: r.status,
    priority: Number(r.priority),
    deps: JSON.parse(r.deps) as string[],
    assignee: r.assignee,
    blockedOn: JSON.parse(r.blocked_on) as string[],
    resumeStatus: r.resume_status,
    data: JSON.parse(r.data) as Record<string, unknown>,
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}

export class WorkQueue {
  private constructor(
    readonly db: Db,
    private readonly now: () => number,
  ) {}

  static async open(db: Db, opts: { now?: () => number } = {}): Promise<WorkQueue> {
    for (const stmt of SCHEMA.split(';')
      .map((s) => s.trim())
      .filter(Boolean))
      await db.exec(stmt);
    await db.run(
      db.dialect === 'sqlite'
        ? 'INSERT OR IGNORE INTO work_counter (name, value) VALUES (?, 0)'
        : 'INSERT INTO work_counter (name, value) VALUES (?, 0) ON CONFLICT DO NOTHING',
      ['seq'],
    );
    return new WorkQueue(db, opts.now ?? Date.now);
  }

  private async nextSeq(db: Db): Promise<number> {
    await db.run("UPDATE work_counter SET value = value + 1 WHERE name = 'seq'");
    return Number((await db.get<{ value: number }>("SELECT value FROM work_counter WHERE name = 'seq'"))!.value);
  }

  private async load(db: Db, id: string): Promise<Task> {
    const r = await db.get<TaskRow>('SELECT * FROM work_tasks WHERE id = ?', [id]);
    if (!r) throw new TransitionError(`no task ${id}`);
    return fromRow(r);
  }

  private async save(db: Db, t: Task, from: TaskStatus | null, actor: string, note?: string): Promise<void> {
    t.updatedAt = this.now();
    await db.run(
      'UPDATE work_tasks SET status = ?, assignee = ?, blocked_on = ?, resume_status = ?, data = ?, updated_at = ? WHERE id = ?',
      [t.status, t.assignee, JSON.stringify(t.blockedOn), t.resumeStatus, JSON.stringify(t.data), t.updatedAt, t.id],
    );
    if (from !== t.status) {
      await db.run(
        'INSERT INTO work_events (seq, task, from_status, to_status, actor, at, note) VALUES (?,?,?,?,?,?,?)',
        [await this.nextSeq(db), t.id, from, t.status, actor, t.updatedAt, note ?? null],
      );
    }
  }

  private async depsDone(db: Db, t: Task): Promise<boolean> {
    for (const d of t.deps) if ((await this.load(db, d)).status !== 'done') return false;
    return true;
  }

  async add(
    o: { id?: string; title: string; deps?: string[]; priority?: number; data?: Record<string, unknown> },
    actor = 'system',
  ): Promise<Task> {
    return this.db.tx(async (db) => {
      const id = o.id ?? `task_${randomBytes(5).toString('hex')}`;
      if (await db.get('SELECT id FROM work_tasks WHERE id = ?', [id]))
        throw new TransitionError(`task ${id} already exists`);
      const deps = [...new Set(o.deps ?? [])];
      for (const d of deps) await this.load(db, d); // must exist (so no cycles can form)
      const now = this.now();
      const seq = await this.nextSeq(db);
      await db.run(
        'INSERT INTO work_tasks (id, title, status, priority, deps, assignee, blocked_on, resume_status, data, created_at, updated_at, seq) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
        [
          id,
          o.title,
          'pending',
          o.priority ?? 0,
          JSON.stringify(deps),
          null,
          '[]',
          null,
          JSON.stringify(o.data ?? {}),
          now,
          now,
          seq,
        ],
      );
      await db.run(
        'INSERT INTO work_events (seq, task, from_status, to_status, actor, at, note) VALUES (?,?,?,?,?,?,?)',
        [await this.nextSeq(db), id, null, 'pending', actor, now, null],
      );
      const t = await this.load(db, id);
      if (await this.depsDone(db, t)) {
        t.status = 'ready';
        await this.save(db, t, 'pending', 'system', 'dependencies satisfied');
      }
      return this.load(db, id);
    });
  }

  get(id: string): Promise<Task> {
    return this.load(this.db, id);
  }

  async list(filter: { status?: TaskStatus; assignee?: string } = {}): Promise<Task[]> {
    const rows = await this.db.all<TaskRow>('SELECT * FROM work_tasks ORDER BY seq');
    return rows
      .map(fromRow)
      .filter(
        (t) => (!filter.status || t.status === filter.status) && (!filter.assignee || t.assignee === filter.assignee),
      );
  }

  async events(task?: string): Promise<TaskEvent[]> {
    const rows = await this.db.all<Record<string, unknown>>(
      task ? 'SELECT * FROM work_events WHERE task = ? ORDER BY seq' : 'SELECT * FROM work_events ORDER BY seq',
      task ? [task] : [],
    );
    return rows.map((r) => ({
      seq: Number(r.seq),
      task: String(r.task),
      from: (r.from_status as TaskStatus) ?? null,
      to: r.to_status as TaskStatus,
      actor: String(r.actor),
      at: Number(r.at),
      note: (r.note as string) ?? null,
    }));
  }

  private async transition(
    id: string,
    actor: string,
    fn: (t: Task, db: Db) => Promise<void> | void,
    note?: string,
  ): Promise<Task> {
    return this.db.tx(async (db) => {
      const t = await this.load(db, id);
      const from = t.status;
      await fn(t, db);
      await this.save(db, t, from, actor, note);
      if (t.status === 'done') await this.promoteDependents(db, t.id);
      return this.load(db, id);
    });
  }

  private async promoteDependents(db: Db, doneId: string): Promise<void> {
    const rows = await db.all<TaskRow>("SELECT * FROM work_tasks WHERE status = 'pending'");
    for (const r of rows.map(fromRow)) {
      if (r.deps.includes(doneId) && (await this.depsDone(db, r))) {
        r.status = 'ready';
        await this.save(db, r, 'pending', 'system', `dependency ${doneId} done`);
      }
    }
  }

  private expect(t: Task, allowed: TaskStatus[], action: string): void {
    if (!allowed.includes(t.status)) throw new TransitionError(`cannot ${action} task ${t.id} in status ${t.status}`);
  }

  private owner(t: Task, agent: string): void {
    if (t.assignee !== agent)
      throw new TransitionError(`task ${t.id} is assigned to ${t.assignee ?? 'nobody'}, not ${agent}`);
  }

  /** Atomically claim the highest-priority ready task (or a specific one). */
  async claim(agent: string, id?: string): Promise<Task | undefined> {
    return this.db.tx(async (db) => {
      const r = id
        ? await db.get<TaskRow>("SELECT * FROM work_tasks WHERE id = ? AND status = 'ready'", [id])
        : await db.get<TaskRow>(
            "SELECT * FROM work_tasks WHERE status = 'ready' ORDER BY priority DESC, seq ASC LIMIT 1",
          );
      if (!r) return undefined;
      const t = fromRow(r);
      const res = await db.run(
        "UPDATE work_tasks SET status = 'claimed', assignee = ? WHERE id = ? AND status = 'ready'",
        [agent, t.id],
      );
      if (res.changes !== 1) return undefined;
      t.status = 'claimed';
      t.assignee = agent;
      await this.save(db, t, 'ready', agent);
      return this.load(db, t.id);
    });
  }

  start(id: string, agent: string) {
    return this.transition(id, agent, (t) => {
      this.expect(t, ['claimed'], 'start');
      this.owner(t, agent);
      t.status = 'in_progress';
    });
  }

  release(id: string, agent: string) {
    return this.transition(id, agent, (t) => {
      this.expect(t, ['claimed', 'in_progress'], 'release');
      this.owner(t, agent);
      t.status = 'ready';
      t.assignee = null;
    });
  }

  submit(id: string, agent: string, data: Record<string, unknown> = {}) {
    return this.transition(id, agent, (t) => {
      this.expect(t, ['in_progress'], 'submit');
      this.owner(t, agent);
      t.status = 'review';
      Object.assign(t.data, data);
    });
  }

  approve(id: string, reviewer: string) {
    return this.transition(id, reviewer, (t) => {
      this.expect(t, ['review'], 'approve');
      t.status = 'done';
    });
  }

  requestChanges(id: string, reviewer: string, note: string) {
    return this.transition(
      id,
      reviewer,
      (t) => {
        this.expect(t, ['review'], 'request changes on');
        t.status = 'in_progress';
      },
      note,
    );
  }

  fail(id: string, actor: string, reason: string) {
    return this.transition(
      id,
      actor,
      (t) => {
        this.expect(t, ['claimed', 'in_progress', 'review', 'blocked'], 'fail');
        t.status = 'failed';
      },
      reason,
    );
  }

  cancel(id: string, actor: string, reason?: string) {
    return this.transition(
      id,
      actor,
      (t) => {
        if (TERMINAL.includes(t.status)) throw new TransitionError(`task ${t.id} is already ${t.status}`);
        t.status = 'canceled';
      },
      reason,
    );
  }

  /** Park a task until a decision is answered. */
  block(id: string, actor: string, decisionId: string) {
    return this.transition(
      id,
      actor,
      (t) => {
        this.expect(t, ['claimed', 'in_progress', 'blocked'], 'block');
        if (!t.blockedOn.includes(decisionId)) t.blockedOn.push(decisionId);
        if (t.status !== 'blocked') {
          t.resumeStatus = t.status;
          t.status = 'blocked';
        }
      },
      `waiting on ${decisionId}`,
    );
  }

  /** Attach a decision's answer to every task waiting on it and resume those with nothing else pending. */
  async resolveDecision(decisionId: string, answer: unknown, actor: string): Promise<Task[]> {
    const waiting = (await this.list({ status: 'blocked' })).filter((t) => t.blockedOn.includes(decisionId));
    const out: Task[] = [];
    for (const w of waiting) {
      out.push(
        await this.transition(
          w.id,
          actor,
          (t) => {
            t.blockedOn = t.blockedOn.filter((d) => d !== decisionId);
            const decisions = (t.data.decisions ?? {}) as Record<string, unknown>;
            decisions[decisionId] = answer;
            t.data.decisions = decisions;
            if (t.blockedOn.length === 0) {
              t.status = t.resumeStatus ?? 'in_progress';
              t.resumeStatus = null;
            }
          },
          `decision ${decisionId} answered`,
        ),
      );
    }
    return out;
  }
}
