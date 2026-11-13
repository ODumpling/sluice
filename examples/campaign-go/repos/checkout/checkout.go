// Package checkout renders cart totals.
package checkout

import "example.com/money"

// Line is a cart line.
type Line struct {
	Name  string
	Price float64
	Qty   int
}

// Total renders the cart total.
func Total(lines []Line) string {
	sum := 0.0
	for _, l := range lines {
		sum += l.Price * float64(l.Qty)
	}
	return "Total: " + money.FormatDollars(sum)
}
