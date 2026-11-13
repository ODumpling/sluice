// Package report renders invoices for humans.
package report

import (
	"strings"

	"example.com/coorddemo/types"
)

// RenderReport renders one line per invoice.
func RenderReport(invoices []types.Invoice) string {
	lines := make([]string, 0, len(invoices))
	for _, i := range invoices {
		lines = append(lines, i.ID+"\t"+i.Dollars())
	}
	return strings.Join(lines, "\n")
}
