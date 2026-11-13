using System.Text.Json;

namespace BillingDemo;

/// <summary>Domain events are emitted as JSON lines on stdout ({"event": ...}).</summary>
public static class Events
{
    private static readonly object Gate = new();

    public static void Emit(string evt, Dictionary<string, object?> data)
    {
        var payload = new Dictionary<string, object?> { ["event"] = evt };
        foreach (var (k, v) in data) payload[k] = v;
        var line = JsonSerializer.Serialize(payload);
        lock (Gate)
        {
            Console.Out.WriteLine(line);
            Console.Out.Flush();
        }
    }
}

/// <summary>The application clock (UTC).</summary>
public static class Clock
{
    public static Func<DateTime> UtcNow { get; set; } = () => DateTime.UtcNow;
}
