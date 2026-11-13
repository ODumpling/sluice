# billing-demo-dotnet

The .NET port of [billing-demo](../billing-demo) (.NET 10 ASP.NET Core minimal
API + Postgres via Npgsql + Stripe over `HttpClient`) used by the north-star
demo. It has the same HTTP API, JSON shapes, schema, Stripe calls and domain
events, so the **same** ticket, scenarios and PRs give the same verdicts as the
Node app.

- `src/` — HTTP API (customers, subscriptions, access,
  `POST /jobs/sync-subscriptions`), Postgres, Stripe client, events.
- `test/` — xunit unit tests (fake DB and Stripe), project `BillingDemo.Tests.csproj`.
- `sluice.yaml` — sandbox (Postgres + app, Stripe fake, `determinism: dotnet`)
  and gate config (`dotnet test` offline, mutation on the changed lines).
- `Dockerfile`, `docker/` — packages are restored and the project is built
  once in the image; `docker/warm.sh` records the exact `csc` invocation, and
  at container start `docker/start.sh` compiles the mounted read-only `src/`
  with one `csc` call into `/app/artifacts` (no MSBuild; ~1.8 s per reset).
  `Directory.Build.props` keeps all build output in `artifacts/`.
- `.sluice/gate/CANCEL-1/` — ticket "Cancellation takes effect next cycle" and
  5 proposed scenarios (identical to the Node example).
- `prs/` — two agent PRs: `bad-immediate-cancel` and `good-period-end-cancel`
  (both with passing unit tests).
- `scripts/subscribe-and-renew.yaml` — an evidence script for `sluice record` / `replay`.

Locally: `dotnet run --project BillingDemo.csproj`, `dotnet test BillingDemo.Tests.csproj`.
Run the whole story from the repo root with `pnpm demo -- --lang dotnet`.
