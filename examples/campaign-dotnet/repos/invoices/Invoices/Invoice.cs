using Acme.Shared;

namespace Acme.Invoices;

public record Invoice(string Id, double Total, double Tax)
{
#pragma warning disable CS0618
    public string Summary() => $"{Id}: {Money.FormatDollars(Total)} (tax {Money.FormatDollars(Tax)})";
#pragma warning restore CS0618
}
