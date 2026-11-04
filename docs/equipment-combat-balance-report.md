# Equipment Combat Balance Report

Deterministic 20 Hz fights run through the production `CombatEngine`. The left fighter initiates each duel, so mirror winners reflect the one-action initiative advantage.

## Progression matrix

| Profile | HP | Offense | Guard | Weapon | Armor | Mirror winner hits | First hit |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Character 0 / Warrior 0 / gear 0 | 100 | 1.5 | 1.35 | 3 | 2.7 | 12 | 9 |
| Character 15 / Warrior 9 / gear 0 | 100 | 9 | 8.85 | 3 | 2.7 | 12 | 9 |
| Character 15 / Warrior 9 / gear 15 | 100 | 16.5 | 16.35 | 18 | 17.7 | 12 | 9 |
| Character 20 / Warrior 12 / gear 20 | 100 | 21.5 | 21.35 | 23 | 22.7 | 12 | 9 |
| Character 25 / Warrior 15 / gear 20 | 100 | 24 | 23.85 | 23 | 22.7 | 12 | 9 |
| Character 25 / Warrior 15 / gear 25 off-affinity | 100 | 25 | 25 | 25 | 25 | 12 | 9 |
| Character 25 / Warrior 15 / gear 25 preferred | 100 | 26.5 | 26.35 | 28 | 27.7 | 12 | 9 |

## Focused comparisons

| Scenario | Winner | Ticks | Left hits/damage | Right hits/damage |
| --- | --- | ---: | ---: | ---: |
| Character 0 / Warrior 0 / gear 0 versus maximum preferred | right | 129 | 4/12 | 4/100 |
| Character 15 / Warrior 9 / gear 0 versus maximum preferred | right | 129 | 4/12 | 4/100 |
| Character 15 / Warrior 9 / gear 15 versus maximum preferred | right | 193 | 6/30 | 6/100 |
| Character 20 / Warrior 12 / gear 20 versus maximum preferred | right | 257 | 8/48 | 8/100 |
| Character 25 / Warrior 15 / gear 20 versus maximum preferred | right | 321 | 10/80 | 10/100 |
| Character 25 / Warrior 15 / gear 25 off-affinity versus maximum preferred | right | 321 | 10/80 | 10/100 |
| Level 0 off-affinity versus level 0 preferred | right | 321 | 10/80 | 10/100 |
| Level 1 preferred versus level 0 preferred | left | 353 | 12/100 | 11/99 |
| Level 0 versus level 25 at equal maximum character and Warrior progression | right | 161 | 5/20 | 5/100 |
| Maximum off-affinity versus maximum preferred | right | 321 | 10/80 | 10/100 |
| Maximum ranged-secondary versus maximum shield | right | 385 | 12/84 | 12/100 |

## Inventory and saved-kit controls

| Inventory items | Valid kits | Winner | Ticks | Left hit ticks |
| ---: | ---: | --- | ---: | --- |
| 7 | 1 | left | 289 | 1, 33, 65, 97, 129, 161, 193, 225, 257, 289 |
| 42 | 1 | left | 289 | 1, 33, 65, 97, 129, 161, 193, 225, 257, 289 |
| 7 | 6 | left | 289 | 1, 33, 65, 97, 129, 161, 193, 225, 257, 289 |
| 42 | 6 | left | 289 | 1, 33, 65, 97, 129, 161, 193, 225, 257, 289 |

## Tick-boundary kit switching

| Scenario | Requested after tick(s) | Applied tick(s) | Attacker hit ticks | Damage | Cadence preserved |
| --- | --- | --- | --- | --- | --- |
| Switch immediately before an attack tick | 0 | 1 | 1, 33, 65 | 9, 9, 9 | yes |
| Switch immediately after an attack tick | 1 | 2 | 1, 33, 65 | 4, 9, 9 | yes |
| Switch between scheduled attacks | 10 | 11 | 1, 33, 65 | 4, 9, 9 | yes |
| Switch after every resolved action | 1, 33, 65, 97, 129 | 2, 34, 66, 98, 130 | 1, 33, 65, 97, 129, 161 | 9, 8, 9, 8, 9, 8 | yes |

## Reconnect authority handoff

| Scenario | Reconnect after tick | Health before/after | Target retained | Restored equipment | Attacker hit ticks | Cadence preserved |
| --- | ---: | --- | --- | --- | --- | --- |
| Replacement connection during active combat | 40 | 91/82 -> 91/82 | yes | kit 1, melee, active revision 1 | 1, 33, 65, 97 | yes |

## Balance gates

| Gate | Result | Evidence |
| --- | --- | --- |
| ordinary_maximum_health | PASS | Every simulated ordinary configuration resolves exactly 100 maximum HP. |
| maximum_mirror_ttk | PASS | 12 successful basics; 9 first-hit damage. |
| required_progression_gaps | PASS | 6/6 lower-progression initiators lost to maximum preferred. |
| level_one_is_measurably_stronger | PASS | Offense 1.5 -> 2; Guard 1.35 -> 1.85. |
| level_zero_overwhelmingly_disadvantaged | PASS | Maximum dealt 100 damage while level 0 dealt 20 before defeat. |
| preferred_affinity_advantage | PASS | Preferred Offense/Guard 26.5/26.35 versus 25/25. |
| inventory_size_independence | PASS | 7-item and 42-item inventories produced identical combat traces. |
| saved_kit_count_independence | PASS | One valid kit, six reused kits, and six unique kits produced identical traces. |
| all_equipment_levels_monotonic | PASS | Levels 0 through 25 are strictly increasing in PvP power and nondecreasing in PvE stats. |
| pve_proficiency_neutral_in_pvp | PASS | A requested 2x PvE proficiency resolves to exactly 1x in PvP without changing power. |
| switch_tick_order | PASS | Before-switch applied tick 1; after-switch applied tick 2; first damages 9/4. |
| switch_preserves_attack_schedule | PASS | All traces remained on ticks 1 + n*32; repeated switching resolved six actions. |
| reconnect_preserves_live_combat_state | PASS | Authority rotated after tick 40; health 91/82 was preserved; attacks remained on ticks 1, 33, 65, 97 with active revision 1. |
