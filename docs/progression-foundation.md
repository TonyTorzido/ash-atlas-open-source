# Progression Foundation

This vertical slice adds a server-authoritative level, XP, equipment, and reward-settlement
foundation without changing the central 20 Hz combat scheduler or the stable Pixi map overlay.

## Current Era

- Start: level 0, 0 XP.
- Cap: level 25, 500,000 XP.
- Curve version: 1.
- Balance version: 1.
- Ordinary target: 10,000 XP per active hour, or about 50 active hours to the cap.
- XP beyond the cap is not banked. The operation ledger records requested, granted, and discarded
  amounts so cap behavior remains replay-safe and auditable.

The exact cumulative thresholds live in `packages/shared/src/progression.ts`; no runtime formula
generates the curve.

## Durable XP

`player_progression_profiles` owns each authenticated player's current XP, level, curve version,
and optimistic persistence version. `xp_operations` has a unique deterministic operation key and
stores the complete replay result. `xp_events` records the grant and every deterministic level-up.
The profile update, operation, and events commit in one transaction. A duplicate key must describe
the same operation and returns its original result.

Combat defeat candidates leave the simulation through a bounded queue. Durable settlements own
one mob life, its participant contributions, group calculation, per-player XP operation keys, and
completed result. Temporary failures stay retryable; completed grants cannot duplicate after a
crash or retry.

Group XP uses one encounter pool, a 10% bonus per additional eligible contributor capped at 30%,
positive authoritative damage only, level-difference modifiers, and deterministic integer
remainder assignment. Training Dummies grant zero XP.

## PvE And PvP

Level 0 PvE stats are 100 maximum health, 10 attack, and 0 defense. Every five levels adds 20
maximum health, 1 attack, and 1 defense. Starter Sword adds 2 attack; Padded Tunic adds 2 defense.
PvE damage is:

```text
max(1, round(attack * 100 / (100 + max(0, defense))))
```

PvP ignores level and equipment as a raw advantage. The neutral 100-health/10-attack/0-defense
template deals the same percentage of a target's live PvE maximum health, preserving equivalent
time-to-kill across levels while still respecting the target's current missing-health percentage.

## Provisional Balance

Legacy archetype defaults (live mob stats are resolved by `resolveMobCombatProfile`):

| Mob | Level | HP | Attack | Defense | Interval | Base XP |
|---|---:|---:|---:|---:|---:|---:|
| Wolf | 5 | 90 | 4 | 2 | 1600 ms | 75 |
| Goblin | 10 | 180 | 5 | 5 | 1600 ms | 140 |
| Bandit | 15 | 300 | 7 | 9 | 1600 ms | 225 |
| Orc Brute | 20 | 450 | 9 | 14 | 1600 ms | 350 |
| Ogre | 25 | 650 | 12 | 20 | 1600 ms | 550 |

Live normal Wolves use `ceil((10 + level) / 2)` attack damage before player mitigation, ranging
from 5 at level 0 to 18 at level 25. Their health remains `3 * (10 + level)`, with zero defense;
Unprovoked world
Wolves require three continuous seconds within 150m before engaging, using the existing visible
acquisition countdown. Leaving the radius cancels that warning. Landing a hit on a Wolf first still
provokes its exact pack immediately. This tuning does not change rewards or population identity.

All mobs use the character basic-attack interval. In active PvE, player and enemy opportunities
alternate at the 800ms half-step; multiple enemies rotate through one bounded queue rather than
running simultaneous per-mob attack timers.

Successful authoritative harvest completion grants wood 20 XP, stone 24 XP, food 16 XP, and ore
32 XP. Water grants 0 XP. Canceled, failed, expired, unavailable, dropped-item, and inventory-drop
operations grant no character XP.

These XP pools, movement speeds, and harvest rewards are version-one provisional values intended
to be tuned from recordings.

## F3 Progression Recording

The existing performance panel includes a Progression Recording section with Start, Stop, Reset,
Loop Start, and Loop End controls. F3 starts/stops the performance and progression captures
together. Recordings remain local and export deterministic `ash-atlas-progression-*.json` and
`.csv` files.

The recorder tracks wall, active, and idle time using a 45-second idle threshold; source XP;
combat TTK and damage events; harvest duration; distinct-flag loops; equipment context; and target
rate comparison. Raw events are bounded at 5,000 while aggregate summaries continue. Exports use
allowlisted gameplay fields and do not contain cookies, tokens, email addresses, Google data, or
device/user-agent data.
