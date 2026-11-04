# Combat feel audit (2026-10-16)

Read-only code audit of master (live 95e647580). Question from the owner: "Any suggestions for smoother combat?"
North star: readable action combat, a deliberate pace, phone twin-thumb, server-authoritative 20 Hz tick with
client prediction. Order of priority: feel, depth, numbers, PvP.

Method: read the real paths end to end (attack button -> swing -> server -> SWING_RESULT/DAMAGE -> overlay), plus the earlier
plans (`combat-feel.md`, `hit-feedback.md`, `combat-zoom-smooth.md`). Nothing was run. Every claim below is from code and cites
file:line; items I could not confirm at runtime are marked **(unverified at runtime)**.

Key constants (packages/shared/src/actionCombat.ts, dash.ts): swing recovery 700/700/900 ms (14/14/18 ticks), buffer window
3 ticks (150 ms), combo reset 1300 ms, swing reach 110 m, hitstun on mob 200 ms, dash 150 m in 150 ms, i-frames 200 ms,
dash cooldown 3000 ms, combat deltas 10 Hz (`DEFAULT_COMBAT_DELTA_HZ`, packages/shared/src/combat.ts:109), tick 20 Hz.

## Ranked findings (feel impact per effort)

### 1. Tap swing fires on finger LIFT; holding the button does nothing for 400 ms
- **Severity:** high. **Size:** S. **Client-only.**
- **Evidence:** `ui/JoystickMovement.tsx` `onRelease` (about line 830): "A tap ... auto-aims once" runs only when the gesture is still
  `"pending"` on pointer-up. `onPointerDown` (about line 846) only starts a rAF loop. The `loop` (line 776-790) promotes
  `pending -> auto` at `ATTACK_HOLD_REPEAT_MS = 400` (`combat/swingAim.ts:55`), and only then repeats. So:
  - tap: the swing starts at lift, a typical thumb tap is 60-150 ms down, so 60-150 ms of added latency before the pose and the
    predicted hit even begin (on top of the 16 ms frame);
  - hold: 400 ms of nothing, then swings.
- **Best games:** Polished mobile action games all act on press (touch-down). Some games fire an auto-aim shot on tap-down
  and uses drag only to override aim.
- **Fix:** fire the auto-aimed swing on pointer-down (the pending state becomes "already swung"); let the repeater run from the
  first frame while held; a drag past the 18 px dead zone then re-aims the NEXT swing (the 700 ms recovery already gates it). To
  avoid a wasted swing when the player means to aim, fire on down only if a hostile is in reach, otherwise wait for the drag or
  the 1-frame tap decision. Update `twinStick.ts` `nextAttackButtonMode` tests.

### 2. The killing blow's damage number is erased and the mob pops out with no death beat
- **Severity:** high. **Size:** S-M. **Client-only.**
- **Evidence:**
  - Server removes a defeated mob the same tick: `combatEngine.ts:18171-18172` emits `MOB_REMOVED` and calls
    `removeEntity(target.entityId, true)`; `SWING_RESULT`/`DAMAGE` flush immediately (`combatEngine.ts:4539`), so the last DAMAGE and the
    removal ride the same COMBAT_DELTA.
  - Client, same delta: `features/combatEquipment/useCombatEquipmentFrameHandler.ts:~712-731` enqueues the floater for the DAMAGE
    event, then immediately calls `overlayRef.removeCombatTargets(message.state.removedEntityIds)` -> `combatPresentation.ts:191`
    `floatingFeedback.removeTargets` -> `damageFloaters.ts:224-232` filters out every non-reward floater of that target. The kill number
    is deleted in the same call that created it. **(unverified at runtime, but the code path is straight-line)**
  - Even without that, `pixiOverlay.ts:3952` hides a floater whose target sprite is gone, because combat floaters never carry
    `worldPosition` (only manually enqueued ones do, `damageFloaters.ts:43`).
  - The mob sprite is destroyed the frame its id leaves `desiredEntityIds` (`pixiOverlay.ts:2405-2415`, `retainedEntityMap.ts:
    pruneRetainedEntities`). No fade, dissolve, flash or shrink exists for mobs (grep for death/dying/fade finds nothing in
    `map/` or `combat/`; `mobReassembleFx` is the revive effect).
- **Best games:** the kill is the loudest beat in polished action games: extra hitstop, death burst, number visible, loot
  pop. They always show the lethal number.
- **Fix:** keep a short-lived "ghost" for removed mobs (copy last rendered position, texture, hit flash) for about 250-350 ms and play
  a flash+shrink or dissolve and a puff; give combat floaters a `worldPosition` (lat/lon of the target at the time of the event) so
  they survive the target; skip `removeTargets` for floaters younger than their lifetime (only drop on scene change). Add a bigger
  hitstop (about 90-120 ms) and a small shake on kill.

### 3. Hit feedback fires 100-230 ms BEFORE the blade arrives, and its hitstop freezes the attacker during the windup
- **Severity:** high. **Size:** S-M. **Client-only.**
- **Evidence:**
  - `App.tsx:6444-6483` (`sendLocalSwing`): on the press it spawns the slash arc, `addPredictedHit` (flash, push, hitstop on mob AND
    attacker) and the spark, all at `hitAtMs = nowMs` (melee).
  - The arm animation: `packages/player-renderer/src/gatherAnimation.ts:355-367` `swing` program is 350 ms, windup peak at 0.28 (98 ms),
    blade across at 0.5 (175 ms); finisher 440 ms with contact about 0.52 (229 ms). `impactAt: null`, so there is no contact frame.
  - `swingEffects.ts:addPredictedHit` freezes the ATTACKER's animation sample clock too (`setStop(attackerId, ...)`, 60 ms swing / 90 ms
    finisher). Because the hit is registered at t = 0 it freezes the windup (0-60 ms), then `HITSTOP_CATCHUP_MS = 90` plays it fast. The
    arm stalls mid-windup and then rushes, which reads as a hitch instead of impact.
  - The server DAMAGE echo (HP bar, number) arrives about RTT/2 + up to one tick later (roughly 60-110 ms at 60-120 ms RTT), also before
    contact at 175 ms.
- **Best games:** Hit effects land on the first active frame; startup is about 3-6 frames (50-100 ms), then the impact and
  hitstop are on the same frame as the visible contact. Polished action games do the same.
- **Fix (pick one or both):**
  a) Add a contact time to `SWING_PROGRAMS` (`impactAt`, about 0.45 x cycle) and schedule the arc peak, flash/push/spark/hitstop at
     `press + impactMs` (all of `SwingEffectsState` already treats negative elapsed as "not started"; verify spark slots). Delay DAMAGE
     floaters with the existing `presentationDelayMs` mechanism that shots already use (`combatPresentation.ts:89-91`), by
     `max(0, impactMs - sinceSwingMs)`.
  b) Shorten the windup so contact is about 90-110 ms (set the 0.28 keys earlier, move the 0.5 key to about 0.3). This is also the
     biggest "responsiveness" lever (see #7: contact at 175 ms plus tap-on-release makes the first hit about 250-350 ms after the thumb).
- **Do not** move the server damage; only the presentation shifts. Prediction/cancel logic is unchanged.

### 4. No combat audio and no haptics at all
- **Severity:** high. **Size:** M. **Client-only** (assets needed).
- **Evidence:** no `Audio`, `AudioContext`, `.mp3/.ogg/.wav` anywhere in `apps/client` (grep found none); the only haptics call is
  `ui/GearSlot.tsx:159-160` (`Haptics.selectionChanged()` / `navigator.vibrate(6)`). `@capacitor/haptics` 8.0.2 is already a dependency.
- **Best games:** on phones, sound and a light tick of haptics are most of the "juice" of a hit. Polished mobile action games
  all pair every hit with a sound and a tap.
- **Fix:** a tiny `combatFeedback.ts` with: swing whoosh (3 variants per combo step), hit thud, kill pop, incoming hit, dash whoosh,
  telegraph "tick" at the strike moment; haptics: light impact on a confirmed predicted hit, medium on finisher/kill, warning tick
  on taking damage, with a setting. Trigger from the same places as `addPredictedHit` and `addIncomingHit`. Use Web Audio with a
  pre-decoded buffer pool (no per-hit allocation) and unlock on first touch.

### 5. Mob motion is retargeted every 10 Hz delta with a jitter-sensitive duration (stop-start glide)
- **Severity:** med-high. **Size:** M. **Client-only** (server already sends `serverTime`).
- **Evidence:** `pixiOverlay.ts:3419-3430` -> `combat/combatRenderSmoothing.ts:nextCompanionRenderPosition`: on each new sample it starts a
  linear move from the CURRENT drawn position to the new target over `clamp(now - lastSampleMs, 50, 250)` ms. Combat deltas come at
  10 Hz (100 ms), so arrival jitter of +-30 ms changes the glide speed each segment (a short measured interval means a fast move,
  then a stall until the late packet) and the segment start is not the previous target (velocity is discontinuous at every delta).
  It is a companion smoother reused for world mobs (`MOB_RENDER_SNAP_M = 40`).
  Remote players use a proper timestamped buffer (`PLAYER_INTERPOLATION_DELAY_MS = 150`, `playerRenderSmoothing.ts:22`), so mobs and
  players are on different pipelines and different delays (mobs about 100 ms + one-way, players 150 ms), which matters when a player
  melees a mob in a party. **(jitter effect unverified at runtime)**
- **Best games:** fixed-delay snapshot interpolation (standard shooter-style netcode): render at `serverNow - 100-120 ms` between two
  timestamped samples, extrapolate briefly past the newest.
- **Fix:** keep a 3-sample ring per mob stamped with `message.state.serverTime`, render at `syncedNow - 110 ms` with linear
  interpolation, extrapolate up to 100 ms, snap on teleport. Reuse the same delay for the swing lag hint (the server already rewinds
  `RTT/2 + 100`, `App.tsx:6413`), so the hit prediction and the picture stay aligned. Consider COMBAT_DELTA_HZ 20 for mobs in
  combat only (bandwidth cost; check `deliveryPolicy.ts`).

### 6. Input buffer window is 150 ms of a 700-900 ms recovery, and a too-early press is silently dropped
- **Severity:** med. **Size:** S (client) / S (shared constant, touches server). 
- **Evidence:** `combat/swing.ts:press` returns `"ignored"` when more than `SWING_BUFFER_WINDOW_MS` (150 ms) remain; no visual or haptic
  cue. Server mirrors it: `combatEngine.ts:4273-4277` rejects `too_soon` beyond `SWING_BUFFER_EARLY_TICKS = 3`. At 700 ms recovery a
  mashing player loses presses in the first 550 ms. The recovery is also double what the arm animation covers (350 ms program, 700 ms
  recovery), so about 350 ms is idle standing with no animation or cue.
- **Best games:** Polished action games buffer roughly the last third of an attack and always shows when the next hit is available.
- **Fix:** raise `SWING_BUFFER_EARLY_TICKS` to 5-6 (250-300 ms; server and client share the constant, so deploy together); show a
  ready cue (the button ring already fills, add a pop/flash on ready, and a tiny weapon glint on the character); when a press is
  ignored, pulse the cooldown ring like the dash does (`dashClientState.denied()`).
- **Also:** the buffered press keeps the direction captured at press time (`swing.ts:press` stores `dirX/dirY`; flush at
  `App.tsx:6481-6485` sends it unchanged). For auto-aim taps re-run `autoAimDirection` at flush so a mob that moved in the last
  150-300 ms is still hit (S).

### 7. Responsiveness budget of the first swing (summary of 1, 3, 6)
- **Severity:** med (derived). With tap-on-lift (60-150 ms) + contact frame (175 ms) + RTT/2 for the echo, a first hit lands visually
  about 250-350 ms after the thumb touches; the best-feeling games are roughly 100-130 ms. Fix #1 + #3b brings it to about 100-130 ms.

### 8. Dash: single 3 s charge, no queue, thin screen feedback
- **Severity:** med. **Size:** S (feedback) / M (charges; touches server authority).
- **Evidence:** `dash.ts:11-19` 150 m / 150 ms / 3000 ms cooldown, i-frames 200 ms; a dash on cooldown is dropped
  (`JoystickMovement.tsx:~413 dashClientState.denied()`, plan says "nothing is queued"). The FX are procedural dust + streak
  (`ui/DashEffects.tsx`) and a pale-blue i-frame shimmer (`hitFeedback.ts:iframeShimmer`); no camera cue (no zoom punch, no shake,
  no brief time-scale), no sound, no haptic.
- **Best games:** Polished action games have multiple dash charges (regen about 1-2 s each) and a 100-150 ms input buffer; the best rolls are nearly
  free. With one 3 s dash and a 750 ms walk-out needed for telegraphs (`combat-feel.md` section 4), the dash is an emergency tool
  only, which is the stated design, but "dash cancels swing" (already good) deserves a second charge for rhythm.
- **Fix:** (a) short buffer: if the dash becomes ready within 150 ms of a press, queue it (client); (b) dash cue: small FOV/zoom punch,
  haptic, sound, brighter i-frame shimmer start; (c) design decision for later: 2 charges at about 2 s regen each.
- **Prediction note:** a swing pressed during a dash is predicted from the mid-dash rendered position (`App.tsx:6436` uses
  `renderPosition`) while the server buffers it until the landing (`combatEngine.ts:4268-4271`, `isSwingAttackerDashing`), so predicted
  flashes can be cancelled on SWING_RESULT. Predict from `dashClientState` predicted end instead (S, low frequency).

### 9. Normal hits have no screen response and lethal hits have no extra beat
- **Severity:** med. **Size:** S. **Client-only.**
- **Evidence:** screen shake only on combo finisher hit (`App.tsx:6478`), incoming hits at or above 12% max HP, and signature casts
  (`hitFeedback.ts:SHAKE_TUNING`, `pixiOverlay.ts:4510`). Ordinary swing hits: only 60 ms hold + 8 px push + flash. Shake is a CSS
  `translate3d` on the whole map host (`pixiOverlay.ts:4411-4425`), rounded to 0.5 px, so tile + overlay move together (good) but it
  exposes the container edge by up to 6 px, and `hitFeedbackStats` counters run every frame.
- **Fix:** add a very small (0.8-1 px, 60 ms) directional kick on every confirmed hit in the swing direction, shake 2x on kills, and
  keep the existing finisher shake. Hit stop on kill 90-120 ms. Optionally slightly overscan the host (`inset: -8px`) to hide shake
  edges.

### 10. Facing and aim readability: one front sprite, 6 px lunge, arc detached from the moving player
- **Severity:** med-low. **Size:** M (art) / S (arc).
- **Evidence:** player has no facing (`combat-feel.md` section 1(b): front sprite, no flip; the arm side follows aim x only,
  `playerAppearancePose.ts:184`). Lunge distance is `ATTACK_STRIKE_DISTANCE_PX = 6`, rotation 0 (`playerAppearancePose.ts:34-35`).
  The slash arc is spawned at the press-time world point (`swingEffects.ts:spawnArc` takes lat/lon once) so while walking at 125 m/s it
  stays behind the character for its 180 ms life. Mobs do not turn toward the player either (no horizontal flip in
  `updateRetainedMob`; **unverified at runtime, art may be front-view**).
- **Best games:** Action games commit a step forward on each attack (about 0.5-1 character widths) and the weapon trail follows the body.
- **Fix:** anchor the arc to the player's rendered position each frame (store the owner id, already kept in `ownerId`), raise the
  lunge to about 14-18 px on swing/finisher; show the aim sector briefly on tap-auto-aim as well (currently only while dragging).

### 11. Hitstop position pop on mobs
- **Severity:** low. **Size:** S.
- **Evidence:** `pixiOverlay.ts:3405-3408`: while a mob is held, its position is frozen but `companionMotion.startMs` keeps ticking, so
  when the hold ends progress has advanced by the hold length (60-90 ms of travel) in one frame. At mob speeds of tens of metres per
  second this is a few metres of snap. **(unverified at runtime)**
- **Fix:** shift `startMs` forward by the hold duration while held (or fold the hold into the sample clock the same way animations do).

### 12. Frame pacing and React churn
- **Severity:** low-med. **Size:** S each. **Client-only.**
- **Evidence:**
  - Per frame allocations in the overlay: `desiredMobIdsForPresentation` (`pixiOverlay.ts:688-713`) builds a new `Set` and runs
    `.filter().map()` every frame while presentation is ready; the flag-travel branch (`pixiOverlay.ts:~2335`) filters the full combat
    list twice. `combatStore.entities()` copies the map into an array on every call (`combatStore.ts:55`) and is called per swing press,
    per auto-aim tap, and from `refreshCombatUi` on every 10 Hz combat delta (`App.tsx:9766-9772`).
  - `JoystickMovement.tsx` calls `setPlant` and `setKnob` (React state) on every pointermove (`update`, lines 369-395) and drag
    (`onDrag`), so the stick re-renders at touch rate; `useSwingCooldownStyle` also subscribes to `swingClientState.revision` and
    re-renders per swing. **(cost unverified; measure with the React profiler or the existing perf probe)**
  - Reassuring: swing FX are pooled (`ARC_POOL_SIZE`, `SPARK_POOL_SIZE`), one Graphics with `clearGraphicsIfDrawn`, the swing layer
    skips when `hasActive` is false, and `clearLayer` is only used on scene resets (the earlier GraphicsContext leak). Damage floater
    Text objects are pooled by style key. I did not find another unpooled `Graphics`/`Text` created per hit, except the per-mob
    `createMobFlashSprite` (one sprite per mob that has ever flashed, destroyed with the mob).
- **Fix:** reuse a scratch Set/array for the mob id list; give `CombatStore` an iterator or a cached array invalidated on writes; drive the
  stick knob via refs and CSS variables (the component already uses `--kx/--ky`) instead of state.

### 13. Swing recovery pacing vs animation
- **Severity:** low (design). The owner chose 1.4 s (earlier) and now 700 ms recovery on purpose (`action-combat-retune-2026-10-12.md`).
  The audit point is only that the arm program (350 ms) ends 350 ms before the next swing is allowed, so the character stands in
  idle. A visible "weapon ready" bob or a held guard pose through the recovery would fill the gap without touching numbers.

## Things I checked that are fine

- **Swing is predicted instantly.** Pose, lunge, arc and predicted hits all start inside the same task as the press (`App.tsx:6405-6483`);
  the SWING message is sent first (`App.tsx:6417`), so the server sees it as early as possible.
- **Server swing resolution is immediate.** `resolveSwing` runs when the command dequeues, rewinds mobs by the client's lag hint
  (`RTT/2 + 100`, clamped to 250 ms) and flushes DAMAGE/SWING events in the same tick (`combatEngine.ts:4244-4290`, `4539`).
  The client draws mobs about 100 ms + one-way late, so the rewound hit test matches what the player saw.
- **Prediction is shared and cancellable.** The arc test is the shared `swingArcContains` against RENDERED mob positions; unconfirmed
  predicted hits are cancelled by `SWING_RESULT` (`cancelPredictedHit`), and the server DAMAGE flash is absorbed to avoid double flashes.
- **Input buffering exists.** One buffered press, released by a timer at the end of recovery and re-armed on correction
  (`App.tsx:6474-6489`, `swing.ts`). Hold and aim-drag repeat on the recovery cadence with a 50 ms retry (`AimAttackRepeater`).
- **Dash cancels swing recovery on both sides.** Client `swingClientState.dashStarted()` and server `notePlayerDashed` clear the
  recovery, and the arm swing is cancelled (`App.tsx:6376-6378`). Movement is not slowed or rooted during swings (confirmed: no swing
  hooks in `movement/`, `beginPlayerAction` only bumps counters), and the combat-feel pass measured 0% speed loss while swinging.
- **Walk/dash reconciliation.** The earlier t1513 pass fixed stale "stopped" samples, the lead cap pull-back and gap-drop resync
  freezes (`combat-feel.md`); `playerRenderSmoothing.ts` constants are sane (correction 80-150 ms, lead 150-600 ms).
- **Aim.** Tap auto-aim uses a 70 degree cone around the facing then nearest, with 18 px dead zone and hysteresis; the manual aim
  sector is shown while dragging.
- **Telegraphs.** `telegraphWindow.ts` anchors the end time once per cast using `remainingMs - one-way latency`, so batching and clock skew do
  not move the decal; windup lengths were retuned to walk-out times (`combat-feel.md` section 4, `telegraph-time.md`).
- **Hit juice maths.** Hitstop with catch-up never runs time backwards (`hitFeedback.ts:hitstopLag`), push eases out and back, incoming
  hits get a lighter hold (35 ms) so taking damage never feels sluggish, shake has settings and honours reduced motion.
- **Camera.** Combat zoom is a single rAF driver with smootherstep and no zoom-out, measured max zoom step 1.0x mean
  (`combat-zoom-smooth.md`); follow uses exponential smoothing with a safe-area steer. I found no fight between zoom and follow.
- **Dash FX exist** (dust, streak, afterimages, i-frame shimmer) and the cooldown pip is shown on the stick or button.

## Suggested order of work

1. #1 swing on touch-down + immediate hold repeat (S, biggest felt latency win).
2. #2 killing-blow number + death ghost (S-M, currently the most visible "bug").
3. #3 contact-frame sync and windup tuning (S-M).
4. #4 audio + haptics (M, needs asset choice).
5. #6 wider buffer + ready cue + re-aim on flush (S, one shared constant).
6. #5 timestamped mob interpolation (M).
7. #9, #10, #11, #12 polish batch (S each).
8. #8 dash charges only as a design decision (depth) after the above.

## Not verified / limits

- Nothing was run. In particular the killing-blow floater removal (#2), mob glide jitter (#5), hitstop pop (#11) and React render cost (#12)
  should be confirmed with a Playwright run of `combatFeel.spec.ts` or a perf probe before sizing the fixes.
- Real-phone thumb latency numbers (#1, #7) are estimates from typical tap durations, not measurements.
- I did not read the server mob AI or hitstun movement code beyond the swing path; mob "approach/retreat smoothness" and flinch were judged
  only from the client presentation.
