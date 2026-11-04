# Hurt circles: 2.5D hit geometry

Branch `feature/hurt-circles--from-t1527`. Owner decision: "use the conventional approach."

## The principles we copy from comparable games

Nobody publishes how comparable games handle collision, so these are the conventions you can see in the game and
that 2.5D action games commonly use. We don't claim this is their code.

1. **Every combatant has a ground hurt circle at its feet.** Hits are tested on the ground plane. The art (and any
   height) floats above the circle and never takes part in a hit test.
2. **An attack is a ground shape.** A cone, circle, lane or swept projectile path. A hit happens when the shape
   **overlaps** the hurt circle. Being "centre point inside the shape" is no longer required: if any part of your
   circle is on the red decal, you're hit. To dodge, the whole circle has to get out.
3. **Telegraph decals stay on the ground** and are the truth: the drawn decal is the shape the server tests.
4. **Projectiles fly at body height**, with a small soft shadow on the ground at their true position. The shadow is
   what the server tests.
5. **Impact VFX happen at the body**: sparks, impact sprites and damage or DODGE numbers spawn at the target's chest
   point (feet + height offset), not at the feet.
6. **Dash i-frames are unchanged.**

## Constants (all in `packages/shared/src/hitGeometry.ts` unless noted)

| Constant | Value | Meaning |
|---|---|---|
| `PLAYER_HURT_RADIUS_SCALE` | 0.65 | share of half the player body width |
| `PLAYER_HURT_RADIUS_M` | 13.8 m | 0.65 × `MOB_TACTICS_PLAYER_BODY_WIDTH_M` (42.4 m) / 2 |
| `MOB_HURT_RADIUS_SCALE` | 1.05 | × half the art-derived body width (`mobTacticsBodyWidthM`), slightly player-favoured |
| `mobHurtRadiusM(archetype, sprite)` | wolf 40.0, generic 41.2, bear 58.0, ogre 58.9 m | a mob's circle |
| `MOB_HURT_RADIUS_MAX_M` | 168.5 m | the largest circle in the catalog (broad-phase query margin) |
| `hurtShapeReachM(effective, r)` | effective − r | drawn/tested size that connects at the old centre distance |
| `SWING_RANGE_M` (actionCombat.ts) | 130 → **110** | swing arc length to the target's circle edge |
| `SHOT_RANGE_M` (actionCombat.ts) | 300 → **280** | shot reach to the circle edge |
| `SHOT_WIDTH_M` (actionCombat.ts) | 30 → **10** | the arrow itself (5 m radius swept projectile) |
| `MOB_TACTICS_MELEE_REACH_M` + `_SLACK_M` (mobTactics.ts) | 130 + 20 = 150 m | managed melee effective reach, now a literal (was tied to the swing range) |
| `COMBAT_CHEST_HEIGHT_SHARE` (client `map/spritePresentation.ts`) | player 0.50, mob 0.45 | chest height as a share of the drawn sprite height |
| `MOB_SHOT_FLIGHT_MS` (client `combat/projectileLift.ts`) | 180 ms | mob shot flight after its telegraph resolves |
| `FEEDBACK_BASE_Y_PX` (client `combat/damageFloaters.ts`) | -56 → -12 px | floater start offset, now relative to the chest |

Helpers: `circleVsCircle`, `circleVsCone`, `circleVsRect` (lane decals), `circleVsSegment` (swept projectile or body;
the whole path is tested at once, so nothing can tunnel), `segmentCircleDistanceM`.

## Reach rule (keeping the feel stable)

- **Reach is compensated.** Reach means lane length, cone range or circle radius. Shapes are drawn and tested at
  `hurtShapeReachM(table value, target radius)`, so the centre-to-centre connect distance is still the table value.
  The AI tables (trigger ranges, seats, engage rings) are untouched and keep their meaning.
- **Width isn't compensated.** Lane and cone widths stay as drawn, so the whole hurt circle has to leave. Dodging
  sideways needs 13.8 m more clearance than before. The walk-out tests (`mobArchetypes.test.ts`) now include the
  circle, and every telegraph still passes at scale 1.
- **Player attacks use the mob's art circle.** Big bodies are easier to hit and small ones harder (the usual way).
  The swing and shot ranges were shortened by about one wolf radius, so a typical mob connects where it used to.
- Telegraph timings are unchanged. `MOB_TELEGRAPH_SCALE` is still available if the extra lateral clearance feels
  tight.

## Effective reach table (centre-to-centre distance, straight ahead)

The test `hitGeometry.test.ts > effective reach parity table` checks this table.

| Attack | Old effective | New effective | Drawn shape (old → new) | Lateral change |
|---|---|---|---|---|
| Player swing vs wolf (r 40.0) | 150 | 150.0 | arc 130 → 110 | arc edge + mob circle |
| Player swing vs generic body (r 41.2) | 150 | 151.2 | | |
| Player swing vs bear/ogre (r 58–59) | 150 | 168–169 | | bigger is easier |
| Player swing vs smallest art (r 6.5) | 150 | 116.5 | | smaller is harder |
| Player swing vs boss (was flat 40) | 170 | 110 + art r | | |
| Player shot vs wolf | 320 (lateral 35) | 320.0 (lateral 45.0) | line 300 → 280, 30 → 10 wide | +10 m |
| Managed mob melee | 150 | 150.0 | cone 130 → 136.2 | +13.8 m off the 45° edge |
| Swarm wave (basic, 70°) | 150 | 150.0 | cone 130 → 136.2 | +13.8 m |
| Unmanaged melee windup (100 m mob) | 105 | 105.0 | cone 100 → 91.2 | +13.8 m |
| Ranged aim (300 m caster) | 300 (lateral 20) | 300.0 (lateral 33.8) | lane 300 → 286.2 | +13.8 m |
| Charge (lane, 120 wide) | lane length | same | length − 13.8 | +13.8 m |
| Maul (cone 100°) | 180 | 180.0 | 180 → 166.2 | +13.8 m |
| Slam (circle) | 110 | 110.0 | r 110 → 96.2 | none (all reach) |
| Lunge (lane, 50 wide) | 160–240 | same | length − 13.8 | +13.8 m |
| Double strike (cone 70°) | 110 | 110.0 | 110 → 96.2 | +13.8 m |
| Smoke step (circle) | 50 | 50.0 | r 50 → 36.2 | none |
| Swoop (cone 90°) | 130 | 130.0 | 130 → 116.2 | +13.8 m |
| Ground blast (circle) | 100 | 100.0 | r 100 → 86.2 | none |
| Volley (3 lanes, 40 wide) | 260 | 260.0 | 260 → 246.2 | +13.8 m |
| Tongue (lane, 60 wide) | lane length | same | length − 13.8 | +13.8 m |
| Legacy slam / bomb / maul / swoop | 110 / 90 / 180 / 130 | same | − 13.8 | as above |
| Legacy hog/stag charge, frog pull | sampled points within width | capsule, same end reach | length − 13.8 | +13.8 m, no gaps between samples |

## Server hit call sites changed (`apps/server/src/game/combat/`)

- `combatEngine.ts readSwingCandidate`: the mob radius is `hurtRadiusM(mob)` (art-derived) instead of the flat 20/40.
  Used by `selectSwingTargets` and `selectShotTarget` in `swingResolver.ts`, which needed no change (they were
  already circle tests).
- `combatEngine.ts hurtRadiusM` (new): player → `PLAYER_HURT_RADIUS_M`; mob → `mobHurtRadiusM`.
- `combatEngine.ts performSwing`: the grid query margin is `MOB_HURT_RADIUS_MAX_M`.
- `combatEngine.ts triggerSkirmisherHops`: the hop trigger uses the swing reach to that mob's circle.
- `combatEngine.ts beginMeleeWindup` and `resolvePendingMeleeStrike`: the cone is drawn at `reach − r(target)` and
  tested with `circleVsCone` (point blank kept). This covers the unmanaged windup, managed melee, the archetype
  basic and the swarm wave. `slackM` is removed from `PendingBasicStrike`.
- `combatEngine.ts beginRangedAim` and `resolvePendingRangedShot`: the lane is drawn at `range − r` and tested with
  `circleVsRect`.
- `combatEngine.ts beginSignature`: every signature decal (line, cone, circle, fan, the second double-strike cone)
  is drawn with `signatureDrawnM`.
- `combatEngine.ts applySignatureHits`: lane, fan, circle and cone hits use the overlap helpers with
  `PLAYER_HURT_RADIUS_M`.
- `combatEngine.ts processStag` (legacy hog/stag charge): the sampled points are replaced by a `circleVsSegment`
  capsule, and the decal length is compensated.
- `combatEngine.ts processGimmickStrike` decals and `resolveGimmickStrike` (legacy slam, bomb, maul, swoop, pull): the
  drawn reach is compensated, with `circleVsCircle`, `circleVsCone` and `circleVsSegment`.
- `mobArchetypeSignatures.ts`: `signatureConeContains`, `signatureCircleContains` and `signatureLaneContains` take
  the hurt radius. `signatureDrawnM` is new.
- `mobTactics.ts` (server) has no hit tests; it only handles positioning. Nothing changed there.
- **No player-vs-player swing path exists** (`readSwingCandidate` only accepts mobs). If one is added, it gets the
  player circle through `hurtRadiusM`.

**Not converted yet (still point tests):** dungeon, boss and special-zone telegraphs. These are Monastery sweeps,
iron statue, bell spirit, raptor spitter zones, squid ink and acid zones, cliff hawk dive, `bossFramework`, the
Wyrm Hollow, Eyrie and Grove behaviours, and Golem Forge. Each one compares `distanceMeters(...) <= radius`. They
should move to the same helpers in a follow-up.

## Client

- Prediction: `App.tsx` swing and shot candidates and tap auto-aim (`combat/swingAim.ts`) use `mobHurtRadiusM`. The
  swing arc visual already uses `SWING_RANGE_M`, so it now matches. Mob telegraph decals come from the server's
  compensated geometry.
- Projectiles: the player's arrow flies at chest height (`combatChestLiftPx(player)`), and mob shots fly at chest
  height too. Mob shots are the ranged aim, the three volley lines and the blast orb, which flies from the caster to
  the blast centre. All of them draw a soft ground shadow on the authoritative path (`combat/projectileLift.ts`).
- VFX: sparks, projectile impacts and floaters (damage and DODGE) anchor at `combatChestPointInto`. Telegraph decals
  stay on the ground.
- Dev overlay: Developer App > Developer View > **Show hurt circles**. It's off by default, lasts for the session
  only, and only applies when dev observe is on. It draws a cyan circle for the player and red circles for mobs at
  the feet. Dev builds also expose `window.__ashHitGeometryProbe` for the full-app spec.

## How to tune

- Player feels too easy or too hard to hit: change `PLAYER_HURT_RADIUS_SCALE`. Mob decal reach adjusts itself
  through `hurtShapeReachM`; only the lateral clearance changes.
- Player attacks connect too early or late on typical mobs: change `SWING_RANGE_M` / `SHOT_RANGE_M`. To change how
  much size matters, change `MOB_HURT_RADIUS_SCALE`.
- One mob's art gives a silly circle: add an entry to `MOB_TACTICS_BODY_WIDTH_OVERRIDES` (mobTactics.ts). That also
  moves its seat spacing.
- The extra 13.8 m of lateral clearance makes dodging feel tight: raise `MOB_TELEGRAPH_SCALE` (timing), or lower
  the player radius.
- Projectile or VFX height: change `COMBAT_CHEST_HEIGHT_SHARE` (client `map/spritePresentation.ts`).

## Screenshots (`docs/plans/hurt-circles/`)

- `lifted-arrow-shadow.png`, `lifted-arrow-shadow-frames.png`: an arrow in flight above its ground shadow (third
  frame of the strip).
- `debug-hurt-circles.png`, `debug-hurt-circles-zoom.png`: the dev overlay (red mob circle at the wolf's feet, cyan
  player circle).
- `wolf-melee-hit.png`: a managed wolf strike landing on the hurt circle (cone drawn at 136.2 m).
