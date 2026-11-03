// Runs one scenario end to end and records it under results/<run-id>/:
//   apply settings -> back to base -> record -> load -> watch -> collect -> grade
//
//   npm run scenario -- s1-cpu
//
// Exit codes: 0 PASS, 1 FAIL (scaling didn't match expectations),
// 2 ERROR (the harness couldn't do its job), 3 ABORTED (Ctrl-C).
// On ERROR or ABORTED the lab is left running for debugging.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { pullActivity, pullLogs, k6Summary } from "./lib/collect.js";
import { API_URL, hubId } from "./lib/config.js";
import { containerAction, findContainer, getContainer, listInstances, reconfigure, type Config, type Container } from "./lib/containers.js";
import { durationMs, evaluate, fmtMs, type Check } from "./lib/evaluate.js";
import { loadLab, repoPath } from "./lib/lab.js";
import { resultsDir } from "./lib/ledger.js";
import { Ndjson, Recorder, type Sample } from "./lib/recorder.js";

interface Scenario {
  id: string;
  title?: string;
  purpose?: string;
  requires?: string;
  reset?: boolean;
  scale?: Config["scale"];
  resources?: Config["resources"];
  load:
    | { type: "loadgen"; env: Record<string, string> }
    | { type: "scaler"; steps: { after: string; instances: number }[] }
    | { type: "none" };
  observe_after_load: string;
  timeout: string;
  expect: Record<string, unknown>;
}

type Status = "PASS" | "FAIL" | "ERROR" | "ABORTED";

// Overridable only so the runner can be tested against a fake API quickly.
const SAMPLE_EVERY_MS = Number(process.env.SCALE_TEST_SAMPLE_MS ?? 15_000);
const POLL_MS = Number(process.env.SCALE_TEST_POLL_MS ?? 10_000);
const abort = new AbortController();

class Aborted extends Error {}
class TimedOut extends Error {}

let deadline = Number.POSITIVE_INFINITY;

/** Sleep that wakes early on Ctrl-C and refuses to sleep past the scenario timeout. */
async function sleep(ms: number): Promise<void> {
  if (Date.now() + ms > deadline) {
    throw new TimedOut("scenario timeout reached");
  }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    abort.signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new Aborted("aborted"));
      },
      { once: true },
    );
  });
}

function stamp(d: Date): string {
  return d.toISOString().replace(/[-:]/g, "").replace(/\..*/, "").replace("T", "-");
}

function gitCommit(): string {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: repoPath(".") }).toString().trim();
  } catch {
    return "unknown";
  }
}

async function waitFor(what: string, check: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > until) {
      throw new Error(`timed out after ${fmtMs(timeoutMs)} waiting for ${what}`);
    }
    await sleep(POLL_MS);
  }
}

function withEnv(container: Container, env: Record<string, string>): Config {
  const config = container.config;
  return {
    ...config,
    runtime: {
      ...config.runtime,
      environment_vars: { ...(config.runtime?.environment_vars ?? {}), ...env },
    } as Config["runtime"],
  };
}

async function main(): Promise<number> {
  const { positionals } = parseArgs({ allowPositionals: true, options: {} });
  const scenarioId = positionals[0];
  if (scenarioId === undefined) {
    console.error("Usage: npm run scenario -- <scenario-id>   e.g. s1-cpu");
    return 2;
  }

  const lab = loadLab();
  const scenarioText = readFileSync(repoPath(`scenarios/${scenarioId}.json`), "utf8");
  const scenario = JSON.parse(scenarioText) as Scenario;
  const started = new Date();
  const runId = `${stamp(started)}-${scenario.id}`;
  const runDir = resultsDir(runId);
  mkdirSync(join(runDir, "logs"), { recursive: true });
  deadline = started.getTime() + durationMs(scenario.timeout);

  const journal = new Ndjson(join(runDir, "steps.ndjson"));
  const manifest: Record<string, unknown> = {
    run_id: runId,
    scenario: scenario.id,
    scenario_sha256: createHash("sha256").update(scenarioText).digest("hex"),
    git_commit: gitCommit(),
    api_url: API_URL,
    hub_id: hubId(),
    started_at: started.toISOString(),
    status: "running",
  };
  const writeManifest = (): void => writeFileSync(join(runDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  writeManifest();

  async function step<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const t0 = Date.now();
    console.log(`[${new Date().toISOString().slice(11, 19)}] ${name}`);
    journal.write({ at: new Date().toISOString(), step: name, status: "start" });
    try {
      const out = await fn();
      journal.write({ at: new Date().toISOString(), step: name, status: "ok", ms: Date.now() - t0 });
      return out;
    } catch (err) {
      journal.write({ at: new Date().toISOString(), step: name, status: "error", ms: Date.now() - t0, error: String(err) });
      throw err;
    }
  }

  process.on("SIGINT", () => {
    console.log("\nCtrl-C: stopping load, saving records...");
    abort.abort();
  });

  console.log(`Run ${runId} on ${API_URL}\nRecords: results/${runId}/\n`);

  let status: Status = "ERROR";
  let error: string | undefined;
  let recorder: Recorder | undefined;
  let app: Container | undefined;
  let scaler: Container | undefined;
  let loadgen: Container | undefined;
  let loadgenStarted = false;
  let loadStart = new Date();
  let loadEnd = new Date();
  let base = 1;

  const setScaler = async (n: number): Promise<void> => {
    if (scaler === undefined) {
      throw new Error("scaler container not loaded");
    }
    // The scaler reads INSTANCES at start; reconfiguring restarts it with the new answer.
    scaler = await getContainer(scaler.id);
    await reconfigure(scaler, withEnv(scaler, { INSTANCES: String(n) }));
  };

  try {
    app = await step("find containers", async () => findContainer(lab.environments.lab.identifier, "app"));
    scaler = await findContainer(lab.environments.lab.identifier, "scaler");
    loadgen = await findContainer(lab.environments.loadgen.identifier, "loadgen");
    base = app.config.deploy.instances;
    manifest.app_container_id = app.id;
    manifest.base_instances = base;

    if (scenario.reset !== false) {
      const current = app.config;
      const next: Config = {
        ...current,
        scale: scenario.scale ?? current.scale,
        resources: scenario.resources ?? current.resources,
      };
      if (JSON.stringify(next) !== JSON.stringify(current)) {
        await step("apply scenario settings to app (restarts it)", () => reconfigure(app as Container, next));
      }
      if (scenario.load.type === "scaler") {
        await step(`scaler answers ${base} (base)`, () => setScaler(base));
      }
      await step(`wait for app to be back to ${base} instance(s)`, async () => {
        try {
          await waitFor(`${base} instance(s)`, async () => {
            const live = await listInstances((app as Container).id);
            return live.filter((i) => i.state.current === "running").length === base;
          }, 10 * 60_000);
        } catch (err) {
          if (err instanceof Aborted || err instanceof TimedOut) {
            throw err;
          }
          throw new Error(
            `the app didn't get back to ${base} instance(s) within 10m. If extra auto-scaled instances are stuck ` +
              `(as in s0), run \`npm run reset\` to see them and \`npm run reset -- --yes\` to remove them, then rerun.`,
          );
        }
      });
    }

    recorder = new Recorder(lab, app.id, runDir, scenario.load.type === "scaler");
    recorder.start(SAMPLE_EVERY_MS);
    await sleep(SAMPLE_EVERY_MS);

    const load = scenario.load;
    if (load.type === "loadgen") {
      const env: Record<string, string> = { TARGET_URL: `https://${lab.dns.app}`, ...load.env };
      await step(`configure loadgen: ${JSON.stringify(env)}`, async () => {
        const current = await getContainer((loadgen as Container).id);
        await reconfigure(current, withEnv(current, env));
      });
      await step("start loadgen", () => containerAction(loadgen as Container, "start"));
      loadgenStarted = true;
      loadStart = new Date();
      const planned = durationMs(env.RAMP ?? "2m") + durationMs(env.HOLD ?? "15m") + durationMs(env.DOWN ?? "30s");
      await step(`load running for ~${fmtMs(planned)}`, () =>
        waitFor("loadgen to finish", async () => {
          const c = await getContainer((loadgen as Container).id);
          return c.state.current === "stopped";
        }, planned + 5 * 60_000),
      );
      loadgenStarted = false;
      loadEnd = new Date();
    } else if (load.type === "scaler") {
      loadStart = new Date();
      const steps = [...load.steps].sort((a, b) => durationMs(a.after) - durationMs(b.after));
      for (const s of steps) {
        const wait = loadStart.getTime() + durationMs(s.after) - Date.now();
        if (wait > 0) {
          await step(`wait ${fmtMs(wait)}`, () => sleep(wait));
        }
        await step(`scaler answers ${s.instances}`, () => setScaler(s.instances));
      }
      loadEnd = new Date();
    } else {
      loadStart = new Date();
      loadEnd = loadStart;
    }

    await step(`watch for ${scenario.observe_after_load} after load`, () => sleep(durationMs(scenario.observe_after_load)));
    status = "PASS";
  } catch (err) {
    if (err instanceof Aborted) {
      status = "ABORTED";
    } else {
      status = "ERROR";
    }
    error = err instanceof Error ? err.message : String(err);
    console.log(`\n${status}: ${error}`);
  }

  // ---- always: stop load, record, collect, grade ----
  if (loadgenStarted && loadgen !== undefined) {
    try {
      await containerAction(loadgen, "stop");
    } catch (err) {
      console.log(`could not stop loadgen: ${String(err)}`);
    }
  }
  let samples: Sample[] = [];
  if (recorder !== undefined) {
    recorder.stop();
    await recorder.sample();
    samples = recorder.samples;
  }

  const collectFrom = new Date(Math.min(loadStart.getTime(), started.getTime()) - 2 * 60_000);
  const collectTo = new Date();
  const notes: string[] = [];
  let k6: unknown;
  const tryCollect = async (what: string, fn: () => Promise<void>): Promise<void> => {
    try {
      await fn();
    } catch (err) {
      notes.push(`could not collect ${what}: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  if (app !== undefined) {
    const appId = app.id;
    await tryCollect("app logs", async () => {
      await pullLogs(appId, collectFrom, collectTo, join(runDir, "logs", "app.log"));
    });
    await tryCollect("Cycle activity", async () => {
      await pullActivity(appId, started, runDir);
    });
  }
  if (scaler !== undefined && scenario.load.type === "scaler") {
    const scalerId = scaler.id;
    await tryCollect("scaler logs", async () => {
      await pullLogs(scalerId, collectFrom, collectTo, join(runDir, "logs", "scaler.log"));
    });
  }
  if (loadgen !== undefined && scenario.load.type === "loadgen") {
    const loadgenId = loadgen.id;
    await tryCollect("loadgen logs", async () => {
      const lines = await pullLogs(loadgenId, collectFrom, collectTo, join(runDir, "logs", "loadgen.log"));
      k6 = k6Summary(lines);
      if (k6 !== undefined) {
        writeFileSync(join(runDir, "k6-summary.json"), JSON.stringify(k6, null, 2) + "\n");
      }
    });
  }

  let checks: Check[] = [];
  if (status === "PASS") {
    const minTtl = scenario.scale?.instances?.min_ttl ?? app?.config.scale?.instances?.min_ttl;
    checks = evaluate(scenario.expect, samples, { loadStart, loadEnd, base, minTtl });
    if (checks.some((c) => c.pass === false)) {
      status = "FAIL";
    }
  }

  const finished = new Date();
  manifest.finished_at = finished.toISOString();
  manifest.load_start = loadStart.toISOString();
  manifest.load_end = loadEnd.toISOString();
  manifest.status = status;
  if (error !== undefined) {
    manifest.error = error;
  }
  writeManifest();
  writeFileSync(
    join(runDir, "summary.json"),
    JSON.stringify({ run_id: runId, scenario: scenario.id, status, error, checks, notes, k6 }, null, 2) + "\n",
  );
  const report = renderReport({ runId, scenario, status, error, checks, notes, samples, manifest, loadStart, loadEnd, k6 });
  writeFileSync(join(runDir, "report.md"), report);

  // One current report per test, in one place; the aggregate report reads these.
  const reportsDir = repoPath("results/reports");
  mkdirSync(reportsDir, { recursive: true });
  writeFileSync(join(reportsDir, `${scenario.id}.md`), `${report}\nFull records: \`results/${runId}/\`\n`);
  writeFileSync(
    join(reportsDir, `${scenario.id}.json`),
    JSON.stringify({ run_id: runId, scenario: scenario.id, title: scenario.title, status, error, checks, notes, finished_at: manifest.finished_at }, null, 2) + "\n",
  );

  console.log(`\n${report}`);
  if (status === "ERROR" || status === "ABORTED") {
    console.log("The lab is left running for debugging. When done: npm run teardown -- --lab");
  }
  return { PASS: 0, FAIL: 1, ERROR: 2, ABORTED: 3 }[status];
}

function hhmmss(iso: string): string {
  return iso.slice(11, 19);
}

function renderReport(r: {
  runId: string;
  scenario: Scenario;
  status: Status;
  error?: string;
  checks: Check[];
  notes: string[];
  samples: Sample[];
  manifest: Record<string, unknown>;
  loadStart: Date;
  loadEnd: Date;
  k6: unknown;
}): string {
  const lines: string[] = [];
  lines.push(`# ${r.scenario.id}: ${r.status}`, "");
  if (r.scenario.title) {
    lines.push(`**${r.scenario.title}.** ${r.scenario.purpose ?? ""}`, "");
  }
  lines.push(
    `Run \`${r.runId}\` at commit \`${String(r.manifest.git_commit)}\`, ${String(r.manifest.started_at)} → ${String(r.manifest.finished_at)}.`,
    `Load ${hhmmss(r.loadStart.toISOString())} → ${hhmmss(r.loadEnd.toISOString())} UTC.`,
    "",
  );
  if (r.error) {
    lines.push(`**Error:** ${r.error}`, "");
  }
  if (r.checks.length > 0) {
    lines.push("| Check | Expected | Observed | Result |", "|---|---|---|---|");
    for (const c of r.checks) {
      const result = c.pass === null ? "n/a" : c.pass ? "pass" : "**FAIL**";
      lines.push(`| ${c.name} | ${c.expected} | ${c.observed} | ${result} |`);
    }
    lines.push("");
  }

  lines.push("## App instances over time (UTC)", "");
  let last = -1;
  let lastBurst = -1;
  for (const s of r.samples) {
    const burst = s.servers.filter((x) => x.role === "burst" && x.state !== "deleted").length;
    if (s.app.count !== last || burst !== lastBurst) {
      const perServer = new Map<string, number>();
      for (const i of s.app.instances) {
        perServer.set(i.server_id.slice(-6), (perServer.get(i.server_id.slice(-6)) ?? 0) + 1);
      }
      const spread = [...perServer.entries()].map(([id, n]) => `${n} on …${id}`).join(", ");
      lines.push(`- ${hhmmss(s.at)}  **${s.app.count}** instance(s)${spread ? ` (${spread})` : ""}${burst > 0 ? `; ${burst} burst server(s)` : ""}`);
      last = s.app.count;
      lastBurst = burst;
    }
  }
  lines.push("");

  if (r.k6 !== undefined) {
    lines.push("## Load (k6)", "", "```json", JSON.stringify(r.k6, null, 2), "```", "");
  }
  if (r.notes.length > 0) {
    lines.push("## Notes", "", ...r.notes.map((n) => `- ${n}`), "");
  }
  lines.push("Files: manifest.json, steps.ndjson, timeline.ndjson, events.ndjson, logs/, summary.json.", "");
  return lines.join("\n");
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(2);
  });
