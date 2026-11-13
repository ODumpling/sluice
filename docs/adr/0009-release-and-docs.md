# ADR-0009: Docs, packaging and release

- Status: accepted
- Date: 2026-11-13

## Decision

- **Docs site**: VitePress (dev dependency) over `docs/`; it fails the build on
  dead links. `docs/reference/cli.md` is generated from the plugin registry
  (`pnpm docs:gen`); a unit test and a CI step fail if it is stale.
- **Packages**: every `core/*`, `plugins/*`, `surfaces/*` package is published
  as `@sluice-dev/<name>` (the CLI as `@sluice-dev/cli`, binary `sluice`).
  pnpm rewrites `workspace:*` to exact versions on publish. CI packs all
  packages and installs the tarballs with plain npm into an empty project,
  then runs the installed binary (`pnpm pack:smoke`).
- **Quickstart budget**: CI runs `pnpm demo` from a fresh checkout without a
  prior install/build and fails if it takes more than 10 minutes.
- **Release**: pushing a `v*` tag runs lint/typecheck/build/tests, checks the
  tag matches every package version, publishes to npm with provenance when the
  `NPM_TOKEN` secret is present, and creates a GitHub release from
  `CHANGELOG.md`.
- **S3 fake contract**: AWS publishes Smithy models, not OpenAPI, so the S3
  fake's contract tests use the official `@aws-sdk/client-s3` (dev
  dependency) and the fake verifies SigV4 signatures itself.

## Consequences

- Publishing requires an npm token with rights to the `@sluice-dev` scope —
  a credential only the maintainers hold.
