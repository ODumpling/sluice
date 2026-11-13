using System.Globalization;

namespace Acme.Shared;

public static class Money
{
    /// <summary>Dollars to integer cents (rounded half away from zero).</summary>
    public static long ToCents(double amount) => (long)Math.Round(amount * 100, MidpointRounding.AwayFromZero);

    /// <summary>Formats integer cents.</summary>
    public static string FormatCents(long cents) =>
        (cents < 0 ? "-" : "") + "$" + (Math.Abs(cents) / 100) + "." + (Math.Abs(cents) % 100).ToString("00");
}
