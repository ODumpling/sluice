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
sluice rules prove review-stripe-subscriptions-cancel --bad <commit> --main main
sluice rules check --base main --head HEAD
sluice rules from-pr --repo acme/app --pr 42        # GitHub comments
```

Candidates come from code spans in the comment (calls generalized to
`callee($$$)`) or the commented line. A rule is **adopted only if proven**: it
flags lines the bad commit changed and finds nothing on main. Rules are
structural (ast-grep), so comments and strings never match.
