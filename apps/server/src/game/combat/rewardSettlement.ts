import {
  CLASS_XP_POLICY_VERSION,
  DEFAULT_SKILL_SYSTEM_V3_RUNTIME_CAPABILITIES,
  isGeneralSkillAvailable,
  type SkillSystemV3RuntimeCapabilities,
  INSPIRATION_BONUS_PERCENT,
  KINGDOM_PERK_PRISM_HOLDINGS_QUANTITY,
  monolithHunterYield,
  LAND_OWNER_BONUS_POLICY_VERSION,
  LEATHERWORKING_DOUBLE_LEATHER_CHANCE,
  LEATHERWORKING_DOUBLE_LEATHER_MIN_RANK,
  MAX_EQUIPMENT_LEVEL,
  isLaunchClassId,
  xpLevelDifferenceMultiplier,
  type ClassId,
  type MobArchetypeKey,
  isHumanoidMobArchetype,
  ROGUE_HUMANOID_GOLD_PROC_CHANCE,
  rogueHumanoidGoldAmount,
  type DroppedItemSnapshot,
  type LatLon,
  type PlayerInventorySnapshot,
  RESOURCE_TYPES,
  CINDER_LANTERN_DROP_MULTIPLIER,
  type ResourceType,
  type XpGrantResult,
  MOB_SPAWN_RULES,
  type RingDefinitionId,
  rollRingDrops,
  seededRingRandom,
  type RingDropSource
} from "@ash-atlas/shared";
import { createHash, randomUUID } from "node:crypto";
import type pg from "pg";

import type { AppLogger } from "../../logger.js";
import type { ProgressionService } from "../progression.js";
import type { ClassService, CombatMasteryGrantResult } from "../classes/classService.js";
import type { InventoryService } from "../inventory.js";
import type { MasteryService } from "../masteries.js";
import type { WalletOperationResult, WalletService } from "../wallet.js";
import type { CityTreasuryService } from "../cityTreasury.js";
import { settlePhysicalItemRewardInTransaction } from "../droppedItems.js";
import { recordCreatureBookKillInTransaction } from "../creatureBook.js";
import { kingdomBrickYieldAt } from "../kingdomBrickYield.js";
import { NO_KINGDOM_HUNTING_PERKS, kingdomHuntingPerksAt, playerHasKingdomPerk } from "../kingdomPerks.js";
import { prismHoldingsHit, payKingdomLegendaryRingPerkInTransaction } from "../kingdomRewardPerks.js";
import { creditLandOwnerBonusInTransaction, type LandBonusPayout } from "../landOwnerBonus.js";
import { inspirationActive } from "../fieldConsumables.js";
import { kingdomBrickYieldRoll } from "../kingdomBrickYield.js";
import { monolithHunterQuantity } from "../monoliths.js";
import { cinderLanternDoublesDrops } from "../cinderLanterns.js";
import type { CombatDefeatSettlementCandidate } from "./combatEngine.js";
import {
  grantRingFindInTransaction,
  overworldRingGroundPlacement,
  type RingFindEquipment,
  type RingFindResult
} from "../ringFinds.js";
import { GOLEM_FORGE_MAX_GROUP_GOLD_MULTIPLIER } from "../golemForge.js";

type RingDropEquipment = RingFindEquipment;

/** Summoned adds and non-creatures never drop rings (undead and split children never settle). */
const RING_NO_DROP_MOBS: ReadonlySet<string> = new Set([
  "training_dummy", "hollin_hut", "hollin_brute", "hollin_elder", "hollin_helper"
]);
/** Rare named bosses: 45% plus a second 12% ring roll. */
const RING_LEGENDARY_MOBS: ReadonlySet<string> = new Set(["fire_bird", "lightning_bird", "ice_bird"]);

export function ringDropSourceFor(mobArchetype: string, boss: boolean, summoned = false): RingDropSource | null {
  if (summoned || RING_NO_DROP_MOBS.has(mobArchetype)) return null;
  if (RING_LEGENDARY_MOBS.has(mobArchetype)) return "legendary";
  const rules = (MOB_SPAWN_RULES as Readonly<Record<string, readonly Readonly<{ rarity?: string }>[] | undefined>>)[mobArchetype] ?? [];
  if (boss || rules.some((rule) => rule.rarity === "boss")) return "boss";
  if (rules.some((rule) => rule.rarity === "elite")) return "elite";
  return "normal";
}
import {
  BASE_XP_PER_HIT_EQUIVALENT,
  COMBAT_ITEM_REWARD_POLICY_VERSION,
  COMBAT_XP_POLICY_VERSION,
  MOB_DEFINITIONS,
  mobXpHitCount,
  MOB_XP_LEVEL_GROWTH,
  METAL_MATERIAL_ROLL_PREFIX,
  MOB_VALUE_BASIC_ITEM_IDS,
  MOB_VALUE_DROP_ROLL_IDS,
  PEARL_DROP_ROLL_ID,
  PET_EGG_DROP_ROLL_ID,
  requireMobDefinition,
  type ChanceBasedItemReward
} from "./mobDefinitions.js";

export const MAX_SETTLEMENT_WORKERS = 2;
const SETTLEMENT_LEASE_SECONDS = 30;

export type CombatRewardShare = {
  playerId: string;
  damage: number;
  playerLevel: number;
  levelMultiplier: number;
  contributionShare: number;
  requestedXp: number;
  activeClassId: ClassId | null;
  requestedClassXp: number;
};

export type CombatSettlementResult = {
  settlementKey: string;
  mobArchetype: MobArchetypeKey;
  mobLevel: number;
  mobBalanceVersion: number;
  xpPolicyVersion: number;
  itemRewardPolicyVersion: number;
  targetBasicHitCount: number;
  baseXpPool: number;
  calculatedXpPool: number;
  classXpPolicyVersion: number;
  baseClassXpPool: number;
  groupSize: number;
  shares: Array<CombatRewardShare & { grant: XpGrantResult; classGrant?: CombatMasteryGrantResult }>;
  mobReward?: {
    playerId: string;
    items: Array<{ itemId: ResourceType; quantity: number }>;
    drops?: DroppedItemSnapshot[];
    gold: number;
    /** Extra Gold from the Rogue humanoid-kill proc, on top of `gold`. */
    rogueBonusGold?: number;
    inventory: PlayerInventorySnapshot;
    walletGold?: string;
    walletVersion?: string;
    cityCoins: number;
    cityId: string | null;
    cityTreasuryBalance: string | null;
    cityContribution: string | null;
    /** Set only when this settlement minted a land owner hunting bonus; the hunter's reward above is unchanged. */
    landBonus?: LandBonusPayout;
    /** Rings found on this kill; a full bag leaves the ring on the ground at the loot pile. */
    rings?: Array<{ definitionId: RingDefinitionId; onGround: boolean; lost?: boolean; lat?: number; lon?: number }>;
  };
  replayed: boolean;
};

export type SettlementMetrics = {
  queueDepth: number;
  oldestPendingAgeMs: number;
  processingCount: number;
  retries: number;
  failures: number;
  completed: number;
  droppedAtCapacity: number;
  totalLatencyMs: number;
};

export type SettlementWorkerState = {
  running: boolean;
  flushInProgress: boolean;
  intervalMs: number | null;
  lastSuccessfulRunAt: string | null;
  lastError: string | null;
};

type PreparedSettlement = {
  settlementKey: string;
  mobArchetype: MobArchetypeKey;
  mobLevel: number;
  mobBalanceVersion: number;
  xpPolicyVersion: number;
  itemRewardPolicyVersion: number;
  targetBasicHitCount: number;
  baseXpPool: number;
  calculatedXpPool: number;
  classXpPolicyVersion: number;
  baseClassXpPool: number;
  shares: CombatRewardShare[];
  rewardRecipientPlayerId: string | null;
  rewardCityId: string | null;
  rewardMembershipId: string | null;
  atlasShrineShardQuantity: number;
  scavengeRank: number;
  leatherworkingRank: number;
  /** Rogue rank of the reward recipient when this kill can pay the humanoid Gold proc (frozen at defeat), else 0. */
  rogueGoldProcRank: number;
  /** 0 for settlements queued before the land owner bonus existed: they never pay it. */
  landBonusPolicyVersion: number;
  /** The defeated mob was summoned (boss add, raid defender, minion, pet...): never a ring source. */
  summoned: boolean;
  /** Golem Forge group gold bonus frozen in the durable candidate (1 = none). */
  groupGoldMultiplier: number;
  lootLocation: Readonly<{
    regionCode: string;
    zoneId: string;
    position: LatLon;
  }> | null;
};

type DurableCombatDefeatSettlementCandidate = CombatDefeatSettlementCandidate & Readonly<{
  scavengeRank?: number;
  leatherworkingRank?: number;
  rogueGoldProcRank?: number;
  landBonusPolicyVersion?: number;
}>;

type CombatItemRewardPolicy = Readonly<{
  items: readonly Readonly<{ itemId: ResourceType; quantity: number }>[];
  chanceItems: readonly ChanceBasedItemReward[];
  delivery: "inventory" | "ground";
}>;

const LEGACY_V1_ITEM_REWARDS: Readonly<Partial<Record<MobArchetypeKey, Omit<CombatItemRewardPolicy, "delivery">>>> =
  Object.freeze({
    deer: Object.freeze({
      items: Object.freeze([]),
      chanceItems: Object.freeze([
        Object.freeze({ itemId: "leather", quantity: 1, probability: 0.5, rollId: "leather_quantity" }),
        Object.freeze({ itemId: "leather", quantity: 2, probability: 0.3, rollId: "leather_quantity" }),
        Object.freeze({ itemId: "leather", quantity: 3, probability: 0.2, rollId: "leather_quantity" })
      ])
    }),
    wolf: Object.freeze({ items: Object.freeze([{ itemId: "leather" as const, quantity: 2 }]), chanceItems: Object.freeze([]) }),
    bear: Object.freeze({ items: Object.freeze([{ itemId: "leather" as const, quantity: 15 }]), chanceItems: Object.freeze([]) }),
    hog: Object.freeze({ items: Object.freeze([{ itemId: "leather" as const, quantity: 2 }]), chanceItems: Object.freeze([]) }),
    alligator: Object.freeze({ items: Object.freeze([{ itemId: "leather" as const, quantity: 4 }]), chanceItems: Object.freeze([]) }),
    ogre: Object.freeze({ items: Object.freeze([{ itemId: "stone" as const, quantity: 1 }]), chanceItems: Object.freeze([]) }),
    mysterious_traveler: Object.freeze({ items: Object.freeze([{ itemId: "balsam_resin" as const, quantity: 25 }]), chanceItems: Object.freeze([]) }),
    sap_crawler: Object.freeze({
      items: Object.freeze([]),
      chanceItems: Object.freeze([
        Object.freeze({ itemId: "balsam_resin", quantity: 1, probability: 0.5, rollId: "resin" }),
        Object.freeze({ itemId: "wood", quantity: 1, probability: 0.1, rollId: "wood" })
      ])
    }),
    coastal_crab: Object.freeze({ items: Object.freeze([{ itemId: "crab_carapace" as const, quantity: 1 }]), chanceItems: Object.freeze([]) }),
    squid: Object.freeze({ items: Object.freeze([{ itemId: "squid_flesh" as const, quantity: 1 }]), chanceItems: Object.freeze([]) }),
    jellyfish: Object.freeze({ items: Object.freeze([{ itemId: "jellyfish_venom" as const, quantity: 1 }]), chanceItems: Object.freeze([]) })
  });

const LEGACY_V2_ITEM_REWARDS: Readonly<Partial<Record<MobArchetypeKey, Omit<CombatItemRewardPolicy, "delivery">>>> =
  Object.freeze({
    deer: Object.freeze({
      items: Object.freeze([]),
      chanceItems: Object.freeze([
        Object.freeze({ itemId: "deer_hide", quantity: 1, probability: 0.5, rollId: "deer_hide_quantity" }),
        Object.freeze({ itemId: "deer_hide", quantity: 2, probability: 0.3, rollId: "deer_hide_quantity" }),
        Object.freeze({ itemId: "deer_hide", quantity: 3, probability: 0.2, rollId: "deer_hide_quantity" })
      ])
    }),
    wolf: Object.freeze({ items: Object.freeze([{ itemId: "wolf_pelt" as const, quantity: 1 }]), chanceItems: Object.freeze([]) }),
    bear: Object.freeze({ items: Object.freeze([{ itemId: "bear_hide" as const, quantity: 1 }]), chanceItems: Object.freeze([]) }),
    hog: Object.freeze({ items: Object.freeze([{ itemId: "hog_hide" as const, quantity: 1 }]), chanceItems: Object.freeze([]) }),
    alligator: Object.freeze({ items: Object.freeze([{ itemId: "alligator_hide" as const, quantity: 1 }]), chanceItems: Object.freeze([]) }),
    ogre: Object.freeze({ items: Object.freeze([{ itemId: "stone" as const, quantity: 1 }]), chanceItems: Object.freeze([]) }),
    mysterious_traveler: Object.freeze({ items: Object.freeze([{ itemId: "balsam_resin" as const, quantity: 25 }]), chanceItems: Object.freeze([]) }),
    sap_crawler: Object.freeze({
      items: Object.freeze([]),
      chanceItems: Object.freeze([
        Object.freeze({ itemId: "balsam_resin", quantity: 1, probability: 0.5, rollId: "resin" }),
        Object.freeze({ itemId: "wood", quantity: 1, probability: 0.1, rollId: "wood" })
      ])
    }),
    coastal_crab: Object.freeze({ items: Object.freeze([{ itemId: "crab_carapace" as const, quantity: 1 }]), chanceItems: Object.freeze([]) }),
    squid: Object.freeze({ items: Object.freeze([{ itemId: "squid_flesh" as const, quantity: 1 }]), chanceItems: Object.freeze([]) }),
    jellyfish: Object.freeze({ items: Object.freeze([{ itemId: "jellyfish_venom" as const, quantity: 1 }]), chanceItems: Object.freeze([]) })
  });

const LEGACY_V3_ITEM_REWARDS: Readonly<Partial<Record<MobArchetypeKey, Omit<CombatItemRewardPolicy, "delivery"> & Pick<CombatItemRewardPolicy, "delivery">>>> =
  Object.freeze({
    training_dummy: Object.freeze({ items: Object.freeze([]), chanceItems: Object.freeze([]), delivery: "inventory" }),
    deer: Object.freeze({
      items: Object.freeze([]),
      chanceItems: Object.freeze([
        Object.freeze({ itemId: "leather", quantity: 1, probability: 0.5, rollId: "leather_quantity" }),
        Object.freeze({ itemId: "leather", quantity: 2, probability: 0.3, rollId: "leather_quantity" }),
        Object.freeze({ itemId: "leather", quantity: 3, probability: 0.2, rollId: "leather_quantity" }),
        Object.freeze({ itemId: "deer_hide", quantity: 1, probability: 0.00001, rollId: "rare_hide" })
      ]),
      delivery: "inventory"
    }),
    wolf: Object.freeze({
      items: Object.freeze([{ itemId: "leather" as const, quantity: 2 }]),
      chanceItems: Object.freeze([
        Object.freeze({ itemId: "wolf_pelt", quantity: 1, probability: 0.00001, rollId: "rare_hide" })
      ]),
      delivery: "inventory"
    }),
    goblin: Object.freeze({ items: Object.freeze([]), chanceItems: Object.freeze([]), delivery: "inventory" }),
    bandit: Object.freeze({ items: Object.freeze([]), chanceItems: Object.freeze([]), delivery: "inventory" }),
    orc_brute: Object.freeze({ items: Object.freeze([]), chanceItems: Object.freeze([]), delivery: "inventory" }),
    ogre: Object.freeze({
      items: Object.freeze([{ itemId: "stone" as const, quantity: 1 }]),
      chanceItems: Object.freeze([]),
      delivery: "inventory"
    }),
    bear: Object.freeze({
      items: Object.freeze([{ itemId: "leather" as const, quantity: 15 }]),
      chanceItems: Object.freeze([
        Object.freeze({ itemId: "bear_hide", quantity: 1, probability: 0.00001, rollId: "rare_hide" })
      ]),
      delivery: "inventory"
    }),
    mysterious_traveler: Object.freeze({
      items: Object.freeze([{ itemId: "balsam_resin" as const, quantity: 25 }]),
      chanceItems: Object.freeze([]),
      delivery: "inventory"
    }),
    sap_crawler: Object.freeze({
      items: Object.freeze([]),
      chanceItems: Object.freeze([
        Object.freeze({ itemId: "balsam_resin", quantity: 1, probability: 0.5, rollId: "resin" }),
        Object.freeze({ itemId: "wood", quantity: 1, probability: 0.1, rollId: "wood" })
      ]),
      delivery: "inventory"
    }),
    hog: Object.freeze({
      items: Object.freeze([{ itemId: "leather" as const, quantity: 8 }]),
      chanceItems: Object.freeze([
        Object.freeze({ itemId: "hog_hide", quantity: 1, probability: 0.00001, rollId: "rare_hide" })
      ]),
      delivery: "inventory"
    }),
    coastal_crab: Object.freeze({
      items: Object.freeze([{ itemId: "crab_carapace" as const, quantity: 1 }]),
      chanceItems: Object.freeze([
        Object.freeze({ itemId: "crude_oil", quantity: 1, probability: 0.5, rollId: "crude_oil" })
      ]),
      delivery: "inventory"
    }),
    frog: Object.freeze({ items: Object.freeze([]), chanceItems: Object.freeze([]), delivery: "inventory" }),
    alligator: Object.freeze({
      items: Object.freeze([{ itemId: "leather" as const, quantity: 8 }]),
      chanceItems: Object.freeze([
        Object.freeze({ itemId: "alligator_hide", quantity: 1, probability: 0.00001, rollId: "rare_hide" })
      ]),
      delivery: "inventory"
    }),
    squid: Object.freeze({
      items: Object.freeze([{ itemId: "squid_flesh" as const, quantity: 1 }]),
      chanceItems: Object.freeze([
        Object.freeze({ itemId: "crude_oil", quantity: 1, probability: 0.5, rollId: "crude_oil" })
      ]),
      delivery: "inventory"
    }),
    jellyfish: Object.freeze({
      items: Object.freeze([{ itemId: "jellyfish_venom" as const, quantity: 1 }]),
      chanceItems: Object.freeze([
        Object.freeze({ itemId: "crude_oil", quantity: 1, probability: 0.5, rollId: "crude_oil" })
      ]),
      delivery: "inventory"
    }),
    fire_bird: Object.freeze({
      items: Object.freeze([{ itemId: "fire_feather" as const, quantity: 1 }]),
      chanceItems: Object.freeze([]),
      delivery: "ground"
    }),
    lightning_bird: Object.freeze({
      items: Object.freeze([{ itemId: "tempest_quill" as const, quantity: 1 }]),
      chanceItems: Object.freeze([]),
      delivery: "ground"
    }),
    ice_bird: Object.freeze({
      items: Object.freeze([{ itemId: "ice_feather" as const, quantity: 1 }]),
      chanceItems: Object.freeze([]),
      delivery: "ground"
    }),
    xoral: Object.freeze({ items: Object.freeze([]), chanceItems: Object.freeze([]), delivery: "inventory" })
  });

// V4 was the aquatic 5% oil policy. Keep it materialized independently of
// the live catalog so delayed V4 settlements can never receive V5 carcasses.
const LEGACY_V4_ITEM_REWARDS: Readonly<Partial<Record<MobArchetypeKey, CombatItemRewardPolicy>>> =
  Object.freeze(Object.fromEntries(
    Object.entries(LEGACY_V3_ITEM_REWARDS).map(([mobArchetype, policy]) => [
      mobArchetype,
      policy && Object.freeze({
        ...policy,
        items: Object.freeze([...policy.items]),
        chanceItems: Object.freeze(policy.chanceItems.map((reward) => Object.freeze(
          reward.rollId === "crude_oil"
            ? { ...reward, probability: 0.05 }
            : reward
        )))
      })
    ])
  )) as Readonly<Partial<Record<MobArchetypeKey, CombatItemRewardPolicy>>>;

// V5 added the carcass rolls to the otherwise unchanged V4 policy. Keep that
// policy frozen before the live V6 universal-food catalog replaces it; replay
// and delayed settlement must retain the exact historical reward identity.
const LEGACY_V5_CARCASS_REWARDS: Readonly<Partial<Record<MobArchetypeKey, ChanceBasedItemReward>>> =
  Object.freeze({
    deer: Object.freeze({ itemId: "deer_carcass", quantity: 1, probability: 0.2, rollId: "species_carcass" }),
    wolf: Object.freeze({ itemId: "wolf_carcass", quantity: 1, probability: 0.2, rollId: "species_carcass" }),
    hog: Object.freeze({ itemId: "hog_carcass", quantity: 1, probability: 0.2, rollId: "species_carcass" }),
    bear: Object.freeze({ itemId: "bear_carcass", quantity: 1, probability: 0.25, rollId: "species_carcass" }),
    alligator: Object.freeze({ itemId: "alligator_carcass", quantity: 1, probability: 0.25, rollId: "species_carcass" })
  });

const LEGACY_V5_ITEM_REWARDS: Readonly<Partial<Record<MobArchetypeKey, CombatItemRewardPolicy>>> =
  Object.freeze(Object.fromEntries(
    Object.entries(LEGACY_V4_ITEM_REWARDS).map(([mobArchetype, policy]) => {
      const carcass = LEGACY_V5_CARCASS_REWARDS[mobArchetype as MobArchetypeKey];
      return [
        mobArchetype,
        policy && Object.freeze({
          ...policy,
          items: Object.freeze([...policy.items]),
          chanceItems: Object.freeze([
            ...policy.chanceItems,
            ...(carcass ? [carcass] : [])
          ])
        })
      ];
    })
  )) as Readonly<Partial<Record<MobArchetypeKey, CombatItemRewardPolicy>>>;

// V6 was the live universal-food policy before Skeleton was introduced. Keep
// its existing mob identities available for delayed/replayed V6 settlements;
// a historical Skeleton candidate has no reward policy because Skeleton did
// not exist in that version.
// V7 is the live catalog before V8 added the Jellyfish Pearl roll and V8 is the catalog before V9
// added the pet egg rolls. V9 is the catalog before V10 added the metal material rolls, and V10
// the catalog before V11 added the mob value pass drops and Feather basics. They derive from the
// live definitions, so strip every later roll and guaranteed item.
function frozenItemRewards(
  excluded: ReadonlySet<string>,
  laterRollIds: ReadonlySet<string>,
  stripMetalMaterials = true
): Readonly<Partial<Record<MobArchetypeKey, CombatItemRewardPolicy>>> {
  return Object.freeze(Object.fromEntries(
    Object.entries(MOB_DEFINITIONS)
      .filter(([mobArchetype]) => !excluded.has(mobArchetype))
      .map(([mobArchetype, definition]) => [
        mobArchetype,
        Object.freeze({
          items: Object.freeze(definition.rewards.items
            .filter((reward) => !MOB_VALUE_BASIC_ITEM_IDS.has(reward.itemId))),
          chanceItems: Object.freeze(definition.rewards.chanceItems
            .filter((reward) => !laterRollIds.has(reward.rollId) && !MOB_VALUE_DROP_ROLL_IDS.has(reward.rollId))
            .filter((reward) => !(stripMetalMaterials && reward.rollId.startsWith(METAL_MATERIAL_ROLL_PREFIX)))
            .map((reward) => Object.freeze({ ...reward }))),
          delivery: definition.rewards.itemDelivery ?? "inventory"
        })
      ])
  )) as Readonly<Partial<Record<MobArchetypeKey, CombatItemRewardPolicy>>>;
}

const LEGACY_V6_ITEM_REWARDS = frozenItemRewards(new Set(["skeleton"]), new Set([PEARL_DROP_ROLL_ID, PET_EGG_DROP_ROLL_ID]));
const LEGACY_V7_ITEM_REWARDS = frozenItemRewards(new Set(), new Set([PEARL_DROP_ROLL_ID, PET_EGG_DROP_ROLL_ID]));
const LEGACY_V8_ITEM_REWARDS = frozenItemRewards(new Set(), new Set([PET_EGG_DROP_ROLL_ID]));
const LEGACY_V9_ITEM_REWARDS = frozenItemRewards(new Set(), new Set());
const LEGACY_V10_ITEM_REWARDS = frozenItemRewards(new Set(), new Set(), false);

export function scaledMobGoldReward(input: Readonly<{
  baseGold: number;
  mobLevel: number;
  settlementKey: string;
}>): number {
  const baseGold = Math.max(0, Math.trunc(input.baseGold));
  const mobLevel = Math.max(0, Math.min(MAX_EQUIPMENT_LEVEL, Math.trunc(input.mobLevel)));
  if (baseGold === 0) return 0;
  const exact = baseGold * (1.02 ** mobLevel);
  const whole = Math.floor(exact);
  const fraction = exact - whole;
  return whole + (
    deterministicRewardUnit(
      "progression-curve-v2-gold-rounding",
      input.settlementKey,
      baseGold,
      mobLevel
    ) < fraction
      ? 1
      : 0
  );
}

export function scaledMobXpPool(input: Readonly<{
  baseXpPool: number;
  mobLevel: number;
  settlementKey: string;
}>): number {
  const baseXpPool = Math.max(0, Math.trunc(input.baseXpPool));
  const mobLevel = Math.max(0, Math.min(MAX_EQUIPMENT_LEVEL, Math.trunc(input.mobLevel)));
  if (baseXpPool === 0) return 0;
  const exact = baseXpPool * (MOB_XP_LEVEL_GROWTH ** mobLevel);
  const whole = Math.floor(exact);
  const fraction = exact - whole;
  return whole + (
    deterministicRewardUnit(
      "progression-curve-v3-xp-rounding",
      input.settlementKey,
      baseXpPool,
      mobLevel
    ) < fraction
      ? 1
      : 0
  );
}

export function scaledLegacyV2MobXpPool(input: Readonly<{
  baseXpPool: number;
  mobLevel: number;
  settlementKey: string;
}>): number {
  const baseXpPool = Math.max(0, Math.trunc(input.baseXpPool));
  const mobLevel = Math.max(0, Math.min(MAX_EQUIPMENT_LEVEL, Math.trunc(input.mobLevel)));
  if (baseXpPool === 0) return 0;
  const exact = baseXpPool * (1.05 ** mobLevel);
  const whole = Math.floor(exact);
  const fraction = exact - whole;
  return whole + (
    deterministicRewardUnit(
      "progression-curve-v2-xp-rounding",
      input.settlementKey,
      baseXpPool,
      mobLevel
    ) < fraction
      ? 1
      : 0
  );
}

export function atlasShrineShardQuantityForOgreRoll(roll: number): 0 | 1 | 2 {
  if (!Number.isFinite(roll) || roll < 0 || roll >= 1) {
    throw new Error("Ogre Atlas Shrine Shard roll must be in [0, 1)");
  }
  if (roll < 0.5) return 0;
  if (roll < 0.9) return 1;
  return 2;
}

/**
 * Applies a drop-chance multiplier. A weighted roll (several rewards sharing a
 * rollId) scales as one: its total chance is capped at 1, so a roll that always
 * drops (Deer leather) is unchanged and a metal range never sums past 1.
 */
export function scaleChanceItemRewards(
  rewards: readonly ChanceBasedItemReward[],
  multiplier: number
): readonly ChanceBasedItemReward[] {
  if (multiplier === 1) return rewards;
  const totals = new Map<string, number>();
  for (const reward of rewards) totals.set(reward.rollId, (totals.get(reward.rollId) ?? 0) + reward.probability);
  return rewards.map((reward) => {
    const total = totals.get(reward.rollId)!;
    const factor = total > 0 ? Math.min(multiplier, 1 / total) : 1;
    return { ...reward, probability: Math.min(1, reward.probability * factor) };
  });
}

export function resolveChanceBasedItemRewards(input: Readonly<{
  settlementKey: string;
  mobArchetype: MobArchetypeKey;
  mobBalanceVersion: number;
  rewards: readonly ChanceBasedItemReward[];
  unitForRoll?: (reward: ChanceBasedItemReward, index: number) => number;
}>): Array<{ itemId: ResourceType; quantity: number }> {
  const groups = new Map<string, Array<{ reward: ChanceBasedItemReward; index: number }>>();
  input.rewards.forEach((reward, index) => {
    if (
      reward.rollId.length === 0
      || !Number.isInteger(reward.quantity)
      || reward.quantity <= 0
      || !Number.isFinite(reward.probability)
      || reward.probability < 0
      || reward.probability > 1
    ) {
      throw new Error("chance-based mob item reward configuration is invalid");
    }
    const group = groups.get(reward.rollId) ?? [];
    group.push({ reward, index });
    groups.set(reward.rollId, group);
  });

  return [...groups.values()].flatMap((group) => {
    const first = group[0]!;
    const unit = input.unitForRoll?.(first.reward, first.index)
      ?? deterministicRewardUnit(
        "combat-item-reward-roll-v1",
        input.settlementKey,
        input.mobArchetype,
        input.mobBalanceVersion,
        first.reward.itemId,
        first.reward.rollId,
        first.index
      );
    if (!Number.isFinite(unit) || unit < 0 || unit >= 1) {
      throw new Error("chance-based mob item reward unit must be in [0, 1)");
    }
    if (group.length === 1) {
      return unit < first.reward.probability
        ? [{ itemId: first.reward.itemId, quantity: first.reward.quantity }]
        : [];
    }

    const totalProbability = group.reduce((total, entry) => total + entry.reward.probability, 0);
    // Metal material ranges may sum below 1: the remainder is a miss.
    // Tolerance covers rounding after scaleChanceItemRewards caps a roll at 1.
    const mayMiss = first.reward.rollId.startsWith(METAL_MATERIAL_ROLL_PREFIX) && totalProbability < 1;
    if (!mayMiss && Math.abs(totalProbability - 1) > 1e-9) {
      throw new Error("weighted chance-based mob item reward probabilities must sum to 1");
    }
    let threshold = 0;
    const selected = group.find(({ reward }) => {
      threshold += reward.probability;
      return unit < threshold;
    });
    return selected
      ? [{ itemId: selected.reward.itemId, quantity: selected.reward.quantity }]
      : [];
  });
}

function deterministicRewardUnit(...parts: readonly (string | number)[]): number {
  const hash = createHash("sha256");
  for (const part of parts) {
    const value = String(part);
    hash.update(String(Buffer.byteLength(value)));
    hash.update(":");
    hash.update(value);
    hash.update("|");
  }
  return Number.parseInt(hash.digest("hex").slice(0, 13), 16)
    / 0x10_0000_0000_0000;
}

const SCAVENGE_POOLS = [
  ["wood", "balsam_resin"],
  ["wood", "balsam_resin", "leather", "iron"],
  ["wood", "balsam_resin", "leather", "iron", "sulfur", "stone"]
] as const satisfies readonly (readonly ResourceType[])[];
// V5-V11 settlements keep this pool and roll on every kill, not only on item drops.
const V11_SCAVENGE_POOLS = [
  ["wood", "wild_meat"],
  ["wood", "wild_meat", "leather", "iron"],
  ["wood", "wild_meat", "leather", "iron", "stone", "balsam_resin"]
] as const satisfies readonly (readonly ResourceType[])[];
const LEGACY_SCAVENGE_POOLS = [
  ["wood", "raw_meat"],
  ["wood", "raw_meat", "leather", "iron"],
  ["wood", "raw_meat", "leather", "iron", "stone", "balsam_resin"]
] as const satisfies readonly (readonly ResourceType[])[];
const SCAVENGE_PROC_PROBABILITIES = [0.04, 0.09, 0.14] as const;

type ScavengeBonus = { itemId: ResourceType; quantity: 1 };

// Keep legacy pool selection frozen for deterministic audit identity. Pending
// pre-V5 settlements can still select Raw Meat, but Raw Meat was retired by
// migration 0818. Normalize only at the physical grant boundary.
function normalizeScavengeBonusAtGrantBoundary(
  bonus: ScavengeBonus | null
): ScavengeBonus | null {
  if (bonus?.itemId !== "raw_meat") return bonus;
  return { itemId: "wild_meat", quantity: bonus.quantity };
}

/**
 * V5 combat settlements can still be pending after the carcass catalog has
 * been retired. Preserve their deterministic roll, but deliver the former
 * Butcher output as the canonical meat item so replay cannot grant a retired
 * inventory identity.
 */
const LEGACY_CARCASS_GRANT_MAP: Readonly<Record<string, Readonly<{ itemId: ResourceType; quantityPerInput: number }>>> =
  Object.freeze({
    deer_carcass: Object.freeze({ itemId: "deer_meat", quantityPerInput: 4 }),
    wolf_carcass: Object.freeze({ itemId: "wolf_meat", quantityPerInput: 3 }),
    hog_carcass: Object.freeze({ itemId: "hog_meat", quantityPerInput: 5 }),
    bear_carcass: Object.freeze({ itemId: "bear_meat", quantityPerInput: 10 }),
    alligator_carcass: Object.freeze({ itemId: "alligator_meat", quantityPerInput: 8 }),
    wild_carcass: Object.freeze({ itemId: "wild_meat", quantityPerInput: 2 })
  });

function normalizeLegacyCarcassGrant(
  item: Readonly<{ itemId: ResourceType; quantity: number }>
): { itemId: ResourceType; quantity: number } {
  const replacement = LEGACY_CARCASS_GRANT_MAP[item.itemId];
  return replacement
    ? { itemId: replacement.itemId, quantity: item.quantity * replacement.quantityPerInput }
    : { itemId: item.itemId, quantity: item.quantity };
}

function clampRogueRank(value: unknown): number {
  const rank = Number(value);
  return Number.isInteger(rank) ? Math.min(5, Math.max(0, rank)) : 0;
}

/**
 * Rogue humanoid-kill Gold proc: 2.5% chance of extra Gold by rank. The roll is a hash of the
 * settlement and the recipient (like ring drops), so a retried settlement rolls the same
 * result; tests inject `roll`. Pays nothing when the kill itself pays no Gold.
 */
export function rogueHumanoidGoldProc(input: Readonly<{
  settlementKey: string;
  playerId: string;
  mobArchetype: string;
  rank: number;
  killGold: number;
  summoned?: boolean;
  roll?: number;
}>): number {
  if (input.killGold <= 0 || input.summoned === true || !isHumanoidMobArchetype(input.mobArchetype)) return 0;
  const amount = rogueHumanoidGoldAmount(clampRogueRank(input.rank));
  if (amount <= 0) return 0;
  const roll = input.roll ?? deterministicRewardUnit("rogue-humanoid-gold", input.settlementKey, input.playerId);
  return roll < ROGUE_HUMANOID_GOLD_PROC_CHANCE ? amount : 0;
}

function clampScavengeRank(value: unknown): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(0, Math.min(3, Math.trunc(numeric))) : 0;
}

export function resolveScavengeBonus(input: Readonly<{
  settlementKey: string;
  mobArchetype: MobArchetypeKey;
  rank: number;
  boss: boolean;
  /** Scavenge only rolls when the monster actually dropped an item. */
  droppedItem: boolean;
  procUnit?: number;
  poolUnit?: number;
  itemRewardPolicyVersion?: number;
}>): ScavengeBonus | null {
  const rank = clampScavengeRank(input.rank);
  const policyVersion = input.itemRewardPolicyVersion;
  // V12 made Scavenge roll only when the monster dropped an item; older settlements roll every kill.
  const requiresDrop = policyVersion === undefined || policyVersion >= 12;
  if (rank === 0 || input.boss || (requiresDrop && !input.droppedItem) || input.mobArchetype === "training_dummy") return null;
  const procUnit = input.procUnit ?? deterministicRewardUnit(
    "combat-scavenge-proc-v1",
    input.settlementKey,
    rank
  );
  const poolUnit = input.poolUnit ?? deterministicRewardUnit(
    "combat-scavenge-pool-v1",
    input.settlementKey,
    rank
  );
  if (![procUnit, poolUnit].every((unit) => Number.isFinite(unit) && unit >= 0 && unit < 1)) {
    throw new Error("Scavenge reward units must be in [0, 1)");
  }
  if (procUnit >= SCAVENGE_PROC_PROBABILITIES[rank - 1]!) return null;
  const pool = (policyVersion === undefined || policyVersion >= 12
    ? SCAVENGE_POOLS
    : policyVersion <= 4 ? LEGACY_SCAVENGE_POOLS : V11_SCAVENGE_POOLS)[rank - 1]!;
  return { itemId: pool[Math.floor(poolUnit * pool.length)]!, quantity: 1 };
}

/**
 * Leatherworking rank 3: a chance of double leather when the monster's drop includes leather. Rolled once
 * per settlement from a deterministic unit, so a retried settlement grants the same amount. V12 and older
 * settlements never double.
 */
export function resolveLeatherDouble(input: Readonly<{
  settlementKey: string;
  rank: number;
  droppedLeather: boolean;
  itemRewardPolicyVersion?: number;
  unit?: number;
}>): boolean {
  const policyVersion = input.itemRewardPolicyVersion;
  if (policyVersion !== undefined && policyVersion < 13) return false;
  if (clampScavengeRank(input.rank) < LEATHERWORKING_DOUBLE_LEATHER_MIN_RANK || !input.droppedLeather) return false;
  const unit = input.unit ?? deterministicRewardUnit("combat-leatherworking-double-v1", input.settlementKey);
  if (!Number.isFinite(unit) || unit < 0 || unit >= 1) throw new Error("Leatherworking reward unit must be in [0, 1)");
  return unit < LEATHERWORKING_DOUBLE_LEATHER_CHANCE;
}

export class CombatRewardSettlementService {
  private flushing: Promise<void> | null = null;
  private supervisor: ReturnType<typeof setInterval> | null = null;
  private supervisorIntervalMs: number | null = null;
  private lastSuccessfulRunAt: string | null = null;
  private lastWorkerError: string | null = null;
  private readonly workerId = `combat-reward:${process.pid}:${randomUUID()}`;
  private readonly metrics: SettlementMetrics = {
    queueDepth: 0,
    oldestPendingAgeMs: 0,
    processingCount: 0,
    retries: 0,
    failures: 0,
    completed: 0,
    droppedAtCapacity: 0,
    totalLatencyMs: 0
  };

  constructor(
    private readonly pool: pg.Pool,
    private readonly progression: ProgressionService,
    private readonly logger: AppLogger,
    private readonly onCompleted?: (result: CombatSettlementResult) => void,
    private readonly classes?: ClassService,
    private readonly inventory?: Pick<
      InventoryService,
      "grantItemsForOperationInTransaction" | "snapshotInTransaction"
    >,
    private readonly masteries?: MasteryService,
    private readonly wallet?: Pick<WalletService, "creditForOperationInTransaction">,
    private readonly cityTreasury?: CityTreasuryService,
    private readonly random: () => number = Math.random
  ) {}

  private ringEquipment: RingDropEquipment | null = null;
  private skillCapabilities: SkillSystemV3RuntimeCapabilities = DEFAULT_SKILL_SYSTEM_V3_RUNTIME_CAPABILITIES;

  /** The server's skill capabilities: Scavenge is a hidden old skill unless the dev flag brings it back. */
  setSkillSystemV3Capabilities(capabilities: SkillSystemV3RuntimeCapabilities): void {
    this.skillCapabilities = capabilities;
  }

  /** Enables mob ring drops (rings are equipment instances, granted in the reward transaction). */
  setRingEquipment(equipment: RingDropEquipment): void {
    this.ringEquipment = equipment;
  }

  async accept(candidate: CombatDefeatSettlementCandidate): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await this.acceptInTransaction(client, candidate);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async acceptInTransaction(
    client: pg.PoolClient,
    candidate: CombatDefeatSettlementCandidate
  ): Promise<void> {
    const defeatingPlayerId =
      candidate.defeatingPlayerId &&
      candidate.eligibleParticipantIds.includes(candidate.defeatingPlayerId) &&
      candidate.contributions.some(
        (entry) => entry.entityId === candidate.defeatingPlayerId && entry.damage > 0
      )
        ? candidate.defeatingPlayerId
        : candidate.contributions.find(
            (entry) =>
              candidate.eligibleParticipantIds.includes(entry.entityId) &&
              entry.damage > 0
          )?.entityId ?? null;
    const membership = defeatingPlayerId && this.cityTreasury
      ? await client.query<{ membership_id: string; city_id: string }>(
          `SELECT membership.membership_id::text,membership.city_id::text
           FROM city_memberships membership
           JOIN city_structures house
             ON house.structure_id=membership.house_structure_id
            AND house.state='active'
            AND house.structure_type IN ('city_house','mayor_house')
           WHERE membership.player_id=$1 AND membership.left_at IS NULL
           ORDER BY membership.joined_at DESC
           LIMIT 1
           FOR SHARE OF membership,house`,
          [defeatingPlayerId]
        )
      : null;
    const rewardMembership = membership?.rows[0] ?? null;
    const definition = requireMobDefinition(candidate.mobArchetype);
    const scavengeRankResult = defeatingPlayerId && definition.boss !== true &&
      candidate.mobArchetype !== "training_dummy" && isGeneralSkillAvailable("scavenge", this.skillCapabilities)
      ? await client.query<{ rank: number }>(
          `SELECT rank FROM player_skill_ranks
           WHERE player_id=$1 AND skill_id='scavenge'
           FOR SHARE`,
          [defeatingPlayerId]
        )
      : null;
    const scavengeRank = clampScavengeRank(scavengeRankResult?.rows[0]?.rank);
    const leatherworkingRankResult = defeatingPlayerId && candidate.mobArchetype !== "training_dummy"
      ? await client.query<{ rank: number }>(
          `SELECT rank FROM player_skill_ranks
           WHERE player_id=$1 AND skill_id='leatherworking'
           FOR SHARE`,
          [defeatingPlayerId]
        )
      : null;
    // Rogue humanoid Gold proc: only a reward-eligible killer, never a summoned mob.
    const rogueRankResult = defeatingPlayerId && !candidate.summoned &&
      isHumanoidMobArchetype(candidate.mobArchetype)
      ? await client.query<{ rank: number }>(
          `SELECT ranks.rank
           FROM player_specialization_state state
           JOIN player_specialization_ranks ranks
             ON ranks.player_id=state.player_id
            AND ranks.specialization_id=state.active_specialization_id
           WHERE state.player_id=$1 AND state.active_specialization_id='rogue'
           FOR SHARE OF state, ranks`,
          [defeatingPlayerId]
        )
      : null;
    const rogueGoldProcRank = clampRogueRank(rogueRankResult?.rows[0]?.rank);
    const durableCandidate: DurableCombatDefeatSettlementCandidate = {
      ...candidate,
      scavengeRank,
      leatherworkingRank: clampScavengeRank(leatherworkingRankResult?.rows[0]?.rank),
      ...(rogueGoldProcRank > 0 ? { rogueGoldProcRank } : {}),
      landBonusPolicyVersion: LAND_OWNER_BONUS_POLICY_VERSION
    };
    const inserted = await client.query<{ settlement_key: string }>(
      `INSERT INTO combat_reward_settlements (
         settlement_key, defeated_mob_instance_id, mob_life_generation, mob_archetype,
         server_tick, status, attempt_count, candidate, next_retry_at,
         reward_player_id,reward_city_id,reward_membership_id
       ) VALUES ($1,$2,$3,$4,$5,'pending',0,$6::jsonb,now(),$7,$8,$9)
       ON CONFLICT DO NOTHING
       RETURNING settlement_key`,
      [candidate.settlementKey, candidate.defeatedEntityId, candidate.defeatGeneration,
        candidate.mobArchetype, candidate.serverTick, JSON.stringify(durableCandidate),
        defeatingPlayerId, rewardMembership?.city_id ?? null,
        rewardMembership?.membership_id ?? null]
    );
    if (inserted.rowCount === 1 && candidate.mobArchetype === "ogre") {
      await client.query(
        `UPDATE combat_reward_settlements
         SET atlas_shrine_shard_quantity = $2
         WHERE settlement_key = $1`,
        [
          candidate.settlementKey,
          atlasShrineShardQuantityForOgreRoll(this.random())
        ]
      );
    }
    const accepted = await client.query<{
      settlement_key: string;
      defeated_mob_instance_id: string;
      mob_life_generation: number;
    }>(
      `SELECT settlement_key, defeated_mob_instance_id, mob_life_generation
       FROM combat_reward_settlements
       WHERE settlement_key = $1
          OR (defeated_mob_instance_id = $2 AND mob_life_generation = $3)
       LIMIT 1`,
      [candidate.settlementKey, candidate.defeatedEntityId, candidate.defeatGeneration]
    );
    const row = accepted.rows[0];
    if (!row || row.settlement_key !== candidate.settlementKey ||
      row.defeated_mob_instance_id !== candidate.defeatedEntityId ||
      Number(row.mob_life_generation) !== candidate.defeatGeneration) {
      throw new Error("Combat reward settlement identity collision");
    }
    await settlePopulationV2Defeat(client, candidate, defeatingPlayerId);
  }

  flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    this.flushing = this.runFlush()
      .then(() => {
        this.lastSuccessfulRunAt = new Date().toISOString();
        this.lastWorkerError = null;
      })
      .catch((error: unknown) => {
        this.lastWorkerError = (error instanceof Error ? error.message : String(error)).slice(0, 240);
        throw error;
      })
      .finally(() => {
        this.flushing = null;
      });
    return this.flushing;
  }

  startSupervisor(intervalMs: number): void {
    if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) {
      throw new Error("combat reward retry interval must be a positive safe integer");
    }
    if (this.supervisor) throw new Error("combat reward supervisor is already running");
    this.supervisorIntervalMs = intervalMs;
    this.supervisor = setInterval(() => {
      void this.flush().catch((error: unknown) => {
        this.logger.warn({ err: error }, "combat reward retry supervisor pass failed");
      });
    }, intervalMs);
  }

  async stopSupervisor(): Promise<void> {
    if (this.supervisor) {
      clearInterval(this.supervisor);
      this.supervisor = null;
    }
    this.supervisorIntervalMs = null;
    await this.flushing?.catch(() => undefined);
  }

  workerState(): SettlementWorkerState {
    return {
      running: this.supervisor !== null,
      flushInProgress: this.flushing !== null,
      intervalMs: this.supervisorIntervalMs,
      lastSuccessfulRunAt: this.lastSuccessfulRunAt,
      lastError: this.lastWorkerError
    };
  }

  async recoverIncomplete(): Promise<number> {
    await this.pool.query(
      `UPDATE combat_reward_settlements
       SET status = 'failed', worker_id = NULL, lease_expires_at = NULL,
           next_retry_at = now(), updated_at = now()
       WHERE status IN ('processing', 'failed')`
    );
    await this.refreshMetrics();
    const completedBefore = this.metrics.completed;
    await this.flush();
    return Math.max(0, this.metrics.completed - completedBefore);
  }

  metricsSnapshot(): SettlementMetrics & { averageLatencyMs: number } {
    return {
      ...this.metrics,
      averageLatencyMs: this.metrics.completed === 0 ? 0 : this.metrics.totalLatencyMs / this.metrics.completed
    };
  }

  async refreshMetricsSnapshot(): Promise<SettlementMetrics & { averageLatencyMs: number }> {
    await this.refreshMetrics();
    return this.metricsSnapshot();
  }

  private async runFlush(): Promise<void> {
    await Promise.all(Array.from({ length: MAX_SETTLEMENT_WORKERS }, () => this.runWorker()));
    await this.refreshMetrics();
  }

  private async runWorker(): Promise<void> {
    for (;;) {
      const claimed = await this.claimNext();
      if (!claimed) return;
      try {
        const startedAt = Date.now();
        const result = await this.processClaimed(claimed);
        this.metrics.totalLatencyMs += Date.now() - startedAt;
        this.onCompleted?.(result);
      } catch (error) {
        this.logger.warn(
          { err: error, settlementKey: claimed.settlement_key },
          "combat reward settlement failed; durable row remains retryable"
        );
        await this.markFailure(claimed.settlement_key, error);
      }
    }
  }

  private async claimNext(): Promise<{
    settlement_key: string;
    candidate: DurableCombatDefeatSettlementCandidate | null;
  } | null> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const selected = await client.query<{
        settlement_key: string;
        candidate: DurableCombatDefeatSettlementCandidate | null;
      }>(
        `SELECT settlement_key, candidate
         FROM combat_reward_settlements
         WHERE (
           (status IN ('pending', 'failed') AND next_retry_at <= now())
           OR (status = 'processing' AND lease_expires_at < now())
         )
         ORDER BY created_at ASC
         FOR UPDATE SKIP LOCKED
         LIMIT 1`
      );
      const row = selected.rows[0];
      if (!row) {
        await client.query("COMMIT");
        return null;
      }
      await client.query(
        `UPDATE combat_reward_settlements
         SET status = 'processing', attempt_count = attempt_count + 1,
             last_attempt_at = now(), worker_id = $2,
             lease_expires_at = now() + ($3 * interval '1 second'),
             error_code = NULL, failure_summary = NULL, updated_at = now()
         WHERE settlement_key = $1`,
        [row.settlement_key, this.workerId, SETTLEMENT_LEASE_SECONDS]
      );
      await client.query("COMMIT");
      return row;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private async markFailure(settlementKey: string, error: unknown): Promise<void> {
    const code = typeof error === "object" && error !== null && "code" in error
      ? String((error as { code?: unknown }).code).slice(0, 80)
      : "SETTLEMENT_FAILED";
    const summary = (error instanceof Error ? error.message : String(error)).slice(0, 240);
    try {
      await this.pool.query(
        `UPDATE combat_reward_settlements
         SET status = 'failed', error_code = $2, failure_summary = $3,
             failure_count = failure_count + 1,
             worker_id = NULL, lease_expires_at = NULL,
             next_retry_at = now() + (
               LEAST(60, POWER(2, LEAST(attempt_count, 6))) * interval '1 second'
             ), updated_at = now()
         WHERE settlement_key = $1 AND status <> 'completed'`,
        [settlementKey, code, summary]
      );
    } catch {
      // A processing lease makes the durable row claimable again after a database outage.
    }
  }

  private async processClaimed(claimed: {
    settlement_key: string;
    candidate: DurableCombatDefeatSettlementCandidate | null;
  }): Promise<CombatSettlementResult> {
    const existing = await this.pool.query<{
      status: string;
      result: CombatSettlementResult | null;
      prepared_at: Date | null;
      candidate: DurableCombatDefeatSettlementCandidate | null;
      reward_city_id: string | null;
      reward_membership_id: string | null;
      reward_player_id: string | null;
      atlas_shrine_shard_quantity: number;
    }>(
      `SELECT status,result,prepared_at,candidate,reward_player_id,
              reward_city_id::text,reward_membership_id::text,
              atlas_shrine_shard_quantity
       FROM combat_reward_settlements WHERE settlement_key = $1`,
      [claimed.settlement_key]
    );
    if (existing.rows[0]?.status === "completed" && existing.rows[0].result) {
      return { ...existing.rows[0].result, replayed: true };
    }
    const row = existing.rows[0];
    if (!row) {
      throw new Error("Claimed combat reward settlement no longer exists");
    }
    if (row.prepared_at) {
      return this.completePrepared(await this.loadPrepared(claimed.settlement_key));
    }
    const candidate = row.candidate ?? claimed.candidate;
    if (!candidate) {
      throw new Error("Combat reward settlement is missing its durable candidate");
    }
    const definition = requireMobDefinition(candidate.mobArchetype);
    const positive = candidate.contributions
      .filter((entry) => entry.damage > 0 && candidate.eligibleParticipantIds.includes(entry.entityId))
      .sort((left, right) => right.damage - left.damage || left.entityId.localeCompare(right.entityId));
    const playerLevels = new Map<string, number>();
    for (const entry of positive) {
      playerLevels.set(entry.entityId, (await this.progression.getOrCreate(entry.entityId)).level);
    }
    const mobLevel = candidate.mobLevel ?? definition.level;
    const xpPolicy = resolveCandidateXpPolicy(candidate, mobLevel);
    const distribution = calculateCombatRewardShares(
      xpPolicy.xpPolicyVersion === COMBAT_XP_POLICY_VERSION
        ? scaledMobXpPool({
            baseXpPool: xpPolicy.baseXpPool,
            mobLevel,
            settlementKey: candidate.settlementKey
          })
        : scaledLegacyV2MobXpPool({
            baseXpPool: xpPolicy.baseXpPool,
            mobLevel,
            settlementKey: candidate.settlementKey
          }),
      mobLevel,
      positive,
      playerLevels
    );
    const classXpShares = calculateClassXpShares(candidate.baseClassXpPool ?? 0, positive);
    const shares = distribution.shares.map((share) => ({
      ...share,
      activeClassId: candidate.participantClassIds?.[share.playerId] ?? null,
      requestedClassXp: classXpShares.get(share.playerId) ?? 0
    }));
    const prepared: PreparedSettlement = {
      settlementKey: candidate.settlementKey,
      mobArchetype: candidate.mobArchetype,
      mobLevel,
      mobBalanceVersion:
        candidate.mobBalanceVersion ?? definition.balanceVersion,
      xpPolicyVersion: xpPolicy.xpPolicyVersion,
      itemRewardPolicyVersion: resolveItemRewardPolicyVersion(candidate),
      targetBasicHitCount: xpPolicy.targetBasicHitCount,
      baseXpPool: xpPolicy.baseXpPool,
      calculatedXpPool: distribution.calculatedPool,
      classXpPolicyVersion: candidate.classXpPolicyVersion ?? 0,
      baseClassXpPool: candidate.baseClassXpPool ?? 0,
      shares,
      rewardRecipientPlayerId: row.reward_player_id,
      rewardCityId: row.reward_city_id,
      rewardMembershipId: row.reward_membership_id,
      atlasShrineShardQuantity: Number(row.atlas_shrine_shard_quantity),
      scavengeRank: clampScavengeRank(candidate.scavengeRank),
      leatherworkingRank: clampScavengeRank(candidate.leatherworkingRank),
      rogueGoldProcRank: clampRogueRank(candidate.rogueGoldProcRank),
      landBonusPolicyVersion: candidate.landBonusPolicyVersion ?? 0,
      lootLocation: candidate.lootLocation ?? null,
      summoned: candidate.summoned === true,
      groupGoldMultiplier: clampGroupGoldMultiplier(candidate.groupGoldMultiplier)
    };
    assertPreparedItemRewardPolicy(prepared);
    await this.persistPrepared(prepared);
    return this.completePrepared(prepared);
  }

  private async persistPrepared(prepared: PreparedSettlement): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      for (const share of prepared.shares) {
        await client.query(
          `INSERT INTO combat_reward_participants (
           settlement_key, player_id, authoritative_damage, player_level, level_multiplier,
             contribution_share, requested_xp, granted_xp, xp_operation_key,
             active_class_id, requested_class_xp, class_xp_policy_version
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,0,NULL,$8,$9,$10)
           ON CONFLICT (settlement_key, player_id) DO NOTHING`,
          [
            prepared.settlementKey,
            share.playerId,
            share.damage,
            share.playerLevel,
            share.levelMultiplier,
            share.contributionShare,
            share.requestedXp,
            share.activeClassId,
            share.requestedClassXp,
            prepared.classXpPolicyVersion
          ]
        );
      }
      await client.query(
        `UPDATE combat_reward_settlements
         SET base_xp_pool = $2, calculated_xp_pool = $3,
             base_class_xp_pool = $4, class_xp_policy_version = $5,
             prepared_at = now(), updated_at = now()
         WHERE settlement_key = $1 AND prepared_at IS NULL`,
        [prepared.settlementKey, prepared.baseXpPool, prepared.calculatedXpPool,
         prepared.baseClassXpPool, prepared.classXpPolicyVersion]
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private async loadPrepared(settlementKey: string): Promise<PreparedSettlement> {
    const result = await this.pool.query<{
      mob_archetype: MobArchetypeKey;
      base_xp_pool: number;
      calculated_xp_pool: number;
      player_id: string | null;
      authoritative_damage: number | null;
      player_level: number | null;
      level_multiplier: string | number | null;
      contribution_share: string | number | null;
      requested_xp: number | null;
      active_class_id: ClassId | null;
      requested_class_xp: number | null;
      class_xp_policy_version: number;
      base_class_xp_pool: number;
      candidate: DurableCombatDefeatSettlementCandidate | null;
      reward_city_id: string | null;
      reward_membership_id: string | null;
      reward_player_id: string | null;
      atlas_shrine_shard_quantity: number;
    }>(
      `SELECT s.mob_archetype, s.base_xp_pool, s.calculated_xp_pool, s.candidate,
              s.reward_player_id,
              s.reward_city_id::text,s.reward_membership_id::text,
              s.atlas_shrine_shard_quantity,
              p.player_id, p.authoritative_damage, p.player_level, p.level_multiplier,
              s.class_xp_policy_version, s.base_class_xp_pool,
              p.contribution_share, p.requested_xp, p.active_class_id, p.requested_class_xp
       FROM combat_reward_settlements s
       LEFT JOIN combat_reward_participants p ON p.settlement_key = s.settlement_key
       WHERE s.settlement_key = $1
       ORDER BY p.authoritative_damage DESC, p.player_id ASC`,
      [settlementKey]
    );
    const first = result.rows[0];
    if (!first) throw new Error("Prepared combat settlement does not exist");
    const definition = requireMobDefinition(first.mob_archetype);
    return {
      settlementKey,
      mobArchetype: first.mob_archetype,
      mobLevel: first.candidate?.mobLevel ?? definition.level,
      mobBalanceVersion:
        first.candidate?.mobBalanceVersion ?? definition.balanceVersion,
      xpPolicyVersion: first.candidate?.xpPolicyVersion ?? 2,
      itemRewardPolicyVersion: resolveItemRewardPolicyVersion(first.candidate ?? {}),
      targetBasicHitCount:
        first.candidate?.targetBasicHitCount ?? mobXpHitCount(first.mob_archetype),
      baseXpPool: Number(first.base_xp_pool),
      calculatedXpPool: Number(first.calculated_xp_pool),
      classXpPolicyVersion: Number(first.class_xp_policy_version),
      baseClassXpPool: Number(first.base_class_xp_pool),
      rewardRecipientPlayerId: first.reward_player_id,
      rewardCityId: first.reward_city_id,
      rewardMembershipId: first.reward_membership_id,
      atlasShrineShardQuantity: Number(first.atlas_shrine_shard_quantity),
      scavengeRank: clampScavengeRank(first.candidate?.scavengeRank),
      leatherworkingRank: clampScavengeRank(first.candidate?.leatherworkingRank),
      rogueGoldProcRank: clampRogueRank(first.candidate?.rogueGoldProcRank),
      landBonusPolicyVersion: first.candidate?.landBonusPolicyVersion ?? 0,
      lootLocation: first.candidate?.lootLocation ?? null,
      summoned: first.candidate?.summoned === true,
      groupGoldMultiplier: clampGroupGoldMultiplier(first.candidate?.groupGoldMultiplier),
      shares: result.rows.flatMap((row) => row.player_id === null ? [] : [{
        playerId: row.player_id,
        damage: Number(row.authoritative_damage),
        playerLevel: Number(row.player_level),
        levelMultiplier: Number(row.level_multiplier),
        contributionShare: Number(row.contribution_share),
        requestedXp: Number(row.requested_xp),
        activeClassId: row.active_class_id,
        requestedClassXp: Number(row.requested_class_xp)
      }])
    };
  }

  private async completePrepared(prepared: PreparedSettlement): Promise<CombatSettlementResult> {
    assertPreparedItemRewardPolicy(prepared);
    const definition = requireMobDefinition(prepared.mobArchetype);
    const grants: CombatSettlementResult["shares"] = [];
    for (const share of prepared.shares) {
      const operationKey = `combat-settlement:${prepared.settlementKey}:${share.playerId}`;
      const grant = await this.progression.grantXp({
        operationKey,
        playerId: share.playerId,
        sourceType: "combat",
        sourceId: prepared.settlementKey,
        requestedXp: share.requestedXp,
        metadata: {
          mobArchetype: prepared.mobArchetype,
          mobLevel: prepared.mobLevel,
          balanceVersion: definition.balanceVersion,
          groupSize: prepared.shares.length,
          contributionShare: share.contributionShare,
          levelMultiplier: share.levelMultiplier
        }
      });
      const classGrant = this.classes
        && share.activeClassId !== null
        && isLaunchClassId(share.activeClassId)
        && prepared.classXpPolicyVersion === CLASS_XP_POLICY_VERSION
        && share.requestedClassXp > 0
        ? await this.classes.grantCombatMastery(
            share.playerId,
            share.activeClassId,
            share.requestedClassXp,
            `class-combat-settlement:${prepared.settlementKey}:${share.playerId}`
          )
        : undefined;
      grants.push({ ...share, grant, ...(classGrant ? { classGrant } : {}) });
      await this.pool.query(
        `UPDATE combat_reward_participants
         SET granted_xp = $3, xp_operation_key = $4
         WHERE settlement_key = $1 AND player_id = $2`,
        [prepared.settlementKey, share.playerId, grant.grantedXp, operationKey]
      );
    }
    const rewardRecipient = prepared.shares.find(
      (share) => share.playerId === prepared.rewardRecipientPlayerId
    );
    const mobReward = rewardRecipient
      ? await this.grantMobReward(prepared, rewardRecipient.playerId)
      : undefined;
    const result: CombatSettlementResult = {
      settlementKey: prepared.settlementKey,
      mobArchetype: prepared.mobArchetype,
      mobLevel: prepared.mobLevel,
      mobBalanceVersion: prepared.mobBalanceVersion,
      xpPolicyVersion: prepared.xpPolicyVersion,
      itemRewardPolicyVersion: prepared.itemRewardPolicyVersion,
      targetBasicHitCount: prepared.targetBasicHitCount,
      baseXpPool: prepared.baseXpPool,
      calculatedXpPool: prepared.calculatedXpPool,
      classXpPolicyVersion: prepared.classXpPolicyVersion,
      baseClassXpPool: prepared.baseClassXpPool,
      groupSize: grants.length,
      shares: grants,
      ...(mobReward ? { mobReward } : {}),
      replayed: false
    };
    await this.pool.query(
      `UPDATE combat_reward_settlements
       SET status = 'completed', calculated_xp_pool = $2, result = $3::jsonb,
           completed_at = now(), worker_id = NULL, lease_expires_at = NULL,
           updated_at = now()
       WHERE settlement_key = $1`,
      [prepared.settlementKey, prepared.calculatedXpPool, JSON.stringify(result)]
    );
    return result;
  }

  private async grantMobReward(
    prepared: PreparedSettlement,
    playerId: string
  ): Promise<CombatSettlementResult["mobReward"] | undefined> {
    const definition = requireMobDefinition(prepared.mobArchetype);
    const reward = definition.rewards;
    const itemRewardPolicy = combatItemRewardPolicy(prepared);
    // Kingdom perks (Reserved Game, Gilded Trim, Caravan Guild). A failed
    // lookup only forgoes the bonus; it never holds up the reward.
    const huntingPerks = await kingdomHuntingPerksAt(
      this.pool,
      playerId,
      prepared.lootLocation?.position ?? null
    ).catch((error: unknown) => {
      this.logger.warn({ err: error, settlementKey: prepared.settlementKey }, "kingdom hunting perk lookup failed");
      return NO_KINGDOM_HUNTING_PERKS;
    });
    const scaledGold = Math.round(scaledMobGoldReward({
      baseGold: reward.gold,
      mobLevel: prepared.mobBalanceVersion === 2 ? prepared.mobLevel : 0,
      settlementKey: prepared.settlementKey
    }) * huntingPerks.goldMultiplier * prepared.groupGoldMultiplier);
    const chanceRewards = resolveChanceBasedItemRewards({
      settlementKey: prepared.settlementKey,
      mobArchetype: prepared.mobArchetype,
      mobBalanceVersion: prepared.mobBalanceVersion,
      rewards: scaleChanceItemRewards(itemRewardPolicy.chanceItems, huntingPerks.dropChanceMultiplier)
    });
    const rogueGold = rogueHumanoidGoldProc({
      settlementKey: prepared.settlementKey,
      playerId,
      mobArchetype: prepared.mobArchetype,
      rank: prepared.rogueGoldProcRank,
      killGold: scaledGold,
      summoned: prepared.summoned
    });
    const scavengeBonus = normalizeScavengeBonusAtGrantBoundary(resolveScavengeBonus({
      settlementKey: prepared.settlementKey,
      mobArchetype: prepared.mobArchetype,
      rank: prepared.scavengeRank,
      boss: definition.boss === true,
      droppedItem: itemRewardPolicy.items.length > 0 || chanceRewards.length > 0 ||
        prepared.atlasShrineShardQuantity > 0,
      itemRewardPolicyVersion: prepared.itemRewardPolicyVersion
    }));
    const droppedLeather = [...itemRewardPolicy.items, ...chanceRewards].some((item) => item.itemId === "leather");
    const doubleLeather = resolveLeatherDouble({
      settlementKey: prepared.settlementKey,
      rank: prepared.leatherworkingRank,
      droppedLeather,
      itemRewardPolicyVersion: prepared.itemRewardPolicyVersion
    });
    // Hunting on kingdom land can drop Bricks into the hunter's pack.
    // A failed lookup only forgoes the Bricks; it never holds up the reward.
    const brickYield = prepared.lootLocation
      ? await kingdomBrickYieldAt(this.pool, {
          playerId,
          position: prepared.lootLocation.position,
          rollKey: `combat:${prepared.settlementKey}:${playerId}`
        }).catch((error: unknown) => {
          this.logger.warn({ err: error, settlementKey: prepared.settlementKey }, "kingdom brick yield lookup failed");
          return null;
        })
      : null;
    // An allied Hunter monolith in range adds City Coins, credited as a
    // separate idempotent bonus entry next to the base combat credit.
    // A Spark Tonic adds 12% City Coins through the same bonus entry.
    const hunterCityCoinBonus = reward.cityCoins > 0 && prepared.lootLocation && prepared.rewardCityId
      ? Math.max(0, await (async () => {
          const monolithCoins = await monolithHunterQuantity(this.pool, {
            playerId,
            position: prepared.lootLocation!.position,
            quantity: reward.cityCoins,
            rollKey: `combat-city-coins:${prepared.settlementKey}:${playerId}`
          }).catch((error: unknown) => {
            this.logger.warn({ err: error, settlementKey: prepared.settlementKey }, "hunter monolith lookup failed");
            return reward.cityCoins;
          });
          const inspired = await inspirationActive(this.pool, playerId).catch(() => false);
          return inspired
            ? monolithHunterYield(
                monolithCoins,
                INSPIRATION_BONUS_PERCENT,
                kingdomBrickYieldRoll(`inspiration:combat-city-coins:${prepared.settlementKey}:${playerId}`)
              )
            : monolithCoins;
        })() - reward.cityCoins)
      : 0;
    const rewardItems = [
      ...itemRewardPolicy.items,
      ...chanceRewards,
      ...(prepared.atlasShrineShardQuantity > 0
        ? [{
            itemId: "atlas_shrine_shard" as const,
            quantity: prepared.atlasShrineShardQuantity
          }]
        : []),
      ...(scavengeBonus ? [scavengeBonus] : []),
      ...(brickYield ? [{ itemId: "bricks" as const, quantity: brickYield.quantity }] : [])
    ].map(normalizeLegacyCarcassGrant);
    if (doubleLeather) {
      for (const item of rewardItems) if (item.itemId === "leather") item.quantity *= 2;
    }
    // A Cinder Lantern triples monster drops inside the dungeon run it paid for. Bricks come
    // from the land, not the monster. The grant stays keyed by the settlement, so a retry never
    // grants twice.
    if (rewardItems.length > 0 && await cinderLanternDoublesDrops(this.pool, playerId).catch(() => false)) {
      for (const item of rewardItems) {
        if (item.itemId !== "bricks") item.quantity *= CINDER_LANTERN_DROP_MULTIPLIER;
      }
    }
    // Prism Holdings: 1.2% of a member's kills give 120 Crystal, rolled from the settlement so a
    // retry rolls the same; it rides the kill's item grant, so it is granted once. The perk is
    // looked up only for a hit. Like Bricks it comes from the kingdom, not the monster.
    const prismHoldings = prismHoldingsHit(`${prepared.settlementKey}:${playerId}`) &&
      await playerHasKingdomPerk(this.pool, playerId, "prism_holdings").catch((error: unknown) => {
        this.logger.warn({ err: error, settlementKey: prepared.settlementKey }, "kingdom prism holdings lookup failed");
        return false;
      });
    const monsterDropsCrystal = rewardItems.some((item) => item.itemId === "crystal");
    if (prismHoldings) {
      rewardItems.push({ itemId: "crystal", quantity: KINGDOM_PERK_PRISM_HOLDINGS_QUANTITY });
    }
    // Ring drops: chance and tier come from a stream seeded by the settlement, so a retried
    // settlement rolls the same rings; Peerless luck (worn rings) only shifts the tier.
    const ringSource = ringDropSourceFor(prepared.mobArchetype, definition.boss === true, prepared.summoned);
    const ringTiers = this.ringEquipment
      ? rollRingDrops({
          source: ringSource,
          mobLevel: prepared.mobLevel,
          peerlessLuck: this.ringEquipment.runtimeSnapshot(playerId)?.derivedStats.ringBonuses?.peerless_luck ?? 0,
          random: seededRingRandom(`ring-drop:${prepared.settlementKey}:${playerId}`)
        })
      : [];
    if (rewardItems.length === 0 && scaledGold === 0 && reward.cityCoins === 0 && ringTiers.length === 0) return undefined;
    if (!this.inventory || !this.wallet) return undefined;
    let ringEquipmentSnapshot: Awaited<ReturnType<RingDropEquipment["grantPackageInstancesInTransaction"]>>["equipment"] | null = null;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const owner = await client.query<{ account_id: string }>(
        "SELECT account_id FROM players WHERE id=$1 FOR SHARE",
        [playerId]
      );
      const accountId = owner.rows[0]?.account_id;
      if (!accountId) throw new Error("Combat reward recipient has no authoritative account");
      const rewardLines = rewardItems.map((item) => ({
        itemId: item.itemId,
        variant: null,
        quantity: item.quantity
      }));
      const groundDrop = prepared.lootLocation
        ? {
            operationKey: `combat-loot:${prepared.settlementKey}`,
            droppedByPlayerId: playerId,
            regionCode: prepared.lootLocation.regionCode,
            zoneId: prepared.lootLocation.zoneId,
            pileId: `combat:${prepared.settlementKey}`,
            sourceEntityType: "combat_settlement",
            sourceEntityId: prepared.settlementKey,
            position: prepared.lootLocation.position,
            reason: `combat_${prepared.mobArchetype}_loot`
          }
        : null;
      const physicalReward = rewardItems.length > 0 && groundDrop
        ? itemRewardPolicy.delivery === "ground"
          ? await settlePhysicalItemRewardInTransaction(client, this.inventory, {
              delivery: "ground",
              playerId,
              lines: rewardLines,
              groundDrop
            })
          : await settlePhysicalItemRewardInTransaction(client, this.inventory, {
              delivery: "inventory_then_ground",
              lines: rewardLines,
              inventoryOperation: {
                operationKey: `combat-items:${prepared.settlementKey}`,
                playerId,
                source: `combat_${prepared.mobArchetype}_reward`,
                sourceEntityType: "combat_settlement",
                sourceEntityId: prepared.settlementKey,
                metadata: { mobArchetype: prepared.mobArchetype }
              },
              groundDrop
            })
        : null;
      const drops = physicalReward?.droppedItems ?? [];
      const directInventoryGrant = !physicalReward && rewardItems.length > 0
        ? await this.inventory.grantItemsForOperationInTransaction(client, {
            operationKey: `combat-items:${prepared.settlementKey}`,
            playerId,
            source: `combat_${prepared.mobArchetype}_reward`,
            sourceEntityType: "combat_settlement",
            sourceEntityId: prepared.settlementKey,
            metadata: { mobArchetype: prepared.mobArchetype },
            grants: rewardItems.map((item) => ({
              itemId: item.itemId,
              variant: null,
              quantity: item.quantity
            }))
          })
        : null;
      const inventoryGrant = physicalReward?.inventoryGrant ?? directInventoryGrant;
      const inventory = physicalReward?.inventory
        ?? inventoryGrant?.inventory
        ?? await this.inventory.snapshotInTransaction(client, playerId);
      const inventoryItems = new Map<ResourceType, number>();
      for (const grant of inventoryGrant?.grants ?? []) {
        if (grant.grantedQuantity <= 0) continue;
        if (grant.itemId === "fishing_rod") continue;
        if (!RESOURCE_TYPES.includes(grant.itemId as ResourceType)) continue;
        const itemId = grant.itemId as ResourceType;
        inventoryItems.set(
          itemId,
          (inventoryItems.get(itemId) ?? 0) + grant.grantedQuantity
        );
      }
      const wallet = scaledGold > 0
        ? await this.wallet.creditForOperationInTransaction(client, {
            playerId,
            accountId,
            amount: BigInt(scaledGold),
            operationKey: `combat-gold:${prepared.settlementKey}`,
            reason: `combat_${prepared.mobArchetype}_reward`
          })
        : undefined;
      // Extra Gold from the Rogue proc: its own operation key in the same transaction as the
      // kill Gold, so a replay credits it exactly once (and the roll is deterministic).
      const rogueWallet = rogueGold > 0
        ? await this.wallet.creditForOperationInTransaction(client, {
            playerId,
            accountId,
            amount: BigInt(rogueGold),
            operationKey: `combat-rogue-gold:${prepared.settlementKey}`,
            reason: "combat_rogue_humanoid_gold"
          })
        : undefined;
      const cityCredit =
        reward.cityCoins > 0 &&
        prepared.rewardCityId &&
        prepared.rewardMembershipId &&
        this.cityTreasury
          ? await this.cityTreasury.creditCombatInTransaction(client, {
              operationKey: `combat-city-coins:${prepared.settlementKey}`,
              cityId: prepared.rewardCityId,
              playerId,
              membershipId: prepared.rewardMembershipId,
              amount: reward.cityCoins,
              settlementKey: prepared.settlementKey,
              mobArchetype: prepared.mobArchetype
            })
          : null;
      // The land owner's 4% is minted on top, never taken from the hunter. A failure
      // here only forgoes the bonus; it never holds up or rolls back the hunter's reward.
      let landBonus: LandBonusPayout | null = null;
      if (scaledGold > 0 && prepared.landBonusPolicyVersion >= 1 && prepared.lootLocation) {
        await client.query("SAVEPOINT land_owner_bonus");
        try {
          landBonus = await creditLandOwnerBonusInTransaction(client, this.wallet, {
            settlementKey: prepared.settlementKey,
            hunterPlayerId: playerId,
            position: prepared.lootLocation.position,
            killGold: scaledGold
          });
          await client.query("RELEASE SAVEPOINT land_owner_bonus");
        } catch (error) {
          await client.query("ROLLBACK TO SAVEPOINT land_owner_bonus");
          landBonus = null;
          this.logger.warn({ err: error, settlementKey: prepared.settlementKey }, "land owner bonus failed");
        }
      }
      const hunterCredit = cityCredit && hunterCityCoinBonus > 0 && this.cityTreasury
        ? await this.cityTreasury.creditCombatInTransaction(client, {
            operationKey: `combat-city-coins-hunter:${prepared.settlementKey}`,
            cityId: prepared.rewardCityId!,
            playerId,
            membershipId: prepared.rewardMembershipId!,
            amount: hunterCityCoinBonus,
            settlementKey: prepared.settlementKey,
            mobArchetype: prepared.mobArchetype
          })
        : null;
      const rings: NonNullable<NonNullable<CombatSettlementResult["mobReward"]>["rings"]> = [];
      // Legacy candidates without a loot location fall back to the player's own position.
      const playerPosition = !prepared.lootLocation && ringTiers.length > 0
        ? (await client.query<{ lat: number | null; lon: number | null }>(
            "SELECT lat, lon FROM players WHERE id=$1", [playerId]
          )).rows[0] ?? null
        : null;
      const ringGround = (pileOrder: number) => prepared.lootLocation
        ? {
            regionCode: prepared.lootLocation.regionCode,
            zoneId: prepared.lootLocation.zoneId,
            pileId: `combat:${prepared.settlementKey}`,
            pileOrder,
            position: prepared.lootLocation.position,
            createdAt: new Date()
          }
        : playerPosition && Number.isFinite(playerPosition.lat) && Number.isFinite(playerPosition.lon)
          ? overworldRingGroundPlacement(
              { lat: playerPosition.lat!, lon: playerPosition.lon! },
              `combat:${prepared.settlementKey}`,
              pileOrder
            )
          : null;
      const reportRing = (found: RingFindResult) => {
        if (found.equipment) ringEquipmentSnapshot = found.equipment;
        if (found.delivered === "lost") {
          this.logger.warn({ settlementKey: prepared.settlementKey, playerId }, "ring drop had no room and no ground placement");
          rings.push({ definitionId: found.definitionId, onGround: false, lost: true });
        } else if (found.delivered === "inventory" || found.delivered === "ground") {
          rings.push({
            definitionId: found.definitionId,
            onGround: found.delivered === "ground",
            ...(found.lat === undefined || found.lon === undefined ? {} : { lat: found.lat, lon: found.lon })
          });
        }
      };
      let perkWallet: WalletOperationResult | undefined;
      for (const [index, tier] of ringTiers.entries()) {
        const ringOperationKey = `combat-ring:${prepared.settlementKey}:${playerId}:${index}`;
        // Full bag: like other overflow loot, the ring lands on this kill's loot pile.
        const found = await grantRingFindInTransaction(client, this.ringEquipment!, {
          operationKey: ringOperationKey,
          playerId,
          tier,
          source: `combat_${prepared.mobArchetype}_ring`,
          ground: ringGround(1_000 + index)
        });
        reportRing(found);
        // Kingdom level 7 perk: pays once per legendary ring the member receives, in this
        // transaction and keyed by the ring grant (a replayed grant pays nothing more).
        if (ringSource === "legendary" && (found.delivered === "inventory" || found.delivered === "ground")) {
          const payout = await payKingdomLegendaryRingPerkInTransaction(
            client,
            { equipment: this.ringEquipment!, wallet: this.wallet },
            { playerId, accountId, ringOperationKey, ground: ringGround(1_100 + index) }
          );
          if (payout?.ring) reportRing(payout.ring);
          if (payout?.wallet) perkWallet = payout.wallet;
        }
      }
      await recordCreatureBookKillInTransaction(client, {
        playerId,
        sourceKind: "combat_settlement",
        sourceId: prepared.settlementKey,
        mobArchetype: prepared.mobArchetype,
        // Bricks (and Prism Holdings Crystal) come from the kingdom, not the creature: keep
        // them out of its book.
        itemIds: [
          ...inventoryItems.keys(),
          ...drops.map((drop) => drop.itemId)
        ].filter((itemId) => itemId !== "bricks" && (itemId !== "crystal" || monsterDropsCrystal))
      });
      await client.query("COMMIT");
      if (ringEquipmentSnapshot) this.ringEquipment?.installAuthoritativeSnapshot(playerId, ringEquipmentSnapshot);
      return {
        playerId,
        items: [...inventoryItems].map(([itemId, quantity]) => ({ itemId, quantity })),
        drops,
        gold: scaledGold,
        ...(rogueGold > 0 ? { rogueBonusGold: rogueGold } : {}),
        inventory,
        ...((perkWallet ?? rogueWallet ?? wallet)
          ? {
              walletGold: (perkWallet ?? rogueWallet ?? wallet)!.goldBalance.toString(),
              walletVersion: (perkWallet ?? rogueWallet ?? wallet)!.version.toString()
            }
          : {}),
        cityCoins: cityCredit ? reward.cityCoins + (hunterCredit ? hunterCityCoinBonus : 0) : 0,
        cityId: cityCredit ? prepared.rewardCityId : null,
        cityTreasuryBalance: (hunterCredit ?? cityCredit)?.balance ?? null,
        cityContribution: (hunterCredit ?? cityCredit)?.contribution ?? null,
        ...(landBonus && landBonus.paidGold > 0 ? { landBonus } : {}),
        ...(rings.length > 0 ? { rings } : {})
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private async refreshMetrics(): Promise<void> {
    const result = await this.pool.query<{
      queue_depth: string | number;
      oldest_pending_age_ms: string | number | null;
      processing_count: string | number;
      retry_count: string | number;
      failure_count: string | number;
      completed_count: string | number;
    }>(
      `SELECT
         COUNT(*) FILTER (WHERE status IN ('pending', 'failed')) AS queue_depth,
         COALESCE(EXTRACT(EPOCH FROM (now() - MIN(created_at)
           FILTER (WHERE status IN ('pending', 'failed')))) * 1000, 0) AS oldest_pending_age_ms,
         COUNT(*) FILTER (WHERE status = 'processing') AS processing_count,
         COALESCE(SUM(GREATEST(attempt_count - 1, 0)), 0) AS retry_count,
         COALESCE(SUM(failure_count), 0) AS failure_count,
         COUNT(*) FILTER (WHERE status = 'completed') AS completed_count
       FROM combat_reward_settlements`
    );
    const row = result.rows[0];
    if (!row) return;
    this.metrics.queueDepth = Number(row.queue_depth);
    this.metrics.oldestPendingAgeMs = Number(row.oldest_pending_age_ms ?? 0);
    this.metrics.processingCount = Number(row.processing_count);
    this.metrics.retries = Number(row.retry_count);
    this.metrics.failures = Number(row.failure_count);
    this.metrics.completed = Number(row.completed_count);
  }
}

function resolveItemRewardPolicyVersion(
  candidate: Pick<CombatDefeatSettlementCandidate, "itemRewardPolicyVersion">
): 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | typeof COMBAT_ITEM_REWARD_POLICY_VERSION {
  const version = candidate.itemRewardPolicyVersion ?? 1;
  if (
    version !== 1
    && version !== 2
    && version !== 3
    && version !== 4
    && version !== 5
    && version !== 6
    && version !== 7
    && version !== 8
    && version !== 9
    && version !== 10
    && version !== 11
    && version !== 12
    && version !== COMBAT_ITEM_REWARD_POLICY_VERSION
  ) {
    throw new Error(`Unsupported combat item reward policy version: ${version}`);
  }
  return version;
}

/** Test seam: the item policy a settlement of this archetype and policy version would use. */
export function combatItemRewardPolicyForTest(mobArchetype: MobArchetypeKey, itemRewardPolicyVersion: number): CombatItemRewardPolicy {
  return combatItemRewardPolicy({ mobArchetype, itemRewardPolicyVersion } as unknown as PreparedSettlement);
}

function combatItemRewardPolicy(prepared: PreparedSettlement): CombatItemRewardPolicy {
  if (prepared.itemRewardPolicyVersion === 1) {
    const legacy = LEGACY_V1_ITEM_REWARDS[prepared.mobArchetype];
    return {
      items: legacy?.items ?? [],
      chanceItems: legacy?.chanceItems ?? [],
      delivery: prepared.lootLocation ? "ground" : "inventory"
    };
  }
  if (prepared.itemRewardPolicyVersion === 2) {
    const legacy = LEGACY_V2_ITEM_REWARDS[prepared.mobArchetype];
    return {
      items: legacy?.items ?? [],
      chanceItems: legacy?.chanceItems ?? [],
      delivery: "inventory"
    };
  }
  if (prepared.itemRewardPolicyVersion === 3) {
    const legacy = LEGACY_V3_ITEM_REWARDS[prepared.mobArchetype];
    return {
      items: legacy?.items ?? [],
      chanceItems: legacy?.chanceItems ?? [],
      delivery: legacy?.delivery ?? "inventory"
    };
  }
  if (prepared.itemRewardPolicyVersion === 4) {
    const legacy = LEGACY_V4_ITEM_REWARDS[prepared.mobArchetype];
    return {
      items: legacy?.items ?? [],
      chanceItems: legacy?.chanceItems ?? [],
      delivery: legacy?.delivery ?? "inventory"
    };
  }
  if (prepared.itemRewardPolicyVersion === 5) {
    const legacy = LEGACY_V5_ITEM_REWARDS[prepared.mobArchetype];
    return {
      items: legacy?.items ?? [],
      chanceItems: legacy?.chanceItems ?? [],
      delivery: legacy?.delivery ?? "inventory"
    };
  }
  if (prepared.itemRewardPolicyVersion === 6) {
    const legacy = LEGACY_V6_ITEM_REWARDS[prepared.mobArchetype];
    return legacy ?? { items: [], chanceItems: [], delivery: "inventory" };
  }
  if (prepared.itemRewardPolicyVersion === 7) {
    const legacy = LEGACY_V7_ITEM_REWARDS[prepared.mobArchetype];
    return legacy ?? { items: [], chanceItems: [], delivery: "inventory" };
  }
  if (prepared.itemRewardPolicyVersion === 8) {
    const legacy = LEGACY_V8_ITEM_REWARDS[prepared.mobArchetype];
    return legacy ?? { items: [], chanceItems: [], delivery: "inventory" };
  }
  if (prepared.itemRewardPolicyVersion === 9) {
    const legacy = LEGACY_V9_ITEM_REWARDS[prepared.mobArchetype];
    return legacy ?? { items: [], chanceItems: [], delivery: "inventory" };
  }
  if (prepared.itemRewardPolicyVersion === 10) {
    const legacy = LEGACY_V10_ITEM_REWARDS[prepared.mobArchetype];
    return legacy ?? { items: [], chanceItems: [], delivery: "inventory" };
  }
  // V11 drops are the live drops; V12 only changed how Scavenge rolls (see resolveScavengeBonus) and V13 added
  // Leatherworking's double leather (see resolveLeatherDouble).
  if (
    prepared.itemRewardPolicyVersion !== 11 && prepared.itemRewardPolicyVersion !== 12 &&
    prepared.itemRewardPolicyVersion !== COMBAT_ITEM_REWARD_POLICY_VERSION
  ) {
    throw new Error(
      `Unsupported combat item reward policy version: ${prepared.itemRewardPolicyVersion}`
    );
  }
  const rewards = requireMobDefinition(prepared.mobArchetype).rewards;
  // Player-built cistern warrens (instance ids `sewer:<id>`) have no run identity, so the completion reward
  // table cannot pay there; the Brood Matriarch pays its token as a mob drop in those instances only.
  if (prepared.mobArchetype === "brood_matriarch" && prepared.lootLocation?.regionCode.startsWith("interior:sewer:")) {
    return {
      items: rewards.items,
      chanceItems: [...rewards.chanceItems, BROOD_SILK_SEWER_DROP],
      delivery: rewards.itemDelivery ?? "inventory"
    };
  }
  return {
    items: rewards.items,
    chanceItems: rewards.chanceItems,
    delivery: rewards.itemDelivery ?? "inventory"
  };
}

/** Matches the Brood Matriarch's completion-table chance in run-based sewers. */
const BROOD_SILK_SEWER_DROP: ChanceBasedItemReward = Object.freeze({
  itemId: "brood_silk", quantity: 1, probability: 0.35, rollId: "brood_silk_sewer_token"
});

function assertPreparedItemRewardPolicy(prepared: PreparedSettlement): void {
  const policy = combatItemRewardPolicy(prepared);
  if (
    prepared.itemRewardPolicyVersion !== 1
    && (policy.items.length > 0 || policy.chanceItems.length > 0 || prepared.atlasShrineShardQuantity > 0)
    && !prepared.lootLocation
  ) {
    throw new Error("V2+ combat item reward candidate is missing its inventory-overflow location");
  }
}

function resolveCandidateXpPolicy(
  candidate: CombatDefeatSettlementCandidate,
  mobLevel: number
): Readonly<{
  xpPolicyVersion: 2 | typeof COMBAT_XP_POLICY_VERSION;
  targetBasicHitCount: number;
  baseXpPool: number;
}> {
  const policyVersion = candidate.xpPolicyVersion ?? 2;
  if (policyVersion === 2) {
    const definition = requireMobDefinition(candidate.mobArchetype);
    return {
      xpPolicyVersion: 2,
      targetBasicHitCount: mobXpHitCount(candidate.mobArchetype),
      baseXpPool: definition.legacyV2BaseXpPool
    };
  }
  if (policyVersion !== COMBAT_XP_POLICY_VERSION) {
    throw new Error(`Unsupported combat XP policy version: ${policyVersion}`);
  }
  const targetBasicHitCount = candidate.targetBasicHitCount;
  const baseXpPool = candidate.baseXpPool;
  if (!Number.isInteger(candidate.mobLevel) || candidate.mobLevel !== mobLevel) {
    throw new Error("V3 combat XP candidate must freeze its actual mob level");
  }
  if (
    !Number.isSafeInteger(targetBasicHitCount)
    || targetBasicHitCount === undefined
    || targetBasicHitCount <= 0
    || !Number.isSafeInteger(baseXpPool)
    || baseXpPool === undefined
    || baseXpPool < 0
  ) {
    throw new Error("V3 combat XP candidate is missing its frozen hit-count anchor");
  }
  const expectedBaseXp = candidate.mobArchetype === "training_dummy"
    ? 0
    : BASE_XP_PER_HIT_EQUIVALENT * targetBasicHitCount;
  if (baseXpPool !== expectedBaseXp) {
    throw new Error("V3 combat XP candidate has an inconsistent frozen base XP pool");
  }
  return {
    xpPolicyVersion: COMBAT_XP_POLICY_VERSION,
    targetBasicHitCount,
    baseXpPool
  };
}

async function settlePopulationV2Defeat(
  queryable: Pick<pg.PoolClient, "query">,
  candidate: CombatDefeatSettlementCandidate,
  defeatingPlayerId: string | null
): Promise<boolean> {
  const expectedRevision = candidate.defeatGeneration - 1;
  const authority = candidate.populationAuthority;
  const transitioned = await queryable.query<{ state_revision: number | string }>(
    `WITH authority AS MATERIALIZED (
       SELECT lease.entity_id
       FROM generated_world_mobs AS projection
       JOIN population_runtime_entity_leases_v2 AS lease
         ON lease.entity_id = projection.population_v2_entity_id
       WHERE projection.entity_id = $1
         AND lease.owner_token = $4::uuid
         AND lease.fencing_generation = $5::bigint
         AND lease.cutover_revision = $6::bigint
         AND lease.state_revision = $2::bigint
         AND lease.lease_expires_at > clock_timestamp()
       FOR UPDATE OF lease
     )
     UPDATE population_entity_state_v2 AS state
     SET state = 'dead',
         state_revision = state.state_revision + 1,
         state_actor_player_id = $3,
         killed_or_harvested_at = clock_timestamp(),
         respawn_at = NULL,
         durable_runtime_state = '{}'::jsonb,
         updated_at = clock_timestamp()
     FROM generated_world_mobs AS projection, authority
     WHERE projection.entity_id = $1
       AND projection.population_v2_entity_id = state.entity_id
       AND projection.population_v2_state_revision = $2::bigint
       AND NOT projection.population_cutover_suppressed
       AND authority.entity_id = state.entity_id
       AND state.state = 'ready'
       AND state.state_revision = $2::bigint
     RETURNING state.state_revision`,
    [
      candidate.defeatedEntityId,
      expectedRevision,
      defeatingPlayerId,
      authority?.ownerToken ?? null,
      authority?.fencingGeneration ?? null,
      authority?.cutoverRevision ?? null
    ]
  );
  if (transitioned.rowCount === 1) {
    if (Number(transitioned.rows[0]?.state_revision) !== candidate.defeatGeneration) {
      throw new Error("Population v2 mob defeat revision did not advance exactly once");
    }
    return true;
  }

  const existing = await queryable.query<{
    population_v2_entity_id: string | null;
    state: string | null;
    state_revision: number | string | null;
    authority_valid: boolean;
  }>(
    `SELECT projection.population_v2_entity_id::text,
            state.state, state.state_revision,
            EXISTS (
              SELECT 1
              FROM population_runtime_entity_leases_v2 AS lease
              WHERE lease.entity_id = projection.population_v2_entity_id
                AND lease.owner_token = $2::uuid
                AND lease.fencing_generation = $3::bigint
                AND lease.cutover_revision = $4::bigint
                AND lease.state_revision = $5::bigint
                AND lease.lease_expires_at > clock_timestamp()
            ) AS authority_valid
     FROM generated_world_mobs AS projection
     LEFT JOIN population_entity_state_v2 AS state
       ON state.entity_id = projection.population_v2_entity_id
     WHERE projection.entity_id = $1`,
    [
      candidate.defeatedEntityId,
      authority?.ownerToken ?? null,
      authority?.fencingGeneration ?? null,
      authority?.cutoverRevision ?? null,
      expectedRevision
    ]
  );
  const row = existing.rows[0];
  if (!row) return false;
  if (!row.population_v2_entity_id) {
    throw new Error(
      "Generated world mob lacks Population v2 authority"
    );
  }
  if (!row.authority_valid) {
    throw new Error("Population v2 mob defeat lost its runtime authority lease");
  }
  if (
    row.state === "dead"
    && Number(row.state_revision) === candidate.defeatGeneration
  ) {
    return true;
  }
  throw new Error("Population v2 mob defeat lost its canonical state race");
}

export function calculateCombatRewardShares(
  baseXpPool: number,
  mobLevel: number,
  contributions: ReadonlyArray<{ entityId: string; damage: number }>,
  playerLevels: ReadonlyMap<string, number>
): { calculatedPool: number; shares: CombatRewardShare[] } {
  const eligible = contributions
    .filter((entry) => entry.damage > 0 && playerLevels.has(entry.entityId))
    .sort((left, right) => right.damage - left.damage || left.entityId.localeCompare(right.entityId));
  if (baseXpPool <= 0 || eligible.length === 0) return { calculatedPool: 0, shares: [] };
  const weighted = eligible.map((entry) => ({
    entry,
    multiplier: xpLevelDifferenceMultiplier(playerLevels.get(entry.entityId)!, mobLevel),
    adjustedDamage: entry.damage * xpLevelDifferenceMultiplier(playerLevels.get(entry.entityId)!, mobLevel)
  }));
  const totalDamage = eligible.reduce((total, entry) => total + entry.damage, 0);
  const totalAdjustedDamage = weighted.reduce((total, entry) => total + entry.adjustedDamage, 0);
  const weightedMultiplier = totalAdjustedDamage / totalDamage;
  const groupBonus = 1 + Math.min(0.3, Math.max(0, eligible.length - 1) * 0.1);
  const calculatedPool = Math.max(0, Math.round(baseXpPool * weightedMultiplier * groupBonus));
  const baseShares = weighted.map(({ entry, multiplier, adjustedDamage }) => {
    const exact = calculatedPool * adjustedDamage / totalAdjustedDamage;
    return { entry, multiplier, exact, requestedXp: Math.floor(exact) };
  });
  let remainder = calculatedPool - baseShares.reduce((total, share) => total + share.requestedXp, 0);
  for (const share of baseShares) {
    if (remainder <= 0) break;
    share.requestedXp += 1;
    remainder -= 1;
  }
  return {
    calculatedPool,
    shares: baseShares.map(({ entry, multiplier, requestedXp }) => ({
      playerId: entry.entityId,
      damage: entry.damage,
      playerLevel: playerLevels.get(entry.entityId)!,
      levelMultiplier: multiplier,
      contributionShare: entry.damage / totalDamage,
      requestedXp,
      activeClassId: null,
      requestedClassXp: 0
    }))
  };
}

export function calculateClassXpShares(
  baseClassXpPool: number,
  contributions: ReadonlyArray<{ entityId: string; damage: number }>
): ReadonlyMap<string, number> {
  const eligible = contributions
    .filter((entry) => entry.damage > 0)
    .sort((left, right) => left.entityId.localeCompare(right.entityId));
  const pool = Math.max(0, Math.trunc(baseClassXpPool));
  if (pool === 0 || eligible.length === 0) return new Map();
  const totalDamage = eligible.reduce((total, entry) => total + entry.damage, 0);
  const shares = eligible.map((entry) => {
    const exact = pool * entry.damage / totalDamage;
    return { entry, exact, requestedXp: Math.floor(exact) };
  }).sort((left, right) =>
    (right.exact - right.requestedXp) - (left.exact - left.requestedXp)
      || left.entry.entityId.localeCompare(right.entry.entityId)
  );
  let remainder = pool - shares.reduce((total, share) => total + share.requestedXp, 0);
  for (const share of shares) {
    if (remainder <= 0) break;
    share.requestedXp += 1;
    remainder -= 1;
  }
  return new Map(shares.map((share) => [share.entry.entityId, share.requestedXp]));
}

/** A frozen Golem Forge group gold bonus, within its table (1 to 2.55); anything else pays no bonus. */
function clampGroupGoldMultiplier(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 1 && value <= GOLEM_FORGE_MAX_GROUP_GOLD_MULTIPLIER
    ? value
    : 1;
}
