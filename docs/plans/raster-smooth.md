# Raster smooth: background-map micro-stutter during the joystick follow

Branch `feature/raster-smooth--from-t1540`. Not deployed.

## Mechanism (MapLibre 5.24.0, `apps/client/node_modules/maplibre-gl/dist/maplibre-gl-dev.js`)

- The follow moves the camera with `panBy(..., {duration: 0})` and the combat zoom with `jumpTo` (`playerFollowController.ts`). A
  zero-duration `easeTo` runs `_prepareEase` (`_moving = true`, line 69531) and `_afterEase` (`_moving = false`, line 69679) in the same
  call, so `isMoving()` is false when the frame renders.
- `Map._render` passes `moving: this.isMoving()` to `painter.render` (line 73839), which stores it as `painter.options`.
- The raster pass: `drawTiles` (line 64595) `const align = !painter.options.moving` then
  `transform.getProjectionData({ overscaledTileID, aligned: align, ... })` (line 64627). Hillshade (64399) and color-relief (64496) do
  the same. No other layer type reads `aligned`: fill, line, symbol, circle, heatmap, background and fill-extrusion never align.
- `MercatorTransform.getProjectionData` (line 56501) -> `calculatePosMatrix(tileID, aligned)` (56323) uses `_alignedProjMatrix`, built at
  lines 56452-56461 by rounding the camera x/y to whole CSS pixels (`x - Math.round(x)`), so raster tiles jump in whole pixels while the
  camera moves in sub-pixel steps. A finger drag keeps `_moving` true, so it is unaligned and smooth.
- JS telemetry could not see this: it compares `map.project()` anchors, not the matrix the raster is drawn with.

Confirmed on the prod build: the drawn tile corner minus its true projection stays constant to 0.00004 px unaligned, and saws over 0.996 px
with stock MapLibre (spec `rasterSmooth`).

## Fix

`map/rasterAlignment.ts`, installed from `createMap.ts`: wraps `painter.render` and overrides `options.moving` for that frame only. We
never change `map.isMoving()` or `_moving` (it also gates image throttling and idle logic). Version guard: only MapLibre 5.x with a
`render` function on the painter; otherwise left stock and reported as `rasterAlignPatch: "unsupported"`.

Switch `ash-atlas:raster-alignment` (localStorage; Developer tools toggles "Raster alignment: stock MapLibre" and "Raster alignment: never"):

| mode | behaviour |
| --- | --- |
| `auto` (default) | unaligned when MapLibre says moving, when the camera changed within 250 ms, or at any fractional zoom; aligned only for a settled camera at an integer zoom |
| `off` | never aligned |
| `on` | stock MapLibre |

Why not a patch or a `getProjectionData` wrapper: the painter wrapper is 30 lines, needs no pnpm patch to maintain, and survives the
transform being swapped between globe and mercator. Alignment at rest buys no crispness at the fractional zoom the game uses (ground-scale
camera), and turning it on at rest causes a settle snap of up to half a CSS pixel, so `auto` is in practice unaligned everywhere in play.

## Follow-only overhead

Every zero-duration pan fires `moveend` -> `endViewportInteraction("move")` returns `inactive` -> `refreshOverlay()` ->
`markAllStaticLayersDirty()`, a full static redraw every frame (a drag freezes the statics instead).

Switch `ash-atlas:static-follow` (`freeze` default, `off` = old behaviour; toggle "Rebuild overlay every follow frame"):

- `App.tsx` `endViewportInteraction` calls the new `overlay.markFollowTransformDirty()` instead of `refreshOverlay()` for that branch.
- `pixiOverlay.ts` keeps the drawn static layers and translates `staticLayer`/`kingdomSeatLayer` by the camera drift. A full redraw happens
  on a data change (dirty flag), after 64 px of drift, after 250 ms, on any zoom/scale/rotation change, 160 ms after the last follow move
  (settle), before a drag or programmatic freeze, on flag travel, and on destroy.
- Culling uses a 64 px margin (`StaticOverlayProjection.padPx`) so edge entities do not pop in.
- Hit tests: every static `pick*At` (all but player and combat entity) first ends the translation with one synchronous redraw, so flag,
  building and collectible hit boxes match what is on screen. (This differs from a shared pick-point transform; it is simpler and exact.
  There is no full-app test that taps a flag mid-walk.)
- Not done: `handleMoveEnd` still runs `schedulePresentationPersist` and `applyCameraZoomLimits` per move (debounced / no-op).
- `MapZoomIndicator` only sets state when the zoom value changed.

Prod build, headless, walking: static redraws about 2 per second (was one per frame), `gameAppRendersPerSec` about 5.

## Other switches

- `ash-atlas:camera-snap=device` (default off; "Snap camera to device pixels"): the follow pan is rounded to whole device pixels with a
  carried residual (`followSwitches.ts`), skipped during the zoom animation.
- `ash-atlas:overlay-walk=hidden` (default off, diagnostic; "Hide overlay while walking"): while the follow moves the camera the Pixi overlay
  skips its draws and render and its canvas is `visibility: hidden`; it is restored on the first frame without follow motion.

All switches are read live: none needs an app restart.

## Telemetry (motionReport)

Added: `maplibreVersion`, `rasterAlignMode`, `rasterAlignPatch`, `rasterRenders`, `rasterMaplibreMovingRenders`, `rasterAlignedRenders`,
`rasterUnalignedRenders`, `rasterLastRenderMoving`, `rasterLastRenderAligned`, `cameraMinZoom`, `cameraMaxZoom`, `staticFollow`,
`cameraSnap`, `overlayWalk`, `staticOverlayRedraws`, `staticOverlayRedrawsPerSec`, `maxStaticOverlayDrawMs`,
`dynamicOverlayUpdateMsPerFrame`, `pixiRenderCallMsPerFrame`, `gameAppRendersPerSec`, `eventLoopLagMs`.

## Tests

- Unit: `rasterAlignment.test.ts`, `followSwitches.test.ts`.
- Full app (prod build): `full-app-tests/rasterSmooth.spec.ts` (drawn raster position, stock vs fixed, telemetry keys, redraw rate, other
  switches, drag, wheel zoom); `playerCamera`, `crispSmooth` and `mapShake` pass. Interiors are not covered by a spec.
- Known baselines: client `tsc` errors in `App.tsx` (NodeListOf iterator) and `inventoryPanelModel.test.ts`; `App.runtimeLifecycle.test.tsx`
  (36) and `spritePresentation.test.ts` fail on the base too. `mapShake` can flake on the MapLibre `getImage` startup race.
