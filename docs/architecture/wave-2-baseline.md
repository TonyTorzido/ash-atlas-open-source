# Wave 2 transport baseline

Captured on 2026-07-22 before any production-code change on
`chore/transport-decomposition--from-t087`.

## Protected identity

| Identity | Verified value |
| --- | --- |
| `origin/integration/test` | `8229b7c56661751080904d9aefc6df8b8f60590e` |
| `origin/master` | `8229b7c56661751080904d9aefc6df8b8f60590e` |
| public release and deployed host | `8229b7c56661751080904d9aefc6df8b8f60590e` |
| immutable checkpoint | `test/t087` (the only exact tag at the tip and the latest checkpoint) |
| accepted Wave 1 feature | `fecc920919cae1c681f603cda848b9b548512689` is an ancestor of the tip |
| World pipeline | `8b8d1c1353cbae563b4c472cdc1d3b6e48ac792b` |
| World release | `world-packages-v1` |
| Settlement Authority release | `world-settlements-v2` / `462688b612b6929be93955f3e2976d19bd22d703fea24db1c5f4fa74e663ee26` |
| founding policy | `settlement-founding-v2` / `cbc6f31242142c2a04059ca39a29a8a4f84b752edd84dfd516830c11458255b1` |
| resolution policy | `primary-settlement-resolution-v1` / `6e422725266126827aab6c10cdd52ca0391c2aeb05243b076b9156ffadc6d371` |

The public `/health`, public `/ready`, host-local probes, repository World lock, and live World
`/api/health` agreed on these identities. Production health and readiness returned 200. No
intervening accepted commit was present and no production write was performed.

## Schema and build inventory

- 114 migrations; latest `0666_city_settlement_reconciliation.sql`.
- Migration 0665 SHA-256:
  `efd21cda6ab83a8e6e3a97147258d83043e5bab5446550e18a52f9196fbe818d`.
- Migration 0666 SHA-256:
  `8f32c1748b023c17f0802564c92866b23703a1ea459a623cf7799fb26694da92`.
- `apps/server/src/realtime/websocket.ts`: 9,137 lines, 370,559 bytes.
- `apps/server/src/http/routes.ts`: 1,814 lines, 60,963 bytes.
- Production server bundle: 2,978,400 bytes; source map: 5,578,454 bytes.
- Production client main JavaScript: 2,655,110 bytes; CSS: 354,125 bytes.
- 418 test files: 32 shared, 233 server, 153 client. The PostgreSQL runner discovers 44 files.

## Import graph

The pre-change architecture scan covered 367 production files and 986 imports. It found three
cycles:

1. server Resource Vision job store/queue;
2. shared classes/combat/progression;
3. shared equipment/equipment-balance.

The registered Wave 1 exceptions were:

1. Population V2 operations importing an HTTP-owned operation type;
2. WorldRuntime importing a realtime connection-registry type;
3. the Population V2 preparation diagnostic directly constructing production components.

The server cycle and all three exceptions are Wave 2 scope. The two shared cycles remain Wave 3
scope.

## Full Wave 1 contract

| Gate | Pre-change result |
| --- | --- |
| frozen install | pass |
| unit tests | pass: shared 270; server 1,606 passed / 321 PostgreSQL-skipped; client 963 |
| PostgreSQL matrix | pass: all 44 runner files on canonical disposable PostGIS |
| typecheck | pass |
| lint | pass |
| architecture | pass: scan plus 2 Node suites and 2 Vitest files / 10 tests |
| policy | pass: runtime 113, generation 13, admission 58, launcher lifecycle 40 |
| production build / verification | pass / pass |
| repository hygiene | pass |
| `git diff --check` | pass |

The World-runtime-groups policy fixture could not acquire deterministic port 41941 while the clean,
compatible Integration Test launcher legitimately owned that port. Its isolated lease root did not
isolate the fixture's deterministic port selection. The process was identity-verified and left
untouched. This is a pre-existing test-environment collision, not an application failure. A first
PostgreSQL runner attempt on the feature-assigned port also exposed seven legacy files hard-coding
35439; the canonical disposable runner at 35439 then passed all 44 files. Neither condition was
hidden or bypassed.

## Raw socket characterization

The registered disposable runtime was
`transport-decomposition-t087-a1f52e323c` on frontend 41168, backend 41169, PostgreSQL 41170, and
the compatible shared World at 41941. Its `/health` and `/ready` returned 200 with the exact branch,
base SHA, database, World, market, reward-worker, Resource Vision, and Population V2 readiness
checks.

Observed network behavior:

- unauthenticated `/ws` upgrade: HTTP 401, without a WebSocket connection;
- authenticated socket: sends `HELLO` once and receives `WELCOME`;
- repeated `HELLO`: covered by the existing exact `HELLO_ALREADY_RECEIVED` test;
- `PING { clientTime: 12345.5 }`: `PONG` preserves `clientTime` and adds `serverTime`;
- replacement: the older connection closes with code 4002 and reason
  `newer gameplay connection opened`; the replacement becomes authoritative;
- graceful client close: code 1000 with no synthetic mutation acknowledgement;
- reconnect: existing state is preserved, new connection generation wins, and stale close cleanup
  cannot remove the replacement.

The first warm bootstrap observation emitted the following sequence. Scheduling can interleave
replicated frames before `WELCOME`; that is existing behavior and therefore part of parity:

```text
PLAYER_DELTA, WELCOME, CHAT_CHANNELS_SNAPSHOT, POPULATION_ZONE_DELTA,
CITIES_SNAPSHOT, CITY_MEMBERSHIP_SNAPSHOT, PLAYER_SNAPSHOT,
WORLD_MAP_DESTINATIONS, KINGDOM_STATE, PARTY_SNAPSHOT,
TRAVEL_INBOX_SNAPSHOT, PROGRESSION_SNAPSHOT, MASTERY_SNAPSHOT,
EQUIPMENT_SNAPSHOT, CLASS_SNAPSHOT, PET_STATE,
PET_EXPEDITION_DASHBOARD, COMBAT_SNAPSHOT, PLAYER_SNAPSHOT, FLAGS_SNAPSHOT
```

Ten reconnect samples confirmed the same required subsequence while allowing existing world/combat
tick interleaving. Independent bootstrap failures remain isolated by `runIndependentBootstrap`;
the exact `CHAT_UNAVAILABLE` behavior and continuation of unrelated bootstrap tasks are protected by
the existing WebSocket characterization tests.

## Bootstrap bytes and latency

One complete warm bootstrap plus PONG and early replication observed 27 frames. Selected serialized
sizes were:

| Frame | Bytes |
| --- | ---: |
| `WELCOME` | 535 |
| `CHAT_CHANNELS_SNAPSHOT` | 2,030 |
| `KINGDOM_STATE` | 1,840 |
| `EQUIPMENT_SNAPSHOT` | 10,962 |
| `CLASS_SNAPSHOT` | 2,756 |
| `COMBAT_SNAPSHOT` | 941 |
| `PLAYER_DELTA` | 562 |
| `PONG` | 63 |

The maximum observed frame was the 10,962-byte equipment snapshot. Ten loopback reconnect samples
produced connection-to-WELCOME p50 82.984 ms / p95 90.517 ms and reconnect-to-usable (WELCOME plus
player state plus flag state) p50 106.483 ms / p95 116.480 ms. A separate ten-run sample produced
open p50 3.463 ms / p95 6.302 ms and HELLO-to-WELCOME p50 84.191 ms / p95 97.145 ms.

At rest after characterization, the 20 Hz runtime reported tick callback interval p50 approximately
46.6 ms (mean; the bounded metric does not retain p50) and p95 62.49 ms, no catch-up steps or
dropped backlog, and event-loop delay p50 31.10 ms / p95 32.15 ms. Pool diagnostics reported 2,290
completed acquisitions, zero failures/timeouts, 0.074 ms average wait, and 11.322 ms maximum wait.
The bounded Wave 1 pool metric does not retain p50/p95, so average/max are the honest comparison
contract for this wave.

No seeded destinations existed in the fresh feature database, so runtime flag/city/party travel
latencies were not invented. Exact phase-one, terminal Population V2, immediate-move, ordering,
revision, request-ID, transaction, rollback, and 500 ms watchdog behavior is characterized by the
existing travel/flag/city/kingdom/party/manor/Population V2 suites enumerated below and will be
rerun before and after extraction.

## Behavior-preservation matrix

`realtime-message-map.md` records every client-frame family, current switch owner, delivery path,
and key acknowledgements. `relocation-path-map.md` records each destination-specific path and the
shared authoritative ordering. Together with the existing focused tests, they cover:

- lifecycle, authentication, HELLO/WELCOME, independent bootstrap failure, PING/PONG,
  replacement, reconnect, stale cleanup, and graceful close;
- movement acceptance/rejection and immediate movement after committed travel;
- combat start/cancel, ability activation, equipment, class, and progression;
- placement quote/request and flag build start/cancel/completion/visit;
- public/toll/private/aggression flag travel, city and World Map city travel, Kingdom Seat,
  party manual/auto-follow, invite, manor jump/exit, and developer relocation;
- cold/warm/terminal-empty/retryable Population V2 relocation;
- harvest, water, inventory, item drop/pickup, market, chat/local chat/DM, and pets.

For each family the existing tests assert the relevant emitted frames, request IDs, public error
code/text, transaction or authority fence, revisions, Population V2 trigger, and cleanup. The
extraction will preserve those tests and add boundary tests rather than replacing behavior coverage.

## Backpressure baseline

`ConnectionRegistry` serializes once per unique payload and applies four existing modes: critical,
replaceable, recoverable-social, and transient-social. Replaceable sends may skip a soft-buffered
recipient; critical sends close a hard-buffered slow recipient. Existing player/world and combat
deltas are replaceable where already declared. Mutation results and errors default to critical;
durable social frames are recoverable by cursor. The Wave 2 delivery table must encode, not
reinterpret, this effective behavior.
