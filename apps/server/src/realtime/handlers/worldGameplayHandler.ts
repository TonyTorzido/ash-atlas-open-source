import { RAFT_LAUNCH_COST, distanceMeters, isWithinWorldEdge, type ServerMessage, type WaterShoreHint } from "@ash-atlas/shared";

import { gameplayLatencyTrace } from "../../diagnostics/gameplayLatencyTrace.js";
import type { AppLogger } from "../../logger.js";
import type { CisternWarrensRuntime } from "../../game/dungeon.js";
import type { FlagBuildCoordinator } from "../../game/flagBuildCoordinator.js";
import type { FlagHardeningCoordinator } from "../../game/flagHardeningCoordinator.js";
import type { FlagBurnCoordinator } from "../../game/flagBurning.js";
import type { FlagRepairCoordinator } from "../../game/flagRepairing.js";
import type { GameState, WaterLeg } from "../../game/state.js";
import { validateMoveTarget } from "../../game/validation.js";
import type { WaterTravelService } from "../../game/waterTravel.js";
import type { WorldCommandInput } from "../../game/worldCommandQueue.js";
import type { WorldRuntime } from "../../game/worldRuntime.js";
import type { WorldLookupClient } from "../../world/worldLookupClient.js";
import type { RealtimeFamilyHandler, RealtimeMessageRouter } from "../messageRouter.js";
import { requireHello, type RealtimeConnectionState } from "./handlerExecutionContext.js";

type ConnectionWorldCommand = WorldCommandInput extends infer Command
  ? Command extends WorldCommandInput
    ? Omit<Command, "playerId" | "accountId" | "connectionId">
    : never
  : never;

export type WorldGameplayHandlerContext = Readonly<{
  state: Pick<RealtimeConnectionState, "playerId">;
  logger: AppLogger;
  worldLookup?: WorldLookupClient | undefined;
  gameState: GameState;
  worldRuntime?: WorldRuntime | undefined;
  flagBuilds: FlagBuildCoordinator | null;
  flagHardenings: FlagHardeningCoordinator;
  flagBurns?: FlagBurnCoordinator;
  flagRepairs?: FlagRepairCoordinator;
  cancelPendingManorEntry(
    playerId: string,
    options?: {
      stopMovement?: boolean;
      notify?: boolean;
      message?: string;
    }
  ): boolean;
  /** Inside a run the dungeon runtime owns position, so DASH is planned against the room instead of the world. */
  dungeon?: Pick<CisternWarrensRuntime, "isInside" | "dash" | "snapshotForPlayer"> | undefined;
  enqueueWorldCommand(command: ConnectionWorldCommand): boolean;
  runMovementLifecycle<T>(operation: () => Promise<T>): Promise<T>;
  /** Water travel (raft rule and water speed). Absent: movement behaves as before. */
  waterTravel?: Pick<WaterTravelService, "planMove" | "launchRaft" | "planCombatApproach"> | undefined;
  send?(message: ServerMessage): void;
  cancelCityConstructionForMovement?(playerId: string): Promise<void>;
  cancelCityFlagConversionForMovement?(playerId: string): void;
  cancelFurnaceConstructionForMovement?(playerId: string): Promise<void>;
  cancelTanneryConstructionForMovement?(playerId: string): Promise<void>;
  cancelLoomConstructionForMovement?(playerId: string): Promise<void>;
  cancelKitchenConstructionForMovement?(playerId: string): Promise<void>;
  cancelGreenhouseConstructionForMovement?(playerId: string): Promise<void>;
  cancelGreenhouseWaterFillForMovement?(playerId: string): Promise<void>;
  cancelBomberDemolitionsForMovement?(playerId: string): Promise<void>;
  cancelFishingConstructionForMovement?(playerId: string): Promise<void>;
  cancelFishingForMovement?(playerId: string): Promise<void>;
}>;

export function createWorldGameplayHandler(
  context: WorldGameplayHandlerContext
): RealtimeFamilyHandler<"world-gameplay"> {
  return async (message) => {
    const {
      state,
      logger,
      worldLookup,
      gameState,
      worldRuntime,
      flagBuilds,
      flagHardenings,
      flagRepairs,
      cancelPendingManorEntry,
      enqueueWorldCommand,
      runMovementLifecycle,
      cancelCityConstructionForMovement,
      cancelCityFlagConversionForMovement,
      cancelFurnaceConstructionForMovement,
      cancelTanneryConstructionForMovement,
      cancelLoomConstructionForMovement,
      cancelKitchenConstructionForMovement,
      cancelGreenhouseConstructionForMovement,
      cancelGreenhouseWaterFillForMovement,
      cancelBomberDemolitionsForMovement,
      cancelFishingConstructionForMovement,
      cancelFishingForMovement,
      waterTravel,
      send
    } = context;
    const launchRaftForMove = async (
      playerId: string,
      requestId: string
    ): Promise<"launched" | "raft-required" | "insufficient"> => {
      const launch = await waterTravel!.launchRaft(playerId, requestId);
      if (launch.status === "insufficient") return "insufficient";
      if (launch.status === "replayed") {
        // The same request id already paid for a raft: never charge or grant twice.
        return gameState.isAfloat(playerId) ? "launched" : "raft-required";
      }
      send?.({
        type: "PLAYER_RESOURCES_UPDATED",
        playerId,
        inventory: launch.inventory,
        serverTime: Date.now()
      });
      return "launched";
    };
    switch (message.type) {
      case "DASH": {
        requireHello(state.playerId);
        const playerId = state.playerId!;
        const receivedAtMs = performance.now();
        if (message.lastDash) {
          // The client's own measurement of its previous dash (press to DASH_ACCEPTED, correction).
          logger.info({
            event: "dash_client_measurement",
            playerId,
            requestId: message.lastDash.requestId,
            pressToAcceptMs: Math.round(message.lastDash.pressToAcceptMs),
            correctionM: Math.round(message.lastDash.correctionM * 100) / 100,
            startOffsetM: message.lastDash.startOffsetM === undefined
              ? null
              : Math.round(message.lastDash.startOffsetM * 100) / 100
          }, "dash client measurement");
          gameplayLatencyTrace.record(playerId, {
            traceId: message.lastDash.requestId,
            source: "game",
            category: "movement",
            name: "dash_client_measurement",
            details: {
              requestId: message.lastDash.requestId,
              pressToAcceptMs: message.lastDash.pressToAcceptMs,
              correctionM: message.lastDash.correctionM,
              startOffsetM: message.lastDash.startOffsetM ?? null
            }
          });
        }
        if (context.dungeon?.isInside(playerId)) {
          try {
            const dash = context.dungeon.dash(playerId, message.dirX, message.dirY);
            send?.({
              type: "DASH_ACCEPTED",
              requestId: message.requestId,
              movementRevision: dash.movementRevision,
              from: dash.from,
              to: dash.to,
              startedAt: dash.startedAtMs,
              until: dash.untilMs,
              cooldownUntil: dash.cooldownUntilMs,
              iframeUntil: dash.iframeUntilMs
            });
            const snapshot = context.dungeon.snapshotForPlayer(playerId);
            if (snapshot) send?.({ type: "DUNGEON_SNAPSHOT", snapshot });
          } catch (error) {
            send?.({
              type: "ERROR",
              requestId: message.requestId,
              code: "DASH_REJECTED",
              message: error instanceof Error ? error.message : "You can't dash right now."
            });
          }
          return;
        }
        if (worldRuntime?.hasPlayerWorldTransition(playerId)) {
          send?.({ type: "ERROR", requestId: message.requestId, code: "DASH_REJECTED", message: "You can't dash while travelling." });
          return;
        }
        await runMovementLifecycle(async () => {
          let maxDistanceM: number | undefined;
          try {
            const provisionalEnd = gameState.planDash(playerId, message.dirX, message.dirY);
            const water = waterTravel?.planCombatApproach(playerId, provisionalEnd);
            if (water?.blocked) {
              send?.({ type: "ERROR", requestId: message.requestId, code: "DASH_REJECTED", message: "You can't dash into the water." });
              return;
            }
            const start = gameState.getPlayer(playerId)?.position;
            if (water && start) maxDistanceM = distanceMeters(start, water.target) + 0.5;
          } catch (error) {
            send?.({
              type: "ERROR",
              requestId: message.requestId,
              code: "DASH_REJECTED",
              message: error instanceof Error ? error.message : "You can't dash right now."
            });
            gameplayLatencyTrace.record(playerId, {
              traceId: message.requestId,
              source: "game",
              category: "movement",
              name: "dash_rejected",
              details: { requestId: message.requestId, reason: error instanceof Error ? error.message : "unknown" },
              failure: true
            });
            return;
          }
          cancelPendingManorEntry(playerId, {
            notify: true,
            message: "Manor entry was cancelled by a new movement command."
          });
          cancelCityFlagConversionForMovement?.(playerId);
          const accepted = enqueueWorldCommand({
            kind: "dash",
            requestId: message.requestId,
            dirX: message.dirX,
            dirY: message.dirY,
            receivedAtMs,
            ...(maxDistanceM !== undefined ? { maxDistanceM } : {})
          });
          if (accepted) {
            flagHardenings.cancelPlayer(playerId, "movement");
            flagRepairs?.cancelPlayer(playerId, "movement");
            flagBuilds?.cancelPlayer(playerId, "movement");
          }
        });
        return;
      }
      case "SWING": {
        requireHello(state.playerId);
        // Not a movement command: no movement lifecycle, no construction/flag cancels.
        // Recovery, combo and lag clamping are the engine's job when the command is processed.
        enqueueWorldCommand({
          kind: "swing",
          requestId: message.requestId,
          seq: message.seq,
          dirX: message.dirX,
          dirY: message.dirY,
          lagMs: message.lagMs,
          receivedAtMs: performance.now()
        });
        return;
      }
      case "MOVE_TO": {
        requireHello(state.playerId);
        cancelPendingManorEntry(state.playerId, {
          notify: true,
          message: "Manor entry was cancelled by a new movement command."
        });
        const movementReceivedAt = performance.now();
        const beforeMovement = state.playerId ? gameState.getPlayer(state.playerId) : null;
        gameplayLatencyTrace.record(state.playerId, {
          traceId: message.requestId,
          source: "game",
          category: "movement",
          name: "movement_message_received",
          details: {
            requestId: message.requestId,
            requestedLat: message.lat,
            requestedLon: message.lon,
            startLat: beforeMovement?.position.lat ?? null,
            startLon: beforeMovement?.position.lon ?? null,
            targetActiveBefore: Boolean(beforeMovement?.target),
            movementRevisionBefore: beforeMovement?.movementRevision ?? null,
            relocationRevision: beforeMovement?.relocationRevision ?? null
          }
        });
        const handleMovement = async (planWater: boolean) => {
          const requestedTarget = validateMoveTarget(message.lat, message.lon);
          if (!isWithinWorldEdge(requestedTarget)) {
            // Past the world edge: skip every movement side effect and let the
            // world runtime answer MOVE_REJECTED with the edge message.
            enqueueWorldCommand({ kind: "move", requestId: message.requestId, target: requestedTarget });
            return;
          }
          let target = requestedTarget;
          let waterLeg: WaterLeg | undefined;
          let shore: WaterShoreHint | undefined;
          if (planWater && waterTravel && state.playerId) {
            const plan = await waterTravel.planMove(state.playerId, requestedTarget, { walk: message.walk === true });
            if (plan?.needsRaft) {
              const rejected = !message.launchRaft
                ? "raft-required"
                : await launchRaftForMove(state.playerId, message.requestId);
              if (rejected === "raft-required") {
                send?.({
                  type: "RAFT_REQUIRED",
                  requestId: message.requestId,
                  target: requestedTarget,
                  cost: RAFT_LAUNCH_COST.map((material) => ({ ...material }))
                });
                return;
              }
              if (rejected === "insufficient") {
                send?.({
                  type: "ERROR",
                  requestId: message.requestId,
                  code: "MOVE_REJECTED",
                  message: `Launching a raft needs ${RAFT_LAUNCH_COST
                    .map((material) => `${material.quantity} ${material.itemId.replace(/_/gu, " ")}`)
                    .join(", ")}.`
                });
                return;
              }
            }
            if (plan) {
              target = plan.target;
              waterLeg = plan.leg;
              shore = plan.shore;
            }
          }
          if (state.playerId) cancelCityFlagConversionForMovement?.(state.playerId);
          if (
            state.playerId &&
            gameState.isMovementBlocked(state.playerId, "furnace-construction")
          ) {
            await cancelFurnaceConstructionForMovement?.(state.playerId);
          }
          if (
            state.playerId &&
            gameState.isMovementBlocked(state.playerId, "tannery-construction")
          ) {
            await cancelTanneryConstructionForMovement?.(state.playerId);
          }
          if (
            state.playerId &&
            gameState.isMovementBlocked(state.playerId, "loom-construction")
          ) {
            await cancelLoomConstructionForMovement?.(state.playerId);
          }
          if (
            state.playerId &&
            gameState.isMovementBlocked(state.playerId, "kitchen-construction")
          ) {
            await cancelKitchenConstructionForMovement?.(state.playerId);
          }
          if (
            state.playerId &&
            gameState.isMovementBlocked(state.playerId, "fishing-construction")
          ) {
            await cancelFishingConstructionForMovement?.(state.playerId);
          }
          if (
            state.playerId &&
            gameState.isMovementBlocked(state.playerId, "greenhouse-construction")
          ) {
            await cancelGreenhouseConstructionForMovement?.(state.playerId);
          }
          if (state.playerId && gameState.isMovementBlocked(state.playerId, "fishing")) {
            await cancelFishingForMovement?.(state.playerId);
          }
          if (state.playerId) {
            await cancelGreenhouseWaterFillForMovement?.(state.playerId);
          }
          if (
            state.playerId &&
            gameState.isMovementBlocked(state.playerId, "city-construction")
          ) {
            await cancelCityConstructionForMovement?.(state.playerId);
          }
          const accepted = enqueueWorldCommand({
            kind: "move",
            requestId: message.requestId,
            ...(message.boundTravelRequestId
              ? { boundTravelRequestId: message.boundTravelRequestId }
              : {}),
            ...(waterLeg ? { waterLeg } : {}),
            ...(shore ? { shore } : {}),
            target
          });
          const buffered =
            accepted &&
            state.playerId !== null &&
            worldRuntime?.bufferedTransitionMoveRequestId(state.playerId) ===
              message.requestId;
          const authoritative = state.playerId ? gameState.getPlayer(state.playerId) : null;
          gameplayLatencyTrace.record(state.playerId, {
            traceId: message.requestId,
            source: "game",
            category: "movement",
            name: accepted ? "movement_accepted" : "movement_rejected",
            details: {
              requestId: message.requestId,
              accepted,
              movementBuffered: buffered,
              serverProcessingMs: performance.now() - movementReceivedAt,
              targetLat: target.lat,
              targetLon: target.lon,
              movementRevision: authoritative?.movementRevision ?? null,
              relocationRevision: authoritative?.relocationRevision ?? null,
              targetActiveAfter: Boolean(authoritative?.target)
            },
            failure: !accepted
          });
          if (accepted && state.playerId) {
            flagHardenings.cancelPlayer(state.playerId, "movement");
            flagRepairs?.cancelPlayer(state.playerId, "movement");
            await cancelBomberDemolitionsForMovement?.(state.playerId);
          }
          if (accepted && !buffered) {
            if (state.playerId) {
              flagBuilds?.cancelPlayer(state.playerId, "movement");
            }
            const movingPlayer = state.playerId ? gameState.getPlayer(state.playerId) : null;
            if (worldLookup) {
              gameplayLatencyTrace.record(state.playerId, {
                traceId: message.requestId,
                source: "game",
                category: "world",
                name: "destination_compact_prewarm",
                details: {
                  movementRevision: movingPlayer?.movementRevision ?? null,
                  destinationCompactPrewarm: 1
                }
              });
              void worldLookup.lookupGameplayEnvironment(target.lat, target.lon)
                .catch((error: unknown) => {
                  logger.warn(
                    { err: error, playerId: state.playerId, requestId: message.requestId, target },
                    "failed to prewarm compact flag placement destination"
                  );
                });
            }
          }
        };
        if (worldRuntime?.hasPlayerWorldTransition(state.playerId)) {
          // Transition-time MOVE_TO is validated and buffered by WorldRuntime.
          // Do not wait on the relocation authority fence: phase one owns that
          // fence and movement must reach the latest-input buffer immediately.
          // The pre-travel position says nothing about water, so no water plan.
          await handleMovement(false);
        } else {
          await runMovementLifecycle(() => handleMovement(true));
        }
        return;
      }
    }
  };
}

export function registerWorldGameplayHandler(
  router: RealtimeMessageRouter,
  handler: RealtimeFamilyHandler<"world-gameplay">
): void {
  router.register("world-gameplay", handler);
}
