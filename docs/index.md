# Sluice

**Nothing merges until the checks open the gate.**

Sluice is an open-source, agent-neutral platform that makes AI-written code
changes cheap to trust. Agents — Claude Code, Codex, Cursor or a script —
plug in over the CLI and MCP. Sluice runs their changes in sealed sandboxes,
records what the code actually _does_, judges it against acceptance scenarios
a human approved before the code existed, proves those checks have teeth, and
coordinates many agents working at once.

```sh
git clone https://github.com/ODumpling/sluice && cd sluice
pnpm demo        # Node ≥ 22.13, pnpm, Docker
```

The demo: a human approves 5 scenarios for "cancellation takes effect next
cycle"; an agent PR that cancels _immediately_ (with green unit tests) is
**failed** with the violated scenarios, a behavior diff against base (API
response, DB writes, Stripe calls) and a mutation proof; a correct PR
**passes**; both land as GitHub checks and HTML reports.

## What's inside

|                                      |                                                                                                                           |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| [Sandbox & fakes](/guide/sandbox)    | Docker sandboxes with no route to the internet; stateful, contract-validated Stripe, GitHub and S3 fakes; drift detection |
| [Evidence & replay](/guide/evidence) | Record HTTP, egress, SQL writes and events; deterministic replay; noise-filtered behavior diffs                           |
| [Gate](/guide/gate)                  | Spec → scenarios → human approval → black-box checks → mutation proof → GitHub check                                      |
| [Bench](/guide/bench)                | Mine your history into eval tasks; compare agent configs on pass rate, cost, time                                         |
| [Policy & rules](/guide/policy)      | Task-scoped credentials with TTLs, scopes, spend caps, step-up approval, audit log; review comments → proven rules        |
| [Coordination](/guide/coordination)  | Work queue, symbol-level leases, interface-change broadcast, decision inbox                                               |
| [Campaigns](/guide/campaigns)        | Multi-repo migrations with evidence-gated steps and rollback                                                              |

Start with the [quickstart](/quickstart).
