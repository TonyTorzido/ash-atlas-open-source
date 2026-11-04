# Combat zoom: smooth, in only (t1521)

Branch `feature/combat-zoom-smooth--from-t1521`, from master ebd3643f8 (live t1521). Follows hud-landscape (t1520).

## Changes

1. **Landscape bottom bar reverted** to exactly its pre-hud-landscape CSS (content 40 px, medallion 46 px, rise 6, ledgers 36 px,
   gap 4, tray to the bottom edge). `phoneBottomDock.css` differs from t1519 only by the removed dash term. At 932x430 with the
   59/59/21 safe area the bar is x 281-651, y 369-430; the stick (x 59-162) and attack face (x 768-863) do not overlap it (asserted
   in `hudLandscape.spec.ts`). Everything else from hud-landscape stays.
2. **No zoom back out.** The combat zoom target is the play zoom (`desiredGroundZoom`) plus `stepLevels` (0.55), still capped by the
   keep-280 m rule and `maxGroundZoom`. On a fight start it eases up only if the current zoom is below the target. When it lands
   it commits the target as the play zoom (`commitPlayZoom`), so idle ground-zoom upkeep keeps it and later fights see
   current >= target and do nothing (no ratchet). After the player zooms out by hand the next fight eases up to that zoom + 0.55,
   never further.
3. **Smoother zoom.** Measured on the runtime (portrait 390x844, training dummy, per-frame `getZoom`/centre/player point):

   | | old (`easeTo` + follow `panBy`) | new (one `jumpTo` per frame) |
   |---|---|---|
   | frames / window | 26 / 512 ms | 51 / 847 ms |
   | max zoom step per frame | 0.067 (3.1x the mean) | 0.021 (1.0x the mean) |
   | max zoom jerk (step to step) | 0.060 | 0.005 |
   | longest frame gap | 79 ms | 47 ms |
   | player drift from centre | 0 px | 0 px |
   | bearing 40 drift | not measured | 0 px |

   Root cause of the roughness: MapLibre's cubic `easeTo` is a 0.5 s ease whose peak speed is 3x the mean, the first frame carried
   the overlay refresh hitch (79 ms), and the follow had to be paused for the whole ease (any `panBy` or `jumpTo` stops an
   `easeTo`), so there were two competing camera drivers. Now one rAF loop interpolates the zoom itself (smootherstep, 900 ms, zero
   speed and acceleration at both ends) and writes zoom and follow pan together with one `jumpTo`
   (`zoomFramingCenter` in playerFollow.ts: zoom around the player, then the pan, at any bearing). No allocation per frame beyond the
   one centre object; the loop only runs while the follow settles or the zoom animates.
4. **Pinch cancels the ease.** A second finger (touchstart with two touches) or the wheel on the map, or any zoom the map reports that
   we did not write, stops our zoom at once (`pinched`), commits nothing, and nothing zooms back. The map's own zoom flag is not
   usable because our per-frame `jumpTo` also fires zoom events.

Constants: `PLAYER_CAMERA.combatZoom` (stepLevels 0.55, easeMs 900, exitDelayMs 3500, pollMs 150, keepVisibleRadiusM 280, edgeFill 0.9,
maxGroundZoom 17, minStepLevels 0.05). `exitDelayMs` now only ends a fight (the next fight may zoom again).

## Tests

- Unit `src/map/playerFollow.test.ts` (30): monotonic, step <= 2.2x mean, jerk, zero speed at both ends, player kept at the centre at
  bearing 0 and 33 (centred and 30 px off), never zooms out, no ratchet over 4 fights, re-zoom after a manual zoom out, no zoom when
  already past the target, pinch/wheel/foreign zoom cancel.
- Full app `full-app-tests/playerCamera.spec.ts`: 11 (smoothness bounds, no zoom out), 12 (pinch cancels the ease), 13 (no ratchet),
  14 (bearing 40 drift), plus the follow tests; `hudLandscape.spec.ts` (bar clears the controls).
