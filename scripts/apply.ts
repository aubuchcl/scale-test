// Applies one scenario's auto-scaling settings (and resources, if it has
// any) to the app container in the lab environment.
//
//   npm run apply -- s1-cpu          dry run: shows the change
//   npm run apply -- s1-cpu --yes    applies it
//
// Applying is a container reconfigure, which restarts every app instance.

import { parseArgs } from "node:util";
import type { components } from "@cycleplatform/api-client-typescript";
import { must } from "./lib/api.js";
import { API_URL, cycle } from "./lib/config.js";
import { findEnvironment } from "./lib/inventory.js";
import { jobIdOf, waitForJob } from "./lib/jobs.js";
import { loadLab, readJson } from "./lib/lab.js";

type Config = components["schemas"]["Config"];

interface Scenario {
  id: string;
  title?: string;
  scale?: Config["scale"];
  resources?: Config["resources"];
}

const APP_CONTAINER = "app";

function show(label: string, before: unknown, after: unknown): boolean {
  const a = JSON.stringify(before ?? null, null, 2);
  const b = JSON.stringify(after ?? null, null, 2);
  if (a === b) {
    console.log(`${label}: unchanged`);
    return false;
  }
  console.log(`${label}:\n  from ${a.replace(/\n/g, "\n       ")}\n  to   ${b.replace(/\n/g, "\n       ")}`);
  return true;
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { yes: { type: "boolean", default: false } },
  });
  const scenarioId = positionals[0];
  if (scenarioId === undefined) {
    console.error("Usage: npm run apply -- <scenario-id> [--yes]   e.g. s1-cpu");
    process.exit(2);
  }

  const lab = loadLab();
  const scenario = readJson<Scenario>(`scenarios/${scenarioId}.json`);
  if (scenario.scale === undefined && scenario.resources === undefined) {
    console.log(`${scenario.id} has no scale or resources block; nothing to apply.`);
    return;
  }

  const env = await findEnvironment(lab.environments.lab.identifier);
  if (env === undefined) {
    throw new Error(`environment ${lab.environments.lab.identifier} not found; set up the lab first`);
  }
  const list = await must(
    `find ${APP_CONTAINER} in ${env.identifier}`,
    cycle().GET("/v1/containers", {
      params: { query: { filter: { identifier: APP_CONTAINER, environment: env.id } } },
    }),
  );
  const container = list.data.find((c) => c.identifier === APP_CONTAINER && c.state.current !== "deleted");
  if (container === undefined) {
    throw new Error(`container ${APP_CONTAINER} not found in ${env.identifier}`);
  }

  console.log(`Applying ${scenario.id}${scenario.title ? ` (${scenario.title})` : ""} to ${APP_CONTAINER} in ${env.identifier} on ${API_URL}\n`);
  const current = container.config;
  const next: Config = {
    ...current,
    scale: scenario.scale ?? current.scale,
    resources: scenario.resources ?? current.resources,
  };
  const scaleChanged = show("scale", current.scale, next.scale);
  const resourcesChanged = show("resources", current.resources, next.resources);
  if (!scaleChanged && !resourcesChanged) {
    console.log("\nAlready applied.");
    return;
  }

  if (!values.yes) {
    console.log("\nDry run. Re-run with --yes to apply (restarts every app instance).");
    return;
  }

  const body = await must(
    `reconfigure ${APP_CONTAINER}`,
    cycle().POST("/v1/containers/{containerId}/tasks", {
      params: { path: { containerId: container.id } },
      body: { action: "reconfigure", contents: next },
    }),
  );
  const jobId = jobIdOf(body);
  if (jobId !== undefined) {
    await waitForJob(jobId, `reconfigure ${APP_CONTAINER}`, 5 * 60_000);
  }
  console.log(`\nApplied ${scenario.id}.`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
