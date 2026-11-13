import { describe, expect, it } from 'vitest';
import { Inbox, dedupeKeyFor } from '@sluice-dev/plugin-inbox';
import { SqliteDb, WorkQueue } from '@sluice-dev/work';

async function setup() {
  const db = new SqliteDb(':memory:');
  const queue = await WorkQueue.open(db);
  const inbox = await Inbox.open(db, { queue });
  for (const id of ['t1', 't2']) {
    await queue.add({ id, title: id });
    await queue.claim(`agent-${id}`, id);
    await queue.start(id, `agent-${id}`);
  }
  return { db, queue, inbox };
}

describe('inbox', () => {
  it('normalizes questions for dedupe', () => {
    expect(dedupeKeyFor('choice', 'Use UTC?', ['yes', 'no'])).toBe(
      dedupeKeyFor('choice', '  use   utc ', ['No', 'Yes']),
    );
    expect(dedupeKeyFor('choice', 'Use UTC?', ['yes', 'no'])).not.toBe(dedupeKeyFor('confirm', 'Use UTC?'));
  });

  it('validates typed answers and propagates them to every blocked task', async () => {
    const { inbox, queue } = await setup();
    const a = await inbox.ask({
      agent: 'agent-t1',
      task: 't1',
      kind: 'confirm',
      question: 'Drop the legacy column?',
      dedupeKey: 'drop-legacy',
    });
    const b = await inbox.ask({
      agent: 'agent-t2',
      task: 't2',
      kind: 'confirm',
      question: 'Is it OK to remove legacy_amount?',
      dedupeKey: 'drop-legacy',
    });
    expect(b).toMatchObject({
      deduped: true,
      decision: { id: a.decision.id, askedBy: ['agent-t1', 'agent-t2'], affectedTasks: ['t1', 't2'] },
    });
    await expect(inbox.answer(a.decision.id, 'perhaps', 'lead')).rejects.toThrow(/yes or no/);
    await expect(inbox.answer(a.decision.id, 'yes', ' ')).rejects.toThrow(/identity/);
    const r = await inbox.answer(a.decision.id, 'yes', 'lead');
    expect(r.tasks.map((t) => [t.id, t.status])).toEqual([
      ['t1', 'in_progress'],
      ['t2', 'in_progress'],
    ]);
    expect((await queue.get('t2')).data.decisions).toMatchObject({ [a.decision.id]: { answer: true } });
    await expect(inbox.answer(a.decision.id, 'no', 'lead')).rejects.toThrow(/already answered/);
    // asking an already-answered question returns the answer immediately and does not block
    const again = await inbox.ask({
      agent: 'agent-t1',
      task: 't1',
      kind: 'confirm',
      question: 'x',
      dedupeKey: 'drop-legacy',
    });
    expect(again).toMatchObject({ alreadyAnswered: true, decision: { answer: true } });
    expect((await queue.get('t1')).status).toBe('in_progress');
  });

  it('rejects malformed questions and delivers notifications once', async () => {
    const { inbox } = await setup();
    await expect(inbox.ask({ agent: 'a', kind: 'choice', question: 'pick', options: ['only'] })).rejects.toThrow(
      /two options/,
    );
    await expect(inbox.ask({ agent: 'a', kind: 'text', question: 'q', options: ['x'] })).rejects.toThrow(/no options/);
    await inbox.notify({ toAgent: 'a', kind: 'interface_changed', message: 'Invoice changed' });
    expect(await inbox.notifications('a', { unreadOnly: true })).toHaveLength(1);
    expect(await inbox.notifications('a', { unreadOnly: true })).toHaveLength(0);
  });
});
