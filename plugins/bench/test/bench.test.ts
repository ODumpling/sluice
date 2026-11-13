import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { extractCost, loadBenchConfig, renderBenchMarkdown, summarize, type AgentRun } from '@sluice-dev/plugin-bench';

const run = (agent: string, passed: boolean, costUsd: number, wallMs: number): AgentRun => ({
  task: `t${wallMs}`,
  agent,
  passed,
  agentExitCode: 0,
  timedOut: false,
  costUsd,
  tokens: 0,
  wallMs,
  evalMs: 1,
  changedFiles: [],
  outputTail: '',
});

describe('bench units', () => {
  it('extracts cost from a report file or Claude-Code-style JSON output', () => {
    const d = mkdtempSync(join(tmpdir(), 'sluice-bench-'));
    const f = join(d, 'r.json');
    expect(
      extractCost(f, 'noise\n{"type":"result","total_cost_usd":0.42,"usage":{"input_tokens":10,"output_tokens":5}}\n'),
    ).toEqual({ costUsd: 0.42, tokens: 15 });
    writeFileSync(f, JSON.stringify({ cost_usd: 1.5, input_tokens: 3, output_tokens: 4 }));
    expect(extractCost(f, '')).toEqual({ costUsd: 1.5, tokens: 7 });
    expect(extractCost(join(d, 'none'), 'plain text')).toEqual({ costUsd: 0, tokens: 0 });
  });
  it('summarizes pass rate, cost and wall time', () => {
    const runs = [run('a', true, 0.1, 10), run('a', false, 0.2, 30), run('a', true, 0.3, 20), run('b', false, 0, 5)];
    expect(summarize('a', runs)).toEqual({
      agent: 'a',
      tasks: 3,
      passed: 2,
      passRate: 2 / 3,
      costUsd: 0.6,
      costPerSolved: 0.3,
      wallMsTotal: 60,
      wallMsMedian: 20,
    });
    expect(summarize('b', runs).costPerSolved).toBeNull();
  });
  it('renders a comparison table', () => {
    const runs = [run('a', true, 0.1, 10), run('b', false, 0, 10)];
    const md = renderBenchMarkdown({
      format: 'sluice-bench-report/1',
      dataset: { name: 'x', hash: 'h', tasks: 1, repo: 'o/r' },
      agents: [],
      summaries: [summarize('a', runs), summarize('b', runs)],
      runs,
    });
    expect(md).toContain('| a | 1/1 | 100.0% | $0.1000 |');
    expect(md).toContain('| t10 | ✅ | ❌ |');
  });
  it('validates bench configs and resolves ${benchDir}', () => {
    const d = mkdtempSync(join(tmpdir(), 'sluice-bench-'));
    writeFileSync(
      join(d, 'b.yaml'),
      'name: x\nsource: { path: ., repo: o/r }\nmine: { limit: 1, source: [lib/], tests: x, testCommand: t }\nagents: [{ name: a, command: "node ${benchDir}/a.mjs" }]\n',
    );
    expect(loadBenchConfig(join(d, 'b.yaml')).config.agents[0]!.command).toBe(`node ${d}/a.mjs`);
    writeFileSync(
      join(d, 'c.yaml'),
      'name: x\nsource: { path: ., repo: o/r }\nmine: { limit: 1, source: [], tests: x, testCommand: t }\nagents: [{ name: a, command: x }, { name: a, command: y }]\n',
    );
    expect(() => loadBenchConfig(join(d, 'c.yaml'))).toThrow(/duplicate agent/);
  });
});
