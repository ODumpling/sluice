package billing_test

import (
	"context"
	"net/url"
	"testing"
	"time"

	billing "billing-demo/src"
)

func TestCancelSchedulesCancellationAtPeriodEnd(t *testing.T) {
	type update struct {
		id     string
		params url.Values
	}
	var updates []update
	end := time.Date(2030, 2, 15, 12, 0, 0, 0, time.UTC)
	db := (&fakeDB{}).
		on("SELECT * FROM subscriptions", func([]any) []billing.Row {
			return []billing.Row{{
				"id": int32(1), "status": "active", "stripe_subscription_id": "sub_1", "plan": "pro_monthly",
				"customer_id": int32(1), "current_period_end": end, "cancel_at": nil, "canceled_at": nil,
			}}
		}).
		on("UPDATE subscriptions", func(p []any) []billing.Row {
			return []billing.Row{{
				"id": int32(1), "status": "active", "plan": "pro_monthly", "customer_id": int32(1),
				"current_period_end": end, "cancel_at": p[1], "canceled_at": nil,
			}}
		})
	stripe := &fakeStripe{updateSubscription: func(id string, p url.Values) (*billing.Subscription, error) {
		updates = append(updates, update{id, p})
		cancelAt := end.Unix()
		return &billing.Subscription{ID: id, Status: "active", CancelAtPeriodEnd: true, CancelAt: &cancelAt}, nil
	}}
	sub, err := (&billing.Billing{DB: db, Stripe: stripe}).Cancel(context.Background(), 1)
	if err != nil {
		t.Fatal(err)
	}
	if len(updates) != 1 || updates[0].id != "sub_1" || updates[0].params.Encode() != "cancel_at_period_end=true" {
		t.Fatalf("stripe updates = %v", updates)
	}
	if sub.Status != "active" {
		t.Fatalf("status = %q, want active", sub.Status)
	}
	if sub.CancelAt == nil || *sub.CancelAt != billing.ISO(end) {
		t.Fatalf("cancel_at = %v, want %s", sub.CancelAt, billing.ISO(end))
	}
}
