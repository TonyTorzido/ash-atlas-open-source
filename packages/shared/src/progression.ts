import type { PlayerInventorySnapshot } from "./collectibles.js";
import type { ResourceType } from "./collectibles.js";
import { BASIC_ATTACK_INTERVAL_MS, MELEE_ATTACK_RANGE_M } from "./combatConstants.js";
import { MOB_DROP_ITEM_IDS } from "./mobDropItems.js";

export const PROGRESSION_CURVE_VERSION = 3;
/**
 * The character level cap (XP levels and skill points). Changing it needs this
 * constant plus a forward migration that re-derives stored character levels
 * (see 0879/0885/1021).
 */
export const CURRENT_LEVEL_CAP = 40;
/**
 * Weapons and armor stay capped at Level 25 while characters go to 40. Item
 * levels, effective (gear) level, monster levels and challenge tiers, pet
 * training, and Martial Arts unarmed scaling derive from this cap.
 */
export const EQUIPMENT_LEVEL_CAP = 25;
export const POST_CAP_XP_PER_REWARD = 250_000;
export const ENCHANTMENT_STONE_VARIANTS = [
  "diamond",
  "onyx",
  "opal",
  "amethyst",
  "topaz",
  "sapphire",
  "ruby",
  "emerald"
] as const;
export type EnchantmentStoneVariant = (typeof ENCHANTMENT_STONE_VARIANTS)[number];
export const TARGET_NORMAL_XP_PER_ACTIVE_HOUR = 10_000;
export const PROGRESSION_BALANCE_VERSION = 3;
export const REQUIREMENT_GROWTH = 1.1227080546772539;
export const BASE_PLAYER_MAX_HEALTH = 100;
export const FUTURE_PLAYER_MAX_HEALTH_SAFETY_CAP = 500;

export const PLAYER_MAX_HEALTH_EXCEPTION_SOURCES = [
  "class",
  "subclass",
  "rare_ring",
  "potion",
  "event",
  /** Negative only: the PvP death max-HP penalty. Never below 50% of the unpenalized value. */
  "debuff"
] as const;
export type PlayerMaxHealthExceptionSource =
  (typeof PLAYER_MAX_HEALTH_EXCEPTION_SOURCES)[number];

export type PlayerMaxHealthModifier = {
  source: PlayerMaxHealthExceptionSource;
  sourceId: string;
  flatBonus: number;
};

/**
 * PvP death max-HP loss (Revenant Metal phase). A PvP death costs `loss` max HP
 * (`revenantArmorLoss` while wearing Revenant armor), recovering 1 max HP every 75 minutes. The
 * penalized maximum never drops below `floorFraction` of the unpenalized value.
 */
export const PVP_MAX_HEALTH_PENALTY = Object.freeze({
  loss: 6,
  revenantArmorLoss: 4,
  recoveryIntervalMs: 75 * 60 * 1_000,
  floorFraction: 0.5
});

/** Max HP the debuff may remove from an unpenalized maximum (the 50% floor). */
export function maxHealthDebuffCap(unpenalizedMaxHealth: number): number {
  const unpenalized = Math.max(1, Math.trunc(unpenalizedMaxHealth));
  return unpenalized - Math.max(1, Math.ceil(unpenalized * PVP_MAX_HEALTH_PENALTY.floorFraction));
}

/** Applies a max-HP penalty to an unpenalized maximum, clamped by the 50% floor. */
export function applyMaxHealthDebuff(unpenalizedMaxHealth: number, penalty: number): number {
  const unpenalized = Math.max(1, Math.trunc(unpenalizedMaxHealth));
  const requested = Number.isFinite(penalty) ? Math.max(0, Math.trunc(penalty)) : 0;
  return unpenalized - Math.min(requested, maxHealthDebuffCap(unpenalized));
}

/** The penalty still in effect at `nowMs`: 1 max HP recovers per full 75 minutes since the anchor. */
export function effectiveMaxHealthPenalty(
  penalty: number,
  recoveryAnchorMs: number,
  nowMs: number
): number {
  const stored = Math.max(0, Math.trunc(penalty));
  const recovered = Math.max(0, Math.floor((nowMs - recoveryAnchorMs) / PVP_MAX_HEALTH_PENALTY.recoveryIntervalMs));
  return Math.max(0, stored - recovered);
}

/**
 * Adds a PvP loss to a lazily recovering penalty. Partial-hour recovery progress is
 * kept while a penalty remains; a fully recovered penalty restarts its clock now.
 * `cap` is the most the penalty may total (see `maxHealthDebuffCap`).
 */
export function addMaxHealthPenalty(
  current: Readonly<{ penalty: number; recoveryAnchorMs: number }> | null,
  loss: number,
  cap: number,
  nowMs: number
): Readonly<{ penaltyBefore: number; penalty: number; recoveryAnchorMs: number; appliedLoss: number }> {
  const before = current ? effectiveMaxHealthPenalty(current.penalty, current.recoveryAnchorMs, nowMs) : 0;
  const recoveryAnchorMs = current && before > 0
    ? current.recoveryAnchorMs +
      (Math.max(0, Math.trunc(current.penalty)) - before) * PVP_MAX_HEALTH_PENALTY.recoveryIntervalMs
    : nowMs;
  const penalty = Math.max(before, Math.min(Math.max(0, Math.trunc(cap)), before + Math.max(0, Math.trunc(loss))));
  return { penaltyBefore: before, penalty, recoveryAnchorMs, appliedLoss: penalty - before };
}

export const TOTAL_XP_FOR_LEVEL = {
  0: 0,
  1: 7_194,
  2: 15_270,
  3: 24_337,
  4: 34_517,
  5: 45_946,
  6: 58_778,
  7: 73_184,
  8: 89_357,
  9: 107_516,
  10: 127_902,
  11: 150_791,
  12: 176_487,
  13: 205_337,
  14: 237_728,
  15: 274_092,
  16: 314_919,
  17: 360_756,
  18: 412_217,
  19: 469_993,
  20: 534_858,
  21: 607_683,
  22: 689_444,
  23: 781_238,
  24: 884_296,
  25: 1_000_000,
  // Levels 26-40 extend the same geometric requirement curve
  // (round(a * (g^L - 1) / (g - 1)), g = REQUIREMENT_GROWTH, total(25) = 1,000,000).
  26: 1_129_902,
  27: 1_275_743,
  28: 1_439_481,
  29: 1_623_310,
  30: 1_829_697,
  31: 2_061_409,
  32: 2_321_554,
  33: 2_613_621,
  34: 2_941_527,
  35: 3_309_670,
  36: 3_722_986,
  37: 4_187_020,
  38: 4_707_995,
  39: 5_292_897,
  40: 5_949_572
} as const;

/** Lifetime XP at the level cap; XP beyond it cycles post-cap rewards and stays banked. */
export const MAX_CURRENT_ERA_XP: number = TOTAL_XP_FOR_LEVEL[CURRENT_LEVEL_CAP];

export type ProgressionSourceType = "combat" | "harvest" | "development";

export type PveCombatStats = {
  maxHealth: number;
  attackPower: number;
  defense: number;
  attackIntervalMs: number;
  attackRangeM: number;
};

export type ProgressionSnapshot = {
  playerId: string;
  totalXp: number;
  level: number;
  curveVersion: number;
  persistenceVersion: number;
  xpIntoLevel: number;
  xpForNextLevel: number | null;
  nextLevelTotalXp: number | null;
  atCap: boolean;
  pveStats: PveCombatStats;
};

export type XpGrantResult = {
  operationKey: string;
  sourceType: ProgressionSourceType;
  sourceId: string | null;
  requestedXp: number;
  grantedXp: number;
  discardedXp: number;
  previousXp: number;
  resultingXp: number;
  previousLevel: number;
  resultingLevel: number;
  levelsGained: number[];
  replayed: boolean;
  progression: ProgressionSnapshot;
  enchantmentStoneRewards?: Array<{
    itemId: "enchantment_stone";
    variant: EnchantmentStoneVariant;
  }>;
  inventory?: PlayerInventorySnapshot;
};

export const HARVEST_XP_BY_RESOURCE: Readonly<Record<ResourceType, number>> = {
  wood: 0,
  stone: 24,
  coal: 24,
  iron: 24,
  sulfur: 24,
  slag: 0,
  iron_bar: 0,
  venomsteel_bar: 0,
  venomsteel_core: 0,
  fire_feather: 0,
  tempest_quill: 0,
  ice_feather: 0,
  fire_bar: 0,
  fire_core: 0,
  lightning_bar: 0,
  lightning_core: 0,
  ice_bar: 0,
  ice_core: 0,
  food: 16,
  bone: 0,
  fertilizer: 0,
  flux_plant: 0,
  simple_food: 0,
  freshwater_fish: 0,
  ashen_fish: 0,
  ore: 32,
  water: 0,
  // Wild Flax and Loom Cloth stay neutral until a dedicated textile
  // progression authority exists; do not silently award Woodcutter/Mining XP.
  flax_fiber: 0,
  cloth: 0,
  leather: 0,
  deer_hide: 0,
  hog_hide: 0,
  wolf_pelt: 0,
  bear_hide: 0,
  alligator_hide: 0,
  deer_carcass: 0,
  wolf_carcass: 0,
  hog_carcass: 0,
  bear_carcass: 0,
  alligator_carcass: 0,
  wild_carcass: 0,
  squid_flesh: 0,
  squid_meat: 0,
  deer_meat: 0,
  wolf_meat: 0,
  hog_meat: 0,
  bear_meat: 0,
  alligator_meat: 0,
  wild_meat: 0,
  crab_carapace: 0,
  raw_meat: 0,
  shell: 0,
  chitin: 0,
  giving_berry: 0,
  balsam_resin: 0,
  repair_kit: 0,
  torch: 0,
  shovel: 0,
  crude_oil: 0,
  jellyfish_venom: 0,
  brood_silk: 0, refined_oil: 0, raptor_scale: 0, giant_egg: 0, brood_egg: 0, clutch_egg: 0, crawler_egg: 0, broken_whistle: 0, bonewrought_blade: 0, bonewrought_mail: 0, anti_venom_tonic: 0, battle_draught: 0, ember_flask: 0, spark_tonic: 0, field_net: 0, field_trap: 0, lamp_sheath: 0, cinder_lantern: 0, challengers_lantern: 0, survey_stake_kit: 0, compass: 0, elder_acorn: 0, zephyr: 0, cave_lichen: 0, gale_plume: 0, heartsap: 0, wyrm_egg: 0, dragon_scale: 0, maw_bloom_petal: 0, giving_tree_sapling: 0, edict_seal: 0, prison_key_fragment: 0, bricks: 0,
  tidewater_draught: 0, undertow_snare: 0, stillwater_orb: 0, free_step_ward: 0, masons_tome: 0, vigor_serum: 0, mending_resin: 0, loadout_scroll: 0,
  crystal: 0,
  pearl: 0,
  atlas_shrine_shard: 0,
  lichen: 0,
  thistle: 0,
  umbral_essence: 0,
  dusk_heart: 0,
  bloom_petal: 0,
  gearwork_essence: 0,
  gale_splinter: 0,
  griffin_plume: 0,
  skyrise_stone: 0,
  mist_drop: 0,
  revenant_bar: 0,
  expel_bar: 0,
  mirage_bar: 0,
  gale_bar: 0,
  fleet_bar: 0,
  whetted_bar: 0,
  vengeance_bar: 0,
  gloom_bar: 0,
  skyrise_bar: 0,
  vital_bar: 0,
  enchantment_stone: 0,
  lumen: 0,
  gift_box: 0,
  manor_skin: 0,
  face_mask: 0,
  shellback_plate: 0,
  abyssal_orb: 0,
  ring_shard: 0,
  forge_spark: 0,
  shard_grit: 0,
  amulet_clasp: 0,
  frog_legs: 0,
  frost_frog_legs: 0,
  poison_frog_legs: 0,
  desert_toad_legs: 0,
  crab_meat: 0,
  ice_crab_meat: 0,
  sand_crab_meat: 0,
  mangrove_crab_meat: 0,
  small_catch: 0,
  jellyfish_jelly: 0,
  crawler_flesh: 0,
  squid_cut: 0,
  wolf_cut: 0,
  frost_wolf_cut: 0,
  dune_wolf_cut: 0,
  jungle_wolf_cut: 0,
  bog_wolf_cut: 0,
  deer_cut: 0,
  frost_deer_cut: 0,
  jungle_deer_cut: 0,
  marsh_deer_cut: 0,
  sand_deer_cut: 0,
  hog_cut: 0,
  woolly_hog_cut: 0,
  warthog_cut: 0,
  jungle_hog_cut: 0,
  mud_hog_cut: 0,
  javelina_cut: 0,
  alligator_tail: 0,
  caiman_tail: 0,
  crocodile_tail: 0,
  bear_cut: 0,
  snow_bear_cut: 0,
  black_bear_cut: 0,
  sun_bear_cut: 0,
  jungle_tapir_cut: 0,
  jaguar_cut: 0,
  mandrill_cut: 0,
  capercaillie_meat: 0,
  elk_cut: 0,
  red_squirrel_cut: 0,
  badger_cut: 0,
  grey_squirrel_cut: 0,
  stag_beetle_cut: 0,
  great_grey_owl_meat: 0,
  flying_squirrel_cut: 0,
  plains_bison_cut: 0,
  prairie_dog_cut: 0,
  burrowing_owl_meat: 0,
  giraffe_cut: 0,
  lioness_cut: 0,
  spotted_hyena_cut: 0,
  sitatunga_cut: 0,
  emperor_dragonfly_cut: 0,
  mountain_ibex_cut: 0,
  wild_yak_cut: 0,
  alpine_marmot_cut: 0,
  wild_scrub_goat_cut: 0,
  crested_porcupine_cut: 0,
  spur_thighed_tortoise_cut: 0,
  dromedary_cut: 0,
  fennec_fox_cut: 0,
  sidewinder_cut: 0,
  field_hare_cut: 0,
  arctic_hare_cut: 0,
  capybara_cut: 0,
  armadillo_cut: 0,
  red_fox_cut: 0,
  wolverine_cut: 0,
  ostrich_cut: 0,
  golden_eagle_cut: 0,
  musk_ox_cut: 0,
  seal_cut: 0,
  desert_lion_cut: 0,
  saiga_cut: 0,
  wild_horse_cut: 0,
  steppe_marmot_cut: 0,
  lemming_cut: 0,
  snow_goose_meat: 0,
  mammoth_cut: 0,
  dire_wolf_cut: 0,
  drake_cut: 0,
  dragon_cut: 0,
  grub_meat: 0,
  emperor_penguin_meat: 0,
  peary_caribou_cut: 0,
  ice_worm_cut: 0,
  sea_otter_cut: 0,
  herring_gull_meat: 0,
  spiny_lobster_tail: 0,
  hammerhead_shark_steak: 0,
  manta_ray_wing: 0,
  humpback_whale_cut: 0,
  muskellunge_fillet: 0,
  mute_swan_meat: 0,
  pike_fillet: 0,
  snapping_turtle_cut: 0,
  beaver_cut: 0,
  otter_cut: 0,
  salmon_fillet: 0,
  elemental_ration: 0,
  scorching_bird_meat: 0,
  zappy_bird_meat: 0,
  freezing_bird_meat: 0,
  field_ration: 0,
  hearty_ration: 0,
  xoral_essence: 0,
  // Mob drops are never harvested.
  ...Object.fromEntries(MOB_DROP_ITEM_IDS.map((itemId) => [itemId, 0])) as Record<(typeof MOB_DROP_ITEM_IDS)[number], number>
};

export const STANDARD_PVP_MAX_HEALTH = 100;
export const STANDARD_PVP_ATTACK_POWER = 10;
export const STANDARD_PVP_DEFENSE = 0;

export function levelForTotalXp(totalXp: number): number {
  const clamped = Math.min(MAX_CURRENT_ERA_XP, Math.max(0, Math.trunc(totalXp)));
  for (let level = CURRENT_LEVEL_CAP; level >= 0; level -= 1) {
    if (clamped >= totalXpForLevel(level)) {
      return level;
    }
  }
  return 0;
}

/**
 * The character level that counts for gameplay: the stored (paid) level, never above what XP
 * supports. With the Glimmer level-up fee off the two are equal; with it on, XP can bank past
 * the stored level until the player pays for the next level.
 */
export function paidCharacterLevel(totalXp: number, storedLevel: number | string | null | undefined): number {
  const derived = levelForTotalXp(totalXp);
  const stored = Number(storedLevel ?? Number.NaN);
  return Number.isFinite(stored) ? Math.min(Math.max(0, Math.trunc(stored)), derived) : derived;
}

export function totalXpForLevel(level: number): number {
  if (!Number.isInteger(level) || level < 0 || level > CURRENT_LEVEL_CAP) {
    throw new Error(`Level must be between 0 and ${CURRENT_LEVEL_CAP}`);
  }
  return TOTAL_XP_FOR_LEVEL[level as keyof typeof TOTAL_XP_FOR_LEVEL];
}

export function xpProgress(totalXp: number): {
  level: number;
  xpIntoLevel: number;
  xpForNextLevel: number | null;
  nextLevelTotalXp: number | null;
  atCap: boolean;
} {
  const normalized = Math.max(0, Math.trunc(totalXp));
  const level = levelForTotalXp(normalized);
  if (level === CURRENT_LEVEL_CAP) {
    return {
      level,
      xpIntoLevel: (normalized - MAX_CURRENT_ERA_XP) % POST_CAP_XP_PER_REWARD,
      xpForNextLevel: POST_CAP_XP_PER_REWARD,
      nextLevelTotalXp: null,
      atCap: true
    };
  }
  const currentThreshold = totalXpForLevel(level);
  const nextThreshold = totalXpForLevel(level + 1);
  return {
    level,
    xpIntoLevel: normalized - currentThreshold,
    xpForNextLevel: nextThreshold - currentThreshold,
    nextLevelTotalXp: nextThreshold,
    atCap: false
  };
}

export function playerPveStats(
  level: number,
  equipment: { attackPower?: number; defense?: number } = {}
): PveCombatStats {
  void level;
  return {
    maxHealth: resolvePlayerMaxHealth(),
    attackPower: 10 + Math.max(0, Math.trunc(equipment.attackPower ?? 0)),
    defense: Math.max(0, Math.trunc(equipment.defense ?? 0)),
    attackIntervalMs: BASIC_ATTACK_INTERVAL_MS,
    attackRangeM: MELEE_ATTACK_RANGE_M
  };
}

export function damageFromStats(attackerAttackPower: number, defenderDefense: number): number {
  return Math.max(
    1,
    Math.round(
      Math.max(0, attackerAttackPower) * 9 /
        (9 + Math.max(0, defenderDefense))
    )
  );
}

export function standardizedPvpDamage(targetMaxHealth: number): number {
  const standardDamage = damageFromStats(STANDARD_PVP_ATTACK_POWER, STANDARD_PVP_DEFENSE);
  return Math.max(1, Math.round((standardDamage / STANDARD_PVP_MAX_HEALTH) * targetMaxHealth));
}

export function xpLevelDifferenceMultiplier(playerLevel: number, mobLevel: number): number {
  const difference = Math.trunc(mobLevel) - Math.trunc(playerLevel);
  if (difference >= 0) return 1;
  const levelsBelow = Math.abs(difference);
  if (levelsBelow <= 2) return 1;
  if (levelsBelow <= 5) return 0.7;
  if (levelsBelow <= 9) return 0.3;
  return 0.1;
}

export function levelUpHealth(
  currentHealth: number,
  previousMaxHealth: number,
  nextMaxHealth: number
): number {
  return preserveCurrentHealthPercentage(currentHealth, previousMaxHealth, nextMaxHealth);
}

/**
 * Resolves ordinary launch health and leaves one explicit, capped seam for
 * future exceptional sources. Character level, class rank, ordinary equipment,
 * affinity, inventory size, and combat-kit count never enter this function.
 */
export function resolvePlayerMaxHealth(
  input: { exceptionalModifiers?: readonly PlayerMaxHealthModifier[] } = {}
): number {
  const modifiers = input.exceptionalModifiers ?? [];
  const modifierTotal = modifiers.filter((modifier) => modifier.source !== "debuff").reduce((total, modifier) => {
    if (!PLAYER_MAX_HEALTH_EXCEPTION_SOURCES.includes(modifier.source)) {
      throw new Error(`Unsupported maximum-health source: ${modifier.source}`);
    }
    if (modifier.sourceId.length === 0 || modifier.sourceId.length > 160) {
      throw new Error("Maximum-health source ID must contain 1 to 160 characters");
    }
    if (!Number.isFinite(modifier.flatBonus)) {
      throw new Error("Maximum-health modifier must be finite");
    }
    return total + Math.trunc(modifier.flatBonus);
  }, 0);
  const unpenalized = Math.max(
    1,
    Math.min(
      FUTURE_PLAYER_MAX_HEALTH_SAFETY_CAP,
      BASE_PLAYER_MAX_HEALTH + modifierTotal
    )
  );
  const debuff = modifiers.filter((modifier) => modifier.source === "debuff").reduce((total, modifier) => {
    if (!Number.isFinite(modifier.flatBonus) || modifier.flatBonus > 0) {
      throw new Error("Maximum-health debuff must be a finite non-positive value");
    }
    return total - Math.trunc(modifier.flatBonus);
  }, 0);
  return applyMaxHealthDebuff(unpenalized, debuff);
}

/**
 * Converts retained health exactly once when maximum-health policy changes.
 * Defeated players remain defeated, living players remain alive, injured
 * players cannot round to full, and full players remain full.
 */
export function preserveCurrentHealthPercentage(
  currentHealth: number,
  previousMaxHealth: number,
  nextMaxHealth: number
): number {
  const previousMaximum = Math.max(1, Math.trunc(
    Number.isFinite(previousMaxHealth) ? previousMaxHealth : 1
  ));
  const nextMaximum = Math.max(1, Math.trunc(
    Number.isFinite(nextMaxHealth) ? nextMaxHealth : 1
  ));
  const current = Math.max(0, Math.min(
    previousMaximum,
    Math.trunc(Number.isFinite(currentHealth) ? currentHealth : 0)
  ));
  if (current === 0) return 0;
  if (current >= previousMaximum) return nextMaximum;
  const proportional = Math.max(
    1,
    Math.round(current / previousMaximum * nextMaximum)
  );
  return nextMaximum === 1
    ? 1
    : Math.min(nextMaximum - 1, proportional);
}

