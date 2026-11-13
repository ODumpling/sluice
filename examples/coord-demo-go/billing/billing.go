// Package billing creates and totals invoices.
package billing

import "example.com/coorddemo/types"

// CreateInvoice builds a new invoice.
func CreateInvoice(customerID string, amountCents int64, issuedAt string) types.Invoice {
	return types.Invoice{ID: "inv_" + customerID + "_" + issuedAt, CustomerID: customerID, AmountCents: amountCents, IssuedAt: issuedAt}
}

// TotalCents sums the amounts of invoices.
func TotalCents(invoices []types.Invoice) int64 {
	var sum int64
	for _, i := range invoices {
		sum += i.AmountCents
	}
	return sum
}
