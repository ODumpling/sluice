package billing

import (
	"context"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Row is one result row keyed by column name (NULL is nil).
type Row = map[string]any

// DB runs a SQL statement and returns its rows.
type DB interface {
	Query(ctx context.Context, sql string, args ...any) ([]Row, error)
}

var migrations = []string{
	`CREATE TABLE IF NOT EXISTS plans (
     code text PRIMARY KEY,
     stripe_price_id text NOT NULL,
     amount_cents integer NOT NULL,
     interval text NOT NULL
   )`,
	`CREATE TABLE IF NOT EXISTS customers (
     id serial PRIMARY KEY,
     email text NOT NULL UNIQUE,
     name text,
     stripe_customer_id text NOT NULL,
     created_at timestamptz NOT NULL
   )`,
	`CREATE TABLE IF NOT EXISTS subscriptions (
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
   )`,
}

// Postgres is a DB backed by a pgx connection pool.
type Postgres struct{ Pool *pgxpool.Pool }

// NewPostgres connects to url (e.g. DATABASE_URL).
func NewPostgres(ctx context.Context, url string) (*Postgres, error) {
	cfg, err := pgxpool.ParseConfig(url)
	if err != nil {
		return nil, err
	}
	cfg.MaxConns = 5
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, err
	}
	return &Postgres{Pool: pool}, nil
}

func (p *Postgres) Query(ctx context.Context, sql string, args ...any) ([]Row, error) {
	rows, err := p.Pool.Query(ctx, sql, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	fields := rows.FieldDescriptions()
	out := []Row{}
	for rows.Next() {
		vals, err := rows.Values()
		if err != nil {
			return nil, err
		}
		r := Row{}
		for i, f := range fields {
			r[f.Name] = vals[i]
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// Migrate creates the schema.
func Migrate(ctx context.Context, db DB) error {
	for _, sql := range migrations {
		if _, err := db.Query(ctx, sql); err != nil {
			return err
		}
	}
	return nil
}
