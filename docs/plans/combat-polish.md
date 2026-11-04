# Combat polish (branch feature/combat-polish--from-t1528, 2026-10-16)

Implements the ranked findings of `combat-feel-audit-2026-10-16.md`. Presentation and input only: no server damage, hit-test or
authority changes. The one shared-constant change is `SWING_BUFFER_EARLY_TICKS` 3 -> 5 (server and client deploy together).
Full-app spec: `apps/client/full-app-tests/combatPolish.spec.ts` (numbers go to `<ASH_ATLAS_E2E_OUT>/combat-polish-<LABEL>.json`).

## Phase A (audit #1, #3, #4, #9, #10)

| Item | Change |
|---|---|
| Swing on touch-down | The attack button swings (auto-aimed) on pointer-down; a held button repeats from the first frame at the recovery cadence; a drag re-aims the next swing. Measured: tap to SWING send 0.1 to 0.8 ms (was the finger-lift time, 60 to 150 ms); a hold swings at 0.3 ms then every ~733 ms, no double fires. |
| Contact frame | Arm swing windup shortened so the blade crosses at 105 ms (119 ms finisher). Flash, spark, hitstop, kick, shake and the damage number all land at that frame instead of on the press. Measured: tap to hit effect 105.1 ms median. |
| Hit kick | Every confirmed hit nudges the screen 1.5 px / 90 ms along the swing, a kill 4 px / 150 ms (scaled by the screen-shake setting). |
| Arc follows the player | The slash arc is anchored to the owner's rendered position each frame; lunge 6 -> 16 px. |
| Cues | `combat/combatFeedback.ts`: named cues (`swing hit kill hurt dash ready dashReady`) fan out to haptics (native only, behind the "Combat haptics" setting in the phone menu, default on) and a sound hook `setCombatSfxHandler` (no assets ship yet). |

## Phase B (audit #2, #5, #11, #12)

| Item | Change |
|---|---|
| Death ghost | A defeated mob is not destroyed the frame it leaves the list: a 400 ms ghost (60 ms white flash, fade, shrink to 0.65; reduced motion fades only) starts at the killing blow's contact frame. |
| Kill number survives | `FloatingFeedbackState.anchorTargets` gives the floaters of removed targets a world position so `removeTargets` no longer erases them. |
| Kill beat | The local player's kill adds a 110 ms hitstop, a 4.5 px / 190 ms shake and the 4 px kick, plus the `kill` cue. Keyed on `DEFEATED` (the killing blow's DAMAGE usually rides an earlier delta, so keying on DAMAGE never fired; found by the spec). |
| Mob snapshot buffer | `combat/mobSnapshotBuffer.ts`: world mobs are drawn at `serverNow - 110 ms` between timestamped samples (4-sample ring per mob, 60 ms extrapolation easing back over 120 ms, snap past 40 m). Replaces the restart-a-glide-on-every-10-Hz-delta smoother for world mobs; companions keep the old path. |
| Aligned lag hint | Swing lag hint = RTT/2 + 110 ms (the draw delay), so the server rewinds mobs to where the player saw them. |
| Hitstop clock | A held mob keeps its position and the sample clock is shifted by the hold, so there is no forward pop when the hold ends. |
| Allocation | `combatStore.entities()` is cached between writes; `desiredMobIdsForPresentation` reuses a scratch set. |
| Stick without React state | The movement stick knob and the floating base move by writing `transform` on refs; React state changes only on touch-down and release (was `setKnob`/`setPlant` on every pointer move). |
| Ready cue | When a swing recovery runs out on its own: the attack ring flashes and the disc pops (300 ms), `ready` cue. A dash-cancel does not fire it. |

Legacy switches for before/after specs (on `window.__ASH_ATLAS_HIT_FEEDBACK__`, never set by the game): `legacyMobSmoothing`
(old glide), `legacyDeathBeat` (no ghost, kill number erased with its target, no kill hitstop or shake), `disabled`.
Probes: `__ASH_ATLAS_MOB_PROBE__` (`enabled`, per-frame drawn mob positions), `__ASH_ATLAS_COMBAT_CUES__`.

### Before / after numbers (full-app, headless Chromium, phone viewport, GPU on)

- Kill number (B1), 2 kills per mode, 16 hits each: legacy lost the killing blow's number in 1 of 2 kills (race with the contact
  delay; the audit predicted it every time, it depends on whether the delayed number is drawn before the removal arrives); after:
  0 of 2. Death ghost: 0 started in legacy, 1 per kill after. Kill hitstop and kill cue: after only.
- Drawn mob motion (B3), a provoked deer approaching, 6 s windows, alternating modes, per-frame drawn speed:
  - mid-motion stall frames (still while moving within 150 ms either side): legacy 14.8 %, snapshot buffer 0 %;
  - change of the 100 ms average speed between neighbouring bins, relative to mean speed: legacy 0.318, snapshot buffer 0.212;
  - the raw trace shows why: legacy is a staircase (0, 71, 0, 139, 0, 86, 0, 96 m/s, re-picked from each packet interval),
    the buffer holds a steady 75 to 90 m/s.
- Forward jump after a hitstop (B4): speed on the frame after each hold vs the moving median, max 0.98 (snapshot buffer) and 0.21
  (legacy glide). No forward pop in either: the pre-existing legacy path already waited its glide clock while held, so the audit's
  #11 was only live for the snapshot buffer to avoid reintroducing. 9 and 6 holds sampled.
- Latency: tap to SWING send ~0.2 ms; tap to hit effect 105 ms.

## Phase C (audit #6, #8)

| Item | Change |
|---|---|
| Wider buffer | `SWING_BUFFER_EARLY_TICKS` 3 -> 5 (250 ms of a 700 ms recovery). Shared constant: client `SWING_BUFFER_WINDOW_MS` and server `too_soon` follow it. |
| Re-aim at send | A buffered auto-aim tap keeps a `reaim` hook and re-runs `autoAimDirection` when the swing actually goes out. Measured: swing 1 east (dirX 1), buffered swing re-aimed west (dirX -1) after the player walked and the west dummy became nearest. |
| Too-early press | A press more than 250 ms before the end is ignored (no SWING) and the attack ring blinks (`is-too-early`, 320 ms). Measured: 200 ms press ignored, 500 ms press buffered and sent 709.8 ms after swing 1. |
| Dash input queue | A dash asked for in the last 150 ms of the 3 s cooldown (flick, Space, gamepad) is held and fires 25 ms after the cooldown ends (the slack keeps it behind the server's own cooldown). One slot, newest wins. Measured: a 300 ms-early press dropped, a 140 ms-early one fired at 3026 ms; server accepted 2 of 2. |
| Dash cues | Camera lean 3 px / 130 ms into the dash (screen-shake setting scales it), `dash` haptic (light) and sound hook, and a bright pop on the recharge pip plus `dashReady` cue when the charge is back. |
| Mid-dash swing | A swing pressed during a dash is predicted from the dash landing point and times its arc and hit effects from the landing (the server buffers it to the landing). Measured: swing sent 71 ms into the dash, predicted hit effect 255 ms after the dash start (150 ms dash + 105 ms contact), server confirmed the hit. |
| Dash charges | Unchanged: one charge, 3 s cooldown, emergency tool by owner decision. |

## Settings and switches

- "Combat haptics" (phone menu), per device, default on, native shells only (web counts skips in `__ASH_ATLAS_COMBAT_CUES__`).
- Screen shake setting scales shake, kick and the dash lean (off removes them, hitstop stays).
- No new flags on the server. Deploy note: client and server must ship together for the buffer constant (an old server with a new
  client still works, since the client sends at recovery end; an old client with a new server only gains slack).

## Not done / follow-ups

- No audio assets (hook only). No weapon glint on the character for the ready cue (ring pop only).
- The mob snapshot buffer is on world mobs only; COMBAT_DELTA_HZ 20 for mobs in combat was not changed (bandwidth call).
- Attack-button knob (aim drag) still uses React state per move; only the movement stick was moved to refs.
