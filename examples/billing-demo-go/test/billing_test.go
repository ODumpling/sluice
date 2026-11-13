package billing_test

import (
	"context"
	"errors"
	"net/url"
	"testing"

	billing "billing-demo/src"
)

func TestCreateCustomerRejectsInvalidEmail(t *testing.T) {
	b := &billing.Billing{DB: &fakeDB{}, Stripe: &fakeStripe{}}
	_, err := b.CreateCustomer(context.Background(), map[string]any{"email": "nope"})
	var he *billing.HTTPError
	if !errors.As(err, &he) || he.Status != 400 {
		t.Fatalf("want HTTPError 400, got %v", err)
	}
}

func TestCreateCustomerStoresStripeCustomerID(t *testing.T) {
	var inserted [][]any
	db := (&fakeDB{}).
		on("SELECT id FROM customers", func([]any) []billing.Row { return nil }).
		on("INSERT INTO customers", func(p []any) []billing.Row {
			inserted = append(inserted, p)
			return []billing.Row{{"id": int32(1), "email": p[0], "name": *(p[1].(*string))}}
		})
	stripe := &fakeStripe{createCustomer: func(url.Values) (*billing.Customer, error) {
		return &billing.Customer{ID: "cus_123"}, nil
	}}
	c, err := (&billing.Billing{DB: db, Stripe: stripe}).CreateCustomer(context.Background(),
		map[string]any{"email": "a@b.co", "name": "A"})
	if err != nil {
		t.Fatal(err)
	}
	if c.ID != 1 || c.Email != "a@b.co" || c.Name == nil || *c.Name != "A" {
		t.Fatalf("unexpected customer %+v", c)
	}
	if inserted[0][2] != "cus_123" {
		t.Fatalf("stripe customer id not stored: %v", inserted[0])
	}
}
