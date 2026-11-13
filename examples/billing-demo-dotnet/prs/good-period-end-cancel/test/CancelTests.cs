using BillingDemo;
using Xunit;

namespace BillingDemo.Tests;

public class CancelTests
{
    [Fact]
    public async Task CancelSchedulesCancellationAtPeriodEnd()
    {
        var updates = new List<(string Id, StripeParams Params)>();
        var end = new DateTime(2030, 2, 15, 12, 0, 0, DateTimeKind.Utc);
        var db = new FakeDb()
            .On("SELECT * FROM subscriptions", _ =>
            [
                new()
                {
                    ["id"] = 1, ["status"] = "active", ["stripe_subscription_id"] = "sub_1", ["plan"] = "pro_monthly",
                    ["customer_id"] = 1, ["current_period_end"] = end, ["cancel_at"] = null, ["canceled_at"] = null,
                },
            ])
            .On("UPDATE subscriptions", p =>
            [
                new()
                {
                    ["id"] = 1, ["status"] = "active", ["plan"] = "pro_monthly", ["customer_id"] = 1,
                    ["current_period_end"] = end, ["cancel_at"] = p[1], ["canceled_at"] = null,
                },
            ]);
        var stripe = new FakeStripe
        {
            OnUpdateSubscription = (id, p) =>
            {
                updates.Add((id, p));
                return new StripeSubscription(id, "active", true, new DateTimeOffset(end).ToUnixTimeSeconds(), null, new([]));
            },
        };
        var sub = await new Billing(db, stripe).Cancel(1);
        var update = Assert.Single(updates);
        Assert.Equal("sub_1", update.Id);
        Assert.Equal([new KeyValuePair<string, string>("cancel_at_period_end", "true")], update.Params);
        Assert.Equal("active", sub.Status);
        Assert.Equal(Billing.Iso(end), sub.CancelAt);
    }
}
