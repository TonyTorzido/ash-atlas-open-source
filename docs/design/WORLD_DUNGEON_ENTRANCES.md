# World dungeon entrances

How the eight ladder dungeons get overworld entrances that normal players can find and enter.
Owner design (2026-10-06): rare and exciting to find, effectively impossible in the wrong area,
findable with effort in the right area.

## Tuning table

Every rate, visibility window, season multiplier and qualifying layer lives in one shared table:
`packages/shared/src/worldDungeonEntrances.ts` (`WORLD_DUNGEON_ENTRANCE_RULES`, plus the Drowned
City and Golem Forge rows). Change numbers there; nothing else needs editing.

### Distance ladder (owner, 2026-10-06)

The target is the typical (median) distance from a spot in fully qualifying terrain to the nearest
entrance of that dungeon, at the x1 season. Each cell-roll dungeon has its own cell size and its
own spacing (the old single 30 km exclusion capped every dungeon near one per 2,800 km², so the
per-dungeon rates meant nothing). Measured by `worldDungeonEntrances.test.ts` over fake
all-qualifying terrain (400 sample spots, 200 km square; `LADDER_REPORT=1` prints it):

| Dungeon | Target | Cell (x1) | Spacing | Measured nearest (median) | Entrance-to-entrance (median / min) |
| --- | --- | --- | --- | --- | --- |
| Fangrock Cavern | 10 km | 400 km² | 14 km | 10.7 km | 18.2 / 14.4 km |
| The Eyrie | 12 km | 600 km² | 17 km | 12.6 km | 20.8 / 17.1 km |
| Blightwood Grove | 14 km | 800 km² | 20 km | 14.1 km | 24.9 / 20.6 km |
| Still Hand Monastery | 17 km | 1,150 km² | 24 km | 17.4 km | 30.5 / 26.2 km |
| Wyrm Hollow | 20 km | 1,600 km² | 28 km | 19.2 km | 33.6 / 29.3 km |
| Drowned City | 25 km nearest along a coast | 350 km² of coastal ocean | none | 22.8 km (8 straight 1,000 km coasts, spots on the coast) | one site per 75.5 km of coast |
| Golem Forge | 30 km nearest | 5,000 km² region | none (one per region) | 29.4 km | 40.4 km median; 71 km mean spacing |

Spacing is about 1.4x the target and the cell is sized so the spacing thins only clumps: a x2
season still adds entrances (the spacing does not saturate). Real terrain is patchy, so actual
distances are longer wherever qualifying cells are scarce.

| Dungeon | Placement | Qualifying cells | Visible | Rate |
| --- | --- | --- | --- | --- |
| Fangrock Cavern (6) | cell roll | hilly or mountainous; badlands, steppe, scrubland, highmeadow; outside cities and 3 km or more from any city | always | 1 per 400 km², 14 km spacing |
| The Eyrie (11) | cell roll | 2,500 m or higher; mountainous; highmeadow, pinewild, tundra, frostwood | day, dusk, dawn | 1 per 600 km², 17 km spacing, x2 in summer |
| Blightwood Grove (17) | cell roll | forest land cover; greenwood, pinewild, jungle, marsh; under 1,500 m; not coastal | dusk, night | 1 per 800 km², 20 km spacing, x2 in autumn |
| Still Hand Monastery (22) | cell roll | 1,500-2,500 m; hilly; highmeadow, steppe, pinewild; 10 km or more from any city | dawn, day | 1 per 1,150 km², 24 km spacing |
| Wyrm Hollow (27) | cell roll | mountainous; 1,500 m or higher; badlands, scrubland, steppe, tundra | always | 1 per 1,600 km², 28 km spacing, x2 in summer or dry season |
| Drowned City (32) | water site | coastal ocean (unchanged rule) | dusk, night | 1 per 350 km² of coastal ocean (was 2,500, before that 40,000) |
| Golem Forge (37) | forge region | 5,000 km² region (was 40,000); first of 16 slots that is hilly/mountainous in badlands, steppe, scrubland, tundra or highmeadow, else first land slot | always | one per region |
| Fallen Prison (40) | crash event | 15-30 km from an online level 40 player; hunted (see below) | always | unchanged cadence |

Common rules for the cell-roll dungeons: each entrance lives 7 days, then a new roll happens
somewhere else; two entrances of the same dungeon are never closer than that dungeon's spacing at
the same time; an entrance hidden by the time of day still exists (it still blocks others within
its spacing) but is left out of the nearby list and cannot be entered until it shows again.
Outside the qualifying layers the chance is zero.

## Mechanism: stateless deterministic cells (no table, no migration)

Chosen over the Population V2 overlay that Hollin Huts use. Reasons:

- The overlay plans per Population V2 generation and is gated in production by
  `POPULATION_V2_MOB_ROLLOUT_KINDS`; entrances would silently stay off until that env line changed,
  and generation top-ups decide when cells roll. The stateless model is on as soon as it ships.
- The overlay's candidate sites carry no city-distance fact, which Fangrock and the Monastery need.
- Drowned City and Golem Forge already use the stateless equal-area model (`waterSitePlacement.ts`);
  reusing it keeps one placement style for every raid entrance and needs no new storage.

How a roll works (`apps/server/src/game/worldDungeonEntrances.ts`):

1. The sphere is cut into equal-area cells of `rate / maxSeasonMultiplier` km² per dungeon (the same
   band/column cells as water sites). Each cell owns one deterministic slot point per rotation.
2. Rotation: all cells of one dungeon rotate together every 7 days; each dungeon has its own
   deterministic phase, so the five dungeons never move at the same moment. (Per-cell staggering
   was tried on paper and rejected: with staggered lives every neighbour always has a live slot, so
   an exact 30 km rule either chains back through time or suppresses almost everything.) The
   rotation number is part of the entrance id (`wd2_<band>_<column>_<rotation>_<dungeonId>`), so
   each rotation is a new place and instance. (`wde_` ids are the pre-ladder cells: they still
   resolve to their point for runs already inside, but never stand or admit again.)
3. Season multiplier: a slot rolls a deterministic unit; it is live when the unit is below
   `multiplier(season at spawn time and place) / maxMultiplier`. So a x2 season doubles the rate and
   the off season keeps the base rate. The season is fixed at spawn, so an entrance never vanishes
   mid-life because the season turned.
4. Qualifying: the slot point's World gameplay environment (terrain, land cover, elevation, RESOLVE
   biome, coast, land) must pass the dungeon's layers. For a city-distance rule the slot and two
   rings of eight points (at half and full distance) must all be outside a World city
   (`/api/lookup-batch`, `insideCity`): World only reports a boundary distance for points inside a
   city, so the ring is the outside-distance test. Unknown World answers fail closed and are not
   cached.
5. Spacing (per dungeon, `spacingM`): every slot has a deterministic mark; a qualifying slot is
   suppressed when a qualifying slot of the same dungeon and rotation with a lower mark stands
   within the dungeon's spacing (a suppressed slot still counts, so the check is local and never
   chains). Two live entrances of one dungeon are therefore never closer than its spacing. An
   unknown neighbour fails closed.
6. Answers are cached per entrance id until it expires.

Normal entry: the derived entrance resolves like the Drowned City one (template library entrance at
the slot). It is not developer-spawned, so `authorizeEntryGates` enforces the level gate and the
lockout, and `authorizeEntry` / the torch lobby enforce the torch cost. World entry (the portal
registry's world source and `entrance(id, true)`) also requires the entrance to be live, qualifying,
not suppressed and visible now; a run already inside resolves the id without World so an expiry or
outage never strands it.

## Expected counts near a player

The client lists entrances within 25 km (1,963 km²). In a fully qualifying area that disc holds
about 4-5 Fangrock entrances, 3 Eyries, 2-3 Blightwoods, 1-2 Monasteries and about one Wyrm Hollow.
Real areas are patchy, so expect:

- Fangrock: often one in dry hill country away from cities; none in flat or wet country.
- Eyrie: one in some high ranges (2,500 m+ mountain cells are scarce); none below the treeline belt.
- Blightwood: one in many lowland forests, but only at dusk and night.
- Monastery: occasional, in hilly 1,500-2,500 m highlands well away from cities.
- Wyrm Hollow: occasional, in dry high mountains (badlands, steppe, scrubland, tundra).
- Drowned City: about one per 75 km of coast (nearest typically ~23-25 km); dusk and night only.
- Golem Forge: one per 5,000 km² region, so often none and at most one or two in the 25 km list.

## Fallen Prison hunt (owner, 2026-10-06)

The crash no longer lands next to the player; level 40 players hunt it.

- Trigger (unchanged): every 5 minutes, each 1° region with an online level 40 player and no live
  crash gets one; it lasts 20 h and its guards respawn 5 h after they fall.
- Landing: 15-30 km from a random eligible player in that region (`FALLEN_PRISON_AUTO_CRASH`), on a
  spot the mob rules allow and that World says is land. The 8 candidate spots go to World in one
  batch through the rolled-entrance lookup path (`WorldDungeonEntranceService.environmentsAt`: the
  same 512 points/minute budget and 3-minute pause after a failure). No answer or no land: no crash
  this check (fail closed); the next check tries again.
- Landing line: every level 40 player in the region gets "A prison has fallen from the sky somewhere
  to the <8-point direction>." (`FALLEN_PRISON_HUNT` message with `announcement`).
- Live hint: every 30 s tick, each level 40 player within 40 km of a live crash gets an 8-point
  compass direction and a band (far > 10 km, closer 3-10 km, near < 3 km) towards the nearest crash,
  sent only when it changes or the player reconnects (new connection id); a player who leaves the
  40 km radius, or whose crash expires, gets one clear. Shared math: `packages/shared/src/fallenPrisonHunt.ts`.
- Client: a small pill (`apps/client/src/ui/FallenPrisonHuntIndicator.tsx`, top right) with a turning
  arrow, the band and the landing line; the chevron collapses it. No scrollbars, no X glyphs.
- Smoke: the crash is listed in the nearby entrance list only within 3 km (`FALLEN_PRISON_HUNT.smokeSightM`)
  instead of the usual 25 km, and draws a tall smoke column (`fallenPrisonSmokeColumn` in
  `pixiOverlay.ts`, kept on screen while the column is in view). When the hint says the smoke is in
  sight the client asks for the nearby list at once.
- No precise position reaches players: the landing no longer broadcasts the entrance to everyone,
  and the exact "Read the trail" bearing/distance (`POST /api/fallen-prison/trail`)
  is removed (its `fallen_prison_trail_claims` table is left in place, unused).
- Players below level 40 get nothing (no line, no hint). The developer crash route is unchanged.

## Persistence, migration, flags

- No database table and no migration. Highest migration number across all branches at writing:
  1200 (`1200_glimmer_shop.sql`); nothing here takes a number.
- No env flag. Entrances appear as soon as the change deploys. There is nothing to append to
  `game.env`.
- Drowned City ids moved to a `drowned3` family at the ladder density (350 km²); legacy
  `drowned` and `drowned2` ids still resolve for runs already inside (exit, room doors), but are no
  longer listed or enterable.
- Rolled entrances moved from `wde_` to `wd2_` ids (new cells): every live rolled entrance moves
  when this deploys; `wde_` ids resolve for runs already inside, never for entry.
- Golem Forge (distance ladder): regions are now 5,000 km² with keys `x<band>:<column>` (the
  `golem_forge_sites` CHECK already allows them, so no migration). Every live Forge relocates when
  this deploys, and progress in open Forges is lost (a new region is a new entrance id, so a new
  instance). Old `<band>:<column>` rows are inert for placement: their ids still resolve to their
  point (runs inside can leave), a recorded Forgemaster death still collapses on time (unused
  admissions refunded, players ejected), and once the collapsed hour is over the row's collapse_at
  is cleared so the sweep stops seeing it. They are never listed or entered. An old open Forge whose
  Forgemaster never died is retired by the collapse sweep: for every old-family instance with a paid
  admission nobody used, `retireLegacySite` upserts its row as moved on (cycle = slot + 1, never a
  delete; skipped while a row is mid-collapse) and `collapseGolemForge` refunds those admissions
  exactly as a collapse does (per-admission refunded_at inside one transaction, so a repeat or a
  restart mid-way pays nothing twice), moves anyone inside to the gate room and drops the instance
  once empty. Players inside can still leave through the gate (the old id resolves).
- Golem Forge lookups: `sitesNear` reads all uncached region rows in one query, and slot lookups now
  spend from their own 512 points/minute budget (plus the existing 3-minute pause after a World
  failure). With 5,000 km² regions (about 71 km across) a 25 km listing touches about 4-9 regions,
  so a first listing in a new area is at most about 9 x 16 = 144 slot points (cached 6 h), well
  inside one minute's budget; regions that do not fit stay hidden until a later listing.

## Verifying

- Developer readout: `GET /api/dev/world-dungeon-entrances?playerId=<id>&radiusM=25000`
  (`developer:observe`) lists the rolled entrances around an online player, hidden ones included,
  with distance, visibility and spawn/expiry times.
- Cost: a first query in an area where every cell qualifies makes about 700 gameplay-environment
  lookups (cached by World client) and, for Fangrock and the Monastery, up to about 5,500
  `lookup-batch` points for the city rings (about 22 requests). Answers are cached per entrance
  for its 7-day life; World misses back off for 2 minutes.
