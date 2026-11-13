# ADR-0005: Bench — mined tasks, agent-neutral runs, reproducible reports

- Status: accepted
- Date: 2026-11-13

## Context

Teams choosing between agent configurations (model, prompt, tool set, CLI)
need numbers from _their kind of code_, not leaderboards: pass rate, cost and
wall time on tasks with an objective oracle.

## Decision

- **Mining** (SWE-bench style): walk first-parent, non-merge history; a commit
  that changes source (`mine.source` prefixes) _and_ tests (`mine.tests`
  regex), and no dependency manifests, is a candidate. It becomes a task only
  if its hidden tests (the test files at the commit) **fail on the parent** and
  the suite **passes on the commit**. Both checks run in `node:22-alpine` with
  `--network none --init` and an in-container `timeout`, so mining is offline
  and hung suites are rejected, not waited on.
- **Task** = base sha, problem statement (commit message), hidden test files,
  gold patch (source-only diff), test command, image. Datasets are JSONL with a
  content hash.
- **Agents** are shell commands run in a fresh git checkout of the base
  (`${benchDir}` expands to the config directory). Agent-neutral: Claude Code,
  Codex, Cursor CLI or a script. Env: `SLUICE_TASK_PROMPT`, `SLUICE_TASK_ID`,
  `SLUICE_AGENT_REPORT`; `SLUICE_TASK_GOLD_PATCH` only for agents marked
  `oracle: true` (calibration). Cost/tokens come from the report file or the
  last JSON output line with `total_cost_usd` / `usage` (Claude Code's
  `--output-format json`).
- **Evaluation**: hidden test files overwrite the agent's tree, then the test
  command runs in a no-network container. Pass = exit 0 and no agent timeout.
- **Reports**: JSON + Markdown with per-agent pass rate, cost, cost/solved,
  median and total wall time, and a per-task matrix. `reproducibleView` (all
  but timings) is identical across re-runs — the M4 test asserts it.
- **Source data**: `marcbachmann/cel-js` (MIT, zero runtime dependencies,
  `node --test`) vendored as a git bundle at
  `86cd97216a1cbb522eda81aaa0221c245d5913d7` (`examples/bench/cel-js.bundle`),
  so tests make no network calls. Bundle is unmodified upstream history.

## Consequences

- Only repos whose tests run without installing dependencies work offline in
  v0.1 (or use an image with dependencies baked in via `mine.image`).
- Scripted agents in `examples/bench/agents` (oracle, first-file partial
  solver with _simulated_ cost) exist to test the harness; real agent configs
  are documented in `bench.yaml` but not run in CI (they need credentials).
