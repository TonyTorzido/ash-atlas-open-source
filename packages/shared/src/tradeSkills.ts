import { GENERAL_SKILL_DEFINITIONS, type GeneralSkillId } from "./skillSystemV3.js";

/**
 * The trade skills are ordinary General Skills (3 ranks, 1 point each, no prerequisites). Their effects
 * live in the systems they gate; this module is the one seam those systems share for rank checks.
 */
export const TRADE_SKILL_IDS = [
  "alchemy", "blacksmithing", "leatherworking", "cartography", "tradecraft"
] as const satisfies readonly GeneralSkillId[];
export type TradeSkillId = (typeof TRADE_SKILL_IDS)[number];

export type TradeSkillGate = Readonly<{ skillId: TradeSkillId; rank: 1 | 2 | 3; action: string }>;

/** Crafting, digging and repair actions that need a trade skill rank. Add new gates here (and nowhere else). */
export const TRADE_SKILL_GATES = Object.freeze({
  artisan_compass: { skillId: "cartography", rank: 1, action: "craft a Compass" },
  craft_survey_stake_kit: { skillId: "cartography", rank: 1, action: "craft a Survey Stake Kit" },
  artisan_shovel: { skillId: "cartography", rank: 2, action: "craft a Shovel" },
  treasure_silver: { skillId: "cartography", rank: 2, action: "see or dig silver treasure" },
  treasure_gold: { skillId: "cartography", rank: 3, action: "see or dig gold treasure" },
  repair_gear: { skillId: "blacksmithing", rank: 1, action: "repair gear" },
  craft_field_trap: { skillId: "blacksmithing", rank: 3, action: "craft a Field Trap" },
  craft_sling: { skillId: "leatherworking", rank: 1, action: "craft a Sling" },
  craft_backpack: { skillId: "leatherworking", rank: 1, action: "craft a Backpack" },
  craft_field_net: { skillId: "leatherworking", rank: 2, action: "craft a Field Net" },
  craft_leather_armor: { skillId: "leatherworking", rank: 3, action: "craft Leather Armor" },
  craft_coinwright_glove: { skillId: "leatherworking", rank: 3, action: "craft a Coinwright Glove" },
  craft_spark_tonic: { skillId: "alchemy", rank: 1, action: "craft a Spark Tonic" },
  craft_anti_venom_tonic: { skillId: "alchemy", rank: 1, action: "craft an Anti-Venom Tonic" },
  craft_battle_draught: { skillId: "alchemy", rank: 2, action: "craft a Battle Draught" },
  craft_ember_flask: { skillId: "alchemy", rank: 3, action: "craft Ember Bombs" },
  craft_mending_resin: { skillId: "alchemy", rank: 1, action: "craft Mending Resin" },
  craft_vigor_serum: { skillId: "alchemy", rank: 2, action: "craft Vigor Serum" }
} as const satisfies Readonly<Record<string, TradeSkillGate>>);
export type TradeSkillGateId = keyof typeof TRADE_SKILL_GATES;

/** Stock or swag equipment craft (by family id) -> the trade skill gate it needs; null when ungated. */
export function equipmentCraftTradeGate(familyId: string): TradeSkillGateId | null {
  return familyId === "sling" ? "craft_sling" : familyId === "leather" ? "craft_leather_armor" : null;
}

/** Field consumable (by item id) -> the trade skill gate its craft needs. */
export const FIELD_CRAFT_TRADE_GATES: Readonly<Partial<Record<string, TradeSkillGateId>>> = Object.freeze({
  field_trap: "craft_field_trap",
  field_net: "craft_field_net",
  spark_tonic: "craft_spark_tonic",
  anti_venom_tonic: "craft_anti_venom_tonic",
  battle_draught: "craft_battle_draught",
  ember_flask: "craft_ember_flask",
  vigor_serum: "craft_vigor_serum",
  mending_resin: "craft_mending_resin"
});

/** A General Skill rank read from a snapshot's `generalSkills` list (0 when not learned or not loaded). */
export function generalSkillRankIn(
  generalSkills: ReadonlyArray<Readonly<{ skillId: string; rank: number }>> | null | undefined,
  skillId: GeneralSkillId
): number {
  return generalSkills?.find((entry) => entry.skillId === skillId)?.rank ?? 0;
}

export function isTradeSkillId(value: unknown): value is TradeSkillId {
  return typeof value === "string" && (TRADE_SKILL_IDS as readonly string[]).includes(value);
}

export function tradeSkillGateMet(gate: TradeSkillGate, rank: number): boolean {
  return Number.isFinite(rank) && rank >= gate.rank;
}

/** "Needs Cartography rank 2 to craft a Shovel." */
export function tradeSkillGateMessage(gate: TradeSkillGate): string {
  return `Needs ${GENERAL_SKILL_DEFINITIONS[gate.skillId].displayName} rank ${gate.rank} to ${gate.action}.`;
}

/** Gear wear scale by Blacksmithing rank: the base loss shrinks by 1.4x/1.8x/2.6x (gear lasts that much longer). */
export function blacksmithingWearLoss(baseLoss: number, rank: number): number {
  const divisor = rank >= 3 ? 2.6 : rank === 2 ? 1.8 : rank === 1 ? 1.4 : 1;
  return Math.max(0, Math.round(baseLoss / divisor));
}

/** Leatherworking: rank 1 +2 Defense and rank 2 +2 Attack versus leather-dropping monsters; rank 3 double leather. */
export const LEATHERWORKING_DEFENSE_MIN_RANK = 1;
export const LEATHERWORKING_ATTACK_MIN_RANK = 2;
/** Flat Defense / Attack granted once the matching rank is learned. */
export const LEATHERWORKING_MATCHUP_BONUS = 2;
export const LEATHERWORKING_DOUBLE_LEATHER_MIN_RANK = 3;
export const LEATHERWORKING_DOUBLE_LEATHER_CHANCE = 0.22;

/** Alchemy: rank 1 Giving Berries heal 45% more; rank 2 tonics last 40% longer; rank 3 stronger Ember Bombs. */
export const ALCHEMY_RESIN_MIN_RANK = 1;
export const ALCHEMY_RESIN_MULTIPLIER = 1.45;
export const ALCHEMY_DURATION_MIN_RANK = 2;
export const ALCHEMY_DURATION_MULTIPLIER = 1.4;
export const ALCHEMY_EMBER_MIN_RANK = 3;
export const ALCHEMY_EMBER_DAMAGE_MULTIPLIER = 1.22;
/** Opened Guard damage bonus (the same strength as Quarry Sense rank 1: 1.4x). */
export const ALCHEMY_OPENED_GUARD_AMOUNT = 0.4;

/** Leatherworking rank 3: a thrown Field Net comes back 70% of the time. */
export const LEATHERWORKING_NET_RETURN_MIN_RANK = 3;
export const LEATHERWORKING_NET_RETURN_CHANCE = 0.7;
