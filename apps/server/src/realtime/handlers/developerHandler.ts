import type { TerritoryCollapseService } from "../../game/territoryCollapse.js";
import type { EquipmentSnapshotV2 } from "@ash-atlas/shared";
import {
  DEFAULT_FLAG_RESOURCE_VISION_RADIUS_M,
  CITY_STRUCTURE_SNAPSHOT_RADIUS_M,
  applyClassCombatStats,
  clampToWorldEdge,
  distanceMeters,
  type ClassSnapshot,
  type DeveloperCapability,
  type EquipmentSnapshot,
  type HarvestSessionSnapshot,
  type KingdomStatModifiers,
  type ProgressionSnapshot,
  type ServerMessage,
  type SkillSystemV3Snapshot
} from "@ash-atlas/shared";
import type pg from "pg";

import type { AuthService } from "../../auth/authService.js";
import {
  developmentAssetGrantCapability,
  isDeveloperEconomyMode
} from "../../auth/developerAuthorization.js";
import type { AuthenticatedSession } from "../../auth/types.js";
import type { AppConfig } from "../../config.js";
import type { AppLogger } from "../../logger.js";
import { CityFoundingError, type CityService } from "../../game/cities.js";
import { CityStructureError } from "../../game/cityStructures.js";
import type { WorldMapService } from "../../game/worldMap.js";
import type { ChatRealtimeCoordinator } from "../../chat/chatRealtime.js";
import { flagSetRevisionMetadata } from "../../game/flags.js";
import { ClassRequestError, type ClassService } from "../../game/classes/classService.js";
import {
  playerEquipmentCombatStateFromSnapshot,
  type CombatEngine
} from "../../game/combat/combatEngine.js";
import {
  DevelopmentEconomyError,
  type DevelopmentEconomyService
} from "../../game/developmentEconomy.js";
import {
  EquipmentError,
  type EquipmentRuntimeContext,
  type EquipmentService
} from "../../game/equipment.js";
import type { EquipmentDefinitionId } from "@ash-atlas/shared";

/** Stock Sword and stock chest armor used by the developer metal grants. */
const DEV_METAL_SWORD_DEFINITION_ID = "starter_sword" as EquipmentDefinitionId;
const DEV_METAL_CHEST_DEFINITION_ID = "leather_armor" as EquipmentDefinitionId;
import type { DeveloperSpawnedDungeonService } from "../../game/developerSpawnedDungeons.js";
import { DeveloperSpawnedDungeonError } from "../../game/developerSpawnedDungeons.js";
import { DungeonError, type CisternWarrensRuntime } from "../../game/dungeon.js";
import type { DeveloperSpawnedMobService } from "../../game/developerSpawnedMobs.js";
import type { HollinHutService } from "../../game/hollinHuts.js";
import type { DeveloperSpawnedPlantService } from "../../game/developerSpawnedPlants.js";
import type { FlagBuildCoordinator } from "../../game/flagBuildCoordinator.js";
import type { FlagService } from "../../game/flags.js";
import type { HarvestSessionService } from "../../game/harvestSessions.js";
import type { PlayerAuthorityFence } from "../../game/playerAuthorityFence.js";
import type { PlayerService } from "../../game/players.js";
import type { ProgressionService } from "../../game/progression.js";
import { SkillRequestError, type SkillService } from "../../game/skills/index.js";
import type { RepeatableResourceService } from "../../game/repeatableResources.js";
import { resourceVisionForArea } from "../../game/resourceVision.js";
import { greenhouseStateForCropCapableClient } from "../../game/greenhouseCropContent.js";
import { packageIdForPosition, zoneIdForPosition } from "../../game/spatialZones.js";
import type { GameState } from "../../game/state.js";
import {
  getCityConstructionBlockReason,
  type TravelBlockReason
} from "../../game/travelEligibility.js";
import type { TravelInviteService } from "../../game/travelInvites.js";
import { validateMoveTarget } from "../../game/validation.js";
import type { WorldCommandInput } from "../../game/worldCommandQueue.js";
import type { WorldRuntime } from "../../game/worldRuntime.js";
import type { XoralEventService } from "../../game/xoralEvents.js";
import { GoblinVillageError, type GoblinVillageService } from "../../game/goblinVillage.js";
import type { ManorPresenceService } from "../../game/manor.js";
import type { GreenhouseService } from "../../game/greenhouses.js";
import type { GreenhouseRuntime } from "../../game/greenhouseRuntime.js";
import type { WorldLookupClient } from "../../world/worldLookupClient.js";
import type { ClassRealtimeState } from "../classRealtimeState.js";
import type { ConnectionRegistry, SocketLike } from "../connectionRegistry.js";
import type { DeveloperRealtimeState } from "../developerRealtimeState.js";
import type { RealtimeFamilyHandler, RealtimeMessageRouter } from "../messageRouter.js";
import type { RelocationPopulationReadiness } from "../populationRealtimeOperations.js";
import { requireHello, type RealtimeConnectionState } from "./handlerExecutionContext.js";
import type { ResolvedTravelDestination, TravelArrivalMode } from "../travelContracts.js";

type Position = { lat: number; lon: number };
type ConnectionWorldCommand = WorldCommandInput extends infer Command
  ? Command extends WorldCommandInput
    ? Omit<Command, "playerId" | "accountId" | "connectionId">
    : never
  : never;
type PopulationRelocation = Readonly<{
  playerId: string;
  connectionId: string;
  connectionGeneration: number;
  relocationRevision: number;
  resourceVisionRevision: number;
  gameplayViewGeneration: number;
  isCurrent(): boolean;
}>;
type TravelResult =
  | { success: true; player: ReturnType<GameState["snapshotForPlayer"]> }
  | { success: false; reason: TravelBlockReason };

export type DeveloperHandlerContext = Readonly<{
  state: Pick<RealtimeConnectionState, "playerId" | "connectionId" | "greenhouseCropCatalogVersion" | "greenhouseCropPackId">;
  socket: SocketLike;
  authenticatedSession: AuthenticatedSession | null | undefined;
  auth?: AuthService | undefined;
  config?: AppConfig | undefined;
  logger: AppLogger;
  registry: ConnectionRegistry;
  worldLookup?: WorldLookupClient | undefined;
  gameState: GameState;
  flagService: FlagService;
  playerService: PlayerService;
  worldRuntime?: WorldRuntime | undefined;
  harvestSessions?: HarvestSessionService | undefined;
  combat?: CombatEngine | undefined;
  developerSpawnedMobs?: DeveloperSpawnedMobService | undefined;
  hollinHuts?: HollinHutService | undefined;
  developerSpawnedPlants?: DeveloperSpawnedPlantService | undefined;
  developerSpawnedDungeons?: DeveloperSpawnedDungeonService | undefined;
  dungeon?: Pick<CisternWarrensRuntime, "resetDeveloperRun"> | undefined;
  goblinVillage?: GoblinVillageService | undefined;
  greenhouses?: GreenhouseService | undefined;
  greenhouseRuntime?: GreenhouseRuntime | undefined;
  manorPresence?: ManorPresenceService | undefined;
  progression?: ProgressionService | undefined;
  equipment?: EquipmentService | undefined;
  cities?: CityService | undefined;
  territoryCollapse?: Pick<TerritoryCollapseService, "begin"> | undefined;
  chats?: Pick<ChatRealtimeCoordinator, "refreshAuthorizedPlayer"> | undefined;
  worldMap?: Pick<WorldMapService, "invalidateFeaturedCities" | "snapshot"> | undefined;
  classes?: ClassService | undefined;
  skills?: SkillService | undefined;
  developmentEconomy?: DevelopmentEconomyService | undefined;
  travelInvites?: TravelInviteService | undefined;
  repeatableResources?: RepeatableResourceService | undefined;
  xoralEvents?: XoralEventService | undefined;
  classRealtimeState: ClassRealtimeState;
  developerRealtimeState: DeveloperRealtimeState;
  playerAuthorityFence: PlayerAuthorityFence;
  flagBuilds: FlagBuildCoordinator | null;
  activeHarvestSessionForPlayer(playerId: string): Promise<HarvestSessionSnapshot | null>;
  enforcePlayerClassRate(key: string, maximum: number, windowMs: number): void;
  enqueueWorldCommand(command: ConnectionWorldCommand): boolean;
  applyLiveSkillMutationState(
    playerId: string,
    snapshot: SkillSystemV3Snapshot,
    equipment: EquipmentSnapshotV2,
    options?: Readonly<{ preserveHealthPercentage?: boolean }>
  ): Promise<ProgressionSnapshot | null>;
  equipmentRuntimeContextFor(
    progression: ProgressionSnapshot | null,
    snapshot: ClassSnapshot | null
  ): EquipmentRuntimeContext;
  followPartyLeader(
    leaderPlayerId: string,
    destination: ResolvedTravelDestination,
    transitionEventId: string,
    arrivalPlan?: Readonly<{
      positions: ReadonlyMap<string, Position>;
      release(): void;
    }> | null
  ): Promise<void>;
  gameplayInterestCenter(playerId: string, fallback: Position): Position;
  gameplayInterestZoneIds(playerId: string, fallback: Position): string[];
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
  rejectDuringPlayerWorldTransition(requestId: string): boolean;
  safeSendServerMessage(
    socket: SocketLike,
    message: ServerMessage,
    logger?: Pick<AppLogger, "warn">,
    context?: Record<string, unknown>
  ): boolean;
  schedulePopulationV2RelocationForActivePlayer(
    playerId: string,
    trigger:
      | "world-entry"
      | "reconnect"
      | "flag-travel"
      | "party-travel"
      | "flag-placement"
      | "separate-space-exit"
      | "administrative-relocation"
      | "explicit-relocation",
    expectedConnection?: Readonly<{
      connectionId: string;
      connectionGeneration: number;
      requestId?: string;
    }>
  ): PopulationRelocation | null;
  sendCollectiblesForPlayer(
    player: ReturnType<GameState["getPlayer"]>,
    isCurrent?: () => boolean
  ): Promise<void>;
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
  sendCombatScopeSnapshot(playerId: string): void;
  sendDroppedItemsToSocket(playerId: string, isCurrent?: () => boolean): Promise<void>;
  sendManorsForPlayer(player: ReturnType<GameState["getPlayer"]>): Promise<void>;
  sendTravelInboxForPlayers(playerIds: Iterable<string>, isCurrent?: () => boolean): Promise<void>;
  syncCombatPlayerAfterRelocation(player: ReturnType<GameState["snapshotForPlayer"]>): void;
  waitForRelocationPopulationV2(input: Readonly<{
    playerId: string;
    requestId: string;
    destination: Position;
    transitionToken: symbol;
    relocation: PopulationRelocation | null;
  }>): Promise<RelocationPopulationReadiness>;
  withEquipmentStats(
    progression: ProgressionSnapshot,
    equipment: EquipmentSnapshot,
    kingdom?: KingdomStatModifiers
  ): ProgressionSnapshot;
}>;

export function createDeveloperHandler(
  context: DeveloperHandlerContext
): RealtimeFamilyHandler<"developer"> {
  return async (message) => {
    const {
      state,
      socket,
      authenticatedSession,
      auth,
      config,
      logger,
      registry,
      worldLookup,
      gameState,
      flagService,
      playerService,
      worldRuntime,
      harvestSessions,
      combat,
      developerSpawnedMobs,
      hollinHuts,
      developerSpawnedPlants,
      developerSpawnedDungeons,
      dungeon,
      goblinVillage,
      greenhouses,
      greenhouseRuntime,
      manorPresence,
      progression,
      equipment,
      cities,
      territoryCollapse,
      chats,
      worldMap,
      classes,
      skills,
      developmentEconomy,
      travelInvites,
      repeatableResources,
      xoralEvents,
      classRealtimeState,
      developerRealtimeState,
      playerAuthorityFence,
      flagBuilds,
      activeHarvestSessionForPlayer,
      enforcePlayerClassRate,
      enqueueWorldCommand,
      applyLiveSkillMutationState,
      equipmentRuntimeContextFor,
      followPartyLeader,
      gameplayInterestCenter,
      gameplayInterestZoneIds,
      performAuthoritativeTravel,
      rejectDuringPlayerWorldTransition,
      safeSendServerMessage,
      schedulePopulationV2RelocationForActivePlayer,
      sendCollectiblesForPlayer,
      sendCombatError,
      sendCombatScopeSnapshot,
      sendDroppedItemsToSocket,
      sendManorsForPlayer,
      sendTravelInboxForPlayers,
      syncCombatPlayerAfterRelocation,
      waitForRelocationPopulationV2,
      withEquipmentStats
    } = context;
    void enqueueWorldCommand;
    const authorizeDeveloperMessage = async (
      capability: DeveloperCapability,
      command: string,
      requestId: string,
      target: string | null = null,
      operationKey: string | null = null
    ): Promise<boolean> => {
      try {
        if (!auth || !authenticatedSession?.player) {
          throw new Error("developer authorization unavailable");
        }
        await auth.authorizeDeveloperCommand(authenticatedSession, {
          capability,
          command,
          transport: "websocket",
          target,
          operationKey
        });
        return true;
      } catch {
        sendCombatError(
          socket,
          requestId,
          "DEVELOPER_COMMAND_FORBIDDEN",
          "Developer command is unavailable"
        );
        return false;
      }
    };
    const recordDeveloperMessageResult = async (
      capability: DeveloperCapability,
      command: string,
      outcome: "succeeded" | "failed",
      target: string | null = null,
      operationKey: string | null = null
    ): Promise<void> => {
      if (!auth || !authenticatedSession) return;
      await auth.recordDeveloperCommandResult(authenticatedSession, {
        capability,
        command,
        transport: "websocket",
        outcome,
        target,
        operationKey
      });
    };
    const sendDevProgressionError = (
      targetSocket: SocketLike,
      operationId: string,
      error: unknown
    ): void => {
      const classError = error instanceof ClassRequestError ? error : null;
      safeSendServerMessage(targetSocket, {
        type: "ERROR",
        requestId: operationId,
        code: classError?.code.startsWith("DEV_PROGRESSION_")
          ? classError.code
          : "DEV_PROGRESSION_REJECTED",
        message: error instanceof Error ? error.message : "Development progression request rejected"
      });
    };
    const sendDevSubclassError = (
      targetSocket: SocketLike,
      operationId: string,
      error: unknown
    ): void => {
      const classError = error instanceof ClassRequestError ? error : null;
      const code = classError?.code === "DEV_PROGRESSION_DISABLED"
        ? "DEV_SUBCLASS_DISABLED"
        : classError?.code === "DEV_PROGRESSION_RESTRICTED"
          ? "DEV_SUBCLASS_RESTRICTED"
          : classError?.code.startsWith("SUBCLASS_")
            ? classError.code
            : "DEV_SUBCLASS_REJECTED";
      safeSendServerMessage(targetSocket, {
        type: "ERROR",
        requestId: operationId,
        code,
        message: error instanceof Error ? error.message : "Development subclass request rejected"
      });
    };
    switch (message.type) {
      case "DEV_ADVANCE_ALL_GREENHOUSE_CROPS":
      case "DEV_WATER_ALL_GREENHOUSE_CROPS": {
        requireHello(state.playerId);
        if (!(await authorizeDeveloperMessage(
          "developer:economy-mutate",
          message.type === "DEV_ADVANCE_ALL_GREENHOUSE_CROPS" ? "greenhouse.advance-all" : "greenhouse.water-all",
          message.requestId,
          state.playerId,
          message.requestId
        ))) return;
        const session = greenhouseRuntime?.get(state.playerId);
        const greenhouseId = session?.greenhouseId;
        try {
          if (!greenhouses || !greenhouseRuntime || !greenhouseId) {
            throw new Error("Enter your owned Greenhouse before using these test controls.");
          }
          const result = message.type === "DEV_ADVANCE_ALL_GREENHOUSE_CROPS"
            ? await greenhouses.developerAdvanceAllCrops(state.playerId, greenhouseId, message.requestId)
            : await greenhouses.developerWaterAllCrops(state.playerId, greenhouseId, message.requestId);
          safeSendServerMessage(socket, {
            type: "GREENHOUSE_STATE",
            requestId: message.requestId,
            state: await greenhouseStateForCropCapableClient(
              result.state,
              state.greenhouseCropCatalogVersion,
              state.greenhouseCropPackId
            )
          });
          await recordDeveloperMessageResult(
            "developer:economy-mutate",
            message.type === "DEV_ADVANCE_ALL_GREENHOUSE_CROPS" ? "greenhouse.advance-all" : "greenhouse.water-all",
            "succeeded",
            greenhouseId,
            message.requestId
          );
        } catch (error) {
          await recordDeveloperMessageResult(
            "developer:economy-mutate",
            message.type === "DEV_ADVANCE_ALL_GREENHOUSE_CROPS" ? "greenhouse.advance-all" : "greenhouse.water-all",
            "failed",
            greenhouseId ?? state.playerId,
            message.requestId
          );
          safeSendServerMessage(socket, {
            type: "GREENHOUSE_ERROR",
            requestId: message.requestId,
            code: "GREENHOUSE_DEVELOPER_ACTION_REJECTED",
            message: error instanceof Error ? error.message : "Greenhouse test action rejected"
          });
        }
        return;
      }
      case "DEV_BUILD_MANOR": {
        requireHello(state.playerId);
        if (!(await authorizeDeveloperMessage(
          "developer:assets-grant",
          "manor.build",
          message.requestId,
          state.playerId,
          message.requestId
        ))) return;
        try {
          if (!manorPresence) throw new Error("Manor service is unavailable");
          const player = gameState.getPlayer(state.playerId);
          if (!player) throw new Error("Player state is unavailable");
          if (await manorPresence.load(player.playerId)) throw new Error("Leave your manor before building another.");
          gameState.stopPlayer(player.playerId);
          const result = await manorPresence.build(
            { ...player, position: { ...player.position }, target: null },
            message.requestId,
            { developer: true }
          );
          registry.send(player.playerId, {
            type: "MANOR_BUILD_RESULT",
            requestId: message.requestId,
            manor: result.manor,
            inventory: result.inventory,
            replayed: result.replayed
          });
          registry.send(player.playerId, { type: "MANOR_STATUS", manor: result.manor });
          await sendManorsForPlayer(gameState.getPlayer(player.playerId));
          await recordDeveloperMessageResult("developer:assets-grant", "manor.build", "succeeded", state.playerId, message.requestId);
        } catch (error) {
          await recordDeveloperMessageResult("developer:assets-grant", "manor.build", "failed", state.playerId, message.requestId);
          safeSendServerMessage(socket, {
            type: "ERROR",
            requestId: message.requestId,
            code: "DEV_BUILD_MANOR_REJECTED",
            message: error instanceof Error ? error.message : "Developer manor build rejected"
          });
        }
        return;
      }
      case "DEV_BUILD_SALON": {
        requireHello(state.playerId);
        if (!(await authorizeDeveloperMessage(
          "developer:world-mutate",
          "salon.build",
          message.requestId,
          state.playerId,
          message.requestId
        ))) return;
        try {
          if (!cities?.structures) throw new Error("City structure service is unavailable");
          const player = gameState.getPlayer(state.playerId);
          if (!player) throw new Error("Player state is unavailable");
          const result = await cities.structures.buildDeveloperSalon(
            { playerId: player.playerId, position: { ...player.position } },
            message.requestId
          );
          registry.broadcast({ type: "CITY_FACILITY_CHANGED", requestId: message.requestId, structure: result.structure });
          await recordDeveloperMessageResult("developer:world-mutate", "salon.build", "succeeded", state.playerId, message.requestId);
        } catch (error) {
          await recordDeveloperMessageResult("developer:world-mutate", "salon.build", "failed", state.playerId, message.requestId);
          safeSendServerMessage(socket, {
            type: "ERROR",
            requestId: message.requestId,
            code: "DEV_BUILD_SALON_REJECTED",
            message: error instanceof Error ? error.message : "Developer salon build rejected"
          });
        }
        return;
      }
      case "DEV_GRANT_METAL_EQUIPMENT": {
        requireHello(state.playerId);
        if (!(await authorizeDeveloperMessage(
          "developer:assets-grant",
          "metal-equipment.grant",
          message.requestId,
          state.playerId,
          message.requestId
        ))) return;
        try {
          if (!equipment) throw new Error("Equipment service is unavailable");
          enforcePlayerClassRate("dev-economy", 12, 10_000);
          const result = await equipment.grantDeveloperMetalEquipment(
            state.playerId,
            message.requestId,
            message.kind === "sword" ? DEV_METAL_SWORD_DEFINITION_ID : DEV_METAL_CHEST_DEFINITION_ID,
            message.metal
          );
          registry.send(state.playerId, {
            type: "EQUIPMENT_SNAPSHOT",
            equipment: result.equipment
          });
          await recordDeveloperMessageResult(
            "developer:assets-grant",
            "metal-equipment.grant",
            "succeeded",
            state.playerId,
            message.requestId
          );
        } catch (error) {
          await recordDeveloperMessageResult(
            "developer:assets-grant",
            "metal-equipment.grant",
            "failed",
            state.playerId,
            message.requestId
          );
          safeSendServerMessage(socket, {
            type: "ERROR",
            requestId: message.requestId,
            code: error instanceof EquipmentError ? error.code : "DEV_METAL_EQUIPMENT_REJECTED",
            message: error instanceof Error ? error.message : "Metal equipment grant rejected"
          });
        }
        return;
      }
      case "RESET_OWN_DEV_SKILL_TREE": {
        requireHello(state.playerId);
        if (!(await authorizeDeveloperMessage(
          "developer:economy-mutate",
          "skill-tree.reset",
          message.requestId,
          state.playerId,
          message.requestId
        ))) return;
        try {
          if (!skills || !equipment) throw new Error("Skill services are unavailable");
          enforcePlayerClassRate("dev-skill-tree", 6, 10_000);
          const result = await skills.resetOwnDevelopmentSkillTree(
            state.playerId,
            message.requestId,
            message.expectedRevision,
            {
              inCombat: combat?.isInCombat(state.playerId) ?? false,
              deadOrDowned: combat ? !combat.isPlayerAlive(state.playerId) : false,
              hasUnresolvedAction: (combat?.hasQueuedAbility(state.playerId) ?? false) ||
                (worldRuntime?.hasPendingCommand(state.playerId) ?? false),
              locationRestricted: worldRuntime?.hasPlayerWorldTransition(state.playerId) ?? false,
              equipmentMutationPending: Boolean(equipment.pendingActivation(state.playerId))
            }
          );
          if (!result.replayed) combat?.resetPlayerSkillV3Runtime(state.playerId);
          const currentEquipment = await equipment.getSnapshot(state.playerId);
          await applyLiveSkillMutationState(
            state.playerId,
            result.snapshot,
            currentEquipment,
            { preserveHealthPercentage: true }
          );
          registry.send(state.playerId, {
            type: "SKILL_MUTATION_CONFIRMED",
            requestId: message.requestId,
            action: "dev_reset",
            replayed: result.replayed,
            snapshot: result.snapshot
          });
          await recordDeveloperMessageResult(
            "developer:economy-mutate",
            "skill-tree.reset",
            "succeeded",
            state.playerId,
            message.requestId
          );
        } catch (error) {
          await recordDeveloperMessageResult(
            "developer:economy-mutate",
            "skill-tree.reset",
            "failed",
            state.playerId,
            message.requestId
          );
          const skillError = error instanceof SkillRequestError ? error : null;
          sendCombatError(
            socket,
            message.requestId,
            skillError?.code ?? "DEV_SKILL_TREE_RESET_REJECTED",
            skillError?.message ?? "Development Skill Tree reset was rejected"
          );
        }
        return;
      }
      case "RESET_OWN_DEV_CLASS_COOLDOWNS": {
        requireHello(state.playerId);
        if (!(await authorizeDeveloperMessage(
          "developer:economy-mutate",
          "class-cooldowns.reset",
          message.requestId,
          state.playerId,
          message.requestId
        ))) return;
        try {
          enforcePlayerClassRate("dev-class-cooldowns", 6, 10_000);
          if (!combat?.resetPlayerClassAbilityCooldowns(state.playerId)) {
            throw new ClassRequestError(
              "DEV_CLASS_COOLDOWN_RESET_UNAVAILABLE",
              "Player class cooldowns are unavailable"
            );
          }
          sendCombatScopeSnapshot(state.playerId);
          safeSendServerMessage(socket, {
            type: "DEV_CLASS_COOLDOWNS_RESET",
            requestId: message.requestId,
            serverTime: Date.now()
          });
          await recordDeveloperMessageResult(
            "developer:economy-mutate",
            "class-cooldowns.reset",
            "succeeded",
            state.playerId,
            message.requestId
          );
        } catch (error) {
          await recordDeveloperMessageResult(
            "developer:economy-mutate",
            "class-cooldowns.reset",
            "failed",
            state.playerId,
            message.requestId
          );
          const classError = error instanceof ClassRequestError ? error : null;
          sendCombatError(
            socket,
            message.requestId,
            classError?.code ?? "DEV_CLASS_COOLDOWN_RESET_UNAVAILABLE",
            classError?.message ?? "Player class cooldowns are unavailable"
          );
        }
        return;
      }
      case "GRANT_OWN_DEV_ASSETS": {
        requireHello(state.playerId);
        const capability = developmentAssetGrantCapability(message);
        if (!(await authorizeDeveloperMessage(
          capability,
          "assets.grant",
          message.requestId,
          state.playerId,
          message.requestId
        ))) return;
        try {
          if (!developmentEconomy) throw new Error("Development economy service is unavailable");
          enforcePlayerClassRate("dev-economy", 12, 10_000);
          const result = await developmentEconomy.grant(state.playerId, authenticatedSession!.account.id, message.requestId, {
            ...(message.gold === undefined ? {} : { gold: BigInt(message.gold) }),
            ...(message.cityCoins === undefined
              ? {}
              : { cityCoins: BigInt(message.cityCoins) }),
            ...(message.glimmer === undefined ? {} : { premium: { glimmer: BigInt(message.glimmer) } }),
            ...(message.lumen === undefined ? {} : { lumen: BigInt(message.lumen) }),
            ...(message.materials === undefined ? {} : { materials: message.materials.map((material) => ({ itemId: material.itemId, quantity: BigInt(material.quantity) })) })
          });
          safeSendServerMessage(socket, {
            type: "DEV_ASSETS_GRANTED",
            requestId: message.requestId,
            replayed: result.replayed,
            walletGold: result.walletGold.toString(),
            walletVersion: result.walletVersion.toString(),
            ...(result.premiumWallet ? { premiumWallet: result.premiumWallet } : {}),
            inventory: result.inventory,
            cityCoins: result.cityCoins,
            grants: result.grants.map((grant) => ({
              itemId: grant.itemId,
              requestedQuantity: grant.requestedQuantity,
              grantedQuantity: grant.grantedQuantity,
              remainderQuantity: grant.remainderQuantity
            }))
          });
          await recordDeveloperMessageResult(
            capability,
            "assets.grant",
            "succeeded",
            state.playerId,
            message.requestId
          );
        } catch (error) {
          await recordDeveloperMessageResult(
            capability,
            "assets.grant",
            "failed",
            state.playerId,
            message.requestId
          );
          safeSendServerMessage(socket, {
            type: "ERROR",
            requestId: message.requestId,
            code: error instanceof DevelopmentEconomyError
              ? error.code
              : "DEV_ASSET_GRANT_REJECTED",
            message: error instanceof Error
              ? error.message
              : "Development grant rejected"
          });
        }
        return;
      }
      case "ADJUST_OWN_DEV_PROGRESSION": {
        requireHello(state.playerId);
        if (!(await authorizeDeveloperMessage(
          "developer:economy-mutate",
          "progression.adjust",
          message.operationId,
          state.playerId,
          message.operationId
        ))) return;
        let mutationToken: symbol | null = null;
        try {
          if (!classes || !equipment || !progression) throw new Error("Progression services are unavailable");
          if (worldRuntime?.hasPlayerWorldTransition(state.playerId)) {
            throw new ClassRequestError("PLAYER_WORLD_TRANSITION_PENDING", "A player world transition is pending");
          }
          if (equipment.pendingActivation(state.playerId)) {
            throw new ClassRequestError(
              "EQUIPMENT_ACTIVATION_PENDING",
              "Class progression cannot change while a combat-kit activation is pending"
            );
          }
          mutationToken = classRealtimeState.beginMutation(state.playerId);
          enforcePlayerClassRate("dev-progression", 12, 10_000);
          const result = await classes.adjustOwnDevelopmentProgression(
            state.playerId,
            message.progressionType,
            message.targetRank,
            message.operationId,
            {
              restricted: (combat?.isInCombat(state.playerId) ?? false) ||
                (combat?.hasQueuedAbility(state.playerId) ?? false) ||
                (worldRuntime?.hasPendingCommand(state.playerId) ?? false)
            }
          );
          const durableProgression = await progression.getOrCreate(state.playerId);
          const loadout = equipment.runtimeSnapshot(state.playerId)
            ? equipment.setRuntimeContext(
                state.playerId,
                equipmentRuntimeContextFor(durableProgression, result.snapshot)
              )
            : await equipment.getSnapshot(
                state.playerId,
                equipmentRuntimeContextFor(durableProgression, result.snapshot)
              );
          const baseProgression = withEquipmentStats(durableProgression, loadout);
          const canonicalProgression = {
            ...baseProgression,
            pveStats: applyClassCombatStats(baseProgression.pveStats, result.snapshot, loadout)
          };
          combat?.updatePlayerPveStats(state.playerId, {
            level: canonicalProgression.level,
            maxHealth: canonicalProgression.pveStats.maxHealth,
            attackPower: canonicalProgression.pveStats.attackPower,
            defense: canonicalProgression.pveStats.defense
          });
          combat?.updatePlayerClassState(state.playerId, result.snapshot, loadout);
          combat?.syncPlayerEquipmentCombatState(
            state.playerId,
            playerEquipmentCombatStateFromSnapshot(loadout)
          );
          registry.send(state.playerId, {
            type: "DEV_PROGRESSION_ADJUSTED",
            operationId: message.operationId,
            replayed: result.replayed,
            classSnapshot: result.snapshot,
            progression: canonicalProgression,
            ...(result.masteries ? { masteries: result.masteries } : {})
          });
          registry.send(state.playerId, {
            type: "EQUIPMENT_SNAPSHOT",
            equipment: loadout
          });
          await recordDeveloperMessageResult(
            "developer:economy-mutate",
            "progression.adjust",
            "succeeded",
            state.playerId,
            message.operationId
          );
        } catch (error) {
          await recordDeveloperMessageResult(
            "developer:economy-mutate",
            "progression.adjust",
            "failed",
            state.playerId,
            message.operationId
          );
          sendDevProgressionError(socket, message.operationId, error);
        } finally {
          if (mutationToken) classRealtimeState.endMutation(state.playerId, mutationToken);
        }
        return;
      }
      case "SET_OWN_DEV_SUBCLASS_UNLOCK": {
        requireHello(state.playerId);
        if (!(await authorizeDeveloperMessage(
          "developer:economy-mutate",
          "subclass.unlock",
          message.operationId,
          state.playerId,
          message.operationId
        ))) return;
        let mutationToken: symbol | null = null;
        try {
          if (!classes || !equipment) throw new Error("Class service is unavailable");
          if (worldRuntime?.hasPlayerWorldTransition(state.playerId)) {
            throw new ClassRequestError("PLAYER_WORLD_TRANSITION_PENDING", "A player world transition is pending");
          }
          if (equipment.pendingActivation(state.playerId)) {
            throw new ClassRequestError(
              "EQUIPMENT_ACTIVATION_PENDING",
              "Subclass unlocks cannot change while a combat-kit activation is pending"
            );
          }
          mutationToken = classRealtimeState.beginMutation(state.playerId);
          enforcePlayerClassRate("dev-subclass", 8, 10_000);
          const result = await classes.setOwnDevelopmentSubclassUnlock(
            state.playerId,
            message.subclassId,
            message.unlocked,
            message.operationId,
            {
              restricted: (combat?.isInCombat(state.playerId) ?? false) ||
                (combat?.hasQueuedAbility(state.playerId) ?? false) ||
                (worldRuntime?.hasPendingCommand(state.playerId) ?? false)
            }
          );
          combat?.updatePlayerClassState(
            state.playerId,
            result.snapshot,
            await equipment.getSnapshot(state.playerId)
          );
          registry.send(state.playerId, {
            type: "CLASS_MUTATION_CONFIRMED",
            requestId: message.operationId,
            replayed: result.replayed,
            snapshot: result.snapshot
          });
          await recordDeveloperMessageResult(
            "developer:economy-mutate",
            "subclass.unlock",
            "succeeded",
            state.playerId,
            message.operationId
          );
        } catch (error) {
          await recordDeveloperMessageResult(
            "developer:economy-mutate",
            "subclass.unlock",
            "failed",
            state.playerId,
            message.operationId
          );
          sendDevSubclassError(socket, message.operationId, error);
        } finally {
          if (mutationToken) classRealtimeState.endMutation(state.playerId, mutationToken);
        }
        return;
      }
      case "DEV_SPAWN_DUNGEON_ENTRANCE": {
        requireHello(state.playerId);
        const developerPlayerId = state.playerId;
        if (!developerPlayerId) return;
        if (!(await authorizeDeveloperMessage(
          "developer:world-mutate",
          "dungeon-entrance.spawn",
          message.requestId,
          message.templateId,
          message.requestId
        ))) return;
        if (!developerSpawnedDungeons) {
          sendCombatError(socket, message.requestId, "DUNGEON_ENTRANCE_UNAVAILABLE", "Dungeon entrance service is unavailable");
          return;
        }
        const target = validateMoveTarget(message.lat, message.lon);
        try {
          let regionCode = packageIdForPosition(target);
          if (worldLookup) {
            const world = await worldLookup.lookupGameplayEnvironment(target.lat, target.lon);
            if (!world.ok || !world.packageId) {
              throw new DeveloperSpawnedDungeonError(
                "WORLD_UNAVAILABLE",
                "The target is outside authoritative world coverage"
              );
            }
            regionCode = world.packageId;
          }
          const result = await playerAuthorityFence.run(developerPlayerId, async () => {
            if (registry.activeConnectionIdForPlayer(developerPlayerId) !== state.connectionId ||
                !gameState.getPlayer(developerPlayerId)) return null;
            const spawned = await developerSpawnedDungeons.spawn({
              creatorPlayerId: developerPlayerId,
              requestId: message.requestId,
              templateId: message.templateId,
              regionCode,
              position: target
            });
            const entrance = developerSpawnedDungeons.snapshotFor(spawned.entrance);
            registry.broadcast({ type: "DUNGEON_ENTRANCE_UPSERTED", entrance });
            safeSendServerMessage(socket, {
              type: "DEV_DUNGEON_ENTRANCE_SPAWNED",
              requestId: message.requestId,
              replayed: spawned.replayed,
              entrance
            });
            return spawned;
          });
          if (!result) return;
          await recordDeveloperMessageResult(
            "developer:world-mutate",
            "dungeon-entrance.spawn",
            "succeeded",
            message.templateId,
            message.requestId
          );
        } catch (error) {
          await recordDeveloperMessageResult(
            "developer:world-mutate",
            "dungeon-entrance.spawn",
            "failed",
            message.templateId,
            message.requestId
          );
          sendCombatError(
            socket,
            message.requestId,
            error instanceof DeveloperSpawnedDungeonError ? error.code : "DUNGEON_ENTRANCE_SPAWN_FAILED",
            error instanceof Error ? error.message : "Dungeon entrance could not be spawned"
          );
        }
        return;
      }
      case "DEV_LIST_DUNGEON_ENTRANCES": {
        requireHello(state.playerId);
        if (!(await authorizeDeveloperMessage(
          "developer:observe",
          "dungeon-entrance.list",
          message.requestId,
          null,
          message.requestId
        ))) return;
        if (!developerSpawnedDungeons) {
          sendCombatError(socket, message.requestId, "DUNGEON_ENTRANCE_UNAVAILABLE", "Dungeon entrance service is unavailable");
          return;
        }
        try {
          const entrances = (await developerSpawnedDungeons.listActive()).map((placement) =>
            developerSpawnedDungeons.snapshotFor(placement)
          );
          safeSendServerMessage(socket, {
            type: "DEV_DUNGEON_ENTRANCES_SNAPSHOT",
            requestId: message.requestId,
            entrances
          });
          await recordDeveloperMessageResult(
            "developer:observe",
            "dungeon-entrance.list",
            "succeeded",
            null,
            message.requestId
          );
        } catch (error) {
          await recordDeveloperMessageResult(
            "developer:observe",
            "dungeon-entrance.list",
            "failed",
            null,
            message.requestId
          );
          sendCombatError(
            socket,
            message.requestId,
            "DUNGEON_ENTRANCE_LIST_FAILED",
            error instanceof Error ? error.message : "Dungeon entrances could not be listed"
          );
        }
        return;
      }
      case "DEV_RESET_DUNGEON_RUN": {
        requireHello(state.playerId);
        const developerPlayerId = state.playerId;
        if (!developerPlayerId) return;
        if (!(await authorizeDeveloperMessage(
          "developer:world-mutate",
          "dungeon-run.reset",
          message.requestId,
          null,
          message.requestId
        ))) return;
        if (!dungeon) {
          sendCombatError(socket, message.requestId, "DUNGEON_UNAVAILABLE", "Dungeons are unavailable");
          return;
        }
        try {
          const snapshot = await dungeon.resetDeveloperRun(developerPlayerId);
          safeSendServerMessage(socket, { type: "DUNGEON_SNAPSHOT", requestId: message.requestId, snapshot });
          await recordDeveloperMessageResult("developer:world-mutate", "dungeon-run.reset", "succeeded", null, message.requestId);
        } catch (error) {
          await recordDeveloperMessageResult("developer:world-mutate", "dungeon-run.reset", "failed", null, message.requestId);
          sendCombatError(
            socket,
            message.requestId,
            error instanceof DungeonError ? error.code : "DEV_DUNGEON_RESET_FAILED",
            error instanceof Error ? error.message : "The dungeon run could not be reset"
          );
        }
        return;
      }
      case "DEV_DELETE_DUNGEON_ENTRANCE": {
        requireHello(state.playerId);
        if (!(await authorizeDeveloperMessage(
          "developer:world-mutate",
          "dungeon-entrance.delete",
          message.requestId,
          message.entranceId,
          message.requestId
        ))) return;
        if (!developerSpawnedDungeons) {
          sendCombatError(socket, message.requestId, "DUNGEON_ENTRANCE_UNAVAILABLE", "Dungeon entrance service is unavailable");
          return;
        }
        try {
          const result = await developerSpawnedDungeons.delete(
            state.playerId,
            message.requestId,
            message.entranceId
          );
          registry.broadcast({
            type: "DUNGEON_ENTRANCE_REMOVED",
            entranceId: result.entrance.entranceId
          });
          safeSendServerMessage(socket, {
            type: "DEV_DUNGEON_ENTRANCE_DELETED",
            requestId: message.requestId,
            replayed: result.replayed,
            entranceId: result.entrance.entranceId
          });
          await recordDeveloperMessageResult(
            "developer:world-mutate",
            "dungeon-entrance.delete",
            "succeeded",
            message.entranceId,
            message.requestId
          );
        } catch (error) {
          await recordDeveloperMessageResult(
            "developer:world-mutate",
            "dungeon-entrance.delete",
            "failed",
            message.entranceId,
            message.requestId
          );
          sendCombatError(
            socket,
            message.requestId,
            error instanceof DeveloperSpawnedDungeonError ? error.code : "DUNGEON_ENTRANCE_DELETE_FAILED",
            error instanceof Error ? error.message : "Dungeon entrance could not be deleted"
          );
        }
        return;
      }
      case "DEV_SPAWN_GOBLIN_VILLAGE": {
        requireHello(state.playerId);
        if (!(await authorizeDeveloperMessage(
          "developer:world-mutate",
          "goblin-village.spawn",
          message.requestId,
          `${message.lat},${message.lon}`,
          message.requestId
        ))) return;
        const player = gameState.getPlayer(state.playerId);
        if (!player || !goblinVillage) {
          sendCombatError(socket, message.requestId, "GOBLIN_VILLAGE_UNAVAILABLE", "Goblin Village service is unavailable");
          return;
        }
        try {
          const result = await goblinVillage.spawn(
            player,
            message.requestId,
            { lat: message.lat, lon: message.lon }
          );
          safeSendServerMessage(socket, {
            type: "DEV_GOBLIN_VILLAGE_SPAWNED",
            requestId: message.requestId,
            ...result
          });
          for (const flag of result.flags) {
            safeSendServerMessage(socket, { type: "FLAG_UPDATED", flag });
          }
          const combatSnapshotPlayerIds = new Set([state.playerId]);
          for (const position of [...result.flags, result.market]) {
            for (const playerId of gameState.playerIdsWhoseGameplayViewCircleContains(position)) {
              combatSnapshotPlayerIds.add(playerId);
            }
          }
          for (const playerId of combatSnapshotPlayerIds) {
            sendCombatScopeSnapshot(playerId);
          }
          if (cities) {
            safeSendServerMessage(socket, {
              type: "CITIES_SNAPSHOT",
              cities: await cities.listCitiesNear(player.anchor)
            });
            if (cities.structures) {
              safeSendServerMessage(socket, {
                type: "CITY_STRUCTURES_SNAPSHOT",
                structures: await cities.structures.listNear(
                  player.position,
                  CITY_STRUCTURE_SNAPSHOT_RADIUS_M
                )
              });
            }
          }
          await recordDeveloperMessageResult(
            "developer:world-mutate",
            "goblin-village.spawn",
            "succeeded",
            result.city.id,
            message.requestId
          );
        } catch (error) {
          await recordDeveloperMessageResult(
            "developer:world-mutate",
            "goblin-village.spawn",
            "failed",
            `${message.lat},${message.lon}`,
            message.requestId
          );
          sendCombatError(
            socket,
            message.requestId,
            error instanceof GoblinVillageError ? error.code : "GOBLIN_VILLAGE_SPAWN_FAILED",
            error instanceof Error ? error.message : "Goblin Village could not be spawned"
          );
        }
        return;
      }
      case "DEV_COLLAPSE_TERRITORY": {
        requireHello(state.playerId);
        const command = `${message.kind}.collapse`;
        const target = message.targetId ?? `own-${message.kind}`;
        if (!(await authorizeDeveloperMessage(
          "developer:world-mutate",
          command,
          message.requestId,
          target,
          message.requestId
        ))) return;
        try {
          if (!territoryCollapse) throw new Error("Territory collapse is unavailable");
          let targetId = message.targetId ?? null;
          if (!targetId) {
            const own = await flagService.databasePool.query<{ id: string }>(
              message.kind === "city"
                ? `SELECT city_id::text AS id FROM city_memberships
                   WHERE player_id = $1 AND left_at IS NULL LIMIT 1`
                : `SELECT kingdom_id::text AS id FROM kingdom_memberships
                   WHERE player_id = $1 AND status = 'active' LIMIT 1`,
              [state.playerId]
            );
            targetId = own.rows[0]?.id ?? null;
          }
          if (!targetId) throw new Error(`You are not in an active ${message.kind}`);
          const collapse = await territoryCollapse.begin({
            kind: message.kind,
            id: targetId,
            reason: "developer_collapse",
            actorPlayerId: state.playerId
          });
          if (!collapse) throw new Error(`That ${message.kind} has already ended`);
          safeSendServerMessage(socket, {
            type: "DEV_TERRITORY_COLLAPSE_RESULT",
            requestId: message.requestId,
            kind: message.kind,
            targetId,
            name: collapse.displayName,
            collapseId: collapse.collapseId,
            flagCount: collapse.flagCount
          });
          await recordDeveloperMessageResult(
            "developer:world-mutate", command, "succeeded", targetId, message.requestId
          );
        } catch (error) {
          await recordDeveloperMessageResult(
            "developer:world-mutate", command, "failed", target, message.requestId
          );
          sendCombatError(
            socket,
            message.requestId,
            "TERRITORY_COLLAPSE_FAILED",
            error instanceof Error ? error.message : "Territory collapse could not start"
          );
        }
        return;
      }
      case "DEV_FOUND_CAPITAL": {
        requireHello(state.playerId);
        const command = message.dryRun ? "capital.found.plan" : "capital.found";
        if (!(await authorizeDeveloperMessage(
          "developer:world-mutate",
          command,
          message.requestId,
          message.leaveCurrentCity ? "albuquerque:leave-current-city" : "albuquerque",
          message.requestId
        ))) return;
        const player = gameState.getPlayer(state.playerId);
        if (!player || !cities) {
          sendCombatError(socket, message.requestId, "CAPITAL_FOUNDING_UNAVAILABLE", "City service is unavailable");
          return;
        }
        try {
          const result = await cities.foundDeveloperCapital(player, {
            requestId: message.requestId,
            dryRun: message.dryRun,
            leaveCurrentCity: message.leaveCurrentCity
          });
          safeSendServerMessage(socket, {
            type: "DEV_CAPITAL_FOUNDING_RESULT",
            requestId: message.requestId,
            dryRun: result.dryRun,
            replayed: result.replayed,
            plan: result.plan,
            city: result.city
          });
          if (!result.dryRun && result.city) {
            const territoryFlags = (await Promise.all(
              result.territoryFlagIds.map((flagId) => flagService.getMapFlag(flagId))
            )).filter((flag) => flag !== null);
            if (result.leftHouse) {
              registry.broadcast({
                type: "CITY_HOUSE_CHANGED",
                requestId: message.requestId,
                structure: result.leftHouse.structure,
                membership: null,
                replayed: false,
                ...(result.leftHouse.inventory ? { inventory: result.leftHouse.inventory } : {}),
                ...(result.leftHouse.droppedItems ? { droppedItems: result.leftHouse.droppedItems } : {})
              });
              for (const structure of result.leftHouse.destroyedStructures ?? []) {
                registry.broadcast({ type: "CITY_FACILITY_CHANGED", requestId: message.requestId, structure });
              }
              cities.districtBenefits.clearRuntime(state.playerId);
            }
            for (const structure of result.structures) {
              if (structure.type === "mayor_house" || structure.type === "city_house") {
                registry.broadcast({
                  type: "CITY_HOUSE_CHANGED",
                  requestId: message.requestId,
                  structure,
                  membership: result.membership,
                  replayed: result.replayed
                });
              } else {
                registry.broadcast({ type: "CITY_FACILITY_CHANGED", requestId: message.requestId, structure });
              }
            }
            await Promise.all(registry.records().map(async (record) => {
              const viewer = gameState.getPlayer(record.playerId);
              if (!viewer) return;
              registry.sendToConnection(record.connectionId, {
                type: "CITIES_SNAPSHOT",
                cities: await cities.listCitiesNear(viewer.anchor)
              });
            }));
            registry.broadcast({
              type: "CITY_TERRITORY_SYNC",
              cityId: result.city.id,
              flags: territoryFlags
            });
            if (!result.replayed) {
              const revisionMetadata = await flagSetRevisionMetadata(flagService);
              for (const flag of territoryFlags) {
                registry.broadcast({ type: "FLAG_UPDATED", flag, ...revisionMetadata });
              }
              for (const annexed of result.plan.annexedFlags) {
                if (annexed.previousOwnerPlayerId === state.playerId) continue;
                registry.send(annexed.previousOwnerPlayerId, {
                  type: "FLAG_ACCESS_CHANGED",
                  flagId: annexed.flagId,
                  message: `${result.city.name} annexed this flag into the capital.`,
                  ...revisionMetadata
                });
                registry.broadcast({ type: "SOCIAL_STATE_CHANGED", playerId: annexed.previousOwnerPlayerId });
              }
            }
            registry.send(state.playerId, {
              type: "CITY_MEMBERSHIP_SNAPSHOT",
              membership: await cities.getMembership(state.playerId)
            });
            await chats?.refreshAuthorizedPlayer(state.playerId);
            worldMap?.invalidateFeaturedCities();
            if (worldMap) {
              registry.send(state.playerId, {
                type: "WORLD_MAP_DESTINATIONS",
                snapshot: await worldMap.snapshot(state.playerId)
              });
            }
            registry.broadcast({ type: "SOCIAL_STATE_CHANGED", playerId: state.playerId });
          }
          await recordDeveloperMessageResult(
            "developer:world-mutate",
            command,
            "succeeded",
            result.city?.id ?? "albuquerque",
            message.requestId
          );
        } catch (error) {
          await recordDeveloperMessageResult(
            "developer:world-mutate",
            command,
            "failed",
            "albuquerque",
            message.requestId
          );
          logger.warn?.({ err: error, requestId: message.requestId }, "developer capital founding failed");
          sendCombatError(
            socket,
            message.requestId,
            error instanceof CityFoundingError || error instanceof CityStructureError
              ? error.code
              : "CAPITAL_FOUNDING_FAILED",
            error instanceof Error ? error.message : "The capital could not be founded"
          );
        }
        return;
      }
      case "DEV_LIST_GOBLIN_VILLAGES": {
        requireHello(state.playerId);
        if (!(await authorizeDeveloperMessage(
          "developer:observe",
          "goblin-village.list",
          message.requestId,
          null,
          message.requestId
        ))) return;
        if (!goblinVillage) {
          sendCombatError(socket, message.requestId, "GOBLIN_VILLAGE_UNAVAILABLE", "Goblin Village service is unavailable");
          return;
        }
        try {
          safeSendServerMessage(socket, {
            type: "DEV_GOBLIN_VILLAGES_SNAPSHOT",
            villages: await goblinVillage.listActiveVillages()
          });
          await recordDeveloperMessageResult(
            "developer:observe",
            "goblin-village.list",
            "succeeded",
            null,
            message.requestId
          );
        } catch (error) {
          await recordDeveloperMessageResult(
            "developer:observe",
            "goblin-village.list",
            "failed",
            null,
            message.requestId
          );
          sendCombatError(
            socket,
            message.requestId,
            "GOBLIN_VILLAGE_LIST_FAILED",
            error instanceof Error ? error.message : "Goblin Villages could not be listed"
          );
        }
        return;
      }
      case "DEV_DELETE_GOBLIN_VILLAGE": {
        requireHello(state.playerId);
        if (!(await authorizeDeveloperMessage(
          "developer:world-mutate",
          "goblin-village.delete",
          message.requestId,
          message.cityId,
          message.requestId
        ))) return;
        if (!goblinVillage) {
          sendCombatError(socket, message.requestId, "GOBLIN_VILLAGE_UNAVAILABLE", "Goblin Village service is unavailable");
          return;
        }
        try {
          const result = await goblinVillage.deleteVillage(
            state.playerId,
            message.requestId,
            message.cityId
          );
          for (const flagId of result.removedFlagIds) {
            registry.broadcast({ type: "FLAG_DELETED", flagId, reason: "deleted" });
          }
          registry.broadcast({
            type: "GOBLIN_VILLAGE_REMOVED",
            cityId: result.city.cityId,
            structureIds: result.structureIds
          });
          safeSendServerMessage(socket, {
            type: "DEV_GOBLIN_VILLAGE_DELETED",
            requestId: message.requestId,
            result
          });
          await recordDeveloperMessageResult(
            "developer:world-mutate",
            "goblin-village.delete",
            "succeeded",
            result.city.cityId,
            message.requestId
          );
        } catch (error) {
          await recordDeveloperMessageResult(
            "developer:world-mutate",
            "goblin-village.delete",
            "failed",
            message.cityId,
            message.requestId
          );
          sendCombatError(
            socket,
            message.requestId,
            error instanceof GoblinVillageError ? error.code : "GOBLIN_VILLAGE_DELETE_FAILED",
            error instanceof Error ? error.message : "Goblin Village could not be deleted"
          );
        }
        return;
      }
      case "DEV_SPAWN_MOB": {
        requireHello(state.playerId);
        const developerPlayerId = state.playerId;
        const developerConnectionId = state.connectionId;
        if (!(await authorizeDeveloperMessage(
          "developer:world-mutate",
          "mob.spawn",
          message.requestId,
          message.archetype,
          message.requestId
        ))) return;
        if (rejectDuringPlayerWorldTransition(message.requestId)) return;
        if (!combat || !config) {
          sendCombatError(socket, message.requestId, "COMBAT_UNAVAILABLE", "Combat is unavailable");
          return;
        }
        const player = gameState.getPlayer(state.playerId);
        if (!player) {
          sendCombatError(socket, message.requestId, "PLAYER_NOT_CONNECTED", "Player is not connected");
          return;
        }
        try {
          validateMoveTarget(message.lat, message.lon);
        } catch {
          sendCombatError(socket, message.requestId, "DEV_MOB_SPAWN_INVALID", "Mob coordinate is invalid");
          return;
        }
        if (
          distanceMeters(player.position, { lat: message.lat, lon: message.lon }) >
          config.DEV_MOB_MAX_SPAWN_DISTANCE_M
        ) {
          sendCombatError(
            socket,
            message.requestId,
            "DEV_MOB_SPAWN_TOO_FAR",
            `Mob spawn must be within ${config.DEV_MOB_MAX_SPAWN_DISTANCE_M}m`
          );
          return;
        }
        if (message.archetype === "xoral") {
          if (!xoralEvents) throw new Error("Xoral events are unavailable");
          await xoralEvents.spawnDeveloperDormant({
            playerId: state.playerId,
            position: { lat: message.lat, lon: message.lon },
            regionCode: player.regionCode,
            combatZoneId: combat.entity(state.playerId)?.zoneId ?? `world:${player.regionCode}`,
            ...(message.appearanceVariant ? { appearanceVariant: message.appearanceVariant } : {})
          });
        } else if (message.archetype === "hollin_hut") {
          if (!hollinHuts) {
            sendCombatError(socket, message.requestId, "COMBAT_UNAVAILABLE", "Hollin Huts are unavailable");
            return;
          }
          try {
            const hut = await playerAuthorityFence.run(developerPlayerId, async () => {
              if (
                state.playerId !== developerPlayerId ||
                state.connectionId !== developerConnectionId ||
                registry.activeConnectionIdForPlayer(developerPlayerId) !== developerConnectionId
              ) return null;
              const currentPlayer = gameState.getPlayer(developerPlayerId);
              if (!currentPlayer) throw new Error("Player is not connected");
              return hollinHuts.spawnHut({
                creatorPlayerId: developerPlayerId,
                requestId: message.requestId,
                position: { lat: message.lat, lon: message.lon },
                regionCode: currentPlayer.regionCode,
                zoneId: zoneIdForPosition(currentPlayer.position)
              });
            });
            if (!hut) return;
            safeSendServerMessage(socket, {
              type: "DEV_MOB_SPAWNED",
              requestId: message.requestId,
              mobEntityId: hut.hutId,
              archetype: "hollin_hut",
              appearanceVariant: "normal"
            });
          } catch (error) {
            sendCombatError(
              socket, message.requestId, "DEV_MOB_SPAWN_FAILED",
              error instanceof Error ? error.message : "Hollin Hut could not be spawned"
            );
            return;
          }
        } else {
          if (!developerSpawnedMobs) {
            sendCombatError(socket, message.requestId, "COMBAT_UNAVAILABLE", "Combat is unavailable");
            return;
          }
          try {
            const spawned = await playerAuthorityFence.run(developerPlayerId, async () => {
              if (
                state.playerId !== developerPlayerId ||
                state.connectionId !== developerConnectionId ||
                registry.activeConnectionIdForPlayer(developerPlayerId) !== developerConnectionId
              ) return false;
              if (rejectDuringPlayerWorldTransition(message.requestId)) return false;
              const currentPlayer = gameState.getPlayer(developerPlayerId);
              if (!currentPlayer) {
                throw new Error("Player is not connected");
              }
              if (
                distanceMeters(currentPlayer.position, { lat: message.lat, lon: message.lon }) >
                config.DEV_MOB_MAX_SPAWN_DISTANCE_M
              ) {
                throw new Error(
                  `Mob spawn must be within ${config.DEV_MOB_MAX_SPAWN_DISTANCE_M}m`
                );
              }
              const mob = await developerSpawnedMobs.spawn({
                creatorPlayerId: developerPlayerId,
                requestId: message.requestId,
                archetype: message.archetype,
                ...(message.appearanceVariant
                  ? { appearanceVariant: message.appearanceVariant }
                  : {}),
                position: { lat: message.lat, lon: message.lon },
                regionCode: currentPlayer.regionCode,
                zoneId: zoneIdForPosition(currentPlayer.position),
                originFlagId: gameState.currentFlagId(developerPlayerId)
              });
              safeSendServerMessage(socket, {
                type: "DEV_MOB_SPAWNED",
                requestId: message.requestId,
                mobEntityId: mob.entityId,
                archetype: mob.archetype,
                appearanceVariant: mob.appearanceVariant
              });
              return true;
            });
            if (!spawned) return;
          } catch (error) {
            await recordDeveloperMessageResult(
              "developer:world-mutate",
              "mob.spawn",
              "failed",
              message.archetype,
              message.requestId
            );
            sendCombatError(
              socket,
              message.requestId,
              "DEV_MOB_SPAWN_FAILED",
              error instanceof Error ? error.message : "Developer mob could not be spawned"
            );
            return;
          }
        }
        await recordDeveloperMessageResult(
          "developer:world-mutate",
          "mob.spawn",
          "succeeded",
          message.archetype,
          message.requestId
        );
        return;
      }
      case "DEV_SPAWN_TEST_FLAG": {
        requireHello(state.playerId);
        const developerPlayerId = state.playerId;
        const developerConnectionId = state.connectionId;
        if (!(await authorizeDeveloperMessage(
          "developer:world-mutate",
          "military-test.flag.spawn",
          message.requestId,
          message.targetKind,
          message.requestId
        ))) return;
        if (!config) {
          sendCombatError(socket, message.requestId, "WORLD_UNAVAILABLE", "World configuration is unavailable");
          return;
        }
        const player = gameState.getPlayer(developerPlayerId);
        if (!player) {
          sendCombatError(socket, message.requestId, "PLAYER_NOT_CONNECTED", "Player is not connected");
          return;
        }
        try {
          validateMoveTarget(message.lat, message.lon);
        } catch {
          sendCombatError(socket, message.requestId, "DEV_TEST_FLAG_SPAWN_INVALID", "Test flag coordinate is invalid");
          return;
        }
        if (
          distanceMeters(player.position, { lat: message.lat, lon: message.lon }) >
          config.DEV_MOB_MAX_SPAWN_DISTANCE_M
        ) {
          sendCombatError(
            socket,
            message.requestId,
            "DEV_TEST_FLAG_SPAWN_TOO_FAR",
            `Test flag spawn must be within ${config.DEV_MOB_MAX_SPAWN_DISTANCE_M}m`
          );
          return;
        }
        try {
          const spawned = await playerAuthorityFence.run(developerPlayerId, async () => {
            if (
              state.playerId !== developerPlayerId ||
              state.connectionId !== developerConnectionId ||
              registry.activeConnectionIdForPlayer(developerPlayerId) !== developerConnectionId
            ) return null;
            if (rejectDuringPlayerWorldTransition(message.requestId)) return null;
            const currentPlayer = gameState.getPlayer(developerPlayerId);
            if (!currentPlayer) throw new Error("Player is not connected");
            const position = { lat: message.lat, lon: message.lon };
            if (distanceMeters(currentPlayer.position, position) > config.DEV_MOB_MAX_SPAWN_DISTANCE_M) {
              throw new Error(`Test flag spawn must be within ${config.DEV_MOB_MAX_SPAWN_DISTANCE_M}m`);
            }
            const result = await flagService.createDeveloperTestFlag({
              creatorPlayerId: developerPlayerId,
              requestId: message.requestId,
              targetKind: message.targetKind,
              position
            });
            safeSendServerMessage(socket, { type: "FLAG_UPDATED", flag: result.flag });
            const combatSnapshotPlayerIds = new Set([developerPlayerId]);
            for (const playerId of gameState.playerIdsWhoseGameplayViewCircleContains(result.flag)) {
              combatSnapshotPlayerIds.add(playerId);
            }
            for (const playerId of combatSnapshotPlayerIds) {
              sendCombatScopeSnapshot(playerId);
            }
            safeSendServerMessage(socket, {
              type: "DEV_TEST_FLAG_SPAWNED",
              requestId: message.requestId,
              replayed: result.replayed,
              targetKind: message.targetKind,
              flag: result.flag
            });
            return true;
          });
          if (spawned === null) return;
        } catch (error) {
          await recordDeveloperMessageResult(
            "developer:world-mutate",
            "military-test.flag.spawn",
            "failed",
            message.targetKind,
            message.requestId
          );
          sendCombatError(
            socket,
            message.requestId,
            "DEV_TEST_FLAG_SPAWN_FAILED",
            error instanceof Error ? error.message : "Developer test flag could not be spawned"
          );
          return;
        }
        await recordDeveloperMessageResult(
          "developer:world-mutate",
          "military-test.flag.spawn",
          "succeeded",
          message.targetKind,
          message.requestId
        );
        return;
      }
      case "DEV_SPAWN_TEST_UNIT": {
        requireHello(state.playerId);
        const developerPlayerId = state.playerId;
        const developerConnectionId = state.connectionId;
        if (!(await authorizeDeveloperMessage(
          "developer:world-mutate",
          "military-test.unit.spawn",
          message.requestId,
          message.unitType,
          message.requestId
        ))) return;
        if (!config || !cities?.militaryIndustry) {
          sendCombatError(socket, message.requestId, "MILITARY_UNAVAILABLE", "Military Industry is unavailable");
          return;
        }
        const player = gameState.getPlayer(developerPlayerId);
        if (!player) {
          sendCombatError(socket, message.requestId, "PLAYER_NOT_CONNECTED", "Player is not connected");
          return;
        }
        try {
          validateMoveTarget(message.lat, message.lon);
        } catch {
          sendCombatError(socket, message.requestId, "DEV_TEST_UNIT_SPAWN_INVALID", "Test unit coordinate is invalid");
          return;
        }
        if (
          distanceMeters(player.position, { lat: message.lat, lon: message.lon }) >
          config.DEV_MOB_MAX_SPAWN_DISTANCE_M
        ) {
          sendCombatError(
            socket,
            message.requestId,
            "DEV_TEST_UNIT_SPAWN_TOO_FAR",
            `Test unit spawn must be within ${config.DEV_MOB_MAX_SPAWN_DISTANCE_M}m`
          );
          return;
        }
        try {
          const spawned = await playerAuthorityFence.run(developerPlayerId, async () => {
            if (
              state.playerId !== developerPlayerId ||
              state.connectionId !== developerConnectionId ||
              registry.activeConnectionIdForPlayer(developerPlayerId) !== developerConnectionId
            ) return null;
            if (rejectDuringPlayerWorldTransition(message.requestId)) return null;
            const currentPlayer = gameState.getPlayer(developerPlayerId);
            if (!currentPlayer) throw new Error("Player is not connected");
            const position = { lat: message.lat, lon: message.lon };
            if (distanceMeters(currentPlayer.position, position) > config.DEV_MOB_MAX_SPAWN_DISTANCE_M) {
              throw new Error(`Test unit spawn must be within ${config.DEV_MOB_MAX_SPAWN_DISTANCE_M}m`);
            }
            const result = await cities.militaryIndustry!.spawnDeveloperUnit(
              { playerId: developerPlayerId, position },
              message.unitType,
              message.requestId
            );
            safeSendServerMessage(socket, {
              type: "MILITARY_INDUSTRY_CHANGED",
              requestId: message.requestId,
              snapshot: result.snapshot,
              replayed: result.replayed
            });
            safeSendServerMessage(socket, {
              type: "DEV_TEST_UNIT_SPAWNED",
              requestId: message.requestId,
              replayed: result.replayed,
              unitType: message.unitType,
              unitId: result.unitId,
              groupId: result.groupId
            });
            return true;
          });
          if (spawned === null) return;
        } catch (error) {
          await recordDeveloperMessageResult(
            "developer:world-mutate",
            "military-test.unit.spawn",
            "failed",
            message.unitType,
            message.requestId
          );
          sendCombatError(
            socket,
            message.requestId,
            "DEV_TEST_UNIT_SPAWN_FAILED",
            error instanceof Error ? error.message : "Developer test unit could not be spawned"
          );
          return;
        }
        await recordDeveloperMessageResult(
          "developer:world-mutate",
          "military-test.unit.spawn",
          "succeeded",
          message.unitType,
          message.requestId
        );
        return;
      }
      case "DEV_CLEAR_MOBS": {
        requireHello(state.playerId);
        const developerPlayerId = state.playerId;
        const developerConnectionId = state.connectionId;
        if (!(await authorizeDeveloperMessage(
          "developer:world-mutate",
          "mobs.clear",
          message.requestId,
          "all",
          message.requestId
        ))) return;
        if (!developerSpawnedMobs || !combat) {
          sendCombatError(socket, message.requestId, "COMBAT_UNAVAILABLE", "Combat is unavailable");
          return;
        }
        try {
          const cleared = await playerAuthorityFence.run(developerPlayerId, async () => {
            if (
              state.playerId !== developerPlayerId ||
              state.connectionId !== developerConnectionId ||
              registry.activeConnectionIdForPlayer(developerPlayerId) !== developerConnectionId ||
              !gameState.getPlayer(developerPlayerId)
            ) return null;
            if (rejectDuringPlayerWorldTransition(message.requestId)) return null;
            await xoralEvents?.clearDeveloperEvents();
            const persistedRemoved = await developerSpawnedMobs.clearPersisted();
            const remainingRemoved = combat.clearMobs();
            return persistedRemoved + remainingRemoved;
          });
          if (cleared === null) return;
          safeSendServerMessage(socket, {
            type: "DEV_MOBS_CLEARED",
            requestId: message.requestId,
            removedCount: cleared
          });
        } catch (error) {
          await recordDeveloperMessageResult(
            "developer:world-mutate",
            "mobs.clear",
            "failed",
            "all",
            message.requestId
          );
          sendCombatError(
            socket,
            message.requestId,
            "DEV_MOBS_CLEAR_FAILED",
            error instanceof Error ? error.message : "Developer mobs could not be cleared"
          );
          return;
        }
        await recordDeveloperMessageResult(
          "developer:world-mutate",
          "mobs.clear",
          "succeeded",
          "all",
          message.requestId
        );
        return;
      }
      case "DEV_SPAWN_PLANT": {
        requireHello(state.playerId);
        const developerPlayerId = state.playerId;
        const developerConnectionId = state.connectionId;
        if (!(await authorizeDeveloperMessage(
          "developer:world-mutate",
          "plant.spawn",
          message.requestId,
          message.plantKey,
          message.requestId
        ))) return;
        if (!developerSpawnedPlants || !config) {
          sendCombatError(socket, message.requestId, "RESOURCE_UNAVAILABLE", "Plant spawning is unavailable");
          return;
        }
        const player = gameState.getPlayer(state.playerId);
        if (!player) {
          sendCombatError(socket, message.requestId, "PLAYER_NOT_CONNECTED", "Player is not connected");
          return;
        }
        try {
          validateMoveTarget(message.lat, message.lon);
        } catch {
          sendCombatError(socket, message.requestId, "DEV_PLANT_SPAWN_INVALID", "Plant coordinate is invalid");
          return;
        }
        if (
          distanceMeters(player.position, { lat: message.lat, lon: message.lon }) >
          config.DEV_MOB_MAX_SPAWN_DISTANCE_M
        ) {
          sendCombatError(
            socket,
            message.requestId,
            "DEV_PLANT_SPAWN_TOO_FAR",
            `Plant spawn must be within ${config.DEV_MOB_MAX_SPAWN_DISTANCE_M}m`
          );
          return;
        }
        try {
          const spawned = await playerAuthorityFence.run(developerPlayerId, async () => {
            if (
              state.playerId !== developerPlayerId ||
              state.connectionId !== developerConnectionId ||
              registry.activeConnectionIdForPlayer(developerPlayerId) !== developerConnectionId
            ) return false;
            if (rejectDuringPlayerWorldTransition(message.requestId)) return false;
            const currentPlayer = gameState.getPlayer(developerPlayerId);
            if (!currentPlayer) throw new Error("Player is not connected");
            if (
              distanceMeters(currentPlayer.position, { lat: message.lat, lon: message.lon }) >
              config.DEV_MOB_MAX_SPAWN_DISTANCE_M
            ) {
              throw new Error(
                `Plant spawn must be within ${config.DEV_MOB_MAX_SPAWN_DISTANCE_M}m`
              );
            }
            const plant = await developerSpawnedPlants.spawn({
              creatorPlayerId: developerPlayerId,
              requestId: message.requestId,
              plantKey: message.plantKey,
              position: { lat: message.lat, lon: message.lon },
              regionCode: currentPlayer.regionCode,
              zoneId: zoneIdForPosition(currentPlayer.position)
            });
            safeSendServerMessage(socket, {
              type: "DEV_PLANT_SPAWNED",
              requestId: message.requestId,
              plantEntityId: plant.entityId,
              plantKey: plant.plantKey
            });
            await sendCollectiblesForPlayer(currentPlayer);
            return true;
          });
          if (!spawned) return;
        } catch (error) {
          await recordDeveloperMessageResult(
            "developer:world-mutate",
            "plant.spawn",
            "failed",
            message.plantKey,
            message.requestId
          );
          sendCombatError(
            socket,
            message.requestId,
            "DEV_PLANT_SPAWN_FAILED",
            error instanceof Error ? error.message : "Developer plant could not be spawned"
          );
          return;
        }
        await recordDeveloperMessageResult(
          "developer:world-mutate",
          "plant.spawn",
          "succeeded",
          message.plantKey,
          message.requestId
        );
        return;
      }
      case "DEV_CLEAR_PLANTS": {
        requireHello(state.playerId);
        const developerPlayerId = state.playerId;
        const developerConnectionId = state.connectionId;
        if (!(await authorizeDeveloperMessage(
          "developer:world-mutate",
          "plants.clear",
          message.requestId,
          "all",
          message.requestId
        ))) return;
        if (!developerSpawnedPlants) {
          sendCombatError(socket, message.requestId, "RESOURCE_UNAVAILABLE", "Plant spawning is unavailable");
          return;
        }
        try {
          const cleared = await playerAuthorityFence.run(developerPlayerId, async () => {
            if (
              state.playerId !== developerPlayerId ||
              state.connectionId !== developerConnectionId ||
              registry.activeConnectionIdForPlayer(developerPlayerId) !== developerConnectionId ||
              !gameState.getPlayer(developerPlayerId)
            ) return null;
            if (rejectDuringPlayerWorldTransition(message.requestId)) return null;
            const removedCount = await developerSpawnedPlants.clearPersisted();
            await sendCollectiblesForPlayer(gameState.getPlayer(developerPlayerId));
            return removedCount;
          });
          if (cleared === null) return;
          safeSendServerMessage(socket, {
            type: "DEV_PLANTS_CLEARED",
            requestId: message.requestId,
            removedCount: cleared
          });
        } catch (error) {
          await recordDeveloperMessageResult(
            "developer:world-mutate",
            "plants.clear",
            "failed",
            "all",
            message.requestId
          );
          sendCombatError(
            socket,
            message.requestId,
            "DEV_PLANTS_CLEAR_FAILED",
            error instanceof Error ? error.message : "Developer plants could not be cleared"
          );
          return;
        }
        await recordDeveloperMessageResult(
          "developer:world-mutate",
          "plants.clear",
          "succeeded",
          "all",
          message.requestId
        );
        return;
      }
      case "DEV_VISIT_MINE": {
        requireHello(state.playerId);
        if (!(await authorizeDeveloperMessage(
          "developer:world-mutate",
          "mine.visit",
          message.requestId,
          message.mineId,
          message.requestId
        ))) return;
        if (!repeatableResources || !worldRuntime) {
          sendCombatError(socket, message.requestId, "PERMANENT_MINES_UNAVAILABLE", "Permanent mine travel is unavailable");
          return;
        }
        const target = await repeatableResources.developerMineVisitTarget(message.mineId);
        if (!target) {
          sendCombatError(socket, message.requestId, "PERMANENT_MINE_NOT_FOUND", "Permanent mine does not exist");
          return;
        }
        if (!target.flag) {
          sendCombatError(socket, message.requestId, "PERMANENT_MINE_NO_COVERING_FLAG", "No active covering flag");
          return;
        }
        const result = await performAuthoritativeTravel({
          playerId: state.playerId,
          requestId: message.requestId,
          arrivalMode: "protected_jump",
          kind: "dev_mine",
          sendResult: false,
          playerSpawnPosition: target.minePosition,
          destination: {
            kind: "flag",
            id: target.flag.id,
            center: target.flag.center,
            flagCenter: target.flag.center,
            flagName: target.flag.name,
            claimRadiusM: target.flag.claimRadiusM,
            resourceVisionRadiusM: target.flag.resourceVisionRadiusM
          }
        });
        if (!result.success) {
          sendCombatError(socket, message.requestId, result.reason.code, result.reason.message);
          return;
        }
        registry.send(state.playerId, {
          type: "DEV_MINE_VISIT_COMPLETED",
          requestId: message.requestId,
          mineId: target.mineId,
          flagId: target.flag.id,
          player: result.player,
          serverTime: Date.now()
        });
        await recordDeveloperMessageResult(
          "developer:world-mutate",
          "mine.visit",
          "succeeded",
          message.mineId,
          message.requestId
        );
        return;
      }
      case "DEV_TELEPORT": {
        requireHello(state.playerId);
        const teleportPlayerId = state.playerId;
        if (!(await authorizeDeveloperMessage(
          "developer:world-mutate",
          "player.teleport",
          message.requestId,
          teleportPlayerId,
          message.requestId
        ))) return;
        const teleportRequestKey = `${teleportPlayerId}:${message.requestId}`;
        const replay = developerRealtimeState.replay(teleportRequestKey);
        if (replay) {
          registry.send(teleportPlayerId, replay);
          return;
        }
        if (developerRealtimeState.isActive(teleportRequestKey)) {
          sendCombatError(socket, message.requestId, "DEV_TELEPORT_DUPLICATE", "This teleport request is already pending");
          return;
        }
        if (!worldRuntime || !worldLookup || !state.connectionId || !authenticatedSession) {
          sendCombatError(socket, message.requestId, "DEV_TELEPORT_UNAVAILABLE", "Development teleport is unavailable");
          return;
        }
        const constructionBlock = getCityConstructionBlockReason(
          gameState,
          teleportPlayerId
        );
        if (constructionBlock) {
          sendCombatError(
            socket,
            message.requestId,
            constructionBlock.code,
            constructionBlock.message
          );
          return;
        }
        if (worldRuntime.hasPlayerWorldTransition(teleportPlayerId)) {
          sendCombatError(socket, message.requestId, "PLAYER_WORLD_TRANSITION_PENDING", "A player world transition is already pending");
          return;
        }
        if (!combat?.isPlayerAlive(teleportPlayerId) || combat.isInCombat(teleportPlayerId) || combat.hasQueuedAbility(teleportPlayerId)) {
          sendCombatError(socket, message.requestId, "DEV_TELEPORT_COMBAT_LOCKED", "Cannot teleport during combat, defeat, or respawn");
          return;
        }
        developerRealtimeState.begin(teleportRequestKey);
        // Developer teleports past the world edge land on the edge instead.
        const destination = clampToWorldEdge(validateMoveTarget(message.lat, message.lon));
        const lookupStartedAt = performance.now();
        logger.info({ playerId: teleportPlayerId, requestId: message.requestId, destination }, "development teleport requested");
        const world = await worldLookup.lookupGameplayEnvironment(
          destination.lat,
          destination.lon
        );
        if (!world.ok || !world.packageId) {
          developerRealtimeState.finish(teleportRequestKey);
          sendCombatError(socket, message.requestId, "DEV_TELEPORT_WORLD_UNAVAILABLE", "The target is outside authoritative world coverage");
          return;
        }
        const destinationPackageId = world.packageId;
        try {
          await playerAuthorityFence.run(teleportPlayerId, async () => {
            const fencedConstructionBlock = getCityConstructionBlockReason(
              gameState,
              teleportPlayerId
            );
            if (fencedConstructionBlock) {
              sendCombatError(
                socket,
                message.requestId,
                fencedConstructionBlock.code,
                fencedConstructionBlock.message
              );
              return;
            }
            if (worldRuntime.hasPlayerWorldTransition(teleportPlayerId)) {
              sendCombatError(socket, message.requestId, "PLAYER_WORLD_TRANSITION_PENDING", "A player world transition is already pending");
              return;
            }
            if (!combat.isPlayerAlive(teleportPlayerId) || combat.isInCombat(teleportPlayerId) || combat.hasQueuedAbility(teleportPlayerId)) {
              sendCombatError(socket, message.requestId, "DEV_TELEPORT_COMBAT_LOCKED", "Cannot teleport during combat, defeat, or respawn");
              return;
            }
            const transitionToken = worldRuntime.beginPlayerWorldTransition(teleportPlayerId);
            if (!transitionToken) {
              sendCombatError(socket, message.requestId, "PLAYER_WORLD_TRANSITION_PENDING", "A player world transition is already pending");
              return;
            }
            const previousView = gameState.capturePlayerViewTransition(teleportPlayerId);
            const sourcePlayer = gameState.getPlayer(teleportPlayerId);
            const sourcePackageId = sourcePlayer?.regionCode ?? null;
            let relocationPersisted = false;
            try {
              flagBuilds?.cancelPlayer(teleportPlayerId, "teleport");
              gameState.stopPlayer(teleportPlayerId);
              const activeHarvest = await activeHarvestSessionForPlayer(teleportPlayerId);
              if (activeHarvest) await harvestSessions?.cancelHarvest(teleportPlayerId, activeHarvest.sessionId);
              if (!sourcePlayer) throw new Error("player is not connected");
              gameState.applyAuthoritativeRelocation({
                playerId: teleportPlayerId,
                anchor: destination,
                authoritativeRegionCode: destinationPackageId,
                resourceVision: resourceVisionForArea({
                  regionCode: destinationPackageId,
                  position: destination,
                  movementLeashRadiusM: sourcePlayer.moveLeashRadiusM,
                  visibleRadiusM:
                    config?.FLAG_RESOURCE_VISION_RADIUS_M ??
                    DEFAULT_FLAG_RESOURCE_VISION_RADIUS_M
                })
              });
              const player = gameState.snapshotForPlayer(teleportPlayerId);
              await playerService.persistPlayerSnapshot(player);
              relocationPersisted = true;
              syncCombatPlayerAfterRelocation(player);
              const zoneId = zoneIdForPosition(destination);
              registry.updateSpatialMembership({
                playerId: teleportPlayerId,
                regionCode: destinationPackageId,
                zoneId,
                interestZoneIds: gameplayInterestZoneIds(
                  teleportPlayerId,
                  gameplayInterestCenter(teleportPlayerId, destination)
                )
              });
              worldRuntime.replication.requestResync(teleportPlayerId);
              combat.requestResync(teleportPlayerId);
              const completion: Extract<ServerMessage, { type: "DEV_TELEPORT_COMPLETED" }> = {
                type: "DEV_TELEPORT_COMPLETED",
                requestId: message.requestId,
                player,
                packageId: destinationPackageId,
                zoneId,
                resourceVisionRevision:
                  gameState.getResourceVisionRevision(teleportPlayerId),
                serverTime: Date.now()
              };
              developerRealtimeState.complete(teleportRequestKey, completion);
              registry.send(teleportPlayerId, completion);
              const populationRelocation =
                schedulePopulationV2RelocationForActivePlayer(
                  teleportPlayerId,
                  "administrative-relocation"
                );
              await waitForRelocationPopulationV2({
                playerId: teleportPlayerId,
                requestId: message.requestId,
                destination,
                transitionToken,
                relocation: populationRelocation
              });
              if (travelInvites) {
                const affected = await travelInvites.invalidateForInviter(
                  teleportPlayerId,
                  "The inviter relocated to another gameplay layer."
                );
                await sendTravelInboxForPlayers(affected);
              }
              flagBuilds?.refreshQuoteForPlayer(teleportPlayerId, "dev-teleport-completed");
              sendCombatScopeSnapshot(teleportPlayerId);
              void followPartyLeader(
                teleportPlayerId,
                { kind: "world", id: null, center: destination },
                message.requestId
              ).catch((error: unknown) => {
                logger.warn({ err: error, playerId: teleportPlayerId }, "failed to fan out development party travel");
              });
              void sendManorsForPlayer(gameState.getPlayer(teleportPlayerId)).catch((error: unknown) => {
                logger.warn({ err: error, playerId: teleportPlayerId }, "failed to refresh manor markers after development teleport");
              });
              await sendCollectiblesForPlayer(gameState.getPlayer(teleportPlayerId));
              await sendDroppedItemsToSocket(teleportPlayerId);
              if (cities) registry.send(teleportPlayerId, { type: "CITIES_SNAPSHOT", cities: await cities.listCitiesNear(destination) });
              logger.info({
                playerId: teleportPlayerId,
                requestId: message.requestId,
                sourcePackageId,
                destinationPackageId,
                destinationZoneId: zoneId,
                destination,
                durationMs: Math.round(performance.now() - lookupStartedAt)
              }, "development teleport completed");
              await recordDeveloperMessageResult(
                "developer:world-mutate",
                "player.teleport",
                "succeeded",
                teleportPlayerId,
                message.requestId
              );
            } catch (error) {
              if (relocationPersisted) {
                logger.warn(
                  { err: error, playerId: teleportPlayerId, requestId: message.requestId },
                  "development teleport committed but a post-relocation refresh failed"
                );
                return;
              }
              gameState.restorePlayerViewTransition(teleportPlayerId, previousView);
              logger.warn({ err: error, playerId: teleportPlayerId, requestId: message.requestId }, "development teleport failed");
              await recordDeveloperMessageResult(
                "developer:world-mutate",
                "player.teleport",
                "failed",
                teleportPlayerId,
                message.requestId
              );
              sendCombatError(socket, message.requestId, "DEV_TELEPORT_FAILED", "Teleport could not be applied consistently");
            } finally {
              worldRuntime.endPlayerWorldTransition(teleportPlayerId, transitionToken);
            }
          });
        } finally {
          developerRealtimeState.finish(teleportRequestKey);
        }
        return;
      }
    }
  };
}

export function assertDevProgressionAccess(
  config: AppConfig | undefined,
  authorizedDeveloper: boolean
): void {
  if (
    !config ||
    !config.DEV_TOOLS_ENABLED ||
    !authorizedDeveloper ||
    !isDeveloperEconomyMode(config)
  ) {
    throw new ClassRequestError(
      "DEV_PROGRESSION_DISABLED",
      "Development progression tools are disabled"
    );
  }
}

export function assertDevelopmentEconomyAccess(
  config: AppConfig | undefined,
  authorizedDeveloper: boolean
): void {
  if (
    !config ||
    !config.DEV_TOOLS_ENABLED ||
    !authorizedDeveloper ||
    !isDeveloperEconomyMode(config)
  ) {
    throw new Error("Development economy tools are disabled");
  }
}

export function registerDeveloperHandler(
  router: RealtimeMessageRouter,
  handler: RealtimeFamilyHandler<"developer">
): void {
  router.register("developer", handler);
}
