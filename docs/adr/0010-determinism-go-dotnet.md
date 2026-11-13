# ADR-0010: Determinism shims for Go and .NET

- Status: accepted
- Date: 2026-11-13

## Context

Evidence, replay and the gate rely on the sandbox determinism shim
([ADR-0002](/adr/0002-sandbox-and-fakes), [ADR-0003](/adr/0003-evidence-and-replay)):
a frozen wall clock the host can move (scenarios advance to a renewal), seeded
randomness (replay ×10 → zero diff) and synchronous capture of domain events
(JSON stdout lines with an `event` key, attributable to the step that caused
them). `determinism: node` does this with `NODE_OPTIONS=--require`. Go and
.NET services need the same contract with no app changes.

## Decision

Two new modes, `determinism: go` and `determinism: dotnet`, speak the Node
shim's control protocol on port 9999 (`POST /clock {nowMs}`, `GET /state`,
`GET /events?since=N`) and read `SLUICE_SEED` / `SLUICE_NOW_MS` /
`SLUICE_CONTROL_PORT`. The sandbox treats every mode the same (control port
published, clock pushed, events read); per-mode `docker run` additions live in
`core/sandbox/src/determinism/`.

### Go: patch the image's stdlib with `go build -overlay`

Go reads the wall clock from the vDSO and randomness from `getrandom(2)`
without libc (static binaries), so LD_PRELOAD cannot reach it. Instead:

- Before the first container, Sluice runs the service image once (no network)
  to read `go env GOROOT GOVERSION GOCACHE GOFLAGS` and four stdlib files,
  applies textual patches on the host, and writes an overlay dir (cached per
  image id under the user cache dir). Each patch must match exactly once or
  Sluice fails with the file, Go version and patch point.
- Patches + added `zz_sluice.go` files:
  - `time`: `func Now()` renamed `sluiceRealNow`; the added `Now` returns the
    frozen clock (an atomic, set by `time.SluiceSetNowMs`). Frozen values have
    **no monotonic reading**, so `Since`/`Until`/`Sub` follow the simulated
    clock like Node's `Date` (a 35-day `advance` expires in-memory TTLs).
    Timers, `Sleep`, tickers and network/context deadlines run on the runtime
    clock and stay real (deadlines are `Now().Add(d)` → `Until` = `d`).
  - `math/rand`, `math/rand/v2`: the linknamed `runtime_rand` (the unseedable
    source behind the top-level functions) is renamed and wrapped by a seeded
    splitmix64 stream per package. This works for v1 and v2 alike and does not
    depend on `GODEBUG=randseednop` (Go 1.24+ makes `rand.Seed` a no-op).
  - `crypto/rand`: `init` in a file that sorts last replaces `Reader` with a
    seeded stream — after the platform init that sets the default (≤1.23)
    and before any importer's init, so `github.com/google/uuid` (which
    captures `rand.Reader` at init) is seeded. `rand.Read` honours a replaced
    `Reader` (checked in 1.22 and 1.27 sources).
  - `os`: `(*File).Write` calls `os.SluiceStdoutTap` for fd 1 before writing:
    synchronous event capture, no pipe.
  - `net/http`: `init` starts the control server (every sandbox service is an
    HTTP server, so `net/http` is always linked) and installs the tap.
- The container gets `GOFLAGS=-overlay=/sluice/go/overlay.json` (after the
  service's/image's own flags) and `GOTOOLCHAIN=local`. The command must
  compile at start (`go run`, `go build && exec`), which `source:` mounts
  require anyway.
- Build cache integrity: the overlay invalidates the image's cached stdlib,
  and a writable cache shared between containers would let code under test
  (a PR, a mutant — it runs as root in the container that also compiles)
  write entries a later base/head build trusts. Sluice therefore builds a
  **warm image** once per (image, overlay, Go build env): `FROM` the service
  image, overlay copied in, `go build std` plus the image's own module,
  offline and compile-only (nothing under test executes). Services run from
  it; their `GOCACHE` is the image layer plus a private copy-on-write layer
  discarded on `reset()`. Measured on arm64 Docker Desktop: warm image build
  6.8 s (once), sandbox up 0.9–1.7 s, `reset()` ~0.6 s. Rejected: one shared
  named volume (poisonable); a per-sandbox copy of a warm volume (still shared
  by base and mutants within a sandbox, and a copy per reset); a read-only
  base + `GOCACHEPROG` layer (Go 1.24+ only, another program to ship).
- Supported: Go 1.22 (first with `math/rand/v2`) through 1.27, verified by
  integration tests on `golang:1.22-alpine` and `golang:1.27-alpine`.

Rejected: LD_PRELOAD (bypassed); `-ldflags -X`/linkname from user code
(Go 1.23 restricts linkname pulls, and needs app changes); a wrapper `go`
binary (same overlay, more moving parts); a stdout pipe (needs a flush
handshake; the `os` tap is synchronous).

### .NET: LD_PRELOAD library under a Sluice PID 1

.NET's native layer calls libc: `clock_gettime(CLOCK_REALTIME)` for
`DateTime.UtcNow`, `open("/dev/urandom")`+`read` for `Guid.NewGuid` and
`Random` seeding (the runtime is built against glibc 2.17, so no
`arc4random`/`getrandom` wrappers), and OpenSSL `RAND_bytes` for
`RandomNumberGenerator` — resolved by `dlsym` on the libcrypto handle, so
it is not interposable directly (checked with `nm` / tracing in
`mcr.microsoft.com/dotnet/sdk:10.0`).

- `libsluice-{glibc,musl}.so` (`assets/dotnet/sluice-preload.c`) intercepts
  `clock_gettime` (`REALTIME`, `REALTIME_COARSE`, `TAI` only), `gettimeofday`,
  `time`, `timespec_get`; `getrandom`, `getentropy`, `arc4random*`,
  `syscall(SYS_getrandom)`, `read`/`pread`/`readv`/`preadv` of fds opened on
  `/dev/urandom|random` (tracked through `open*`/`openat*`, `dup*`,
  `fcntl(F_DUPFD*)`, `close`, `close_range`, `syscall(SYS_close…)`; the
  bitmap is only a hint — a read is seeded only if `fstat` shows char device
  1:8/1:9, so an fd reused behind the shim's back passes through); `srand*`
  (seed derived from `SLUICE_SEED`); and, on glibc, `dlsym` to hand out a
  seeded `RAND_bytes`. Every other `dlsym` (and any `RTLD_NEXT`/`RTLD_DEFAULT`
  lookup) is a tail call, so the real `dlsym` sees the original caller and
  other interposers keep working. Negative clock values are floor-normalized
  (`0 ≤ tv_nsec < 1e9`). Randomness comes
  from 128 lock-free splitmix64 streams keyed by (entry point, size), so a
  background consumer racing on another thread cannot shift the values of
  unrelated APIs (without this, `Guid`s varied across replays).
- `sluice-init` (`assets/dotnet/sluice-init.c`, static musl) is the container
  entrypoint: it maps a clock state file shared with every process (the
  control server writes it, preloads read it atomically), pipes the command's
  stdout through itself to capture events, and sets `LD_PRELOAD` (glibc or
  musl build, chosen by probing for the musl loader) for the image
  `ENTRYPOINT` + service `command`. `/events` first writes a sentinel through
  the stdout pipe and waits for it, so everything the app wrote before
  responding is included. It forwards signals, reaps orphans and exits with
  the command's status.
- The control server lives in init, not the app, because `dotnet run` and
  MSBuild are processes in the same container: a per-process server would
  bind in whichever process starts first. SDK processes (an argument under
  `<root>/sdk/` for the running dotnet host's root or `$DOTNET_ROOT`,
  symlinks resolved; or a `dotnet <verb>` muxer) keep the real clock so
  builds behave; `SLUICE_SHIM_ALL=1` overrides.
- `Random.Shared` is a `[ThreadStatic]` xoshiro per thread, seeded on first
  use; startup code consumes draws on some pool workers, and which worker
  serves a request varies, so its values varied in ~1 of 5 runs. The preload
  sets `DOTNET_ThreadPool_ForceMinWorkerThreads/ForceMaxWorkerThreads=1` in
  app processes (not SDK ones: MSBuild with one worker hangs), so all managed
  request code runs on one thread: 12/12 resets gave identical
  `Random.Shared`/`new Random()` values, and the Kestrel + Npgsql
  billing-demo-dotnet e2e passes. Cost: sync-over-async in request code can
  deadlock; `SLUICE_DOTNET_WORKERS=0` opts out (then `Random` is best
  effort). Rejected: identical seeds for every 32-byte read (every
  `new Random()` would produce the same sequence); a startup hook replacing
  `Random.Shared` (`static readonly`, not settable after type init without IL
  patching).
- Built once per arch in `alpine:3.20` (init + musl lib) and
  `debian:bookworm-slim` (glibc lib: needs glibc ≥ 2.34 at runtime, i.e.
  every .NET 8+ glibc image except Debian 11), cached under the user cache
  dir; `SLUICE_DOTNET_SHIM_DIR` points at prebuilt binaries for offline use.

Rejected: `DOTNET_STARTUP_HOOKS` (the clock and randomness still need the
preload, and hooks also run in SDK processes); `libfaketime` (no control
protocol, no randomness or events).

### Coverage

| runtime | frozen                                                     | seeded                                                                                                                           | not deterministic                                                                            |
| ------- | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| node    | `Date`                                                     | `Math.random`, `crypto.randomUUID/randomBytes/randomFillSync/getRandomValues`                                                    | `performance.now` (real)                                                                     |
| go      | `time.Now` and everything built on it                      | `math/rand(/v2)` top-level, `crypto/rand.Reader/Read/Text`, `google/uuid`                                                        | map order, scheduling, `crypto/*` keygen (Go 1.26+ ignores the reader)                       |
| dotnet  | `DateTime(Offset).UtcNow/Now`, `TimeProvider.System`, libc | `Guid.NewGuid/CreateVersion7`, `RandomNumberGenerator` (glibc), string hash seed, `Random.Shared`/`new Random()` (single worker) | OpenSSL-internal DRBG (TLS/keys), musl `RAND_bytes`, `Random` with `SLUICE_DOTNET_WORKERS=0` |

Monotonic clocks stay real everywhere.

## Consequences

- Go services must compile at container start; .NET services that should see
  swapped builds must too (`dotnet run --no-restore`). Both are documented in
  the [sandbox guide](/guide/sandbox) with Dockerfile templates.
- Integration tests cover each mode (`core/sandbox/test/*-determinism.itest.ts`)
  against tiny fixture services: clock frozen and moved, same seed → same
  values across resets and a different seed → different, events present right
  after the response, no egress, a private Go build cache per container, and
  `Random.Shared` identical over 10 resets. `dotnet-preload.itest.ts` runs a
  native C regression program (`fixtures/preload-test`) under the glibc and
  musl builds: fd tracking through dup/fcntl/close_range/raw-close reuse,
  pread/readv/preadv, negative clock normalization, `dlsym(RTLD_NEXT)`
  semantics and SDK-process detection.
- First use costs a stdlib probe plus a warm image build (Go, ~10 s) or a
  shim build (.NET, ~30 s, needs network once); all are cached.
- A new Go release that rewrites a patched declaration fails loudly at
  sandbox start; adding a patch rule is a one-line change in
  `determinism/go.ts` plus a fixture snippet in its unit test.
