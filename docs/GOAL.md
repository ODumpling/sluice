# GOAL
Build **Sluice**: an open-source, agent-neutral platform that makes AI-written code
changes cheap to trust. Agents (Claude Code, Codex, Cursor, etc.) plug in via CLI + MCP.
Sluice executes changes in sandboxes, records behavioral evidence, enforces policy, and
coordinates multi-agent work. Tagline: "Nothing merges until the checks open the gate."

Naming: CLI binary `sluice`; npm scope `@sluice-dev/*` (bare `sluice` npm name is taken);
config file `sluice.yaml`; GitHub App "Sluice Gate".

Done = every milestone's exit criteria pass in CI, and the end-to-end demo (below) runs
from a clean clone with one command (`pnpm demo`).

# NORTH-STAR DEMO (final acceptance test)
On a bundled sample app ("billing-demo": Node + Postgres + fake Stripe):
1. A human approves 5 acceptance scenarios for ticket "cancellation takes effect next cycle".
2. An agent submits a PR that wrongly cancels immediately (but includes passing unit tests).
3. `sluice gate run` FAILS the PR, showing the violated scenario, a behavior diff
   (API response + DB writes vs. base), and proof the checks catch deliberately broken
   versions of the code.
4. A correct PR PASSES. Report is posted as a GitHub check + HTML artifact.

# ARCHITECTURE (fixed interfaces, swappable internals)
Monorepo, TypeScript (Node 22), pnpm workspaces, Docker for sandboxes.
- core/sandbox    : spin up app + deps in containers from a `sluice.yaml` env spec
- core/fakes      : stateful, contract-validated fakes (Stripe, GitHub, S3 for v1),
                    generated from OpenAPI + recorded traffic; drift detection
- core/evidence   : record HTTP req/resp, SQL writes, emitted events; deterministic
                    replay (frozen clock, seeded RNG, fakes for all egress); diff engine
                    with noise filtering
- core/policy     : task-scoped credential broker (short TTL, scopes, spend caps),
                    step-up approval, audit log; rule engine (semgrep/ast-grep)
- core/work       : task/dependency state machine, persisted (SQLite default, Postgres opt)
- plugins/gate    : spec -> scenarios -> human approval -> black-box checks -> mutation test
- plugins/bench   : mine merged PRs into eval tasks; compare agent configs on pass/cost/time
- plugins/rules   : review comment -> proposed rule -> proven on bad commit + clean on main
- plugins/leases  : symbol-level leases via LSP index; interface-change broadcast
- plugins/campaign: multi-repo migration state machine with evidence-gated steps
- plugins/inbox   : typed decision requests, dedupe, propagate answers to affected tasks
- surfaces        : `sluice` CLI, MCP server, GitHub App/Action, minimal web UI
                    (reports, approvals)
Plugin API is documented and versioned; core never imports plugins.

CLI shape: `sluice init | up | replay | diff | gate run | bench | rules | lease | campaign | inbox`

# MILESTONES (in order; do not start N+1 until N's exit criteria pass)
M0 Skeleton: repo, CI, lint, typecheck, test harness, plugin API, ADR-0001 architecture.
   Exit: `pnpm test` green in CI; plugin API has a working "hello" plugin; `sluice --help` works.
M1 Sandbox + fakes: billing-demo boots via `sluice up`; Stripe fake stateful + contract-checked.
   Exit: integration tests show billing-demo full flow against fake with zero real egress.
M2 Evidence + replay: record a session, replay against two builds, diff deterministically.
   Exit: same build replayed 10x -> zero diff; seeded behavior change -> exactly that diff.
M3 Gate (north star): scenarios, approval, black-box checks, mutation proof, GH check.
   Exit: north-star demo passes as an automated e2e test.
M4 Bench: mine >=20 tasks from a public repo's history; compare 2 agent configs.
   Exit: reproducible report (pass rate, cost, wall time) from `sluice bench`.
M5 Policy: credential broker + audit; rules plugin.
   Exit: agent denied out-of-scope GitHub write; rule proven on seeded bad commit.
M6 Coordination: work state machine, leases, inbox.
   Exit: two simulated agents editing a shared type get a lease conflict before merge.
M7 Campaign: 3-repo migration with evidence-gated steps and rollback.
   Exit: e2e test drives migration to completion; injected failure blocks destructive step.
M8 Polish: docs site, quickstart <10 min, examples, CONTRIBUTING, license (Apache-2.0
   core), security policy, release v0.1.0 to npm as `@sluice-dev/cli`.

# WORKING RULES
- Test-first. Every feature ships with tests; exit criteria are automated, not eyeballed.
- No stubs, TODO-returns, or mocked-out core logic presented as done. If something is
  genuinely blocked, record it in PROGRESS.md and move to the next unblocked item.
- Keep PROGRESS.md updated after each milestone: done, evidence (test names/commands),
  open issues, next step. Record significant decisions as ADRs in docs/adr/.
- Commit per coherent step with clear messages; never commit secrets; no real
  third-party network calls in tests.
- Prefer boring, well-maintained deps; justify any new dependency in the ADR.
- Re-run the full suite before declaring any milestone done.
- Ask the human only for: credentials, license/naming decisions, or scope changes.

# NON-GOALS (v0.1)
Languages beyond Node/TS sample apps, non-Postgres DBs, clouds beyond GitHub + one
fake cloud API, a hosted SaaS offering, billing/accounts, a polished UI.

# FINAL DELIVERABLE
Tagged v0.1.0, green CI, README with 1-command demo, PROGRESS.md showing every exit
criterion with the command that proves it.
