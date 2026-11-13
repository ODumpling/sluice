using System.Globalization;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace BillingDemo;

public sealed record Plan(string Name, int AmountCents, string Interval);

/// <summary>An error with an HTTP status for the API response.</summary>
public sealed class HttpError(int status, string message) : Exception(message)
{
    public int Status { get; } = status;
}

public sealed record SubscriptionView(
    [property: JsonPropertyName("id")] long Id,
    [property: JsonPropertyName("customer_id")] long CustomerId,
    [property: JsonPropertyName("plan")] string Plan,
    [property: JsonPropertyName("status")] string Status,
    [property: JsonPropertyName("current_period_end")] string CurrentPeriodEnd,
    [property: JsonPropertyName("cancel_at")] string? CancelAt,
    [property: JsonPropertyName("canceled_at")] string? CanceledAt);

public sealed record CustomerView(
    [property: JsonPropertyName("id")] long Id,
    [property: JsonPropertyName("email")] string Email,
    [property: JsonPropertyName("name")] string? Name);

public sealed record AccessView(
    [property: JsonPropertyName("customer_id")] long CustomerId,
    [property: JsonPropertyName("has_access")] bool HasAccess,
    [property: JsonPropertyName("plan")] string? Plan,
    [property: JsonPropertyName("access_until")] string? AccessUntil);

public sealed record SyncResult(
    [property: JsonPropertyName("checked")] int Checked,
    [property: JsonPropertyName("changed")] int Changed);

public sealed class Billing(IDb db, IStripe stripe)
{
    public static readonly Dictionary<string, Plan> Plans = new()
    {
        ["pro_monthly"] = new Plan("Pro", 2000, "month"),
    };

    /// <summary>Formats an instant like JavaScript's Date#toISOString.</summary>
    public static string Iso(DateTime t) =>
        t.ToUniversalTime().ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture);

    private static DateTime FromUnix(long sec) => DateTimeOffset.FromUnixTimeSeconds(sec).UtcDateTime;

    private static string? IsoOrNull(object? v) => v is DateTime t ? Iso(t) : null;

    private static SubscriptionView RowToSubscription(Dictionary<string, object?> row) => new(
        Convert.ToInt64(row["id"]),
        Convert.ToInt64(row["customer_id"]),
        (string)row["plan"]!,
        (string)row["status"]!,
        Iso((DateTime)row["current_period_end"]!),
        IsoOrNull(row["cancel_at"]),
        IsoOrNull(row["canceled_at"]));

    private async Task<Dictionary<string, object?>?> One(string sql, params object?[] args) =>
        (await db.Query(sql, args)).FirstOrDefault();

    private static long ToLong(JsonElement? v) => v switch
    {
        { ValueKind: JsonValueKind.Number } n => (long)n.GetDouble(),
        { ValueKind: JsonValueKind.String } s => long.TryParse(s.GetString(), out var i) ? i : 0,
        _ => 0,
    };

    private static string? Str(Dictionary<string, JsonElement> body, string key) =>
        body.TryGetValue(key, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;

    private async Task<Dictionary<string, object?>> EnsurePlan(string code)
    {
        if (!Plans.TryGetValue(code, out var plan)) throw new HttpError(400, $"unknown plan {code}");
        var existing = await One("SELECT * FROM plans WHERE code = $1", code);
        if (existing != null) return existing;
        var found = await stripe.ListPrices(new() { { "lookup_keys[0]", code }, { "limit", "1" } });
        var priceId = found.FirstOrDefault()?.Id;
        if (priceId == null)
        {
            var product = await stripe.CreateProduct(new() { { "name", plan.Name } });
            var price = await stripe.CreatePrice(new()
            {
                { "product", product.Id },
                { "currency", "usd" },
                { "unit_amount", plan.AmountCents.ToString(CultureInfo.InvariantCulture) },
                { "recurring[interval]", plan.Interval },
                { "lookup_key", code },
            });
            priceId = price.Id;
        }
        return (await One(
            "INSERT INTO plans (code, stripe_price_id, amount_cents, interval) VALUES ($1, $2, $3, $4) RETURNING *",
            code, priceId, plan.AmountCents, plan.Interval))!;
    }

    private async Task<Dictionary<string, object?>> GetSubscriptionRow(long id) =>
        await One("SELECT * FROM subscriptions WHERE id = $1", (int)id)
        ?? throw new HttpError(404, $"subscription {id} not found");

    public async Task<CustomerView> CreateCustomer(Dictionary<string, JsonElement> body)
    {
        var email = Str(body, "email");
        if (email == null || !email.Contains('@')) throw new HttpError(400, "valid email required");
        if (await One("SELECT id FROM customers WHERE email = $1", email) != null)
            throw new HttpError(409, "email already registered");
        var name = Str(body, "name");
        var p = new StripeParams { { "email", email } };
        if (name != null) p.Add("name", name);
        var sc = await stripe.CreateCustomer(p);
        var row = (await One(
            "INSERT INTO customers (email, name, stripe_customer_id, created_at) VALUES ($1, $2, $3, $4) RETURNING *",
            email, name, sc.Id, Clock.UtcNow()))!;
        Events.Emit("customer.created", new() { ["customer_id"] = Convert.ToInt64(row["id"]) });
        return new CustomerView(Convert.ToInt64(row["id"]), (string)row["email"]!, row["name"] as string);
    }

    public async Task<SubscriptionView> Subscribe(Dictionary<string, JsonElement> body)
    {
        body.TryGetValue("customer_id", out var rawCustomerId);
        var customerId = ToLong(rawCustomerId);
        var plan = Str(body, "plan") ?? "pro_monthly";
        var customer = await One("SELECT * FROM customers WHERE id = $1", (int)customerId)
            ?? throw new HttpError(404, $"customer {customerId} not found");
        if (await One("SELECT id FROM subscriptions WHERE customer_id = $1 AND status IN ('active', 'past_due')",
                (int)customerId) != null)
            throw new HttpError(409, "customer already has an active subscription");
        var p = await EnsurePlan(plan);
        var sub = await stripe.CreateSubscription(new()
        {
            { "customer", (string)customer["stripe_customer_id"]! },
            { "items[0][price]", (string)p["stripe_price_id"]! },
            { "metadata[customer_id]", customerId.ToString(CultureInfo.InvariantCulture) },
        });
        var now = Clock.UtcNow();
        var row = (await One(
            """
            INSERT INTO subscriptions (customer_id, plan, stripe_subscription_id, status, current_period_end, created_at, updated_at)
                     VALUES ($1, $2, $3, $4, $5, $6, $6) RETURNING *
            """,
            (int)customerId, plan, sub.Id, sub.Status, FromUnix(sub.Items.Data[0].CurrentPeriodEnd), now))!;
        Events.Emit("subscription.created",
            new() { ["subscription_id"] = Convert.ToInt64(row["id"]), ["customer_id"] = customerId });
        return RowToSubscription(row);
    }

    /// <summary>CANCEL-1: cancellation takes effect at the end of the current period.</summary>
    public async Task<SubscriptionView> Cancel(long id)
    {
        var row = await GetSubscriptionRow(id);
        if ((string)row["status"]! == "canceled" || row["cancel_at"] != null)
            throw new HttpError(409, "subscription already canceled");
        var s = await stripe.UpdateSubscription((string)row["stripe_subscription_id"]!,
            new() { { "cancel_at_period_end", "true" } });
        var cancelAt = FromUnix(s.CancelAt!.Value);
        var updated = (await One("UPDATE subscriptions SET cancel_at = $2, updated_at = $3 WHERE id = $1 RETURNING *",
            (int)id, cancelAt, Clock.UtcNow()))!;
        Events.Emit("subscription.cancel_scheduled",
            new() { ["subscription_id"] = id, ["cancel_at"] = Iso(cancelAt) });
        return RowToSubscription(updated);
    }

    public async Task<SubscriptionView> GetSubscription(long id) => RowToSubscription(await GetSubscriptionRow(id));

    public async Task<AccessView> Access(long customerId)
    {
        var sub = await One("SELECT * FROM subscriptions WHERE customer_id = $1 ORDER BY id DESC LIMIT 1",
            (int)customerId);
        var now = Clock.UtcNow();
        var hasAccess = sub != null && (string)sub["status"]! != "canceled" && (DateTime)sub["current_period_end"]! > now;
        return new AccessView(
            customerId,
            hasAccess,
            hasAccess ? (string)sub!["plan"]! : null,
            hasAccess ? IsoOrNull(sub!["cancel_at"] ?? sub["current_period_end"]) : null);
    }

    /// <summary>Pull subscription state from Stripe (renewals, scheduled cancellations).</summary>
    public async Task<SyncResult> SyncSubscriptions()
    {
        var rows = await db.Query("SELECT * FROM subscriptions WHERE status <> 'canceled' ORDER BY id");
        var changed = 0;
        foreach (var row in rows)
        {
            var s = await stripe.RetrieveSubscription((string)row["stripe_subscription_id"]!);
            var periodEnd = FromUnix(s.Items.Data[0].CurrentPeriodEnd);
            DateTime? cancelAt = s.CancelAt is { } ca ? FromUnix(ca) : null;
            DateTime? canceledAt = s.EndedAt is { } ea ? FromUnix(ea) : null;
            var status = (string)row["status"]!;
            if (s.Status != status || periodEnd != (DateTime)row["current_period_end"]! || cancelAt != (DateTime?)row["cancel_at"])
            {
                await db.Query(
                    "UPDATE subscriptions SET status = $2, current_period_end = $3, cancel_at = $4, canceled_at = COALESCE($5, canceled_at), updated_at = $6 WHERE id = $1",
                    row["id"], s.Status, periodEnd, cancelAt, canceledAt, Clock.UtcNow());
                if (s.Status != status) Events.Emit($"subscription.{s.Status}", new() { ["subscription_id"] = Convert.ToInt64(row["id"]) });
                changed++;
            }
        }
        return new SyncResult(rows.Count, changed);
    }
}
