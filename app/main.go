// Command scaletest is the workload for the Cycle auto-scaling test lab.
//
// One binary, two modes, selected with MODE:
//
//	app     the service under test: endpoints that burn CPU, hold RAM,
//	        hold connections open and stream bytes on demand.
//	scaler  the webhook Cycle's "custom" scaling threshold calls; it answers
//	        {"instances": N}, and a script changes N through POST /set.
//
// Both modes listen on [::] because Cycle's private network is IPv6-only and
// the load balancer reaches instances over it.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"
)

// identity is what Cycle tells the instance about itself through the
// environment variables it injects. Every response carries it so the load
// generator and the recorder can see which instance and server answered.
type identity struct {
	Mode          string    `json:"mode"`
	InstanceID    string    `json:"instance_id"`
	ContainerID   string    `json:"container_id"`
	EnvironmentID string    `json:"environment_id"`
	ServerID      string    `json:"server_id"`
	Provider      string    `json:"provider"`
	Location      string    `json:"location"`
	Cluster       string    `json:"cluster"`
	Hostname      string    `json:"hostname"`
	StartedAt     time.Time `json:"started_at"`
}

func loadIdentity(mode string) identity {
	hostname, err := os.Hostname()
	if err != nil {
		hostname = "unknown"
	}
	return identity{
		Mode:          mode,
		InstanceID:    envOr("CYCLE_INSTANCE_ID", "local"),
		ContainerID:   envOr("CYCLE_CONTAINER_ID", "local"),
		EnvironmentID: envOr("CYCLE_ENVIRONMENT_ID", "local"),
		ServerID:      envOr("CYCLE_SERVER_ID", "local"),
		Provider:      envOr("CYCLE_PROVIDER_VENDOR", "local"),
		Location:      envOr("CYCLE_PROVIDER_LOCATION", "local"),
		Cluster:       envOr("CYCLE_CLUSTER", "local"),
		Hostname:      hostname,
		StartedAt:     time.Now().UTC(),
	}
}

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	slog.SetDefault(logger)

	mode := envOr("MODE", "app")
	id := loadIdentity(mode)
	listen := envOr("LISTEN", "[::]:80")

	var handler http.Handler
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	switch mode {
	case "app":
		a := newApp(id)
		go a.logStats(ctx, envDuration("STATS_INTERVAL", 10*time.Second))
		handler = a.routes()
	case "scaler":
		s := newScaler(id, envInt("INSTANCES", 1), os.Getenv("SCALER_TOKEN"))
		handler = s.routes()
	default:
		slog.Error("unknown MODE; expected app or scaler", "mode", mode)
		os.Exit(2)
	}

	srv := &http.Server{
		Addr:              listen,
		Handler:           withIdentityHeader(id, handler),
		ReadHeaderTimeout: 10 * time.Second,
		// No write timeout: /hold and /bytes deliberately keep responses open.
	}

	slog.Info("starting", "identity", id, "listen", listen)

	errCh := make(chan error, 1)
	go func() {
		errCh <- srv.ListenAndServe()
	}()

	select {
	case err := <-errCh:
		if err != nil && !errors.Is(err, http.ErrServerClosed) {
			slog.Error("server stopped", "error", err)
			os.Exit(1)
		}
	case <-ctx.Done():
		slog.Info("shutting down")
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		err := srv.Shutdown(shutdownCtx)
		if err != nil {
			slog.Error("shutdown", "error", err)
		}
	}
}

// withIdentityHeader tags every response with the answering instance so a
// load generator can count how traffic spreads across instances.
func withIdentityHeader(id identity, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Instance-Id", id.InstanceID)
		w.Header().Set("X-Server-Id", id.ServerID)
		next.ServeHTTP(w, r)
	})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	err := json.NewEncoder(w).Encode(v)
	if err != nil {
		slog.Warn("write response", "error", err)
	}
}
