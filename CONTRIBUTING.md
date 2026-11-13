# Contributing to Sluice

Thanks for helping make AI-written changes cheap to trust.

## Setup

```sh
pnpm install          # Node >= 22.13, pnpm 10
pnpm build
pnpm test             # unit tests (no Docker)
pnpm test:integration # Docker required: sandboxes, Postgres, gate e2e
pnpm lint && pnpm typecheck
pnpm docs:dev         # docs site
```

## Ground rules

- **Test-first.** Every feature ships with tests; behaviour claims in docs
  should be backed by a test. Exit criteria are automated, never eyeballed.
- **No stubs presented as done.** If something is blocked, say so in
  `PROGRESS.md` / the PR.
- **Hermetic tests.** No real third-party network calls — the test setup
  (`test/setup/no-egress.ts`) throws on any non-loopback connection. Use the
  fakes.
- **Architecture.** `core/*` never imports `plugins/*` or `surfaces/*`
  (lint rule + `test/unit/architecture.test.ts`). New capabilities are plugins
  using the [plugin API](docs/plugin-api.md).
- **Dependencies.** Prefer boring, well-maintained packages and justify new
  ones in an ADR (`docs/adr/`). Significant decisions get an ADR.
- **Docs.** `docs/reference/cli.md` is generated — run `pnpm docs:gen` after
  changing commands or tools (a test checks it is current).

## Pull requests

Keep PRs focused, describe the behaviour change and how it is tested, and make
sure CI (lint, typecheck, unit, integration, docs, packaging) is green. By
contributing you agree that your contributions are licensed under the
Apache License 2.0.
