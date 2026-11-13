<img src="assets/icon.svg" width="64" height="64" alt="">

# Sluice

**Nothing merges until the checks open the gate.**

Sluice is an open-source, agent-neutral platform that makes AI-written code
changes cheap to trust. Agents (Claude Code, Codex, Cursor, scripts) plug in
via the CLI and MCP. Sluice runs their changes in sealed sandboxes, records
behavioral evidence, enforces policy, and coordinates multi-agent work.

## One-command demo

```sh
git clone https://github.com/ODumpling/sluice && cd sluice
pnpm demo            # needs Node >= 22.13, pnpm 10, Docker
pnpm demo -- --lang go       # same story on a Go service
pnpm demo -- --lang dotnet   # same story on an ASP.NET Core (C#) service
```

**Languages:** TypeScript/JavaScript, Go and C#/.NET are supported out of the
box across the gate (mutation proof), deterministic sandboxes, symbol leases,
structural rules, codemods, bench and campaigns — no language toolchain needed
on the host (see [Languages](docs/languages.md)).

On a bundled app (**billing-demo**: Node + Postgres + fake Stripe; ports in
[Go](examples/billing-demo-go) and [.NET](examples/billing-demo-dotnet)):

1. a human approves 5 acceptance scenarios for ticket _"cancellation takes
   effect next cycle"_;
2. an agent PR **cancels immediately** — and ships passing unit tests;
3. `sluice gate run` **fails** it, naming the violated scenarios, showing a
   behavior diff vs base (API response, DB writes, Stripe calls) and a
   mutation proof that the checks catch deliberately broken code;
4. a correct PR **passes**; both verdicts are posted as GitHub checks (to a
   contract-validated GitHub fake) and HTML reports.

```
✘ Sluice Gate failed: 3/5 approved scenarios violated, mutation 4/10
  FAIL cancel-keeps-subscription-active
       step 3 (POST /subscriptions/${sub}/cancel): body.status expected "active", got "canceled"
  FAIL stripe-cancels-at-period-end
       step 4: expected no egress matching {"fake":"stripe","method":"DELETE"}, but the app called stripe DELETE /v1/subscriptions/sub_…
  unit tests (npm test --silent): pass
✔ Sluice Gate passed: 5/5 approved scenarios hold, mutation 10/10
```

## What's in the box

| Area         | CLI                                                         |                                                                                       |
| ------------ | ----------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Sandbox      | `sluice up`, `sluice down`                                  | Docker services on an internal network; egress only to Sluice-hosted fakes            |
| Fakes        | —                                                           | Stripe, GitHub (OpenAPI contract-validated), S3 (SigV4-verified); drift detection     |
| Evidence     | `sluice record`, `replay`, `diff`                           | HTTP, egress, SQL writes, events; deterministic replay; noise-filtered diffs          |
| Gate         | `sluice gate ticket\|propose\|status\|approve\|run`         | approved scenarios → black-box checks → behavior diff → mutation proof → GitHub check |
| Bench        | `sluice bench mine\|run`                                    | mine history into fail-to-pass tasks; compare agents on pass rate, cost, time         |
| Policy       | `sluice policy serve\|grant\|approvals\|approve\|audit`     | task-scoped credential broker, step-up approval, tamper-evident audit                 |
| Rules        | `sluice rules propose\|prove\|check\|from-pr`               | review comment → proven structural rule                                               |
| Coordination | `sluice work …`, `lease …`, `inbox …`                       | work queue, symbol leases, interface-change broadcast, decision inbox                 |
| Campaigns    | `sluice campaign run\|status\|rollback`                     | evidence-gated multi-repo migrations with rollback                                    |
| Surfaces     | `sluice ui`, `sluice-mcp`, GitHub Action, "Sluice Gate" App |                                                                                       |

Docs: [`docs/`](docs/index.md) (`pnpm docs:dev`) — start with the
[quickstart](docs/quickstart.md), then [concepts](docs/concepts.md),
[`sluice.yaml`](docs/config.md), the [CLI reference](docs/reference/cli.md)
and the [plugin API](docs/plugin-api.md). Design decisions live in
[`docs/adr/`](docs/adr); status and evidence for every milestone in
[PROGRESS.md](PROGRESS.md).

## Development

```sh
pnpm install && pnpm build
pnpm test                 # unit (hermetic, no Docker)
pnpm test:integration     # Docker: sandboxes, Postgres, north-star e2e, bench, campaigns
pnpm lint && pnpm typecheck
```

See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md).

## License

Apache-2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE).
