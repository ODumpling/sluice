using BillingDemo;

namespace BillingDemo.Tests;

/// <summary>Answers queries by SQL prefix, like the Node tests' fakeDb.</summary>
public sealed class FakeDb : IDb
{
    private readonly List<(string Prefix, Func<object?[], List<Dictionary<string, object?>>> Handler)> handlers = [];

    public FakeDb On(string prefix, Func<object?[], List<Dictionary<string, object?>>> handler)
    {
        handlers.Add((prefix, handler));
        return this;
    }

    public Task<List<Dictionary<string, object?>>> Query(string sql, params object?[] args)
    {
        foreach (var (prefix, handler) in handlers)
            if (sql.Trim().StartsWith(prefix, StringComparison.Ordinal)) return Task.FromResult(handler(args));
        throw new InvalidOperationException($"unexpected SQL: {sql}");
    }
}

/// <summary>Implements the Stripe calls a test sets; anything else throws.</summary>
public sealed class FakeStripe : IStripe
{
    public Func<StripeParams, StripeCustomer>? OnCreateCustomer { get; init; }
    public Func<string, StripeParams, StripeSubscription>? OnUpdateSubscription { get; init; }
    public Func<string, StripeSubscription>? OnCancelSubscription { get; init; }

    private static T Unexpected<T>(string call) => throw new InvalidOperationException($"unexpected Stripe call {call}");

    public Task<StripeCustomer> CreateCustomer(StripeParams p) =>
        Task.FromResult(OnCreateCustomer is { } f ? f(p) : Unexpected<StripeCustomer>("customers.create"));

    public Task<List<StripePrice>> ListPrices(StripeParams p) => Unexpected<Task<List<StripePrice>>>("prices.list");

    public Task<StripeProduct> CreateProduct(StripeParams p) => Unexpected<Task<StripeProduct>>("products.create");

    public Task<StripePrice> CreatePrice(StripeParams p) => Unexpected<Task<StripePrice>>("prices.create");

    public Task<StripeSubscription> CreateSubscription(StripeParams p) =>
        Unexpected<Task<StripeSubscription>>("subscriptions.create");

    public Task<StripeSubscription> RetrieveSubscription(string id) =>
        Unexpected<Task<StripeSubscription>>("subscriptions.retrieve");

    public Task<StripeSubscription> UpdateSubscription(string id, StripeParams p) =>
        Task.FromResult(OnUpdateSubscription is { } f ? f(id, p) : Unexpected<StripeSubscription>("subscriptions.update"));

    public Task<StripeSubscription> CancelSubscription(string id) =>
        Task.FromResult(OnCancelSubscription is { } f ? f(id) : Unexpected<StripeSubscription>("subscriptions.cancel"));
}
