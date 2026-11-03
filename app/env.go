package main

import (
	"net/http"
	"os"
	"strconv"
	"time"
)

func envOr(key, fallback string) string {
	value := os.Getenv(key)
	if value == "" {
		return fallback
	}
	return value
}

func envInt(key string, fallback int) int {
	value, err := strconv.Atoi(os.Getenv(key))
	if err != nil {
		return fallback
	}
	return value
}

func envDuration(key string, fallback time.Duration) time.Duration {
	value, err := time.ParseDuration(os.Getenv(key))
	if err != nil {
		return fallback
	}
	return value
}

// queryInt reads an integer query parameter, falling back to def when it is
// absent and clamping it to [min, max] so a typo can't take the instance down.
func queryInt(r *http.Request, key string, def, min, max int) int {
	raw := r.URL.Query().Get(key)
	if raw == "" {
		return def
	}
	value, err := strconv.Atoi(raw)
	if err != nil {
		return def
	}
	if value < min {
		return min
	}
	if value > max {
		return max
	}
	return value
}

func queryDuration(r *http.Request, key string, def, max time.Duration) time.Duration {
	raw := r.URL.Query().Get(key)
	if raw == "" {
		return def
	}
	value, err := time.ParseDuration(raw)
	if err != nil {
		return def
	}
	if value < 0 {
		return def
	}
	if value > max {
		return max
	}
	return value
}
