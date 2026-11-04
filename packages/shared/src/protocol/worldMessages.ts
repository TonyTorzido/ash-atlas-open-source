import type { PlayerInventorySnapshot } from "../collectibles.js";
import type { MapMarkersState } from "../mapMarkers.js";
import type { WorldMapDestinationSnapshot } from "../worldMap.js";
import type { PlayerDashSnapshot, PlayerSnapshot } from "../playerSnapshotContracts.js";
import type { LatLon } from "../types.js";
import type { ResourceType } from "../collectibles.js";
import type { MoveSpeedSegment, WaterShoreHint } from "../waterTravel.js";
import type { SwingComboIndex, SwingRejectReason } from "../actionCombat.js";

export type PlayerDeltaUpsert =
  | { kind: "full"; player: PlayerSnapshot }
  | {
      kind: "movement";
      playerId: string;
      lat: number;
      lon: number;
      movementRevision: number;
      relocationRevision?: number;
      targetLat: number | null;
      targetLon: number | null;
      moving: boolean;
      online: boolean;
      updatedAt: string;
      dash?: PlayerDashSnapshot | null;
      /** Owner's own upsert only: effective walking speed (m/s) the server tick applies on land. */
      speedMps?: number;
    };

export type PopulationZoneEntitySnapshot = Readonly<{
  entityId: string;
  zoneId: string;
  generationId: string | null;
  kind: string;
  archetype: string;
  position: LatLon;
  homePosition: LatLon;
  stateRevision: number;
  resinAvailable?: boolean;
  berryAvailable?: boolean;
  /** Elder Ferns only: when the sap refills after the last tap (null: never tapped). */
  sapReadyAt?: string | null;
}>;

export type PopulationPreparationTrigger =
  | "world-entry"
  | "reconnect"
  | "flag-travel"
  | "party-travel"
  | "flag-placement"
  | "separate-space-exit"
  | "administrative-relocation"
  | "explicit-relocation"
  | "flag-construction";

export type PopulationPreparationScope =
  | "required-visible"
  | "prepared-radius"
  | "neighbor-preload";

export type PopulationPreparationResult =
  | "pending"
  | "ready"
  | "degraded"
  | "retryable-failure"
  | "stale"
  | "cancelled";

export const POPULATION_PREPARATION_REASONS = [
  "initial-world-generation",
  "generation-missing",
  "generation-expired",
  "replacement-required",
  "plan-pending",
  "plan-terminal-failure",
  "durable-rehydration",
  "simulation-activation",
  "backpressure-retry",
  "guarded-materialization",
  "unsupported-kind-isolated",
  "ready",
  "stale-authority",
  "cancelled"
] as const;

export type PopulationPreparationReason =
  (typeof POPULATION_PREPARATION_REASONS)[number];

export type PopulationResyncOutcome =
  | "republished"
  | "relocation-started"
  | "already-current"
  | "rate-limited"
  | "ignored-stale"
  | "unavailable";

export type WorldServerMessage =
  | { type: "MAP_MARKERS_STATE"; requestId?: string; state: MapMarkersState; notice?: string; inventory?: PlayerInventorySnapshot }
  | { type: "MAP_MARKERS_ERROR"; requestId?: string; code: string; message: string }
  | { type: "WORLD_MAP_DESTINATIONS"; requestId?: string; snapshot: WorldMapDestinationSnapshot }
  | { type: "PLAYER_SNAPSHOT"; serverTime: number; sequence: number; players: PlayerSnapshot[] }
  | {
      type: "PLAYER_DELTA";
      serverTime: number;
      sequence: number;
      upserts: PlayerDeltaUpsert[];
      removedPlayerIds: string[];
    }
  | {
      type: "MOVE_ACCEPTED";
      requestId: string;
      movementRevision: number;
      target: LatLon;
      /** Effective walking speed (m/s) on land: base x clamp(0.2..2, movement multiplier). Optional (older servers). */
      speedMps?: number;
      /** Water travel: speed breakpoints measured from `speedOrigin` along the straight path. */
      speedOrigin?: LatLon;
      speedSegments?: MoveSpeedSegment[];
      /** Walking next to open water: the shore wall for client slide prediction. */
      shore?: WaterShoreHint;
    }
  | {
      /** DASH accepted: the authoritative (leash/edge-clamped) path and timing, in server epoch ms. */
      type: "DASH_ACCEPTED";
      requestId: string;
      movementRevision: number;
      from: LatLon;
      to: LatLon;
      startedAt: number;
      until: number;
      cooldownUntil: number;
      iframeUntil: number;
    }
  | {
      /**
       * Answer to SWING. Confirms or cancels the client's predicted hits and corrects the combo
       * and cooldown; damage floaters still come from DAMAGE combat events. `nextSwingAt` is
       * server epoch ms. `hits` holds at most SWING_MAX_TARGETS entries.
       */
      type: "SWING_RESULT";
      requestId: string;
      seq: number;
      serverTick: number;
      comboIndex: SwingComboIndex;
      nextSwingAt: number;
      hits: Array<{ entityId: string; damage: number; currentHealth: number }>;
      rejected?: SwingRejectReason;
    }
  | {
      /** The move enters ocean or lake from land; confirm with MOVE_TO launchRaft. */
      type: "RAFT_REQUIRED";
      requestId: string;
      target: LatLon;
      cost: Array<{ itemId: ResourceType; quantity: number }>;
    }
  | {
      type: "POPULATION_ZONE_DELTA";
      playerId: string;
      connectionId: string;
      connectionGeneration: number;
      preparationGeneration: number;
      preparationTrigger: PopulationPreparationTrigger;
      preparationScope: PopulationPreparationScope;
      requiredForGameplay: boolean;
      relocationRevision: number;
      resourceVisionRevision: number;
      gameplayViewGeneration: number;
      retainedZoneIds: string[];
      activatedZoneIds: string[];
      releasedZoneIds: string[];
      withheldZoneIds: string[];
      upserts: PopulationZoneEntitySnapshot[];
      removedEntityIds: string[];
      visibleZoneCount: number;
      readyVisibleZoneCount: number;
      backgroundZoneCount: number;
      readyBackgroundZoneCount: number;
      zoneSnapshots: Array<{
        zoneId: string;
        generationId: string | null;
        entityIds: string[];
      }>;
      preparationReason: PopulationPreparationReason;
      preparationResult: PopulationPreparationResult;
      partial: boolean;
      terminal: boolean;
    }
  | {
      type: "POPULATION_RESYNC_RESULT";
      requestId: string;
      outcome: PopulationResyncOutcome;
      playerId: string;
      connectionId: string;
      connectionGeneration: number;
      requestedPreparationGeneration: number;
      currentPreparationGeneration: number | null;
      requestedRelocationRevision: number;
      currentRelocationRevision: number;
      requestedResourceVisionRevision: number;
      currentResourceVisionRevision: number;
      preparationReason: PopulationPreparationReason | null;
      preparationResult: PopulationPreparationResult | null;
      visibleZoneCount: number;
      readyVisibleZoneCount: number;
      terminal: boolean;
    };
