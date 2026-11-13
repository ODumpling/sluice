// The same state machine against Postgres (optional backend).
import { afterAll, beforeAll, describe, it } from 'vitest';
import { docker } from '@sluice-dev/sandbox';
import { PostgresDb } from '@sluice-dev/work';
import { exerciseQueue } from './queue.shared.js';

describe('work queue (Postgres)', () => {
  const name = `sluice-work-pg-${process.pid}`;
  let url = '';
  beforeAll(async () => {
    await docker([
      'run',
      '-d',
      '--rm',
      '--name',
      name,
      '--label',
      'sluice.sandbox=work-test',
      '-e',
      'POSTGRES_PASSWORD=pw',
      '-p',
      '127.0.0.1::5432',
      'postgres:16-alpine',
    ]);
    const port = /:(\d+)/.exec((await docker(['port', name, '5432/tcp'])).stdout)![1];
    url = `postgres://postgres:pw@127.0.0.1:${port}/postgres`;
    for (let i = 0; i < 60; i++) {
      const db = new PostgresDb(url);
      try {
        await db.get('SELECT 1');
        await db.close();
        return;
      } catch {
        await db.close().catch(() => undefined);
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    throw new Error('postgres did not start');
  });
  afterAll(async () => {
    await docker(['rm', '-f', name], { allowFail: true });
  });
  it('runs the task/dependency state machine', async () => {
    const db = new PostgresDb(url);
    await exerciseQueue(db);
    await db.close();
  });
});
