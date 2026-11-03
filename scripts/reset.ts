// Removes leftover auto-scaled app instances so the next test starts from the
// app's base instance count. Used when Cycle's auto-scaler leaves extra
// instances behind (seen in s0: it would not remove the last one).
//
//   npm run reset          dry run: lists what it would delete
//   npm run reset -- --yes deletes them

import { parseArgs } from "node:util";
import { must } from "./lib/api.js";
import { API_URL, cycle } from "./lib/config.js";
import { findContainer, idTime, listInstances } from "./lib/containers.js";
import { jobIdOf, waitForJob } from "./lib/jobs.js";
import { loadLab } from "./lib/lab.js";

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { yes: { type: "boolean", default: false } } });
  const lab = loadLab();
  const app = await findContainer(lab.environments.lab.identifier, "app");
  const base = app.config.deploy.instances;
  const instances = await listInstances(app.id);

  // Prefer Cycle's own marker; fall back to "newest beyond the base count".
  let extras = instances.filter((i) => i.autoscale);
  if (extras.length === 0 && instances.length > base) {
    extras = [...instances].sort((a, b) => idTime(b.id).getTime() - idTime(a.id).getTime()).slice(0, instances.length - base);
  }

  console.log(`app in ${lab.environments.lab.identifier} on ${API_URL}: ${instances.length} instance(s), base ${base}`);
  for (const i of instances) {
    const mark = extras.some((e) => e.id === i.id) ? "extra" : "base ";
    console.log(`  ${mark} ${i.id} ${i.state.current} created ${idTime(i.id).toISOString()}${i.autoscale ? ` (auto-scaled, min_ttl ${i.autoscale.min_ttl})` : ""}`);
  }
  if (extras.length === 0) {
    console.log("\nNothing to remove.");
    return;
  }
  if (!values.yes) {
    console.log(`\nDry run. Re-run with --yes to delete ${extras.length} extra instance(s).`);
    return;
  }
  for (const i of extras) {
    const body = await must(
      `delete instance ${i.id}`,
      cycle().DELETE("/v1/containers/{containerId}/instances/{instanceId}", {
        params: { path: { containerId: app.id, instanceId: i.id } },
      }),
    );
    const jobId = jobIdOf(body);
    if (jobId !== undefined) {
      await waitForJob(jobId, `delete instance ${i.id}`, 5 * 60_000);
    }
    console.log(`deleted ${i.id}`);
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
