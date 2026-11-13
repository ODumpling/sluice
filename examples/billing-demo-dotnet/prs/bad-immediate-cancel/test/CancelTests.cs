using BillingDemo;
using Xunit;

namespace BillingDemo.Tests;

public class CancelTests
{
    [Fact]
    public async Task CancelCancelsTheSubscriptionInStripeAndMarksItCanceled()
    {
        var canceled = new List<string>();
        var db = new FakeDb()
            .On("SELECT * FROM subscriptions", _ =>
            [
                new()
                {
                    ["id"] = 1, ["status"] = "active", ["stripe_subscription_id"] = "sub_1", ["plan"] = "pro_monthly",
                    ["customer_id"] = 1, ["current_period_end"] = DateTime.UtcNow, ["cancel_at"] = null,
                    ["canceled_at"] = null,
                },
            ])
            .On("UPDATE subscriptions", _ =>
            [
                new()
                {
                    ["id"] = 1, ["status"] = "canceled", ["plan"] = "pro_monthly", ["customer_id"] = 1,
                    ["current_period_end"] = DateTime.UtcNow, ["cancel_at"] = null, ["canceled_at"] = DateTime.UtcNow,
                },
            ]);
        var stripe = new FakeStripe
        {
            OnCancelSubscription = id =>
            {
                canceled.Add(id);
                return new StripeSubscription(id, "canceled", false, null, null, new([]));
            },
        };
        var sub = await new Billing(db, stripe).Cancel(1);
        Assert.Equal(["sub_1"], canceled);
        Assert.Equal("canceled", sub.Status);
    }
}
