# campaign example

Three repositories — `shared-money` (library), `checkout` and `invoices` (consumers) — and `campaign.yaml`, an expand → migrate (codemod) → contract migration from `formatDollars` (float) to `formatCents` (integer cents). Every step is evidence-gated; the destructive `contract` step only runs once both consumers migrated.

Each `repos/*` directory must be a git repository (the e2e test initializes them); then `sluice campaign run campaign.yaml`. See [docs/guide/campaigns.md](../../docs/guide/campaigns.md).
