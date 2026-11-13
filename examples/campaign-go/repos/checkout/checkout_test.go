package checkout

import (
	"testing"

	"github.com/google/go-cmp/cmp"
)

func TestTotal(t *testing.T) {
	got := Total([]Line{{"tea", 2.5, 2}, {"cake", 3.25, 1}})
	if d := cmp.Diff("Total: $8.25", got); d != "" {
		t.Error(d)
	}
}
