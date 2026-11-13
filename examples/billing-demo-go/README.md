# billing-demo-go

The Go port of [billing-demo](../billing-demo) (Go 1.27 `net/http` + Postgres via
pgx + Stripe over raw HTTP) used by the north-star demo. It has the same HTTP
API, JSON shapes, schema, Stripe calls and domain events, so the **same**
ticket, scenarios and PRs give the same verdicts as the Node app.

- `src/` — package `billing`: HTTP API (customers, subscriptions, access,
  `POST /jobs/sync-subscriptions`), Postgres, Stripe client, events.
  `main.go` only calls `billing.Main()`.
- `test/` — `go test` unit tests (fake DB and Stripe).
- `sluice.yaml` — sandbox (Postgres + app, Stripe fake, `determinism: go`) and
  gate config (`go test ./test/` offline, mutation on the changed lines).
- `Dockerfile` — modules and the build cache are baked in; the container
  compiles the mounted read-only `src/` at start (`go build`, ~0.6 s per reset
  with the determinism overlay; its stdlib rebuild is cached in a volume).
- `.sluice/gate/CANCEL-1/` — ticket "Cancellation takes effect next cycle" and
  5 proposed scenarios (identical to the Node example).
- `prs/` — two agent PRs: `bad-immediate-cancel` and `good-period-end-cancel`
  (both with passing unit tests).
- `scripts/subscribe-and-renew.yaml` — an evidence script for `sluice record` / `replay`.

Run the whole story from the repo root with `pnpm demo -- --lang go`.
