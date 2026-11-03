// What the runner needs to know about loadgen/main.js: which environment
// variables it reads, and how many requests a profile should send.

import { durationMs } from "./evaluate.js";

/**
 * Every variable loadgen/main.js reads. Before each run the runner removes all
 * of them from the loadgen container and sets only the scenario's, so a knob
 * from an earlier scenario can't leak into the next one (s3's first run
 * inherited s2's TIME_UNIT=10s and sent a tenth of its load).
 * loadgen.test.ts checks this list against main.js.
 */
export const LOADGEN_KNOBS = [
  "TARGET_URL",
  "SCENARIO",
  "RAMP",
  "HOLD",
  "DOWN",
  "RATE",
  "TIME_UNIT",
  "PRE_VUS",
  "MAX_VUS",
  "BURN_MS",
  "ALLOC_MB",
  "ALLOC_HOLD",
  "VUS",
  "HOLD_S",
  "KB",
] as const;

/** Profiles in main.js that send RATE requests per TIME_UNIT. */
const ARRIVAL_RATE_PROFILES = new Set(["cpu", "ram", "requests", "throughput"]);

/**
 * The container's env with every loadgen knob replaced by `env`. Variables the
 * runner doesn't own (anything not in LOADGEN_KNOBS) are kept.
 */
export function loadgenEnv(current: Record<string, string>, env: Record<string, string>): Record<string, string> {
  const knobs = new Set<string>(LOADGEN_KNOBS);
  const kept = Object.fromEntries(Object.entries(current).filter(([key]) => !knobs.has(key)));
  return { ...kept, ...env };
}

/**
 * Requests an arrival-rate profile should send: linear ramp up, hold, linear
 * ramp down, with main.js's defaults. Undefined for profiles that aren't
 * arrival-rate or when RATE isn't set.
 */
export function plannedRequests(env: Record<string, string>): number | undefined {
  const profile = env.SCENARIO ?? "smoke";
  if (!ARRIVAL_RATE_PROFILES.has(profile) || env.RATE === undefined) {
    return undefined;
  }
  const perMs = Number(env.RATE) / durationMs(env.TIME_UNIT ?? "1s");
  const ramp = durationMs(env.RAMP ?? "2m");
  const hold = durationMs(env.HOLD ?? "15m");
  const down = durationMs(env.DOWN ?? "30s");
  return Math.round(perMs * (ramp / 2 + hold + down / 2));
}
