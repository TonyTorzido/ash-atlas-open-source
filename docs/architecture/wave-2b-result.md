# Wave 2B result

## Identity and scope

| Item | Result |
| --- | --- |
| base | immutable `test/t088` / `e3e7e66996f4855bbd6d792bf8369bad6716903a` |
| branch | `chore/physical-transport-extract--from-t088` |
| feature runtime | `physical-transport-extract-t088-1a0c1cf2ee` |
| launcher | `Active/Run Physical Transport Extraction [t088].cmd` |

This wave was physical ownership only. It changed no client or shared protocol source, public
message/route contract, migration, dependency, World repository, retained database, production
state, protected branch, tag, release, or deployment.

## Structural result

- all 125 client messages retain exhaustive ownership across the 13 established family handlers;
- each handler owns its message bodies and receives focused state and operation ports;
- `realtimeApplication.ts` fell from 9,097 lines / 370,288 bytes to 1,424 lines / 46,840 bytes;
- `sessionHandler.ts` is an 85-line lifecycle handler; bootstrap work is separately focused;
- all 38 inventoried HTTP routes retain exhaustive policy ownership;
- `registerRoutes.ts` fell from 1,816 lines / 61,562 bytes to 185 lines / 5,865 bytes;
- route schemas, handlers, helpers, and family authorization adapters live in six physical route
  modules, while Population V2 remains in its existing focused module;
- compatibility exports in `websocket.ts` and `routes.ts` remain stable.

Focused state ownership lives in `classRealtimeState.ts`, `partyRealtimeState.ts`,
`manorRealtimeState.ts`, `travelRuntimeState.ts`, `socialRealtimeState.ts`, and
`developerRealtimeState.ts`. Shared family coordination is split by concern across Population,
travel, manor, combat/equipment, flag, snapshot, connection-world, and admission operation modules;
it was not moved into a replacement generic host.

HTTP ownership is system 2, world 1, flags 11, players 5, collectibles 5, diagnostics 10, and
Population V2 4. Developer endpoints follow their domain owner: flag operations are in flags,
teleport is in players, permanent mines are in collectibles, and diagnostics retains database,
realtime/gameplay trace, and spawn operations.

## Enforcement and verification

The architecture scan covers 418 files and 1,462 imports, reports zero boundary findings, and
retains only the two accepted shared-package cycles. It rejects client-message switches and known
family implementations in `realtimeApplication.ts`, plus Zod schemas and inline routes in
`registerRoutes.ts`.

| Gate | Final result |
| --- | --- |
| frozen install | passed |
| unit | shared 270; server 1,626 passed / 321 PostgreSQL-skipped; client 963 |
| PostgreSQL | all 44 integration files passed on canonical disposable PostGIS |
| focused realtime | router/state/manor/WebSocket: 65 passed |
| typecheck / lint | passed / passed |
| architecture | 4 Node checks plus 10 Vitest tests; zero findings |
| policy | runtime 113, generation 13, admission 58, launcher 40 passed |
| production build / verify / hygiene | passed / passed / passed |
| diff check | passed |

The first combined unit run put the unchanged 1,000-quantity Market UI stress case over its fixed
five-second timeout. Its complete 22-test file passed immediately in isolation, and the subsequent
full client run passed all 153 files / 963 tests without changing the timeout.

The World-runtime-groups fixture retained the baseline environmental refusal: the clean Integration
Test World owns deterministic t088 port 41941. The unrelated runtime was not stopped or changed.
The feature launcher could not start because Docker address pools are exhausted, so isolated
health/readiness/reconnect smoke was unavailable.

## Migration, cleanup, and build parity

All 114 accepted migrations remain byte-identical to `test/t088`. The canonical runner applied the
full chain, exercised populated and empty/repeat migration paths, passed all 44 PostgreSQL files,
and left no `ash_atlas_stability*` database. Migration 0665 remains SHA-256
`efd21cda6ab83a8e6e3a97147258d83043e5bab5446550e18a52f9196fbe818d`; 0666 remains
`8f32c1748b023c17f0802564c92866b23703a1ea459a623cf7799fb26694da92`.

The final production server bundle is 3,028,848 bytes. Client JavaScript and CSS remain exactly
2,655,110 and 354,125 bytes. No temporary PostgreSQL database or canonical-port proxy remained
after validation.
