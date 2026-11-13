# Policy & rules

## Credential broker

```sh
SLUICE_UPSTREAM_GITHUB_TOKEN=ghp_… sluice policy serve --port 4700
sluice policy grant --task T-1 --agent codex --ttl 900 \
  --scope github:acme/app:contents:read --scope github:acme/app:pull_requests:write \
  --max-requests 200 --max-writes 20
sluice policy approvals            # pending step-up requests
sluice policy approve apr_… --as lead@acme.test
sluice policy audit                # verify the hash chain
```

- Scopes: `github:<owner>/<repo|*>:<metadata|contents|pull_requests|issues|checks|merge>:<read|write>`,
  `stripe:<resource|*>:<read|write>`. `write` implies `read`.
- Every request is mapped to the scope it needs; anything not brokered is
  denied. The real credential is injected by the broker.
- Caps: requests, writes, and USD for Stripe subscription creation (priced
  before forwarding; refused with 402 if over).
- Step-up: scopes matching `policy.stepUp` need a single-use human approval
  per request (e.g. merges).
- Audit: append-only JSONL, each entry hash-chained to the previous.

## Rules from review comments

```sh
sluice rules propose --comment "Don't call \`stripe.subscriptions.cancel()\` here…" --path src/billing.js
sluice rules propose --comment "Don't call \`stripe.CancelNow(...)\` here" --path billing/cancel.go
sluice rules prove review-stripe-subscriptions-cancel --bad <commit> --main main
sluice rules check --base main --head HEAD
sluice rules from-pr --repo acme/app --pr 42 [--language go]   # GitHub comments
```

Candidates come from code spans in the comment (calls generalized to
`callee($$$)`, constructors to `new T($$$)`; `fn(...)` in prose means "any
arguments") or the call at the commented line. A rule is **adopted only if
proven**: it flags lines the bad commit changed and finds nothing on main.
Rules are structural (ast-grep), so comments and strings never match.
`sluice rules check` (and the MCP tool `sluice_rules_check`) runs adopted rules
on the tree, a ref, or only the lines changed `base..head`.

### Languages

| `language`   | Applies to                                    | Proposed from                                         |
| ------------ | --------------------------------------------- | ----------------------------------------------------- |
| `javascript` | `.js .mjs .cjs .jsx` **and** TypeScript files | `call_expression`, `new`                              |
| `typescript` | `.ts .mts .cts .tsx` only                     | `call_expression`, `new`                              |
| `go`         | `.go` (not `vendor/`, `testdata/`)            | `call_expression`                                     |
| `csharp`     | `.cs` (not `bin/`, `obj/`)                    | `invocation_expression`, `object_creation_expression` |

A proposal's language is `--language` if given, else the comment's `--path`
(`.go` → `go`, `.cs` → `csharp`), else the project toolchain (`go.mod` → `go`,
a `.csproj`/`.sln` → `csharp`, otherwise `javascript`).

A rule file (`.sluice/rules/<id>.yaml`):

```yaml
id: no-immediate-cancel
message: CANCEL-1 cancels at period end
severity: error
language: go
pattern: stripe.CancelNow($$$)
paths: [billing/] # optional
```

Go and C# pattern examples:

```yaml
# Go
pattern: stripe.CancelNow($$$) # any arity
pattern: defer $X.Close() # statements
pattern: $A, $ERR := subscription.Cancel($$$)
pattern: import "github.com/acme/legacy"
pattern: stripe.Key # package-qualified identifier
# C#
pattern: await $S.CancelAsync($$$)
pattern: new SubscriptionService($$$)
pattern: StripeConfiguration.ApiKey
pattern: using Legacy.Billing;
pattern: $A * $B
```

Full ast-grep rule objects (`rule: { pattern, inside, has, not, all, any }`)
work for every language; node kinds are tree-sitter's (`function_declaration`,
`method_declaration`, `invocation_expression`, …).

Gotchas (handled for you in `pattern` strings, including `pattern` keys inside
rule objects):

- **Go:** at the top level of a file `pkg.Fn(x)` parses as a _type conversion_
  and `pkg.Name` as a _qualified type_, so a naive pattern silently misses
  calls. Sluice parses Go expression/statement patterns inside a function body
  (`{context: 'package _\nfunc _() {\n<pattern>\n}', selector: <kind>}`);
  declarations (`package`, `import`, `func`, `type`, `var`, `const`) are used
  as written. Hand-written `{context, selector}` patterns are passed through.
- **C#:** `$A * $B` on its own is a pointer declaration and `Foo.Bar` an
  ERROR; such expressions are parsed on the right of an assignment
  (`_ = <pattern>;`). End a pattern with `;` to match a whole statement.
- Metavariables are `$NAME` (one node), `$$$NAME` / `$$$` (zero or more), as for
  JS; Go/C# use ast-grep's `µ` expando internally, so don't use `µ` in patterns.
