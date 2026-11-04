# G0 Performance Instrumentation

This branch adds lightweight client-side tooling for hunting freezes and hitches during G0 gameplay. It should not alter gameplay behavior, movement tuning, zoom tuning, flag placement, persistence, or the existing Pixi render architecture.

## Controls

- Press `F2` to toggle the live performance panel.
- Press `F3` to start or stop a JSON performance recording.
- Press `F1` to open the dev console.
- Run `perf` in the dev console for a one-line snapshot.
- Run `perf reset` to clear frame, camera, and WebSocket counters while keeping load milestones.
- Run `perf record start`, `perf record stop`, `perf record status`, or `perf record reset` from the dev console. The aliases `record start`, `record stop`, `record status`, and `record reset` also work.

## Live Panel

The F2 panel is hidden by default and samples at about 2 Hz so React state is not updated every animation frame. It shows:

- FPS, sample window, average frame time, all-time/recent worst frame time, frame-budget misses over 16 ms / 33 ms, and long frames over 50 ms / 100 ms.
- Last long-frame reason.
- Map render events per second plus moving and zooming state.
- Camera `easeTo` rate/count, recenter count, and follow skips caused by dragging, zooming, close-enough movement, or interval limits.
- WebSocket rates split by player snapshots, flag snapshots, summed snapshot rate, total message rate, last snapshot age, ready state, reconnect count, visible flag count, and selected flag id.
- Load milestones from app mount through map load/idle, Pixi overlay init, WebSocket connection, welcome, and first snapshots.
- Current recording status when F3 recording is active.

## Recordings

Performance recordings are client-side only and export as JSON downloads named `ash-atlas-perf-YYYYMMDD-HHMMSS.json`. The recorder samples metrics at 10 Hz, records important event markers, and avoids per-frame event spam.

When recording starts, the first sample becomes the baseline for cumulative counters. Exported samples and summaries report recording-window values for frame counts, average/worst frame time, frame-budget misses, long-frame counts, map render event totals, camera `easeTo` count, and WebSocket message/snapshot totals. Load milestones remain absolute app-session markers because they are useful for startup context.

Recording limits keep memory bounded:

- Sample interval: 100 ms.
- Max duration: 5 minutes.
- Max samples: 3000.
- Max events: 5000.

If a recording reaches a limit, it stops and downloads automatically. Short focused captures are easier to inspect than very long recordings.

## Recording A Freeze

1. Open the game.
2. Press `F3` to start recording.
3. Reproduce the freeze or lag: drag, zoom, move, place/select/delete flags, Visit Flag, Recenter, or teleport.
4. Press `F3` again to stop and download the JSON.
5. Inspect or upload the JSON for analysis.

`F2` can stay open during this process, but it is optional.

## Guardrails

Instrumentation should remain observational. Flags, territory, movement leash, selected flag highlight, and flag hit testing should continue to render through the stable Pixi overlay path from `54af006`.

Do not reintroduce the discarded static overlay throttle, `StaticOverlayScheduler`, or the MapLibre source/layer migration for flag territory, flag centers, movement leash, or selected flag highlight.
