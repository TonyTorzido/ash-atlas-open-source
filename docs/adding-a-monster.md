# Adding a monster

One command writes every stub; the compiler and two completeness tests refuse a half-wired mob.

## 1. Scaffold

```sh
pnpm mob:scaffold frost_hare --dry-run   # prints the plan, writes nothing
pnpm mob:scaffold frost_hare             # asks for anything not passed as a flag
```

Non-interactive example (`--yes` fails on any missing value instead of asking):

```sh
pnpm mob:scaffold frost_hare --yes --name "Frost Hare" --level 6 \
  --weapon "Teeth:dagger" --armor "Fur:martial_tunic" --hits 2 \
  --gold 3 --item leather:2 --food field_ration \
  --spawn land --pack 2 --density 0.4 \
  --book common --book-habitat forest --hunt-names "Hare Today|Gone Tomorrow|Hare Apparent" \
  --art frost-hare.png
```

`pnpm mob:scaffold` with no key prints every flag. It refuses an existing key, and it writes
nothing if any target is missing. Run it once per mob.

## 2. What it writes, and why

| File | Entry | Why |
| --- | --- | --- |
| `packages/shared/src/mobContracts.ts` | `MOB_ARCHETYPE_KEYS` | The key. Every record below is `Record<MobArchetypeKey, …>`, so each one becomes a compile error until it has the mob. |
| `packages/shared/src/mobMatchups.ts` | `MOB_MATCHUPS` | Weapon/armor type on the universal damage table, plus flavor names. |
| `packages/shared/src/universalFood.ts` | `UNIVERSAL_FOOD_BY_MOB` | The food it drops. |
| `apps/server/src/game/combat/mobDefinitions.ts` | `MOB_DEFINITIONS`, `MOB_AI_PROFILES`, `MOB_TARGET_BASIC_HIT_COUNTS` | Name, level, rewards, boss flag, AI, hit count. |
| `apps/server/src/game/populationV2MobRegistry.ts` | `POPULATION_V2_MOB_DEFINITIONS` (a `registered_overlay` entry) **or** `NON_POPULATION_V2_MOB_ARCHETYPES` | How it enters the world, or which system spawns it instead. |
| `packages/shared/src/creatureBook.ts` | `CREATURE_BOOK_ROSTER` + `CREATURE_BOOK_HABITATS` **or** `CREATURE_BOOK_EXCLUDED_ARCHETYPES` | Encyclopedia entry and habitat page, or why it is not in the book. |
| `packages/shared/src/legendCatalog.ts` | `huntNames` | Three hunt achievements (book creatures only). |
| `apps/appearance-studio/src/mobArtworkSlots.ts` | `normalArtworkByArchetype` | Asset Studio label and sprite editor for its normal PNG (book creatures only). |
| `apps/client/src/map/mobArtwork.ts` | `MOB_ARCHETYPE_ARTWORK` (+ import and `MOB_ARTWORK_URLS` when the PNG exists) | The one place an archetype picks its world PNG. `null` = art pending. |
| `apps/client/src/map/mobSpritePresentation.ts` | `MOB_SPRITE_PRESENTATION` (when the PNG exists) | Size and anchor; starts on `genericMob`. |

No migration is needed. The database checks only the key format on Creature Book tables; the
server checks membership against the shared roster (migration `0910`).

## 3. Still manual (the scaffold prints this list)

- Art, if pending (section 5).
- Spawn tuning: review `spacingClass`, `suppressionClass`, `behaviorCategory` and density. To take
  a share of an existing surface encounter table instead of an independent overlay, follow
  [population-v2-adding-a-mob.md](population-v2-adding-a-mob.md); that also lists the Population V2
  tests to add.
- AI: the stub only retaliates when attacked (packs defend each other). Add proactive aggression,
  standoff movement or a custom leash in `MOB_AI_PROFILES`.
- Optional dev tooling: `apps/client/src/developer/devPngCatalog.ts` and
  `apps/appearance-studio/src/runtimeAssetCatalog.ts` to make the PNG editable in the dev PNG lab
  and Asset Studio.
- Tests that pin the exact roster: `populationV2MobRegistry.test.ts` (registry list) and
  `creatureBook.test.ts` (roster length).

Then run:

```sh
pnpm --filter @ash-atlas/server exec vitest run src/game/mobCompleteness.test.ts
pnpm --filter @ash-atlas/client exec vitest run src/map/mobArtCompleteness.test.ts
```

and typecheck shared, server, client and appearance-studio. A failure names the mob and the
missing piece.

## 4. Matchup and difficulty rules

- Pick a **weapon type** (`unarmed`, `dagger`, `sword`, `axe`, `spear`, `longbow`, …) and an
  **armor type** (`unarmored`, `martial_tunic`, `leather`, `chainmail`, `breastplate`; shields are
  player-only) from the universal damage table. Beasts and birds wear `martial_tunic` as "Fur" or "Feathers".
- **Health = target hit count × the neutral hit (9)**, an equal-level sword into unarmored,
  whatever the monster wears. Armor then decides how many swings it really takes:
  ceil(health ÷ equal-level sword hit into its armor), where that hit is unarmored 9, martial
  tunic 8, leather 7, breastplate 4, chainmail 3. A 3-hit wolf has 27 health and takes 4 sword
  swings through Fur (tunic). Fixed pools: Xoral 5,000, jellyfish, Hollin Hut 10,000.
- **Difficulty comes from level and hit count.** A damage multiplier other than 1 is only for
  bosses (`--boss`) and reviewed elites; the scaffold warns otherwise and the completeness test
  fails.
- **Level**: world spawns take the level of the zone they spawn in. The definition level is the
  fixed level for dungeon, event and developer spawns.

## 5. Art

- Match `apps/client/src/assets/wolf.png` and `ogre.png`: 1254 × 1254 px PNG, transparent
  background, the creature standing on the same baseline and framing.
- Put it at the `--art` path under `apps/client/src/assets` (default `<key-with-dashes>.png`).
  If the file exists when you scaffold, it is wired automatically; otherwise the mob is
  recorded as `null` (art pending) and draws as a generic marker.
- Missing art stays empty. Never draw a placeholder. Track pending art in
  `docs/wiki-art-backlog.md` where that file exists (it lands with the wiki work; this base does
  not have it yet).

## 6. Placeholder matchups (tune with the dungeon designer)

The dungeon and Hollin archetypes copied their weapon and armor types from the closest existing
monster. Health keeps each mob's hit count (× 9); the Hollin Hut keeps a fixed 10,000 pool.

| Mob | Weapon | Armor | × | Copied from |
| --- | --- | --- | --- | --- |
| shellback_turtle | Beak (spear) | Shell (chainmail) | 1 | coastal_crab |
| sewer_spider | Fangs (unarmed) | Chitin (unarmored) | 1 | sap_crawler |
| dune_tick | Bite (unarmed) | Shell (unarmored) | 1 | sewer_rat |
| spiderling | Fangs (unarmed) | Soft Body (unarmored) | 1 | sap_crawler |
| brood_matriarch | Fangs (unarmed) | Chitin (unarmored) | 1.5 | sap_crawler, boss |
| cave_raptor | Claws (dagger) | Hide (martial_tunic) | 1 | wolf |
| raptor_runt | Claws (dagger) | Hide (martial_tunic) | 1 | wolf |
| raptor_spitter | Spit (dagger) | Hide (martial_tunic) | 1 | goblin |
| cave_bat | Bite (dagger) | Fur (martial_tunic) | 1 | wolf |
| raptor_chieftain | Claws (dagger) | Hide (martial_tunic) | 1.5 | wolf, boss |
| nest_mouse | Gnaw (unarmed) | Fur (unarmored) | 1 | sewer_rat |
| carrion_chick | Beak (spear) | Matted Down (chainmail) | 1 | hog |
| cliff_hawk | Talons (spear) | Feathers (martial_tunic) | 1 | legendary birds |
| thunderwing | Talons (spear) | Feathers (martial_tunic) | 1.5 | lightning_bird, boss |
| rot_wolf | Bite (dagger) | Fur (martial_tunic) | 1 | wolf |
| blighted_stag | Antlers (spear) | Fur (martial_tunic) | 1 | deer |
| thornfern | Thorns (unarmed) | Fronds (unarmored) | 1 | sap_crawler |
| blight_treant | Crushing Roots (axe) | Bark (chainmail) | 1 | xoral |
| blight_sprite | Spores (unarmed) | Soft Body (unarmored) | 1 | sap_crawler |
| hollow_elder | Crushing Roots (axe) | Ironbark (chainmail) | 1.5 | xoral, boss |
| hollin_hut | None (unarmed) | Thatch (unarmored) | 1 | training_dummy |
| hollin_guard | Knife (dagger) | Tunic (martial_tunic) | 1 | goblin |
| hollin_farmer | None (unarmed) | Clothes (unarmored) | 1 | training_dummy |
| hollin_helper | None (unarmed) | Clothes (unarmored) | 1 | training_dummy |

The Hollin archetypes have no PNG yet (art pending) and draw as placeholder squares.
