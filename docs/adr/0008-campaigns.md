# ADR-0008: Campaigns — evidence-gated multi-repo migrations

- Status: accepted
- Date: 2026-11-13

## Context

Cross-repo changes (API deprecations, schema moves) follow expand → migrate →
contract. The dangerous part is the _contract_ step: removing the old thing
before every consumer has really moved breaks production.

## Decision

- A campaign (`campaign.yaml`) lists repositories and ordered steps. Each step
  targets some repos and has an `apply` (`copy` overlay, structural `codemod`
  on ast-grep with metavariable templates, or `command`) and **mandatory
  evidence** (a campaign without evidence on every step is rejected).
- Evidence kinds: `tests` — run in a no-network container against a
  side-by-side snapshot of **every repo's current campaign branch**
  (`scope: all` re-tests every repo, which is how consumers prove they work
  against the changed library); `rule` — an ast-grep invariant (e.g. no
  `formatDollars($$$)` left).
- Work happens on `campaign/<id>` branches; each applied step is a commit, so
  **rollback** is `reset --hard` to the step's recorded `before` sha (automatic
  on failure; manual via `sluice campaign rollback`).
- Gating: a failing step is rolled back and halts the campaign; every later
  `destructive` step is marked **blocked** with the reason. A destructive step
  also re-checks that every earlier step passed in every repo before running.
- State (`.sluice/campaigns/<id>.json`) makes campaigns resumable: passed
  steps are skipped; fixed definitions continue from the failure.

## Consequences

- Repos are local git checkouts; pushing branches/opening PRs per repo is left
  to the surrounding tooling (the GitHub client can do it) in v0.1.
