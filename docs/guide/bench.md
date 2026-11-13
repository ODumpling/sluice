# Bench

Compare agent configurations on _your_ code: pass rate, cost, wall time.

```sh
cd examples/bench
sluice bench mine     # history -> fail-to-pass tasks
sluice bench run      # every agent × every task; JSON + Markdown report
```

```yaml
# bench.yaml
name: cel-js
source: { bundle: cel-js.bundle, repo: marcbachmann/cel-js, ref: main } # or path:
mine:
  limit: 20
  source: [lib/]
  tests: '^test/.*\.test\.js$'
  testCommand: node --test --experimental-test-isolation=none test/**/*.test.js
agents:
  - name: claude-code
    command: claude -p "$SLUICE_TASK_PROMPT" --permission-mode acceptEdits --output-format json
  - name: codex
    command: codex exec --full-auto "$SLUICE_TASK_PROMPT"
```

**Mining.** A commit that changes source and tests (and no dependency
manifests — `package.json`/lockfiles, `go.mod`/`go.sum`, `*.csproj`/`*.sln`/
`Directory.Packages.props`/`NuGet.config`…) becomes a task only if its tests
fail on the parent and pass on the commit — checked in containers with no
network, CPU/memory caps and a host-enforced deadline.

## Go and .NET

Only the source and the agents are required: everything else defaults from
the toolchain detected at the repository root at the mined ref
(`go.mod`/`go.work` → Go; `*.sln`/`*.slnx`/`*.csproj` → .NET;
`package.json` → Node).

| `mine.*`      | Go                                     | .NET                                   | Node                 |
| ------------- | -------------------------------------- | -------------------------------------- | -------------------- |
| `image`       | `golang:1.27-alpine`                   | `mcr.microsoft.com/dotnet/sdk:10.0`    | `node:22-alpine`     |
| `testCommand` | `go test ./...`                        | `dotnet test --nologo`                 | `npm test --silent`  |
| `tests`       | `*_test.go`                            | `*Tests.cs`, `.cs` in a `*Tests/` dir  | `*.test.js`, `test/` |
| `source`      | non-test `.go` files                   | non-test `.cs` files                   | non-test JS/TS files |
| `prepare`     | on (`go mod download`, `go build std`) | on (`dotnet restore` of every project) | off                  |

`dotnet test` needs one solution or project at the root; otherwise set
`mine.testCommand` (e.g. `dotnet test tests/App.Tests`).

```yaml
# go.bench.yaml — see examples/bench
name: go-textkit
source: { bundle: go-textkit.bundle, repo: example/go-textkit }
mine: { limit: 10, timeoutSec: 120 }
agents:
  - { name: oracle, command: node ${benchDir}/agents/oracle.mjs, oracle: true }
```

**Offline dependencies (`mine.prepare`).** Tests always run with
`--network none` from a git-archived tree, so Go modules and NuGet packages
are fetched once, ahead of time: Sluice builds a derived image `FROM <image>`
that contains **only the tree's dependency manifests** (paths preserved, under
`/work`) and runs the prepare command there **with network, at image build
time**. Tests then run offline in that image (Go's module and build caches,
NuGet's global packages folder and `obj/` restore state are baked in; the
implicit restore of `dotnet test` succeeds offline). The image is tagged
`sluice-prepare:<hash>` by base image, command, environment and the content of
every manifest, so it is reused until a manifest changes (mined commits never
change one; an agent that edits `go.mod` gets a fresh prepare). Values:

- omitted — the toolchain default when the tree needs it (any `go.mod`; any
  .NET project); **none for Node** (zero-dependency suites such as cel-js run
  as before);
- `true` — the toolchain default (Node: `npm ci`/`npm install`);
- a string — your command, run in `/work` with only the manifests present
  (e.g. `go mod download && go install gotest.tools/gotestsum@v1.12.0`);
- `false` — none (vendored modules, an `image` with dependencies baked in).

Remove cached images with `docker image prune -a --filter label=sluice.prepare=1`.
A prepare failure rejects the candidate (`prepare failed on the parent: …`)
rather than counting as a failing test. Tasks record `prepare` (and the
toolchain `env`, e.g. `DOTNET_CLI_TELEMETRY_OPTOUT`) so evaluation uses the
same image.

**Running.** Each agent runs in a fresh checkout of the base commit with
`SLUICE_TASK_PROMPT`. Hidden tests are then applied and run in a container.
Cost comes from `$SLUICE_AGENT_REPORT` (`{cost_usd, input_tokens,
output_tokens}`) or the last JSON line with `total_cost_usd` (Claude Code's
JSON output). `oracle: true` agents also get the reference patch (for
calibration).

**Report.** Pass rate, cost, cost per solved task, median/total wall time and a
per-task matrix; everything but timings is reproducible across runs.
