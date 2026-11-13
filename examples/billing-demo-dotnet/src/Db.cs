using Npgsql;

namespace BillingDemo;

/// <summary>Runs SQL with positional ($1, $2, …) parameters; rows are keyed by column name, NULL is null.</summary>
public interface IDb
{
    Task<List<Dictionary<string, object?>>> Query(string sql, params object?[] args);
}

public sealed class PostgresDb(NpgsqlDataSource dataSource) : IDb
{
    private static readonly string[] Migrations =
    [
        """
        CREATE TABLE IF NOT EXISTS plans (
          code text PRIMARY KEY,
          stripe_price_id text NOT NULL,
          amount_cents integer NOT NULL,
          interval text NOT NULL
        )
        """,
        """
        CREATE TABLE IF NOT EXISTS customers (
          id serial PRIMARY KEY,
          email text NOT NULL UNIQUE,
          name text,
          stripe_customer_id text NOT NULL,
          created_at timestamptz NOT NULL
        )
        """,
        """
        CREATE TABLE IF NOT EXISTS subscriptions (
          id serial PRIMARY KEY,
          customer_id integer NOT NULL REFERENCES customers(id),
          plan text NOT NULL REFERENCES plans(code),
          stripe_subscription_id text NOT NULL UNIQUE,
          status text NOT NULL,
          current_period_end timestamptz NOT NULL,
          cancel_at timestamptz,
          canceled_at timestamptz,
          created_at timestamptz NOT NULL,
          updated_at timestamptz NOT NULL
        )
        """,
    ];

    /// <summary>Accepts postgres:// URLs (DATABASE_URL) as well as Npgsql connection strings.</summary>
    public static PostgresDb Create(string url)
    {
        var cs = url;
        if (url.StartsWith("postgres://") || url.StartsWith("postgresql://"))
        {
            var u = new Uri(url);
            var userInfo = u.UserInfo.Split(':', 2);
            cs = new NpgsqlConnectionStringBuilder
            {
                Host = u.Host,
                Port = u.Port > 0 ? u.Port : 5432,
                Username = Uri.UnescapeDataString(userInfo[0]),
                Password = userInfo.Length > 1 ? Uri.UnescapeDataString(userInfo[1]) : null,
                Database = u.AbsolutePath.TrimStart('/'),
                MaxPoolSize = 5,
            }.ConnectionString;
        }
        return new PostgresDb(NpgsqlDataSource.Create(cs));
    }

    public async Task Migrate()
    {
        foreach (var sql in Migrations) await Query(sql);
    }

    public async Task<List<Dictionary<string, object?>>> Query(string sql, params object?[] args)
    {
        await using var cmd = dataSource.CreateCommand(sql);
        foreach (var a in args) cmd.Parameters.Add(new NpgsqlParameter { Value = a ?? DBNull.Value });
        await using var reader = await cmd.ExecuteReaderAsync();
        var rows = new List<Dictionary<string, object?>>();
        while (await reader.ReadAsync())
        {
            var row = new Dictionary<string, object?>();
            for (var i = 0; i < reader.FieldCount; i++)
                row[reader.GetName(i)] = reader.IsDBNull(i) ? null : reader.GetValue(i);
            rows.Add(row);
        }
        return rows;
    }
}
