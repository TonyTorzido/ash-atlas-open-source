# Shared boss framework

Ash Atlas bosses are four cooperating concerns. `BossDefinition` is stable
identity (`id`, revision, combat archetype key, appearance, controller ID, and
reward policy). Combat stats remain in the mob definition catalog. A host owns
where an encounter lives and who may participate. A controller owns mechanics,
casts, targeting, phase transitions, and temporary movement ownership. A reward
policy composes the durable settlement inputs without becoming a universal loot
DSL.

```text
Trigger / Dungeon Encounter
        ↓
Boss Host
        ↓
Boss Encounter Instance
        ↓
Boss Controller
        ↓
CombatEngine
        ↓
Authoritative Cast / Resolution
        ↓
Defeat Candidate
        ↓
Encounter Owner
        ↓
Reward Adapter / Dungeon Progression
```

## Ownership and identity

Every boss combat projection carries `bossOwnership` with `bossId`,
`bossRevision`, `encounterHandlerId`, `hostKind`, `hostInstanceId`,
`encounterInstanceId`, appearance identity, and life generation. Defeat
candidates copy this value. Routing first uses the explicit handler and host;
`archetypeKey` is only combat/stat identity and is not a defeat-routing key.
The generation prevents a late cast or candidate from affecting a reset life.

`XoralEventService` remains the overworld event owner and keeps its harvest
roll, dormant start flow, locked roster, target/root behavior, and bespoke ring
settlement. The appearance variant is stored with the event identity (migration
0810) and is applied to every projection. On process restart an `active` Xoral
life is explicitly cancelled and despawned because combat health, target state,
and casts are not durable; it is never silently reconstructed at approximate
full health. Legendary birds use the same explicit ownership seam. A dungeon boss uses `hostKind = dungeon` plus the
instance/run/encounter identity, so another run can safely use the same mob
archetype. Legacy defeat candidates without ownership metadata are accepted
only by test-only service fixtures; production composition fails closed.
Metadata-bearing candidates never fall back to archetype routing.

## Host adapters

`OverworldBossHostAdapter` supplies an anchor/instance, an explicit handler,
and a participation policy. It can represent Xoral's locked roster or a future
open regional roster without changing a controller. `DungeonBossHostAdapter`
requires the exact instance, run, and room for every participant. Dungeon
`bossTemplateId` projections are marked with this ownership when a wave spawns;
the existing `DungeonRuntime` still owns room confinement, wipe/reset, doors,
and progression.

Hosts decide activation, abandonment, reset, and despawn. The shared lifecycle
supports `created`, `dormant`, `active`, `resetting`, `defeated`, `cancelled`,
and `despawned`; hosts do not have to use every state.

Dungeon Creator boss-library entries are references, not new boss definitions:
`dungeonBossTemplate` records retain the registered definition, controller,
appearance, and reward-policy IDs, while an encounter supplies only its room,
wave, placement, and host settings. DungeonRuntime resolves the definition from
`BossEncounterManager` before spawning and fails closed when the registered
package is unavailable. This lets a boss already exercised by an overworld host
be reused in a dungeon without copying controller code or bypassing reward
idempotency.

## Controllers and casts

`BossController` is a small imperative seam (`onActivate`, `update`,
`onDamage`, `onPhaseTransition`, `onReset`, `onDefeat`, and `destroy`). It uses
`BossEncounter.beginCast` and the targeting helpers rather than raw timers.
`BossEncounter` owns cast IDs, start/resolve timestamps, geometry, and life
generation. Active casts and replay IDs are bounded, and casts are resolved by
the server on `BossEncounterManager.tick`.
Reset, defeat, cancellation, phase transition, and despawn synchronously clear
active casts; stale generations cannot resolve.

Circle, cone, and line geometry live in `packages/shared/src/boss.ts`.
`isPointInsideBossGeometry` is the authoritative hit test and is also the
client's rendering contract. Bearings are clockwise from true north, matching
existing world geometry. Active casts are projected with authoritative
timestamps so reconnect can rebuild a still-valid telegraph without receiving
the original start event. No cast state is persisted for exact resume; the
explicit restart policy is clean-reset/cancel rather than an approximation of a
mid-cast fight.

## Rewards and contribution

`BossRewardPolicy` is intentionally small: fixed XP/Gold, optional common or
guaranteed drops, one rare chance, and an optional minimum contribution.
`eligibleBossRewardParticipants` consumes existing contribution tracking.
`IdempotentBossRewardAdapter` coalesces concurrent retries; durable settlement
continues to use the existing reward ledger/inbox or a host-specific adapter
such as Xoral's deterministic ring transaction. Dungeon progression remains a
DungeonRuntime concern.

## Adding a boss

1. Add one `BossDefinition` with a new revision and controller ID; reuse the
   existing mob archetype/stat definition.
2. Register a small imperative controller that selects host-provided eligible
   participants and begins only the needed shared geometry casts.
3. Create the appropriate overworld or dungeon host adapter from the trigger or
   encounter runtime; do not copy `XoralEventService`.
4. Attach the returned ownership to the CombatEngine mob projection and route
   the defeat candidate through the explicit owner.
5. Provide a reward adapter that preserves the existing idempotent settlement
   operation key, then add focused lifecycle/cast/host isolation tests.

Do not add a scripting DSL, behavior-tree hierarchy, universal spawn scheduler,
raid loot schema, or a private entry/exit pipeline. Movement-specific mechanics
may claim a generation-scoped `BossMovementOverride` when a real controller
needs it, and may later add adds/hazards/phases without changing ownership or
combat resolution.
