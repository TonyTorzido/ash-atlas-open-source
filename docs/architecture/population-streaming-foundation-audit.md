# Population streaming foundation audit

Baseline: `origin/integration/test` at `e156ede4bbfa80a7fafc3248d4e859bc9284cf6c`
(`test/t293`).

This audit maps orchestration only. Population V2 equal-area geometry,
deterministic habitat and placement, selected-plan/cutover authority, generation
lifecycle, canonical entity state, runtime leases, CombatEngine authority, mob
registry, harvested-tree fencing, and permanent-resource authority remain the
canonical core.

## Current call graph

### World entry and reconnect

1. `sessionBootstrap` publishes `WELCOME` and completes ordinary bootstrap
   admission.
2. It starts an independent `population-relocation` bootstrap task.
3. `realtimeApplication.schedulePopulationV2Relocation` calls
   `createPopulationRealtimeOperations.schedulePopulationV2RelocationForActivePlayer`.
4. That function derives a `GameplayAreaContract` from the current authoritative
   player anchor, gameplay view, Resource Vision, and configured radii.
5. `PopulationRealtimeAdapter.relocate` calls
   `PopulationZonesV2Runtime.startRelocation`.
6. The runtime intersects the visible and prepared circles with Population V2
   zones, acquires one undifferentiated reference per zone, and starts visible
   priority 0 followed by prepared-radius priority 2 activation.
7. `PopulationZonesV2Backend.activateZones` schedules each zone through
   `PopulationV2ZoneActivationScheduler`, assesses or creates the generation,
   loads canonical descriptors, enforces invariants, acquires runtime leases,
   and installs CombatEngine actors for priority 0.
8. Runtime deltas flow through `PopulationRealtimeAdapter` to
   `POPULATION_ZONE_DELTA`, then `populationZoneProjection` applies fenced
   per-zone exact snapshots and tombstones.

World entry therefore becomes client-visible before exact Population V2
simulation readiness. Reconnect follows the same route with a different
trigger.

### Current anchored circle and recovery

The connection lease retains every prepared-radius zone until relocation or
disconnect. A client `REQUEST_POPULATION_RESYNC` first asks the runtime to
republish the current lease. If it is missing or retryable, the server schedules
another full relocation against the current authoritative anchor. Planner and
generation-lifecycle callbacks call `runtime.notifyZoneReady`, which performs a
fresh activation and publishes the resulting exact zone snapshot.

### Flag construction

1. `FlagBuildCoordinator.beginBuild` accepts the exact future flag center and
   starts `warmPopulation` during the construction timer.
2. `flagRealtimeOperations` maps that hook to `warmPopulationV2` with
   `waitUntilReady: true`.
3. `populationV2WarmStages` produces priority 0 visible zones and priority 2
   prepared zones.
4. `PopulationRealtimeAdapter.warmPopulation` waits on the planner and directly
   calls the backend for priority 0 with `activateRuntime: false`.
5. At successful transaction commit, `FlagBuildCoordinator` aborts the build
   controller with the reason that population work is detached.
6. Its `completed` hook starts a second `waitUntilReady: false` warm, then
   neighbor preload.

This is not a reservation. It has no stage references, adoption, or shared
publication authority.

### Flag, shrine, kingdom, city, party, manor, and administrative travel

`PREPARE_WORLD_MAP_TRAVEL` starts an exact destination warm, but the warm path
does not activate runtime actors. Ordinary flag travel instead calls
`PopulationNeighborPreparation.preload` before commit using the current
Resource Vision/anchor plus a selected destination hint. That helper calls the
backend directly from `application.ts`, outside the connection runtime.

After relocation is durably committed, travel updates spatial membership and
only then calls `schedulePopulationV2RelocationForActivePlayer` for the new
anchor. The authoritative relocation coordinator waits for this post-commit
visible activation before releasing the transition. City travel, party travel,
manor exit, developer relocation, and separate-space exit use variations of
the same post-commit scheduling route. Each caller owns its own timing and
interpretation of readiness.

### Sleep and rehydration

`PopulationZonesV2Runtime.releaseZone` starts a 60-second timer after the final
undifferentiated reference. `flushSleepRequests` asks the backend to release
runtime leases and despawn actors, then deletes runtime entity descriptors,
generation IDs, pending status, and materialization diagnostics. A revisit must
reload the durable generation.

An in-flight sleep serializes a reacquisition behind the sleep call. When the
sleep returns, the old completion invalidates ownership and deletes the cache
even if a new reference arrived; the queued activation repairs the zone later,
but the stale completion is still allowed to erase newly needed state.

### Client preparation semantics

Every required-visible `pending` delta starts the same 180 ms timer in
`usePopulationPreparationVisibility`. `PopulationPreparationNotice` always
labels it “Preparing the wilds” and renders a percentage calculated only from
ready-zone count. The protocol exposes pending/ready/failure but not why work is
pending, so valid durable rehydration is indistinguishable from generation
creation or replacement.

## Confirmed root causes

1. Construction warming is speculative work, not a typed streaming source.
2. Successful flag commit aborts that work and starts a second detached warm.
3. Priority 0 warm explicitly sets `activateRuntime: false`; “warm” is not
   simulation-ready.
4. Prepared-radius priority 2 prepares plans only; it is not durable-ready.
5. Travel destination work is split between exact non-simulation warming and a
   current-anchor neighbor heuristic.
6. Exact simulation activation begins after relocation commit for normal
   travel paths.
7. `PopulationZonesV2Runtime` uses one reference count for plan, durable cache,
   simulation, and publication.
8. The backend combines plan assessment, generation lifecycle, canonical load,
   invariant filtering, leases, and actor installation in one activation.
9. A cached descriptor has no complete selected-plan/generation/cutover/schema/
   registry/state authority fingerprint.
10. Sleep tears down both actor authority and durable descriptors, and an old
    sleep completion can invalidate a reacquired zone.
11. Direct backend callers in the warm and neighbor paths compete with runtime
    activation rather than joining one area/zone flight.
12. `Promise.all` at the runtime visible stage rejects the whole area on one
    expected zone outcome.
13. Publication fencing includes connection, relocation, Resource Vision,
    gameplay view, preparation generation, zone, and generation, but lacks a
    complete per-zone selected-plan/cutover/content authority token.
14. Unknown entity kinds are isolated by invariant filtering (and grouped
    packs are fenced), but common schema compatibility and per-kind manifests
    are not one general population-kind contract.
15. The UI has no typed preparation reason and treats zone-count completion as
    deterministic percentage progress.

## Existing diagnostics baseline

The runtime already exposes reference counts, cached zones/entities, pending
activations, in-flight sleeps, incomplete visible preparations, stranded
preparations, materialization status, and late-visible counts. The backend
exposes active actors by zone, duplicate activation prevention, actor rebinds,
generation creation, materialization fast paths, invariant suppression, and
preparation time by priority. The realtime adapter exposes frame counts,
serialized bytes, duplicate entity occurrences, and maximum frame size.

The foundation will retain these counters, map them to explicit stages and
sources, add bounded cache/scheduler/reservation metrics, and avoid warning
logs for normal successful operations.

## Related active work

`feature/population-mob-registry--from-t273` and all prior population
architecture branches are ancestors of `test/t293`. The clean unintegrated
`fix/permanent-mine-regen--from-t293` is a focused repair to repeatable-resource
and store authority. This branch does not copy or modify that worktree and will
preserve permanent stone identity and regeneration semantics. The old
`fix/population-world-sha--from-t073` is a one-line pipeline pin and is not an
architecture continuation.

## Red-before characterizations

The audit commit records expected failures for:

- a successful flag commit retaining, rather than aborting, its population
  reservation;
- priority 0 preparation installing runtime authority;
- actor sleep retaining a bounded durable descriptor snapshot.

Each expected failure is converted to a normal passing regression in the
implementation commit that owns the behavior.
