// npm test
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { classify, retryingFetch } from "./retryFetch.js";

const realFetch = globalThis.fetch;
const API = "https://api.dev.cycle.io";

function netError(code?: string): TypeError {
  return new TypeError("fetch failed", code ? { cause: Object.assign(new Error(code), { code }) } : undefined);
}

/**
 * Fake fetch: fails the first `failures` calls with `fail` (an error to throw
 * or a status to return), then answers 200. Records each call's method.
 */
function fakeFetch(failures: number, fail: Error | number): { calls: string[] } {
  const state = { calls: [] as string[] };
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const req = input as Request;
    state.calls.push(req.method);
    if (state.calls.length <= failures) {
      if (typeof fail === "number") {
        return new Response("{}", { status: fail });
      }
      throw fail;
    }
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  return state;
}

const quiet = { firstDelayMs: 10, maxWaitMs: 2_000, log: () => {} };

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("classify", () => {
  it("sorts every call the scripts make", () => {
    assert.equal(classify("GET", "/v1/containers/x"), "read");
    assert.equal(classify("POST", "/v1/monitoring/logs/aggregate"), "read");
    assert.equal(classify("POST", "/v1/containers/abc/tasks"), "converge");
    assert.equal(classify("DELETE", "/v1/environments/abc"), "converge");
    assert.equal(classify("PATCH", "/v1/stacks/abc"), "converge");
    assert.equal(classify("POST", "/v1/stacks"), "create");
    assert.equal(classify("POST", "/v1/infrastructure/servers"), "create");
  });
});

describe("retryingFetch", () => {
  it("retries a read through a network outage", async () => {
    const f = fakeFetch(3, netError());
    const res = await retryingFetch(quiet)(new Request(`${API}/v1/containers/x`));
    assert.equal(res.status, 200);
    assert.equal(f.calls.length, 4);
  });

  it("retries a container task (start/stop/reconfigure) through an outage, body intact", async () => {
    const bodies: string[] = [];
    let n = 0;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      bodies.push(await (input as Request).text());
      n++;
      if (n <= 2) {
        throw netError("ECONNRESET");
      }
      return new Response("{}", { status: 202 });
    }) as typeof fetch;
    const res = await retryingFetch(quiet)(
      new Request(`${API}/v1/containers/abc/tasks`, { method: "POST", body: '{"action":"stop"}' }),
    );
    assert.equal(res.status, 202);
    assert.deepEqual(bodies, ['{"action":"stop"}', '{"action":"stop"}', '{"action":"stop"}']);
  });

  it("retries a delete on 503", async () => {
    const f = fakeFetch(2, 503);
    const res = await retryingFetch(quiet)(new Request(`${API}/v1/environments/abc`, { method: "DELETE" }));
    assert.equal(res.status, 200);
    assert.equal(f.calls.length, 3);
  });

  it("retries a create only when the request never reached Cycle", async () => {
    const refused = fakeFetch(2, netError("ECONNREFUSED"));
    const ok = await retryingFetch(quiet)(new Request(`${API}/v1/stacks`, { method: "POST", body: "{}" }));
    assert.equal(ok.status, 200);
    assert.equal(refused.calls.length, 3);

    const reset = fakeFetch(1, netError("ECONNRESET"));
    await assert.rejects(retryingFetch(quiet)(new Request(`${API}/v1/stacks`, { method: "POST", body: "{}" })));
    assert.equal(reset.calls.length, 1, "a create whose response may have been lost is not repeated");

    const gateway = fakeFetch(1, 502);
    const res = await retryingFetch(quiet)(new Request(`${API}/v1/stacks`, { method: "POST", body: "{}" }));
    assert.equal(res.status, 502, "a 502 on a create goes back to the caller to re-check");
    assert.equal(gateway.calls.length, 1);
  });

  it("gives up after maxWaitMs and surfaces the error", async () => {
    fakeFetch(1_000, netError());
    const started = Date.now();
    await assert.rejects(retryingFetch({ ...quiet, maxWaitMs: 300 })(new Request(`${API}/v1/containers/x`)));
    assert.ok(Date.now() - started < 1_000);
  });

  it("does not retry ordinary errors like 400/403/404", async () => {
    const f = fakeFetch(1, 403);
    const res = await retryingFetch(quiet)(new Request(`${API}/v1/containers/x`));
    assert.equal(res.status, 403);
    assert.equal(f.calls.length, 1);
  });
});
