import { gameplayLatencyTrace } from "../../diagnostics/gameplayLatencyTrace.js";
import type { FlagSnapshot } from "@ash-atlas/shared";
import type { AppLogger } from "../../logger.js";
import type { FlagBuildCoordinator } from "../../game/flagBuildCoordinator.js";
import type { FlagHardeningCoordinator } from "../../game/flagHardeningCoordinator.js";
import { FlagBurnError, type FlagBurnCoordinator } from "../../game/flagBurning.js";
import { isFlagRepairError, type FlagRepairCoordinator } from "../../game/flagRepairing.js";
import {
  FlagAttackError,
  FlagPlacementError,
  type FlagService
} from "../../game/flags.js";
import type { GameState } from "../../game/state.js";
import type { AltDoorwayGate } from "../../auth/trust/altDoorway.js";
import type { HostileActionGate } from "../../auth/trust/hostileGate.js";
import type { LandActionGate } from "../../auth/trust/trustService.js";
import type { AuthenticatedSession } from "../../auth/types.js";
import { landActionAllowed, noteLandAction, raidAllowed } from "./landActionGuard.js";
import type { SocketLike } from "../connectionRegistry.js";
import type { RealtimeFamilyHandler, RealtimeMessageRouter } from "../messageRouter.js";
import { requireHello, safeSendServerMessage, type RealtimeConnectionState } from "./handlerExecutionContext.js";

export type FlagHandlerContext = Readonly<{
  state: Pick<RealtimeConnectionState, "playerId">;
  logger: AppLogger;
  socket: SocketLike;
  gameState: GameState;
  flagBuilds: FlagBuildCoordinator | null;
  flagHardenings: FlagHardeningCoordinator;
  flagBurns?: FlagBurnCoordinator;
  flagRepairs?: FlagRepairCoordinator;
  flagService: Pick<FlagService, "attackFlag">;
  authenticatedSession?: AuthenticatedSession | null | undefined;
  landActions?: LandActionGate | undefined;
  altDoorway?: AltDoorwayGate | undefined;
  hostileGate?: HostileActionGate | undefined;
  broadcastFlagUpdate(flag: FlagSnapshot): void | Promise<void>;
  rejectDuringPlayerWorldTransition(requestId: string): boolean;
  sendCombatError(
    socket: SocketLike,
    requestId: string,
    code: string,
    message: string,
    details?: {
      retryAfterMs?: number;
      retryable?: boolean;
      currentTollGold?: string;
      requiredGold?: string;
    }
  ): void;
}>;

export function createFlagHandler(
  context: FlagHandlerContext
): RealtimeFamilyHandler<"flag"> {
  return async (message) => {
    const {
      state,
      logger,
      socket,
      gameState,
      flagBuilds,
      flagHardenings,
      flagBurns,
      flagRepairs,
      flagService,
      broadcastFlagUpdate,
      rejectDuringPlayerWorldTransition,
      sendCombatError,
      authenticatedSession,
      landActions,
      altDoorway,
      hostileGate
    } = context;
    const accountId = authenticatedSession?.account.id ?? null;
    switch (message.type) {
      case "PLACE_FLAG": {
        requireHello(state.playerId);
        gameplayLatencyTrace.record(state.playerId, {
          traceId: message.requestId,
          source: "game",
          category: "build",
          name: "build_request_received",
          details: {
            requestId: message.requestId,
            quoteIdPresent: message.quoteId !== undefined
          }
        });
        logger.info({
          playerId: state.playerId,
          requestId: message.requestId,
          quoteIdPresent: message.quoteId !== undefined,
          receivedAt: Date.now()
        }, "flag placement received");
        if (rejectDuringPlayerWorldTransition(message.requestId)) return;
        const player = gameState.getPlayer(state.playerId);
        if (!player) {
          throw new Error("player is not connected");
        }
        if (!flagBuilds) throw new Error("flag construction service is unavailable");
        const landAction = {
          landActions,
          accountId,
          playerId: state.playerId,
          action: "flag_place" as const,
          position: player.position
        };
        if (!(await landActionAllowed(landAction, socket, message.requestId, sendCombatError))) return;
        try {
          await flagBuilds.start(
            player,
            message.requestId,
            message.name,
            message.quoteId,
            message.anchorKind ?? "flag"
          );
          noteLandAction(landAction);
        } catch (error) {
          const placementError = error instanceof FlagPlacementError ? error : null;
          gameplayLatencyTrace.record(state.playerId, {
            traceId: message.requestId,
            source: "game",
            category: "build",
            name: "build_request_rejected",
            details: {
              requestId: message.requestId,
              outcome: placementError?.code ?? "FLAG_BUILD_REJECTED",
              retryable: placementError?.retryable ?? false,
              quoteState: placementError?.quoteDiagnostic?.quoteState ?? null,
              worldLookupAttempted:
                placementError?.quoteDiagnostic?.worldLookupAttempted ?? false,
              worldLookupMs: 0
            },
            failure: true
          });
          sendCombatError(
            socket,
            message.requestId,
            placementError?.code ?? "FLAG_BUILD_REJECTED",
            error instanceof Error ? error.message : "Flag build rejected",
            {
              retryable: placementError?.retryable ?? false,
              ...(placementError?.retryAfterMs === undefined
                ? {}
                : { retryAfterMs: placementError.retryAfterMs })
            }
          );
        }
        return;
      }
      case "CANCEL_FLAG_BUILD": {
        requireHello(state.playerId);
        if (!flagBuilds?.cancelPlayer(state.playerId, "explicit", message.buildId)) {
          sendCombatError(socket, message.requestId, "FLAG_BUILD_NOT_ACTIVE", "No matching flag build is active");
        }
        return;
      }
      case "REINFORCE_FLAG": {
        requireHello(state.playerId);
        const playerId = state.playerId;
        if (!playerId) throw new Error("player is not connected");
        if (rejectDuringPlayerWorldTransition(message.requestId)) return;
        const landAction = {
          landActions,
          accountId,
          playerId,
          action: "flag_reinforce" as const,
          position: gameState.getPlayer(playerId)?.position ?? null
        };
        if (!(await landActionAllowed(landAction, socket, message.requestId, sendCombatError))) return;
        try {
          await flagHardenings.start(
            playerId,
            message.flagId,
            message.requestId,
            message.targetTier,
            () => gameState.getPlayer(playerId) ?? null,
            message.targetTowerLevel
          );
          noteLandAction(landAction);
        } catch (error) {
          sendCombatError(
            socket,
            message.requestId,
            "FLAG_REINFORCEMENT_REJECTED",
            error instanceof Error ? error.message : "Flag reinforcement rejected"
          );
        }
        return;
      }
      case "START_FLAG_BURN": {
        requireHello(state.playerId);
        if (rejectDuringPlayerWorldTransition(message.requestId)) return;
        const player = gameState.getPlayer(state.playerId);
        if (!player) {
          sendCombatError(socket, message.requestId, "FLAG_BURN_REJECTED", "Player is not connected");
          return;
        }
        const landAction = {
          landActions,
          accountId,
          playerId: state.playerId,
          action: "flag_burn" as const,
          position: player.position
        };
        if (!(await landActionAllowed(landAction, socket, message.requestId, sendCombatError))) return;
        if (!(await raidAllowed({
          altDoorway,
          hostileGate,
          accountId,
          playerId: state.playerId,
          action: "flag_burn",
          flagId: message.flagId
        }, socket, message.requestId, sendCombatError))) return;
        try {
          if (!flagBurns) throw new Error("Flag burning service is unavailable");
          const started = await flagBurns.start(
            state.playerId,
            message.flagId,
            message.requestId,
            player
          );
          noteLandAction(landAction);
          if (started.inventory) {
            safeSendServerMessage(socket, {
              type: "PLAYER_RESOURCES_UPDATED",
              playerId: state.playerId,
              inventory: started.inventory,
              serverTime: Date.now()
            }, logger, { playerId: state.playerId, requestId: message.requestId });
          }
        } catch (error) {
          sendCombatError(
            socket,
            message.requestId,
            error instanceof FlagBurnError ? error.code : "FLAG_BURN_REJECTED",
            error instanceof Error ? error.message : "Flag burn rejected"
          );
        }
        return;
      }
      case "ATTACK_FLAG": {
        requireHello(state.playerId);
        if (rejectDuringPlayerWorldTransition(message.requestId)) return;
        const player = gameState.getPlayer(state.playerId);
        if (!player) {
          sendCombatError(socket, message.requestId, "FLAG_ATTACK_REJECTED", "Player is not connected");
          return;
        }
        const landAction = {
          landActions,
          accountId,
          playerId: state.playerId,
          action: "flag_attack" as const,
          position: player.position
        };
        if (!(await landActionAllowed(landAction, socket, message.requestId, sendCombatError))) return;
        if (!(await raidAllowed({
          altDoorway,
          hostileGate,
          accountId,
          playerId: state.playerId,
          action: "flag_attack",
          flagId: message.flagId
        }, socket, message.requestId, sendCombatError))) return;
        try {
          const result = await flagService.attackFlag(
            state.playerId,
            message.flagId,
            message.requestId,
            player
          );
          noteLandAction(landAction);
          await broadcastFlagUpdate(result.flag);
        } catch (error) {
          sendCombatError(
            socket,
            message.requestId,
            error instanceof FlagAttackError ? error.code : "FLAG_ATTACK_REJECTED",
            error instanceof Error ? error.message : "Flag attack rejected"
          );
        }
        return;
      }
      case "START_FLAG_REPAIR": {
        requireHello(state.playerId);
        if (rejectDuringPlayerWorldTransition(message.requestId)) return;
        const player = gameState.getPlayer(state.playerId);
        if (!player) {
          sendCombatError(socket, message.requestId, "FLAG_REPAIR_DISCONNECTED", "Player is not connected");
          return;
        }
        try {
          if (!flagRepairs) throw new Error("Flag repair service is unavailable");
          await flagRepairs.startRepair(state.playerId, message.flagId, message.requestId, player);
        } catch (error) {
          sendCombatError(socket, message.requestId, isFlagRepairError(error) ? error.code : "FLAG_REPAIR_REJECTED", error instanceof Error ? error.message : "Flag repair rejected");
        }
        return;
      }
      case "CANCEL_FLAG_REPAIR": {
        requireHello(state.playerId);
        const active = flagRepairs?.activeRepairForPlayer(state.playerId);
        if (!active || active.operationId !== message.operationId || active.structureId !== message.flagId) {
          sendCombatError(socket, message.requestId, "FLAG_REPAIR_NOT_ACTIVE", "No matching Flag repair is active");
          return;
        }
        flagRepairs?.cancelPlayer(state.playerId, "explicit");
        return;
      }
      case "START_FLAG_REPAIR_DISRUPT": {
        requireHello(state.playerId);
        if (rejectDuringPlayerWorldTransition(message.requestId)) return;
        const player = gameState.getPlayer(state.playerId);
        if (!player) {
          sendCombatError(socket, message.requestId, "FLAG_DISRUPT_DISCONNECTED", "Player is not connected");
          return;
        }
        try {
          if (!flagRepairs) throw new Error("Flag repair service is unavailable");
          await flagRepairs.startDisrupt(state.playerId, message.flagId, message.repairOperationId, message.requestId, player);
        } catch (error) {
          sendCombatError(socket, message.requestId, isFlagRepairError(error) ? error.code : "FLAG_DISRUPT_REJECTED", error instanceof Error ? error.message : "Repair disruption rejected");
        }
        return;
      }
      case "CANCEL_FLAG_REPAIR_DISRUPT": {
        requireHello(state.playerId);
        const active = flagRepairs?.activeDisruptForPlayer(state.playerId);
        if (!active || active.operationId !== message.operationId || active.structureId !== message.flagId) {
          sendCombatError(socket, message.requestId, "FLAG_DISRUPT_NOT_ACTIVE", "No matching repair disruption is active");
          return;
        }
        flagRepairs?.cancelPlayer(state.playerId, "explicit");
        return;
      }
      case "CRAFT_TORCH": {
        requireHello(state.playerId);
        try {
          if (!flagBurns) throw new Error("Flag burning service is unavailable");
          const result = await flagBurns.craftTorches(state.playerId, message.requestId);
          safeSendServerMessage(socket, {
            type: "TORCHES_CRAFTED",
            requestId: message.requestId,
            quantity: 25,
            replayed: result.replayed,
            inventory: result.inventory
          }, logger, { playerId: state.playerId, requestId: message.requestId });
        } catch (error) {
          sendCombatError(
            socket,
            message.requestId,
            "TORCH_CRAFT_REJECTED",
            error instanceof Error ? error.message : "Torch craft rejected"
          );
        }
        return;
      }
    }
  };
}

export function registerFlagHandler(
  router: RealtimeMessageRouter,
  handler: RealtimeFamilyHandler<"flag">
): void {
  router.register("flag", handler);
}
