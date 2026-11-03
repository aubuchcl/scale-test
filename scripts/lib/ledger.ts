import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { repoPath } from "./lab.js";

/**
 * Every Cycle resource a run created, by ID. Written as soon as each
 * resource exists, so teardown and resume work even after a crash.
 */
export interface Ledger {
  run_id: string;
  created_at: string;
  environments: { id: string; identifier: string }[];
  stacks: { id: string; identifier: string }[];
  servers: { id: string; hostname: string; role: "baseline" | "burst" }[];
  dns_records: { id: string; zone_id: string; name: string }[];
  autoscale_group?: { id: string; identifier: string };
}

export function resultsDir(runId: string): string {
  return repoPath(join("results", runId));
}

export function emptyLedger(runId: string): Ledger {
  return {
    run_id: runId,
    created_at: new Date().toISOString(),
    environments: [],
    stacks: [],
    servers: [],
    dns_records: [],
  };
}

export function readLedger(runId: string): Ledger {
  const file = join(resultsDir(runId), "ledger.json");
  if (!existsSync(file)) {
    throw new Error(`no ledger at results/${runId}/ledger.json; use --lab to find the lab's resources by name instead`);
  }
  return JSON.parse(readFileSync(file, "utf8")) as Ledger;
}

export function writeLedger(ledger: Ledger): void {
  const dir = resultsDir(ledger.run_id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "ledger.json"), JSON.stringify(ledger, null, 2) + "\n");
}
