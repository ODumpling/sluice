# ADR-0003: Evidence, deterministic replay and behavior diffs

- Status: accepted
- Date: 2026-11-13

## Context

"Trust" in a change should come from observed behavior, not from reading the
diff. We need to record what an app _does_ (responses, calls to third parties,
DB writes, emitted events), replay the same inputs against another build, and
show only the differences that matter.

## Decision

- **Inputs are scripts** (`http`, `advance`, `clock` steps, with `save` +
  `${var}` capture). A **session** is a script plus, per step: the ingress
  exchange, egress calls (from the fake journals), row-level DB writes and
  domain events; and final fake + DB state (`sluice-session/1` JSON).
- **DB writes** are captured by an audit trigger installed through an _event
  trigger_ (`ddl_command_end`, `CREATE TABLE`) in the empty database before it
  is templated, so tables the app creates during its own migrations are covered
  without app changes.
- **Events** are JSON stdout lines with an `event` key; the determinism shim
  captures them synchronously (before the app responds), so attribution to steps
  is race-free.
- **Determinism**: every run starts from `Sandbox.reset()` — fresh containers,
  DB from template, fakes reset with the same seed, clock at the same instant;
  the shim freezes `Date` and seeds randomness inside the app.
- **Diff engine**: normalize → canonicalize generated ids by first appearance
  (configurable regexes; default Stripe-style `xx_XXXXXXXXXXXXXX`) → strip noise
  paths (`evidence.ignore` globs with `*`/`**`, rooted at `response`, `egress`,
  `db`, `events`, `final`) → structural diff. Record lists are aligned with LCS;
  unmatched neighbours with the same identity (table+op+id, fake+method+path,
  event name) are diffed field-by-field so one changed write is one entry.
- Builds are source trees: working tree, `--source <dir>` or `--ref <git-ref>`
  (temporary `git worktree`).

## Consequences

- Replays are exact: the M2 test replays 10× with _no_ noise filters and
  compares serialized steps byte-for-byte.
- Apps that read the DB clock (`now()`) or wall time outside Node would need
  noise filters; documented in docs/config.md.
- Public tables are keyed by bare name (`customers`), others `schema:table`, so
  glob paths never contain dots inside a segment.
