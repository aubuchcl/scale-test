import { getClient } from "@cycleplatform/api-client-typescript";
import { retryingFetch } from "./retryFetch.js";

// The lab runs against Cycle's dev platform.
export const API_URL = "https://api.dev.cycle.io";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set. Export it before running any script.`);
  }
  return value;
}

export type CycleClient = ReturnType<typeof getClient>;

let client: CycleClient | undefined;

/**
 * The API client, created on first use so scripts that never call Cycle
 * (validate) don't need credentials. The key comes from $DEVAPI and the hub
 * from $DEVHUBID; neither is ever written to a log or record.
 */
export function cycle(): CycleClient {
  if (client === undefined) {
    client = getClient({
      baseUrl: API_URL,
      apiKey: requireEnv("DEVAPI"),
      hubId: requireEnv("DEVHUBID"),
      // Reads retry through brief API outages (up to 5 minutes by default).
      fetch: retryingFetch({ maxWaitMs: Number(process.env.SCALE_TEST_API_RETRY_MS ?? 5 * 60_000) }),
    });
  }
  return client;
}

export function hubId(): string {
  return requireEnv("DEVHUBID");
}
