# Bench

Compare agent configurations on _your_ code: pass rate, cost, wall time.

```sh
cd examples/bench
sluice bench mine     # history -> fail-to-pass tasks
sluice bench run      # every agent × every task; JSON + Markdown report
```

```yaml
# bench.yaml
name: cel-js
source: { bundle: cel-js.bundle, repo: marcbachmann/cel-js, ref: main } # or path:
mine:
  limit: 20
  source: [lib/]
  tests: '^test/.*\.test\.js$'
  testCommand: node --test --experimental-test-isolation=none test/**/*.test.js
agents:
  - name: claude-code
    command: claude -p "$SLUICE_TASK_PROMPT" --permission-mode acceptEdits --output-format json
  - name: codex
    command: codex exec --full-auto "$SLUICE_TASK_PROMPT"
```

**Mining.** A commit that changes source and tests (and no dependency
manifests) becomes a task only if its tests fail on the parent and pass on the
commit — checked in containers with no network, CPU/memory caps and a
host-enforced deadline.

**Running.** Each agent runs in a fresh checkout of the base commit with
`SLUICE_TASK_PROMPT`. Hidden tests are then applied and run in a container.
Cost comes from `$SLUICE_AGENT_REPORT` (`{cost_usd, input_tokens,
output_tokens}`) or the last JSON line with `total_cost_usd` (Claude Code's
JSON output). `oracle: true` agents also get the reference patch (for
calibration).

**Report.** Pass rate, cost, cost per solved task, median/total wall time and a
per-task matrix; everything but timings is reproducible across runs.
