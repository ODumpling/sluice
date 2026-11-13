// Fixture for the dotnet determinism shim: a tiny HTTP service exposing the
// clock, every common randomness source, event emission and egress probes.
using System.Diagnostics;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text.Json;

var builder = WebApplication.CreateBuilder(args);
builder.Logging.ClearProviders();
builder.WebHost.UseUrls($"http://0.0.0.0:{Environment.GetEnvironmentVariable("PORT") ?? "8080"}");
var app = builder.Build();
var boot = DateTime.UtcNow;
var seeded = new Random();

app.MapGet("/health", () => new { ok = true });
app.MapGet("/now", () => new
{
    ms = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
    iso = DateTime.UtcNow.ToString("O"),
    local = DateTime.Now.ToUniversalTime().ToString("O"),
    sinceBoot = (long)(DateTime.UtcNow - boot).TotalMilliseconds,
    uptimeTicking = Stopwatch.GetTimestamp() > 0,
});
app.MapGet("/rand", () => new
{
    shared = Random.Shared.NextInt64(),
    unseeded = seeded.NextInt64(),
    fresh = new Random().NextInt64(),
    rng = Convert.ToHexString(RandomNumberGenerator.GetBytes(8)),
    rngInt = RandomNumberGenerator.GetInt32(1_000_000),
    hash = "x".GetHashCode() != 0,
});
app.MapGet("/uuid", () => new { uuid = Guid.NewGuid(), v7 = Guid.CreateVersion7() });
app.MapGet("/emit", (string name) =>
{
    // several events per request, a partial write and a non-event line
    Console.WriteLine(JsonSerializer.Serialize(new { @event = name, seq = 1, at = DateTime.UtcNow.ToString("O") }));
    Console.Write($"{{\"event\":\"{name}.second\",");
    Console.WriteLine("\"seq\":2}");
    Console.WriteLine("{\"level\":\"info\",\"msg\":\"not an event\"}");
    Console.Out.Write(JsonSerializer.Serialize(new { @event = name + ".third", seq = 3 }) + "\n");
    return new { emitted = name };
});
// half an event line per request: the host reads /events in between
app.MapGet("/partial", (int part) =>
{
    if (part == 1) Console.Write("{\"event\":\"split\",");
    else Console.WriteLine("\"seq\":9}");
    return new { ok = true };
});
app.MapGet("/egress", async () =>
{
    string https, tcp;
    using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(3) };
    try { await http.GetAsync("https://api.stripe.com/v1/charges"); https = "REACHED"; }
    catch { https = "BLOCKED"; }
    try
    {
        using var c = new TcpClient();
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(3));
        await c.ConnectAsync("1.1.1.1", 443, cts.Token);
        tcp = "REACHED";
    }
    catch { tcp = "BLOCKED"; }
    return new { https, tcp };
});

Console.WriteLine("listening");
app.Run();
