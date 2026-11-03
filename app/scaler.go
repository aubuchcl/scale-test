package main

import (
	"crypto/subtle"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// scaler is the endpoint for Cycle's "custom" scaling threshold. Cycle calls
// it at half the scaling window and expects {"instances": N} back.
// The test scripts change N with POST /set, which needs SCALER_TOKEN.
type scaler struct {
	id       identity
	token    string
	desired  atomic.Int64
	calls    atomic.Int64
	mu       sync.Mutex
	lastCall *webhookCall
}

type webhookCall struct {
	At         time.Time         `json:"at"`
	SinceLast  string            `json:"since_last,omitempty"`
	Method     string            `json:"method"`
	RemoteAddr string            `json:"remote_addr"`
	Query      map[string]string `json:"query"`
	Body       string            `json:"body,omitempty"`
	Answered   int64             `json:"answered"`
}

const maxLoggedBody = 4096

func newScaler(id identity, initial int, token string) *scaler {
	s := &scaler{id: id, token: token}
	s.desired.Store(int64(initial))
	return s
}

func (s *scaler) routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
	mux.HandleFunc("GET /state", s.handleState)
	mux.HandleFunc("POST /set", s.handleSet)
	// Any method: the portal docs say Cycle sends a GET, the API spec's
	// WebhookURL type says POST. The log records which one actually arrives.
	mux.HandleFunc("/{$}", s.handleWebhook)
	return mux
}

// handleWebhook answers Cycle and logs every call, including the time since
// the previous one, so the record shows the cadence Cycle actually polls at.
func (s *scaler) handleWebhook(w http.ResponseWriter, r *http.Request) {
	answer := s.desired.Load()
	now := time.Now().UTC()

	query := map[string]string{}
	for key, values := range r.URL.Query() {
		query[key] = strings.Join(values, ",")
	}

	body, err := io.ReadAll(io.LimitReader(r.Body, maxLoggedBody))
	if err != nil {
		slog.Warn("read webhook body", "error", err)
	}

	call := &webhookCall{
		At:         now,
		Method:     r.Method,
		RemoteAddr: r.RemoteAddr,
		Query:      query,
		Body:       string(body),
		Answered:   answer,
	}

	s.mu.Lock()
	if s.lastCall != nil {
		call.SinceLast = now.Sub(s.lastCall.At).Round(time.Second).String()
	}
	s.lastCall = call
	s.mu.Unlock()
	s.calls.Add(1)

	slog.Info("webhook", "call", call)
	writeJSON(w, http.StatusOK, map[string]int64{"instances": answer})
}

func (s *scaler) handleState(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	last := s.lastCall
	s.mu.Unlock()
	writeJSON(w, http.StatusOK, map[string]any{
		"instances": s.desired.Load(),
		"calls":     s.calls.Load(),
		"last_call": last,
	})
}

// handleSet changes the answer: POST /set?n=5 with
// "Authorization: Bearer <SCALER_TOKEN>". Disabled when no token is set,
// because the scaler is public so that Cycle can reach it.
func (s *scaler) handleSet(w http.ResponseWriter, r *http.Request) {
	if s.token == "" {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "SCALER_TOKEN is not set; /set is disabled"})
		return
	}
	given := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	if subtle.ConstantTimeCompare([]byte(given), []byte(s.token)) != 1 {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "bad token"})
		return
	}
	n := queryInt(r, "n", -1, -1, 1000)
	if n < 0 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "n must be an integer from 0 to 1000"})
		return
	}
	previous := s.desired.Swap(int64(n))
	slog.Info("set", "from", previous, "to", n)
	writeJSON(w, http.StatusOK, map[string]int64{"from": previous, "instances": int64(n)})
}
