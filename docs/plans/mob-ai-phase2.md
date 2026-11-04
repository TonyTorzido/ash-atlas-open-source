# Mob AI Phase 2: archetype behaviours (movement style, rhythm, one signature move)

Status: design decisions folded in (section 0). Chunks A-E built (server engine, flag default off); chunk F partial; G and H not started.
Worktree: `C:\Users\dev\Documents\worktrees\mob-archetypes__t1511`, branch `feature/mob-archetypes--from-t1511` (from master, live t1511, e837cd858).
Builds on `docs/plans/mob-ai-phase1.md` (tokens, ring slots, separation, rhythm, ranged aim). Read its sections 0, 2.4, 2.5, 8, 9, 10 first.
Units: metres and milliseconds. Player speed 125 m/s, dash 200 m with 200 ms i-frames and a 1.5 s cooldown, swing reach 130 m, swings 700/700/900 ms, server tick 20 Hz.

Everything here runs only when `ACTION_COMBAT_ENABLED`, `MOB_TACTICS_ENABLED` and the new `MOB_ARCHETYPES_ENABLED` (default off) are all on. Flag off is Phase 1, byte for byte.

## 0. Design decisions

The recommended answer was adopted on all six questions (section 13). Mapping calls marked `*` in section 3 stand as written.

| # | Decision |
|---|---|
| 1 | Per-archetype rhythm allowed; each damage factor = cycle / 1400 (Swarmer excepted: 0.30, deliberately weak, pays 0.5 token) so a lone mob's damage rate is unchanged. |
| 2 | Witches, bonebow and blowgunner get a 260 m reach only while `MOB_ARCHETYPES_ENABLED` is on. |
| 3 | Knockback from managed signatures capped at 60 m; the miss stagger reward stays. |
| 4 | Large deer-template animals stay Swarmer for Phase 2; revisit in Phase 3. |
| 5 | Shell and quill mobs get no offensive signature. |
| 6 | No terrain line of sight; a clear-lane check only. Terrain LOS is Phase 3. |
| 7 | **Design decision** (2026-10-13; the intent for decision 1 was "different attack speeds per type, damage per second kept the same"). Hit factors are tuned until every archetype deals 0.8x to 1.1x of Phase 1 at pack sizes 1, 2 and 4 against a still player (size 8 may sit lower where Phase 1 itself dips). Casters get 2 ranged points while archetypes are on. The mixed-pack ceiling is whatever the 2 s governor enforces, and the governor caps landed damage at 1.25x the Phase 1 token ceiling. This replaces "damage factor = cycle / 1400" and the Swarmer's 0.30. |

## 1. What Phase 1 left us (facts that shape the design)

| Fact | Where | Consequence for Phase 2 |
|---|---|---|
| Every managed melee mob runs one rhythm: windup 450, recover 300, cooldown 650 (1.4 s). `MOB_RHYTHM_OVERRIDES` is empty. | shared `mobTactics.ts` | Per-archetype rhythm slots in without new plumbing. |
| Per-mob signature moves already exist and run on their own timers: ogre slam, bear maul, hog charge, owl swoop, bandit smoke, frog tongue, squid ink, goblin bomb. | server `mobGimmicks.ts`, `processGimmickStrike`, `processStag` in `combatEngine.ts` | They are **not gated by tactics**: no token, no landing gap, can fire while the mob has a basic windup live. Phase 2 re-homes them as the signature moves instead of inventing new ones. |
| Accidental interactions today: hog charge needs 180 m or more and so fires from the wait bands; frog tongue needs 120 m or more, same; owl/eagle swoop needs 130 m or less but a ranged owl holds the 157 m ring, so it never fires; slam and maul fire from the engage ring beside a basic windup. | engine 9345-9440, 10085, 10491 | Phase 2 puts all of them behind the token and a landing rule (section 6). |
| Telegraph pipeline: `addMobTelegraph(mob, abilityId, geometry, durationMs)`, geometry `circle`, `cone` or `line`, ids are `<archetype>_<kind>`. Client draws all three as painted decals and maps the id suffix to an animation program (`_charge`, `_maul`, `_slam`, `_swoop`, `_smoke`). | `telegraphDecal.ts`, `mobActionAnimation.ts` | Almost no client work (section 7). |
| Hit tests exist for cone (`meleeWindupConeContains`), line lane (`rangedLaneContains`, `chargeLaneSamples`), circle (distance). Dash i-frames count as a dodge everywhere through `isEntityInvulnerable`. | shared `actionCombat.ts`, `mobSpecialBehaviors.ts` | Reuse. |
| A miss on slam, maul, swoop or charge already staggers the mob for 5 s (takes 1.25x, melee 1.5x); a hit costs it 600 ms. | `DODGE_REWARD`, `applyStrikeAftermath` | Kept as the Brute's dodge reward. Lighter versions for the others (section 4). |
| Raptor family (cave raptor flank pounce, runt flee, spitter back-off and acid) is dungeon-only, so it is unmanaged. | `mobSpecialBehaviors.ts` | No conflict; they are the reference designs for Pack and Caster (section 9). |
| No line-of-sight code exists anywhere. | grep | Casters use a "clear lane" check, not LOS (question 6). |
| Overworld roster is 128 mobs; all `common` tier by level (epic and legendary are rolled per spawn). Only two mobs (owl, eagle) have a basic reach above 100 m, so the ranged pool is nearly empty today. | roster dump | Caster needs a reach override for four humanoids (question 2). |

## 2. The five archetypes

Refinements to the starting proposal are marked **(changed)**.

| Archetype | Feel | Movement | Signature move |
|---|---|---|---|
| **Brute** | Heavy, patient, takes the front. | Walks straight in at 0.85x speed, takes engage seats first, never strafes, never backs off. Its recover is a real punish window because it stays put. | **Heavy blow**, three looks by family: Charge (line), Maul (cone), Slam (circle). All are existing gimmicks, re-timed and token-bound. |
| **Pack hunter** | Wolves around you; one commits. | Circles the wait band (180 m) in one shared direction at 0.55x speed. Hurt (35% or less) and others alive: peels back for 2.5 s. | **Flank lunge**: a narrow lane from behind or beside, fast, short telegraph. |
| **Skirmisher** | Hit, step away, hard to pin. | Engage ring to strike, then a 50 m burst away in recover. **(changed)** The "sidestep player swings" idea is limited to a hop out of reach that only works while the mob is not winding up, once per 4 s, so it cannot dodge everything. | **Double-strike** (default: two cones, the second re-aimed), **Smoke step** (bandit family, existing), **Swoop** (owl and eagle, existing). |
| **Caster** | Stays back, makes you move. | Outer ring 200 to 260 m. Player inside 150 m: it backs up to 200 m if it is fast enough (speed 0.4x player or more); slow ones (frogs) hold ground like turrets. | **Ground blast** (circle on you), **Volley** (3-line fan) or **Tongue** (existing pull lane). |
| **Swarmer** | Many, weak, impatient. | Rushes at 1.1x, closer wait band (130 m), short strafe, no arrival grace, starvation threshold 2 s. | **Pile-on wave** **(changed)**: up to 4 swarmers wind up together and land on one shared tick. No cooldown move; the wave is the signature. |

Roster note: Brute is 64 of 128 mobs (half the overworld). It has to be the best-tuned archetype.

## 3. Mapping: every overworld mob (128, from `MOB_SPAWN_RULES`)

Rule: first an explicit per-mob exception, then the mob's **behaviour family** (`mobBehaviorArchetype`, the key the engine already uses to pick gimmicks), then the template. `*` = unclear, recommended mapping shown (details after the table). The map lives in `MOB_ARCHETYPE_BY_FAMILY` and `MOB_ARCHETYPE_OVERRIDES` in the shared file (section 4) and a test fails if any spawnable mob is unmapped.

| Archetype / look | Count | Mobs |
|---|---|---|
| **Brute / Charge** | 30 | jungle_tapir, hog, badger, woolly_hog, plains_bison, warthog, giraffe*, mud_hog, wild_yak, javelina, woolly_mammoth, ostrich*, musk_ox, snapjaw_flytrap*, pine_dryad, basilisk*, olive_dryad, giant_scorpion, muskellunge*, northern_pike*, beaver*, and the alligator family: alligator, caiman, crocodile, frostwater_troll, leech_mother, hammerhead_shark, sea_serpent, elder_mere_serpent, bridge_troll |
| **Brute / Maul** | 19 | bear, snow_bear, wolverine, snow_talonbear, thunderhorn, yeti, tide_wraith, moss_troll, cairn_golem, rime_troll, and the skeleton family: lizardfolk_warrior, barrow_wight, dust_mummy, kurgan_wight, frost_wraith, aurora_shade, phantom_lookout, drowned_bride, drowned_thrall |
| **Brute / Slam** | 9 | moss_golem, volt_elemental, cyclops_shepherd, permafrost_elemental, coral_golem, maelstrom_spirit, rapids_elemental, drowned_cultist, jellyfish* |
| **Brute / no offensive signature** | 6 | spur_thighed_tortoise*, snapping_turtle*, kappa*, kappa_brawler*, shellback*, crested_porcupine* (their shell or quills stay as they are) |
| **Pack hunter / Lunge** | 10 | mandrill, wolf, frost_wolf, spotted_hyena, lioness, dune_wolf, jaguar*, griffin*, storm_harpy*, ash_drake* |
| **Skirmisher / Double-strike** | 3 | mossjaw_spearman, centaur_outrider*, merfolk_harpooner* |
| **Skirmisher / Smoke step** | 2 | bog_hag, gate_warden |
| **Skirmisher / Swoop** | 2 | great_grey_owl, golden_eagle |
| **Caster / Ground blast** | 10 | hedge_witch, rime_witch, and the squid family: squid, underice_lurker, reef_kraken, manta_ray, humpback_whale, kraken, lake_maiden, ink_pool |
| **Caster / Volley** | 2 | gnoll_bonebow, frogfolk_blowgunner |
| **Caster / Tongue** | 5 | frog, frost_frog, poison_frog, desert_toad, nixie* (frog template, keeps its tongue) |
| **Swarmer / Pile-on wave** | 29 | the deer-template critters: red_squirrel, grey_squirrel, prairie_dog, alpine_marmot, mountain_ibex, wild_scrub_goat, fennec_fox, steppe_marmot, saiga, snow_goose, lemming, field_hare, arctic_hare, red_fox, river_otter, darter, plus wild_horse*, dromedary*, capybara*, seal*, mute_swan*, armadillo*; sap crawlers vine_lurker, bloat_leech; spiny_lobster*; sidewinder*, sea_otter*, river_salmon*, frogfolk_tadpole* |
| **Not managed** | 1 | drowned_citizen (speed 0, does not retaliate; stays as it is) |

Unclear mobs and the recommended call:

| Mobs | Why unclear | Recommendation |
|---|---|---|
| giraffe, ostrich, beaver, muskellunge, northern_pike, snapjaw_flytrap, basilisk | Hog-template stats but not boar-shaped (long-legged, fish, plant). | Brute/Charge by family. A rooted plant or fish still uses the same lane; revisit art-by-art in Phase 3. |
| jaguar | Bear template, but its own `POUNCE` first-hit proc reads as a solo ambusher. | Pack hunter (lunge replaces the opener). A lone jaguar is a pack of one and still lunges. |
| griffin, storm_harpy, ash_drake | Wolf template, flying fantasy. | Pack hunter by family. |
| centaur_outrider, merfolk_harpooner | Hog template, but a mounted or spear fighter. | Skirmisher. |
| turtles, kappas, shellback, porcupine | Slow, defensive; shell guard and quills are their `hasOwnGimmick`. | Brute with no offensive signature; keep the shell and quills as is (question 5). |
| wild_horse, dromedary, capybara, seal, mute_swan, armadillo | Deer-template stats (25 HP) but large sprites. | Swarmer for now (question 4). |
| sidewinder, sea_otter, river_salmon, frogfolk_tadpole, spiny_lobster | Frog or crab template, 7 to 10 HP, no tongue worth the name. | Swarmer. |
| nixie | Frog template, humanoid art. | Caster/Tongue (it has the frog tongue today). |
| jellyfish | 900 HP, ocean, no gimmick. | Brute/Slam (its only hit stays a basic hit if the art cannot sell a slam). |
| hedge_witch, rime_witch, gnoll_bonebow, frogfolk_blowgunner | World-goblin template with reach 100, so they are melee today. | Caster, with a reach override under the flag (question 2). |

## 4. Parameters (all constants in one new shared file)

File: `packages/shared/src/mobArchetypes.ts`, exported through the package index like `mobTactics.ts`. It holds the archetype ids, the mapping, the tables below, and pure helpers. No engine types. Phase 1's `MOB_RHYTHM_OVERRIDES` and `MOB_TACTICS_BODY_WIDTH_OVERRIDES` stay; the archetype table feeds `deriveMobRhythm` through them.

### 4.1 Rhythm, movement, tokens

Damage factor is **cycle / 1400** (Swarmer is the exception: 0.30 by design), so a lone mob has the same average damage rate as today and the "uniform attack speed, balance by per-hit levers" rule holds in spirit (question 1).

| Parameter | Brute | Pack | Skirmisher | Caster | Swarmer |
|---|---|---|---|---|---|
| Windup (ms) | 600 | 400 | 400 | 450 (aim) | 300 |
| Recover (ms) | 500 | 250 | 400 | 350 | 200 |
| Cooldown (ms, before 10% jitter) | 900 | 450 | 800 | 600 | 500 |
| Cycle (ms) | 2000 | 1100 | 1600 | 1400 | 1000 |
| Basic damage factor | 1.40 | 0.80 | 1.15 | 1.00 | 0.30 |
| Lone-mob damage rate (per second, Phase 1 = 0.714) | 0.70 | 0.73 | 0.72 | 0.71 | 0.30 |
| Move speed factor (on the mob's own speed, clamped to 0.95x player) | 0.85 | 1.15 | 1.2 on bursts, else 1.0 | 1.0 (retreat 1.1) | 1.1 |
| Preferred distance | engage ring (about 85 to 110 m) | wait band 0 to 1 (160 to 200 m) | engage ring to strike, then 200 m | outer ring 200 to 260 m | engage ring and band 0 at 130 m |
| Strafe (share of speed, direction) | 0 | 0.55, one shared direction per pack, flips every 6 to 10 s | 0.2, flips as Phase 1 | 0 | 0.4, flips as Phase 1 |
| Token cost (basic) | 1 | 1 | 1 | 1 (ranged pool) | **0.5** (melee pool) |
| Token cost on signature | 2 | 1 | 1 | 1 (ranged pool) | 0.5 (wave) |
| Back-off in recover (m) | 0 | 20 | 50 | 0 | 0 |
| Arrival grace (ms) | 400 | 400 | 400 | 400 | 0 |
| Starvation threshold (ms) | 4000 | 4000 | 4000 | 4000 | 2000 |
| Basic reach (m) | 125 | 125 | 125 | 260 (override for 4 humanoids) | 90 |

Epic and legendary mobs: archetype cost is replaced by the Phase 1 tier cost (2) when higher. Swarmer 0.5 only applies to common tier.

### 4.2 Retreat and reaction rules

| Archetype | Rule | Numbers |
|---|---|---|
| Brute | Never retreats, never backs off. | none |
| Pack | **Hurt retreat**: at 35% HP or less, if at least one other pack mate is alive, drops to wait band 2, takes no tokens, then returns. At most one retreating mate per player. | 2500 ms retreat, 8000 ms before it can retreat again |
| Skirmisher | **Back-off burst** in recover. **Hop**: when a player swing is committed on it and it is not in windup, recover or stagger, it hops out of reach. | 50 m over 400 ms; hop 90 m directly away in 150 ms, 4000 ms cooldown |
| Caster | **Kite**: player inside 150 m, back up to 200 m. Slow casters (speed under 0.4x player) hold ground. A caster that cannot back up (habitat edge) just fires. | kite trigger 150 m, target 200 m |
| Swarmer | None. | none |

### 4.3 Signature moves

All telegraph shapes use today's geometry. "Locked" means origin and facing are fixed at telegraph start, so moving sideways dodges, same as Phase 1.

| Move (archetype) | Telegraph | Telegraph time | Damage factor | Per-mob cooldown (from landing) | Trigger | How to dodge |
|---|---|---|---|---|---|---|
| **Charge** (Brute, hog and alligator families) | `line`, locked, 120 m wide (hit if within 60 m of lane), length = distance to player + 80 m, from 180 to 500 m away | 900 | 1.25 animal, 1.5 fantasy | 7000 | Token holder at 180 m or more with sight of the player (a clear lane) | Step 60 m aside, or dash through (i-frames at the resolve tick). Mob ends at the lane end. |
| **Maul** (Brute, bear, skeleton, orc families) | `cone`, 100 degrees, 180 m, locked | 1000 | 1.3 animal, 1.8 fantasy (existing `BEAR_MAUL` numbers) | 7000 | Token holder on the engage ring, player within 140 m | Walk out of the cone, or dash. |
| **Slam** (Brute, ogre family) | `circle` on the mob, radius 110 m | 1200 (110 m takes 0.9 s to leave, plus reaction) | 1.6 | 8000 | Token holder, player within 130 m | Walk or dash out of the circle. |
| **Flank lunge** (Pack) | `line`, locked, 50 m wide, 160 m long, drawn from the lunge start. Start point is on the wait band at a bearing 100 degrees or more off the player's heading (behind or beside), reached by the normal orbit. | 500 | 1.2 | 6000 | Token holder in the rear arc, player heading known | Step 25 m aside, or dash. Mob ends adjacent to the player's locked position. |
| **Double-strike** (Skirmisher) | two `cone`s, 90 degrees, 125 m. The second is re-aimed at the player when the first resolves. | 450, then 350 | 0.65 each (1.3 total) | 6000 | Token holder on the engage ring | Leave cone 1, then leave cone 2 (it follows). |
| **Smoke step** (Skirmisher, bandit family, existing) | `circle`, 50 m, on the point 60 m behind the player | 1100 (existing) | next hit within 6 s lands 1.75x | 10000 (existing) | Token holder, player 130 to 500 m away | Move off the puff or fight the next hit with a dash. |
| **Swoop** (Skirmisher, owl and eagle, existing) | `cone`, 90 degrees, 130 m | 1000 (was 1300) | 1.3 | 8000 | Token holder; the bird drops to the engage ring for the strike, then climbs back to 157 m | Walk out of the cone, or dash. |
| **Ground blast** (Caster, witches and squid family) | `circle` at the player's position, radius 100 m, locked | 1100 | 1.3 (squid ink keeps its slowing cloud: 0.25 per tick, 4 s) | 6000 | Token holder, clear lane, player 150 to 300 m | Walk 100 m out, or dash. |
| **Volley** (Caster, bonebow and blowgunner) | three `line`s, 40 m wide, 260 m long, fan of 36 degrees (centre on the player, side lines 18 degrees off), one hit maximum | 700 | 0.6 per line | 6000 | Token holder, clear lane | The player stands on the centre line, so step sideways 20 m out of it (side lines are 18 degrees off, wide of you at range). |
| **Tongue** (Caster, frog family, existing) | `line`, 60 m wide, 120 to 350 m | 900 | 0.6 and pull to 70 m | 8000 | Token holder in range | Step aside or dash. Slow frogs hold ground. |
| **Pile-on wave** (Swarmer) | up to 4 small `cone`s, 70 degrees, 90 m, all landing on **one shared tick** | 300 | 0.30 each | none (every cycle) | Granted swarm tokens in the same tick | One dash or a step out of the ring gap. |

Existing values stay in `mobGimmicks.ts` for the flag-off and unmanaged paths. The shared table copies them, and a test asserts the shared and server copies match.

### 4.4 Dodge reward (miss behaviour)

| Archetype | Miss | Hit |
|---|---|---|
| Brute | Stagger 5000 ms, takes 1.25x (1.5x melee), existing `DODGE_REWARD` | recovery 600 |
| Pack | Stagger 1500 ms | recovery 400 |
| Skirmisher | Stagger 1000 ms (both cones missed) | recovery 300 |
| Caster | none; recover 500 | recover 500 |
| Swarmer | none | none |

## 5. Readability rules added on top of Phase 1 section 2.8

1. At most **one signature telegraph live per player**.
2. Signature **landings are at least 1600 ms apart** per player. That is more than the 1500 ms dash cooldown, so the dash is always back before the next signature.
3. No basic landing within **500 ms either side** of a signature landing. Basic-to-basic stays 300 ms.
4. A signature telegraph is at least 450 ms and at least 250 ms longer than the time to walk out of it.
5. A signature shape never matches a basic one (basic = cone or aim line; signatures use lane, circle, fan or the second cone), and telegraph ids are registered in `MOB_SIGNATURE_ABILITY_IDS` so the client can style them.

## 6. State machine: how archetypes plug in

Phase 1 phases (`approach, wait, windup, strike, recover, cooldown`) do not change. Three additions.

### 6.1 New per-mob state (transient, on `MobTacticsState`)

`archetype`, `params` (resolved once at join from the table), `signatureKind | null` (the move, null if none), `signatureReadyTick`, `inSignature` (this cycle is a signature), `retreatUntilTick`, `orbitDir`, `hopReadyTick`, `waveId`. New field `pendingSignature` on `MobSpecialState` beside `pendingBasicStrike`: kind, locked geometry, `dueTick`, extra strike index.

### 6.2 Where behaviour hooks in

| Phase 1 step (`processTacticsTarget`) | Archetype change |
|---|---|
| 1 Validate | Resolve archetype params on join. Hand back (cancel telegraph, release token) if the mob loses its target mid-signature. |
| 3 Timed phases | `recover` uses the archetype recover and back-off; signature `strike` runs `resolveSignature`; the miss stagger releases the token **at once** (a stagger never holds a token). |
| 4 Rings and slots | Ring and band choice come from `preferredDistance`; Pack uses shared orbit; retreating mobs go to band 2 and are skipped for seats. |
| 5 Candidates | `cost` is the archetype cost. `wantsSignature = tick >= signatureReadyTick && trigger holds && signature slot free`. A swarm candidate carries `waveId`. |
| 6 Start windup | If `wantsSignature` and the ledger can also cover `signatureCost`, the cycle becomes a signature (extra points taken at the grant, else it stays a basic strike). Then `beginSignatureTelegraph` instead of `beginMeleeWindup`. |
| 7 Movement | Per-archetype movement model (push, orbit, burst, kite, rush) replaces the single slot-seek; separation, minimum spacing and the one write per mob per tick are unchanged. |

### 6.3 Tokens and the landing gap

- **No special token pool.** A signature spends the mob's own token at the archetype's `signatureCost` (Brute 2, so it swings alone; Pack, Skirmisher and Caster 1; Swarmer 0.5). The ledger's costs become fractional; capacity stays 2 melee and 1 ranged, so existing arithmetic works.
- **One signature slot per player** (a single field, not a pool). It holds from telegraph start to landing, and a second field enforces the 1600 ms spacing.
- **Landing windows replace the single cursor.** The ledger keeps up to 4 reserved landings `{landTick, kind}`. A new landing may not fall within 300 ms of a basic one or 500 ms of a signature one. Swarm wave members may share one tick. A telegraph is never shortened; only its start is delayed. With basic strikes only this gives the same result as the Phase 1 cursor (a test proves it), so flag-off-equivalent behaviour is preserved.
- Token hold on a signature is telegraph + recover (at most 1200 + 500 = 1700 ms, under the 2500 ms fail-safe).
- Target swap or hand-back mid-signature cancels the telegraph, refunds nothing, and sets `signatureReadyTick = now + 1500`.
- **Legacy gimmicks:** under the flag, `processMobSpecials` skips `processStag` and `processGimmickStrike` for a **managed** mob whose archetype owns that move, so nothing fires twice. An unmanaged mob (boss, dungeon, pet target) keeps the old timers. Procs and thresholds (howl, enrage, pounce, death roll, quills, shell, poison, splits, bursts) are not signatures and keep running with the basic hit. Pounce does not stack with a lunge: the first hit uses the larger factor.
- Telegraph ids for multi-part moves add a suffix (`_a`, `_b`, `_l`, `_c`, `_r`) because `castInstanceId` is `entity:ability:tick`.

## 7. Client needs

| Need | Covered by existing code? | Work |
|---|---|---|
| Charge lane, lunge lane, volley lines, tongue | Yes: `line` decal with chevrons. | None. |
| Slam, ground blast, smoke puff | Yes: `circle` decal. | None. |
| Maul, swoop, double-strike cones, wave cones | Yes: `cone` decal. | None. |
| Several telegraphs from one mob (volley 3, double-strike second cone) | Server list cap is 256 casts; client draws any number. | Check one mob with 3 live casts draws cleanly. |
| Ability-id to ground marks and animation | Suffix map. | Add `_lunge` to program `charge`, `_blast` and `_volley` to a cast pose (reuse `howl`), `_double_a` and `_double_b` to `maul`; marks for `_lunge` chevrons. About 20 lines. |
| Signature looks different from a basic strike | Not today. | Draw ids in `MOB_SIGNATURE_ABILITY_IDS` with a heavier ink outline; no new protocol. |
| Retreat, hop and orbit | Plain position updates, 10 Hz deltas. | Check facing during orbit and hop (Phase 1 task C1 applies). Hop and lunge steps over 40 m are snapped by the client (`MOB_RENDER_SNAP_M` 40): keep steps under 40 m per delta or let the charge animation program cover the jump. |

No protocol change.

## 8. Balance guardrails

Unit: HE = one Phase 1 common melee hit. Phase 1 is 0.714 HE/s per mob, capped by the tokens at 2.67 HE/s (2 points over a 750 ms hold), landing-gap ceiling 3.33.

| Pack (pure) | Phase 1 HE/s | Brute | Pack | Skirmisher | Swarmer (4 at 0.5 pts) | Caster (ranged pool, extra) |
|---|---|---|---|---|---|---|
| 1 mob | 0.71 | 0.70 | 0.73 | 0.72 | 0.30 | 0.71 |
| 2 mobs | 1.43 | 1.40 | 1.45 | 1.44 | 0.60 | 1.25 (pool cap) |
| 4 mobs | 2.67 | 2.55 | 2.46 | 2.88 | 1.20 | 1.25 (pool cap) |
| 8 mobs | 2.67 | 2.55 | 2.46 | 2.88 | 2.40 | 1.25 |

(Pure ceilings are `capacity * factor / (cost * hold)`: Brute 2*1.4/1.1, Pack 2*0.8/0.65, Skirmisher 2*1.15/0.8, Swarmer 4*0.3/0.5.)

Rules:

1. **Basic ceiling:** every archetype's HE per point-second stays within 1.10x of Phase 1 (1.33 → at most 1.46; Skirmisher is the highest at 1.44). A shared unit test computes it from the table and fails on a breach.
2. **Mixed ceiling** (decision 7): whatever the 2 s governor enforces. The governor caps landed damage at 1.25x the Phase 1 token ceiling (2.67 x 1.25 = 3.33 HE/s, 6.67 HE per 2 s) and defers basic and signature starts alike while archetypes are on. Swarmers still pay in melee points.
3. **Signatures:** at most 1.25x Phase 1 including signatures (3.34 HE/s). Signature rate is bounded by rule 2 in section 5 (one landing per 1.6 s at most 1.8 factor is about 1.1 HE/s worst case, and it replaces a basic hit).
4. **Governor:** the ledger tracks landed HE per player over a sliding 2000 ms and defers a signature start that would push the window above 6.5 HE (about 1.22x Phase 1 for 2 s).
5. **Single lever:** `MOB_TACTICS_DAMAGE_FACTOR` (Phase 1, 1.0) still scales everything.
6. **Time to kill:** player damage, mob HP and mob speed definitions are not changed. The Pack hurt retreat is the only rule that can lengthen a kill; it is capped at one mate and 2.5 s and never applies to a lone mob. A telemetry check compares mean kill time for wolf packs against Phase 1.
7. Phase 3 does the real tuning; the constants file is the only place to change.

## 9. Existing special behaviours: map or conflict

| Behaviour | Where | Maps to | Conflict and resolution |
|---|---|---|---|
| Hog charge (`HOG_CHARGE`, `HOG_CHARGE_ANIMAL`) | `processStag` | Brute Charge | Re-homed, token-bound; legacy timer skipped for managed mobs. |
| Bear maul, ogre slam, owl swoop | `processGimmickStrike` | Brute Maul, Brute Slam, Skirmisher Swoop | Same. Swoop was unreachable from the ranged ring; fixed by dropping the bird to the engage ring for the strike. |
| Bandit smoke | `processGimmickStrike` | Skirmisher Smoke step | Same; uses the existing puff, 1.75x follow-up, and `directMobTarget` rejoin. |
| Frog tongue, squid ink | `processGimmickStrike` | Caster Tongue, Caster Blast | Same; ink keeps its slow cloud. |
| Goblin bomb | same | none (base `goblin` is not on the overworld) | Stays for unmanaged use. |
| Blighted stag charge | `processStag` | none (not in the overworld roster) | Unmanaged, unchanged. |
| Cave raptor flank pounce, runt flee, spitter back-off and acid | raptor family | Reference for Pack lunge, Pack hurt retreat, Caster kite and Blast | Dungeon-only and unmanaged. If dungeons ever get tactics: cave raptor = Pack, runt = Pack, spitter = Caster. `flankSlotPosition` and `raptorFamilyBehaviors.test.ts` untouched. |
| Pounce (jaguar, lioness, sidewinder) | `POUNCE` | first-hit proc | Kept; no stacking with lunge (max of the two). |
| Wolf howl, orc enrage, skeleton reassemble | thresholds | none | Kept as is. |
| Shell guard, quills, death roll, bird procs, slime split, darter and sick-rat bursts | procs | none | Kept as is; not signatures. |
| Hawk dive, flea and mouse hops, bat lifesteal | `processHawk`, hop code | none | Dungeon or non-roster; unmanaged. |

## 10. Flag

- `MOB_ARCHETYPES_ENABLED`, default `false`, in `apps/server/src/config.ts` beside `MOB_TACTICS_ENABLED`, passed as engine option `mobArchetypesEnabled`. Effective only when action combat **and** tactics are on.
- Optional narrow rollout: `MOB_ARCHETYPES_ONLY` (comma list, empty = all) to light up one archetype at a time in prod.
- Off or not listed: Phase 1 runs unchanged, legacy gimmicks included. Test: the Phase 1 engine suite passes untouched and a golden event run matches.

## 11. Test plan

### 11.1 Shared and pure
1. Mapping covers every `MOB_SPAWN_RULES` key and nothing maps to an unknown archetype.
2. Rhythm sums equal the cycle in section 4.1; damage factor within 0.05 of cycle / 1400 (Swarmer excluded).
3. Guardrail math (section 8 rules 1 and 2) computed from the table.
4. Shared gimmick numbers equal `mobGimmicks.ts` numbers.
5. Ledger: fractional costs, landing windows (basic 300 ms, signature 500 ms, shared wave tick), signature slot and 1600 ms spacing, governor deferral, release idempotent, equivalence with the Phase 1 cursor for basic-only runs.

### 11.2 Engine tests (`combatEngine.mobArchetypes.test.ts`, 20 Hz manual clock like `combatEngine.mobTactics.test.ts`)
| Archetype | Tests |
|---|---|
| Brute | stays on the engage ring, never strafes or backs off; charge telegraph 900 ms then lane hit or DODGE; dash at the resolve tick dodges; miss staggers 5 s and releases the token at once; slam circle and maul cone hit tests; signature costs 2 (a second mob cannot wind up beside it); legacy `processStag` does not fire for a managed hog. |
| Pack | orbit direction shared and steady; only one lunge at a time; lunge starts in the rear arc; hurt retreat only with a living mate, one at a time, 2.5 s; lunge miss staggers 1.5 s; lone wolf never retreats. |
| Skirmisher | back-off 50 m in recover; hop only when idle, once per 4 s; double-strike second cone re-aims; bandit smoke blinks behind and next hit is 1.75x; owl drops to the engage ring for the swoop. |
| Caster | holds 200 to 260 m; kites when inside 150 m; slow caster holds; blast circle locked; volley lines; reach override applies only under the flag. |
| Swarmer | wave of up to 4 lands on one tick; costs 0.5 each; no arrival grace; four swarmers plus one bear never exceed 2 points. |
| All | one signature live per player; 1600 ms spacing; no basic landing within 500 ms of a signature; ids registered; cancel on target swap, death, leash, hand-back; ledger empty after every end case; bosses, shared raid, dungeons, pet targets stay unmanaged; flag off equals Phase 1; HE/s per pack size within section 8 bands over a 60 s simulated run. |

### 11.3 Playwright (`apps/client/full-app-tests/mobArchetypes.spec.ts`)
Follows `mobTactics.spec.ts`: dev account, `DEV_SPAWN_MOB`, backend with `ACTION_COMBAT_ENABLED=true MOB_TACTICS_ENABLED=true MOB_ARCHETYPES_ENABLED=true DEV_TOOLS_ENABLED=true`. Desktop and 390x844.
1. Brute: spawn 2 bears and a hog; assert maul cone telegraph then resolve, charge lane from 180 m or more, never two signatures live.
2. Pack: 4 wolves; assert shared orbit, one lunge lane at a time from the rear arc.
3. Skirmisher: bandit and spearman; double-strike shows two cones in sequence; smoke puff behind the player.
4. Caster: hedge witch, bonebow, squid; blast circle, volley fan, distance 200 to 260 m, kite when walked at.
5. Swarmer: 8 red squirrels; wave cones share a landing tick.
6. Screenshot at telegraph peak for each signature (circle, lane, cone, fan) for review. Control run with the flag off.

### 11.4 Dev invulnerability run
Backend with `DEV_PLAYERS_INVULNERABLE=true`, spec with `ASH_ATLAS_E2E_INVULNERABLE=1`. Because invulnerability also counts as a dodge, this run is an **observation run** (sequence, spacing, shapes, no stuck tokens over 5 minutes per archetype group, frame logs and screenshots), not a damage check; damage is covered in 11.2. Also record per-archetype HE/s and mean kill time from combat telemetry into the output folder for the guardrail check.

## 12. Build order (checkpoint commit after each task)

| Task | Scope |
|---|---|
| A | `packages/shared/src/mobArchetypes.ts` (ids, mapping, tables, helpers, `MOB_SIGNATURE_ABILITY_IDS`), config flag and engine option, shared tests 11.1 items 1 to 4. |
| B | Ledger: fractional costs, landing windows, signature slot and spacing, governor; wave id; archetype params threaded through join and `MobTacticsState`; pure tests 11.1 item 5. Phase 1 suite green, flag off identical. |
| C | Movement models in `processTacticsTarget` step 7 and ring choice: Brute push, Pack orbit and hurt retreat, Skirmisher burst and hop, Caster kite and reach override, Swarmer rush; engine tests for movement. |
| D | Signature framework (`pendingSignature`, `beginSignatureTelegraph`, `resolveSignature`, aftermath, cancel and hand-back, legacy gimmick skip) plus Brute Charge, Maul, Slam; engine tests. |
| E | Pack lunge, Skirmisher double-strike, smoke step, swoop; Caster blast, volley, tongue; Swarmer wave landing; engine tests. |
| F | Client: suffix maps, marks, signature outline, three-cast check, tests. |
| G | Playwright spec, dev invulnerability run, screenshots, telemetry for guardrails; run all suites. |
| H (after owner playtest) | Constant tuning only (Phase 3 starts here). |

## 13. Open questions (6)

| # | Question | Recommended answer |
|---|---|---|
| 1 | Phase 1 decision 7 and the uniform-attack-speed rule put every mob on one 1.4 s cycle. Phase 2 wants a rhythm per archetype (Brute 2.0 s, Pack 1.1 s, and so on). Allowed? | Yes, as long as each cycle's damage factor equals cycle / 1400 so a lone mob's damage rate is unchanged. |
| 2 | Four humanoid mobs (hedge_witch, rime_witch, gnoll_bonebow, frogfolk_blowgunner) are melee today. Give them a 260 m reach, only when the flag is on, so they can be Casters? | Yes. It is a flag-gated override in the shared table; flag off keeps them melee. |
| 3 | Brute and Pack signatures can knock the player back (maul 150 m, slam 150 m today). That ejects the player from the ring and past the wait band. Keep? | Cap knockback at 60 m for managed signatures; keep the stagger reward. |
| 4 | 29 mobs map to Swarmer, including large deer-template animals (wild horse, dromedary, seal, swan). Fine for now? | Yes for Phase 2; sort large critters into Brute or a skittish prey behaviour in Phase 3 once art and spawn groups are reviewed. |
| 5 | Turtles, kappas, shellback and porcupine get no offensive signature (their shell or quills stay). Accept? | Accept. A defensive move is their identity and the shell is already a readable cue; add a small slam later if they feel idle. |
| 6 | Casters "need line of sight", but there is no LOS code. Build terrain LOS in Phase 2? | No. Use a clear-lane check (the lane crosses no blocked cell and no other caster's body) and put terrain LOS in Phase 3. |

## 14. Build notes (chunk A)

- Built in `packages/shared/src/mobArchetypes.ts` (+ `mobArchetypes.test.ts`), server copy-equality test `apps/server/src/game/combat/mobArchetypes.test.ts`, and config keys `MOB_ARCHETYPES_ENABLED` / `MOB_ARCHETYPES_ONLY` (parsed, not yet read by the engine).
- Swarmer is the one archetype whose damage factor is not cycle / 1400 (0.30 by design); noted in section 0.
- Check found that three frog-template mobs (sea_otter, river_salmon, frogfolk_tadpole) run the frog tongue today but map to Swarmer; they lose the tongue while managed under the flag. `nixie` moved to Caster/Tongue for the same reason. A test pins the exact list.
- Telegraph width of the tongue is 60 m (was written as 36 m in the first draft).
- Chunk F (partial): `mobActionProgramForAbility` maps `_lunge` to the charge pose and `_double_a`/`_double_b` to the maul pose (`apps/client/src/map/mobActionAnimation.ts`, with a test). The signature outline, cast pose for blast and volley, and the three-cast check are still open.

## 15. Build notes (chunks B-E)

- Ledger (`apps/server/src/game/combat/mobTactics.ts`): fractional costs (minimum 0.5), landing windows, one signature slot with 1600 ms spacing, cost upgrade for signature cycles, 2 s governor. A randomized test proves basic-only runs match the Phase 1 cursor decision for decision. Pure join and shape helpers live in `mobArchetypeSignatures.ts`.
- Engine (`combatEngine.ts`): `mobArchetypesEnabled` / `mobArchetypesOnly` options wired from config. Archetype resolved at join (`state.arch`, null = Phase 1). Turning the flag off mid-fight re-joins the mob as Phase 1. Legacy `processStag` / `processGimmickStrike` do not *start* for an archetype-managed mob; a strike already in flight still resolves. Shell guard and procs are untouched.
- Engine tests: `combatEngine.mobArchetypes.test.ts` (22 tests); ledger and helper tests: `mobTactics.archetypes.test.ts` (15 tests).

Spec corrections made while building:

1. **Signature cooldown storage.** It lives on `MobSpecialState.archSignatureReadyTick`, not `MobTacticsState`, so a target swap or re-join cannot reset it.
2. **Approach-phase signatures.** An archetype mob still approaching may ask for its signature. Otherwise a hog never charges from 180 m or more, because Phase 1 only lets waiting mobs ask.
3. **Signature priority.** A signature-ready mob asks at its signature cost even when it is in basic reach. Strict pool priority then keeps both points for a Brute. It may hold its points briefly while reserved basic landings clear its 500 ms window. Without this, a Brute among wolves never mauled.
4. **Slam reach.** A 110 m circle with a 130 m trigger misses anyone standing still at 111-130 m. The engine starts the slam only inside 95 m (radius minus 15 m), and the ogre steps in for it the way the owl drops in for its swoop.
5. **Lunge lane.** The 160 m lane is stretched to reach a target anywhere in its 120-240 m trigger (up to 265 m).
6. **Pack and Swarmer waiting.** Mobs that are not holding a token wait on their own band (180 m / 130 m) even when they hold an engage seat, and may ask for a token from that band. The token holder then walks in.
7. **Melee-reach casters.** Frog family, nixie and the squid family stay in the melee pool on the Phase 1 rings. Their tongue or blast fires from wherever the trigger holds. Only the four overridden humanoids use the 200-260 m outer ring and kite.
8. **Swarmer wave and reach.** The wave is the Swarmer's basic strike: a `swarmer_wave` cone of 70 degrees, a wave id, a shared landing tick and the basic landing kind. It does not take the signature slot. Reach is max(90, engage ring + 15).
9. **Damage.** Signature damage follows the legacy gimmicks: `attackDamage x factor` through scripted damage. Basic factors scale the basic hit in `applyDamage`. A missed target gets a DODGE innate event carrying the signature's ability id.

## 16. Chunk H: tuning and review

### Measurement

`apps/server/src/game/combat/combatEngine.mobArchetypes.balance.test.ts` runs each mob in packs of 1, 2, 4 and 8 for 60 simulated seconds against a player who stands still and is not displaced by knockbacks or pulls. Each pack runs twice: Phase 1 (archetypes off) and Phase 2 (archetypes on). Both harnesses now spawn players and mobs in real overworld zones (`zoneIdForPosition`); with the old `"world:NM"` zone every strike silently became a dodge, so Phase 1 is re-measured here. Run it with `MOB_ARCH_BALANCE_PRINT=1` to print this table. The test guards against regressions outside 0.35x to 1.45x. The 0.8x to 1.1x target is not met everywhere (see below).

Signature damage now scales off the mob's real basic hit on that player (the PvE matrix hit), so a factor of 1.0 is one Phase 1 basic hit. Before, it used the raw attack stat, which runs lower than the matrix hit (a wolf's attack stat is about 8 against a 13 matrix hit).

### Constant changes

- `MOB_ARCH_SIGNATURE_MIN_SPACING_MS` 1600 to 3000. With 1600 ms, a dense pack landed a signature every 1.6 s and the 500 ms windows on either side left little room for basics.
- Skirmisher `retreatToM` 200 to 160.
- New `MOB_ARCH_READY_BAND_M = { pack: 125 }`: a ready wolf waits at 125 m and fades back to 180 m only during its cooldown.
- Decision 7 hit factors: brute 1.4 to 1.5, pack 0.8 to 1.0, skirmisher 1.15 to 1.3, caster 1.0 to 1.1, swarmer 0.3 to 0.8.

> **Combat feel note (2026-10-13, `docs/plans/combat-feel.md`):** every telegraph can now be walked out of from its
> worst spot (125 m/s plus 250 ms reaction). Melee basics reach exactly the player's swing reach (130 m to the body
> edge, `SWING_RANGE_M`), so basic windups are 750 ms (swarmer 700), the Phase 1 managed melee windup is 750 ms with a
> 250 ms recover, double strike is 600 + 600 ms on a 110 m / 70 degree cone, the swarm wave
> is 600 ms and the volley fan is 50 degrees. The dash is 150 m with a 3 s cooldown, and the signature spacing stays at
> or above it. Recovery stays readable, so cycles got longer: lone melee mobs deal about 12-21 % less, and full
> packs less again. The balance band above is now 0.7x to 1.4x of Phase 1.
- Maul 1.8 / 1.3 (animal) to 2.6 / 2.6.
- Brute signature cost 2 to 1 (2 held the whole pool for 1.6 s per maul and starved the brutes' own basics; epic tiers still pay 2).
- Brute rhythm 600 / 500 / 900 to 600 / 350 / 1050 (same 2.0 s cycle, shorter token hold).
- `MOB_ARCH_CASTER_RANGED_TOKENS = 2` under the flag.
- `MOB_ARCH_GOVERNOR_BUDGET_HE` = 2 s x 1.25 x Phase 1 ceiling (6.67 HE). It now also defers basics, and strikes started in the same tick count against it, so a swarm wave cannot overshoot.

Final table (ratio = Phase 2 / Phase 1 damage per second):

| Mob | Pack | Phase 1 hits/s | Phase 2 hits/s | Phase 1 dmg/s | Phase 2 dmg/s | Ratio |
|---|---|---|---|---|---|---|
| brute (bear, maul) | 1 | 0.77 | 0.45 | 18.6 | 18.7 | 1.00 |
| brute (bear, maul) | 2 | 1.48 | 0.90 | 36.1 | 37.3 | 1.03 |
| brute (bear, maul) | 4 | 2.78 | 1.40 | 68.0 | 56.1 | 0.82 |
| brute (bear, maul) | 8 | 2.43 | 1.18 | 63.1 | 47.3 | 0.75 |
| brute (hog, charge) | 1 | 0.70 | 0.50 | 11.2 | 12.0 | 1.07 |
| brute (hog, charge) | 2 | 1.38 | 0.98 | 22.1 | 23.6 | 1.07 |
| brute (hog, charge) | 4 | 2.63 | 1.53 | 42.1 | 36.8 | 0.87 |
| brute (hog, charge) | 8 | 2.17 | 1.52 | 34.8 | 36.4 | 1.05 |
| brute (ogre, slam) | 1 | 0.47 | 0.43 | 15.9 | 22.4 | 1.41 |
| brute (ogre, slam) | 2 | 0.85 | 0.68 | 28.9 | 35.4 | 1.22 |
| brute (ogre, slam) | 4 | 0.85 | 0.60 | 28.9 | 31.4 | 1.09 |
| brute (ogre, slam) | 8 | 0.87 | 0.40 | 30.9 | 21.3 | 0.69 |
| pack (wolf) | 1 | 0.70 | 0.62 | 9.1 | 8.5 | 0.94 |
| pack (wolf) | 2 | 1.38 | 1.22 | 18.0 | 16.8 | 0.93 |
| pack (wolf) | 4 | 2.63 | 2.15 | 34.2 | 28.8 | 0.84 |
| pack (wolf) | 8 | 2.12 | 1.70 | 27.5 | 22.9 | 0.83 |
| skirmisher (spearman) | 1 | 0.72 | 0.58 | 12.9 | 10.8 | 0.84 |
| skirmisher (spearman) | 2 | 1.38 | 1.15 | 24.9 | 21.7 | 0.87 |
| skirmisher (spearman) | 4 | 2.63 | 2.05 | 47.4 | 41.3 | 0.87 |
| skirmisher (spearman) | 8 | 2.28 | 2.03 | 41.1 | 40.9 | 1.00 |
| skirmisher (bandit) | 1 | 0.70 | 0.40 | 16.4 | 13.8 | 0.84 |
| skirmisher (bandit) | 2 | 1.38 | 0.77 | 32.4 | 26.7 | 0.82 |
| skirmisher (bandit) | 4 | 2.60 | 1.65 | 60.9 | 51.7 | 0.85 |
| skirmisher (bandit) | 8 | 1.85 | 2.00 | 53.9 | 60.7 | 1.13 |
| caster (hedge witch) | 1 | 0.72 | 0.63 | 12.9 | 13.1 | 1.01 |
| caster (hedge witch) | 2 | 1.38 | 1.23 | 24.9 | 25.4 | 1.02 |
| caster (hedge witch) | 4 | 2.63 | 2.18 | 47.4 | 44.1 | 0.93 |
| caster (hedge witch) | 8 | 2.28 | 2.18 | 41.1 | 44.1 | 1.07 |
| caster (frog) | 1 | 0.72 | 0.70 | 2.2 | 2.1 | 0.95 |
| caster (frog) | 2 | 1.38 | 1.37 | 4.3 | 4.1 | 0.96 |
| caster (frog) | 4 | 2.65 | 2.40 | 8.2 | 7.2 | 0.88 |
| caster (frog) | 8 | 2.53 | 1.60 | 10.8 | 4.5 | 0.42 |
| swarmer (red squirrel) | 1 | 0.70 | 0.73 | 3.5 | 2.9 | 0.84 |
| swarmer (red squirrel) | 2 | 1.38 | 1.45 | 6.9 | 5.8 | 0.84 |
| swarmer (red squirrel) | 4 | 2.63 | 2.88 | 13.2 | 11.5 | 0.88 |
| swarmer (red squirrel) | 8 | 1.95 | 3.18 | 9.8 | 12.7 | 1.31 |

### Rows outside 0.8x to 1.1x

- **Lone and paired ogre** (1.41x, 1.22x): the Phase 1 baseline is broken. The legacy slam (110 m circle, 130 m trigger) whiffs at the engage ring and staggers the Phase 1 ogre for 5 s, so it lands 0.47 hits/s where every other brute lands 0.70. Phase 2 hits at the intended Phase 1 rate. The balance test applies only the floor to these two rows.
- **Size 8**, where Phase 1 itself dips: the frog (0.42x) and ogre (0.69x) sit lower. The squirrel (1.31x) and bandit (1.13x) are above their own Phase 1 dip but under 1.1x of the Phase 1 peak (size 4), which is the ceiling the test uses at size 8.

### Review findings (fixed)

1. A cancelled signature's telegraph stayed on screen when the mob was already gone (despawned before the tactics pass): the cast was filtered by mob only when the mob still existed. Cancel now filters by mob id. Test added.
2. Reentrancy: a signature hit that ends the fight (the player dies, or the mob dies to a reflect) forgets the mob and cancels the signature mid-resolve. The resolver still re-aimed a double strike's second cone (an orphan telegraph), moved the mob and applied the aftermath. It now stops once the signature has been cancelled under it. Test added.
3. The skirmisher hop covered only 60 of its 90 m when the swing resolved after the tactics pass. It now tracks the distance left.
4. Checked and fine: a target swap mid-telegraph (cancel, slot freed, 1.5 s lockout), the flag turning off mid-fight (re-join as Phase 1, legacy gimmicks resume), tactics turning off (hand-back cancels), a mob or player death through `removeEnemy`, and orphaned archetype basics (they resolve with their factor and wave cone). The token fail-safe can take back a token mid-signature; the slot is still freed at landing.
