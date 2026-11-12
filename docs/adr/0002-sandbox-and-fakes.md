# ADR-0002: Sandboxes and contract-validated fakes

- Status: accepted
- Date: 2026-11-12

## Context

Evidence about an AI-written change is only trustworthy if the app runs in a
controlled environment: real dependencies where cheap (Postgres), faithful fakes
where not (Stripe, GitHub, S3), and provably no real third-party egress.

## Decision

### Sandbox topology

- Each sandbox gets two Docker networks: `sluice-<id>-int` created with
  `--internal` (no route off the host) and `sluice-<id>-ext` (normal bridge).
- All services from `sluice.yaml` (`sandbox.services`) attach **only** to the
  internal network.
- A gateway container (`node:22-alpine` running `core/sandbox/assets/gateway.cjs`,
  zero dependencies) attaches to both. It forwards exactly:
  - host → service ports (published on `127.0.0.1` only): ingress, database,
    determinism control port;
  - service → fake: `http://sluice-gw:<port>` → `host.docker.internal:<fake port>`.
    `${fakes.<name>.url}` in service env resolves to that gateway address.
- Fakes run in the Sluice host process (`FakeServer`), so their journal and
  state are directly inspectable and their clock is the sandbox clock.
- Services with `source:` get that directory bind-mounted over the image's copy,
  so switching builds (base / PR / mutants) recreates a container instead of
  rebuilding an image. Images are tagged by a content hash of the build context
  (excluding `source`).
- `determinism: node` mounts `assets/determinism.cjs` via `NODE_OPTIONS=--require`:
  frozen `Date`, seeded `Math.random` / `crypto.randomUUID` / `randomBytes` /
  `getRandomValues`, and a control server to move the clock.
- Databases: after the DB service is ready, `prepareDatabase` (used by evidence
  to install audit triggers) runs, then the DB is cloned to a template.
  `reset()` drops/recreates the DB from the template, recreates stateless
  containers and resets fakes + clock — a fresh, identical start every time.
- Docker is driven through the `docker` CLI (no daemon SDK dependency).

Zero egress is verified by tests: service containers are attached only to the
internal network, and probes from inside the app container (`fetch` to
api.stripe.com, raw TCP to 1.1.1.1) fail.

### Fakes

- `Contract` loads an OpenAPI 3.0 document: route matching, request coercion
  (form strings → schema types) and validation, **strict** response validation
  (types, required fields and _undocumented fields_ all fail), and `synthesize()`
  which builds the minimal spec-valid object for a schema. Fake objects start
  from `synthesize()` — they are generated from the spec — and `FakeServer`
  validates every response; in strict mode a violation becomes an HTTP 500 so a
  drifting fake fails loudly.
- The Stripe contract is a subset of Stripe's published `spec3.json`
  (operations the fake implements + reachable schemas, descriptions stripped),
  vendored by `scripts/vendor-stripe-openapi.mjs` with the source SHA-256.
- Recorded traffic: `RecordingProxy` writes redacted JSONL cassettes of real
  exchanges; Stripe's published `fixtures3.json` objects are vendored too.
- Drift detection: `detectSpecDrift` (new spec vs vendored, scoped to
  implemented operations), `detectTrafficDrift` (replay a cassette against a
  fresh fake with id remapping; contract violations in real responses and
  status/shape differences are reported), `detectFixtureDrift`, and
  `detectClientVersionDrift` (clients pinning another `Stripe-Version`). It
  already finds real upstream drift in Stripe's own fixtures
  (`invoice.subscription`, `product.type`).

## Dependencies

| Dependency                         | Where             | Why                                                            |
| ---------------------------------- | ----------------- | -------------------------------------------------------------- |
| ajv                                | fakes             | de-facto JSON Schema validator; handles Stripe's large schemas |
| pg                                 | sandbox, evidence | standard Postgres client (DB reset, audit capture)             |
| stripe (dev only)                  | fakes tests       | proves the fake works with the official SDK                    |
| node:22-alpine, postgres:16-alpine | images            | official images; gateway needs only Node                       |

## Consequences

- Requires Docker; unit tests stay Docker-free.
- On Linux the host-side fakes bind `0.0.0.0` so the docker bridge can reach
  them (override with `SLUICE_FAKES_BIND`); on macOS they bind loopback.
- Only Node services get the determinism shim in v0.1.
