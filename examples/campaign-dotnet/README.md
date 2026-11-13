# campaign example (.NET)

The [Node campaign](../campaign/README.md) on three .NET solutions: `shared-money` (library), `checkout` and `invoices` (consumers, built against the sibling library checkout), and `campaign.yaml` — expand → migrate (C# codemod) → contract from `FormatDollars` (double) to `FormatCents` (integer cents).

No image or dependency setup is configured: evidence runs in the detected toolchain's image after a prepare step (`dotnet restore`, network at image build time only); the tests themselves run offline.

Each `repos/*` directory must be a git repository (the e2e test initializes them); then `sluice campaign run campaign.yaml`. See [docs/guide/campaigns.md](../../docs/guide/campaigns.md#go-and-net).
