using System.Net.Http.Headers;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace BillingDemo;

public sealed record StripeCustomer([property: JsonPropertyName("id")] string Id);

public sealed record StripeProduct([property: JsonPropertyName("id")] string Id);

public sealed record StripePrice([property: JsonPropertyName("id")] string Id);

public sealed record StripeList<T>([property: JsonPropertyName("data")] List<T> Data);

public sealed record StripeSubscriptionItem([property: JsonPropertyName("current_period_end")] long CurrentPeriodEnd);

public sealed record StripeSubscription(
    [property: JsonPropertyName("id")] string Id,
    [property: JsonPropertyName("status")] string Status,
    [property: JsonPropertyName("cancel_at_period_end")] bool CancelAtPeriodEnd,
    [property: JsonPropertyName("cancel_at")] long? CancelAt,
    [property: JsonPropertyName("ended_at")] long? EndedAt,
    [property: JsonPropertyName("items")] StripeList<StripeSubscriptionItem> Items);

/// <summary>Form parameters in Stripe's bracketed encoding (items[0][price]=…).</summary>
public sealed class StripeParams : List<KeyValuePair<string, string>>
{
    public void Add(string key, string value) => Add(new KeyValuePair<string, string>(key, value));
}

/// <summary>The subset of the Stripe API the app uses.</summary>
public interface IStripe
{
    Task<StripeCustomer> CreateCustomer(StripeParams p);
    Task<List<StripePrice>> ListPrices(StripeParams p);
    Task<StripeProduct> CreateProduct(StripeParams p);
    Task<StripePrice> CreatePrice(StripeParams p);
    Task<StripeSubscription> CreateSubscription(StripeParams p);
    Task<StripeSubscription> RetrieveSubscription(string id);
    Task<StripeSubscription> UpdateSubscription(string id, StripeParams p);
    Task<StripeSubscription> CancelSubscription(string id);
}

public sealed class StripeException(int status, string message) : Exception($"stripe: {status} {message}")
{
    public int Status { get; } = status;
}

/// <summary>Stripe REST client. STRIPE_API_BASE lets the app run against the Sluice Stripe fake.</summary>
public sealed class StripeClient : IStripe
{
    public const string ApiVersion = "2026-09-30.endive";
    private readonly HttpClient http;

    public StripeClient(string? apiBase, string? secretKey)
    {
        http = new HttpClient
        {
            BaseAddress = new Uri((string.IsNullOrEmpty(apiBase) ? "https://api.stripe.com" : apiBase).TrimEnd('/') + "/"),
            Timeout = TimeSpan.FromSeconds(80),
        };
        http.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", secretKey ?? "");
        http.DefaultRequestHeaders.Add("Stripe-Version", ApiVersion);
        http.DefaultRequestHeaders.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
    }

    public static StripeClient FromEnvironment() =>
        new(Environment.GetEnvironmentVariable("STRIPE_API_BASE"), Environment.GetEnvironmentVariable("STRIPE_SECRET_KEY"));

    private async Task<T> Send<T>(HttpMethod method, string path, StripeParams? p = null)
    {
        var uri = path.TrimStart('/');
        HttpContent? content = null;
        if (p is { Count: > 0 })
        {
            if (method == HttpMethod.Get) uri += "?" + await new FormUrlEncodedContent(p).ReadAsStringAsync();
            else content = new FormUrlEncodedContent(p);
        }
        using var req = new HttpRequestMessage(method, uri) { Content = content };
        using var res = await http.SendAsync(req);
        var body = await res.Content.ReadAsStringAsync();
        if (!res.IsSuccessStatusCode)
        {
            var message = "";
            try
            {
                message = JsonDocument.Parse(body).RootElement.GetProperty("error").GetProperty("message").GetString() ?? "";
            }
            catch (Exception)
            {
                // not a Stripe error body
            }
            throw new StripeException((int)res.StatusCode, message);
        }
        return JsonSerializer.Deserialize<T>(body)!;
    }

    public Task<StripeCustomer> CreateCustomer(StripeParams p) => Send<StripeCustomer>(HttpMethod.Post, "/v1/customers", p);

    public async Task<List<StripePrice>> ListPrices(StripeParams p) =>
        (await Send<StripeList<StripePrice>>(HttpMethod.Get, "/v1/prices", p)).Data;

    public Task<StripeProduct> CreateProduct(StripeParams p) => Send<StripeProduct>(HttpMethod.Post, "/v1/products", p);

    public Task<StripePrice> CreatePrice(StripeParams p) => Send<StripePrice>(HttpMethod.Post, "/v1/prices", p);

    public Task<StripeSubscription> CreateSubscription(StripeParams p) =>
        Send<StripeSubscription>(HttpMethod.Post, "/v1/subscriptions", p);

    public Task<StripeSubscription> RetrieveSubscription(string id) =>
        Send<StripeSubscription>(HttpMethod.Get, $"/v1/subscriptions/{Uri.EscapeDataString(id)}");

    public Task<StripeSubscription> UpdateSubscription(string id, StripeParams p) =>
        Send<StripeSubscription>(HttpMethod.Post, $"/v1/subscriptions/{Uri.EscapeDataString(id)}", p);

    public Task<StripeSubscription> CancelSubscription(string id) =>
        Send<StripeSubscription>(HttpMethod.Delete, $"/v1/subscriptions/{Uri.EscapeDataString(id)}");
}
