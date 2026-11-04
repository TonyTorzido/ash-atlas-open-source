# Crisp rendering and smooth walking

Owner complaint (iPhone): the world looked soft and walking "stutters the world and isn't super smooth".

## Culprits

Commits that made the picture soft or the motion uneven: a96ea96a7, 141e080b7, 7b635fdec, 5d39e0e29. Between them they capped the
map and overlay at min(2, DPR), turned antialiasing off and shipped 512 px sprite derivatives, and let the follow camera, the
MapLibre render and the Pixi sprites run on separate rAF callbacks.

## Fixes

1. Blur (e850fe2f5): full device pixel ratio, antialiasing on and 1024 px sprite derivatives by default. The old caps are a
   Low quality mode, switched by a developer toggle or by the low-FPS governor (src/perf/renderQualityGovernor.ts); never on Apple.
2. One tick (a8d009424): the follow camera runs inside the overlay frame, the map renders synchronously when the camera moved
   (MapLibre's own `_frameRequest` is aborted), then the sprites draw. The dev-tools zoom readout no longer re-renders React on moveend.
3. Frame clock: the overlay frame now uses the requestAnimationFrame timestamp (`takeFrameTiming(frameTimeMs)`), not
   `performance.now()` at callback time. Callback time jitters by several ms under load, which showed as 2:1 camera step
   ratios between neighbouring frames. Also makes the clock 120 Hz friendly.
4. Camera catch-up: the follow blend is done on speeds (px/ms), not distances, so one long frame no longer overshoots on the next short one.
5. React: mid-walk player delta commits (about 3/s from the batched `players` + `lastSnapshotAt` updates) are wrapped in
   `startTransition`, so taps, joystick and the map frame win over them. The map itself reads the render timeline, not React state.
6. Drag stops the follow (mouse, pen and one-finger touch). Cause: MapLibre never delivered `dragstart` while the follow moved the camera every frame (each programmatic
   move resets its drag handler), and the overlay frame that would have noticed the gesture pauses during a drag, so the follow
   kept running. `PlayerFollowController` now listens to pointer events on the map container itself (mouse or pen moved more than
   4 px with a button down stops the follow); one finger that starts on the map and moves more than 6 px does the same. While any pointer is down on the map the follow holds the camera still (a programmatic move would reset MapLibre's drag handler), and a tap just resumes it. A second finger is a pinch and never counts as a drag. Joystick, attack button and HUD controls are outside the map container, so their fingers never reach these listeners.

## Measurements

Production build served through a small static + proxy server in front of the feature runtime, headless Chromium with GPU, iPhone
viewport 393x852, DPR 3, 4 s walk. "Before" is master with only the frame probe added. Camera and sprite speeds are per display
frame (spec rAF timestamps), taken only while the player is actually moving.

| Metric | Before 1x | After 1x | Before 4x | After 4x |
| --- | --- | --- | --- | --- |
| FPS | 60 | 60 | 59.5 | 58.5 |
| Frames over 20 ms | 0 | 0 | 2 | 6 (earlier run: 1) |
| Camera speed CV | 0.07 | 0.05 | 0.23 | 0.25 |
| Sprite ground speed CV | 0.10 | 0.03 | 0.22 | 0.25 |
| Sprite screen step p95 (px) | 0.13 | 0.01 | 0.39 | 0.26 |
| Layer mismatch (px) | 0 | 0 | 0 | 0 |
| GameApp renders per second | 9.5 | 8.75 | 8.75 | 9 |

Reading it: at 1x the sprite is steadier. At 4x CPU the results are within run-to-run noise; the headless run does not reproduce
the iPhone stutter strongly, and layer mismatch is 0 in both because Chromium orders rAF callbacks deterministically (Safari may not).
The 120 Hz case was not emulated. GameApp still renders about 9 times per second while walking (3/s `players`, the rest
unwatched state), so a render-cost reduction in App.tsx is the next lever.

## Low mode

`ash-atlas` render quality Low = min(2, DPR) canvases, antialias off, 512 px sprite derivatives. Set it in Developer tools, or the
governor switches it at the next launch when the frame rate stays low. Apple devices are never switched.

## Tests

`apps/client/full-app-tests/crispSmooth.spec.ts` (run against a production build; the dev server is too slow for the frame
thresholds), `playerCamera.spec.ts`, `musicLoop.spec.ts`; unit tests in src/perf, src/map.
