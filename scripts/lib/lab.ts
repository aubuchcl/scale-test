import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export interface LabConfig {
  hub: { id: string; name: string };
  prefix: string;
  cluster: string;
  repo: { url: string; branch: string };
  dns: { zone: string; app: string; scaler: string };
  environments: Record<"lab" | "loadgen", { identifier: string; name: string; cluster: string }>;
  stacks: Record<
    "target" | "loadgen",
    { identifier: string; name: string; file: string; environment: "lab" | "loadgen"; variables: Record<string, string> }
  >;
  baseline_server: {
    provider: string;
    model: string;
    model_id: string;
    location: string;
    location_id: string;
    tags: string[];
    allow: { pool: boolean; services: boolean; overcommit: boolean };
  };
  autoscale_group: { identifier: string; file: string; tags: string[] };
  cost_estimate_usd_per_hour: Record<string, number | string>;
}

export function repoPath(relative: string): string {
  return resolve(REPO_ROOT, relative);
}

export function readJson<T>(relative: string): T {
  return JSON.parse(readFileSync(repoPath(relative), "utf8")) as T;
}

export function loadLab(): LabConfig {
  return readJson<LabConfig>("lab.config.json");
}

/** Tags that mark a server as belonging to the lab. */
export function labServerTags(lab: LabConfig): string[] {
  return [...lab.baseline_server.tags, ...lab.autoscale_group.tags];
}

/** Estimated hourly cost of a server model, or undefined when unknown. */
export function hourlyCost(lab: LabConfig, model: string): number | undefined {
  const value = lab.cost_estimate_usd_per_hour[model];
  if (typeof value === "number") {
    return value;
  }
  return undefined;
}

/** Replace {{var}} stack variables with values, the way Cycle does at build time. */
export function renderStackVariables(text: string, variables: Record<string, string>): string {
  return text.replace(/\{\{\$?([a-z0-9-]+)\}\}/g, (match, name: string) => {
    const value = variables[name];
    if (value === undefined) {
      return match;
    }
    return value;
  });
}
