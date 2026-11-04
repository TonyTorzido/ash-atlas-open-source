# Attack cadence profiles

Branch `feature/attack-cadence-profiles--from-t1565`. The owner dropped the rule that every player attacks on one
uniform 1.4 s cadence. Swing timing is now data, chosen per (class, weapon family), in
`packages/shared/src/attackProfiles.ts`. Server and client both read it.

## Cadence map (as of t1565)

There are two player attack paths. Only the second one is the live melee attack.

### 1. Legacy tap-to-attack auto-attack (the 1.4 s beat)

- `BASIC_ATTACK_INTERVAL_MS = 1_400` (`packages/shared/src/combatConstants.ts`). The engine converts it once to
  `attackIntervalTicks` (28 ticks at 20 Hz) and `PVE_TURN_STEP_MS = 700` to `pveTurnStepTicks` (14)
  (`combatEngine.ts` constructor).
- PvE session phases: the player acts on one 700 ms half and the enemy acts on the other half (`enemyActionAtTick =
  now + pveTurnStepTicks`, `player.nextEligibleAttackTick = now + attackIntervalTicks`, `scheduleEnemyPhaseAfterArrival`).
- Mobs: every mob definition uses `attackIntervalMs: BASIC_ATTACK_INTERVAL_MS` (`mobDefinitions.ts`). Minions and Revenant
  Metal undead do too (`minionRuntime.ts`, `revenantMetalUndead.ts`). The melee mob windup is `MOB_MELEE_WINDUP_MS = 450`.
- PvP: a swing only hits mobs (`readSwingCandidate` keeps `kind === "mob"`), so player against player still uses this
  path. Each hit goes through the PvP damage matrix (`damageMatrixV3.ts`, per hit, with no time term), on the 1.4 s beat.
- Weapon switch: `WEAPON_SWITCH_DELAY_MS = BASIC_ATTACK_INTERVAL_MS * 0.25` (350 ms). The queued auto-attack is
  rescheduled to the switch end (`switchCompletesAtTick`). This branch has no gear-set code. The plan is that gear-set
  swaps are beat-timed in combat (memory: PvP gear swaps), so they will couple to this path, not to swings.

### 2. Action-combat swing (live, flag ON in prod)

- Server: `CombatEngine.resolveSwing` → `performSwing` (`apps/server/src/game/combat/combatEngine.ts`).
  - Recovery gate `SWING_RECOVERY_TICKS = [14, 14, 18]`: 700, 700 and 900 ms, press to next press.
  - A press up to `SWING_BUFFER_EARLY_TICKS = 5` (250 ms) early takes the one buffer slot. Earlier presses get `too_soon`.
  - Combo: the next step if the press comes within `SWING_COMBO_RESET_MS = 1300` of the last press, else step 0.
  - Damage `SWING_DAMAGE_FACTORS = [0.5, 0.5, 0.75]` x the basic attack, giving 1.75 basic hits per 2.3 s (0.761/s).
  - Damage lands on the tick the press is resolved. Mob positions are rewound by the lag hint, which is clamped to
    250 ms. A swing cancels the queued auto-attack.
  - A dash clears recovery (`notePlayerDashed`).
- Client contact: the blade crosses the target `SWING_CONTACT_MS` after the press: 105 ms for a swing and 119 ms for a
  finisher (`packages/player-renderer/src/gatherAnimation.ts`). The drawn key poses put the hit pose at frame f3,
  100–133 ms at 30 fps (`apps/client/src/players/jacketSword.ts`). `App.sendLocalSwing` schedules the arc, flash, spark,
  hitstop and numbers at press + contact.
- Client prediction: `apps/client/src/combat/swing.ts` (`SwingClientState`) applies the same combo and recovery rules
  locally and is reconciled by `SWING_RESULT`. `JoystickMovement.tsx` only reads `nextSwingAtMs` and `lastSwingAtMs`
  for the cooldown ring and hold-repeat, so it does not depend on the profile.
- Shots (ranged weapon): fixed `SHOT_RECOVERY_TICKS = 20`, `SHOT_DAMAGE_FACTOR = 0.75`, no combo. Profiles do not
  touch shots.

### 3. Periodic effects (DoT, HoT, regen): a beat grid of their own

- `beatAlignedIntervalMs` and `beatAlignedAmountScale` (`packages/shared/src/combat.ts`) snap each design interval to
  whole 1.4 s beats. The engine advances periodic ticks by the global `attackIntervalTicks`, anchored to the player or
  enemy half (`periodicPhase` and `periodicBeatOffset`).
- Guard: `apps/server/src/game/combat/beatEnvironment.test.ts` scans every shared export named `*_TICK_MS` and fails
  unless it is a whole number of beats.
- Coupling found: the grid uses the engine-global beat, not any per-player cadence, so swing profiles cannot move it.
  The guard is name-based, so the profile tick length is exported as `ATTACK_PROFILE_TICK_LENGTH_MS`, which does not
  match the pattern. DoT, regen, mobs, minions and the auto-attack all stay on 1.4 s.

## Profile shape

```ts
type AttackSwingStep = { windupMs; recoveryMs; damageMultiplier; knockbackM };    // one per combo step
type AttackProfile  = { id; label; combo: AttackSwingStep[]; comboResetMs; hitTiming: "press" | "contact" };
```

- Step cadence is `windupMs + recoveryMs`, counted press to press in 20 Hz ticks with
  `attackStepCycleTicks = round(ms / 50)`. Server and client use the same function.
- `comboResetMs` is measured from the last press. Combo length can be 1 to 6, and the wire `comboIndex` accepts 0..5.
- Equal DPS: `attackProfileDamagePerSecond(profile)` is basic hits per second over a full chained combo.
  `equalDpsDamageMultipliers(steps, target)` returns factors that hit the target. By default each step's share follows
  its cadence; a `weight` per step keeps a chosen shape.

## Combat styles: one resolver

`combatStyleFor(classId, weaponFamily)` returns `'default' | 'sword:generic' | 'sword:ronin'`. It checks two tables:

- A class table. It has one entry: `ronin` holding a sword resolves to `sword:ronin`. `ronin` is not a class id at
  t1565 (it lives on `feature/class-rework--from-t1492`), so the entry only takes effect once that id exists.
- A weapon table. A sword resolves to `sword:generic`.

Anything else resolves to `default`.

Where the style is resolved and used:

- **Server:** `CombatEngine.combatStyleOf(player)` passes the active specialization id (falling back to the class id)
  and `equipmentCombatState.weaponCategory`.
- **Snapshot:** the player's combat snapshot carries `combatStyle` and omits it for `default`. The local client predicts
  its own swings with that value.
- **SWING event:** for non-default styles the event id is `swing_<step>@<style>`, so other clients play the exact
  profile the server used for that swing. They use it to find the finisher and to land a contact-timed arc at contact.

| Style | Contact (ms) | Next press (ms) | Reset | Damage | DPS vs default | Hit |
|---|---|---|---|---|---|---|
| default | 105 / 105 / 119 | 700 / 700 / 900 | 1.3 s | 0.5 / 0.5 / 0.75 | 0.761 basic hits/s | press |
| sword:generic | 100 / 100 / 133 | 500 / 500 / 650 | 1.0 s | 0.359 / 0.359 / 0.538 | +0.05 % | contact (2 / 2 / 3 ticks) |
| sword:ronin | 133 / 133 / 200 | 650 / 800 / 1000 | 1.5 s | 0.535 / 0.535 / 0.793 | -0.06 % | contact (3 / 3 / 4 ticks) |

The animator proposed 0.36 / 0.36 / 0.54 for sword:generic (+0.36 % DPS) and 0.54 / 0.54 / 0.80 for sword:ronin
(+0.85 % DPS). Both were rescaled to the default's DPS and keep the proposed shape.

Art: sword:generic's contact frames fall on the drawn hit pose (frame f3, 100–133 ms). A 467 ms swing ends before
each next press. The Ronin 200 ms finisher has no drawn pose yet; it shows swing 3 with its hit frame early.

## Hit timing (server)

The server stays authoritative over when damage lands.

- `hitTiming: "press"` (the default profile) lands the hit on the tick the press resolves, exactly as today.
- `hitTiming: "contact"` (both sword styles) commits the swing on the press: combo, recovery gate and SWING event. The
  hit lands `round(windupMs / 50)` ticks later, in `beginTick`, against mob positions rewound by the lag hint.
- The press answers `buffered: true`, and the real `SWING_RESULT` follows through `onSwingResolved`, the same path a
  buffered press already uses.
- The hit is dropped if, during the windup, the player dashes, dies, is stunned or leaves, swaps weapon instance or
  combat style, or changes region or zone (for example entering an interior). The result is still sent and is not
  `rejected`, so the client keeps the combo step.
- **Exactly one `SWING_RESULT` per press.** When a buffered press (mid-dash, early, or flushed by a newer press)
  starts a windup, it sends nothing until contact.
- **Routing:** the runtime remembers the connection for each deferred swing by its requestId, so a windup and an early
  press buffered behind it both reach the connection they were pressed on.

## Risks

- **PvP and gear-swap timing:** profiles only drive swings, and swings never hit players. PvP and beat-timed gear swaps
  stay on the 1.4 s auto-attack. Moving PvP onto swings needs PvP damage-matrix balancing per profile, and gear-swap
  timing then has to follow the swing cadence instead of the beat.
- **Anti-cheat:**
  - The client cannot pick its profile. The server derives it from its own equipment and skill state.
  - Contact timing is server ticks from the resolved press. No client value can shorten it.
  - The lag hint still only rewinds mob positions, clamped to 250 ms.
- **Prediction desync:**
  - The client predicts with the `combatStyle` in its last combat snapshot. Right after a weapon swap or specialization
    change, before the new snapshot arrives, one press can be predicted with the old profile. `SWING_RESULT` corrects
    `comboIndex` and `nextSwingAt`.
  - With contact timing, `SWING_RESULT` arrives one windup later than before. Predicted hit effects stay until it comes
    (1.5 s timeout).
- **Stale clients:** the combat entity schema is `.strict()`. A client older than this change rejects snapshots that
  carry `combatStyle`, which is every sword holder, and does not read `@<style>` swing tags. Server and client (OTA)
  must deploy together.
- **Live behaviour change:** the default profile is unchanged, but anyone holding a sword now plays sword:generic. Their
  swing is faster, with a 1.0 s reset, and the hit lands at contact (100–150 ms after the server resolves the press,
  where before it landed on the press).

## Harness note

In the engine test harness, chaining swings at a dummy and then idling lets one plain basic attack (x1.0) land after
the last swing. This happens on the default path, unchanged from master. The DPS tests therefore count only swing hits.
Whether it happens in production was not checked.
