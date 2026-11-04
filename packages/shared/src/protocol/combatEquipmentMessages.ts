import type { ClassId, ClassSnapshot, SubclassId } from "../classes.js";
import type {
  ClassCombatState,
  CombatStateBatch,
  PveCombatSessionSnapshot
} from "../combat.js";
import type {
  CombatKitIndex,
  CombatKitInvalidReason,
  EquipmentDefinitionId,
  EquipmentSnapshotV2
} from "../equipment.js";
import type { AchievementSnapshot } from "../achievements.js";
import type { RingDefinitionId, RingTier } from "../rings.js";
import type { GearScrollsSnapshot } from "../gearScrolls.js";

import type { MasterySnapshot } from "../masteries.js";
import type { ProgressionSnapshot, XpGrantResult } from "../progression.js";
import type { PremiumWalletSnapshot } from "../premiumCurrency.js";
import type { PvpTimerEntry } from "../pvpTimers.js";
import type { PlayerInventorySnapshot, ResourceType } from "../collectibles.js";
import type { WorldViewAuthority } from "../worldView.js";
import type { DroppedItemSnapshot } from "../droppedItems.js";
import type { DeathDropSummary } from "../deathBackpackDrop.js";

export type XoralRingDropSnapshot = Readonly<{
  dropId: string;
  eventId: string;
  ringDefinitionId: "ring_plain" | "chopping_ring" | "mining_ring" | "attack_ring";
  regionCode: string;
  zoneId: string;
  lat: number;
  lon: number;
  createdAt: string;
}>;

export type CombatEquipmentServerMessage =
  | {
      type: "COMBAT_SNAPSHOT";
      state: CombatStateBatch;
      worldViewAuthority?: WorldViewAuthority;
      combatSnapshotGeneration?: number;
    }
  | { type: "COMBAT_DELTA"; state: CombatStateBatch }
  | { type: "COMBAT_STARTED"; requestId: string; attackerEntityId: string; targetEntityId: string }
  | {
      type: "XORAL_EVENT_STARTED";
      requestId: string;
      eventId: string;
      xoralEntityId: string;
      participantPlayerIds: string[];
    }
  | {
      type: "XORAL_REWARD_GRANTED";
      eventId: string;
      ringDefinitionId: "ring_plain" | "chopping_ring" | "mining_ring" | "attack_ring";
      ringDelivery: "inventory" | "ground";
      gold: number;
      walletGold: string;
      walletVersion: string;
      xp: number;
      classXp: number;
    }
  | {
      /** Batched, rate-limited: Gold a land owner's territory earned from other players' hunting. */
      type: "LAND_BONUS_EARNED";
      gold: number;
      kills: number;
      walletGold: string;
      walletVersion: string;
    }
  | {
      type: "XORAL_EVENT_CANCELLED";
      eventId: string;
      reason: string;
    }
  | {
      type: "LEGENDARY_EVENT_ALERT";
      eventId: string;
      birdSpecies: "fire" | "lightning" | "ice";
      flagId: string;
      message: string;
      selectedAt: string;
      expiresAt: string;
    }
  | {
      type: "XORAL_PARTICIPANT_EXITED";
      requestId: string;
      eventId: string;
      reason: string;
    }
  | { type: "XORAL_RING_DROPS_SNAPSHOT"; drops: XoralRingDropSnapshot[] }
  | {
      type: "XORAL_RING_DROP_PICKED_UP";
      requestId: string;
      dropId: string;
      equipment: EquipmentSnapshotV2;
    }
  | { type: "COMBAT_CANCELLED"; requestId: string; entityId: string }
  | {
      type: "COMBAT_REWARD_GRANTED";
      settlementKey: string;
      playerId: string;
      items: Array<{ itemId: ResourceType; quantity: number }>;
      drops: DroppedItemSnapshot[];
      gold: number;
      /** Defeated mob's display name and boss flag, so the client can title the loot card. */
      mobName?: string;
      boss?: boolean;
      walletGold?: string;
      walletVersion?: string;
      inventory: PlayerInventorySnapshot;
      cityCoins: number;
      cityId: string | null;
      cityTreasuryBalance: string | null;
      cityContribution: string | null;
      /** Rings found on the kill (the bag first, else the loot pile). */
      rings?: Array<{ definitionId: RingDefinitionId; onGround: boolean; lost?: boolean }>;
    }
  | {
      type: "PROGRESSION_SNAPSHOT";
      progression: ProgressionSnapshot;
      deathPenalty?: { operationKey: string; deathDrop?: DeathDropSummary; xpLost: number };
    }
  | {
      /** PvP timers this player is part of; walletGold rides along after a PvP death's gold transfer. */
      type: "PVP_STATUS";
      timers: PvpTimerEntry[];
      serverTime: number;
      notice?: string;
      walletGold?: string;
      walletVersion?: string;
    }
  | { type: "MASTERY_SNAPSHOT"; masteries: MasterySnapshot }
  | { type: "CLASS_SNAPSHOT"; requestId?: string; snapshot: ClassSnapshot }
  | {
      type: "DEV_PROGRESSION_ADJUSTED";
      operationId: string;
      replayed: boolean;
      classSnapshot: ClassSnapshot;
      progression: ProgressionSnapshot;
      masteries?: MasterySnapshot;
    }
  | { type: "CLASS_MUTATION_CONFIRMED"; requestId: string; replayed: boolean; snapshot: ClassSnapshot; walletGold?: string; walletVersion?: string }
  | {
      type: "ABILITY_QUEUE_UPDATED";
      requestId: string;
      classCombat: ClassCombatState | null;
      pveCombat: PveCombatSessionSnapshot | null;
    }
  | {
      type: "CLASS_MASTERY_GRANTED";
      eventId: string;
      classId: ClassId;
      subclassId: SubclassId | null;
      requestedXp: number;
      grantedXp: number;
      replayed: boolean;
      previousRank: number;
      resultingRank: number;
      snapshot: ClassSnapshot;
    }
  | { type: "XP_GRANTED"; grant: XpGrantResult }
  | {
      type: "LEVEL_UP";
      level: number;
      progression: ProgressionSnapshot;
      /** Set on the answer to CONFIRM_LEVEL_UP (a paid Glimmer level-up). */
      requestId?: string;
      replayed?: boolean;
      premiumWallet?: PremiumWalletSnapshot;
    }
  | { type: "EQUIPMENT_SNAPSHOT"; equipment: EquipmentSnapshotV2 }
  | { type: "ACHIEVEMENT_SNAPSHOT"; achievements: AchievementSnapshot }
  | { type: "ACHIEVEMENT_UNLOCKED"; achievementId: "bitter_blood"; title: string; achievements: AchievementSnapshot }
  | { type: "EQUIPMENT_UPDATED"; requestId: string; replayed: boolean; equipment: EquipmentSnapshotV2; progression: ProgressionSnapshot }
  | {
      type: "EQUIPMENT_UPGRADE_RESULT";
      requestId: string;
      replayed: boolean;
      instanceId: string;
      levelBefore: number;
      levelAfter: number;
      goldCost: string;
      balanceVersion: number;
      goldBalance: string;
      equipment: EquipmentSnapshotV2;
    }
  | {
      type: "EQUIPMENT_ACQUIRED";
      requestId: string;
      action: "craft" | "limited_purchase";
      replayed: boolean;
      definitionId: EquipmentDefinitionId;
      instanceId: string;
      materialCosts: Array<{ itemId: ResourceType; quantity: number }>;
      goldCost: string;
      walletGold?: string;
      walletVersion?: string;
      inventory: PlayerInventorySnapshot;
      equipment: EquipmentSnapshotV2;
      message: string;
    }
  | {
      type: "EQUIPMENT_REPAIRED";
      requestId: string;
      replayed: boolean;
      instanceId: string;
      conditionBefore: number;
      conditionAfter: number;
      materialCosts: Array<{ itemId: ResourceType; quantity: number }>;
      inventory: PlayerInventorySnapshot;
      equipment: EquipmentSnapshotV2;
      message: string;
    }
  | {
      type: "GEAR_SCROLLS_STATE";
      requestId: string | null;
      action: "snapshot" | "craft" | "remember" | "equip";
      replayed?: boolean;
      /** A newer swap request replaced this one before it ran. */
      superseded?: boolean;
      position?: number;
      equipped?: number;
      skipped?: number;
      /** Omitted on swaps to keep them small. */
      gearScrolls?: GearScrollsSnapshot;
      inventory?: PlayerInventorySnapshot;
      equipment?: EquipmentSnapshotV2;
    }
  | {
      type: "RING_OPERATION_RESULT";
      requestId: string;
      replayed: boolean;
      action: "polish" | "dump";
      instanceId: string;
      tier: RingTier;
      oilSpent: number;
      shardsGranted: number;
      inventory: PlayerInventorySnapshot;
      equipment: EquipmentSnapshotV2;
      message: string;
    }
  | {
      type: "REPAIR_KIT_CRAFTED";
      requestId: string;
      replayed: boolean;
      quantity: number;
      materialCosts: Array<{ itemId: ResourceType; quantity: number }>;
      inventory: PlayerInventorySnapshot;
      equipment: EquipmentSnapshotV2;
      message: string;
    }
  | { type: "COMBAT_KIT_SNAPSHOT"; requestId?: string; equipment: EquipmentSnapshotV2 }
  | {
      type: "COMBAT_KIT_ACTIVATED";
      requestId: string;
      kitIndex: CombatKitIndex;
      inventoryRevision: number;
      activeRevision: number;
      activationTick: number;
      replayed: boolean;
      equipment: EquipmentSnapshotV2;
    }
  | {
      type: "COMBAT_KIT_INVALIDATED";
      requestId?: string;
      kitIndex: CombatKitIndex;
      reason: CombatKitInvalidReason;
      equipment: EquipmentSnapshotV2;
    };
