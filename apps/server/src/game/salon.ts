import {
  advanceIndoorVector,
  FACE_MASK_ITEM_ID,
  faceMaskDisplayName,
  isFaceMaskVariant,
  isShopCopyId,
  DEFAULT_PLAYER_FACE_APPEARANCE_ID,
  DEFAULT_PLAYER_APPEARANCE_CATALOG,
  DEFAULT_PLAYER_SKIN_TONE_ID,
  findIndoorNavigationRoute,
  interactionInRange,
  interiorNavigation,
  isIndoorNavigationPointWalkable,
  SALON_SELECTABLE_APPEARANCE_CATEGORY_IDS,
  PLAYER_SKIN_TONE_IDS,
  SALON_INTERIOR_ROOM,
  SALON_MAIN_ROOM,
  SALON_MAX_TARGET_DISTANCE,
  SALON_MOVE_SPEED,
  SALON_SPAWN,
  DEFAULT_INTERACTION_RADIUS_M,
  distanceMeters,
  FACE_FEATURE_CATEGORY_IDS,
  faceFeaturePointAllowed,
  isFaceFeatureCategory,
  normalizePlayerSalonStyles,
  sanitizeFaceFeaturePoints,
  salonAppearanceCategory,
  salonAppearanceSelectable,
  type FaceFeaturePoints,
  type PlayerSalonStyles,
  type IndoorPoint,
  type SalonAppearanceCategoryId,
  type SalonPosition
} from "@ash-atlas/shared";
import { createHash, randomUUID } from "node:crypto";
import type pg from "pg";

import type { PlayerRecord } from "./state.js";

/** Movement inputs of the Salon room (its floor and colliders), from the authored interior space. */
const SALON_NAVIGATION = interiorNavigation(SALON_INTERIOR_ROOM);

type PresenceRow = {
  player_id: string;
  salon_structure_id: string;
  session_id: string;
  local_x: number;
  local_y: number;
  return_region_code: string;
  return_lat: number;
  return_lon: number;
};

type PlayerStyleRow = {
  hair_appearance_id: string | null;
  eyes_appearance_id: string | null;
  nose_mouth_appearance_id: string | null;
  nose_appearance_id: string | null;
  mouth_appearance_id: string | null;
  beard_appearance_id: string | null;
  mask_appearance_id: string | null;
  legs_overlay_appearance_id: string | null;
  skin_tone_id: string | null;
  eyes_feature_x: number | null;
  eyes_feature_y: number | null;
  nose_feature_x: number | null;
  nose_feature_y: number | null;
  mouth_feature_x: number | null;
  mouth_feature_y: number | null;
  base_appearance_revision: string | number;
};

const PLAYER_STYLE_COLUMNS = `hair_appearance_id,eyes_appearance_id,nose_mouth_appearance_id,
  nose_appearance_id,mouth_appearance_id,
  beard_appearance_id,mask_appearance_id,legs_overlay_appearance_id,
  skin_tone_id,eyes_feature_x,eyes_feature_y,nose_feature_x,nose_feature_y,
  mouth_feature_x,mouth_feature_y,
  base_appearance_revision`;

export type SalonPresence = {
  playerId: string;
  structureId: string;
  sessionId: string;
  localX: number;
  localY: number;
  returnRegionCode: string;
  returnLat: number;
  returnLon: number;
};

export type SalonRuntimeSession = {
  playerId: string;
  structureId: string;
  sessionId: string;
  position: SalonPosition;
  movementSequence: number;
};

export class SalonError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

export class SalonRuntime {
  private readonly sessions = new Map<string, SalonRuntimeSession>();
  private readonly routes = new Map<string, IndoorPoint[]>();

  constructor(
    private readonly persistPosition?: (
      playerId: string,
      structureId: string,
      x: number,
      y: number
    ) => Promise<unknown>
  ) {}

  enter(presence: SalonPresence): SalonRuntimeSession {
    this.routes.delete(presence.playerId);
    const savedPosition = { x: presence.localX, y: presence.localY };
    const recovered = !isIndoorNavigationPointWalkable(SALON_NAVIGATION, savedPosition);
    if (recovered && !isIndoorNavigationPointWalkable(SALON_NAVIGATION, SALON_SPAWN)) {
      throw new Error("The canonical Salon spawn must be walkable.");
    }
    const startingPosition = recovered ? SALON_SPAWN : savedPosition;
    const session = {
      playerId: presence.playerId,
      structureId: presence.structureId,
      sessionId: presence.sessionId,
      position: {
        x: startingPosition.x,
        y: startingPosition.y,
        targetX: null,
        targetY: null,
        moving: false,
        revision: 0
      },
      movementSequence: 0
    } satisfies SalonRuntimeSession;
    this.sessions.set(presence.playerId, session);
    if (recovered) {
      void this.persistPosition?.(
        presence.playerId,
        presence.structureId,
        startingPosition.x,
        startingPosition.y
      );
    }
    return cloneSession(session);
  }

  get(playerId: string): SalonRuntimeSession | null {
    const session = this.sessions.get(playerId);
    return session ? cloneSession(session) : null;
  }

  sessionsInSalon(structureId: string): SalonRuntimeSession[] {
    return [...this.sessions.values()]
      .filter((session) => session.structureId === structureId)
      .map(cloneSession);
  }

  moveTo(playerId: string, sessionId: string, x: number, y: number): SalonRuntimeSession {
    const session = this.requireSession(playerId, sessionId);
    const min = SALON_MAIN_ROOM.playerRadius;
    if (
      !Number.isFinite(x) || !Number.isFinite(y) || x < min || y < min ||
      x > SALON_MAIN_ROOM.roomWidth - min || y > SALON_MAIN_ROOM.roomHeight - min
    ) {
      throw new SalonError("INVALID_MOVE", "That target is outside the Salon floor.");
    }
    if (Math.hypot(x - session.position.x, y - session.position.y) > SALON_MAX_TARGET_DISTANCE) {
      throw new SalonError("INVALID_MOVE", "That Salon destination is too far away.");
    }
    if (!isIndoorNavigationPointWalkable(SALON_NAVIGATION, { x, y })) {
      throw new SalonError("BLOCKED_TARGET", "That target is blocked by a Salon fixture.");
    }
    const route = findIndoorNavigationRoute(SALON_NAVIGATION, session.position, { x, y });
    if (!route?.[0]) {
      throw new SalonError("INVALID_MOVE", "No collision-free route is available from your current position.");
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

  authorizeChair(playerId: string, sessionId: string, sequence: number): SalonRuntimeSession {
    const session = this.requireSession(playerId, sessionId);
    if (session.movementSequence !== sequence || session.position.moving) {
      throw new SalonError("SALON_POSITION_STALE", "Finish walking to the chair first.");
    }
    if (!interactionInRange(SALON_INTERIOR_ROOM, { objectId: "salon_chair" }, session.position)) {
      throw new SalonError("SALON_CHAIR_OUT_OF_RANGE", "Move closer to the Salon chair.");
    }
    return cloneSession(session);
  }

  isNearDoor(playerId: string, sessionId: string): boolean {
    const session = this.requireSession(playerId, sessionId);
    return interactionInRange(SALON_INTERIOR_ROOM, { anchorId: "world_exit" }, session.position);
  }

  exit(playerId: string, sessionId: string): void {
    this.requireSession(playerId, sessionId);
    this.routes.delete(playerId);
    this.sessions.delete(playerId);
  }

  remove(playerId: string): void {
    this.routes.delete(playerId);
    this.sessions.delete(playerId);
  }

  stop(playerId: string): void {
    this.routes.delete(playerId);
    const session = this.sessions.get(playerId);
    if (!session || !session.position.moving) return;
    session.position.targetX = null;
    session.position.targetY = null;
    session.position.moving = false;
    session.position.revision += 1;
    session.movementSequence += 1;
  }

  place(playerId: string, sessionId: string, position: { x: number; y: number }): SalonRuntimeSession {
    const session = this.requireSession(playerId, sessionId);
    this.routes.delete(playerId);
    session.position = {
      ...position, targetX: null, targetY: null, moving: false,
      revision: session.position.revision + 1
    };
    session.movementSequence += 1;
    return cloneSession(session);
  }

  tick(deltaSeconds: number): SalonRuntimeSession[] {
    const changed: SalonRuntimeSession[] = [];
    const step = Math.max(0, Math.min(0.25, deltaSeconds)) * SALON_MOVE_SPEED;
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
      session.position.revision += 1;
      void this.persistPosition?.(
        session.playerId,
        session.structureId,
        session.position.x,
        session.position.y
      );
      changed.push(cloneSession(session));
    }
    return changed;
  }

  private requireSession(playerId: string, sessionId: string): SalonRuntimeSession {
    const session = this.sessions.get(playerId);
    if (!session) throw new SalonError("NOT_INSIDE", "You are not inside a Salon.");
    if (session.sessionId !== sessionId) {
      throw new SalonError("STALE_SESSION", "That Salon session is stale.");
    }
    return session;
  }
}

export class SalonService {
  private readonly editorSessions = new Map<string, {
    editorSessionId: string;
    salonSessionId: string;
    structureId: string;
    appearanceRevision: number;
  }>();

  constructor(
    private readonly pool: pg.Pool,
    private readonly releaseSha: string | null
  ) {}

  async enter(
    player: PlayerRecord,
    structureId: string,
    expectedPlacementRevision: string
  ): Promise<SalonPresence> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [player.playerId]);
      const structure = await client.query<{
        structure_id: string;
        lat: number;
        lon: number;
        placement_revision: string | number;
      }>(
        `SELECT structure_id,lat,lon,placement_revision
         FROM city_structures
         WHERE structure_id=$1::uuid AND structure_type='salon' AND state='active'
         FOR SHARE`,
        [structureId]
      );
      const row = structure.rows[0];
      if (!row) throw new SalonError("SALON_NOT_ACTIVE", "That Salon is unavailable.");
      if (String(row.placement_revision) !== expectedPlacementRevision) {
        throw new SalonError("SALON_CHANGED", "That Salon changed before entry.");
      }
      if (distanceMeters(player.position, { lat: Number(row.lat), lon: Number(row.lon) }) > DEFAULT_INTERACTION_RADIUS_M) {
        throw new SalonError("SALON_OUT_OF_RANGE", "Move closer to the Salon entrance.");
      }
      const existing = await client.query("SELECT 1 FROM salon_presence WHERE player_id=$1", [player.playerId]);
      if (existing.rowCount) throw new SalonError("ALREADY_INSIDE", "You are already inside a Salon.");
      const sessionId = randomUUID();
      const inserted = await client.query<PresenceRow>(
        `INSERT INTO salon_presence (
           player_id,salon_structure_id,session_id,local_x,local_y,
           return_region_code,return_lat,return_lon
         ) VALUES ($1,$2::uuid,$3::uuid,$4,$5,$6,$7,$8)
         RETURNING player_id,salon_structure_id::text,session_id::text,local_x,local_y,
                   return_region_code,return_lat,return_lon`,
        [player.playerId, structureId, sessionId, SALON_SPAWN.x, SALON_SPAWN.y,
          player.regionCode, player.position.lat, player.position.lon]
      );
      await client.query("COMMIT");
      return mapPresence(inserted.rows[0]!);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async loadPresence(playerId: string): Promise<SalonPresence | null> {
    const result = await this.pool.query<PresenceRow>(
      `SELECT player_id,salon_structure_id::text,session_id::text,local_x,local_y,
              return_region_code,return_lat,return_lon
       FROM salon_presence WHERE player_id=$1`,
      [playerId]
    );
    return result.rows[0] ? mapPresence(result.rows[0]) : null;
  }

  async persistLocalPosition(
    playerId: string,
    structureId: string,
    x: number,
    y: number
  ): Promise<void> {
    await this.pool.query(
      `UPDATE salon_presence SET local_x=$3,local_y=$4,updated_at=clock_timestamp()
       WHERE player_id=$1 AND salon_structure_id=$2::uuid`,
      [playerId, structureId, x, y]
    );
  }

  async exit(playerId: string, salonSessionId: string): Promise<SalonPresence> {
    const result = await this.pool.query<PresenceRow>(
      `DELETE FROM salon_presence
       WHERE player_id=$1 AND session_id=$2::uuid
       RETURNING player_id,salon_structure_id::text,session_id::text,local_x,local_y,
                 return_region_code,return_lat,return_lon`,
      [playerId, salonSessionId]
    );
    const row = result.rows[0];
    if (!row) throw new SalonError("STALE_SESSION", "That Salon session is stale.");
    this.editorSessions.delete(playerId);
    return mapPresence(row);
  }

  async stylesForPlayer(playerId: string): Promise<{
    styles: PlayerSalonStyles;
    revision: number;
  }> {
    const result = await this.pool.query<PlayerStyleRow>(
      `SELECT ${PLAYER_STYLE_COLUMNS}
       FROM players WHERE id=$1`,
      [playerId]
    );
    const row = result.rows[0];
    if (!row) throw new SalonError("PLAYER_NOT_FOUND", "Player appearance is unavailable.");
    return { styles: stylesFromRow(row), revision: Number(row.base_appearance_revision) };
  }

  async beginCustomize(
    playerId: string,
    runtime: SalonRuntimeSession
  ): Promise<{
    editorSessionId: string;
    releaseSha: string | null;
    catalogRevision: number;
    schemaVersion: number;
    appearanceRevision: number;
    styles: PlayerSalonStyles;
  }> {
    const current = await this.stylesForPlayer(playerId);
    const editorSessionId = randomUUID();
    this.editorSessions.set(playerId, {
      editorSessionId,
      salonSessionId: runtime.sessionId,
      structureId: runtime.structureId,
      appearanceRevision: current.revision
    });
    return {
      editorSessionId,
      releaseSha: this.releaseSha,
      catalogRevision: DEFAULT_PLAYER_APPEARANCE_CATALOG.catalogRevision,
      schemaVersion: DEFAULT_PLAYER_APPEARANCE_CATALOG.schemaVersion,
      appearanceRevision: current.revision,
      styles: current.styles
    };
  }

  cancelCustomize(playerId: string, editorSessionId: string): void {
    const session = this.editorSessions.get(playerId);
    if (session?.editorSessionId === editorSessionId) this.editorSessions.delete(playerId);
  }

  invalidateEditor(playerId: string): void {
    this.editorSessions.delete(playerId);
  }

  /**
   * Wear a mask from the inventory, or take it off (null). Needs a copy in the inventory; the worn
   * copy stays there, locked (1200 refuses any removal or an unowned mask at commit).
   */
  async equipMask(playerId: string, copyId: string | null): Promise<{
    styles: PlayerSalonStyles;
    revision: number;
    changed: boolean;
    message: string;
    maskCopyId: string | null;
  }> {
    if (copyId !== null && !isShopCopyId(copyId)) {
      throw new SalonError("MASK_UNKNOWN", "That mask does not exist.");
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [playerId]);
      const locked = await client.query<PlayerStyleRow>(
        `SELECT ${PLAYER_STYLE_COLUMNS} FROM players WHERE id=$1 FOR UPDATE`,
        [playerId]
      );
      const row = locked.rows[0];
      if (!row) throw new SalonError("PLAYER_NOT_FOUND", "Player appearance is unavailable.");
      const current = row.mask_appearance_id ?? null;
      const currentCopy = (await client.query<{ mask_copy_id: string | null }>(
        "SELECT mask_copy_id FROM players WHERE id=$1", [playerId]
      )).rows[0]?.mask_copy_id ?? null;
      let revision = Number(row.base_appearance_revision);
      if (currentCopy === copyId && (copyId !== null || current === null)) {
        await client.query("COMMIT");
        return {
          styles: stylesFromRow(row),
          revision,
          changed: false,
          message: current ? `${faceMaskDisplayName(current)} is already on.` : "No mask is worn.",
          maskCopyId: currentCopy
        };
      }
      let appearanceId: string | null = null;
      if (copyId !== null) {
        // The exact copy must be in this player's inventory.
        const held = await client.query<{ look: string }>(
          `SELECT copy.look FROM player_inventory inventory
           JOIN shop_item_copies copy ON copy.copy_id = inventory.variant AND copy.item_id = inventory.resource_type
           WHERE inventory.player_id=$1 AND inventory.resource_type=$2 AND inventory.variant=$3 AND inventory.quantity > 0`,
          [playerId, FACE_MASK_ITEM_ID, copyId]
        );
        appearanceId = held.rows[0]?.look ?? null;
        if (!appearanceId || !isFaceMaskVariant(appearanceId)) {
          throw new SalonError("MASK_NOT_OWNED", "That mask is not in your inventory.");
        }
      }
      revision += 1;
      await client.query(
        "UPDATE players SET mask_appearance_id=$2, mask_copy_id=$4, base_appearance_revision=$3 WHERE id=$1",
        [playerId, appearanceId, revision, copyId]
      );
      await client.query("COMMIT");
      return {
        styles: stylesFromRow({ ...row, mask_appearance_id: appearanceId }),
        revision,
        changed: true,
        message: appearanceId ? `${faceMaskDisplayName(appearanceId)} on.` : `${faceMaskDisplayName(current ?? "")} off.`,
        maskCopyId: copyId
      };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      if ((error as { constraint?: unknown }).constraint === "player_face_mask_worn") {
        throw new SalonError("MASK_NOT_OWNED", "You need that mask in your inventory.");
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async save(input: {
    playerId: string;
    requestId: string;
    editorSessionId: string;
    expectedAppearanceRevision: number;
    catalogRevision: number;
    changes: PlayerSalonStyles;
  }): Promise<{ styles: PlayerSalonStyles; revision: number; replayed: boolean }> {
    const editor = this.editorSessions.get(input.playerId);
    if (!editor || editor.editorSessionId !== input.editorSessionId) {
      throw new SalonError("SALON_EDITOR_STALE", "Reopen the Salon editor.");
    }
    if (input.catalogRevision !== DEFAULT_PLAYER_APPEARANCE_CATALOG.catalogRevision) {
      throw new SalonError("SALON_CATALOG_STALE", "Reload the game to use the current appearance catalog.");
    }
    // Masks are worn only from the inventory (EQUIP_MASK, 1202): a Salon save never touches them.
    const { mask: _ignoredMask, ...salonChanges } = input.changes;
    void _ignoredMask;
    input = { ...input, changes: salonChanges };
    for (const categoryId of Object.keys(input.changes)) {
      if (categoryId === "featurePoints") {
        const points = input.changes.featurePoints;
        if (!points || typeof points !== "object") {
          throw new SalonError("SALON_FEATURE_POINT_INVALID", "That feature position is unavailable.");
        }
        for (const [featureId, point] of Object.entries(points)) {
          if (
            !isFaceFeatureCategory(featureId) ||
            !point ||
            !faceFeaturePointAllowed(DEFAULT_PLAYER_APPEARANCE_CATALOG, featureId, point)
          ) {
            throw new SalonError(
              "SALON_FEATURE_POINT_INVALID",
              "That feature position is outside its allowed area."
            );
          }
        }
        continue;
      }
      if (categoryId === "skinToneId") {
        const skinToneId = input.changes.skinToneId;
        if (!skinToneId || !PLAYER_SKIN_TONE_IDS.includes(skinToneId)) {
          throw new SalonError("SALON_APPEARANCE_UNAVAILABLE", "That skin color is unavailable.");
        }
        continue;
      }
      if (!SALON_SELECTABLE_APPEARANCE_CATEGORY_IDS.includes(
        categoryId as (typeof SALON_SELECTABLE_APPEARANCE_CATEGORY_IDS)[number]
      )) {
        throw new SalonError("SALON_CATEGORY_INVALID", "That appearance category is unavailable.");
      }
    }
    const normalizedChanges: PlayerSalonStyles = {
      ...input.changes,
      ...(Object.hasOwn(input.changes, "eyes") && input.changes.eyes === null
        ? { eyes: DEFAULT_PLAYER_FACE_APPEARANCE_ID }
        : {}),
      ...(input.changes.featurePoints
        ? { featurePoints: canonicalFeaturePoints(input.changes.featurePoints) }
        : {})
    };
    const requestHash = createHash("sha256").update(JSON.stringify({
      editorSessionId: input.editorSessionId,
      expectedAppearanceRevision: input.expectedAppearanceRevision,
      catalogRevision: input.catalogRevision,
      changes: Object.fromEntries(Object.entries(normalizedChanges).sort())
    })).digest("hex");
    const operationKey = `salon:${input.playerId}:${input.requestId}`;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [input.playerId]);
      const replay = await client.query<{
        request_hash: string;
        result: { styles: PlayerSalonStyles; revision: number } | null;
      }>(
        `SELECT request_hash,result FROM salon_appearance_operations
         WHERE operation_key=$1 FOR UPDATE`,
        [operationKey]
      );
      if (replay.rows[0]) {
        if (replay.rows[0].request_hash !== requestHash || !replay.rows[0].result) {
          throw new SalonError("SALON_IDEMPOTENCY_CONFLICT", "That request ID was already used.");
        }
        await client.query("COMMIT");
        return {
          ...replay.rows[0].result,
          styles: normalizePlayerSalonStyles(replay.rows[0].result.styles),
          replayed: true
        };
      }
      const locked = await client.query<PlayerStyleRow>(
        `SELECT ${PLAYER_STYLE_COLUMNS}
         FROM players WHERE id=$1 FOR UPDATE`,
        [input.playerId]
      );
      const row = locked.rows[0];
      if (!row) throw new SalonError("PLAYER_NOT_FOUND", "Player appearance is unavailable.");
      const currentRevision = Number(row.base_appearance_revision);
      const currentStyles = stylesFromRow(row);
      if (
        currentRevision !== input.expectedAppearanceRevision ||
        currentRevision !== editor.appearanceRevision
      ) {
        throw new SalonError("SALON_APPEARANCE_STALE", "Appearance changed; reopen the editor.");
      }
      for (const [categoryId, appearanceId] of Object.entries(normalizedChanges)) {
        if (categoryId === "skinToneId" || categoryId === "featurePoints") continue;
        const appearanceCategory = categoryId as SalonAppearanceCategoryId;
        if (appearanceId === null || appearanceId === currentStyles[appearanceCategory]) continue;
        const appearance = DEFAULT_PLAYER_APPEARANCE_CATALOG.appearances.find(
          (candidate) => candidate.appearanceId === appearanceId
        );
        if (
          !appearance ||
          !salonAppearanceSelectable(appearance) ||
          salonAppearanceCategory(DEFAULT_PLAYER_APPEARANCE_CATALOG, appearance) !== appearanceCategory
        ) {
          throw new SalonError("SALON_APPEARANCE_UNAVAILABLE", "That appearance cannot be selected.");
        }
      }
      // A sent feature-point map replaces the stored map; omitted categories use defaults.
      const styles = normalizePlayerSalonStyles({
        ...currentStyles,
        ...normalizedChanges
      });
      const points = styles.featurePoints ?? {};
      const revision = currentRevision + 1;
      await client.query(
        `INSERT INTO salon_appearance_operations (
           operation_key,player_id,request_id,salon_structure_id,request_hash,
           catalog_revision,prior_revision,intent
         ) VALUES ($1,$2,$3,$4::uuid,$5,$6,$7,$8::jsonb)`,
        [operationKey, input.playerId, input.requestId, editor.structureId, requestHash,
          input.catalogRevision, currentRevision, JSON.stringify(normalizedChanges)]
      );
      await client.query(
        `UPDATE players SET
           hair_appearance_id=$2,
           eyes_appearance_id=$3,
           nose_mouth_appearance_id=$4,
           beard_appearance_id=$5,
           mask_appearance_id=$6,
           legs_overlay_appearance_id=$7,
           skin_tone_id=$8,
           base_appearance_revision=$9,
           nose_appearance_id=$10,
           mouth_appearance_id=$11,
           eyes_feature_x=$12,
           eyes_feature_y=$13,
           nose_feature_x=$14,
           nose_feature_y=$15,
           mouth_feature_x=$16,
           mouth_feature_y=$17,
           last_seen_at=clock_timestamp()
         WHERE id=$1`,
        [input.playerId, styles.hair ?? null, styles.eyes ?? DEFAULT_PLAYER_FACE_APPEARANCE_ID,
          null, styles.beard ?? null, styles.mask ?? null, styles.legs ?? null,
          styles.skinToneId ?? DEFAULT_PLAYER_SKIN_TONE_ID, revision,
          styles.nose ?? null, styles.mouth ?? null,
          points.eyes?.x ?? null, points.eyes?.y ?? null,
          points.nose?.x ?? null, points.nose?.y ?? null,
          points.mouth?.x ?? null, points.mouth?.y ?? null]
      );
      const result = { styles, revision };
      await client.query(
        `UPDATE salon_appearance_operations SET
           resulting_revision=$2,result=$3::jsonb,completed_at=clock_timestamp()
         WHERE operation_key=$1`,
        [operationKey, revision, JSON.stringify(result)]
      );
      await client.query("COMMIT");
      editor.appearanceRevision = revision;
      return { ...result, replayed: false };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

export function stylesFromRow(row: Partial<PlayerStyleRow>): PlayerSalonStyles {
  return normalizePlayerSalonStyles({
    hair: row.hair_appearance_id ?? null,
    eyes: row.eyes_appearance_id ?? null,
    nose: row.nose_appearance_id ?? null,
    mouth: row.mouth_appearance_id ?? null,
    beard: row.beard_appearance_id ?? null,
    mask: row.mask_appearance_id ?? null,
    legs: row.legs_overlay_appearance_id ?? null,
    skinToneId: row.skin_tone_id === "medium" || row.skin_tone_id === "dark"
      ? row.skin_tone_id
      : DEFAULT_PLAYER_SKIN_TONE_ID,
    // Points left outside a redrawn area fall back to the area default.
    featurePoints: sanitizeFaceFeaturePoints(DEFAULT_PLAYER_APPEARANCE_CATALOG, {
      ...featurePointFromRow("eyes", row.eyes_feature_x, row.eyes_feature_y),
      ...featurePointFromRow("nose", row.nose_feature_x, row.nose_feature_y),
      ...featurePointFromRow("mouth", row.mouth_feature_x, row.mouth_feature_y)
    })
  });
}

function featurePointFromRow(
  categoryId: keyof FaceFeaturePoints,
  x: number | string | null | undefined,
  y: number | string | null | undefined
): FaceFeaturePoints {
  if (x === null || x === undefined || y === null || y === undefined) return {};
  return { [categoryId]: { x: Number(x), y: Number(y) } };
}

function canonicalFeaturePoints(points: FaceFeaturePoints): FaceFeaturePoints {
  return Object.fromEntries(FACE_FEATURE_CATEGORY_IDS.flatMap((categoryId) => {
    const point = points[categoryId];
    return point ? [[categoryId, { x: point.x, y: point.y }]] : [];
  })) as FaceFeaturePoints;
}

function mapPresence(row: PresenceRow): SalonPresence {
  return {
    playerId: row.player_id,
    structureId: row.salon_structure_id,
    sessionId: row.session_id,
    localX: Number(row.local_x),
    localY: Number(row.local_y),
    returnRegionCode: row.return_region_code,
    returnLat: Number(row.return_lat),
    returnLon: Number(row.return_lon)
  };
}

function cloneSession(session: SalonRuntimeSession): SalonRuntimeSession {
  return { ...session, position: { ...session.position } };
}
