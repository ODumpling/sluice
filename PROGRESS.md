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

Open issues: GitHub and S3 fakes are planned for M3/M5 (GitHub, needed for checks and policy) and M8 (S3).

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
