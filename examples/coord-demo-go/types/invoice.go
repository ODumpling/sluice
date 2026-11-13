// Package types holds the data exchanged between modules.
package types

import "fmt"

// Invoice is an invoice as stored and exchanged between packages.
type Invoice struct {
	ID          string `json:"id"`
	CustomerID  string `json:"customerId"`
	AmountCents int64  `json:"amountCents"`
	IssuedAt    string `json:"issuedAt"`
}

// Dollars formats the amount as dollars.
func (i Invoice) Dollars() string {
	return fmt.Sprintf("%.2f", float64(i.AmountCents)/100)
}

// InvoiceStatus is the lifecycle state of an invoice.
type InvoiceStatus string

const (
	Draft InvoiceStatus = "draft"
	Open  InvoiceStatus = "open"
	Paid  InvoiceStatus = "paid"
)
