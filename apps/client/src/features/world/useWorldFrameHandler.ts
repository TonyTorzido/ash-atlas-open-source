import {
  distanceMeters,
  isFiniteLatLon,
  type CollectibleNode,
  type PlayerDeltaUpsert,
  type PlayerSnapshot,
  type PopulationPreparationReason,
  type WorldMapDestination,
  type WorldMapDestinationSnapshot,
  type WorldServerMessage
} from "@ash-atlas/shared";
import {
  useCallback,
  useEffect,
  useRef,
  startTransition,
  type Dispatch,
  type SetStateAction
} from "react";

import type { HarvestTask } from "../../collectibles/harvest.js";
import {
  removeCollectiblesFromPresentation
} from "../../collectibles/collectibleReconciliation.js";
import {
  WorldResourcePresentationStore
} from "../../collectibles/worldResourcePresentationStore.js";
import { recordShoreHint } from "../../movement/shoreSlide.js";
import { gameplayLatencyTrace } from "../../diagnostics/gameplayLatencyTrace.js";
import type { RenderState } from "../../map/mapObjects.js";
import type { PixiGameOverlay } from "../../map/pixiOverlay.js";
import {
  clearPostArrivalTravelBinding,
  type LocalMovementRequestTracker
} from "../../movement/localMovementRequests.js";
import { recordMovementTrace } from "../../movement/movementDebugTrace.js";
import {
  handleLocalMoveAccepted,
  snapshotSequenceBaseline
} from "../../movement/playerMessageHandling.js";
import {
  applyPlayerDelta,
  playerDeltaAction
} from "../../movement/playerReplication.js";
import type { PlayerRenderTimeline } from "../../movement/playerRenderSmoothing.js";
import type {
  QueuedMapFlagBuild,
  QueuedMapFlagBuildController
} from "../../movement/queuedMapFlagBuild.js";
import { perfMetrics } from "../../perf/perfMetrics.js";
import { perfRecorder } from "../../perf/perfRecorder.js";
import { dashClientState } from "../../movement/dash.js";
import { swingClientState, type SwingResolution } from "../../combat/swing.js";
import { progressionRecorder } from "../../perf/progressionRecorder.js";
import {
  applyPopulationZoneDelta,
  coalescePopulationZoneDeltas,
  populationDeltaAuthorityKey,
  type PopulationZoneDelta,
  type PopulationPreparationProgress,
  type PopulationZoneProjectionState
} from "../../population/populationZoneProjection.js";
import type { StartupEvent } from "../../startupState.js";
import { frameClockNow } from "../../map/frameClock.js";
import type {
  WorldViewConvergenceBarrier
} from "../../worldView/worldViewConvergenceBarrier.js";
import type {
  WorldViewEpochInstallationResult
} from "../../worldView/committedWorldViewEpoch.js";

type RefCell<T> = { current: T };

const WORLD_FRAME_TYPES = new Set<string>([
  "WORLD_MAP_DESTINATIONS",
  "MAP_MARKERS_STATE",
  "MAP_MARKERS_ERROR",
  "PLAYER_SNAPSHOT",
  "PLAYER_DELTA",
  "MOVE_ACCEPTED",
  "DASH_ACCEPTED",
  "SWING_RESULT",
  "RAFT_REQUIRED",
  "POPULATION_ZONE_DELTA",
  "POPULATION_RESYNC_RESULT"
]);

const LEGACY_POPULATION_PREPARATION_WARNING =
  "The land could not be prepared. Try again shortly.";

export function isWorldServerMessage(
  message: { type: string }
): message is WorldServerMessage {
  return WORLD_FRAME_TYPES.has(message.type);
}

export interface WorldFrameHandlerOptions {
  ownPlayerId: string;
  populationFrameBatchingEnabled?: boolean;
  dispatchStartup(event: StartupEvent): void;
  localPlayerRef: RefCell<PlayerSnapshot | null>;
  relocationRevisionRef: RefCell<number>;
  resourceVisionRevisionRef: RefCell<number>;
  pendingTravelRequestIdRef: RefCell<string | null>;
  postArrivalTravelRequestIdRef: RefCell<string | null>;
  postArrivalTravelRequestExpiresAtRef: RefCell<number>;
  firstPlayerSnapshotRef: RefCell<boolean>;
  pendingWorldResyncReasonRef: RefCell<string | null>;
  playerDeltaSequenceRef: RefCell<number>;
  playerRenderTimeline: PlayerRenderTimeline;
  setPlayers: Dispatch<SetStateAction<PlayerSnapshot[]>>;
  setLastSnapshotAt: Dispatch<SetStateAction<number | null>>;
  setWarning: Dispatch<SetStateAction<string | null>>;
  requestWorldResync(reason: string): void;
  onInitialPlayerSnapshot(player: PlayerSnapshot): void;
  installCommittedWorldViewEpoch(
    player: PlayerSnapshot
  ): WorldViewEpochInstallationResult;
  populationZoneProjectionRef: RefCell<PopulationZoneProjectionState>;
  presentationStoreRef?: RefCell<WorldResourcePresentationStore>;
  worldViewBarrierRef?: RefCell<WorldViewConvergenceBarrier>;
  setPopulationPreparationProgress:
    Dispatch<SetStateAction<PopulationPreparationProgress>>;
  onPopulationResyncResult(
    message: Extract<WorldServerMessage, { type: "POPULATION_RESYNC_RESULT" }>
  ): void;
  renderStateRef: RefCell<RenderState>;
  overlayRef: RefCell<PixiGameOverlay | null>;
  setCollectibles: Dispatch<SetStateAction<CollectibleNode[]>>;
  harvestTaskRef: RefCell<HarvestTask | null>;
  selectedCollectibleIdRef: RefCell<string | null>;
  settleHarvestAfterAuthoritativeRemoval(nodeId: string): void;
  clearOptimisticResinPresentation(nodeId?: string): void;
  setSelectedCollectibleId: Dispatch<SetStateAction<string | null>>;
  localMovementRequests: LocalMovementRequestTracker;
  queuedMapFlagBuild: QueuedMapFlagBuildController;
  setQueuedMapFlagBuild: Dispatch<SetStateAction<QueuedMapFlagBuild | null>>;
  setWorldMapSnapshot: Dispatch<SetStateAction<WorldMapDestinationSnapshot | null>>;
  /** Water travel: the move enters ocean or lake and needs a raft launch confirmation. */
  onRaftRequired?(message: Extract<WorldServerMessage, { type: "RAFT_REQUIRED" }>): void;
  /** A SWING_RESULT reconciled a pending swing (Phase 4 predicted hit effects hook in here). */
  onSwingResolved?(resolution: SwingResolution): void;
}

export function useWorldFrameHandler(options: WorldFrameHandlerOptions) {
  const {
    ownPlayerId,
    populationFrameBatchingEnabled = false,
    dispatchStartup,
    localPlayerRef,
    relocationRevisionRef,
    resourceVisionRevisionRef,
    pendingTravelRequestIdRef,
    postArrivalTravelRequestIdRef,
    postArrivalTravelRequestExpiresAtRef,
    firstPlayerSnapshotRef,
    pendingWorldResyncReasonRef,
    playerDeltaSequenceRef,
    playerRenderTimeline,
    setPlayers,
    setLastSnapshotAt,
    setWarning,
    requestWorldResync,
    onInitialPlayerSnapshot,
    installCommittedWorldViewEpoch,
    populationZoneProjectionRef,
    presentationStoreRef: providedPresentationStoreRef,
    worldViewBarrierRef,
    setPopulationPreparationProgress,
    onPopulationResyncResult,
    renderStateRef,
    overlayRef,
    setCollectibles,
    harvestTaskRef,
    selectedCollectibleIdRef,
    settleHarvestAfterAuthoritativeRemoval,
    clearOptimisticResinPresentation,
    setSelectedCollectibleId,
    localMovementRequests,
    queuedMapFlagBuild,
    setQueuedMapFlagBuild,
    setWorldMapSnapshot,
    onRaftRequired,
    onSwingResolved
  } = options;
  const fallbackPresentationStoreRef = useRef(
    new WorldResourcePresentationStore(renderStateRef.current.collectibles)
  );
  const presentationStoreRef =
    providedPresentationStoreRef ?? fallbackPresentationStoreRef;
  const populationFramesRef = useRef(
    new Map<string, PopulationZoneDelta[]>()
  );
  const populationFrameRequestRef = useRef<number | null>(null);
  const flushingPopulationFramesRef = useRef(false);
  const handleWorldFrameRef = useRef<
    (message: WorldServerMessage) => void
  >(() => undefined);
  // Mid-walk position deltas skip React: the map reads positions from the
  // render timeline, so they only need to reach `players` a few times a second.
  const pendingPlayerDeltasRef = useRef<PendingPlayerDelta[]>([]);
  const playerDeltaFlushTimerRef = useRef<number | null>(null);
  const walkingPlayerIdsRef = useRef(new Set<string>());
  const flushPlayerDeltas = useCallback((lowPriority = false): void => {
    if (playerDeltaFlushTimerRef.current !== null) {
      window.clearTimeout(playerDeltaFlushTimerRef.current);
      playerDeltaFlushTimerRef.current = null;
    }
    const pending = pendingPlayerDeltasRef.current;
    if (pending.length === 0) return;
    pendingPlayerDeltasRef.current = [];
    const commit = (): void => {
      setPlayers((current) => pending.reduce(
        (players, delta) =>
          applyPlayerDelta(players, delta.upserts, delta.removedPlayerIds),
        current
      ));
      setLastSnapshotAt(performance.now());
    };
    // Mid-walk commits are not urgent (the map reads the render timeline): a transition lets taps, the joystick and the
    // map frame run first and lets React drop a stale render when a newer one arrives.
    if (lowPriority) startTransition(commit);
    else commit();
  }, [setLastSnapshotAt, setPlayers]);
  const dropPendingPlayerDeltas = useCallback((): void => {
    if (playerDeltaFlushTimerRef.current !== null) {
      window.clearTimeout(playerDeltaFlushTimerRef.current);
      playerDeltaFlushTimerRef.current = null;
    }
    pendingPlayerDeltasRef.current = [];
  }, []);
  useEffect(() => () => {
    if (populationFrameRequestRef.current !== null) {
      cancelAnimationFrame(populationFrameRequestRef.current);
    }
    populationFrameRequestRef.current = null;
    populationFramesRef.current.clear();
    dropPendingPlayerDeltas();
  }, [dropPendingPlayerDeltas]);

  const handleWorldFrame = useCallback((
    message: WorldServerMessage
  ): void => {
    switch (message.type) {
      // Map Marker frames are consumed by the Map Markers feature before this handler.
      case "MAP_MARKERS_STATE":
      case "MAP_MARKERS_ERROR":
        return;
      case "WORLD_MAP_DESTINATIONS":
        setWorldMapSnapshot((current) =>
          current && sameWorldMapDestinations(
            current.destinations,
            message.snapshot.destinations
          )
            ? current
            : message.snapshot
        );
        return;
      case "PLAYER_SNAPSHOT": {
        const authoritativePlayer = message.players.find(
          (candidate) => candidate.playerId === ownPlayerId
        );
        if (
          !authoritativePlayer ||
          !isFiniteLatLon(authoritativePlayer.lat, authoritativePlayer.lon)
        ) {
          dispatchStartup({
            type: "error",
            message: authoritativePlayer
              ? "The server returned invalid player coordinates."
              : "The player snapshot did not include the signed-in player."
          });
          return;
        }
        if (message.players.some(
          (candidate) => !isFiniteLatLon(candidate.lat, candidate.lon)
        )) {
          dispatchStartup({
            type: "error",
            message: "The server returned an invalid player snapshot."
          });
          return;
        }
        if (
          installCommittedWorldViewEpoch(authoritativePlayer) ===
          "stale-epoch-ignored"
        ) {
          return;
        }
        localPlayerRef.current = authoritativePlayer;
        relocationRevisionRef.current = authoritativePlayer.relocationRevision ?? 0;
        clearPostArrivalTravelBinding({
          requestId: postArrivalTravelRequestIdRef,
          expiresAt: postArrivalTravelRequestExpiresAtRef
        });
        const isInitialPlayerSnapshot = !firstPlayerSnapshotRef.current;
        const snapshotReason = pendingWorldResyncReasonRef.current ??
          (firstPlayerSnapshotRef.current ? "server-resync-or-backpressure" : "initial");
        pendingWorldResyncReasonRef.current = null;
        if (!firstPlayerSnapshotRef.current) {
          firstPlayerSnapshotRef.current = true;
          perfMetrics.markLoadMilestone("first player snapshot");
        }
        playerDeltaSequenceRef.current = snapshotSequenceBaseline(message);
        dropPendingPlayerDeltas();
        walkingPlayerIdsRef.current = new Set(
          message.players
            .filter((player) => player.moving)
            .map((player) => player.playerId)
        );
        playerRenderTimeline.applySnapshot(
          message.players,
          message.serverTime,
          frameClockNow(),
          // The real receipt time feeds the server clock offset (dead reckoning by server time); timeline values use frames.
          { sequence: message.sequence, reason: snapshotReason, receivedAtMs: performance.now() }
        );
        setPlayers(message.players);
        if (isInitialPlayerSnapshot) onInitialPlayerSnapshot(authoritativePlayer);
        dispatchStartup({ type: "player" });
        dispatchStartup({ type: "location" });
        setLastSnapshotAt(performance.now());
        return;
      }
      case "PLAYER_DELTA": {
        if (message.upserts.some((candidate) => {
          if (candidate.kind === "full") {
            return !isFiniteLatLon(candidate.player.lat, candidate.player.lon);
          }
          const targetIsValid = candidate.targetLat === null && candidate.targetLon === null
            ? true
            : isFiniteLatLon(candidate.targetLat, candidate.targetLon);
          return !isFiniteLatLon(candidate.lat, candidate.lon) || !targetIsValid;
        })) {
          setWarning(
            "Ignored a player update with invalid coordinates and requested a fresh snapshot."
          );
          requestWorldResync("invalid-player-coordinates");
          return;
        }
        const sequenceAction = playerDeltaAction(
          playerDeltaSequenceRef.current,
          message.sequence
        );
        if (!sequenceAction.apply) return;
        // A gap still applies (absolute per-player state) and asks for a resync, so a lost or late delta never
        // freezes movement until the rate-limited snapshot arrives.
        if (sequenceAction.resync) requestWorldResync("player-sequence-gap");
        playerDeltaSequenceRef.current = message.sequence;
        playerRenderTimeline.applyDelta(
          message.upserts,
          message.removedPlayerIds,
          message.serverTime,
          // On the display frame's clock (map/frameClock.ts), so the prediction never runs past the next frame's time.
          frameClockNow(),
          { sequence: message.sequence, receivedAtMs: performance.now() }
        );
        pendingPlayerDeltasRef.current.push({
          upserts: message.upserts,
          removedPlayerIds: message.removedPlayerIds
        });
        const midWalk = isMidWalkPlayerDelta(
          message.upserts,
          message.removedPlayerIds,
          walkingPlayerIdsRef.current
        );
        trackWalkingPlayers(
          walkingPlayerIdsRef.current,
          message.upserts,
          message.removedPlayerIds
        );
        if (midWalk) {
          playerDeltaFlushTimerRef.current ??= window.setTimeout(
            () => flushPlayerDeltas(true),
            MID_WALK_PLAYER_COMMIT_INTERVAL_MS
          );
        } else {
          flushPlayerDeltas();
        }
        return;
      }
      case "POPULATION_ZONE_DELTA": {
        if (
          populationFrameBatchingEnabled
          && !flushingPopulationFramesRef.current
        ) {
          const key = populationDeltaAuthorityKey(message);
          const pending = populationFramesRef.current.get(key) ?? [];
          pending.push(message);
          populationFramesRef.current.set(key, pending);
          if (populationFrameRequestRef.current === null) {
            populationFrameRequestRef.current = requestAnimationFrame(() => {
              populationFrameRequestRef.current = null;
              const groups = [...populationFramesRef.current.values()];
              populationFramesRef.current.clear();
              flushingPopulationFramesRef.current = true;
              try {
                for (const group of groups) {
                  handleWorldFrameRef.current(
                    coalescePopulationZoneDeltas(group)
                  );
                }
              } finally {
                flushingPopulationFramesRef.current = false;
              }
            });
          }
          return;
        }
        const projection = applyPopulationZoneDelta(
          populationZoneProjectionRef.current,
          message,
          {
            playerId: ownPlayerId,
            relocationRevision: relocationRevisionRef.current,
            resourceVisionRevision: resourceVisionRevisionRef.current
          }
        );
        if (!projection.accepted) return;
        const travelTraceId = message.preparationTrigger === "flag-travel"
          ? pendingTravelRequestIdRef.current ??
            postArrivalTravelRequestIdRef.current
          : null;
        if (travelTraceId) {
          gameplayLatencyTrace.record(
            "population",
            "population_required_visible_applied",
            {
              relocationRevision: message.relocationRevision,
              preparationGeneration: message.preparationGeneration,
              preparationReason: message.preparationReason,
              populationState: populationStateForPreparationReason(
                message.preparationReason
              ),
              destinationZoneId:
                message.zoneSnapshots[0]?.zoneId ??
                message.activatedZoneIds[0] ??
                message.retainedZoneIds[0] ??
                null,
              populationOwnerRequestId: travelTraceId,
              preparationAuthority: message.requiredForGameplay
                ? "destination-critical"
                : "background",
              visibleZoneCount: message.visibleZoneCount,
              readyVisibleZoneCount: message.readyVisibleZoneCount,
              upsertCount: message.upserts.length,
              partial: message.partial,
              terminal: message.terminal
            },
            { traceId: travelTraceId }
          );
        }
        populationZoneProjectionRef.current = projection.state;
        setPopulationPreparationProgress(projection.preparationProgress);
        if (projection.preparationProgress.status === "ready") {
          setWarning((current) =>
            current === LEGACY_POPULATION_PREPARATION_WARNING
              ? null
              : current
          );
        }
        const gameplayViewCircle = renderStateRef.current.gameplayViewCircle;
        const collectibleUpserts = gameplayViewCircle
          ? projection.collectibleUpserts.filter((node) =>
              distanceMeters(gameplayViewCircle.center, node) <=
                gameplayViewCircle.radiusM
            )
          : [];
        const removedCollectibleIds =
          projection.removedCollectibleIds;
        removeCollectiblesFromPresentation({
          removals: [...removedCollectibleIds].map((nodeId) => ({
            nodeId,
            stateRevision: undefined,
            domain: "population" as const,
            reason: "explicit-server-removal" as const
          })),
          renderStateRef,
          presentationStoreRef,
          populationZoneProjectionRef,
          harvestTaskRef,
          selectedCollectibleIdRef,
          overlayRef,
          setCollectibles,
          setSelectedCollectibleId,
          settleHarvestAfterAuthoritativeRemoval,
          clearOptimisticResinPresentation
        });
        const nextCollectibles = presentationStoreRef.current.replacePopulation(
          collectibleUpserts,
          removedCollectibleIds,
          projection.replacesProjection,
          projection.state.authority
            ? [
                projection.state.authority.playerId,
                projection.state.authority.connectionId,
                projection.state.authority.connectionGeneration,
                projection.state.authority.preparationGeneration,
                projection.state.authority.relocationRevision,
                projection.state.authority.resourceVisionRevision,
                projection.state.authority.gameplayViewGeneration
              ].join(":")
            : undefined
        );
        renderStateRef.current = {
          ...renderStateRef.current,
          collectibles: nextCollectibles
        };
        setCollectibles(nextCollectibles);
        overlayRef.current?.update(renderStateRef.current);
        worldViewBarrierRef?.current.observePopulation(
          {
            playerId: message.playerId,
            connectionId: message.connectionId,
            connectionGeneration: message.connectionGeneration,
            relocationRevision: message.relocationRevision,
            resourceVisionRevision: message.resourceVisionRevision,
            gameplayViewGeneration: message.gameplayViewGeneration,
            populationPreparationGeneration:
              message.preparationGeneration
          },
          message.requiredForGameplay &&
            message.terminal &&
            (
              message.preparationResult === "degraded" ||
              (
                message.preparationResult === "ready" &&
                message.readyVisibleZoneCount === message.visibleZoneCount
              )
            )
        );
        if (
          travelTraceId &&
          message.requiredForGameplay &&
          message.terminal &&
          (
            message.preparationResult === "degraded" ||
            (
              message.preparationResult === "ready" &&
              message.readyVisibleZoneCount === message.visibleZoneCount
            )
          )
        ) {
          gameplayLatencyTrace.record(
            "ui",
            "population_required_visible_presented",
            {
              relocationRevision: message.relocationRevision,
              preparationGeneration: message.preparationGeneration,
              preparationReason: message.preparationReason,
              populationState: populationStateForPreparationReason(
                message.preparationReason
              ),
              visibleZoneCount: message.visibleZoneCount,
              readyVisibleZoneCount: message.readyVisibleZoneCount,
              entityCount: nextCollectibles.length
            },
            { traceId: travelTraceId }
          );
        }
        return;
      }
      case "POPULATION_RESYNC_RESULT":
        onPopulationResyncResult(message);
        return;
      case "MOVE_ACCEPTED": {
        const acceptance = handleLocalMoveAccepted(localMovementRequests, message);
        const accepted = acceptance.status === "accepted";
        perfRecorder.recordEvent("local_movement_accepted", {
          requestId: message.requestId,
          movementGeneration: acceptance.request?.generation ?? -1,
          movementRevision: message.movementRevision,
          acceptance: acceptance.status,
          accepted
        });
        recordMovementTrace({
          messageType: "MOVE_ACCEPTED",
          requestId: message.requestId,
          movementGeneration: acceptance.request?.generation ?? null,
          movementRevision: message.movementRevision,
          target: message.target,
          outcome: accepted ? "accepted" : "ignored",
          reason: acceptance.status
        });
        if (!accepted) return;
        recordShoreHint(message.shore, performance.now());
        if (
          acceptance.request?.boundTravelRequestId ===
            postArrivalTravelRequestIdRef.current
        ) {
          clearPostArrivalTravelBinding({
            requestId: postArrivalTravelRequestIdRef,
            expiresAt: postArrivalTravelRequestExpiresAtRef
          }, acceptance.request?.boundTravelRequestId ?? null);
        }
        const queuedGesture = queuedMapFlagBuild.accept(
          message.requestId,
          message.movementRevision
        );
        if (queuedGesture) setQueuedMapFlagBuild(queuedGesture);
        playerRenderTimeline.acceptLocalAnticipation(
          message.requestId,
          message.target,
          message.movementRevision,
          message.speedOrigin && message.speedSegments
            ? { origin: message.speedOrigin, segments: message.speedSegments }
            : null,
          message.speedMps ?? null
        );
        setWarning(null);
        progressionRecorder.recordEvent({ type: "movement" });
        return;
      }
      case "DASH_ACCEPTED": {
        const acceptance = handleLocalMoveAccepted(localMovementRequests, {
          type: "MOVE_ACCEPTED",
          requestId: message.requestId,
          movementRevision: message.movementRevision,
          target: message.to
        });
        const measurement = dashClientState.accepted(message.requestId, message.to, performance.now(), message.from);
        if (measurement) {
          perfRecorder.recordEvent("dash_accepted", {
            requestId: message.requestId,
            pressToAcceptMs: measurement.pressToAcceptMs,
            correctionM: measurement.correctionM,
            startOffsetM: measurement.startOffsetM
          });
          gameplayLatencyTrace.record("movement", "dash_acceptance_received", {
            requestId: message.requestId,
            pressToAcceptMs: measurement.pressToAcceptMs,
            correctionM: measurement.correctionM,
            startOffsetM: measurement.startOffsetM
          }, { traceId: message.requestId });
        }
        if (acceptance.status !== "accepted") return;
        playerRenderTimeline.acceptLocalAnticipation(message.requestId, message.to, message.movementRevision);
        return;
      }
      case "RAFT_REQUIRED": {
        // The move was not started: settle the predicted step, then offer the launch.
        playerRenderTimeline.rejectLocalAnticipation(message.requestId, frameClockNow());
        localMovementRequests.reset();
        onRaftRequired?.(message);
        return;
      }
      case "SWING_RESULT": {
        // Action combat: confirm or cancel the pending swing, and take the server's combo and recovery.
        const nowMs = performance.now();
        const resolution = swingClientState.result(message, nowMs, swingClientState.serverNow());
        if (resolution) {
          if (!resolution.rejected) perfMetrics.noteSwingPressToResult(resolution.pressToResultMs);
          perfRecorder.recordEvent("swing_result", {
            requestId: message.requestId,
            seq: message.seq,
            comboIndex: message.comboIndex,
            hits: message.hits.length,
            rejected: resolution.rejected ?? null,
            pressToResultMs: resolution.pressToResultMs
          });
          // Phase 4 hooks in here: resolution.confirmedHitIds keep their predicted effects,
          // resolution.missedPredictedIds get their flash and nudge cancelled.
          onSwingResolved?.(resolution);
        }
        return;
      }
    }
  }, [
    clearOptimisticResinPresentation,
    dispatchStartup,
    firstPlayerSnapshotRef,
    harvestTaskRef,
    installCommittedWorldViewEpoch,
    localMovementRequests,
    localPlayerRef,
    onInitialPlayerSnapshot,
    onRaftRequired,
    onSwingResolved,
    ownPlayerId,
    overlayRef,
    pendingTravelRequestIdRef,
    populationFrameBatchingEnabled,
    postArrivalTravelRequestIdRef,
    postArrivalTravelRequestExpiresAtRef,
    pendingWorldResyncReasonRef,
    playerDeltaSequenceRef,
    playerRenderTimeline,
    populationZoneProjectionRef,
    presentationStoreRef,
    queuedMapFlagBuild,
    relocationRevisionRef,
    renderStateRef,
    requestWorldResync,
    resourceVisionRevisionRef,
    selectedCollectibleIdRef,
    setCollectibles,
    setLastSnapshotAt,
    setPlayers,
    setPopulationPreparationProgress,
    setQueuedMapFlagBuild,
    setSelectedCollectibleId,
    setWarning,
    settleHarvestAfterAuthoritativeRemoval,
    setWorldMapSnapshot,
    dropPendingPlayerDeltas,
    flushPlayerDeltas
  ]);
  handleWorldFrameRef.current = handleWorldFrame;
  return handleWorldFrame;
}

const MID_WALK_PLAYER_COMMIT_INTERVAL_MS = 250;

interface PendingPlayerDelta {
  upserts: readonly PlayerDeltaUpsert[];
  removedPlayerIds: readonly string[];
}

// Joins, leaves, starts, stops and full records commit at once; only players
// who were already walking and still are wait for the next batched commit.
function isMidWalkPlayerDelta(
  upserts: readonly PlayerDeltaUpsert[],
  removedPlayerIds: readonly string[],
  walkingPlayerIds: ReadonlySet<string>
): boolean {
  return removedPlayerIds.length === 0 && upserts.every((upsert) =>
    upsert.kind === "movement" &&
    upsert.moving &&
    upsert.online &&
    walkingPlayerIds.has(upsert.playerId)
  );
}

function trackWalkingPlayers(
  walkingPlayerIds: Set<string>,
  upserts: readonly PlayerDeltaUpsert[],
  removedPlayerIds: readonly string[]
): void {
  for (const playerId of removedPlayerIds) walkingPlayerIds.delete(playerId);
  for (const upsert of upserts) {
    const player = upsert.kind === "full" ? upsert.player : upsert;
    if (player.moving) walkingPlayerIds.add(player.playerId);
    else walkingPlayerIds.delete(player.playerId);
  }
}

function populationStateForPreparationReason(
  reason: PopulationPreparationReason
): "cold" | "warm" | "indeterminate" {
  if (
    reason === "initial-world-generation" ||
    reason === "generation-missing" ||
    reason === "generation-expired" ||
    reason === "replacement-required"
  ) return "cold";
  if (
    reason === "ready" ||
    reason === "durable-rehydration" ||
    reason === "simulation-activation"
  ) return "warm";
  return "indeterminate";
}

function sameWorldMapDestinations(
  current: readonly WorldMapDestination[],
  next: readonly WorldMapDestination[]
): boolean {
  return current.length === next.length && current.every((destination, index) => {
    const candidate = next[index];
    return Boolean(
      candidate &&
      destination.kind === candidate.kind &&
      destination.id === candidate.id &&
      destination.name === candidate.name &&
      destination.lat === candidate.lat &&
      destination.lon === candidate.lon &&
      (destination.visible !== false) === (candidate.visible !== false) &&
      (
        destination.kind !== "kingdom" ||
        (candidate.kind === "kingdom" && destination.seatId === candidate.seatId)
      )
    );
  });
}
