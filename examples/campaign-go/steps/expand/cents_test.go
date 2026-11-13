package money

import (
	"testing"

	"github.com/google/go-cmp/cmp"
)

func TestFormatCents(t *testing.T) {
	got := []string{FormatCents(1250), FormatCents(5), FormatCents(-199), FormatCents(ToCents(0.1 + 0.2))}
	if d := cmp.Diff([]string{"$12.50", "$0.05", "-$1.99", "$0.30"}, got); d != "" {
		t.Error(d)
	}
}
