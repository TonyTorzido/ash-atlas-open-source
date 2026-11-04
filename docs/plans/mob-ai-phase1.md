# Mob AI Phase 1 under action combat: tokens, surround slots, separation, rhythm

Status: design decisions folded in (section 0). Chunks 1-5 plus the spacing follow-ups are built (flag default off); build notes and corrections are in sections 8-10.
Worktree: `C:\Users\dev\Documents\worktrees\mob-ai__t1506`, branch `feature/mob-ai--from-t1506` (from `test/t1506`).
All paths are relative to the worktree root. Line numbers are for `apps/server/src/game/combat/combatEngine.ts` unless a file is named.
Units: game metres. Melee range 100 m, player speed 125 m/s, mob body radius 20 m, server tick 20 Hz (50 ms, 6.25 m per tick at player speed).

Everything below applies only when `ACTION_COMBAT_ENABLED` is on and a new sub-flag `MOB_TACTICS_ENABLED` is on (default off, so it can ship dark). Flag off means today's behaviour, byte for byte.

## 0. Design decisions and defaults

| # | Question | Decision |
|---|---|---|
| 1 | Pack pressure up about 3x | Accepted. Launch `MOB_TACTICS_DAMAGE_FACTOR` at 1.0. |
| 2 | Melee tokens | 2. |
| 3 | Epic and legendary cost | 2 tokens. |
| 4 | Ranged telegraph | **Yes, in Phase 1.** Aim line, then a dodge check on release. See 2.12. |
| 5 | Wait ring | **Pulled in to 150 m** (factor 1.5). One 20 m step forward puts a waiter inside the 130 m swing reach. A mob the player engages grabs a token and fights back. See 2.13. |
| 6 | Bosses, raid mobs, dungeons | Stay on the old system in Phase 1. |
| 7 | Per-mob rhythm | **Defaulted:** every mob on the same 1.4 s cycle at launch; per-archetype overrides exist but are empty. Matches the uniform attack speed rule. |
| 8 | Free hits on waiters (was Q5 concern) | Resolved by 5: waiters inside 130 m can be hit, and being hit makes them fight. |
| 9 | Any `combatSeparationM: 0` mobs meant to overlap | **Defaulted:** none are exempt in Phase 1. Revisit if a swarm archetype looks wrong. |
| 10 | Strafe on the ranged ring | **Defaulted:** ranged mobs hold still while waiting (no strafe) so aim lines stay readable. |

## 1. Current state (what is wrong and where)

### 1.1 The PvE queue (the main cause)

| What | Where | Finding |
|---|---|---|
| Membership | `trackEnemy` 14034, `appendEnemy` 14041, `claimMobAggro` ~14058 | `session.enemyIds` (who owns loot/XP/aggro) and `session.enemyQueue` (turn order) are separate. Cap `MAX_PVE_ENEMY_QUEUE_SIZE` = 128 (`combat.ts:122`). |
| Turn engine | `processPveSessions` 14414, `resolveEnemyOpportunity` 14565 | One call resolves **one** enemy and `break`s (14646-14660). Then `completeEnemyAction` 14701 flips the phase back to `waiting_player`. |
| Cursor | `queueCursor` field 859, rotation 14584-14602 | Round robin. Mobs out of range are removed and set to chase; new arrivals are skipped one turn. |
| Beat | `PVE_TURN_STEP_MS` = 700 (`combat.ts:84`) = `BASIC_ATTACK_INTERVAL_MS` (1400, `combatConstants.ts:1`) / 2 | Player turn and enemy turn alternate every 700 ms, so **one mob attack per 1.4 s per player, however many mobs**. |
| Phases | `PveCombatPhase = waiting_player / enemy_pending` (`combat.ts:135`) | Also in the wire schema (`protocol/combatEquipmentServerSchemas.ts:203-206`: `enemyQueue`, `queueCursor`, `phase`). The client reads none of these outside tests. |
| Windup on the queue | `beginSessionEnemyWindup` 14552, windup start 14500-14510 | The telegraph is bolted on: it starts 450 ms before the queued turn and only for the mob at the cursor. |
| Session end | `maybeEndPveSession` 14384 | Depends on `enemyIds` and `pursuingEnemyIds`, **not** on the queue. Good: an empty queue does not end a fight. |

### 1.2 Movement and stacking

- `processChases` (6822) sets the destination to `BASIC_ATTACK_APPROACH_M` (98 m, `combat.ts:101`) from the target, along the mob's own approach line (6872-6876). Mobs from the same side converge on the same point. When `distance <= attackRangeM` the chase ends (6865) and the mob just stands there.
- The only separation is `moveMobWithPackSeparation` (12257). It works only for mobs with a `packId` and `combatSeparationM > 0` (mostly 0-25 in `mobDefinitions.ts`, one 200), only while chasing, and pushes by at most half a step.
- Nothing keeps a mob on a slot once it has arrived. Nothing moves a waiting mob when the player moves except the 5 m hold buffer (`MOB_ATTACK_HOLD_RANGE_BUFFER_M`, `combat.ts:112`) that sends it back to chase.
- `flankSlotPosition` (`mobSpecialBehaviors.ts:449`) is a pure function: even spacing, fixed +45 degree offset, radius `CAVE_RAPTOR_POUNCE.flankRadiusM`. Its **only** caller is `processRaptorFlank` (9608, line 9617), and only for `cave_raptor`, as a teleport-style pounce hop (`placeMobAtFirstTraversable`). Reusable as geometry, not as a system.

### 1.3 The melee windup (keep, reuse)

- `usesMeleeWindup` 12167: flag on, mob attacker, player target, range <= 100 m, not a companion dog, not undead. Ranged mobs (range up to 300 m, `RANGED_ATTACK_RANGE_M`) never wind up.
- `beginMeleeWindup` 12190 stores `special.pendingBasicStrike` and adds a 90 degree cone telegraph (`MOB_MELEE_WINDUP_MS` 450, `actionCombat.ts:57-67`).
- `resolvePendingMeleeStrike` 12207: cone test at the strike tick, else a `DODGE` event plus a zero `DAMAGE` event. Dash i-frames (`DASH_IFRAME_MS` 200) also dodge.
- `pendingMeleeStrikeFor` drops a strike aimed at a different target (this is the target-swap behaviour we want).
- Hitstun (200 ms, `SWING_HITSTUN_TICKS`) defers the strike (`resolveOrphanedMeleeStrikes` 12236, `resolveAttack` hitstun branch).

### 1.4 The separate `scheduleAttack` path (investigated)

`scheduleAttack` (16867) puts a mob or player on the shared scheduler; `resolveAttack` (15866-16177) fires it. It has its own per-entity cadence (`nextEligibleAttackTick`, `attackIntervalTicks` = 1400 ms for nearly every mob), **no queue and no beat**. It has its own copy of the windup logic (15934-15992) and its own chase retry.

Who feeds it for a mob attacker:

| Feeder | Where | Used for |
|---|---|---|
| `directMobTarget` | 5751 (callers 9415, 9463, 9540, 9674) | Scripted pulls: smith rubble, boss wake, cultists, Provoke skill. |
| `retaliateAgainstUndead` | 9026 | A mob turning on a necromancer minion. |
| `establishRetaliation` | 16179 | A mob hit by something that is not a player (pet, undead). |
| Shared mob combat | `application.ts:1256` `isSharedMobCombat` | Overworld raid bosses: they strike through `resolveAttack` (the meleeWindup test comment says so). |

Findings:
1. For ordinary mobs on players it is **not used**: `engageHostileMob` (12120) calls `invalidateScheduledAttack`, and the session queue owns the turn.
2. It is a second, uncoordinated attacker. A mob that is both in a session queue and given `directMobTarget` (Provoke does this) can attack from both paths. This is an existing double-attack hazard that tokens will close for the mobs we manage.
3. It stacks the same way as the queue (no slots, no separation).
4. Phase 1 decision: **ordinary mobs on players move to tactics; the other feeders stay as they are** (bosses, shared raid mobs, mobs targeting pets or undead). `directMobTarget` hands a managed mob to tactics instead of calling `scheduleAttack`.

### 1.5 Client countdown

`apps/client/src/map/mobAttackCountdown.ts` draws a badge for `aiPresentation.phase` = `acquiring` or `disengaging`. Those come from the **world mob AI** (`mobAiPresentation` 17261: the aggro acquisition delay and the leave-combat grace timers), not from the attack queue. So the badge keeps working untouched. It never showed queue state.

### 1.6 Other facts the design relies on

- Action combat is overworld only: `isSwingUnavailable` (4195-4204) refuses swings in `interior:` regions. Dungeons stay on the queue in Phase 1.
- Mob position writes go through `setMobPosition` (6438), which also feeds the lag-compensation history (`POSITION_HISTORY_TICKS` 8). Tactics must write positions only through it.
- Combat deltas flush at 10 Hz (`COMBAT_DELTA_HZ`), so extra mob movement does not raise wire cost beyond one position per dirty mob per delta.
- Client smoothing (`apps/client/src/combat/combatRenderSmoothing.ts`) interpolates linearly between samples and snaps only past `MOB_RENDER_SNAP_M` = 40 m. Every tactics step is at most mob speed (about 6 m per tick), so it never snaps.
- Tick order (`beginTick` 4447-4458): swings, class runtime, `processMobRetreats`, `processWorldMobAi`, `processChases`, `processMobSpecials`, `reconcilePveEnemyMembership`, `processPveSessions`, orphaned strikes.
- Player side (parallel branch, not touched here): nearest-target melee, 130 m reach, swings 700/700/900 ms, no knockback, hitstun kept. Engage ring (85 m) is inside the 130 m reach; the wait ring (150 m) is just outside it, so a short step in lets the player pick a fight with a waiter (2.13).

## 2. Design

### 2.1 Where it lives

- New shared file `packages/shared/src/mobTactics.ts` (exports through the package index like `actionCombat.ts`/`dash.ts`): **all constants**, the rhythm derivation, token costs, and the pure ring geometry. No engine types.
- New server file `apps/server/src/game/combat/mobTactics.ts`: `MobTacticsCoordinator` (token ledgers, slot assignment, per-mob step), pure and unit-testable, driven by the engine through a small interface. The engine file is 17.7k lines; nothing new goes into it beyond hooks.
- Engine gate `usesMobTactics(mob, target)`:
  `actionCombatEnabled() && MOB_TACTICS_ENABLED && mob.kind==="mob" && target.kind==="player"` and not boss, not `companionDogId`, not `undead`, not `isSharedMobCombat`, and the player's region is not `interior:`. Everything that fails the gate keeps today's path.

### 2.2 Data model

```ts
// packages/shared/src/mobTactics.ts (types)
type TacticsPhase = "approach" | "wait" | "windup" | "strike" | "recover" | "cooldown";
type TacticsPool = "melee" | "ranged";

type MobRhythm = {             // per mob, derived once at spawn
  windupMs: number;            // telegraph length (melee), 0 for ranged in Phase 1
  recoverMs: number;           // punish window, no attacks, back-off step
  cooldownMs: number;          // token-free rest before it may ask again
  backoffM: number;            // total back-off distance during recover
  jitterPct: number;           // +-% applied to cooldown, seeded by entityId
};

// per mob, on MobSpecialState (transient, never persisted)
type MobTacticsState = {
  phase: TacticsPhase;
  phaseEndTick: number;
  ring: "engage" | "wait" | "outer";   // outer = ranged ring
  slotAngleDeg: number;                // world-space bearing from the target to the slot
  slotLayer: number;                   // 0 normally, +1 when the ring is full
  waitingSinceTick: number;            // fairness clock, reset on token release
  joinedTick: number;                  // for the arrival grace
  strafeDir: 1 | -1; strafeFlipTick: number;
  holdsToken: boolean;
};

// per target player, on the engine, rebuilt lazily, never sent to clients
type TokenLedger = {
  playerId: string;
  meleeInUse: number; rangedInUse: number;          // points, not mobs
  holders: Map<string, { cost: number; pool: TacticsPool; grantedTick: number }>;
  nextLandingTick: number;                           // readability gap cursor
  roster: string[];                                  // managed mob ids, sorted for determinism
};
```

Note: the ledger is keyed by the **target** player, so a mob that swaps target moves ledgers.

### 2.3 Constants (all in `packages/shared/src/mobTactics.ts`)

| Constant | Value | Why |
|---|---|---|
| `MOB_TACTICS_MELEE_TOKENS` | 2 points | Target is about 2-3. Two keeps hits dodgeable. Raise to 3 if too soft. |
| `MOB_TACTICS_RANGED_TOKENS` | 1 point | Separate pool; one shot at a time. |
| `MOB_TACTICS_TIER_COST` | common 1, uncommon 1, rare 1, epic 2, legendary 2 | Elites eat the pool, so grunts back off while an elite swings. Uses `MobChallengeTier`. |
| Bosses | excluded in Phase 1 | They keep today's path. See risks. |
| `MOB_TACTICS_LANDING_MIN_GAP_MS` | 300 | Above `DASH_IFRAME_MS` (200), so one dash cannot absorb two landings. |
| `MOB_TACTICS_ARRIVAL_GRACE_MS` | 400 | A mob that just joined or just came on screen cannot start a windup yet. |
| `MOB_TACTICS_ATTACK_VIEW_RADIUS_M` | 450 | Off-screen mobs do not start windups. To verify against the ground-scale camera on a phone; the server interest radius (1100 m) is far wider than the screen. |
| `MOB_TACTICS_ENGAGE_RING_FACTOR` | 0.85 x `attackRangeM` (85 m) | Inside the windup cone range (100 m) with slack for the 5 m hold buffer. |
| `MOB_TACTICS_WAIT_RING_FACTOR` | 1.5 x `attackRangeM` (150 m) | Design decision: one 20 m step puts a waiter inside the 130 m swing reach. |
| `MOB_TACTICS_ENGAGE_SEATS` | 6 | At 85 m a 55 m chord is 37 degrees, so 9 fit; 6 leaves slack. |
| `MOB_TACTICS_RANGED_RING_FACTOR` / `_MAX_M` | 0.75 x range, capped 260 m | Outer ring for archers and casters, kept on screen. |
| `MOB_TACTICS_SLOT_MIN_SPACING_M` | 55 | Body diameter 40 + 15 gap. Minimum angle is `2 asin(27.5 / R)`. |
| `MOB_TACTICS_LAYER_STEP_M` | 60 | A full ring spills outward by one layer. |
| `MOB_TACTICS_SLOT_REASSIGN_TICKS` | 5 (250 ms), staggered by player id hash | Cheap, and smooth. |
| `MOB_TACTICS_SLOT_HYSTERESIS_DEG` | 25 | A mob keeps its slot unless the better one is 25 degrees nearer, or its slot is blocked. |
| `MOB_TACTICS_SLOT_ARRIVE_M` | 10 | Counts as "at slot". |
| `MOB_TACTICS_STRAFE_SPEED_FACTOR` | 0.2 x mob speed | Slow circle while waiting. |
| `MOB_TACTICS_STRAFE_FLIP_MS` | 1500 to 3500, seeded | Direction flips so a pack does not rotate as one wheel. |
| `MOB_TACTICS_SEPARATION_RADIUS_M` | 50 | Two body radii (40) + 10. |
| `MOB_TACTICS_SEPARATION_STRENGTH` | 0.6 of one step at full overlap | Same shape as the existing rule: `pressure = (R - d) / R`. |
| `MOB_TACTICS_SEPARATION_MAX_SHARE` | 0.5 | Total push never exceeds half a step, as today (12257), so mobs still make progress. |
| `MOB_TACTICS_FRONT_BONUS_MS` / `_FRONT_HALF_ANGLE_DEG` | 600 / 60 | Fairness score bonus for mobs in front of the player's heading. |
| `MOB_TACTICS_STARVATION_MS` | 4000 | A mob that has waited this long is served first. |
| `MOB_TACTICS_TOKEN_MAX_HOLD_MS` | 2500 | Fail-safe against a stuck token (hitstun, stun). |
| `MOB_RANGED_AIM_MS` | 450 | Ranged aim windup, same as melee. A 40 m wide lane is crossed in about 0.3 s at 125 m/s, so it is dodgeable by walking, not only by dashing. |
| `MOB_RANGED_AIM_WIDTH_M` | 40 | Width of the aim line and of the hit lane (telegraph equals hitbox). |
| `MOB_RANGED_AIM_LOCK` | locked at windup start | The lane does not track, so moving sideways dodges, like the melee cone. |
| `MOB_TACTICS_GRAB_MAX_RANGE_FACTOR` | 1.5 (the wait ring) | A mob hit by the player grabs a token if it is within this many ranges. |
| `MOB_TACTICS_RECOVER_MS` / `_BACKOFF_M` | 300 / 20 | Default punish window and back-off step (20 m is well under the client snap of 40 m). |
| `MOB_TACTICS_COOLDOWN_MIN_MS` | 300 | Floor for the derived cooldown. |
| `MOB_TACTICS_COOLDOWN_JITTER_PCT` | 10 | Stops lockstep. |
| `MOB_TACTICS_TARGET_SWAP_PENALTY_MS` | 300 | After a target swap the mob starts over (no instant hit on the new target). |
| `MOB_TACTICS_DAMAGE_FACTOR` | 1.0 | One lever for pack pressure (see risks). Applied through the existing `damageMultiplier` on the attack context. |

Rhythm derivation (replaces the global beat for managed mobs):

```
windupMs   = melee ? MOB_MELEE_WINDUP_MS (450) : 0
recoverMs  = MOB_TACTICS_RECOVER_MS (300)
cooldownMs = max(COOLDOWN_MIN, attackIntervalMs - windupMs - recoverMs) * (1 +- jitter)
```

With `attackIntervalMs` = 1400 (every mob today) this gives windup 450 + recover 300 + cooldown 650 = **1400 ms cycle**. A lone mob attacks exactly as often as today, so 1v1 balance and the "uniform attack speed" rule are unchanged. Per-archetype overrides go in an optional `MOB_RHYTHM_OVERRIDES: Partial<Record<MobArchetypeKey, Partial<MobRhythm>>>`, **empty at launch**.

### 2.4 Per-mob state machine

```
approach -> wait -> windup -> strike -> recover -> cooldown -> wait
              ^                                       |
              +---------------------------------------+
```

| Phase | Mob does | Token | Ends when |
|---|---|---|---|
| approach | Walks to its ring slot (not to the player). Existing speed rules (slows, snare, rooted, habitat, leash). | no | within `SLOT_ARRIVE_M` of slot |
| wait | Holds slot, strafes at 0.2 x speed along the ring, faces the player (client flips by target side), re-slots with hysteresis. | no | granted a token and the landing gap, arrival grace and view rules pass |
| windup | **Planted.** Existing `beginMeleeWindup` (cone telegraph, `pendingBasicStrike`). No steering, no re-slotting. | held | `windupMs` (extended by remaining hitstun, capped by token max hold) |
| strike | Existing `resolvePendingMeleeStrike` (cone test, dash i-frames, DODGE pair). Instant, one tick. Damage x `MOB_TACTICS_DAMAGE_FACTOR`. | held | same tick |
| recover | Back-off step of `backoffM` straight away from the target over `recoverMs`. **No attacks**; this is the punish window. | held until recover ends, then released | `recoverMs` |
| cooldown | Back to slot, strafing. | no | `cooldownMs` |

Token release timing: by design, the token is released after strike + recovery, i.e. when recover ends (a 750 ms hold with the defaults). The landing-gap cursor (below) is what keeps a second mob from landing right behind the first.

Ranged mobs (range > 100 m): the same machine with an aim windup instead of a cone (2.12). They use the ranged pool and the outer ring.

### 2.5 Token arbitration (per player, every tick, O(roster))

1. Drop invalid holders (dead, target changed, left roster, over `TOKEN_MAX_HOLD_MS`). Self-healing, so a missed release can never leak.
2. Candidates: managed mobs in phase `wait`, inside the engage ring (within `attackRangeM + 5` m of the target; ranged: in range), inside `ATTACK_VIEW_RADIUS_M`, past `ARRIVAL_GRACE_MS`, not hitstunned or held.
3. Score = `min(waitedMs, STARVATION)` + `FRONT_BONUS` if within +-60 degrees of the player's heading (derived from the last movement or swing direction; no bonus if unknown) + 1 ms per metre closer than the engage ring. A mob over `STARVATION_MS` goes first. Ties break by `entityId` for determinism.
4. Walk candidates by score; grant while `inUse + cost <= capacity` for that pool.
5. Landing gap: `startTick = max(now, ledger.nextLandingTick - windupTicks)`; the mob only starts when `now >= startTick`, then `ledger.nextLandingTick = now + windupTicks + gapTicks`. The telegraph is always its full length; only the start is delayed. One integer compare per player, no scan.
6. Release (idempotent) on: end of recover; mob death, removal, leash or clear target; target swap (windup is cancelled and the telegraph cleared, then the swap penalty applies); player dashes beyond `attackRangeM + 50` m while the mob is **not** yet planted (back to approach; a planted windup finishes and simply misses, which is the existing dodge); player death or disconnect; session end.

Pool rule for elites: an epic or legendary non-boss costs 2, so with capacity 2 it swings alone.

### 2.6 Surround slots

- Ring geometry is a new pure `ringSlotPosition(center, radiusM, angleDeg)` (just `destinationPoint`), and `flankSlotPosition` is rewritten as a thin wrapper over it. Its signature and output stay identical, so `raptorFamilyBehaviors.test.ts` is unchanged.
- Assignment is **angular relaxation, not even re-spacing**. Each mob's desired angle is its current bearing from the target. Sorted by bearing, each slot angle is pushed apart until neighbours are at least the minimum angle (spread, not teleport). Mobs therefore keep the side they arrived from and never cross through the player.
- Inner (engage) ring holds `ENGAGE_SEATS` mobs; the rest sit on the wait ring; a full ring spills to the next layer. The engage ring fills first with the highest scores, so the next token holder is usually already in place.
- The ring is anchored to the **player's current position** and keeps world-space angles, so when the player walks the whole ring translates with them (the same shape, mobs do not orbit).
- Hysteresis: re-evaluated every 5 ticks; a mob moves slots only if the new angle is better by 25 degrees or its slot is blocked.
- Blocked slot (water for land mobs, cliff, wall): check with `isMobHabitatStepAllowed` (9126); try +-1, +-2 neighbouring angles (about 35 degrees steps), else hold the current position. Slots are never teleports.
- `processRaptorFlank` (cave raptor pounce) is left as is, but it now takes its slot from tactics when the mob is managed, so the two systems cannot disagree. Pounce counts as `approach`.

### 2.7 Separation

- Applies to every managed mob against the other managed mobs in the same player's roster (no `packId` needed). Roster pairs only, so no spatial query: at most 16 x 15 / 2 = 120 pair checks per player per tick.
- Computed inside the same step as the slot seek (one steering vector: seek + push), then clamped to the mob's normal max step. So there is one position write per mob per tick, through `setMobPosition`. Server authority is unchanged: this is purely where the server decides to put a mob, using the same speed, slow, snare, habitat and leash rules as `processChases`.
- To share that logic, extract the step block of `processChases` (6890-6925: hold check, speed with slows and snare, habitat check, leash check, write) into `stepMobToward(mob, destination)` and call it from both. Flag off still runs the same code path.
- Pre-engage movement keeps using `combatSeparationM` as today. A mob with `combatSeparationM: 0` is not excluded from tactics (open question if any are meant to overlap, such as swarms).
- Client: no change. Mob steps are at most mob speed and slot targets move smoothly, so the existing linear interpolation never snaps (MOB_RENDER_SNAP_M 40).

### 2.12 Ranged aim windup

- Telegraph: the existing `line` geometry (`bossContracts.ts:50`, `origin`, `facingDegrees`, `lengthM`, `widthM`) through `addMobTelegraph`, length = the mob's `attackRangeM`, width 40 m, id `ranged_aim`. The client already draws line telegraphs.
- Flow mirrors melee: `beginRangedAim` stores `pendingBasicStrike` with the locked origin and facing, 450 ms later `resolvePendingRangedShot` does a corridor test (point-to-line distance within 20 m of the line, along-track within length) in the same local metric frame as the melee cone test. Inside the lane and not in dash i-frames: normal `resolveBasicAttack`. Outside: `DODGE` innate event plus a zero `DAMAGE` event, exactly like melee.
- Shared helper in `actionCombat.ts`-style pure code: `rangedLaneContains(facingDegrees, lengthM, widthM, x, y)`.
- Recover 350 ms, then the cooldown formula. Ranged mobs never move during aim.
- `usesMeleeWindup` stays melee-only; a new `usesRangedAim` gate has the same conditions but range above 100 m. Both are off when the sub-flag is off, so flag-off ranged mobs still fire untelegraphed as today.

### 2.13 Engaging a waiting mob

- A player hit (swing or shot) on a managed mob in `wait` or `cooldown` marks it `grabbed`. A grabbed mob is at the front of the token queue ahead of the fairness score (waiting time, front bonus, starvation).
- It does not bypass capacity: if both tokens are held it takes the next one released (at most about 750 ms). It does not bypass the arrival grace or the landing gap, which keeps the readability rules intact.
- It holds the token while walking from the wait ring to its engage seat (covered by `TOKEN_MAX_HOLD_MS`), then winds up.
- Hits on a mob already in windup, strike or recover do nothing new.

### 2.8 Readability rules (summary)

1. No windup starts unless the mob is within 450 m of the player and has been in the roster for 400 ms.
2. Landing gap of 300 ms between any two strikes on the same player (cursor in 2.5 step 5).
3. Capacity 2 points, so at most 2 telegraphs are visible at once (3 if raised).
4. A planted mob never moves during windup; the telegraph origin and facing never lie.

### 2.9 What happens to the old queue under the flag

| Piece | With flag on (tactics on) | Flag off |
|---|---|---|
| `session.enemyIds` | **Kept.** Still the owner of aggro, loot, XP, party sharing, session end. | Same. |
| `enemyQueue`, `queueCursor`, `enemyQueueJoinedAtTick` | Stay empty for managed mobs. `appendEnemy` adds the mob to `enemyIds` and the tactics roster and does not queue it. The queue only holds mobs that fail `usesMobTactics` (bosses, shared raid mobs, dungeons). | Unchanged. |
| `enemy_pending` phase | Never entered for managed mobs. `scheduleEnemyPhaseAfterArrival` (6973) returns early; `reconcilePveEnemyMembership` (6912) skips managed mobs. | Unchanged. |
| `waiting_player` | Stays the resting phase (the player-side auto-attack path still keys on it). | Unchanged. |
| `resolveEnemyOpportunity`, `beginSessionEnemyWindup` | Only run for unmanaged queued mobs. | Unchanged. |
| `resolveAttack` / `scheduleAttack` | Not called for managed mobs. `directMobTarget` joins tactics instead of scheduling. | Unchanged. |
| Wire schema and `PveCombatSession` fields | Unchanged (empty queue is valid). No protocol version bump. | Unchanged. |
| Client `mobAttackCountdown` | Unchanged: it shows world-AI acquire and disengage timers, not queue state (see 1.5). | Unchanged. |

Cleanup of the dead queue code is a later phase and only after the flag is permanently on.

### 2.10 Integration points in the server tick

New `processMobTactics()` in `beginTick`, right after `processMobSpecials()` and before `reconcilePveEnemyMembership()`:

1. `processChases` gets one line: skip mobs the coordinator manages.
2. `processMobTactics()`: for each player ledger (sorted by player id): validate roster, arbitrate tokens (2.5), then for each managed mob advance its phase and call `stepMobToward` for approach, wait, recover back-off and cooldown. Windups call `beginMeleeWindup` with `rhythm.windupMs`, strikes call `resolvePendingMeleeStrike`.
3. Join hooks (call `coordinator.join(mob, player)` instead of queueing): `engageHostileMob` 12120, the swing claim at 4372-4378, taunt 15784, arrivals in `reconcilePveEnemyMembership` 6959, `establishRetaliation` 16179 (player branch), `directMobTarget` 5751.
4. Forget hooks (one `coordinator.forget(mobId)`, all idempotent): `removeEnemy` 14222, `removeEnemyFromQueue` 14194, `releaseMobClaim`, `defeat`, `removeEntity` 16884, `clearTarget`, `endPveSession`, `setTarget` when the target changes.
5. `beginMeleeWindup` and `addMobTelegraph` take a duration argument instead of reading `MOB_MELEE_WINDUP_MS` (default unchanged for the old path).
6. `MOB_TACTICS_ENABLED` is read from config next to `ACTION_COMBAT_ENABLED` (`config.ts:266`, engine option at `application.ts:1533`).

### 2.11 Aggro, PvP, multiple players

- One mob has one target (the aggro owner or, with taunt or threat priority, `sessionEnemyTarget`). It asks the **target's** ledger. Two players never share a ledger. Party mobs use the current target's ledger (`partyAuthority.sameParty` rules unchanged).
- Aggro switch: windup is cancelled, token released in the old ledger, mob joins the new ledger in `approach` with a 300 ms swap penalty. No instant hit on the new target.
- Non-party players cannot engage an owned mob today (`claimMobAggro`), so the "two ledgers fight over one mob" case cannot happen. Shared raid mobs are unmanaged.
- PvP: player-versus-player fights are not mob tactics and are untouched. A player in PvP can still be a mob's target; their ledger works the same. A pet or undead target is not a player, so those mobs stay on the old path and the token is released when the mob retargets to them.

## 3. Networking and client

- **No protocol change.** Mob positions already travel in 10 Hz combat deltas, telegraphs already carry `origin` and `facingDegrees`.
- Wait-ring strafing makes waiting mobs "dirty" more often. The delta flush is capped at 10 Hz, so this is at most one position per moving mob per delta (about 16 mobs x 10 Hz x tens of bytes per player in a big fight).
- Facing: the client already flips mob sprites by horizontal direction. Verify a strafing mob faces its target and not its travel direction; if not, a small client fix uses `targetEntityId` when the mob is on a slot. (Client task C1.)
- Optional, not in Phase 1: a one-byte `tacticsPhase` on the mob snapshot so the client can show a "recovering" cue. Skip until needed.

## 4. Risks

| Risk | Detail | Mitigation |
|---|---|---|
| Dupe and authority | Tactics holds only transient combat state. It never touches inventory, loot, XP or gold. Damage still goes through `resolveBasicAttack` from `resolvePendingMeleeStrike`, which consumes `pendingBasicStrike` once. Aggro ownership, session membership and `defeat` are untouched. | Token release is idempotent; the ledger self-heals every tick; a test asserts one strike per windup and an empty ledger after every end case. No persistence, no migration. |
| Double attack from two paths | Provoke or `directMobTarget` plus the queue can already double-attack. | Managed mobs never get `scheduleAttack`. Test added. |
| Balance: pack pressure | Today a pack gets 1 hit per 1.4 s. With 2 tokens and a 0.75 s token hold, throughput is about 2.7 hits/s max (about 3.7x), reached with 4 or more mobs. A 2-mob fight doubles it. | One lever, `MOB_TACTICS_DAMAGE_FACTOR`, plus capacity. Launch dark, measure with the existing combat telemetry, tune. Accepted by owner (decision 1). |
| Perf, many mobs | Cost per tick is O(managed mobs): one cheap state step each, roster pair loop for separation (at most 120 pairs per player), slot relaxation every 5th tick, one sort of at most 16 ids per player. No allocations in the hot loop (preallocated arrays like `swingTargets`). 200 fighters x 12 mobs is about 2,400 steps and 13k pair checks per tick. This replaces `processChases` work for those mobs, not adds to it. | Counter in the engine metrics (`tacticsManaged`, `tacticsTokensInUse`). Cap roster at 16 per player with overflow staying on the wait ring. A ceiling `maxTacticsPerTick` mirrors `maxChasesPerTick`. |
| Dungeons | Action combat is overworld only, and tactics are gated to non-`interior:` players. Dungeon mobs keep the queue. Slots need walkability checks that interiors cannot give yet. | Revisit when interiors use the main renderer. A dungeon test proves nothing changes. |
| Bosses | Excluded: scripted moves, large bodies, shared combat, their own cadence. A boss in a session still uses the queue beside tactics mobs, so boss plus adds mix two systems. | Documented. Later phase: boss owns a token share or takes the whole pool for big moves. |
| Elites | Cost 2 tokens (decided). With capacity 2 an elite swings alone. | Accepted. |
| Pets | Companion dogs and other pets are not managed. Mobs on pets stay on the old path. Pets are not in ledgers or in separation. A mob switching between pet and player flips between paths. | Gate is checked at each retarget; release and join are idempotent. |
| Hitstun on a planted mob | A swing hit during windup extends the windup by the remaining hitstun and the token stays held. | `TOKEN_MAX_HOLD_MS` fail-safe. |
| Raptor pounce | Cave raptors hop to flank slots on their own timer. | Takes the slot from tactics when managed (2.6). Test included. |
| Lag compensation | Tactics move mobs more. | All writes use `setMobPosition`, so position history stays right. A swing test with moving ring mobs confirms rewind still hits. |

## 5. Test plan

### 5.1 Server unit tests (vitest, no network)

Pure module, `apps/server/src/game/combat/mobTactics.test.ts`:
1. Rhythm derivation: for **every** entry in `MOB_DEFINITIONS`, windup, recover and cooldown are positive and sum to `attackIntervalMs` (or to the floor); ranged mobs have windup 0.
2. Slot relaxation: 6 mobs bearing-clustered at 10 degrees end up at least the minimum angle apart, keep their circular order, and move monotonically.
3. Hysteresis: a 10 degree player shift moves no slot; a 30 degree shift moves one.
4. Token arbitration: capacity respected; an epic blocks a second mob at capacity 2; fairness (longest waiter, front bonus, starvation, deterministic tie-break); ranged pool independent of melee pool.
5. Landing gap: two grants in one tick get landing ticks at least 6 ticks apart; telegraph length never shortened.
6. Release: idempotent on double release; every end case (death, leash, target swap, dash out, session end, disconnect) leaves the ledger empty.

Engine tests, `apps/server/src/game/combat/combatEngine.mobTactics.test.ts`, written like `combatEngine.meleeWindup.test.ts` (`actionCombatEnabled: () => true`, 20 Hz, manual clock):
1. **Pack spread:** spawn 6 wolves bunched 100-125 m away on one side (inside the wolf leash: home-to-target must stay within leash 160 m + range 100 m), run 600 ticks. Assert after 200 ticks every pair is at least 40 m apart (no stacking) and every melee mob is within 5 m of its ring radius.
2. **Windup cap:** every tick, count mobs with a live `pendingBasicStrike`. Assert never above 2 with all common mobs. With one epic plus grunts, assert never above 2 points.
3. **No stacking with the old behaviour:** the same scenario with the flag off still stacks (control, proves the test catches the bug).
4. **Landing gap:** collect strike ticks from DAMAGE and DODGE events; assert consecutive gaps are at least 6 ticks.
5. **Rate:** a lone mob attacks every 1400 ms +-10 percent (same as today).
6. **Fairness:** over 20 s every one of 6 mobs attacks at least once; none waits over `STARVATION_MS` + a cycle.
7. **No double strike:** each windup produces exactly one DAMAGE or DODGE pair. A `directMobTarget` call on a managed mob does not create a second attacker.
8. **Release cases:** kill a holder mid-windup; move the player 400 m away; swap target by taunt; dash out; end the session. Ledger empty each time and the next mob gets the token within one tick.
9. **Player moves:** walk the player in a circle for 10 s; slot angle changes per mob are at most 1 per second and positions stay inside the clamp (no jitter: sign changes of tangential velocity are bounded).
10. **Flag off:** `combatEngine.meleeWindup.test.ts` and the existing suite pass unchanged. A golden run of the old queue with tactics off produces identical events.
11. Boss, shared raid mob, dungeon (`interior:` region), pet target, undead target all stay on their old path (unmanaged).
12. Swing lag-compensation test against moving ring mobs.

### 5.2 Headless Playwright (`apps/client/full-app-tests/mobTactics.spec.ts`)

Follow `actionCombat.spec.ts`: sign in as the dev account, `DEV_SPAWN_MOB` through the websocket helper, backend with `ACTION_COMBAT_ENABLED=true MOB_TACTICS_ENABLED=true`. Desktop and a 390x844 phone viewport.
1. Spawn 6 wolves bunched 100-125 m out (300 m is past the wolf leash and they disengage at once); after 6 s sample combat frames: pairwise distance at least 40 m, and at least 4 mobs between 70 and 200 m from the player on distinct bearings (more than 25 degrees apart).
2. Over 20 s of standing still, count live `melee_windup` telegraphs per frame: never above 2; no two strikes within 300 ms (events).
3. Walk the player 600 m; the pack follows without any mob teleporting (no position jump over 40 m between frames).
4. Screenshot at 5 s and 15 s to judge the spread; verify the mobs face the player.
5. Flag off run: the same spec asserts the old behaviour (control).

## 6. Build order (one author, checkpoint commit after each task)

| Task | Scope | Done when |
|---|---|---|
| 1 | `packages/shared/src/mobTactics.ts` (constants, types, rhythm derivation, ring geometry, `flankSlotPosition` as wrapper), config flag, shared unit tests, `MOB_DEFINITIONS` rhythm test. | shared tests and typecheck pass; `raptorFamilyBehaviors.test.ts` unchanged. |
| 2 | Pure coordinator `apps/server/src/game/combat/mobTactics.ts`: ledger, token arbitration, landing gap, slot relaxation, separation, with its unit tests (5.1 items 1-6). No engine wiring. | pure tests pass. |
| 3 | Engine wiring: `usesMobTactics` gate, join and forget hooks, `stepMobToward` extraction, `processMobTactics` state machine, `processChases` skip, queue bypass. Flag off proven identical. | engine tests 1-4 and 10 pass; old suite green. |
| 4 | Engine tests 5-9, 11-12 and fixes: target swap, dash-out, hitstun, raptors, `directMobTarget`, metrics counters. | full server suite green. |
| 5 | Playwright spec, client facing check (C1), mobile viewport, screenshots, telemetry run for pack pressure. Playtest on a phone. | review screenshots and feel; tune constants. |
| 6 (later, after approval) | Optional: boss token share, dungeons, remove dead queue code once the flag is permanent. | separate spec. |

Tasks 3-4 touch server authority and combat timing, so give them extra review; tasks 1-2 are pure logic. Playwright and test runs are routine.

## 7. Open questions

None blocking. Defaulted items are in section 0 (7, 9, 10). Still worth a look during the Chunk 5 playtest: capacity 2 feel, the 450 ms aim lane width, and wait-ring distance on a phone screen.

## 8. Chunk 3 build notes (corrections found while wiring)

- **Leash vs slots.** The `processChases` leash rule on a step (step past `leashRadiusM` from home -> `clearTarget`) cannot be reused for slot steps: slots sit around the player, not toward the mob, so they often lie beyond the leash and the whole pack disengaged. Tactics keeps the real leash rule (target beyond leash + range from home -> `clearTarget`, taunted-in-view exempt), pulls each slot destination back inside the home leash, and holds a step that would still cross it.
- **Reachable arc.** Slot relaxation is not leash-aware. A pack whose home is far from the player can only reach part of the ring (home 185 m away, leash 160 m: about +-60 degrees of the 85 m ring), so clamped mobs can bunch. Chunk 4 candidate: relax inside the reachable arc, spill to the wait ring when it is full.
- **Test 5.1 #1 distance.** Wolves have a 160 m leash, so a pull from 300 m disengages at once on both paths. Fixed in 5.1 and 5.2: the pack spawns 100-125 m out.
- **More than 6 melee mobs.** `assignRings` keeps current engage occupants first, so wait-ring mobs never get an engage seat and never become token candidates (only a grab reaches them). Needs seat rotation by waiting time in chunk 4.
- **Client.** No change needed: `ranged_aim` line telegraphs render through the existing generic line style (chevrons), same pipeline as `melee_windup`.
- **Where the code lives.** The per-tick state machine is in the engine (`processMobTactics` and helpers, about 550 lines) because it needs private engine helpers (speed, habitat, leash, windups, strike side effects). Ledgers, per-mob state and reuse buffers are in `MobTacticsCoordinator` (server `mobTactics.ts`), not on `MobSpecialState`.
- **Not yet wired:** `MOB_TACTICS_DAMAGE_FACTOR` (1.0, so no effect), player heading for the front bonus (null), `MOB_TACTICS_MAX_ROSTER`, `maxTacticsPerTick`, metrics counters, raptor flank slot hand-off, queue bleed turns for managed mobs.

## 9. Chunk 4 build notes

- **Seat rotation.** Engage seats are ranked by waiting time (fairness clock restarts on token release, so cooldown counts as waiting); busy mobs (token, windup, recover) and grabbed mobs keep or take a seat; a current occupant gets `MOB_TACTICS_SEAT_HOLD_BONUS_MS` (1000) so seats do not flap. A 9-wolf pack now has every wolf attack without grabs.
- **Leash-aware slots.** `reachableArcHalfDeg` gives each mob the arc of its ring inside its home leash; slot relaxation alternates projection into the arc and re-spreading, and the engage seat count is capped to what fits on the arc (the rest wait on the wait ring). Settled mobs stay 40 m+ apart; mobs crossing between rings during rotation can pass closer (down to about 20 m) for a moment. If that reads badly, raise separation or the seat hold bonus.
- **Bleed and threat priority.** Queue bleed ticks at each managed windup start (a bleed kill spends the turn). Threat priority retargets a managed mob to that ally (swap penalty applies), as the queue does on its turn.
- **Ceilings and metrics.** Only the first 16 roster mobs (join order) compete for tokens and are separation bodies; `maxTacticsPerTick` (default 2048) round-robins target players; `tacticsManaged` and `tacticsTokensInUse` are in the combat metrics (0 with the flag off).
- **Heading.** The front bonus uses the player's last >= 1 m of movement; swing direction is not used.
- **Raptors.** A managed cave raptor pounces to its tactics slot.
- **Still open:** `MOB_TACTICS_DAMAGE_FACTOR` (1.0) is not applied; the ring pass every 5 ticks still allocates small arrays; the lag-comp test checks the history is written by every step, not a full rewound swing.

## 10. Spacing follow-ups (playtest)

- **Sprite-sized bodies.** Body width per archetype comes from the runtime PNG catalog: frame height at ground zoom 15 (the default play zoom, 2.39 m per CSS px) x hit-box width share x master scale (wolf about 95 m; the screen measured 98 m). Overrides in `MOB_TACTICS_BODY_WIDTH_OVERRIDES` still win.
- **Rings.** Engage ring = player half-width (26.5 m) + body half + 20 m gap + 15 m clearance (wolf about 109 m), at most 4 seats. Waiters sit on band 0 at 160 m (or just outside the engage ring plus a packed body) at the midpoints between engaged mobs that keep them clear, then on bands 40 m further out, packed to body + 5 m. Decision 5 holds again: one step puts a band-0 waiter in swing reach.
- **Reach (option 3).** Managed melee mobs strike out to max(125 m, engage ring + 15 m); the windup cone matches. A 200 m dash still clears it. Flag off: unchanged 100 m.
- **Spacing.** Full spacing (body + 20 m) on the engage ring; a firm per-pair minimum (half widths + 5 m) on every step, corrected at most one step per tick.
- **Leash.** While engaged, slot steps may go 400 m past the home leash, so a pack surrounds the player; the disengage rule is unchanged.
- **Client.** Ordinary mob health bars are at most 75 % of the sprite width (bosses and players unchanged).
- **Dev tool.** `DEV_PLAYERS_INVULNERABLE` (dev tools on and NODE_ENV not production only) for watching packs in e2e runs.
