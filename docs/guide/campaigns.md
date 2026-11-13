# Campaigns

Multi-repo migrations (expand → migrate → contract) where **every step is
gated by evidence** and a destructive step can only run after every consumer
has moved.

```sh
cd examples/campaign
sluice campaign run campaign.yaml
sluice campaign status campaign.yaml
sluice campaign rollback campaign.yaml --step migrate --repo invoices
```

```yaml
id: money-to-cents
repos:
  - { name: shared-money, path: repos/shared-money }
  - { name: checkout, path: repos/checkout }
  - { name: invoices, path: repos/invoices }
steps:
  - id: expand
    repos: [shared-money]
    apply: { copy: steps/expand }
    evidence: [{ tests: node --test test/*.test.js, scope: all }]
  - id: migrate
    repos: [checkout, invoices]
    apply:
      codemod:
        language: javascript
        rules:
          - { pattern: 'formatDollars($A, $OPTS)', rewrite: 'formatCents(Math.round($A * 100), $OPTS)' }
          - { pattern: 'formatDollars($A)', rewrite: 'formatCents(Math.round($A * 100))' }
    evidence:
      - tests: node --test test/*.test.js
      - rule: { language: javascript, pattern: 'formatDollars($$$)', expect: none }
  - id: contract
    repos: [shared-money]
    destructive: true
    apply: { copy: steps/contract }
    evidence: [{ tests: node --test test/*.test.js, scope: all }]
```

- `apply`: `copy` (overlay files), `codemod` (ast-grep pattern → template with
  the same metavariables), or `command`.
- `tests` evidence runs in a no-network container against a side-by-side
  snapshot of **every repo's campaign branch**; `scope: all` re-tests all
  repos. `rule` evidence asserts a structural invariant.
- Each applied step is a commit on `campaign/<id>`; failures are rolled back
  automatically, the campaign halts and later destructive steps are marked
  **blocked**. State is persisted; fixing the definition and re-running resumes.

## Go and .NET

Campaigns work the same on Go modules and .NET solutions (examples:
`examples/campaign-go`, `examples/campaign-dotnet`):

- `codemod.language: go | csharp` rewrites only that language's files;
  `rule` evidence takes the same languages (`money.FormatDollars($$$)`).
- The `tests` evidence image defaults **per repo** from its detected toolchain
  (`golang:1.27-alpine`, `mcr.microsoft.com/dotnet/sdk:10.0`, `node:22-alpine`);
  `evidenceImage` (campaign) or `repos[].image` override it.
- Dependencies are fetched by a **prepare** step before the offline tests: an
  image `FROM` the evidence image holding only the workspace's dependency
  manifests runs the prepare command in the repo's directory with network at
  build time (cached by the base image ID and manifest content). Default: on
  for Go (`go mod download`) and .NET (`dotnet restore` of every project), off
  for Node; it runs at the repo's detected project root (`backend/go.mod` →
  `cd <repo> && cd backend && …`). Override with `prepare:` on the campaign, a
  repo or a step — a command, `true` (toolchain default) or `false`.
- Prepare **executes the repos' build logic with network** at image build
  time: `dotnet restore` evaluates every imported MSBuild file
  (`Directory.Build.props`/`.targets`, custom restore targets, NuGet plugins
  from `NuGet.config`); Go honours `go.mod` directives (`toolchain` downloads,
  replaces) but never runs `go generate`. Run campaigns only over repos whose
  build files you trust, or set `prepare: false` with an `image` that already
  has the dependencies. The evidence tests themselves run with no network.
- Consumers that build against the sibling library checkout
  (`replace example.com/money => ../shared-money` in `go.mod`,
  `<ProjectReference Include="../../shared-money/…">`) see the library's
  campaign branch, so `scope: all` proves every consumer against the change.

```yaml
id: money-to-cents-go
repos:
  - { name: shared-money, path: repos/shared-money }
  - { name: checkout, path: repos/checkout }
steps:
  - id: migrate
    repos: [checkout]
    apply:
      codemod:
        language: go
        rules: [{ pattern: 'money.FormatDollars($A)', rewrite: 'money.FormatCents(money.ToCents($A))' }]
    evidence:
      - tests: go test ./...
      - rule: { language: go, pattern: 'money.FormatDollars($$$)', expect: none }
```
