import {
  AGGRESSIVE_FLAG_TRAVEL_LOCK_MS,
  GREENHOUSE_GIVING_BERRY_TREE_CROP_ID,
  KITCHEN_COOK_ANY_RECIPE_ID,
  type LoomRecipeId,
  type TanneryRecipeId,
  type HarvestSessionSnapshot,
  type ServerMessage
} from "@ash-atlas/shared";
import type pg from "pg";

import type { AppLogger } from "../../logger.js";
import type { CombatEngine } from "../../game/combat/combatEngine.js";
import type { FlagBuildCoordinator } from "../../game/flagBuildCoordinator.js";
import { FurnaceError, type FurnaceService } from "../../game/furnaces.js";
import { TanneryError, type TanneryService } from "../../game/tanneries.js";
import { LoomError, type LoomService } from "../../game/looms.js";
import { KitchenError, type KitchenService } from "../../game/kitchens.js";
import { GreenhouseError, type GreenhouseService } from "../../game/greenhouses.js";
import {
  greenhousePlantPresentationIsCurrent,
  greenhouseStateForCropCapableClient
} from "../../game/greenhouseCropContent.js";
import type { GreenhouseRuntime } from "../../game/greenhouseRuntime.js";
import { FishingError, type FishingService } from "../../game/fishing.js";
import type { EquipmentService } from "../../game/equipment.js";
import { gatheringActivityForFishing } from "../../game/gatheringActivity.js";
import { OutdoorStationClearanceError } from "../../game/stationPlacementClearance.js";
import { JewelStationError, type JewelStationService } from "../../game/jewelStation.js";
import {
  ManorError,
  type ManorPresence,
  type ManorPresenceService,
  type ManorRuntime,
  type ManorStorageService
} from "../../game/manor.js";
import type {
  ManorDecorationService
} from "../../game/manorDecorations.js";
import type { PlayerAuthorityFence } from "../../game/playerAuthorityFence.js";
import type { AltDoorwayGate } from "../../auth/trust/altDoorway.js";
import type { HostileActionGate } from "../../auth/trust/hostileGate.js";
import type { LandActionGate } from "../../auth/trust/trustService.js";
import type { AuthenticatedSession } from "../../auth/types.js";
import { landActionAllowed, noteLandAction, raidAllowed } from "./landActionGuard.js";
import type { GameState } from "../../game/state.js";
import type { TravelBlockReason } from "../../game/travelEligibility.js";
import type { TravelInviteService } from "../../game/travelInvites.js";
import type { WorldMapService } from "../../game/worldMap.js";
import type { WorldRuntime } from "../../game/worldRuntime.js";
import type { ConnectionRegistry, SocketLike } from "../connectionRegistry.js";
import type { ManorRealtimeState } from "../manorRealtimeState.js";
import type { RealtimeFamilyHandler, RealtimeMessageRouter } from "../messageRouter.js";
import {
  requireHello,
  safeSendServerMessage as sendServerMessage,
  type RealtimeConnectionState
} from "./handlerExecutionContext.js";
import type { ResolvedTravelDestination, TravelArrivalMode } from "../travelContracts.js";

type Position = { lat: number; lon: number };
type TravelResult =
  | { success: true; player: ReturnType<GameState["snapshotForPlayer"]> }
  | { success: false; reason: TravelBlockReason };

export type ManorHandlerContext = Readonly<{
  state: Pick<RealtimeConnectionState, "playerId" | "connectionId" | "greenhouseCropCatalogVersion" | "greenhouseCropPackId">;
  socket: SocketLike;
  logger: AppLogger;
  registry: ConnectionRegistry;
  gameState: GameState;
  worldRuntime?: WorldRuntime | undefined;
  combat?: CombatEngine | undefined;
  manorPresence?: ManorPresenceService | undefined;
  manorStorage?: ManorStorageService | undefined;
  manorRuntime?: ManorRuntime | undefined;
  manorDecorations?: ManorDecorationService | undefined;
  furnaces?: FurnaceService | undefined;
  tanneries?: TanneryService | undefined;
  looms?: LoomService | undefined;
  kitchens?: KitchenService | undefined;
  greenhouses?: GreenhouseService | undefined;
  greenhouseRuntime?: GreenhouseRuntime | undefined;
  fishing?: FishingService | undefined;
  /** Read-only: the equipped gathering tool shown while fishing. */
  fishingEquipment?: Pick<EquipmentService, "runtimeSnapshot"> | undefined;
  jewelStation?: JewelStationService | undefined;
  travelInvites?: TravelInviteService | undefined;
  worldMap?: WorldMapService | undefined;
  manorRealtimeState: ManorRealtimeState;
  playerAuthorityFence: PlayerAuthorityFence;
  /** Manor warfare uses the same settled / anti-spoof / arrival-hold gates as a flag attack. */
  authenticatedSession?: AuthenticatedSession | null | undefined;
  landActions?: LandActionGate | undefined;
  altDoorway?: AltDoorwayGate | undefined;
  hostileGate?: HostileActionGate | undefined;
  flagBuilds: FlagBuildCoordinator | null;
  activeHarvestSessionForPlayer(playerId: string): Promise<HarvestSessionSnapshot | null>;
  broadcastManorSnapshots(): Promise<void>;
  cancelPendingManorEntry(
    playerId: string,
    options?: { stopMovement?: boolean; notify?: boolean; message?: string }
  ): boolean;
  forceManorEjection(presence: ManorPresence, reason: string): Promise<void>;
  /** Re-enter an owner who is inside their Manor at the lobby spawn of its newly equipped skin. */
  respawnManorOwnerAfterSkinChange(playerId: string, manorId: string): Promise<void>;
  performAuthoritativeTravel(input: {
    playerId: string;
    destination: ResolvedTravelDestination;
    requestId: string;
    arrivalMode: TravelArrivalMode;
    kind: "flag" | "invite" | "party_manual" | "party_auto_follow" | "manor_jump" | "dev_mine";
    sendResult?: boolean;
    playerSpawnPosition?: Position;
    transitionToken?: symbol;
    expectedTollGold?: string;
    beforePublish?: (client?: pg.PoolClient) => Promise<void>;
  }): Promise<TravelResult>;
  safeSendServerMessage(
    socket: SocketLike,
    message: ServerMessage,
    logger?: Pick<AppLogger, "warn">,
    context?: Record<string, unknown>
  ): boolean;
  sendManorError(socket: SocketLike, requestId: string | undefined, error: unknown): void;
  sendManorManagementSnapshot(
    ownerPlayerId: string,
    manorId: string,
    requestId?: string
  ): Promise<void>;
  sendTravelFailure(
    playerId: string,
    kind: "invite" | "party_manual" | "party_auto_follow" | "manor_jump",
    reason: TravelBlockReason,
    requestId?: string
  ): void;
  sendTravelInboxForPlayers(playerIds: Iterable<string>, isCurrent?: () => boolean): Promise<void>;
}>;

export function createManorHandler(
  context: ManorHandlerContext
): RealtimeFamilyHandler<"manor"> {
  let manorRequestTimestamps: number[] = [];
  const beginManorRequest = (): void => {
    const now = Date.now();
    manorRequestTimestamps = manorRequestTimestamps.filter(
      (timestamp) => now - timestamp < 10_000
    );
    if (manorRequestTimestamps.length >= 20) {
      throw new ManorError("MANOR_RATE_LIMITED", "Too many manor requests; try again shortly.");
    }
    manorRequestTimestamps.push(now);
  };
  const waterFillTimers = new Map<string, ReturnType<typeof setTimeout>>();
  return async (message) => {
    const {
      state,
      socket,
      logger,
      registry,
      gameState,
      worldRuntime,
      combat,
      manorPresence,
      manorStorage,
      manorRuntime,
      manorDecorations,
      furnaces,
      tanneries,
      looms,
      kitchens,
      greenhouses,
      greenhouseRuntime,
      fishing,
      fishingEquipment,
      jewelStation,
      travelInvites,
      worldMap,
      manorRealtimeState,
      playerAuthorityFence,
      flagBuilds,
      activeHarvestSessionForPlayer,
      broadcastManorSnapshots,
      cancelPendingManorEntry,
      forceManorEjection,
      respawnManorOwnerAfterSkinChange,
      performAuthoritativeTravel,
      safeSendServerMessage,
      sendManorError,
      sendManorManagementSnapshot,
      sendTravelFailure,
      sendTravelInboxForPlayers,
      authenticatedSession,
      landActions,
      altDoorway,
      hostileGate
    } = context;
    switch (message.type) {
      case "ATTACK_MANOR":
      case "START_MANOR_REPAIR":
      case "STOP_MANOR_REPAIR": {
        requireHello(state.playerId);
        const player = gameState.getPlayer(state.playerId);
        try {
          if (!manorPresence || !player) throw new ManorError("UNAVAILABLE", "Manor warfare is unavailable.");
          const warfarePlayer = { position: player.position, target: player.target, online: player.online };
          let changedManorId: string | null = null;
          if (message.type === "ATTACK_MANOR") {
            const accountId = authenticatedSession?.account.id ?? null;
            const sendGateError = (
              gateSocket: SocketLike,
              requestId: string,
              code: string,
              gateMessage: string
            ): void => {
              safeSendServerMessage(gateSocket, { type: "MANOR_ERROR", requestId, code, message: gateMessage });
            };
            const landAction = {
              landActions,
              accountId,
              playerId: state.playerId,
              action: "flag_attack" as const,
              position: player.position
            };
            if (!(await landActionAllowed(landAction, socket, message.requestId, sendGateError))) return;
            // The Manor id is never one of the attacker's flags, so an unsettled
            // account or an arrival hold refuses it exactly like a flag raid.
            if (!(await raidAllowed({
              altDoorway,
              hostileGate,
              accountId,
              playerId: state.playerId,
              action: "flag_attack",
              flagId: message.manorId
            }, socket, message.requestId, sendGateError))) return;
            const result = await manorPresence.attackManor(
              state.playerId, message.manorId, message.requestId, warfarePlayer
            );
            noteLandAction(landAction);
            safeSendServerMessage(socket, {
              type: "MANOR_WARFARE_CHANGED",
              requestId: message.requestId,
              action: "attack",
              manorId: result.manorId,
              damage: result.damage,
              replayed: result.replayed
            });
            changedManorId = result.manorId;
          } else if (message.type === "START_MANOR_REPAIR") {
            const result = await manorPresence.startManorRepair(state.playerId, message.manorId, warfarePlayer);
            safeSendServerMessage(socket, {
              type: "MANOR_WARFARE_CHANGED",
              requestId: message.requestId,
              action: "repair_started",
              manorId: result.manorId,
              replayed: result.replayed
            });
            changedManorId = result.manorId;
          } else {
            const result = await manorPresence.stopManorRepair(state.playerId);
            safeSendServerMessage(socket, {
              type: "MANOR_WARFARE_CHANGED",
              requestId: message.requestId,
              action: "repair_stopped",
              manorId: result?.manorId ?? "",
              replayed: result === null
            });
            changedManorId = result?.manorId ?? null;
          }
          if (changedManorId) {
            const manor = await manorPresence.builtManor(changedManorId);
            if (manor) registry.broadcast({ type: "MANOR_WORLD_UPDATED", manor });
          }
        } catch (error) {
          sendManorError(socket, message.requestId, error);
        }
        return;
      }
      case "BUILD_FURNACE": {
        requireHello(state.playerId);
        try {
          if (!furnaces || !worldRuntime) {
            throw new FurnaceError("FURNACE_UNAVAILABLE", "Furnace construction is unavailable.");
          }
          await playerAuthorityFence.run(state.playerId, async () => {
            const player = gameState.getPlayer(state.playerId!);
            if (!player || !gameState.isWorldPresent(player.playerId)) {
              throw new FurnaceError("FURNACE_WORLD_REQUIRED", "Return to the world to build a Furnace.");
            }
            if (combat && (!combat.isPlayerAlive(player.playerId) || combat.hasQueuedAbility(player.playerId))) {
              throw new FurnaceError("FURNACE_CANNOT_ACT", "You cannot build a Furnace right now.");
            }
            if (worldRuntime.hasPlayerWorldTransition(player.playerId) || worldRuntime.hasPendingCommand(player.playerId)) {
              throw new FurnaceError("FURNACE_ACTION_PENDING", "Finish the current world action first.");
            }
            if (
              flagBuilds?.activeForPlayer(player.playerId) ||
              gameState.isMovementBlocked(player.playerId, "city-construction") ||
              gameState.isMovementBlocked(player.playerId, "furnace-construction") ||
              gameState.isMovementBlocked(player.playerId, "tannery-construction") ||
              gameState.isMovementBlocked(player.playerId, "loom-construction") ||
              gameState.isMovementBlocked(player.playerId, "kitchen-construction") ||
              await activeHarvestSessionForPlayer(player.playerId)
            ) {
              throw new FurnaceError("FURNACE_ACTION_PENDING", "Finish the current world action first.");
            }
            gameState.stopPlayer(player.playerId);
            const result = await furnaces.build(
              { ...player, position: { ...player.position }, target: null },
              message.requestId
            );
            if (result.status === "constructing") {
              gameState.setMovementBlocked(player.playerId, true, "furnace-construction");
              registry.send(player.playerId, {
                type: "FURNACE_BUILD_STARTED",
                requestId: message.requestId,
                build: result.build,
                inventory: result.inventory,
                serverTime: Date.now(),
                replayed: result.replayed
              });
            } else if (result.status === "completed") {
              gameState.setMovementBlocked(player.playerId, false, "furnace-construction");
              registry.send(player.playerId, {
                type: "FURNACE_BUILD_RESULT",
                requestId: message.requestId,
                furnace: result.furnace,
                inventory: result.inventory,
                replayed: result.replayed
              });
              void broadcastManorSnapshots().catch((error: unknown) => {
                logger.warn({ err: error, playerId: player.playerId }, "failed to broadcast Furnace refresh");
              });
            } else {
              gameState.setMovementBlocked(player.playerId, false, "furnace-construction");
              registry.send(player.playerId, {
                type: "FURNACE_BUILD_CANCELLED",
                requestId: message.requestId,
                buildId: result.buildId,
                inventory: result.inventory,
                droppedItems: [],
                message: "Furnace construction was already cancelled."
              });
            }
          });
        } catch (error) {
          sendFurnaceError(socket, message.requestId, error);
        }
        return;
      }
      case "OPEN_FURNACE": {
        requireHello(state.playerId);
        try {
          if (!furnaces) throw new FurnaceError("FURNACE_UNAVAILABLE", "Furnaces are unavailable.");
          const player = gameState.getPlayer(state.playerId!);
          if (!player || !gameState.isWorldPresent(player.playerId)) {
            throw new FurnaceError("FURNACE_WORLD_REQUIRED", "Return to the world to use a Furnace.");
          }
          registry.send(player.playerId, {
            type: "FURNACE_STATE",
            requestId: message.requestId,
            state: await furnaces.state(player, message.furnaceId)
          });
        } catch (error) {
          sendFurnaceError(socket, message.requestId, error);
        }
        return;
      }
      case "START_FURNACE_SMELT": {
        requireHello(state.playerId);
        try {
          if (!furnaces) throw new FurnaceError("FURNACE_UNAVAILABLE", "Furnaces are unavailable.");
          await playerAuthorityFence.run(state.playerId, async () => {
            const player = gameState.getPlayer(state.playerId!);
            if (!player || !gameState.isWorldPresent(player.playerId)) {
              throw new FurnaceError("FURNACE_WORLD_REQUIRED", "Return to the world to use a Furnace.");
            }
            const result = await furnaces.start(
              player,
              message.requestId,
              message.furnaceId,
              message.recipeId,
              message.quantity,
              {
                ...(message.categoryPicks === undefined ? {} : { categoryPicks: message.categoryPicks }),
                ...(message.confirmHighGrade === undefined ? {} : { confirmHighGrade: message.confirmHighGrade })
              }
            );
            registry.send(player.playerId, {
              type: "FURNACE_SMELT_STARTED",
              requestId: message.requestId,
              state: result.state,
              inventory: result.inventory,
              replayed: result.replayed
            });
          });
        } catch (error) {
          sendFurnaceError(socket, message.requestId, error);
        }
        return;
      }
      case "COLLECT_FURNACE_OUTPUT": {
        requireHello(state.playerId);
        try {
          if (!furnaces) throw new FurnaceError("FURNACE_UNAVAILABLE", "Furnaces are unavailable.");
          await playerAuthorityFence.run(state.playerId, async () => {
            const player = gameState.getPlayer(state.playerId!);
            if (!player || !gameState.isWorldPresent(player.playerId)) {
              throw new FurnaceError("FURNACE_WORLD_REQUIRED", "Return to the world to use a Furnace.");
            }
            const result = await furnaces.collect(player, message.requestId, message.furnaceId);
            registry.send(player.playerId, {
              type: "FURNACE_OUTPUT_COLLECTED",
              requestId: message.requestId,
              state: result.state,
              inventory: result.inventory,
              collectedQuantity: result.collectedQuantity,
              replayed: result.replayed
            });
          });
        } catch (error) {
          sendFurnaceError(socket, message.requestId, error);
        }
        return;
      }
      case "REFINE_FURNACE_GLIMMER_OIL": {
        requireHello(state.playerId);
        try {
          if (!furnaces) throw new FurnaceError("FURNACE_UNAVAILABLE", "Furnaces are unavailable.");
          await playerAuthorityFence.run(state.playerId, async () => {
            const player = gameState.getPlayer(state.playerId!);
            if (!player || !gameState.isWorldPresent(player.playerId)) {
              throw new FurnaceError("FURNACE_WORLD_REQUIRED", "Return to the world to use a Furnace.");
            }
            const result = await furnaces.refineGlimmerOil(
              player,
              message.requestId,
              message.furnaceId,
              message.quantity
            );
            registry.send(player.playerId, {
              type: "FURNACE_GLIMMER_OIL_REFINED",
              requestId: message.requestId,
              state: result.state,
              inventory: result.inventory,
              premiumWallet: result.premiumWallet,
              refinedQuantity: result.refinedQuantity,
              replayed: result.replayed
            });
          });
        } catch (error) {
          sendFurnaceError(socket, message.requestId, error);
        }
        return;
      }
      case "BUILD_TANNERY": {
        requireHello(state.playerId);
        try {
          if (!tanneries || !worldRuntime) {
            throw new TanneryError("TANNERY_UNAVAILABLE", "Tannery construction is unavailable.");
          }
          await playerAuthorityFence.run(state.playerId, async () => {
            const player = gameState.getPlayer(state.playerId!);
            if (!player || !gameState.isWorldPresent(player.playerId)) {
              throw new TanneryError("TANNERY_WORLD_REQUIRED", "Return to the world to build a Tannery.");
            }
            if (combat && (!combat.isPlayerAlive(player.playerId) || combat.hasQueuedAbility(player.playerId))) {
              throw new TanneryError("TANNERY_CANNOT_ACT", "You cannot build a Tannery right now.");
            }
            if (worldRuntime.hasPlayerWorldTransition(player.playerId) || worldRuntime.hasPendingCommand(player.playerId)) {
              throw new TanneryError("TANNERY_ACTION_PENDING", "Finish the current world action first.");
            }
            if (
              flagBuilds?.activeForPlayer(player.playerId) ||
              gameState.isMovementBlocked(player.playerId, "city-construction") ||
              gameState.isMovementBlocked(player.playerId, "furnace-construction") ||
              gameState.isMovementBlocked(player.playerId, "tannery-construction") ||
              gameState.isMovementBlocked(player.playerId, "loom-construction") ||
              gameState.isMovementBlocked(player.playerId, "kitchen-construction") ||
              await activeHarvestSessionForPlayer(player.playerId)
            ) {
              throw new TanneryError("TANNERY_ACTION_PENDING", "Finish the current world action first.");
            }
            gameState.stopPlayer(player.playerId);
            const result = await tanneries.build(
              { ...player, position: { ...player.position }, target: null },
              message.requestId
            );
            if (result.status === "constructing") {
              gameState.setMovementBlocked(player.playerId, true, "tannery-construction");
              registry.send(player.playerId, {
                type: "TANNERY_BUILD_STARTED", requestId: message.requestId,
                build: result.build, inventory: result.inventory, serverTime: Date.now(),
                replayed: result.replayed
              });
            } else if (result.status === "completed") {
              gameState.setMovementBlocked(player.playerId, false, "tannery-construction");
              registry.send(player.playerId, {
                type: "TANNERY_BUILD_RESULT", requestId: message.requestId,
                tannery: result.tannery, inventory: result.inventory, replayed: result.replayed
              });
              void broadcastManorSnapshots().catch((error: unknown) => {
                logger.warn({ err: error, playerId: player.playerId }, "failed to broadcast Tannery refresh");
              });
            } else {
              gameState.setMovementBlocked(player.playerId, false, "tannery-construction");
              registry.send(player.playerId, {
                type: "TANNERY_BUILD_CANCELLED", requestId: message.requestId,
                buildId: result.buildId, inventory: result.inventory, droppedItems: [],
                message: "Tannery construction was already cancelled."
              });
            }
          });
        } catch (error) {
          sendTanneryError(socket, message.requestId, error);
        }
        return;
      }
      case "OPEN_TANNERY": {
        requireHello(state.playerId);
        try {
          if (!tanneries) throw new TanneryError("TANNERY_UNAVAILABLE", "Tanneries are unavailable.");
          const player = gameState.getPlayer(state.playerId!);
          if (!player || !gameState.isWorldPresent(player.playerId)) {
            throw new TanneryError("TANNERY_WORLD_REQUIRED", "Return to the world to use a Tannery.");
          }
          registry.send(player.playerId, {
            type: "TANNERY_STATE", requestId: message.requestId,
            state: await tanneries.state(player, message.tanneryId)
          });
        } catch (error) {
          sendTanneryError(socket, message.requestId, error);
        }
        return;
      }
      case "START_TANNERY_BATCH": {
        requireHello(state.playerId);
        try {
          if (!tanneries) throw new TanneryError("TANNERY_UNAVAILABLE", "Tanneries are unavailable.");
          await playerAuthorityFence.run(state.playerId, async () => {
            const player = gameState.getPlayer(state.playerId!);
            if (!player || !gameState.isWorldPresent(player.playerId)) {
              throw new TanneryError("TANNERY_WORLD_REQUIRED", "Return to the world to use a Tannery.");
            }
            const result = await tanneries.start(
              player, message.requestId, message.tanneryId, message.recipeId as TanneryRecipeId, message.quantity,
              message.confirmHighGrade
            );
            registry.send(player.playerId, {
              type: "TANNERY_BATCH_STARTED", requestId: message.requestId,
              state: result.state, inventory: result.inventory, replayed: result.replayed
            });
          });
        } catch (error) {
          sendTanneryError(socket, message.requestId, error);
        }
        return;
      }
      case "COLLECT_TANNERY_OUTPUT": {
        requireHello(state.playerId);
        try {
          if (!tanneries) throw new TanneryError("TANNERY_UNAVAILABLE", "Tanneries are unavailable.");
          await playerAuthorityFence.run(state.playerId, async () => {
            const player = gameState.getPlayer(state.playerId!);
            if (!player || !gameState.isWorldPresent(player.playerId)) {
              throw new TanneryError("TANNERY_WORLD_REQUIRED", "Return to the world to use a Tannery.");
            }
            const result = await tanneries.collect(player, message.requestId, message.tanneryId);
            registry.send(player.playerId, {
              type: "TANNERY_OUTPUT_COLLECTED", requestId: message.requestId,
              state: result.state, inventory: result.inventory,
              collectedQuantity: result.collectedQuantity, replayed: result.replayed
            });
          });
        } catch (error) {
          sendTanneryError(socket, message.requestId, error);
        }
        return;
      }
      case "BUILD_LOOM": {
        requireHello(state.playerId);
        try {
          if (!looms || !worldRuntime) {
            throw new LoomError("LOOM_UNAVAILABLE", "Loom construction is unavailable.");
          }
          await playerAuthorityFence.run(state.playerId, async () => {
            const player = gameState.getPlayer(state.playerId!);
            if (!player || !gameState.isWorldPresent(player.playerId)) {
              throw new LoomError("LOOM_WORLD_REQUIRED", "Return to the world to build a Loom.");
            }
            if (combat && (!combat.isPlayerAlive(player.playerId) || combat.hasQueuedAbility(player.playerId))) {
              throw new LoomError("LOOM_CANNOT_ACT", "You cannot build a Loom right now.");
            }
            if (worldRuntime.hasPlayerWorldTransition(player.playerId) || worldRuntime.hasPendingCommand(player.playerId)) {
              throw new LoomError("LOOM_ACTION_PENDING", "Finish the current world action first.");
            }
            if (
              flagBuilds?.activeForPlayer(player.playerId) ||
              gameState.isMovementBlocked(player.playerId, "city-construction") ||
              gameState.isMovementBlocked(player.playerId, "furnace-construction") ||
              gameState.isMovementBlocked(player.playerId, "tannery-construction") ||
              gameState.isMovementBlocked(player.playerId, "loom-construction") ||
              gameState.isMovementBlocked(player.playerId, "kitchen-construction") ||
              await activeHarvestSessionForPlayer(player.playerId)
            ) {
              throw new LoomError("LOOM_ACTION_PENDING", "Finish the current world action first.");
            }
            gameState.stopPlayer(player.playerId);
            const result = await looms.build(
              { ...player, position: { ...player.position }, target: null },
              message.requestId
            );
            if (result.status === "constructing") {
              gameState.setMovementBlocked(player.playerId, true, "loom-construction");
              registry.send(player.playerId, {
                type: "LOOM_BUILD_STARTED", requestId: message.requestId,
                build: result.build, inventory: result.inventory, serverTime: Date.now(),
                replayed: result.replayed
              });
            } else if (result.status === "completed") {
              gameState.setMovementBlocked(player.playerId, false, "loom-construction");
              registry.send(player.playerId, {
                type: "LOOM_BUILD_RESULT", requestId: message.requestId,
                loom: result.loom, inventory: result.inventory, replayed: result.replayed
              });
              void broadcastManorSnapshots().catch((error: unknown) => {
                logger.warn({ err: error, playerId: player.playerId }, "failed to broadcast Loom refresh");
              });
            } else {
              gameState.setMovementBlocked(player.playerId, false, "loom-construction");
              registry.send(player.playerId, {
                type: "LOOM_BUILD_CANCELLED", requestId: message.requestId,
                buildId: result.buildId, inventory: result.inventory, droppedItems: [],
                message: "Loom construction was already cancelled."
              });
            }
          });
        } catch (error) {
          sendLoomError(socket, message.requestId, error);
        }
        return;
      }
      case "OPEN_LOOM": {
        requireHello(state.playerId);
        try {
          if (!looms) throw new LoomError("LOOM_UNAVAILABLE", "Looms are unavailable.");
          const player = gameState.getPlayer(state.playerId!);
          if (!player || !gameState.isWorldPresent(player.playerId)) {
            throw new LoomError("LOOM_WORLD_REQUIRED", "Return to the world to use a Loom.");
          }
          registry.send(player.playerId, {
            type: "LOOM_STATE", requestId: message.requestId,
            state: await looms.state(player, message.loomId)
          });
        } catch (error) {
          sendLoomError(socket, message.requestId, error);
        }
        return;
      }
      case "START_LOOM_BATCH": {
        requireHello(state.playerId);
        try {
          if (!looms) throw new LoomError("LOOM_UNAVAILABLE", "Looms are unavailable.");
          await playerAuthorityFence.run(state.playerId, async () => {
            const player = gameState.getPlayer(state.playerId!);
            if (!player || !gameState.isWorldPresent(player.playerId)) {
              throw new LoomError("LOOM_WORLD_REQUIRED", "Return to the world to use a Loom.");
            }
            const result = await looms.start(
              player, message.requestId, message.loomId, message.recipeId as LoomRecipeId, message.quantity,
              message.confirmHighGrade
            );
            registry.send(player.playerId, {
              type: "LOOM_BATCH_STARTED", requestId: message.requestId,
              state: result.state, inventory: result.inventory, replayed: result.replayed
            });
          });
        } catch (error) {
          sendLoomError(socket, message.requestId, error);
        }
        return;
      }
      case "COLLECT_LOOM_OUTPUT": {
        requireHello(state.playerId);
        try {
          if (!looms) throw new LoomError("LOOM_UNAVAILABLE", "Looms are unavailable.");
          await playerAuthorityFence.run(state.playerId, async () => {
            const player = gameState.getPlayer(state.playerId!);
            if (!player || !gameState.isWorldPresent(player.playerId)) {
              throw new LoomError("LOOM_WORLD_REQUIRED", "Return to the world to use a Loom.");
            }
            const result = await looms.collect(player, message.requestId, message.loomId);
            registry.send(player.playerId, {
              type: "LOOM_OUTPUT_COLLECTED", requestId: message.requestId,
              state: result.state, inventory: result.inventory,
              collectedQuantity: result.collectedQuantity, replayed: result.replayed
            });
          });
        } catch (error) {
          sendLoomError(socket, message.requestId, error);
        }
        return;
      }
      case "BUILD_FISHING_HUT": {
        requireHello(state.playerId);
        try {
          if (!fishing || !worldRuntime) throw new FishingError("FISHING_UNAVAILABLE", "Fishing Hut construction is unavailable.");
          await playerAuthorityFence.run(state.playerId, async () => {
            const player = gameState.getPlayer(state.playerId!);
            if (!player || !gameState.isWorldPresent(player.playerId)) throw new FishingError("FISHING_WORLD_REQUIRED", "Return to the world to build a Fishing Hut.");
            if (combat && (!combat.isPlayerAlive(player.playerId) || combat.hasQueuedAbility(player.playerId))) throw new FishingError("FISHING_CANNOT_ACT", "You cannot build a Fishing Hut right now.");
            if (worldRuntime.hasPlayerWorldTransition(player.playerId) || worldRuntime.hasPendingCommand(player.playerId)) throw new FishingError("FISHING_ACTION_PENDING", "Finish the current world action first.");
            if (flagBuilds?.activeForPlayer(player.playerId) ||
              gameState.isMovementBlocked(player.playerId, "city-construction") ||
              gameState.isMovementBlocked(player.playerId, "furnace-construction") ||
              gameState.isMovementBlocked(player.playerId, "tannery-construction") ||
              gameState.isMovementBlocked(player.playerId, "butcher-construction") ||
              gameState.isMovementBlocked(player.playerId, "loom-construction") ||
              gameState.isMovementBlocked(player.playerId, "kitchen-construction") ||
              gameState.isMovementBlocked(player.playerId, "fishing-construction") ||
              gameState.isMovementBlocked(player.playerId, "fishing") ||
              await activeHarvestSessionForPlayer(player.playerId)) throw new FishingError("FISHING_ACTION_PENDING", "Finish the current world action first.");
            gameState.stopPlayer(player.playerId);
            const result = await fishing.build({ ...player, position: { ...player.position }, target: null }, message.requestId);
            if (result.status === "constructing") {
              gameState.setMovementBlocked(player.playerId, true, "fishing-construction");
              registry.send(player.playerId, { type: "FISHING_HUT_BUILD_STARTED", requestId: message.requestId, build: result.build, inventory: result.inventory, serverTime: Date.now(), replayed: result.replayed });
            } else if (result.status === "completed") {
              gameState.setMovementBlocked(player.playerId, false, "fishing-construction");
              registry.send(player.playerId, { type: "FISHING_HUT_BUILD_RESULT", requestId: message.requestId, fishingHut: result.hut, inventory: result.inventory, replayed: result.replayed });
              void broadcastManorSnapshots().catch((error: unknown) => logger.warn({ err: error, playerId: player.playerId }, "failed to broadcast Fishing Hut refresh"));
            } else {
              gameState.setMovementBlocked(player.playerId, false, "fishing-construction");
              registry.send(player.playerId, { type: "FISHING_HUT_BUILD_CANCELLED", requestId: message.requestId, buildId: result.buildId, inventory: result.inventory, droppedItems: [], message: "Fishing Hut construction was already cancelled." });
            }
          });
        } catch (error) { sendFishingError(socket, message.requestId, error); }
        return;
      }
      case "OPEN_FISHING_HUT": {
        requireHello(state.playerId);
        try {
          if (!fishing) throw new FishingError("FISHING_UNAVAILABLE", "Fishing Huts are unavailable.");
          const player = gameState.getPlayer(state.playerId!);
          if (!player || !gameState.isWorldPresent(player.playerId)) throw new FishingError("FISHING_WORLD_REQUIRED", "Return to the world to use a Fishing Hut.");
          registry.send(player.playerId, { type: "FISHING_STATE", requestId: message.requestId, state: await fishing.state(player, message.fishingHutId ?? null) });
        } catch (error) { sendFishingError(socket, message.requestId, error); }
        return;
      }
      case "REQUEST_FISHING_RECORDS": {
        requireHello(state.playerId);
        try {
          if (!fishing) throw new FishingError("FISHING_UNAVAILABLE", "Fishing records are unavailable.");
          const player = gameState.getPlayer(state.playerId!);
          if (!player || !gameState.isWorldPresent(player.playerId)) throw new FishingError("FISHING_WORLD_REQUIRED", "Return to the world to view fishing records.");
          registry.send(player.playerId, { type: "FISHING_RECORDS", requestId: message.requestId, records: await fishing.records(player, message.fishingHutId ?? null) });
        } catch (error) { sendFishingError(socket, message.requestId, error); }
        return;
      }
      case "COLLECT_FISHING_HUT": {
        requireHello(state.playerId);
        try {
          if (!fishing) throw new FishingError("FISHING_UNAVAILABLE", "Fishing Huts are unavailable.");
          await playerAuthorityFence.run(state.playerId, async () => {
            const player = gameState.getPlayer(state.playerId!);
            if (!player || !gameState.isWorldPresent(player.playerId)) throw new FishingError("FISHING_WORLD_REQUIRED", "Return to the world to collect Fishing Hut output.");
            const result = await fishing.collect(player, message.requestId, message.fishingHutId);
            registry.send(player.playerId, { type: "FISHING_STATE", requestId: message.requestId, state: result.state });
            registry.send(player.playerId, { type: "FISHING_PASSIVE_COLLECTED", requestId: message.requestId, state: result.state, inventory: result.inventory, collectedQuantity: result.collectedQuantity, replayed: result.replayed });
          });
        } catch (error) { sendFishingError(socket, message.requestId, error); }
        return;
      }
      case "CRAFT_FISHING_ROD": {
        requireHello(state.playerId);
        try {
          if (!fishing) throw new FishingError("FISHING_UNAVAILABLE", "Fishing training is unavailable.");
          await playerAuthorityFence.run(state.playerId, async () => {
            const player = gameState.getPlayer(state.playerId!);
            if (!player || !gameState.isWorldPresent(player.playerId)) throw new FishingError("FISHING_WORLD_REQUIRED", "Return to the world to craft a Fishing Rod.");
            if (combat && (!combat.isPlayerAlive(player.playerId) || combat.hasQueuedAbility(player.playerId))) throw new FishingError("FISHING_CANNOT_ACT", "You cannot craft a Fishing Rod during combat.");
            const result = await fishing.craftRod(player, message.requestId, message.fishingHutId);
            registry.send(player.playerId, { type: "FISHING_PROGRESS_RESULT", requestId: message.requestId, state: result.state, inventory: result.inventory, upgrades: result.upgrades, specialization: result.specialization, replayed: result.replayed, ...(result.rodId ? { rodId: result.rodId } : {}) });
          });
        } catch (error) { sendFishingError(socket, message.requestId, error); }
        return;
      }
      case "UPGRADE_FISHING_TRAINING": {
        requireHello(state.playerId);
        try {
          if (!fishing) throw new FishingError("FISHING_UNAVAILABLE", "Fishing training is unavailable.");
          await playerAuthorityFence.run(state.playerId, async () => {
            const player = gameState.getPlayer(state.playerId!);
            if (!player || !gameState.isWorldPresent(player.playerId)) throw new FishingError("FISHING_WORLD_REQUIRED", "Return to the world to upgrade fishing training.");
            if (combat && (!combat.isPlayerAlive(player.playerId) || combat.hasQueuedAbility(player.playerId))) throw new FishingError("FISHING_CANNOT_ACT", "You cannot upgrade fishing training during combat.");
            const result = await fishing.upgrade(player, message.requestId, message.fishingHutId, message.track);
            registry.send(player.playerId, { type: "FISHING_PROGRESS_RESULT", requestId: message.requestId, state: result.state, inventory: result.inventory, upgrades: result.upgrades, specialization: result.specialization, replayed: result.replayed, ...(result.walletGold ? { walletGold: result.walletGold } : {}), ...(result.walletVersion ? { walletVersion: result.walletVersion } : {}) });
          });
        } catch (error) { sendFishingError(socket, message.requestId, error); }
        return;
      }
      case "SELECT_FISHING_SPECIALIZATION": {
        requireHello(state.playerId);
        try {
          if (!fishing) throw new FishingError("FISHING_UNAVAILABLE", "Fishing specialization is unavailable.");
          await playerAuthorityFence.run(state.playerId, async () => {
            const player = gameState.getPlayer(state.playerId!);
            if (!player || !gameState.isWorldPresent(player.playerId)) throw new FishingError("FISHING_WORLD_REQUIRED", "Return to the world to select a fishing specialization.");
            if (combat && (!combat.isPlayerAlive(player.playerId) || combat.hasQueuedAbility(player.playerId))) throw new FishingError("FISHING_CANNOT_ACT", "You cannot select a fishing specialization during combat.");
            const result = await fishing.specialize(player, message.requestId, message.fishingHutId, message.specializationType);
            registry.send(player.playerId, { type: "FISHING_PROGRESS_RESULT", requestId: message.requestId, state: result.state, inventory: result.inventory, upgrades: result.upgrades, specialization: result.specialization, replayed: result.replayed });
          });
        } catch (error) { sendFishingError(socket, message.requestId, error); }
        return;
      }
      case "START_FISHING": {
        requireHello(state.playerId);
        try {
          if (!fishing) throw new FishingError("FISHING_UNAVAILABLE", "Fishing is unavailable.");
          await playerAuthorityFence.run(state.playerId, async () => {
            const player = gameState.getPlayer(state.playerId!);
            if (!player || !gameState.isWorldPresent(player.playerId)) throw new FishingError("FISHING_WORLD_REQUIRED", "Return to the world to fish.");
            if (combat && (!combat.isPlayerAlive(player.playerId) || combat.hasQueuedAbility(player.playerId))) throw new FishingError("FISHING_CANNOT_ACT", "You cannot fish during combat.");
            if (player.target || gameState.isMovementBlocked(player.playerId)) throw new FishingError("FISHING_MUST_BE_STATIONARY", "Stop moving before you start fishing.");
            if (worldRuntime?.hasPlayerWorldTransition(player.playerId) || worldRuntime?.hasPendingCommand(player.playerId)) throw new FishingError("FISHING_ACTION_PENDING", "Finish the current world action before fishing.");
            const result = await fishing.start(player, message.requestId, message.fishingRodId);
            gameState.stopPlayer(player.playerId);
            gameState.setMovementBlocked(player.playerId, true, "fishing");
            registry.send(player.playerId, { type: "FISHING_ENCOUNTER_STARTED", requestId: message.requestId, state: result.state, replayed: result.replayed });
          });
        } catch (error) { sendFishingError(socket, message.requestId, error); }
        return;
      }
      case "FISHING_CAST":
      case "FISHING_HOOK":
      case "FISHING_CONTROL":
      case "FISHING_LAND":
      case "FISHING_CANCEL": {
        requireHello(state.playerId);
        try {
          if (!fishing) throw new FishingError("FISHING_UNAVAILABLE", "Fishing is unavailable.");
          await playerAuthorityFence.run(state.playerId, async () => {
            const player = gameState.getPlayer(state.playerId!);
            if (!player || !gameState.isWorldPresent(player.playerId)) throw new FishingError("FISHING_WORLD_REQUIRED", "Return to the world to fish.");
            if (message.type === "FISHING_CAST") {
              if (combat && (!combat.isPlayerAlive(player.playerId) || combat.hasQueuedAbility(player.playerId))) throw new FishingError("FISHING_CANNOT_ACT", "You cannot cast during combat.");
              if (player.target) throw new FishingError("FISHING_MUST_BE_STATIONARY", "Stop moving before you cast.");
              if (worldRuntime?.hasPlayerWorldTransition(player.playerId) || worldRuntime?.hasPendingCommand(player.playerId)) throw new FishingError("FISHING_ACTION_PENDING", "Finish the current world action before casting.");
            }
            const result = message.type === "FISHING_CAST"
              ? await fishing.cast(player, message.requestId, message.encounterId, message.timing, message.castPoint, message.waterbody)
              : message.type === "FISHING_HOOK"
                ? await fishing.hook(player, message.requestId, message.encounterId)
                : message.type === "FISHING_CONTROL"
                  ? await fishing.control(player, message.requestId, message.encounterId, message.direction, message.reeling)
                  : message.type === "FISHING_LAND"
                    ? await fishing.land(player, message.requestId, message.encounterId)
                    : await fishing.cancel(player, message.requestId, message.encounterId);
            const phase = result.state.encounter?.phase;
            gameState.setGatheringActivity(player.playerId, gatheringActivityForFishing(
              result.state.encounter,
              fishingEquipment?.runtimeSnapshot(player.playerId),
              gameState.gatheringActivity(player.playerId)
            ));
            if (phase === "landed" || phase === "escaped" || phase === "expired" || phase === "cancelled") {
              gameState.setMovementBlocked(player.playerId, false, "fishing");
            }
            const resultType = message.type === "FISHING_CAST" ? "FISHING_CAST_RESULT" : message.type === "FISHING_HOOK" ? "FISHING_HOOK_RESULT" : message.type === "FISHING_CONTROL" ? "FISHING_CONTROL_RESULT" : message.type === "FISHING_LAND" ? "FISHING_CATCH_LANDED" : "FISHING_CONTROL_RESULT";
            if (resultType === "FISHING_CATCH_LANDED") {
              registry.send(player.playerId, { type: "FISHING_CATCH_LANDED", requestId: message.requestId, state: result.state, catch: result.state.encounter?.catch ?? null, ...(result.inventory ? { inventory: result.inventory } : {}), collectedQuantity: result.collectedQuantity ?? 0, replayed: result.replayed });
            } else {
              registry.send(player.playerId, { type: resultType, requestId: message.requestId, state: result.state, replayed: result.replayed } as never);
            }
          });
        } catch (error) { sendFishingError(socket, message.requestId, error); }
        return;
      }
      case "BUILD_KITCHEN": {
        requireHello(state.playerId);
        try {
          if (!kitchens || !worldRuntime) throw new KitchenError("KITCHEN_UNAVAILABLE", "Kitchen construction is unavailable.");
          await playerAuthorityFence.run(state.playerId, async () => {
            const player = gameState.getPlayer(state.playerId!);
            if (!player || !gameState.isWorldPresent(player.playerId)) throw new KitchenError("KITCHEN_WORLD_REQUIRED", "Return to the world to build a Kitchen.");
            if (combat && (!combat.isPlayerAlive(player.playerId) || combat.hasQueuedAbility(player.playerId))) throw new KitchenError("KITCHEN_CANNOT_ACT", "You cannot build a Kitchen right now.");
            if (worldRuntime.hasPlayerWorldTransition(player.playerId) || worldRuntime.hasPendingCommand(player.playerId)) throw new KitchenError("KITCHEN_ACTION_PENDING", "Finish the current world action first.");
            if (flagBuilds?.activeForPlayer(player.playerId) ||
              gameState.isMovementBlocked(player.playerId, "city-construction") ||
              gameState.isMovementBlocked(player.playerId, "furnace-construction") ||
              gameState.isMovementBlocked(player.playerId, "tannery-construction") ||
              gameState.isMovementBlocked(player.playerId, "loom-construction") ||
              gameState.isMovementBlocked(player.playerId, "kitchen-construction") ||
              await activeHarvestSessionForPlayer(player.playerId)) throw new KitchenError("KITCHEN_ACTION_PENDING", "Finish the current world action first.");
            gameState.stopPlayer(player.playerId);
            const result = await kitchens.build({ ...player, position: { ...player.position }, target: null }, message.requestId);
            if (result.status === "constructing") {
              gameState.setMovementBlocked(player.playerId, true, "kitchen-construction");
              registry.send(player.playerId, { type: "KITCHEN_BUILD_STARTED", requestId: message.requestId, build: result.build, inventory: result.inventory, serverTime: Date.now(), replayed: result.replayed });
            } else if (result.status === "completed") {
              gameState.setMovementBlocked(player.playerId, false, "kitchen-construction");
              registry.send(player.playerId, { type: "KITCHEN_BUILD_RESULT", requestId: message.requestId, kitchen: result.kitchen, inventory: result.inventory, replayed: result.replayed });
              void broadcastManorSnapshots().catch((error: unknown) => logger.warn({ err: error, playerId: player.playerId }, "failed to broadcast Kitchen refresh"));
            } else {
              gameState.setMovementBlocked(player.playerId, false, "kitchen-construction");
              registry.send(player.playerId, { type: "KITCHEN_BUILD_CANCELLED", requestId: message.requestId, buildId: result.buildId, inventory: result.inventory, droppedItems: [], message: "Kitchen construction was already cancelled." });
            }
          });
        } catch (error) { sendKitchenError(socket, message.requestId, error); }
        return;
      }
      case "OPEN_KITCHEN": {
        requireHello(state.playerId);
        try {
          if (!kitchens) throw new KitchenError("KITCHEN_UNAVAILABLE", "Kitchens are unavailable.");
          const player = gameState.getPlayer(state.playerId!);
          if (!player || !gameState.isWorldPresent(player.playerId)) throw new KitchenError("KITCHEN_WORLD_REQUIRED", "Return to the world to use a Kitchen.");
          registry.send(player.playerId, { type: "KITCHEN_STATE", requestId: message.requestId, state: await kitchens.state(player, message.kitchenId) });
        } catch (error) { sendKitchenError(socket, message.requestId, error); }
        return;
      }
      case "START_KITCHEN_BATCH": {
        requireHello(state.playerId);
        try {
          if (!kitchens) throw new KitchenError("KITCHEN_UNAVAILABLE", "Kitchens are unavailable.");
          await playerAuthorityFence.run(state.playerId, async () => {
            const player = gameState.getPlayer(state.playerId!);
            if (!player || !gameState.isWorldPresent(player.playerId)) throw new KitchenError("KITCHEN_WORLD_REQUIRED", "Return to the world to use a Kitchen.");
            if (message.recipeId === KITCHEN_COOK_ANY_RECIPE_ID) {
              const result = await kitchens.startCookAny(player, message.requestId, message.kitchenId, message.quantity, message.categoryPicks, message.confirmHighGrade);
              registry.send(player.playerId, { type: "KITCHEN_BATCH_STARTED", requestId: message.requestId, state: result.state, inventory: result.inventory, replayed: result.replayed, leftoverQuantity: result.leftoverQuantity });
              return;
            }
            const result = await kitchens.start(player, message.requestId, message.kitchenId, message.recipeId, message.quantity, message.confirmHighGrade);
            registry.send(player.playerId, { type: "KITCHEN_BATCH_STARTED", requestId: message.requestId, state: result.state, inventory: result.inventory, replayed: result.replayed });
          });
        } catch (error) { sendKitchenError(socket, message.requestId, error); }
        return;
      }
      case "COLLECT_KITCHEN_OUTPUT": {
        requireHello(state.playerId);
        try {
          if (!kitchens) throw new KitchenError("KITCHEN_UNAVAILABLE", "Kitchens are unavailable.");
          await playerAuthorityFence.run(state.playerId, async () => {
            const player = gameState.getPlayer(state.playerId!);
            if (!player || !gameState.isWorldPresent(player.playerId)) throw new KitchenError("KITCHEN_WORLD_REQUIRED", "Return to the world to use a Kitchen.");
            const result = await kitchens.collect(player, message.requestId, message.kitchenId);
            registry.send(player.playerId, { type: "KITCHEN_OUTPUT_COLLECTED", requestId: message.requestId, state: result.state, inventory: result.inventory, collectedQuantity: result.collectedQuantity, replayed: result.replayed });
          });
        } catch (error) { sendKitchenError(socket, message.requestId, error); }
        return;
      }
      case "BUILD_GREENHOUSE": {
        requireHello(state.playerId);
        try {
          if (!greenhouses || !worldRuntime) throw new GreenhouseError("GREENHOUSE_UNAVAILABLE", "Greenhouse construction is unavailable.");
          await playerAuthorityFence.run(state.playerId, async () => {
            const player = gameState.getPlayer(state.playerId!);
            if (!player || !gameState.isWorldPresent(player.playerId)) throw new GreenhouseError("GREENHOUSE_WORLD_REQUIRED", "Return to the world to build a Greenhouse.");
            if (combat && (!combat.isPlayerAlive(player.playerId) || combat.hasQueuedAbility(player.playerId))) throw new GreenhouseError("GREENHOUSE_CANNOT_ACT", "You cannot build a Greenhouse right now.");
            if (worldRuntime.hasPlayerWorldTransition(player.playerId) || worldRuntime.hasPendingCommand(player.playerId)) throw new GreenhouseError("GREENHOUSE_ACTION_PENDING", "Finish the current world action first.");
            if (flagBuilds?.activeForPlayer(player.playerId) || gameState.isMovementBlocked(player.playerId, "city-construction") || gameState.isMovementBlocked(player.playerId, "greenhouse-construction") || await activeHarvestSessionForPlayer(player.playerId)) throw new GreenhouseError("GREENHOUSE_ACTION_PENDING", "Finish the current world action first.");
            gameState.stopPlayer(player.playerId);
            const result = await greenhouses.build({ ...player, position: { ...player.position }, target: null }, message.requestId);
            if (result.status === "constructing") {
              gameState.setMovementBlocked(player.playerId, true, "greenhouse-construction");
              registry.send(player.playerId, { type: "GREENHOUSE_BUILD_STARTED", requestId: message.requestId, build: result.build, inventory: result.inventory, serverTime: Date.now(), replayed: result.replayed });
            } else {
              gameState.setMovementBlocked(player.playerId, false, "greenhouse-construction");
              registry.send(player.playerId, { type: "GREENHOUSE_BUILD_RESULT", requestId: message.requestId, greenhouse: result.greenhouse, inventory: result.inventory, replayed: result.replayed });
            }
          });
        } catch (error) { sendGreenhouseError(socket, message.requestId, error); }
        return;
      }
      case "PREVIEW_GREENHOUSE_BUILD": {
        requireHello(state.playerId);
        try {
          if (!greenhouses || !worldRuntime) throw new GreenhouseError("GREENHOUSE_UNAVAILABLE", "Greenhouse construction is unavailable.");
          await playerAuthorityFence.run(state.playerId, async () => {
            const player = gameState.getPlayer(state.playerId!);
            if (!player || !gameState.isWorldPresent(player.playerId)) throw new GreenhouseError("GREENHOUSE_WORLD_REQUIRED", "Return to the world to preview Greenhouse placement.");
            const preview = await greenhouses.previewBuild({ ...player, position: { ...player.position }, target: null });
            registry.send(player.playerId, { type: "GREENHOUSE_BUILD_PREVIEW", requestId: message.requestId, preview });
          });
        } catch (error) { sendGreenhouseError(socket, message.requestId, error); }
        return;
      }
      case "CANCEL_GREENHOUSE_BUILD": {
        requireHello(state.playerId);
        try {
          if (!greenhouses) throw new GreenhouseError("GREENHOUSE_UNAVAILABLE", "Greenhouse construction is unavailable.");
          await playerAuthorityFence.run(state.playerId, async () => {
            const player = gameState.getPlayer(state.playerId!);
            if (!player) throw new GreenhouseError("GREENHOUSE_PLAYER_REQUIRED", "Your player session is unavailable.");
            const cancelled = await greenhouses.cancelBuild(player.playerId, message.requestId);
            if (!cancelled) {
              throw new GreenhouseError("GREENHOUSE_BUILD_NOT_FOUND", "There is no active Greenhouse construction to cancel.");
            }
            gameState.setMovementBlocked(player.playerId, false, "greenhouse-construction");
            registry.send(player.playerId, {
              type: "GREENHOUSE_BUILD_CANCELLED",
              requestId: cancelled.requestId,
              buildId: cancelled.buildId,
              inventory: cancelled.inventory,
              droppedItems: cancelled.droppedItems,
              message: cancelled.message
            });
          });
        } catch (error) { sendGreenhouseError(socket, message.requestId, error); }
        return;
      }
      case "DESTROY_GREENHOUSE": {
        requireHello(state.playerId);
        try {
          if (!greenhouses || !worldRuntime) throw new GreenhouseError("GREENHOUSE_UNAVAILABLE", "Greenhouse management is unavailable.");
          await playerAuthorityFence.run(state.playerId, async () => {
            const player = gameState.getPlayer(state.playerId!);
            if (!player || !gameState.isWorldPresent(player.playerId)) throw new GreenhouseError("GREENHOUSE_WORLD_REQUIRED", "Return to the world before destroying a Greenhouse.");
            if (greenhouseRuntime?.isInside(player.playerId)) throw new GreenhouseError("GREENHOUSE_EXIT_REQUIRED", "Exit the Greenhouse before destroying it.");
            if (gameState.isMovementBlocked(player.playerId, "greenhouse-construction")) throw new GreenhouseError("GREENHOUSE_BUILD_ACTIVE", "Cancel or finish the active Greenhouse construction first.");
            const result = await greenhouses.destroy({ ...player, position: { ...player.position }, target: null }, message.requestId, message.greenhouseId);
            registry.send(player.playerId, { type: "GREENHOUSE_DESTROY_RESULT", requestId: message.requestId, ...result });
            await Promise.all(registry.activePlayerIds().map(async (activePlayerId) => {
              const activePlayer = gameState.getPlayer(activePlayerId);
              if (!activePlayer || !gameState.isWorldPresent(activePlayerId)) return;
              registry.send(activePlayerId, { type: "GREENHOUSES_SNAPSHOT", greenhouses: await greenhouses.listNear(activePlayer) });
            }));
          });
        } catch (error) { sendGreenhouseError(socket, message.requestId, error); }
        return;
      }
      case "OPEN_GREENHOUSE": {
          requireHello(state.playerId);
          try {
           if (!greenhouses || !greenhouseRuntime) throw new GreenhouseError("GREENHOUSE_UNAVAILABLE", "Greenhouses are unavailable.");
           const player = gameState.getPlayer(state.playerId!);
           if (!player) throw new GreenhouseError("GREENHOUSE_PLAYER_REQUIRED", "Your player session is unavailable.");
           const session = greenhouseRuntime.get(player.playerId);
           if (!session || session.greenhouseId !== message.greenhouseId) throw new GreenhouseError("GREENHOUSE_SESSION_REQUIRED", "Enter your Greenhouse before opening it.");
           const snapshot = await greenhouses.snapshot(player, message.greenhouseId);
           registry.send(player.playerId, {
             type: "GREENHOUSE_STATE",
             requestId: message.requestId,
             state: await greenhouseStateForCropCapableClient(
               snapshot,
               state.greenhouseCropCatalogVersion,
               state.greenhouseCropPackId
             )
           });
        } catch (error) { sendGreenhouseError(socket, message.requestId, error); }
        return;
      }
      case "GREENHOUSE_MOVE_TO": {
        requireHello(state.playerId);
        try {
          if (!greenhouseRuntime) throw new GreenhouseError("GREENHOUSE_UNAVAILABLE", "Greenhouse movement is unavailable.");
          const player = gameState.getPlayer(state.playerId!);
          if (!player) throw new GreenhouseError("GREENHOUSE_PLAYER_REQUIRED", "Your player session is unavailable.");
          const session = greenhouseRuntime.moveTo(player.playerId, message.greenhouseSessionId, message.x, message.y);
          registry.send(player.playerId, {
            type: "GREENHOUSE_POSITION",
            greenhouseSessionId: session.sessionId,
            position: session.position,
            movementSequence: session.movementSequence,
            serverTime: Date.now()
          });
        } catch (error) { sendGreenhouseError(socket, message.requestId, error); }
        return;
      }
      case "PLACE_GREENHOUSE": {
        requireHello(state.playerId);
        try {
          if (!greenhouses || !greenhouseRuntime) throw new GreenhouseError("GREENHOUSE_UNAVAILABLE", "Greenhouse placement is unavailable.");
          const player = gameState.getPlayer(state.playerId!);
          if (!player) throw new GreenhouseError("GREENHOUSE_PLAYER_REQUIRED", "Your player session is unavailable.");
          const session = greenhouseRuntime.requireSession(player.playerId, message.greenhouseSessionId);
          const result = await greenhouses.place(
            player,
            message.requestId,
            session.greenhouseId,
            message.placementKind,
            message.x,
            message.y,
            message.anchorId
          );
          registry.send(player.playerId, {
            type: "GREENHOUSE_MUTATION_RESULT",
            requestId: message.requestId,
            action: "place",
            state: await greenhouseStateForCropCapableClient(
              result.state,
              state.greenhouseCropCatalogVersion,
              state.greenhouseCropPackId
            ),
            inventory: result.inventory,
            replayed: result.replayed,
            message: result.message,
            ...(result.placementKind ? { placementKind: result.placementKind } : {}),
            ...(result.placedAnchorId ? { placedAnchorId: result.placedAnchorId } : {})
          });
        } catch (error) { sendGreenhouseError(socket, message.requestId, error); }
        return;
      }
      case "PLANT_GREENHOUSE":
      case "WATER_GREENHOUSE":
      case "CLIP_GREENHOUSE":
      case "HARVEST_GREENHOUSE": {
        requireHello(state.playerId);
        try {
           if (!greenhouses || !greenhouseRuntime) throw new GreenhouseError("GREENHOUSE_UNAVAILABLE", "Greenhouses are unavailable.");
           const player = gameState.getPlayer(state.playerId!);
           if (!player) throw new GreenhouseError("GREENHOUSE_PLAYER_REQUIRED", "Your player session is unavailable.");
           const session = greenhouseRuntime.requireSession(player.playerId, message.greenhouseSessionId);
           const action = message.type === "PLANT_GREENHOUSE" ? "plant" : message.type === "WATER_GREENHOUSE" ? "water" : message.type === "CLIP_GREENHOUSE" ? "clip" : "harvest";
           if (message.type === "PLANT_GREENHOUSE" && message.cropId !== GREENHOUSE_GIVING_BERRY_TREE_CROP_ID && (
             state.greenhouseCropCatalogVersion !== 1 ||
             !(await greenhousePlantPresentationIsCurrent(
               message.cropId,
               message.packId,
               state.greenhouseCropPackId
             ))
           )) {
             throw new GreenhouseError("GREENHOUSE_CROP_ART_UNAVAILABLE", "Verified crop artwork is unavailable. Try again after the content update.");
           }
           const planterPosition = await greenhouses.planterPosition(session.greenhouseId, message.anchorId);
           if (!planterPosition || !greenhouseRuntime.isNearPlanter(player.playerId, message.greenhouseSessionId, message.anchorId, planterPosition)) {
             throw new GreenhouseError("GREENHOUSE_PLANTER_RANGE", "Move next to the Farm Plot before using it.");
           }
           const result = message.type === "PLANT_GREENHOUSE"
             ? await greenhouses.plant(player, message.requestId, session.greenhouseId, message.anchorId, message.packId, message.cropId)
              : message.type === "WATER_GREENHOUSE"
               ? await greenhouses.water(player, message.requestId, session.greenhouseId, message.anchorId)
               : message.type === "CLIP_GREENHOUSE"
                 ? await greenhouses.clip(player, message.requestId, session.greenhouseId, message.anchorId)
                 : await greenhouses.harvest(player, message.requestId, session.greenhouseId, message.anchorId);
          registry.send(player.playerId, {
            type: "GREENHOUSE_MUTATION_RESULT",
            requestId: message.requestId,
            action,
            state: await greenhouseStateForCropCapableClient(
              result.state,
              state.greenhouseCropCatalogVersion,
              state.greenhouseCropPackId
            ),
            inventory: result.inventory,
            replayed: result.replayed,
            message: result.message,
            ...( "yieldQuantity" in result ? { yieldQuantity: result.yieldQuantity } : {})
          });
        } catch (error) { sendGreenhouseError(socket, message.requestId, error); }
        return;
      }
      case "TAP_GREENHOUSE_TREE": {
        requireHello(state.playerId);
        try {
          if (!greenhouses || !greenhouseRuntime) throw new GreenhouseError("GREENHOUSE_UNAVAILABLE", "Greenhouses are unavailable.");
          const player = gameState.getPlayer(state.playerId!);
          if (!player) throw new GreenhouseError("GREENHOUSE_PLAYER_REQUIRED", "Your player session is unavailable.");
          const session = greenhouseRuntime.requireSession(player.playerId, message.greenhouseSessionId);
          const planterPosition = await greenhouses.planterPosition(session.greenhouseId, message.anchorId);
          if (!planterPosition || !greenhouseRuntime.isNearPlanter(player.playerId, message.greenhouseSessionId, message.anchorId, planterPosition)) {
            throw new GreenhouseError("GREENHOUSE_PLANTER_RANGE", "Move next to the Farm Plot before using it.");
          }
          const result = await greenhouses.tapTree(player, message.requestId, session.greenhouseId, message.anchorId);
          registry.send(player.playerId, {
            type: "GREENHOUSE_MUTATION_RESULT",
            requestId: message.requestId,
            action: "tap",
            state: await greenhouseStateForCropCapableClient(result.state, state.greenhouseCropCatalogVersion, state.greenhouseCropPackId),
            inventory: result.inventory,
            replayed: result.replayed,
            message: result.message,
            ...( "yieldQuantity" in result ? { yieldQuantity: result.yieldQuantity } : {})
          });
        } catch (error) { sendGreenhouseError(socket, message.requestId, error); }
        return;
      }
      case "CRAFT_WATER_BUCKET": {
        requireHello(state.playerId);
        try {
          if (!greenhouses) throw new GreenhouseError("GREENHOUSE_UNAVAILABLE", "Greenhouses are unavailable.");
          const player = gameState.getPlayer(state.playerId!);
          if (!player) throw new GreenhouseError("GREENHOUSE_PLAYER_REQUIRED", "Your player session is unavailable.");
          const result = await greenhouses.craftWaterBucket(player, message.requestId);
          registry.send(player.playerId, { type: "GREENHOUSE_BUCKET_RESULT", requestId: message.requestId, inventory: result.inventory, waterBucketGallons: result.waterBucketGallons, gardeningBucketGallons: result.gardeningBucketGallons, replayed: result.replayed });
        } catch (error) { sendGreenhouseError(socket, message.requestId, error); }
        return;
      }
      case "CRAFT_FERTILIZER": {
        requireHello(state.playerId);
        try {
          if (!greenhouses) throw new GreenhouseError("GREENHOUSE_UNAVAILABLE", "Greenhouse crafting is unavailable.");
          const player = gameState.getPlayer(state.playerId!);
          if (!player) throw new GreenhouseError("GREENHOUSE_PLAYER_REQUIRED", "Your player session is unavailable.");
          const result = await greenhouses.craftFertilizer(player, message.requestId);
          registry.send(player.playerId, {
            type: "GREENHOUSE_FERTILIZER_RESULT",
            requestId: message.requestId,
            inventory: result.inventory,
            replayed: result.replayed
          });
        } catch (error) { sendGreenhouseError(socket, message.requestId, error); }
        return;
      }
      case "FILL_WATER_BUCKET": {
        requireHello(state.playerId);
        try {
          if (!greenhouses) throw new GreenhouseError("GREENHOUSE_UNAVAILABLE", "Greenhouses are unavailable.");
          const player = gameState.getPlayer(state.playerId!);
          if (!player) throw new GreenhouseError("GREENHOUSE_PLAYER_REQUIRED", "Your player session is unavailable.");
          if (!gameState.isWorldPresent(player.playerId)) throw new GreenhouseError("GREENHOUSE_WORLD_REQUIRED", "Return to the world to fill a Water Bucket.");
          const result = await greenhouses.startWaterBucketFill(player, message.requestId, { lat: message.lat, lon: message.lon }, message.gallons);
          const prior = waterFillTimers.get(player.playerId);
          if (prior) clearTimeout(prior);
          const timer = setTimeout(() => {
            waterFillTimers.delete(player.playerId);
            void greenhouses.completeWaterBucketFill(player, `greenhouse-fill-complete:${message.requestId}`).then((completed) => {
              registry.send(player.playerId, { type: "GREENHOUSE_WATER_FILL_RESULT", requestId: message.requestId, gallons: completed.gallons, waterBucketGallons: completed.waterBucketGallons, inventory: completed.inventory, replayed: completed.replayed });
            }).catch((error: unknown) => {
              if (error instanceof GreenhouseError && (error.code === "GREENHOUSE_FILL_MISSING" || error.code === "GREENHOUSE_FILL_NOT_ACTIVE")) return;
              sendGreenhouseError(socket, message.requestId, error);
            });
          }, Math.max(0, result.completesAt - Date.now()));
          timer.unref?.();
          waterFillTimers.set(player.playerId, timer);
          registry.send(player.playerId, { type: "GREENHOUSE_WATER_FILL_STARTED", requestId: message.requestId, gallons: result.gallons, completesAt: result.completesAt, rangeM: result.rangeM, message: `Filling ${result.gallons} gallons; 3 seconds per gallon.` });
        } catch (error) { sendGreenhouseError(socket, message.requestId, error); }
        return;
      }
      case "CANCEL_WATER_BUCKET_FILL": {
        requireHello(state.playerId);
        try {
          if (!greenhouses) throw new GreenhouseError("GREENHOUSE_UNAVAILABLE", "Greenhouses are unavailable.");
          const player = gameState.getPlayer(state.playerId!);
          if (!player) throw new GreenhouseError("GREENHOUSE_PLAYER_REQUIRED", "Your player session is unavailable.");
          const timer = waterFillTimers.get(player.playerId);
          if (timer) clearTimeout(timer);
          waterFillTimers.delete(player.playerId);
          const result = await greenhouses.cancelWaterBucketFill(player, message.requestId);
          registry.send(player.playerId, { type: "GREENHOUSE_WATER_FILL_RESULT", requestId: message.requestId, gallons: result.creditedGallons, waterBucketGallons: result.waterBucketGallons, inventory: result.inventory, replayed: false });
        } catch (error) { sendGreenhouseError(socket, message.requestId, error); }
        return;
      }
      case "DEPOSIT_GREENHOUSE_WATER":
      case "REFILL_GARDENING_BUCKET": {
        requireHello(state.playerId);
        try {
           if (!greenhouses || !greenhouseRuntime) throw new GreenhouseError("GREENHOUSE_UNAVAILABLE", "Greenhouses are unavailable.");
           const player = gameState.getPlayer(state.playerId!);
           if (!player) throw new GreenhouseError("GREENHOUSE_PLAYER_REQUIRED", "Your player session is unavailable.");
           const session = greenhouseRuntime.requireSession(player.playerId, message.greenhouseSessionId);
           const waterStoragePosition = await greenhouses.waterStoragePosition(session.greenhouseId);
           if (!waterStoragePosition || !greenhouseRuntime.isNearWaterStorage(player.playerId, message.greenhouseSessionId, waterStoragePosition)) {
             throw new GreenhouseError("GREENHOUSE_TANK_RANGE", "Move next to the water tank before using it.");
           }
           const result = message.type === "DEPOSIT_GREENHOUSE_WATER"
             ? await greenhouses.depositWater(player, message.requestId, session.greenhouseId)
             : await greenhouses.refillGardeningBucket(player, message.requestId, session.greenhouseId);
          registry.send(player.playerId, { type: "GREENHOUSE_MUTATION_RESULT", requestId: message.requestId, action: message.type === "DEPOSIT_GREENHOUSE_WATER" ? "deposit" : "refill", state: result.state, inventory: result.inventory, replayed: result.replayed, message: result.message });
        } catch (error) { sendGreenhouseError(socket, message.requestId, error); }
        return;
      }
      case "OPEN_JEWEL_STATION": {
        requireHello(state.playerId);
        try {
          if (!jewelStation || !manorRuntime) {
            throw new JewelStationError("JEWEL_UNAVAILABLE", "The Jewel Station is unavailable.");
          }
          manorRuntime.authorizeJewel(state.playerId, message.manorSessionId, message.movementSequence);
          safeSendServerMessage(socket, {
            type: "JEWEL_STATION_STATE",
            requestId: message.requestId,
            state: await jewelStation.state(state.playerId)
          }, logger, {
            playerId: state.playerId,
            requestId: message.requestId,
            action: "open-jewel-station"
          });
        } catch (error) {
          sendJewelError(socket, message.requestId, error);
        }
        return;
      }
      case "PREPARE_JEWEL_EQUIPMENT":
      case "IMBUE_JEWEL_EQUIPMENT":
      case "REFORGE_JEWEL_EQUIPMENT": {
        requireHello(state.playerId);
        try {
          if (!jewelStation || !manorRuntime) {
            throw new JewelStationError("JEWEL_UNAVAILABLE", "The Jewel Station is unavailable.");
          }
          await playerAuthorityFence.run(state.playerId, async () => {
            manorRuntime.authorizeJewel(state.playerId!, message.manorSessionId, message.movementSequence);
            const result = message.type === "PREPARE_JEWEL_EQUIPMENT"
              ? await jewelStation.prepare(
                  state.playerId!, message.requestId, message.instanceId, message.gemstone
                )
              : message.type === "IMBUE_JEWEL_EQUIPMENT"
                ? await jewelStation.imbue(
                    state.playerId!, message.requestId, message.instanceId, message.metal
                  )
                : await jewelStation.reforge(
                    state.playerId!, message.requestId, message.instanceId,
                    {
                      gemstone: message.gemstone ?? null,
                      ...(message.changeMetal !== undefined ? { changeMetal: message.changeMetal } : {})
                    }
                  );
            safeSendServerMessage(
              socket,
              { type: "JEWEL_STATION_RESULT", ...result },
              logger,
              {
                playerId: state.playerId,
                requestId: message.requestId,
                action: message.type === "PREPARE_JEWEL_EQUIPMENT"
                  ? "prepare-jewel-equipment"
                  : message.type === "IMBUE_JEWEL_EQUIPMENT"
                    ? "imbue-jewel-equipment"
                    : "reforge-jewel-equipment"
              }
            );
          });
        } catch (error) {
          sendJewelError(socket, message.requestId, error);
        }
        return;
      }
      case "BUILD_MANOR": {
        requireHello(state.playerId);
        try {
          if (!manorPresence || !worldRuntime) throw new ManorError("UNAVAILABLE", "Manor construction is unavailable.");
          await playerAuthorityFence.run(state.playerId, async () => {
            const player = gameState.getPlayer(state.playerId!);
            if (!player) throw new ManorError("NOT_CONNECTED", "Player state is unavailable.");
            if (manorRuntime?.isInside(player.playerId) || await manorPresence.load(player.playerId)) {
              throw new ManorError("ALREADY_INSIDE", "You cannot build a manor while inside one.");
            }
            if (combat && (!combat.isPlayerAlive(player.playerId) || combat.hasQueuedAbility(player.playerId))) {
              throw new ManorError("CANNOT_ACT", "You cannot build a manor right now.");
            }
            if (combat?.isTravelLocked(player.playerId, AGGRESSIVE_FLAG_TRAVEL_LOCK_MS)) {
              throw new ManorError("TRAVEL_LOCKED", "Manor construction is locked for ten seconds after aggression.");
            }
            if (worldRuntime.hasPlayerWorldTransition(player.playerId) || worldRuntime.hasPendingCommand(player.playerId)) {
              throw new ManorError("TRANSITION_PENDING", "Finish the current world action before building your manor.");
            }
            if (flagBuilds?.activeForPlayer(player.playerId)) {
              throw new ManorError("FLAG_BUILD_ACTIVE", "Finish or cancel the current flag build first.");
            }
            if (await activeHarvestSessionForPlayer(player.playerId)) {
              throw new ManorError("ACTION_ACTIVE", "Finish or cancel the current harvest first.");
            }
            const transition = worldRuntime.beginPlayerWorldTransition(player.playerId);
            if (!transition) throw new ManorError("TRANSITION_PENDING", "Another transition is active.");
            try {
              gameState.stopPlayer(player.playerId);
              const authoritativePlayer = { ...player, position: { ...player.position }, target: null };
              const result = await manorPresence.build(authoritativePlayer, message.requestId);
              registry.send(player.playerId, {
                type: "MANOR_BUILD_RESULT",
                requestId: message.requestId,
                manor: result.manor,
                inventory: result.inventory,
                replayed: result.replayed
              });
              registry.send(player.playerId, { type: "MANOR_STATUS", manor: result.manor });
              if (worldMap) {
                registry.send(player.playerId, {
                  type: "WORLD_MAP_DESTINATIONS",
                  snapshot: await worldMap.snapshot(player.playerId)
                });
              }
              void broadcastManorSnapshots().catch((error: unknown) => {
                logger.warn({ err: error, playerId: player.playerId }, "failed to broadcast manor marker refresh");
              });
            } finally {
              worldRuntime.endPlayerWorldTransition(player.playerId, transition);
            }
          });
        } catch (error) {
          sendManorError(socket, message.requestId, error);
        }
        return;
      }
      case "OPEN_MANOR_UPGRADES": {
        requireHello(state.playerId);
        try {
          beginManorRequest();
          if (!manorPresence) throw new ManorError("UNAVAILABLE", "Manor upgrades are unavailable.");
          if (manorRuntime?.isInside(state.playerId)) {
            throw new ManorError("ALREADY_INSIDE", "Open Manor Upgrades from the built manor marker in the world.");
          }
          safeSendServerMessage(socket, {
            type: "MANOR_UPGRADES_SNAPSHOT",
            requestId: message.requestId,
            snapshot: await manorPresence.storageUpgradeSnapshotForOwner(state.playerId)
          });
        } catch (error) {
          sendManorError(socket, message.requestId, error);
        }
        return;
      }
      case "UPGRADE_MANOR_STORAGE": {
        requireHello(state.playerId);
        try {
          beginManorRequest();
          if (!manorPresence) throw new ManorError("UNAVAILABLE", "Manor upgrades are unavailable.");
          if (manorRuntime?.isInside(state.playerId)) {
            throw new ManorError("ALREADY_INSIDE", "Open Manor Upgrades from the built manor marker in the world.");
          }
          const result = await playerAuthorityFence.run(state.playerId, () =>
            manorPresence.upgradeStorage({
              playerId: state.playerId!,
              requestId: message.requestId,
              targetLevel: message.targetLevel
            })
          );
          safeSendServerMessage(socket, { type: "MANOR_UPGRADE_RESULT", ...result });
        } catch (error) {
          sendManorError(socket, message.requestId, error);
        }
        return;
      }
      case "DESTROY_MANOR": {
        requireHello(state.playerId);
        try {
          if (!manorPresence || !worldRuntime) throw new ManorError("UNAVAILABLE", "Manor destruction is unavailable.");
          await playerAuthorityFence.run(state.playerId, async () => {
            const player = gameState.getPlayer(state.playerId!);
            if (!player) throw new ManorError("NOT_CONNECTED", "Player state is unavailable.");
            if (manorRuntime?.isInside(player.playerId) || await manorPresence.load(player.playerId)) {
              throw new ManorError("ALREADY_INSIDE", "You cannot destroy your manor while inside it.");
            }
            if (combat && (!combat.isPlayerAlive(player.playerId) || combat.hasQueuedAbility(player.playerId))) {
              throw new ManorError("CANNOT_ACT", "You cannot destroy your manor right now.");
            }
            if (combat?.isTravelLocked(player.playerId, AGGRESSIVE_FLAG_TRAVEL_LOCK_MS)) {
              throw new ManorError("TRAVEL_LOCKED", "Manor destruction is locked for ten seconds after aggression.");
            }
            if (worldRuntime.hasPlayerWorldTransition(player.playerId) || worldRuntime.hasPendingCommand(player.playerId)) {
              throw new ManorError("TRANSITION_PENDING", "Finish the current world action before destroying your manor.");
            }
            if (flagBuilds?.activeForPlayer(player.playerId)) {
              throw new ManorError("FLAG_BUILD_ACTIVE", "Finish or cancel the current flag build first.");
            }
            if (await activeHarvestSessionForPlayer(player.playerId)) {
              throw new ManorError("ACTION_ACTIVE", "Finish or cancel the current harvest first.");
            }
            const transition = worldRuntime.beginPlayerWorldTransition(player.playerId);
            if (!transition) throw new ManorError("TRANSITION_PENDING", "Another transition is active.");
            try {
              gameState.stopPlayer(player.playerId);
              const result = await manorPresence.destroy(player.playerId, message.requestId);
              if (!result.replayed) {
                for (const { playerId: pendingPlayerId } of
                  manorRealtimeState.pendingEntriesForManor(result.manorId)) {
                  cancelPendingManorEntry(pendingPlayerId, {
                    stopMovement: true,
                    notify: true,
                    message: "That manor was destroyed."
                  });
                }
                const affected = await travelInvites?.invalidateForManor(
                  result.manorId,
                  "The manor was destroyed."
                ) ?? [];
                await sendTravelInboxForPlayers(affected);
                await Promise.all(result.ejected.map((presence) =>
                  playerAuthorityFence.run(
                    presence.playerId,
                    () => forceManorEjection(presence, "The manor was destroyed.")
                  )
                ));
              }
              registry.send(player.playerId, {
                type: "MANOR_DESTROY_RESULT",
                requestId: message.requestId,
                manorId: result.manorId,
                placementRevision: result.placementRevision,
                replayed: result.replayed
              });
              registry.send(player.playerId, { type: "MANOR_STATUS", manor: null });
              if (worldMap) {
                registry.send(player.playerId, {
                  type: "WORLD_MAP_DESTINATIONS",
                  snapshot: await worldMap.snapshot(player.playerId)
                });
              }
              void broadcastManorSnapshots().catch((error: unknown) => {
                logger.warn({ err: error, playerId: player.playerId }, "failed to broadcast destroyed manor marker refresh");
              });
            } finally {
              worldRuntime.endPlayerWorldTransition(player.playerId, transition);
            }
          });
        } catch (error) {
          sendManorError(socket, message.requestId, error);
        }
        return;
      }
      case "INSTALL_MANOR_SKIN": {
        requireHello(state.playerId);
        try {
          if (!manorPresence) throw new ManorError("UNAVAILABLE", "Manors are unavailable.");
          const playerId = state.playerId;
          const result = await playerAuthorityFence.run(playerId, async () => {
            const owned = await manorPresence.status(playerId);
            if (owned && manorRuntime && manorRuntime.playerIdsInManor(owned.manorId).some((id) => id !== playerId)) {
              throw new ManorError("MANOR_OCCUPIED", "Guests are inside your Manor. Change its skin once they have left.");
            }
            const equipped = await manorPresence.equipSkin({ playerId, requestId: message.requestId, manorTypeId: message.manorTypeId, copyId: message.copyId ?? null });
            if (equipped.manor) manorRuntime?.setManorType(equipped.manor.manorId, equipped.manor.manorTypeId);
            if (equipped.ownerRespawn) {
              await respawnManorOwnerAfterSkinChange(playerId, equipped.ownerRespawn.manorId).catch((error: unknown) => {
                logger.warn({ err: error, playerId }, "failed to re-enter the owner after a manor skin change");
              });
            }
            return equipped;
          });
          registry.send(playerId, {
            type: "MANOR_SKIN_RESULT",
            requestId: message.requestId,
            action: "install",
            manor: result.manor,
            inventory: result.inventory,
            replayed: result.replayed,
            message: result.message
          });
          registry.send(playerId, { type: "MANOR_STATUS", manor: result.manor });
          void broadcastManorSnapshots().catch((error: unknown) => {
            logger.warn({ err: error, playerId }, "failed to broadcast manor skin refresh");
          });
        } catch (error) {
          sendManorError(socket, message.requestId, error);
        }
        return;
      }
      case "JUMP_TO_MANOR": {
        requireHello(state.playerId);
        cancelPendingManorEntry(state.playerId, { notify: true });
        try {
          beginManorRequest();
          if (!manorPresence) throw new ManorError("UNAVAILABLE", "Manors are unavailable.");
          const manor = await manorPresence.builtManor(message.manorId);
          if (!manor) throw new ManorError("MANOR_NOT_BUILT", "That manor no longer exists.");
          if (manor.ownerPlayerId !== state.playerId) {
            throw new ManorError("MANOR_OWNER_REQUIRED", "Only the manor owner may jump to this manor.");
          }
          const operationKey = `${state.playerId}\0${message.requestId}`;
          let operation = manorRealtimeState.activeJump(operationKey);
          if (!operation) {
            operation = (async () => {
              if (await manorPresence.completedJump(state.playerId!, message.requestId, manor.manorId)) {
                return { success: true as const, replayed: true };
              }
              const connected = gameState.getPlayer(state.playerId!);
              if (!connected) throw new ManorError("NOT_CONNECTED", "Player state is unavailable.");
              const result = await performAuthoritativeTravel({
                playerId: state.playerId!,
                destination: {
                  kind: "manor",
                  id: manor.manorId,
                  center: { lat: manor.lat, lon: manor.lon },
                  travelAnchor: {
                    scopeId: "world",
                    layerId: `manor:${manor.manorId}`,
                    center: { lat: manor.lat, lon: manor.lon },
                    relocationRevision: connected.relocationRevision ?? 0,
                    layerGeneration: manor.placementRevision,
                    sourceType: "manor",
                    sourceId: manor.manorId
                  }
                },
                requestId: message.requestId,
                arrivalMode: "protected_jump",
                kind: "manor_jump",
                sendResult: false
              });
              if (!result.success) return result;
              await manorPresence.completeJump(
                state.playerId!,
                message.requestId,
                manor.manorId,
                result.player.relocationRevision ?? 0
              );
              return { success: true as const, replayed: false };
            })();
            manorRealtimeState.trackJump(operationKey, operation);
          }
          const result = await operation;
          if (!result.success) {
            sendTravelFailure(state.playerId, "manor_jump", result.reason, message.requestId);
          } else {
            registry.send(state.playerId, {
              type: "TRAVEL_RESULT",
              requestId: message.requestId,
              kind: "manor_jump",
              success: true,
              message: result.replayed ? "Manor jump already completed." : "Jumped to manor.",
              player: gameState.snapshotForPlayer(state.playerId),
              resourceVisionRevision: gameState.getResourceVisionRevision(state.playerId),
              arrivalPresentation: "jump"
            });
          }
        } catch (error) {
          sendManorError(socket, message.requestId, error);
        }
        return;
      }
      case "CANCEL_MANOR_ENTRY": {
        requireHello(state.playerId);
        cancelPendingManorEntry(state.playerId, {
          stopMovement: true,
          notify: true,
          message: "Manor entry cancelled."
        });
        return;
      }
      case "REQUEST_MANOR_GUESTS": {
        requireHello(state.playerId);
        try {
          beginManorRequest();
          await sendManorManagementSnapshot(state.playerId, message.manorId, message.requestId);
        } catch (error) {
          sendManorError(socket, message.requestId, error);
        }
        return;
      }
      case "KICK_MANOR_GUEST": {
        requireHello(state.playerId);
        try {
          beginManorRequest();
          if (!manorPresence || !manorRuntime || !travelInvites) {
            throw new ManorError("UNAVAILABLE", "Manor guest management is unavailable.");
          }
          await playerAuthorityFence.runMany([state.playerId, message.targetPlayerId], async () => {
            const presence = await manorPresence.kick(state.playerId!, message.manorId, message.targetPlayerId);
            cancelPendingManorEntry(message.targetPlayerId, { stopMovement: true, notify: true });
            const affected = await travelInvites.invalidateForManor(
              message.manorId,
              "The manor owner revoked this invitation.",
              message.targetPlayerId
            );
            await sendTravelInboxForPlayers(affected);
            await forceManorEjection(presence, "You were kicked from the manor.");
            await sendManorManagementSnapshot(state.playerId!, message.manorId, message.requestId);
          });
        } catch (error) {
          sendManorError(socket, message.requestId, error);
        }
        return;
      }
      case "BAN_MANOR_GUEST": {
        requireHello(state.playerId);
        try {
          beginManorRequest();
          if (!manorPresence || !travelInvites) {
            throw new ManorError("UNAVAILABLE", "Manor guest management is unavailable.");
          }
          await playerAuthorityFence.runMany([state.playerId, message.targetPlayerId], async () => {
            const presence = await manorPresence.ban(state.playerId!, message.manorId, message.targetPlayerId);
            cancelPendingManorEntry(message.targetPlayerId, { stopMovement: true, notify: true });
            const affected = await travelInvites.invalidateForManor(
              message.manorId,
              "The recipient is banned from this manor.",
              message.targetPlayerId
            );
            await sendTravelInboxForPlayers(affected);
            if (presence) await forceManorEjection(presence, "You were banned from this manor.");
            await sendManorManagementSnapshot(state.playerId!, message.manorId, message.requestId);
          });
        } catch (error) {
          sendManorError(socket, message.requestId, error);
        }
        return;
      }
      case "UNBAN_MANOR_GUEST": {
        requireHello(state.playerId);
        try {
          beginManorRequest();
          if (!manorPresence) throw new ManorError("UNAVAILABLE", "Manor guest management is unavailable.");
          await manorPresence.unban(state.playerId, message.manorId, message.targetPlayerId);
          await sendManorManagementSnapshot(state.playerId, message.manorId, message.requestId);
        } catch (error) {
          sendManorError(socket, message.requestId, error);
        }
        return;
      }
      case "ENTER_MANOR": {
        sendManorError(socket, message.requestId, new ManorError(
          "USE_PORTAL_REQUIRED", "Manor entry must use the universal portal system."
        ));
        return;
      }
      case "EXIT_MANOR": {
        sendManorError(socket, message.requestId, new ManorError(
          "USE_PORTAL_REQUIRED", "Manor exit must use the universal portal system."
        ));
        return;
      }
      case "MANOR_MOVE_TO": {
        requireHello(state.playerId);
        try {
          if (!manorRuntime) throw new ManorError("UNAVAILABLE", "Manors are unavailable.");
          const session = manorRuntime.moveTo(state.playerId, message.manorSessionId, message.x, message.y);
          safeSendServerMessage(socket, {
            type: "MANOR_POSITION",
            manorSessionId: session.sessionId,
            spaceId: session.spaceId,
            position: session.position,
            movementSequence: session.movementSequence,
            serverTime: Date.now()
          });
        } catch (error) { sendManorError(socket, message.requestId, error); }
        return;
      }
      case "REQUEST_MANOR_DECORATIONS": {
        requireHello(state.playerId);
        try {
          if (!manorRuntime || !manorDecorations) {
            throw new ManorError("UNAVAILABLE", "Manor decorations are unavailable.");
          }
          const session = manorRuntime.requireSession(state.playerId, message.manorSessionId);
          const snapshot = await manorDecorations.snapshotForPlayer(
            state.playerId,
            session.manorId
          );
          manorRuntime.setManorNavigation(
            snapshot.manorId,
            session.spaceId,
            manorDecorations.navigationForManor(snapshot.manorId, session.spaceId)
          );
          safeSendServerMessage(socket, {
            type: "MANOR_DECORATIONS_SNAPSHOT",
            requestId: message.requestId,
            snapshot
          });
        } catch (error) { sendManorError(socket, message.requestId, error); }
        return;
      }
      case "PLACE_MANOR_DECORATION":
      case "MOVE_MANOR_DECORATION":
      case "REMOVE_MANOR_DECORATION": {
        requireHello(state.playerId);
        try {
          if (!manorRuntime || !manorDecorations) {
            throw new ManorError("UNAVAILABLE", "Manor decorations are unavailable.");
          }
          const playerId = state.playerId;
          const result = await playerAuthorityFence.run(playerId, async () => {
            const session = manorRuntime.requireSession(playerId, message.manorSessionId);
            if (message.type === "PLACE_MANOR_DECORATION") {
              return manorDecorations.place({
                playerId,
                requestId: message.requestId,
                manorSessionId: session.sessionId,
                spaceId: session.spaceId,
                definitionId: message.definitionId,
                ...(message.x === undefined ? {} : { x: message.x }),
                ...(message.y === undefined ? {} : { y: message.y })
              });
            }
            if (message.type === "MOVE_MANOR_DECORATION") {
              return manorDecorations.move({
                playerId,
                requestId: message.requestId,
                manorSessionId: session.sessionId,
                spaceId: session.spaceId,
                placementId: message.placementId,
                x: message.x,
                y: message.y
              });
            }
            return manorDecorations.remove({
              playerId,
              requestId: message.requestId,
              manorSessionId: session.sessionId,
              placementId: message.placementId
            });
          });
          const currentSession = manorRuntime.requireSession(playerId, message.manorSessionId);
          manorRuntime.setManorNavigation(
            result.snapshot.manorId,
            currentSession.spaceId,
            manorDecorations.navigationForManor(result.snapshot.manorId, currentSession.spaceId)
          );
          safeSendServerMessage(socket, {
            type: "MANOR_DECORATION_UPDATED",
            ...result
          });
          for (const occupantId of manorRuntime.playerIdsInManor(result.snapshot.manorId)) {
            if (occupantId === playerId) continue;
            try {
              const occupantSnapshot = await manorDecorations.snapshotForPlayer(
                occupantId,
                result.snapshot.manorId
              );
              registry.send(occupantId, {
                type: "MANOR_DECORATIONS_SNAPSHOT",
                requestId: "broadcast",
                snapshot: occupantSnapshot
              });
            } catch (error) {
              logger.warn({ err: error, playerId: occupantId, manorId: result.snapshot.manorId },
                "failed to broadcast Manor decoration snapshot");
            }
          }
        } catch (error) { sendManorError(socket, message.requestId, error); }
        return;
      }
      case "OPEN_MANOR_STORAGE": {
        requireHello(state.playerId);
        try {
          if (!manorRuntime || !manorStorage) throw new ManorError("UNAVAILABLE", "Manors are unavailable.");
          if (!manorRuntime.isNearChest(state.playerId, message.manorSessionId)) {
            throw new ManorError("CHEST_OUT_OF_RANGE", "Move closer to the chest first.");
          }
          safeSendServerMessage(socket, {
            type: "MANOR_STORAGE_SNAPSHOT",
            requestId: message.requestId,
            manorSessionId: message.manorSessionId,
            storage: await manorStorage.snapshotForPlayer(state.playerId)
          });
        } catch (error) { sendManorError(socket, message.requestId, error); }
        return;
      }
      case "REQUEST_MANOR_STORAGE_VIEW": {
        requireHello(state.playerId);
        try {
          if (!manorRuntime || !manorStorage) {
            throw new ManorError("UNAVAILABLE", "Manor storage is unavailable.");
          }
          if (manorRuntime.isInside(state.playerId)) {
            throw new ManorError(
              "MANOR_VIEW_INSIDE",
              "Use the manor chest while you are inside a manor."
            );
          }
          safeSendServerMessage(socket, {
            type: "MANOR_STORAGE_VIEW_SNAPSHOT",
            requestId: message.requestId,
            storage: await manorStorage.snapshotForOwner(state.playerId)
          });
        } catch (error) {
          sendManorError(socket, message.requestId, error);
        }
        return;
      }
      case "MOVE_MANOR_STACK":
      case "SPLIT_MANOR_STACK":
      case "RESTACK_MANOR_STACK":
      case "REORGANIZE_MANOR_STORAGE":
      case "TRANSFER_MANOR_STACK":
      case "TRANSFER_MANOR_EQUIPMENT":
      case "TRANSFER_MANOR_BACKPACK":
      case "BULK_STORE_MANOR_ITEMS":
      case "BULK_TAKE_MANOR_ITEMS": {
        requireHello(state.playerId);
        const manorPlayerId = state.playerId;
        try {
          if (!manorRuntime || !manorStorage) throw new ManorError("UNAVAILABLE", "Manors are unavailable.");
          const result = await playerAuthorityFence.run(manorPlayerId, async () => {
            manorRuntime.requireSession(manorPlayerId, message.manorSessionId);
            if (!manorRuntime.isNearChest(manorPlayerId, message.manorSessionId)) {
              throw new ManorError("CHEST_OUT_OF_RANGE", "Move closer to the chest first.");
            }
            if (message.type === "MOVE_MANOR_STACK") {
              return manorStorage.moveStack(
                manorPlayerId, message.requestId, message.stackId, message.targetSlot
              );
            }
            if (message.type === "SPLIT_MANOR_STACK") {
              return manorStorage.splitStack(
                manorPlayerId, message.requestId, message.stackId, message.quantity
              );
            }
            if (message.type === "RESTACK_MANOR_STACK") {
              return manorStorage.restackStack(
                manorPlayerId, message.requestId, message.stackId
              );
            }
            if (message.type === "REORGANIZE_MANOR_STORAGE") {
              return manorStorage.reorganize(manorPlayerId, message.requestId);
            }
            if (message.type === "TRANSFER_MANOR_STACK") {
              return manorStorage.transfer({
                playerId: manorPlayerId,
                requestId: message.requestId,
                direction: message.direction,
                sourceStackId: message.sourceStackId,
                quantity: message.quantity
              });
            }
            if (message.type === "TRANSFER_MANOR_EQUIPMENT") {
              return manorStorage.transferEquipment({
                playerId: manorPlayerId,
                requestId: message.requestId,
                direction: message.direction,
                equipmentInstanceId: message.equipmentInstanceId
              });
            }
            if (message.type === "TRANSFER_MANOR_BACKPACK") {
              return manorStorage.transferBackpack({
                playerId: manorPlayerId,
                requestId: message.requestId,
                direction: message.direction,
                backpackInstanceId: message.backpackInstanceId
              });
            }
            return manorStorage.bulkTransfer(
              manorPlayerId,
              message.requestId,
              message.type === "BULK_STORE_MANOR_ITEMS" ? "deposit" : "withdrawal"
            );
          });
          safeSendServerMessage(socket, { type: "MANOR_STORAGE_UPDATED", ...result });
        } catch (error) { sendManorError(socket, message.requestId, error); }
        return;
      }
    }
  };
}

function sendFurnaceError(
  socket: SocketLike,
  requestId: string | undefined,
  error: unknown
): void {
  const furnaceError = error instanceof FurnaceError ? error : null;
  const clearanceError = error instanceof OutdoorStationClearanceError ? error : null;
  sendServerMessage(socket, {
    type: "FURNACE_ERROR",
    ...(requestId ? { requestId } : {}),
    code: clearanceError?.code ?? furnaceError?.code ?? "FURNACE_REQUEST_REJECTED",
    message: error instanceof Error ? error.message : "Furnace request rejected",
    ...(clearanceError?.suggestedPosition ? { suggestedPosition: clearanceError.suggestedPosition } : {})
  });
}

function sendTanneryError(
  socket: SocketLike,
  requestId: string | undefined,
  error: unknown
): void {
  const tanneryError = error instanceof TanneryError ? error : null;
  const clearanceError = error instanceof OutdoorStationClearanceError ? error : null;
  sendServerMessage(socket, {
    type: "TANNERY_ERROR",
    ...(requestId ? { requestId } : {}),
    code: clearanceError?.code ?? tanneryError?.code ?? "TANNERY_REQUEST_REJECTED",
    message: error instanceof Error ? error.message : "Tannery request rejected",
    ...(clearanceError?.suggestedPosition ? { suggestedPosition: clearanceError.suggestedPosition } : {})
  });
}

function sendLoomError(
  socket: SocketLike,
  requestId: string | undefined,
  error: unknown
): void {
  const loomError = error instanceof LoomError ? error : null;
  const clearanceError = error instanceof OutdoorStationClearanceError ? error : null;
  sendServerMessage(socket, {
    type: "LOOM_ERROR",
    ...(requestId ? { requestId } : {}),
    code: clearanceError?.code ?? loomError?.code ?? "LOOM_REQUEST_REJECTED",
    message: error instanceof Error ? error.message : "Loom request rejected",
    ...(clearanceError?.suggestedPosition ? { suggestedPosition: clearanceError.suggestedPosition } : {})
  });
}

function sendKitchenError(
  socket: SocketLike,
  requestId: string | undefined,
  error: unknown
): void {
  const kitchenError = error instanceof KitchenError ? error : null;
  const clearanceError = error instanceof OutdoorStationClearanceError ? error : null;
  sendServerMessage(socket, {
    type: "KITCHEN_ERROR",
    ...(requestId ? { requestId } : {}),
    code: clearanceError?.code ?? kitchenError?.code ?? "KITCHEN_REQUEST_REJECTED",
    message: error instanceof Error ? error.message : "Kitchen request rejected",
    ...(clearanceError?.suggestedPosition ? { suggestedPosition: clearanceError.suggestedPosition } : {})
  });
}

function sendGreenhouseError(
  socket: SocketLike,
  requestId: string | undefined,
  error: unknown
): void {
  const greenhouseError = error instanceof GreenhouseError ? error : null;
  sendServerMessage(socket, {
    type: "GREENHOUSE_ERROR",
    ...(requestId ? { requestId } : {}),
    code: greenhouseError?.code ?? "GREENHOUSE_REQUEST_REJECTED",
    message: error instanceof Error ? error.message : "Greenhouse request rejected"
  });
}

function sendFishingError(
  socket: SocketLike,
  requestId: string | undefined,
  error: unknown
): void {
  const fishingError = error instanceof FishingError ? error : null;
  const clearanceError = error instanceof OutdoorStationClearanceError ? error : null;
  const suggestedPosition = clearanceError?.suggestedPosition ?? fishingError?.suggestedPosition;
  sendServerMessage(socket, {
    type: "FISHING_ERROR",
    ...(requestId ? { requestId } : {}),
    code: clearanceError?.code ?? fishingError?.code ?? "FISHING_REQUEST_REJECTED",
    message: error instanceof Error ? error.message : "Fishing request rejected",
    ...(suggestedPosition ? { suggestedPosition } : {})
  });
}

function sendJewelError(
  socket: SocketLike,
  requestId: string | undefined,
  error: unknown
): void {
  const jewelError = error instanceof JewelStationError ? error : null;
  const manorError = error instanceof ManorError ? error : null;
  sendServerMessage(socket, {
    type: "JEWEL_STATION_ERROR",
    ...(requestId ? { requestId } : {}),
    code: jewelError?.code ?? manorError?.code ?? "JEWEL_REQUEST_REJECTED",
    message: error instanceof Error ? error.message : "Jewel Station request rejected"
  });
}

export function registerManorHandler(
  router: RealtimeMessageRouter,
  handler: RealtimeFamilyHandler<"manor">
): void {
  router.register("manor", handler);
}
