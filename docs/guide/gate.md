# Gate

The gate judges a change by behaviour against acceptance scenarios a human
approved **before** the code was written.

## 1. Ticket and scenarios

```
.sluice/gate/CANCEL-1/
  ticket.yaml              id, title, spec
  scenarios/<id>.yaml      black-box checks
  approvals.json           approvals bound to scenario sha256
```

```yaml
# scenarios/cancel-keeps-subscription-active.yaml
id: cancel-keeps-subscription-active
title: Cancelling schedules the end at the current period end
steps:
  - http: { method: POST, path: /customers, body: { email: ada@example.com } }
    save: { cust: body.id }
  - http: { method: POST, path: /subscriptions, body: { customer_id: '${cust}' } }
    save: { sub: body.id, period_end: body.current_period_end }
  - http: { method: POST, path: '/subscriptions/${sub}/cancel' }
    expect: { status: 200, body: { status: active, cancel_at: '${period_end}' } }
  - advance: 32d
  - assert: { egress: { none: { fake: stripe, method: DELETE } } }
  - assert: { fake: stripe, path: subscriptions, matches: [{ cancel_at_period_end: true }] }
  - assert: { sql: SELECT status FROM subscriptions WHERE id = $1, params: ['${sub}'], rows: [{ status: active }] }
  - assert: { events: { some: { event: subscription.cancel_scheduled } } }
```

Matching is partial for objects, exact-length for arrays, with operators
`$exists $ne $in $regex $gt $gte $lt $lte $contains $len $any`. Equal instants
match across ISO spellings.

## 2. Propose (agents) and approve (humans)

```sh
sluice gate ticket CANCEL-1 --title "Cancellation takes effect next cycle" --spec-file spec.md
sluice gate propose CANCEL-1 drafts/*.yaml                # or --command "<any LLM CLI>"
sluice gate status CANCEL-1
sluice gate approve CANCEL-1 --as po@acme.test            # or in `sluice ui`
```

Agents propose over MCP (`sluice_gate_propose_scenarios`) but **cannot
approve** — approval is not exposed as a tool. Editing an approved scenario
makes its approval _stale_.

## 3. Run

```sh
sluice gate run --ticket CANCEL-1 --base origin/main --head HEAD [--github-check --repo owner/name]
```

The gate:

1. reads ticket, scenarios, approvals and `sluice.yaml` **from base** and fails
   if the change touches `.sluice/gate/**`;
2. runs every approved scenario against head in a fresh sandbox;
3. runs them against base and shows the **behavior diff** (responses, egress,
   DB writes, events, final state);
4. generates up to `maxMutants` **mutants of the changed lines** (operators,
   literals, negations, removed calls, return values) and reruns the scenarios
   — a mutant is _caught_ if any scenario's outcome changes (section 4);
5. fails if a scenario fails, a scenario is unapproved/stale, or — when all
   pass — fewer than `threshold` of the valid mutants are caught;
6. writes `.sluice/reports/gate-<ticket>-<sha>.{html,json}` and optionally a
   GitHub check run.

Optionally `pluginConfig.gate.unitTests` runs the PR's own unit tests in the
app image with no network, shown for contrast.

## 4. Mutation proof

Mutants are generated only on lines the change touched, in source files of
the sandbox services' `source` dirs (language by extension; test files —
`*.test.ts`, `*_test.go`, `*Tests.cs`, `test/` dirs — are skipped, as are
generated files). JS/TS use the TypeScript compiler API, Go and C# tree-sitter.
One mutant is applied at a time; `maxMutants` (default 10) are picked evenly
across the change.

| operator           | JS / TS                                                             | Go                                         | C#                                           |
| ------------------ | ------------------------------------------------------------------- | ------------------------------------------ | -------------------------------------------- |
| `binary-operator`  | `===`↔`!==` `==`↔`!=` `<`↔`<=` `>`↔`>=` `&&`↔`\|\|` `+`↔`-` `*`↔`/` | same table                                 | same table                                   |
| `boolean-literal`  | `true`↔`false`                                                      | same                                       | same                                         |
| `remove-negation`  | `!x` → `x`                                                          | same                                       | same (not the `!` null-forgiving operator)   |
| `string-literal`   | `'x'` → `''`                                                        | `"x"` / `` `x` `` → `""`                   | `"x"`, `@"x"`, `"""x"""`, `$"x{y}"` → `""`   |
| `numeric-literal`  | `n` → `n+1`                                                         | ints (any base) and decimal floats → `n+1` | ints (suffix kept) and decimal reals → `n+1` |
| `negate-condition` | `if (c)` → `if (!(c))`                                              | `if c {` → `if !(c) {`                     | `if (c)` → `if (!(c))`                       |
| `remove-call`      | `f();` → `void 0;`                                                  | `f()` → `if false { f() }`                 | `f();` / `await f();` → `;`                  |
| `return-value`     | `return x` → `undefined`                                            | `return x` → zero value of the result type | `return x;` / `=> x` → `default!`            |

Literals are never mutated in import paths or object/map keys; Go also skips
struct tags, C# attribute arguments and index keys.

**Compiled languages.** A Go or C# mutant must build before it can say
anything, so the generators only emit mutants that should compile, judged from
syntax (there is no type checker):

- `+`↔`-` is skipped when an operand is a string (literal, string-typed
  variable/parameter/field declared in the file, `fmt.Sprintf`/`.ToString()`
  …), and in C# for `DateTime` arithmetic; `* 0` is not turned into `/ 0`.
- Go `return` uses the zero value of the declared result type when it is
  obvious — `0`, `""`, `false`, `nil` for error/pointer/slice/map/chan/func/
  interface types, `T{}` for a struct declared in the same file, a named type's
  underlying zero value; other named types and type parameters are skipped.
  Multi-value returns mutate the first value only. A return whose expression
  holds the last use of a local variable or import is skipped (Go rejects
  unused ones); for the same reason a removed Go call stays in the source
  behind `if false { … }`.
- C# `return-value` is skipped inside lambdas (inferred return types),
  `void`/`async Task` members and `ref` returns. Conditions with pattern or
  `out` variables are not negated, and calls with `out` arguments are not
  removed (definite assignment).
- No duplicate `case` labels, no array lengths or constant indexes, no
  `127`/`255`/`2147483647`… bumps that overflow a sized integer.

A mutant that still fails to compile or start (the sandbox's service exits or
never becomes ready when switched to the mutant tree) is reported **invalid**
with the startup output: it counts neither as caught nor as survived, and the
score is caught / (total − invalid). If every mutant is invalid the gate has
no mutation score. A mutant that starts and then breaks a request (crash,
reset connection) is caught.
