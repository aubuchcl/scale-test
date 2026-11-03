import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { must } from "./api.js";
import { cycle } from "./config.js";
import { Ndjson } from "./recorder.js";

// Cycle's log lines carry terminal colour codes and \r from the console.
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;

export interface LogLine {
  time: string;
  instance_id?: string | null;
  message: string;
}

/** Pull a container's logs for a time range and save them as plain text. */
export async function pullLogs(
  containerId: string,
  start: Date,
  end: Date,
  file: string,
  limit = 5000,
): Promise<LogLine[]> {
  const body = await must(
    `pull logs for ${containerId}`,
    cycle().POST("/v1/monitoring/logs/aggregate", {
      body: {
        scope: {
          type: "container",
          ids: [containerId],
          date_range: { start: start.toISOString(), end: end.toISOString() },
        },
        limit,
      },
    }),
  );
  const lines = body.data
    .map((l) => ({ time: l.time, instance_id: l.instance_id, message: l.message.replace(ANSI, "").replace(/\r$/, "") }))
    .sort((a, b) => a.time.localeCompare(b.time));
  writeFileSync(file, lines.map((l) => `${l.time} ${l.instance_id ?? "-"} ${l.message}`).join("\n") + "\n");
  return lines;
}

/** The k6 summary JSON the loadgen prints between markers, if present. */
export function k6Summary(lines: LogLine[]): unknown {
  const begin = lines.findIndex((l) => l.message.includes("K6_SUMMARY_BEGIN"));
  if (begin < 0) {
    return undefined;
  }
  const json = lines.slice(begin + 1).find((l) => l.message.trim().startsWith("{"));
  if (json === undefined) {
    return undefined;
  }
  try {
    return JSON.parse(json.message.trim());
  } catch {
    return { unparsed: json.message };
  }
}

/** Cycle's own activity log for a container (autoscale up/down, scale, reconfigure...). */
export async function pullActivity(containerId: string, since: Date, runDir: string): Promise<{ event: string; time: string }[]> {
  const body = await must(
    `pull activity for ${containerId}`,
    cycle().GET("/v1/hubs/current/activity", {
      params: { query: { filter: { container: containerId }, page: { size: 100 } } },
    }),
  );
  const out = new Ndjson(join(runDir, "events.ndjson"));
  const events = body.data
    .filter((a) => new Date(a.time).getTime() >= since.getTime())
    .sort((a, b) => a.time.localeCompare(b.time));
  for (const a of events) {
    out.write({ time: a.time, event: a.event, status: a.status, changes: a.changes, error: a.error });
  }
  return events.map((a) => ({ event: a.event, time: a.time }));
}
