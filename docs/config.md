# `sluice.yaml`

`sluice.yaml` lives at the project root (Sluice walks up from the current
directory to find it). Unknown keys are errors.

```yaml
version: 1
name: billing-demo

plugins: [./plugins/my-plugin.mjs] # extra plugins (path or package)
pluginConfig:
  gate:
    mutation: { maxMutants: 10, threshold: 0.8 }
    unitTests: { service: app, command: [npm, test, --silent], mounts: [src, test] }

sandbox:
  clock: '2030-01-15T12:00:00.000Z' # simulated start time
  seed: 1 # RNG seed
  fakes: [stripe] # stripe | github | s3
  ingress: { service: app, port: 3000 }
  database: { service: db, port: 5432, user: sluice, password: sluice, name: billing }
  services:
    db:
      image: postgres:16-alpine
      env: { POSTGRES_USER: sluice, POSTGRES_PASSWORD: sluice, POSTGRES_DB: billing }
      ports: [5432]
      ready: { exec: [pg_isready, -U, sluice, -d, billing, -h, 127.0.0.1] }
    app:
      build: . # Dockerfile context
      source: src # mounted so builds can be swapped
      workdir: /app
      env:
        DATABASE_URL: postgres://sluice:sluice@db:5432/billing
        STRIPE_API_BASE: ${fakes.stripe.url}
      ports: [3000]
      dependsOn: [db]
      determinism: node # frozen clock, seeded RNG, event capture
      ready: { http: { port: 3000, path: /health } }

evidence:
  ignore: ['db.*.new.updated_at'] # noise filters (globs: * one segment, ** any)

policy:
  stepUp: ['github:acme/*:merge:write']
  maxTtlSec: 3600
  db: .sluice/state/broker.db
  audit: .sluice/state/audit.jsonl

work:
  url: .sluice/state/work.db # or postgres://…
```

## `sandbox.services.<name>`

| key               | meaning                                                                                                        |
| ----------------- | -------------------------------------------------------------------------------------------------------------- |
| `image` / `build` | exactly one: a prebuilt image, or a Docker build context (images are tagged by a content hash)                 |
| `dockerfile`      | Dockerfile path within the context                                                                             |
| `command`         | override the image command                                                                                     |
| `env`             | environment; `${fakes.<name>.url}` resolves to the fake via the gateway, `${sandbox.id}` to the sandbox id     |
| `ports`           | container ports the gateway may forward to the host                                                            |
| `source`          | directory bind-mounted over `workdir/<source>` — lets Sluice run base, PR and mutant builds without rebuilding |
| `dependsOn`       | start order                                                                                                    |
| `determinism`     | `node`: inject the determinism shim (`NODE_OPTIONS=--require`)                                                 |
| `ready`           | `{exec: [...]}`, `{http: {port, path}}` or `{tcp: port}`                                                       |

Service containers get resource caps (2 CPUs, 2 GiB, 1024 pids).

## Noise filters

Paths are rooted at a channel: `response.…`, `egress.…`, `db.…`, `events.…`,
`final.…`. Public tables are keyed by bare name (`customers`), others as
`schema:table`. Generated ids (`cus_…`, `sub_…`) are canonicalized
automatically.

## Environment variables

| variable                                                                   | used by                                                                   |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `GITHUB_TOKEN`, `GITHUB_API_URL`, `GITHUB_REPOSITORY`                      | `gate run --github-check`, `rules from-pr`                                |
| `SLUICE_APPROVER`                                                          | default approver identity for `gate approve`                              |
| `SLUICE_UPSTREAM_GITHUB_TOKEN`/`_URL`, `SLUICE_UPSTREAM_STRIPE_KEY`/`_URL` | `policy serve` (real credentials stay in the broker)                      |
| `SLUICE_FAKES_BIND`                                                        | host address fakes bind to (default 127.0.0.1 on macOS, 0.0.0.0 on Linux) |
| `SLUICE_LOG=debug`, `SLUICE_TRACE_DOCKER=1`, `SLUICE_TRACE_BENCH=1`        | diagnostics                                                               |
