# Quickstart (under 10 minutes)

You need **Node ≥ 22.13**, **pnpm 10** and a running **Docker** daemon.
CI runs this exact quickstart from a clean clone and fails if it takes longer
than 10 minutes.

## 1. Run the demo (≈3 min, one command)

```sh
git clone https://github.com/ODumpling/sluice && cd sluice
pnpm demo
```

`pnpm demo` installs and builds if needed, then:

1. creates a git repo with **billing-demo** (Node + Postgres + Stripe SDK) and
   ticket `CANCEL-1` with 5 proposed acceptance scenarios;
2. approves them as a human (`sluice gate approve CANCEL-1 --as …`);
3. opens two agent PR branches — one cancels immediately, one at period end —
   both with passing unit tests;
4. runs `sluice gate run` on each and posts GitHub check runs (to the bundled
   GitHub fake — no network).

Expected: `✘ … 3/5 approved scenarios violated` for the first PR,
`✔ … 5/5 approved scenarios hold` for the second. Open the HTML reports it
prints.

## 2. Try the pieces on billing-demo (≈5 min)

```sh
pnpm build && alias sluice="node $PWD/surfaces/cli/bin/sluice.js"
cd examples/billing-demo

sluice up --exec 'curl -s $SLUICE_INGRESS_URL/health'       # sealed sandbox
sluice record scripts/subscribe-and-renew.yaml               # record behavior
sluice replay .sluice/sessions/subscribe-and-renew.json -n 3 # deterministic: no diff
sluice gate status CANCEL-1                                  # scenarios + approvals
sluice ui                                                    # reports & approvals UI
```

## 3. Use it on your project

```sh
cd your-service
sluice init                      # writes sluice.yaml
```

Describe your services and fakes in [`sluice.yaml`](/config), write a ticket
and scenarios (or let an agent propose them over MCP), approve them, and run
`sluice gate run --ticket <ID> --base origin/main --head HEAD` in CI — or add
the [GitHub Action](/guide/github).

Connect your agent with the [MCP server](/guide/agents).
