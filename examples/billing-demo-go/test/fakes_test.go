package billing_test

import (
	"context"
	"fmt"
	"net/url"
	"strings"

	billing "billing-demo/src"
)

type sqlHandler struct {
	prefix string
	fn     func(args []any) []billing.Row
}

// fakeDB answers queries by SQL prefix, like the Node tests' fakeDb.
type fakeDB struct{ handlers []sqlHandler }

func (f *fakeDB) on(prefix string, fn func(args []any) []billing.Row) *fakeDB {
	f.handlers = append(f.handlers, sqlHandler{prefix, fn})
	return f
}

func (f *fakeDB) Query(_ context.Context, sql string, args ...any) ([]billing.Row, error) {
	for _, h := range f.handlers {
		if strings.HasPrefix(strings.TrimSpace(sql), h.prefix) {
			return h.fn(args), nil
		}
	}
	return nil, fmt.Errorf("unexpected SQL: %s", sql)
}

// fakeStripe implements the calls a test sets; anything else panics (nil embedded interface).
type fakeStripe struct {
	billing.Stripe
	createCustomer     func(p url.Values) (*billing.Customer, error)
	updateSubscription func(id string, p url.Values) (*billing.Subscription, error)
	cancelSubscription func(id string) (*billing.Subscription, error)
}

func (f *fakeStripe) CreateCustomer(_ context.Context, p url.Values) (*billing.Customer, error) {
	return f.createCustomer(p)
}

func (f *fakeStripe) UpdateSubscription(_ context.Context, id string, p url.Values) (*billing.Subscription, error) {
	return f.updateSubscription(id, p)
}

func (f *fakeStripe) CancelSubscription(_ context.Context, id string) (*billing.Subscription, error) {
	return f.cancelSubscription(id)
}
