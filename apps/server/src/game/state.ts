import type {
  LatLon,
  HungerSnapshot,
  PlayerGatheringActivity,
  PersonalFlagColor,
  PlayerBodyVariantId,
  PlayerAppearanceSnapshot,
  PlayerSalonStyles,
  PlayerSnapshot,
  ResourceVision,
  SpecializationId
} from "@ash-atlas/shared";
import { randomUUID } from "node:crypto";
import {
  DASH_COOLDOWN_MS,
  DASH_DISTANCE_M,
  DASH_DURATION_MS,
  DASH_IFRAME_MS,
  DASH_MIN_DISTANCE_M,
  DASH_SPEED_MPS,
  GAMEPLAY_AREA_BOUNDARY_EPSILON_M,
  WORLD_EDGE_MESSAGE,
  clampToWorldEdge,
  dashEndPoint,
  distanceMeters,
  hungerSnapshot,
  isWithinWorldEdge,
  moveToward
} from "@ash-atlas/shared";

import type { AppConfig } from "../config.js";
import type { AppLogger } from "../logger.js";
import { sanitizeUsername } from "./validation.js";
import {
  packageIdForPosition,
  zoneIdsIntersectingCircle,
  zoneIdForPosition
} from "./spatialZones.js";
import { SHORE_STOP_M, cellKey, pathCells, snapToSampleGrid } from "./waterCells.js";

/** A move that starts this close to where the player last arrived (login, relocation, respawn) is at the arrival. */
const ARRIVAL_SPOT_M = 1;

export type PlayerRecord = {
  playerId: string;
  username: string;
  displayColor: string | null;
  personalFlagColor?: PersonalFlagColor;
  regionCode: string;
  position: LatLon;
  anchor: LatLon;
  moveLeashRadiusM: number;
  movementRevision: number;
  relocationRevision?: number;
  target: LatLon | null;
  online: boolean;
  updatedAt: Date;
  resourceVision?: ResourceVision | null;
  appearance?: PlayerAppearanceSnapshot;
  bodyVariantId?: PlayerBodyVariantId;
  salonStyles?: PlayerSalonStyles;
  salonAppearanceRevision?: number;
  hunger?: HungerSnapshot;
  /** Water travel: on a raft (ocean/lake). Persisted; overworld only. */
  afloat?: boolean;
  /** Live gathering action broadcast to nearby players. Never persisted. */
  gathering?: PlayerGatheringActivity | null;
};

export type WaterLegSurface = "land" | "open_water" | "unknown";

/** Overworld dash bookkeeping. Times are wall-clock epoch ms (the dash clock). */
export type PlayerDashState = {
  requestId: string;
  from: LatLon;
  /** The dash target object; the dash is moving only while `player.target === to`. */
  to: LatLon;
  startedAtMs: number;
  untilMs: number;
  cooldownUntilMs: number;
  iframeUntilMs: number;
  active: boolean;
  /** A MOVE_TO accepted mid-dash; it starts the moment the dash ends. */
  queued: { target: LatLon; waterLeg?: WaterLeg } | null;
};

export type DashRejectReason = "unavailable" | "blocked" | "water" | "cooldown" | "leash";

/** Why a dash was refused; the message is sent to the client. */
export class DashRejectedError extends Error {
  constructor(readonly reason: DashRejectReason, message: string) {
    super(message);
    this.name = "DashRejectedError";
  }
}

/** Speed/afloat breakpoints for one straight MOVE_TO leg, measured from `origin`. */
export type WaterLeg = Readonly<{
  origin: LatLon;
  relocationRevision: number;
  segments: readonly Readonly<{ startM: number; multiplier: number; surface: WaterLegSurface }>[];
  /**
   * Stranded exit: an unrafted player left on water by a fail-open walk may wade the leading water of this
   * leg up to here (metres from origin) to reach land. The shore guard lets those cells pass. Never afloat.
   */
  wadeM?: number;
}>;

export type CombatApproachPlanResult =
  | Readonly<{ blocked: true }>
  | Readonly<{ blocked: false; target: LatLon; leg: WaterLeg | null }>;

export type PlayerPersistenceCapture = {
  playerId: string;
  generation: number;
  version: number;
  snapshot: PlayerSnapshot;
};

export type ActiveRuntimeMetrics = {
  loadedPlayers: number;
  onlinePlayers: number;
  movingPlayers: number;
  resourceVisionPlayers: number;
  flagMemberships: number;
  replicationPlayers: number;
};

export type AuthoritativeGameplayViewCircle = {
  anchorType: "normal" | "flag";
  anchorId: string;
  center: LatLon;
  radiusM: number;
  generation: number;
  eligibleRegionCodes: readonly string[];
  eligibleZoneIds: readonly string[];
};

export type AuthoritativeTravelAnchor = Readonly<{
  scopeId: "world" | "manor";
  layerId: string;
  center: LatLon;
  relocationRevision: number;
  layerGeneration: number;
  sourceType: "flag" | "kingdom_seat" | "area" | "player_anchor" | "manor";
  sourceId: string | null;
}>;

export type PlayerViewTransitionSnapshot = {
  regionCode: string;
  movementRevision: number;
  relocationRevision: number;
  position: LatLon;
  anchor: LatLon;
  target: LatLon | null;
  resourceVision: ResourceVision | null;
  resourceVisionRevision: number;
  viewGeneration: number;
  updatedAt: Date;
  afloat: boolean;
};

export type AuthoritativeRelocationInput = Readonly<{
  playerId: string;
  anchor: LatLon;
  playerSpawnPosition?: LatLon;
  authoritativeRegionCode?: string;
  resourceVision: ResourceVision | null;
}>;

export type InPlaceFlagViewInput = Readonly<{
  playerId: string;
  authoritativeRegionCode?: string;
  resourceVision: ResourceVision;
}>;

const LEASH_EPSILON_M = 0.05;

export class GameState {
  private readonly players = new Map<string, PlayerRecord>();
  private readonly dirtyPlayerIds = new Set<string>();
  private readonly dirtyPlayerSince = new Map<string, number>();
  private readonly resourceVisions = new Map<string, ResourceVision>();
  private readonly resourceVisionRevisions = new Map<string, number>();
  private readonly viewGenerations = new Map<string, number>();
  private readonly movementBlockReasons = new Map<string, Set<string>>();
  private readonly nonWorldPlayerIds = new Set<string>();
  private readonly onlinePlayerIds = new Set<string>();
  private readonly movingPlayerIds = new Set<string>();
  /** The movement multiplier the last tick (or move acceptance) applied, clamped like the tick. Never persisted. */
  private readonly movementMultipliers = new Map<string, number>();
  private readonly resourceVisionPlayerIds = new Set<string>();
  private readonly flagPlayerIds = new Map<string, Set<string>>();
  private readonly indexedFlagIdsByPlayer = new Map<string, string>();
  private readonly replicationPlayerIds = new Set<string>();
  private readonly playerGenerations = new Map<string, number>();
  private readonly playerVersions = new Map<string, number>();
  private readonly worldAuthorityEpochs = new Map<string, string>();
  private readonly waterLegs = new Map<string, WaterLeg & { target: LatLon }>();
  private readonly dashes = new Map<string, PlayerDashState>();
  /** Players whose first tick after a dash landing is logged (dash diagnostics). */
  private readonly dashLandingLog = new Set<string>();
  private dashClock: () => number = () => Date.now();
  /** Afloat players who have actually been on open water since launching. */
  private readonly wetPlayerIds = new Set<string>();
  /** Where each player last arrived in the world (login, relocation, respawn): the only free-raft spots. */
  private readonly arrivalSpots = new Map<string, { position: LatLon; relocationRevision: number }>();
  /** Cache-only surface of a grid cell for the shore guard; null when water travel is not wired. */
  private waterSurfaceAt: ((point: LatLon) => WaterLegSurface) | null = null;
  private worldArrivalListener: ((playerId: string) => void) | null = null;
  private combatApproachPlanner: ((playerId: string, target: LatLon) => CombatApproachPlanResult) | null = null;
  private combatApproachBlocked: ((playerId: string) => void) | null = null;
  /** The player's active class (PlayerSnapshot.classId); the combat runtime owns it. */
  private playerClassIdResolver: ((playerId: string) => SpecializationId | null) | null = null;
  private nextPlayerGeneration = 0;
  private nextPlayerVersion = 0;

  constructor(
    private readonly config: AppConfig,
    private readonly logger?: Pick<AppLogger, "warn"> & Partial<Pick<AppLogger, "info" | "debug">>
  ) {}

  helloPlayer(playerId: string, username: string): PlayerRecord {
    const existing = this.players.get(playerId);
    if (existing) {
      if (!this.worldAuthorityEpochs.has(playerId)) {
        this.worldAuthorityEpochs.set(playerId, randomUUID());
      }
      existing.username = sanitizeUsername(username);
      existing.online = true;
      existing.hunger ??= hungerSnapshot();
      this.playerGenerations.set(playerId, ++this.nextPlayerGeneration);
      this.refreshActiveIndexes(playerId);
      existing.updatedAt = new Date();
      this.markDirty(existing.playerId);
      return existing;
    }

    const player: PlayerRecord = {
      playerId,
      username: sanitizeUsername(username),
      displayColor: displayColorForPlayer(playerId),
      regionCode: packageIdForPosition({
        lat: this.config.DEFAULT_SPAWN_LAT,
        lon: this.config.DEFAULT_SPAWN_LON
      }),
      position: {
        lat: this.config.DEFAULT_SPAWN_LAT,
        lon: this.config.DEFAULT_SPAWN_LON
      },
      anchor: {
        lat: this.config.DEFAULT_SPAWN_LAT,
        lon: this.config.DEFAULT_SPAWN_LON
      },
      moveLeashRadiusM: this.config.MOVE_LEASH_RADIUS_M,
      movementRevision: 0,
      relocationRevision: 0,
      target: null,
      online: true,
      bodyVariantId: "default",
      hunger: hungerSnapshot(),
      updatedAt: new Date()
    };
    this.players.set(playerId, player);
    this.worldAuthorityEpochs.set(playerId, randomUUID());
    this.playerGenerations.set(playerId, ++this.nextPlayerGeneration);
    this.refreshActiveIndexes(playerId);
    this.bumpViewGeneration(playerId);
    this.markDirty(playerId);
    return player;
  }

  connectPlayer(player: PlayerRecord): PlayerRecord {
    this.removeFromActiveIndexes(player.playerId);
    // Legacy records beyond the world edge are not migrated; the live player is
    // pulled back onto the edge (position and anchor, so the leash stays valid).
    const position = clampToWorldEdge(player.position);
    const anchor = clampToWorldEdge(player.anchor);
    if (position !== player.position || anchor !== player.anchor) {
      this.logger?.warn(
        { playerId: player.playerId, persistedPosition: player.position, persistedAnchor: player.anchor },
        "persisted player position clamped to the world edge"
      );
    }
    const persistedVision = player.resourceVision
      ? structuredClone(player.resourceVision)
      : null;
    const repairedVision = persistedVision
      ? resourceVisionAtAnchor(persistedVision, anchor)
      : null;
    if (persistedVision && !samePosition(persistedVision.center, anchor)) {
      this.logger?.warn(
        {
          playerId: player.playerId,
          persistedAnchor: anchor,
          persistedResourceVisionCenter: persistedVision.center
        },
        "resource vision center repaired to the persisted player anchor"
      );
    }
    const connected: PlayerRecord = {
      ...player,
      position,
      anchor,
      username: sanitizeUsername(player.username),
      regionCode: packageIdForPosition(position),
      displayColor: player.displayColor ?? displayColorForPlayer(player.playerId),
      moveLeashRadiusM: player.moveLeashRadiusM || this.config.MOVE_LEASH_RADIUS_M,
      movementRevision: player.movementRevision ?? 0,
      relocationRevision: player.relocationRevision ?? 0,
      target: null,
      online: true,
      hunger: hungerSnapshot(player.hunger?.current, player.hunger?.baseCapacity),
      updatedAt: new Date(),
      resourceVision: repairedVision ? structuredClone(repairedVision) : null
    };
    this.players.set(player.playerId, connected);
    this.worldAuthorityEpochs.set(player.playerId, randomUUID());
    if (repairedVision) {
      this.resourceVisions.set(player.playerId, structuredClone(repairedVision));
    } else {
      this.resourceVisions.delete(player.playerId);
    }
    this.resourceVisionRevisions.set(
      player.playerId,
      persistedVision && !samePosition(persistedVision.center, anchor) ? 1 : 0
    );
    this.playerGenerations.set(player.playerId, ++this.nextPlayerGeneration);
    this.waterLegs.delete(player.playerId);
    this.wetPlayerIds.delete(player.playerId);
    this.refreshActiveIndexes(player.playerId);
    this.bumpViewGeneration(player.playerId);
    this.markDirty(player.playerId);
    this.notifyWorldArrival(player.playerId);
    return connected;
  }

  getPlayer(playerId: string): PlayerRecord | undefined {
    return this.players.get(playerId);
  }

  /** Called after login, relocation and respawn so water travel can classify the arrival point. */
  onWorldArrival(listener: ((playerId: string) => void) | null): void {
    this.worldArrivalListener = listener;
  }

  isAfloat(playerId: string): boolean {
    return this.players.get(playerId)?.afloat === true;
  }

  isWet(playerId: string): boolean {
    return this.wetPlayerIds.has(playerId);
  }

  /**
   * Publish (or clear with null) what the player is gathering. Replication compares snapshots,
   * so this needs no persistence dirty mark; moving or relocating clears it.
   */
  setGatheringActivity(playerId: string, activity: PlayerGatheringActivity | null): void {
    const player = this.players.get(playerId);
    if (!player) return;
    player.gathering = activity ? { ...activity } : null;
  }

  gatheringActivity(playerId: string): PlayerGatheringActivity | null {
    return this.players.get(playerId)?.gathering ?? null;
  }

  setAfloat(playerId: string, afloat: boolean, wet = false): void {
    const player = this.players.get(playerId);
    if (!player) return;
    if (afloat && wet) this.wetPlayerIds.add(playerId);
    else if (!afloat) this.wetPlayerIds.delete(playerId);
    if ((player.afloat === true) === afloat) return;
    player.afloat = afloat;
    player.updatedAt = new Date();
    this.markDirty(playerId);
  }

  /** The tick's shore guard reads cached cell surfaces through this (water travel wires it). */
  setWaterSurfaceLookup(lookup: ((point: LatLon) => WaterLegSurface) | null): void {
    this.waterSurfaceAt = lookup;
  }

  /**
   * True while the player still stands where they last arrived (login, relocation, respawn) since that
   * arrival. Only there does standing on open water make an unrafted player afloat for free.
   */
  isAtArrivalSpot(playerId: string): boolean {
    const player = this.players.get(playerId);
    const spot = this.arrivalSpots.get(playerId);
    return Boolean(
      player && spot &&
      (player.relocationRevision ?? 0) === spot.relocationRevision &&
      distanceMeters(player.position, spot.position) <= ARRIVAL_SPOT_M
    );
  }

  private notifyWorldArrival(playerId: string): void {
    const arrived = this.players.get(playerId);
    if (arrived) {
      this.arrivalSpots.set(playerId, {
        position: { ...arrived.position },
        relocationRevision: arrived.relocationRevision ?? 0
      });
    }
    try {
      this.worldArrivalListener?.(playerId);
    } catch (error) {
      this.logger?.warn({ err: error, playerId }, "world arrival listener failed");
    }
  }

  private clearWaterTravel(player: PlayerRecord): void {
    this.waterLegs.delete(player.playerId);
    this.wetPlayerIds.delete(player.playerId);
    player.afloat = false;
  }

  get playerMovementSpeedMps(): number {
    return this.config.PLAYER_SPEED_MPS;
  }

  /** Caches the walking multiplier (combat/equipment/class/slows) the tick uses; ignored when negative (held in place). */
  noteMovementMultiplier(playerId: string, multiplier: number): void {
    if (Number.isFinite(multiplier) && multiplier >= 0) {
      this.movementMultipliers.set(playerId, Math.max(0.2, Math.min(2, multiplier)));
    }
  }

  /**
   * Effective walking speed the tick applies on land: PLAYER_SPEED_MPS x clamp(0.2..2, multiplier), sent to the owning
   * client (MOVE_ACCEPTED, self movement upserts) so its prediction walks at the server's pace. Undefined before the first
   * multiplier is known.
   */
  effectiveSpeedMps(playerId: string): number | undefined {
    const multiplier = this.movementMultipliers.get(playerId);
    return multiplier === undefined ? undefined : this.config.PLAYER_SPEED_MPS * multiplier;
  }

  setTarget(playerId: string, target: LatLon, waterLeg?: WaterLeg): PlayerRecord {
    const player = this.players.get(playerId);
    if (!player) {
      throw new Error("player is not connected");
    }
    if (!player.online) {
      throw new Error("player is offline");
    }
    if (this.isMovementBlocked(playerId)) {
      throw new Error(this.isMovementBlocked(playerId, "default")
        ? "player cannot move while defeated"
        : "player cannot move while an authoritative action is active");
    }
    if (this.nonWorldPlayerIds.has(playerId)) {
      throw new Error("world movement is unavailable in the current interior location");
    }
    if (!isWithinWorldEdge(target)) {
      // Clients resolve taps onto the edge first; anything past it is rejected like the leash.
      throw new Error(WORLD_EDGE_MESSAGE);
    }
    const distanceFromAnchor = distanceMeters(player.anchor, target);
    // Walking away ends any gathering pose others see, whatever the session's own fate.
    player.gathering = null;
    if (distanceFromAnchor > player.moveLeashRadiusM) {
      throw new Error(
        `MOVE_TO target is outside the ${player.moveLeashRadiusM}m movement leash`
      );
    }
    const leg = waterLeg && waterLeg.relocationRevision === (player.relocationRevision ?? 0)
      ? waterLeg
      : null;
    const dash = this.movingDash(player);
    if (dash) {
      // Mid-dash input (joystick resume, a tap) waits for the dash to land, then starts at once.
      dash.queued = { target: { ...target }, ...(leg ? { waterLeg: leg } : {}) };
      return player;
    }
    if (player.target && distanceMeters(player.target, target) <= LEASH_EPSILON_M) {
      if (leg) this.waterLegs.set(playerId, { ...leg, target: player.target });
      return player;
    }
    player.target = target;
    if (leg) this.waterLegs.set(playerId, { ...leg, target });
    else this.waterLegs.delete(playerId);
    this.refreshActiveIndexes(playerId);
    player.movementRevision += 1;
    player.updatedAt = new Date();
    this.markDirty(player.playerId);
    return player;
  }

  /** Tests inject a clock; production uses wall time (the combat engine's clock too). */
  setDashClock(now: () => number): void {
    this.dashClock = now;
  }

  /** The dash whose movement is in progress, or null. */
  private movingDash(player: PlayerRecord): PlayerDashState | null {
    const dash = this.dashes.get(player.playerId);
    if (!dash?.active) return null;
    if (player.target !== dash.to) {
      // Something else (relocation, a stop, a knockback) replaced the dash path.
      dash.active = false;
      dash.queued = null;
      return null;
    }
    return dash;
  }

  getDash(playerId: string): Readonly<PlayerDashState> | null {
    return this.dashes.get(playerId) ?? null;
  }

  isDashing(playerId: string): boolean {
    const player = this.players.get(playerId);
    return Boolean(player && this.movingDash(player));
  }

  /** Dash invulnerability frames: true from the dash start for DASH_IFRAME_MS. */
  isDashInvulnerable(playerId: string, nowMs = this.dashClock()): boolean {
    const dash = this.dashes.get(playerId);
    return Boolean(dash && nowMs >= dash.startedAtMs && nowMs < dash.iframeUntilMs);
  }

  /** A MOVE_TO accepted mid-dash reports this target (where the player heads after landing). */
  pendingTargetAfterDash(playerId: string): LatLon | null {
    const player = this.players.get(playerId);
    const dash = player ? this.movingDash(player) : null;
    return dash?.queued ? { ...dash.queued.target } : null;
  }

  /**
   * True when the current walk leg touches water (open water or a non-1 speed segment). Every
   * MOVE_TO carries a leg once water planning ran, so an all-land walk must not count.
   */
  private isInWaterTransition(playerId: string): boolean {
    const leg = this.waterLegs.get(playerId);
    if (!leg) return false;
    return leg.segments.some((segment) => segment.surface === "open_water" || segment.multiplier !== 1);
  }

  private assertDashAllowed(player: PlayerRecord | undefined, nowMs: number): PlayerRecord {
    if (!player || !player.online || this.nonWorldPlayerIds.has(player.playerId)) {
      throw new DashRejectedError("unavailable", "Dash is only available in the overworld.");
    }
    if (this.isMovementBlocked(player.playerId)) {
      throw new DashRejectedError("blocked", "You can't dash right now.");
    }
    if (player.afloat === true || this.isInWaterTransition(player.playerId)) {
      throw new DashRejectedError("water", "You can't dash on the water.");
    }
    const previous = this.dashes.get(player.playerId);
    if (previous && nowMs < previous.cooldownUntilMs) {
      throw new DashRejectedError("cooldown", "Dash is recharging.");
    }
    return player;
  }

  /**
   * The authoritative dash end for a world-space unit direction (dirX east, dirY north), from the
   * server position, clamped to the world edge and inside the movement leash. Throws DashRejectedError.
   */
  planDash(
    playerId: string,
    dirX: number,
    dirY: number,
    nowMs = this.dashClock(),
    maxDistanceM = DASH_DISTANCE_M
  ): LatLon {
    const player = this.assertDashAllowed(this.players.get(playerId), nowMs);
    const origin = { ...player.position };
    const limitM = Math.max(0, player.moveLeashRadiusM - GAMEPLAY_AREA_BOUNDARY_EPSILON_M);
    const allowed = (meters: number): boolean => {
      const point = dashEndPoint(origin, dirX, dirY, meters);
      return isWithinWorldEdge(point) && distanceMeters(player.anchor, point) <= limitM;
    };
    let distanceM = Math.max(0, Math.min(DASH_DISTANCE_M, maxDistanceM));
    if (!allowed(distanceM)) {
      let low = 0;
      let high = distanceM;
      for (let i = 0; i < 18; i += 1) {
        const mid = (low + high) / 2;
        if (allowed(mid)) low = mid; else high = mid;
      }
      distanceM = low;
    }
    if (distanceM < DASH_MIN_DISTANCE_M) {
      throw new DashRejectedError("leash", "You can't dash any further this way.");
    }
    return dashEndPoint(origin, dirX, dirY, distanceM);
  }

  /** Starts a dash to an end from planDash; every rule is re-checked here, at command time. */
  startDash(playerId: string, requestId: string, end: LatLon, nowMs = this.dashClock()): {
    player: PlayerRecord;
    dash: PlayerDashState;
  } {
    const player = this.assertDashAllowed(this.players.get(playerId), nowMs);
    if (
      !validLatLon(end) || !isWithinWorldEdge(end) ||
      distanceMeters(player.anchor, end) > player.moveLeashRadiusM ||
      distanceMeters(player.position, end) > DASH_DISTANCE_M + 1
    ) {
      throw new DashRejectedError("leash", "You can't dash any further this way.");
    }
    const to = { ...end };
    const dash: PlayerDashState = {
      requestId,
      from: { ...player.position },
      to,
      startedAtMs: nowMs,
      untilMs: nowMs + DASH_DURATION_MS,
      cooldownUntilMs: nowMs + DASH_COOLDOWN_MS,
      iframeUntilMs: nowMs + DASH_IFRAME_MS,
      active: true,
      queued: null
    };
    this.dashes.set(playerId, dash);
    player.gathering = null;
    player.target = to;
    this.waterLegs.delete(playerId);
    player.movementRevision += 1;
    player.updatedAt = new Date(nowMs);
    this.markDirty(playerId);
    this.refreshActiveIndexes(playerId);
    return { player, dash };
  }

  /** Dash movement: fixed DASH_SPEED_MPS, no speed multipliers; lands stationary (or on a queued move). */
  private stepDash(player: PlayerRecord, deltaSeconds: number): void {
    const dash = this.dashes.get(player.playerId)!;
    const stepM = DASH_SPEED_MPS * Math.max(0, deltaSeconds);
    const remaining = distanceMeters(player.position, dash.to);
    const overdue = this.dashClock() >= dash.untilMs + DASH_DURATION_MS;
    const next = remaining <= stepM
      ? clampToWorldEdge({ ...dash.to })
      : clampToWorldEdge(moveToward(player.position, dash.to, stepM));
    // An unrafted dash that reaches a known water cell lands on the shore instead.
    const shoreStop = this.shoreGuardStop(player, player.position, next);
    player.position = shoreStop ?? next;
    player.regionCode = packageIdForPosition(player.position);
    if (remaining <= stepM || overdue || shoreStop) {
      dash.active = false;
      player.target = null;
      player.movementRevision += 1;
      const queued = dash.queued;
      dash.queued = null;
      if (queued) {
        try {
          this.setTarget(player.playerId, queued.target, queued.waterLeg);
        } catch {
          // The queued move became invalid during the dash; stay where the dash landed.
        }
      }
    }
    this.constrainPlayerToMovementLeash(player, "dash");
    this.logger?.debug?.({
      event: "dash_tick", playerId: player.playerId, requestId: dash.requestId,
      phase: dash.active ? "moving" : "landed",
      fromStartM: round2(distanceMeters(dash.from, player.position)),
      toEndM: round2(distanceMeters(player.position, dash.to)),
      lat: player.position.lat, lon: player.position.lon
    }, "dash tick");
    if (!dash.active) this.dashLandingLog.add(player.playerId);
    player.updatedAt = new Date();
    this.markDirty(player.playerId);
    this.refreshActiveIndexes(player.playerId);
  }

  private classIdSnapshotField(playerId: string): { classId?: SpecializationId } {
    const classId = this.playerClassIdResolver?.(playerId) ?? null;
    return classId ? { classId } : {};
  }

  private dashSnapshotFields(player: PlayerRecord): { dash?: NonNullable<PlayerSnapshot["dash"]> } {
    const dash = this.dashes.get(player.playerId);
    if (!dash) return {};
    const moving = this.movingDash(player) !== null;
    if (!moving && this.dashClock() >= dash.cooldownUntilMs) return {};
    return {
      dash: {
        active: moving,
        startedAt: dash.startedAtMs,
        until: dash.untilMs,
        cooldownUntil: dash.cooldownUntilMs,
        fromLat: dash.from.lat,
        fromLon: dash.from.lon,
        toLat: dash.to.lat,
        toLon: dash.to.lon
      }
    };
  }

  visitFlag(playerId: string, flagPosition: LatLon): PlayerRecord {
    return this.applyAuthoritativeRelocation({
      playerId,
      anchor: flagPosition,
      resourceVision: null
    });
  }

  relocateToAnchor(playerId: string, anchor: LatLon, arrival: LatLon = anchor): PlayerRecord {
    const player = this.players.get(playerId);
    if (!player) throw new Error("player is not connected");
    // System-derived return positions (manor exit) are clamped onto the world edge.
    const edgeArrival = clampToWorldEdge(arrival);
    player.position = { ...edgeArrival };
    player.regionCode = packageIdForPosition(edgeArrival);
    player.anchor = { ...clampToWorldEdge(anchor) };
    player.movementRevision += 1;
    this.bumpRelocationRevision(player);
    player.target = null;
    player.updatedAt = new Date();
    this.clearWaterTravel(player);
    this.resourceVisions.delete(playerId);
    this.bumpViewGeneration(playerId);
    this.markDirty(playerId);
    this.refreshActiveIndexes(playerId);
    this.notifyWorldArrival(playerId);
    return player;
  }

  currentWaterLeg(playerId: string): WaterLeg | null {
    const leg = this.waterLegs.get(playerId);
    const player = this.players.get(playerId);
    return leg && player?.target && leg.target === player.target ? leg : null;
  }

  /** Where PlayerSnapshot.classId comes from: the server-authoritative active class in the combat runtime. */
  setPlayerClassIdResolver(resolver: ((playerId: string) => SpecializationId | null) | null): void {
    this.playerClassIdResolver = resolver;
  }

  /** Water travel for automatic combat approaches (same rules as MOVE_TO, no raft launch). */
  setCombatApproachPlanner(
    planner: ((playerId: string, target: LatLon) => CombatApproachPlanResult) | null,
    onBlocked: ((playerId: string) => void) | null
  ): void {
    this.combatApproachPlanner = planner;
    this.combatApproachBlocked = onBlocked;
  }

  setCombatTarget(playerId: string, target: LatLon): PlayerRecord {
    const plan = this.isWorldPresent(playerId) ? this.combatApproachPlanner?.(playerId, target) : undefined;
    if (plan?.blocked) {
      // A land player never walks onto ocean or lake without a raft.
      this.stopPlayer(playerId);
      this.combatApproachBlocked?.(playerId);
      const player = this.players.get(playerId);
      if (!player) throw new Error("player is not connected");
      return player;
    }
    return this.setTarget(playerId, plan?.target ?? target, plan?.leg ?? undefined);
  }

  repositionCombatPlayer(playerId: string, target: LatLon, maximumDistanceM = 120): boolean {
    const player = this.players.get(playerId);
    if (
      !player || !player.online || this.nonWorldPlayerIds.has(playerId) ||
      !validLatLon(target) || !isWithinWorldEdge(target) ||
      distanceMeters(player.position, target) > maximumDistanceM ||
      distanceMeters(player.anchor, target) > player.moveLeashRadiusM
    ) return false;
    player.position = { ...target };
    player.regionCode = packageIdForPosition(target);
    player.target = null;
    player.movementRevision += 1;
    player.updatedAt = new Date();
    this.markDirty(playerId);
    this.refreshActiveIndexes(playerId);
    return true;
  }

  stopPlayer(playerId: string): void {
    const player = this.players.get(playerId);
    if (!player) {
      return;
    }
    this.clearTarget(player);
  }

  setMovementBlocked(
    playerId: string,
    blocked: boolean,
    reason = "default"
  ): void {
    if (blocked) {
      const reasons = this.movementBlockReasons.get(playerId) ?? new Set<string>();
      reasons.add(reason);
      this.movementBlockReasons.set(playerId, reasons);
      this.stopPlayer(playerId);
    } else {
      const reasons = this.movementBlockReasons.get(playerId);
      reasons?.delete(reason);
      if (reasons?.size === 0) this.movementBlockReasons.delete(playerId);
      this.refreshActiveIndexes(playerId);
    }
  }

  isMovementBlocked(playerId: string, reason?: string): boolean {
    const reasons = this.movementBlockReasons.get(playerId);
    return reason ? Boolean(reasons?.has(reason)) : Boolean(reasons?.size);
  }

  setWorldPresence(playerId: string, present: boolean): void {
    this.setPlayerLocationKind(playerId, present ? "world" : "interior");
  }

  setPlayerLocationKind(playerId: string, kind: "world" | "interior"): void {
    const present = kind === "world";
    const changed = present
      ? this.nonWorldPlayerIds.delete(playerId)
      : !this.nonWorldPlayerIds.has(playerId);
    if (!present) {
      this.nonWorldPlayerIds.add(playerId);
      this.stopPlayer(playerId);
    }
    if (changed) this.markDirty(playerId);
    this.refreshActiveIndexes(playerId);
  }

  isWorldPresent(playerId: string): boolean {
    return this.players.has(playerId) && !this.nonWorldPlayerIds.has(playerId);
  }

  respawnPlayerAtAnchor(playerId: string): LatLon {
    const player = this.players.get(playerId);
    if (!player) {
      throw new Error("player is not connected");
    }
    player.position = { ...player.anchor };
    player.regionCode = packageIdForPosition(player.position);
    player.movementRevision += 1;
    player.target = null;
    player.gathering = null;
    player.updatedAt = new Date();
    // Death loses the raft; a respawn onto water (a buoy) is afloat again for free.
    this.clearWaterTravel(player);
    const movementBlocks = this.movementBlockReasons.get(playerId);
    movementBlocks?.delete("default");
    if (movementBlocks?.size === 0) this.movementBlockReasons.delete(playerId);
    this.refreshActiveIndexes(playerId);
    this.markDirty(playerId);
    this.notifyWorldArrival(playerId);
    return { ...player.position };
  }

  setResourceVision(playerId: string, vision: ResourceVision): void {
    const player = this.players.get(playerId);
    if (!player) {
      throw new Error("player is not connected");
    }
    if (!samePosition(vision.center, player.anchor)) {
      throw new Error("resource vision center must equal the authoritative player anchor");
    }
    const attachedVision = resourceVisionAtAnchor(vision, player.anchor);
    this.resourceVisions.set(playerId, attachedVision);
    player.resourceVision = structuredClone(attachedVision);
    this.bumpResourceVisionRevision(playerId);
    this.bumpViewGeneration(playerId);
    this.markDirty(playerId);
    this.refreshActiveIndexes(playerId);
  }

  getResourceVision(playerId: string): ResourceVision | null {
    const vision = this.resourceVisions.get(playerId);
    return vision ? structuredClone(vision) : null;
  }

  getResourceVisionRevision(playerId: string): number {
    return this.resourceVisionRevisions.get(playerId) ?? 0;
  }

  clearResourceVision(playerId: string): void {
    if (this.resourceVisions.delete(playerId)) {
      const player = this.players.get(playerId);
      if (player) player.resourceVision = null;
      this.bumpResourceVisionRevision(playerId);
      this.bumpViewGeneration(playerId);
      this.markDirty(playerId);
      this.refreshActiveIndexes(playerId);
    }
  }

  clearResourceVisions(): void {
    for (const playerId of this.resourceVisions.keys()) {
      this.bumpResourceVisionRevision(playerId);
      this.bumpViewGeneration(playerId);
      this.markDirty(playerId);
    }
    this.resourceVisions.clear();
    for (const [playerId, player] of this.players) {
      player.resourceVision = null;
      this.refreshActiveIndexes(playerId);
    }
  }

  capturePlayerViewTransition(playerId: string): PlayerViewTransitionSnapshot {
    const player = this.players.get(playerId);
    if (!player) throw new Error("player is not connected");
    return {
      regionCode: player.regionCode,
      movementRevision: player.movementRevision,
      relocationRevision: player.relocationRevision ?? 0,
      position: { ...player.position },
      anchor: { ...player.anchor },
      target: player.target ? { ...player.target } : null,
      resourceVision: this.resourceVisions.has(playerId)
        ? structuredClone(this.resourceVisions.get(playerId)!)
        : null,
      resourceVisionRevision: this.getResourceVisionRevision(playerId),
      viewGeneration: this.viewGenerations.get(playerId) ?? 0,
      updatedAt: new Date(player.updatedAt),
      afloat: player.afloat === true
    };
  }

  applyValidatedFlagVisit(
    playerId: string,
    vision: ResourceVision,
    playerSpawnPosition: LatLon = vision.center
  ): PlayerRecord {
    return this.applyAuthoritativeRelocation({
      playerId,
      anchor: vision.center,
      playerSpawnPosition,
      resourceVision: vision
    });
  }

  applyAuthoritativeRelocation(input: AuthoritativeRelocationInput): PlayerRecord {
    const player = this.players.get(input.playerId);
    if (!player) throw new Error("player is not connected");
    player.gathering = null;
    if (!validLatLon(input.anchor)) {
      throw new Error("authoritative relocation anchor is outside WGS84 bounds");
    }
    const playerSpawnPosition = input.playerSpawnPosition ?? input.anchor;
    if (!validLatLon(playerSpawnPosition)) {
      throw new Error("authoritative relocation spawn position is outside WGS84 bounds");
    }
    if (input.resourceVision && !samePosition(input.resourceVision.center, input.anchor)) {
      throw new Error("resource vision center must equal the authoritative relocation anchor");
    }
    // World edge: flag/area views beyond the edge are refused (callers reject
    // explicit travel first); system-derived anchors and arrival scatter clamp.
    if (input.resourceVision && !isWithinWorldEdge(input.anchor)) {
      throw new Error(WORLD_EDGE_MESSAGE);
    }
    const anchor = { ...clampToWorldEdge(input.anchor) };
    const edgeSpawn = clampToWorldEdge(playerSpawnPosition);
    const spawn = { ...edgeSpawn };
    const regionCode = edgeSpawn === playerSpawnPosition
      ? input.authoritativeRegionCode ?? packageIdForPosition(spawn)
      : packageIdForPosition(spawn);
    const resourceVision = input.resourceVision
      ? resourceVisionAtAnchor(input.resourceVision, anchor)
      : null;

    player.position = spawn;
    player.regionCode = regionCode;
    player.anchor = anchor;
    player.movementRevision += 1;
    this.bumpRelocationRevision(player);
    player.target = null;
    player.updatedAt = new Date();
    // Any teleport or travel loses the raft; an arrival on water is afloat again for free.
    this.clearWaterTravel(player);
    if (resourceVision) this.resourceVisions.set(input.playerId, resourceVision);
    else this.resourceVisions.delete(input.playerId);
    player.resourceVision = resourceVision ? structuredClone(resourceVision) : null;
    this.bumpResourceVisionRevision(input.playerId);
    this.bumpViewGeneration(input.playerId);
    this.markDirty(input.playerId);
    this.refreshActiveIndexes(input.playerId);
    this.notifyWorldArrival(input.playerId);
    return player;
  }

  applyInPlaceFlagView(input: InPlaceFlagViewInput): PlayerRecord {
    const player = this.players.get(input.playerId);
    if (!player) throw new Error("player is not connected");
    if (!validLatLon(input.resourceVision.center)) {
      throw new Error("resource vision center is outside WGS84 bounds");
    }
    if (!samePosition(player.position, input.resourceVision.center)) {
      throw new Error("in-place flag authority must match the current player position");
    }
    const anchor = { ...input.resourceVision.center };
    const resourceVision = resourceVisionAtAnchor(input.resourceVision, anchor);
    player.anchor = anchor;
    player.regionCode =
      input.authoritativeRegionCode ?? packageIdForPosition(player.position);
    player.resourceVision = structuredClone(resourceVision);
    player.updatedAt = new Date();
    this.resourceVisions.set(input.playerId, resourceVision);
    this.bumpResourceVisionRevision(input.playerId);
    this.bumpViewGeneration(input.playerId);
    this.markDirty(input.playerId);
    this.refreshActiveIndexes(input.playerId);
    return player;
  }

  currentFlagId(playerId: string): string | null {
    return durableFlagIdForVision(this.resourceVisions.get(playerId));
  }

  playerIdsAtFlag(flagId: string): string[] {
    return [...(this.flagPlayerIds.get(flagId) ?? [])].sort();
  }

  playerIdsWithGameplayViewCircle(): string[] {
    return [...this.replicationPlayerIds].sort();
  }

  playerIdsWhoseGameplayViewCircleContains(position: LatLon): string[] {
    return [...this.replicationPlayerIds]
      .filter((playerId) => {
        const view = this.getGameplayViewCircle(playerId);
        return Boolean(view && distanceMeters(view.center, position) <= view.radiusM);
      })
      .sort();
  }

  sharesCompatibleFlagPresence(leftPlayerId: string, rightPlayerId: string): boolean {
    if (!this.isWorldPresent(leftPlayerId) || !this.isWorldPresent(rightPlayerId)) return false;
    const left = this.players.get(leftPlayerId);
    const right = this.players.get(rightPlayerId);
    const leftFlagId = this.currentFlagId(leftPlayerId);
    return Boolean(left?.online && right?.online && leftFlagId && leftFlagId === this.currentFlagId(rightPlayerId));
  }

  restorePlayerViewTransition(playerId: string, snapshot: PlayerViewTransitionSnapshot): void {
    const player = this.players.get(playerId);
    if (!player) return;
    player.position = { ...snapshot.position };
    player.regionCode = snapshot.regionCode;
    player.movementRevision = snapshot.movementRevision;
    player.relocationRevision = snapshot.relocationRevision;
    player.anchor = { ...snapshot.anchor };
    player.target = snapshot.target ? { ...snapshot.target } : null;
    player.updatedAt = new Date(snapshot.updatedAt);
    player.afloat = snapshot.afloat;
    this.waterLegs.delete(playerId);
    if (snapshot.resourceVision) {
      const resourceVision = resourceVisionAtAnchor(snapshot.resourceVision, snapshot.anchor);
      this.resourceVisions.set(playerId, resourceVision);
      player.resourceVision = structuredClone(resourceVision);
    }
    else {
      this.resourceVisions.delete(playerId);
      player.resourceVision = null;
    }
    this.resourceVisionRevisions.set(playerId, snapshot.resourceVisionRevision);
    this.viewGenerations.set(playerId, snapshot.viewGeneration);
    this.markDirty(playerId);
    this.refreshActiveIndexes(playerId);
  }

  getGameplayViewCircle(playerId: string): AuthoritativeGameplayViewCircle | null {
    const player = this.players.get(playerId);
    if (!player) return null;
    const vision = this.resourceVisions.get(playerId);
    const radiusM = vision?.radiusM ?? this.config.FLAG_RESOURCE_VISION_RADIUS_M;
    const eligibleZoneIds = zoneIdsIntersectingCircle(player.anchor, radiusM);
    const eligibleRegionCodes = eligibleZoneIds.map((zoneId) => zoneId.slice("world:".length));
    return vision
      ? {
          anchorType: vision.destinationKind === "area" ? "normal" : "flag",
          anchorId: vision.flagId,
          center: { ...player.anchor },
          radiusM,
          generation: this.viewGenerations.get(playerId) ?? 0,
          eligibleRegionCodes,
          eligibleZoneIds
        }
      : {
          anchorType: "normal",
          anchorId: player.playerId,
          center: { ...player.anchor },
          radiusM,
          generation: this.viewGenerations.get(playerId) ?? 0,
          eligibleRegionCodes,
          eligibleZoneIds
        };
  }

  getAuthoritativeTravelAnchor(playerId: string): AuthoritativeTravelAnchor | null {
    const player = this.players.get(playerId);
    if (!player || !player.online || !this.isWorldPresent(playerId)) return null;
    const vision = this.resourceVisions.get(playerId);
    const sourceType = vision?.destinationKind === "kingdom_seat"
      ? "kingdom_seat"
      : vision?.destinationKind === "area"
        ? "area"
        : vision
          ? "flag"
          : "player_anchor";
    const sourceId = vision?.flagId ?? player.playerId;
    const center = player.anchor;
    if (!validLatLon(center)) return null;
    return {
      scopeId: "world",
      layerId: `${sourceType}:${sourceId}`,
      center: { ...center },
      relocationRevision: player.relocationRevision ?? 0,
      layerGeneration: this.viewGenerations.get(playerId) ?? 0,
      sourceType,
      sourceId
    };
  }

  playerIdsInTravelLayer(anchor: Pick<AuthoritativeTravelAnchor, "scopeId" | "layerId">): string[] {
    return [...this.onlinePlayerIds]
      .filter((playerId) => {
        const current = this.getAuthoritativeTravelAnchor(playerId);
        return current?.scopeId === anchor.scopeId && current.layerId === anchor.layerId;
      })
      .sort();
  }

  private bumpViewGeneration(playerId: string): void {
    this.viewGenerations.set(playerId, (this.viewGenerations.get(playerId) ?? 0) + 1);
  }

  teleportPlayer(playerId: string, destination: LatLon, authoritativeRegionCode?: string): PlayerRecord {
    return this.applyAuthoritativeRelocation({
      playerId,
      anchor: destination,
      ...(authoritativeRegionCode === undefined ? {} : { authoritativeRegionCode }),
      resourceVision: null
    });
  }

  restoreWorldPosition(playerId: string, destination: LatLon, regionCode: string): PlayerRecord {
    const player = this.players.get(playerId);
    if (!player) throw new Error("player is not connected");
    return this.applyAuthoritativeRelocation({
      playerId,
      anchor: player.anchor,
      playerSpawnPosition: destination,
      authoritativeRegionCode: regionCode,
      resourceVision: this.resourceVisions.get(playerId) ?? null
    });
  }

  markOffline(playerId: string): void {
    const player = this.players.get(playerId);
    if (!player) {
      return;
    }
    player.online = false;
    if (player.target) {
      player.movementRevision += 1;
      player.target = null;
    }
    player.updatedAt = new Date();
    this.markDirty(player.playerId);
    this.refreshActiveIndexes(playerId);
  }

  markOnlinePreservingView(playerId: string): PlayerRecord | null {
    const player = this.players.get(playerId);
    if (!player) return null;
    if (!this.worldAuthorityEpochs.has(playerId)) {
      this.worldAuthorityEpochs.set(playerId, randomUUID());
    }
    player.online = true;
    this.playerGenerations.set(playerId, ++this.nextPlayerGeneration);
    player.updatedAt = new Date();
    this.markDirty(player.playerId);
    this.refreshActiveIndexes(playerId);
    return player;
  }

  worldAuthorityEpoch(playerId: string): string {
    const epoch = this.worldAuthorityEpochs.get(playerId);
    if (!epoch) throw new Error("player world authority is not connected");
    return epoch;
  }

  setPlayerColor(playerId: string, color: string): PlayerRecord | null {
    const player = this.players.get(playerId);
    if (!player) {
      return null;
    }
    player.displayColor = color;
    player.updatedAt = new Date();
    this.markDirty(player.playerId);
    return player;
  }

  setPlayerHunger(playerId: string, current: number, baseCapacity?: number): PlayerRecord | null {
    const player = this.players.get(playerId);
    if (!player) return null;
    player.hunger = hungerSnapshot(current, baseCapacity ?? player.hunger?.baseCapacity);
    player.updatedAt = new Date();
    this.markDirty(playerId);
    return player;
  }

  setPlayerAppearance(
    playerId: string,
    appearance: PlayerAppearanceSnapshot
  ): PlayerAppearanceSnapshot | null {
    const player = this.players.get(playerId);
    if (!player) return null;
    const currentRevision = player.appearance?.revision ?? -1;
    const installed = {
      ...structuredClone(appearance),
      revision: Math.max(appearance.revision, currentRevision + 1)
    };
    player.appearance = installed;
    return structuredClone(installed);
  }

  setPlayerSalonStyles(
    playerId: string,
    styles: PlayerSalonStyles,
    revision: number
  ): PlayerRecord | null {
    const player = this.players.get(playerId);
    if (!player) return null;
    player.salonStyles = structuredClone(styles);
    player.salonAppearanceRevision = revision;
    return player;
  }

  setPlayerBodyVariant(
    playerId: string,
    bodyVariantId: PlayerBodyVariantId
  ): PlayerAppearanceSnapshot | null {
    const player = this.players.get(playerId);
    if (!player) return null;
    player.bodyVariantId = bodyVariantId;
    if (!player.appearance) return null;
    const installed = {
      ...player.appearance,
      bodyVariantId,
      revision: player.appearance.revision + 1
    };
    player.appearance = installed;
    return structuredClone(installed);
  }

  tick(deltaSeconds: number, movementMultiplier: (playerId: string) => number = () => 1): void {
    for (const playerId of this.dashLandingLog) {
      const landed = this.players.get(playerId);
      const dash = this.dashes.get(playerId);
      if (landed && dash) {
        this.logger?.debug?.({
          event: "dash_tick", playerId, requestId: dash.requestId, phase: "after-landing",
          fromStartM: round2(distanceMeters(dash.from, landed.position)),
          toEndM: round2(distanceMeters(landed.position, dash.to)),
          moving: landed.target !== null, lat: landed.position.lat, lon: landed.position.lon
        }, "dash tick");
      }
    }
    this.dashLandingLog.clear();
    for (const playerId of [...this.movingPlayerIds]) {
      const player = this.players.get(playerId);
      if (!player || !player.online || this.nonWorldPlayerIds.has(playerId) ||
          this.isMovementBlocked(playerId) || !player.target) {
        this.movingPlayerIds.delete(playerId);
        continue;
      }
      if (this.movingDash(player)) {
        this.stepDash(player, deltaSeconds);
        continue;
      }
      const multiplier = movementMultiplier(playerId);
      if (multiplier < 0) continue;
      this.noteMovementMultiplier(playerId, multiplier);
      if (this.constrainPlayerToMovementLeash(player, "tick start")) {
        continue;
      }
      if (!player.target) {
        continue;
      }
      const waterLeg = this.currentWaterLeg(playerId);
      const waterMultiplier = waterLeg
        ? waterLegSegmentAt(waterLeg, distanceMeters(waterLeg.origin, player.position))?.multiplier ?? 1
        : 1;
      const maxStepMeters = this.config.PLAYER_SPEED_MPS *
        Math.max(0.2, Math.min(2, multiplier * waterMultiplier)) * deltaSeconds;
      const remaining = distanceMeters(player.position, player.target);
      // A great-circle step between two edge points bulges a few centimetres poleward.
      const next = clampToWorldEdge(moveToward(player.position, player.target, maxStepMeters));
      const shoreStop = this.shoreGuardStop(player, player.position, next);
      player.position = shoreStop ?? next;
      player.regionCode = packageIdForPosition(player.position);
      if (waterLeg) this.applyWaterLegSurface(player, waterLeg);
      if (shoreStop || remaining <= maxStepMeters) {
        player.movementRevision += 1;
        player.target = null;
        this.waterLegs.delete(playerId);
      }
      this.constrainPlayerToMovementLeash(player, "tick");
      player.updatedAt = new Date();
      this.markDirty(player.playerId);
      this.refreshActiveIndexes(player.playerId);
    }
  }

  /**
   * Shore guard (the planner's safety net): an unrafted player's step never enters a grid cell the water cache
   * knows as open water. Returns where the step must end instead (SHORE_STOP_M before that cell's edge, never
   * behind the step start), or null when the step is fine. The cell the step starts in is never refused, so a
   * stranded player can step out of it. Unknown or cold cells pass (fail-open for movement; the lookup fetches
   * them in the background). Never grants afloat: only launchRaft, water sites and arrivals do.
   */
  private shoreGuardStop(player: PlayerRecord, from: LatLon, to: LatLon): LatLon | null {
    const surfaceAt = this.waterSurfaceAt;
    if (!surfaceAt || player.afloat === true || this.nonWorldPlayerIds.has(player.playerId)) return null;
    if (from.lat === to.lat && from.lon === to.lon) return null;
    const { cells } = pathCells(from, to);
    const startKey = cells[0]!.key;
    const leg = this.currentWaterLeg(player.playerId);
    const wadeM = leg?.wadeM ?? 0;
    const legOffsetM = wadeM > 0 && leg ? distanceMeters(leg.origin, from) : 0;
    for (let index = 1; index < cells.length; index += 1) {
      const cell = cells[index]!;
      if (cell.key === startKey || legOffsetM + cell.entryM < wadeM) continue;
      if (surfaceAt(cell.point) !== "open_water") continue;
      const stopM = cell.entryM - SHORE_STOP_M;
      return stopM > 0 ? moveToward(from, to, stopM) : { ...from };
    }
    // Belt and braces against float rounding exactly on a cell edge: the end point's own cell.
    const endCell = snapToSampleGrid(to);
    if (
      cellKey(endCell) !== startKey && legOffsetM + distanceMeters(from, to) >= wadeM &&
      surfaceAt(endCell) === "open_water"
    ) return { ...from };
    return null;
  }

  /**
   * Being on open water marks a raft as used; reaching land after that loses it. This never sets afloat:
   * a leg only floats a player who already paid (launchRaft) or was granted it (water site, arrival on water).
   */
  private applyWaterLegSurface(player: PlayerRecord, leg: WaterLeg): void {
    if (player.afloat !== true) return;
    const surface = waterLegSegmentAt(leg, distanceMeters(leg.origin, player.position))?.surface;
    if (surface === "open_water") {
      this.wetPlayerIds.add(player.playerId);
    } else if (surface === "land" && this.wetPlayerIds.has(player.playerId)) {
      this.wetPlayerIds.delete(player.playerId);
      player.afloat = false;
    }
  }

  snapshots(options: { onlineOnly?: boolean; regionCode?: string } = {}): PlayerSnapshot[] {
    const playerIds = options.onlineOnly === false
      ? this.players.keys()
      : this.replicationPlayerIds.values();
    return [...playerIds]
      .map((playerId) => this.players.get(playerId))
      .filter((player): player is PlayerRecord => Boolean(player))
      .filter((player) => !this.nonWorldPlayerIds.has(player.playerId))
      .filter((player) => !options.regionCode || player.regionCode === options.regionCode)
      .map((player) => this.snapshot(player));
  }

  snapshotForPlayer(playerId: string): PlayerSnapshot {
    const player = this.players.get(playerId);
    if (!player) {
      throw new Error("player is not connected");
    }
    return this.snapshot(player);
  }

  capturePlayerPersistence(playerId: string): PlayerPersistenceCapture {
    const snapshot = this.snapshotForPlayer(playerId);
    return {
      playerId,
      generation: this.playerGenerations.get(playerId) ?? 0,
      version: this.playerVersions.get(playerId) ?? 0,
      snapshot
    };
  }

  acknowledgePlayerPersistence(capture: PlayerPersistenceCapture): boolean {
    const player = this.players.get(capture.playerId);
    if (!player || this.playerGenerations.get(capture.playerId) !== capture.generation ||
        this.playerVersions.get(capture.playerId) !== capture.version) {
      return false;
    }
    this.dirtyPlayerIds.delete(capture.playerId);
    this.dirtyPlayerSince.delete(capture.playerId);
    if (player.online) return false;
    this.evictPlayer(capture.playerId);
    return true;
  }

  activeRuntimeMetrics(): ActiveRuntimeMetrics {
    let flagMemberships = 0;
    for (const members of this.flagPlayerIds.values()) flagMemberships += members.size;
    return {
      loadedPlayers: this.players.size,
      onlinePlayers: this.onlinePlayerIds.size,
      movingPlayers: this.movingPlayerIds.size,
      resourceVisionPlayers: this.resourceVisionPlayerIds.size,
      flagMemberships,
      replicationPlayers: this.replicationPlayerIds.size
    };
  }

  dirtyPlayerMetrics(now = Date.now()): { count: number; oldestAgeMs: number } {
    let oldestSince = now;
    for (const playerId of this.dirtyPlayerIds) {
      oldestSince = Math.min(oldestSince, this.dirtyPlayerSince.get(playerId) ?? now);
    }
    return {
      count: this.dirtyPlayerIds.size,
      oldestAgeMs: this.dirtyPlayerIds.size === 0 ? 0 : Math.max(0, now - oldestSince)
    };
  }

  consumeDirtyPlayerIds(): string[] {
    const ids = [...this.dirtyPlayerIds];
    this.dirtyPlayerIds.clear();
    return ids;
  }

  restoreDirtyPlayerIds(playerIds: Iterable<string>): void {
    for (const playerId of playerIds) {
      if (this.players.has(playerId)) {
        this.dirtyPlayerIds.add(playerId);
        if (!this.dirtyPlayerSince.has(playerId)) this.dirtyPlayerSince.set(playerId, Date.now());
      }
    }
  }

  playerIds(): string[] {
    return [...this.players.keys()];
  }

  private snapshot(player: PlayerRecord): PlayerSnapshot {
    this.constrainPlayerToMovementLeash(player, "snapshot");
    const resourceVision = this.resourceVisions.get(player.playerId);
    return {
      playerId: player.playerId,
      username: player.username,
      displayColor: player.displayColor,
      ...(player.personalFlagColor
        ? { personalFlagColor: player.personalFlagColor }
        : {}),
      regionCode: player.regionCode,
      zoneId: zoneIdForRegion(player.regionCode),
      lat: player.position.lat,
      lon: player.position.lon,
      anchorLat: player.anchor.lat,
      anchorLon: player.anchor.lon,
      moveLeashRadiusM: player.moveLeashRadiusM,
      movementRevision: player.movementRevision,
      relocationRevision: player.relocationRevision ?? 0,
      targetLat: player.target?.lat ?? null,
      targetLon: player.target?.lon ?? null,
      moving: player.target !== null,
      currentFlagId: durableFlagIdForVision(resourceVision),
      ...(resourceVision?.destinationKind === "kingdom_seat"
        ? { currentKingdomSeatId: resourceVision.flagId }
        : {}),
      online: player.online,
      updatedAt: player.updatedAt.toISOString(),
      ...(player.appearance
        ? { appearance: structuredClone(player.appearance) }
        : {}),
      hunger: hungerSnapshot(player.hunger?.current, player.hunger?.baseCapacity),
      ...(player.afloat ? { afloat: true } : {}),
      ...(player.gathering ? { gathering: { ...player.gathering } } : {}),
      ...this.dashSnapshotFields(player),
      ...this.classIdSnapshotField(player.playerId)
    };
  }

  private constrainPlayerToMovementLeash(player: PlayerRecord, reason: string): boolean {
    const leashRadiusM = player.moveLeashRadiusM;
    const distanceFromAnchor = distanceMeters(player.anchor, player.position);
    if (distanceFromAnchor <= leashRadiusM + LEASH_EPSILON_M) {
      return false;
    }

    const previousPosition = player.position;
    player.position = moveToward(player.anchor, player.position, leashRadiusM);
    player.regionCode = packageIdForPosition(player.position);
    player.movementRevision += 1;
    player.target = null;
    player.updatedAt = new Date();
    this.markDirty(player.playerId);
    this.refreshActiveIndexes(player.playerId);
    this.logger?.warn(
      {
        playerId: player.playerId,
        reason,
        distanceFromAnchor,
        movementLeashRadiusM: leashRadiusM,
        previousPosition,
        correctedPosition: player.position
      },
      "player position corrected to movement leash"
    );
    return true;
  }

  private refreshActiveIndexes(playerId: string): void {
    this.removeFromActiveIndexes(playerId);
    const player = this.players.get(playerId);
    if (!player?.online) return;
    this.onlinePlayerIds.add(playerId);
    if (!this.nonWorldPlayerIds.has(playerId)) {
      this.replicationPlayerIds.add(playerId);
      if (player.target && !this.isMovementBlocked(playerId)) {
        this.movingPlayerIds.add(playerId);
      }
      const vision = this.resourceVisions.get(playerId);
      if (vision) {
        this.resourceVisionPlayerIds.add(playerId);
        const flagId = durableFlagIdForVision(vision);
        if (flagId) {
          const members = this.flagPlayerIds.get(flagId) ?? new Set<string>();
          members.add(playerId);
          this.flagPlayerIds.set(flagId, members);
          this.indexedFlagIdsByPlayer.set(playerId, flagId);
        }
      }
    }
  }

  private removeFromActiveIndexes(playerId: string): void {
    this.onlinePlayerIds.delete(playerId);
    this.movingPlayerIds.delete(playerId);
    this.resourceVisionPlayerIds.delete(playerId);
    this.replicationPlayerIds.delete(playerId);
    const flagId = this.indexedFlagIdsByPlayer.get(playerId);
    if (flagId) {
      const members = this.flagPlayerIds.get(flagId);
      if (members) {
        members.delete(playerId);
        if (members.size === 0) this.flagPlayerIds.delete(flagId);
      }
      this.indexedFlagIdsByPlayer.delete(playerId);
    }
  }

  private evictPlayer(playerId: string): void {
    this.removeFromActiveIndexes(playerId);
    this.players.delete(playerId);
    this.movementMultipliers.delete(playerId);
    this.dashes.delete(playerId);
    this.dirtyPlayerIds.delete(playerId);
    this.dirtyPlayerSince.delete(playerId);
    this.resourceVisions.delete(playerId);
    this.resourceVisionRevisions.delete(playerId);
    this.viewGenerations.delete(playerId);
    this.waterLegs.delete(playerId);
    this.wetPlayerIds.delete(playerId);
    this.movementBlockReasons.delete(playerId);
    this.nonWorldPlayerIds.delete(playerId);
    this.playerGenerations.delete(playerId);
    this.playerVersions.delete(playerId);
    this.worldAuthorityEpochs.delete(playerId);
    this.indexedFlagIdsByPlayer.delete(playerId);
  }

  private clearTarget(player: PlayerRecord): void {
    const dash = this.dashes.get(player.playerId);
    if (dash) {
      dash.active = false;
      dash.queued = null;
    }
    if (!player.target) {
      return;
    }
    player.target = null;
    player.movementRevision += 1;
    player.updatedAt = new Date();
    this.markDirty(player.playerId);
    this.refreshActiveIndexes(player.playerId);
  }

  private bumpRelocationRevision(player: PlayerRecord): void {
    player.relocationRevision = (player.relocationRevision ?? 0) + 1;
  }

  private bumpResourceVisionRevision(playerId: string): void {
    this.resourceVisionRevisions.set(playerId, this.getResourceVisionRevision(playerId) + 1);
  }

  private markDirty(playerId: string): void {
    this.dirtyPlayerIds.add(playerId);
    if (!this.dirtyPlayerSince.has(playerId)) this.dirtyPlayerSince.set(playerId, Date.now());
    this.playerVersions.set(playerId, ++this.nextPlayerVersion);
  }
}

export function zoneIdForRegion(regionCode: string): string {
  return `world:${regionCode}`;
}

export function waterLegSegmentAt(
  leg: WaterLeg,
  distanceM: number
): WaterLeg["segments"][number] | null {
  let current: WaterLeg["segments"][number] | null = null;
  for (const segment of leg.segments) {
    if (segment.startM > distanceM) break;
    current = segment;
  }
  return current;
}

function durableFlagIdForVision(vision: ResourceVision | undefined): string | null {
  return vision?.destinationKind === "area" ? null : vision?.flagId ?? null;
}

function validLatLon(position: LatLon): boolean {
  return Number.isFinite(position.lat) && Number.isFinite(position.lon) &&
    Math.abs(position.lat) <= 90 && Math.abs(position.lon) <= 180;
}

function samePosition(left: LatLon, right: LatLon): boolean {
  return left.lat === right.lat && left.lon === right.lon;
}

function resourceVisionAtAnchor(vision: ResourceVision, anchor: LatLon): ResourceVision {
  return {
    ...structuredClone(vision),
    center: { ...anchor }
  };
}

export { zoneIdForPosition };

export function displayColorForPlayer(playerId: string): string {
  let hash = 0;
  for (const char of playerId) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  }
  const palette = ["#38bdf8", "#a78bfa", "#34d399", "#fbbf24", "#fb7185", "#f472b6"];
  return palette[hash % palette.length] ?? "#38bdf8";
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
