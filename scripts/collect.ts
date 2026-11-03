// Re-pulls a past run's logs (and the k6 summary) into results/<run-id>/.
// For runs whose log pull failed, e.g. before the API key had the
// monitoring-logs-view capability. Cycle keeps logs, so this works after the fact.
//
//   npm run collect -- 20261103-174544-s1-cpu

import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { ApiError } from "./lib/api.js";
import { k6Summary, pullLogs } from "./lib/collect.js";
import { findContainer } from "./lib/containers.js";
import { loadLab, readJson, repoPath } from "./lib/lab.js";
import { resultsDir } from "./lib/ledger.js";

interface Manifest {
  run_id: string;
  scenario: string;
  started_at: string;
  finished_at?: string;
  load_start?: string;
  app_container_id?: string;
}

async function main(): Promise<void> {
  const { positionals } = parseArgs({ allowPositionals: true, options: {} });
  const runId = positionals[0];
  if (runId === undefined) {
    console.error("Usage: npm run collect -- <run-id>   (a folder name under results/)");
    process.exit(2);
  }
  const runDir = resultsDir(runId);
  const manifestFile = join(runDir, "manifest.json");
  if (!existsSync(manifestFile)) {
    throw new Error(`no manifest at results/${runId}/manifest.json`);
  }
  const manifest = JSON.parse(readFileSync(manifestFile, "utf8")) as Manifest;
  const scenario = readJson<{ load: { type: string } }>(`scenarios/${manifest.scenario}.json`);
  const lab = loadLab();

  const started = new Date(manifest.started_at);
  const loadStart = manifest.load_start ? new Date(manifest.load_start) : started;
  const from = new Date(Math.min(started.getTime(), loadStart.getTime()) - 2 * 60_000);
  const to = new Date(new Date(manifest.finished_at ?? Date.now()).getTime() + 60_000);
  console.log(`Collecting logs for ${runId}: ${from.toISOString()} → ${to.toISOString()}`);

  const pulled: string[] = [];
  const tryPull = async (what: string, fn: () => Promise<void>): Promise<void> => {
    try {
      await fn();
      pulled.push(what);
      console.log(`  ok    ${what}`);
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) {
        console.log(`  FAIL  ${what}: the API key needs the monitoring-logs-view capability`);
        return;
      }
      console.log(`  FAIL  ${what}: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const appId = manifest.app_container_id ?? (await findContainer(lab.environments.lab.identifier, "app")).id;
  await tryPull("app logs", async () => {
    await pullLogs(appId, from, to, join(runDir, "logs", "app.log"));
  });
  if (scenario.load.type === "scaler") {
    const scaler = await findContainer(lab.environments.lab.identifier, "scaler");
    await tryPull("scaler logs", async () => {
      await pullLogs(scaler.id, from, to, join(runDir, "logs", "scaler.log"));
    });
  }
  if (scenario.load.type === "loadgen") {
    const loadgen = await findContainer(lab.environments.loadgen.identifier, "loadgen");
    await tryPull("loadgen logs + k6 summary", async () => {
      const lines = await pullLogs(loadgen.id, from, to, join(runDir, "logs", "loadgen.log"));
      const k6 = k6Summary(lines);
      if (k6 !== undefined) {
        writeFileSync(join(runDir, "k6-summary.json"), JSON.stringify(k6, null, 2) + "\n");
      }
    });
  }

  if (pulled.length > 0) {
    const note = `\nLogs re-collected with \`npm run collect\` at ${new Date().toISOString()}: ${pulled.join(", ")}.\n`;
    appendFileSync(join(runDir, "report.md"), note);
    const perTest = repoPath(`results/reports/${manifest.scenario}.md`);
    if (existsSync(perTest)) {
      appendFileSync(perTest, note);
    }
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
