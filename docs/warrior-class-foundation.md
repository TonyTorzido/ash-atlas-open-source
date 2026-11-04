# Warrior PvE class

Warrior is a balanced melee class. It has no combat resource and no class-owned
Taunt. Its authoritative PvE actions are basic attacks and two equipped
cooldown-based class skills. Shared class-resource and generic Taunt contracts
remain for other classes, but Warrior snapshots and controls do not expose them.

## Class skills

Warrior has one unified class-skill category and two slots. Slot one unlocks at
Level 1 and slot two at Level 4.

- Level 1, Empowered Hit: pay up to 11 HP without dropping below 1; the next
  basic attack deals 123% damage; 15-second cooldown.
- Level 3, Anger Explosion: pay up to 8 HP without dropping below 1; deal 30%
  basic damage to every eligible hostile PvE enemy within 140 meters;
  20-second cooldown.
- Level 8, Concussive Blow: one non-stacking Concussed charge makes the mob's
  next damaging attack against a player resolve for zero without stopping
  movement or pursuit; 15-second cooldown.
- Level 11, Battle Cry: the caster and eligible nearby party members deal 9%
  more damage for 9 seconds; refreshes/replaces and never stacks;
  30-second cooldown.

Battle Hardened is guaranteed at Level 1 and is the authority for the 1 HP
minimum on Warrior skill costs. Cooldowns are stored once as absolute server
expiry timestamps and remaining time is derived from expiry minus server time.

## Selectable passives

Exactly one choice is equipped in each unlocked tier:

- Level 2: Heavy Handed (+1 flat basic-attack damage) or Bloodthirst (heal 6 on
  an eligible PvE defeat, capped at maximum HP).
- Level 7: Relentless (+31% on every third same-target basic attack) or Crowd
  Fighter (+1 flat Attack and Defense while fighting at least two owned PvE enemies).
- Level 12: Desperate Fury (+2 flat damage against enemies below 37% maximum
  HP) or Last Stand (+2 flat Defense while below 37% HP).

## Equipment mastery and progression

Axe Mastery grants +1/+2/+4 flat Attack at Levels 5/9/13 while the active
weapon belongs to the Axe family. Breastplate Mastery grants +2/+3/+4 flat
Defense at Levels 6/10/14 while wearing the Breastplate family. These bonuses
never change the item's stored or displayed level.

The exact cumulative XP thresholds for Levels 0 through 15 are:

`0, 1193, 2600, 4257, 6212, 8515, 11231, 14432, 18205, 22652, 27895, 34075, 41360, 49946, 60068, 72000`

Empty class-tree levels are intentional. Character level, equipment upgrades,
and other progression remain independent.

## Persistence cutover

Migration `0732_warrior_pve_rework.sql` preserves Warrior XP, character
progression, and equipment. It clears legacy Rage, reservations, queued/reset
actions, Warrior effects, cooldowns, and counters, then assigns deterministic
valid class skills and one default passive per unlocked tier. Runtime
reconciliation applies the same rules so stale clients or retained rows cannot
execute Punishing Strike, Guarded Strike, Cleave, Fortify, or old passives.
