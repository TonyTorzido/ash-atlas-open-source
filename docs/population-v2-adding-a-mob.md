# Adding a Population V2 mob

Population V2 discovers mobs from `populationV2MobRegistry.ts`. Add one validated registry
definition; do not add kind-specific planner, store, runtime, or protocol switches, and do not bump a
global population version.

## Registry definition

Add a `PopulationV2MobDefinition` to `POPULATION_V2_MOB_DEFINITIONS` with:

- `mobKind`: stable lowercase storage and wire identity (`[a-z][a-z0-9_]*`).
- `combatArchetype`: an existing server combat definition. Registry validation rejects unsupported
  archetypes and accidental shared ownership; set `allowSharedCombatArchetype` only when sharing is
  deliberate.
- `placementRevision`: the immutable revision for this placement algorithm.
- `generationPlacement`: use `registered_overlay` for an independently budgeted new mob. Use
  `encounter_table_v1` when the mob intentionally takes a weighted share of an existing surface
  encounter budget, and give it the matching `encounterSurface`. `legacy_frozen` exists only for
  older characterized placement paths.
- `spawnModel`, `candidateBuilder`, and optional `packFormation`: a single mob has one member with a
  null member index; a pack must always produce one allowed complete member set indexed from zero.
- `behaviorCategory`, `clientPresentational`, `diagnosticsLabel`, and `plannerPriority`: behavior,
  presentation, observability, and stable overlay ordering metadata.
- `density`, `eligibleAreaKm2`, and `isEligibleAnchor`: common density-per-area or rare target-area
  placement, the habitat area on which it applies, and the per-candidate habitat predicate. The
  area and anchor predicate must describe the same habitat (for example, wolf area and wolf-weight
  anchors).
- `spacingClass` and `suppressionClass`: placement separation and protected-area suppression policy.
- `defaultRolloutPolicy` and `existingGenerationRolloutEligible`: whether the mob waits for the next
  generation or may be explicitly topped up into a generation already being served.

Use `createSinglePopulationV2MobCandidateBuilder` or
`createPackPopulationV2MobCandidateBuilder` unless the formation genuinely needs a custom builder.
New mobs do not need `legacyIdentity`; that adapter exists only to keep pre-registry IDs exact.

The registry supplies the runtime projection kinds and combat-archetype bindings. A registered slot
must carry the definition's mob kind, combat archetype, spacing class, suppression class, and
placement revision. Runtime loading rejects a mismatched kind/archetype pair.

## Placement, spacing, and identity

Registered placement uses persisted habitat candidate anchors, deterministic density rounding, and
the symmetric matrix in `populationV2MobSpacing.ts`. Reuse an existing spacing class when its full
row expresses the intended relationship. If a new class is necessary, add its rule against every
class, including itself; matrix validation rejects missing or asymmetric rules. Packs are compared
by anchor where configured and by their closest bodies otherwise. A candidate is all-or-nothing:
spacing rejection or corrupt persisted membership must never leave a partial pack.

`placementRevision` is part of candidate, encounter, pack, slot, and entity identity together with
the generation ID, mob kind, deterministic anchor ID, and member index. Keep it unchanged while
those placement and formation semantics are unchanged. Change it only for an intentional new
placement life; never edit an old revision's meaning. Combat tuning or presentation changes alone
do not require a placement revision or a global version bump.

## Generation and rollout

Natural generation is the default path. `registered_overlay` mobs are planned after the frozen
baseline. `encounter_table_v1` mobs are selected from the shared deterministic per-surface budget
and table. Both are written with the generation's slots and canonical state in the same
transaction and recorded in `population_generation_mob_rollouts_v2` with `source='generation'`.

Do not bump the global materialization revision for an ordinary registry-only mob. If an
intentional encounter-table or materialization change genuinely requires a new revision, the
previous live revision must remain explicitly compatible and stale-but-servable until its
generations expire naturally. Add the previous revision to both the common-schema mapping and
`POPULATION_V2_COMPATIBLE_MATERIALIZATION_REVISIONS` before changing the current revision. Add a
focused regression proving the previous revision remains servable and a genuinely unknown future
revision remains guarded. Never rebuild or edit valid production population rows merely to roll
out a new mob or spawn-table balance.

Existing-generation top-up is optional maintenance, not generation serving:

- It is disabled by default. Enable `POPULATION_V2_MOB_ROLLOUT_ENABLED` and explicitly name kinds in
  `POPULATION_V2_MOB_ROLLOUT_KINDS`; the definition must also opt in.
- Admission happens only after player readiness and only for referenced, current, selected, active,
  unexpired generations. It never blocks activation or scans historical generations.
- The worker is bounded and single-job, prioritizes referenced zones, yields around work, and pauses
  for event-loop pressure, PostgreSQL waiters, or unhealthy host state.
- The store locks generation authority and inserts complete slot/state/projection groups plus the
  receipt in one transaction. Runtime refresh occurs only after actual inserted bodies.

Hollin Hut (`hollin_hut`, a `registered_overlay`) stands on any dry land (its biome only changes its
shop stock). It is placed in new generations automatically and in
already-served generations only through this top-up path. Enable it per environment with exactly
`POPULATION_V2_MOB_ROLLOUT_ENABLED=true` and `POPULATION_V2_MOB_ROLLOUT_KINDS=hollin_hut`; both stay
off in code. Natural generation and top-up space the hut against the same occupancy (own and
neighbouring-zone stones and slots within the maximum spacing distance).

The planner still rolls one hut per 15 km² of land; the rules that make huts rare live outside the
planner, in `HollinHutService.onPopulationBodySpawned`, when a spawned body is adopted as a
`hollin_huts` row. Adoption is refused (the body is sent away with `despawnPopulationManagedMob`)
inside claimed territory and within 30 km of any unexpired hut, population or developer; the 30 km
check and the insert run in one transaction under an advisory lock, so two cells adopting at once
cannot both win. An adopted hut stands 6-8 days (`expires_at`, deterministic per hut id), which
outlives its 48 h generation: when the slot is cleaned up the service takes over the body (life
+ 1, like a raid respawn) and a returning body with the same entity id is sent away rather than
doubled. A new generation rolls new entity ids, so its hut in the same cell is refused until the old
hut expires and is retired.

When a placement rule widens, bump `placementRevision` so a generation whose receipt already ran the
old rule is re-rolled by the top-up, and list the old revision in `compatiblePlacementRevisions` so
its existing slots stay servable (the hut went from `overlay-v1-hollin-hut-single-v1`, farmland only,
to `...-v2`, any land, this way). Only slots of the current revision count toward the target, so an
old slot stays and blocks a second hut by spacing rather than by count.

The receipt key is `(generation_id, mob_kind, rollout_revision)`. Terminal receipts make repeat
requests no-ops; retryable failures retain bounded attempt and next-retry state. A spacing shortfall
is recorded as `completed_with_shortfall`. A pre-existing partial or corrupt group is a
`terminal_diagnostic` and inserts nothing. Receipt absence never makes a generation unservable, so
legacy generations remain valid.

Use the rollout enable flag as the kill switch. Keep the queue and attempt limits bounded; do not
increase them to hide pressure or failures. Exhausted transient errors and partial groups require
diagnosis or a forward revision, not unbounded retry or piecemeal pack repair.

## Verification checklist

1. Add the shared `MobArchetypeKey` and its combat archetype with a positive target-basic-hit count,
   positive character XP anchor, stats, AI, and rewards. Every new mob receives Hunter XP by
   default; do not add it to the closed legacy/system exclusion list. For a new Creature Book
   species, add it to `CREATURE_BOOK_ROSTER` and add its normal artwork mapping in
   `apps/appearance-studio/src/mobArtworkSlots.ts`.
   No migration is needed: the server validates Creature Book keys against the shared roster
   (`pnpm mob:scaffold` writes all of this; see [adding-a-monster.md](adding-a-monster.md)). The
   definition's combat profile is applied unscaled by the authoritative spawn path.
2. Route defeat rewards through `CombatRewardSettlementService`. Event lifecycles that require the
   event transition and reward acceptance to be atomic must use `acceptInTransaction`. Xoral's
   retained bespoke boss economy is a closed exception, not precedent for a new reward pipeline.
3. Add the registry definition,
   density/formation metadata, and any complete spacing-matrix row.
4. Add the client art and presentation mapping for the new archetype.
5. Prove registry validation, deterministic identity, density, spacing, suppression, group
   integrity, shortfall, and idempotent replay in focused tests.
6. Extend the injected-registry lifecycle test pattern in
   `populationV2RegistryTestBoarLifecycle.test.ts`: projection, runtime binding, lease, spawn,
   deduplication, rebind, sleep/despawn, wake, dead exclusion, and cutover heartbeat must work
   without production kind switches.
7. Cover natural-generation manifest writes. If top-up is allowed, cover authority loss,
   transaction rollback, terminal receipt replay, bounded retry/exhaustion, pressure pause, kill
   switch, and refresh-only-on-insert behavior.
8. Run the focused registry, spacing, overlay, rollout service/store, generation-store, backend, and
   runtime tests; then run the affected server typecheck and `git diff --check`.
9. If the materialization revision changes, prove the immediately previous production revision is
   stale-but-servable and an unknown revision is guarded.
