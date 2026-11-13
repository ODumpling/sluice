using System.Text.Json;
using BillingDemo;
using Xunit;

namespace BillingDemo.Tests;

public class BillingTests
{
    private static Dictionary<string, JsonElement> Body(object o) =>
        JsonSerializer.Deserialize<Dictionary<string, JsonElement>>(JsonSerializer.Serialize(o))!;

    [Fact]
    public async Task CreateCustomerRejectsInvalidEmail()
    {
        var billing = new Billing(new FakeDb(), new FakeStripe());
        var e = await Assert.ThrowsAsync<HttpError>(() => billing.CreateCustomer(Body(new { email = "nope" })));
        Assert.Equal(400, e.Status);
    }

    [Fact]
    public async Task CreateCustomerStoresTheStripeCustomerId()
    {
        var inserted = new List<object?[]>();
        var db = new FakeDb()
            .On("SELECT id FROM customers", _ => [])
            .On("INSERT INTO customers", p =>
            {
                inserted.Add(p);
                return [new() { ["id"] = 1, ["email"] = p[0], ["name"] = p[1] }];
            });
        var stripe = new FakeStripe { OnCreateCustomer = _ => new StripeCustomer("cus_123") };
        var c = await new Billing(db, stripe).CreateCustomer(Body(new { email = "a@b.co", name = "A" }));
        Assert.Equal(new CustomerView(1, "a@b.co", "A"), c);
        Assert.Equal("cus_123", inserted[0][2]);
    }
}
