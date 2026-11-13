// Package money formats amounts.
package money

import "fmt"

// FormatDollars formats a float dollar amount.
//
// Deprecated: floats lose cents; use FormatCents.
func FormatDollars(amount float64) string {
	return fmt.Sprintf("$%.2f", amount)
}
