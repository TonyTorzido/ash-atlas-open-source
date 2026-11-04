# HTTP route ownership

`registerRoutes` remains the single hook and composition point. All 35 routes in this boundary have
one typed policy entry and one validated family registration; duplicate/missing policy entries fail
startup or tests. Existing focused route modules outside this inventory remain independently owned.

| Family | Count | Routes / responsibility |
| --- | ---: | --- |
| system | 2 | public `/health` and `/ready` |
| world | 1 | public World lookup with admission-owned cancellation signal |
| flags | 11 | placement quote, list/environment/territory, create/delete/rename, and flag developer operations |
| players | 5 | online list, inventory, player read, color mutation, and developer teleport |
| collectibles | 5 | survey, nearby, pickup, water collection, and permanent-mine development |
| diagnostics | 11 | authenticated database/realtime/gameplay trace, spawn, and developer-only Population V2 diagnostics |

Each policy records method, path, family, authentication class, admission class, developer-only
status, timeout owner, and disconnect owner. Admission values are derived from this registry rather
than a distant string map. The completeness test compares registered Fastify routes and policy keys
in both directions.

Common authentication/origin/CSRF hooks are still installed once. Public paths, methods, payloads,
status codes, error codes/text, and admission limits are unchanged.

## Cancellation ownership

`HttpAdmissionController` installs one request lifecycle signal. A queued request removed by client
abort cannot later receive a permit. Acquired permits release idempotently across response, abort,
and shutdown races. Queue depth excludes cancelled waiters, timers/listeners are cleaned up, and
shutdown cancels all queued requests.

Detailed metrics distinguish rate rejection, queue-capacity rejection, queue timeout, client
cancellation, shutdown cancellation, queue wait, and handler duration. The public health summary
retains only `accepted`, `rejected`, `active`, `queued`, `queueDepth`, `timedOut`, and `completed`.

The stable schemas, handlers, helper functions, and family-specific authorization adapters now
live in `http/routes/systemRoutes.ts`, `worldRoutes.ts`, `flagRoutes.ts`, `playerRoutes.ts`,
`collectibleRoutes.ts`, and `diagnosticRoutes.ts`. `registerRoutes.ts` contains only shared hook and
admission setup, dependency adaptation, route-family registration, and existing focused-route
composition. Population rollout, prepare, and cutover HTTP routes no longer exist; runtime
preparation is internal authority and its detailed snapshot is available only at
`GET /api/dev/diagnostics/population`. Architecture checks reject Zod schemas and inline route
bodies returning to `registerRoutes.ts`.
