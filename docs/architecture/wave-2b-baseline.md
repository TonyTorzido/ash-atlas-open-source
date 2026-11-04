# Wave 2B physical-extraction baseline

Captured on 2026-07-22 before production-code changes.

## Approved identity

| Item | Value |
| --- | --- |
| base | `test/t088` / `e3e7e66996f4855bbd6d792bf8369bad6716903a` |
| accepted Wave 2 tip | `1025660a2d2a736f0da119fb436ca794bcaff2bb` (ancestor of the base) |
| branch | `chore/physical-transport-extract--from-t088` |
| feature runtime | `physical-transport-extract-t088-1a0c1cf2ee` |
| `origin/master` / deployed game | `8229b7c56661751080904d9aefc6df8b8f60590e` |
| World pipeline | `8b8d1c1353cbae563b4c472cdc1d3b6e48ac792b` |
| World release | `world-packages-v1` / manifest `80bfe7152f2b4f16cc182cc38a86a72950634d5799fbb31b6bad4ef686bb5578` |
| Settlement Authority | `world-settlements-v2` / `462688b612b6929be93955f3e2976d19bd22d703fea24db1c5f4fa74e663ee26` |
| founding policy | `settlement-founding-v2` / `cbc6f31242142c2a04059ca39a29a8a4f84b752edd84dfd516830c11458255b1` |
| resolution policy | `primary-settlement-resolution-v1` / `6e422725266126827aab6c10cdd52ca0391c2aeb05243b076b9156ffadc6d371` |

The remote `test/t088` tag and `origin/integration/test` both resolved to the exact base SHA. There
were no commits after that checkpoint. The public release identity, the protected `master` ref, and
the VPS release symlink agreed. Direct production `/health` and `/ready` returned HTTP 200, the game
service was active, and the World health response matched every checked-in World and Settlement
Authority identity above. No protected branch, deployment, production process, retained database,
or World repository was changed.

The migration directory contains 114 files. Migration 0665 remains SHA-256
`efd21cda6ab83a8e6e3a97147258d83043e5bab5446550e18a52f9196fbe818d`; migration 0666 remains
`8f32c1748b023c17f0802564c92866b23703a1ea459a623cf7799fb26694da92`.

## Physical hosts

| Host | Lines | Bytes | Current responsibility |
| --- | ---: | ---: | --- |
| `apps/server/src/realtime/realtimeApplication.ts` | 9,097 | 370,288 | transport composition plus all 125 message bodies and most handler-local state/helpers |
| `apps/server/src/http/registerRoutes.ts` | 1,816 | 61,562 | admission composition plus 34 inline route bodies, schemas, auth adapters, and helpers |

The 13 files under `realtime/handlers/` contain typed registration seams only. The six files under
`http/routes/` expose family-scoped registration façades while schemas and handlers remain in
`registerRoutes.ts`.

## Realtime case ownership

Line numbers below refer to the immutable t088 base. Adjacent labels sharing a body are recorded at
their individual `case` lines.

| Family | Current switch/case locations | Final owner |
| --- | --- | --- |
| session | `HELLO` 2940; `REQUEST_WORLD_RESYNC` 7754; `PING` 7764 | `sessionHandler.ts` |
| world-gameplay | `MOVE_TO` 4716 | `worldGameplayHandler.ts` |
| flag | `PLACE_FLAG` 6151; `CANCEL_FLAG_BUILD` 6215; `REINFORCE_FLAG` 6222 | `flagHandler.ts` |
| travel | `VISIT_CITY` 6508; `VISIT_WORLD_MAP_CITY` 6509; `VISIT_FLAG` 6706; `VISIT_WORLD_MAP_KINGDOM` 6707 | `travelHandler.ts` |
| settlement | 6248 `PREVIEW_CITY_FOUNDING`; 6274 `FOUND_CITY`; 6334 `REQUEST_CITY_INFO`; 6353 `REQUEST_WORLD_MAP_DESTINATIONS`; 6363 `JOIN_CITY`; 6400 `LEAVE_CITY`; 6437/6438 mayor claim/relinquish; 6475 `CONVERT_CITY_FLAG` | `settlementHandler.ts` |
| party | 4878, 4897, 4914, 4948, 4972, 4990, 5008, 5035, 5057, 5072, 5178, 5188, 5240, 5535 (the 14 party/invite variants in router order) | `partyHandler.ts` |
| manor | 3977, 4033, 4111, 4185, 4194, 4204, 4228, 4252, 4264, 4286, 4449, 4464, 4481/4482 (the 14 manor variants) | `manorHandler.ts` |
| harvesting | 6891, 6915, 6939, 7010, 7139, 7170, 7224, 7285 | `harvestingHandler.ts` |
| combat-equipment | 4805, 4867, 5742, 5779, 5816, 5859, 5905-5907, 5970, 6040, 6082/6083, 7335, 7363, 7368, 7393, 7413 | `combatEquipmentHandler.ts` |
| social | `REQUEST_CHAT_BOOTSTRAP` 3554; `DM_*` 3952-3962; chat 4505, 4524, 4560, 4573; `REQUEST_KINGDOM_STATE` 4818; `KINGDOM_CHAT_SEND` 4835 | `socialHandler.ts` |
| market | 4592, 4608, 4619, 4636, 4654, 4670, 4685, 4696 | `marketHandler.ts` |
| pet | 3560, 3574, 3593, 3609, 3625, 3641, 3657, 3673, 3689, 3718, 3775, 3789, 3804, 3825, 3840, 3855, 3870, 3892 | `petHandler.ts` |
| developer | 5546, 5583, 5676, 7429, 7481, 7501, 7560 | `developerHandler.ts` |

The switch starts inside `dispatchValidatedMessage` at line 2939 and ends at line 7774. Its family
handlers all currently point back to that same function.

### Publication calls in family bodies

The counts are physical calls to `safeSendServerMessage`, `registry.send`, or
`registry.sendToConnection`; calls through named publication helpers are shown separately. They are
characterization data, not target quotas.

| Family | Direct calls | Named send-helper calls |
| --- | ---: | ---: |
| session | 22 | 27 |
| world-gameplay | 0 | 0 |
| flag | 2 | 3 |
| travel | 2 | 23 |
| settlement | 20 | 1 |
| party | 1 | 36 |
| manor | 11 | 23 |
| harvesting | 29 | 6 |
| combat-equipment | 11 | 19 |
| social | 5 | 12 |
| market | 8 | 8 |
| pet | 18 | 18 |
| developer | 10 | 24 |

All of these calls already pass through the Wave 2 publisher/policy engine, either directly or via
the registry. Extraction must preserve the exact primitive, payload, delivery override, ordering,
and await behavior at every call site.

## Mutable realtime state and shared helpers

| State at t088 | Current line | Intended owner |
| --- | ---: | --- |
| IP market limiter / market edge windows | 343, 9020 | market transport state |
| Kingdom chat gate | 348, 9041 | social handler state |
| class rate windows / active class mutations | 349-350 | combat-equipment mutation state |
| active party mutations / completed follow events | 351, 1195 | party mutation state |
| active/completed developer teleports | 352-353 | developer realtime state |
| player authority fence | 354 | shared authority port retained by composition |
| connection generations / close handlers | 355, 383 | `connectionLifecycle.ts` |
| Population relocation generations | 356 | relocation runtime state |
| pending manor entries / active manor jumps | 357-368 | manor realtime state |
| smooth travel transitions and watchdogs | 373-382 | travel runtime state |
| chat bootstrap ready set / flights | 384-385 | social bootstrap state |

Cross-family helpers currently retained in the compatibility host include connection/currentness
checks, authenticated actor resolution, travel blocking and arrival reservation, authoritative
relocation/Population adapters, world/bootstrap scope publication, city/manor/collectible/drop/combat
scope refresh, travel inbox publication, and the common typed error publishers. Family-specific
authorization, rate limiting, mutation fences, replay caches, and validation move with their family;
genuinely cross-family publication and relocation helpers become narrow ports.

## Required imports by family

| Family | Existing dependency groups used by its body |
| --- | --- |
| session | auth/player/session lifecycle, game state, registry/publisher, bootstrap coordinators, configuration/logger |
| world-gameplay | WorldRuntime command port, transition/currentness checks, movement validation/logger |
| flag | flags/builds, placement/Resource Vision, masteries, world state, publisher/logger |
| travel | flags/cities/World Map/Kingdom destination adapters, access/tolls, arrival reservations, relocation/Population ports |
| settlement | cities/Kingdoms/World Map, player/flag services, publisher/logger |
| party | party authority, travel invites, arrival/relocation ports, party fences, registry/publisher |
| manor | presence/runtime/storage, party/invite authorization, relocation and scope-publication ports |
| harvesting | collectibles/harvest/repeatable resources/drops/inventory/masteries, gameplay-scope publisher |
| combat-equipment | combat/profiles, progression/classes/equipment/kits/masteries, class mutation state, publisher |
| social | chat/DM/recent-player/Kingdom services, bootstrap state, registry/publisher |
| market | market service/actor resolver, edge limiter, registry/publisher/logger |
| pet | pet and expedition services, developer authorization adapter, direct publisher/logger |
| developer | developer authorization/economy, combat/world/mine/teleport adapters, replay state, relocation/scope ports |

## HTTP route ownership

| Family | t088 registration locations in `registerRoutes.ts` | Final owner |
| --- | --- | --- |
| system | 325 `/health`; 357 `/ready` | `routes/systemRoutes.ts` |
| world | 407 `/api/world/lookup` | `routes/worldRoutes.ts` |
| flags | 418 quote; 630 list; 650 environment; 664 territory; 918 create; 965 delete; 1052 rename | `routes/flagRoutes.ts` |
| players | 673 online; 681 inventory; 821 player; 859 color | `routes/playerRoutes.ts` |
| collectibles | 698 survey; 732 nearby; 762 pickup; 771 water | `routes/collectibleRoutes.ts` |
| diagnostics | 1120, 1130, 1142, 1157, 1163, 1169, 1175, 1181, 1198, 1217, 1234, 1258, 1297, 1315, 1327, 1363 | `routes/diagnosticRoutes.ts` |
| Population V2 | lines 87, 138, 220, and 302 of `populationZonesV2RolloutRoutes.ts` | unchanged focused owner |

`registerRoutes.ts` also owns all Zod schemas at lines 57-180, the family auth adapters, flag
refresh helper at 1446, actor/trace/error helpers at 1491-1537, developer authorization/audit at
1537-1592, bbox parsing at 1593, and readiness helpers at 1678-1815. Each moves only to the family
that uses it; common admission hooks and Population V2 registration remain composed once.

## Import graph, bundle, and accepted verification

The architecture scan found 400 files, 1,049 import edges, zero boundary findings, and the two
accepted shared-package cycles:

1. `packages/shared/src/classes.ts -> combat.ts -> progression.ts`
2. `packages/shared/src/equipment.ts -> equipmentBalance.ts`

The production server JavaScript bundle is 3,009,083 bytes. Its source map is 5,647,706 bytes in
this worktree (absolute source paths make map byte size path-dependent). The main client chunk and
CSS remain 2,655,110 and 354,125 bytes.

| Gate | t088 result before implementation |
| --- | --- |
| frozen install | passed |
| shared unit | 32 files / 270 passed |
| server unit | 195 files passed, 44 PostgreSQL-skipped / 1,621 passed, 321 skipped |
| client unit | 153 files / 963 passed |
| PostgreSQL | all 44 integration files passed on disposable PostGIS; no disposable database remained |
| typecheck / lint | passed / passed |
| architecture | 3 Node tests plus 10 Vitest tests passed; zero findings |
| policy | runtime 113, generation 13, admission 58, launcher 40 passed |
| build / verify / hygiene | passed / passed / passed |
| focused publisher + websocket | 40 passed |

The World-runtime-groups fixture refused deterministic port 41941 because the clean Integration
Test World already owned it. Ownership and exact t088 World identity were verified, and that
unrelated runtime was left untouched. The feature runtime registration is valid, but its first
startup also encountered exhausted Docker address pools before creating its owned network; no
unrelated Docker network was removed.
