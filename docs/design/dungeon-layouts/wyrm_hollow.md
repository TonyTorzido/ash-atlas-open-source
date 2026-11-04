# Wyrm Hollow layout (Lv 27)

Spec: `tools/appearance-studio/interior-specs/wyrm_hollow.json` (scaffolded with `pnpm interior:scaffold`,
then post-processed like the other ladder dungeons). Coordinates are **room units** (PNG px ÷ 2), y-down.
Each floor PNG is the room background at `x=0, y=0, width=room.width, height=room.height`.

Dungeon id `wyrm_hollow`, `party_ephemeral`. Access: level 27, entry cost 18 Glimmer Oil + 1 Wood (the torch
cost), 6-day completion lockout. World entrance template `wyrm_hollow_world_entrance` (art
`wyrm_hollow/entrance.png`) is unplaced like the others: bind it in Developer App > Spawning > Dungeon
entrances. The developer menu can spawn it.

**Art status:** delivered (art drop wyrm-hollow-01): the seven floors, the Wyrm Nest and the entrance under
`apps/client/public/assets/dungeons/wyrm_hollow/`, smooth redraws of the lair mobs, the Elder Dragon boss
appearance, the Ember Drake pet, the Wyrm Egg and the new Dragon Scale item icon. Doorways were placed mid-wall
before the floors existed; re-check them against the art and add wall/lava colliders (the Bone Bridge should become
a narrow walkable band at y ~ 350).

## Room graph

```
[world] ⇅ Lair Mouth (S cave mouth)
Lair Mouth N ⇄ Ember Tunnels W
Ember Tunnels E ⇄ Salamander Pools W
Salamander Pools N ⇄ Bone Bridge W
Bone Bridge E ⇄ Hatchery W
Hatchery E ⇄ Hoard Vault W   (optional side room)
Hatchery N ⇄ Hoard Chamber S  (boss)
```

| Room | Size | Floor | Doorway anchors | Encounter |
|---|---|---|---|---|
| `lair_mouth` | 1000×1000 | `lair-mouth-floor.png` | world exit (500, 960), N (500, 30) | none |
| `ember_tunnels` | 1600×800 | `ember-tunnels-floor.png` | W (30, 400), E (1570, 400) | 4 Drakelings, 2 Lava Slimes, 1 Fire Bird; 5 lava vents |
| `salamander_pools` | 1200×1200 | `salamander-pools-floor.png` | W (30, 600), N (600, 30) | 3 Magma Salamanders, 1 Lava Slime, 2 Drakelings |
| `bone_bridge` | 1600×700 | `bone-bridge-floor.png` | W (30, 350), E (1570, 350) | 3 Ash Wyverns, 2 Drakelings, 1 Fire Bird |
| `hatchery` | 1200×1000 | `hatchery-floor.png` | W (30, 500), N (600, 30), E (1170, 500) | 2 Drake Broodguards, 3 Drakelings; Wyrm Nest at (600, 560) |
| `hoard_vault` | 800×800 | `hoard-vault-floor.png` | W (30, 400) | 1 Magma Salamander, 2 Lava Slimes; reveals the Hoard Vault Cache |
| `hoard_chamber` | 1600×1600 | `hoard-chamber-floor.png` | S (800, 1570) | The Elder Dragon at (800, 760); reveals the hoard chest and completes the run |

Every combat room locks its doors until cleared. Themed resources: sulfur/coal in the tunnels, iron/stone in
the pools.

## Mobs (`apps/server/src/game/combat/wyrmHollowBehaviors.ts` for tuning, engine `processWyrmHollowMob`)

| Mob | Archetype | AI |
|---|---|---|
| Drakeling | `drakeling` | pack mob; every 6s a 0.8s-telegraphed small fire cone that burns |
| Magma Salamander | `magma_salamander` | every 11s submerges for 2.5s (retreat state: untargetable), surfaces beside its target with a burning bite; ordinary bites burn 35% of the time |
| Lava Slime | `lava_slime` | drips a 3s burning puddle every 1.6s while fighting |
| Ash Wyvern | `ash_wyvern` | Cliff Hawk flight (keeps range, telegraphed dive, climbs out of reach); the dive knocks players back |
| Drake Broodguard | `drake_broodguard` | slow tank; enraged (harder hits, "Enraged" buff) while a player stands at the eggs by its post (220 units of its spawn point). There is no egg pickup system, so standing at the clutch stands in for "picking up an egg". Drops 1 Dragon Scale |
| Fire Bird | `fire_bird` (existing) | occasional ember bird |

**Lava vents:** zones with purpose `damage` are timed hazards (implemented generically in the dungeon
runtime). While a player is in the room each vent erupts every 7s, staggered 1.4s apart: 1.5s telegraph,
then a 2.5s burning zone.

## The Elder Dragon (`apps/server/src/game/elderDragonBoss.ts`)

- Fire breath: 60° cone, 1.6s telegraph every 9s; burns.
- Wing buffet: circle around itself, knocks players back, every 12s.
- Flight at 70% and 40% health: 15s airborne (retreat state + zero incoming/outgoing damage), a telegraphed
  fireball on a random player every 1.8s; 3 and 4 Drakelings spill in from the edges as the runtime's
  health-triggered summons (placements `elder_dragon_drakeling_70_*` / `_40_*`), then it lands and turns on a
  random player.
- Four lava pools diagonally off the perch pulse every 4s and widen from 90 to 260 units.
- Below 25%: enraged, breath every 5s with a 1s telegraph.
- Reward (mob definition, normal defeat settlement): 1 Wyrm Egg guaranteed, 3 Dragon Scales, 520 gold.

## Wyrm Egg and Rare Beast Mastery

The Wyrm Nest in the Hatchery (`skillTurnIn: "rare_beast_mastery"`) takes 6 Wyrm Eggs plus 3 different trophies (Stormwing Talon, Chimera Horn, Patriarch Tusk,
Elder Serpent Horn, Kraken Beak) from a level 27+ player and
discovers Rare Beast Mastery; ranks then cost General Skill Points. The Wyrm Egg is also the Ember Drake pet egg.

| Rank | Effect | Where |
|---|---|---|
| 1 | Hatch and call the Ember Drake; craft Chain Mail (10 Dragon Scales, 8 Iron Bars) and the Ranged Shield (6 Dragon Scales, 8 Iron Bars, 50 Wood) at the Smithing Station; +6 max health; +1 Defense against dragons | `petSystem.ts` (`requiresSkill`), `equipment.ts` (`requiresSkill` on the recipe, checked in `EquipmentService`), `skillSystemV3.ts` |
| 2 | Ember Drake out 40 min longer; +11 max health; +1 Attack against dragons | `petActiveDurationMs`, `RARE_BEAST_MASTERY_MAX_HEALTH`, `rareBeastDragonDefenseBonus` |
| 3 | Ember Drake out 75 min longer; +18 max health; +2 Defense and Attack against dragons | `rareBeastDragonAttackBonus` |

Max health is each rank's total (6 / 11 / 18), not cumulative. "Dragons" are the Drakeling, Ash Wyvern, Drake
Broodguard and Elder Dragon, plus the overworld Ash Drake and Ember Dragon (`RARE_BEAST_DRAGON_ARCHETYPES`); the Magma Salamander and Lava Slime are not dragons.
Wyrm Scalemail and Wyrm Shield are our Chain Mail (Chainmail matrix column) and Ranged Shield (Wyrm Shield
column): only crafting them is gated; pieces already owned stay usable and tradable.
