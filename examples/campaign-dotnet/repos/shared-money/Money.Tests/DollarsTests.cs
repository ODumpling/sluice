using Acme.Shared;
using Xunit;

namespace Money.Tests;

public class DollarsTests
{
#pragma warning disable CS0618 // the deprecated API is still under test until the contract step
    [Fact]
    public void FormatsDollars() => Assert.Equal("$12.50", Acme.Shared.Money.FormatDollars(12.5));
#pragma warning restore CS0618
}
