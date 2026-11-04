# Wave 1 baseline (test/t086)

Captured on 2026-07-22 before production-code changes.

## Approved identity

| Item | Value |
| --- | --- |
| `origin/integration/test` | `e56814059c3d16446934e2f117d7a28c493c6655` |
| `origin/master` | `e56814059c3d16446934e2f117d7a28c493c6655` |
| deployed game release | `e56814059c3d16446934e2f117d7a28c493c6655` |
| immutable checkpoint | `test/t086` |
| deployed World pipeline | `8b8d1c1353cbae563b4c472cdc1d3b6e48ac792b` |
| settlement release | `world-settlements-v2` |
| settlement release fingerprint | `462688b612b6929be93955f3e2976d19bd22d703fea24db1c5f4fa74e663ee26` |
| founding policy | `settlement-founding-v2` |
| founding policy fingerprint | `cbc6f31242142c2a04059ca39a29a8a4f84b752edd84dfd516830c11458255b1` |
| resolution policy | `primary-settlement-resolution-v1` |
| resolution policy fingerprint | `6e422725266126827aab6c10cdd52ca0391c2aeb05243b076b9156ffadc6d371` |

The protected checkout was clean. There were no accepted commits after the recorded SHA. The
migration ledger contained 114 migrations through `0666_city_settlement_reconciliation.sql`.
The SHA-256 values of migrations 0665 and 0666 were respectively
`efd21cda6ab83a8e6e3a97147258d83043e5bab5446550e18a52f9196fbe818d` and
`8f32c1748b023c17f0802564c92866b23703a1ea459a623cf7799fb26694da92`.

## Verification baseline

| Gate | Result |
| --- | --- |
| shared tests | 32 files, 270 passed |
| server tests without PostgreSQL | 184 files passed, 43 skipped; 1,590 passed, 320 skipped |
| client tests | 153 files, 963 passed |
| all package typechecks | passed |
| ESLint | passed |
| repository hygiene | passed |
| production build and server syntax verification | passed |
| runtime-policy | 113 assertions passed |
| test-generation policy | 13 assertions passed |
| integration-admission policy | 58 assertions passed |
| launcher-lifecycle policy | 40 assertions passed |
| World runtime-group policy | 58 assertions passed |

The server bundle was 2,977,005 bytes (5,614,892-byte source map). The main client JavaScript
bundle was 2,655,110 bytes (754.18 kB gzip) and the main CSS bundle was 354,125 bytes
(61.20 kB gzip). Vite reported the existing main-chunk size warning.

Fresh migration from zero applied all 114 migrations. An immediate second run applied none. A
separate retained-database characterization upgraded through 0666 while retaining representative
records.

The broad PostgreSQL characterization used disposable PostGIS 16/3.4 databases. Thirty-eight of
41 canonical-port administrator and migration assertions passed. The three failures were stale
tests that expected a historical migration to be the last migration instead of accepting the
current 0666 ledger. The wider database-gated run also exposed pre-existing assertions for the
old 1,500 m active-runtime radius (the approved contract is 650 m), two pet-expedition cases, and
one concurrent water-cadence case. They are recorded as baseline defects and are not behaviorally
masked by this refactor.

## Characterization coverage

Existing server tests cover HELLO/WELCOME; initial bootstrap; player and combat snapshots/deltas;
Population V2 pending, terminal, and retryable terminal deltas; flag quote/build success,
completion, and rejection; flag, public-toll, private-denied, aggressive-lock, city, party, and
manor-exit travel; reconnect and connection replacement; immediate movement after travel; and the
current shutdown drains. Settlement tests cover the exact World authority identity, primary and
alias resolution, founding preview/success/rejection, reconciliation planning and repeatability,
append-only audit behavior, reversal authorization, retained snapshots, city travel, mismatch
rejection, fresh 0665/0666 application, retained upgrade, and an empty second migration run.

## Performance baseline

All times are milliseconds. These are characterization measurements, not pass/fail thresholds.

| Benchmark | Baseline |
| --- | --- |
| active runtime, 1k players | p50 0.538, p95 0.866 |
| active runtime, 10k players | p50 6.451, p95 10.672 |
| active runtime, 100k players | p50 119.043, p95 128.099 |
| persistence, 1k players | first pass 1,912.7; retry 15.1; 0 remaining |
| persistence, 10k players | first pass 19,384.6; retry 30.9; 0 remaining |
| Population V2 preparation, mid-latitude | warm 1.84; cold 4.22 |
| Population V2 preparation, boundary | warm 21.03; cold 31.10 |
| Population V2 preparation, four-way | warm 30.36; cold 45.10 |
| flag construction, cold quote | p50 195.37, p95 267.36 |
| flag construction, cold click-to-start | p50 1.78, p95 2.46, p99 8.98 |
| flag construction, warm quote | p50 0.012, p95 0.018 |
| flag construction, warm click-to-start | p50 1.81, p95 2.04, p99 8.94 |

The flag-prewarm benchmark did not sample because its historical Dublin coordinate no longer
resolved under the pinned t086 World authority. The failure is retained as baseline evidence.

## Initial architecture findings

- `apps/server/src/index.ts` owns construction, startup, timers, process handlers, and shutdown.
- `registerRoutes` and `registerRealtime` use long positional dependency lists and accept optional
  production authority. The route layer can construct a second Population V2 rollout controller.
- the Population V2 realtime adapter is assembled inline in the executable.
- a disabled Population V2 backend reports empty zones as ready when no game release SHA exists.
- `EnvironmentalPopulationService` remains in live HTTP/realtime signatures despite V2-only
  production composition.
- six top-level intervals have distributed ownership; asynchronous callbacks do not share an
  explicit overlap contract.
- PostgreSQL pool construction hardcodes only `max: 10` and exposes no acquisition/close metrics.
- `WorldCommandQueue.hasPendingMovementForPlayer` scans the queued suffix.
- the canonical World lock is imported by more than one authority consumer and settlement fields
  are interpreted outside a single typed contract boundary.
- the largest composition boundaries are `realtime/websocket.ts` (9,352 lines),
  `game/combat/combatEngine.ts` (7,099), client `App.tsx` (7,369), and the executable entry point.
