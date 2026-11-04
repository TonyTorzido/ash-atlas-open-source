# Map shake while walking (iPhone)

Owner report after t1535 (crisp-smooth): on the iPhone app the background map shakes while the character walks, worse than
before. Headless Chromium stays smooth, so this adds on-device telemetry and fixes the likely causes behind runtime switches.

## Suspected causes (ranked)

1. **Mixed clocks on the stateful prediction.** `PlayerRenderTimeline.renderPosition` keeps the furthest time it was asked
   for. Since t1535 the overlay and camera ask at the rAF timestamp, while the joystick (`getJoystickWorldState`), the
   off-screen badge, the aim indicator, the follow's poll and PLAYER_DELTA ingest asked at `performance.now()`. On iOS touch
   events and socket messages run between the frame's timestamp and its callbacks, so the frame often rendered the event's
   moment instead of its own: uneven per-frame steps that the feed-forward camera copies into the map. Fix: those reads use
   `frameClockNow()` (map/frameClock.ts). The report counts reads behind the clock (`clockBehindReads`).
2. **The camera copies prediction jitter.** The follow feeds the rendered player's per-frame move straight into the pan. Server
   snaps, lead-cap pull-backs (dead-reckoned authority jumps with network jitter) and correction blends reach the map 1:1 while
   the sprite stays centred. Fix: the camera follows `CameraTargetFilter` (low-pass with velocity feed-forward, acceleration
   limited velocity estimate, fixed 4 ms sub-steps, no step backwards along the movement axis) and the pan itself never goes
   backwards along that axis while movement input is held. The hard on-screen limit still uses the real player point.
3. **Map renders not owned by one loop.** MapLibre's own rAF can be queued ahead of the overlay's (any triggerRepaint during a
   frame), rendering the old camera first: two map renders in one frame at 3x DPR, or the ground a frame behind on WebKit's
   callback order. Fix: while the overlay frame drives the camera, `map.triggerRepaint` is held and the overlay renders the map
   once per frame; released when the camera stops.
4. **Frame pacing (120 Hz ProMotion, dropped frames).** The follow already blends speeds; the filter uses fixed sub-steps and
   spreads the raw point over a long frame, so 60/90/120 Hz and drops give the same curve (unit tested).
5. **Snapping.** Checked: map and sprites are both unsnapped and projected through the same transform after the camera moves;
   only text labels round. No mismatch source, no change.
6. **3x DPR cost.** Possible frame drops; A/B with the existing Low graphics quality switch. The report carries DPR, canvas
   backing sizes, frame distribution and long tasks.

## Switches (localStorage, Developer tools, apply at once)

There is no server-pushed client config, so these are per-device localStorage switches with Developer tools toggles:

- Standalone camera loop: `ash-atlas:camera-driver` = `standalone` (default in-overlay driver).
- Unfiltered camera target: `ash-atlas:camera-filter` = `off` (default filtered).
- Low graphics quality (existing): `ash-atlas:render-quality` = `low` (restart to apply).

Specs and support can also set `window.__ASH_ATLAS_CAMERA_MODES__.driver` / `.filter`.

## Motion report

After 3 s of walking the client samples about 5 s of frames once per session, plus up to two jitter-triggered samples (pan
direction flips or long frames), and posts to `POST /api/diagnostics/motion`. The server logs `client motion report`:

    journalctl -u <game service> --since "1 hour ago" | grep "client motion report"

Keys: frame p50/p95/max, frames over 20/34 ms, refreshHz, camera step mean/CV/reversals/back steps, player offset p95/max/
reversals, moving frames with 0/1/2+ map renders, layer mismatch frames/max, corrections (count/max/mean m), snaps,
lead-cap frames, reads behind the prediction clock, long tasks, DPR, map/overlay backing sizes, GPU, driver, filter, quality.

## Tests

Unit: `src/map/cameraTargetFilter.test.ts`, `src/map/playerFollow.test.ts` (jittery walk at 60/120 Hz, ProMotion pacing and
dropped frames: zero reversals), `src/perf/motionReport.test.ts`, server `clientMotionReportRoutes.test.ts`.
Full app: `full-app-tests/mapShake.spec.ts` (simulated network plus injected server snaps, zero camera reversals, report posted).
