// Checks every file the lab sends to Cycle against Cycle's published API spec,
// pinned to one commit so results are reproducible:
//   stacks/*.json            -> stack spec (after filling in {{variables}})
//   scenarios/*.json         -> our scenario format, with `scale` checked
//                               against the API's ContainerScale and
//                               `resources` against ContainerResources
//   infra/autoscale-group.json -> the Create Auto-Scale Group request body
//
// No credentials needed. Run: npm run validate

import $RefParser from "@apidevtools/json-schema-ref-parser";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadLab, readJson, renderStackVariables, repoPath } from "./lib/lab.js";

const API_SPEC_REPO = "https://github.com/cycleplatform/api-spec.git";
const API_SPEC_COMMIT = "2bd5dd178e07f5854ba3040d9de36511da36afe2";
const CACHE_DIR = repoPath(".cache/api-spec");

const KNOWN_EXPECTATIONS = new Set([
  "scale_up_within",
  "peak_at_most",
  "peak_at_least",
  "respects_min_ttl",
  "back_to_base_within",
  "servers_added_at_least",
  "servers_added_within",
  "instances_on_new_servers_at_least",
  "servers_back_to_baseline_within",
  "server_removal_order",
]);
const DURATION = /^(\d+(ns|us|µs|ms|s|m|h|d|w|y))+$/;

type Schema = Record<string, unknown>;

function ensureApiSpec(): void {
  if (!existsSync(join(CACHE_DIR, ".git"))) {
    console.log(`Fetching cycleplatform/api-spec @ ${API_SPEC_COMMIT.slice(0, 7)} into .cache/ ...`);
    execFileSync("git", ["clone", "--quiet", "--filter=blob:none", API_SPEC_REPO, CACHE_DIR], { stdio: "inherit" });
  }
  const head = execFileSync("git", ["-C", CACHE_DIR, "rev-parse", "HEAD"]).toString().trim();
  if (head !== API_SPEC_COMMIT) {
    execFileSync("git", ["-C", CACHE_DIR, "fetch", "--quiet", "origin", API_SPEC_COMMIT], { stdio: "inherit" });
    execFileSync("git", ["-C", CACHE_DIR, "checkout", "--quiet", API_SPEC_COMMIT], { stdio: "inherit" });
  }
}

async function schemaAt(file: string): Promise<Schema> {
  return (await $RefParser.dereference(join(CACHE_DIR, file), {
    dereference: { circular: "ignore" },
  })) as Schema;
}

function dig(obj: unknown, path: string[]): Schema {
  let current: unknown = obj;
  for (const key of path) {
    if (current === null || typeof current !== "object") {
      throw new Error(`schema path not found: ${path.join(".")}`);
    }
    current = (current as Record<string, unknown>)[key];
  }
  return current as Schema;
}

const ajv = new Ajv2020({ strict: false, allErrors: true, logger: false });
addFormats(ajv);

let failures = 0;

function check(label: string, schema: Schema, value: unknown): void {
  const validate = ajv.compile(schema);
  if (validate(value)) {
    console.log(`  ok    ${label}`);
    return;
  }
  failures++;
  console.log(`  FAIL  ${label}`);
  // oneOf/anyOf wrappers repeat the real problem; show the leaf errors.
  const leaves = (validate.errors ?? []).filter((e) => e.keyword !== "oneOf" && e.keyword !== "anyOf");
  for (const e of leaves.slice(0, 10)) {
    console.log(`        ${e.instancePath || "/"} ${e.message ?? ""} ${JSON.stringify(e.params)}`);
  }
}

function fail(label: string, message: string): void {
  failures++;
  console.log(`  FAIL  ${label}: ${message}`);
}

async function main(): Promise<void> {
  ensureApiSpec();
  const lab = loadLab();

  const stackSpec = await schemaAt("stackspec/schema/StackSpec.yml");
  const containerScale = await schemaAt("components/schemas/containers/config/ContainerScale.yml");
  const containerResources = await schemaAt("components/schemas/containers/config/ContainerResources.yml");
  const groupPaths = await schemaAt("platform/paths/infrastructure/auto-scale/groups/groups.yml");
  const createGroupBody = dig(groupPaths, ["post", "requestBody", "content", "application/json", "schema"]);

  console.log("Stacks");
  for (const stack of Object.values(lab.stacks)) {
    const raw = readFileSync(repoPath(stack.file), "utf8");
    const rendered = renderStackVariables(raw, stack.variables);
    const leftover = rendered.match(/\{\{\$?[a-z0-9-]+\}\}/g);
    if (leftover) {
      fail(stack.file, `no value in lab.config.json for ${leftover.join(", ")}`);
      continue;
    }
    check(stack.file, stackSpec, JSON.parse(rendered));
  }

  console.log("Auto-scale group");
  check(lab.autoscale_group.file, createGroupBody, readJson(lab.autoscale_group.file));

  console.log("Scenarios");
  const ids = new Set<string>();
  const files = readdirSync(repoPath("scenarios")).filter((f) => f.endsWith(".json")).sort();
  for (const file of files) {
    const label = `scenarios/${file}`;
    const s = readJson<Record<string, unknown>>(`scenarios/${file}`);
    ids.add(String(s.id));

    if (`${String(s.id)}.json` !== file) {
      fail(label, `id "${String(s.id)}" does not match the file name`);
    }
    if (s.scale !== undefined) {
      check(`${label} scale`, containerScale, s.scale);
    }
    if (s.resources !== undefined) {
      check(`${label} resources`, containerResources, s.resources);
    }

    const load = s.load as { type?: string } | undefined;
    if (!load || !["loadgen", "scaler", "none"].includes(String(load.type))) {
      fail(label, "load.type must be loadgen, scaler or none");
    }

    for (const key of ["timeout", "observe_after_load"]) {
      if (!DURATION.test(String(s[key]))) {
        fail(label, `${key} must be a duration like 15m`);
      }
    }

    const expect = (s.expect ?? {}) as Record<string, unknown>;
    for (const key of Object.keys(expect)) {
      if (!KNOWN_EXPECTATIONS.has(key)) {
        fail(label, `unknown expectation "${key}"`);
      }
    }
  }
  for (const file of files) {
    const s = readJson<Record<string, unknown>>(`scenarios/${file}`);
    if (s.requires !== undefined && !ids.has(String(s.requires))) {
      fail(`scenarios/${file}`, `requires unknown scenario "${String(s.requires)}"`);
    }
  }
  if (files.length > 0 && failures === 0) {
    console.log(`  ok    ${files.length} scenario files`);
  }

  console.log(failures === 0 ? "\nAll files valid." : `\n${failures} problem(s) found.`);
  if (failures > 0) {
    process.exit(1);
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
