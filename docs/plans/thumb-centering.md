# Thumb zones centred, dash flick tuned (t1524)

Branch `feature/thumb-centering--from-t1524`, from master ec83df88e.

## Centring
- Both controls rest at the exact geometric centre of their zone (`restingBaseCenter`), in landscape and portrait. No shift for the
  safe-area inset (the ring may overlap it); a control only moves if it would not fit inside its zone (the zones reach the screen
  edges in landscape). A planted stick follows the thumb while touching and returns to the centre on release. `plantBounds` and
  `attackThumbRegion` were removed.
- Landscape 932x430 (safe 59/59/21): left zone x 0-209.7, y 292.4-430, centre (104.8, 361.2); right zone x 699-932, y 305.3-430,
  centre (815.5, 367.6). Stick base and attack face centres: (104.9, 361.2) and (815.5, 367.6).
- Portrait 430x932 (safe top 59, bottom 34): left zone x 0-172, y 691.4-846, centre (86, 768.7); right zone x 258-430, same y,
  centre (344, 768.7). The two zones are exact mirror images (same width, height and bottom, which is the dock top; the rail cap is
  the lower of the two rails). The attack zone in portrait is now the whole corner zone (it used to be a square around the button).
  No overlap with the bottom bar or the rails (asserted); the MENU medallion sits between the zones.
- Screenshots: `docs/plans/thumb-centering/landscape-932x430.png`, `portrait-430x932.png` (zone outlines dotted).

## Dash flick (flickDash.ts)
| | old | new |
|---|---|---|
| fresh touch: rim fraction | 0.7 | 0.525 (x0.75) |
| fresh touch: travel from landing | 0.5 | 0.375 (x0.75) |
| fresh touch: reach within | 140 ms | 75 ms (7.0 radii/s, was 5.0, +40%) |
| fresh touch: lift within | 180 ms | 125 ms |
| mid-walk turn: travel | 1.3 radii in 70 ms (18.6/s) | 0.975 radii in 36 ms (27/s, +46%) |
| mid-walk push: travel | 0.9 radii in 70 ms (12.9/s) | 0.675 radii in 36 ms (18.75/s, +46%) |
The dash travel distance (shared dash.ts) is unchanged. Simulation (10,080 scripted walking/circle/zig-zag/turn/correction paths):
0 false dashes; deliberate flicks fire 100% at dense pointer input and at 25 ms spacing; at 33 ms spacing (a very loaded main
thread) a flick is no longer guaranteed because the window is about one event.

## Tests
`floatingStick.test.ts` (mirrored portrait zones, centre rest), `flickDash.test.ts`, `walkFlickDash.test.ts`;
full app `hudLandscape.spec.ts` (centres within 2 px of the guides in landscape and portrait, mirrored portrait zones, no overlap),
`floatingSticks.spec.ts` (whole file runs), `flickDash.spec.ts` (faster scripted flicks).
