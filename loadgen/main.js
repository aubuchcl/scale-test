// Load generator for the Cycle auto-scaling test lab.
//
// The container runs one load profile, chosen with SCENARIO, against
// TARGET_URL and then exits. Every profile has the same shape: ramp up for
// RAMP, hold the peak for HOLD, ramp back down over DOWN. Arrival-rate
// profiles send RATE requests per TIME_UNIT (default 1s).
//
// Profiles and the threshold each one is meant to cross:
//   smoke        2 VUs for 30s, just proves the target answers
//   cpu          /burn            -> cpu
//   ram          /alloc           -> ram
//   requests     /                -> network-requests
//   connections  /hold            -> network-connections (one open connection per VU)
//   throughput   /bytes           -> network-throughput
//
// Every request opens a new connection (REUSE_CONNECTIONS=1 turns keep-alive
// back on). Cycle's load balancer keeps a connection on one instance, so with
// k6's few reused connections, instances added mid-test got no traffic (s1, s3).
// New connections spread the load the way many separate clients would.
//
// Results are printed between K6_SUMMARY_BEGIN / K6_SUMMARY_END markers so the
// collector can pull them out of the container log before teardown.

import http from "k6/http";
import { check } from "k6";

function str(name, fallback) {
  const value = __ENV[name];
  if (value === undefined || value === "") {
    return fallback;
  }
  return value;
}

function num(name, fallback) {
  const raw = __ENV[name];
  if (raw === undefined || raw === "") {
    return fallback;
  }
  const value = Number(raw);
  if (Number.isNaN(value)) {
    throw new Error(`${name} must be a number, got "${raw}"`);
  }
  return value;
}

const TARGET = str("TARGET_URL", "").replace(/\/$/, "");
const SCENARIO = str("SCENARIO", "smoke");
const RAMP = str("RAMP", "2m");
const HOLD = str("HOLD", "15m");
const DOWN = str("DOWN", "30s");

function stages(peak) {
  return [
    { target: peak, duration: RAMP },
    { target: peak, duration: HOLD },
    { target: 0, duration: DOWN },
  ];
}

function arrivalRate(peak) {
  return {
    executor: "ramping-arrival-rate",
    startRate: 0,
    // RATE is requests per TIME_UNIT, so RATE=1 TIME_UNIT=10s is one every 10s.
    timeUnit: str("TIME_UNIT", "1s"),
    preAllocatedVUs: num("PRE_VUS", 50),
    maxVUs: num("MAX_VUS", 500),
    stages: stages(peak),
  };
}

const PROFILES = {
  smoke: {
    executor: { executor: "constant-vus", vus: 2, duration: "30s" },
    path: () => "/",
  },
  cpu: {
    executor: arrivalRate(num("RATE", 5)),
    path: () => `/burn?ms=${num("BURN_MS", 100)}`,
  },
  ram: {
    executor: arrivalRate(num("RATE", 1)),
    path: () => `/alloc?mb=${num("ALLOC_MB", 16)}&hold=${str("ALLOC_HOLD", "60s")}`,
  },
  requests: {
    executor: arrivalRate(num("RATE", 50)),
    path: () => "/",
  },
  connections: {
    executor: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: stages(num("VUS", 200)),
      gracefulRampDown: "0s",
    },
    path: () => `/hold?s=${num("HOLD_S", 30)}`,
  },
  throughput: {
    executor: arrivalRate(num("RATE", 2)),
    path: () => `/bytes?kb=${num("KB", 5120)}`,
  },
};

const profile = PROFILES[SCENARIO];
if (profile === undefined) {
  throw new Error(`unknown SCENARIO "${SCENARIO}"; expected one of ${Object.keys(PROFILES).join(", ")}`);
}

export const options = {
  scenarios: { [SCENARIO]: profile.executor },
  discardResponseBodies: true,
  noConnectionReuse: str("REUSE_CONNECTIONS", "0") !== "1",
  summaryTrendStats: ["avg", "min", "med", "p(90)", "p(95)", "p(99)", "max"],
};

function marker(event, extra) {
  console.log(JSON.stringify({ marker: "k6", event, scenario: SCENARIO, at: new Date().toISOString(), ...extra }));
}

export function setup() {
  if (TARGET === "") {
    throw new Error("TARGET_URL is not set");
  }
  const health = http.get(`${TARGET}/healthz`);
  if (health.status !== 200) {
    throw new Error(`target is not healthy: GET ${TARGET}/healthz returned ${health.status}`);
  }
  marker("load_start", { target: TARGET, ramp: RAMP, hold: HOLD, down: DOWN, path: profile.path() });
}

export default function () {
  const res = http.get(`${TARGET}${profile.path()}`, {
    timeout: "11m",
    tags: { profile: SCENARIO },
  });
  check(res, { "status is 200": (r) => r.status === 200 });
}

export function teardown() {
  marker("load_end", {});
}

function pick(metric, fields) {
  if (metric === undefined) {
    return null;
  }
  const out = {};
  for (const field of fields) {
    out[field] = metric.values[field];
  }
  return out;
}

export function handleSummary(data) {
  const m = data.metrics;
  const summary = {
    scenario: SCENARIO,
    target: TARGET,
    finished_at: new Date().toISOString(),
    http_reqs: pick(m.http_reqs, ["count", "rate"]),
    http_req_failed: pick(m.http_req_failed, ["rate", "passes", "fails"]),
    http_req_duration_ms: pick(m.http_req_duration, ["avg", "med", "p(90)", "p(95)", "p(99)", "max"]),
    iterations: pick(m.iterations, ["count", "rate"]),
    dropped_iterations: pick(m.dropped_iterations, ["count", "rate"]),
    vus_max: pick(m.vus_max, ["value"]),
    data_received_bytes: pick(m.data_received, ["count", "rate"]),
    data_sent_bytes: pick(m.data_sent, ["count", "rate"]),
    checks: pick(m.checks, ["rate", "passes", "fails"]),
  };
  return {
    stdout: `\n=== K6_SUMMARY_BEGIN ===\n${JSON.stringify(summary)}\n=== K6_SUMMARY_END ===\n`,
  };
}
