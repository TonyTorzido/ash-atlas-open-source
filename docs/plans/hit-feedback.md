# Hit feedback (crunch, no new animations)

Branch `feature/hit-feedback--from-t1514`, worktree `worktrees\hit-feedback__t1514` (base t1514, 35e28ae8e).
Client only. It needs no server or protocol change and adds no new character animation. Every effect is layered on
top of the existing sprites; the rig, the animation programs and the animator are untouched.

Direction: readable action combat at a deliberate pace, phone first, feel first.

## What each effect does

| Effect | What you see | Where |
|---|---|---|
| Hitstop | On a landed swing, the attacker's pose, walk cycle and slash arc and the victim's motion and drawn position freeze briefly, then play slightly fast for 90 ms to catch up. Nothing is permanently delayed. It never touches input, network or prediction: only the clock that animations sample. | `swingEffects.ts` (`sampleNowMs`, `isHeld`), `hitFeedback.ts` (`hitstopLag`), `pixiOverlay.ts` |
| Impact flash | Hit mob: a white additive flash (the existing flash sprite) for the hold, then a stronger red multiply that fades, layered over the existing red hit tint. Hit player: a strong red tint on the hit frame, then a fade (the player rig has no flash sprite). | `pixiOverlay.ts` `applyMobActionMotion`, `applyPlayerHitTint` |
| Impact spark + slash mark | A white 4-point star at the contact point for the first ~65 ms, 6 rays, and a white slash line across the target, square to the swing. Bigger on the finisher. | `pixiOverlay.ts` `drawSwingFx` (one pooled Graphics) |
| Visual push | The victim is displaced 55% of the push on impact with a 1.5 px frame-by-frame tremble while frozen. After the hold it eases out to the full push, then eases back. Render-only: the server position is unchanged, since knockback stays off. | `swingEffects.ts` `nudge` |
| Screen shake | Translates the map host (map tiles and the overlay together; the HUD stays still) on the combo finisher, on an incoming hit of 12% max HP or more, or on a signature or telegraphed move. Setting: Menu, Settings, Map, Action combat, **Screen shake** Full / Reduced / Off. Always off under OS reduced motion. | `hitFeedback.ts` `ScreenShakeState`, `pixiOverlay.ts` `applyScreenShake`, `PhoneHud.tsx` |
| Damage pop | Numbers scale in big, undershoot, then settle. Finisher and big incoming hits use a bigger pop, settle 15% larger, and get a bigger brighter style (gold out, hot red in). Incoming damage is red and stays right of the head (clear of the mob attack-countdown badge), drifting outward. Outgoing numbers cross left to right. Label Text objects are pooled per style. | `damageFloaters.ts`, `pixiOverlay.ts` `drawDamageFloaters` |
| DODGE | Cyan "DODGE" pops straight up and is gone in 0.9 s (it used to linger like a damage number). | `damageFloaters.ts`, `floatingFeedbackStyle` |
| Dash i-frames | A soft pale-blue shimmer on the player for the 200 ms of dash i-frames (local from the predicted dash, remote from the snapshot's active dash). | `pixiOverlay.ts` `applyPlayerHitTint` |
| Hit sound | Skipped: the client has no audio pipeline. | none |

Reduced motion: the push drops to 35% with no tremble, shake is off, damage numbers do not pop, and the shimmer is
a steady half strength. Hitstop stays, because it is a pause, not motion.

## Constants

All in `apps/client/src/combat/hitFeedback.ts` unless noted.

| Constant | Value | Meaning |
|---|---|---|
| `HIT_TUNING.swing` | hold 60 ms, push 8 px | swing 1 and 2 |
| `HIT_TUNING.finisher` | hold 90 ms, push 12 px | combo finisher (swing 3) |
| `HIT_TUNING.shot` | hold 45 ms, push 6 px | bow shot, on arrow arrival |
| `HIT_TUNING.incoming` | hold 35 ms, push 5 px | the local player getting hit (lighter) |
| `HITSTOP_CATCHUP_MS` | 90 | after the hold, animations run at about 1.7x to catch up |
| `PUSH_IMPACT_SHARE` | 0.55 | share of the push applied on the impact frame |
| `PUSH_OUT_MS` / `PUSH_RETURN_MS` | 45 / 170 | ease out after the hold / ease back |
| `HOLD_JITTER_PX` | 1.5 | tremble while frozen |
| `IMPACT_FLASH_ALPHA` / `IMPACT_FLASH_FADE_MS` | 0.85 / 80 | white additive flash during the hold, then fade |
| `IMPACT_RED_STRENGTH` / `IMPACT_RED_MS` | 0.55 / 220 | red multiply after the flash (existing ramp: 255 to 90 on G and B) |
| `IMPACT_SPARK_MS` (= `SPARK_DURATION_MS`) | 190 | spark rays |
| `IMPACT_SLASH_MS` | 140 | slash mark |
| `SHAKE_TUNING.finisher` | 3 px, 140 ms | |
| `SHAKE_TUNING.bigHit` | 5 px, 200 ms | incoming hit of 12% max HP or more (`BIG_HIT_HEALTH_SHARE`) |
| `SHAKE_TUNING.signature` | 6 px, 240 ms | incoming hit from a signature ability or a telegraphed cast |
| `SHAKE_REDUCED_SCALE` | 0.4 | Screen shake: Reduced |
| `DAMAGE_POP_START_SCALE` / `_BIG_` / `_INCOMING_` | 1.7 / 2.25 / 1.5 | pop start scale |
| `DAMAGE_POP_IN_MS` / `DAMAGE_POP_SETTLE_MS` | 90 / 80 | ease out to 0.9x, then ease in to settled |
| `DAMAGE_BIG_SETTLED_SCALE` | 1.15 | big numbers stay larger |
| `DODGE_VISIBLE_MS` | 900 | DODGE life (last 300 ms fade) |
| `IFRAME_SHIMMER_CYCLES` | 2 | pulses over `DASH_IFRAME_MS` (200, shared) |
| incoming number x | +30 px, drifting to +46 | `damageFloaters.ts` |
| floater label pool | 16 per style | `pixiOverlay.ts` `FLOATER_POOL_LIMIT` |

## Guarantees and how they are checked

- Input is never delayed. The SWING message is sent in the same handler that starts the hitstop (0.2 ms apart in
  the e2e run), and a dash pressed during the hold goes out 0.1 to 0.2 ms after the press (a baseline dash, with no
  hold, takes 0.5 to 0.6 ms).
- Hitstop really happens: the e2e run counts rendered held frames, and the hold lengths are 60/60/90 over a
  three-swing combo.
- Screen shake "off" gives 0 shake starts and no map-host transform, while the hitstop still runs.
- No per-frame allocation in the hot paths. Records are reused, the floater label pool replaces a new Text per
  number, the per-frame `Set` and the `toGlobal` points are scratch objects, and spark drawing uses an
  allocation-free entity centre. A template string is built only on frames where the shake offset changes.

Tests:
- `apps/client/src/combat/hitFeedback.test.ts`: easing, hitstop lag (never runs backwards), push, flash, shake,
  setting scale, damage pop, shimmer.
- `apps/client/src/combat/swingEffects.test.ts`: hold, catch-up, finisher/incoming lengths, arc holds with its
  swinger, push direction.
- `apps/client/src/combat/damageFloaters.test.ts`: incoming placement, big pop, DODGE timing.
- `apps/client/full-app-tests/hitFeedback.spec.ts`: WELCOME flag and attack button, hitstop without input delay,
  finisher shake and the setting, screenshot bursts (`HIT_FEEDBACK_BURSTS=1`), and perf (`HIT_FEEDBACK_PERF=1` on a
  runtime with `DEV_PLAYERS_INVULNERABLE=true`).

## Perf (6-wolf fight, headless Chromium, 390x844)

Six 5 s windows alternate hit feedback off (`__ASH_ATLAS_HIT_FEEDBACK__.disabled = true`) and on. Six wolves are
topped up before each window, the player taps attack every 350 ms (5 to 6 landed hitstops per window), and the
runtime has `DEV_PLAYERS_INVULNERABLE=true` so the fight lasts (wolf bites resolve as DODGE). The figures are mean
ms per frame, measured in the dev build in headless Chromium with GPU:

| Window | Feedback | Dynamic draw | Pixi render | rAF mean | rAF p95 |
|---|---|---|---|---|---|
| 0 | off | 0.960 | 0.596 | 19.89 | 59.6 |
| 1 | on | 0.874 | 0.510 | 19.85 | 61.3 |
| 2 | off | 0.805 | 0.478 | 19.72 | 60.9 |
| 3 | on | 0.834 | 0.693 | 19.38 | 57.8 |
| 4 | off | 0.813 | 0.786 | 19.35 | 56.0 |
| 5 | on | 0.808 | 0.758 | 19.45 | 54.4 |

Extra cost with hit feedback on (draw + render, mean of the on windows minus the off windows): **+0.013 ms per
frame**. That is within run-to-run noise and well under the 1 ms budget. The rAF numbers are headless pacing, not
phone frame times.

## Screenshots

`docs/plans/hit-feedback-shots/`, all captured at the default zoom from CDP screencast bursts (1:1 CSS pixels):

| File | Moment |
|---|---|
| `phone-1-swing-hold-flash.png` | swing hold: white flash, impact star, frozen arc |
| `phone-2-swing-slash-red-number.png` | just after the hold: slash mark, rays, red tint, damage number |
| `phone-3-finisher-hold.png` | finisher hold: bigger star, longer flash (shake running) |
| `phone-4-finisher-big-number.png` | finisher: big gold number next to the regular one |
| `phone-5-incoming-hit-red.png` | wolf bite: red player tint, red incoming number clear of the attack badge |
| `phone-6-dash-iframe-shimmer.png` | dash: pale-blue i-frame shimmer on the player |
| `phone-7-dodge-text.png` | DODGE after dashing through a wolf wind-up |
| `desktop-1-swing-hold-flash.png`, `desktop-2-swing-slash-red.png` | the same swing at the desktop default zoom |
| `zoom-*.png` | 2x labelled crops of each burst, frame by frame (offsets from the press) |

## Known limits

- The player rig has no additive flash sprite, so a hit player gets a red tint, not white (no rig changes by design).
- "Signature" detection on incoming hits is a heuristic: the source mob has a signature telegraph up or a
  telegraphed cast running when the DAMAGE arrives. Big hits (12% max HP or more) shake regardless.
- Hitstop and the big pop follow the local player's own predicted hits. Hits by other players flash and pop
  normally, with no hold.
