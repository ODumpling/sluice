# Sandbox & fakes

```sh
sluice up                        # boots services; prints SLUICE_* URLs; Ctrl-C to stop
sluice up --exec './smoke.sh'    # run a command against it, tear down, pass exit code
sluice up --source ../other-checkout
sluice down                      # remove leftovers
```

## Topology

Services join only an `--internal` Docker network (no route off the host).
A gateway container (Node, zero dependencies) is the only bridge: it publishes
ingress/database/control ports on `127.0.0.1` and forwards
`http://sluice-gw:<port>` to fakes running in the Sluice process. Tests prove
`fetch('https://api.stripe.com')` from inside the app fails.

## Determinism

`determinism: node` injects a shim: frozen `Date` (moved with `advance` /
`clock` steps), seeded `Math.random` / `crypto.randomUUID` / `randomBytes` /
`getRandomValues`, and synchronous capture of JSON stdout lines with an
`event` key. `reset()` recreates containers, restores the database from a
template and resets fakes and clock.

## Fakes

| fake     | contract                                               | notes                                                                                                                                                                           |
| -------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `stripe` | Stripe's OpenAPI (`spec3.json`, vendored subset)       | customers, products, prices, subscriptions (renewal and cancellation driven by the clock), invoices, events, idempotency keys, `expand[]`; works with the official `stripe` SDK |
| `github` | GitHub's REST OpenAPI (vendored subset)                | repos, branches, contents, PRs, comments, check runs, App JWT + installation tokens, fine-grained permissions                                                                   |
| `s3`     | official AWS SDK v3 (S3 publishes Smithy, not OpenAPI) | buckets, objects, ranges, copy, ListObjectsV2; **SigV4 signatures verified**                                                                                                    |

Every Stripe/GitHub response is validated strictly against the contract
(missing required fields, wrong types and _undocumented_ fields fail); in
strict mode a violation becomes an HTTP 500 so a drifting fake fails loudly.

### Drift detection

- `detectSpecDrift(current, next)` — a newer spec vs the vendored one, scoped
  to implemented operations;
- `detectTrafficDrift(contract, fake, cassette)` — replay recorded real
  traffic (from `RecordingProxy`) against a fresh fake with id remapping;
- `detectFixtureDrift`, `detectClientVersionDrift`.

Regenerate vendored specs with `scripts/vendor-stripe-openapi.mjs` /
`scripts/vendor-github-openapi.mjs`.
