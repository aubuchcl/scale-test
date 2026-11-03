// What is running in the lab right now, and roughly what it costs per hour.
// Read-only. Run: npm run status

import { must } from "./lib/api.js";
import { API_URL, cycle } from "./lib/config.js";
import { findAutoScaleGroup, findEnvironment, formatCost, labServers } from "./lib/inventory.js";
import { loadLab } from "./lib/lab.js";

function age(iso: string | undefined): string {
  if (!iso) {
    return "?";
  }
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (minutes < 120) {
    return `${minutes}m`;
  }
  return `${(minutes / 60).toFixed(1)}h`;
}

async function main(): Promise<void> {
  const lab = loadLab();
  console.log(`Lab status (${API_URL}, cluster ${lab.cluster})\n`);

  const servers = await labServers(lab);
  let total = 0;
  let unknownCost = false;
  console.log(`Servers: ${servers.length}`);
  for (const { server, role, costPerHour } of servers) {
    if (costPerHour === undefined) {
      unknownCost = true;
    } else {
      total += costPerHour;
    }
    console.log(
      `  ${role.padEnd(8)} ${server.hostname}  ${server.state.current}  ${server.provider.model} @ ${server.provider.location}` +
        `  up ${age(server.events.created)}  ${formatCost(costPerHour)}  tags=[${(server.constraints.tags ?? []).join(",")}]`,
    );
  }

  const group = await findAutoScaleGroup(lab.autoscale_group.identifier);
  console.log(`\nAuto-scale group ${lab.autoscale_group.identifier}: ${group ? group.state.current : "not created"}`);

  console.log("\nEnvironments:");
  for (const envConfig of Object.values(lab.environments)) {
    const env = await findEnvironment(envConfig.identifier);
    if (env === undefined) {
      console.log(`  ${envConfig.identifier}: not created`);
      continue;
    }
    console.log(`  ${envConfig.identifier}: ${env.state.current} (cluster ${env.cluster})`);
    const containers = await must(
      `list containers in ${envConfig.identifier}`,
      cycle().GET("/v1/containers", {
        params: { query: { filter: { environment: env.id } } },
      }),
    );
    for (const container of containers.data) {
      console.log(
        `    ${container.identifier.padEnd(10)} ${container.state.current.padEnd(10)} instances=${container.instances}`,
      );
    }
  }

  const costNote = unknownCost ? " (plus servers with unknown pricing)" : "";
  console.log(`\nEstimated running cost: ~$${total.toFixed(3)}/hr${costNote}`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
