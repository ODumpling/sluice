using System.Globalization;

namespace Acme.Shared;

public static class Money
{
    /// <summary>Formats a dollar amount.</summary>
    [Obsolete("doubles lose cents; use FormatCents")]
    public static string FormatDollars(double amount) => "$" + amount.ToString("0.00", CultureInfo.InvariantCulture);
}
