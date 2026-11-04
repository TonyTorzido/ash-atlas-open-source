# G0 Performance Audit

## Current branch
- Branch: `g0-performance-audit`
- Commit audited: `c0ae7cc`

## Symptoms being investigated
- Short freeze or hitch on initial load.
- Zooming in/out feels uncomfortable or laggy.
- Movement and camera follow should feel smoother.
- Pixi overlay and MapLibre interaction may be competing for frame time.

## Findings

### 1. Full Pixi overlay rebuild every animation frame
- Severity: high
- Files: `apps/client/src/map/pixiOverlay.ts`
- What likely causes lag: `drawFrame` runs every RAF and calls `draw`, which clears every layer with `removeChildren`, rebuilds movement leash geometry, rebuilds all owner territories, rebuilds all flag center graphics, recomputes hit boxes, and recreates the player sprite.
- Why it matters: territory union, geodesic circle creation, MapLibre projection, Pixi `Graphics` allocation, and garbage collection all happen during the frame budget, even when flags and map transform have not changed.
- How to confirm: open Chrome Performance, zoom/pan with several flags, and look for repeated `draw`, `polygonClipping.union`, `createGeodesicCircleScreenPoints`, `new Graphics`, and GC activity on every frame.
- Recommended fix: split the overlay into static territory/flag layers and a dynamic player layer. Redraw static layers only when flags, selected flag, claim radius, map transform, or viewport size changes. Keep the player layer on RAF for interpolation.
- Risk level: medium, because hit testing and selected-flag visuals must stay in sync with the cached graphics.

### 2. Territory union and geodesic circles are recomputed on every frame
- Severity: high
- Files: `apps/client/src/map/pixiOverlay.ts`
- What likely causes lag: every frame groups flags by owner, creates 96-point geodesic circles for each flag, projects every point, then runs `polygonClipping.union`.
- Why it matters: polygon union gets expensive quickly as flags grow. It is also especially bad during zoom/pan because projection changes while MapLibre is already doing tile work.
- How to confirm: create 10-30 flags, run a browser profile, and compare frame time before/after commenting out territory rendering.
- Recommended fix: cache unprojected geodesic rings by `flag.id + claimRadiusM`; cache owner group membership by flag list revision; only rerun union when flags change. During map movement, reproject cached geographic rings or temporarily render simpler circles until idle.
- Risk level: medium-high, because cached geometry needs careful invalidation when flags are deleted/cleared or claim radius changes.

### 3. React state updates during zoom and MapLibre render can add jank
- Severity: medium
- Files: `apps/client/src/App.tsx`, `apps/client/src/ui/DebugPanel.tsx`
- What likely causes lag: `map.on("zoom", () => setZoom(map.getZoom()))` can update React at high frequency during wheel/trackpad zoom. The `zoom` state is also included in the overlay update effect dependency list, so zoom can trigger React work and overlay updates while the Pixi RAF is already drawing.
- Why it matters: React rendering the debug panel is small, but doing it during every zoom frame competes with MapLibre tile/render work and Pixi drawing.
- How to confirm: add a counter around the zoom handler or use React DevTools Profiler while zooming.
- Recommended fix: store raw zoom in a ref for Pixi, throttle debug-panel zoom state to 4-10 Hz, and remove `zoom` from the overlay-update effect unless render state actually changed.
- Risk level: low, because this mostly affects telemetry/debug UI.

### 4. Camera follow may issue frequent `easeTo` calls while snapshots arrive
- Severity: medium
- Files: `apps/client/src/App.tsx`, `apps/server/src/index.ts`
- What likely causes lag: server broadcasts snapshots at `SERVER_TICK_HZ`; every player snapshot updates React state. The follow effect can call `easeTo` every 180 ms while the local player object changes, even if the camera is already near the player.
- Why it matters: repeated `easeTo` calls can fight user input, interrupt inertial map movement, and make motion feel swimmy.
- How to confirm: log `easeTo` calls while moving and zooming, or profile MapLibre camera updates during movement.
- Recommended fix: gate camera follow by screen distance from center, skip `easeTo` if the player is already within a small pixel threshold, and suspend follow while zooming/dragging until `moveend`/`zoomend`.
- Risk level: medium, because camera feel is subjective and affects core play.

### 5. Player snapshot broadcast rate drives React and network churn
- Severity: medium
- Files: `apps/server/src/index.ts`, `apps/client/src/App.tsx`, `apps/server/src/game/state.ts`
- What likely causes lag: every tick broadcasts a full `PLAYER_SNAPSHOT` array to every socket, even when no player moved. The client replaces `players` state on each snapshot, driving React effects and local player lookup.
- Why it matters: the current player count is small, but this creates a constant background update stream and can jitter interpolation if the browser is under load.
- How to confirm: inspect WebSocket message frequency and payload size, then temporarily lower `SERVER_TICK_HZ` and compare CPU/frame smoothness.
- Recommended fix: send snapshots only when a player moved or on a lower fixed network rate, such as 10 Hz, while client interpolation continues at 60 FPS. Consider per-player deltas later.
- Risk level: medium, because movement responsiveness and authoritative correction timing need retesting.

### 6. Pixi `Application` uses `resizeTo` plus full redraw
- Severity: medium
- Files: `apps/client/src/map/pixiOverlay.ts`, `apps/client/src/styles.css`
- What likely causes lag: `resizeTo: container` delegates resizing to Pixi while the app also redraws every RAF. On browser/layout changes, this can create resize/render bursts.
- Why it matters: initial load and hot reload can feel frozen if resize, map load, tile decode, Pixi init, and first full overlay draw happen together.
- How to confirm: profile first load and window resize; look for resize and Pixi renderer work clustered with MapLibre setup.
- Recommended fix: explicitly resize Pixi on throttled `resize`/MapLibre `resize`, draw a minimal first frame, and defer expensive static territory generation until after map `idle` or first flags snapshot.
- Risk level: low-medium.

### 7. Selected flag delete overlay updates React state on every MapLibre render
- Severity: low-medium
- Files: `apps/client/src/App.tsx`
- What likely causes lag: `refreshOverlay` runs on MapLibre `render` and calls `updateSelectedFlagScreenPoint`, which calls `setSelectedFlagScreenPoint` with a new object each time a flag is selected.
- Why it matters: while selected, panning/zooming can trigger frequent React renders just to reposition one button.
- How to confirm: select a flag, pan/zoom, and run React Profiler.
- Recommended fix: use a DOM ref and imperatively update `style.transform` inside a throttled map render callback, or update React state only when rounded pixel coordinates changed.
- Risk level: low.

### 8. Initial load does MapLibre, Pixi, WebSocket, and flag snapshot work together
- Severity: medium
- Files: `apps/client/src/App.tsx`, `apps/client/src/map/createMap.ts`, `apps/server/src/realtime/websocket.ts`
- What likely causes lag: on login, the client creates MapLibre, initializes Pixi, fetches the NM boundary, opens WebSocket, receives flags, and starts the Pixi RAF. If flags exist, first frames immediately perform full territory union/render work.
- Why it matters: this matches the reported "screen sometimes freezes a bit on load."
- How to confirm: profile the first 2 seconds after entering a username with persisted flags present.
- Recommended fix: sequence startup: create map, wait for first map load/idle, show player and flag centers first, defer territory union to the next idle/RAF slice, and lazy-load the boundary overlay.
- Risk level: medium.

### 9. Debug panel "snapshot age" is not live but still tied to snapshots
- Severity: low
- Files: `apps/client/src/App.tsx`, `apps/client/src/ui/DebugPanel.tsx`
- What likely causes lag: `lastSnapshotAgeMs` is recomputed when `players` changes, which is every snapshot. It does not need full React state churn to be useful.
- Why it matters: not a primary lag cause, but a quick win when reducing render noise.
- How to confirm: React Profiler while server ticks are active.
- Recommended fix: throttle debug data updates or hide/disable debug panel in normal play.
- Risk level: low.

### 10. Server flag placement and lookup can block intent responses
- Severity: low-medium
- Files: `apps/server/src/game/flags.ts`, `apps/server/src/http/routes.ts`, `apps/server/src/realtime/websocket.ts`
- What likely causes lag: flag creation does DB count, territory overlap query, world lookup, insert, and then list/broadcast all flags. This is not per-frame, but can feel like a hitch when placing flags.
- Why it matters: a slow world API or DB query can make interactions feel frozen even if rendering is fine.
- How to confirm: log timings around `createForPlayer`, `worldLookup.lookup`, insert, and `listFlags`.
- Recommended fix: add timing logs, keep world lookup timeout low, and after flag creation broadcast `FLAG_CREATED`/`FLAG_DELETED` deltas instead of full `FLAGS_SNAPSHOT` when possible.
- Risk level: low-medium.

## Highest-impact fixes

1. Stop rebuilding static Pixi layers every RAF. Keep only player interpolation on the animation loop.
2. Cache flag geodesic rings and owner territory union results; invalidate only on flag mutations or radius changes.
3. Throttle React debug/zoom updates and remove `zoom` from render-state updates that do not need React.
4. Gate camera follow `easeTo` calls by pixel distance and suspend follow during user zoom/drag until the interaction ends.
5. Lower or event-gate server `PLAYER_SNAPSHOT` broadcasts while preserving client-side interpolation.
6. Defer heavy territory rendering until after MapLibre load/idle and first paint.
7. Move selected-flag delete button positioning to an imperative DOM ref or rounded-pixel throttled update.
8. Add simple render timing instrumentation for Pixi draw cost, territory build cost, and snapshot frequency.
9. Broadcast flag deltas for create/delete instead of full flag snapshots after every mutation.
10. Consider lowering antialias or point counts during active zoom/pan, then restoring full quality on idle.

## Proposed implementation phases

### Phase 1: no-risk quick wins
- Add lightweight `performance.now()` timing logs/counters around Pixi draw, territory build, and camera follow.
- Throttle debug panel zoom/snapshot age updates.
- Skip camera `easeTo` when player is already close to center.
- Stop selected flag overlay from calling React state every map render.
- Remove `zoom` from overlay update effect if render state has not changed.

### Phase 2: render architecture cleanup
- Split Pixi into independently invalidated layers: territory, flag centers, movement leash, selected highlight, player.
- Cache static flag and territory geometry.
- Redraw static layers on flag changes, map move/zoom, resize, and selected flag change rather than every RAF.
- During active zoom/pan, use cheaper temporary geometry and rebuild high-quality merged territory on `moveend`/`zoomend`/`idle`.

### Phase 3: deeper profiling
- Capture Chrome Performance traces for load, zoom, pan, movement, flag create/delete, and refresh with persisted flags.
- Add an optional FPS/frame-time counter in dev mode.
- Measure server snapshot rate, WebSocket payload size, and client snapshot handling cost.
- Decide whether to introduce delta snapshots or a lower network tick rate.

## Phase 1 implementation notes

- Addressed Finding 1 by splitting the Pixi overlay into dirty static layers and a dynamic player layer. Flag centers, territory, selected highlight, and movement leash no longer rebuild on every RAF frame.
- Addressed Finding 2 by caching geodesic flag rings and merged same-owner territory polygons by flag geometry revision. Map pan/zoom now reprojects cached geometry instead of rerunning the same-owner union unless flags changed.
- Addressed Finding 3 by throttling React zoom/debug telemetry and removing zoom from the overlay state effect dependency list.
- Addressed Finding 4 by gating camera follow `easeTo` calls with follow state, drag/zoom interaction state, a 60px screen-distance threshold, and a 300ms minimum interval. Explicit Recenter and teleport still center immediately.
- Addressed Finding 7 by only updating selected flag delete-button React state when the rounded projected position changes by at least 1px.
- Addressed Finding 18 by explicitly removing MapLibre event listeners during cleanup and keeping a single Pixi RAF loop that is canceled on destroy.
- Deferred snapshot broadcast changes from Finding 5 to Phase 2 because network tick behavior is gameplay-adjacent and should be profiled before changing.
- Deferred first-load sequencing and boundary lazy-loading from Finding 8 to Phase 2 because they need browser profiling to avoid optimizing the wrong startup work.
- Manual QA was not run during this pass.

## Things not to change

- No `world-pipeline` changes.
- No gameplay rule changes.
- No movement radius or movement speed changes.
- No flag radius changes.
- No zoom value changes unless later approved.
- No new gameplay features.
- No push or commit during this audit.
