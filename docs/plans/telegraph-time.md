# Telegraph time

Owner, after playing live t1516: "the loading for attacks is still too short. We need more time to react to stuff."
Target: readable combat at a deliberate pace. The player sees the telegraph, decides, then walks or
dashes.

Branch `feature/telegraph-time--from-t1516` (base t1516, f11ff5859). Follows `combat-feel.md` section 4, which
tuned every shape for 250 ms of reaction. This pass tunes for **400 ms**.

## 1. The live knob: `MOB_TELEGRAPH_SCALE`

A server env number. The engine clamps it to 1.0-3.0; anything that is not a number counts as 1.0. It multiplies:

- every managed-mob windup: Phase 1 melee and ranged aim, archetype basics, and the swarm wave;
- every signature telegraph part (both double-strike cones);
- the token stuck-holder fail-safe (`MOB_TACTICS_TOKEN_MAX_HOLD_MS`), so it always covers the scaled windups.

Recover and cooldown keep their lengths, so the cycle grows with the windup and the punish window stays readable.

Only managed mobs read it, so it needs `ACTION_COMBAT_ENABLED` and `MOB_TACTICS_ENABLED`. These keep their own
timings:

- action combat without tactics (`MOB_MELEE_WINDUP_MS`, 450 ms);
- shared and raid mobs, bosses and the legacy gimmicks.

The value is read when a mob joins tactics and when a player's ledger is made. After a change, restart the server.
No deploy is needed.

```
MOB_TELEGRAPH_SCALE=1.3
```

Wiring: `config.ts` (`MOB_TELEGRAPH_SCALE`, default 1) → `application.ts` (`mobTelegraphScale`) → the engine option.
The startup log line ("Ash Atlas game server started") shows `mobTelegraphScale`. Shared helpers live in
`mobTactics.ts` and `mobArchetypes.ts`: `clampMobTelegraphScale`, `scaleTelegraphMs`, `scaleMobRhythm`,
`scaleMobArchetypeParams`, `scaleMobSignature` and `mobTacticsTokenMaxHoldMs`.

**The client needs no deploy for a scale change.** Telegraphs carry `durationMs` and `remainingMs`. The decal fill,
the impact and the mob windup pose (`mobActionAnimation.ts`) all run off that window. No client code holds a windup
length:

- there is no countdown text;
- hit feedback (`hitFeedback.ts`) only times the player's own swing and the damage reactions.

## 2. New defaults (scale 1.0)

Walk speed 125 m/s, **reaction 400 ms**. Walk-out geometry is the same as in combat-feel:

- **Cone** (half-angle h, range L): the worst spot is d = L / (1 + sin h), and the player walks L sin h / (1 + sin h)
  to get out.
- **Lane:** half its width.
- **Circle:** its radius.

Time needed = distance / 125 + 400 ms.

| Shape | Size | Walk out | Needed (+400 ms) | Old telegraph | New telegraph |
|---|---|---|---|---|---|
| Phase 1 melee windup cone | 150 m (130 reach + 20 body), 90° | 62 m → 497 ms | 897 | 750 | **1100** |
| Phase 1 ranged aim lane | 40 m wide | 20 m → 160 ms | 560 | 450 | **900** |
| Brute / Pack / Skirmisher basic cone | 150 m, 90° | 497 ms | 897 | 750 | **1100** |
| Swarmer basic (wave cone) | 150 m, 70° | 55 m → 437 ms | 837 | 700 | **1000** |
| Caster basic (aim lane) | 40 m wide | 160 ms | 560 | 450 | **900** |
| Charge lane | 120 m wide | 60 m → 480 ms | 880 | 900 | **1300** |
| Maul cone | 180 m, 100° | 78 m → 625 ms | 1025 | 1000 | **1400** |
| Slam circle | r 110 m | 880 ms | 1280 | 1200 | **1600** |
| Lunge lane | 50 m wide | 25 m → 200 ms | 600 | 500 | **1200** |
| Double strike (each cone, re-aimed) | 110 m, 70° | 40 m → 321 ms | 721 | 600 + 600 | **1200 + 1000** |
| Smoke step circle | r 50 m | 400 ms | 800 | 1100 | **1200** |
| Swoop cone | 130 m, 90° | 54 m → 431 ms | 831 | 1000 | **1300** |
| Ground blast circle | r 100 m | 800 ms | 1200 | 1100 | **1500** |
| Volley fan (centre lane) | 40 m wide | 20 m → 160 ms | 560 | 700 | **1200** |
| Tongue lane | 60 m wide | 30 m → 240 ms | 640 | 900 | **1200** |
| Swarm wave (table row) | 90 m, 70° | 33 m → 262 ms | 662 | 600 | **1000** |

Notes on the table:

- **Signature floor.** No signature telegraph is shorter than 1000 ms (`MOB_ARCH_SIGNATURE_MIN_TELEGRAPH_MS`,
  was 450).
- **Signature sizes.** Most signatures are 1.2-1.6 s by size. The second double-strike cone is 1.0 s: it follows
  straight on, and the player is already moving.
- **Legacy gimmicks.** The bandit smoke and frog tongue gimmicks keep their own delays (1100 / 900 ms) when the flag
  is off. The server test now checks that the managed telegraphs are at least as long as the legacy ones.
- **Network.** After the phone-network delay (section 3, about 200 ms), the melee cone still shows for 897 ms. That
  is exactly the 497 ms walk plus 400 ms of reaction.

`shared/mobArchetypes.test.ts` computes each walk-out from the table and checks every signature part, every basic
cone and the aim lane against walk-out + `MOB_ARCH_SIGNATURE_REACTION_SLACK_MS`, which is now
`MOB_TELEGRAPH_REACTION_MS` (400).

### Rhythm and damage (accepted for now; Phase 3 retunes damage)

Cooldowns are unchanged, so every cycle grows by the windup increase. Recovers stay at 250 ms or more (the swarmer's
went from 200 to 250). The Phase 1 cooldown sits at its 300 ms floor.

| Rhythm | Before (windup / recover / cooldown = cycle) | After | Lone-mob hit-equivalents/s | Full-pack ceiling (token hold) |
|---|---|---|---|---|
| Phase 1 managed melee | 750 / 250 / 400 = 1400 | 1100 / 250 / 300 = 1650 | 0.71 → 0.61 (-15 %) | -26 % (1000 → 1350 ms) |
| Phase 1 managed ranged | 450 / 350 / 600 = 1400 | 900 / 350 / 300 = 1550 | 0.71 → 0.65 (-10 %) | -36 % (800 → 1250 ms) |
| Brute | 750 / 350 / 1200 = 2300 | 1100 / 350 / 1200 = 2650 | 0.65 → 0.57 (-13 %) | -24 % |
| Pack | 750 / 250 / 400 = 1400 | 1100 / 250 / 400 = 1750 | 0.71 → 0.57 (-20 %) | -26 % |
| Skirmisher | 750 / 400 / 700 = 1850 | 1100 / 400 / 700 = 2200 | 0.70 → 0.59 (-16 %) | -23 % |
| Caster | 450 / 350 / 600 = 1400 | 900 / 350 / 600 = 1850 | 0.79 → 0.59 (-24 %) | -36 % |
| Swarmer | 700 / 200 / 250 = 1150 | 1000 / 250 / 250 = 1500 | 0.70 → 0.53 (-23 %) | -28 % |

**DPS ratio:** mob damage per second is about **0.76-0.90x** of t1516 for a lone mob, and about **0.64-0.77x** for a
full pack at its token ceiling, before signatures. At scale s, each melee cycle becomes 1100 s + 550 ms. At scale 2
the Phase 1 lone rate is 0.36 hits/s, half of t1516.

Pack sizes 1-4 in the engine balance run (`combatEngine.mobArchetypes.balance.test.ts`), Phase 2 against Phase 1:

- The band is now 0.7x-1.5x (was 1.4x).
- The 4-squirrel swarm measures 1.40x. Phase 1 tokens are held 35 % longer, while a swarm wave's half-point tokens
  are held 39 % longer but four at a time.
- Both phases are lower in absolute damage than at t1516.

### Consistency of the token, landing and governor math

- **Token fail-safe:** `MOB_TACTICS_TOKEN_MAX_HOLD_MS` 2500 → 3000 ms, times the scale.
  - The longest hold is the double strike: 1200 + 1000 + 400 recover = 2600 ms.
  - A test checks every signature hold and every basic hold with 300 ms to spare at scales 1, 1.5, 2 and 3.
  - The hold clock still restarts when a strike starts.
- **Signature-waiting basic hold:** this is the scaled windup + 500 ms gap (it reads the mob's own rhythm).
- **Landing gaps** (300 ms basic, 500 ms around a signature): unchanged. They space landings for the dash i-frames,
  not windups.
- **Signature spacing** (3000 ms, at or above the dash cooldown): unchanged. Only one signature is live per player,
  so a scaled signature longer than 3 s simply lands later.
- **Governor:** it is still anchored to the tuned Phase 1 reference hold. Longer holds only lower what packs can
  land.
- **Landing ticks:** signature landing ticks come from the scaled telegraphs (`resolveArchetypeTactics`). Basic
  landings come from the scaled rhythm.

## 3. Readability on the phone network

`apps/client/full-app-tests/telegraphTime.spec.ts` runs against a local feature runtime (same machine, same clock).
The phone network is simulated at 140 ms RTT ±30 ms. A mixed pack (wolves, bear, hedge witch, hog, squirrel) attacks
the player for 60 s; there were 12 telegraphs in the last run.

| Measure | Median | p95 |
|---|---|---|
| Server windup start → frame reaches the page (tick, delta flush, socket) | 44 ms | 57 ms |
| Server windup start → frame handed to the app (after the phone hold) | 159 ms | 191 ms |
| Server windup start → decal on screen (second frame after delivery) | 203 ms | 233 ms |
| Share of the telegraph visible before the server resolves | 82 % | 76 % min |
| Melee windup 1100 ms: visible | 897 ms | |
| Maul 1400 ms: visible | 1180 ms | |
| Measured PING/PONG round trip in that page | about 270 ms | |

**Fix: the decal ended late.** The client anchored `localEnd = arrival + remainingMs`. Nothing allowed for the time
on the wire, so the decal finished **159 ms (median) after the server had already resolved the strike**. Its fill was
just as late. That cheats the player: a dodge timed to the decal's end was too late.

`map/telegraphWindow.ts` now subtracts half the smoothed PING/PONG round trip, capped at 150 ms and never below 0:

- The decal now ends **+15 ms (median, p95 +47)** from the server resolve.
- A cast seen late shows part-filled, with its true time left. The fill is anchored once and never restarted.
- The mob windup pose uses the same window.

The guard in the spec is that the decal is on screen within 250 ms (p95) of the windup start.

This client change does need a client release (OTA). Scale changes do not.

## 4. Tests

- `server/combat/combatEngine.telegraphScale.test.ts`:
  - At scale 2.0, every windup doubles in the real engine: Phase 1 melee, brute basic, caster aim, swarm wave, hog
    charge.
  - The knob is clamped (0.4 and NaN → 1, 9 → 3, 1.5 → 1.5x).
  - Action combat without tactics and shared mobs keep the legacy 450 ms.
  - Signature landing ticks double, and the stuck-holder fail-safe doubles.
- `shared/mobTactics.test.ts`: the helpers (scale, clamp, rhythm, params, signature, fail-safe).
- `client/map/telegraphWindow.test.ts`: latency compensation and its cap.
- The engine and shared timing tests now derive from the constants, or state the new values.
