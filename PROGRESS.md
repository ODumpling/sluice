# PROGRESS

Spec: [docs/GOAL.md](docs/GOAL.md). Each milestone lists exit criteria and the command that proves it.

## Status

| Milestone            | State       |
| -------------------- | ----------- |
| M0 Skeleton          | done        |
| M1 Sandbox + fakes   | not started |
| M2 Evidence + replay | not started |
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
Next: M1 — sandbox + Stripe fake + billing-demo.
