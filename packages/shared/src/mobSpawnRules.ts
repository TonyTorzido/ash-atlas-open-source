import { ANIMAL_MOB_ARCHETYPES, MOB_BIOME_VARIANT_FAMILIES } from "./mobContracts.js";
import {
  WORLD_ZONE_OCEAN_DEPTHS,
  type WorldZoneBiome,
  type WorldZoneOceanDepth
} from "./worldZones.js";

/**
 * Per-mob overworld spawn rules. A site's encounter table is derived from
 * every rule that matches it (server: populationV2EncounterTables.ts), so a
 * mob's habitat lives here and nowhere else. The standard for adding a mob is
 * docs/architecture/MOB_CONTENT_STANDARD.md.
 *
 * Bump the revision whenever a rule changes: it keys the deterministic
 * encounter roll, so regenerated areas re-roll against the new tables.
 */
export const MOB_SPAWN_RULES_REVISION = "mob-spawn-rules-v10-biome-roster-c";

export const MOB_SPAWN_SURFACES = ["land", "lake", "river", "ocean"] as const;
export type MobSpawnSurface = (typeof MOB_SPAWN_SURFACES)[number];

/**
 * The land biomes a population site can resolve to (worldZoneBiomeFromResolveIds).
 * Water sites resolve to the nearest land ecology, so lake, river and ocean
 * rules use these biomes too.
 */
export const MOB_SPAWN_SITE_BIOMES = [
  "jungle", "pinewild", "greenwood", "frostwood", "plains", "savanna", "marsh",
  "highmeadow", "scrubland", "badlands", "steppe", "tundra", "frozen_waste"
] as const satisfies readonly WorldZoneBiome[];
export type MobSpawnSiteBiome = (typeof MOB_SPAWN_SITE_BIOMES)[number];

/** Shoreline facts of a site; each listed key must equal the site's known value. */
export type MobSpawnShore = Readonly<{
  /** Land site tagged `coastal-land`. */
  coast?: boolean;
  lakeshore?: boolean;
  /** Land site on a riverbank. */
  riverside?: boolean;
}>;
export const MOB_SPAWN_SHORE_KEYS = ["coast", "lakeshore", "riverside"] as const;

/**
 * Land elevation bands exactly as World reports them on a site (`elevationBand`,
 * world-pipeline `_elevation_band`): below 0 m, <500, <1500, <2500, <3500, above.
 * Any other value (including the planner's "unknown") reads as unknown.
 */
export const MOB_SPAWN_ELEVATION_BANDS = [
  "below_sea_level", "lowland", "upland", "montane", "alpine", "high_alpine"
] as const;
export type MobSpawnElevationBand = (typeof MOB_SPAWN_ELEVATION_BANDS)[number];

export function isMobSpawnElevationBand(value: string | null | undefined): value is MobSpawnElevationBand {
  return (MOB_SPAWN_ELEVATION_BANDS as readonly string[]).includes(value ?? "");
}

/** Ocean depth band ids (worldZones.ts): Shallows (the Coast biome), Open Water, The Deep, The Abyss. */
export const MOB_SPAWN_OCEAN_DEPTHS = WORLD_ZONE_OCEAN_DEPTHS;
export type MobSpawnOceanDepth = WorldZoneOceanDepth;

type MobSpawnRuleWhere = Readonly<{
  surface: MobSpawnSurface;
  /** Biomes the rule matches. Required and non-empty. */
  biomes: readonly MobSpawnSiteBiome[];
  /** Also match sites whose biome cannot be resolved. */
  unknownBiome?: boolean;
  /** Optional: World elevation bands the site must be in. */
  elevationBands?: readonly MobSpawnElevationBand[];
  /** Optional, ocean rules only: depth bands the site must be in. */
  oceanDepth?: readonly MobSpawnOceanDepth[];
  /** Optional: shoreline facts. */
  shore?: MobSpawnShore;
}>;

/**
 * How often a mob turns up next to the other mobs of its group (animal or
 * fantasy) at a site. Weights are relative and defined only here.
 */
export const MOB_SPAWN_RARITY_WEIGHTS = Object.freeze({
  common: 100,
  uncommon: 40,
  rare: 15,
  elite: 5,
  boss: 1.5
});
export type MobSpawnRarity = keyof typeof MOB_SPAWN_RARITY_WEIGHTS;
export const MOB_SPAWN_RARITIES = Object.freeze(Object.keys(MOB_SPAWN_RARITY_WEIGHTS) as MobSpawnRarity[]);

/** Share of a site's table that goes to animals when the site has animals and fantasy mobs. */
export const MOB_SPAWN_ANIMAL_SHARE = 0.70;
/** Most any one kind may hold of a table with at least MOB_SPAWN_DOMINANCE_MIN_KINDS kinds. */
export const MOB_SPAWN_DOMINANCE_CAP = 0.12;
export const MOB_SPAWN_DOMINANCE_MIN_KINDS = 9;
/** Smaller tables: at most this multiple of an even split. */
export const MOB_SPAWN_SMALL_TABLE_CAP_FACTOR = 1.5;
/** Kinds meant to dominate wherever they spawn; exempt from the dominance cap. None today. */
export const MOB_SPAWN_INTENTIONALLY_DOMINANT_KINDS: readonly string[] = Object.freeze([]);
/** The only kinds allowed a fixed share of the table instead of a rarity. */
export const MOB_SPAWN_FIXED_SHARE_KINDS: readonly string[] = Object.freeze([]);

/**
 * Animals for the animal budget: every animal template mob, every biome
 * variant family (deer, wolf, hog, bear, crab, frog, alligator) and the
 * original sea animals. Every other spawning mob is fantasy.
 */
const MOB_SPAWN_ANIMAL_KINDS: ReadonlySet<string> = new Set([
  ...ANIMAL_MOB_ARCHETYPES,
  ...Object.values(MOB_BIOME_VARIANT_FAMILIES).flat(),
  "squid",
  "jellyfish"
]);

export type MobSpawnGroup = "animal" | "fantasy";
export function mobSpawnGroup(kind: string): MobSpawnGroup {
  return MOB_SPAWN_ANIMAL_KINDS.has(kind) ? "animal" : "fantasy";
}

/**
 * `rarity`: the mob's place in its group's mix. `fixedShare`: a fixed fraction
 * of the whole table, only for MOB_SPAWN_FIXED_SHARE_KINDS.
 */
export type MobSpawnRule = MobSpawnRuleWhere & (
  | Readonly<{ rarity: MobSpawnRarity; fixedShare?: never }>
  | Readonly<{ fixedShare: number; rarity?: never }>
);

/** What a site is, per layer; null means unknown (optional filters then do not match). */
export type MobSpawnSiteFacts = Readonly<{
  surface: MobSpawnSurface;
  biome: WorldZoneBiome | null;
  elevationBand: MobSpawnElevationBand | null;
  /** Ocean sites only; null elsewhere or when unknown. */
  oceanDepth: MobSpawnOceanDepth | null;
  coast: boolean | null;
  lakeshore: boolean | null;
  riverside: boolean | null;
}>;

const ALL: readonly MobSpawnSiteBiome[] = MOB_SPAWN_SITE_BIOMES;

function land(rarity: MobSpawnRarity, biomes: readonly MobSpawnSiteBiome[], unknownBiome = false): MobSpawnRule {
  return { surface: "land", biomes, unknownBiome, rarity };
}


function water(
  surface: Exclude<MobSpawnSurface, "land">,
  rarity: MobSpawnRarity,
  biomes: readonly MobSpawnSiteBiome[],
  unknownBiome = false
): MobSpawnRule {
  return { surface, biomes, unknownBiome, rarity };
}

/**
 * Every overworld mob's spawn rules. Biome variants are separate kinds with
 * their own rules. Order is the roll order of a derived table.
 */
export const MOB_SPAWN_RULES = Object.freeze({
  // Land roster (biome roster overhaul, phase A): biome lists only, one rule per kind
  // per rarity. Kinds with no land rule left here spawn nowhere on land.
  // Animals
  jungle_tapir: [land("common", ["jungle"])],
  mandrill: [land("common", ["jungle"])],
  jaguar: [land("uncommon", ["jungle"])],

  red_squirrel: [land("common", ["pinewild"])],
  hog: [land("common", ["pinewild", "greenwood", "scrubland"], true)],
  wolf: [land("common", ["pinewild", "plains"], true)],
  bear: [land("uncommon", ["pinewild"], true)],

  grey_squirrel: [land("common", ["greenwood"])],
  badger: [land("common", ["greenwood"])],

  woolly_hog: [land("common", ["frostwood"])],
  great_grey_owl: [land("uncommon", ["frostwood"])],
  frost_wolf: [land("common", ["frostwood", "tundra"])],

  prairie_dog: [land("common", ["plains"])],
  plains_bison: [land("common", ["plains"])],
  wild_horse: [land("common", ["plains", "steppe"])],

  warthog: [land("common", ["savanna"])],
  giraffe: [land("uncommon", ["savanna"])],
  spotted_hyena: [land("common", ["savanna"])],
  lioness: [land("uncommon", ["savanna"])],

  mud_hog: [land("common", ["marsh"])],

  alpine_marmot: [land("common", ["highmeadow"])],
  mountain_ibex: [land("common", ["highmeadow"])],
  wild_yak: [land("uncommon", ["highmeadow"])],

  wild_scrub_goat: [land("common", ["scrubland"])],
  crested_porcupine: [land("common", ["scrubland"])],
  spur_thighed_tortoise: [land("common", ["scrubland"])],

  fennec_fox: [land("common", ["badlands"])],
  javelina: [land("common", ["badlands"])],
  dromedary: [land("common", ["badlands"])],
  sidewinder: [land("common", ["badlands"])],

  steppe_marmot: [land("common", ["steppe"])],
  saiga: [land("common", ["steppe"])],
  dune_wolf: [land("common", ["steppe"])],
  woolly_mammoth: [land("uncommon", ["steppe", "tundra"])],

  snow_goose: [land("common", ["tundra"])],

  lemming: [land("common", ["frozen_waste"])],
  snow_bear: [land("uncommon", ["frozen_waste"])],

  // Phase C animals
  field_hare: [land("common", ["pinewild", "greenwood", "plains", "scrubland"])],
  arctic_hare: [land("common", ["frostwood", "tundra", "frozen_waste"])],
  capybara: [land("common", ["jungle", "marsh"])],
  armadillo: [land("common", ["jungle", "badlands"])],
  red_fox: [land("common", ["greenwood"])],
  wolverine: [land("uncommon", ["frostwood", "highmeadow"])],
  ostrich: [land("uncommon", ["savanna"])],
  golden_eagle: [land("uncommon", ["highmeadow"])],
  musk_ox: [land("uncommon", ["tundra", "frozen_waste"])],
  seal: [land("common", ["frozen_waste"])],

  // Fantasy
  vine_lurker: [land("common", ["jungle"])],
  lizardfolk_warrior: [land("common", ["jungle"])],
  snapjaw_flytrap: [land("common", ["jungle"])],

  pine_dryad: [land("common", ["pinewild"])],
  moss_troll: [land("uncommon", ["pinewild"])],
  barrow_wight: [land("common", ["pinewild", "frostwood"])],

  moss_golem: [land("uncommon", ["greenwood"])],
  mossjaw_spearman: [land("common", ["greenwood"])],
  hedge_witch: [land("common", ["greenwood"])],

  rime_witch: [land("common", ["frostwood"])],
  snow_talonbear: [land("uncommon", ["frostwood"])],

  centaur_outrider: [land("common", ["plains", "steppe"])],
  volt_elemental: [land("uncommon", ["plains"])],
  griffin: [land("uncommon", ["plains", "highmeadow"])],

  gnoll_bonebow: [land("common", ["savanna"])],
  thunderhorn: [land("uncommon", ["savanna"])],
  basilisk: [land("uncommon", ["savanna", "scrubland"])],

  frogfolk_blowgunner: [land("common", ["marsh"])],
  bloat_leech: [land("common", ["marsh"])],
  bog_hag: [land("uncommon", ["marsh"])],

  storm_harpy: [land("common", ["highmeadow"])],
  cairn_golem: [land("uncommon", ["highmeadow", "steppe"])],

  cyclops_shepherd: [land("uncommon", ["scrubland"])],
  olive_dryad: [land("common", ["scrubland"])],

  giant_scorpion: [land("common", ["badlands"])],
  ash_drake: [land("common", ["badlands"])],
  dust_mummy: [land("common", ["badlands"])],

  kurgan_wight: [land("common", ["steppe"])],

  frost_wraith: [land("common", ["tundra"])],
  yeti: [land("uncommon", ["tundra", "frozen_waste"])],
  permafrost_elemental: [land("uncommon", ["tundra"])],

  rime_troll: [land("uncommon", ["frozen_waste"])],
  aurora_shade: [land("rare", ["frozen_waste"])],

  // Water (unchanged), plus marsh land rules for frog, river_otter and alligator.
  frog: [
    water("lake", "common", ["pinewild", "greenwood", "plains", "marsh", "highmeadow", "scrubland"], true),
    land("common", ["marsh"])
  ],
  frost_frog: [water("lake", "common", ["frostwood", "tundra", "frozen_waste"])],
  poison_frog: [water("lake", "common", ["jungle"])],
  desert_toad: [water("lake", "common", ["savanna", "steppe", "badlands"])],

  alligator: [
    water("river", "common", [
      "pinewild", "greenwood", "frostwood", "plains", "marsh", "highmeadow",
      "scrubland", "tundra", "frozen_waste"
    ], true),
    land("uncommon", ["marsh"])
  ],
  caiman: [water("river", "common", ["jungle"])],
  crocodile: [water("river", "common", ["savanna", "steppe", "badlands"])],

  squid: [water("ocean", "common", ALL, true)],
  jellyfish: [water("ocean", "rare", ALL, true)],
  // Wave 1 water
  frostwater_troll: [{ surface: "river", biomes: ["frostwood", "tundra"], rarity: "uncommon" }],
  underice_lurker: [{ surface: "lake", biomes: ["frostwood", "tundra", "frozen_waste"], rarity: "uncommon" }],
  frogfolk_tadpole: [{ surface: "lake", biomes: ["marsh"], rarity: "common" }],
  leech_mother: [{ surface: "lake", biomes: ["marsh"], rarity: "elite" }],
  sea_otter: [{ surface: "ocean", biomes: ["pinewild", "greenwood", "frostwood", "plains", "marsh", "highmeadow", "scrubland", "steppe", "tundra", "frozen_waste"], rarity: "common", oceanDepth: ["shallows"] }],
  spiny_lobster: [{ surface: "ocean", biomes: ["jungle", "pinewild", "greenwood", "plains", "savanna", "marsh", "highmeadow", "scrubland", "badlands", "steppe"], rarity: "common", oceanDepth: ["shallows"] }],
  coral_golem: [{ surface: "ocean", biomes: ["jungle", "savanna", "marsh", "scrubland", "badlands"], rarity: "uncommon", oceanDepth: ["shallows"] }],
  reef_kraken: [{ surface: "ocean", biomes: ALL, unknownBiome: true, rarity: "uncommon", oceanDepth: ["shallows"] }],
  // Wave 1: Open Ocean
  hammerhead_shark: [{ surface: "ocean", biomes: ["jungle", "pinewild", "greenwood", "plains", "savanna", "marsh", "highmeadow", "scrubland", "badlands", "steppe"], rarity: "common", oceanDepth: ["open_water", "the_deep"] }],
  manta_ray: [{ surface: "ocean", biomes: ["jungle", "savanna", "marsh", "scrubland", "badlands"], rarity: "common", oceanDepth: ["open_water"] }],
  humpback_whale: [{ surface: "ocean", biomes: ALL, unknownBiome: true, rarity: "rare", oceanDepth: ["open_water", "the_deep"] }],
  merfolk_harpooner: [{ surface: "ocean", biomes: ALL, unknownBiome: true, rarity: "common", oceanDepth: ["open_water"] }],
  phantom_lookout: [{ surface: "ocean", biomes: ALL, unknownBiome: true, rarity: "common", oceanDepth: ["open_water", "the_deep"] }],
  maelstrom_spirit: [{ surface: "ocean", biomes: ALL, unknownBiome: true, rarity: "uncommon", oceanDepth: ["open_water", "the_deep"] }],
  sea_serpent: [{ surface: "ocean", biomes: ALL, unknownBiome: true, rarity: "uncommon", oceanDepth: ["open_water", "the_deep"] }],
  kraken: [{ surface: "ocean", biomes: ALL, unknownBiome: true, rarity: "elite", oceanDepth: ["the_deep", "the_abyss"] }],
  // Wave 1: Lake
  muskellunge: [{ surface: "lake", biomes: ["pinewild", "greenwood", "frostwood", "plains", "highmeadow"], rarity: "common" }],
  mute_swan: [water("lake", "common", ["pinewild", "greenwood", "plains", "highmeadow", "scrubland", "marsh", "steppe"])],
  drowned_bride: [{ surface: "lake", biomes: ALL, unknownBiome: true, rarity: "rare" }],
  lake_maiden: [{ surface: "lake", biomes: ["pinewild", "greenwood", "plains", "highmeadow", "scrubland", "marsh", "steppe"], rarity: "uncommon" }],
  elder_mere_serpent: [{ surface: "lake", biomes: ["pinewild", "greenwood", "frostwood", "plains", "highmeadow", "marsh", "steppe", "tundra"], rarity: "boss" }],
  northern_pike: [
    water("lake", "common", ["pinewild", "greenwood", "frostwood", "plains", "highmeadow", "marsh", "steppe", "tundra"]),
    water("river", "common", ["pinewild", "greenwood", "frostwood", "plains", "highmeadow", "marsh", "steppe", "tundra"])
  ],
  snapping_turtle: [water("lake", "common", ["jungle", "pinewild", "greenwood", "plains", "savanna", "marsh", "scrubland"])],
  drowned_thrall: [{ surface: "lake", biomes: ALL, unknownBiome: true, rarity: "common" }],
  // Wave 1: River
  beaver: [
    water("river", "common", ["pinewild", "greenwood", "frostwood", "plains", "highmeadow", "marsh", "steppe", "tundra"]),
    water("lake", "common", ["pinewild", "greenwood", "frostwood", "plains", "highmeadow", "marsh", "steppe", "tundra"])
  ],
  river_otter: [
    water("river", "common", ["jungle", "pinewild", "greenwood", "frostwood", "plains", "savanna", "marsh", "highmeadow", "scrubland", "steppe", "tundra"]),
    water("lake", "common", ["jungle", "pinewild", "greenwood", "frostwood", "plains", "savanna", "marsh", "highmeadow", "scrubland", "steppe", "tundra"]),
    land("common", ["marsh"])
  ],
  river_salmon: [
    water("river", "common", ["pinewild", "greenwood", "frostwood", "plains", "highmeadow", "tundra"]),
    water("lake", "common", ["pinewild", "greenwood", "frostwood", "plains", "highmeadow", "tundra"])
  ],
  kappa: [{ surface: "river", biomes: ["jungle", "pinewild", "greenwood", "plains", "highmeadow", "scrubland", "marsh"], rarity: "common" }],
  kappa_brawler: [{ surface: "river", biomes: ["jungle", "pinewild", "greenwood", "plains", "highmeadow", "scrubland", "marsh"], rarity: "uncommon" }],
  bridge_troll: [{ surface: "river", biomes: ["jungle", "pinewild", "greenwood", "plains", "savanna", "marsh", "highmeadow", "scrubland", "badlands", "steppe", "frozen_waste"], rarity: "elite" }],
  nixie: [{ surface: "river", biomes: ["jungle", "pinewild", "greenwood", "frostwood", "plains", "savanna", "marsh", "highmeadow", "scrubland", "steppe", "tundra"], rarity: "common" }],
  rapids_elemental: [{ surface: "river", biomes: ALL, unknownBiome: true, rarity: "uncommon", elevationBands: ["upland", "montane", "alpine", "high_alpine"] }],
  // Water game phase B (docs/design/WATER_GAME_PLAN.md): open sea past the shallows.
  // Shellbacks also herd on lakes (no lake-size layer exists; intended filter: large lakes only).
  shellback: [
    { surface: "ocean", biomes: ALL, unknownBiome: true, rarity: "common", oceanDepth: ["open_water", "the_deep"] },
    water("lake", "uncommon", ALL, true)
  ],
  darter: [{ surface: "ocean", biomes: ALL, unknownBiome: true, rarity: "common", oceanDepth: ["open_water", "the_deep"] }],
  ink_pool: [{ surface: "ocean", biomes: ALL, unknownBiome: true, rarity: "uncommon", oceanDepth: ["open_water", "the_deep", "the_abyss"] }],
  drowned_citizen: [{ surface: "ocean", biomes: ALL, unknownBiome: true, rarity: "rare", oceanDepth: ["open_water", "the_deep"] }],
  tide_wraith: [{ surface: "ocean", biomes: ALL, unknownBiome: true, rarity: "uncommon", oceanDepth: ["the_deep", "the_abyss"] }],
  gate_warden: [{ surface: "ocean", biomes: ALL, unknownBiome: true, rarity: "rare", oceanDepth: ["the_deep", "the_abyss"] }],
  drowned_cultist: [{ surface: "ocean", biomes: ALL, unknownBiome: true, rarity: "rare", oceanDepth: ["the_abyss"] }],
} satisfies Readonly<Record<string, readonly MobSpawnRule[]>>);

export type MobSpawnKind = keyof typeof MOB_SPAWN_RULES;
export const MOB_SPAWN_KINDS = Object.freeze(Object.keys(MOB_SPAWN_RULES) as MobSpawnKind[]);

function rulesOf(kind: MobSpawnKind): readonly MobSpawnRule[] {
  return MOB_SPAWN_RULES[kind];
}

/** Where a spawned mob may walk: land, or any water surface. */
export type MobMovementHabitat = "land" | "water";

const MOB_MOVEMENT_HABITATS: ReadonlyMap<string, MobMovementHabitat> = new Map(
  MOB_SPAWN_KINDS.flatMap((kind) => {
    const surfaces = new Set(rulesOf(kind).map((rule) => rule.surface === "land" ? "land" : "water"));
    return surfaces.size === 1 ? [[kind, [...surfaces][0]!] as const] : [];
  })
);

/**
 * The movement habitat of a spawning mob, from its spawn rules' surfaces: land
 * when every rule is land, water when every rule is lake, river or ocean. Null
 * for a kind with no spawn rules or with both (it may go anywhere).
 */
export function mobMovementHabitat(kind: string | null | undefined): MobMovementHabitat | null {
  return kind == null ? null : MOB_MOVEMENT_HABITATS.get(kind) ?? null;
}

export function mobSpawnRuleMatches(rule: MobSpawnRule, site: MobSpawnSiteFacts): boolean {
  if (rule.surface !== site.surface) return false;
  if (site.biome === null ? rule.unknownBiome !== true
    : !(rule.biomes as readonly string[]).includes(site.biome)) return false;
  if (rule.elevationBands !== undefined
      && (site.elevationBand === null || !rule.elevationBands.includes(site.elevationBand))) {
    return false;
  }
  if (rule.oceanDepth !== undefined
      && (site.oceanDepth === null || !rule.oceanDepth.includes(site.oceanDepth))) {
    return false;
  }
  if (rule.shore !== undefined) {
    for (const key of MOB_SPAWN_SHORE_KEYS) {
      const wanted = rule.shore[key];
      if (wanted !== undefined && site[key] !== wanted) return false;
    }
  }
  return true;
}

/**
 * The optional layers any rule on a surface filters on. Only these layers
 * (plus surface and biome) can change a derived table, so they alone key it.
 */
export function mobSpawnLayersUsed(surface: MobSpawnSurface): Readonly<{
  elevationBand: boolean;
  oceanDepth: boolean;
  coast: boolean;
  lakeshore: boolean;
  riverside: boolean;
}> {
  const used = { elevationBand: false, oceanDepth: false, coast: false, lakeshore: false, riverside: false };
  for (const kind of MOB_SPAWN_KINDS) {
    for (const rule of rulesOf(kind)) {
      if (rule.surface !== surface) continue;
      if (rule.elevationBands !== undefined) used.elevationBand = true;
      if (rule.oceanDepth !== undefined) used.oceanDepth = true;
      for (const key of MOB_SPAWN_SHORE_KEYS) {
        if (rule.shore?.[key] !== undefined) used[key] = true;
      }
    }
  }
  return used;
}

/** The dominance cap for a table of `kindCount` kinds. */
export function mobSpawnDominanceCap(kindCount: number): number {
  return kindCount >= MOB_SPAWN_DOMINANCE_MIN_KINDS
    ? MOB_SPAWN_DOMINANCE_CAP
    : MOB_SPAWN_SMALL_TABLE_CAP_FACTOR / kindCount;
}

/**
 * The most one kind of this rarity may hold of a table of `kindCount` kinds:
 * the dominance cap for common and uncommon kinds, the rarity's part of it
 * (cap x weight / common weight) for rare, elite and boss kinds, so that
 * redistributed excess never makes a rare mob common.
 */
export function mobSpawnKindCap(kind: string, rarity: MobSpawnRarity, kindCount: number): number {
  if (MOB_SPAWN_INTENTIONALLY_DOMINANT_KINDS.includes(kind)) return Number.POSITIVE_INFINITY;
  const weight = MOB_SPAWN_RARITY_WEIGHTS[rarity];
  const cap = mobSpawnDominanceCap(kindCount);
  return weight >= MOB_SPAWN_RARITY_WEIGHTS.uncommon ? cap : cap * weight / MOB_SPAWN_RARITY_WEIGHTS.common;
}

const CAP_EPSILON = 1e-12;

/**
 * The encounter table for one site, as fractions summing to 1, in
 * MOB_SPAWN_RULES order:
 * 1. fixed shares (none today) are taken off the top;
 * 2. the rest splits into animals and fantasy mobs: animals get
 *    MOB_SPAWN_ANIMAL_SHARE where both groups spawn, one group alone gets all
 *    of it; inside a group each kind gets its rarity weight's part;
 * 3. no kind may exceed its cap (mobSpawnKindCap). A capped kind's excess
 *    goes proportionally to the uncapped kinds of its own group, then to the
 *    other group's. A table too thin to fit under its caps scales every cap
 *    up together (commons and uncommons level, rarer kinds at their part).
 */
export function mobSpawnTableEntries(site: MobSpawnSiteFacts): readonly (readonly [MobSpawnKind, number])[] {
  type Entry = {
    kind: MobSpawnKind;
    group: MobSpawnGroup;
    fixed: boolean;
    rarity: MobSpawnRarity;
    weight: number;
    value: number;
    capped: boolean;
  };
  const entries: Entry[] = [];
  for (const kind of MOB_SPAWN_KINDS) {
    const matched = rulesOf(kind).filter((rule) => mobSpawnRuleMatches(rule, site));
    if (matched.length > 1) {
      throw new Error(`mob spawn rules for ${kind} overlap: ${matched.length} match one site`);
    }
    const rule = matched[0];
    if (rule === undefined) continue;
    const fixed = rule.fixedShare !== undefined;
    entries.push({
      kind,
      group: mobSpawnGroup(kind),
      fixed,
      rarity: rule.rarity ?? "common",
      weight: fixed ? 0 : MOB_SPAWN_RARITY_WEIGHTS[rule.rarity!],
      value: fixed ? rule.fixedShare! : 0,
      capped: false
    });
  }
  const fixedTotal = entries.reduce((sum, entry) => sum + entry.value, 0);
  const pooled = entries.filter((entry) => !entry.fixed);
  const groupWeight = (group: MobSpawnGroup) =>
    pooled.reduce((sum, entry) => sum + (entry.group === group ? entry.weight : 0), 0);
  const weights = { animal: groupWeight("animal"), fantasy: groupWeight("fantasy") };
  const rest = 1 - fixedTotal;
  const mass = weights.animal > 0 && weights.fantasy > 0
    ? { animal: MOB_SPAWN_ANIMAL_SHARE, fantasy: rest - MOB_SPAWN_ANIMAL_SHARE }
    : { animal: weights.animal > 0 ? rest : 0, fantasy: weights.fantasy > 0 ? rest : 0 };
  for (const entry of pooled) entry.value = entry.weight / weights[entry.group] * mass[entry.group];

  const capOf = (entry: Entry) => mobSpawnKindCap(entry.kind, entry.rarity, entries.length);
  for (;;) {
    const over = pooled.filter((entry) => !entry.capped && entry.value > capOf(entry) + CAP_EPSILON);
    if (over.length === 0) break;
    const excess = { animal: 0, fantasy: 0 };
    for (const entry of over) {
      excess[entry.group] += entry.value - capOf(entry);
      entry.value = capOf(entry);
      entry.capped = true;
    }
    for (const group of ["animal", "fantasy"] as const) {
      if (excess[group] === 0) continue;
      const own = pooled.filter((entry) => !entry.capped && entry.group === group);
      const receivers = own.length > 0 ? own : pooled.filter((entry) => !entry.capped);
      if (receivers.length === 0) {
        // Every kind is at its cap: the table is too thin to fit under the
        // caps, so they scale up together.
        const capped = pooled.reduce((sum, entry) => sum + entry.value, 0);
        for (const entry of pooled) entry.value *= (capped + excess[group]) / capped;
        continue;
      }
      const receiving = receivers.reduce((sum, entry) => sum + entry.value, 0);
      for (const entry of receivers) entry.value += excess[group] * entry.value / receiving;
    }
  }
  return entries.map((entry) => [entry.kind, entry.value] as const);
}

/**
 * Every combination of layer values the rules can tell apart, per surface:
 * each site biome plus unknown, and for each used optional layer every value
 * and unknown.
 */
export function mobSpawnSiteFactCombinations(): MobSpawnSiteFacts[] {
  const combinations: MobSpawnSiteFacts[] = [];
  for (const surface of MOB_SPAWN_SURFACES) {
    const used = mobSpawnLayersUsed(surface);
    const bands = used.elevationBand ? [null, ...MOB_SPAWN_ELEVATION_BANDS] : [null];
    const depths = used.oceanDepth ? [null, ...MOB_SPAWN_OCEAN_DEPTHS] : [null];
    const flag = (isUsed: boolean) => isUsed ? [null, false, true] : [null];
    for (const biome of [null, ...MOB_SPAWN_SITE_BIOMES]) {
      for (const elevationBand of bands) {
        for (const oceanDepth of depths) {
          for (const coast of flag(used.coast)) {
            for (const lakeshore of flag(used.lakeshore)) {
              for (const riverside of flag(used.riverside)) {
                combinations.push({ surface, biome, elevationBand, oceanDepth, coast, lakeshore, riverside });
              }
            }
          }
        }
      }
    }
  }
  return combinations;
}

/** Data checks that need no mob registry; the server adds the registry check. */
export function validateMobSpawnRules(): void {
  for (const kind of MOB_SPAWN_KINDS) {
    if (!/^[a-z][a-z0-9_]*$/u.test(kind)) throw new Error(`mob spawn kind ${kind} is invalid`);
    const rules = rulesOf(kind);
    if (rules.length === 0) throw new Error(`mob ${kind} has no spawn rules`);
    for (const rule of rules) {
      if (!(MOB_SPAWN_SURFACES as readonly string[]).includes(rule.surface)) {
        throw new Error(`mob ${kind} spawn rule has invalid surface ${rule.surface}`);
      }
      if (rule.biomes.length === 0) throw new Error(`mob ${kind} spawn rule lists no biomes`);
      if (rule.biomes.some((biome) => !(MOB_SPAWN_SITE_BIOMES as readonly string[]).includes(biome))) {
        throw new Error(`mob ${kind} spawn rule lists a biome no site resolves to`);
      }
      if (rule.elevationBands !== undefined && (rule.elevationBands.length === 0
          || !rule.elevationBands.every((band) => isMobSpawnElevationBand(band)))) {
        throw new Error(`mob ${kind} spawn rule has an empty or invalid elevation filter`);
      }
      if (rule.oceanDepth !== undefined && (rule.surface !== "ocean" || rule.oceanDepth.length === 0
          || !rule.oceanDepth.every((depth) => (MOB_SPAWN_OCEAN_DEPTHS as readonly string[]).includes(depth)))) {
        throw new Error(`mob ${kind} spawn rule ocean depth filter must be a non-empty ocean-only list`);
      }
      const hasRarity = rule.rarity !== undefined;
      const hasFixedShare = rule.fixedShare !== undefined;
      if (hasRarity === hasFixedShare) {
        throw new Error(`mob ${kind} spawn rule needs exactly one of rarity or fixedShare`);
      }
      if (hasRarity && !(MOB_SPAWN_RARITIES as readonly string[]).includes(rule.rarity!)) {
        throw new Error(`mob ${kind} spawn rule has invalid rarity ${rule.rarity}`);
      }
      if (hasFixedShare && !MOB_SPAWN_FIXED_SHARE_KINDS.includes(kind)) {
        throw new Error(`mob ${kind} may not use a fixed share; give it a rarity`);
      }
      if (hasFixedShare && !(Number.isFinite(rule.fixedShare) && rule.fixedShare! > 0 && rule.fixedShare! < 1)) {
        throw new Error(`mob ${kind} spawn rule fixed share must be between 0 and 1`);
      }
    }
  }
  for (const site of mobSpawnSiteFactCombinations()) {
    let fixedSum = 0;
    let pooled = 0;
    for (const kind of MOB_SPAWN_KINDS) {
      const matched = rulesOf(kind).filter((rule) => mobSpawnRuleMatches(rule, site));
      if (matched.length > 1) {
        throw new Error(`mob spawn rules for ${kind} overlap at ${JSON.stringify(site)}`);
      }
      fixedSum += matched[0]?.fixedShare ?? 0;
      if (matched[0]?.rarity !== undefined) pooled += 1;
    }
    if (fixedSum > 0 && pooled === 0) {
      throw new Error(`mob spawn fixed shares have no rarity pool at ${JSON.stringify(site)}`);
    }
    if (pooled > 0 && fixedSum + MOB_SPAWN_ANIMAL_SHARE >= 1) {
      throw new Error(`mob spawn fixed shares leave no room at ${JSON.stringify(site)}`);
    }
  }
}
