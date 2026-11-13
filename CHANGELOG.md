# Changelog

## Unreleased

- **Browser steps** ([guide](docs/guide/browser.md), ADR-0011): `sandbox.browser`
  runs Playwright Chromium inside the sandbox; scripts and gate scenarios
  drive the frontend with `browser: { goto | click | fill | press | select |
check | uncheck | waitFor }`. Each action records the page's requests,
  visible text, console errors and a screenshot, and the DB writes, egress
  and events it caused. Diffs gain a `browser` channel; gate scenarios gain
  `expect: { text, visible, hidden, url, title, noErrors }`.
- **Timeline**: `sluice timeline <session>` and `sluice record --html` render
  a session as action → requests → data changes; gate reports embed it per
  scenario. `sluice record|replay --trace` writes a Playwright trace.
- **Sandbox**: every service is also reachable as `<name>.sluice.internal`.
- **billing-demo**: a customer portal (`/portal/:id`) and
  `scripts/portal-cancel.yaml`.

## 0.2.0 — 2026-11-13

Fixes from the first [field trials](docs/field-trials.md) on three
third-party services (Node, Go, .NET):

- **Evidence/gate**: `${var}` interpolation in request `headers`, so a token
  saved from a login can authenticate later steps.
- **CLI**: `sluice down` removes only the current project's sandboxes;
  `--all` removes every project's.
- **Sandbox**: `ready: { tcp }` waits for the service itself (it probed the
  gateway port, which always accepts).
- **Gate**: changed source lines that yield no mutants fail as unproven
  (`mutation.allowNoMutants: true` to accept); surviving mutants are listed in
  the CLI output.
- **Docs**: the database clock is not frozen; concurrent .NET `Guid` draws need
  `SLUICE_DOTNET_WORKERS: '1'`; authenticated script example.

The npm 0.1.0 packages already contained the Go/.NET work below; the `v0.1.0`
git tag predates it. 0.2.0 is the first release whose tag matches npm.

Go and C#/.NET get the same out-of-the-box support as TypeScript/JavaScript
([docs/languages.md](docs/languages.md)):

- **Languages**: new `@sluice-dev/lang` (tree-sitter Go/C# grammars, toolchain
  detection, dependency-manifest detection).
- **Sandbox**: `determinism: go` (stdlib overlay: frozen clock, seeded
  `math/rand`/`crypto/rand`, event capture, control server) and
  `determinism: dotnet` (`LD_PRELOAD` shim + init). ADR-0010.
- **Gate**: Go/C# mutation operators; mutants that fail to compile are
  reported `invalid` and excluded from the score.
- **Coordination**: Go and C# symbol leases and interface-change broadcast.
- **Rules/campaigns**: `language: go|csharp` rules, review-comment proposals
  and codemods.
- **Bench/campaigns**: offline dependency `prepare` images; toolchain-based
  defaults for image, tests and source.
- **CLI**: `sluice init` detects Node/Go/.NET (`--lang`); `pnpm demo -- --lang go|dotnet`.
- **Examples**: `billing-demo-go`, `billing-demo-dotnet`, `coord-demo-go`,
  `coord-demo-dotnet`, `campaign-go`, `campaign-dotnet`, Go/.NET bench bundles.
- Fix: fakes' request journal snapshots responses (behavior diffs no longer
  show later state changes of the same object).

## 0.1.0 — 2026-11-13

First release. Nothing merges until the checks open the gate.

- **Gate**: tickets, human-approved acceptance scenarios bound to content
  hashes, black-box checks against a sealed sandbox, behavior diff vs base,
  mutation proof on changed lines, HTML/JSON reports, GitHub check runs,
  GitHub Action and "Sluice Gate" GitHub App.
- **Sandbox**: Docker services on an internal network with a forwarding
  gateway; determinism shim (frozen clock, seeded RNG, event capture);
  fast database reset; source swapping for base/PR/mutant builds.
- **Fakes**: stateful Stripe and GitHub fakes validated against their OpenAPI
  contracts; S3 fake with SigV4 verification; spec/traffic/fixture/client
  drift detection; recording proxy.
- **Evidence**: session recording (responses, egress, row-level DB writes,
  events), deterministic replay, LCS-aligned diffs with noise filters.
- **Bench**: fail-to-pass task mining from git history; agent-neutral runs;
  pass rate, cost and wall-time reports.
- **Policy**: task-scoped credential broker (TTL, scopes, request/write/USD
  caps, step-up approvals), hash-chained audit log, ast-grep rule engine;
  review comments → proven rules.
- **Coordination**: work queue (SQLite/Postgres), TypeScript symbol leases
  with pre-merge conflict checks and interface-change broadcast, decision inbox
  with dedupe and propagation.
- **Campaigns**: evidence-gated multi-repo migrations with codemods, rollback
  and destructive-step gating.
- **Surfaces**: `sluice` CLI, MCP server, GitHub App/Action, local web UI.
- Plugin API v1.0.0.
