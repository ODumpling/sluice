// Fixture for the go determinism shim: a tiny HTTP service exposing the
// clock, every common randomness source, event emission and egress probes.
package main

import (
	crand "crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math/rand"
	randv2 "math/rand/v2"
	"net"
	"net/http"
	"os"
	"time"

	"github.com/google/uuid"
)

func reply(w http.ResponseWriter, v any) {
	w.Header().Set("content-type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}

func main() {
	started := time.Now()
	http.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) { reply(w, map[string]bool{"ok": true}) })
	http.HandleFunc("/now", func(w http.ResponseWriter, r *http.Request) {
		now := time.Now()
		reply(w, map[string]any{
			"ms":        now.UnixMilli(),
			"iso":       now.UTC().Format(time.RFC3339Nano),
			"sinceBoot": time.Since(started).Milliseconds(),
		})
	})
	http.HandleFunc("/rand", func(w http.ResponseWriter, r *http.Request) {
		b := make([]byte, 8)
		_, _ = crand.Read(b)
		reply(w, map[string]any{
			"v1":     rand.Int63(),
			"v2":     randv2.Uint64(),
			"crypto": hex.EncodeToString(b),
			"text":   crand.Text(),
		})
	})
	http.HandleFunc("/uuid", func(w http.ResponseWriter, r *http.Request) {
		reply(w, map[string]string{"uuid": uuid.NewString(), "v7": uuid.Must(uuid.NewV7()).String()})
	})
	http.HandleFunc("/emit", func(w http.ResponseWriter, r *http.Request) {
		name := r.URL.Query().Get("name")
		// several events per request, a partial write and a non-event line
		fmt.Printf("{\"event\":%q,\"seq\":1,\"at\":%q}\n", name, time.Now().UTC().Format(time.RFC3339))
		fmt.Print(`{"event":"` + name + `.second",`)
		fmt.Println(`"seq":2}`)
		fmt.Println(`{"level":"info","msg":"not an event"}`)
		_ = json.NewEncoder(os.Stdout).Encode(map[string]any{"event": name + ".third", "seq": 3})
		reply(w, map[string]string{"emitted": name})
	})
	// half an event line per request: the host reads /events in between
	http.HandleFunc("/partial", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("part") == "1" {
			fmt.Print(`{"event":"split",`)
		} else {
			fmt.Println(`"seq":9}`)
		}
		reply(w, map[string]bool{"ok": true})
	})
	http.HandleFunc("/egress", func(w http.ResponseWriter, r *http.Request) {
		out := map[string]string{}
		c := http.Client{Timeout: 3 * time.Second}
		if res, err := c.Get("https://api.stripe.com/v1/charges"); err != nil {
			out["https"] = "BLOCKED"
		} else {
			res.Body.Close()
			out["https"] = "REACHED"
		}
		if conn, err := net.DialTimeout("tcp", "1.1.1.1:443", 3*time.Second); err != nil {
			out["tcp"] = "BLOCKED"
		} else {
			conn.Close()
			out["tcp"] = "REACHED"
		}
		reply(w, out)
	})
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}
	fmt.Println("listening on", port)
	if err := http.ListenAndServe(":"+port, nil); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
