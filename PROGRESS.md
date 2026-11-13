# PROGRESS

Spec: [docs/GOAL.md](docs/GOAL.md). Each milestone lists exit criteria and the command that proves it.

## Status

| Milestone            | State |
| -------------------- | ----- |
| M0 Skeleton          | done  |
| M1 Sandbox + fakes   | done  |
| M2 Evidence + replay | done  |
| M3 Gate              | done  |
| M4 Bench             | done  |
| M5 Policy            | done  |
| M6 Coordination      | done  |
| M7 Campaign          | done  |
| M8 Polish            | done  |
| M9 Go/.NET parity    | done  |

## M0 Skeleton — done

Delivered: pnpm monorepo (`core/`, `plugins/`, `surfaces/`), TypeScript 6 strict,
ESLint + Prettier, Vitest (`unit` + `integration` projects), socket-level
no-egress guard for all tests, GitHub Actions CI, plugin API v1
(`@sluice-dev/plugin-api`) with docs (`docs/plugin-api.md`), reference
`hello` plugin, `@sluice-dev/config` (`sluice.yaml` loader), CLI (`sluice`)
whose commands are all registered through the plugin API, ADR-0001.

| Exit criterion                          | Proof                                                                                                                                 |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm test` green in CI                 | CI job `check` (`.github/workflows/ci.yml`) runs `pnpm lint && pnpm typecheck && pnpm build && pnpm test`                             |
| plugin API has a working "hello" plugin | `plugins/hello/test/hello.test.ts`; `surfaces/cli/test/cli.test.ts` ("runs the hello plugin command…", "loads a third-party plugin…") |
| `sluice --help` works                   | `surfaces/cli/test/cli.test.ts` ("--help lists commands"); CI step `node surfaces/cli/bin/sluice.js --help`                           |
| core never imports plugins              | `test/unit/architecture.test.ts`; ESLint rule in `eslint.config.js`                                                                   |

Open issues: none.

## M1 Sandbox + fakes — done

Delivered: `@sluice-dev/sandbox` (Docker CLI driven; services on an `--internal`
network; gateway container is the only bridge; host-side fakes; determinism
shim; DB template reset; source swapping), `@sluice-dev/fakes` (OpenAPI
`Contract`, `FakeServer`, stateful `StripeFake` on vendored Stripe spec
2026-09-30.endive, `RecordingProxy`, spec/traffic/fixture/client-version drift
detection), `examples/billing-demo` (Node + Postgres + Stripe SDK),
`sluice up [--exec]`, `sluice down`, ADR-0002.

| Exit criterion                               | Proof                                                                                                                                                                                                                           |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| billing-demo boots via `sluice up`           | `surfaces/cli/test/up.itest.ts` (`pnpm test:integration`)                                                                                                                                                                       |
| Stripe fake stateful + contract-checked      | `core/fakes/test/stripe-fake.test.ts` (official `stripe` SDK against the fake; `server.violations` empty), `core/fakes/test/form-contract.test.ts` (strict validation catches undocumented/mistyped fields)                     |
| drift detection                              | `core/fakes/test/drift.test.ts` (spec drift, recorded-cassette drift, client version drift); fixture drift finds real upstream drift in Stripe's fixtures                                                                       |
| full flow against fake with zero real egress | `core/sandbox/test/billing-demo.itest.ts`: full flow incl. clock-driven renewal; app/db attached only to the internal network; in-container `fetch('https://api.stripe.com')` and raw TCP to 1.1.1.1 fail; CI job `integration` |

Open issues: S3 fake is planned for M8 (GitHub fake landed in M3).

## M2 Evidence + replay — done

Delivered: `@sluice-dev/evidence` (audit triggers via event trigger, scripts
with capture/interpolation, `runScript` sessions with ingress/egress/DB/events +
final state, diff engine with id canonicalization, noise-filter globs and LCS
alignment), determinism shim event capture, `checkoutRef` builds,
`sluice record | replay | diff`, ADR-0003.

| Exit criterion                                                      | Proof                                                                                                                                                                     |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| record a session, replay against two builds, diff deterministically | `core/evidence/test/replay.itest.ts`, `surfaces/cli/test/evidence.itest.ts`                                                                                               |
| same build replayed 10x -> zero diff                                | `replay.itest.ts` "same build replayed 10x -> zero diff (raw, no noise filters)" — also byte-equal step JSON                                                              |
| seeded behavior change -> exactly that diff                         | `replay.itest.ts` "seeded response change -> exactly that diff" (3 exact entries) and "seeded DB-write change -> exactly that diff …" (response + DB write + final state) |
| diff engine semantics                                               | `core/evidence/test/diff.test.ts` (LCS alignment, identity pairing, id canonicalization, noise filters)                                                                   |

Command: `pnpm test:integration` (CI job `integration`).
Open issues: none.

## M3 Gate (north star) — done

Delivered: `@sluice-dev/plugin-gate` (tickets, scenarios + matchers, sha256-bound
human approvals, scenario runner, base-vs-head behavior diff, TS-compiler-API
mutation engine on changed lines, verdict rules, JSON/HTML/Markdown reports,
GitHub check posting; CLI `gate ticket|propose|status|approve|run`; MCP tools
`sluice_gate_status|propose_scenarios|run`), GitHub fake (contract-validated on
GitHub's OpenAPI; permissions; App JWT/installation tokens), `@sluice-dev/github-api`,
`@sluice-dev/mcp` (MCP server), `@sluice-dev/github` ("Sluice Gate" App webhook
server + Action `surfaces/github/action/action.yml` + `app.yml` manifest),
`@sluice-dev/web` (`sluice ui`: tickets, approvals, reports), billing-demo
ticket `CANCEL-1` with 5 scenarios and two agent PR overlays, `pnpm demo`, ADR-0004.

| Exit criterion                                  | Proof                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| north-star demo passes as an automated e2e test | `test/e2e/north-star.itest.ts` (`pnpm test:integration`): human approves 5 scenarios; immediate-cancel PR (passing unit tests) FAILS naming 3 violated scenarios, with behavior diff (response 404→200, `status: canceled`, DB `UPDATE subscriptions … canceled`, egress `DELETE /v1/subscriptions/…`) and mutation proof; correct PR PASSES (5/5, mutation ≥80%); both posted as GitHub checks (fake) + HTML artifacts; PR editing its own approvals rejected |
| one-command demo                                | `pnpm demo` (scripts/demo.mjs) — local run: bad PR ✘ 3/5 violated, mutation 4/10; good PR ✔ 5/5, mutation 10/10                                                                                                                                                                                                                                                                                                                                                |
| GitHub App                                      | `test/e2e/github-app.itest.ts` (signed webhook → installation token → clone → gate → failing check run), `surfaces/github/test/app.test.ts`                                                                                                                                                                                                                                                                                                                    |
| MCP / web UI                                    | `surfaces/mcp/test/mcp.test.ts` (agents propose, cannot approve), `surfaces/web/test/web.test.ts` (approvals, CSRF guard, reports)                                                                                                                                                                                                                                                                                                                             |
| GitHub fake + client                            | `core/github-api/test/github.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                          |

Open issues: first local `pnpm demo` run hung once in the good-PR phase (no
error visible; stderr was suppressed). Fixed visibility (errors always shown) and
added timeouts to every sandbox/evidence fetch; not reproduced since.

## M4 Bench — done

Delivered: `@sluice-dev/plugin-bench` — `sluice bench mine` (SWE-bench-style
fail-to-pass mining, validated in no-network, CPU/memory-capped containers with
host-enforced deadlines; trees streamed via tar, no bind mounts) and
`sluice bench run` (agent-neutral command agents, hidden-test evaluation, cost
from agent report / Claude-Code JSON, JSON + Markdown reports with pass rate,
cost, cost/solved, wall time, per-task matrix). Source data: unmodified
history of `marcbachmann/cel-js` (MIT) vendored as `examples/bench/cel-js.bundle`.
Calibration agents `oracle` and `first-file` (simulated cost). ADR-0005.

| Exit criterion                                   | Proof                                                                                                                                                    |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| mine ≥20 tasks from a public repo's history      | `plugins/bench/test/bench.itest.ts` "mines >= 20 fail-to-pass tasks from cel-js history"                                                                 |
| compare 2 agent configs                          | same file, "compares two agent configs…" (oracle 100%, first-file <100% with non-zero cost)                                                              |
| reproducible report (pass rate, cost, wall time) | same file, "the report is reproducible" (`reproducibleView` identical across runs); `sluice bench run` writes `.sluice/bench/<name>/reports/*.{json,md}` |
| harness units                                    | `plugins/bench/test/bench.test.ts`                                                                                                                       |

Open issue (local only): on the development Mac under heavy load (Spotlight
indexing temp dirs), child processes spawned from test workers — `docker`
_and_ plain `git archive`/`tar` — occasionally stall ~15 minutes, then resume.
Never observed in CI (Linux). Mitigations: integration files run sequentially,
fetch/pg timeouts, container resource caps, host-enforced kill deadlines,
bench test runs without bind mounts. Debug with `SLUICE_TRACE_DOCKER=1` /
`SLUICE_TRACE_BENCH=1`.

## M5 Policy — done

Delivered: `@sluice-dev/policy` — `CredentialBroker` (task-scoped `slc_` tokens,
TTL, scopes, request/write/USD caps, real-credential injection, step-up
approvals, SQLite store), hash-chained `AuditLog`, ast-grep rule engine;
`@sluice-dev/plugin-rules` (comment → candidate rules → proof on bad commit +
clean on main → adoption; `rules propose|from-pr|prove|check`; MCP
`sluice_rules_check`); CLI `sluice policy serve|grant|approvals|approve|deny|audit`;
`changedLines` moved to `@sluice-dev/sandbox`. ADR-0006.

| Exit criterion                         | Proof                                                                                                                                                                                                                                                |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| agent denied out-of-scope GitHub write | `core/policy/test/broker.test.ts` "denies an out-of-scope GitHub write…" (403 `requires github:acme/billing:contents:write`, nothing reaches the GitHub fake, deny audited with task/agent/scope)                                                    |
| credential broker + audit              | same file: TTL/revocation, request/write caps, single-use step-up for merges, Stripe spend cap (402); `core/policy/test/audit.test.ts` (edit/delete/reorder detected); `surfaces/cli/test/policy.test.ts`                                            |
| rule proven on seeded bad commit       | `plugins/rules/test/rules.test.ts` "proves the right candidate on the seeded bad commit…" (flags `stripe.subscriptions.cancel(...)` in the bad PR, clean on main; wrong/noisy candidates rejected) and the CLI flow (bad PR blocked, good PR passes) |

Command: `pnpm test` (these are hermetic unit tests; no Docker needed).

## M6 Coordination — done

Delivered: `@sluice-dev/work` (task/dependency state machine, atomic claims,
decision blocking, event log; SQLite default, Postgres optional),
`@sluice-dev/plugin-leases` (TypeScript language-service symbol index,
all-or-nothing symbol leases from a branch diff, pre-merge `lease check`,
interface-change broadcast to dependents), `@sluice-dev/plugin-inbox` (typed
decisions, dedupe, answer propagation, notifications), CLI
`sluice work|lease|inbox …`, MCP tools, `examples/coord-demo`. ADR-0007.

| Exit criterion                                                               | Proof                                                                                                                                                                                                                                   |
| ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| two simulated agents editing a shared type get a lease conflict before merge | `plugins/leases/test/coordination.test.ts` "agent B editing the same type gets a lease conflict BEFORE merge" (`lease sync` and pre-merge `lease check` exit 1: `src/types.ts#Invoice is leased by agent-a for T-A`; no partial leases) |
| interface-change broadcast                                                   | same file: agent C (lease on `renderReport`, which uses `Invoice`) is notified when A adds `currency`                                                                                                                                   |
| inbox dedupe + propagation                                                   | same file + `plugins/inbox/test/inbox.test.ts` (two agents' question → one decision; typed answer resumes both tasks)                                                                                                                   |
| work state machine, SQLite + Postgres                                        | `core/work/test/queue.test.ts`, `core/work/test/queue-postgres.itest.ts` (same suite on Postgres 16)                                                                                                                                    |

## M7 Campaign — done

Delivered: `@sluice-dev/plugin-campaign` (campaign definitions with mandatory
evidence per step; `copy` / ast-grep `codemod` / `command` apply; tests
evidence against a side-by-side snapshot of all repos; rule-invariant
evidence; per-step commits on `campaign/<id>` branches; automatic rollback on
failure; destructive steps gated and blocked; resumable state;
`sluice campaign run|status|rollback`), `examples/campaign` (shared-money
library + checkout + invoices consumers; formatDollars → formatCents).
Container runner moved to `@sluice-dev/sandbox` (`runInContainer`). ADR-0008.

| Exit criterion                                   | Proof                                                                                                                                                                                                                                                                                |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| e2e test drives a 3-repo migration to completion | `plugins/campaign/test/campaign.itest.ts` "drives the 3-repo migration to completion…" (expand → codemod migrate ×2 → destructive contract; every step's evidence recorded and passing; contract re-tests all 3 repos)                                                               |
| injected failure blocks the destructive step     | same file, "an injected failure rolls the failing step back and blocks the destructive step" (codemod misses the 2-arg form → invoices evidence fails → rolled back to its original sha; contract `blocked`; shared-money keeps formatDollars; fixed campaign resumes to completion) |
| codemod engine                                   | `plugins/campaign/test/codemod.test.ts`                                                                                                                                                                                                                                              |

## M8 Polish — done

Delivered: S3 fake (SigV4-verified, AWS SDK v3 contract tests) completing the
v1 fake set; VitePress docs site (`docs/`: quickstart, concepts, config,
guides for every feature, generated CLI/MCP reference, plugin API, ADRs);
README with the one-command demo; LICENSE (Apache-2.0), NOTICE (third-party
attributions), CONTRIBUTING, SECURITY, CHANGELOG; example READMEs; publishable
package metadata for all 19 `@sluice-dev/*` packages; CI jobs for docs,
packaging and the timed clean-clone demo; tag-triggered release workflow.
ADR-0009.

| Exit criterion                                           | Proof                                                                                                                                                                                                                                                                                                                                                                                           |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| docs site                                                | CI job `docs` (`pnpm docs:build`, dead links fail; generated reference must be committed); `surfaces/cli/test/reference.test.ts`                                                                                                                                                                                                                                                                |
| quickstart < 10 min                                      | CI job `demo` runs `pnpm demo` from a fresh checkout with no prior install and fails if > 600 s (`docs/quickstart.md`); first CI run: **104 s** (install + build + both gate runs)                                                                                                                                                                                                              |
| examples                                                 | `examples/{billing-demo,bench,coord-demo,campaign}` each with README and tests that run them                                                                                                                                                                                                                                                                                                    |
| CONTRIBUTING, license (Apache-2.0 core), security policy | `CONTRIBUTING.md`, `LICENSE`, `NOTICE`, `SECURITY.md`; `test/unit/architecture.test.ts` checks every package is Apache-2.0                                                                                                                                                                                                                                                                      |
| release v0.1.0 to npm as `@sluice-dev/cli`               | tag `v0.1.0`; `.github/workflows/release.yml`; CI job `packaging` (`pnpm pack:smoke`: tarballs install with npm and the `sluice` binary works). **Published**: all 20 `@sluice-dev/*` packages at 0.1.0 on npm (first publish by a maintainer via `npm login`; `npm install @sluice-dev/cli` verified); later tags publish from CI via npm Trusted Publishing (GitHub OIDC, see `RELEASING.md`) |

## M9 Go and .NET parity — done

Delivered: `@sluice-dev/lang`; `determinism: go|dotnet` (ADR-0010); Go/C#
mutation proof with `invalid` mutants; Go/C# symbol leases; Go/C# rules,
review-comment rules and codemods; bench/campaign `prepare` images and
toolchain defaults; `sluice init` toolchain detection; Go and .NET ports of
billing-demo, coord-demo and campaign; `pnpm demo -- --lang go|dotnet`;
[docs/languages.md](docs/languages.md).

| Exit criterion                                  | Proof                                                                                                                                            |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| north-star gate story holds on Go and .NET      | `test/e2e/north-star-go.itest.ts`, `test/e2e/north-star-dotnet.itest.ts` (bad PR fails the same 3/5 scenarios with diff + mutation; good PR 5/5) |
| deterministic Go/.NET sandboxes                 | `core/sandbox/test/go-determinism.itest.ts`, `core/sandbox/test/dotnet-determinism.itest.ts` (frozen/moved clock, seeded replay, events, egress) |
| Go/C# mutation operators compile                | `plugins/gate/test/mutation-languages.test.ts` (go build / dotnet build of every fixture mutant)                                                 |
| Go/C# leases, conflicts, broadcast              | `plugins/leases/test/{go,csharp,mixed}.test.ts`                                                                                                  |
| Go/C# rules from review comments, codemods      | `plugins/rules/test/rules-languages.test.ts`, `core/policy/test/rules-languages.test.ts`, `plugins/campaign/test/codemod.test.ts`                |
| Go/.NET bench mining + campaigns (offline deps) | `plugins/bench/test/toolchains.itest.ts`, `plugins/campaign/test/campaign.itest.ts`                                                              |
| `sluice init` per toolchain                     | `surfaces/cli/test/cli.test.ts`                                                                                                                  |

## Field trials — 2026-11-13

Three third-party services (Node/Prisma, Go/gRPC-gateway, .NET 10/EF Core),
public docs only, published CLI: the gate failed every bad branch for the
right reason and passed every good branch (after fixes). Results, fixes and
open findings: [docs/field-trials.md](docs/field-trials.md). Fixes shipped in
0.2.0 with tests: `core/evidence/test/session.test.ts` (header
interpolation), `surfaces/cli/test/up.itest.ts` ("sluice down" scoping),
`core/sandbox/test/ready-tcp.itest.ts`, `plugins/gate/test/mutation-gate.test.ts`
(unproven changes, survivors listed).

## Browser steps — 2026-11-13

Delivered: `sandbox.browser` (Playwright Chromium in a container on the
sandbox's internal network, lazily started); `browser` script/scenario steps;
per-action evidence (requests, visible text, console, screenshot) with DB
writes/egress/events attributed to the action; `browser` diff channel; gate
`expect` for pages; `sluice timeline`, `record --html/--trace`; timelines in
gate reports; billing-demo portal. ADR-0011, [guide](docs/guide/browser.md).

| Exit criterion                                          | Proof                                                                                  |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| browser runs sealed inside the sandbox                  | `test/e2e/browser.itest.ts` (internal network only; `https://example.com` unreachable) |
| click → requests → DB writes/egress/events per action   | `test/e2e/browser.itest.ts`                                                            |
| deterministic replay with browser steps                 | `test/e2e/browser.itest.ts` (raw diff, no noise filters)                               |
| gate scenarios judge the page (good PR pass, bad fail)  | `test/e2e/browser.itest.ts`                                                            |
| validation, browser diff channel, timeline, version pin | `core/evidence/test/browser.test.ts`, `plugins/gate/test/gate-units.test.ts`           |

# Final acceptance

| Criterion                                                              | Command / proof                                                                                                                                         |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| every milestone's exit criteria pass in CI                             | GitHub Actions `CI` on `main`: jobs `check` (lint, typecheck, build, `pnpm test`), `integration` (`pnpm test:integration`), `docs`, `packaging`, `demo` |
| end-to-end demo from a clean clone with one command                    | `pnpm demo` (CI job `demo`); automated assertion of the same story in `test/e2e/north-star.itest.ts`                                                    |
| tagged v0.1.0, green CI                                                | `git tag v0.1.0`; CI run for the tagged commit                                                                                                          |
| README with 1-command demo                                             | `README.md`                                                                                                                                             |
| PROGRESS.md shows every exit criterion with the command that proves it | this file                                                                                                                                               |
