# Monastery of the Still Hand layout (Lv 22)

Plan: `docs/design/DUNGEONS_5_6_PLAN.md` (Dungeon 5). Spec: `tools/appearance-studio/interior-specs/still_hand_monastery.json`;
data: `packages/shared/src/data/interiors/still_hand_monastery.json`. Coordinates are room units (PNG px ÷ 2),
y-down, origin top-left.

New dungeon id `still_hand_monastery`, `party_ephemeral`. Access: level 22, 18 Refined Oil + 1 Wood (torch cost),
6-day lockout. The library world entrance `still_hand_monastery_world_entrance` is unplaced: bind it in
Developer App > Spawning > Dungeon entrances.

## Art status

Floors are not delivered yet. Each room already has a `<room>_floor` prefab pointing at its planned PNG, drawn at
zIndex 1 over the shared placeholder floor (`still_hand_monastery_initial_floor`, zIndex 0). A missing PNG loads as
an empty texture, so the placeholder shows until the art drops in. When the floors land: drop them at the paths
below, map the anchors from the painted doorways (current door anchors are provisional, centred on each wall), add
wall colliders, and retire the placeholder placement.

| Room | Id | Units | Floor PNG (`apps/client/public/assets/dungeons/still_hand_monastery/`) | Doorways |
|---|---|---|---|---|
| Mountain Gate | `mountain_gate` | 1000×1000 | `mountain-gate-floor.png` (2000×2000) | S world exit (500, 960), N (500, 30) |
| Training Courtyard | `training_courtyard` | 1400×1000 | `training-courtyard-floor.png` (2048×1463) | S (700, 970), N (700, 30) |
| Bell Hall | `bell_hall` | 1200×1200 | `bell-hall-floor.png` (2048×2048) | S (600, 1170), E (1170, 600) |
| Garden of Stillness | `still_garden` | 1200×1000 | `still-garden-floor.png` (2048×1707) | W (30, 500), N (600, 30) |
| Hall of Statues | `statue_hall` | 1600×800 | `statue-hall-floor.png` (2048×1024) | S (800, 770), E (1570, 400) |
| Grandmaster's Sanctum | `grandmaster_sanctum` | 1400×1400 | `grandmaster-sanctum-floor.png` (2048×2048) | W (30, 700) |

Floors are drawn at 2 px per unit and downscaled to at most 2048 px (art drop `art-drops\monastery-env-01`, Drowned City method).
Props and entrance (same folder): `zephyr-altar.png` (prefab `monastery_zephyr_altar`, used by the
Zephyr Altar object), `entrance.png` (library entrance). `bamboo-barricade.png` is drawn but not wired, and `training-dummy.png` /
`bronze-bell.png` were not drawn (no barricade overlay exists for any dungeon; the dummy uses the
`training_dummy` silhouette; the bell is painted on the Bell Hall floor).

## Room graph and encounters

```
[world] ⇅ Mountain Gate (S)            safe; Zephyr Altar at (780, 320)
Mountain Gate N ⇄ Training Courtyard S  2 training dummies + 3 Initiate Monks
Courtyard N ⇄ Bell Hall S               2 Initiate Monks + 2 Bell Spirits
Bell Hall E ⇄ Garden W                  3 Shadow Acrobats + 2 Staff Adepts
Garden N ⇄ Hall of Statues S            5 Iron Statues (alcoves) + Shadow Acrobat + Bell Spirit
Hall of Statues E ⇄ Sanctum W           The Grandmaster (700, 600); 2 shadow clones at 50%
```

Every combat room locks its doors until cleared. The Grandmaster's defeat reveals the Grandmaster's Offering chest
(700, 260) and completes the dungeon.

## Rule: the Still Hand

Inside, a player carrying a weapon deals no damage; fight unarmed (martial weapons still work: brass knuckles,
shuriken, blowdart). Everyone fights with Martial Arts rank 3 and
Perfect Strike rank 1 for the run (higher learned ranks still count). Server: `isStillHandMonasteryZone` and
`STILL_HAND_GRANTED_SKILL_RANKS` (`packages/shared/src/stillHandMonastery.ts`), enforced in `CombatEngine.applyDamage`.

## Mobs

| Mob | Archetype | Signature (server: `combat/monasteryBehaviors.ts`) |
|---|---|---|
| Initiate Monk | `initiate_monk` | After two landed hits, a telegraphed cone finisher that knocks back |
| Staff Adept | `staff_adept` | Circle sweep telegraph around itself, then dashes onto its target |
| Shadow Acrobat | `shadow_acrobat` | 30% dodge; after two hits vanishes and reappears behind its target |
| Iron Statue Guardian | `iron_statue` | Dormant (rooted, no attacks) until a player is within 160 or strikes it; wakes with a slam, slams every 10 s; never displaced |
| Bell Spirit | `bell_spirit` | Toll: ring telegraph, damage, interrupts movement and silences general actives for 3 s |
| Training Dummy | `training_dummy` | Existing practice target |

## The Grandmaster (`grandmaster`, `grandmasterBoss.ts`)

Stances rotate every 12 s: Tiger (telegraphed palm cones, knockback) → Crane (stands still and glows twice for 4 s;
damage dealt to him while glowing is reflected to the attacker) → Tiger … Below 50% health Mantis joins after Crane
(quick circle strikes), and two `grandmaster_clone` shadow clones (his art, smaller and dark-tinted) are summoned
by the room data. Drops: gold. Zephyr comes from the Grandmaster's Offering chest (one claim per party member, like the
Fallen Prison seals), so every member earns a token per clear. 9 Zephyr also smelt a Skyrise bar.

## Zephyr and Perfect Strike

Zephyr (`zephyr`, migration 1120): every party member claims one from the Grandmaster's Offering chest after the boss. Offering 6 Zephyr (at the Zephyr Altar or from the Skills panel) discovers Perfect Strike
(`player_skill_world_unlocks`, once per player, tokens consumed in the same transaction); it is then bought with
General Skill Points (still requires Martial Arts 3).
