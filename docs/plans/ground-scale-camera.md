# Ground-scale camera: same on-screen size at every latitude

**Owner goal:** a 500 m circle, a player and a mob must look the same size anywhere in the world. That means at the equator, in ABQ, in Reykjavík, in Svalbard, and at the 85° world edge alike.

**Decision (research, 2026-10-12):**
- Use a latitude zoom offset on the Web Mercator camera: `cameraZoom = groundZoom − log2(1/cos lat)`.
- MapLibre globe projection does not help. Version 5.24 is Mercator above zoom 12, and its vertical-perspective mode scales the sphere by 1/cos(lat) on purpose.
- A custom projection is too costly on phones.

## Why things grow toward the poles today

At camera zoom 15, Web Mercator metres-per-pixel is `78271.5·cos(lat)/2^z`.

| latitude | m/px | 500 m circle radius | player sprite |
|---|---|---|---|
| 0° | 2.39 | 209 px | 28 px |
| 35° (ABQ) | 1.96 | 256 px | 32 px |
| 60° | 1.19 | 419 px | 46 px |
| 75° | 0.62 | 808 px | 86 px |
| 85° | 0.21 | 2401 px | 156 px |

- **Sprites:** commit d60d95507 added `apps/client/src/map/groundScaleZoom.ts`. It sets `groundZoom = cameraZoom + log2(1/max(0.01, cos lat))`, and the overlay sizes sprites from that value at ~25 sites in pixiOverlay.ts.
- **What's missing:** the MapLibre camera zoom was deliberately left raw (see the groundScaleZoom.ts header). So sprites match the ground, but the ground itself is magnified up to 11×.
- **Circles:** metre circles are geodesic (`screenRadiusForMeters`), and action-combat math is metre-based. Both become uniform for free once the camera is offset.
- **Already in t1500:** the Antarctica fix (f584672ed + follow-up) added `MAP_MAX_LATITUDE`, `clampMapLatitude`, `safeCosLatitude` and `polarFramingZoom` to groundScaleZoom.ts, plus a latitude-aware `gameplayMapRecenterTargetZoom` in globeCamera.ts. This work generalises that. Replace the polar-relief special case with the full ground-zoom camera; don't stack the two.

## Residual error (acceptable)

At ground zoom 15 on a phone screen, the top and bottom of the screen differ in scale by:

| latitude | difference |
|---|---|
| 60° | 0.055% |
| 75° | 0.12% |
| 85° | 0.36% |

The camera zoom needed for the default framing (ground zoom 15):

| latitude | camera zoom |
|---|---|
| 0° | 15.00 |
| 45° | 14.50 |
| 60° | 14.00 |
| 70° | 13.45 |
| 75° | 13.05 |
| 80° | 12.47 |
| 85° | 11.48 |

## Poles

The server already clamps players to ±85° (`WORLD_EDGE_MAX_ABS_LATITUDE`, packages/shared/src/geo.ts:19). No blocking is needed.

## Projection band

`createMap.ts` uses `projection: {type: "globe"}`, which blends vertical-perspective into mercator between camera zoom 11 and 12. The 80–85° default framing (camera ~11.5–12.5) would sit inside that blend.

Replace it with an explicit expression:

```
["interpolate", ["linear"], ["zoom"], 9, "vertical-perspective", 10, "mercator"]
```

Gameplay zooms then render pure Mercator. The globe band (camera 4–8) is unchanged. If the expression misbehaves, fall back to 8→9.

## Phases

**Phase 1: camera maths and map config**
- New `apps/client/src/map/groundScaleCamera.ts`, providing:
  - `cameraZoomForGroundZoom(groundZoom, lat)`
  - `groundZoomForCameraZoom` (re-export the inverse)
  - `cameraZoomLimits(lat) → {minZoom, maxZoom}`, mapping ground limits MIN 2 and MAX 18 to camera values, with the floor at −2
  - `GROUND_ZOOM_DRIFT_EPSILON = 0.01`
  - all of it safe for NaN input and clamped to ±85°
- `createMap.ts`:
  - set the explicit projection expression
  - convert the initial zoom and min/max using the initial centre latitude
- Unit tests: round trip at 0/45/60/70/80/85/90°, clamps, NaN. Update createMap.test.ts.

**Phase 2: App.tsx zoom boundary and overlay thresholds**
- Every zoom passed to MapLibre (jumpTo/easeTo/flyTo/setZoom/setMinZoom/setMaxZoom) speaks ground zoom and converts at the boundary. That includes:
  - recenter (`gameplayMapRecenterTargetZoom`)
  - `smoothlyResetMapZoom`
  - travel arrival, dev teleport and manor exit
  - the phone default zoom preference (`mobileZoomPreference.ts`, which keeps ground semantics; no migration)
  - the zoom indicator
- `pixiOverlay.ts`: `WIDE_ZOOM_LOD_BELOW` and the detail-fade thresholds use `mapGroundScaleZoom(map)`, not the raw `getZoom()`.
- Re-apply the min/max limits on `moveend` when the latitude offset changed by more than the epsilon.
- Grep every remaining raw `map.getZoom()` threshold and convert those that are gameplay thresholds. The standalone World Map (0–5) stays raw, and interiors stay raw (they render around 0,0).

**Phase 3: keep the ground zoom while moving**
- Add a `desiredGroundZoom` ref, set from user zoom gestures (non-programmatic `zoomend`).
- After any programmatic centre change (recenter, travel, teleport, joystick follow, R3 lock), jump to `cameraZoomForGroundZoom(desired, lat)`.
- Idle drift correction runs at most once per second, only when no gesture is active. Gate it on the existing gesture-ownership flags (`mapDragRenderOwnership` and the programmatic-move generation), so it never fights a pinch.

**Phase 4: measure, then deploy**
- Run a headless Playwright full-app check, extending `apps/client/full-app-tests/actionCombat.spec.ts` or adding a sibling spec. On both phone and desktop layouts:
  - dev-teleport to 0°, 35°, 45°, 70°, 80° and 85° (north, and south where possible) and recenter
  - measure the pixel radius of the gameplay view circle (500 m-type metre circle) via `screenRadiusForMeters`, and the local player sprite height
  - both must be within 1% of the 0° values
  - `map.getZoom()` must equal `cameraZoomForGroundZoom(15, lat)` ±0.01
  - recenter and zoom-out must still work at 85°
  - save screenshots
- Re-run the full actionCombat spec.
- Update `docs/build-bible/WORLD_PRESENTATION_AND_GAME_PNG.md` (the camera is now offset, and the projection band moved).
- Deploy to production. The owner has pre-approved this and will test on their phone at work.

## Risks

1. The projection blend band. Visually check the 85° framing.
2. The stored phone zoom preference gets re-interpreted (≤0.3 zoom at ABQ). Acceptable.
3. A programmatic zoom during a pinch. Gate it on gesture ownership.
4. Raw `getZoom()` thresholds left over would make behaviour depend on latitude. Grep after Phase 2.
5. Poleward of 82.8°, the default framing loses water squares (minzoom 12) and uses coarser OSM raster. That only affects the ice, and is already documented.
6. The idle drift correction undoes any programmatic gameplay-map zoom that does not update the desired ground zoom.
   Pre-deploy audit (2026-10-12): every gameplay-map `jumpTo`/`easeTo`/`flyTo` with a zoom goes through
   `cameraZoomForTrackedMove` or `holdGroundZoomCameraZoom`; interiors and map-rendered dungeons are excluded; the World
   Map and Creature Book are separate MapLibre instances. The correction now compares against the zoom the camera limits
   allow, so a desired zoom below the polar camera floor no longer fires a no-op jump every second. E2E code that sets a
   zoom on purpose passes an `originalEvent` so it counts as a user zoom.
