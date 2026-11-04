# Equipment progression and combat-kit foundation

Status: implemented and verified on `feature/equipment-combat-kits--from-t040`.

Base: `test/t040` at `43152fbe7faaf99543db570907a4e8ffbf6555bd`.

This design keeps the existing 20 Hz authoritative `CombatEngine`, due-tick scheduler,
PvE enemy queue, alternating player/enemy phases, targets, movement, resources, abilities,
effects, and persistence supervisors. Equipment activation is an input to that engine, not a
replacement combat loop.

The committed balance report is generated from the production combat engine. The focused
acceptance matrix covers shared derivation and protocol contracts, server tick-boundary
activation, upgrade replay and concurrency, runtime reconnect/checkpoint behavior, client
reconciliation, and the forward migration on populated PostgreSQL with an empty second run.

## `test/t040` baseline audit

### Progression and health

- `packages/shared/src/progression.ts::playerPveStats` currently adds 20 maximum health,
  one attack, and one defense every five character levels. It also accepts fixed equipment
  attack and defense bonuses.
- `packages/shared/src/progression.ts::levelUpHealth` currently grants the positive
  maximum-health delta as healing.
- `packages/shared/src/classes.ts::applyClassCombatStats` currently multiplies maximum
  health for Warrior and retained future classes.
- `packages/shared/src/masteries.ts::warriorEffects` currently exposes a launch-facing
  maximum-health bonus at Warrior ranks 10 and 15.
- `packages/shared/src/classes.ts::WARRIOR_GUARANTEED_TRAITS` still describes five
  0-25 trait tracks, including maximum-health unlocks above the rank-15 launch cap.
- `apps/client/src/ui/WarriorClassPanel.tsx::MasterWarriorCard` and
  `WarriorProgression` still describe the rank-15 health bonus.
- `apps/server/src/realtime/websocket.ts` uses `levelUpHealth` during connection and world
  transitions and repeatedly rebuilds combat stats after progression, class, kingdom, or
  equipment changes.
- `db/migrations/0012_basic_combat.sql` permits retained player maximum health up to
  1,000,000, so a forward migration must normalize ordinary players without resetting their
  health state.

Launch decision: ordinary players use `BASE_PLAYER_MAX_HEALTH = 100`. Character level,
Warrior rank, ordinary equipment, inventory size, and kit count do not modify it. The former
launch Warrior health bonus is inactive and represented as a small mitigation improvement in
the rank-15 description and runtime. Retained future-class health metadata remains
deserializable but is not applied by the ordinary launch resolver.

### Equipment and inventory

- `packages/shared/src/equipment.ts` defines only `weapon` and `chest`, places fixed final
  attack/defense bonuses on definitions, and has no durable item level.
- `db/migrations/0015_combat_reward_settlement.sql` constrains active slots to `weapon` or
  `chest`, stores active equipment directly on `equipment_instances`, and has no saved-kit or
  upgrade-operation tables.
- `apps/server/src/game/equipment.ts::ensureStarterLoadout` creates four ordinary items
  without an item level, equips Sword and Tunic, and treats equip/unequip as the
  only active-loadout operations.
- `apps/server/src/game/equipment.ts::equipmentSnapshot` derives fixed totals directly from
  definitions and exposes only `weapon` and `chest`.
- `packages/shared/src/classes.ts::applyClassCombatStats`,
  `apps/server/src/game/classes/classService.ts::validateClassEquipment`,
  `apps/server/src/game/combat/combatEngine.ts::updatePlayerClassState`,
  `apps/server/src/game/combat/combatSimulation.ts`, and progression refresh helpers in
  `apps/server/src/index.ts` and `apps/server/src/realtime/websocket.ts` all consume the
  two-slot snapshot.
- `apps/client/src/ui/InventoryPanel.tsx`, `apps/client/src/App.tsx`, and
  `apps/client/src/perf/progressionRecorder.ts` expose the two-slot model to the launch UI.

Launch decision: active equipment has seven slots: `head`, `chest`, `gloves`, `boots`,
`ring`, `melee`, and `secondary`. `secondary` accepts a ranged weapon or shield. Saved-kit
references never change an instance's active location. Final attack and defense values are
derived from definition, category, level, class affinity, balance version, context, and
ruleset; they are never persisted as item truth.

### Warrior reachability

- Warrior rank is already capped at 15 in `packages/shared/src/masteries.ts` and migration
  `0634_launch_progression_rework.sql`.
- The four launch active abilities unlock at ranks 1, 3, 5, and 7 and are reachable.
- Launch class selection is already narrowed to Warrior and subclasses are hidden.
- Retained tier-20 passives, subclass data, and future-class 0-25 definitions remain in the
  historical catalog and combat compatibility path.
- The contradiction is launch-facing trait copy and threshold arrays that still advertise
  ranks 16-25, not the four active abilities.

Launch decision: keep the four active abilities at their current ranks, keep historical
future data deserializable, remove health scaling from launch behavior, and compress every
launch-facing Warrior automatic-trait milestone to ranks 0-15. Tier-20 and subclass records
remain inactive historical compatibility data.

### PvP and PvE damage

- `apps/server/src/game/combat/combatEngine.ts::resolveBasicAttack` calls
  `standardizedPvpDamage` for player-versus-player basics, ignoring attacker equipment,
  character level, class rank, and defender gear.
- `CombatEngine::resolveAbility` instead multiplies `attacker.attackDamage` and sends the
  result through the general defense path, so PvP abilities and PvP basics use different
  power rules.
- `CombatEngine::applyDamage` is the common final mitigation, status-effect, telemetry, and
  health mutation path and should remain intact.
- `packages/shared/src/progression.ts::damageFromStats` is the current shared PvE
  attack/defense curve.
- `apps/server/src/game/combat/combatSimulation.ts` already drives the production engine and
  is the correct precedent for deterministic balance reporting.

Launch decision: one versioned derived-stat resolver supplies PvE attack/defense and PvP
Offense/Guard. Both basic attacks and active/reset abilities obtain their context-specific
base damage from it, then retain the existing ability multipliers, effects, and final
`applyDamage` path. A future PvE weapon-proficiency multiplier is explicitly `1` outside PvE.

### Equipment persistence versus loadouts

- `equipment_instances.location = 'equipped'` currently means both "owned" and "selected in
  the only loadout"; there is no distinct saved reference.
- Class loadouts in `player_class_loadouts` store abilities, not equipment.
- There is no runtime equipment cache, inventory revision, staged activation, coalesced active
  checkpoint, or reconnect restore for combat kits.

Launch decision: ownership remains on equipment instances, active equipment remains one
complete runtime loadout, and saved kits contain only durable instance references. These
states have separate revisions and transaction boundaries.

### Protocol, UI, and telemetry

- `packages/shared/src/protocol.ts` has two-slot equipment schemas and only
  `EQUIP_ITEM`/`UNEQUIP_ITEM` mutations.
- `apps/client/src/gameClient.ts` and `apps/client/src/App.tsx` have no equipment-upgrade or
  combat-kit request lifecycle.
- `apps/client/src/ui/InventoryPanel.tsx` shows fixed bonuses, no item level, and a note that
  PvP is neutral.
- `apps/server/src/game/combat/combatTelemetry.ts` records class/loadout combat data but no
  gear levels, derived Offense/Guard, or kit activation timing.

Launch decision: equipment snapshot version 2 is server-authored and includes level 0,
affinity, upgrade price, seven active slots, six kit summaries, revisions, and derived stats.
The combat-kit hotbar uses six server-confirmed actions and Shift+1 through Shift+6 so it does
not collide with existing ability keys.

## Version-one equipment model

Equipment categories are definition-owned:

- `melee_weapon`
- `ranged_weapon`
- `shield`
- `head_armor`
- `chest_armor`
- `gloves`
- `boots`
- `ring`

The category-to-slot registry is authoritative. Individual item IDs are not branched on in
combat code.

Every equipment instance stores:

- instance, definition, and owner identity;
- active location and active slot;
- `item_level` in the inclusive range 0-25;
- the balance version used for upgrade audit provenance;
- optional null enchantment/material identity for future use;
- creation and update provenance.

Level 0 is a first-class value. It is owned, equippable, savable, activatable, and useful. It
is never interpreted through a truthy fallback. Empty and level 0 are distinct:

```text
empty slot     -> no item access, no affinity, numerical level contribution 0
level-0 item   -> definition utility/access, explicit minimum PvE contribution,
                  numerical item level 0 before affinity
```

Ordinary creation defaults to level 0. A future higher-level grant must identify an explicit
server-owned reward-policy version; no such policy is introduced here.

## Database schema

Migration `0651_equipment_progression_combat_kits.sql` is forward-only and rerunnable:

- broadens active equipment slot checks to the seven launch slots;
- migrates equipped Sword from `weapon` to `melee`;
- keeps equipped Tunic in `chest`;
- moves a compatible equipped Bow or Staff to `secondary`;
- leaves conflicts and incompatible instances in inventory;
- adds `item_level`, `balance_version`, and nullable enchantment identity;
- creates one `player_equipment_state` row per player;
- creates exactly six `combat_kits` rows per player;
- creates normalized `combat_kit_items` references;
- creates replay-safe `combat_kit_operations`;
- creates durable `equipment_upgrade_operations`;
- creates bounded, queryable `equipment_audit_events`;
- normalizes retained ordinary combat health to the 100-HP baseline by percentage.

No instance is deleted. The unique active-slot index is retained. Kit items use a per-kit
unique instance constraint, while the same instance may be referenced by different kits.

## Ownership, active state, and saved references

```text
equipment_instances
  owns item identity, level, destroyed state, and the last checkpointed active slot

combat_kits + combat_kit_items
  own six named reference sets; references do not equip or duplicate an item

authoritative equipment runtime
  owns the connected player's current active loadout, readied weapon, inventory revision,
  staged activation, and monotonic checkpoint revision
```

An activation is valid only when every referenced instance is still owned, not destroyed,
category-compatible, unique inside the kit, and present in every required slot.

## Runtime and tick-boundary activation

Connection loads owned instances, six kits, active state, and revisions into one bounded
server runtime snapshot. Disconnect and graceful shutdown flush a dirty active checkpoint and
release the snapshot.

The exact activation order is:

1. Parse a stable request ID and expected inventory revision.
2. Validate the complete kit against the connected server runtime snapshot.
3. Reserve the activation intent in `combat_kit_operations` outside combat resolution.
4. Stage one immutable complete loadout with its request ID.
5. At `CombatEngine.beginTick`, after incrementing the authoritative tick and before class,
   AI, chase, queue, phase, or scheduled-attack work, atomically replace equipment-derived
   state.
6. Resolve all work due for that tick using the newly active state.
7. Emit server confirmation containing the activation tick.
8. Outside combat resolution, coalesce the latest active loadout and transactionally persist
   it while completing every applied activation row accumulated since the prior checkpoint.

If resolution for a tick has already started, staging occurs after that boundary and applies
at the next tick. The combat tick does no database work. The applied-completion journal is
bounded to 64 requests; a new activation is rejected with the runtime-capacity error until
the persistence supervisor drains a full backlog. The operation never changes:

- `nextEligibleAttackTick`;
- `scheduledAttackTick` or its generation;
- PvE phase, enemy action tick, or queue order;
- target, movement, or chase state;
- queued ability or reserved resource;
- Rage, cooldowns, effects, counters, or combat generation;
- aggression ownership or locks;
- current or maximum health.

An active-item upgrade follows the same staging seam to refresh derived values without
resaving kits or changing action timing.

## Fixed maximum health

The centralized resolver is:

```text
BASE_PLAYER_MAX_HEALTH = 100
FUTURE_PLAYER_MAX_HEALTH_SAFETY_CAP = 500

ordinary launch resolve = 100
future exceptional resolve = clamp(100 + explicit exceptional modifiers, 1, 500)
```

No current level, class rank, ordinary item, affinity, or kit supplies an exceptional
modifier. A future class, rare ring, potion, or event must use an explicit typed source.

When an old maximum is replaced, current health preserves percentage:

- zero remains zero;
- a living player remains at least one HP;
- a previously injured player is not rounded to full;
- a previously full player remains full;
- the transition is applied once and then persisted at the new maximum.

## Version-one balance

All coefficients live in one balance module and carry `balanceVersion = 1`.

Warrior affinity:

```text
preferred melee weapon category = axe
preferred armor category = heavy
affinity bonus = +3 effective item levels
```

Affinity does not change stored level. Each preferred armor item receives +3 before weighted
averaging, so a complete preferred armor set produces one approximately +3 weighted
advantage, not five additive character bonuses. Rings never receive heavy affinity.
The class snapshot publishes the server-owned affinity identity, preferred categories, bonus,
and balance version; equipment snapshots publish the applied per-item bonus and effective level.

PvP:

```text
normalizedClassPower = 25 * warriorRank / 15

PvPOffense =
    0.30 * characterLevel
  + 0.20 * normalizedClassPower
  + 0.50 * effectiveReadiedWeaponLevel

WeightedArmorLevel =
    0.20 * effectiveHeadLevel
  + 0.35 * effectiveChestLevel
  + 0.15 * effectiveGlovesLevel
  + 0.20 * effectiveBootsLevel
  + 0.10 * effectiveRingLevel

PvPGuard =
    0.30 * characterLevel
  + 0.20 * normalizedClassPower
  + 0.50 * WeightedArmorLevel
  + boundedLevelScaledShieldGuard

baseBasicDamage = 9
powerDifference = clamp(attackerOffense - defenderGuard, -15, 15)
powerMultiplier = 1.07 ^ powerDifference
finalBaseDamage = round(baseBasicDamage * powerMultiplier)
```

Only the readied melee or ranged weapon supplies offense. A shield supplies bounded Guard
while melee remains readied. A non-readied ranged or melee weapon supplies no passive
offense.

PvE keeps the existing queue and `damageFromStats` mitigation. Definition-owned minimum
contributions are multiplied by a monotonic level-0-safe curve. Level 0 is explicit and useful,
level 1 is larger, and level 25 is the ordinary maximum. The future proficiency seam is:

```text
target.kind === "mob" ? resolvePveWeaponProficiency(...) : 1
```

The launch implementation returns 1 because no compatible proficiency grind exists.

## Upgrade lifecycle and transaction

Version-one costs are provisional and centralized. There are exactly 25 transitions:

```text
0 -> 1 -> 2 -> ... -> 24 -> 25
```

For one request:

1. Reserve `equipment-upgrade:<account>:<requestId>`.
2. Lock the equipment instance and verify owner, state, and expected current level.
3. Resolve the server cost for `before -> before + 1`.
4. Debit the existing wallet service inside the same database transaction.
5. Update the instance by exactly one level and increment equipment/inventory revision.
6. Insert the completed upgrade operation and audit event.
7. Build the resulting authoritative snapshot and commit.

A replay with identical intent returns the stored result and does not debit again. Reusing a
request ID with different intent fails. Concurrent requests serialize on the instance; after
one succeeds, a competing stale expected-level request fails before debit. Any failure rolls
back wallet, level, operation, and audit event together.

## Reconnect, crash, and stale revisions

- A client activation includes the last server inventory revision it observed.
- A stale revision is rejected with a precise reason and cannot partially activate.
- Save, clear, ownership changes, destruction, and upgrade refresh the runtime snapshot and
  relevant revisions.
- Item upgrades do not invalidate kits because kit rows reference instances, not copied stats.
- Missing or destroyed references invalidate the kit without deleting it.
- A request disconnected before its tick remains a durable incomplete intent. Replaying the
  same request after reconnect stages it for a later tick without creating another operation.
- Reconnect restores the last valid checkpointed active kit/loadout. A completed operation
  replay returns its stored activation tick and does not stage or increment revisions again.
- A disconnect starts a new client reconciliation epoch, so a post-crash checkpoint with lower
  revisions replaces the prior connection's optimistic state; revisions remain monotonic within
  each live connection.
- If the persisted active-kit marker names an invalid or mismatched loadout, reconnect clears
  only that marker (and safely normalizes an unusable readied slot). It preserves every owned
  active item, kit, and surviving kit reference and never substitutes an item into an incomplete
  kit.
- Graceful disconnect flushes the latest active checkpoint and all accumulated completion rows
  in one transaction. A process crash after tick application but before that checkpoint can lose
  the final in-memory selection and leave its operation pending because durable active state did
  not advance; replay then stages it again. Ownership, item level, wallet state, and kit
  definitions are never part of that crash window.

## State transitions

```text
New level-0 item
  -> Owned level-0 item
  -> Saved-kit reference (zero or more kits)
  -> Active equipment (zero or one active slot)
  -> Staged kit activation
  -> Applied kit at tick boundary

Owned level-0 item
  -> atomic paid 0-to-1 upgrade
  -> Owned leveled item
  -> repeated atomic one-level upgrades
  -> Maximum level-25 item

Saved-kit reference
  -> invalidated kit when ownership/category/destroyed state becomes invalid
  -> valid again only when the exact references are valid; no partial fallback
```

## Future enchanted material seam

Equipment level and optional enchantment/material identity are independent. The combat seam
accepts action sequence, attacker/target context, active weapon instance, combat context,
ruleset, and an injected deterministic random source, and returns status/telemetry results.
Null enchantment performs no work. Swapping equipment never invokes the seam. No materials,
proc chances, effects, crafting, or UI are implemented in this feature.

## Telemetry and simulations

Bounded combat telemetry adds character level, Warrior rank, kit index, readied slot, weapon
category and levels, weighted armor, shield level, PvP Offense/Guard, activation tick,
switch/invalid counts, time to next resolved action, pre-scaling damage, power multiplier, and
final damage. It records IDs and bounded numbers only, not account identity or unbounded
inventory data.

The deterministic equipment report drives the production `CombatEngine` at 20 Hz and covers
the required progression matrix, mirrors, affinity, shield/ranged choices, level 0/1/25,
inventory and kit-count independence, active and inactive upgrades, switch timing, and a live
replacement-connection authority handoff that restores the equipment runtime without changing
health, target, or the existing action cadence. It writes:

- `docs/equipment-combat-balance-report.json`
- `docs/equipment-combat-balance-report.md`

## Migration and rollback strategy

The migration is expand-and-forward. It does not edit historical SQL and is safe on empty and
populated databases. Rerunning the migration runner applies nothing a second time. A failed
migration transaction leaves the old schema and data untouched.

Application rollback is code-only after migration: old rows remain readable through retained
location values and definition IDs, while new columns/tables are additive. The migration is
not reversed destructively. Any later correction is another forward migration.
