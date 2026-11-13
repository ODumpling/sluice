// Sluice determinism shim (go mode), overlaid into package net/http as
// zz_sluice.go: every sandboxed service is an HTTP server, so net/http is
// always linked. When SLUICE_CONTROL_PORT is set, init starts the control
// server (same protocol as the Node shim):
//
//	POST /clock {"nowMs": n}   move the frozen clock
//	GET  /state                {"nowMs", "seed", "events"}
//	GET  /events?since=N       {"total", "events": [...]}
//
// and captures domain events: JSON lines with a string "event" key written to
// stdout (os.Stdout / fd 1), synchronously inside (*os.File).Write.

package http

import (
	"bytes"
	"encoding/json"
	"net"
	"os"
	"strconv"
	"sync"
	"time"
)

var sluiceEv struct {
	mu      sync.Mutex
	partial []byte
	events  []json.RawMessage
}

const sluiceMaxEvents = 100000

func sluiceTap(b []byte) {
	defer func() { _ = recover() }() // never break the app's output
	e := &sluiceEv
	e.mu.Lock()
	defer e.mu.Unlock()
	e.partial = append(e.partial, b...)
	for {
		i := bytes.IndexByte(e.partial, '\n')
		if i < 0 {
			break
		}
		line := bytes.TrimSpace(e.partial[:i])
		e.partial = e.partial[i+1:]
		if len(line) == 0 || line[0] != '{' || len(e.events) >= sluiceMaxEvents {
			continue
		}
		var v map[string]json.RawMessage
		if json.Unmarshal(line, &v) != nil {
			continue
		}
		if name, ok := v["event"]; !ok || len(name) == 0 || name[0] != '"' {
			continue
		}
		e.events = append(e.events, json.RawMessage(bytes.Clone(line)))
	}
	if len(e.partial) > 1<<20 { // a huge line without newline: not an event
		e.partial = nil
	} else {
		e.partial = bytes.Clone(e.partial)
	}
}

func sluiceControl(w ResponseWriter, r *Request) {
	if r.Method == MethodPost && r.URL.Path == "/clock" {
		var v struct {
			NowMs *json.Number `json:"nowMs"`
		}
		dec := json.NewDecoder(r.Body)
		dec.UseNumber()
		if dec.Decode(&v) == nil && v.NowMs != nil {
			if f, err := v.NowMs.Float64(); err == nil {
				time.SluiceSetNowMs(int64(f))
			}
		}
	}
	w.Header().Set("content-type", "application/json")
	e := &sluiceEv
	e.mu.Lock()
	defer e.mu.Unlock()
	if r.URL.Path == "/events" {
		since, _ := strconv.Atoi(r.URL.Query().Get("since"))
		if since < 0 || since > len(e.events) {
			since = len(e.events)
		}
		evs := e.events[since:]
		if evs == nil {
			evs = []json.RawMessage{}
		}
		_ = json.NewEncoder(w).Encode(struct {
			Total  int               `json:"total"`
			Events []json.RawMessage `json:"events"`
		}{len(e.events), evs})
		return
	}
	seed, _ := strconv.ParseInt(os.Getenv("SLUICE_SEED"), 10, 64)
	_ = json.NewEncoder(w).Encode(struct {
		NowMs  int64 `json:"nowMs"`
		Seed   int64 `json:"seed"`
		Events int   `json:"events"`
	}{time.SluiceNowMs(), seed, len(e.events)})
}

func init() {
	port := os.Getenv("SLUICE_CONTROL_PORT")
	if port == "" {
		return
	}
	ln, err := net.Listen("tcp", ":"+port)
	if err != nil {
		return // e.g. a second Go program in the same container
	}
	os.SluiceStdoutTap = sluiceTap
	srv := &Server{Handler: HandlerFunc(sluiceControl), ReadHeaderTimeout: 10 * time.Second}
	go func() { _ = srv.Serve(ln) }()
}
