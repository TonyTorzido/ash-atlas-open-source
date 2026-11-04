# Cistern Warrens v2 layout

Read from the delivered floor PNGs (`apps/client/public/assets/dungeons/cistern_warrens/*-floor.png`).
All coordinates are **room units** (PNG px ÷ 2), y-down, origin top-left. Each floor PNG is the room
background at `x=0, y=0, width=room.width, height=room.height`.

Rework in place: keep dungeon id `cistern_warrens`, its world entrance portal, and its instance policy.
Bump the revision to `cistern-warrens-v2`. The old rooms (`sewer_entrance`, `sewer_depths`, `rat_warden`)
and the old `sewer-floor.png` background are replaced; the goblins are removed.

## Room graph

```
[world] ⇅ Hatch Landing (N ladder)
Hatch Landing E ⇄ Overflow Channel W
Overflow Channel E ⇄ Turtle Cistern W
Turtle Cistern N ⇄ Warden Junction S
Warden Junction N ⇄ Webbed Tunnels W
Webbed Tunnels E ⇄ Brood Chamber W
```

Doorways are painted on the floors. Portals are placed **on** the painted openings and need no door
art (use an invisible/zero-opacity portal visual or the existing sewer door at low opacity; the
world exit keeps the painted ladder). The `grate-barricade.png` overlay is shown on a doorway while
its room is locked.

## Rooms

### 1. Hatch Landing: `hatch_landing` (1000×1000, `hatch-landing-floor.png`)
- Walls: top y 0–100, bottom y 880–1000, left x 0–100, right x 900–1000.
- **World exit:** painted ladder in the N wall gap x 430–570. Portal anchor `world_exit` (500, 60);
  interaction radius ~110.
- **E doorway:** gap y 410–540 in the right wall. Anchor `door_e` (950, 475); arrival `arrive_e`
  (820, 475).
- Spawn / world arrival: (500, 200). Death recovery: (500, 320).
- Collider: crates and lantern, rect (100, 680, 170, 180).

### 2. Overflow Channel: `overflow_channel` (1600×800, `overflow-channel-floor.png`)
- Walls: top y 0–45, bottom y 730–800, left x 0–60, right x 1540–1600.
- **W doorway:** gap y 330–470. Anchor `door_w` (30, 400); arrival `arrive_w` (130, 400).
- **E doorway:** gap y 330–470. Anchor `door_e` (1570, 400); arrival `arrive_e` (1470, 400).
- Sewage channel (not walkable) y 310–490 from x 200 to x 1400, crossed by two stone bridges at
  x 480–560 and x 1040–1112. Water colliders:
  - rect (200, 310, 280, 180)
  - rect (560, 310, 480, 180)
  - rect (1112, 310, 288, 180)
- Walkways: north y 45–300, south y 500–730, plus the floor columns at both ends (x 60–200 and
  x 1400–1540) that connect the doorways to both walkways.
- Spawn areas: north walkway rect (250, 70, 1100, 200); south walkway rect (250, 520, 1100, 190).

### 3. Turtle Cistern: `turtle_cistern` (1200×1200, `turtle-cistern-floor.png`)
- Walls: ~60 thick on all sides (playable x 60–1140, y 60–1140).
- **W doorway:** gap y 510–650. Anchor `door_w` (30, 580); arrival `arrive_w` (130, 580).
- **N doorway:** gap x 520–675. Anchor `door_n` (600, 30); arrival `arrive_n` (600, 130).
- Water ring (not walkable): an annulus centred (595, 545), outer radius 425, inner radius 262.
  Three stone paths cross it: N path x 555–665, W path y 520–640, S path x 555–665. That splits the
  water into three polygon colliders (approximate each arc with 8–10 points):
  - **A:** from the N path's east edge clockwise through E to the S path's east edge.
  - **B:** from the S path's west edge clockwise through SW to the W path's south edge.
  - **C:** from the W path's north edge clockwise through NW to the N path's west edge.
- Center island: circle centred (600, 550), radius ~255, walkable.
- **Treasure alcove** (painted, S): interior x 430–760, y 1010–1130, entered through a gap at
  x 545–645, y ~975–1010. Colliders for its walls:
  - rect (385, 975, 160, 35)
  - rect (645, 975, 145, 35)
  - rect (385, 1010, 45, 120)
  - rect (760, 1010, 30, 120)
  - Chest anchor `alcove_chest` (600, 1080).
- Corner floor outside the ring (all four corners) is walkable. Spawn areas: the four corners and
  the island.

### 4. Warden Junction: `warden_junction` (1000×1000, `warden-junction-floor.png`)
- Walls/pipes: playable x 115–885, y 100–880.
- **S doorway:** gap x 430–570. Anchor `door_s` (500, 970); arrival `arrive_s` (500, 860).
- **N doorway:** gap x 430–570. Anchor `door_n` (500, 30); arrival `arrive_n` (500, 140).
- Rag nest NW (decor, walkable). Rat Warden spawn (500, 420); escort rats around it.

### 5. Webbed Tunnels: `webbed_tunnels` (1600×800, `webbed-tunnels-floor.png`)
- Walls: top y 0–60, bottom y 700–800, left x 0–65, right x 1535–1600.
- **W doorway:** gap y 300–470. Anchor `door_w` (30, 385); arrival `arrive_w` (140, 385).
- **E doorway:** gap y 300–470. Anchor `door_e` (1570, 385); arrival `arrive_e` (1460, 385).
- Open floor x 65–1535, y 60–700. Spawn area rect (300, 100, 1000, 560). Web snares are placed here
  once that hazard exists.

### 6. Brood Chamber: `brood_chamber` (1400×1400, `brood-chamber-floor.png`)
- Circular floor centred (700, 700), radius ~610. Outside the circle is wall.
- **W doorway:** corridor y 570–780 from x 0 to x 210. Anchor `door_w` (30, 675); arrival
  `arrive_w` (230, 675).
- Pillar colliders (radius ~60): (385, 230), (1030, 230), (370, 1085), (1015, 1085).
- Giant web and egg sacs on the north half are floor decor (walkable). Boss spawn (700, 560).
  Completion chest (700, 1050). Exit ladder prop (`exit-ladder.png`) revealed at (700, 1180) after
  the boss, as a portal back to the world.

## Encounters

Phase 1 uses existing archetypes. New mobs and the boss replace the placeholders in later phases.

| Room | Encounter | Phase 1 (existing mobs) | Final |
|---|---|---|---|
| Overflow Channel | lock-in | 4 Sewer Rats | Sewer Rats + Dune Ticks |
| Turtle Cistern | lock-in | 3 Sick Sewer Rats | Shell-back Turtles + Sick Sewer Rats; alcove chest |
| Warden Junction | miniboss, lock-in | Rat Warden (`sewer-rat-miniboss`) + 2 Sewer Rats | same |
| Webbed Tunnels | lock-in | 3 Sewer Rats + 2 Sick Sewer Rats | Sewer Spiders + web snares |
| Brood Chamber | boss | Rat Warden as stand-in boss | Brood Matriarch + Spiderlings |

## Boss: Brood Matriarch
- Web snare: telegraphed root on a random player; the snare patch stays on the floor briefly.
- Poison bite on her current target (DoT).
- At 50% and 25% HP, egg sacs burst: a Spiderling wave from the chamber walls.
- While Spiderlings live she takes reduced damage (the brood shields her), so players must clear
  adds.
- Drops Brood Silk.

## Phases
1. **Layout:** 6 rooms, floors, walls, water, painted doorways as portals, existing mobs.
2. **New mobs:** register `shellback_turtle`, `sewer_spider`, `dune_tick`, and `spiderling` as mob
   archetypes with art and stats, then swap them in.
3. **Boss:** Brood Matriarch definition and controller (web snare root, poison bite, Spiderling
   waves at 50% and 25% HP), with web snare hazard and `grate-barricade.png` lock visuals.
