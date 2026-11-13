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
