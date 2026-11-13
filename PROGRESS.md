# PROGRESS

Spec: [docs/GOAL.md](docs/GOAL.md). Each milestone lists exit criteria and the command that proves it.

## Status

| Milestone            | State       |
| -------------------- | ----------- |
| M0 Skeleton          | done        |
| M1 Sandbox + fakes   | not started |
| M2 Evidence + replay | done        |
| M3 Gate              | not started |
| M4 Bench             | not started |
| M5 Policy            | not started |
| M6 Coordination      | not started |
| M7 Campaign          | not started |
| M8 Polish            | not started |

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
