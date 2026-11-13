using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;

public enum Status { Active = 1, Cancelled = 2 }

public record Invoice(string Id, int Amount, bool Paid);

public interface IStore { Task<Invoice?> GetAsync(string id); }

public class Billing
{
    private readonly IStore _store;
    private int _count;
    public const int Limit = 100;
    public string Prefix { get; set; } = "inv";
    public int Count => _count;
    public bool Enabled { get => _count > 0; set => _count = value ? 1 : 0; }

    public Billing(IStore store) { _store = store; }

    public int Total(IEnumerable<int> items, int discount)
    {
        if (!items.Any()) return 0;
        var sum = 0;
        foreach (var it in items) sum += it * 2;
        if (sum > Limit && discount >= 0 || !Enabled)
        {
            sum = sum - discount / 2;
        }
        return sum;
    }

    public string Name(string first, string last)
    {
        var full = first + " " + last;
        string greeting = "hi";
        var msg = greeting + full + $"!{_count}";
        Console.WriteLine("name {0}", msg);
        return msg.Trim();
    }

    public string Kind(int n)
    {
        switch (n)
        {
            case 1: return "one";
            case 2: return "two";
            case 3 or 4: return "";
        }
        var d = new Dictionary<string, int> { { "a", 1 }, { "b", 2 } };
        var d2 = new Dictionary<string, int> { ["c"] = 3 };
        _ = d2;
        if (d.TryGetValue("a", out var v)) Log(v);
        byte b = 255;
        sbyte s8 = -128;
        int max = 2147483647;
        _ = (b, s8, max);
        var arr = new int[3];
        arr[2] = 7;
        return d["b"] > 1 ? "big" : "small";
    }

    public async Task<Invoice?> FindAsync(string id)
    {
        var inv = await _store.GetAsync(id);
        if (inv is null) throw new InvalidOperationException($"missing {id}");
        if (inv is { Paid: true } paid) return paid;
        await Task.Yield();
        return inv;
    }

    public async Task SaveAsync() => await Task.Delay(1);

    public void Log(int x) => Console.WriteLine(x);

    public TimeSpan Age(DateTime from) => DateTime.UtcNow - from;

    public decimal Ratio(decimal a, double b, float c)
    {
        if (a == 0.0m) return 1.5m;
        var r = b * 0 + c * 2.0f;
        Func<int, int> twice = x => { return x * 2; };
        var sel = new[] { 1, 2 }.Select(x => { return x + 1; }).ToList();
        int Local() => 3;
        return a * (decimal)r + Local() + twice(1) + sel.Count;
    }

    public Status Code(bool on) => on ? Status.Active : Status.Cancelled;

    public static Billing operator +(Billing a, Billing b) { return a; }

    public int Switch(string s) => s switch { "a" => 1, "" => 0, _ => -1 };

    public bool Check(object o)
    {
        if (o is string str && str.Length > 0) return true;
        return false;
    }

    public string Ids(Invoice inv) => inv.Id + inv.Id + Prefix;

    public int Inc(int x)
    {
        x++;
        int y;
        Init(out y);
        return y + x;
    }

    private static void Init(out int v) { v = 1; }

    private static void Use(Func<int, Func<Task>, Task> f) { }
    private static void Use(Func<int, Func<int, Task>, Task> f) { }

    public void Pipeline()
    {
        Use(async (n, next) =>
        {
            await next(n);
            Console.WriteLine(n > 0);
        });
    }
}
