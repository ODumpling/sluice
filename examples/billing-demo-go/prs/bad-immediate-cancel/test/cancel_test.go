package billing_test

import (
	"context"
	"slices"
	"testing"
	"time"

	billing "billing-demo/src"
)

func TestCancelCancelsInStripeAndMarksCanceled(t *testing.T) {
	var canceled []string
	db := (&fakeDB{}).
		on("SELECT * FROM subscriptions", func([]any) []billing.Row {
			return []billing.Row{{
				"id": int32(1), "status": "active", "stripe_subscription_id": "sub_1", "plan": "pro_monthly",
				"customer_id": int32(1), "current_period_end": time.Now(), "cancel_at": nil, "canceled_at": nil,
			}}
		}).
		on("UPDATE subscriptions", func([]any) []billing.Row {
			return []billing.Row{{
				"id": int32(1), "status": "canceled", "plan": "pro_monthly", "customer_id": int32(1),
				"current_period_end": time.Now(), "cancel_at": nil, "canceled_at": time.Now(),
			}}
		})
	stripe := &fakeStripe{cancelSubscription: func(id string) (*billing.Subscription, error) {
		canceled = append(canceled, id)
		return &billing.Subscription{ID: id, Status: "canceled"}, nil
	}}
	sub, err := (&billing.Billing{DB: db, Stripe: stripe}).Cancel(context.Background(), 1)
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(canceled, []string{"sub_1"}) {
		t.Fatalf("stripe cancel calls = %v", canceled)
	}
	if sub.Status != "canceled" {
		t.Fatalf("status = %q, want canceled", sub.Status)
	}
}
