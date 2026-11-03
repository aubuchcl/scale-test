package main

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"log/slog"
	"net/http"
	"sync"
	"sync/atomic"
	"time"
)

const (
	maxBurnMS       = 10_000
	maxAllocCallMB  = 512
	maxHoldDuration = 10 * time.Minute
	maxBytesKB      = 1 << 20 // 1 GiB per request
	pageSize        = 4096
)

// app is the service under test. Each endpoint creates one kind of load that
// a Cycle scaling threshold measures:
//
//	/burn   CPU            (threshold: cpu)
//	/alloc  RAM            (threshold: ram)
//	/hold   open conns     (threshold: network-connections)
//	/bytes  throughput     (threshold: network-throughput)
//	any     request count  (threshold: network-requests)
type app struct {
	id identity

	requests  atomic.Int64
	inflight  atomic.Int64
	bytesSent atomic.Int64

	allocMu      sync.Mutex
	allocations  map[int64][]byte
	allocNextID  int64
	allocatedMB  atomic.Int64
	maxAllocMB   int64
	streamBuffer []byte
}

func newApp(id identity) *app {
	buf := make([]byte, 64*1024)
	_, err := rand.Read(buf)
	if err != nil {
		slog.Warn("random stream buffer", "error", err)
	}
	return &app{
		id:           id,
		allocations:  map[int64][]byte{},
		maxAllocMB:   int64(envInt("MAX_ALLOC_MB", 1024)),
		streamBuffer: buf,
	}
}

func (a *app) routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
	mux.HandleFunc("GET /stats", a.handleStats)
	mux.HandleFunc("GET /burn", a.counted(a.handleBurn))
	mux.HandleFunc("GET /alloc", a.counted(a.handleAlloc))
	mux.HandleFunc("GET /free", a.counted(a.handleFree))
	mux.HandleFunc("GET /hold", a.counted(a.handleHold))
	mux.HandleFunc("GET /bytes", a.counted(a.handleBytes))
	mux.HandleFunc("GET /{$}", a.counted(a.handleStats))
	return mux
}

// counted tracks totals and in-flight requests for the stats log line.
// /healthz and /stats are excluded so health checks don't skew the numbers.
func (a *app) counted(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		a.requests.Add(1)
		a.inflight.Add(1)
		defer a.inflight.Add(-1)
		next(w, r)
	}
}

type statsSnapshot struct {
	Identity    identity `json:"identity"`
	Requests    int64    `json:"requests"`
	Inflight    int64    `json:"inflight"`
	BytesSent   int64    `json:"bytes_sent"`
	AllocatedMB int64    `json:"allocated_mb"`
	UptimeSec   int64    `json:"uptime_sec"`
}

func (a *app) snapshot() statsSnapshot {
	return statsSnapshot{
		Identity:    a.id,
		Requests:    a.requests.Load(),
		Inflight:    a.inflight.Load(),
		BytesSent:   a.bytesSent.Load(),
		AllocatedMB: a.allocatedMB.Load(),
		UptimeSec:   int64(time.Since(a.id.StartedAt).Seconds()),
	}
}

func (a *app) handleStats(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, a.snapshot())
}

// handleBurn spins one core for ?ms= milliseconds (default 100).
func (a *app) handleBurn(w http.ResponseWriter, r *http.Request) {
	ms := queryInt(r, "ms", 100, 1, maxBurnMS)
	deadline := time.Now().Add(time.Duration(ms) * time.Millisecond)
	sum := sha256.Sum256(nil)
	rounds := 0
	for time.Now().Before(deadline) {
		for i := 0; i < 1000; i++ {
			sum = sha256.Sum256(sum[:])
		}
		rounds++
		if r.Context().Err() != nil {
			break
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"instance_id": a.id.InstanceID,
		"burned_ms":   ms,
		"rounds":      rounds,
		"digest":      hex.EncodeToString(sum[:4]),
	})
}

// handleAlloc allocates ?mb= MiB (default 64), touches every page so it is
// really resident, and holds it for ?hold= (default 60s) before releasing it.
// It returns immediately; the memory is held in the background.
func (a *app) handleAlloc(w http.ResponseWriter, r *http.Request) {
	mb := int64(queryInt(r, "mb", 64, 1, maxAllocCallMB))
	hold := queryDuration(r, "hold", 60*time.Second, maxHoldDuration)

	if a.allocatedMB.Load()+mb > a.maxAllocMB {
		writeJSON(w, http.StatusTooManyRequests, map[string]any{
			"error":        "allocation cap reached",
			"allocated_mb": a.allocatedMB.Load(),
			"max_alloc_mb": a.maxAllocMB,
		})
		return
	}

	buf := make([]byte, mb*1024*1024)
	for i := 0; i < len(buf); i += pageSize {
		buf[i] = 1
	}

	a.allocMu.Lock()
	a.allocNextID++
	allocID := a.allocNextID
	a.allocations[allocID] = buf
	a.allocMu.Unlock()
	total := a.allocatedMB.Add(mb)

	time.AfterFunc(hold, func() {
		a.release(allocID, mb)
	})

	writeJSON(w, http.StatusOK, map[string]any{
		"instance_id":  a.id.InstanceID,
		"allocated_mb": mb,
		"total_mb":     total,
		"hold":         hold.String(),
	})
}

func (a *app) release(allocID, mb int64) {
	a.allocMu.Lock()
	_, ok := a.allocations[allocID]
	if ok {
		delete(a.allocations, allocID)
	}
	a.allocMu.Unlock()
	if ok {
		a.allocatedMB.Add(-mb)
	}
}

// handleFree releases every held allocation at once.
func (a *app) handleFree(w http.ResponseWriter, r *http.Request) {
	a.allocMu.Lock()
	freed := len(a.allocations)
	a.allocations = map[int64][]byte{}
	a.allocMu.Unlock()
	a.allocatedMB.Store(0)
	writeJSON(w, http.StatusOK, map[string]any{
		"instance_id": a.id.InstanceID,
		"freed":       freed,
	})
}

// handleHold keeps the connection open for ?s= seconds (default 30), or until
// the client goes away, so open-connection counts can be driven up cheaply.
func (a *app) handleHold(w http.ResponseWriter, r *http.Request) {
	seconds := queryInt(r, "s", 30, 1, int(maxHoldDuration.Seconds()))
	timer := time.NewTimer(time.Duration(seconds) * time.Second)
	defer timer.Stop()
	select {
	case <-timer.C:
		writeJSON(w, http.StatusOK, map[string]any{
			"instance_id": a.id.InstanceID,
			"held_s":      seconds,
		})
	case <-r.Context().Done():
	}
}

// handleBytes streams ?kb= KiB (default 1024) of incompressible data.
func (a *app) handleBytes(w http.ResponseWriter, r *http.Request) {
	kb := int64(queryInt(r, "kb", 1024, 1, maxBytesKB))
	remaining := kb * 1024
	w.Header().Set("Content-Type", "application/octet-stream")
	w.WriteHeader(http.StatusOK)
	for remaining > 0 {
		chunk := a.streamBuffer
		if int64(len(chunk)) > remaining {
			chunk = chunk[:remaining]
		}
		n, err := w.Write(chunk)
		a.bytesSent.Add(int64(n))
		if err != nil {
			return
		}
		remaining -= int64(n)
	}
}

// logStats writes one JSON line per interval. The collector pulls these from
// the container logs before teardown, so the record keeps the app's own view
// of the load next to Cycle's.
func (a *app) logStats(ctx context.Context, interval time.Duration) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			s := a.snapshot()
			slog.Info("stats",
				"instance_id", s.Identity.InstanceID,
				"server_id", s.Identity.ServerID,
				"requests", s.Requests,
				"inflight", s.Inflight,
				"bytes_sent", s.BytesSent,
				"allocated_mb", s.AllocatedMB,
				"uptime_sec", s.UptimeSec,
			)
		}
	}
}
