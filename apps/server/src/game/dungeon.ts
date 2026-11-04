import {
  advanceIndoorVector,
  CISTERN_WARRENS_DUNGEON,
  DUNGEON_CATALOG,
  CISTERN_WARRENS_DESCRIPTION,
  CISTERN_WARRENS_MAX_TARGET_DISTANCE,
  CISTERN_WARRENS_NAME,
  CISTERN_WARRENS_PLAYER_VISUAL_HEIGHT_UNITS,
  CISTERN_WARRENS_SPATIAL_PROFILE,
  DASH_COOLDOWN_MS,
  DASH_DISTANCE_M,
  DASH_DURATION_MS,
  DASH_IFRAME_MS,
  DEFAULT_PLAYER_SPEED_MPS,
  cisternWarrensRoomDefinition,
  dungeonAnchorDefinition,
  cisternWarrensIndoorPointToStored,
  cisternWarrensRoomNavigation,
  combatPositionToDungeonLocal,
  dungeonLocalDistanceToCombatMeters,
  dungeonLocalToCombatPosition,
  dungeonSceneRevision,
  DUNGEON_ELITE_TUNING,
  dungeonEliteShieldActive,
  type DungeonEliteModifierId,
  dungeonFormationOffset,
  dungeonRewardRollSeed,
  dungeonObjectSpawnsInRun,
  randomDungeonPointInShape,
  resolveDungeonChestRarity,
  findIndoorNavigationRoute,
  isIndoorNavigationPointWalkable,
  isIndoorNavigationSegmentWalkable,
  isCisternWarrensSpaceId,
  materializeDungeonRun,
  distanceMeters,
  portalIds,
  type DungeonEntranceSnapshot,
  type DungeonCatalog,
  type DungeonDefinition,
  type DungeonEncounterDefinition,
  type DungeonObjectSnapshot,
  type DungeonRoomDefinition,
  type DungeonPlayerSnapshot,
  type DungeonSnapshot,
  type DungeonSnapshotUpdate,
  type IndoorPoint,
  type IndoorRoomNavigation,
  type LatLon,
  type PlayerAppearanceSnapshot
} from "@ash-atlas/shared";
import { COLLECTIBLE_PICKUP_RADIUS_M, atlasPassDungeonEntryCost, describeDungeonEntryCost, DUNGEON_TORCH_MEMBER_MIN, DUNGEON_TORCH_TOTAL_MAX, DUNGEON_TORCH_TOTAL_MIN, effectiveDungeonMinimumLevel, type DungeonNotice, type DungeonResourceType, type DungeonTurnInId } from "@ash-atlas/shared";
import { FALLEN_PRISON_HUNT, MAX_EQUIPMENT_LEVEL, drownedCityEntranceIdForSite, drownedCitySiteIdForEntrance, type PlayerLocationSnapshot } from "@ash-atlas/shared";
import {
  HEART_PUZZLES, HEART_PUZZLE_START_SLACK, heartPuzzleBoardColliders, heartPuzzleForRoom, heartPuzzleForSeal, verifyHeartPuzzleSolve
} from "@ash-atlas/shared";
import { dungeonResourceRule } from "./dungeonResourceRules.js";
import {
  GOLEM_FORGE_BOSS_ENCOUNTER_IDS,
  GOLEM_FORGE_FINAL_BOSS_ENCOUNTER_ID,
  GOLEM_FORGE_HUB_ROOM_ID,
  golemForgeEntryCost,
  golemForgeGroupGoldMultiplier,
  isGolemForge
} from "./golemForge.js";
import {
  GOLEM_FORGE_COLLAPSED_DISPLAY_MS,
  golemForgeEntranceSnapshot,
  parseGolemForgeEntranceId,
  type GolemForgeSite,
  type GolemForgeSiteService
} from "./golemForgeSites.js";
import { drownedCityEntranceAt, drownedCityEntranceSnapshot } from "./drownedCityEntrances.js";
import {
  parseWorldDungeonEntranceId,
  worldDungeonEntranceSnapshot,
  type WorldDungeonEntranceService
} from "./worldDungeonEntrances.js";
import { createHash, randomUUID } from "node:crypto";
import { boundedPortalRevision } from "./locations/portalRevision.js";
import type pg from "pg";

import type { CombatEngine } from "./combat/combatEngine.js";
import { requireMobDefinition, resolveMobCombatProfile } from "./combat/mobDefinitions.js";
import { LAVA_VENT, lavaVentDue } from "./combat/wyrmHollowBehaviors.js";
import { DungeonBossHostAdapter, type BossEncounter, type BossEncounterManager, type BossRoomHooks } from "./bossFramework.js";
import {
  DEFAULT_DUNGEON_LOCKOUT_DAYS,
  DungeonRepeatError,
  DungeonRepeatLedger,
  type DungeonCompletion
} from "./dungeonRepeatLedger.js";
import type { PlayerRecord } from "./state.js";
import type { PlayerLocationService } from "./locations/playerLocationService.js";
import type { DeveloperSpawnedDungeonService } from "./developerSpawnedDungeons.js";
import { packageIdForPosition } from "./spatialZones.js";

type SewerSession = {
  playerId: string;
  sessionId: string;
  sewerId: string;
  instanceId: string;
  runId: string;
  dungeon: DungeonDefinition;
  legacySewer: boolean;
  entrancePortalId: string;
  entrancePresentation: DungeonEntranceSnapshot["presentation"];
  entranceAssetKey: string | null;
  spaceId: string;
  cityId?: string;
  cityName?: string;
  name: string;
  displayColor: string | null;
  appearance: PlayerAppearanceSnapshot | undefined;
  x: number;
  y: number;
  targetX: number | null;
  targetY: number | null;
  movementRevision: number;
  lastPersistAt: number;
  returnRegionCode: string;
  returnLat: number;
  returnLon: number;
  connected: boolean;
  /** Torches the session's run burned (dungeon_run_stats.torch_total) when it entered or restored. */
  torchTotal: number | null;
  /**
   * The Ash Heart puzzle this player started by talking to the room's NPC: they are locked in place until the
   * solve or a quit. Held in the live session only; a disconnect, room change or death clears it (the board is
   * client-simulated and resets on reload, so a reconnect comes back reset and unlocked).
   */
  heartPuzzle?: Readonly<{ roomId: string; startedAt: number }> | null;
};

type ObjectState = DungeonRoomDefinition["objects"][number]["initialState"];
type DungeonSnapshotCommon = Omit<
  DungeonSnapshot,
  "snapshotKind" | "room" | "prefabs"
>;
type EncounterState = "idle" | "active" | "completed" | "failed" | "resetting";
type RuntimeEvent = Readonly<{ type: string; playerId?: string; roomId?: string;
  zoneId?: string; objectId?: string; portalId?: string; encounterId?: string;
  state?: string; flagId?: string; value?: boolean; requestId?: string }>;
type TriggerRuntimeState = { enabled: boolean; firedCount: number;
  cooldowns: Map<string, number>; sequenceIndexes: Map<string, number>; timerDueAt: number | null;
  firedScopes: Set<string>;
  /**
   * Players in the run when this trigger's "present" run rewards fired (connected or not): the only ones a
   * restore may still pay (grantMissedRunRewards). Persisted with the trigger state.
   */
  rewardEligible: Set<string> };
type EncounterRuntimeState = { state: EncounterState; currentWaveId: string | null;
  attempts: number; spawnedMobIds: Map<string, string>; nextWaveAt: number | null;
  pendingWaveId: string | null; startedAt?: number;
  /** When it last completed (persisted): the Golem Forge trash refill counts from here. */
  completedAt?: number };
type EliteRuntimeState = {
  entityId: string; encounterId: string; spawnId: string;
  modifiers: ReadonlySet<DungeonEliteModifierId>;
  spawnedAt: number; nextHealAt: number; lastPosition: LatLon; splitDone: boolean;
};
/** Synthetic spawn ids for split copies: `<parent spawn id>~split<n>`. */
const SPLIT_SPAWN_MARKER = "~split";
/** Synthetic spawn ids for a shared run's party torch set copies: `<placement id>~party:<party entry id>`. */
const PARTY_SET_SPAWN_MARKER = "~party:";
function splitParentSpawnId(spawnId: string): string | null {
  const index = spawnId.indexOf(SPLIT_SPAWN_MARKER);
  return index < 0 ? null : spawnId.slice(0, index);
}
type ResourceRuntimeState = {
  id: string;
  roomId: string;
  resourceType: DungeonResourceType;
  x: number;
  y: number;
  quantity: number;
  minYield: number;
  maxYield: number;
  state: "available" | "depleted";
  availableAt: number | null;
  respawnSeconds: number | null;
  resetOnRun: boolean;
  interactionRadius: number;
  source: "authored" | "spawn_zone";
  prefabId?: string;
  prefabRevision?: string;
  lifeRevision: number;
};
type DungeonInstanceState = {
  /** The run's materialized dungeon (the authored one when nothing rolls). */
  dungeon: DungeonDefinition;
  runId: string;
  legacySewer: boolean;
  /** Torches burned for this run: rolled torch sets up to this number spawn. See torchTotalForRun. */
  torchTotal: number;
  /** When the run's first entrant came in (dungeon_run_stats.started_at); null until known. */
  runStartedAt: number | null;
  /** Deaths inside this run, per player (dungeon_run_stats.deaths_by_player). */
  deathsByPlayer: Map<string, number>;
  objectStates: Map<string, ObjectState>;
  objectAvailability: Map<string, boolean>;
  portalLocks: Map<string, boolean>;
  triggers: Map<string, TriggerRuntimeState>;
  flags: Map<string, boolean>;
  encounters: Map<string, EncounterRuntimeState>;
  /** Rolled elites by combat entity id (stat-only elites carry no runtime behaviour but are listed for the snapshot). */
  elites: Map<string, EliteRuntimeState>;
  resources: Map<string, ResourceRuntimeState>;
  zoneMembership: Map<string, Set<string>>;
  allPlayersPresent: Set<string>;
  processedInteractions: Map<string, Readonly<{
    sessionId: string; objectId: string; snapshot: DungeonSnapshot
  }>>;
  processedResourceHarvests: Map<string, Readonly<{
    sessionId: string; resourceId: string; resourceType: DungeonResourceType;
    quantity: number; snapshot: DungeonSnapshot
  }>>;
  eventQueue: RuntimeEvent[];
  processingEvents: boolean;
  pendingRewardScopes: Set<string>;
  completed: boolean;
  cues: string[];
  /** Ephemeral HUD notices; never persisted. `audience` null means everyone in the instance. */
  notices: Array<DungeonNotice & { audience: ReadonlySet<string> | null }>;
  noticeSeq: number;
  noticeBatch: NoticeBatch | null;
  noticeAudience: ReadonlySet<string> | null;
  lastStatePersistAt: number;
  resetDeadline: number | null;
  /**
   * Shared Golem Forge run: each party entry (one torch lobby start) with its torches and the rooms its
   * extra torch sets already spawned in, and the party entry each player came in with. Persisted.
   */
  partyEntries: Map<string, { torches: number; rooms: Set<string> }>;
  playerPartyEntries: Map<string, string>;
  /** Golem Forge boss encounters: players inside when the fight started (its chest and credit). Persisted. */
  bossCredits: Map<string, Set<string>>;
};

type NoticeBatch = {
  authored: Array<{ text: string; tone: DungeonNotice["tone"]; audience: ReadonlySet<string> | null }>;
  auto: AutoNotice[];
};
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type AutoNotice = { audience: ReadonlySet<string> | null } & (
  | { kind: "object"; text: string }
  | { kind: "portal"; portalId: string }
  | { kind: "defeat"; name: string; boss: boolean }
  | { kind: "complete" }
);
/**
 * A combat snapshot's mob cast as the dungeon snapshot carries it. Combat casts add durationMs/remainingMs for the
 * client clock; the dungeon telegraph contract is strict and has neither, so a copied cast made the client reject
 * every DUNGEON_SNAPSHOT during a fight (three rejects drop and reopen the socket, over and over).
 */
function dungeonTelegraph(cast: DungeonSnapshot["telegraphs"][number] & { durationMs?: number; remainingMs?: number }): DungeonSnapshot["telegraphs"][number] {
  const { durationMs: _durationMs, remainingMs: _remainingMs, ...rest } = cast;
  return rest;
}
const MAX_DUNGEON_NOTICES = 8;
/** Dungeons whose deaths respawn at the start of the current room (puzzle progress lives in run flags). */
const ROOM_RESPAWN_DUNGEON_IDS: ReadonlySet<string> = new Set(["tilted_vault"]);
/**
 * Dungeons whose encounter mobs spawn at the level of the highest-level living player in the room instead of their
 * authored level (owner, 2026-10-21: Vault mobs match the player for now; levels get redesigned later). Elites keep
 * their modifiers at that level; bosses keep theirs.
 */
const PARTY_LEVEL_DUNGEON_IDS: ReadonlySet<string> = new Set(["tilted_vault"]);

export type NoticeContext = { dungeon: DungeonDefinition; occupiedRoomIds: ReadonlySet<string> };

/**
 * One short line per fact. Doors are announced once (no reciprocal back-direction duplicate) and only when
 * they leave a room the audience is standing in; a non-boss defeat absorbs the first door it opened.
 * Dungeon completion is its own line and supersedes door chatter.
 */
export function summarizeAutoNotices(context: NoticeContext, notices: readonly AutoNotice[]): string[] {
  const announced = new Set<string>();
  const roomDoors: string[] = [];
  const otherDoors: string[] = [];
  for (const notice of notices) {
    if (notice.kind !== "portal") continue;
    const portal = context.dungeon.portals.find((candidate) => candidate.id === notice.portalId);
    if (!portal || portal.source.kind !== "room" || !context.occupiedRoomIds.has(portal.source.roomId)) continue;
    if (portal.destination.kind !== "room") {
      if (!announced.has(portal.id)) { announced.add(portal.id); otherDoors.push(`${portal.interactionLabel} opened.`); }
      continue;
    }
    const destinationId = portal.destination.roomId;
    const pair = [portal.source.roomId, destinationId].sort().join("|");
    if (announced.has(pair)) continue;
    announced.add(pair);
    roomDoors.push(context.dungeon.rooms.find((room) => room.id === destinationId)?.name ?? destinationId);
  }
  const complete = notices.some((notice) => notice.kind === "complete");
  const lines: string[] = [];
  let absorbed = false;
  for (const notice of notices) {
    if (notice.kind === "defeat") {
      const name = notice.name.replace(/\s*[-\u2013\u2014]\s*boss$/iu, "").trim();
      if (notice.boss) lines.push(`Boss defeated: ${name}`);
      else if (roomDoors.length > 0 && !complete && !absorbed) {
        absorbed = true;
        lines.push(`${name} defeated \u2014 ${roomDoors[0]} is open.`);
      } else lines.push(`${name} defeated.`);
    } else if (notice.kind === "object") lines.push(notice.text);
  }
  if (!complete) {
    for (const [index, door] of roomDoors.entries()) {
      if (index === 0 && absorbed) continue;
      lines.push(`The way to ${door} is open.`);
    }
    lines.push(...otherDoors);
  }
  if (complete) lines.push("Dungeon complete.");
  return [...new Set(lines)];
}

const MAX_DUNGEON_INTERACTION_REPLAYS = 256;
const MAX_DUNGEON_EVENT_DRAIN = 256;
const MAX_DUNGEON_DIAGNOSTIC_CUES = 32;

export type DungeonResourceHarvestResult = Readonly<{
  resourceId: string;
  resourceType: DungeonResourceType;
  quantity: number;
  snapshot: DungeonSnapshot;
}>;

/** A validated dungeon resource node a player can start or finish gathering. */
export type DungeonResourceHarvestTarget = Readonly<{
  instanceId: string;
  runId: string;
  dungeonId: string;
  resourceId: string;
  resourceType: DungeonResourceType;
  spaceId: string;
  lifeRevision: number;
  /** Dungeon combat position (lat/lon after the y-flip), equal to the map position. */
  position: LatLon;
  distanceM: number;
}>;

export type DungeonRuntimeAuthorities = Readonly<{
  playerMovementSpeedMps?: number;
  ownsItem?: (playerId: string, itemId: string, quantity: number) => boolean;
  hasQuestFlag?: (playerId: string, flagId: string, value: boolean) => boolean;
  loadPlayerAuthorities?: (playerId: string) => Promise<Readonly<{
    items: Readonly<Record<string, number>>;
    questFlags: Readonly<Record<string, boolean>>;
  }>>;
  harvestResource?: (
    playerId: string,
    resourceType: DungeonResourceType,
    quantity: number,
    context: Readonly<{ instanceId: string; runId: string; dungeonId: string; resourceId: string; requestId: string }>
  ) => number | void | Promise<number | void>;
  appearanceForPlayer?: (playerId: string) => PlayerAppearanceSnapshot | undefined;
  grantReward?: (
    playerId: string | undefined,
    rewardTableId: string,
    context: Readonly<{ instanceId: string; runId: string; dungeonId: string;
      rewardSourceId: string; requestId?: string; torchTotal?: number }>
  ) => void | Promise<void>;
  partyIdForPlayer?: (playerId: string) => string | null;
  /** A timed rescue succeeded: the player gains a freed ally. */
  rescueAlly?: (playerId: string) => void;
  /** The player left the dungeon: freed allies leave with them. */
  releaseAllies?: (playerId: string) => void;
  /**
   * Drowned City sites: the site's position when it stands on coastal ocean, else null (fail closed
   * on an unknown surface). Without it no Drowned City entrance resolves.
   */
  drownedCitySite?: (siteId: string) => Promise<LatLon | null>;
  /** Drowned City site ids on eligible water within `radiusM` of `position`. */
  drownedCitySitesNear?: (position: LatLon, radiusM: number) => Promise<readonly string[]>;
  /** A failed encounter moved this player to another room (send the new location and snapshot). */
  onPlayerEjected?: (playerId: string, location: PlayerLocationSnapshot | null, snapshot: DungeonSnapshot) => void;
  /** Afloat state for `access.requiresAfloat` (fails closed when absent). */
  isAfloat?: (playerId: string) => boolean;
  /** Golem Forge world sites (golemForgeSites.ts); without it no Forge site entrance resolves or collapses. */
  golemForgeSites?: Pick<GolemForgeSiteService, "site" | "siteForEntrance" | "sitesNear" | "recordForgemasterDeath" | "collapsedSites"> &
    Partial<Pick<GolemForgeSiteService, "retireLegacySite">>;
  /** Rolled ladder-dungeon world entrances (worldDungeonEntrances.ts); without it none resolves for world entry. */
  worldDungeonEntrances?: Pick<WorldDungeonEntranceService, "sitesNear" | "siteForEntrance">;
  /**
   * Inside the caller's open transaction, gives one shared-run admission back exactly what its charge took
   * (nothing for a zero-torch admission), idempotent per admission. Must throw when it cannot be applied.
   */
  refundAdmission?: (
    client: Pick<pg.PoolClient, "query">,
    context: Readonly<{ dungeonId: string; instanceId: string; runId: string; playerId: string; admissionId: string }>
  ) => Promise<void>;
  /**
   * Atlas Pass dungeon discount (ATLAS_PASS_DUNGEON_DISCOUNT_ENABLED): whether this player pays the
   * discounted entry cost. Absent when the discount is off, so everyone pays the authored cost.
   */
  atlasPassEntryDiscount?: (queryable: Pick<pg.PoolClient, "query">, playerId: string) => Promise<boolean>;
  /** Whether the player holds the items (read-only preview of the entry cost). */
  canAffordEntryCost?: (playerId: string, items: readonly Readonly<{ itemId: string; quantity: number }>[]) => Promise<boolean>;
  /**
   * Consumes the entry cost inside the caller's open transaction, so the charge and the presence row
   * commit or roll back together. Must throw when the player cannot afford it.
   */
  chargeEntryCost?: (
    client: Pick<pg.PoolClient, "query">,
    playerId: string,
    items: readonly Readonly<{ itemId: string; quantity: number }>[],
    /** `torches`: how many torches `items` pays for (torches x the per-torch cost); absent means one. */
    context: Readonly<{ dungeonId: string; instanceId: string; runId: string; torches?: number;
      /** A shared run's paid entry (dungeon_run_admissions): each admission is its own charge. */
      admissionId?: string }>
  ) => Promise<void>;
  /**
   * Inside the caller's open transaction, gives every payer of the run back exactly what chargeEntryCost
   * took from them, idempotent per (run, player). Must throw when a refund cannot be applied.
   */
  refundEntryCosts?: (
    client: Pick<pg.PoolClient, "query">,
    context: Readonly<{ dungeonId: string; instanceId: string; runId: string }>
  ) => Promise<void>;
  /**
   * Called when a Delver's Lore player voluntarily leaves an unfinished run (never the Cistern Warrens; death
   * and disconnect do not call it). Fire and forget: a failure here must never affect leaving.
   */
  onDungeonLeft?: (event: Readonly<{ playerId: string; runId: string; dungeonId: string; instanceId: string }>) => void | Promise<void>;
  /**
   * Called once for each player present when their run completes (never for the Cistern Warrens). Fire
   * and forget: a failure here must never affect the dungeon.
   */
  onDungeonCompleted?: (event: Readonly<{
    playerId: string;
    runId: string;
    dungeonId: string;
    dungeonName: string;
    entrance: DungeonEntranceSnapshot;
  }>) => void | Promise<void>;
}>;

/** Host services that do not change dungeon mechanics. Omitted by durable game hosts. */
type DungeonExecutionEnvironment = Readonly<{
  now?: () => number;
  ephemeralRunId?: string;
  storageAttempts?: () => number;
  /** Disposable hosts (Play Test) may simulate a torch total; durable hosts use torchTotalForRun. */
  torchTotal?: number;
}>;

type EntranceRow = {
  structure_id: string;
  city_id: string;
  city_name: string;
  region_code: string | null;
  placement_revision: string;
  lat: number;
  lon: number;
};

export type CisternWarrensCanonicalTransform = Readonly<{
  spaceId: string;
  position: IndoorPoint;
  instanceId?: string;
  locationType?: "cistern_warrens" | "dungeon";
}>;

export type CisternWarrensRestoreTransform = CisternWarrensCanonicalTransform & Readonly<{
  sewerId: string;
}>;

/** A run the torch lobby paid expires (every payer refunded) when nobody enters it within this long (tunable). */
export const DUNGEON_PENDING_TORCH_RUN_TTL_MS = 15 * 60_000;
/** How often the tick sweeps for expired paid runs that no entrance touched (the lazy checks cover the rest). */
const PENDING_TORCH_RUN_SWEEP_MS = 60_000;
/** The sweep only looks this far back; older strays are expired lazily when their entrance is used. */
const PENDING_TORCH_RUN_SWEEP_WINDOW_MS = 7 * 24 * 60 * 60_000;

/** A world entrance whose runs burn torches, as seen by one player (see DungeonRuntime.torchEntryFor). */
export type DungeonTorchEntry = Readonly<{
  entranceId: string;
  dungeonId: string;
  dungeonName: string;
  position: LatLon;
  interactionRadiusM: number;
  instanceId: string;
  /** The party the instance belongs to (party-scoped instances only), else null. */
  partyId: string | null;
  /** Party-scoped instance: a member who changes party no longer belongs to this run. */
  partyScoped: boolean;
  /** What one torch costs. */
  entryCost: ReadonlyArray<Readonly<{ itemId: string; quantity: number }>>;
  paid: boolean;
  /**
   * The lobby this entry gathers in, when it is not the instance itself: a shared Golem Forge run has one
   * instance but a lobby per party (or solo player).
   */
  lobbyKey?: string;
  /** Golem Forge: bosses alive when this price was read; the charge refuses if it changed. */
  bossesAlive?: number;
}>;

function torchesRequired(dungeon: DungeonDefinition): DungeonError {
  return new DungeonError("DUNGEON_TORCHES_REQUIRED",
    `Light torches at the entrance of ${dungeon.name} before entering (each torch: ` +
    `${describeDungeonEntryCost(dungeon.access?.entryCost ?? [])}).`);
}

export class DungeonError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "DungeonError";
  }
}

export class DungeonRuntime {
  private readonly sessions = new Map<string, SewerSession>();
  /** Players whose eject commit has not finished: they are leaving their room and must not restart its fight. */
  private readonly ejectsInFlight = new Set<string>();
  private readonly routes = new Map<string, IndoorPoint[]>();
  private readonly instances = new Map<string, DungeonInstanceState>();
  /** Timed `damage` zones (lava vents) per occupied room: when the room woke and each zone's last eruption. */
  private readonly damageZoneClocks = new Map<string, { wokeAt: number; last: Map<string, number> }>();
  private readonly hydrationPromises = new Map<string, Promise<void>>();
  private readonly hydratedRuns = new WeakMap<DungeonInstanceState, string>();
  private readonly itemAuthorityCache = new Map<string, Readonly<Record<string, number>>>();
  private readonly questFlagAuthorityCache = new Map<string, Readonly<Record<string, boolean>>>();
  private readonly resourceHarvestTails = new Map<string, Promise<void>>();
  private readonly repeatLedger: DungeonRepeatLedger;
  private readonly roomLeaveListeners = new Set<(playerId: string) => void>();
  private lastPendingTorchRunSweepAt = 0;
  private pendingTorchRunSweep: Promise<void> | null = null;
  private lastGolemForgeSweepAt = 0;
  private golemForgeSweep: Promise<void> | null = null;
  /** Instance ids of Golem Forge sites past their collapse time (rebuilt by the sweep after a restart). */
  private readonly collapsedForges = new Set<string>();

  constructor(
    private readonly pool: pg.Pool,
    private readonly combat: CombatEngine,
    private readonly playerLocations?: PlayerLocationService,
    private readonly dungeon: DungeonDefinition = CISTERN_WARRENS_DUNGEON,
    private readonly authorities: DungeonRuntimeAuthorities = {},
    private readonly catalog: DungeonCatalog = DUNGEON_CATALOG,
    repeatLedger?: DungeonRepeatLedger,
    private readonly developerSpawnedDungeons?: DeveloperSpawnedDungeonService,
    private readonly bossEncounters?: BossEncounterManager | null,
    private readonly execution: DungeonExecutionEnvironment = {}
  ) {
    this.repeatLedger = repeatLedger ?? new DungeonRepeatLedger(pool);
    this.combat.setMobCombatModifierProvider?.((entityId) => this.eliteCombatModifiers(entityId));
  }

  /** No Pool is accepted: this host cannot connect to, read, or write a database. */
  static ephemeral(input: Readonly<{
    combat: CombatEngine; dungeon: DungeonDefinition; catalog: DungeonCatalog;
    runId: string; now: () => number; authorities?: DungeonRuntimeAuthorities;
    bossEncounters?: BossEncounterManager; torchTotal?: number;
  }>): DungeonRuntime {
    let storageAttempts = 0;
    const reject = () => { storageAttempts += 1; throw new Error("Ephemeral dungeon attempted durable storage access."); };
    const unavailablePool = { query: reject, connect: reject } as unknown as pg.Pool;
    return new DungeonRuntime(unavailablePool, input.combat, undefined, input.dungeon,
      input.authorities, input.catalog, undefined, undefined, input.bossEncounters,
      { now: input.now, ephemeralRunId: input.runId, storageAttempts: () => storageAttempts,
        ...(input.torchTotal !== undefined ? { torchTotal: input.torchTotal } : {}) });
  }

  /**
   * Torches burned for a run, which decides how many rolled torch sets spawn. Durable runs use the total
   * stored on the run (dungeon_run_stats.torch_total), read when a run is started, entered or restored
   * and kept on the instance; disposable hosts (Play Test) may override it.
   */
  private torchTotalForRun(stored: number | null | undefined): number {
    return this.execution.torchTotal ?? stored ?? 1;
  }

  /** The run's dungeon: the authored one materialized for this run, shared with a live instance of it. */
  private runDungeon(authored: DungeonDefinition, instanceId: string, runId: string): DungeonDefinition {
    const live = this.instances.get(instanceId);
    return live && live.runId === runId ? live.dungeon : materializeDungeonRun(authored, runId);
  }

  /** Notified when a player leaves a dungeon room or the dungeon (their room-scoped gathering must stop). */
  onPlayerLeftRoom(listener: (playerId: string) => void): () => void {
    this.roomLeaveListeners.add(listener);
    return () => { this.roomLeaveListeners.delete(listener); };
  }

  private notifyLeftRoom(playerId: string): void {
    for (const listener of this.roomLeaveListeners) {
      try { listener(playerId); } catch { /* a listener never blocks leaving */ }
    }
  }

  /** Server clock at each player's latest entry into a room; the heart-puzzle solve check reads it. */
  private readonly roomEnteredAt = new Map<string, number>();
  private now(): number { return this.execution.now?.() ?? Date.now(); }

  get ephemeralStorageAttempts(): number { return this.execution.storageAttempts?.() ?? 0; }

  /** Explicit debug reset, available only to disposable hosts; other rooms retain their progress. */
  resetEphemeralRoom(playerId: string): void {
    if (!this.execution.ephemeralRunId) throw new Error("Room reset requires an ephemeral dungeon host.");
    const session = this.sessions.get(playerId);
    if (!session) throw new DungeonError("SESSION_NOT_FOUND", "That dungeon session is no longer active.");
    const instance = this.instance(session);
    const room = this.roomDefinition(session.spaceId, session.dungeon);
    const encounterIds = new Set(session.dungeon.encounters.filter((entry) => entry.roomId === room.id).map((entry) => entry.id));
    const portalIds = new Set(session.dungeon.portals.filter((entry) => entry.source.kind === "room" && entry.source.roomId === room.id).map((entry) => entry.id));
    for (const definition of session.dungeon.encounters) {
      if (!encounterIds.has(definition.id)) continue;
      const state = instance.encounters.get(definition.id);
      if (!state) continue;
      for (const entityId of state.spawnedMobIds.values()) {
        const boss = this.bossEncounters?.encounterForEntity(entityId);
        if (boss) this.bossEncounters?.despawn(boss.encounterId, "debug-room-reset");
        this.combat.despawnMob(entityId);
      }
      Object.assign(state, { state: "idle", currentWaveId: null, attempts: 0,
        spawnedMobIds: new Map(), nextWaveAt: null, pendingWaveId: null });
      for (const portalId of definition.lockPortalIds) instance.portalLocks.set(portalId, false);
    }
    for (const object of room.objects.filter((entry) => !entry.retired)) {
      instance.objectStates.set(objectKey(room.id, object.id), object.initialState);
      instance.objectAvailability.set(objectKey(room.id, object.id), object.available &&
        dungeonObjectSpawnsInRun(instance.dungeon, instance.runId, room.id, object));
    }
    for (const portalId of portalIds) instance.portalLocks.set(portalId, false);
    for (const trigger of session.dungeon.triggers.filter((entry) => !entry.retired)) {
      const event = trigger.event;
      const belongs = ("roomId" in event && event.roomId === room.id)
        || ("encounterId" in event && encounterIds.has(event.encounterId))
        || ("portalId" in event && portalIds.has(event.portalId))
        || (event.type === "timer" && trigger.actions.some((action) =>
          ("roomId" in action && action.roomId === room.id)
          || ("encounterId" in action && encounterIds.has(action.encounterId))
          || ("portalId" in action && portalIds.has(action.portalId))));
      if (!belongs) continue;
      instance.triggers.set(trigger.id, { enabled: trigger.enabled, firedCount: 0, cooldowns: new Map(),
        sequenceIndexes: new Map(), timerDueAt: event.type === "timer" ? this.now() + event.delayMs : null,
        firedScopes: new Set(), rewardEligible: new Set() });
      for (const action of trigger.actions) if (action.type === "set_dungeon_flag") instance.flags.delete(action.flagId);
    }
    for (const [id, resource] of instance.resources) if (resource.roomId === room.id) instance.resources.delete(id);
    this.initializeResources(instance);
    instance.processedInteractions.clear();
    instance.processedResourceHarvests.clear();
    instance.zoneMembership.delete(playerId);
    instance.allPlayersPresent.clear();
    instance.completed = false;
    instance.cues.length = 0;
    instance.notices.length = 0;
    const spawn = dungeonAnchorDefinition(room, room.spawnAnchorId);
    this.transferSpace(playerId, session.sessionId, room.id, spawn);
  }

  /**
   * World to dungeon entry rules: minimum level, then repeat lockout, then (for a dungeon with a torch
   * cost) that the instance's run is already paid in the torch lobby or under way. Entry itself never
   * charges. Throws a DungeonError / DungeonRepeatError whose message is shown to the player.
   */
  async authorizeEntry(playerId: string, sewerId: string): Promise<void> {
    const { entrance, dungeon } = await this.authorizeEntryGates(playerId, sewerId);
    if (!entrance || !dungeon || entrance.developerSpawned || !dungeon.access?.entryCost?.length ||
        this.isLegacySewerEntrance(sewerId, dungeon)) return;
    const instanceId = authoredInstanceId(
      entrance.entranceId, dungeon.instancePolicy, playerId, this.authorities.partyIdForPlayer?.(playerId) ?? null
    );
    if (isGolemForge(dungeon)) {
      // The shared Forge admits a player who paid at its entrance and has not entered on that payment yet.
      if (!await this.hasUnenteredAdmission(this.pool, instanceId, playerId)) throw torchesRequired(dungeon);
      return;
    }
    if ((await this.paidRunState(this.pool, instanceId, dungeon)).state === "none") throw torchesRequired(dungeon);
  }

  /**
   * The per-player gates of entry: minimum level, then repeat lockout. Developer-spawned entrances bypass
   * them (dev testing only). Also checked for every torch lobby member before anyone is charged.
   */
  async authorizeEntryGates(playerId: string, sewerId: string): Promise<Readonly<{
    entrance: DungeonEntranceSnapshot | null; dungeon: DungeonDefinition | undefined;
  }>> {
    if (parseGolemForgeEntranceId(sewerId)) {
      const site = await this.authorities.golemForgeSites?.siteForEntrance(sewerId);
      if (!site) throw new DungeonError("DUNGEON_NOT_FOUND", "This Golem Forge is gone. Look for the new one in the region.");
      if (site.state === "collapsed") {
        throw new DungeonError("DUNGEON_COLLAPSED",
          "The Golem Forge has collapsed. A new one opens elsewhere in the region within the hour.");
      }
    }
    if (parseWorldDungeonEntranceId(sewerId)) {
      const site = await this.authorities.worldDungeonEntrances?.siteForEntrance(sewerId);
      if (!site) throw new DungeonError("DUNGEON_NOT_FOUND", "This entrance is gone. Look for a new one elsewhere.");
      if (!site.visible) throw new DungeonError("DUNGEON_HIDDEN", "The entrance has faded from sight. Come back at another time of day.");
    }
    const entrance = await this.entrance(sewerId, true);
    if (!entrance && drownedCitySiteIdForEntrance(sewerId)) {
      throw new DungeonError("DUNGEON_NOT_FOUND", "The Drowned City cannot be reached from here right now.");
    }
    const dungeon = entrance
      ? this.catalog.dungeons.find((candidate) => candidate.id === entrance.dungeonId && !candidate.retired)
      : undefined;
    if (entrance?.developerSpawned) return { entrance, dungeon };
    const access = dungeon?.access;
    if (entrance && dungeon && access?.requiresAfloat && this.authorities.isAfloat?.(playerId) !== true) {
      throw new DungeonError("DUNGEON_AFLOAT_REQUIRED", `${dungeon.name} is entered from the water. Get afloat first.`);
    }
    const minimumLevel = effectiveDungeonMinimumLevel(access);
    // A developer-placed Golem Forge keeps its real lobby and price but skips the level gate (so it can be tested).
    const developerForge = isGolemForge(dungeon) && !parseGolemForgeEntranceId(sewerId);
    if (entrance && dungeon && minimumLevel && !developerForge) {
      const level = await this.playerLevel(playerId);
      if (level < minimumLevel) {
        throw new DungeonError(
          "DUNGEON_LEVEL_TOO_LOW",
          `${dungeon.name} requires level ${minimumLevel}. You are level ${level}.`
        );
      }
    }
    await this.repeatLedger.authorizeEntry(
      playerId,
      dungeon && !this.isLegacySewerEntrance(sewerId, dungeon) ? dungeonLockoutKey(dungeon.id) : cisternWarrensDungeonKey(sewerId)
    );
    return { entrance, dungeon };
  }

  /**
   * The torch lobby view of an entrance for this player: null when entry burns no torches (no entry
   * cost, a developer entrance or the legacy sewer). `paid` means the instance's run is already paid or
   * under way, so the player enters free (late joiners never change the torch total).
   */
  async torchEntryFor(playerId: string, entranceId: string): Promise<DungeonTorchEntry | null> {
    const entrance = await this.entrance(entranceId);
    const dungeon = entrance
      ? this.catalog.dungeons.find((candidate) => candidate.id === entrance.dungeonId && !candidate.retired)
      : undefined;
    const entryCost = dungeon?.access?.entryCost;
    // A shared instance has no party to gather: every stranger would share one lobby and enter free. Each
    // entrant pays their own torch on entry instead (see enter). The shared Golem Forge is the exception:
    // each party gathers in its own lobby and pays there for its own admission into the one shared run.
    if (!entrance || !dungeon || entrance.developerSpawned || !entryCost?.length ||
        (dungeon.instancePolicy === "shared_persistent" && !isGolemForge(dungeon)) ||
        this.isLegacySewerEntrance(entranceId, dungeon) || this.execution.ephemeralRunId) return null;
    const partyId = this.authorities.partyIdForPlayer?.(playerId) ?? null;
    const instanceId = authoredInstanceId(entrance.entranceId, dungeon.instancePolicy, playerId, partyId);
    if (isGolemForge(dungeon)) {
      const bossesAlive = await this.forgeBossesAlive(this.pool, instanceId);
      return { entranceId: entrance.entranceId, dungeonId: dungeon.id, dungeonName: dungeon.name,
        position: { lat: entrance.lat, lon: entrance.lon }, interactionRadiusM: entrance.interactionRadiusM,
        instanceId, lobbyKey: forgeLobbyKey(instanceId, playerId, partyId), partyId, partyScoped: partyId !== null,
        entryCost: await this.entryCostFor(this.pool, playerId, golemForgeEntryCost(bossesAlive)),
        paid: await this.hasUnenteredAdmission(this.pool, instanceId, playerId), bossesAlive };
    }
    const partyScoped = dungeon.instancePolicy === "party_ephemeral";
    await this.expireStalePendingTorchRun(instanceId, dungeon.id);
    const paid = (await this.paidRunState(this.pool, instanceId, dungeon)).state !== "none";
    return { entranceId: entrance.entranceId, dungeonId: dungeon.id, dungeonName: dungeon.name,
      position: { lat: entrance.lat, lon: entrance.lon }, interactionRadiusM: entrance.interactionRadiusM,
      instanceId, partyId: partyScoped ? partyId : null, partyScoped,
      // Per torch, as this player pays it (the Atlas Pass discount when it applies).
      entryCost: await this.entryCostFor(this.pool, playerId, entryCost), paid };
  }

  /**
   * Starts a torch run from the lobby. Every member's level and lockout are checked first; then, in one
   * transaction under the instance lock, a fresh run is opened, each member pays torches x the entry cost
   * from their own pack (idempotent per run and player) and the total is stored on the run. Any failed
   * charge rolls back every charge and the run, so nobody pays and nobody enters. A repeated start finds
   * the run it already paid (nobody inside yet) and charges nothing; a run under way refuses.
   */
  async startTorchRun(input: Readonly<{
    entranceId: string;
    members: ReadonlyArray<Readonly<{ playerId: string; name: string; torches: number }>>;
    /** Golem Forge: the boss count the lobby showed its price for; a different live count charges nobody. */
    expectedBossesAlive?: number;
  }>): Promise<Readonly<{ runId: string; instanceId: string; torchTotal: number; replayed: boolean }>> {
    const [first] = input.members;
    const entry = first ? await this.torchEntryFor(first.playerId, input.entranceId) : null;
    const dungeon = entry && this.catalog.dungeons.find((candidate) => candidate.id === entry.dungeonId);
    if (!entry || !dungeon) throw new DungeonError("TORCH_LOBBY_UNAVAILABLE", "This entrance burns no torches.");
    const ids = new Set(input.members.map((member) => member.playerId));
    const total = input.members.reduce((sum, member) => sum + member.torches, 0);
    if (ids.size !== input.members.length || input.members.some((member) =>
      !Number.isInteger(member.torches) || member.torches < DUNGEON_TORCH_MEMBER_MIN || member.torches > DUNGEON_TORCH_TOTAL_MAX)) {
      throw new DungeonError("DUNGEON_TORCHES_INVALID", "Each member picks a whole number of torches.");
    }
    if (total < DUNGEON_TORCH_TOTAL_MIN || total > DUNGEON_TORCH_TOTAL_MAX) {
      throw new DungeonError("DUNGEON_TORCHES_INVALID",
        `The party burns ${DUNGEON_TORCH_TOTAL_MIN} to ${DUNGEON_TORCH_TOTAL_MAX} torches in total.`);
    }
    if (isGolemForge(dungeon)) return this.startForgeAdmission(entry, dungeon, input, total);
    for (const member of input.members) {
      const instanceId = authoredInstanceId(entry.entranceId, dungeon.instancePolicy, member.playerId,
        this.authorities.partyIdForPlayer?.(member.playerId) ?? null);
      if (instanceId !== entry.instanceId) {
        throw new DungeonError("TORCH_LOBBY_PARTY_CHANGED", `${member.name} is no longer in this party.`);
      }
      try {
        await this.authorizeEntryGates(member.playerId, input.entranceId);
      } catch (error) {
        if (error instanceof DungeonError || error instanceof DungeonRepeatError) {
          throw new DungeonError(error.code, `${member.name}: ${error.message}`);
        }
        throw error;
      }
    }
    if (!this.authorities.chargeEntryCost) {
      throw new DungeonError("DUNGEON_ENTRY_COST_UNAVAILABLE", "Torches cannot be collected right now.");
    }
    const instanceId = entry.instanceId;
    const client = await this.pool.connect();
    let result: { runId: string; torchTotal: number; replayed: boolean };
    try {
      await client.query("BEGIN");
      await lockDungeonInstance(client, instanceId);
      const current = await this.paidRunState(client, instanceId, dungeon);
      if (current.state === "pending") {
        result = { runId: current.runId!, torchTotal: current.torchTotal!, replayed: true };
      } else if (current.state === "live") {
        throw new DungeonError("DUNGEON_RUN_IN_PROGRESS", `A ${dungeon.name} run is already under way. Enter to join it.`);
      } else {
        if (current.runId) await endDungeonRunStats(client, current.runId);
        const runId = randomUUID();
        await client.query(
          `INSERT INTO dungeon_instance_runs (instance_id,run_id,updated_at) VALUES ($1,$2::uuid,now())
           ON CONFLICT (instance_id) DO UPDATE SET run_id=EXCLUDED.run_id,updated_at=now()`,
          [instanceId, runId]
        );
        const payers = [...input.members].filter((member) => member.torches > 0)
          .sort((left, right) => left.playerId.localeCompare(right.playerId));
        for (const member of payers) {
          const perTorch = await this.entryCostFor(client, member.playerId, dungeon.access!.entryCost!);
          const cost = perTorch.map((item) => ({ itemId: item.itemId, quantity: item.quantity * member.torches }));
          try {
            await this.authorities.chargeEntryCost(client, member.playerId, cost,
              { dungeonId: dungeon.id, instanceId, runId, torches: member.torches });
          } catch {
            throw new DungeonError("DUNGEON_ENTRY_COST_UNAFFORDABLE",
              `${member.name} cannot pay for ${member.torches} ${member.torches === 1 ? "torch" : "torches"} ` +
              `(${describeDungeonEntryCost(cost)}). Nobody was charged.`);
          }
        }
        await client.query(
          `INSERT INTO dungeon_run_stats (run_id,instance_id,dungeon_id,tier,torch_total,party_size,deaths_by_player)
           VALUES ($1::uuid,$2,$3,$4,$5,0,'{}'::jsonb)`,
          [runId, instanceId, dungeon.id, dungeon.tier?.id ?? null, total]
        );
        result = { runId, torchTotal: total, replayed: false };
        // A member may have left the party (or the lobby's instance) while the charges ran: nobody pays.
        for (const member of input.members) {
          const memberInstanceId = authoredInstanceId(entry.entranceId, dungeon.instancePolicy, member.playerId,
            this.authorities.partyIdForPlayer?.(member.playerId) ?? null);
          if (memberInstanceId !== instanceId) {
            throw new DungeonError("TORCH_LOBBY_PARTY_CHANGED", `${member.name} left the party. Nobody was charged.`);
          }
        }
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    // A previous run still held in memory (despawn pending) gives way to the paid run before anyone enters.
    const live = this.instances.get(instanceId);
    if (live && live.runId !== result.runId) this.resetInstanceState(live, result.runId, result.torchTotal);
    return { ...result, instanceId };
  }

  /**
   * The shared Golem Forge's torch lobby start: every member's level and lockout are checked, then in one
   * transaction under the Forge's instance lock the live boss count is re-read (a count other than the one
   * the lobby priced refuses, so the price shown is the price charged), each paying member is charged
   * torches x the price for that count from their own pack, and one admission per member is written for
   * this party entry. A member who already holds an unentered admission refuses the start (no double pay).
   * Any failure rolls everything back: nobody pays.
   */
  private async startForgeAdmission(
    entry: DungeonTorchEntry,
    dungeon: DungeonDefinition,
    input: Readonly<{
      entranceId: string;
      members: ReadonlyArray<Readonly<{ playerId: string; name: string; torches: number }>>;
      expectedBossesAlive?: number;
    }>,
    total: number
  ): Promise<Readonly<{ runId: string; instanceId: string; torchTotal: number; replayed: boolean }>> {
    const lobbyKey = entry.lobbyKey ?? entry.instanceId;
    const memberLobbyKey = (playerId: string) =>
      forgeLobbyKey(entry.instanceId, playerId, this.authorities.partyIdForPlayer?.(playerId) ?? null);
    for (const member of input.members) {
      if (memberLobbyKey(member.playerId) !== lobbyKey) {
        throw new DungeonError("TORCH_LOBBY_PARTY_CHANGED", `${member.name} is no longer in this party.`);
      }
      try {
        await this.authorizeEntryGates(member.playerId, input.entranceId);
      } catch (error) {
        if (error instanceof DungeonError || error instanceof DungeonRepeatError) {
          throw new DungeonError(error.code, `${member.name}: ${error.message}`);
        }
        throw error;
      }
    }
    if (!this.authorities.chargeEntryCost) {
      throw new DungeonError("DUNGEON_ENTRY_COST_UNAVAILABLE", "Torches cannot be collected right now.");
    }
    const instanceId = entry.instanceId;
    const partyEntryId = randomUUID();
    const client = await this.pool.connect();
    let runId: string;
    try {
      await client.query("BEGIN");
      runId = await loadOrCreateDungeonRun(client, instanceId);
      const bossesAlive = await this.forgeBossesAlive(client, instanceId);
      if (input.expectedBossesAlive !== undefined && input.expectedBossesAlive !== bossesAlive) {
        throw forgePriceChanged(dungeon, bossesAlive);
      }
      const members = [...input.members].sort((left, right) => left.playerId.localeCompare(right.playerId));
      for (const member of members) {
        if (await this.hasUnenteredAdmission(client, instanceId, member.playerId, true)) {
          throw new DungeonError("DUNGEON_ALREADY_PAID",
            `${member.name} already paid to enter ${dungeon.name}. Nobody was charged.`);
        }
      }
      for (const member of members) {
        const admissionId = randomUUID();
        if (member.torches > 0) {
          const perTorch = await this.entryCostFor(client, member.playerId, golemForgeEntryCost(bossesAlive));
          const cost = perTorch.map((item) => ({ itemId: item.itemId, quantity: item.quantity * member.torches }));
          try {
            await this.authorities.chargeEntryCost(client, member.playerId, cost,
              { dungeonId: dungeon.id, instanceId, runId, torches: member.torches, admissionId });
          } catch {
            throw new DungeonError("DUNGEON_ENTRY_COST_UNAFFORDABLE",
              `${member.name} cannot pay for ${member.torches} ${member.torches === 1 ? "torch" : "torches"} ` +
              `(${describeDungeonEntryCost(cost)}). Nobody was charged.`);
          }
        }
        await client.query(
          `INSERT INTO dungeon_run_admissions
             (admission_id,party_entry_id,instance_id,run_id,dungeon_id,player_id,torches,party_torch_total,bosses_alive)
           VALUES ($1::uuid,$2::uuid,$3,$4::uuid,$5,$6,$7,$8,$9)`,
          [admissionId, partyEntryId, instanceId, runId, dungeon.id, member.playerId, member.torches, total, bossesAlive]
        );
      }
      // A member may have left the party while the charges ran: nobody pays.
      for (const member of input.members) {
        if (memberLobbyKey(member.playerId) !== lobbyKey) {
          throw new DungeonError("TORCH_LOBBY_PARTY_CHANGED", `${member.name} left the party. Nobody was charged.`);
        }
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    return { runId, instanceId, torchTotal: total, replayed: false };
  }

  /** Whether the player holds a paid, unentered admission into the instance's current shared run. */
  private async hasUnenteredAdmission(
    queryable: Pick<pg.PoolClient, "query">,
    instanceId: string,
    playerId: string,
    lock = false
  ): Promise<boolean> {
    const result = await queryable.query(
      `SELECT 1 FROM dungeon_run_admissions admission
         JOIN dungeon_instance_runs run ON run.instance_id=admission.instance_id AND run.run_id=admission.run_id
        WHERE admission.instance_id=$1 AND admission.player_id=$2 AND admission.entered_at IS NULL
          AND admission.refunded_at IS NULL
        LIMIT 1${lock ? " FOR UPDATE OF admission" : ""}`,
      [instanceId, playerId]
    );
    return Boolean(result?.rowCount);
  }

  /**
   * Golem Forge bosses still alive in the instance's current run: the live instance when it holds that run
   * (authoritative; persistence lags it), otherwise the persisted encounter states. No run yet = all three.
   */
  private async forgeBossesAlive(queryable: Pick<pg.PoolClient, "query">, instanceId: string): Promise<number> {
    const result = await queryable.query<{ run_id: string; encounter_states: unknown }>(
      `SELECT run.run_id::text, state.encounter_states
         FROM dungeon_instance_runs run
         LEFT JOIN dungeon_instance_state state ON state.instance_id=run.instance_id AND state.run_id=run.run_id
        WHERE run.instance_id=$1`,
      [instanceId]
    );
    const row = result?.rows?.[0];
    if (!row) return GOLEM_FORGE_BOSS_ENCOUNTER_IDS.length;
    const live = this.instances.get(instanceId);
    if (live && live.runId === row.run_id && this.hydratedRuns.get(live) === live.runId) {
      return GOLEM_FORGE_BOSS_ENCOUNTER_IDS.filter((id) => live.encounters.get(id)?.state !== "completed").length;
    }
    const states = isRecord(row.encounter_states) ? row.encounter_states : {};
    return GOLEM_FORGE_BOSS_ENCOUNTER_IDS.filter((id) => {
      const state = states[id];
      return !(isRecord(state) && state.state === "completed");
    }).length;
  }

  /**
   * Expires the instance's paid run when nobody entered it within DUNGEON_PENDING_TORCH_RUN_TTL_MS: in one
   * transaction under the instance lock, every payer gets back exactly what they paid (idempotent per run
   * and player), the run's stats end and the instance moves to a fresh, unpaid run. A run anyone entered
   * (a presence row, or entrants on its stats) never expires. Failures leave the run pending (it can still
   * be entered) and are retried on the next touch or sweep. Returns whether a run expired.
   */
  async expireStalePendingTorchRun(instanceId: string, dungeonId: string): Promise<boolean> {
    if (this.execution.ephemeralRunId || !this.authorities.refundEntryCosts) return false;
    try {
      const candidate = await this.pool.query<{ run_id: string }>(
        `${STALE_PENDING_TORCH_RUN_SQL} LIMIT 1`, [instanceId, DUNGEON_PENDING_TORCH_RUN_TTL_MS]
      );
      if (!candidate?.rows?.[0]?.run_id) return false;
      const client = await this.pool.connect();
      let expired: { runId: string; nextRunId: string } | null = null;
      try {
        await client.query("BEGIN");
        await lockDungeonInstance(client, instanceId);
        const stale = await client.query<{ run_id: string }>(
          `${STALE_PENDING_TORCH_RUN_SQL} FOR UPDATE OF run`, [instanceId, DUNGEON_PENDING_TORCH_RUN_TTL_MS]
        );
        const runId = stale?.rows?.[0]?.run_id;
        if (runId) {
          await this.authorities.refundEntryCosts(client, { dungeonId, instanceId, runId });
          await endDungeonRunStats(client, runId);
          const nextRunId = randomUUID();
          await client.query(
            "UPDATE dungeon_instance_runs SET run_id=$2::uuid,updated_at=now() WHERE instance_id=$1",
            [instanceId, nextRunId]
          );
          expired = { runId, nextRunId };
        }
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
      if (!expired) return false;
      const live = this.instances.get(instanceId);
      if (live && live.runId === expired.runId && this.sessionsInInstance(instanceId).length === 0) {
        this.resetInstanceState(live, expired.nextRunId);
      }
      return true;
    } catch (error) {
      console.warn(`[dungeon] pending torch run expiry failed instance=${instanceId} ` +
        `reason=${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  /** The Golem Forge site entrance id this instance belongs to, or null (other dungeons, dev Forges). */
  private forgeSiteEntranceId(instance: DungeonInstanceState): string | null {
    const instanceId = this.instanceIdFor(instance);
    const entranceId = instanceId.startsWith("dungeon:") ? instanceId.slice("dungeon:".length) : "";
    return isGolemForge(instance.dungeon) && parseGolemForgeEntranceId(entranceId) ? entranceId : null;
  }

  /** The Forgemaster died: the site collapses 24 h from now (durable; the sweep repairs a failed write). */
  private recordForgeCleared(instance: DungeonInstanceState): void {
    const entranceId = this.forgeSiteEntranceId(instance);
    if (!entranceId || !this.authorities.golemForgeSites || this.execution.ephemeralRunId) return;
    void this.authorities.golemForgeSites.recordForgemasterDeath(entranceId, this.now())
      .catch(() => this.recordDiagnostic(instance, "error:golem_forge_collapse_time_unrecorded"));
  }

  /**
   * When this Forge's Forgemaster died, or null while it lives: the final boss encounter's persisted completion
   * time, else `now` for a run that is complete without one (the 24 h collapse then counts from this sweep).
   */
  private forgemasterDiedAt(instance: DungeonInstanceState, now: number): number | null {
    if (!isGolemForge(instance.dungeon)) return null;
    const boss = instance.encounters.get(GOLEM_FORGE_FINAL_BOSS_ENCOUNTER_ID);
    if (boss?.state === "completed") return boss.completedAt ?? now;
    return instance.completed ? now : null;
  }

  /**
   * Golem Forge lifecycle sweep (from the tick, every 30 s): re-records the collapse time of every cleared
   * Forge held in memory (idempotent: the first time stands), then collapses every site past its collapse
   * time. Everything it acts on is read from the database, so a restart picks up where it left off.
   */
  private sweepGolemForges(now: number): void {
    const sites = this.authorities.golemForgeSites;
    if (this.execution.ephemeralRunId || !sites || this.golemForgeSweep ||
        now - this.lastGolemForgeSweepAt < GOLEM_FORGE_SWEEP_MS) return;
    this.lastGolemForgeSweepAt = now;
    this.golemForgeSweep = (async () => {
      for (const instance of this.instances.values()) {
        // A Forge whose Forgemaster is dead (completed run, or its persisted boss encounter) must have a collapse
        // time: this heals a missed write and a restart that restored the state but not the 24 h clock.
        const diedAt = this.forgemasterDiedAt(instance, now);
        const entranceId = diedAt === null ? null : this.forgeSiteEntranceId(instance);
        if (entranceId && diedAt !== null) await sites.recordForgemasterDeath(entranceId, diedAt).catch(() => undefined);
      }
      // Forges not held in memory (a restart nobody has entered since): read their current run's persisted state.
      const persisted = await Promise.resolve(this.pool.query<{ instance_id: string; died_at: string | null }>(
        `SELECT st.instance_id, st.encounter_states->'${GOLEM_FORGE_FINAL_BOSS_ENCOUNTER_ID}'->>'completedAt' AS died_at
           FROM dungeon_instance_state st
           JOIN dungeon_instance_runs run ON run.instance_id=st.instance_id AND run.run_id=st.run_id
          WHERE starts_with(st.instance_id, 'dungeon:golem_forge_')
            AND (st.completed OR st.encounter_states->'${GOLEM_FORGE_FINAL_BOSS_ENCOUNTER_ID}'->>'state'='completed')`
      )).catch(() => null);
      for (const row of persisted?.rows ?? []) {
        if (this.instances.has(row.instance_id)) continue;
        const diedAt = Number(row.died_at);
        await sites.recordForgemasterDeath(row.instance_id.slice("dungeon:".length),
          Number.isFinite(diedAt) && row.died_at !== null ? diedAt : now).catch(() => undefined);
      }
      // Retired-family (40,000 km²) Forges that never collapsed: refund paid admissions nobody used and
      // retire the region (collapseGolemForge, as for a collapse). Players inside can still leave.
      if (sites.retireLegacySite) {
        const unused = await Promise.resolve(this.pool.query<{ instance_id: string }>(
          `SELECT DISTINCT instance_id FROM dungeon_run_admissions
            WHERE starts_with(instance_id, 'dungeon:golem_forge_') AND entered_at IS NULL AND refunded_at IS NULL`
        )).catch(() => null);
        for (const row of unused?.rows ?? []) {
          const retired = await sites.retireLegacySite(row.instance_id.slice("dungeon:".length)).catch(() => null);
          if (retired) await this.collapseGolemForge(retired).catch((error: unknown) => {
            console.warn(`[dungeon] retired golem forge refund failed site=${retired.entranceId} ` +
              `reason=${error instanceof Error ? error.message : String(error)}`);
          });
        }
      }
      for (const site of await sites.collapsedSites()) {
        await this.collapseGolemForge(site).catch((error: unknown) => {
          console.warn(`[dungeon] golem forge collapse failed site=${site.entranceId} ` +
            `reason=${error instanceof Error ? error.message : String(error)}`);
        });
      }
    })().catch(() => undefined).finally(() => { this.golemForgeSweep = null; });
  }

  /**
   * Collapses one Golem Forge site (safe to repeat): in one transaction under the instance lock every paid
   * admission nobody entered is refunded exactly and marked refunded (so it can never be entered); everyone
   * still inside is moved to the gate room's world exit; once the collapsed hour is over the region moves
   * on to its next site (a new entrance, so a fresh instance and run) and the old instance is dropped.
   */
  async collapseGolemForge(site: GolemForgeSite): Promise<void> {
    const instanceId = `dungeon:${site.entranceId}`;
    const dungeon = this.catalog.dungeons.find((candidate) => isGolemForge(candidate));
    if (!dungeon) return;
    if (this.authorities.refundAdmission) {
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        await lockDungeonInstance(client, instanceId);
        const unused = await client.query<{ admission_id: string; run_id: string; player_id: string }>(
          `SELECT admission_id::text, run_id::text, player_id FROM dungeon_run_admissions
            WHERE instance_id=$1 AND entered_at IS NULL AND refunded_at IS NULL
            ORDER BY admission_id FOR UPDATE`,
          [instanceId]
        );
        for (const row of unused?.rows ?? []) {
          await this.authorities.refundAdmission(client, { dungeonId: dungeon.id, instanceId, runId: row.run_id,
            playerId: row.player_id, admissionId: row.admission_id });
          await client.query("UPDATE dungeon_run_admissions SET refunded_at=now() WHERE admission_id=$1::uuid",
            [row.admission_id]);
        }
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    }
    this.collapsedForges.add(instanceId);
    const instance = this.instances.get(instanceId);
    if (instance) {
      const gate = instance.dungeon.entrance;
      const arrival = dungeonAnchorDefinition(this.roomDefinition(gate.roomId, instance.dungeon), gate.arrivalAnchorId);
      for (const session of this.sessionsInInstance(instanceId)) {
        if (session.spaceId === gate.roomId) continue;
        void this.ejectToRoom(session, instance.dungeon.escape.portalId, gate.roomId, { x: arrival.x, y: arrival.y })
          .catch(() => undefined);
      }
      this.withNoticeBatch(instance, () => this.batch(instance).authored.push({
        text: "The Golem Forge is collapsing. Get out through the gate.", tone: "warning", audience: null
      }));
    }
    if (site.collapseAt === null || this.now() < site.collapseAt + GOLEM_FORGE_COLLAPSED_DISPLAY_MS) return;
    await this.authorities.golemForgeSites?.site(site.regionKey);
    if (instance && this.sessionsInInstance(instanceId).length === 0) {
      for (const encounter of instance.encounters.values()) {
        for (const entityId of encounter.spawnedMobIds.values()) this.combat.despawnMob(entityId);
      }
      this.instances.delete(instanceId);
      this.collapsedForges.delete(instanceId);
    }
  }

  /** Light periodic sweep (from the tick) for expired paid runs whose entrance nobody touched. */
  private sweepStalePendingTorchRuns(now: number): void {
    if (this.execution.ephemeralRunId || !this.authorities.refundEntryCosts || this.pendingTorchRunSweep ||
        now - this.lastPendingTorchRunSweepAt < PENDING_TORCH_RUN_SWEEP_MS) return;
    this.lastPendingTorchRunSweepAt = now;
    const dungeonIds = this.catalog.dungeons.filter((dungeon) => dungeon.access?.entryCost?.length)
      .map((dungeon) => dungeon.id);
    if (dungeonIds.length === 0) return;
    this.pendingTorchRunSweep = (async () => {
      const stale = await this.pool.query<{ instance_id: string; dungeon_id: string }>(
        `SELECT stats.instance_id, stats.dungeon_id
           FROM dungeon_run_stats stats
           JOIN dungeon_instance_runs run ON run.instance_id=stats.instance_id AND run.run_id=stats.run_id
          WHERE stats.dungeon_id = ANY($1::text[]) AND stats.ended_at IS NULL AND stats.party_size=0
            AND stats.started_at > now() - ($3::double precision * interval '1 millisecond')
            AND stats.started_at <= now() - ($2::double precision * interval '1 millisecond')
          LIMIT 20`,
        [dungeonIds, DUNGEON_PENDING_TORCH_RUN_TTL_MS, PENDING_TORCH_RUN_SWEEP_WINDOW_MS]
      );
      for (const row of stale?.rows ?? []) await this.expireStalePendingTorchRun(row.instance_id, row.dungeon_id);
    })().catch(() => undefined).finally(() => { this.pendingTorchRunSweep = null; });
  }

  /**
   * Whether the instance's current run is paid: `pending` (the torch lobby paid it and nobody entered
   * yet), `live` (someone is inside, or entering continues the entered run), or `none` (entering would
   * open a new, unpaid run).
   */
  private async paidRunState(
    queryable: Pick<pg.PoolClient, "query">,
    instanceId: string,
    dungeon: DungeonDefinition
  ): Promise<{ state: "none" | "pending" | "live"; runId: string | null; torchTotal: number | null }> {
    const result = await queryable.query<{ run_id: string; torch_total: number | null; party_size: number | null; occupied: boolean }>(
      `SELECT run.run_id::text, stats.torch_total, stats.party_size,
              EXISTS(SELECT 1 FROM dungeon_presence WHERE instance_id=$1) AS occupied
         FROM dungeon_instance_runs run
         LEFT JOIN dungeon_run_stats stats ON stats.run_id=run.run_id AND stats.ended_at IS NULL
        WHERE run.instance_id=$1`,
      [instanceId]
    );
    const row = result?.rows?.[0];
    if (!row) return { state: "none", runId: null, torchTotal: null };
    const torchTotal = row.torch_total === null || row.torch_total === undefined ? null : Number(row.torch_total);
    if (row.occupied) return { state: "live", runId: row.run_id, torchTotal };
    if (torchTotal === null) return { state: "none", runId: row.run_id, torchTotal };
    if (Number(row.party_size) === 0) return { state: "pending", runId: row.run_id, torchTotal };
    const continues = dungeon.reset.policy !== "when_empty" || this.instances.get(instanceId)?.runId === row.run_id;
    return { state: continues ? "live" : "none", runId: row.run_id, torchTotal };
  }

  /** The entry cost this player pays: the authored cost, or the Atlas Pass discount when it applies. */
  private async entryCostFor(
    queryable: Pick<pg.PoolClient, "query">,
    playerId: string,
    entryCost: NonNullable<NonNullable<DungeonDefinition["access"]>["entryCost"]>
  ): Promise<NonNullable<NonNullable<DungeonDefinition["access"]>["entryCost"]>> {
    return this.authorities.atlasPassEntryDiscount && await this.authorities.atlasPassEntryDiscount(queryable, playerId)
      ? atlasPassDungeonEntryCost(entryCost)
      : entryCost;
  }

  /** Personalize per-player entrance snapshots with the entry cost that player pays (one Pass lookup). */
  private async withPlayerEntryCosts(entrances: DungeonEntranceSnapshot[], playerId: string | undefined): Promise<DungeonEntranceSnapshot[]> {
    const priced = (entrance: DungeonEntranceSnapshot): boolean =>
      Boolean(entrance.access?.entryCost?.length) && entrance.developerSpawned !== true;
    // The shared Golem Forge is priced by its live boss count (before any Atlas Pass discount).
    entrances = await Promise.all(entrances.map(async (entrance) =>
      priced(entrance) && isGolemForge({ id: entrance.dungeonId })
        ? { ...entrance, access: { ...entrance.access, entryCost: golemForgeEntryCost(await this.forgeBossesAlive(
          this.pool, authoredInstanceId(entrance.entranceId, "shared_persistent", "", null))) } }
        : entrance));
    if (!playerId || !this.authorities.atlasPassEntryDiscount || !entrances.some(priced)) return entrances;
    if (!await this.authorities.atlasPassEntryDiscount(this.pool, playerId)) return entrances;
    return entrances.map((entrance) => priced(entrance)
      ? { ...entrance, access: { ...entrance.access, entryCost: atlasPassDungeonEntryCost(entrance.access!.entryCost!) } }
      : entrance);
  }

  private isLegacySewerEntrance(sewerId: string, dungeon: DungeonDefinition): boolean {
    return dungeon.id === this.dungeon.id && !this.catalog.entrances.some((entrance) => entrance.id === sewerId);
  }

  private async playerLevel(playerId: string): Promise<number> {
    const result = await this.pool.query<{ level: number | string }>(
      "SELECT level FROM player_progression_profiles WHERE player_id=$1", [playerId]
    );
    return Number(result.rows[0]?.level ?? 1);
  }

  async completeSession(
    playerId: string,
    sessionId: string,
    completionKey: string
  ): Promise<DungeonCompletion> {
    const session = this.requireSession(playerId, sessionId);
    return this.repeatLedger.recordCompletion({
      playerId,
      dungeonKey: cisternWarrensDungeonKey(session.sewerId),
      sessionIdentity: session.sessionId,
      completionKey
    });
  }

  /** Whether an authored cave entrance lies within `radiusM` of the position (world positions only). */
  isNearCaveEntrance(position: LatLon, radiusM: number): boolean {
    return this.catalog.entrances.some((entrance) =>
      !entrance.retired && entrance.presentation === "cave" && distanceMeters(position, entrance) <= radiusM
    );
  }

  /** World Map points for Deepstone Lore rank 1+: every live authored cave entrance, however far away. */
  caveLandmarks(): { id: string; name: string; lat: number; lon: number }[] {
    return this.catalog.entrances
      .filter((entrance) => !entrance.retired && entrance.presentation === "cave")
      .map((entrance) => ({ id: entrance.id, name: entrance.name, lat: entrance.lat, lon: entrance.lon }));
  }

  /** Whether any authored (catalog) dungeon entrance lies within `radiusM` of the position. */
  isNearDungeonEntrance(position: LatLon, radiusM: number): boolean {
    return this.catalog.entrances.some((entrance) => !entrance.retired && distanceMeters(position, entrance) <= radiusM);
  }

  async entrancesNear(
    position: LatLon,
    radiusM: number,
    playerId?: string
  ): Promise<DungeonEntranceSnapshot[]> {
    const result = await this.pool.query<EntranceRow>(
      `SELECT structure.structure_id::text, structure.city_id::text,
              city.name AS city_name, structure.region_code,
              structure.placement_revision::text,
              ST_Y(structure.geom)::double precision AS lat,
              ST_X(structure.geom)::double precision AS lon
       FROM city_structures structure
       JOIN cities city ON city.id=structure.city_id
       WHERE structure.structure_type='cistern_warrens'
         AND structure.state='active'
         AND ST_DWithin(
           structure.geom::geography,
           ST_SetSRID(ST_MakePoint($1,$2),4326)::geography,
           $3
         )
       ORDER BY ST_Distance(
         structure.geom::geography,
         ST_SetSRID(ST_MakePoint($1,$2),4326)::geography
       )`,
      [position.lon, position.lat, radiusM]
    );
    const authored = this.catalog.entrances.filter((entrance) =>
      !entrance.retired && distanceMeters(position, entrance) <= radiusM
    ).map((entrance) => ({
      ...entranceFromCatalog(entrance, this.catalog),
      ...(playerId ? { instanceId: authoredInstanceId(
        entrance.id,
        this.catalog.dungeons.find((candidate) => candidate.id === entrance.dungeonId)!.instancePolicy,
        playerId,
        this.authorities.partyIdForPlayer?.(playerId) ?? null
      ) } : {})
    }));
    const developer = this.developerSpawnedDungeons
      ? (await this.developerSpawnedDungeons.listActive())
        // The Fallen Prison is hunted: it is listed only once its smoke is in sight.
        .filter((placement) => distanceMeters(position, placement.position) <=
          (placement.eventKind === "fallen_prison_crash" ? Math.min(radiusM, FALLEN_PRISON_HUNT.smokeSightM) : radiusM))
        .map((placement) => {
          const entrance = this.developerSpawnedDungeons!.snapshotFor(placement);
          const dungeon = this.catalog.dungeons.find((candidate) => candidate.id === entrance.dungeonId);
          return {
            ...entrance,
            ...(playerId && dungeon ? { instanceId: authoredInstanceId(
              entrance.entranceId,
              dungeon.instancePolicy,
              playerId,
              this.authorities.partyIdForPlayer?.(playerId) ?? null
            ) } : {})
          };
        })
      : [];
    const drowned = (await this.authorities.drownedCitySitesNear?.(position, radiusM) ?? []).flatMap((siteId) => {
      const entranceId = drownedCityEntranceIdForSite(siteId);
      const found = entranceId ? drownedCityEntranceAt(this.catalog, entranceId) : null;
      if (!found) return [];
      const dungeon = this.catalog.dungeons.find((candidate) => candidate.id === found.entrance.dungeonId)!;
      return [{
        ...drownedCityEntranceSnapshot(this.catalog, found.entrance),
        ...(playerId ? { instanceId: authoredInstanceId(found.entrance.id, dungeon.instancePolicy, playerId,
          this.authorities.partyIdForPlayer?.(playerId) ?? null) } : {})
      }];
    });
    const forges = (await this.authorities.golemForgeSites?.sitesNear(position, radiusM).catch(() => []) ?? [])
      .flatMap((site) => {
        const snapshot = golemForgeEntranceSnapshot(this.catalog, site.entranceId, site.state);
        return snapshot ? [{ ...snapshot, ...(playerId
          ? { instanceId: authoredInstanceId(site.entranceId, "shared_persistent", playerId, null) } : {}) }] : [];
      });
    const rolled = (await this.authorities.worldDungeonEntrances?.sitesNear(position, radiusM).catch(() => []) ?? [])
      .flatMap((site) => {
        const snapshot = site.visible ? worldDungeonEntranceSnapshot(this.catalog, site.entranceId) : null;
        const dungeon = snapshot ? this.catalog.dungeons.find((candidate) => candidate.id === snapshot.dungeonId) : undefined;
        return snapshot && dungeon ? [{ ...snapshot, ...(playerId ? { instanceId: authoredInstanceId(site.entranceId,
          dungeon.instancePolicy, playerId, this.authorities.partyIdForPlayer?.(playerId) ?? null) } : {}) }] : [];
      });
    return this.withPlayerEntryCosts(
      [...result.rows.map(entranceFromRow), ...authored, ...developer, ...drowned, ...forges, ...rolled], playerId);
  }

  /**
   * `checkSiteSurface`: a Drowned City entrance also needs its site on coastal ocean right now (World
   * lookup, fail closed). World entry asks for it; a run already inside (enter after the authorized
   * commit, reconnect, completion) trusts the deterministic site so a World outage never strands it.
   */
  async entrance(sewerId: string, checkSiteSurface = false): Promise<DungeonEntranceSnapshot | null> {
    const authored = this.catalog.entrances.find((candidate) =>
      candidate.id === sewerId && !candidate.retired);
    if (authored) return entranceFromCatalog(authored, this.catalog);
    const drowned = drownedCityEntranceAt(this.catalog, sewerId);
    if (drowned) {
      if (checkSiteSurface && !await this.authorities.drownedCitySite?.(drowned.siteId)) return null;
      return drownedCityEntranceSnapshot(this.catalog, drowned.entrance);
    }
    // Rolled world entrances: world entry needs the entrance standing and visible now; a run already
    // inside trusts the deterministic id so an expiry or a World outage never strands it.
    const rolled = worldDungeonEntranceSnapshot(this.catalog, sewerId);
    if (rolled) {
      if (checkSiteSurface && (await this.authorities.worldDungeonEntrances?.siteForEntrance(sewerId))?.visible !== true) return null;
      return rolled;
    }
    // Golem Forge sites: whether the site is open is the entry gate's check (authorizeEntryGates).
    const forge = golemForgeEntranceSnapshot(this.catalog, sewerId);
    if (forge) return forge;
    if (this.developerSpawnedDungeons) {
      const placement = await this.developerSpawnedDungeons.find(sewerId, true);
      if (placement) return this.developerSpawnedDungeons.snapshotFor(placement);
    }
    const result = await this.pool.query<EntranceRow>(
      `SELECT structure.structure_id::text, structure.city_id::text,
              city.name AS city_name, structure.region_code,
              structure.placement_revision::text,
              ST_Y(structure.geom)::double precision AS lat,
              ST_X(structure.geom)::double precision AS lon
       FROM city_structures structure
       JOIN cities city ON city.id=structure.city_id
       WHERE structure.structure_id=$1::uuid
         AND structure.structure_type='cistern_warrens'
         AND structure.state='active'`,
      [sewerId]
    );
    return result.rows[0] ? entranceFromRow(result.rows[0]) : null;
  }

  get(playerId: string): DungeonSnapshot | null {
    const session = this.sessions.get(playerId);
    return session ? this.snapshot(session) : null;
  }

  authorizePortal(playerId: string, runtimePortalId: string): void {
    const session = this.sessions.get(playerId);
    if (!session) throw new DungeonError("SESSION_NOT_FOUND", "That dungeon session is no longer active.");
    const portalId = this.catalogPortalId(runtimePortalId, session.dungeon);
    const portal = session.dungeon.portals.find((candidate) => candidate.id === portalId && !candidate.retired);
    if (!portal || !portal.enabled) throw new DungeonError("PORTAL_UNAVAILABLE", "That dungeon portal is unavailable.");
    if (!this.portalAvailable(this.instance(session), portal, playerId)) {
      throw new DungeonError("PORTAL_LOCKED", "That dungeon portal is locked or its conditions are not met.");
    }
  }

  /** Refreshes production inventory/quest authority immediately before portal planning. */
  async refreshPortalAuthorities(playerId: string): Promise<void> {
    await this.refreshPlayerAuthorities(playerId);
  }

  portalUsed(playerId: string, runtimePortalId: string): void {
    const session = this.sessions.get(playerId);
    if (!session) return;
    this.dispatch(this.instance(session), {
      type: "portal_used", playerId, roomId: session.spaceId,
      portalId: this.catalogPortalId(runtimePortalId, session.dungeon)
    });
  }

  /** Shows an authored notice to one player (turn-in results) and returns their snapshot. */
  announceToPlayer(playerId: string, sessionId: string, text: string, tone: "info" | "success" | "warning"): DungeonSnapshot {
    const session = this.requireSession(playerId, sessionId);
    const instance = this.instance(session);
    this.withNoticeBatch(instance, () => {
      this.batch(instance).authored.push({ text, tone, audience: new Set([playerId]) });
    });
    return this.snapshot(session);
  }

  /** The player's current snapshot with no notice, for state changes the client presents itself (a looted chest). */
  snapshotForSession(playerId: string, sessionId: string): DungeonSnapshot {
    return this.snapshot(this.requireSession(playerId, sessionId));
  }

  /** Dungeon the player is currently inside, or null. */
  dungeonIdFor(playerId: string): string | null {
    return this.sessions.get(playerId)?.dungeon.id ?? null;
  }

  /** True while the player stands inside a `heal` zone (the Healing Spring) of their current room. */
  isInHealZone(playerId: string): boolean {
    const session = this.sessions.get(playerId);
    if (!session || !session.connected) return false;
    const room = this.roomDefinition(session.spaceId, session.dungeon);
    return room.zones.some((zone) => !zone.retired && zone.purpose === "heal" && pointInGeometry(session, zone));
  }

  /**
   * Validates an interaction with a skill turn-in object (available, in range) and returns the skill it
   * offers, or null when the object is an ordinary interactable.
   */
  skillTurnInFor(playerId: string, sessionId: string, objectId: string): DungeonTurnInId | null {
    const session = this.requireSession(playerId, sessionId);
    const room = this.roomDefinition(session.spaceId, session.dungeon);
    const object = room.objects.find((candidate) => candidate.id === objectId && !candidate.retired);
    if (!object?.skillTurnIn) return null;
    const instance = this.instance(session);
    if (instance.objectAvailability.get(objectKey(room.id, object.id)) !== true) {
      throw new DungeonError("OBJECT_UNAVAILABLE", "That dungeon object is unavailable.");
    }
    const anchor = dungeonAnchorDefinition(room, object.anchorId);
    if (Math.hypot(anchor.x - session.x, anchor.y - session.y) > object.interactionRadius) {
      throw new DungeonError("OUT_OF_RANGE", "Move closer to interact with that object.");
    }
    return object.skillTurnIn;
  }

  /**
   * A client-simulated Ash Heart puzzle was solved. The server owns the outcome: the player must be in the
   * puzzle room, must have spent at least the room's minimum time there (server clock), and the seal must
   * still be closed; then the seal's normal object_interact trigger opens the next door. Replays are idempotent.
   */
  puzzleSolve(playerId: string, sessionId: string, roomId: string, requestId: string): DungeonSnapshot {
    const session = this.requireSession(playerId, sessionId);
    const instance = this.instance(session);
    const room = this.roomDefinition(session.spaceId, session.dungeon);
    if (room.id !== roomId) throw new DungeonError("WRONG_ROOM", "That puzzle is not in this room.");
    const puzzle = heartPuzzleForRoom(session.dungeon.id, room.id);
    if (!puzzle) throw new DungeonError("NO_PUZZLE", "There is no puzzle in this room.");
    const key = objectKey(room.id, puzzle.sealObjectId);
    if (instance.objectStates.get(key) === "on") { // already solved
      session.heartPuzzle = null;
      return this.snapshot(session);
    }
    if (session.heartPuzzle?.roomId !== room.id) {
      return this.announceToPlayer(playerId, sessionId, "Talk to Old Pell to start the puzzle.", "warning");
    }
    const enteredAt = this.roomEnteredAt.get(`${playerId}:${room.id}`);
    const since = Math.max(enteredAt ?? this.now(), session.heartPuzzle.startedAt);
    const verdict = verifyHeartPuzzleSolve(session.dungeon.id, room.id, this.now() - since);
    if (!verdict.ok) {
      return this.announceToPlayer(playerId, sessionId, "The seal does not budge. Take your time with the stones.", "warning");
    }
    // The seal is shared: everyone at this room's board (a party member at Pell too) is released.
    for (const other of this.sessionsInInstance(session.instanceId)) {
      if (other.heartPuzzle?.roomId === room.id) other.heartPuzzle = null;
    }
    instance.objectStates.set(key, "on");
    this.dispatch(instance, { type: "object_interact", playerId, roomId: room.id, objectId: puzzle.sealObjectId, requestId });
    this.dispatch(instance, { type: "object_state", playerId, roomId: room.id, objectId: puzzle.sealObjectId, state: "on" });
    return this.snapshot(session);
  }

  /**
   * Start or quit the room's Ash Heart puzzle. Starting needs the seal still closed and the player standing by the
   * room's NPC (they talked to him); it stops them and locks movement until the solve or a quit. Both are idempotent.
   */
  puzzleSetActive(playerId: string, sessionId: string, roomId: string, active: boolean): DungeonSnapshot {
    const session = this.requireSession(playerId, sessionId);
    if (!active) {
      if (session.heartPuzzle) session.heartPuzzle = null;
      return this.snapshot(session);
    }
    const instance = this.instance(session);
    const room = this.roomDefinition(session.spaceId, session.dungeon);
    if (room.id !== roomId) throw new DungeonError("WRONG_ROOM", "That puzzle is not in this room.");
    const puzzle = heartPuzzleForRoom(session.dungeon.id, room.id);
    if (!puzzle) throw new DungeonError("NO_PUZZLE", "There is no puzzle in this room.");
    if (instance.objectStates.get(objectKey(room.id, puzzle.sealObjectId)) === "on") {
      throw new DungeonError("PUZZLE_SOLVED", "That seal is already open.");
    }
    if (session.heartPuzzle?.roomId === room.id) return this.snapshot(session);
    const npc = room.objects.find((candidate) => candidate.id === puzzle.npcObjectId && !candidate.retired);
    if (npc) {
      const anchor = dungeonAnchorDefinition(room, npc.anchorId);
      if (Math.hypot(anchor.x - session.x, anchor.y - session.y) > npc.interactionRadius + HEART_PUZZLE_START_SLACK) {
        throw new DungeonError("OUT_OF_RANGE", "Stand next to Old Pell to start.");
      }
    }
    this.routes.delete(playerId);
    this.combat.cancelPlayerAttackApproach?.(playerId);
    session.targetX = null;
    session.targetY = null;
    session.movementRevision += 1;
    session.heartPuzzle = { roomId: room.id, startedAt: this.now() };
    this.syncCombatPlayer(session);
    return this.snapshot(session);
  }

  /**
   * Developer only (the realtime handler checks the developer capability): puts the player's run of a
   * developer-placed dungeon back to its start - every object (seals, doors, chests), flag, trigger and encounter
   * as authored, completion cleared, everyone's puzzle lock released - and moves the player to the entry room's
   * spawn, so a finished dev run (the Tilted Vault with every seal on) can be replayed from scratch. Runs entered
   * from any player-facing entrance are refused.
   */
  async resetDeveloperRun(playerId: string): Promise<DungeonSnapshot> {
    const session = this.sessions.get(playerId);
    if (!session) throw new DungeonError("NOT_INSIDE", "Enter the dungeon from a developer entrance first.");
    if (!session.sewerId.startsWith(DEVELOPER_DUNGEON_ENTRANCE_PREFIX)) {
      throw new DungeonError("NOT_DEVELOPER_RUN", "Only a run entered from a developer entrance can be reset.");
    }
    const instance = this.instance(session);
    this.resetInstanceState(instance, null);
    // The authored reset rules may keep chests or doors between runs; a dev replay starts from nothing.
    for (const room of instance.dungeon.rooms) for (const object of room.objects.filter((candidate) => !candidate.retired)) {
      instance.objectStates.set(objectKey(room.id, object.id), object.initialState);
      instance.objectAvailability.set(objectKey(room.id, object.id),
        object.available && dungeonObjectSpawnsInRun(instance.dungeon, instance.runId, room.id, object));
    }
    instance.runStartedAt = null;
    instance.deathsByPlayer.set(playerId, 0);
    for (const other of this.sessionsInInstance(session.instanceId)) other.heartPuzzle = null;
    void this.persistInstanceState(instance).catch(() => undefined);
    const entry = instance.dungeon.portals.find((portal) =>
      !portal.retired && portal.source.kind !== "room" && portal.destination.kind === "room");
    const roomId = entry?.destination.kind === "room" ? entry.destination.roomId : instance.dungeon.rooms[0]!.id;
    const room = this.roomDefinition(roomId, instance.dungeon);
    const spawn = dungeonAnchorDefinition(room, room.spawnAnchorId);
    if (session.spaceId === roomId) {
      this.combat.cancelCombat(playerId);
      return this.transferSpace(playerId, session.sessionId, roomId, { x: spawn.x, y: spawn.y });
    }
    return await this.relocateWithinRun(session, "developer:reset-run", roomId, { x: spawn.x, y: spawn.y }) ??
      this.snapshot(session);
  }

  /**
   * The session's live puzzle lock. A lock whose room is no longer the player's, or whose seal is already open
   * (solved by a party member, or reset), ends here, so no path can leave a player locked at an open board.
   */
  private puzzleLock(session: SewerSession): SewerSession["heartPuzzle"] {
    const lock = session.heartPuzzle;
    if (!lock) return null;
    const puzzle = heartPuzzleForRoom(session.dungeon.id, lock.roomId);
    if (lock.roomId !== session.spaceId || !puzzle ||
        this.instance(session).objectStates.get(objectKey(lock.roomId, puzzle.sealObjectId)) === "on") {
      session.heartPuzzle = null;
      return null;
    }
    return lock;
  }

  private assertNotPuzzleLocked(session: SewerSession): void {
    if (this.puzzleLock(session)) {
      throw new DungeonError("PUZZLE_LOCKED", "You are at the puzzle. Solve it, or talk to Old Pell to give up.");
    }
  }

  private readonly lockedBoardNavigations = new Map<string, IndoorRoomNavigation>();

  /**
   * Player navigation for the session's room: in an Ash Heart puzzle room whose seal is still closed, the board's
   * wall cells are solid (holes are not); once the seal opens the player walks over the board freely.
   */
  private playerNavigation(session: SewerSession): IndoorRoomNavigation {
    const base = this.roomNavigation(session.spaceId, session.dungeon);
    const puzzle = heartPuzzleForRoom(session.dungeon.id, session.spaceId);
    if (!puzzle || this.instance(session).objectStates.get(objectKey(session.spaceId, puzzle.sealObjectId)) === "on") {
      return base;
    }
    const key = `${session.dungeon.id}:${session.spaceId}`;
    let navigation = this.lockedBoardNavigations.get(key);
    if (!navigation) {
      navigation = Object.freeze({ ...base, colliders: Object.freeze([...base.colliders, ...heartPuzzleBoardColliders(puzzle)]) });
      this.lockedBoardNavigations.set(key, navigation);
    }
    return navigation;
  }

  interact(playerId: string, sessionId: string, objectId: string, requestId: string): DungeonSnapshot {
    const session = this.requireSession(playerId, sessionId);
    const instance = this.instance(session);
    const interactionKey = `${playerId}:${requestId}`;
    const replay = instance.processedInteractions.get(interactionKey);
    if (replay) {
      if (replay.sessionId !== sessionId || replay.objectId !== objectId) {
        throw new DungeonError("REQUEST_ID_REUSED", "That request ID was already used for another dungeon interaction.");
      }
      return structuredClone(replay.snapshot);
    }
    const room = this.roomDefinition(session.spaceId, session.dungeon);
    const object = room.objects.find((candidate) => candidate.id === objectId && !candidate.retired);
    if (!object) throw new DungeonError("OBJECT_NOT_FOUND", "That dungeon object does not exist here.");
    if (instance.objectAvailability.get(objectKey(room.id, object.id)) !== true) {
      throw new DungeonError("OBJECT_UNAVAILABLE", "That dungeon object is unavailable.");
    }
    if (object.type === "portal") {
      throw new DungeonError("USE_PORTAL_REQUIRED", "Dungeon portals use the universal portal system.");
    }
    if (heartPuzzleForSeal(room.id, object.id)) {
      return this.announceToPlayer(playerId, sessionId, "The seal answers only to the puzzle on the floor.", "info");
    }
    const anchor = dungeonAnchorDefinition(room, object.anchorId);
    if (Math.hypot(anchor.x - session.x, anchor.y - session.y) > object.interactionRadius) {
      throw new DungeonError("OUT_OF_RANGE", "Move closer to interact with that object.");
    }
    if (object.type === "chest" && !this.bossChestCredited(instance, room.id, playerId)) {
      return this.announceToPlayer(playerId, sessionId, "Only those who fought this boss can open its chest.", "info");
    }
    const key = objectKey(room.id, object.id);
    const previous = instance.objectStates.get(key) ?? object.initialState;
    const hasDurableReward = object.type === "chest" && session.dungeon.triggers.some((trigger) =>
      !trigger.retired && trigger.event.type === "object_interact" &&
      trigger.event.roomId === room.id && trigger.event.objectId === object.id &&
      trigger.actions.some((action) => action.type === "grant_reward"));
    if (hasDurableReward) {
      const claimed = session.dungeon.triggers.some((trigger) =>
        !trigger.retired && trigger.event.type === "object_interact" &&
        trigger.event.roomId === room.id && trigger.event.objectId === object.id &&
        trigger.actions.some((action) => action.type === "grant_reward") &&
        instance.triggers.get(trigger.id)?.firedScopes.has(this.triggerScopeKey(trigger.scope, playerId) ?? "") === true);
      // A claimed reward chest stays interactable for party members, so say why nothing happens again.
      if (claimed) return this.announceToPlayer(playerId, sessionId, "You have already looted this chest.", "info");
    }
    // Reward-bearing chests are consumed only by their authored post-grant actions.
    // A capacity failure therefore leaves both the durable claim and chest available.
    const next = hasDurableReward ? previous : defaultInteractionState(object.type, previous);
    if (next !== previous) {
      instance.objectStates.set(key, next);
      if (object.type === "chest" && next === "looted") {
        instance.objectAvailability.set(key, false);
      }
    }
    this.dispatch(instance, { type: "object_interact", playerId, roomId: room.id, objectId, requestId });
    // A bespoke boss in this room may own the object (tide bombs, abyssal arms); replays never reach here.
    for (const boss of this.activeBossEncounters(instance, room.id)) boss.objectInteract(playerId, objectId);
    if (next !== previous) {
      this.dispatch(instance, { type: "object_state", playerId, roomId: room.id, objectId, state: next });
      if (next === "destroyed") {
        this.dispatch(instance, { type: "object_destroyed", playerId, roomId: room.id, objectId });
      }
    }
    const snapshot = this.snapshot(session);
    instance.processedInteractions.set(interactionKey, {
      sessionId, objectId, snapshot: structuredClone(snapshot)
    });
    while (instance.processedInteractions.size > MAX_DUNGEON_INTERACTION_REPLAYS) {
      const oldest = instance.processedInteractions.keys().next().value;
      if (oldest === undefined) break;
      instance.processedInteractions.delete(oldest);
    }
    return snapshot;
  }

  async harvestResource(
    playerId: string,
    sessionId: string,
    resourceId: string,
    requestId: string
  ): Promise<DungeonResourceHarvestResult> {
    const session = this.requireSession(playerId, sessionId);
    const instance = this.instance(session);
    const lockKey = `${this.instanceIdFor(instance)}:${instance.runId}:${resourceId}`;
    const prior = this.resourceHarvestTails.get(lockKey) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const tail = prior.then(() => current);
    this.resourceHarvestTails.set(lockKey, tail);
    await prior;
    try {
      return await this.harvestResourceLocked(playerId, sessionId, resourceId, requestId, session, instance);
    } finally {
      release();
      if (this.resourceHarvestTails.get(lockKey) === tail) this.resourceHarvestTails.delete(lockKey);
    }
  }

  private async harvestResourceLocked(
    playerId: string,
    sessionId: string,
    resourceId: string,
    requestId: string,
    session: SewerSession,
    instance: DungeonInstanceState
  ): Promise<DungeonResourceHarvestResult> {
    const interactionKey = `${playerId}:${requestId}`;
    const replay = instance.processedResourceHarvests.get(interactionKey);
    if (replay) {
      if (replay.sessionId !== sessionId || replay.resourceId !== resourceId) {
        throw new DungeonError("REQUEST_ID_REUSED", "That request ID was already used for another dungeon harvest.");
      }
      return {
        resourceId: replay.resourceId,
        resourceType: replay.resourceType,
        quantity: replay.quantity,
        snapshot: structuredClone(replay.snapshot)
      };
    }
    const resource = instance.resources.get(resourceId);
    if (!resource || resource.roomId !== session.spaceId) {
      throw new DungeonError("RESOURCE_NOT_FOUND", "That dungeon resource does not exist here.");
    }
    if (resource.state !== "available" || resource.quantity <= 0) {
      throw new DungeonError("RESOURCE_DEPLETED", "That resource node is depleted.");
    }
    if (Math.hypot(resource.x - session.x, resource.y - session.y) > resource.interactionRadius) {
      throw new DungeonError("OUT_OF_RANGE", "Move closer to harvest that resource.");
    }
    if (!this.authorities.harvestResource) {
      throw new DungeonError("RESOURCE_AUTHORITY_UNAVAILABLE", "Resource harvesting is temporarily unavailable.");
    }
    const requested = Math.max(1, Math.min(resource.quantity, randomYield(resource, instance.runId)));
    let granted: number | void;
    try {
      granted = await this.authorities.harvestResource(
        playerId,
        resource.resourceType,
        requested,
        {
          instanceId: this.instanceIdFor(instance),
          runId: instance.runId,
          dungeonId: instance.dungeon.id,
          resourceId,
          requestId
        }
      );
    } catch (error) {
      throw error instanceof DungeonError ? error :
        new DungeonError("RESOURCE_GRANT_FAILED", "The resource could not be added to your inventory.");
    }
    const quantity = granted === undefined ? requested : Math.min(requested, Math.floor(granted));
    if (!Number.isSafeInteger(quantity) || quantity <= 0) {
      throw new DungeonError("INVENTORY_FULL", "There is no room for that resource.");
    }
    resource.quantity = Math.max(0, resource.quantity - quantity);
    resource.state = resource.quantity > 0 ? "available" : "depleted";
    resource.lifeRevision += 1;
    resource.availableAt = resource.state === "depleted" && resource.respawnSeconds !== null
      ? this.now() + resource.respawnSeconds * 1_000
      : null;
    void this.persistResourceState(instance, resource).catch(() => undefined);
    const snapshot = this.snapshot(session);
    instance.processedResourceHarvests.set(interactionKey, {
      sessionId,
      resourceId,
      resourceType: resource.resourceType,
      quantity,
      snapshot: structuredClone(snapshot)
    });
    while (instance.processedResourceHarvests.size > MAX_DUNGEON_INTERACTION_REPLAYS) {
      const oldest = instance.processedResourceHarvests.keys().next().value;
      if (oldest === undefined) break;
      instance.processedResourceHarvests.delete(oldest);
    }
    return { resourceId, resourceType: resource.resourceType, quantity, snapshot };
  }

  /**
   * Validates a resource node for the overworld harvest flow: the player is in
   * the node's room, the node is ready and inside the overworld gather range.
   */
  resourceHarvestTarget(playerId: string, resourceId: string): DungeonResourceHarvestTarget {
    const session = this.sessions.get(playerId);
    if (!session) throw new DungeonError("SESSION_NOT_FOUND", "That dungeon session is no longer active.");
    const instance = this.instance(session);
    const resource = instance.resources.get(resourceId);
    if (!resource || resource.roomId !== session.spaceId) {
      throw new DungeonError("RESOURCE_NOT_FOUND", "That dungeon resource does not exist here.");
    }
    if (resource.state !== "available" || resource.quantity <= 0) {
      throw new DungeonError("RESOURCE_DEPLETED", "That resource node is depleted.");
    }
    const distanceM = dungeonLocalDistanceToCombatMeters(Math.hypot(resource.x - session.x, resource.y - session.y));
    if (distanceM > COLLECTIBLE_PICKUP_RADIUS_M) {
      throw new DungeonError("OUT_OF_RANGE", "Move closer to harvest that resource.");
    }
    return {
      instanceId: this.instanceIdFor(instance),
      runId: instance.runId,
      dungeonId: instance.dungeon.id,
      resourceId,
      resourceType: resource.resourceType,
      spaceId: resource.roomId,
      lifeRevision: resource.lifeRevision,
      position: dungeonLocalToCombatPosition(resource.x, resource.y),
      distanceM
    };
  }

  /**
   * Finishes a gather on a resource node. `settle` grants the reward (idempotent
   * on its own operation key) while the node is locked; the node then follows
   * its dungeon lifecycle: a gathered node stays depleted until the run ends (no
   * regeneration timer), except a mine kept ready by an unbroken vein.
   */
  async settleResourceHarvest<T>(input: Readonly<{
    playerId: string;
    resourceId: string;
    lifeRevision: number;
    keepReady: boolean;
    settle(target: DungeonResourceHarvestTarget): Promise<T>;
  }>): Promise<Readonly<{ result: T; snapshot: DungeonSnapshot }>> {
    const session = this.sessions.get(input.playerId);
    if (!session) throw new DungeonError("SESSION_NOT_FOUND", "That dungeon session is no longer active.");
    const instance = this.instance(session);
    const lockKey = `${this.instanceIdFor(instance)}:${instance.runId}:${input.resourceId}`;
    const prior = this.resourceHarvestTails.get(lockKey) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const tail = prior.then(() => current);
    this.resourceHarvestTails.set(lockKey, tail);
    await prior;
    try {
      const target = this.resourceHarvestTarget(input.playerId, input.resourceId);
      const resource = instance.resources.get(input.resourceId);
      if (!resource || resource.lifeRevision !== input.lifeRevision) {
        throw new DungeonError("RESOURCE_CHANGED", "That resource changed while you were gathering.");
      }
      const result = await input.settle(target);
      const rule = dungeonResourceRule(resource.resourceType, resource.id);
      resource.lifeRevision += 1;
      if (!(input.keepReady && rule.kind === "mine")) {
        resource.quantity = 0;
        resource.state = "depleted";
        resource.availableAt = rule.regenerationMs === null ? null : this.now() + rule.regenerationMs;
      }
      void this.persistResourceState(instance, resource).catch(() => undefined);
      return { result, snapshot: this.snapshot(session) };
    } finally {
      release();
      if (this.resourceHarvestTails.get(lockKey) === tail) this.resourceHarvestTails.delete(lockKey);
    }
  }

  isInside(playerId: string): boolean {
    return this.sessions.has(playerId);
  }

  /**
   * True when a death here respawns the player at the start of the room they died in (see respawnPlayer) instead of
   * recovering them out to the world. Run flags persist, so solved rooms stay solved; a wiped encounter resets.
   */
  respawnsInRoomOnDeath(playerId: string): boolean {
    const session = this.sessions.get(playerId);
    return session !== undefined && ROOM_RESPAWN_DUNGEON_IDS.has(session.dungeon.id);
  }

  /** The current dungeon run id of an inside player, else null. */
  runIdOf(playerId: string): string | null {
    return this.sessions.get(playerId)?.runId ?? null;
  }

  /** The Grove Hermit's clearing in Blightwood Grove, where the Hermit sells pets. */
  isAtGroveHermit(playerId: string): boolean {
    const session = this.sessions.get(playerId);
    return session?.dungeon.id === "blightwood_grove" && session.spaceId === "hermit_clearing";
  }

  canFightMob(playerId: string, mobEntityId: string): boolean {
    const session = this.sessions.get(playerId);
    if (!session?.connected) return false;
    const instance = this.instances.get(session.instanceId);
    // An encounter mob, or an add it summoned (a boss's kit adds, a Gate Warden's rift cultists).
    // Optional calls: lightweight combat test doubles predate summons.
    const summoner = this.combat.summonerOf?.(mobEntityId) ?? null;
    if (!instance || !instance.dungeon.encounters.some((definition) => {
      const encounter = instance.encounters.get(definition.id);
      if (definition.retired || definition.roomId !== session.spaceId || encounter?.state !== "active") return false;
      const owned = [...encounter.spawnedMobIds.values()];
      return owned.includes(mobEntityId) || (summoner !== null && owned.includes(summoner));
    })) return false;
    const player = this.combat.entity(playerId);
    const mob = this.combat.entity(mobEntityId);
    const regionCode = `interior:${session.instanceId}`;
    const zoneId = `${regionCode}:${session.spaceId}`;
    return player?.kind === "player" && mob?.kind === "mob" &&
      player.lifeState === "alive" && mob.lifeState === "alive" &&
      player.regionCode === regionCode && mob.regionCode === regionCode &&
      player.zoneId === zoneId && mob.zoneId === zoneId;
  }

  sessionsInSewer(sewerId: string): readonly SewerSession[] {
    return [...this.sessions.values()].filter((session) =>
      session.sewerId === sewerId && session.connected
    );
  }

  async hasDurableOccupants(sewerId: string, queryable: pg.Pool | pg.PoolClient = this.pool): Promise<boolean> {
    if (this.catalog.entrances.some((entrance) => entrance.id === sewerId && !entrance.retired) ||
        sewerId.startsWith(DEVELOPER_DUNGEON_ENTRANCE_PREFIX)) {
      const generic = await queryable.query<{ occupied: boolean }>(
        "SELECT EXISTS(SELECT 1 FROM dungeon_presence WHERE entrance_id=$1) AS occupied",
        [sewerId]
      );
      return generic.rows[0]?.occupied === true;
    }
    const result = await queryable.query<{ occupied: boolean }>(
      `SELECT EXISTS(
         SELECT 1 FROM cistern_warrens_presence WHERE sewer_structure_id=$1::uuid
       ) AS occupied`,
      [sewerId]
    );
    return result.rows[0]?.occupied === true;
  }

  async durableSewerId(playerId: string): Promise<string | null> {
    const result = await this.pool.query<{ sewer_structure_id: string }>(
      `SELECT sewer_structure_id::text FROM cistern_warrens_presence WHERE player_id=$1
       UNION ALL
       SELECT entrance_id FROM dungeon_presence WHERE player_id=$1
       LIMIT 1`,
      [playerId]
    );
    return result.rows[0]?.sewer_structure_id ?? null;
  }

  async discardStalePresence(playerId: string): Promise<void> {
    await Promise.all([
      this.pool.query("DELETE FROM cistern_warrens_presence WHERE player_id=$1", [playerId]),
      this.pool.query("DELETE FROM dungeon_presence WHERE player_id=$1", [playerId])
    ]);
    this.routes.delete(playerId);
    const session = this.sessions.get(playerId);
    if (!session) return;
    this.sessions.delete(playerId);
    this.notifyLeftRoom(playerId);
    const instance = this.instance(session);
    instance.zoneMembership.delete(playerId);
    this.recomputeAllPlayersPresent(instance, session.sewerId, playerId);
  }

  gameplayViewCircle(playerId: string) {
    const session = this.sessions.get(playerId);
    if (!session) return null;
    const room = this.roomDefinition(session.spaceId, session.dungeon);
    return {
      anchorType: "normal" as const,
      anchorId: session.instanceId,
      center: dungeonLocalToCombatPosition(room.width / 2, room.height / 2),
      // TODO(remove after the first deploy of the interior y-flip + DROPPED_ITEM_TTL_MS):
      // restore `Math.max(room.width, room.height)`. Twice the room extent also
      // reaches pre-flip dungeon drops, which storedDropLatitude reads mirrored
      // but which are still stored north of the room. Dungeon-only circle.
      radiusM: dungeonLocalDistanceToCombatMeters(Math.max(room.width, room.height) * 2),
      generation: 1,
      eligibleRegionCodes: [`interior:${session.instanceId}`],
      eligibleZoneIds: [`interior:${session.instanceId}:${session.spaceId}`]
    };
  }

  async enter(
    player: PlayerRecord,
    sewerId: string,
    canonical: CisternWarrensCanonicalTransform
  ): Promise<DungeonSnapshot> {
    if (this.sessions.has(player.playerId)) {
      throw new DungeonError("ALREADY_INSIDE", "You are already inside a dungeon.");
    }
    const entrance = await this.entrance(sewerId);
    if (!entrance) throw new DungeonError("DUNGEON_NOT_FOUND", "That dungeon no longer exists.");
    const legacySewer = canonical.locationType !== "dungeon";
    const dungeon = legacySewer ? this.dungeon :
      this.catalog.dungeons.find((candidate) => candidate.id === entrance.dungeonId && !candidate.retired);
    if (!dungeon) throw new DungeonError("DUNGEON_NOT_FOUND", "That dungeon definition is unavailable.");
    const instanceId = canonical.instanceId ?? (legacySewer
      ? `sewer:${sewerId}`
      : `dungeon:${sewerId}:player:${player.playerId}`);
    const room = this.roomNavigation(canonical.spaceId, dungeon);
    if (!isIndoorNavigationPointWalkable(room, canonical.position)) {
      throw new DungeonError("INVALID_POSITION", "The committed dungeon arrival is not walkable.");
    }
    const storedArrival = cisternWarrensIndoorPointToStored(canonical.position);
    const sessionId = randomUUID();
    let runId = this.execution.ephemeralRunId ?? instanceId;
    let enteredRunStartedAt: number | null = null;
    let paidTorchTotal: number | null = null;
    const entryCost = legacySewer || entrance.developerSpawned ? undefined : dungeon.access?.entryCost;
    // The shared Golem Forge: each entry consumes one paid admission (re-entry pays again in the lobby).
    const forge = !legacySewer && isGolemForge(dungeon);
    let forgeAdmission: { partyEntryId: string; torches: number } | null = null;
    if (!this.execution.ephemeralRunId) {
      // A paid run nobody entered in time is refunded first, so entry never lands in it.
      if (entryCost?.length && !forge) await this.expireStalePendingTorchRun(instanceId, dungeon.id);
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        if (!legacySewer) runId = await loadOrCreateDungeonRun(
          client,
          instanceId,
          dungeon.reset.policy === "when_empty" && !this.instances.has(instanceId)
        );
        const duplicate = await client.query(
          legacySewer
            ? "SELECT 1 FROM cistern_warrens_presence WHERE player_id=$1 FOR UPDATE"
            : "SELECT 1 FROM dungeon_presence WHERE player_id=$1 FOR UPDATE",
          [player.playerId]
        );
        if (duplicate.rowCount) throw new DungeonError("ALREADY_INSIDE", "You are already inside a dungeon.");
        // Torches are normally paid in the torch lobby (startTorchRun) before anyone enters: a paid run (or one
        // already under way) admits every member free. A plain enter into an unpaid, empty run (clients
        // without the lobby, solo taps, shared instances) burns one torch from the entrant instead, in this
        // transaction, idempotent on (run, player); the run then records torch_total=1.
        if (forge && entryCost?.length) {
          const admission = await client.query<{ party_entry_id: string; party_torch_total: number }>(
            `UPDATE dungeon_run_admissions SET entered_at=now()
              WHERE admission_id=(
                SELECT admission_id FROM dungeon_run_admissions
                 WHERE instance_id=$1 AND run_id=$2::uuid AND player_id=$3 AND entered_at IS NULL AND refunded_at IS NULL
                 ORDER BY created_at DESC LIMIT 1 FOR UPDATE)
              RETURNING party_entry_id::text, party_torch_total`,
            [instanceId, runId, player.playerId]
          );
          const row = admission?.rows?.[0];
          if (!row) throw torchesRequired(dungeon);
          forgeAdmission = { partyEntryId: row.party_entry_id, torches: Number(row.party_torch_total) };
        }
        if (!legacySewer) {
          const paid = await client.query<{ torch_total: number }>(
            "SELECT torch_total FROM dungeon_run_stats WHERE run_id=$1::uuid AND ended_at IS NULL", [runId]
          );
          paidTorchTotal = paid?.rows?.[0] ? Number(paid.rows[0].torch_total) : null;
          // The shared run's encounters spawn only the base set; each party's extra sets are its own.
          if (forge) paidTorchTotal = DUNGEON_TORCH_TOTAL_MIN;
        }
        if (entryCost?.length && paidTorchTotal === null && !forge) {
          const occupied = await client.query<{ occupied: boolean }>(
            "SELECT EXISTS(SELECT 1 FROM dungeon_presence WHERE instance_id=$1) AS occupied", [instanceId]
          );
          if (!occupied.rows[0]?.occupied) {
            if (!this.authorities.chargeEntryCost) throw torchesRequired(dungeon);
            const torchCost = await this.entryCostFor(client, player.playerId, entryCost);
            try {
              await this.authorities.chargeEntryCost(client, player.playerId, torchCost,
                { dungeonId: dungeon.id, instanceId, runId });
            } catch {
              throw new DungeonError("DUNGEON_ENTRY_COST_UNAFFORDABLE",
                `Entering ${dungeon.name} burns a torch (${describeDungeonEntryCost(torchCost)}).`);
            }
            paidTorchTotal = DUNGEON_TORCH_TOTAL_MIN;
          }
        }
        await client.query(legacySewer ? `INSERT INTO cistern_warrens_presence (
           player_id,sewer_structure_id,session_id,local_x,local_y,
           return_region_code,return_lat,return_lon
         ) VALUES ($1,$2::uuid,$3::uuid,$4,$5,$6,$7,$8)` : `INSERT INTO dungeon_presence (
           player_id,entrance_id,dungeon_id,instance_id,run_id,session_id,space_id,
           local_x,local_y,return_region_code,return_lat,return_lon
         ) VALUES ($1,$2,$9,$10,$12::uuid,$3::uuid,$11,$4,$5,$6,$7,$8)`,
          legacySewer
            ? [player.playerId, sewerId, sessionId, storedArrival.x, storedArrival.y,
                player.regionCode, player.position.lat, player.position.lon]
            : [player.playerId, sewerId, sessionId, canonical.position.x, canonical.position.y,
                player.regionCode, player.position.lat, player.position.lon,
                dungeon.id, instanceId, canonical.spaceId, runId]
        );
        if (!legacySewer) {
          enteredRunStartedAt = await recordDungeonRunEntry(client, {
            runId, instanceId, dungeonId: dungeon.id, tier: dungeon.tier?.id ?? null,
            torchTotal: this.torchTotalForRun(paidTorchTotal), playerId: player.playerId
          });
        }
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    }
    this.routes.delete(player.playerId);
    const session: SewerSession = {
      playerId: player.playerId,
      sessionId,
      sewerId,
      instanceId,
      runId,
      dungeon: this.runDungeon(dungeon, instanceId, runId),
      legacySewer,
      entrancePortalId: entrance.portalId,
      entrancePresentation: entrance.presentation,
      entranceAssetKey: entrance.assetKey,
      spaceId: canonical.spaceId,
      ...(entrance.cityId ? { cityId: entrance.cityId } : {}),
      ...(entrance.cityName ? { cityName: entrance.cityName } : {}),
      name: player.username,
      displayColor: player.displayColor,
      appearance: player.appearance ? structuredClone(player.appearance) : undefined,
      x: canonical.position.x,
      y: canonical.position.y,
      targetX: null,
      targetY: null,
      movementRevision: player.movementRevision + 1,
      lastPersistAt: this.now(),
      returnRegionCode: player.regionCode,
      returnLat: player.position.lat,
      returnLon: player.position.lon,
      connected: true,
      torchTotal: paidTorchTotal
    };
    this.sessions.set(player.playerId, session);
    const instance = this.instance(session);
    await this.hydrateInstance(instance);
    instance.runStartedAt ??= enteredRunStartedAt;
    if (forgeAdmission) {
      if (!instance.partyEntries.has(forgeAdmission.partyEntryId)) {
        instance.partyEntries.set(forgeAdmission.partyEntryId, { torches: forgeAdmission.torches, rooms: new Set() });
      }
      instance.playerPartyEntries.set(player.playerId, forgeAdmission.partyEntryId);
    }
    if (!instance.deathsByPlayer.has(player.playerId)) instance.deathsByPlayer.set(player.playerId, 0);
    await this.refreshPlayerAuthorities(player.playerId);
    instance.resetDeadline = null;
    this.dispatch(instance, { type: "room_enter", playerId: player.playerId, roomId: session.spaceId });
    this.spawnPartyTorchSets(instance, player.playerId, session.spaceId);
    this.dispatchPlayerCount(instance, player.playerId);
    this.syncCombatPlayer(session);
    this.updateZones(session, true);
    return this.snapshot(session);
  }

  async restore(
    player: PlayerRecord,
    canonical: CisternWarrensRestoreTransform
  ): Promise<DungeonSnapshot | null> {
    const entrance = await this.entrance(canonical.sewerId);
    const legacySewer = canonical.locationType !== "dungeon";
    const dungeon = legacySewer ? this.dungeon :
      this.catalog.dungeons.find((candidate) => candidate.id === entrance?.dungeonId && !candidate.retired);
    if (!entrance || !dungeon || !isCisternWarrensSpaceId(canonical.spaceId, dungeon)) {
      await this.discardStalePresence(player.playerId);
      return null;
    }
    cisternWarrensRoomDefinition(canonical.spaceId, dungeon);
    const result = await this.pool.query<{
      sewer_structure_id: string; session_id: string; local_x: number; local_y: number;
      return_region_code: string; return_lat: number; return_lon: number;
      instance_id?: string; dungeon_id?: string; run_id?: string; torch_total?: number | null;
    }>(
      legacySewer ? `SELECT sewer_structure_id::text,session_id::text,local_x,local_y,
              return_region_code,return_lat,return_lon
       FROM cistern_warrens_presence WHERE player_id=$1` :
      `SELECT entrance_id AS sewer_structure_id,session_id::text,local_x,local_y,
              return_region_code,return_lat,return_lon,instance_id,dungeon_id,run_id::text,
              (SELECT stats.torch_total FROM dungeon_run_stats stats
                WHERE stats.run_id=dungeon_presence.run_id) AS torch_total
       FROM dungeon_presence WHERE player_id=$1`,
      [player.playerId]
    );
    const row = result.rows[0];
    if (!row) return null;
    if (row.sewer_structure_id !== canonical.sewerId) {
      await this.discardStalePresence(player.playerId);
      return null;
    }
    if (!legacySewer && (row.instance_id !== canonical.instanceId || row.dungeon_id !== dungeon.id || !row.run_id)) {
      await this.discardStalePresence(player.playerId);
      return null;
    }
    this.routes.delete(player.playerId);
    const room = this.roomNavigation(canonical.spaceId, dungeon);
    const recovered = !isIndoorNavigationPointWalkable(room, canonical.position);
    if (recovered && !isIndoorNavigationPointWalkable(room, room.spawn)) {
      throw new Error("The canonical Cistern Warrens spawn must be walkable.");
    }
    const startingPosition = recovered ? room.spawn : canonical.position;
    const instanceId = canonical.instanceId ?? `sewer:${entrance.sewerId ?? entrance.entranceId}`;
    const runId = legacySewer ? instanceId : row.run_id!;
    const session: SewerSession = {
      playerId: player.playerId,
      sessionId: row.session_id,
      sewerId: entrance.sewerId ?? entrance.entranceId,
      instanceId,
      runId,
      dungeon: this.runDungeon(dungeon, instanceId, runId),
      legacySewer,
      entrancePortalId: entrance.portalId,
      entrancePresentation: entrance.presentation,
      entranceAssetKey: entrance.assetKey,
      spaceId: canonical.spaceId,
      ...(entrance.cityId ? { cityId: entrance.cityId } : {}),
      ...(entrance.cityName ? { cityName: entrance.cityName } : {}),
      name: player.username,
      displayColor: player.displayColor,
      appearance: player.appearance ? structuredClone(player.appearance) : undefined,
      x: startingPosition.x,
      y: startingPosition.y,
      targetX: null,
      targetY: null,
      movementRevision: player.movementRevision + 1,
      lastPersistAt: this.now(),
      returnRegionCode: row.return_region_code,
      returnLat: Number(row.return_lat),
      returnLon: Number(row.return_lon),
      connected: true,
      torchTotal: !legacySewer && row.torch_total !== null && row.torch_total !== undefined ? Number(row.torch_total) : null
    };
    if (recovered) {
      await this.persistPresencePosition(session);
      await this.playerLocations?.persistInteriorPosition({
        playerId: player.playerId,
        instanceId: session.instanceId,
        spaceId: session.spaceId,
        x: startingPosition.x,
        y: startingPosition.y
      });
    }
    this.sessions.set(player.playerId, session);
    const instance = this.instance(session);
    await this.hydrateInstance(instance);
    if (!instance.deathsByPlayer.has(player.playerId)) instance.deathsByPlayer.set(player.playerId, 0);
    await this.refreshPlayerAuthorities(player.playerId);
    instance.resetDeadline = null;
    this.dispatch(instance, { type: "room_enter", playerId: player.playerId, roomId: session.spaceId });
    this.dispatchPlayerCount(instance, player.playerId);
    this.grantMissedRunRewards(instance, player.playerId);
    this.syncCombatPlayer(session);
    this.updateZones(session, true);
    return this.snapshot(session);
  }

  async leave(playerId: string, sessionId: string | undefined, runtimePortalId?: string): Promise<{
    regionCode: string; lat: number; lon: number;
  } | null> {
    const session = this.sessions.get(playerId);
    if (!session) {
      await this.discardStalePresence(playerId);
      return null;
    }
    if (session.sessionId !== sessionId) {
      throw new DungeonError("SESSION_NOT_FOUND", "That dungeon session is no longer active.");
    }
    const instance = this.instance(session);
    const delversLoreRank = this.combat.generalSkillRank(playerId, "delvers_lore");
    if (!this.execution.ephemeralRunId) await this.pool.query(
      session.legacySewer
        ? "DELETE FROM cistern_warrens_presence WHERE player_id=$1 AND session_id=$2::uuid"
        : "DELETE FROM dungeon_presence WHERE player_id=$1 AND session_id=$2::uuid",
      [playerId, sessionId]
    );
    if (runtimePortalId) this.portalUsed(playerId, runtimePortalId);
    await this.recordEarlyLeaveLockout(instance, session, runtimePortalId);
    this.dispatch(instance, { type: "room_exit", playerId, roomId: session.spaceId });
    this.notifyLeftRoom(playerId);
    this.combat.cancelCombat(playerId);
    this.routes.delete(playerId);
    this.sessions.delete(playerId);
    this.authorities.releaseAllies?.(playerId);
    instance.zoneMembership.delete(playerId);
    this.recomputeAllPlayersPresent(instance, session.sewerId, playerId);
    this.dispatchPlayerCount(instance, playerId);
    await this.scheduleResetIfEmpty(session.sewerId, instance);
    if (delversLoreRank >= 1 && !instance.completed && !session.legacySewer && !this.execution.ephemeralRunId) {
      void Promise.resolve(this.authorities.onDungeonLeft?.({
        playerId, runId: session.runId, dungeonId: session.dungeon.id, instanceId: session.instanceId
      })).catch(() => undefined);
    }
    return {
      regionCode: session.returnRegionCode,
      lat: session.returnLat,
      lon: session.returnLon
    };
  }

  moveTo(playerId: string, sessionId: string, x: number, y: number): DungeonSnapshot {
    const session = this.requireSession(playerId, sessionId);
    this.assertNotPuzzleLocked(session);
    const room = this.roomNavigation(session.spaceId, session.dungeon);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw new DungeonError("INVALID_POSITION", "Invalid dungeon position.");
    }
    if (
      x < room.playerRadius || y < room.playerRadius ||
      x > room.roomWidth - room.playerRadius || y > room.roomHeight - room.playerRadius
    ) {
      throw new DungeonError("OUT_OF_BOUNDS", "That target is outside the dungeon floor.");
    }
    if (Math.hypot(x - session.x, y - session.y) > CISTERN_WARRENS_MAX_TARGET_DISTANCE) {
      throw new DungeonError("INVALID_POSITION", "That dungeon destination is too far away.");
    }
    this.combat.cancelPlayerAttackApproach?.(playerId);
    this.installRoute(session, { x, y });
    return this.snapshot(session);
  }

  transferSpace(
    playerId: string,
    sessionId: string,
    spaceId: string,
    position: { x: number; y: number },
    runtimePortalId?: string
  ): DungeonSnapshot {
    const session = this.requireSession(playerId, sessionId);
    const room = this.roomNavigation(spaceId, session.dungeon);
    if (!isIndoorNavigationPointWalkable(room, position)) {
      throw new DungeonError("INVALID_POSITION", "The committed dungeon arrival is not walkable.");
    }
    const instance = this.instance(session);
    const previousRoomId = session.spaceId;
    session.heartPuzzle = null;
    this.routes.delete(playerId);
    session.spaceId = spaceId;
    session.x = position.x;
    session.y = position.y;
    session.targetX = null;
    session.targetY = null;
    session.movementRevision += 1;
    this.dispatch(instance, { type: "room_exit", playerId, roomId: previousRoomId });
    this.notifyLeftRoom(playerId);
    if (runtimePortalId) this.portalUsed(playerId, runtimePortalId);
    this.dispatch(instance, { type: "room_enter", playerId, roomId: spaceId });
    this.spawnPartyTorchSets(instance, playerId, spaceId);
    this.syncCombatPlayer(session);
    this.updateZones(session, true);
    this.unstickPlayer(session);
    return this.snapshot(session);
  }

  stop(playerId: string): void {
    this.routes.delete(playerId);
    const session = this.sessions.get(playerId);
    if (!session) return;
    session.targetX = null;
    session.targetY = null;
    session.movementRevision += 1;
    this.syncCombatPlayer(session);
  }

  /** Dash state per player (server clock ms): cooldown, i-frame window and landing time. */
  private readonly dashStates = new Map<string, Readonly<{ untilMs: number; cooldownUntilMs: number; iframeUntilMs: number }>>();

  /** Dash i-frames, honoured by every damage path through the combat engine's `isEntityInvulnerable` hook. */
  isDashInvulnerable(playerId: string): boolean {
    const state = this.dashStates.get(playerId);
    return state !== undefined && this.now() < state.iframeUntilMs;
  }

  /** True while the dash itself is in flight (a swing pressed now waits for the landing). */
  isDashing(playerId: string): boolean {
    const state = this.dashStates.get(playerId);
    return state !== undefined && this.now() < state.untilMs;
  }

  /**
   * Action-combat dash inside a run: the overworld dash distance, cooldown and i-frames, clamped by the room's
   * walls, fixtures and floor polygons. The server owns the landing point; the player is placed there at once and the
   * client animates the 150 ms travel from DASH_ACCEPTED.
   */
  dash(playerId: string, dirX: number, dirY: number): Readonly<{
    movementRevision: number;
    fromLocal: IndoorPoint;
    toLocal: IndoorPoint;
    from: LatLon;
    to: LatLon;
    startedAtMs: number;
    untilMs: number;
    cooldownUntilMs: number;
    iframeUntilMs: number;
  }> {
    const session = this.sessions.get(playerId);
    if (!session || !session.connected) throw new DungeonError("NOT_IN_DUNGEON", "You are not inside a dungeon.");
    if (!this.combat.isPlayerAlive(playerId)) throw new DungeonError("DASH_REJECTED", "You can't dash while incapacitated.");
    const length = Math.hypot(dirX, dirY);
    if (!Number.isFinite(length) || length < 1e-6) throw new DungeonError("DASH_REJECTED", "Invalid dash direction.");
    const nowMs = this.now();
    const previous = this.dashStates.get(playerId);
    if (previous && nowMs < previous.cooldownUntilMs) throw new DungeonError("DASH_REJECTED", "Dash is on cooldown.");
    if (this.puzzleLock(session)) throw new DungeonError("DASH_REJECTED", "You are at the puzzle.");
    const room = this.playerNavigation(session);
    const unitM = dungeonLocalDistanceToCombatMeters(1);
    const maxUnits = DASH_DISTANCE_M / unitM;
    // Local axes are y-down; the client sends screen-style (east, south) components, like the overworld sends (east, north).
    const ux = dirX / length;
    const uy = -dirY / length;
    const from = { x: session.x, y: session.y };
    const full = {
      x: clamp(from.x + ux * maxUnits, room.playerRadius, room.roomWidth - room.playerRadius),
      y: clamp(from.y + uy * maxUnits, room.playerRadius, room.roomHeight - room.playerRadius)
    };
    const reaches = (t: number): boolean => {
      const point = { x: from.x + (full.x - from.x) * t, y: from.y + (full.y - from.y) * t };
      return isIndoorNavigationPointWalkable(room, point) && isIndoorNavigationSegmentWalkable(room, from, point);
    };
    let to = full;
    if (!reaches(1)) {
      let low = 0;
      let high = 1;
      for (let step = 0; step < 14; step += 1) {
        const mid = (low + high) / 2;
        if (reaches(mid)) low = mid; else high = mid;
      }
      to = { x: from.x + (full.x - from.x) * low, y: from.y + (full.y - from.y) * low };
    }
    this.routes.delete(playerId);
    this.combat.cancelPlayerAttackApproach?.(playerId);
    this.combat.notePlayerDashed(playerId);
    session.x = to.x;
    session.y = to.y;
    session.targetX = null;
    session.targetY = null;
    session.movementRevision += 1;
    this.syncCombatPlayer(session);
    this.updateZones(session);
    const state = {
      untilMs: nowMs + DASH_DURATION_MS,
      cooldownUntilMs: nowMs + DASH_COOLDOWN_MS,
      iframeUntilMs: nowMs + DASH_IFRAME_MS
    };
    this.dashStates.set(playerId, state);
    return {
      movementRevision: session.movementRevision,
      fromLocal: from,
      toLocal: { x: to.x, y: to.y },
      from: dungeonLocalToCombatPosition(from.x, from.y),
      to: dungeonLocalToCombatPosition(to.x, to.y),
      startedAtMs: nowMs,
      ...state
    };
  }

  respawnPlayer(playerId: string): LatLon | void {
    const session = this.sessions.get(playerId);
    if (!session) return;
    this.routes.delete(playerId);
    session.heartPuzzle = null;
    const spawn = this.roomNavigation(session.spaceId, session.dungeon).spawn;
    session.x = spawn.x;
    session.y = spawn.y;
    session.targetX = null;
    session.targetY = null;
    session.movementRevision += 1;
    void this.persistPresencePosition(session).catch(() => undefined);
    void this.playerLocations?.persistInteriorPosition({
      playerId,
      instanceId: session.instanceId,
      spaceId: session.spaceId,
      x: spawn.x,
      y: spawn.y
    }).catch(() => undefined);
    // Arriving back at the room start is a fresh entry: its start zone fires again (a wiped fight wakes back up).
    this.instance(session).zoneMembership.delete(playerId);
    this.updateZones(session, true);
    return dungeonLocalToCombatPosition(session.x, session.y);
  }

  setCombatTarget(playerId: string, target: LatLon): void {
    const session = this.sessions.get(playerId);
    if (!session || this.puzzleLock(session)) return;
    const local = combatPositionToDungeonLocal(target);
    const room = this.roomNavigation(session.spaceId, session.dungeon);
    const point = {
      x: clamp(local.x, room.playerRadius, room.roomWidth - room.playerRadius),
      y: clamp(local.y, room.playerRadius, room.roomHeight - room.playerRadius)
    };
    this.installRoute(session, point);
  }

  repositionCombatPlayer(playerId: string, target: LatLon, maximumDistanceM = 120, requireClearPath = false): boolean {
    const session = this.sessions.get(playerId);
    if (!session || this.puzzleLock(session) || !Number.isFinite(target.lat) || !Number.isFinite(target.lon)) return false;
    const current = dungeonLocalToCombatPosition(session.x, session.y);
    const local = combatPositionToDungeonLocal(target);
    const room = this.playerNavigation(session);
    if (
      distanceMeters(current, target) > maximumDistanceM ||
      !isIndoorNavigationPointWalkable(room, local)
    ) return false;
    if (requireClearPath && !isIndoorNavigationSegmentWalkable(room, { x: session.x, y: session.y }, local)) return false;
    this.routes.delete(playerId);
    session.x = local.x;
    session.y = local.y;
    session.targetX = null;
    session.targetY = null;
    session.movementRevision += 1;
    this.syncCombatPlayer(session);
    this.updateZones(session);
    return true;
  }

  suspend(playerId: string): void {
    const session = this.sessions.get(playerId);
    if (!session) return;
    this.routes.delete(playerId);
    // Reconnect policy: an active puzzle ends with the connection (reset and unlocked), never a stuck lock.
    session.heartPuzzle = null;
    session.connected = false;
    session.targetX = null;
    session.targetY = null;
    this.combat.cancelCombat(playerId);
    this.recomputeAllPlayersPresent(this.instance(session), session.sewerId, playerId);
  }

  async detachRuntime(playerId: string): Promise<void> {
    const session = this.sessions.get(playerId);
    if (!session) return;
    this.routes.delete(playerId);
    const presencePersistence = this.persistPresencePosition(session);
    const locationPersistence = this.playerLocations?.persistInteriorPosition({
      playerId,
      instanceId: session.instanceId,
      spaceId: session.spaceId,
      x: session.x,
      y: session.y
    });
    await Promise.all(locationPersistence
      ? [presencePersistence, locationPersistence]
      : [presencePersistence]);
    this.sessions.delete(playerId);
    const instance = this.instance(session);
    instance.zoneMembership.delete(playerId);
    this.recomputeAllPlayersPresent(instance, session.sewerId, playerId);
  }

  async tick(
    deltaSeconds: number,
    options: Readonly<{ movementAlreadyAdvanced?: boolean }> = {}
  ): Promise<void> {
    if (!options.movementAlreadyAdvanced) this.advanceMovement(deltaSeconds);
    await this.tickSystems();
  }

  /** Advances dungeon movement in the same pre-combat phase as world movement. */
  advanceMovement(deltaSeconds: number): void {
    for (const session of this.sessions.values()) {
      this.unstickPlayer(session);
      if (session.connected && !this.combat.isPlayerReserved(session.playerId)) {
        this.advancePlayer(session, deltaSeconds);
      }
    }
  }

  /**
   * Nobody stays frozen inside a solid spot. In an Ash Heart puzzle dungeon a player whose feet are not on
   * walkable floor (inside an unsolved board, off the floor polygon, an arrival that landed in a wall) is moved to
   * the nearest walkable point of the room, or to the room's start when none is near, and their route is dropped.
   * Returns true when the player was moved.
   */
  private unstickPlayer(session: SewerSession): boolean {
    if (!HEART_PUZZLES.some((puzzle) => puzzle.dungeonId === session.dungeon.id)) return false;
    const navigation = this.playerNavigation(session);
    if (isIndoorNavigationPointWalkable(navigation, session)) return false;
    let best: IndoorPoint | null = null;
    for (let radius = 6; radius <= 700 && !best; radius += 6) {
      const steps = Math.max(8, Math.ceil(radius / 4));
      for (let i = 0; i < steps && !best; i += 1) {
        const angle = (i / steps) * Math.PI * 2;
        const point = { x: session.x + Math.cos(angle) * radius, y: session.y + Math.sin(angle) * radius };
        if (isIndoorNavigationPointWalkable(navigation, point)) best = point;
      }
    }
    if (!best) {
      const room = this.roomDefinition(session.spaceId, session.dungeon);
      const spawn = dungeonAnchorDefinition(room, room.spawnAnchorId);
      best = { x: spawn.x, y: spawn.y };
    }
    console.warn(`[dungeon] unstuck player=${session.playerId} room=${session.spaceId} ` +
      `from=${Math.round(session.x)},${Math.round(session.y)} to=${Math.round(best.x)},${Math.round(best.y)}`);
    this.routes.delete(session.playerId);
    session.x = best.x;
    session.y = best.y;
    session.targetX = null;
    session.targetY = null;
    session.movementRevision += 1;
    this.syncCombatPlayer(session);
    this.updateZones(session);
    return true;
  }

  private async tickSystems(): Promise<void> {
    const now = this.now();
    const liveDamageZoneClocks = new Set<string>();
    this.sweepStalePendingTorchRuns(now);
    this.sweepGolemForges(now);
    for (const [instanceId, instance] of this.instances) {
      this.respawnResources(instance, now);
      for (const [triggerId, state] of instance.triggers) {
        if (state.timerDueAt !== null && state.timerDueAt <= now) {
          state.timerDueAt = null;
          const trigger = instance.dungeon.triggers.find((candidate) => candidate.id === triggerId);
          if (trigger?.scope === "instance") {
            this.dispatch(instance, { type: "timer", objectId: triggerId });
          } else {
            const seen = new Set<string>();
            for (const session of this.sessionsInInstance(instanceId).filter((candidate) => candidate.connected)) {
              const scopeKey = trigger ? this.triggerScopeKey(trigger.scope, session.playerId) : null;
              if (!scopeKey || seen.has(scopeKey)) continue;
              seen.add(scopeKey);
              this.dispatch(instance, { type: "timer", objectId: triggerId, playerId: session.playerId });
            }
          }
          if (trigger?.event.type === "timer" && trigger.repetition !== "once") {
            state.timerDueAt = this.now() + trigger.event.delayMs;
          }
        }
      }
      this.tickDamageZones(instanceId, instance, now, liveDamageZoneClocks);
      this.tickElites(instance, now);
      this.pollEncounters(instanceId, instance, now);
      if (instance.resetDeadline !== null && instance.resetDeadline <= now) {
        await this.resetInstance(instanceId, instance);
      }
      if (now - instance.lastStatePersistAt >= 1_000) {
        instance.lastStatePersistAt = now;
        void this.persistInstanceState(instance).catch(() => undefined);
      }
    }
    for (const key of [...this.damageZoneClocks.keys()]) {
      if (!liveDamageZoneClocks.has(key)) this.damageZoneClocks.delete(key);
    }
  }

  /**
   * `damage` zones are timed hazards (the Ember Tunnels lava vents): while a player is in the room each
   * zone erupts on a staggered cycle as a telegraphed burning combat hazard.
   */
  private tickDamageZones(instanceId: string, instance: DungeonInstanceState, now: number, live: Set<string>): void {
    const occupied = new Set(this.sessionsInInstance(instanceId)
      .filter((session) => session.connected)
      .map((session) => session.spaceId));
    for (const room of instance.dungeon.rooms) {
      if (!occupied.has(room.id)) continue;
      const zones = room.zones.filter((zone) => !zone.retired && zone.purpose === "damage");
      if (zones.length === 0) continue;
      const key = `${instanceId}:${room.id}`;
      live.add(key);
      let clock = this.damageZoneClocks.get(key);
      if (!clock) {
        clock = { wokeAt: now, last: new Map() };
        this.damageZoneClocks.set(key, clock);
      }
      zones.forEach((zone, index) => {
        if (!lavaVentDue(now, clock!.wokeAt, index, clock!.last.get(zone.id))) return;
        clock!.last.set(zone.id, now);
        const points = zone.kind === "rectangle"
          ? [{ x: zone.x, y: zone.y }, { x: zone.x + zone.width, y: zone.y + zone.height }]
          : zone.points;
        const xs = points.map((point) => point.x);
        const ys = points.map((point) => point.y);
        const minX = Math.min(...xs); const maxX = Math.max(...xs);
        const minY = Math.min(...ys); const maxY = Math.max(...ys);
        this.combat.spawnRoomHazard({
          zoneId: `interior:${instanceId}:${room.id}`,
          hazardId: `${instanceId}:${room.id}:${zone.id}`,
          center: dungeonLocalToCombatPosition((minX + maxX) / 2, (minY + maxY) / 2),
          radiusM: dungeonLocalDistanceToCombatMeters(Math.min(maxX - minX, maxY - minY) / 2),
          delayMs: LAVA_VENT.telegraphMs,
          durationMs: LAVA_VENT.eruptionMs,
          damage: LAVA_VENT.tickDamage,
          techniqueId: LAVA_VENT.techniqueId
        });
      });
    }
  }

  snapshotForPlayer(playerId: string): DungeonSnapshot | null {
    return this.get(playerId);
  }

  activeSnapshots(): readonly Readonly<{ playerId: string; snapshot: DungeonSnapshotUpdate }>[] {
    return [...this.sessions.values()].filter((session) => session.connected).map((session) => ({
      playerId: session.playerId,
      snapshot: this.updateSnapshot(session)
    }));
  }

  private advancePlayer(session: SewerSession, deltaSeconds: number): void {
    if (session.targetX === null || session.targetY === null) return;
    let remainingStep = Math.max(0, Math.min(0.25, deltaSeconds)) *
      this.playerMovementSpeed(session.playerId);
    let waypointX: number | null = session.targetX;
    let waypointY: number | null = session.targetY;
    while (waypointX !== null && waypointY !== null) {
      const waypointDistance = Math.hypot(waypointX - session.x, waypointY - session.y);
      const advanced = advanceIndoorVector(session, { x: waypointX, y: waypointY }, remainingStep);
      session.x = advanced.x;
      session.y = advanced.y;
      if (!advanced.arrived) break;
      remainingStep = Math.max(0, remainingStep - waypointDistance);
      const route = this.routes.get(session.playerId);
      const next = route?.shift();
      if (next) {
        if (route?.length === 0) this.routes.delete(session.playerId);
        session.targetX = next.x;
        session.targetY = next.y;
        waypointX = next.x;
        waypointY = next.y;
        if (remainingStep > 0 || waypointDistance === 0) continue;
        break;
      }
      this.routes.delete(session.playerId);
      session.targetX = null;
      session.targetY = null;
      waypointX = null;
      waypointY = null;
    }
    session.movementRevision += 1;
    this.syncCombatPlayer(session);
    this.updateZones(session);
    const now = this.now();
    if (now - session.lastPersistAt >= 1_000 || session.targetX === null) {
      session.lastPersistAt = now;
      void this.persistPresencePosition(session).catch(() => undefined);
      void this.playerLocations?.persistInteriorPosition({
        playerId: session.playerId,
        instanceId: session.instanceId,
        spaceId: session.spaceId,
        x: session.x,
        y: session.y
      }).catch(() => undefined);
    }
  }

  private syncCombatPlayer(session: SewerSession): void {
    this.combat.syncPlayer({
      playerId: session.playerId,
      position: dungeonLocalToCombatPosition(session.x, session.y),
      regionCode: `interior:${session.instanceId}`,
      zoneId: `interior:${session.instanceId}:${session.spaceId}`,
      name: session.name
    });
  }

  private installRoute(session: SewerSession, target: IndoorPoint): void {
    const locked = this.playerNavigation(session);
    // A player already standing inside a board wall (from before the walls were solid) may walk out of it.
    const room = isIndoorNavigationPointWalkable(locked, session) ? locked : this.roomNavigation(session.spaceId, session.dungeon);
    if (!isIndoorNavigationPointWalkable(room, target)) {
      throw new DungeonError("BLOCKED_TARGET", "That target is blocked by a dungeon fixture.");
    }
    const route = findIndoorNavigationRoute(room, session, target);
    if (!route?.[0]) {
      throw new DungeonError("INVALID_POSITION", "No collision-free route is available.");
    }
    const [waypoint, ...remaining] = route;
    if (remaining.length > 0) this.routes.set(session.playerId, remaining);
    else this.routes.delete(session.playerId);
    session.targetX = waypoint.x;
    session.targetY = waypoint.y;
    session.movementRevision += 1;
  }

  private snapshot(session: SewerSession): DungeonSnapshot {
    const room = this.roomDefinition(session.spaceId, session.dungeon);
    const instance = this.instance(session);
    // Torch sets above the run's total never spawn; their placements stay in the run (stable ids) but
    // are not sent.
    // Floors stay server-side (movement authority); the snapshot room keeps its published wire shape.
    const { floors: _floors, ...wireRoom } = room;
    const sent = structuredClone({ ...wireRoom, mobs: room.mobs.filter((placement) => torchSetSpawns(placement, instance)) });
    return {
      ...this.commonSnapshot(session),
      snapshotKind: "full",
      room: sent,
      prefabs: this.catalog.prefabs
        .filter((prefab) => !prefab.retired)
        .map((prefab) => structuredClone(prefab))
    };
  }

  private persistPresencePosition(session: SewerSession): Promise<pg.QueryResult> {
    if (this.execution.ephemeralRunId) return Promise.resolve({ command: "", fields: [], oid: 0, rows: [], rowCount: 0 });
    const position = session.legacySewer ? cisternWarrensIndoorPointToStored(session) : session;
    return this.pool.query(
      session.legacySewer
        ? `UPDATE cistern_warrens_presence SET local_x=$2,local_y=$3,updated_at=now() WHERE player_id=$1`
        : `UPDATE dungeon_presence SET local_x=$2,local_y=$3,space_id=$4,updated_at=now() WHERE player_id=$1`,
      session.legacySewer
        ? [session.playerId, position.x, position.y]
        : [session.playerId, position.x, position.y, session.spaceId]
    );
  }

  private commonSnapshot(session: SewerSession): DungeonSnapshotCommon {
    const room = this.roomDefinition(session.spaceId, session.dungeon);
    const instance = this.instance(session);
    this.syncDungeonBossParticipants(instance);
    const enemies = this.enemies(session, instance);
    return {
      catalogRevision: this.catalog.catalogRevision,
      sceneRevision: dungeonSceneRevision(
        this.catalog.catalogRevision,
        session.dungeon.revision,
        session.spaceId
      ),
      dungeonId: session.dungeon.id,
      dungeonRevision: session.dungeon.revision,
      instancePolicy: session.dungeon.instancePolicy,
      entranceId: session.sewerId,
      name: session.dungeon.name,
      description: session.dungeon.description,
      portalId: session.entrancePortalId,
      presentation: session.entrancePresentation,
      assetKey: session.entranceAssetKey,
      ...(session.legacySewer ? { sewerId: session.sewerId } : {}),
      ...(session.cityId ? { cityId: session.cityId } : {}),
      ...(session.cityName ? { cityName: session.cityName } : {}),
      sessionId: session.sessionId,
      instanceId: session.instanceId,
      spaceId: session.spaceId,
      roomWidth: room.width,
      roomHeight: room.height,
      playerVisualHeight: CISTERN_WARRENS_PLAYER_VISUAL_HEIGHT_UNITS,
      camera: structuredClone(room.camera),
      environment: {
        ...structuredClone(session.dungeon.environment),
        ...structuredClone(room.environment)
      },
      player: this.playerSnapshot(session),
      occupants: this.sessionsInInstance(session.instanceId)
        .filter((occupant) => occupant.spaceId === session.spaceId)
        .map((occupant) => this.playerSnapshot(occupant)),
      enemies,
      objects: this.objects(session),
      resources: this.resources(session),
      telegraphs: this.snapshotTelegraphs(session, enemies),
      encounters: [...instance.encounters].map(([id, encounter]) => ({
        id, state: encounter.state, currentWaveId: encounter.currentWaveId, attempts: encounter.attempts
      })),
      triggers: [...instance.triggers].map(([id, trigger]) => ({
        id, enabled: trigger.enabled, firedCount: trigger.firedCount,
        cooldownUntil: trigger.cooldowns.size > 0 ? Math.max(...trigger.cooldowns.values()) : null
      })),
      dungeonFlags: Object.fromEntries(instance.flags),
      portalLocks: Object.fromEntries([...instance.portalLocks].map(([portalId, locked]) => [
        this.runtimePortalId(session, portalId),
        locked
      ])),
      completed: instance.completed,
      cues: [...instance.cues],
      notices: instance.notices
        .filter((notice) => !notice.audience || notice.audience.has(session.playerId))
        .map(({ id, text, tone }) => ({ id, text, tone })),
      resetDeadline: instance.resetDeadline,
      runStartedAt: instance.runStartedAt,
      partyDeaths: [...instance.deathsByPlayer.values()].reduce((sum, deaths) => sum + deaths, 0),
      heartPuzzleActiveRoomId: this.puzzleLock(session)?.roomId ?? null,
      status: session.dungeon.description,
      serverTime: this.now()
    };
  }

  private updateSnapshot(session: SewerSession): DungeonSnapshotUpdate {
    return { ...this.commonSnapshot(session), snapshotKind: "update" };
  }

  private playerSnapshot(session: SewerSession): DungeonPlayerSnapshot {
    const entity = this.combat.entity(session.playerId);
    const appearance = this.authorities.appearanceForPlayer?.(session.playerId) ??
      session.appearance;
    return {
      playerId: session.playerId,
      name: session.name,
      displayColor: session.displayColor,
      ...(appearance ? { appearance: structuredClone(appearance) } : {}),
      x: session.x,
      y: session.y,
      targetX: session.targetX,
      targetY: session.targetY,
      targetEntityId: entity?.targetEntityId ?? null,
      movementSpeed: this.playerMovementSpeed(session.playerId),
      movementRevision: session.movementRevision,
      currentHealth: entity?.currentHealth ?? 0,
      maxHealth: entity?.maxHealth ?? 1
    };
  }

  private playerMovementSpeed(playerId: string): number {
    const movementMultiplier = Math.max(
      0.2,
      Math.min(2, this.combat.playerMovementMultiplier?.(playerId) ?? 1)
    );
    const configuredMetersPerSecond = this.authorities.playerMovementSpeedMps ??
      DEFAULT_PLAYER_SPEED_MPS;
    // Delver's Lore: a flat +8/+16/+24 Speed (same units as the base m/s) while inside a dungeon.
    const delversLoreSpeed = this.combat.generalSkillRank(playerId, "delvers_lore") * 8;
    return (configuredMetersPerSecond * movementMultiplier + delversLoreSpeed) /
      CISTERN_WARRENS_SPATIAL_PROFILE.combatMetersPerLocalUnit;
  }

  private requireSession(playerId: string, sessionId: string): SewerSession {
    const session = this.sessions.get(playerId);
    if (!session || session.sessionId !== sessionId) {
      throw new DungeonError("SESSION_NOT_FOUND", "That dungeon session is no longer active.");
    }
    return session;
  }

  private roomDefinition(spaceId: string, dungeon: DungeonDefinition = this.dungeon) {
    if (!isCisternWarrensSpaceId(spaceId, dungeon)) {
      throw new DungeonError("INVALID_SPACE", "That dungeon room does not exist.");
    }
    return cisternWarrensRoomDefinition(spaceId, dungeon);
  }

  private roomNavigation(spaceId: string, dungeon: DungeonDefinition = this.dungeon) {
    this.roomDefinition(spaceId, dungeon);
    return cisternWarrensRoomNavigation(spaceId, dungeon);
  }

  private objects(session: SewerSession): DungeonObjectSnapshot[] {
    const room = this.roomDefinition(session.spaceId, session.dungeon);
    const instance = this.instance(session);
    return room.objects.filter((object) => {
      if (object.retired) return false;
      if (object.type !== "portal") return true;
      const portal = session.dungeon.portals.find((candidate) => candidate.id === object.portalId);
      return portal !== undefined && !portal.retired;
    }).map((object) => {
      const anchor = dungeonAnchorDefinition(room, object.anchorId);
      const objectPortal = object.type === "portal"
        ? session.dungeon.portals.find((portal) => portal.id === object.portalId)
        : undefined;
      const portalEnabled = object.type !== "portal" ||
        (objectPortal?.enabled === true && objectPortal !== undefined &&
          this.portalAvailable(instance, objectPortal, session.playerId));
      const available = instance.objectAvailability.get(objectKey(room.id, object.id)) === true && portalEnabled;
      const chestPresentation = available
        ? this.chestPresentation(session.dungeon, room.id, object, instance.runId)
        : null;
      return {
        id: object.id,
        kind: object.type,
        name: object.name,
        x: anchor.x,
        y: anchor.y,
        available,
        // A reward chest this player already claimed (or is claiming) reads as looted for them only.
        state: object.type === "chest" && (this.rewardChestClaimed(session.dungeon, instance, room.id, object.id, session.playerId, true) ||
          !this.bossChestCredited(instance, room.id, session.playerId))
          ? "looted"
          : instance.objectStates.get(objectKey(room.id, object.id)) ?? object.initialState,
        prefabId: object.prefabId,
        prefabRevision: object.prefabRevision,
        layerId: object.layerId,
        interactionRadius: object.interactionRadius,
        rotationDeg: object.rotationDeg,
        opacity: object.opacity,
        flipX: object.flipX,
        flipY: object.flipY,
        zIndex: object.zIndex,
        ...(chestPresentation ? {
          rarity: chestPresentation.rarity,
          ...(chestPresentation.assetKey ? { assetKey: chestPresentation.assetKey } : {})
        } : {}),
        ...(object.portalId ? { portalId: this.runtimePortalId(session, object.portalId) } : {}),
        ...(object.interactionLabel ? { interactionLabel: object.interactionLabel } : {})
      };
    });
  }

  /** True once the player's reward trigger for this chest has fired (or, with includePending, is mid-grant). */
  private rewardChestClaimed(
    dungeon: DungeonDefinition,
    instance: DungeonInstanceState,
    roomId: string,
    objectId: string,
    playerId: string,
    includePending = false
  ): boolean {
    return dungeon.triggers.some((trigger) => {
      if (trigger.retired || trigger.event.type !== "object_interact" ||
        trigger.event.roomId !== roomId || trigger.event.objectId !== objectId ||
        !trigger.actions.some((action) => action.type === "grant_reward")) return false;
      const scopeKey = this.triggerScopeKey(trigger.scope, playerId) ?? "";
      return instance.triggers.get(trigger.id)?.firedScopes.has(scopeKey) === true ||
        (includePending && instance.pendingRewardScopes.has(`${trigger.id}:${scopeKey}`));
    });
  }

  private chestPresentation(
    dungeon: DungeonDefinition,
    roomId: string,
    object: DungeonDefinition["rooms"][number]["objects"][number],
    runId: string
  ): Readonly<{ rarity: NonNullable<DungeonObjectSnapshot["rarity"]>; assetKey?: string }> | null {
    if (object.type !== "chest") return null;
    const reward = dungeon.triggers
      .filter((trigger) => !trigger.retired && trigger.event.type === "object_interact" &&
        trigger.event.roomId === roomId && trigger.event.objectId === object.id)
      .flatMap((trigger) => trigger.actions.map((action, actionIndex) => ({ trigger, action, actionIndex })))
      .find((candidate) => candidate.action.type === "grant_reward" &&
        (!object.rewardTableId || candidate.action.rewardTableId === object.rewardTableId));
    if (!reward || reward.action.type !== "grant_reward") return null;
    const rewardAction = reward.action;
    const table = this.catalog.rewardTables.find((candidate) =>
      candidate.id === rewardAction.rewardTableId && !candidate.retired);
    if (!table?.chestLoot) return null;
    const rarity = resolveDungeonChestRarity(table, dungeonRewardRollSeed(
      runId,
      `${reward.trigger.id}:reward:${reward.actionIndex}`,
      table
    ));
    if (!rarity) return null;
    const assetKey = table.chestLoot.rarities.find((row) => row.rarity === rarity)?.assetKey;
    return { rarity, ...(assetKey ? { assetKey } : {}) };
  }

  private portalAvailable(
    instance: DungeonInstanceState,
    portal: DungeonDefinition["portals"][number],
    playerId?: string
  ): boolean {
    if (portal.retired || !portal.enabled) return false;
    const locks = instance.portalLocks.get(portal.id) === true;
    for (const condition of portal.conditions) {
      if (condition === "always") continue;
      if (condition === "dungeon_active" && instance.completed) return false;
      if (condition === "unlocked" && locks) return false;
      if (condition === "boss_defeated") {
        const bossEncounters = instance.dungeon.encounters.filter((encounter) =>
          !encounter.retired && encounter.bossTemplateId
        );
        if (bossEncounters.length === 0 || bossEncounters.some((encounter) =>
          instance.encounters.get(encounter.id)?.state !== "completed")) return false;
      }
    }
    if (locks) return false;
    for (const gate of portal.gates ?? []) {
      if (!playerId) return false;
      if (gate.type === "dungeon_flag" && (instance.flags.get(gate.flagId) ?? false) !== gate.value) return false;
      if (gate.type === "item_owned" && !this.itemOwned(playerId, gate.itemId, gate.quantity)) return false;
      if (gate.type === "quest_flag" && !this.questFlag(playerId, gate.flagId, gate.value)) return false;
    }
    return true;
  }

  private itemOwned(playerId: string, itemId: string, quantity: number): boolean {
    const direct = this.authorities.ownsItem?.(playerId, itemId, quantity);
    if (direct !== undefined) return direct;
    return (this.itemAuthorityCache.get(playerId)?.[itemId] ?? 0) >= quantity;
  }

  private questFlag(playerId: string, flagId: string, value: boolean): boolean {
    const direct = this.authorities.hasQuestFlag?.(playerId, flagId, value);
    if (direct !== undefined) return direct;
    return (this.questFlagAuthorityCache.get(playerId)?.[flagId] ?? false) === value;
  }

  private async refreshPlayerAuthorities(playerId: string): Promise<void> {
    const loader = this.authorities.loadPlayerAuthorities;
    if (!loader) return;
    try {
      const authorities = await loader(playerId);
      this.itemAuthorityCache.set(playerId, authorities.items);
      this.questFlagAuthorityCache.set(playerId, authorities.questFlags);
    } catch {
      // A missing production authority must fail closed. Retain no stale grant
      // cache when the authoritative refresh fails during reconnect.
      this.itemAuthorityCache.delete(playerId);
      this.questFlagAuthorityCache.delete(playerId);
    }
  }

  private resources(session: SewerSession): NonNullable<DungeonSnapshot["resources"]> {
    const instance = this.instance(session);
    return [...instance.resources.values()]
      .filter((resource) => resource.roomId === session.spaceId)
      .map((resource) => ({
        id: resource.id,
        roomId: resource.roomId,
        resourceType: resource.resourceType,
        x: resource.x,
        y: resource.y,
        quantity: resource.quantity,
        state: resource.state,
        // Dungeon nodes never regenerate, so there is no regeneration timer to show.
        availableAt: null,
        interactionRadius: resource.interactionRadius,
        ...(resource.prefabId ? { prefabId: resource.prefabId } : {}),
        ...(resource.prefabRevision ? { prefabRevision: resource.prefabRevision } : {}),
        source: resource.source
      }));
  }

  private initializeResources(instance: DungeonInstanceState): void {
    for (const room of instance.dungeon.rooms.filter((candidate) => !candidate.retired)) {
      for (const node of room.resourceNodes ?? []) {
        if (node.retired || instance.resources.has(node.id)) continue;
        const anchor = dungeonAnchorDefinition(room, node.anchorId);
        const prefab = node.prefabId
          ? this.catalog.prefabs.find((candidate) => candidate.id === node.prefabId && !candidate.retired)
          : undefined;
        const rule = dungeonResourceRule(node.resourceType, node.id);
        const quantity = node.available ? rule.yieldQuantity : 0;
        instance.resources.set(node.id, {
          id: node.id,
          roomId: room.id,
          resourceType: node.resourceType,
          x: anchor.x,
          y: anchor.y,
          quantity,
          minYield: rule.yieldQuantity,
          maxYield: rule.yieldQuantity,
          state: quantity > 0 ? "available" : "depleted",
          availableAt: null,
          respawnSeconds: rule.regenerationMs === null ? null : rule.regenerationMs / 1_000,
          resetOnRun: true,
          interactionRadius: node.interactionRadius,
          source: "authored",
          ...(prefab ? { prefabId: prefab.id, prefabRevision: prefab.revision } : {}),
          lifeRevision: 0
        });
      }
      for (const zone of room.resourceSpawnZones ?? []) {
        if (zone.retired) continue;
        const count = zone.minCount + hashInt(`${zone.seed}:${instance.runId}:${zone.id}`, zone.maxCount - zone.minCount + 1);
        const navigation = this.roomNavigation(room.id, instance.dungeon);
        const occupied = [...instance.resources.values()]
          .filter((resource) => resource.roomId === room.id)
          .map((resource) => ({ x: resource.x, y: resource.y }));
        let created = 0;
        let attempts = 0;
        const maximumAttempts = Math.max(32, count * 64);
        while (created < count && attempts < maximumAttempts) {
          const candidate = randomPointInShape(zone.shape, `${zone.seed}:${instance.runId}:${zone.id}:${attempts}`);
          attempts += 1;
          if (!candidate || !isIndoorNavigationPointWalkable(navigation, candidate) ||
              occupied.some((point) => Math.hypot(point.x - candidate.x, point.y - candidate.y) < zone.minimumSpacing)) {
            continue;
          }
          const id = `${room.id}:${zone.id}:${created + 1}`;
          const resourceType = zone.resourceTypes[
            hashInt(`${zone.seed}:${instance.runId}:${id}:type`, zone.resourceTypes.length)
          ]!;
          const prefab = zone.prefabId
            ? this.catalog.prefabs.find((candidatePrefab) => candidatePrefab.id === zone.prefabId && !candidatePrefab.retired)
            : undefined;
          const rule = dungeonResourceRule(resourceType, id);
          instance.resources.set(id, {
            id,
            roomId: room.id,
            resourceType,
            x: candidate.x,
            y: candidate.y,
            quantity: rule.yieldQuantity,
            minYield: rule.yieldQuantity,
            maxYield: rule.yieldQuantity,
            state: "available",
            availableAt: null,
            respawnSeconds: rule.regenerationMs === null ? null : rule.regenerationMs / 1_000,
            resetOnRun: true,
            interactionRadius: zone.interactionRadius,
            source: "spawn_zone",
            ...(prefab ? { prefabId: prefab.id, prefabRevision: prefab.revision } : {}),
            lifeRevision: 0
          });
          occupied.push(candidate);
          created += 1;
        }
        if (created < zone.minCount) {
          this.recordDiagnostic(instance, `warning:resource_zone_underfilled:${room.id}:${zone.id}`);
        }
      }
    }
  }

  private async hydrateInstance(instance: DungeonInstanceState): Promise<void> {
    if (this.execution.ephemeralRunId) return;
    if (instance.legacySewer || !isUuid(instance.runId) || this.hydratedRuns.get(instance) === instance.runId) return;
    const key = `${this.instanceIdFor(instance)}:${instance.runId}`;
    const existing = this.hydrationPromises.get(key);
    if (existing) {
      await existing;
      return;
    }
    const hydration = (async () => {
      try {
        const [stateResult, resourceResult] = await Promise.all([
          this.pool.query<{
            object_states: unknown; object_availability: unknown; portal_locks: unknown;
            flags: unknown; trigger_states: unknown; encounter_states: unknown;
            completed: boolean; cues: unknown; party_entries: unknown; boss_credits: unknown;
          }>(
            `SELECT object_states,object_availability,portal_locks,flags,trigger_states,
                    encounter_states,completed,cues,party_entries,boss_credits
               FROM dungeon_instance_state WHERE instance_id=$1 AND run_id=$2::uuid`,
            [this.instanceIdFor(instance), instance.runId]
          ),
          this.pool.query<{
            resource_id: string; room_id: string; resource_type: DungeonResourceType;
            x: number; y: number; quantity: number; state: "available" | "depleted";
            available_at: Date | string | null; min_yield: number; max_yield: number;
            respawn_seconds: number | null; reset_on_run: boolean; life_revision: number;
          }>(
            `SELECT resource_id,room_id,resource_type,x,y,quantity,state,available_at,
                    min_yield,max_yield,respawn_seconds,reset_on_run,life_revision
               FROM (
                 SELECT DISTINCT ON (resource_id) resource_id,room_id,resource_type,x,y,quantity,state,
                        available_at,min_yield,max_yield,respawn_seconds,reset_on_run,life_revision,
                        run_id,updated_at
                   FROM dungeon_resource_states
                  WHERE instance_id=$1 AND run_id=$2::uuid
                  ORDER BY resource_id,(run_id=$2::uuid) DESC,updated_at DESC
               ) persisted_resources`,
            [this.instanceIdFor(instance), instance.runId]
          )
        ]);
        const state = stateResult.rows[0];
        if (state) {
          applyJsonMap(state.object_states, (id, value) => instance.objectStates.set(id, value as ObjectState));
          applyJsonMap(state.object_availability, (id, value) => instance.objectAvailability.set(id, value === true));
          applyJsonMap(state.portal_locks, (id, value) => instance.portalLocks.set(id, value === true));
          applyJsonMap(state.flags, (id, value) => instance.flags.set(id, value === true));
          applyJsonMap(state.trigger_states, (id, value) => {
            const target = instance.triggers.get(id);
            if (!target || !isRecord(value)) return;
            target.enabled = value.enabled === true;
            target.firedCount = numberOr(value.firedCount, 0);
            target.timerDueAt = typeof value.timerDueAt === "number" ? value.timerDueAt : null;
            target.cooldowns = mapNumberValues(value.cooldowns);
            target.sequenceIndexes = mapNumberValues(value.sequenceIndexes);
            target.firedScopes = new Set(stringArray(value.firedScopes));
            target.rewardEligible = new Set(stringArray(value.rewardEligible));
          });
          applyJsonMap(state.encounter_states, (id, value) => {
            const target = instance.encounters.get(id);
            if (!target || !isRecord(value)) return;
            const stateValue = value.state;
            if (stateValue === "idle" || stateValue === "active" || stateValue === "completed" ||
                stateValue === "failed" || stateValue === "resetting") target.state = stateValue;
            target.currentWaveId = typeof value.currentWaveId === "string" ? value.currentWaveId : null;
            target.attempts = numberOr(value.attempts, 0);
            target.nextWaveAt = typeof value.nextWaveAt === "number" ? value.nextWaveAt : null;
            target.pendingWaveId = typeof value.pendingWaveId === "string" ? value.pendingWaveId : null;
            // Completed before completion times were kept: the refill clock starts now.
            const completedAt = typeof value.completedAt === "number" ? value.completedAt
              : target.state === "completed" ? this.now() : null;
            if (completedAt === null) delete target.completedAt;
            else target.completedAt = completedAt;
            target.spawnedMobIds.clear();
          });
          instance.completed = state.completed === true;
          instance.cues = stringArray(state.cues).slice(-MAX_DUNGEON_DIAGNOSTIC_CUES);
          if (isRecord(state.party_entries)) {
            applyJsonMap(state.party_entries.entries, (id, value) => {
              if (!isRecord(value)) return;
              instance.partyEntries.set(id, { torches: numberOr(value.torches, 1), rooms: new Set(stringArray(value.rooms)) });
            });
            applyJsonMap(state.party_entries.players, (playerId, value) => {
              if (typeof value === "string") instance.playerPartyEntries.set(playerId, value);
            });
          }
          applyJsonMap(state.boss_credits, (encounterId, value) =>
            instance.bossCredits.set(encounterId, new Set(stringArray(value))));
        }
        for (const row of resourceResult.rows) {
          const resource = instance.resources.get(row.resource_id);
          if (!resource || resource.roomId !== row.room_id || resource.resourceType !== row.resource_type) continue;
          resource.x = Number(row.x);
          resource.y = Number(row.y);
          resource.quantity = Math.max(0, Number(row.quantity));
          resource.state = row.state === "available" && resource.quantity > 0 ? "available" : "depleted";
          resource.availableAt = row.available_at === null ? null : new Date(row.available_at).getTime();
          resource.lifeRevision = Math.max(0, Number(row.life_revision));
        }
        await this.hydrateRunStats(instance);
        // Mob entity IDs are process-local. Re-spawn an active persisted wave
        // from its durable encounter state after reconnect/restart.
        for (const [encounterId, encounter] of instance.encounters) {
          if (encounter.state !== "active" || !encounter.currentWaveId) continue;
          const waveId = encounter.currentWaveId;
          encounter.currentWaveId = null;
          this.startWave(instance, encounterId, waveId);
        }
      } catch {
        // A runtime started before the forward migration remains usable with
        // catalog defaults; durable state is simply fail-closed for this run.
        this.recordDiagnostic(instance, "warning:dungeon_state_hydration_unavailable");
      }
    })();
    this.hydrationPromises.set(key, hydration);
    try {
      await hydration;
      this.hydratedRuns.set(instance, instance.runId);
    } finally {
      this.hydrationPromises.delete(key);
    }
  }

  private async hydrateRunStats(instance: DungeonInstanceState): Promise<void> {
    try {
      const result = await this.pool.query<{ started_at: Date | string; deaths_by_player: unknown }>(
        "SELECT started_at,deaths_by_player FROM dungeon_run_stats WHERE run_id=$1::uuid",
        [instance.runId]
      );
      const row = result?.rows?.[0];
      if (!row) return;
      instance.runStartedAt = new Date(row.started_at).getTime();
      applyJsonMap(row.deaths_by_player, (playerId, deaths) =>
        instance.deathsByPlayer.set(playerId, Math.max(0, numberOr(deaths, 0))));
    } catch {
      this.recordDiagnostic(instance, "warning:dungeon_run_stats_unavailable");
    }
  }

  /** Durable run stats apply to authored runs with a run row (not the legacy sewer or Play Test). */
  private recordsRunStats(instance: DungeonInstanceState): boolean {
    return !this.execution.ephemeralRunId && !instance.legacySewer && isUuid(instance.runId);
  }

  /** Ends the run's stats as cleared. Fire and forget; a run already ended is left alone. */
  private recordRunCleared(instance: DungeonInstanceState): void {
    if (!this.recordsRunStats(instance)) return;
    void Promise.resolve(this.pool.query(
      `UPDATE dungeon_run_stats
          SET ended_at=now(),result='cleared',
              duration_ms=GREATEST(0,floor(extract(epoch FROM (now()-started_at))*1000))::bigint
        WHERE run_id=$1::uuid AND ended_at IS NULL`,
      [instance.runId]
    )).catch(() => undefined);
  }

  /** Counts a player's death inside a dungeon run, for the run stats and the HUD death counter. */
  recordPlayerDeath(playerId: string): void {
    const session = this.sessions.get(playerId);
    if (!session) return;
    const instance = this.instances.get(session.instanceId);
    if (!instance || instance.runId !== session.runId) return;
    instance.deathsByPlayer.set(playerId, (instance.deathsByPlayer.get(playerId) ?? 0) + 1);
    if (!this.recordsRunStats(instance)) return;
    void Promise.resolve(this.pool.query(
      `UPDATE dungeon_run_stats
          SET deaths_by_player=jsonb_set(deaths_by_player,ARRAY[$2::text],
                to_jsonb(COALESCE((deaths_by_player->>$2::text)::integer,0)+1))
        WHERE run_id=$1::uuid AND ended_at IS NULL`,
      [instance.runId, playerId]
    )).catch(() => undefined);
  }

  private async persistInstanceState(instance: DungeonInstanceState): Promise<void> {
    if (this.execution.ephemeralRunId) return;
    if (instance.legacySewer || !isUuid(instance.runId)) return;
    // A fresh in-memory instance holds catalog defaults until its saved run is read; persisting them first would
    // overwrite the run's progress (flags, seals) after a server restart.
    if (this.hydratedRuns.get(instance) !== instance.runId) return;
    const instanceId = this.instanceIdFor(instance);
    const triggerStates = Object.fromEntries([...instance.triggers].map(([id, state]) => [id, {
      enabled: state.enabled,
      firedCount: state.firedCount,
      cooldowns: Object.fromEntries(state.cooldowns),
      sequenceIndexes: Object.fromEntries(state.sequenceIndexes),
      timerDueAt: state.timerDueAt,
      firedScopes: [...state.firedScopes],
      rewardEligible: [...state.rewardEligible]
    }]));
    const encounterStates = Object.fromEntries([...instance.encounters].map(([id, state]) => [id, {
      state: state.state,
      currentWaveId: state.currentWaveId,
      attempts: state.attempts,
      nextWaveAt: state.nextWaveAt,
      pendingWaveId: state.pendingWaveId,
      ...(state.completedAt !== undefined ? { completedAt: state.completedAt } : {})
    }]));
    const partyEntries = {
      entries: Object.fromEntries([...instance.partyEntries].map(([id, entry]) =>
        [id, { torches: entry.torches, rooms: [...entry.rooms] }])),
      players: Object.fromEntries(instance.playerPartyEntries)
    };
    const bossCredits = Object.fromEntries([...instance.bossCredits].map(([id, players]) => [id, [...players]]));
    await this.pool.query(
      `INSERT INTO dungeon_instance_state
         (instance_id,run_id,revision,object_states,object_availability,portal_locks,flags,
          trigger_states,encounter_states,completed,cues,party_entries,boss_credits,updated_at)
       VALUES ($1,$2::uuid,1,$3::jsonb,$4::jsonb,$5::jsonb,$6::jsonb,$7::jsonb,$8::jsonb,$9,$10::jsonb,
         $11::jsonb,$12::jsonb,now())
       ON CONFLICT (instance_id,run_id) DO UPDATE SET
         revision=dungeon_instance_state.revision+1,object_states=EXCLUDED.object_states,
         object_availability=EXCLUDED.object_availability,portal_locks=EXCLUDED.portal_locks,
         flags=EXCLUDED.flags,trigger_states=EXCLUDED.trigger_states,encounter_states=EXCLUDED.encounter_states,
         completed=EXCLUDED.completed,cues=EXCLUDED.cues,party_entries=EXCLUDED.party_entries,
         boss_credits=EXCLUDED.boss_credits,updated_at=now()`,
      [instanceId, instance.runId, JSON.stringify(Object.fromEntries(instance.objectStates)),
        JSON.stringify(Object.fromEntries(instance.objectAvailability)),
        JSON.stringify(Object.fromEntries(instance.portalLocks)),
        JSON.stringify(Object.fromEntries(instance.flags)), JSON.stringify(triggerStates),
        JSON.stringify(encounterStates), instance.completed, JSON.stringify(instance.cues),
        JSON.stringify(partyEntries), JSON.stringify(bossCredits)]
    );
  }

  private respawnResources(instance: DungeonInstanceState, now: number): void {
    for (const resource of instance.resources.values()) {
      if (resource.state !== "depleted" || resource.availableAt === null || resource.availableAt > now) continue;
      resource.lifeRevision += 1;
      resource.quantity = dungeonResourceRule(resource.resourceType, resource.id).yieldQuantity;
      resource.state = "available";
      resource.availableAt = null;
      void this.persistResourceState(instance, resource).catch(() => undefined);
    }
  }

  private async persistResourceState(instance: DungeonInstanceState, resource: ResourceRuntimeState): Promise<void> {
    if (this.execution.ephemeralRunId) return;
    await this.pool.query(
      `INSERT INTO dungeon_resource_states
         (instance_id,run_id,resource_id,room_id,resource_type,x,y,quantity,state,available_at,
          min_yield,max_yield,respawn_seconds,reset_on_run,life_revision,updated_at)
       VALUES ($1,$2::uuid,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,now())
       ON CONFLICT (instance_id,run_id,resource_id) DO UPDATE SET
         room_id=EXCLUDED.room_id,resource_type=EXCLUDED.resource_type,x=EXCLUDED.x,y=EXCLUDED.y,
         quantity=EXCLUDED.quantity,state=EXCLUDED.state,available_at=EXCLUDED.available_at,
         min_yield=EXCLUDED.min_yield,max_yield=EXCLUDED.max_yield,respawn_seconds=EXCLUDED.respawn_seconds,
         reset_on_run=EXCLUDED.reset_on_run,life_revision=EXCLUDED.life_revision,updated_at=now()`,
      [this.instanceIdFor(instance), instance.runId, resource.id, resource.roomId, resource.resourceType,
        resource.x, resource.y, resource.quantity, resource.state, resource.availableAt === null
          ? null : new Date(resource.availableAt), resource.minYield, resource.maxYield,
        resource.respawnSeconds, resource.resetOnRun, resource.lifeRevision]
    );
  }

  private instance(session: SewerSession): DungeonInstanceState {
    const instanceId = session.instanceId;
    let instance = this.instances.get(instanceId);
    if (instance) {
      if (instance.runId !== session.runId) {
        throw new DungeonError("DUNGEON_RUN_MISMATCH", "The dungeon run changed before the session was installed.");
      }
      return instance;
    }
    const now = this.now();
    instance = {
      dungeon: session.dungeon,
      runId: session.runId,
      legacySewer: session.legacySewer,
      torchTotal: this.torchTotalForRun(session.torchTotal),
      runStartedAt: this.execution.ephemeralRunId ? now : null, deathsByPlayer: new Map(),
      objectStates: new Map(), objectAvailability: new Map(), portalLocks: new Map(),
      triggers: new Map(), flags: new Map(), encounters: new Map(), elites: new Map(), resources: new Map(), zoneMembership: new Map(),
      allPlayersPresent: new Set(), processedInteractions: new Map(), processedResourceHarvests: new Map(), eventQueue: [], processingEvents: false,
      pendingRewardScopes: new Set(), completed: false, cues: [], notices: [], noticeSeq: 0,
      noticeBatch: null, noticeAudience: null, lastStatePersistAt: 0, resetDeadline: null,
      partyEntries: new Map(), playerPartyEntries: new Map(), bossCredits: new Map()
    };
    for (const room of session.dungeon.rooms) for (const object of room.objects) {
      if (object.retired) continue;
      instance.objectStates.set(objectKey(room.id, object.id), object.initialState);
      instance.objectAvailability.set(objectKey(room.id, object.id), object.available && dungeonObjectSpawnsInRun(instance.dungeon, instance.runId, room.id, object));
    }
    for (const portal of session.dungeon.portals) if (!portal.retired) instance.portalLocks.set(portal.id, false);
    for (const encounter of session.dungeon.encounters) if (!encounter.retired) {
      instance.encounters.set(encounter.id, {
        state: "idle", currentWaveId: null, attempts: 0,
        spawnedMobIds: new Map(), nextWaveAt: null, pendingWaveId: null
      });
    }
    for (const trigger of session.dungeon.triggers) if (!trigger.retired) {
      instance.triggers.set(trigger.id, {
        enabled: trigger.enabled, firedCount: 0, cooldowns: new Map(), sequenceIndexes: new Map(),
        timerDueAt: trigger.event.type === "timer" ? now + trigger.event.delayMs : null,
        firedScopes: new Set(), rewardEligible: new Set()
      });
    }
    this.initializeResources(instance);
    this.instances.set(instanceId, instance);
    return instance;
  }

  private catalogPortalId(runtimePortalId: string, dungeon: DungeonDefinition = this.dungeon): string {
    return dungeon.portals.find((portal) => runtimePortalId === portal.id ||
      runtimePortalId.endsWith(`:${portal.id}`))?.id ?? runtimePortalId;
  }

  private runtimePortalId(session: SewerSession, catalogPortalId: string): string {
    return session.legacySewer
      ? `sewer:${session.sewerId}:${catalogPortalId}`
      : portalIds.dungeon(session.sewerId, catalogPortalId);
  }

  private dispatch(instance: DungeonInstanceState, event: RuntimeEvent): void {
    if (event.type === "room_enter") this.roomEnteredAt.set(`${event.playerId}:${event.roomId}`, this.now());
    instance.eventQueue.push(event);
    if (instance.processingEvents) return;
    instance.processingEvents = true;
    let drained = 0;
    try {
      while (instance.eventQueue.length > 0) {
        drained += 1;
        if (drained > MAX_DUNGEON_EVENT_DRAIN) {
          instance.eventQueue.length = 0;
          this.recordDiagnostic(instance, "error:event_drain_budget_exceeded");
          break;
        }
        const next = instance.eventQueue.shift()!;
        this.advanceSequences(instance, next);
        for (const trigger of instance.dungeon.triggers) {
          if (trigger.retired || !eventMatches(trigger.event, next, trigger.id)) continue;
          const state = instance.triggers.get(trigger.id);
          if (!state || !this.triggerCanFire(instance, trigger, state, next)) continue;
          if (!this.preflightActions(instance, trigger.id, trigger.actions)) continue;
          const scopeKey = this.triggerScopeKey(trigger.scope, next.playerId);
          if (!scopeKey) continue;
          const pendingKey = `${trigger.id}:${scopeKey}`;
          if (instance.pendingRewardScopes.has(pendingKey)) continue;
          const rewards = trigger.actions.flatMap((action, actionIndex) =>
            action.type === "grant_reward" ? [{ action, actionIndex }] : []);
          const finish = () => {
            state.firedCount += 1;
            state.firedScopes.add(scopeKey);
            if (trigger.repetition === "cooldown") state.cooldowns.set(scopeKey, this.now() + trigger.cooldownMs);
            instance.noticeAudience = this.noticeAudienceFor(instance, trigger.scope, next.playerId);
            try {
              this.executeActions(instance, trigger.actions.filter((action) => action.type !== "grant_reward"), next.playerId);
            } finally {
              instance.noticeAudience = null;
            }
            if (trigger.actions.some((action) => action.type === "grant_run_reward" && action.recipients === "present")) {
              this.recordRunRewardEligibility(instance, state);
            }
            trigger.actions.forEach((action, actionIndex) => {
              if (action.type !== "grant_run_reward") return;
              const roomId = action.recipients === "room_present" ? this.eventRoomId(instance, next) : null;
              if (action.recipients === "room_present" && !roomId) return;
              this.grantRunReward(instance, action.rewardTableId, `${trigger.id}:reward:${actionIndex}`, roomId);
            });
          };
          if (rewards.length === 0) {
            finish();
            continue;
          }
          const rewardRunId = instance.runId;
          const grants = rewards.map(({ action, actionIndex }) => this.authorities.grantReward!(
            next.playerId,
            action.rewardTableId,
            { instanceId: this.instanceIdFor(instance), runId: rewardRunId, dungeonId: instance.dungeon.id,
              rewardSourceId: `${trigger.id}:reward:${actionIndex}`, torchTotal: instance.torchTotal,
              ...(next.requestId ? { requestId: next.requestId } : {}) }
          ));
          const asynchronous = grants.filter((grant): grant is Promise<void> =>
            grant !== undefined && typeof (grant as Promise<void>).then === "function");
          if (asynchronous.length === 0) {
            finish();
            continue;
          }
          instance.pendingRewardScopes.add(pendingKey);
          void Promise.all(asynchronous).then(() => {
            if (instance.runId === rewardRunId) finish();
          }).catch(() => {
            if (instance.runId === rewardRunId) {
              this.recordDiagnostic(instance, `error:reward_grant_failed:${trigger.id}`);
            }
          }).finally(() => {
            if (instance.runId === rewardRunId) instance.pendingRewardScopes.delete(pendingKey);
          });
        }
      }
    } finally {
      instance.processingEvents = false;
    }
  }

  private advanceSequences(instance: DungeonInstanceState, event: RuntimeEvent): void {
    if (event.type !== "object_interact" || !event.objectId || !event.roomId) return;
    for (const trigger of instance.dungeon.triggers) {
      if (trigger.retired || trigger.event.type !== "object_sequence" ||
          trigger.event.roomId !== event.roomId) continue;
      const state = instance.triggers.get(trigger.id);
      if (!state?.enabled) continue;
      const scopeKey = this.triggerScopeKey(trigger.scope, event.playerId);
      if (!scopeKey) continue;
      const sequenceIndex = state.sequenceIndexes.get(scopeKey) ?? 0;
      const expected = trigger.event.objectIds[sequenceIndex];
      const nextIndex = event.objectId === expected ? sequenceIndex + 1 :
        event.objectId === trigger.event.objectIds[0] ? 1 : 0;
      state.sequenceIndexes.set(scopeKey, nextIndex);
      if (nextIndex === trigger.event.objectIds.length) {
        state.sequenceIndexes.set(scopeKey, 0);
        instance.eventQueue.push({ ...event, type: "object_sequence", objectId: trigger.id });
      }
    }
  }

  private triggerCanFire(
    instance: DungeonInstanceState,
    trigger: DungeonDefinition["triggers"][number],
    state: TriggerRuntimeState,
    event: RuntimeEvent
  ): boolean {
    if (!state.enabled) return false;
    const scopeKey = this.triggerScopeKey(trigger.scope, event.playerId);
    if (!scopeKey) return false;
    if (trigger.repetition === "once" && state.firedScopes.has(scopeKey)) return false;
    if (trigger.repetition === "cooldown" && (state.cooldowns.get(scopeKey) ?? 0) > this.now()) return false;
    const results = trigger.conditions.items.map((condition) => this.conditionMatches(instance, condition, event.playerId));
    return results.length === 0 || (trigger.conditions.mode === "all" ? results.every(Boolean) : results.some(Boolean));
  }

  private conditionMatches(
    instance: DungeonInstanceState,
    condition: DungeonDefinition["triggers"][number]["conditions"]["items"][number],
    playerId?: string
  ): boolean {
    switch (condition.type) {
      case "encounter_state": return instance.encounters.get(condition.encounterId)?.state === condition.state;
      case "object_state": return instance.objectStates.get(objectKey(condition.roomId, condition.objectId)) === condition.state;
      case "dungeon_flag": return (instance.flags.get(condition.flagId) ?? false) === condition.value;
      case "player_count": return compareCount(this.connectedCount(instance), condition.operator, condition.count);
      case "item_owned": return !!playerId && this.itemOwned(playerId, condition.itemId, condition.quantity);
      case "quest_flag": return !!playerId && this.questFlag(playerId, condition.flagId, condition.value);
    }
  }

  private triggerScopeKey(scope: "player" | "party" | "instance", playerId?: string): string | null {
    if (scope === "instance") return "instance";
    if (!playerId) return null;
    if (scope === "player") return `player:${playerId}`;
    const partyId = this.authorities.partyIdForPlayer?.(playerId);
    return partyId ? `party:${partyId}` : `player:${playerId}`;
  }

  private executeActions(
    instance: DungeonInstanceState,
    actions: DungeonDefinition["triggers"][number]["actions"],
    playerId?: string
  ): void {
    this.withNoticeBatch(instance, () => this.runActions(instance, actions, playerId));
  }

  private runActions(
    instance: DungeonInstanceState,
    actions: DungeonDefinition["triggers"][number]["actions"],
    playerId?: string
  ): void {
    for (const action of actions) switch (action.type) {
      case "start_encounter": this.startEncounter(instance, action.encounterId); break;
      case "start_wave": this.startWave(instance, action.encounterId, action.waveId); break;
      case "set_object_state": {
        const key = objectKey(action.roomId, action.objectId);
        if (instance.objectStates.get(key) === action.state) break;
        instance.objectStates.set(key, action.state);
        if (action.state === "looted" || action.state === "destroyed") {
          instance.objectAvailability.set(key, false);
        }
        this.dispatch(instance, { type: "object_state", ...(playerId ? { playerId } : {}), roomId: action.roomId,
          objectId: action.objectId, state: action.state });
        break;
      }
      case "set_object_available": {
        const object = instance.dungeon.rooms.find((room) => room.id === action.roomId)?.objects.find((candidate) => candidate.id === action.objectId);
        const key = objectKey(action.roomId, action.objectId);
        const wasAvailable = instance.objectAvailability.get(key) === true;
        const nowAvailable = action.available &&
          (object ? dungeonObjectSpawnsInRun(instance.dungeon, instance.runId, action.roomId, object) : true);
        instance.objectAvailability.set(key, nowAvailable);
        if (nowAvailable && !wasAvailable && object) this.autoNotice(instance, { kind: "object", text: `${object.name} appeared.` });
        break;
      }
      case "set_portal_locked": {
        const wasLocked = instance.portalLocks.get(action.portalId) === true;
        instance.portalLocks.set(action.portalId, action.locked);
        if (wasLocked && !action.locked) this.autoNotice(instance, { kind: "portal", portalId: action.portalId });
        break;
      }
      case "enable_trigger": {
        const target = instance.triggers.get(action.triggerId);
        if (target) target.enabled = action.enabled;
        break;
      }
      case "play_cue": this.pushCue(instance, action.cueId); break;
      case "show_message":
        this.batch(instance).authored.push({
          text: action.text, tone: action.tone ?? "info", audience: instance.noticeAudience
        });
        break;
      case "set_dungeon_flag": {
        if ((instance.flags.get(action.flagId) ?? false) === action.value) break;
        instance.flags.set(action.flagId, action.value);
        // A flag that satisfies a door's gate is how scaffolded dungeons unlock doors; announce the opening.
        for (const portal of instance.dungeon.portals) {
          if (portal.retired || !portal.enabled) continue;
          if (portal.gates?.some((gate) => gate.type === "dungeon_flag" && gate.flagId === action.flagId && gate.value === action.value)) {
            this.autoNotice(instance, { kind: "portal", portalId: portal.id });
          }
        }
        this.dispatch(instance, { type: "dungeon_flag", ...(playerId ? { playerId } : {}), flagId: action.flagId, value: action.value });
        break;
      }
      case "grant_reward": break;
      case "grant_run_reward": break;
      case "complete_dungeon":
        if (!instance.completed) {
          this.autoNotice(instance, { kind: "complete" });
          instance.completed = true;
          this.recordCompletionLockouts(instance);
          this.recordForgeCleared(instance);
          this.recordRunCleared(instance);
          this.announceCompletion(instance);
        }
        instance.completed = true;
        break;
    }
  }

  /** Starts the repeat lockout for every player present in the run that just completed. Fire and forget. */
  private recordCompletionLockouts(instance: DungeonInstanceState): void {
    const hours = instance.dungeon.access?.lockoutHours;
    const days = instance.dungeon.access?.lockoutDays ?? DEFAULT_DUNGEON_LOCKOUT_DAYS;
    if ((!hours && days <= 0) || instance.legacySewer || this.execution.ephemeralRunId) return;
    for (const playerId of this.completionPlayerIds(instance)) {
      void this.repeatLedger.recordCompletion({
        completionKey: `dungeon-complete:${instance.runId}:${playerId}`,
        playerId,
        dungeonKey: dungeonLockoutKey(instance.dungeon.id),
        sessionIdentity: `run:${instance.runId}`,
        ...(hours ? { lockoutHours: hours } : { baseCooldownDays: days })
      }).catch(() => undefined);
    }
  }

  /**
   * Who a clear credits (lockout, completion notice): every session of the run, or in the shared Golem
   * Forge only the players inside the Forgemaster fight when it started, connected or not.
   */
  private completionPlayerIds(instance: DungeonInstanceState): string[] {
    if (isGolemForge(instance.dungeon)) return [...instance.bossCredits.get(GOLEM_FORGE_FINAL_BOSS_ENCOUNTER_ID) ?? []];
    return [...this.sessions.values()]
      .filter((session) => session.runId === instance.runId && session.dungeon.id === instance.dungeon.id)
      .map((session) => session.playerId);
  }

  /** Golem Forge: a boss room's chest opens only for players credited with that boss's fight. */
  private bossChestCredited(instance: DungeonInstanceState, roomId: string, playerId: string): boolean {
    if (!isGolemForge(instance.dungeon)) return true;
    const boss = instance.dungeon.encounters.find((definition) =>
      !definition.retired && definition.roomId === roomId && definition.bossTemplateId);
    return !boss || instance.bossCredits.get(boss.id)?.has(playerId) === true;
  }

  /**
   * Golem Forge: a boss fight starting (its doors lock) records everyone in its room as the fight's credit
   * list, replacing a previous attempt's. Disconnects keep their credit; a wipe or eject clears it.
   */
  private recordBossCredits(instance: DungeonInstanceState, definition: DungeonEncounterDefinition): void {
    if (!isGolemForge(instance.dungeon) || !definition.bossTemplateId) return;
    instance.bossCredits.set(definition.id, new Set(this.sessionsInInstance(this.instanceIdFor(instance))
      .filter((session) => session.spaceId === definition.roomId).map((session) => session.playerId)));
  }

  /**
   * Golem Forge group gold bonus for a mob this player killed in `regionCode`: how many of the killer's
   * party (killer included) are connected in the same Forge picks the multiplier. 1 anywhere else.
   */
  groupGoldMultiplier(playerId: string, regionCode: string | undefined): number {
    const session = this.sessions.get(playerId);
    if (!session || session.legacySewer || !isGolemForge(session.dungeon) ||
        regionCode !== `interior:${session.instanceId}`) return 1;
    const partyId = this.authorities.partyIdForPlayer?.(playerId) ?? null;
    if (!partyId) return 1;
    return golemForgeGroupGoldMultiplier(this.sessionsInInstance(session.instanceId).filter((other) =>
      other.connected && this.authorities.partyIdForPlayer?.(other.playerId) === partyId).length);
  }

  /**
   * `access.noReentry`: walking out through the world exit before the run is complete starts this
   * player's lockout (same length as a clear), so the run cannot be re-entered. Death respawns inside
   * and a disconnect never calls leave, so neither counts.
   */
  private async recordEarlyLeaveLockout(instance: DungeonInstanceState, session: SewerSession, runtimePortalId: string | undefined): Promise<void> {
    const access = instance.dungeon.access;
    // The shared Golem Forge never locks out on leaving: coming back later at a lower price is the point.
    if (!access?.noReentry || instance.completed || instance.legacySewer || this.execution.ephemeralRunId || !runtimePortalId ||
        isGolemForge(instance.dungeon)) return;
    if (this.catalogPortalId(runtimePortalId, session.dungeon) !== instance.dungeon.escape.portalId) return;
    const hours = access.lockoutHours;
    const days = access.lockoutDays ?? DEFAULT_DUNGEON_LOCKOUT_DAYS;
    if (!hours && days <= 0) return;
    // Awaited so a quick re-entry already sees the lockout; a ledger failure never blocks leaving.
    // Recorded as an early leave, never a clear (no completion notice, its own key and identity).
    await this.repeatLedger.recordEarlyLeave({
      playerId: session.playerId,
      dungeonKey: dungeonLockoutKey(instance.dungeon.id),
      runId: instance.runId,
      ...(hours ? { lockoutHours: hours } : { baseCooldownDays: days })
    }).catch((error: unknown) => {
      console.warn(`[dungeon] early-leave lockout failed dungeon=${instance.dungeon.id} player=${session.playerId}`, error);
    });
  }

  /** Tells the host which players just completed this run, with the entrance they came in by. */
  private announceCompletion(instance: DungeonInstanceState): void {
    const notify = this.authorities.onDungeonCompleted;
    if (!notify || instance.legacySewer || instance.dungeon.id === CISTERN_WARRENS_DUNGEON.id || this.execution.ephemeralRunId) return;
    const credited = new Set(this.completionPlayerIds(instance));
    for (const session of this.sessions.values()) {
      if (session.runId !== instance.runId || session.dungeon.id !== instance.dungeon.id) continue;
      if (!credited.has(session.playerId)) continue;
      const { playerId, runId } = session;
      void this.entrance(session.sewerId).then(async (entrance) => {
        if (entrance) await notify({ playerId, runId, dungeonId: instance.dungeon.id, dungeonName: instance.dungeon.name, entrance });
      }).catch(() => undefined);
    }
  }

  /** The room an instance-wide event happened in: its own room, or its encounter's room. */
  private eventRoomId(instance: DungeonInstanceState, event: RuntimeEvent): string | null {
    if (event.roomId) return event.roomId;
    if (!event.encounterId) return null;
    return instance.dungeon.encounters.find((encounter) => encounter.id === event.encounterId)?.roomId ?? null;
  }

  /**
   * A member who was disconnected when a fire-once "present" run reward fired is paid when they restore into
   * the same run. Claims are idempotent on (run, player, rewardSourceId), so a repeat is a no-op.
   */
  private grantMissedRunRewards(instance: DungeonInstanceState, playerId: string): void {
    for (const trigger of instance.dungeon.triggers) {
      const state = instance.triggers.get(trigger.id);
      // Only players who were in the run when it fired: a late joiner who restores is never paid.
      if (trigger.retired || !state || state.firedCount === 0 || !state.rewardEligible.has(playerId)) continue;
      trigger.actions.forEach((action, actionIndex) => {
        if (action.type !== "grant_run_reward" || action.recipients !== "present") return;
        this.grantRunReward(instance, action.rewardTableId, `${trigger.id}:reward:${actionIndex}`, null, playerId);
      });
    }
  }

  /**
   * Records who was in the run when a "present" run reward fired: every session of the run, connected or
   * not, plus (durably) every presence row of the run, which covers members who have not restored since a
   * server restart. Persisted at once so a restart keeps the eligibility.
   */
  private recordRunRewardEligibility(instance: DungeonInstanceState, state: TriggerRuntimeState): void {
    const instanceId = this.instanceIdFor(instance);
    const runId = instance.runId;
    for (const session of this.sessionsInInstance(instanceId)) {
      if (session.runId === runId) state.rewardEligible.add(session.playerId);
    }
    if (this.execution.ephemeralRunId || !this.recordsRunStats(instance)) return;
    instance.lastStatePersistAt = this.now();
    void Promise.resolve(this.pool.query<{ player_id: string }>(
      "SELECT player_id FROM dungeon_presence WHERE instance_id=$1 AND run_id=$2::uuid", [instanceId, runId]
    )).then((result) => {
      if (instance.runId !== runId) return;
      for (const row of result?.rows ?? []) state.rewardEligible.add(row.player_id);
    }).catch(() => undefined).finally(() => {
      if (instance.runId !== runId) return;
      instance.lastStatePersistAt = this.now();
      return this.persistInstanceState(instance).catch(() => undefined);
    });
  }

  /**
   * Pays one claim of `rewardTableId` to every connected member of the run (or of `roomId`). Each claim is
   * idempotent on (run, player, rewardSourceId); a member's grant in flight is not started twice.
   */
  private grantRunReward(
    instance: DungeonInstanceState,
    rewardTableId: string,
    rewardSourceId: string,
    roomId: string | null,
    onlyPlayerId?: string
  ): void {
    const grantReward = this.authorities.grantReward;
    if (!grantReward) {
      this.recordDiagnostic(instance, `error:unsupported_reward_authority:${rewardSourceId}`);
      return;
    }
    // Claims are keyed on a run UUID; the legacy city-structure sewer has no run identity.
    if (instance.legacySewer || (!this.execution.ephemeralRunId && !isUuid(instance.runId))) {
      this.recordDiagnostic(instance, `warning:run_reward_without_run_identity:${rewardSourceId}`);
      return;
    }
    const instanceId = this.instanceIdFor(instance);
    const runId = instance.runId;
    const recipients = this.sessionsInInstance(instanceId).filter((session) =>
      session.connected && session.runId === runId && (roomId === null || session.spaceId === roomId) &&
      (onlyPlayerId === undefined || session.playerId === onlyPlayerId));
    for (const session of recipients) {
      const pendingKey = `${rewardSourceId}:player:${session.playerId}`;
      if (instance.pendingRewardScopes.has(pendingKey)) continue;
      const failed = () => {
        if (instance.runId === runId) this.recordDiagnostic(instance, `error:reward_grant_failed:${rewardSourceId}`);
      };
      let grant: void | Promise<void>;
      try {
        grant = grantReward(session.playerId, rewardTableId, {
          instanceId, runId, dungeonId: instance.dungeon.id, rewardSourceId, torchTotal: instance.torchTotal
        });
      } catch {
        failed();
        continue;
      }
      if (!grant || typeof (grant as Promise<void>).then !== "function") continue;
      instance.pendingRewardScopes.add(pendingKey);
      void grant.catch(failed).finally(() => {
        if (instance.runId === runId) instance.pendingRewardScopes.delete(pendingKey);
      });
    }
  }

  /** Runs `fn` inside one notice batch: authored messages win, otherwise automatic notices merge into one. */
  private withNoticeBatch(instance: DungeonInstanceState, fn: () => void): void {
    const outer = instance.noticeBatch;
    if (!outer) instance.noticeBatch = { authored: [], auto: [] };
    try {
      fn();
    } finally {
      if (!outer) {
        const batch = instance.noticeBatch!;
        instance.noticeBatch = null;
        this.flushNotices(instance, batch);
      }
    }
  }

  private batch(instance: DungeonInstanceState): NoticeBatch {
    if (!instance.noticeBatch) throw new Error("Dungeon notice raised outside a notice batch");
    return instance.noticeBatch;
  }

  private autoNotice(instance: DungeonInstanceState, notice: DistributiveOmit<AutoNotice, "audience">): void {
    this.batch(instance).auto.push({ ...notice, audience: instance.noticeAudience } as AutoNotice);
  }

  private flushNotices(instance: DungeonInstanceState, batch: NoticeBatch): void {
    if (batch.authored.length > 0) {
      for (const notice of batch.authored) this.pushNotice(instance, notice.text, notice.tone, notice.audience);
      return;
    }
    // Automatic notices from one burst are de-noised per audience into short lines, one per fact.
    const byAudience = new Map<string, { notices: AutoNotice[]; audience: ReadonlySet<string> | null }>();
    for (const notice of batch.auto) {
      const key = notice.audience ? [...notice.audience].sort().join(",") : "*";
      const entry = byAudience.get(key) ?? { notices: [], audience: notice.audience };
      entry.notices.push(notice);
      byAudience.set(key, entry);
    }
    for (const { notices, audience } of byAudience.values()) {
      for (const text of summarizeAutoNotices(this.noticeContext(instance, audience), notices)) {
        this.pushNotice(instance, text, "success", audience);
      }
    }
  }

  private noticeContext(instance: DungeonInstanceState, audience: ReadonlySet<string> | null): NoticeContext {
    return {
      dungeon: instance.dungeon,
      occupiedRoomIds: new Set(this.sessionsInInstance(this.instanceIdFor(instance))
        .filter((session) => !audience || audience.has(session.playerId))
        .map((session) => session.spaceId))
    };
  }

  private pushNotice(
    instance: DungeonInstanceState,
    text: string,
    tone: DungeonNotice["tone"],
    audience: ReadonlySet<string> | null
  ): void {
    instance.noticeSeq += 1;
    instance.notices.push({ id: instance.noticeSeq, text, tone, audience });
    if (instance.notices.length > MAX_DUNGEON_NOTICES) {
      instance.notices.splice(0, instance.notices.length - MAX_DUNGEON_NOTICES);
    }
  }

  private noticeAudienceFor(
    instance: DungeonInstanceState,
    scope: "player" | "party" | "instance",
    playerId?: string
  ): ReadonlySet<string> | null {
    if (scope === "instance" || !playerId) return null;
    if (scope === "player") return new Set([playerId]);
    const partyId = this.authorities.partyIdForPlayer?.(playerId);
    if (!partyId) return new Set([playerId]);
    const members = this.sessionsInInstance(this.instanceIdFor(instance))
      .filter((session) => this.authorities.partyIdForPlayer?.(session.playerId) === partyId)
      .map((session) => session.playerId);
    return new Set([playerId, ...members]);
  }

  private preflightActions(
    instance: DungeonInstanceState,
    triggerId: string,
    actions: DungeonDefinition["triggers"][number]["actions"]
  ): boolean {
    if (actions.some((action) => action.type === "grant_reward" || action.type === "grant_run_reward") &&
        !this.authorities.grantReward) {
      this.recordDiagnostic(instance, `error:unsupported_reward_authority:${triggerId}`);
      return false;
    }
    return true;
  }

  private pushCue(instance: DungeonInstanceState, cue: string): void {
    instance.cues.push(cue);
    if (instance.cues.length > MAX_DUNGEON_DIAGNOSTIC_CUES) {
      instance.cues.splice(0, instance.cues.length - MAX_DUNGEON_DIAGNOSTIC_CUES);
    }
  }

  private recordDiagnostic(instance: DungeonInstanceState, cue: string): void {
    if (!instance.cues.includes(cue)) this.pushCue(instance, cue);
  }

  private startEncounter(instance: DungeonInstanceState, encounterId: string): void {
    const definition = instance.dungeon.encounters.find((candidate) => candidate.id === encounterId && !candidate.retired);
    const state = instance.encounters.get(encounterId);
    if (!definition || !state || state.state === "active" || state.state === "completed") return;
    if (!definition.retry.allowed && state.attempts > 0) return;
    if (definition.retry.maxAttempts !== null && state.attempts >= definition.retry.maxAttempts) return;
    const firstWave = definition.waves[0];
    if (!firstWave) return;
    // A failed spawn preflight must not consume an attempt or leave encounter doors locked.
    // This is deliberately pure with respect to encounter state; startWave repeats it when
    // a delayed first wave is eventually released.
    const room = this.roomDefinition(definition.roomId, instance.dungeon);
    this.preflightWaveSpawns(instance, definition, state, firstWave, room);
    state.state = "active";
    state.startedAt = this.now();
    state.attempts += 1;
    if (definition.rescue) {
      this.withNoticeBatch(instance, () => this.batch(instance).authored.push({
        text: `Defeat them within ${Math.round(definition.rescue!.timeLimitMs / 1_000)} seconds to free the prisoner!`,
        tone: "warning", audience: instance.noticeAudience
      }));
    }
    // A Golem Forge boss gathers first: the party follows in one by one, and the doors (its entry
    // included) seal and its credit list is taken when the boss wakes (startWave).
    const gathering = isGolemForge(instance.dungeon) && Boolean(definition.bossTemplateId) && firstWave.delayMs > 0;
    if (gathering) {
      const audience = new Set(this.sessionsInInstance(this.instanceIdFor(instance))
        .filter((session) => session.spaceId === definition.roomId).map((session) => session.playerId));
      this.withNoticeBatch(instance, () => this.batch(instance).authored.push({
        text: `${definition.name} wakes in ${Math.round(firstWave.delayMs / 1_000)} seconds. Everyone inside when it ` +
          "wakes fights it, and the doors seal.",
        tone: "warning", audience
      }));
    } else {
      for (const portalId of definition.lockPortalIds) instance.portalLocks.set(portalId, true);
    }
    this.recordBossCredits(instance, definition);
    this.dispatch(instance, { type: "encounter_state", encounterId, state: "active" });
    if (firstWave.delayMs > 0) {
      state.pendingWaveId = firstWave.id;
      state.nextWaveAt = this.now() + firstWave.delayMs;
    } else {
      this.startWave(instance, encounterId, firstWave.id);
    }
  }

  private prepareWaveSpawns(
    instance: DungeonInstanceState,
    definition: DungeonEncounterDefinition,
    state: EncounterRuntimeState,
    wave: DungeonEncounterDefinition["waves"][number],
    room: DungeonRoomDefinition,
    torchTotal = instance.torchTotal
  ): Array<{ placement: DungeonRoomDefinition["mobs"][number]; spawnPoint: IndoorPoint }> {
    const navigation = this.roomNavigation(room.id, instance.dungeon);
    const plans: Array<{ placement: DungeonRoomDefinition["mobs"][number]; spawnPoint: IndoorPoint }> = [];
    for (const spawnId of wave.mobSpawnIds) {
      const placement = room.mobs.find((candidate) => candidate.id === spawnId && !candidate.retired);
      if (!placement || state.spawnedMobIds.has(spawnId)) continue;
      if (!torchSetSpawns(placement, { torchTotal })) continue;
      if (placement.summonedByMobSpawnId) {
        const leaderId = state.spawnedMobIds.get(placement.summonedByMobSpawnId);
        const leader = leaderId ? this.combat.entity(leaderId) : null;
        if (!leader || leader.currentHealth / Math.max(1, leader.maxHealth) * 100 > (placement.summonAtHealthPercent ?? 50)) continue;
      }
      const anchor = dungeonAnchorDefinition(room, placement.anchorId);
      const groupedSpawnIds = wave.mobSpawnIds.filter((candidateId) =>
        room.mobs.find((candidate) => candidate.id === candidateId)?.spawnGroupId === placement.spawnGroupId
      );
      const formationIndex = Math.max(0, groupedSpawnIds.indexOf(spawnId));
      const formationOffset = dungeonFormationOffset(
        definition.groupControls?.formation ?? "scatter",
        formationIndex,
        groupedSpawnIds.length
      );
      let spawnPoint: IndoorPoint = {
        x: clamp(anchor.x + formationOffset.x, 0, room.width),
        y: clamp(anchor.y + formationOffset.y, 0, room.height)
      };
      if (placement.randomSpawnZoneId) {
        const zone = room.zones.find((candidate) => candidate.id === placement.randomSpawnZoneId && !candidate.retired);
        let point: IndoorPoint | null = null;
        for (let attempt = 0; zone && attempt < 256; attempt += 1) {
          const candidate = randomPointInShape(zone, `${instance.runId}:${placement.id}:${attempt}`);
          if (candidate && isIndoorNavigationPointWalkable(navigation, candidate)) { point = candidate; break; }
        }
        if (!point) {
          throw new DungeonError("SPAWN_ZONE_BLOCKED", `No walkable spawn point in ${placement.randomSpawnZoneId}.`);
        }
        spawnPoint = point;
      }
      if (!isIndoorNavigationPointWalkable(navigation, spawnPoint)) {
        throw new DungeonError("SPAWN_POSITION_BLOCKED",
          `Formation-adjusted spawn position for ${placement.id} is blocked.`);
      }
      // Mobs never share an exact point: a scatter group (no formation offset) shares one anchor.
      plans.push({ placement, spawnPoint: separatedSpawnPoint(spawnPoint, plans.map((plan) => plan.spawnPoint), navigation, room) });
    }
    return plans;
  }

  private startWave(instance: DungeonInstanceState, encounterId: string, waveId: string): void {
    const definition = instance.dungeon.encounters.find((candidate) => candidate.id === encounterId && !candidate.retired);
    const state = instance.encounters.get(encounterId);
    const wave = definition?.waves.find((candidate) => candidate.id === waveId);
    if (!definition || !state || !wave || state.state === "completed") return;
    if (state.state !== "active") {
      if (!definition.retry.allowed && state.attempts > 0) return;
      if (definition.retry.maxAttempts !== null && state.attempts >= definition.retry.maxAttempts) return;
    }
    const room = this.roomDefinition(definition.roomId, instance.dungeon);
    // Validate every spawn before changing active/current-wave/attempt/portal state. A
    // blocked formation therefore remains retryable and cannot be mistaken for an empty
    // completed wave by the next encounter tick.
    this.preflightWaveSpawns(instance, definition, state, wave, room);
    if (state.state !== "active") {
      state.state = "active";
      state.attempts += 1;
      for (const portalId of definition.lockPortalIds) instance.portalLocks.set(portalId, true);
      this.recordBossCredits(instance, definition);
      this.dispatch(instance, { type: "encounter_state", encounterId, state: "active" });
    }
    if (state.pendingWaveId === waveId && waveId === definition.waves[0]?.id &&
        isGolemForge(instance.dungeon) && definition.bossTemplateId) {
      // The gathering is over: seal the doors and credit everyone inside as the boss wakes.
      for (const portalId of definition.lockPortalIds) instance.portalLocks.set(portalId, true);
      this.recordBossCredits(instance, definition);
    }
    state.currentWaveId = waveId;
    state.nextWaveAt = null;
    state.pendingWaveId = null;
    state.attempts = Math.max(1, state.attempts);
    // Dispatching the active-state event can synchronously fire authored triggers. Rebuild
    // plans after that dispatch so a nested startWave cannot leave stale duplicate plans here.
    try {
      this.spawnWavePlans(instance, definition, state, wave, room);
    } catch (error) {
      // The portals are already locked; never strand players behind them.
      this.failEncounter(instance, definition, state, `spawn_failed:${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  }

  private spawnWavePlans(
    instance: DungeonInstanceState,
    definition: DungeonEncounterDefinition,
    state: EncounterRuntimeState,
    wave: DungeonEncounterDefinition["waves"][number],
    room: DungeonRoomDefinition
  ): void {
    const spawnPlans = this.prepareWaveSpawns(instance, definition, state, wave, room);
    for (const { placement, spawnPoint } of spawnPlans) {
      this.spawnPlacementMob(instance, definition, state, room, placement, spawnPoint, placement.id);
    }
  }

  /** Spawns one encounter placement as `spawnId`: the placement's own id, or a party torch set's copy. */
  private spawnPlacementMob(
    instance: DungeonInstanceState,
    definition: DungeonEncounterDefinition,
    state: EncounterRuntimeState,
    room: DungeonRoomDefinition,
    placement: DungeonRoomDefinition["mobs"][number],
    spawnPoint: IndoorPoint,
    spawnId: string
  ): void {
    const encounterId = definition.id;
    const instanceId = this.instanceIdFor(instance);
    // A fresh authored run is a new combat life; reconnects within that run keep the same identity.
    const combatRunId = instance.legacySewer ? instanceId : `${instanceId}:${instance.runId}`;
    const entityId = boundedDungeonCombatId(`dungeon:${combatRunId}:${encounterId}:${spawnId}:${state.attempts}`);
    const bossTemplate = definition.bossTemplateId && !placement.summonedByMobSpawnId
      ? this.catalog.bossTemplates.find((candidate) => candidate.id === definition.bossTemplateId && !candidate.retired)
      : undefined;
    const bossDefinitionId = placement.summonedByMobSpawnId ? undefined : bossTemplate?.bossDefinitionId ?? definition.bossTemplateId;
    const registeredBoss = bossDefinitionId && this.bossEncounters
      ? this.bossEncounters.definition(bossDefinitionId)
      : null;
    const bossAppearanceId = registeredBoss?.appearanceId ?? bossTemplate?.appearanceId;
    if (bossTemplate && this.bossEncounters && !registeredBoss) {
      throw new DungeonError("BOSS_DEFINITION_UNAVAILABLE",
        `Boss definition ${bossTemplate.bossDefinitionId} is not registered.`);
    }
    if (definition.bossTemplateId && !placement.summonedByMobSpawnId && this.bossEncounters && !bossTemplate) {
      this.bossEncounters.registerDefinition({
        id: definition.bossTemplateId,
        revision: 1,
        archetypeKey: placement.archetype,
        controllerId: "dungeon",
        rewardPolicy: { id: `dungeon:${definition.bossTemplateId}` },
        displayName: placement.archetype
      });
    }
    const eliteModifiers = placement.elite && !bossDefinitionId
      ? new Set<DungeonEliteModifierId>(placement.elite.modifiers) : null;
    const partyLevel = PARTY_LEVEL_DUNGEON_IDS.has(instance.dungeon.id) && !bossDefinitionId
      ? this.highestLivingPlayerLevel(instanceId, room.id) : null;
    const levelProfile = partyLevel !== null
      ? this.levelCombatProfile(placement.archetype, partyLevel)
      : eliteModifiers ? this.eliteCombatProfile(placement.archetype, eliteModifiers) : null;
    const spawned = this.combat.spawnMob({
      entityId, archetype: placement.archetype,
      ...(levelProfile ? { combatProfile: levelProfile } : {}),
      ...(eliteModifiers?.has("hardy") ? { maxHealthMultiplier: DUNGEON_ELITE_TUNING.hardy.healthMultiplier } : {}),
      position: dungeonLocalToCombatPosition(spawnPoint.x, spawnPoint.y),
      homePosition: dungeonLocalToCombatPosition(spawnPoint.x, spawnPoint.y),
      packId: definition.groupControls?.linkedAggro === false
        ? null
        : boundedDungeonCombatId(`dungeon:${combatRunId}:${placement.spawnGroupId}`),
      worldAi: true,
      regionCode: `interior:${instanceId}`,
      zoneId: `interior:${instanceId}:${room.id}`,
      ...(placement.archetype === "sewer_rat_miniboss" || placement.archetype === "brood_matriarch" || placement.archetype === "raptor_chieftain" || placement.archetype === "thunderwing" || placement.archetype === "hollow_elder" || placement.archetype === "grandmaster" || placement.archetype === "elder_dragon"
        ? { defenseOverride: requireMobDefinition(placement.archetype).defense }
        : {}),
      ...(bossDefinitionId ? {
        bossLifecycleState: "active" as const,
        bossOwnership: {
          bossId: registeredBoss?.id ?? definition.bossTemplateId!,
          bossRevision: registeredBoss?.revision ?? 1,
          encounterHandlerId: "dungeon",
          hostKind: "dungeon" as const,
          hostInstanceId: instanceId,
          encounterInstanceId: `${instanceId}:${instance.runId}:${definition.id}:${state.attempts}:${spawnId}`,
          ...(bossAppearanceId ? { appearanceId: bossAppearanceId } : {}),
          lifeGeneration: state.attempts
        }
      } : {})
    });
    if (bossDefinitionId && this.bossEncounters) {
      const encounterSuffix = `${definition.id}:${state.attempts}:${spawnId}`;
      const encounterId = `${instanceId}:${instance.runId}:${encounterSuffix}`;
      const host = new DungeonBossHostAdapter({
        instanceId,
        runId: instance.runId,
        roomId: definition.roomId,
        encounterId: encounterSuffix,
        participantIds: this.sessionsInInstance(instanceId)
          .filter((session) => session.connected && session.spaceId === definition.roomId)
          .map((session) => session.playerId),
        room: this.bossRoomHooks(instance, definition.roomId)
      });
      this.bossEncounters.create({
        encounterId,
        definitionId: bossDefinitionId,
        host,
        mobEntityId: entityId,
        initialState: "active",
        lifeGeneration: state.attempts,
        ...(spawned.appearanceVariant ? { initialAppearanceVariant: spawned.appearanceVariant } : {})
      });
    }
    state.spawnedMobIds.set(spawnId, entityId);
    if (eliteModifiers) {
      if (eliteModifiers.has("swift")) {
        this.combat.scaleFreshMobStats(entityId, { movementSpeed: DUNGEON_ELITE_TUNING.swift.speedMultiplier });
      }
      const now = this.now();
      instance.elites.set(entityId, {
        entityId, encounterId, spawnId, modifiers: eliteModifiers, spawnedAt: now,
        nextHealAt: now + DUNGEON_ELITE_TUNING.healerAura.intervalMs,
        lastPosition: { lat: spawned.lat, lon: spawned.lon }, splitDone: false
      });
    }
  }

  /**
   * Shared Golem Forge: a party entry that burned more than one torch meets its extra torch sets (2..its
   * torches) the first time any of its members enters each room, whoever cleared the room's base set. The
   * copies join the encounter's spawned mobs as `<placement>~party:<entry>` (shown, healed and despawned
   * with it) but never hold its waves open or lock its doors. Boss encounters never get torch sets.
   */
  private spawnPartyTorchSets(instance: DungeonInstanceState, playerId: string, roomId: string): void {
    if (!isGolemForge(instance.dungeon)) return;
    const entryId = instance.playerPartyEntries.get(playerId);
    const entry = entryId ? instance.partyEntries.get(entryId) : undefined;
    if (!entryId || !entry || entry.torches <= 1 || entry.rooms.has(roomId)) return;
    const room = this.roomDefinition(roomId, instance.dungeon);
    let failed = false;
    for (const definition of instance.dungeon.encounters) {
      if (definition.retired || definition.roomId !== roomId || definition.bossTemplateId) continue;
      const state = instance.encounters.get(definition.id);
      if (!state) continue;
      for (const wave of definition.waves) {
        try {
          for (const { placement, spawnPoint } of this.prepareWaveSpawns(instance, definition, state, wave, room, entry.torches)) {
            const spawnId = `${placement.id}${PARTY_SET_SPAWN_MARKER}${entryId}`;
            if ((placement.partySet ?? 1) < 2 || state.spawnedMobIds.has(spawnId)) continue;
            this.spawnPlacementMob(instance, definition, state, room, placement, spawnPoint, spawnId);
          }
        } catch {
          failed = true;
          this.recordDiagnostic(instance, `warning:party_set_spawn_failed:${definition.id}`);
        }
      }
    }
    // Done for this entry only when everything spawned; the next entry retries what is missing.
    if (!failed) entry.rooms.add(roomId);
  }

  /**
   * A base-set wipe or failure clears only the encounter's own mobs: party torch set copies belong to
   * their party entry and stay (that entry already met them in this room).
   */
  private despawnEncounterBaseMobs(state: EncounterRuntimeState): void {
    for (const [spawnId, entityId] of [...state.spawnedMobIds]) {
      if (spawnId.includes(PARTY_SET_SPAWN_MARKER)) continue;
      const encounter = this.bossEncounters?.encounterForEntity(entityId);
      if (encounter) this.bossEncounters?.despawn(encounter.encounterId, "encounter-reset");
      this.combat.despawnMob(entityId);
      state.spawnedMobIds.delete(spawnId);
    }
  }

  /** Elite level: archetype level plus the elite bonus (and hardy bonus), capped at the engine maximum. */
  /**
   * The level of the highest-level living, connected player in the room. With nobody alive it falls back to the
   * highest level of anyone there: a respawn wakes the fight (the room start is a fresh entry) a moment before combat
   * marks the player alive. Null when no player in the room reports a level.
   */
  private highestLivingPlayerLevel(instanceId: string, roomId: string): number | null {
    let living: number | null = null;
    let anyone: number | null = null;
    for (const session of this.sessionsInInstance(instanceId)) {
      if (!session.connected || session.spaceId !== roomId) continue;
      const entity = this.combat.entity(session.playerId);
      if (!entity || typeof entity.level !== "number" || !Number.isInteger(entity.level)) continue;
      anyone = Math.max(anyone ?? entity.level, entity.level);
      if (entity.lifeState === undefined || entity.lifeState === "alive") living = Math.max(living ?? entity.level, entity.level);
    }
    return living ?? anyone;
  }

  /** A mob's combat profile at `level` (clamped to the mob level range), through the normal level-driven scaling. */
  private levelCombatProfile(
    archetype: DungeonRoomDefinition["mobs"][number]["archetype"],
    level: number
  ): { level: number; tier: ReturnType<typeof resolveMobCombatProfile>["tier"]; balanceVersion: number } {
    const profile = resolveMobCombatProfile(archetype, Math.max(0, Math.min(MAX_EQUIPMENT_LEVEL, level)));
    return { level: profile.level, tier: profile.tier, balanceVersion: profile.balanceVersion };
  }

  private eliteCombatProfile(
    archetype: DungeonRoomDefinition["mobs"][number]["archetype"],
    modifiers: ReadonlySet<DungeonEliteModifierId>
  ): { level: number; tier: ReturnType<typeof resolveMobCombatProfile>["tier"]; balanceVersion: number } | null {
    let bonus = DUNGEON_ELITE_TUNING.levelBonus + (modifiers.has("hardy") ? DUNGEON_ELITE_TUNING.hardy.levelBonus : 0);
    const base = requireMobDefinition(archetype).level;
    for (; bonus > 0; bonus -= 1) {
      try {
        const profile = resolveMobCombatProfile(archetype, base + bonus);
        return { level: profile.level, tier: profile.tier, balanceVersion: profile.balanceVersion };
      } catch { /* above the level cap: try a smaller bonus */ }
    }
    return null;
  }

  /** Per-tick elite upkeep: remember positions and pulse healer auras. Shield and enrage read live state. */
  private tickElites(instance: DungeonInstanceState, now: number): void {
    for (const [entityId, elite] of instance.elites) {
      const entity = this.combat.entity(entityId);
      if (!entity) { instance.elites.delete(entityId); continue; }
      if (entity.lifeState !== "alive") {
        if (!elite.modifiers.has("splitting") || elite.splitDone) instance.elites.delete(entityId);
        continue;
      }
      elite.lastPosition = { lat: entity.lat, lon: entity.lon };
      if (!elite.modifiers.has("healer_aura") || now < elite.nextHealAt) continue;
      elite.nextHealAt = now + DUNGEON_ELITE_TUNING.healerAura.intervalMs;
      const { radiusM, healFraction } = DUNGEON_ELITE_TUNING.healerAura;
      for (const encounter of instance.encounters.values()) for (const allyId of encounter.spawnedMobIds.values()) {
        if (allyId === entityId) continue;
        const ally = this.combat.entity(allyId);
        if (!ally || ally.lifeState !== "alive" || ally.currentHealth >= ally.maxHealth) continue;
        if (distanceMeters(elite.lastPosition, { lat: ally.lat, lon: ally.lon }) > radiusM) continue;
        this.combat.healMob(allyId, ally.maxHealth * healFraction);
      }
    }
  }

  /** Live modifiers for rolled elites; read by the combat engine for every non-boss mob hit. */
  private eliteCombatModifiers(entityId: string): { outgoingDamageMultiplier?: number; incomingDamageMultiplier?: number } | null {
    for (const instance of this.instances.values()) {
      const elite = instance.elites.get(entityId);
      if (!elite) continue;
      const result: { outgoingDamageMultiplier?: number; incomingDamageMultiplier?: number } = {};
      if (elite.modifiers.has("shielded") && dungeonEliteShieldActive(this.now() - elite.spawnedAt)) {
        result.incomingDamageMultiplier = 0;
      }
      if (elite.modifiers.has("enraged")) {
        const entity = this.combat.entity(entityId);
        if (entity && entity.lifeState === "alive" &&
            entity.currentHealth < entity.maxHealth * DUNGEON_ELITE_TUNING.enraged.belowHealthFraction) {
          result.outgoingDamageMultiplier = DUNGEON_ELITE_TUNING.enraged.outgoingDamageMultiplier;
        }
      }
      return result.incomingDamageMultiplier === undefined && result.outgoingDamageMultiplier === undefined ? null : result;
    }
    return null;
  }

  /** Defeated splitting elites leave two half-health, three-quarter-scale copies that hold the wave open. */
  private processEliteSplits(
    instance: DungeonInstanceState,
    definition: DungeonEncounterDefinition,
    state: EncounterRuntimeState
  ): void {
    for (const elite of [...instance.elites.values()]) {
      if (elite.encounterId !== definition.id || elite.splitDone || !elite.modifiers.has("splitting")) continue;
      if (state.spawnedMobIds.get(elite.spawnId) !== elite.entityId) continue;
      const parent = this.combat.entity(elite.entityId);
      if (parent && parent.lifeState !== "defeated") continue;
      elite.splitDone = true;
      const archetype = parent?.archetypeKey ?? null;
      if (!archetype) continue;
      const position = parent ? { lat: parent.lat, lon: parent.lon } : elite.lastPosition;
      const instanceId = this.instanceIdFor(instance);
      for (let index = 1; index <= DUNGEON_ELITE_TUNING.splitting.copies; index += 1) {
        const childSpawnId = `${elite.spawnId}${SPLIT_SPAWN_MARKER}${index}`;
        const childEntityId = boundedDungeonCombatId(`${elite.entityId}:split:${index}`);
        const angle = (index / DUNGEON_ELITE_TUNING.splitting.copies) * Math.PI * 2;
        const offsetM = 1.5;
        const child = this.combat.spawnMob({
          entityId: childEntityId, archetype,
          position: {
            lat: position.lat + Math.sin(angle) * offsetM / 111_320,
            lon: position.lon + Math.cos(angle) * offsetM / 111_320
          },
          homePosition: position,
          packId: parent?.packId ?? null,
          worldAi: true,
          regionCode: `interior:${instanceId}`,
          zoneId: parent?.zoneId ?? `interior:${instanceId}`
        });
        const parentMax = parent?.maxHealth ?? child.maxHealth;
        this.combat.scaleFreshMobStats(child.entityId, {
          maxHealth: DUNGEON_ELITE_TUNING.splitting.healthFraction * parentMax / child.maxHealth
        });
        state.spawnedMobIds.set(childSpawnId, child.entityId);
      }
    }
  }

  private preflightWaveSpawns(
    instance: DungeonInstanceState,
    definition: DungeonEncounterDefinition,
    state: EncounterRuntimeState,
    wave: DungeonEncounterDefinition["waves"][number],
    room: DungeonRoomDefinition
  ): Array<{ placement: DungeonRoomDefinition["mobs"][number]; spawnPoint: IndoorPoint }> {
    if (wave.mobSpawnIds.length === 0) {
      throw new DungeonError("EMPTY_WAVE", `Encounter ${definition.id} wave ${wave.id} has no mob placements.`);
    }
    if (definition.bossTemplateId) {
      const bossPlacements = room.mobs.filter((placement) =>
        !placement.retired && placement.encounterId === definition.id && !placement.summonedByMobSpawnId
      );
      if (bossPlacements.length !== 1) {
        throw new DungeonError("AMBIGUOUS_BOSS_PLACEMENT",
          `Encounter ${definition.id} requires exactly one non-summoned boss placement.`);
      }
      const bossTemplate = this.catalog.bossTemplates.find((candidate) =>
        candidate.id === definition.bossTemplateId && !candidate.retired
      );
      if (bossTemplate && this.bossEncounters && !this.bossEncounters.definition(bossTemplate.bossDefinitionId)) {
        throw new DungeonError("BOSS_DEFINITION_UNAVAILABLE",
          `Boss definition ${bossTemplate.bossDefinitionId} is not registered.`);
      }
    }
    return this.prepareWaveSpawns(instance, definition, state, wave, room);
  }

  private pollEncounters(instanceId: string, instance: DungeonInstanceState, now: number): void {
    for (const definition of instance.dungeon.encounters) {
      if (definition.retired) continue;
      const state = instance.encounters.get(definition.id);
      if (!state) continue;
      if (state.state === "completed" && this.refillForgeTrash(instanceId, instance, definition, state, now)) continue;
      if (state.state === "resetting" && state.nextWaveAt !== null && state.nextWaveAt <= now) {
        state.state = "idle";
        state.nextWaveAt = null;
        // A Golem Forge boss waits for a party: its gathering window must not run out on an empty room.
        if (isGolemForge(instance.dungeon) && definition.bossTemplateId) this.rearmRoomStart(instanceId, instance, definition);
        // A room-respawn dungeon (the Tilted Vault) waits for a living player in the room's start zone: the dead
        // player respawns at the room start (inside it) and the repeatable start trigger wakes the fight again.
        else if (ROOM_RESPAWN_DUNGEON_IDS.has(instance.dungeon.id)) this.restartIfLivingPlayerInStartZone(instanceId, instance, definition);
        else this.startEncounter(instance, definition.id);
        continue;
      }
      // A Vault fight that has woken before and now sits idle wakes again once a living player stands in its start
      // zone. A player downed (not killed) in a wipe recovers where they lie, with no respawn and no fresh zone entry,
      // so neither the reset end nor the repeat start trigger would ever wake it: the room soft-locked.
      if (state.state === "idle" && state.attempts > 0 && ROOM_RESPAWN_DUNGEON_IDS.has(instance.dungeon.id)) {
        this.restartIfLivingPlayerInStartZone(instanceId, instance, definition);
        continue;
      }
      if (state.state !== "active") continue;
      if (definition.bossTemplateId && this.bossFailureRequested(state)) {
        this.failEncounterAndEject(instance, definition, state, now);
        continue;
      }
      const occupants = this.sessionsInInstance(instanceId).filter((session) =>
        session.connected && session.spaceId === definition.roomId);
      const occupantEntities = occupants.map((session) => this.combat.entity(session.playerId));
      if (occupantEntities.length > 0 && occupantEntities.every((entity) =>
          entity !== null && entity.lifeState !== undefined && entity.lifeState !== "alive")) {
        this.handlePartyWipe(instance, definition, state, now);
        continue;
      }
      if (state.nextWaveAt !== null) {
        if (state.nextWaveAt <= now && state.pendingWaveId) {
          this.startWave(instance, definition.id, state.pendingWaveId);
        }
        continue;
      }
      if (!state.currentWaveId) {
        if (!state.pendingWaveId) this.failEncounter(instance, definition, state, "no_current_or_pending_wave");
        continue;
      }
      this.processEliteSplits(instance, definition, state);
      // Revisit only pending health-triggered adds; already spawned IDs are idempotent.
      this.startWave(instance, definition.id, state.currentWaveId);
      if (state.spawnedMobIds.size === 0 && state.nextWaveAt === null) {
        const room = this.roomDefinition(definition.roomId, instance.dungeon);
        const currentWave = definition.waves.find((candidate) => candidate.id === state.currentWaveId);
        // Waves with health-triggered summons may legitimately have no live mobs yet.
        if (currentWave && !currentWave.mobSpawnIds.some((spawnId) =>
            room.mobs.some((mob) => mob.id === spawnId && mob.summonedByMobSpawnId))) {
          this.failEncounter(instance, definition, state, "no_live_mobs");
          continue;
        }
      }
      const waveIndex = definition.waves.findIndex((wave) => wave.id === state.currentWaveId);
      const wave = definition.waves[waveIndex];
      const waveRoom = this.roomDefinition(definition.roomId, instance.dungeon);
      if (!wave || !wave.mobSpawnIds.every((spawnId) => {
        // Torch sets above the run's torch total never spawn and never hold the wave open.
        const placement = waveRoom.mobs.find((candidate) => candidate.id === spawnId);
        if (placement && !torchSetSpawns(placement, instance)) return true;
        const entityId = state.spawnedMobIds.get(spawnId);
        const entity = entityId ? this.combat.entity(entityId) : null;
        if (entityId && entity?.lifeState === "defeated") {
          const encounter = this.bossEncounters?.encounterForEntity(entityId);
          if (encounter) encounter.defeat();
        }
        return Boolean(entityId) && (!entity || entity.lifeState === "defeated");
      }) || [...state.spawnedMobIds].some(([spawnId, entityId]) => {
        // Split copies are not wave placements; the wave stays open until each one is defeated. A party torch
        // set's copies (and their splits) never hold the base wave open.
        if (splitParentSpawnId(spawnId) === null || spawnId.includes(PARTY_SET_SPAWN_MARKER)) return false;
        const entity = this.combat.entity(entityId);
        return Boolean(entity) && entity!.lifeState !== "defeated";
      })) continue;
      // Adds the encounter's mobs summoned are part of the fight; they fade on their own timers.
      if (this.livingSummonedAdds(this.instanceIdFor(instance), definition, state).length > 0) continue;
      const next = definition.waves[waveIndex + 1];
      if (next) {
        state.pendingWaveId = next.id;
        state.nextWaveAt = now + next.delayMs;
      }
      else {
        state.state = "completed";
        state.currentWaveId = null;
        state.completedAt = now;
        this.withNoticeBatch(instance, () => {
          if (definition.rescue) this.resolveRescue(instance, instanceId, definition, state, now);
          const reopened = definition.lockPortalIds.filter((portalId) => instance.portalLocks.get(portalId) === true);
          for (const portalId of definition.lockPortalIds) instance.portalLocks.set(portalId, false);
          this.autoNotice(instance, { kind: "defeat", name: definition.name, boss: Boolean(definition.bossTemplateId) });
          for (const portalId of reopened) this.autoNotice(instance, { kind: "portal", portalId });
          this.dispatch(instance, { type: "encounter_state", encounterId: definition.id, state: "completed" });
          if (definition.rewardTableId) {
            this.grantRunReward(instance, definition.rewardTableId, `encounter:${definition.id}`, definition.roomId);
          }
          if (instance.dungeon.encounters.filter((candidate) => !candidate.retired &&
              candidate.roomId === definition.roomId).every((candidate) =>
                instance.encounters.get(candidate.id)?.state === "completed")) {
            this.dispatch(instance, { type: "room_clear", roomId: definition.roomId });
          }
        });
      }
    }
  }

  /**
   * Golem Forge trash refill: a cleared non-boss encounter, outside any boss room, goes back to idle
   * GOLEM_FORGE_TRASH_REFILL_MS after it was cleared while the Forge is open, so its base set spawns again
   * (at once for anyone in the room, otherwise on the next room entry). Party torch set copies are left
   * alone; attempts keep counting so every refill is a new combat life. Returns whether it refilled.
   */
  private refillForgeTrash(
    instanceId: string,
    instance: DungeonInstanceState,
    definition: DungeonEncounterDefinition,
    state: EncounterRuntimeState,
    now: number
  ): boolean {
    if (!isGolemForge(instance.dungeon) || definition.bossTemplateId || state.completedAt === undefined ||
        now < state.completedAt + GOLEM_FORGE_TRASH_REFILL_MS || this.collapsedForges.has(instanceId) ||
        instance.dungeon.encounters.some((candidate) =>
          !candidate.retired && candidate.roomId === definition.roomId && candidate.bossTemplateId)) return false;
    for (const [spawnId, entityId] of [...state.spawnedMobIds]) {
      if (spawnId.includes(PARTY_SET_SPAWN_MARKER)) continue;
      this.combat.despawnMob(entityId);
      state.spawnedMobIds.delete(spawnId);
    }
    Object.assign(state, { state: "idle", currentWaveId: null, nextWaveAt: null, pendingWaveId: null });
    delete state.completedAt;
    this.rearmRoomStart(instanceId, instance, definition);
    return true;
  }

  /** The room's start trigger fires again on the next entry; the encounter starts at once for anyone already inside. */
  private rearmRoomStart(instanceId: string, instance: DungeonInstanceState, definition: DungeonEncounterDefinition): void {
    for (const trigger of instance.dungeon.triggers) {
      if (trigger.retired || trigger.event.type !== "room_enter" || trigger.event.roomId !== definition.roomId ||
          !trigger.actions.some((action) => action.type === "start_encounter" && action.encounterId === definition.id)) continue;
      const triggerState = instance.triggers.get(trigger.id);
      if (triggerState) { triggerState.firedScopes.clear(); triggerState.firedCount = 0; }
    }
    // Players still being ejected are not in the room any more, whatever their session says for now.
    if (this.sessionsInInstance(instanceId).some((session) =>
      session.connected && session.spaceId === definition.roomId && !this.ejectsInFlight.has(session.playerId))) {
      this.startEncounter(instance, definition.id);
    }
  }

  /** After a wipe's reset: start again at once only if a living, connected player already stands in a start zone. */
  private restartIfLivingPlayerInStartZone(
    instanceId: string,
    instance: DungeonInstanceState,
    definition: DungeonEncounterDefinition
  ): void {
    const room = this.roomDefinition(definition.roomId, instance.dungeon);
    const startZones = instance.dungeon.triggers.filter((trigger) => !trigger.retired && trigger.enabled &&
      trigger.actions.some((action) => action.type === "start_encounter" && action.encounterId === definition.id))
      .map((trigger) => trigger.event.type === "zone_enter" && trigger.event.roomId === room.id
        ? room.zones.find((zone) => zone.id === (trigger.event as { zoneId: string }).zoneId && !zone.retired) ?? null
        : trigger.event.type === "room_enter" && trigger.event.roomId === room.id ? "room" : null)
      .filter((zone) => zone !== null);
    if (startZones.length === 0) return;
    const living = this.sessionsInInstance(instanceId).filter((session) => {
      if (!session.connected || session.spaceId !== definition.roomId) return false;
      const life = this.combat.entity(session.playerId)?.lifeState;
      return life === undefined || life === "alive";
    });
    if (living.some((session) => startZones.some((zone) => zone === "room" || pointInGeometry(session, zone)))) {
      this.startEncounter(instance, definition.id);
    }
  }

  /** Timed rescue: in time, the players in the room gain a freed ally; late, the prisoner is lost. */
  private resolveRescue(
    instance: DungeonInstanceState,
    instanceId: string,
    definition: DungeonEncounterDefinition,
    state: EncounterRuntimeState,
    now: number
  ): void {
    const rescue = definition.rescue!;
    const inTime = state.startedAt !== undefined && now - state.startedAt <= rescue.timeLimitMs;
    if (inTime) {
      for (const session of this.sessionsInInstance(instanceId)) {
        if (session.connected && session.spaceId === definition.roomId) this.authorities.rescueAlly?.(session.playerId);
      }
      instance.flags.set(`${definition.id}_rescued`, true);
    }
    this.batch(instance).authored.push({
      text: inTime ? "The Valkyrie is free and fights at your side." : "Too slow. The prisoner is lost.",
      tone: inTime ? "success" : "warning", audience: instance.noticeAudience
    });
  }

  /** Room object and notice hooks a bespoke boss controller drives (DungeonBossHostAdapter.room). */
  private bossRoomHooks(instance: DungeonInstanceState, roomId: string): BossRoomHooks {
    const room = this.roomDefinition(roomId, instance.dungeon);
    const known = (objectId: string) => room.objects.some((object) => object.id === objectId && !object.retired);
    return {
      objectAvailable: (objectId) => instance.objectAvailability.get(objectKey(roomId, objectId)) === true,
      objectState: (objectId) => known(objectId)
        ? instance.objectStates.get(objectKey(roomId, objectId)) ?? room.objects.find((object) => object.id === objectId)!.initialState
        : null,
      setObjectAvailable: (objectId, available) => {
        if (!known(objectId)) return;
        instance.objectAvailability.set(objectKey(roomId, objectId), available);
      },
      setObjectState: (objectId, state) => {
        if (!known(objectId)) return;
        const key = objectKey(roomId, objectId);
        if ((instance.objectStates.get(key) ?? null) === state) return;
        instance.objectStates.set(key, state);
        this.dispatch(instance, { type: "object_state", roomId, objectId, state });
      },
      notify: (playerId, text, tone) => {
        const audience = playerId
          ? new Set([playerId])
          : new Set(this.sessionsInInstance(this.instanceIdFor(instance))
            .filter((session) => session.spaceId === roomId).map((session) => session.playerId));
        this.withNoticeBatch(instance, () => { this.batch(instance).authored.push({ text, tone, audience }); });
      }
    };
  }

  private activeBossEncounters(instance: DungeonInstanceState, roomId: string): BossEncounter[] {
    if (!this.bossEncounters) return [];
    const found: BossEncounter[] = [];
    for (const definition of instance.dungeon.encounters) {
      if (definition.retired || definition.roomId !== roomId || !definition.bossTemplateId) continue;
      const state = instance.encounters.get(definition.id);
      if (state?.state !== "active") continue;
      for (const entityId of state.spawnedMobIds.values()) {
        const encounter = this.bossEncounters.encounterForEntity(entityId);
        if (encounter) found.push(encounter);
      }
    }
    return found;
  }

  private bossFailureRequested(state: EncounterRuntimeState): boolean {
    return [...state.spawnedMobIds.values()].some((entityId) =>
      this.bossEncounters?.encounterForEntity(entityId)?.failureRequested != null);
  }

  /**
   * K3 failure (DROWNED_CITY_SPEC.md section 3, decision 1): the boss asked to fail (a ritual outlived
   * its deadline). The encounter resets through the party-wipe path (adds and boss despawn, the boss
   * returns at full health after the reset delay) and everyone in the room is moved to the room they
   * came in from (the sanctum's gate back to the hub) through the location CAS, then told.
   */
  private failEncounterAndEject(
    instance: DungeonInstanceState,
    definition: DungeonEncounterDefinition,
    state: EncounterRuntimeState,
    now: number
  ): void {
    const roomExits = instance.dungeon.portals.filter((portal) => !portal.retired && portal.source.kind === "room" &&
      portal.source.roomId === definition.roomId && portal.destination.kind === "room");
    // The Golem Forge throws the room out to its hub (the Crucible), not to the room it came in from.
    const back = (isGolemForge(instance.dungeon)
      ? roomExits.find((portal) => portal.destination.kind === "room" && portal.destination.roomId === GOLEM_FORGE_HUB_ROOM_ID)
      : undefined) ?? roomExits[0];
    const occupants = this.sessionsInInstance(this.instanceIdFor(instance))
      .filter((session) => session.spaceId === definition.roomId);
    this.handlePartyWipe(instance, definition, state, now);
    this.recordDiagnostic(instance, `encounter_failed_eject:${definition.id}`);
    if (!back || back.destination.kind !== "room") return;
    const destination = back.destination;
    const arrival = dungeonAnchorDefinition(this.roomDefinition(destination.roomId, instance.dungeon),
      back.destinationArrivalAnchorId ?? destination.anchorId);
    for (const session of occupants) {
      void this.ejectToRoom(session, back.id, destination.roomId, { x: arrival.x, y: arrival.y }).catch((error: unknown) => {
        console.warn(`[dungeon] eject failed dungeon=${instance.dungeon.id} player=${session.playerId}`, error);
      });
    }
  }

  /** Commits the eject through the location CAS first, then moves the session and tells the player. */
  async ejectToRoom(session: SewerSession, catalogPortalId: string, roomId: string, position: IndoorPoint): Promise<void> {
    this.ejectsInFlight.add(session.playerId);
    try {
      await this.ejectToRoomNow(session, catalogPortalId, roomId, position);
    } finally {
      this.ejectsInFlight.delete(session.playerId);
    }
  }

  private async ejectToRoomNow(session: SewerSession, catalogPortalId: string, roomId: string, position: IndoorPoint): Promise<void> {
    await this.relocateWithinRun(session, this.runtimePortalId(session, catalogPortalId), roomId, position);
  }

  /** Moves a session to another room of its run: the location CAS first, then the session; tells the player. */
  private async relocateWithinRun(
    session: SewerSession, runtimePortalId: string, roomId: string, position: IndoorPoint
  ): Promise<DungeonSnapshot | null> {
    let location: PlayerLocationSnapshot | null = null;
    if (this.playerLocations && !this.execution.ephemeralRunId) {
      const current = await this.playerLocations.load(session.playerId);
      if (current.kind !== "interior" || current.instanceId !== session.instanceId) return null;
      const committed = await this.playerLocations.commitPortalTransition({
        playerId: session.playerId,
        requestId: randomUUID(),
        portalId: runtimePortalId,
        expectedRevision: current.revision,
        destination: {
          kind: "interior", locationType: current.locationType, locationId: current.locationId,
          instanceId: current.instanceId, spaceId: roomId, position: { ...position }
        }
      });
      location = committed.location;
    }
    if (this.sessions.get(session.playerId) !== session) return null;
    this.combat.cancelCombat(session.playerId);
    const snapshot = this.transferSpace(session.playerId, session.sessionId, roomId, position);
    this.authorities.onPlayerEjected?.(session.playerId, location, snapshot);
    return snapshot;
  }

  /** Living adds summoned by this encounter's mobs (kit summons, rift cultists) in its room. */
  private livingSummonedAdds(instanceId: string, definition: DungeonEncounterDefinition, state: EncounterRuntimeState): string[] {
    if (state.spawnedMobIds.size === 0) return [];
    return this.combat.livingSummonedMobIds?.(`interior:${instanceId}:${definition.roomId}`, new Set(state.spawnedMobIds.values())) ?? [];
  }

  /** Terminal fail-safe: drop any spawned mobs, release portal locks, and mark the encounter failed. */
  private failEncounter(
    instance: DungeonInstanceState,
    definition: DungeonEncounterDefinition,
    state: EncounterRuntimeState,
    reason: string
  ): void {
    console.warn(`[dungeon] encounter failed safe dungeon=${instance.dungeon.id} encounter=${definition.id} reason=${reason}`);
    instance.bossCredits.delete(definition.id);
    for (const addId of this.livingSummonedAdds(this.instanceIdFor(instance), definition, state)) this.combat.despawnMob(addId);
    this.despawnEncounterBaseMobs(state);
    state.currentWaveId = null;
    state.pendingWaveId = null;
    state.nextWaveAt = null;
    state.state = "failed";
    for (const portalId of definition.lockPortalIds) instance.portalLocks.set(portalId, false);
    this.recordDiagnostic(instance, `error:encounter_failed_safe:${definition.id}`);
    this.dispatch(instance, { type: "encounter_state", encounterId: definition.id, state: "failed" });
  }

  private handlePartyWipe(
    instance: DungeonInstanceState,
    definition: DungeonEncounterDefinition,
    state: EncounterRuntimeState,
    now: number
  ): void {
    // A failed attempt (wipe, or a boss's eject) credits nobody; the next start records a fresh list.
    instance.bossCredits.delete(definition.id);
    const adds = this.livingSummonedAdds(this.instanceIdFor(instance), definition, state);
    // Pools and steam the boss left must not outlive the attempt (the reset is only a moment away).
    this.combat.clearDamageZones?.([...state.spawnedMobIds.values(), ...adds]);
    for (const addId of adds) this.combat.despawnMob(addId);
    this.despawnEncounterBaseMobs(state);
    state.currentWaveId = null;
    state.pendingWaveId = null;
    if (!definition.reset.onPartyWipe || !definition.retry.allowed ||
        (definition.retry.maxAttempts !== null && state.attempts >= definition.retry.maxAttempts)) {
      state.state = "failed";
      state.nextWaveAt = null;
      for (const portalId of definition.lockPortalIds) instance.portalLocks.set(portalId, false);
      this.dispatch(instance, { type: "encounter_state", encounterId: definition.id, state: "failed" });
      return;
    }
    // A Golem Forge boss gathers a party again on its restart and seals the doors only when it wakes, so the doors
    // its last attempt sealed open now; otherwise nobody could walk back in to fight it after a wipe or an eject.
    if (isGolemForge(instance.dungeon) && definition.bossTemplateId) {
      for (const portalId of definition.lockPortalIds) instance.portalLocks.set(portalId, false);
    }
    state.state = "resetting";
    state.nextWaveAt = now + definition.reset.delayMs;
    this.dispatch(instance, { type: "encounter_state", encounterId: definition.id, state: "resetting" });
  }

  /** Boss casts plus ordinary-mob telegraphs (carried by each mob, or by the viewer once the mob is gone). */
  private snapshotTelegraphs(session: SewerSession, enemies: DungeonSnapshot["enemies"]): DungeonSnapshot["telegraphs"] {
    const casts = new Map<string, DungeonSnapshot["telegraphs"][number]>();
    for (const enemy of enemies) {
      for (const cast of enemy.bossEncounter?.activeCasts ?? []) casts.set(cast.castInstanceId, cast);
      for (const cast of this.combat.entity(enemy.entityId)?.telegraphs ?? []) casts.set(cast.castInstanceId, dungeonTelegraph(cast));
    }
    for (const cast of this.combat.entity(session.playerId)?.telegraphs ?? []) casts.set(cast.castInstanceId, dungeonTelegraph(cast));
    return [...casts.values()];
  }

  private enemies(session: SewerSession, instance: DungeonInstanceState): DungeonSnapshot["enemies"] {
    const result: DungeonSnapshot["enemies"] = [];
    for (const [encounterId, encounter] of instance.encounters) for (const [spawnId, entityId] of encounter.spawnedMobIds) {
      const splitParentId = splitParentSpawnId(spawnId);
      // A party torch set's copy (and its split copies) draws as its placement.
      const placementId = (splitParentId ?? spawnId).split(PARTY_SET_SPAWN_MARKER)[0]!;
      const placement = this.roomDefinition(session.spaceId, session.dungeon).mobs.find((candidate) => candidate.id === placementId);
      const entity = this.combat.entity(entityId);
      const elite = instance.elites.get(entityId);
      if (!placement || !entity || entity.zoneId !== `interior:${session.instanceId}:${session.spaceId}`) continue;
      const local = combatPositionToDungeonLocal({ lat: entity.lat, lon: entity.lon });
      const bossEncounter = this.bossEncounters?.projectionForEntity(
        entityId,
        this.now(),
        session.playerId
      ) ?? null;
      result.push({ entityId, spawnId, encounterId, archetype: placement.archetype,
        name: entity.name, x: local.x, y: local.y, currentHealth: entity.currentHealth,
        maxHealth: entity.maxHealth, lifeState: entity.lifeState,
        targetEntityId: entity.targetEntityId,
        visualScale: splitParentId !== null ? placement.visualScale * DUNGEON_ELITE_TUNING.splitting.visualScale : placement.visualScale,
        ...(elite ? { elite: {
          modifiers: [...elite.modifiers],
          ...(elite.modifiers.has("shielded")
            ? { shieldActive: dungeonEliteShieldActive(this.now() - elite.spawnedAt) } : {})
        } } : {}),
        ...(entity.boss ? { boss: true } : {}),
        ...(entity.bossOwnership ? { bossOwnership: entity.bossOwnership } : {}),
        ...(bossEncounter ? { bossEncounter } : {}) });
    }
    // Adds the room's encounter mobs summoned (kit waves, rift cultists, tentacles, ritual cultists)
    // are enemies too, or clients would never draw or target them.
    for (const definition of instance.dungeon.encounters) {
      if (definition.retired || definition.roomId !== session.spaceId) continue;
      const state = instance.encounters.get(definition.id);
      if (!state) continue;
      for (const entityId of this.livingSummonedAdds(session.instanceId, definition, state)) {
        const entity = this.combat.entity(entityId);
        if (!entity?.archetypeKey) continue;
        const local = combatPositionToDungeonLocal({ lat: entity.lat, lon: entity.lon });
        result.push({ entityId, spawnId: entityId, encounterId: definition.id, archetype: entity.archetypeKey,
          name: entity.name, x: local.x, y: local.y, currentHealth: entity.currentHealth,
          maxHealth: entity.maxHealth, lifeState: entity.lifeState,
          targetEntityId: entity.targetEntityId, visualScale: 1 });
      }
    }
    return result;
  }

  private syncDungeonBossParticipants(instance: DungeonInstanceState): void {
    if (!this.bossEncounters) return;
    const instanceId = this.instanceIdFor(instance);
    const sessions = this.sessionsInInstance(instanceId);
    const connectedPlayerIds = new Set(
      sessions.filter((session) => session.connected).map((session) => session.playerId)
    );
    for (const encounterState of instance.encounters.values()) {
      for (const entityId of encounterState.spawnedMobIds.values()) {
        const encounter = this.bossEncounters.encounterForEntity(entityId);
        if (!encounter || encounter.host.hostKind !== "dungeon") continue;
        const host = encounter.host as DungeonBossHostAdapter;
        for (const playerId of host.participantIds()) {
          if (!connectedPlayerIds.has(playerId)) host.removeParticipant(playerId);
        }
        for (const session of sessions) {
          if (!session.connected) continue;
          host.setParticipantContext(session.playerId, {
            instanceId,
            runId: instance.runId,
            roomId: session.spaceId
          });
        }
      }
    }
  }

  private updateZones(session: SewerSession, forceGroupRecompute = false): void {
    const instance = this.instance(session);
    const room = this.roomDefinition(session.spaceId, session.dungeon);
    const key = session.playerId;
    const previous = instance.zoneMembership.get(key) ?? new Set<string>();
    const current = new Set(room.zones.filter((zone) => !zone.retired && pointInGeometry(session, zone))
      .map((zone) => `${room.id}:${zone.id}`));
    let changed = current.size !== previous.size;
    for (const zoneKey of current) if (!previous.has(zoneKey)) {
      changed = true;
      const [, zoneId] = zoneKey.split(":");
      if (zoneId) this.dispatch(instance, { type: "zone_enter", playerId: key, roomId: room.id, zoneId });
    }
    for (const zoneKey of previous) if (!current.has(zoneKey)) {
      changed = true;
      const [roomId, zoneId] = zoneKey.split(":");
      if (roomId && zoneId) this.dispatch(instance, { type: "zone_exit", playerId: key, roomId, zoneId });
    }
    instance.zoneMembership.set(key, current);
    if (!changed && !forceGroupRecompute) return;
    this.recomputeAllPlayersPresent(instance, session.sewerId, key);
  }

  private recomputeAllPlayersPresent(
    instance: DungeonInstanceState,
    sewerId: string,
    playerId: string
  ): void {
    const instanceId = this.instanceIdFor(instance);
    const players = this.sessionsInInstance(instanceId).filter((session) => session.connected);
    for (const room of instance.dungeon.rooms.filter((candidate) => candidate.active && !candidate.retired)) {
      for (const zone of room.zones.filter((candidate) => !candidate.retired)) {
        const zoneKey = `${room.id}:${zone.id}`;
        const allPresent = players.length > 0 && players.every((session) =>
          session.spaceId === room.id && pointInGeometry(session, zone));
        const wasPresent = instance.allPlayersPresent.has(zoneKey);
        if (allPresent && !wasPresent) {
          instance.allPlayersPresent.add(zoneKey);
          this.dispatch(instance, {
            type: "all_players_present", playerId, roomId: room.id, zoneId: zone.id
          });
        } else if (!allPresent && wasPresent) {
          instance.allPlayersPresent.delete(zoneKey);
        }
      }
    }
  }

  private connectedCount(instance: DungeonInstanceState): number {
    const instanceId = this.instanceIdFor(instance);
    return [...this.sessions.values()].filter((session) => session.connected && session.instanceId === instanceId).length;
  }

  private sessionsInInstance(instanceId: string): SewerSession[] {
    return [...this.sessions.values()].filter((session) => session.instanceId === instanceId);
  }

  private dispatchPlayerCount(instance: DungeonInstanceState, playerId: string): void {
    this.dispatch(instance, { type: "player_count", playerId, state: String(this.connectedCount(instance)) });
  }

  private instanceIdFor(instance: DungeonInstanceState): string {
    return [...this.instances].find(([, candidate]) => candidate === instance)?.[0] ?? "unknown";
  }

  private async scheduleResetIfEmpty(sewerId: string, instance: DungeonInstanceState): Promise<void> {
    if (this.execution.ephemeralRunId) return;
    if (instance.dungeon.reset.policy !== "when_empty") return;
    const instanceId = this.instanceIdFor(instance);
    const occupied = instance.legacySewer
      ? this.sessionsInSewer(sewerId).length > 0 || await this.hasDurableOccupants(sewerId)
      : this.sessionsInInstance(instanceId).length > 0 || await this.hasDurableInstanceOccupants(instanceId);
    if (occupied) return;
    instance.resetDeadline = this.now() + (instance.dungeon.reset.despawnAfterSeconds ?? 0) * 1_000;
  }

  private async resetInstance(instanceId: string, instance: DungeonInstanceState): Promise<void> {
    let nextRunId: string | null = null;
    if (!instance.legacySewer) {
      nextRunId = await rotateDungeonRunIfEmpty(this.pool, instanceId);
      if (!nextRunId) {
        instance.resetDeadline = null;
        return;
      }
    }
    this.resetInstanceState(instance, nextRunId);
  }

  /** Resets an empty instance in place; with a run id it also moves the instance onto that new run. */
  private resetInstanceState(instance: DungeonInstanceState, nextRunId: string | null, nextTorchTotal: number | null = null): void {
    const instanceId = this.instanceIdFor(instance);
    if (nextRunId) {
      instance.runId = nextRunId;
      // A new run re-rolls: same encounter ids, new generated placements, waves and run flags.
      const authored = this.catalog.dungeons.find((candidate) => candidate.id === instance.dungeon.id);
      if (authored) instance.dungeon = materializeDungeonRun(authored, nextRunId);
      instance.torchTotal = this.torchTotalForRun(nextTorchTotal);
      instance.runStartedAt = null;
      instance.deathsByPlayer.clear();
      instance.partyEntries.clear();
      instance.playerPartyEntries.clear();
      instance.bossCredits.clear();
    }
    for (const definition of instance.dungeon.encounters.filter((candidate) => !candidate.retired)) {
      const encounter = instance.encounters.get(definition.id);
      if (!encounter) continue;
      const shouldReset = definition.bossTemplateId
        ? instance.dungeon.reset.resetBoss
        : instance.dungeon.reset.resetEnemies;
      if (!shouldReset) continue;
      for (const entityId of encounter.spawnedMobIds.values()) {
        const boss = this.bossEncounters?.encounterForEntity(entityId);
        if (boss) this.bossEncounters?.despawn(boss.encounterId, "instance-reset");
        this.combat.despawnMob(entityId);
      }
      encounter.state = "idle";
      encounter.currentWaveId = null;
      encounter.attempts = 0;
      encounter.spawnedMobIds.clear();
      encounter.nextWaveAt = null;
      encounter.pendingWaveId = null;
    }
    for (const room of instance.dungeon.rooms) for (const object of room.objects.filter((candidate) => !candidate.retired)) {
      if ((object.type === "chest" && !instance.dungeon.reset.resetLoot) ||
          (object.type === "door" && !instance.dungeon.reset.resetDoors)) continue;
      instance.objectStates.set(objectKey(room.id, object.id), object.initialState);
      instance.objectAvailability.set(objectKey(room.id, object.id), object.available && dungeonObjectSpawnsInRun(instance.dungeon, instance.runId, room.id, object));
    }
    instance.portalLocks.clear();
    for (const portal of instance.dungeon.portals.filter((candidate) => !candidate.retired)) {
      instance.portalLocks.set(portal.id, false);
    }
    instance.flags.clear();
    instance.completed = false;
    instance.cues.length = 0;
    instance.notices.length = 0;
    instance.processedInteractions.clear();
    instance.processedResourceHarvests.clear();
    // Resource nodes belong to one run; a new run never inherits them.
    instance.resources.clear();
    this.initializeResources(instance);
    instance.zoneMembership.clear();
    instance.allPlayersPresent.clear();
    instance.pendingRewardScopes.clear();
    const now = this.now();
    // Run-flag triggers differ between rolled runs; drop the previous run's.
    instance.triggers.clear();
    for (const trigger of instance.dungeon.triggers.filter((candidate) => !candidate.retired)) {
      instance.triggers.set(trigger.id, {
        enabled: trigger.enabled, firedCount: 0, cooldowns: new Map(), sequenceIndexes: new Map(),
        timerDueAt: trigger.event.type === "timer" ? now + trigger.event.delayMs : null,
        firedScopes: new Set(), rewardEligible: new Set()
      });
    }
    instance.resetDeadline = null;
    instance.lastStatePersistAt = this.now();
    // The reset state is authoritative for this run id: nothing older to hydrate over it.
    this.hydratedRuns.set(instance, instance.runId);
    void this.persistInstanceState(instance).catch(() => undefined);
    void instanceId;
  }

  private async hasDurableInstanceOccupants(instanceId: string): Promise<boolean> {
    const result = await this.pool.query<{ occupied: boolean }>(
      "SELECT EXISTS(SELECT 1 FROM dungeon_presence WHERE instance_id=$1) AS occupied",
      [instanceId]
    );
    return result.rows[0]?.occupied === true;
  }

}

/** Keep authored combat identities stable and inside the protocol's 160-character limit. */
export function boundedDungeonCombatId(identity: string): string {
  return identity.length <= 160 ? identity : `dungeon:sha256:${createHash("sha256").update(identity).digest("hex")}`;
}

export { DungeonRuntime as CisternWarrensRuntime };

/**
 * The instance's current run when it is a paid run nobody entered and older than the TTL ($1 instance,
 * $2 TTL in ms). Pending = open stats with no entrants and no presence row in the instance.
 */
const STALE_PENDING_TORCH_RUN_SQL = `SELECT run.run_id::text
   FROM dungeon_instance_runs run
   JOIN dungeon_run_stats stats ON stats.run_id=run.run_id
  WHERE run.instance_id=$1 AND stats.ended_at IS NULL AND stats.party_size=0
    AND stats.started_at <= now() - ($2::double precision * interval '1 millisecond')
    AND NOT EXISTS (SELECT 1 FROM dungeon_presence presence WHERE presence.instance_id=$1)`;

async function lockDungeonInstance(
  queryable: Pick<pg.PoolClient, "query">,
  instanceId: string
): Promise<void> {
  await queryable.query(
    "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
    [instanceId]
  );
}

async function loadOrCreateDungeonRun(
  client: pg.PoolClient,
  instanceId: string,
  resetWhenEmpty = false
): Promise<string> {
  await lockDungeonInstance(client, instanceId);
  const existing = await client.query<{ run_id: string }>(
    "SELECT run_id::text FROM dungeon_instance_runs WHERE instance_id=$1 FOR UPDATE",
    [instanceId]
  );
  if (existing.rows[0]) {
    if (!resetWhenEmpty) return existing.rows[0].run_id;
    const occupied = await client.query<{ occupied: boolean }>(
      "SELECT EXISTS(SELECT 1 FROM dungeon_presence WHERE instance_id=$1) AS occupied",
      [instanceId]
    );
    if (occupied.rows[0]?.occupied) return existing.rows[0].run_id;
    // A run the torch lobby paid that nobody entered yet is the run to enter, never rotated away.
    if (await isPendingTorchRun(client, existing.rows[0].run_id)) return existing.rows[0].run_id;
    await endDungeonRunStats(client, existing.rows[0].run_id);
    const nextRunId = randomUUID();
    await client.query(
      `UPDATE dungeon_instance_runs
          SET run_id=$2::uuid,updated_at=now()
        WHERE instance_id=$1`,
      [instanceId, nextRunId]
    );
    return nextRunId;
  }
  const runId = randomUUID();
  await client.query(
    "INSERT INTO dungeon_instance_runs (instance_id,run_id) VALUES ($1,$2::uuid)",
    [instanceId, runId]
  );
  return runId;
}

/**
 * Adds the entrant to the run's stats row, creating it (the run's start) on the first entry.
 * Returns the run's start time.
 */
export async function recordDungeonRunEntry(
  client: Pick<pg.PoolClient, "query">,
  input: Readonly<{ runId: string; instanceId: string; dungeonId: string; tier: string | null;
    torchTotal: number; playerId: string }>
): Promise<number | null> {
  const result = await client.query<{ started_at: Date | string }>(
    `INSERT INTO dungeon_run_stats
       (run_id,instance_id,dungeon_id,tier,torch_total,party_size,deaths_by_player)
     VALUES ($1::uuid,$2,$3,$4,$5,1,jsonb_build_object($6::text,0))
     ON CONFLICT (run_id) DO UPDATE SET
       started_at=CASE WHEN dungeon_run_stats.party_size=0 THEN now() ELSE dungeon_run_stats.started_at END,
       deaths_by_player=jsonb_build_object($6::text,0) || dungeon_run_stats.deaths_by_player,
       party_size=(SELECT count(*) FROM jsonb_object_keys(
         jsonb_build_object($6::text,0) || dungeon_run_stats.deaths_by_player))
     RETURNING started_at`,
    [input.runId, input.instanceId, input.dungeonId, input.tier, input.torchTotal, input.playerId]
  );
  const startedAt = result?.rows?.[0]?.started_at;
  return startedAt === undefined ? null : new Date(startedAt).getTime();
}

/** A run the torch lobby paid (stats row, nobody entered yet). */
async function isPendingTorchRun(client: Pick<pg.PoolClient, "query">, runId: string): Promise<boolean> {
  const result = await client.query<{ pending: boolean }>(
    `SELECT EXISTS(SELECT 1 FROM dungeon_run_stats
       WHERE run_id=$1::uuid AND ended_at IS NULL AND party_size=0) AS pending`,
    [runId]
  );
  return result?.rows?.[0]?.pending === true;
}

/** Ends a run that rotates without a clear: 'wiped' when every entrant died, else 'abandoned'. */
export async function endDungeonRunStats(client: Pick<pg.PoolClient, "query">, runId: string): Promise<void> {
  await client.query(
    `UPDATE dungeon_run_stats
        SET ended_at=now(),
            duration_ms=GREATEST(0,floor(extract(epoch FROM (now()-started_at))*1000))::bigint,
            result=CASE WHEN party_size > 0 AND NOT EXISTS (
              SELECT 1 FROM jsonb_each_text(deaths_by_player) entry WHERE entry.value::integer = 0
            ) THEN 'wiped' ELSE 'abandoned' END
      WHERE run_id=$1::uuid AND ended_at IS NULL`,
    [runId]
  );
}

async function rotateDungeonRunIfEmpty(
  pool: pg.Pool,
  instanceId: string
): Promise<string | null> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await lockDungeonInstance(client, instanceId);
    const occupied = await client.query<{ occupied: boolean }>(
      "SELECT EXISTS(SELECT 1 FROM dungeon_presence WHERE instance_id=$1) AS occupied",
      [instanceId]
    );
    if (occupied.rows[0]?.occupied) {
      await client.query("COMMIT");
      return null;
    }
    const previous = await client.query<{ run_id: string }>(
      "SELECT run_id::text FROM dungeon_instance_runs WHERE instance_id=$1",
      [instanceId]
    );
    if (previous?.rows?.[0] && await isPendingTorchRun(client, previous.rows[0].run_id)) {
      await client.query("COMMIT");
      return null;
    }
    if (previous?.rows?.[0]) await endDungeonRunStats(client, previous.rows[0].run_id);
    const runId = randomUUID();
    await client.query(
      `INSERT INTO dungeon_instance_runs (instance_id,run_id,updated_at)
       VALUES ($1,$2::uuid,now())
       ON CONFLICT (instance_id) DO UPDATE
       SET run_id=EXCLUDED.run_id,updated_at=now()`,
      [instanceId, runId]
    );
    await client.query("COMMIT");
    return runId;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** Lockouts are per dungeon (not per entrance), so every entrance to a dungeon shares one cooldown. */
export function dungeonLockoutKey(dungeonId: string): string {
  return `dungeon:${dungeonId}`;
}

export function cisternWarrensDungeonKey(sewerId: string): string {
  return `cistern_warrens:${sewerId}`;
}

function randomYield(resource: ResourceRuntimeState, runId: string): number {
  return randomYieldDefinition(resource.minYield, resource.maxYield, resource.id, runId, resource.lifeRevision);
}

function randomYieldDefinition(
  minYield: number,
  maxYield: number,
  resourceId: string,
  runId: string,
  lifeRevision: number
): number {
  const minimum = Math.max(1, Math.min(minYield, maxYield));
  const maximum = Math.max(minimum, maxYield);
  return minimum + hashInt(`${resourceId}:${runId}:${lifeRevision}:yield`, maximum - minimum + 1);
}

function hashInt(seed: string, modulo: number): number {
  if (modulo <= 1) return 0;
  let hash = 2_166_136_261;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0) % modulo;
}

const randomPointInShape = randomDungeonPointInShape;

/** Smallest gap between two mobs spawned by one wave (the formation spacing). */
const SPAWN_MIN_SEPARATION = 36;

/** The point itself when it is clear of the taken ones, else the nearest ring point that is, walkable from it. */
export function separatedSpawnPoint(
  point: IndoorPoint,
  taken: readonly IndoorPoint[],
  navigation: IndoorRoomNavigation,
  room: Pick<DungeonRoomDefinition, "width" | "height">
): IndoorPoint {
  const clear = (candidate: IndoorPoint) =>
    taken.every((other) => Math.hypot(other.x - candidate.x, other.y - candidate.y) >= SPAWN_MIN_SEPARATION);
  if (clear(point)) return point;
  // Two rings at most, and only points the mob could walk to from where it was placed (never across a wall).
  for (let ring = 1; ring <= 2; ring += 1) {
    const steps = 6 * ring;
    for (let step = 0; step < steps; step += 1) {
      const angle = (Math.PI * 2 * step) / steps;
      const candidate = {
        x: clamp(point.x + Math.cos(angle) * SPAWN_MIN_SEPARATION * ring, 0, room.width),
        y: clamp(point.y + Math.sin(angle) * SPAWN_MIN_SEPARATION * ring, 0, room.height)
      };
      if (clear(candidate) && isIndoorNavigationSegmentWalkable(navigation, point, candidate)) return candidate;
    }
  }
  return point;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function applyJsonMap(
  value: unknown,
  apply: (key: string, value: unknown) => void
): void {
  if (!isRecord(value)) return;
  for (const [key, item] of Object.entries(value)) apply(key, item);
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function mapNumberValues(value: unknown): Map<string, number> {
  const result = new Map<string, number>();
  if (!isRecord(value)) return result;
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "number" && Number.isFinite(item)) result.set(key, item);
  }
  return result;
}

const CISTERN_WARRENS_ENTRANCE_ASSET_KEY = "apps/client/public/assets/dungeons/cistern_warrens/entrance.png";

function entranceFromRow(row: EntranceRow): DungeonEntranceSnapshot {
  return {
    entranceId: row.structure_id,
    dungeonId: CISTERN_WARRENS_DUNGEON.id,
    sewerId: row.structure_id,
    structureId: row.structure_id,
    portalId: portalIds.sewerWorldToEntrance(row.structure_id),
    portalRevision: row.placement_revision,
    interactionLabel: "Descend into Sewer",
    cityId: row.city_id,
    cityName: row.city_name,
    name: CISTERN_WARRENS_NAME,
    description: CISTERN_WARRENS_DESCRIPTION,
    regionCode: row.region_code ?? "world",
    lat: Number(row.lat),
    lon: Number(row.lon)
    ,
    interactionRadiusM: 35,
    footprintRadiusM: 8,
    presentation: "hatch",
    // The manhole art, not the stock cave.
    assetKey: CISTERN_WARRENS_ENTRANCE_ASSET_KEY
  };
}

function entranceFromCatalog(
  entrance: DungeonCatalog["entrances"][number],
  catalog: DungeonCatalog
): DungeonEntranceSnapshot {
  const dungeon = catalog.dungeons.find((candidate) => candidate.id === entrance.dungeonId)!;
  return {
    entranceId: entrance.id,
    dungeonId: entrance.dungeonId,
    portalId: portalIds.dungeon(entrance.id, entrance.portalId),
    portalRevision: boundedPortalRevision(`${entrance.revision}:${entrance.portalRevision}:${dungeon.revision}`),
    interactionLabel: entrance.interactionLabel,
    name: entrance.name,
    description: entrance.description,
    regionCode: packageIdForPosition(entrance),
    lat: entrance.lat,
    lon: entrance.lon,
    interactionRadiusM: entrance.interactionRadiusM,
    footprintRadiusM: entrance.footprintRadiusM,
    presentation: entrance.presentation,
    assetKey: entrance.assetKey
  };
}

function authoredInstanceId(
  entranceId: string,
  policy: DungeonDefinition["instancePolicy"],
  playerId: string,
  partyId: string | null
): string {
  const prefix = `dungeon:${entranceId}`;
  if (policy === "shared_persistent") return prefix;
  if (policy === "party_ephemeral" && partyId) return `${prefix}:party:${partyId}`;
  return `${prefix}:player:${playerId}`;
}

/** A cleared Golem Forge trash room refills this long after it was cleared (tunable). */
export const GOLEM_FORGE_TRASH_REFILL_MS = 2 * 60 * 60 * 1_000;
const GOLEM_FORGE_SWEEP_MS = 30_000;

/** A shared Golem Forge run gathers each party (or solo player) in its own torch lobby. */
function forgeLobbyKey(instanceId: string, playerId: string, partyId: string | null): string {
  return partyId ? `${instanceId}:party:${partyId}` : `${instanceId}:player:${playerId}`;
}

function forgePriceChanged(dungeon: DungeonDefinition, bossesAlive: number): DungeonError {
  return new DungeonError("DUNGEON_ENTRY_PRICE_CHANGED",
    `A boss fell in ${dungeon.name}: ${bossesAlive} ${bossesAlive === 1 ? "boss remains" : "bosses remain"} and ` +
    `each torch now costs ${describeDungeonEntryCost(golemForgeEntryCost(bossesAlive))}. Nobody was charged; ready up again.`);
}

function clamp(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) throw new DungeonError("INVALID_POSITION", "Invalid dungeon position.");
  return Math.max(minimum, Math.min(maximum, value));
}

/** A placement's torch set (absent = set 1) spawns only when the run burned that many torches. */
function torchSetSpawns(
  placement: DungeonRoomDefinition["mobs"][number],
  instance: Pick<DungeonInstanceState, "torchTotal">
): boolean {
  return (placement.partySet ?? 1) <= instance.torchTotal;
}

/** Entrance ids of developer-placed dungeon entrances (the Developer App's dungeon spawner). */
const DEVELOPER_DUNGEON_ENTRANCE_PREFIX = "dev-dungeon-";

function objectKey(roomId: string, objectId: string): string {
  return `${roomId}:${objectId}`;
}

function defaultInteractionState(kind: DungeonObjectSnapshot["kind"], state: ObjectState): ObjectState {
  if (state === "pressed") return "released";
  if (state === "released") return "pressed";
  if (kind === "valve" || kind === "switch") return state === "on" ? "off" : "on";
  if (kind === "door") return state === "open" ? "closed" : "open";
  if (kind === "chest") return state === "looted" ? "looted" : "looted";
  return state;
}

function eventMatches(
  expected: DungeonDefinition["triggers"][number]["event"],
  actual: RuntimeEvent,
  triggerId: string
): boolean {
  if (expected.type !== actual.type) return false;
  switch (expected.type) {
    case "room_enter":
    case "room_exit":
    case "room_clear": return expected.roomId === actual.roomId;
    case "zone_enter":
    case "zone_exit":
    case "all_players_present": return expected.roomId === actual.roomId && expected.zoneId === actual.zoneId;
    case "object_interact":
    case "object_destroyed": return expected.roomId === actual.roomId && expected.objectId === actual.objectId;
    case "object_state": return expected.roomId === actual.roomId && expected.objectId === actual.objectId && expected.state === actual.state;
    case "object_sequence": return actual.objectId === triggerId;
    case "portal_used": return expected.portalId === actual.portalId;
    case "timer": return actual.objectId === triggerId;
    case "encounter_state": return expected.encounterId === actual.encounterId && expected.state === actual.state;
    case "player_count": return compareCount(Number(actual.state ?? 0), expected.operator, expected.count);
    case "dungeon_flag": return expected.flagId === actual.flagId && expected.value === actual.value;
  }
}

function compareCount(value: number, operator: "at_least" | "at_most" | "exactly", count: number): boolean {
  return operator === "at_least" ? value >= count : operator === "at_most" ? value <= count : value === count;
}

function pointInGeometry(
  point: IndoorPoint,
  geometry: DungeonRoomDefinition["zones"][number]
): boolean {
  if (geometry.kind === "rectangle") {
    return point.x >= geometry.x && point.x <= geometry.x + geometry.width &&
      point.y >= geometry.y && point.y <= geometry.y + geometry.height;
  }
  let inside = false;
  for (let i = 0, j = geometry.points.length - 1; i < geometry.points.length; j = i++) {
    const a = geometry.points[i]!;
    const b = geometry.points[j]!;
    if ((a.y > point.y) !== (b.y > point.y) &&
        point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}
