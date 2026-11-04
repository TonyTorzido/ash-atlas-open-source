import type { PlayerRecord, GameState } from "../game/state.js";
import { CITY_STRUCTURE_SNAPSHOT_RADIUS_M } from "@ash-atlas/shared";
import type { CityService } from "../game/cities.js";
import type { CollectibleService } from "../game/collectibles.js";
import type { CombatEngine } from "../game/combat/combatEngine.js";
import type { DroppedItemService } from "../game/droppedItems.js";
import type { FlagService } from "../game/flags.js";
import type { ManorPresenceService } from "../game/manor.js";
import type { FurnaceService } from "../game/furnaces.js";
import type { TanneryService } from "../game/tanneries.js";
import type { LoomService } from "../game/looms.js";
import type { KitchenService } from "../game/kitchens.js";
import type { GreenhouseService } from "../game/greenhouses.js";
import type { FishingService } from "../game/fishing.js";
import type { WorldRuntime } from "../game/worldRuntime.js";
import type { ConnectionRegistry } from "./connectionRegistry.js";
import type { SessionConnectionState } from "./handlers/sessionHandler.js";

type WorldBootstrapTrigger =
  | "world-entry"
  | "reconnect"
  | "separate-space-exit"
  | "death-respawn";
type PopulationRelocationBootstrapTrigger = Exclude<WorldBootstrapTrigger, "death-respawn">;

export function createConnectionSnapshotOperations(context: Readonly<{
  state: Pick<
    SessionConnectionState,
    "connectionId" | "connectionGeneration" | "playerId"
  >;
  registry: ConnectionRegistry;
  gameState: GameState;
  worldRuntime?: WorldRuntime | undefined;
  combat?: CombatEngine | undefined;
  flagService: FlagService;
  cities?: CityService | undefined;
  manorPresence?: ManorPresenceService | undefined;
  furnaces?: FurnaceService | undefined;
  tanneries?: TanneryService | undefined;
  looms?: LoomService | undefined;
  kitchens?: KitchenService | undefined;
  greenhouses?: GreenhouseService | undefined;
  fishing?: FishingService | undefined;
  collectibles?: CollectibleService | undefined;
  droppedItems?: DroppedItemService | undefined;
  schedulePopulationV2Relocation(
    player: PlayerRecord,
    trigger: PopulationRelocationBootstrapTrigger
  ): void;
  sendCollectiblesForPlayer(player: PlayerRecord | undefined): Promise<void>;
  sendCombatScopeSnapshot?(playerId: string): void;
  sendDroppedItemsForPlayer(
    playerId: string,
    isCurrent?: () => boolean
  ): Promise<void>;
  refreshDroppedItemsNear(
    positions: readonly Readonly<{ lat: number; lon: number }>[]
  ): Promise<void>;
}>): Readonly<{
  sendManorsForPlayer(player: PlayerRecord | undefined): Promise<void>;
  sendWorldBootstrapForPlayer(
    player: PlayerRecord,
    trigger: WorldBootstrapTrigger,
    scheduleRuntimeRelocation?: boolean
  ): Promise<void>;
  broadcastManorSnapshots(): Promise<void>;
  sendDroppedItemsToSocket(
    playerId: string,
    isCurrent?: () => boolean
  ): Promise<void>;
  broadcastDroppedItems(
    positions?: readonly Readonly<{ lat: number; lon: number }>[]
  ): Promise<void>;
}> {
  const {
    state,
    registry,
    gameState,
    worldRuntime,
    combat,
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
  } = context;
  const connectionId = (): string | null => state.connectionId;

  async function sendManorsForPlayer(player: ReturnType<GameState["getPlayer"]>): Promise<void> {
    if (!player || !manorPresence || !gameState.isWorldPresent(player.playerId)) return;
    registry.send(player.playerId, {
      type: "MANORS_SNAPSHOT",
      manors: await manorPresence.listBuiltNear(player)
    });
    if (furnaces) {
      registry.send(player.playerId, {
        type: "FURNACES_SNAPSHOT",
        furnaces: await furnaces.listNear(player)
      });
    }
    if (tanneries) {
      registry.send(player.playerId, {
        type: "TANNERIES_SNAPSHOT",
        tanneries: await tanneries.listNear(player)
      });
    }
    if (looms) {
      registry.send(player.playerId, {
        type: "LOOMS_SNAPSHOT",
        looms: await looms.listNear(player)
      });
    }
    if (kitchens) {
      registry.send(player.playerId, {
        type: "KITCHENS_SNAPSHOT",
        kitchens: await kitchens.listNear(player)
      });
    }
    if (greenhouses) {
      registry.send(player.playerId, {
        type: "GREENHOUSES_SNAPSHOT",
        greenhouses: await greenhouses.listNear(player)
      });
    }
    if (fishing) {
      registry.send(player.playerId, {
        type: "FISHING_HUTS_SNAPSHOT",
        fishingHuts: await fishing.listNear(player)
      });
    }
  }



  async function sendWorldBootstrapForPlayer(
    player: NonNullable<ReturnType<GameState["getPlayer"]>>,
    trigger: WorldBootstrapTrigger,
    scheduleRuntimeRelocation = true
  ): Promise<void> {
    if (!connectionId() || !worldRuntime) return;
    if (scheduleRuntimeRelocation && trigger !== "death-respawn") {
      schedulePopulationV2Relocation(player, trigger);
    }
    const interest = worldRuntime.interestFrameFor([player.playerId]);
    registry.sendToConnection(connectionId()!, {
      type: "PLAYER_SNAPSHOT",
      serverTime: Date.now(),
      sequence: 0,
      players: worldRuntime.replication.snapshotForPlayer(player.playerId, interest)
    });
    if (combat) {
      if (sendCombatScopeSnapshot) {
        sendCombatScopeSnapshot(player.playerId);
      } else {
        registry.sendToConnection(connectionId()!, {
          type: "COMBAT_SNAPSHOT",
          state: combat.snapshotForPlayer(player.playerId, interest)
        });
      }
    }
    if (cities) {
      registry.sendToConnection(connectionId()!, {
        type: "CITIES_SNAPSHOT",
        cities: await cities.listCitiesNear(player.anchor)
      });
      registry.sendToConnection(connectionId()!, {
        type: "CITY_MEMBERSHIP_SNAPSHOT",
        membership: await cities.getMembership(player.playerId)
      });
      if (cities.structures) {
        registry.sendToConnection(connectionId()!, {
          type: "CITY_STRUCTURES_SNAPSHOT",
          structures: await cities.structures.listNear(
            player.position,
            CITY_STRUCTURE_SNAPSHOT_RADIUS_M
          )
        });
        registry.sendToConnection(connectionId()!, {
          type: "OWNER_OIL_WELL_PROJECTION",
          structure: await cities.structures.ownerOilWellProjection(
            player.playerId,
            player.position
          )
        });
      }
    }
    await sendManorsForPlayer(player);
    if (collectibles) await sendCollectiblesForPlayer(player);
    if (droppedItems) await sendDroppedItemsToSocket(player.playerId);
  }

  async function broadcastManorSnapshots(): Promise<void> {
    if (!manorPresence) return;
    await Promise.all(registry.activePlayerIds().map(async (activePlayerId) => {
      await sendManorsForPlayer(gameState.getPlayer(activePlayerId));
    }));
  }

  async function sendDroppedItemsToSocket(
    targetPlayerId: string,
    isCurrent: () => boolean = () => true
  ): Promise<void> {
    await sendDroppedItemsForPlayer(targetPlayerId, isCurrent);
  }

  async function broadcastDroppedItems(
    positions: readonly Readonly<{ lat: number; lon: number }>[] = []
  ): Promise<void> {
    if (!droppedItems) return;
    if (positions.length > 0) {
      await refreshDroppedItemsNear(positions);
      return;
    }
    await Promise.all(registry.activePlayerIds().map((activePlayerId) =>
      sendDroppedItemsForPlayer(activePlayerId)
    ));
  }


  return {
    sendManorsForPlayer,
    sendWorldBootstrapForPlayer,
    broadcastManorSnapshots,
    sendDroppedItemsToSocket,
    broadcastDroppedItems
  };
}

