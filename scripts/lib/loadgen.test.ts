// npm test
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { LOADGEN_KNOBS, loadgenEnv, plannedRequests } from "./loadgen.js";

describe("LOADGEN_KNOBS", () => {
  it("lists exactly the variables loadgen/main.js reads", () => {
    const source = readFileSync(new URL("../../loadgen/main.js", import.meta.url), "utf8");
    const read = new Set([...source.matchAll(/\b(?:str|num)\("([A-Z_]+)"/g)].map((m) => m[1]));
    assert.deepEqual([...read].sort(), [...LOADGEN_KNOBS].sort());
  });
});

describe("loadgenEnv", () => {
  it("drops knobs left by an earlier scenario and keeps everything else", () => {
    const leftFromS2 = { TARGET_URL: "https://old", SCENARIO: "ram", RATE: "1", TIME_UNIT: "10s", ALLOC_MB: "16", OTHER: "x" };
    const env = loadgenEnv(leftFromS2, { TARGET_URL: "https://app", SCENARIO: "requests", RATE: "30" });
    assert.deepEqual(env, { OTHER: "x", TARGET_URL: "https://app", SCENARIO: "requests", RATE: "30" });
  });
});

describe("plannedRequests", () => {
  it("integrates ramp, hold and ramp-down", () => {
    const s3 = { SCENARIO: "requests", RATE: "30", RAMP: "2m", HOLD: "25m", DOWN: "30s" };
    assert.equal(plannedRequests(s3), 47_250);
    // what s3's first run actually sent, with s2's TIME_UNIT=10s leaked in
    assert.equal(plannedRequests({ ...s3, TIME_UNIT: "10s" }), 4_725);
  });

  it("is undefined for non-arrival-rate profiles or without RATE", () => {
    assert.equal(plannedRequests({ SCENARIO: "connections", VUS: "150" }), undefined);
    assert.equal(plannedRequests({ SCENARIO: "requests" }), undefined);
  });
});
