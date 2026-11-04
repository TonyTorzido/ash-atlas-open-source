import { createHmac, randomUUID } from "node:crypto";

import websocketPlugin from "@fastify/websocket";
import {
  ASH_ATLAS_PROTOCOL_INCOMPATIBLE_CLOSE_CODE,
  ASH_ATLAS_PROTOCOL_INCOMPATIBLE_CLOSE_REASON,
  BUG_REPORT_WIRE_MAX_BYTES,
  CITY_STRUCTURE_SNAPSHOT_RADIUS_M,
  STRUCTURE_WARFARE_INTERACTION_RADIUS_M,
  STRUCTURE_WARFARE_REPAIR_TICK_MS,
  distanceMeters,
  negotiateAshAtlasProtocol,
  parseClientMessage,
  protocolSupportMetadataFromQuery,
  type BugReportSubmitMessage,
  type ClientMessage
} from "@ash-atlas/shared";
import type { FastifyInstance } from "fastify";
import type { RawData } from "ws";
import type pg from "pg";

import type { AuthService } from "../auth/authService.js";
import type { NativeAppAuthorization } from "../auth/nativeAppAuthorization.js";
import { sendAuthError } from "../auth/authGuard.js";
import { AuthError } from "../auth/types.js";
import type { AppConfig } from "../config.js";
import type { AppLogger } from "../logger.js";
import type { ChatRealtimeCoordinator } from "../chat/chatRealtime.js";
import type { DirectMessageRealtimeCoordinator } from "../directMessages/directMessageRealtime.js";
import type { CityService } from "../game/cities.js";
import type { WorldMapService } from "../game/worldMap.js";
import { endKingdomWithCollapse, type KingdomService } from "../game/kingdoms.js";
import type { CollectibleService } from "../game/collectibles.js";
import type { BalsamResinService } from "../game/balsamResin.js";
import type { FieldConsumableService } from "../game/fieldConsumables.js";
import { WaterSiteService } from "../game/waterSites.js";
import type { BackpackService } from "../game/backpacks.js";
import type { CombatEngine } from "../game/combat/combatEngine.js";
import { DruidReplenishService } from "../game/combat/druidReplenish.js";
import { MerchantMaximizeTacticsService } from "../game/combat/merchantMaximizeTactics.js";
import { WaterTravelService } from "../game/waterTravel.js";
import type { PetCompanionRuntime } from "../game/combat/petCompanionRuntime.js";
import type { MinionRuntime } from "../game/combat/minionRuntime.js";
import type { CombatProfileService } from "../game/combat/combatProfiles.js";
import type { DroppedItemService } from "../game/droppedItems.js";
import type { CisternWarrensRuntime } from "../game/dungeon.js";
import type { EquipmentService } from "../game/equipment.js";
import type { DevelopmentEconomyService } from "../game/developmentEconomy.js";
import type { DeveloperSpawnedMobService } from "../game/developerSpawnedMobs.js";
import type { DeveloperSpawnedPlantService } from "../game/developerSpawnedPlants.js";
import type { DeveloperSpawnedDungeonService } from "../game/developerSpawnedDungeons.js";
import { flagSetRevisionMetadata, type FlagService } from "../game/flags.js";
import {
  TERRITORY_COLLAPSE_TICK_MS,
  TerritoryCollapseService
} from "../game/territoryCollapse.js";
import { publishBrokenFlags, publishTerritoryCollapseStarted } from "./territoryCollapsePublisher.js";
import { settleFallenOrganizationStructures } from "../game/organizationStructureFall.js";
import { abandonInactiveOwnerFlags, FLAG_ABANDONMENT_SWEEP_INTERVAL_MS } from "../game/flagAbandonment.js";
import { TOWER_VOLLEY_TICK_MS, TowerVolleyService } from "../game/towerVolleys.js";
import { forwardSappersWarTowerBonus } from "../game/kingdomPerks.js";
import { broadcastCityStructureWarfare } from "./handlers/settlementHandler.js";
import type { FlagAccessService } from "../game/flagAccess.js";
import { PlayerAuthorityFence } from "../game/playerAuthorityFence.js";
import type { HarvestSessionService } from "../game/harvestSessions.js";
import type { InventoryService } from "../game/inventory.js";
import type { FurnaceService } from "../game/furnaces.js";
import type { TanneryService } from "../game/tanneries.js";
import type { LoomService } from "../game/looms.js";
import type { KitchenService } from "../game/kitchens.js";
import type { GreenhouseService } from "../game/greenhouses.js";
import type { GreenhouseRuntime } from "../game/greenhouseRuntime.js";
import { greenhouseStateForCropCapableClient } from "../game/greenhouseCropContent.js";
import type { FishingService } from "../game/fishing.js";
import type { SimpleFoodService } from "../game/simpleFood.js";
import type { JewelStationService } from "../game/jewelStation.js";
import type { AchievementService } from "../game/achievements.js";
import type { InventoryProtectionService } from "../game/inventoryProtection.js";
import type { PlayerService } from "../game/players.js";
import type { PetService } from "../game/petService.js";
import type { GivingSaplingService } from "../game/givingSaplings.js";
import type { MutablePartyAuthority } from "../game/party/PartyAuthority.js";
import type { ProgressionService } from "../game/progression.js";
import type { MasteryService } from "../game/masteries.js";
import type { ClassService } from "../game/classes/classService.js";
import type { SkillService, SpecializationService } from "../game/skills/index.js";
import type { ResourceVisionJobQueue } from "../game/resourceVisionJobs.js";
import type { RepeatableResourceService } from "../game/repeatableResources.js";
import type { DungeonResourceHarvestService } from "../game/dungeonResourceHarvest.js";
import type { GameState } from "../game/state.js";
import type { TravelInviteService } from "../game/travelInvites.js";
import type { MarketService } from "../game/marketService.js";
export { publishMarketCommit } from "./marketRealtimeOperations.js";
import type { WorldRuntime } from "../game/worldRuntime.js";
import type { XoralEventService } from "../game/xoralEvents.js";
import type { OverworldBossParticipantLeaseCoordinator } from "../game/overworldBossParticipantLeases.js";
import type { LegendaryBirdEventService } from "../game/legendaryBirdEvents.js";
import type { CreatureBookService } from "../game/creatureBook.js";
import type { BiomeDiscoveryService } from "../game/biomeDiscovery.js";
import type { AltDoorwayGate } from "../auth/trust/altDoorway.js";
import type { DestinationAnchorGate } from "../auth/trust/destinationAnchorGate.js";
import type { HostileActionGate } from "../auth/trust/hostileGate.js";
import type { TrustArrivalLog } from "../auth/trust/trustArrivals.js";
import type { RelocationGate } from "../auth/trust/relocationGate.js";
import type { SettlementService } from "../auth/trust/settlement.js";
import type { LandActionGate, LocationReportService } from "../auth/trust/trustService.js";
import type { SalonRuntime, SalonService } from "../game/salon.js";
import type { RecentPlayersService } from "../game/recentPlayers.js";
import type { PlayerPackageService } from "../game/playerPackages.js";
import type { PlayerGiftService } from "../game/playerGifts.js";
import type { GlimmerShopService } from "../game/glimmerShop.js";
import type { WalletService } from "../game/wallet.js";
import type { DungeonSkillService } from "../game/dungeonSkills.js";
import type { DungeonTorchLobbyService } from "./dungeonTorchLobbyService.js";
import type { PremiumWalletService } from "../game/premiumWallet.js";
import type { GoblinVillageService } from "../game/goblinVillage.js";
import type { HollinHutService } from "../game/hollinHuts.js";
import type { MapMarkerService } from "../game/mapMarkers.js";
import type { CinderLanternService } from "../game/cinderLanterns.js";
import type { WanderingMerchantService } from "../game/wanderingMerchants.js";
import type { PlayerLocationService } from "../game/locations/playerLocationService.js";
import type { PortalRegistry } from "../game/locations/portalRegistry.js";
import type {
  BugReportAuthoritativeContext,
  ClosedTestTelemetryService
} from "../telemetry/service.js";
import type { WorldLookupClient } from "../world/worldLookupClient.js";
import type {
  ManorPresenceService,
  ManorRuntime,
  ManorStorageService
} from "../game/manor.js";
import type { ManorDecorationService } from "../game/manorDecorations.js";
import type { ConnectionRegistry, SocketLike } from "./connectionRegistry.js";
import type { PartyCombatPublisher } from "./partyCombatPublisher.js";
import type { PartyReadyCheckService } from "./partyReadyCheckService.js";
import { publishFlagSnapshot } from "./flagSnapshotPublisher.js";
import { CLIENT_MESSAGE_FAMILIES } from "./messageRouter.js";
import {
  ConnectionCloseRegistry,
  ConnectionGenerationLedger,
  runIndependentBootstrapTask
} from "./connectionLifecycle.js";
import { createRealtimeMessageRouter } from "./handlers/registerHandlers.js";
import {
  clientReleaseIdentityFromQuery,
  createClientReleaseGate
} from "./clientReleaseGate.js";
import { readPublishedVersionMetadata } from "./publishedVersionMetadata.js";
import {
  createSessionHandler,
  type SessionConnectionState
} from "./handlers/sessionHandler.js";
import {
  createSessionBootstrap,
  publishStartupPresentationCombatSnapshot
} from "./handlers/sessionBootstrap.js";
import { createWorldGameplayHandler } from "./handlers/worldGameplayHandler.js";
import { createFlagHandler } from "./handlers/flagHandler.js";
import { landActionAllowed, noteLandAction, raidAllowed } from "./handlers/landActionGuard.js";
import { createTravelHandler } from "./handlers/travelHandler.js";
import { createSettlementHandler } from "./handlers/settlementHandler.js";
import { createPartyHandler } from "./handlers/partyHandler.js";
import { createManorHandler } from "./handlers/manorHandler.js";
import { createSalonHandler } from "./handlers/salonHandler.js";
import { createHarvestingHandler } from "./handlers/harvestingHandler.js";
import { createCombatEquipmentHandler } from "./handlers/combatEquipmentHandler.js";
import { createBackpackHandler } from "./handlers/backpackHandler.js";
import {
  createChatBootstrap,
  createSocialHandler,
  KingdomChatRateGate
} from "./handlers/socialHandler.js";
import {
  createMarketHandler,
  MarketNetworkRateLimiter
} from "./handlers/marketHandler.js";
import { createPetHandler } from "./handlers/petHandler.js";
import { createSaplingHandler } from "./handlers/saplingHandler.js";
import { createPlayerPackageHandler } from "./handlers/playerPackageHandler.js";
import { createPlayerGiftHandler } from "./handlers/playerGiftHandler.js";
import { createShopHandler } from "./handlers/shopHandler.js";
import { createDeveloperHandler } from "./handlers/developerHandler.js";
import { createDungeonHandler } from "./handlers/dungeonHandler.js";
import { createPortalHandler } from "./handlers/portalHandler.js";
import { createPortalTransitionEffects } from "./portalTransitionEffects.js";
import { createSalonPortalOperations } from "./salonPortalOperations.js";
export {
  assertDevelopmentEconomyAccess,
  assertDevProgressionAccess
} from "./handlers/developerHandler.js";
import {
  safeSendServerMessage,
  sendCombatError
} from "./handlers/handlerExecutionContext.js";
export { safeSendServerMessage } from "./handlers/handlerExecutionContext.js";

export { KingdomChatRateGate };
import {
  ClassRealtimeState,
  isDeveloperClassRateExempt
} from "./classRealtimeState.js";
export {
  enforceClassRate,
  isDeveloperClassRateExempt
} from "./classRealtimeState.js";
import { DeveloperRealtimeState } from "./developerRealtimeState.js";
import { ManorRealtimeState } from "./manorRealtimeState.js";
import {
  createCancelPendingManorEntry,
  createManorRealtimeOperations,
  sendManorError
} from "./manorRealtimeOperations.js";
export { isWorldOnlyWhileInManor } from "./manorRealtimeOperations.js";
import {
  createConnectionCombatEquipmentOperations,
  createCombatEquipmentRealtimeOperations,
  equipmentRuntimeContextFor,
  withEquipmentStats,
  withLiveClassCombatState
} from "./combatEquipmentRealtimeOperations.js";
import { createFlagRealtimeOperations } from "./flagRealtimeOperations.js";
import {
  createCityFlagConversionRealtimeOperations
} from "./cityFlagConversionRealtimeOperations.js";
import { createRealtimeSnapshotOperations } from "./realtimeSnapshotOperations.js";
import { createConnectionSnapshotOperations } from "./connectionSnapshotOperations.js";
import { createConnectionWorldOperations } from "./connectionWorldOperations.js";
import { createConnectionMessageAdmission } from "./connectionMessageAdmission.js";
import { PartyRealtimeState } from "./partyRealtimeState.js";
import { SocialRealtimeState } from "./socialRealtimeState.js";
import { TravelRuntimeState } from "./travelRuntimeState.js";
import { createTravelRealtimeOperations } from "./travelRealtimeOperations.js";
import { createMetalExpelHandler } from "./metalExpel.js";
import {
  createPopulationRealtimeOperations,
  type ScheduledPopulationV2Relocation,
  type PopulationV2RealtimeHooks
} from "./populationRealtimeOperations.js";
import { ReconnectLeaseCoordinator } from "./reconnectLeaseCoordinator.js";
import {
  BootstrapAttemptCoordinator,
  type BootstrapAttempt
} from "./bootstrapAttemptCoordinator.js";

export type {
  PopulationV2RealtimeHooks,
  PopulationV2RealtimeRelocationHandle
} from "./populationRealtimeOperations.js";

type RawSocket = SocketLike & {
  on(event: "message", handler: (data: RawData | string) => void): void;
  on(event: "close", handler: (code: number, reason: Buffer) => void): void;
  on(event: "error", handler: (error: Error) => void): void;
};

export type RealtimeLifecycle = {
  devTeleport(
    playerId: string,
    requestId: string,
    destination: { lat: number; lon: number }
  ): Promise<{ success: true } | { success: false; reason: { code: string; message: string } }>;
  schedulePopulationRelocation(playerId: string): boolean;
  refreshDroppedItemsNear(
    positions: readonly Readonly<{ lat: number; lon: number }>[]
  ): Promise<void>;
  finalizeAccountConnections(accountId: string, code: number, reason: string): Promise<void>;
  /**
   * Re-run the full gameplay gate for live sockets now (all, or one account's),
   * closing any that no longer pass instead of waiting for the periodic recheck.
   */
  revalidateLiveSessions(accountId?: string): Promise<void>;
  shutdownConnections(): Promise<void>;
};

type ExplicitOptional<T> = Readonly<{
  [Property in keyof T]?: T[Property] | undefined;
}>;

export type RealtimeDependencies = Readonly<{
  infrastructure: Readonly<{
    app: FastifyInstance;
    registry: ConnectionRegistry;
    logger: AppLogger;
    config?: AppConfig | undefined;
    worldLookup?: WorldLookupClient | undefined;
    telemetry?: ClosedTestTelemetryService | undefined;
    captureTelemetryPlayerSnapshot?: (
      playerId: string,
      sessionId: string,
      reason: "login" | "logout" | "terminal_disconnect"
    ) => void | Promise<void>;
    captureBugReportContext?: (
      playerId: string,
      report: BugReportSubmitMessage
    ) => Promise<BugReportAuthoritativeContext>;
  }>;
  authority: Readonly<{
    gameState: GameState;
    flagService: FlagService;
    playerService: PlayerService;
    auth?: AuthService | undefined;
    nativeAppAuthorization?: NativeAppAuthorization | undefined;
    worldRuntime?: WorldRuntime | undefined;
    flagAccess?: FlagAccessService | undefined;
  }>;
  capabilities?: ExplicitOptional<{
    collectibles?: CollectibleService;
    harvestSessions?: HarvestSessionService;
    dungeonResourceHarvest?: DungeonResourceHarvestService;
    balsamResin?: BalsamResinService;
    fieldConsumables?: FieldConsumableService;
    resourceVisionJobs?: ResourceVisionJobQueue;
    droppedItems?: DroppedItemService;
    combat?: CombatEngine;
    developerSpawnedMobs?: DeveloperSpawnedMobService;
    developerSpawnedPlants?: DeveloperSpawnedPlantService;
    developerSpawnedDungeons?: DeveloperSpawnedDungeonService;
    goblinVillage?: GoblinVillageService;
    hollinHuts?: HollinHutService;
    mapMarkers?: MapMarkerService;
    wanderingMerchants?: WanderingMerchantService;
    cinderLanterns?: CinderLanternService;
    combatProfiles?: CombatProfileService;
    progression?: ProgressionService;
    equipment?: EquipmentService;
    backpacks?: BackpackService;
    cities?: CityService;
    chats?: ChatRealtimeCoordinator;
    kingdoms?: KingdomService;
    market?: MarketService;
    classes?: ClassService;
    skills?: SkillService;
    specializations?: SpecializationService;
    partyAuthority?: MutablePartyAuthority;
    partyCombatPublisher?: PartyCombatPublisher;
    partyReadyChecks?: PartyReadyCheckService;
    developmentEconomy?: DevelopmentEconomyService;
    manorPresence?: ManorPresenceService;
    manorStorage?: ManorStorageService;
    manorRuntime?: ManorRuntime;
    manorDecorations?: ManorDecorationService;
    furnaces?: FurnaceService;
    tanneries?: TanneryService;
    looms?: LoomService;
    kitchens?: KitchenService;
    greenhouses?: GreenhouseService;
    greenhouseRuntime?: GreenhouseRuntime;
    fishing?: FishingService;
    simpleFood?: SimpleFoodService;
    jewelStation?: JewelStationService;
    achievements?: AchievementService;
    salon?: SalonService;
    salonRuntime?: SalonRuntime;
    travelInvites?: TravelInviteService;
    directMessages?: DirectMessageRealtimeCoordinator;
    recentPlayers?: RecentPlayersService;
    repeatableResources?: RepeatableResourceService;
    inventory?: InventoryService;
    databasePool?: pg.Pool;
    inventoryProtection?: InventoryProtectionService;
    starterInventory?: Pick<InventoryService, "grantItemsForOperation">;
    masteries?: MasteryService;
    worldMap?: WorldMapService;
    pets?: PetService;
    givingSaplings?: GivingSaplingService;
    dogCompanions?: PetCompanionRuntime;
    minions?: MinionRuntime;
    playerPackages?: PlayerPackageService;
    playerGifts?: PlayerGiftService;
    glimmerShop?: GlimmerShopService;
    wallet?: WalletService;
    premiumWallet?: PremiumWalletService;
    dungeon?: CisternWarrensRuntime;
    dungeonSkills?: DungeonSkillService;
    dungeonTorchLobbies?: DungeonTorchLobbyService;
    playerLocations?: PlayerLocationService;
    portals?: PortalRegistry;
    xoralEvents?: XoralEventService;
    overworldBossParticipantLeases?: OverworldBossParticipantLeaseCoordinator;
    legendaryBirdEvents?: LegendaryBirdEventService;
    creatureBook?: CreatureBookService;
    biomeDiscovery?: BiomeDiscoveryService;
    locationReports?: LocationReportService;
    landActions?: LandActionGate;
    altDoorway?: AltDoorwayGate;
    settlement?: SettlementService;
    relocationGate?: RelocationGate;
    hostileGate?: HostileActionGate;
    pvpStatus?: Readonly<{ sendTo(playerId: string): Promise<void>; hasTimers?(playerId: string): boolean }>;
    destinationAnchors?: DestinationAnchorGate;
    trustArrivals?: TrustArrivalLog;
  }>;
  operations?: ExplicitOptional<{
    persistRuntimePlayers?: () => Promise<void>;
    populationV2?: PopulationV2RealtimeHooks;
    settleAndRespawnPlayer?: (
      playerId: string,
      complete: (operationKey: string) => Promise<boolean>
    ) => Promise<boolean>;
  }>;
}>;

const LIVE_SESSION_RECHECK_INTERVAL_MS = 60_000;
const LIVE_CLIENT_RELEASE_RECHECK_INTERVAL_MS = 5_000;
const DEFAULT_WS_MAX_PAYLOAD_BYTES = 65_536;
const DEFAULT_TRAVEL_PHASE_2_TASK_TIMEOUT_MS = 10_000;
const DEFAULT_RECONNECT_GRACE_MS = 180_000;
const DEFAULT_LINKDEAD_WORLD_PRESENCE_MS = 30_000;
const HARVEST_RECONNECT_GRACE_MS = 12_000;
const HARVEST_SESSION_SCAVENGE_INTERVAL_MS = 5_000;
const DEFAULT_WS_HEARTBEAT_TIMEOUT_MS = 20_000;
const DEFAULT_WS_HEARTBEAT_SWEEP_MS = 5_000;
const DEFAULT_WS_BOOTSTRAP_TIMEOUT_MS = 15_000;
const securityMetrics = {
  oversizedPayloadRejections: 0,
  edgeMarketRateLimitRejections: 0,
  bootstrapAttemptsStarted: 0,
  bootstrapAttemptsCancelled: 0,
  bootstrapAttemptsTimedOut: 0,
  staleBootstrapRejections: 0,
  bootstrapRegistryHandoffs: 0,
  bootstrapWelcomesSent: 0,
  unexpectedCrossAccountReplacements: 0
};

export function websocketSecurityMetricsSnapshot(): Readonly<typeof securityMetrics> {
  return { ...securityMetrics };
}

export function isWebSocketHeartbeatExpired(
  lastMessageAt: Date,
  nowMs: number,
  timeoutMs: number
): boolean {
  return nowMs - lastMessageAt.getTime() >= timeoutMs;
}

export async function registerRealtimeApplication(
  dependencies: RealtimeDependencies
): Promise<RealtimeLifecycle> {
  const {
    infrastructure: {
      app,
      registry,
      logger,
      config,
      worldLookup,
      telemetry,
      captureTelemetryPlayerSnapshot,
      captureBugReportContext
    },
    authority: {
      gameState,
      flagService,
      playerService,
      auth,
      nativeAppAuthorization,
      worldRuntime,
      flagAccess
    },
    capabilities: {
      collectibles,
      harvestSessions,
      dungeonResourceHarvest,
      balsamResin,
      fieldConsumables,
      resourceVisionJobs,
      droppedItems,
      combat,
      developerSpawnedMobs,
      developerSpawnedPlants,
      developerSpawnedDungeons,
      goblinVillage,
      hollinHuts,
      mapMarkers,
      wanderingMerchants,
      cinderLanterns,
      combatProfiles,
      progression,
      equipment,
      backpacks,
      cities,
      chats,
      kingdoms,
      market,
      classes,
      skills,
      specializations,
      partyAuthority,
      partyCombatPublisher,
      partyReadyChecks,
      developmentEconomy,
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
      simpleFood,
      jewelStation,
      achievements,
      salon,
      salonRuntime,
      travelInvites,
      directMessages,
      recentPlayers,
      repeatableResources,
      inventory,
      databasePool,
      inventoryProtection,
      starterInventory,
      masteries,
      worldMap,
      pets,
      givingSaplings,
      dogCompanions,
      minions,
      playerPackages,
      playerGifts,
      glimmerShop,
      wallet,
      premiumWallet,
      dungeon,
      dungeonSkills,
      dungeonTorchLobbies,
      playerLocations,
      portals,
      xoralEvents,
      overworldBossParticipantLeases,
      legendaryBirdEvents,
      creatureBook,
      biomeDiscovery,
      locationReports,
      landActions,
      altDoorway,
      settlement,
      relocationGate,
      hostileGate,
      pvpStatus,
      destinationAnchors,
      trustArrivals
    } = {},
    operations: { persistRuntimePlayers, populationV2, settleAndRespawnPlayer } = {}
  } = dependencies;
  const maximumPayloadBytes = config?.WS_MAX_PAYLOAD_BYTES ?? DEFAULT_WS_MAX_PAYLOAD_BYTES;
  const ipMarketLimiter = new MarketNetworkRateLimiter();
  const websocketOptions = {
    maxPayload: config?.BUG_REPORTS_ENABLED
      ? Math.max(maximumPayloadBytes, BUG_REPORT_WIRE_MAX_BYTES)
      : maximumPayloadBytes,
    closeTimeout: 1_000
  };
  await app.register(websocketPlugin, {
    options: websocketOptions,
    errorHandler(error, socket, request) {
      logger.error(
        { err: error, path: request.url },
        "websocket connection handler failed"
      );
      socket.close(1011, "websocket initialization failed");
    }
  });
  const kingdomChatGate = new KingdomChatRateGate();
  const classRealtimeState = new ClassRealtimeState();
  const partyRealtimeState = new PartyRealtimeState();
  const developerRealtimeState = new DeveloperRealtimeState();
  const manorRealtimeState = new ManorRealtimeState();
  const socialRealtimeState = new SocialRealtimeState();
  const travelRuntimeState = new TravelRuntimeState();
  const playerAuthorityFence = new PlayerAuthorityFence();
  if (worldRuntime && combat && inventory && databasePool && playerLocations) {
    worldRuntime.configureDruidReplenish(new DruidReplenishService(
      databasePool, inventory, combat, playerAuthorityFence, playerLocations
    ));
  }
  if (worldRuntime && combat && inventory && databasePool && wallet) {
    worldRuntime.configureMerchantMaximizeTactics(new MerchantMaximizeTacticsService({
      pool: databasePool, inventory, wallet, combat, fence: playerAuthorityFence
    }));
  }
  const waterTravel = inventory && databasePool && worldLookup
    ? new WaterTravelService({
        pool: databasePool, inventory, worldLookup, gameState, logger,
        hasFullWaterSpeed: (playerId) => combat?.hasTidewaterDraught(playerId) === true
      })
    : undefined;
  const waterSites = inventory && databasePool
    ? new WaterSiteService({
        pool: databasePool,
        inventory,
        worldLookup,
        gameState,
        turnIn: dungeonSkills ? (playerId, skillId, requestId) => dungeonSkills.turnIn(playerId, skillId, requestId) : undefined,
        logger
      })
    : undefined;
  // Other players see each player's active class (PlayerSnapshot.classId) from the combat runtime.
  gameState.setPlayerClassIdResolver(combat ? (classPlayerId) => combat.playerActiveSpecializationId(classPlayerId) : null);
  if (waterTravel) {
    // Keeps land mobs off the water and water mobs in it, from the cached path surfaces.
    combat?.setMobSurfaceLookup({
      surfaceAt: (position) => waterTravel.cachedSurfaceNear(position),
      prewarm: (from, to) => waterTravel.prewarmMobLine(from, to)
    });
    // Shore guard: unrafted players never step onto a cached water cell (docs/plans/water-shore.md).
    gameState.setWaterSurfaceLookup((point) => waterTravel.cachedSurfaceAt(point));
    gameState.onWorldArrival((arrivingPlayerId) => {
      void waterTravel.refreshArrival(arrivingPlayerId).catch((error: unknown) => {
        logger.warn({ err: error, playerId: arrivingPlayerId }, "water arrival check failed");
      });
    });
    gameState.setCombatApproachPlanner(
      (approachingPlayerId, target) => waterTravel.planCombatApproach(approachingPlayerId, target),
      (blockedPlayerId) => {
        // Called from inside the combat step: cancel after it finishes.
        queueMicrotask(() => {
          combat?.cancelAttack(blockedPlayerId);
          registry.send(blockedPlayerId, {
            type: "COMBAT_CANCELLED",
            requestId: `raft-approach:${Date.now()}`,
            entityId: blockedPlayerId
          });
          registry.send(blockedPlayerId, {
            type: "ERROR",
            code: "RAFT_REQUIRED_FOR_APPROACH",
            message: "You need a raft to reach that target."
          });
        });
      }
    );
  }
  const connectionGenerations = new ConnectionGenerationLedger();
  const travelPhase2TaskTimeoutMs =
    config?.RESOURCE_ENVIRONMENT_BATCH_TIMEOUT_MS ??
    DEFAULT_TRAVEL_PHASE_2_TASK_TIMEOUT_MS;
  const connectionCloseRegistry = new ConnectionCloseRegistry();
  const liveSessionRevalidators = new Map<() => Promise<boolean>, string>();
  const bootstrapAttempts = new BootstrapAttemptCoordinator({
    timeoutMs: config?.WS_BOOTSTRAP_TIMEOUT_MS ?? DEFAULT_WS_BOOTSTRAP_TIMEOUT_MS,
    logger,
    onMetricsChanged(metrics) {
      securityMetrics.bootstrapAttemptsStarted = metrics.attemptsStarted;
      securityMetrics.bootstrapAttemptsCancelled = metrics.attemptsCancelled;
      securityMetrics.bootstrapAttemptsTimedOut = metrics.attemptsTimedOut;
      securityMetrics.staleBootstrapRejections = metrics.staleAttemptRejections;
      securityMetrics.bootstrapRegistryHandoffs = metrics.registryHandoffs;
      securityMetrics.bootstrapWelcomesSent = metrics.welcomesSent;
      securityMetrics.unexpectedCrossAccountReplacements =
        metrics.unexpectedCrossAccountReplacements;
    }
  });
  let shuttingDown = false;
  const reconnectLeases = new ReconnectLeaseCoordinator({
    graceMs: config?.RECONNECT_GRACE_MS ?? DEFAULT_RECONNECT_GRACE_MS,
    worldPresenceMs:
      config?.LINKDEAD_WORLD_PRESENCE_MS ?? DEFAULT_LINKDEAD_WORLD_PRESENCE_MS,
    logger
  });
  const harvestReconnectLeases = new ReconnectLeaseCoordinator({
    graceMs: HARVEST_RECONNECT_GRACE_MS,
    worldPresenceMs: HARVEST_RECONNECT_GRACE_MS,
    logger
  });
  const harvestSessionScavenger =
    typeof harvestSessions?.expireStaleActiveSessions === "function"
      ? setInterval(() => {
          void harvestSessions.expireStaleActiveSessions()
            .then((cleaned) => {
              if (cleaned > 0) {
                logger.info(
                  { cleaned },
                  "stale active harvest sessions cleaned"
                );
              }
            })
            .catch((error: unknown) => {
              logger.warn({ err: error }, "stale harvest session scavenging failed");
            });
        }, HARVEST_SESSION_SCAVENGE_INTERVAL_MS)
      : null;
  harvestSessionScavenger?.unref?.();
  const heartbeatTimeoutMs =
    config?.WS_HEARTBEAT_TIMEOUT_MS ?? DEFAULT_WS_HEARTBEAT_TIMEOUT_MS;
  const heartbeatSweep = setInterval(() => {
    const now = Date.now();
    for (const connection of registry.records()) {
      if (!isWebSocketHeartbeatExpired(connection.lastMessageAt, now, heartbeatTimeoutMs)) {
        continue;
      }
      logger.warn(
        { closeCategory: "heartbeat-timeout", idleMs: now - connection.lastMessageAt.getTime() },
        "closing stale websocket"
      );
      connection.socket.close(1011, "heartbeat timeout");
    }
  }, config?.WS_HEARTBEAT_SWEEP_MS ?? DEFAULT_WS_HEARTBEAT_SWEEP_MS);
  heartbeatSweep.unref?.();
  const cityConstructionSupervisor = cities?.structures
    ? setInterval(() => {
        void cities.structures!.reconcileDueConstruction()
          .then(async (completed) => {
            for (const completion of completed) {
              const nextActive =
                await cities.structures!.activeConstructionForPlayer(
                  completion.actorPlayerId
                );
              if (!nextActive) {
                gameState.setMovementBlocked(
                  completion.actorPlayerId,
                  false,
                  "city-construction"
                );
              }
              if (
                completion.structure.type === "city_house" ||
                completion.structure.type === "mayor_house"
              ) {
                registry.broadcast({
                  type: "CITY_HOUSE_CHANGED",
                  requestId: completion.requestId,
                  structure: completion.structure,
                  membership: completion.membership,
                  replayed: false
                });
                if (completion.structure.ownerPlayerId) {
                  registry.send(completion.structure.ownerPlayerId, {
                    type: "CITY_MEMBERSHIP_SNAPSHOT",
                    membership: completion.membership
                  });
                  registry.broadcast({
                    type: "SOCIAL_STATE_CHANGED",
                    playerId: completion.structure.ownerPlayerId
                  });
                }
              } else {
                registry.broadcast({
                  type: "CITY_FACILITY_CHANGED",
                  requestId: completion.requestId,
                  structure: completion.structure,
                  ...(completion.droppedItems
                    ? { droppedItems: completion.droppedItems }
                    : {})
                });
                if (completion.inventory) {
                  registry.send(completion.actorPlayerId, {
                    type: "PLAYER_RESOURCES_UPDATED",
                    playerId: completion.actorPlayerId,
                    inventory: completion.inventory,
                    serverTime: Date.now()
                  });
                }
                if (completion.structure.type === "oil_well") {
                  registry.send(completion.actorPlayerId, {
                    type: "OWNER_OIL_WELL_PROJECTION",
                    structure: completion.structure.state === "active"
                      ? completion.structure
                      : null
                  });
                }
                if (completion.structure.type === "monument") {
                  await cities.districtBenefits.refreshCityRuntime(
                    completion.structure.cityId
                  );
                }
              }
            }
          })
          .catch((error: unknown) => {
            logger.warn({ err: error }, "city construction reconciliation failed");
          });
      }, 1_000)
    : null;
  cityConstructionSupervisor?.unref?.();
  const militaryIndustrySupervisor = cities?.militaryIndustry
    ? setInterval(() => {
        const military = cities.militaryIndustry!;
        const followingPlayers = gameState.playerIds().flatMap((playerId) => {
          const player = gameState.getPlayer(playerId);
          if (!player) return [];
          return [{
            playerId: player.playerId,
            position: player.position,
            target: player.target,
            online: player.online,
            worldPresent: gameState.isWorldPresent(player.playerId)
          }];
        });
        const followTick = typeof military.reconcileFollowingMilitaryGroups === "function"
          ? military.reconcileFollowingMilitaryGroups(followingPlayers, 1)
          : Promise.resolve(0);
        const packingTick = typeof military.reconcileDueMilitarySiegePacking === "function"
          ? military.reconcileDueMilitarySiegePacking()
          : Promise.resolve(0);
        // War Camps whose 1 h burn ended are removed; owners get a fresh snapshot.
        void (military.warCamps?.reconcileBurnedOutWarCamps() ?? Promise.resolve([] as string[]))
          .then(async (ownerIds: string[]) => {
            for (const ownerId of ownerIds) {
              const owner = gameState.getPlayer(ownerId);
              if (!owner?.online) continue;
              registry.send(ownerId, {
                type: "MILITARY_INDUSTRY_STATE",
                requestId: `war-camp-burned:${Date.now()}:${ownerId}`,
                snapshot: await military.snapshot(ownerId, owner)
              }, "replaceable");
            }
          })
          .catch((error: unknown) => {
            logger.warn({ err: error }, "war camp burn reconciliation failed");
          });
        void Promise.all([
          military.reconcileDueTrainingJobs(),
          military.reconcileDueRecovery(),
          military.reconcileDueRallies(),
          military.reconcileDueBomberDemolitions(),
          military.reconcileDueBallistaVolleys(),
          followTick,
          packingTick
        ]).then(async ([, , , bomberChanged, ballistaChanged, followingChanged, packingChanged]) => {
          const reconciledBallistaFlagIds = typeof military.takeReconciledBallistaFlagIds === "function"
            ? military.takeReconciledBallistaFlagIds()
            : [];
          const reconciledCityStructureIds = typeof military.takeReconciledCityStructureIds === "function"
            ? military.takeReconciledCityStructureIds()
            : [];
          if (reconciledCityStructureIds.length > 0 && cities.structures) {
            await broadcastCityStructureWarfare(cities.structures, registry, reconciledCityStructureIds);
          }
          const reconciledBallistaVolleyCues = typeof military.takeReconciledBallistaVolleyCues === "function"
            ? military.takeReconciledBallistaVolleyCues()
            : [];
          const reconciledBomberDetonationCues = typeof military.takeReconciledBomberDetonationCues === "function"
            ? military.takeReconciledBomberDetonationCues()
            : [];
          if (reconciledBallistaFlagIds.length > 0) {
            const revisionMetadata = await flagSetRevisionMetadata(flagService);
            await Promise.all([...new Set(reconciledBallistaFlagIds)].map(async (flagId) => {
              const flag = await flagService.getMapFlag(flagId);
              if (!flag) {
                registry.broadcast({ type: "FLAG_DELETED", flagId, reason: "destroyed", ...revisionMetadata });
                return;
              }
              registry.broadcast({ type: "FLAG_UPDATED", flag, ...revisionMetadata });
            }));
          }
          if (
            bomberChanged + ballistaChanged + followingChanged + packingChanged <= 0 &&
            reconciledBallistaVolleyCues.length === 0 && reconciledBomberDetonationCues.length === 0
          ) return;
          // Military snapshots are owner-scoped; refresh connected world
          // players after a server tick changes a followed group.
          await Promise.all(gameState.playerIds().map(async (playerId) => {
            const player = gameState.getPlayer(playerId);
            if (!player?.online || !gameState.isWorldPresent(playerId)) return;
            const snapshot = await military.snapshot(playerId, player);
            const siegeVolleys = reconciledBallistaVolleyCues
              .filter((entry) => entry.playerId === playerId)
              .map((entry) => entry.cue);
            const bomberDetonations = reconciledBomberDetonationCues
              .filter((entry) => entry.playerId === playerId)
              .map((entry) => entry.cue);
            registry.send(playerId, {
              type: "MILITARY_INDUSTRY_STATE",
              requestId: `military-tick:${Date.now()}:${playerId}`,
              snapshot,
              ...(siegeVolleys.length > 0 ? { siegeVolleys } : {}),
              ...(bomberDetonations.length > 0 ? { bomberDetonations } : {})
            }, bomberDetonations.length > 0 ? "critical" : "replaceable");
          }));
        }).catch((error: unknown) => {
          logger.warn({ err: error }, "military industry reconciliation failed");
        });
      }, 1_000)
    : null;
  militaryIndustrySupervisor?.unref?.();
  const furnaceConstructionSupervisor = furnaces
    ? setInterval(() => {
        void furnaces.reconcileDueBuilds()
          .then(async ({ completed, cancelled }) => {
            for (const completion of completed) {
              gameState.setMovementBlocked(
                completion.playerId,
                false,
                "furnace-construction"
              );
              registry.send(completion.playerId, {
                type: "FURNACE_BUILD_RESULT",
                requestId: completion.requestId,
                furnace: completion.furnace,
                inventory: completion.inventory,
                replayed: false
              });
            }
            for (const cancellation of cancelled) {
              gameState.setMovementBlocked(
                cancellation.playerId,
                false,
                "furnace-construction"
              );
              registry.send(cancellation.playerId, {
                type: "FURNACE_BUILD_CANCELLED",
                requestId: cancellation.requestId,
                buildId: cancellation.buildId,
                inventory: cancellation.inventory,
                droppedItems: cancellation.droppedItems,
                message: "Furnace construction was cancelled because its placement was no longer valid."
              });
            }
            if (completed.length > 0) {
              await Promise.all(registry.activePlayerIds().map(async (activePlayerId) => {
                const player = gameState.getPlayer(activePlayerId);
                if (!player || !gameState.isWorldPresent(activePlayerId)) return;
                registry.send(activePlayerId, {
                  type: "FURNACES_SNAPSHOT",
                  furnaces: await furnaces.listNear(player)
                });
              }));
            }
          })
          .catch((error: unknown) => {
            logger.warn({ err: error }, "Furnace construction reconciliation failed");
          });
      }, 250)
    : null;
  furnaceConstructionSupervisor?.unref?.();
  const tanneryConstructionSupervisor = tanneries
    ? setInterval(() => {
        void tanneries.reconcileDueBuilds()
          .then(async ({ completed, cancelled }) => {
            for (const completion of completed) {
              gameState.setMovementBlocked(completion.playerId, false, "tannery-construction");
              registry.send(completion.playerId, {
                type: "TANNERY_BUILD_RESULT", requestId: completion.requestId,
                tannery: completion.tannery, inventory: completion.inventory, replayed: false
              });
            }
            for (const cancellation of cancelled) {
              gameState.setMovementBlocked(cancellation.playerId, false, "tannery-construction");
              registry.send(cancellation.playerId, {
                type: "TANNERY_BUILD_CANCELLED", requestId: cancellation.requestId,
                buildId: cancellation.buildId, inventory: cancellation.inventory,
                droppedItems: cancellation.droppedItems,
                message: "Tannery construction was cancelled because its placement was no longer valid."
              });
            }
            if (completed.length > 0) {
              await Promise.all(registry.activePlayerIds().map(async (activePlayerId) => {
                const player = gameState.getPlayer(activePlayerId);
                if (!player || !gameState.isWorldPresent(activePlayerId)) return;
                registry.send(activePlayerId, {
                  type: "TANNERIES_SNAPSHOT", tanneries: await tanneries.listNear(player)
                });
              }));
            }
          })
          .catch((error: unknown) => {
            logger.warn({ err: error }, "Tannery construction reconciliation failed");
          });
      }, 250)
    : null;
  tanneryConstructionSupervisor?.unref?.();
  const loomConstructionSupervisor = looms
    ? setInterval(() => {
        void looms.reconcileDueBuilds()
          .then(async ({ completed, cancelled }) => {
            for (const completion of completed) {
              gameState.setMovementBlocked(completion.playerId, false, "loom-construction");
              registry.send(completion.playerId, {
                type: "LOOM_BUILD_RESULT", requestId: completion.requestId,
                loom: completion.loom, inventory: completion.inventory, replayed: false
              });
            }
            for (const cancellation of cancelled) {
              gameState.setMovementBlocked(cancellation.playerId, false, "loom-construction");
              registry.send(cancellation.playerId, {
                type: "LOOM_BUILD_CANCELLED", requestId: cancellation.requestId,
                buildId: cancellation.buildId, inventory: cancellation.inventory,
                droppedItems: cancellation.droppedItems,
                message: "Loom construction was cancelled because its placement was no longer valid."
              });
            }
            if (completed.length > 0) {
              await Promise.all(registry.activePlayerIds().map(async (activePlayerId) => {
                const player = gameState.getPlayer(activePlayerId);
                if (!player || !gameState.isWorldPresent(activePlayerId)) return;
                registry.send(activePlayerId, {
                  type: "LOOMS_SNAPSHOT", looms: await looms.listNear(player)
                });
              }));
            }
          })
          .catch((error: unknown) => {
            logger.warn({ err: error }, "Loom construction reconciliation failed");
          });
      }, 250)
    : null;
  loomConstructionSupervisor?.unref?.();
  const kitchenConstructionSupervisor = kitchens
    ? setInterval(() => {
        void kitchens.reconcileDueBuilds()
          .then(async ({ completed, cancelled }) => {
            for (const completion of completed) {
              gameState.setMovementBlocked(completion.playerId, false, "kitchen-construction");
              registry.send(completion.playerId, {
                type: "KITCHEN_BUILD_RESULT", requestId: completion.requestId,
                kitchen: completion.kitchen, inventory: completion.inventory, replayed: false
              });
            }
            for (const cancellation of cancelled) {
              gameState.setMovementBlocked(cancellation.playerId, false, "kitchen-construction");
              registry.send(cancellation.playerId, {
                type: "KITCHEN_BUILD_CANCELLED", requestId: cancellation.requestId,
                buildId: cancellation.buildId, inventory: cancellation.inventory,
                droppedItems: cancellation.droppedItems,
                message: "Kitchen construction was cancelled because its placement was no longer valid."
              });
            }
            if (completed.length > 0) {
              await Promise.all(registry.activePlayerIds().map(async (activePlayerId) => {
                const player = gameState.getPlayer(activePlayerId);
                if (!player || !gameState.isWorldPresent(activePlayerId)) return;
                registry.send(activePlayerId, {
                  type: "KITCHENS_SNAPSHOT", kitchens: await kitchens.listNear(player)
                });
              }));
            }
          })
          .catch((error: unknown) => {
            logger.warn({ err: error }, "Kitchen construction reconciliation failed");
          });
      }, 250)
    : null;
  kitchenConstructionSupervisor?.unref?.();
  const greenhouseConstructionSupervisor = greenhouses
    ? setInterval(() => {
      void Promise.all([
          greenhouses.reconcileDueBuilds(),
          greenhouses.reconcileDuePlants()
        ]).then(async ([builds, transitions]) => {
          const { completed, cancelled } = builds;
          for (const completion of completed) {
            gameState.setMovementBlocked(completion.playerId, false, "greenhouse-construction");
            registry.send(completion.playerId, {
              type: "GREENHOUSE_BUILD_RESULT",
              requestId: completion.requestId,
              greenhouse: completion.greenhouse,
              inventory: completion.inventory,
              replayed: false
            });
          }
          for (const cancellation of cancelled) {
            gameState.setMovementBlocked(cancellation.playerId, false, "greenhouse-construction");
            registry.send(cancellation.playerId, {
              type: "GREENHOUSE_BUILD_CANCELLED",
              requestId: cancellation.requestId,
              buildId: cancellation.buildId,
              inventory: cancellation.inventory,
              droppedItems: cancellation.droppedItems,
              message: cancellation.message
            });
          }
          if (transitions.length > 0 && greenhouseRuntime) {
            const changedGreenhouses = new Set(transitions.map((transition) => transition.greenhouseId));
            await Promise.all(registry.activePlayerIds().map(async (activePlayerId) => {
              const session = greenhouseRuntime.get(activePlayerId);
              if (!session || !changedGreenhouses.has(session.greenhouseId)) return;
              const player = gameState.getPlayer(activePlayerId);
              if (!player) return;
              try {
                const connectionId = registry.activeConnectionIdForPlayer(activePlayerId);
                const connection = connectionId ? registry.recordForConnection(connectionId) : null;
                const state = await greenhouses.snapshot(player, session.greenhouseId);
                registry.send(activePlayerId, {
                  type: "GREENHOUSE_STATE",
                  requestId: `greenhouse-stage-transition:${Date.now()}`.slice(0, 128),
                  state: await greenhouseStateForCropCapableClient(
                    state,
                    connection?.greenhouseCropCatalogVersion,
                    connection?.greenhouseCropPackId
                  )
                });
              } catch (error) {
                logger.warn({ err: error, playerId: activePlayerId, greenhouseId: session.greenhouseId }, "failed to publish greenhouse stage transition");
              }
            }));
          }
          if (completed.length > 0) {
            await Promise.all(registry.activePlayerIds().map(async (activePlayerId) => {
              const player = gameState.getPlayer(activePlayerId);
              if (!player || !gameState.isWorldPresent(activePlayerId)) return;
              registry.send(activePlayerId, {
                type: "GREENHOUSES_SNAPSHOT",
                greenhouses: await greenhouses.listNear(player)
              });
            }));
          }
        }).catch((error: unknown) => logger.warn({ err: error }, "Greenhouse reconciliation failed"));
      }, 250)
    : null;
  greenhouseConstructionSupervisor?.unref?.();
  const fishingConstructionSupervisor = fishing
    ? setInterval(() => {
        void fishing.reconcileDueBuilds()
          .then(async ({ completed, cancelled }) => {
            for (const completion of completed) {
              gameState.setMovementBlocked(completion.playerId, false, "fishing-construction");
              registry.send(completion.playerId, {
                type: "FISHING_HUT_BUILD_RESULT", requestId: completion.requestId,
                fishingHut: completion.hut, inventory: completion.inventory, replayed: false
              });
            }
            for (const cancellation of cancelled) {
              gameState.setMovementBlocked(cancellation.playerId, false, "fishing-construction");
              registry.send(cancellation.playerId, {
                type: "FISHING_HUT_BUILD_CANCELLED", requestId: cancellation.requestId,
                buildId: cancellation.buildId, inventory: cancellation.inventory,
                droppedItems: cancellation.droppedItems, message: "Fishing Hut construction was cancelled because its placement was no longer valid."
              });
            }
            if (completed.length > 0) {
              await Promise.all(registry.activePlayerIds().map(async (activePlayerId) => {
                const player = gameState.getPlayer(activePlayerId);
                if (!player || !gameState.isWorldPresent(activePlayerId)) return;
                registry.send(activePlayerId, { type: "FISHING_HUTS_SNAPSHOT", fishingHuts: await fishing.listNear(player) });
              }));
            }
          })
          .catch((error: unknown) => logger.warn({ err: error }, "Fishing Hut construction reconciliation failed"));
      }, 250)
    : null;
  fishingConstructionSupervisor?.unref?.();
  // Territory collapse waves: announce each fallen city / kingdom once, then
  // break one bounded batch of due flags per tick and publish it as one frame.
  const territoryCollapsePool = (flagService as Partial<Pick<FlagService, "databasePool">>).databasePool;
  const territoryCollapse = territoryCollapsePool
    ? new TerritoryCollapseService(territoryCollapsePool, {
        city: async (id, reason, actorPlayerId) => cities
          ? cities.deactivateCity(id, "destroyed", { actorPlayerId, collapseReason: reason })
          : null,
        kingdom: (id, reason, actorPlayerId) =>
          endKingdomWithCollapse(territoryCollapsePool, id, actorPlayerId, reason)
      })
    : null;
  let territoryCollapseTickRunning = false;
  const territoryCollapseSupervisor = territoryCollapse ? setInterval(() => {
    if (territoryCollapseTickRunning) return;
    territoryCollapseTickRunning = true;
    const announceTerritoryCollapses = async (): Promise<void> => {
      for (const announcement of await territoryCollapse.claimAnnouncements()) {
        publishTerritoryCollapseStarted(registry, {
          collapseId: announcement.collapseId,
          kind: announcement.kind,
          name: announcement.displayName,
          reason: announcement.reason,
          flagCount: announcement.flagCount,
          playerIds: announcement.notifyPlayerIds
        });
        if (announcement.kind === "kingdom") {
          for (const playerId of announcement.notifyPlayerIds) {
            registry.send(playerId, { type: "KINGDOM_STATE_CHANGED", playerId });
          }
        } else if (cities) {
          await cities.districtBenefits.refreshCityRuntime(announcement.id);
          for (const playerId of announcement.notifyPlayerIds) {
            registry.send(playerId, {
              type: "CITY_MEMBERSHIP_SNAPSHOT",
              membership: await cities.getMembership(playerId)
            });
          }
          await Promise.all(registry.records().map(async (record) => {
            const player = gameState.getPlayer(record.playerId);
            if (!player) return;
            registry.sendToConnection(record.connectionId, {
              type: "CITIES_SNAPSHOT",
              cities: await cities.listCitiesNear(player.anchor)
            });
          }));
        }
      }
    };
    void (async () => {
      // Burnt-out or destroyed city / kingdom structures: a City Center or
      // Castle starts the collapse (announced below); an ordinary flag breaks
      // with the flags it alone connected. Each stage is isolated so a failure
      // in one never blocks the announcements or the due collapse batches.
      try {
        const fallen = await settleFallenOrganizationStructures(territoryCollapsePool!, territoryCollapse);
        for (const failure of fallen.failures) {
          logger.warn({ err: failure.error, flagId: failure.flagId }, "fallen organization structure did not settle");
        }
        // A Castle in rubble keeps its kingdom: members refresh their kingdom
        // state (perks off, rebuild / disband offer); stats follow through the
        // kingdom perk scheduler.
        for (const ruined of fallen.ruinedCastles) {
          logger.info({ kingdomId: ruined.kingdomId, flagId: ruined.flagId }, "castle fell to rubble");
          for (const playerId of ruined.notifyPlayerIds) {
            registry.send(playerId, { type: "KINGDOM_STATE_CHANGED", playerId });
          }
        }
        if (fallen.brokenFlagIds.length > 0) {
          publishBrokenFlags(registry, {
            flagIds: fallen.brokenFlagIds,
            collapseId: null,
            reason: "structure_destroyed",
            completed: true,
            ...await flagSetRevisionMetadata(flagService)
          });
        }
      } catch (error) {
        logger.warn({ err: error }, "organization structure fall sweep failed");
      }
      try {
        await announceTerritoryCollapses();
      } catch (error) {
        logger.warn({ err: error }, "territory collapse announcements failed");
      }
      const batches = await territoryCollapse.breakDueBatch();
      if (batches.length === 0) return;
      const revision = await flagSetRevisionMetadata(flagService);
      for (const batch of batches) {
        publishBrokenFlags(registry, {
          flagIds: batch.flagIds,
          collapseId: batch.collapseId,
          reason: batch.reason,
          completed: batch.completed,
          ...revision
        });
        if (batch.completed) {
          logger.info(
            { collapseId: batch.collapseId, kind: batch.kind, id: batch.id },
            "territory collapse completed"
          );
        }
      }
    })()
      .catch((error: unknown) => {
        logger.warn({ err: error }, "territory collapse tick failed");
      })
      .finally(() => {
        territoryCollapseTickRunning = false;
      });
  }, TERRITORY_COLLAPSE_TICK_MS) : null;
  territoryCollapseSupervisor?.unref?.();
  // Flag abandonment (daily): personal flags of owners unseen for 30 days are
  // removed like destroyed flags. Bounded batches; idempotent across servers.
  // Also runs a few minutes after start so frequent restarts cannot starve it.
  let flagAbandonmentRunning = false;
  const runFlagAbandonment = (): void => {
    if (!territoryCollapsePool || flagAbandonmentRunning) return;
    flagAbandonmentRunning = true;
    void (async () => {
      for (let batch = 0; batch < 20; batch += 1) {
        const result = await abandonInactiveOwnerFlags(territoryCollapsePool, { limit: 100 });
        for (const failure of result.failures) {
          logger.warn({ err: failure.error, flagId: failure.flagId }, "abandoned flag did not settle");
        }
        if (result.abandonedFlagIds.length > 0) {
          logger.info({ count: result.abandonedFlagIds.length }, "abandoned flags of inactive owners removed");
          publishBrokenFlags(registry, {
            flagIds: result.abandonedFlagIds,
            collapseId: null,
            reason: "flag_abandoned",
            completed: true,
            ...await flagSetRevisionMetadata(flagService)
          });
        }
        if (result.abandonedFlagIds.length + result.failures.length < 100) break;
      }
    })()
      .catch((error: unknown) => {
        logger.warn({ err: error }, "flag abandonment sweep failed");
      })
      .finally(() => {
        flagAbandonmentRunning = false;
      });
  };
  const flagAbandonmentKickoff = setTimeout(runFlagAbandonment, 5 * 60 * 1_000);
  flagAbandonmentKickoff.unref?.();
  const flagAbandonmentSupervisor = setInterval(runFlagAbandonment, FLAG_ABANDONMENT_SWEEP_INTERVAL_MS);
  flagAbandonmentSupervisor.unref?.();
  // Towers shoot: one spatial query per uniform attack interval finds the
  // nearest hostile player / Siege / Bomber within range of each armed tower.
  const towerVolleyPool = (flagService as Partial<Pick<FlagService, "databasePool">>).databasePool;
  const towerVolleys = towerVolleyPool && combat
    ? new TowerVolleyService(towerVolleyPool, {
        hitPlayer: (input) => combat.applyTowerAttack(input),
        // Forward Sappers: War Towers of a kingdom with the perk hit harder.
        warTowerAttackBonus: (kingdomIds) => forwardSappersWarTowerBonus(towerVolleyPool, kingdomIds),
        ...(cities?.militaryIndustry
          ? {
              hitGroup: (input: Readonly<{ groupId: string; damage: number }>) =>
                cities.militaryIndustry!.applyTowerHitToGroup(input.groupId, input.damage),
              groupHit: async (ownerPlayerId: string) => {
                const owner = gameState.getPlayer(ownerPlayerId);
                if (!owner?.online || !gameState.isWorldPresent(ownerPlayerId)) return;
                registry.send(ownerPlayerId, {
                  type: "MILITARY_INDUSTRY_STATE",
                  requestId: `tower-volley:${Date.now()}:${ownerPlayerId}`,
                  snapshot: await cities.militaryIndustry!.snapshot(ownerPlayerId, owner)
                }, "replaceable");
              }
            }
          : {})
      })
    : null;
  const towerVolleySupervisor = towerVolleys ? setInterval(() => {
    const players = gameState.playerIds().flatMap((playerId) => {
      const player = gameState.getPlayer(playerId);
      if (!player?.online || !gameState.isWorldPresent(playerId) || !combat!.isPlayerAlive(playerId)) return [];
      return [{ playerId, lat: player.position.lat, lon: player.position.lon }];
    });
    void towerVolleys.tick(players).catch((error: unknown) => {
      logger.warn({ err: error }, "tower volley tick failed");
    });
  }, TOWER_VOLLEY_TICK_MS) : null;
  towerVolleySupervisor?.unref?.();
  const cityLifecycleSupervisor = cities?.structures
    ? setInterval(() => {
        void cities.structures!.reconcileExpiredFounderClaimDeadlines()
          .then(async (expiredCityIds) => {
            if (expiredCityIds.length === 0) return;
            await Promise.all(registry.records().map(async (record) => {
              const player = gameState.getPlayer(record.playerId);
              if (!player) return;
              registry.sendToConnection(record.connectionId, {
                type: "CITIES_SNAPSHOT",
                cities: await cities.listCitiesNear(player.anchor)
              });
              registry.sendToConnection(record.connectionId, {
                type: "CITY_STRUCTURES_SNAPSHOT",
                structures: await cities.structures!.listNear(
                  player.position,
                  CITY_STRUCTURE_SNAPSHOT_RADIUS_M
                )
              });
            }));
          })
          .catch((error: unknown) => {
            logger.warn({ err: error }, "city founder claim reconciliation failed");
          });
      }, 30_000)
    : null;
  cityLifecycleSupervisor?.unref?.();
  // City building warfare (war part C3): a repair runs only while its city
  // member stays online, alive, still and beside the building; burnt-out and
  // fallen buildings are destroyed here.
  let cityBuildingWarfareRunning = false;
  const cityBuildingWarfareSupervisor = cities?.structures
    ? setInterval(() => {
        if (cityBuildingWarfareRunning) return;
        cityBuildingWarfareRunning = true;
        const structures = cities.structures!;
        void structures.reconcileBuildingWarfare((playerId, building) => {
          const player = gameState.getPlayer(playerId);
          return Boolean(
            player?.online &&
            player.target === null &&
            gameState.isWorldPresent(playerId) &&
            (!combat || combat.isPlayerAlive(playerId)) &&
            distanceMeters(player.position, building) <=
              STRUCTURE_WARFARE_INTERACTION_RADIUS_M + building.footprintRadiusM
          );
        })
          .then(async (result) => {
            await broadcastCityStructureWarfare(structures, registry, result.changedStructureIds);
            for (const destruction of result.destroyed) {
              registry.broadcast({
                type: "CITY_FACILITY_CHANGED",
                requestId: `city-war-destroyed:${destruction.structure.structureId}`,
                structure: destruction.structure
              });
              if (destruction.membershipEnded && destruction.ownerPlayerId) {
                registry.send(destruction.ownerPlayerId, {
                  type: "CITY_MEMBERSHIP_SNAPSHOT",
                  membership: await cities.getMembership(destruction.ownerPlayerId)
                });
              }
            }
          })
          .catch((error: unknown) => {
            logger.warn({ err: error }, "city building warfare reconciliation failed");
          })
          .finally(() => {
            cityBuildingWarfareRunning = false;
          });
      }, STRUCTURE_WARFARE_REPAIR_TICK_MS)
    : null;
  cityBuildingWarfareSupervisor?.unref?.();
  // Manor warfare (houses): an owner repair runs only while the owner stays
  // online, alive, still and beside the Manor; burnt-down Manors settle at 0
  // health (never deleted).
  let manorWarfareRunning = false;
  const manorWarfareSupervisor = manorPresence
    ? setInterval(() => {
        if (manorWarfareRunning) return;
        manorWarfareRunning = true;
        const manors = manorPresence;
        void manors.reconcileManorWarfare((playerId, manor) => {
          const player = gameState.getPlayer(playerId);
          return Boolean(
            player?.online &&
            player.target === null &&
            gameState.isWorldPresent(playerId) &&
            (!combat || combat.isPlayerAlive(playerId)) &&
            distanceMeters(player.position, manor) <= STRUCTURE_WARFARE_INTERACTION_RADIUS_M
          );
        })
          .then(async (result) => {
            for (const manorId of result.changedManorIds) {
              const manor = await manors.builtManor(manorId);
              if (manor) registry.broadcast({ type: "MANOR_WORLD_UPDATED", manor });
            }
          })
          .catch((error: unknown) => {
            logger.warn({ err: error }, "manor warfare reconciliation failed");
          })
          .finally(() => {
            manorWarfareRunning = false;
          });
      }, STRUCTURE_WARFARE_REPAIR_TICK_MS)
    : null;
  manorWarfareSupervisor?.unref?.();
  app.addHook("onClose", async () => {
    if (harvestSessionScavenger) clearInterval(harvestSessionScavenger);
    clearInterval(heartbeatSweep);
    if (cityConstructionSupervisor) clearInterval(cityConstructionSupervisor);
    if (militaryIndustrySupervisor) clearInterval(militaryIndustrySupervisor);
    if (furnaceConstructionSupervisor) clearInterval(furnaceConstructionSupervisor);
    if (tanneryConstructionSupervisor) clearInterval(tanneryConstructionSupervisor);
    if (loomConstructionSupervisor) clearInterval(loomConstructionSupervisor);
    if (kitchenConstructionSupervisor) clearInterval(kitchenConstructionSupervisor);
    if (greenhouseConstructionSupervisor) clearInterval(greenhouseConstructionSupervisor);
    if (cityLifecycleSupervisor) clearInterval(cityLifecycleSupervisor);
    if (cityBuildingWarfareSupervisor) clearInterval(cityBuildingWarfareSupervisor);
    if (manorWarfareSupervisor) clearInterval(manorWarfareSupervisor);
    if (territoryCollapseSupervisor) clearInterval(territoryCollapseSupervisor);
    clearTimeout(flagAbandonmentKickoff);
    clearInterval(flagAbandonmentSupervisor);
    if (towerVolleySupervisor) clearInterval(towerVolleySupervisor);
  });

  const runIndependentBootstrap = async (
    subsystem: string,
    connectionId: string,
    playerId: string,
    operation: () => void | Promise<void>
  ): Promise<void> => {
    await runIndependentBootstrapTask({
      subsystem,
      connectionId,
      playerId,
      releaseSha: config?.RUNTIME_SHA ?? null,
      logger,
      operation
    });
  };

  const bootstrapChat = createChatBootstrap({
    chats,
    registry,
    logger,
    config,
    socialRealtimeState
  });
  let publishRecoveredPopulationPresentation = (
    _relocation: ScheduledPopulationV2Relocation
  ): void => { void _relocation; };
  const populationOperations = createPopulationRealtimeOperations({
    config,
    logger,
    registry,
    connectionGenerations,
    gameState,
    worldRuntime,
    combat,
    equipment,
    populationV2,
    travelRuntimeState,
    onPresentationRelocation: (relocation) => {
      publishRecoveredPopulationPresentation(relocation);
    }
  });
  const {
    schedulePopulationV2RelocationForActivePlayer,
    currentWorldViewAuthority,
    requestPopulationResync,
    beginSmoothTravelTransition,
    endSmoothTravelTransition,
    markSmoothTravelTransitionPhase,
    armCommittedTravelTransitionWatchdog,
    reservePopulationV2CurrentArea,
    waitForRelocationPopulationV2
  } = populationOperations;
  const {
    sendToGameplayCirclesContaining,
    sendCombatScopeSnapshot,
    gameplayInterestCenter,
    gameplayInterestZoneIds,
    syncCombatPlayerAfterRelocation,
    activeHarvestSessionForPlayer,
    sendCollectiblesForPlayer,
    sendDroppedItemsForPlayer,
    refreshDroppedItemsNear,
    travelInboxEntriesForPlayer,
    sendTravelInboxForPlayers,
    sendTravelResourceVisionReadyAndSnapshot
  } = createRealtimeSnapshotOperations({
    logger,
    registry,
    landActions,
    settlement,
    connectionGenerations,
    gameState,
    worldRuntime,
    combat,
    collectibles,
    droppedItems,
    harvestSessions,
    repeatableResources,
    travelInvites,
    playerService,
    currentGameplayViewCircle: (playerId) =>
      dungeon?.gameplayViewCircle(playerId) ?? gameState.getGameplayViewCircle(playerId),
    currentWorldViewAuthority
  });
  publishRecoveredPopulationPresentation = (relocation): void => {
    void publishStartupPresentationCombatSnapshot({
      relocation,
      onRejected: (reason) => {
        logger.warn({
          playerId: relocation.playerId,
          connectionId: relocation.connectionId,
          connectionGeneration: relocation.connectionGeneration,
          relocationRevision: relocation.relocationRevision,
          populationPreparationGeneration:
            relocation.preparationGeneration ?? 0,
          reason
        }, "recovered presentation combat snapshot rejected");
      },
      sendCombatScopeSnapshot
    }).catch((error: unknown) => {
      logger.warn(
        {
          err: error,
          playerId: relocation.playerId,
          connectionId: relocation.connectionId,
          connectionGeneration: relocation.connectionGeneration,
          relocationRevision: relocation.relocationRevision,
          populationPreparationGeneration:
            relocation.preparationGeneration ?? 0
        },
        "recovered population presentation combat snapshot failed"
      );
    });
  };
  const sendFlagSnapshotForPlayer = async (
    playerId: string,
    isCurrent: () => boolean = () => true
  ): Promise<void> => {
    if (config?.FLAG_SCOPED_SNAPSHOT_ENABLED !== true) return;
    const connectionId = registry.activeConnectionIdForPlayer(playerId);
    const connectionGeneration = connectionGenerations.current(playerId);
    if (
      !connectionId
      || connectionGeneration === undefined
      || !registry.connectionSupports(
        connectionId,
        "scoped-flag-snapshots"
      )
      || !registry.connectionSupports(
        connectionId,
        "viewport-flag-loading-v1"
      )
    ) return;
    await publishFlagSnapshot({
      state: { playerId, connectionId, connectionGeneration },
      playerId,
      registry,
      gameState,
      flagService,
      scopedSnapshotsEnabled: true,
      isCurrent
    });
  };
  if (typeof flagService.reconcileZeroHealthFlags === "function") {
    const retired = await flagService.reconcileZeroHealthFlags();
    if (retired.length > 0) {
      const revisionMetadata = await flagSetRevisionMetadata(flagService);
      for (const result of retired) {
        registry.broadcast({
          type: "FLAG_DELETED",
          flagId: result.flagId,
          reason: "deleted",
          ...revisionMetadata
        });
      }
    }
  }
  const {
    flagBuilds,
    flagHardenings,
    flagBurns,
    flagRepairs,
    flagArrivalReservations
  } = createFlagRealtimeOperations({
    config,
    logger,
    registry,
    gameState,
    playerService,
    connectionGenerations,
    flagService,
    collectibles,
    combat,
    worldRuntime,
    playerAuthorityFence,
    resourceVisionJobs,
    masteries,
    inventory,
    populationV2,
    sendToGameplayCirclesContaining,
    schedulePopulationV2RelocationForActivePlayer,
    syncCombatPlayerAfterRelocation,
    sendCombatScopeSnapshot,
    sendCollectiblesForPlayer,
    sendTravelResourceVisionReadyAndSnapshot
  });
  flagBurns.startReconciliation();
  const cityFlagConversions = createCityFlagConversionRealtimeOperations({
    config,
    logger,
    registry,
    cities,
    flagService
  });
  const {
    refreshAuthoritativePlayerStats,
    stageEquipmentSnapshot,
    resolvePveMaxHealth
  } = createCombatEquipmentRealtimeOperations({
    combat,
    progression,
    equipment,
    classes,
    skills,
    kingdoms
  });
  const cancelPendingManorEntry = createCancelPendingManorEntry({
    manorRealtimeState,
    gameState,
    registry,
    worldRuntime
  });
  const {
    resolveFlagTravelDestination,
    reserveTravelArrivals,
    sendCityScopeForPlayer,
    prepareWorldMapTravelPopulation,
    prepareVisibleFlagVisitPopulation,
    cancelVisibleFlagVisitPopulation,
    cancelWorldMapTravelPopulation,
    releaseSoftTravelPopulationConnection,
    closeSoftTravelPopulation,
    applyAuthoritativeTravelPhase1,
    performAuthoritativeTravel,
    sendTravelFailure,
    followPartyLeader
  } = createTravelRealtimeOperations({
    config,
    altDoorway,
    destinationAnchors,
    trustArrivals,
    onTravelCommitted: pets ? (travellerId) => {
      void pets.ownerForPlayer(travellerId)
        .then((owner) => owner ? pets.shaveForTravel(owner) : null)
        .then((result) => { if (result) dogCompanions?.sync(travellerId, result.active); })
        .catch((error: unknown) => logger.warn({ err: error, playerId: travellerId }, "pet travel shave failed"));
    } : undefined,
    logger,
    registry,
    gameState,
    worldRuntime,
    combat,
    telemetry,
    flagService,
    flagAccess,
    flagBuilds,
    flagArrivalReservations,
    playerService,
    partyAuthority,
    classRealtimeState,
    xoralEvents,
    legendaryBirdEvents,
    partyRealtimeState,
    playerAuthorityFence,
    connectionGenerations,
    populationV2,
    cities,
    worldMap,
    travelInvites,
    collectibles,
    resourceVisionJobs,
    droppedItems,
    manorPresence,
    travelPhase2TaskTimeoutMs,
    cancelPendingManorEntry,
    gameplayInterestCenter,
    gameplayInterestZoneIds,
    syncCombatPlayerAfterRelocation,
    schedulePopulationV2RelocationForActivePlayer,
    authoritativeChallengeProfile: (playerId) =>
      equipment?.runtimeSnapshot(playerId)?.derivedStats.challengeProfile,
    activeHarvestSessionForPlayer,
    beginSmoothTravelTransition,
    endSmoothTravelTransition,
    markSmoothTravelTransitionPhase,
    armCommittedTravelTransitionWatchdog,
    waitForRelocationPopulationV2,
    sendDroppedItemsForPlayer,
    sendCombatScopeSnapshot,
    sendCollectiblesForPlayer,
    sendFlagSnapshotForPlayer,
    sendTravelInboxForPlayers,
    sendTravelResourceVisionReadyAndSnapshot
  });
  app.addHook("onClose", async () => {
    flagBurns.stopReconciliation();
    closeSoftTravelPopulation();
  });

  combat?.setExpelHandler(createMetalExpelHandler({
    logger,
    gameState,
    worldRuntime,
    isInsideDungeon: (playerId) => dungeon?.isInside(playerId) === true,
    manorPresence,
    performAuthoritativeTravel,
    syncCombatPlayerAfterRelocation
  }));
  const {
    activePartyMemberOfOwner,
    resolveManorEntryAuthorization,
    sendManorManagementSnapshot,
    authorizePortalManorEntry,
    projectPortalManorEntry,
    projectPortalManorExit,
    enterManorNow,
    forceManorEjection,
    respawnManorOwnerAfterSkinChange,
    enforcePartyManorAccess
  } = createManorRealtimeOperations({
    logger,
    registry,
    gameState,
    worldRuntime,
    combat,
    combatProfiles,
    progression,
    equipment,
    classes,
    classRealtimeState,
    xoralEvents,
    flagBuilds,
    manorPresence,
    manorStorage,
    manorRuntime,
    manorDecorations,
    droppedItems,
    playerLocations,
    portals,
    manorRealtimeState,
    partyAuthority,
    partyRealtimeState,
    travelInvites,
    playerAuthorityFence,
    populationV2,
    connectionGenerations,
    activeHarvestSessionForPlayer,
    cancelPendingManorEntry,
    sendTravelInboxForPlayers,
    refreshAuthoritativePlayerStats,
    reserveTravelArrivals,
    reservePopulationV2CurrentArea,
    sendCityScopeForPlayer,
    sendCollectiblesForPlayer,
    schedulePopulationV2RelocationForActivePlayer
  });
  const {
    projectEntry: projectPortalSalonEntry,
    projectExit: projectPortalSalonExit
  } = createSalonPortalOperations({
    registry,
    gameState,
    salon,
    salonRuntime
  });
  const authenticatedRawSessionTokens = new WeakMap<object, string>();
  const clientReleaseGate = createClientReleaseGate(() =>
    readPublishedVersionMetadata(config?.PUBLIC_RELEASE_METADATA_PATH)
  );
  const outdatedClientRequests = new WeakSet<object>();
  app.get(
    "/ws",
    {
      websocket: true,
      preValidation: async (request, reply) => {
        if (!auth) {
          throw new Error("websocket authentication service is required");
        }
        try {
          auth.assertOrigin(request.headers.origin);
          const ticketSessionToken = nativeAppAuthorization?.rawSessionTokenForProtocols(
            request.headers["sec-websocket-protocol"]
          ) ?? null;
          const rawSessionToken = ticketSessionToken ??
            request.cookies[auth.sessionCookieName] ??
            null;
          const session = await auth.authenticateSession(
            rawSessionToken
          );
          if (!session) {
            throw new AuthError("AUTHENTICATION_REQUIRED", "Authentication required", 401);
          }
          await auth.requireGameplayReady(session);
          request.authSession = session;
          if (rawSessionToken) authenticatedRawSessionTokens.set(request, rawSessionToken);
          if (!(await clientReleaseGate.admitsConnection(clientReleaseIdentityFromQuery(request.query)))) {
            outdatedClientRequests.add(request);
          }
        } catch (error) {
          sendAuthError(reply, error);
        }
      }
    },
    (rawConnection: unknown, request) => {
      const acceptedAtMs = Date.now();
      const socket = normalizeSocket(rawConnection);
      const advertisedProtocol = protocolSupportMetadataFromQuery(request.query);
      const protocolNegotiation = negotiateAshAtlasProtocol(advertisedProtocol);
      const clientReleaseIdentity = clientReleaseIdentityFromQuery(request.query);
      if (
        outdatedClientRequests.has(request) ||
        (
          protocolNegotiation.status !== "compatible-current" &&
          protocolNegotiation.status !== "compatible-legacy"
        )
      ) {
        socket.close(
          ASH_ATLAS_PROTOCOL_INCOMPATIBLE_CLOSE_CODE,
          ASH_ATLAS_PROTOCOL_INCOMPATIBLE_CLOSE_REASON
        );
        return;
      }
      const supportsViewportFlagLoading =
        protocolNegotiation.protocol.capabilities.includes(
          "viewport-flag-loading-v1"
        );
      const negotiatedProtocol = config?.FLAG_SCOPED_SNAPSHOT_ENABLED !== true
        || !supportsViewportFlagLoading
        ? {
            ...protocolNegotiation.protocol,
            capabilities: protocolNegotiation.protocol.capabilities.filter(
              (capability) => capability !== "scoped-flag-snapshots"
            )
          }
        : protocolNegotiation.protocol;
      const authenticatedSession = request.authSession;
      const rawSessionToken = auth
        ? authenticatedRawSessionTokens.get(request) ??
          request.cookies[auth.sessionCookieName] ??
          null
        : null;
      let playerId: string | null = null;
      let connectionId: string | null = null;
      let helloReceived = false;
      let socketClosed = false;
      let socketCloseCode: number | null = null;
      let socketCloseReason = "";
      let closeHandled = false;
      let connectionGeneration: number | null = null;
      let bootstrapAttempt: BootstrapAttempt | null = null;
      let lastSessionValidationAt = Date.now();
      let lastClientReleaseCheckAt = Date.now();
      let clientReleaseCheck: Promise<boolean> | null = null;
      let sessionValidation: Promise<boolean> | null = null;
      let connectionNetwork: ReturnType<AuthService["networkTelemetryForRequest"]> | null = null;
      try {
        connectionNetwork = auth?.networkTelemetryForRequest(request.ip) ?? null;
      } catch (error) {
        logger.warn({ err: error }, "Connection network telemetry could not be derived");
      }
      const marketIpKey = networkRateKey(
        request.ip,
        config?.AUTH_NETWORK_HMAC_KEY ?? "development-only-network-hmac-key-change-me"
      );
      const classRateSubject =
        authenticatedSession?.player?.id ??
        authenticatedSession?.account.id ??
        "unauthenticated";
      const enforcePlayerClassRate = (key: string, maximum: number, windowMs: number): void => {
        classRealtimeState.enforceRate(
          classRateSubject,
          key,
          maximum,
          windowMs,
          isDeveloperClassRateExempt(
            config,
            Boolean(auth?.hasDeveloperCapability(
              authenticatedSession,
              "developer:economy-mutate"
            ))
          )
        );
      };
      const sessionState: SessionConnectionState = {
        get playerId() { return playerId; },
        set playerId(value) { playerId = value; },
        get connectionId() { return connectionId; },
        set connectionId(value) { connectionId = value; },
        get helloReceived() { return helloReceived; },
        set helloReceived(value) { helloReceived = value; },
        get connectionGeneration() { return connectionGeneration; },
        set connectionGeneration(value) { connectionGeneration = value; },
        get socketClosed() { return socketClosed; },
        set socketClosed(value) { socketClosed = value; },
        protocol: negotiatedProtocol,
        protocolMetadataAdvertised: advertisedProtocol !== undefined
      };
      const {
        sendManorsForPlayer,
        sendWorldBootstrapForPlayer,
        broadcastManorSnapshots,
        sendDroppedItemsToSocket,
        broadcastDroppedItems
      } = createConnectionSnapshotOperations({
        state: sessionState,
        registry,
        gameState,
        worldRuntime,
        combat,
        flagService,
        cities,
        manorPresence,
        furnaces,
        tanneries,
        looms,
        kitchens,
        greenhouses,
        fishing,
        collectibles,
        droppedItems,
        schedulePopulationV2Relocation,
        sendCollectiblesForPlayer,
        sendCombatScopeSnapshot,
        sendDroppedItemsForPlayer,
        refreshDroppedItemsNear
      });
      const {
        enqueueWorldCommand,
        runMovementLifecycle,
        awaitCommittedPlayerWorldTransition,
        rejectDuringPlayerWorldTransition,
        requestWorldResync
      } = createConnectionWorldOperations({
        state: sessionState,
        authenticatedSession,
        socket,
        config,
        registry,
        gameState,
        worldRuntime,
        combat,
        logger,
        connectionGenerations,
        playerAuthorityFence,
        sendManorsForPlayer,
        sendCombatScopeSnapshot
      });
      const { applyLiveClassMutationState, applyLiveSkillMutationState } = createConnectionCombatEquipmentOperations({
        socket,
        registry,
        combat,
        progression,
        equipment
      });
      const bootstrapHello = createSessionBootstrap({
        state: sessionState,
        socket,
        landActions,
        settlement,
        hostileGate,
        pvpStatus,
        acceptedAtMs,
        bootstrapAttempts,
        setBootstrapAttempt: (attempt) => {
          bootstrapAttempt = attempt;
        },
        authenticatedSession,
        auth,
        config,
        logger,
        registry,
        connectionGenerations,
        connectionCloseRegistry,
        reconnectLeases,
        harvestReconnectLeases,
        partyRealtimeState,
        playerService,
        gameState,
        flagService,
        flagAccess,
        flagBuilds,
        furnaces,
        tanneries,
        looms,
        kitchens,
        greenhouses,
        greenhouseRuntime,
        fishing,
        cityFlagConversions,
        starterInventory,
        manorPresence,
        manorRuntime,
        salon,
        salonRuntime,
        manorStorage,
        manorDecorations,
        dungeon,
        playerLocations,
        worldRuntime,
        collectibles,
        balsamResin,
        fieldConsumables,
        resourceVisionJobs,
        droppedItems,
        xoralEvents,
        legendaryBirdEvents,
        combat,
        combatProfiles,
        progression,
        achievements,
        equipment,
        backpacks,
        inventoryProtection,
        classes,
        skills,
        cities,
        kingdoms,
        partyAuthority,
        partyCombatPublisher,
        partyReadyChecks,
        dungeonTorchLobbies,
        travelInvites,
        masteries,
        worldMap,
        pets,
        dogCompanions,
        wallet,
        premiumWallet,
        activeHarvestSessionForPlayer,
        activePartyMemberOfOwner,
        bootstrapChat,
        gameplayInterestCenter,
        gameplayInterestZoneIds,
        enqueueWorldCommand,
        handleClose,
        schedulePopulationV2Relocation,
        runIndependentBootstrap,
        sendCollectiblesForPlayer,
        sendCombatScopeSnapshot,
        sendDroppedItemsToSocket,
        sendManorManagementSnapshot,
        sendManorsForPlayer,
        sendTravelInboxForPlayers,
        travelInboxEntriesForPlayer,
        sendTravelResourceVisionReadyAndSnapshot,
        equipmentRuntimeContextFor,
        withEquipmentStats,
        withLiveClassCombatState,
        safeSendServerMessage
      });
      const sessionHandler = createSessionHandler({
        state: sessionState,
        socket,
        registry,
        worldRuntime,
        combat,
        creatureBook,
        biomeDiscovery,
        openWorldPosition: (playerId) => (
          gameState.isWorldPresent(playerId) && !worldRuntime?.hasPlayerWorldTransition(playerId)
            ? gameState.getPlayer(playerId)?.position ?? null
            : null
        ),
        telemetry,
        authSessionId: authenticatedSession?.sessionId ?? null,
        accountRateKey: authenticatedSession?.account.id ?? null,
        captureBugReportContext,
        capturePlayerSnapshot: captureTelemetryPlayerSnapshot,
        bootstrapHello,
        suspendConnection: () => {
          socket.close(1001, "application suspended");
        },
        rejectDuringPlayerWorldTransition,
        requestWorldResync: (requestId, expectedWorldViewAuthority) => {
          requestWorldResync(requestId, expectedWorldViewAuthority);
          if (!sessionState.playerId) return;
          void sendFlagSnapshotForPlayer(
            sessionState.playerId,
            () => Boolean(
              sessionState.playerId
              && sessionState.connectionId
              && registry.isActivePlayerConnection(
                sessionState.playerId,
                sessionState.connectionId
              )
            )
          ).catch((error: unknown) => {
            logger.warn(
              { err: error, playerId: sessionState.playerId },
              "failed to refresh scoped flag snapshot during world resync"
            );
          });
        },
        requestPopulationResync: (message) => {
          if (
            !sessionState.playerId ||
            !sessionState.connectionId ||
            sessionState.connectionGeneration === null
          ) return;
          requestPopulationResync({
            requestId: message.requestId,
            playerId: sessionState.playerId,
            connectionId: message.connectionId,
            connectionGeneration: message.connectionGeneration,
            preparationGeneration: message.preparationGeneration,
            relocationRevision: message.relocationRevision,
            resourceVisionRevision: message.resourceVisionRevision,
            preparationTrigger: message.preparationTrigger,
            preparationScope: message.preparationScope
          });
        }
      });
      const worldGameplayHandler = createWorldGameplayHandler({
        state: sessionState,
        logger,
        dungeon,
        worldLookup,
        gameState,
        worldRuntime,
        flagBuilds,
        flagHardenings,
        flagBurns,
        flagRepairs,
         cancelPendingManorEntry,
         enqueueWorldCommand,
         runMovementLifecycle,
         waterTravel,
         send: (message) => { safeSendServerMessage(socket, message, logger); },
         cancelBomberDemolitionsForMovement: async (movingPlayerId) => {
           await cities?.militaryIndustry?.cancelBomberDemolitionsForMovement(movingPlayerId);
         },
         cancelFurnaceConstructionForMovement: async (movingPlayerId) => {
          const cancelled = await furnaces?.cancelBuildForMovement(movingPlayerId) ?? null;
          if (!cancelled) return;
          gameState.setMovementBlocked(
            movingPlayerId,
            false,
            "furnace-construction"
          );
          registry.send(movingPlayerId, {
            type: "FURNACE_BUILD_CANCELLED",
            requestId: cancelled.requestId,
            buildId: cancelled.buildId,
            inventory: cancelled.inventory,
            droppedItems: cancelled.droppedItems,
            message: "Furnace construction was cancelled by movement."
          });
          if (cancelled.droppedItems.length > 0) await broadcastDroppedItems();
        },
        cancelTanneryConstructionForMovement: async (movingPlayerId) => {
          const cancelled = await tanneries?.cancelBuildForMovement(movingPlayerId) ?? null;
          if (!cancelled) return;
          gameState.setMovementBlocked(movingPlayerId, false, "tannery-construction");
          registry.send(movingPlayerId, {
            type: "TANNERY_BUILD_CANCELLED", requestId: cancelled.requestId,
            buildId: cancelled.buildId, inventory: cancelled.inventory,
            droppedItems: cancelled.droppedItems,
            message: "Tannery construction was cancelled by movement."
          });
          if (cancelled.droppedItems.length > 0) await broadcastDroppedItems();
        },
        cancelLoomConstructionForMovement: async (movingPlayerId) => {
          const cancelled = await looms?.cancelBuildForMovement(movingPlayerId) ?? null;
          if (!cancelled) return;
          gameState.setMovementBlocked(movingPlayerId, false, "loom-construction");
          registry.send(movingPlayerId, {
            type: "LOOM_BUILD_CANCELLED", requestId: cancelled.requestId,
            buildId: cancelled.buildId, inventory: cancelled.inventory,
            droppedItems: cancelled.droppedItems,
            message: "Loom construction was cancelled by movement."
          });
          if (cancelled.droppedItems.length > 0) await broadcastDroppedItems();
        },
        cancelKitchenConstructionForMovement: async (movingPlayerId) => {
          const cancelled = await kitchens?.cancelBuildForMovement(movingPlayerId) ?? null;
          if (!cancelled) return;
          gameState.setMovementBlocked(movingPlayerId, false, "kitchen-construction");
          registry.send(movingPlayerId, {
            type: "KITCHEN_BUILD_CANCELLED", requestId: cancelled.requestId,
            buildId: cancelled.buildId, inventory: cancelled.inventory,
            droppedItems: cancelled.droppedItems,
            message: "Kitchen construction was cancelled by movement."
          });
          if (cancelled.droppedItems.length > 0) await broadcastDroppedItems();
        },
        cancelGreenhouseConstructionForMovement: async (movingPlayerId) => {
          const cancelled = await greenhouses?.cancelBuildForMovement(movingPlayerId) ?? null;
          if (!cancelled) return;
          gameState.setMovementBlocked(movingPlayerId, false, "greenhouse-construction");
          registry.send(movingPlayerId, {
            type: "GREENHOUSE_BUILD_CANCELLED",
            requestId: cancelled.requestId,
            buildId: cancelled.buildId,
            inventory: cancelled.inventory,
            droppedItems: cancelled.droppedItems,
            message: cancelled.message
          });
          if (cancelled.droppedItems.length > 0) await broadcastDroppedItems();
        },
        cancelGreenhouseWaterFillForMovement: async (movingPlayerId) => {
          const player = gameState.getPlayer(movingPlayerId);
          if (!player || !greenhouses) return;
          if (!greenhouses.mayHaveActiveWaterFill(movingPlayerId)) return;
          try {
            const cancelled = await greenhouses.cancelWaterBucketFill(
              player,
              `greenhouse-fill-movement:${randomUUID()}`
            );
            if (cancelled.active) {
              registry.send(movingPlayerId, {
                type: "GREENHOUSE_WATER_FILL_RESULT",
                requestId: `greenhouse-fill-movement:${movingPlayerId}`,
                gallons: cancelled.creditedGallons,
                waterBucketGallons: cancelled.waterBucketGallons,
                inventory: cancelled.inventory,
                replayed: false
              });
            }
          } catch (error) {
            logger.warn({ err: error, playerId: movingPlayerId }, "failed to cancel greenhouse water fill on movement");
          }
        },
        cancelFishingConstructionForMovement: async (movingPlayerId) => {
          const cancelled = await fishing?.cancelBuildForMovement(movingPlayerId) ?? null;
          if (!cancelled) return;
          gameState.setMovementBlocked(movingPlayerId, false, "fishing-construction");
          registry.send(movingPlayerId, {
            type: "FISHING_HUT_BUILD_CANCELLED", requestId: cancelled.requestId,
            buildId: cancelled.buildId, inventory: cancelled.inventory,
            droppedItems: cancelled.droppedItems,
            message: "Fishing Hut construction was cancelled by movement."
          });
          if (cancelled.droppedItems.length > 0) await broadcastDroppedItems();
        },
        cancelFishingForMovement: async (movingPlayerId) => {
          const cancelled = await fishing?.cancelForMovement(movingPlayerId) ?? null;
          if (!cancelled) return;
          gameState.setGatheringActivity(movingPlayerId, null);
          gameState.setMovementBlocked(movingPlayerId, false, "fishing");
        },
        cancelCityConstructionForMovement: async (movingPlayerId) => {
          const cancelled = await cities?.structures?.cancelConstructionForMovement(
            movingPlayerId
          ) ?? null;
          if (!cancelled) return;
          gameState.setMovementBlocked(
            movingPlayerId,
            false,
            "city-construction"
          );
          const cancellationRequestId = `city-build-cancel:${cancelled.structure.structureId}`;
          if (
            cancelled.structure.type === "city_house" ||
            cancelled.structure.type === "mayor_house"
          ) {
            registry.broadcast({
              type: "CITY_HOUSE_CHANGED",
              requestId: cancellationRequestId,
              structure: cancelled.structure,
              membership: null,
              replayed: false,
              ...(cancelled.droppedItems ? { droppedItems: cancelled.droppedItems } : {})
            });
          } else {
            registry.broadcast({
              type: "CITY_FACILITY_CHANGED",
              requestId: cancellationRequestId,
              structure: cancelled.structure,
              ...(cancelled.droppedItems ? { droppedItems: cancelled.droppedItems } : {})
            });
          }
          if (cancelled.structure.type === "oil_well") {
            registry.send(movingPlayerId, {
              type: "OWNER_OIL_WELL_PROJECTION",
              structure: null
            });
          }
          if (cancelled.structure.type === "monument") {
            await cities!.districtBenefits.refreshCityRuntime(
              cancelled.structure.cityId
            );
          }
          if (cancelled.inventory) {
            registry.send(movingPlayerId, {
              type: "PLAYER_RESOURCES_UPDATED",
              playerId: movingPlayerId,
              inventory: cancelled.inventory,
              serverTime: Date.now()
            });
          }
        },
        cancelCityFlagConversionForMovement: (movingPlayerId) => {
          cityFlagConversions?.cancelPlayer(movingPlayerId, "movement");
        }
      });
      const flagHandler = createFlagHandler({
        state: sessionState,
        logger,
        socket,
        authenticatedSession,
        landActions,
        altDoorway,
        hostileGate,
        gameState,
        flagBuilds,
        flagHardenings,
        flagBurns,
        flagRepairs,
        flagService,
        broadcastFlagUpdate: async (flag) => {
          registry.broadcast({ type: "FLAG_UPDATED", flag, ...await flagSetRevisionMetadata(flagService) });
        },
        rejectDuringPlayerWorldTransition,
        sendCombatError
      });
      const travelHandler = createTravelHandler({
        state: sessionState,
        socket,
        authenticatedSession,
        config,
        logger,
        registry,
        gameState,
        flagService,
        flagAccess,
        playerService,
        worldRuntime,
        combat,
        cities,
        kingdoms,
        travelInvites,
        worldMap,
        hollinHuts,
        recordedTravelTarget: mapMarkers ? (id, locationId) => mapMarkers.recordedTravelTarget(id, locationId) : undefined,
        takeOpenLandGrant: dogCompanions ? (id) => dogCompanions.takeOpenLandGrant(id) : undefined,
        classRealtimeState,
        xoralEvents,
        flagBuilds,
        flagRepairs,
        locationReports,
        settlement,
        relocationGate,
        connectionNetwork,
        connectionIp: request.ip,
        clientPlatform: clientReleaseIdentity.platform,
        activeHarvestSessionForPlayer,
        beginSmoothTravelTransition,
        endSmoothTravelTransition,
        followPartyLeader,
        gameplayInterestCenter,
        gameplayInterestZoneIds,
        resolveFlagTravelDestination,
        reserveTravelArrivals,
        prepareVisibleFlagVisitPopulation,
        cancelVisibleFlagVisitPopulation,
        prepareWorldMapTravelPopulation,
        cancelWorldMapTravelPopulation,
        performAuthoritativeTravel,
        safeSendServerMessage,
        schedulePopulationV2RelocationForActivePlayer,
        sendCityScopeForPlayer,
        sendCollectiblesForPlayer,
        sendCombatError,
        sendCombatScopeSnapshot,
        sendDroppedItemsToSocket,
        sendManorsForPlayer,
        sendTravelInboxForPlayers,
        syncCombatPlayerAfterRelocation,
        waitForRelocationPopulationV2
      });
      const settlementHandler = createSettlementHandler({
        state: sessionState,
        socket,
        authenticatedSession,
        auth,
        landActions,
        hostileGate,
        destinationAnchors,
        registry,
        gameState,
        flagService,
        progression,
        equipment,
        goblinVillage,
        hollinHuts,
        mapMarkers,
        wanderingMerchants,
        cinderLanterns,
        cities,
        combat,
        cityFlagConversions,
        chats,
        kingdoms,
        worldMap,
        playerAuthorityFence,
        refreshAuthoritativePlayerStats,
        safeSendServerMessage
      });
      const partyHandler = createPartyHandler({
        state: sessionState,
        socket,
        authenticatedSession,
        altDoorway,
        clientPlatform: clientReleaseIdentity.platform,
        registry,
        gameState,
        worldRuntime,
        partyAuthority,
        partyCombatPublisher,
        partyReadyChecks,
        chats,
        combat,
        pvpTimerActive: (playerId) => pvpStatus?.hasTimers?.(playerId) ?? false,
        manorPresence,
        manorRuntime,
        travelInvites,
        recentPlayers,
        overworldBossParticipantLeases,
        partyRealtimeState,
        playerAuthorityFence,
        applyAuthoritativeTravelPhase1,
        beginSmoothTravelTransition,
        endSmoothTravelTransition,
        enforcePartyManorAccess,
        enterManorNow,
        performAuthoritativeTravel,
        resolveFlagTravelDestination,
        resolveManorEntryAuthorization,
        safeSendServerMessage,
        sendCombatError,
        sendTravelFailure,
        sendTravelInboxForPlayers,
        waitForRelocationPopulationV2
      });
      const manorHandler = createManorHandler({
        state: sessionState,
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
        fishingEquipment: equipment,
        jewelStation,
        travelInvites,
        worldMap,
        manorRealtimeState,
        playerAuthorityFence,
        authenticatedSession,
        landActions,
        altDoorway,
        hostileGate,
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
        sendTravelInboxForPlayers
      });
      const salonHandler = createSalonHandler({
        state: sessionState,
        socket,
        registry,
        gameState,
        salon,
        salonRuntime,
        equipment,
        enforcePlayerClassRate
      });
      const dungeonHandler = createDungeonHandler({
        state: sessionState,
        registry,
        gameState,
        dungeon,
        dungeonSkills,
        torchLobbies: dungeonTorchLobbies
      });
      if (!playerLocations || !portals || !combat) {
        throw new Error("universal portal services are required");
      }
      const portalEffects = createPortalTransitionEffects({
        logger,
        authenticatedSession,
        registry,
        gameState,
        worldRuntime,
        manorRuntime,
        greenhouseRuntime,
        salonRuntime,
        dungeon,
        combat,
        combatProfiles,
        classes,
        flagBuilds,
        populationV2,
        connectionGenerations,
        connectionId: () => sessionState.connectionId,
        refreshAuthoritativePlayerStats,
        reservePopulationV2CurrentArea,
        schedulePopulationV2RelocationForActivePlayer,
        waitForRelocationPopulationV2,
        sendWorldBootstrapForPlayer
      });
      const portalHandler = createPortalHandler({
        cinderLanterns,
        state: sessionState,
        socket,
        registry,
        gameState,
        locations: playerLocations,
        portals,
        playerAuthorityFence,
        worldRuntime,
        manorRuntime,
        greenhouseRuntime,
        salonRuntime,
        dungeon,
        xoralEvents,
        flagRepairs,
        effects: portalEffects,
        authorizeManorEntry: authorizePortalManorEntry,
        authorizeGreenhouseEntry: async (playerId, greenhouseId) => {
          if (!greenhouses) throw new Error("Greenhouses are unavailable.");
          await greenhouses.authorizeEntry(playerId, greenhouseId);
        },
        cancelGreenhouseWaterFill: async (playerId) => {
          const player = gameState.getPlayer(playerId);
          if (player && greenhouses) {
            await greenhouses.cancelWaterBucketFill(player, `greenhouse-fill-portal:${randomUUID()}`);
          }
        },
        projectManorEntry: projectPortalManorEntry,
        projectManorExit: projectPortalManorExit,
        projectSalonEntry: projectPortalSalonEntry,
        projectSalonExit: projectPortalSalonExit,
        projectGreenhouseEntry: async ({ playerId, greenhouseId, position }) => {
          if (!greenhouseRuntime) throw new Error("Greenhouse runtime is unavailable.");
          let session = greenhouseRuntime.get(playerId);
          if (!session) {
            gameState.setWorldPresence(playerId, false);
            session = greenhouseRuntime.enter(playerId, greenhouseId, position);
          }
          registry.send(playerId, {
            type: "GREENHOUSE_POSITION",
            greenhouseSessionId: session.sessionId,
            position: session.position,
            movementSequence: session.movementSequence,
            serverTime: Date.now()
          });
          const player = gameState.getPlayer(playerId);
          if (greenhouses && player) {
            const connectionId = registry.activeConnectionIdForPlayer(playerId);
            const connection = connectionId ? registry.recordForConnection(connectionId) : null;
            const state = await greenhouses.snapshot(player, greenhouseId);
            registry.send(playerId, {
              type: "GREENHOUSE_STATE",
              requestId: "portal-entry",
              state: await greenhouseStateForCropCapableClient(
                state,
                connection?.greenhouseCropCatalogVersion,
                connection?.greenhouseCropPackId
              )
            });
          }
        },
        projectGreenhouseExit: async ({ playerId }) => {
          if (!greenhouseRuntime) throw new Error("Greenhouse runtime is unavailable.");
          const session = greenhouseRuntime.get(playerId);
          if (session) greenhouseRuntime.exit(playerId, session.sessionId);
          gameState.setWorldPresence(playerId, true);
        }
      });
      // Shared by pet strikes and the Ember Bomb: every structure in reach takes the same gated hit.
      const strikeStructuresNear = async ({ origin, radiusM, activationId, damage }: Readonly<{ origin: { lat: number; lon: number }; radiusM: number; activationId: string; damage?: number }>) => {
        const strikerId = sessionState.playerId;
        const striker = strikerId ? gameState.getPlayer(strikerId) : null;
        if (!strikerId || !striker) return { hit: 0, skipped: 0 };
        const accountId = authenticatedSession?.account.id ?? null;
        // Gate failures are not shown per structure; the strike simply skips that structure.
        const quiet = () => undefined;
        let hit = 0;
        let skipped = 0;
        for (const flagId of await flagService.listStructureIdsNear(origin, radiusM)) {
          const landAction = { landActions, accountId, playerId: strikerId, action: "flag_attack" as const, position: striker.position };
          if (!(await landActionAllowed(landAction, socket, activationId, quiet)) ||
            !(await raidAllowed({ altDoorway, hostileGate, accountId, playerId: strikerId, action: "flag_attack", flagId }, socket, activationId, quiet))) {
            skipped += 1;
            continue;
          }
          try {
            const result = await flagService.attackFlag(strikerId, flagId, `${activationId}:${flagId}`, striker, { origin, radiusM, ...(damage !== undefined ? { damage } : {}) });
            noteLandAction(landAction);
            registry.broadcast({ type: "FLAG_UPDATED", flag: result.flag, ...await flagSetRevisionMetadata(flagService) });
            hit += 1;
          } catch {
            skipped += 1;
          }
        }
        return { hit, skipped };
      };
      const harvestingHandler = createHarvestingHandler({
        state: sessionState,
        socket,
        logger,
        registry,
        telemetry,
        authSessionId: authenticatedSession?.sessionId ?? null,
        gameState,
        collectibles,
        harvestSessions,
        hollinHuts,
        dungeonResourceHarvest,
        balsamResin,
        simpleFood,
        fieldConsumables,
        strikeStructures: strikeStructuresNear,
        waterSites,
        travelThroughWhirlpool: async (input) => {
          const result = await performAuthoritativeTravel({
            playerId: input.playerId,
            requestId: input.requestId,
            arrivalMode: "protected_jump",
            kind: "whirlpool",
            destination: { kind: "world", id: null, center: { ...input.destination } },
            chargeTravelHunger: false,
            chargeInTransaction: input.chargeInTransaction
          });
          return result.success ? { success: true } : { success: false, reason: result.reason };
        },
        droppedItems,
        manorRuntime,
        dungeon,
        combat,
        progression,
        equipment,
        repeatableResources,
        inventory,
        playerAuthorityFence,
        playerLocations,
        inventoryProtection,
        xoralEvents,
        broadcastDroppedItems,
        refreshAuthoritativePlayerStats,
        awaitCommittedPlayerWorldTransition,
        rejectDuringPlayerWorldTransition,
        safeSendServerMessage,
        sendCollectiblesForPlayer,
        sendDroppedItemsForPlayer,
        sendToGameplayCirclesContaining,
        removeHarvestedTree: (transition) => {
          if (populationV2?.removeHarvestedTree) {
            populationV2.removeHarvestedTree(transition);
          } else {
            combat?.removeGivingTree(transition.entityId);
          }
        },
        onPlayerTreeChopped: (nodeId) => givingSaplings?.forgetChoppedTree(nodeId)
      });
      const combatEquipmentHandler = createCombatEquipmentHandler({
        dungeonSkills,
        inventory,
        prewarmWaterPath: waterTravel
          ? (approachingPlayerId, target) => waterTravel.prewarmPath(approachingPlayerId, target)
          : undefined,
        state: sessionState,
        socket,
        authenticatedSession,
        landActions,
        hostileGate,
        logger,
        registry,
        gameState,
        worldRuntime,
        combat,
        goblinVillage,
        progression,
        equipment,
        classes,
        skills,
        specializations,
        xoralEvents,
        manorPresence,
        manorRuntime,
        classRealtimeState,
        playerAuthorityFence,
        flagBuilds,
        applyLiveClassMutationState,
        applyLiveSkillMutationState,
        cancelPendingManorEntry,
        enforcePlayerClassRate,
        enqueueWorldCommand,
        refreshAuthoritativePlayerStats,
        recoverPlayerToWorldAnchor: portalHandler.recoverToWorldAnchor,
        respawnsInRoomOnDeath: (playerId) => dungeon?.respawnsInRoomOnDeath(playerId) ?? false,
        settleAndRespawnPlayer,
        safeSendServerMessage,
        sendCombatError,
        stageEquipmentSnapshot,
        resolvePveMaxHealth,
        recenterXoralParticipant: async (participantId, anchor, requestId) => {
          const result = await performAuthoritativeTravel({
            playerId: participantId,
            destination: { kind: "world", id: null, center: anchor },
            requestId,
            arrivalMode: "ordinary_relocation",
            kind: "party_manual",
            chargeTravelHunger: false,
            populationSourceKind: "party-travel",
            sendResult: false
          });
          return result;
        }
      });
      const socialHandler = createSocialHandler({
        state: sessionState,
        socket,
        config,
        logger,
        registry,
        chats,
        authenticatedSession,
        auth,
        kingdoms,
        directMessages,
        kingdomChatGate,
        bootstrapChat,
        safeSendServerMessage,
        sendCombatError
      });
      const marketHandler = createMarketHandler({
        state: sessionState,
        socket,
        authenticatedSession,
        config,
        logger,
        registry,
        market,
        inventory,
        networkKey: marketIpKey,
        networkRateLimiter: ipMarketLimiter,
        recordEdgeRateLimitRejection: () => {
          securityMetrics.edgeMarketRateLimitRejections += 1;
        },
        safeSendServerMessage
      });
      const messageAdmission = createConnectionMessageAdmission({
        state: sessionState,
        socket,
        manorRuntime,
        dungeon,
        marketHandler
      });
      const petHandler = createPetHandler({
        state: sessionState,
        socket,
        authenticatedSession,
        pets,
        petCompanions: dogCompanions,
        isAtGroveHermit: dungeon ? (id) => dungeon.isAtGroveHermit(id) : undefined,
        strikeStructures: strikeStructuresNear,
        logger,
        authorizeDeveloperGrant: auth ? async (command, requestId) => {
          try {
            await auth.authorizeDeveloperCommand(authenticatedSession ?? null, {
              capability: "developer:economy-mutate",
              command,
              transport: "websocket",
              target: sessionState.playerId ?? null,
              operationKey: requestId
            });
            return true;
          } catch {
            return false;
          }
        } : undefined,
        minions,
        groveLoreRank: dungeonSkills
          ? async (id) => { await dungeonSkills.ensureLoaded(id); return dungeonSkills.rankOf(id, "grove_lore"); }
          : undefined,
        sendCombatScopeSnapshot,
        safeSendServerMessage
      });
      const playerPackageHandler = playerPackages
        ? createPlayerPackageHandler({
            state: sessionState,
            socket,
            packages: playerPackages,
            enforcePlayerClassRate,
            safeSendServerMessage
          })
        : () => undefined;
      const playerGiftHandler = playerGifts
        ? createPlayerGiftHandler({
            state: sessionState,
            socket,
            gifts: playerGifts,
            sendToPlayer: (recipientId, frame) => registry.send(recipientId, frame),
            enforcePlayerClassRate,
            safeSendServerMessage,
            logError: (error, messageType) => logger.error({ err: error, messageType }, "player gift command failed")
          })
        : () => undefined;
      const shopHandler = glimmerShop
        ? createShopHandler({
            state: sessionState,
            socket,
            shop: glimmerShop,
            enforcePlayerClassRate,
            safeSendServerMessage,
            logError: (error, messageType) => logger.error({ err: error, messageType }, "glimmer shop command failed")
          })
        : () => undefined;
      const backpackHandler = createBackpackHandler({
        state: sessionState,
        socket,
        authenticatedSession,
        registry,
        backpacks,
        safeSendServerMessage
      });
      const developerHandler = createDeveloperHandler({
        state: sessionState,
        territoryCollapse: territoryCollapse ?? undefined,
        socket,
        authenticatedSession,
        auth,
        chats,
        worldMap,
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
        developerSpawnedPlants,
        developerSpawnedDungeons,
        dungeon,
        goblinVillage,
        hollinHuts,
        greenhouses,
        greenhouseRuntime,
        manorPresence,
        progression,
        equipment,
        cities,
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
      });
      const saplingHandler = createSaplingHandler({
        state: sessionState,
        socket,
        gameState,
        saplings: givingSaplings,
        groveLoreRank: dungeonSkills
          ? async (id) => { await dungeonSkills.ensureLoaded(id); return dungeonSkills.rankOf(id, "grove_lore"); }
          : undefined,
        isAggressive: combat ? (id) => combat.aggressiveUntil(id) !== null : undefined,
        safeSendServerMessage
      });
      const messageRouter = createRealtimeMessageRouter({
        session: sessionHandler,
        worldGameplay: worldGameplayHandler,
        flag: flagHandler,
        travel: travelHandler,
        settlement: settlementHandler,
        party: partyHandler,
        manor: manorHandler,
        salon: salonHandler,
        harvesting: harvestingHandler,
        combatEquipment: combatEquipmentHandler,
        backpack: backpackHandler,
        social: socialHandler,
        market: marketHandler,
        pet: petHandler,
        sapling: saplingHandler,
        packages: playerPackageHandler,
        gifts: playerGiftHandler,
        shop: shopHandler,
        developer: developerHandler,
        dungeon: dungeonHandler,
        portal: portalHandler
      });
      socket.on("message", (data) => {
        const normalized = normalizeRawMessage(data, maximumPayloadBytes);
        const { byteLength } = normalized;
        if (byteLength > maximumPayloadBytes) {
          securityMetrics.oversizedPayloadRejections += 1;
          logger.warn(
            {
              accountId: authenticatedSession?.account.id,
              playerId,
              byteLength,
              maximumPayloadBytes
            },
            "oversized websocket payload rejected"
          );
          socket.close(1009, "payload too large");
          return;
        }
        if (normalized.text === null) {
          socket.close(1009, "payload too large");
          return;
        }
        void handleMessage(normalized.text).catch((error: unknown) => {
          const requestContext = parseRawClientRequestContext(normalized.text!);
          logger.warn(
            {
              err: error,
              accountId: authenticatedSession?.account.id,
              playerId,
              messageType: requestContext.type ?? null
            },
            "websocket request failed"
          );
          safeSendServerMessage(
            socket,
            {
              type: "ERROR",
              ...(requestContext.requestId
                ? { requestId: requestContext.requestId }
                : {}),
              code: "WEBSOCKET_ERROR",
              message: "Request could not be completed"
            },
            logger,
            {
              accountId: authenticatedSession?.account.id,
              playerId,
              connectionId
            }
          );
        });
      });

      const revalidateLiveSession = (): Promise<boolean> => validateLiveSession(true);
      if (auth && authenticatedSession) {
        liveSessionRevalidators.set(revalidateLiveSession, authenticatedSession.account.id);
      }
      socket.on("close", (code, reason) => {
        liveSessionRevalidators.delete(revalidateLiveSession);
        if (liveSessionSweep) clearInterval(liveSessionSweep);
        clearInterval(clientReleaseSweep);
        socketClosed = true;
        socketCloseCode = code;
        socketCloseReason = reason.toString("utf8").slice(0, 123);
        if (bootstrapAttempt) bootstrapAttempts.observeSocketClose(bootstrapAttempt, code);
        void handleClose();
      });

      socket.on("error", (error) => {
        if (bootstrapAttempt) bootstrapAttempts.cancel(bootstrapAttempt, "socket-error");
        logger.warn({ err: error, playerId }, "websocket error");
      });
      const liveSessionSweep = auth
        ? setInterval(() => {
            if (!socketClosed) void validateLiveSession(true);
          }, LIVE_SESSION_RECHECK_INTERVAL_MS)
        : null;
      liveSessionSweep?.unref?.();
      // An idle outdated client sends no messages to trigger the per-message
      // check, so sweep each connection until the gate closes it.
      const clientReleaseSweep = setInterval(() => {
        if (socketClosed || clientReleaseCheck) return;
        lastClientReleaseCheckAt = Date.now();
        const check = clientReleaseGate.admitsLiveConnection(clientReleaseIdentity).then((admitted) => {
          if (!admitted && !socketClosed) {
            socket.close(
              ASH_ATLAS_PROTOCOL_INCOMPATIBLE_CLOSE_CODE,
              ASH_ATLAS_PROTOCOL_INCOMPATIBLE_CLOSE_REASON
            );
          }
          return admitted;
        }).finally(() => {
          if (clientReleaseCheck === check) clientReleaseCheck = null;
        });
        clientReleaseCheck = check;
      }, LIVE_CLIENT_RELEASE_RECHECK_INTERVAL_MS);
      clientReleaseSweep.unref?.();

    async function handleMessage(raw: string): Promise<void> {
      const rawBytes = Buffer.byteLength(raw, "utf8");
      const isBugReport = raw.includes('"BUG_REPORT_SUBMIT"');
      if (!isBugReport && rawBytes > maximumPayloadBytes) {
        socket.close(1009, "message too big");
        return;
      }
      if (isBugReport && rawBytes > BUG_REPORT_WIRE_MAX_BYTES) {
        const requestId = raw.match(
          /"requestId"\s*:\s*"([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})"/iu
        )?.[1];
        if (requestId) {
          safeSendServerMessage(socket, {
            type: "BUG_REPORT_SUBMIT_RESULT",
            requestId,
            success: false,
            code: "BUG_REPORT_TOO_LARGE",
            message: "The diagnostic snapshot is too large. Reopen Report a Bug and retry.",
            retryable: false
          });
        }
        return;
      }
      if (
        auth &&
        (
          sessionValidation ||
          Date.now() - lastSessionValidationAt >= LIVE_SESSION_RECHECK_INTERVAL_MS
        )
      ) {
        if (!(await validateLiveSession())) {
          return;
        }
      }
      if (
        clientReleaseCheck ||
        Date.now() - lastClientReleaseCheckAt >= LIVE_CLIENT_RELEASE_RECHECK_INTERVAL_MS
      ) {
        // Messages that arrive during the check wait for it, preserving order.
        if (!clientReleaseCheck) {
          lastClientReleaseCheckAt = Date.now();
          const check = clientReleaseGate.admitsLiveConnection(clientReleaseIdentity).then((admitted) => {
            if (!admitted) {
              socket.close(
                ASH_ATLAS_PROTOCOL_INCOMPATIBLE_CLOSE_CODE,
                ASH_ATLAS_PROTOCOL_INCOMPATIBLE_CLOSE_REASON
              );
            }
            return admitted;
          }).finally(() => {
            if (clientReleaseCheck === check) clientReleaseCheck = null;
          });
          clientReleaseCheck = check;
        }
        if (!(await clientReleaseCheck)) return;
      }
      if (
        connectionId &&
        authenticatedSession &&
        !registry.isActiveConnection(authenticatedSession.account.id, connectionId)
      ) {
        socket.close(4002, "gameplay connection was replaced");
        return;
      }
      let message;
      try {
        message = parseClientMessage(raw);
      } catch (error) {
        const directMessageRequest = parseInvalidDirectMessageRequest(raw);
        if (directMessageRequest) {
          if (connectionId && directMessages) {
            directMessages.sendInvalidRequest(connectionId, directMessageRequest.requestId);
          } else {
            safeSendServerMessage(socket, {
              type: "DM_ERROR",
              ...(directMessageRequest.requestId
                ? { requestId: directMessageRequest.requestId }
                : {}),
              code: "invalid_request",
              message: "Private messaging request was invalid.",
              retryable: false
            });
          }
          return;
        }
        throw error;
      }
      if (!messageAdmission.admitBeforeTouch(message)) return;
      registry.noteInboundMessage(
        Buffer.byteLength(raw, "utf8"),
        CLIENT_MESSAGE_FAMILIES[message.type]
      );
      const telemetryFamily = selectedTelemetryFamily(message);
      if (
        telemetryFamily &&
        playerId &&
        authenticatedSession &&
        connectionGeneration !== null
      ) {
        telemetry?.recordEvent({
          eventFamily: telemetryFamily,
          eventType: `request_received_${message.type.toLowerCase()}`,
          priority: "routine",
          playerId,
          sessionId: authenticatedSession.sessionId,
          connectionGeneration,
          operationId:
            "requestId" in message && typeof message.requestId === "string"
              ? message.requestId
              : null,
          metadata: { messageType: message.type }
        });
      }
      if (connectionId) {
        registry.touch(connectionId, {
          ping: message.type === "PING",
          messageType: message.type
        });
      }
      if (!messageAdmission.admitAfterTouch(message)) return;
      await messageRouter.dispatch(message);
    }

    function schedulePopulationV2Relocation(
      player: NonNullable<ReturnType<GameState["getPlayer"]>>,
      trigger:
        | "world-entry"
        | "reconnect"
        | "flag-travel"
        | "party-travel"
        | "flag-placement"
        | "separate-space-exit"
        | "administrative-relocation"
        | "explicit-relocation"
    ): ScheduledPopulationV2Relocation | null {
      if (!connectionId || connectionGeneration === null) return null;
      return schedulePopulationV2RelocationForActivePlayer(player.playerId, trigger, {
        connectionId,
        connectionGeneration
      });
    }

    async function handleClose(): Promise<void> {
      if (closeHandled || !connectionId || !playerId || connectionGeneration === null) {
        return;
      }
      closeHandled = true;
      const closingConnectionId = connectionId;
      const closingPlayerId = playerId;
      const closingGeneration = connectionGeneration;
      // Capture the session owned by this socket before any awaited close
      // cleanup. A replacement connection can restore a new session while
      // this handler is awaiting auth/persistence work; terminal cleanup must
      // never accidentally capture or disconnect that newer session.
      const closingGreenhouseSession = greenhouseRuntime?.get(closingPlayerId) ?? null;
      const reconnectEligible =
        !shuttingDown &&
        Boolean(authenticatedSession) &&
        socketCloseCode !== null &&
        [1001, 1006, 1011, 1012, 1013].includes(socketCloseCode);
      if (telemetry && authenticatedSession) {
        const replaced = socketCloseCode === 4002;
        const telemetrySessionId = replaced
          ? telemetry.resolveSessionId(authenticatedSession.sessionId)
          : telemetry.closeSession({
              playerId: closingPlayerId,
              sessionId: authenticatedSession.sessionId,
              connectionGeneration: closingGeneration,
              clean: socketCloseCode === 1000,
              retryable: reconnectEligible,
              closeCode: socketCloseCode,
              closeReasonCategory: websocketCloseCategory(socketCloseCode)
            });
        if (replaced) {
          telemetry.recordEvent({
            eventFamily: "connection",
            eventType: "session_replacement",
            priority: "critical",
            playerId: closingPlayerId,
            sessionId: authenticatedSession.sessionId,
            connectionGeneration: closingGeneration
          });
        } else if (!reconnectEligible) {
          if (captureTelemetryPlayerSnapshot) {
            void Promise.resolve()
              .then(() => captureTelemetryPlayerSnapshot(
                closingPlayerId,
                telemetrySessionId ?? authenticatedSession.sessionId,
                socketCloseCode === 1000 ? "logout" : "terminal_disconnect"
              ))
              .catch(() => undefined);
          }
        }
      }
      const isCurrentClosingGeneration = (): boolean =>
        connectionGenerations.isCurrent(closingPlayerId, closingGeneration) &&
        registry.connectionCountForPlayer(closingPlayerId) === 0;
      releaseSoftTravelPopulationConnection(
        closingConnectionId,
        closingGeneration
      );
      socialRealtimeState.clearConnection(closingConnectionId);
      chats?.disconnect(connectionId);
      await portalHandler.disconnect(closingPlayerId);
      connectionCloseRegistry.remove(closingConnectionId);
      registry.remove(closingConnectionId);
      if (authenticatedSession) {
        try {
          await auth?.recordConnectionEvent(authenticatedSession, "game_connection_closed");
        } catch (error) {
          logger.warn(
            { err: error, playerId: closingPlayerId, connectionId: closingConnectionId },
            "failed to record websocket close event"
          );
        }
      }
      logger.info(
        {
          accountId: authenticatedSession?.account.id,
          playerId: closingPlayerId,
          connectionId: closingConnectionId,
          closeCode: socketCloseCode,
          closeReason: socketCloseReason,
          readyState: socket.readyState,
          serviceUptimeSeconds: process.uptime(),
          releaseSha: config?.RUNTIME_SHA ?? null
        },
        "websocket disconnected"
      );
      if (populationV2) {
        void (async () => {
          await populationV2.releaseConnection({
            playerId: closingPlayerId,
            connectionId: closingConnectionId,
            connectionGeneration: closingGeneration
          });
        })().catch((error: unknown) => {
          logger.warn(
            { err: error, playerId: closingPlayerId },
            "population v2 connection release failed"
          );
        });
      }
      if (!isCurrentClosingGeneration()) {
        return;
      }
      dungeonTorchLobbies?.disconnect(closingPlayerId);
      if (fishing) {
        try {
          if (reconnectEligible) await fishing.markDisconnected(closingPlayerId);
          else await fishing.cancelForDisconnect(closingPlayerId);
        } catch (error) {
          logger.warn({ err: error, playerId: closingPlayerId }, "failed to finalize fishing encounter on disconnect");
        }
      }
      // A reconnect starts idle; gathering poses are republished by the next action.
      gameState.setGatheringActivity(closingPlayerId, null);
      const cancelActiveHarvests = async (reason: string): Promise<void> => {
        let cancellations: Array<() => Promise<unknown>> = [];
        if (typeof harvestSessions?.cancelActiveForPlayer === "function") {
          cancellations.push(() =>
            harvestSessions.cancelActiveForPlayer(closingPlayerId)
          );
        }
        if (dungeonResourceHarvest) {
          dungeonResourceHarvest.cancelActiveForPlayer(closingPlayerId);
        }
        if (typeof repeatableResources?.cancelActiveForPlayer === "function") {
          cancellations.push(() =>
            repeatableResources.cancelActiveForPlayer(closingPlayerId)
          );
        }
        for (let attempt = 1; attempt <= 2 && cancellations.length > 0; attempt += 1) {
          const settled = await Promise.allSettled(
            cancellations.map((cancel) => cancel())
          );
          const retry: Array<() => Promise<unknown>> = [];
          settled.forEach((result, index) => {
            if (result.status === "rejected" && cancellations[index]) {
              retry.push(cancellations[index]!);
              logger.warn({
                err: result.reason,
                playerId: closingPlayerId,
                closingGeneration,
                reason,
                attempt
              }, "active harvest cancellation failed");
            }
          });
          cancellations = retry;
        }
      };
      flagBuilds?.disconnectPlayer(closingPlayerId);
      flagHardenings.disconnectPlayer(closingPlayerId);
      flagBurns.disconnectPlayer(closingPlayerId);
      flagRepairs.disconnectPlayer(closingPlayerId);
      if (!reconnectEligible) {
        await cancelActiveHarvests("terminal-close");
      }
      cancelPendingManorEntry(closingPlayerId);
      const closingPlayer = gameState.getPlayer(closingPlayerId);
      if (closingPlayer && greenhouses) {
        try {
          await greenhouses.cancelWaterBucketFill(
            closingPlayer,
            `greenhouse-fill-disconnect:${randomUUID()}`
          );
        } catch (error) {
          logger.warn({ err: error, playerId: closingPlayerId }, "failed to cancel greenhouse water fill during disconnect");
        }
      }
      const closingManorSession = manorRuntime?.get(closingPlayerId) ?? null;
      manorRuntime?.stop(closingPlayerId);
      // A replaced socket can close after the replacement has restored a new
      // greenhouse session. Do not let stale disconnect cleanup stop that
      // newer session; terminal cleanup below is generation-gated as well.
      if (isCurrentClosingGeneration()) {
        greenhouseRuntime?.stop(closingPlayerId);
      }
      salonRuntime?.remove(closingPlayerId);
      dungeon?.suspend(closingPlayerId);
      combat?.cancelPendingEquipmentCombatUpdates(closingPlayerId);
      const terminalFinalize = async (): Promise<void> => {
        if (!isCurrentClosingGeneration()) return;
        try {
          await fishing?.cancelForDisconnect(closingPlayerId);
        } catch (error) {
          logger.warn({ err: error, playerId: closingPlayerId }, "failed to cancel fishing encounter during terminal disconnect");
        }
        await dungeon?.detachRuntime(closingPlayerId);
        registry.setLinkDeadWorldPresence(closingPlayerId, false);
        if (closingManorSession) {
          await manorRuntime?.disconnect(
            closingPlayerId,
            closingManorSession.sessionId
          );
        }
        if (closingGreenhouseSession) {
          await greenhouseRuntime?.disconnect(
            closingPlayerId,
            closingGreenhouseSession.sessionId
          );
        }
        if (closingManorSession) {
          worldRuntime?.sendManorOccupants(closingManorSession.manorId);
        }
        if (closingManorSession && manorPresence) {
          const closingPresence = await manorPresence.load(closingPlayerId).catch(() => null);
          if (closingPresence) {
            void sendManorManagementSnapshot(
              closingPresence.ownerPlayerId,
              closingPresence.manorId
            ).catch((error: unknown) => {
              logger.warn(
                { err: error, playerId: closingPlayerId },
                "failed to refresh manor occupants after disconnect"
              );
            });
          }
        }
        if (worldRuntime) {
          worldRuntime.revokeConnectionAuthority(closingPlayerId, closingConnectionId);
        } else {
          combat?.disconnectPlayer(closingPlayerId);
          gameState.setWorldPresence(closingPlayerId, false);
          gameState.markOffline(closingPlayerId);
        }
        if (travelInvites) {
          try {
            const durableManorPresence = await manorPresence?.load(closingPlayerId) ?? null;
            const preserveManorInvites = durableManorPresence?.ownerPlayerId === closingPlayerId;
            if (!preserveManorInvites) {
              const affected = await travelInvites.invalidateForInviter(
                closingPlayerId,
                "The inviter disconnected.",
                authenticatedSession ? { sessionId: authenticatedSession.sessionId } : {}
              );
              await sendTravelInboxForPlayers(affected);
            }
          } catch (error) {
            logger.warn(
              { err: error, playerId: closingPlayerId },
              "failed to invalidate Travel Invites after disconnect"
            );
          }
        }
        await worldRuntime?.waitForPlayerWorldTransition(closingPlayerId);
        if (!isCurrentClosingGeneration()) return;
        if (worldRuntime) {
          worldRuntime.revokeConnectionAuthority(closingPlayerId, closingConnectionId);
        } else {
          combat?.disconnectPlayer(closingPlayerId);
          gameState.setWorldPresence(closingPlayerId, false);
          gameState.markOffline(closingPlayerId);
        }
        await equipment?.flushAndRelease(closingPlayerId);
        await achievements?.flushAndRelease(closingPlayerId);
        const persistence = persistRuntimePlayers
          ? null
          : gameState.capturePlayerPersistence(closingPlayerId);
        if (persistRuntimePlayers) await persistRuntimePlayers();
        else await playerService.persistPlayerSnapshot(persistence!.snapshot);
        if (!isCurrentClosingGeneration()) {
          await playerService.markOnline(closingPlayerId);
          return;
        }
        await playerService.markOffline(closingPlayerId);
        if (!isCurrentClosingGeneration()) {
          await playerService.markOnline(closingPlayerId);
          return;
        }
        connectionGenerations.deleteIfCurrent(closingPlayerId, closingGeneration);
        travelRuntimeState.clearPopulationGeneration(closingPlayerId);
        if (persistence) gameState.acknowledgePlayerPersistence(persistence);
      };
      try {
        if (reconnectEligible) {
          registry.setLinkDeadWorldPresence(closingPlayerId, true);
          if (worldRuntime) {
            worldRuntime.suspendConnectionAuthority(closingPlayerId, closingConnectionId);
          } else {
            gameState.stopPlayer(closingPlayerId);
            combat?.suspendPlayerAuthority(closingPlayerId);
          }
          reconnectLeases.start({
            accountId: authenticatedSession!.account.id,
            playerId: closingPlayerId,
            authSessionId: authenticatedSession!.sessionId,
            connectionGeneration: closingGeneration,
            endWorldPresence: () => {
              if (!isCurrentClosingGeneration()) return;
              registry.setLinkDeadWorldPresence(closingPlayerId, false);
              if (worldRuntime) worldRuntime.endLinkDeadWorldPresence(closingPlayerId);
              else {
                combat?.endLinkDeadWorldPresence(closingPlayerId);
                gameState.setWorldPresence(closingPlayerId, false);
              }
            },
            finalize: async () => {
              const telemetrySessionId = telemetry?.resolveSessionId(
                authenticatedSession!.sessionId
              ) ?? authenticatedSession!.sessionId;
              if (captureTelemetryPlayerSnapshot) {
                void Promise.resolve()
                  .then(() => captureTelemetryPlayerSnapshot(
                    closingPlayerId,
                    telemetrySessionId,
                    "terminal_disconnect"
                  ))
                  .catch(() => undefined);
              }
              telemetry?.closeSession({
                playerId: closingPlayerId,
                sessionId: authenticatedSession!.sessionId,
                connectionGeneration: closingGeneration,
                clean: false,
                retryable: false,
                closeCode: socketCloseCode,
                closeReasonCategory: "reconnect_lease_finalized"
              });
              await terminalFinalize();
            }
          });
          harvestReconnectLeases.start({
            accountId: authenticatedSession!.account.id,
            playerId: closingPlayerId,
            authSessionId: authenticatedSession!.sessionId,
            connectionGeneration: closingGeneration,
            endWorldPresence: () => undefined,
            finalize: () => cancelActiveHarvests("harvest-reconnect-expired")
          });
          await worldRuntime?.waitForPlayerWorldTransition(closingPlayerId);
          if (isCurrentClosingGeneration()) {
            const suspensionCheckpoint =
              gameState.capturePlayerPersistence(closingPlayerId);
            await playerService.persistPlayerSnapshot(
              suspensionCheckpoint.snapshot
            );
            if (isCurrentClosingGeneration()) {
              gameState.acknowledgePlayerPersistence(suspensionCheckpoint);
            }
          }
        } else {
          await terminalFinalize();
        }
      } catch (error) {
        logger.warn({ err: error, playerId: closingPlayerId }, "failed to mark player offline");
      }
    }

    async function validateLiveSession(force = false): Promise<boolean> {
      if (!auth) {
        return true;
      }
      if (sessionValidation) {
        return sessionValidation;
      }
      if (
        !force &&
        Date.now() - lastSessionValidationAt < LIVE_SESSION_RECHECK_INTERVAL_MS
      ) {
        return true;
      }
      lastSessionValidationAt = Date.now();
      sessionValidation = (async () => {
        try {
          const current = await auth.authenticateSession(rawSessionToken);
          if (current) {
            await auth.requireGameplayReady(current);
            return true;
          }
          safeSendServerMessage(socket, {
              type: "AUTH_SESSION_INVALID",
              code: "SESSION_EXPIRED",
              message: "Session expired"
            });
        } catch (error) {
          let code:
            | "ACCOUNT_SUSPENDED"
            | "TEST_ACCESS_PENDING"
            | "TEST_ACCESS_DENIED"
            | "TEST_ACCESS_REVOKED"
            | "SESSION_REVOKED" = "SESSION_REVOKED";
          if (
            error instanceof AuthError &&
            (
              error.code === "ACCOUNT_SUSPENDED" ||
              error.code === "TEST_ACCESS_PENDING" ||
              error.code === "TEST_ACCESS_DENIED" ||
              error.code === "TEST_ACCESS_REVOKED"
            )
          ) {
            code = error.code;
          }
          safeSendServerMessage(socket, {
              type: "AUTH_SESSION_INVALID",
              code,
              message: error instanceof AuthError
                ? error.message
                : "Session is no longer valid"
            });
        }
        socket.close(4001, "authentication session invalid");
        return false;
      })();
      try {
        return await sessionValidation;
      } finally {
        sessionValidation = null;
      }
    }
  });
  return {
    /** Developer HTTP teleport: the real world-travel path minus cost and eligibility. */
    async devTeleport(
      playerId: string,
      requestId: string,
      destination: { lat: number; lon: number }
    ): Promise<{ success: true } | { success: false; reason: { code: string; message: string } }> {
      const result = await performAuthoritativeTravel({
        playerId,
        requestId,
        arrivalMode: "ordinary_relocation",
        kind: "dev_teleport",
        destination: { kind: "world", id: null, center: { ...destination } },
        chargeTravelHunger: false,
        skipTravelEligibility: true
      });
      return result.success ? { success: true } : { success: false, reason: result.reason };
    },
    schedulePopulationRelocation(playerId: string): boolean {
      return schedulePopulationV2RelocationForActivePlayer(
        playerId,
        "administrative-relocation"
      ) !== null;
    },
    refreshDroppedItemsNear,
    async finalizeAccountConnections(
      accountId: string,
      code: number,
      reason: string
    ): Promise<void> {
      const connectionIds = registry.records()
        .filter((record) => record.accountId === accountId)
        .map((record) => record.connectionId);
      const handlers = connectionCloseRegistry.handlersFor(connectionIds);
      registry.closeAccountConnections(accountId, code, reason);
      await Promise.allSettled(handlers.map((handler) => handler()));
      await reconnectLeases.finalizeAccount(accountId);
      await harvestReconnectLeases.finalizeAccount(accountId);
    },
    async revalidateLiveSessions(accountId?: string): Promise<void> {
      const revalidations = [...liveSessionRevalidators]
        .filter(([, ownerAccountId]) => accountId === undefined || ownerAccountId === accountId)
        .map(([revalidate]) => revalidate());
      await Promise.allSettled(revalidations);
    },
    async shutdownConnections(): Promise<void> {
      shuttingDown = true;
      bootstrapAttempts.shutdown();
      clearInterval(heartbeatSweep);
      populationOperations.closeScheduling();
      for (const { token: transition, transition: tracked } of
        travelRuntimeState.trackedTransitions()) {
        endSmoothTravelTransition(
          tracked.playerId,
          tracked.requestId,
          transition,
          tracked.committed ? "committed" : "failed",
          "shutdown"
        );
      }
      worldRuntime?.forceReleaseAllPlayerWorldTransitions("shutdown");
      await flagRepairs.shutdown();
      const closeHandlers = connectionCloseRegistry.handlersFor(
        registry.records().map((record) => record.connectionId)
      );
      registry.closeAll(1012, "service restart");
      await Promise.allSettled(closeHandlers.map((handler) => handler()));
      await reconnectLeases.drain();
      await harvestReconnectLeases.drain();
    }
  };
}

function normalizeSocket(rawConnection: unknown): RawSocket {
  if (
    typeof rawConnection === "object" &&
    rawConnection !== null &&
    "socket" in rawConnection
  ) {
    return (rawConnection as { socket: RawSocket }).socket;
  }
  return rawConnection as RawSocket;
}


function parseInvalidDirectMessageRequest(
  raw: string
): { requestId?: string } | null {
  try {
    const candidate: unknown = JSON.parse(raw);
    if (!candidate || typeof candidate !== "object") return null;
    const record = candidate as Record<string, unknown>;
    if (typeof record.type !== "string" || !record.type.startsWith("DM_")) return null;
    return typeof record.requestId === "string" && record.requestId.length > 0 && record.requestId.length <= 128
      ? { requestId: record.requestId }
      : {};
  } catch {
    return null;
  }
}

function parseRawClientRequestContext(
  raw: string
): { requestId?: string; type?: string } {
  try {
    const candidate: unknown = JSON.parse(raw);
    if (!candidate || typeof candidate !== "object") return {};
    const record = candidate as Record<string, unknown>;
    return {
      ...(typeof record.requestId === "string"
        && record.requestId.length > 0
        && record.requestId.length <= 128
        ? { requestId: record.requestId }
        : {}),
      ...(typeof record.type === "string" ? { type: record.type } : {})
    };
  } catch {
    return {};
  }
}

function networkRateKey(address: string | undefined, key: string): string {
  return createHmac("sha256", key).update(address ?? "unknown").digest("hex");
}

function websocketCloseCategory(code: number | null): string {
  if (code === null) return "unknown";
  if (code === 1000) return "normal";
  if (code === 1001) return "going_away";
  if (code === 1006) return "abnormal";
  if (code === 1011) return "server_error";
  if (code === 1012) return "service_restart";
  if (code === 1013) return "retry_later";
  if (code === 4002) return "session_replaced";
  if (code === 4008) return "backpressure";
  return code >= 4000 ? "application" : "protocol_or_network";
}

const SELECTED_TELEMETRY_REQUEST_TYPES = new Set<ClientMessage["type"]>([
  "PLACE_FLAG",
  "CANCEL_FLAG_BUILD",
  "REINFORCE_FLAG",
  "START_HARVEST",
  "COMPLETE_HARVEST",
  "CANCEL_HARVEST",
  "USE_CONSUMABLE",
  "START_ATTACK",
  "CANCEL_ATTACK",
  "USE_NORMAL_ABILITY",
  "USE_RESET_ABILITY",
  "USE_UNIVERSAL_TAUNT",
  "VISIT_FLAG",
  "VISIT_CITY",
  "VISIT_CITY_HOUSE",
  "VISIT_CITY_MARKET",
  "VISIT_CITY_WAREHOUSE",
  "VISIT_WORLD_MAP_CITY",
  "VISIT_WORLD_MAP_ATLAS_SHRINE",
  "VISIT_WORLD_MAP_HOLLIN_HUT",
  "VISIT_OPEN_LAND",
  "VISIT_RECORDED_LOCATION",
  "VISIT_WORLD_MAP_KINGDOM",
  "RELOCATE_TO_CURRENT_LOCATION",
  "LOCATION_FIX",
  "TRAVEL_TO_PARTY_LEADER",
  "FOUND_CITY",
  "JOIN_CITY",
  "LEAVE_CITY",
  "CREATE_PARTY",
  "LEAVE_PARTY",
  "CHAT_SEND",
  "KINGDOM_CHAT_SEND",
  "DM_SEND",
  "MARKET_CREATE_ORDER",
  "MARKET_SIMPLE_BUY",
  "MARKET_CANCEL_ORDER",
  "MARKET_CLAIM"
]);

function selectedTelemetryFamily(
  message: ClientMessage
): "travel" | "harvest" | "combat" | "economy" | "settlement" | "social" | null {
  if (!SELECTED_TELEMETRY_REQUEST_TYPES.has(message.type)) return null;
  const family = CLIENT_MESSAGE_FAMILIES[message.type];
  if (family === "travel") return "travel";
  if (family === "harvesting") return "harvest";
  if (family === "combat-equipment") return "combat";
  if (family === "market") return "economy";
  if (family === "flag" || family === "settlement" || family === "manor") {
    return "settlement";
  }
  if (family === "social" || family === "party") return "social";
  return null;
}

function normalizeRawMessage(
  data: RawData | string,
  maximumPayloadBytes: number
): { byteLength: number; text: string | null } {
  if (typeof data === "string") {
    const byteLength = Buffer.byteLength(data, "utf8");
    return {
      byteLength,
      text: byteLength <= maximumPayloadBytes ? data : null
    };
  }
  if (Array.isArray(data)) {
    const byteLength = data.reduce((total, fragment) => total + fragment.byteLength, 0);
    if (byteLength > maximumPayloadBytes) return { byteLength, text: null };
    const buffer = Buffer.concat(data, byteLength);
    return { byteLength: buffer.byteLength, text: buffer.toString("utf8") };
  }
  if (data instanceof ArrayBuffer) {
    if (data.byteLength > maximumPayloadBytes) {
      return { byteLength: data.byteLength, text: null };
    }
    const buffer = Buffer.from(data);
    return { byteLength: buffer.byteLength, text: buffer.toString("utf8") };
  }
  return {
    byteLength: data.byteLength,
    text: data.byteLength <= maximumPayloadBytes ? data.toString("utf8") : null
  };
}
