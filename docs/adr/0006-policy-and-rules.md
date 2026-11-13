# ADR-0006: Policy — credential broker, step-up, audit; rules from review comments

- Status: accepted
- Date: 2026-11-13

## Context

Agents need real API access (GitHub, Stripe) to do useful work, but a leaked
or over-broad token turns one bad action into an incident. Separately, review
feedback ("never cancel immediately") is repeated forever unless it becomes an
automated check — and auto-generated checks are only useful if they are
precise.

## Decision

### Credential broker (`@sluice-dev/policy`)

- Agents receive opaque `slc_…` tokens bound to **task, agent, scopes, TTL and
  caps** (requests, writes, USD). Only the SHA-256 of a token is stored
  (SQLite via `node:sqlite`, WAL; `:memory:` in tests).
- The broker is an HTTP proxy (`/github/*`, `/stripe/*`, bare `/v1/*` for
  Stripe SDKs). Every request is mapped to the scope it needs
  (`github:<owner>/<repo>:<perm>:<read|write>`, `stripe:<resource>:<level>`);
  unknown endpoints are denied. Allowed requests get the **real upstream
  credential injected** by the broker; agents never hold it.
- **Spend caps**: for Stripe subscription creation the broker prices the
  request (looks up item prices) _before_ forwarding and refuses (HTTP 402)
  if the cap would be exceeded.
- **Step-up**: scopes matching `policy.stepUp` patterns (default intent:
  merges) require a per-request human approval (`sluice policy approve`).
  Approvals are single-use and bound to grant + method + path.
- **Audit log**: append-only JSONL, each entry hash-chained to the previous
  (`sluice policy audit` verifies). Grants, every allow/deny with reason and
  scope, step-up requests and decisions are recorded.

### Rule engine + rules plugin

- Rules are ast-grep (tree-sitter) patterns or full rule objects — structural,
  so comments and strings never match. Dependency: `@ast-grep/napi`
  (prebuilt native binaries for macOS/Linux/Windows, actively maintained;
  semgrep would add a Python runtime).
- `plugins/rules`: a review comment yields candidates from its code spans
  (calls generalized to `callee($$$)`), or from the commented line. A
  candidate is adopted only when **proven**: ≥1 finding on lines the bad
  commit changed **and** 0 findings on main. Others are rejected with the
  reason (misses the bad code / noisy on main). Proof provenance is stored in
  the adopted rule. `sluice rules check --base --head` gates PRs; MCP tool
  `sluice_rules_check` lets agents self-check.

## Consequences

- Agents must be pointed at the broker (`GITHUB_API_URL=<broker>/github`,
  Stripe host/port), which every client supports.
- `node:sqlite` is experimental in Node 22 (prints a warning) but avoids a
  native SQLite dependency; the store sits behind the broker class.
