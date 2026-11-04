import {
  CITY_STRUCTURE_SNAPSHOT_RADIUS_M,
  DEFAULT_FLAG_CLAIM_RADIUS_M,
  HUNGER_BASE_CAPACITY,
  applySkillSystemV3CombatStats,
  applyClassCombatStats,
  isEquipmentDefinitionId,
  levelUpHealth,
  manorAuthoredRoom,
  resolveManorTypeId,
  requireEquipmentDefinition,
  resolveV3DefenseProfileForEquipmentFamily,
  resolveV3WeaponProfileForEquipmentFamily,
  type HarvestSessionSnapshot,
  type ClassCombatState,
  type ClassSnapshot,
  type CombatEntitySnapshot,
  type EquipmentSnapshot,
  type EquipmentSnapshotV2,
  type KingdomStatModifiers,
  type ManorSpaceId,
  type ProgressionSnapshot,
  type ResourceVision,
  type ServerMessage,
  type TravelInboxEntry,
  type WorldViewAuthority,
  ASH_ATLAS_MIN_PROTOCOL_VERSION,
  ASH_ATLAS_MAX_PROTOCOL_VERSION,
  createVersionClients
} from "@ash-atlas/shared";

import type { AuthService } from "../../auth/authService.js";
import type { HostileActionGate } from "../../auth/trust/hostileGate.js";
import type { SettlementService } from "../../auth/trust/settlement.js";
import type { LandActionGate } from "../../auth/trust/trustService.js";
import { AuthError, type AuthenticatedSession } from "../../auth/types.js";
import type { AppConfig } from "../../config.js";
import type { AppLogger } from "../../logger.js";
import type { CityService } from "../../game/cities.js";
import type { ClassService } from "../../game/classes/classService.js";
import type { SkillService } from "../../game/skills/index.js";
import type { CollectibleService } from "../../game/collectibles.js";
import type { BalsamResinService } from "../../game/balsamResin.js";
import type { FieldConsumableService } from "../../game/fieldConsumables.js";
import type { BackpackService } from "../../game/backpacks.js";
import {
  playerEquipmentCombatStateFromSnapshot,
  type CombatEngine
} from "../../game/combat/combatEngine.js";
import type { CombatProfileService } from "../../game/combat/combatProfiles.js";
import type { DroppedItemService } from "../../game/droppedItems.js";
import type { CisternWarrensRuntime } from "../../game/dungeon.js";
import type { EquipmentRuntimeContext, EquipmentService } from "../../game/equipment.js";
import type { AchievementService } from "../../game/achievements.js";
import { installAuthoritativePlayerAppearance } from "../../game/appearanceProjection.js";
import type { FlagAccessService } from "../../game/flagAccess.js";
import type { FlagBuildCoordinator } from "../../game/flagBuildCoordinator.js";
import type { FurnaceService } from "../../game/furnaces.js";
import type { TanneryService } from "../../game/tanneries.js";
import type { LoomService } from "../../game/looms.js";
import type { KitchenService } from "../../game/kitchens.js";
import type { GreenhouseService } from "../../game/greenhouses.js";
import type { GreenhouseRuntime } from "../../game/greenhouseRuntime.js";
import { greenhouseStateForCropCapableClient } from "../../game/greenhouseCropContent.js";
import type { FishingService } from "../../game/fishing.js";
import type {
  CityFlagConversionCoordinator
} from "../../game/cityFlagConversionCoordinator.js";
import {
  BUOY_BUILD_RECIPE,
  FLAG_BUILD_RECIPE,
  type FlagService
} from "../../game/flags.js";
import type { InventoryService } from "../../game/inventory.js";
import type { InventoryProtectionService } from "../../game/inventoryProtection.js";
import type { LegendaryBirdEventService } from "../../game/legendaryBirdEvents.js";
import { ensureStarterResources } from "../../game/starterResources.js";
import type { KingdomService } from "../../game/kingdoms.js";
import type {
  ManorPresenceService,
  ManorPresence,
  ManorRuntime,
  ManorStorageService
} from "../../game/manor.js";
import type { ManorDecorationService } from "../../game/manorDecorations.js";
import type { MasteryService } from "../../game/masteries.js";
import type { MutablePartyAuthority } from "../../game/party/PartyAuthority.js";
import type { PetService } from "../../game/petService.js";
import type { PetCompanionRuntime } from "../../game/combat/petCompanionRuntime.js";
import type { PlayerService } from "../../game/players.js";
import type { PlayerLocationService } from "../../game/locations/playerLocationService.js";
import { loadMaxHealthPenaltySafely, type ProgressionService } from "../../game/progression.js";
import type { ResourceVisionJobQueue } from "../../game/resourceVisionJobs.js";
import type { GameState, PlayerRecord } from "../../game/state.js";
import type { TravelInviteService } from "../../game/travelInvites.js";
import { packageIdForPosition, zoneIdForPosition } from "../../game/spatialZones.js";
import type { WorldMapService } from "../../game/worldMap.js";
import type { WorldCommandInput } from "../../game/worldCommandQueue.js";
import type { WorldRuntime } from "../../game/worldRuntime.js";
import type { WalletService } from "../../game/wallet.js";
import type { PremiumWalletService } from "../../game/premiumWallet.js";
import type { XoralEventService } from "../../game/xoralEvents.js";
import type { SalonPresence, SalonRuntime, SalonService } from "../../game/salon.js";
import type { ConnectionCloseRegistry, ConnectionGenerationLedger } from "../connectionLifecycle.js";
import type { ConnectionRegistry, SocketLike } from "../connectionRegistry.js";
import type { ReconnectLeaseCoordinator } from "../reconnectLeaseCoordinator.js";
import {
  BootstrapAttemptInactiveError,
  type BootstrapAttempt,
  type BootstrapAttemptCoordinator
} from "../bootstrapAttemptCoordinator.js";
import type { PartyRealtimeState } from "../partyRealtimeState.js";
import type { PartyCombatPublisher } from "../partyCombatPublisher.js";
import type { PartyReadyCheckService } from "../partyReadyCheckService.js";
import type { DungeonTorchLobbyService } from "../dungeonTorchLobbyService.js";
import type { MessageForFamily } from "../messageRouter.js";
import type { ScheduledPopulationV2Relocation } from "../populationRealtimeOperations.js";
import type { CombatScopeSnapshotPublication } from "../realtimeSnapshotOperations.js";
import { publishFlagSnapshot } from "../flagSnapshotPublisher.js";
import { readPublishedVersionMetadata } from "../publishedVersionMetadata.js";
import type { SessionConnectionState } from "./sessionHandler.js";

type ConnectionWorldCommand = WorldCommandInput extends infer Command
  ? Command extends WorldCommandInput
    ? Omit<Command, "playerId" | "accountId" | "connectionId">
    : never
  : never;

export function isCurrentPostWelcomeConnection(input: Readonly<{
  registry: Pick<ConnectionRegistry, "isActivePlayerConnection">;
  connectionGenerations: Pick<ConnectionGenerationLedger, "isCurrent">;
  playerId: string;
  connectionId: string;
  connectionGeneration: number;
}>): boolean {
  return input.registry.isActivePlayerConnection(
    input.playerId,
    input.connectionId
  ) && input.connectionGenerations.isCurrent(
    input.playerId,
    input.connectionGeneration
  );
}

type SessionBootstrapDependencies = Readonly<{
  state: SessionConnectionState;
  socket: SocketLike;
  acceptedAtMs: number;
  bootstrapAttempts: BootstrapAttemptCoordinator;
  setBootstrapAttempt(attempt: BootstrapAttempt | null): void;
  authenticatedSession: AuthenticatedSession | null | undefined;
  auth?: AuthService | undefined;
  config?: AppConfig | undefined;
  logger: AppLogger;
  registry: ConnectionRegistry;
  connectionGenerations: ConnectionGenerationLedger;
  connectionCloseRegistry: ConnectionCloseRegistry;
  reconnectLeases: ReconnectLeaseCoordinator;
  harvestReconnectLeases: ReconnectLeaseCoordinator;
  partyRealtimeState: PartyRealtimeState;
  playerService: PlayerService;
  playerLocations?: PlayerLocationService | undefined;
  gameState: GameState;
  flagService: FlagService;
  flagAccess?: FlagAccessService | undefined;
  flagBuilds: FlagBuildCoordinator | null;
  furnaces?: FurnaceService | undefined;
  tanneries?: TanneryService | undefined;
  looms?: LoomService | undefined;
  kitchens?: KitchenService | undefined;
  greenhouses?: GreenhouseService | undefined;
  greenhouseRuntime?: GreenhouseRuntime | undefined;
  fishing?: FishingService | undefined;
  cityFlagConversions: CityFlagConversionCoordinator | null;
  starterInventory?: Pick<InventoryService, "grantItemsForOperation"> | undefined;
  manorPresence?: ManorPresenceService | undefined;
  manorRuntime?: ManorRuntime | undefined;
  salon?: SalonService | undefined;
  salonRuntime?: SalonRuntime | undefined;
  manorStorage?: ManorStorageService | undefined;
  manorDecorations?: ManorDecorationService | undefined;
  dungeon?: CisternWarrensRuntime | undefined;
  worldRuntime?: WorldRuntime | undefined;
  collectibles?: CollectibleService | undefined;
  balsamResin?: BalsamResinService | undefined;
  fieldConsumables?: FieldConsumableService | undefined;
  resourceVisionJobs?: ResourceVisionJobQueue | undefined;
  droppedItems?: DroppedItemService | undefined;
  xoralEvents?: XoralEventService | undefined;
  legendaryBirdEvents?: LegendaryBirdEventService | undefined;
  combat?: CombatEngine | undefined;
  combatProfiles?: CombatProfileService | undefined;
  progression?: ProgressionService | undefined;
  achievements?: Pick<AchievementService, "connectRuntime"> | undefined;
  equipment?: EquipmentService | undefined;
  backpacks?: BackpackService | undefined;
  inventoryProtection?: InventoryProtectionService | undefined;
  classes?: ClassService | undefined;
  skills?: SkillService | undefined;
  cities?: CityService | undefined;
  kingdoms?: KingdomService | undefined;
  partyAuthority?: MutablePartyAuthority | undefined;
  partyCombatPublisher?: PartyCombatPublisher | undefined;
  partyReadyChecks?: PartyReadyCheckService | undefined;
  dungeonTorchLobbies?: DungeonTorchLobbyService | undefined;
  travelInvites?: TravelInviteService | undefined;
  landActions?: Pick<LandActionGate, "availableAt"> | undefined;
  settlement?: Pick<SettlementService, "relocationExemptionAvailable"> | undefined;
  hostileGate?: Pick<HostileActionGate, "prime"> | undefined;
  /** Sends the player's PvP timers (Revenge/Protection) once the connection is registered. */
  pvpStatus?: Readonly<{ sendTo(playerId: string): Promise<void> }> | undefined;
  masteries?: MasteryService | undefined;
  worldMap?: WorldMapService | undefined;
  pets?: PetService | undefined;
  dogCompanions?: PetCompanionRuntime | undefined;
  wallet?: Pick<WalletService, "snapshot"> | undefined;
  premiumWallet?: Pick<PremiumWalletService, "snapshot"> | undefined;
  activeHarvestSessionForPlayer(playerId: string): Promise<HarvestSessionSnapshot | null>;
  activePartyMemberOfOwner(playerId: string, ownerPlayerId: string): boolean;
  bootstrapChat(connectionId: string, playerId: string): Promise<void>;
  gameplayInterestCenter(
    playerId: string,
    fallback: { lat: number; lon: number }
  ): { lat: number; lon: number };
  gameplayInterestZoneIds(
    playerId: string,
    fallback: { lat: number; lon: number }
  ): string[];
  enqueueWorldCommand(command: ConnectionWorldCommand): boolean;
  handleClose(): Promise<void>;
  rejectDuringPlayerWorldTransition(requestId: string): boolean;
  requestWorldResync(
    requestId: string,
    expectedWorldViewAuthority?: WorldViewAuthority
  ): void;
  schedulePopulationV2Relocation(
    player: PlayerRecord,
    trigger: "world-entry" | "reconnect"
  ): ScheduledPopulationV2Relocation | null;
  runIndependentBootstrap(
    subsystem: string,
    connectionId: string,
    playerId: string,
    operation: () => void | Promise<void>
  ): Promise<void>;
  sendCollectiblesForPlayer(player: PlayerRecord | undefined): Promise<void>;
  sendCombatScopeSnapshot?(
    playerId: string,
    expectedAuthority?: WorldViewAuthority,
    presentationEligible?: boolean
  ): CombatScopeSnapshotPublication | null;
  sendDroppedItemsToSocket(playerId: string): Promise<void>;
  sendManorManagementSnapshot(
    ownerPlayerId: string,
    manorId: string,
    requestId?: string
  ): Promise<void>;
  sendManorsForPlayer(player: PlayerRecord | undefined): Promise<void>;
  sendTravelInboxForPlayers(playerIds: Iterable<string>): Promise<void>;
  travelInboxEntriesForPlayer(playerId: string): Promise<TravelInboxEntry[]>;
  sendTravelResourceVisionReadyAndSnapshot(
    player: PlayerRecord,
    resourceVision: ResourceVision,
    status: NonNullable<Awaited<ReturnType<CollectibleService["resourceVisionStatus"]>>>,
    isCurrent?: () => boolean
  ): Promise<void>;
  equipmentRuntimeContextFor(
    progression: ProgressionSnapshot | null,
    snapshot: ClassSnapshot | null
  ): EquipmentRuntimeContext;
  withEquipmentStats(
    progression: ProgressionSnapshot,
    equipment: EquipmentSnapshot,
    kingdom?: KingdomStatModifiers
  ): ProgressionSnapshot;
  withLiveClassCombatState(
    snapshot: ClassSnapshot,
    classCombat: ClassCombatState
  ): ClassSnapshot;
  requireHello(playerId: string | null): void;
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
  safeSendServerMessage(
    socket: SocketLike,
    message: ServerMessage,
    logger?: Pick<AppLogger, "warn">,
    context?: Record<string, unknown>
  ): boolean;
}>;

export type SessionBootstrapContext = Omit<
  SessionBootstrapDependencies,
  | "rejectDuringPlayerWorldTransition"
  | "requestWorldResync"
  | "requireHello"
  | "sendCombatError"
>;

export async function reconcileCanonicalInteriorProjections(input: Readonly<{
  playerId: string;
  canonicalLocation: Awaited<ReturnType<PlayerLocationService["load"]>>;
  manorPresence?: ManorPresenceService | undefined;
  manorRuntime?: ManorRuntime | undefined;
  salon?: SalonService | undefined;
  salonRuntime?: SalonRuntime | undefined;
  dungeon?: CisternWarrensRuntime | undefined;
}>): Promise<Readonly<{
  manorPresence: ManorPresence | null;
  salonPresence: SalonPresence | null;
}>> {
  const canonicalManor = input.canonicalLocation.kind === "interior" &&
    input.canonicalLocation.locationType === "manor";
  const storedManorPresence = await input.manorPresence?.load(input.playerId) ?? null;
  if (storedManorPresence && !canonicalManor && input.manorPresence) {
    await input.manorPresence.exit(input.playerId);
    const staleSession = input.manorRuntime?.get(input.playerId);
    if (staleSession) input.manorRuntime?.exit(input.playerId, staleSession.sessionId);
  }

  const canonicalSalon = input.canonicalLocation.kind === "interior" &&
    input.canonicalLocation.locationType === "salon";
  const storedSalonPresence = await input.salon?.loadPresence(input.playerId) ?? null;
  if (storedSalonPresence && !canonicalSalon && input.salon) {
    await input.salon.exit(input.playerId, storedSalonPresence.sessionId);
    input.salonRuntime?.remove(input.playerId);
  }

  const canonicalDungeon = input.canonicalLocation.kind === "interior" &&
    (input.canonicalLocation.locationType === "cistern_warrens" ||
      input.canonicalLocation.locationType === "dungeon");
  if (input.dungeon && !canonicalDungeon && await input.dungeon.durableSewerId(input.playerId)) {
    await input.dungeon.discardStalePresence(input.playerId);
  }

  return {
    manorPresence: canonicalManor ? storedManorPresence : null,
    salonPresence: canonicalSalon ? storedSalonPresence : null
  };
}

export async function publishStartupPresentationCombatSnapshot(input: Readonly<{
  relocation: ScheduledPopulationV2Relocation;
  onRejected?(reason: "population-not-ready" | "stale-before-publication" | "stale-after-publication"): void;
  sendCombatScopeSnapshot(
    playerId: string,
    expectedAuthority: WorldViewAuthority
  ): CombatScopeSnapshotPublication | null;
}>): Promise<CombatScopeSnapshotPublication | null> {
  const readiness = await input.relocation.presentationReady;
  if (
    readiness.status !== "degraded" &&
    (readiness.status !== "ready" || readiness.pendingVisibleZoneCount !== 0)
  ) {
    input.onRejected?.("population-not-ready");
    return null;
  }
  if (!input.relocation.isCurrent()) {
    input.onRejected?.("stale-before-publication");
    return null;
  }
  const expectedAuthority: WorldViewAuthority = {
    playerId: input.relocation.playerId,
    connectionId: input.relocation.connectionId,
    connectionGeneration: input.relocation.connectionGeneration,
    relocationRevision: input.relocation.relocationRevision,
    resourceVisionRevision: input.relocation.resourceVisionRevision,
    gameplayViewGeneration: input.relocation.gameplayViewGeneration,
    populationPreparationGeneration:
      input.relocation.preparationGeneration ?? 0
  };
  const publication = input.sendCombatScopeSnapshot(
    input.relocation.playerId,
    expectedAuthority
  );
  if (!input.relocation.isCurrent()) {
    input.onRejected?.("stale-after-publication");
    return null;
  }
  return publication;
}

export function createSessionBootstrap(
  context: SessionBootstrapContext
): (
  message: Extract<MessageForFamily<"session">, { type: "HELLO" }>
) => Promise<void> {
  return async (message) => {
    const {
      state,
      socket,
      acceptedAtMs,
      bootstrapAttempts,
      setBootstrapAttempt,
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
      playerLocations,
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
      landActions,
      settlement,
      hostileGate,
      pvpStatus,
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
    } = context;
    if (state.helloReceived) {
      safeSendServerMessage(socket, {
          type: "ERROR",
          code: "HELLO_ALREADY_RECEIVED",
          message: "HELLO is only allowed once per connection"
        });
      return;
    }
    state.helloReceived = true;
    if (!authenticatedSession?.player) {
      throw new AuthError("AUTHENTICATION_REQUIRED", "Authentication required", 401);
    }
    const greenhouseCropPackId = message.greenhouseCropPackId;
    if (message.greenhouseCropCatalogVersion === 1 && typeof greenhouseCropPackId === "string") {
      state.greenhouseCropCatalogVersion = 1;
      state.greenhouseCropPackId = greenhouseCropPackId;
    } else {
      delete state.greenhouseCropCatalogVersion;
      delete state.greenhouseCropPackId;
    }
    if (state.connectionId) {
      registry.setGreenhouseCropCapability(
        state.connectionId,
        state.greenhouseCropCatalogVersion,
        state.greenhouseCropPackId
      );
    }
    const attempt = bootstrapAttempts.begin({
      accountId: authenticatedSession.account.id,
      acceptedAtMs,
      authenticatedHelloAtMs: Date.now(),
      socket,
      isSocketClosed: () => state.socketClosed
    });
    setBootstrapAttempt(attempt);
    const assertAuthority = (stage: string): void => {
      bootstrapAttempts.assertCurrentOpen(attempt, stage);
    };
    try {
    assertAuthority("authenticated-hello");
    const persistedPlayer = await playerService.loadPlayer(
      authenticatedSession.player.id
    );
    assertAuthority("player-loaded");
    if (!persistedPlayer) {
      throw new Error("authenticated player does not exist");
    }
    let canonicalLocation = await playerLocations?.load(persistedPlayer.playerId) ?? {
      kind: "world" as const,
      regionCode: persistedPlayer.regionCode,
      zoneId: zoneIdForPosition(persistedPlayer.position),
      position: { ...persistedPlayer.position },
      revision: 0
    };
    assertAuthority("location-loaded");
    let personalFlagReconnectRevoked = false;
    if (flagAccess && persistedPlayer.resourceVision?.flagId) {
      const reconnectAccess = await flagAccess.authorize(
        persistedPlayer.resourceVision.flagId,
        persistedPlayer.playerId
      );
      assertAuthority("flag-access-authorized");
      if (reconnectAccess.controlType === "personal" && !reconnectAccess.decision.allowed) {
        persistedPlayer.resourceVision = null;
        personalFlagReconnectRevoked = true;
      }
    }
    if (starterInventory) {
      assertAuthority("starter-resources-start");
      await ensureStarterResources(starterInventory, persistedPlayer.playerId);
      assertAuthority("starter-resources-finished");
    }
    await partyRealtimeState.waitForMutation(persistedPlayer.playerId);
    assertAuthority("party-mutations-settled");
    // Resolve durable manor presence before publishing the player to the
    // in-memory world so a reconnect cannot leak for even one world tick.
    let manorRestorationFallback: string | null = null;
    const reconciledInterior = await reconcileCanonicalInteriorProjections({
      playerId: persistedPlayer.playerId,
      canonicalLocation,
      manorPresence,
      manorRuntime,
      salon,
      salonRuntime,
      dungeon
    });
  let restoredManorPresence = reconciledInterior.manorPresence;
    let restoredGreenhouseId = canonicalLocation.kind === "interior" &&
      canonicalLocation.locationType === "greenhouse"
      ? canonicalLocation.locationId
      : null;
    if (restoredGreenhouseId) {
      try {
        if (!greenhouses) throw new Error("Greenhouses are unavailable.");
        await greenhouses.authorizeEntry(persistedPlayer.playerId, restoredGreenhouseId);
      } catch (error) {
        logger.warn({ err: error, playerId: persistedPlayer.playerId, greenhouseId: restoredGreenhouseId }, "greenhouse reconnect was no longer authorized; recovering to world");
        restoredGreenhouseId = null;
        if (playerLocations) {
          canonicalLocation = (await playerLocations.commitPortalTransition({
            playerId: persistedPlayer.playerId,
            requestId: `safe-eject:greenhouse:${canonicalLocation.revision}`,
            portalId: "recovery:greenhouse-access-revoked",
            expectedRevision: canonicalLocation.revision,
            destination: {
              kind: "world",
              regionCode: persistedPlayer.regionCode,
              position: { ...persistedPlayer.position }
            }
          })).location;
          assertAuthority("greenhouse-recovery-location-committed");
        }
      }
    }
    assertAuthority("manor-presence-loaded");
    if (restoredManorPresence && manorPresence) {
      const activePartyAccess = activePartyMemberOfOwner(
        persistedPlayer.playerId,
        restoredManorPresence.ownerPlayerId
      );
      const manorReconnectAllowed = await manorPresence.reconnectAllowed(
        restoredManorPresence,
        activePartyAccess
      );
      assertAuthority("manor-reconnect-authorized");
      const manorSpaceMissing = canonicalLocation.kind === "interior" && canonicalLocation.locationType === "manor" &&
        canonicalLocation.spaceId !== "manor_foyer" &&
        !manorAuthoredRoom(canonicalLocation.spaceId, restoredManorPresence.manorTypeId);
      if (!manorReconnectAllowed || manorSpaceMissing) {
        assertAuthority("manor-presence-exit");
        await manorPresence.exit(persistedPlayer.playerId);
        assertAuthority("manor-presence-exited");
        restoredManorPresence = null;
        if (playerLocations) {
          canonicalLocation = (await playerLocations.commitPortalTransition({
            playerId: persistedPlayer.playerId,
            requestId: `safe-eject:${canonicalLocation.revision}`,
            portalId: "recovery:manor-access-revoked",
            expectedRevision: canonicalLocation.revision,
            destination: {
              kind: "world",
              regionCode: persistedPlayer.regionCode,
              position: { ...persistedPlayer.position }
            }
          })).location;
          assertAuthority("manor-recovery-location-committed");
        }
        manorRestorationFallback =
          "Your previous manor session was no longer valid, so you were returned safely to the world.";
      }
    }
    const restoredSalonPresence = reconciledInterior.salonPresence;
    assertAuthority("salon-presence-loaded");
    if (
      playerLocations && canonicalLocation.kind === "interior" &&
      ((canonicalLocation.locationType === "manor" && !restoredManorPresence) ||
       (canonicalLocation.locationType === "salon" && !restoredSalonPresence) ||
       (canonicalLocation.locationType === "greenhouse" && !restoredGreenhouseId))
    ) {
      canonicalLocation = (await playerLocations.commitPortalTransition({
        playerId: persistedPlayer.playerId,
        requestId: `safe-eject:missing-domain:${canonicalLocation.revision}`,
        portalId: "recovery:missing-interior-domain",
        expectedRevision: canonicalLocation.revision,
        destination: {
          kind: "world", regionCode: persistedPlayer.regionCode,
          position: { ...persistedPlayer.position }
        }
      })).location;
      assertAuthority("interior-recovery-location-committed");
    }
    // Load authored decoration collision geometry before restoring the runtime
    // session. Reconnect positions must be validated against the same
    // navigation view that will be sent to the client.
    let restoredManorDecorations:
      | Awaited<ReturnType<ManorDecorationService["snapshotForPlayer"]>>
      | null = null;
    if (restoredManorPresence) manorRuntime?.setManorType(restoredManorPresence.manorId, restoredManorPresence.manorTypeId);
    if (restoredManorPresence && manorDecorations) {
      restoredManorDecorations = await manorDecorations.snapshotForPlayer(
        persistedPlayer.playerId,
        restoredManorPresence.manorId
      );
      const restoredManorSpaceId = canonicalLocation.kind === "interior" &&
        canonicalLocation.locationType === "manor"
        ? canonicalLocation.spaceId as ManorSpaceId
        : "manor_main_room" as const;
      manorRuntime?.setManorNavigation(
        restoredManorPresence.manorId,
        restoredManorSpaceId,
        manorDecorations.navigationForManor(
          restoredManorPresence.manorId,
          restoredManorSpaceId
        )
      );
    }
    const reconnectLease = await reconnectLeases.claim({
      accountId: authenticatedSession.account.id,
      playerId: persistedPlayer.playerId,
      isAuthorized: () => bootstrapAttempts.isCurrentOpen(attempt)
    });
    assertAuthority("reconnect-lease-claimed");
    await harvestReconnectLeases.claim({
      accountId: authenticatedSession.account.id,
      playerId: persistedPlayer.playerId,
      isAuthorized: () => bootstrapAttempts.isCurrentOpen(attempt)
    });
    // Keep the authority, runtime, presence, and registry handoff on one event-loop turn.
    // A newer HELLO cannot interleave after this guard and before registration.
    assertAuthority("authority-handoff");
    const replacementCandidateId = registry.activeConnectionIdForAccount(
      authenticatedSession.account.id
    );
    const replacementCandidate = replacementCandidateId
      ? registry.recordForConnection(replacementCandidateId)
      : null;
    const preserveLiveState = Boolean(
      (reconnectLease || replacementCandidate?.playerId === persistedPlayer.playerId) &&
      gameState.getPlayer(persistedPlayer.playerId)
    );
    state.connectionGeneration = connectionGenerations.allocate(
      authenticatedSession.player.id
    );
    registry.setLinkDeadWorldPresence(persistedPlayer.playerId, false);
    const player = preserveLiveState || worldRuntime?.hasPlayerWorldTransition(persistedPlayer.playerId)
      ? gameState.markOnlinePreservingView(persistedPlayer.playerId) ??
        gameState.connectPlayer(persistedPlayer)
      : gameState.connectPlayer(persistedPlayer);
    const restoredSewerId = canonicalLocation.kind === "interior" &&
      (canonicalLocation.locationType === "cistern_warrens" || canonicalLocation.locationType === "dungeon")
        ? canonicalLocation.locationId
        : null;
    const restoredManorSession = restoredManorPresence
      ? manorRuntime?.restore(
          player.playerId,
          restoredManorPresence.manorId,
          restoredManorPresence.accessSource,
          {
            x: restoredManorPresence.localPositionX,
            y: restoredManorPresence.localPositionY
          },
          canonicalLocation.kind === "interior" && canonicalLocation.locationType === "manor"
            ? canonicalLocation.spaceId as ManorSpaceId
            : "manor_main_room"
        ) ?? null
      : null;
    const restoredSalonSession = restoredSalonPresence
      ? salonRuntime?.enter(restoredSalonPresence) ?? null
      : null;
    const restoredGreenhouseSession = restoredGreenhouseId && greenhouseRuntime
      ? greenhouseRuntime.restore(
          player.playerId,
          restoredGreenhouseId,
          canonicalLocation.kind === "interior" && canonicalLocation.locationType === "greenhouse"
            ? canonicalLocation.position
            : undefined
        )
      : null;
    gameState.setWorldPresence(
      player.playerId,
      canonicalLocation.kind === "world"
    );
    const connection = registry.addWithReplacement({
      accountId: authenticatedSession.account.id,
      authSessionId: authenticatedSession.sessionId,
      playerId: player.playerId,
      username: player.username,
      regionCode: canonicalLocation.regionCode,
      zoneId: canonicalLocation.zoneId,
      interestZoneIds: canonicalLocation.kind === "interior"
        ? []
        : gameplayInterestZoneIds(
            player.playerId,
            gameplayInterestCenter(player.playerId, player.anchor)
          ),
      protocolCapabilities: state.protocol.capabilities,
      socket
    });
    bootstrapAttempts.markRegistryHandoff(attempt, {
      replacedConnectionId: connection.replacedConnectionId,
      replacedAccountId: replacementCandidate?.accountId ?? null,
      replacedSocketState: replacementCandidate?.socket.readyState ?? null
    });
    state.playerId = player.playerId;
    // Load trust status for the synchronous PvP shield before combat starts.
    hostileGate?.prime(player.playerId);
    state.connectionId = connection.connectionId;
    void pvpStatus?.sendTo(player.playerId).catch((error: unknown) => {
      logger?.warn({ err: error, playerId: player.playerId }, "failed to send PvP status");
    });
    if (connection.replacedConnectionId) {
      worldRuntime?.forceReleasePlayerWorldTransition(
        player.playerId,
        connection.replacedConnectionId,
        "connection-replaced"
      );
    }
    connectionCloseRegistry.register(connection.connectionId, handleClose);
    if (state.socketClosed) {
      await handleClose();
      return;
    }
    await playerService.markOnline(persistedPlayer.playerId);
    assertAuthority("player-marked-online");
    if (personalFlagReconnectRevoked) {
      await playerService.persistPlayerSnapshot(gameState.snapshotForPlayer(player.playerId));
      assertAuthority("player-reconnect-snapshot-persisted");
    }
    if (
      travelInvites &&
      (reconnectLease?.previousAuthSessionId ?? replacementCandidate?.authSessionId) &&
      (reconnectLease?.previousAuthSessionId ?? replacementCandidate?.authSessionId) !== authenticatedSession.sessionId
    ) {
      const previousAuthSessionId =
        reconnectLease?.previousAuthSessionId ?? replacementCandidate!.authSessionId!;
      const affected = await travelInvites.invalidateForInviter(
        player.playerId,
        "The inviter changed active sessions.",
        { sessionId: previousAuthSessionId }
      );
      assertAuthority("travel-invites-invalidated");
      await sendTravelInboxForPlayers(affected);
      assertAuthority("travel-inboxes-refreshed");
    }
    let progressionSnapshot = progression
      ? await progression.getOrCreate(player.playerId)
      : null;
    assertAuthority("progression-loaded");
    const masterySnapshot = masteries ? await masteries.getOrCreate(player.playerId) : null;
    assertAuthority("masteries-loaded");
    const achievementSnapshot = achievements
      ? await achievements.connectRuntime(player.playerId)
      : null;
    assertAuthority("achievements-loaded");
    let classSnapshot = classes ? await classes.getOrCreate(player.playerId) : null;
    assertAuthority("class-loaded");
    const skillSnapshot = skills ? await skills.getOrCreate(player.playerId) : null;
    assertAuthority("skills-loaded");
    let equipmentSnapshot: EquipmentSnapshotV2 | null = null;
    if (equipment) {
      await equipment.ensureStarterLoadout(
        player.playerId,
        classSnapshot?.activeClassId ?? "warrior"
      );
      assertAuthority("starter-loadout-ensured");
      const existingRuntime = equipment.runtimeSnapshot(player.playerId);
      if (preserveLiveState && existingRuntime) {
        equipmentSnapshot = existingRuntime;
      } else {
        if (existingRuntime) {
          await equipment.flushAndRelease(player.playerId);
          assertAuthority("equipment-runtime-released");
        }
        equipmentSnapshot = await equipment.connectRuntime(
          player.playerId,
          {
            ...equipmentRuntimeContextFor(progressionSnapshot, classSnapshot),
            achievementIds: achievementSnapshot?.achievements
              .filter(({ completed }) => completed)
              .map(({ achievementId }) => achievementId) ?? []
          }
        );
        assertAuthority("equipment-runtime-connected");
      }
    }
    if (equipmentSnapshot) {
      installAuthoritativePlayerAppearance(gameState, equipmentSnapshot);
    }
    let classRuntime = classes && !preserveLiveState
      ? await classes.loadRuntime(player.playerId)
      : null;
    assertAuthority("class-runtime-loaded");
    if (cities) {
      await cities.districtBenefits.refreshRuntime(player.playerId);
      assertAuthority("city-benefits-refreshed");
    }
    let liveCombatSnapshot: CombatEntitySnapshot | null = null;
    if (progressionSnapshot && equipmentSnapshot) {
      progressionSnapshot = withEquipmentStats(
        progressionSnapshot,
        equipmentSnapshot,
        await kingdoms?.statModifiers(player.playerId)
      );
      assertAuthority("kingdom-modifiers-loaded");
      if (skillSnapshot) {
        const weapon = equipmentSnapshot.active[equipmentSnapshot.readiedWeaponSlot]
          ?? equipmentSnapshot.weapon;
        const chest = equipmentSnapshot.active.chest ?? equipmentSnapshot.chest;
        const shield = equipmentSnapshot.active.secondary?.category === "shield"
          ? equipmentSnapshot.active.secondary
          : null;
        const weaponFamily = weapon && isEquipmentDefinitionId(weapon.definitionId)
          ? requireEquipmentDefinition(weapon.definitionId).gameplayFamilyId
          : null;
        const bodyFamily = chest && isEquipmentDefinitionId(chest.definitionId)
          ? requireEquipmentDefinition(chest.definitionId).gameplayFamilyId
          : null;
        const weaponProfile = resolveV3WeaponProfileForEquipmentFamily(weaponFamily).profile ?? "unarmed";
        const bodyProfile = resolveV3DefenseProfileForEquipmentFamily(bodyFamily).profile ?? "unarmored";
        const resolved = applySkillSystemV3CombatStats({
          maxHp: progressionSnapshot.pveStats.maxHealth,
          attack: progressionSnapshot.pveStats.attackPower,
          defense: progressionSnapshot.pveStats.defense,
          movementSpeed: 0,
          attackRangeM: progressionSnapshot.pveStats.attackRangeM,
          dodgeProbability: 0,
          directHealingMultiplier: 1,
          healingOverTimeMultiplier: 1
        }, skillSnapshot, {
          weaponProfile,
          bodyDefenseProfile: bodyProfile,
          bodyArmorFamilyId: bodyFamily,
          shieldEquipped: shield !== null,
          martialArtsDodgeEligible: shield === null && bodyProfile !== "breastplate" && bodyProfile !== "chainmail"
        });
        progressionSnapshot = {
          ...progressionSnapshot,
          pveStats: {
            ...progressionSnapshot.pveStats,
            maxHealth: resolved.maxHp,
            attackPower: resolved.attack,
            defense: resolved.defense,
            attackRangeM: resolved.attackRangeM
          }
        };
      } else if (classSnapshot) {
        progressionSnapshot = {
          ...progressionSnapshot,
          pveStats: applyClassCombatStats(progressionSnapshot.pveStats, classSnapshot, equipmentSnapshot)
        };
      }
    }
    if (combat && !restoredManorPresence && !restoredSalonPresence && !restoredGreenhouseSession) {
      const liveCombat = preserveLiveState
        ? combat.rotatePlayerAuthority(
            player.playerId,
            authenticatedSession.account.id,
            state.connectionId
          )
        : null;
      liveCombatSnapshot = liveCombat;
      if (liveCombat) {
        gameState.setMovementBlocked(player.playerId, liveCombat.currentHealth <= 0);
      } else if (combatProfiles) {
        const profile = await combatProfiles.getOrCreate(player.playerId);
        assertAuthority("combat-profile-loaded");
        const stats = progressionSnapshot?.pveStats;
        combat.connectPlayer({
          playerId: player.playerId,
          name: player.username,
          regionCode: player.regionCode,
          zoneId: zoneIdForPosition(player.position),
          position: player.position,
          accountId: authenticatedSession.account.id,
          connectionId: state.connectionId,
          profile: stats
            ? {
                ...profile,
                level: progressionSnapshot!.level,
                maxHealth: stats.maxHealth,
                currentHealth: levelUpHealth(
                  profile.currentHealth,
                  profile.maxHealth,
                  stats.maxHealth
                ),
                baseAttackDamage: stats.attackPower,
                defense: stats.defense
              }
            : profile
        });
        gameState.setMovementBlocked(player.playerId, profile.currentHealth <= 0);
        if (progression) {
          // PvP death max-HP penalty: recovery since the last loss is computed lazily from its anchor.
          const maxHealthPenalty = await loadMaxHealthPenaltySafely(progression, player.playerId, (error) =>
            logger.warn({ err: error, playerId: player.playerId }, "max-HP penalty could not be loaded at login"));
          assertAuthority("max-health-penalty-loaded");
          if (maxHealthPenalty !== undefined) combat.setPlayerMaxHealthPenalty(player.playerId, maxHealthPenalty);
        }
        if (classSnapshot && equipmentSnapshot) {
          classRuntime ??= await classes?.loadRuntime(player.playerId) ?? null;
          assertAuthority("combat-class-runtime-loaded");
          combat.updatePlayerClassState(
            player.playerId,
            classSnapshot,
            equipmentSnapshot,
            classRuntime ?? undefined
          );
        }
        if (skillSnapshot) combat.updatePlayerSkillState(player.playerId, skillSnapshot);
      }
      if (equipmentSnapshot) {
        combat.syncPlayerEquipmentCombatState(
          player.playerId,
          playerEquipmentCombatStateFromSnapshot(equipmentSnapshot)
        );
      }
      const activeBalsamResin = await balsamResin?.activeEffect(player.playerId);
      assertAuthority("balsam-effect-loaded");
      if (activeBalsamResin) {
        combat.stageBalsamResinEffect(activeBalsamResin, { fresh: false });
      }
      const activeFieldBuffs = await fieldConsumables?.activeBuffs(player.playerId);
      assertAuthority("field-buffs-loaded");
      if (activeFieldBuffs) combat.stageFieldBuffs(player.playerId, activeFieldBuffs);
      worldRuntime?.replication.resetPlayer(player.playerId);
      if (connection.replacedConnectionId) {
        enqueueWorldCommand({
          kind: "lifecycle-cancel",
          requestId: `replacement:${connection.connectionId}`,
          reason: "connection-replaced"
        });
      }
    }
    let restoredDungeonSnapshot = restoredSewerId && canonicalLocation.kind === "interior" &&
      (canonicalLocation.locationType === "cistern_warrens" || canonicalLocation.locationType === "dungeon")
      ? await dungeon?.restore(player, {
        sewerId: canonicalLocation.locationId,
        spaceId: canonicalLocation.spaceId,
        position: canonicalLocation.position,
        instanceId: canonicalLocation.instanceId,
        locationType: canonicalLocation.locationType
      }) ?? null
      : null;
    assertAuthority("dungeon-runtime-restored");
    if (
      restoredDungeonSnapshot && canonicalLocation.kind === "interior" &&
      (canonicalLocation.locationType === "cistern_warrens" || canonicalLocation.locationType === "dungeon") &&
      restoredDungeonSnapshot.spaceId !== canonicalLocation.spaceId
    ) {
      restoredDungeonSnapshot = dungeon?.transferSpace(
        player.playerId,
        restoredDungeonSnapshot.sessionId,
        canonicalLocation.spaceId,
        canonicalLocation.position
      ) ?? restoredDungeonSnapshot;
    }
    if (restoredDungeonSnapshot) {
      gameState.setWorldPresence(player.playerId, false);
      worldRuntime?.replication.removePlayer(player.playerId);
    } else if (restoredSewerId) {
      if (playerLocations && canonicalLocation.kind === "interior") {
        canonicalLocation = (await playerLocations.commitPortalTransition({
          playerId: player.playerId,
          requestId: `safe-eject:missing-sewer:${canonicalLocation.revision}`,
          portalId: "recovery:missing-sewer",
          expectedRevision: canonicalLocation.revision,
          destination: {
            kind: "world", regionCode: player.regionCode,
            position: { ...player.position }
          }
        })).location;
        assertAuthority("sewer-recovery-location-committed");
      }
      gameState.setWorldPresence(player.playerId, true);
      registry.updateSpatialMembership({
        playerId: player.playerId,
        regionCode: player.regionCode,
        zoneId: zoneIdForPosition(player.position),
        interestZoneIds: gameplayInterestZoneIds(
          player.playerId,
          gameplayInterestCenter(player.playerId, player.anchor)
        )
      });
    }
    if (restoredSalonPresence && restoredSalonSession) {
      registry.sendToConnection(connection.connectionId, {
        type: "SALON_ENTERED",
        requestId: "resume",
        structureId: restoredSalonPresence.structureId,
        salonSessionId: restoredSalonSession.sessionId,
        displayColor: player.displayColor,
        ...(player.appearance ? { appearance: player.appearance } : {}),
        position: restoredSalonSession.position,
        movementSequence: restoredSalonSession.movementSequence,
        serverTime: Date.now()
      });
    }
    if (restoredGreenhouseId && restoredGreenhouseSession && greenhouses) {
      await runIndependentBootstrap(
        "greenhouse-session",
        connection.connectionId,
        player.playerId,
        async () => {
          registry.sendToConnection(connection.connectionId, {
            type: "GREENHOUSE_POSITION",
            greenhouseSessionId: restoredGreenhouseSession.sessionId,
            position: restoredGreenhouseSession.position,
            movementSequence: restoredGreenhouseSession.movementSequence,
            serverTime: Date.now()
          });
          const greenhouseState = await greenhouses.snapshot(player, restoredGreenhouseId);
          registry.sendToConnection(connection.connectionId, {
            type: "GREENHOUSE_STATE",
            requestId: "resume",
            state: await greenhouseStateForCropCapableClient(
              greenhouseState,
              state.greenhouseCropCatalogVersion,
              state.greenhouseCropPackId
            )
          });
        }
      );
    }
    if (classSnapshot && liveCombatSnapshot?.classCombat) {
      classSnapshot = withLiveClassCombatState(classSnapshot, liveCombatSnapshot.classCombat);
    }
    const activeCityConstruction =
      await cities?.structures?.activeConstructionForPlayer(player.playerId) ?? null;
    assertAuthority("city-construction-loaded");
    gameState.setMovementBlocked(
      player.playerId,
      activeCityConstruction !== null,
      "city-construction"
    );
    const activeFurnaceBuild = await furnaces?.activeBuildForPlayer(player.playerId) ?? null;
    assertAuthority("furnace-construction-loaded");
    gameState.setMovementBlocked(
      player.playerId,
      activeFurnaceBuild !== null,
      "furnace-construction"
    );
    if (activeFurnaceBuild) {
      registry.sendToConnection(connection.connectionId, {
        type: "FURNACE_BUILD_STARTED",
        requestId: activeFurnaceBuild.requestId,
        build: activeFurnaceBuild.build,
        inventory: activeFurnaceBuild.inventory,
        serverTime: Date.now(),
        replayed: true
      });
    }
    const activeTanneryBuild = await tanneries?.activeBuildForPlayer(player.playerId) ?? null;
    assertAuthority("tannery-construction-loaded");
    gameState.setMovementBlocked(
      player.playerId,
      activeTanneryBuild !== null,
      "tannery-construction"
    );
    if (activeTanneryBuild) {
      registry.sendToConnection(connection.connectionId, {
        type: "TANNERY_BUILD_STARTED",
        requestId: activeTanneryBuild.requestId,
        build: activeTanneryBuild.build,
        inventory: activeTanneryBuild.inventory,
        serverTime: Date.now(),
        replayed: true
      });
    }
    const activeLoomBuild = await looms?.activeBuildForPlayer(player.playerId) ?? null;
    assertAuthority("loom-construction-loaded");
    gameState.setMovementBlocked(
      player.playerId,
      activeLoomBuild !== null,
      "loom-construction"
    );
    if (activeLoomBuild) {
      registry.sendToConnection(connection.connectionId, {
        type: "LOOM_BUILD_STARTED",
        requestId: activeLoomBuild.requestId,
        build: activeLoomBuild.build,
        inventory: activeLoomBuild.inventory,
        serverTime: Date.now(),
        replayed: true
      });
    }
    const activeKitchenBuild = await kitchens?.activeBuildForPlayer(player.playerId) ?? null;
    assertAuthority("kitchen-construction-loaded");
    gameState.setMovementBlocked(
      player.playerId,
      activeKitchenBuild !== null,
      "kitchen-construction"
    );
    if (activeKitchenBuild) {
      registry.sendToConnection(connection.connectionId, {
        type: "KITCHEN_BUILD_STARTED",
        requestId: activeKitchenBuild.requestId,
        build: activeKitchenBuild.build,
        inventory: activeKitchenBuild.inventory,
        serverTime: Date.now(),
        replayed: true
      });
    }
    const activeGreenhouseBuild = await greenhouses?.activeBuildForPlayer(player.playerId) ?? null;
    assertAuthority("greenhouse-construction-loaded");
    gameState.setMovementBlocked(
      player.playerId,
      activeGreenhouseBuild !== null,
      "greenhouse-construction"
    );
    if (activeGreenhouseBuild) {
      registry.sendToConnection(connection.connectionId, {
        type: "GREENHOUSE_BUILD_STARTED",
        requestId: activeGreenhouseBuild.requestId,
        build: activeGreenhouseBuild.build,
        inventory: activeGreenhouseBuild.inventory,
        serverTime: Date.now(),
        replayed: true
      });
    }
    const activeFishingBuild = await fishing?.activeBuildForPlayer(player.playerId) ?? null;
    assertAuthority("fishing-construction-loaded");
    gameState.setMovementBlocked(
      player.playerId,
      activeFishingBuild !== null,
      "fishing-construction"
    );
    if (activeFishingBuild) {
      registry.sendToConnection(connection.connectionId, {
        type: "FISHING_HUT_BUILD_STARTED",
        requestId: activeFishingBuild.requestId,
        build: activeFishingBuild.build,
        inventory: activeFishingBuild.inventory,
        serverTime: Date.now(),
        replayed: true
      });
    }
    const activeFishingState = await fishing?.resumeState(player) ?? null;
    assertAuthority("fishing-encounter-loaded");
    gameState.setMovementBlocked(player.playerId, activeFishingState !== null, "fishing");
    if (activeFishingState) {
      registry.sendToConnection(connection.connectionId, {
        type: "FISHING_ENCOUNTER_STATE",
        state: activeFishingState
      });
    }
    await auth?.recordConnectionEvent(authenticatedSession, "game_connection_opened");
    assertAuthority("connection-open-event-recorded");
    if (connection.replacedConnectionId) {
      await auth?.recordConnectionEvent(authenticatedSession, "game_connection_replaced");
      assertAuthority("connection-replaced-event-recorded");
    }
    logger.info(
      {
        accountId: authenticatedSession.account.id,
        playerId: player.playerId
      },
      "websocket connected"
    );
    cityFlagConversions?.connectPlayer(player.playerId);
    if (!restoredManorPresence && !restoredSewerId && !restoredGreenhouseSession) {
      flagBuilds?.connectPlayer(player.playerId);
      try {
        await worldMap?.discoverAtAuthoritativePosition(
          player.playerId,
          player.anchor
        );
        assertAuthority("world-map-discovery-recorded");
      } catch (error) {
        if (error instanceof BootstrapAttemptInactiveError) throw error;
        logger.warn(
          { err: error, playerId: player.playerId },
          "failed to record city discovery during world entry"
        );
      }
    }
    const walletSnapshot = await wallet?.snapshot(
      player.playerId,
      authenticatedSession.account.id
    );
    const premiumWalletSnapshot = await premiumWallet?.snapshot(
      authenticatedSession.account.id
    );
    // Effective Glimmer costs for this player (Atlas Pass price applied); omitted while every fee is off.
    const glimmerCosts = {
      levelUp: progression?.levelUpGlimmerFee ?? null,
      skillReset: typeof skills?.fullBuildRespecGlimmerCost === "function"
        ? await skills.fullBuildRespecGlimmerCost(player.playerId)
        : null
    };
    const publishedVersionMetadata = await readPublishedVersionMetadata(
      config?.PUBLIC_RELEASE_METADATA_PATH
    );
    assertAuthority("welcome");
    const welcomeResult = registry.sendToConnection(
      connection.connectionId,
      {
        type: "WELCOME",
        playerId: player.playerId,
        username: player.username,
        spawn: player.position,
          anchor: player.anchor,
          moveLeashRadiusM: player.moveLeashRadiusM,
          flagClaimRadiusM:
            config?.FLAG_CLAIM_RADIUS_M ?? DEFAULT_FLAG_CLAIM_RADIUS_M,
          flagBuildRecipe: [...FLAG_BUILD_RECIPE],
          buoyBuildRecipe: [...BUOY_BUILD_RECIPE],
          playerSpeedMps: gameState.playerMovementSpeedMps,
          serverTickHz: config?.SERVER_TICK_HZ ?? 20,
        regionCode: player.regionCode,
        zoneId: zoneIdForPosition(player.position),
        worldAuthorityEpoch: gameState.worldAuthorityEpoch(player.playerId),
        connectionId: connection.connectionId,
        connectionGeneration: state.connectionGeneration!,
        gameplayViewGeneration:
          gameState.getGameplayViewCircle(player.playerId)?.generation ?? 0,
        relocationRevision: player.relocationRevision ?? 0,
        resourceVisionRevision:
          gameState.getResourceVisionRevision(player.playerId),
        developerCapabilities:
          auth?.developerCapabilities(authenticatedSession) ?? [],
        bugReportsEnabled: Boolean(
          config?.BUG_REPORTS_ENABLED && config.TELEMETRY_ENABLED
        ),
        ...(config?.ACTION_COMBAT_ENABLED ? { actionCombat: true } : {}),
        ...(config?.CLERIC_ARC_ENABLED ? { clericArc: true } : {}),
        ...(walletSnapshot ? { wallet: walletSnapshot } : {}),
        ...(premiumWalletSnapshot ? { premiumWallet: premiumWalletSnapshot } : {}),
        ...(glimmerCosts.levelUp !== null || glimmerCosts.skillReset !== null ? { glimmerCosts } : {}),
        hunger: {
          current: player.hunger?.current ?? HUNGER_BASE_CAPACITY,
          baseCapacity: player.hunger?.baseCapacity ?? HUNGER_BASE_CAPACITY
        },
        serverTime: Date.now(),
        ...(state.protocol.capabilities.includes("welcome-release-sha") && config?.RUNTIME_SHA
          ? { releaseSha: config.RUNTIME_SHA }
          : {}),
        ...(state.protocolMetadataAdvertised
          ? { protocol: state.protocol }
          : {}),
        ...(state.protocol.capabilities.includes("welcome-version-metadata")
          ? {
              clients: publishedVersionMetadata?.clients ?? createVersionClients(null),
              serverVersion: config?.RUNTIME_SHA ?? null,
              protocolMin: ASH_ATLAS_MIN_PROTOCOL_VERSION,
              protocolMax: ASH_ATLAS_MAX_PROTOCOL_VERSION,
              publicVersion: publishedVersionMetadata?.publicVersion ?? null,
              generation: publishedVersionMetadata?.generation ?? config?.RUNTIME_GENERATION ?? null
            }
          : {})
      }
    );
    if (welcomeResult !== "sent") {
      throw new Error(`failed to send WELCOME: ${welcomeResult}`);
    }
    bootstrapAttempts.markWelcomed(attempt);
    bootstrapAttempts.complete(attempt);
    setBootstrapAttempt(null);
    if (legendaryBirdEvents) {
      await runIndependentBootstrap(
        "legendary-event-alerts",
        connection.connectionId,
        player.playerId,
        () => legendaryBirdEvents.sendCurrentAlerts(player.playerId)
      );
    }
    const postWelcomeBootstrapStartedAt = performance.now();
    registry.sendToConnection(connection.connectionId, {
      type: "PLAYER_LOCATION_SNAPSHOT",
      location: canonicalLocation
    });
    const startupPopulationRelocation: {
      current: ScheduledPopulationV2Relocation | null;
    } = { current: null };
    if (!restoredManorPresence && !restoredSewerId && !restoredGreenhouseSession) {
      await runIndependentBootstrap(
        "population-relocation",
        connection.connectionId,
        player.playerId,
        () => {
          startupPopulationRelocation.current = schedulePopulationV2Relocation(
            player,
            connection.replacedConnectionId ? "reconnect" : "world-entry"
          );
        }
      );
    }
    if (manorRestorationFallback) {
      registry.sendToConnection(connection.connectionId, {
        type: "MANOR_ERROR",
        code: "MANOR_RESTORE_FALLBACK",
        message: manorRestorationFallback
      });
    }
    if (progressionSnapshot) {
      const snapshot = progressionSnapshot;
      const connectionGeneration = state.connectionGeneration!;
      await runIndependentBootstrap(
        "progression",
        connection.connectionId,
        player.playerId,
        async () => {
          const deathPenaltyOperationKey = combat?.deathPenaltyOperationKey(player.playerId) ?? null;
          const deathPenalty = progression && deathPenaltyOperationKey
            ? await progression.deathPenaltyPresentation({
                operationKey: deathPenaltyOperationKey,
                playerId: player.playerId,
                currentTotalXp: snapshot.totalXp
              })
            : null;
          if (!isCurrentPostWelcomeConnection({
            registry,
            connectionGenerations,
            playerId: player.playerId,
            connectionId: connection.connectionId,
            connectionGeneration
          })) return;
          registry.sendToConnection(connection.connectionId, {
            type: "PROGRESSION_SNAPSHOT",
            progression: snapshot,
            ...(deathPenalty ? { deathPenalty } : {})
          });
        }
      );
    }
    if (combat && !restoredManorPresence && !restoredGreenhouseSession) {
      await runIndependentBootstrap(
        "combat",
        connection.connectionId,
        player.playerId,
        () => {
          const interest = worldRuntime?.interestFrameFor([player.playerId]);
          if (sendCombatScopeSnapshot) {
            sendCombatScopeSnapshot(player.playerId, undefined, false);
          } else {
            registry.sendToConnection(
              connection.connectionId,
              {
                type: "COMBAT_SNAPSHOT",
                state: combat.snapshotForPlayer(player.playerId, interest)
              }
            );
          }
        }
      );
    }
    if (worldRuntime && !restoredManorPresence && !restoredSewerId && !restoredGreenhouseSession) {
      await runIndependentBootstrap(
        "players",
        connection.connectionId,
        player.playerId,
        () => {
          const interest = worldRuntime.interestFrameFor([player.playerId]);
          if (!interest) return;
          registry.sendToConnection(
            connection.connectionId,
            {
              type: "PLAYER_SNAPSHOT",
              serverTime: Date.now(),
              sequence: 0,
              players: worldRuntime.replication.snapshotForPlayer(player.playerId, interest)
            }
          );
        }
      );
    }
    await runIndependentBootstrap(
      "flags",
      connection.connectionId,
      player.playerId,
      async () => {
        await publishFlagSnapshot({
          state,
          playerId: player.playerId,
          registry,
          gameState,
          flagService,
          scopedSnapshotsEnabled:
            config?.FLAG_SCOPED_SNAPSHOT_ENABLED ?? false
        });
      }
    );
    await runIndependentBootstrap(
      "chat",
      connection.connectionId,
      player.playerId,
      () => bootstrapChat(connection.connectionId, player.playerId)
    );
    if (cities && !restoredManorPresence && !restoredGreenhouseSession) {
      await runIndependentBootstrap(
        "cities",
        connection.connectionId,
        player.playerId,
        async () => {
          registry.sendToConnection(connection.connectionId, {
            type: "CITIES_SNAPSHOT",
            cities: await cities.listCitiesNear(player.anchor)
          });
        }
      );
      await runIndependentBootstrap(
        "city-membership",
        connection.connectionId,
        player.playerId,
        async () => {
          registry.sendToConnection(connection.connectionId, {
            type: "CITY_MEMBERSHIP_SNAPSHOT",
            membership: await cities.getMembership(player.playerId)
          });
        }
      );
      if (cities.structures) {
        await runIndependentBootstrap(
          "city-structures",
          connection.connectionId,
          player.playerId,
          async () => {
            registry.sendToConnection(connection.connectionId, {
              type: "CITY_STRUCTURES_SNAPSHOT",
              structures: await cities.structures!.listNear(
                player.position,
                CITY_STRUCTURE_SNAPSHOT_RADIUS_M
              )
            });
            registry.sendToConnection(connection.connectionId, {
              type: "OWNER_OIL_WELL_PROJECTION",
              structure: await cities.structures!.ownerOilWellProjection(
                player.playerId,
                player.position
              )
            });
          }
        );
      }
    }
    if (worldMap) {
      await runIndependentBootstrap(
        "world-map",
        connection.connectionId,
        player.playerId,
        async () => {
          registry.sendToConnection(connection.connectionId, {
            type: "WORLD_MAP_DESTINATIONS",
            snapshot: await worldMap.snapshot(player.playerId)
          });
        }
      );
    }
    if (kingdoms) {
      await runIndependentBootstrap(
        "kingdoms",
        connection.connectionId,
        player.playerId,
        async () => {
          registry.sendToConnection(connection.connectionId, {
            type: "KINGDOM_STATE",
            state: await kingdoms.getState(player)
          });
        }
      );
    }
    if (partyAuthority) {
      await runIndependentBootstrap(
        "party",
        connection.connectionId,
        player.playerId,
        () => {
          const party = partyAuthority.partyForPlayer(player.playerId);
          registry.sendToConnection(connection.connectionId, {
            type: "PARTY_SNAPSHOT",
            party,
            invites: [...partyAuthority.invitesForPlayer(player.playerId)],
            inboxInvites: [...partyAuthority.inboxInvitesForPlayer(player.playerId)],
            outgoingInvites: party
              ? [...partyAuthority.outgoingInvitesForParty(party.partyId)]
              : []
          });
          if (party) partyCombatPublisher?.sendSnapshot(player.playerId);
          partyReadyChecks?.sendForPlayer(player.playerId);
          dungeonTorchLobbies?.sendForPlayer(player.playerId);
        }
      );
    }
    if (travelInvites) {
      await runIndependentBootstrap(
        "travel-inbox",
        connection.connectionId,
        player.playerId,
        async () => {
          const relocationStatus = await playerService.relocationStatus(player.playerId);
          const accountId = authenticatedSession?.account.id;
          const landActionAvailableAt = landActions && accountId
            ? await landActions.availableAt(accountId)
            : undefined;
          const relocationExemptionAvailable = settlement && accountId
            ? await settlement.relocationExemptionAvailable(accountId, relocationStatus.lastRelocatedAt)
            : undefined;
          registry.sendToConnection(connection.connectionId, {
            type: "TRAVEL_INBOX_SNAPSHOT",
            entries: await travelInboxEntriesForPlayer(player.playerId),
            serverTime: relocationStatus.serverTime,
            relocationAvailableAt: relocationStatus.relocationAvailableAt,
            travelInviteAvailableAt: relocationStatus.travelInviteAvailableAt,
            ...(landActionAvailableAt === undefined ? {} : { landActionAvailableAt }),
            ...(relocationExemptionAvailable === undefined ? {} : { relocationExemptionAvailable })
          });
        }
      );
    }
    if (masterySnapshot) {
      await runIndependentBootstrap(
        "mastery",
        connection.connectionId,
        player.playerId,
        () => {
          registry.sendToConnection(connection.connectionId, {
            type: "MASTERY_SNAPSHOT",
            masteries: masterySnapshot
          });
        }
      );
    }
    if (achievementSnapshot) {
      await runIndependentBootstrap(
        "achievements",
        connection.connectionId,
        player.playerId,
        () => {
          registry.sendToConnection(connection.connectionId, {
            type: "ACHIEVEMENT_SNAPSHOT",
            achievements: achievementSnapshot
          });
        }
      );
    }
    if (equipmentSnapshot) {
      await runIndependentBootstrap(
        "equipment",
        connection.connectionId,
        player.playerId,
        () => {
          registry.sendToConnection(connection.connectionId, {
            type: "EQUIPMENT_SNAPSHOT",
            equipment: equipmentSnapshot
          });
        }
      );
    }
    if (backpacks) {
      await runIndependentBootstrap(
        "backpacks",
        connection.connectionId,
        player.playerId,
        async () => {
          registry.sendToConnection(connection.connectionId, {
            type: "BACKPACK_SNAPSHOT",
            backpacks: await backpacks.getSnapshot(player.playerId)
          });
        }
      );
    }
    if (inventoryProtection) {
      await runIndependentBootstrap(
        "inventory-protection",
        connection.connectionId,
        player.playerId,
        async () => {
          registry.sendToConnection(connection.connectionId, {
            type: "INVENTORY_PROTECTION_SNAPSHOT",
            protection: await inventoryProtection.snapshot(player.playerId)
          });
        }
      );
    }
    if (classSnapshot) {
      await runIndependentBootstrap(
        "class",
        connection.connectionId,
        player.playerId,
        () => {
          registry.sendToConnection(connection.connectionId, {
            type: "CLASS_SNAPSHOT",
            snapshot: classSnapshot
          });
        }
      );
    }
    if (skillSnapshot) {
      await runIndependentBootstrap(
        "skills-v3",
        connection.connectionId,
        player.playerId,
        () => {
          registry.sendToConnection(connection.connectionId, {
            type: "SKILL_TREE_SNAPSHOT",
            requestId: `bootstrap:${connection.connectionId}:skills-v3`,
            snapshot: skillSnapshot
          });
        }
      );
    }
    const presentationRelocation = startupPopulationRelocation.current;
    const startupPresentationCombatStartedAt =
      presentationRelocation && sendCombatScopeSnapshot
        ? performance.now()
        : null;
    const startupPresentationCombatPublication =
      presentationRelocation && sendCombatScopeSnapshot
        ? publishStartupPresentationCombatSnapshot({
            relocation: presentationRelocation,
            onRejected: (reason) => {
              logger.warn({
                playerId: player.playerId,
                connectionId: presentationRelocation.connectionId,
                connectionGeneration: presentationRelocation.connectionGeneration,
                relocationRevision: presentationRelocation.relocationRevision,
                populationPreparationGeneration:
                  presentationRelocation.preparationGeneration ?? 0,
                reason
              }, "startup presentation combat snapshot rejected");
            },
            sendCombatScopeSnapshot
          }).catch((error: unknown) => {
            logger.warn(
              { err: error, playerId: player.playerId },
              "startup presentation combat snapshot failed"
            );
            return null;
          })
        : null;
    if (pets) {
      await runIndependentBootstrap(
        "pets",
        connection.connectionId,
        player.playerId,
        async () => {
          const petState = await pets.state({
            accountId: authenticatedSession.account.id,
            playerId: player.playerId
          });
          registry.sendToConnection(connection.connectionId, {
            type: "PET_STATE",
            state: petState.state
          });
          dogCompanions?.sync(player.playerId, petState.active);
        }
      );
    }
    const reconnectVision = gameState.getResourceVision(player.playerId);
    const reconnectFlagId = gameState.currentFlagId(player.playerId);
    if (
      resourceVisionJobs &&
      reconnectVision &&
      reconnectFlagId &&
      !restoredManorPresence &&
      !restoredSewerId &&
      !restoredGreenhouseSession
    ) {
      await runIndependentBootstrap(
        "resource-vision-job",
        connection.connectionId,
        player.playerId,
        async () => {
          const relocationRevision = player.relocationRevision ?? 0;
          const resourceVisionRevision =
            gameState.getResourceVisionRevision(player.playerId);
          const isCurrent = (): boolean =>
            registry.isActivePlayerConnection(
              player.playerId,
              connection.connectionId
            ) &&
            (gameState.getPlayer(player.playerId)?.relocationRevision ?? -1) ===
              relocationRevision &&
            gameState.getResourceVisionRevision(player.playerId) ===
              resourceVisionRevision;
          const flag = await flagService.getFlag(reconnectFlagId);
          if (!flag || !isCurrent()) return;
          await resourceVisionJobs.ensureQueued({
            flag,
            regionCode: packageIdForPosition(reconnectVision.center),
            movementLeashRadiusM: player.moveLeashRadiusM,
            reason: "flag-visit",
            onComplete: async (completion) => {
              if (!isCurrent()) return;
              const currentPlayer = gameState.getPlayer(player.playerId);
              const activeVision = gameState.getResourceVision(player.playerId);
              if (
                !currentPlayer ||
                !activeVision ||
                activeVision.flagId !== completion.resourceVision.flagId
              ) return;
              await sendTravelResourceVisionReadyAndSnapshot(
                currentPlayer,
                activeVision,
                completion.status,
                isCurrent
              );
            }
          });
        }
      );
    }
    if (collectibles && !restoredManorPresence && !restoredDungeonSnapshot && !restoredGreenhouseSession) {
      await runIndependentBootstrap(
        "collectibles",
        connection.connectionId,
        player.playerId,
        async () => {
          await sendCollectiblesForPlayer(player);
          const activeSession = await activeHarvestSessionForPlayer(
            player.playerId
          );
          if (!activeSession) return;
          safeSendServerMessage(socket, {
              type: "HARVEST_STARTED",
              requestId: "resume",
              session: activeSession,
              serverTime: Date.now()
            });
        }
      );
    }
    if (fieldConsumables) {
      await runIndependentBootstrap(
        "field-buffs",
        connection.connectionId,
        player.playerId,
        async () => {
          const buffs = [
            ...await fieldConsumables.activeBuffs(player.playerId),
            ...(combat?.fieldBuffSnapshots(player.playerId) ?? [])
          ];
          safeSendServerMessage(socket, { type: "FIELD_BUFFS", buffs, serverTime: Date.now() });
        }
      );
    }
    if (droppedItems && !restoredManorPresence && !restoredGreenhouseSession) {
      await runIndependentBootstrap(
        "dropped-items",
        connection.connectionId,
        player.playerId,
        () => sendDroppedItemsToSocket(player.playerId)
      );
    }
    if (xoralEvents && !restoredManorPresence && !restoredGreenhouseSession) {
      await runIndependentBootstrap(
        "xoral-ring-drops",
        connection.connectionId,
        player.playerId,
        () => xoralEvents.sendAvailableDrops(player.playerId)
      );
    }
    if (manorPresence) {
      await runIndependentBootstrap(
        "manor",
        connection.connectionId,
        player.playerId,
        async () => {
          registry.sendToConnection(connection.connectionId, {
            type: "MANOR_STATUS",
            manor: await manorPresence.status(player.playerId)
          });
          if (!restoredManorPresence && !restoredGreenhouseSession) await sendManorsForPlayer(player);
        }
      );
    }
    if (restoredManorPresence && restoredManorSession && manorStorage) {
      await runIndependentBootstrap(
        "manor-session",
        connection.connectionId,
        player.playerId,
        async () => {
          registry.sendToConnection(connection.connectionId, {
            type: "MANOR_ENTERED",
            manorId: restoredManorPresence.manorId,
            spaceId: restoredManorSession.spaceId,
            manorTypeId: manorRuntime?.manorTypeOf(restoredManorPresence.manorId) ?? resolveManorTypeId(restoredManorPresence.manorTypeId),
            manorSessionId: restoredManorSession.sessionId,
            displayColor: player.displayColor,
            ...(player.appearance ? { appearance: player.appearance } : {}),
            position: restoredManorSession.position,
            movementSequence: restoredManorSession.movementSequence,
            serverTime: Date.now(),
            accessSource: restoredManorPresence.accessSource,
            storage: restoredManorPresence.accessSource === "OWNER"
              ? await manorStorage.snapshotForPlayer(player.playerId)
              : null,
            droppedItems: droppedItems
              ? await droppedItems.listActiveManorDrops(restoredManorPresence.manorId)
              : [],
            ...(manorDecorations
              ? { decorations: restoredManorDecorations ?? await manorDecorations.snapshotForPlayer(
                  player.playerId,
                  restoredManorPresence.manorId
                ) }
              : {})
          });
          if (manorDecorations) {
            manorRuntime?.setManorNavigation(
              restoredManorPresence.manorId,
              restoredManorSession.spaceId,
              manorDecorations.navigationForManor(
                restoredManorPresence.manorId,
                restoredManorSession.spaceId
              )
            );
          }
          if (collectibles) {
            registry.sendToConnection(connection.connectionId, {
              type: "PLAYER_RESOURCES_UPDATED",
              playerId: player.playerId,
              inventory: await collectibles.inventoryForPlayer(player.playerId),
              serverTime: Date.now()
            });
          }
          await sendManorManagementSnapshot(
            restoredManorPresence.ownerPlayerId,
            restoredManorPresence.manorId
          );
          worldRuntime?.sendManorOccupants(restoredManorPresence.manorId);
        }
      );
    }
    if (restoredDungeonSnapshot) {
      registry.sendToConnection(connection.connectionId, {
        type: "DUNGEON_ENTERED",
        requestId: "resume",
        snapshot: restoredDungeonSnapshot
      });
      if (collectibles) {
        registry.sendToConnection(connection.connectionId, {
          type: "PLAYER_RESOURCES_UPDATED",
          playerId: player.playerId,
          inventory: await collectibles.inventoryForPlayer(player.playerId),
          serverTime: Date.now()
        });
      }
    }
    const combatPresentation = await startupPresentationCombatPublication;
    if (startupPresentationCombatStartedAt !== null) {
      logger.info({
        connectionId: connection.connectionId,
        releaseSha: config?.RUNTIME_SHA ?? null,
        bootstrapSubsystem: "startup-presentation-combat",
        bootstrapOutcome: combatPresentation ? "success" : "not-published",
        durationMs: Math.max(
          0,
          performance.now() - startupPresentationCombatStartedAt
        ),
        completedAt: new Date().toISOString()
      }, "websocket post-welcome bootstrap subsystem finished");
    }
    if (
      startupPresentationCombatPublication &&
      !combatPresentation
    ) {
      return;
    }
    const currentPlayer = gameState.getPlayer(player.playerId);
    const connectionGeneration = state.connectionGeneration;
    const activeConnection = Boolean(
      currentPlayer &&
      registry.isActivePlayerConnection(player.playerId, connection.connectionId)
    );
    const currentConnectionGeneration = Boolean(
      connectionGeneration !== null &&
      connectionGenerations.isCurrent(player.playerId, connectionGeneration)
    );
    if (
      currentPlayer &&
      connectionGeneration !== null &&
      activeConnection &&
      currentConnectionGeneration
    ) {
      const presentationAuthority = combatPresentation?.worldViewAuthority;
      const sendResult = registry.sendToConnection(connection.connectionId, {
        type: "PRESENTATION_SNAPSHOT_COMPLETE",
        connectionId:
          presentationAuthority?.connectionId ?? connection.connectionId,
        connectionGeneration:
          presentationAuthority?.connectionGeneration ?? connectionGeneration,
        gameplayViewGeneration:
          presentationAuthority?.gameplayViewGeneration ??
          gameState.getGameplayViewCircle(player.playerId)?.generation ?? 0,
        relocationRevision:
          presentationAuthority?.relocationRevision ??
          currentPlayer.relocationRevision ?? 0,
        resourceVisionRevision:
          presentationAuthority?.resourceVisionRevision ??
          gameState.getResourceVisionRevision(player.playerId),
        populationPreparationGeneration:
          presentationAuthority?.populationPreparationGeneration ??
          presentationRelocation?.preparationGeneration ?? 0
      });
      const sentAt = new Date();
      const logContext = {
        connectionId: connection.connectionId,
        connectionGeneration,
        gameplayViewGeneration:
          gameState.getGameplayViewCircle(player.playerId)?.generation ?? 0,
        relocationRevision: currentPlayer.relocationRevision ?? 0,
        resourceVisionRevision:
          gameState.getResourceVisionRevision(player.playerId),
        releaseSha: config?.RUNTIME_SHA ?? null,
        sendResult,
        sentAt: sentAt.toISOString(),
        postWelcomeDurationMs: Math.max(
          0,
          performance.now() - postWelcomeBootstrapStartedAt
        )
      };
      if (sendResult === "sent") {
        logger.info(
          logContext,
          "websocket presentation snapshot complete sent"
        );
      } else {
        logger.warn(
          logContext,
          "websocket presentation snapshot complete was not sent"
        );
      }
    } else {
      logger.warn({
        connectionId: connection.connectionId,
        connectionGeneration,
        releaseSha: config?.RUNTIME_SHA ?? null,
        currentPlayerPresent: Boolean(currentPlayer),
        activeConnection,
        currentConnectionGeneration,
        skippedAt: new Date().toISOString(),
        postWelcomeDurationMs: Math.max(
          0,
          performance.now() - postWelcomeBootstrapStartedAt
        )
      }, "websocket presentation snapshot complete skipped");
    }
    return;
    } catch (error) {
      setBootstrapAttempt(null);
      if (error instanceof BootstrapAttemptInactiveError) {
        return;
      }
      if (!attempt.welcomed) {
        bootstrapAttempts.cancel(attempt, "bootstrap-failure");
        bootstrapAttempts.close(attempt, 1011, "session bootstrap failed");
      }
      throw error;
    }
  };
}
