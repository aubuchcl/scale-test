import type { components } from "@cycleplatform/api-client-typescript";
import { must } from "./api.js";
import { cycle } from "./config.js";
import { hourlyCost, type LabConfig } from "./lab.js";

export type Server = components["schemas"]["Server"];
export type Environment = components["schemas"]["Environment"];
export type AutoScaleGroup = components["schemas"]["AutoScaleGroup"];

export interface ServerView {
  server: Server;
  role: "baseline" | "burst" | "foreign";
  costPerHour: number | undefined;
}

/** Every server in the lab cluster, classified by the tags the lab gives them. */
export async function labServers(lab: LabConfig): Promise<ServerView[]> {
  const body = await must(
    "list servers",
    cycle().GET("/v1/infrastructure/servers", {
      params: { query: { filter: { cluster: lab.cluster } } },
    }),
  );
  const baselineTags = new Set(lab.baseline_server.tags);
  const burstTags = new Set(lab.autoscale_group.tags);

  return body.data
    .filter((server) => server.state.current !== "deleted")
    .map((server) => {
      const tags = server.constraints.tags ?? [];
      let role: ServerView["role"] = "foreign";
      if (server.autoscale || tags.some((t) => burstTags.has(t))) {
        role = "burst";
      } else if (tags.some((t) => baselineTags.has(t))) {
        role = "baseline";
      }
      return { server, role, costPerHour: hourlyCost(lab, server.provider.model) };
    });
}

export async function findEnvironment(identifier: string): Promise<Environment | undefined> {
  const body = await must(
    `look up environment ${identifier}`,
    cycle().GET("/v1/environments", {
      params: { query: { filter: { identifier } } },
    }),
  );
  return body.data.find((env) => env.identifier === identifier && env.state.current !== "deleted");
}

export async function findAutoScaleGroup(identifier: string): Promise<AutoScaleGroup | undefined> {
  const body = await must(
    `look up auto-scale group ${identifier}`,
    cycle().GET("/v1/infrastructure/auto-scale/groups", {
      params: { query: { filter: { identifier } } },
    }),
  );
  return body.data.find((group) => group.identifier === identifier && group.state.current !== "deleted");
}

export function formatCost(value: number | undefined): string {
  if (value === undefined) {
    return "unknown";
  }
  return `~$${value.toFixed(3)}/hr`;
}
