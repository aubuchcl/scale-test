// Removes everything a session created, in the order Cycle allows:
// environments -> stacks -> burst servers -> baseline server (-> group).
//
//   npm run teardown -- --run <run-id>        resources from that run's ledger
//   npm run teardown -- --lab                 every asl- resource, found by name
//   add --all                                 also delete the auto-scale group
//   add --yes                                 actually delete (default is a dry run)
//
// Safe to re-run: anything already gone is skipped. Exits non-zero and lists
// what's left (with its hourly cost) if anything could not be removed.

import { parseArgs } from "node:util";
import { must, mustDelete } from "./lib/api.js";
import { API_URL, cycle } from "./lib/config.js";
import { findAutoScaleGroup, findEnvironment, formatCost, labServers, type ServerView } from "./lib/inventory.js";
import { jobIdOf, sleep, waitForJob } from "./lib/jobs.js";
import { loadLab, type LabConfig } from "./lib/lab.js";
import { readLedger } from "./lib/ledger.js";

interface Plan {
  environments: { id: string; identifier: string }[];
  stacks: { id: string; identifier: string }[];
  servers: ServerView[];
  group?: { id: string; identifier: string };
}

const ENV_TIMEOUT_MS = 10 * 60_000;
const SERVER_RETRY_MS = 10 * 60_000;

async function findStack(identifier: string): Promise<{ id: string; identifier: string } | undefined> {
  const body = await must(
    `look up stack ${identifier}`,
    cycle().GET("/v1/stacks", { params: { query: { filter: { identifier } } } }),
  );
  const stack = body.data.find(
    (s) => s.identifier === identifier && s.state.current !== "deleted" && s.state.current !== "deleting",
  );
  if (stack === undefined) {
    return undefined;
  }
  return { id: stack.id, identifier };
}

/** --lab: find every lab resource by its configured name. */
async function planFromLab(lab: LabConfig, all: boolean): Promise<Plan> {
  const plan: Plan = { environments: [], stacks: [], servers: [] };
  // loadgen first, so traffic stops before the lab environment goes
  for (const key of ["loadgen", "lab"] as const) {
    const env = await findEnvironment(lab.environments[key].identifier);
    if (env !== undefined && env.state.current !== "deleting") {
      plan.environments.push({ id: env.id, identifier: env.identifier });
    }
  }
  for (const stack of Object.values(lab.stacks)) {
    const found = await findStack(stack.identifier);
    if (found !== undefined) {
      plan.stacks.push(found);
    }
  }
  plan.servers = await labServers(lab);
  if (all) {
    const group = await findAutoScaleGroup(lab.autoscale_group.identifier);
    if (group !== undefined) {
      plan.group = { id: group.id, identifier: group.identifier };
    }
  }
  return plan;
}

/** --run: start from the ledger, but also catch burst servers the group added. */
async function planFromRun(lab: LabConfig, runId: string, all: boolean): Promise<Plan> {
  const ledger = readLedger(runId);
  const fromLab = await planFromLab(lab, all);
  const envIds = new Set(fromLab.environments.map((e) => e.id));
  const stackIds = new Set(fromLab.stacks.map((s) => s.id));
  const ledgerServerIds = new Set(ledger.servers.map((s) => s.id));
  return {
    environments: ledger.environments.filter((e) => envIds.has(e.id)),
    stacks: ledger.stacks.filter((s) => stackIds.has(s.id)),
    // burst servers are created by Cycle, not the run, so they're never in the ledger
    servers: fromLab.servers.filter((s) => ledgerServerIds.has(s.server.id) || s.role === "burst"),
    group: all ? fromLab.group : undefined,
  };
}

function printPlan(plan: Plan): number {
  let hourly = 0;
  console.log("Environments (deleting one removes all of its containers):");
  for (const e of plan.environments) {
    console.log(`  - ${e.identifier} (${e.id})`);
  }
  console.log("Stacks:");
  for (const s of plan.stacks) {
    console.log(`  - ${s.identifier} (${s.id})`);
  }
  console.log("Servers:");
  for (const { server, role, costPerHour } of plan.servers) {
    hourly += costPerHour ?? 0;
    console.log(`  - ${role.padEnd(8)} ${server.hostname} (${server.id}) ${server.state.current} ${formatCost(costPerHour)}`);
  }
  if (plan.group) {
    console.log(`Auto-scale group:\n  - ${plan.group.identifier} (${plan.group.id})`);
  }
  return hourly;
}

async function deleteEnvironment(env: { id: string; identifier: string }): Promise<void> {
  const body = await mustDelete(
    `delete environment ${env.identifier}`,
    cycle().DELETE("/v1/environments/{environmentId}", { params: { path: { environmentId: env.id } } }),
  );
  const jobId = jobIdOf(body);
  if (jobId !== undefined) {
    await waitForJob(jobId, `delete environment ${env.identifier}`, ENV_TIMEOUT_MS);
  }
}

async function deleteStack(stack: { id: string; identifier: string }): Promise<void> {
  const body = await mustDelete(
    `delete stack ${stack.identifier}`,
    cycle().DELETE("/v1/stacks/{stackId}", { params: { path: { stackId: stack.id } } }),
  );
  const jobId = jobIdOf(body);
  if (jobId !== undefined) {
    await waitForJob(jobId, `delete stack ${stack.identifier}`, 5 * 60_000);
  }
}

/** Servers refuse deletion while instances are still draining, so retry. */
async function deleteServer(view: ServerView): Promise<void> {
  const name = `delete server ${view.server.hostname}`;
  const deadline = Date.now() + SERVER_RETRY_MS;
  let attempt = 0;
  while (true) {
    attempt++;
    try {
      const body = await mustDelete(
        name,
        cycle().DELETE("/v1/infrastructure/servers/{serverId}", { params: { path: { serverId: view.server.id } } }),
      );
      const jobId = jobIdOf(body);
      if (jobId !== undefined) {
        await waitForJob(jobId, name, 5 * 60_000);
      }
      return;
    } catch (err) {
      if (Date.now() > deadline) {
        throw err;
      }
      console.log(`    attempt ${attempt} failed (${err instanceof Error ? err.message : String(err)}); retrying in 30s`);
      await sleep(30_000);
    }
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      run: { type: "string" },
      lab: { type: "boolean", default: false },
      all: { type: "boolean", default: false },
      yes: { type: "boolean", default: false },
    },
  });
  if (values.run === undefined && !values.lab) {
    console.error("Say what to tear down: --run <run-id> (from its ledger) or --lab (every asl- resource).");
    process.exit(2);
  }

  const lab = loadLab();
  console.log(`Teardown against ${API_URL}, cluster ${lab.cluster}\n`);

  const plan = values.run !== undefined ? await planFromRun(lab, values.run, values.all) : await planFromLab(lab, values.all);

  const foreign = plan.servers.filter((s) => s.role === "foreign");
  if (foreign.length > 0) {
    for (const s of foreign) {
      console.error(`REFUSING: ${s.server.hostname} in ${lab.cluster} has none of the lab's tags. Remove or retag it by hand first.`);
    }
    process.exit(1);
  }

  const hourly = printPlan(plan);
  const nothing = plan.environments.length + plan.stacks.length + plan.servers.length === 0 && plan.group === undefined;
  if (nothing) {
    console.log("\nNothing to tear down.");
    return;
  }
  console.log(`\nThis stops ~$${hourly.toFixed(3)}/hr of servers.`);
  if (!values.yes) {
    console.log("Dry run. Re-run with --yes to delete.");
    return;
  }

  const failures: string[] = [];
  async function attempt(label: string, fn: () => Promise<void>): Promise<void> {
    console.log(`- ${label}`);
    try {
      await fn();
      console.log("    done");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failures.push(`${label}: ${message}`);
      console.log(`    FAILED: ${message}`);
    }
  }

  for (const env of plan.environments) {
    await attempt(`delete environment ${env.identifier}`, () => deleteEnvironment(env));
  }
  // Cycle won't delete stacks or servers that still have containers on them,
  // so stop here rather than spend 10 minutes per server retrying.
  if (failures.length > 0) {
    plan.stacks = [];
    plan.servers = [];
    plan.group = undefined;
    console.log("- skipping stacks, servers and the group: an environment could not be deleted");
  }
  for (const stack of plan.stacks) {
    await attempt(`delete stack ${stack.identifier}`, () => deleteStack(stack));
  }
  // burst servers first, newest first; the baseline last
  const servers = [...plan.servers].sort((a, b) => {
    if (a.role !== b.role) {
      return a.role === "burst" ? -1 : 1;
    }
    return (b.server.events.created ?? "").localeCompare(a.server.events.created ?? "");
  });
  for (const view of servers) {
    await attempt(`delete server ${view.server.hostname}`, () => deleteServer(view));
  }
  const group = plan.group;
  if (group !== undefined) {
    await attempt(`delete auto-scale group ${group.identifier}`, async () => {
      await mustDelete(
        `delete auto-scale group ${group.identifier}`,
        cycle().DELETE("/v1/infrastructure/auto-scale/groups/{groupId}", { params: { path: { groupId: group.id } } }),
      );
    });
  }

  // Verify against Cycle rather than trusting the steps above.
  const left = await planFromLab(lab, values.all);
  const stillBilling = left.servers.filter((s) => s.server.state.current !== "deleting");
  const leftovers = left.environments.length + left.stacks.length + stillBilling.length + (left.group ? 1 : 0);
  if (failures.length === 0 && leftovers === 0) {
    const deleting = left.servers.length - stillBilling.length;
    console.log(`\nTeardown complete.${deleting > 0 ? ` ${deleting} server(s) still finishing deletion at the provider.` : ""}`);
    return;
  }

  console.log("\nTeardown INCOMPLETE. Still present:");
  const leftHourly = printPlan({ ...left, servers: stillBilling });
  console.log(`\nStill costing ~$${leftHourly.toFixed(3)}/hr. Safe to re-run this command.`);
  for (const f of failures) {
    console.log(`  failure: ${f}`);
  }
  process.exit(1);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
