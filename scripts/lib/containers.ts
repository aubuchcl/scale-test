import type { components } from "@cycleplatform/api-client-typescript";
import { must } from "./api.js";
import { cycle } from "./config.js";
import { findEnvironment } from "./inventory.js";
import { jobIdOf, waitForJob } from "./jobs.js";

export type Container = components["schemas"]["Container"];
export type Config = components["schemas"]["Config"];
export type Instance = components["schemas"]["Instance"];

export async function findContainer(envIdentifier: string, identifier: string): Promise<Container> {
  const env = await findEnvironment(envIdentifier);
  if (env === undefined) {
    throw new Error(`environment ${envIdentifier} not found; set up the lab first`);
  }
  const list = await must(
    `find ${identifier} in ${envIdentifier}`,
    cycle().GET("/v1/containers", {
      params: { query: { filter: { identifier, environment: env.id } } },
    }),
  );
  const container = list.data.find((c) => c.identifier === identifier && c.state.current !== "deleted");
  if (container === undefined) {
    throw new Error(`container ${identifier} not found in ${envIdentifier}`);
  }
  return container;
}

export async function getContainer(containerId: string): Promise<Container> {
  const body = await must(
    `get container ${containerId}`,
    cycle().GET("/v1/containers/{containerId}", { params: { path: { containerId } } }),
  );
  return body.data;
}

/** Replace a container's whole config (Cycle's reconfigure restarts running instances). */
export async function reconfigure(container: Container, config: Config): Promise<void> {
  const body = await must(
    `reconfigure ${container.identifier}`,
    cycle().POST("/v1/containers/{containerId}/tasks", {
      params: { path: { containerId: container.id } },
      body: { action: "reconfigure", contents: config },
    }),
  );
  const jobId = jobIdOf(body);
  if (jobId !== undefined) {
    await waitForJob(jobId, `reconfigure ${container.identifier}`, 5 * 60_000);
  }
}

export async function containerAction(container: Container, action: "start" | "stop"): Promise<void> {
  const body = await must(
    `${action} ${container.identifier}`,
    cycle().POST("/v1/containers/{containerId}/tasks", {
      params: { path: { containerId: container.id } },
      body: { action },
    }),
  );
  const jobId = jobIdOf(body);
  if (jobId !== undefined) {
    await waitForJob(jobId, `${action} ${container.identifier}`, 5 * 60_000);
  }
}

/** Live (non-deleted) instances of a container. */
export async function listInstances(containerId: string): Promise<Instance[]> {
  const body = await must(
    `list instances of ${containerId}`,
    cycle().GET("/v1/containers/{containerId}/instances", {
      params: { path: { containerId }, query: { page: { size: 100 } } },
    }),
  );
  return body.data.filter((i) => i.state.current !== "deleted");
}

/** Creation time encoded in a Cycle (Mongo ObjectID) resource ID. */
export function idTime(id: string): Date {
  return new Date(parseInt(id.slice(0, 8), 16) * 1000);
}
