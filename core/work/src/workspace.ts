import { mkdirSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { openDb, type Db } from './db.js';
import { WorkQueue } from './queue.js';

export interface Workspace {
  db: Db;
  queue: WorkQueue;
  close(): Promise<void>;
}

/** Open the project's coordination store: `work.url` from sluice.yaml (sqlite file or postgres URL). */
export async function openWorkspace(
  root: string,
  url = '.sluice/state/work.db',
  opts: { now?: () => number } = {},
): Promise<Workspace> {
  let target = url;
  if (!/^postgres(ql)?:\/\//.test(url) && url !== ':memory:') {
    const file = isAbsolute(url.replace(/^sqlite:/, ''))
      ? url.replace(/^sqlite:/, '')
      : resolve(root, url.replace(/^sqlite:/, ''));
    mkdirSync(dirname(file), { recursive: true });
    target = file;
  }
  const db = openDb(target);
  const queue = await WorkQueue.open(db, opts);
  return { db, queue, close: () => db.close() };
}
