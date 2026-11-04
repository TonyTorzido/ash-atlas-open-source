import { createHash, randomInt } from "node:crypto";

import {
  metalEquipmentEnhancement,
  parseEquipmentEnhancement,
  serializeEquipmentEnhancement,
  type EquipmentMetal,
  COMBAT_KIT_INDICES,
  EQUIPMENT_BALANCE_VERSION,
  EQUIPMENT_CRAFT_RECIPES,
  equipmentSwagCraftRecipe,
  EQUIPMENT_DEFINITION_IDS,
  EQUIPMENT_SLOTS,
  MAX_EQUIPMENT_LEVEL,
  RESOURCE_TYPES,
  activeEquipmentLoadoutFromSnapshot,
  activeEquipmentLimitedSales,
  emptyEquipmentSlots,
  equipmentUpgradeCost,
  equipmentUpgradeCostForIdentity,
  equipmentRequiredAchievementId,
  isCarriedEquipmentLocation,
  isEquipmentCategoryAllowedInSlot,
  isEquipmentDefinitionId,
  requireEquipmentDefinition,
  type EquipmentDefinition,
  requireEquipmentLevel,
  resolveEquipmentCombatStats,
  resolveEquipmentItemDerivedStats,
  clampEquipmentCondition,
  conditionAfterRepair,
  equipmentRepairCostForFamily,
  EQUIPMENT_DEATH_CONDITION_LOSS,
  blacksmithingWearLoss,
  equipmentCraftTradeGate,
  EQUIPMENT_MAX_CONDITION,
  REPAIR_KIT_ITEM_ID,
  REPAIR_KIT_CRAFT_CATEGORY_INPUTS,
  REPAIR_KIT_CRAFT_COSTS,
  RING_SHARD_ITEM_ID,
  isValidRingBonusRolls,
  parseRingBonusRolls,
  ringDumpShards,
  ringPolishCost,
  ringTierForDefinitionId,
  rollRingBonuses,
  type RingBonusRoll,
  type RingInstanceView,
  type RingTier,
  type ClassId,
  type CombatContext,
  type CombatKitIndex,
  type CombatKitInvalidReason,
  type CombatKitSnapshot,
  type EquipmentCombatStats,
  type EquipmentDefinitionId,
  type EquipmentGameplayFamilyId,
  type EquipmentInstanceV2,
  type EquipmentSlot,
  type EquipmentSlotRecord,
  type EquipmentSnapshotV2,
  type EquipmentUpgradeDisabledReason,
  type PlayerInventorySnapshot,
  type ResourceType,
  type ReadiedWeaponSlot
} from "@ash-atlas/shared";
import type pg from "pg";
import { UTILITY_GEAR, inscriptionKind, isPortableEquipmentCraft, isUtilityGearDefinitionId } from "@ash-atlas/shared";
import {
  LOADOUT_SCROLL_ITEM_ID,
  LOADOUT_SCROLL_MATERIALS,
  GEAR_SCROLL_SLOTS,
  gearScrollSlotsForGroup,
  type GearScrollMemoryGroup,
  type GearScrollsSnapshot
} from "@ash-atlas/shared";
import {
  GearScrollSwapQueue,
  loadGearScrollMemory,
  loadGearScrollsSnapshot,
  writeGearScrollMemory,
  type GearScrollEquipOutcome,
  type GearScrollMemory
} from "./gearScrolls.js";
import { resolveMaterialSpend, spendableItemCounts } from "./materialSpend.js";
import { requireRuntimeItemDefinition } from "./items.js";
import { requireTradeSkillGate, tradeSkillRank } from "./skills/tradeSkillRank.js";
import {
  MENDING_RESIN_ALCHEMY_MIN_RANK,
  MENDING_RESIN_ALCHEMY_REPAIR_POINTS,
  MENDING_RESIN_REPAIR_POINTS
} from "@ash-atlas/shared";

import {
  DEFAULT_INVENTORY_VARIANT,
  InventoryService,
  isInventoryCapacityError,
  isInventoryShortageError,
  lockInventoryCapacity,
  assertInventoryWeightInTransaction,
  fittingInventoryQuantityInTransaction
} from "./inventory.js";
import { WalletOperationError, WalletService } from "./wallet.js";
import { hasActiveAtlasPass } from "./atlasPass.js";
import { playerIsAtHome, type UtilityGearCraftResult } from "./utilityGear.js";

type Queryable = Pick<pg.Pool | pg.PoolClient, "query">;
type EquipmentWallet = Pick<WalletService, "debitForOperationInTransaction">;
type EquipmentInventory = Pick<
  InventoryService,
  "debitItemsForOperationInTransaction" |
  "grantItemsForOperationInTransaction" |
  "snapshotInTransaction"
>;

type EquipmentRow = {
  instance_id: string;
  definition_id: string;
  owner_player_id: string;
  location:
    | "inventory"
    | "equipped"
    | "manor_storage"
    | "market_escrow"
    | "market_collection"
    | "world_drop"
    | "destroyed";
  equipped_slot: EquipmentSlot | "weapon" | null;
  inventory_slot_index: number | null;
  manor_id: string | null;
  manor_slot_index: number | null;
  item_level: number;
  condition: number;
  balance_version: number;
  enchantment_identity: string | null;
  ring_bonuses?: unknown;
  ring_rough?: boolean;
  uses_remaining?: number | null;
  inscription_name?: string | null;
  inscribed_by_name?: string | null;
  shop_tag?: string | null;
  shop_buyer_name?: string | null;
  inscribed_at?: Date | string | null;
  inscription_stats?: Record<string, number> | null;
  created_at: Date | string;
  updated_at: Date | string;
};

type EquipmentStateRow = {
  inventory_revision: string | number;
  active_revision: string | number;
  checkpoint_revision: string | number;
  readied_weapon_slot: ReadiedWeaponSlot;
  active_kit_index: number | null;
  current_combat_gear_level: number;
  unlocked_combat_gear_level: number;
  challenge_profile_version: number;
  character_level: number;
};

type CombatKitRow = {
  kit_index: number;
  name: string;
  readied_weapon_slot: ReadiedWeaponSlot;
  revision: string | number;
};

type CombatKitItemRow = {
  kit_index: number;
  equipment_slot: EquipmentSlot;
  instance_id: string;
};

type LegacyOperationRow = {
  player_id: string;
  action: "starter_loadout" | "equip" | "unequip" | "package_grant";
  instance_id: string | null;
  requested_slot: EquipmentSlot | "weapon" | null;
  result: unknown;
  completed_at: Date | string | null;
};

type KitOperationAction =
  | "save"
  | "rename"
  | "clear"
  | "toggle_readied"
  | "activate";

type KitOperationRow = {
  player_id: string;
  request_id: string;
  action: KitOperationAction;
  kit_index: number | null;
  payload_matches: boolean;
  result: unknown;
  completed_at: Date | string | null;
};

type UpgradeOperationRow = {
  player_id: string;
  account_id: string;
  instance_id: string;
  expected_level: number;
  facility_structure_id: string | null;
  authority_kind: string;
  authority_source: string | null;
  runtime_authority_session_id: string | null;
  authority_movement_sequence: string | number | null;
  result: unknown;
  completed_at: Date | string | null;
};

type AcquisitionOperationRow = {
  player_id: string;
  action: string;
  request_hash: string | null;
  result: unknown;
  completed_at: Date | string | null;
};

export type EquipmentRuntimeContext = {
  context: CombatContext;
  characterLevel: number;
  classId: ClassId;
  classRank: number;
  achievementIds?: readonly string[];
};

export type EquipmentActor = {
  playerId: string;
  accountId: string;
};

export type EquipmentManorSmithContext = {
  kind: "manor_smith";
  manorId: string;
  manorSessionId: string;
  movementSequence: number;
  authorize(): Promise<void>;
};

/** Authority for a portable craft (a starter gathering tool crafted on the player, anywhere). */
export type EquipmentPortableCraftContext = {
  kind: "portable_craft";
  authorize(): Promise<void>;
};

export type EquipmentLegacyCityReplayContext = {
  kind: "legacy_city_replay";
  facilityStructureId: string;
};

export type EquipmentOperationResult = {
  applied: boolean;
  replayed: boolean;
  equipment: EquipmentSnapshotV2;
};

export type PackageEquipmentGrant = Readonly<{
  definitionId: EquipmentDefinitionId;
  quantity: number;
  /** Developer test grants only: pre-infused identity, the form the Jewel Station writes. */
  enchantmentIdentity?: string;
  /**
   * Ring tiers only. Bonuses roll on the server at insert unless given (tests, conversions).
   * Fine and up arrive Rough unless `ringPolished` (fixed rewards come pre-polished).
   */
  ringPolished?: boolean;
  ringBonuses?: readonly RingBonusRoll[];
}>;

export type RingOperationResult = Readonly<{
  applied: boolean;
  replayed: boolean;
  equipment: EquipmentSnapshotV2;
  inventory: PlayerInventorySnapshot;
  tier: RingTier;
  oilSpent: number;
  shardsGranted: number;
}>;

export type PackageEquipmentGrantResult = Readonly<{
  definitionId: EquipmentDefinitionId;
  requestedQuantity: number;
  grantedQuantity: number;
}>;

export type EquipmentUpgradeResult = EquipmentOperationResult & {
  instanceId: string;
  levelBefore: number;
  levelAfter: number;
  goldCost: string;
  balanceVersion: number;
  goldBalance: string;
};

export type EquipmentAcquisitionAction = "craft" | "limited_purchase";

export type EquipmentAcquisitionResult = EquipmentOperationResult & {
  action: EquipmentAcquisitionAction;
  definitionId: EquipmentDefinitionId;
  instanceId: string;
  materialCosts: Array<{ itemId: ResourceType; quantity: number }>;
  goldCost: string;
  walletGold?: string;
  walletVersion?: string;
  inventory: PlayerInventorySnapshot;
  message: string;
};

export type EquipmentRepairResult = EquipmentOperationResult & {
  instanceId: string;
  conditionBefore: number;
  conditionAfter: number;
  materialCosts: Array<{ itemId: ResourceType; quantity: number }>;
  inventory: PlayerInventorySnapshot;
  message: string;
};

export type RepairKitCraftResult = EquipmentOperationResult & {
  quantity: 1;
  materialCosts: Array<{ itemId: ResourceType; quantity: number }>;
  inventory: PlayerInventorySnapshot;
  message: string;
};

export type EquipmentUpgradeProjection = Readonly<Pick<
  EquipmentInstanceV2,
  "nextUpgradeLevel" | "nextUpgradeCost" | "upgradeDisabledReason"
>>;

export function projectEquipmentUpgradeEligibility(input: Readonly<{
  itemLevel: number;
  characterLevel: number;
  owned: boolean;
  destroyed: boolean;
  enchantmentIdentity?: string | null;
}>): EquipmentUpgradeProjection {
  const itemLevel = requireEquipmentLevel(input.itemLevel);
  let upgradeDisabledReason: EquipmentUpgradeDisabledReason | null = null;
  if (!input.owned) upgradeDisabledReason = "not_owned";
  else if (input.destroyed) upgradeDisabledReason = "destroyed";
  else if (itemLevel >= MAX_EQUIPMENT_LEVEL) upgradeDisabledReason = "maximum_level";
  if (
    upgradeDisabledReason === "not_owned"
    || upgradeDisabledReason === "destroyed"
    || upgradeDisabledReason === "maximum_level"
  ) {
    return {
      nextUpgradeLevel: null,
      nextUpgradeCost: null,
      upgradeDisabledReason
    };
  }
  return {
    nextUpgradeLevel: itemLevel + 1,
    nextUpgradeCost: String(equipmentUpgradeCostForIdentity(
      equipmentUpgradeCost(itemLevel, EQUIPMENT_BALANCE_VERSION),
      input.enchantmentIdentity ?? null
    )),
    upgradeDisabledReason
  };
}

export type StagedKitActivation = {
  requestId: string;
  kitIndex: CombatKitIndex;
  inventoryRevision: number;
  activeRevision: number;
  activationTick: number | null;
  replayed: boolean;
  equipment: EquipmentSnapshotV2;
  derivedStats: EquipmentCombatStats;
};

export type AppliedKitActivation = Omit<
  StagedKitActivation,
  "activationTick"
> & {
  activationTick: number;
};

export type EquipmentCheckpoint = {
  playerId: string;
  inventoryRevision: number;
  activeRevision: number;
  activeKitIndex: CombatKitIndex | null;
  readiedWeaponSlot: ReadiedWeaponSlot;
  activeInstanceIds: EquipmentSlotRecord<string | null>;
  activations: readonly AppliedKitActivation[];
};

export type EquipmentErrorCode =
  | "EQUIPMENT_REPAIR_SKILL_REQUIRED"
  | "EQUIPMENT_CRAFT_SKILL_REQUIRED"
  | "EQUIPMENT_INVALID_REQUEST"
  | "EQUIPMENT_PLAYER_NOT_FOUND"
  | "EQUIPMENT_NOT_OWNED"
  | "EQUIPMENT_DESTROYED"
  | "EQUIPMENT_SLOT_INVALID"
  | "EQUIPMENT_SLOT_OCCUPIED"
  | "EQUIPMENT_STALE_LEVEL"
  | "EQUIPMENT_CHARACTER_LEVEL_REQUIRED"
  | "EQUIPMENT_ACHIEVEMENT_REQUIRED"
  | "EQUIPMENT_MAXIMUM_LEVEL"
  | "EQUIPMENT_STALE_INVENTORY_REVISION"
  | "EQUIPMENT_IDEMPOTENCY_CONFLICT"
  | "EQUIPMENT_OPERATION_INCOMPLETE"
  | "EQUIPMENT_KIT_INVALID"
  | "EQUIPMENT_RUNTIME_NOT_CONNECTED"
  | "EQUIPMENT_RUNTIME_CAPACITY"
  | "EQUIPMENT_MUTATION_PENDING"
  | "EQUIPMENT_ACTIVATION_PENDING"
  | "EQUIPMENT_ACTIVATION_NOT_STAGED"
  | "EQUIPMENT_CHECKPOINT_CONFLICT"
  | "EQUIPMENT_NOT_CARRIED"
  | "EQUIPMENT_CRAFT_RECIPE_UNAVAILABLE"
  | "EQUIPMENT_CRAFT_MATERIALS_REQUIRED"
  | "EQUIPMENT_REPAIR_UNAVAILABLE"
  | "EQUIPMENT_REPAIR_STALE_CONDITION"
  | "EQUIPMENT_REPAIR_MATERIALS_REQUIRED"
  | "EQUIPMENT_LIMITED_SALE_UNAVAILABLE"
  | "EQUIPMENT_INVENTORY_FULL"
  | "EQUIPMENT_RING_ROUGH"
  | "EQUIPMENT_RING_INVALID"
  | "EQUIPMENT_RING_OIL_REQUIRED"
  | "EQUIPMENT_UTILITY_AT_HOME_ONLY"
  | "UTILITY_GEAR_INVALID"
  | "UTILITY_GEAR_PASS_REQUIRED"
  | "GEAR_SCROLL_INVALID"
  | "MANOR_SMITH_ACCESS_DENIED";

export class EquipmentError extends Error {
  constructor(
    readonly code: EquipmentErrorCode,
    message: string,
    readonly invalidReason: CombatKitInvalidReason | null = null
  ) {
    super(message);
    this.name = "EquipmentError";
  }
}

export type EquipmentServiceOptions = {
  wallet?: EquipmentWallet;
  inventory?: EquipmentInventory;
  now?: () => Date;
  achievements?: Readonly<{
    achievementIds(playerId: string): ReadonlySet<string> | null;
  }>;
  runtimeCapacity?: number;
  afterUpgradeDebit?: () => void | Promise<void>;
};

type RuntimeEntry = {
  context: EquipmentRuntimeContext;
  snapshot: EquipmentSnapshotV2;
  pendingActivation: StagedKitActivation | null;
  completedActivations: Map<string, AppliedKitActivation>;
  dirtyCheckpoint: EquipmentCheckpoint | null;
};

type SnapshotOverride = {
  activeInstanceIds: EquipmentSlotRecord<string | null>;
  readiedWeaponSlot: ReadiedWeaponSlot;
  activeKitIndex: CombatKitIndex | null;
  activeRevision: number;
  checkpointRevision: number;
};

const DEFAULT_RUNTIME_CONTEXT: EquipmentRuntimeContext = {
  context: "pve",
  characterLevel: 0,
  classId: "warrior",
  classRank: 0
};
const DEFAULT_RUNTIME_CAPACITY = 10_000;
const COMPLETED_ACTIVATION_LIMIT = 64;
const EQUIPMENT_AUDIT_DETAILS_LIMIT_BYTES = 4_096;

export class EquipmentService {
  private operationCount = 0;
  private readonly wallet: EquipmentWallet;
  private readonly inventory: EquipmentInventory;
  private readonly now: () => Date;
  private readonly achievements: EquipmentServiceOptions["achievements"];
  private readonly runtimeCapacity: number;
  private readonly afterUpgradeDebit: () => void | Promise<void>;
  private readonly runtimes = new Map<string, RuntimeEntry>();
  private readonly gearScrollSwaps = new GearScrollSwapQueue();
  private readonly lastGearScroll = new Map<string, number>();

  constructor(
    private readonly pool: pg.Pool,
    options: EquipmentServiceOptions = {}
  ) {
    this.wallet = options.wallet ?? new WalletService();
    this.inventory = options.inventory ?? new InventoryService(pool);
    this.now = options.now ?? (() => new Date());
    this.achievements = options.achievements;
    this.runtimeCapacity = options.runtimeCapacity ?? DEFAULT_RUNTIME_CAPACITY;
    if (!Number.isInteger(this.runtimeCapacity) || this.runtimeCapacity <= 0) {
      throw new Error("Equipment runtime capacity must be a positive integer");
    }
    this.afterUpgradeDebit = options.afterUpgradeDebit ?? (() => undefined);
  }

  async ensureStarterLoadout(
    playerId: string,
    activeClassId: ClassId = "warrior"
  ): Promise<EquipmentOperationResult> {
    requireIdentifier(playerId, "player ID", 160);
    const operationKey = activeClassId === "ninja"
      ? `starter-loadout:${playerId}:ninja:v2`
      : `starter-loadout:${playerId}:v5`;
    const client = await this.pool.connect();
    let committedSnapshot: EquipmentSnapshotV2 | null = null;
    try {
      await client.query("BEGIN");
      await ensureEquipmentScaffold(client, playerId);
      await lockInventoryCapacity(client, playerId);
      const reserved = await client.query(
        `INSERT INTO equipment_operations (operation_key, player_id, action)
         VALUES ($1,$2,'starter_loadout')
         ON CONFLICT (operation_key) DO NOTHING
         RETURNING operation_key`,
        [operationKey, playerId]
      );
      if (reserved.rowCount === 0) {
        const replay = await assertLegacyOperation(
          client,
          operationKey,
          playerId,
          "starter_loadout",
          null,
          null
        );
        const equipment = storedSnapshot(replay.result) ??
          await loadEquipmentSnapshot(client, playerId, this.contextFor(playerId));
        await client.query("COMMIT");
        return { applied: false, replayed: true, equipment };
      }

      const occupied = await client.query<{
        instance_id: string;
        equipped_slot: EquipmentSlot;
      }>(
        `SELECT instance_id, equipped_slot
         FROM equipment_instances
         WHERE owner_player_id = $1 AND location = 'equipped'
         FOR UPDATE`,
        [playerId]
      );
      const occupiedBySlot = new Map(
        occupied.rows.map((row) => [row.equipped_slot, row] as const)
      );
      let inventoryChanged = false;
      let changedActive = false;
      let shouldReadySecondary = false;
      for (const definitionId of [
        "starter_sword",
        "starter_bow",
        "starter_staff",
        ...(activeClassId === "ninja" ? ["starter_shuriken"] : []),
        "padded_tunic"
      ] as const) {
        const owned = await client.query<{
          instance_id: string;
          location: EquipmentRow["location"];
          equipped_slot: EquipmentRow["equipped_slot"];
        }>(
          `SELECT instance_id, location, equipped_slot
           FROM equipment_instances
           WHERE owner_player_id = $1
             AND definition_id = $2
             AND location <> 'destroyed'
           FOR UPDATE`,
          [playerId, definitionId]
        );
        if (owned.rowCount) {
          if (definitionId === "starter_shuriken" && activeClassId === "ninja") {
            const existing = owned.rows[0]!;
            const secondary = occupiedBySlot.get("secondary");
            if (
              !secondary &&
              isCarriedEquipmentLocation(existing.location)
            ) {
              await client.query(
                `UPDATE equipment_instances
                 SET location = 'equipped', equipped_slot = 'secondary'
                 WHERE instance_id = $1 AND owner_player_id = $2`,
                [existing.instance_id, playerId]
              );
              occupiedBySlot.set("secondary", {
                instance_id: existing.instance_id,
                equipped_slot: "secondary"
              });
              inventoryChanged = true;
              changedActive = true;
            }
            if (occupiedBySlot.get("secondary")?.instance_id === existing.instance_id) {
              shouldReadySecondary = true;
            }
          }
          continue;
        }

        const definition = requireEquipmentDefinition(definitionId);
        await assertInventoryWeightInTransaction(client, playerId, BigInt(requireRuntimeItemDefinition(definitionId).unitWeightGrams));
        const equip =
          (definitionId === "starter_sword" ||
            definitionId === "padded_tunic" ||
            (activeClassId === "ninja" && definitionId === "starter_shuriken")) &&
          !occupiedBySlot.has(definition.slot);
        const inserted = await client.query(
          `INSERT INTO equipment_instances (
             instance_id, definition_id, owner_player_id, location, equipped_slot,
             inventory_slot_index, item_level, balance_version, enchantment_identity,
             created_by_operation_key
           ) VALUES ($1,$2,$3,$4,$5,$6,0,$7,NULL,$8)
           ON CONFLICT DO NOTHING
           RETURNING instance_id`,
          [
            crypto.randomUUID(),
            definitionId,
            playerId,
            equip ? "equipped" : "inventory",
            equip ? definition.slot : null,
            null,
            EQUIPMENT_BALANCE_VERSION,
            operationKey
          ]
        );
        if (!inserted.rowCount) continue;
        inventoryChanged = true;
        if (equip) {
          changedActive = true;
          occupiedBySlot.set(definition.slot, {
            instance_id: inserted.rows[0]!.instance_id,
            equipped_slot: definition.slot
          });
          if (definitionId === "starter_shuriken") shouldReadySecondary = true;
        }
      }

      const state = await client.query<{
        readied_weapon_slot: ReadiedWeaponSlot;
      }>(
        `SELECT readied_weapon_slot
         FROM player_equipment_state
         WHERE player_id = $1
         FOR UPDATE`,
        [playerId]
      );
      const persistedReadiedWeaponSlot = state.rows[0]?.readied_weapon_slot;
      if (!persistedReadiedWeaponSlot) {
        throw new EquipmentError(
          "EQUIPMENT_PLAYER_NOT_FOUND",
          "Player equipment state does not exist"
        );
      }
      const readiedWeaponSlot = shouldReadySecondary
        ? "secondary"
        : persistedReadiedWeaponSlot;
      const changedReadiness =
        readiedWeaponSlot !== persistedReadiedWeaponSlot;
      const activeChanged = changedActive || changedReadiness;
      if (inventoryChanged || activeChanged) {
        await client.query(
          `UPDATE player_equipment_state
           SET inventory_revision = inventory_revision + $2::bigint,
               active_revision = active_revision + $3::bigint,
               checkpoint_revision = checkpoint_revision + $3::bigint,
               active_kit_index = CASE WHEN $4::boolean THEN NULL ELSE active_kit_index END,
               readied_weapon_slot = $5
           WHERE player_id = $1`,
          [
            playerId,
            inventoryChanged ? 1 : 0,
            activeChanged ? 1 : 0,
            changedActive,
            readiedWeaponSlot
          ]
        );
      }
      if (inventoryChanged) {
        await updateEquipmentChallengeProfile(client, playerId);
      }

      const equipment = await loadEquipmentSnapshot(
        client,
        playerId,
        this.contextFor(playerId)
      );
      await client.query(
        `UPDATE equipment_operations
         SET result = $2::jsonb, completed_at = now()
         WHERE operation_key = $1`,
        [operationKey, JSON.stringify(equipment)]
      );
      await client.query("COMMIT");
      committedSnapshot = equipment;
      this.operationCount += 1;
      return { applied: true, replayed: false, equipment };
    } catch (error) {
      await client.query("ROLLBACK");
      if (isInventoryCapacityError(error)) throw new EquipmentError("EQUIPMENT_INVENTORY_FULL", "This would exceed your carrying capacity");
      throw error;
    } finally {
      client.release();
      if (committedSnapshot) this.installMutationSnapshot(playerId, committedSnapshot);
    }
  }

  async getSnapshot(
    playerId: string,
    context: EquipmentRuntimeContext = this.contextFor(playerId)
  ): Promise<EquipmentSnapshotV2> {
    const runtime = this.runtimes.get(playerId);
    if (runtime && sameRuntimeContext(runtime.context, context)) {
      return runtime.snapshot;
    }
    return this.loadFreshSnapshot(playerId, context);
  }

  /** Apply the single authoritative death wear transition. */
  async applyDeathConditionWear(input: Readonly<{
    playerId: string;
    operationKey: string;
  }>): Promise<Readonly<{
    applied: boolean;
    replayed: boolean;
    changed: boolean;
    brokenCount: number;
    equipment: EquipmentSnapshotV2;
    message: string | null;
  }>> {
    requireIdentifier(input.playerId, "player ID", 160);
    requireIdentifier(input.operationKey, "operation key", 240);
    const client = await this.pool.connect();
    let committedSnapshot: EquipmentSnapshotV2 | null = null;
    try {
      await client.query("BEGIN");
      await ensureEquipmentScaffold(client, input.playerId);
      await lockInventoryCapacity(client, input.playerId);
      const reserved = await client.query(
        `INSERT INTO equipment_repair_operations (operation_key, player_id, action)
         VALUES ($1,$2,'death_wear')
         ON CONFLICT (operation_key) DO NOTHING
         RETURNING operation_key`,
        [input.operationKey, input.playerId]
      );
      if (reserved.rowCount === 0) {
        const existing = await client.query<{ player_id: string; action: string; result: unknown; completed_at: Date | string | null }>(
          `SELECT player_id, action, result, completed_at
           FROM equipment_repair_operations
           WHERE operation_key=$1
           FOR UPDATE`,
          [input.operationKey]
        );
        const row = existing.rows[0];
        const stored = storedDeathWearResult(row?.result);
        if (!row || row.player_id !== input.playerId || row.action !== "death_wear" ||
            !row.completed_at || !stored) {
          throw new EquipmentError(
            "EQUIPMENT_IDEMPOTENCY_CONFLICT",
            "Death equipment wear operation is incomplete or conflicts with another player"
          );
        }
        await client.query("COMMIT");
        committedSnapshot = stored.equipment;
        return { ...stored, applied: false, replayed: true };
      }

      const equipped = await client.query<EquipmentRow>(
        `${EQUIPMENT_ROW_SELECT}
         FROM equipment_instances
         WHERE owner_player_id=$1 AND location='equipped'
         FOR UPDATE`,
        [input.playerId]
      );
      // Blacksmithing makes equipped gear last longer: the death wear shrinks with rank.
      const wearLoss = blacksmithingWearLoss(
        EQUIPMENT_DEATH_CONDITION_LOSS,
        await tradeSkillRank(client, input.playerId, "blacksmithing")
      );
      let changed = false;
      let activeChanged = false;
      let brokenCount = 0;
      const brokenNames: string[] = [];
      for (const row of equipped.rows) {
        const definition = requireEquipmentDefinition(row.definition_id);
        if (definition.category !== "chest_armor" || !equipmentRepairCostForFamily(definition.gameplayFamilyId)) {
          continue;
        }
        const before = clampEquipmentCondition(row.condition);
        const after = Math.max(0, before - wearLoss);
        if (after === before) continue;
        changed = true;
        activeChanged = true;
        if (after === 0) {
          brokenCount += 1;
          brokenNames.push(definition.displayName);
        }
        await client.query(
          `UPDATE equipment_instances
           SET condition=$2::smallint,
               location=CASE WHEN $2::smallint=0 THEN 'inventory' ELSE location END,
               equipped_slot=CASE WHEN $2::smallint=0 THEN NULL ELSE equipped_slot END,
               updated_at=now()
           WHERE instance_id=$1`,
          [row.instance_id, after]
        );
      }
      await client.query(
        `UPDATE player_equipment_state
         SET inventory_revision=inventory_revision+$2::bigint,
             active_revision=active_revision+$3::bigint,
             checkpoint_revision=checkpoint_revision+$3::bigint,
             active_kit_index=CASE WHEN $4::bigint > 0 THEN NULL ELSE active_kit_index END
         WHERE player_id=$1`,
        [input.playerId, changed ? 1 : 0, activeChanged ? 1 : 0, brokenCount]
      );
      if (activeChanged) await updateEquipmentChallengeProfile(client, input.playerId);
      const message = changed
        ? brokenCount > 0
          ? `${brokenNames.join(", ")} broke during the defeat and was unequipped. Repair it at a Manor Smithing Station.`
          : "Your chest armor lost 10 condition during the defeat."
        : null;
      const equipment = {
        ...(await loadEquipmentSnapshot(client, input.playerId, this.contextFor(input.playerId))),
        repairMessage: message
      };
      const result = { applied: true, replayed: false, changed, brokenCount, equipment, message };
      await client.query(
        `UPDATE equipment_repair_operations
         SET result=$2::jsonb, completed_at=now()
         WHERE operation_key=$1`,
        [input.operationKey, JSON.stringify(result)]
      );
      await client.query("COMMIT");
      committedSnapshot = equipment;
      this.operationCount += 1;
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      if (isInventoryCapacityError(error)) throw new EquipmentError("EQUIPMENT_INVENTORY_FULL", "This would exceed your carrying capacity");
      throw error;
    } finally {
      client.release();
      if (committedSnapshot) this.installMutationSnapshot(input.playerId, committedSnapshot);
    }
  }

  async repairEquipment(
    actor: EquipmentActor,
    instanceId: string,
    expectedCondition: number,
    requestId: string,
    authority: EquipmentManorSmithContext
  ): Promise<EquipmentRepairResult> {
    requireIdentifier(actor.playerId, "player ID", 160);
    requireIdentifier(actor.accountId, "account ID", 160);
    requireIdentifier(instanceId, "equipment instance ID", 160);
    requireRequestId(requestId);
    if (
      !Number.isInteger(expectedCondition) ||
      expectedCondition < 0 ||
      expectedCondition > EQUIPMENT_MAX_CONDITION
    ) {
      throw new EquipmentError(
        "EQUIPMENT_INVALID_REQUEST",
        "Expected equipment condition is invalid"
      );
    }
    const safeExpectedCondition = clampEquipmentCondition(expectedCondition);
    const operationKey = `equipment-repair:${actor.accountId}:${requestId}`;
    const requestHash = createHash("sha256")
      .update(JSON.stringify({ instanceId, expectedCondition: safeExpectedCondition }))
      .digest("hex");
    const client = await this.pool.connect();
    let committedSnapshot: EquipmentSnapshotV2 | null = null;
    try {
      await client.query("BEGIN");
      await ensureEquipmentScaffold(client, actor.playerId);
      await lockInventoryCapacity(client, actor.playerId);
      await authority.authorize();
      await requireTradeSkillGate(client, actor.playerId, "repair_gear", (message) => new EquipmentError("EQUIPMENT_REPAIR_SKILL_REQUIRED", message));
      const reserved = await client.query(
        `INSERT INTO equipment_repair_operations (
           operation_key,player_id,action,request_id,request_hash,instance_id,expected_condition
         ) VALUES ($1,$2,'repair',$3,$4,$5,$6)
         ON CONFLICT (operation_key) DO NOTHING
         RETURNING operation_key`,
        [operationKey, actor.playerId, requestId, requestHash, instanceId, safeExpectedCondition]
      );
      if (reserved.rowCount === 0) {
        const existing = await client.query<{ player_id: string; action: string; request_hash: string | null; instance_id: string | null; expected_condition: number | null; result: unknown; completed_at: Date | string | null }>(
          `SELECT player_id,action,request_hash,instance_id::text,expected_condition,result,completed_at
           FROM equipment_repair_operations WHERE operation_key=$1 FOR UPDATE`,
          [operationKey]
        );
        const row = existing.rows[0];
        const stored = storedRepairResult(row?.result);
        if (!row || row.player_id !== actor.playerId || row.action !== "repair" ||
            row.request_hash !== requestHash || row.instance_id !== instanceId ||
            row.expected_condition !== safeExpectedCondition || !row.completed_at || !stored) {
          throw new EquipmentError("EQUIPMENT_IDEMPOTENCY_CONFLICT", "Repair request ID was reused with different intent");
        }
        const inventory = await this.inventory.snapshotInTransaction(client, actor.playerId);
        const equipment = await loadEquipmentSnapshot(client, actor.playerId, this.contextFor(actor.playerId));
        await client.query("COMMIT");
        committedSnapshot = equipment;
        return { ...stored, applied: false, replayed: true, inventory, equipment };
      }

      const locked = await client.query<EquipmentRow>(
        `${EQUIPMENT_ROW_SELECT} FROM equipment_instances WHERE instance_id=$1 FOR UPDATE`,
        [instanceId]
      );
      const item = locked.rows[0];
      if (!item || item.owner_player_id !== actor.playerId) {
        throw new EquipmentError("EQUIPMENT_NOT_OWNED", "Equipment instance is not owned by this player");
      }
      if (item.location === "destroyed") {
        throw new EquipmentError("EQUIPMENT_DESTROYED", "Destroyed equipment cannot be repaired");
      }
      if (!isCarriedEquipmentLocation(item.location)) {
        throw new EquipmentError("EQUIPMENT_NOT_CARRIED", "Equipment must be in Inventory or equipped to be repaired");
      }
      const definition = requireEquipmentDefinition(item.definition_id);
      const cost = equipmentRepairCostForFamily(definition.gameplayFamilyId);
      if (definition.category !== "chest_armor" || !cost) {
        throw new EquipmentError("EQUIPMENT_REPAIR_UNAVAILABLE", "Only eligible chest armor can be repaired");
      }
      const before = clampEquipmentCondition(item.condition);
      if (before !== safeExpectedCondition) {
        throw new EquipmentError("EQUIPMENT_REPAIR_STALE_CONDITION", `Expected condition ${safeExpectedCondition}, current condition is ${before}`);
      }
      if (before >= EQUIPMENT_MAX_CONDITION) {
        throw new EquipmentError("EQUIPMENT_REPAIR_UNAVAILABLE", "This armor is already fully repaired");
      }
      const materialCosts: Array<{ itemId: ResourceType; quantity: number }> = [
        { itemId: REPAIR_KIT_ITEM_ID, quantity: cost.repairKitQuantity },
        ...cost.materials.map((material) => ({ itemId: material.itemId as ResourceType, quantity: material.quantity }))
      ];
      await ensureEquipmentRepairMaterials(client, actor.playerId, materialCosts);
      await this.inventory.debitItemsForOperationInTransaction(client, {
        operationKey: `${operationKey}:materials`,
        playerId: actor.playerId,
        source: "equipment_repair",
        sourceEntityType: "equipment_repair_operation",
        sourceEntityId: operationKey,
        debits: materialCosts.map((material) => ({ ...material, variant: DEFAULT_INVENTORY_VARIANT }))
      });
      const after = conditionAfterRepair(before);
      const active = item.location === "equipped";
      await client.query(
        `UPDATE equipment_instances SET condition=$2, updated_at=now() WHERE instance_id=$1`,
        [instanceId, after]
      );
      await client.query(
        `UPDATE player_equipment_state
         SET inventory_revision=inventory_revision+1,
             active_revision=active_revision+$2::bigint,
             checkpoint_revision=checkpoint_revision+$2::bigint
         WHERE player_id=$1`,
        [actor.playerId, active ? 1 : 0]
      );
      if (active) await updateEquipmentChallengeProfile(client, actor.playerId);
      const inventory = await this.inventory.snapshotInTransaction(client, actor.playerId);
      const equipment = await loadEquipmentSnapshot(client, actor.playerId, this.contextFor(actor.playerId));
      const message = `${definition.displayName} repaired to ${after}/${EQUIPMENT_MAX_CONDITION}.`;
      const result: EquipmentRepairResult = {
        applied: true,
        replayed: false,
        instanceId,
        conditionBefore: before,
        conditionAfter: after,
        materialCosts,
        inventory,
        equipment,
        message
      };
      await client.query(
        `UPDATE equipment_repair_operations SET result=$2::jsonb, completed_at=now() WHERE operation_key=$1`,
        [operationKey, JSON.stringify(result)]
      );
      await client.query("COMMIT");
      committedSnapshot = equipment;
      this.operationCount += 1;
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      if (isInventoryCapacityError(error)) throw new EquipmentError("EQUIPMENT_INVENTORY_FULL", "This would exceed your carrying capacity");
      throw error;
    } finally {
      client.release();
      if (committedSnapshot) this.installMutationSnapshot(actor.playerId, committedSnapshot);
    }
  }

  /**
   * Mending Resin: spends one resin and restores condition on one carried or worn chest armor.
   * Debit, repair and the operation record commit together; a repeated request changes nothing.
   * Condition is stored 0-100, so a repair never goes past EQUIPMENT_MAX_CONDITION.
   */
  async mendEquipmentWithResin(
    actor: EquipmentActor,
    instanceId: string,
    requestId: string,
    stackId?: string
  ): Promise<EquipmentRepairResult> {
    requireIdentifier(actor.playerId, "player ID", 160);
    requireIdentifier(actor.accountId, "account ID", 160);
    requireIdentifier(instanceId, "equipment instance ID", 160);
    requireRequestId(requestId);
    const operationKey = `equipment-mend:${actor.accountId}:${requestId}`;
    const requestHash = createHash("sha256").update(JSON.stringify({ instanceId, resin: true })).digest("hex");
    const client = await this.pool.connect();
    let committedSnapshot: EquipmentSnapshotV2 | null = null;
    try {
      await client.query("BEGIN");
      await ensureEquipmentScaffold(client, actor.playerId);
      await lockInventoryCapacity(client, actor.playerId);
      const reserved = await client.query(
        `INSERT INTO equipment_repair_operations (
           operation_key,player_id,action,request_id,request_hash,instance_id
         ) VALUES ($1,$2,'resin_repair',$3,$4,$5)
         ON CONFLICT (operation_key) DO NOTHING
         RETURNING operation_key`,
        [operationKey, actor.playerId, requestId, requestHash, instanceId]
      );
      if (reserved.rowCount === 0) {
        const existing = await client.query<{ player_id: string; action: string; request_hash: string | null; instance_id: string | null; result: unknown; completed_at: Date | string | null }>(
          `SELECT player_id,action,request_hash,instance_id::text,result,completed_at
           FROM equipment_repair_operations WHERE operation_key=$1 FOR UPDATE`,
          [operationKey]
        );
        const row = existing.rows[0];
        const stored = storedRepairResult(row?.result);
        if (!row || row.player_id !== actor.playerId || row.action !== "resin_repair" ||
            row.request_hash !== requestHash || row.instance_id !== instanceId || !row.completed_at || !stored) {
          throw new EquipmentError("EQUIPMENT_IDEMPOTENCY_CONFLICT", "Mend request ID was reused with different intent");
        }
        const inventory = await this.inventory.snapshotInTransaction(client, actor.playerId);
        const equipment = await loadEquipmentSnapshot(client, actor.playerId, this.contextFor(actor.playerId));
        await client.query("COMMIT");
        committedSnapshot = equipment;
        return { ...stored, applied: false, replayed: true, inventory, equipment };
      }
      const locked = await client.query<EquipmentRow>(
        `${EQUIPMENT_ROW_SELECT} FROM equipment_instances WHERE instance_id=$1 FOR UPDATE`,
        [instanceId]
      );
      const item = locked.rows[0];
      if (!item || item.owner_player_id !== actor.playerId) {
        throw new EquipmentError("EQUIPMENT_NOT_OWNED", "Equipment instance is not owned by this player");
      }
      if (!isCarriedEquipmentLocation(item.location)) {
        throw new EquipmentError("EQUIPMENT_NOT_CARRIED", "Equipment must be in Inventory or equipped to be mended");
      }
      const definition = requireEquipmentDefinition(item.definition_id);
      if (definition.category !== "chest_armor" || !equipmentRepairCostForFamily(definition.gameplayFamilyId)) {
        throw new EquipmentError("EQUIPMENT_REPAIR_UNAVAILABLE", "Mending Resin only repairs chest armor");
      }
      const before = clampEquipmentCondition(item.condition);
      if (before >= EQUIPMENT_MAX_CONDITION) {
        throw new EquipmentError("EQUIPMENT_REPAIR_UNAVAILABLE", "This armor is already fully repaired");
      }
      const materialCosts: Array<{ itemId: ResourceType; quantity: number }> = [{ itemId: "mending_resin", quantity: 1 }];
      try {
        await this.inventory.debitItemsForOperationInTransaction(client, {
          operationKey: `${operationKey}:resin`,
          playerId: actor.playerId,
          source: "equipment_repair",
          sourceEntityType: "equipment_repair_operation",
          sourceEntityId: operationKey,
          ...(stackId ? { preferredStackId: stackId } : {}),
          debits: [{ itemId: "mending_resin", variant: null, quantity: 1 }]
        });
      } catch (error) {
        if (error instanceof Error && error.message === "Inventory does not contain enough items") {
          throw new EquipmentError("EQUIPMENT_REPAIR_MATERIALS_REQUIRED", "You do not have any Mending Resin");
        }
        throw error;
      }
      const points = (await tradeSkillRank(client, actor.playerId, "alchemy")) >= MENDING_RESIN_ALCHEMY_MIN_RANK
        ? MENDING_RESIN_ALCHEMY_REPAIR_POINTS
        : MENDING_RESIN_REPAIR_POINTS;
      const after = Math.min(EQUIPMENT_MAX_CONDITION, before + points);
      const active = item.location === "equipped";
      await client.query(`UPDATE equipment_instances SET condition=$2, updated_at=now() WHERE instance_id=$1`, [instanceId, after]);
      await client.query(
        `UPDATE player_equipment_state
         SET inventory_revision=inventory_revision+1,
             active_revision=active_revision+$2::bigint,
             checkpoint_revision=checkpoint_revision+$2::bigint
         WHERE player_id=$1`,
        [actor.playerId, active ? 1 : 0]
      );
      if (active) await updateEquipmentChallengeProfile(client, actor.playerId);
      const inventory = await this.inventory.snapshotInTransaction(client, actor.playerId);
      const equipment = await loadEquipmentSnapshot(client, actor.playerId, this.contextFor(actor.playerId));
      const result: EquipmentRepairResult = {
        applied: true,
        replayed: false,
        instanceId,
        conditionBefore: before,
        conditionAfter: after,
        materialCosts,
        inventory,
        equipment,
        message: `${definition.displayName} mended to ${after}/${EQUIPMENT_MAX_CONDITION}.`
      };
      await client.query(
        `UPDATE equipment_repair_operations SET result=$2::jsonb, completed_at=now() WHERE operation_key=$1`,
        [operationKey, JSON.stringify(result)]
      );
      await client.query("COMMIT");
      committedSnapshot = equipment;
      this.operationCount += 1;
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      if (isInventoryCapacityError(error)) throw new EquipmentError("EQUIPMENT_INVENTORY_FULL", "This would exceed your carrying capacity");
      throw error;
    } finally {
      client.release();
      if (committedSnapshot) this.installMutationSnapshot(actor.playerId, committedSnapshot);
    }
  }

  async craftRepairKit(
    actor: EquipmentActor,
    requestId: string,
    authority: EquipmentManorSmithContext
  ): Promise<RepairKitCraftResult> {
    requireIdentifier(actor.playerId, "player ID", 160);
    requireIdentifier(actor.accountId, "account ID", 160);
    requireRequestId(requestId);
    const operationKey = `repair-kit-craft:${actor.accountId}:${requestId}`;
    const materialCosts: Array<{ itemId: ResourceType; quantity: number }> =
      REPAIR_KIT_CRAFT_COSTS.map((material) => ({ ...material }));
    const requestHash = createHash("sha256").update("repair-kit-v1").digest("hex");
    const client = await this.pool.connect();
    let committedSnapshot: EquipmentSnapshotV2 | null = null;
    try {
      await client.query("BEGIN");
      await ensureEquipmentScaffold(client, actor.playerId);
      await lockInventoryCapacity(client, actor.playerId);
      await authority.authorize();
      const reserved = await client.query(
        `INSERT INTO equipment_repair_operations (operation_key,player_id,action,request_id,request_hash)
         VALUES ($1,$2,'craft_repair_kit',$3,$4)
         ON CONFLICT (operation_key) DO NOTHING RETURNING operation_key`,
        [operationKey, actor.playerId, requestId, requestHash]
      );
      if (reserved.rowCount === 0) {
        const existing = await client.query<{ player_id: string; action: string; request_hash: string | null; result: unknown; completed_at: Date | string | null }>(
          `SELECT player_id,action,request_hash,result,completed_at FROM equipment_repair_operations WHERE operation_key=$1 FOR UPDATE`,
          [operationKey]
        );
        const row = existing.rows[0];
        const stored = storedRepairKitCraftResult(row?.result);
        if (!row || row.player_id !== actor.playerId || row.action !== "craft_repair_kit" ||
            row.request_hash !== requestHash || !row.completed_at || !stored) {
          throw new EquipmentError("EQUIPMENT_IDEMPOTENCY_CONFLICT", "Repair Kit craft request ID was reused with different intent");
        }
        const inventory = await this.inventory.snapshotInTransaction(client, actor.playerId);
        const equipment = await loadEquipmentSnapshot(client, actor.playerId, this.contextFor(actor.playerId));
        await client.query("COMMIT");
        committedSnapshot = equipment;
        return { ...stored, applied: false, replayed: true, inventory, equipment };
      }
      const kitSpend = resolveMaterialSpend(
        "Repair Kit", materialCosts, REPAIR_KIT_CRAFT_CATEGORY_INPUTS,
        await spendableItemCounts(this.inventory, client, actor.playerId, false), {}
      );
      if (!kitSpend.ok) throw new EquipmentError("EQUIPMENT_REPAIR_MATERIALS_REQUIRED", kitSpend.failure.message);
      materialCosts.splice(0, materialCosts.length, ...kitSpend.debits.map((debit) => ({ itemId: debit.itemId as ResourceType, quantity: debit.quantity })));
      await ensureEquipmentRepairMaterials(client, actor.playerId, materialCosts);
      await this.inventory.debitItemsForOperationInTransaction(client, {
        operationKey: `${operationKey}:materials`,
        playerId: actor.playerId,
        source: "repair_kit_craft",
        sourceEntityType: "equipment_repair_operation",
        sourceEntityId: operationKey,
        debits: materialCosts.map((material) => ({ ...material, variant: DEFAULT_INVENTORY_VARIANT }))
      });
      await this.inventory.grantItemsForOperationInTransaction(client, {
        operationKey: `${operationKey}:kit`,
        playerId: actor.playerId,
        source: "repair_kit_craft",
        sourceEntityType: "equipment_repair_operation",
        sourceEntityId: operationKey,
        grants: [{ itemId: REPAIR_KIT_ITEM_ID, quantity: 1, variant: DEFAULT_INVENTORY_VARIANT }]
      });
      const inventory = await this.inventory.snapshotInTransaction(client, actor.playerId);
      const equipment = await loadEquipmentSnapshot(client, actor.playerId, this.contextFor(actor.playerId));
      const result: RepairKitCraftResult = {
        applied: true,
        replayed: false,
        quantity: 1,
        materialCosts,
        inventory,
        equipment,
        message: "Repair Kit crafted and added to Player Inventory."
      };
      await client.query(
        `UPDATE equipment_repair_operations SET result=$2::jsonb, completed_at=now() WHERE operation_key=$1`,
        [operationKey, JSON.stringify(result)]
      );
      await client.query("COMMIT");
      committedSnapshot = equipment;
      this.operationCount += 1;
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      if (isInventoryCapacityError(error)) throw new EquipmentError("EQUIPMENT_INVENTORY_FULL", "This would exceed your carrying capacity");
      throw error;
    } finally {
      client.release();
      if (committedSnapshot) this.installMutationSnapshot(actor.playerId, committedSnapshot);
    }
  }

  async snapshotInTransaction(
    queryable: Queryable,
    playerId: string
  ): Promise<EquipmentSnapshotV2> {
    await ensureEquipmentScaffold(queryable, playerId);
    return loadEquipmentSnapshot(queryable, playerId, this.contextFor(playerId));
  }

  async destroyCarriedInstanceForGoblinSaleInTransaction(
    queryable: Queryable,
    playerId: string,
    instanceId: string
  ): Promise<EquipmentSnapshotV2> {
    await ensureEquipmentScaffold(queryable, playerId);
    const locked = await queryable.query<{ definition_id: string; condition: number; ring_rough: boolean }>(
      `SELECT definition_id,condition,ring_rough
       FROM equipment_instances
       WHERE instance_id=$1 AND owner_player_id=$2 AND location='inventory'
       FOR UPDATE`,
      [instanceId, playerId]
    );
    const item = locked.rows[0];
    if (!item) {
      throw new EquipmentError(
        "EQUIPMENT_NOT_CARRIED",
        "Only an equipment instance carried in inventory can be sold"
      );
    }
    if (item.ring_rough) {
      throw new EquipmentError("EQUIPMENT_RING_ROUGH", "Polish this ring before you sell it");
    }
    const definition = requireEquipmentDefinition(item.definition_id);
    if (
      definition.category === "chest_armor" &&
      equipmentRepairCostForFamily(definition.gameplayFamilyId) &&
      clampEquipmentCondition(item.condition) < EQUIPMENT_MAX_CONDITION
    ) {
      throw new EquipmentError(
        "EQUIPMENT_REPAIR_UNAVAILABLE",
        "Eligible chest armor must be fully repaired before Goblin resale"
      );
    }
    const changed = await queryable.query(
      `UPDATE equipment_instances
       SET location='destroyed',equipped_slot=NULL,inventory_slot_index=NULL,
           manor_id=NULL,manor_slot_index=NULL,updated_at=now()
       WHERE instance_id=$1 AND owner_player_id=$2 AND location='inventory'
       RETURNING instance_id`,
      [instanceId, playerId]
    );
    if (changed.rowCount !== 1) {
      throw new EquipmentError(
        "EQUIPMENT_NOT_CARRIED",
        "Only an equipment instance carried in inventory can be sold"
      );
    }
    await queryable.query(
      `UPDATE player_equipment_state
       SET inventory_revision=inventory_revision+1,updated_at=now()
       WHERE player_id=$1`,
      [playerId]
    );
    return this.snapshotInTransaction(queryable, playerId);
  }

  async grantPackageInstancesInTransaction(
    queryable: Queryable,
    input: Readonly<{
      operationKey: string;
      playerId: string;
      grants: readonly PackageEquipmentGrant[];
      source?: string;
    }>
  ): Promise<Readonly<{
    applied: boolean;
    equipment: EquipmentSnapshotV2;
    grants: readonly PackageEquipmentGrantResult[];
  }>> {
    requireIdentifier(input.operationKey, "operation key", 240);
    requireIdentifier(input.playerId, "player ID", 160);
    if (input.grants.length === 0) {
      return {
        applied: false,
        equipment: await this.snapshotInTransaction(queryable, input.playerId),
        grants: []
      };
    }
    const normalized = input.grants.map((grant) => {
      const definition = requireEquipmentDefinition(grant.definitionId);
      if (!Number.isSafeInteger(grant.quantity) || grant.quantity <= 0 || grant.quantity > 100) {
        throw new EquipmentError(
          "EQUIPMENT_INVALID_REQUEST",
          "Package equipment quantity is invalid"
        );
      }
      if (grant.enchantmentIdentity !== undefined && parseEquipmentEnhancement(grant.enchantmentIdentity) === null) {
        throw new EquipmentError(
          "EQUIPMENT_INVALID_REQUEST",
          "Package equipment enhancement identity is invalid"
        );
      }
      const ringTier = ringTierForDefinitionId(definition.definitionId);
      if (
        (ringTier === null && (grant.ringPolished !== undefined || grant.ringBonuses !== undefined)) ||
        (ringTier !== null && grant.ringBonuses !== undefined && !isValidRingBonusRolls(ringTier, grant.ringBonuses))
      ) {
        throw new EquipmentError("EQUIPMENT_INVALID_REQUEST", "Package ring grant is invalid");
      }
      return {
        definitionId: definition.definitionId,
        quantity: grant.quantity,
        ...(grant.enchantmentIdentity === undefined ? {} : { enchantmentIdentity: grant.enchantmentIdentity }),
        ...(grant.ringPolished === undefined ? {} : { ringPolished: grant.ringPolished }),
        ...(grant.ringBonuses === undefined ? {} : { ringBonuses: grant.ringBonuses })
      };
    });
    if (
      normalized.reduce((total, grant) => total + grant.quantity, 0) > 100 ||
      new Set(normalized.map((grant) => grant.definitionId)).size !== normalized.length
    ) {
      throw new EquipmentError(
        "EQUIPMENT_INVALID_REQUEST",
        "Package equipment grants exceed the canonical limits"
      );
    }

    await ensureEquipmentScaffold(queryable, input.playerId);
    await lockInventoryCapacity(queryable, input.playerId);
    const requested = normalized.map((grant) => ({
      definitionId: grant.definitionId,
      quantity: grant.quantity,
      ...(grant.enchantmentIdentity === undefined ? {} : { enchantmentIdentity: grant.enchantmentIdentity }),
      ...(grant.ringPolished === undefined ? {} : { ringPolished: grant.ringPolished }),
      ...(grant.ringBonuses === undefined ? {} : { ringBonuses: grant.ringBonuses })
    }));
    const reserved = await queryable.query(
      `INSERT INTO equipment_operations (
         operation_key, player_id, action, result
       ) VALUES ($1,$2,'package_grant',$3::jsonb)
       ON CONFLICT (operation_key) DO NOTHING
       RETURNING operation_key`,
      [
        input.operationKey,
        input.playerId,
        JSON.stringify({ requested, grants: null })
      ]
    );
    if (reserved.rowCount === 0) {
      const existing = await queryable.query<{
        player_id: string;
        action: string;
        result: unknown;
        completed_at: Date | string | null;
      }>(
        `SELECT player_id, action, result, completed_at
         FROM equipment_operations
         WHERE operation_key = $1
         FOR UPDATE`,
        [input.operationKey]
      );
      const row = existing.rows[0];
      const stored = packageGrantOperationResult(row?.result);
      if (
        !row ||
        row.player_id !== input.playerId ||
        row.action !== "package_grant" ||
        JSON.stringify(stored.requested) !== JSON.stringify(requested) ||
        !row.completed_at ||
        stored.grants === null
      ) {
        throw new EquipmentError(
          "EQUIPMENT_IDEMPOTENCY_CONFLICT",
          "Package equipment operation key was reused"
        );
      }
      return {
        applied: false,
        equipment: await loadEquipmentSnapshot(
          queryable,
          input.playerId,
          this.contextFor(input.playerId)
        ),
        grants: stored.grants
      };
    }

    const results: PackageEquipmentGrantResult[] = [];
    let created = 0;
    for (const grant of normalized) {
      let grantedQuantity = 0;
      const fittingQuantity = Number(await fittingInventoryQuantityInTransaction(
        queryable, input.playerId, grant.definitionId, BigInt(grant.quantity)
      ));
      const ringTier = ringTierForDefinitionId(grant.definitionId);
      for (let index = 0; index < fittingQuantity; index += 1) {
        // Ring rolls happen here, server-side, once per created instance.
        const ringBonuses = ringTier === null
          ? null
          : grant.ringBonuses ?? rollRingBonuses(ringTier, serverRingRandom);
        const ringRough = ringTier !== null && ringTier !== "plain" && grant.ringPolished !== true;
        await queryable.query(
          `INSERT INTO equipment_instances (
             instance_id, definition_id, owner_player_id, location, equipped_slot,
             inventory_slot_index, item_level, balance_version,
             enchantment_identity, created_by_operation_key, metadata,
             ring_bonuses, ring_rough, uses_remaining
           ) VALUES (
             gen_random_uuid(),$1,$2,'inventory',NULL,$3,0,$4,$7,$5,$6::jsonb,$8::jsonb,$9,$10
           )`,
          [
            grant.definitionId,
            input.playerId,
            null,
            EQUIPMENT_BALANCE_VERSION,
            input.operationKey,
            JSON.stringify({ source: input.source ?? "player_package" }),
            grant.enchantmentIdentity ?? null,
            ringBonuses === null ? null : JSON.stringify(ringBonuses),
            ringRough,
            isUtilityGearDefinitionId(grant.definitionId) ? UTILITY_GEAR[grant.definitionId].uses : null
          ]
        );
        grantedQuantity += 1;
        created += 1;
      }
      results.push({
        definitionId: grant.definitionId,
        requestedQuantity: grant.quantity,
        grantedQuantity
      });
    }
    if (created > 0) {
      await queryable.query(
        `UPDATE player_equipment_state
         SET inventory_revision = inventory_revision + 1
         WHERE player_id = $1`,
        [input.playerId]
      );
    }
    await queryable.query(
      `UPDATE equipment_operations
       SET result = $2::jsonb, completed_at = now()
       WHERE operation_key = $1`,
      [input.operationKey, JSON.stringify({ requested, grants: results })]
    );
    return {
      applied: created > 0,
      equipment: await loadEquipmentSnapshot(
        queryable,
        input.playerId,
        this.contextFor(input.playerId)
      ),
      grants: results
    };
  }

  /**
   * Developer test grant: one stock instance already infused with a metal (gem-less identity).
   * Idempotent per request ID; goes through the normal package-grant instance insert.
   */
  async grantDeveloperMetalEquipment(
    playerId: string,
    requestId: string,
    definitionId: EquipmentDefinitionId,
    metal: EquipmentMetal
  ): Promise<Readonly<{ applied: boolean; equipment: EquipmentSnapshotV2 }>> {
    requireIdentifier(playerId, "player ID", 160);
    requireRequestId(requestId);
    const client = await this.pool.connect();
    let committed: EquipmentSnapshotV2 | null = null;
    try {
      await client.query("BEGIN");
      const result = await this.grantPackageInstancesInTransaction(client, {
        operationKey: `dev-metal-grant:${playerId}:${requestId}`,
        playerId,
        source: "developer_metal_grant",
        grants: [{
          definitionId,
          quantity: 1,
          enchantmentIdentity: serializeEquipmentEnhancement(metalEquipmentEnhancement(null, metal))
        }]
      });
      await client.query("COMMIT");
      committed = result.equipment;
      return { applied: result.applied, equipment: result.equipment };
    } catch (error) {
      await client.query("ROLLBACK");
      if (isInventoryCapacityError(error)) {
        throw new EquipmentError("EQUIPMENT_INVENTORY_FULL", "This would exceed your carrying capacity");
      }
      throw error;
    } finally {
      client.release();
      if (committed) this.installMutationSnapshot(playerId, committed);
    }
  }

  /**
   * Overflow loot: inserts one rolled ring straight into inventory under an already reserved
   * operation key so the caller can move it onto the ground in the same transaction (the carry
   * guard is deferred to commit, when the ring is no longer carried).
   */
  async insertOverflowRingInTransaction(
    queryable: Queryable,
    input: Readonly<{ operationKey: string; playerId: string; definitionId: EquipmentDefinitionId; source: string }>
  ): Promise<string> {
    const tier = ringTierForDefinitionId(input.definitionId);
    if (tier === null) throw new EquipmentError("EQUIPMENT_RING_INVALID", "Only rings overflow to the ground here");
    const instanceId = crypto.randomUUID();
    await queryable.query(
      `INSERT INTO equipment_instances (
         instance_id, definition_id, owner_player_id, location, equipped_slot,
         inventory_slot_index, item_level, balance_version,
         enchantment_identity, created_by_operation_key, metadata, ring_bonuses, ring_rough
       ) VALUES ($1,$2,$3,'inventory',NULL,NULL,0,$4,NULL,$5,$6::jsonb,$7::jsonb,$8)`,
      [
        instanceId,
        input.definitionId,
        input.playerId,
        EQUIPMENT_BALANCE_VERSION,
        input.operationKey,
        JSON.stringify({ source: input.source, overflow: "ground" }),
        JSON.stringify(rollRingBonuses(tier, serverRingRandom)),
        tier !== "plain"
      ]
    );
    return instanceId;
  }

  /**
   * Polishes a Rough ring carried in inventory: spends Glimmer Oil (half for Atlas Pass holders)
   * and reveals its bonuses, in one transaction. Idempotent per request ID.
   */
  async polishRing(playerId: string, instanceId: string, requestId: string): Promise<RingOperationResult> {
    return this.ringOperation(playerId, instanceId, requestId, "polish");
  }

  /**
   * Dumps a carried ring for Ring Shards only (no gold): fewer for a Rough ring. The ring is
   * destroyed and the shards granted in one transaction. Idempotent per request ID.
   */
  async dumpRing(playerId: string, instanceId: string, requestId: string): Promise<RingOperationResult> {
    return this.ringOperation(playerId, instanceId, requestId, "dump");
  }

  /**
   * Crafts one utility item (Atlas Pass members only, checked inside the transaction). The material
   * debit and the new instance commit together; a replayed request charges once.
   */
  async craftUtilityGear(playerId: string, requestId: string, definitionId: string, accountId?: string): Promise<UtilityGearCraftResult> {
    requireIdentifier(playerId, "player ID", 160);
    requireRequestId(requestId);
    if (!isUtilityGearDefinitionId(definitionId)) {
      throw new EquipmentError("UTILITY_GEAR_INVALID", "That item cannot be crafted here");
    }
    this.assertNoPendingActivation(playerId);
    const spec = UTILITY_GEAR[definitionId];
    const operation = `utility-gear-craft:${playerId}:${requestId}`;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await ensureEquipmentScaffold(client, playerId);
      if (spec.atlasPassOnly && !(await hasActiveAtlasPass(client, playerId))) {
        throw new EquipmentError("UTILITY_GEAR_PASS_REQUIRED", "Utility gear is crafted by Atlas Pass members");
      }
      if (spec.tradeGate) {
        await requireTradeSkillGate(client, playerId, spec.tradeGate, (message) => new EquipmentError("EQUIPMENT_CRAFT_SKILL_REQUIRED", message));
      }
      let utilityWallet: Awaited<ReturnType<EquipmentWallet["debitForOperationInTransaction"]>> | null = null;
      if (spec.goldCost) {
        if (!accountId) throw new EquipmentError("UTILITY_GEAR_INVALID", "This craft needs an authenticated account");
        utilityWallet = await this.wallet.debitForOperationInTransaction(client, {
          playerId,
          accountId,
          amount: BigInt(spec.goldCost),
          operationKey: `${operation}:gold`,
          reason: "utility_gear_craft"
        });
      }
      const debited = await this.inventory.debitItemsForOperationInTransaction(client, {
        operationKey: operation,
        playerId,
        source: "utility_gear_craft",
        sourceEntityType: "utility_gear",
        sourceEntityId: definitionId,
        debits: spec.materials.map((material) => ({
          itemId: material.itemId, variant: null, quantity: material.quantity
        }))
      });
      // A replay already holds its instance; only the first pass creates one.
      if (debited.applied) {
        await this.grantPackageInstancesInTransaction(client, {
          operationKey: `${operation}:item`,
          playerId,
          grants: [{ definitionId, quantity: 1 }],
          source: "utility_gear_craft"
        });
      }
      const created = await client.query<{ instance_id: string }>(
        `SELECT instance_id::text FROM equipment_instances
          WHERE created_by_operation_key = $1 AND owner_player_id = $2
          ORDER BY created_at LIMIT 1`,
        [`${operation}:item`, playerId]
      );
      const instanceId = created.rows[0]?.instance_id;
      if (!instanceId) {
        // Pack full: nothing was created, so the debit rolls back with it.
        throw new EquipmentError("EQUIPMENT_INVENTORY_FULL", "This would exceed your carrying capacity");
      }
      const inventory = await this.inventory.snapshotInTransaction(client, playerId);
      await client.query("COMMIT");
      const equipment = await this.syncUtilityGear(playerId);
      this.operationCount += 1;
      return {
        replayed: !debited.applied, definitionId, instanceId, inventory, equipment,
        ...(utilityWallet ? { walletGold: utilityWallet.goldBalance.toString(), walletVersion: utilityWallet.version.toString() } : {})
      };
    } catch (error) {
      await client.query("ROLLBACK");
      if (error instanceof WalletOperationError && error.code === "WALLET_INSUFFICIENT_FUNDS") {
        throw new EquipmentError("EQUIPMENT_INVENTORY_FULL", `${spec.displayName} needs ${spec.goldCost} gold`);
      }
      if (isInventoryShortageError(error)) {
        throw new EquipmentError("EQUIPMENT_INVENTORY_FULL", `${spec.displayName} needs more materials`);
      }
      if (isInventoryCapacityError(error)) {
        throw new EquipmentError("EQUIPMENT_INVENTORY_FULL", "This would exceed your carrying capacity");
      }
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Crafts one Loadout Scroll (Atlas Pass members only, checked inside the transaction). The
   * Lumen and material debit and the granted scroll commit together; a replayed request charges once.
   */
  async craftGearScroll(playerId: string, requestId: string): Promise<Readonly<{
    replayed: boolean;
    inventory: PlayerInventorySnapshot;
    gearScrolls: GearScrollsSnapshot;
  }>> {
    requireIdentifier(playerId, "player ID", 160);
    requireRequestId(requestId);
    const operation = `gear-scroll-craft:${playerId}:${requestId}`;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      if (!(await hasActiveAtlasPass(client, playerId))) {
        throw new EquipmentError("UTILITY_GEAR_PASS_REQUIRED", "Loadout Scrolls are crafted by Atlas Pass members");
      }
      const debited = await this.inventory.debitItemsForOperationInTransaction(client, {
        operationKey: operation,
        playerId,
        source: "gear_scroll_craft",
        sourceEntityType: "gear_scroll",
        sourceEntityId: LOADOUT_SCROLL_ITEM_ID,
        debits: LOADOUT_SCROLL_MATERIALS.map((material) => ({
          itemId: material.itemId, variant: null, quantity: material.quantity
        }))
      });
      // A replay already holds its scroll; only the first pass grants one.
      if (debited.applied) {
        await this.inventory.grantItemsForOperationInTransaction(client, {
          operationKey: `${operation}:item`,
          playerId,
          source: "gear_scroll_craft",
          sourceEntityType: "gear_scroll",
          sourceEntityId: LOADOUT_SCROLL_ITEM_ID,
          grants: [{ itemId: LOADOUT_SCROLL_ITEM_ID, variant: null, quantity: 1 }]
        });
      }
      const inventory = await this.inventory.snapshotInTransaction(client, playerId);
      const gearScrolls = await loadGearScrollsSnapshot(client, playerId, this.lastGearScroll.get(playerId) ?? null);
      await client.query("COMMIT");
      this.operationCount += 1;
      return { replayed: !debited.applied, inventory, gearScrolls };
    } catch (error) {
      await client.query("ROLLBACK");
      if (isInventoryShortageError(error)) {
        throw new EquipmentError("EQUIPMENT_INVENTORY_FULL", "A Loadout Scroll needs more materials");
      }
      if (isInventoryCapacityError(error)) {
        throw new EquipmentError("EQUIPMENT_INVENTORY_FULL", "This would exceed your carrying capacity");
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async gearScrolls(playerId: string): Promise<GearScrollsSnapshot> {
    requireIdentifier(playerId, "player ID", 160);
    const client = await this.pool.connect();
    try {
      return await loadGearScrollsSnapshot(client, playerId, this.lastGearScroll.get(playerId) ?? null);
    } finally {
      client.release();
    }
  }

  /**
   * Remembers what is worn now in one group of slots (weapons and armor, or rings) on the scroll at
   * `position`. Stores equipment instance ids, never copies; an empty slot is forgotten.
   */
  async rememberGearScroll(
    playerId: string,
    position: number,
    group: GearScrollMemoryGroup
  ): Promise<GearScrollsSnapshot> {
    requireIdentifier(playerId, "player ID", 160);
    const slots = gearScrollSlotsForGroup(group);
    const worn = this.runtimes.get(playerId)?.snapshot ?? await this.getSnapshot(playerId);
    const memory: GearScrollMemory = {};
    for (const slot of slots) {
      const item = worn.active[slot];
      if (item && !isUtilityGearDefinitionId(item.definitionId)) memory[slot] = item.instanceId;
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await this.requireCarriedGearScroll(client, playerId, position);
      await writeGearScrollMemory(client, playerId, position, slots, memory);
      const snapshot = await loadGearScrollsSnapshot(client, playerId, this.lastGearScroll.get(playerId) ?? null);
      await client.query("COMMIT");
      return snapshot;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Equips the scroll at `position`: every remembered item the player still carries goes on; items
   * sold, dropped, traded or unusable are skipped. Never consumes the scroll and costs nothing.
   * Swaps run one at a time per player and only the latest waiting request counts. `exclusive`
   * lets the realtime layer hold its equipment mutation guard around the swap itself.
   */
  equipGearScroll(
    playerId: string,
    position: number,
    requestId: string,
    options: Readonly<{
      exclusive?: <Value>(work: () => Promise<Value>) => Promise<Value>;
      /** Runs inside `exclusive` after a swap changed the worn set (stages the tick-boundary combat update). */
      onApplied?(equipment: EquipmentSnapshotV2, requestId: string): void | Promise<void>;
      /**
       * Whether the active class can use this readied weapon and chest armor. Called inside
       * `exclusive`; remembered items that would break it are skipped like missing ones.
       */
      classAllows?(weapon: EquipmentDefinition | null, chest: EquipmentDefinition | null): boolean;
    }> = {}
  ): Promise<GearScrollEquipOutcome> {
    const exclusive = options.exclusive ?? (<Value>(work: () => Promise<Value>) => work());
    requireIdentifier(playerId, "player ID", 160);
    requireRequestId(requestId);
    if (!Number.isInteger(position) || position < 1) {
      throw new EquipmentError("GEAR_SCROLL_INVALID", "That scroll does not exist");
    }
    return this.gearScrollSwaps.submit(playerId, position, requestId, (nextPosition, nextRequestId) =>
      exclusive(async () => {
        const result = await this.applyGearScroll(playerId, nextPosition, options.classAllows);
        this.lastGearScroll.set(playerId, nextPosition);
        const worn = this.runtimes.get(playerId)?.snapshot;
        if (result.changed && worn) await options.onApplied?.(worn, nextRequestId);
        return { kind: "applied" as const, requestId: nextRequestId, position: nextPosition, ...result };
      })
    );
  }

  /**
   * The scroll stacks are locked FOR SHARE until commit: a trade, drop or sale that takes a scroll
   * (it locks the same rows FOR UPDATE) waits for this transaction, so its commit-time memory prune
   * sees memory written here, and a debit that committed first is seen in the count.
   */
  private async requireCarriedGearScroll(client: pg.PoolClient, playerId: string, position: number): Promise<void> {
    if (!Number.isInteger(position) || position < 1) {
      throw new EquipmentError("GEAR_SCROLL_INVALID", "That scroll is not in your inventory");
    }
    const stacks = await client.query<{ quantity: string }>(
      `SELECT quantity::text FROM player_inventory
        WHERE player_id = $1 AND resource_type = $2
        FOR SHARE`,
      [playerId, LOADOUT_SCROLL_ITEM_ID]
    );
    const carried = stacks.rows.reduce((total, row) => total + Number(row.quantity), 0);
    if (position > carried) {
      throw new EquipmentError("GEAR_SCROLL_INVALID", "That scroll is not in your inventory");
    }
  }

  /**
   * One short transaction: lock the equipment state, the remembered rows and the worn rows, move
   * only the slots that change, and bump the active revision (not the inventory revision, like a
   * combat-kit activation). Locations are durable at commit, so trade, drop, market and storage
   * paths, which lock the same rows and require location 'inventory', always see the swap.
   */
  private async applyGearScroll(
    playerId: string,
    position: number,
    classAllows?: (weapon: EquipmentDefinition | null, chest: EquipmentDefinition | null) => boolean
  ): Promise<Readonly<{
    changed: boolean; equipped: number; skipped: number;
  }>> {
    const runtime = this.requireRuntime(playerId);
    this.assertNoPendingActivation(playerId);
    if (runtime.dirtyCheckpoint) await this.flushCheckpoint(runtime.dirtyCheckpoint);
    const client = await this.pool.connect();
    let committed: EquipmentSnapshotV2 | null = null;
    let outcome: { changed: boolean; equipped: number; skipped: number };
    try {
      await client.query("BEGIN");
      await ensureEquipmentScaffold(client, playerId);
      const state = await client.query<{ active_revision: string; readied_weapon_slot: ReadiedWeaponSlot }>(
        `SELECT active_revision::text, readied_weapon_slot FROM player_equipment_state
          WHERE player_id = $1 FOR UPDATE`,
        [playerId]
      );
      const stateRow = state.rows[0];
      if (!stateRow) throw new EquipmentError("EQUIPMENT_PLAYER_NOT_FOUND", "Player equipment state does not exist");
      await this.requireCarriedGearScroll(client, playerId, position);
      const memory = await loadGearScrollMemory(client, playerId, position);
      const rememberedIds = GEAR_SCROLL_SLOTS.map((slot) => memory[slot]).filter((id): id is string => Boolean(id));
      const locked = await client.query<EquipmentRow>(
        `${EQUIPMENT_ROW_SELECT}
           FROM equipment_instances
          WHERE instance_id = ANY($2::uuid[])
             OR (owner_player_id = $1 AND location = 'equipped')
          ORDER BY instance_id
          FOR UPDATE`,
        [playerId, rememberedIds]
      );
      const byId = new Map(locked.rows.map((row) => [row.instance_id, row]));
      const current = emptyEquipmentSlots<string | null>(null);
      for (const row of locked.rows) {
        if (row.owner_player_id === playerId && row.location === "equipped" && row.equipped_slot && row.equipped_slot !== "weapon") {
          current[row.equipped_slot] = row.instance_id;
        }
      }
      const hasBitterBlood = await playerHasAchievement(client, playerId, "bitter_blood", this.achievementIdsFor(playerId));
      const selection = { ...current };
      let equipped = 0;
      let skipped = 0;
      for (const slot of GEAR_SCROLL_SLOTS) {
        const instanceId = memory[slot];
        if (!instanceId) continue;
        const row = byId.get(instanceId);
        if (!row || !gearScrollRowUsable(row, slot, playerId, hasBitterBlood)) {
          skipped += 1;
          continue;
        }
        // A remembered ring worn in the other ring slot moves instead of being worn twice.
        for (const other of EQUIPMENT_SLOTS) {
          if (other !== slot && selection[other] === instanceId) selection[other] = null;
        }
        selection[slot] = instanceId;
        equipped += 1;
      }
      const readiedFor = (candidate: EquipmentSlotRecord<string | null>): ReadiedWeaponSlot => {
        const secondaryRow = byId.get(candidate.secondary ?? "");
        return stateRow.readied_weapon_slot === "secondary" && (
          !secondaryRow || requireEquipmentDefinition(secondaryRow.definition_id).category !== "ranged_weapon"
        ) ? "melee" : stateRow.readied_weapon_slot;
      };
      const definitionIn = (candidate: EquipmentSlotRecord<string | null>, slot: EquipmentSlot) => {
        const row = byId.get(candidate[slot] ?? "");
        return row ? requireEquipmentDefinition(row.definition_id) : null;
      };
      const classFits = (candidate: EquipmentSlotRecord<string | null>) =>
        !classAllows || classAllows(definitionIn(candidate, readiedFor(candidate)), definitionIn(candidate, "chest"));
      // Remembered weapons or armor the active class cannot use are skipped; the worn item stays.
      // First drop each item that does not fit with the current gear, then any left that still clash.
      const keepWorn = (slot: "chest" | "melee" | "secondary") => {
        selection[slot] = current[slot];
        equipped -= 1;
        skipped += 1;
      };
      for (const pass of ["solo", "combined"] as const) {
        for (const slot of ["chest", "melee", "secondary"] as const) {
          if (classFits(selection)) break;
          if (!memory[slot] || selection[slot] === current[slot]) continue;
          if (pass === "combined" || !classFits({ ...current, [slot]: selection[slot] })) keepWorn(slot);
        }
      }
      const readied = readiedFor(selection);
      const changedSlots = EQUIPMENT_SLOTS.filter((slot) => selection[slot] !== current[slot]);
      const changed = changedSlots.length > 0 || readied !== stateRow.readied_weapon_slot;
      if (changed) {
        // Safety net: the final selection must pass the same checks a kit activation does.
        assertLockedSelection(playerId, selection, readied, locked.rows, 0, hasBitterBlood, true);
        await client.query(
          `UPDATE equipment_instances SET location = 'inventory', equipped_slot = NULL
            WHERE owner_player_id = $1 AND location = 'equipped' AND equipped_slot = ANY($2::text[])`,
          [playerId, changedSlots]
        );
        const placed = changedSlots.filter((slot) => selection[slot]);
        await client.query(
          `UPDATE equipment_instances AS equipment
              SET location = 'equipped', equipped_slot = placed.slot, inventory_slot_index = NULL
             FROM unnest($2::uuid[], $3::text[]) AS placed(instance_id, slot)
            WHERE equipment.owner_player_id = $1 AND equipment.instance_id = placed.instance_id`,
          [playerId, placed.map((slot) => selection[slot]), placed]
        );
        const activeRevision = databaseRevision(stateRow.active_revision, "active revision") + 1;
        await client.query(
          `UPDATE player_equipment_state
              SET active_revision = $2::bigint, checkpoint_revision = $2::bigint,
                  readied_weapon_slot = $3, active_kit_index = NULL
            WHERE player_id = $1`,
          [playerId, String(activeRevision), readied]
        );
        await updateEquipmentChallengeProfile(client, playerId);
        const known = new Set(runtime.snapshot.instances.map((instance) => instance.instanceId));
        committed = EQUIPMENT_SLOTS.every((slot) => !selection[slot] || known.has(selection[slot]!))
          && runtime.snapshot.activeRevision === activeRevision - 1
          ? rebuildSnapshot(runtime.snapshot, selection, readied, null, activeRevision, activeRevision, runtime.context)
          : await loadEquipmentSnapshot(client, playerId, this.contextFor(playerId));
      }
      await client.query("COMMIT");
      outcome = { changed, equipped, skipped };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    if (committed) {
      this.installMutationSnapshot(playerId, committed);
      this.operationCount += 1;
    }
    return outcome;
  }

  private async ringOperation(
    playerId: string,
    instanceId: string,
    requestId: string,
    action: "polish" | "dump"
  ): Promise<RingOperationResult> {
    requireIdentifier(playerId, "player ID", 160);
    requireIdentifier(instanceId, "equipment instance ID", 160);
    requireRequestId(requestId);
    this.assertNoPendingActivation(playerId);
    const operationKey = `ring-${action}:${playerId}:${requestId}`;
    const client = await this.pool.connect();
    let committed: EquipmentSnapshotV2 | null = null;
    try {
      await client.query("BEGIN");
      await ensureEquipmentScaffold(client, playerId);
      await client.query("SELECT player_id FROM player_equipment_state WHERE player_id = $1 FOR UPDATE", [playerId]);
      const prior = await client.query<{
        player_id: string; action: string; instance_id: string; tier: RingTier;
        oil_spent: number; shards_granted: number;
      }>(
        `SELECT player_id, action, instance_id::text, tier, oil_spent, shards_granted
         FROM ring_operations WHERE operation_key = $1`,
        [operationKey]
      );
      const replay = prior.rows[0];
      if (replay) {
        if (replay.player_id !== playerId || replay.action !== action || replay.instance_id !== instanceId) {
          throw new EquipmentError("EQUIPMENT_IDEMPOTENCY_CONFLICT", "Ring operation request ID was reused");
        }
        const equipment = await loadEquipmentSnapshot(client, playerId, this.contextFor(playerId));
        const inventory = await this.inventory.snapshotInTransaction(client, playerId);
        await client.query("COMMIT");
        return {
          applied: false, replayed: true, equipment, inventory, tier: replay.tier,
          oilSpent: replay.oil_spent, shardsGranted: replay.shards_granted
        };
      }
      const locked = await client.query<EquipmentRow>(
        `${EQUIPMENT_ROW_SELECT} FROM equipment_instances WHERE instance_id = $1 FOR UPDATE`,
        [instanceId]
      );
      const row = locked.rows[0];
      if (!row || row.owner_player_id !== playerId) {
        throw new EquipmentError("EQUIPMENT_NOT_OWNED", "That ring is not yours");
      }
      const tier = ringTierForDefinitionId(row.definition_id);
      if (tier === null) {
        throw new EquipmentError("EQUIPMENT_RING_INVALID", "Only rings can be polished or dumped");
      }
      if (row.location !== "inventory") {
        throw new EquipmentError(
          "EQUIPMENT_NOT_CARRIED",
          row.location === "equipped" ? "Take the ring off first" : "The ring must be in your inventory"
        );
      }
      const rough = row.ring_rough === true;
      let oilSpent = 0;
      let shardsGranted = 0;
      if (action === "polish") {
        if (!rough) throw new EquipmentError("EQUIPMENT_RING_INVALID", "This ring is already polished");
        const atlasPass = await hasActiveAtlasPass(client, playerId);
        oilSpent = ringPolishCost(tier, atlasPass);
        if (oilSpent > 0) {
          try {
            await this.inventory.debitItemsForOperationInTransaction(client, {
              operationKey,
              playerId,
              source: "ring_polish",
              sourceEntityType: "equipment_instance",
              sourceEntityId: instanceId,
              metadata: { tier, atlasPass },
              debits: [{ itemId: "refined_oil" as ResourceType, variant: null, quantity: oilSpent }]
            });
          } catch (error) {
            if (isInventoryShortageError(error)) {
              throw new EquipmentError(
                "EQUIPMENT_RING_OIL_REQUIRED",
                `Polishing needs ${oilSpent} Glimmer Oil`
              );
            }
            throw error;
          }
        }
        const polished = await client.query(
          `UPDATE equipment_instances SET ring_rough = false, updated_at = now()
           WHERE instance_id = $1 AND owner_player_id = $2 AND ring_rough`,
          [instanceId, playerId]
        );
        if (polished.rowCount !== 1) throw new EquipmentError("EQUIPMENT_RING_INVALID", "The ring changed; try again");
      } else {
        shardsGranted = ringDumpShards(tier, rough);
        const destroyed = await client.query(
          `UPDATE equipment_instances
           SET location = 'destroyed', equipped_slot = NULL, inventory_slot_index = NULL,
               manor_id = NULL, manor_slot_index = NULL, updated_at = now()
           WHERE instance_id = $1 AND owner_player_id = $2 AND location = 'inventory'`,
          [instanceId, playerId]
        );
        if (destroyed.rowCount !== 1) throw new EquipmentError("EQUIPMENT_NOT_CARRIED", "The ring must be in your inventory");
        await this.inventory.grantItemsForOperationInTransaction(client, {
          operationKey,
          playerId,
          source: "ring_dump",
          sourceEntityType: "equipment_instance",
          sourceEntityId: instanceId,
          metadata: { tier, rough },
          grants: [{ itemId: RING_SHARD_ITEM_ID as ResourceType, variant: null, quantity: shardsGranted }]
        });
      }
      await client.query(
        `INSERT INTO ring_operations (
           operation_key, player_id, action, instance_id, tier, was_rough, oil_spent, shards_granted
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [operationKey, playerId, action, instanceId, tier, rough, oilSpent, shardsGranted]
      );
      await client.query(
        `UPDATE player_equipment_state SET inventory_revision = inventory_revision + 1, updated_at = now()
         WHERE player_id = $1`,
        [playerId]
      );
      const equipment = await loadEquipmentSnapshot(client, playerId, this.contextFor(playerId));
      const inventory = await this.inventory.snapshotInTransaction(client, playerId);
      await client.query("COMMIT");
      committed = equipment;
      this.operationCount += 1;
      return { applied: true, replayed: false, equipment, inventory, tier, oilSpent, shardsGranted };
    } catch (error) {
      await client.query("ROLLBACK");
      if (isInventoryCapacityError(error)) {
        throw new EquipmentError("EQUIPMENT_INVENTORY_FULL", "This would exceed your carrying capacity");
      }
      throw error;
    } finally {
      client.release();
      if (committed) this.installMutationSnapshot(playerId, committed);
    }
  }


  /**
   * Brings committed carried-item state into the runtime after a utility-gear use, a craft or a
   * sale, and returns the runtime snapshot: utility items (uses left, a used-up item destroyed, its
   * replacement worn) come from the database, and items no longer carried (sold, destroyed) are
   * dropped. Every other slot, the readied weapon and the active kit stay as they are, so an applied
   * but not yet saved kit activation, or a staged one, survives. When the result differs from the
   * durable loadout, or a save is already pending, it is queued at a revision newer than the
   * database's so the checkpoint flush writes it.
   */
  async syncUtilityGear(playerId: string): Promise<EquipmentSnapshotV2> {
    for (let attempt = 0; ; attempt += 1) {
      const runtime = this.runtimes.get(playerId);
      if (!runtime) return this.loadFreshSnapshot(playerId, this.contextFor(playerId));
      const before = runtime.snapshot;
      const fresh = await this.loadFreshSnapshot(playerId, runtime.context);
      if (this.runtimes.get(playerId) !== runtime) continue;
      // Another mutation installed a newer snapshot while this read ran: read again so a stale
      // durable view never overwrites it.
      if (runtime.snapshot !== before && attempt < 3) continue;
      // Still older than memory after the retries: a later database read (which already saw any
      // destroyed item) is installed, so a merge would only move the runtime backwards.
      if (fresh.inventoryRevision < runtime.snapshot.inventoryRevision) return runtime.snapshot;
      const base = runtime.snapshot;
      const selection = carriedSelectionFrom(base, fresh);
      const drift = EQUIPMENT_SLOTS.some((slot) => selection[slot] !== (fresh.active[slot]?.instanceId ?? null)) ||
        base.readiedWeaponSlot !== fresh.readiedWeaponSlot ||
        base.activeKitIndex !== fresh.activeKitIndex;
      const queued = drift || runtime.dirtyCheckpoint !== null;
      const merged = deepFreeze(withCarriedStateFrom(
        base,
        fresh,
        queued
          ? Math.max(base.activeRevision, fresh.activeRevision + 1)
          : Math.max(base.activeRevision, fresh.activeRevision),
        Math.max(base.checkpointRevision, fresh.checkpointRevision),
        runtime.context
      ));
      runtime.snapshot = merged;
      if (queued) {
        runtime.dirtyCheckpoint = checkpointFromSnapshot(merged, runtime.dirtyCheckpoint?.activations ?? []);
      }
      const staged = runtime.pendingActivation;
      if (staged) {
        const equipment = deepFreeze(withCarriedStateFrom(
          staged.equipment, fresh, merged.activeRevision + 1, merged.checkpointRevision, runtime.context
        ));
        runtime.pendingActivation = deepFreeze({
          ...staged,
          activeRevision: equipment.activeRevision,
          equipment,
          derivedStats: equipment.derivedStats
        });
      }
      return merged;
    }
  }

  /** Writes an applied but unsaved kit activation now, so a sale or trade sees what is really worn. */
  async flushPendingCheckpoint(playerId: string): Promise<void> {
    const checkpoint = this.runtimes.get(playerId)?.dirtyCheckpoint;
    if (checkpoint) await this.flushCheckpoint(checkpoint);
  }

  installAuthoritativeSnapshot(
    playerId: string,
    snapshot: EquipmentSnapshotV2
  ): void {
    this.installMutationSnapshot(playerId, deepFreeze(snapshot));
  }

  /** Compatibility method name: refreshes carried instance state; no player cells are allocated. */
  async refreshInventorySlots(playerId: string): Promise<EquipmentSnapshotV2> {
    const snapshot = deepFreeze(
      await this.loadFreshSnapshot(playerId, this.contextFor(playerId))
    );
    this.installMutationSnapshot(playerId, snapshot);
    return snapshot;
  }

  async connectRuntime(
    playerId: string,
    context: EquipmentRuntimeContext = DEFAULT_RUNTIME_CONTEXT
  ): Promise<EquipmentSnapshotV2> {
    requireIdentifier(playerId, "player ID", 160);
    if (!this.runtimes.has(playerId) && this.runtimes.size >= this.runtimeCapacity) {
      throw new EquipmentError(
        "EQUIPMENT_RUNTIME_CAPACITY",
        "Authoritative equipment runtime capacity is exhausted"
      );
    }
    const existing = this.runtimes.get(playerId);
    if (existing) {
      existing.pendingActivation = null;
      if (existing.dirtyCheckpoint) {
        await this.flushCheckpoint(existing.dirtyCheckpoint);
      }
    }
    const snapshot = deepFreeze(await this.loadFreshSnapshot(playerId, context, true));
    this.runtimes.set(playerId, {
      context: { ...context },
      snapshot,
      pendingActivation: null,
      completedActivations: new Map(),
      dirtyCheckpoint: null
    });
    return snapshot;
  }

  runtimeSnapshot(playerId: string): EquipmentSnapshotV2 | null {
    return this.runtimes.get(playerId)?.snapshot ?? null;
  }

  setRuntimeContext(
    playerId: string,
    context: EquipmentRuntimeContext
  ): EquipmentSnapshotV2 {
    const runtime = this.requireRuntime(playerId);
    runtime.context = { ...context };
    runtime.snapshot = deepFreeze(rebuildSnapshot(
      runtime.snapshot,
      activeIdsFromSnapshot(runtime.snapshot),
      runtime.snapshot.readiedWeaponSlot,
      runtime.snapshot.activeKitIndex,
      runtime.snapshot.activeRevision,
      runtime.snapshot.checkpointRevision,
      context
    ));
    if (runtime.pendingActivation) {
      const pendingEquipment = deepFreeze(rebuildSnapshot(
        runtime.pendingActivation.equipment,
        activeIdsFromSnapshot(runtime.pendingActivation.equipment),
        runtime.pendingActivation.equipment.readiedWeaponSlot,
        runtime.pendingActivation.equipment.activeKitIndex,
        runtime.pendingActivation.equipment.activeRevision,
        runtime.pendingActivation.equipment.checkpointRevision,
        context
      ));
      runtime.pendingActivation = deepFreeze({
        ...runtime.pendingActivation,
        equipment: pendingEquipment,
        derivedStats: pendingEquipment.derivedStats
      });
    }
    if (runtime.dirtyCheckpoint) {
      runtime.dirtyCheckpoint = checkpointFromSnapshot(
        runtime.snapshot,
        runtime.dirtyCheckpoint.activations
      );
    }
    return runtime.snapshot;
  }

  async stageKitActivation(
    playerId: string,
    input: {
      requestId: string;
      kitIndex: CombatKitIndex;
      expectedInventoryRevision: number;
    }
  ): Promise<StagedKitActivation> {
    requireRequestId(input.requestId);
    const kitIndex = requireKitIndex(input.kitIndex);
    const expectedInventoryRevision = requireRevision(
      input.expectedInventoryRevision,
      "expected inventory revision"
    );
    const runtime = this.requireRuntime(playerId);

    const completed = runtime.completedActivations.get(input.requestId);
    if (completed) {
      assertActivationIntent(completed, kitIndex, expectedInventoryRevision);
      return deepFreeze({
        ...completed,
        activationTick: completed.activationTick,
        replayed: true
      });
    }
    if (runtime.pendingActivation) {
      if (runtime.pendingActivation.requestId === input.requestId) {
        assertActivationIntent(
          runtime.pendingActivation,
          kitIndex,
          expectedInventoryRevision
        );
        return deepFreeze({ ...runtime.pendingActivation, replayed: true });
      }
      throw new EquipmentError(
        "EQUIPMENT_ACTIVATION_PENDING",
        "Another combat-kit activation is already staged for this player"
      );
    }
    if (
      runtime.dirtyCheckpoint &&
      runtime.dirtyCheckpoint.activations.length >= COMPLETED_ACTIVATION_LIMIT
    ) {
      throw new EquipmentError(
        "EQUIPMENT_RUNTIME_CAPACITY",
        "Combat-kit activation completion backlog is at capacity"
      );
    }
    if (runtime.snapshot.inventoryRevision !== expectedInventoryRevision) {
      throw new EquipmentError(
        "EQUIPMENT_STALE_INVENTORY_REVISION",
        `Expected inventory revision ${expectedInventoryRevision}, current revision is ` +
          `${runtime.snapshot.inventoryRevision}`
      );
    }

    const kit = runtime.snapshot.kits.find((entry) => entry.kitIndex === kitIndex);
    if (!kit) {
      throw new EquipmentError("EQUIPMENT_KIT_INVALID", `Combat kit ${kitIndex} does not exist`);
    }
    if (!kit.valid || kit.invalidReason) {
      throw new EquipmentError(
        "EQUIPMENT_KIT_INVALID",
        `Combat kit ${kitIndex} is invalid: ${kit.invalidReason ?? "incomplete"}`,
        kit.invalidReason ?? "incomplete"
      );
    }
    const desiredIds = emptyEquipmentSlots<string | null>(null);
    for (const slot of EQUIPMENT_SLOTS) {
      const item = kit.items[slot];
      desiredIds[slot] = item?.instanceId ?? null;
    }
    // Worn utility gloves and boots stay on: they come off only at home, never through a kit.
    for (const slot of EQUIPMENT_SLOTS) {
      const worn = runtime.snapshot.active[slot];
      if (worn && isUtilityGearDefinitionId(worn.definitionId)) desiredIds[slot] = worn.instanceId;
    }
    assertCompleteSelection(runtime.snapshot, desiredIds, kit.readiedWeaponSlot);

    const equipment = deepFreeze(rebuildSnapshot(
      runtime.snapshot,
      desiredIds,
      kit.readiedWeaponSlot,
      kitIndex,
      runtime.snapshot.activeRevision + 1,
      runtime.snapshot.checkpointRevision,
      runtime.context
    ));
    const candidate = deepFreeze<StagedKitActivation>({
      requestId: input.requestId,
      kitIndex,
      inventoryRevision: equipment.inventoryRevision,
      activeRevision: equipment.activeRevision,
      activationTick: null,
      replayed: false,
      equipment,
      derivedStats: equipment.derivedStats
    });
    const operationKey = kitOperationKey(playerId, input.requestId);
    const client = await this.pool.connect();
    let durable:
      | { kind: "reserved" | "pending" }
      | { kind: "completed"; activation: AppliedKitActivation };
    try {
      await client.query("BEGIN");
      await ensureEquipmentScaffold(client, playerId);
      const characterLevel = await lockAuthoritativeCharacterLevel(client, playerId);
      await lockAndValidateSelection(
        client,
        playerId,
        desiredIds,
        kit.readiedWeaponSlot,
        characterLevel,
        this.achievementIdsFor(playerId),
        true
      );
      durable = await reserveActivationOperation(
        client,
        operationKey,
        playerId,
        input.requestId,
        kitIndex,
        expectedInventoryRevision
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      if (isInventoryCapacityError(error)) throw new EquipmentError("EQUIPMENT_INVENTORY_FULL", "This would exceed your carrying capacity");
      throw error;
    } finally {
      client.release();
    }

    if (durable.kind === "completed") {
      assertActivationIntent(
        durable.activation,
        kitIndex,
        expectedInventoryRevision
      );
      rememberCompletedActivation(runtime.completedActivations, durable.activation);
      return deepFreeze({ ...durable.activation, replayed: true });
    }
    if (this.runtimes.get(playerId) !== runtime) {
      throw new EquipmentError(
        "EQUIPMENT_RUNTIME_NOT_CONNECTED",
        "Authoritative equipment runtime disconnected while the activation was reserved"
      );
    }
    const pendingAfterReservation =
      this.runtimes.get(playerId)?.pendingActivation ?? null;
    if (pendingAfterReservation) {
      if (pendingAfterReservation.requestId !== input.requestId) {
        throw new EquipmentError(
          "EQUIPMENT_ACTIVATION_PENDING",
          "Another combat-kit activation is already staged for this player"
        );
      }
      assertActivationIntent(
        pendingAfterReservation,
        kitIndex,
        expectedInventoryRevision
      );
      return deepFreeze({ ...pendingAfterReservation, replayed: true });
    }
    if (
      runtime.snapshot.inventoryRevision !== expectedInventoryRevision ||
      runtime.snapshot.activeRevision + 1 !== candidate.activeRevision
    ) {
      throw new EquipmentError(
        "EQUIPMENT_STALE_INVENTORY_REVISION",
        "Equipment changed while the combat-kit activation was being reserved"
      );
    }
    const staged = deepFreeze({
      ...candidate,
      replayed: durable.kind === "pending"
    });
    runtime.pendingActivation = staged;
    return staged;
  }

  markActivationApplied(
    playerId: string,
    requestId: string,
    activationTick: number
  ): AppliedKitActivation {
    requireRequestId(requestId);
    requireRevision(activationTick, "activation tick");
    const runtime = this.requireRuntime(playerId);
    const replay = runtime.completedActivations.get(requestId);
    if (replay) {
      if (replay.activationTick !== activationTick) {
        throw new EquipmentError(
          "EQUIPMENT_IDEMPOTENCY_CONFLICT",
          "Kit activation request was replayed with a different activation tick"
        );
      }
      return deepFreeze({ ...replay, replayed: true });
    }
    const staged = runtime.pendingActivation;
    if (!staged || staged.requestId !== requestId) {
      throw new EquipmentError(
        "EQUIPMENT_ACTIVATION_NOT_STAGED",
        "Combat-kit activation was not staged for this request"
      );
    }
    const applied = deepFreeze<AppliedKitActivation>({
      requestId: staged.requestId,
      kitIndex: staged.kitIndex,
      inventoryRevision: staged.inventoryRevision,
      activeRevision: staged.activeRevision,
      activationTick,
      replayed: staged.replayed,
      equipment: staged.equipment,
      derivedStats: staged.derivedStats
    });
    runtime.snapshot = staged.equipment;
    runtime.pendingActivation = null;
    runtime.dirtyCheckpoint = checkpointFromSnapshot(
      runtime.snapshot,
      appendCheckpointActivation(
        runtime.dirtyCheckpoint?.activations ?? [],
        applied
      )
    );
    rememberCompletedActivation(runtime.completedActivations, applied);
    return applied;
  }

  pendingActivation(playerId: string): StagedKitActivation | null {
    return this.runtimes.get(playerId)?.pendingActivation ?? null;
  }

  cancelPendingActivation(playerId: string, requestId?: string): boolean {
    const runtime = this.runtimes.get(playerId);
    if (!runtime?.pendingActivation) return false;
    if (requestId !== undefined && runtime.pendingActivation.requestId !== requestId) {
      return false;
    }
    runtime.pendingActivation = null;
    return true;
  }

  peekDirtyCheckpoints(): readonly EquipmentCheckpoint[] {
    return [...this.runtimes.values()]
      .map((runtime) => runtime.dirtyCheckpoint)
      .filter((checkpoint): checkpoint is EquipmentCheckpoint => checkpoint !== null);
  }

  async flushDirtyCheckpoints(
    checkpoints: readonly EquipmentCheckpoint[] = this.peekDirtyCheckpoints()
  ): Promise<void> {
    for (const checkpoint of checkpoints) {
      await this.flushCheckpoint(checkpoint);
    }
  }

  async flushAndRelease(playerId: string): Promise<void> {
    const runtime = this.runtimes.get(playerId);
    if (!runtime) return;
    // A staged request has not crossed the authoritative tick boundary and is
    // therefore safe to abandon. Only the last applied dirty checkpoint is
    // durable on disconnect or graceful shutdown.
    runtime.pendingActivation = null;
    if (runtime.dirtyCheckpoint) {
      await this.flushCheckpoint(runtime.dirtyCheckpoint);
    }
    this.runtimes.delete(playerId);
    this.lastGearScroll.delete(playerId);
  }

  async equip(
    playerId: string,
    instanceId: string,
    slot: EquipmentSlot,
    requestId: string
  ): Promise<EquipmentOperationResult> {
    return this.changeEquipment(playerId, instanceId, slot, requestId, "equip");
  }

  async unequip(
    playerId: string,
    instanceId: string,
    requestId: string
  ): Promise<EquipmentOperationResult> {
    return this.changeEquipment(playerId, instanceId, null, requestId, "unequip");
  }

  async upgrade(
    actor: EquipmentActor,
    instanceId: string,
    expectedLevel: number,
    requestId: string,
    context: EquipmentRuntimeContext = this.contextFor(actor.playerId),
    authorityContext?: EquipmentManorSmithContext | EquipmentLegacyCityReplayContext
  ): Promise<EquipmentUpgradeResult> {
    requireIdentifier(actor.playerId, "player ID", 160);
    requireIdentifier(actor.accountId, "account ID", 160);
    requireIdentifier(instanceId, "equipment instance ID", 160);
    requireRequestId(requestId);
    const safeExpectedLevel = requireEquipmentLevel(expectedLevel);
    const manorAuthority =
      authorityContext?.kind === "manor_smith" ? authorityContext : null;
    const legacyCityReplay =
      authorityContext?.kind === "legacy_city_replay" ? authorityContext : null;
    const authorityKind = manorAuthority ? "manor_smith" : legacyCityReplay ? "city_facility" : "inventory";
    const authoritySource =
      manorAuthority?.manorId ?? legacyCityReplay?.facilityStructureId ?? null;
    const runtimeAuthoritySessionId = manorAuthority?.manorSessionId ?? null;
    const authorityMovementSequence = manorAuthority?.movementSequence ?? null;
    if (safeExpectedLevel === MAX_EQUIPMENT_LEVEL) {
      throw new EquipmentError(
        "EQUIPMENT_MAXIMUM_LEVEL",
        `Equipment is already at maximum level ${MAX_EQUIPMENT_LEVEL}`
      );
    }
    this.assertNoPendingActivation(actor.playerId);
    const connectedRuntime = this.runtimes.get(actor.playerId);
    if (connectedRuntime?.dirtyCheckpoint) {
      await this.flushCheckpoint(connectedRuntime.dirtyCheckpoint);
    }
    const connectedSnapshot = this.runtimes.get(actor.playerId)?.snapshot;
    const operationKey = `equipment-upgrade:${actor.accountId}:${requestId}`;
    const client = await this.pool.connect();
    let committedSnapshot: EquipmentSnapshotV2 | null = null;
    try {
      await client.query("BEGIN");
      await ensureEquipmentScaffold(client, actor.playerId);
      const reserved = await client.query(
        `INSERT INTO equipment_upgrade_operations (
           operation_key, player_id, account_id, request_id, instance_id, expected_level,
           facility_structure_id, authority_kind, authority_source,
           runtime_authority_session_id, authority_movement_sequence
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT (operation_key) DO NOTHING
         RETURNING operation_key`,
        [
          operationKey,
          actor.playerId,
          actor.accountId,
          requestId,
          instanceId,
          safeExpectedLevel,
          legacyCityReplay?.facilityStructureId ?? null,
          authorityKind,
          authoritySource,
          runtimeAuthoritySessionId,
          authorityMovementSequence
        ]
      );
      if (reserved.rowCount === 0) {
        const existing = await client.query<UpgradeOperationRow>(
          `SELECT player_id,account_id,instance_id,expected_level,
                  facility_structure_id::text,authority_kind,authority_source,
                  runtime_authority_session_id,authority_movement_sequence,
                  result,completed_at
           FROM equipment_upgrade_operations
           WHERE operation_key = $1`,
          [operationKey]
        );
        const row = existing.rows[0];
        const legacyCityAuthority =
          row?.authority_kind === "legacy" &&
          !manorAuthority &&
          row.authority_source === null &&
          row.runtime_authority_session_id === null &&
          row.authority_movement_sequence === null;
        if (
          !row ||
          row.player_id !== actor.playerId ||
          row.account_id !== actor.accountId ||
          row.instance_id !== instanceId ||
          row.expected_level !== safeExpectedLevel ||
          row.facility_structure_id !== (legacyCityReplay?.facilityStructureId ?? null) ||
          (
            !legacyCityAuthority &&
            (
              row.authority_kind !== authorityKind ||
              row.authority_source !== authoritySource
            )
          ) ||
          row.runtime_authority_session_id !== runtimeAuthoritySessionId ||
          (
            row.authority_movement_sequence === null
              ? authorityMovementSequence !== null
              : Number(row.authority_movement_sequence) !== authorityMovementSequence
          )
        ) {
          throw new EquipmentError(
            "EQUIPMENT_IDEMPOTENCY_CONFLICT",
            "Equipment upgrade request ID was reused with different intent"
          );
        }
        const stored = storedUpgradeResult(row.result);
        if (!row.completed_at || !stored) {
          throw new EquipmentError(
            "EQUIPMENT_OPERATION_INCOMPLETE",
            "Equipment upgrade operation exists without a completed result"
          );
        }
        await client.query("COMMIT");
        return { ...stored, applied: false, replayed: true };
      }
      if (legacyCityReplay) {
        throw new EquipmentError(
          "MANOR_SMITH_ACCESS_DENIED",
          "City facilities no longer authorize equipment upgrades. Use a manor Smithing Station."
        );
      }

      const locked = await client.query<EquipmentRow>(
        `${EQUIPMENT_ROW_SELECT}
         FROM equipment_instances
         WHERE instance_id = $1
         FOR NO KEY UPDATE`,
        [instanceId]
      );
      const item = locked.rows[0];
      if (!item || item.owner_player_id !== actor.playerId) {
        throw new EquipmentError(
          "EQUIPMENT_NOT_OWNED",
          "Equipment instance is not owned by this player"
        );
      }
      if (item.location === "destroyed") {
        throw new EquipmentError("EQUIPMENT_DESTROYED", "Destroyed equipment cannot be upgraded");
      }
      if (!isCarriedEquipmentLocation(item.location)) {
        throw new EquipmentError(
          "EQUIPMENT_NOT_CARRIED",
          "Equipment must be in your Inventory or equipped to be upgraded"
        );
      }
      const upgradesActiveItem = connectedSnapshot
        ? EQUIPMENT_SLOTS.some(
            (slot) => connectedSnapshot.active[slot]?.instanceId === instanceId
          )
        : item.location === "equipped";
      const before = requireEquipmentLevel(item.item_level);
      if (before !== safeExpectedLevel) {
        throw new EquipmentError(
          "EQUIPMENT_STALE_LEVEL",
          `Expected equipment level ${safeExpectedLevel}, current level is ${before}`
        );
      }
      if (before >= MAX_EQUIPMENT_LEVEL) {
        throw new EquipmentError(
          "EQUIPMENT_MAXIMUM_LEVEL",
          `Equipment is already at maximum level ${MAX_EQUIPMENT_LEVEL}`
        );
      }
      requireEquipmentDefinition(item.definition_id);
      // Historical station requests retain their replay identity. Inventory upgrades
      // use authenticated ownership, expected level and the transactional wallet.
      if (manorAuthority) await manorAuthority.authorize();
      const goldCost = equipmentUpgradeCostForIdentity(
        equipmentUpgradeCost(before, EQUIPMENT_BALANCE_VERSION),
        item.enchantment_identity
      );
      const walletResult = await this.wallet.debitForOperationInTransaction(client, {
        playerId: actor.playerId,
        accountId: actor.accountId,
        amount: BigInt(goldCost),
        operationKey,
        reason: "equipment_upgrade_v1"
      });
      await this.afterUpgradeDebit();

      const upgraded = await client.query<{ item_level: number }>(
        `UPDATE equipment_instances
         SET item_level = item_level + 1,
             balance_version = $3
         WHERE instance_id = $1 AND item_level = $2
         RETURNING item_level`,
        [instanceId, before, EQUIPMENT_BALANCE_VERSION]
      );
      const after = upgraded.rows[0]?.item_level;
      if (after !== before + 1) {
        throw new EquipmentError(
          "EQUIPMENT_STALE_LEVEL",
          "Equipment level changed before the upgrade could be applied"
        );
      }
      await client.query(
        `UPDATE player_equipment_state
         SET inventory_revision = inventory_revision + 1,
             active_revision = active_revision + $2::bigint,
             checkpoint_revision = checkpoint_revision + $2::bigint
         WHERE player_id = $1`,
        [actor.playerId, upgradesActiveItem ? 1 : 0]
      );
      if (upgradesActiveItem) {
        await updateEquipmentChallengeProfile(client, actor.playerId);
      }

      const source = connectedSnapshot;
      const override = source ? overrideFromSnapshot(source) : undefined;
      if (override && upgradesActiveItem) {
        override.activeRevision += 1;
        override.checkpointRevision += 1;
      }
      const equipment = await loadEquipmentSnapshot(
        client,
        actor.playerId,
        context,
        override
      );
      const result: EquipmentUpgradeResult = {
        applied: true,
        replayed: false,
        instanceId,
        levelBefore: before,
        levelAfter: after,
        goldCost: String(goldCost),
        balanceVersion: EQUIPMENT_BALANCE_VERSION,
        goldBalance: walletResult.goldBalance.toString(),
        equipment
      };
      await client.query(
        `UPDATE equipment_upgrade_operations
         SET level_before = $2,
             level_after = $3,
             gold_cost = $4::bigint,
             balance_version = $5,
             wallet_operation_key = $1,
             wallet_version_after = $6::bigint,
             result = $7::jsonb,
             completed_at = now()
         WHERE operation_key = $1`,
        [
          operationKey,
          before,
          after,
          String(goldCost),
          EQUIPMENT_BALANCE_VERSION,
          walletResult.version.toString(),
          JSON.stringify(result)
        ]
      );
      await insertAuditEvent(client, {
        operationKey,
        playerId: actor.playerId,
        eventType: "equipment_upgraded",
        instanceId,
        kitIndex: null,
        equipment,
        details: {
          levelBefore: before,
          levelAfter: after,
          goldCost: String(goldCost),
          balanceVersion: EQUIPMENT_BALANCE_VERSION,
          authorityKind,
          authoritySource
        }
      });
      await client.query("COMMIT");
      committedSnapshot = equipment;
      this.operationCount += 1;
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      if (isInventoryCapacityError(error)) throw new EquipmentError("EQUIPMENT_INVENTORY_FULL", "This would exceed your carrying capacity");
      throw error;
    } finally {
      client.release();
      if (committedSnapshot) this.installMutationSnapshot(actor.playerId, committedSnapshot);
    }
  }

  async craftStockEquipment(
    actor: EquipmentActor,
    familyId: EquipmentGameplayFamilyId,
    requestId: string,
    authority: EquipmentManorSmithContext | EquipmentPortableCraftContext,
    swagDefinitionId?: EquipmentDefinitionId
  ): Promise<EquipmentAcquisitionResult> {
    if (authority.kind === "portable_craft" && !isPortableEquipmentCraft(familyId, swagDefinitionId)) {
      throw new EquipmentError(
        "MANOR_SMITH_ACCESS_DENIED",
        "Craft that at your Manor's Smithing Station."
      );
    }
    if (swagDefinitionId === undefined) {
      return this.acquireEquipment(actor, requestId, "craft", familyId, authority);
    }
    // A swag recipe must belong to the requested family; any other cosmetic has no recipe.
    const swag = equipmentSwagCraftRecipe(swagDefinitionId);
    if (!swag || swag.familyId !== familyId) {
      throw new EquipmentError(
        "EQUIPMENT_CRAFT_RECIPE_UNAVAILABLE",
        "That equipment cannot be crafted"
      );
    }
    return this.acquireEquipment(actor, requestId, "craft", swag.definitionId, authority);
  }

  async purchaseLimitedEquipment(
    actor: EquipmentActor,
    definitionId: EquipmentDefinitionId,
    requestId: string,
    authority: EquipmentManorSmithContext
  ): Promise<EquipmentAcquisitionResult> {
    return this.acquireEquipment(
      actor,
      requestId,
      "limited_purchase",
      definitionId,
      authority
    );
  }

  private async acquireEquipment(
    actor: EquipmentActor,
    requestId: string,
    action: EquipmentAcquisitionAction,
    requestedId: string,
    authority: EquipmentManorSmithContext | EquipmentPortableCraftContext
  ): Promise<EquipmentAcquisitionResult> {
    requireIdentifier(actor.playerId, "player ID", 160);
    requireIdentifier(actor.accountId, "account ID", 160);
    requireRequestId(requestId);
    this.assertNoPendingActivation(actor.playerId);
    const connectedRuntime = this.runtimes.get(actor.playerId);
    if (connectedRuntime?.dirtyCheckpoint) {
      await this.flushCheckpoint(connectedRuntime.dirtyCheckpoint);
    }
    const operationKey = `equipment-acquire:${actor.accountId}:${
      createHash("sha256").update(requestId).digest("hex")
    }`;
    const requestHash = createHash("sha256")
      .update(JSON.stringify({ action, requestedId }))
      .digest("hex");
    const client = await this.pool.connect();
    let committedSnapshot: EquipmentSnapshotV2 | null = null;
    try {
      await client.query("BEGIN");
      await ensureEquipmentScaffold(client, actor.playerId);
      await lockInventoryCapacity(client, actor.playerId);
      await authority.authorize();
      const reserved = await client.query(
        `INSERT INTO equipment_operations (
           operation_key, player_id, action, request_hash
         ) VALUES ($1,$2,$3,$4)
         ON CONFLICT (operation_key) DO NOTHING
         RETURNING operation_key`,
        [operationKey, actor.playerId, action, requestHash]
      );
      if (reserved.rowCount === 0) {
        const existing = await client.query<AcquisitionOperationRow>(
          `SELECT player_id,action,request_hash,result,completed_at
           FROM equipment_operations
           WHERE operation_key=$1
           FOR UPDATE`,
          [operationKey]
        );
        const row = existing.rows[0];
        const stored = storedAcquisitionResult(row?.result);
        if (
          !row ||
          row.player_id !== actor.playerId ||
          row.action !== action ||
          row.request_hash !== requestHash ||
          !row.completed_at ||
          !stored
        ) {
          throw new EquipmentError(
            "EQUIPMENT_IDEMPOTENCY_CONFLICT",
            "Equipment acquisition request ID was reused with different intent"
          );
        }
        const inventory = await this.inventory.snapshotInTransaction(client, actor.playerId);
        const equipment = await loadEquipmentSnapshot(
          client,
          actor.playerId,
          this.contextFor(actor.playerId)
        );
        const wallet = action === "limited_purchase"
          ? await currentWallet(client, actor)
          : null;
        await client.query("COMMIT");
        committedSnapshot = equipment;
        return {
          applied: false,
          replayed: true,
          action,
          ...stored,
          ...(wallet
            ? { walletGold: wallet.gold, walletVersion: wallet.version }
            : {}),
          inventory,
          equipment
        };
      }

      let definitionId: EquipmentDefinitionId;
      let materialCosts: Array<{ itemId: ResourceType; quantity: number }> = [];
      let goldCost = "0";
      let walletResult: Awaited<ReturnType<EquipmentWallet["debitForOperationInTransaction"]>> | null = null;
      if (action === "craft") {
        // Stock crafts are requested by family ID, swag crafts by their own definition ID.
        const swagRecipe = equipmentSwagCraftRecipe(requestedId);
        const recipe = swagRecipe ?? EQUIPMENT_CRAFT_RECIPES.find(
          (candidate) => candidate.familyId === requestedId
        );
        if (!recipe) {
          throw new EquipmentError(
            "EQUIPMENT_CRAFT_RECIPE_UNAVAILABLE",
            "That stock equipment family cannot be crafted"
          );
        }
        if (swagRecipe) {
          // Glimmer Shop (1200): a swag weapon sold as shop-only has no Smithing recipe.
          const shopOnly = await client.query(
            `SELECT 1 FROM glimmer_shop_catalog
             WHERE kind='weapon' AND grant_item_id=$1 AND source='shop'`,
            [swagRecipe.definitionId]
          );
          if (shopOnly.rowCount) {
            throw new EquipmentError(
              "EQUIPMENT_CRAFT_RECIPE_UNAVAILABLE",
              `${swagRecipe.displayName} is sold in the Glimmer Shop and cannot be crafted`
            );
          }
        }
        const definition = requireEquipmentDefinition(recipe.definitionId);
        if (definition.equipmentRole !== (swagRecipe ? "cosmetic" : "stock")) {
          throw new EquipmentError(
            "EQUIPMENT_CRAFT_RECIPE_UNAVAILABLE",
            "Only canonical stock equipment can be crafted"
          );
        }
        if (recipe.requiresSkill) {
          const skill = await client.query<{ rank: number }>(
            "SELECT rank FROM player_skill_ranks WHERE player_id=$1 AND skill_id=$2",
            [actor.playerId, recipe.requiresSkill.skillId]
          );
          if ((skill.rows[0]?.rank ?? 0) < recipe.requiresSkill.rank) {
            throw new EquipmentError(
              "EQUIPMENT_CRAFT_RECIPE_UNAVAILABLE",
              `${definition.displayName} needs Rare Beast Mastery rank ${recipe.requiresSkill.rank}`
            );
          }
        }
        definitionId = recipe.definitionId;
        const leatherGate = equipmentCraftTradeGate(recipe.familyId);
        if (leatherGate) {
          await requireTradeSkillGate(client, actor.playerId, leatherGate, (message) => new EquipmentError("EQUIPMENT_CRAFT_SKILL_REQUIRED", message));
        }
        materialCosts = recipe.materials.map((material) => ({ ...material }));
        if (recipe.categoryMaterials !== undefined) {
          const craftSpend = resolveMaterialSpend(
            `Crafting ${definition.displayName}`, materialCosts, recipe.categoryMaterials,
            await spendableItemCounts(this.inventory, client, actor.playerId, false), {}
          );
          if (!craftSpend.ok) throw new EquipmentError("EQUIPMENT_CRAFT_MATERIALS_REQUIRED", craftSpend.failure.message);
          materialCosts = craftSpend.debits.map((debit) => ({ itemId: debit.itemId as ResourceType, quantity: debit.quantity }));
        }
        const available = await client.query<{ resource_type: string; quantity: string }>(
          `SELECT resource_type,quantity::text
           FROM player_inventory
           WHERE player_id=$1
             AND variant=$2
             AND resource_type=ANY($3::text[])
           ORDER BY resource_type
           FOR UPDATE`,
          [actor.playerId, DEFAULT_INVENTORY_VARIANT, materialCosts.map(({ itemId }) => itemId)]
        );
        const quantities = new Map(
          available.rows.map((row) => [row.resource_type, BigInt(row.quantity)])
        );
        const missing = materialCosts.find(
          ({ itemId, quantity }) => (quantities.get(itemId) ?? 0n) < BigInt(quantity)
        );
        if (missing) {
          throw new EquipmentError(
            "EQUIPMENT_CRAFT_MATERIALS_REQUIRED",
            `Crafting ${definition.displayName} requires ${missing.quantity} ${
              missing.itemId.replaceAll("_", " ")
            }`
          );
        }
        await this.inventory.debitItemsForOperationInTransaction(client, {
          operationKey: `${operationKey}:materials`,
          playerId: actor.playerId,
          source: "equipment_craft",
          sourceEntityType: "equipment_operation",
          sourceEntityId: operationKey,
          debits: materialCosts.map((material) => ({
            ...material,
            variant: DEFAULT_INVENTORY_VARIANT
          }))
        });
      } else {
        const sale = activeEquipmentLimitedSales(this.now()).find(
          (candidate) => candidate.definitionId === requestedId
        );
        if (!sale) {
          throw new EquipmentError(
            "EQUIPMENT_LIMITED_SALE_UNAVAILABLE",
            "That limited equipment sale is not active"
          );
        }
        const definition = requireEquipmentDefinition(sale.definitionId);
        if (definition.equipmentRole !== "cosmetic") {
          throw new EquipmentError(
            "EQUIPMENT_LIMITED_SALE_UNAVAILABLE",
            "Limited sales may contain only cosmetic equipment"
          );
        }
        definitionId = sale.definitionId;
        goldCost = sale.priceGold;
        walletResult = await this.wallet.debitForOperationInTransaction(client, {
          playerId: actor.playerId,
          accountId: actor.accountId,
          amount: BigInt(goldCost),
          operationKey: `${operationKey}:gold`,
          reason: "equipment_limited_purchase_v1",
          metadata: { definitionId, saleEndsAt: sale.endsAt }
        });
      }

      // Crafting consumes its materials before checking the resulting carried weight.
      await assertInventoryWeightInTransaction(client, actor.playerId, BigInt(requireRuntimeItemDefinition(definitionId).unitWeightGrams));
      const instanceId = crypto.randomUUID();
      await client.query(
        `INSERT INTO equipment_instances (
           instance_id,definition_id,owner_player_id,location,equipped_slot,
           inventory_slot_index,item_level,balance_version,enchantment_identity,
           created_by_operation_key,metadata
         ) VALUES ($1,$2,$3,'inventory',NULL,$4,0,$5,NULL,$6,$7::jsonb)`,
        [
          instanceId,
          definitionId,
          actor.playerId,
          null,
          EQUIPMENT_BALANCE_VERSION,
          operationKey,
          JSON.stringify({ source: action })
        ]
      );
      await client.query(
        `UPDATE player_equipment_state
         SET inventory_revision=inventory_revision+1
         WHERE player_id=$1`,
        [actor.playerId]
      );
      const definition = requireEquipmentDefinition(definitionId);
      const message = action === "craft"
        ? `${definition.displayName} crafted and added to Player Inventory.`
        : `${definition.displayName} purchased and added to Player Inventory.`;
      const stored = {
        definitionId,
        instanceId,
        materialCosts,
        goldCost,
        message
      };
      await client.query(
        `UPDATE equipment_operations
         SET instance_id=$2,result=$3::jsonb,completed_at=now()
         WHERE operation_key=$1`,
        [operationKey, instanceId, JSON.stringify(stored)]
      );
      const inventory = await this.inventory.snapshotInTransaction(client, actor.playerId);
      const equipment = await loadEquipmentSnapshot(
        client,
        actor.playerId,
        this.contextFor(actor.playerId)
      );
      await client.query("COMMIT");
      committedSnapshot = equipment;
      this.operationCount += 1;
      return {
        applied: true,
        replayed: false,
        action,
        ...stored,
        ...(walletResult
          ? {
              walletGold: walletResult.goldBalance.toString(),
              walletVersion: walletResult.version.toString()
            }
          : {}),
        inventory,
        equipment
      };
    } catch (error) {
      await client.query("ROLLBACK");
      if (isInventoryCapacityError(error)) throw new EquipmentError("EQUIPMENT_INVENTORY_FULL", "This would exceed your carrying capacity");
      throw error;
    } finally {
      client.release();
      if (committedSnapshot) {
        this.installMutationSnapshot(actor.playerId, committedSnapshot);
      }
    }
  }

  async saveCombatKit(
    playerId: string,
    kitIndexInput: CombatKitIndex,
    expectedInventoryRevision: number,
    requestId: string
  ): Promise<EquipmentOperationResult> {
    requireRequestId(requestId);
    const kitIndex = requireKitIndex(kitIndexInput);
    const expected = requireRevision(expectedInventoryRevision, "expected inventory revision");
    this.assertNoPendingActivation(playerId);
    const source = await this.getSnapshot(playerId);
    const selectedIds = activeIdsFromSnapshot(source);
    const payload = { expectedInventoryRevision: expected };
    const operationKey = kitOperationKey(playerId, requestId);
    const client = await this.pool.connect();
    let committedSnapshot: EquipmentSnapshotV2 | null = null;
    try {
      await client.query("BEGIN");
      await ensureEquipmentScaffold(client, playerId);
      const replay = await reserveKitOperation(
        client,
        operationKey,
        playerId,
        requestId,
        "save",
        kitIndex,
        payload
      );
      if (replay) {
        await client.query("COMMIT");
        return replay;
      }
      assertCompleteSelection(source, selectedIds, source.readiedWeaponSlot);
      await lockAndAssertInventoryRevision(client, playerId, expected);
      const characterLevel = await lockAuthoritativeCharacterLevel(client, playerId);
      await lockAndValidateSelection(
        client,
        playerId,
        selectedIds,
        source.readiedWeaponSlot,
        characterLevel,
        this.achievementIdsFor(playerId)
      );
      await client.query(
        `DELETE FROM combat_kit_items
         WHERE player_id = $1 AND kit_index = $2`,
        [playerId, kitIndex]
      );
      await client.query(
        `INSERT INTO combat_kit_items (
           player_id, kit_index, equipment_slot, instance_id
         )
         SELECT $1, $2, slot, instance_id
         FROM unnest($3::text[], $4::uuid[]) AS selected(slot, instance_id)
         WHERE instance_id IS NOT NULL`,
        [
          playerId,
          kitIndex,
          [...EQUIPMENT_SLOTS],
          EQUIPMENT_SLOTS.map((slot) => selectedIds[slot])
        ]
      );
      await client.query(
        `UPDATE combat_kits
         SET readied_weapon_slot = $3,
             revision = revision + 1
         WHERE player_id = $1 AND kit_index = $2`,
        [playerId, kitIndex, source.readiedWeaponSlot]
      );
      await client.query(
        `UPDATE player_equipment_state
         SET inventory_revision = inventory_revision + 1
         WHERE player_id = $1`,
        [playerId]
      );
      const equipment = await loadEquipmentSnapshot(
        client,
        playerId,
        this.contextFor(playerId),
        overrideFromSnapshot(source)
      );
      const result: EquipmentOperationResult = {
        applied: true,
        replayed: false,
        equipment
      };
      await completeKitOperation(client, operationKey, result);
      await insertAuditEvent(client, {
        operationKey,
        playerId,
        eventType: "combat_kit_saved",
        instanceId: null,
        kitIndex,
        equipment,
        details: { kitRevision: equipment.kits[kitIndex - 1]!.revision }
      });
      await client.query("COMMIT");
      committedSnapshot = equipment;
      this.operationCount += 1;
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      if (isInventoryCapacityError(error)) throw new EquipmentError("EQUIPMENT_INVENTORY_FULL", "This would exceed your carrying capacity");
      throw error;
    } finally {
      client.release();
      if (committedSnapshot) this.installMutationSnapshot(playerId, committedSnapshot);
    }
  }

  async renameCombatKit(
    playerId: string,
    kitIndexInput: CombatKitIndex,
    nameInput: string,
    requestId: string
  ): Promise<EquipmentOperationResult> {
    requireRequestId(requestId);
    const kitIndex = requireKitIndex(kitIndexInput);
    const name = nameInput.trim();
    if (name.length < 1 || name.length > 32) {
      throw new EquipmentError(
        "EQUIPMENT_INVALID_REQUEST",
        "Combat-kit name must contain between 1 and 32 characters"
      );
    }
    this.assertNoPendingActivation(playerId);
    const source = await this.getSnapshot(playerId);
    const payload = { name };
    const operationKey = kitOperationKey(playerId, requestId);
    const client = await this.pool.connect();
    let committedSnapshot: EquipmentSnapshotV2 | null = null;
    try {
      await client.query("BEGIN");
      await ensureEquipmentScaffold(client, playerId);
      const replay = await reserveKitOperation(
        client,
        operationKey,
        playerId,
        requestId,
        "rename",
        kitIndex,
        payload
      );
      if (replay) {
        await client.query("COMMIT");
        return replay;
      }
      const renamed = await client.query(
        `UPDATE combat_kits
         SET name = $3, revision = revision + 1
         WHERE player_id = $1 AND kit_index = $2
         RETURNING kit_index`,
        [playerId, kitIndex, name]
      );
      if (renamed.rowCount !== 1) {
        throw new EquipmentError("EQUIPMENT_KIT_INVALID", `Combat kit ${kitIndex} does not exist`);
      }
      const equipment = await loadEquipmentSnapshot(
        client,
        playerId,
        this.contextFor(playerId),
        overrideFromSnapshot(source)
      );
      const result: EquipmentOperationResult = {
        applied: true,
        replayed: false,
        equipment
      };
      await completeKitOperation(client, operationKey, result);
      await insertAuditEvent(client, {
        operationKey,
        playerId,
        eventType: "combat_kit_renamed",
        instanceId: null,
        kitIndex,
        equipment,
        details: { name }
      });
      await client.query("COMMIT");
      committedSnapshot = equipment;
      this.operationCount += 1;
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      if (isInventoryCapacityError(error)) throw new EquipmentError("EQUIPMENT_INVENTORY_FULL", "This would exceed your carrying capacity");
      throw error;
    } finally {
      client.release();
      if (committedSnapshot) this.installMutationSnapshot(playerId, committedSnapshot);
    }
  }

  async clearCombatKit(
    playerId: string,
    kitIndexInput: CombatKitIndex,
    expectedInventoryRevision: number,
    requestId: string
  ): Promise<EquipmentOperationResult> {
    requireRequestId(requestId);
    const kitIndex = requireKitIndex(kitIndexInput);
    const expected = requireRevision(expectedInventoryRevision, "expected inventory revision");
    this.assertNoPendingActivation(playerId);
    const source = await this.getSnapshot(playerId);
    const payload = { expectedInventoryRevision: expected };
    const operationKey = kitOperationKey(playerId, requestId);
    const client = await this.pool.connect();
    let committedSnapshot: EquipmentSnapshotV2 | null = null;
    try {
      await client.query("BEGIN");
      await ensureEquipmentScaffold(client, playerId);
      const replay = await reserveKitOperation(
        client,
        operationKey,
        playerId,
        requestId,
        "clear",
        kitIndex,
        payload
      );
      if (replay) {
        await client.query("COMMIT");
        return replay;
      }
      await lockAndAssertInventoryRevision(client, playerId, expected);
      await client.query(
        `DELETE FROM combat_kit_items
         WHERE player_id = $1 AND kit_index = $2`,
        [playerId, kitIndex]
      );
      const cleared = await client.query(
        `UPDATE combat_kits
         SET readied_weapon_slot = 'melee', revision = revision + 1
         WHERE player_id = $1 AND kit_index = $2
         RETURNING kit_index`,
        [playerId, kitIndex]
      );
      if (cleared.rowCount !== 1) {
        throw new EquipmentError("EQUIPMENT_KIT_INVALID", `Combat kit ${kitIndex} does not exist`);
      }
      await client.query(
        `UPDATE player_equipment_state
         SET inventory_revision = inventory_revision + 1,
             active_kit_index = CASE
               WHEN active_kit_index = $2 THEN NULL
               ELSE active_kit_index
             END
         WHERE player_id = $1`,
        [playerId, kitIndex]
      );
      const override = overrideFromSnapshot(source);
      if (override.activeKitIndex === kitIndex) override.activeKitIndex = null;
      const equipment = await loadEquipmentSnapshot(
        client,
        playerId,
        this.contextFor(playerId),
        override
      );
      const result: EquipmentOperationResult = {
        applied: true,
        replayed: false,
        equipment
      };
      await completeKitOperation(client, operationKey, result);
      await insertAuditEvent(client, {
        operationKey,
        playerId,
        eventType: "combat_kit_cleared",
        instanceId: null,
        kitIndex,
        equipment,
        details: {}
      });
      await client.query("COMMIT");
      committedSnapshot = equipment;
      this.operationCount += 1;
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      if (isInventoryCapacityError(error)) throw new EquipmentError("EQUIPMENT_INVENTORY_FULL", "This would exceed your carrying capacity");
      throw error;
    } finally {
      client.release();
      if (committedSnapshot) this.installMutationSnapshot(playerId, committedSnapshot);
    }
  }

  async toggleReadiedWeapon(
    playerId: string,
    readiedWeaponSlot: ReadiedWeaponSlot,
    expectedInventoryRevision: number,
    requestId: string
  ): Promise<EquipmentOperationResult> {
    requireRequestId(requestId);
    if (readiedWeaponSlot !== "melee" && readiedWeaponSlot !== "secondary") {
      throw new EquipmentError(
        "EQUIPMENT_INVALID_REQUEST",
        "Readied weapon slot must be melee or secondary"
      );
    }
    const expected = requireRevision(expectedInventoryRevision, "expected inventory revision");
    this.assertNoPendingActivation(playerId);
    const runtime = this.runtimes.get(playerId);
    if (runtime?.dirtyCheckpoint) {
      await this.flushCheckpoint(runtime.dirtyCheckpoint);
    }
    const source = await this.getSnapshot(playerId);
    const payload = { expectedInventoryRevision: expected, readiedWeaponSlot };
    const operationKey = kitOperationKey(playerId, requestId);
    const client = await this.pool.connect();
    let committedSnapshot: EquipmentSnapshotV2 | null = null;
    try {
      await client.query("BEGIN");
      await ensureEquipmentScaffold(client, playerId);
      const replay = await reserveKitOperation(
        client,
        operationKey,
        playerId,
        requestId,
        "toggle_readied",
        null,
        payload
      );
      if (replay) {
        await client.query("COMMIT");
        return replay;
      }
      assertReadiedWeapon(source.active, readiedWeaponSlot);
      await lockAndAssertInventoryRevision(client, playerId, expected);
      const changed = source.readiedWeaponSlot !== readiedWeaponSlot;
      if (changed) {
        await client.query(
          `UPDATE player_equipment_state
           SET readied_weapon_slot = $2,
               active_revision = active_revision + 1,
               checkpoint_revision = checkpoint_revision + 1
           WHERE player_id = $1`,
          [playerId, readiedWeaponSlot]
        );
      }
      const override = overrideFromSnapshot(source);
      override.readiedWeaponSlot = readiedWeaponSlot;
      if (changed) {
        override.activeRevision += 1;
        override.checkpointRevision += 1;
      }
      const equipment = await loadEquipmentSnapshot(
        client,
        playerId,
        this.contextFor(playerId),
        override
      );
      const result: EquipmentOperationResult = {
        applied: true,
        replayed: false,
        equipment
      };
      await completeKitOperation(client, operationKey, result);
      if (changed) {
        await insertAuditEvent(client, {
          operationKey,
          playerId,
          eventType: "readied_weapon_changed",
          instanceId: null,
          kitIndex: equipment.activeKitIndex,
          equipment,
          details: {
            before: source.readiedWeaponSlot,
            after: readiedWeaponSlot
          }
        });
      }
      await client.query("COMMIT");
      committedSnapshot = equipment;
      this.operationCount += 1;
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      if (isInventoryCapacityError(error)) throw new EquipmentError("EQUIPMENT_INVENTORY_FULL", "This would exceed your carrying capacity");
      throw error;
    } finally {
      client.release();
      if (committedSnapshot) this.installMutationSnapshot(playerId, committedSnapshot);
    }
  }

  metricsSnapshot(): {
    operations: number;
    connectedRuntimes: number;
    dirtyCheckpoints: number;
  } {
    return {
      operations: this.operationCount,
      connectedRuntimes: this.runtimes.size,
      dirtyCheckpoints: this.peekDirtyCheckpoints().length
    };
  }

  private async changeEquipment(
    playerId: string,
    instanceId: string,
    slot: EquipmentSlot | null,
    requestId: string,
    action: "equip" | "unequip"
  ): Promise<EquipmentOperationResult> {
    requireIdentifier(playerId, "player ID", 160);
    requireIdentifier(instanceId, "equipment instance ID", 160);
    requireRequestId(requestId);
    this.assertNoPendingActivation(playerId);
    const connectedRuntime = this.runtimes.get(playerId);
    if (connectedRuntime?.dirtyCheckpoint) {
      await this.flushCheckpoint(connectedRuntime.dirtyCheckpoint);
    }
    const operationKey = `equipment:${playerId}:${requestId}`;
    const client = await this.pool.connect();
    let committedSnapshot: EquipmentSnapshotV2 | null = null;
    try {
      await client.query("BEGIN");
      await ensureEquipmentScaffold(client, playerId);
      const reserved = await client.query(
        `INSERT INTO equipment_operations (
           operation_key, player_id, action, instance_id, requested_slot
         ) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (operation_key) DO NOTHING
         RETURNING operation_key`,
        [operationKey, playerId, action, instanceId, slot]
      );
      if (reserved.rowCount === 0) {
        const replay = await assertLegacyOperation(
          client,
          operationKey,
          playerId,
          action,
          instanceId,
          slot
        );
        const equipment = storedSnapshot(replay.result) ??
          await loadEquipmentSnapshot(client, playerId, this.contextFor(playerId));
        await client.query("COMMIT");
        return { applied: false, replayed: true, equipment };
      }

      await client.query("SELECT player_id FROM player_equipment_state WHERE player_id = $1 FOR UPDATE", [playerId]);
      const locked = await client.query<EquipmentRow>(
        `${EQUIPMENT_ROW_SELECT}
         FROM equipment_instances
         WHERE instance_id = $1
         FOR UPDATE`,
        [instanceId]
      );
      const instance = locked.rows[0];
      if (!instance || instance.owner_player_id !== playerId) {
        throw new EquipmentError(
          "EQUIPMENT_NOT_OWNED",
          "Equipment instance is not owned by this player"
        );
      }
      if (instance.location === "destroyed") {
        throw new EquipmentError("EQUIPMENT_DESTROYED", "Destroyed equipment cannot be equipped");
      }
      if (action === "equip" && !isCarriedEquipmentLocation(instance.location)) {
        throw new EquipmentError(
          "EQUIPMENT_NOT_CARRIED",
          "Equipment must be carried before it can be equipped"
        );
      }
      const definition = requireEquipmentDefinition(instance.definition_id);
      if (action === "equip") {
        if (
          clampEquipmentCondition(instance.condition) === 0 &&
          definition.category === "chest_armor" &&
          equipmentRepairCostForFamily(definition.gameplayFamilyId)
        ) {
          throw new EquipmentError(
            "EQUIPMENT_REPAIR_UNAVAILABLE",
            "Broken equipment must be repaired before it can be equipped"
          );
        }
        if (!slot || !isEquipmentCategoryAllowedInSlot(definition.category, slot)) {
          throw new EquipmentError(
            "EQUIPMENT_SLOT_INVALID",
            `Equipment category ${definition.category} cannot occupy slot ${slot ?? "none"}`
          );
        }
        if (instance.ring_rough === true) {
          throw new EquipmentError("EQUIPMENT_RING_ROUGH", "Polish this ring before wearing it");
        }
        if (isUtilityGearDefinitionId(instance.definition_id) && !((instance.uses_remaining ?? 0) > 0)) {
          throw new EquipmentError("EQUIPMENT_DESTROYED", "That item has no uses left");
        }
        const requiredAchievementId = equipmentRequiredAchievementId(instance.enchantment_identity);
        if (requiredAchievementId && !(await playerHasAchievement(
          client,
          playerId,
          requiredAchievementId,
          this.achievementIdsFor(playerId)
        ))) {
          throw new EquipmentError(
            "EQUIPMENT_ACHIEVEMENT_REQUIRED",
            "Bitter Blood is required to equip Venom poison equipment",
            "achievement_required"
          );
        }
        const occupied = await client.query<{ instance_id: string }>(
          `SELECT instance_id
           FROM equipment_instances
           WHERE owner_player_id = $1
             AND location = 'equipped'
             AND equipped_slot = $2
           FOR UPDATE`,
          [playerId, slot]
        );
        // Utility gear goes on and comes off only at home (training gloves and boots are exempt).
        const wornUtility = occupied.rows.length > 0 && (await client.query(
          `SELECT 1 FROM equipment_instances
            WHERE owner_player_id = $1 AND location = 'equipped' AND equipped_slot = $2 AND uses_remaining IS NOT NULL`,
          [playerId, slot]
        )).rowCount! > 0;
        if ((isUtilityGearDefinitionId(instance.definition_id) || wornUtility) && !(await playerIsAtHome(client, playerId))) {
          throw new EquipmentError("EQUIPMENT_UTILITY_AT_HOME_ONLY", "Utility gear can only be changed at home");
        }
        if (occupied.rows.some((row) => row.instance_id !== instanceId)) {
          await client.query(
            `UPDATE equipment_instances SET location = 'inventory', equipped_slot = NULL
             WHERE owner_player_id = $1 AND location = 'equipped'
               AND equipped_slot = $2 AND instance_id <> $3`,
            [playerId, slot, instanceId]
          );
        }
        await client.query(
          `UPDATE equipment_instances
           SET location = 'equipped', equipped_slot = $2
           WHERE instance_id = $1`,
          [instanceId, slot]
        );
      } else {
        if (instance.location !== "equipped") {
          throw new EquipmentError(
            "EQUIPMENT_SLOT_INVALID",
            "Equipment instance is not currently equipped"
          );
        }
        if (isUtilityGearDefinitionId(instance.definition_id) && !(await playerIsAtHome(client, playerId))) {
          throw new EquipmentError("EQUIPMENT_UTILITY_AT_HOME_ONLY", "Utility gear can only be changed at home");
        }
        await client.query(
          `UPDATE equipment_instances
           SET location = 'inventory', equipped_slot = NULL
           WHERE instance_id = $1`,
          [instanceId]
        );
      }
      await client.query(
        `UPDATE player_equipment_state
         SET inventory_revision = inventory_revision + 1,
             active_revision = active_revision + 1,
             checkpoint_revision = checkpoint_revision + 1,
             active_kit_index = NULL,
             readied_weapon_slot = CASE
               WHEN $2 = 'unequip' AND readied_weapon_slot = $3 THEN 'melee'
               ELSE readied_weapon_slot
             END
         WHERE player_id = $1`,
        [playerId, action, instance.equipped_slot]
      );
      await updateEquipmentChallengeProfile(client, playerId);
      const equipment = await loadEquipmentSnapshot(
        client,
        playerId,
        this.contextFor(playerId)
      );
      await client.query(
        `UPDATE equipment_operations
         SET result = $2::jsonb, completed_at = now()
         WHERE operation_key = $1`,
        [operationKey, JSON.stringify(equipment)]
      );
      await client.query("COMMIT");
      committedSnapshot = equipment;
      this.operationCount += 1;
      return { applied: true, replayed: false, equipment };
    } catch (error) {
      await client.query("ROLLBACK");
      if (isInventoryCapacityError(error)) throw new EquipmentError("EQUIPMENT_INVENTORY_FULL", "This would exceed your carrying capacity");
      throw error;
    } finally {
      client.release();
      if (committedSnapshot) this.installMutationSnapshot(playerId, committedSnapshot);
    }
  }

  private async loadFreshSnapshot(
    playerId: string,
    context: EquipmentRuntimeContext,
    repairPersistedActiveLoadout = false
  ): Promise<EquipmentSnapshotV2> {
    requireIdentifier(playerId, "player ID", 160);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await ensureEquipmentScaffold(client, playerId);
      const snapshot = await loadEquipmentSnapshot(
        client,
        playerId,
        context,
        undefined,
        repairPersistedActiveLoadout
      );
      await client.query("COMMIT");
      return snapshot;
    } catch (error) {
      await client.query("ROLLBACK");
      if (isInventoryCapacityError(error)) throw new EquipmentError("EQUIPMENT_INVENTORY_FULL", "This would exceed your carrying capacity");
      throw error;
    } finally {
      client.release();
    }
  }

  private contextFor(playerId: string): EquipmentRuntimeContext {
    const context = this.runtimes.get(playerId)?.context ?? DEFAULT_RUNTIME_CONTEXT;
    const achievementIds = this.achievementIdsFor(playerId);
    return achievementIds === null
      ? context
      : { ...context, achievementIds: [...achievementIds] };
  }

  private achievementIdsFor(playerId: string): ReadonlySet<string> | null {
    return this.achievements?.achievementIds(playerId) ?? null;
  }

  private requireRuntime(playerId: string): RuntimeEntry {
    const runtime = this.runtimes.get(playerId);
    if (!runtime) {
      throw new EquipmentError(
        "EQUIPMENT_RUNTIME_NOT_CONNECTED",
        "Authoritative equipment runtime is not connected for this player"
      );
    }
    return runtime;
  }

  private assertNoPendingActivation(playerId: string): void {
    if (this.runtimes.get(playerId)?.pendingActivation) {
      throw new EquipmentError(
        "EQUIPMENT_ACTIVATION_PENDING",
        "Equipment cannot be mutated while a combat-kit activation is staged"
      );
    }
  }

  private installMutationSnapshot(
    playerId: string,
    snapshot: EquipmentSnapshotV2
  ): void {
    const runtime = this.runtimes.get(playerId);
    if (!runtime) return;
    runtime.snapshot = deepFreeze(snapshot);
    if (runtime.dirtyCheckpoint) {
      runtime.dirtyCheckpoint = checkpointFromSnapshot(
        runtime.snapshot,
        runtime.dirtyCheckpoint.activations
      );
    }
  }

  private async flushCheckpoint(checkpoint: EquipmentCheckpoint): Promise<void> {
    const client = await this.pool.connect();
    let persisted = false;
    try {
      await client.query("BEGIN");
      await ensureEquipmentScaffold(client, checkpoint.playerId);
      const stateResult = await client.query<EquipmentStateRow>(
        `SELECT equipment.inventory_revision::text,
                equipment.active_revision::text,
                equipment.checkpoint_revision::text,
                equipment.readied_weapon_slot,
                equipment.active_kit_index,
                equipment.current_combat_gear_level,
                equipment.unlocked_combat_gear_level,
                equipment.challenge_profile_version,
                progression.level AS character_level
         FROM player_equipment_state equipment
         JOIN player_progression_profiles progression
           ON progression.player_id = equipment.player_id
         WHERE equipment.player_id = $1
         FOR UPDATE`,
        [checkpoint.playerId]
      );
      const state = stateResult.rows[0];
      if (!state) {
        throw new EquipmentError(
          "EQUIPMENT_PLAYER_NOT_FOUND",
          "Player equipment state does not exist"
        );
      }
      const databaseInventoryRevision = databaseRevision(
        state.inventory_revision,
        "inventory revision"
      );
      const databaseActiveRevision = databaseRevision(
        state.active_revision,
        "active revision"
      );
      const databaseCheckpointRevision = databaseRevision(
        state.checkpoint_revision,
        "checkpoint revision"
      );
      if (databaseInventoryRevision > checkpoint.inventoryRevision) {
        if (
          checkpoint.activations.length > 0 &&
          databaseCheckpointRevision < checkpoint.activeRevision
        ) {
          throw new EquipmentError(
            "EQUIPMENT_CHECKPOINT_CONFLICT",
            "A newer inventory revision exists before the activation checkpoint was durable"
          );
        }
        await completeActivationOperations(client, checkpoint.activations);
        await client.query("COMMIT");
        this.acknowledgeCheckpoint(checkpoint);
        return;
      }
      if (databaseInventoryRevision < checkpoint.inventoryRevision) {
        throw new EquipmentError(
          "EQUIPMENT_CHECKPOINT_CONFLICT",
          "Equipment checkpoint is ahead of the durable inventory revision"
        );
      }
      if (
        databaseCheckpointRevision >= checkpoint.activeRevision ||
        databaseActiveRevision > checkpoint.activeRevision
      ) {
        await completeActivationOperations(client, checkpoint.activations);
        await client.query("COMMIT");
        this.acknowledgeCheckpoint(checkpoint);
        return;
      }

      const selectedIds = EQUIPMENT_SLOTS.map((slot) => checkpoint.activeInstanceIds[slot]);
      const locked = await client.query<EquipmentRow>(
        `${EQUIPMENT_ROW_SELECT}
         FROM equipment_instances
         WHERE instance_id = ANY($1::uuid[])
         FOR UPDATE`,
        [selectedIds]
      );
      const hasBitterBlood = await playerHasAchievement(
        client,
        checkpoint.playerId,
        "bitter_blood",
        this.achievementIdsFor(checkpoint.playerId)
      );
      assertLockedSelection(
        checkpoint.playerId,
        checkpoint.activeInstanceIds,
        checkpoint.readiedWeaponSlot,
        locked.rows,
        state.character_level,
        hasBitterBlood,
        true
      );
      await client.query(
        `UPDATE equipment_instances
         SET location = 'inventory', equipped_slot = NULL
         WHERE owner_player_id = $1 AND location = 'equipped'`,
        [checkpoint.playerId]
      );
      await client.query(
        `UPDATE equipment_instances AS equipment
         SET location = 'equipped',
             equipped_slot = selected.equipment_slot
         FROM unnest($2::uuid[], $3::text[]) AS selected(instance_id, equipment_slot)
         WHERE equipment.owner_player_id = $1
           AND equipment.instance_id = selected.instance_id`,
        [checkpoint.playerId, selectedIds, [...EQUIPMENT_SLOTS]]
      );
      await client.query(
        `UPDATE player_equipment_state
         SET active_revision = $2::bigint,
             checkpoint_revision = $2::bigint,
             readied_weapon_slot = $3,
             active_kit_index = $4
         WHERE player_id = $1`,
        [
          checkpoint.playerId,
          String(checkpoint.activeRevision),
          checkpoint.readiedWeaponSlot,
          checkpoint.activeKitIndex
        ]
      );
      await updateEquipmentChallengeProfile(client, checkpoint.playerId);
      await insertAuditEvent(client, {
        operationKey: `equipment-checkpoint:${checkpoint.playerId}:${checkpoint.activeRevision}`,
        playerId: checkpoint.playerId,
        eventType: "active_loadout_checkpointed",
        instanceId: null,
        kitIndex: checkpoint.activeKitIndex,
        equipment: {
          inventoryRevision: checkpoint.inventoryRevision,
          activeRevision: checkpoint.activeRevision
        },
        details: {
          activeInstanceIds: checkpoint.activeInstanceIds,
          readiedWeaponSlot: checkpoint.readiedWeaponSlot
        }
      });
      await completeActivationOperations(client, checkpoint.activations);
      await client.query("COMMIT");
      persisted = true;
    } catch (error) {
      await client.query("ROLLBACK");
      if (isInventoryCapacityError(error)) throw new EquipmentError("EQUIPMENT_INVENTORY_FULL", "This would exceed your carrying capacity");
      throw error;
    } finally {
      client.release();
    }

    if (!persisted) return;
    this.acknowledgeCheckpoint(checkpoint);
  }

  private acknowledgeCheckpoint(checkpoint: EquipmentCheckpoint): void {
    const runtime = this.runtimes.get(checkpoint.playerId);
    if (!runtime) return;
    if (
      runtime.dirtyCheckpoint &&
      runtime.dirtyCheckpoint.activeRevision === checkpoint.activeRevision &&
      runtime.dirtyCheckpoint.inventoryRevision === checkpoint.inventoryRevision
    ) {
      runtime.dirtyCheckpoint = null;
    } else if (runtime.dirtyCheckpoint && checkpoint.activations.length > 0) {
      const completedRequestIds = new Set(
        checkpoint.activations.map((activation) => activation.requestId)
      );
      const remainingActivations = runtime.dirtyCheckpoint.activations.filter(
        (activation) => !completedRequestIds.has(activation.requestId)
      );
      if (
        remainingActivations.length !==
        runtime.dirtyCheckpoint.activations.length
      ) {
        runtime.dirtyCheckpoint = deepFreeze({
          ...runtime.dirtyCheckpoint,
          activations: remainingActivations
        });
      }
    }
    if (runtime.snapshot.checkpointRevision < checkpoint.activeRevision) {
      runtime.snapshot = deepFreeze({
        ...runtime.snapshot,
        checkpointRevision: checkpoint.activeRevision
      });
    }
  }
}

function packageGrantOperationResult(value: unknown): {
  requested: Array<{ definitionId: EquipmentDefinitionId; quantity: number }>;
  grants: PackageEquipmentGrantResult[] | null;
} {
  if (!value || typeof value !== "object") {
    throw new EquipmentError(
      "EQUIPMENT_OPERATION_INCOMPLETE",
      "Package equipment operation is incomplete"
    );
  }
  const candidate = value as {
    requested?: unknown;
    grants?: unknown;
  };
  if (!Array.isArray(candidate.requested)) {
    throw new EquipmentError(
      "EQUIPMENT_OPERATION_INCOMPLETE",
      "Package equipment operation request is missing"
    );
  }
  return {
    requested: candidate.requested as Array<{
      definitionId: EquipmentDefinitionId;
      quantity: number;
    }>,
    grants: Array.isArray(candidate.grants)
      ? candidate.grants as PackageEquipmentGrantResult[]
      : null
  };
}

const EQUIPMENT_ROW_SELECT = `SELECT
  instance_id::text,
  definition_id,
  owner_player_id,
  location,
  equipped_slot,
  inventory_slot_index,
  manor_id::text,
  manor_slot_index,
  item_level,
  condition,
  balance_version,
  enchantment_identity,
  ring_bonuses,
  ring_rough,
  uses_remaining,
  inscription_name,
  inscribed_by_name,
  inscribed_at,
  inscription_stats,
  (SELECT copy.tag FROM shop_item_copies copy
   WHERE copy.copy_id = equipment_instances.instance_id::text) AS shop_tag,
  (SELECT copy.original_buyer_name FROM shop_item_copies copy
   WHERE copy.copy_id = equipment_instances.instance_id::text) AS shop_buyer_name,
  created_at,
  updated_at`;

async function ensureEquipmentScaffold(
  queryable: Queryable,
  playerId: string
): Promise<void> {
  await queryable.query(
    `INSERT INTO player_progression_profiles (player_id)
     SELECT id FROM players WHERE id = $1
     ON CONFLICT (player_id) DO NOTHING`,
    [playerId]
  );
  const state = await queryable.query(
    `INSERT INTO player_equipment_state (player_id)
     SELECT id FROM players WHERE id = $1
     ON CONFLICT (player_id) DO NOTHING
     RETURNING player_id`,
    [playerId]
  );
  await queryable.query(
    `INSERT INTO combat_kits (player_id, kit_index, name)
     SELECT player.id, kit_index, 'Kit ' || kit_index::text
     FROM players player
     CROSS JOIN generate_series(1, 6) AS kit_index
     WHERE player.id = $1
     ON CONFLICT (player_id, kit_index) DO NOTHING`,
    [playerId]
  );
  if (!state.rowCount) {
    const exists = await queryable.query(
      `SELECT player_id FROM player_equipment_state WHERE player_id = $1`,
      [playerId]
    );
    if (!exists.rowCount) {
      throw new EquipmentError(
        "EQUIPMENT_PLAYER_NOT_FOUND",
        "Player does not exist for equipment state"
      );
    }
  }
}

async function lockAuthoritativeCharacterLevel(
  queryable: Queryable,
  playerId: string
): Promise<number> {
  const result = await queryable.query<{ level: number }>(
    `SELECT level
     FROM player_progression_profiles
     WHERE player_id = $1
     FOR KEY SHARE`,
    [playerId]
  );
  const level = result.rows[0]?.level;
  if (!Number.isInteger(level) || level! < 0 || level! > MAX_EQUIPMENT_LEVEL) {
    throw new EquipmentError(
      "EQUIPMENT_PLAYER_NOT_FOUND",
      "Authoritative character level is unavailable"
    );
  }
  return level!;
}

const SHIELD_EQUIPMENT_DEFINITION_IDS: readonly string[] = EQUIPMENT_DEFINITION_IDS
  .filter((definitionId) => requireEquipmentDefinition(definitionId).category === "shield");

async function updateEquipmentChallengeProfile(
  queryable: Queryable,
  playerId: string
): Promise<{
  current_combat_gear_level: number;
  unlocked_combat_gear_level: number;
  challenge_profile_version: number;
}> {
  const result = await queryable.query<{
    current_combat_gear_level: number;
    unlocked_combat_gear_level: number;
    challenge_profile_version: number;
  }>(
    // Mirrors resolveEquipmentChallengeProfile: ceil(mean(best weapon, best
    // armor)) over present categories; secondary shields count as armor.
    `WITH categories AS (
       SELECT
         max(item_level) FILTER (
           WHERE equipped_slot = 'melee'
              OR (equipped_slot = 'secondary' AND NOT definition_id = ANY($3::text[]))
         ) AS weapon,
         max(item_level) FILTER (
           WHERE equipped_slot = 'chest'
              OR (equipped_slot = 'secondary' AND definition_id = ANY($3::text[]))
         ) AS armor
       FROM equipment_instances
       WHERE owner_player_id = $1
         AND location = 'equipped'
     ), resolved AS (
       SELECT COALESCE(
         ceil(
           (COALESCE(weapon, 0) + COALESCE(armor, 0))::numeric /
           NULLIF((weapon IS NOT NULL)::integer + (armor IS NOT NULL)::integer, 0)
         ),
         0
       )::integer AS current_level
       FROM categories
     )
     UPDATE player_equipment_state equipment
     SET current_combat_gear_level = resolved.current_level,
         unlocked_combat_gear_level = greatest(
           equipment.unlocked_combat_gear_level,
           resolved.current_level
         ),
         challenge_profile_version = $2
     FROM resolved
     WHERE equipment.player_id = $1
     RETURNING equipment.current_combat_gear_level,
               equipment.unlocked_combat_gear_level,
               equipment.challenge_profile_version`,
    [playerId, EQUIPMENT_BALANCE_VERSION, SHIELD_EQUIPMENT_DEFINITION_IDS]
  );
  const row = result.rows[0];
  if (!row) {
    throw new EquipmentError(
      "EQUIPMENT_PLAYER_NOT_FOUND",
      "Player equipment challenge profile does not exist"
    );
  }
  return row;
}

async function loadEquipmentSnapshot(
  queryable: Queryable,
  playerId: string,
  context: EquipmentRuntimeContext,
  override?: SnapshotOverride,
  repairPersistedActiveLoadout = false
): Promise<EquipmentSnapshotV2> {
  const stateResult = await queryable.query<EquipmentStateRow>(
    `SELECT equipment.inventory_revision::text,
            equipment.active_revision::text,
            equipment.checkpoint_revision::text,
            equipment.readied_weapon_slot,
            equipment.active_kit_index,
            equipment.current_combat_gear_level,
            equipment.unlocked_combat_gear_level,
            equipment.challenge_profile_version,
            progression.level AS character_level
     FROM player_equipment_state equipment
     JOIN player_progression_profiles progression
       ON progression.player_id = equipment.player_id
     WHERE equipment.player_id = $1
     ${repairPersistedActiveLoadout ? "FOR UPDATE" : ""}`,
    [playerId]
  );
  const equipmentResult = await queryable.query<EquipmentRow>(
    `${EQUIPMENT_ROW_SELECT}
     FROM equipment_instances
     WHERE (
       owner_player_id = $1
       AND location NOT IN ('market_escrow', 'market_collection', 'gift_escrow')
     )
        OR instance_id IN (
          SELECT instance_id FROM combat_kit_items WHERE player_id = $1
        )
     ORDER BY created_at, instance_id`,
    [playerId]
  );
  const kitsResult = await queryable.query<CombatKitRow>(
    `SELECT kit_index, name, readied_weapon_slot, revision::text
     FROM combat_kits
     WHERE player_id = $1
     ORDER BY kit_index`,
    [playerId]
  );
  const kitItemsResult = await queryable.query<CombatKitItemRow>(
    `SELECT kit_index, equipment_slot, instance_id::text
     FROM combat_kit_items
     WHERE player_id = $1
     ORDER BY kit_index, equipment_slot`,
    [playerId]
  );
  const achievementIds = context.achievementIds === undefined
    ? new Set((await queryable.query<{ achievement_id: string }>(
        `SELECT achievement_id FROM player_achievements WHERE player_id=$1`,
        [playerId]
      )).rows.map((row) => row.achievement_id))
    : new Set(context.achievementIds);
  const state = stateResult.rows[0];
  if (!state) {
    throw new EquipmentError(
      "EQUIPMENT_PLAYER_NOT_FOUND",
      "Player equipment state does not exist"
    );
  }
  if (kitsResult.rows.length !== COMBAT_KIT_INDICES.length) {
    throw new EquipmentError(
      "EQUIPMENT_OPERATION_INCOMPLETE",
      "Player equipment state does not contain exactly six combat kits"
    );
  }
  const authoritativeContext: EquipmentRuntimeContext = {
    ...context,
    characterLevel: state.character_level
  };
  let repairMessage: string | null = null;
  if (repairPersistedActiveLoadout) {
    const illegalRows = equipmentResult.rows.filter(
      (row) =>
        row.owner_player_id === playerId &&
        row.location === "equipped" &&
        (
          equipmentRequiredAchievementId(row.enchantment_identity) !== null &&
          !achievementIds.has(equipmentRequiredAchievementId(row.enchantment_identity)!)
        )
    );
    if (illegalRows.length > 0) {
      const illegalIds = illegalRows.map((row) => row.instance_id);
      await queryable.query(
        `UPDATE equipment_instances
         SET location = 'inventory', equipped_slot = NULL
         WHERE owner_player_id = $1
           AND instance_id = ANY($2::uuid[])
           AND location = 'equipped'`,
        [playerId, illegalIds]
      );
      const revised = await queryable.query<{
        inventory_revision: string;
        active_revision: string;
        checkpoint_revision: string;
      }>(
        `UPDATE player_equipment_state
         SET inventory_revision = inventory_revision + 1,
             active_revision = active_revision + 1,
             checkpoint_revision = active_revision + 1,
             active_kit_index = NULL,
             readied_weapon_slot = 'melee'
         WHERE player_id = $1
         RETURNING inventory_revision::text,
                   active_revision::text,
                   checkpoint_revision::text`,
        [playerId]
      );
      const revision = revised.rows[0];
      if (!revision) {
        throw new EquipmentError(
          "EQUIPMENT_PLAYER_NOT_FOUND",
          "Player equipment state disappeared during bootstrap repair"
        );
      }
      state.inventory_revision = revision.inventory_revision;
      state.active_revision = revision.active_revision;
      state.checkpoint_revision = revision.checkpoint_revision;
      state.active_kit_index = null;
      state.readied_weapon_slot = "melee";
      for (const row of illegalRows) {
        row.location = "inventory";
        row.equipped_slot = null;
      }
      repairMessage =
        `${illegalRows.length} equipped item${illegalRows.length === 1 ? " was" : "s were"} ` +
        `moved to Inventory because its equip requirements were no longer met. ` +
        `Saved kit references were preserved.`;
    }
    const profile = await updateEquipmentChallengeProfile(queryable, playerId);
    state.current_combat_gear_level = profile.current_combat_gear_level;
    state.unlocked_combat_gear_level = profile.unlocked_combat_gear_level;
    state.challenge_profile_version = profile.challenge_profile_version;
  }
  const snapshot = composeSnapshot({
    playerId,
    context: authoritativeContext,
    state,
    equipmentRows: equipmentResult.rows,
    kitRows: kitsResult.rows,
    kitItemRows: kitItemsResult.rows,
    achievementIds,
    repairMessage,
    ...(override ? { override } : {})
  });
  if (
    repairPersistedActiveLoadout &&
    (
      snapshot.activeKitIndex !== optionalKitIndex(state.active_kit_index) ||
      snapshot.readiedWeaponSlot !== state.readied_weapon_slot
    )
  ) {
    await queryable.query(
      `UPDATE player_equipment_state
       SET active_kit_index = $2,
           readied_weapon_slot = $3
       WHERE player_id = $1`,
      [playerId, snapshot.activeKitIndex, snapshot.readiedWeaponSlot]
    );
  }
  return snapshot;
}

function composeSnapshot(input: {
  playerId: string;
  context: EquipmentRuntimeContext;
  state: EquipmentStateRow;
  equipmentRows: EquipmentRow[];
  kitRows: CombatKitRow[];
  kitItemRows: CombatKitItemRow[];
  achievementIds: ReadonlySet<string>;
  repairMessage: string | null;
  override?: SnapshotOverride;
}): EquipmentSnapshotV2 {
  const rowsById = new Map(input.equipmentRows.map((row) => [row.instance_id, row]));
  const savedKitIndices = new Map<string, Set<CombatKitIndex>>();
  for (const reference of input.kitItemRows) {
    const kitIndex = requireKitIndex(reference.kit_index);
    const indices = savedKitIndices.get(reference.instance_id) ?? new Set<CombatKitIndex>();
    indices.add(kitIndex);
    savedKitIndices.set(reference.instance_id, indices);
  }

  const activeInstanceIds = input.override?.activeInstanceIds ??
    activeIdsFromRows(input.equipmentRows, input.playerId);
  const activeSlotByInstance = new Map<string, EquipmentSlot>();
  for (const slot of EQUIPMENT_SLOTS) {
    const instanceId = activeInstanceIds[slot];
    if (!instanceId || activeSlotByInstance.has(instanceId)) continue;
    const row = rowsById.get(instanceId);
    if (
      !row ||
      row.owner_player_id !== input.playerId ||
      !isCarriedEquipmentLocation(row.location)
      || (equipmentRequiredAchievementId(row.enchantment_identity) !== null &&
        !input.achievementIds.has(equipmentRequiredAchievementId(row.enchantment_identity)!))
    ) {
      continue;
    }
    const definition = requireEquipmentDefinition(row.definition_id);
    if (!isEquipmentCategoryAllowedInSlot(definition.category, slot)) continue;
    if (row.ring_rough === true) continue;
    activeSlotByInstance.set(instanceId, slot);
  }

  const ownedInstances = input.equipmentRows
    .filter((row) =>
      row.owner_player_id === input.playerId &&
      !["destroyed", "market_escrow", "market_collection", "gift_escrow"].includes(row.location)
    )
    .map((row) => {
      const activeSlot = activeSlotByInstance.get(row.instance_id) ?? null;
      return instanceFromRow(
        row,
        input.playerId,
      input.context,
        [...(savedKitIndices.get(row.instance_id) ?? [])],
        activeSlot ? "equipped" : row.location,
        activeSlot,
        input.achievementIds
      );
    });
  const ownedById = new Map(ownedInstances.map((instance) => [instance.instanceId, instance]));
  const allById = new Map<string, EquipmentInstanceV2>(ownedById);
  for (const row of input.equipmentRows) {
    if (allById.has(row.instance_id)) continue;
    allById.set(
      row.instance_id,
      instanceFromRow(
        row,
        input.playerId,
      input.context,
        [...(savedKitIndices.get(row.instance_id) ?? [])],
        row.location,
        row.location === "equipped" && row.equipped_slot !== "weapon"
          ? row.equipped_slot
          : null,
        input.achievementIds
      )
    );
  }

  const active = emptyEquipmentSlots<EquipmentInstanceV2 | null>(null);
  for (const [instanceId, slot] of activeSlotByInstance) {
    active[slot] = ownedById.get(instanceId) ?? null;
  }
  let readiedWeaponSlot =
    input.override?.readiedWeaponSlot ?? input.state.readied_weapon_slot;
  if (
    readiedWeaponSlot === "secondary" &&
    active.secondary?.category !== "ranged_weapon"
  ) {
    readiedWeaponSlot = "melee";
  }

  const referencesByKit = new Map<CombatKitIndex, Map<EquipmentSlot, string>>();
  for (const reference of input.kitItemRows) {
    const kitIndex = requireKitIndex(reference.kit_index);
    const references = referencesByKit.get(kitIndex) ?? new Map<EquipmentSlot, string>();
    references.set(reference.equipment_slot, reference.instance_id);
    referencesByKit.set(kitIndex, references);
  }
  const kits = input.kitRows.map((row) => {
    const kitIndex = requireKitIndex(row.kit_index);
    const items = emptyEquipmentSlots<EquipmentInstanceV2 | null>(null);
    const references = referencesByKit.get(kitIndex);
    if (references) {
      for (const [slot, instanceId] of references) {
        items[slot] = allById.get(instanceId) ?? null;
      }
    }
    const invalidReason = assessKit(
      input.playerId,
      items,
      references,
      row.readied_weapon_slot
    );
    return {
      kitIndex,
      name: row.name,
      readiedWeaponSlot: row.readied_weapon_slot,
      items,
      valid: invalidReason === null,
      invalidReason,
      revision: databaseRevision(row.revision, "combat-kit revision")
    };
  });
  const requestedActiveKitIndex =
    input.override?.activeKitIndex ??
    optionalKitIndex(input.state.active_kit_index);
  const requestedActiveKit = requestedActiveKitIndex === null
    ? null
    : kits.find((kit) => kit.kitIndex === requestedActiveKitIndex) ?? null;
  const activeKitIndex =
    requestedActiveKit &&
    requestedActiveKit.valid &&
    requestedActiveKit.invalidReason === null &&
    requestedActiveKit.readiedWeaponSlot === readiedWeaponSlot &&
    EQUIPMENT_SLOTS.every(
      (slot) =>
        requestedActiveKit.items[slot]?.instanceId ===
        active[slot]?.instanceId
    )
      ? requestedActiveKit.kitIndex
      : null;

  return finishSnapshot({
    playerId: input.playerId,
    context: input.context,
    instances: ownedInstances,
    active,
    readiedWeaponSlot,
    activeKitIndex,
    kits,
    inventoryRevision: databaseRevision(
      input.state.inventory_revision,
      "inventory revision"
    ),
    activeRevision: Math.max(
      input.override?.activeRevision ?? 0,
      databaseRevision(input.state.active_revision, "active revision")
    ),
    checkpointRevision: Math.max(
      input.override?.checkpointRevision ?? 0,
      databaseRevision(input.state.checkpoint_revision, "checkpoint revision")
    ),
    unlockedGearLevel: input.state.unlocked_combat_gear_level,
    repairMessage: input.repairMessage
  });
}

function finishSnapshot(input: {
  playerId: string;
  context: EquipmentRuntimeContext;
  instances: EquipmentInstanceV2[];
  active: EquipmentSlotRecord<EquipmentInstanceV2 | null>;
  readiedWeaponSlot: ReadiedWeaponSlot;
  activeKitIndex: CombatKitIndex | null;
  kits: CombatKitSnapshot[];
  inventoryRevision: number;
  activeRevision: number;
  checkpointRevision: number;
  unlockedGearLevel: number;
  repairMessage: string | null;
}): EquipmentSnapshotV2 {
  const derivedStats = resolveEquipmentCombatStats({
    context: input.context.context,
    characterLevel: input.context.characterLevel,
    classId: input.context.classId,
    classRank: input.context.classRank,
    loadout: activeEquipmentLoadoutFromSnapshot({
      active: input.active,
      readiedWeaponSlot: input.readiedWeaponSlot
    }),
    unlockedGearLevel: input.unlockedGearLevel
  });
  const readied = input.active[input.readiedWeaponSlot];
  const weapon =
    readied?.category === "melee_weapon" || readied?.category === "ranged_weapon"
      ? readied
      : null;
  const totalAttackPowerBonus = Math.max(
    0,
    Math.round(weapon?.derived.pveAttackContribution ?? 0)
  );
  const totalDefenseBonus = Math.max(
    0,
    Math.round(
      EQUIPMENT_SLOTS.reduce(
        (total, slot) => total + (input.active[slot]?.derived.pveDefenseContribution ?? 0),
        0
      )
    )
  );
  return {
    snapshotVersion: 2,
    balanceVersion: EQUIPMENT_BALANCE_VERSION,
    playerId: input.playerId,
    instances: input.instances,
    active: input.active,
    readiedWeaponSlot: input.readiedWeaponSlot,
    activeKitIndex: input.activeKitIndex,
    kits: input.kits,
    inventoryRevision: input.inventoryRevision,
    activeRevision: input.activeRevision,
    checkpointRevision: input.checkpointRevision,
    derivedStats,
    characterLevel: input.context.characterLevel,
    repairMessage: input.repairMessage,
    weapon,
    chest: input.active.chest,
    totalAttackPowerBonus,
    totalDefenseBonus
  };
}

/** Ring tier, Rough state and bonuses; a Rough ring shows its tier only. */
function ringFieldsFromRow(row: EquipmentRow): { ring?: RingInstanceView } {
  const tier = ringTierForDefinitionId(row.definition_id);
  if (tier === null) return {};
  const rough = row.ring_rough === true;
  return {
    ring: {
      tier,
      rough,
      bonuses: rough ? [] : parseRingBonusRolls(row.ring_bonuses) ?? []
    }
  };
}

function serverRingRandom(): number {
  return randomInt(0, 2 ** 32) / 2 ** 32;
}

function instanceFromRow(
  row: EquipmentRow,
  viewerPlayerId: string,
  context: EquipmentRuntimeContext,
  savedKitIndices: CombatKitIndex[],
  location: EquipmentRow["location"],
  equippedSlot: EquipmentSlot | null,
  achievementIds: ReadonlySet<string>
): EquipmentInstanceV2 {
  const definition = requireEquipmentDefinition(row.definition_id);
  const itemLevel = requireEquipmentLevel(row.item_level);
  const derivedSlot = equippedSlot ?? definition.slot;
  const derived = resolveEquipmentItemDerivedStats({
      item: {
        instanceId: row.instance_id,
        definition,
        itemLevel,
        condition: row.condition
    },
    slot: derivedSlot,
    classId: context.classId
  });
  const notOwned = row.owner_player_id !== viewerPlayerId;
  const destroyed = location === "destroyed";
  const upgrade = projectEquipmentUpgradeEligibility({
    itemLevel,
    characterLevel: context.characterLevel,
    owned: !notOwned,
    destroyed,
    enchantmentIdentity: row.enchantment_identity
  });
  const requiredAchievementId = equipmentRequiredAchievementId(row.enchantment_identity);
  return {
    instanceId: row.instance_id,
    definitionId: definition.definitionId,
    displayName: definition.displayName,
    ownerPlayerId: row.owner_player_id,
    location,
    equippedSlot,
    ...(row.manor_id === null ? {} : { manorId: row.manor_id }),
    ...(row.manor_slot_index === null ? {} : { manorSlotIndex: row.manor_slot_index }),
    droppable: true,
    manorStorable: true,
    itemLevel,
    maximumItemLevel: MAX_EQUIPMENT_LEVEL,
    condition: clampEquipmentCondition(row.condition),
    maximumCondition: EQUIPMENT_MAX_CONDITION,
    category: definition.category,
    balanceVersion: EQUIPMENT_BALANCE_VERSION,
    enchantmentIdentity: row.enchantment_identity,
    ...ringFieldsFromRow(row),
    ...(isUtilityGearDefinitionId(row.definition_id) ? { usesRemaining: row.uses_remaining ?? null } : {}),
    ...(row.inscription_name && inscriptionKind(definition.category)
      ? {
          inscription: {
            name: row.inscription_name,
            inscriberName: row.inscribed_by_name ?? "",
            inscribedAt: new Date(row.inscribed_at ?? row.updated_at).toISOString(),
            kind: inscriptionKind(definition.category)!,
            stats: row.inscription_stats ?? {}
          }
        }
      : {}),
    ...(row.shop_tag && row.shop_buyer_name
      ? { provenance: { tag: row.shop_tag, originalBuyerName: row.shop_buyer_name } }
      : {}),
    requiredAchievementId,
    achievementRequirementMet: requiredAchievementId === null || achievementIds.has(requiredAchievementId),
    attackPowerBonus: Math.max(0, Math.round(derived.pveAttackContribution)),
    defenseBonus: Math.max(0, Math.round(derived.pveDefenseContribution)),
    weaponCategory: definition.weaponCategory,
    armorCategory: definition.armorCategory,
    twoHanded: definition.twoHanded,
    savedKitIndices: savedKitIndices.sort((left, right) => left - right),
    derived,
    ...upgrade,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString()
  };
}

function rebuildSnapshot(
  current: EquipmentSnapshotV2,
  requestedActiveIds: EquipmentSlotRecord<string | null>,
  requestedReadiedWeaponSlot: ReadiedWeaponSlot,
  activeKitIndex: CombatKitIndex | null,
  activeRevision: number,
  checkpointRevision: number,
  context: EquipmentRuntimeContext
): EquipmentSnapshotV2 {
  const slotByInstance = new Map<string, EquipmentSlot>();
  for (const slot of EQUIPMENT_SLOTS) {
    const instanceId = requestedActiveIds[slot];
    if (instanceId) slotByInstance.set(instanceId, slot);
  }
  const instances = current.instances.map((instance) => {
    const activeSlot = slotByInstance.get(instance.instanceId) ?? null;
    const definition = requireEquipmentDefinition(instance.definitionId);
    const derived = resolveEquipmentItemDerivedStats({
      item: {
        instanceId: instance.instanceId,
        definition,
        itemLevel: instance.itemLevel,
        ...(instance.condition === undefined ? {} : { condition: instance.condition })
      },
      slot: activeSlot ?? definition.slot,
      classId: context.classId
    });
    const upgrade = projectEquipmentUpgradeEligibility({
      itemLevel: instance.itemLevel,
      characterLevel: context.characterLevel,
      owned: instance.ownerPlayerId === current.playerId,
      destroyed: instance.location === "destroyed",
      enchantmentIdentity: instance.enchantmentIdentity ?? null
    });
    return {
      ...instance,
      location: activeSlot
        ? "equipped" as const
        : instance.location === "equipped"
          ? "inventory" as const
          : instance.location,
      equippedSlot: activeSlot,
      derived,
      attackPowerBonus: Math.max(0, Math.round(derived.pveAttackContribution)),
      defenseBonus: Math.max(0, Math.round(derived.pveDefenseContribution)),
      ...upgrade
    };
  });
  const byId = new Map(instances.map((instance) => [instance.instanceId, instance]));
  const active = emptyEquipmentSlots<EquipmentInstanceV2 | null>(null);
  for (const slot of EQUIPMENT_SLOTS) {
    const instanceId = requestedActiveIds[slot];
    active[slot] = instanceId ? byId.get(instanceId) ?? null : null;
  }
  const kits = current.kits.map((kit) => {
    const items = emptyEquipmentSlots<EquipmentInstanceV2 | null>(null);
    const references = new Map<EquipmentSlot, string>();
    for (const slot of EQUIPMENT_SLOTS) {
      const previous = kit.items[slot];
      if (!previous) continue;
      references.set(slot, previous.instanceId);
      items[slot] = byId.get(previous.instanceId) ?? previous;
    }
    const invalidReason = assessKit(
      current.playerId,
      items,
      references,
      kit.readiedWeaponSlot
    );
    return {
      ...kit,
      items,
      valid: invalidReason === null,
      invalidReason
    };
  });
  return finishSnapshot({
    playerId: current.playerId,
    context,
    instances,
    active,
    readiedWeaponSlot: requestedReadiedWeaponSlot,
    activeKitIndex,
    kits,
    inventoryRevision: current.inventoryRevision,
    activeRevision,
    checkpointRevision,
    unlockedGearLevel: current.derivedStats.challengeProfile.unlockedGearLevel,
    repairMessage: current.repairMessage
  });
}

function assessKit(
  playerId: string,
  items: EquipmentSlotRecord<EquipmentInstanceV2 | null>,
  references: Map<EquipmentSlot, string> | undefined,
  readiedWeaponSlot: ReadiedWeaponSlot
): CombatKitInvalidReason | null {
  const seen = new Set<string>();
  for (const slot of EQUIPMENT_SLOTS) {
    const referencedId = references?.get(slot);
    if (!referencedId) continue;
    const item = items[slot];
    if (!item) return "missing_item";
    if (item.ownerPlayerId !== playerId) return "not_owned";
    if (item.location === "destroyed") return "destroyed";
    if (!isCarriedEquipmentLocation(item.location)) return "not_carried";
    if (item.requiredAchievementId && !item.achievementRequirementMet) return "achievement_required";
    if (seen.has(item.instanceId)) return "duplicate_item";
    seen.add(item.instanceId);
    if (slot === "secondary" && !["ranged_weapon", "shield"].includes(item.category)) {
      return "secondary_not_ranged_or_shield";
    }
    if (!isEquipmentCategoryAllowedInSlot(item.category, slot)) {
      return "slot_incompatible";
    }
  }
  if (!references?.size) return "incomplete";
  if (
    readiedWeaponSlot === "secondary" &&
    items.secondary?.category !== "ranged_weapon"
  ) {
    return "readied_secondary_not_ranged";
  }
  return null;
}

function assertCompleteSelection(
  snapshot: EquipmentSnapshotV2,
  selected: EquipmentSlotRecord<string | null>,
  readiedWeaponSlot: ReadiedWeaponSlot
): void {
  const byId = new Map(snapshot.instances.map((item) => [item.instanceId, item]));
  const seen = new Set<string>();
  for (const slot of EQUIPMENT_SLOTS) {
    const instanceId = selected[slot];
    if (!instanceId) continue;
    const item = byId.get(instanceId);
    if (!item) {
      throw new EquipmentError(
        "EQUIPMENT_KIT_INVALID",
        `Equipment instance ${instanceId} is missing`,
        "missing_item"
      );
    }
    if (item.ownerPlayerId !== snapshot.playerId) {
      throw new EquipmentError(
        "EQUIPMENT_KIT_INVALID",
        `Equipment instance ${instanceId} is not owned`,
        "not_owned"
      );
    }
    if (item.location === "destroyed") {
      throw new EquipmentError(
        "EQUIPMENT_KIT_INVALID",
        `Equipment instance ${instanceId} is destroyed`,
        "destroyed"
      );
    }
    if (!isCarriedEquipmentLocation(item.location)) {
      throw new EquipmentError(
        "EQUIPMENT_KIT_INVALID",
        `Equipment instance ${instanceId} is not carried`,
        "not_carried"
      );
    }
    if (item.requiredAchievementId && !item.achievementRequirementMet) {
      throw new EquipmentError(
        "EQUIPMENT_ACHIEVEMENT_REQUIRED",
        "Bitter Blood is required to activate Venom poison equipment",
        "achievement_required"
      );
    }
    if (seen.has(instanceId)) {
      throw new EquipmentError(
        "EQUIPMENT_KIT_INVALID",
        `Equipment instance ${instanceId} occupies more than one slot`,
        "duplicate_item"
      );
    }
    seen.add(instanceId);
    if (!isEquipmentCategoryAllowedInSlot(item.category, slot)) {
      throw new EquipmentError(
        "EQUIPMENT_KIT_INVALID",
        `Equipment instance ${instanceId} is incompatible with slot ${slot}`,
        slot === "secondary"
          ? "secondary_not_ranged_or_shield"
          : "slot_incompatible"
      );
    }
  }
  const active = emptyEquipmentSlots<EquipmentInstanceV2 | null>(null);
  for (const slot of EQUIPMENT_SLOTS) active[slot] = byId.get(selected[slot] ?? "") ?? null;
  if (readiedWeaponSlot === "secondary") assertReadiedWeapon(active, readiedWeaponSlot);
}

function assertReadiedWeapon(
  active: EquipmentSlotRecord<EquipmentInstanceV2 | null>,
  readiedWeaponSlot: ReadiedWeaponSlot
): void {
  if (readiedWeaponSlot === "secondary" && active.secondary?.category !== "ranged_weapon") {
    throw new EquipmentError(
      "EQUIPMENT_KIT_INVALID",
      "Secondary can be readied only when it contains a ranged weapon",
      "readied_secondary_not_ranged"
    );
  }
  if (readiedWeaponSlot === "melee" && active.melee?.category !== "melee_weapon") {
    throw new EquipmentError(
      "EQUIPMENT_KIT_INVALID",
      "The melee slot does not contain a melee weapon",
      "slot_incompatible"
    );
  }
}

async function lockAndValidateSelection(
  queryable: Queryable,
  playerId: string,
  selected: EquipmentSlotRecord<string | null>,
  readiedWeaponSlot: ReadiedWeaponSlot,
  characterLevel: number,
  achievementIds: ReadonlySet<string> | null,
  allowWornUtility = false
): Promise<void> {
  const rows = await queryable.query<EquipmentRow>(
    `${EQUIPMENT_ROW_SELECT}
     FROM equipment_instances
     WHERE instance_id = ANY($1::uuid[])
     FOR UPDATE`,
    [EQUIPMENT_SLOTS.map((slot) => selected[slot])]
  );
  const hasBitterBlood = await playerHasAchievement(
    queryable,
    playerId,
    "bitter_blood",
    achievementIds
  );
  assertLockedSelection(
    playerId,
    selected,
    readiedWeaponSlot,
    rows.rows,
    characterLevel,
    hasBitterBlood,
    allowWornUtility
  );
}

async function playerHasAchievement(
  queryable: Queryable,
  playerId: string,
  achievementId: string,
  achievementIds: ReadonlySet<string> | null = null
): Promise<boolean> {
  if (achievementIds !== null) return achievementIds.has(achievementId);
  const result = await queryable.query(
    `SELECT 1 FROM player_achievements
     WHERE player_id=$1 AND achievement_id=$2`,
    [playerId, achievementId]
  );
  return (result.rowCount ?? 0) > 0;
}

function assertLockedSelection(
  playerId: string,
  selected: EquipmentSlotRecord<string | null>,
  readiedWeaponSlot: ReadiedWeaponSlot,
  rows: EquipmentRow[],
  characterLevel: number,
  hasBitterBlood: boolean,
  /**
   * Lets utility gear stay in a selection when it is already worn in that same slot (an untouched
   * glove or boot during a scroll swap or a kit activation). It is never put on this way.
   */
  allowWornUtility = false
): void {
  const byId = new Map(rows.map((row) => [row.instance_id, row]));
  const seen = new Set<string>();
  for (const slot of EQUIPMENT_SLOTS) {
    const instanceId = selected[slot];
    if (!instanceId) continue;
    if (seen.has(instanceId)) {
      throw new EquipmentError(
        "EQUIPMENT_KIT_INVALID",
        "The same equipment instance cannot occupy two active slots",
        "duplicate_item"
      );
    }
    seen.add(instanceId);
    const row = byId.get(instanceId);
    if (!row) {
      throw new EquipmentError(
        "EQUIPMENT_KIT_INVALID",
        `Equipment instance ${instanceId} is missing`,
        "missing_item"
      );
    }
    if (row.owner_player_id !== playerId) {
      throw new EquipmentError(
        "EQUIPMENT_KIT_INVALID",
        `Equipment instance ${instanceId} is not owned`,
        "not_owned"
      );
    }
    if (row.location === "destroyed") {
      throw new EquipmentError(
        "EQUIPMENT_KIT_INVALID",
        `Equipment instance ${instanceId} is destroyed`,
        "destroyed"
      );
    }
    if (!isCarriedEquipmentLocation(row.location)) {
      throw new EquipmentError(
        "EQUIPMENT_KIT_INVALID",
        `Equipment instance ${instanceId} is not carried`,
        "not_carried"
      );
    }
    if (isUtilityGearDefinitionId(row.definition_id)) {
      if (allowWornUtility && row.location === "equipped" && row.equipped_slot === slot) continue;
      throw new EquipmentError(
        "EQUIPMENT_KIT_INVALID",
        "Utility gear cannot be part of a combat kit",
        "not_carried"
      );
    }
    if (equipmentRequiredAchievementId(row.enchantment_identity) && !hasBitterBlood) {
      throw new EquipmentError(
        "EQUIPMENT_ACHIEVEMENT_REQUIRED",
        "Bitter Blood is required to activate Venom poison equipment",
        "achievement_required"
      );
    }
    const definition = requireEquipmentDefinition(row.definition_id);
    if (
      clampEquipmentCondition(row.condition) === 0 &&
      definition.category === "chest_armor" &&
      equipmentRepairCostForFamily(definition.gameplayFamilyId)
    ) {
      throw new EquipmentError(
        "EQUIPMENT_REPAIR_UNAVAILABLE",
        `Broken ${definition.displayName} must be repaired before it can be equipped`
      );
    }
    if (row.ring_rough === true) {
      throw new EquipmentError("EQUIPMENT_RING_ROUGH", "Polish this ring before wearing it", "slot_incompatible");
    }
    if (!isEquipmentCategoryAllowedInSlot(definition.category, slot)) {
      throw new EquipmentError(
        "EQUIPMENT_KIT_INVALID",
        `Equipment instance ${instanceId} is incompatible with slot ${slot}`,
        slot === "secondary"
          ? "secondary_not_ranged_or_shield"
          : "slot_incompatible"
      );
    }
  }
  if (readiedWeaponSlot === "secondary") {
    const secondary = byId.get(selected.secondary ?? "");
    if (
      !secondary ||
      requireEquipmentDefinition(secondary.definition_id).category !== "ranged_weapon"
    ) {
      throw new EquipmentError(
        "EQUIPMENT_KIT_INVALID",
        "Secondary can be readied only when it contains a ranged weapon",
        "readied_secondary_not_ranged"
      );
    }
  }
}

/** Whether a locked, remembered row can go on in `slot` now; anything else is skipped, never an error. */
function gearScrollRowUsable(row: EquipmentRow, slot: EquipmentSlot, playerId: string, hasBitterBlood: boolean): boolean {
  if (row.owner_player_id !== playerId || !isCarriedEquipmentLocation(row.location)) return false;
  if (isUtilityGearDefinitionId(row.definition_id) || row.ring_rough === true) return false;
  if (!isEquipmentDefinitionId(row.definition_id)) return false;
  const definition = requireEquipmentDefinition(row.definition_id);
  if (!isEquipmentCategoryAllowedInSlot(definition.category, slot)) return false;
  if (equipmentRequiredAchievementId(row.enchantment_identity) && !hasBitterBlood) return false;
  return !(
    clampEquipmentCondition(row.condition) === 0 &&
    definition.category === "chest_armor" &&
    equipmentRepairCostForFamily(definition.gameplayFamilyId)
  );
}

async function lockAndAssertInventoryRevision(
  queryable: Queryable,
  playerId: string,
  expected: number
): Promise<void> {
  const result = await queryable.query<{ inventory_revision: string }>(
    `SELECT inventory_revision::text
     FROM player_equipment_state
     WHERE player_id = $1
     FOR UPDATE`,
    [playerId]
  );
  const row = result.rows[0];
  if (!row) {
    throw new EquipmentError(
      "EQUIPMENT_PLAYER_NOT_FOUND",
      "Player equipment state does not exist"
    );
  }
  const current = databaseRevision(row.inventory_revision, "inventory revision");
  if (current !== expected) throw staleInventoryError(expected, current);
}

async function reserveActivationOperation(
  queryable: Queryable,
  operationKey: string,
  playerId: string,
  requestId: string,
  kitIndex: CombatKitIndex,
  expectedInventoryRevision: number
): Promise<
  | { kind: "reserved" | "pending" }
  | { kind: "completed"; activation: AppliedKitActivation }
> {
  const payloadJson = JSON.stringify({ expectedInventoryRevision });
  const reserved = await queryable.query(
    `INSERT INTO combat_kit_operations (
       operation_key, player_id, request_id, action, kit_index, payload
     ) VALUES ($1,$2,$3,'activate',$4,$5::jsonb)
     ON CONFLICT (operation_key) DO NOTHING
     RETURNING operation_key`,
    [operationKey, playerId, requestId, kitIndex, payloadJson]
  );
  if (reserved.rowCount) return { kind: "reserved" };

  const existing = await queryable.query<KitOperationRow>(
    `SELECT player_id, request_id, action, kit_index,
            payload = $2::jsonb AS payload_matches,
            result, completed_at
     FROM combat_kit_operations
     WHERE operation_key = $1`,
    [operationKey, payloadJson]
  );
  const row = existing.rows[0];
  if (
    !row ||
    row.player_id !== playerId ||
    row.request_id !== requestId ||
    row.action !== "activate" ||
    row.kit_index !== kitIndex ||
    !row.payload_matches
  ) {
    throw new EquipmentError(
      "EQUIPMENT_IDEMPOTENCY_CONFLICT",
      "Combat-kit activation request ID was reused with different intent"
    );
  }
  if (!row.completed_at) return { kind: "pending" };
  const activation = storedActivationResult(row.result);
  if (!activation) {
    throw new EquipmentError(
      "EQUIPMENT_OPERATION_INCOMPLETE",
      "Completed combat-kit activation does not contain a valid result"
    );
  }
  return { kind: "completed", activation };
}

async function completeActivationOperations(
  queryable: Queryable,
  activations: readonly AppliedKitActivation[]
): Promise<void> {
  for (const activation of activations) {
    await completeActivationOperation(queryable, activation);
  }
}

async function completeActivationOperation(
  queryable: Queryable,
  activation: AppliedKitActivation
): Promise<void> {
  const operationKey = kitOperationKey(
    activation.equipment.playerId,
    activation.requestId
  );
  const result = await queryable.query(
    `UPDATE combat_kit_operations
     SET result = $2::jsonb, completed_at = now()
     WHERE operation_key = $1
       AND action = 'activate'
       AND completed_at IS NULL
     RETURNING operation_key`,
    [operationKey, JSON.stringify({ ...activation, replayed: false })]
  );
  if (result.rowCount) return;

  const existing = await queryable.query<KitOperationRow>(
    `SELECT player_id, request_id, action, kit_index,
            true AS payload_matches, result, completed_at
     FROM combat_kit_operations
     WHERE operation_key = $1`,
    [operationKey]
  );
  const row = existing.rows[0];
  const stored = row?.completed_at ? storedActivationResult(row.result) : null;
  if (
    !row ||
    row.player_id !== activation.equipment.playerId ||
    row.request_id !== activation.requestId ||
    row.action !== "activate" ||
    row.kit_index !== activation.kitIndex ||
    !stored ||
    stored.inventoryRevision !== activation.inventoryRevision ||
    stored.activeRevision !== activation.activeRevision ||
    stored.activationTick !== activation.activationTick
  ) {
    throw new EquipmentError(
      "EQUIPMENT_IDEMPOTENCY_CONFLICT",
      "Combat-kit activation completion conflicts with durable operation history"
    );
  }
}

async function reserveKitOperation(
  queryable: Queryable,
  operationKey: string,
  playerId: string,
  requestId: string,
  action: KitOperationAction,
  kitIndex: CombatKitIndex | null,
  payload: Record<string, unknown>
): Promise<EquipmentOperationResult | null> {
  const payloadJson = JSON.stringify(payload);
  const reserved = await queryable.query(
    `INSERT INTO combat_kit_operations (
       operation_key, player_id, request_id, action, kit_index, payload
     ) VALUES ($1,$2,$3,$4,$5,$6::jsonb)
     ON CONFLICT (operation_key) DO NOTHING
     RETURNING operation_key`,
    [operationKey, playerId, requestId, action, kitIndex, payloadJson]
  );
  if (reserved.rowCount) return null;
  const existing = await queryable.query<KitOperationRow>(
    `SELECT player_id, request_id, action, kit_index,
            payload = $2::jsonb AS payload_matches,
            result, completed_at
     FROM combat_kit_operations
     WHERE operation_key = $1`,
    [operationKey, payloadJson]
  );
  const row = existing.rows[0];
  if (
    !row ||
    row.player_id !== playerId ||
    row.request_id !== requestId ||
    row.action !== action ||
    row.kit_index !== kitIndex ||
    !row.payload_matches
  ) {
    throw new EquipmentError(
      "EQUIPMENT_IDEMPOTENCY_CONFLICT",
      "Combat-kit request ID was reused with different intent"
    );
  }
  const equipment = storedKitOperationSnapshot(row.result);
  if (!row.completed_at || !equipment) {
    throw new EquipmentError(
      "EQUIPMENT_OPERATION_INCOMPLETE",
      "Combat-kit operation exists without a completed result"
    );
  }
  return { applied: false, replayed: true, equipment };
}

async function completeKitOperation(
  queryable: Queryable,
  operationKey: string,
  result: EquipmentOperationResult
): Promise<void> {
  await queryable.query(
    `UPDATE combat_kit_operations
     SET result = $2::jsonb, completed_at = now()
     WHERE operation_key = $1`,
    [operationKey, JSON.stringify(result)]
  );
}

async function assertLegacyOperation(
  queryable: Queryable,
  operationKey: string,
  playerId: string,
  action: LegacyOperationRow["action"],
  instanceId: string | null,
  slot: EquipmentSlot | null
): Promise<LegacyOperationRow> {
  const existing = await queryable.query<LegacyOperationRow>(
    `SELECT player_id, action, instance_id::text, requested_slot, result, completed_at
     FROM equipment_operations
     WHERE operation_key = $1`,
    [operationKey]
  );
  const row = existing.rows[0];
  if (
    !row ||
    row.player_id !== playerId ||
    row.action !== action ||
    row.instance_id !== instanceId ||
    row.requested_slot !== slot
  ) {
    throw new EquipmentError(
      "EQUIPMENT_IDEMPOTENCY_CONFLICT",
      "Equipment request ID was reused with different intent"
    );
  }
  return row;
}

async function insertAuditEvent(
  queryable: Queryable,
  input: {
    operationKey: string;
    playerId: string;
    eventType:
      | "equipment_upgraded"
      | "combat_kit_saved"
      | "combat_kit_renamed"
      | "combat_kit_cleared"
      | "readied_weapon_changed"
      | "active_loadout_checkpointed";
    instanceId: string | null;
    kitIndex: CombatKitIndex | null;
    equipment: Pick<EquipmentSnapshotV2, "inventoryRevision" | "activeRevision">;
    details: Record<string, unknown>;
  }
): Promise<void> {
  const details = JSON.stringify(input.details);
  if (Buffer.byteLength(details, "utf8") > EQUIPMENT_AUDIT_DETAILS_LIMIT_BYTES) {
    throw new EquipmentError(
      "EQUIPMENT_INVALID_REQUEST",
      "Equipment audit details exceed the bounded database payload"
    );
  }
  await queryable.query(
    `INSERT INTO equipment_audit_events (
       operation_key, player_id, event_type, instance_id, kit_index,
       inventory_revision, active_revision, details
     ) VALUES ($1,$2,$3,$4,$5,$6::bigint,$7::bigint,$8::jsonb)
     ON CONFLICT (operation_key, event_type) DO NOTHING`,
    [
      input.operationKey,
      input.playerId,
      input.eventType,
      input.instanceId,
      input.kitIndex,
      String(input.equipment.inventoryRevision),
      String(input.equipment.activeRevision),
      details
    ]
  );
}

function activeIdsFromRows(
  rows: EquipmentRow[],
  playerId: string
): EquipmentSlotRecord<string | null> {
  const active = emptyEquipmentSlots<string | null>(null);
  const seen = new Set<string>();
  for (const row of rows) {
    if (
      row.owner_player_id !== playerId ||
      row.location !== "equipped" ||
      !row.equipped_slot ||
      row.equipped_slot === "weapon" ||
      seen.has(row.instance_id)
    ) {
      continue;
    }
    const definition = requireEquipmentDefinition(row.definition_id);
    if (!isEquipmentCategoryAllowedInSlot(definition.category, row.equipped_slot)) continue;
    if (active[row.equipped_slot]) continue;
    active[row.equipped_slot] = row.instance_id;
    seen.add(row.instance_id);
  }
  return active;
}

/** Carried instances: `base`'s, minus any no longer carried in `fresh`, with utility items and new items from `fresh`. */
function carriedInstancesFrom(base: EquipmentSnapshotV2, fresh: EquipmentSnapshotV2): EquipmentInstanceV2[] {
  const durable = new Set(fresh.instances.map((instance) => instance.instanceId));
  const known = new Set(base.instances.map((instance) => instance.instanceId));
  return [
    ...base.instances.filter((instance) =>
      !isUtilityGearDefinitionId(instance.definitionId) && durable.has(instance.instanceId)),
    ...fresh.instances.filter((instance) =>
      isUtilityGearDefinitionId(instance.definitionId) || !known.has(instance.instanceId))
  ];
}

/** `base`'s worn ids, with utility slots taken from `fresh` and items no longer carried removed. */
function carriedSelectionFrom(base: EquipmentSnapshotV2, fresh: EquipmentSnapshotV2): EquipmentSlotRecord<string | null> {
  const known = new Set(carriedInstancesFrom(base, fresh).map((instance) => instance.instanceId));
  const selection = activeIdsFromSnapshot(base);
  for (const slot of EQUIPMENT_SLOTS) {
    const current = base.active[slot];
    const durable = fresh.active[slot];
    const durableUtility = durable && isUtilityGearDefinitionId(durable.definitionId) ? durable.instanceId : null;
    if ((current && isUtilityGearDefinitionId(current.definitionId)) || (!current && durableUtility)) {
      selection[slot] = durableUtility;
    }
    if (selection[slot] && !known.has(selection[slot]!)) selection[slot] = null;
  }
  return selection;
}

/**
 * `base` with its carried items brought up to date from the durable `fresh` snapshot (see
 * `carriedInstancesFrom`). Every other slot, the readied weapon and the active kit stay as in `base`.
 */
function withCarriedStateFrom(
  base: EquipmentSnapshotV2,
  fresh: EquipmentSnapshotV2,
  activeRevision: number,
  checkpointRevision: number,
  context: EquipmentRuntimeContext
): EquipmentSnapshotV2 {
  return rebuildSnapshot(
    {
      ...base,
      instances: carriedInstancesFrom(base, fresh),
      inventoryRevision: Math.max(base.inventoryRevision, fresh.inventoryRevision)
    },
    carriedSelectionFrom(base, fresh),
    base.readiedWeaponSlot,
    base.activeKitIndex,
    activeRevision,
    checkpointRevision,
    context
  );
}

function activeIdsFromSnapshot(
  snapshot: EquipmentSnapshotV2
): EquipmentSlotRecord<string | null> {
  return Object.fromEntries(
    EQUIPMENT_SLOTS.map((slot) => [slot, snapshot.active[slot]?.instanceId ?? null])
  ) as EquipmentSlotRecord<string | null>;
}

function overrideFromSnapshot(snapshot: EquipmentSnapshotV2): SnapshotOverride {
  return {
    activeInstanceIds: activeIdsFromSnapshot(snapshot),
    readiedWeaponSlot: snapshot.readiedWeaponSlot,
    activeKitIndex: snapshot.activeKitIndex,
    activeRevision: snapshot.activeRevision,
    checkpointRevision: snapshot.checkpointRevision
  };
}

function checkpointFromSnapshot(
  snapshot: EquipmentSnapshotV2,
  activations: readonly AppliedKitActivation[] = []
): EquipmentCheckpoint {
  const activeInstanceIds = emptyEquipmentSlots<string | null>(null);
  for (const slot of EQUIPMENT_SLOTS) {
    const item = snapshot.active[slot];
    activeInstanceIds[slot] = item?.instanceId ?? null;
  }
  return deepFreeze({
    playerId: snapshot.playerId,
    inventoryRevision: snapshot.inventoryRevision,
    activeRevision: snapshot.activeRevision,
    activeKitIndex: snapshot.activeKitIndex,
    readiedWeaponSlot: snapshot.readiedWeaponSlot,
    activeInstanceIds,
    activations: [...activations]
  });
}

function appendCheckpointActivation(
  activations: readonly AppliedKitActivation[],
  activation: AppliedKitActivation
): readonly AppliedKitActivation[] {
  const withoutReplay = activations.filter(
    (entry) => entry.requestId !== activation.requestId
  );
  return [...withoutReplay, activation];
}

function assertActivationIntent(
  activation: Pick<
    StagedKitActivation,
    "kitIndex" | "inventoryRevision"
  >,
  kitIndex: CombatKitIndex,
  inventoryRevision: number
): void {
  if (
    activation.kitIndex !== kitIndex ||
    activation.inventoryRevision !== inventoryRevision
  ) {
    throw new EquipmentError(
      "EQUIPMENT_IDEMPOTENCY_CONFLICT",
      "Combat-kit activation request ID was reused with different intent"
    );
  }
}

function rememberCompletedActivation(
  completed: Map<string, AppliedKitActivation>,
  activation: AppliedKitActivation
): void {
  completed.set(activation.requestId, activation);
  while (completed.size > COMPLETED_ACTIVATION_LIMIT) {
    const oldest = completed.keys().next().value as string | undefined;
    if (!oldest) break;
    completed.delete(oldest);
  }
}

function storedSnapshot(value: unknown): EquipmentSnapshotV2 | null {
  return isRecord(value) && value.snapshotVersion === 2
    ? value as EquipmentSnapshotV2
    : null;
}

function storedKitOperationSnapshot(value: unknown): EquipmentSnapshotV2 | null {
  if (!isRecord(value)) return null;
  return storedSnapshot(value.equipment);
}

function storedActivationResult(value: unknown): AppliedKitActivation | null {
  if (
    !isRecord(value) ||
    typeof value.requestId !== "string" ||
    typeof value.kitIndex !== "number" ||
    typeof value.inventoryRevision !== "number" ||
    typeof value.activeRevision !== "number" ||
    typeof value.activationTick !== "number" ||
    !storedSnapshot(value.equipment) ||
    !isRecord(value.derivedStats)
  ) {
    return null;
  }
  try {
    requireRequestId(value.requestId);
    requireKitIndex(value.kitIndex);
    requireRevision(value.inventoryRevision, "stored inventory revision");
    requireRevision(value.activeRevision, "stored active revision");
    requireRevision(value.activationTick, "stored activation tick");
  } catch {
    return null;
  }
  return value as AppliedKitActivation;
}

function storedUpgradeResult(value: unknown): EquipmentUpgradeResult | null {
  if (!isRecord(value) || !storedSnapshot(value.equipment)) return null;
  if (
    typeof value.instanceId !== "string" ||
    typeof value.levelBefore !== "number" ||
    typeof value.levelAfter !== "number" ||
    typeof value.goldCost !== "string" ||
    typeof value.balanceVersion !== "number" ||
    typeof value.goldBalance !== "string"
  ) {
    return null;
  }
  return value as EquipmentUpgradeResult;
}

type StoredAcquisitionResult = Pick<
  EquipmentAcquisitionResult,
  "definitionId" | "instanceId" | "materialCosts" | "goldCost" | "message"
>;

function storedAcquisitionResult(value: unknown): StoredAcquisitionResult | null {
  if (
    !isRecord(value) ||
    typeof value.definitionId !== "string" ||
    typeof value.instanceId !== "string" ||
    !Array.isArray(value.materialCosts) ||
    typeof value.goldCost !== "string" ||
    typeof value.message !== "string"
  ) return null;
  try {
    const definition = requireEquipmentDefinition(value.definitionId);
    const materialCosts = value.materialCosts.map((candidate) => {
      if (
        !isRecord(candidate) ||
        typeof candidate.itemId !== "string" ||
        !RESOURCE_TYPES.includes(candidate.itemId as ResourceType) ||
        typeof candidate.quantity !== "number" ||
        !Number.isSafeInteger(candidate.quantity) ||
        candidate.quantity <= 0
      ) throw new Error("invalid material cost");
      return {
        itemId: candidate.itemId as ResourceType,
        quantity: candidate.quantity
      };
    });
    if (!/^(0|[1-9][0-9]{0,18})$/u.test(value.goldCost)) return null;
    return {
      definitionId: definition.definitionId,
      instanceId: value.instanceId,
      materialCosts,
      goldCost: value.goldCost,
      message: value.message
    };
  } catch {
    return null;
  }
}

function storedDeathWearResult(value: unknown): Readonly<{
  changed: boolean;
  brokenCount: number;
  equipment: EquipmentSnapshotV2;
  message: string | null;
}> | null {
  if (!isRecord(value) || typeof value.changed !== "boolean" ||
      typeof value.brokenCount !== "number" || !storedSnapshot(value.equipment) ||
      (value.message !== null && typeof value.message !== "string")) return null;
  return value as Readonly<{
    changed: boolean;
    brokenCount: number;
    equipment: EquipmentSnapshotV2;
    message: string | null;
  }>;
}

function storedRepairResult(value: unknown): Pick<
  EquipmentRepairResult,
  "instanceId" | "conditionBefore" | "conditionAfter" | "materialCosts" | "message"
> | null {
  if (!isRecord(value) || typeof value.instanceId !== "string" ||
      typeof value.conditionBefore !== "number" || typeof value.conditionAfter !== "number" ||
      !Array.isArray(value.materialCosts) || typeof value.message !== "string") return null;
  try {
    const materialCosts = value.materialCosts.map((candidate) => {
      if (!isRecord(candidate) || typeof candidate.itemId !== "string" ||
          !RESOURCE_TYPES.includes(candidate.itemId as ResourceType) ||
          typeof candidate.quantity !== "number" || !Number.isSafeInteger(candidate.quantity) ||
          candidate.quantity <= 0) throw new Error("invalid material cost");
      return { itemId: candidate.itemId as ResourceType, quantity: candidate.quantity };
    });
    return {
      instanceId: value.instanceId,
      conditionBefore: clampEquipmentCondition(value.conditionBefore),
      conditionAfter: clampEquipmentCondition(value.conditionAfter),
      materialCosts,
      message: value.message
    };
  } catch {
    return null;
  }
}

function storedRepairKitCraftResult(value: unknown): Pick<
  RepairKitCraftResult,
  "quantity" | "materialCosts" | "message"
> | null {
  if (!isRecord(value) || value.quantity !== 1 || !Array.isArray(value.materialCosts) ||
      typeof value.message !== "string") return null;
  try {
    const materialCosts = value.materialCosts.map((candidate) => {
      if (!isRecord(candidate) || typeof candidate.itemId !== "string" ||
          !RESOURCE_TYPES.includes(candidate.itemId as ResourceType) ||
          typeof candidate.quantity !== "number" || !Number.isSafeInteger(candidate.quantity) ||
          candidate.quantity <= 0) throw new Error("invalid material cost");
      return { itemId: candidate.itemId as ResourceType, quantity: candidate.quantity };
    });
    return { quantity: 1, materialCosts, message: value.message };
  } catch {
    return null;
  }
}

async function ensureEquipmentRepairMaterials(
  queryable: Queryable,
  playerId: string,
  materials: readonly { itemId: ResourceType; quantity: number }[]
): Promise<void> {
  const available = await queryable.query<{ resource_type: string; quantity: string }>(
    `SELECT resource_type,quantity::text
     FROM player_inventory
     WHERE player_id=$1
       AND variant=$2
       AND resource_type=ANY($3::text[])
     ORDER BY resource_type
     FOR UPDATE`,
    [playerId, DEFAULT_INVENTORY_VARIANT, materials.map(({ itemId }) => itemId)]
  );
  const quantities = new Map(
    available.rows.map((row) => [row.resource_type, BigInt(row.quantity)])
  );
  const missing = materials.find(
    ({ itemId, quantity }) => (quantities.get(itemId) ?? 0n) < BigInt(quantity)
  );
  if (missing) {
    throw new EquipmentError(
      "EQUIPMENT_REPAIR_MATERIALS_REQUIRED",
      `Repair requires ${missing.quantity} ${missing.itemId.replaceAll("_", " ")}`
    );
  }
}

async function currentWallet(
  queryable: Queryable,
  actor: EquipmentActor
): Promise<{ gold: string; version: string }> {
  const result = await queryable.query<{ gold: string; version: string }>(
    `SELECT gold_balance::text AS gold,version::text
     FROM player_wallets
     WHERE player_id=$1 AND account_id=$2`,
    [actor.playerId, actor.accountId]
  );
  const row = result.rows[0];
  if (!row) {
    throw new EquipmentError(
      "EQUIPMENT_OPERATION_INCOMPLETE",
      "Equipment purchase wallet is unavailable"
    );
  }
  return row;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalKitIndex(value: number | null): CombatKitIndex | null {
  return value === null ? null : requireKitIndex(value);
}

function requireKitIndex(value: number): CombatKitIndex {
  if (!COMBAT_KIT_INDICES.includes(value as CombatKitIndex)) {
    throw new EquipmentError(
      "EQUIPMENT_INVALID_REQUEST",
      "Combat-kit index must be between 1 and 6"
    );
  }
  return value as CombatKitIndex;
}

function requireRequestId(requestId: string): void {
  requireIdentifier(requestId, "request ID", 128);
}

function requireIdentifier(value: string, label: string, maximumLength: number): void {
  if (!value || value.length > maximumLength) {
    throw new EquipmentError(
      "EQUIPMENT_INVALID_REQUEST",
      `${label} is required and must contain at most ${maximumLength} characters`
    );
  }
}

function requireRevision(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new EquipmentError(
      "EQUIPMENT_INVALID_REQUEST",
      `${label} must be a nonnegative safe integer`
    );
  }
  return value;
}

function databaseRevision(value: string | number, label: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new EquipmentError(
      "EQUIPMENT_OPERATION_INCOMPLETE",
      `Database ${label} exceeds the supported runtime range`
    );
  }
  return parsed;
}

function staleInventoryError(expected: number, current: number): EquipmentError {
  return new EquipmentError(
    "EQUIPMENT_STALE_INVENTORY_REVISION",
    `Expected inventory revision ${expected}, current revision is ${current}`
  );
}

function kitOperationKey(playerId: string, requestId: string): string {
  const requestHash = createHash("sha256").update(requestId).digest("hex");
  return `combat-kit:${playerId}:${requestHash}`;
}

function sameRuntimeContext(
  left: EquipmentRuntimeContext,
  right: EquipmentRuntimeContext
): boolean {
  return (
    left.context === right.context &&
    left.characterLevel === right.characterLevel &&
    left.classId === right.classId &&
    left.classRank === right.classRank
  );
}

function deepFreeze<Value>(value: Value): Value {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}
