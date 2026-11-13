# Changelog

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
