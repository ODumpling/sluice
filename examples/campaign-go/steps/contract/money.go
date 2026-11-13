// Package money formats amounts.
package money

import (
	"fmt"
	"math"
)

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
