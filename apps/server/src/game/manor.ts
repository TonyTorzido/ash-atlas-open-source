import {
  advanceIndoorVector,
  getBackpackWeightGrams,
  findIndoorNavigationRoute,
  isIndoorNavigationPointInsideWalkableSurface,
  isIndoorNavigationPointWalkable,
  interactionInRange,
  interiorNavigation,
  MANOR_BUILD_WOOD_COST,
  MANOR_KICK_REENTRY_LOCK_MS,
  MANOR_FLOOR_SIZE,
  MANOR_MAX_TARGET_DISTANCE,
  MANOR_MOVE_SPEED,
  MANOR_PLAYER_RADIUS,
  MANOR_SPAWN,
  MANOR_ENTRANCE_SPACE_ID,
  MANOR_STORAGE_UPGRADES,
  MANOR_STORAGE_UPGRADE_MAX_LEVEL,
  manorStorageCapacityForLevel,
  manorStorageUpgradeForLevel,
  MANOR_STORAGE_UNLOCKED_SLOTS,
  MANOR_FOYER_ROOM,
  manorRoomNavigation,
  manorAuthoredRoom,
  manorInteriorRoom,
  manorAuthoredSpaceId,
  manorTypeSpace,
  DEFAULT_MANOR_TYPE_ID,
  MANOR_SKIN_ITEM_ID,
  isPurchasableManorSkin,
  manorSkinDisplayName,
  isShopCopyId,
  resolveManorTypeId,
  isManorBurnt,
  type PremiumWalletSnapshot,
  worldExitOf,
  type ManorPosition,
  type ManorBannedPlayerSnapshot,
  type ManorGuestManagementSnapshot,
  type ManorOccupantAccessSource,
  type ManorOccupantSnapshot,
  type ManorStorageSnapshot,
  type ManorStorageAction,
  type ManorStorageResult,
  type ManorStorageUpgradeResult,
  type ManorStorageUpgradeMaterialCost,
  type ManorStorageUpgradeSnapshot,
  type ManorStorageUpgradeDefinition,
  type ManorSpaceId,
  type ManorTransferSummary,
  type ManorTransferDirection,
  type ManorWorldSnapshot,
  type PlayerInventorySnapshot,
  type EquipmentSnapshotV2,
  type BackpackSnapshot,
  type IndoorPoint,
  type IndoorRoomNavigation,
  type ResourceType
} from "@ash-atlas/shared";
import { createHash, randomUUID } from "node:crypto";
import type pg from "pg";

import {
  DEFAULT_INVENTORY_VARIANT,
  InventoryService,
  isInventoryCapacityError,
  isInventoryItemEquippedError,
  inventoryWeightSnapshotInTransaction,
  MAX_SAFE_INVENTORY_QUANTITY,
  inventoryQuantityToSafeNumber,
  lockInventoryCapacity,
  assertInventoryWeightInTransaction,
  fittingInventoryQuantityInTransaction
} from "./inventory.js";
import { EquipmentService } from "./equipment.js";
import { BackpackService } from "./backpacks.js";
import {
  lockInventoryProtection,
  materialProtectionAllocation
} from "./inventoryProtection.js";
import { requireItemDefinition, requireRuntimeItemDefinition } from "./items.js";
import { planAutomaticStackConsolidation } from "./stackConsolidation.js";
import { WalletOperationError, WalletService } from "./wallet.js";
import type { PremiumWalletService } from "./premiumWallet.js";
import type { PlayerRecord } from "./state.js";
import type { FlagService } from "./flags.js";
import {
  attackManor,
  manorCheckpointHealth,
  manorWarfareSnapshot,
  reconcileManorWarfare,
  startManorRepair,
  stopManorRepairForPlayer,
  type ManorAttackResult,
  type ManorRepairerPresence,
  type ManorWarfareCheckpointColumns,
  type ManorWarfarePlayer,
  type ManorWarfareSweep
} from "./manorWarfare.js";

type ManorRow = {
  id: string;
  owner_player_id: string;
  world_region_code: string | null;
  world_lat: number | null;
  world_lon: number | null;
  built_at: Date | string | null;
  source_flag_id: string | null;
  placement_revision: string | number;
  manor_type_id: string;
};
type ManorWorldRow = ManorRow & { owner_username: string } & Partial<ManorWarfareCheckpointColumns>;
type PresenceRow = {
  player_id: string;
  manor_id: string;
  owner_player_id: string;
  access_source: ManorOccupantAccessSource;
  admission_travel_invite_id: string | null;
  return_region_code: string;
  return_lat: number;
  return_lon: number;
  local_position_x: number | null;
  local_position_y: number | null;
  manor_type_id?: string;
};
type BanRow = {
  banned_player_id: string;
  username: string;
  display_color: string | null;
  created_at: Date | string;
};
type StackRow = {
  stack_id: string;
  manor_id: string;
  slot_index: number;
  item_id: string;
  variant: string;
  quantity: string;
  manual_split: boolean;
  version: string;
};
type OverflowStackRow = {
  stack_id: string;
  source_order: number;
  item_id: string;
  variant: string;
  quantity: string;
};
type PlayerInventoryEntryRow = {
  stack_id: string;
  player_id: string;
  resource_type: string;
  variant: string;
  quantity: string;
};
const STORAGE_STACK_SELECT = `SELECT stack.stack_id,stack.manor_id,stack.slot_index,
  stack.item_id,stack.variant,stack.quantity::text,stack.manual_split,stack.version::text`;
const PLAYER_ENTRY_SELECT = `SELECT stack.entry_id::text AS stack_id,stack.player_id,
  stack.resource_type,stack.variant,stack.quantity::text`;
type OperationRow = {
  operation_key: string;
  player_id: string;
  manor_id: string;
  request_hash: string;
  original_result: ManorStorageResult | null;
};
type PlacementOperationRow = {
  player_id: string;
  manor_id: string;
  operation_type: "build" | "destroy";
  request_hash: string;
  applied_revision: string | number;
  original_result: { manor: ManorWorldSnapshot; inventory?: PlayerInventorySnapshot } | { manorId: string; placementRevision: number };
};
type ManorStorageUpgradeOperationRow = {
  operation_key: string;
  player_id: string;
  manor_id: string;
  request_hash: string;
  target_level: number;
  original_result: ManorStorageUpgradeResult | null;
};

export class ManorError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

export type ManorPresence = {
  playerId: string;
  manorId: string;
  ownerPlayerId: string;
  accessSource: ManorOccupantAccessSource;
  admissionTravelInviteId: string | null;
  returnRegionCode: string;
  returnLat: number;
  returnLon: number;
  localPositionX: number | null;
  localPositionY: number | null;
  /** Manor type of the occupied Manor (loaded with the presence; the default type when unknown). */
  manorTypeId?: string;
};

export type ManorEntryAuthorization = {
  manor: ManorWorldSnapshot;
  accessSource: ManorOccupantAccessSource;
  travelInviteId: string | null;
};

export type ManorBuildResult = {
  manor: ManorWorldSnapshot;
  inventory: PlayerInventorySnapshot;
  replayed: boolean;
};

export type ManorStorageUpgradeInput = Readonly<{
  playerId: string;
  requestId: string;
  targetLevel: number;
}>;

export type ManorPresenceEconomyOptions = Readonly<{
  inventory?: Pick<InventoryService, "debitItemsForOperationInTransaction" | "grantItemsForOperationInTransaction" | "snapshotInTransaction">;
  wallet?: Pick<WalletService, "debitForOperationInTransaction" | "snapshotInTransaction">;
  /** Glimmer wallet for skin purchases (never credited here). */
  premium?: Pick<PremiumWalletService, "debitForOperationInTransaction" | "snapshotInTransaction">;
}>;

export type ManorDestroyResult = {
  manorId: string;
  placementRevision: number;
  ejected: ManorPresence[];
  replayed: boolean;
};

export class ManorPresenceService {
  private readonly kickLocks = new Map<string, number>();
  private readonly inventory: Pick<InventoryService, "debitItemsForOperationInTransaction" | "grantItemsForOperationInTransaction" | "snapshotInTransaction">;
  private readonly wallet: Pick<WalletService, "debitForOperationInTransaction" | "snapshotInTransaction">;
  private readonly premium: Pick<PremiumWalletService, "debitForOperationInTransaction" | "snapshotInTransaction"> | null;

  constructor(
    private readonly pool: pg.Pool,
    private readonly territoryAuthority?: Pick<FlagService, "resolveTerritoryAtPoint">,
    options: ManorPresenceEconomyOptions = {}
  ) {
    this.inventory = options.inventory ?? new InventoryService(pool);
    this.wallet = options.wallet ?? new WalletService();
    this.premium = options.premium ?? null;
  }

  async ensureManor(playerId: string): Promise<string> {
    const result = await this.pool.query<ManorRow>(
      `INSERT INTO player_manors (owner_player_id) VALUES ($1)
       ON CONFLICT (owner_player_id) DO UPDATE SET owner_player_id = EXCLUDED.owner_player_id
       RETURNING id, owner_player_id, world_region_code, world_lat, world_lon, built_at, source_flag_id, placement_revision`,
      [playerId]
    );
    return requireRow(result.rows[0], "Manor could not be created").id;
  }

  async builtManor(manorId: string): Promise<ManorWorldSnapshot | null> {
    const result = await this.pool.query<ManorWorldRow>(
      `SELECT m.id,m.owner_player_id,p.username AS owner_username,m.world_region_code,m.world_lat,m.world_lon,
              m.built_at,m.source_flag_id,m.placement_revision,m.manor_type_id,
              m.health,m.health_at,m.burning_since,m.repair_player_id
       FROM player_manors m JOIN players p ON p.id=m.owner_player_id
       WHERE m.id=$1 AND m.built_at IS NOT NULL`,
      [manorId]
    );
    return result.rows[0] ? mapWorldManor(result.rows[0]) : null;
  }

  async completedJump(playerId: string, requestId: string, manorId: string): Promise<boolean> {
    const result = await this.pool.query<{ manor_id: string }>(
      "SELECT manor_id FROM manor_jump_operations WHERE player_id=$1 AND request_id=$2",
      [playerId, requestId]
    );
    const replay = result.rows[0];
    if (!replay) return false;
    if (replay.manor_id !== manorId) {
      throw new ManorError("REPLAY_CONFLICT", "That request ID was already used for another manor jump.");
    }
    return true;
  }

  async completeJump(
    playerId: string,
    requestId: string,
    manorId: string,
    relocationRevision: number
  ): Promise<void> {
    const result = await this.pool.query<{ manor_id: string }>(
      `INSERT INTO manor_jump_operations (player_id,request_id,manor_id,relocation_revision)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (player_id,request_id) DO UPDATE
         SET player_id=manor_jump_operations.player_id
       RETURNING manor_id`,
      [playerId, requestId, manorId, relocationRevision]
    );
    if (result.rows[0]?.manor_id !== manorId) {
      throw new ManorError("REPLAY_CONFLICT", "That request ID was already used for another manor jump.");
    }
  }

  async authorizeEntry(input: {
    playerId: string;
    manorId: string;
    activePartyMember: boolean;
    activeTravelInviteId: string | null;
  }): Promise<ManorEntryAuthorization> {
    const manor = await this.builtManor(input.manorId);
    if (!manor) throw new ManorError("MANOR_NOT_BUILT", "That manor no longer exists.");
    if (isManorBurnt(manor.warfare, Date.now())) throw burntManorError();
    if (manor.ownerPlayerId === input.playerId) {
      return { manor, accessSource: "OWNER", travelInviteId: null };
    }
    const banned = await this.pool.query(
      "SELECT 1 FROM manor_bans WHERE manor_id=$1 AND banned_player_id=$2",
      [input.manorId, input.playerId]
    );
    if (banned.rowCount) throw new ManorError("MANOR_BANNED", "You are banned from this manor.");
    const kickRemainingMs = this.kickRemainingMs(input.manorId, input.playerId);
    if (kickRemainingMs > 0) {
      throw new ManorError("MANOR_TEMPORARILY_KICKED", `You may return in ${Math.ceil(kickRemainingMs / 1_000)} seconds.`);
    }
    if (input.activeTravelInviteId) {
      return {
        manor,
        accessSource: "TRAVEL_INVITE",
        travelInviteId: input.activeTravelInviteId
      };
    }
    if (input.activePartyMember) {
      return { manor, accessSource: "PARTY", travelInviteId: null };
    }
    throw new ManorError("MANOR_ACCESS_DENIED", "You do not have access to this manor.");
  }

  async enter(
    player: PlayerRecord,
    authorization?: ManorEntryAuthorization,
    beforeCommit?: (client: pg.PoolClient) => Promise<void>
  ): Promise<ManorPresence> {
    const ownedManor = authorization ? null : await this.status(player.playerId);
    if (!authorization && !ownedManor) {
      throw new ManorError("MANOR_NOT_BUILT", "Build your manor before entering it.");
    }
    const resolved = authorization ?? await this.authorizeEntry({
      playerId: player.playerId,
      manorId: ownedManor!.manorId,
      activePartyMember: false,
      activeTravelInviteId: null
    });
    if (resolved.manor.ownerPlayerId !== player.playerId) {
      const kickRemainingMs = this.kickRemainingMs(resolved.manor.manorId, player.playerId);
      if (kickRemainingMs > 0) {
        throw new ManorError("MANOR_TEMPORARILY_KICKED", `You may return in ${Math.ceil(kickRemainingMs / 1_000)} seconds.`);
      }
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [player.playerId]);
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        `manor-access:${resolved.manor.manorId}:${player.playerId}`
      ]);
      if (
        resolved.manor.ownerPlayerId !== player.playerId &&
        this.kickRemainingMs(resolved.manor.manorId, player.playerId) > 0
      ) {
        throw new ManorError("MANOR_TEMPORARILY_KICKED", "You were recently removed from this manor.");
      }
      const existing = await client.query<PresenceRow>(
        `SELECT presence.player_id,presence.manor_id,manor.owner_player_id,presence.access_source,
                presence.admission_travel_invite_id,presence.return_region_code,presence.return_lat,presence.return_lon,
                presence.local_position_x,presence.local_position_y
         FROM player_manor_presence presence
         JOIN player_manors manor ON manor.id=presence.manor_id
         WHERE presence.player_id=$1`,
        [player.playerId]
      );
      if (existing.rowCount) throw new ManorError("ALREADY_INSIDE", "You are already inside a manor.");
      const manor = await client.query<ManorRow & ManorWarfareCheckpointColumns & { db_now: Date | string }>(
        `SELECT id,owner_player_id,world_region_code,world_lat,world_lon,built_at,source_flag_id,placement_revision,manor_type_id,
                health,health_at,burning_since,repair_player_id,clock_timestamp() AS db_now
         FROM player_manors WHERE id=$1 AND built_at IS NOT NULL FOR SHARE`,
        [resolved.manor.manorId]
      );
      const builtManor = manor.rows[0];
      if (!builtManor || Number(builtManor.placement_revision) !== resolved.manor.placementRevision) {
        throw new ManorError("MANOR_CHANGED", "That manor changed before entry could begin.");
      }
      if (manorCheckpointHealth(builtManor, new Date(builtManor.db_now).getTime()) <= 0) throw burntManorError();
      if (resolved.accessSource === "OWNER" && builtManor.owner_player_id !== player.playerId) {
        throw new ManorError("MANOR_ACCESS_DENIED", "Only the manor owner has owner access.");
      }
      if (builtManor.owner_player_id !== player.playerId) {
        const banned = await client.query(
          "SELECT 1 FROM manor_bans WHERE manor_id=$1 AND banned_player_id=$2",
          [builtManor.id, player.playerId]
        );
        if (banned.rowCount) throw new ManorError("MANOR_BANNED", "You are banned from this manor.");
      }
      const manorId = builtManor.id;
      const inserted = await client.query<PresenceRow>(
        `INSERT INTO player_manor_presence
          (player_id,manor_id,access_source,admission_travel_invite_id,
           return_region_code,return_lat,return_lon)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         RETURNING player_id,manor_id,$8::text AS owner_player_id,access_source,
           admission_travel_invite_id,return_region_code,return_lat,return_lon,
           local_position_x,local_position_y,$9::text AS manor_type_id`,
        [player.playerId, manorId, resolved.accessSource, resolved.travelInviteId,
          player.regionCode, player.position.lat, player.position.lon, builtManor.owner_player_id,
          builtManor.manor_type_id]
      );
      if (beforeCommit) await beforeCommit(client);
      await client.query("COMMIT");
      return mapPresence(requireRow(inserted.rows[0], "Manor presence could not be saved"));
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async load(playerId: string): Promise<ManorPresence | null> {
    const result = await this.pool.query<PresenceRow>(
      `SELECT p.player_id,p.manor_id,m.owner_player_id,p.access_source,p.admission_travel_invite_id,
              p.return_region_code,p.return_lat,p.return_lon,p.local_position_x,p.local_position_y,m.manor_type_id
       FROM player_manor_presence p
       JOIN player_manors m ON m.id=p.manor_id
       WHERE p.player_id = $1`,
      [playerId]
    );
    return result.rows[0] ? mapPresence(result.rows[0]) : null;
  }

  async restorePresence(presence: ManorPresence): Promise<void> {
    await this.pool.query(
      `INSERT INTO player_manor_presence
        (player_id,manor_id,access_source,admission_travel_invite_id,return_region_code,return_lat,return_lon,
         local_position_x,local_position_y)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (player_id) DO UPDATE SET
         manor_id=EXCLUDED.manor_id,access_source=EXCLUDED.access_source,
         admission_travel_invite_id=EXCLUDED.admission_travel_invite_id,
         return_region_code=EXCLUDED.return_region_code,
         return_lat=EXCLUDED.return_lat,return_lon=EXCLUDED.return_lon,
         local_position_x=EXCLUDED.local_position_x,local_position_y=EXCLUDED.local_position_y,
         updated_at=now()`,
      [presence.playerId, presence.manorId, presence.accessSource, presence.admissionTravelInviteId,
        presence.returnRegionCode, presence.returnLat, presence.returnLon,
        presence.localPositionX, presence.localPositionY]
    );
  }

  async persistLocalPosition(
    playerId: string,
    manorId: string,
    x: number,
    y: number
  ): Promise<boolean> {
    if (!isValidLocalPosition(x, y)) {
      throw new ManorError("INVALID_POSITION", "Manor local coordinates are invalid.");
    }
    const result = await this.pool.query(
      `UPDATE player_manor_presence
       SET local_position_x=$3,local_position_y=$4,updated_at=now()
       WHERE player_id=$1 AND manor_id=$2`,
      [playerId, manorId, x, y]
    );
    return Boolean(result.rowCount);
  }

  async exit(playerId: string): Promise<ManorPresence> {
    const result = await this.pool.query<PresenceRow>(
      `DELETE FROM player_manor_presence p
       USING player_manors m
       WHERE p.player_id=$1 AND m.id=p.manor_id
       RETURNING p.player_id,p.manor_id,m.owner_player_id,p.access_source,
         p.admission_travel_invite_id,p.return_region_code,p.return_lat,p.return_lon,
         p.local_position_x,p.local_position_y,m.manor_type_id`,
      [playerId]
    );
    if (!result.rows[0]) throw new ManorError("NOT_INSIDE", "You are not inside a manor.");
    return mapPresence(result.rows[0]);
  }

  async reconnectAllowed(presence: ManorPresence, activePartyMember: boolean): Promise<boolean> {
    const manor = await this.pool.query<{
      owner_player_id: string;
      built_at: Date | string | null;
    }>(
      "SELECT owner_player_id,built_at FROM player_manors WHERE id=$1",
      [presence.manorId]
    );
    if (
      !manor.rows[0]?.built_at ||
      manor.rows[0].owner_player_id !== presence.ownerPlayerId
    ) return false;
    if (presence.playerId === presence.ownerPlayerId) return true;
    if (this.kickRemainingMs(presence.manorId, presence.playerId) > 0) return false;
    const banned = await this.pool.query(
      "SELECT 1 FROM manor_bans WHERE manor_id=$1 AND banned_player_id=$2",
      [presence.manorId, presence.playerId]
    );
    if (banned.rowCount) return false;
    return presence.accessSource === "TRAVEL_INVITE" ||
      (presence.accessSource === "PARTY" && activePartyMember);
  }

  async isBanned(manorId: string, playerId: string): Promise<boolean> {
    const result = await this.pool.query(
      "SELECT 1 FROM manor_bans WHERE manor_id=$1 AND banned_player_id=$2",
      [manorId, playerId]
    );
    return Boolean(result.rowCount);
  }

  async managementSnapshot(
    ownerPlayerId: string,
    manorId: string,
    activePlayerIds: readonly string[]
  ): Promise<ManorGuestManagementSnapshot> {
    await this.requireOwner(this.pool, ownerPlayerId, manorId);
    const occupants = activePlayerIds.length === 0
      ? { rows: [] as Array<{ player_id: string; username: string; display_color: string | null; access_source: ManorOccupantAccessSource }> }
      : await this.pool.query<{
          player_id: string;
          username: string;
          display_color: string | null;
          access_source: ManorOccupantAccessSource;
        }>(
          `SELECT presence.player_id,player.username,player.display_color,presence.access_source
           FROM player_manor_presence presence
           JOIN players player ON player.id=presence.player_id
           WHERE presence.manor_id=$1 AND presence.player_id=ANY($2::text[])
             AND presence.player_id<>$3
           ORDER BY lower(player.username),presence.player_id`,
          [manorId, [...activePlayerIds], ownerPlayerId]
        );
    const bans = await this.pool.query<BanRow>(
      `SELECT ban.banned_player_id,player.username,player.display_color,ban.created_at
       FROM manor_bans ban JOIN players player ON player.id=ban.banned_player_id
       WHERE ban.manor_id=$1
       ORDER BY lower(player.username),ban.banned_player_id`,
      [manorId]
    );
    return {
      manorId,
      guests: occupants.rows.map((row): ManorOccupantSnapshot => ({
        playerId: row.player_id,
        displayName: row.username,
        displayColor: row.display_color,
        accessSource: row.access_source === "TRAVEL_INVITE" ? "TRAVEL_INVITE" : "PARTY"
      })),
      bannedPlayers: bans.rows.map((row): ManorBannedPlayerSnapshot => ({
        playerId: row.banned_player_id,
        displayName: row.username,
        displayColor: row.display_color,
        createdAt: new Date(row.created_at).toISOString()
      }))
    };
  }

  async kick(ownerPlayerId: string, manorId: string, targetPlayerId: string): Promise<ManorPresence> {
    if (ownerPlayerId === targetPlayerId) throw new ManorError("MANOR_SELF_MODERATION", "You cannot kick yourself.");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        `manor-access:${manorId}:${targetPlayerId}`
      ]);
      await this.requireOwner(client, ownerPlayerId, manorId);
      const removed = await client.query<PresenceRow>(
        `DELETE FROM player_manor_presence presence
         USING player_manors manor
         WHERE presence.player_id=$1 AND presence.manor_id=$2 AND manor.id=presence.manor_id
         RETURNING presence.player_id,presence.manor_id,manor.owner_player_id,presence.access_source,
           presence.admission_travel_invite_id,presence.return_region_code,presence.return_lat,presence.return_lon,
           presence.local_position_x,presence.local_position_y`,
        [targetPlayerId, manorId]
      );
      if (!removed.rows[0]) throw new ManorError("MANOR_GUEST_NOT_PRESENT", "That player is not inside this manor.");
      await client.query("COMMIT");
      this.kickLocks.set(kickKey(manorId, targetPlayerId), Date.now() + MANOR_KICK_REENTRY_LOCK_MS);
      return mapPresence(removed.rows[0]);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async ban(ownerPlayerId: string, manorId: string, targetPlayerId: string): Promise<ManorPresence | null> {
    if (ownerPlayerId === targetPlayerId) throw new ManorError("MANOR_SELF_MODERATION", "You cannot ban yourself.");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        `manor-access:${manorId}:${targetPlayerId}`
      ]);
      await this.requireOwner(client, ownerPlayerId, manorId);
      await client.query(
        `INSERT INTO manor_bans (manor_id,banned_player_id,banned_by_player_id)
         VALUES ($1,$2,$3)
         ON CONFLICT (manor_id,banned_player_id) DO UPDATE
           SET banned_by_player_id=EXCLUDED.banned_by_player_id`,
        [manorId, targetPlayerId, ownerPlayerId]
      );
      const removed = await client.query<PresenceRow>(
        `DELETE FROM player_manor_presence presence
         USING player_manors manor
         WHERE presence.player_id=$1 AND presence.manor_id=$2 AND manor.id=presence.manor_id
         RETURNING presence.player_id,presence.manor_id,manor.owner_player_id,presence.access_source,
           presence.admission_travel_invite_id,presence.return_region_code,presence.return_lat,presence.return_lon,
           presence.local_position_x,presence.local_position_y`,
        [targetPlayerId, manorId]
      );
      await client.query("COMMIT");
      this.kickLocks.delete(kickKey(manorId, targetPlayerId));
      return removed.rows[0] ? mapPresence(removed.rows[0]) : null;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async unban(ownerPlayerId: string, manorId: string, targetPlayerId: string): Promise<void> {
    if (ownerPlayerId === targetPlayerId) throw new ManorError("MANOR_SELF_MODERATION", "You cannot unban yourself.");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await this.requireOwner(client, ownerPlayerId, manorId);
      await client.query(
        "DELETE FROM manor_bans WHERE manor_id=$1 AND banned_player_id=$2",
        [manorId, targetPlayerId]
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  clearKickLocksForManor(manorId: string): void {
    for (const key of this.kickLocks.keys()) {
      if (key.startsWith(`${manorId}:\0`)) this.kickLocks.delete(key);
    }
  }

  private kickRemainingMs(manorId: string, playerId: string): number {
    const key = kickKey(manorId, playerId);
    const expiresAt = this.kickLocks.get(key) ?? 0;
    if (expiresAt <= Date.now()) {
      this.kickLocks.delete(key);
      return 0;
    }
    return expiresAt - Date.now();
  }

  private async requireOwner(
    queryable: Pick<pg.Pool | pg.PoolClient, "query">,
    ownerPlayerId: string,
    manorId: string
  ): Promise<void> {
    const result = await queryable.query(
      "SELECT 1 FROM player_manors WHERE id=$1 AND owner_player_id=$2 AND built_at IS NOT NULL",
      [manorId, ownerPlayerId]
    );
    if (!result.rowCount) throw new ManorError("MANOR_OWNER_REQUIRED", "Only the manor owner may manage guests.");
  }

  /** Manor warfare (houses): hand attack by another player. */
  attackManor(
    playerId: string,
    manorId: string,
    requestId: string,
    player: ManorWarfarePlayer
  ): Promise<ManorAttackResult> {
    return attackManor(this.pool, { playerId, manorId, requestId, player });
  }

  /** Manor warfare: the owner starts a free, time-only repair (also from burnt). */
  startManorRepair(
    playerId: string,
    manorId: string,
    player: ManorWarfarePlayer
  ): Promise<Readonly<{ manorId: string; replayed: boolean }>> {
    return startManorRepair(this.pool, { playerId, manorId, player });
  }

  stopManorRepair(playerId: string): Promise<Readonly<{ manorId: string }> | null> {
    return stopManorRepairForPlayer(this.pool, playerId);
  }

  /** Manor warfare tick: stops repairs whose owner left, settles burnt-down Manors. */
  reconcileManorWarfare(isRepairerPresent: ManorRepairerPresence): Promise<ManorWarfareSweep> {
    return reconcileManorWarfare(this.pool, isRepairerPresent);
  }

  async status(playerId: string): Promise<ManorWorldSnapshot | null> {
    const result = await this.pool.query<ManorWorldRow>(
      `SELECT m.id,m.owner_player_id,p.username AS owner_username,m.world_region_code,m.world_lat,m.world_lon,
              m.built_at,m.source_flag_id,m.placement_revision,m.manor_type_id,
              m.health,m.health_at,m.burning_since,m.repair_player_id
       FROM player_manors m JOIN players p ON p.id=m.owner_player_id
       WHERE m.owner_player_id=$1 AND m.built_at IS NOT NULL`,
      [playerId]
    );
    return result.rows[0] ? mapWorldManor(result.rows[0]) : null;
  }

  async listBuiltNear(player: PlayerRecord, radiusM = 50_000, limit = 250): Promise<ManorWorldSnapshot[]> {
    const boundedLimit = Math.min(Math.max(Math.trunc(limit), 1), 500);
    const boundedRadius = Math.min(Math.max(radiusM, 1), 100_000);
    const result = await this.pool.query<ManorWorldRow>(
      `SELECT m.id,m.owner_player_id,p.username AS owner_username,m.world_region_code,m.world_lat,m.world_lon,
              m.built_at,m.source_flag_id,m.placement_revision,m.manor_type_id,
              m.health,m.health_at,m.burning_since,m.repair_player_id
       FROM player_manors m JOIN players p ON p.id=m.owner_player_id
       WHERE m.built_at IS NOT NULL AND m.world_region_code=$3
         AND ST_DWithin(m.geom::geography, ST_SetSRID(ST_MakePoint($1,$2),4326)::geography, $4)
       ORDER BY ST_Distance(m.geom::geography, ST_SetSRID(ST_MakePoint($1,$2),4326)::geography),m.id
       LIMIT $5`,
      [player.position.lon, player.position.lat, player.regionCode, boundedRadius, boundedLimit]
    );
    return result.rows.map(mapWorldManor);
  }

  /**
   * `developer` (Developer App only, authorized by the caller) builds the manor at the player's position without owned
   * territory or the wood cost, so interiors can be verified on accounts that own no land.
   */
  async build(
    player: PlayerRecord,
    requestId: string,
    options: Readonly<{ developer?: boolean }> = {}
  ): Promise<ManorBuildResult> {
    if (!requestId || requestId.length > 128) throw new ManorError("INVALID_REQUEST", "A valid request ID is required.");
    if (!this.territoryAuthority) throw new ManorError("UNAVAILABLE", "Manor construction is unavailable.");
    const requestHash = placementRequestHash("build", player.playerId);
    const operationKey = placementOperationKey("build", player.playerId, requestId);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`manor-placement:${player.playerId}`]);
      const previous = await client.query<PlacementOperationRow>(
        `SELECT player_id,manor_id,operation_type,request_hash,applied_revision,original_result
         FROM manor_placement_operations
         WHERE player_id=$1 AND request_id=$2 FOR UPDATE`,
        [player.playerId, requestId]
      );
      if (previous.rows[0]) {
        const replay = previous.rows[0];
        if (replay.operation_type !== "build" || replay.request_hash !== requestHash) {
          throw new ManorError("REPLAY_CONFLICT", "That request ID was already used for a different manor operation.");
        }
        const current = await client.query<ManorRow>(
          `SELECT id,owner_player_id,world_region_code,world_lat,world_lon,built_at,source_flag_id,placement_revision,manor_type_id
           FROM player_manors WHERE id=$1 FOR SHARE`, [replay.manor_id]
        );
        const currentManor = current.rows[0];
        if (!currentManor?.built_at || Number(currentManor.placement_revision) !== Number(replay.applied_revision)) {
          throw new ManorError("STALE_PLACEMENT_REPLAY", "That build belongs to an older manor placement.");
        }
        const inventory = await this.inventory.snapshotInTransaction(client, player.playerId);
        await client.query("COMMIT");
        return {
          manor: {
            ...(replay.original_result as { manor: ManorWorldSnapshot }).manor,
            placementRevision: Number(currentManor.placement_revision)
          },
          inventory,
          replayed: true
        };
      }
      const transferReuse = await client.query(
        "SELECT 1 FROM manor_transfer_operations WHERE player_id=$1 AND request_id=$2",
        [player.playerId, requestId]
      );
      if (transferReuse.rowCount) {
        throw new ManorError("REPLAY_CONFLICT", "That request ID was already used for a different manor operation.");
      }
      const manorResult = await client.query<ManorRow>(
        `INSERT INTO player_manors (owner_player_id) VALUES ($1)
         ON CONFLICT (owner_player_id) DO UPDATE SET owner_player_id=EXCLUDED.owner_player_id
         RETURNING id,owner_player_id,world_region_code,world_lat,world_lon,built_at,source_flag_id,placement_revision,manor_type_id`,
        [player.playerId]
      );
      const manor = requireRow(manorResult.rows[0], "Manor could not be reserved");
      if (manor.built_at) throw new ManorError("MANOR_ALREADY_BUILT", "You have already built your manor.");
      if (!Number.isFinite(player.position.lat) || !Number.isFinite(player.position.lon)) {
        throw new ManorError("INVALID_POSITION", "Your authoritative world position is invalid.");
      }
      const territory = options.developer
        ? { claimed: true as const, ownerPlayerId: player.playerId, nearestFlagId: null }
        : await this.territoryAuthority.resolveTerritoryAtPoint(
          player.position.lat,
          player.position.lon,
          client,
          true
        );
      if (!territory.claimed) {
        throw new ManorError("MANOR_TERRITORY_REQUIRED", "You must build your manor inside territory you own.");
      }
      if (territory.ownerPlayerId !== player.playerId) {
        throw new ManorError("MANOR_TERRITORY_OWNED_BY_OTHER", "This territory belongs to another player.");
      }
      if (!options.developer) {
        await consumeManorMaterialCost(client, this.inventory, {
          operationKey: `${operationKey}:materials`,
          playerId: player.playerId,
          source: "manor",
          sourceEntityType: "manor_build",
          sourceEntityId: manor.id,
          materials: [{ itemId: "wood", quantity: MANOR_BUILD_WOOD_COST }],
          insufficientCode: "MANOR_INSUFFICIENT_WOOD",
          insufficientMessage: `Manor construction requires ${MANOR_BUILD_WOOD_COST} wood.`
        });
      }
      const placed = await client.query<ManorRow>(
        `UPDATE player_manors SET world_region_code=$2,world_lat=$3,world_lon=$4,
           geom=ST_SetSRID(ST_MakePoint($4,$3),4326),built_at=now(),source_flag_id=$5,
           placement_revision=placement_revision+1,updated_at=now()
         WHERE id=$1 AND built_at IS NULL
         RETURNING id,owner_player_id,world_region_code,world_lat,world_lon,built_at,source_flag_id,placement_revision,manor_type_id`,
        [manor.id, player.regionCode, player.position.lat, player.position.lon, territory.nearestFlagId]
      );
      const worldManor = mapWorldManor({
        ...requireRow(placed.rows[0], "Manor was built concurrently"),
        owner_username: player.username
      });
      const inventory = await this.inventory.snapshotInTransaction(client, player.playerId);
      await client.query(
        `INSERT INTO manor_placement_operations
          (operation_key,player_id,manor_id,request_id,operation_type,request_hash,applied_revision,original_result)
         VALUES ($1,$2,$3,$4,'build',$5,$6,$7::jsonb)`,
        [operationKey, player.playerId, manor.id, requestId, requestHash, worldManor.placementRevision,
          JSON.stringify({ manor: worldManor, inventory })]
      );
      await client.query(
        `INSERT INTO manor_placement_events
          (operation_key,manor_id,player_id,event_type,placement_revision,region_code,lat,lon,source_flag_id)
         VALUES ($1,$2,$3,'built',$4,$5,$6,$7,$8)`,
        [operationKey, manor.id, player.playerId, worldManor.placementRevision, worldManor.regionCode,
          worldManor.lat, worldManor.lon, territory.nearestFlagId]
      );
      await client.query("COMMIT");
      return { manor: worldManor, inventory, replayed: false };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async storageUpgradeSnapshotForOwner(playerId: string): Promise<ManorStorageUpgradeSnapshot> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await lockManorPlayerState(client, playerId);
      const manor = await lockBuiltManorForOwner(client, playerId);
      await lockInventoryCapacity(client, playerId);
      await lockManorUpgradeState(client, manor.id, playerId);
      const snapshot = await this.storageUpgradeSnapshotInTransaction(
        client,
        playerId,
        manor.id,
        manor.account_id,
        Number(manor.storage_upgrade_level)
      );
      await client.query("COMMIT");
      return snapshot;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async upgradeStorage(input: ManorStorageUpgradeInput): Promise<ManorStorageUpgradeResult> {
    if (!input.requestId || input.requestId.length > 128) {
      throw new ManorError("INVALID_REQUEST", "A valid request ID is required.");
    }
    if (!Number.isSafeInteger(input.targetLevel) || input.targetLevel < 1 || input.targetLevel > MANOR_STORAGE_UPGRADE_MAX_LEVEL) {
      throw new ManorError("MANOR_UPGRADE_INVALID_LEVEL", "That manor storage tier is not available.");
    }
    const requestHash = manorStorageUpgradeRequestHash(input.playerId, input.targetLevel);
    const operationKey = manorStorageUpgradeOperationKey(input.playerId, input.requestId);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await lockManorPlayerState(client, input.playerId);
      const manor = await lockBuiltManorForOwner(client, input.playerId);
      await lockInventoryCapacity(client, input.playerId);
      await lockManorUpgradeState(client, manor.id, input.playerId);
      const previous = await client.query<ManorStorageUpgradeOperationRow>(
        `SELECT operation_key,player_id,manor_id,request_hash,target_level,original_result
         FROM manor_storage_upgrade_operations
         WHERE player_id=$1 AND request_id=$2 FOR UPDATE`,
        [input.playerId, input.requestId]
      );
      if (previous.rows[0]) {
        const replay = previous.rows[0];
        if (
          replay.request_hash !== requestHash ||
          replay.manor_id !== manor.id ||
          replay.target_level !== input.targetLevel ||
          !replay.original_result
        ) {
          throw new ManorError("REPLAY_CONFLICT", "That request ID was already used for a different manor upgrade.");
        }
        const snapshot = await this.storageUpgradeSnapshotInTransaction(
          client,
          input.playerId,
          manor.id,
          manor.account_id,
          Number(manor.storage_upgrade_level)
        );
        await client.query("COMMIT");
        return {
          requestId: input.requestId,
          targetLevel: input.targetLevel,
          snapshot,
          replayed: true,
          message: `${replay.original_result.message} (already applied)`
        };
      }
      const placementReuse = await client.query(
        `SELECT 1 FROM manor_placement_operations WHERE player_id=$1 AND request_id=$2
         UNION ALL
         SELECT 1 FROM manor_transfer_operations WHERE player_id=$1 AND request_id=$2`,
        [input.playerId, input.requestId]
      );
      if (placementReuse.rowCount) {
        throw new ManorError("REPLAY_CONFLICT", "That request ID was already used for a different manor operation.");
      }
      const currentLevel = Number(manor.storage_upgrade_level);
      if (currentLevel >= MANOR_STORAGE_UPGRADE_MAX_LEVEL) {
        throw new ManorError("MANOR_UPGRADE_MAX_LEVEL", "Manor storage is already at its maximum tier.");
      }
      if (input.targetLevel !== currentLevel + 1) {
        throw new ManorError(
          "MANOR_UPGRADE_SEQUENCE",
          `Unlock Manor Storage Tier ${currentLevel + 1} before purchasing Tier ${input.targetLevel}.`
        );
      }
      const upgrade = manorStorageUpgradeForLevel(input.targetLevel);
      if (!upgrade) throw new ManorError("MANOR_UPGRADE_INVALID_LEVEL", "That manor storage tier is not available.");
      const capacityBefore = manorStorageCapacityForLevel(currentLevel);
      // Reserve the idempotency row before recording the append-only event. The
      // event has a foreign key back to this row, so both records must be
      // created in this transaction before the completed result is published.
      await client.query(
        `INSERT INTO manor_storage_upgrade_operations
          (operation_key,player_id,manor_id,request_id,request_hash,target_level,
           material_cost,gold_cost,capacity_before_grams,capacity_after_grams)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10)`,
        [
          operationKey,
          input.playerId,
          manor.id,
          input.requestId,
          requestHash,
          upgrade.level,
          JSON.stringify(upgrade.materials),
          upgrade.gold,
          capacityBefore,
          upgrade.capacityGrams
        ]
      );
      await consumeManorMaterialCost(client, this.inventory, {
        operationKey: `${operationKey}:materials`,
        playerId: input.playerId,
        source: "manor",
        sourceEntityType: "manor_storage_upgrade",
        sourceEntityId: manor.id,
        materials: upgrade.materials,
        insufficientCode: "MANOR_INSUFFICIENT_MATERIALS",
        insufficientMessage: `Tier ${upgrade.level} requires ${formatManorMaterialCost(upgrade)}.`
      });
      try {
        await this.wallet.debitForOperationInTransaction(client, {
          playerId: input.playerId,
          accountId: manor.account_id,
          amount: BigInt(upgrade.gold),
          operationKey: `${operationKey}:gold`,
          reason: "manor_storage_upgrade_v1",
          metadata: { manorId: manor.id, targetLevel: upgrade.level }
        });
      } catch (error) {
        if (error instanceof WalletOperationError && error.code === "WALLET_INSUFFICIENT_FUNDS") {
          throw new ManorError("MANOR_INSUFFICIENT_GOLD", `Tier ${upgrade.level} requires ${upgrade.gold.toLocaleString("en-US")} gold.`);
        }
        throw error;
      }
      const updated = await client.query(
        `UPDATE player_manors
         SET storage_upgrade_level=$2,updated_at=now()
         WHERE id=$1 AND owner_player_id=$3 AND built_at IS NOT NULL
           AND storage_upgrade_level=$4
         RETURNING storage_upgrade_level`,
        [manor.id, upgrade.level, input.playerId, currentLevel]
      );
      if (updated.rowCount !== 1) {
        throw new ManorError("MANOR_UPGRADE_CONFLICT", "Manor storage changed before this upgrade completed.");
      }
      await client.query(
        `INSERT INTO manor_storage_upgrade_events
          (operation_key,manor_id,player_id,previous_level,next_level,
           capacity_before_grams,capacity_after_grams,material_cost,gold_cost)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)`,
        [
          operationKey,
          manor.id,
          input.playerId,
          currentLevel,
          upgrade.level,
          capacityBefore,
          upgrade.capacityGrams,
          JSON.stringify(upgrade.materials),
          upgrade.gold
        ]
      );
      const snapshot = await this.storageUpgradeSnapshotInTransaction(
        client,
        input.playerId,
        manor.id,
        manor.account_id,
        upgrade.level
      );
      const result: ManorStorageUpgradeResult = {
        requestId: input.requestId,
        targetLevel: upgrade.level,
        snapshot,
        replayed: false,
        message: `Manor Storage upgraded to Tier ${upgrade.level}. Capacity is now ${formatKg(upgrade.capacityGrams)}.`
      };
      await client.query(
        `UPDATE manor_storage_upgrade_operations
         SET original_result=$2::jsonb,completed_at=now()
         WHERE operation_key=$1 AND original_result IS NULL`,
        [operationKey, JSON.stringify(result)]
      );
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private async storageUpgradeSnapshotInTransaction(
    client: pg.PoolClient,
    playerId: string,
    manorId: string,
    accountId: string,
    level: number
  ): Promise<ManorStorageUpgradeSnapshot> {
    const inventory = await this.inventory.snapshotInTransaction(client, playerId);
    const wallet = await this.wallet.snapshotInTransaction(client, playerId, accountId);
    return {
      manorId,
      level,
      maximumLevel: MANOR_STORAGE_UPGRADE_MAX_LEVEL,
      capacityGrams: manorStorageCapacityForLevel(level).toString(),
      upgrades: MANOR_STORAGE_UPGRADES,
      inventory,
      walletGold: wallet.gold,
      walletVersion: wallet.revision
    };
  }

  async destroy(playerId: string, requestId: string): Promise<ManorDestroyResult> {
    if (!requestId || requestId.length > 128) throw new ManorError("INVALID_REQUEST", "A valid request ID is required.");
    const requestHash = placementRequestHash("destroy", playerId);
    const operationKey = placementOperationKey("destroy", playerId, requestId);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`manor-placement:${playerId}`]);
      const previous = await client.query<PlacementOperationRow>(
        `SELECT player_id,manor_id,operation_type,request_hash,applied_revision,original_result
         FROM manor_placement_operations WHERE player_id=$1 AND request_id=$2 FOR UPDATE`,
        [playerId, requestId]
      );
      if (previous.rows[0]) {
        const replay = previous.rows[0];
        if (replay.operation_type !== "destroy" || replay.request_hash !== requestHash) {
          throw new ManorError("REPLAY_CONFLICT", "That request ID was already used for a different manor operation.");
        }
        const current = await client.query<ManorRow>(
          `SELECT id,owner_player_id,world_region_code,world_lat,world_lon,built_at,source_flag_id,placement_revision,manor_type_id
           FROM player_manors WHERE id=$1 FOR SHARE`, [replay.manor_id]
        );
        const currentManor = current.rows[0];
        if (!currentManor || currentManor.built_at || Number(currentManor.placement_revision) !== Number(replay.applied_revision)) {
          throw new ManorError("STALE_PLACEMENT_REPLAY", "That destruction belongs to an older manor placement.");
        }
        const result = replay.original_result as { manorId: string; placementRevision: number };
        await client.query("COMMIT");
        return { ...result, ejected: [], replayed: true };
      }
      const transferReuse = await client.query(
        "SELECT 1 FROM manor_transfer_operations WHERE player_id=$1 AND request_id=$2", [playerId, requestId]
      );
      if (transferReuse.rowCount) {
        throw new ManorError("REPLAY_CONFLICT", "That request ID was already used for a different manor operation.");
      }
      const manorResult = await client.query<ManorRow>(
        `SELECT id,owner_player_id,world_region_code,world_lat,world_lon,built_at,source_flag_id,placement_revision,manor_type_id
         FROM player_manors WHERE owner_player_id=$1 FOR UPDATE`, [playerId]
      );
      const manor = manorResult.rows[0];
      if (!manor?.built_at) throw new ManorError("MANOR_NOT_BUILT", "You do not have a built manor to destroy.");
      const cleared = await client.query<ManorRow>(
        `UPDATE player_manors SET world_region_code=NULL,world_lat=NULL,world_lon=NULL,geom=NULL,
           built_at=NULL,source_flag_id=NULL,placement_revision=placement_revision+1,updated_at=now()
         WHERE id=$1 AND owner_player_id=$2 AND built_at IS NOT NULL
         RETURNING id,owner_player_id,world_region_code,world_lat,world_lon,built_at,source_flag_id,placement_revision,manor_type_id`,
        [manor.id, playerId]
      );
      const unbuilt = requireRow(cleared.rows[0], "Manor was destroyed concurrently");
      const result = { manorId: unbuilt.id, placementRevision: Number(unbuilt.placement_revision) };
      const removedPresence = await client.query<PresenceRow>(
        `DELETE FROM player_manor_presence presence
         USING player_manors owner
         WHERE presence.manor_id=$1 AND owner.id=presence.manor_id
         RETURNING presence.player_id,presence.manor_id,owner.owner_player_id,presence.access_source,
           presence.admission_travel_invite_id,presence.return_region_code,presence.return_lat,presence.return_lon,
           presence.local_position_x,presence.local_position_y`,
        [manor.id]
      );
      await client.query("DELETE FROM manor_bans WHERE manor_id=$1", [manor.id]);
      await client.query(
        `INSERT INTO manor_placement_operations
          (operation_key,player_id,manor_id,request_id,operation_type,request_hash,applied_revision,original_result)
         VALUES ($1,$2,$3,$4,'destroy',$5,$6,$7::jsonb)`,
        [operationKey, playerId, manor.id, requestId, requestHash, result.placementRevision, JSON.stringify(result)]
      );
      await client.query(
        `INSERT INTO manor_placement_events
          (operation_key,manor_id,player_id,event_type,placement_revision)
         VALUES ($1,$2,$3,'destroyed',$4)`,
        [operationKey, manor.id, playerId, result.placementRevision]
      );
      await client.query("COMMIT");
      this.clearKickLocksForManor(manor.id);
      return { ...result, ejected: removedPresence.rows.map(mapPresence), replayed: false };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Equip a Manor skin from the inventory (the default type unequips back to
   * the timber Manor). Skins are equipment: the item never leaves the
   * inventory, it is only locked there while equipped (1083 refuses any
   * removal at commit; debits and storage refuse earlier with the reason).
   * Lock order: the placement lock, the inventory carry lock, then the Manor
   * row, the order every inventory writer uses. Refused while guests are
   * inside; when the owner is inside, their durable location moves to the new
   * type's lobby spawn (the realtime layer re-enters their session there).
   * Works on an unbuilt Manor too, so a skin is never stuck equipped. Request
   * ids replay. Decorations stay with their rooms and only show while their
   * type is active.
   */
  async equipSkin(input: Readonly<{ playerId: string; requestId: string; manorTypeId: string; copyId?: string | null }>): Promise<ManorSkinResult> {
    const { playerId, requestId, manorTypeId } = input;
    const copyId = manorTypeId === DEFAULT_MANOR_TYPE_ID ? null : input.copyId ?? null;
    if (manorTypeId !== DEFAULT_MANOR_TYPE_ID && (!copyId || !isShopCopyId(copyId))) {
      throw new ManorError("MANOR_SKIN_NOT_OWNED", "Choose which skin copy to equip.");
    }
    if (!requestId || requestId.length > 128) throw new ManorError("INVALID_REQUEST", "A valid request ID is required.");
    if (manorTypeId !== DEFAULT_MANOR_TYPE_ID && !isPurchasableManorSkin(manorTypeId)) {
      throw new ManorError("MANOR_TYPE_UNKNOWN", "That manor skin is not available.");
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`manor-placement:${playerId}`]);
      const replay = await this.skinReplay(client, playerId, requestId, "install", manorTypeId);
      if (replay) {
        const manor = await this.statusInTransaction(client, playerId);
        const inventory = await this.inventory.snapshotInTransaction(client, playerId);
        await client.query("COMMIT");
        return { manor, inventory, replayed: true, message: replay, ownerRespawn: null };
      }
      await lockInventoryCapacity(client, playerId);
      const locked = await client.query<ManorRow>(
        `SELECT id,owner_player_id,world_region_code,world_lat,world_lon,built_at,source_flag_id,placement_revision,manor_type_id
         FROM player_manors WHERE owner_player_id=$1 FOR UPDATE`, [playerId]
      );
      const manor = locked.rows[0];
      if (!manor) throw new ManorError("MANOR_NOT_BUILT", "Build your manor before equipping a skin.");
      const current = resolveManorTypeId(manor.manor_type_id);
      const currentCopy = (await client.query<{ skin_copy_id: string | null }>(
        "SELECT skin_copy_id FROM player_manors WHERE id=$1", [manor.id]
      )).rows[0]?.skin_copy_id ?? null;
      let message = current === manorTypeId && currentCopy === copyId
        ? (manorTypeId === DEFAULT_MANOR_TYPE_ID ? "No skin is equipped." : `${manorSkinDisplayName(manorTypeId)} is already equipped.`)
        : "";
      let ownerRespawn: ManorSkinResult["ownerRespawn"] = null;
      if (current !== manorTypeId || currentCopy !== copyId) {
        const guests = await client.query(
          "SELECT 1 FROM player_manor_presence WHERE manor_id=$1 AND player_id<>$2 LIMIT 1", [manor.id, playerId]
        );
        if (guests.rowCount) {
          throw new ManorError("MANOR_OCCUPIED", "Guests are inside your Manor. Change its skin once they have left.");
        }
        if (manorTypeId !== DEFAULT_MANOR_TYPE_ID) {
          // The exact copy must be in the owner's inventory and have this look (1202).
          const held = await client.query<{ look: string }>(
            `SELECT copy.look FROM player_inventory inventory
             JOIN shop_item_copies copy ON copy.copy_id = inventory.variant AND copy.item_id = inventory.resource_type
             WHERE inventory.player_id=$1 AND inventory.resource_type=$2 AND inventory.variant=$3 AND inventory.quantity > 0`,
            [playerId, MANOR_SKIN_ITEM_ID, copyId]
          );
          if (held.rows[0]?.look !== manorTypeId) {
            throw new ManorError("MANOR_SKIN_NOT_OWNED", `You need a ${manorSkinDisplayName(manorTypeId)} in your inventory.`);
          }
        }
        await client.query(
          "UPDATE player_manors SET manor_type_id=$2,skin_copy_id=$3,updated_at=now() WHERE id=$1",
          [manor.id, manorTypeId, copyId]
        );
        // The owner inside moves to the new type's lobby spawn: their old room may not exist there.
        const spawnRoom = manorAuthoredRoom(MANOR_ENTRANCE_SPACE_ID, manorTypeId);
        const spawn = spawnRoom?.anchors.find((anchor) => anchor.id === spawnRoom.spawnAnchorId) ?? MANOR_SPAWN;
        const inside = await client.query(
          `UPDATE player_manor_presence SET local_position_x=NULL,local_position_y=NULL
           WHERE manor_id=$1 AND player_id=$2 RETURNING player_id`,
          [manor.id, playerId]
        );
        if (inside.rowCount) {
          await client.query(
            `UPDATE players SET location_space_id=$3,location_local_x=$4,location_local_y=$5,
               location_revision=location_revision+1
             WHERE id=$1 AND location_kind='interior' AND location_type='manor' AND location_id=$2`,
            [playerId, manor.id, MANOR_ENTRANCE_SPACE_ID, spawn.x, spawn.y]
          );
          ownerRespawn = { manorId: manor.id, manorTypeId };
        }
        message = manorTypeId === DEFAULT_MANOR_TYPE_ID
          ? `${manorSkinDisplayName(current)} unequipped. Your Manor is back to the default Timber skin.`
          : `${manorSkinDisplayName(manorTypeId)} equipped.`;
      }
      await client.query(
        `INSERT INTO manor_skin_operations (player_id,request_id,action,manor_type_id,manor_id,previous_manor_type_id)
         VALUES ($1,$2,'install',$3,$4,$5)`,
        [playerId, requestId, manorTypeId, manor.id, current]
      );
      const updated = await this.statusInTransaction(client, playerId);
      const inventory = await this.inventory.snapshotInTransaction(client, playerId);
      await client.query("COMMIT");
      return { manor: updated, inventory, replayed: false, message, ownerRespawn };
    } catch (error) {
      await client.query("ROLLBACK");
      if (isInventoryItemEquippedError(error)) {
        // A concurrent removal won the per-owner lock (1083): the skin is gone.
        throw new ManorError("MANOR_SKIN_NOT_OWNED", `You need a ${manorSkinDisplayName(manorTypeId)} in your inventory.`);
      }
      throw error;
    } finally {
      client.release();
    }
  }

  /** The original outcome message of a replayed skin request, or null; a reused id for other data conflicts. */
  private async skinReplay(client: pg.PoolClient, playerId: string, requestId: string, action: "install" | "purchase", manorTypeId: string): Promise<string | null> {
    const previous = await client.query<{ action: string; manor_type_id: string }>(
      "SELECT action,manor_type_id FROM manor_skin_operations WHERE player_id=$1 AND request_id=$2",
      [playerId, requestId]
    );
    const row = previous.rows[0];
    if (!row) return null;
    if (row.action !== action || row.manor_type_id !== manorTypeId) {
      throw new ManorError("REPLAY_CONFLICT", "That request ID was already used for a different skin request.");
    }
    return action === "install" ? "Skin change already applied." : "Purchase already completed.";
  }

  private async statusInTransaction(client: pg.PoolClient, playerId: string): Promise<ManorWorldSnapshot | null> {
    const result = await client.query<ManorWorldRow>(
      `SELECT m.id,m.owner_player_id,p.username AS owner_username,m.world_region_code,m.world_lat,m.world_lon,
              m.built_at,m.source_flag_id,m.placement_revision,m.manor_type_id,
              m.health,m.health_at,m.burning_since,m.repair_player_id
       FROM player_manors m JOIN players p ON p.id=m.owner_player_id
       WHERE m.owner_player_id=$1 AND m.built_at IS NOT NULL`,
      [playerId]
    );
    return result.rows[0] ? mapWorldManor(result.rows[0]) : null;
  }
}

export type ManorSkinResult = {
  manor: ManorWorldSnapshot | null;
  inventory: PlayerInventorySnapshot;
  premiumWallet?: PremiumWalletSnapshot;
  replayed: boolean;
  message: string;
  /** Set when the owner was inside: the realtime layer re-enters them at the new type's lobby spawn. */
  ownerRespawn: { manorId: string; manorTypeId: string } | null;
};

export type ManorStorageTransferInput = {
  playerId: string;
  requestId: string;
  direction: ManorTransferDirection;
  sourceStackId: string;
  quantity: number;
};

export type ManorEquipmentTransferInput = {
  playerId: string;
  requestId: string;
  direction: ManorTransferDirection;
  equipmentInstanceId: string;
};

export type ManorBackpackTransferInput = {
  playerId: string;
  requestId: string;
  direction: ManorTransferDirection;
  backpackInstanceId: string;
};

export type ManorStorageFailureHook =
  | "after-inventory-debit"
  | "after-storage-debit"
  | "after-destination-write";

type StorageOperationWork = {
  transfer: ManorTransferSummary | null;
  message: string;
};

export class ManorStorageService {
  private readonly inventory: InventoryService;
  private readonly equipment: EquipmentService;
  private readonly backpacks: BackpackService;

  constructor(
    private readonly pool: pg.Pool,
    inventory?: InventoryService,
    private readonly failureHook?: (point: ManorStorageFailureHook) => void,
    equipment?: EquipmentService,
    backpacks?: BackpackService
  ) {
    this.inventory = inventory ?? new InventoryService(pool);
    this.equipment = equipment ?? new EquipmentService(pool);
    this.backpacks = backpacks ?? new BackpackService(pool, {
      inventory: this.inventory
    });
  }

  private ensureStorageMutationAllowed(): void {
    throw new ManorError(
      "MANOR_STORAGE_RETIRED",
      "Manor Storage is retired; recover items from the Manor recovery pile."
    );
  }

  async snapshotForPlayer(playerId: string): Promise<ManorStorageSnapshot> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const presence = await this.requireOwnedPresence(client, playerId);
      await lockInventoryCapacity(client, playerId);
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 676))", [
        JSON.stringify([presence.manor_id, playerId])
      ]);
      await normalizeManorStorageStacks(client, presence.manor_id);
      const equipment = await this.equipment.snapshotInTransaction(client, playerId);
      const backpacks = await this.backpacks.snapshotInTransaction(client, playerId);
      const snapshot = await storageSnapshot(client, presence.manor_id, equipment, backpacks);
      await client.query("COMMIT");
      return snapshot;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async snapshotForOwner(playerId: string): Promise<ManorStorageSnapshot> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const manor = await client.query<{ id: string }>(
        `SELECT id FROM player_manors
         WHERE owner_player_id=$1 AND built_at IS NOT NULL`,
        [playerId]
      );
      const manorId = manor.rows[0]?.id;
      if (!manorId) {
        throw new ManorError("MANOR_NOT_BUILT", "You do not have a built manor.");
      }
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 676))", [
        JSON.stringify([manorId, playerId])
      ]);
      await normalizeManorStorageStacks(client, manorId);
      const equipment = await this.equipment.snapshotInTransaction(client, playerId);
      const backpacks = await this.backpacks.snapshotInTransaction(client, playerId);
      const snapshot = await storageSnapshot(client, manorId, equipment, backpacks);
      await client.query("COMMIT");
      return snapshot;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  moveStack(
    playerId: string,
    requestId: string,
    stackId: string,
    targetSlot: number
  ): Promise<ManorStorageResult> {
    if (!Number.isSafeInteger(targetSlot) || targetSlot < 0) {
      throw new ManorError("MANOR_STORAGE_TARGET_INVALID", "That manor storage position is not available.");
    }
    return this.runOperation(playerId, requestId, "move", { stackId, targetSlot }, async (
      client, manorId, operationKey
    ) => {
      const source = await storageStack(client, manorId, stackId);
      if (!source) throw new ManorError("MANOR_STORAGE_STACK_NOT_FOUND", "That storage stack is no longer available.");
      const target = await storageStackAtSlot(client, manorId, targetSlot);
      if (source.slot_index !== targetSlot) {
        if (target) {
          await client.query(
            `UPDATE manor_storage_stacks
             SET slot_index = CASE stack_id
                   WHEN $2::uuid THEN $3::integer
                   ELSE $4::integer
                 END,
                 version = version + 1, updated_at = now()
             WHERE manor_id=$1 AND stack_id IN ($2::uuid,$5::uuid)`,
            [manorId, source.stack_id, targetSlot, source.slot_index, target.stack_id]
          );
          await this.writeStackEvent(client, operationKey, playerId, manorId, "move", source, {
            slotIndex: targetSlot
          });
          await this.writeStackEvent(client, operationKey, playerId, manorId, "move", target, {
            slotIndex: source.slot_index
          });
        } else {
          await client.query(
            `UPDATE manor_storage_stacks
             SET slot_index=$3,version=version+1,updated_at=now()
             WHERE manor_id=$1 AND stack_id=$2::uuid`,
            [manorId, source.stack_id, targetSlot]
          );
          await this.writeStackEvent(client, operationKey, playerId, manorId, "move", source, {
            slotIndex: targetSlot
          });
        }
      }
      return { transfer: null, message: "Storage stack moved." };
    });
  }

  splitStack(
    playerId: string,
    requestId: string,
    stackId: string,
    quantity: number
  ): Promise<ManorStorageResult> {
    if (!Number.isSafeInteger(quantity) || quantity <= 0) {
      throw new ManorError("MANOR_STORAGE_SPLIT_INVALID_QUANTITY", "Split quantity must be a positive whole number.");
    }
    return this.runOperation(playerId, requestId, "split", { stackId, quantity }, async (
      client, manorId, operationKey
    ) => {
      const source = await storageStack(client, manorId, stackId);
      if (!source) throw new ManorError("MANOR_STORAGE_STACK_NOT_FOUND", "That storage stack is no longer available.");
      const maximum = maximumStack(source.item_id);
      if (BigInt(quantity) >= BigInt(source.quantity)) {
        throw new ManorError("MANOR_STORAGE_SPLIT_INVALID_QUANTITY", "Split quantity must be less than the source quantity.");
      }
      if (BigInt(quantity) > maximum) {
        throw new ManorError(
          "MANOR_STORAGE_SPLIT_INVALID_QUANTITY",
          `A new stack cannot exceed ${maximum.toLocaleString()}.`
        );
      }
      const freeSlot = await nextManorStoragePosition(client, manorId);
      await client.query(
        `UPDATE manor_storage_stacks
         SET quantity=quantity-$3::bigint,version=version+1,updated_at=now()
         WHERE manor_id=$1 AND stack_id=$2::uuid`,
        [manorId, stackId, quantity]
      );
      const created = await client.query<StackRow>(
        `INSERT INTO manor_storage_stacks
           (manor_id,slot_index,item_id,variant,quantity,manual_split)
         VALUES ($1,$2,$3,$4,$5::bigint,true)
         RETURNING stack_id,manor_id,slot_index,item_id,variant,quantity::text,
                   manual_split,version::text`,
        [manorId, freeSlot, source.item_id, source.variant, quantity]
      );
      const newStack = requireRow(created.rows[0], "Manor split returned no stack");
      await this.writeStackEvent(client, operationKey, playerId, manorId, "split", source, {
        quantity: BigInt(source.quantity) - BigInt(quantity)
      }, newStack.stack_id);
      await this.writeStackEvent(client, operationKey, playerId, manorId, "split", null, {
        stack: newStack
      }, source.stack_id);
      return { transfer: null, message: `Split ${quantity.toLocaleString()} into a manual stack.` };
    });
  }

  restackStack(
    playerId: string,
    requestId: string,
    stackId: string
  ): Promise<ManorStorageResult> {
    return this.runOperation(playerId, requestId, "restack", { stackId }, async (
      client, manorId, operationKey
    ) => {
      const source = await storageStack(client, manorId, stackId);
      if (!source) throw new ManorError("MANOR_STORAGE_STACK_NOT_FOUND", "That storage stack is no longer available.");
      if (!source.manual_split) {
        throw new ManorError("MANOR_STORAGE_STACK_NOT_MANUAL", "Only a manually split stack can be restacked.");
      }
      const maximum = maximumStack(source.item_id);
      let remaining = BigInt(source.quantity);
      const compatible = await client.query<StackRow>(
        `${STORAGE_STACK_SELECT}
         FROM manor_storage_stacks stack
         WHERE stack.manor_id=$1 AND stack.item_id=$2 AND stack.variant=$3
           AND stack.manual_split=false AND stack.stack_id<>$4::uuid AND stack.quantity<$5::bigint
         ORDER BY stack.slot_index FOR UPDATE`,
        [manorId, source.item_id, source.variant, stackId, maximum.toString()]
      );
      for (const target of compatible.rows) {
        const moved = minBigInt(remaining, maximum - BigInt(target.quantity));
        if (moved <= 0n) continue;
        await client.query(
          `UPDATE manor_storage_stacks
           SET quantity=quantity+$2::bigint,version=version+1,updated_at=now()
           WHERE stack_id=$1::uuid`,
          [target.stack_id, moved.toString()]
        );
        await this.writeStackEvent(client, operationKey, playerId, manorId, "restack", target, {
          quantity: BigInt(target.quantity) + moved
        }, source.stack_id);
        remaining -= moved;
        if (remaining === 0n) break;
      }
      if (remaining === 0n) {
        await client.query("DELETE FROM manor_storage_stacks WHERE manor_id=$1 AND stack_id=$2::uuid", [
          manorId, stackId
        ]);
        await this.writeStackEvent(client, operationKey, playerId, manorId, "restack", source, {
          deleted: true
        });
      } else {
        await client.query(
          `UPDATE manor_storage_stacks
           SET quantity=$3::bigint,manual_split=false,version=version+1,updated_at=now()
           WHERE manor_id=$1 AND stack_id=$2::uuid`,
          [manorId, stackId, remaining.toString()]
        );
        await this.writeStackEvent(client, operationKey, playerId, manorId, "restack", source, {
          quantity: remaining,
          manualSplit: false
        });
      }
      return { transfer: null, message: "Manual stack returned to automatic stacking." };
    });
  }

  reorganize(playerId: string, requestId: string): Promise<ManorStorageResult> {
    return this.runOperation(playerId, requestId, "reorganize", {}, async (
      client, manorId, operationKey
    ) => {
      const consolidationRows = await client.query<StackRow>(
        `${STORAGE_STACK_SELECT}
         FROM manor_storage_stacks stack
         WHERE stack.manor_id=$1 AND stack.quantity > 0
         ORDER BY stack.slot_index
         FOR UPDATE`,
        [manorId]
      );
      const consolidationPlan = planAutomaticStackConsolidation(
        consolidationRows.rows.map((stack) => ({
          stackId: stack.stack_id,
          slotIndex: stack.slot_index,
          itemId: stack.item_id,
          variant: stack.variant,
          quantity: stack.quantity,
          manualSplit: stack.manual_split
        }))
      );
      const consolidationById = new Map(
        consolidationRows.rows.map((stack) => [stack.stack_id, stack])
      );
      for (const update of consolidationPlan.updates) {
        const stack = consolidationById.get(update.stackId)!;
        await client.query(
          `UPDATE manor_storage_stacks
           SET quantity=$3::bigint,version=version+1,updated_at=now()
           WHERE manor_id=$1 AND stack_id=$2::uuid`,
          [manorId, update.stackId, update.quantity.toString()]
        );
        await this.writeStackEvent(
          client,
          operationKey,
          playerId,
          manorId,
          "reorganize",
          stack,
          { quantity: update.quantity }
        );
      }
      for (const stackId of consolidationPlan.deletions) {
        const stack = consolidationById.get(stackId)!;
        await client.query(
          "DELETE FROM manor_storage_stacks WHERE manor_id=$1 AND stack_id=$2::uuid",
          [manorId, stackId]
        );
        await this.writeStackEvent(
          client,
          operationKey,
          playerId,
          manorId,
          "reorganize",
          stack,
          { deleted: true }
        );
      }
      const rows = await client.query<StackRow & { display_name: string }>(
        `${STORAGE_STACK_SELECT}, definition.display_name
         FROM manor_storage_stacks stack
         JOIN item_definitions definition ON definition.item_id=stack.item_id
         WHERE stack.manor_id=$1
         ORDER BY lower(definition.display_name) COLLATE "C",
                  stack.quantity DESC,
                  stack.variant COLLATE "C",
                  stack.stack_id
         FOR UPDATE OF stack`,
        [manorId]
      );
      let moved = false;
      for (let index = 0; index < rows.rows.length; index += 1) {
        const stack = rows.rows[index]!;
        const slotIndex = index;
        if (stack.slot_index === slotIndex) continue;
        await client.query(
          `UPDATE manor_storage_stacks
           SET slot_index=$3,version=version+1,updated_at=now()
           WHERE manor_id=$1 AND stack_id=$2::uuid`,
          [manorId, stack.stack_id, slotIndex]
        );
        await this.writeStackEvent(client, operationKey, playerId, manorId, "reorganize", stack, {
          slotIndex
        });
        moved = true;
      }
      if (moved) this.failureHook?.("after-destination-write");
      return { transfer: null, message: "Manor Storage reorganized." };
    });
  }

  transfer(input: ManorStorageTransferInput): Promise<ManorStorageResult> {
    const normalized = normalizeTransfer(input);
    return this.runOperation(
      normalized.playerId,
      normalized.requestId,
      "transfer",
      {
        direction: normalized.direction,
        sourceStackId: normalized.sourceStackId,
        quantity: normalized.quantity.toString()
      },
      async (client, manorId, operationKey) => {
        const summary = normalized.direction === "deposit"
          ? await this.storePlayerStack(client, manorId, operationKey, normalized)
          : await this.takeManorStack(client, manorId, operationKey, normalized);
        return {
          transfer: summary,
          message: normalized.direction === "deposit"
            ? `Stored ${summary.quantityMoved.toLocaleString()} item${summary.quantityMoved === 1 ? "" : "s"}.`
            : `Took ${summary.quantityMoved.toLocaleString()} item${summary.quantityMoved === 1 ? "" : "s"}.`
        };
      }
    );
  }

  transferEquipment(input: ManorEquipmentTransferInput): Promise<ManorStorageResult> {
    if (!input.equipmentInstanceId) {
      throw new ManorError("INVALID_REQUEST", "An equipment instance is required.");
    }
    return this.runOperation(
      input.playerId,
      input.requestId,
      "transfer",
      {
        kind: "equipment",
        direction: input.direction,
        equipmentInstanceId: input.equipmentInstanceId
      },
      async (client, manorId, operationKey) => {
        await lockInventoryProtection(client, input.playerId);
        const locked = await client.query<{
          instance_id: string;
          definition_id: string;
          location: "inventory" | "equipped" | "manor_storage" | "destroyed";
          inventory_slot_index: number | null;
          manor_id: string | null;
          manor_slot_index: number | null;
          manor_storable: boolean;
        }>(
          `SELECT equipment.instance_id::text,equipment.definition_id,equipment.location,
                  equipment.inventory_slot_index,equipment.manor_id::text,
                  equipment.manor_slot_index,definition.manor_storable
           FROM equipment_instances equipment
           JOIN item_definitions definition
             ON definition.item_id=equipment.definition_id
           WHERE equipment.owner_player_id=$1
             AND equipment.instance_id=$2::uuid
           FOR UPDATE OF equipment`,
          [input.playerId, input.equipmentInstanceId]
        );
        const item = locked.rows[0];
        if (!item || item.location === "destroyed") {
          throw new ManorError("EQUIPMENT_NOT_OWNED", "That equipment is no longer owned.");
        }
        let slotBefore: number | null = null;
        let slotAfter: number | null = null;
        const inventorySlotBefore: number | null = item.inventory_slot_index;
        const inventorySlotAfter: number | null = null;
        if (input.direction === "deposit") {
          if (item.location !== "inventory") {
            throw new ManorError(
              "EQUIPMENT_NOT_STORABLE",
              item.location === "equipped"
                ? "Unequip this item before storing it."
                : "That equipment is not in Player Inventory."
            );
          }
          if (!item.manor_storable) {
            throw new ManorError("EQUIPMENT_NOT_STORABLE", "That equipment cannot be stored.");
          }
          const protection = await client.query<{ protected: boolean }>(
            `SELECT protected
             FROM player_unique_item_protections
             WHERE player_id=$1 AND equipment_instance_id=$2::uuid`,
            [input.playerId, input.equipmentInstanceId]
          );
          const kitReference = await client.query(
            `SELECT 1 FROM combat_kit_items
             WHERE player_id=$1 AND instance_id=$2::uuid LIMIT 1`,
            [input.playerId, input.equipmentInstanceId]
          );
          if (protection.rows[0]?.protected) {
            throw new ManorError("EQUIPMENT_PROTECTED", "That equipment is protected.");
          }
          if (kitReference.rowCount) {
            throw new ManorError(
              "EQUIPMENT_SAVED_KIT",
              "Remove this equipment from saved combat kits before storing it."
            );
          }
          if (await manorStorageWeightRemaining(client, manorId) < BigInt(requireRuntimeItemDefinition(item.definition_id).unitWeightGrams)) {
            throw new ManorError("MANOR_STORAGE_FULL", "Manor Storage does not have room for that equipment.");
          }
          slotAfter = await nextManorStoragePosition(client, manorId);
          await client.query(
            `UPDATE equipment_instances
             SET location='manor_storage',equipped_slot=NULL,inventory_slot_index=NULL,
                 manor_id=$3,manor_slot_index=$4,updated_at=now()
             WHERE owner_player_id=$1 AND instance_id=$2::uuid`,
            [input.playerId, input.equipmentInstanceId, manorId, slotAfter]
          );
        } else {
          if (item.location !== "manor_storage" || item.manor_id !== manorId) {
            throw new ManorError(
              "EQUIPMENT_NOT_IN_STORAGE",
              "That equipment is not in this Manor Storage."
            );
          }
          slotBefore = item.manor_slot_index;
          await assertInventoryWeightInTransaction(client, input.playerId, BigInt(requireRuntimeItemDefinition(item.definition_id).unitWeightGrams));
          await client.query(
            `UPDATE equipment_instances
             SET location='inventory',equipped_slot=NULL,inventory_slot_index=$3,
                 manor_id=NULL,manor_slot_index=NULL,updated_at=now()
             WHERE owner_player_id=$1 AND instance_id=$2::uuid`,
            [input.playerId, input.equipmentInstanceId, inventorySlotAfter]
          );
        }
        await client.query(
          `UPDATE player_equipment_state
           SET inventory_revision=inventory_revision+1
           WHERE player_id=$1`,
          [input.playerId]
        );
        await client.query(
          `INSERT INTO manor_storage_equipment_events
           (operation_key,manor_id,player_id,equipment_instance_id,direction,
            slot_before,slot_after,inventory_slot_before,inventory_slot_after)
           VALUES ($1,$2,$3,$4::uuid,$5,$6,$7,$8,$9)`,
          [
            operationKey,
            manorId,
            input.playerId,
            input.equipmentInstanceId,
            input.direction,
            slotBefore,
            slotAfter,
            inventorySlotBefore,
            inventorySlotAfter
          ]
        );
        return {
          transfer: transferSummary(input.direction, 1, 1n, 1, 1n, null),
          message: input.direction === "deposit"
            ? "Equipment stored."
            : "Equipment taken."
        };
      }
    );
  }

  transferBackpack(input: ManorBackpackTransferInput): Promise<ManorStorageResult> {
    if (!input.backpackInstanceId) {
      throw new ManorError("INVALID_REQUEST", "A backpack instance is required.");
    }
    return this.runOperation(
      input.playerId,
      input.requestId,
      "transfer",
      {
        kind: "backpack",
        direction: input.direction,
        backpackInstanceId: input.backpackInstanceId
      },
      async (client, manorId, operationKey) => {
        const locked = await client.query<{
          instance_id: string;
          definition_id: string;
          location: "inventory" | "equipped" | "manor_storage" | "destroyed";
          inventory_slot_index: number | null;
          manor_id: string | null;
          manor_slot_index: number | null;
        }>(
          `SELECT instance_id::text,definition_id,location,inventory_slot_index,
                  manor_id::text,manor_slot_index
           FROM player_backpack_instances
           WHERE owner_player_id=$1 AND instance_id=$2::uuid
           FOR UPDATE`,
          [input.playerId, input.backpackInstanceId]
        );
        const item = locked.rows[0];
        if (!item || item.location === "destroyed") {
          throw new ManorError("BACKPACK_NOT_OWNED", "That backpack is no longer owned.");
        }
        let slotBefore: number | null = null;
        let slotAfter: number | null = null;
        const inventorySlotBefore = item.inventory_slot_index;
        const inventorySlotAfter: number | null = null;
        if (input.direction === "deposit") {
          if (item.location !== "inventory" && item.location !== "equipped") {
            throw new ManorError(
              "BACKPACK_NOT_STORABLE",
              "That backpack is not in Player Inventory."
            );
          }
          if (await manorStorageWeightRemaining(client, manorId) < BigInt(getBackpackWeightGrams())) {
            throw new ManorError("MANOR_STORAGE_FULL", "Manor Storage does not have room for that backpack.");
          }
          slotAfter = await nextManorStoragePosition(client, manorId);
          await client.query(
            `UPDATE player_backpack_instances
             SET location='manor_storage',equipped_slot=NULL,inventory_slot_index=NULL,
                 manor_id=$3,manor_slot_index=$4,version=version+1,updated_at=now()
             WHERE owner_player_id=$1 AND instance_id=$2::uuid`,
            [input.playerId, input.backpackInstanceId, manorId, slotAfter]
          );
        } else {
          if (item.location !== "manor_storage" || item.manor_id !== manorId) {
            throw new ManorError(
              "BACKPACK_NOT_IN_STORAGE",
              "That backpack is not in this Manor Storage."
            );
          }
          slotBefore = item.manor_slot_index;
          await assertInventoryWeightInTransaction(client, input.playerId, BigInt(getBackpackWeightGrams()));
          await client.query(
            `UPDATE player_backpack_instances
             SET location='inventory',inventory_slot_index=$3,
                 manor_id=NULL,manor_slot_index=NULL,version=version+1,updated_at=now()
             WHERE owner_player_id=$1 AND instance_id=$2::uuid`,
            [input.playerId, input.backpackInstanceId, inventorySlotAfter]
          );
        }
        await advanceBackpackRevision(client, input.playerId);
        await lockInventoryCapacity(client, input.playerId);
        await client.query(
          `INSERT INTO manor_storage_backpack_events
           (operation_key,manor_id,player_id,backpack_instance_id,direction,
            slot_before,slot_after,inventory_slot_before,inventory_slot_after)
           VALUES ($1,$2,$3,$4::uuid,$5,$6,$7,$8,$9)`,
          [
            operationKey,
            manorId,
            input.playerId,
            input.backpackInstanceId,
            input.direction,
            slotBefore,
            slotAfter,
            inventorySlotBefore,
            inventorySlotAfter
          ]
        );
        return {
          transfer: transferSummary(input.direction, 1, 1n, 1, 1n, null),
          message: input.direction === "deposit"
            ? "Backpack stored."
            : "Backpack taken."
        };
      }
    );
  }

  bulkTransfer(
    playerId: string,
    requestId: string,
    direction: ManorTransferDirection
  ): Promise<ManorStorageResult> {
    const action: ManorStorageAction = direction === "deposit" ? "bulk_store" : "bulk_take";
    return this.runOperation(playerId, requestId, action, { direction }, async (
      client, manorId, operationKey
    ) => {
      const summary = direction === "deposit"
        ? await this.bulkStore(client, manorId, operationKey, playerId, requestId)
        : await this.bulkTake(client, manorId, operationKey, playerId, requestId);
      const destination = direction === "deposit" ? "Manor Storage" : "Player Inventory";
      const verb = direction === "deposit" ? "Stored" : "Took";
      const skippedReasons = [...new Set(summary.skipped.map((item) => item.reason))];
      const message = summary.partial
        ? `${verb} ${summary.stacksMoved} ${summary.stacksMoved === 1 ? "stack" : "stacks"}. ` +
          `${summary.stacksRemaining} ${summary.stacksRemaining === 1 ? "stack remained" : "stacks remained"}` +
          (skippedReasons.length > 0
            ? `: ${skippedReasons.join(" ")}`
            : ` because ${destination} is full.`)
        : `${verb} everything.`;
      return { transfer: summary, message };
    });
  }

  private async runOperation(
    playerId: string,
    requestId: string,
    action: ManorStorageAction,
    payload: Record<string, unknown>,
    work: (
      client: pg.PoolClient,
      manorId: string,
      operationKey: string
    ) => Promise<StorageOperationWork>
  ): Promise<ManorStorageResult> {
    if (!requestId || requestId.length > 128) {
      throw new ManorError("INVALID_REQUEST", "A valid request ID is required.");
    }
    this.ensureStorageMutationAllowed();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [playerId]
      );
      const presence = await this.requireOwnedPresence(client, playerId);
      await lockInventoryCapacity(client, playerId);
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 676))", [
        JSON.stringify([presence.manor_id, playerId])
      ]);
      const conflicting = await client.query(
        `SELECT 1 FROM manor_placement_operations WHERE player_id=$1 AND request_id=$2
         UNION ALL
         SELECT 1 FROM manor_transfer_operations WHERE player_id=$1 AND request_id=$2
         LIMIT 1`,
        [playerId, requestId]
      );
      if (conflicting.rowCount) {
        throw new ManorError("REPLAY_CONFLICT", "That request ID was already used for a different manor operation.");
      }
      const operationKey = operationKeyFor(playerId, requestId);
      const requestHash = storageRequestHash(action, playerId, payload);
      const inserted = await client.query<OperationRow>(
        `INSERT INTO manor_storage_operations
           (operation_key,player_id,manor_id,request_id,action,request_hash)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT DO NOTHING
         RETURNING operation_key,player_id,manor_id,request_hash,original_result`,
        [operationKey, playerId, presence.manor_id, requestId, action, requestHash]
      );
      if (inserted.rowCount === 0) {
        const replay = await client.query<OperationRow>(
          `SELECT operation_key,player_id,manor_id,request_hash,original_result
           FROM manor_storage_operations
           WHERE player_id=$1 AND request_id=$2
           FOR UPDATE`,
          [playerId, requestId]
        );
        const row = replay.rows[0];
        if (!row || row.manor_id !== presence.manor_id || row.request_hash !== requestHash) {
          throw new ManorError("REPLAY_CONFLICT", "That request ID was already used for a different storage action.");
        }
        if (!row.original_result) {
          throw new ManorError("OPERATION_INCOMPLETE", "The original storage action did not complete.");
        }
        await client.query("COMMIT");
        return { ...row.original_result, replayed: true };
      }

      await normalizeManorStorageStacks(client, presence.manor_id);
      const completed = await work(client, presence.manor_id, operationKey);
      const equipment = await this.equipment.snapshotInTransaction(client, playerId);
      const backpacks = await this.backpacks.snapshotInTransaction(client, playerId);
      const result: ManorStorageResult = {
        requestId,
        action,
        inventory: await this.inventory.snapshotInTransaction(client, playerId),
        equipment,
        backpacks,
        storage: await storageSnapshot(
          client,
          presence.manor_id,
          equipment,
          backpacks
        ),
        transfer: completed.transfer,
        replayed: false,
        message: completed.message
      };
      await client.query(
        `UPDATE manor_storage_operations
         SET original_result=$2::jsonb,completed_at=now()
         WHERE operation_key=$1`,
        [operationKey, JSON.stringify(result)]
      );
      await client.query("COMMIT");
      this.equipment.installAuthoritativeSnapshot(playerId, equipment);
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw mapTransferError(error);
    } finally {
      client.release();
    }
  }

  private async storePlayerStack(
    client: pg.PoolClient,
    manorId: string,
    operationKey: string,
    input: ReturnType<typeof normalizeTransfer>
  ): Promise<ManorTransferSummary> {
    await lockInventoryProtection(client, input.playerId);
    const source = await playerInventoryStack(client, input.playerId, input.sourceStackId);
    if (!source) throw new ManorError("INVENTORY_STACK_NOT_FOUND", "That inventory stack is no longer available.");
    if (!requireItemDefinition(source.resource_type).manorStorable) {
      throw new ManorError("ITEM_NOT_MANOR_STORABLE", "That item cannot be stored in a manor.");
    }
    if (input.quantity > BigInt(source.quantity)) {
      throw new ManorError("INSUFFICIENT_INVENTORY", "That inventory stack no longer contains the requested quantity.");
    }
    const protection = await materialProtectionAllocation(client, input.playerId);
    const allocation = protection.byStackId.get(source.stack_id);
    const movable = BigInt(allocation?.movableQuantity ?? source.quantity);
    if (input.quantity > movable) {
      throw new ManorError(
        "ITEM_PROTECTED",
        source.resource_type === MANOR_SKIN_ITEM_ID && movable === 0n && allocation?.reason
          ? allocation.reason
          : `Only ${movable.toLocaleString()} can be stored; the rest is protected.`
      );
    }
    const capacity = await manorCapacityFor(
      client, manorId, source.resource_type, source.variant
    );
    if (capacity < input.quantity) {
      throw new ManorError("MANOR_STORAGE_FULL", "Manor Storage does not have room for that quantity.");
    }
    await this.inventory.debitItemsForOperationInTransaction(client, {
      operationKey: `${operationKey}:inventory`,
      playerId: input.playerId,
      source: "manor_stack_deposit",
      sourceEntityType: "player_manor",
      sourceEntityId: manorId,
      metadata: { requestId: input.requestId, sourceStackId: input.sourceStackId },
      debits: [{
        itemId: source.resource_type as ResourceType,
        variant: protocolVariant(source.variant),
        quantity: input.quantity
      }],
      preferredStackId: input.sourceStackId
    });
    this.failureHook?.("after-inventory-debit");
    await this.addToStorage(
      client,
      manorId,
      operationKey,
      input.playerId,
      source.resource_type,
      source.variant,
      input.quantity,
      false,
      "transfer"
    );
    this.failureHook?.("after-destination-write");
    return transferSummary(input.direction, 1, input.quantity, 1, input.quantity, null);
  }

  private async takeManorStack(
    client: pg.PoolClient,
    manorId: string,
    operationKey: string,
    input: ReturnType<typeof normalizeTransfer>
  ): Promise<ManorTransferSummary> {
    const source = await storageStack(client, manorId, input.sourceStackId);
    if (!source) throw new ManorError("MANOR_STORAGE_STACK_NOT_FOUND", "That storage stack is no longer available.");
    if (input.quantity > BigInt(source.quantity)) {
      throw new ManorError("INSUFFICIENT_STORAGE", "That storage stack no longer contains the requested quantity.");
    }
    const capacity = await playerCapacityFor(
      client, input.playerId, source.item_id, source.variant
    );
    if (capacity < input.quantity) {
      throw new ManorError("PLAYER_INVENTORY_FULL", "Player Inventory does not have room for that quantity.");
    }
    await this.debitStorageStack(
      client, operationKey, input.playerId, manorId, source, input.quantity, "transfer"
    );
    this.failureHook?.("after-storage-debit");
    await this.inventory.grantItemsForOperationInTransaction(client, {
      operationKey: `${operationKey}:inventory`,
      playerId: input.playerId,
      source: "manor_stack_withdrawal",
      sourceEntityType: "player_manor",
      sourceEntityId: manorId,
      metadata: { requestId: input.requestId, sourceStackId: input.sourceStackId },
      grants: [{
        itemId: source.item_id as ResourceType,
        variant: protocolVariant(source.variant),
        quantity: input.quantity
      }]
    });
    this.failureHook?.("after-destination-write");
    return transferSummary(input.direction, 1, input.quantity, 1, input.quantity, null);
  }

  private async bulkStore(
    client: pg.PoolClient,
    manorId: string,
    operationKey: string,
    playerId: string,
    requestId: string
  ): Promise<ManorTransferSummary> {
    await lockInventoryProtection(client, playerId);
    const sources = await client.query<PlayerInventoryEntryRow>(
      `${PLAYER_ENTRY_SELECT}
       FROM player_inventory stack
       WHERE stack.player_id=$1
       ORDER BY stack.resource_type,stack.variant,stack.entry_id
       FOR UPDATE`,
      [playerId]
    );
    let requestedQuantity = sumQuantities(sources.rows);
    const protection = await materialProtectionAllocation(client, playerId);
    let movedQuantity = 0n;
    let movedStacks = 0;
    let remainingStacks = 0;
    const skipped: ManorTransferSummary["skipped"] = [];
    for (const source of sources.rows) {
      const definition = requireItemDefinition(source.resource_type);
      if (!definition.manorStorable) {
        remainingStacks += 1;
        skipped.push({
          sourceId: source.stack_id,
          kind: "stack",
          reason: "This item cannot be stored in a manor.",
          quantity: inventoryQuantityToSafeNumber(source.quantity)
        });
        continue;
      }
      const protectedQuantity = BigInt(
        protection.byStackId.get(source.stack_id)?.protectedQuantity ?? 0
      );
      const protectedReason = (source.resource_type === MANOR_SKIN_ITEM_ID
        ? protection.byStackId.get(source.stack_id)?.reason
        : null) ?? "Protected by your keep amount.";
      const movableQuantity = BigInt(source.quantity) - protectedQuantity;
      const available = await manorCapacityFor(
        client, manorId, source.resource_type, source.variant
      );
      const moved = minBigInt(movableQuantity, available);
      if (moved === 0n) {
        remainingStacks += 1;
        skipped.push({
          sourceId: source.stack_id,
          kind: "stack",
          reason: movableQuantity === 0n
            ? protectedReason
            : "Manor Storage is full.",
          quantity: inventoryQuantityToSafeNumber(source.quantity)
        });
        continue;
      }
      await this.inventory.debitItemsForOperationInTransaction(client, {
        operationKey: `${operationKey}:inventory:${source.stack_id}`,
        playerId,
        source: "manor_bulk_store",
        sourceEntityType: "player_manor",
        sourceEntityId: manorId,
        metadata: { requestId, sourceStackId: source.stack_id },
        debits: [{
          itemId: source.resource_type as ResourceType,
          variant: protocolVariant(source.variant),
          quantity: moved
        }],
        preferredStackId: source.stack_id
      });
      await this.addToStorage(
        client,
        manorId,
        operationKey,
        playerId,
        source.resource_type,
        source.variant,
        moved,
        false,
        "bulk_store"
      );
      movedStacks += 1;
      movedQuantity += moved;
      if (moved < BigInt(source.quantity)) {
        remainingStacks += 1;
        skipped.push({
          sourceId: source.stack_id,
          kind: "stack",
          reason: moved < movableQuantity
            ? "Manor Storage filled before the stack could be stored."
            : protectedReason,
          quantity: inventoryQuantityToSafeNumber(BigInt(source.quantity) - moved)
        });
      }
    }
    const equipmentSources = await client.query<{
      instance_id: string;
      definition_id: string;
      location: "inventory" | "equipped";
      inventory_slot_index: number | null;
      manor_storable: boolean;
      protected: boolean;
      saved_in_kit: boolean;
    }>(
      `SELECT equipment.instance_id::text,equipment.definition_id,equipment.location,
              equipment.inventory_slot_index,
              definition.manor_storable,
              COALESCE(protection.protected,false) AS protected,
              EXISTS (
                SELECT 1 FROM combat_kit_items kit
                WHERE kit.player_id=equipment.owner_player_id
                  AND kit.instance_id=equipment.instance_id
              ) AS saved_in_kit
       FROM equipment_instances equipment
       JOIN item_definitions definition ON definition.item_id=equipment.definition_id
       LEFT JOIN player_unique_item_protections protection
         ON protection.player_id=equipment.owner_player_id
        AND protection.equipment_instance_id=equipment.instance_id
       WHERE equipment.owner_player_id=$1
         AND equipment.location IN ('inventory','equipped')
       ORDER BY equipment.definition_id,equipment.instance_id
       FOR UPDATE OF equipment`,
      [playerId]
    );
    requestedQuantity += BigInt(equipmentSources.rows.length);
    let movedEquipment = 0;
    for (const item of equipmentSources.rows) {
      const reason = item.location === "equipped"
        ? "Equipped equipment."
        : item.protected
        ? "Protected equipment."
        : item.saved_in_kit
          ? "Referenced by a saved combat kit."
          : !item.manor_storable
            ? "This equipment cannot be stored."
            : null;
      if (reason) {
        remainingStacks += 1;
        skipped.push({
          sourceId: item.instance_id,
          kind: "equipment",
          reason,
          quantity: 1
        });
        continue;
      }
      const targetSlot = await nextManorStoragePosition(client, manorId);
      if (await manorStorageWeightRemaining(client, manorId) < BigInt(requireRuntimeItemDefinition(item.definition_id).unitWeightGrams)) {
        remainingStacks += 1;
        skipped.push({
          sourceId: item.instance_id,
          kind: "equipment",
          reason: "Manor Storage is full.",
          quantity: 1
        });
        continue;
      }
      await client.query(
        `UPDATE equipment_instances
         SET location='manor_storage',equipped_slot=NULL,inventory_slot_index=NULL,
             manor_id=$3,manor_slot_index=$4,updated_at=now()
         WHERE owner_player_id=$1 AND instance_id=$2::uuid`,
        [playerId, item.instance_id, manorId, targetSlot]
      );
      await client.query(
        `INSERT INTO manor_storage_equipment_events
         (operation_key,manor_id,player_id,equipment_instance_id,direction,
          slot_before,slot_after,inventory_slot_before,inventory_slot_after)
         VALUES ($1,$2,$3,$4::uuid,'deposit',NULL,$5,$6,NULL)`,
        [operationKey, manorId, playerId, item.instance_id, targetSlot, item.inventory_slot_index]
      );
      movedEquipment += 1;
      movedStacks += 1;
      movedQuantity += 1n;
    }
    if (movedEquipment > 0) {
      await client.query(
        `UPDATE player_equipment_state
         SET inventory_revision=inventory_revision+1 WHERE player_id=$1`,
        [playerId]
      );
    }
    const backpackSources = await client.query<{
      instance_id: string;
      inventory_slot_index: number;
      equipped_slot: number | null;
    }>(
      `SELECT instance_id::text,inventory_slot_index,equipped_slot
       FROM player_backpack_instances
       WHERE owner_player_id=$1 AND location IN ('inventory','equipped')
       ORDER BY definition_id,instance_id
       FOR UPDATE`,
      [playerId]
    );
    requestedQuantity += BigInt(backpackSources.rows.length);
    let movedBackpacks = 0;
    for (const item of backpackSources.rows) {
      const targetSlot = await nextManorStoragePosition(client, manorId);
      if (await manorStorageWeightRemaining(client, manorId) < BigInt(getBackpackWeightGrams())) {
        remainingStacks += 1;
        skipped.push({
          sourceId: item.instance_id,
          kind: "backpack",
          reason: "Manor Storage is full.",
          quantity: 1
        });
        continue;
      }
      await client.query(
        `UPDATE player_backpack_instances
         SET location='manor_storage',equipped_slot=NULL,inventory_slot_index=NULL,
             manor_id=$3,manor_slot_index=$4,version=version+1,updated_at=now()
         WHERE owner_player_id=$1 AND instance_id=$2::uuid`,
        [playerId, item.instance_id, manorId, targetSlot]
      );
      await client.query(
        `INSERT INTO manor_storage_backpack_events
         (operation_key,manor_id,player_id,backpack_instance_id,direction,
          slot_before,slot_after,inventory_slot_before,inventory_slot_after)
         VALUES ($1,$2,$3,$4::uuid,'deposit',NULL,$5,$6,NULL)`,
        [operationKey, manorId, playerId, item.instance_id, targetSlot, item.inventory_slot_index]
      );
      movedBackpacks += 1;
      movedStacks += 1;
      movedQuantity += 1n;
    }
    if (movedBackpacks > 0) {
      await advanceBackpackRevision(client, playerId);
      await lockInventoryCapacity(client, playerId);
    }
    this.failureHook?.("after-destination-write");
    return transferSummary(
      "deposit",
      sources.rows.length + equipmentSources.rows.length + backpackSources.rows.length,
      requestedQuantity,
      movedStacks,
      movedQuantity,
      remainingStacks > 0 ? "Manor Storage is full." : null,
      remainingStacks,
      skipped
    );
  }

  private async bulkTake(
    client: pg.PoolClient,
    manorId: string,
    operationKey: string,
    playerId: string,
    requestId: string
  ): Promise<ManorTransferSummary> {
    const sources = await client.query<StackRow>(
      `${STORAGE_STACK_SELECT}
       FROM manor_storage_stacks stack
       WHERE stack.manor_id=$1
       ORDER BY stack.slot_index
       FOR UPDATE`,
      [manorId]
    );
    let requestedQuantity = sumQuantities(sources.rows);
    let movedQuantity = 0n;
    let movedStacks = 0;
    let remainingStacks = 0;
    const skipped: ManorTransferSummary["skipped"] = [];
    for (const source of sources.rows) {
      const available = await playerCapacityFor(client, playerId, source.item_id, source.variant);
      const moved = minBigInt(BigInt(source.quantity), available);
      if (moved === 0n) {
        remainingStacks += 1;
        skipped.push({
          sourceId: source.stack_id,
          kind: "stack",
          reason: "Carrying capacity is full.",
          quantity: inventoryQuantityToSafeNumber(source.quantity)
        });
        continue;
      }
      await this.debitStorageStack(
        client, operationKey, playerId, manorId, source, moved, "bulk_take"
      );
      await this.inventory.grantItemsForOperationInTransaction(client, {
        operationKey: `${operationKey}:inventory:${source.stack_id}`,
        playerId,
        source: "manor_bulk_take",
        sourceEntityType: "player_manor",
        sourceEntityId: manorId,
        metadata: { requestId, sourceStackId: source.stack_id },
        grants: [{
          itemId: source.item_id as ResourceType,
          variant: protocolVariant(source.variant),
          quantity: moved
        }]
      });
      movedStacks += 1;
      movedQuantity += moved;
      if (moved < BigInt(source.quantity)) remainingStacks += 1;
    }
    const equipmentSources = await client.query<{
      instance_id: string;
      definition_id: string;
      manor_slot_index: number;
    }>(
      `SELECT instance_id::text,definition_id,manor_slot_index
       FROM equipment_instances
       WHERE owner_player_id=$1 AND location='manor_storage' AND manor_id=$2
       ORDER BY manor_slot_index,instance_id
       FOR UPDATE`,
      [playerId, manorId]
    );
    requestedQuantity += BigInt(equipmentSources.rows.length);
    let movedEquipment = 0;
    for (const item of equipmentSources.rows) {
      const fits = await fittingInventoryQuantityInTransaction(client, playerId, item.definition_id, 1n);
      if (fits === 0n) {
        remainingStacks += 1;
        skipped.push({
          sourceId: item.instance_id,
          kind: "equipment",
          reason: "Carrying capacity is full.",
          quantity: 1
        });
        continue;
      }
      await client.query(
        `UPDATE equipment_instances
         SET location='inventory',equipped_slot=NULL,inventory_slot_index=$3,
             manor_id=NULL,manor_slot_index=NULL,updated_at=now()
         WHERE owner_player_id=$1 AND instance_id=$2::uuid`,
        [playerId, item.instance_id, null]
      );
      await client.query(
        `INSERT INTO manor_storage_equipment_events
         (operation_key,manor_id,player_id,equipment_instance_id,direction,
          slot_before,slot_after,inventory_slot_before,inventory_slot_after)
         VALUES ($1,$2,$3,$4::uuid,'withdrawal',$5,NULL,NULL,$6)`,
        [operationKey, manorId, playerId, item.instance_id, item.manor_slot_index, null]
      );
      movedEquipment += 1;
      movedStacks += 1;
      movedQuantity += 1n;
    }
    if (movedEquipment > 0) {
      await client.query(
        `UPDATE player_equipment_state
         SET inventory_revision=inventory_revision+1 WHERE player_id=$1`,
        [playerId]
      );
    }
    const backpackSources = await client.query<{
      instance_id: string;
      definition_id: string;
      manor_slot_index: number;
    }>(
      `SELECT instance_id::text,definition_id,manor_slot_index
       FROM player_backpack_instances
       WHERE owner_player_id=$1 AND location='manor_storage' AND manor_id=$2
       ORDER BY manor_slot_index,instance_id
       FOR UPDATE`,
      [playerId, manorId]
    );
    requestedQuantity += BigInt(backpackSources.rows.length);
    let movedBackpacks = 0;
    for (const item of backpackSources.rows) {
      const carry = await inventoryWeightSnapshotInTransaction(client, playerId);
      if (carry.currentWeightGrams + BigInt(getBackpackWeightGrams()) > carry.allowedWeightGrams) {
        remainingStacks += 1;
        skipped.push({
          sourceId: item.instance_id,
          kind: "backpack",
          reason: "Carrying capacity is full.",
          quantity: 1
        });
        continue;
      }
      await client.query(
        `UPDATE player_backpack_instances
         SET location='inventory',equipped_slot=NULL,inventory_slot_index=$3,
             manor_id=NULL,manor_slot_index=NULL,version=version+1,updated_at=now()
         WHERE owner_player_id=$1 AND instance_id=$2::uuid`,
        [playerId, item.instance_id, null]
      );
      await client.query(
        `INSERT INTO manor_storage_backpack_events
         (operation_key,manor_id,player_id,backpack_instance_id,direction,
          slot_before,slot_after,inventory_slot_before,inventory_slot_after)
         VALUES ($1,$2,$3,$4::uuid,'withdrawal',$5,NULL,NULL,$6)`,
        [operationKey, manorId, playerId, item.instance_id, item.manor_slot_index, null]
      );
      movedBackpacks += 1;
      movedStacks += 1;
      movedQuantity += 1n;
    }
    if (movedBackpacks > 0) {
      await advanceBackpackRevision(client, playerId);
      await lockInventoryCapacity(client, playerId);
    }
    this.failureHook?.("after-destination-write");
    return transferSummary(
      "withdrawal",
      sources.rows.length + equipmentSources.rows.length + backpackSources.rows.length,
      requestedQuantity,
      movedStacks,
      movedQuantity,
      remainingStacks > 0 ? "Carrying capacity is full." : null,
      remainingStacks,
      skipped
    );
  }

  private async addToStorage(
    client: pg.PoolClient,
    manorId: string,
    operationKey: string,
    playerId: string,
    itemId: string,
    variant: string,
    quantity: bigint,
    preserveManualSplit: boolean,
    action: "transfer" | "bulk_store"
  ): Promise<void> {
    let remaining = quantity;
    const maximum = maximumStack(itemId);
    if (preserveManualSplit && remaining <= maximum) {
      const freeSlot = await nextManorStoragePosition(client, manorId);
      const inserted = await client.query<StackRow>(
          `INSERT INTO manor_storage_stacks
             (manor_id,slot_index,item_id,variant,quantity,manual_split)
           VALUES ($1,$2,$3,$4,$5::bigint,true)
           RETURNING stack_id,manor_id,slot_index,item_id,variant,quantity::text,
                     manual_split,version::text`,
          [manorId, freeSlot, itemId, variant, remaining.toString()]
        );
      await this.writeStackEvent(
        client, operationKey, playerId, manorId, action, null,
        { stack: requireRow(inserted.rows[0], "Manor storage insert returned no stack") }
      );
      return;
    }
    const compatible = await client.query<StackRow>(
      `${STORAGE_STACK_SELECT}
       FROM manor_storage_stacks stack
       WHERE stack.manor_id=$1 AND stack.item_id=$2 AND stack.variant=$3
         AND stack.manual_split=false AND stack.quantity<$4::bigint
       ORDER BY stack.slot_index
       FOR UPDATE`,
      [manorId, itemId, variant, maximum.toString()]
    );
    for (const target of compatible.rows) {
      const moved = minBigInt(remaining, maximum - BigInt(target.quantity));
      if (moved === 0n) continue;
      await client.query(
        `UPDATE manor_storage_stacks
         SET quantity=quantity+$2::bigint,version=version+1,updated_at=now()
         WHERE stack_id=$1::uuid`,
        [target.stack_id, moved.toString()]
      );
      await this.writeStackEvent(client, operationKey, playerId, manorId, action, target, {
        quantity: BigInt(target.quantity) + moved
      });
      remaining -= moved;
      if (remaining === 0n) return;
    }
    while (remaining > 0n) {
      const freeSlot = await nextManorStoragePosition(client, manorId);
      const moved = minBigInt(remaining, maximum);
      const inserted = await client.query<StackRow>(
        `INSERT INTO manor_storage_stacks
           (manor_id,slot_index,item_id,variant,quantity,manual_split)
         VALUES ($1,$2,$3,$4,$5::bigint,false)
         RETURNING stack_id,manor_id,slot_index,item_id,variant,quantity::text,
                   manual_split,version::text`,
        [manorId, freeSlot, itemId, variant, moved.toString()]
      );
      await this.writeStackEvent(
        client, operationKey, playerId, manorId, action, null,
        { stack: requireRow(inserted.rows[0], "Manor storage insert returned no stack") }
      );
      remaining -= moved;
    }
  }

  private async debitStorageStack(
    client: pg.PoolClient,
    operationKey: string,
    playerId: string,
    manorId: string,
    source: StackRow,
    quantity: bigint,
    action: ManorStorageAction
  ): Promise<void> {
    const remaining = BigInt(source.quantity) - quantity;
    if (remaining === 0n) {
      await client.query(
        "DELETE FROM manor_storage_stacks WHERE manor_id=$1 AND stack_id=$2::uuid",
        [manorId, source.stack_id]
      );
      await this.writeStackEvent(client, operationKey, playerId, manorId, action, source, {
        deleted: true
      });
    } else {
      await client.query(
        `UPDATE manor_storage_stacks
         SET quantity=$3::bigint,version=version+1,updated_at=now()
         WHERE manor_id=$1 AND stack_id=$2::uuid`,
        [manorId, source.stack_id, remaining.toString()]
      );
      await this.writeStackEvent(client, operationKey, playerId, manorId, action, source, {
        quantity: remaining
      });
    }
  }

  private async writeStackEvent(
    client: pg.PoolClient,
    operationKey: string,
    playerId: string,
    manorId: string,
    action: ManorStorageAction,
    before: StackRow | null,
    after: {
      stack?: StackRow;
      slotIndex?: number;
      quantity?: bigint;
      manualSplit?: boolean;
      deleted?: boolean;
    },
    relatedStackId?: string
  ): Promise<void> {
    const next = after.stack;
    await client.query(
      `INSERT INTO manor_storage_stack_events
       (operation_key,manor_id,player_id,action,stack_id,related_stack_id,item_id,variant,
        slot_before,slot_after,quantity_before,quantity_after,
        manual_split_before,manual_split_after,metadata)
       VALUES ($1,$2,$3,$4,$5::uuid,$6::uuid,$7,$8,$9,$10,$11::bigint,$12::bigint,
               $13,$14,$15::jsonb)`,
      [
        operationKey,
        manorId,
        playerId,
        action,
        before?.stack_id ?? next?.stack_id ?? null,
        relatedStackId ?? null,
        before?.item_id ?? next?.item_id ?? null,
        before?.variant ?? next?.variant ?? null,
        before?.slot_index ?? null,
        after.deleted ? null : after.slotIndex ?? next?.slot_index ?? before?.slot_index ?? null,
        before?.quantity ?? null,
        after.deleted ? null : (after.quantity ?? (next ? BigInt(next.quantity) : before ? BigInt(before.quantity) : null))?.toString() ?? null,
        before?.manual_split ?? null,
        after.deleted ? null : after.manualSplit ?? next?.manual_split ?? before?.manual_split ?? null,
        JSON.stringify({ deleted: after.deleted === true })
      ]
    );
  }

  private async requireOwnedPresence(
    queryable: Pick<pg.Pool | pg.PoolClient, "query">,
    playerId: string
  ): Promise<PresenceRow> {
    const result = await queryable.query<PresenceRow>(
      `SELECT p.player_id,p.manor_id,m.owner_player_id,p.access_source,
              p.admission_travel_invite_id,p.return_region_code,p.return_lat,p.return_lon,
              p.local_position_x,p.local_position_y
       FROM player_manor_presence p
       JOIN player_manors m ON m.id=p.manor_id
       WHERE p.player_id=$1 AND m.owner_player_id=$1 AND m.built_at IS NOT NULL`,
      [playerId]
    );
    if (!result.rows[0]) throw new ManorError("NOT_INSIDE", "You are not inside your manor.");
    return result.rows[0];
  }
}

export type ManorRuntimeSession = {
  playerId: string;
  manorId: string;
  spaceId: ManorSpaceId;
  accessSource: ManorOccupantAccessSource;
  sessionId: string;
  position: ManorPosition;
  movementSequence: number;
};

type ManorPositionPersistence = (
  playerId: string,
  manorId: string,
  x: number,
  y: number,
  spaceId?: ManorSpaceId
) => Promise<unknown>;

type ManorPersistenceState = {
  sessionId: string;
  dirty: boolean;
  lastFlushAt: number;
  inFlight: Promise<void> | null;
};

const MANOR_POSITION_FLUSH_INTERVAL_MS = 2_000;

export class ManorRuntime {
  private readonly sessions = new Map<string, ManorRuntimeSession>();
  private readonly routes = new Map<string, IndoorPoint[]>();
  private readonly manorNavigations = new Map<string, IndoorRoomNavigation>();
  private readonly persistence = new Map<string, ManorPersistenceState>();
  /** Manor type per Manor id, installed by entry and reconnect (absent: the default type). */
  private readonly manorTypes = new Map<string, string>();
  private navigationProvider: ((manorId: string, spaceId: ManorSpaceId) => IndoorRoomNavigation | null) | null = null;
  private readonly movementSettledListeners = new Map<string, Set<{
    listener: () => void;
    observedMovement: boolean;
    movementSequence: number;
  }>>();

  constructor(
    private readonly persistPosition?: ManorPositionPersistence,
    private readonly onPersistenceError?: (
      error: unknown,
      context: { playerId: string; manorId: string }
    ) => void
  ) {}

  enter(
    playerId: string,
    manorId: string,
    accessSource: ManorOccupantAccessSource = "OWNER",
    spaceId: ManorSpaceId = "manor_main_room"
  ): ManorRuntimeSession {
    this.routes.delete(playerId);
    const position = this.nextSpawn(manorId, spaceId);
    const session: ManorRuntimeSession = {
      playerId,
      manorId,
      spaceId,
      accessSource,
      sessionId: randomUUID(),
      position: { ...position, targetX: null, targetY: null, moving: false, revision: 0 },
      movementSequence: 0
    };
    this.sessions.set(playerId, session);
    this.persistence.set(playerId, {
      sessionId: session.sessionId,
      dirty: false,
      lastFlushAt: Date.now(),
      inFlight: null
    });
    return cloneSession(session);
  }

  restore(
    playerId: string,
    manorId: string,
    accessSource: ManorOccupantAccessSource = "OWNER",
    savedPosition?: { x: number | null; y: number | null },
    spaceId: ManorSpaceId = "manor_main_room"
  ): ManorRuntimeSession {
    this.routes.delete(playerId);
    const current = this.sessions.get(playerId);
    const room = this.navigationFor(manorId, spaceId);
    const restoredPosition =
      current?.manorId === manorId && current.spaceId === spaceId &&
        isIndoorNavigationPointWalkable(room, current.position)
        ? { x: current.position.x, y: current.position.y }
        : savedPosition &&
            savedPosition.x !== null &&
            savedPosition.y !== null &&
            isIndoorNavigationPointWalkable(room, { x: savedPosition.x, y: savedPosition.y })
          ? { x: savedPosition.x, y: savedPosition.y }
          : this.nextSpawn(manorId, spaceId);
    const session: ManorRuntimeSession = {
      playerId,
      manorId,
      spaceId,
      accessSource,
      sessionId: randomUUID(),
      position: {
        ...restoredPosition,
        targetX: null,
        targetY: null,
        moving: false,
        revision: 0
      },
      movementSequence: 0
    };
    this.sessions.set(playerId, session);
    this.persistence.set(playerId, {
      sessionId: session.sessionId,
      dirty: Boolean(current),
      lastFlushAt: Date.now(),
      inFlight: this.persistence.get(playerId)?.inFlight ?? null
    });
    if (current) this.schedulePersistence(session, true);
    return cloneSession(session);
  }
  restoreSession(session: ManorRuntimeSession): ManorRuntimeSession {
    this.routes.delete(session.playerId);
    const restored = cloneSession(session);
    this.sessions.set(session.playerId, restored);
    this.persistence.set(session.playerId, {
      sessionId: session.sessionId,
      dirty: true,
      lastFlushAt: Date.now(),
      inFlight: null
    });
    return cloneSession(restored);
  }
  exit(playerId: string, sessionId: string): ManorRuntimeSession {
    const session = this.requireSession(playerId, sessionId);
    this.sessions.delete(playerId);
    this.routes.delete(playerId);
    this.persistence.delete(playerId);
    this.movementSettledListeners.delete(playerId);
    return cloneSession(session);
  }
  isInside(playerId: string): boolean { return this.sessions.has(playerId); }
  async disconnect(playerId: string, sessionId: string): Promise<void> {
    if (!this.hasSession(playerId, sessionId)) return;
    await this.flush(playerId, sessionId);
    if (!this.hasSession(playerId, sessionId)) return;
    this.sessions.delete(playerId);
    this.routes.delete(playerId);
    if (this.persistence.get(playerId)?.sessionId === sessionId) {
      this.persistence.delete(playerId);
    }
    this.movementSettledListeners.delete(playerId);
  }
  async flush(playerId: string, sessionId: string): Promise<void> {
    let forced = false;
    while (this.hasSession(playerId, sessionId)) {
      const state = this.persistence.get(playerId);
      if (!state || state.sessionId !== sessionId) return;
      if (state.inFlight) {
        await state.inFlight;
        if (!this.hasSession(playerId, sessionId)) return;
        continue;
      }
      if (!state.dirty || forced) return;
      const session = this.sessions.get(playerId);
      if (!session || session.sessionId !== sessionId) return;
      forced = true;
      this.schedulePersistence(session, true);
    }
  }
  async flushAll(): Promise<void> {
    await Promise.all(
      [...this.sessions.values()].map(({ playerId, sessionId }) =>
        this.flush(playerId, sessionId))
    );
  }
  get(playerId: string): ManorRuntimeSession | null {
    const value = this.sessions.get(playerId);
    return value ? cloneSession(value) : null;
  }
  /** Install the latest authoritative shared navigation view for a Manor room. */
  setManorNavigation(
    manorId: string,
    spaceId: ManorSpaceId,
    navigation: IndoorRoomNavigation
  ): void {
    this.manorNavigations.set(`${manorId}:${spaceId}`, navigation);
    for (const session of this.sessions.values()) {
      if (session.manorId === manorId && session.spaceId === spaceId) {
        this.routes.delete(session.playerId);
      }
    }
  }
  /** Install the Manor type of a Manor before sessions enter or restore in it. */
  setManorType(manorId: string, manorTypeId: string | null | undefined): void {
    const typeId = resolveManorTypeId(manorTypeId);
    if (this.manorTypes.get(manorId) === typeId) return;
    this.manorTypes.set(manorId, typeId);
    for (const key of [...this.manorNavigations.keys()]) {
      if (key.startsWith(`${manorId}:`)) this.manorNavigations.delete(key);
    }
  }
  manorTypeOf(manorId: string): string {
    return resolveManorTypeId(this.manorTypes.get(manorId));
  }
  /** Room navigation including placed decorations, for rooms whose view was not installed explicitly. */
  useNavigationProvider(provider: (manorId: string, spaceId: ManorSpaceId) => IndoorRoomNavigation | null): void {
    this.navigationProvider = provider;
  }
  playerIdsInManor(manorId: string): string[] {
    return [...this.sessions.values()]
      .filter((session) => session.manorId === manorId)
      .map((session) => session.playerId)
      .sort();
  }
  sessionsInManor(manorId: string): ManorRuntimeSession[] {
    return [...this.sessions.values()]
      .filter((session) => session.manorId === manorId)
      .map(cloneSession);
  }
  private nextSpawn(manorId: string, spaceId: ManorSpaceId): { x: number; y: number } {
    const authored = manorAuthoredRoom(spaceId, this.manorTypeOf(manorId));
    const spawn = spaceId === "manor_foyer" ? MANOR_FOYER_ROOM.spawn
      : authored?.anchors.find((anchor) => anchor.id === authored.spawnAnchorId) ?? MANOR_SPAWN;
    const navigation = this.navigationFor(manorId, spaceId);
    const occupied = new Set(
      [...this.sessions.values()]
        .filter((session) => session.manorId === manorId && session.spaceId === spaceId)
        .map((session) => `${session.position.x}:${session.position.y}`)
    );
    const offsets = [
      [0, 0], [-70, 0], [70, 0], [0, -70], [-70, -70], [70, -70],
      [-140, 0], [140, 0], [-140, -70], [140, -70]
    ] as const;
    const available = offsets
      .map(([x, y]) => ({ x: spawn.x + x, y: spawn.y + y }))
      .find((candidate) => !occupied.has(`${candidate.x}:${candidate.y}`) &&
        isIndoorNavigationPointWalkable(navigation, candidate));
    if (available) return available;
    const fallback = { x: spawn.x, y: spawn.y - 140 };
    return isIndoorNavigationPointWalkable(navigation, fallback) ? fallback : { ...spawn };
  }
  requireSession(playerId: string, sessionId: string): ManorRuntimeSession {
    const session = this.sessions.get(playerId);
    if (!session) throw new ManorError("NOT_INSIDE", "You are not inside a manor.");
    if (session.sessionId !== sessionId) throw new ManorError("STALE_SESSION", "That manor session is stale.");
    return session;
  }
  transferSpace(
    playerId: string,
    sessionId: string,
    spaceId: ManorSpaceId,
    position: { x: number; y: number }
  ): ManorRuntimeSession {
    const session = this.requireSession(playerId, sessionId);
    this.routes.delete(playerId);
    session.spaceId = spaceId;
    session.position = {
      ...position, targetX: null, targetY: null, moving: false,
      revision: session.position.revision + 1
    };
    session.movementSequence += 1;
    this.markDirty(session);
    this.schedulePersistence(session, true);
    return cloneSession(session);
  }
  moveTo(playerId: string, sessionId: string, x: number, y: number): ManorRuntimeSession {
    const session = this.requireSession(playerId, sessionId);
    const room = this.navigationFor(session.manorId, session.spaceId);
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new ManorError("INVALID_MOVE", "Manor coordinates must be finite.");
    const target = { x, y };
    const hasAuthoredFloor = Boolean(room.walkableSurfaces && room.walkableSurfaces.length > 0);
    const min = hasAuthoredFloor ? 0 : room.playerRadius;
    if (x < min || y < min || x > room.roomWidth - min || y > room.roomHeight - min) {
      throw new ManorError("OUT_OF_BOUNDS", "That target is outside the manor floor.");
    }
    if (Math.hypot(x - session.position.x, y - session.position.y) > MANOR_MAX_TARGET_DISTANCE) {
      throw new ManorError("INVALID_MOVE", "That target is too far away.");
    }
    if (hasAuthoredFloor && !isIndoorNavigationPointInsideWalkableSurface(room, target)) {
      throw new ManorError("OUT_OF_BOUNDS", "That target is outside the manor floor.");
    }
    if (!isIndoorNavigationPointWalkable(room, target)) {
      throw new ManorError("BLOCKED_TARGET", "That target is blocked by a manor collision.");
    }
    const route = findIndoorNavigationRoute(room, session.position, target);
    if (!route?.[0]) {
      throw new ManorError("INVALID_MOVE", "No collision-free route is available from your current position.");
    }
    const [waypoint, ...remaining] = route;
    if (remaining.length > 0) this.routes.set(playerId, remaining);
    else this.routes.delete(playerId);
    session.position.targetX = waypoint.x;
    session.position.targetY = waypoint.y;
    session.position.moving = true;
    session.position.revision += 1;
    session.movementSequence += 1;
    return cloneSession(session);
  }
  private navigationFor(manorId: string, spaceId: ManorSpaceId): IndoorRoomNavigation {
    const installed = this.manorNavigations.get(`${manorId}:${spaceId}`);
    if (installed) return installed;
    const provided = spaceId === "manor_foyer" ? null : this.navigationProvider?.(manorId, spaceId) ?? null;
    if (provided) return provided;
    // No provider: the authored room's floors and colliders, without placed decorations.
    const typeId = this.manorTypeOf(manorId);
    const room = spaceId === "manor_foyer" ? undefined : manorInteriorRoom(spaceId, typeId);
    return room ? interiorNavigation(room) : manorRoomNavigation(spaceId, typeId);
  }
  stop(playerId: string): void {
    this.routes.delete(playerId);
    const session = this.sessions.get(playerId);
    if (!session || !session.position.moving) return;
    session.position.targetX = null; session.position.targetY = null; session.position.moving = false; session.position.revision += 1;
    session.movementSequence += 1;
    this.markDirty(session);
    this.schedulePersistence(session, true);
  }
  subscribeMovementSettled(playerId: string, listener: () => void): () => void {
    const session = this.sessions.get(playerId);
    const listeners = this.movementSettledListeners.get(playerId) ?? new Set<{
      listener: () => void;
      observedMovement: boolean;
      movementSequence: number;
    }>();
    const subscription = {
      listener,
      observedMovement: Boolean(session?.position.moving),
      movementSequence: session?.movementSequence ?? 0
    };
    listeners.add(subscription);
    this.movementSettledListeners.set(playerId, listeners);
    return () => {
      listeners.delete(subscription);
      if (listeners.size === 0) this.movementSettledListeners.delete(playerId);
    };
  }
  isNearChest(playerId: string, sessionId: string): boolean {
    const session = this.requireSession(playerId, sessionId);
    if (session.accessSource !== "OWNER") {
      throw new ManorError("MANOR_OWNER_REQUIRED", "Only the manor owner may use Manor Storage.");
    }
    return this.inLobbyRange(session, { objectId: "manor_chest" });
  }
  authorizeSmith(
    playerId: string,
    sessionId: string,
    movementSequence: number
  ): ManorRuntimeSession {
    const session = this.requireSession(playerId, sessionId);
    if (session.playerId !== playerId) {
      throw new ManorError("SMITH_ACCESS_DENIED", "That manor session belongs to another player.");
    }
    if (session.movementSequence !== movementSequence) {
      throw new ManorError(
        "SMITH_STALE_MOVEMENT",
        "Your manor position changed before the upgrade could begin."
      );
    }
    if (session.position.moving) {
      throw new ManorError("SMITH_MOVING", "Stop moving before using the Smithing Station.");
    }
    if (!this.inLobbyRange(session, { objectId: "manor_smith" })) {
      throw new ManorError(
        "SMITH_OUT_OF_RANGE",
        "Move closer to the Smithing Station before upgrading equipment."
      );
    }
    return cloneSession(session);
  }
  authorizeJewel(
    playerId: string,
    sessionId: string,
    movementSequence: number
  ): ManorRuntimeSession {
    const session = this.requireSession(playerId, sessionId);
    if (session.playerId !== playerId) {
      throw new ManorError("JEWEL_ACCESS_DENIED", "That manor session belongs to another player.");
    }
    if (session.movementSequence !== movementSequence) {
      throw new ManorError(
        "JEWEL_STALE_MOVEMENT",
        "Your manor position changed before the enhancement could begin."
      );
    }
    if (session.position.moving) {
      throw new ManorError("JEWEL_MOVING", "Stop moving before using the Jewel Station.");
    }
    if (!this.inLobbyRange(session, { objectId: "manor_jewel" })) {
      throw new ManorError(
        "JEWEL_OUT_OF_RANGE",
        "Move closer to the Jewel Station before enhancing equipment."
      );
    }
    return cloneSession(session);
  }
  isNearDoor(playerId: string, sessionId: string): boolean {
    const session = this.requireSession(playerId, sessionId);
    const typeId = this.manorTypeOf(session.manorId);
    const exit = worldExitOf(manorTypeSpace(typeId));
    if (!exit) return false;
    const spaceId = manorAuthoredSpaceId(exit.roomId, typeId);
    const room = manorInteriorRoom(spaceId, typeId);
    return Boolean(room && session.spaceId === spaceId &&
      interactionInRange(room, { anchorId: exit.anchorId }, session.position));
  }
  /** Lobby stations of the session's Manor type, only from inside the lobby. */
  private inLobbyRange(session: ManorRuntimeSession, target: { objectId: string }): boolean {
    if (session.spaceId !== "manor_main_room") return false;
    const lobby = manorInteriorRoom("manor_main_room", this.manorTypeOf(session.manorId));
    return lobby !== undefined && interactionInRange(lobby, target, session.position);
  }
  tick(deltaSeconds: number): ManorRuntimeSession[] {
    const changed: ManorRuntimeSession[] = [];
    const step = Math.max(0, Math.min(0.25, deltaSeconds)) * MANOR_MOVE_SPEED;
    for (const session of this.sessions.values()) {
      const { targetX, targetY } = session.position;
      if (targetX === null || targetY === null) continue;
      let remainingStep = step;
      let waypointX: number | null = targetX;
      let waypointY: number | null = targetY;
      while (waypointX !== null && waypointY !== null) {
        const waypointDistance = Math.hypot(
          waypointX - session.position.x,
          waypointY - session.position.y
        );
        const advanced = advanceIndoorVector(
          session.position,
          { x: waypointX, y: waypointY },
          remainingStep
        );
        session.position.x = advanced.x;
        session.position.y = advanced.y;
        if (!advanced.arrived) break;
        remainingStep = Math.max(0, remainingStep - waypointDistance);
        const route = this.routes.get(session.playerId);
        const next = route?.shift();
        if (next) {
          if (route?.length === 0) this.routes.delete(session.playerId);
          session.position.targetX = next.x;
          session.position.targetY = next.y;
          waypointX = next.x;
          waypointY = next.y;
          if (remainingStep > 0 || waypointDistance === 0) continue;
          break;
        }
        this.routes.delete(session.playerId);
        session.position.targetX = null;
        session.position.targetY = null;
        session.position.moving = false;
        waypointX = null;
        waypointY = null;
      }
      session.movementSequence += 1;
      this.markDirty(session);
      this.schedulePersistence(session, !session.position.moving);
      changed.push(cloneSession(session));
    }
    this.publishMovementSettled();
    return changed;
  }

  private publishMovementSettled(): void {
    for (const [playerId, listeners] of this.movementSettledListeners) {
      const session = this.sessions.get(playerId);
      if (!session) continue;
      if (session.position.moving) {
        for (const subscription of listeners) subscription.observedMovement = true;
        continue;
      }
      for (const subscription of listeners) {
        if (
          !subscription.observedMovement &&
          subscription.movementSequence === session.movementSequence
        ) continue;
        listeners.delete(subscription);
        queueMicrotask(subscription.listener);
      }
      if (listeners.size === 0) this.movementSettledListeners.delete(playerId);
    }
  }

  private markDirty(session: ManorRuntimeSession): void {
    const state = this.persistence.get(session.playerId);
    if (state?.sessionId === session.sessionId) state.dirty = true;
  }

  private schedulePersistence(session: ManorRuntimeSession, force: boolean): void {
    if (!this.persistPosition) return;
    const state = this.persistence.get(session.playerId);
    if (state?.sessionId !== session.sessionId || !state.dirty || state.inFlight) return;
    const now = Date.now();
    if (!force && now - state.lastFlushAt < MANOR_POSITION_FLUSH_INTERVAL_MS) return;
    const snapshot = cloneSession(session);
    state.dirty = false;
    state.lastFlushAt = now;
    let failed = false;
    const operation = this.persistPosition(
      snapshot.playerId,
      snapshot.manorId,
      snapshot.position.x,
      snapshot.position.y,
      snapshot.spaceId
    ).then(() => undefined).catch((error: unknown) => {
      failed = true;
      const latest = this.persistence.get(snapshot.playerId);
      if (latest) latest.dirty = true;
      this.onPersistenceError?.(error, {
        playerId: snapshot.playerId,
        manorId: snapshot.manorId
      });
    }).finally(() => {
      const latest = this.persistence.get(snapshot.playerId);
      if (latest?.inFlight !== operation) return;
      latest.inFlight = null;
      const current = this.sessions.get(snapshot.playerId);
      const replaced = current?.sessionId !== snapshot.sessionId;
      if (
        latest.dirty &&
        current &&
        latest.sessionId === current.sessionId &&
        (!failed || replaced)
      ) {
        this.schedulePersistence(current, !current.position.moving);
      }
    });
    state.inFlight = operation;
  }

  private hasSession(playerId: string, sessionId: string): boolean {
    return this.sessions.get(playerId)?.sessionId === sessionId;
  }
}

function normalizeTransfer(input: ManorStorageTransferInput) {
  if (!input.requestId || input.requestId.length > 128) throw new ManorError("INVALID_REQUEST", "A valid request ID is required.");
  if (!input.sourceStackId) throw new ManorError("INVALID_REQUEST", "An authoritative source stack is required.");
  if (!Number.isSafeInteger(input.quantity) || input.quantity <= 0) throw new ManorError("INVALID_QUANTITY", "Quantity must be a positive safe integer.");
  const quantity = BigInt(input.quantity);
  if (quantity > MAX_SAFE_INVENTORY_QUANTITY) throw new ManorError("INVALID_QUANTITY", "Quantity is too large.");
  return { ...input, quantity };
}

async function storageSnapshot(
  queryable: Pick<pg.PoolClient, "query">,
  manorId: string,
  equipmentSnapshot: EquipmentSnapshotV2,
  backpackSnapshot: BackpackSnapshot
): Promise<ManorStorageSnapshot> {
  const [result, overflow] = await Promise.all([
    queryable.query<StackRow>(
      `${STORAGE_STACK_SELECT}
       FROM manor_storage_stacks stack
       WHERE stack.manor_id=$1 AND stack.quantity > 0
       ORDER BY stack.slot_index`,
      [manorId]
    ),
    queryable.query<OverflowStackRow>(
      `SELECT stack_id::text,source_order,item_id,variant,quantity::text
       FROM manor_storage_overflow
       WHERE manor_id=$1
       ORDER BY source_order`,
      [manorId]
    )
  ]);
  const stacks = result.rows.map((row) => ({
    stackId: row.stack_id,
    slotIndex: row.slot_index,
    itemId: row.item_id as ResourceType,
    variant: row.variant === DEFAULT_INVENTORY_VARIANT ? null : row.variant,
    quantity: inventoryQuantityToSafeNumber(row.quantity),
    maxStack: requireItemDefinition(row.item_id).maxStack ?? Number.MAX_SAFE_INTEGER,
    manualSplit: row.manual_split,
    version: inventoryQuantityToSafeNumber(row.version)
  }));
  const equipment = equipmentSnapshot.instances
    .filter((item) => item.location === "manor_storage" && item.manorId === manorId)
    .map((item) => ({
      equipmentInstanceId: item.instanceId,
      slotIndex: item.manorSlotIndex!,
      equipment: item
    }))
    .sort((left, right) => left.slotIndex - right.slotIndex);
  const backpacks = backpackSnapshot.instances
    .filter((item) => item.location === "manor_storage" && item.manorId === manorId)
    .map((item) => ({
      backpackInstanceId: item.instanceId,
      slotIndex: item.manorSlotIndex!,
      backpack: item
    }))
    .sort((left, right) => left.slotIndex - right.slotIndex);
  const currentWeightGrams = await manorStorageWeightGrams(queryable, manorId);
  const maximumWeightGrams = await manorStorageCapacityGrams(queryable, manorId);
  return {
    manorId,
    unlockedSlots: MANOR_STORAGE_UNLOCKED_SLOTS,
    currentWeightGrams: currentWeightGrams.toString(),
    maximumWeightGrams: maximumWeightGrams.toString(),
    stacks,
    equipment,
    backpacks,
    slots: [
      ...stacks.map((stack) => ({ kind: "stack" as const, ...stack })),
      ...equipment.map((item) => ({ kind: "equipment" as const, ...item })),
      ...backpacks.map((item) => ({ kind: "backpack" as const, ...item }))
    ].sort((left, right) => left.slotIndex - right.slotIndex),
    overflowStacks: overflow.rows.map((row) => ({
      stackId: row.stack_id,
      sourceOrder: row.source_order,
      itemId: row.item_id as ResourceType,
      variant: protocolVariant(row.variant),
      quantity: inventoryQuantityToSafeNumber(row.quantity)
    }))
  };
}

async function normalizeManorStorageStacks(
  client: pg.PoolClient,
  manorId: string
): Promise<void> {
  const stacks = await client.query<StackRow>(
    `${STORAGE_STACK_SELECT}
     FROM manor_storage_stacks stack
     WHERE stack.manor_id=$1 AND stack.quantity > 0
     ORDER BY stack.slot_index
     FOR UPDATE`,
    [manorId]
  );
  for (const stack of stacks.rows) {
    const maximum = maximumStack(stack.item_id);
    let quantity = BigInt(stack.quantity);
    if (quantity <= maximum) continue;
    while (quantity > maximum) {
      const freeSlot = await nextManorStoragePosition(client, manorId);
      const moved = minBigInt(quantity - maximum, maximum);
      await client.query(
        `INSERT INTO manor_storage_stacks
           (manor_id,slot_index,item_id,variant,quantity,manual_split)
         VALUES ($1,$2,$3,$4,$5::bigint,false)`,
        [manorId, freeSlot, stack.item_id, stack.variant, moved.toString()]
      );
      quantity -= moved;
    }
    if (quantity !== BigInt(stack.quantity)) {
      await client.query(
        `UPDATE manor_storage_stacks
         SET quantity=$3::bigint,version=version+1,updated_at=now()
         WHERE manor_id=$1 AND stack_id=$2::uuid`,
        [manorId, stack.stack_id, quantity.toString()]
      );
    }
  }
}

function operationKeyFor(playerId: string, requestId: string): string {
  return `manor:${createHash("sha256").update(`${playerId}\0${requestId}`).digest("hex")}`;
}

type BuiltManorEconomyRow = {
  id: string;
  owner_player_id: string;
  account_id: string;
  storage_upgrade_level: string | number;
};

async function lockBuiltManorForOwner(
  queryable: Pick<pg.Pool | pg.PoolClient, "query">,
  playerId: string
): Promise<BuiltManorEconomyRow> {
  const result = await queryable.query<BuiltManorEconomyRow>(
    `SELECT m.id,m.owner_player_id,m.storage_upgrade_level,p.account_id
     FROM player_manors m
     JOIN players p ON p.id=m.owner_player_id
     WHERE m.owner_player_id=$1 AND m.built_at IS NOT NULL
     FOR UPDATE OF m`,
    [playerId]
  );
  const manor = result.rows[0];
  if (!manor) throw new ManorError("MANOR_NOT_BUILT", "You do not have a built manor.");
  return manor;
}

async function lockManorPlayerState(
  queryable: Pick<pg.Pool | pg.PoolClient, "query">,
  playerId: string
): Promise<void> {
  await queryable.query(
    "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
    [playerId]
  );
}

async function lockManorUpgradeState(
  queryable: Pick<pg.Pool | pg.PoolClient, "query">,
  manorId: string,
  playerId: string
): Promise<void> {
  await queryable.query(
    "SELECT pg_advisory_xact_lock(hashtextextended($1, 676))",
    [JSON.stringify([manorId, playerId])]
  );
}

async function consumeManorMaterialCost(
  queryable: pg.PoolClient,
  inventory: Pick<InventoryService, "debitItemsForOperationInTransaction">,
  input: Readonly<{
    operationKey: string;
    playerId: string;
    source: string;
    sourceEntityType: string;
    sourceEntityId: string;
    materials: readonly ManorStorageUpgradeMaterialCost[];
    insufficientCode: string;
    insufficientMessage: string;
  }>
): Promise<void> {
  const available = await queryable.query<{ resource_type: string; quantity: string }>(
    `SELECT resource_type,quantity::text
     FROM player_inventory
     WHERE player_id=$1 AND variant=$2 AND resource_type=ANY($3::text[])
     ORDER BY resource_type
     FOR UPDATE`,
    [input.playerId, DEFAULT_INVENTORY_VARIANT, input.materials.map((material) => material.itemId)]
  );
  const quantities = new Map(available.rows.map((row) => [row.resource_type, BigInt(row.quantity)]));
  const missing = input.materials.find((material) =>
    (quantities.get(material.itemId) ?? 0n) < BigInt(material.quantity)
  );
  if (missing) {
    throw new ManorError(input.insufficientCode, input.insufficientMessage);
  }
  await inventory.debitItemsForOperationInTransaction(queryable, {
    operationKey: input.operationKey,
    playerId: input.playerId,
    source: input.source,
    sourceEntityType: input.sourceEntityType,
    sourceEntityId: input.sourceEntityId,
    debits: input.materials.map((material) => ({
      itemId: material.itemId,
      variant: DEFAULT_INVENTORY_VARIANT,
      quantity: material.quantity
    }))
  });
}

function formatManorMaterialCost(upgrade: ManorStorageUpgradeDefinition): string {
  return upgrade.materials
    .map((material) => `${material.quantity.toLocaleString("en-US")} ${material.itemId}`)
    .join(" + ");
}

function formatKg(grams: number): string {
  return `${(grams / 1_000).toLocaleString("en-US")} kg`;
}

function manorStorageUpgradeOperationKey(playerId: string, requestId: string): string {
  return `manor-upgrade:${createHash("sha256").update(`${playerId}\0${requestId}`).digest("hex")}`;
}

function manorStorageUpgradeRequestHash(playerId: string, targetLevel: number): string {
  return createHash("sha256")
    .update(JSON.stringify({ action: "storage_upgrade", playerId, targetLevel }))
    .digest("hex");
}

function storageRequestHash(
  action: ManorStorageAction,
  playerId: string,
  payload: Record<string, unknown>
): string {
  return createHash("sha256")
    .update(JSON.stringify({ action, playerId, ...payload }))
    .digest("hex");
}

async function storageStack(
  queryable: Pick<pg.Pool | pg.PoolClient, "query">,
  manorId: string,
  stackId: string
): Promise<StackRow | null> {
  const result = await queryable.query<StackRow>(
    `${STORAGE_STACK_SELECT}
     FROM manor_storage_stacks stack
     WHERE stack.manor_id=$1 AND stack.stack_id=$2::uuid
     FOR UPDATE`,
    [manorId, stackId]
  );
  return result.rows[0] ?? null;
}

async function storageStackAtSlot(
  queryable: Pick<pg.Pool | pg.PoolClient, "query">,
  manorId: string,
  slotIndex: number
): Promise<StackRow | null> {
  const result = await queryable.query<StackRow>(
    `${STORAGE_STACK_SELECT}
     FROM manor_storage_stacks stack
     WHERE stack.manor_id=$1 AND stack.slot_index=$2
     FOR UPDATE`,
    [manorId, slotIndex]
  );
  return result.rows[0] ?? null;
}

async function playerInventoryStack(
  queryable: Pick<pg.Pool | pg.PoolClient, "query">,
  playerId: string,
  stackId: string
): Promise<PlayerInventoryEntryRow | null> {
  const result = await queryable.query<PlayerInventoryEntryRow>(
    `${PLAYER_ENTRY_SELECT}
     FROM player_inventory stack
     WHERE stack.player_id=$1 AND stack.entry_id=$2::uuid
     FOR UPDATE`,
    [playerId, stackId]
  );
  return result.rows[0] ?? null;
}

async function nextManorStoragePosition(
  queryable: Pick<pg.Pool | pg.PoolClient, "query">,
  manorId: string
): Promise<number> {
  const result = await queryable.query<{ slot_index: number }>(
    `SELECT (COALESCE(MAX(position), -1) + 1)::integer AS slot_index
     FROM (
       SELECT slot_index AS position
       FROM manor_storage_stacks
       WHERE manor_id=$1
       UNION ALL
       SELECT manor_slot_index AS position
       FROM equipment_instances
       WHERE manor_id=$1 AND location='manor_storage'
       UNION ALL
       SELECT manor_slot_index AS position
       FROM player_backpack_instances
       WHERE manor_id=$1 AND location='manor_storage'
     ) positions`,
    [manorId]
  );
  return result.rows[0]?.slot_index ?? 0;
}

async function manorCapacityFor(
  queryable: Pick<pg.Pool | pg.PoolClient, "query">,
  manorId: string,
  itemId: string,
  _variant: string
): Promise<bigint> {
  void _variant;
  const unitWeight = BigInt(requireRuntimeItemDefinition(itemId).unitWeightGrams);
  // Weightless items (Lumen) never fill storage.
  if (unitWeight === 0n) return BigInt(Number.MAX_SAFE_INTEGER);
  return (await manorStorageWeightRemaining(queryable, manorId)) / unitWeight;
}

async function manorStorageWeightRemaining(
  queryable: Pick<pg.Pool | pg.PoolClient, "query">,
  manorId: string
): Promise<bigint> {
  const current = await manorStorageWeightGrams(queryable, manorId);
  const capacity = await manorStorageCapacityGrams(queryable, manorId);
  return current >= capacity
    ? 0n
    : capacity - current;
}

async function manorStorageCapacityGrams(
  queryable: Pick<pg.Pool | pg.PoolClient, "query">,
  manorId: string
): Promise<bigint> {
  const result = await queryable.query<{ storage_upgrade_level: string | number }>(
    "SELECT storage_upgrade_level FROM player_manors WHERE id=$1",
    [manorId]
  );
  return BigInt(manorStorageCapacityForLevel(Number(result.rows[0]?.storage_upgrade_level ?? 0)));
}

async function manorStorageWeightGrams(
  queryable: Pick<pg.Pool | pg.PoolClient, "query">,
  manorId: string
): Promise<bigint> {
  const resources = await queryable.query<{ weight: string }>(
    `SELECT COALESCE(sum(holding.quantity::numeric * definition.unit_weight_grams),0)::text AS weight
     FROM (
       SELECT item_id,quantity FROM manor_storage_stacks WHERE manor_id=$1
       UNION ALL
       SELECT item_id,quantity FROM manor_storage_overflow WHERE manor_id=$1
     ) holding
     JOIN item_definitions definition ON definition.item_id=holding.item_id`,
    [manorId]
  );
  const equipment = await queryable.query<{ weight: string }>(
    `SELECT COALESCE(sum(definition.unit_weight_grams),0)::text AS weight
     FROM equipment_instances equipment
     JOIN item_definitions definition ON definition.item_id=equipment.definition_id
     WHERE equipment.manor_id=$1 AND equipment.location='manor_storage'`,
    [manorId]
  );
  const backpacks = await queryable.query<{ quantity: string }>(
    `SELECT count(*)::text AS quantity
     FROM player_backpack_instances
     WHERE manor_id=$1 AND location='manor_storage'`,
    [manorId]
  );
  return BigInt(resources.rows[0]?.weight ?? "0")
    + BigInt(equipment.rows[0]?.weight ?? "0")
    + BigInt(backpacks.rows[0]?.quantity ?? "0") * BigInt(getBackpackWeightGrams());
}

async function playerCapacityFor(
  queryable: Pick<pg.Pool | pg.PoolClient, "query">,
  playerId: string,
  itemId: string,
  _variant: string
): Promise<bigint> {
  void _variant;
  return fittingInventoryQuantityInTransaction(queryable, playerId, itemId, MAX_SAFE_INVENTORY_QUANTITY);
}

function maximumStack(itemId: string): bigint {
  const definition = requireItemDefinition(itemId);
  return BigInt(definition.maxStack ?? Number.MAX_SAFE_INTEGER);
}

async function advanceBackpackRevision(
  queryable: Pick<pg.Pool | pg.PoolClient, "query">,
  playerId: string
): Promise<void> {
  await queryable.query(
    `INSERT INTO player_backpack_state (player_id,revision)
     SELECT id,1 FROM players WHERE id=$1
     ON CONFLICT (player_id) DO UPDATE
     SET revision=player_backpack_state.revision+1,updated_at=now()`,
    [playerId]
  );
}

function protocolVariant(variant: string): string | null {
  return variant === DEFAULT_INVENTORY_VARIANT ? null : variant;
}

function minBigInt(left: bigint, right: bigint): bigint {
  return left < right ? left : right;
}

function sumQuantities(rows: ReadonlyArray<{ quantity: string }>): bigint {
  return rows.reduce((total, row) => total + BigInt(row.quantity), 0n);
}

function transferSummary(
  direction: ManorTransferDirection,
  stacksRequested: number,
  quantityRequested: bigint,
  stacksMoved: number,
  quantityMoved: bigint,
  capacityReason: string | null,
  stacksRemaining = 0,
  skipped: ManorTransferSummary["skipped"] = []
): ManorTransferSummary {
  const quantityRemaining = quantityRequested - quantityMoved;
  return {
    direction,
    stacksRequested,
    quantityRequested: inventoryQuantityToSafeNumber(quantityRequested),
    stacksMoved,
    quantityMoved: inventoryQuantityToSafeNumber(quantityMoved),
    stacksRemaining,
    quantityRemaining: inventoryQuantityToSafeNumber(quantityRemaining),
    partial: quantityRemaining > 0n,
    capacityReason,
    skipped
  };
}
function mapPresence(row: PresenceRow): ManorPresence {
  return {
    playerId: row.player_id,
    manorId: row.manor_id,
    ownerPlayerId: row.owner_player_id,
    accessSource: row.access_source,
    admissionTravelInviteId: row.admission_travel_invite_id,
    returnRegionCode: row.return_region_code,
    returnLat: Number(row.return_lat),
    returnLon: Number(row.return_lon),
    localPositionX: finiteNumberOrNull(row.local_position_x),
    localPositionY: finiteNumberOrNull(row.local_position_y),
    ...(row.manor_type_id ? { manorTypeId: resolveManorTypeId(row.manor_type_id) } : {})
  };
}
function finiteNumberOrNull(value: number | null): number | null {
  if (value === null) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
function isValidLocalPosition(x: number, y: number): boolean {
  const min = MANOR_PLAYER_RADIUS;
  const max = MANOR_FLOOR_SIZE - MANOR_PLAYER_RADIUS;
  return Number.isFinite(x) && Number.isFinite(y) &&
    x >= min && x <= max && y >= min && y <= max;
}
function kickKey(manorId: string, playerId: string): string { return `${manorId}:\0${playerId}`; }
function mapWorldManor(row: ManorWorldRow): ManorWorldSnapshot {
  if (!row.world_region_code || row.world_lat === null || row.world_lon === null || !row.built_at) {
    throw new Error("Built manor placement is incomplete");
  }
  return {
    manorId: row.id,
    ownerPlayerId: row.owner_player_id,
    ownerUsername: row.owner_username,
    regionCode: row.world_region_code,
    lat: Number(row.world_lat),
    lon: Number(row.world_lon),
    builtAt: new Date(row.built_at).toISOString(),
    placementRevision: Number(row.placement_revision),
    manorTypeId: resolveManorTypeId(row.manor_type_id),
    ...(() => {
      const warfare = manorWarfareSnapshot(row);
      return warfare ? { warfare } : {};
    })()
  };
}
function placementOperationKey(type: "build" | "destroy", playerId: string, requestId: string): string {
  return `manor-${type}:${createHash("sha256").update(`${playerId}\0${requestId}`).digest("hex")}`;
}
function placementRequestHash(type: "build" | "destroy", playerId: string): string {
  return createHash("sha256").update(JSON.stringify({
    type: type === "build" ? "BUILD_MANOR" : "DESTROY_MANOR",
    playerId
  })).digest("hex");
}
function burntManorError(): ManorError {
  return new ManorError("MANOR_BURNT", "This Manor has burnt down. Its owner must repair it before anyone can enter.");
}
function requireRow<T>(row: T | undefined, message: string): T { if (!row) throw new Error(message); return row; }
function cloneSession(session: ManorRuntimeSession): ManorRuntimeSession { return { ...session, position: { ...session.position } }; }
function mapTransferError(error: unknown): Error {
  if (isInventoryCapacityError(error)) return new ManorError("PLAYER_INVENTORY_FULL", "This would exceed your carrying capacity");
  if (error instanceof ManorError) return error;
  const message = error instanceof Error ? error.message : "Manor transfer failed";
  if (message.includes("enough items")) return new ManorError("INSUFFICIENT_INVENTORY", message);
  if (message.includes("idempotency key")) return new ManorError("REPLAY_CONFLICT", message);
  return error instanceof Error ? error : new Error(message);
}
