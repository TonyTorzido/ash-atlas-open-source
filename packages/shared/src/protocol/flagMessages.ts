import type {
  PlayerInventorySnapshot,
  ResourceType
} from "../collectibles.js";
import type { FlagReinforcementTarget, FlagSnapshot } from "../types.js";
import type { PersonalAnchorKind } from "../types.js";

export type FlagBuildMaterial = Readonly<{
  itemId: ResourceType;
  quantity: number;
}>;

type FlagSnapshotAuthorityBase = Readonly<{
  connectionId: string;
  connectionGeneration: number;
  scopeId: string;
  snapshotId: string;
  chunkIndex: number;
  chunkCount?: number;
  finalChunk: boolean;
}>;

export type FlagSnapshotAuthority =
  | (FlagSnapshotAuthorityBase & Readonly<{
      scopeKind: "global-flags";
    }>)
  | (FlagSnapshotAuthorityBase & Readonly<{
      scopeKind: "gameplay-circle-flags";
      relocationRevision: number;
      gameplayViewGeneration: number;
    }>);

export function gameplayCircleFlagScopeId(input: Readonly<{
  relocationRevision: number;
  gameplayViewGeneration: number;
}>): string {
  return [
    "gameplay-circle-flags",
    input.relocationRevision,
    input.gameplayViewGeneration
  ].join(":");
}

export type FlagServerMessage =
  | {
      type: "FLAGS_SNAPSHOT";
      flags: FlagSnapshot[];
      flagSetRevision?: number;
      complete?: boolean;
      truncated?: boolean;
      authority?: FlagSnapshotAuthority;
    }
  | {
      type: "FLAG_BUILD_QUEUED";
      buildId: string;
      requestId: string;
      queuedAt: number;
      anchorKind?: PersonalAnchorKind;
      flagName?: string;
    }
  | {
      type: "FLAG_BUILD_STARTED";
      buildId: string;
      requestId: string;
      startedAt: number;
      completesAt: number;
      durationMs: number;
      serverTime: number;
      position: { lat: number; lon: number };
      anchorKind?: PersonalAnchorKind;
      flagName?: string;
    }
  | { type: "FLAG_BUILD_CANCELLED"; buildId: string; requestId: string; reason: string; serverTime: number }
  | {
      type: "FLAG_REINFORCEMENT_STARTED";
      requestId: string;
      flagId: string;
      flagName: string;
      startedAt: number;
      completesAt: number;
      durationMs: number;
      serverTime: number;
      position: { lat: number; lon: number };
      targetTier: FlagReinforcementTarget;
      targetTowerLevel?: number;
    }
  | { type: "FLAG_REINFORCEMENT_CANCELLED"; requestId: string; flagId: string; reason: string; serverTime: number }
  | {
      type: "FLAG_BURN_STARTED";
      operationId: string;
      requestId: string;
      flagId: string;
      flagName: string;
      startedAt: number;
      completesAt: number;
      durationMs: number;
      serverTime: number;
      position: { lat: number; lon: number };
    }
  | {
      type: "FLAG_BURN_CANCELLED";
      operationId: string;
      requestId: string;
      flagId: string;
      reason: string;
      serverTime: number;
    }
  | {
      type: "FLAG_BURN_NOTICE";
      operationId: string;
      flagId: string;
      flagName: string;
      message: string;
      completesAt: number;
      serverTime: number;
    }
  | {
      type: "FLAG_REPAIR_STARTED";
      operationId: string;
      requestId: string;
      flagId: string;
      ownerId: string;
      flagName: string;
      startedAt: number;
      completesAt: number;
      durationMs: number;
      pausedBurnRemainingMs: number;
      repairKitQuantity: number;
      stoneQuantity: number;
      serverTime: number;
      position: { lat: number; lon: number };
    }
  | {
      type: "FLAG_REPAIR_CANCELLED";
      operationId: string;
      requestId: string;
      flagId: string;
      reason: string;
      serverTime: number;
    }
  | {
      type: "FLAG_REPAIRED";
      operationId: string;
      requestId: string;
      flag: FlagSnapshot;
      inventory: PlayerInventorySnapshot;
      replayed: boolean;
      serverTime: number;
    }
  | {
      type: "FLAG_REPAIR_DISRUPT_STARTED";
      operationId: string;
      requestId: string;
      flagId: string;
      repairOperationId: string;
      startedAt: number;
      completesAt: number;
      durationMs: number;
      serverTime: number;
      position: { lat: number; lon: number };
    }
  | {
      type: "FLAG_REPAIR_DISRUPT_CANCELLED";
      operationId: string;
      requestId: string;
      flagId: string;
      reason: string;
      serverTime: number;
    }
  | {
      type: "FLAG_REPAIR_DISRUPTED";
      operationId: string;
      requestId: string;
      flagId: string;
      repairOperationId: string;
      replayed: boolean;
      serverTime: number;
    }
  | {
      type: "TORCHES_CRAFTED";
      requestId: string;
      quantity: number;
      replayed: boolean;
      inventory: PlayerInventorySnapshot;
    }
  | {
      type: "FLAG_CREATED";
      requestId?: string;
      buildId?: string;
      flag: FlagSnapshot;
      warning?: string;
      serverTime?: number;
      inventory?: PlayerInventorySnapshot;
      consumedMaterials?: FlagBuildMaterial[];
      recoveredMaterials?: FlagBuildMaterial[];
      flagSetRevision?: number;
    }
  | { type: "FLAG_UPSERTED"; flag: FlagSnapshot; serverTime: number; flagSetRevision?: number }
  | { type: "FLAG_REINFORCED"; requestId: string; flag: FlagSnapshot; inventory: PlayerInventorySnapshot; replayed: boolean; flagSetRevision?: number }
  | {
      type: "FLAG_DELETED";
      flagId: string;
      reason?: "deleted" | "transformed" | "destroyed";
      inventory?: PlayerInventorySnapshot;
      flagSetRevision?: number;
    }
  | { type: "FLAG_UPDATED"; flag: FlagSnapshot; flagSetRevision?: number }
  | {
      /** One batch of a territory collapse wave (or a cut-off break): remove all listed flags. */
      type: "FLAGS_COLLAPSED";
      flagIds: string[];
      collapseId: string | null;
      reason: string;
      completed: boolean;
      flagSetRevision?: number;
    }
  | {
      /** Sent once to affected players when a city or kingdom falls. */
      type: "TERRITORY_COLLAPSE_STARTED";
      collapseId: string;
      kind: "city" | "kingdom";
      name: string;
      reason: string;
      flagCount: number;
    }
  | { type: "FLAG_ACCESS_CHANGED"; flagId: string; message: string; flagSetRevision?: number };
