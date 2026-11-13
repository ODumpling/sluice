# GitHub

## GitHub Action

```yaml
# .github/workflows/sluice.yml
on: pull_request
permissions: { checks: write, contents: read }
jobs:
  gate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - uses: ODumpling/sluice/surfaces/github/action@v0.1.0
        with:
          ticket: CANCEL-1 # default: [TICKET-1] / "Ticket: X" in the PR title or body
```

The action runs `sluice gate run --github-check` and uploads the HTML report as
an artifact.

## "Sluice Gate" GitHub App

`surfaces/github/app.yml` is an app manifest (checks: write, contents: read,
pull_requests: read; `pull_request` events). Run the webhook server:

```sh
SLUICE_APP_ID=123 SLUICE_APP_PRIVATE_KEY_FILE=key.pem SLUICE_WEBHOOK_SECRET=… \
  node surfaces/github/bin/sluice-gate-app.js
```

On `opened`/`synchronize`/`reopened` it verifies the webhook signature,
exchanges an RS256 App JWT for an installation token, creates an
`in_progress` check, clones the repo, runs the gate on base..head and
completes the check with the verdict and Markdown report. PRs without a ticket
get a neutral check.
