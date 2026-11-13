// Sluice determinism shim (go mode), overlaid into package time as zz_sluice.go.
// time.go's own Now is renamed sluiceRealNow by the overlay generator; this
// Now returns the frozen sandbox clock when SLUICE_NOW_MS is set. The frozen
// value has no monotonic reading, so Since/Until/Sub between frozen times use
// the simulated wall clock; timers, Sleep and network deadlines keep running
// on the real (runtime) clock.

package time

import (
	"sync/atomic"
	"syscall"
)

var sluiceNowMs atomic.Int64

var sluiceFrozen = sluiceClockInit()

func sluiceClockInit() bool {
	v, ok := syscall.Getenv("SLUICE_NOW_MS")
	if !ok || v == "" {
		return false
	}
	var n int64
	for _, c := range v {
		if c < '0' || c > '9' {
			return false
		}
		n = n*10 + int64(c-'0')
	}
	sluiceNowMs.Store(n)
	return true
}

// Now returns the current local time (the frozen Sluice clock in a sandbox).
func Now() Time {
	if !sluiceFrozen {
		return sluiceRealNow()
	}
	ms := sluiceNowMs.Load()
	return Unix(ms/1e3, (ms%1e3)*1e6)
}

// SluiceFrozen reports whether the Sluice frozen clock is active.
func SluiceFrozen() bool { return sluiceFrozen }

// SluiceNowMs returns the frozen clock in Unix milliseconds.
func SluiceNowMs() int64 { return sluiceNowMs.Load() }

// SluiceSetNowMs moves the frozen clock (POST /clock on the control port).
func SluiceSetNowMs(ms int64) { sluiceNowMs.Store(ms) }
