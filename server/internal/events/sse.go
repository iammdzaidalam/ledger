package events

import (
	"fmt"
	"net/http"
	"time"
)

type SSE struct {
	Bus       Bus
	Keepalive time.Duration
}

func (s SSE) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}
	keepalive := s.Keepalive
	if keepalive <= 0 {
		keepalive = 15 * time.Second
	}
	ch, release := s.Bus.Subscribe(r.URL.Query().Get("swarm"))
	defer release()

	h := w.Header()
	h.Set("Content-Type", "text/event-stream")
	h.Set("Cache-Control", "no-cache")
	h.Set("Connection", "keep-alive")
	h.Set("X-Accel-Buffering", "no")
	fmt.Fprint(w, ": connected\n\n")
	flusher.Flush()

	tick := time.NewTicker(keepalive)
	defer tick.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case e, open := <-ch:
			if !open {
				return
			}
			fmt.Fprintf(w, "data: %s\n\n", e.JSON())
			flusher.Flush()
		case <-tick.C:
			fmt.Fprint(w, ": keepalive\n\n")
			flusher.Flush()
		}
	}
}
