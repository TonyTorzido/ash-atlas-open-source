# Mob content standard

Every overworld mob added or changed MUST go through this checklist, in order. A mob is done only
when every section is filled in and its tests pass. Dungeon mobs follow sections 1, 3, 4, 5, 6
and 7; their spawning is the dungeon system's, not section 2.

## 1. Identity and art

- **Archetype key**: snake_case, added to `MOB_ARCHETYPE_KEYS` in
  `packages/shared/src/mobContracts.ts`. A biome variant joins its family list there
  (`*_FAMILY_ARCHETYPES`). A mob built on a template goes in `ANIMAL_MOB_TEMPLATES` (a new
  animal) or `FANTASY_MOB_TEMPLATES` (a fantasy mob), mapped to its template: an overworld mob,
  or a world template (`WORLD_MOB_TEMPLATE_KEYS`) when the numbers it borrows exist only on a
  village, event or dungeon mob (Goblin, Lightning Bird, Shell-back Turtle, Cliff Hawk, Carrion
  Chick). Never template on a dungeon mob directly, and never on another template mob.
- **Art**: comes from `C:\Users\dev\Documents\art-drops` (drawn outside the repo,
  bold outline + flat cel shading). Never draw, generate or retouch art inside the repo. Copy the
  finished PNG into `apps/client/src/assets/` (dungeon mobs: `assets/mobs/dungeons`).
- **Artwork key**: map the archetype to a camelCase key in `apps/client/src/map/mobArtwork.ts`.
- **Presentation entry**: add the key to `MOB_SPRITE_PRESENTATION`
  (`apps/client/src/map/mobSpritePresentation.ts`) and its geometry to
  `packages/shared/src/data/runtime-png-presentation.json`. The size class is the entry's
  `baseHeightPx` plus hit geometry: copy the closest existing mob of the same body size and adjust.
- Missing art stays missing: borrow an existing sprite only with a comment naming the backlog.

## 2. Spawn rule

Overworld spawning is data in `MOB_SPAWN_RULES` (`packages/shared/src/mobSpawnRules.ts`). Each
site's encounter table is derived from every rule that matches it; there is no other table.

- A mob has one or more rules. Each rule REQUIRES:
  - `surface`: `land`, `lake`, `river` or `ocean`. The kind must be registered in
    `apps/server/src/game/populationV2MobRegistry.ts` with that surface: its `encounterSurface`,
    or for a water mob that lives on more than one water surface (a pike in lakes and rivers),
    one of its `additionalEncounterSurfaces` (water only, e.g. `encounterSurface: "lake"`,
    `additionalEncounterSurfaces: ["river"]`). Give it one rule per surface.
  - `biomes`: an explicit, non-empty list of site biomes (`MOB_SPAWN_SITE_BIOMES`). Water sites
    resolve to the nearest land ecology, so water rules use land biomes too. Add
    `unknownBiome: true` only if the mob should also spawn where no biome resolves.
  - `rarity`: `common`, `uncommon`, `rare`, `elite` or `boss` (`MOB_SPAWN_RARITY_WEIGHTS`:
    100 / 40 / 15 / 5 / 1.5). Never a number: the weights are defined once, and every site's mix
    is derived from them. `fixedShare` (a fixed fraction of the whole table) exists only for the
    Mysterious Traveler (0.5% of land, `MOB_SPAWN_FIXED_SHARE_KINDS`); validation rejects it on
    any other kind.
- OPTIONAL filters. A rule with a filter never matches a site whose value for that layer is
  unknown:
  - `shore`: `{ coast?, lakeshore?, riverside? }`, each `true` or `false`. These are reliable,
    owner-built World facts meant for shore mobs: `coast` is the `coastal-land` site tag (land
    within 1 km of the ocean, always known); `lakeshore` and `riverside` are land within 500 m of
    a lake or river (World contract `canonical-water-surface-land-within-500m-v1`; profile rows
    without them are rejected). Only older cached sites can still lack them.
  - `elevationBands`: World's site bands (`MOB_SPAWN_ELEVATION_BANDS`): `below_sea_level`
    (< 0 m), `lowland` (< 500), `upland` (< 1500), `montane` (< 2500), `alpine` (< 3500),
    `high_alpine`. Bands are known for all land and fresh-water sites (missing only for
    saltwater and north of 84N). The spawn bands differ from the player-facing height words
    (Lowland/Upland/Highland/Peaks/Summit).
  - `oceanDepth` (ocean rules only): `shallows`, `open_water`, `the_deep`, `the_abyss`
    (`MOB_SPAWN_OCEAN_DEPTHS`). Read from the bundled world-zone lookup at the site's position,
    like the sea zone label; where that lookup is not ocean the site reads `open_water`. If the
    lookup file cannot be loaded, depth is unknown. The label's Shallows also comes from World's
    ocean-coast fact, which sites do not carry, so at the coast edge a `shallows` rule and the
    label can disagree by one band.
  - Not available as a filter: time of day. Day/night admission is a registry field
    (`worldTimePhaseEligibility`), not a spawn rule.
- Two rules of the same mob must never match the same site (validation fails). To give a mob a
  different rarity in different places, split its rules with a filter (`coast: false` /
  `coast: true`).
- How a site's table is derived (`mobSpawnTableEntries`):
  1. Fixed shares (the Traveler) come off the top.
  2. Animal budget: each kind is `animal` (every `ANIMAL_MOB_TEMPLATES` mob, every biome variant
     family, Squid and Jellyfish; nothing is declared per rule) or `fantasy` (everything else).
     Where both groups spawn, animals get 70% of the table (`MOB_SPAWN_ANIMAL_SHARE`) and fantasy
     mobs the rest; a site with one group gives it everything. Inside a group each kind gets its
     rarity weight's part.
  3. Dominance cap: no kind may exceed 12% of a table with 9 or more kinds, or 1.5x an even split
     of a smaller one; rare, elite and boss kinds are capped at their weight's part of that (15%,
     5%, 1.5% of the cap) so redistribution never makes a rare mob common. A capped kind's excess
     goes proportionally to the uncapped kinds of its own group, then to the other group. A table
     too thin to fit under its caps scales every cap up together. Only kinds listed in
     `MOB_SPAWN_INTENTIONALLY_DOMINANT_KINDS` (none today) are exempt.
  Thin water tables can therefore miss the 70% animal budget or level an uncommon with the
  commons; the fix is more kinds at that site, never a number.
- Choosing a rarity:
  - `common`: the everyday mobs of a habitat (tier 1-2 animals and fantasy mobs, biome variants).
  - `uncommon`: tier 3, or a tier 1-2 mob meant to be a notable sighting (bears, ogres).
  - `rare`: a mob players should feel lucky to meet (Jellyfish, Humpback Whale, Drowned Bride).
  - `elite`: tier 4 leaders and champions.
  - `boss`: tier 5 world bosses; always below 1% of any table.
  A water mob that is one of only a few kinds at its site is usually `common`, so no water table
  is one mob plus crumbs.
- Variants are separate kinds with their own rules. A variant's biomes are removed from the base
  kind's rule; a biome with neither has no member of that family.
- Bump `MOB_SPAWN_RULES_REVISION` with any rule change. Existing areas keep their mobs until
  they regenerate.

## 3. Combat matrix entry

Add the archetype to `MOB_MATCHUPS` (`packages/shared/src/mobMatchups.ts`); a missing key is a
compile error. Declare `weaponType` and `armorType` from the matrix types and give player-facing
flavor names (`weaponName`, `armorName`).

- A template mob (animal or fantasy) declares its OWN entry: its own weapon/armor types and
  flavor names, chosen for the creature, not copied from the template.
- Biome variants of one animal family share the base's matchup exactly.
- `damageMultiplier` is 1, except: bosses and reviewed elites; a tier 4 mob (definition level
  in the epic band, levels 16-20) may use 1.25 and a tier 5 mob (legendary band, 21-25) 1.5
  (`MOB_TIER_DAMAGE_MULTIPLIERS`, checked in `mobCompleteness.test.ts`).
- Never edit the matrix itself for one mob.

## 4. Stats

Reuse a template definition (`apps/server/src/game/combat/mobDefinitions.ts`): variants copy
their base, template mobs copy their template's numbers, AI profile and hit count (a world
template's from `WORLD_MOB_TEMPLATES`, which holds copies, so retuning a dungeon mob never moves
a world mob). A template mob may set its own `level` and/or `targetBasicHitCount` in
`TEMPLATE_MOB_OWN_NUMBERS` with a one-line `reason` (e.g. "T5 world boss"). Attack cadence is
uniform for everyone; balance through per-hit levers, never speed.

## 5. Drops and economy

- Every animal has its own meat cut (`<animal>_cut`), wired in `packages/shared/src/universalFood.ts`.
  A mob never drops another animal's meat: a fantasy template mob whose template food is an
  animal's meat gets `null` in `UNIVERSAL_FOOD_BY_MOB` (no food roll); rations are fine.
- A template mob's rewards are its OWN list, never the template's: `ANIMAL_MOB_DROPS` or
  `FANTASY_MOB_DROPS` in `mobDefinitions.ts` (`items`, `chanceItems` built with `ownDrop`,
  `metalMaterialReward` or `metalMaterialRange`, `gold`, optional `cityCoins`). Its universal food
  roll (its meat cut) is added automatically; do not list it. Only the first fourteen fantasy
  mobs keep their template's drops.
- Other drops use shared materials (hides, bones, essences, metals) unless the new item has a
  real use (a recipe, upgrade or quest that consumes it).
- Every new item declares its inventory GROUP on its catalog entry
  (`packages/shared/src/inventoryCatalog.ts`: `group: "meat"` in `resource(...)`, or the group
  argument of `universalFoodResource`/`legendary`). The id no longer decides the group. The
  inventory collapses a group once the player holds more than 4 kinds of it. Groups
  (`INVENTORY_ITEM_GROUP_IDS`; names in `inventoryPanelModel.ts`, icons in
  `apps/client/src/assets/items/groups/`): in use `meat` (Meat), `hides` (Hides and pelts),
  `feathers` (Feathers), `bars` (Bars and cores), `ores` (Ores and minerals), `food` (Food);
  reserved for new items `bones` (Bones, horns and teeth), `scales` (Scales, shells and chitin),
  `venoms` (Venoms and glands), `essences` (Essences and cores), `gems` (Gems and minerals),
  `plants` (Plants and fungi), `trinkets` (Cloth, gear and trinkets), `trophies` (Trophies),
  `eggs` (Eggs), `fish` (Fish and seafood). An item with no group stays a single row.
- A new item needs a migration (item catalog), which makes the change careful lane. Never edit
  an existing migration.

## 6. Creature Book entry

Add the entry and its habitat in `packages/shared/src/creatureBook.ts`. The habitat lists exactly
the biomes of the mob's spawn rules (`biomeHabitat([...biomes], label)`).

Hunt achievements (`huntNames` in `packages/shared/src/legendCatalog.ts`) are optional and added
only on the owner's request. A species without names has a book entry and no hunts; a named
species has all three.

## 7. Tests and lane

- Run `apps/server/src/game/populationV2SpawnRules.test.ts` (rule validation plus the balance
  guards at every reachable combination of site facts: tables normalise, animals hold 70% unless
  the other group is full, the dominance cap holds, the Traveler stays 0.5%, every boss stays
  below 1%) and `populationV2EncounterTables.test.ts`; update `POPULATION_V2_RUNTIME_MOB_KINDS`
  expectations for a newly registered kind. Adding a kind deliberately changes its sites' mix, so
  exact-table and benchmark expectations there move with it. Add a focused test only for new
  behaviour (e.g. a new filter).
- A filter whose site data can be missing is left off the rule and kept as a comment
  (`// intended filter: ...`) until the data is there.
- Typecheck `@ash-atlas/shared` and `@ash-atlas/server`.
- Lane: art, shared data, server and client changes deploy in the fast lane. Any new item
  (migration) moves the whole change to the careful lane.

## Worked example: Reed Heron (hypothetical)

A tier 2 wading bird in Marsh and Jungle, only on land next to lakes.

1. `reed_heron` in `MOB_ARCHETYPE_KEYS` and `reed_heron: "frog"` in `ANIMAL_MOB_TEMPLATES` (which
   also makes it an animal for the animal budget); PNG from the art drop to
   `apps/client/src/assets/reed-heron.png`; `reed_heron: "reedHeron"` in `mobArtwork.ts`;
   `reedHeron` presentation copied from the frog-sized entry and adjusted.
2. Registry definition (`biomeVariantPopulationDefinition` on a land shape such as the Hog's,
   since the Frog's is a lake shape) with `encounterSurface: "land"`, then:
   ```ts
   reed_heron: [{
     surface: "land", biomes: ["marsh", "jungle"], rarity: "common", shore: { lakeshore: true }
   }],
   ```
   and bump `MOB_SPAWN_RULES_REVISION`. At a Marsh lakeshore site the heron joins the animal
   group: animals still take 70% of the table, now split over one more common, and the fantasy
   mix is untouched. Sites with unknown lakeshore get no heron.
3. `reed_heron: matchup("Beak", "spear", "Feathers", "unarmored")`.
4. Stats copied from the Frog template; no own numbers. Name in `ANIMAL_MOB_NAMES`.
5. `heron_cut` (Meat group) as its meat; `heron_feather` only if a recipe uses it (Feathers
   group). `reed_heron: { chanceItems: [ownDrop("leather", 0.3)], gold: 2 }` in
   `ANIMAL_MOB_DROPS`. Both new items: one migration, careful lane.
6. Creature Book entry with habitat "Marsh & Jungle".
7. Spawn rule and encounter table tests (the balance guards cover the heron's sites
   automatically), update the runtime kind list, typecheck shared and server. Add one focused test
   that a Marsh lakeshore site rolls it.
