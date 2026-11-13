using System.Globalization;

namespace Acme.Shared;

public static class Money
{
    /// <summary>Formats a dollar amount.</summary>
    [Obsolete("doubles lose cents; use FormatCents")]
    public static string FormatDollars(double amount) => "$" + amount.ToString("0.00", CultureInfo.InvariantCulture);

    /// <summary>Dollars to integer cents (rounded half away from zero).</summary>
    public static long ToCents(double amount) => (long)Math.Round(amount * 100, MidpointRounding.AwayFromZero);

    /// <summary>Formats integer cents.</summary>
    public static string FormatCents(long cents) =>
        (cents < 0 ? "-" : "") + "$" + (Math.Abs(cents) / 100) + "." + (Math.Abs(cents) % 100).ToString("00");
}
