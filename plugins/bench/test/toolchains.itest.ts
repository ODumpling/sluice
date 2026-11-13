// Go and .NET bench out of the box: synthesize small repos with history and an
// external dependency each, mine fail-to-pass tasks with every mining setting
// defaulted from the detected toolchain (image, test command, test files and the
// network-at-build-time dependency prepare step; tests run offline), and run the
// oracle agent -> 100% pass.
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { bench, loadBenchConfig, mine, readDataset } from '@sluice-dev/plugin-bench';

const EXAMPLE = join(import.meta.dirname, '..', '..', '..', 'examples', 'bench');

describe('bench for Go and .NET', () => {
  let root: string;
  let synth: string;
  const heads: Record<string, string> = {};
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'sluice-bench-langs-'));
    synth = join(root, 'synth');
    const out = execFileSync('node', [join(EXAMPLE, 'synth', 'make-repos.mjs'), synth]).toString();
    for (const l of out.trim().split('\n')) {
      const [name, sha] = l.split(' ');
      heads[name!] = sha!;
    }
    cpSync(EXAMPLE, join(root, 'bench'), {
      recursive: true,
      filter: (s) => !s.includes('.sluice') && !s.endsWith('cel-js.bundle'),
    });
  });

  it('the vendored example bundles are exactly the synthesized history', () => {
    for (const name of ['go-textkit', 'dotnet-textkit']) {
      const listed = execFileSync('git', ['bundle', 'list-heads', join(EXAMPLE, `${name}.bundle`)]).toString();
      expect(listed).toContain(`${heads[name]} refs/heads/main`);
    }
  });

  for (const [lang, name, image, testFile] of [
    ['go', 'go-textkit', /^golang:/, /_test\.go$/],
    ['dotnet', 'dotnet-textkit', /^mcr\.microsoft\.com\/dotnet\/sdk:/, /^tests\/Textkit\.Tests\/\w+Tests\.cs$/],
  ] as const) {
    it(`${lang}: mines fail-to-pass tasks with toolchain defaults and the oracle solves all`, async () => {
      const dir = join(root, 'bench');
      const cfg = `${lang}.local.bench.yaml`;
      // the example config, pointed at the freshly synthesized repository
      writeFileSync(
        join(dir, cfg),
        readFileSync(join(dir, `${lang}.bench.yaml`), 'utf8').replace(
          /bundle: .*\n/,
          `path: ${JSON.stringify(join(synth, name))}\n`,
        ),
      );
      const b = loadBenchConfig(join(dir, cfg));
      const logs: string[] = [];
      const mined = await mine(b, (m) => logs.push(m));
      const why = JSON.stringify({ logs, rejected: mined.rejected });
      const tasks = readDataset(join(dir, '.sluice', 'bench', name, 'tasks.jsonl'));
      // initial commit has no parent; the README-only commit has no tests
      expect(tasks.length, why).toBe(4);
      expect(mined.rejected, why).toEqual([]);
      for (const t of tasks) {
        expect(t.image).toMatch(image);
        expect(t.prepare).toBeTruthy();
        expect(Object.keys(t.tests).length).toBeGreaterThan(0);
        for (const f of Object.keys(t.tests)) expect(f).toMatch(testFile);
        expect(t.goldPatch).not.toMatch(testFile);
        expect(t.goldPatch).toMatch(/^diff --git /m);
      }
      expect(tasks.map((t) => t.problem.split('\n')[0])).toContain(
        lang === 'go' ? 'Fix Reverse for multi-byte characters' : 'Fix Reverse for surrogate pairs',
      );

      const { report } = await bench(b, { agents: ['oracle'] });
      expect(report.summaries[0], JSON.stringify(report.runs.filter((x) => !x.passed))).toMatchObject({
        agent: 'oracle',
        tasks: 4,
        passed: 4,
        passRate: 1,
      });
    });
  }
});
