# Jacket B gathering + flag-building animations (2026-10-20)

Branch `feature/player-gather-anims--from-t1551` (worktree `player-gather-anims__t1551`), from test/t1551.

Owner: "make animations, using our character and program, for chopping, harvesting, mining, etc, with current in
game tools ... use our new system and make them better." Flag: "it should kinda build flag but not set down until
ready. Like final animation 1 s before flag is actually built."

## Found code paths

| What | Where |
| --- | --- |
| Jacket B sheet player (idle / walk L,R / turned stand) | `apps/client/src/players/jacketRig.ts`, wired in `apps/client/src/map/pixiOverlay.ts` (~3471: `jacketRig.update`, hides `playerRenderer.visualRoot` once ready) |
| Sheet build | `scripts/copy-jacket-rig.mjs` (rigs from turnfront branch, `animator render`, trim/dedupe/pack, `jacketb-sheets.json`) |
| Rigs | `packages/animator/rigs/jacketb/front-turn15-faceA{,-mirin}.anim.json` (template7 skeleton, separate arm slots: `upper_arm/forearm/hand` + jacket sleeves; arm limits upper -15..105, fold 0..70) |
| What is shown while gathering | `apps/client/src/players/gatheringPresentation.ts` (`localGatheringPresentation`, `remoteGatheringPresentation`, `applyPlayerGathering`; side = `gatherSideForTarget`, locked per action) |
| Procedural gather motion, timing, impacts | `packages/player-renderer/src/gatherAnimation.ts` (`GATHER_PROGRAMS`), `renderer.ts` `updateGather` (impact = `impactsBetween(program, cadence, lastElapsed, elapsed)` on `nowMs - startedAtMs`; increments `gatherImpactCount`, spawns particles in `root` (still visible under the jacket rig)) |
| Target reaction (tree shake etc.) | `pixiOverlay.ts` reads `gatherImpactCount` -> `gatherTargetReactions.trigger` |
| Flag build | `packages/player-renderer/src/flagBuildAnimation.ts` (`FLAG_BUILD_PROGRAM`), client countdown `apps/client/src/flags/flagBuildCountdown.ts` (`localDeadline`, `durationMs`), state in `App.tsx` `flagBuild` (set on `FLAG_BUILD_STARTED`, cleared on complete / `FLAG_BUILD_CANCELLED`), server `FLAG_BUILD_DURATION_MS` default 10 000 |
| Tool art | `packages/player-renderer/src/assets/player-appearance/tools/{wooden,stone}-{axe,pickaxe}.png`, `starter-fishing-pole.png` (1024 px canvas, handle vertical, head up, grip at 0.496/0.648; pole grip 0.4966/0.5098) |
| Flag art | Soft Flag pieces via `flagBuildArtFromTextures` (`gatheringPresentation.ts`): pole hardware + tinted cloth |

## Timings (the impacts the clips must hit)

Clips are 30 fps; frame k shows from k/30 s. The client samples the clip on the same clock the renderer counts
impacts on (`nowMs - startedAtMs`), so a contact frame placed on the impact time lands with the particles and the
node shake.

| Program | Cycle | Impact | Jacket clip | Frames | Contact frame |
| --- | --- | --- | --- | --- | --- |
| chop (axe) | 1000 ms | 0.555 (555 ms) | `chop` | 30 | f16 (533-567 ms) |
| chop_hand (no axe) | 900 ms | 0.6 | `chop`, time-warped | - | contact warped onto 540 ms |
| mine (pickaxe) | 1300 ms | 0.64 (832 ms) | `mine` | 39 | f24 (800-833 ms) |
| mine_hand | 900 ms | 0.66 | `mine`, time-warped | - | contact warped onto 594 ms |
| harvest | 1100 ms | 0.43 (473 ms) | `harvest` | 33 | f14 (467-500 ms) |
| fish cast | 900 ms | none (line at 0.5) | `fish_cast` then `fish_hold` | 27 + loop | flick f13-14 |
| flag build | 1100 ms | 0.555 (610 ms) | `flag_work` loop | 33 | f18 (600-633 ms) |
| flag plant | last 1000 ms of the build | plant | `flag_plant` | 30 | ram f22, then hold |

Time warp: one piecewise-linear map from program phase to clip phase that sends the program's impact fraction to the
clip's contact fraction, so the same clip also serves the bare-hand programs and the reduced-motion cadence (x1.5).

## Design

1. **Clips** on the Jacket B turned rigs (L15, and the mirrored-input R rig drawn image-flipped like the walk).
   Authored by `packages/animator/scripts/views/gather-clips-jacketb.ts` with the five-anims / sword-chop builder
   pattern (world-angle arm solver, pose limits). Rig constraint: arms cannot cross the body (upper arm -15 deg), so
   tool swings are one-handed on the facing (far) arm with the near arm bracing/counter-swinging; the overhead raise
   is the turned sword chop's raise (stiff elbow, wrist turns the tool).
   - `chop`: wind-up over the shoulder (anticipation, body drawn back), whip into the trunk at the side, recoil
     (squash, small lean in), recover.
   - `mine`: higher overhead raise, heavier downward strike to rock height, bounce back.
   - `harvest`: lean and reach down/out to the plant, grab, quick pluck tug back to the chest, drop to the pouch.
   - `fish_cast` (rod back, flick) and `fish_hold` (rod out, slow breath; bite/fight jitter added on the rod in the
     client).
   - `flag_work`: crouched, the flag held low and slanted (not planted), the near hand works the base (tamping beat).
   - `flag_plant`: rise, lift the flag upright, ram it into the ground, let go, settle.
2. **Tools are not baked.** Each body clip renders once per facing with empty/gripping hands. The build exports per
   frame the tool transform from the far hand bone (grip point px in the frame, tool angle, front/back draw order) to
   the sheet manifest. In game the current tool texture (the renderer's loaded `gatherToolTexture`, flag art for
   the flag) is a Sprite in the rig container, positioned per frame. Draw order per frame = weapon_under/over.
3. **Facing** follows the gather side the overlay already locks per action (`rendered.gathering.side`).
4. **Flag**: `flag_work` loops while `remaining > 1000 ms`; when `remaining <= 1000 ms` `flag_plant` plays from
   `1000 - remaining`; the flag is only placed at completion (the existing server/client flow). Cancel -> the
   presentation goes null -> idle/walk.
5. **Size**: separate gather sheets (`apps/client/src/assets/player-rig/jacketb-gather/`), loaded lazily per clip
   and facing the first time that action plays (so a player who never fishes never pays for it). Frame holds: every
   2nd pose held 2 frames (15 fps) except around contact; fish hold every 4th.

## Evidence

`docs/plans/player-gather-anims/`: per clip, a GIF and a contact sheet with the tool attached, at 0.4 and 0.471.

## Status (2026-10-20, after review)

- Chop: level strike at chest height into the trunk, the axe head drawn over the hair at the wind-up peak, lean and
  step into the hit. Mine: deeper lean into the strike. Flag plant: lift high (upright), drive down with a dip,
  let go, the pole stays planted beside him.
- Impacts: chips / leaves / flag dust spawn at the clip's tool head, hand or flag base
  (`PlayerRenderer.setGatherImpactOrigin`, `FlagBuildRig.spawnImpact(sign, at)`).
- Timing: `apps/client/src/players/jacketGather.test.ts` pins every program's impact (tool, bare hand, reduced
  motion, flag work, flag plant) to the clip's contact frame.
- Size: gather sheets are 8-bit palette PNGs (libimagequant via sharp, dithered; checked on crops at 2x): 5.6 MB on
  disk (was 21.6 MB). GPU: 114.6 MB if every clip and side were resident; loaded lazily, one clip + side is 4-9 MB
  (+1/3 mipmaps).
- In game: `ingame/` - the developer gathering preview (UI Standards > Gathering animations) now shows the Jacket B
  rig on its plain-body columns with the real renderer, tool textures, flag art and particles
  (`preview-real-pipeline.png`, `preview-all-rows.png`); world captures of a real chop and a real Elder Fern gather
  (`world-chop-tree.png`, `world-harvest-elder-fern.png`, headless at default zoom, small).

## Smooth + crisp pass (2026-10-20, branch `feature/player-gather-smooth--from-t1552`)

Owner: gather animations "very stuttery, not smooth like the 30 fps"; walk/idle "laggy ... stutters at some points";
"at zoom the player looks a bit blurry"; picking must end the moment the sap / berries are gone.

- **Stutter root cause:** pose holds baked into the sheets. Gather clips held every 2nd pose (15 fps outside contact,
  fish hold every 4th) and the turned standing every 4th (7.5 fps). Frame log (feature runtime, per rendered frame):
  chop 20.8 unique poses/s with 3-4 x 60 Hz holds -> 32.5/s with 2 x 60 Hz holds; turned standing 8 x 60 Hz holds ->
  2. Walk was already 30 fps. Now every clip ships all 30 fps poses (`hold: 1`).
- **Hitches:** sheet pages now upload to the GPU one per frame as soon as they load (`players/playerSheetUpload.ts`)
  instead of on the frame a clip first draws a page (a 2048 px page + mipmaps mid-walk/breath/gather start); a walk
  that resumes within 300 ms keeps its stride phase (no snap to frame 0 on a walk-detector flicker); the walk rate is
  low-passed (0.25 s).
- **Blur:** sheets rendered at 0.34 drew 1.235 device px per sheet px at max zoom on DPR 3 (upscale). Body and gather
  sheets now render at 0.42 = 1.002 device px per sheet px. Renderer resolution is already full DPR (up to 3).
- **Picking end:** `localGatheringPresentation` returns null for `harvest` once the task is `completing` (the timer
  ended; berries are hidden then) or the tree's produce is gone; chop and mine unchanged.
- **Size:** body sheets 18.0 -> 9.0 MB (now 8-bit too), gather 5.7 -> 13 MB; total 23.7 -> 22 MB on disk. GPU: body
  (eager) ~69 -> 171.7 MB RGBA (+1/3 mipmaps); gather all-resident 114.6 -> 268.2 MB, but lazy: one clip + side
  ~9-19 MB (was 4-9).
- Evidence: `player-gather-anims/smooth/` (frame logs before/after + `frame-analysis.txt`, DPR 3 max-zoom crops,
  berry harvest end screenshots).
