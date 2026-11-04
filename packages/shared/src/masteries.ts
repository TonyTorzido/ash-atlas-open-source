export const WARRIOR_MAX_RANK = 15;
export const PROFESSION_MAX_RANK = 8;
export const WARRIOR_MAX_XP = 72_000;
export const WARRIOR_CURVE_VERSION = 3;
export const WARRIOR_XP_POLICY_VERSION = 1;
export const WARRIOR_XP_PER_TARGET_BASIC_HIT = 2;
export const WARRIOR_REQUIREMENT_GROWTH = 10 ** (1 / 14);
export const PROFESSION_MAX_XP = 100_000;
export const OIL_WORKER_MAX_XP = 25_000;
export const BREEDER_MAX_RANK = 4;
export const PROFESSION_REQUIREMENT_GROWTH = 10 ** (1 / 7);

export const WARRIOR_XP_THRESHOLDS = [
  0, 1_193, 2_600, 4_257, 6_212, 8_515, 11_231, 14_432,
  18_205, 22_652, 27_895, 34_075, 41_360, 49_946, 60_068, 72_000
] as const;

// Launch classes share Warrior Progression V3. Keep the Warrior names as durable
// compatibility aliases while new code uses the class-wide authority.
export const CLASS_MAX_RANK = WARRIOR_MAX_RANK;
export const CLASS_MAX_XP = WARRIOR_MAX_XP;
export const CLASS_CURVE_VERSION = WARRIOR_CURVE_VERSION;
export const CLASS_XP_POLICY_VERSION = WARRIOR_XP_POLICY_VERSION;
export const CLASS_XP_PER_TARGET_BASIC_HIT = WARRIOR_XP_PER_TARGET_BASIC_HIT;
export const CLASS_XP_THRESHOLDS = WARRIOR_XP_THRESHOLDS;

export const PROFESSION_XP_THRESHOLDS = [
  0, 3_021, 7_218, 13_049, 21_152, 32_412, 48_056, 69_795, 100_000
] as const;
export const OIL_WORKER_XP_THRESHOLDS = [
  0, 755, 1_804, 3_262, 5_288, 8_103, 12_014, 17_449, 25_000
] as const;

export const PROFESSION_IDS = ["woodcutter", "miner", "builder", "oil_worker", "metallurgy"] as const;
export type ProfessionId = (typeof PROFESSION_IDS)[number];
/**
 * Retired profession tracks. Their progress, operation and achievement rows
 * stay in the database untouched; code no longer awards, applies, or shows them.
 */
export const RETIRED_PROFESSION_IDS = ["hunter", "breeder"] as const;
export const RETIRED_MASTERY_ACHIEVEMENT_IDS = ["master_hunter", "master_breeder"] as const;
export const RETIRED_MASTERY_TITLES = ["Master Hunter", "Master Breeder"] as const;
export const MASTERY_TRACK_IDS = ["warrior", ...PROFESSION_IDS] as const;
export type MasteryTrackId = (typeof MASTERY_TRACK_IDS)[number];

export const MASTERY_TITLES: Readonly<Record<MasteryTrackId, string>> = {
  warrior: "Master Warrior",
  woodcutter: "Master Woodcutter",
  miner: "Master Miner",
  builder: "Master Builder",
  oil_worker: "Master Oil Worker",
  metallurgy: "Master Metallurgy"
};

export type MasteryProgress = {
  trackId: MasteryTrackId;
  xp: number;
  rank: number;
  maximumRank: number;
  nextRankXp: number | null;
  completedAt: string | null;
  mastered: boolean;
  title: string;
};

export type MasterySnapshot = {
  playerId: string;
  warrior: MasteryProgress;
  professions: Record<ProfessionId, MasteryProgress>;
  achievementIds: string[];
  equippedTitle: string | null;
  serverTime: number;
};

export type MasteryGrantResult = {
  operationKey: string;
  playerId: string;
  trackId: ProfessionId;
  requestedXp: number;
  grantedXp: number;
  previousXp: number;
  resultingXp: number;
  previousRank: number;
  resultingRank: number;
  replayed: boolean;
  newlyMastered: boolean;
  snapshot: MasterySnapshot;
};

export const PROFESSION_XP_AWARDS = {
  woodHarvest: 15,
  stoneMine: 25,
  flagBuild: 25,
  flagReinforcement: 25,
  metallurgyIronSuccess: 1_500,
  metallurgyIronFailure: 1_000,
  metallurgyMetalBar: 3_000
} as const;

export function builderXpForConstruction(baseDurationSeconds: number): number {
  if (!Number.isFinite(baseDurationSeconds) || baseDurationSeconds < 0) {
    throw new Error("Construction duration must be a nonnegative number");
  }
  return Math.round(baseDurationSeconds * 5 / 3);
}

export const WARRIOR_RANKS = [
  "Warrior", "Empowered Hit / Battle Hardened", "Passive Slot I", "Anger Explosion",
  "Class Skill Slot II", "Double Axe Mastery I", "Breastplate Mastery I", "Passive Slot II",
  "Concussive Blow", "Double Axe Mastery II", "Breastplate Mastery II", "Battle Cry",
  "Passive Slot III", "Double Axe Mastery III", "Breastplate Mastery III", "Master Warrior"
] as const;

export const PROFESSION_RANKS: Readonly<Record<ProfessionId, readonly string[]>> = {
  woodcutter: ["Woodcutter", "Practiced Swing I", "Clean Cut I", "Perfect Swing I", "Practiced Swing II", "Clean Cut II", "Chopping Rhythm", "Perfect Swing II", "Master Woodcutter"],
  miner: ["Miner", "Strong Swing I", "Careful Extraction I", "Mine Memory", "Strong Swing II", "Clean Break I", "Unbroken Vein", "Careful Extraction II", "Master Miner"],
  builder: ["Builder", "Apprentice Builder I", "Flagwright I", "Material Recovery I", "Apprentice Builder II", "Reinforcement Specialist", "Material Recovery II", "Journeyman Builder", "Master Builder"],
  oil_worker: ["Oil Worker", "Expanded Tank I", "Well Gauge", "Expanded Tank II", "Remote Monitoring", "Expanded Tank III", "Full-Well Alert", "Expanded Tank IV", "Master Oil Worker"],
  metallurgy: ["Metallurgy", "Furnace Control I", "Slag Recovery I", "Furnace Control II", "Slag Recovery II", "Furnace Control III", "Furnace Control IV", "Furnace Control V", "Master Metallurgy"]
};

export const PROFESSION_DESCRIPTIONS: Readonly<Record<ProfessionId, readonly string[]>> = {
  woodcutter: ["Woodcutter", "+3% woodcutting speed", "3% chance for +1 bonus wood", "2% chance to instantly chop", "+6% woodcutting speed", "6% chance for +1 bonus wood", "+4% chained woodcutting speed", "3% chance to instantly chop", "8% speed / 8% bonus / 4% instant / 5% rhythm"],
  miner: ["Miner", "+3% mining speed", "3% chance for +1 bonus stone", "Exact mine respawn information", "+6% mining speed", "2% chance to instantly mine", "3% chance the mine does not deplete", "6% chance for +1 bonus stone", "8% speed / 8% bonus / 3% instant / 3% unbroken"],
  builder: ["Builder", "+2% general construction speed", "+4% additional flag-building speed", "1% material recovery chance", "+4% general construction speed", "+5% additional reinforcement/repair speed", "2% material recovery chance", "+6% general construction speed", "8% general / 8% flag / 8% reinforcement / 3% recovery"],
  oil_worker: ["120 crude capacity", "124 crude capacity", "128 capacity and exact time until full", "132 crude capacity", "136 capacity and remote well status", "140 crude capacity", "144 capacity and full-well alert", "147 crude capacity", "150 capacity and remote harvest"],
  metallurgy: [
    "Smelt Iron Ore into Iron Bars and earn Metallurgy XP.",
    "Iron smelting succeeds 75% of the time.",
    "Recover 1 Iron Bar from 5 Slag.",
    "Iron smelting succeeds 80% of the time; 16% chance a smelted bar comes out doubled.",
    "Recover 1 Iron Bar from 5 Slag; recovery cost improves at Rank 5.",
    "Iron smelting succeeds 90% of the time; recover 1 Iron Bar from 4 Slag; 34% double-bar chance.",
    "Iron smelting succeeds 90% of the time.",
    "Iron smelting succeeds 90% of the time.",
    "Iron smelting succeeds 100% of the time; recover 1 Iron Bar from 3 Slag; 52% double-bar chance."
  ]
};

/** Used only by the legacy dog breeding service; Breeder is no longer a profession track. */
export const BREEDER_PUBLIC_RANK_LABELS = ["I", "II", "III", "IV", "V"] as const;
export const BREEDER_FOCUS_UNLOCK_RANK = 2;
export const BREEDER_PROBABILITY_CONFIG = [
  { breakthroughMultiplier: 1.00, regressionReductionChance: 0, traitInheritanceAdditivePoints: 0 },
  { breakthroughMultiplier: 1.02, regressionReductionChance: 0.05, traitInheritanceAdditivePoints: 0.02 },
  { breakthroughMultiplier: 1.04, regressionReductionChance: 0.10, traitInheritanceAdditivePoints: 0.03 },
  { breakthroughMultiplier: 1.07, regressionReductionChance: 0.16, traitInheritanceAdditivePoints: 0.05 },
  { breakthroughMultiplier: 1.10, regressionReductionChance: 0.22, traitInheritanceAdditivePoints: 0.08 }
] as const;

export function breederProbabilityConfig(rank: number) {
  const safe = Math.min(BREEDER_MAX_RANK, Math.max(0, Math.trunc(rank)));
  return {
    ...BREEDER_PROBABILITY_CONFIG[safe]!,
    focusUnlocked: safe >= BREEDER_FOCUS_UNLOCK_RANK
  };
}

export function metallurgyIronSuccessChance(rank: number): number {
  const safe = Math.min(PROFESSION_MAX_RANK, Math.max(0, Math.trunc(rank)));
  return safe >= 8 ? 1 : safe >= 5 ? 0.9 : safe >= 2 ? 0.8 : 0.75;
}

/** Chance a smelted bar comes out doubled: Metallurgy ranks 2 / 5 / 8 give 16% / 34% / 52%. */
export function metallurgyDoubleBarChance(rank: number): number {
  const safe = Math.min(PROFESSION_MAX_RANK, Math.max(0, Math.trunc(rank)));
  return safe >= 8 ? 0.52 : safe >= 5 ? 0.34 : safe >= 2 ? 0.16 : 0;
}

export function rankForThresholds(xp: number, thresholds: readonly number[]): number {
  const maximumXp = thresholds.at(-1) ?? 0;
  const safe = Math.min(maximumXp, Math.max(0, Math.trunc(Number.isFinite(xp) ? xp : 0)));
  for (let rank = thresholds.length - 1; rank >= 0; rank -= 1) {
    if (safe >= (thresholds[rank] ?? 0)) return rank;
  }
  return 0;
}

export function warriorRankForXp(xp: number): number {
  return rankForThresholds(xp, WARRIOR_XP_THRESHOLDS);
}

export function classRankForXp(xp: number): number {
  return rankForThresholds(xp, CLASS_XP_THRESHOLDS);
}

export function professionXpThresholds(trackId: ProfessionId): readonly number[] {
  return trackId === "oil_worker" ? OIL_WORKER_XP_THRESHOLDS : PROFESSION_XP_THRESHOLDS;
}

export function professionMaxXp(trackId: ProfessionId): number {
  return trackId === "oil_worker" ? OIL_WORKER_MAX_XP : PROFESSION_MAX_XP;
}

export function professionMaxRank(trackId: ProfessionId): number {
  void trackId;
  return PROFESSION_MAX_RANK;
}

export function professionRankForXp(xp: number, trackId: ProfessionId = "woodcutter"): number {
  return rankForThresholds(xp, professionXpThresholds(trackId));
}

export const OIL_WELL_CAPACITY_BY_OIL_WORKER_RANK = [120, 124, 128, 132, 136, 140, 144, 147, 150] as const;
export function oilWellCapacityForOilWorkerRank(rank: number): number {
  const safe = Math.min(PROFESSION_MAX_RANK, Math.max(0, Math.trunc(rank)));
  return OIL_WELL_CAPACITY_BY_OIL_WORKER_RANK[safe]!;
}

export function professionEffects(trackId: ProfessionId, rank: number) {
  const safe = Math.min(professionMaxRank(trackId), Math.max(0, Math.trunc(rank)));
  if (trackId === "woodcutter") return {
    speedBonus: safe >= 8 ? 0.08 : safe >= 4 ? 0.06 : safe >= 1 ? 0.03 : 0,
    bonusYieldChance: safe >= 8 ? 0.08 : safe >= 5 ? 0.06 : safe >= 2 ? 0.03 : 0,
    instantChance: safe >= 8 ? 0.04 : safe >= 7 ? 0.03 : safe >= 3 ? 0.02 : 0,
    rhythmBonus: safe >= 8 ? 0.05 : safe >= 6 ? 0.04 : 0
  };
  if (trackId === "miner") return {
    speedBonus: safe >= 8 ? 0.08 : safe >= 4 ? 0.06 : safe >= 1 ? 0.03 : 0,
    mineMemory: safe >= 3,
    bonusYieldChance: safe >= 8 ? 0.08 : safe >= 7 ? 0.06 : safe >= 2 ? 0.03 : 0,
    instantChance: safe >= 8 ? 0.03 : safe >= 5 ? 0.02 : 0,
    unbrokenVeinChance: safe >= 6 ? 0.03 : 0
  };
  if (trackId === "builder") return {
    generalSpeedBonus: safe >= 8 ? 0.08 : safe >= 7 ? 0.06 : safe >= 4 ? 0.04 : safe >= 1 ? 0.02 : 0,
    flagSpeedBonus: safe >= 8 ? 0.08 : safe >= 2 ? 0.04 : 0,
    reinforcementSpeedBonus: safe >= 8 ? 0.08 : safe >= 5 ? 0.05 : 0,
    flagRefundChance: safe >= 8 ? 0.03 : safe >= 6 ? 0.02 : safe >= 3 ? 0.01 : 0
  };
  if (trackId === "oil_worker") return {
    capacity: oilWellCapacityForOilWorkerRank(safe),
    exactTimeUntilFull: safe >= 2,
    remoteMonitoring: safe >= 4,
    fullWellAlert: safe >= 6,
    remoteHarvest: safe >= 8
  };
  return {
    ironSuccessChance: metallurgyIronSuccessChance(safe),
    slagRecoveryCost: safe >= 8 ? 3 : safe >= 5 ? 4 : safe >= 2 ? 5 : null,
    slagRecoveryUnlocked: safe >= 2
  };
}

export function warriorEffects(rank: number) {
  const safe = Math.min(WARRIOR_MAX_RANK, Math.max(0, Math.trunc(rank)));
  return {
    normalRageGenerationBonus: safe >= 15 ? 0.06 : safe >= 2 ? 0.04 : 0,
    lowHealthRageGenerationBonus: safe >= 13 ? 0.15 : 0,
    /**
     * Retained compatibility field. Iron Constitution no longer changes
     * launch health; its rank-15 value is represented by the mitigation step.
     */
    maximumHealthBonus: 0,
    permanentDamageReduction: safe >= 15 ? 0.03 : safe >= 4 ? 0.02 : 0,
    punishingStrikeBonus: safe >= 15 ? 0.42 : safe >= 9 ? 0.40 : 0.35,
    guardedStrikeBonus: safe >= 15 ? 0.27 : safe >= 9 ? 0.25 : 0.20,
    guardedStrikeReduction: safe >= 15 ? 0.16 : 0.15,
    guardedStrikeDurationMs: safe >= 15 ? 3_250 : 3_000,
    empoweredRageRefund: safe >= 15 ? 5 : safe >= 11 ? 4 : 0,
    cleavePrimaryMultiplier: safe >= 15 ? 1.05 : 1,
    cleaveSecondaryMultiplier: safe >= 15 ? 0.70 : 0.65,
    cleaveRadiusM: safe >= 8 ? 70 : 60,
    cleaveMaximumSecondaryTargets: safe >= 8 ? 4 : 3,
    cleaveCooldownMs: safe >= 14 ? 7_200 : 8_000,
    fortifyReduction: safe >= 15 ? 0.23 : safe >= 12 ? 0.22 : 0.20,
    fortifyDurationMs: safe >= 15 ? 4_750 : safe >= 12 ? 4_500 : 4_000,
    fortifyCooldownMs: safe >= 14 ? 14_400 : 16_000,
    rageDecayDelayBonusMs: safe >= 6 ? 3_000 : 0,
    rageDecayRateMultiplier: safe >= 6 ? 0.9 : 1
  };
}
