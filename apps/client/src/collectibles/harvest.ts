import {
  isGivingTreeResinCapable,
  isElderFern,
  COLLECTIBLE_PICKUP_RADIUS_M,
  distanceMeters,
  moveToward,
  treeDisplayNameForStableId,
  treeProduceAvailable,
  type CollectibleNode,
  type HarvestSessionSnapshot,
  type LatLon,
  type PlayerSnapshot,
  type ResourceType
} from "@ash-atlas/shared";

import { getClosestInteractionApproachPoint } from "../movement/interactionApproach.js";
import { isLocalMovementTargetValid } from "../movement/localMovementValidation.js";

export const HARVEST_RANGE_M = COLLECTIBLE_PICKUP_RADIUS_M;
export const HARVEST_APPROACH_BUFFER_M = 5;
export const HARVEST_START_ACK_TIMEOUT_MS = 5_000;

export type HarvestPhase = "approaching" | "starting" | "harvesting" | "completing";
export const HARVEST_COMPLETION_RETRY_MS = 2_000;

export type HarvestTask = {
  nodeId: string;
  action: "primary" | "resin";
  phase: HarvestPhase;
  sessionId: string | null;
  completesAtMs: number | null;
  startedAtMs: number | null;
  startRequestedAtMs: number | null;
};

export type PendingMineClaim = Readonly<{
  nodeId: string;
  authorityRevision: number;
  movementRequestId: string;
  movementGeneration: number;
  movementRevision: number;
  connectionGeneration: number;
  relocationRevision: number;
}>;

export type MineClaimPlan =
  | Readonly<{ kind: "claim-now" }>
  | Readonly<{ kind: "approach"; target: LatLon }>
  | Readonly<{ kind: "unreachable" }>;

export type MineClaimTransition = "waiting" | "claim" | "cancel" | "unreachable";

export type PendingHarvestCompletion = Readonly<{
  sessionId: string;
  requestId: string | null;
  nodeId: string;
  lastAttemptAtMs: number;
}>;

export type QueuedHarvestReplacement = Readonly<{
  sourceNodeId: string;
  sourceRequestId: string | null;
  sourceSessionId: string | null;
  targetNodeId: string;
  targetAction: "primary" | "resin";
}>;

export function queueHarvestReplacement(
  current: QueuedHarvestReplacement | null,
  task: HarvestTask | null,
  pendingCompletion: PendingHarvestCompletion | null,
  sourceRequestId: string | null,
  targetNodeId: string,
  targetAction: "primary" | "resin"
): QueuedHarvestReplacement | null {
  if (current) return { ...current, targetNodeId, targetAction };
  const sourceNodeId = task?.nodeId ?? pendingCompletion?.nodeId;
  const sourceSessionId = task?.sessionId ?? pendingCompletion?.sessionId ?? null;
  if (!sourceNodeId) return null;
  return {
    sourceNodeId,
    sourceRequestId,
    sourceSessionId,
    targetNodeId,
    targetAction
  };
}

export function attachQueuedHarvestSourceSession(
  queued: QueuedHarvestReplacement,
  requestId: string,
  nodeId: string,
  sessionId: string
): QueuedHarvestReplacement | null {
  return queued.sourceSessionId === null &&
    queued.sourceRequestId === requestId &&
    queued.sourceNodeId === nodeId
    ? { ...queued, sourceSessionId: sessionId }
    : null;
}

export function queuedHarvestMatchesSettlement(
  queued: QueuedHarvestReplacement | null,
  nodeId: string,
  sessionId: string
): queued is QueuedHarvestReplacement {
  return queued?.sourceNodeId === nodeId && queued.sourceSessionId === sessionId;
}

export function queuedHarvestMatchesRequestSettlement(
  queued: QueuedHarvestReplacement | null,
  nodeId: string,
  requestId: string
): queued is QueuedHarvestReplacement {
  return queued?.sourceNodeId === nodeId && queued.sourceRequestId === requestId;
}

export function queuedHarvestMatchesCompletion(
  queued: QueuedHarvestReplacement | null,
  nodeId: string,
  sessionId: string,
  requestId: string
): queued is QueuedHarvestReplacement {
  return queuedHarvestMatchesSettlement(queued, nodeId, sessionId) &&
    (queued.sourceRequestId === null || queued.sourceRequestId === requestId);
}

export function correlateQueuedHarvestCompletionRequest(
  queued: QueuedHarvestReplacement | null,
  task: HarvestTask | null,
  pendingCompletion: PendingHarvestCompletion | null,
  requestId: string | null
): QueuedHarvestReplacement | null {
  if (!queued || !requestId) return queued;
  const sourceNodeId = task?.nodeId ?? pendingCompletion?.nodeId;
  const sourceSessionId = task?.sessionId ?? pendingCompletion?.sessionId;
  return queued.sourceNodeId === sourceNodeId &&
    queued.sourceSessionId === sourceSessionId
    ? { ...queued, sourceRequestId: requestId }
    : queued;
}

type HarvestCompletionReplayAttempt = Readonly<{
  requestId: string;
  outcome: Readonly<{ status: string }>;
}>;

type MutableRef<T> = { current: T };

export function replayPendingHarvestCompletion(
  pendingCompletionRef: MutableRef<PendingHarvestCompletion | null>,
  requestSentRef: MutableRef<string | null>,
  send: (
    sessionId: string
  ) => HarvestCompletionReplayAttempt | null | undefined,
  nowMs = Date.now(),
  force = false
): "none" | "sent" | "retained" | "released" {
  const pending = pendingCompletionRef.current;
  if (pending === null) return "none";
  if (
    !force &&
    (
      pending.requestId !== null ||
      nowMs - pending.lastAttemptAtMs < HARVEST_COMPLETION_RETRY_MS
    )
  ) return "retained";
  let attempt: HarvestCompletionReplayAttempt | null | undefined;
  try {
    attempt = send(pending.sessionId);
  } catch {
    attempt = null;
  }
  if (!attempt) {
    pendingCompletionRef.current = {
      ...pending,
      requestId: null,
      lastAttemptAtMs: nowMs
    };
    requestSentRef.current = null;
    return "retained";
  }
  if (attempt.outcome.status !== "sent") {
    if (
      attempt.outcome.status === "intentionally-disconnected" ||
      attempt.outcome.status === "protocol-incompatible" ||
      (
        attempt.outcome.status === "send-failed" &&
        "failure" in attempt.outcome &&
        attempt.outcome.failure === "serialization"
      )
    ) {
      pendingCompletionRef.current = null;
      requestSentRef.current = null;
      return "released";
    }
    pendingCompletionRef.current = {
      ...pending,
      requestId: null,
      lastAttemptAtMs: nowMs
    };
    requestSentRef.current = null;
    return "retained";
  }
  pendingCompletionRef.current = {
    ...pending,
    requestId: attempt.requestId,
    lastAttemptAtMs: nowMs
  };
  requestSentRef.current = attempt.requestId;
  return "sent";
}

export function pendingHarvestCompletion(
  task: HarvestTask,
  nowMs: number
): PendingHarvestCompletion | null {
  if (!task.sessionId) return null;
  return {
    sessionId: task.sessionId,
    requestId: null,
    nodeId: task.nodeId,
    lastAttemptAtMs: nowMs - HARVEST_COMPLETION_RETRY_MS
  };
}

export function markHarvestCompletionInFlight(task: HarvestTask): HarvestTask {
  return {
    ...task,
    phase: "completing"
  };
}

export type HarvestCancellationRequest = Readonly<{
  stopMovement: boolean;
  sessionId: string | null;
  pendingStartNodeId: string | null;
}>;

export function canStartHarvestInteraction(
  task: HarvestTask | null,
  pendingCompletion: PendingHarvestCompletion | null
): boolean {
  return task === null && pendingCompletion === null;
}

export function planHarvestCancellation(
  task: HarvestTask | null,
  stopMovement: boolean
): HarvestCancellationRequest | null {
  if (task === null || task.phase === "completing") return null;
  return {
    stopMovement,
    sessionId: task.sessionId,
    pendingStartNodeId:
      task.phase === "starting" && task.sessionId === null
        ? task.nodeId
        : null
  };
}

export type HarvestTransition = {
  task: HarvestTask | null;
  shouldStart: boolean;
  shouldComplete: boolean;
  resinPresentationNodeId: string | null;
  cancellationReason: "out-of-range" | "start-timeout" | null;
};

export function resourceDisplayName(resourceType: ResourceType): string {
  if (resourceType === "iron") return "Iron Ore";
  if (resourceType === "shell") return "Shell (Legacy)";
  return resourceType
    .replaceAll("_", " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

export function collectibleDisplayName(collectible: CollectibleNode, nowMs = Date.now()): string {
  if (collectible.repeatableNodeType) {
    return collectible.type === "iron"
      ? "Iron Mine"
      : `${resourceDisplayName(collectible.type)} Mine`;
  }
  return collectible.type === "wood"
    ? treeDisplayNameForStableId(collectible.id, collectibleProduceAvailable(collectible, nowMs))
    : resourceDisplayName(collectible.type);
}

/** Berries on a Giving Tree or sap on a Elder Fern, ready to take now (the "resin" action). */
export function collectibleProduceAvailable(
  collectible: Pick<CollectibleNode, "id" | "type" | "repeatableNodeType" | "berryAvailable" | "sapReadyAt">,
  nowMs = Date.now()
): boolean {
  return collectible.type === "wood" && !collectible.repeatableNodeType
    && treeProduceAvailable(collectible, nowMs);
}

/** Label of the tree's produce action: "Harvest Frond Sap" on a Elder Fern, else "Gather Berries". */
export function treeProduceActionLabel(collectible: Pick<CollectibleNode, "id">): string {
  return isElderFern(collectible.id) ? "Harvest Frond Sap" : "Gather Berries";
}

export function collectibleQuickHarvestAction(collectible: CollectibleNode): "primary" | "resin" {
  return collectibleProduceAvailable(collectible) ? "resin" : "primary";
}

export function harvestActionLabel(collectible: CollectibleNode, action: "primary" | "resin" = "primary"): "Chop" | "Gather" {
  if (action === "resin") return "Gather";
  return collectible.type === "wood" && !collectible.repeatableNodeType
    ? "Chop"
    : "Gather";
}

export function harvestActivityLabel(
  collectible: Pick<CollectibleNode, "repeatableNodeType" | "type">
): "Chopping" | "Mining" | "Harvesting" {
  return collectible.repeatableNodeType
    ? "Mining"
    : collectible.type === "wood"
      ? "Chopping"
      : "Harvesting";
}

/** Menu label while this node's gather is walking up or running: "Chopping", "Mining"... */
export function harvestInProgressLabel(
  collectible: Pick<CollectibleNode, "repeatableNodeType" | "type"> & Partial<Pick<CollectibleNode, "id">>,
  action: "primary" | "resin" = "primary"
): string {
  if (action === "resin") {
    return collectible.id !== undefined && isElderFern(collectible.id) ? "Tapping Frond Sap" : "Gathering Berries";
  }
  const activity = harvestActivityLabel(collectible);
  return activity === "Harvesting" ? "Gathering" : activity;
}

export function resolveActiveHarvestCollectible(
  task: HarvestTask | null,
  collectibles: readonly CollectibleNode[]
): CollectibleNode | null {
  return task
    ? collectibles.find((collectible) => collectible.id === task.nodeId) ?? null
    : null;
}

export type HarvestActor = Pick<PlayerSnapshot, "lat" | "lon">;

/**
 * Whether gathering commands may be sent. Above ground that needs the world player snapshot;
 * a map-rendered interior carries the player in its room snapshot instead, so the world
 * player may be absent there and the loaded room is the readiness signal.
 */
export function harvestConnectionReady(input: {
  connectionStatus: "online" | "connecting" | "offline";
  hasWorldPlayer: boolean;
  interiorRoomLoaded: boolean | null;
}): boolean {
  if (input.connectionStatus !== "online") return false;
  return input.interiorRoomLoaded === null
    ? input.hasWorldPlayer
    : input.interiorRoomLoaded;
}

export function collectibleHarvestAvailability(
  collectible: CollectibleNode,
  activeTask: HarvestTask | null,
  connected: boolean,
  pendingCompletion: PendingHarvestCompletion | null = null
): { enabled: boolean; disabledReason: string | null } {
  const activeNodeId = activeTask?.nodeId ?? pendingCompletion?.nodeId ?? null;
  if (activeNodeId === collectible.id) {
    return {
      enabled: false,
      disabledReason: "Finish the current gathering action first."
    };
  }
  if (collectible.repeatableState === "depleted") {
    return {
      enabled: false,
      disabledReason: "This resource is not ready yet."
    };
  }
  if (
    collectible.repeatableNodeType !== undefined &&
    collectible.repeatableOwnerPlayerId !== null &&
    collectible.repeatableAccessMode === "private" &&
    collectible.repeatableCanManage !== true
  ) {
    return { enabled: false, disabledReason: "This mine is private." };
  }
  if (!connected) {
    return {
      enabled: false,
      disabledReason: "Cannot gather while disconnected."
    };
  }
  return { enabled: true, disabledReason: null };
}

export function distanceToCollectible(
  player: HarvestActor,
  collectible: CollectibleNode
): number {
  return distanceMeters(
    { lat: player.lat, lon: player.lon },
    { lat: collectible.lat, lon: collectible.lon }
  );
}

export function getClosestHarvestApproachPoint(
  playerPosition: LatLon,
  nodePosition: LatLon,
  harvestRadiusM = HARVEST_RANGE_M,
  bufferM = HARVEST_APPROACH_BUFFER_M
): LatLon | null {
  return getClosestInteractionApproachPoint(
    playerPosition,
    nodePosition,
    harvestRadiusM,
    bufferM
  );
}

export function getClosestReachableHarvestApproachPoint(
  player: Pick<
    PlayerSnapshot,
    "lat" | "lon" | "anchorLat" | "anchorLon" | "moveLeashRadiusM"
  >,
  nodePosition: LatLon,
  harvestRadiusM = HARVEST_RANGE_M,
  bufferM = HARVEST_APPROACH_BUFFER_M
): LatLon | null {
  const preferred = getClosestHarvestApproachPoint(
    { lat: player.lat, lon: player.lon },
    nodePosition,
    harvestRadiusM,
    bufferM
  );
  if (!preferred || isLocalMovementTargetValid(player, preferred)) {
    return preferred;
  }

  const anchor = { lat: player.anchorLat, lon: player.anchorLon };
  const requiredDistanceFromNodeM = Math.max(
    0,
    distanceMeters(anchor, nodePosition) - player.moveLeashRadiusM
  );
  if (requiredDistanceFromNodeM > harvestRadiusM) return null;

  const bufferedDistanceFromNodeM = Math.max(
    0,
    harvestRadiusM - Math.max(0, bufferM)
  );
  const reachable = moveToward(
    nodePosition,
    anchor,
    Math.max(bufferedDistanceFromNodeM, requiredDistanceFromNodeM)
  );
  return isLocalMovementTargetValid(player, reachable) &&
    distanceMeters(reachable, nodePosition) <= harvestRadiusM
    ? reachable
    : null;
}

export function planMineClaim(
  player: Pick<
    PlayerSnapshot,
    "lat" | "lon" | "anchorLat" | "anchorLon" | "moveLeashRadiusM"
  >,
  nodePosition: LatLon,
  harvestRadiusM = HARVEST_RANGE_M,
  bufferM = HARVEST_APPROACH_BUFFER_M
): MineClaimPlan {
  if (distanceMeters(player, nodePosition) <= harvestRadiusM) {
    return { kind: "claim-now" };
  }
  const target = getClosestReachableHarvestApproachPoint(
    player,
    nodePosition,
    harvestRadiusM,
    bufferM
  );
  return target
    ? { kind: "approach", target }
    : { kind: "unreachable" };
}

export function advanceMineClaimApproach(input: Readonly<{
  pending: PendingMineClaim;
  node: CollectibleNode | null;
  player: Pick<
    PlayerSnapshot,
    "lat" | "lon" | "moving" | "movementRevision" | "relocationRevision"
  > | null;
  movement: Readonly<{ requestId: string; generation: number }> | null;
  connectionGeneration: number;
  harvestRadiusM?: number;
}>): MineClaimTransition {
  const {
    pending,
    node,
    player,
    movement,
    connectionGeneration,
    harvestRadiusM = HARVEST_RANGE_M
  } = input;
  if (
    !node
    || node.id !== pending.nodeId
    || node.repeatableNodeType === undefined
    || node.repeatableOwnerPlayerId !== null
    || (node.repeatableRevision ?? 0) !== pending.authorityRevision
    || !player
    || (player.relocationRevision ?? 0) !== pending.relocationRevision
    || connectionGeneration !== pending.connectionGeneration
    || !movement
    || movement.requestId !== pending.movementRequestId
    || movement.generation !== pending.movementGeneration
  ) {
    return "cancel";
  }
  if (player.movementRevision < pending.movementRevision) {
    return "cancel";
  }
  if (player.movementRevision === pending.movementRevision || player.moving) {
    return "waiting";
  }
  return distanceMeters(player, node) <= harvestRadiusM
    ? "claim"
    : "unreachable";
}

export function startHarvestTask(
  player: HarvestActor,
  collectible: CollectibleNode,
  action: "primary" | "resin" = "primary",
  nowMs = Date.now()
): HarvestTask {
  const inRange = distanceToCollectible(player, collectible) <= HARVEST_RANGE_M;
  return {
    nodeId: collectible.id,
    action,
    phase: inRange ? "starting" : "approaching",
    sessionId: null,
    completesAtMs: null,
    startedAtMs: null,
    startRequestedAtMs: inRange ? nowMs : null
  };
}

export function attachHarvestSession(
  task: HarvestTask,
  session: HarvestSessionSnapshot,
  serverTimeMs: number,
  clientNowMs = Date.now()
): HarvestTask {
  if (session.nodeId !== task.nodeId || session.status !== "active") {
    throw new Error("Harvest session does not match the active collectible");
  }
  return {
    nodeId: task.nodeId,
    action: task.action,
    phase: "harvesting",
    sessionId: session.sessionId,
    completesAtMs: clientDeadlineMs(session.completesAt, serverTimeMs, clientNowMs),
    startedAtMs: clientDeadlineMs(session.startedAt, serverTimeMs, clientNowMs),
    startRequestedAtMs: null
  };
}

export function resumeHarvestTask(
  session: HarvestSessionSnapshot,
  serverTimeMs: number,
  clientNowMs = Date.now()
): HarvestTask {
  if (session.status !== "active") {
    throw new Error("Only active harvest sessions can be resumed");
  }
  return {
    nodeId: session.nodeId,
    action: (session.resourceType === "balsam_resin" || session.resourceType === "giving_berry") ? "resin" : "primary",
    phase: "harvesting",
    sessionId: session.sessionId,
    completesAtMs: clientDeadlineMs(session.completesAt, serverTimeMs, clientNowMs),
    startedAtMs: clientDeadlineMs(session.startedAt, serverTimeMs, clientNowMs),
    startRequestedAtMs: null
  };
}

export function advanceHarvestTask(
  task: HarvestTask,
  player: HarvestActor,
  collectible: CollectibleNode,
  nowMs: number
): HarvestTransition {
  const inRange = distanceToCollectible(player, collectible) <= HARVEST_RANGE_M;
  if (task.phase === "approaching") {
    return inRange
      ? {
          task: { ...task, phase: "starting", startRequestedAtMs: nowMs },
          shouldStart: true,
          shouldComplete: false,
          resinPresentationNodeId: null,
          cancellationReason: null
        }
      : {
          task,
          shouldStart: false,
          shouldComplete: false,
          resinPresentationNodeId: null,
          cancellationReason: null
        };
  }

  if (
    task.phase === "starting" &&
    task.startRequestedAtMs !== null &&
    nowMs - task.startRequestedAtMs >= HARVEST_START_ACK_TIMEOUT_MS
  ) {
    return {
      task: null,
      shouldStart: false,
      shouldComplete: false,
      resinPresentationNodeId: null,
      cancellationReason: "start-timeout"
    };
  }

  if (!inRange) {
    return {
      task: null,
      shouldStart: false,
      shouldComplete: false,
      resinPresentationNodeId: null,
      cancellationReason: "out-of-range"
    };
  }

  if (
    task.phase === "harvesting" &&
    task.sessionId &&
    task.completesAtMs !== null &&
    nowMs >= task.completesAtMs
  ) {
    return {
      task,
      shouldStart: false,
      shouldComplete: true,
      resinPresentationNodeId:
        task.action === "resin" && collectible.berryAvailable === true
          ? task.nodeId
          : null,
      cancellationReason: null
    };
  }

  return {
    task,
    shouldStart: false,
    shouldComplete: false,
    resinPresentationNodeId: null,
    cancellationReason: null
  };
}

export function setCollectibleResinAvailability(
  collectibles: CollectibleNode[],
  nodeId: string,
  resinAvailable: boolean
): CollectibleNode[] {
  const index = collectibles.findIndex((collectible) => collectible.id === nodeId);
  const collectible = collectibles[index];
  if (!collectible || !isGivingTreeResinCapable(collectible.id)
    || collectible.berryAvailable === resinAvailable) {
    return collectibles;
  }
  const updated = [...collectibles];
  updated[index] = { ...collectible, berryAvailable: resinAvailable };
  return updated;
}

export function harvestRemainingMs(task: HarvestTask, nowMs: number): number {
  if (task.phase !== "harvesting" || task.completesAtMs === null) {
    return 0;
  }
  return Math.max(0, task.completesAtMs - nowMs);
}

function clientDeadlineMs(
  deadline: string,
  serverTimeMs: number,
  clientNowMs: number
): number {
  return clientNowMs + (Date.parse(deadline) - serverTimeMs);
}

export function gatheringProgressForTask(
  task: HarvestTask | null,
  collectible: CollectibleNode | null,
  nowMs: number
): {
  nodeId: string;
  label: "Chopping" | "Mining" | "Harvesting";
  progress: number;
  remainingMs: number;
} | null {
  if (
    !task || task.phase !== "harvesting" || !collectible ||
    collectible.id !== task.nodeId || task.startedAtMs === null || task.completesAtMs === null
  ) return null;
  const durationMs = task.completesAtMs - task.startedAtMs;
  if (durationMs <= 0) return null;
  return {
    nodeId: task.nodeId,
    label: task.action === "resin" ? "Harvesting" : harvestActivityLabel(collectible),
    progress: Math.min(1, Math.max(0, (nowMs - task.startedAtMs) / durationMs)),
    remainingMs: Math.max(0, task.completesAtMs - nowMs)
  };
}
