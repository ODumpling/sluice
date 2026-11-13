/**
 * Inbox: typed decision requests from agents to humans, and notifications.
 *
 *  - ask(): an agent asks a typed question (choice / confirm / text) on
 *    behalf of a task; the task is parked (`blocked`) in the work queue.
 *  - dedupe: the same question from several agents/tasks becomes ONE request
 *    (explicit dedupeKey, or normalized kind + question + options); every
 *    asking task is recorded as affected.
 *  - answer(): a human answers once; the answer is validated against the
 *    type and propagated to every affected task, which resumes with the
 *    answer in task.data.decisions[id].
 *  - notify(): one-way messages (e.g. interface-change broadcasts from leases).
 */
import { createHash, randomBytes } from 'node:crypto';
import type { Db, Task, WorkQueue } from '@sluice-dev/work';

export type DecisionKind = 'choice' | 'confirm' | 'text';

export interface Decision {
  id: string;
  kind: DecisionKind;
  question: string;
  options: string[];
  context: Record<string, unknown>;
  dedupeKey: string;
  status: 'open' | 'answered';
  answer: unknown;
  askedBy: string[];
  affectedTasks: string[];
  createdAt: number;
  answeredBy: string | null;
}

export interface InboxNotification {
  id: string;
  toAgent: string;
  task: string | null;
  kind: string;
  message: string;
  data: Record<string, unknown>;
  createdAt: number;
  read: boolean;
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS inbox_decisions (
    id TEXT PRIMARY KEY, kind TEXT NOT NULL, question TEXT NOT NULL, options TEXT NOT NULL, context TEXT NOT NULL,
    dedupe_key TEXT NOT NULL, status TEXT NOT NULL, answer TEXT, asked_by TEXT NOT NULL, affected_tasks TEXT NOT NULL,
    created_at BIGINT NOT NULL, answered_by TEXT)`,
  `CREATE TABLE IF NOT EXISTS inbox_notifications (
    id TEXT PRIMARY KEY, to_agent TEXT NOT NULL, task TEXT, kind TEXT NOT NULL, message TEXT NOT NULL,
    data TEXT NOT NULL, created_at BIGINT NOT NULL, is_read INTEGER NOT NULL DEFAULT 0)`,
];

export function dedupeKeyFor(kind: DecisionKind, question: string, options: string[] = []): string {
  const q = question
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return createHash('sha256')
    .update(
      `${kind}|${q}|${[...options]
        .map((o) => o.toLowerCase().trim())
        .sort()
        .join('|')}`,
    )
    .digest('hex')
    .slice(0, 24);
}

function toDecision(r: Record<string, unknown>): Decision {
  return {
    id: String(r.id),
    kind: r.kind as DecisionKind,
    question: String(r.question),
    options: JSON.parse(String(r.options)) as string[],
    context: JSON.parse(String(r.context)) as Record<string, unknown>,
    dedupeKey: String(r.dedupe_key),
    status: r.status as Decision['status'],
    answer: r.answer === null || r.answer === undefined ? null : (JSON.parse(String(r.answer)) as unknown),
    askedBy: JSON.parse(String(r.asked_by)) as string[],
    affectedTasks: JSON.parse(String(r.affected_tasks)) as string[],
    createdAt: Number(r.created_at),
    answeredBy: (r.answered_by as string | null) ?? null,
  };
}

export class Inbox {
  private constructor(
    private readonly db: Db,
    private readonly queue: WorkQueue | undefined,
    private readonly now: () => number,
  ) {}

  static async open(db: Db, opts: { queue?: WorkQueue; now?: () => number } = {}): Promise<Inbox> {
    for (const s of SCHEMA) await db.exec(s);
    return new Inbox(db, opts.queue, opts.now ?? Date.now);
  }

  async ask(o: {
    agent: string;
    task?: string;
    kind: DecisionKind;
    question: string;
    options?: string[];
    context?: Record<string, unknown>;
    dedupeKey?: string;
  }): Promise<{ decision: Decision; deduped: boolean; alreadyAnswered: boolean }> {
    const options = o.options ?? [];
    if (o.kind === 'choice' && options.length < 2) throw new Error('a choice needs at least two options');
    if (o.kind !== 'choice' && options.length) throw new Error(`${o.kind} questions take no options`);
    if (!o.question.trim()) throw new Error('question required');
    const key = o.dedupeKey ?? dedupeKeyFor(o.kind, o.question, options);
    const result = await this.db.tx(async (db) => {
      const existing = await db.get(
        'SELECT * FROM inbox_decisions WHERE dedupe_key = ? ORDER BY created_at DESC LIMIT 1',
        [key],
      );
      if (existing) {
        const d = toDecision(existing);
        if (!d.askedBy.includes(o.agent)) d.askedBy.push(o.agent);
        if (o.task && !d.affectedTasks.includes(o.task)) d.affectedTasks.push(o.task);
        await db.run('UPDATE inbox_decisions SET asked_by = ?, affected_tasks = ? WHERE id = ?', [
          JSON.stringify(d.askedBy),
          JSON.stringify(d.affectedTasks),
          d.id,
        ]);
        return { decision: d, deduped: true };
      }
      const d: Decision = {
        id: `dec_${randomBytes(5).toString('hex')}`,
        kind: o.kind,
        question: o.question.trim(),
        options,
        context: o.context ?? {},
        dedupeKey: key,
        status: 'open',
        answer: null,
        askedBy: [o.agent],
        affectedTasks: o.task ? [o.task] : [],
        createdAt: this.now(),
        answeredBy: null,
      };
      await db.run(
        'INSERT INTO inbox_decisions (id, kind, question, options, context, dedupe_key, status, answer, asked_by, affected_tasks, created_at, answered_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
        [
          d.id,
          d.kind,
          d.question,
          JSON.stringify(d.options),
          JSON.stringify(d.context),
          d.dedupeKey,
          d.status,
          null,
          JSON.stringify(d.askedBy),
          JSON.stringify(d.affectedTasks),
          d.createdAt,
          null,
        ],
      );
      return { decision: d, deduped: false };
    });
    const alreadyAnswered = result.decision.status === 'answered';
    if (o.task && this.queue && !alreadyAnswered) await this.queue.block(o.task, o.agent, result.decision.id);
    return { ...result, alreadyAnswered };
  }

  async get(id: string): Promise<Decision> {
    const r = await this.db.get('SELECT * FROM inbox_decisions WHERE id = ?', [id]);
    if (!r) throw new Error(`no decision ${id}`);
    return toDecision(r);
  }

  async list(status?: Decision['status']): Promise<Decision[]> {
    const rows = await this.db.all(
      status
        ? 'SELECT * FROM inbox_decisions WHERE status = ? ORDER BY created_at'
        : 'SELECT * FROM inbox_decisions ORDER BY created_at',
      status ? [status] : [],
    );
    return rows.map(toDecision);
  }

  static coerceAnswer(d: Decision, raw: unknown): unknown {
    if (d.kind === 'choice') {
      const v = String(raw);
      if (!d.options.includes(v)) throw new Error(`answer must be one of: ${d.options.join(', ')}`);
      return v;
    }
    if (d.kind === 'confirm') {
      if (raw === true || raw === 'yes' || raw === 'true') return true;
      if (raw === false || raw === 'no' || raw === 'false') return false;
      throw new Error('answer must be yes or no');
    }
    const v = String(raw ?? '').trim();
    if (!v) throw new Error('answer must not be empty');
    return v;
  }

  /** Human answer; propagated to every affected task. Returns the resumed tasks. */
  async answer(id: string, raw: unknown, by: string): Promise<{ decision: Decision; tasks: Task[] }> {
    if (!by.trim()) throw new Error('who is answering? (identity required)');
    const d = await this.get(id);
    if (d.status === 'answered') throw new Error(`decision ${id} was already answered by ${d.answeredBy}`);
    const answer = Inbox.coerceAnswer(d, raw);
    await this.db.run(
      "UPDATE inbox_decisions SET status = 'answered', answer = ?, answered_by = ? WHERE id = ? AND status = 'open'",
      [JSON.stringify(answer), by, id],
    );
    const tasks = this.queue ? await this.queue.resolveDecision(id, { answer, by, question: d.question }, by) : [];
    return { decision: { ...d, status: 'answered', answer, answeredBy: by }, tasks };
  }

  async notify(n: {
    toAgent: string;
    task?: string;
    kind: string;
    message: string;
    data?: Record<string, unknown>;
  }): Promise<InboxNotification> {
    const row: InboxNotification = {
      id: `ntf_${randomBytes(5).toString('hex')}`,
      toAgent: n.toAgent,
      task: n.task ?? null,
      kind: n.kind,
      message: n.message,
      data: n.data ?? {},
      createdAt: this.now(),
      read: false,
    };
    await this.db.run(
      'INSERT INTO inbox_notifications (id, to_agent, task, kind, message, data, created_at) VALUES (?,?,?,?,?,?,?)',
      [row.id, row.toAgent, row.task, row.kind, row.message, JSON.stringify(row.data), row.createdAt],
    );
    return row;
  }

  /** Notifications for an agent (marks them read). */
  async notifications(
    agent: string,
    opts: { unreadOnly?: boolean; markRead?: boolean } = {},
  ): Promise<InboxNotification[]> {
    const rows = await this.db.all(
      `SELECT * FROM inbox_notifications WHERE to_agent = ?${opts.unreadOnly ? ' AND is_read = 0' : ''} ORDER BY created_at, id`,
      [agent],
    );
    const out = rows.map((r) => ({
      id: String(r.id),
      toAgent: String(r.to_agent),
      task: (r.task as string | null) ?? null,
      kind: String(r.kind),
      message: String(r.message),
      data: JSON.parse(String(r.data)) as Record<string, unknown>,
      createdAt: Number(r.created_at),
      read: Number(r.is_read) === 1,
    }));
    if (opts.markRead !== false)
      await this.db.run('UPDATE inbox_notifications SET is_read = 1 WHERE to_agent = ?', [agent]);
    return out;
  }
}
