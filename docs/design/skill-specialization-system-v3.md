# Skill and Specialization System V3

## Authority and progression

Skill System V3 is the live character-build authority. Character levels award one General Skill
Point per level through level 25, for a launch entitlement of 25. The server persists earned,
spent, and available totals and reconciles earned points from authoritative character progression;
it does not derive or import them from retained class training-point columns. If actual persisted
V3 spending exceeds 25 during the schedule transition, reconciliation preserves that spending by
setting total earned to the greater of level entitlement or actual spending and available to zero.
As spending is later reduced, the balance may converge to the 25-point entitlement.

General skills and specialization ranks share this point budget. Every general skill rank costs 1 SP
(default 1/1/1; the former 1/1/2 rank-3 cost is gone, and migration 1100 refunded the extra point on already-bought
rank 3s). Hidden World Knowledge ranks also cost 1 SP each. The player-selectable roster is eight classes: Warrior and Ranger (starters, no gateway needed) plus
Knight, Militia (`sentinel`), Monk, Ninja, Druid, and Mercenary (Rank 3 in their declared gateway
skill). None has a blanket character-level gate; all other classes stay unavailable. Before purchasing each successive class rank,
the build must already have spent 3/7/11/16/20 Character SP for Ranks 1/2/3/4/5. The first
successful Rank-1 class purchase atomically commits the character to that
class and activates it; the server infers this boundary and never trusts a client confirmation. Only that class may
receive later ranks, and it may reach Rank 5. A canonical confirmation explains
the lock before the purchase, and the free test-server full respec is the way to change classes.
The committed launch class remains active until full respec; there is no separate activation action
or zero-active player state.

Existing Rank 0–15 and historical Rank 0–25 class records are retained as immutable migration
evidence. Their mapped V3 specialization ranks are grandfathered and cost no General Skill
Points. Only later V3 purchases consume points. Retained class XP, training points, loadouts, and
runtime records are legacy data and do not advance or execute in V3 combat.

Every mutation is server-authoritative and operation-keyed. Clients submit a request ID and the
expected snapshot revision; successful and replayed results return the full resulting snapshot.
Individual production refunds remain disabled. An authoritative server capability exposes a free
full-build respec only on development/test and the public test-server deployment identity. The
operation resets all purchased general ranks, every specialization rank including retained non-launch ranks,
commitment, activation, general loadout, build cooldowns, effects, counters, and queues. It preserves level/XP/post-cap,
inventory/equipment/currency, world and city state, professions, knowledge/discoveries, achievements,
retained backend-class evidence, and completed Mastery Trials. True production does not expose it.

## Build model

The shared catalog is separate from the retained class and technique registries. It owns:

- general skills and their ranks, prerequisites, coordinates, effects, and implementation status;
- the 16 specialization tracks and their five ranks, costs, and gateways;
- profession skill representations that explicitly use Profession XP rather than General Skill
  Points;
- hidden world-knowledge nodes with server-owned reveal state;
- explicit legacy execution classification.

The four confirmed gateways are Cleave, Archery, Martial Arts, and Tactics. Visible edge prerequisites
are Shield Charge ← Cleave, Pursuit ← Shield Charge, Pierce Armor ← Cleave, Blight Strike ← Pierce
Armor, Second Wind ← Cleave, Deathburst ← Second Wind, Ricochet ← Archery, Quarry Sense ← Ricochet,
Huntsman's Edge ← Quarry Sense, Concentration ← Huntsman's Edge, Perfect Strike ← Martial Arts Rank 3,
Taunt ← Tactics, War Standard ← Taunt, Heroism ← War Standard, Cleanse ← Tactics, Scavenge ← Cleanse,
Calm Mind ← Cleanse, Companion Bond ← Tactics, and Delver's Lore ← Companion Bond. Knight uses Cleave
Rank 3 and Druid uses Tactics Rank 3; both use the spent-SP gates and one-class commitment rules.
Definitions with a purchase equipment requirement validate the serialized authoritative equipped-item
snapshot when a rank is purchased. Use-only equipment requirements do not block training; combat
independently enforces them when the learned skill can proc or be activated. Ricochet therefore requires
Archery Rank 1 to purchase, while its proc remains limited to Sling, Longbow, Crossbow, Blowdart, or Shuriken use.

### Launch catalog visibility

General-skill definitions also carry launch catalog visibility independently from implementation
status. Visibility defaults to `visible`. A skill marked `hidden_until_dependency` or
`hidden_for_launch` retains its stable ID, ranks, prerequisites, effects, persistence, and server
behavior while being omitted from the player tree. No general skill is currently hidden: Provoke is live and obtainable
(its monster-flee trigger now exists), and the hidden states remain available for future skills. Perfect Strike,
Pierce Armor, Blight Strike, Deathburst, Quarry Sense, Huntsman's Edge, Concentration, Heroism,
Scavenge, Companion Bond, Delver's Lore and Provoke are player-visible and server-authoritative.
Delver's Lore dungeon speed and the re-entry torch (only the player who paid the entry torch, once per run) are live. Mercenary PvP kills pay bonus XP: 1/2/3 by rank x min(level, 30) x Momentum stacks, keyed to the death.
When a hidden node is omitted, the visible members of its existing branch reconnect in order; a
branch with no visible members is omitted.
All seven World Knowledge definitions and their snapshot, persistence, and service contracts remain
backend-retained, but the player Skills destination hides World Knowledge until a real
authoritative discovery loop exists.

The current player roster is exactly Warrior, Ranger, Ninja, Knight, and Druid. Paladin and
Cleric were removed entirely (migration 0916 refunded paid unlocks and returned their SP). The
other specialization definitions remain durable historical records but cannot be trained or
activated. Existing committed characters in a retired class may choose an enabled
replacement: the retired class rank stays recorded, its V3 SP are refunded in the operation
receipt, and General Skills are preserved. An already-trained enabled class can be selected
without purchasing another rank. Replacing one enabled class with another remains locked.

The gateway groups retained in the catalog are Cleave (Warrior and Knight), Archery (Ranger,
Militia, Mercenary), Martial Arts (Ninja and Monk), and Tactics (Druid). Warrior and Ranger do not
require their gateway. Other historical definitions remain visible to
developers as retained content.

The current V3 combat loadout has Basic Attack and two General Active slots. Historical class
techniques and passive slots remain in the registry for saved-data compatibility but
cannot be equipped or executed. The Ranger Focus signature and the Warrior, Ranger and Ninja class techniques were removed. Classes have no Ultimate or Class Technique at all; the
server keeps sending the old snapshot fields as `null`/`false` for installed clients. Druid Replenish is the explicit Rank 1 action exception; it uses
five Giving Berries and a selected injured ally in melee range without an equip slot or cooldown.
It makes the caster aggressive and cannot lower the caster below 1 HP. The server transfers only
the own HP needed to fill the ally, rounded down after applying the transfer ratio. Unwithered
ratios are 0.65:1 at Ranks 1–2, 0.95:1 at Ranks 3–4, and 1.25:1 at Rank 5. Withered transfers at
0.25:1 at Rank 1, and Ash keeps 0.25:1 at every rank until later Withered ratios are designed. General active loadouts remain separate
from retained class loadout columns.

### General skill numbers

The registry text in `skillSystemV3.ts` is authoritative; the notable live values are:

- Taunt: 36 s duration, cooldown 4.5/3.5/2.7 min at ranks 1/2/3.
- Calm Mind: aggression -12/27/42%; rank 3 ends aggression on a kill when no other enemies remain.
- Archery: +1/+3/+4 Longbow/Crossbow Attack and +22 m / +45 m range at ranks 2/3.
- Flat ladders by rank: Martial Arts Shuriken/Blowdart Attack +1/+2/+4; Taunt Defense +2/+3/+4; War Standard Attack +1/+2/+3; Provoke Defense debuff -2/-3 at ranks 2/3; Heroism Boss Defense +1/+3/+3 and Hero Attack +1/+1/+3; Leatherworking +2 Defense (rank 1) and +2 Attack (rank 2).
- Exposed: 1.4x damage until death (Quarry Sense rank 3: 1.75x). Boundary Writ gives +2 Attack and +2 Defense.
- Martial Arts: Tunic/Cloth no-Shield Dodge 0/14/28 points at ranks 1/2/3.
- Scavenge: rolls only on monster item drops. Pool is Wood or Balsam Resin, then adds Leather and Iron Ore, then Sulfur and Stone.
- Second Wind: no cooldown; kills by your pet or minion count.
- Concentration: attacks always stay on the focused target in this game.
- Tactics: also gains per chopped tree.
- Provoke: live and obtainable.
- Deathburst: any killing blow, 2.5/5.5/9% of the target's max HP.

### Specialization rank contract

Each roster class except the Warrior and Ranger starters requires Rank 3 in its mapped gateway, and every roster class uses the 3/7/11/16/20 currently-spent SP
gates for its next rank. Retained non-launch classes keep their existing level policy. The first
class point purchases Rank 1, commits the build, and activates the class. Warrior, Knight, Legionnaire,
Ranger, Assassin, Ninja, Monk, Rogue, Druid, Merchant, Artificer, and Voyager cost
`1/1/1/1/1` SP. Mercenary and Militia (`sentinel`) preserve `1/1/2/2/3` SP.

| Class | Rank 1 | Rank 2 | Rank 3 | Rank 4 | Rank 5 |
| --- | --- | --- | --- | --- | --- |
| Warrior | +9 Max HP; +1 Axe Attack | Total +18 Max HP; +1 melee Attack below 46% HP | Total +27 Max HP; +2 Axe Attack | Total +36 Max HP; +2 Axe Attack below 33% HP | Total +45 Max HP; +4 Axe Attack; +3 melee Attack below 22% HP |
| Knight | +1 Sword Attack | +1 Breastplate or Wyrm Scalemail Defense; +1 Shield Defense versus ranged | +2 Sword Attack; +2 ranged Shield Defense | +2 Breastplate or Wyrm Scalemail Defense | +4 Sword Attack; +3 heavy Defense; +3 ranged Shield Defense |
| Legionnaire | +1 Spear Attack | +1 Shield Defense; formation +0.4 per qualifying shield-bearer (total up to +2), party allies +0.2 each (total up to +1.5) | +2 Spear Attack; +2 Shield Defense | formation +0.65 each, total up to +3 | +4 Spear Attack; formation +0.9 each, total up to +5 |
| Ranger | +1 Longbow/Sword Attack | +4 Speed; +20m Longbow range | +2 Longbow/Sword Attack; +1 Leather Defense versus melee without Shield | +40m Longbow range | +4 Longbow/Sword; +9 Speed; +3 qualifying Leather Defense |
| Mercenary | +1 Spear Attack; PvP sustained-hit Spear Attack bonus up to +2 | PvP kill XP coefficient 3 | +1 Crossbow; +1 Leather Defense without Shield; PvP sustained-hit Spear Attack bonus up to +3 | +2 Spear Attack; PvP sustained-hit Spear Attack bonus up to +4 | +3 Crossbow/Spear Attack; +1 additional Leather Defense versus melee; PvP sustained-hit Spear Attack bonus up to +6 |
| Militia (`sentinel`) | +1 Crossbow Attack; close-range use | +2 Breastplate Defense versus ranged; Breastplate movement penalty -2 points | +2 Crossbow; -9 Dodge points | +3 Breastplate Defense versus ranged; penalty -4 points | +4 Crossbow, +4 Breastplate ranged Defense; penalty -6 points; -22 Dodge points |
| Ninja | +1 Shuriken; close-range use | +9 Speed; +4 Dodge points | +2 Shuriken | +18 Speed; +7 Dodge points | +4 Shuriken; +27 Speed; +11 Dodge |
| Assassin | +1 Dagger; Dagger Dodge permission | +1 Blowdart; aggression -4% | +2 Dagger; 2.5x nonaggressive-player surprise hit | +2 Blowdart; aggression -9%; +1 Tunic Defense | +4 Dagger/Blowdart; 3.5x surprise; aggression -14% |
| Monk | Sling Dodge permission; +1 Staff/Sling; nonaggressive Giving Berry healing +25% | +2 Tunic Defense; hostile base Speed -8 within 180m; Staff/Sling hits 4% stun for 5 s | +2 Staff/Sling; Giving Berry +55% | +3 Tunic Defense; hostile base Speed -16 within 180m; Staff/Sling hits 7% stun for 5 s | +4 Staff/Sling, +4 Tunic Defense; hostile base Speed -26 within 180m; Giving Berry 1.8x |
| Rogue | +7 Speed; +1 Dagger/Knuckles; Leather/no-Shield Dodge; 2.5% chance for 450 extra Gold on a humanoid kill | +14 Speed; steal 9% of a defeated player's remaining Gold, up to 900 | +21 Speed; +2 Dagger/Knuckles; humanoid-kill proc pays 900 | +28 Speed; theft cap 2,200 | +35 Speed; +4 Dagger/Knuckles; humanoid-kill proc pays 1,350; theft cap 4,500 |
| Druid | Staff without Kestrel; Replenish 0.65:1 (Withered 0.25:1); Healing Aura range +26 m | Tactics cap +4.5; Healing Aura heals Withered targets at 40%; pets rest at most 7 hours | 13% Dodge without Heavy/Shield; Replenish 0.95:1; pet Tactics sharing pending | Tactics cap +5.5; Healing Aura heals Withered targets at 80% | Tactics cap +7; 27% Dodge; Replenish 1.25:1; pet Tactics sharing pending |
| Merchant | Retained Gold-to-Tactics/Bazaar Stall definitions | Tactics cap +4.5 | Retained city/trade concepts | Tactics cap +5.5 | Tactics cap +7 |
| Artificer | Retained crafting-reward/construct definitions | Tactics cap +4.5 | Retained bulk-crafting/construct sharing definitions | Tactics cap +5.5 | Tactics cap +7 |
| Voyager | +9 land/water Speed | Stored PvE Monster Attack cap +4.5 | +18 Speed | Stored PvE Monster Attack cap +5.5 | Stored PvE Monster Attack cap +7; +27 Speed |

The player rank ledger marks individual effects Supported or Dormant. Dormant effects remain in the
registry without pretending they execute: Monk stun; Druid pet sharing; Merchant market/city discounts and Bazaar
Stall; Artificer crafting-time/output and constructs; and Voyager building-isolation, waypoint, and
recenter effects. These require missing source, economy, crafting-job, status, pet, or world-spatial
authority and must be wired only through those canonical systems later.

Rogue Gold effects are live. The humanoid-kill proc (`HUMANOID_MOB_ARCHETYPES` in `mobContracts.ts`) rolls 2.5% on a
reward-eligible kill that pays Gold and credits the extra Gold in the same transaction as the kill Gold under its own
ledger key. PvP theft runs inside the existing PvP death Gold transfer (`pvpDeathGold.ts`): it is skipped for beginner
protection and repeat kills, is computed on the Gold left after the normal 10% loss, and is recorded once per death
(`rogue_theft`, migration 1095).

## Combat boundary

V3 builds are projected into a dedicated runtime view containing the active specialization and
rank, learned general skills, two equipped general actives,
cooldowns, modifier inputs, temporary
effects, and engagement state. Stored Ultimate and Mastery data is ignored. A retained ability identifier is not executable
merely because a legacy registry can resolve it. V3 activation clears or fences old queued actions,
temporary class effects, counters, traps, and zones, and namespaces new cooldowns.

Dodge remains eligible only for targeted basic/weapon attacks. Resolution gathers the defender's
eligible Dodge, subtracts flat anti-Dodge points, clamps, and then halves the remainder only when the
defender's active class is Ninja and the attacker's currently used weapon has a canonically parsed Ice
Metal enhancement. Ice armor does not qualify, non-Ninja Dodge is unchanged, and the existing Ice proc
continues independently. The resolver mutates no stats and performs one authoritative roll.

Class weapon Attack and context/body/Shield Defense enter one context-aware server policy. PvE and
PvP consume that policy without duplicating static modifiers, and fractional Legionnaire formation
Defense is accumulated before the existing final damage normalization. PvE continues to use the authoritative stat-based damage path. PvP uses the v3 matrix
only when both current equipment profiles are supported. Unsupported current equipment uses the
explicit `compatibility_v1` path; it is never silently coerced into a v3 profile.

## PvP raw matrix

The rows in `PVP_RAW_MATRIX_V3` are this game's own tuned weapon-by-armour table. Its metadata is:

- `evidenceStatus`: `designed`
- `sourceVersion`: `ash_pvp_raw_matrix_v2`
- `fullMatrixPresent`: `true`
- `roundingBasis`: `ash_provisional`
- `derivedRows`: none (the wand has its own row)

## Professions and world knowledge

Professions keep independent XP and unlock authority. Blacksmithing owns weapon, armor, shield,
repair, and durability work, while Metallurgy owns metal refining and conversion. Tradecraft owns
appraisal, market access, order information, and special inventory without promising percentage
discounts. Merchant's class identity remains separate from Tradecraft and does not duplicate its
profession progression. Cartography owns map tools and recorded-destination concepts. Artificer
retains crafting-time/output, Robot, gadget, and Tactics concepts, but only Tactics caps execute
until every supported station snapshots one authoritative class modifier inside its job transaction.
Voyager retains movement, travel, exploration, and Tactics concepts. Alchemy exposes contracts and a future-content entry/recipe seam
without inventing consumables. Its typed recipe registry is intentionally empty, and the read-only
`ProfessionSkillV3Service` exposes the catalog without claiming Profession XP authority.

Tidecraft, Rare Beast Mastery, Hollin (Wildkin) Lore, Deepstone Lore, Grove Lore, Edict Stride, and Field Engineering use
hidden/revealed server state. Rare Beast Mastery is `future_content`; the others are `implemented` with the
following effects still pending: Deepstone cave visibility outside the circle, Grove tree companions, and Field
Engineering Reflection and Gloom monoliths. Deepstone Lore gives +2 Attack (rank 2) and +2 Defense (rank 3) within
150 m of cave entrances. Edict Stride needs character level 40. Metallurgy (a profession, not a skill) gives a 16/34/52%
chance of a doubled smelted bar at ranks 2/5/8. Pet, summon, structure, humanoid-tag, custom-map-marker, and unresolved economy rewards
remain explicitly pending rather than being simulated by placeholder mechanics.

## User interface

The Skills & Professions destination uses one canonical game shell with housed Skills, Professions,
and Achievements tabs, canonical actions, and the Ash theme. Combining the navigation surface does
not combine the economies: character levels award the shared Skill Point budget, while professions
retain independent XP and rank authority. The Skills tab lists every gateway discipline (currently
Cleave, Archery, Martial Arts, and Tactics) in a grid; opening one shows a single discipline page
with the gateway row and inline Level Up, the discipline's skill paths, and a Classes section that
is always visible with unlock progress and the one-active-class rule. Class detail shows the real
five ranks, 3/7/11/16/20 total-spent Character SP gates, supported effects, and the
existing commitment/respec state. Gateway, skill, and class details open in a bottom sheet on phone
or a docked side panel on desktop without leaving the page; the header's Active class chip opens an
overview of all classes. `docs/build-bible/APP_SHELLS_MENUS_AND_NAVIGATION.md` (Progression
browsers) is the navigation standard.
Combat progression has no pan, zoom, minimap, giant combined canvas, or hidden drag gesture.
Professions retain housed category filters through the canonical compact subtabs rail and ordinary
vertically scrollable row/grid entries for live and subordinate Future Content groups without
invented prerequisite edges. Selecting a profession replaces the category list body with its
detail view; the shell footer returns to the originating Gathering, Crafting, or Trade & World
list and restores its scroll position. Skills, Professions, and Achievements are top-level housed
tabs rather than nested history steps, so each root uses **Back to Main Menu** and invokes the
shared close/back-to-menu callback. Current
points, active specialization, gateway requirements, rank cost, disabled reason, pending state, and
the server-confirmed result are always visible without hover. Hidden World Knowledge does not appear
in launch navigation until its authoritative discovery loop exists.
Class cards distinguish Untrained, Locked, and Active; visible launch classes do not advertise a
separate Committed state. Rank 1 is visibly labeled as the commitment boundary, and canonical confirmation prompts confirm both Rank-1 commitment and
the capability-gated free test-server respec. Each rank lists its individual effects and labels them
Supported or Dormant; a pending subsystem never makes the whole class appear unavailable. The class
detail, desktop controls, phone controls, and transient legacy fallback expose no Ultimate card,
slot, cooldown, icon, or `U` action.

## Status vocabulary

`implemented` is live and usable. `future_content` is intentionally represented but has no
invented mechanic. `pending_dependency` requires an authoritative game-data or runtime seam.
`pending_design` requires an approved design decision. Registry metadata may additionally use
`pending_source` or `pending_economy_policy` for unresolved historical evidence or economic rules.

## Trade skills (live)

Alchemy, Blacksmithing, Leatherworking, Cartography and Tradecraft are ordinary General Skills in the
Trades tab: 3 ranks, 1 point each, no prerequisites. Their effects live in the systems they gate; the
shared seam is `packages/shared/src/tradeSkills.ts` (`TRADE_SKILL_GATES`) with the server check
`requireTradeSkillGate`. A gated action reads "Needs <Skill> rank N to <action>."

| Skill | Rank 1 | Rank 2 | Rank 3 |
| --- | --- | --- | --- |
| Tradecraft | NPC shop prices 18% lower | 27% lower | 37% lower |
| Cartography | Artisan Compass and Survey Stake Kit | Artisan Shovel; see and dig silver treasure | See and dig gold treasure |
| Blacksmithing | Repair gear; equipped gear lasts 1.4x | 1.8x | 2.6x; craft Field Traps |
| Leatherworking | Craft Slings (stock and swag) and the first Backpack; +2 Defense vs leather-dropping monsters | Craft Field Nets; +2 Attack vs leather-dropping monsters | Craft Leather Armor; 22% double leather on a leather drop; 70% of used Field Nets return |
| Alchemy | Craft Spark Tonics; Giving Berries you eat heal 45% more | Craft Anti-Venom Tonics and Battle Draughts; tonics last 40% longer | Craft Ember Flasks; +22% Ember damage and Exposed on non-Boss monsters |

"Leather-dropping monster" means the mob's drop table (guaranteed or chance) contains leather
(`mobDropsLeather`). Double leather is rolled once per settlement from a deterministic unit and is gated
by combat item reward policy 13; settlements at policy 12 and older never double. The net return is
derived from the use request, so a repeat request gets the same answer.

Left out: effects with no matching system yet are not in the rank text.
