# Interior map renderer

Interiors are drawn by the overworld renderer (MapLibre + the Pixi overlay) instead of
separate DOM scenes, so indoors looks and plays like above ground. Portals, locations and
server authority are unchanged (`UNIVERSAL_PORTAL_AND_LOCATION_SYSTEM.md`).

## Coordinate strategy

- Every interior renders around lat/lon (0, 0). The client shows one interior at a time;
  the server already separates instances by `interior:<instance>` region/zone ids.
- `packages/shared/src/interiorSpace.ts` owns the conversion.
  `metersPerUnit = DEFAULT_PLAYER_SPEED_MPS / movementUnitsPerSecond`:
  dungeon/Cistern Warrens 125/130, manor/salon/greenhouse 125/260. Every profile therefore
  moves at the overworld 125 m/s and draws a 33.65 m player. Size is tuned by art scale,
  never by speed.
- Rooms are y-down; local +y maps to south (`lat = -y * metersPerUnit / metersPerDegree`).
  The dungeon combat conversion (`dungeonLocalToCombatPosition`) uses the same axis, so
  combat lat/lon equals map lngLat indoors and world targeting, projectiles, floaters and
  boss telegraphs work unchanged.
- Nothing persisted in lat/lon needed a migration: dungeon sessions, arrivals and Manor
  drops persist local coordinates. Dungeon ground drops (1-hour TTL) written before the
  flip are read mirrored by sign (`storedDropLatitude`).

## Camera rules

- Entering an interior saves the world camera, hides every world style layer and world
  overlay by visibility (never `setStyle`), pauses the globe background sync, and shows a
  plain interior background.
- Camera starts at `INTERIOR_DEFAULT_ZOOM` (18.35: the zoom where the world player sprite
  covers the interior player's 33.65 m; derivation in the client interior-space test) and
  follows the player. Zoom and pan behave exactly like the overworld: wheel/pinch zoom
  anchors at the cursor or pinch point, drag pans anywhere, and zoom-out reaches
  `INTERIOR_MIN_ZOOM` so the whole room fits. There is deliberately no MapLibre `maxBounds`:
  when the viewport is larger than the bounds it forces the centre to the bounds centre, which
  broke cursor-anchored zoom and blocked zoom-out. Instead the centre is eased back into the
  room plus a small margin on `moveend` (`clampInteriorCameraCenter`), never during a gesture.
- Interiors draw no movement leash or gameplay view circle (the gameplay area still limits
  movement), and the map's `moveend` does not persist the interior camera as the saved world
  presentation state.
- Catalog camera `fixed_center` no longer drives the in-game camera (Studio may still use it).
- Leaving restores the saved world camera and zoom range. The retained reconnect center
  stays the world camera. Flag-travel presentation is blocked while indoors; selection is
  cleared whenever the space changes.

## Layer order (bottom to top)

1. `background`, `below_player` authored layers (one Pixi container per room, transformed
   from the projected room origin and one axis point per frame)
2. world static layers (drops) and boss telegraphs
3. actors, y-sorted: authored `actors` layer, objects, resource nodes (overworld collectibles), players, mobs
4. `above_player`
5. local player, target highlights, projectiles, floaters
6. `ceiling`

Colliders and zones draw only in the developer debug overlay. Room textures load at
native resolution and unload when the space is left.

## Dungeon resource nodes

Dungeon resources are real overworld resource nodes scoped to one dungeon run: same art
(`collectibleArtworkKey`), same prompt, same START/COMPLETE/CANCEL_HARVEST flow and frames,
same gather duration, yields, tool/mastery effects and XP. The client projects `snapshot.resources`
through `dungeonResourceAsCollectible` (id `dungeon-resource:<id>`) into the interior
`collectibles`; the server adapter (`DungeonResourceHarvestService`) reuses the overworld rule
functions.

- The catalog's `minYield`/`maxYield`/`respawnSeconds`/`resetOnRun` are ignored in the game
  (they only drive the Studio playtest runtime). Yield comes from the
  overworld definitions and mining runs exactly like the overworld (duration, mastery rolls
  including unbroken vein and bonus extraction, XP). **Dungeon nodes never regenerate:** a
  depleted mine has no respawn timer (`availableAt` is always null, the prompt shows plain
  "Depleted") and stays depleted for the rest of the run unless a skill keeps it ready (unbroken
  vein); trees and plants vanish when harvested and last until
  the run ends.
- Nodes are always run-scoped: a new run has fresh nodes and the old run's state is gone.
  They are never claimable, access-managed or written to the world store.
- Harvest range is the overworld pickup radius (`COLLECTIBLE_PICKUP_RADIUS_M`).
- Leaving the room or dungeon cancels the active gather. `DUNGEON_HARVEST_RESOURCE` is rejected
  for game clients.

## Phases

- **P0 foundations** (done): interiorSpace, y-axis flip, map space mode, overlay interior
  render state, this document.
- **P1 dungeon + Cistern Warrens on the map** (done; now the default for everyone): Developer Tools
  "Use legacy indoor dungeon scene" (dev-only, session-only, default off) falls back to the old
  DOM scenes. By default the DOM dungeon/sewer scenes are not
  mounted; the map renders the room, input moves through `requestManualDungeonMove`, and
  fixtures pick through the overlay (`interiorRoom.pickObjectsAt`, prefab frame rectangles) into the existing action prompts.
  Interior taps run the world pick pipeline: `WorldObjectPick` gained `interior_object`, so the phone multi-target chooser lists room fixtures and resource nodes.
  The Recenter button eases to the local dungeon player at `INTERIOR_DEFAULT_ZOOM`, world
  camera moves are ignored while indoors, and class-ability drag-aim previews and commits in
  map lngLat (equal to the combat position).
- **P2 remove the legacy dungeon path**: map rendering is already the default; delete
  `DungeonZoneLayer`, `DungeonEntityLayer`, `dungeonZoom`. Keep `DungeonRoomPresentation`
  until the Studio playtest moves.
- **P3 greenhouse**: planters and the water tank become interior object types.
- **P4 manor / foyer / salon** on the map. Manor rooms done (2026-10-20, branch feature/manor-map--from-t1561):
  `features/interiorMap/manorMapInterior.ts` builds the interior render state (floor art, lobby stations, decorations and
  the placement preview as `InteriorRenderState.sprites`, local player from the Manor timeline, same-room occupants from
  MANOR_OCCUPANTS, floor drops through the world drop layer). `ManorScene mapRendered` keeps only the HUD, prompts and a
  drag surface while a decoration is placed; map taps hit-test doors, world exit, stations, guests and drops in room units
  (`mapPickRef`), map double-tap and the stick walk through `walkableIndoorJoystickTarget` on the decoration-aware client
  navigation (`manorClientNavigation`, same inputs as the server). Camera follow, Recenter and the off-screen indicator use
  the Manor timeline. The legacy foyer keeps its DOM scene: only players saved there before authored Manors can reach it.
  Salon and Greenhouse done (2026-10-21, branch feature/salon-greenhouse-map--from-t1562): `salonMapInterior.ts` draws
  the CSS-era floor, mirror, door and chair as SVG sprites in room units; `greenhouseMapInterior.ts` draws the floor,
  authored overlays (same rotation/scale as the DOM stage, checked side by side through the legacy switch), plots, crops,
  tank and the placement preview. Both share `roomMapInterior.ts` with the Manor (timeline player, camera, stick,
  double-tap). `SalonScene` / `GreenhouseScene` `mapRendered` keep the HUD, prompts, the appearance editor and the
  placement pointer surface; chair/door and plot/tank/self/exit taps hit-test through `mapPickRef`. The camera follows
  server-driven walks (chair, planter, tank approach), recenters when the styling editor closes, and lands on the player
  when a reconnect that resumed indoors leaves to the world. The Greenhouse placement tools sit top right (Manor's
  Decorations spot). `DEV_BUILD_SALON` places an active Salon for testing. E2E: `full-app-tests/salonGreenhouseMap.spec.ts`.
- **P5 one interior room catalog**: a single schema based on `dungeonRoomDefinitionSchema`,
  spatial profile `standard_indoor_full` for 260 u/s rooms, and object types `planter`,
  `water_tank`, `station`, `decoration_surface`, `salon_mirror`.

## Interior parity (2026-10-20)

- Every indoor player draws the Jacket B rig. Map-rendered rooms get it from the overlay; the legacy
  `IndoorPlayerLayer` (manor, salon, greenhouse, legacy dungeon switch) attaches a `createJacketRig` per actor and
  hides the drawn body once the rig is ready, until P4 moves those rooms onto the map.
- Map-rendered interiors mount the overworld joystick (keys, stick, pad) and the off-screen player indicator with the
  same prefs, walking at 125 m/s. Dash and the touch attack button stay world-only (server commands).
- Manor, salon and greenhouse (still DOM scenes) mount the same stick, keys and pad; the stick target is clamped to the
  room's walkable navigation (`movement/indoorJoystickTarget.ts`) so the server never rejects it. Swing and dash stay off there.
- The camera follows the player in map-rendered rooms (proven in the Drowned City, interiorParityB spec). Interiors keep
  the overworld music.
