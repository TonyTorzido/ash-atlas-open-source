import {
  DEFAULT_MANOR_TEMPLATE_CATALOG,
  DEFAULT_MANOR_TYPE_ID,
  interiorNavigation,
  manorAuthoredRoom,
  manorInteriorRoom,
  manorTypeRoomIds,
  manorPointInPolygon,
  manorTypeTemplate,
  resolveManorTypeId,
  manorDecorationFootprintInRoom,
  isManorDecorationPlacementValid,
  manorPolygonGeometryIssues,
  resolveManorDecorationDragPosition,
  manorRoomNavigation,
  type IndoorPoint,
  type IndoorRoomNavigation,
  type ManorDecorationDefinition,
  type ManorDecorationMutationResult,
  type ManorDecorationPlacement,
  type ManorDecorationSnapshot,
  type ManorRoomDefinition,
  type ManorSpaceId,
  type PlayerInventorySnapshot,
  type ResourceType
} from "@ash-atlas/shared";
import { createHash, randomUUID } from "node:crypto";
import type pg from "pg";

import {
  DEFAULT_INVENTORY_VARIANT,
  InventoryService
} from "./inventory.js";
import { ManorError } from "./manor.js";
import { requireRuntimeItemDefinition } from "./items.js";

type Queryable = Pick<pg.Pool | pg.PoolClient, "query">;

type PlacementRow = {
  placement_id: string;
  definition_id: string;
  item_id: string | null;
  item_variant: string | null;
  room_id: string;
  surface_id: string;
  x: number;
  y: number;
  rotation_deg: number;
  width: number;
  height: number;
  scale_x: number;
  scale_y: number;
  anchor_x: number;
  anchor_y: number;
};

type PresenceRow = { manor_id: string; owner_player_id: string; access_source: string; manor_type_id: string };
type OperationRow = {
  manor_id: string;
  action: "place" | "move" | "remove";
  request_hash: string;
  original_result: ManorDecorationMutationResult | null;
};

/** Stable wire-safe identity for a placement supplied by the published template. */
export function authoredManorDecorationPlacementId(
  manorId: string,
  definitionId: string
): string {
  const hex = createHash("sha256")
    .update(`manor-authored-decoration:${manorId}:${definitionId}`)
    .digest("hex")
    .slice(0, 32)
    .split("");
  hex[12] = "5";
  hex[16] = "8";
  return `${hex.slice(0, 8).join("")}-${hex.slice(8, 12).join("")}-${hex.slice(12, 16).join("")}-${hex.slice(16, 20).join("")}-${hex.slice(20).join("")}`;
}

export type ManorDecorationPlaceInput = Readonly<{
  playerId: string;
  requestId: string;
  manorSessionId: string;
  /** Room the owner is standing in; the decoration is placed there. */
  spaceId: ManorSpaceId;
  definitionId: string;
  x?: number;
  y?: number;
}>;

export type ManorDecorationMoveInput = Readonly<{
  playerId: string;
  requestId: string;
  manorSessionId: string;
  /** Room the owner is standing in; a moved decoration lands there. */
  spaceId: ManorSpaceId;
  placementId: string;
  x: number;
  y: number;
}>;

export type ManorDecorationRemoveInput = Readonly<{
  playerId: string;
  requestId: string;
  manorSessionId: string;
  placementId: string;
}>;

/**
 * Durable Manor decoration custody and placement authority.
 *
 * Definitions and authored defaults come from the shared Studio catalog.
 * Persisted placements override a default with the same definition ID.
 * Inventory-backed decorations reserve one stackable item in the same
 * transaction as their durable row; universal definitions and authored
 * defaults intentionally skip inventory custody.
 */
export class ManorDecorationService {
  private readonly placementCache = new Map<string, ManorDecorationPlacement[]>();
  private readonly groundDropAnchorCache = new Map<string, IndoorPoint[]>();
  /** Manor type per Manor id, refreshed whenever a snapshot or mutation reads the Manor. */
  private readonly manorTypes = new Map<string, string>();
  /** Every published decoration definition across Manor types (default type first); any type may place them. */
  private readonly definitions: readonly ManorDecorationDefinition[] = manorDecorationDefinitions();

  constructor(
    private readonly pool: pg.Pool,
    private readonly inventory: Pick<InventoryService, "debitItemsForOperationInTransaction" | "grantItemsForOperationInTransaction" | "snapshotInTransaction"> = new InventoryService(pool)
  ) {}

  async snapshotForPlayer(playerId: string, manorId: string): Promise<ManorDecorationSnapshot> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await this.requireOwnerOrOccupant(client, playerId, manorId, false);
      const inventory = await this.inventory.snapshotInTransaction(client, playerId);
      const snapshot = await this.snapshotInTransaction(client, playerId, manorId, inventory);
      await client.query("COMMIT");
      return snapshot;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  /** Build the shared indoor navigation view for the current cached Manor. */
  navigationForManor(manorId: string, spaceId: ManorSpaceId): IndoorRoomNavigation {
    // Keep the authored lobby navigation in lockstep with the authored room
    // surfaces and collision geometry. Movable decoration colliders are
    // layered onto that same navigation below.
    const typeId = this.manorTypeOf(manorId);
    const interiorRoom = manorInteriorRoom(spaceId, typeId);
    const room = manorAuthoredRoom(spaceId, typeId);
    if (!room || !interiorRoom) return manorRoomNavigation(spaceId, typeId);
    const decorations = (this.placementCache.get(manorId) ?? [])
      .map((placement) => {
        const definition = this.definition(placement.definitionId, true);
        if (!definition?.collision || placement.roomId !== room.id) return null;
        const footprint = manorDecorationFootprintInRoom({
          ...definition,
          transform: placement.transform
        }, definition.mirrorX === true);
        return {
          id: `decoration:${placement.placementId}`,
          kind: "polygon" as const,
          points: footprint
        };
      })
      .filter((collider): collider is {
        id: string;
        kind: "polygon";
        points: IndoorPoint[];
      } => collider !== null);
    // Same movement inputs as `manorRoomNavigation`: the room floors and colliders plus the placed decoration footprints.
    return interiorNavigation(interiorRoom, decorations);
  }

  async place(input: ManorDecorationPlaceInput): Promise<ManorDecorationMutationResult> {
    return this.runOperation(input.playerId, input.requestId, "place", {
      definitionId: input.definitionId,
      x: input.x ?? null,
      y: input.y ?? null
    }, async (client, manorId, typeId) => {
      const definition = this.requireDefinition(input.definitionId);
      const room = this.requireRoom(input.spaceId, typeId);
      if (definition.placementMode === "permanent" && room.id !== definition.roomId) {
        throw new ManorError("MANOR_DECORATION_ROOM", `${definition.name} can only be placed in its own room.`);
      }
      const surface = this.requireSurface(room, definition, { x: input.x ?? definition.transform.x, y: input.y ?? definition.transform.y });
      const transform = {
        ...definition.transform,
        x: definition.placementMode === "permanent" ? definition.transform.x : input.x ?? definition.transform.x,
        y: definition.placementMode === "permanent" ? definition.transform.y : input.y ?? definition.transform.y
      };
      this.assertFinitePlacement(transform.x, transform.y);
      this.assertContainment(manorId, definition, room, surface, transform);
      const placementId = randomUUID();
      let inventory = await this.inventory.snapshotInTransaction(client, input.playerId);
      if (definition.itemId === null) {
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`manor-decoration-free:${manorId}`]);
        const existing = await client.query<{ count: string }>(
          `SELECT count(*)::text AS count
           FROM manor_decoration_placements
           WHERE manor_id=$1::uuid AND definition_id=$2 AND room_id = ANY($3::text[])`,
          [manorId, definition.id, [...manorTypeRoomIds(typeId)]]
        );
        if (Number(existing.rows[0]?.count ?? 0) > 0) {
          throw new ManorError("MANOR_DECORATION_UNAVAILABLE", `${definition.name} is already placed in this Manor.`);
        }
      } else {
        const item = requireRuntimeItemDefinition(definition.itemId);
        if (item.category === "equipment" || !item.manorStorable || !item.stackable) {
          throw new ManorError("MANOR_DECORATION_ITEM_UNSUPPORTED", "That decoration is not mapped to a storable stackable item.");
        }
        const debited = await this.inventory.debitItemsForOperationInTransaction(client, {
          operationKey: `manor-decoration:${input.playerId}:${input.requestId}:debit`,
          playerId: input.playerId,
          source: "manor_decoration",
          sourceEntityType: "manor_decoration_placement",
          sourceEntityId: placementId,
          debits: [{ itemId: definition.itemId as ResourceType, variant: DEFAULT_INVENTORY_VARIANT, quantity: 1 }],
          metadata: { action: "place", definitionId: definition.id, manorId }
        });
        inventory = debited.inventory;
      }
      const itemVariant = definition.itemId === null ? null : DEFAULT_INVENTORY_VARIANT;
      await client.query(
        `INSERT INTO manor_decoration_placements (
           placement_id,manor_id,definition_id,item_id,item_variant,room_id,surface_id,
           x,y,rotation_deg,width,height,scale_x,scale_y,anchor_x,anchor_y
         ) VALUES ($1::uuid,$2::uuid,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
        [placementId, manorId, definition.id, definition.itemId, itemVariant,
          room.id, surface.id, transform.x, transform.y, transform.rotationDeg,
          transform.width, transform.height, transform.scaleX, transform.scaleY,
          transform.anchorX, transform.anchorY]
      );
      const placement = this.placementFromRow({
        placement_id: placementId,
        definition_id: definition.id,
        item_id: definition.itemId,
        item_variant: itemVariant,
        room_id: room.id,
        surface_id: surface.id,
        x: transform.x,
        y: transform.y,
        rotation_deg: transform.rotationDeg,
        width: transform.width,
        height: transform.height,
        scale_x: transform.scaleX,
        scale_y: transform.scaleY,
        anchor_x: transform.anchorX,
        anchor_y: transform.anchorY
      });
      const snapshot = await this.snapshotInTransaction(client, input.playerId, manorId, inventory);
      return {
        requestId: input.requestId,
        action: "place",
        snapshot,
        inventory,
        placement,
        replayed: false,
        message: definition.placementMode === "permanent"
          ? `${definition.name} placed at its authored permanent position.`
          : `${definition.name} placed.`
      };
    });
  }

  async move(input: ManorDecorationMoveInput): Promise<ManorDecorationMutationResult> {
    return this.runOperation(input.playerId, input.requestId, "move", {
      placementId: input.placementId,
      x: input.x,
      y: input.y
    }, async (client, manorId, typeId) => {
      const row = await this.lockPlacement(client, manorId, input.placementId, typeId);
      const definition = this.requireDefinition(row.definition_id);
      if (definition.placementMode === "permanent") {
        throw new ManorError("MANOR_DECORATION_IMMOVABLE", "Permanent decorations cannot be repositioned.");
      }
      const room = this.requireRoom(input.spaceId, typeId);
      const surface = this.requireSurface(room, definition, { x: input.x, y: input.y });
      this.assertFinitePlacement(input.x, input.y);
      const currentTransform = canonicalManorDecorationTransform(
        definition,
        room,
        surface,
        { x: Number(row.x), y: Number(row.y) }
      );
      const resolvedPosition = resolveDecorationMove(definition, room, surface, currentTransform, {
        x: input.x,
        y: input.y
      }, this.groundDropCollisionPolygons(manorId));
      const transform = {
        ...currentTransform,
        x: resolvedPosition.x,
        y: resolvedPosition.y
      };
      this.assertContainment(manorId, definition, room, surface, transform);
      await client.query(
        `UPDATE manor_decoration_placements
         SET room_id=$1,surface_id=$2,x=$3,y=$4,rotation_deg=$5,width=$6,height=$7,
             scale_x=$8,scale_y=$9,anchor_x=$10,anchor_y=$11,updated_at=now()
         WHERE manor_id=$12::uuid AND placement_id=$13::uuid`,
        [room.id, surface.id, transform.x, transform.y, transform.rotationDeg,
          transform.width, transform.height, transform.scaleX, transform.scaleY,
          transform.anchorX, transform.anchorY, manorId, input.placementId]
      );
      const inventory = await this.inventory.snapshotInTransaction(client, input.playerId);
      const snapshot = await this.snapshotInTransaction(client, input.playerId, manorId, inventory);
      const placement = snapshot.placements.find((candidate) => candidate.placementId === input.placementId) ?? null;
      return {
        requestId: input.requestId,
        action: "move",
        snapshot,
        inventory,
        placement,
        replayed: false,
        message: `${definition.name} placement saved.`
      };
    });
  }

  async remove(input: ManorDecorationRemoveInput): Promise<ManorDecorationMutationResult> {
    return this.runOperation(input.playerId, input.requestId, "remove", {
      placementId: input.placementId
    }, async (client, manorId, typeId) => {
      const row = await this.lockPlacement(client, manorId, input.placementId, typeId);
      // Retired definitions remain removable so a content retirement cannot
      // strand an item reservation in a Manor.
      const definition = this.requireDefinition(row.definition_id, true);
      let inventory = await this.inventory.snapshotInTransaction(client, input.playerId);
      if (definition.itemId !== null && row.item_id !== null) {
        const refund = await this.inventory.grantItemsForOperationInTransaction(client, {
          operationKey: `manor-decoration:${input.playerId}:${input.requestId}:refund`,
          playerId: input.playerId,
          source: "manor_decoration",
          sourceEntityType: "manor_decoration_placement",
          sourceEntityId: input.placementId,
          grants: [{ itemId: row.item_id as ResourceType, variant: row.item_variant, quantity: 1 }],
          metadata: { action: "remove", definitionId: definition.id, manorId }
        });
        inventory = refund.inventory;
      }
      await client.query(
        "DELETE FROM manor_decoration_placements WHERE manor_id=$1::uuid AND placement_id=$2::uuid",
        [manorId, input.placementId]
      );
      const snapshot = await this.snapshotInTransaction(client, input.playerId, manorId, inventory);
      return {
        requestId: input.requestId,
        action: "remove",
        snapshot,
        inventory,
        placement: null,
        replayed: false,
        message: definition.itemId === null
          ? `${definition.name} removed.`
          : `${definition.name} returned to your inventory.`
      };
    });
  }

  private async runOperation<T extends ManorDecorationMutationResult>(
    playerId: string,
    requestId: string,
    action: OperationRow["action"],
    payload: unknown,
    execute: (client: pg.PoolClient, manorId: string, manorTypeId: string) => Promise<T>
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const presence = await this.requireOwnerOrOccupant(client, playerId, undefined, true);
      const manorId = presence.manor_id;
      const manorTypeId = resolveManorTypeId(presence.manor_type_id);
      this.manorTypes.set(manorId, manorTypeId);
      const requestHash = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
      const existing = await client.query<OperationRow>(
        `SELECT manor_id,action,request_hash,original_result
         FROM manor_decoration_operations
         WHERE player_id=$1 AND request_id=$2
         FOR UPDATE`,
        [playerId, requestId]
      );
      const operation = existing.rows[0];
      if (operation) {
        if (operation.manor_id !== manorId || operation.action !== action || operation.request_hash !== requestHash) {
          throw new ManorError("MANOR_DECORATION_REQUEST_CONFLICT", "That decoration request was already used for different data.");
        }
        if (!operation.original_result) {
          throw new ManorError("MANOR_DECORATION_RETRY", "That decoration request is still being completed; try again.");
        }
        const replay = structuredClone(operation.original_result) as T;
        await client.query("COMMIT");
        return { ...replay, replayed: true };
      }
      await client.query(
        `INSERT INTO manor_decoration_operations
         (player_id,request_id,manor_id,action,request_hash)
         VALUES ($1,$2,$3::uuid,$4,$5)`,
        [playerId, requestId, manorId, action, requestHash]
      );
      const result = await execute(client, manorId, manorTypeId);
      await client.query(
        `UPDATE manor_decoration_operations
         SET original_result=$1::jsonb,completed_at=now()
         WHERE player_id=$2 AND request_id=$3`,
        [JSON.stringify(result), playerId, requestId]
      );
      await client.query("COMMIT");
      this.placementCache.set(manorId, result.snapshot.placements);
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private async snapshotInTransaction(
    client: Queryable,
    playerId: string,
    manorId: string,
    inventory: PlayerInventorySnapshot
  ): Promise<ManorDecorationSnapshot> {
    const typeRow = await client.query<{ manor_type_id: string }>(
      "SELECT manor_type_id FROM player_manors WHERE id=$1::uuid", [manorId]
    );
    const manorTypeId = resolveManorTypeId(typeRow.rows[0]?.manor_type_id);
    this.manorTypes.set(manorId, manorTypeId);
    const template = manorTypeTemplate(manorTypeId);
    const result = await client.query<PlacementRow>(
      `SELECT placement_id::text,definition_id,item_id,item_variant,room_id,surface_id,
              x,y,rotation_deg,width,height,scale_x,scale_y,anchor_x,anchor_y
       FROM manor_decoration_placements
       WHERE manor_id=$1::uuid
       ORDER BY created_at,placement_id
       FOR UPDATE`,
      [manorId]
    );
    await this.loadGroundDropAnchors(client, manorId);
    const durablePlacements: ManorDecorationPlacement[] = [];
    const durableDefinitionIds = new Set<string>();
    // Placements belong to the rooms of one Manor type: those of other (not
    // installed) skins stay stored untouched and hidden until that skin returns.
    const activeRooms = new Set(manorTypeRoomIds(manorTypeId));
    for (const row of result.rows.filter((candidate) => activeRooms.has(candidate.room_id))) {
      const canonical = this.canonicalPlacementRow(row, manorId, manorTypeId);
      if (placementRowChanged(row, canonical)) {
        await client.query(
          `UPDATE manor_decoration_placements
           SET room_id=$1,surface_id=$2,x=$3,y=$4,rotation_deg=$5,width=$6,height=$7,
               scale_x=$8,scale_y=$9,anchor_x=$10,anchor_y=$11,updated_at=now()
           WHERE placement_id=$12::uuid AND manor_id=$13::uuid`,
          [canonical.room_id, canonical.surface_id, canonical.x, canonical.y,
            canonical.rotation_deg, canonical.width, canonical.height,
            canonical.scale_x, canonical.scale_y, canonical.anchor_x,
            canonical.anchor_y, canonical.placement_id, manorId]
        );
      }
      durablePlacements.push(this.placementFromRow(canonical));
      durableDefinitionIds.add(canonical.definition_id);
    }
    const room = template.rooms.find((candidate) =>
      candidate.id === template.defaultRoomId && !candidate.retired && candidate.active
    ) ?? template.rooms.find((candidate) => !candidate.retired && candidate.active)
      ?? template.rooms[0]!;
    // Authored defaults are the Manor type template content (its lobby decorations).
    const authoredPlacements = template.decorations
      .filter((definition) =>
        !definition.retired &&
        definition.roomId === room.id &&
        room.placementSurfaces.some((surface) => surface.id === definition.surfaceId && !surface.retired) &&
        !durableDefinitionIds.has(definition.id)
      )
      .map((definition) => this.authoredDefaultPlacement(manorId, definition, room));
    // A persisted/player placement for a definition is the explicit override
    // for its authored default. Keep additional persisted copies intact.
    const placements = [...durablePlacements, ...authoredPlacements];
    this.placementCache.set(manorId, placements);
    const reserved = new Map<string, number>();
    for (const placement of placements) {
      if (placement.itemId === null) continue;
      reserved.set(
        placement.itemId,
        (reserved.get(placement.itemId) ?? 0) + 1
      );
    }
    const placedDefinitionIds = new Set(placements.map((placement) => placement.definitionId));
    const definitions = this.definitions
      .filter((definition) => !definition.retired || placedDefinitionIds.has(definition.id))
      .map((definition) => {
        const placedQuantity = placements.filter((placement) =>
          placement.definitionId === definition.id
        ).length;
        const ownedQuantity = definition.itemId === null
          ? 1
          : inventory.items
            .filter((item) => item.resourceType === definition.itemId &&
              (item.variant ?? DEFAULT_INVENTORY_VARIANT) === DEFAULT_INVENTORY_VARIANT)
            .reduce((total, item) => total + item.quantity, 0);
        const reservedQuantity = definition.itemId === null
          ? 0
          : reserved.get(definition.itemId) ?? 0;
        return {
          definition,
          ownedQuantity: ownedQuantity + reservedQuantity,
          availableQuantity: definition.itemId === null
            ? Math.max(0, 1 - placedQuantity)
            : ownedQuantity
        };
      });
    return {
      manorId,
      roomWidth: room.width,
      roomHeight: room.height,
      definitions,
      placements
    };
  }

  private authoredDefaultPlacement(
    manorId: string,
    definition: ManorDecorationDefinition,
    room: ManorRoomDefinition
  ): ManorDecorationPlacement {
    const surface = room.placementSurfaces.find((candidate) =>
      candidate.id === definition.surfaceId && !candidate.retired
    );
    if (!surface) {
      throw new ManorError("MANOR_DECORATION_INVALID", "The decoration references an inactive placement surface.");
    }
    return {
      placementId: authoredManorDecorationPlacementId(manorId, definition.id),
      definitionId: definition.id,
      // Authored defaults are template content, not player custody. A
      // persisted row takes precedence when a player places this definition.
      itemId: null,
      itemVariant: null,
      roomId: room.id,
      surfaceId: surface.id,
      transform: canonicalManorDecorationTransform(
        definition,
        room,
        surface,
        { x: definition.transform.x, y: definition.transform.y }
      ),
      authoredDefault: true
    };
  }

  private async requireOwnerOrOccupant(
    queryable: Queryable,
    playerId: string,
    manorId?: string,
    ownerOnly = false
  ): Promise<PresenceRow> {
    const result = await queryable.query<PresenceRow>(
      `SELECT presence.manor_id,manor.owner_player_id,presence.access_source,manor.manor_type_id
       FROM player_manor_presence presence
       JOIN player_manors manor ON manor.id=presence.manor_id
       WHERE presence.player_id=$1
         AND manor.built_at IS NOT NULL
         AND ($2::uuid IS NULL OR presence.manor_id=$2::uuid)`,
      [playerId, manorId ?? null]
    );
    const presence = result.rows[0];
    if (!presence) throw new ManorError("NOT_INSIDE", "You are not inside a manor.");
    if (ownerOnly && presence.owner_player_id !== playerId) {
      throw new ManorError("MANOR_OWNER_REQUIRED", "Only the manor owner may place Manor decorations.");
    }
    return presence;
  }

  /** A placement in the active skin's rooms (hidden placements of other skins cannot be moved or stored). */
  private async lockPlacement(client: pg.PoolClient, manorId: string, placementId: string, manorTypeId: string): Promise<PlacementRow> {
    const result = await client.query<PlacementRow>(
      `SELECT placement_id::text,definition_id,item_id,item_variant,room_id,surface_id,
              x,y,rotation_deg,width,height,scale_x,scale_y,anchor_x,anchor_y
       FROM manor_decoration_placements
       WHERE manor_id=$1::uuid AND placement_id=$2::uuid AND room_id = ANY($3::text[])
       FOR UPDATE`,
      [manorId, placementId, [...manorTypeRoomIds(manorTypeId)]]
    );
    const row = result.rows[0];
    if (!row) throw new ManorError("MANOR_DECORATION_NOT_FOUND", "That Manor decoration is no longer placed.");
    return row;
  }

  private requireDefinition(id: string, allowRetired = false): ManorDecorationDefinition {
    const definition = this.definitions.find((candidate) =>
      candidate.id === id && (allowRetired || !candidate.retired)
    );
    if (!definition) throw new ManorError("MANOR_DECORATION_NOT_FOUND", "That decoration is not published in the Manor template.");
    return definition;
  }

  private manorTypeOf(manorId: string): string {
    return this.manorTypes.get(manorId) ?? DEFAULT_MANOR_TYPE_ID;
  }

  private definition(id: string, includeRetired = false): ManorDecorationDefinition | null {
    return this.definitions.find((candidate) =>
      candidate.id === id && (includeRetired || !candidate.retired)
    ) ?? null;
  }

  private requireRoom(spaceId: ManorSpaceId, manorTypeId: string): ManorRoomDefinition {
    const room = manorAuthoredRoom(spaceId, manorTypeId);
    if (!room) throw new ManorError("MANOR_DECORATION_INVALID", "Decorations cannot be placed in this room.");
    return room;
  }

  private requireSurface(
    room: ManorRoomDefinition,
    definition: ManorDecorationDefinition,
    point: IndoorPoint
  ): ManorRoomDefinition["placementSurfaces"][number] {
    const surface = manorDecorationSurfaceInRoom(definition, room, point);
    if (!surface) throw new ManorError("MANOR_DECORATION_INVALID", "This room has no surface for that decoration.");
    return surface;
  }

  private async loadGroundDropAnchors(
    client: Queryable,
    manorId: string
  ): Promise<void> {
    const result = await client.query<{ local_x: number; local_y: number }>(
      `SELECT local_x,local_y
       FROM world_item_drops
       WHERE manor_id=$1::uuid AND status='active'
         AND local_x IS NOT NULL AND local_y IS NOT NULL
       UNION ALL
       SELECT local_x,local_y
       FROM world_equipment_drops
       WHERE manor_id=$1::uuid AND status='active'
         AND local_x IS NOT NULL AND local_y IS NOT NULL`,
      [manorId]
    );
    this.groundDropAnchorCache.set(manorId, result.rows.map((row) => ({
      x: Number(row.local_x),
      y: Number(row.local_y)
    })));
  }

  private groundDropCollisionPolygons(manorId: string): IndoorPoint[][] {
    const radius = 2;
    return (this.groundDropAnchorCache.get(manorId) ?? []).map((point) => [
      { x: point.x - radius, y: point.y - radius },
      { x: point.x + radius, y: point.y - radius },
      { x: point.x + radius, y: point.y + radius },
      { x: point.x - radius, y: point.y + radius }
    ]);
  }

  private assertContainment(
    manorId: string,
    definition: ManorDecorationDefinition,
    room: ManorRoomDefinition,
    surface: ManorRoomDefinition["placementSurfaces"][number],
    transform: ManorDecorationDefinition["transform"]
  ): void {
    const footprint = manorDecorationFootprintInRoom({ ...definition, transform },
      surface.kind === "right_wall" || definition.mirrorX === true);
    if (manorPolygonGeometryIssues(footprint).length > 0) {
      throw new ManorError("MANOR_DECORATION_INVALID", "The decoration footprint is not a valid polygon.");
    }
    const collisionPolygons = room.colliders
      .filter((collider) => !collider.retired)
      .map((collider) => collider.points)
      .concat(this.groundDropCollisionPolygons(manorId).map((polygon) => [...polygon]));
    if (!isManorDecorationPlacementValid(definition, surface, transform, collisionPolygons)) {
      throw new ManorError("MANOR_DECORATION_OUT_OF_BOUNDS", "The decoration must remain fully inside its authored placement surface.");
    }
  }

  private assertFinitePlacement(x: number, y: number): void {
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw new ManorError("MANOR_DECORATION_INVALID", "Decoration coordinates must be finite.");
    }
  }

  private placementFromRow(row: PlacementRow): ManorDecorationPlacement {
    const definition = this.definition(row.definition_id, true);
    const universal = definition?.itemId === null;
    return {
      placementId: row.placement_id,
      definitionId: row.definition_id,
      itemId: universal ? null : row.item_id,
      itemVariant: universal ? null : row.item_variant,
      roomId: row.room_id,
      surfaceId: row.surface_id,
      transform: {
        x: Number(row.x),
        y: Number(row.y),
        width: Number(row.width),
        height: Number(row.height),
        rotationDeg: Number(row.rotation_deg),
        scaleX: Number(row.scale_x),
        scaleY: Number(row.scale_y),
        anchorX: Number(row.anchor_x),
        anchorY: Number(row.anchor_y)
      }
    };
  }

  private canonicalPlacementRow(row: PlacementRow, manorId: string, manorTypeId: string): PlacementRow {
    const definition = this.definition(row.definition_id, true);
    if (!definition || definition.retired) return row;
    // A placement stays in its own room; rooms outside the Manor type are left untouched.
    const room = manorAuthoredRoom(row.room_id, manorTypeId);
    if (!room || room.id !== row.room_id) return row;
    const surface = room.placementSurfaces.find((candidate) =>
      candidate.id === row.surface_id && !candidate.retired && candidate.kind === manorDecorationSurfaceKind(definition)
    ) ?? manorDecorationSurfaceInRoom(definition, room, { x: Number(row.x), y: Number(row.y) });
    if (!surface) return row;
    const transform = canonicalManorDecorationTransform(
      definition,
      room,
      surface,
      { x: Number(row.x), y: Number(row.y) },
      this.groundDropCollisionPolygons(manorId)
    );
    return {
      ...row,
      room_id: room.id,
      surface_id: surface.id,
      x: transform.x,
      y: transform.y,
      rotation_deg: transform.rotationDeg,
      width: transform.width,
      height: transform.height,
      scale_x: transform.scaleX,
      scale_y: transform.scaleY,
      anchor_x: transform.anchorX,
      anchor_y: transform.anchorY
    };
  }
}

/**
 * Project a durable placement onto the currently published authored geometry.
 * Existing player placement coordinates are retained when valid; if a Studio
 * transform update makes them invalid, the shared edge-sliding resolver finds
 * the nearest valid position from the authored default.
 */
export function canonicalManorDecorationTransform(
  definition: ManorDecorationDefinition,
  room: ManorRoomDefinition,
  surface: ManorRoomDefinition["placementSurfaces"][number],
  requestedPosition: IndoorPoint,
  additionalCollisionPolygons: readonly (readonly IndoorPoint[])[] = []
): ManorDecorationDefinition["transform"] {
  const authored = { ...definition.transform };
  const requested = Number.isFinite(requestedPosition.x) && Number.isFinite(requestedPosition.y)
    ? requestedPosition
    : { x: authored.x, y: authored.y };
  const collisionPolygons = room.colliders
    .filter((collider) => !collider.retired)
    .map((collider) => collider.points)
    .concat(additionalCollisionPolygons.map((polygon) => [...polygon]));
  const authoredAtRequested = { ...authored, x: requested.x, y: requested.y };
  if (isManorDecorationPlacementValid(definition, surface, authoredAtRequested, collisionPolygons)) {
    return authoredAtRequested;
  }
  const resolved = resolveManorDecorationDragPosition({
    decoration: definition,
    surface,
    currentTransform: authored,
    requestedPosition: requested,
    collisionPolygons
  });
  const resolvedTransform = { ...authored, x: resolved.x, y: resolved.y };
  return isManorDecorationPlacementValid(definition, surface, resolvedTransform, collisionPolygons)
    ? resolvedTransform
    : authored;
}

/** Published decoration definitions of every Manor type, default type first, each id once. */
function manorDecorationDefinitions(): ManorDecorationDefinition[] {
  const templates = [...DEFAULT_MANOR_TEMPLATE_CATALOG.templates]
    .sort((left, right) => Number(right.id === DEFAULT_MANOR_TYPE_ID) - Number(left.id === DEFAULT_MANOR_TYPE_ID));
  const seen = new Set<string>();
  return templates.flatMap((template) => template.decorations).filter((definition) => {
    if (seen.has(definition.id)) return false;
    seen.add(definition.id);
    return true;
  });
}

/** The surface kind (floor or a wall side) a decoration was authored on. */
export function manorDecorationSurfaceKind(definition: ManorDecorationDefinition): ManorRoomDefinition["placementSurfaces"][number]["kind"] {
  for (const template of DEFAULT_MANOR_TEMPLATE_CATALOG.templates) {
    const surface = template.rooms.find((room) => room.id === definition.roomId)?.placementSurfaces
      .find((candidate) => candidate.id === definition.surfaceId);
    if (surface) return surface.kind;
  }
  return "floor";
}

/**
 * The surface of `room` a decoration lands on: its authored surface in its own
 * room, otherwise an active surface of the same kind (for floors, the one under
 * the requested point when there is one). Lets every decoration go in any room.
 */
export function manorDecorationSurfaceInRoom(
  definition: ManorDecorationDefinition,
  room: ManorRoomDefinition,
  point: IndoorPoint
): ManorRoomDefinition["placementSurfaces"][number] | null {
  const kind = manorDecorationSurfaceKind(definition);
  const candidates = room.placementSurfaces.filter((surface) => !surface.retired && surface.kind === kind);
  const own = room.id === definition.roomId ? candidates.find((surface) => surface.id === definition.surfaceId) : undefined;
  if (own) return own;
  return candidates.find((surface) => manorPointInPolygon(point, surface.kind === "floor" ? surface.polygon : surface.roomPolygon))
    ?? candidates[0] ?? null;
}

function placementRowChanged(left: PlacementRow, right: PlacementRow): boolean {
  return left.room_id !== right.room_id || left.surface_id !== right.surface_id ||
    Number(left.x) !== right.x || Number(left.y) !== right.y ||
    Number(left.rotation_deg) !== right.rotation_deg || Number(left.width) !== right.width ||
    Number(left.height) !== right.height || Number(left.scale_x) !== right.scale_x ||
    Number(left.scale_y) !== right.scale_y || Number(left.anchor_x) !== right.anchor_x ||
    Number(left.anchor_y) !== right.anchor_y;
}

function resolveDecorationMove(
  definition: ManorDecorationDefinition,
  room: ManorRoomDefinition,
  surface: ManorRoomDefinition["placementSurfaces"][number],
  currentTransform: ManorDecorationDefinition["transform"],
  requestedPosition: IndoorPoint,
  additionalCollisionPolygons: readonly (readonly IndoorPoint[])[] = []
): IndoorPoint {
  return resolveManorDecorationDragPosition({
    decoration: definition,
    surface,
    currentTransform,
    requestedPosition,
    collisionPolygons: room.colliders
      .filter((collider) => !collider.retired)
      .map((collider) => collider.points)
      .concat(additionalCollisionPolygons.map((polygon) => [...polygon]))
  });
}
