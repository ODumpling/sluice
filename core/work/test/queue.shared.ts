import { expect } from 'vitest';
import { TransitionError, WorkQueue, type Db } from '@sluice-dev/work';

/** Behaviour every Db backend must satisfy. */
export async function exerciseQueue(db: Db): Promise<void> {
  let t = 1000;
  const q = await WorkQueue.open(db, { now: () => (t += 1) });
  const types = await q.add({ id: 'types', title: 'change Invoice type' });
  expect(types.status).toBe('ready');
  const api = await q.add({ id: 'api', title: 'expose invoices API', deps: ['types'] });
  const ui = await q.add({ id: 'ui', title: 'invoice UI', deps: ['api'], priority: 5 });
  expect([api.status, ui.status]).toEqual(['pending', 'pending']);
  await expect(q.add({ id: 'x', title: 'x', deps: ['nope'] })).rejects.toBeInstanceOf(TransitionError);
  await expect(q.add({ id: 'types', title: 'dup' })).rejects.toThrow(/already exists/);

  // only one agent can claim a ready task
  const [a, b] = await Promise.all([q.claim('agent-a'), q.claim('agent-b')]);
  expect([a?.id, b?.id].filter(Boolean)).toEqual(['types']);
  const owner = a ? 'agent-a' : 'agent-b';
  const other = a ? 'agent-b' : 'agent-a';
  await expect(q.start('types', other)).rejects.toThrow(/assigned to/);
  await q.start('types', owner);

  // block on a decision, answer propagates
  await q.block('types', owner, 'dec_1');
  expect((await q.get('types')).status).toBe('blocked');
  const resumed = await q.resolveDecision('dec_1', { choice: 'keep amount_cents' }, 'po');
  expect(resumed[0]).toMatchObject({
    id: 'types',
    status: 'in_progress',
    blockedOn: [],
    data: { decisions: { dec_1: { choice: 'keep amount_cents' } } },
  });

  await q.submit('types', owner, { pr: 7 });
  await expect(q.approve('api', 'lead')).rejects.toThrow(/cannot approve/);
  await q.approve('types', 'lead');
  expect((await q.get('api')).status).toBe('ready'); // dependency promotion
  expect((await q.get('ui')).status).toBe('pending');
  const next = await q.claim(other);
  expect(next?.id).toBe('api');
  await q.start('api', other);
  await q.submit('api', other);
  await q.requestChanges('api', 'lead', 'missing pagination');
  await q.submit('api', other);
  await q.approve('api', 'lead');
  expect((await q.get('ui')).status).toBe('ready');
  await q.cancel('ui', 'lead', 'descoped');
  await expect(q.cancel('ui', 'lead')).rejects.toThrow(/already canceled/);

  const ev = await q.events('types');
  expect(ev.map((e) => e.to)).toEqual([
    'pending',
    'ready',
    'claimed',
    'in_progress',
    'blocked',
    'in_progress',
    'review',
    'done',
  ]);
  expect(ev[4]!.note).toBe('waiting on dec_1');
  expect((await q.list({ status: 'done' })).map((x) => x.id)).toEqual(['types', 'api']);
}
