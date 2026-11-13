import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'vitest';
import { SqliteDb, WorkQueue, openDb } from '@sluice-dev/work';
import { exerciseQueue } from './queue.shared.js';

describe('work queue (SQLite)', () => {
  it('runs the task/dependency state machine', async () => {
    const db = new SqliteDb(':memory:');
    await exerciseQueue(db);
    await db.close();
  });
  it('persists across processes (file database)', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'sluice-work-')), 'work.db');
    const a = openDb(`sqlite:${file}`);
    const q = await WorkQueue.open(a);
    await q.add({ id: 't1', title: 'one' });
    await a.close();
    const b = openDb(file);
    const q2 = await WorkQueue.open(b);
    const { expect } = await import('vitest');
    expect((await q2.get('t1')).status).toBe('ready');
    await b.close();
  });
});
