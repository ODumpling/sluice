// Package money formats amounts.
package money

import (
	"fmt"
	"math"
)

// FormatDollars formats a float dollar amount.
//
// Deprecated: floats lose cents; use FormatCents.
func FormatDollars(amount float64) string {
	return fmt.Sprintf("$%.2f", amount)
}

// ToCents converts a dollar amount to integer cents (rounded).
func ToCents(amount float64) int64 {
	return int64(math.Round(amount * 100))
}

// FormatCents formats integer cents.
func FormatCents(cents int64) string {
	sign := ""
	if cents < 0 {
		sign, cents = "-", -cents
	}
	return fmt.Sprintf("%s$%d.%02d", sign, cents/100, cents%100)
}
