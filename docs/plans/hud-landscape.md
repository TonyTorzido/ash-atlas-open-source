# Landscape HUD, no dash button, combat zoom (t1520)

Branch `feature/hud-landscape--from-t1520`, from master 54db33cb8 (t1520). Driven by an iPhone landscape playtest.

## What changed

1. **Dash button removed** (JoystickMovement.tsx, JoystickMovement.css, the `--cc-dash`/`--cc-arc` sizing and the rail
   line in phoneBottomDock.css). Flick-to-dash is the only touch dash; Space and gamepad dash are unchanged. The recharge
   cue is the existing `joystick-dash-pip` (thin bar above the bottom bar, also pulses when a flick hits the cooldown); it
   now shows with the sticks visible too. No new UI.
2. **Landscape corners** (short landscape = `orientation: landscape` and `max-height: 520px`): stick base and attack face
   sit in the bottom corners with only the safe-area inset plus `--cc-face-inset: 10px` sideways and
   `--cc-edge-gap: 4px` from the bottom safe edge. The floating stick used to rest in the middle of its tall zone (that was the
   "raised" look); in short landscape it now rests at its CSS anchor. 932x430 with a 59/59/21 safe area: stick base
   and attack face are centred in their zone boxes (see item 3).
3. **Corner zones own their touches** (owner-drawn boxes, as viewport fractions, edge to edge including the safe-area strips,
   floors 150 x 110 px): left stick zone = left 22.5% of the width x bottom 32% of the height (932x430: x 0-210, y 292-430);
   right attack zone = right 25% x bottom 29% (x 698-932, y 305-430). Constants in `FLOATING_REGION.landscape`
   (floatingStick.ts). Touches inside never pan, zoom or open popups; touches outside go back to the map. A planted base
   stays inside the safe area (`plantBounds()`); the dotted guides follow the zones. Portrait is unchanged.
   At rest the stick base and the attack face sit at the centre of their boxes, computed from the zone rects and shifted the
   minimum to stay inside the safe area (`clampBaseCenter`). At 932x430: left box centre (105, 361) becomes (110, 358)
   (pushed in from the 59 px notch strip and up off the 21 px home inset); right box centre (815, 368) becomes (815, 361)
   (up off the home inset). A planted stick still goes where the thumb lands. The cooldown pip is anchored to the bottom bar,
   not the controls, so it does not move.
4. **Bottom bar** (REVERTED in t1521, see combat-zoom-smooth.md): content 40 -> 34 px, ledgers 36 -> 30 px, MENU medallion 46 -> 40 px (rise 6), and the tray stops at the
   safe edge (`--dock-tray-bottom: var(--hud-safe-bottom)`), so only the home-indicator inset sits below it. 932x430: bar
   y 375..430 (34 px of content + 21 px inset), clear of both corner controls. Portrait untouched.
5. **Mob camera lock removed** (acquire, switch, tap-retarget, death handoff, idle release, popup-Attack lock). A mob tap is
   the pre-t1518 single-tap popup. Kept: joystick follow, drag stops follow, tap-move no follow, recenter, off-screen badge.
   `cameraLock*.ts` became `playerFollow.ts` / `playerFollowController.ts` (`PLAYER_CAMERA`; debug global
   `__ASH_ATLAS_PLAYER_CAMERA__`). `docs/plans/camera-lock.md` is historical for the lock part.
6. **Combat zoom** (changed in t1521: smoother, no zoom back out; constants below are superseded there) (`PLAYER_CAMERA.combatZoom`, one block in playerFollow.ts):

   | constant | value |
   |---|---|
   | stepLevels | 0.55 ground-scale levels (about 1.5x) |
   | easeMs | 500 (zoom in and out, `easeTo`, ease-in-out cubic, around the player) |
   | exitDelayMs | 3500 with no combat signal, then back to the previous zoom |
   | pollMs | 150 (timer; no rAF loop while idle) |
   | keepVisibleRadiusM | 280, edgeFill 0.9 of the smaller canvas half-extent: the step is cut back so mobs within 280 m stay on screen |
   | maxGroundZoom / minStepLevels | 17 / 0.05 |

   Combat = the existing `authoritativeCombatEngaged` state of the local player, or a hostile mob targeting the player, or a
   confirmed player hit. While zooming the follow waits (a pan would cancel the ease), then re-centres on the player. A user
   pinch or wheel zoom puts the controller in `pinched`: it stops, and does not zoom back out over the player's zoom. The idle
   ground-zoom correction is skipped while the combat zoom holds the zoom. One `easeTo` per transition, no per-frame writes.
7. **iOS home indicator**: dropped by the owner, no native changes. See below.

## Later, native build

On iOS a swipe from the bottom edge can be made to need two swipes. Approach for a future native build: a
`CAPBridgeViewController` subclass wired in `Main.storyboard`, overriding
`preferredScreenEdgesDeferringSystemGestures` to `.bottom` (consider `.all`) and `prefersHomeIndicatorAutoHidden` to `true`,
calling `setNeedsUpdateOfScreenEdgesDeferringSystemGestures()` and `setNeedsUpdateOfHomeIndicatorAutoHidden()`. It is a native
change (careful lane, new build, not OTA).

## Tests

- Unit: `src/map/playerFollow.test.ts` (follow, indicator, combat zoom in/out, pinch respected, soft ease target),
  `src/combat/floatingStick.test.ts` (landscape zones and plant bounds).
- Full app (feature runtime with action combat flags): `full-app-tests/hudLandscape.spec.ts` (no dash button, 932x430 positions with
  simulated safe area, corner touches never pan/zoom), `full-app-tests/playerCamera.spec.ts` (badge, follow, combat zoom
  in/out smooth, pinch respected). `cameraLock.spec.ts` was removed; other specs now dash with Space.
- Screenshots: `docs/plans/hud-landscape/before-landscape.png`, `after-landscape.png` (932x430, safe area 59/59/21).
