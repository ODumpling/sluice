# Sandbox & fakes

```sh
sluice up                        # boots services; prints SLUICE_* URLs; Ctrl-C to stop
sluice up --exec './smoke.sh'    # run a command against it, tear down, pass exit code
sluice up --source ../other-checkout
sluice down                      # remove this project's leftovers (--all: every project's)
```

## Topology

Services join only an `--internal` Docker network (no route off the host).
A gateway container (Node, zero dependencies) is the only bridge: it publishes
ingress/database/control ports on `127.0.0.1` and forwards
`http://sluice-gw:<port>` to fakes running in the Sluice process. Tests prove
`fetch('https://api.stripe.com')` from inside the app fails.

With `sandbox.browser` on, a Playwright Chromium container joins the same
internal network (started on the first `browser` step); Sluice drives it
through the gateway and it reaches services as `<name>.sluice.internal`
([browser guide](/guide/browser)).

## Determinism

`determinism:` on a service injects a runtime shim. Every mode does the same
four things, so evidence, replay and the gate treat Node, Go and .NET services
alike:

- **frozen wall clock** at `sandbox.clock`, moved only by `advance` / `clock`
  steps (`Sandbox.advance` / `setClock`); monotonic clocks, timers and
  timeouts keep real time. Only shimmed app processes see it: the database
  keeps real time, so `now()` / `CURRENT_TIMESTAMP` column defaults differ
  every run (add them to `evidence.ignore`) and SQL date logic does not follow
  `advance`;
- **seeded randomness** from `sandbox.seed` (`reset({seed})` re-seeds): the
  same seed gives the same ids/tokens every run, a different seed different
  ones;
- **domain events**: JSON lines with a string `event` key written to stdout
  are captured in order, and are available as soon as the app has responded;
- a **control server** on port 9999 (published through the gateway):
  `POST /clock {"nowMs":n}`, `GET /state`, `GET /events?since=N`.

The shim reads `SLUICE_SEED`, `SLUICE_NOW_MS` and `SLUICE_CONTROL_PORT`
(set by the sandbox). `reset()` recreates containers (fresh, re-seeded
process), restores the database from a template and resets fakes and clock.

| mode     | how                                                                                 | requirements                                                                                     |
| -------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `node`   | `NODE_OPTIONS=--require /sluice/determinism.cjs`                                    | the command runs `node`                                                                          |
| `go`     | `GOFLAGS=-overlay=…`: the image's own stdlib is patched at compile time             | Go 1.22+ toolchain in the image; the command **compiles at container start**; links `net/http`   |
| `dotnet` | `sluice-init` (PID 1) + `LD_PRELOAD` library for the app process (glibc 2.34+/musl) | any Linux .NET image; for `dotnet run`, restore in the image and build at start (`--no-restore`) |
| `none`   | nothing (default)                                                                   |                                                                                                  |

### `node`

Freezes `Date`; seeds `Math.random`, `crypto.randomUUID`, `randomBytes`,
`randomFillSync`, `getRandomValues`; captures `process.stdout.write`.

### `go`

Go reads time through the vDSO and randomness through `getrandom(2)` without
libc, so Sluice patches the standard library instead: before the first
container it reads `$GOROOT/src` from the service image, generates a
`go build -overlay` (cached per image id under `~/.cache/sluice`) and mounts
it at `/sluice/go`. Because the overlay applies when the program is compiled,
**the service command must build from the mounted source** — a binary baked
into the image is not shimmed.

```dockerfile
FROM golang:1.27-alpine
WORKDIR /app
COPY go.mod go.sum ./
RUN go mod download          # no network at sandbox runtime
COPY . .
RUN go build -o /dev/null ./cmd/server   # compiles the dependencies into the image's build cache
CMD ["go", "run", "./cmd/server"]
```

```yaml
app:
  build: .
  source: internal # or cmd, … — mounted over /app/internal
  command: [go, run, ./cmd/server] # or [sh, -c, 'go build -o /tmp/s ./cmd/server && exec /tmp/s']
  determinism: go
  ready: { http: { port: 8080, path: /health } }
```

Sluice sets `GOFLAGS=-overlay=/sluice/go/overlay.json` (appended to the
service's or the image's own `GOFLAGS`) and `GOTOOLCHAIN=local` (the overlay
patches this image's GOROOT). The sandbox has no network: download modules in
the image (`ENV GOPROXY=off` makes a missing one fail fast).

Containers run from a **warm image** `sluice-gowarm-<image>:<key>` that Sluice
builds once (offline, compile-only: `FROM` the service image, the overlay
copied to `/sluice/go`, `go build std` and the image's own module with the
overlay). Its `GOCACHE` already holds the overlaid stdlib, so a container
starts in about a second, and each container writes only to its own
copy-on-write layer: code under test (a PR, a mutant) can never put entries
into a cache that a later base/head run reads. No cache volume is mounted.
Warm images carry `sluice.image=1` / `sluice.gowarm=1` labels
(`docker rmi $(docker images -q --filter label=sluice.gowarm=1)`).

Because nothing is cached between containers, every container compiles
whatever its image doesn't already have cached. Keep the `RUN go build` step
in the Dockerfile (from a source tree that imports all dependencies): the warm
image then compiles the module's dependencies with the overlay once, and
only the mounted packages are rebuilt per start/reset. Without it a large
dependency tree recompiles on every `reset()`. The warm-up uses the
service's `GO*`/`CGO_*` env (after `${…}` interpolation), so its cache keys
match the container's.

What is covered:

| API                                                                                                              | behaviour                                                                                                  |
| ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `time.Now` (and `Since`, `Until`, `log`, `slog`, `uuid.NewV7`, …)                                                | frozen; values carry no monotonic reading, so `time.Since(t)` follows the simulated clock (0 while frozen) |
| `time.Sleep`, `time.After`, tickers, `context.WithTimeout`, net deadlines                                        | real time (runtime clock)                                                                                  |
| `math/rand` and `math/rand/v2` top-level functions                                                               | seeded                                                                                                     |
| `crypto/rand.Reader`, `Read`, `Text`, `Int(rand.Reader, …)`, `github.com/google/uuid`                            | seeded                                                                                                     |
| explicitly seeded generators (`rand.New(rand.NewSource(n))`, `rand.NewPCG`, …)                                   | untouched (already deterministic)                                                                          |
| `crypto/*` key generation (Go 1.26+ ignores the `io.Reader` argument), map iteration order, goroutine scheduling | **not** deterministic — sort map keys before emitting them                                                 |
| events                                                                                                           | writes to fd 1 via `os.Stdout` (`fmt.Print*`, `json.NewEncoder(os.Stdout)`, `slog` to stdout)              |

`log` and the default `slog` logger write to **stderr**; emit events to
stdout. A program that does not link `net/http` gets no control server (the
sandbox fails with a hint).

### `dotnet`

.NET reads time and randomness through libc, so an `LD_PRELOAD` library can
freeze and seed them. Sluice builds it (and the static `sluice-init`) from
`core/sandbox/assets/dotnet/*.c` once per CPU architecture in throwaway
builder containers (`alpine:3.20`, `debian:bookworm-slim`; needs network
once, cached under `~/.cache/sluice`; or point `SLUICE_DOTNET_SHIM_DIR` at
prebuilt `sluice-init`, `libsluice-glibc.so`, `libsluice-musl.so`). The
container entrypoint becomes `/sluice/dotnet/sluice-init`, which runs the
image `ENTRYPOINT` + the service `command` (or image `CMD`) with stdout piped
through it and `LD_PRELOAD` set; `docker exec` processes are not shimmed.
SDK processes (any argument under `<dotnet root>/sdk/` — the root of the
running `dotnet` host or `$DOTNET_ROOT` — e.g. MSBuild, csc, the compiler
server; or a `dotnet <verb>` CLI like `dotnet run`) run with real time; only
the app process (`dotnet App.dll`, `dotnet exec …`, or the apphost) is
shimmed (`SLUICE_SHIM_ALL=1` shims everything).

`Random.Shared` is thread-local, so by default its values (and `new
Random()` seeds) depend on which thread-pool thread serves a request: seeded,
but best effort. The same goes for `Guid` / `RandomNumberGenerator` when
several pool threads draw randomness at once (e.g. a JWT `jti` per request
under load): each value is seeded, but which thread gets which can vary. To
make all of them reproducible, opt in with
`SLUICE_DOTNET_WORKERS: '1'` in the service `env`: managed app processes
(never shells or SDK processes, which would hang) then get
`DOTNET_ThreadPool_ForceMin/MaxWorkerThreads=1` unless they set those
themselves, so request code always runs on one thread. Kestrel, `async` I/O
and Npgsql work with it, but request code that blocks on tasks (`.Result`,
`.Wait()` on work needing another pool thread) deadlocks; a readiness timeout
then names the cap. Without the opt-in, prefer `Guid` /
`RandomNumberGenerator` (reproducible while requests don't overlap), or inject
a `new Random(seed)` you own.

```dockerfile
FROM mcr.microsoft.com/dotnet/sdk:10.0
WORKDIR /app
COPY *.csproj ./
RUN dotnet restore           # no network at sandbox runtime
# don't bake build output: a swapped-in source tree with older mtimes could be skipped
CMD ["dotnet", "run", "--no-restore", "--no-launch-profile"]
```

```yaml
app:
  build: .
  source: src # *.cs mounted over /app/src; the .csproj (in /app) globs them
  determinism: dotnet
  ready: { http: { port: 8080, path: /health } }
```

A published app works too (`command: [dotnet, /out/App.dll]`), but then the
mounted source is not compiled — use `dotnet run` (or `sh -c 'dotnet build
… && exec dotnet …'`) when Sluice swaps builds.

| API                                                                                                          | behaviour                                                                                                                         |
| ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `DateTime.UtcNow` / `Now`, `DateTimeOffset.UtcNow`, `TimeProvider.System.GetUtcNow()`, Kestrel `Date` header | frozen (`clock_gettime(CLOCK_REALTIME*)`, `gettimeofday`, `time`)                                                                 |
| `Stopwatch`, `Environment.TickCount64`, timers, `Task.Delay`, timeouts                                       | real (`CLOCK_MONOTONIC`)                                                                                                          |
| `Guid.NewGuid`, `Guid.CreateVersion7`, `RandomNumberGenerator.*`, string hash seed                           | seeded (`/dev/urandom` reads incl. `pread`/`readv`, `getrandom`, `getentropy`, OpenSSL `RAND_bytes`); concurrent draws: see above |
| `Random.Shared`, `new Random()`                                                                              | seeded; best effort by default, reproducible with `SLUICE_DOTNET_WORKERS: '1'` (see above)                                        |
| TLS / key generation inside OpenSSL                                                                          | not deterministic (DRBG nonces)                                                                                                   |
| events                                                                                                       | anything written to fd 1 (`Console.WriteLine`, `Console.Out`): synchronous, `Console.Out` autoflushes                             |

The `Microsoft.Extensions.Logging` console logger writes from a background
thread: don't emit events through `ILogger`, use `Console.WriteLine`.
Musl (Alpine) images: the OpenSSL `RAND_bytes` hook is glibc-only.

Diagnostics: `SLUICE_SHIM_DEBUG=1` in a service's `env` logs every seeded
read to stderr.

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
