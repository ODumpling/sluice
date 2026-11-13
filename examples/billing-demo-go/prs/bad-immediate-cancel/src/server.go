package billing

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"regexp"
	"strconv"
)

type handler func(ctx context.Context, m []string, body map[string]any) (int, any, error)

type route struct {
	method  string
	pattern *regexp.Regexp
	handle  handler
}

func id(m []string) int64 {
	n, _ := strconv.ParseInt(m[1], 10, 64)
	return n
}

func readJSON(r *http.Request) (map[string]any, error) {
	data, err := io.ReadAll(r.Body)
	if err != nil || len(data) == 0 {
		return map[string]any{}, err
	}
	var body map[string]any
	if json.Unmarshal(data, &body) != nil {
		return nil, httpError(400, "invalid JSON body")
	}
	return body, nil
}

func ok[T any](status int) func(v T, err error) (int, any, error) {
	return func(v T, err error) (int, any, error) { return status, v, err }
}

// NewApp returns the HTTP API.
func NewApp(b *Billing) http.Handler {
	routes := []route{
		{"GET", regexp.MustCompile(`^/health$`), func(ctx context.Context, m []string, body map[string]any) (int, any, error) {
			return 200, map[string]bool{"ok": true}, nil
		}},
		{"POST", regexp.MustCompile(`^/customers$`), func(ctx context.Context, m []string, body map[string]any) (int, any, error) {
			return ok[*CustomerView](201)(b.CreateCustomer(ctx, body))
		}},
		{"GET", regexp.MustCompile(`^/customers/(\d+)/access$`), func(ctx context.Context, m []string, body map[string]any) (int, any, error) {
			return ok[*AccessView](200)(b.Access(ctx, id(m)))
		}},
		{"POST", regexp.MustCompile(`^/subscriptions$`), func(ctx context.Context, m []string, body map[string]any) (int, any, error) {
			return ok[*SubscriptionView](201)(b.Subscribe(ctx, body))
		}},
		{"GET", regexp.MustCompile(`^/subscriptions/(\d+)$`), func(ctx context.Context, m []string, body map[string]any) (int, any, error) {
			return ok[*SubscriptionView](200)(b.GetSubscription(ctx, id(m)))
		}},
		{"POST", regexp.MustCompile(`^/subscriptions/(\d+)/cancel$`), func(ctx context.Context, m []string, body map[string]any) (int, any, error) {
			return ok[*SubscriptionView](200)(b.Cancel(ctx, id(m)))
		}},
		{"POST", regexp.MustCompile(`^/jobs/sync-subscriptions$`), func(ctx context.Context, m []string, body map[string]any) (int, any, error) {
			return ok[*SyncResult](200)(b.SyncSubscriptions(ctx))
		}},
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		status, payload, err := 404, any(map[string]string{"error": "not found"}), error(nil)
		for _, rt := range routes {
			m := rt.pattern.FindStringSubmatch(r.URL.Path)
			if m == nil || r.Method != rt.method {
				continue
			}
			body := map[string]any{}
			if rt.method == "POST" {
				body, err = readJSON(r)
			}
			if err == nil {
				status, payload, err = rt.handle(r.Context(), m, body)
			}
			break
		}
		if err != nil {
			var he *HTTPError
			if errors.As(err, &he) {
				status, payload = he.Status, map[string]string{"error": he.Message}
			} else {
				status, payload = 500, map[string]string{"error": "internal error"}
				log.Println(err)
			}
		}
		data, _ := json.Marshal(payload)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_, _ = w.Write(data)
	})
}

// Main connects to Postgres, migrates, and serves the API on $PORT.
func Main() {
	ctx := context.Background()
	db, err := NewPostgres(ctx, os.Getenv("DATABASE_URL"))
	if err == nil {
		err = Migrate(ctx, db)
	}
	if err != nil {
		log.Fatal(err)
	}
	b := &Billing{DB: db, Stripe: NewStripeFromEnv()}
	port := os.Getenv("PORT")
	if port == "" {
		port = "3000"
	}
	fmt.Fprintf(os.Stderr, "billing-demo listening on :%s\n", port)
	log.Fatal(http.ListenAndServe(":"+port, NewApp(b)))
}
