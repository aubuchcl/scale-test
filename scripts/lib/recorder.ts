import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { idTime, listInstances } from "./containers.js";
import { labServers } from "./inventory.js";
import type { LabConfig } from "./lab.js";

export interface Sample {
  at: string;
  app: {
    count: number;
    instances: { id: string; server_id: string; state: string; created: string; autoscaled: boolean; min_ttl?: string }[];
  };
  servers: { id: string; hostname: string; role: string; state: string; created?: string }[];
  scaler?: { instances?: number; calls?: number; last_call?: unknown } | { error: string };
  errors?: string[];
}

/** Appends one JSON object per line to a file in the run's folder. */
export class Ndjson {
  constructor(readonly file: string) {
    mkdirSync(join(file, ".."), { recursive: true });
  }
  write(record: unknown): void {
    appendFileSync(this.file, JSON.stringify(record) + "\n");
  }
}

/**
 * Polls Cycle every intervalMs and appends a Sample to timeline.ndjson, so a
 * crash still leaves everything recorded up to that moment. A failed poll is
 * recorded as an error in the sample, never thrown.
 */
export class Recorder {
  readonly samples: Sample[] = [];
  private timer: NodeJS.Timeout | undefined;
  private busy = false;
  private readonly out: Ndjson;

  constructor(
    private readonly lab: LabConfig,
    private readonly appContainerId: string,
    runDir: string,
    private readonly watchScaler: boolean,
  ) {
    this.out = new Ndjson(join(runDir, "timeline.ndjson"));
  }

  start(intervalMs: number): void {
    void this.sample();
    this.timer = setInterval(() => void this.sample(), intervalMs);
  }

  stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
    }
  }

  latest(): Sample | undefined {
    return this.samples[this.samples.length - 1];
  }

  async sample(): Promise<Sample | undefined> {
    if (this.busy) {
      return undefined;
    }
    this.busy = true;
    const errors: string[] = [];
    const sample: Sample = { at: new Date().toISOString(), app: { count: 0, instances: [] }, servers: [] };
    try {
      const instances = await listInstances(this.appContainerId);
      sample.app.instances = instances.map((i) => ({
        id: i.id,
        server_id: i.server_id,
        state: i.state.current,
        created: idTime(i.id).toISOString(),
        autoscaled: Boolean(i.autoscale),
        min_ttl: i.autoscale?.min_ttl,
      }));
      sample.app.count = instances.filter((i) => i.state.current === "running" || i.state.current === "starting").length;
    } catch (err) {
      errors.push(`instances: ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
      const servers = await labServers(this.lab);
      sample.servers = servers.map(({ server, role }) => ({
        id: server.id,
        hostname: server.hostname,
        role,
        state: server.state.current,
        created: server.events.created,
      }));
    } catch (err) {
      errors.push(`servers: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (this.watchScaler) {
      try {
        const res = await fetch(`https://${this.lab.dns.scaler}/state`, { signal: AbortSignal.timeout(10_000) });
        const body = (await res.json()) as { instances?: number; calls?: number; last_call?: unknown };
        sample.scaler = { instances: body.instances, calls: body.calls, last_call: body.last_call };
      } catch (err) {
        sample.scaler = { error: err instanceof Error ? err.message : String(err) };
      }
    }
    if (errors.length > 0) {
      sample.errors = errors;
    }
    this.samples.push(sample);
    this.out.write(sample);
    this.busy = false;
    return sample;
  }
}
