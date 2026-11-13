// Sluice determinism shim (go mode), overlaid into package crypto/rand as
// zz_sluice.go. When SLUICE_SEED is set, Reader becomes a seeded stream. The
// file sorts last so its init runs after the platform init that sets the
// default Reader (Go <= 1.23) and before any importing package's init, so
// libraries that capture rand.Reader at init (github.com/google/uuid) see the
// seeded one. rand.Read, rand.Text and rand.Int(rand.Reader, ...) all read
// through Reader. Note: since Go 1.26 crypto/* key generation ignores the
// io.Reader argument and always uses system randomness; keys are not seeded.

package rand

import (
	"sync"
	"syscall"
)

type sluiceReader struct {
	mu sync.Mutex
	s  uint64
}

func (r *sluiceReader) Read(b []byte) (int, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for i := 0; i < len(b); i += 8 {
		r.s += 0x9e3779b97f4a7c15
		z := r.s
		z = (z ^ (z >> 30)) * 0xbf58476d1ce4e5b9
		z = (z ^ (z >> 27)) * 0x94d049bb133111eb
		z ^= z >> 31
		for j := 0; j < 8 && i+j < len(b); j++ {
			b[i+j] = byte(z >> (8 * j))
		}
	}
	return len(b), nil
}

func init() {
	v, ok := syscall.Getenv("SLUICE_SEED")
	if !ok || v == "" {
		return
	}
	var n uint64
	neg := false
	for i, c := range v {
		if i == 0 && c == '-' {
			neg = true
			continue
		}
		if c < '0' || c > '9' {
			return
		}
		n = n*10 + uint64(c-'0')
	}
	if neg {
		n = -n
	}
	Reader = &sluiceReader{s: n*0x9e3779b97f4a7c15 ^ 0x63727970746f}
}
