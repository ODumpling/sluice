// Sluice determinism shim (go mode), overlaid into package os as zz_sluice.go.
// The overlay generator makes (*File).Write call SluiceStdoutTap with every
// buffer written to file descriptor 1, synchronously and before the write, so
// domain events are captured before the app can respond to the request.

package os

// SluiceStdoutTap, when set, sees every write to file descriptor 1.
var SluiceStdoutTap func([]byte)
