import type { PlayerInventorySnapshot } from "./collectibles.js";

/** @deprecated Historical slot-era decoder/migration metadata only. */
export const DEFAULT_PLAYER_BASE_INVENTORY_SLOTS = 40;
export const MAX_EQUIPPED_BACKPACKS = 4;
/** @deprecated Historical slot-era decoder/migration metadata only. */
export const MAX_PLAYER_INVENTORY_SLOTS = 100;

export const BACKPACK_DEFINITION_IDS = [
  "starter_backpack",
  "traveler_backpack",
  "explorer_backpack",
  "trailblazer_backpack"
] as const;

export type BackpackDefinitionId = (typeof BACKPACK_DEFINITION_IDS)[number];

export type BackpackCost = Readonly<{
  leather: number;
  gold: number;
}>;

export type BackpackDefinition = Readonly<{
  definitionId: BackpackDefinitionId;
  displayName: string;
  upgradeIncrement: number;
  capacityBonus: number;
  cost: BackpackCost;
  nextDefinitionId: BackpackDefinitionId | null;
}>;

/** Historical named definitions preserve ownership/type IDs. New costs and capacity use BACKPACK_LEVELS. */
export const BACKPACK_DEFINITIONS: Readonly<
  Record<BackpackDefinitionId, BackpackDefinition>
> = Object.freeze({
  starter_backpack: Object.freeze({
    definitionId: "starter_backpack",
    displayName: "Starter Pack",
    upgradeIncrement: 1,
    capacityBonus: 1,
    cost: Object.freeze({ leather: 50, gold: 100 }),
    nextDefinitionId: "traveler_backpack"
  }),
  traveler_backpack: Object.freeze({
    definitionId: "traveler_backpack",
    displayName: "Traveler Pack",
    upgradeIncrement: 2,
    capacityBonus: 3,
    cost: Object.freeze({ leather: 100, gold: 500 }),
    nextDefinitionId: "explorer_backpack"
  }),
  explorer_backpack: Object.freeze({
    definitionId: "explorer_backpack",
    displayName: "Explorer Pack",
    upgradeIncrement: 4,
    capacityBonus: 7,
    cost: Object.freeze({ leather: 250, gold: 1_000 }),
    nextDefinitionId: "trailblazer_backpack"
  }),
  trailblazer_backpack: Object.freeze({
    definitionId: "trailblazer_backpack",
    displayName: "Trailblazer Pack",
    upgradeIncrement: 8,
    capacityBonus: 15,
    cost: Object.freeze({ leather: 500, gold: 5_000 }),
    nextDefinitionId: null
  })
});

export type BackpackLocation =
  | "inventory"
  | "equipped"
  | "manor_storage"
  | "world_drop"
  | "destroyed";

export type BackpackInstanceSnapshot = {
  instanceId: string;
  ownerPlayerId: string;
  definitionId: BackpackDefinitionId;
  displayName: string;
  location: BackpackLocation;
  /** Retired slot bonus, accepted only for older persisted results. */
  capacityBonus?: number;
  upgradeLevel?: number;
  capacityBonusGrams?: number;
  unitWeightGrams?: number;
  equippedSlot: number | null;
  inventorySlotIndex?: number | null;
  manorId: string | null;
  manorSlotIndex: number | null;
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type EquippedBackpackSlots = readonly [
  BackpackInstanceSnapshot | null,
  BackpackInstanceSnapshot | null,
  BackpackInstanceSnapshot | null,
  BackpackInstanceSnapshot | null
];

export type BackpackSnapshot = {
  playerId: string;
  revision: number;
  baseCapacityGrams?: number;
  backpackBonusGrams?: number;
  maximumCapacityGrams?: number;
  /** Legacy snapshot fields, no longer used for player carrying capacity. */
  baseSlots?: number;
  backpackBonusSlots?: number;
  effectiveSlots?: number;
  maximumSlots?: number;
  equipped: EquippedBackpackSlots;
  instances: BackpackInstanceSnapshot[];
};

export const BACKPACK_ACTIONS = [
  "create",
  "equip",
  "unequip",
  "upgrade"
] as const;
export type BackpackAction = (typeof BACKPACK_ACTIONS)[number];

export const BACKPACK_ERROR_CODES = [
  "BACKPACK_INVALID_REQUEST",
  "BACKPACK_SKILL_REQUIRED",
  "BACKPACK_NOT_OWNED",
  "BACKPACK_NOT_IN_INVENTORY",
  "BACKPACK_NOT_EQUIPPED",
  "BACKPACK_SLOT_INVALID",
  "BACKPACK_SLOT_OCCUPIED",
  "BACKPACK_EQUIP_LIMIT_REACHED",
  "BACKPACK_MAXIMUM_TIER",
  "BACKPACK_INSUFFICIENT_LEATHER",
  "BACKPACK_INSUFFICIENT_GOLD",
  "BACKPACK_UNEQUIP_CAPACITY_EXCEEDED",
  "BACKPACK_UNEQUIP_SLOT_RANGE_BLOCKED",
  "BACKPACK_INVENTORY_FULL",
  "BACKPACK_IDEMPOTENCY_CONFLICT",
  "BACKPACK_OPERATION_INCOMPLETE"
] as const;
export type BackpackErrorCode = (typeof BACKPACK_ERROR_CODES)[number];

export type BackpackUnequipDiagnostic = {
  currentWeightGrams?: string;
  resultingMaximumWeightGrams?: string;
  currentEffectiveSlots?: number;
  resultingEffectiveSlots?: number;
  occupiedResourceStacks?: number;
  slotsToFree?: number;
  highSlotOccupied?: boolean;
};

export type BackpackOperationResult = {
  requestId: string;
  action: BackpackAction;
  replayed: boolean;
  backpacks: BackpackSnapshot;
  inventory: PlayerInventorySnapshot;
  walletGold: string;
  walletVersion?: string;
  message: string;
};

export function requireBackpackDefinition(
  definitionId: string
): BackpackDefinition {
  const definition = BACKPACK_DEFINITIONS[definitionId as BackpackDefinitionId];
  if (!definition) throw new Error(`Unknown backpack definition: ${definitionId}`);
  return definition;
}

export function backpackTierIndex(definitionId: BackpackDefinitionId): number {
  return BACKPACK_DEFINITION_IDS.indexOf(definitionId);
}

/** @deprecated Historical slot-era calculation; never use for current capacity. */
export function calculateBackpackBonus(
  definitionIds: readonly BackpackDefinitionId[]
): number {
  return definitionIds.reduce(
    (total, definitionId) => total + requireBackpackDefinition(definitionId).capacityBonus,
    0
  );
}

/** @deprecated Historical slot-era calculation; never use for current capacity. */
export function calculatePlayerInventorySlots(
  baseSlots: number,
  equippedDefinitionIds: readonly BackpackDefinitionId[]
): number {
  return Math.min(
    MAX_PLAYER_INVENTORY_SLOTS,
    baseSlots + calculateBackpackBonus(equippedDefinitionIds)
  );
}

export const MAX_BACKPACK_UPGRADE_LEVEL = 10;
export type BackpackLevelDefinition = Readonly<{
  level: number;
  capacityBonusGrams: number;
  upgradeCost: BackpackCost;
  /** Reserved configuration for future per-level benefits; no perks apply yet. */
  effects: Readonly<Record<string, unknown>>;
}>;
// Level zero is the canonical craft recipe. Every following row is the
// deterministic one-level enhancement cost for the same item instance. The
// capacity is derived from the contract's 5 kg-per-level formula so the
// progression cannot drift from the table's level index.
const BACKPACK_UPGRADE_COSTS: readonly BackpackCost[] = Object.freeze([
  { leather: 80, gold: 2_000 },
  { leather: 20, gold: 500 },
  { leather: 35, gold: 1_000 },
  { leather: 50, gold: 1_500 },
  { leather: 80, gold: 2_500 },
  { leather: 120, gold: 4_000 },
  { leather: 180, gold: 6_500 },
  { leather: 260, gold: 10_000 },
  { leather: 375, gold: 15_000 },
  { leather: 550, gold: 22_500 },
  { leather: 800, gold: 35_000 }
]);
export const BACKPACK_LEVELS: readonly BackpackLevelDefinition[] = Object.freeze(
  BACKPACK_UPGRADE_COSTS.map((upgradeCost, level) => Object.freeze({
    level,
    capacityBonusGrams: 5_000 * (level + 1),
    upgradeCost: Object.freeze(upgradeCost),
    effects: Object.freeze({})
  }))
);
export function requireBackpackLevel(level: number): BackpackLevelDefinition {
  if (!Number.isInteger(level) || level < 0 || level > MAX_BACKPACK_UPGRADE_LEVEL) {
    throw new Error('Backpack upgrade level must be between +0 and +10');
  }
  return BACKPACK_LEVELS[level]!;
}
