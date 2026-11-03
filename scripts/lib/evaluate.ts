import type { Sample } from "./recorder.js";

export function durationMs(value: string): number {
  const units: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  const parts = [...value.matchAll(/(\d+)(ms|s|m|h|d)/g)];
  if (parts.length === 0) {
    throw new Error(`not a duration: "${value}"`);
  }
  return parts.reduce((total, [, n, unit]) => total + Number(n) * (units[unit ?? "s"] ?? 0), 0);
}

export function fmtMs(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 120) {
    return `${s}s`;
  }
  return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
}

export interface Check {
  name: string;
  expected: string;
  observed: string;
  pass: boolean | null; // null = could not be evaluated from the data
}

export interface Timing {
  loadStart: Date;
  loadEnd: Date;
  base: number;
  minTtl?: string;
}

const t = (s: Sample): number => new Date(s.at).getTime();
const burstServers = (s: Sample) => s.servers.filter((x) => x.role === "burst" && x.state !== "deleting" && x.state !== "deleted");

/** Grade a scenario's expectations against the recorded timeline. */
export function evaluate(expect: Record<string, unknown>, samples: Sample[], timing: Timing): Check[] {
  const checks: Check[] = [];
  const ok = samples.filter((s) => !s.errors?.some((e) => e.startsWith("instances")));
  const start = timing.loadStart.getTime();
  const end = timing.loadEnd.getTime();
  const peak = ok.reduce((max, s) => Math.max(max, s.app.count), 0);

  for (const [name, value] of Object.entries(expect)) {
    const expected = String(value);
    let observed = "no data";
    let pass: boolean | null = null;

    if (name === "scale_up_within") {
      const first = ok.find((s) => t(s) >= start && s.app.count > timing.base);
      if (first !== undefined) {
        const took = t(first) - start;
        observed = `${fmtMs(took)} (to ${first.app.count} instances)`;
        pass = took <= durationMs(expected);
      } else {
        observed = "never scaled up";
        pass = false;
      }
    } else if (name === "peak_at_most") {
      observed = String(peak);
      pass = peak <= Number(value);
    } else if (name === "peak_at_least") {
      observed = String(peak);
      pass = peak >= Number(value);
    } else if (name === "back_to_base_within") {
      const back = ok.find((s) => t(s) >= end && s.app.count === timing.base);
      if (back !== undefined) {
        const took = t(back) - end;
        observed = fmtMs(took);
        pass = took <= durationMs(expected);
      } else {
        observed = `still at ${ok[ok.length - 1]?.app.count ?? "?"} when recording stopped`;
        pass = false;
      }
    } else if (name === "respects_min_ttl") {
      const result = minTtlCheck(ok, timing.minTtl);
      observed = result.observed;
      pass = result.pass;
    } else if (name === "servers_added_at_least") {
      const most = ok.reduce((max, s) => Math.max(max, burstServers(s).length), 0);
      observed = String(most);
      pass = most >= Number(value);
    } else if (name === "servers_added_within") {
      const first = ok.find((s) => t(s) >= start && burstServers(s).length > 0);
      if (first !== undefined) {
        const took = t(first) - start;
        observed = fmtMs(took);
        pass = took <= durationMs(expected);
      } else {
        observed = "no burst server appeared";
        pass = false;
      }
    } else if (name === "instances_on_new_servers_at_least") {
      const most = ok.reduce((max, s) => {
        const burstIds = new Set(burstServers(s).map((x) => x.id));
        return Math.max(max, s.app.instances.filter((i) => burstIds.has(i.server_id)).length);
      }, 0);
      observed = String(most);
      pass = most >= Number(value);
    } else if (name === "servers_back_to_baseline_within") {
      const hadBurst = ok.some((s) => burstServers(s).length > 0);
      const back = ok.find((s) => t(s) >= start && burstServers(s).length === 0);
      if (!hadBurst) {
        observed = "no burst servers during the run";
      } else if (back !== undefined) {
        const took = t(back) - start;
        observed = fmtMs(took);
        pass = took <= durationMs(expected);
      } else {
        observed = "burst servers still present when recording stopped";
        pass = false;
      }
    } else if (name === "server_removal_order") {
      const result = removalOrder(ok);
      observed = result.observed;
      pass = result.pass === null ? null : result.pass === expected;
    }
    checks.push({ name, expected, observed, pass });
  }
  return checks;
}

/** An auto-scaled instance must not disappear before created + min_ttl. */
function minTtlCheck(samples: Sample[], minTtl: string | undefined): { observed: string; pass: boolean | null } {
  if (minTtl === undefined) {
    return { observed: "scenario has no min_ttl", pass: null };
  }
  const ttl = durationMs(minTtl);
  const initial = new Set(samples[0]?.app.instances.map((i) => i.id) ?? []);
  const violations: string[] = [];
  let removed = 0;
  for (let k = 1; k < samples.length; k++) {
    const prev = samples[k - 1];
    const cur = samples[k];
    if (prev === undefined || cur === undefined) {
      continue;
    }
    const now = new Set(cur.app.instances.map((i) => i.id));
    for (const inst of prev.app.instances) {
      if (now.has(inst.id) || initial.has(inst.id)) {
        continue;
      }
      removed++;
      // It was gone by cur.at at the latest; that's an upper bound on its lifetime.
      const lived = t(cur) - new Date(inst.created).getTime();
      if (lived < ttl) {
        violations.push(`${inst.id} gone within ${fmtMs(lived)}`);
      }
    }
  }
  if (removed === 0) {
    return { observed: "no auto-scaled instance was removed during recording", pass: null };
  }
  if (violations.length > 0) {
    return { observed: violations.join("; "), pass: false };
  }
  return { observed: `${removed} removed, all after at least ${minTtl}`, pass: true };
}

function removalOrder(samples: Sample[]): { observed: string; pass: string | null } {
  const created = new Map<string, number>();
  const removedAt = new Map<string, number>();
  for (const s of samples) {
    for (const x of s.servers.filter((v) => v.role === "burst")) {
      created.set(x.id, new Date(x.created ?? s.at).getTime());
      if ((x.state === "deleting" || x.state === "deleted") && !removedAt.has(x.id)) {
        removedAt.set(x.id, t(s));
      }
    }
  }
  for (const id of created.keys()) {
    const lastSeen = samples.findLastIndex((s) => s.servers.some((x) => x.id === id));
    const after = samples[lastSeen + 1];
    if (!removedAt.has(id) && after !== undefined) {
      removedAt.set(id, t(after));
    }
  }
  const ids = [...removedAt.keys()];
  if (ids.length < 2) {
    return { observed: `${ids.length} burst server(s) removed; need 2 to tell the order`, pass: null };
  }
  const byRemoval = [...ids].sort((a, b) => (removedAt.get(a) ?? 0) - (removedAt.get(b) ?? 0));
  const newestFirst = [...ids].sort((a, b) => (created.get(b) ?? 0) - (created.get(a) ?? 0));
  const oldestFirst = [...newestFirst].reverse();
  if (byRemoval.join() === newestFirst.join()) {
    return { observed: "newest removed first", pass: "lifo" };
  }
  if (byRemoval.join() === oldestFirst.join()) {
    return { observed: "oldest removed first", pass: "fifo" };
  }
  return { observed: "mixed order", pass: "mixed" };
}
