# Wave 2 result

## Identity and scope

| Item | Result |
| --- | --- |
| base | `test/t087` / `8229b7c56661751080904d9aefc6df8b8f60590e` |
| branch | `chore/transport-decomposition--from-t087` |
| feature runtime | `transport-decomposition-t087-a1f52e323c` |
| World pipeline | `8b8d1c1353cbae563b4c472cdc1d3b6e48ac792b` |
| World lock SHA-256 | `710b2bdd591ad52df39efed5661ab5b4c728547bc233cac01a4951edd43d5b62` |
| Settlement release | `world-settlements-v2` / `462688b612b6929be93955f3e2976d19bd22d703fea24db1c5f4fa74e663ee26` |
| founding policy | `settlement-founding-v2` / `cbc6f31242142c2a04059ca39a29a8a4f84b752edd84dfd516830c11458255b1` |
| resolution policy | `primary-settlement-resolution-v1` / `6e422725266126827aab6c10cdd52ca0391c2aeb05243b076b9156ffadc6d371` |

No World repository, production database, retained state, public branch, tag, release, or deployment
was modified.

## Structural result

- `websocket.ts`: 9,137 -> 3 lines; it is a compatibility export/delegation entry.
- `routes.ts`: 1,814 -> 2 lines; it is a compatibility export entry.
- 125 client frames map exhaustively to 13 typed handler families.
- 134 server frames have explicit delivery policy and one publisher/metrics engine.
- 38 HTTP routes have exhaustive method/path/family/auth/admission/cancellation policy.
- one shared relocation coordinator owns committed transition/readiness/phase-two flow.
- all three Wave 1 exceptions are removed.
- Resource Vision server cycle is removed; two shared cycles remain unchanged.
- architecture scan: 400 files, 1,049 imports, 2 known cycles, 0 findings, 0 exceptions.

The compatibility implementation hosts retain the stable connection-local message bodies and
route bodies behind these new typed seams. This conservative choice minimizes authority and wire
risk; owner review may request a later pure file-movement pass if smaller physical modules are more
valuable than the churn.

Wave 2B completed that physical movement from `test/t088`. The compatibility hosts now contain
transport/admission composition only, while family modules own the message and route
implementations. See [wave-2b-result.md](wave-2b-result.md) for the final ownership and verification
record.

## Behavior and parity

The original realtime, travel, flag, city, Kingdom, party, manor, combat/equipment, social/DM,
market, pet, developer, Population V2, and HTTP tests continued to run against the compatibility
entry points. They preserve frame types/order, request IDs, errors, locks, revisions, transactions,
rollback, idempotency, the 500 ms watchdog, immediate movement, replacement fencing, and bootstrap
fault isolation. No shared protocol file, public route schema, gameplay value, migration, or client
source changed.

The required travel matrix is covered by the retained focused suites: flag success/replay/stale
toll/insufficient gold/private/custom/enemy/aggression/construction/harvesting; city/World Map/
Kingdom; party manual/Auto-Follow/invite; manor exit; developer relocation; persistence rollback;
stale/replacement connection; Population ready/stale/failed/watchdog; immediate movement;
reservation cleanup; duplicate request idempotency.

Randomized cancellation tests prove queued abort removal and permit consistency. A real aborted
socket test proves a disconnected waiter never acquires later. Route-policy tests prove exact
registration/policy completeness.

## Verification totals

| Gate | Final result |
| --- | --- |
| frozen install | pass |
| unit | pass: shared 270; server 1,621 passed / 321 PostgreSQL-skipped; client 963 |
| PostgreSQL | pass: all 44 integration files on canonical disposable PostGIS |
| typecheck / lint | pass / pass |
| architecture | pass: 3 Node checks and 10 Vitest architecture tests; scan 0 findings |
| policy | runtime 113; generation 13; admission 58; launcher 40 passed |
| build / verify / hygiene | pass / pass / pass |
| focused realtime publisher + websocket | 40 passed |
| diff check | pass |

The World-runtime-groups fixture could not claim deterministic port 41941 because the clean shared
Integration Test World legitimately owned it. Ownership was verified and the unrelated runtime was
left untouched. This is the same environmental fixture collision recorded at baseline, not an
application failure.

## Migration and protected data

Fresh database creation applied all 114 accepted migrations. Populated upgrade, migration-focused
tests, and an empty second run passed. The runner left no disposable test databases. Migration 0665
remains SHA-256 `efd21cda6ab83a8e6e3a97147258d83043e5bab5446550e18a52f9196fbe818d`;
0666 remains `8f32c1748b023c17f0802564c92866b23703a1ea459a623cf7799fb26694da92`.
No migration was added or edited. Retained city/reconciliation and canonical Population V2
preservation are covered by the populated PostgreSQL matrix; production received no write.

## Build and performance

| Metric | t087 baseline | Wave 2 | Result |
| --- | ---: | ---: | --- |
| server JS | 2,978,400 B | 3,009,083 B | +30,683 B (+1.03%), publisher/policy/router/metrics |
| server source map | 5,578,454 B | 5,643,684 B | +65,230 B |
| client JS | 2,655,110 B | 2,655,110 B | unchanged |
| client CSS | 354,125 B | 354,125 B | unchanged |
| HELLO -> WELCOME p50/p95 | 84.19 / 97.15 ms | 85.42 / 90.67 ms (30 warm samples) | within threshold |
| reconnect -> usable p50/p95 | 106.48 / 116.48 ms | 109.54 / 113.38 ms (30 samples) | within threshold |
| world tick p95 | 62.49 ms | 62.41 ms | unchanged/better |
| event-loop p95 | 32.15 ms | 32.08 ms | unchanged/better |
| pool average/max wait | 0.074 / 11.322 ms | 0.119 / 11.552 ms | approximately unchanged; zero failures/timeouts |

Runtime publisher diagnostics reported no duplicate/failure signal: zero skipped frames, zero
serialization/send failures, zero backpressure closures, and 10,962-byte maximum observed frame.
No extra client bundle, parse pass, serialization pass, World lookup, query, Population relocation,
persistence write, broadcast, or timer loop was introduced.

## Interactive runtime acceptance

The isolated runtime returned 200 from `/health` and `/ready`. Browser acceptance confirmed login,
HELLO/WELCOME, movement command admission, General/Trading/Hunting/Local publication, session
reload/reconnect, exact connection replacement recovery, and authority return through “Reconnect
Here.” The active and replaced tabs logged no browser warning/error. No stuck transition or
“Preparing surroundings” state appeared.

The broad domain matrix (DM, flag build/travel/toll, city/World Map/Kingdom, party/Auto-Follow,
manor, Population cold/warm/terminal, harvesting/water/drop/pickup, combat/equipment, market, pet,
developer teleport) was exercised through the complete focused automated contract using disposable
data. The exact runtime then shut down cleanly, restarted from the final committed tree, returned
healthy/ready, accepted a persisted-session reconnect through `WELCOME`, `PLAYER_SNAPSHOT`, and
`FLAGS_SNAPSHOT`, and shut down cleanly again.

## Future work

- Wave 3: protocol negotiation/runtime server-frame validation, `GameClient`/`App.tsx`/shared
  protocol decomposition, and the two shared-package cycles.
- Wave 4: measurement-led Resource/Water Vision simplification, Population V1 retirement policy,
  and measured statement-timeout classes.
