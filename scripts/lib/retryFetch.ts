// A fetch for the Cycle client that rides out brief API outages (s2 lost the
// API for a few minutes during a platform update and the run died on the
// first failed read).
//
// Only requests that change nothing are retried: GET/HEAD, and the log query
// (a POST that only reads). Writes are never retried blindly, because Cycle
// may already have acted on one whose response was lost.

const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);
const READ_ONLY_POSTS = [/\/v1\/monitoring\/logs\/aggregate$/];

export interface RetryOptions {
  /** Give up after this long in total. Default 5 minutes. */
  maxWaitMs?: number;
  log?: (message: string) => void;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function retryingFetch(options: RetryOptions = {}): typeof fetch {
  const maxWaitMs = options.maxWaitMs ?? 5 * 60_000;
  const log = options.log ?? ((m: string) => console.error(m));

  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request ? input : new Request(input, init);
    const path = new URL(request.url).pathname;
    const readOnly =
      request.method === "GET" || request.method === "HEAD" || (request.method === "POST" && READ_ONLY_POSTS.some((r) => r.test(path)));
    if (!readOnly) {
      return globalThis.fetch(request);
    }

    const deadline = Date.now() + maxWaitMs;
    let delay = 2_000;
    let attempt = 0;
    while (true) {
      attempt++;
      let problem: string;
      try {
        const response = await globalThis.fetch(request.clone());
        if (!RETRYABLE_STATUS.has(response.status)) {
          return response;
        }
        if (Date.now() + delay > deadline) {
          return response;
        }
        problem = `HTTP ${response.status}`;
      } catch (err) {
        if (Date.now() + delay > deadline) {
          throw err;
        }
        const cause = err instanceof Error && err.cause instanceof Error ? ` (${err.cause.message})` : "";
        problem = `${err instanceof Error ? err.message : String(err)}${cause}`;
      }
      log(`[api ${new Date().toISOString().slice(11, 19)}] ${request.method} ${path} failed: ${problem}; retry ${attempt + 1} in ${Math.round(delay / 1000)}s`);
      await sleep(delay);
      delay = Math.min(delay * 2, 30_000);
    }
  };
}
