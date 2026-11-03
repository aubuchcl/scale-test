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

The key needs to manage servers, environments, stacks, containers, DNS records and auto-scale groups. Preflight can only check read access, so give the key all of these up front; otherwise a missing delete permission only shows up at teardown.

```sh
npm install
npm run validate    # checks stacks, scenarios and the group file against Cycle's API spec (no credentials needed)
npm run preflight   # read-only: credentials, hub, cluster, servers, group, environments, DNS
npm run status      # what's running in the lab and its estimated hourly cost
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
| s3 | Request count (units undocumented; the run tells us) | 20 req/s |
| s4 | Open connections | 150 held connections |
| s5 | Throughput on the private interface | ~80 Mbps of `/bytes` |
| s6 | `max` and `max_server` | heavy CPU with max 2 / max_server 2 |
| s7 | Minimum instance lifetime | short burst, then nothing |
| s8 | Server scale-up through `asl-burst` | large reserves + heavy CPU |
| s9 | Server scale-down (runs straight after s8) | none |

A scenario file holds the `scale` block to apply (the API's `ContainerScale` format), optional `resources`, the `load`, how long to keep watching afterwards, a hard `timeout`, and `expect`ations (`scale_up_within`, `peak_at_most`, `respects_min_ttl`, `back_to_base_within`, `servers_added_at_least`, …). `npm run validate` checks all of it.

## Runs, records and teardown

`npm run teardown` works today; setup, the scenario runner and the records below are being built.

Each run writes to `results/<run-id>/` as it goes: `manifest.json`, `ledger.json` (every resource it created), `steps.ndjson` (every API call), `timeline.ndjson` (instances and servers every 15s), `events.ndjson`, `telemetry.ndjson`, app and k6 logs, `summary.json` and `report.md`. Records stay local and git-ignored.

- A scenario that passes or fails moves on to the next one after a reset; the session tears down at the end unless `--keep` is passed.
- On a harness ERROR, records are saved and everything stays up for debugging; tear it down yourself when done.
- `npm run teardown -- --run <run-id>` works from that run's ledger; `--lab` finds every `asl-` resource instead; `--all` also deletes the auto-scale group. Every teardown is a dry run unless `--yes` is passed.

## Spec questions the runs should settle

Found while building against the API spec at `2bd5dd1`:

- The portal docs list **Min** and **Delta** for container auto-scaling; the API's `ContainerScale` has only `max`, `max_server`, `min_ttl`.
- `max_server` is described as a *minimum* per server in the API and a hard *maximum* in the portal (s6 tells them apart).
- Request and connection thresholds are `requests` / `connections` in the API but `requests_total` / `connections_total` in the stack spec.
- The stack spec's threshold `oneOf` leaves out `custom` (it's only in the discriminator mapping), so a stack file with a webhook threshold fails strict validation. The scenarios apply `scale` through the API instead.
- Stack-spec fields typed `oneOf: [string, StackVariable]` reject every `{{variable}}`, since a variable is also a string. `validate` fills variables in first, as Cycle does at build time.
- The webhook is documented as a GET (portal) and a POST (`WebhookURL` in the API spec).
- `ContainerScale`'s description reads "Network configuration for a container".
- The CPU threshold is measured against the CPU **limit**, so the app always has one set.

Found on the first real builds:

- Cycle rejects a restart `delay` under 5s, even with `condition: "never"`; the schema allows any duration. `validate` now checks for it.
- With `context_dir` set and no `build_file`, the image build failed in buildkit. The stacks now build from the repo root with an explicit `build_file` (`app/Dockerfile`, `loadgen/Dockerfile`), which reads the same whichever way Cycle resolves the path.
