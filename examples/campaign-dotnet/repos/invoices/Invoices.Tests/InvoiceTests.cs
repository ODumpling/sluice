using Acme.Invoices;
using Xunit;

namespace Invoices.Tests;

public class InvoiceTests
{
    [Fact]
    public void Summarizes() => Assert.Equal("INV-1: $107.50 (tax $7.50)", new Invoice("INV-1", 107.5, 7.5).Summary());
}
