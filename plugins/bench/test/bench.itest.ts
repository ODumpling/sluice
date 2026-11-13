// M4 exit: mine >= 20 tasks from a public repo's history (marcbachmann/cel-js, vendored
// as a git bundle — no network) and compare 2 agent configs with a reproducible report.
import { cpSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { runCli, type HostIO } from '@sluice-dev/cli';
import { bench, loadBenchConfig, readDataset, reproducibleView, type BenchReport } from '@sluice-dev/plugin-bench';

const EXAMPLE = join(import.meta.dirname, '..', '..', '..', 'examples', 'bench');

describe('sluice bench (M4)', () => {
  let dir: string;
  beforeAll(() => {
    dir = join(mkdtempSync(join(tmpdir(), 'sluice-bench-e2e-')), 'bench');
    cpSync(EXAMPLE, dir, { recursive: true, filter: (s) => !s.includes('.sluice') });
  });

  it('mines >= 20 fail-to-pass tasks from cel-js history', async () => {
    let out = '';
    const io: HostIO = { cwd: dir, env: {}, stdout: { write: (t) => void (out += t) }, stderr: { write: () => {} } };
    expect(await runCli(['bench', 'mine'], io)).toBe(0);
    const tasks = readDataset(join(dir, '.sluice', 'bench', 'cel-js', 'tasks.jsonl'));
    expect(tasks.length).toBeGreaterThanOrEqual(20);
    for (const t of tasks) {
      expect(t.repo).toBe('marcbachmann/cel-js');
      expect(Object.keys(t.tests).length).toBeGreaterThan(0);
      expect(t.goldPatch).toMatch(/^diff --git a\/lib\//m);
      expect(t.problem.length).toBeGreaterThan(0);
    }
    expect(new Set(tasks.map((t) => t.id)).size).toBe(tasks.length);
  });

  let first: BenchReport;
  it('compares two agent configs on pass rate, cost and wall time', async () => {
    let out = '';
    const io: HostIO = { cwd: dir, env: {}, stdout: { write: (t) => void (out += t) }, stderr: { write: () => {} } };
    expect(await runCli(['bench', 'run', '--json'], io)).toBe(0);
    first = JSON.parse(out) as BenchReport;
    const [oracle, partial] = first.summaries;
    expect(oracle).toMatchObject({ agent: 'oracle', passRate: 1, costUsd: 0 });
    expect(oracle!.tasks).toBeGreaterThanOrEqual(20);
    expect(partial!.agent).toBe('first-file');
    expect(partial!.passRate).toBeLessThan(1);
    expect(partial!.costUsd).toBeGreaterThan(0);
    for (const s of first.summaries) expect(s.wallMsTotal).toBeGreaterThan(0);
  });

  it('the report is reproducible', async () => {
    const again = await bench(loadBenchConfig(join(dir, 'bench.yaml')));
    expect(reproducibleView(again.report)).toEqual(reproducibleView(first));
  });
});
