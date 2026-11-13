# Languages

Sluice supports **TypeScript/JavaScript**, **Go** and **C#/.NET** out of the
box. Code is parsed on the host with tree-sitter (via ast-grep; Go and C#
grammars ship prebuilt in `@sluice-dev/lang`) or the TypeScript compiler, so
no Go or .NET toolchain is needed on the host: anything that compiles runs
inside the sandbox or a test container.

| Feature                                 | TypeScript / JavaScript                                                               | Go                                                                                          | C# / .NET                                                                                           |
| --------------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| [Deterministic sandbox](/guide/sandbox) | `determinism: node` (`--require` shim)                                                | `determinism: go` (stdlib patched via `go build -overlay`)                                  | `determinism: dotnet` (`LD_PRELOAD` shim + init)                                                    |
| [Gate mutation proof](/guide/gate)      | TS compiler API                                                                       | tree-sitter; zero-value-aware returns; non-compiling mutants `invalid`                      | tree-sitter; `default!` returns; non-compiling mutants `invalid`                                    |
| [Symbol leases](/guide/coordination)    | TS language service                                                                   | package-aware index (go.mod), methods `Recv.Method`                                         | namespace/`using`-aware index, partial types, nested types                                          |
| [Structural rules](/guide/policy)       | `language: javascript` / `typescript`                                                 | `language: go`                                                                              | `language: csharp`                                                                                  |
| Review comment → proven rule            | yes                                                                                   | yes                                                                                         | yes                                                                                                 |
| [Campaign codemods](/guide/campaigns)   | yes                                                                                   | yes                                                                                         | yes                                                                                                 |
| [Bench mining](/guide/bench)            | yes                                                                                   | yes (`prepare`: `go mod download`)                                                          | yes (`prepare`: `dotnet restore`)                                                                   |
| `sluice init`                           | detects `package.json`                                                                | detects `go.mod`                                                                            | detects `*.csproj` / `*.sln` / `*.slnx`                                                             |
| North-star demo                         | [`billing-demo`](https://github.com/ODumpling/sluice/tree/main/examples/billing-demo) | [`billing-demo-go`](https://github.com/ODumpling/sluice/tree/main/examples/billing-demo-go) | [`billing-demo-dotnet`](https://github.com/ODumpling/sluice/tree/main/examples/billing-demo-dotnet) |

Default toolchain images: `node:22-alpine`, `golang:1.27-alpine`,
`mcr.microsoft.com/dotnet/sdk:10.0` (override per bench/campaign/repo).

## Known limits

- **Go determinism** needs the service to compile at container start (a
  prebuilt binary isn't shimmed) and to link `net/http`. Map iteration order
  and `crypto/*` key generation stay nondeterministic.
- **.NET determinism**: wall clock, `Guid`, `RandomNumberGenerator` are
  deterministic; `Random.Shared` / `new Random()` are seeded but best effort
  (thread-local) unless the service opts in with `SLUICE_DOTNET_WORKERS: '1'`
  (one thread-pool worker; apps that block on tasks can deadlock), see the
  [sandbox guide](/guide/sandbox#dotnet). Emit events with `Console.WriteLine` (the `ILogger` console
  provider is asynchronous).
- **Go/C# symbol resolution** is syntactic (no type checker): see the
  precision notes in the [coordination guide](/guide/coordination).

Design: [ADR-0010](/adr/0010-determinism-go-dotnet).
