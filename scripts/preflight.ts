// Read-only checks before anything is created. Exits non-zero when a
// blocking problem is found, so later scripts can run it first and stop.
//
// Run: npm run preflight

import { ApiError, must } from "./lib/api.js";
import { API_URL, cycle, hubId } from "./lib/config.js";
import { findAutoScaleGroup, findEnvironment, labServers } from "./lib/inventory.js";
import { loadLab } from "./lib/lab.js";

type Level = "ok" | "info" | "warn" | "block";

const results: { level: Level; message: string }[] = [];

function report(level: Level, message: string): void {
  results.push({ level, message });
  const tag = { ok: "  ok   ", info: "  info ", warn: "  WARN ", block: "  BLOCK" }[level];
  console.log(`${tag} ${message}`);
}

async function step(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof ApiError) {
      report("block", `${name}: ${err.message}`);
      return;
    }
    report("block", `${name}: ${errorText(err)}`);
  }
}

/** fetch() hides the useful part (DNS, TLS, refused) in err.cause. */
function errorText(err: unknown): string {
  if (!(err instanceof Error)) {
    return String(err);
  }
  if (err.cause instanceof Error) {
    return `${err.message} (${err.cause.message}); is ${API_URL} reachable from this machine?`;
  }
  return err.message;
}

async function main(): Promise<void> {
  const lab = loadLab();
  console.log(`Preflight against ${API_URL}\n`);

  await step("credentials", async () => {
    cycle();
    report("ok", "DEVAPI and DEVHUBID are set");
  });
  if (results.some((r) => r.level === "block")) {
    return;
  }

  await step("hub id", async () => {
    if (hubId() !== lab.hub.id) {
      report("block", `DEVHUBID is ${hubId()}, but lab.config.json expects "${lab.hub.name}" (${lab.hub.id})`);
      return;
    }
    report("ok", `DEVHUBID matches lab.config.json (${lab.hub.name})`);
  });

  await step("reach the API", async () => {
    const hub = await must("get current hub", cycle().GET("/v1/hubs/current", {}));
    report("ok", `API key works; hub is "${hub.data?.name ?? "unknown"}"`);
  });
  if (results.some((r) => r.level === "block")) {
    return;
  }

  await step("cluster", async () => {
    await must(
      `get cluster ${lab.cluster}`,
      cycle().GET("/v1/infrastructure/clusters/{clusterId}", {
        params: { path: { clusterId: lab.cluster } },
      }),
    );
    report("ok", `cluster ${lab.cluster} exists`);
  });

  await step("servers", async () => {
    const servers = await labServers(lab);
    const foreign = servers.filter((s) => s.role === "foreign");
    for (const s of foreign) {
      report("block", `server ${s.server.hostname} in ${lab.cluster} has none of the lab's tags; the scripts won't touch a cluster they don't fully own`);
    }
    const baseline = servers.filter((s) => s.role === "baseline").length;
    const burst = servers.filter((s) => s.role === "burst").length;
    report("info", `servers in ${lab.cluster}: ${baseline} baseline, ${burst} burst`);
  });

  await step("auto-scale group", async () => {
    const group = await findAutoScaleGroup(lab.autoscale_group.identifier);
    if (group === undefined) {
      report("warn", `auto-scale group ${lab.autoscale_group.identifier} not found; create it from ${lab.autoscale_group.file} (needed for s8/s9 only)`);
      return;
    }
    report("ok", `auto-scale group ${group.identifier} exists (cluster ${group.cluster})`);
  });

  await step("environments", async () => {
    for (const env of Object.values(lab.environments)) {
      const found = await findEnvironment(env.identifier);
      if (found === undefined) {
        report("info", `environment ${env.identifier} not created yet`);
        continue;
      }
      report("info", `environment ${env.identifier} exists (state ${found.state.current}, cluster ${found.cluster})`);
    }
  });

  await step("dns zone", async () => {
    const zones = await must(
      "list dns zones",
      cycle().GET("/v1/dns/zones", { params: { query: { page: { size: 100 } } } }),
    );
    const zone = zones.data.find((z) => z.origin === lab.dns.zone);
    if (zone === undefined) {
      report("warn", `DNS zone ${lab.dns.zone} not found on the hub; the app and scaler need it for their public hostnames`);
      return;
    }
    report("ok", `DNS zone ${lab.dns.zone} exists`);
  });

  report(
    "info",
    "write permissions can't be checked without writing; the key needs to manage servers, environments, stacks, containers, DNS and auto-scale groups",
  );
}

main()
  .catch((err: unknown) => {
    report("block", err instanceof Error ? err.message : String(err));
  })
  .finally(() => {
    const blocking = results.filter((r) => r.level === "block").length;
    const warnings = results.filter((r) => r.level === "warn").length;
    if (blocking > 0) {
      console.log(`\nNot ready: ${blocking} blocking problem(s), ${warnings} warning(s).`);
      process.exit(1);
    }
    console.log(`\nReady${warnings > 0 ? ` with ${warnings} warning(s)` : ""}.`);
  });
