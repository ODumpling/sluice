# Gate

The gate judges a change by behaviour against acceptance scenarios a human
approved **before** the code was written.

## 1. Ticket and scenarios

```
.sluice/gate/CANCEL-1/
  ticket.yaml              id, title, spec
  scenarios/<id>.yaml      black-box checks
  approvals.json           approvals bound to scenario sha256
```

```yaml
# scenarios/cancel-keeps-subscription-active.yaml
id: cancel-keeps-subscription-active
title: Cancelling schedules the end at the current period end
steps:
  - http: { method: POST, path: /customers, body: { email: ada@example.com } }
    save: { cust: body.id }
  - http: { method: POST, path: /subscriptions, body: { customer_id: '${cust}' } }
    save: { sub: body.id, period_end: body.current_period_end }
  - http: { method: POST, path: '/subscriptions/${sub}/cancel' }
    expect: { status: 200, body: { status: active, cancel_at: '${period_end}' } }
  - advance: 32d
  - assert: { egress: { none: { fake: stripe, method: DELETE } } }
  - assert: { fake: stripe, path: subscriptions, matches: [{ cancel_at_period_end: true }] }
  - assert: { sql: SELECT status FROM subscriptions WHERE id = $1, params: ['${sub}'], rows: [{ status: active }] }
  - assert: { events: { some: { event: subscription.cancel_scheduled } } }
```

Matching is partial for objects, exact-length for arrays, with operators
`$exists $ne $in $regex $gt $gte $lt $lte $contains $len $any`. Equal instants
match across ISO spellings.

## 2. Propose (agents) and approve (humans)

```sh
sluice gate ticket CANCEL-1 --title "Cancellation takes effect next cycle" --spec-file spec.md
sluice gate propose CANCEL-1 drafts/*.yaml                # or --command "<any LLM CLI>"
sluice gate status CANCEL-1
sluice gate approve CANCEL-1 --as po@acme.test            # or in `sluice ui`
```

Agents propose over MCP (`sluice_gate_propose_scenarios`) but **cannot
approve** — approval is not exposed as a tool. Editing an approved scenario
makes its approval _stale_.

## 3. Run

```sh
sluice gate run --ticket CANCEL-1 --base origin/main --head HEAD [--github-check --repo owner/name]
```

The gate:

1. reads ticket, scenarios, approvals and `sluice.yaml` **from base** and fails
   if the change touches `.sluice/gate/**`;
2. runs every approved scenario against head in a fresh sandbox;
3. runs them against base and shows the **behavior diff** (responses, egress,
   DB writes, events, final state);
4. generates up to `maxMutants` **mutants of the changed lines** (operators,
   literals, negations, removed calls, return values) and reruns the scenarios
   — a mutant is _caught_ if any scenario's outcome changes;
5. fails if a scenario fails, a scenario is unapproved/stale, or — when all
   pass — fewer than `threshold` of the mutants are caught;
6. writes `.sluice/reports/gate-<ticket>-<sha>.{html,json}` and optionally a
   GitHub check run.

Optionally `pluginConfig.gate.unitTests` runs the PR's own unit tests in the
app image with no network, shown for contrast.
