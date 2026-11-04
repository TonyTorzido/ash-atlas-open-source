# The Eyrie layout (Lv 11)

Read from the delivered floor PNGs (`apps/client/public/assets/dungeons/the_eyrie/*-floor.png`).
Coordinates are **room units** (PNG px ÷ 2), y-down, origin top-left. Each floor PNG is the room
background at `x=0, y=0, width=room.width, height=room.height`.

New dungeon id `the_eyrie`, `party_ephemeral`, world entrance art `the_eyrie/entrance.png`. Combat
rooms lock until cleared; show `bramble-barricade.png` over a locked doorway. **Sky is never
walkable.** In the open-air rooms, everything outside the described walkable shapes is a collider.

## Room graph

```
[world] ⇅ Cliff Base (S, path down the mountain)
Cliff Base N ⇄ Switchback Ledge W
Switchback Ledge E ⇄ Scrap Hollow W
Scrap Hollow N ⇄ Wind Bridge W
Wind Bridge E ⇄ Nest Crown W
```

## Rooms

### 1. Cliff Base: `cliff_base` (1000×1000, `cliff-base-floor.png`)
- Rock walls: left/right ~60 thick, top y 0–60, bottom y 900–1000. Playable x 60–940, y 60–910.
- **World exit:** dirt path gap in the S wall x 440–570. Anchor `world_exit` (505, 960).
- **N doorway:** carved stone steps x 440–560. Anchor `door_n` (500, 30); arrival `arrive_n` (500, 140).
- Spawn / world arrival (500, 800). Death recovery (500, 700). No combat.

### 2. Switchback Ledge: `switchback_ledge` (1600×800, `switchback-ledge-floor.png`)
- Walkable ledge: from the top rock edge (y ≈ 30) down to the cliff lip, which waves between
  y ≈ 540 and y ≈ 640. Use a conservative wavy polygon at y 560 for the lip. Everything below it is
  sky (collider).
- Thin rock rim on the left (x 0–30), right (x 1570–1600) and top (y 0–30).
- **W doorway:** the dirt path meets the left edge at y 300–420. Anchor `door_w` (20, 360); arrival
  `arrive_w` (130, 360).
- **E doorway:** the path meets the right edge at y 300–420. Anchor `door_e` (1580, 360); arrival
  `arrive_e` (1470, 360).
- Encounter: Dune Ticks on the path; Cliff Hawks dive in from the sky side (spawn them along
  y 520).

### 3. Scrap Hollow: `scrap_hollow` (1200×1000, `scrap-hollow-floor.png`)
- Rock walls ~60 thick. Playable x 60–1140, y 60–940.
- **W doorway:** dark opening y 400–500. Anchor `door_w` (25, 450); arrival `arrive_w` (140, 450).
- **N doorway:** dark opening x 520–680. Anchor `door_n` (600, 25); arrival `arrive_n` (600, 140).
- Mouse holes painted at (240, 40), (1040, 50), (1160, 560): use them as Nest Mouse spawn points.
- Scrap piles (decor) in the SW and SE corners.
- Encounter: Nest Mice in waves out of the holes, plus Carrion Chicks.

### 4. Wind Bridge: `wind_bridge` (1600×700, `wind-bridge-floor.png`)
- Walkable shapes, with sky everywhere else:
  - **W outcrop:** irregular rock, roughly polygon (0, 230), (60, 150), (200, 140), (300, 220),
    (300, 430), (200, 520), (80, 520), (0, 400).
  - **Bridge planks:** rect (300, 275, 990, 115). The rope rails are the edges.
  - **E outcrop:** roughly polygon (1290, 220), (1360, 150), (1520, 150), (1600, 230), (1600, 400),
    (1500, 520), (1360, 520), (1290, 430).
- **W doorway:** at the left edge y 230–390. Anchor `door_w` (20, 310); arrival `arrive_w` (140, 330).
- **E doorway:** at the right edge y 230–390. Anchor `door_e` (1580, 310); arrival `arrive_e`
  (1460, 330).
- Encounter: Cliff Hawks dive the bridge while Carrion Chicks block the E outcrop.

### 5. Nest Crown: `nest_crown` (1400×1400, `nest-crown-floor.png`)
- Walkable shapes, with sky everywhere else:
  - **Stone walkway:** rect (0, 620, 300, 130).
  - **Summit plateau:** circle centred (730, 690), radius ~490.
- The twig nest fills the plateau centre (centre ~(750, 690), outer radius ~330). It is the boss
  arena and is walkable; its rim is decor.
- **W doorway:** the walkway at the left edge. Anchor `door_w` (20, 685); arrival `arrive_w` (200, 685).
- Painted eggs in the NE of the nest around (790, 480). The `giant-egg.png` pickup appears at
  (760, 600) after the boss.
- Boss spawn (780, 700). Completion chest (1050, 950). World exit portal after the boss at the
  walkway end, or reuse `door_w` back.

## Mobs

| Mob | Archetype | Art | AI signature |
|---|---|---|---|
| Dune Tick | `dune_tick` (from the Sewer) | `dune-tick.png` | erratic hops |
| Nest Mouse | `nest_mouse` | `nest-mouse.png` | darts in, steals (briefly snatches a dropped/ground item or gold on hit), flees to a hole |
| Carrion Chick | `carrion_chick` | `carrion-chick.png` | slow, tanky blocker; screeches to call nearby hawks (aggro link) |
| Cliff Hawk | `cliff_hawk` | `cliff-hawk.png` | circles at range, telegraphed dive strike, then climbs away out of melee reach |
| Thunderwing | boss | `thunderwing.png` | see below |

**Thunderwing (boss):**
- Wind gust cone that knocks players back. Near the plateau edge this is dangerous: the gust can
  push a player against the sky collider but never off it.
- Telegraphed dive on a random player.
- Static charge: every few gusts it marks a player, and lightning strikes their spot after a delay.
- At 50% HP it calls Carrion Chicks and Cliff Hawks.
- Drops a chance at a Giant Egg.

## Code wiring (mobs and boss are registered; layout JSON still to come)
- Mob archetypes: `nest_mouse`, `carrion_chick`, `cliff_hawk` (plus the existing `dune_tick`); boss archetype
  `thunderwing`. Mob behavior lives in `apps/server/src/game/combat/mobSpecialBehaviors.ts` and the combat
  engine; the boss controller is `apps/server/src/game/thunderwingBoss.ts`.
- Boss encounter: set `"bossTemplateId": "thunderwing"` on the encounter, add `"thunderwing"` to
  `modules.bossTemplateIds`, and place exactly one non-summoned mob with `"archetype": "thunderwing"` (a large
  `visualScale`, about 1.6). The template resolves to the registered `thunderwing` definition and controller.
- 50% call: add 2 `carrion_chick` and 2 `cliff_hawk` placements in the boss room with
  `"summonedByMobSpawnId": "<boss placement id>"` and `"summonAtHealthPercent": 50`, each on its own walkable
  anchor and in a `spawnGroupId` of its own. List every summon id in the encounter wave's `mobSpawnIds` next to
  the boss.
- Reward: one guaranteed Giant Egg plus gold comes from the boss's mob definition on defeat. The optional
  ground art `the_eyrie/giant-egg.png` is not wired to the drop.
- Wind gust knockback goes through the server's `repositionPlayer` option, so a push is shortened until the room
  accepts the landing spot and never carries anyone off the walkable floor or through the sky collider.
- Mob notes: nest mice slow their target on the bite (there is no existing gold-theft hook) and run about 220m
  away after each bite. Hawk dives have no client telegraph (non-boss mobs cannot draw one); a climbing hawk is
  unreachable for about 2.5s.
