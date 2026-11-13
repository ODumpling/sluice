package money

import (
	"testing"

	"github.com/google/go-cmp/cmp"
)

func TestFormatDollars(t *testing.T) {
	if d := cmp.Diff("$12.50", FormatDollars(12.5)); d != "" {
		t.Error(d)
	}
}
