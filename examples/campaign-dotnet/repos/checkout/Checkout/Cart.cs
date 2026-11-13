using Acme.Shared;

namespace Acme.Checkout;

public record Line(string Name, double Price, int Qty);

public static class Cart
{
#pragma warning disable CS0618
    public static string Total(IEnumerable<Line> lines) => "Total: " + Money.FormatDollars(lines.Sum(l => l.Price * l.Qty));
#pragma warning restore CS0618
}
