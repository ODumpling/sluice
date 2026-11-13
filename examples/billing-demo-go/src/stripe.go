package billing

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
)

// StripeAPIVersion is the Stripe API version the app is written against.
const StripeAPIVersion = "2026-09-30.endive"

type Customer struct {
	ID    string `json:"id"`
	Email string `json:"email"`
}

type Product struct {
	ID string `json:"id"`
}

type Price struct {
	ID string `json:"id"`
}

type SubscriptionItem struct {
	CurrentPeriodEnd int64 `json:"current_period_end"`
}

type Subscription struct {
	ID                string `json:"id"`
	Status            string `json:"status"`
	CancelAtPeriodEnd bool   `json:"cancel_at_period_end"`
	CancelAt          *int64 `json:"cancel_at"`
	EndedAt           *int64 `json:"ended_at"`
	Items             struct {
		Data []SubscriptionItem `json:"data"`
	} `json:"items"`
}

// Stripe is the subset of the Stripe API the app uses.
type Stripe interface {
	CreateCustomer(ctx context.Context, params url.Values) (*Customer, error)
	ListPrices(ctx context.Context, params url.Values) ([]Price, error)
	CreateProduct(ctx context.Context, params url.Values) (*Product, error)
	CreatePrice(ctx context.Context, params url.Values) (*Price, error)
	CreateSubscription(ctx context.Context, params url.Values) (*Subscription, error)
	RetrieveSubscription(ctx context.Context, id string) (*Subscription, error)
	UpdateSubscription(ctx context.Context, id string, params url.Values) (*Subscription, error)
	CancelSubscription(ctx context.Context, id string) (*Subscription, error)
}

// StripeClient calls the Stripe REST API with form-encoded requests.
// STRIPE_API_BASE lets the app run against the Sluice Stripe fake.
type StripeClient struct {
	Base string
	Key  string
	HTTP *http.Client
}

func NewStripeFromEnv() *StripeClient {
	base := os.Getenv("STRIPE_API_BASE")
	if base == "" {
		base = "https://api.stripe.com"
	}
	return &StripeClient{
		Base: strings.TrimRight(base, "/"),
		Key:  os.Getenv("STRIPE_SECRET_KEY"),
		HTTP: &http.Client{Timeout: 80 * time.Second},
	}
}

// StripeError is a non-2xx Stripe response.
type StripeError struct {
	Status  int
	Message string
}

func (e *StripeError) Error() string { return fmt.Sprintf("stripe: %d %s", e.Status, e.Message) }

func (c *StripeClient) request(ctx context.Context, method, path string, params url.Values, out any) error {
	u := c.Base + path
	var body io.Reader
	if method == http.MethodGet && len(params) > 0 {
		u += "?" + params.Encode()
	} else if method != http.MethodGet && len(params) > 0 {
		body = strings.NewReader(params.Encode())
	}
	req, err := http.NewRequestWithContext(ctx, method, u, body)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+c.Key)
	req.Header.Set("Stripe-Version", StripeAPIVersion)
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	}
	res, err := c.HTTP.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	data, err := io.ReadAll(res.Body)
	if err != nil {
		return err
	}
	if res.StatusCode >= 300 {
		var e struct {
			Error struct {
				Message string `json:"message"`
			} `json:"error"`
		}
		_ = json.Unmarshal(data, &e)
		return &StripeError{Status: res.StatusCode, Message: e.Error.Message}
	}
	return json.Unmarshal(data, out)
}

func (c *StripeClient) CreateCustomer(ctx context.Context, p url.Values) (*Customer, error) {
	var out Customer
	return &out, c.request(ctx, http.MethodPost, "/v1/customers", p, &out)
}

func (c *StripeClient) ListPrices(ctx context.Context, p url.Values) ([]Price, error) {
	var out struct {
		Data []Price `json:"data"`
	}
	err := c.request(ctx, http.MethodGet, "/v1/prices", p, &out)
	return out.Data, err
}

func (c *StripeClient) CreateProduct(ctx context.Context, p url.Values) (*Product, error) {
	var out Product
	return &out, c.request(ctx, http.MethodPost, "/v1/products", p, &out)
}

func (c *StripeClient) CreatePrice(ctx context.Context, p url.Values) (*Price, error) {
	var out Price
	return &out, c.request(ctx, http.MethodPost, "/v1/prices", p, &out)
}

func (c *StripeClient) CreateSubscription(ctx context.Context, p url.Values) (*Subscription, error) {
	var out Subscription
	return &out, c.request(ctx, http.MethodPost, "/v1/subscriptions", p, &out)
}

func (c *StripeClient) RetrieveSubscription(ctx context.Context, id string) (*Subscription, error) {
	var out Subscription
	return &out, c.request(ctx, http.MethodGet, "/v1/subscriptions/"+url.PathEscape(id), nil, &out)
}

func (c *StripeClient) UpdateSubscription(ctx context.Context, id string, p url.Values) (*Subscription, error) {
	var out Subscription
	return &out, c.request(ctx, http.MethodPost, "/v1/subscriptions/"+url.PathEscape(id), p, &out)
}

func (c *StripeClient) CancelSubscription(ctx context.Context, id string) (*Subscription, error) {
	var out Subscription
	return &out, c.request(ctx, http.MethodDelete, "/v1/subscriptions/"+url.PathEscape(id), nil, &out)
}
