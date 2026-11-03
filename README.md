# scale-test

A reproducible lab for testing [Cycle](https://cycle.io) container auto-scaling and infrastructure auto-scale groups, run against Cycle's dev platform (`https://api.dev.cycle.io`).

## Layout

```
app/              Go service, one image, two modes (MODE=app | scaler)
loadgen/          k6 load generator; runs the profile in SCENARIO, then exits
stacks/           Cycle stack files: target.json (app + scaler), loadgen.json
infra/            autoscale-group.json, the Create Auto-Scale Group request body
scenarios/        one JSON file per test (s0–s9)
scripts/          TypeScript tooling (Cycle's official API client)
lab.config.json   names, tags, DNS, server model; everything except secrets
results/          run records (git-ignored, see below)
```

## Requirements

- Node 20+
- `DEVAPI`: a Cycle API key for the dev hub
- `DEVHUBID`: the hub ID (`5a14ddd8b6393d0001976f44`, "compute dev")

The API URL is fixed to `https://api.dev.cycle.io` in `scripts/lib/config.ts`. The key never reaches a log or a record.

The key needs to manage servers, environments, stacks, containers, DNS records and auto-scale groups, and the `monitoring-logs-view` capability so runs can collect logs. Preflight can only check read access, so give the key all of these up front; otherwise a missing delete permission only shows up at teardown.

```sh
npm install
npm run validate    # checks stacks, scenarios and the group file against Cycle's API spec (no credentials needed)
npm test            # unit tests for the API retry rules and loadgen settings (no credentials needed)
npm run preflight   # read-only: credentials, hub, cluster, servers, group, environments, DNS
npm run status      # what's running in the lab and its estimated hourly cost
npm run apply -- s1-cpu            # dry run: shows a scenario's scaling change to the app; add --yes to apply
npm run scenario -- s1-cpu         # runs a scenario end to end and writes results/<run-id>/
npm run reset                      # dry run: lists leftover auto-scaled app instances; add --yes to remove them
npm run collect -- <run-id>        # re-pulls a past run's logs (needs monitoring-logs-view on the key)
npm run teardown -- --lab          # dry run: lists what it would delete
npm run teardown -- --lab --yes    # deletes environments, stacks, then servers
```

## How the lab is laid out on Cycle

| Thing | Name | Lifetime | Cost |
|---|---|---|---|
| Cluster | `autoscale-lab` | permanent | free |
| Auto-scale group | `asl-burst`: up to 2 × Vultr `vc2-1c-2gb`, New Jersey then Chicago; servers stay ≥15m, go after 10m idle, newest first | permanent | free while idle |
| Baseline server | Vultr `vc2-2c-4gb` in New Jersey, tag `asl-base`, overcommit off | per session | ~$0.03/hr |
| Burst servers | tag `asl-burst`, added by the group | while needed | ~$0.015/hr each |
| Environment | `asl-lab` on `autoscale-lab`: app + scaler | per session | |
| Environment | `asl-loadgen` on `development`: k6 | per session | |

The app is reached at `scale-test.cycle.chrisaubuchon.com` and the scaler at `scale-test-scaler.cycle.chrisaubuchon.com` (linked records in a hosted zone on the hub). Load comes in from outside through the app's public load balancer, so generating it doesn't use up the capacity being tested.

## The app

| Endpoint | Load it creates | Threshold it targets |
|---|---|---|
| `GET /burn?ms=100` | spins one core for `ms` | `cpu` |
| `GET /alloc?mb=16&hold=60s` | holds `mb` of resident memory for `hold` (capped by `MAX_ALLOC_MB`) | `ram` |
| `GET /hold?s=30` | keeps the connection open for `s` seconds | `network-connections` |
| `GET /bytes?kb=1024` | streams `kb` of incompressible data | `network-throughput` |
| any of the above | one request | `network-requests` |
| `GET /stats`, `GET /` | counters and identity | |

Every response carries `X-Instance-Id` and `X-Server-Id`, and the app logs a `stats` line every 10s. It listens on `[::]:80` because Cycle's private network is IPv6-only.

**Scaler mode** answers Cycle's custom-threshold webhook with `{"instances": N}` on `/` (any method; the docs disagree on GET vs POST, so it logs which arrives, plus the query and timing). `POST /set?n=5` with `Authorization: Bearer $SCALER_TOKEN` changes N; without a token configured, `/set` is disabled. `GET /state` shows the current answer and the last call. Deliver `SCALER_TOKEN` as a secret scoped variable, never in the stack file.

## Scenarios

| # | Tests | Load |
|---|---|---|
| s0 | Webhook (custom) threshold: the whole loop, GET vs POST, total vs additional | scaler answers 3, then 1 |
| s1 | CPU | `/burn` ramp |
| s2 | RAM | `/alloc` at 1 per 10s |
| s3 | Request count: a **total over the window**, minimum 10,000; is it per instance or across all? | 30 req/s (18,000 per 10m window) |
| s4 | Open connections | 150 held connections |
| s5 | Throughput on the private interface | ~80 Mbps of `/bytes` |
| s6 | `max` and `max_server` | heavy CPU with max 2 / max_server 2 |
| s7 | Minimum instance lifetime | short burst, then nothing |
| s8 | Server scale-up through `asl-burst` | large reserves + heavy CPU |
| s9 | Server scale-down (runs straight after s8) | none |

A scenario file holds the `scale` block to apply (the API's `ContainerScale` format), optional `resources`, the `load`, how long to keep watching afterwards, a hard `timeout`, and `expect`ations (`scale_up_within`, `peak_at_most`, `respects_min_ttl`, `back_to_base_within`, `servers_added_at_least`, …). `npm run validate` checks all of it.

## Runs, records and teardown

`npm run scenario -- <id>` applies the scenario's settings, waits for the app to be back to its base instance count, records every 15s, runs the load (loadgen profile, or scaler answers for s0), keeps watching for `observe_after_load`, then collects logs and Cycle's activity and grades the expectations. Exit code 0 PASS, 1 FAIL, 2 ERROR, 3 ABORTED (Ctrl-C). Lab setup is still done by hand with the MCP; `npm run teardown` removes it.

Each test's latest report is `results/reports/<test>.md` (with a `.json` summary next to it); an aggregate report across tests will be built from those. Each run writes to `results/<run-id>/` as it goes: `manifest.json`, `ledger.json` (every resource it created), `steps.ndjson` (every API call), `timeline.ndjson` (instances and servers every 15s), `events.ndjson`, `telemetry.ndjson`, app and k6 logs, `summary.json` and `report.md`. Records stay local and git-ignored.

- A scenario that passes or fails moves on to the next one after a reset; the session tears down at the end unless `--keep` is passed.
- On a harness ERROR, records are saved and everything stays up for debugging; tear it down yourself when done.
- `npm run teardown -- --run <run-id>` works from that run's ledger; `--lab` finds every `asl-` resource instead; `--all` also deletes the auto-scale group. Every teardown is a dry run unless `--yes` is passed.

## Spec questions the runs should settle

Found while building against the API spec at `2bd5dd1`:

- The portal docs list **Min** and **Delta** for container auto-scaling; the API's `ContainerScale` has only `max`, `max_server`, `min_ttl`.
- `max_server` is described as a *minimum* per server in the API and a hard *maximum* in the portal (s6 tells them apart).
- Request and connection thresholds are `requests` / `connections` in the API but `requests_total` / `connections_total` in the stack spec. Cycle's own error calls requests a total (see below).
- The stack spec's threshold `oneOf` leaves out `custom` (it's only in the discriminator mapping), so a stack file with a webhook threshold fails strict validation. The scenarios apply `scale` through the API instead.
- Stack-spec fields typed `oneOf: [string, StackVariable]` reject every `{{variable}}`, since a variable is also a string. `validate` fills variables in first, as Cycle does at build time.
- The webhook is documented as a GET (portal) and a POST (`WebhookURL` in the API spec).
- `ContainerScale`'s description reads "Network configuration for a container".
- The CPU threshold is measured against the CPU **limit**, so the app always has one set.

Found running the tests:

- **Cycle restarted a container whose restart policy is `never`.** In s1 the loadgen exited cleanly at 18:00:43 and Cycle started it again at 18:10:16 (`CYCLE_AUTO_START=yes`), re-running the load. The runner now stops the loadgen explicitly after each run and fails a `load_ran_once` check if it runs again.
- **The custom (webhook) threshold left the last auto-scaled instance behind** (s0), even when answering 0; CPU scaling (s1) removed it normally.
- **The RAM threshold follows container memory, not what the app thinks it holds.** In s2's first run the app's live allocations were 20–50 MB per instance, but Go kept freed memory, so container memory averaged ~131 MB (peak ~214 MB) against the 80M threshold and Cycle correctly kept adding instances (1 → 4). The app now returns freed memory to the OS straight away (`debug.FreeOSMemory`), so container memory tracks the load.
- **The request threshold is a total over the window, with a minimum of 10,000.** Cycle rejects anything lower ("total requests cannot be below 10000"); the docs give no unit or minimum. That matches the stack spec's `requests_total`. `validate` now checks it.
- **A Cycle update mid-run** (agent/compute `2026.11.02.4` → `2026.11.03.1`) made the API unreachable for a couple of minutes; workloads were not restarted. Every API call now waits and retries through outages of up to 5 minutes (2s, 4s, 8s… up to 30s apart): reads, container tasks and deletes always, creates only when the request clearly never reached Cycle, so nothing is duplicated. A delete that turns out to have already happened counts as done, and the runner's waits treat a failed check as "not yet". `npm test` covers the retry rules.
- **Instances added during a test got no traffic** (s1, s3). Cycle's load balancer keeps each client connection on one instance, and k6 reused a handful of keep-alive connections opened before the scale-up, so the base instance kept all the load; in s2, at one request per 10s, added instances did get requests. The loadgen now opens a new connection per request (`REUSE_CONNECTIONS=1` restores keep-alive), which spreads load the way many separate clients would.
- **Request-threshold scaling is slow both ways** (s3, 10m window, 30 req/s against 10,000): the instance was added 17 minutes after the load started (~10 minutes after the window's count first passed 10,000) and removed ~36 minutes after the load ended. CPU (s1, 5m window) took 3m19s up and 2m22s down.
- **A loadgen setting leaked from one scenario into the next** (a harness bug, not Cycle). The runner merged each scenario's settings into the loadgen's existing environment, so s3's first run inherited s2's `TIME_UNIT=10s` and sent 30 requests per 10s instead of per second: 4,725 in total, ~1,800 per 10m window against the 10,000 threshold, and Cycle correctly stayed at one instance. The runner now replaces every variable `loadgen/main.js` reads before each run (`npm test` checks the list against the script), and a `load_delivered` check compares k6's request count with what the scenario planned.

Found on the first real builds:

- Cycle rejects a restart `delay` under 5s, even with `condition: "never"`; the schema allows any duration. `validate` now checks for it.
- **Open: the stack file's `scaling` block didn't reach the container.** After deploying `asl-target-stack` (stack `6aea102e5f30be404d5e475d`, build `6aea11bf5f30be404d5e476d`, deployed through the Cycle MCP), the app's `config.scale` was `null`. Being investigated; the stack keeps its `scaling` block so it takes effect once this is resolved. Until then, `npm run apply` sets the same settings through the API.
- With TLS on a linked record, the load balancer redirects `http://` to `https://`, so an `http://` load test makes two round trips per request (found in the smoke test: k6 counted 2,956 requests, the app 1,477). The loadgen targets `https://`.
- `build_file` must start with `/` ("Build file must begin with a '/'"); the schema doesn't say. The first build used a relative `context_dir: "app"` with no `build_file` and failed inside buildkit with no detail. The stacks now build from the repo root with `build_file` `/app/Dockerfile` and `/loadgen/Dockerfile`, and `validate` checks both paths start with `/`.
