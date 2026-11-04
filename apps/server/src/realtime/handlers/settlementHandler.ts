import { CityMarketDailyError } from "../../game/cityMarketDaily.js";
import { LibraryStudyError } from "../../game/libraryStudy.js";
import type { EquipmentSnapshotV2, ProgressionSnapshot, ServerMessage } from "@ash-atlas/shared";

import type { AppLogger } from "../../logger.js";
import type { ChatRealtimeCoordinator } from "../../chat/chatRealtime.js";
import { CityFoundingError, type CityService } from "../../game/cities.js";
import { CityGoldError } from "../../game/cityGold.js";
import { CityStructureError, type CityStructureService } from "../../game/cityStructures.js";
import { CityStructureWarfareError } from "../../game/cityStructureWarfare.js";
import { CityTreasuryError } from "../../game/cityTreasury.js";
import { CityWarehouseError } from "../../game/cityWarehouse.js";
import { MilitaryIndustryError } from "../../game/militaryIndustry.js";
import type { CombatEngine } from "../../game/combat/combatEngine.js";
import type { EquipmentService } from "../../game/equipment.js";
import type {
  CityFlagConversionCoordinator
} from "../../game/cityFlagConversionCoordinator.js";
import { flagSetRevisionMetadata, type FlagService } from "../../game/flags.js";
import type { GameState } from "../../game/state.js";
import type { KingdomService } from "../../game/kingdoms.js";
import type { ProgressionService } from "../../game/progression.js";
import type { PlayerAuthorityFence } from "../../game/playerAuthorityFence.js";
import { GoblinVillageError, type GoblinVillageService } from "../../game/goblinVillage.js";
import { HollinHutError, type HollinHutService } from "../../game/hollinHuts.js";
import { CinderLanternError, type CinderLanternService } from "../../game/cinderLanterns.js";
import { WanderingMerchantError, type WanderingMerchantService } from "../../game/wanderingMerchants.js";
import type { AuthService } from "../../auth/authService.js";
import type { AuthenticatedSession } from "../../auth/types.js";
import { MapMarkerError, type MapMarkerService, type MapMarkerResult } from "../../game/mapMarkers.js";
import { WorldMapError, type WorldMapService } from "../../game/worldMap.js";
import type { ConnectionRegistry, SocketLike } from "../connectionRegistry.js";
import type { RealtimeFamilyHandler, RealtimeMessageRouter } from "../messageRouter.js";
import { requireHello, sendCombatError, type RealtimeConnectionState } from "./handlerExecutionContext.js";
import type { LandActionGate } from "../../auth/trust/trustService.js";
import { landActionAllowed, noteLandAction } from "./landActionGuard.js";
import type { HostileActionGate, HostileMilitaryOrder } from "../../auth/trust/hostileGate.js";
import type { DestinationAnchorGate, StructureOpenKind } from "../../auth/trust/destinationAnchorGate.js";

export type SettlementHandlerContext = Readonly<{
  state: Pick<RealtimeConnectionState, "playerId">;
  socket: SocketLike;
  registry: ConnectionRegistry;
  gameState: GameState;
  flagService: FlagService;
  progression?: ProgressionService | undefined;
  equipment?: EquipmentService | undefined;
  goblinVillage?: GoblinVillageService | undefined;
  hollinHuts?: HollinHutService | undefined;
  wanderingMerchants?: WanderingMerchantService | undefined;
  cinderLanterns?: CinderLanternService | undefined;
  authenticatedSession?: AuthenticatedSession | null | undefined;
  auth?: Pick<AuthService, "hasDeveloperCapability"> | undefined;
  landActions?: LandActionGate | undefined;
  hostileGate?: HostileActionGate | undefined;
  destinationAnchors?: Pick<DestinationAnchorGate, "checkOpenStructure"> | undefined;
  cities?: CityService | undefined;
  combat?: Pick<CombatEngine, "applyMilitaryAttack"> | undefined;
  cityFlagConversions?: CityFlagConversionCoordinator | null | undefined;
  kingdoms?: KingdomService | undefined;
  chats?: ChatRealtimeCoordinator | undefined;
  worldMap?: WorldMapService | undefined;
  mapMarkers?: MapMarkerService | undefined;
  playerAuthorityFence: PlayerAuthorityFence;
  refreshAuthoritativePlayerStats(playerId: string): Promise<{
    progression: ProgressionSnapshot;
    equipment: EquipmentSnapshotV2;
  }>;
  safeSendServerMessage(
    socket: SocketLike,
    message: ServerMessage,
    logger?: Pick<AppLogger, "warn">,
    context?: Record<string, unknown>
  ): boolean;
}>;

export function createSettlementHandler(
  context: SettlementHandlerContext
): RealtimeFamilyHandler<"settlement"> {
  return async (message) => {
    const {
      state,
      socket,
      registry,
      gameState,
      flagService,
      progression,
      equipment,
      goblinVillage,
      hollinHuts,
      wanderingMerchants,
      cinderLanterns,
      authenticatedSession,
      auth,
      landActions,
      hostileGate,
      destinationAnchors,
      cities,
      combat,
      cityFlagConversions,
      kingdoms,
      chats,
      worldMap,
      mapMarkers,
      playerAuthorityFence,
      refreshAuthoritativePlayerStats,
      safeSendServerMessage
    } = context;
    // Hostile-action gate (plan 3.4): unsettled accounts cannot give hostile
    // military orders; military attacks on players use the two-way PvP shield.
    const hostileMilitaryAllowed = async (
      requestId: string,
      order: HostileMilitaryOrder,
      groupId: string,
      targetEntityId?: string
    ): Promise<boolean> => {
      if (!hostileGate || !state.playerId) return true;
      const decision = order === "attack_group"
        ? targetEntityId && gameState.getPlayer(targetEntityId)
          ? await hostileGate.checkPvp({ attackerPlayerId: state.playerId, targetPlayerId: targetEntityId })
          : { allowed: true as const }
        : await hostileGate.checkMilitaryOrder({ playerId: state.playerId, order, groupId });
      if (decision.allowed) return true;
      sendCombatError(socket, requestId, decision.code, decision.message);
      return false;
    };
    // Private until Settled (plan 3.3): founding or joining a city flag opens
    // land to every traveller.
    const openStructureAllowed = async (requestId: string, kind: StructureOpenKind): Promise<boolean> => {
      if (!destinationAnchors || !state.playerId) return true;
      const refusal = await destinationAnchors.checkOpenStructure({ playerId: state.playerId, kind });
      if (!refusal) return true;
      safeSendServerMessage(socket, { type: "ERROR", requestId, code: refusal.code, message: refusal.message });
      return false;
    };
    switch (message.type) {
      case "OPEN_GOBLIN_MARKET": {
        requireHello(state.playerId);
        const player = gameState.getPlayer(state.playerId);
        if (!player || !goblinVillage) {
          safeSendServerMessage(socket, {
            type: "GOBLIN_MARKET_ERROR",
            requestId: message.requestId,
            code: "GOBLIN_MARKET_UNAVAILABLE",
            message: "Goblin Market is unavailable"
          });
          return;
        }
        try {
          safeSendServerMessage(socket, {
            type: "GOBLIN_MARKET_SNAPSHOT",
            requestId: message.requestId,
            snapshot: await goblinVillage.openMarket(player, message.marketStructureId)
          });
        } catch (error) {
          safeSendServerMessage(socket, {
            type: "GOBLIN_MARKET_ERROR",
            requestId: message.requestId,
            code: error instanceof GoblinVillageError ? error.code : "GOBLIN_MARKET_OPEN_FAILED",
            message: error instanceof Error ? error.message : "Goblin Market could not be opened"
          });
        }
        return;
      }
      case "SELL_TO_GOBLIN_MARKET": {
        requireHello(state.playerId);
        const player = gameState.getPlayer(state.playerId);
        if (!player || !goblinVillage || !authenticatedSession) {
          safeSendServerMessage(socket, {
            type: "GOBLIN_MARKET_ERROR",
            requestId: message.requestId,
            code: "GOBLIN_MARKET_UNAVAILABLE",
            message: "Goblin Market is unavailable"
          });
          return;
        }
        try {
          const result = await goblinVillage.sell(
            player,
            authenticatedSession.account.id,
            {
              requestId: message.requestId,
              marketStructureId: message.marketStructureId,
              itemKind: message.itemKind,
              itemIdentity: message.itemIdentity,
              quantity: message.quantity,
              expectedOfferGold: message.expectedOfferGold
            }
          );
          safeSendServerMessage(socket, {
            type: "GOBLIN_MARKET_SOLD",
            requestId: message.requestId,
            ...result
          });
        } catch (error) {
          safeSendServerMessage(socket, {
            type: "GOBLIN_MARKET_ERROR",
            requestId: message.requestId,
            code: error instanceof GoblinVillageError ? error.code : "GOBLIN_MARKET_SALE_FAILED",
            message: error instanceof Error ? error.message : "Goblin Market sale failed"
          });
        }
        return;
      }
      case "BUY_FROM_GOBLIN_MARKET": {
        requireHello(state.playerId);
        const player = gameState.getPlayer(state.playerId);
        if (!player || !goblinVillage || !authenticatedSession) {
          safeSendServerMessage(socket, {
            type: "GOBLIN_MARKET_ERROR",
            requestId: message.requestId,
            code: "GOBLIN_MARKET_UNAVAILABLE",
            message: "Goblin Market is unavailable"
          });
          return;
        }
        try {
          const result = await goblinVillage.buy(
            player,
            authenticatedSession.account.id,
            {
              requestId: message.requestId,
              marketStructureId: message.marketStructureId,
              itemId: message.itemId,
              quantity: message.quantity,
              expectedUnitPriceGold: message.expectedUnitPriceGold
            }
          );
          safeSendServerMessage(socket, {
            type: "GOBLIN_MARKET_PURCHASED",
            requestId: message.requestId,
            ...result
          });
        } catch (error) {
          safeSendServerMessage(socket, {
            type: "GOBLIN_MARKET_ERROR",
            requestId: message.requestId,
            code: error instanceof GoblinVillageError ? error.code : "GOBLIN_MARKET_PURCHASE_FAILED",
            message: error instanceof Error ? error.message : "Goblin Market purchase failed"
          });
        }
        return;
      }
      case "OPEN_HOLLIN_HUT":
      case "BUY_FROM_HOLLIN_HUT":
      case "OFFER_BERRY_TO_HOLLINS":
      case "USE_HOLLIN_HUT_SERVICE": {
        requireHello(state.playerId);
        const player = gameState.getPlayer(state.playerId);
        if (!player || !hollinHuts || !authenticatedSession) {
          safeSendServerMessage(socket, {
            type: "HOLLIN_HUT_ERROR", requestId: message.requestId,
            code: "HOLLIN_UNAVAILABLE", message: "Hollin Huts are unavailable"
          });
          return;
        }
        const accountId = authenticatedSession.account.id;
        try {
          if (message.type === "OPEN_HOLLIN_HUT") {
            safeSendServerMessage(socket, {
              type: "HOLLIN_HUT_SHOP", requestId: message.requestId,
              snapshot: await hollinHuts.shopFor(player, accountId, message.hutId)
            });
          } else if (message.type === "BUY_FROM_HOLLIN_HUT") {
            const result = await hollinHuts.buy(player, accountId, message);
            safeSendServerMessage(socket, { type: "HOLLIN_HUT_PURCHASED", requestId: message.requestId, ...result });
          } else if (message.type === "USE_HOLLIN_HUT_SERVICE") {
            const { skills, ...result } = message.service === "heal"
              ? await hollinHuts.heal(player, accountId, message)
              : await hollinHuts.turnInEggs(player, accountId, message);
            if (skills) {
              safeSendServerMessage(socket, { type: "SKILL_TREE_SNAPSHOT", requestId: message.requestId, snapshot: skills });
            }
            safeSendServerMessage(socket, { type: "HOLLIN_HUT_SERVICED", requestId: message.requestId, ...result });
          } else {
            const result = await hollinHuts.pacify(player, accountId, message);
            safeSendServerMessage(socket, { type: "HOLLIN_HUT_PACIFIED", requestId: message.requestId, ...result });
          }
        } catch (error) {
          safeSendServerMessage(socket, {
            type: "HOLLIN_HUT_ERROR",
            requestId: message.requestId,
            code: error instanceof HollinHutError ? error.code : "HOLLIN_FAILED",
            message: error instanceof Error ? error.message : "The Hollins could not help"
          });
        }
        return;
      }
      case "LIST_WANDERING_MERCHANTS": {
        requireHello(state.playerId);
        safeSendServerMessage(socket, {
          type: "WANDERING_MERCHANTS",
          merchants: wanderingMerchants ? await wanderingMerchants.listActive(state.playerId) : []
        });
        return;
      }
      case "OPEN_WANDERING_MERCHANT":
      case "BUY_FROM_WANDERING_MERCHANT": {
        requireHello(state.playerId);
        const player = gameState.getPlayer(state.playerId);
        if (!player || !wanderingMerchants || !authenticatedSession) {
          safeSendServerMessage(socket, {
            type: "WANDERING_MERCHANT_ERROR", requestId: message.requestId,
            code: "MERCHANT_UNAVAILABLE", message: "The Wandering Merchant is unavailable"
          });
          return;
        }
        const accountId = authenticatedSession.account.id;
        try {
          if (message.type === "OPEN_WANDERING_MERCHANT") {
            safeSendServerMessage(socket, {
              type: "WANDERING_MERCHANT_SHOP", requestId: message.requestId,
              snapshot: await wanderingMerchants.shopFor(player, accountId, message.merchantId)
            });
          } else {
            const result = await wanderingMerchants.buy(player, accountId, message);
            safeSendServerMessage(socket, { type: "WANDERING_MERCHANT_PURCHASED", requestId: message.requestId, ...result });
          }
        } catch (error) {
          safeSendServerMessage(socket, {
            type: "WANDERING_MERCHANT_ERROR",
            requestId: message.requestId,
            code: error instanceof WanderingMerchantError ? error.code : "MERCHANT_FAILED",
            message: error instanceof Error ? error.message : "The merchant could not help"
          });
        }
        return;
      }
      case "CRAFT_CINDER_LANTERN": {
        requireHello(state.playerId);
        if (!cinderLanterns) {
          safeSendServerMessage(socket, {
            type: "WANDERING_MERCHANT_ERROR", requestId: message.requestId,
            code: "LANTERN_UNAVAILABLE", message: "Lanterns are unavailable"
          });
          return;
        }
        try {
          const result = await cinderLanterns.craft(
            state.playerId, message.requestId, message.lantern ?? "cinder"
          );
          safeSendServerMessage(socket, {
            type: "CINDER_LANTERN_CRAFTED", requestId: message.requestId,
            replayed: result.replayed, charges: result.charges, inventory: result.inventory,
            message: `Crafted a ${message.lantern === "challenger" ? "Challenger's" : "Cinder's"} Lantern with ${result.charges} charges.`
          });
        } catch (error) {
          safeSendServerMessage(socket, {
            type: "WANDERING_MERCHANT_ERROR",
            requestId: message.requestId,
            code: error instanceof CinderLanternError ? error.code : "LANTERN_CRAFT_FAILED",
            message: error instanceof Error ? error.message : "The lantern could not be crafted"
          });
        }
        return;
      }
      case "REQUEST_KINGDOM_STATE": {
        requireHello(state.playerId);
        if (!kingdoms) throw new Error("Kingdom service is unavailable");
        const player = gameState.getPlayer(state.playerId);
        safeSendServerMessage(socket, {
          type: "KINGDOM_STATE",
          state: await kingdoms.getState(player ?? state.playerId)
        });
        if (progression && equipment) {
          const refreshed = await refreshAuthoritativePlayerStats(state.playerId);
          safeSendServerMessage(socket, {
            type: "PROGRESSION_SNAPSHOT",
            progression: refreshed.progression
          });
        }
        return;
      }
      case "PREVIEW_CITY_FOUNDING": {
        requireHello(state.playerId);
        const player = gameState.getPlayer(state.playerId);
        if (!player || !cities) {
          throw new Error("city founding service is unavailable");
        }
        try {
          const preview = await cities.previewFounding(player, message.flagId);
          safeSendServerMessage(socket, {
            type: "CITY_FOUNDING_PREVIEW",
            requestId: message.requestId,
            preview
          });
        } catch (error) {
          safeSendServerMessage(socket, {
            type: "ERROR",
            requestId: message.requestId,
            code: error instanceof CityFoundingError ? error.code : "CITY_FOUNDING_PREVIEW_FAILED",
            message: error instanceof Error ? error.message : "City founding preview failed",
            ...(error instanceof CityFoundingError && error.details
              ? { details: error.details }
              : {})
          });
        }
        return;
      }
      case "FOUND_CITY": {
        requireHello(state.playerId);
        const player = gameState.getPlayer(state.playerId);
        if (!player || !cities) {
          throw new Error("city founding service is unavailable");
        }
        const landAction = {
          landActions,
          accountId: authenticatedSession?.account.id ?? null,
          playerId: state.playerId,
          action: "city_found" as const,
          position: player.position
        };
        if (!(await landActionAllowed(landAction, socket, message.requestId, sendCombatError))) return;
        if (!(await openStructureAllowed(message.requestId, "city_found"))) return;
        try {
          const result = await cities.foundCity(player, {
            requestId: message.requestId,
            flagId: message.flagId
          });
          noteLandAction(landAction);
          const territoryFlags = (await Promise.all(
            result.territoryFlagIds.map((flagId) => flagService.getMapFlag(flagId))
          )).filter((flag) => flag !== null);
          if (territoryFlags.length !== result.territoryFlagIds.length) {
            throw new Error("founded city territory snapshot is incomplete");
          }
          const seatFlag = territoryFlags.find(({ id }) => id === result.seatFlagId);
          if (!seatFlag) throw new Error("founded City Center snapshot is unavailable");
          safeSendServerMessage(socket, {
            type: "CITY_FOUNDED",
            requestId: message.requestId,
            city: result.city,
            seatFlag,
            territoryFlags,
            replayed: result.replayed,
            materialCost: 0
          });
          await Promise.all(registry.records().map(async (record) => {
            const visibleToPlayer = gameState.getPlayer(record.playerId);
            if (!visibleToPlayer) return;
            registry.sendToConnection(record.connectionId, {
              type: "CITIES_SNAPSHOT",
              cities: await cities.listCitiesNear(visibleToPlayer.anchor)
            });
          }));
          registry.broadcast({
            type: "CITY_TERRITORY_SYNC",
            cityId: result.city.id,
            flags: territoryFlags
          });
          if (!result.replayed) {
            const revisionMetadata =
              await flagSetRevisionMetadata(flagService);
            for (const flag of territoryFlags) {
              registry.broadcast({
                type: "FLAG_UPDATED",
                flag,
                ...revisionMetadata
              });
            }
            for (const annexed of result.annexedFlags) {
              registry.send(annexed.previousOwnerPlayerId, {
                type: "FLAG_ACCESS_CHANGED",
                flagId: annexed.flagId,
                message: `${result.city.name} annexed this flag into its founding territory.`,
                ...revisionMetadata
              });
            }
          }
          registry.send(state.playerId, {
            type: "CITY_MEMBERSHIP_SNAPSHOT",
            membership: await cities.getMembership(state.playerId)
          });
          await chats?.refreshAuthorizedPlayer(state.playerId);
          if (worldMap) {
            registry.send(state.playerId, {
              type: "WORLD_MAP_DESTINATIONS",
              snapshot: await worldMap.snapshot(state.playerId)
            });
          }
          for (const affectedPlayerId of new Set([
            state.playerId,
            ...result.annexedFlags.map(({ previousOwnerPlayerId }) => previousOwnerPlayerId)
          ])) {
            registry.broadcast({ type: "SOCIAL_STATE_CHANGED", playerId: affectedPlayerId });
          }
        } catch (error) {
          safeSendServerMessage(socket, {
            type: "ERROR",
            requestId: message.requestId,
            code: error instanceof CityFoundingError ? error.code : "CITY_FOUNDING_FAILED",
            message: error instanceof Error ? error.message : "City founding failed",
            ...(error instanceof CityFoundingError && error.details
              ? { details: error.details }
              : {})
          });
        }
        return;
      }
      case "ADVANCE_CITY_CONSTRUCTION": {
        requireHello(state.playerId);
        if (!cities) throw new Error("city construction service is unavailable");
        try {
          const result = await cities.advanceConstruction(state.playerId, {
            requestId: message.requestId,
            cityId: message.cityId,
            action: message.action
          });
          safeSendServerMessage(socket, {
            type: "CITY_CONSTRUCTION_ADVANCED",
            requestId: message.requestId,
            action: result.action,
            city: result.city,
            replayed: result.replayed,
            ...(result.inventory ? { inventory: result.inventory } : {}),
            ...(result.walletGold !== undefined
              ? { walletGold: result.walletGold, walletVersion: result.walletVersion }
              : {})
          });
          await Promise.all(registry.records().map(async (record) => {
            const visibleToPlayer = gameState.getPlayer(record.playerId);
            if (!visibleToPlayer) return;
            registry.sendToConnection(record.connectionId, {
              type: "CITIES_SNAPSHOT",
              cities: await cities.listCitiesNear(visibleToPlayer.anchor)
            });
          }));
          if (result.city.constructionPhase === "complete" && worldMap) {
            registry.send(state.playerId, {
              type: "WORLD_MAP_DESTINATIONS",
              snapshot: await worldMap.snapshot(state.playerId)
            });
          }
        } catch (error) {
          safeSendServerMessage(socket, {
            type: "ERROR",
            requestId: message.requestId,
            code: error instanceof CityFoundingError
              ? error.code
              : "CITY_CONSTRUCTION_FAILED",
            message: error instanceof Error ? error.message : "City construction failed",
            ...(error instanceof CityFoundingError && error.details
              ? { details: error.details }
              : {})
          });
        }
        return;
      }
      case "REQUEST_CITY_INFO": {
        requireHello(state.playerId);
        if (!cities) throw new Error("city service is unavailable");
        try {
          safeSendServerMessage(socket, {
            type: "CITY_INFO",
            requestId: message.requestId,
            info: await cities.getCityInfo(state.playerId, message.cityId)
          });
        } catch (error) {
          safeSendServerMessage(socket, {
            type: "ERROR",
            requestId: message.requestId,
            code: error instanceof CityFoundingError ? error.code : "CITY_INFO_FAILED",
            message: error instanceof Error ? error.message : "City information is unavailable"
          });
        }
        return;
      }
      case "REQUEST_CITY_APP": {
        requireHello(state.playerId);
        if (!cities) throw new Error("city service is unavailable");
        try {
          safeSendServerMessage(socket, {
            type: "CITY_APP",
            requestId: message.requestId,
            snapshot: await cities.getCityApp(state.playerId)
          });
        } catch (error) {
          sendCityActionError(socket, message.requestId, error, safeSendServerMessage);
        }
        return;
      }
      case "BUILD_CITY_HOUSE": {
        requireHello(state.playerId);
        const player = gameState.getPlayer(state.playerId);
        if (!cities?.structures || !player) throw new Error("City House service is unavailable");
        try {
          requireStationaryCityBuilder(gameState, state.playerId, player);
          const result = await cities.structures.buildHouse(
            state.playerId,
            player.position,
            message.requestId
          );
          registry.broadcast({
            type: "CITY_HOUSE_CHANGED",
            requestId: message.requestId,
            structure: result.structure,
            membership: result.membership,
            replayed: result.replayed
          });
          if (result.structure.state === "constructing") {
            gameState.setMovementBlocked(
              state.playerId,
              true,
              "city-construction"
            );
          }
          registry.send(state.playerId, {
            type: "CITY_MEMBERSHIP_SNAPSHOT",
            membership: await cities.getMembership(state.playerId)
          });
          await chats?.refreshAuthorizedPlayer(state.playerId);
          registry.broadcast({ type: "SOCIAL_STATE_CHANGED", playerId: state.playerId });
        } catch (error) {
          sendCityActionError(socket, message.requestId, error, safeSendServerMessage);
        }
        return;
      }
      case "DESTROY_CITY_HOUSE": {
        requireHello(state.playerId);
        if (!cities?.structures) throw new Error("City House service is unavailable");
        try {
          const result = await cities.structures.destroyHouse(
            state.playerId,
            message.structureId,
            message.expectedPlacementRevision,
            message.requestId
          );
          registry.broadcast({
            type: "CITY_HOUSE_CHANGED",
            requestId: message.requestId,
            structure: result.structure,
            membership: null,
            replayed: result.replayed,
            ...(result.inventory ? { inventory: result.inventory } : {}),
            ...(result.droppedItems
              ? { droppedItems: result.droppedItems }
              : {})
          });
          registry.send(state.playerId, { type: "CITY_MEMBERSHIP_SNAPSHOT", membership: null });
          gameState.setMovementBlocked(
            state.playerId,
            false,
            "city-construction"
          );
          cities.districtBenefits.clearRuntime(state.playerId);
          await chats?.refreshAuthorizedPlayer(state.playerId);
          registry.broadcast({ type: "SOCIAL_STATE_CHANGED", playerId: state.playerId });
          for (const structure of result.destroyedStructures ?? []) {
            registry.broadcast({
              type: "CITY_FACILITY_CHANGED",
              requestId: message.requestId,
              structure
            });
          }
        } catch (error) {
          sendCityActionError(socket, message.requestId, error, safeSendServerMessage);
        }
        return;
      }
      case "BUILD_OIL_WELL": {
        requireHello(state.playerId);
        const player = gameState.getPlayer(state.playerId);
        if (!cities?.structures || !player) {
          throw new Error("Oil Well service is unavailable");
        }
        try {
          requireStationaryCityBuilder(gameState, state.playerId, player);
          const result = await cities.structures.buildOilWell(
            state.playerId,
            message.cityId,
            player.position,
            message.requestId,
            message.structureType ?? "oil_well"
          );
          registry.broadcast({
            type: "CITY_FACILITY_CHANGED",
            requestId: message.requestId,
            structure: result.structure
          });
          if (result.inventory) {
            registry.send(state.playerId, {
              type: "PLAYER_RESOURCES_UPDATED",
              playerId: state.playerId,
              inventory: result.inventory,
              serverTime: Date.now()
            });
          }
          if (result.structure.state === "constructing") {
            gameState.setMovementBlocked(
              state.playerId,
              true,
              "city-construction"
            );
          }
        } catch (error) {
          sendCityActionError(socket, message.requestId, error, safeSendServerMessage);
        }
        return;
      }
      case "OPEN_OIL_WELL": {
        requireHello(state.playerId);
        const player = gameState.getPlayer(state.playerId);
        if (!cities?.structures || !player) {
          throw new Error("Oil Well service is unavailable");
        }
        try {
          safeSendServerMessage(socket, {
            type: "OIL_WELL_OPENED",
            requestId: message.requestId,
            well: await cities.structures.openOilWell(
              state.playerId,
              message.structureId,
              player.position,
              message.remote === true
            )
          });
        } catch (error) {
          sendCityActionError(socket, message.requestId, error, safeSendServerMessage);
        }
        return;
      }
      case "OPEN_LIBRARY": {
        requireHello(state.playerId);
        const player = gameState.getPlayer(state.playerId);
        if (!cities?.structures || !player) {
          throw new Error("Library service is unavailable");
        }
        try {
          safeSendServerMessage(socket, {
            type: "LIBRARY_STATE",
            requestId: message.requestId,
            library: await cities.structures.library.open(
              state.playerId,
              message.structureId,
              player.position
            )
          });
        } catch (error) {
          sendCityActionError(socket, message.requestId, error, safeSendServerMessage);
        }
        return;
      }
      case "STUDY_LIBRARY": {
        const playerId = state.playerId;
        requireHello(playerId);
        const structures = cities?.structures;
        if (!structures) {
          throw new Error("Library service is unavailable");
        }
        try {
          const result = await playerAuthorityFence.run(playerId, async () => {
            const player = gameState.getPlayer(playerId);
            if (!player) {
              throw new Error("Library service is unavailable");
            }
            return structures.library.study(
              playerId,
              message.structureId,
              player.position,
              message.requestId
            );
          });
          safeSendServerMessage(socket, {
            type: "LIBRARY_STATE",
            requestId: message.requestId,
            library: result.library,
            result: result.result,
            walletGold: result.walletGold,
            walletVersion: result.walletVersion
          });
        } catch (error) {
          sendCityActionError(socket, message.requestId, error, safeSendServerMessage);
        }
        return;
      }
      case "HARVEST_OIL_WELL": {
        const playerId = state.playerId;
        requireHello(playerId);
        const structures = cities?.structures;
        if (!structures) {
          throw new Error("Oil Well service is unavailable");
        }
        try {
          const result = await playerAuthorityFence.run(playerId, async () => {
            const player = gameState.getPlayer(playerId);
            if (!player) {
              throw new Error("Oil Well service is unavailable");
            }
            return structures.harvestOilWell(
              playerId,
              message.structureId,
              player.position,
              message.requestId,
              message.remote === true
            );
          });
          const { masteryGrant, ...wireResult } = result;
          safeSendServerMessage(socket, {
            type: "OIL_WELL_HARVESTED",
            requestId: message.requestId,
            ...wireResult
          });
          registry.send(playerId, {
            type: "PLAYER_RESOURCES_UPDATED",
            playerId,
            inventory: result.inventory,
            serverTime: result.well.serverTime
          });
          if (masteryGrant && !result.replayed) {
            registry.send(playerId, { type: "MASTERY_SNAPSHOT", masteries: masteryGrant.snapshot });
          }
        } catch (error) {
          sendCityActionError(socket, message.requestId, error, safeSendServerMessage);
        }
        return;
      }
      case "DESTROY_OIL_WELL": {
        requireHello(state.playerId);
        const player = gameState.getPlayer(state.playerId);
        if (!cities?.structures || !player) {
          throw new Error("Oil Well service is unavailable");
        }
        try {
          const result = await cities.structures.destroyOilWell(
            state.playerId,
            message.structureId,
            message.expectedPlacementRevision,
            player.position,
            message.requestId
          );
          registry.broadcast({
            type: "CITY_FACILITY_CHANGED",
            requestId: message.requestId,
            structure: result.structure,
            ...(result.droppedItems
              ? { droppedItems: result.droppedItems }
              : {})
          });
          if (result.inventory) {
            registry.send(state.playerId, {
              type: "PLAYER_RESOURCES_UPDATED",
              playerId: state.playerId,
              inventory: result.inventory,
              serverTime: Date.now()
            });
          }
        } catch (error) {
          sendCityActionError(socket, message.requestId, error, safeSendServerMessage);
        }
        return;
      }
      case "BUILD_CITY_FACILITY": {
        requireHello(state.playerId);
        const player = gameState.getPlayer(state.playerId);
        if (!cities?.structures || !player) throw new Error("City facility service is unavailable");
        try {
          requireStationaryCityBuilder(gameState, state.playerId, player);
          const structure = await cities.structures.buildFacility(
            state.playerId,
            message.cityId,
            message.facilityType,
            player.position,
            message.requestId
          );
          registry.broadcast({
            type: "CITY_FACILITY_CHANGED",
            requestId: message.requestId,
            structure
          });
          if (structure.state === "constructing") {
            gameState.setMovementBlocked(
              state.playerId,
              true,
              "city-construction"
            );
          }
        } catch (error) {
          sendCityActionError(socket, message.requestId, error, safeSendServerMessage);
        }
        return;
      }
      case "BUILD_MILITARY_FACILITY": {
        requireHello(state.playerId);
        const player = gameState.getPlayer(state.playerId);
        if (!cities?.structures || !player) throw new Error("City facility service is unavailable");
        try {
          requireStationaryCityBuilder(gameState, state.playerId, player);
          const structure = await cities.structures.buildFacility(
            state.playerId,
            message.cityId,
            message.facilityType,
            player.position,
            message.requestId
          );
          registry.broadcast({
            type: "CITY_FACILITY_CHANGED",
            requestId: message.requestId,
            structure
          });
          if (structure.state === "constructing") {
            gameState.setMovementBlocked(state.playerId, true, "city-construction");
          }
        } catch (error) {
          sendCityActionError(socket, message.requestId, error, safeSendServerMessage);
        }
        return;
      }
      case "BUILD_LODGE": {
        requireHello(state.playerId);
        const player = gameState.getPlayer(state.playerId);
        if (!cities?.militaryIndustry || !player) throw new Error("Lodge service is unavailable");
        try {
          requireStationaryCityBuilder(gameState, state.playerId, player);
          const result = await cities.militaryIndustry.buildLodge(player, message.requestId);
          safeSendServerMessage(socket, {
            type: "MILITARY_INDUSTRY_CHANGED",
            requestId: message.requestId,
            snapshot: result.snapshot,
            replayed: result.replayed,
            ...(result.inventory ? { inventory: result.inventory } : {}),
            ...(result.walletGold ? { walletGold: result.walletGold } : {}),
            ...(result.walletVersion ? { walletVersion: result.walletVersion } : {})
          });
          if (result.inventory) {
            registry.send(state.playerId, {
              type: "PLAYER_RESOURCES_UPDATED",
              playerId: state.playerId,
              inventory: result.inventory,
              serverTime: Date.now()
            });
          }
        } catch (error) {
          sendCityActionError(socket, message.requestId, error, safeSendServerMessage);
        }
        return;
      }
      case "UPGRADE_LODGE": {
        requireHello(state.playerId);
        if (!cities?.militaryIndustry) throw new Error("Lodge service is unavailable");
        try {
          const result = await cities.militaryIndustry.upgradeLodge(
            state.playerId,
            message.requestId,
            message.expectedLevel as 1 | 2 | 3 | 4 | 5
          );
          safeSendServerMessage(socket, {
            type: "MILITARY_INDUSTRY_CHANGED",
            requestId: message.requestId,
            snapshot: result.snapshot,
            replayed: result.replayed,
            ...(result.inventory ? { inventory: result.inventory } : {}),
            ...(result.walletGold ? { walletGold: result.walletGold } : {}),
            ...(result.walletVersion ? { walletVersion: result.walletVersion } : {})
          });
          if (result.inventory) {
            registry.send(state.playerId, {
              type: "PLAYER_RESOURCES_UPDATED",
              playerId: state.playerId,
              inventory: result.inventory,
              serverTime: Date.now()
            });
          }
        } catch (error) {
          sendCityActionError(socket, message.requestId, error, safeSendServerMessage);
        }
        return;
      }
      case "DESTROY_LODGE": {
        requireHello(state.playerId);
        if (!cities?.militaryIndustry) throw new Error("Lodge service is unavailable");
        try {
          const result = await cities.militaryIndustry.destroyLodge(state.playerId, message.requestId);
          safeSendServerMessage(socket, {
            type: "MILITARY_INDUSTRY_CHANGED",
            requestId: message.requestId,
            snapshot: result.snapshot,
            replayed: result.replayed
          });
        } catch (error) {
          sendCityActionError(socket, message.requestId, error, safeSendServerMessage);
        }
        return;
      }
      case "REQUEST_MILITARY_INDUSTRY": {
        requireHello(state.playerId);
        if (!cities?.militaryIndustry) throw new Error("Military Industry service is unavailable");
        const player = gameState.getPlayer(state.playerId);
        safeSendServerMessage(socket, {
          type: "MILITARY_INDUSTRY_STATE",
          requestId: message.requestId,
          snapshot: await cities.militaryIndustry.snapshot(state.playerId, player ?? undefined)
        });
        return;
      }
      case "TRAIN_SIEGE_CREW": {
        requireHello(state.playerId);
        const player = gameState.getPlayer(state.playerId);
        const accountId = authenticatedSession?.account.id;
        if (!cities?.militaryIndustry || !player || !accountId) throw new Error("Military Industry service is unavailable");
        try {
          const result = await cities.militaryIndustry.startSiegeCrewTraining(
            player,
            accountId,
            message.facilityStructureId,
            message.requestId
          );
          safeSendServerMessage(socket, {
            type: "MILITARY_INDUSTRY_CHANGED",
            requestId: message.requestId,
            snapshot: result.snapshot,
            replayed: result.replayed,
            ...(result.inventory ? { inventory: result.inventory } : {}),
            ...(result.walletGold ? { walletGold: result.walletGold } : {}),
            ...(result.walletVersion ? { walletVersion: result.walletVersion } : {})
          });
          if (result.inventory) {
            registry.send(state.playerId, {
              type: "PLAYER_RESOURCES_UPDATED",
              playerId: state.playerId,
              inventory: result.inventory,
              serverTime: Date.now()
            });
          }
        } catch (error) {
          sendCityActionError(socket, message.requestId, error, safeSendServerMessage);
        }
        return;
      }
      case "TRAIN_MILITARY_UNIT": {
        requireHello(state.playerId);
        const player = gameState.getPlayer(state.playerId);
        const accountId = authenticatedSession?.account.id;
        if (!cities?.militaryIndustry || !player || !accountId) throw new Error("Military Industry service is unavailable");
        try {
          const result = await cities.militaryIndustry.startMilitaryUnitTraining(
            player,
            accountId,
            message.facilityStructureId,
            message.unitType,
            message.requestId
          );
          safeSendServerMessage(socket, {
            type: "MILITARY_INDUSTRY_CHANGED",
            requestId: message.requestId,
            snapshot: result.snapshot,
            replayed: result.replayed,
            ...(result.inventory ? { inventory: result.inventory } : {}),
            ...(result.walletGold ? { walletGold: result.walletGold } : {}),
            ...(result.walletVersion ? { walletVersion: result.walletVersion } : {})
          });
          if (result.inventory) registry.send(state.playerId, {
            type: "PLAYER_RESOURCES_UPDATED", playerId: state.playerId, inventory: result.inventory, serverTime: Date.now()
          });
        } catch (error) {
          sendCityActionError(socket, message.requestId, error, safeSendServerMessage);
        }
        return;
      }
      case "MANUFACTURE_FIELD_BALLISTA": {
        requireHello(state.playerId);
        const player = gameState.getPlayer(state.playerId);
        const accountId = authenticatedSession?.account.id;
        if (!cities?.militaryIndustry || !player || !accountId) throw new Error("Military Industry service is unavailable");
        try {
          const result = await cities.militaryIndustry.manufactureFieldBallista(
            player, accountId, message.facilityStructureId, message.requestId
          );
          safeSendServerMessage(socket, {
            type: "MILITARY_INDUSTRY_CHANGED", requestId: message.requestId,
            snapshot: result.snapshot, replayed: result.replayed,
            ...(result.inventory ? { inventory: result.inventory } : {}),
            ...(result.walletGold ? { walletGold: result.walletGold } : {}),
            ...(result.walletVersion ? { walletVersion: result.walletVersion } : {})
          });
          if (result.inventory) registry.send(state.playerId, {
            type: "PLAYER_RESOURCES_UPDATED", playerId: state.playerId, inventory: result.inventory, serverTime: Date.now()
          });
        } catch (error) {
          sendCityActionError(socket, message.requestId, error, safeSendServerMessage);
        }
        return;
      }
      case "START_MILITARY_PRODUCTION": {
        requireHello(state.playerId);
        const player = gameState.getPlayer(state.playerId);
        if (!cities?.militaryIndustry || !player) throw new Error("Military Industry service is unavailable");
        try {
          const result = message.production === "repair_kit_batch"
            ? await cities.militaryIndustry.startRepairKitBatch(player, message.facilityStructureId, message.requestId, message.quantity)
            : await cities.militaryIndustry.startTorchBatch(player, message.facilityStructureId, message.requestId, message.quantity);
          safeSendServerMessage(socket, {
            type: "MILITARY_INDUSTRY_CHANGED",
            requestId: message.requestId,
            snapshot: result.snapshot,
            replayed: result.replayed,
            ...(result.inventory ? { inventory: result.inventory } : {})
          });
          if (result.inventory) {
            registry.send(state.playerId, {
              type: "PLAYER_RESOURCES_UPDATED",
              playerId: state.playerId,
              inventory: result.inventory,
              serverTime: Date.now()
            });
          }
        } catch (error) {
          sendCityActionError(socket, message.requestId, error, safeSendServerMessage);
        }
        return;
      }
      case "COMBINE_MILITARY_GROUPS": {
        requireHello(state.playerId);
        const player = gameState.getPlayer(state.playerId);
        if (!cities?.militaryIndustry || !player) throw new Error("Military Industry service is unavailable");
        try {
          const result = await cities.militaryIndustry.combineMilitaryGroups(player, message.groupIds, message.requestId);
          safeSendServerMessage(socket, {
            type: "MILITARY_INDUSTRY_CHANGED",
            requestId: message.requestId,
            snapshot: result.snapshot,
            replayed: result.replayed
          });
        } catch (error) {
          sendCityActionError(socket, message.requestId, error, safeSendServerMessage);
        }
        return;
      }
      case "SPLIT_MILITARY_GROUP": {
        requireHello(state.playerId);
        if (!cities?.militaryIndustry) throw new Error("Military Industry service is unavailable");
        try {
          const result = await cities.militaryIndustry.splitMilitaryGroup(state.playerId, message.groupId, message.splitSizes, message.requestId);
          safeSendServerMessage(socket, {
            type: "MILITARY_INDUSTRY_CHANGED",
            requestId: message.requestId,
            snapshot: result.snapshot,
            replayed: result.replayed
          });
        } catch (error) {
          sendCityActionError(socket, message.requestId, error, safeSendServerMessage);
        }
        return;
      }
      case "BUILD_WAR_CAMP":
      case "RELOCATE_WAR_CAMP":
      case "REMOVE_WAR_CAMP": {
        requireHello(state.playerId);
        const player = gameState.getPlayer(state.playerId);
        if (!cities?.militaryIndustry || !player) throw new Error("Military Industry service is unavailable");
        try {
          const result = message.type === "BUILD_WAR_CAMP"
            ? await cities.militaryIndustry.buildWarCamp(player, message.requestId)
            : message.type === "RELOCATE_WAR_CAMP"
              ? await cities.militaryIndustry.relocateWarCamp(player, message.requestId)
              : await cities.militaryIndustry.removeWarCamp(state.playerId, message.requestId);
          safeSendServerMessage(socket, { type: "MILITARY_INDUSTRY_CHANGED", requestId: message.requestId, snapshot: result.snapshot, replayed: result.replayed, ...(result.inventory ? { inventory: result.inventory } : {}) });
          if (result.inventory) registry.send(state.playerId, { type: "PLAYER_RESOURCES_UPDATED", playerId: state.playerId, inventory: result.inventory, serverTime: Date.now() });
        } catch (error) {
          sendCityActionError(socket, message.requestId, error, safeSendServerMessage);
        }
        return;
      }
      case "CALL_TROOPS": {
        requireHello(state.playerId);
        const player = gameState.getPlayer(state.playerId);
        if (!cities?.militaryIndustry || !player) throw new Error("Military Industry service is unavailable");
        try {
          const result = await cities.militaryIndustry.callTroops(player, message.requestId);
          safeSendServerMessage(socket, { type: "MILITARY_INDUSTRY_CHANGED", requestId: message.requestId, snapshot: result.snapshot, replayed: result.replayed });
        } catch (error) {
          sendCityActionError(socket, message.requestId, error, safeSendServerMessage);
        }
        return;
      }
      case "FOLLOW_MILITARY_GROUP":
      case "DEPLOY_MILITARY_GROUP":
      case "DEFEND_MILITARY_GROUP":
      case "RETURN_MILITARY_GROUP":
      case "STOP_MILITARY_GROUP": {
        requireHello(state.playerId);
        const player = gameState.getPlayer(state.playerId);
        if (!cities?.militaryIndustry || !player) throw new Error("Military Industry service is unavailable");
        if (
          (message.type === "DEPLOY_MILITARY_GROUP" || message.type === "DEFEND_MILITARY_GROUP")
          && !(await hostileMilitaryAllowed(
            message.requestId,
            message.type === "DEPLOY_MILITARY_GROUP" ? "deploy" : "defend",
            message.groupId
          ))
        ) return;
        try {
          const targetState = message.type === "FOLLOW_MILITARY_GROUP"
            ? "FOLLOWING_PLAYER"
            : message.type === "DEPLOY_MILITARY_GROUP" || message.type === "DEFEND_MILITARY_GROUP"
              ? "DEPLOYED_FIELD"
              : message.type === "RETURN_MILITARY_GROUP"
                ? "STATIONED_WAR_CAMP"
                : "STATIONED_CITY";
          const result = await cities.militaryIndustry.setMilitaryGroupState(
            player,
            message.groupId,
            targetState,
            message.requestId,
            message.type === "DEPLOY_MILITARY_GROUP" ? message.position : undefined
          );
          safeSendServerMessage(socket, { type: "MILITARY_INDUSTRY_CHANGED", requestId: message.requestId, snapshot: result.snapshot, replayed: result.replayed });
        } catch (error) {
          sendCityActionError(socket, message.requestId, error, safeSendServerMessage);
        }
        return;
      }
      case "STAY_MILITARY_GROUP": {
        requireHello(state.playerId);
        const player = gameState.getPlayer(state.playerId);
        if (!cities?.militaryIndustry || !player) throw new Error("Military Industry service is unavailable");
        try {
          const result = await cities.militaryIndustry.setMilitaryGroupState(
            player,
            message.groupId,
            "PACKED_FIELD",
            message.requestId
          );
          safeSendServerMessage(socket, { type: "MILITARY_INDUSTRY_CHANGED", requestId: message.requestId, snapshot: result.snapshot, replayed: result.replayed });
        } catch (error) {
          sendCityActionError(socket, message.requestId, error, safeSendServerMessage);
        }
        return;
      }
      case "PACK_UP_MILITARY_GROUP": {
        requireHello(state.playerId);
        const player = gameState.getPlayer(state.playerId);
        if (!cities?.militaryIndustry || !player) throw new Error("Military Industry service is unavailable");
        try {
          const result = await cities.militaryIndustry.packUpMilitaryGroup(
            player,
            message.groupId,
            message.requestId
          );
          safeSendServerMessage(socket, { type: "MILITARY_INDUSTRY_CHANGED", requestId: message.requestId, snapshot: result.snapshot, replayed: result.replayed });
        } catch (error) {
          sendCityActionError(socket, message.requestId, error, safeSendServerMessage);
        }
        return;
      }
      case "MOVE_MILITARY_GROUP": {
        requireHello(state.playerId);
        const player = gameState.getPlayer(state.playerId);
        if (!cities?.militaryIndustry || !player) throw new Error("Military Industry service is unavailable");
        try {
          const result = await cities.militaryIndustry.moveMilitaryGroupToPosition(
            player,
            message.groupId,
            message.position,
            message.requestId
          );
          safeSendServerMessage(socket, { type: "MILITARY_INDUSTRY_CHANGED", requestId: message.requestId, snapshot: result.snapshot, replayed: result.replayed });
        } catch (error) {
          sendCityActionError(socket, message.requestId, error, safeSendServerMessage);
        }
        return;
      }
      case "ATTACK_MILITARY_GROUP": {
        requireHello(state.playerId);
        const player = gameState.getPlayer(state.playerId);
        if (!cities?.militaryIndustry || !player || !combat) throw new Error("Military combat service is unavailable");
        if (!(await hostileMilitaryAllowed(message.requestId, "attack_group", message.groupId, message.targetEntityId))) return;
        try {
          const result = await cities.militaryIndustry.attackMilitaryGroup(
            player,
            message.groupId,
            message.targetEntityId,
            message.requestId,
            combat
          );
          safeSendServerMessage(socket, {
            type: "MILITARY_INDUSTRY_CHANGED",
            requestId: message.requestId,
            snapshot: result.snapshot,
            replayed: result.replayed,
            ...(result.damage !== undefined ? { damage: result.damage } : {})
          });
        } catch (error) {
          sendCityActionError(socket, message.requestId, error, safeSendServerMessage);
        }
        return;
      }
      case "ATTACK_MILITARY_SIEGE": {
        requireHello(state.playerId);
        const player = gameState.getPlayer(state.playerId);
        if (!cities?.militaryIndustry || !player) throw new Error("Military combat service is unavailable");
        if (!(await hostileMilitaryAllowed(message.requestId, "attack_siege", message.groupId))) return;
        const military = cities.militaryIndustry;
        try {
          const result = await military.attackMilitarySiege(
            player,
            message.groupId,
            message.requestId
          );
          // Refresh the attacker's own vision immediately, then publish the
          // same authoritative snapshot shape to nearby connected players so
          // a damaged or destroyed hostile Siege disappears without waiting
          // for a later military tick.
          let attackerSnapshot = result.snapshot;
          try {
            attackerSnapshot = await military.snapshot(state.playerId, player);
          } catch {
            // The durable hit already committed; keep returning its operation
            // snapshot if a post-commit visibility refresh is unavailable.
          }
          safeSendServerMessage(socket, {
            type: "MILITARY_INDUSTRY_CHANGED",
            requestId: message.requestId,
            snapshot: attackerSnapshot,
            replayed: result.replayed,
            ...(result.damage !== undefined ? { damage: result.damage } : {})
          });
          await Promise.all(registry.activePlayerIds().map(async (viewerPlayerId) => {
            if (viewerPlayerId === state.playerId) return;
            const viewer = gameState.getPlayer(viewerPlayerId);
            if (!viewer || viewer.online === false || !gameState.isWorldPresent(viewerPlayerId)) return;
            try {
              const snapshot = await military.snapshot(viewerPlayerId, viewer);
              registry.send(viewerPlayerId, {
                type: "MILITARY_INDUSTRY_STATE",
                requestId: `military-siege-attack:${message.requestId}:${viewerPlayerId}`,
                snapshot
              }, "replaceable");
            } catch {
              // Viewer publication is best-effort after the durable hit.
            }
          }));
        } catch (error) {
          sendCityActionError(socket, message.requestId, error, safeSendServerMessage);
        }
        return;
      }
      case "ATTACK_CITY_STRUCTURE":
      case "START_CITY_STRUCTURE_REPAIR":
      case "STOP_CITY_STRUCTURE_REPAIR": {
        requireHello(state.playerId);
        const player = gameState.getPlayer(state.playerId);
        if (!cities?.structures || !player) throw new Error("City building service is unavailable");
        try {
          const warfarePlayer = { position: player.position, target: player.target, online: player.online };
          if (message.type === "ATTACK_CITY_STRUCTURE") {
            const result = await cities.structures.attackBuilding(
              state.playerId, message.structureId, message.requestId, warfarePlayer
            );
            safeSendServerMessage(socket, {
              type: "CITY_STRUCTURE_WARFARE_CHANGED",
              requestId: message.requestId,
              action: "attack",
              structureId: result.structureId,
              damage: result.damage,
              replayed: result.replayed
            });
            await broadcastCityStructureWarfare(cities.structures, registry, [result.structureId]);
          } else if (message.type === "START_CITY_STRUCTURE_REPAIR") {
            const result = await cities.structures.startBuildingRepair(
              state.playerId, message.structureId, warfarePlayer
            );
            safeSendServerMessage(socket, {
              type: "CITY_STRUCTURE_WARFARE_CHANGED",
              requestId: message.requestId,
              action: "repair_started",
              structureId: result.structureId,
              replayed: result.replayed
            });
            await broadcastCityStructureWarfare(cities.structures, registry, [result.structureId]);
          } else {
            const result = await cities.structures.stopBuildingRepair(state.playerId);
            safeSendServerMessage(socket, {
              type: "CITY_STRUCTURE_WARFARE_CHANGED",
              requestId: message.requestId,
              action: "repair_stopped",
              structureId: result?.structureId ?? "",
              replayed: result === null
            });
            if (result) await broadcastCityStructureWarfare(cities.structures, registry, [result.structureId]);
          }
        } catch (error) {
          sendCityActionError(socket, message.requestId, error, safeSendServerMessage);
        }
        return;
      }
      case "ATTACK_WAR_CAMP": {
        requireHello(state.playerId);
        const player = gameState.getPlayer(state.playerId);
        const military = cities?.militaryIndustry;
        if (!military || !player) throw new Error("Military Industry service is unavailable");
        try {
          const result = await military.warCamps.attack({
            playerId: player.playerId,
            position: player.position,
            campId: message.campId,
            requestId: message.requestId,
            mode: message.mode,
            ...(message.groupId ? { groupId: message.groupId } : {})
          });
          safeSendServerMessage(socket, {
            type: "MILITARY_INDUSTRY_CHANGED",
            requestId: message.requestId,
            snapshot: await military.snapshot(player.playerId, player),
            replayed: result.replayed,
            damage: result.damage
          });
          const owner = result.ownerPlayerId ? gameState.getPlayer(result.ownerPlayerId) : undefined;
          if (owner?.online && !result.replayed) {
            try {
              registry.send(owner.playerId, {
                type: "MILITARY_INDUSTRY_STATE",
                requestId: `war-camp-attacked:${message.requestId}`,
                snapshot: await military.snapshot(owner.playerId, owner)
              }, "replaceable");
            } catch {
              // The owner's refresh is best-effort after the durable hit.
            }
          }
        } catch (error) {
          sendCityActionError(socket, message.requestId, error, safeSendServerMessage);
        }
        return;
      }
      case "DEMOLISH_FLAG":
      case "FIRE_BALLISTA_VOLLEY": {
        requireHello(state.playerId);
        const player = gameState.getPlayer(state.playerId);
        if (!cities?.militaryIndustry || !player) throw new Error("Military Industry service is unavailable");
        if (!(await hostileMilitaryAllowed(
          message.requestId,
          message.type === "DEMOLISH_FLAG" ? "demolish_flag" : "fire_volley",
          message.groupId
        ))) return;
        try {
          const targetKind = message.targetKind ?? "flag";
          const result = message.type === "DEMOLISH_FLAG"
            ? await cities.militaryIndustry.demolishFlag(player, message.groupId, message.targetFlagId, message.requestId, targetKind)
            : await cities.militaryIndustry.fireBallistaVolley(player, message.groupId, message.targetFlagId, message.requestId, targetKind);
          safeSendServerMessage(socket, {
            type: "MILITARY_INDUSTRY_CHANGED",
            requestId: message.requestId,
            snapshot: result.snapshot,
            replayed: result.replayed,
            ...(result.damage !== undefined ? { damage: result.damage } : {}),
            ...(result.siegeVolleys?.length ? { siegeVolleys: result.siegeVolleys } : {}),
          });
          if (result.affectedCityStructureIds?.length && cities.structures) {
            await broadcastCityStructureWarfare(cities.structures, registry, result.affectedCityStructureIds);
          }
          if (result.affectedFlagIds?.length) {
            const revisionMetadata = await flagSetRevisionMetadata(flagService);
            const affectedFlagIds = [...new Set(result.affectedFlagIds)];
            const affectedFlags = await Promise.all(
              affectedFlagIds.map((flagId) => flagService.getMapFlag(flagId))
            );
            for (const [index, flag] of affectedFlags.entries()) {
              if (!flag) {
                const flagId = affectedFlagIds[index];
                if (flagId) registry.broadcast({ type: "FLAG_DELETED", flagId, reason: "destroyed", ...revisionMetadata });
                continue;
              }
              registry.broadcast({ type: "FLAG_UPDATED", flag, ...revisionMetadata });
            }
          }
        } catch (error) {
          sendCityActionError(socket, message.requestId, error, safeSendServerMessage);
        }
        return;
      }
      case "REPAIR_BALLISTA": {
        requireHello(state.playerId);
        const player = gameState.getPlayer(state.playerId);
        if (!cities?.militaryIndustry || !player) throw new Error("Military Industry service is unavailable");
        try {
          const result = await cities.militaryIndustry.repairBallista(player, message.unitId, message.requestId);
          safeSendServerMessage(socket, { type: "MILITARY_INDUSTRY_CHANGED", requestId: message.requestId, snapshot: result.snapshot, replayed: result.replayed, ...(result.inventory ? { inventory: result.inventory } : {}) });
          if (result.inventory) registry.send(state.playerId, { type: "PLAYER_RESOURCES_UPDATED", playerId: state.playerId, inventory: result.inventory, serverTime: Date.now() });
        } catch (error) {
          sendCityActionError(socket, message.requestId, error, safeSendServerMessage);
        }
        return;
      }
      case "COLLECT_MILITARY_JOB": {
        requireHello(state.playerId);
        const player = gameState.getPlayer(state.playerId);
        if (!cities?.militaryIndustry || !player) throw new Error("Military Industry service is unavailable");
        try {
          const result = await cities.militaryIndustry.collectJob(player, message.jobId, message.requestId);
          safeSendServerMessage(socket, {
            type: "MILITARY_INDUSTRY_CHANGED",
            requestId: message.requestId,
            snapshot: result.snapshot,
            replayed: result.replayed,
            ...(result.inventory ? { inventory: result.inventory } : {})
          });
          if (result.inventory) {
            registry.send(state.playerId, {
              type: "PLAYER_RESOURCES_UPDATED",
              playerId: state.playerId,
              inventory: result.inventory,
              serverTime: Date.now()
            });
          }
        } catch (error) {
          sendCityActionError(socket, message.requestId, error, safeSendServerMessage);
        }
        return;
      }
      case "BUY_CITY_MARKET_DAILY": {
        requireHello(state.playerId);
        if (!cities?.structures) throw new Error("City Market service is unavailable");
        try {
          const result = await cities.structures.marketDaily.purchase(
            state.playerId,
            message.cityId,
            message.requestId
          );
          safeSendServerMessage(socket, {
            type: "CITY_MARKET_DAILY_PURCHASED",
            requestId: message.requestId,
            ...result
          });
        } catch (error) {
          sendCityActionError(socket, message.requestId, error, safeSendServerMessage);
        }
        return;
      }
      case "BUILD_CITY_MARKET":
      case "BUILD_CITY_MONUMENT": {
        requireHello(state.playerId);
        const player = gameState.getPlayer(state.playerId);
        if (!cities?.structures || !player) {
          throw new Error("City civic building service is unavailable");
        }
        try {
          requireStationaryCityBuilder(gameState, state.playerId, player);
          const structure = message.type === "BUILD_CITY_MARKET"
            ? await cities.structures.buildMarket(
                state.playerId,
                message.cityId,
                player.position,
                message.requestId,
                message.expectedCityRevision
              )
            : await cities.structures.buildMonument(
                state.playerId,
                message.cityId,
                message.districtType,
                player.position,
                message.requestId,
                message.expectedCityRevision,
                message.expectedDistrictRevision
              );
          registry.broadcast({
            type: "CITY_FACILITY_CHANGED",
            requestId: message.requestId,
            structure
          });
          if (structure.state === "constructing") {
            gameState.setMovementBlocked(
              state.playerId,
              true,
              "city-construction"
            );
          }
          if (structure.type === "monument") {
            await cities.districtBenefits.refreshCityRuntime(structure.cityId);
          }
        } catch (error) {
          sendCityActionError(socket, message.requestId, error, safeSendServerMessage);
        }
        return;
      }
      case "UPGRADE_CITY_FACILITY": {
        requireHello(state.playerId);
        const player = gameState.getPlayer(state.playerId);
        if (!cities?.structures || !player) throw new Error("City facility service is unavailable");
        try {
          requireStationaryCityBuilder(gameState, state.playerId, player);
          const structure = await cities.structures.upgradeFacility(
            state.playerId,
            message.structureId,
            message.expectedTier,
            player.position,
            message.requestId
          );
          registry.broadcast({
            type: "CITY_FACILITY_CHANGED",
            requestId: message.requestId,
            structure
          });
          if (structure.state === "constructing") {
            gameState.setMovementBlocked(
              state.playerId,
              true,
              "city-construction"
            );
          }
        } catch (error) {
          sendCityActionError(socket, message.requestId, error, safeSendServerMessage);
        }
        return;
      }
      case "UPGRADE_CITY_MONUMENT": {
        requireHello(state.playerId);
        const player = gameState.getPlayer(state.playerId);
        if (!cities?.structures || !player) {
          throw new Error("City Monument service is unavailable");
        }
        try {
          requireStationaryCityBuilder(gameState, state.playerId, player);
          const structure = await cities.structures.upgradeMonument(
            state.playerId,
            message.structureId,
            message.expectedTier,
            message.expectedPlacementRevision,
            message.expectedDistrictRevision,
            player.position,
            message.requestId
          );
          registry.broadcast({
            type: "CITY_FACILITY_CHANGED",
            requestId: message.requestId,
            structure
          });
          if (structure.state === "constructing") {
            gameState.setMovementBlocked(
              state.playerId,
              true,
              "city-construction"
            );
          }
          await cities.districtBenefits.refreshCityRuntime(structure.cityId);
        } catch (error) {
          sendCityActionError(socket, message.requestId, error, safeSendServerMessage);
        }
        return;
      }
      case "DESTROY_CITY_FACILITY": {
        requireHello(state.playerId);
        const player = gameState.getPlayer(state.playerId);
        if (!cities?.structures || !player) throw new Error("City facility service is unavailable");
        try {
          const result = await cities.structures.destroyFacility(
            state.playerId,
            message.structureId,
            message.expectedPlacementRevision,
            player.position,
            message.requestId
          );
          registry.broadcast({
            type: "CITY_FACILITY_CHANGED",
            requestId: message.requestId,
            structure: result.structure,
            ...(result.droppedItems ? { droppedItems: result.droppedItems } : {})
          });
        } catch (error) {
          sendCityActionError(socket, message.requestId, error, safeSendServerMessage);
        }
        return;
      }
      case "DESTROY_CITY_MONUMENT": {
        requireHello(state.playerId);
        const player = gameState.getPlayer(state.playerId);
        if (!cities?.structures || !player) {
          throw new Error("City Monument service is unavailable");
        }
        try {
          const structure = await cities.structures.destroyMonument(
            state.playerId,
            message.structureId,
            message.expectedPlacementRevision,
            message.expectedDistrictRevision,
            player.position,
            message.requestId
          );
          registry.broadcast({
            type: "CITY_FACILITY_CHANGED",
            requestId: message.requestId,
            structure
          });
          await cities.districtBenefits.refreshCityRuntime(structure.cityId);
        } catch (error) {
          sendCityActionError(socket, message.requestId, error, safeSendServerMessage);
        }
        return;
      }
      case "OPEN_CITY_WAREHOUSE":
      case "DONATE_CITY_WAREHOUSE":
      case "DONATE_ALL_CITY_WAREHOUSE":
      case "MOVE_CITY_WAREHOUSE_STACK":
      case "REORGANIZE_CITY_WAREHOUSE":
      case "DONATE_CITY_GOLD": {
        requireHello(state.playerId);
        const player = gameState.getPlayer(state.playerId);
        if (!cities?.structures || !player) throw new Error("City Warehouse service is unavailable");
        const warehouse = cities.structures.warehouse;
        try {
          if (message.type === "OPEN_CITY_WAREHOUSE") {
            safeSendServerMessage(socket, {
              type: "CITY_WAREHOUSE_OPENED",
              requestId: message.requestId,
              warehouse: await warehouse.open(
                state.playerId,
                message.structureId,
                player.position
              )
            });
            return;
          }
          if (message.type === "DONATE_CITY_GOLD") {
            const result = await cities.structures.gold.donate(
              state.playerId,
              message.structureId,
              player.position,
              message.requestId,
              message.amount
            );
            safeSendServerMessage(socket, {
              type: "CITY_GOLD_DONATED",
              requestId: message.requestId,
              warehouse: await warehouse.open(
                state.playerId,
                message.structureId,
                player.position
              ),
              walletGold: result.walletGold,
              walletVersion: result.walletVersion,
              replayed: result.replayed,
              donatedGold: result.donatedGold
            });
            return;
          }
          const result = message.type === "DONATE_CITY_WAREHOUSE"
            ? await warehouse.donate(
                state.playerId,
                message.structureId,
                player.position,
                message.requestId,
                message.stackId,
                message.quantity
              )
            : message.type === "DONATE_ALL_CITY_WAREHOUSE"
              ? await warehouse.donateAllEligible(
                  state.playerId,
                  message.structureId,
                  player.position,
                  message.requestId
                )
              : message.type === "MOVE_CITY_WAREHOUSE_STACK"
                ? await warehouse.move(
                  state.playerId,
                  message.structureId,
                  player.position,
                  message.requestId,
                  message.stackId,
                  message.targetSlot
                )
                : await warehouse.reorganize(
                    state.playerId,
                    message.structureId,
                    player.position,
                    message.requestId
                  );
          safeSendServerMessage(socket, {
            type: "CITY_WAREHOUSE_UPDATED",
            requestId: message.requestId,
            ...result
          });
          registry.send(state.playerId, {
            type: "PLAYER_RESOURCES_UPDATED",
            playerId: state.playerId,
            inventory: result.inventory,
            serverTime: Date.now()
          });
        } catch (error) {
          sendCityActionError(socket, message.requestId, error, safeSendServerMessage);
        }
        return;
      }
      case "REQUEST_WORLD_MAP_DESTINATIONS": {
        requireHello(state.playerId);
        if (!worldMap) throw new Error("world map service is unavailable");
        registry.send(state.playerId, {
          type: "WORLD_MAP_DESTINATIONS",
          requestId: message.requestId,
          snapshot: await worldMap.snapshot(state.playerId)
        });
        return;
      }
      case "MAP_MARKER_COMMAND": {
        requireHello(state.playerId);
        const playerId = state.playerId;
        const player = gameState.getPlayer(playerId);
        try {
          if (!mapMarkers || !player) throw new MapMarkerError("MAP_MARKERS_UNAVAILABLE", "Map markers are unavailable.");
          const command = message.command;
          let result: MapMarkerResult;
          switch (command.action) {
            case "list": result = await mapMarkers.list(playerId); break;
            case "open_compass": result = await mapMarkers.openCompass(playerId, message.requestId); break;
            case "craft": result = await mapMarkers.craft(playerId, message.requestId, command.item); break;
            case "create":
              result = await mapMarkers.create(playerId, player.position, message.requestId, command.name, command.spot);
              break;
            case "rename": result = await mapMarkers.rename(playerId, command.markerId, command.name); break;
            case "delete": result = await mapMarkers.remove(playerId, command.markerId); break;
            case "set_waypoint": result = await mapMarkers.setWaypoint(playerId, message.requestId, command.target); break;
            case "clear_waypoint": result = await mapMarkers.clearWaypoint(playerId); break;
            case "record_location":
              result = await mapMarkers.recordLocation(playerId, player.position, message.requestId, command.name);
              break;
            case "delete_recorded_location": result = await mapMarkers.deleteRecordedLocation(playerId, command.locationId); break;
          }
          safeSendServerMessage(socket, {
            type: "MAP_MARKERS_STATE",
            requestId: message.requestId,
            state: result.state,
            ...(result.notice ? { notice: result.notice } : {}),
            ...(result.inventory ? { inventory: result.inventory } : {})
          });
          if (worldMap && ["create", "rename", "delete"].includes(command.action)) {
            registry.send(playerId, { type: "WORLD_MAP_DESTINATIONS", snapshot: await worldMap.snapshot(playerId) });
          }
        } catch (error) {
          safeSendServerMessage(socket, {
            type: "MAP_MARKERS_ERROR",
            requestId: message.requestId,
            code: error instanceof MapMarkerError ? error.code : "MAP_MARKERS_FAILED",
            message: error instanceof MapMarkerError ? error.message : "Map markers could not be updated."
          });
        }
        return;
      }
      case "SET_WORLD_MAP_DESTINATION_VISIBILITY": {
        requireHello(state.playerId);
        if (!worldMap) throw new Error("world map service is unavailable");
        try {
          registry.send(state.playerId, {
            type: "WORLD_MAP_DESTINATIONS",
            requestId: message.requestId,
            snapshot: await worldMap.setDestinationVisibility(
              state.playerId,
              {
                kind: message.destinationKind,
                id: message.destinationId
              },
              message.visible
            )
          });
        } catch (error) {
          safeSendServerMessage(socket, {
            type: "ERROR",
            requestId: message.requestId,
            code: error instanceof WorldMapError
              ? error.code
              : "WORLD_MAP_VISIBILITY_UPDATE_FAILED",
            message: error instanceof Error
              ? error.message
              : "World Map visibility could not be updated."
          });
        }
        return;
      }
      case "SET_WORLD_MAP_SOCIAL_VISIBILITY": {
        requireHello(state.playerId);
        if (!worldMap) throw new Error("world map service is unavailable");
        try {
          registry.send(state.playerId, {
            type: "WORLD_MAP_DESTINATIONS",
            requestId: message.requestId,
            snapshot: await worldMap.setSocialVisibility(
              state.playerId,
              message.audience,
              message.visible
            )
          });
        } catch (error) {
          safeSendServerMessage(socket, {
            type: "ERROR",
            requestId: message.requestId,
            code: "WORLD_MAP_SOCIAL_VISIBILITY_UPDATE_FAILED",
            message: error instanceof Error
              ? error.message
              : "World Map social visibility could not be updated."
          });
        }
        return;
      }
      case "JOIN_CITY": {
        requireHello(state.playerId);
        if (!cities) throw new Error("city service is unavailable");
        try {
          const result = await cities.joinCity(state.playerId, {
            requestId: message.requestId,
            cityId: message.cityId
          });
          safeSendServerMessage(socket, {
            type: "CITY_JOINED",
            requestId: message.requestId,
            info: result.info,
            membership: result.membership,
            replayed: result.replayed
          });
          registry.send(state.playerId, {
            type: "CITY_MEMBERSHIP_SNAPSHOT",
            membership: result.membership
          });
          await cities.districtBenefits.refreshRuntime(state.playerId);
          await chats?.refreshAuthorizedPlayer(state.playerId);
          registry.broadcast({
            type: "CITY_MEMBERSHIP_UPDATED",
            cityId: message.cityId,
            playerId: state.playerId,
            memberCount: result.info.memberCount,
            expansionFlagCount: result.info.expansionFlagCount,
            expansionFlagLimit: result.info.expansionFlagLimit,
            action: "joined"
          });
          registry.broadcast({ type: "SOCIAL_STATE_CHANGED", playerId: state.playerId });
        } catch (error) {
          safeSendServerMessage(socket, {
            type: "ERROR",
            requestId: message.requestId,
            code: error instanceof CityFoundingError ? error.code : "CITY_JOIN_FAILED",
            message: error instanceof Error ? error.message : "City joining failed"
          });
        }
        return;
      }
      case "LEAVE_CITY": {
        requireHello(state.playerId);
        if (!cities) throw new Error("city service is unavailable");
        try {
          const result = await cities.leaveCity(state.playerId, {
            requestId: message.requestId,
            cityId: message.cityId
          });
          safeSendServerMessage(socket, {
            type: "CITY_LEFT",
            requestId: message.requestId,
            info: result.info,
            cityId: result.cityId,
            replayed: result.replayed
          });
          registry.send(state.playerId, {
            type: "CITY_MEMBERSHIP_SNAPSHOT",
            membership: null
          });
          cities.districtBenefits.clearRuntime(state.playerId);
          await chats?.refreshAuthorizedPlayer(state.playerId);
          registry.broadcast({
            type: "CITY_MEMBERSHIP_UPDATED",
            cityId: message.cityId,
            playerId: state.playerId,
            memberCount: result.info.memberCount,
            expansionFlagCount: result.info.expansionFlagCount,
            expansionFlagLimit: result.info.expansionFlagLimit,
            action: "left"
          });
          registry.broadcast({ type: "SOCIAL_STATE_CHANGED", playerId: state.playerId });
        } catch (error) {
          safeSendServerMessage(socket, {
            type: "ERROR",
            requestId: message.requestId,
            code: error instanceof CityFoundingError ? error.code : "CITY_LEAVE_FAILED",
            message: error instanceof Error ? error.message : "City leaving failed"
          });
        }
        return;
      }
      case "CLAIM_CITY_MAYOR":
      case "RELINQUISH_CITY_MAYOR": {
        requireHello(state.playerId);
        if (!cities) throw new Error("city service is unavailable");
        const action = message.type === "CLAIM_CITY_MAYOR" ? "claimed" : "relinquished";
        try {
          const result = message.type === "CLAIM_CITY_MAYOR"
            ? await cities.claimMayor(state.playerId, {
                requestId: message.requestId,
                cityId: message.cityId
              })
            : await cities.relinquishMayor(state.playerId, {
                requestId: message.requestId,
                cityId: message.cityId
              });
          registry.broadcast({
            type: "CITY_MAYOR_UPDATED",
            requestId: message.requestId,
            city: result.city,
            actorPlayerId: state.playerId,
            action,
            replayed: result.replayed
          });
          if (result.structure) {
            registry.broadcast({
              type: "CITY_HOUSE_CHANGED",
              requestId: message.requestId,
              structure: result.structure,
              membership: result.membership ?? null,
              replayed: result.replayed
            });
          }
          safeSendServerMessage(socket, {
            type: "CITY_MEMBERSHIP_SNAPSHOT",
            membership: await cities.getMembership(state.playerId)
          });
          registry.broadcast({ type: "SOCIAL_STATE_CHANGED", playerId: state.playerId });
        } catch (error) {
          sendCityActionError(socket, message.requestId, error, safeSendServerMessage);
        }
        return;
      }
      case "CONVERT_CITY_FLAG": {
        requireHello(state.playerId);
        if (!cityFlagConversions) {
          throw new Error("city flag contribution service is unavailable");
        }
        const landAction = {
          landActions,
          accountId: authenticatedSession?.account.id ?? null,
          playerId: state.playerId,
          action: "city_convert" as const,
          position: gameState.getPlayer(state.playerId)?.position ?? null
        };
        if (!(await landActionAllowed(landAction, socket, message.requestId, sendCombatError))) return;
        if (!(await openStructureAllowed(message.requestId, "city_convert"))) return;
        try {
          await cityFlagConversions.start(
            state.playerId,
            message.requestId,
            message.flagId,
            {
              // Server-side developer authority only; never trusted from the client.
              exemptFromExpansionLimit: Boolean(
                auth && authenticatedSession &&
                auth.hasDeveloperCapability(authenticatedSession, "developer:world-mutate")
              )
            }
          );
          noteLandAction(landAction);
        } catch (error) {
          safeSendServerMessage(socket, {
            type: "ERROR",
            requestId: message.requestId,
            code: error instanceof CityFoundingError ? error.code : "CITY_FLAG_CONVERSION_FAILED",
            message: error instanceof Error ? error.message : "City flag conversion failed"
          });
        }
        return;
      }
    }
  };
}

export function registerSettlementHandler(
  router: RealtimeMessageRouter,
  handler: RealtimeFamilyHandler<"settlement">
): void {
  router.register("settlement", handler);
}

/** Publishes the current state of city buildings whose war health changed. */
export async function broadcastCityStructureWarfare(
  structures: Pick<CityStructureService, "getStructure">,
  registry: Pick<ConnectionRegistry, "broadcast">,
  structureIds: readonly string[]
): Promise<void> {
  for (const structureId of [...new Set(structureIds)]) {
    const structure = await structures.getStructure(structureId);
    if (!structure) continue;
    registry.broadcast({
      type: "CITY_FACILITY_CHANGED",
      requestId: `city-war:${structureId}:${Date.now()}`,
      structure
    });
  }
}

function sendCityActionError(
  socket: SocketLike,
  requestId: string,
  error: unknown,
  send: (socket: SocketLike, message: ServerMessage) => boolean
): void {
  const typed = error instanceof CityFoundingError ||
    error instanceof CityGoldError ||
    error instanceof CityMarketDailyError ||
    error instanceof LibraryStudyError ||
    error instanceof CityStructureError ||
    error instanceof CityTreasuryError ||
    error instanceof CityWarehouseError ||
    error instanceof MilitaryIndustryError ||
    error instanceof CityStructureWarfareError
    ? error
    : null;
  send(socket, {
    type: "ERROR",
    requestId,
    code: typed?.code ?? "CITY_ACTION_FAILED",
    message: error instanceof Error ? error.message : "City action failed",
    ...(error instanceof CityStructureError && error.details
      ? { details: error.details }
      : {})
  });
}

function requireStationaryCityBuilder(
  gameState: Pick<SettlementHandlerContext["gameState"], "isWorldPresent">,
  playerId: string,
  player: Readonly<{ target: unknown }>
): void {
  if (!gameState.isWorldPresent(playerId)) {
    throw new CityStructureError(
      "CITY_CONSTRUCTION_LOCATION_INCOMPATIBLE",
      "Return to the world before beginning city construction."
    );
  }
  if (player.target) {
    throw new CityStructureError(
      "CITY_CONSTRUCTION_STATIONARY_REQUIRED",
      "Stop moving before beginning city construction."
    );
  }
}
