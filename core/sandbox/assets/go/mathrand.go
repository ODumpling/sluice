// Sluice determinism shim (go mode), overlaid into packages math/rand and
// math/rand/v2 as zz_sluice.go. The overlay generator renames the package's
// linknamed runtime_rand (runtime.rand, the unseedable fast source behind the
// top-level functions) to sluiceRuntimeRand; this runtime_rand replaces it
// with a stream seeded from SLUICE_SEED. Explicitly seeded generators
// (rand.New(rand.NewSource(n)), rand.NewPCG, ...) are untouched.

package rand

import (
	"sync"
	"syscall"
)

type sluiceStream struct {
	mu sync.Mutex
	s  uint64
}

// splitmix64
func (r *sluiceStream) next() uint64 {
	r.mu.Lock()
	r.s += 0x9e3779b97f4a7c15
	z := r.s
	r.mu.Unlock()
	z = (z ^ (z >> 30)) * 0xbf58476d1ce4e5b9
	z = (z ^ (z >> 27)) * 0x94d049bb133111eb
	return z ^ (z >> 31)
}

var sluiceRand = sluiceSeeded(sluiceStreamLabel)

func sluiceSeeded(label uint64) *sluiceStream {
	v, ok := syscall.Getenv("SLUICE_SEED")
	if !ok || v == "" {
		return nil
	}
	var n uint64
	neg := false
	for i, c := range v {
		if i == 0 && c == '-' {
			neg = true
			continue
		}
		if c < '0' || c > '9' {
			return nil
		}
		n = n*10 + uint64(c-'0')
	}
	if neg {
		n = -n
	}
	return &sluiceStream{s: n*0x9e3779b97f4a7c15 ^ label}
}

func runtime_rand() uint64 {
	if sluiceRand != nil {
		return sluiceRand.next()
	}
	return sluiceRuntimeRand()
}
