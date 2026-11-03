// A fetch for the Cycle client that rides out brief API outages, such as a
// platform update (s2's first run died on a single failed read while the API
// was unreachable for about a minute).
//
// Every request waits and retries, but how far depends on what repeating it
// could do:
//
//   read       GET/HEAD and the log query (a POST that only reads).
//              Always safe to repeat.
//   converge   Container tasks (start/stop/restart/reconfigure/scale), PATCH,
//              DELETE. Repeating ends in the same state; a repeated DELETE
//              that already happened comes back 404, which callers treat as done.
//   create     Every other POST/PUT. Repeated only when the request clearly
//              never reached Cycle (connection refused, DNS failure, connect
//              timeout) or Cycle said it didn't process it (429/503).
//              Otherwise a lost response could create a duplicate, so the
//              error goes to the caller, which re-checks before trying again.

export type RequestKind = "read" | "converge" | "create";

const READ_ONLY_POSTS = [/\/v1\/monitoring\/logs\/aggregate$/];
const CONVERGENT_POSTS = [/\/v1\/containers\/[^/]+\/tasks$/];

/** Failures that mean the request never left this machine or never reached a server. */
const NOT_SENT_CODES = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
]);
/** Statuses that mean "try again later": nothing was done. */
const NOT_PROCESSED_STATUS = new Set([429, 503]);
/** Statuses worth retrying for requests that are safe to repeat. */
const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);

export function classify(method: string, path: string): RequestKind {
  const m = method.toUpperCase();
  if (m === "GET" || m === "HEAD") {
    return "read";
  }
  if (m === "POST" && READ_ONLY_POSTS.some((r) => r.test(path))) {
    return "read";
  }
  if (m === "DELETE" || m === "PATCH") {
    return "converge";
  }
  if (m === "POST" && CONVERGENT_POSTS.some((r) => r.test(path))) {
    return "converge";
  }
  return "create";
}

/** The low-level error code behind Node's generic "fetch failed". */
export function errorCode(err: unknown): string | undefined {
  const cause = (err as { cause?: unknown } | undefined)?.cause as
    | { code?: string; errors?: { code?: string }[] }
    | undefined;
  if (cause === undefined) {
    return undefined;
  }
  if (typeof cause.code === "string") {
    return cause.code;
  }
  return cause.errors?.find((e) => typeof e.code === "string")?.code;
}

function retryableError(kind: RequestKind, err: unknown): boolean {
  if (kind !== "create") {
    return true;
  }
  const code = errorCode(err);
  return code !== undefined && NOT_SENT_CODES.has(code);
}

function retryableStatus(kind: RequestKind, status: number): boolean {
  if (kind === "create") {
    return NOT_PROCESSED_STATUS.has(status);
  }
  return RETRYABLE_STATUS.has(status);
}

export interface RetryOptions {
  /** Keep retrying for up to this long in total. Default 5 minutes. */
  maxWaitMs?: number;
  /** First wait; doubles each time up to 30s. Default 2s. */
  firstDelayMs?: number;
  log?: (message: string) => void;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function retryingFetch(options: RetryOptions = {}): typeof fetch {
  const maxWaitMs = options.maxWaitMs ?? 5 * 60_000;
  const firstDelayMs = options.firstDelayMs ?? 2_000;
  const log = options.log ?? ((m: string) => console.error(m));

  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request ? input : new Request(input, init);
    const path = new URL(request.url).pathname;
    const kind = classify(request.method, path);
    const deadline = Date.now() + maxWaitMs;
    let delay = firstDelayMs;
    let attempt = 0;

    while (true) {
      attempt++;
      let problem: string;
      try {
        // Each attempt sends a fresh copy, since a request body can only be read once.
        const response = await globalThis.fetch(request.clone());
        if (!retryableStatus(kind, response.status) || Date.now() + delay > deadline) {
          return response;
        }
        problem = `HTTP ${response.status}`;
      } catch (err) {
        if (!retryableError(kind, err) || Date.now() + delay > deadline) {
          throw err;
        }
        const code = errorCode(err);
        problem = `${err instanceof Error ? err.message : String(err)}${code ? ` (${code})` : ""}`;
      }
      log(
        `[api ${new Date().toISOString().slice(11, 19)}] ${request.method} ${path} failed: ${problem}; ` +
          `retry ${attempt + 1} in ${Math.round(delay / 1000)}s`,
      );
      await sleep(delay);
      delay = Math.min(delay * 2, 30_000);
    }
  };
}
