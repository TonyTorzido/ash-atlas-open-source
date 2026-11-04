# Blightwood Grove layout (Lv 17)

Read from the delivered floor PNGs (`apps/client/public/assets/dungeons/blightwood_grove/*-floor.png`).
Coordinates are **room units** (PNG px ÷ 2), y-down, origin top-left. Each floor PNG is the room
background at `x=0, y=0, width=room.width, height=room.height`.

New dungeon id `blightwood_grove`, `party_ephemeral`, world entrance art `blightwood_grove/entrance.png`.
Combat rooms lock until cleared; show `root-barricade.png` over a locked doorway. The Clearing's
N doorway stays sealed (root barricade) until **both** Fern Hollow and Treant Ring are cleared.

## Room graph

```
[world] ⇅ Grove Gate (S, daylight root arch)
Grove Gate N ⇄ Blighted Path W
Blighted Path E ⇄ Hermit's Clearing S
Hermit's Clearing W ⇄ Fern Hollow E
Hermit's Clearing E ⇄ Treant Ring W
Hermit's Clearing N ⇄ Heartwood S   (sealed until both side rooms are cleared)
```

## Rooms

### 1. Grove Gate: `grove_gate` (1000×1000, `grove-gate-floor.png`)
- Root and foliage walls ~60 thick. Playable x 60–940, y 60–900.
- **World exit:** sunlit path gap in the S wall x 430–570. Anchor `world_exit` (500, 960).
- **N doorway:** purple-tinged path gap x 430–570. Anchor `door_n` (500, 30); arrival `arrive_n`
  (500, 140).
- Spawn / world arrival (500, 800). Death recovery (500, 700). No combat.

### 2. Blighted Path: `blighted_path` (1600×800, `blighted-path-floor.png`)
- Walls: top y 0–55, bottom y 720–800, left x 0–40, right x 1560–1600.
- **W doorway:** path gap y 270–400. Anchor `door_w` (20, 335); arrival `arrive_w` (130, 335).
- **E doorway:** path gap y 290–410. Anchor `door_e` (1580, 350); arrival `arrive_e` (1470, 350).
- The south half is blighted (purple). Spawn Rot Wolves from the blight side (y 550–700) and Sap
  Crawlers along the path.

### 3. Hermit's Clearing: `hermit_clearing` (1200×1200, `hermit-clearing-floor.png`), safe room
- Foliage walls ~60 thick. Playable x 60–1140, y 60–1140.
- **S doorway:** gap x 510–690. Anchor `door_s` (600, 1175); arrival `arrive_s` (600, 1060).
- **N doorway (boss, sealed):** gap x 500–670. Anchor `door_n` (585, 25); arrival `arrive_n` (585, 140).
- **W doorway:** gap y 500–650. Anchor `door_w` (25, 575); arrival `arrive_w` (140, 575).
- **E doorway:** gap y 500–650. Anchor `door_e` (1175, 575); arrival `arrive_e` (1060, 575).
- Hermit's hut (mossy roof) collider rect (230, 110, 210, 190). Grove Hermit NPC (`grove-hermit.png`)
  stands at (340, 350): he takes 28 Elder Acorns to teach Hermit's Gift.
- Bare dirt circle at (330, 920), radius ~90: place the `healing-spring.png` prop there (rest spot,
  heals over time while standing in it).
- Zone purpose `safe` over the whole room: no mobs spawn here.

### 4. Fern Hollow: `fern_hollow` (1200×1000, `fern-hollow-floor.png`)
- Walls ~50 thick. Playable x 50–1110, y 60–900.
- **E doorway:** path gap y 410–560. Anchor `door_e` (1175, 485); arrival `arrive_e` (1060, 485).
- A stream meanders down the W side, roughly x 120–290 from top to bottom. Treat it as a collider
  band (polygon following the painted stream, ~70 wide), with no crossing needed; the W strip
  beyond it is decor.
- Giant fern clusters at (300, 100) and (300, 760) are small colliders. Thornferns spawn at fixed
  points along the fern line: (380, 250), (380, 650), (600, 820).
- Encounter: Thornferns (rooted) + Blighted Stags + Frogs.

### 5. Treant Ring: `treant_ring` (1200×1200, `treant-ring-floor.png`)
- Walls ~60 thick. Playable x 60–1130, y 60–1110.
- **W doorway:** path gap y 510–650. Anchor `door_w` (25, 580); arrival `arrive_w` (140, 580).
- Seven standing stones (colliders, radius ~55): (350, 270), (600, 160), (850, 280), (1020, 550),
  (910, 850), (600, 960), (290, 820).
- Encounter: Blight Treants rise beside the stones (spawn at the stone points, offset inward), plus
  Rot Wolves.

### 6. Heartwood: `heartwood` (1400×1400, `heartwood-floor.png`)
- Inside of the hollow tree. Bark wall ~40 thick on the sides and top, ~80 on the bottom. Playable
  x 40–1360, y 30–1320.
- **S doorway:** gap x 610–780. Anchor `door_s` (695, 1375); arrival `arrive_s` (695, 1230).
- Corruption heart at the centre (700, 640). The boss spawns there.
- Completion chest (1150, 1150). Elder Acorns drop from the boss.

## Mobs

| Mob | Archetype | Art | AI signature |
|---|---|---|---|
| Sap Crawler | `sap_crawler` (existing) | existing | existing |
| Frog | `frog` (existing) | existing | existing |
| Rot Wolf | `rot_wolf` | `rot-wolf.png` | pack hunter: surrounds a target, and wolves gain attack speed while 2+ are on the same target; bite applies a short poison |
| Blighted Stag | `blighted_stag` | `blighted-stag.png` | telegraphed straight-line charge with knockback, then a brief stun on itself if it misses |
| Thornfern | `thornfern` | `thornfern.png` | immobile; thorn volley at range; heavy bleed on melee attackers (thorns aura) |
| Blight Treant | `blight_treant` | `blight-treant.png` | slow tank; root slam (roots nearby players briefly); regenerates while standing on blight unless set on fire |
| Blight Sprite | `blight_sprite` | `blight-sprite.png` | boss add; flies to a player and bursts into a small spore cloud (poison zone) |
| The Hollow Elder | boss | `hollow-elder.png` | see below |
| Grove Hermit | NPC | `grove-hermit.png` | Acorn turn-in |

**The Hollow Elder (boss):**
- Root slam lines: telegraphed lanes radiating from it.
- Spore cloud zones.
- Summons waves of Blight Sprites.
- At 50% HP it pulls the corruption in (heals) unless players destroy the sprites.
- Drops Elder Acorns.

While inside the Grove, players get a temporary Hermit's Gift aura: a small group heal over time.

## Code wiring (mobs and boss are registered; layout JSON still to come)
- Mob archetypes: `rot_wolf`, `blighted_stag`, `thornfern`, `blight_treant`, `blight_sprite`; boss archetype
  `hollow_elder`. Behavior lives in `apps/server/src/game/combat/mobSpecialBehaviors.ts` and the combat engine;
  the boss controller is `apps/server/src/game/hollowElderBoss.ts`.
- Boss encounter: set `"bossTemplateId": "hollow-elder"` on the encounter, add `"hollow-elder"` to
  `modules.bossTemplateIds`, and place exactly one non-summoned mob with `"archetype": "hollow_elder"` (a large
  `visualScale`, about 1.7).
- Sprite waves: the dungeon runtime only spawns adds from authored placements (mobs spawned any other way are
  not attackable inside a dungeon), so waves are health-triggered summons. Add `blight_sprite` placements with
  `"summonedByMobSpawnId": "<boss placement id>"` and one `summonAtHealthPercent` per wave. Suggested waves:
  90, 70, 50, 35 and 20, 2 to 3 sprites each, every placement on its own walkable anchor and in a
  `spawnGroupId` per wave. List every summon id in the encounter wave's `mobSpawnIds` next to the boss. The 50%
  wave is the one the draw-in channel looks at.
- Draw-in: when the Elder falls to 50% it starts a channel 1.5s later, remembering the sprites alive then. If
  any of them is still alive 8s later it heals 15% of its max health; if all are dead, nothing happens. The
  phase shows as `drawing_corruption` with a deadline so the client can display it.
- Reward: 4 guaranteed Elder Acorns plus gold come from the boss's mob definition on defeat.
- Grove Hermit NPC: `apps/client/public/assets/dungeons/blightwood_grove/grove-hermit.png` is registered as the
  library prefab `grove_hermit` (type `object`, sprite). The catalog supports an `npc` object type, so place it
  as an object with `"type": "npc"` and `"prefabId": "grove_hermit"`. There is no NPC dialogue or turn-in code.
- Notes: stag charges and thornfern volleys have no client telegraph (non-boss mobs cannot draw one). Rot wolves
  gain per-hit damage per packmate on their target, not attack speed, because attack cadence stays uniform.
