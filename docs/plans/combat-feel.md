# Combat feel (phones)

Owner playtest of live t1513: "the fighting system feels finicky", "the player moves all wonky",
"the area at bottom is too large, for movement and attack direction", "just doesn't FEEL good".
Target: Twin-stick. Crisp, predictable movement, aim that does what you meant,
touch zones only where the thumbs are.

Branch `feature/combat-feel--from-t1513` (base t1513, 7943bcaee).

## How it is measured

`apps/client/full-app-tests/combatFeel.spec.ts` runs against a feature runtime with
`ACTION_COMBAT_ENABLED`, `MOB_TACTICS_ENABLED`, `MOB_ARCHETYPES_ENABLED` and `DEV_TOOLS_ENABLED`.
Headless Chromium, touch emulation, CDP multi-touch, floating sticks and stick guides on.

- A page probe finds the player render timeline and `getWorldState` through React fibers. It samples
  the rendered local position every frame. It also wraps the timeline's correction, snap and
  lead-cap hooks to count them.
- **Phone network:** every websocket frame each way is held in the page for 70 ms ± 30 ms (order
  kept), so the round trip is ~140 ms with jitter. Movement runs both on LAN and on this phone
  network. Aim and stall checks use the phone network.
- Numbers go to `<ASH_ATLAS_E2E_OUT>/combat-feel-<COMBAT_FEEL_LABEL>.json`.
  `COMBAT_FEEL_GUARD=0` only measures; the default also asserts the guard numbers below.

Walk speed is 125 m/s (`DEFAULT_PLAYER_SPEED_MPS`, game metres), swing reach 130 m.

## 1. Before (t1513)

### (a) Touch zones

| | portrait 390x844 | landscape 844x390 |
|---|---|---|
| Movement zone | 176x146 px: 45 % W x 17 % H, 7.8 % of screen (y 640-786, between the lowest hotbar slot and the dock) | 246x148 px: 29 % W x 38 % H, 11.1 % |
| Attack zone | 176x146 px, 7.8 % of screen | 246x148 px, 11.1 % |
| Attack button face | 86x86 px, 2.2 % | 86x86 px, 2.2 % |
| Dash button | 67x67 px, 1.4 % (on top of the attack zone) | 67x67 px, 1.4 % |
| Taps owned by the map | 70 % | 64 % |
| Hotbar / dock | 4.9 % / 4.9 % | 4.5 % / 3.3 % |

What steals taps: the two stick zones cover the whole bottom band from edge to edge (90 % of its
width in portrait). The attack zone is 3.5x the button: **72 % of it is empty space around the
button**. A touch anywhere in it plants an attack stick, so a tap meant for the map just above the
dock, or a sloppy movement-thumb tap, starts an attack. In landscape, stick zones take 22 % of the
screen.

### (b) Movement

| | LAN | phone network (140 ms RTT ± 30) |
|---|---|---|
| Input to first visible move | 18 ms median (1 frame) | 17.5 ms median |
| 10 s square walk: corrections / mean size | 1 / 0 m | 1 / 0 m |
| Position snaps (frame step > 2.5x walk step) | 0 | 0 |
| Steady speed jitter (frame-to-frame CV) | 0.011 | 0.009 |
| Hitch frames (speed < 50 % or > 150 % of median) | 0 % | 0 % |
| Heading error vs stick, straight | 1.8° mean, 2.9° p95 | 2.0° / 3.0° |
| Heading error vs stick, 10 s circle | 5.9° mean, **15.5° p95** | 5.5° / 13.7° |
| Walk/idle flicker while held | 0 / s | 0 / s |
| Release drift | 2.3 m, stops in 40 ms | 2.3 m, 43 ms |

**Stick response curve:** binary. Deflection 0.05 and 0.08 of the radius give 0 m/s. 0.12 and
above give the full 125 m/s. The dead zone is 0.1 x 46 px = **4.6 px**, so a thumb landing a few
pixels off already starts a full-speed walk.

**Facing:** the character is one front sprite with no left/right flip
(`map/playerWalkMotion.ts` only switches walk and idle). There is no facing to flicker. Walk/idle
flicker measured 0. The swing arm picks a side from the aim's screen x.

Steady walking is clean. The "wonky" feel comes from intermittent events that a steady walk does
not show (see (d)), and from the circle lag: the walk direction updates only after the stick turns
more than 10°, at most every 120 ms. The path is a polygon that lags the thumb by up to 15°.

### (c) Aim

| Scenario (phone network) | Meant | Swung | |
|---|---|---|---|
| Tap, dummy ahead at 100 m, a closer dummy behind at 70 m | ahead | **behind (180° off)** | miss |
| Tap, only dummy to the right (90 m) | right | right | ok |
| Tap with a 12 px thumb wobble left, dummy right | right (a tap) | **wobble direction (166° off)** | miss |
| Tap with a 6 px wobble, dummy right | right | right | ok |
| Drag 30 px left, dummy right | left | left, aim indicator shown | ok |
| Tap, no mobs, after walking right | right | right | ok |
| Tap after a drag-aim down then a step up (stale aim) | up | up | ok |
| Tap, dummy ahead out of reach (170 m) | ahead | ahead | ok |

2 of 8 taps go somewhere the player did not mean:

- Auto-aim takes the nearest mob in reach even when it is behind the player.
- The drag dead zone is 10 px, smaller than a normal thumb wobble on a tap. A wobbly tap becomes an
  instant manual swing in the wobble direction.

Nothing aims from a stale stick value.

### (d) Do swinging or dashing stall or rubber-band movement?

8 runs of "walk, swing 3x while walking, walk, dash mid-walk, keep walking" on the phone network:

- **Swinging:** no slowdown in 7 of 8 runs (0 % speed loss). In 2 runs the walk froze for
  ~650 ms after a **13.6 m backward jump**. That freeze is not caused by the swing; see the second
  cause below.
- **Dash:** after the dash, the walk resumes in 106-117 ms. In 5 of 8 runs the player
  **rubber-banded backward**: 12, 14, 30, 196 m (once the whole dash), with 2-3 corrections up to
  17 m. On LAN: 0 m.

Causes, from per-frame traces of the render timeline:

1. **Stale "stopped" sample cancels a pending move.** The server lands the dash and stops for a
   moment before the next MOVE_TO reaches it. That "stopped" sample arrives while the client's
   newer request is still unanswered. It carries a newer movement revision, so
   `applyLocalAuthority` treats it as final, drops the local intent and blends the player back to
   the landing point. The walk then restarts when the request echo arrives. The 196 m case is the
   same thing with the stop from before the dash.
2. **Lead cap pulls the player back when authority pauses.** When player deltas pause
   (seen around world resyncs; the delta sequence restarts at 1), dead reckoning of the authority
   stops after 300 ms. The prediction lead cap then clamps the rendered player toward that frozen
   point. The result is one backward jump of up to the whole lead (13.6 m measured), then a freeze
   until deltas resume.

### Flick to dash (before)

Off by default (`ashAtlas.flickDash.v1` unset, so off). The scripted path has 17 gestures: walk
starts, 260-420 ms nudges, gentle 150 ms half steps, circles and reversals. It caused 0 dashes. A
real flick also did nothing, because the option was off.

## 2. Fixes

| Problem (from the numbers) | Fix | Files |
|---|---|---|
| Stick zones span the whole bottom band; the attack zone is 3.5x its button | Movement zone 40 % wide (max 230 px). Attack zone = resting button + 18 px each side, clipped to the corner. Everything else goes to the map. | `combat/floatingStick.ts`, `ui/JoystickMovement.tsx` |
| Tap auto-aim hits the mob behind you | Tap aims at the nearest mob within 70° of the facing (the last move), then the nearest in reach, then the facing | `combat/swingAim.ts` |
| A wobbly tap becomes a manual swing | Drag dead zone 10 → 18 px (release 5 → 10 px). Past it, the first swing still goes out at once. | `combat/swingAim.ts` |
| Binary stick that starts on a 4.6 px slip | Dead zone 0.10 → 0.15 (7 px). Still full speed past it (the server walks at one speed). | `movement/joystickMovementMath.ts` |
| Circle path lags the thumb by up to 15° | MOVE_TO resend on a 5° change (was 10°), at most every 90 ms (was 120 ms) | `movement/joystickMovementMath.ts` |
| Rubber-band after a dash | An unanswered local move outranks a "stopped" sample, even one with a newer revision. MOVE_ACCEPTED, the rejections or the 1.5 s timeout resolve it. | `movement/playerRenderSmoothing.ts` |
| Lead cap pulls the player back during a short delta pause | While the server walks to the same target as the client, the authority is dead-reckoned for up to 1 s (was 300 ms), bounded by that target | `movement/playerRenderSmoothing.ts` |
| Flick-to-dash unused (off) | On by default for coarse pointers (an explicit setting wins). The rim must be reached in 110 ms (was 150) and the finger lifted in 160 ms (was 200), so quick steps never dash. | `movement/floatingSticksPreference.ts`, `combat/flickDash.ts` |

Tried and reverted: making the lead cap hold the player still instead of clamping it. It froze the
walk for seconds on the phone network (1359 lead-cap frames, mean speed 32 m/s).

## 3. Before / after

All rows are portrait 390x844 on the simulated phone network unless noted.

| Metric | Before | After |
|---|---|---|
| Movement zone (portrait) | 176x146, 45 % W, 7.8 % of screen | 156x146, 40 % W, 6.9 % |
| Movement zone (landscape) | 246x148, 29 % W, 11.1 % | 230x148, 27 % W, 10.3 % |
| Attack zone (portrait / landscape) | 7.8 % / 11.1 % of screen | 4.1 % / 4.2 % (122x112 around the 86 px button) |
| Taps that pan the map (portrait / landscape) | 70 % / 64 % | 73 % / 72 % |
| Input to first visible move | 17.5 ms | 17.8 ms |
| 10 s walk: corrections, snaps, speed CV | 1 (0 m), 0, 0.009 | 1 (0 m), 0, 0.029 steady |
| Heading error, straight / circle p95 | 2.0° / 13.7° | 1.9° / 10.1° |
| Circle mean heading error | 5.5° | 3.8° |
| Stick dead zone | 4.6 px (0.10) | 7 px (0.15) |
| Release drift | 2.3 m | 2.2 m |
| Aim scenarios that swing somewhere unintended | 2 / 8 | **0 / 8** |
| Flick: false dashes on the scripted path / real flick dashes | 0 (option off) / 0 | **0 / 20 gestures**, real flick 1 / 1 (the walk-flick pass below grew the path to 35 gestures: still 0) |
| Dash rubber-band (no world resync) | 12-196 m in 5 of 8 runs | not reproduced in clean runs (see the limitation below) |

### World resync freezes (fixed in the follow-up pass)

**Cause.** The client throws away every player delta after one sequence gap until a resync snapshot
arrives. Snapshots are rate-limited to about one per second, client and server side. The result was a
1 s+ freeze followed by a snap.

The suspected "sequence restart" was not the cause. A snapshot carries sequence 0 and the next deltas
start at 1, which is the protocol working as designed.

**Fix (client only, no protocol change).** `playerDeltaAction` decides what to do with each delta:

- A delta past a gap is still applied: every upsert carries the player's absolute state, and the
  timeline keeps rejecting older movement revisions. A resync is requested in the background.
- Old and duplicate deltas are still dropped.
- Combat deltas are unchanged: a gap there still waits for the snapshot.

**Correction to the earlier "before" stall numbers.** The first phone-network simulator could swap two
frames that arrived a millisecond apart. A real socket never does that. The swaps caused most of the
gaps those runs saw. The simulator is now a strict FIFO. On it, stall runs show:

- 0 world resyncs;
- 0 % speed loss while swinging;
- 0-6 m backward after a dash.

The stale "stopped" sample cause (section 1 (d), cause 1) came from a real trace, and that fix stays.

`combatFeel.spec.ts` "resync" walks through three forced `REQUEST_WORLD_RESYNC`s (the server
rate-limits some of them):

| Measure | Result |
|---|---|
| Longest gap between applied deltas | 133-166 ms (guard < 400 ms) |
| Slowest 250 ms window | 115-125 m/s (guard > 75 m/s) |
| Snaps | 0 |

### Pack lunge in sustained fights (fixed in the follow-up pass)

**Cause, confirmed with gate counters.** Distance never blocked the lunge (0 trigger-window misses). The
landing-window check did. With 700 ms windups, a close rotation always had a committed basic landing
inside the ±500 ms signature gap. `canStartSignature` never passed, and because the lunge costs the same
as a basic, the wolf fell back to a basic every time. Widening the trigger range would not have helped.

**Fix.** A token holder whose ready signature is waiting for a window keeps its token. This now
includes signatures that cost no more than a basic. While it waits, the ledger blocks new basic
windups (`signatureBasicHold`) for at most one windup plus the gap. The hold clears when:

- the signature starts;
- the mob releases its token;
- the hold expires.

The committed landings drain and the lunge fires. Wolves lunge again during sustained fights.

## 4. Dodge by walking, and dash as the emergency tool

> **Superseded timings:** `telegraph-time.md` retunes every telegraph below for 400 ms of reaction (melee 1100 ms,
> swarm wave 1000, ranged aim 900, signatures 1200-1600) and adds the live `MOB_TELEGRAPH_SCALE` knob. The tables
> below are the combat-feel (250 ms) pass.

Walk speed 125 m/s, reaction 250 ms. The worst spot for a cone aimed at the player (half-angle h,
range L) is d = L / (1 + sin h): from there it takes L sin h / (1 + sin h) metres to get out,
sideways or backward. A lane takes half its width; a circle its radius (from the centre). Time to
walk out = distance / 125 + 250 ms.

| Shape | Size | Time to walk out | Old telegraph | New telegraph |
|---|---|---|---|---|
| Phase 1 melee windup cone | **150 m (130 swing reach + 20 body radius)**, 90° | 62 m → 747 ms | 450 | **750** |
| Phase 1 ranged aim lane | 40 m wide | 20 m → 410 ms | 450 | 450 |
| Brute basic cone | 150 m, 90° | 747 ms | 600 | **750** |
| Pack basic cone | 150 m, 90° | 747 ms | 400 | **750** |
| Skirmisher basic cone | 150 m, 90° | 747 ms | 400 | **750** |
| Swarmer basic (wave cone) | **150 m**, 70° (was 95 m) | 55 m → 687 ms | 300 | **700** |
| Charge lane | 120 m wide | 60 m → 730 ms | 900 | 900 |
| Maul cone | 180 m, 100° | 78 m → 874 ms | 1000 | 1000 |
| Slam circle | r 110 m | 110 m → 1130 ms | 1200 | 1200 |
| Lunge lane | 50 m wide | 25 m → 450 ms | 500 | 500 |
| Double strike (each cone, re-aimed) | was 125 m 90°, now **110 m 70°** | 40 m → 570 ms (was 52 m → 666 ms) | 450 + 350 | **600 + 600** |
| Smoke step circle | r 50 m | 650 ms | 1100 | 1100 |
| Swoop cone | 130 m, 90° | 682 ms | 1000 | 1000 |
| Ground blast circle | r 100 m | 1050 ms | 1100 | 1100 |
| Volley fan (3 lanes, 40 m) | was 36°, now **50°** | centre lane 20 m → 410 ms, with a real 23 m gap beside it at 150 m (was 6 m) | 700 | 700 |
| Tongue lane | 60 m wide | 30 m → 490 ms | 900 | 900 |
| Swarm wave cone | 90 m, 70° | 33 m → 513 ms | 300 | **600** |

Damage per second (design decision, follow-up pass): **readable recovery kept, about 12-21 % less
mob damage**. An earlier version kept damage neutral by cutting recovery to 50 ms. That was rejected: the punish
window after a strike has to stay readable.

| Rhythm | Before (windup / recover / cooldown = cycle) | After | Lone-mob hits/s | Full-pack ceiling |
|---|---|---|---|---|
| Phase 1 managed melee | 450 / 300 / 650 = 1400 | 750 / 250 / 400 = 1400 | unchanged (0.71) | -25 % (token held 1000 ms instead of 750 ms) |
| Brute | 600 / 350 / 1050 = 2000 | 750 / 350 / 1200 = 2300 | 0.75 → 0.65 (-13 %) | -13 % |
| Pack | 400 / 250 / 450 = 1100 | 750 / 250 / 400 = 1400 | 0.91 → 0.71 (-21 %) | -35 % |
| Skirmisher | 400 / 400 / 800 = 1600 | 750 / 400 / 700 = 1850 | 0.81 → 0.70 (-13 %) | -29 % |
| Caster (ranged lane, already walkable) | 450 / 350 / 600 = 1400 | unchanged | unchanged | unchanged |
| Swarmer | 300 / 200 / 500 = 1000 | 700 / 200 / 250 = 1150 | 0.80 → 0.70 (-13 %) | -44 % (token hold 900 ms instead of 500 ms) |

- **Governor and ceilings:** anchored to the tuned Phase 1 hold (`MOB_ARCH_PHASE1_REFERENCE_HOLD_MS`,
  750 ms). The longer holds only lower what packs can land.
- **Balance test band:** Phase 2 vs Phase 1 at pack sizes 1-4 is now 0.7x-1.4x (was 0.8x-1.1x).
  Both phases are below their old damage, but by different amounts.
- **Signature fail-safe:** every signature hold is still at most 2 s.


### Mob melee reach = the player's swing reach (owner, last pass)

Managed melee basics now reach exactly `SWING_RANGE_M` (130 m), measured the way the swing measures it: from the
attacker's centre to the target's body edge. The strike adds the 20 m body radius (`SWING_TARGET_RADIUS_M`), so a
player centre within 150 m of the mob, inside the cone, is hit. Before, the reach was max(125 m, engage ring + 15)
with 5 m of slack, an effective 130 m+ that varied by mob.

- **Derived constants:** `MOB_TACTICS_MELEE_REACH_M = SWING_RANGE_M` and
  `MOB_TACTICS_MELEE_REACH_SLACK_M = SWING_TARGET_RADIUS_M`. The telegraph cone is drawn 130 m long.
- **Archetypes:** brute, pack, skirmisher and swarmer use the same reach (the swarmer's was 90 m). Caster basics,
  ranged aims and signatures keep their own ranges. The action-combat-only path keeps its 5 m slack.
- **Engage ring:** clamped to at most 140 m (reach + body radius - the 10 m arrive tolerance), so a big body always
  hits from its seat; it may overlap the player sprite slightly. Mob-to-mob spacing is unchanged.
- **Walk-out:** the longer cone (150 m effective) needs 747 ms to walk out of, so basic windups are 750 ms (the
  swarmer's 70° wave, 687 ms → 700 ms). Cooldowns shrank by the same amount, so every cycle (and the lone-mob damage)
  is unchanged.
- **Two engine fixes the longer windups needed:**
  - A holder's token clock restarts when its strike starts. A walk to the seat plus a 750 ms windup could pass the
    2.5 s stuck-holder fail-safe, which let a third windup start.
  - The governor now counts basics already wound up but not landed. It used to count only the current tick's starts,
    and a dense swarm overshot the 2 s budget.

**Dash:** 150 m in 150 ms (the same speed, so it feels just as snappy). Cooldown 3000 ms (was 1500).
I-frames stay 200 ms. Signature spacing is `max(3000, DASH_COOLDOWN_MS)`, so it is at or above the
new cooldown. The client cooldown ring and flick-to-dash read the shared constants.

`shared/mobArchetypes.test.ts` now computes each walk-out from the table and checks every
signature part and every basic cone against it.

## Walk flick dash (flick while already walking)

A fresh-touch flick needs the rim within 140 ms and a lift within 180 ms, so it cannot happen while walking. The
mid-hold flick covers that: with the thumb down and the player walking, a quick sharp thumb flick dashes the way
the thumb ends up pointing. It follows the same setting as the fresh-touch flick (`ashAtlas.flickDash.v1`, on by
default for touch), both stick modes (floating and fixed), and the shared dash cooldown (3 s).

**Detector (`combat/flickDash.ts`, `walkFlickStep`).** Pure. It keeps the last ~70 ms of finger samples (screen
position plus the stick vector) and, at each sample, looks back in 10 ms steps (interpolating, so a 30 Hz event
stream is measured as fairly as 120 Hz). It fires when, for some look-back inside the window:

1. the stick had been out of the dead zone for at least 150 ms at the start of the look-back (the player is
   walking, and the first moments of a touch stay with the fresh-touch flick);
2. the finger travelled at least 1.3 stick radii (60 px on the 46 px stick) in at most 70 ms (about 850 px/s);
3. the stick ends at least 0.4 R out (a quick return to centre is a stop, not a flick); and
4. either **a sharp turn**: the end direction differs from the walking direction by 60 degrees or more, or **a push
   outward**: it starts at or under 0.55 R, ends at 0.8 R or more, and moves 0.9 R in at most 70 ms in a straight
   line out along the way it started.

The dash goes along the stick vector at the end of the flick (where the thumb points; walking carries on that way).
After it fires the detector is re-armed: the next flick needs another 150 ms of walking, so one swing never dashes
twice. A flick while the dash recharges does nothing but pulse the dash button (a short shake and brightening, or a
brightening only with reduced motion); nothing is queued.

**How the thresholds were picked.** `combat/walkFlickSim.ts` replays scripted thumb paths (minimum-jerk
movement, 1.2 px finger noise, 4 ms timing jitter, 8 to 33 ms event spacing, seven start headings, 4 seeds)
through the real detector. The shortest time the finger needs to cover 1.2 R was the separator:

| Gesture | Shortest time to cover 1.2 R |
|---|---|
| Circle, 2 s per lap / 1 s / 0.7 s / 0.5 s | 410 / 206 / 144 / 104 ms |
| Zig-zag, 300 ms / 200 ms legs (+-60 deg) | 126 / 84 ms |
| 90 degree turn, 300 / 200 / 150 ms | 158 / 106 / 80 ms |
| 180 degree reversal, normal (300 ms+) | 68 ms and up |
| Deliberate flicks (40 to 120 ms) | 12 to 62 ms |

A 70 ms window at 1.3 R sits between those: everything normal needs more time to cover that distance, every
deliberate flick needs less. Each look-back is judged on the finger's own path, not on the stick vector (the
floating origin trails a finger past the rim, which hides speed).

| Constant | Value |
|---|---|
| `WALK_FLICK.windowMs` | 70 ms |
| `WALK_FLICK.minTravelFraction` | 1.3 R |
| `WALK_FLICK.walkingForMs` | 150 ms |
| `WALK_FLICK.endMinFraction` | 0.4 R |
| `WALK_FLICK.turnMinDeg` | 60 degrees |
| push: start max / end min / travel / alignment | 0.55 R / 0.8 R / 0.9 R in 70 ms / 40 degrees |

**Input handling (`ui/JoystickMovement.tsx`).** Every coalesced pointer event is fed to the detector with its own
timestamp, so a loaded main thread cannot hide a flick or fake one. When the browser reports every movement, a quiet
stretch of 30 to 200 ms is read as a resting thumb (it moved again only just before the new event); a longer gap, or
a browser without coalesced events, uses the cautious reading (the finger may have moved unseen), which only costs a
little sensitivity for a perfectly still thumb. Real thumbs jitter every frame, so this rarely matters.

### Walk flick numbers

| Check | Result |
|---|---|
| False triggers, scripted paths in the unit simulator (steady walk, circles 4 s to 0.5 s per lap at two radii, zig-zags 600 to 200 ms legs, 90 degree turns 600 to 150 ms arc and chord both ways, 180 degree reversals 600 to 300 ms, 8 to 20 px corrections in 40 to 150 ms, a light walk opening to the rim in 90 to 400 ms) | **0 / 10080** |
| Detection, scripted flicks in the simulator (reversal, short reversal, 90 degrees both ways, 135 degrees, outward push; every heading; 30 ms to the per-kind limit: reversals and diagonals 80 ms at 25 to 33 ms event spacing and 100 ms at 8 to 16 ms, 90 degree turns 60 / 80 ms, push 50 ms) | **3808 / 3808** (1624 sparse, 2184 dense) |
| False dashes, real browser: 35 scripted gestures with real touch timing (walk starts, nudges, circles at 4 s, 2 s and 1 s per lap, zig-zags with 400, 300 and 250 ms legs, 90 degree turns in 400, 300 and 200 ms, 12 px corrections) | **0 / 35** (two runs) |
| Detection, real browser: 12 scripted flicks from a walk (reversals, 90 degrees both ways, diagonals), fresh spot each time | **12 / 12**, direction error 0 to 9.7 degrees (two runs) |
| Flick on cooldown | no DASH sent, dash button pulses (`is-denied`), both stick modes |
| Walking after the dash | MOVE_TO resumes, the player walks on along the stick (about 100 m in 0.9 s on the 125 m/s dev speed), both stick modes |
| Flick setting off | a mid-hold flick never dashes |

Limits: a 90 degree turn flick must be done in about 60 ms (the chord is only 1.41 R); slower ones are treated
as steering. A reversal or diagonal flick up to about 100 ms works. The simulator uses a 46 px stick; thresholds scale
with the stick radius. Not tuned on a physical phone: if real thumbs feel too hard or too easy, change
`minTravelFraction` (and `windowMs`) in `WALK_FLICK` and re-run `walkFlickDash.test.ts` (set `FLICK_REPORT=1` to print the
counts) and the `flick` tests in `combatFeel.spec.ts`.

Files: `combat/flickDash.ts`, `combat/walkFlickSim.ts` (test helper), `combat/walkFlickDash.test.ts`,
`ui/JoystickMovement.tsx` and `.css` (wiring, pulse), `movement/dash.ts` (`denied()`),
`full-app-tests/flickDash.spec.ts` and `combatFeel.spec.ts` (end to end).
