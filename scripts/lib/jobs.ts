import { trackJob, type components } from "@cycleplatform/api-client-typescript";
import { cycle } from "./config.js";

type Job = components["schemas"]["Job"];

export class JobFailed extends Error {
  constructor(
    readonly what: string,
    readonly jobId: string,
    readonly state: string,
    readonly reason: string,
  ) {
    super(`${what}: job ${jobId} ended ${state}${reason ? `: ${reason}` : ""}`);
  }
}

export class JobTimeout extends Error {
  constructor(
    readonly what: string,
    readonly jobId: string,
    readonly waitedMs: number,
  ) {
    super(`${what}: job ${jobId} still running after ${Math.round(waitedMs / 1000)}s (Cycle keeps working on it; check it before retrying)`);
  }
}

/** The job ID inside a task/delete response, if Cycle created one. */
export function jobIdOf(body: unknown): string | undefined {
  const data = (body as { data?: { job?: { id?: string } } } | undefined)?.data;
  return data?.job?.id;
}

function isJob(value: unknown): value is Job {
  return typeof value === "object" && value !== null && "state" in value && "id" in value;
}

/**
 * Wait for a Cycle job to finish. Throws JobFailed when it errors or
 * expires, and JobTimeout when it outlives timeoutMs. A timeout does NOT
 * mean the job failed: callers must check the resource before retrying.
 */
export async function waitForJob(jobId: string, what: string, timeoutMs: number): Promise<Job> {
  const tracker = trackJob(cycle(), jobId, { pollingInterval: 3000 });
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new JobTimeout(what, jobId, timeoutMs)), timeoutMs);
  });
  try {
    const job = await Promise.race([tracker.promise, timeout]);
    if (job.state.current !== "completed") {
      throw new JobFailed(what, jobId, job.state.current, job.state.error?.message ?? "");
    }
    return job;
  } catch (err) {
    if (isJob(err)) {
      throw new JobFailed(what, jobId, err.state.current, err.state.error?.message ?? "");
    }
    throw err;
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
