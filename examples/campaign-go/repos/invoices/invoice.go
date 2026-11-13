// Package invoices renders invoice summaries.
package invoices

import (
	"fmt"

	"example.com/money"
)

// Invoice is a billed amount with tax.
type Invoice struct {
	ID    string
	Total float64
	Tax   float64
}

// Summary renders one invoice.
func Summary(inv Invoice) string {
	return fmt.Sprintf("%s: %s (tax %s)", inv.ID, money.FormatDollars(inv.Total), money.FormatDollars(inv.Tax))
}
