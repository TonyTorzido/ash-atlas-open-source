# Action combat measurements (Phase 9)

Branch `feature/action-combat--from-t1499`, local dev runtime (frontend 41768, backend 41769, `ACTION_COMBAT_ENABLED=true`, `SWING_DEBUG_LOG=true`), headless Chromium on the same machine, so network latency is about zero. Source: backend `perf-server` log lines and `full-app-tests/actionCombat.spec.ts` (three full runs of 10 tests each, all passed).

## Server (last `perf-server` line, counters cumulative since the backend started)

| Metric | Value |
| --- | --- |
| swingsResolved | 334 |
| swingHits | 264 |
| swingRejected | 0 |
| swingResolveMsMax | 2.23 ms |
| swingResolveMs average (Total 153.2 / 334) | 0.46 ms |
| tick p95 (last 1200-tick window) | 0.14 ms (p50 0.08) |
| tick max (last window) | 0.29 ms |
| worst tick p95 across all windows in the log | 0.43 ms |
| worst tick max across all windows in the log | 17.67 ms (one outlier; the 20 Hz tick budget is 50 ms) |

## Client `perf-sample`

No `perf-sample` lines reached the backend log (0 found), so `swingPressToResultP95Ms`, fps and `swingDrawCalls` were not measured in this run. The press-to-result figures below come from the E2E websocket frame pairs instead. fps and draw calls still need a real device or a client-side probe.

## Press to result (E2E, SWING sent to SWING_RESULT received)

121 swings over the three full runs (each run includes the 30-swing paced latency test).

| p50 | p95 | max | min |
| --- | --- | --- | --- |
| 50 ms | 87 ms | 216 ms | 39 ms |

The single-run figure the spec prints (n=40, last run) is p95 56 ms, max 107 ms. Localhost only; add the real round trip on a phone.

## Notes

- Zero rejected swings across 334 resolved; every swing in the E2E was accepted.
- Swing resolve cost is about 0.5 ms average, so combat adds no measurable tick load at this scale (1 to 2 active combatants).
