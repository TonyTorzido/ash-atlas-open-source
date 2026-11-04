# Fangrock Cavern layout (Lv 6)

Read from the delivered floor PNGs (`apps/client/public/assets/dungeons/fangrock_cavern/*-floor.png`).
Coordinates are **room units** (PNG px ÷ 2), y-down, origin top-left. Each floor PNG is the room
background at `x=0, y=0, width=room.width, height=room.height`.

New dungeon id `fangrock_cavern`, `party_ephemeral`. World entrance art: the existing
`dungeons/shared/orc-cave-entrance.png`. Every combat room locks its doors until cleared; show
`rockfall-barricade.png` over a locked doorway.

## Room graph

```
[world] ⇅ Cave Mouth (S, daylight)
Cave Mouth N ⇄ The Fork S
The Fork W ⇄ Raptor Den E        (dead end: nests, ore)
The Fork E ⇄ Mushroom Grotto W   (dead end: goblin mine, ore)
The Fork N ⇄ Narrow Pass W
Narrow Pass E ⇄ Bone Pit W
Bone Pit N ⇄ Chieftain's Throne S
```

## Rooms

### 1. Cave Mouth: `cave_mouth` (1000×1000, `cave-mouth-floor.png`)
- Rock walls: left x 0–100, right x 900–1000, top y 0–100, bottom y 830–1000.
- **World exit:** daylit gap in the S wall x 400–600. Anchor `world_exit` (500, 950).
- **N doorway:** gap x 430–570. Anchor `door_n` (500, 40); arrival `arrive_n` (500, 150).
- Spawn / world arrival (500, 760). Death recovery (500, 650).
- No combat. A torch or a hint message lives here.

### 2. The Fork: `the_fork` (1000×1000, `the-fork-floor.png`)
- Playable x 60–940, y 60–930 (boulder clusters in the four corners are walls).
- **S doorway:** gap x 400–560. Anchor `door_s` (480, 970); arrival `arrive_s` (480, 860).
- **N doorway:** gap x 400–570. Anchor `door_n` (485, 30); arrival `arrive_n` (485, 140).
- **W doorway:** gap y 400–530. Anchor `door_w` (30, 465); arrival `arrive_w` (140, 465).
- **E doorway:** gap y 420–540. Anchor `door_e` (970, 480); arrival `arrive_e` (860, 480).
- Corner boulder colliders: rough rects (0, 0, 200, 200), (800, 0, 200, 200), (0, 800, 200, 200),
  (800, 800, 200, 200), trimmed so they don't cover the doorway gaps.
- Encounter: a raptor pack in the center. Lock all 4 doorways.

### 3. Raptor Den: `raptor_den` (1000×800, `raptor-den-floor.png`)
- Playable x 60–930, y 60–720.
- **E doorway:** gap y 340–455 in the right wall. Anchor `door_e` (970, 400); arrival `arrive_e`
  (860, 400).
- Nests along the W wall (decor, walkable). Gold ore vein painted in the top wall at x 540–620; put
  an ore node at (580, 110).
- Encounter: Raptor Runts guarding the nests. Optional chest at (150, 650) by the egg nest.

### 4. Mushroom Grotto: `mushroom_grotto` (1200×1000, `mushroom-grotto-floor.png`)
- Playable x 70–1120, y 80–890.
- **W doorway:** gap y 350–450 in the left wall. Anchor `door_w` (30, 400); arrival `arrive_w`
  (140, 400).
- Colliders:
  - Mushroom cluster NE: circle (800, 90) radius 70.
  - Mushroom cluster SE: circle (1060, 850) radius 110.
  - Mine scaffold and rails along the E wall: rect (1000, 20, 120, 560).
- Ore nodes along the rails (960, 300) and (980, 500); crystal ore near (350, 920).
- Encounter: Goblins mining + Cave Bats.

### 5. Narrow Pass: `narrow_pass` (1600×700, `narrow-pass-floor.png`)
- A winding path crosses W–E, with a chasm and rope bridge in the middle.
- **W doorway:** gap y 300–400. Anchor `door_w` (30, 350); arrival `arrive_w` (140, 350).
- **E doorway:** gap y 300–400. Anchor `door_e` (1570, 350); arrival `arrive_e` (1460, 350).
- Walkable path: rect (60, 260, 640, 170), the bridge rect (700, 305, 205, 95), and rect
  (905, 260, 635, 170).
- Treat the stalagmite and rock bands above and below the path as walls. The chasm x 700–905 is a
  collider everywhere except the bridge.
- Encounter: Cave Bats swooping over the bridge, then 2 raptors at the E end.

### 6. Bone Pit: `bone_pit` (1200×1200, `bone-pit-floor.png`)
- Sunken arena: pit floor roughly a circle centred (640, 640) radius ~380, raised rocky ledges
  around it (walkable), outer wall ~80 thick.
- **W doorway:** gap y 510–640. Anchor `door_w` (30, 575); arrival `arrive_w` (150, 575).
- **N doorway:** ramp gap x 500–670. Anchor `door_n` (585, 30); arrival `arrive_n` (585, 160).
- Boulder clusters on the ledges are small colliders (optional; paint in Studio).
- Encounter: a raptor ambush in waves (Cave Raptors, then Raptor Spitters from the ledges).

### 7. Chieftain's Throne: `chieftain_throne` (1400×1400, `chieftain-throne-floor.png`)
- Playable x 90–1310, y 90–1210.
- **S doorway:** gap x 615–785 in the bottom wall. Anchor `door_s` (700, 1370); arrival `arrive_s`
  (700, 1150).
- Boulder throne in the N wall: collider rect (570, 0, 300, 220). Chieftain spawn in front of it
  (720, 330).
- Scale Shrine prop (`scale-shrine.png`, clickable) at (1180, 1080) in the SE corner.
- Completion chest (400, 1050). World-exit portal (e.g. a painted crack or the S door back) after
  completion.
- Encounter: Raptor Chieftain. Runts called at 66% and 33% HP. Drops 1 Raptor Scale.

## Mobs

| Mob | Archetype (new unless noted) | Art | AI signature |
|---|---|---|---|
| Cave Raptor | `cave_raptor` | `mobs/dungeons/cave-raptor.png` | pack flanker: raptors on the same target spread around it instead of stacking; a short pounce gap-closer |
| Raptor Runt | `raptor_runt` | `mobs/dungeons/raptor-runt.png` (redo requested) | fast and fragile; at low HP it flees and shrieks, pulling idle raptors in the room to its attacker |
| Raptor Spitter | `raptor_spitter` | `mobs/dungeons/raptor-spitter.png` | keeps range; acid spit leaves a short acid puddle (damage zone); backs off when meleed |
| Cave Bat | `cave_bat` | `mobs/dungeons/cave-bat.png` | erratic flier; hit-and-retreat; small lifesteal on bite |
| Goblin | `goblin` (existing) | existing | existing |
| Raptor Chieftain | boss | `mobs/dungeons/raptor-chieftain.png` | see below |

**Raptor Chieftain (boss):**
- Telegraphed leap slam onto a player (circle AoE).
- War roar that buffs every raptor in the room's attack speed for a few seconds.
- Calls Raptor Runts at 66% and 33% HP.
- Below 25% HP it enrages: faster leaps.
- Drops 1 Raptor Scale.

## Code wiring (mobs and boss are registered; layout JSON still to come)
- Mob archetypes: `cave_raptor`, `raptor_runt`, `raptor_spitter`, `cave_bat`; boss archetype `raptor_chieftain`.
  Behavior lives in `apps/server/src/game/combat/mobSpecialBehaviors.ts` and the combat engine; the
  boss controller is `apps/server/src/game/raptorChieftainBoss.ts`.
- Boss encounter: set `"bossTemplateId": "raptor-chieftain"` on the encounter, add `"raptor-chieftain"` to
  `modules.bossTemplateIds`, and place exactly one non-summoned mob with `"archetype": "raptor_chieftain"`
  (give it a generous `visualScale`, about 1.5). The template resolves to the registered
  `raptor_chieftain` boss definition and controller.
- Runt calls: add `raptor_runt` placements in the boss room with `"summonedByMobSpawnId": "<boss placement id>"`
  and `"summonAtHealthPercent": 66` (first wave) or `33` (second wave), each on its own anchor along the
  walls, in their own `spawnGroupId`. List every summon id in the encounter wave's `mobSpawnIds` next to the boss.
- Reward: a guaranteed Raptor Scale plus gold comes from the boss's mob definition on defeat; no chest wiring.
- War roar buffs per-hit damage (not attack cadence, which stays uniform) of raptor-family mobs in the boss room.
