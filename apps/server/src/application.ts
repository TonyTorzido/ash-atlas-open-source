import cors from "@fastify/cors";
import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import Fastify from "fastify";
import {
  BASE_PLAYER_MAX_HEALTH,
  CHAT_HUNTING_CHANNEL_KEY,
  SPECIALIZATION_IDS,
  type SpecializationId,
  isSpecializationAvailable,
  classifyFlagPlacementTerrain,
  classProgress,
  DEFAULT_PLAYER_APPEARANCE_CATALOG,
  distanceMeters,
  GRAVE_ECHO_CHANCE,
  projectPlayerAppearance,
  type AchievementSnapshot,
  type BugReportSubmitMessage,
  type DungeonResourceType,
  type ResourceType,
  CHALLENGERS_LANTERN_ATTACK_BONUS,
  CHALLENGERS_LANTERN_DEFENSE_BONUS,
  LEVEL_UP_GLIMMER_FEE
} from "@ash-atlas/shared";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { freemem } from "node:os";

import { installAuthGuard } from "./auth/authGuard.js";
import {
  registerAuthRoutes,
  type AccountConnectionCloser
} from "./auth/authRoutes.js";
import { registerAccountDeletionRoutes } from "./auth/accountDeletionRoutes.js";
import { registerUpdateSubscriberRoutes } from "./http/updateSubscriberRoutes.js";
import { UpdateSubscriberService } from "./http/updateSubscriberService.js";
import { AuthService } from "./auth/authService.js";
import { PostgresAuthStore } from "./auth/authStore.js";
import { AppleAuthService } from "./auth/appleAuth.js";
import { AltDoorwayGate, createSharedNetworkBlock } from "./auth/trust/altDoorway.js";
import { AttestationResolver } from "./auth/trust/attestation/attestationResolver.js";
import { AttestationService } from "./auth/trust/attestation/attestationService.js";
import { PostgresAttestationStore } from "./auth/trust/attestation/attestationStore.js";
import { createDeviceCheckClient } from "./auth/trust/attestation/deviceCheckClient.js";
import { DeviceEnvironmentService, PostgresDeviceEnvironmentStore } from "./auth/trust/attestation/deviceEnvironment.js";
import { createPlayIntegrityDecoder, googleAccessTokenSource } from "./auth/trust/attestation/playIntegrityClient.js";
import { getPopulationGrid } from "./auth/trust/populationGrid.js";
import { createIpGeo } from "./auth/trust/ipGeo.js";
import { DestinationAnchoring } from "./auth/trust/anchoring.js";
import { DestinationAnchorGate, PostgresDestinationAnchorStore } from "./auth/trust/destinationAnchorGate.js";
import { HostileActionGate, PostgresHostileGateStore } from "./auth/trust/hostileGate.js";
import { PostgresTrustArrivalStore, TrustArrivalLog } from "./auth/trust/trustArrivals.js";
import { RelocationGate } from "./auth/trust/relocationGate.js";
import { TrustLab } from "./auth/trust/trustLab.js";
import { AccountLinkMonitor, PostgresAccountLinkStore } from "./auth/trust/accountLinks.js";
import { LocationHistoryMonitor, PostgresLocationHistoryStore } from "./auth/trust/stateHopping.js";
import { PostgresSettlementStore, SettlementService } from "./auth/trust/settlement.js";
import { PostgresTrustAlertStore } from "./auth/trust/trustAlerts.js";
import { PostgresTrustAdminOpsStore, TrustAdminOps } from "./auth/trust/trustAdminOps.js";
import { LandActionGate, LocationReportService, TrustService } from "./auth/trust/trustService.js";
import {
  PostgresAltDoorwayStore,
  PostgresLandActionStore,
  PostgresLocationReportStore,
  PostgresTrustAdminStore,
  PostgresTrustStateStore,
  PostgresTrustZoneStore
} from "./auth/trust/trustStore.js";
import { AccountDeletionService } from "./auth/accountDeletionService.js";
import { GoogleAuthLibraryIdentityVerifier } from "./auth/googleIdentity.js";
import { createEmailSender } from "./auth/email/emailSender.js";
import {
  CAPACITOR_IOS_ORIGIN,
  CAPACITOR_ANDROID_ORIGIN,
  NativeAppAuthorization
} from "./auth/nativeAppAuthorization.js";
import { registerNativeAppRoutes } from "./auth/nativeAppRoutes.js";
import { registerNativeBundleRoutes } from "./auth/nativeBundleRoutes.js";
import { InitialSpawnSampler } from "./auth/initialSpawn.js";
import { OnboardingService } from "./auth/onboardingService.js";
import { registerTestAccessRoutes } from "./auth/testAccessRoutes.js";
import { TestAccessService } from "./auth/testAccessService.js";
import { startCombatTelemetryFlushLoop } from "./combatTelemetryStartup.js";
import { loadConfig, publicConfigSummary, skillSystemV3RuntimeCapabilities } from "./config.js";
import { ChatRealtimeCoordinator } from "./chat/chatRealtime.js";
import { PartyListingService } from "./chat/partyListings.js";
import { ChatService } from "./chat/chatService.js";
import { ChatCrestService } from "./chat/chatCrestService.js";
import { BoundedChatRateLimiter, BoundedRecentChatCache } from "./chat/boundedMemory.js";
import {
  CHAT_TRANSLATION_MONTHLY_CHARACTER_CAP_DEFAULT,
  ChatTranslationService
} from "./chat/chatTranslationService.js";
import { GoogleCloudTranslationProvider } from "./chat/googleCloudTranslation.js";
import { CommunitySafetyService } from "./communitySafety.js";
import { DirectMessageRealtimeCoordinator } from "./directMessages/directMessageRealtime.js";
import { DirectMessageService } from "./directMessages/directMessageService.js";
import { InboxReadReceiptService } from "./game/inboxReadReceipts.js";
import {
  BoundedModerationDispatcher,
  InProcessChatModerationConsumer
} from "./chat/moderation.js";
import { createPool } from "./db/pool.js";
import { CollectibleService } from "./game/collectibles.js";
import { BalsamResinService } from "./game/balsamResin.js";
import { FieldConsumableService } from "./game/fieldConsumables.js";
import { CityService } from "./game/cities.js";
import { MapMarkerService } from "./game/mapMarkers.js";
import { PlayerBuildingIndex } from "./game/playerBuildingIndex.js";
import { WorldMapService } from "./game/worldMap.js";
import { KingdomService } from "./game/kingdoms.js";
import { refreshDueKingdomPerks } from "./game/kingdomPerkScheduler.js";
import { syncKingdomCombatPerks } from "./game/kingdomCombatPerks.js";
import { CityProfileAffiliationsResolver } from "./game/cityAffiliations.js";
import {
  CombatEngine,
  playerEquipmentCombatStateFromSnapshot
} from "./game/combat/combatEngine.js";
import { MOB_DEFINITIONS } from "./game/combat/mobDefinitions.js";
import { findValidOceanRetreatDestination } from "./game/combat/mobRetreatDestination.js";
import { companionBaseHealthFromRuntime, PetCompanionRuntime } from "./game/combat/petCompanionRuntime.js";
import { MinionRuntime } from "./game/combat/minionRuntime.js";
import { findOpenLandForTravel } from "./game/openLandSearch.js";
import { RevenantMetalUndeadRuntime } from "./game/combat/revenantMetalUndead.js";
import { PostgresRevenantMetalLichStore } from "./game/revenantMetalLichStore.js";
import { ClassService } from "./game/classes/classService.js";
import { SkillService, SpecializationService } from "./game/skills/index.js";
import { CombatProfileService } from "./game/combat/combatProfiles.js";
import {
  CombatRewardSettlementService,
  type CombatSettlementResult
} from "./game/combat/rewardSettlement.js";
import { CombatTelemetryService } from "./game/combat/combatTelemetry.js";
import { DroppedItemService } from "./game/droppedItems.js";
import { DeveloperSpawnedMobService } from "./game/developerSpawnedMobs.js";
import { DeveloperSpawnedPlantService } from "./game/developerSpawnedPlants.js";
import { dungeonRewardSnapshot } from "./game/dungeonRewards.js";
import { refundDungeonEntryTorch } from "./game/dungeonReentryTorch.js";
import { grantMercenaryKillXp } from "./game/mercenaryKillXp.js";
import { DeveloperSpawnedDungeonService } from "./game/developerSpawnedDungeons.js";
import { InventoryProtectionService } from "./game/inventoryProtection.js";
import { DevelopmentEconomyService } from "./game/developmentEconomy.js";
import { EquipmentService } from "./game/equipment.js";
import { spendUtilityGearUseInTransaction, type UtilityGearHooks } from "./game/utilityGear.js";
import { UtilityGearProximityService } from "./game/utilityGearProximity.js";
import { AchievementService } from "./game/achievements.js";
import { LegendJournalService } from "./game/legendJournal.js";
import { registerLegendJournalRoutes } from "./http/legendJournalRoutes.js";
import { registerCommunitySafetyRoutes } from "./http/communitySafetyRoutes.js";
import { registerChatTranslationRoutes } from "./http/chatTranslationRoutes.js";
import { registerChatCrestRoutes } from "./http/chatCrestRoutes.js";
import { registerRuntimePngContentRoutes } from "./http/runtimePngContentRoutes.js";
import { JewelStationService } from "./game/jewelStation.js";
import { installAuthoritativePlayerAppearance } from "./game/appearanceProjection.js";
import {
  GameplayEnvironmentProfileJobService,
  GameplayEnvironmentProfileMaterializer
} from "./game/gameplayEnvironmentProfileJobs.js";
import {
  PostgresWorldEnvironmentProfileStore
} from "./game/gameplayEnvironmentProfileStore.js";
import {
  CANDIDATE_SLOT_VERSION,
  ENVIRONMENT_PROFILE_VERSION,
  GameplayEnvironmentProfileService,
  worldEnvironmentIdentityKey
} from "./game/gameplayEnvironmentProfiles.js";
import { FlagService } from "./game/flags.js";
import { FlagAccessService } from "./game/flagAccess.js";
import { HarvestSessionService } from "./game/harvestSessions.js";
import { InventoryService } from "./game/inventory.js";
import { FurnaceService } from "./game/furnaces.js";
import { TanneryService } from "./game/tanneries.js";
import { LoomService } from "./game/looms.js";
import { KitchenService } from "./game/kitchens.js";
import { GreenhouseService } from "./game/greenhouses.js";
import { GreenhouseRuntime } from "./game/greenhouseRuntime.js";
import { FishingService } from "./game/fishing.js";
import { SimpleFoodService } from "./game/simpleFood.js";
import { BackpackService } from "./game/backpacks.js";
import { validateItemDefinitionCatalog } from "./game/items.js";
import { MarketService } from "./game/marketService.js";
import { MarketAccessPolicy } from "./game/marketAccess.js";
import { MarketReconciliationService } from "./game/marketReconciliation.js";
import { MarketReconciliationSupervisor } from "./game/marketReconciliationSupervisor.js";
import { PlayerService } from "./game/players.js";
import { PlayerPackageService } from "./game/playerPackages.js";
import { PlayerGiftService } from "./game/playerGifts.js";
import { GlimmerShopService } from "./game/glimmerShop.js";
import { registerDeveloperShopCatalogRoutes } from "./http/developerShopCatalogRoutes.js";
import { PetService, type PetMutationResult } from "./game/petService.js";
import { GivingSaplingService } from "./game/givingSaplings.js";
import { fanOutSaplingViewChanges } from "./game/givingSaplingFanout.js";
import { PlayerPersistenceSupervisor } from "./game/playerPersistenceSupervisor.js";
import {
  createPopulationZonesV2Composition
} from "./game/populationZonesV2Composition.js";
import {
  POPULATION_V2_COMPATIBLE_MATERIALIZATION_REVISIONS
} from "./game/populationV2GenerationServices.js";
import { PopulationFlagSuppressionCleanupWorker } from "./game/populationFlagSuppressionCleanup.js";
import { PopulationFlagPlanBackfillWorker } from "./game/populationFlagPlanBackfill.js";
import { PopulationFlagLocalityWarmer } from "./game/populationFlagLocalityWarmer.js";
import { PostgresPartyAuthority } from "./game/party/PostgresPartyAuthority.js";
import { ProgressionService } from "./game/progression.js";
import { PendingDeathPenaltyCoordinator } from "./game/pendingDeathPenaltyCoordinator.js";
import {
  applyAndPublishDeathBackpackDrop,
  DEATH_DROP_METADATA_KEY,
  deathDropContextAtDefeat
} from "./game/deathBackpackDrop.js";
import { WeeklyLeaderboardService } from "./game/weeklyLeaderboards.js";
import { PlayerAnnouncementService } from "./game/playerAnnouncements.js";
import { WikiService } from "./game/wiki.js";
import { DeveloperLeaderboardService } from "./game/developerLeaderboards.js";
import { EconomyObservatoryService } from "./game/economyObservatory.js";
import { MasteryService } from "./game/masteries.js";
import { ProfileSocialService } from "./game/profiles.js";
import { HotbarService } from "./game/hotbar.js";
import { RecentPlayersService } from "./game/recentPlayers.js";
import { ResourceVisionJobQueue } from "./game/resourceVisionJobs.js";
import { RepeatableResourceService } from "./game/repeatableResources.js";
import { PermanentResourceLifecycleService } from "./game/permanentResourceLifecycle.js";
import { PostgresResourceVisionJobStore } from "./game/resourceVisionJobStore.js";
import { GameState } from "./game/state.js";
import { WorldRuntime } from "./game/worldRuntime.js";
import { XoralEventService } from "./game/xoralEvents.js";
import { LegendaryBirdEventService } from "./game/legendaryBirdEvents.js";
import { CreatureBookService } from "./game/creatureBook.js";
import { BiomeDiscoveryService, loadWorldZoneLookupFromDisk } from "./game/biomeDiscovery.js";
import { OverworldBossEventRegistry } from "./game/overworldBossEvents.js";
import { OverworldBossParticipantLeaseCoordinator } from "./game/overworldBossParticipantLeases.js";
import {
  IdempotentBossRewardAdapter,
  type BossEncounterManager
} from "./game/bossFramework.js";
import { createCoreBossRuntime } from "./game/coreBossRuntime.js";
import { PartyCombatPublisher } from "./realtime/partyCombatPublisher.js";
import { PartyReadyCheckService } from "./realtime/partyReadyCheckService.js";
import { DungeonTorchLobbyService } from "./realtime/dungeonTorchLobbyService.js";
import { WalletService } from "./game/wallet.js";
import { PremiumWalletService } from "./game/premiumWallet.js";
import { hasActiveAtlasPass } from "./game/atlasPass.js";
import { LandBonusNotifier } from "./game/landBonusNotifier.js";
import { GoblinVillageService } from "./game/goblinVillage.js";
import { HollinHutService, PostgresHollinHutStore, hollinHutSpawnAdopter, poolTransaction } from "./game/hollinHuts.js";
import { HollinHelperService } from "./game/hollinHelper.js";
import { CinderLanternService } from "./game/cinderLanterns.js";
import { WanderingMerchantService } from "./game/wanderingMerchants.js";
import { TravelInviteService } from "./game/travelInvites.js";
import { registerCombatTelemetryRoutes } from "./http/combatTelemetryRoutes.js";
import { registerClientAttackAimReportRoutes, registerClientAudioReportRoutes, registerClientDungeonStuckReportRoutes, registerClientMotionReportRoutes } from "./http/clientAudioReportRoutes.js";
import { registerAppearanceStudioRoutes } from "./http/appearanceStudioRoutes.js";
import { registerRoutes } from "./http/routes.js";
import type { DevTeleportThroughTravel } from "./http/routes/playerRoutes.js";
import {
  publishExpiredNeutralityRequests,
  registerProfileRoutes
} from "./http/profileRoutes.js";
import { registerHotbarRoutes } from "./http/hotbarRoutes.js";
import { registerHealTargetRoutes } from "./http/healTargetRoutes.js";
import { HealTargetService, loadHolyArcRelations } from "./game/healTargets.js";
import { registerKingdomRoutes } from "./http/kingdomRoutes.js";
import { registerWarRoutes } from "./http/warRoutes.js";
import { registerMonolithRoutes } from "./http/monolithRoutes.js";
import { registerTreasureRoutes } from "./http/treasureRoutes.js";
import { OrganizationWarService } from "./game/warStructures.js";
import { applyWarDeathLosses } from "./game/warDeathLosses.js";
import { applyPvpDeathGoldLoss } from "./game/pvpDeathGold.js";
import { prunePvpPendingDeaths, resolvePvpDeath } from "./game/pvpPendingDeaths.js";
import { PvpTimerService, type PvpTimerNotice } from "./game/pvpTimers.js";
import { registerInboxRoutes } from "./http/inboxRoutes.js";
import { registerNativePushRoutes } from "./http/nativePushRoutes.js";
import { NativePushService } from "./notifications/nativePushService.js";
import { NativePushWorker } from "./notifications/nativePushWorker.js";
import { createNativePushSender } from "./notifications/nativePushProviders.js";
import { registerPlayerPackageRoutes } from "./http/playerPackageRoutes.js";
import { registerInscribeRoutes } from "./http/inscribeRoutes.js";
import { registerPathfinderMarkRoutes } from "./http/pathfinderMarkRoutes.js";
import { registerFlagAccessRoutes } from "./http/flagAccessRoutes.js";
import { PathfinderMarkService } from "./game/pathfinderMarks.js";
import { InscriptionStatsRecorder } from "./game/inscriptionStats.js";
import { registerHarvestAccessRoutes } from "./http/harvestAccessRoutes.js";
import { HarvestAccessService } from "./game/harvestAccess.js";
import { registerWeeklyLeaderboardRoutes } from "./http/weeklyLeaderboardRoutes.js";
import { registerDeveloperLeaderboardRoutes } from "./http/developerLeaderboardRoutes.js";
import { registerEconomyObservatoryRoutes } from "./http/economyObservatoryRoutes.js";
import { registerDeveloperBugReportRoutes } from "./http/developerBugReportRoutes.js";
import { registerDeveloperCommunitySafetyRoutes } from "./http/developerCommunitySafetyRoutes.js";
import { registerDeveloperTrustRoutes } from "./http/developerTrustRoutes.js";
import { registerDeviceTrustRoutes } from "./http/deviceTrustRoutes.js";
import { createGooglePurchaseMaintenance, createPurchaseService } from "./purchases/createPurchases.js";
import { registerPurchaseRoutes } from "./purchases/purchaseRoutes.js";
import { registerDeveloperLegendaryBirdRoutes } from "./http/developerLegendaryBirdRoutes.js";
import { registerAnnouncementRoutes } from "./http/announcementRoutes.js";
import { registerFallenPrisonRoutes } from "./http/fallenPrisonRoutes.js";
import { registerDeveloperWorldDungeonEntranceRoutes } from "./http/developerWorldDungeonEntranceRoutes.js";
import { FallenPrisonCrashService } from "./game/fallenPrisonCrash.js";
import { registerWikiRoutes } from "./http/wikiRoutes.js";
import { createLogger, requestPathForLog, type AppLogger } from "./logger.js";
import {
  ConnectionRegistry,
  type SendResult
} from "./realtime/connectionRegistry.js";
import { PresenceService } from "./realtime/presenceService.js";
import { PopulationRealtimeAdapter } from "./realtime/populationRealtimeAdapter.js";
import { publishMarketCommit, registerRealtime } from "./realtime/websocket.js";
import {
  equipmentRuntimeContextFor,
  withSkillSystemV3Stats
} from "./realtime/combatEquipmentRealtimeOperations.js";
import { ManorPresenceService, ManorRuntime, ManorStorageService } from "./game/manor.js";
import { ManorDecorationService } from "./game/manorDecorations.js";
import { CisternWarrensRuntime } from "./game/dungeon.js";
import { DungeonResourceHarvestService } from "./game/dungeonResourceHarvest.js";
import { DungeonSkillService } from "./game/dungeonSkills.js";
import { DungeonSkillAuraRuntime } from "./game/dungeonSkillAura.js";
import { MonolithRuntime, MonolithService } from "./game/monoliths.js";
import { TreasureRuntime, TreasureService } from "./game/buriedTreasure.js";
import { DungeonRewardService } from "./game/dungeonRewards.js";
import { dungeonEntryCostAuthorities } from "./game/dungeonEntryCost.js";
import { SalonRuntime, SalonService } from "./game/salon.js";
import { PlayerLocationService } from "./game/locations/playerLocationService.js";
import { createAshAtlasPortalRegistry } from "./game/locations/ashAtlasPortalRegistry.js";
import { GolemForgeSiteService } from "./game/golemForgeSites.js";
import { WorldDungeonEntranceService, worldDungeonEntranceLookupFromWorld } from "./game/worldDungeonEntrances.js";
import { securityHeadersOptions } from "./securityHeaders.js";
import {
  FixedStepScheduler,
  type FixedStepSchedulerMetrics
} from "./runtime/fixedStepScheduler.js";
import {
  LifecycleSupervisor,
  PeriodicTask
} from "./runtime/lifecycleSupervisor.js";
import { WorldLookupClient } from "./world/worldLookupClient.js";
import { WaterSiteService } from "./game/waterSites.js";
import { WORLD_RUNTIME_CONTRACT } from "./runtime/authorityIdentity.js";
import {
  ClosedTestTelemetryService,
  type BugReportAuthoritativeContext,
  type PlayerSnapshotInput
} from "./telemetry/service.js";
import { loadGlobalWorldTelemetry } from "./telemetry/worldReconciliation.js";

export type StartedApplication = Readonly<{
  shutdown(signal: string): Promise<boolean>;
  reportFatal(reason: unknown, origin: string): void;
}>;

type CapturedPublication = Readonly<{
  outcome: SendResult | "failed";
  error?: unknown;
}>;

function capturePublication(
  publish: () => SendResult
): CapturedPublication {
  try {
    return { outcome: publish() };
  } catch (error) {
    return { outcome: "failed", error };
  }
}

/** Mob name and boss flag for the client's loot card; legacy settlements with an unknown archetype omit both. */
function combatRewardMobPresentation(mobArchetype: string): { mobName?: string; boss?: boolean } {
  const definition = (MOB_DEFINITIONS as Readonly<Record<string, { name: string; boss?: boolean } | undefined>>)[mobArchetype];
  return definition ? { mobName: definition.name, ...(definition.boss ? { boss: true } : {}) } : {};
}

export async function publishCommittedCombatReward(
  result: CombatSettlementResult,
  registry: Pick<
    ConnectionRegistry,
    "send" | "activeConnectionIdForPlayer"
  >,
  inventory: Pick<InventoryService, "getInventorySnapshot">,
  logger: Pick<AppLogger, "warn">
): Promise<void> {
  const reward = result.mobReward;
  if (!reward) return;
  const inventoryPublication = capturePublication(() =>
    registry.send(reward.playerId, {
      type: "PLAYER_RESOURCES_UPDATED",
      playerId: reward.playerId,
      inventory: reward.inventory,
      serverTime: Date.now()
    })
  );
  const rewardPublication = capturePublication(() =>
    registry.send(reward.playerId, {
      type: "COMBAT_REWARD_GRANTED",
      settlementKey: result.settlementKey,
      playerId: reward.playerId,
      items: reward.items,
      drops: reward.drops ?? [],
      gold: reward.gold + (reward.rogueBonusGold ?? 0),
      ...combatRewardMobPresentation(result.mobArchetype),
      ...(reward.walletGold !== undefined && reward.walletVersion !== undefined
        ? {
            walletGold: reward.walletGold,
            walletVersion: reward.walletVersion
          }
        : {}),
      inventory: reward.inventory,
      cityCoins: reward.cityCoins,
      cityId: reward.cityId,
      cityTreasuryBalance: reward.cityTreasuryBalance,
      cityContribution: reward.cityContribution,
      ...(reward.rings && reward.rings.length > 0
        ? { rings: reward.rings.map(({ definitionId, onGround, lost }) => ({ definitionId, onGround, ...(lost ? { lost } : {}) })) }
        : {})
    })
  );
  if (
    inventoryPublication.outcome === "sent" &&
    rewardPublication.outcome === "sent"
  ) return;

  let resyncPublication: CapturedPublication = { outcome: "failed" };
  let resyncError: unknown;
  try {
    const authoritativeInventory =
      await inventory.getInventorySnapshot(reward.playerId);
    resyncPublication = capturePublication(() =>
      registry.send(reward.playerId, {
        type: "PLAYER_RESOURCES_UPDATED",
        playerId: reward.playerId,
        inventory: authoritativeInventory,
        serverTime: Date.now()
      })
    );
  } catch (error) {
    resyncError = error;
  }
  logger.warn({
    ...(resyncError ? { err: resyncError } : {}),
    ...(inventoryPublication.error
      ? { inventoryPublicationError: inventoryPublication.error }
      : {}),
    ...(rewardPublication.error
      ? { rewardPublicationError: rewardPublication.error }
      : {}),
    ...(resyncPublication.error
      ? { resyncPublicationError: resyncPublication.error }
      : {}),
    settlementKey: result.settlementKey,
    operationKey: `combat-items:${result.settlementKey}`,
    playerId: reward.playerId,
    inventoryRevision: reward.inventory.revision,
    inventoryPublication: inventoryPublication.outcome,
    rewardPublication: rewardPublication.outcome,
    resyncPublication: resyncPublication.outcome,
    currentConnectionId:
      registry.activeConnectionIdForPlayer(reward.playerId)
  }, "combat-reward-committed-publication-failed");
}

export async function createApplication(): Promise<StartedApplication> {
  const config = loadConfig();
  const logger = createLogger(config.NODE_ENV);
  let latestWorldSchedulerMetrics: FixedStepSchedulerMetrics | null = null;
  // Always-on gameplay step duration (one performance.now pair per step); windowed per scheduler metrics emission.
  const worldStepDuration = { steps: 0, totalMs: 0, maxMs: 0, last: null as { steps: number; meanMs: number; maxMs: number } | null };
  const eventLoopDelay = monitorEventLoopDelay({ resolution: 20 });
  eventLoopDelay.enable();
  const telemetryEventLoopDelay = config.TELEMETRY_ENABLED
    ? monitorEventLoopDelay({ resolution: 20 })
    : null;
  telemetryEventLoopDelay?.enable();
  const requiredWorldIdentity = {
    releaseId: config.WORLD_REQUIRED_RELEASE_ID,
    profileSetFingerprint: config.WORLD_REQUIRED_PROFILE_SET_FINGERPRINT,
    buildContractFingerprint: config.WORLD_REQUIRED_BUILD_CONTRACT_FINGERPRINT,
    boundaryReleaseId: config.WORLD_REQUIRED_BOUNDARY_RELEASE_ID
  };
  const worldLookup = new WorldLookupClient(
    config.WORLD_API_BASE,
    logger,
    config.WORLD_LOOKUP_TIMEOUT_MS,
    requiredWorldIdentity,
    config.RESOURCE_ENVIRONMENT_BATCH_TIMEOUT_MS,
    {
      maxEntries: config.WORLD_WATER_CACHE_MAX_ENTRIES,
      maxBytes: config.WORLD_WATER_CACHE_MAX_BYTES,
      ttlMs: config.WORLD_WATER_CACHE_TTL_MS
    },
    {
      runtimeSha: WORLD_RUNTIME_CONTRACT.worldPipelineSha,
      ...WORLD_RUNTIME_CONTRACT.riverSurface
    },
    {
      runtimeSha: WORLD_RUNTIME_CONTRACT.worldPipelineSha,
      ...WORLD_RUNTIME_CONTRACT.lakeSurface
    },
    {
      runtimeSha: WORLD_RUNTIME_CONTRACT.worldPipelineSha,
      ...WORLD_RUNTIME_CONTRACT.oceanCoastSurface
    },
    {
      runtimeSha: WORLD_RUNTIME_CONTRACT.worldPipelineSha,
      ...WORLD_RUNTIME_CONTRACT.waterbodyIdentity
    }
  );
  let verifiedWorldRelease;
  try {
    verifiedWorldRelease = await worldLookup.verifyRequiredRelease();
  } catch (error) {
    if (!(config.NODE_ENV === "development" && config.ALLOW_DEGRADED_WORLD_LOOKUPS_IN_DEV)) {
      throw error;
    }
    logger.error(
      { err: error, worldApiBase: config.WORLD_API_BASE },
      "DEGRADED WORLD AUTHORITY: required global release was not verified"
    );
  }
  if (verifiedWorldRelease) {
    logger.info({ worldRelease: verifiedWorldRelease }, "verified authoritative global world release");
  }
  const pool = createPool({
    databaseUrl: config.DATABASE_URL,
    max: config.DB_POOL_MAX,
    connectionTimeoutMs: config.DB_POOL_CONNECTION_TIMEOUT_MS,
    idleTimeoutMs: config.DB_POOL_IDLE_TIMEOUT_MS,
    applicationName: `ash-atlas:${config.RUNTIME_LABEL ?? config.NODE_ENV}`,
    logger
  });
  try {
    await validateItemDefinitionCatalog(pool);
  } catch (error) {
    await pool.end().catch(() => undefined);
    throw error;
  }
  logger.info(
    {
      nodeEnv: config.NODE_ENV,
      globalAccess: config.MARKET_GLOBAL_ACCESS,
      productionAcknowledged: config.MARKET_ALLOW_GLOBAL_ACCESS_IN_PRODUCTION
    },
    "market access policy configured"
  );
  const combatTelemetry = new CombatTelemetryService(pool, undefined, logger);
  const telemetry = new ClosedTestTelemetryService(config, logger);
  telemetry.start();
  const app = Fastify({
    genReqId: () => crypto.randomUUID(),
    logger: false,
    trustProxy: config.AUTH_TRUST_PROXY
  });
  const registry = new ConnectionRegistry(
    config.WS_BACKPRESSURE_SOFT_BYTES,
    config.WS_BACKPRESSURE_HARD_BYTES,
    config.WS_BACKPRESSURE_MAX_SKIPS,
    logger
  );
  const presence = new PresenceService({
    onAggregate: (onlinePlayerCount) => {
      registry.broadcast({ type: "ONLINE_PLAYER_COUNT", onlinePlayerCount });
    },
    onTransition: async (playerId) => {
      const friends = await pool.query<{ friend_id: string }>(
        `SELECT CASE WHEN player_low_id = $1 THEN player_high_id ELSE player_low_id END AS friend_id
         FROM friendships
         WHERE player_low_id = $1 OR player_high_id = $1`,
        [playerId]
      );
      for (const recipientId of new Set([
        playerId,
        ...friends.rows.map((row) => row.friend_id)
      ])) {
        registry.send(recipientId, { type: "SOCIAL_STATE_CHANGED", playerId });
      }
    }
  });
  registry.attachPresenceActivity(presence);
  const communitySafety = new CommunitySafetyService(pool);
  let finalizeAccountConnections = async (
    accountId: string,
    code: number,
    reason: string
  ): Promise<void> => {
    registry.closeAccountConnections(accountId, code, reason);
  };
  // Replaced once realtime is registered; before that no live sockets exist.
  let revalidateLiveSessions: (accountId?: string) => Promise<void> = async () => {};
  const directMessageService = new DirectMessageService(pool, {
    pushAudience: { accounts:config.NATIVE_PUSH_ACCOUNT_ALLOWLIST,kinds:config.NATIVE_PUSH_CATEGORY_ALLOWLIST },
    pushEnqueueEnabled: config.NATIVE_PUSH_ENQUEUE_ENABLED,
    // Direct messages may exist between non-friends. Presence is exposed only
    // through the relationship-aware profile/social path.
    isPlayerOnline: () => false,
    requireCurrentTermsAcceptance: (playerId) =>
      communitySafety.hasCurrentTermsAcceptance(playerId)
  });
  const inboxReadReceipts = new InboxReadReceiptService(pool);
  const directMessageRealtime = new DirectMessageRealtimeCoordinator(
    directMessageService,
    registry,
    logger
  );
  const gameState = new GameState(config, logger);
  const masteries = new MasteryService(pool);
  const flagService = new FlagService(pool, worldLookup, config, logger, undefined, masteries);
  let worldMapEquipment: EquipmentService | null = null;
  let worldMapSalon: SalonService | null = null;
  const worldMapService = new WorldMapService(pool, config, {
    extraDestinations: async (playerId) => await hollinHutsRef?.visibleDestinations(playerId) ?? [],
    pathfinderMarkTravelAllowed: async (playerId, flagId) => {
      const authorization = await flagAccess.authorize(flagId, playerId);
      return authorization.decision.allowed && authorization.decision.tollGold === "0";
    },
    caveLandmarks: async (playerId) => {
      if (!dungeonRef || !dungeonSkillsRef) return [];
      await dungeonSkillsRef.ensureLoaded(playerId);
      return dungeonSkillsRef.rankOf(playerId, "deepstone_lore") >= 1 ? dungeonRef.caveLandmarks() : [];
    },
    socialPlayerState: async (playerId) => {
      const player = gameState.getPlayer(playerId);
      if (player?.appearance) return { appearance: structuredClone(player.appearance) };
      const equipment = worldMapEquipment;
      const salon = worldMapSalon;
      if (!equipment || !salon) return null;
      const [equipmentSnapshot, salonAppearance] = await Promise.all([
        equipment.getSnapshot(playerId),
        salon.stylesForPlayer(playerId)
      ]);
      const appearance = projectPlayerAppearance(
        equipmentSnapshot,
        DEFAULT_PLAYER_APPEARANCE_CATALOG,
        {},
        undefined,
        player?.bodyVariantId ?? "default",
        player?.salonStyles ?? salonAppearance.styles
      );
      return {
        appearance: {
          ...appearance,
          revision: Math.max(appearance.revision, salonAppearance.revision)
        }
      };
    }
  });
  const kingdomService = new KingdomService(pool, worldLookup, config, logger, undefined, undefined, masteries);
  const playerService = new PlayerService(pool, config, logger);
  const inventory = new InventoryService(pool, (timing) => {
    if (timing.totalMs < 250) return;
    logger.warn({
      action: timing.action,
      requestId: timing.requestId,
      inventoryTiming: timing
    }, "Slow inventory stack action");
  });
  const mapMarkers = new MapMarkerService(pool, inventory, {
    destinations: async (playerId) => (await worldMapService.snapshot(playerId)).destinations
  });
  const wallet = new WalletService(pool);
  const premiumWallet = new PremiumWalletService(pool);
  const furnaces = new FurnaceService(pool, config.WORLD_ID, inventory, Date.now, masteries, Math.random, premiumWallet);
  const tanneries = new TanneryService(pool, config.WORLD_ID, inventory);
  const looms = new LoomService(pool, config.WORLD_ID, inventory);
  const kitchens = new KitchenService(pool, config.WORLD_ID, inventory);
  const greenhouses = new GreenhouseService(pool, config.WORLD_ID, inventory, worldLookup);
  const fishing = new FishingService(pool, config.WORLD_ID, inventory, worldLookup, Date.now, undefined, wallet);
  const simpleFood = new SimpleFoodService(pool, inventory);
  const droppedItemService = new DroppedItemService(pool, inventory);
  const cityService = new CityService(pool, worldLookup, config, logger, { inventory, wallet, flagService });
  const balsamResin = new BalsamResinService(pool, inventory);
  const fieldConsumables = new FieldConsumableService(pool, inventory);
  const pets = new PetService(pool, premiumWallet, inventory);
  const playerPersistenceSupervisor = new PlayerPersistenceSupervisor(
    gameState,
    async (snapshot) => {
      const metrics = await playerService.persistPlayerSnapshotMeasured(snapshot);
      try {
        await worldMapService.publishSocialPosition(snapshot.playerId, {
          lat: snapshot.lat,
          lon: snapshot.lon
        });
        const discovery = await worldMapService.discoverAtAuthoritativePosition(
          snapshot.playerId,
          { lat: snapshot.lat, lon: snapshot.lon }
        );
        if (discovery?.discovered) {
          registry.send(snapshot.playerId, {
            type: "WORLD_MAP_DESTINATIONS",
            snapshot: await worldMapService.snapshot(snapshot.playerId)
          });
        }
      } catch (error) {
        logger.warn(
          { err: error, playerId: snapshot.playerId },
          "failed to record city discovery after player persistence"
        );
      }
      return metrics;
    },
    config.PLAYER_PERSISTENCE_CONCURRENCY,
    logger
  );
  const travelInvites = new TravelInviteService(pool);
  const combatProfiles = new CombatProfileService(pool, config);
  const progression = new ProgressionService(pool, inventory, config.GLIMMER_LEVEL_UP_FEE_ENABLED
    ? { levelUpFee: { glimmer: LEVEL_UP_GLIMMER_FEE, premiumWallet } }
    : {});
  const weeklyLeaderboards = new WeeklyLeaderboardService(pool, logger);
  const playerAnnouncements = new PlayerAnnouncementService(pool);
  const wiki = new WikiService(pool);
  const developerLeaderboards = new DeveloperLeaderboardService(
    pool,
    weeklyLeaderboards
  );
  const backpacks = new BackpackService(pool, { inventory, wallet });
  const flagAccess = new FlagAccessService(pool, wallet);
  const harvestAccess = new HarvestAccessService(pool);
  const achievements = new AchievementService(pool);
  const equipment = new EquipmentService(pool, { wallet, inventory, achievements });
  worldMapEquipment = equipment;
  const jewelStation = new JewelStationService(pool, inventory, equipment, achievements);
  const publishBitterBloodUnlock = async (
    playerId: string,
    snapshot?: AchievementSnapshot
  ): Promise<void> => {
    registry.send(playerId, {
      type: "ACHIEVEMENT_UNLOCKED",
      achievementId: "bitter_blood",
      title: "Bitter Blood",
      achievements: snapshot ?? await achievements.snapshot(playerId)
    });
    registry.send(playerId, {
      type: "EQUIPMENT_SNAPSHOT",
      equipment: await equipment.refreshInventorySlots(playerId)
    });
  };
  const playerPackages = new PlayerPackageService(pool, {
    pushAudience: { accounts:config.NATIVE_PUSH_ACCOUNT_ALLOWLIST,kinds:config.NATIVE_PUSH_CATEGORY_ALLOWLIST },
    pushEnqueueEnabled: config.NATIVE_PUSH_ENQUEUE_ENABLED,
    inventory,
    equipment,
    fishing,
    wallet,
    ...(cityService.structures
      ? { cityTreasury: cityService.structures.treasury }
      : {})
  });
  const classes = new ClassService(pool, masteries);
  const skillSystemV3Capabilities = skillSystemV3RuntimeCapabilities(config);
  const skills = new SkillService(pool, {
    ...skillSystemV3Capabilities,
    ...(config.GLIMMER_SKILL_RESET_FEE_ENABLED ? { skillResetFee: { premiumWallet } } : {})
  });
  const specializations = new SpecializationService(pool, { ...skillSystemV3Capabilities, inventory });
  const partyAuthority = new PostgresPartyAuthority(pool, config.NATIVE_PUSH_ENQUEUE_ENABLED, { accounts:config.NATIVE_PUSH_ACCOUNT_ALLOWLIST,kinds:config.NATIVE_PUSH_CATEGORY_ALLOWLIST });
  await partyAuthority.initialize();
  const overworldBossEvents = new OverworldBossEventRegistry();
  const overworldBossParticipantLeases = new OverworldBossParticipantLeaseCoordinator();
  let combatRef: CombatEngine | null = null;
  let bossEncounterManagerRef: BossEncounterManager | null = null;
  const overworldBossHandlerForEntity = (entityId: string) => {
    const ownership = combatRef?.entity(entityId)?.bossOwnership;
    return ownership
      ? overworldBossEvents.handlerForOwnership(ownership)
      : overworldBossEvents.handlerForEntity(entityId);
  };
  let developerSpawnedMobsRef: DeveloperSpawnedMobService | null = null;
  let hollinHutsRef: HollinHutService | null = null;
  const settleKingdomRevoltsAndNotify = async (kingdomIds?: readonly string[]): Promise<void> => {
    const changed = await kingdomService.settleRevolts(kingdomIds);
    for (const playerId of await kingdomService.activeMemberIds(changed)) {
      registry.send(playerId, { type: "KINGDOM_STATE_CHANGED", playerId });
    }
  };
  const kingdomRevoltTick = setInterval(() => {
    void settleKingdomRevoltsAndNotify()
      .catch((error: unknown) => logger.warn({ err: error }, "kingdom revolt tick failed"));
  }, 60_000);
  kingdomRevoltTick.unref();
  app.addHook("onClose", async () => clearInterval(kingdomRevoltTick));
  // Trust hostile-action gate (two-way PvP shield); built with the trust services below.
  let hostileGateRef: HostileActionGate | null = null;
  // PvP strike-block rule: aggressor marks, one-swing strike blocks, fights (synchronous combat checks).
  const playerNames = async (playerIds: readonly string[]): Promise<Map<string, string>> => {
    if (playerIds.length === 0) return new Map();
    const result = await pool.query<{ id: string; username: string }>(
      "SELECT id, username FROM players WHERE id = ANY($1::text[])",
      [[...new Set(playerIds)]]
    );
    return new Map(result.rows.map((row) => [row.id, row.username]));
  };
  const sendPvpStatus = async (
    playerId: string,
    extra: Readonly<{ notice?: string; walletGold?: bigint; walletVersion?: bigint }> = {}
  ): Promise<void> => {
    const timers = pvpTimers.timersFor(playerId);
    const names = await playerNames(timers.map((timer) => timer.playerId));
    registry.send(playerId, {
      type: "PVP_STATUS",
      timers: timers.map((timer) => ({ ...timer, displayName: names.get(timer.playerId) ?? "Unknown player" })),
      serverTime: Date.now(),
      ...(extra.notice === undefined ? {} : { notice: extra.notice }),
      ...(extra.walletGold === undefined || extra.walletVersion === undefined
        ? {}
        : { walletGold: extra.walletGold.toString(), walletVersion: extra.walletVersion.toString() })
    });
  };
  const pvpTimerNoticeText = (notice: PvpTimerNotice, otherName: string): string =>
    notice.kind === "struck"
      ? `You struck ${otherName}: no more attacks on them for 20h unless they fight back`
      : notice.kind === "engaged"
        ? `${otherName} was Aggressive and fights back`
        : `${otherName} struck you: you may attack them for 20h`;
  const pvpTimers = new PvpTimerService(pool, {
    logger,
    onChange: (playerIds, notices) => {
      void (async () => {
        const names = await playerNames([...notices.values()].map((notice) => notice.otherPlayerId));
        await Promise.all(playerIds.map((playerId) => {
          const notice = notices.get(playerId);
          return sendPvpStatus(playerId, notice
            ? { notice: pvpTimerNoticeText(notice, names.get(notice.otherPlayerId) ?? "another player") }
            : {});
        }));
      })().catch((error: unknown) => logger.warn({ err: error, playerIds }, "failed to send PvP status"));
    }
  });
  await pvpTimers.load();
  const pvpFightSweep = setInterval(() => pvpTimers.sweep(), 1_000);
  pvpFightSweep.unref();
  app.addHook("onClose", async () => {
    clearInterval(pvpFightSweep);
    await pvpTimers.flush();
  });
  const pendingDeathPenalties = new PendingDeathPenaltyCoordinator();
  await prunePvpPendingDeaths(pool)
    .catch((error: unknown) => logger.warn({ err: error }, "failed to prune pending PvP deaths"));
  const persistDeathPenaltyAndRefresh = async (input: Parameters<ProgressionService["applyDeathPenalty"]>[0]): Promise<void> => {
    const pvpDeath = await resolvePvpDeath(pool, input, logger);
    const killerPlayerId = pvpDeath?.killerPlayerId ?? null;
    if (pvpDeath && killerPlayerId) {
      // PvP death gold: 12% of carried gold to the player who landed the
      // killing blow, once per death. Undead, military units, towers and the
      // world pay nothing. Like war losses it never blocks the XP penalty or
      // the respawn.
      try {
        const gold = pvpDeath.goldEligible
          ? await applyPvpDeathGoldLoss(pool, wallet, {
            deathOperationKey: input.operationKey,
            victimPlayerId: input.playerId,
            killerPlayerId
          })
          : null;
        if (gold?.applied && gold.goldLost > 0n && gold.victimWallet && gold.killerWallet) {
          const names = await playerNames([input.playerId, killerPlayerId]);
          const amount = gold.goldLost.toLocaleString("en-US");
          const stolen = gold.rogueTheft > 0n ? gold.rogueTheft.toLocaleString("en-US") : null;
          await sendPvpStatus(input.playerId, {
            notice: `${names.get(killerPlayerId) ?? "Your killer"} took ${amount} gold (10% of what you carried)${stolen ? `, plus ${stolen} gold stolen` : ""}`,
            walletGold: gold.victimWallet.gold,
            walletVersion: gold.victimWallet.version
          });
          await sendPvpStatus(killerPlayerId, {
            notice: `You took ${amount} gold from ${names.get(input.playerId) ?? "your victim"}${stolen ? `, plus ${stolen} gold stolen` : ""}`,
            walletGold: gold.killerWallet.gold,
            walletVersion: gold.killerWallet.version
          });
        } else if (gold?.applied && gold.beginnerProtected) {
          await sendPvpStatus(input.playerId, { notice: "Beginner protection: you lose nothing through level 3" });
        }
      } catch (error: unknown) {
        logger.error({ err: error, playerId: input.playerId, operationKey: input.operationKey }, "failed to apply PvP death gold loss");
      }
      // Mercenary Momentum kill XP, once per death (the death key dedupes a retry). Never blocks the respawn.
      const momentum = input.metadata?.mercenaryMomentum as { rank?: unknown; stacks?: unknown } | undefined;
      if (momentum && typeof momentum.rank === "number" && typeof momentum.stacks === "number") {
        try {
          const killer = await progression.getOrCreate(killerPlayerId);
          const grant = await grantMercenaryKillXp(progression, {
            deathOperationKey: input.operationKey,
            killerPlayerId,
            victimPlayerId: input.playerId,
            rank: momentum.rank,
            killerLevel: killer.level,
            stacks: momentum.stacks
          });
          if (grant) registry.send(killerPlayerId, { type: "XP_GRANTED", grant });
        } catch (error: unknown) {
          logger.error({ err: error, playerId: killerPlayerId, operationKey: input.operationKey }, "failed to grant Mercenary kill XP");
        }
      }
      // War-death losses never block the XP penalty or the respawn; the
      // death operation key makes a retried attempt a no-op.
      try {
        const loss = await applyWarDeathLosses(pool, inventory, {
          deathOperationKey: input.operationKey,
          victimPlayerId: input.playerId,
          killerPlayerId
        });
        if (loss?.applied && (loss.carriedLost > 0 || loss.treasuryLost > 0)) {
          const parts = [
            ...(loss.carriedLost > 0 ? [`you lost ${loss.carriedLost.toLocaleString("en-US")} carried Bricks`] : []),
            ...(loss.treasuryLost > 0 ? [`your kingdom lost ${loss.treasuryLost.toLocaleString("en-US")} Bricks`] : [])
          ];
          const message = `Killed in war: ${parts.join(" and ")}.`;
          if (loss.inventory) {
            registry.send(input.playerId, {
              type: "INVENTORY_STACK_UPDATED",
              requestId: `war-death:${input.operationKey}`,
              action: "reorganize",
              inventory: loss.inventory,
              serverTime: Date.now(),
              message
            });
          }
        }
        if (loss?.applied && loss.victimWasLeader && loss.victimKingdomId) {
          // A leader's war death boosts an open revolt vote, which may now pass.
          await settleKingdomRevoltsAndNotify([loss.victimKingdomId]);
        }
      } catch (error: unknown) {
        logger.error({ err: error, playerId: input.playerId, operationKey: input.operationKey }, "failed to apply war-death losses");
      }
    }
    // Death drop: the lowest backpack plus what no longer fits, on the
    // ground at the death spot. Before the XP penalty (beginner protection
    // reads the level at death); never blocks the penalty or the respawn.
    const deathDrop = await applyAndPublishDeathBackpackDrop({
      pool, inventory, backpacks, equipment, logger,
      send: (playerId, message) => registry.send(playerId, message),
      publishGroundLoot: (positions) => publishCommittedGroundLoot(positions)
    }, input);
    const deathWear = await equipment.applyDeathConditionWear({
      playerId: input.playerId,
      operationKey: input.operationKey
    });
    const deathPenalty = await progression.applyDeathPenalty(input);
    if (killerPlayerId) {
      // PvP death: -6 max HP (-4 with Revenant armor), recovering 1 every 75 minutes. Never blocks respawn.
      try {
        const loss = await progression.applyPvpMaxHealthLoss({
          operationKey: input.operationKey,
          playerId: input.playerId,
          killerPlayerId,
          revenantArmor: pvpDeath?.revenantArmor === true,
          unpenalizedMaxHealth: combatRef?.unpenalizedMaxHealth(input.playerId) ?? BASE_PLAYER_MAX_HEALTH
        });
        combatRef?.setPlayerMaxHealthPenalty(input.playerId, loss.penalty);
      } catch (error: unknown) {
        logger.error({ err: error, playerId: input.playerId, operationKey: input.operationKey }, "failed to apply PvP max-HP loss");
      }
    }
    const [baseProgression, classSnapshot, skillSnapshot, kingdomModifiers] = await Promise.all([
      progression.getOrCreate(input.playerId),
      classes.getOrCreate(input.playerId),
      skills.getOrCreate(input.playerId),
      kingdomService.statModifiers(input.playerId)
    ]);
    const loadout = await equipment.getSnapshot(
      input.playerId,
      equipmentRuntimeContextFor(baseProgression, classSnapshot)
    );
    const resolved = withSkillSystemV3Stats(
      baseProgression,
      loadout,
      skillSnapshot,
      kingdomModifiers
    );
    combatRef?.updatePlayerPveStats(input.playerId, {
      level: resolved.level,
      maxHealth: resolved.pveStats.maxHealth,
      attackPower: resolved.pveStats.attackPower,
      defense: resolved.pveStats.defense
    }, { preserveCurrentHealth: true });
    combatRef?.syncPlayerEquipmentCombatState(
      input.playerId,
      playerEquipmentCombatStateFromSnapshot(loadout)
    );
    if (deathWear.changed) {
      registry.send(input.playerId, {
        type: "EQUIPMENT_SNAPSHOT",
        equipment: {
          ...loadout,
          repairMessage: deathWear.message
        }
      });
    }
    combatRef?.updatePlayerSkillState(input.playerId, skillSnapshot);
    registry.send(input.playerId, {
      type: "PROGRESSION_SNAPSHOT",
      progression: resolved,
      deathPenalty: {
        operationKey: deathPenalty.operationKey,
        ...(deathDrop ? { deathDrop } : {}),
        xpLost: deathPenalty.xpLost
      }
    });
  };
  let worldRuntimeRef: WorldRuntime | null = null;
  let goblinVillageRef: GoblinVillageService | null = null;
  let dungeonRef: CisternWarrensRuntime | null = null;
  /** Set once the dungeon skill service exists; the combat engine reads Tidecraft ranks through it. */
  let dungeonSkillsRef: DungeonSkillService | null = null;
  let publishCommittedGroundLoot = async (
    _positions: readonly Readonly<{ lat: number; lon: number }>[]
  ): Promise<void> => { void _positions; };
  const creatureBook = new CreatureBookService(pool);
  const biomeDiscovery = new BiomeDiscoveryService(pool, loadWorldZoneLookupFromDisk(logger), worldLookup, Date.now, new LegendJournalService(pool));
  registry.setCombatPresentationObserver((playerId, entities) => {
    void creatureBook.recordVisibleCreatures(playerId, entities).catch((error: unknown) => {
      logger.warn({ err: error, playerId }, "failed to record creature book sightings");
    });
  });
  const landBonusNotifier = new LandBonusNotifier((playerId, notice) => {
    registry.send(playerId, notice);
  });
  const settlements = new CombatRewardSettlementService(
    pool,
    progression,
    logger,
    (result) => {
      if (result.mobReward) {
        void publishCommittedCombatReward(result, registry, inventory, logger);
        const landBonus = result.mobReward.landBonus;
        if (
          landBonus?.payeeKind === "player" &&
          landBonus.walletGold !== undefined &&
          landBonus.walletVersion !== undefined
        ) {
          landBonusNotifier.record(landBonus.payeeId, {
            gold: landBonus.paidGold,
            walletGold: landBonus.walletGold,
            walletVersion: landBonus.walletVersion
          });
        }
        const groundRings = (result.mobReward.rings ?? []).flatMap((ring) =>
          ring.onGround && ring.lat !== undefined && ring.lon !== undefined ? [{ lat: ring.lat, lon: ring.lon }] : []);
        if ((result.mobReward.drops?.length ?? 0) > 0 || groundRings.length > 0) {
          void publishCommittedGroundLoot([...(result.mobReward.drops ?? []).map((drop) => ({
            lat: drop.lat,
            lon: drop.lon
          })), ...groundRings]).catch((error: unknown) => {
            logger.warn(
              { err: error, settlementKey: result.settlementKey },
              "failed to publish committed combat ground loot"
            );
          });
        }
      }
      for (const share of result.shares) {
        void Promise.all([
          share.classGrant ? Promise.resolve(share.classGrant.snapshot) : classes.getOrCreate(share.playerId),
          skills.getOrCreate(share.playerId),
          kingdomService.statModifiers(share.playerId)
        ]).then(async ([classSnapshot, skillSnapshot, kingdomModifiers]) => {
          const equipmentContext = {
            context: "pve" as const,
            characterLevel: share.grant.progression.level,
            classId: classSnapshot.activeClassId,
            classRank: classProgress(classSnapshot, classSnapshot.activeClassId)?.level ?? 0
          };
          const loadout = equipment.runtimeSnapshot(share.playerId)
            ? equipment.setRuntimeContext(share.playerId, equipmentContext)
            : await equipment.getSnapshot(share.playerId, equipmentContext);
          const pendingEquipmentActivation = equipment.pendingActivation(share.playerId);
          if (pendingEquipmentActivation && combatRef) {
            combatRef.stageEquipmentCombatUpdate(share.playerId, {
              requestId: pendingEquipmentActivation.requestId,
              kind: "kit_activation",
              state: playerEquipmentCombatStateFromSnapshot(
                pendingEquipmentActivation.equipment
              )
            });
          }
          const progressionSnapshot = withSkillSystemV3Stats(
            share.grant.progression,
            loadout,
            skillSnapshot,
            kingdomModifiers
          );
          const classStats = progressionSnapshot.pveStats;
          const grant = { ...share.grant, progression: progressionSnapshot };
          combatRef?.updatePlayerPveStats(share.playerId, {
            level: progressionSnapshot.level,
            maxHealth: classStats.maxHealth,
            attackPower: progressionSnapshot.pveStats.attackPower,
            defense: progressionSnapshot.pveStats.defense
          });
          combatRef?.updatePlayerClassState(share.playerId, classSnapshot, loadout);
          combatRef?.updatePlayerSkillState(share.playerId, skillSnapshot);
          combatRef?.syncPlayerEquipmentCombatState(
            share.playerId,
            playerEquipmentCombatStateFromSnapshot(loadout)
          );
          registry.send(share.playerId, { type: "XP_GRANTED", grant });
          registry.send(share.playerId, {
            type: "EQUIPMENT_SNAPSHOT",
            equipment: loadout
          });
          if (share.classGrant) {
            registry.send(share.playerId, {
              type: "CLASS_MASTERY_GRANTED",
              eventId: `class-xp:${result.settlementKey}:${share.playerId}`,
              classId: share.classGrant.classId,
              subclassId: share.classGrant.subclassId,
              requestedXp: share.classGrant.requestedXp,
              grantedXp: share.classGrant.grantedXp,
              replayed: share.classGrant.replayed,
              previousRank: share.classGrant.warriorPreviousRank,
              resultingRank: share.classGrant.warriorResultingRank,
              snapshot: classSnapshot
            });
          }
          if (share.classGrant) {
            registry.send(share.playerId, {
              type: "MASTERY_SNAPSHOT",
              masteries: await masteries.getOrCreate(share.playerId)
            });
          }
          for (const level of grant.levelsGained) {
            registry.send(share.playerId, {
              type: "LEVEL_UP",
              level,
              progression: progressionSnapshot
            });
          }
        }).catch((error: unknown) => {
          logger.warn({ err: error, playerId: share.playerId }, "failed to refresh level-up combat stats");
        });
      }
    },
    // Class mastery is retained as migration evidence under Skill System V3,
    // but combat rewards no longer advance the dormant Rank 0-15 tracks.
    undefined,
    inventory,
    masteries,
    wallet,
    cityService.structures?.treasury
  );
  settlements.setSkillSystemV3Capabilities(skillSystemV3Capabilities);
  settlements.setRingEquipment(equipment);
  const dogHealthPersistence = new Map<string, Promise<void>>();
  const enqueueDogPersistence = (dogId: string, operation: () => Promise<void>): void => {
    const prior = dogHealthPersistence.get(dogId) ?? Promise.resolve();
    const next = prior.then(operation, operation).catch((error: unknown) => {
      logger.warn({ err: error, dogId }, "failed to persist Dog companion state");
    }).finally(() => {
      if (dogHealthPersistence.get(dogId) === next) dogHealthPersistence.delete(dogId);
    });
    dogHealthPersistence.set(dogId, next);
  };
  /** A pet's outing ended (timer, 0 HP, or the owner entered a dungeon): persist it and tell the owner. */
  const endPetOuting = async (
    ownerPlayerId: string,
    petId: string,
    reason: "expired" | "defeated" | "sent_home"
  ): Promise<void> => {
    const owner = await pets.ownerForPlayer(ownerPlayerId);
    if (!owner) return;
    const result: PetMutationResult = reason === "sent_home"
      ? await pets.sendHome(owner, petId)
      : await pets.beginRest(owner, petId, reason);
    if (reason !== "sent_home") dogCompanionsRef?.unsummon(ownerPlayerId);
    registry.send(ownerPlayerId, {
      type: "PET_STATE",
      action: reason === "sent_home" ? "sent_home" : "rested",
      state: result.state,
      ...(result.notice ? { notice: reason === "sent_home" ? `${result.notice.replace(/ went home to rest\.$/u, "")} went home to rest: pets can't enter dungeons.` : result.notice } : {})
    });
  };
  let dogCompanionsRef: PetCompanionRuntime | null = null;
  let minionsRef: MinionRuntime | null = null;
  /** Bonewrought relics are carried, not equipped: check the authoritative inventory. */
  const carries = async (playerId: string, itemId: string): Promise<boolean> => {
    const result = await pool.query<{ held: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM player_inventory WHERE player_id = $1 AND resource_type = $2 AND quantity > 0) AS held",
      [playerId, itemId]
    );
    return result.rows[0]?.held === true;
  };
  // Bound once the dungeon runtime exists (the runtime reads combat entities).
  let monolithRuntime: MonolithRuntime | null = null;
  const inscriptionStats = new InscriptionStatsRecorder(pool);
  inscriptionStats.start();
  app.addHook("onClose", async () => { await inscriptionStats.stop().catch(() => undefined); });
  // Dev/e2e only (see DEV_PLAYERS_INVULNERABLE in config.ts); never in production.
  const devPlayersInvulnerable = config.DEV_PLAYERS_INVULNERABLE && config.DEV_TOOLS_ENABLED === true &&
    config.NODE_ENV !== "production";
  const combat = new CombatEngine({
    tickRateHz: config.SERVER_TICK_HZ,
    inscriptionStats,
    // Dev/e2e only (DEV_PLAYER_DAMAGE_MULTIPLIER in config.ts); never in production.
    devPlayerDamageMultiplier: config.DEV_TOOLS_ENABLED === true && config.NODE_ENV !== "production"
      ? config.DEV_PLAYER_DAMAGE_MULTIPLIER
      : 1,
    // Dash i-frames: every damage path that honours this hook (mob hits, telegraph strikes,
    // PvP, status ticks, towers) skips a dashing player.
    isEntityInvulnerable: (entityId) => gameState.isDashInvulnerable(entityId) ||
      (dungeonRef?.isDashInvulnerable(entityId) ?? false) ||
      (devPlayersInvulnerable && combatRef?.entityKind(entityId) === "player"),
    // Action combat: swings resolve only with ACTION_COMBAT_ENABLED; a swing pressed mid-dash waits for the landing.
    actionCombatEnabled: () => config.ACTION_COMBAT_ENABLED,
    clericArcEnabled: () => config.CLERIC_ARC_ENABLED,
    // Mob tactics only take effect while action combat is also on.
    mobTacticsEnabled: () => config.MOB_TACTICS_ENABLED,
    // Mob archetypes (Phase 2) only take effect while action combat and mob tactics are also on.
    mobArchetypesEnabled: () => config.MOB_ARCHETYPES_ENABLED,
    // Damage matrix v4 (docs/plans/class-roster-v2.md section 6); off keeps the v3 table.
    damageMatrixV4Enabled: () => config.DAMAGE_MATRIX_V4_ENABLED,
    mobArchetypesOnly: () => config.MOB_ARCHETYPES_ONLY,
    // Telegraph time: every managed-mob windup and telegraph times this (clamped 1-3 in the engine).
    mobTelegraphScale: () => config.MOB_TELEGRAPH_SCALE,
    isEntityDashing: (entityId) => gameState.isDashing(entityId) || (dungeonRef?.isDashing(entityId) ?? false),
    // A buffered swing's deferred SWING_RESULT, back to the connection it was pressed on.
    onSwingResolved: (playerId, result) => worldRuntimeRef?.deliverBufferedSwingResult(playerId, result),
    onCompanionHealthChanged: (event) => {
      // Minions are runtime-only; only the owner's whistle pet persists health.
      if (dogCompanionsRef?.activePetId(event.ownerPlayerId) !== event.dogId) return;
      const baseHealth = companionBaseHealthFromRuntime(event);
      enqueueDogPersistence(event.dogId, () =>
        pets.updateHealthForOwner(event.ownerPlayerId, event.dogId, baseHealth));
      if (event.defeated || baseHealth <= 0) {
        enqueueDogPersistence(event.dogId, () => endPetOuting(event.ownerPlayerId, event.dogId, "defeated"));
      }
    },
    onHarmfulStatusDamage: (event) => {
      if (event.harmfulStatusId !== "poison") return;
      void achievements.recordPoisonDamage(
        event.playerId,
        event.appliedDamage
      ).then((result) => {
        if (result.newlyUnlocked) {
          void publishBitterBloodUnlock(event.playerId, result.snapshot).catch((error: unknown) => {
            logger.warn({ err: error, playerId: event.playerId }, "failed to refresh equipment after achievement unlock");
          });
        } else {
          registry.send(event.playerId, {
            type: "ACHIEVEMENT_SNAPSHOT",
            achievements: result.snapshot
          });
        }
      }).catch((error: unknown) => {
        logger.warn({ err: error, playerId: event.playerId }, "failed to persist poison achievement progress");
      });
    },
    playerMaxHealth: config.COMBAT_PLAYER_MAX_HEALTH,
    playerAttackDamage: config.COMBAT_PLAYER_BASIC_DAMAGE,
    playerMovementSpeedMps: config.PLAYER_SPEED_MPS,
    spatialCellSizeM: config.COMBAT_SPATIAL_CELL_M,
    interestRadiusM: config.COMBAT_INTEREST_RADIUS_M,
    maxChasesPerTick: config.COMBAT_MAX_CHASES_PER_TICK,
    partyAuthority,
    isPvpBlocked: (attackerPlayerId, targetPlayerId) =>
      hostileGateRef?.pvpBlocked(attackerPlayerId, targetPlayerId) ?? false,
    pvpStrikeBlockMs: (attackerPlayerId, targetPlayerId) =>
      pvpTimers.strikeBlockMs(attackerPlayerId, targetPlayerId),
    pvpPlayerName: (playerId) => gameState.getPlayer(playerId)?.username ?? null,
    pvpIsFighting: (a, b) => pvpTimers.isFighting(a, b),
    pvpDefeatSafetyMs: (playerId) => pvpTimers.defeatSafetyMs(playerId),
    onPvpHit: (attackerPlayerId, targetPlayerId, aggressiveUntilMs, targetAggressive) =>
      pvpTimers.recordHit(attackerPlayerId, targetPlayerId, aggressiveUntilMs, targetAggressive),
    isPvpSupportRestricted: (playerId) => hostileGateRef?.pvpSupportRestricted(playerId) ?? false,
    getAuthoritativeViewCircle: (playerId) =>
      dungeonRef?.gameplayViewCircle(playerId) ?? gameState.getGameplayViewCircle(playerId),
    dungeonLanternStatBonus: (playerId) => cinderLanterns.challengerRunActive(playerId, dungeonRef?.runIdOf(playerId) ?? null)
      ? { attack: CHALLENGERS_LANTERN_ATTACK_BONUS, defense: CHALLENGERS_LANTERN_DEFENSE_BONUS }
      : { attack: 0, defense: 0 },
    isPlayerMobAttackAuthorized: (playerId, mobEntityId) => hollinHutsRef?.canPlayerAttack(playerId, mobEntityId) ?? (dungeonRef?.isInside(playerId)
      ? dungeonRef.canFightMob(playerId, mobEntityId)
      : (() => {
          const ownership = combatRef?.entity(mobEntityId)?.bossOwnership;
          const handler = overworldBossHandlerForEntity(mobEntityId);
          return ownership ? handler?.canPlayerAttack(playerId, mobEntityId) ?? false
            : handler?.canPlayerAttack(playerId, mobEntityId) ?? true;
        })()),
    isMobPlayerAttackAuthorized: (mobEntityId, playerId) => hollinHutsRef?.canMobAttack(mobEntityId, playerId) ?? (dungeonRef?.isInside(playerId)
      ? dungeonRef.canFightMob(playerId, mobEntityId)
      : (() => {
          const ownership = combatRef?.entity(mobEntityId)?.bossOwnership;
          const handler = overworldBossHandlerForEntity(mobEntityId);
          return ownership ? handler?.canMobAttack(mobEntityId, playerId) ?? false
            : handler?.canMobAttack(mobEntityId, playerId) ?? true;
        })()),
    isSharedMobCombat: (mobEntityId) =>
      overworldBossHandlerForEntity(mobEntityId)?.isSharedCombat(mobEntityId) ?? false,
    canMobProactivelyAcquire: (mobEntityId, playerId) => dungeonRef?.isInside(playerId)
      ? dungeonRef.canFightMob(playerId, mobEntityId)
      : goblinVillageRef?.canDefenderAttack(mobEntityId, playerId) ??
      worldRuntimeRef?.canMobProactivelyAcquire(mobEntityId, playerId) ?? false,
    canMobContinueIntent: (mobEntityId, playerId) => dungeonRef?.isInside(playerId)
      ? dungeonRef.canFightMob(playerId, mobEntityId)
      : (() => {
          const ownership = combatRef?.entity(mobEntityId)?.bossOwnership;
          const handler = overworldBossHandlerForEntity(mobEntityId);
          if (ownership) return handler?.canMobContinueIntent?.(mobEntityId, playerId) ?? false;
          return handler?.canMobContinueIntent?.(mobEntityId, playerId) ??
            goblinVillageRef?.canDefenderAttack(mobEntityId, playerId) ??
            worldRuntimeRef?.canMobContinueIntent(mobEntityId, playerId) ?? false;
        })(),
    resolveMobRetreatDestination: ({
      entityId,
      archetype,
      anchor,
      distanceM,
      retreatIndex
    }) => {
      if (archetype !== "jellyfish") return Promise.resolve(null);
      return findValidOceanRetreatDestination({
        entityId,
        anchor,
        distanceM,
        retreatIndex,
        lookup: (points) => worldLookup.lookupGameplayEnvironments(points, {
          caller: "wildlife",
          priority: 0,
          cacheClass: "protected"
        })
      });
    },
    getMonolithOutgoingDamageBonus: (playerId) => monolithRuntime?.attackBonus(playerId) ?? 0,
    getCityDistrictCombatBenefits: (playerId) => {
      const benefit = cityService.districtBenefits.runtimeSnapshot(playerId);
      return {
        directPveDamageBonus: benefit.directMobDamageBonus,
        pveDefenseBonus: benefit.mobDefenseBonus
      };
    },
    isPlayerAuthorityActive: (playerId, accountId, connectionId) =>
      registry.isActiveConnection(accountId, connectionId) &&
      registry.isActivePlayerConnection(playerId, connectionId),
    movePlayerToward: (playerId, target) => {
      if (dungeonRef?.isInside(playerId)) dungeonRef.setCombatTarget(playerId, target);
      else gameState.setCombatTarget(playerId, target);
    },
    stopPlayer: (playerId) => {
      if (dungeonRef?.isInside(playerId)) dungeonRef.stop(playerId);
      else gameState.stopPlayer(playerId);
    },
    repositionPlayer: (playerId, target, maximumDistanceM, requireClearPath) => dungeonRef?.isInside(playerId)
      ? dungeonRef.repositionCombatPlayer(playerId, target, maximumDistanceM, requireClearPath)
      : gameState.repositionCombatPlayer(playerId, target, maximumDistanceM),
    onPlayerDefeated: (playerId, deathId, killerPlayerId, details) => {
      if (details?.killedByInscription) {
        registry.send(playerId, {
          type: "PLAYER_DEATH_MESSAGE",
          message: `You have been killed by ${details.killedByInscription.wielderName}'s ${details.killedByInscription.inscription}`
        });
      }
      dungeonRef?.recordPlayerDeath(playerId);
      void carries(playerId, "bonewrought_mail").then((held) => {
        if (held) minionsRef?.recordBonewroughtDeath(playerId, GRAVE_ECHO_CHANCE);
      }).catch((error: unknown) => logger.warn({ err: error, playerId }, "grave echo check failed"));
      gameState.setMovementBlocked(playerId, true);
      pvpTimers.recordDeath(playerId, killerPlayerId);
      void pendingDeathPenalties.begin(
        playerId,
        {
          operationKey: `player-death:${deathId}`,
          playerId,
          metadata: {
            [DEATH_DROP_METADATA_KEY]: deathDropContextAtDefeat(
              dungeonRef?.isInside(playerId) === true,
              gameState.isWorldPresent(playerId),
              gameState.getPlayer(playerId)
            ),
            deathId,
            ...(killerPlayerId ? { killerPlayerId, pvpGoldEligible: details?.goldEligible === true } : {}),
            ...(details?.mercenaryMomentum ? { mercenaryMomentum: details.mercenaryMomentum } : {}),
            ...(details?.revenantArmor ? { revenantArmor: true } : {})
          }
        },
        persistDeathPenaltyAndRefresh
      ).catch((error: unknown) => {
        logger.error({ err: error, playerId, deathId }, "failed to persist player death XP penalty");
      });
      void (async () => {
        const affected = await travelInvites.invalidateForInviter(
          playerId,
          "The inviter was defeated."
        );
        await Promise.all(affected.map(async (affectedPlayerId) => {
          if (!registry.activeConnectionIdForPlayer(affectedPlayerId)) return;
          registry.send(affectedPlayerId, {
            type: "TRAVEL_INBOX_SNAPSHOT",
            entries: await travelInvites.inboxForPlayer(affectedPlayerId),
            serverTime: Date.now()
          });
        }));
      })().catch((error: unknown) => {
        logger.warn({ err: error, playerId }, "failed to invalidate Travel Invites after defeat");
      });
    },
    onPlayerRespawn: (playerId) => {
      // Tilted Vault: back to the start of the room the player died in; the world player stays where it is.
      if (dungeonRef?.respawnsInRoomOnDeath(playerId)) {
        const position = dungeonRef.respawnPlayer(playerId);
        gameState.setMovementBlocked(playerId, false);
        if (position) return position;
      }
      return gameState.respawnPlayerAtAnchor(playerId);
    },
    tidecraftRank: (playerId) => {
      if (!dungeonSkillsRef) return 0;
      void dungeonSkillsRef.ensureLoaded(playerId).catch(() => undefined);
      return dungeonSkillsRef.rankOf(playerId, "tidecraft");
    },
    deepstoneRank: (playerId) => {
      if (!dungeonSkillsRef) return 0;
      void dungeonSkillsRef.ensureLoaded(playerId).catch(() => undefined);
      return dungeonSkillsRef.rankOf(playerId, "deepstone_lore");
    },
    isNearCave: (position, radiusM) => dungeonRef?.isNearCaveEntrance(position, radiusM) ?? false,
    onTidewaterLost: (playerId) => {
      void fieldConsumables.clearTidewater(playerId).then(async () => {
        if (!registry.activeConnectionIdForPlayer(playerId)) return;
        registry.send(playerId, {
          type: "FIELD_BUFFS",
          buffs: [...await fieldConsumables.activeBuffs(playerId), ...combat.fieldBuffSnapshots(playerId)],
          serverTime: Date.now()
        });
      }).catch((error: unknown) => {
        logger.warn({ err: error, playerId }, "failed to clear the Tidewater Draught after defeat");
      });
    },
    onVigorSerumLost: (playerId) => {
      void fieldConsumables.clearVigorSerum(playerId).then(async () => {
        if (!registry.activeConnectionIdForPlayer(playerId)) return;
        registry.send(playerId, {
          type: "FIELD_BUFFS",
          buffs: [...await fieldConsumables.activeBuffs(playerId), ...combat.fieldBuffSnapshots(playerId)],
          serverTime: Date.now()
        });
      }).catch((error: unknown) => {
        logger.warn({ err: error, playerId }, "failed to clear Vigor Serum after defeat");
      });
    },
    onFieldBuffsChanged: (playerId) => {
      if (!registry.activeConnectionIdForPlayer(playerId)) return;
      void fieldConsumables.activeBuffs(playerId).then((persistent) => {
        registry.send(playerId, {
          type: "FIELD_BUFFS",
          buffs: [...persistent, ...combat.fieldBuffSnapshots(playerId)],
          serverTime: Date.now()
        });
      }).catch((error: unknown) => {
        logger.warn({ err: error, playerId }, "failed to refresh field buffs");
      });
    },
    onBalsamResinEffectFinished: (playerId, effectId, reason) =>
      balsamResin.finish(playerId, effectId, reason).catch((error: unknown) => {
        logger.warn(
          { err: error, playerId, effectId, reason },
          "failed to finalize Balsam Resin effect"
        );
      }),
    onDefeatSettlementCandidate: async (candidate) => {
      const killerId = candidate.defeatingPlayerId;
      // Golem Forge group gold bonus, frozen into the durable candidate so a replayed settlement pays the same.
      const groupGoldMultiplier = killerId
        ? dungeonRef?.groupGoldMultiplier(killerId, candidate.lootLocation?.regionCode) ?? 1
        : 1;
      if (groupGoldMultiplier > 1) candidate.groupGoldMultiplier = groupGoldMultiplier;
      if (killerId) {
        void carries(killerId, "bonewrought_blade").then((held) => {
          if (held) minionsRef?.recordBonewroughtKill(killerId);
        }).catch((error: unknown) => logger.warn({ err: error, playerId: killerId }, "bone thrall check failed"));
      }
      try {
        if (hollinHutsRef?.ownsHutEntity(candidate.defeatedEntityId)) {
          // Raid loot goes through the ordinary reward settlement (loot cards), then the hut is
          // marked destroyed and its respawn scheduled.
          await settlements.accept(candidate);
          await hollinHutsRef.onHutDefeated(candidate.defeatedEntityId);
          void settlements.flush().catch((error: unknown) => {
            logger.warn({ err: error, settlementKey: candidate.settlementKey }, "durably accepted Hollin Hut reward remains queued for retry");
          });
          return true;
        }
        if (developerSpawnedMobsRef?.owns(candidate.defeatedEntityId)) {
          await settlements.accept(candidate);
          await developerSpawnedMobsRef.removeAfterDefeat(candidate.defeatedEntityId);
          void settlements.flush().catch((error: unknown) => {
            logger.warn(
              { err: error, settlementKey: candidate.settlementKey },
              "durably accepted developer mob reward remains queued for retry"
            );
          });
          return true;
        }
        if (
          candidate.bossOwnership?.hostKind === "dungeon" &&
          bossEncounterManagerRef?.ownsDefeatCandidate(candidate)
        ) {
          return await bossEncounterManagerRef.acceptDefeatCandidate(
            candidate,
            async (ownedCandidate) => {
              return bossRewardAdapter.settle(ownedCandidate.settlementKey, async () => {
                await settlements.accept(ownedCandidate);
                void settlements.flush().catch((error: unknown) => {
                  logger.warn(
                    { err: error, settlementKey: ownedCandidate.settlementKey },
                    "durably accepted dungeon boss reward remains queued for retry"
                  );
                });
                return true;
              });
            }
          );
        }
        const bossHandler = overworldBossEvents.handlerForDefeatCandidate(candidate);
        if (candidate.bossOwnership?.hostKind === "overworld" && !bossHandler) return false;
        if (bossHandler) {
          if (!(await bossHandler.acceptDefeat(candidate))) return false;
        } else {
          await settlements.accept(candidate);
          void settlements.flush().catch((error: unknown) => {
            logger.warn(
              { err: error, settlementKey: candidate.settlementKey },
              "durably accepted combat reward remains queued for retry"
            );
          });
        }
      } catch (error) {
        logger.warn(
          { err: error, settlementKey: candidate.settlementKey },
          "combat defeat remains non-final because durable reward acceptance failed"
        );
        return false;
      }
      return true;
    },
    onCombatAnalyticsEvent: (event) => {
      hollinHutsRef?.onCombatEvent(event);
      if (event.context !== "pvp_open_world") return;
      const recordForPlayer = (
        playerId: string,
        eventType: "damage_applied" | "damage_received" | "kill" | "death",
        otherActorId: string | null,
        targetId: string,
        priority: "critical" | "routine"
      ): void => {
        const connectionId = registry.activeConnectionIdForPlayer(playerId);
        const connection = connectionId
          ? registry.recordForConnection(connectionId)
          : null;
        telemetry.recordEvent({
          eventFamily: "combat",
          eventType,
          priority,
          playerId,
          otherActorId,
          targetId,
          sessionId: connection?.authSessionId ?? null,
          gameplayZoneId:
            combatRef?.entity(playerId)?.zoneId
            ?? gameState.getPlayer(playerId)?.regionCode
            ?? null,
          durationMs: null,
          metadata: {
            actorKind: event.actorKind,
            targetKind: event.targetKind,
            actorLevel: event.actorLevel,
            targetLevel: event.targetLevel,
            actorClassId: event.actorClassId,
            actorSubclassId: event.actorSubclassId,
            targetClassId: event.targetClassId,
            targetSubclassId: event.targetSubclassId,
            actorWeaponInstanceId: event.actorWeaponInstanceId,
            damageBeforeMitigation: event.damageBeforeMitigation,
            damage: event.damageApplied,
            mitigationBySource: event.mitigationBySource,
            sourceTechniqueId: event.sourceTechniqueId,
            distanceM: event.distanceM,
            targetHealthAfter: event.targetHealthAfter,
            pvp: true
          }
        });
      };
      if (event.kind === "damage_applied") {
        if (event.actorKind === "player") {
          recordForPlayer(
            event.actorId,
            "damage_applied",
            null,
            event.targetId,
            "routine"
          );
        }
        if (event.targetKind === "player") {
          recordForPlayer(
            event.targetId,
            "damage_received",
            event.actorId,
            event.targetId,
            "routine"
          );
        }
        return;
      }
      if (event.actorKind === "player") {
        recordForPlayer(
          event.actorId,
          "kill",
          null,
          event.targetId,
          "critical"
        );
      }
      if (event.targetKind === "player") {
        recordForPlayer(
          event.targetId,
          "death",
          event.actorId,
          event.targetId,
          "critical"
        );
      }
    },
    onCombatSummary: (summary) => {
      void achievements.flushPlayer(summary.playerId).then(async (newlyUnlocked) => {
        if (newlyUnlocked) {
          await publishBitterBloodUnlock(summary.playerId);
        } else {
          registry.send(summary.playerId, {
            type: "ACHIEVEMENT_SNAPSHOT",
            achievements: await achievements.snapshot(summary.playerId)
          });
        }
      }).catch((error: unknown) => {
        logger.warn(
          { err: error, playerId: summary.playerId },
          "failed to checkpoint poison achievement progress after combat"
        );
      });
      const result = combatTelemetry.enqueue(summary);
      if (!result.accepted) {
        logger.warn(
          { combatSessionId: summary.combatSessionId, reason: result.reason },
          "combat telemetry queue is full"
        );
      }
      const connectionId = registry.activeConnectionIdForPlayer(summary.playerId);
      const connection = connectionId
        ? registry.recordForConnection(connectionId)
        : null;
      telemetry.recordEvent({
        eventFamily: "combat",
        eventType: "combat_summary",
        priority: "important",
        eventTime: new Date(summary.endedAt),
        playerId: summary.playerId,
        sessionId: connection?.authSessionId ?? null,
        operationId: summary.combatSessionId,
        gameplayZoneId: combatRef?.entity(summary.playerId)?.zoneId ?? null,
        durationMs: summary.durationMs,
        appliedState: "applied",
        metadata: {
          activeClassId: summary.activeClassId,
          activeSubclassId: summary.activeSubclassId,
          initialEnemyQueueSize: summary.initialEnemyQueueSize,
          maximumEnemyQueueSize: summary.maximumEnemyQueueSize,
          enemyArchetypeCounts: summary.enemyArchetypeCounts,
          damageDealt: Object.values(summary.damageBySource).reduce(
            (total, amount) => total + amount,
            0
          ),
          damageReceived: summary.damageReceived,
          enemiesDefeated: summary.enemiesDefeated,
          playerSurvived: summary.playerSurvived,
          combatEndReason: summary.combatEndReason
        }
      });
    },
    onEquipmentCombatUpdatesApplied: ({ playerId, activationTick, updates, state }) => {
      for (const update of updates) {
        if (update.kind !== "kit_activation") continue;
        try {
          const applied = equipment.markActivationApplied(
            playerId,
            update.requestId,
            activationTick
          );
          registry.send(playerId, {
            type: "COMBAT_KIT_ACTIVATED",
            requestId: applied.requestId,
            kitIndex: applied.kitIndex,
            inventoryRevision: applied.inventoryRevision,
            activeRevision: applied.activeRevision,
            activationTick: applied.activationTick,
            replayed: applied.replayed,
            equipment: applied.equipment
          });
        } catch (error) {
          logger.error(
            {
              err: error,
              playerId,
              requestId: update.requestId,
              activationTick
            },
            "failed to finalize tick-boundary combat-kit activation"
          );
        }
      }
      const activeEquipment = equipment.runtimeSnapshot(playerId);
      if (activeEquipment) {
        installAuthoritativePlayerAppearance(
          gameState,
          activeEquipment,
          state.activeWeaponSlot
        );
      }
    },
    onWeaponSwitchCompleted: (playerId, activeWeaponSlot) => {
      const activeEquipment = equipment.runtimeSnapshot(playerId);
      if (activeEquipment) {
        installAuthoritativePlayerAppearance(
          gameState,
          activeEquipment,
          activeWeaponSlot
        );
      }
    }
  });
  const developerSpawnedMobs = new DeveloperSpawnedMobService(
    pool,
    combat,
    logger
  );
  const developerSpawnedPlants = new DeveloperSpawnedPlantService(pool, logger);
  developerSpawnedMobsRef = developerSpawnedMobs;
  const dogCompanions = new PetCompanionRuntime(combat, {
    onDeferredAbility: (ownerPlayerId, petId, outcome) => {
      void (async () => {
        const owner = await pets.ownerForPlayer(ownerPlayerId);
        if (!owner) return;
        const result = await pets.state(owner);
        const readyAt = dogCompanionsRef?.abilityReadyAt(ownerPlayerId) ?? {};
        registry.send(ownerPlayerId, {
          type: "PET_STATE",
          action: "ability",
          state: { ...result.state, pets: result.state.pets.map((pet) => pet.id === petId ? { ...pet, abilityReadyAt: readyAt } : pet) },
          notice: outcome.notice,
          ...(outcome.ping ? { ping: outcome.ping } : {})
        });
      })().catch((error: unknown) => logger.warn({ err: error, ownerPlayerId }, "pet deferred ability publish failed"));
    },
    partyMemberIds: (ownerPlayerId) => partyAuthority.partyForPlayer(ownerPlayerId)?.memberPlayerIds ?? [],
    onExpired: (ownerPlayerId, petId) => {
      enqueueDogPersistence(petId, () => endPetOuting(ownerPlayerId, petId, "expired"));
    },
    onOwnerDefeated: (ownerPlayerId, petId) => {
      enqueueDogPersistence(petId, () => endPetOuting(ownerPlayerId, petId, "defeated"));
    },
    onSentHome: (ownerPlayerId, petId) => {
      enqueueDogPersistence(petId, () => endPetOuting(ownerPlayerId, petId, "sent_home"));
    },
    findOpenLand: (ownerPlayerId, position) => findOpenLandForTravel(pool, flagService, ownerPlayerId, position),
    playerBaseSpeedMps: config.PLAYER_SPEED_MPS,
    boundaryForOwner: (ownerPlayerId) => {
      const player = gameState.getPlayer(ownerPlayerId);
      return player ? {
        anchor: { ...player.anchor },
        radiusM: player.moveLeashRadiusM,
        revision: player.relocationRevision ?? 0,
      } : null;
    },
  });
  dogCompanionsRef = dogCompanions;
  const minions = new MinionRuntime(combat, { playerBaseSpeedMps: config.PLAYER_SPEED_MPS });
  minionsRef = minions;
  const dogCompanionTick = setInterval(() => {
    dogCompanions.updateAll(Date.now());
    minions.updateAll(Date.now());
  }, 50);
  dogCompanionTick.unref();
  app.addHook("onClose", async () => clearInterval(dogCompanionTick));
  const revenantMetalUndead = new RevenantMetalUndeadRuntime(combat, {
    playerBaseSpeedMps: config.PLAYER_SPEED_MPS,
    isOverworldPresent: (playerId) =>
      gameState.isWorldPresent(playerId) && dungeonRef?.isInside(playerId) !== true,
    overworldPlayerIds: () => gameState.playerIds().filter((playerId) =>
      gameState.isWorldPresent(playerId) && dungeonRef?.isInside(playerId) !== true),
    store: new PostgresRevenantMetalLichStore(pool),
    onStoreError: (error, ownerPlayerId) =>
      logger.warn({ err: error, playerId: ownerPlayerId }, "Revenant Metal Lich persistence failed")
  });
  combat.setRevenantMetalHandler(revenantMetalUndead);
  const playerBuildings = new PlayerBuildingIndex(pool);
  combat.setPlayerBuildingLookup((position) => playerBuildings.hasBuildingNear(position));
  playerBuildings.start();
  app.addHook("onClose", async () => playerBuildings.stop());
  const revenantMetalUndeadTick = setInterval(() => {
    try {
      revenantMetalUndead.updateAll(Date.now());
    } catch (error: unknown) {
      logger.error({ err: error }, "Revenant Metal undead update failed");
    }
  }, 100);
  revenantMetalUndeadTick.unref();
  app.addHook("onClose", async () => {
    clearInterval(revenantMetalUndeadTick);
    await revenantMetalUndead.shutdown();
  });
  combatRef = combat;
  bossEncounterManagerRef = createCoreBossRuntime(combat, config.PLAYER_SPEED_MPS);
  // The framework adapter only coalesces concurrent callers. Durable identity
  // and replay safety remain owned by CombatRewardSettlementService below.
  const bossRewardAdapter = new IdempotentBossRewardAdapter();
  const xoralEvents = new XoralEventService(
    pool,
    combat,
    partyAuthority,
    gameState,
    registry,
    progression,
    equipment,
    logger,
    Math.random,
    overworldBossParticipantLeases,
    bossEncounterManagerRef
  );
  const legendaryBirdEvents = new LegendaryBirdEventService(
    pool,
    combat,
    settlements,
    flagService,
    registry,
    logger,
    Math.random,
    () => new Date(),
    bossEncounterManagerRef
  );
  overworldBossEvents.register(xoralEvents);
  overworldBossEvents.register(legendaryBirdEvents);
  await developerSpawnedMobs.recover();
  await developerSpawnedPlants.recover();
  await xoralEvents.recover();
  await legendaryBirdEvents.recover();
  const playerLocations = new PlayerLocationService(pool);
  const partyIdForPlayer = (playerId: string) =>
    partyAuthority.partyForPlayer(playerId)?.partyId ?? null;
  const developerSpawnedDungeons = new DeveloperSpawnedDungeonService(pool, undefined, logger);
  const fallenPrisonCrash = new FallenPrisonCrashService(pool, developerSpawnedDungeons, combat, logger, Date.now, {
    onlinePlayers: () => gameState.snapshots().map((player) => ({ playerId: player.playerId, position: { lat: player.lat, lon: player.lon } })),
    // The landing check spends from the rolled-entrance World budget and shares its failure pause.
    landAt: async (points) => (await worldDungeonEntrances.environmentsAt(points)).map((environment) => environment?.isLand ?? null),
    send: (playerId, message) => { registry.send(playerId, message); },
    connectionKey: (playerId) => registry.activeConnectionIdForPlayer(playerId)
  });
  await fallenPrisonCrash.recover();
  fallenPrisonCrash.start();
  // Drowned City entrances are derived from water sites; this instance only answers the coastal
  // ocean surface checks (World lookup, cached, fail closed). Dives and turn-ins use the realtime one.
  const drownedCitySites = new WaterSiteService({ pool, inventory, worldLookup, gameState, logger });
  const golemForgeSites = new GolemForgeSiteService({ pool, worldLookup });
  const worldDungeonEntrances = new WorldDungeonEntranceService({
    lookup: worldLookup ? worldDungeonEntranceLookupFromWorld(worldLookup) : undefined
  });
  const portals = createAshAtlasPortalRegistry(pool, {
    partyIdForPlayer,
    developerSpawnedDungeons,
    drownedCitySite: (siteId) => drownedCitySites.drownedCitySite(siteId),
    golemForgeSite: (entranceId) => golemForgeSites.siteForEntrance(entranceId),
    worldDungeonEntranceSite: (entranceId) => worldDungeonEntrances.siteForEntrance(entranceId)
  });
  const dungeonRewards = new DungeonRewardService(pool, undefined, { inventory, wallet });
  const cinderLanterns = new CinderLanternService({ pool, inventory, transaction: poolTransaction(pool) });
  const dungeonEntryCosts = dungeonEntryCostAuthorities(inventory);
  const wanderingMerchants: WanderingMerchantService = new WanderingMerchantService({
    pool,
    wallet,
    inventory,
    transaction: poolTransaction(pool),
    logger,
    onSpawned: (playerId) => {
      void wanderingMerchants.listActive(playerId)
        .then((merchants) => { registry.send(playerId, { type: "WANDERING_MERCHANTS", merchants }); })
        .catch((error: unknown) => logger.warn({ err: error, playerId }, "wandering merchant push failed"));
    }
  });
  const wanderingMerchantSweep = setInterval(() => {
    void wanderingMerchants.purgeExpired().catch((error: unknown) => logger.warn({ err: error }, "wandering merchant sweep failed"));
  }, 5 * 60_000);
  wanderingMerchantSweep.unref();
  app.addHook("onClose", async () => clearInterval(wanderingMerchantSweep));
  const dungeon = new CisternWarrensRuntime(pool, combat, playerLocations, undefined, {
    playerMovementSpeedMps: config.PLAYER_SPEED_MPS,
    partyIdForPlayer: (playerId) => partyAuthority.partyForPlayer(playerId)?.partyId ?? null,
    appearanceForPlayer: (playerId) => gameState.getPlayer(playerId)?.appearance,
    drownedCitySite: (siteId) => drownedCitySites.drownedCitySite(siteId),
    drownedCitySitesNear: (position, radiusM) => drownedCitySites.drownedCitySitesNear(position, radiusM),
    golemForgeSites,
    worldDungeonEntrances,
    isAfloat: (playerId) => gameState.isAfloat(playerId),
    onPlayerEjected: (playerId, location, snapshot) => {
      if (location) registry.send(playerId, { type: "PLAYER_LOCATION_SNAPSHOT", location });
      registry.send(playerId, { type: "DUNGEON_SNAPSHOT", snapshot });
    },
    loadPlayerAuthorities: async (playerId) => {
      const [inventorySnapshot] = await Promise.all([
        inventory.getInventorySnapshot(playerId),
        achievements.connectRuntime(playerId)
      ]);
      await cinderLanterns.warmChallengerRun(playerId).catch(() => undefined);
      const completedAchievements = achievements.achievementIds(playerId) ?? new Set<string>();
      return {
        items: inventorySnapshot.totals,
        questFlags: Object.fromEntries([...completedAchievements].map((id) => [id, true]))
      };
    },
    ...(config.ATLAS_PASS_DUNGEON_DISCOUNT_ENABLED
      ? { atlasPassEntryDiscount: hasActiveAtlasPass }
      : {}),
    canAffordEntryCost: async (playerId, items) => await cinderLanterns.hasCharge(playerId) || inventory.canAfford(
      playerId,
      items.map((item) => ({ itemId: item.itemId as ResourceType, quantity: item.quantity }))
    ),
    ...dungeonEntryCosts,
    chargeEntryCost: async (client, playerId, items, context) => {
      // A Cinder Lantern pays for one torch with one charge (once per run); any further torches the
      // player lit in the torch lobby are still paid from the pack.
      const torches = context.torches ?? 1;
      let owed = items;
      if (await cinderLanterns.useChargeForEntryInTransaction(client, playerId, context.runId)) {
        if (torches <= 1) return;
        owed = items.map((item) => ({ itemId: item.itemId, quantity: (item.quantity / torches) * (torches - 1) }));
      }
      await dungeonEntryCosts.chargeEntryCost(client, playerId, owed, context);
    },
    onDungeonLeft: async (event) => {
      const refund = await refundDungeonEntryTorch(pool, inventory, event);
      if (refund) {
        registry.send(event.playerId, {
          type: "INVENTORY_STACK_UPDATED",
          requestId: `dungeon-reentry-torch:${event.runId}`,
          action: "reorganize",
          inventory: refund.inventory,
          serverTime: Date.now(),
          message: "Delver's Lore: your entry torch was returned."
        });
      }
    },
    rescueAlly: (playerId) => { minions.summonRescuedValkyrie(playerId); },
    releaseAllies: (playerId) => { minions.despawnSpecies(playerId, "valkyrie"); },
    onDungeonCompleted: async (event) => {
      await wanderingMerchants.spawn({
        playerId: event.playerId,
        spawnKey: `dungeon-complete:${event.runId}`,
        dungeonId: event.dungeonId,
        dungeonName: event.dungeonName,
        entranceId: event.entrance.entranceId,
        regionCode: event.entrance.regionCode,
        entrance: { lat: event.entrance.lat, lon: event.entrance.lon }
      });
    },
    harvestResource: async (playerId, resourceType: DungeonResourceType, quantity, context) => {
      const result = await inventory.grantItemsForOperation({
        operationKey: `dungeon-resource:${context.runId}:${context.resourceId}:${context.requestId}`,
        playerId,
        source: "dungeon_resource_harvest",
        sourceEntityType: "dungeon_resource",
        sourceEntityId: context.resourceId,
        metadata: {
          dungeonId: context.dungeonId,
          instanceId: context.instanceId,
          runId: context.runId
        },
        grants: [{ itemId: resourceType, variant: null, quantity }]
      });
      return result.grants[0]?.grantedQuantity ?? 0;
    },
    grantReward: async (playerId, rewardTableId, rewardContext) => {
      if (!playerId) throw new Error("Dungeon player reward requires a player scope");
      try {
        const result = await dungeonRewards.grant({ playerId, rewardTableId, ...rewardContext });
        registry.send(playerId, {
          type: "DUNGEON_REWARD_GRANTED",
          ...(rewardContext.requestId ? { requestId: rewardContext.requestId } : {}),
          runId: rewardContext.runId,
          rewardSourceId: rewardContext.rewardSourceId,
          rewardTableId,
          applied: result.applied,
          inventory: result.inventory,
          wallet: result.wallet,
          items: [...result.items],
          gold: result.gold,
          message: result.applied
            ? "Dungeon reward granted."
            : "This dungeon reward was already claimed for this run."
        });
        // A granted claim is revealed by the client as a loot card (item art, names, quantities), so it
        // gets a snapshot only (the chest now reads as looted); replays and empty chests keep a HUD line.
        const inside = dungeonRef?.get(playerId);
        if (dungeonRef && inside) {
          registry.send(playerId, {
            type: "DUNGEON_SNAPSHOT",
            ...(rewardContext.requestId ? { requestId: rewardContext.requestId } : {}),
            snapshot: dungeonRewardSnapshot(dungeonRef, playerId, inside.sessionId, result)
          });
        }
      } catch (error) {
        registry.send(playerId, {
          type: "DUNGEON_ERROR",
          ...(rewardContext.requestId ? { requestId: rewardContext.requestId } : {}),
          code: "DUNGEON_REWARD_FAILED",
          message: error instanceof Error ? error.message : "The dungeon reward could not be granted."
        });
        throw error;
      }
    },
  }, undefined, undefined, developerSpawnedDungeons, bossEncounterManagerRef);
  dungeonRef = dungeon;
  const dungeonSkills = new DungeonSkillService(pool, inventory, skills);
  dungeonSkillsRef = dungeonSkills;
  dungeonSkills.setRingYieldSource((playerId) =>
    equipment.runtimeSnapshot(playerId)?.derivedStats.ringBonuses?.deepstone_yield ?? 0);
  const dungeonSkillAura = new DungeonSkillAuraRuntime({
    activePlayerIds: () => registry.activePlayerIds(),
    skills: dungeonSkills,
    combat,
    dungeon,
    partyMemberIds: (playerId) => partyAuthority.partyForPlayer(playerId)?.memberPlayerIds ?? []
  });
  const monolithService = new MonolithService(pool, inventory);
  monolithRuntime = new MonolithRuntime({
    pool,
    activePlayerIds: () => registry.activePlayerIds(),
    combat,
    onWorldMap: (playerId) => dungeon.dungeonIdFor(playerId) === null,
    retireFinished: () => monolithService.retireFinished()
  });
  const treasureService = new TreasureService(pool, inventory, equipment);
  const treasureRuntime = new TreasureRuntime({
    pool,
    playerPositions: () => registry.activePlayerIds().flatMap((playerId) => {
      const player = gameState.getPlayer(playerId);
      return player && dungeon.dungeonIdFor(playerId) === null
        ? [{ playerId, lat: player.position.lat, lon: player.position.lon }]
        : [];
    }),
    lookupLand: async (points) => {
      const environments = await worldLookup.lookupGameplayEnvironments(points, { caller: "other", priority: 1 });
      return environments.map((environment) => ({
        land: environment.ok && environment.isLand === true,
        label: environment.settlementName ?? environment.namedRiverName ?? environment.majorLakeName ?? null
      }));
    },
    expireFinished: () => treasureService.expireFinished()
  });
  const utilityGearHooks: UtilityGearHooks = {
    afterUse: async (playerId) => {
      const snapshot = await equipment.syncUtilityGear(playerId);
      registry.send(playerId, { type: "EQUIPMENT_SNAPSHOT", equipment: snapshot });
    }
  };
  const dungeonResourceHarvest = new DungeonResourceHarvestService({
    pool,
    dungeon,
    inventory,
    dungeonSkills,
    masteries,
    districtBenefits: cityService.districtBenefits,
    ringEquipment: equipment,
    onRingFound: (playerId, snapshot) => registry.send(playerId, { type: "EQUIPMENT_SNAPSHOT", equipment: snapshot }),
    onUtilityUse: (playerId) => utilityGearHooks.afterUse(playerId)
  });
  dungeon.onPlayerLeftRoom((playerId) => dungeonResourceHarvest.cancelActiveForPlayer(playerId));
  await settlements.recoverIncomplete();
  const manorPresence = new ManorPresenceService(pool, flagService, { inventory, wallet, premium: premiumWallet });
  const manorRuntime = new ManorRuntime(
    (playerId, manorId, x, y, spaceId = "manor_main_room") => Promise.all([
      manorPresence.persistLocalPosition(playerId, manorId, x, y),
      playerLocations.persistInteriorPosition({
        playerId, instanceId: `manor:${manorId}`, spaceId, x, y
      })
    ]),
    (error, context) => {
      logger.warn(
        { err: error, ...context },
        "failed to persist authoritative manor local position"
      );
    }
  );
  const greenhouseRuntime = new GreenhouseRuntime((input) =>
    playerLocations.persistInteriorPosition(input)
  );
  const inventoryProtection = new InventoryProtectionService(pool);
  const manorStorage = new ManorStorageService(
    pool,
    inventory,
    undefined,
    equipment,
    backpacks
  );
  const manorDecorations = new ManorDecorationService(pool, inventory);
  // Rooms entered through a door get the same decoration-aware navigation as the entry room.
  manorRuntime.useNavigationProvider((manorId, spaceId) => {
    try {
      return manorDecorations.navigationForManor(manorId, spaceId);
    } catch {
      return null;
    }
  });
  const salon = new SalonService(pool, config.RUNTIME_SHA ?? null);
  worldMapSalon = salon;
  const salonRuntime = new SalonRuntime((playerId, structureId, x, y) =>
    Promise.all([
      salon.persistLocalPosition(playerId, structureId, x, y),
      playerLocations.persistInteriorPosition({
        playerId, instanceId: `salon:${structureId}`, spaceId: "salon_main_room", x, y
      })
    ])
  );
  const partyCombatPublisher = new PartyCombatPublisher(
    partyAuthority,
    registry,
    gameState,
    combat
  );
  const partyReadyChecks = new PartyReadyCheckService(partyAuthority, registry);
  const dungeonTorchLobbies = new DungeonTorchLobbyService({
    dungeon,
    parties: partyAuthority,
    connections: registry,
    playerName: (playerId) => gameState.getPlayer(playerId)?.username ?? null,
    playerPosition: (playerId) => gameState.getPlayer(playerId)?.position ?? null,
    // Preview only (as canAffordEntryCost): a Cinder Lantern charge can pay a torch; startTorchRun enforces.
    canAfford: async (playerId, items) => await cinderLanterns.hasCharge(playerId) || inventory.canAfford(
      playerId,
      items.map((item) => ({ itemId: item.itemId as ResourceType, quantity: item.quantity }))
    )
  });
  const worldRuntime = new WorldRuntime(
    config,
    registry,
    gameState,
    combat,
    logger,
    manorRuntime,
    partyCombatPublisher
  );
  worldRuntimeRef = worldRuntime;
  const environmentProfileStore = new PostgresWorldEnvironmentProfileStore(
    pool,
    config.RESOURCE_JOB_MAX_ATTEMPTS,
    {
      worldIdentityKey: worldEnvironmentIdentityKey(requiredWorldIdentity),
      profileVersion: ENVIRONMENT_PROFILE_VERSION,
      candidateSlotVersion: CANDIDATE_SLOT_VERSION
    },
    config.POPULATION_V2_PROFILE_QUEUE_MAX
  );
  const supersededPopulationProfileJobs =
    await environmentProfileStore.supersedePopulationV2Jobs(
      "superseded by population-zone-plan-compiler-v3"
    );
  if (supersededPopulationProfileJobs > 0) {
    logger.info({
      supersededPopulationProfileJobs
    }, "superseded regenerable population v2 profile jobs");
  }
  const environmentProfiles = new GameplayEnvironmentProfileService(
    environmentProfileStore,
    512,
    logger
  );
  const populationBackgroundPressureElevated = (): boolean =>
    eventLoopDelay.percentile(95) / 1_000_000 > 50
    || pool.waitingCount > 0
    || (pool.totalCount > 0 && pool.idleCount < 1);
  const populationV2 = createPopulationZonesV2Composition({
    pool,
    config,
    worldIdentity: requiredWorldIdentity,
    worldLookup,
    combat,
    logger,
    backgroundPressureElevated: populationBackgroundPressureElevated,
    hostHealthy: () => !populationBackgroundPressureElevated(),
    onRuntimeMobSpawned: (entity, position) => {
      if (hollinHutsRef) void hollinHutSpawnAdopter(hollinHutsRef, logger)(entity, position);
    }
  });
  const goblinVillage = new GoblinVillageService(
    pool,
    config,
    worldLookup,
    cityService,
    flagService,
    inventory,
    equipment,
    backpacks,
    wallet,
    combat,
    populationV2.runtime
  );
  goblinVillageRef = goblinVillage;
  const hollinHuts = new HollinHutService({
    store: new PostgresHollinHutStore(pool),
    combat,
    wallet,
    inventory,
    ranks: dungeonSkills,
    transaction: poolTransaction(pool),
    onlinePlayers: () => gameState.playerIds()
      .filter((id) => gameState.isWorldPresent(id))
      .map((id) => gameState.getPlayer(id))
      .filter((player): player is NonNullable<typeof player> => Boolean(player?.online))
      .map((player) => ({ playerId: player.playerId, position: player.position })),
    biomeAt: (position) => biomeDiscovery.biomeAt(position),
    onRaidLoot: (event) => {
      registry.send(event.playerId, {
        type: "INVENTORY_STACK_UPDATED",
        requestId: `hollin-raid-loot:${event.hutId}:${event.playerId}`,
        action: "reorganize",
        inventory: event.inventory,
        serverTime: Date.now(),
        message: `The Hollin Hut falls. Your share: ${event.loot
          .map((entry) => `${entry.quantity} ${entry.itemId.replace(/_/gu, " ")}`).join(", ")}.`
      });
    },
    logger
  });
  hollinHutsRef = hollinHuts;
  await hollinHuts.recover();
  const hollinHutTick = setInterval(() => {
    void hollinHuts.tick().catch((error: unknown) => logger.warn({ err: error }, "hollin hut tick failed"));
  }, 1_000);
  hollinHutTick.unref();
  app.addHook("onClose", async () => clearInterval(hollinHutTick));
  const hollinHelpers = new HollinHelperService({
    combat,
    ranks: dungeonSkills,
    players: {
      onlineWorldPlayers: () => gameState.playerIds()
        .filter((id) => gameState.isWorldPresent(id))
        .map((id) => gameState.getPlayer(id))
        .filter((player): player is NonNullable<typeof player> => Boolean(player?.online))
    },
    droppedItems: droppedItemService,
    inventory,
    transaction: poolTransaction(pool),
    playerSpeedMps: config.PLAYER_SPEED_MPS,
    logger,
    onForaged: (event) => {
      registry.send(event.playerId, {
        type: "INVENTORY_STACK_UPDATED",
        requestId: `hollin-forage:${Date.now()}`,
        action: "reorganize",
        inventory: event.inventory,
        serverTime: Date.now(),
        message: event.kind === "berry"
          ? "Your Hollin helper gathered a Giving Berry."
          : `Your Hollin helper picked up ${event.quantity} ${event.itemId.replace(/_/gu, " ")}.`
      });
    }
  });
  const hollinHelperTick = setInterval(() => {
    void hollinHelpers.tick().catch((error: unknown) => logger.warn({ err: error }, "hollin helper tick failed"));
  }, 500);
  hollinHelperTick.unref();
  app.addHook("onClose", async () => clearInterval(hollinHelperTick));
  const givingSaplings = new GivingSaplingService(pool, inventory, {
    terrainAt: async (position) => {
      const environment = await worldLookup.lookupGameplayEnvironment(position.lat, position.lon);
      return environment.ok ? classifyFlagPlacementTerrain(environment) : "unknown";
    },
    territoryOwnerAt: async (position) => {
      const territory = await flagService.resolveTerritoryAtPoint(position.lat, position.lon);
      return territory.claimed ? territory.ownerPlayerId : null;
    },
    biomeAt: (position) => biomeDiscovery.biomeAt(position),
    // Healing saplings and grown player trees live in the combat engine's tree index, kept one tree at a time.
    aura: {
      upsert: (tree) => combat.upsertGivingTreeInSource("player-saplings", tree),
      remove: (treeId) => combat.removeGivingTreeFromSource("player-saplings", treeId)
    },
    nearbyTrees: (position, radiusM) => combat.nearbyKnownGivingTrees(position, radiusM),
    // Push each change only to the players within view of that tree, found through the combat engine's
    // spatial index (never a scan of all connections), batched into one message per player.
    onViewChange: (changes) => {
      fanOutSaplingViewChanges(changes, {
        nearbyPlayerIds: (position, radiusM) => combat.nearbyEntityIds(position, radiusM)
          .filter((entityId) => combat.entity(entityId)?.kind === "player"),
        playerPosition: (playerId) => {
          const viewer = gameState.getPlayer(playerId);
          return viewer && gameState.isWorldPresent(playerId) ? viewer.position : null;
        },
        send: (playerId, message) => { registry.send(playerId, message); }
      });
    }
  });
  // The full list loads once, here. After that only rows whose timer is due are touched.
  await givingSaplings.loadIndex().catch((error: unknown) => logger.warn({ err: error }, "sapling aura load failed"));
  const saplingTick = setInterval(() => {
    void givingSaplings.sweepDue().catch((error: unknown) => logger.warn({ err: error }, "sapling sweep failed"));
  }, 30_000);
  saplingTick.unref();
  app.addHook("onClose", async () => clearInterval(saplingTick));
  await goblinVillage.reconcileActiveVillages();
  const populationFlagLocalityWarmer = new PopulationFlagLocalityWarmer(
    pool,
    populationV2.planner,
    logger,
    {
      maximumFlags: config.POPULATION_LOCALITY_MAX_FLAGS,
      maximumDistinctZones: config.POPULATION_LOCALITY_MAX_DISTINCT_ZONES,
      interestTtlMs: config.POPULATION_LOCALITY_INTEREST_TTL_MS,
      fallbackFlagRadiusM: config.FLAG_RESOURCE_VISION_RADIUS_M
    }
  );
  const collectibleService = new CollectibleService(
    pool,
    worldLookup,
    config,
    logger,
    developerSpawnedPlants
  );
  const repeatableResourceService = new RepeatableResourceService(
    pool,
    inventory,
    masteries,
    undefined,
    new PermanentResourceLifecycleService(pool, undefined, logger)
  );
  repeatableResourceService.setUtilityGear(utilityGearHooks);
  furnaces.setUtilityGear(utilityGearHooks);
  givingSaplings.setTillerBoot({
    spendUses: async (client, playerId, count) =>
      (await spendUtilityGearUseInTransaction(client, playerId, "tiller_boot", count)) !== null,
    afterUse: (playerId) => utilityGearHooks.afterUse(playerId)
  });
  const utilityGearProximity = new UtilityGearProximityService({
    pool,
    saplings: givingSaplings,
    groveLoreRank: async (id) => { await dungeonSkills.ensureLoaded(id); return dungeonSkills.rankOf(id, "grove_lore"); },
    wallet,
    hooks: utilityGearHooks,
    onlineWorldPlayers: () => gameState.playerIds()
      .filter((id) => gameState.isWorldPresent(id))
      .map((id) => gameState.getPlayer(id))
      .filter((player): player is NonNullable<typeof player> => Boolean(player?.online)),
    onLodestoneDump: (event) => {
      // Same refresh the normal pickup path sends, so nearby clients drop the item at once.
      void publishCommittedGroundLoot(event.positions).catch(() => undefined);
      void inventory.snapshotInTransaction(pool, event.playerId).then((snapshot) => {
        registry.send(event.playerId, {
          type: "INVENTORY_STACK_UPDATED",
          requestId: `lodestone-dump:${event.playerId}:${Date.now()}`,
          action: "reorganize",
          inventory: snapshot,
          serverTime: Date.now(),
          message: `Your Lodestone Boot dumped ${event.dumped} item${event.dumped === 1 ? "" : "s"} for ${event.gold} gold.`,
          walletGold: event.walletGold,
          walletVersion: event.walletVersion
        });
      }).catch(() => undefined);
    },
    logger
  });
  const utilityGearProximityTick = setInterval(() => {
    void utilityGearProximity.tick().catch((error: unknown) => logger.warn({ err: error }, "utility gear proximity tick failed"));
  }, 1_500);
  utilityGearProximityTick.unref();
  app.addHook("onClose", async () => clearInterval(utilityGearProximityTick));
  const populationRealtime = new PopulationRealtimeAdapter({
    orchestrator: populationV2.orchestrator,
    registry,
    combat,
    teleportPublicationCoalescingEnabled:
      config.POPULATION_TELEPORT_PUBLICATION_COALESCING_ENABLED,
    queueBackgroundMobRollout: (zoneIds) =>
      populationV2.queueBackgroundMobRollout(zoneIds),
    updateWithheldPopulationZones: (delta) =>
      worldRuntime.updateWithheldPopulationZones(delta),
    localityWarmer: populationFlagLocalityWarmer
  });
  populationRealtime.start();
  const environmentProfileJobs = new GameplayEnvironmentProfileJobService(
    environmentProfileStore,
    new GameplayEnvironmentProfileMaterializer(worldLookup),
    logger,
    environmentProfiles,
    {
      leaseMs: config.RESOURCE_JOB_LEASE_MS,
      retryPollMs: config.RESOURCE_JOB_RETRY_POLL_MS,
      concurrency: config.ENVIRONMENT_PROFILE_PREPARATION_CONCURRENCY
    }
  );
  const harvestSessionService = new HarvestSessionService(
    pool,
    collectibleService,
    undefined,
    progression,
    masteries,
    cityService.districtBenefits,
    undefined,
    creatureBook,
    dungeonSkills
  );
  harvestSessionService.setUtilityGear(utilityGearHooks);
  harvestSessionService.setRingFinds(equipment, (playerId, snapshot) =>
    registry.send(playerId, { type: "EQUIPMENT_SNAPSHOT", equipment: snapshot }));
  const resourceVisionJobs = new ResourceVisionJobQueue(
    collectibleService,
    logger,
    new PostgresResourceVisionJobStore(
      pool,
      config.RESOURCE_JOB_PENDING_MAX,
      config.RESOURCE_JOB_MAX_ATTEMPTS
    ),
    config,
    config.RESOURCE_PREPARATION_CONCURRENCY
  );
  const populationFlagSuppressionCleanup =
    new PopulationFlagSuppressionCleanupWorker(
      pool,
      logger,
      populationBackgroundPressureElevated
    );
  const populationFlagPlanBackfill = new PopulationFlagPlanBackfillWorker(
    pool,
    populationV2.planner,
    logger,
    populationBackgroundPressureElevated,
    config.FLAG_RESOURCE_VISION_RADIUS_M
  );
  const authStore = new PostgresAuthStore(pool, config);
  const testAccess = new TestAccessService(pool, config);
  const authService = new AuthService(
    config,
    authStore,
    new GoogleAuthLibraryIdentityVerifier(config.GOOGLE_CLIENT_ID),
    logger,
    undefined,
    testAccess,
    createEmailSender(config, logger)
  );
  const appleAuth = new AppleAuthService(config, pool, authService);
  const trust = new TrustService(new PostgresTrustStateStore(pool), config, { logger });
  authService.setLoginTrustHook((accountId) => trust.onLogin(accountId));
  const landActions = new LandActionGate(new PostgresLandActionStore(pool), config, { logger, sink: trust });
  const settlement = new SettlementService(new PostgresSettlementStore(pool), config, {
    logger,
    sink: trust,
    invites: travelInvites,
    onInvitesInvalidated: async (playerIds) => {
      await Promise.all(playerIds.map(async (affectedPlayerId) => {
        if (!registry.activeConnectionIdForPlayer(affectedPlayerId)) return;
        registry.send(affectedPlayerId, {
          type: "TRAVEL_INBOX_SNAPSHOT",
          entries: await travelInvites.inboxForPlayer(affectedPlayerId),
          serverTime: Date.now()
        });
      }));
    }
  });
  authService.setSettlementStatusHook((accountId) => settlement.isSettled(accountId));
  // Provisional (grandfathered) Settled rows past their window are revoked hourly.
  const settlementExpiryTick = setInterval(() => {
    void settlement.expireProvisional()
      .then((expired) => {
        if (expired > 0) logger.info({ expired }, "Provisional Settled status expired");
      })
      .catch((error: unknown) => logger.warn({ err: error }, "Provisional Settled expiry failed"));
  }, 60 * 60_000);
  settlementExpiryTick.unref();
  app.addHook("onClose", async () => clearInterval(settlementExpiryTick));
  // Greppable server tick stats once a minute (`perf-server`), alongside the client `perf-sample` lines.
  const perfServerLog = setInterval(() => {
    logger.info({
      perfServer: {
        ...combat.tickHistorySnapshot(),
        worldStep: worldStepDuration.last,
        swing: combat.swingMetricsSnapshot()
      }
    }, "perf-server");
  }, 60_000);
  perfServerLog.unref();
  app.addHook("onClose", async () => clearInterval(perfServerLog));
  // Load the alert-zone grid at boot so a missing or corrupt file warns now.
  const populationGrid = getPopulationGrid(logger);
  populationGrid.isAvailable();
  const trustZones = new PostgresTrustZoneStore(pool);
  // Admin trust ops; also the suspension path for the new-account red-zone lock.
  const trustAdminOps = new TrustAdminOps({
    store: new PostgresTrustAdminOpsStore(pool),
    settlement,
    anchors: new PostgresDestinationAnchorStore(pool),
    closeConnections: (accountId, reason) => finalizeAccountConnections(accountId, 4003, reason),
    // Bound late: deviceEnvironment is created with the attestation providers below.
    onSpoofingLock: (accountId) => deviceEnvironment.markSpoofingLock(accountId)
  });
  const relocationGate = new RelocationGate({
    config,
    classify: (lat, lon) => populationGrid.classify(lat, lon),
    yellowOwners: (lat, lon, radiusKm, excludeAccountId, limit) =>
      trustZones.yellowOwners(lat, lon, radiusKm, excludeAccountId, limit),
    kingdomOwners: (lat, lon, radiusKm, excludeAccountId, limit) =>
      trustZones.kingdomOwners(lat, lon, radiusKm, excludeAccountId, limit),
    alerts: new PostgresTrustAlertStore(pool),
    redZoneLock: trustAdminOps,
    settlement,
    sink: trust,
    logger
  });
  // DB-IP Lite City + ASN; a missing database logs one warning and skips IP signals.
  const ipGeo = await createIpGeo({
    ...(config.TRUST_IPGEO_DIR ? { directory: config.TRUST_IPGEO_DIR } : {}),
    logger
  });
  // Device attestation (NATIVE_ANTISPOOF_BUILD_PLAN.md §8). Providers stay null
  // until enabled; TRUST_ATTESTATION_MODE=off hides the endpoints (404).
  const attestationStore = new PostgresAttestationStore(pool);
  const deviceCheckClient = config.TRUST_DEVICECHECK_ENABLED
    && config.TRUST_DEVICECHECK_KEY_ID
    && config.TRUST_DEVICECHECK_PRIVATE_KEY_P8_BASE64
    ? createDeviceCheckClient({
        teamId: config.TRUST_APP_ATTEST_APP_ID.split(".")[0]!,
        keyId: config.TRUST_DEVICECHECK_KEY_ID,
        privateKeyP8Base64: config.TRUST_DEVICECHECK_PRIVATE_KEY_P8_BASE64,
        environment: config.TRUST_DEVICECHECK_ENVIRONMENT,
        timeoutMs: config.TRUST_ATTEST_VERIFY_TIMEOUT_MS
      })
    : null;
  // Environment block + integrity signals (plan §8.9): shadow evidence only by default.
  const deviceEnvironment = new DeviceEnvironmentService(new PostgresDeviceEnvironmentStore(pool), config, {
    sink: trust,
    deviceCheck: deviceCheckClient,
    logger
  });
  const attestationService = config.TRUST_ATTESTATION_MODE === "off"
    ? null
    : new AttestationService(attestationStore, config, {
        playIntegrity: config.TRUST_PLAY_INTEGRITY_ENABLED
          ? createPlayIntegrityDecoder({
              packageName: config.TRUST_PLAY_INTEGRITY_PACKAGE_NAME,
              timeoutMs: config.TRUST_ATTEST_VERIFY_TIMEOUT_MS,
              auth: googleAccessTokenSource(config.TRUST_PLAY_INTEGRITY_CREDENTIALS_JSON_BASE64)
            })
          : null,
        deviceCheck: deviceCheckClient?.validate ?? null,
        environment: deviceEnvironment,
        sink: trust,
        revoke: (accountId, reason, metadata) => settlement.revoke(accountId, reason, metadata),
        logger
      });
  authService.setAttestationSessionConfig(() => attestationService?.sessionConfig());
  const locationReports = new LocationReportService(
    new PostgresLocationReportStore(pool),
    config,
    {
      logger,
      holdListener: landActions,
      sink: trust,
      familiarity: trust.isFamiliar,
      settlement,
      ipGeo,
      attestations: new AttestationResolver(attestationStore),
      accountLinks: new AccountLinkMonitor(new PostgresAccountLinkStore(pool), config, {
        sink: trust,
        alerts: new PostgresTrustAlertStore(pool),
        logger
      }),
      locationHistory: new LocationHistoryMonitor(new PostgresLocationHistoryStore(pool), config, {
        sink: trust,
        alerts: new PostgresTrustAlertStore(pool),
        logger
      })
    }
  );
  const altDoorwayStore = new PostgresAltDoorwayStore(pool);
  const altDoorway = new AltDoorwayGate(altDoorwayStore, config, {
    logger,
    sink: trust,
    devProfilesExempt: () => authService.developmentAuthEnabled,
    sharedNetworkBlock: createSharedNetworkBlock(altDoorwayStore, { logger })
  });
  const hostileGate = new HostileActionGate(new PostgresHostileGateStore(pool), config, {
    logger,
    sink: trust,
    devProfilesExempt: () => authService.developmentAuthEnabled
  });
  hostileGateRef = hostileGate;
  cityService.militaryIndustry?.setAutomaticFirePolicy((ownerPlayerId) => hostileGate.automaticFireAllowed(ownerPlayerId));
  const destinationAnchors = new DestinationAnchorGate(
    new PostgresDestinationAnchorStore(pool),
    new DestinationAnchoring(trustZones, config),
    config,
    { logger, sink: trust, devProfilesExempt: () => authService.developmentAuthEnabled }
  );
  // Personal flag access is the owner's choice whether or not they are
  // Settled (owner decision 2026-10-15); only harvest access stays gated.
  harvestAccess.setOpenPolicy((ownerPlayerId) =>
    destinationAnchors.checkOpenStructure({ playerId: ownerPlayerId, kind: "harvest_access" }));
  const trustArrivals = new TrustArrivalLog(new PostgresTrustArrivalStore(pool), config, {
    logger,
    classify: (lat, lon) => populationGrid.classify(lat, lon)
  });
  settlement.addStatusListener(async (accountId, change) => {
    hostileGate.refreshAccount(accountId);
    destinationAnchors.invalidate(accountId);
    if (change.revoked) await destinationAnchors.onRevoked(accountId);
  });
  const nativeAppAuthorization = new NativeAppAuthorization();
  const initialSpawns = new InitialSpawnSampler(config, worldLookup);
  const onboarding = new OnboardingService(
    pool,
    config,
    initialSpawns,
    pets,
    logger,
    undefined,
    testAccess
  );
  const profileSocial = new ProfileSocialService(pool, {
    playerPresence: (playerId) => presence.statusFor(playerId),
    playerAppearance: async (playerId, bodyVariantId) => {
      const liveAppearance = gameState.getPlayer(playerId)?.appearance;
      if (liveAppearance) return structuredClone(liveAppearance);
      const [equipmentSnapshot, salonAppearance] = await Promise.all([
        equipment.getSnapshot(playerId),
        salon.stylesForPlayer(playerId)
      ]);
      const appearance = projectPlayerAppearance(
        equipmentSnapshot,
        DEFAULT_PLAYER_APPEARANCE_CATALOG,
        {},
        undefined,
        bodyVariantId,
        salonAppearance.styles
      );
      return {
        ...appearance,
        revision: Math.max(appearance.revision, salonAppearance.revision)
      };
    },
    affiliations: new CityProfileAffiliationsResolver(pool),
    logger
  });
  const hotbar = new HotbarService(pool);
  const recentPlayers = new RecentPlayersService(pool, {
    playerPresence: (playerId) => presence.statusFor(playerId),
    logger
  });
  worldRuntime.setMutualPositionVisibilityEntryHandler((pairs) => {
    recentPlayers.recordMutualVisibility(pairs);
  });
  const moderationDispatcher = new BoundedModerationDispatcher(
    new InProcessChatModerationConsumer(async () => {
      // The local/HTTP/queue moderation model adapter is intentionally attached later.
    }),
    config.CHAT_MODERATION_QUEUE_LIMIT,
    2,
    (event, error) => {
      logger.warn(
        { err: error, messageId: event.messageId, channelId: event.channelId },
        "chat moderation event reached the dead-letter boundary"
      );
    }
  );
  const chatService = new ChatService(pool, {
    logger,
    moderationDispatcher,
    rateLimiter: new BoundedChatRateLimiter(50_000, config.CHAT_RATE_BUCKET_TTL_MS),
    recentCache: new BoundedRecentChatCache(
      config.CHAT_RECENT_CACHE_LIMIT,
      256,
      config.CHAT_RECENT_CACHE_TTL_MS
    ),
    messageMaxLength: config.CHAT_MESSAGE_MAX_LENGTH,
    historyPageSize: config.CHAT_HISTORY_PAGE_SIZE,
    catchUpLimit: config.CHAT_CATCH_UP_LIMIT,
    automatedMuteMaxDurationSeconds: config.CHAT_AUTOMATED_MUTE_MAX_SECONDS,
    worldId: config.WORLD_ID,
    requireCurrentTermsAcceptance: (playerId) =>
      communitySafety.hasCurrentTermsAcceptance(playerId)
  });
  const chatCrestService = new ChatCrestService(pool);
  const chatRealtime = new ChatRealtimeCoordinator(chatService, registry, {
    visiblePlayerIdsFor: (playerId) => worldRuntime.positionVisiblePlayerIdsFor(playerId),
    filterDirectlyInteractable: (playerId, candidatePlayerIds) =>
      profileSocial.filterDirectlyInteractable(playerId, candidatePlayerIds),
    hasActiveWorldTransition: (playerId) => worldRuntime.hasPlayerWorldTransition(playerId),
    onLocalDelivered: (senderPlayerId, recipientPlayerIds) => {
      recentPlayers.recordLocalDelivery(senderPlayerId, recipientPlayerIds);
    },
    onDeliveryError: (error, metadata) => {
      logger.warn({ err: error, ...metadata }, "local chat delivery failed after acceptance");
    }
  }, presence);
  const partyListings = new PartyListingService({
    chat: chatService,
    partyAuthority: () => partyAuthority,
    profile: async (playerId) => {
      const result = await pool.query<{ username: string | null; active_specialization_id: string | null; level: number | null }>(
        `SELECT player.username, specialization.active_specialization_id, progression.level
         FROM players player
         LEFT JOIN player_specialization_state specialization ON specialization.player_id = player.id
         LEFT JOIN player_progression_profiles progression ON progression.player_id = player.id
         WHERE player.id = $1`,
        [playerId]
      );
      const row = result.rows[0];
      const classId = row?.active_specialization_id ?? null;
      return {
        displayName: row?.username ?? "Unknown player",
        // A hidden old class (Ninja and the rest) reads as no class.
        classId: classId && (SPECIALIZATION_IDS as readonly string[]).includes(classId)
          && isSpecializationAvailable(classId as SpecializationId, skillSystemV3Capabilities)
          ? classId as SpecializationId
          : null,
        level: Math.max(1, Number(row?.level ?? 1))
      };
    },
    send: (playerId, message) => registry.send(playerId, message),
    sendToConnection: (connectionId, message) => registry.sendToConnection(connectionId, message),
    sendToConnectionIds: (connectionIds, message) => { registry.sendToConnectionIds(connectionIds, message); },
    huntingConnectionIds: () => new Set([
      ...chatRealtime.subscriptions.activeConnectionIds(CHAT_HUNTING_CHANNEL_KEY),
      ...chatRealtime.subscriptions.previewConnectionIds(CHAT_HUNTING_CHANNEL_KEY)
    ]),
    partyCreated: (playerId, requestId) => {
      const party = partyAuthority.partyForPlayer(playerId);
      registry.send(playerId, {
        type: "PARTY_SNAPSHOT",
        requestId,
        party,
        invites: [...partyAuthority.invitesForPlayer(playerId)],
        inboxInvites: [...partyAuthority.inboxInvitesForPlayer(playerId)],
        outgoingInvites: party ? [...partyAuthority.outgoingInvitesForParty(party.partyId)] : []
      });
      void chatRealtime.refreshAuthorizedPlayer(playerId).catch(() => undefined);
    }
  });
  if (config.CHAT_ENABLED) {
    await partyListings.load();
    partyListings.start();
    chatRealtime.partyListings = partyListings;
  }
  const marketReconciliation = new MarketReconciliationService(
    pool,
    () => new Date(),
    {
      statementTimeoutMs: config.MARKET_RECONCILIATION_STATEMENT_TIMEOUT_MS,
      advisoryLockTimeoutMs: config.MARKET_RECONCILIATION_LOCK_TIMEOUT_MS,
      transactionRetryLimit: config.MARKET_TRANSACTION_RETRY_LIMIT
    }
  );
  const marketReconciliationSupervisor = new MarketReconciliationSupervisor(
    marketReconciliation,
    logger,
    {
      intervalMs: config.MARKET_RECONCILIATION_INTERVAL_MS,
      staleAfterMs: config.MARKET_RECONCILIATION_STALE_AFTER_MS,
      reconciliationOptions: {
        recordCriticalAudit: true
      }
    }
  );
  const marketService = new MarketService(pool, config, logger, {
    access: new MarketAccessPolicy(config, gameState),
    inventory,
    wallet,
    equipment,
    onCommitted: (event) => {
      void publishMarketCommit(marketService, registry, event, logger).catch(
        (error: unknown) => {
          logger.warn({ err: error, itemIdentity: event.itemIdentity }, "failed to publish market update");
        }
      );
    },
    onInvariantFailure: () => {
      marketReconciliationSupervisor.requestImmediate("market_invariant_failure");
    }
  });
  for (;;) {
    const repaired = await marketService.repairLegacyCollections();
    logger.info(repaired, "market legacy Collection repair pass completed");
    if (
      repaired.material === 0 &&
      repaired.equipment === 0 &&
      repaired.equipmentGold === 0
    ) break;
  }
  const developmentEconomy = new DevelopmentEconomyService(pool, {
    wallet,
    premiumWallet,
    inventory,
    fishing,
    cityTreasury: cityService.structures?.treasury ?? null
  });
  const economyObservatory = new EconomyObservatoryService(pool);
  registry.attachEconomyActivity(economyObservatory);

  app.addHook("onRequest", async (request) => {
    logger.info(
      {
        requestId: request.id,
        method: request.method,
        url: requestPathForLog(request.url)
      },
      "request received"
    );
  });

  await app.register(cookie);
  await app.register(helmet, securityHeadersOptions(config));
  await app.register(rateLimit, {
    global: false
  });
  await app.register(cors, {
    origin: [
      ...config.AUTH_ALLOWED_ORIGINS,
      CAPACITOR_IOS_ORIGIN,
      CAPACITOR_ANDROID_ORIGIN
    ],
    credentials: true
  });
  installAuthGuard(app, config, authService);
  const accountConnections: AccountConnectionCloser = {
    finalizeAccountConnections: (accountId, code, reason) =>
      finalizeAccountConnections(accountId, code, reason)
  };
  registerAuthRoutes(
    app,
    authService,
    onboarding,
    config,
    accountConnections,
    nativeAppAuthorization,
    appleAuth
  );
  registerAccountDeletionRoutes(
    app,
    authService,
    new AccountDeletionService(pool),
    config,
    accountConnections
  );
  registerUpdateSubscriberRoutes(app, authService, new UpdateSubscriberService(pool));
  registerCommunitySafetyRoutes(app, communitySafety);
  registerChatTranslationRoutes(
    app,
    chatService,
    new ChatTranslationService(
      pool,
      new GoogleCloudTranslationProvider(config.CHAT_TRANSLATION_GOOGLE_API_KEY, {
        timeoutMs: config.CHAT_TRANSLATION_TIMEOUT_MS
      }),
      {
        monthlyCharacterCap:
          config.CHAT_TRANSLATION_MONTHLY_CHAR_CAP ?? CHAT_TRANSLATION_MONTHLY_CHARACTER_CAP_DEFAULT,
        onTranslationCreated: async (message, targetLanguage, translation) => {
          if (!message.channelId || !message.channelKey || !message.createdAt) return;
          await chatRealtime.broadcastTranslation({
            channelId: message.channelId,
            channelKey: message.channelKey,
            messageCreatedAt: new Date(message.createdAt),
            messageId: message.id,
            targetLanguage,
            translatedText: translation.translatedText,
            sourceLanguage: translation.sourceLanguage
          }).catch((error: unknown) => {
            logger.warn({ err: error, messageId: message.id }, "chat translation broadcast failed");
          });
        }
      }
    )
  );
  registerChatCrestRoutes(app, chatCrestService);
  registerRuntimePngContentRoutes(app);
  registerDeveloperCommunitySafetyRoutes(app, authService, communitySafety);
  registerDeveloperTrustRoutes(
    app,
    authService,
    new PostgresTrustAdminStore(pool),
    config,
    undefined,
    trustAdminOps,
    new TrustLab({
      config,
      classify: (lat, lon) => populationGrid.classify(lat, lon),
      zoneGridLoaded: () => populationGrid.isAvailable(),
      yellowOwners: (lat, lon, radiusKm, excludeAccountId, limit) =>
        trustZones.yellowOwners(lat, lon, radiusKm, excludeAccountId, limit),
      kingdomOwners: (lat, lon, radiusKm, excludeAccountId, limit) =>
        trustZones.kingdomOwners(lat, lon, radiusKm, excludeAccountId, limit),
      logger
    })
  );
  registerDeviceTrustRoutes(app, attestationService);
  const purchases = createPurchaseService(pool, config, logger, { wallet: premiumWallet, inventory });
  registerPurchaseRoutes(app, purchases);
  const googlePurchaseMaintenance = createGooglePurchaseMaintenance(
    purchases, config.PURCHASES_GOOGLE_VOIDED_SWEEP_MINUTES, logger
  );
  registerNativeAppRoutes(app, authService, config, nativeAppAuthorization);
  registerNativeBundleRoutes(app);
  registerAppearanceStudioRoutes(app, authService, config, gameState);
  registerTestAccessRoutes(app, authService, testAccess, accountConnections, {
    revalidateLiveSessions: (accountId) => revalidateLiveSessions(accountId)
  });
  registerProfileRoutes(
    app,
    profileSocial,
    config,
    registry,
    undefined,
    recentPlayers,
    gameState
  );
  registerHotbarRoutes(app, hotbar, logger);
  const refreshHolyArcRelations = async (playerIds: readonly string[]): Promise<void> => {
    const relations = await loadHolyArcRelations(pool, playerIds);
    for (const playerId of playerIds) combat.setHolyArcRelations(playerId, relations.get(playerId) ?? null);
  };
  registerHealTargetRoutes(app, new HealTargetService(pool), logger, (playerId) => {
    if (!config.CLERIC_ARC_ENABLED) return;
    void refreshHolyArcRelations([playerId]).catch((error: unknown) => {
      logger.warn({ err: error, playerId }, "failed to refresh holy arc relations after a settings change");
    });
  });
  registerWeeklyLeaderboardRoutes(app, weeklyLeaderboards);
  registerLegendJournalRoutes(app, new LegendJournalService(pool));
  registerDeveloperLeaderboardRoutes(app, authService, developerLeaderboards);
  registerEconomyObservatoryRoutes(app, authService, economyObservatory);
  registerDeveloperBugReportRoutes(app, authService, telemetry);
  registerDeveloperLegendaryBirdRoutes(app, authService, legendaryBirdEvents);
  const glimmerShop = new GlimmerShopService(pool, { inventory, equipment, premium: premiumWallet });
  registerDeveloperShopCatalogRoutes(app, authService, glimmerShop);
  registerAnnouncementRoutes(app, authService, playerAnnouncements, registry);
  registerFallenPrisonRoutes(app, authService, fallenPrisonCrash, developerSpawnedDungeons, gameState, registry);
  registerDeveloperWorldDungeonEntranceRoutes(app, authService, worldDungeonEntrances, gameState);
  registerWikiRoutes(app, config, wiki);
  registerFlagAccessRoutes(app, flagAccess, flagService, registry, logger);
  registerInscribeRoutes(app, jewelStation, logger);
  registerPathfinderMarkRoutes(app, new PathfinderMarkService(
    pool,
    flagAccess,
    async (playerId) => (await worldMapService.snapshot(playerId)).destinations
      .filter((destination) => destination.kind !== "pathfinder_mark"),
    (playerId) => utilityGearHooks.afterUse(playerId)
  ), logger);
  registerHarvestAccessRoutes(app, harvestAccess, registry, logger, gameState);
  registerInboxRoutes(app, inboxReadReceipts, logger);
  const nativePushService = new NativePushService(pool, config);
  registerNativePushRoutes(app, nativePushService);
  const nativePushWorker = new NativePushWorker(nativePushService, createNativePushSender(config), logger);
  const playerGifts = new PlayerGiftService(pool, {
    inventory,
    equipment,
    wallet,
    trustConfig: config,
    devProfilesExempt: () => authService.developmentAuthEnabled,
    pushAudience: { accounts: config.NATIVE_PUSH_ACCOUNT_ALLOWLIST, kinds: config.NATIVE_PUSH_CATEGORY_ALLOWLIST },
    pushEnqueueEnabled: config.NATIVE_PUSH_ENQUEUE_ENABLED
  });
  registerPlayerPackageRoutes(
    app,
    authService,
    playerPackages,
    registry,
    logger
  );
  const refreshKingdomPlayerStats = async (playerIds: string[]): Promise<void> => {
    await Promise.all([...new Set(playerIds)].map(async (affectedPlayerId) => {
      const [playerProgression, loadout, kingdomModifiers, skillSnapshot] = await Promise.all([
        progression.getOrCreate(affectedPlayerId),
        equipment.getSnapshot(affectedPlayerId),
        kingdomService.statModifiers(affectedPlayerId),
        skills.getOrCreate(affectedPlayerId)
      ]);
      const resolved = withSkillSystemV3Stats(
        playerProgression,
        loadout,
        skillSnapshot,
        kingdomModifiers
      );
      combat.updatePlayerPveStats(affectedPlayerId, {
        level: resolved.level,
        maxHealth: resolved.pveStats.maxHealth,
        attackPower: resolved.pveStats.attackPower,
        defense: resolved.pveStats.defense
      });
      registry.send(affectedPlayerId, { type: "PROGRESSION_SNAPSHOT", progression: resolved });
    }));
  };
  registerKingdomRoutes(
    app,
    kingdomService,
    flagService,
    gameState,
    registry,
    logger,
    config,
    refreshKingdomPlayerStats,
    chatRealtime
  );
  registerWarRoutes(app, new OrganizationWarService(pool), logger);
  registerMonolithRoutes(app, monolithService, gameState, async (playerId) =>
    dungeon.dungeonIdFor(playerId) === null && (await playerLocations.load(playerId)).kind === "world", logger);
  registerTreasureRoutes(app, treasureService, gameState, async (playerId) =>
    dungeon.dungeonIdFor(playerId) === null && (await playerLocations.load(playerId)).kind === "world", (playerId) => inventory.getInventorySnapshot(playerId), logger);
  registerCombatTelemetryRoutes(app, config, combatTelemetry, logger, authService);
  registerClientAudioReportRoutes(app, logger);
  registerClientMotionReportRoutes(app, logger);
  registerClientAttackAimReportRoutes(app, logger);
  registerClientDungeonStuckReportRoutes(app, logger);
  let devTeleportThroughTravel: DevTeleportThroughTravel | undefined;
  let scheduleRealtimePopulationRelocation:
    ((playerId: string) => boolean) | null = null;
  registerRoutes({
      infrastructure: {
          app: app,
          pool: pool,
          worldLookup: worldLookup,
          config: config,
          registry: registry,
          presence: presence,
          logger: logger
      },
      authority: {
          flags: flagService,
          players: playerService,
          gameState: gameState,
          auth: authService
      },
      capabilities: {
          collectibles: collectibleService,
          resourceVisionJobs: resourceVisionJobs,
          combat: combat,
          worldRuntime: worldRuntime,
          marketReconciliation: marketReconciliationSupervisor,
          marketMetrics: () => marketService.metricsSnapshot(),
          repeatableResources: repeatableResourceService,
          cities: cityService,
          worldMap: worldMapService,
          landActions,
          devTeleport: (playerId, requestId, destination) =>
              devTeleportThroughTravel?.(playerId, requestId, destination) ??
                Promise.resolve({
                  success: false as const,
                  reason: { code: "TRAVEL_UNAVAILABLE", message: "Travel is not ready" }
                }),
          schedulePopulationV2Relocation: (playerId) => {
              scheduleRealtimePopulationRelocation?.(playerId);
          }
      },
      operational: {
          populationFlagCleanup: () =>
            populationFlagSuppressionCleanup.metricsSnapshot(),
          combatRewards: settlements,
          populationV2: () => ({
              planner: populationV2.planner.snapshot(),
              runtime: populationV2.runtime.snapshot(),
              backend: populationV2.backend.snapshot(),
              locality: populationFlagLocalityWarmer.metricsSnapshot(),
              flagPlanBackfill: populationFlagPlanBackfill.metricsSnapshot()
          }),
          populationV2Materializations: () =>
            populationV2.store.loadMaterializationDiagnostics(
              [...POPULATION_V2_COMPATIBLE_MATERIALIZATION_REVISIONS]
            ),
          environmentProfiles: () => environmentProfiles.metricsSnapshot(),
          environmentProfileJobs: () => environmentProfileJobs.metricsSnapshot(),
          gameplayTick: () => latestWorldSchedulerMetrics
            ? { ...latestWorldSchedulerMetrics, stepDurationMs: worldStepDuration.last }
            : null,
          eventLoopDelay: () => ({
              p50Ms: eventLoopDelay.percentile(50) / 1000000,
              p95Ms: eventLoopDelay.percentile(95) / 1000000,
              p99Ms: eventLoopDelay.percentile(99) / 1000000,
              maxMs: eventLoopDelay.max / 1000000
          }),
          database: () => pool.metricsSnapshot()
      }
  });
  let persistRuntimeForDisconnect = (): Promise<void> =>
    playerPersistenceSupervisor.runPass().then(() => undefined);
  const lastInventoryTelemetryRevision = new Map<string, number>();
  const lastInventoryTelemetryCheckpointAt = new Map<string, number>();
  const lastInventoryTelemetrySnapshotId = new Map<string, string>();
  const captureTelemetryPlayerSnapshot = async (
    playerId: string,
    sessionId: string | null,
    reason: PlayerSnapshotInput["snapshotReason"]
  ): Promise<void> => {
    if (!config.TELEMETRY_ENABLED) return;
    const telemetrySessionId = telemetry.resolveSessionId(sessionId);
    const connectionId = registry.activeConnectionIdForPlayer(playerId);
    const connection = connectionId
      ? registry.recordForConnection(connectionId)
      : null;
    const [
      inventorySnapshot,
      progressionSnapshot,
      classSnapshot,
      masterySnapshot,
      equipmentSnapshot,
      databaseContext
    ] = await Promise.all([
      inventory.getInventorySnapshot(playerId),
      progression.getOrCreate(playerId),
      classes.getOrCreate(playerId),
      masteries.getOrCreate(playerId),
      equipment.runtimeSnapshot(playerId)
        ? Promise.resolve(equipment.runtimeSnapshot(playerId)!)
        : equipment.getSnapshot(playerId),
      pool.query<{
        gold_balance: string | null;
        inventory_revision: string | number;
        personal_flag_count: string | number;
        city_id: string | null;
        city_role: string | null;
        kingdom_id: string | null;
        kingdom_role: string | null;
        manor_id: string | null;
      }>(
        `SELECT
           (SELECT gold_balance::text FROM player_wallets WHERE player_id=$1)
             AS gold_balance,
           (SELECT COALESCE(max(id),0) FROM inventory_events WHERE player_id=$1)
             AS inventory_revision,
           (SELECT count(*) FROM flags
             WHERE owner_id=$1 AND control_type='personal') AS personal_flag_count,
           (SELECT city_id::text FROM city_memberships
             WHERE player_id=$1 AND left_at IS NULL
             ORDER BY joined_at DESC LIMIT 1) AS city_id,
           (SELECT role FROM city_memberships
             WHERE player_id=$1 AND left_at IS NULL
             ORDER BY joined_at DESC LIMIT 1) AS city_role,
           (SELECT kingdom_id::text FROM kingdom_memberships
             WHERE player_id=$1 AND status='active' LIMIT 1) AS kingdom_id,
           (SELECT role FROM kingdom_memberships
             WHERE player_id=$1 AND status='active' LIMIT 1) AS kingdom_role,
           COALESCE(
             (SELECT id::text FROM player_manors WHERE owner_player_id=$1),
             (SELECT manor_id::text FROM player_manor_presence WHERE player_id=$1)
           ) AS manor_id`,
        [playerId]
      ).then((result) => result.rows[0]!)
    ]);
    const inventoryRevision = Number(databaseContext.inventory_revision);
    const now = Date.now();
    const checkpointDue =
      now - (lastInventoryTelemetryCheckpointAt.get(playerId) ?? 0)
      >= config.TELEMETRY_INVENTORY_CHECKPOINT_INTERVAL_MS;
    const inventoryChanged =
      lastInventoryTelemetryRevision.get(playerId) !== inventoryRevision;
    let inventorySnapshotId: string | null = null;
    if (inventoryChanged || checkpointDue || reason !== "interval") {
      inventorySnapshotId = telemetry.recordInventorySnapshot({
        playerId,
        sessionId: telemetrySessionId,
        snapshotReason:
          reason === "interval"
            ? inventoryChanged
              ? "interval_changed"
              : "consistency_checkpoint"
            : reason,
        inventoryRevision,
        items: inventorySnapshot.items,
        itemStackCount: inventorySnapshot.items.length,
        totalQuantity: inventorySnapshot.items.reduce(
          (total, item) => total + item.quantity,
          0
        )
      });
      if (inventorySnapshotId) {
        lastInventoryTelemetryRevision.set(playerId, inventoryRevision);
        lastInventoryTelemetryCheckpointAt.set(playerId, now);
        lastInventoryTelemetrySnapshotId.set(playerId, inventorySnapshotId);
      }
    }
    const player = gameState.getPlayer(playerId);
    const combatSnapshot = combat.entity(playerId);
    telemetry.recordPlayerSnapshot({
      playerId,
      sessionId: telemetrySessionId,
      snapshotReason: reason,
      onlineDurationSeconds: connection
        ? Math.max(0, Math.floor((now - connection.connectedAt.getTime()) / 1_000))
        : 0,
      level: progressionSnapshot.level,
      totalXp: progressionSnapshot.totalXp,
      classId: classSnapshot.activeClassId,
      subclassId: classSnapshot.activeSubclassId,
      classLoadout: classSnapshot.loadout,
      professionProgression: masterySnapshot.professions,
      gold: databaseContext.gold_balance,
      inventoryRevision,
      inventorySnapshotId:
        inventorySnapshotId
        ?? lastInventoryTelemetrySnapshotId.get(playerId)
        ?? null,
      equipmentRevision: equipmentSnapshot.activeRevision,
      equippedItems: equipmentSnapshot.active,
      currentHp: combatSnapshot?.currentHealth ?? null,
      maximumHp: combatSnapshot?.maxHealth ?? null,
      lifeState: combatSnapshot?.lifeState ?? "alive",
      combatState: combatSnapshot?.activityState ?? null,
      personalFlagCount: Number(databaseContext.personal_flag_count),
      cityId: databaseContext.city_id,
      cityRole: databaseContext.city_role,
      kingdomId: databaseContext.kingdom_id,
      kingdomRole: databaseContext.kingdom_role,
      manorId: databaseContext.manor_id,
      partyId: partyAuthority.partyForPlayer(playerId)?.partyId ?? null,
      coarseZoneId: combatSnapshot?.zoneId ?? player?.regionCode ?? null,
      currentFlagId: gameState.currentFlagId(playerId),
      cumulativeCounters: {
        movementRevision: player?.movementRevision ?? null,
        relocationRevision: player?.relocationRevision ?? null
      },
      lastAuthoritativeActivityAt: connection?.lastMessageAt ?? null
    });
  };
  const captureBugReportContext = async (
    playerId: string,
    report: BugReportSubmitMessage
  ): Promise<BugReportAuthoritativeContext> => {
    const player = gameState.getPlayer(playerId);
    if (!player) throw new Error("reporting player is not present in the runtime");
    const combatPlayer = combat.entity(playerId);
    const equipmentSnapshot = equipment.runtimeSnapshot(playerId);
    const connectionId = registry.activeConnectionIdForPlayer(playerId);
    const connection = connectionId
      ? registry.recordForConnection(connectionId)
      : null;
    const databaseContext = await pool.query<{
      inventory_revision: string | number;
      city_id: string | null;
      kingdom_id: string | null;
      manor_id: string | null;
    }>(
      `SELECT
         (SELECT COALESCE(max(id),0) FROM inventory_events WHERE player_id=$1)
           AS inventory_revision,
         (SELECT city_id::text FROM city_memberships
           WHERE player_id=$1 AND left_at IS NULL
           ORDER BY joined_at DESC LIMIT 1) AS city_id,
         (SELECT kingdom_id::text FROM kingdom_memberships
           WHERE player_id=$1 AND status='active' LIMIT 1) AS kingdom_id,
         COALESCE(
           (SELECT id::text FROM player_manors WHERE owner_player_id=$1),
           (SELECT manor_id::text FROM player_manor_presence WHERE player_id=$1)
         ) AS manor_id`,
      [playerId]
    ).then((result) => result.rows[0]!);
    const canonicalRadiusM = Math.min(750, config.COMBAT_INTEREST_RADIUS_M);
    const nearbyIds = combat.nearbyEntityIds(player.position, canonicalRadiusM);
    const referencedIds = [
      report.clientState.selectedEntityId,
      report.clientState.combatTargetId,
      ...report.diagnostics.recentClientActions.map((entry) => entry.targetId)
    ].filter((value): value is string => Boolean(value));
    const priority = new Map<string, number>();
    referencedIds.forEach((entityId, index) => {
      const rank = index === 0 ? 0 : index === 1 ? 1 : 2;
      priority.set(entityId, Math.min(priority.get(entityId) ?? rank, rank));
    });
    const candidates: Array<{ entityId: string; [key: string]: unknown }> =
      [...new Set([...referencedIds, ...nearbyIds])]
      .map((entityId) => {
        const entity = combat.entity(entityId);
        if (!entity) return null;
        const distanceM = distanceMeters(player.position, {
          lat: entity.lat,
          lon: entity.lon
        });
        return {
          priority: priority.get(entityId) ?? 3,
          distanceM,
          value: {
            entityId: entity.entityId,
            entityType: entity.kind,
            entityCategory: entity.archetypeKey ?? entity.kind,
            position: { lat: entity.lat, lon: entity.lon },
            distanceM,
            clientClaimsVisible: referencedIds.includes(entity.entityId),
            serverVisibilityEligible: distanceM <= canonicalRadiusM,
            resourceVisionEligible: entity.kind !== "player",
            state: entity.lifeState === "alive"
              ? entity.activityState
              : entity.lifeState,
            spawnProvenance: "combat_runtime",
            cooldownOrRespawnAt: null,
            authorityType: "authoritative_runtime",
            combatTargetId: entity.targetEntityId,
            revision: entity.revision
          }
        };
      })
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
      .sort((left, right) =>
        left.priority - right.priority || left.distanceM - right.distanceM
      )
      .slice(0, 200)
      .map((entry) => entry.value);
    for (const entityId of referencedIds.slice(0, 16)) {
      if (candidates.some((entry) => entry.entityId === entityId)) continue;
      if (candidates.length >= 200) candidates.pop();
      candidates.push({
        entityId,
        entityType: entityId === report.clientState.selectedEntityId
          ? report.clientState.selectedEntityType ?? "unknown"
          : "unknown",
        entityCategory: "not_found",
        position: null,
        distanceM: null,
        clientClaimsVisible: true,
        serverVisibilityEligible: false,
        resourceVisionEligible: false,
        state: "not_found_at_snapshot_time",
        spawnProvenance: null,
        cooldownOrRespawnAt: null,
        authorityType: "authoritative_runtime",
        combatTargetId: null,
        revision: null
      });
      if (candidates.length >= 200) break;
    }
    return {
      playerState: {
        playerId,
        authoritativePosition: { ...player.position },
        coarseZoneId: combatPlayer?.zoneId ?? player.regionCode,
        currentFlagId: gameState.currentFlagId(playerId),
        visionAnchor: player.resourceVision
          ? {
              id: player.resourceVision.flagId,
              lat: player.resourceVision.center.lat,
              lon: player.resourceVision.center.lon
            }
          : null,
        movementAnchor: {
          id: gameState.currentFlagId(playerId),
          lat: player.anchor.lat,
          lon: player.anchor.lon
        },
        worldTransitionState: gameState.isWorldPresent(playerId)
          ? player.target ? "moving" : "world"
          : "manor_or_transition",
        currentHp: combatPlayer?.currentHealth ?? null,
        maximumHp: combatPlayer?.maxHealth ?? null,
        lifeState: combatPlayer?.lifeState ?? null,
        combatState: combatPlayer?.activityState ?? null,
        combatTargetId:
          combatPlayer?.pveCombat?.focusTargetEntityId
          ?? combatPlayer?.targetEntityId
          ?? null,
        partyId: partyAuthority.partyForPlayer(playerId)?.partyId ?? null,
        manorId: databaseContext.manor_id,
        cityId: databaseContext.city_id,
        kingdomId: databaseContext.kingdom_id,
        inventoryRevision: Number(databaseContext.inventory_revision),
        equipmentRevision: equipmentSnapshot?.activeRevision ?? null,
        pendingServerOperationIds: [],
        lastAuthoritativeActivityAt: connection?.lastMessageAt?.toISOString() ?? null,
        currentServerTick: combat.metricsSnapshot().currentServerTick,
        diagnosticRadiusM: canonicalRadiusM
      },
      nearbyEntities: candidates
    };
  };
  telemetry.setRunFreezeHandler(async (_runId, reason) => {
    await Promise.allSettled(
      registry.activePlayerIds().map((playerId) => {
        const connectionId = registry.activeConnectionIdForPlayer(playerId);
        const sessionId = connectionId
          ? registry.recordForConnection(connectionId)?.authSessionId ?? null
          : null;
        return captureTelemetryPlayerSnapshot(playerId, sessionId, "run_freeze");
      })
    );
    telemetry.freezeSessions(reason === "segment_rotation");
    lastInventoryTelemetryRevision.clear();
    lastInventoryTelemetryCheckpointAt.clear();
    lastInventoryTelemetrySnapshotId.clear();
  });
  const realtime = await registerRealtime({
      infrastructure: {
          app: app,
          registry: registry,
          logger: logger,
          config: config,
          worldLookup: worldLookup,
          telemetry,
          captureTelemetryPlayerSnapshot,
          captureBugReportContext
      },
      authority: {
          gameState: gameState,
          flagService: flagService,
          playerService: playerService,
          auth: authService,
          nativeAppAuthorization,
          worldRuntime: worldRuntime,
          flagAccess: flagAccess
      },
      capabilities: {
          collectibles: collectibleService,
          harvestSessions: harvestSessionService,
          dungeonResourceHarvest,
          balsamResin: balsamResin,
          fieldConsumables,
          resourceVisionJobs: resourceVisionJobs,
          droppedItems: droppedItemService,
          combat: combat,
          developerSpawnedMobs,
          developerSpawnedPlants,
          developerSpawnedDungeons,
          goblinVillage,
          hollinHuts,
          mapMarkers,
          wanderingMerchants,
          cinderLanterns,
          combatProfiles: combatProfiles,
          progression: progression,
          equipment: equipment,
          backpacks,
          inventoryProtection,
          cities: cityService,
          chats: config.CHAT_ENABLED ? chatRealtime : undefined,
          kingdoms: kingdomService,
          market: marketService,
          classes: classes,
          skills,
          specializations,
          partyAuthority: partyAuthority,
          partyCombatPublisher,
          partyReadyChecks,
          developmentEconomy: developmentEconomy,
          manorPresence: manorPresence,
          manorStorage: manorStorage,
          manorRuntime: manorRuntime,
          manorDecorations: manorDecorations,
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
          playerLocations,
          portals,
          travelInvites: travelInvites,
          directMessages: directMessageRealtime,
          recentPlayers: recentPlayers,
          repeatableResources: repeatableResourceService,
          inventory: inventory,
          databasePool: pool,
          starterInventory: inventory,
          masteries: masteries,
          worldMap: worldMapService,
          pets: pets,
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
          pvpStatus: {
            sendTo: (playerId) => sendPvpStatus(playerId),
            hasTimers: (playerId) => pvpTimers.timersFor(playerId).length > 0
          },
          destinationAnchors,
          trustArrivals
      },
      operations: {
          persistRuntimePlayers: () => persistRuntimeForDisconnect(),
          populationV2: populationRealtime,
          settleAndRespawnPlayer: async (playerId, complete) => {
            const operationKey = combat.deathPenaltyOperationKey(playerId);
            if (!operationKey) return false;
            pendingDeathPenalties.ensure(
              playerId,
              { operationKey, playerId, metadata: { recoveredFromCombatProfile: true } },
              persistDeathPenaltyAndRefresh
            );
            return pendingDeathPenalties.settleAndComplete(
              playerId,
              (input) => complete(input.operationKey)
            );
          }
      }
  });
  publishCommittedGroundLoot = realtime.refreshDroppedItemsNear;
  finalizeAccountConnections = (accountId, code, reason) =>
    realtime.finalizeAccountConnections(accountId, code, reason);
  revalidateLiveSessions = (accountId) => realtime.revalidateLiveSessions(accountId);
  devTeleportThroughTravel = (playerId, requestId, destination) =>
    realtime.devTeleport(playerId, requestId, destination);
  scheduleRealtimePopulationRelocation = (playerId) =>
    realtime.schedulePopulationRelocation(playerId);
  const workerLifecycle = new LifecycleSupervisor(
    config.SHUTDOWN_FLUSH_TIMEOUT_MS,
    (step) => {
      if (step.error || step.timedOut) {
        logger.error({ step }, "background lifecycle shutdown step failed");
      }
    }
  );
  workerLifecycle.register({
    name: "xoral events",
    start: () => undefined,
    stop: () => {
      xoralEvents.stop();
      bossEncounterManagerRef?.clearCasts();
    }
  });
  workerLifecycle.register({
    name: "fallen prison crash",
    start: () => undefined,
    stop: () => fallenPrisonCrash.stop()
  });
  workerLifecycle.register({
    name: "legendary bird events",
    start: () => undefined,
    stop: () => legendaryBirdEvents.stop()
  });
  workerLifecycle.register({
    name: "google purchase maintenance",
    start: () => googlePurchaseMaintenance.start(),
    stop: () => googlePurchaseMaintenance.stop()
  });
  workerLifecycle.register({
    name: "market reconciliation",
    start: () => marketReconciliationSupervisor.start(),
    stop: () => marketReconciliationSupervisor.stop()
  });
  workerLifecycle.register({
    name: "combat reward settlement",
    start: () => settlements.startSupervisor(config.COMBAT_REWARD_RETRY_INTERVAL_MS),
    stop: () => settlements.stopSupervisor()
  });
  workerLifecycle.register({
    name: "weekly leaderboard projection",
    start: () => weeklyLeaderboards.start(),
    stop: () => weeklyLeaderboards.stop()
  });
  workerLifecycle.register({
    name: "resource vision jobs",
    start: () => resourceVisionJobs.start(),
    stop: () => resourceVisionJobs.stop()
  });
  workerLifecycle.register({
    name: "population flag suppression cleanup",
    start: () => populationFlagSuppressionCleanup.start(),
    stop: () => populationFlagSuppressionCleanup.stop()
  });
  workerLifecycle.register({
    name: "population flag plan backfill",
    start: () => populationFlagPlanBackfill.start(),
    stop: () => populationFlagPlanBackfill.stop()
  });
  workerLifecycle.register({
    name: "environment profile jobs",
    async start() {
      await environmentProfileJobs.start();
      environmentProfiles.setJobNotifier(() => environmentProfileJobs.wake());
    },
    async stop() {
      environmentProfiles.setJobNotifier(null);
      await environmentProfileJobs.stop();
    }
  });
  try {
    await workerLifecycle.start();
  } catch (error) {
    populationRealtime.stop();
    await populationV2.close().catch(() => undefined);
    await app.close().catch(() => undefined);
    await partyAuthority.close().catch(() => undefined);
    await pool.end().catch(() => undefined);
    throw error;
  }

  let persistencePass: Promise<void> | null = null;
  const runPersistencePass = async (shutdown = false): Promise<void> => {
    await playerPersistenceSupervisor.runPass(
      shutdown ? { shutdown: true } : {}
    );
    const dirtyCombatProfiles = combat.peekDirtyProfiles();
    if (dirtyCombatProfiles.length > 0) {
      const result = await combatProfiles.persistProfiles(dirtyCombatProfiles);
      combat.markProfilesPersisted(result.persisted);
      if (result.failed.length > 0) {
        combat.notePersistenceFailure(true);
        logger.warn(
          { failedProfiles: result.failed.length },
          "failed to persist some combat profiles; they remain dirty for retry"
        );
      }
    }
    const dirtyClassRuntimes = combat.peekDirtyClassRuntimes();
    const persistedClassRuntimes: Array<{ playerId: string; version: number }> = [];
    for (const runtime of dirtyClassRuntimes) {
      try {
        if (runtime.skillV3) {
          await skills.persistRuntime(runtime.playerId, {
            cooldownEndsAt: runtime.cooldownEndsAt,
            statusEffects: runtime.statusEffects,
            counters: runtime.counters,
            engagedTarget: runtime.engagedTarget,
            combatGeneration: runtime.combatGeneration,
            revision: runtime.version
          });
        } else {
          await classes.persistRuntime(runtime.playerId, runtime);
        }
        persistedClassRuntimes.push({ playerId: runtime.playerId, version: runtime.version });
      } catch (error) {
        logger.warn(
          { err: error, playerId: runtime.playerId, skillSystem: runtime.skillV3 ? "v3" : "legacy" },
          "failed to persist combat runtime"
        );
      }
    }
    combat.markClassRuntimesPersisted(persistedClassRuntimes);
    const newlyUnlockedPlayerIds = await achievements.flushDirty();
    await Promise.all(newlyUnlockedPlayerIds.map((playerId) =>
      publishBitterBloodUnlock(playerId).catch((error: unknown) => {
        logger.warn({ err: error, playerId }, "failed to refresh equipment after retried achievement unlock");
      })
    ));
    await equipment.flushDirtyCheckpoints();
    await settlements.flush();
  };
  const persistDirtyPlayers = (shutdown = false): Promise<void> => {
    if (persistencePass) {
      return persistencePass;
    }
    persistencePass = runPersistencePass(shutdown).finally(() => {
      persistencePass = null;
    });
    return persistencePass;
  };
  persistRuntimeForDisconnect = () => persistDirtyPlayers();

  const tickDungeon = (deltaSeconds: number): void => {
    try { dungeonSkillAura.tick(); } catch (error) { logger.warn({ err: error }, "Dungeon skill aura tick failed"); }
    try { monolithRuntime?.tick(); } catch (error) { logger.warn({ err: error }, "Monolith runtime tick failed"); }
    try { treasureRuntime.tick(); } catch (error) { logger.warn({ err: error }, "Treasure runtime tick failed"); }
    void dungeon.tick(deltaSeconds, { movementAlreadyAdvanced: true }).then(() => {
      for (const active of dungeon.activeSnapshots()) {
        registry.send(active.playerId, {
          type: "DUNGEON_SNAPSHOT",
          snapshot: active.snapshot
        });
      }
    }).catch((error: unknown) => {
      logger.warn({ err: error }, "Cistern Warrens runtime tick failed");
    });
  };

  const tickSalon = (deltaSeconds: number): void => {
    for (const session of salonRuntime.tick(deltaSeconds)) {
      registry.send(session.playerId, {
        type: "SALON_POSITION",
        salonSessionId: session.sessionId,
        position: session.position,
        movementSequence: session.movementSequence,
        serverTime: Date.now()
      });
    }
  };

  const tickGreenhouse = (deltaSeconds: number): void => {
    for (const session of greenhouseRuntime.tick(deltaSeconds)) {
      registry.send(session.playerId, {
        type: "GREENHOUSE_POSITION",
        greenhouseSessionId: session.sessionId,
        position: session.position,
        movementSequence: session.movementSequence,
        serverTime: Date.now()
      });
    }
  };

  const worldScheduler = new FixedStepScheduler({
    stepHz: config.SERVER_TICK_HZ,
    maxCatchUpSteps: 4,
    onStep: (deltaSeconds) => {
      bossEncounterManagerRef?.tick(Date.now());
      combat.refreshBossEncounterProjections();
      const startedAt = performance.now();
      worldRuntime.tick(deltaSeconds, () => dungeon.advanceMovement(deltaSeconds));
      tickDungeon(deltaSeconds);
      tickSalon(deltaSeconds);
      tickGreenhouse(deltaSeconds);
      const durationMs = performance.now() - startedAt;
      worldStepDuration.steps += 1;
      worldStepDuration.totalMs += durationMs;
      if (durationMs > worldStepDuration.maxMs) worldStepDuration.maxMs = durationMs;
      if (config.TELEMETRY_ENABLED) telemetry.observeTick(durationMs);
    },
    onMetrics: (metrics: FixedStepSchedulerMetrics) => {
      latestWorldSchedulerMetrics = metrics;
      worldStepDuration.last = worldStepDuration.steps > 0
        ? { steps: worldStepDuration.steps, meanMs: worldStepDuration.totalMs / worldStepDuration.steps, maxMs: worldStepDuration.maxMs }
        : null;
      worldStepDuration.steps = 0;
      worldStepDuration.totalMs = 0;
      worldStepDuration.maxMs = 0;
      if (config.NODE_ENV === "development") {
        logger.info(metrics, "world fixed-step scheduler metrics");
      } else if (metrics.droppedBacklogSteps > 0 || metrics.backlogResetEvents > 0) {
        // Dropped ticks stall every walker for a step (docs/plans/move-smooth.md): always visible in production.
        logger.warn(metrics, "world fixed-step scheduler dropped backlog");
      }
    }
  });
  worldScheduler.start();
  let lastTelemetryCpuUsage = process.cpuUsage();
  const activatedMemberships = new Set<string>();
  const economySnapshotTask = new PeriodicTask({
    name: "economy observatory daily snapshot",
    intervalMs: 24 * 60 * 60_000,
    overlap: "skip-while-running",
    run: () => economyObservatory.captureSnapshot("24h").then(() => undefined),
    onError: (error) => logger.warn({ err: error }, "failed to capture economy observatory snapshot")
  });
  const periodicTasks = [
    new PeriodicTask({
      name: "closed-test server telemetry",
      intervalMs: config.TELEMETRY_SERVER_SAMPLE_INTERVAL_MS,
      overlap: "skip-while-running",
      run() {
        if (!config.TELEMETRY_ENABLED || !telemetryEventLoopDelay) return;
        const cpuUsage = process.cpuUsage(lastTelemetryCpuUsage);
        lastTelemetryCpuUsage = process.cpuUsage();
        const memory = process.memoryUsage();
        const world = worldRuntime.metricsSnapshot();
        const commands = worldRuntime.commands.metricsSnapshot();
        const network = registry.metricsSnapshot();
        const publisher = registry.realtimePublisherMetricsSnapshot();
        const database = pool.metricsSnapshot();
        const populationRuntime = populationV2.runtime.snapshot();
        const populationBackend = populationV2.backend.snapshot();
        const resourceVision = resourceVisionJobs.metricsSnapshot();
        telemetry.recordServerSample({
          active_players: registry.activePlayerIds().length,
          link_dead_players: registry.linkDeadPlayerCount(),
          active_websocket_connections: registry.activeConnectionCount(),
          connections_by_state: {
            active: registry.activeConnectionCount(),
            linkDead: registry.linkDeadPlayerCount()
          },
          process_cpu_user_ms: cpuUsage.user / 1_000,
          process_cpu_system_ms: cpuUsage.system / 1_000,
          process_rss_bytes: memory.rss,
          node_heap_used_bytes: memory.heapUsed,
          node_heap_total_bytes: memory.heapTotal,
          node_external_memory_bytes: memory.external,
          host_available_memory_bytes: freemem(),
          event_loop_delay_mean_ms:
            finiteOrNull(telemetryEventLoopDelay.mean / 1_000_000),
          event_loop_delay_p50_ms:
            finiteOrNull(telemetryEventLoopDelay.percentile(50) / 1_000_000),
          event_loop_delay_p95_ms:
            finiteOrNull(telemetryEventLoopDelay.percentile(95) / 1_000_000),
          eventLoopDelayP99Ms:
            finiteOrNull(telemetryEventLoopDelay.percentile(99) / 1_000_000),
          event_loop_delay_max_ms:
            finiteOrNull(telemetryEventLoopDelay.max / 1_000_000),
          current_server_tick: world.currentTick,
          world_command_queue_depth: commands.depth,
          world_command_queue_max_depth: commands.peakDepth,
          commands_accepted: commands.accepted,
          commands_processed: commands.processed,
          commands_rejected: commands.rejected,
          commands_duplicate: commands.duplicates,
          commands_stale: commands.stale,
          commands_overflowed: commands.globalOverflows + commands.playerOverflows,
          world_deltas_sent: world.worldDeltasSent,
          combat_deltas_sent: world.combatDeltasSent,
          websocket_messages_sent: sumMetricRecord(publisher.framesByMessageType),
          websocket_bytes_sent: sumMetricRecord(publisher.bytesByMessageType),
          websocket_messages_received: network.messagesReceived,
          websocket_bytes_received: network.bytesReceived,
          websocket_messages_by_family: network.messagesReceivedByFamily,
          replaceable_messages_skipped: network.replaceableSkipped,
          replaceable_messages_coalesced: network.replaceableCoalesced,
          backpressure_closures: network.backpressureClosures,
          gameplay_pool_total: database.connections.total,
          gameplay_pool_idle: database.connections.idle,
          gameplay_pool_active:
            Math.max(0, database.connections.total - database.connections.idle),
          gameplay_pool_waiting: database.connections.waiting,
          gameplay_query_timing: database.acquisitions,
          gameplay_database_errors: database.unexpectedIdleErrors.count,
          population_preparation_queue_depth:
            populationRuntime.activationRequests
            + populationRuntime.activationInFlight,
          population_preparation_timing:
            populationBackend.lastPreparationMsByPriority,
          resource_vision_queue_depth: resourceVision.pending + resourceVision.active,
          resource_vision_timing: resourceVision,
          service_uptime_seconds: process.uptime(),
          restart_boot_identifier: `${config.RUNTIME_LABEL ?? "server"}:${process.pid}`
        });
        telemetryEventLoopDelay.reset();
      }
    }),
    new PeriodicTask({
      name: "closed-test runtime world telemetry",
      intervalMs: config.TELEMETRY_WORLD_SAMPLE_INTERVAL_MS,
      overlap: "skip-while-running",
      run() {
        if (!config.TELEMETRY_ENABLED) return;
        const runtime = populationV2.runtime.snapshot();
        const encounters = combat.telemetryEncounterSnapshot();
        const activePlayers = registry.activePlayerIds().length;
        telemetry.recordWorldSamples([
          {
            scopeType: "global",
            scopeId: config.REGION_CODE,
            entityCategory: "population_zones",
            activeRuntimeCount: runtime.referencedZones,
            sleepingCount: Math.max(0, runtime.warmZones - runtime.referencedZones),
            metadata: {
              warmZones: runtime.warmZones,
              pendingPlanZones: runtime.pendingPlanZones,
              activationInFlight: runtime.activationInFlight,
              pendingSleepZones: runtime.pendingSleepZones,
              incompleteActivationZones: runtime.incompleteActivationZones
            }
          },
          {
            scopeType: "global",
            scopeId: config.REGION_CODE,
            entityCategory: "players",
            readyAliveCount: gameState.playerIds().length,
            activeRuntimeCount: activePlayers,
            sleepingCount: registry.linkDeadPlayerCount(),
            visibleCount: activePlayers
          },
          {
            scopeType: "global",
            scopeId: config.REGION_CODE,
            entityCategory: "active_population_zones",
            activeRuntimeCount: runtime.referencedZones
          },
          {
            scopeType: "global",
            scopeId: config.REGION_CODE,
            entityCategory: "sleeping_population_zones",
            sleepingCount: Math.max(0, runtime.warmZones - runtime.referencedZones)
          },
          {
            scopeType: "global",
            scopeId: config.REGION_CODE,
            entityCategory: "preparing_population_zones",
            activeRuntimeCount: runtime.pendingPlanZones,
            metadata: { activationInFlight: runtime.activationInFlight }
          },
          {
            scopeType: "global",
            scopeId: config.REGION_CODE,
            entityCategory: "active_combat_encounters",
            activeRuntimeCount: encounters.activeCombatEncounters
          },
          {
            scopeType: "global",
            scopeId: config.REGION_CODE,
            entityCategory: "active_pve_encounters",
            activeRuntimeCount: encounters.activePveEncounters
          },
          {
            scopeType: "global",
            scopeId: config.REGION_CODE,
            entityCategory: "active_pvp_encounters",
            activeRuntimeCount: encounters.activePvpEncounters
          },
          ...populationV2.runtime.telemetrySnapshot().map((sample) => ({
            scopeType: "zone" as const,
            scopeId: sample.zoneId,
            entityCategory: sample.entityCategory,
            readyAliveCount: sample.readyAliveCount,
            activeRuntimeCount: sample.activeRuntimeCount,
            sleepingCount: sample.sleepingCount,
            visibleCount: sample.visibleCount
          }))
        ]);
      }
    }),
    new PeriodicTask({
      name: "closed-test population reconciliation telemetry",
      intervalMs: config.TELEMETRY_WORLD_RECONCILIATION_INTERVAL_MS,
      overlap: "skip-while-running",
      async run() {
        if (!config.TELEMETRY_ENABLED) return;
        const samples = await populationV2.store.telemetryReconciliationSnapshot();
        telemetry.recordWorldSamples(samples.map((sample) => ({
          scopeType: "zone",
          scopeId: sample.zoneId,
          entityCategory: sample.entityCategory,
          plannedCount: sample.plannedCount,
          persistedCount: sample.persistedCount,
          readyAliveCount: sample.readyAliveCount,
          deadHarvestedCount: sample.deadHarvestedCount,
          respawnPendingCount: sample.respawnPendingCount,
          suppressedCount: sample.suppressedCount,
          reconciliationSource: "postgres_reconciliation"
        })));
        telemetry.recordWorldSamples(await loadGlobalWorldTelemetry(pool));
      },
      onError: (error) => {
        logger.warn({ err: error }, "closed-test population reconciliation failed");
      }
    }),
    new PeriodicTask({
      name: "closed-test player telemetry",
      intervalMs: config.TELEMETRY_PLAYER_SAMPLE_INTERVAL_MS,
      overlap: "skip-while-running",
      async run() {
        if (!config.TELEMETRY_ENABLED) return;
        const results = await Promise.allSettled(
          registry.activePlayerIds().map((playerId) => {
            const connectionId = registry.activeConnectionIdForPlayer(playerId);
            const sessionId = connectionId
              ? registry.recordForConnection(connectionId)?.authSessionId ?? null
              : null;
            return captureTelemetryPlayerSnapshot(playerId, sessionId, "interval");
          })
        );
        const failed = results.filter((result) => result.status === "rejected");
        if (failed.length > 0) {
          logger.warn(
            { failedPlayerSnapshots: failed.length },
            "closed-test player telemetry snapshot failed"
          );
        }
      }
    }),
    new PeriodicTask({
      name: "player persistence",
      intervalMs: 5_000,
      overlap: "coalesce-one",
      run: () => persistDirtyPlayers(),
      onError: (error) => logger.warn({ err: error }, "periodic player persistence failed")
    }),
    new PeriodicTask({
      name: "market order expiration",
      intervalMs: 5_000,
      overlap: "skip-while-running",
      run: () => marketService.expireDueOrders().then(() => undefined),
      onError: (error) => logger.warn({ err: error }, "failed to expire Market orders")
    }),
    new PeriodicTask({
      name: "authentication and market cleanup",
      intervalMs: 24 * 60 * 60_000,
      overlap: "skip-while-running",
      run: () => Promise.all([
        authService.cleanupExpiredData(),
        marketService.cleanupExpiredData()
      ]).then(() => undefined),
      onError: (error) => {
        logger.warn({ err: error }, "failed to clean expired authentication or market data");
      }
    }),
    new PeriodicTask({
      name: "Apple account-revocation jobs",
      intervalMs: 60_000,
      overlap: "skip-while-running",
      run: () => appleAuth.processDueRevocationJobs().then(() => undefined),
      onError: (error) => logger.warn({ err: error }, "failed to process Apple revocation jobs")
    }),
    economySnapshotTask,
    new PeriodicTask({
      name: "neutrality expiration",
      intervalMs: 5_000,
      overlap: "skip-while-running",
      async run() {
        const expired = await profileSocial.expireNeutralityRequests();
        publishExpiredNeutralityRequests(registry, expired);
      },
      onError: (error) => logger.warn({ err: error }, "failed to expire neutrality requests")
    }),
    new PeriodicTask({
      name: "chat metric logging",
      intervalMs: 60_000,
      overlap: "skip-while-running",
      run() {
        if (!config.CHAT_ENABLED) return;
        logger.info(
          {
            chat: chatRealtime.metrics(),
            moderation: moderationDispatcher.metricsSnapshot()
          },
          "chat operational metrics"
        );
      }
    }),
    new PeriodicTask({
      name: "environment metric logging",
      intervalMs: 60_000,
      overlap: "skip-while-running",
      run() {
        logger.info({
          profiles: environmentProfiles.metricsSnapshot(),
          jobs: environmentProfileJobs.metricsSnapshot()
        }, "gameplay environment profile metrics");
      }
    }),
    new PeriodicTask({
      name: "Kingdom perk qualification refresh",
      intervalMs: 1_000,
      overlap: "skip-while-running",
      run: () => refreshDueKingdomPerks(
        kingdomService,
        registry.activePlayerIds(),
        activatedMemberships,
        refreshKingdomPlayerStats
      ),
      onError: (error) => {
        logger.warn({ err: error }, "failed to refresh Kingdom perk qualification boundary");
      }
    }),
    new PeriodicTask({
      // Holy arc: kingdom, city, friends, wars and heal-target settings of every connected player, for the engine.
      name: "Holy arc relation sync",
      intervalMs: 2_000,
      overlap: "skip-while-running",
      run: async () => {
        if (!config.CLERIC_ARC_ENABLED) return;
        await refreshHolyArcRelations(registry.activePlayerIds());
      },
      onError: (error) => {
        logger.warn({ err: error }, "failed to sync holy arc relations");
      }
    }),
    new PeriodicTask({
      name: "Kingdom combat perk sync",
      intervalMs: 2_000,
      overlap: "skip-while-running",
      run: () => syncKingdomCombatPerks(
        pool,
        combat.kingdomPerkFootprints(),
        (playerId, effects) => combat.setPlayerKingdomPerkEffects(playerId, effects),
        new Date(),
        (position, radiusM) => dungeonRef?.isNearDungeonEntrance(position, radiusM) ?? false
      ),
      onError: (error) => {
        logger.warn({ err: error }, "failed to sync Kingdom combat perks");
      }
    })
  ];
  presence.start();
  for (const task of periodicTasks) task.start();
  economySnapshotTask.trigger();
  const combatTelemetryFlush = startCombatTelemetryFlushLoop(combatTelemetry, logger);

  let appCloseResult: Promise<void> | null = null;
  const lifecycle = new LifecycleSupervisor(
    config.SHUTDOWN_FLUSH_TIMEOUT_MS,
    (step) => {
      if (step.error || step.timedOut) {
        logger.error({ step }, "application lifecycle shutdown step failed");
      } else {
        logger.info({ step }, "application lifecycle shutdown step completed");
      }
    }
  );
  lifecycle.adopt({ name: "PostgreSQL pool", stop: () => pool.end() });
  lifecycle.adopt({ name: "Hunting party cards", stop: () => partyListings.stop() });
  nativePushWorker.start();
  lifecycle.adopt({ name: "native notification delivery", stop: () => nativePushWorker.stop() });
  lifecycle.adopt({
    name: "closed-test telemetry drain",
    stop: () => telemetry.shutdown()
  });
  lifecycle.adopt({ name: "party authority", stop: () => partyAuthority.close() });
  lifecycle.adopt({ name: "party ready checks", stop: () => partyReadyChecks.close() });
  lifecycle.adopt({ name: "dungeon torch lobbies", stop: () => dungeonTorchLobbies.close() });
  lifecycle.adopt({
    name: "HTTP close",
    stop: () => appCloseResult ?? Promise.reject(new Error("HTTP close was not initiated"))
  });
  lifecycle.adopt({
    name: "durable offline marker",
    stop: () => playerService.markManyOffline(gameState.playerIds())
  });
  lifecycle.adopt({ name: "recent players drain", stop: () => recentPlayers.drain() });
  lifecycle.adopt({
    name: "combat telemetry drain",
    async stop() {
      combatTelemetryFlush.stop();
      await combatTelemetryFlush.flushRemaining();
    }
  });
  lifecycle.adopt({
    name: "runtime persistence drain",
    async stop() {
      playerPersistenceSupervisor.stopAccepting();
      await manorRuntime.flushAll();
      await persistDirtyPlayers(true);
      if (gameState.dirtyPlayerMetrics().count > 0) await persistDirtyPlayers(true);
      await playerPersistenceSupervisor.waitForIdle();
      if (gameState.dirtyPlayerMetrics().count > 0) {
        throw new Error("mandatory player persistence remained dirty");
      }
    }
  });
  lifecycle.adopt({
    name: "background workers",
    async stop() {
      const report = await workerLifecycle.shutdown();
      if (!report.durable) throw new Error("mandatory background worker shutdown failed");
    }
  });
  lifecycle.adopt({
    name: "Population V2",
    async stop() {
      await populationV2.close();
    }
  });
  lifecycle.adopt({
    name: "Population V2 delta publication",
    stop: () => populationRealtime.stop()
  });
  lifecycle.adopt({
    name: "WebSocket authority",
    stop: () => realtime.shutdownConnections()
  });
  lifecycle.adopt({
    name: "presence authority",
    stop: () => presence.stop()
  });
  lifecycle.adopt({
    name: "periodic tasks",
    stop: () => Promise.all(periodicTasks.map((task) => task.stop())).then(() => undefined)
  });
  lifecycle.adopt({
    name: "World batch admission",
    stop: () => worldLookup.shutdownBatchAdmission()
  });
  lifecycle.adopt({
    name: "world scheduler",
    stop() {
      worldScheduler.stop();
      eventLoopDelay.disable();
      telemetryEventLoopDelay?.disable();
    }
  });
  lifecycle.adopt({
    name: "new HTTP authority",
    stop() {
      appCloseResult ??= app.close();
      void appCloseResult.catch(() => undefined);
    }
  });

  const shutdown = async (signal: string): Promise<boolean> => {
    logger.info({ signal }, "shutting down");
    const report = await lifecycle.shutdown();
    return report.durable;
  };

  try {
    await app.listen({ host: "127.0.0.1", port: config.PORT });
  } catch (error) {
    await lifecycle.shutdown();
    throw error;
  }
  logger.info(publicConfigSummary(config), "Ash Atlas game server started");
  return {
    shutdown,
    reportFatal(reason, origin) {
      logger.fatal(
        {
          err: reason,
          origin,
          serviceUptimeSeconds: process.uptime(),
          releaseSha: config.RUNTIME_SHA ?? null
        },
        "fatal process event terminated the game runtime"
      );
    }
  };
}

function finiteOrNull(value: number): number | null {
  return Number.isFinite(value) ? value : null;
}

function sumMetricRecord(record: Readonly<Record<string, number>>): number {
  return Object.values(record).reduce((total, value) => total + value, 0);
}
