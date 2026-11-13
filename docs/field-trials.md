# Field trials (2026-11-13)

Before this, Sluice had only run on apps its authors wrote. We took three
popular open-source services nobody on the project wrote. For each, someone new
to Sluice followed only the public docs with the published
`@sluice-dev/cli@0.1.0`. They wrote a ticket and approved scenarios, and opened
two "agent" branches: a subtle bug that passes the repo's own unit tests, and a
correct fix.

|                        | Node                                                                                                                                          | Go                                                                                                                  | .NET                                                                                                                                     |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Repo                   | [node-express-realworld-example-app](https://github.com/gothinkster/node-express-realworld-example-app) `30b68e1` (Express, Prisma, Postgres) | [techschool/simplebank](https://github.com/techschool/simplebank) `97f000f` (gRPC-gateway, Postgres, Redis, PASETO) | [aspnetcore-realworld-example-app](https://github.com/gothinkster/aspnetcore-realworld-example-app) `6fe67a5` (.NET 10, EF Core, SQLite) |
| Ticket                 | editing an article must not wipe its tags (a real upstream bug)                                                                               | case-insensitive emails                                                                                             | popular tags: by usage, hide unused, at most 10                                                                                          |
| Healthy `sluice up`    | 3 min                                                                                                                                         | 4 min                                                                                                               | 2.5 min                                                                                                                                  |
| First gate verdict     | 11 min                                                                                                                                        | 14 min                                                                                                              | 9 min                                                                                                                                    |
| Hand-written config    | 39 + 12-line Dockerfile                                                                                                                       | 43 + 10                                                                                                             | 26 + 14                                                                                                                                  |
| Hand-written scenarios | 60 lines / 5                                                                                                                                  | 95 lines / 5                                                                                                        | 42 lines / 4                                                                                                                             |
| Bad branch             | **failed** for the right reason (1/5)                                                                                                         | **failed** for the right reason (2/5), repeated in 2 runs                                                           | **failed** for the right reason (1/4), repeated in 3 runs                                                                                |
| Good branch            | **passed** in 3/3 runs                                                                                                                        | passed in 3/3 runs once a scenario checked the error body (first try: "checks too weak")                            | **passed** in 4/4 runs                                                                                                                   |
| Replay deterministic   | after ignoring DB-generated timestamps                                                                                                        | after ignoring DB-generated timestamps (18 replays)                                                                 | with `SLUICE_DOTNET_WORKERS: '1'` (10/10)                                                                                                |
| Gate wall time         | ~2 min                                                                                                                                        | ~1–2 min                                                                                                            | ~1.5–2 min                                                                                                                               |

No Go or .NET toolchain was installed on the host. In every repo the gate
caught a bug that the repo's own unit tests, and the agent's added test,
missed. The correct PR never failed a scenario in any run. Caveat: each trial
picked its own ticket and wrote both the scenarios and the bug, so this shows
the machinery works on unfamiliar code. It does not show that scenarios catch
bugs nobody anticipated.

## Fixed after the trials

- **Request `headers` now get `${var}` interpolation**, so a token saved from
  a login can authenticate later steps. All three trials hit this first; before
  the fix, any authenticated API needed hardcoded tokens or a patched
  `node_modules`. See the [evidence guide](/guide/evidence).
- **`sluice down` removes only the current project's sandboxes.** It used to
  remove every Sluice sandbox on the machine, including other projects' running
  ones and concurrent CI jobs'. `--all` keeps the old behavior.
- **`ready: { tcp }` probes the service from inside the sandbox network.**
  Before, it probed Sluice's own gateway port, which always accepts, so
  "ready" could fire before the app listened. That caused intermittent
  `fetch failed`, and could make a mutant look caught.
- **The gate fails changed source lines that yield no mutants** as unproven,
  instead of passing silently (opt out with `mutation.allowNoMutants`).
  **Surviving mutants are listed in the CLI output**; before, they were only
  in the JSON report.
- Docs: the database clock is not frozen (`now()` defaults and SQL date
  logic); concurrent .NET `Guid` draws need `SLUICE_DOTNET_WORKERS: '1'`.

## Open findings, by priority

1. **The PR controls the sandbox image.** The gate builds the image from the
   head tree. Only `.sluice/gate/**` and `sluice.yaml` come from base, so a PR
   that edits its Dockerfile can change what runs. In the .NET trial, a
   Dockerfile that ran a hidden good build made buggy code pass every scenario.
   Only the mutation proof caught it. Options: build from base, or require
   approval when build-context files outside `source` change. This needs a
   design decision, since dependency bumps legitimately change the image.
2. **Mutation operators miss common idioms.** There is no "unwrap the call"
   mutant (`strings.ToLower(x)` → `x`: the Go ticket's core change got no
   mutant). JS/TS ternaries and conditional spreads aren't mutated, and C# LINQ
   (`OrderBy`↔`OrderByDescending`, dropping a `.Where` or `.Take`) isn't
   either. With 2–3 mutants per change, one survivor flips the verdict.
3. **The database runs on real time.** Applying the existing clock shim to the
   database service would make `now()` follow `advance`.
4. **`sluice init` doesn't inspect the repo.** It assumes port 3000,
   `/health`, `src`/`test` dirs and `npm test`, and generates no sandbox
   Dockerfile. In the .NET trial its config came up "healthy" but never
   compiled the mounted source. Every trial had to hand-write a
   `Dockerfile.sluice`.
5. Smaller items:
   - Migration bookkeeping tables (`_prisma_migrations`,
     `__EFMigrationsHistory`, …) should be ignored by default.
   - Generated code (`prisma generate`) goes stale when `schema.prisma`
     changes.
   - Each new head builds a new image, and nothing cleans them up (~1–3 GB per
     image for .NET).
   - The CLI shows neither the base diff nor the values behind "got 2".
   - `gate propose` rewrites scenario YAML and drops comments.
   - There is no step to wait for background jobs to settle.
   - A branch that doesn't compile gives a raw `docker build failed`.

Unconfirmed: the .NET trial reported one gate run where base ran head's
compiled binary, because baked MSBuild output was newer than the base
checkout. Re-running the same base and head with a freshly built image gave a
correct base diff, so the cause is still unknown.
