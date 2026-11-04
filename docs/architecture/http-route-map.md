# HTTP route map (Wave 2 baseline)

Captured at `test/t087` before route-family extraction. `registerRoutes` remains the required single
composition point.

This remains the historical pre-extraction map. Wave 2B completed physical ownership; see
[http-route-ownership.md](http-route-ownership.md) and [wave-2b-result.md](wave-2b-result.md).
The rollout module and its four operator routes were subsequently removed by the V2-only lifecycle
correction. Current population preparation is internal, and its detailed operational snapshot is
developer-authorized at `GET /api/dev/diagnostics/population`.

## Ownership at t087

| Current module | Routes/concern | Baseline note |
| --- | --- | --- |
| `routes.ts` (1,814 lines) | health/readiness, World lookup, flag quote/list/environment/create/delete/rename, territory, online players, inventory, collectibles/water, player/color, developer cleanup/refresh/teleport, database and gameplay-trace diagnostics | mixed schemas, handlers, admission map, and operational diagnostics |
| `populationZonesV2RolloutRoutes.ts` (historical) | rollout read/write, zone prepare/cutover | present at t087; removed from the current V2-only runtime |
| `flagAccessRoutes.ts` | flag access policy, passage requests, management/grants/groups/search | already focused |
| `kingdomRoutes.ts` | Kingdom state/founding/membership/identity/economy/construction/decoration | already focused |
| `profileRoutes.ts` | profile/social/recent-player HTTP reads and mutations | already focused |
| `combatTelemetryRoutes.ts` | authenticated combat telemetry | already focused |

## Routes still owned by `routes.ts` at t087

| Family | Methods and paths | Admission at t087 |
| --- | --- | --- |
| Probes | `GET /health`, `GET /ready` | none; public probe semantics |
| World | `GET /api/world/lookup` | expensive |
| Flag reads/quote | `POST /api/flags/placement-quote`, `GET /api/flags`, `GET /api/flags/:id/environment`, `GET /api/territory/resolve` | standard; expensive; expensive; expensive |
| Player/inventory | `GET /api/players/online`, `GET /api/inventory/:id`, `GET /api/players/:id`, `PATCH /api/players/:id/color` | standard; standard; standard; none |
| Collectibles | `POST /api/collectibles/survey`, `GET /api/collectibles/nearby`, `POST /api/collectibles/pickup`, `POST /api/collectibles/water/collect` | expensive; expensive; none; expensive |
| Flag mutations | `POST /api/flags`, `DELETE /api/flags/:id`, `PATCH /api/flags/:id` | expensive; none; none |
| Diagnostics | database and gameplay-latency trace GET/start/stop/delete/mark/events | none; existing auth checks remain handler-owned |
| Developer | flag counts/cleanup/environment refresh/diagnostics, permanent mines, spawn counts/cleanup, player teleport | none; existing capability checks remain handler-owned |

The twelve admission entries are currently a distant string-keyed map at the top of `routes.ts`.
The pre-handler silently ignores a route with no matching key, and no baseline test proves that
every policy references a registered route or that every intended admitted route has exactly one
policy.

## Authentication and hook ordering

Application composition installs common authentication/origin/CSRF behavior before route
registration. `registerRoutes` constructs one `HttpAdmissionController`, installs one pre-handler
and one response hook, then registers focused modules and inline routes. Route-family extraction
must not duplicate those common hooks.

`GET /api/world/lookup` already creates an `AbortController` from `request.raw`'s `aborted` event
and passes its signal to `WorldLookupClient`. Admission itself is not cancellation-aware: queued
waiters remain until timeout, can later receive a permit, and are released only by `onResponse`.
The Wave 2 cancellation change must make that request lifecycle the single authoritative signal
without adding a competing placement-quote timeout.

## Probe contract at t087

- `/health` is public and returns process/runtime identity plus the existing operational fields.
- `/ready` is public, bounded, and returns 200 only when database, World authority, runtime
  identity, market reconciliation, combat rewards, Resource Vision jobs, historical Population V2
  rollout, and Population V2 runtime authority are ready at t087. Current readiness has no rollout
  gate; it requires the V2 runtime authority.
- Wave 2 may move the implementations but may not change either path, response shape, access, or
  deployment meaning. A future `/live` split is documentation-only in this wave.
