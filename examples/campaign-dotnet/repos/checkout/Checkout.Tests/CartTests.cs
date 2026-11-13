using Acme.Checkout;
using Xunit;

namespace Checkout.Tests;

public class CartTests
{
    [Fact]
    public void RendersTotal() =>
        Assert.Equal("Total: $8.25", Cart.Total([new Line("tea", 2.5, 2), new Line("cake", 3.25, 1)]));
}
