import {
  BASIC_ATTACK_INTERVAL_MS,
  BASIC_ATTACK_RANGE_M,
  RANGED_ATTACK_RANGE_M,
  DEFAULT_FLAG_RESOURCE_VISION_RADIUS_M,
  EQUIPMENT_BALANCE_VERSION,
  EQUIPMENT_LEVEL_CAP,
  MAX_EQUIPMENT_LEVEL,
  ANIMAL_MOB_ARCHETYPES,
  FANTASY_MOB_ARCHETYPES,
  isAnimalMobArchetype,
  isWorldMobTemplateKey,
  MOB_BIOME_VARIANT_FAMILIES,
  MOB_BIOME_VARIANT_FAMILY_BASES,
  MOB_HEALTH_UNIT,
  mobChallengeTier,
  mobMatchup,
  MOB_SPAWN_RULES,
  mobTemplateOf,
  UNIVERSAL_FOOD_DROP_PROBABILITY,
  UNIVERSAL_FOOD_DROP_ROLL_ID,
  universalFoodForMob,
  type AnimalMobArchetype,
  type DeerFamilyArchetype,
  type FantasyMobArchetype,
  type MobChallengeTier,
  type MobArchetypeKey,
  type MobBiomeVariantArchetype,
  type MobMatchup,
  type MobSpawnRarity,
  type ResourceType,
  type WorldMobTemplateKey
} from "@ash-atlas/shared";
import { GOLEM_FORGE_MOB_PACE } from "./golemForgeMobs.js";

export type MobAiIntent = "combat" | "observe";
export type MobAiGroupPropagation = "self" | "exact_pack";
export type MobAiEndDisposition = "return_home" | "idle_current";
export type MobAiProfile = Readonly<{
  proactive: Readonly<{
    intent: MobAiIntent;
    radiusM: number;
    acquisitionDelayMs: number;
  }> | null;
  onAttacked: Readonly<{
    group: MobAiGroupPropagation;
  }> | null;
  movement: Readonly<{
    kind: "attack_range";
  }> | Readonly<{
    kind: "standoff";
    distanceM: number;
    deadbandM: number;
  }>;
  disengagement: Readonly<{
    kind: "engagement_timeout";
  }> | Readonly<{
    kind: "outside_radius";
    radiusM: number;
    graceMs: number;
  }>;
  endDisposition: MobAiEndDisposition;
  countdown: "acquisition" | "disengagement" | null;
}>;
export type MobHabitat = "land" | "lake" | "river" | "ocean";

// Rewards sharing a rollId are weighted outcomes of one roll; unique rollIds remain independent.
export type ChanceBasedItemReward = Readonly<{
  itemId: ResourceType;
  quantity: number;
  probability: number;
  rollId: string;
}>;

// The current Wolf graphic is about 50px wide at the default combat-map zoom.
// This world-space equivalent keeps neighboring pack bodies visibly separate.
export const WOLF_COLLISION_RADIUS_M = 27.5;
export const WOLF_PACK_MINIMUM_SEPARATION_M = WOLF_COLLISION_RADIUS_M * 2;
export const WOLF_PACK_FORMATION_RADIUS_M = 48;
export const WOLF_HOME_TOLERANCE_M = 2;
export const COMBAT_ITEM_REWARD_POLICY_VERSION = 13;
/** V13 added Leatherworking rank 3's chance of double leather (drops unchanged from V11). */
/** V12 made Scavenge roll only on monster item drops, with the aligned pool (drops unchanged from V11). */
/** V11 added the mob value pass drops (MOB_VALUE_DROPS, MOB_VALUE_FEATHER_BASICS). */
/** V10 added the metal material rolls (Umbral Essence, Griffin Plume, Bloom Petal). */
export const METAL_MATERIAL_ROLL_PREFIX = "metal_material:";

function metalMaterialReward(itemId: ResourceType, probability: number): ChanceBasedItemReward {
  return { itemId, quantity: 1, probability, rollId: `${METAL_MATERIAL_ROLL_PREFIX}${itemId}` };
}

/**
 * One roll that drops `min..max` of an item with the given total chance: one
 * entry per quantity sharing a roll id, so the roll picks at most one of them.
 */
function metalMaterialRange(
  itemId: ResourceType,
  probability: number,
  min: number,
  max: number
): ChanceBasedItemReward[] {
  const count = max - min + 1;
  return Array.from({ length: count }, (_, offset) => ({
    itemId,
    quantity: min + offset,
    probability: probability / count,
    rollId: `${METAL_MATERIAL_ROLL_PREFIX}${itemId}`
  }));
}

/** Extra metal-material drops per fantasy mob, replacing any copied from its template. */
const FANTASY_METAL_DROPS: Readonly<Partial<Record<FantasyMobArchetype, readonly ChanceBasedItemReward[]>>> = {
  frost_wraith: [metalMaterialReward("umbral_essence", 0.08)],
  barrow_wight: [metalMaterialReward("umbral_essence", 0.08)],
  bog_ghoul: [metalMaterialReward("umbral_essence", 0.08)],
  dust_mummy: [metalMaterialReward("umbral_essence", 0.08)],
  vine_lurker: [metalMaterialReward("dusk_heart", 0.02), metalMaterialReward("bloom_petal", 0.1)],
  lizardfolk_warrior: [metalMaterialReward("dusk_heart", 0.02)],
  moss_golem: metalMaterialRange("gearwork_essence", 0.25, 2, 4),
  griffin: [...metalMaterialRange("gale_splinter", 0.4, 2, 5), metalMaterialReward("griffin_plume", 0.1)],
  thunderhorn: metalMaterialRange("gale_splinter", 0.4, 2, 5)
};

/**
 * A template mob's own rewards. Its universal food roll (its meat cut, from
 * UNIVERSAL_FOOD_BY_MOB) is added; nothing comes from the template.
 */
export type MobOwnDrops = Readonly<{
  items?: readonly Readonly<{ itemId: ResourceType; quantity: number }>[];
  chanceItems: readonly ChanceBasedItemReward[];
  gold: number;
  cityCoins?: number;
}>;

/** A wave 1 mob's items; its gold and city coins come from waveOneBounty, not a literal. */
type WaveOneDrops = Omit<MobOwnDrops, "gold" | "cityCoins">;

/**
 * Wave 1 gold and city coins: one curve by level, linear between anchors taken
 * from existing mobs (frog 2/0, crab 5/1, deer 10/1, wolf 15/2, hog 23/3,
 * squid 30/3, bear 60/4, serpent jailer 80, ogre 100/5), times the tier's
 * damage multiplier: tier 4 (1.25) x1.5, tier 5 (1.5) x3.
 */
const WAVE_ONE_GOLD_ANCHORS: readonly (readonly [number, number])[] = [
  [0, 2], [1, 5], [2, 10], [5, 15], [8, 23], [12, 30], [15, 60], [20, 80], [25, 100]
];
const WAVE_ONE_COIN_ANCHORS: readonly (readonly [number, number])[] = [
  [0, 0], [1, 1], [2, 1], [5, 2], [8, 3], [12, 3], [15, 4], [25, 5]
];

function anchorValue(anchors: readonly (readonly [number, number])[], level: number): number {
  const last = anchors[anchors.length - 1]!;
  if (level >= last[0]) return last[1];
  const upper = anchors.findIndex(([anchorLevel]) => anchorLevel >= level);
  const [hiLevel, hiValue] = anchors[upper]!;
  if (upper === 0 || hiLevel === level) return hiValue;
  const [loLevel, loValue] = anchors[upper - 1]!;
  return loValue + (hiValue - loValue) * (level - loLevel) / (hiLevel - loLevel);
}

export function waveOneBounty(level: number, damageMultiplier: number): Readonly<{ gold: number; cityCoins: number }> {
  const tier = damageMultiplier >= 1.5 ? 3 : damageMultiplier >= 1.25 ? 1.5 : 1;
  return {
    gold: Math.round(anchorValue(WAVE_ONE_GOLD_ANCHORS, level) * tier),
    cityCoins: Math.round(anchorValue(WAVE_ONE_COIN_ANCHORS, level) * tier)
  };
}

/** One independent roll for `quantity` of an item. */
export function ownDrop(itemId: ResourceType, probability: number, quantity = 1): ChanceBasedItemReward {
  return { itemId, quantity, probability, rollId: `drop:${itemId}` };
}

/** Every new animal's own drops (ANIMAL_MOB_TEMPLATES); a missing key is a compile error. */
const ANIMAL_MOB_DROPS: Readonly<Record<AnimalMobArchetype, WaveOneDrops>> = {
  jungle_tapir: { items: [{ itemId: "leather", quantity: 2 }], chanceItems: [] },
  jaguar: { items: [{ itemId: "leather", quantity: 8 }], chanceItems: [] },
  mandrill: { items: [{ itemId: "leather", quantity: 2 }], chanceItems: [] },
  capercaillie: { chanceItems: [] },
  elk: { items: [{ itemId: "leather", quantity: 8 }], chanceItems: [{ itemId: "deer_hide", quantity: 1, probability: 0.00001, rollId: "rare_hide" }] },
  red_squirrel: { items: [{ itemId: "leather", quantity: 1 }], chanceItems: [] },
  badger: { items: [{ itemId: "leather", quantity: 1 }], chanceItems: [] },
  grey_squirrel: { items: [{ itemId: "leather", quantity: 1 }], chanceItems: [] },
  stag_beetle: { items: [{ itemId: "chitin", quantity: 1 }], chanceItems: [] },
  great_grey_owl: { chanceItems: [] },
  flying_squirrel: { chanceItems: [] },
  plains_bison: { items: [{ itemId: "leather", quantity: 8 }], chanceItems: [] },
  prairie_dog: { items: [{ itemId: "leather", quantity: 1 }], chanceItems: [] },
  burrowing_owl: { chanceItems: [] },
  giraffe: { items: [{ itemId: "leather", quantity: 15 }], chanceItems: [] },
  lioness: { items: [{ itemId: "leather", quantity: 8 }], chanceItems: [] },
  spotted_hyena: { items: [{ itemId: "leather", quantity: 2 }], chanceItems: [] },
  sitatunga: { items: [{ itemId: "leather", quantity: 2 }], chanceItems: [] },
  emperor_dragonfly: { chanceItems: [ownDrop("chitin", 0.5)] },
  mountain_ibex: { items: [{ itemId: "leather", quantity: 2 }], chanceItems: [] },
  wild_yak: { items: [{ itemId: "leather", quantity: 8 }], chanceItems: [] },
  alpine_marmot: { items: [{ itemId: "leather", quantity: 1 }], chanceItems: [] },
  wild_scrub_goat: { items: [{ itemId: "leather", quantity: 2 }], chanceItems: [] },
  crested_porcupine: { items: [{ itemId: "leather", quantity: 1 }], chanceItems: [] },
  spur_thighed_tortoise: { items: [{ itemId: "chitin", quantity: 2 }], chanceItems: [] },
  dromedary: { items: [{ itemId: "leather", quantity: 8 }], chanceItems: [] },
  fennec_fox: { items: [{ itemId: "leather", quantity: 1 }], chanceItems: [] },
  sidewinder: { chanceItems: [ownDrop("chitin", 0.5)] },
  desert_lion: { items: [{ itemId: "leather", quantity: 8 }], chanceItems: [] },
  saiga: { items: [{ itemId: "leather", quantity: 2 }], chanceItems: [] },
  wild_horse: { items: [{ itemId: "leather", quantity: 8 }], chanceItems: [] },
  steppe_marmot: { items: [{ itemId: "leather", quantity: 1 }], chanceItems: [] },
  lemming: { items: [{ itemId: "leather", quantity: 1 }], chanceItems: [] },
  snow_goose: { chanceItems: [] },
  emperor_penguin: { chanceItems: [] },
  peary_caribou: { items: [{ itemId: "leather", quantity: 2 }], chanceItems: [] },
  ice_worm: { chanceItems: [ownDrop("chitin", 0.5)] },
  sea_otter: { chanceItems: [ownDrop("leather", 0.5)] },
  herring_gull: { chanceItems: [] },
  spiny_lobster: { items: [{ itemId: "chitin", quantity: 1 }], chanceItems: [] },
  hammerhead_shark: { items: [{ itemId: "leather", quantity: 8 }, { itemId: "bone", quantity: 2 }], chanceItems: [] },
  manta_ray: { items: [{ itemId: "leather", quantity: 8 }], chanceItems: [] },
  humpback_whale: { items: [{ itemId: "crude_oil", quantity: 2 }, { itemId: "bone", quantity: 5 }], chanceItems: [] },
  muskellunge: { items: [{ itemId: "freshwater_fish", quantity: 2 }], chanceItems: [] },
  mute_swan: { chanceItems: [] },
  northern_pike: { items: [{ itemId: "freshwater_fish", quantity: 1 }], chanceItems: [] },
  snapping_turtle: { items: [{ itemId: "chitin", quantity: 3 }], chanceItems: [] },
  beaver: { chanceItems: [ownDrop("leather", 0.5)] },
  river_otter: { chanceItems: [ownDrop("leather", 0.5)] },
  river_salmon: { items: [{ itemId: "freshwater_fish", quantity: 1 }], chanceItems: [] },
  // The Mammoth Cut is legendary meat (the Patriarch's), so a common Mammoth only sometimes yields one.
  woolly_mammoth: { items: [{ itemId: "leather", quantity: 15 }], chanceItems: [ownDrop("mammoth_cut", 0.15), ownDrop("fur_pelt", 0.6), ownDrop("mammoth_tusk", 0.2)] },
  // Biome roster phase C.
  field_hare: { items: [{ itemId: "leather", quantity: 1 }], chanceItems: [] },
  arctic_hare: { items: [{ itemId: "leather", quantity: 1 }], chanceItems: [] },
  capybara: { items: [{ itemId: "leather", quantity: 2 }], chanceItems: [] },
  armadillo: { items: [{ itemId: "leather", quantity: 1 }], chanceItems: [ownDrop("chitin", 0.3)] },
  red_fox: { items: [{ itemId: "leather", quantity: 1 }], chanceItems: [] },
  wolverine: { items: [{ itemId: "leather", quantity: 2 }], chanceItems: [] },
  ostrich: { items: [{ itemId: "leather", quantity: 2 }], chanceItems: [] },
  golden_eagle: { chanceItems: [] },
  musk_ox: { items: [{ itemId: "leather", quantity: 8 }], chanceItems: [] },
  seal: { items: [{ itemId: "leather", quantity: 2 }], chanceItems: [] }
};

/** The first fantasy mobs: they keep their template's drops plus FANTASY_METAL_DROPS. */
const TEMPLATE_DROP_FANTASY_MOBS = [
  "frost_wraith", "yeti", "barrow_wight", "moss_golem", "vine_lurker", "lizardfolk_warrior",
  "bog_ghoul", "giant_scorpion", "dust_mummy", "thunderhorn", "griffin", "basilisk",
  "risen_skeleton", "revenant_lich"
] as const satisfies readonly FantasyMobArchetype[];
type TemplateDropFantasyMob = (typeof TEMPLATE_DROP_FANTASY_MOBS)[number];

/**
 * Every other fantasy mob's own drop list, replacing its template's drops
 * entirely; a missing key is a compile error.
 */
const FANTASY_MOB_DROPS: Readonly<Record<Exclude<FantasyMobArchetype, TemplateDropFantasyMob>, WaveOneDrops>> = {
  canopy_goblin: { chanceItems: [ownDrop("cloth", 0.3)] },
  poisonfrog_raider: { chanceItems: [metalMaterialReward("dusk_heart", 0.02)] },
  pantherfolk_stalker: { items: [{ itemId: "leather", quantity: 4 }], chanceItems: [] },
  vine_wrapped_corpse: { chanceItems: [ownDrop("bone", 0.5, 4), metalMaterialReward("umbral_essence", 0.08), metalMaterialReward("bloom_petal", 0.05)] },
  serpent_priestess: { chanceItems: [metalMaterialReward("dusk_heart", 0.05), ownDrop("jellyfish_venom", 0.1)] },
  bugbear_chieftain: { items: [{ itemId: "leather", quantity: 15 }], chanceItems: [ownDrop("iron", 0.3)] },
  pinewarden: { items: [{ itemId: "stone", quantity: 1 }], chanceItems: [ownDrop("wood", 0.6, 2), ownDrop("balsam_resin", 0.5, 2)] },
  gallows_ghost: { chanceItems: [ownDrop("bone", 0.5, 4), metalMaterialReward("umbral_essence", 0.08)] },
  alder_king: { chanceItems: [ownDrop("cloth", 0.8, 2), metalMaterialReward("umbral_essence", 0.15)] },
  pine_dryad: { items: [{ itemId: "wood", quantity: 2 }, { itemId: "balsam_resin", quantity: 1 }], chanceItems: [] },
  mossjaw_sneak: { chanceItems: [ownDrop("cloth", 0.4)] },
  mossjaw_spearman: { chanceItems: [ownDrop("wood", 0.5)] },
  mossjaw_hexer: { chanceItems: [metalMaterialReward("umbral_essence", 0.05)] },
  mossjaw_warboss: { chanceItems: [ownDrop("iron", 0.4), ownDrop("crystal", 0.2)] },
  hedge_witch: { chanceItems: [ownDrop("thistle", 0.3), ownDrop("lichen", 0.3)] },
  restless_gravedigger: { chanceItems: [ownDrop("bone", 0.5, 4), metalMaterialReward("umbral_essence", 0.08)] },
  coven_matron: { chanceItems: [metalMaterialReward("umbral_essence", 0.2), ownDrop("thistle", 0.5, 2)] },
  stagfolk_warden: { chanceItems: [ownDrop("leather", 0.4, 2)] },
  rime_witch: { chanceItems: [ownDrop("lichen", 0.3)] },
  draugr_berserker: { chanceItems: [ownDrop("bone", 0.5, 4), metalMaterialReward("umbral_essence", 0.08), ownDrop("leather", 0.4)] },
  snow_talonbear: { items: [{ itemId: "leather", quantity: 15 }], chanceItems: [] },
  frostwater_troll: { items: [{ itemId: "leather", quantity: 8 }], chanceItems: [] },
  underice_lurker: { chanceItems: [ownDrop("crude_oil", 0.05)] },
  centaur_outrider: { items: [{ itemId: "leather", quantity: 8 }], chanceItems: [] },
  volt_elemental: { items: [{ itemId: "stone", quantity: 1 }], chanceItems: [...metalMaterialRange("gale_splinter", 0.4, 2, 5), ownDrop("iron", 0.15)] },
  possessed_scythe: { chanceItems: [ownDrop("bone", 0.5, 4), metalMaterialReward("umbral_essence", 0.08), ownDrop("iron", 0.3), ownDrop("wood", 0.4)] },
  strawman_lord: { chanceItems: [ownDrop("flax_fiber", 1, 3), metalMaterialReward("umbral_essence", 0.1)] },
  gnoll_bonebow: { chanceItems: [ownDrop("bone", 0.4)] },
  gnoll_packseer: { chanceItems: [metalMaterialReward("umbral_essence", 0.05)] },
  gnoll_packlord: { chanceItems: [ownDrop("bone", 0.6, 3), ownDrop("iron", 0.3)] },
  carrion_ghoul: { chanceItems: [ownDrop("bone", 0.5, 4), metalMaterialReward("umbral_essence", 0.08)] },
  sun_griffin: { items: [{ itemId: "leather", quantity: 2 }], chanceItems: [...metalMaterialRange("gale_splinter", 0.4, 2, 5), metalMaterialReward("griffin_plume", 0.1)] },
  frogfolk_tadpole: { chanceItems: [] },
  frogfolk_blowgunner: { chanceItems: [ownDrop("flax_fiber", 0.5)] },
  frogfolk_shaman: { chanceItems: [metalMaterialReward("bloom_petal", 0.1), ownDrop("crystal", 0.05)] },
  frogfolk_chief: { chanceItems: [ownDrop("crystal", 0.3), metalMaterialReward("bloom_petal", 0.2)] },
  bloat_leech: { chanceItems: [] },
  bog_hag: { chanceItems: [ownDrop("cloth", 0.4), metalMaterialReward("bloom_petal", 0.1)] },
  leech_mother: { items: [{ itemId: "crude_oil", quantity: 4 }], chanceItems: [] },
  yakfolk_stonehorn: { items: [{ itemId: "leather", quantity: 8 }], chanceItems: [ownDrop("iron", 0.3)] },
  highland_reaver: { chanceItems: [ownDrop("cloth", 0.5), ownDrop("iron", 0.3)] },
  storm_harpy: { items: [{ itemId: "leather", quantity: 2 }], chanceItems: [...metalMaterialRange("gale_splinter", 0.4, 2, 5)] },
  cairn_wight: { chanceItems: [ownDrop("bone", 0.5, 4), metalMaterialReward("umbral_essence", 0.08)] },
  stormwing_chick: { chanceItems: [...metalMaterialRange("gale_splinter", 0.2, 1, 2)] },
  stormwing: { items: [{ itemId: "griffin_plume", quantity: 1 }], chanceItems: [...metalMaterialRange("gale_splinter", 1, 5, 10)] },
  cyclops_shepherd: { items: [{ itemId: "stone", quantity: 1 }], chanceItems: [ownDrop("leather", 0.4, 2)] },
  skeleton_hoplite: { chanceItems: [ownDrop("bone", 0.5, 4), metalMaterialReward("umbral_essence", 0.08)] },
  tar_elemental: { chanceItems: [ownDrop("crude_oil", 0.5)] },
  olive_dryad: { items: [{ itemId: "wood", quantity: 2 }, { itemId: "balsam_resin", quantity: 1 }], chanceItems: [] },
  chimera: { items: [{ itemId: "leather", quantity: 15 }, { itemId: "sulfur", quantity: 2 }], chanceItems: [] },
  jackalfolk_skirmisher: { chanceItems: [ownDrop("leather", 0.4)] },
  dune_goblin: { chanceItems: [ownDrop("leather", 0.4), ownDrop("crystal", 0.05)] },
  desert_marauder: { chanceItems: [ownDrop("cloth", 0.5)] },
  scorch_troll: { chanceItems: [ownDrop("sulfur", 0.2)] },
  ember_giant: { items: [{ itemId: "sulfur", quantity: 3 }, { itemId: "coal", quantity: 3 }, { itemId: "crystal", quantity: 1 }], chanceItems: [] },
  steppe_raider: { chanceItems: [ownDrop("leather", 0.4)] },
  steppe_horse_archer: { chanceItems: [ownDrop("leather", 0.4)] },
  salt_husk: { chanceItems: [ownDrop("bone", 0.5, 4), metalMaterialReward("umbral_essence", 0.08), ownDrop("crystal", 0.1)] },
  kurgan_wight: { chanceItems: [ownDrop("bone", 0.5, 4), metalMaterialReward("umbral_essence", 0.08)] },
  centaur_khan: { items: [{ itemId: "leather", quantity: 15 }, { itemId: "iron", quantity: 3 }], chanceItems: [] },
  frostborn_runecaster: { chanceItems: [ownDrop("crystal", 0.15)] },
  frostborn_jarl: { chanceItems: [ownDrop("iron", 0.5, 2), ownDrop("leather", 0.5, 2)] },
  permafrost_elemental: { items: [{ itemId: "stone", quantity: 1 }], chanceItems: [ownDrop("stone", 0.8, 2), ...metalMaterialRange("gearwork_essence", 0.25, 2, 4)] },
  draugr: { chanceItems: [ownDrop("bone", 0.5, 4), metalMaterialReward("umbral_essence", 0.08)] },
  mammoth_patriarch: { items: [{ itemId: "leather", quantity: 30 }, { itemId: "bone", quantity: 10 }], chanceItems: [] },
  rime_troll: { chanceItems: [ownDrop("leather", 0.4)] },
  aurora_shade: { chanceItems: [ownDrop("bone", 0.5, 4), metalMaterialReward("umbral_essence", 0.15)] },
  blizzard_lord: { items: [{ itemId: "crystal", quantity: 2 }], chanceItems: [...metalMaterialRange("gearwork_essence", 1, 4, 8)] },
  gillfolk_scout: { items: [{ itemId: "crab_carapace", quantity: 1 }], chanceItems: [] },
  gillfolk_netter: { items: [{ itemId: "flax_fiber", quantity: 3 }], chanceItems: [] },
  coral_golem: { items: [{ itemId: "stone", quantity: 1 }], chanceItems: [...metalMaterialRange("gearwork_essence", 0.25, 2, 4), ownDrop("pearl", 0.05)] },
  drowned_deckhand: { chanceItems: [ownDrop("bone", 0.5, 4), metalMaterialReward("umbral_essence", 0.08)] },
  reef_kraken: { chanceItems: [ownDrop("crude_oil", 0.05)] },
  merfolk_harpooner: { items: [{ itemId: "chitin", quantity: 2 }], chanceItems: [ownDrop("pearl", 0.05)] },
  phantom_lookout: { chanceItems: [ownDrop("bone", 0.5, 4), metalMaterialReward("umbral_essence", 0.1)] },
  maelstrom_spirit: { items: [{ itemId: "stone", quantity: 1 }], chanceItems: [...metalMaterialRange("gale_splinter", 0.4, 2, 5)] },
  sea_serpent: { items: [{ itemId: "chitin", quantity: 8 }], chanceItems: [] },
  kraken: { items: [{ itemId: "crude_oil", quantity: 4 }, { itemId: "pearl", quantity: 1 }], chanceItems: [] },
  drowned_bride: { chanceItems: [ownDrop("bone", 0.5, 4), metalMaterialReward("umbral_essence", 0.15), ownDrop("pearl", 0.05)] },
  lake_maiden: { chanceItems: [ownDrop("pearl", 0.15)] },
  elder_mere_serpent: { items: [{ itemId: "chitin", quantity: 20 }, { itemId: "pearl", quantity: 2 }], chanceItems: [] },
  drowned_thrall: { chanceItems: [ownDrop("bone", 0.5, 4), metalMaterialReward("umbral_essence", 0.08), ownDrop("cloth", 0.6)] },
  kappa: { chanceItems: [ownDrop("chitin", 0.3), ownDrop("freshwater_fish", 0.3)] },
  kappa_brawler: { chanceItems: [ownDrop("chitin", 0.5)] },
  bridge_troll: { items: [{ itemId: "leather", quantity: 15 }, { itemId: "stone", quantity: 2 }], chanceItems: [] },
  nixie: { chanceItems: [ownDrop("pearl", 0.05)] },
  rapids_elemental: { items: [{ itemId: "stone", quantity: 1 }], chanceItems: [...metalMaterialRange("gearwork_essence", 0.25, 2, 4)] },
  // Water game phase B (docs/design/WATER_GAME_PLAN.md, decisions 4 and 9).
  shellback: { items: [{ itemId: "shellback_plate", quantity: 2 }], chanceItems: [] },
  darter: { chanceItems: [ownDrop("shellback_plate", 0.15)] },
  ink_pool: { items: [{ itemId: "crude_oil", quantity: 1 }], chanceItems: [] },
  drowned_citizen: { chanceItems: [] },
  tide_wraith: { chanceItems: [ownDrop("abyssal_orb", 0.02)] },
  gate_warden: { chanceItems: [ownDrop("abyssal_orb", 0.05)] },
  drowned_cultist: { chanceItems: [] },
  // Overworld bestiary additions (drop rates from the bestiary drop set).
  dire_wolf: { chanceItems: [ownDrop("dire_wolf_pelt", 0.6), ownDrop("fang", 0.5)] },
  moss_troll: { chanceItems: [ownDrop("troll_gristle", 0.6), ownDrop("troll_tooth", 0.3), ownDrop("wood", 0.4)] },
  ash_drake: { chanceItems: [ownDrop("drake_scale", 0.9), ownDrop("drake_tail_spike", 0.12), ownDrop("reptile_scale", 0.3)] },
  ember_dragon: { items: [{ itemId: "ember_scale", quantity: 3 }], chanceItems: [ownDrop("fire_gland", 0.35), ownDrop("ember_dragon_horn", 0.02)] },
  snapjaw_flytrap: { chanceItems: [ownDrop("snapjaw_nectar", 0.6), ownDrop("flax_fiber", 0.3)] },
  // The Giant Larva drops only its own Grub Meat (food roll); rings come from the generic ring drop by spawn rarity.
  giant_larva: { chanceItems: [] },
  cairn_golem: { chanceItems: [ownDrop("golem_heartstone", 0.4), ownDrop("stone", 0.9, 3)] },
  // Drowned City raid: orbs come from the raid's chests (guaranteed 2+2+2+4), not mob rolls.
  tide_wraith_dc: { chanceItems: [] },
  darter_dc: { chanceItems: [ownDrop("shellback_plate", 0.15)] },
  ink_pool_dc: { items: [{ itemId: "crude_oil", quantity: 1 }], chanceItems: [] },
  drowned_cultist_dc: { chanceItems: [] },
  shellback_dc: { items: [{ itemId: "shellback_plate", quantity: 2 }], chanceItems: [] },
  coral_golem_dc: { items: [{ itemId: "stone", quantity: 1 }], chanceItems: [ownDrop("pearl", 0.05)] },
  drowned_deckhand_dc: { chanceItems: [ownDrop("bone", 0.5, 4)] },
  phantom_lookout_dc: { chanceItems: [ownDrop("bone", 0.5, 4)] },
  merfolk_harpooner_dc: { items: [{ itemId: "chitin", quantity: 2 }], chanceItems: [ownDrop("pearl", 0.05)] },
  gate_warden_dc: { chanceItems: [] },
  void_wisp: { chanceItems: [metalMaterialReward("umbral_essence", 0.1)] },
  deep_crawler: { items: [{ itemId: "chitin", quantity: 2 }], chanceItems: [] },
  maw_lily: { chanceItems: [metalMaterialReward("bloom_petal", 0.15)] },
  chrono_wisp: { chanceItems: [ownDrop("crystal", 0.1)] },
  abyssal_cultist: { chanceItems: [] },
  // Golem Forge: golems drop a little Shard Grit; Amulet Clasps and Sparks come from the boss chests.
  iron_golem_gf: { chanceItems: [ownDrop("shard_grit", 0.08)] },
  stone_golem_gf: { items: [{ itemId: "stone", quantity: 2 }], chanceItems: [ownDrop("shard_grit", 0.08)] },
  geode_golem_gf: { chanceItems: [ownDrop("shard_grit", 0.15)] },
  mender_golem_gf: { chanceItems: [ownDrop("shard_grit", 0.08)] },
  sentinel_statue_gf: { chanceItems: [ownDrop("shard_grit", 0.08)] },
  spark_wisp_gf: { chanceItems: [] },
  slag_crawler_gf: { items: [{ itemId: "chitin", quantity: 1 }], chanceItems: [] },
  golem_smith_gf: { chanceItems: [] },
  corrupted_husk_gf: { chanceItems: [] },
  gem_husk_gf: { chanceItems: [] },
  walking_hammer_gf: { chanceItems: [] },
  healer_monolith_gf: { chanceItems: [] }
};

/**
 * Mob value pass (step B1): every overworld mob's regional, signature and
 * trophy items (MOB-VALUE-AND-UNLOCKS section 9), each its own independent
 * roll. The chance already includes the elite/boss doubling and trophy rules.
 * Applied to the finished definitions, so each biome variant and template mob
 * lists its own and nothing leaks through a template.
 */
const MOB_VALUE_DROPS: Readonly<Partial<Record<MobArchetypeKey, readonly ChanceBasedItemReward[]>>> = {
  blizzard_lord: [ownDrop("glacier_heart", 0.2)],
  centaur_khan: [ownDrop("centaur_horsehair", 0.24), ownDrop("centaur_khan_banner", 0.2), ownDrop("ancient_coin", 0.24)],
  elder_mere_serpent: [ownDrop("elder_serpent_horn", 0.2)],
  ember_giant: [ownDrop("ember_giant_heart_coal", 0.2), ownDrop("crude_gem", 0.24)],
  mammoth_patriarch: [ownDrop("fur_pelt", 0.24), ownDrop("patriarch_tusk", 0.2)],
  stormwing: [ownDrop("stormwing_talon", 0.2)],
  alder_king: [ownDrop("fey_silk", 0.2), ownDrop("alder_kings_horn", 0.05), ownDrop("mana_shard", 0.24)],
  bridge_troll: [ownDrop("river_troll_hide", 0.12), ownDrop("troll_toll_bell", 0.05)],
  chimera: [ownDrop("horn", 0.24), ownDrop("chimera_flame_gland", 0.2), ownDrop("chimera_horn", 0.05)],
  coven_matron: [ownDrop("coven_matron_hat", 0.05), ownDrop("mana_shard", 0.24), ownDrop("monster_eye", 0.12)],
  frogfolk_chief: [ownDrop("crude_gem", 0.24), ownDrop("frogking_crown", 0.05)],
  frostborn_jarl: [ownDrop("frostborn_jarl_helm", 0.05), ownDrop("fur_pelt", 0.24), ownDrop("ancient_coin", 0.24)],
  gnoll_packlord: [ownDrop("gnoll_packlord_mask", 0.05), ownDrop("fang", 0.24)],
  kraken: [ownDrop("kraken_ink", 0.12), ownDrop("kraken_beak", 0.05)],
  leech_mother: [ownDrop("leech_blood_sac", 0.24), ownDrop("leech_mother_maw", 0.05)],
  mossjaw_warboss: [ownDrop("mossjaw_warboss_helm", 0.05), ownDrop("crude_gem", 0.24)],
  serpent_priestess: [ownDrop("serpent_priestess_crown", 0.05), ownDrop("venom_sac", 0.24)],
  strawman_lord: [ownDrop("feather", 0.5), ownDrop("crow_crown", 0.05)],
  coral_golem: [ownDrop("coral_heartstone", 0.06)],
  cyclops_shepherd: [ownDrop("cyclops_eye_lens", 0.06), ownDrop("animal_fat", 0.25)],
  moss_golem: [ownDrop("earthen_core", 0.06)],
  ogre: [ownDrop("troll_gristle", 0.06)],
  permafrost_elemental: [ownDrop("earthen_core", 0.06)],
  pinewarden: [ownDrop("living_heartwood", 0.06)],
  rapids_elemental: [ownDrop("river_essence", 0.06), ownDrop("riverheart_stone", 0.06)],
  volt_elemental: [ownDrop("charged_core", 0.06)],
  orc_brute: [ownDrop("scrap_metal", 0.12)],
  rime_troll: [ownDrop("troll_gristle", 0.06), ownDrop("troll_tooth", 0.06), ownDrop("fur_pelt", 0.12)],
  scorch_troll: [ownDrop("troll_gristle", 0.06), ownDrop("troll_tooth", 0.06)],
  alligator: [ownDrop("reptile_scale", 0.12)],
  bear: [ownDrop("fur_pelt", 0.12), ownDrop("claw", 0.12)],
  black_bear: [ownDrop("fur_pelt", 0.12), ownDrop("claw", 0.12)],
  bugbear_chieftain: [ownDrop("bugbear_shag_pelt", 0.06), ownDrop("fang", 0.12)],
  caiman: [ownDrop("reptile_scale", 0.12)],
  crocodile: [ownDrop("reptile_scale", 0.12)],
  frostwater_troll: [ownDrop("river_troll_hide", 0.06)],
  hammerhead_shark: [ownDrop("shark_tooth", 0.06)],
  jaguar: [ownDrop("jaguar_pelt", 0.06), ownDrop("fang", 0.12)],
  pantherfolk_stalker: [ownDrop("pantherfolk_rosette_hide", 0.06), ownDrop("claw", 0.12), ownDrop("fine_fur", 0.25)],
  sea_serpent: [ownDrop("fang", 0.12)],
  snow_bear: [ownDrop("fur_pelt", 0.12), ownDrop("claw", 0.12)],
  snow_talonbear: [ownDrop("talonbear_pelt", 0.06), ownDrop("down_feather", 0.25)],
  sun_bear: [ownDrop("fur_pelt", 0.12), ownDrop("claw", 0.12)],
  thunderhorn: [ownDrop("horn", 0.12)],
  yeti: [ownDrop("fur_pelt", 0.12)],
  humpback_whale: [ownDrop("blubber", 0.25)],
  stormwing_chick: [ownDrop("down_feather", 0.25)],
  aurora_shade: [ownDrop("mana_shard", 0.12)],
  drowned_bride: [ownDrop("drowned_locket", 0.12)],
  kappa: [ownDrop("kappa_shell_plate", 0.12)],
  kappa_brawler: [ownDrop("kappa_shell_plate", 0.12), ownDrop("sinew", 0.12)],
  snapping_turtle: [ownDrop("snapper_shell", 0.12), ownDrop("reptile_scale", 0.12)],
  spur_thighed_tortoise: [ownDrop("tortoise_scute", 0.12), ownDrop("small_egg", 0.12)],
  bandit: [ownDrop("ancient_coin", 0.12)],
  bog_hag: [ownDrop("poison_gland", 0.25)],
  desert_marauder: [ownDrop("marauder_sand_veil", 0.12)],
  frogfolk_shaman: [ownDrop("mana_shard", 0.12), ownDrop("crude_gem", 0.12)],
  frostborn_runecaster: [ownDrop("rune_fragment", 0.06)],
  gnoll_packseer: [ownDrop("monster_eye", 0.06)],
  mossjaw_hexer: [ownDrop("mana_shard", 0.12)],
  stagfolk_warden: [ownDrop("antler", 0.25), ownDrop("fine_fur", 0.25)],
  steppe_horse_archer: [ownDrop("steppe_horsehair_tassel", 0.12), ownDrop("feather", 0.25), ownDrop("sinew", 0.12)],
  steppe_raider: [ownDrop("steppe_horsehair_tassel", 0.12)],
  lake_maiden: [ownDrop("lakeglass_tear", 0.06), ownDrop("mana_shard", 0.12)],
  reef_kraken: [ownDrop("kraken_ink", 0.06)],
  tar_elemental: [ownDrop("tar_lump", 0.12)],
  underice_lurker: [ownDrop("fang", 0.12)],
  canopy_goblin: [ownDrop("goblin_scrap_charm", 0.25), ownDrop("feather", 0.25), ownDrop("poison_gland", 0.25)],
  dune_goblin: [ownDrop("goblin_scrap_charm", 0.25), ownDrop("crude_gem", 0.12)],
  frogfolk_blowgunner: [ownDrop("reed_blowdart", 0.12), ownDrop("poison_gland", 0.25)],
  gnoll_bonebow: [ownDrop("feather", 0.25)],
  poisonfrog_raider: [ownDrop("poison_gland", 0.25)],
  rime_witch: [ownDrop("mana_shard", 0.12)],
  basilisk: [ownDrop("reptile_scale", 0.12)],
  centaur_outrider: [ownDrop("centaur_horsehair", 0.12)],
  giant_scorpion: [ownDrop("venom_sac", 0.12)],
  gillfolk_netter: [ownDrop("fish_scale", 0.25)],
  merfolk_harpooner: [ownDrop("merfolk_scale", 0.12), ownDrop("merfolk_spearhead", 0.12)],
  olive_dryad: [ownDrop("dryad_heartwood", 0.12), ownDrop("dryad_blossom", 0.12)],
  pine_dryad: [ownDrop("dryad_heartwood", 0.12), ownDrop("dryad_blossom", 0.12)],
  yakfolk_stonehorn: [ownDrop("yakfolk_wool_bundle", 0.12), ownDrop("horn", 0.12)],
  barrow_wight: [ownDrop("barrow_torc", 0.12), ownDrop("ancient_coin", 0.12)],
  bog_ghoul: [ownDrop("grave_cloth", 0.12)],
  cairn_wight: [ownDrop("fur_pelt", 0.12), ownDrop("barrow_torc", 0.12)],
  carrion_ghoul: [ownDrop("fang", 0.12)],
  draugr: [ownDrop("rimed_draugr_mail", 0.12), ownDrop("ancient_coin", 0.12)],
  draugr_berserker: [ownDrop("rimed_draugr_mail", 0.12), ownDrop("fur_pelt", 0.12)],
  drowned_deckhand: [ownDrop("drowned_compass", 0.12)],
  drowned_thrall: [ownDrop("drowned_locket", 0.12)],
  dust_mummy: [ownDrop("grave_cloth", 0.12)],
  frost_wraith: [ownDrop("ectoplasm", 0.12)],
  gallows_ghost: [ownDrop("hangmans_rope", 0.12)],
  kurgan_wight: [ownDrop("barrow_torc", 0.12), ownDrop("ancient_coin", 0.12)],
  lizardfolk_warrior: [ownDrop("reptile_scale", 0.12)],
  possessed_scythe: [ownDrop("reaper_shard", 0.12), ownDrop("scrap_metal", 0.12)],
  skeleton: [ownDrop("ancient_coin", 0.12)],
  skeleton_hoplite: [ownDrop("ancient_coin", 0.12), ownDrop("rusted_legion_blade", 0.12)],
  vine_wrapped_corpse: [ownDrop("grave_vine", 0.25)],
  griffin: [ownDrop("feather", 0.25)],
  storm_harpy: [ownDrop("harpy_plume", 0.06), ownDrop("feather", 0.25)],
  sun_griffin: [ownDrop("feather", 0.25), ownDrop("fine_fur", 0.25)],
  great_grey_owl: [ownDrop("owl_feather", 0.25), ownDrop("down_feather", 0.25)],
  squid: [ownDrop("kraken_ink", 0.06)],
  badger: [ownDrop("fur_pelt", 0.12), ownDrop("claw", 0.12)],
  beaver: [ownDrop("beaver_pelt", 0.12)],
  crested_porcupine: [ownDrop("quill", 0.12)],
  elk: [ownDrop("antler", 0.25)],
  giraffe: [ownDrop("sinew", 0.12)],
  hog: [ownDrop("animal_fat", 0.25)],
  javelina: [ownDrop("animal_fat", 0.25)],
  jungle_hog: [ownDrop("animal_fat", 0.25)],
  jungle_tapir: [ownDrop("animal_fat", 0.25)],
  mud_hog: [ownDrop("animal_fat", 0.25)],
  muskellunge: [ownDrop("fish_scale", 0.25), ownDrop("fang", 0.12)],
  northern_pike: [ownDrop("fish_scale", 0.25), ownDrop("fang", 0.12)],
  plains_bison: [ownDrop("horn", 0.12)],
  warthog: [ownDrop("animal_fat", 0.25)],
  wild_yak: [ownDrop("horn", 0.12)],
  woolly_hog: [ownDrop("animal_fat", 0.25)],
  bog_wolf: [ownDrop("fang", 0.12)],
  desert_lion: [ownDrop("fur_pelt", 0.12), ownDrop("lion_mane", 0.06), ownDrop("claw", 0.12)],
  dune_wolf: [ownDrop("fang", 0.12)],
  frost_wolf: [ownDrop("fang", 0.12)],
  jungle_wolf: [ownDrop("fang", 0.12)],
  lioness: [ownDrop("fur_pelt", 0.12), ownDrop("fang", 0.12), ownDrop("claw", 0.12)],
  mandrill: [ownDrop("fur_pelt", 0.12), ownDrop("fang", 0.12)],
  spotted_hyena: [ownDrop("fur_pelt", 0.12), ownDrop("fang", 0.12)],
  wolf: [ownDrop("fang", 0.12)],
  capercaillie: [ownDrop("feather", 0.25)],
  deer: [ownDrop("antler", 0.25)],
  emperor_penguin: [ownDrop("down_feather", 0.25), ownDrop("blubber", 0.25)],
  frost_deer: [ownDrop("antler", 0.25)],
  jungle_deer: [ownDrop("antler", 0.25)],
  marsh_deer: [ownDrop("antler", 0.25)],
  mountain_ibex: [ownDrop("ibex_horn", 0.12)],
  mute_swan: [ownDrop("down_feather", 0.25), ownDrop("feather", 0.25)],
  peary_caribou: [ownDrop("fine_fur", 0.25), ownDrop("antler", 0.25)],
  river_otter: [ownDrop("otter_pelt", 0.12), ownDrop("fine_fur", 0.25)],
  saiga: [ownDrop("horn", 0.12)],
  sand_deer: [ownDrop("antler", 0.25)],
  sitatunga: [ownDrop("horn", 0.12)],
  snow_goose: [ownDrop("down_feather", 0.25), ownDrop("large_egg", 0.12)],
  wild_horse: [ownDrop("sinew", 0.12)],
  wild_scrub_goat: [ownDrop("horn", 0.12)],
  bloat_leech: [ownDrop("leech_blood_sac", 0.12), ownDrop("slime_gel", 0.25)],
  emperor_dragonfly: [ownDrop("insect_wing", 0.12)],
  gillfolk_scout: [ownDrop("fish_scale", 0.25)],
  stag_beetle: [ownDrop("beetle_carapace", 0.12)],
  vine_lurker: [ownDrop("grave_vine", 0.25)],
  alpine_marmot: [ownDrop("fine_fur", 0.25), ownDrop("animal_fat", 0.25)],
  burrowing_owl: [ownDrop("owl_feather", 0.25)],
  desert_toad: [ownDrop("slime_gel", 0.25)],
  fennec_fox: [ownDrop("fine_fur", 0.25)],
  flying_squirrel: [ownDrop("fine_fur", 0.25)],
  frog: [ownDrop("slime_gel", 0.25)],
  frogfolk_tadpole: [ownDrop("slime_gel", 0.25)],
  frost_frog: [ownDrop("slime_gel", 0.25)],
  grey_squirrel: [ownDrop("fine_fur", 0.25), ownDrop("cached_nuts", 0.25)],
  herring_gull: [ownDrop("feather", 0.25)],
  lemming: [ownDrop("fine_fur", 0.25)],
  nixie: [ownDrop("nixie_comb", 0.12)],
  poison_frog: [ownDrop("poison_gland", 0.25)],
  prairie_dog: [ownDrop("fine_fur", 0.25)],
  red_squirrel: [ownDrop("fine_fur", 0.25), ownDrop("cached_nuts", 0.25)],
  river_salmon: [ownDrop("fish_scale", 0.25)],
  sea_otter: [ownDrop("fine_fur", 0.25)],
  sidewinder: [ownDrop("reptile_scale", 0.12), ownDrop("venom_sac", 0.12)],
  steppe_marmot: [ownDrop("fine_fur", 0.25), ownDrop("animal_fat", 0.25)]
};

/** Birds now drop the generic Feathers basic (`feather`) on every kill. */
const MOB_VALUE_FEATHER_BASICS: Readonly<Partial<Record<MobArchetypeKey, number>>> = {
  great_grey_owl: 2,
  capercaillie: 1,
  emperor_penguin: 1,
  mute_swan: 2,
  snow_goose: 1,
  burrowing_owl: 1,
  herring_gull: 1
};

/** Every roll id and guaranteed item the mob value pass added (V11), for legacy policy replay. */
export const MOB_VALUE_DROP_ROLL_IDS: ReadonlySet<string> = new Set(
  Object.values(MOB_VALUE_DROPS).flatMap((rewards) => (rewards ?? []).map((reward) => reward.rollId))
);
export const MOB_VALUE_BASIC_ITEM_IDS: ReadonlySet<ResourceType> = new Set(["feather"]);

function withMobValueDrops(
  definitions: Record<MobArchetypeKey, MobDefinition>
): Record<MobArchetypeKey, MobDefinition> {
  for (const [key, drops] of Object.entries(MOB_VALUE_DROPS) as [MobArchetypeKey, readonly ChanceBasedItemReward[]][]) {
    const definition = definitions[key];
    const existing = new Set(definition.rewards.chanceItems.map((reward) => reward.rollId));
    for (const reward of drops) {
      if (existing.has(reward.rollId)) throw new Error(`${key} already rolls ${reward.rollId}`);
    }
    definitions[key] = {
      ...definition,
      rewards: { ...definition.rewards, chanceItems: [...definition.rewards.chanceItems, ...drops.map((reward) => ({ ...reward }))] }
    };
  }
  for (const [key, quantity] of Object.entries(MOB_VALUE_FEATHER_BASICS) as [MobArchetypeKey, number][]) {
    const definition = definitions[key];
    definitions[key] = {
      ...definition,
      rewards: { ...definition.rewards, items: [...definition.rewards.items, { itemId: "feather", quantity }] }
    };
  }
  return definitions;
}

type TemplateMobArchetype = FantasyMobArchetype | AnimalMobArchetype;

/** Orc Brute (L20) and Ogre (L25) legacy attack and defense, for elites and bosses built on a lower-level template. */
const ELITE_LEGACY_STATS = { attackPower: 9, defense: 14 } as const;
const BOSS_LEGACY_STATS = { attackPower: 12, defense: 20 } as const;

/**
 * A template mob's own level or target hit count where it differs from its
 * template (e.g. a world boss role), each with its reason.
 */
const TEMPLATE_MOB_OWN_NUMBERS: Readonly<Partial<Record<TemplateMobArchetype, Readonly<{
  level?: number;
  targetBasicHitCount?: number;
  /** Legacy attack/defense where the template's are a lower-level mob's (see templateMobDefinition). */
  attackPower?: number;
  defense?: number;
  /** Pace and reach where the template's do not fit (Golem Forge: a slow Iron Golem, a fast Spark Wisp, a throwing Smith). */
  movementSpeedMultiplier?: number;
  attackRangeM?: number;
  reason: string;
}>>>> = {
  // T4 elites: 20 hits, the Orc Brute's L20 attack and defense.
  leech_mother: { level: 20, targetBasicHitCount: 20, ...ELITE_LEGACY_STATS, reason: "T4 elite" },
  chimera: { level: 20, targetBasicHitCount: 20, ...ELITE_LEGACY_STATS, reason: "T4 elite" },
  kraken: { level: 20, targetBasicHitCount: 20, ...ELITE_LEGACY_STATS, reason: "T4 elite" },
  bridge_troll: { level: 20, targetBasicHitCount: 20, ...ELITE_LEGACY_STATS, reason: "T4 elite" },
  serpent_priestess: { targetBasicHitCount: 20, reason: "T4 elite" },
  alder_king: { targetBasicHitCount: 20, reason: "T4 elite" },
  mossjaw_warboss: { targetBasicHitCount: 20, reason: "T4 elite" },
  coven_matron: { targetBasicHitCount: 20, reason: "T4 elite" },
  strawman_lord: { targetBasicHitCount: 20, reason: "T4 elite" },
  gnoll_packlord: { targetBasicHitCount: 20, reason: "T4 elite" },
  frogfolk_chief: { targetBasicHitCount: 20, reason: "T4 elite" },
  frostborn_jarl: { targetBasicHitCount: 20, reason: "T4 elite" },
  // T5 world bosses: their declared hit counts, the Ogre's L25 attack and defense.
  stormwing: { targetBasicHitCount: 60, reason: "T5 world boss" },
  ember_giant: { targetBasicHitCount: 50, reason: "T5 world boss" },
  centaur_khan: { level: 25, targetBasicHitCount: 45, ...BOSS_LEGACY_STATS, reason: "T5 world boss" },
  mammoth_patriarch: { level: 25, targetBasicHitCount: 55, ...BOSS_LEGACY_STATS, reason: "T5 world boss" },
  blizzard_lord: { targetBasicHitCount: 50, reason: "T5 world boss" },
  elder_mere_serpent: { level: 25, targetBasicHitCount: 50, ...BOSS_LEGACY_STATS, reason: "T5 world boss" },
  shellback: { level: 16, targetBasicHitCount: 14, reason: "Water herd: very high HP (Resin Crawler template is a 1-hit pest)" },
  darter: { level: 14, targetBasicHitCount: 4, reason: "Water pack mob in the level 14-25 sea band" },
  ink_pool: { level: 15, targetBasicHitCount: 9, reason: "Water mob in the level 14-25 sea band" },
  drowned_citizen: { level: 14, targetBasicHitCount: 5, reason: "Peaceful sea folk in the level 14-25 sea band" },
  tide_wraith: { level: 18, reason: "Hostile deep-sea mob in the level 14-25 sea band" },
  gate_warden: { level: 20, targetBasicHitCount: 16, reason: "Rare deep-sea caster that summons adds" },
  drowned_cultist: { level: 16, targetBasicHitCount: 3, reason: "Gate Warden add in the level 14-25 sea band" },
  // Overworld bestiary additions: tier by level band, effort by hit count (gold follows 5 x hits x rarity).
  dire_wolf: { level: 12, targetBasicHitCount: 8, reason: "Tier 3 pack hunter, much bigger than a Wolf (3 hits)" },
  moss_troll: { level: 15, targetBasicHitCount: 12, reason: "Tier 3 troll, the Rime and Scorch Trolls' 12 hits" },
  woolly_mammoth: { level: 15, targetBasicHitCount: 15, reason: "Tier 3 megafauna grazer, far tougher than a Hog (5 hits)" },
  wolverine: { level: 10, targetBasicHitCount: 6, reason: "Small but aggressive: a notch below the Bear (10 hits)" },
  musk_ox: { level: 12, targetBasicHitCount: 11, reason: "Arctic grazer tougher than a Hog (5 hits), well short of the Mammoth (15)" },
  ash_drake: { level: 8, targetBasicHitCount: 5, reason: "Tier 2 wingless drake, a Goblin-sized fight in the Wolf's lane" },
  ember_dragon: { level: 20, targetBasicHitCount: 20, ...ELITE_LEGACY_STATS, reason: "Tier 4 rare dragon: a hunt-tier fight of 20 hits" },
  snapjaw_flytrap: { level: 6, targetBasicHitCount: 4, reason: "Tier 2 plant ambusher, tougher than a Frog (1 hit)" },
  giant_larva: { level: 17, targetBasicHitCount: 16, reason: "Tier 4 mid-high hunt: a dangerous grub between the Hog (5 hits) and the Ember Dragon (20)" },
  cairn_golem: { level: 15, targetBasicHitCount: 14, reason: "Tier 3 stone guardian, a notch above the 12-hit trolls" },
  // Drowned City raid (level-30 entry): the spec's 27-31 sits above the mob level cap (25), so the
  // roster fills the top challenge tier and is tuned by hit count.
  tide_wraith_dc: { level: 23, targetBasicHitCount: 14, reason: "Drowned City entry mob (top tier)" },
  darter_dc: { level: 21, targetBasicHitCount: 6, reason: "Drowned City entry pack mob" },
  ink_pool_dc: { level: 22, targetBasicHitCount: 12, reason: "Drowned City entry mob" },
  drowned_cultist_dc: { level: 22, targetBasicHitCount: 5, reason: "Drowned City warden add" },
  shellback_dc: { level: 22, targetBasicHitCount: 18, reason: "Drowned City herd mob" },
  coral_golem_dc: { level: 24, targetBasicHitCount: 16, reason: "Drowned City kelp wing heavy" },
  drowned_deckhand_dc: { level: 22, targetBasicHitCount: 8, reason: "Drowned City harbor wing mob" },
  phantom_lookout_dc: { level: 23, targetBasicHitCount: 9, reason: "Drowned City harbor wing mob" },
  merfolk_harpooner_dc: { level: 23, targetBasicHitCount: 10, reason: "Drowned City harbor wing mob" },
  gate_warden_dc: { level: 25, targetBasicHitCount: 24, reason: "Drowned City warden hall caster" },
  void_wisp: { level: 23, targetBasicHitCount: 6, reason: "Drowned City observatory mob, Abyssal One add" },
  deep_crawler: { level: 24, targetBasicHitCount: 10, reason: "Drowned City observatory mob" },
  maw_lily: { level: 23, targetBasicHitCount: 9, reason: "Drowned City kelp wing mob" },
  chrono_wisp: { level: 22, targetBasicHitCount: 6, reason: "Drowned City past-room guardian" },
  abyssal_cultist: { level: 24, targetBasicHitCount: 8, reason: "The Abyssal One's timed ritual add" },
  // Golem Forge (level 37 by design; mob levels stop at the equipment cap, so the roster sits in the top tier).
  iron_golem_gf: { level: 24, targetBasicHitCount: 20, movementSpeedMultiplier: GOLEM_FORGE_MOB_PACE.ironGolem, reason: "Golem Forge Iron Golem" },
  stone_golem_gf: { level: 24, targetBasicHitCount: 18, reason: "Golem Forge Stone Golem" },
  geode_golem_gf: { level: 25, targetBasicHitCount: 22, reason: "Golem Forge Geode Golem" },
  mender_golem_gf: { level: 23, targetBasicHitCount: 14, reason: "Golem Forge Mender Golem" },
  sentinel_statue_gf: { level: 25, targetBasicHitCount: 24, reason: "Golem Forge Sentinel Statue" },
  spark_wisp_gf: { level: 23, targetBasicHitCount: 6, movementSpeedMultiplier: GOLEM_FORGE_MOB_PACE.sparkWisp, reason: "Golem Forge Spark Wisp" },
  slag_crawler_gf: { level: 23, targetBasicHitCount: 12, reason: "Golem Forge Slag Crawler" },
  golem_smith_gf: { level: 24, targetBasicHitCount: 10, attackRangeM: GOLEM_FORGE_MOB_PACE.smithThrowRangeM, reason: "Golem Forge Golem Smith" },
  corrupted_husk_gf: { level: 25, targetBasicHitCount: 40, reason: "Golem Forge Corrupted Husk" },
  gem_husk_gf: { level: 25, targetBasicHitCount: 40, reason: "Golem Forge Gem Husk" },
  walking_hammer_gf: { level: 23, targetBasicHitCount: 12, reason: "Golem Forge Walking Hammer" },
  healer_monolith_gf: { level: 25, targetBasicHitCount: 30, reason: "Golem Forge Healer Monolith" }
};
/**
 * Pet eggs (policy V9): the Brood Matriarch drops a Brood Egg and the Raptor Chieftain a Fangrock
 * Clutch Egg on 5% of kills; hatching them at Pets costs Glimmer (docs/design/PETS_PLAN.md).
 */
export const PET_EGG_DROP_ROLL_ID = "pet_egg";
export const PET_EGG_DROP_PROBABILITY = 0.05;
/**
 * Pearl (Command Board material) drops from Jellyfish, the Jellyfish Venom source.
 * Venom is guaranteed per kill; Pearl lands on half of kills, so a 300-Pearl
 * Command Board level costs about 600 Jellyfish. Policy V8 introduced this roll.
 */
export const PEARL_DROP_ROLL_ID = "pearl";
export const PEARL_DROP_PROBABILITY = 0.5;

export type MobDefinition = {
  key: MobArchetypeKey;
  name: string;
  maxHealth: number;
  level: number;
  attackPower: number;
  defense: number;
  attackIntervalMs: number;
  attackRangeM: number;
  movementSpeedMultiplier: number;
  combatSeparationM: number;
  retaliates: boolean;
  leashRadiusM: number;
  legacyV2BaseXpPool: number;
  balanceVersion: number;
  spriteKey: string;
  boss?: boolean;
  habitat?: MobHabitat;
  legacyRuntime?: {
    movementSpeedMultiplier: number;
    leashRadiusM: number;
  };
  rewards: {
    itemDelivery?: "inventory" | "ground";
    items: readonly { itemId: ResourceType; quantity: number }[];
    chanceItems: readonly ChanceBasedItemReward[];
    gold: number;
    cityCoins: number;
  };
};

/** The numbers a template mob copies: everything but identity, art and rewards. */
export type MobTemplateNumbers = Omit<MobDefinition, "key" | "name" | "spriteKey" | "rewards">;

/**
 * Wolf, Hog, Bear, Coastal Crab, Frog and Alligator biome variants. Each copies
 * its family base's entry in every per-archetype table below; only the name,
 * sprite and universal-food cut differ (Deer variants are written out in full).
 */
type DerivedBiomeVariantArchetype = Exclude<MobBiomeVariantArchetype, DeerFamilyArchetype>;

const TEMPLATE_MOB_ARCHETYPES: readonly TemplateMobArchetype[] = [
  ...FANTASY_MOB_ARCHETYPES,
  ...ANIMAL_MOB_ARCHETYPES
];

/**
 * Fills every derived biome variant from its family base, and every template
 * mob (FANTASY_MOB_TEMPLATES, ANIMAL_MOB_TEMPLATES) from its template: a mob's
 * value, or the world template's (WORLD_MOB_TEMPLATES) when it starts on one.
 */
function withBiomeVariants<T, W = T>(
  table: Readonly<Record<Exclude<MobArchetypeKey, DerivedBiomeVariantArchetype | TemplateMobArchetype>, T>>,
  worldTemplateValue: (template: WorldMobTemplate) => W,
  derive: (baseValue: T, variant: DerivedBiomeVariantArchetype) => T = (baseValue) => baseValue,
  deriveTemplated: (templateValue: T | W, key: TemplateMobArchetype) => T = (templateValue) => templateValue as T
): Record<MobArchetypeKey, T> {
  const result = { ...table } as Record<MobArchetypeKey, T>;
  for (const base of MOB_BIOME_VARIANT_FAMILY_BASES) {
    if (base === "deer") continue;
    for (const variant of MOB_BIOME_VARIANT_FAMILIES[base]) {
      if (variant === base) continue;
      result[variant] = derive(table[base], variant as DerivedBiomeVariantArchetype);
    }
  }
  for (const key of TEMPLATE_MOB_ARCHETYPES) {
    const template = mobTemplateOf(key)!;
    if (isWorldMobTemplateKey(template)) {
      result[key] = deriveTemplated(worldTemplateValue(WORLD_MOB_TEMPLATES[template]), key);
      continue;
    }
    if (mobTemplateOf(template) !== null) {
      throw new Error(`template mob ${key} cannot start on another template mob (${template})`);
    }
    result[key] = deriveTemplated(result[template], key);
  }
  return result;
}

const FANTASY_MOB_NAMES: Readonly<Record<FantasyMobArchetype, string>> = Object.freeze({
  frost_wraith: "Frost Wraith",
  yeti: "Yeti",
  barrow_wight: "Barrow Wight",
  risen_skeleton: "Risen Skeleton",
  revenant_lich: "Revenant Lich",
  moss_golem: "Moss Golem",
  vine_lurker: "Vine Lurker",
  lizardfolk_warrior: "Lizardfolk Warrior",
  bog_ghoul: "Bog Ghoul",
  giant_scorpion: "Giant Scorpion",
  dust_mummy: "Dust Mummy",
  thunderhorn: "Thunderhorn",
  griffin: "Griffin",
  basilisk: "Basilisk",
  canopy_goblin: "Canopy Goblin",
  poisonfrog_raider: "Poisonfrog Raider",
  pantherfolk_stalker: "Pantherfolk Stalker",
  vine_wrapped_corpse: "Vine-Wrapped Corpse",
  serpent_priestess: "Serpent Priestess",
  bugbear_chieftain: "Bugbear Chieftain",
  pinewarden: "Pinewarden",
  gallows_ghost: "Gallows Ghost",
  alder_king: "Alder King",
  pine_dryad: "Pine Dryad",
  mossjaw_sneak: "Mossjaw Sneak",
  mossjaw_spearman: "Mossjaw Spearman",
  mossjaw_hexer: "Mossjaw Hexer",
  mossjaw_warboss: "Mossjaw Warboss",
  hedge_witch: "Hedge Witch",
  restless_gravedigger: "Restless Gravedigger",
  coven_matron: "Coven Matron",
  stagfolk_warden: "Stagfolk Warden",
  rime_witch: "Rime Witch",
  draugr_berserker: "Draugr Berserker",
  snow_talonbear: "Snow Talonbear",
  frostwater_troll: "Frostwater Troll",
  underice_lurker: "Underice Lurker",
  centaur_outrider: "Centaur Outrider",
  volt_elemental: "Volt Elemental",
  possessed_scythe: "Possessed Scythe",
  strawman_lord: "Strawman Lord",
  gnoll_bonebow: "Gnoll Bonebow",
  gnoll_packseer: "Gnoll Packseer",
  gnoll_packlord: "Gnoll Packlord",
  carrion_ghoul: "Carrion Ghoul",
  sun_griffin: "Sun Griffin",
  frogfolk_tadpole: "Frogfolk Tadpole",
  frogfolk_blowgunner: "Frogfolk Blowgunner",
  frogfolk_shaman: "Frogfolk Shaman",
  frogfolk_chief: "Frogfolk Chief",
  bloat_leech: "Bloat Leech",
  bog_hag: "Bog Hag",
  leech_mother: "Leech Mother",
  yakfolk_stonehorn: "Yakfolk Stonehorn",
  highland_reaver: "Highland Reaver",
  storm_harpy: "Storm Harpy",
  cairn_wight: "Cairn Wight",
  stormwing_chick: "Stormwing Chick",
  stormwing: "Stormwing",
  cyclops_shepherd: "Cyclops Shepherd",
  skeleton_hoplite: "Skeleton Hoplite",
  tar_elemental: "Tar Elemental",
  olive_dryad: "Olive Dryad",
  chimera: "Chimera",
  jackalfolk_skirmisher: "Jackalfolk Skirmisher",
  dune_goblin: "Dune Goblin",
  desert_marauder: "Desert Marauder",
  scorch_troll: "Scorch Troll",
  ember_giant: "Ember Giant",
  steppe_raider: "Steppe Raider",
  steppe_horse_archer: "Steppe Horse Archer",
  salt_husk: "Salt Husk",
  kurgan_wight: "Kurgan Wight",
  centaur_khan: "Centaur Khan",
  frostborn_runecaster: "Frostborn Runecaster",
  frostborn_jarl: "Frostborn Jarl",
  permafrost_elemental: "Permafrost Elemental",
  draugr: "Draugr",
  mammoth_patriarch: "Mammoth Patriarch",
  rime_troll: "Rime Troll",
  aurora_shade: "Aurora Shade",
  blizzard_lord: "Blizzard Lord",
  gillfolk_scout: "Gillfolk Scout",
  gillfolk_netter: "Gillfolk Netter",
  coral_golem: "Coral Golem",
  drowned_deckhand: "Drowned Deckhand",
  reef_kraken: "Reef Kraken",
  merfolk_harpooner: "Merfolk Harpooner",
  phantom_lookout: "Phantom Lookout",
  maelstrom_spirit: "Maelstrom Spirit",
  sea_serpent: "Sea Serpent",
  kraken: "Kraken",
  drowned_bride: "Drowned Bride",
  lake_maiden: "Lake Maiden",
  elder_mere_serpent: "Elder Mere Serpent",
  drowned_thrall: "Drowned Thrall",
  kappa: "Kappa",
  kappa_brawler: "Kappa Brawler",
  bridge_troll: "Bridge Troll",
  nixie: "Nixie",
  rapids_elemental: "Rapids Elemental",
  shellback: "Shellback",
  darter: "Darter",
  ink_pool: "Ink Pool",
  drowned_citizen: "Drowned Citizen",
  tide_wraith: "Tide Wraith",
  gate_warden: "Gate Warden",
  drowned_cultist: "Drowned Cultist",
  dire_wolf: "Dire Wolf",
  moss_troll: "Moss Troll",
  ash_drake: "Ash Drake",
  ember_dragon: "Ember Dragon",
  snapjaw_flytrap: "Snapjaw Flytrap",
  cairn_golem: "Cairn Golem",
  giant_larva: "Giant Larva",
  tide_wraith_dc: "Tide Wraith",
  darter_dc: "Darter",
  ink_pool_dc: "Ink Pool",
  drowned_cultist_dc: "Drowned Cultist",
  shellback_dc: "Shellback",
  coral_golem_dc: "Coral Golem",
  drowned_deckhand_dc: "Drowned Deckhand",
  phantom_lookout_dc: "Phantom Lookout",
  merfolk_harpooner_dc: "Merfolk Harpooner",
  gate_warden_dc: "Gate Warden",
  void_wisp: "Void Wisp",
  deep_crawler: "Deep Crawler",
  maw_lily: "Maw Lily",
  chrono_wisp: "Chrono Wisp",
  abyssal_cultist: "Abyssal Cultist",
  iron_golem_gf: "Iron Golem",
  stone_golem_gf: "Stone Golem",
  geode_golem_gf: "Geode Golem",
  mender_golem_gf: "Mender Golem",
  sentinel_statue_gf: "Sentinel Statue",
  spark_wisp_gf: "Spark Wisp",
  slag_crawler_gf: "Slag Crawler",
  golem_smith_gf: "Golem Smith",
  corrupted_husk_gf: "Corrupted Husk",
  gem_husk_gf: "Gem Husk",
  walking_hammer_gf: "Walking Hammer",
  healer_monolith_gf: "Healer Monolith"
});

const ANIMAL_MOB_NAMES: Readonly<Record<AnimalMobArchetype, string>> = Object.freeze({
  jungle_tapir: "Jungle Tapir",
  jaguar: "Jaguar",
  mandrill: "Mandrill",
  capercaillie: "Capercaillie",
  elk: "Elk",
  red_squirrel: "Red Squirrel",
  badger: "Badger",
  grey_squirrel: "Grey Squirrel",
  stag_beetle: "Stag Beetle",
  great_grey_owl: "Great Grey Owl",
  flying_squirrel: "Flying Squirrel",
  plains_bison: "Plains Bison",
  prairie_dog: "Prairie Dog",
  burrowing_owl: "Burrowing Owl",
  giraffe: "Giraffe",
  lioness: "Lioness",
  spotted_hyena: "Spotted Hyena",
  sitatunga: "Sitatunga",
  emperor_dragonfly: "Emperor Dragonfly",
  mountain_ibex: "Mountain Ibex",
  wild_yak: "Wild Yak",
  alpine_marmot: "Alpine Marmot",
  wild_scrub_goat: "Wild Scrub Goat",
  crested_porcupine: "Crested Porcupine",
  spur_thighed_tortoise: "Spur-thighed Tortoise",
  dromedary: "Dromedary",
  fennec_fox: "Fennec Fox",
  sidewinder: "Sidewinder",
  desert_lion: "Desert Lion",
  saiga: "Saiga",
  wild_horse: "Steppe Wild Horse",
  steppe_marmot: "Steppe Marmot",
  lemming: "Lemming",
  snow_goose: "Snow Goose",
  emperor_penguin: "Emperor Penguin",
  peary_caribou: "Peary Caribou",
  ice_worm: "Ice Worm",
  sea_otter: "Sea Otter",
  herring_gull: "Herring Gull",
  spiny_lobster: "Spiny Lobster",
  hammerhead_shark: "Hammerhead Shark",
  manta_ray: "Manta Ray",
  humpback_whale: "Humpback Whale",
  muskellunge: "Muskellunge",
  mute_swan: "Mute Swan",
  northern_pike: "Northern Pike",
  snapping_turtle: "Snapping Turtle",
  beaver: "Beaver",
  river_otter: "River Otter",
  river_salmon: "River Salmon",
  woolly_mammoth: "Woolly Mammoth",
  field_hare: "Field Hare",
  arctic_hare: "Arctic Hare",
  capybara: "Capybara",
  armadillo: "Armadillo",
  red_fox: "Red Fox",
  wolverine: "Wolverine",
  ostrich: "Ostrich",
  golden_eagle: "Golden Eagle",
  musk_ox: "Musk Ox",
  seal: "Seal"
});

const TEMPLATE_MOB_NAMES: Readonly<Record<TemplateMobArchetype, string>> = Object.freeze({
  ...FANTASY_MOB_NAMES,
  ...ANIMAL_MOB_NAMES
});

const BIOME_VARIANT_NAMES: Readonly<Record<DerivedBiomeVariantArchetype, string>> = Object.freeze({
  frost_wolf: "Frost Wolf",
  dune_wolf: "Dune Wolf",
  jungle_wolf: "Jungle Wolf",
  bog_wolf: "Bog Wolf",
  woolly_hog: "Woolly Hog",
  warthog: "Warthog",
  jungle_hog: "Jungle Hog",
  mud_hog: "Mud Hog",
  javelina: "Javelina",
  snow_bear: "Snow Bear",
  black_bear: "Black Bear",
  sun_bear: "Sun Bear",
  ice_crab: "Ice Crab",
  sand_crab: "Sand Crab",
  mangrove_crab: "Mangrove Crab",
  frost_frog: "Frost Frog",
  poison_frog: "Poison Frog",
  desert_toad: "Desert Toad",
  caiman: "Caiman",
  crocodile: "Crocodile"
});

const ATTACKED_SINGLE: MobAiProfile = Object.freeze({
  proactive: null,
  onAttacked: Object.freeze({ group: "self" }),
  movement: Object.freeze({ kind: "attack_range" }),
  disengagement: Object.freeze({ kind: "engagement_timeout" }),
  endDisposition: "return_home",
  countdown: null
});

const VAULT_ENCOUNTER_AGGRESSIVE: MobAiProfile = Object.freeze({
  ...ATTACKED_SINGLE,
  proactive: Object.freeze({ intent: "combat", radiusM: 400, acquisitionDelayMs: 1_000 }),
  countdown: "acquisition"
});

const LEGENDARY_BIRD_ATTACKED_SINGLE: MobAiProfile = Object.freeze({
  ...ATTACKED_SINGLE,
  disengagement: Object.freeze({
    kind: "outside_radius",
    radiusM: DEFAULT_FLAG_RESOURCE_VISION_RADIUS_M,
    graceMs: 0
  })
});

const HOLLIN_PASSIVE: MobAiProfile = Object.freeze({
  proactive: null,
  onAttacked: null,
  movement: Object.freeze({ kind: "attack_range" }),
  disengagement: Object.freeze({ kind: "engagement_timeout" }),
  endDisposition: "idle_current",
  countdown: null
});

export type WorldMobTemplate = Readonly<{
  numbers: MobTemplateNumbers;
  aiProfile: MobAiProfile;
  targetBasicHitCount: number;
}>;

/**
 * Overworld copies of village, event and dungeon mob numbers (named after
 * their source as of 2026-10-04) for world mobs that borrow them. They are
 * copies on purpose: retuning the source mob must not move a world mob.
 */
export const WORLD_MOB_TEMPLATES: Readonly<Record<WorldMobTemplateKey, WorldMobTemplate>> = Object.freeze({
  world_goblin: {
    numbers: {
      level: 10, maxHealth: 180, attackPower: 5, defense: 5,
      attackIntervalMs: BASIC_ATTACK_INTERVAL_MS, attackRangeM: BASIC_ATTACK_RANGE_M,
      movementSpeedMultiplier: 0.75, combatSeparationM: 200, retaliates: true, leashRadiusM: 160,
      legacyV2BaseXpPool: 140, balanceVersion: 2
    },
    aiProfile: ATTACKED_SINGLE,
    targetBasicHitCount: 5
  },
  world_shellback_turtle: {
    numbers: {
      level: 6, maxHealth: 160, attackPower: 12, defense: 4,
      attackIntervalMs: BASIC_ATTACK_INTERVAL_MS, attackRangeM: BASIC_ATTACK_RANGE_M,
      movementSpeedMultiplier: 0.3, combatSeparationM: 22, retaliates: true, leashRadiusM: 0,
      legacyV2BaseXpPool: 96, balanceVersion: 2
    },
    aiProfile: ATTACKED_SINGLE,
    targetBasicHitCount: 10
  },
  world_cliff_hawk: {
    numbers: {
      level: 12, maxHealth: 110, attackPower: 22, defense: 2,
      attackIntervalMs: BASIC_ATTACK_INTERVAL_MS, attackRangeM: RANGED_ATTACK_RANGE_M * 0.7,
      movementSpeedMultiplier: 0.9, combatSeparationM: 18, retaliates: true, leashRadiusM: 0,
      legacyV2BaseXpPool: 110, balanceVersion: 2
    },
    aiProfile: ATTACKED_SINGLE,
    targetBasicHitCount: 5
  },
  world_carrion_chick: {
    numbers: {
      level: 10, maxHealth: 280, attackPower: 16, defense: 6,
      attackIntervalMs: BASIC_ATTACK_INTERVAL_MS, attackRangeM: BASIC_ATTACK_RANGE_M,
      movementSpeedMultiplier: 0.35, combatSeparationM: 22, retaliates: true, leashRadiusM: 0,
      legacyV2BaseXpPool: 120, balanceVersion: 2
    },
    aiProfile: ATTACKED_SINGLE,
    targetBasicHitCount: 14
  },
  world_lightning_bird: {
    numbers: {
      level: 25, maxHealth: 1_200, attackPower: 18, defense: 12,
      attackIntervalMs: BASIC_ATTACK_INTERVAL_MS, attackRangeM: BASIC_ATTACK_RANGE_M,
      movementSpeedMultiplier: 0.85, combatSeparationM: 0, retaliates: true,
      leashRadiusM: DEFAULT_FLAG_RESOURCE_VISION_RADIUS_M, legacyV2BaseXpPool: 1_500, balanceVersion: 2,
      boss: true, habitat: "land"
    },
    aiProfile: LEGENDARY_BIRD_ATTACKED_SINGLE,
    targetBasicHitCount: 120
  },
  /** Hollin farmer: never fights back and never starts a fight. */
  world_hollin_farmer: {
    numbers: {
      level: 1, maxHealth: 30, attackPower: 0, defense: 0,
      attackIntervalMs: BASIC_ATTACK_INTERVAL_MS, attackRangeM: BASIC_ATTACK_RANGE_M,
      movementSpeedMultiplier: 0, combatSeparationM: 12, retaliates: false, leashRadiusM: 0,
      legacyV2BaseXpPool: 0, balanceVersion: 1
    },
    aiProfile: HOLLIN_PASSIVE,
    targetBasicHitCount: 3
  }
});

/** Shared by Deer and every biome Deer variant. */
const DEER_AI_PROFILE: MobAiProfile = Object.freeze({
  ...ATTACKED_SINGLE,
  onAttacked: Object.freeze({ group: "exact_pack" }),
  endDisposition: "idle_current"
});

export const MOB_AI_PROFILES: Readonly<Record<MobArchetypeKey, MobAiProfile>> = Object.freeze(withBiomeVariants({
  training_dummy: Object.freeze({
    proactive: null,
    onAttacked: null,
    movement: Object.freeze({ kind: "attack_range" }),
    disengagement: Object.freeze({ kind: "engagement_timeout" }),
    endDisposition: "idle_current",
    countdown: null
  }),
  deer: DEER_AI_PROFILE,
  frost_deer: DEER_AI_PROFILE,
  jungle_deer: DEER_AI_PROFILE,
  marsh_deer: DEER_AI_PROFILE,
  sand_deer: DEER_AI_PROFILE,
  wolf: Object.freeze({
    ...ATTACKED_SINGLE,
    proactive: Object.freeze({ intent: "combat", radiusM: 150, acquisitionDelayMs: 3_000 }),
    onAttacked: Object.freeze({ group: "exact_pack" }),
    countdown: "acquisition"
  }),
  ogre: Object.freeze({
    ...ATTACKED_SINGLE,
    proactive: Object.freeze({ intent: "combat", radiusM: 300, acquisitionDelayMs: 5_000 }),
    countdown: "acquisition"
  }),
  bear: Object.freeze({
    ...ATTACKED_SINGLE,
    proactive: Object.freeze({ intent: "combat", radiusM: 300, acquisitionDelayMs: 0 }),
    disengagement: Object.freeze({ kind: "outside_radius", radiusM: 300, graceMs: 5_000 }),
    countdown: "disengagement"
  }),
  mysterious_traveler: Object.freeze({
    ...ATTACKED_SINGLE,
    proactive: Object.freeze({ intent: "observe", radiusM: 400, acquisitionDelayMs: 0 }),
    movement: Object.freeze({ kind: "standoff", distanceM: 300, deadbandM: 25 }),
    endDisposition: "idle_current"
  }),
  fire_bird: LEGENDARY_BIRD_ATTACKED_SINGLE,
  lightning_bird: LEGENDARY_BIRD_ATTACKED_SINGLE,
  ice_bird: LEGENDARY_BIRD_ATTACKED_SINGLE,
  sap_crawler: Object.freeze({
    ...ATTACKED_SINGLE,
    onAttacked: Object.freeze({ group: "exact_pack" })
  }),
  hog: ATTACKED_SINGLE,
  skeleton: ATTACKED_SINGLE,
  coastal_crab: ATTACKED_SINGLE,
  frog: ATTACKED_SINGLE,
  alligator: ATTACKED_SINGLE,
  squid: ATTACKED_SINGLE,
  jellyfish: ATTACKED_SINGLE,
  goblin: ATTACKED_SINGLE,
  bandit: ATTACKED_SINGLE,
  orc_brute: ATTACKED_SINGLE,
  xoral: Object.freeze({
    proactive: null,
    onAttacked: null,
    movement: Object.freeze({ kind: "attack_range" }),
    disengagement: Object.freeze({ kind: "engagement_timeout" }),
    endDisposition: "idle_current",
    countdown: null
  }),
  sewer_rat: ATTACKED_SINGLE,
  sick_sewer_rat: ATTACKED_SINGLE,
  sewer_rat_miniboss: ATTACKED_SINGLE,
  shellback_turtle: ATTACKED_SINGLE,
  sewer_spider: ATTACKED_SINGLE,
  dune_tick: ATTACKED_SINGLE,
  spiderling: ATTACKED_SINGLE,
  brood_matriarch: ATTACKED_SINGLE,
  cave_raptor: ATTACKED_SINGLE,
  raptor_runt: ATTACKED_SINGLE,
  raptor_spitter: ATTACKED_SINGLE,
  cave_bat: ATTACKED_SINGLE,
  raptor_chieftain: ATTACKED_SINGLE,
  nest_mouse: ATTACKED_SINGLE,
  carrion_chick: ATTACKED_SINGLE,
  cliff_hawk: ATTACKED_SINGLE,
  thunderwing: ATTACKED_SINGLE,
  rot_wolf: ATTACKED_SINGLE,
  blighted_stag: ATTACKED_SINGLE,
  thornfern: ATTACKED_SINGLE,
  blight_treant: ATTACKED_SINGLE,
  blight_sprite: ATTACKED_SINGLE,
  hollow_elder: ATTACKED_SINGLE,
  drakeling: ATTACKED_SINGLE,
  magma_salamander: ATTACKED_SINGLE,
  lava_slime: ATTACKED_SINGLE,
  ash_wyvern: ATTACKED_SINGLE,
  drake_broodguard: ATTACKED_SINGLE,
  elder_dragon: ATTACKED_SINGLE,
  initiate_monk: ATTACKED_SINGLE,
  staff_adept: ATTACKED_SINGLE,
  shadow_acrobat: ATTACKED_SINGLE,
  iron_statue: ATTACKED_SINGLE,
  bell_spirit: ATTACKED_SINGLE,
  // Tilted Vault story mobs exist only inside a woken combat-room encounter: they come for the player (a short
  // readable beat first) instead of waiting to be hit, so the room is a fight and its special moves get used.
  ember_shade: VAULT_ENCOUNTER_AGGRESSIVE,
  ashbound_revenant: VAULT_ENCOUNTER_AGGRESSIVE,
  vault_warden: VAULT_ENCOUNTER_AGGRESSIVE,
  grandmaster: ATTACKED_SINGLE,
  grandmaster_clone: ATTACKED_SINGLE,
  slime: ATTACKED_SINGLE,
  slime_miniboss: ATTACKED_SINGLE,
  hollin_hut: HOLLIN_PASSIVE,
  hollin_guard: ATTACKED_SINGLE,
  hollin_brute: ATTACKED_SINGLE,
  hollin_elder: ATTACKED_SINGLE,
  hollin_farmer: HOLLIN_PASSIVE,
  hollin_helper: HOLLIN_PASSIVE,
  sky_scout: ATTACKED_SINGLE,
  cloud_sentry: ATTACKED_SINGLE,
  cloud_arbiter: ATTACKED_SINGLE,
  warden_scout: ATTACKED_SINGLE,
  zealot: ATTACKED_SINGLE,
  serpent_jailer: ATTACKED_SINGLE,
  caged_valkyrie: ATTACKED_SINGLE,
  coil_hatchling: ATTACKED_SINGLE,
  legion_soldier: ATTACKED_SINGLE,
  mimic: ATTACKED_SINGLE,
  centurion: ATTACKED_SINGLE,
  brood_matron: ATTACKED_SINGLE,
  trifang_warden: ATTACKED_SINGLE,
  the_watcher: ATTACKED_SINGLE,
  drowned_admiral: ATTACKED_SINGLE,
  tidemaw: ATTACKED_SINGLE,
  abyssal_one: ATTACKED_SINGLE,
  tidemaw_tentacle: ATTACKED_SINGLE,
  granite_bull: ATTACKED_SINGLE,
  corrupted_core: ATTACKED_SINGLE,
  forgemaster: ATTACKED_SINGLE,
  tidemaw_tentacle_marked: ATTACKED_SINGLE
}, (template) => template.aiProfile, undefined, (profile, key) => key === "sentinel_statue_gf"
  // Dormant until a player comes close; the engine wakes it (golemForgeMobs.ts), so it never acquires on its own.
  ? Object.freeze({ ...profile, proactive: null, countdown: null })
  : profile));

export function requireMobAiProfile(key: MobArchetypeKey): MobAiProfile {
  return MOB_AI_PROFILES[key];
}

export type MobCombatProfile = Readonly<{
  level: number;
  tier: MobChallengeTier;
  balanceVersion: number;
  /** Weapon and armor type on the universal damage table. */
  matchup: MobMatchup;
  /** Health unit: the neutral hit (equal-level sword into unarmored). */
  referenceAttack: number;
  maxHealth: number;
  attackPower: number;
  defense: number;
  targetBasicHitCount: number;
}>;

export const MOB_TARGET_BASIC_HIT_COUNTS: Readonly<
  Record<MobArchetypeKey, number>
> = withBiomeVariants({
  training_dummy: 10,
  sap_crawler: 1,
  deer: 2,
  frost_deer: 2,
  jungle_deer: 2,
  marsh_deer: 2,
  sand_deer: 2,
  wolf: 3,
  goblin: 5,
  bandit: 8,
  orc_brute: 12,
  ogre: 4,
  bear: 10,
  hog: 5,
  skeleton: 5,
  coastal_crab: 1,
  frog: 1,
  alligator: 9,
  squid: 7,
  jellyfish: 35,
  mysterious_traveler: 25,
  fire_bird: 120,
  lightning_bird: 120,
  ice_bird: 100,
  xoral: 500,
  sewer_rat: 4,
  sick_sewer_rat: 6,
  sewer_rat_miniboss: 30,
  shellback_turtle: 10,
  sewer_spider: 6,
  dune_tick: 2,
  spiderling: 1,
  brood_matriarch: 35,
  cave_raptor: 6,
  raptor_runt: 2,
  raptor_spitter: 4,
  cave_bat: 3,
  raptor_chieftain: 45,
  nest_mouse: 3,
  carrion_chick: 14,
  cliff_hawk: 5,
  thunderwing: 45,
  rot_wolf: 5,
  blighted_stag: 10,
  thornfern: 8,
  blight_treant: 20,
  blight_sprite: 1,
  hollow_elder: 50,
  drakeling: 6,
  magma_salamander: 9,
  lava_slime: 9,
  ash_wyvern: 7,
  drake_broodguard: 24,
  elder_dragon: 70,
  initiate_monk: 7,
  staff_adept: 9,
  shadow_acrobat: 7,
  iron_statue: 22,
  bell_spirit: 6,
  ember_shade: 6,
  ashbound_revenant: 9,
  vault_warden: 34,
  grandmaster: 60,
  grandmaster_clone: 1,
  slime: 3,
  slime_miniboss: 18,
  hollin_hut: 500,
  hollin_guard: 4,
  hollin_brute: 14,
  hollin_elder: 24,
  hollin_farmer: 3,
  hollin_helper: 3,
  sky_scout: 5,
  cloud_sentry: 9,
  cloud_arbiter: 16,
  warden_scout: 5,
  zealot: 9,
  serpent_jailer: 14,
  caged_valkyrie: 24,
  coil_hatchling: 2,
  legion_soldier: 12,
  mimic: 14,
  centurion: 70,
  brood_matron: 100,
  trifang_warden: 150,
  // Drowned City: sub-bosses ~1.2x the Brood Matron, the final boss ~2x.
  the_watcher: 120,
  drowned_admiral: 120,
  tidemaw: 120,
  abyssal_one: 200,
  // Tidemaw parts: the marked tentacle is the one that surfaces the boss.
  // Golem Forge: bosses ~1.2x the Drowned City ones (level 37 vs 32), the final boss ~1.9x.
  granite_bull: 140,
  corrupted_core: 140,
  forgemaster: 230,
  tidemaw_tentacle: 10,
  tidemaw_tentacle_marked: 14
}, (template) => template.targetBasicHitCount, undefined,
(templateHits, key) => TEMPLATE_MOB_OWN_NUMBERS[key]?.targetBasicHitCount ?? templateHits);

/**
 * XP-only hit counts where a mob's XP anchor intentionally differs from its
 * health hit count. The Ogre's health is 4 hits (soloable); its XP keeps 20.
 */
export const MOB_XP_HIT_COUNT_OVERRIDES: Readonly<Partial<Record<MobArchetypeKey, number>>> = {
  ogre: 20,
  hollin_hut: 20
};

export function mobXpHitCount(archetype: MobArchetypeKey): number {
  return MOB_XP_HIT_COUNT_OVERRIDES[archetype] ?? MOB_TARGET_BASIC_HIT_COUNTS[archetype];
}

/** Fixed Xoral health pool; it does not follow the equal-level sword-hit rule. */
export const XORAL_MAX_HEALTH = 5_000;

export const COMBAT_XP_POLICY_VERSION = 3;
export const BASE_XP_PER_HIT_EQUIVALENT = 12;
export const MOB_XP_LEVEL_GROWTH = 1.02;

/** The rarity of a mob's first overworld spawn rule; null for a mob with none (dungeon, fixed-share). */
function overworldSpawnRarity(key: MobArchetypeKey): MobSpawnRarity | null {
  const rules = (MOB_SPAWN_RULES as Readonly<Record<string, readonly { rarity?: MobSpawnRarity }[] | undefined>>)[key];
  return rules?.[0]?.rarity ?? null;
}

const FOOD_QUANTITY_WEIGHTS = [[1, 0.5], [2, 0.3], [3, 0.2]] as const;

/** Fantasy mobs that carry their own species cut (not a template's): they roll it at the standard chance. */
const FANTASY_MOBS_WITH_OWN_MEAT: ReadonlySet<string> = new Set(["dire_wolf", "ash_drake", "ember_dragon", "giant_larva"]);

/**
 * Meat chance per overworld mob (the food roll keeps its universal_food roll id; rations stay at
 * UNIVERSAL_FOOD_DROP_PROBABILITY). Critter (1-2 hits) 25%, Game (3-8 hits) 10%, Hunt (rare spawn
 * or 9+ hits) 25%, elite 50%; a world boss always drops 1-3 (null = quantity 1 at the default chance).
 */
function mobMeatChance(key: MobArchetypeKey): number | "boss" | null {
  const rarity = overworldSpawnRarity(key);
  const food = universalFoodForMob(key);
  if (rarity === null || food === null || key === "sap_crawler" || food.itemId === "field_ration"
      || food.itemId === "hearty_ration" || food.itemId === "xoral_essence") {
    return null;
  }
  // A fantasy mob's meat cut is its template's (or none); only its elites and bosses own one.
  if (rarity !== "boss" && rarity !== "elite" && (FANTASY_MOB_ARCHETYPES as readonly string[]).includes(key)
      && !FANTASY_MOBS_WITH_OWN_MEAT.has(key)) {
    return null;
  }
  if (rarity === "boss") return "boss";
  if (rarity === "elite") return 0.5;
  const hits = MOB_TARGET_BASIC_HIT_COUNTS[key];
  return hits <= 2 || hits >= 9 || rarity === "rare" ? 0.25 : 0.1;
}

/** A mob's universal food roll: one reward, or weighted 1-3 quantities for a world boss. */
function universalFoodRewards(
  mobArchetype: Exclude<MobArchetypeKey, "training_dummy">
): ChanceBasedItemReward[] {
  const food = universalFoodForMob(mobArchetype);
  if (!food) throw new Error(`Missing universal food policy for ${mobArchetype}`);
  const chance = mobMeatChance(mobArchetype);
  const reward = (quantity: number, probability: number): ChanceBasedItemReward => ({
    itemId: food.itemId,
    quantity,
    probability,
    rollId: UNIVERSAL_FOOD_DROP_ROLL_ID
  });
  if (chance === "boss") return FOOD_QUANTITY_WEIGHTS.map(([quantity, weight]) => reward(quantity, weight));
  return [reward(1, chance ?? UNIVERSAL_FOOD_DROP_PROBABILITY)];
}

function universalFoodReward(
  mobArchetype: Exclude<MobArchetypeKey, "training_dummy">
): ChanceBasedItemReward {
  return universalFoodRewards(mobArchetype)[0]!;
}

/**
 * Overworld gold: 5 per kill hit times the spawn rarity (common 1, uncommon 1.2, rare and elite
 * 1.5, boss 2), where the hits are the mob's XP hits (an Ogre-template L25 mob that is not a boss
 * counts 20). A mob keeps its current gold when the rule is within 25% of it; a 1-hit critter
 * always keeps its gold.
 */
const GOLD_RARITY_FACTORS: Readonly<Record<MobSpawnRarity, number>> = {
  common: 1, uncommon: 1.2, rare: 1.5, elite: 1.5, boss: 2
};

export function overworldGoldByRule(key: MobArchetypeKey): number | null {
  const rarity = overworldSpawnRarity(key);
  if (rarity === null) return null;
  const ogreGolem = rarity !== "boss" && mobTemplateOf(key) === "ogre" && key !== "ogre";
  const hits = ogreGolem ? 20 : mobXpHitCount(key);
  return Math.round(5 * hits * GOLD_RARITY_FACTORS[rarity]);
}

function overworldGold(key: MobArchetypeKey, currentGold: number): number {
  const byRule = overworldGoldByRule(key);
  if (byRule === null || mobXpHitCount(key) <= 1) return currentGold;
  return Math.abs(byRule - currentGold) <= currentGold * 0.25 ? currentGold : byRule;
}

export function combatXpAnchor(archetype: MobArchetypeKey): Readonly<{
  xpPolicyVersion: typeof COMBAT_XP_POLICY_VERSION;
  targetBasicHitCount: number;
  baseXpPool: number;
}> {
  const targetBasicHitCount = mobXpHitCount(archetype);
  return {
    xpPolicyVersion: COMBAT_XP_POLICY_VERSION,
    targetBasicHitCount,
    baseXpPool: archetype === "training_dummy"
      ? 0
      : BASE_XP_PER_HIT_EQUIVALENT * targetBasicHitCount
  };
}

export function resolveMobCombatProfile(
  archetype: MobArchetypeKey,
  level: number
): MobCombatProfile {
  if (!Number.isInteger(level) || level < 0 || level > MAX_EQUIPMENT_LEVEL) {
    throw new Error(`Mob combat level must be an integer from 0 through ${MAX_EQUIPMENT_LEVEL}`);
  }
  const legacyReferenceAttack = 10 + level;
  const matchup = mobMatchup(archetype);
  // Health is the target hit count of neutral hits (equal-level sword into
  // unarmored, 9) whatever the mob wears, so it does not scale with level.
  // Armor then decides the real swing count. Fixed pools are listed below.
  const referenceAttack = MOB_HEALTH_UNIT;
  const targetBasicHitCount = MOB_TARGET_BASIC_HIT_COUNTS[archetype];
  return {
    level,
    tier: mobChallengeTier(level),
    balanceVersion: EQUIPMENT_BALANCE_VERSION,
    matchup,
    referenceAttack,
    // Fixed pools: the jellyfish, the Xoral, and the Hollin Hut structure
    // (10,000 health; a building is not measured in sword hits).
    maxHealth: archetype === "jellyfish" || archetype === "hollin_hut"
      ? MOB_DEFINITIONS[archetype].maxHealth
      : archetype === "xoral"
        ? XORAL_MAX_HEALTH
        : referenceAttack * targetBasicHitCount,
    // Legacy attack: only used against non-player targets (companions, NPC
    // actors). Players are always hit through the universal damage table.
    attackPower: archetype === "jellyfish"
      ? MOB_DEFINITIONS.jellyfish.attackPower
      : archetype === "wolf" ? Math.ceil(legacyReferenceAttack / 2) : legacyReferenceAttack,
    defense: 0,
    targetBasicHitCount
  };
}

/**
 * Deer and its biome variants share one set of numbers, AI and drops; only the
 * name and the universal-food cut (UNIVERSAL_FOOD_BY_MOB) differ per key.
 */
function deerFamilyDefinition(key: DeerFamilyArchetype, name: string): MobDefinition {
  return {
    key,
    name,
    maxHealth: 25,
    level: 2,
    attackPower: 1,
    defense: 0,
    attackIntervalMs: BASIC_ATTACK_INTERVAL_MS,
    attackRangeM: BASIC_ATTACK_RANGE_M,
    movementSpeedMultiplier: 0.6,
    combatSeparationM: 25,
    retaliates: true,
    leashRadiusM: 0,
    legacyV2BaseXpPool: 30,
    balanceVersion: 2,
    spriteKey: key,
    rewards: {
      items: [],
      chanceItems: [
        { itemId: "leather", quantity: 1, probability: 0.5, rollId: "leather_quantity" },
        { itemId: "leather", quantity: 2, probability: 0.3, rollId: "leather_quantity" },
        { itemId: "leather", quantity: 3, probability: 0.2, rollId: "leather_quantity" },
        { itemId: "deer_hide", quantity: 1, probability: 0.00001, rollId: "rare_hide" },
        universalFoodReward(key)
      ],
      gold: 10,
      cityCoins: 1
    }
  };
}

/** A biome variant: its base's exact numbers, AI and drops under its own name, sprite and food cut. */
function biomeVariantDefinition(
  base: MobDefinition,
  key: DerivedBiomeVariantArchetype
): MobDefinition {
  return {
    ...base,
    key,
    name: BIOME_VARIANT_NAMES[key],
    spriteKey: key,
    rewards: {
      ...base.rewards,
      items: base.rewards.items.map((reward) => ({ ...reward })),
      chanceItems: base.rewards.chanceItems.map((reward) =>
        reward.rollId === UNIVERSAL_FOOD_DROP_ROLL_ID ? universalFoodReward(key) : reward
      )
    }
  };
}

/**
 * A mob built on a template (a mob's definition or a world template's
 * numbers): the template's numbers under its own name and sprite, its own
 * level where it declares one, and its own drops plus its own universal food
 * (none when its UNIVERSAL_FOOD_BY_MOB entry is null).
 */
export function mobDefinitionFromTemplate(input: Readonly<{
  key: Exclude<MobArchetypeKey, "training_dummy">;
  name: string;
  template: MobDefinition | MobTemplateNumbers;
  level?: number | undefined;
  drops: MobOwnDrops;
}>): MobDefinition {
  const { key: _key, name: _name, spriteKey: _spriteKey, rewards: _rewards, ...numbers } =
    input.template as Partial<MobDefinition> & MobTemplateNumbers;
  if (input.drops.chanceItems.some((reward) => reward.rollId === UNIVERSAL_FOOD_DROP_ROLL_ID)) {
    throw new Error(`${input.key}: its universal food roll is added for it; do not list one`);
  }
  return {
    ...numbers,
    ...(input.level === undefined ? {} : { level: input.level }),
    key: input.key,
    name: input.name,
    spriteKey: input.key,
    rewards: {
      items: (input.drops.items ?? []).map((reward) => ({ ...reward })),
      chanceItems: [
        ...input.drops.chanceItems.map((reward) => ({ ...reward })),
        // A template mob whose food is null (UNIVERSAL_FOOD_BY_MOB) has no food roll.
        ...(universalFoodForMob(input.key) === null ? [] : universalFoodRewards(input.key))
      ],
      gold: input.drops.gold,
      cityCoins: input.drops.cityCoins ?? 0
    }
  };
}

/**
 * A mob that declares its own hit count (an elite or world boss) takes its health from it, the
 * same hits x neutral hit as resolveMobCombatProfile, not the template's health; it also takes its
 * own legacy attack and defense where TEMPLATE_MOB_OWN_NUMBERS gives them.
 */
function withOwnCombatNumbers(definition: MobDefinition, key: TemplateMobArchetype): MobDefinition {
  const own = TEMPLATE_MOB_OWN_NUMBERS[key];
  if (own?.targetBasicHitCount === undefined) return definition;
  return {
    ...definition,
    maxHealth: MOB_HEALTH_UNIT * own.targetBasicHitCount,
    ...(own.attackPower === undefined ? {} : { attackPower: own.attackPower }),
    ...(own.defense === undefined ? {} : { defense: own.defense }),
    ...(own.movementSpeedMultiplier === undefined ? {} : { movementSpeedMultiplier: own.movementSpeedMultiplier }),
    ...(own.attackRangeM === undefined ? {} : { attackRangeM: own.attackRangeM })
  };
}

/**
 * A template mob (fantasy or animal). A mob with its own drop list gets
 * mobDefinitionFromTemplate. The first fourteen fantasy mobs keep their
 * template's exact numbers, AI and drops (template food included), with their
 * own metal materials (FANTASY_METAL_DROPS) in place of the template's. Every
 * fantasy mob is a Creature Book species, so it is Ashen-eligible like the
 * rest of the book (the Skeleton template itself is not in the book).
 */
function templateMobDefinition(
  template: MobDefinition | MobTemplateNumbers,
  key: TemplateMobArchetype
): MobDefinition {
  const ownNumbers = TEMPLATE_MOB_OWN_NUMBERS[key];
  const drops: WaveOneDrops | undefined = isAnimalMobArchetype(key)
    ? ANIMAL_MOB_DROPS[key]
    : (FANTASY_MOB_DROPS as Readonly<Partial<Record<FantasyMobArchetype, WaveOneDrops>>>)[key];
  if (drops !== undefined) {
    const level = ownNumbers?.level ?? (template as { level: number }).level;
    const bounty = waveOneBounty(level, mobMatchup(key).damageMultiplier);
    return withOwnCombatNumbers(mobDefinitionFromTemplate({
      key, name: TEMPLATE_MOB_NAMES[key], template, level: ownNumbers?.level,
      drops: { ...drops, gold: overworldGold(key, bounty.gold), cityCoins: bounty.cityCoins }
    }), key);
  }
  if (!("rewards" in template)
      || !(TEMPLATE_DROP_FANTASY_MOBS as readonly string[]).includes(key)) {
    throw new Error(`${key} needs its own drop list`);
  }
  return withOwnCombatNumbers({
    ...template,
    ...(ownNumbers?.level === undefined ? {} : { level: ownNumbers.level }),
    key,
    name: TEMPLATE_MOB_NAMES[key],
    spriteKey: key,
    rewards: {
      ...template.rewards,
      // The Skeleton template's gold was 12 before the value pass; that is what this mob is measured from.
      gold: overworldGold(key, mobTemplateOf(key) === "skeleton" ? 12 : template.rewards.gold),
      items: template.rewards.items.map((reward) => ({ ...reward })),
      chanceItems: [
        ...template.rewards.chanceItems
          .filter((reward) => !reward.rollId.startsWith(METAL_MATERIAL_ROLL_PREFIX))
          // The template's meat chance is its own; these keep the standard chance.
          .map((reward) => reward.rollId === UNIVERSAL_FOOD_DROP_ROLL_ID
            ? { ...reward, probability: UNIVERSAL_FOOD_DROP_PROBABILITY }
            : { ...reward }),
        ...(FANTASY_METAL_DROPS[key as FantasyMobArchetype] ?? []).map((reward) => ({ ...reward }))
      ]
    }
  }, key);
}

export const MOB_DEFINITIONS: Record<MobArchetypeKey, MobDefinition> = withMobValueDrops(withBiomeVariants({
  training_dummy: {
    key: "training_dummy",
    name: "Training Dummy",
    maxHealth: 100,
    level: 0,
    attackPower: 0,
    defense: 0,
    attackIntervalMs: BASIC_ATTACK_INTERVAL_MS,
    attackRangeM: BASIC_ATTACK_RANGE_M,
    movementSpeedMultiplier: 0,
    combatSeparationM: 0,
    retaliates: false,
    leashRadiusM: 0,
    legacyV2BaseXpPool: 0,
    balanceVersion: 1,
    spriteKey: "training_dummy",
    rewards: { items: [], chanceItems: [], gold: 0, cityCoins: 0 }
  },
  deer: deerFamilyDefinition("deer", "Deer"),
  frost_deer: deerFamilyDefinition("frost_deer", "Frost Deer"),
  jungle_deer: deerFamilyDefinition("jungle_deer", "Jungle Deer"),
  marsh_deer: deerFamilyDefinition("marsh_deer", "Marsh Deer"),
  sand_deer: deerFamilyDefinition("sand_deer", "Sand Deer"),
  wolf: {
    key: "wolf", name: "Wolf", level: 5, maxHealth: 90, attackPower: 4, defense: 2,
    attackIntervalMs: BASIC_ATTACK_INTERVAL_MS, attackRangeM: BASIC_ATTACK_RANGE_M, movementSpeedMultiplier: 0.75,
    combatSeparationM: WOLF_PACK_MINIMUM_SEPARATION_M,
    retaliates: true, leashRadiusM: 0, legacyV2BaseXpPool: 75, balanceVersion: 2,
    spriteKey: "wolf",
    legacyRuntime: {
      movementSpeedMultiplier: 0.6,
      leashRadiusM: 160
    },
    rewards: {
      items: [{ itemId: "leather", quantity: 2 }],
      chanceItems: [
        { itemId: "wolf_pelt", quantity: 1, probability: 0.00001, rollId: "rare_hide" },
        universalFoodReward("wolf")
      ],
      gold: 15,
      cityCoins: 2
    }
  },
  goblin: {
    key: "goblin",
    name: "Goblin",
    level: 10,
    maxHealth: 180,
    attackPower: 5,
    defense: 5,
    attackIntervalMs: BASIC_ATTACK_INTERVAL_MS,
    attackRangeM: BASIC_ATTACK_RANGE_M,
    movementSpeedMultiplier: 0.75,
    combatSeparationM: 200,
    retaliates: true,
    leashRadiusM: 160,
    legacyV2BaseXpPool: 140,
    balanceVersion: 2,
    spriteKey: "goblin",
    rewards: { items: [], chanceItems: [universalFoodReward("goblin")], gold: 1, cityCoins: 0 }
  },
  bandit: {
    key: "bandit", name: "Bandit", level: 15, maxHealth: 300, attackPower: 7, defense: 9,
    // Moves like the Skeleton.
    attackIntervalMs: BASIC_ATTACK_INTERVAL_MS, attackRangeM: BASIC_ATTACK_RANGE_M, movementSpeedMultiplier: 0.5,
    combatSeparationM: 0,
    retaliates: true, leashRadiusM: 160, legacyV2BaseXpPool: 225, balanceVersion: 2,
    spriteKey: "bandit",
    rewards: { items: [], chanceItems: [universalFoodReward("bandit")], gold: 48, cityCoins: 0 }
  },
  orc_brute: {
    key: "orc_brute", name: "Orc Brute", level: 20, maxHealth: 450, attackPower: 9,
    defense: 14, attackIntervalMs: BASIC_ATTACK_INTERVAL_MS, attackRangeM: BASIC_ATTACK_RANGE_M,
    // Moves like the Ogre (world AI and legacy runtime).
    movementSpeedMultiplier: 0.9, retaliates: true, leashRadiusM: 160, legacyV2BaseXpPool: 350,
    combatSeparationM: 0,
    balanceVersion: 2, spriteKey: "orc_brute",
    legacyRuntime: {
      movementSpeedMultiplier: 0.6,
      leashRadiusM: 160
    },
    rewards: { items: [], chanceItems: [universalFoodReward("orc_brute")], gold: 72, cityCoins: 0 }
  },
  ogre: {
    key: "ogre", name: "Ogre", level: 25, maxHealth: 650, attackPower: 12, defense: 20,
    attackIntervalMs: BASIC_ATTACK_INTERVAL_MS, attackRangeM: BASIC_ATTACK_RANGE_M, movementSpeedMultiplier: 0.9,
    combatSeparationM: 0,
    retaliates: true, leashRadiusM: 0, legacyV2BaseXpPool: 550, balanceVersion: 2,
    spriteKey: "ogre",
    legacyRuntime: {
      movementSpeedMultiplier: 0.6,
      leashRadiusM: 160
    },
    rewards: {
      items: [{ itemId: "stone", quantity: 1 }],
      chanceItems: [universalFoodReward("ogre")],
      gold: 100,
      cityCoins: 5
    }
  },
  bear: {
    key: "bear",
    name: "Bear",
    level: 15,
    maxHealth: 250,
    attackPower: 25,
    defense: 0,
    attackIntervalMs: BASIC_ATTACK_INTERVAL_MS,
    attackRangeM: BASIC_ATTACK_RANGE_M,
    movementSpeedMultiplier: 0.65,
    combatSeparationM: 0,
    retaliates: true,
    leashRadiusM: 160,
    legacyV2BaseXpPool: 120,
    balanceVersion: 2,
    spriteKey: "bear",
    habitat: "land",
    rewards: {
      items: [{ itemId: "leather", quantity: 15 }],
      chanceItems: [
        { itemId: "bear_hide", quantity: 1, probability: 0.00001, rollId: "rare_hide" },
        universalFoodReward("bear")
      ],
      gold: 60,
      cityCoins: 4
    }
  },
  mysterious_traveler: {
    key: "mysterious_traveler",
    name: "Mysterious Traveler",
    level: 25,
    maxHealth: 600,
    attackPower: 45,
    defense: 0,
    attackIntervalMs: BASIC_ATTACK_INTERVAL_MS,
    attackRangeM: 100,
    movementSpeedMultiplier: 0.8,
    combatSeparationM: 0,
    retaliates: true,
    leashRadiusM: 220,
    legacyV2BaseXpPool: 300,
    balanceVersion: 2,
    spriteKey: "mysterious_traveler",
    habitat: "land",
    rewards: {
      items: [{ itemId: "balsam_resin", quantity: 25 }],
      chanceItems: [universalFoodReward("mysterious_traveler")],
      gold: 250,
      cityCoins: 0
    }
  },
  sap_crawler: {
    key: "sap_crawler",
    name: "Resin Crawler",
    level: 1,
    maxHealth: 10,
    attackPower: 1,
    defense: 0,
    attackIntervalMs: BASIC_ATTACK_INTERVAL_MS,
    attackRangeM: BASIC_ATTACK_RANGE_M,
    movementSpeedMultiplier: 0.2,
    combatSeparationM: 15,
    retaliates: true,
    leashRadiusM: 120,
    legacyV2BaseXpPool: 15,
    balanceVersion: 2,
    spriteKey: "sap_crawler",
    rewards: {
      items: [],
      chanceItems: [
        { itemId: "balsam_resin", quantity: 1, probability: 0.5, rollId: "resin" },
        { itemId: "wood", quantity: 1, probability: 0.1, rollId: "wood" },
        universalFoodReward("sap_crawler")
      ],
      gold: 5,
      cityCoins: 1
    }
  },
  hog: {
    key: "hog",
    name: "Hog",
    level: 8,
    maxHealth: 135,
    attackPower: 4,
    defense: 3,
    attackIntervalMs: BASIC_ATTACK_INTERVAL_MS,
    attackRangeM: BASIC_ATTACK_RANGE_M,
    movementSpeedMultiplier: 0.55,
    combatSeparationM: 0,
    retaliates: true,
    leashRadiusM: 160,
    legacyV2BaseXpPool: 120,
    balanceVersion: 2,
    spriteKey: "hog",
    habitat: "land",
    rewards: {
      items: [{ itemId: "leather", quantity: 8 }],
      chanceItems: [
        { itemId: "hog_hide", quantity: 1, probability: 0.00001, rollId: "rare_hide" },
        universalFoodReward("hog")
      ],
      gold: 23,
      cityCoins: 3
    }
  },
  skeleton: {
    key: "skeleton",
    name: "Skeleton",
    level: 6,
    maxHealth: 100,
    attackPower: 5,
    defense: 3,
    attackIntervalMs: BASIC_ATTACK_INTERVAL_MS,
    attackRangeM: BASIC_ATTACK_RANGE_M,
    movementSpeedMultiplier: 0.5,
    combatSeparationM: 0,
    retaliates: true,
    leashRadiusM: 160,
    legacyV2BaseXpPool: 90,
    balanceVersion: 3,
    spriteKey: "skeleton",
    habitat: "land",
    rewards: {
      items: [],
      chanceItems: [
        { itemId: "bone", quantity: 4, probability: 0.5, rollId: "bone_quantity" },
        metalMaterialReward("umbral_essence", 0.08),
        universalFoodReward("skeleton")
      ],
      gold: 25,
      cityCoins: 0
    }
  },
  coastal_crab: {
    key: "coastal_crab",
    name: "Coastal Crab",
    level: 1,
    maxHealth: 10,
    attackPower: 1,
    defense: 0,
    attackIntervalMs: BASIC_ATTACK_INTERVAL_MS,
    attackRangeM: BASIC_ATTACK_RANGE_M,
    movementSpeedMultiplier: 0.2,
    combatSeparationM: 0,
    retaliates: true,
    leashRadiusM: 120,
    legacyV2BaseXpPool: 12,
    balanceVersion: 2,
    spriteKey: "coastal_crab",
    habitat: "land",
    rewards: {
      items: [{ itemId: "crab_carapace", quantity: 1 }],
      chanceItems: [
        { itemId: "crude_oil", quantity: 1, probability: 0.05, rollId: "crude_oil" },
        universalFoodReward("coastal_crab")
      ],
      gold: 5,
      cityCoins: 0
    }
  },
  frog: {
    key: "frog",
    name: "Frog",
    level: 0,
    maxHealth: 7,
    attackPower: 1,
    defense: 0,
    attackIntervalMs: BASIC_ATTACK_INTERVAL_MS,
    attackRangeM: BASIC_ATTACK_RANGE_M,
    movementSpeedMultiplier: 0.15,
    combatSeparationM: 0,
    retaliates: true,
    leashRadiusM: 80,
    legacyV2BaseXpPool: 10,
    balanceVersion: 2,
    spriteKey: "frog",
    habitat: "lake",
    rewards: { items: [], chanceItems: [universalFoodReward("frog")], gold: 2, cityCoins: 0 }
  },
  alligator: {
    key: "alligator",
    name: "Alligator",
    level: 15,
    maxHealth: 250,
    attackPower: 6,
    defense: 7,
    attackIntervalMs: BASIC_ATTACK_INTERVAL_MS,
    attackRangeM: BASIC_ATTACK_RANGE_M,
    movementSpeedMultiplier: 0.5,
    combatSeparationM: 0,
    retaliates: true,
    leashRadiusM: 160,
    legacyV2BaseXpPool: 210,
    balanceVersion: 2,
    spriteKey: "alligator",
    habitat: "river",
    rewards: {
      items: [{ itemId: "leather", quantity: 8 }],
      chanceItems: [
        { itemId: "alligator_hide", quantity: 1, probability: 0.00001, rollId: "rare_hide" },
        universalFoodReward("alligator")
      ],
      gold: 40,
      cityCoins: 4
    }
  },
  squid: {
    key: "squid",
    name: "Squid",
    level: 12,
    maxHealth: 180,
    attackPower: 5,
    defense: 5,
    attackIntervalMs: BASIC_ATTACK_INTERVAL_MS,
    attackRangeM: BASIC_ATTACK_RANGE_M,
    movementSpeedMultiplier: 0.6,
    combatSeparationM: 0,
    retaliates: true,
    leashRadiusM: 160,
    legacyV2BaseXpPool: 150,
    balanceVersion: 2,
    spriteKey: "squid",
    habitat: "ocean",
    rewards: {
      items: [],
      chanceItems: [
        { itemId: "crude_oil", quantity: 1, probability: 0.05, rollId: "crude_oil" },
        universalFoodReward("squid")
      ],
      gold: 30,
      cityCoins: 3
    }
  },
  jellyfish: {
    key: "jellyfish",
    name: "Jellyfish",
    level: 12,
    maxHealth: 900,
    attackPower: 1,
    defense: 5,
    attackIntervalMs: BASIC_ATTACK_INTERVAL_MS,
    attackRangeM: BASIC_ATTACK_RANGE_M,
    movementSpeedMultiplier: 0.6,
    combatSeparationM: 0,
    retaliates: true,
    leashRadiusM: 160,
    legacyV2BaseXpPool: 150,
    balanceVersion: 2,
    spriteKey: "jellyfish",
    habitat: "ocean",
    rewards: {
      items: [{ itemId: "jellyfish_venom", quantity: 1 }],
      chanceItems: [
        { itemId: "crude_oil", quantity: 1, probability: 0.05, rollId: "crude_oil" },
        { itemId: "pearl", quantity: 1, probability: PEARL_DROP_PROBABILITY, rollId: PEARL_DROP_ROLL_ID },
        universalFoodReward("jellyfish")
      ],
      gold: 263,
      cityCoins: 3
    }
  },
  fire_bird: legendaryBird("fire_bird", "Fire Bird", 1_200, 18, "fire_feather"),
  lightning_bird: legendaryBird("lightning_bird", "Lightning Bird", 1_200, 18, "tempest_quill"),
  ice_bird: legendaryBird("ice_bird", "Ice Bird", 1_000, 16, "ice_feather"),
  xoral: {
    key: "xoral",
    name: "The Xoral",
    level: 25,
    maxHealth: 17_500,
    attackPower: 35,
    defense: 0,
    attackIntervalMs: BASIC_ATTACK_INTERVAL_MS,
    attackRangeM: 250,
    movementSpeedMultiplier: 0.75,
    combatSeparationM: 0,
    retaliates: false,
    leashRadiusM: 650,
    legacyV2BaseXpPool: 6_000,
    balanceVersion: 2,
    spriteKey: "xoral",
    boss: true,
    rewards: { items: [], chanceItems: [universalFoodReward("xoral")], gold: 0, cityCoins: 0 }
  },
  // Authored dungeon actors.
  slime: {
    key: "slime", name: "Slime", level: 1,
    maxHealth: 36, attackPower: 6, defense: 0,
    attackIntervalMs: BASIC_ATTACK_INTERVAL_MS, attackRangeM: BASIC_ATTACK_RANGE_M,
    movementSpeedMultiplier: 0.45, combatSeparationM: 18,
    retaliates: true, leashRadiusM: 0, legacyV2BaseXpPool: 36, balanceVersion: 2,
    spriteKey: "slime",
    rewards: { items: [], chanceItems: [universalFoodReward("slime")], gold: 4, cityCoins: 0 }
  },
  slime_miniboss: {
    key: "slime_miniboss", name: "Slime Miniboss", level: 3,
    maxHealth: 216, attackPower: 10, defense: 1,
    attackIntervalMs: BASIC_ATTACK_INTERVAL_MS, attackRangeM: BASIC_ATTACK_RANGE_M,
    movementSpeedMultiplier: 0.4, combatSeparationM: 32,
    retaliates: true, leashRadiusM: 0, legacyV2BaseXpPool: 216, balanceVersion: 2,
    spriteKey: "slime_miniboss", boss: true,
    rewards: { items: [], chanceItems: [universalFoodReward("slime_miniboss")], gold: 30, cityCoins: 0 }
  },
  hollin_hut: {
    key: "hollin_hut", name: "Hollin Hut", level: 10,
    maxHealth: 10_000, attackPower: 0, defense: 0,
    attackIntervalMs: BASIC_ATTACK_INTERVAL_MS, attackRangeM: BASIC_ATTACK_RANGE_M,
    movementSpeedMultiplier: 0, combatSeparationM: 0,
    retaliates: false, leashRadiusM: 0, legacyV2BaseXpPool: 240, balanceVersion: 1,
    spriteKey: "hollin_hut", boss: false,
    // Gold only here: each raid contributor's food and ingredient roll is granted once per hut
    // defeat by HollinHutService (see HOLLIN_RAID_LOOT_*), so it is not repeated in this table.
    rewards: {
      items: [],
      chanceItems: [universalFoodReward("hollin_hut")],
      gold: 400,
      cityCoins: 0
    }
  },
  hollin_guard: {
    key: "hollin_guard", name: "Hollin Guard", level: 8,
    maxHealth: 60, attackPower: 10, defense: 0,
    attackIntervalMs: BASIC_ATTACK_INTERVAL_MS, attackRangeM: BASIC_ATTACK_RANGE_M,
    movementSpeedMultiplier: 0.9, combatSeparationM: 18,
    retaliates: true, leashRadiusM: 0, legacyV2BaseXpPool: 48, balanceVersion: 1,
    spriteKey: "hollin_guard",
    rewards: { items: [], chanceItems: [universalFoodReward("hollin_guard")], gold: 1, cityCoins: 0 }
  },
  // Raid elites: summoned adds, so only the universal 5% Kitchen ingredient roll and 1 Gold (no rings,
  // no rare drops). Balance is per hit; the cadence stays on the uniform attack interval.
  hollin_brute: {
    key: "hollin_brute", name: "Hollin Brute", level: 12,
    maxHealth: 60, attackPower: 24, defense: 2,
    attackIntervalMs: BASIC_ATTACK_INTERVAL_MS, attackRangeM: BASIC_ATTACK_RANGE_M,
    movementSpeedMultiplier: 0.8, combatSeparationM: 20,
    retaliates: true, leashRadiusM: 0, legacyV2BaseXpPool: 120, balanceVersion: 1,
    spriteKey: "hollin_guard",
    rewards: { items: [], chanceItems: [universalFoodReward("hollin_brute")], gold: 1, cityCoins: 0 }
  },
  hollin_elder: {
    key: "hollin_elder", name: "Hollin Elder", level: 14,
    maxHealth: 60, attackPower: 14, defense: 1,
    attackIntervalMs: BASIC_ATTACK_INTERVAL_MS, attackRangeM: BASIC_ATTACK_RANGE_M,
    movementSpeedMultiplier: 0.7, combatSeparationM: 22,
    retaliates: true, leashRadiusM: 0, legacyV2BaseXpPool: 200, balanceVersion: 1,
    spriteKey: "hollin_guard",
    rewards: { items: [], chanceItems: [universalFoodReward("hollin_elder")], gold: 1, cityCoins: 0 }
  },
  hollin_farmer: {
    key: "hollin_farmer", name: "Hollin", level: 1,
    maxHealth: 30, attackPower: 0, defense: 0,
    attackIntervalMs: BASIC_ATTACK_INTERVAL_MS, attackRangeM: BASIC_ATTACK_RANGE_M,
    movementSpeedMultiplier: 0, combatSeparationM: 12,
    retaliates: false, leashRadiusM: 0, legacyV2BaseXpPool: 0, balanceVersion: 1,
    spriteKey: "hollin_farmer",
    rewards: { items: [], chanceItems: [universalFoodReward("hollin_farmer")], gold: 1, cityCoins: 0 }
  },
  hollin_helper: {
    key: "hollin_helper", name: "Hollin Helper", level: 1,
    maxHealth: 30, attackPower: 0, defense: 0,
    attackIntervalMs: BASIC_ATTACK_INTERVAL_MS, attackRangeM: BASIC_ATTACK_RANGE_M,
    movementSpeedMultiplier: 0, combatSeparationM: 8,
    retaliates: false, leashRadiusM: 0, legacyV2BaseXpPool: 0, balanceVersion: 1,
    spriteKey: "hollin_helper",
    rewards: { items: [], chanceItems: [universalFoodReward("hollin_helper")], gold: 1, cityCoins: 0 }
  },
  sewer_rat: {
    key: "sewer_rat",
    name: "Sewer Rat",
    level: 4,
    maxHealth: 56,
    attackPower: 14,
    defense: 1,
    attackIntervalMs: BASIC_ATTACK_INTERVAL_MS,
    attackRangeM: BASIC_ATTACK_RANGE_M,
    movementSpeedMultiplier: 0.65,
    combatSeparationM: 18,
    retaliates: true,
    leashRadiusM: 0,
    legacyV2BaseXpPool: 48,
    balanceVersion: 2,
    spriteKey: "sewer_rat",
    rewards: { items: [], chanceItems: [universalFoodReward("sewer_rat")], gold: 8, cityCoins: 0 }
  },
  sick_sewer_rat: {
    key: "sick_sewer_rat",
    name: "Sick Sewer Rat",
    level: 6,
    maxHealth: 96,
    attackPower: 16,
    defense: 2,
    attackIntervalMs: BASIC_ATTACK_INTERVAL_MS,
    attackRangeM: BASIC_ATTACK_RANGE_M,
    movementSpeedMultiplier: 0.6,
    combatSeparationM: 18,
    retaliates: true,
    leashRadiusM: 0,
    legacyV2BaseXpPool: 72,
    balanceVersion: 2,
    spriteKey: "sick_sewer_rat",
    rewards: { items: [], chanceItems: [universalFoodReward("sick_sewer_rat")], gold: 12, cityCoins: 0 }
  },
  shellback_turtle: {
    key: "shellback_turtle",
    name: "Shell-back Turtle",
    level: 6,
    maxHealth: 160,
    attackPower: 12,
    defense: 4,
    attackIntervalMs: BASIC_ATTACK_INTERVAL_MS,
    attackRangeM: BASIC_ATTACK_RANGE_M,
    movementSpeedMultiplier: 0.3,
    combatSeparationM: 22,
    retaliates: true,
    leashRadiusM: 0,
    legacyV2BaseXpPool: 96,
    balanceVersion: 2,
    spriteKey: "shellback_turtle",
    rewards: { items: [], chanceItems: [universalFoodReward("shellback_turtle")], gold: 14, cityCoins: 0 }
  },
  sewer_spider: {
    key: "sewer_spider",
    name: "Sewer Spider",
    level: 6,
    maxHealth: 96,
    attackPower: 15,
    defense: 1,
    attackIntervalMs: BASIC_ATTACK_INTERVAL_MS,
    attackRangeM: BASIC_ATTACK_RANGE_M,
    movementSpeedMultiplier: 0.95,
    combatSeparationM: 18,
    retaliates: true,
    leashRadiusM: 0,
    legacyV2BaseXpPool: 72,
    balanceVersion: 2,
    spriteKey: "sewer_spider",
    rewards: { items: [], chanceItems: [universalFoodReward("sewer_spider")], gold: 12, cityCoins: 0 }
  },
  dune_tick: {
    key: "dune_tick",
    name: "Dune Tick",
    level: 3,
    maxHealth: 26,
    attackPower: 8,
    defense: 0,
    attackIntervalMs: BASIC_ATTACK_INTERVAL_MS,
    attackRangeM: BASIC_ATTACK_RANGE_M,
    movementSpeedMultiplier: 0.8,
    combatSeparationM: 12,
    retaliates: true,
    leashRadiusM: 0,
    legacyV2BaseXpPool: 24,
    balanceVersion: 2,
    spriteKey: "dune_tick",
    rewards: { items: [], chanceItems: [universalFoodReward("dune_tick")], gold: 4, cityCoins: 0 }
  },
  spiderling: {
    key: "spiderling",
    name: "Spiderling",
    level: 2,
    maxHealth: 12,
    attackPower: 6,
    defense: 0,
    attackIntervalMs: BASIC_ATTACK_INTERVAL_MS,
    attackRangeM: BASIC_ATTACK_RANGE_M,
    movementSpeedMultiplier: 1.05,
    combatSeparationM: 10,
    retaliates: true,
    leashRadiusM: 0,
    legacyV2BaseXpPool: 12,
    balanceVersion: 2,
    spriteKey: "spiderling",
    rewards: { items: [], chanceItems: [universalFoodReward("spiderling")], gold: 2, cityCoins: 0 }
  },
  cave_raptor: {
    key: "cave_raptor",
    name: "Cave Raptor",
    level: 6,
    maxHealth: 96,
    attackPower: 16,
    defense: 2,
    attackIntervalMs: BASIC_ATTACK_INTERVAL_MS,
    attackRangeM: BASIC_ATTACK_RANGE_M,
    movementSpeedMultiplier: 0.8,
    combatSeparationM: 20,
    retaliates: true,
    leashRadiusM: 0,
    legacyV2BaseXpPool: 72,
    balanceVersion: 2,
    spriteKey: "cave_raptor",
    rewards: { items: [], chanceItems: [universalFoodReward("cave_raptor")], gold: 12, cityCoins: 0 }
  },
  raptor_runt: {
    key: "raptor_runt",
    name: "Raptor Runt",
    level: 5,
    maxHealth: 30,
    attackPower: 12,
    defense: 0,
    attackIntervalMs: BASIC_ATTACK_INTERVAL_MS,
    attackRangeM: BASIC_ATTACK_RANGE_M,
    movementSpeedMultiplier: 1.05,
    combatSeparationM: 14,
    retaliates: true,
    leashRadiusM: 0,
    legacyV2BaseXpPool: 30,
    balanceVersion: 2,
    spriteKey: "raptor_runt",
    rewards: { items: [], chanceItems: [universalFoodReward("raptor_runt")], gold: 6, cityCoins: 0 }
  },
  raptor_spitter: {
    key: "raptor_spitter",
    name: "Raptor Spitter",
    level: 6,
    maxHealth: 64,
    attackPower: 14,
    defense: 1,
    attackIntervalMs: BASIC_ATTACK_INTERVAL_MS,
    attackRangeM: RANGED_ATTACK_RANGE_M * 0.8,
    movementSpeedMultiplier: 0.65,
    combatSeparationM: 18,
    retaliates: true,
    leashRadiusM: 0,
    legacyV2BaseXpPool: 56,
    balanceVersion: 2,
    spriteKey: "raptor_spitter",
    rewards: { items: [], chanceItems: [universalFoodReward("raptor_spitter")], gold: 12, cityCoins: 0 }
  },
  cave_bat: {
    key: "cave_bat",
    name: "Cave Bat",
    level: 5,
    maxHealth: 45,
    attackPower: 11,
    defense: 0,
    attackIntervalMs: BASIC_ATTACK_INTERVAL_MS,
    attackRangeM: BASIC_ATTACK_RANGE_M,
    movementSpeedMultiplier: 1,
    combatSeparationM: 12,
    retaliates: true,
    leashRadiusM: 0,
    legacyV2BaseXpPool: 36,
    balanceVersion: 2,
    spriteKey: "cave_bat",
    rewards: { items: [], chanceItems: [universalFoodReward("cave_bat")], gold: 8, cityCoins: 0 }
  },
  raptor_chieftain: {
    key: "raptor_chieftain",
    name: "Raptor Chieftain",
    level: 8,
    maxHealth: 810,
    attackPower: 24,
    defense: 6,
    attackIntervalMs: BASIC_ATTACK_INTERVAL_MS,
    attackRangeM: BASIC_ATTACK_RANGE_M,
    movementSpeedMultiplier: 0.85,
    combatSeparationM: 44,
    retaliates: true,
    leashRadiusM: 0,
    legacyV2BaseXpPool: 400,
    balanceVersion: 2,
    spriteKey: "raptor_chieftain",
    boss: true,
    rewards: {
      // The boss token is paid to every member by the dungeon's completion reward table.
      items: [],
      chanceItems: [
        { itemId: "clutch_egg", quantity: 1, probability: PET_EGG_DROP_PROBABILITY, rollId: PET_EGG_DROP_ROLL_ID },
        universalFoodReward("raptor_chieftain")
      ],
      // The 1,000 Gold per member comes from the completion reward table; this is only the kill drop.
      gold: 40,
      cityCoins: 6
    }
  },
  nest_mouse: {
    key: "nest_mouse",
    name: "Nest Mouse",
    level: 10,
    maxHealth: 60,
    attackPower: 20,
    defense: 0,
    attackIntervalMs: BASIC_ATTACK_INTERVAL_MS,
    attackRangeM: BASIC_ATTACK_RANGE_M,
    movementSpeedMultiplier: 1.05,
    combatSeparationM: 12,
    retaliates: true,
    leashRadiusM: 0,
    legacyV2BaseXpPool: 60,
    balanceVersion: 2,
    spriteKey: "nest_mouse",
    rewards: { items: [], chanceItems: [...metalMaterialRange("gale_splinter", 0.4, 2, 5), universalFoodReward("nest_mouse")], gold: 10, cityCoins: 0 }
  },
  carrion_chick: {
    key: "carrion_chick",
    name: "Carrion Chick",
    level: 10,
    maxHealth: 280,
    attackPower: 16,
    defense: 6,
    attackIntervalMs: BASIC_ATTACK_INTERVAL_MS,
    attackRangeM: BASIC_ATTACK_RANGE_M,
    movementSpeedMultiplier: 0.35,
    combatSeparationM: 22,
    retaliates: true,
    leashRadiusM: 0,
    legacyV2BaseXpPool: 120,
    balanceVersion: 2,
    spriteKey: "carrion_chick",
    rewards: { items: [], chanceItems: [...metalMaterialRange("gale_splinter", 0.4, 2, 5), universalFoodReward("carrion_chick")], gold: 16, cityCoins: 0 }
  },
  cliff_hawk: {
    key: "cliff_hawk",
    name: "Cliff Hawk",
    level: 12,
    maxHealth: 110,
    attackPower: 22,
    defense: 2,
    attackIntervalMs: BASIC_ATTACK_INTERVAL_MS,
    attackRangeM: RANGED_ATTACK_RANGE_M * 0.7,
    movementSpeedMultiplier: 0.9,
    combatSeparationM: 18,
    retaliates: true,
    leashRadiusM: 0,
    legacyV2BaseXpPool: 110,
    balanceVersion: 2,
    spriteKey: "cliff_hawk",
    rewards: { items: [], chanceItems: [...metalMaterialRange("gale_splinter", 0.4, 2, 5), universalFoodReward("cliff_hawk")], gold: 16, cityCoins: 0 }
  },
  thunderwing: {
    key: "thunderwing",
    name: "Thunderwing",
    level: 14,
    maxHealth: 1080,
    attackPower: 28,
    defense: 8,
    attackIntervalMs: BASIC_ATTACK_INTERVAL_MS,
    attackRangeM: BASIC_ATTACK_RANGE_M,
    movementSpeedMultiplier: 0.85,
    combatSeparationM: 46,
    retaliates: true,
    leashRadiusM: 0,
    legacyV2BaseXpPool: 520,
    balanceVersion: 2,
    spriteKey: "thunderwing",
    boss: true,
    rewards: {
      // The boss token is paid to every member by the dungeon's completion reward table.
      items: [],
      chanceItems: [metalMaterialReward("griffin_plume", 0.5), universalFoodReward("thunderwing")],
      gold: 260,
      cityCoins: 8
    }
  },
  rot_wolf: {
    key: "rot_wolf",
    name: "Rot Wolf",
    level: 15,
    maxHealth: 125,
    attackPower: 25,
    defense: 3,
    attackIntervalMs: BASIC_ATTACK_INTERVAL_MS,
    attackRangeM: BASIC_ATTACK_RANGE_M,
    movementSpeedMultiplier: 0.95,
    combatSeparationM: 20,
    retaliates: true,
    leashRadiusM: 0,
    legacyV2BaseXpPool: 125,
    balanceVersion: 2,
    spriteKey: "rot_wolf",
    rewards: { items: [], chanceItems: [universalFoodReward("rot_wolf")], gold: 20, cityCoins: 0 }
  },
  blighted_stag: {
    key: "blighted_stag",
    name: "Blighted Stag",
    level: 16,
    maxHealth: 260,
    attackPower: 30,
    defense: 4,
    attackIntervalMs: BASIC_ATTACK_INTERVAL_MS,
    attackRangeM: BASIC_ATTACK_RANGE_M,
    movementSpeedMultiplier: 0.9,
    combatSeparationM: 26,
    retaliates: true,
    leashRadiusM: 0,
    legacyV2BaseXpPool: 208,
    balanceVersion: 2,
    spriteKey: "blighted_stag",
    rewards: { items: [], chanceItems: [universalFoodReward("blighted_stag")], gold: 26, cityCoins: 0 }
  },
  thornfern: {
    key: "thornfern",
    name: "Thornfern",
    level: 15,
    maxHealth: 200,
    attackPower: 22,
    defense: 4,
    attackIntervalMs: BASIC_ATTACK_INTERVAL_MS,
    attackRangeM: RANGED_ATTACK_RANGE_M * 0.8,
    movementSpeedMultiplier: 0,
    combatSeparationM: 16,
    retaliates: true,
    leashRadiusM: 0,
    legacyV2BaseXpPool: 160,
    balanceVersion: 2,
    spriteKey: "thornfern",
    rewards: { items: [], chanceItems: [metalMaterialReward("bloom_petal", 0.1), universalFoodReward("thornfern")], gold: 18, cityCoins: 0 }
  },
  blight_treant: {
    key: "blight_treant",
    name: "Blight Treant",
    level: 16,
    maxHealth: 520,
    attackPower: 28,
    defense: 8,
    attackIntervalMs: BASIC_ATTACK_INTERVAL_MS,
    attackRangeM: BASIC_ATTACK_RANGE_M,
    movementSpeedMultiplier: 0.35,
    combatSeparationM: 34,
    retaliates: true,
    leashRadiusM: 0,
    legacyV2BaseXpPool: 312,
    balanceVersion: 2,
    spriteKey: "blight_treant",
    rewards: { items: [], chanceItems: [metalMaterialReward("bloom_petal", 0.1), universalFoodReward("blight_treant")], gold: 34, cityCoins: 0 }
  },
  blight_sprite: {
    key: "blight_sprite",
    name: "Blight Sprite",
    level: 15,
    maxHealth: 25,
    attackPower: 18,
    defense: 0,
    attackIntervalMs: BASIC_ATTACK_INTERVAL_MS,
    attackRangeM: BASIC_ATTACK_RANGE_M,
    movementSpeedMultiplier: 1.1,
    combatSeparationM: 10,
    retaliates: true,
    leashRadiusM: 0,
    legacyV2BaseXpPool: 25,
    balanceVersion: 2,
    spriteKey: "blight_sprite",
    rewards: { items: [], chanceItems: [metalMaterialReward("bloom_petal", 0.1), universalFoodReward("blight_sprite")], gold: 4, cityCoins: 0 }
  },
  hollow_elder: {
    key: "hollow_elder",
    name: "Hollow Elder",
    level: 18,
    maxHealth: 1400,
    attackPower: 34,
    defense: 9,
    attackIntervalMs: BASIC_ATTACK_INTERVAL_MS,
    attackRangeM: BASIC_ATTACK_RANGE_M,
    movementSpeedMultiplier: 0.6,
    combatSeparationM: 48,
    retaliates: true,
    leashRadiusM: 0,
    legacyV2BaseXpPool: 700,
    balanceVersion: 2,
    spriteKey: "hollow_elder",
    boss: true,
    rewards: {
      // The boss token is paid to every member by the dungeon's completion reward table.
      items: [],
      chanceItems: [universalFoodReward("hollow_elder")],
      gold: 340,
      cityCoins: 10
    }
  },
  drakeling: {
    key: "drakeling",
    name: "Drakeling",
    level: EQUIPMENT_LEVEL_CAP - 1,
    maxHealth: 220,
    attackPower: 34,
    defense: 5,
    attackIntervalMs: BASIC_ATTACK_INTERVAL_MS,
    attackRangeM: BASIC_ATTACK_RANGE_M,
    movementSpeedMultiplier: 1,
    combatSeparationM: 22,
    retaliates: true,
    leashRadiusM: 0,
    legacyV2BaseXpPool: 200,
    balanceVersion: 2,
    spriteKey: "drakeling",
    rewards: { items: [], chanceItems: [universalFoodReward("drakeling")], gold: 26, cityCoins: 0 }
  },
  magma_salamander: {
    key: "magma_salamander",
    name: "Magma Salamander",
    level: EQUIPMENT_LEVEL_CAP,
    maxHealth: 300,
    attackPower: 38,
    defense: 6,
    attackIntervalMs: BASIC_ATTACK_INTERVAL_MS,
    attackRangeM: BASIC_ATTACK_RANGE_M,
    movementSpeedMultiplier: 0.9,
    combatSeparationM: 24,
    retaliates: true,
    leashRadiusM: 0,
    legacyV2BaseXpPool: 260,
    balanceVersion: 2,
    spriteKey: "magma_salamander",
    rewards: { items: [], chanceItems: [universalFoodReward("magma_salamander")], gold: 30, cityCoins: 0 }
  },
  lava_slime: {
    key: "lava_slime",
    name: "Lava Slime",
    level: EQUIPMENT_LEVEL_CAP - 1,
    maxHealth: 340,
    attackPower: 30,
    defense: 4,
    attackIntervalMs: BASIC_ATTACK_INTERVAL_MS,
    attackRangeM: BASIC_ATTACK_RANGE_M,
    movementSpeedMultiplier: 0.6,
    combatSeparationM: 26,
    retaliates: true,
    leashRadiusM: 0,
    legacyV2BaseXpPool: 220,
    balanceVersion: 2,
    spriteKey: "lava_slime",
    rewards: { items: [], chanceItems: [universalFoodReward("lava_slime")], gold: 24, cityCoins: 0 }
  },
  ash_wyvern: {
    key: "ash_wyvern",
    name: "Ash Wyvern",
    level: EQUIPMENT_LEVEL_CAP,
    maxHealth: 260,
    attackPower: 36,
    defense: 5,
    attackIntervalMs: BASIC_ATTACK_INTERVAL_MS,
    attackRangeM: RANGED_ATTACK_RANGE_M * 0.7,
    movementSpeedMultiplier: 1,
    combatSeparationM: 26,
    retaliates: true,
    leashRadiusM: 0,
    legacyV2BaseXpPool: 240,
    balanceVersion: 2,
    spriteKey: "ash_wyvern",
    rewards: { items: [], chanceItems: [universalFoodReward("ash_wyvern")], gold: 30, cityCoins: 0 }
  },
  drake_broodguard: {
    key: "drake_broodguard",
    name: "Drake Broodguard",
    level: EQUIPMENT_LEVEL_CAP,
    maxHealth: 780,
    attackPower: 42,
    defense: 11,
    attackIntervalMs: BASIC_ATTACK_INTERVAL_MS,
    attackRangeM: BASIC_ATTACK_RANGE_M,
    movementSpeedMultiplier: 0.55,
    combatSeparationM: 38,
    retaliates: true,
    leashRadiusM: 0,
    legacyV2BaseXpPool: 520,
    balanceVersion: 2,
    spriteKey: "drake_broodguard",
    rewards: { items: [{ itemId: "dragon_scale", quantity: 1 }], chanceItems: [universalFoodReward("drake_broodguard")], gold: 48, cityCoins: 0 }
  },
  elder_dragon: {
    key: "elder_dragon",
    name: "Elder Dragon",
    level: EQUIPMENT_LEVEL_CAP,
    maxHealth: 3200,
    attackPower: 48,
    defense: 12,
    attackIntervalMs: BASIC_ATTACK_INTERVAL_MS,
    attackRangeM: BASIC_ATTACK_RANGE_M,
    movementSpeedMultiplier: 0.5,
    combatSeparationM: 60,
    retaliates: true,
    leashRadiusM: 0,
    legacyV2BaseXpPool: 1600,
    balanceVersion: 2,
    spriteKey: "elder_dragon",
    boss: true,
    rewards: {
      // Guaranteed: settled by the normal dungeon mob-defeat path (the encounter reward table is not read at runtime).
      items: [{ itemId: "wyrm_egg", quantity: 1 }, { itemId: "dragon_scale", quantity: 3 }],
      chanceItems: [universalFoodReward("elder_dragon")],
      gold: 520,
      cityCoins: 16
    }
  },
  initiate_monk: {
    key: "initiate_monk",
    name: "Initiate Monk",
    level: 19,
    maxHealth: 220,
    attackPower: 28,
    defense: 4,
    attackIntervalMs: BASIC_ATTACK_INTERVAL_MS,
    attackRangeM: BASIC_ATTACK_RANGE_M,
    movementSpeedMultiplier: 1.0,
    combatSeparationM: 18,
    retaliates: true,
    leashRadiusM: 0,
    legacyV2BaseXpPool: 180,
    balanceVersion: 2,
    spriteKey: "initiate_monk",
    rewards: { items: [], chanceItems: [universalFoodReward("initiate_monk")], gold: 22, cityCoins: 0 }
  },
  staff_adept: {
    key: "staff_adept",
    name: "Staff Adept",
    level: 20,
    maxHealth: 300,
    attackPower: 32,
    defense: 5,
    attackIntervalMs: BASIC_ATTACK_INTERVAL_MS,
    attackRangeM: BASIC_ATTACK_RANGE_M,
    movementSpeedMultiplier: 0.95,
    combatSeparationM: 22,
    retaliates: true,
    leashRadiusM: 0,
    legacyV2BaseXpPool: 240,
    balanceVersion: 2,
    spriteKey: "staff_adept",
    rewards: { items: [], chanceItems: [universalFoodReward("staff_adept")], gold: 28, cityCoins: 0 }
  },
  shadow_acrobat: {
    key: "shadow_acrobat",
    name: "Shadow Acrobat",
    level: 20,
    maxHealth: 200,
    attackPower: 30,
    defense: 3,
    attackIntervalMs: BASIC_ATTACK_INTERVAL_MS,
    attackRangeM: BASIC_ATTACK_RANGE_M,
    movementSpeedMultiplier: 1.15,
    combatSeparationM: 16,
    retaliates: true,
    leashRadiusM: 0,
    legacyV2BaseXpPool: 220,
    balanceVersion: 2,
    spriteKey: "shadow_acrobat",
    rewards: { items: [], chanceItems: [universalFoodReward("shadow_acrobat")], gold: 26, cityCoins: 0 }
  },
  iron_statue: {
    key: "iron_statue",
    name: "Iron Statue Guardian",
    level: 21,
    maxHealth: 650,
    attackPower: 40,
    defense: 12,
    attackIntervalMs: BASIC_ATTACK_INTERVAL_MS,
    attackRangeM: BASIC_ATTACK_RANGE_M,
    movementSpeedMultiplier: 0.4,
    combatSeparationM: 34,
    retaliates: true,
    leashRadiusM: 0,
    legacyV2BaseXpPool: 360,
    balanceVersion: 2,
    spriteKey: "iron_statue",
    rewards: { items: [], chanceItems: [universalFoodReward("iron_statue")], gold: 40, cityCoins: 0 }
  },
  bell_spirit: {
    key: "bell_spirit",
    name: "Bell Spirit",
    level: 20,
    maxHealth: 180,
    attackPower: 24,
    defense: 2,
    attackIntervalMs: BASIC_ATTACK_INTERVAL_MS,
    attackRangeM: RANGED_ATTACK_RANGE_M * 0.6,
    movementSpeedMultiplier: 0.8,
    combatSeparationM: 16,
    retaliates: true,
    leashRadiusM: 0,
    legacyV2BaseXpPool: 200,
    balanceVersion: 2,
    spriteKey: "bell_spirit",
    rewards: { items: [], chanceItems: [universalFoodReward("bell_spirit")], gold: 24, cityCoins: 0 }
  },
  ember_shade: {
    key: "ember_shade",
    name: "Ember Shade",
    level: 14,
    maxHealth: 150,
    attackPower: 22,
    defense: 2,
    attackIntervalMs: BASIC_ATTACK_INTERVAL_MS,
    attackRangeM: BASIC_ATTACK_RANGE_M,
    movementSpeedMultiplier: 1.05,
    combatSeparationM: 16,
    retaliates: true,
    leashRadiusM: 0,
    legacyV2BaseXpPool: 180,
    balanceVersion: 2,
    spriteKey: "ember_shade",
    // Tilted Vault story mob (dungeon only). Drops: existing shared materials from the art brief's list; its new items were skipped.
    rewards: { items: [], chanceItems: [universalFoodReward("ember_shade"), ownDrop("umbral_essence", 0.5)], gold: 5, cityCoins: 0 }
  },
  ashbound_revenant: {
    key: "ashbound_revenant",
    name: "Ashbound Revenant",
    level: 15,
    maxHealth: 230,
    attackPower: 26,
    defense: 6,
    attackIntervalMs: BASIC_ATTACK_INTERVAL_MS,
    attackRangeM: BASIC_ATTACK_RANGE_M,
    movementSpeedMultiplier: 1,
    combatSeparationM: 16,
    retaliates: true,
    leashRadiusM: 0,
    legacyV2BaseXpPool: 240,
    balanceVersion: 2,
    spriteKey: "ashbound_revenant",
    // Tilted Vault story mob (dungeon only). Drops: existing shared materials from the art brief's list; its new items were skipped.
    rewards: { items: [], chanceItems: [universalFoodReward("ashbound_revenant"), ownDrop("iron", 0.4)], gold: 8, cityCoins: 0 }
  },
  vault_warden: {
    key: "vault_warden",
    name: "Vault Warden",
    level: 18,
    maxHealth: 1000,
    attackPower: 34,
    defense: 12,
    attackIntervalMs: BASIC_ATTACK_INTERVAL_MS,
    attackRangeM: BASIC_ATTACK_RANGE_M,
    movementSpeedMultiplier: 0.8,
    combatSeparationM: 16,
    retaliates: true,
    leashRadiusM: 0,
    legacyV2BaseXpPool: 600,
    balanceVersion: 2,
    spriteKey: "vault_warden",
    // Tilted Vault story mob (dungeon only). Drops: existing shared materials from the art brief's list; its new items were skipped.
    rewards: { items: [], chanceItems: [universalFoodReward("vault_warden"), ownDrop("stone", 0.9), ownDrop("gearwork_essence", 0.3)], gold: 28, cityCoins: 0 }
  },
  grandmaster: {
    key: "grandmaster",
    name: "The Grandmaster",
    level: 22,
    maxHealth: 1800,
    attackPower: 38,
    defense: 10,
    attackIntervalMs: BASIC_ATTACK_INTERVAL_MS,
    attackRangeM: BASIC_ATTACK_RANGE_M,
    movementSpeedMultiplier: 0.8,
    combatSeparationM: 44,
    retaliates: true,
    leashRadiusM: 0,
    legacyV2BaseXpPool: 900,
    balanceVersion: 2,
    spriteKey: "grandmaster",
    boss: true,
    // Zephyr is not a kill drop: every party member claims one from the Grandmaster's Offering chest.
    rewards: {
      items: [],
      chanceItems: [universalFoodReward("grandmaster")],
      gold: 400,
      cityCoins: 12
    }
  },
  grandmaster_clone: {
    key: "grandmaster_clone",
    name: "Shadow Clone",
    level: 20,
    maxHealth: 260,
    attackPower: 22,
    defense: 3,
    attackIntervalMs: BASIC_ATTACK_INTERVAL_MS,
    attackRangeM: BASIC_ATTACK_RANGE_M,
    movementSpeedMultiplier: 1.0,
    combatSeparationM: 24,
    retaliates: true,
    leashRadiusM: 0,
    legacyV2BaseXpPool: 25,
    balanceVersion: 2,
    spriteKey: "grandmaster_clone",
    rewards: { items: [], chanceItems: [universalFoodReward("grandmaster_clone")], gold: 4, cityCoins: 0 }
  },
  brood_matriarch: {
    key: "brood_matriarch",
    name: "Brood Matriarch",
    level: 14,
    maxHealth: 840,
    attackPower: 22,
    defense: 6,
    attackIntervalMs: BASIC_ATTACK_INTERVAL_MS,
    attackRangeM: BASIC_ATTACK_RANGE_M,
    movementSpeedMultiplier: 0.7,
    combatSeparationM: 46,
    retaliates: true,
    leashRadiusM: 0,
    legacyV2BaseXpPool: 420,
    balanceVersion: 2,
    spriteKey: "brood_matriarch",
    boss: true,
    rewards: {
      // The boss token is paid to every member by the dungeon's completion reward table.
      items: [],
      chanceItems: [
        { itemId: "brood_egg", quantity: 1, probability: PET_EGG_DROP_PROBABILITY, rollId: PET_EGG_DROP_ROLL_ID },
        universalFoodReward("brood_matriarch")
      ],
      gold: 220,
      cityCoins: 8
    }
  },
  sewer_rat_miniboss: {
    key: "sewer_rat_miniboss",
    name: "Sewer Rat Miniboss",
    level: 12,
    maxHealth: 660,
    attackPower: 22,
    defense: 8,
    attackIntervalMs: BASIC_ATTACK_INTERVAL_MS,
    attackRangeM: BASIC_ATTACK_RANGE_M,
    movementSpeedMultiplier: 0.8,
    combatSeparationM: 42,
    retaliates: true,
    leashRadiusM: 0,
    legacyV2BaseXpPool: 360,
    balanceVersion: 2,
    spriteKey: "sewer_rat_miniboss",
    boss: true,
    rewards: { items: [], chanceItems: [universalFoodReward("sewer_rat_miniboss")], gold: 150, cityCoins: 5 }
  },
  sky_scout: {
    key: "sky_scout",
    name: "Spire Scout",
    level: 22,
    // Live health comes from resolveMobCombatProfile (hits x the neutral hit, 9).
    maxHealth: 45,
    attackPower: 32,
    defense: 0,
    attackIntervalMs: BASIC_ATTACK_INTERVAL_MS,
    attackRangeM: BASIC_ATTACK_RANGE_M,
    movementSpeedMultiplier: 0.95,
    combatSeparationM: 18,
    retaliates: true,
    leashRadiusM: 0,
    legacyV2BaseXpPool: 45,
    balanceVersion: 2,
    spriteKey: "sky_scout",
    rewards: {
      items: [],
      chanceItems: [universalFoodReward("sky_scout")],
      gold: 40,
      cityCoins: 0
    }
  },
  cloud_sentry: {
    key: "cloud_sentry",
    name: "Cloud Sentry",
    level: 23,
    // Live health comes from resolveMobCombatProfile (hits x the neutral hit, 9).
    maxHealth: 81,
    attackPower: 33,
    defense: 0,
    attackIntervalMs: BASIC_ATTACK_INTERVAL_MS,
    attackRangeM: BASIC_ATTACK_RANGE_M,
    movementSpeedMultiplier: 0.7,
    combatSeparationM: 24,
    retaliates: true,
    leashRadiusM: 0,
    legacyV2BaseXpPool: 81,
    balanceVersion: 2,
    spriteKey: "cloud_sentry",
    rewards: {
      items: [],
      chanceItems: [universalFoodReward("cloud_sentry")],
      gold: 60,
      cityCoins: 0
    }
  },
  cloud_arbiter: {
    key: "cloud_arbiter",
    name: "Cloud Arbiter",
    level: 24,
    // Live health comes from resolveMobCombatProfile (hits x the neutral hit, 9).
    maxHealth: 144,
    attackPower: 34,
    defense: 0,
    attackIntervalMs: BASIC_ATTACK_INTERVAL_MS,
    attackRangeM: BASIC_ATTACK_RANGE_M,
    movementSpeedMultiplier: 0.75,
    combatSeparationM: 26,
    retaliates: true,
    leashRadiusM: 0,
    legacyV2BaseXpPool: 144,
    balanceVersion: 2,
    spriteKey: "cloud_arbiter",
    rewards: {
      items: [],
      chanceItems: [universalFoodReward("cloud_arbiter")],
      gold: 90,
      cityCoins: 0
    }
  },
  warden_scout: {
    key: "warden_scout",
    name: "Warden Scout",
    level: 22,
    // Live health comes from resolveMobCombatProfile (hits x the neutral hit, 9).
    maxHealth: 45,
    attackPower: 32,
    defense: 0,
    attackIntervalMs: BASIC_ATTACK_INTERVAL_MS,
    attackRangeM: BASIC_ATTACK_RANGE_M,
    movementSpeedMultiplier: 0.9,
    combatSeparationM: 18,
    retaliates: true,
    leashRadiusM: 0,
    legacyV2BaseXpPool: 45,
    balanceVersion: 2,
    spriteKey: "warden_scout",
    rewards: {
      items: [],
      chanceItems: [universalFoodReward("warden_scout")],
      gold: 36,
      cityCoins: 0
    }
  },
  zealot: {
    key: "zealot",
    name: "Zealot",
    level: 23,
    // Live health comes from resolveMobCombatProfile (hits x the neutral hit, 9).
    maxHealth: 81,
    attackPower: 33,
    defense: 0,
    attackIntervalMs: BASIC_ATTACK_INTERVAL_MS,
    attackRangeM: BASIC_ATTACK_RANGE_M,
    movementSpeedMultiplier: 0.8,
    combatSeparationM: 22,
    retaliates: true,
    leashRadiusM: 0,
    legacyV2BaseXpPool: 81,
    balanceVersion: 2,
    spriteKey: "zealot",
    rewards: {
      items: [],
      chanceItems: [universalFoodReward("zealot")],
      gold: 55,
      cityCoins: 0
    }
  },
  serpent_jailer: {
    key: "serpent_jailer",
    name: "Serpent Jailer",
    level: 24,
    // Live health comes from resolveMobCombatProfile (hits x the neutral hit, 9).
    maxHealth: 126,
    attackPower: 34,
    defense: 0,
    attackIntervalMs: BASIC_ATTACK_INTERVAL_MS,
    attackRangeM: BASIC_ATTACK_RANGE_M,
    movementSpeedMultiplier: 0.7,
    combatSeparationM: 26,
    retaliates: true,
    leashRadiusM: 0,
    legacyV2BaseXpPool: 126,
    balanceVersion: 2,
    spriteKey: "serpent_jailer",
    rewards: {
      items: [],
      chanceItems: [universalFoodReward("serpent_jailer")],
      gold: 80,
      cityCoins: 0
    }
  },
  caged_valkyrie: {
    key: "caged_valkyrie",
    name: "Caged Valkyrie",
    level: 25,
    // Live health comes from resolveMobCombatProfile (hits x the neutral hit, 9).
    maxHealth: 216,
    attackPower: 35,
    defense: 0,
    attackIntervalMs: BASIC_ATTACK_INTERVAL_MS,
    attackRangeM: BASIC_ATTACK_RANGE_M,
    movementSpeedMultiplier: 0.9,
    combatSeparationM: 22,
    retaliates: true,
    leashRadiusM: 0,
    legacyV2BaseXpPool: 216,
    balanceVersion: 2,
    spriteKey: "caged_valkyrie",
    rewards: {
      items: [],
      chanceItems: [universalFoodReward("caged_valkyrie")],
      gold: 1,
      cityCoins: 0
    }
  },
  coil_hatchling: {
    key: "coil_hatchling",
    name: "Coil Hatchling",
    level: 23,
    // Live health comes from resolveMobCombatProfile (hits x the neutral hit, 9).
    maxHealth: 18,
    attackPower: 33,
    defense: 0,
    attackIntervalMs: BASIC_ATTACK_INTERVAL_MS,
    attackRangeM: BASIC_ATTACK_RANGE_M,
    movementSpeedMultiplier: 1,
    combatSeparationM: 10,
    retaliates: true,
    leashRadiusM: 0,
    legacyV2BaseXpPool: 18,
    balanceVersion: 2,
    spriteKey: "coil_hatchling",
    rewards: {
      items: [],
      chanceItems: [universalFoodReward("coil_hatchling")],
      gold: 20,
      cityCoins: 0
    }
  },
  legion_soldier: {
    key: "legion_soldier",
    name: "Legion Soldier",
    level: 24,
    // Live health comes from resolveMobCombatProfile (hits x the neutral hit, 9).
    maxHealth: 108,
    attackPower: 34,
    defense: 0,
    attackIntervalMs: BASIC_ATTACK_INTERVAL_MS,
    attackRangeM: BASIC_ATTACK_RANGE_M,
    movementSpeedMultiplier: 0.7,
    combatSeparationM: 24,
    retaliates: true,
    leashRadiusM: 0,
    legacyV2BaseXpPool: 108,
    balanceVersion: 2,
    spriteKey: "legion_soldier",
    rewards: {
      items: [],
      chanceItems: [universalFoodReward("legion_soldier")],
      gold: 70,
      cityCoins: 0
    }
  },
  mimic: {
    key: "mimic",
    name: "Mimic",
    level: 24,
    // Live health comes from resolveMobCombatProfile (hits x the neutral hit, 9).
    maxHealth: 126,
    attackPower: 34,
    defense: 0,
    attackIntervalMs: BASIC_ATTACK_INTERVAL_MS,
    attackRangeM: BASIC_ATTACK_RANGE_M,
    movementSpeedMultiplier: 0.6,
    combatSeparationM: 24,
    retaliates: true,
    leashRadiusM: 0,
    legacyV2BaseXpPool: 126,
    balanceVersion: 2,
    spriteKey: "mimic",
    rewards: {
      items: [],
      chanceItems: [universalFoodReward("mimic")],
      gold: 100,
      cityCoins: 0
    }
  },
  centurion: {
    key: "centurion",
    name: "The Cohort Marshal",
    level: 24,
    // Live health comes from resolveMobCombatProfile (hits x the neutral hit, 9).
    maxHealth: 630,
    attackPower: 34,
    defense: 0,
    attackIntervalMs: BASIC_ATTACK_INTERVAL_MS,
    attackRangeM: BASIC_ATTACK_RANGE_M,
    movementSpeedMultiplier: 0.6,
    combatSeparationM: 40,
    retaliates: true,
    leashRadiusM: 0,
    legacyV2BaseXpPool: 630,
    balanceVersion: 2,
    spriteKey: "centurion",
    boss: true,
    rewards: {
      items: [],
      chanceItems: [universalFoodReward("centurion")],
      gold: 600,
      cityCoins: 12
    }
  },
  brood_matron: {
    key: "brood_matron",
    name: "The Brood Matron",
    level: 25,
    // Live health comes from resolveMobCombatProfile (hits x the neutral hit, 9).
    maxHealth: 900,
    attackPower: 35,
    defense: 0,
    attackIntervalMs: BASIC_ATTACK_INTERVAL_MS,
    attackRangeM: BASIC_ATTACK_RANGE_M,
    movementSpeedMultiplier: 0.5,
    combatSeparationM: 52,
    retaliates: true,
    leashRadiusM: 0,
    legacyV2BaseXpPool: 900,
    balanceVersion: 2,
    spriteKey: "brood_matron",
    boss: true,
    rewards: {
      items: [],
      chanceItems: [universalFoodReward("brood_matron")],
      gold: 900,
      cityCoins: 14
    }
  },
  trifang_warden: {
    key: "trifang_warden",
    name: "Trifang Warden",
    level: 25,
    // Live health comes from resolveMobCombatProfile (hits x the neutral hit, 9).
    maxHealth: 1350,
    attackPower: 35,
    defense: 0,
    attackIntervalMs: BASIC_ATTACK_INTERVAL_MS,
    attackRangeM: BASIC_ATTACK_RANGE_M,
    movementSpeedMultiplier: 0.8,
    combatSeparationM: 56,
    retaliates: true,
    leashRadiusM: 0,
    legacyV2BaseXpPool: 1350,
    balanceVersion: 2,
    spriteKey: "trifang_warden",
    boss: true,
    rewards: {
      items: [],
      chanceItems: [universalFoodReward("trifang_warden")],
      gold: 1500,
      cityCoins: 20
    }
  },
  // Drowned City bosses (docs/design/DROWNED_CITY_SPEC.md). Orbs and the big gold come from the
  // hidden chests each defeat reveals; the mob itself settles like the Fallen Prison bosses.
  the_watcher: drownedCityBoss("the_watcher", "The Watcher", 0.4, 1_080),
  drowned_admiral: drownedCityBoss("drowned_admiral", "The Drowned Admiral", 0.7, 1_080),
  tidemaw: drownedCityBoss("tidemaw", "Tidemaw", 0, 1_080),
  abyssal_one: drownedCityBoss("abyssal_one", "The Abyssal One", 0, 1_800),
  granite_bull: golemForgeBoss("granite_bull", "Granite Bull", 0.8, 1_260, 900),
  corrupted_core: golemForgeBoss("corrupted_core", "The Corrupted Core", 0.6, 1_260, 900),
  forgemaster: golemForgeBoss("forgemaster", "The Forgemaster", 0.5, 2_070, 1_500),
  tidemaw_tentacle: tidemawTentacle("tidemaw_tentacle", "Tidemaw Tentacle", 90),
  tidemaw_tentacle_marked: tidemawTentacle("tidemaw_tentacle_marked", "Marked Tentacle", 126)
}, (template) => template.numbers, biomeVariantDefinition, templateMobDefinition));

/** Tidemaw's tentacles: rooted in their pools (speed 0), a little gold each. */
function golemForgeBoss(
  key: "granite_bull" | "corrupted_core" | "forgemaster",
  name: string,
  movementSpeedMultiplier: number,
  maxHealth: number,
  gold: number
): MobDefinition {
  return {
    key,
    name,
    level: 25,
    // Live health comes from resolveMobCombatProfile (hits x the neutral hit, 9).
    maxHealth,
    attackPower: 35,
    defense: 0,
    attackIntervalMs: BASIC_ATTACK_INTERVAL_MS,
    attackRangeM: BASIC_ATTACK_RANGE_M,
    movementSpeedMultiplier,
    combatSeparationM: 56,
    retaliates: true,
    leashRadiusM: 0,
    legacyV2BaseXpPool: maxHealth,
    balanceVersion: 2,
    spriteKey: key,
    boss: true,
    // Sparks, Amulet Clasps and the big gold come from the per-player boss chests.
    rewards: { items: [], chanceItems: [universalFoodReward(key)], gold, cityCoins: 20 }
  };
}

function tidemawTentacle(key: "tidemaw_tentacle" | "tidemaw_tentacle_marked", name: string, maxHealth: number): MobDefinition {
  return {
    key, name, level: 24,
    // Live health comes from resolveMobCombatProfile (hits x the neutral hit, 9).
    maxHealth, attackPower: 34, defense: 0,
    attackIntervalMs: BASIC_ATTACK_INTERVAL_MS, attackRangeM: BASIC_ATTACK_RANGE_M,
    movementSpeedMultiplier: 0, combatSeparationM: 30, retaliates: true, leashRadiusM: 0,
    legacyV2BaseXpPool: maxHealth, balanceVersion: 2, spriteKey: key,
    rewards: { items: [], chanceItems: [universalFoodReward(key)], gold: 5, cityCoins: 0 }
  };
}

function drownedCityBoss(
  key: "the_watcher" | "drowned_admiral" | "tidemaw" | "abyssal_one",
  name: string,
  movementSpeedMultiplier: number,
  maxHealth: number
): MobDefinition {
  return {
    key,
    name,
    level: 25,
    // Live health comes from resolveMobCombatProfile (hits x the neutral hit, 9).
    maxHealth,
    attackPower: 35,
    defense: 0,
    attackIntervalMs: BASIC_ATTACK_INTERVAL_MS,
    attackRangeM: BASIC_ATTACK_RANGE_M,
    movementSpeedMultiplier,
    combatSeparationM: 56,
    retaliates: true,
    leashRadiusM: 0,
    legacyV2BaseXpPool: maxHealth,
    balanceVersion: 2,
    spriteKey: key,
    boss: true,
    rewards: {
      items: [],
      chanceItems: [universalFoodReward(key)],
      gold: key === "abyssal_one" ? 1_500 : 900,
      cityCoins: key === "abyssal_one" ? 20 : 14
    }
  };
}

function legendaryBird(
  key: "fire_bird" | "lightning_bird" | "ice_bird",
  name: string,
  maxHealth: number,
  attackPower: number,
  feather: "fire_feather" | "tempest_quill" | "ice_feather"
): MobDefinition {
  return {
    key,
    name,
    level: 25,
    maxHealth,
    attackPower,
    defense: 12,
    attackIntervalMs: BASIC_ATTACK_INTERVAL_MS,
    attackRangeM: BASIC_ATTACK_RANGE_M,
    movementSpeedMultiplier: 0.85,
    combatSeparationM: 0,
    retaliates: true,
    leashRadiusM: DEFAULT_FLAG_RESOURCE_VISION_RADIUS_M,
    legacyV2BaseXpPool: 1_500,
    balanceVersion: 2,
    spriteKey: key,
    boss: true,
    habitat: "land",
    rewards: {
      itemDelivery: "ground",
      items: [{ itemId: feather, quantity: 1 }],
      chanceItems: [universalFoodReward(key)],
      gold: 0,
      cityCoins: 0
    }
  };
}

export function requireMobDefinition(key: MobArchetypeKey): MobDefinition {
  return MOB_DEFINITIONS[key];
}

/** A "leather-dropping monster": its live drop table (guaranteed or chance) includes leather. */
export function mobDropsLeather(key: string | null | undefined): boolean {
  const definition = key ? (MOB_DEFINITIONS as Readonly<Record<string, MobDefinition | undefined>>)[key] : undefined;
  if (!definition) return false;
  return definition.rewards.items.some((item) => item.itemId === "leather") ||
    definition.rewards.chanceItems.some((item) => item.itemId === "leather");
}

export function mobMovementSpeedMps(
  key: MobArchetypeKey,
  authoritativePlayerSpeedMps: number
): number {
  return requireMobDefinition(key).movementSpeedMultiplier * authoritativePlayerSpeedMps;
}
