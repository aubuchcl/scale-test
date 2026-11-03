package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func testIdentity(mode string) identity {
	return identity{Mode: mode, InstanceID: "inst-1", ServerID: "srv-1", StartedAt: time.Now()}
}

func do(t *testing.T, h http.Handler, method, target string, header map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, target, nil)
	for key, value := range header {
		req.Header.Set(key, value)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func decode(t *testing.T, rec *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	out := map[string]any{}
	err := json.Unmarshal(rec.Body.Bytes(), &out)
	if err != nil {
		t.Fatalf("decode %q: %v", rec.Body.String(), err)
	}
	return out
}

func TestAppEndpoints(t *testing.T) {
	a := newApp(testIdentity("app"))
	h := withIdentityHeader(a.id, a.routes())

	rec := do(t, h, "GET", "/healthz", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("healthz: %d", rec.Code)
	}
	if rec.Header().Get("X-Instance-Id") != "inst-1" {
		t.Fatalf("missing X-Instance-Id header")
	}

	start := time.Now()
	rec = do(t, h, "GET", "/burn?ms=50", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("burn: %d", rec.Code)
	}
	if time.Since(start) < 50*time.Millisecond {
		t.Fatalf("burn returned before 50ms")
	}

	rec = do(t, h, "GET", "/alloc?mb=8&hold=50ms", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("alloc: %d %s", rec.Code, rec.Body.String())
	}
	if a.allocatedMB.Load() != 8 {
		t.Fatalf("allocated_mb = %d, want 8", a.allocatedMB.Load())
	}
	time.Sleep(150 * time.Millisecond)
	if a.allocatedMB.Load() != 0 {
		t.Fatalf("allocation not released after hold, still %d MB", a.allocatedMB.Load())
	}

	rec = do(t, h, "GET", "/bytes?kb=100", nil)
	body, _ := io.ReadAll(rec.Body)
	if len(body) != 100*1024 {
		t.Fatalf("bytes: got %d bytes, want %d", len(body), 100*1024)
	}

	rec = do(t, h, "GET", "/hold?s=1", nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("hold: %d", rec.Code)
	}

	stats := decode(t, do(t, h, "GET", "/stats", nil))
	if stats["requests"].(float64) < 4 {
		t.Fatalf("requests counter not counting: %v", stats["requests"])
	}
}

func TestAllocCap(t *testing.T) {
	a := newApp(testIdentity("app"))
	a.maxAllocMB = 10
	h := a.routes()
	rec := do(t, h, "GET", "/alloc?mb=16&hold=1s", nil)
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("over-cap alloc: got %d, want 429", rec.Code)
	}
}

func TestScaler(t *testing.T) {
	s := newScaler(testIdentity("scaler"), 2, "secret")
	h := s.routes()

	got := decode(t, do(t, h, "GET", "/?container_id=abc", nil))
	if got["instances"].(float64) != 2 {
		t.Fatalf("webhook: got %v, want 2", got["instances"])
	}

	rec := do(t, h, "POST", "/set?n=5", map[string]string{"Authorization": "Bearer wrong"})
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("set with bad token: %d", rec.Code)
	}

	rec = do(t, h, "POST", "/set?n=5", map[string]string{"Authorization": "Bearer secret"})
	if rec.Code != http.StatusOK {
		t.Fatalf("set: %d %s", rec.Code, rec.Body.String())
	}

	got = decode(t, do(t, h, "GET", "/", nil))
	if got["instances"].(float64) != 5 {
		t.Fatalf("webhook after set: got %v, want 5", got["instances"])
	}

	got = decode(t, do(t, h, "POST", "/", nil))
	if got["instances"].(float64) != 5 {
		t.Fatalf("POST webhook: got %v, want 5", got["instances"])
	}

	state := decode(t, do(t, h, "GET", "/state", nil))
	if state["calls"].(float64) != 3 {
		t.Fatalf("calls = %v, want 3", state["calls"])
	}
	last := state["last_call"].(map[string]any)
	if last["method"] != "POST" {
		t.Fatalf("last_call.method = %v, want POST", last["method"])
	}
}

func TestScalerSetDisabledWithoutToken(t *testing.T) {
	s := newScaler(testIdentity("scaler"), 1, "")
	rec := do(t, s.routes(), "POST", "/set?n=3", map[string]string{"Authorization": "Bearer "})
	if rec.Code != http.StatusForbidden {
		t.Fatalf("set without token configured: got %d, want 403", rec.Code)
	}
}
