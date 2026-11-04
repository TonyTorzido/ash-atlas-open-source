# Action combat backbone: implementation plan

Worktree: `C:\Users\dev\Documents\worktrees\action-combat__t1499`
Branch: `feature/action-combat--from-t1499`, created from the tip of `feature/joystick-move--from-t1499` (3b0a882c3), which has the joystick, gamepad and dash work. Paths below are relative to the worktree root.

Goal: swing-to-hit melee, plus one ranged shot. It must be server-authoritative, feel instant on PC, mobile and gamepad, sit alongside the live queued auto-attack behind a flag, and cover PvE first with PvP designed in. Animation stays simple; the backbone has to be solid.

## Decisions taken for v1

The owner can change any of these later.

1. **Damage per swing:** `SWING_DAMAGE_FACTORS = [0.5, 0.5, 0.75]`, chosen for feel. That was about 2.3× the queued DPS at the original 300/300/450 ms recovery. Recovery is now 700/700/900 ms (about 0.76 base hits per second against the old auto-attack's 0.71), so the same factors give about 0.62× the queued DPS (average factor 0.583 × 0.76 vs 0.71); retune the factors if the owner wants parity. Parity would be `[0.25, 0.25, 0.4]`. It is a single tuning lever.
2. **Gamepad right stick in action mode:** it aims when it is deflected and a hostile is within 150 m. Otherwise it pans the camera.
3. **Movement:** keep the `MOVE_TO` lookahead. Velocity intent (`MOVE_DIR`) is a deferred follow-up.
4. **Gathering:** a swing does not interrupt gathering. Swings are rejected while `isMovementBlocked`.
5. **Mob windup:** a 450 ms melee windup applies to all melee mobs while the flag is on.
6. **Scope:** dungeons and interiors are out of v1. Overworld only.

## 0. Design in one paragraph

1. The client plays the swing instantly and predicts hits locally.
2. It sends one small `SWING` message: a world-space unit direction, a sequence number, and a bounded lag hint.
3. The server resolves the hit on the tick it processes the command. It tests mob positions rewound by the client's lag hint (capped), using an arc test in a local metric frame around the attacker.
4. Damage goes through the existing `resolveBasicAttack`/`applyDamage` path, so the matrix, stagger bonus, aggro, death and loot all work unchanged.
5. The server replies with a critical `SWING_RESULT`.
6. The server never trusts positions, combo index or timing from the client. It enforces recovery itself through `nextSwingTick`.
7. Movement stays on the existing `MOVE_TO` path, where the water, raft and leash rules already live.

## Verified facts the plan relies on

**Server movement and commands**
- `GameState.tick` steps players toward `target` at `PLAYER_SPEED_MPS`, which is 125 m/s. Melee range is 100 m; the dash covers 200 m.
- Commands flow `worldGameplayHandler` → `enqueueWorldCommand` → `WorldRuntime.processCommand`. They are deduped by `playerId:requestId`, capped at 32 per player, and go stale after 2 s.

**Combat delivery**
- Combat deltas flush at 10 Hz (`COMBAT_DELTA_HZ`). Events ride inside them as `replaceable-combat`.
- `addMobTelegraph` already has a same-tick flush flag, `telegraphFlushPending`.

**Spatial lookup and mob positions**
- `SpatialHashGrid` uses 128 m cells, and `grid.query()` returns sorted id arrays. `nearbyEntityIds()` wraps it.
- Mob positions are written at `commitMobPhysicalPosition`, at the chase step in `processChases`, and in `placeMobAtFirstTraversable`/`pushAwayFrom`.

**Damage path**
- `applyDamage` already handles `isEntityInvulnerable` (the dash i-frames), stagger multipliers (`DODGE_REWARD`), aggro ownership and `defeat()` (loot and XP).
- `resolveBasicAttack(attacker, target, embeddedAction, ctx)` is the per-hit path: it applies the live PvE matrix and procs.
- `startAttack` (around lines 3828-3850) shows the session and aggro claim sequence to copy.

**Mob knockback and stun**
- `pushAwayFrom` → `placeMobAtFirstTraversable` already exists.
- Mobs have `special.staggerUntilTick` and `stunUntilTick`, and `isMobMovementHeld` gates chase.

**Client**
- Dash prediction is the template to copy: `movement/dash.ts`, `App.requestLocalDash`, and the `useWorldFrameHandler` handling of `DASH_ACCEPTED`.
- Mob hit flash exists: `mobActionAnimation.ts` has a 120 ms `hitFlash` driven by `hitElapsedMs`.
- `attackStrikeMotion` gives a 6 px directional lunge.
- `CombatPresentationController` turns `ATTACK_LANDED` into arrow impacts for bow appearances.
- Perf upload (`perf/perfUpload.ts`, every 10 s, developer sessions only) lands in the server log as `perf-sample`. The server logs `perf-server` once a minute.

**Classes:** the class rework is not in this worktree, because `CLASS_IDS` still holds the old ids. The ranged proof therefore keys off the active weapon category, not the class.

## 1. Input to server protocol

### `SWING` (client → server), family `world-gameplay`

```ts
// packages/shared/src/protocol/worldSchemas.ts
export const swingMessageSchema = z.object({
  type: z.literal("SWING"),
  requestId: requestIdSchema,            // queue dedupe, same as DASH
  seq: z.number().int().nonnegative(),   // per-connection monotonic; stale/dup dropped
  dirX: z.number().finite().min(-1.05).max(1.05),  // world-space unit vector, east
  dirY: z.number().finite().min(-1.05).max(1.05),  // north (same convention as DASH)
  lagMs: z.number().finite().min(0).max(1_000)     // client rtt/2 + mob render delay; server clamps
}).strict();
```

- **Validation:** the unit-length check goes in the `clientMessages.ts` superRefine, next to the DASH check. Reuse `isDashDirectionUnit`.
- **What it leaves out:** no combo index, no target id and no position. The server works out the combo from its own timing and echoes it back.
- **Size and rate:** about 90 bytes. At most one message per swing recovery (3/s sustained), never one per frame.

### `SWING_RESULT` (server → client), delivery `critical`

```ts
{ type: "SWING_RESULT"; requestId: string; seq: number; serverTick: number;
  comboIndex: 0 | 1 | 2; nextSwingAt: number /* server epoch ms */;
  hits: Array<{ entityId: string; damage: number; currentHealth: number }>;   // max 4
  rejected?: "too_soon" | "dashing" | "unavailable" | "disabled" }
```

Damage numbers are NOT drawn from this message. They still come from the existing `DAMAGE` events (floaters). `SWING_RESULT` only confirms or cancels predicted hit effects and corrects the combo and cooldown.

Register it in:
- `worldServerSchemas.ts`
- `worldMessages.ts`
- `serverMessageFixtures.test.ts`
- `deliveryPolicy.ts`, as `"critical"`
- client `clientFrameRouter.ts`, as `"world"`
- the type list in `useWorldFrameHandler.ts`

### `SWING` combat event (for other players)

- Add `"SWING"` to `CombatEventType` in `packages/shared/src/combat.ts`.
- It uses existing optional fields: `position` (origin), `radiusM`, and `abilityId: "swing_0" | "swing_1" | "swing_2" | "shot"`. Add one new optional field, `facingDegrees?: number`.
- Remote clients draw the slash arc from this event. The local client ignores it, because it already predicted the swing.

### Movement

Keep the `MOVE_TO` lookahead. Reduce rubberiness within that path:
- send interval 100 ms
- lookahead = speed × 0.45 s
- the server accepts moves during swing recovery, so a swing never locks movement

### Registration checklist (mirror DASH)

- `protocol/clientMessages.ts`: the dispatch union and the superRefine
- `realtime/messageRouter.ts`: `SWING: "world-gameplay"`
- `realtime/connectionMessageAdmission.ts`: add to `WORLD_ONLY_DUNGEON_MESSAGE_TYPES` (overworld only in v1)
- `game/worldCommandQueue.ts`: new `kind: "swing"`
- `protocolCompatibility.ts`, if it lists world message types

## 2. Server hit resolution

### Constants

All in `packages/shared/src/actionCombat.ts`, the one place, like `dash.ts`.

```ts
export const SWING_RANGE_M = 130;            // melee range 120 + attacker favour
export const SWING_HALF_ANGLE_DEG = 60;      // 120 degree arc
export const SWING_POINT_BLANK_M = 25;       // inside this the angle test is skipped
export const SWING_TARGET_RADIUS_M = 20;     // mob body radius for the arc test (boss x2)
export const SWING_MAX_TARGETS = 1;          // nearest first by edge distance; 1 = single target, raise to bring cleave back
export const SWING_RECOVERY_TICKS = [14, 14, 18] as const;   // 700/700/900 ms at 20 Hz (full combo 2.3 s, ~0.76 hits/s)
export const SWING_COMBO_RESET_MS = 1300;    // idle longer than this -> combo 0 (above the longest recovery plus slack)
export const SWING_BUFFER_EARLY_TICKS = 3;   // a press up to 150 ms early is buffered (one slot)
export const SWING_DAMAGE_FACTORS = [0.5, 0.5, 0.75] as const;
export const SWING_HITSTUN_TICKS = 4;        // 200 ms
export const SWING_KNOCKBACK_M = [0, 0, 0] as const;      // off for now (returns later as a perk); 0 m is skipped, hitstun stays
export const SWING_LAG_COMP_MAX_MS = 250;
export const POSITION_HISTORY_TICKS = 8;     // 400 ms ring, covers the cap
export const SHOT_RANGE_M = 300;
export const SHOT_WIDTH_M = 30;
export const SHOT_RECOVERY_TICKS = 20;                   // 1000 ms, ~0.75 shots/s
export const MOB_MELEE_WINDUP_MS = 450;
```

Pure math functions, shared by the server resolve and the client prediction. They are allocation-free and write into an `out` object:

```ts
/** Local metric frame: east = dLon*cos(lat0)*R*rad, north = dLat*R*rad. */
export function toLocalMeters(lat0, lon0, cosLat0, lat, lon, out: {x:number;y:number}): void
export function swingArcContains(dirX, dirY, x, y, targetRadiusM): boolean
export function shotLineContains(dirX, dirY, x, y, targetRadiusM): number | null // distance along, or null
```

### Resolution flow

The pure part goes in `apps/server/src/game/combat/swingResolver.ts`; the engine method is `CombatEngine.resolveSwing`.

1. **Gate.** All of these must hold:
   - the flag is on (`options.actionCombatEnabled?.()`)
   - the attacker is alive and not stunned (`requireNotStunned`)
   - the attacker is not dashing. `options.isEntityInvulnerable` is the dash signal. A swing during a dash is buffered and runs when the dash lands, like `pendingTargetAfterDash`.
   - `currentTick >= nextSwingTick`. A press up to 3 ticks early is buffered (one slot); anything earlier is rejected with `too_soon`.
2. **Combo.** `comboIndex = (now - lastSwingAtMs <= SWING_COMBO_RESET_MS) ? (lastCombo + 1) % 3 : 0`.
3. **Cancel the queued auto-attack** for this player (`cancelAttack`, clearing the target and the scheduled attack), so swings and auto-attack never stack DPS. Call `beginPlayerAction` once per swing.
4. **Rewind.** `rewindTicks = round(clamp(lagMs, 0, 250) / 50)`.
5. **Candidates.** Make one query per swing: `grid.query(attacker.position, SWING_RANGE_M + SWING_TARGET_RADIUS_M * 2)`. A candidate must be:
   - a `mob`, alive, and not a companion or undead ally
   - valid under `isAttackPairValid`
   - not owned by another non-party session (the same rule as `startAttack`; honour `isSharedMobCombat`)

   For each valid candidate, take `positionAtTick(mob, currentTick - rewindTicks)`, convert it to local metres, and test `swingArcContains`. Keep the `SWING_MAX_TARGETS` nearest (now 1, by distance to the target's edge) by insertion into a fixed-size array, with no sort allocation.
6. **Per hit.**
   - Claim aggro and session membership exactly as `startAttack` does (ensure the session, `claimMobAggro`, enemyIds) BEFORE damage, so death, loot and XP route through the session.
   - Then call `resolveBasicAttack(attacker, mob, true, ctx)` with the swing factor applied through a new optional `AttackResolutionContext.damageMultiplier`, applied where `basicOrResetMultiplier` is read.
   - If the mob is still alive and is not a boss: set `special.hitstunUntilTick = currentTick + SWING_HITSTUN_TICKS` and call `pushAwayFrom(attacker.position, mob, SWING_KNOCKBACK_M[combo])`.
7. **Bookkeeping.**
   - Set `nextSwingTick = currentTick + SWING_RECOVERY_TICKS[combo]`, plus `lastSwingAtMs` and `lastCombo`.
   - Emit the `SWING` event with origin, `facingDegrees` and `radiusM`.
   - Set the same-tick flush flag (rename `telegraphFlushPending` → `immediateFlushPending`) so DAMAGE events ship this tick instead of up to 100 ms later.
   - Return the hits for `SWING_RESULT`.

**Timing in ticks:**
- **Windup:** 0 server ticks. The client's 80 ms windup animation absorbs network latency.
- **Active:** the tick the command is processed on.
- **Recovery:** `SWING_RECOVERY_TICKS`.
- **Later:** a finisher windup scheduled through the existing `scheduler` is not in v1.

### Position history ring (PvP reuses it)

File: `apps/server/src/game/combat/positionHistory.ts`.

- **Storage:** each entity gets a preallocated `Float64Array(POSITION_HISTORY_TICKS * 3)` holding (tick, lat, lon), plus a head index. It is created on first write and pooled on removal.
- **Writes:** `record(entityId, tick, lat, lon)`. Route every mob position write site through one `setMobPosition` helper that calls it: `commitMobPhysicalPosition`, the chase write in `processChases`, and `placeMobAtFirstTraversable`/`pushAwayFrom`. Grep for all of them.
- **Reads:** `positionAtTick(entity, tick, out)`.
  - If there is no history, or the tick is older than the oldest sample, it returns the current position.
  - Otherwise it interpolates linearly between the neighbouring samples.
- **Cost:** zero per-tick cost for idle mobs.
- **Players:** get the same `record` call in `syncPlayer` later, once PvP is turned on (flag-gated).

### Favour-the-attacker and anti-cheat

- **Positions:** never read client positions. The direction is a unit vector (enforced by the schema).
- **Lag hint:** `lagMs` is clamped to 250 ms. The worst rewind error is 25 m at a mob speed of 100 m/s, against a 130 m arc.
- **Ordering:** `seq` must be greater than the last accepted one. Duplicate `requestId`s are already dropped by `WorldCommandQueue`.
- **Rate:** the `nextSwingTick` gate plus one buffered slot. Anything beyond that is rejected with `too_soon` and logged (`swing_rejected`).
- **Server-only values:** range, arc, cleave cap and damage factors are all server constants.
- **Scope:** reject swings in dungeons and interiors in v1.

### Metrics and logs

- **Engine metrics:** add `swingsResolved`, `swingHits`, `swingRejected`, `swingResolveMsMax` and `swingResolveMsTotal` to `CombatEngine.metrics`. They surface in the once-a-minute `perf-server` log line (`application.ts` ~2429).
- **Per-swing log:** `swing_resolved {playerId, seq, combo, hits, rewindTicks, queueMs}`, behind the `SWING_DEBUG_LOG` env (off by default).
- **Latency trace:** add a `gameplayLatencyTrace` record, like `dash_accepted`.

## 3. Interaction with existing systems

- **Flag:**
  - `ACTION_COMBAT_ENABLED: booleanFromEnv.default(false)` in `apps/server/src/config.ts`.
  - It reaches the engine as `options.actionCombatEnabled` and is echoed in `WELCOME` as `actionCombat?: boolean`.
  - On the client, `movement/actionCombatPreference.ts` is modelled on `joystickMovementPreference.ts`.
  - The effective mode is the server flag AND the preference. The preference defaults to on when the server flag is on, so the owner can compare against queued combat in the same runtime.
- **Living alongside queued auto-attack:**
  - The server accepts both. A `SWING` cancels the player's queued attack, and a `START_ATTACK` resets `nextSwingTick` to now.
  - In action mode the client stops sending `START_ATTACK` from mob taps; tapping swings toward the mob instead.
  - Aggressive mode is hidden in action mode.
- **Uniform cadence:** mobs keep the 1.4 s beat and the alternating phase, untouched. Player swing DPS is balanced only through `SWING_DAMAGE_FACTORS`, which is a per-hit lever.
- **I-frames:** the dash i-frames already skip mob damage. A swing during i-frames is buffered until the dash lands. Swings have no i-frames of their own.
- **Telegraph and stagger:** `applyDamage` already applies the 1.5 stagger melee factor. Nothing to add.
- **Aggro:** claimed per hit, as in `startAttack`. Mobs retaliate through the existing AI.
- **Death, loot and XP:** unchanged.

## 4. Client feel with minimal latency

New module: `apps/client/src/combat/swing.ts` (`SwingClientState`, modelled on `DashClientState`). It holds:
- a `pending` map by requestId: pressedAtMs, seq, dir and predictedHitIds
- the local `comboIndex` and `lastSwingAtMs`, using the same rule as the server
- `nextSwingAtMs`
- one buffered input slot
- listeners for the HUD

Also add `swing(dirX, dirY, lagMs)` to `client/domains/worldGameplayClient.ts`.

Per press, in `App.requestLocalSwing(direction)` (mirrors `requestLocalDash`):
1. **Too soon:** if `now < nextSwingAtMs`, buffer the press if it is within 150 ms of the cooldown ending, otherwise ignore it. No message is sent.
2. **Send:** facing = the aim direction. Send `SWING` with `lagMs = round(rttMs / 2 + 100)`.
3. **Instant local animation:** `PlayerAppearancePoseController.beginLocalSwing(playerId, now, direction)`. The `attack_action` pose and `attackStrikeMotion` start now, not on `ATTACK_LANDED`. A pooled slash arc effect is spawned.
4. **Predicted hits:** run the shared `swingArcContains` against the **rendered** mob positions and take the nearest `SWING_MAX_TARGETS` (now 1). For each one:
   - start the hit flash now
   - start a 2-frame hitstop, which freezes animation sampling but not the render loop
   - add a 6 px knockback nudge that decays over 150 ms
   - spawn a pooled spark
5. **On `SWING_RESULT`:**
   - confirmed hits keep their effects
   - predicted hits that the server missed get their flash and nudge cancelled
   - correct `comboIndex` and `nextSwingAtMs` from the server
   - record `pressToResultMs` in the perf metrics
   - damage floaters appear from `DAMAGE` events, as today
6. **Dash cancel:** a dash is allowed at any time after a swing press. The dash clears `nextSwingAtMs`, on the client and on the server.
7. **Remote players:** the `SWING` combat event drives the same arc effect and pose through `CombatPresentationController.enqueueCombatEvents`.

**Facing with the single front-facing pose:**
- the arc effect rotates to the facing direction
- the lunge goes in the facing direction
- the arm side is left or right according to the facing x

## 5. Mob behaviour minimums (flag-gated)

- **Approach:** the existing chase is enough.
- **Windup:**
  - When the flag is on, `resolveAttack` for a melee mob (range ≤ 100 m) first calls `addMobTelegraph(mob, "melee_windup", {kind:"cone", origin, facingDegrees, rangeM: attackRangeM, angleDegrees: 90}, MOB_MELEE_WINDUP_MS)`.
  - It then reschedules the actual strike 9 ticks later, with a `special.pendingBasicStrike` flag.
  - The strike only lands if the target is still inside the cone. Moving away or dash i-frames dodge it.
- **Hit reaction:** `special.hitstunUntilTick` (200 ms) is added to `isMobMovementHeld`. `resolveAttack` reschedules the strike of a mob that is in hitstun.
- **Knockback:** currently off (`SWING_KNOCKBACK_M` is 0, the push is skipped). When on, it is done on the server through `pushAwayFrom` (traversability-checked). A 12–30 m knockback stays under the client's 40 m snap limit, so it interpolates instead of snapping.

## 6. Controls per platform

**PC**
- WASD to move (already built).
- Mouse aim: each frame, the direction from the player's screen point to the cursor, converted to world space.
- Left click swings in action mode. It goes through `worldMapClickArbitrator`, so clicks on UI, popups and interactables keep their meaning.
- Right click or double-click moves. Space dashes (already built).

**Mobile**
- An attack button sits next to the dash button.
- Tap auto-aims at the nearest alive hostile within `SWING_RANGE_M`, falling back to the last movement bearing.
- Drag aims by hand. While dragging, a ground sector indicator (130 m × 120°) shows the arc, and releasing swings.

**Gamepad**
- In action mode, X swings when a hostile mob is within 150 m or the player is engaged in combat. Otherwise X stays the nearest quick action.
- Aim priority: the right stick if deflected, then the left stick, then the nearest mob.
- The right stick aims while a mob is in range and pans the camera otherwise.
- Hold-X Aggressive is hidden in action mode.
- A dashes (already built). RT keeps tap-at-cursor.

**Ranged proof**
- The server picks `shot` when the active weapon's category is `ranged_weapon`.
- It is a hitscan line, `SHOT_RANGE_M` × `SHOT_WIDTH_M`, hitting only the first mob along the line, with 20 ticks (1000 ms) of recovery and a 0.75 damage factor.
- The client draws the existing bow projectile flying 300 m over 150 ms, then the impact.

## 7. Performance budget and measurement

**Server**
- One grid query and at most about 50 candidate tests per swing, in local-frame math.
- Target under 0.05 ms per swing.
- Zero per-tick cost for idle mobs.
- No per-swing allocations beyond the candidate array from the grid query.
- Measured through `perf-server`.

**Client**
- Pooled arc effects (max 8) and sparks (max 16) in one `Graphics` layer, at most 2 extra draw calls.
- Hit flash and nudge are per-sprite property writes.
- No React state on the hot path.
- Target 60 fps on mid phones in the packed preview build.
- Measured through the 10 s `perf-sample` upload, with new fields: `swings`, `swingPressToResultP95Ms`, `swingPredictedHits`, `swingCancelledHits`, `swingDrawCalls`.

The owner never reports numbers; they are read from the runtime server log.

## 8. Phases

Each phase is one deliverable. Commit at the end, with a checkpoint commit if a phase runs long. PC can swing after Phase 3.

| # | Goal | Scope | Acceptance |
|---|------|--------|-----------|
| 1 | Shared contracts, flag and protocol (`actionCombat.ts` + test, the schemas, fixtures, WELCOME field, config, router, admission, delivery, queue kind). Demote the dash info logs to debug first. | server | Typecheck passes. Schema tests pass: a valid SWING is accepted, a non-unit direction is rejected, lagMs > 1000 is rejected. |
| 2a | Engine: `positionHistory.ts`, pure `swingResolver.ts`, `resolveSwing`, the `setMobPosition` helper, hitstun, knockback, `immediateFlushPending`, metrics | server | Engine tests: in-arc hit, behind miss, point-blank ignores angle, cleave cap (`SWING_MAX_TARGETS`, now 1) nearest, rewind hits the old position, recovery gate plus buffer, other-session mob skipped, dead and invulnerable skipped, knockback, hitstun holds chase, damage factor, defeat through the session |
| 2b | Wire the handler, runtime, `SWING_RESULT`, logs and perf-server fields | server | Integration tests: a swing round-trip against a dev-spawned training_dummy, a swing cancels a queued attack, a swing during a dash lands after the dash, a dungeon rejects SWING |
| 3 | Client input and prediction core; PC playable | client | Combo and buffer unit tests. In the running game: a click gives an instant pose plus floaters, and press-to-result appears in perf-sample. |
| 4 | Hit feel: predicted flash, hitstop, nudge, spark, slash arc, confirm and cancel, dash cancel, remote SWING event | client | A predicted miss is cancelled; pool caps hold; the draw-call delta is ≤ 2; the packed phone build holds 60 fps. |
| 5 | Mobile attack button: tap auto-aim, drag aim with the ground sector | client | Aim bearing unit test; phone link check (no native scrollbars, no X glyph) |
| 6 | Mob minimums: 450 ms melee windup cone, hitstun delaying mob strikes | server | A strike lands only if the target is still in the cone; a dash dodges it; hitstun reschedules. The decal is visible in the pane. |
| 7 | Ranged proof: hitscan `shot` plus projectile | server, then client | Only the first mob on the line is hit; the arrow flies |
| 8 | Simple arm swing program on the existing rig (350 ms, 3 keys) | client | Renderer test; visual check at 1:1 |
| 9 | Measurement and tuning summary | client | Report p95 press-to-result, fps and tick ms |

**End-to-end check (every client phase):**
- Run the runtime with `ACTION_COMBAT_ENABLED=1`.
- In the running game, `DEV_SPAWN_MOB training_dummy` next to the player, swing, and read `SWING_RESULT` and the floaters.
- Fake gamepad: `navigator.getGamepads = () => [fakePad]` with a standard-mapping pad object, then `window.dispatchEvent(new Event("gamepadconnected"))`. Flip `buttons[2].pressed` for X and `axes[0..1]` for the stick.

## 9. Risks

- **Scattered mob position writes:** a missed write site leaves the rewind stale on that path. Use one `setMobPosition` helper and a test that moves a mob through each path.
- **Dropped damage numbers:** `COMBAT_DELTA` is replaceable, so DAMAGE events can be dropped under backpressure (same as live). `SWING_RESULT` is critical, so prediction never desyncs.
- **Client-supplied lag hint:** it is bounded to 250 ms. If logs show abuse, switch to a server-measured RTT.
- **Proc rolls:** with `SWING_MAX_TARGETS` at 1 there is one proc roll per swing. If cleave is raised again, four hits means four proc rolls; cap procs to the first hit if balance needs it.
- **Mobile fps:** judge it only on the packed preview build.
- **Deploy lane:** the protocol changes ride the careful deploy lane.
