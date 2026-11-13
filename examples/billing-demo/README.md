# billing-demo

Sample billing service (Node + Postgres + Stripe SDK) used by the north-star demo.

- `src/` — HTTP API: customers, subscriptions, access, `POST /jobs/sync-subscriptions`.
- `sluice.yaml` — sandbox (Postgres + app, Stripe fake, determinism shim) and gate config.
- `.sluice/gate/CANCEL-1/` — ticket "Cancellation takes effect next cycle" and 5 proposed scenarios.
- `prs/` — two agent PRs: `bad-immediate-cancel` and `good-period-end-cancel` (both with passing unit tests).
- `scripts/subscribe-and-renew.yaml` — an evidence script for `sluice record` / `replay`.
- `src/portal.js` + `scripts/portal-cancel.yaml` — a customer portal page and a
  browser script: `sluice record scripts/portal-cancel.yaml --html portal.html`
  shows each click's requests, DB writes, Stripe calls and events.

Run the whole story from the repo root with `pnpm demo`.
