using Xunit;

namespace Money.Tests;

public class CentsTests
{
    [Theory]
    [InlineData(1250, "$12.50")]
    [InlineData(5, "$0.05")]
    [InlineData(-199, "-$1.99")]
    public void FormatsCents(long cents, string expected) => Assert.Equal(expected, Acme.Shared.Money.FormatCents(cents));

    [Fact]
    public void RoundsToCents() => Assert.Equal(30, Acme.Shared.Money.ToCents(0.1 + 0.2));
}
