# Current application map

This is the navigation and ownership map for the dungeon-capable `test/t989` codebase and its
maintainability refactor. Historical wave reports describe their named checkpoints; their message
counts, branch status, and proposed follow-ups are not the current runtime contract.

## Workspace boundaries

| Area | Entry points and responsibility |
| --- | --- |
| Server composition | `apps/server/src/index.ts` owns process hooks; `application.ts` wires the pool, authorities, transports, workers, and shutdown |
| Client composition | `apps/client/src/App.tsx` composes features and views; `gameClient.ts` owns connection lifecycle and the command facade |
| Shared code | `packages/shared/src` contains contracts, catalogs, protocol schemas, and deterministic calculations; it cannot import applications |
| Player rendering | `packages/player-renderer/src` renders shared appearance data for the client and authoring previews |
| Appearance Studio | `apps/appearance-studio/src/App.tsx` composes authoring; `server.ts` and the existing bridge modules own workspace/server operations |
| Native host | `ios`, `capacitor.config.ts`, and client native adapters host the same application and authenticated transport |

## Server networking and authority

Realtime registration enters through the compatibility module `realtime/websocket.ts`, then
`registerRealtime.ts` and `realtimeApplication.ts`. `messageRouter.ts` assigns typed message families
to `realtime/handlers`; domain services own validation and mutations. The composition module wires
these owners without becoming another packet switch or raw sender.

- `connectionLifecycle.ts` and `bootstrapAttemptCoordinator.ts` coordinate authenticated bootstrap,
  replacement, cancellation, and cleanup. The connection generation ledger fences stale work.
- `connectionRegistry.ts` owns account/player/socket indexes and subscriptions. `realtimePublisher.ts`
  owns serialization and socket delivery; `deliveryPolicy.ts` classifies delivery semantics.
- `connectionMessageAdmission.ts` owns edge admission. HTTP routes use the existing admission and
  route-policy owners under `http`; authorization remains at those boundaries and domain services.
- `travelContracts.ts` is the neutral type owner shared by travel handlers and operations. Domain
  destination adapters retain access, toll, party, and persistence responsibilities.
- `marketRealtimeOperations.ts` publishes already committed market changes. Its subscriber access
  checks, asset notifications, and book updates retain their existing order; it does not own trades.
- `game/overworldBossEvents.ts` declares the narrow publication port used by boss domains. The
  connection registry satisfies it structurally; boss domains do not import realtime transport.

`WorldLookupClient` is the remote World port. `config/world-runtime.lock.json` pins the complete
pipeline/release identity. Shared in-flight lookups use one subscriber cleanup implementation:
individual cancellation releases its listener/count, and only the last departing subscriber aborts
unsettled upstream work. Gameplay-environment results retain their copy isolation; resource and
interactive results retain their existing shared references.

`game/worldRuntime.ts` owns authoritative tick/movement ordering. Population V2 has one production
composition and a separate explicit diagnostic composition. Domain workers and periodic tasks keep
their existing cadence; `runtime/lifecycleSupervisor.ts` and `runtime/shutdownDrain.ts` provide the
existing ownership and drain machinery. A timeout report must not be mistaken for completed work.

## Persistence and domain calculations

Composition owns the PostgreSQL pool. Auth, inventory, equipment, market, rewards, progression,
and other services retain their transaction, locking, idempotency, and error boundaries. Recorded
migrations and durable identities are immutable; general refactoring does not modify them.

`game/equipmentInventorySlot.ts` contains the identical carried-equipment slot query used by
equipment acquisition, ground pickup, and market delivery. Callers own locks and mutations. Its
inclusive candidate bound and missing-capacity result are deliberately preserved. Inventory, Manor,
and warehouse capacity policies differ and are not interchangeable with this query.

`game/combat/playerEquipmentCombatState.ts` owns snapshot conversion, normalization, and telemetry
projection of equipment combat state. `combatEngine.ts` owns combat execution and retains its
compatibility exports. Moving pure conversion does not change combat ticks or catalog values.

In shared code, `classContracts.ts` owns class, weapon, and technique contracts used by authored class
catalogs. `classes.ts` retains compatibility exports, including the same weapon-category array object.
Large authored catalogs remain together where splitting would add navigation cost without separating
an independent responsibility.

## Client commands, state, and rendering

`BrowserWebSocketTransport` is the sole raw WebSocket constructor/sender and fences socket generations.
`GameClient` owns reconnect policy and lifecycle telemetry. Domain command modules under
`client/domains` construct gameplay intents through the command port; command ownership and
equivalence tests protect payloads, request IDs, admission outcomes, and replay behavior.

Shared protocol modules own schemas and wire types. `protocol.ts` is an export-only compatibility
boundary, and the exhaustive server-message validation/parser maps remain authoritative. Client
frame routing assigns typed families to feature handlers instead of parsing frames inside UI code.

Feature state stays near the workflow it serves:

- `features/combatEquipment/equipmentSnapshotAcceptance.ts` owns revision reconciliation; UI retains
  compatibility access without being the source of domain acceptance rules.
- Flag snapshot authority and mutation journals stay in the flag frame handler; construction/result
  feedback is a synchronous extracted responsibility at the same dispatch position.
- Harvest authority remains in the harvesting feature. Inventory results and harvest-completion error
  handling have focused modules, preserving request gates, retry timing, and original return paths.
- Manor storage commands share the existing session and pending refs. Entry, exit, and movement remain
  with the universal location system.
- `features/settlements/useCityWarehouseFeature.ts` owns the open warehouse, request correlation, and
  warehouse commands/results. The parent retains the disconnect effect's relative execution position.

Map runtime owners compose input, subscriptions, rendering, and disposal. `map/animationFrameLoop.ts`
contains the existing RAF lifecycle and paint ordering; the Pixi overlay retains rendering and
compatibility exports. Feature extractions preserve callback dependencies and state ownership rather
than changing freshness or scheduling as an incidental cleanup.

## Enterable locations

Every building, room, floor, cave, dungeon, and shop uses the
[universal portal and location system](UNIVERSAL_PORTAL_AND_LOCATION_SYSTEM.md).
`PlayerLocationSnapshot` is canonical location authority. The portal registry, transition coordinator,
location service, client portal controller, and `LocationSceneHost` own transfer and scene selection.
Manor, Salon, Sewer, and catalog-defined dungeon adapters supply domain policy and content.

The [Build Bible](../build-bible/README.md) routes interaction and UI standards. Its canonical components
and styles are authoritative; Developer App → UI Standards is their downstream reference.

## Appearance Studio

`studioState.ts` owns player catalog/history transformations, including template and shared-anchor
edits. `recoveryDraft.ts` owns the existing browser draft key, validation, and storage behavior.
`studioApi.ts` owns request/session recovery and asset uploads; repeated binary conversion is shared
without changing upload payloads or async ordering. The UI, preview lifecycle, authoring contracts,
workspace verification, and publication workflow remain in their existing owners.

## Verification and operations

`tools/architecture/check-import-boundaries.mjs` checks import cycles and ownership boundaries. The
protocol guard checks re-export syntax, not a stale line budget. The WebSocket guard requires its
canonical owner and rejects competing owners; optional constructor protocols do not create a second
owner. Feature size checks remain in force.

Use proportional validation per change, and
[DEV_WORKTREES.md](../history/DEV_WORKTREES.md) for generations and runtime ownership. Authorized protected
integration/publication uses `tools/release/accept-and-publish-test-server.ps1`; recover uncertain
operations with its Inspect/Resume modes. Feature databases, logs, generated reports, and launchers
remain outside retained Main data and Git history.

Historical context: [Wave 2 result](wave-2-result.md), [Wave 3B result](wave-3b-result.md), and the
[historical refactor roadmap](refactor-roadmap.md). These are evidence for their original checkpoints,
not instructions to repeat already implemented work.
