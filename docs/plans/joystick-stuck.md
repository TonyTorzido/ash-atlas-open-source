# Joystick stuck (t1523)

Owner saw the floating stick drawn active (base planted, knob pushed) with no finger on it.

## Cause (measured with real CDP multi-touch, portrait and landscape)
The stick was released only by pointerup, pointercancel and lostpointercapture on its own element. Reproduced still-held with
no release after: window blur, document hidden (visibilitychange), pagehide, a portrait/landscape change, and a capture that is
gone without an event. iOS drops touches for the home-bar swipe, banners, Control Centre and backgrounding and does not always
send pointerup/pointercancel, so the stick stays held; while stale, a new press on the stick was also ignored. Not causes
(verified): touchcancel, sliding off the screen edge, a second finger on a hotbar slot or a map pinch, in either lift order, and
the corner-zone code.

## Fix (`JoystickMovement.tsx`, `combat/stickWatchdog.ts`)
- `resetStick()` (knob recentres, move loop sends its stop frame, follow settles) is called on blur, pagehide, document hidden,
  orientationchange and a portrait/landscape flip.
- The stick records its own touch identifier; any touch event whose active list lacks it (or is empty) releases it.
- A 300 ms watchdog releases a stick whose pointer capture is gone; a stale hold never blocks a new press (it is taken over).

## Tests
`full-app-tests/stickRelease.spec.ts` (20 scenarios, both orientations, asserts not held, knob recentred, player stopped);
unit `src/combat/stickWatchdog.test.ts`.
