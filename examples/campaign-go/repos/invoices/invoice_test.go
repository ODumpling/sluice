package invoices

import (
	"testing"

	"github.com/google/go-cmp/cmp"
)

func TestSummary(t *testing.T) {
	got := Summary(Invoice{ID: "INV-1", Total: 107.5, Tax: 7.5})
	if d := cmp.Diff("INV-1: $107.50 (tax $7.50)", got); d != "" {
		t.Error(d)
	}
}
