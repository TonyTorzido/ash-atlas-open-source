> Note: the mob lock described here was removed in t1520 (see hud-landscape.md); only the follow and the off-screen badge remain.

# Combat camera lock

Owner brief: while fighting a mob, the game recenters around it, softly and naturally, with player movement staying
smooth. The lock only moves to another mob after three hits on it, or when the player picks it (tap, then Attack). The
bottom-left recenter control removes the lock. If the player is ever off screen, a small edge badge points to them.

Client only, render only. Player prediction, joystick direction, tap auto-aim and flick dash stay in world space and
never read the lock. Hit-feedback shake (it translates the map host) and hitstop layer on top unchanged.

## Rules

1. **Acquire.** With no lock, the first server-confirmed player hit (SWING_RESULT `confirmedHitIds`, swing or shot)
   locks on that mob. Tapping a mob and pressing Attack in its popup (`requestAttack`) locks at once and overrides any
   current lock.
2. **Switch.** Three consecutive confirmed hits on one other mob switch the lock. A hit on the locked mob resets the
   count; a hit on a third mob restarts the count for that mob. A swing that hits several mobs counts the locked mob
   if it is among them, else the first.
3. **Release.** The locked mob dies, despawns or stops being a hostile alive entity; the player is more than two screen
   widths away; or there is no landed hit on it (or popup Attack at it) for 6 s. The camera then eases back to
   the player; the next landed hit re-acquires. The recenter control (and its callers: vitals tap, R3) and the
   off-screen badge clear the lock and use the normal recenter. A manual drag or gamepad pan also ends the lock
   (the user took the camera); a pinch or wheel zoom and any programmatic camera move (travel, recenter ease) only
   pause it.
4. **Framing.** Target = the locked mob, but the player is kept inside the safe area (inner 70 percent wide, top
   15 percent and the bottom quarter, which holds the thumb controls, left out). The soft pull toward the safe area
   is smoothed like everything else; a hard limit (6 percent side margins, 8 percent top, 20 percent bottom) is applied
   after smoothing so a dash or sprint can never push the player off screen or under the controls. The hard limit is
   skipped while the player is already outside it (manual pan), so it never snaps.
5. **Feel.** Exponential smoothing, about 0.5 s to settle, with a 10 px dead zone around the screen centre, applied to
   the camera with `map.panBy(..., { duration: 0 })` (the call the gamepad pan uses). Switches and releases glide.
   The loop runs only while a lock or an ease-back is active.

## Off-screen player badge

`ui/PlayerOffscreenIndicator`. Whenever the local player's rendered point is outside the map canvas (manual pan, lock
edge cases, zoom) a 40 px frosted-parchment circle with a bronze rim (the thumb-control glass tokens) and a chevron
shows on the canvas edge, along the ray from the screen centre to the player, inset 66 px from the sides (slot
rails), 84 px from the top and 190 px from the bottom (touch controls). The chevron points at the player and the
badge slides along the edge as the direction changes. Opacity fades in 180 ms; it is hidden when the player is on
screen. Tapping it calls the same handler as the recenter control. Positioned imperatively per frame (no React
re-render).

## Tunables

All in `CAMERA_LOCK` in `apps/client/src/map/cameraLock.ts`:
`hitsToSwitch` 3, `settleMs` 500, `deadZonePx` 10, `safeMargin` (15/15/15/25 percent),
`hardMargin` (6/6/8/20 percent), `releaseDistanceScreenWidths` 2, `idleReleaseMs` 6000, `returnDoneEpsilonPx` 1.5,
`returnMaxMs` 2500, `maxFrameMs` 64, and `indicator` (off-screen pad, insets, fade).

## Files

- `map/cameraLock.ts`: constants, `CameraLockState` (rules 1 to 3), framing and indicator math (pure).
- `map/cameraLockController.ts`: rAF driver; `window.__ASH_ATLAS_CAMERA_LOCK__` exposes phase, lockedId,
  challengerId, challengerHits (and a `paused` test hook) for the full-app spec.
- `ui/PlayerOffscreenIndicator.tsx` / `.css`.
- `App.tsx`: controller creation, `onSwingResolved` hit feed, `requestAttack` popup lock, recenter clears the lock,
  gamepad pan ends it, indicator mounted beside the joystick.

## Tests

- `map/cameraLock.test.ts`: state machine (acquire, 3-hit switch, reset, restart, popup attack, release reasons),
  framing/safe area/hard limit, indicator placement, and the controller against a fake map (ease without snap, safe
  area, sprint, death ease-back, idle release, recenter clear, drag release, zoom/programmatic pause).
- `full-app-tests/cameraLock.spec.ts` (phone size, feature runtime with action combat on): eases to a hit mob with the
  player in the safe area and no per-frame snap; 3 hits switch, 2 do not; popup Attack locks and recenter clears;
  the badge shows at the correct edge pointing the right way and tapping it recenters and clears the lock.

## Notes

- At the default zoom a 130 m melee reach is only about 55 px on a phone, so melee fights barely move the camera
  (the mob is already near the centre). The lock matters for ranged shots (300 m), dashes and kiting.
- Not done: a marker on the locked mob (optional in the brief).

## v2 (t1518 follow-up)

- **Death handoff.** When the locked mob dies, the lock goes straight to the nearest hostile mob that targets the player
  (within the release distance) and the camera keeps gliding; it eases back to the player only when nothing is engaged.
- **Tap to switch.** While a lock is active or a mob is engaged with the player, one tap on a mob moves the lock to it
  and opens no popup (the tap does nothing else). Tapping the locked mob again opens the popup as before. Out of combat
  taps are unchanged.
- **No snap.** The pan is blended from the previous frame's pan (`panBlendMs`), so a retarget or handoff ramps the camera
  speed instead of stepping it. The hard-area clamp also catches a player up to `hardSlackPx` outside it.
- **Stability fix.** The camera lock pans every frame, and every pan redraws the static overlay layers. `clearLayer`
  destroyed redrawn Graphics with `destroy({ children: true })`, which in Pixi 8 does not free the Graphics' own
  GraphicsContext, so about 100 KB leaked per redraw (about 6 MB/s, 90 MB per 15 s of panning measured in headless
  Chromium). On a phone that ends in the WebContent process being killed (stutter, reset, reload). `clearLayer` now passes
  `context: true`; the same 15 s of panning now retains 0.3 MB.
- **Stickman after reload.** `PlayerRenderer` remembered a failed body or equipment texture request as done, so a
  transient load failure kept the mannequin for the whole session. It now forgets the request and retries with a
  2 s to 30 s backoff.

## Follow mode (t1519)

Owner brief: while moving around the camera keeps the player centred, softly and with no lag. Dragging the map, or
moving by tap, does not.

- **Start.** Movement input held (joystick, keyboard or pad: `moveInputHeldRef`) starts the follow (`noteMoveInput`).
  It keeps running while the input is held and settles to idle once the input stops and the player is centred.
- **Manual drag or pan** stops it (the existing drag release). It stays stopped until the recenter control, or until
  movement input starts again (a new press), which glides back to centre.
- **Tap-to-move** (`handleMovementIntent`) never starts a follow and cancels one that is settling.
- **Mob lock wins.** While a lock is active the lock framing runs. When it releases with movement input still held the
  controller goes straight into the follow (no ease-back phase) and keeps the lock's slower settle and blend for
  `gentleMs`, so there is no snap. Follow works without action combat; the lock still needs it.
- **No lag.** The target is the rendered, smoothed player position (not the raw server position). The camera is fed
  forward with the player's own screen movement each frame, and only the leftover error is smoothed, so there is no
  trailing at walk speed. A player step above `feedForwardMaxPx` (a dash, a teleport) is not fed forward and starts a
  `gentleMs` window with the slow settle, so a dash never jerks the camera; the hard-area clamp still keeps the player
  on screen.
- **Constants** (`CAMERA_LOCK.follow`): `settleMs` 200 (error pull), `blendMs` 100 (blend from the last pan),
  `feedForwardMaxPx` 12 per frame, `gentleMs` 600.
- **Performance.** Same single `panBy` per frame as the lock; no React state. The Pixi layer-redraw leak is fixed (v2),
  and heap stays flat over 15 s of sustained walking (+2.0 MB then +0.2 MB with forced GC, headless Chromium).
- **Tests.** `cameraLock.test.ts` "follow mode" (joystick starts the follow and keeps the player centred, settles to
  idle, drag stops and a new press resumes, tap-move does not follow, dash does not jerk, lock to follow blend, release
  without input still eases back); `cameraLock.spec.ts` tests 8 to 10 (keyboard walking keeps the player within 1.5 px
  with a 1 px maximum camera step, drag stops the follow, tap-move leaves the camera still).
