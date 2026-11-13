# ADR-0007: Coordination — work queue, symbol leases, inbox

- Status: accepted
- Date: 2026-11-13

## Context

Several agents working on one codebase collide in ways git can't see until
too late: two agents change the same type differently (semantic conflicts),
one agent changes an interface another depends on, and agents ask humans the
same question repeatedly — or guess.

## Decision

- **`@sluice-dev/work`**: a validated task state machine
  (`pending → ready → claimed → in_progress → review → done`, plus `blocked`,
  `failed`, `canceled`) with dependencies (dependents are promoted to `ready`
  when the last dependency is `done`), atomic claims, decision blocking and an
  event log. Storage behind a tiny async `Db` adapter: **SQLite by default**
  (`node:sqlite`, file `.sluice/state/work.db`) and **Postgres optionally**
  (`work.url: postgres://…`, SERIALIZABLE transactions with retry). The same
  behavioural test suite runs against both.
- **`plugins/leases`**: a symbol index built on the **TypeScript language
  service** (the engine behind tsserver/typescript-language-server; it handles
  JS via `allowJs`). Top-level declarations get ids `path#Name`, a normalized
  public signature, and semantic references (imports, type positions).
  `lease sync` maps a branch's diff to touched symbols and leases them for
  (agent, task) **all-or-nothing**; a symbol leased by another task is a
  **conflict before merge** (`lease check` is the CI/gate step). When a change
  alters an exported signature, agents holding leases on **dependent** symbols
  get an `interface_changed` notification through the inbox service.
  (We use the language service in-process rather than speaking LSP to a
  server: same index, no subprocess management.)
- **`plugins/inbox`**: typed decision requests (`choice`, `confirm`, `text`)
  that block the asking task; **dedupe** by explicit key or normalized
  kind+question+options, accumulating every affected task; a typed human
  answer is validated and **propagated** to all affected tasks (stored in
  `task.data.decisions`). Also one-way notifications. Exposed to agents as MCP
  tools (`sluice_inbox_ask`, `sluice_inbox_check`, `sluice_work_claim`,
  `sluice_work_update`, `sluice_lease_sync`); answering is human-only.
- Plugins talk through the service registry (`inbox` service), not imports.

## Consequences

- Leases are advisory at edit time and enforced at merge time (`lease check`).
- Only TS/JS symbols in v0.1.
