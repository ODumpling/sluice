# ADR-0001: Architecture — monorepo, fixed interfaces, plugin boundary

- Status: accepted
- Date: 2026-11-12

## Context

Sluice must make AI-written changes cheap to trust while staying agent-neutral
(Claude Code, Codex, Cursor, … plug in over CLI + MCP). The feature set (sandbox,
fakes, evidence, policy, work coordination, gate, bench, rules, leases,
campaigns, inbox) is large; internals will be rewritten as we learn, so the
interfaces between parts must be fixed early and the internals swappable.

## Decision

1. **Monorepo, TypeScript on Node 22, pnpm workspaces.** Three package groups:
   - `core/*` — reusable engines: `plugin-api`, `config`, `sandbox`, `fakes`,
     `evidence`, `policy`, `work`.
   - `plugins/*` — features built on core: `gate`, `bench`, `rules`, `leases`,
     `campaign`, `inbox` (+ `hello`, the reference plugin).
   - `surfaces/*` — entry points: `cli` (binary `sluice`), `mcp`, `github`
     (Action + "Sluice Gate" App), `web` (minimal reports/approvals UI).
2. **Dependency direction is one-way:** surfaces → plugins → core. **Core never
   imports plugins or surfaces.** Enforced three ways: an ESLint
   `no-restricted-imports` rule on `core/**`, a structural test
   (`test/unit/architecture.test.ts`) over package manifests and sources, and
   code review.
3. **Plugin API (`@sluice-dev/plugin-api`) is the only contract between hosts and
   plugins.** It is semver-versioned (`PLUGIN_API_VERSION`); plugins declare a
   compatible range (`apiVersion: "^1.0.0"`). A plugin contributes CLI
   `commands` (by path, e.g. `["gate","run"]`), MCP `tools` (JSON-Schema input),
   an optional `activate()` hook, and may `provide`/`get` named services through
   the host's service registry. The same plugin objects back every surface:
   the CLI maps commands to subcommands, the MCP server maps tools to MCP tools.
   Core CLI commands (`init`, `up`, `replay`, `diff`) are themselves registered
   through the plugin API by the CLI's built-in core plugin.
4. **Package entry points** export `src/*.ts` under the custom condition
   `@sluice-dev/source` (used by tests and `tsc --noEmit`) and `dist/*.js`
   otherwise (used at runtime and when published). No build is needed to test;
   `pnpm build` (tsc, topological) is needed to run the binary.
5. **Sandboxes are Docker containers** driven through the `docker` CLI. The app
   under test runs on an `internal` Docker network (no route out); a small
   gateway container bridges only the ports Sluice chooses (ingress to the app,
   DB access for evidence, and egress to Sluice-hosted fakes). Details in
   ADR-0002.
6. **Tests are hermetic.** `pnpm test` (unit project) needs no Docker;
   `pnpm test:integration` needs Docker. Both install a socket-level guard
   (`test/setup/no-egress.ts`) that throws on any non-loopback connection, so no
   test can make a real third-party network call.

## Dependencies (justification)

| Dependency                           | Where  | Why                                                             |
| ------------------------------------ | ------ | --------------------------------------------------------------- |
| typescript 6.0                       | dev    | language; 6.0 is the newest line supported by typescript-eslint |
| vitest                               | dev    | fast TS-native test runner with workspace "projects"            |
| eslint + typescript-eslint, prettier | dev    | standard lint/format                                            |
| commander                            | cli    | most widely used Node CLI parser; stable, zero deps             |
| yaml                                 | config | maintained YAML 1.2 parser with good errors                     |
| zod                                  | config | schema validation with inferred TS types for `sluice.yaml`      |

Later ADRs justify further dependencies when they are introduced.

## Consequences

- Plugins can be developed out-of-tree and loaded via `plugins:` in
  `sluice.yaml`; incompatible plugins fail at startup with a clear error.
- Core packages stay usable as libraries (e.g. embedding the evidence engine in
  another tool) without pulling in the CLI.
- Two module-resolution modes (source vs dist) must stay in sync; the build
  `tsconfig.build.json` files disable the source condition.
