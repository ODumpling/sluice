package billing

import (
	"context"
	"fmt"
	"net/url"
	"strconv"
	"strings"
	"time"
)

type Plan struct {
	Name        string
	AmountCents int
	Interval    string
}

var Plans = map[string]Plan{
	"pro_monthly": {Name: "Pro", AmountCents: 2000, Interval: "month"},
}

// HTTPError is an error with an HTTP status for the API response.
type HTTPError struct {
	Status  int
	Message string
}

func (e *HTTPError) Error() string { return e.Message }

func httpError(status int, format string, args ...any) error {
	return &HTTPError{Status: status, Message: fmt.Sprintf(format, args...)}
}

// SubscriptionView is the API representation of a subscription.
type SubscriptionView struct {
	ID               int64   `json:"id"`
	CustomerID       int64   `json:"customer_id"`
	Plan             string  `json:"plan"`
	Status           string  `json:"status"`
	CurrentPeriodEnd string  `json:"current_period_end"`
	CancelAt         *string `json:"cancel_at"`
	CanceledAt       *string `json:"canceled_at"`
}

type CustomerView struct {
	ID    int64   `json:"id"`
	Email string  `json:"email"`
	Name  *string `json:"name"`
}

type AccessView struct {
	CustomerID  int64   `json:"customer_id"`
	HasAccess   bool    `json:"has_access"`
	Plan        *string `json:"plan"`
	AccessUntil *string `json:"access_until"`
}

type SyncResult struct {
	Checked int `json:"checked"`
	Changed int `json:"changed"`
}

// ISO formats an instant like JavaScript's Date#toISOString.
func ISO(t time.Time) string { return t.UTC().Format("2006-01-02T15:04:05.000Z") }

func fromUnix(sec int64) time.Time { return time.Unix(sec, 0).UTC() }

func toInt(v any) int64 {
	switch n := v.(type) {
	case int:
		return int64(n)
	case int32:
		return int64(n)
	case int64:
		return n
	case float64:
		return int64(n)
	case string:
		i, _ := strconv.ParseInt(n, 10, 64)
		return i
	}
	return 0
}

func toStr(v any) string {
	s, _ := v.(string)
	return s
}

func toTime(v any) *time.Time {
	switch t := v.(type) {
	case time.Time:
		return &t
	case *time.Time:
		return t
	}
	return nil
}

func isoOrNil(v any) *string {
	t := toTime(v)
	if t == nil {
		return nil
	}
	s := ISO(*t)
	return &s
}

func strOrNil(v any) *string {
	if s, ok := v.(string); ok {
		return &s
	}
	return nil
}

func rowToSubscription(row Row) *SubscriptionView {
	return &SubscriptionView{
		ID:               toInt(row["id"]),
		CustomerID:       toInt(row["customer_id"]),
		Plan:             toStr(row["plan"]),
		Status:           toStr(row["status"]),
		CurrentPeriodEnd: ISO(*toTime(row["current_period_end"])),
		CancelAt:         isoOrNil(row["cancel_at"]),
		CanceledAt:       isoOrNil(row["canceled_at"]),
	}
}

// Billing implements the billing use cases on top of a DB and Stripe.
type Billing struct {
	DB     DB
	Stripe Stripe
}

func (b *Billing) one(ctx context.Context, sql string, args ...any) (Row, error) {
	rows, err := b.DB.Query(ctx, sql, args...)
	if err != nil || len(rows) == 0 {
		return nil, err
	}
	return rows[0], nil
}

func (b *Billing) ensurePlan(ctx context.Context, code string) (Row, error) {
	plan, ok := Plans[code]
	if !ok {
		return nil, httpError(400, "unknown plan %s", code)
	}
	existing, err := b.one(ctx, "SELECT * FROM plans WHERE code = $1", code)
	if err != nil || existing != nil {
		return existing, err
	}
	found, err := b.Stripe.ListPrices(ctx, url.Values{"lookup_keys[0]": {code}, "limit": {"1"}})
	if err != nil {
		return nil, err
	}
	var priceID string
	if len(found) > 0 {
		priceID = found[0].ID
	} else {
		product, err := b.Stripe.CreateProduct(ctx, url.Values{"name": {plan.Name}})
		if err != nil {
			return nil, err
		}
		price, err := b.Stripe.CreatePrice(ctx, url.Values{
			"product":             {product.ID},
			"currency":            {"usd"},
			"unit_amount":         {strconv.Itoa(plan.AmountCents)},
			"recurring[interval]": {plan.Interval},
			"lookup_key":          {code},
		})
		if err != nil {
			return nil, err
		}
		priceID = price.ID
	}
	return b.one(ctx,
		"INSERT INTO plans (code, stripe_price_id, amount_cents, interval) VALUES ($1, $2, $3, $4) RETURNING *",
		code, priceID, plan.AmountCents, plan.Interval)
}

func (b *Billing) subscriptionRow(ctx context.Context, id int64) (Row, error) {
	row, err := b.one(ctx, "SELECT * FROM subscriptions WHERE id = $1", id)
	if err == nil && row == nil {
		err = httpError(404, "subscription %d not found", id)
	}
	return row, err
}

func (b *Billing) CreateCustomer(ctx context.Context, body map[string]any) (*CustomerView, error) {
	email, ok := body["email"].(string)
	if !ok || !strings.Contains(email, "@") {
		return nil, httpError(400, "valid email required")
	}
	dupe, err := b.one(ctx, "SELECT id FROM customers WHERE email = $1", email)
	if err != nil {
		return nil, err
	}
	if dupe != nil {
		return nil, httpError(409, "email already registered")
	}
	name := strOrNil(body["name"])
	params := url.Values{"email": {email}}
	if name != nil {
		params.Set("name", *name)
	}
	sc, err := b.Stripe.CreateCustomer(ctx, params)
	if err != nil {
		return nil, err
	}
	row, err := b.one(ctx,
		"INSERT INTO customers (email, name, stripe_customer_id, created_at) VALUES ($1, $2, $3, $4) RETURNING *",
		email, name, sc.ID, Now())
	if err != nil {
		return nil, err
	}
	Emit("customer.created", map[string]any{"customer_id": toInt(row["id"])})
	return &CustomerView{ID: toInt(row["id"]), Email: toStr(row["email"]), Name: strOrNil(row["name"])}, nil
}

func (b *Billing) Subscribe(ctx context.Context, body map[string]any) (*SubscriptionView, error) {
	customerID := toInt(body["customer_id"])
	plan := "pro_monthly"
	if p, ok := body["plan"].(string); ok {
		plan = p
	}
	customer, err := b.one(ctx, "SELECT * FROM customers WHERE id = $1", customerID)
	if err != nil {
		return nil, err
	}
	if customer == nil {
		return nil, httpError(404, "customer %v not found", body["customer_id"])
	}
	active, err := b.one(ctx,
		"SELECT id FROM subscriptions WHERE customer_id = $1 AND status IN ('active', 'past_due')", customerID)
	if err != nil {
		return nil, err
	}
	if active != nil {
		return nil, httpError(409, "customer already has an active subscription")
	}
	p, err := b.ensurePlan(ctx, plan)
	if err != nil {
		return nil, err
	}
	sub, err := b.Stripe.CreateSubscription(ctx, url.Values{
		"customer":              {toStr(customer["stripe_customer_id"])},
		"items[0][price]":       {toStr(p["stripe_price_id"])},
		"metadata[customer_id]": {strconv.FormatInt(customerID, 10)},
	})
	if err != nil {
		return nil, err
	}
	now := Now()
	row, err := b.one(ctx,
		`INSERT INTO subscriptions (customer_id, plan, stripe_subscription_id, status, current_period_end, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $6) RETURNING *`,
		customerID, plan, sub.ID, sub.Status, fromUnix(sub.Items.Data[0].CurrentPeriodEnd), now)
	if err != nil {
		return nil, err
	}
	Emit("subscription.created", map[string]any{"subscription_id": toInt(row["id"]), "customer_id": customerID})
	return rowToSubscription(row), nil
}

// Cancel implements CANCEL-1: cancellation takes effect at the end of the current period.
func (b *Billing) Cancel(ctx context.Context, id int64) (*SubscriptionView, error) {
	row, err := b.subscriptionRow(ctx, id)
	if err != nil {
		return nil, err
	}
	if toStr(row["status"]) == "canceled" || row["cancel_at"] != nil {
		return nil, httpError(409, "subscription already canceled")
	}
	s, err := b.Stripe.UpdateSubscription(ctx, toStr(row["stripe_subscription_id"]),
		url.Values{"cancel_at_period_end": {"true"}})
	if err != nil {
		return nil, err
	}
	cancelAt := fromUnix(*s.CancelAt)
	updated, err := b.one(ctx, `UPDATE subscriptions SET cancel_at = $2, updated_at = $3 WHERE id = $1 RETURNING *`,
		id, cancelAt, Now())
	if err != nil {
		return nil, err
	}
	Emit("subscription.cancel_scheduled", map[string]any{"subscription_id": id, "cancel_at": ISO(cancelAt)})
	return rowToSubscription(updated), nil
}

func (b *Billing) GetSubscription(ctx context.Context, id int64) (*SubscriptionView, error) {
	row, err := b.subscriptionRow(ctx, id)
	if err != nil {
		return nil, err
	}
	return rowToSubscription(row), nil
}

func (b *Billing) Access(ctx context.Context, customerID int64) (*AccessView, error) {
	sub, err := b.one(ctx, "SELECT * FROM subscriptions WHERE customer_id = $1 ORDER BY id DESC LIMIT 1", customerID)
	if err != nil {
		return nil, err
	}
	now := Now()
	hasAccess := sub != nil && toStr(sub["status"]) != "canceled" && toTime(sub["current_period_end"]).After(now)
	view := &AccessView{CustomerID: customerID, HasAccess: hasAccess}
	if hasAccess {
		view.Plan = strOrNil(sub["plan"])
		view.AccessUntil = isoOrNil(sub["cancel_at"])
		if view.AccessUntil == nil {
			view.AccessUntil = isoOrNil(sub["current_period_end"])
		}
	}
	return view, nil
}

// SyncSubscriptions pulls subscription state from Stripe (renewals, scheduled cancellations).
func (b *Billing) SyncSubscriptions(ctx context.Context) (*SyncResult, error) {
	rows, err := b.DB.Query(ctx, "SELECT * FROM subscriptions WHERE status <> 'canceled' ORDER BY id")
	if err != nil {
		return nil, err
	}
	changed := 0
	for _, row := range rows {
		s, err := b.Stripe.RetrieveSubscription(ctx, toStr(row["stripe_subscription_id"]))
		if err != nil {
			return nil, err
		}
		periodEnd := fromUnix(s.Items.Data[0].CurrentPeriodEnd)
		var cancelAt, canceledAt *time.Time
		if s.CancelAt != nil {
			t := fromUnix(*s.CancelAt)
			cancelAt = &t
		}
		if s.EndedAt != nil {
			t := fromUnix(*s.EndedAt)
			canceledAt = &t
		}
		rowCancelAt := toTime(row["cancel_at"])
		if s.Status != toStr(row["status"]) ||
			!periodEnd.Equal(*toTime(row["current_period_end"])) ||
			(cancelAt == nil) != (rowCancelAt == nil) ||
			(cancelAt != nil && !cancelAt.Equal(*rowCancelAt)) {
			if _, err := b.DB.Query(ctx,
				`UPDATE subscriptions SET status = $2, current_period_end = $3, cancel_at = $4, canceled_at = COALESCE($5, canceled_at), updated_at = $6 WHERE id = $1`,
				row["id"], s.Status, periodEnd, cancelAt, canceledAt, Now()); err != nil {
				return nil, err
			}
			if s.Status != toStr(row["status"]) {
				Emit("subscription."+s.Status, map[string]any{"subscription_id": toInt(row["id"])})
			}
			changed++
		}
	}
	return &SyncResult{Checked: len(rows), Changed: changed}, nil
}
