using System.Text.Json;

namespace BillingDemo;

public static class Server
{
    private static async Task<Dictionary<string, JsonElement>> ReadJson(HttpRequest req)
    {
        using var reader = new StreamReader(req.Body);
        var text = await reader.ReadToEndAsync();
        if (text.Length == 0) return [];
        try
        {
            return JsonSerializer.Deserialize<Dictionary<string, JsonElement>>(text) ?? [];
        }
        catch (JsonException)
        {
            throw new HttpError(400, "invalid JSON body");
        }
    }

    private static IResult Json(int status, object payload) => Results.Json(payload, statusCode: status);

    public static WebApplication CreateApp(Billing billing, string[]? args = null)
    {
        var builder = WebApplication.CreateSlimBuilder(args ?? []);
        builder.Logging.ClearProviders();
        var app = builder.Build();
        app.Use(async (ctx, next) =>
        {
            try
            {
                await next(ctx);
            }
            catch (HttpError e)
            {
                await Json(e.Status, new { error = e.Message }).ExecuteAsync(ctx);
            }
            catch (Exception e)
            {
                Console.Error.WriteLine(e);
                await Json(500, new { error = "internal error" }).ExecuteAsync(ctx);
            }
        });

        app.MapGet("/health", () => Json(200, new { ok = true }));
        app.MapPost("/customers", async (HttpRequest req) => Json(201, await billing.CreateCustomer(await ReadJson(req))));
        app.MapGet("/customers/{id:long}/access", async (long id) => Json(200, await billing.Access(id)));
        app.MapPost("/subscriptions", async (HttpRequest req) => Json(201, await billing.Subscribe(await ReadJson(req))));
        app.MapGet("/subscriptions/{id:long}", async (long id) => Json(200, await billing.GetSubscription(id)));
        app.MapPost("/subscriptions/{id:long}/cancel", async (long id) => Json(200, await billing.Cancel(id)));
        app.MapPost("/jobs/sync-subscriptions", async () => Json(200, await billing.SyncSubscriptions()));
        app.MapFallback(() => Json(404, new { error = "not found" }));
        return app;
    }

    public static async Task Main(string[] args)
    {
        var db = PostgresDb.Create(Environment.GetEnvironmentVariable("DATABASE_URL") ?? "");
        await db.Migrate();
        var billing = new Billing(db, StripeClient.FromEnvironment());
        var port = Environment.GetEnvironmentVariable("PORT") ?? "3000";
        var app = CreateApp(billing, args);
        app.Urls.Add($"http://0.0.0.0:{port}");
        await app.StartAsync();
        Console.Error.WriteLine($"billing-demo listening on :{port}");
        await app.WaitForShutdownAsync();
    }
}
