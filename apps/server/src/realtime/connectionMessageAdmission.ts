import { isDungeonResourceNodeId, type parseClientMessage } from "@ash-atlas/shared";

import { ManorError, type ManorRuntime } from "../game/manor.js";
import type { CisternWarrensRuntime } from "../game/dungeon.js";
import type { SocketLike } from "./connectionRegistry.js";
import type { SessionConnectionState } from "./handlers/sessionHandler.js";
import {
  isMarketMessage,
  type MarketHandler
} from "./handlers/marketHandler.js";
import {
  isWorldOnlyWhileInManor,
  sendManorError
} from "./manorRealtimeOperations.js";
import { safeSendServerMessage } from "./handlers/handlerExecutionContext.js";

type ClientMessage = ReturnType<typeof parseClientMessage>;

export function createConnectionMessageAdmission(context: Readonly<{
  state: Pick<SessionConnectionState, "playerId">;
  socket: SocketLike;
  manorRuntime?: ManorRuntime | undefined;
  dungeon?: CisternWarrensRuntime | undefined;
  marketHandler: MarketHandler;
}>): Readonly<{
  admitBeforeTouch(message: ClientMessage): boolean;
  admitAfterTouch(message: ClientMessage): boolean;
}> {
  const { state, socket, manorRuntime, dungeon, marketHandler } = context;
  let manorWindowStartedAt = 0;
  let manorWindowCount = 0;

  function admitBeforeTouch(message: ClientMessage): boolean {
    if (isManorRateLimitedMessage(message.type)) {
      const now = Date.now();
      if (now - manorWindowStartedAt >= 10_000) {
        manorWindowStartedAt = now;
        manorWindowCount = 0;
      }
      manorWindowCount += 1;
      if (manorWindowCount > 80) {
        sendRateLimitError(socket, message);
        return false;
      }
    }
    return !isMarketMessage(message) || marketHandler.admit(message);
  }

  function admitAfterTouch(message: ClientMessage): boolean {
    if (
      state.playerId &&
      manorRuntime?.isInside(state.playerId) &&
      isWorldOnlyWhileInManor(message.type)
    ) {
      sendManorError(
        socket,
        "requestId" in message ? message.requestId : undefined,
        new ManorError(
          "WORLD_ACTION_UNAVAILABLE",
          "That world action is unavailable inside your manor."
        )
      );
      return false;
    }
    if (
      state.playerId &&
      dungeon?.isInside(state.playerId) &&
      isWorldOnlyWhileInDungeon(message.type) &&
      !isDungeonHarvestMessage(message)
    ) {
      safeSendServerMessage(socket, {
        type: "DUNGEON_ERROR",
        ...("requestId" in message ? { requestId: message.requestId } : {}),
        code: "WORLD_ACTION_UNAVAILABLE",
        message: `That world action is unavailable inside ${dungeon.snapshotForPlayer(state.playerId)?.name ?? "the dungeon"}.`
      });
      return false;
    }
    return true;
  }

  return { admitBeforeTouch, admitAfterTouch };
}

export function isManorRateLimitedMessage(messageType: string): boolean {
  return messageType.includes("MANOR") ||
    messageType.includes("FURNACE") ||
    messageType.includes("TANNERY") ||
    messageType.includes("LOOM") ||
    messageType.includes("KITCHEN") ||
    messageType.includes("FISHING") ||
    messageType.includes("JEWEL");
}

function sendRateLimitError(socket: SocketLike, message: ClientMessage): void {
  const requestId = "requestId" in message ? message.requestId : undefined;
  const error = new ManorError("RATE_LIMITED", "Too many manor requests; slow down briefly.");
  if (message.type.includes("JEWEL")) {
    safeSendServerMessage(socket, {
      type: "JEWEL_STATION_ERROR",
      ...(requestId === undefined ? {} : { requestId }),
      code: error.code,
      message: error.message
    });
    return;
  }
  if (message.type.includes("FURNACE")) {
    safeSendServerMessage(socket, {
      type: "FURNACE_ERROR",
      ...(requestId === undefined ? {} : { requestId }),
      code: error.code,
      message: error.message
    });
    return;
  }
  if (message.type.includes("TANNERY")) {
    safeSendServerMessage(socket, {
      type: "TANNERY_ERROR",
      ...(requestId === undefined ? {} : { requestId }),
      code: error.code,
      message: error.message
    });
    return;
  }
  if (message.type.includes("LOOM")) {
    safeSendServerMessage(socket, {
      type: "LOOM_ERROR",
      ...(requestId === undefined ? {} : { requestId }),
      code: error.code,
      message: error.message
    });
    return;
  }
  if (message.type.includes("KITCHEN")) {
    safeSendServerMessage(socket, {
      type: "KITCHEN_ERROR",
      ...(requestId === undefined ? {} : { requestId }),
      code: error.code,
      message: error.message
    });
    return;
  }
  if (message.type.includes("FISHING")) {
    safeSendServerMessage(socket, {
      type: "FISHING_ERROR",
      ...(requestId === undefined ? {} : { requestId }),
      code: error.code,
      message: error.message
    });
    return;
  }
  sendManorError(socket, requestId, error);
}

const WORLD_ONLY_DUNGEON_MESSAGE_TYPES = new Set<string>([
  "MOVE_TO", "BUILD_MANOR", "DESTROY_MANOR", "ATTACK_MANOR", "START_MANOR_REPAIR", "INSTALL_MANOR_SKIN", "JUMP_TO_MANOR", "ENTER_MANOR",
  "BUILD_FURNACE", "OPEN_FURNACE", "START_FURNACE_SMELT", "COLLECT_FURNACE_OUTPUT", "REFINE_FURNACE_GLIMMER_OIL",
  "BUILD_GREENHOUSE", "PREVIEW_GREENHOUSE_BUILD", "OPEN_GREENHOUSE", "FILL_WATER_BUCKET", "CANCEL_WATER_BUCKET_FILL",
  "BUILD_TANNERY", "OPEN_TANNERY", "START_TANNERY_BATCH", "COLLECT_TANNERY_OUTPUT",
  "BUILD_LOOM", "OPEN_LOOM", "START_LOOM_BATCH", "COLLECT_LOOM_OUTPUT",
  "BUILD_KITCHEN", "OPEN_KITCHEN", "START_KITCHEN_BATCH", "COLLECT_KITCHEN_OUTPUT",
  "BUILD_FISHING_HUT", "OPEN_FISHING_HUT", "COLLECT_FISHING_HUT", "REQUEST_FISHING_RECORDS", "CRAFT_FISHING_ROD", "UPGRADE_FISHING_TRAINING", "SELECT_FISHING_SPECIALIZATION", "START_FISHING",
  "FISHING_CAST", "FISHING_HOOK", "FISHING_CONTROL", "FISHING_LAND", "FISHING_CANCEL",
  "PLACE_FLAG", "CANCEL_FLAG_BUILD", "REINFORCE_FLAG", "START_FLAG_BURN", "ATTACK_FLAG",
  "START_FLAG_REPAIR", "CANCEL_FLAG_REPAIR", "START_FLAG_REPAIR_DISRUPT", "CANCEL_FLAG_REPAIR_DISRUPT",
  "CRAFT_TORCH", "VISIT_FLAG",
  "PREPARE_VISIBLE_FLAG_VISIT", "COMMIT_VISIBLE_FLAG_VISIT", "VISIT_WORLD_MAP_KINGDOM",
  "VISIT_WORLD_MAP_ATLAS_SHRINE", "VISIT_WORLD_MAP_HOLLIN_HUT", "VISIT_OPEN_LAND", "VISIT_RECORDED_LOCATION", "PREPARE_WORLD_MAP_TRAVEL", "VISIT_WORLD_MAP_CITY",
  "SET_WORLD_MAP_DESTINATION_VISIBILITY",
  "MAP_MARKER_COMMAND",
  "SET_WORLD_MAP_SOCIAL_VISIBILITY",
  "VISIT_CITY", "VISIT_CITY_HOUSE", "VISIT_CITY_MARKET", "VISIT_CITY_WAREHOUSE",
  "PREVIEW_CITY_FOUNDING", "FOUND_CITY", "ADVANCE_CITY_CONSTRUCTION", "CONVERT_CITY_FLAG", "BUILD_CITY_HOUSE", "DESTROY_CITY_HOUSE", "BUILD_OIL_WELL",
  "OPEN_OIL_WELL", "OPEN_LIBRARY", "STUDY_LIBRARY", "HARVEST_OIL_WELL", "DESTROY_OIL_WELL", "BUILD_CITY_FACILITY",
  "UPGRADE_CITY_FACILITY", "DESTROY_CITY_FACILITY", "BUILD_CITY_MARKET", "BUY_CITY_MARKET_DAILY",
  "BUILD_CITY_MONUMENT", "UPGRADE_CITY_MONUMENT", "DESTROY_CITY_MONUMENT",
  "OPEN_CITY_WAREHOUSE", "DONATE_CITY_WAREHOUSE", "DONATE_ALL_CITY_WAREHOUSE",
  "MOVE_CITY_WAREHOUSE_STACK", "REORGANIZE_CITY_WAREHOUSE", "MARKET_OPEN", "MARKET_BROWSE", "MARKET_GET_BOOK",
  "MARKET_REQUEST_QUOTE", "MARKET_CREATE_ORDER", "MARKET_SIMPLE_BUY", "MARKET_CANCEL_ORDER",
  "MARKET_CLAIM", "MARKET_SET_SUBSCRIPTIONS", "REQUEST_NEARBY_COLLECTIBLES", "SURVEY_AREA", "CLAIM_MINE",
  "START_HARVEST", "COMPLETE_HARVEST", "CANCEL_HARVEST", "DROP_ITEM", "DROP_EQUIPMENT",
  "PICKUP_DROPPED_ITEM", "PICKUP_XORAL_RING_DROP", "COLLECT_WATER_AT_COORDINATE", "DEV_SPAWN_MOB", "DEV_SPAWN_PLANT", "DEV_CLEAR_MOBS", "DEV_CLEAR_PLANTS",
  "DEV_TELEPORT", "DEV_VISIT_MINE", "DEV_ADVANCE_ALL_GREENHOUSE_CROPS", "DEV_WATER_ALL_GREENHOUSE_CROPS", "DEV_BUILD_MANOR", "DEV_BUILD_SALON", "REQUEST_WORLD_RESYNC", "REQUEST_POPULATION_RESYNC",
  "SEND_TRAVEL_INVITE", "RESPOND_TRAVEL_INVITE", "TRAVEL_TO_PARTY_LEADER",
  "RELOCATE_TO_CURRENT_LOCATION",
  "SET_PARTY_AUTO_FOLLOW", "TRAVEL_TO_PET_DESTINATION",
  "REQUEST_SAPLINGS", "REQUEST_SAPLING_DETAIL", "PLANT_SAPLING", "PLANT_SAPLINGS_GRID", "TEND_SAPLING", "PULL_SAPLING", "GATHER_SAPLING_BERRY"
]);

/**
 * Dungeon resource nodes use the overworld harvest messages. Starting is admitted only for
 * dungeon node ids; complete/cancel carry session ids, and the harvesting handler rejects any
 * session that is not a dungeon harvest while the player is inside a dungeon.
 */
function isDungeonHarvestMessage(message: ClientMessage): boolean {
  if (message.type === "START_HARVEST") return isDungeonResourceNodeId(message.nodeId);
  return message.type === "COMPLETE_HARVEST" || message.type === "CANCEL_HARVEST";
}

export function isWorldOnlyWhileInDungeon(messageType: string): boolean {
  return WORLD_ONLY_DUNGEON_MESSAGE_TYPES.has(messageType);
}
