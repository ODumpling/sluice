package billing

import (
	"encoding/json"
	"fmt"
	"os"
	"sync"
	"time"
)

var stdoutMu sync.Mutex

// Emit writes a domain event as one JSON line on stdout ({"event": ...}).
func Emit(event string, data map[string]any) {
	m := map[string]any{"event": event}
	for k, v := range data {
		m[k] = v
	}
	line, _ := json.Marshal(m)
	stdoutMu.Lock()
	defer stdoutMu.Unlock()
	fmt.Fprintln(os.Stdout, string(line))
}

// Now is the application clock (UTC). Tests may replace it.
var Now = func() time.Time { return time.Now().UTC() }
