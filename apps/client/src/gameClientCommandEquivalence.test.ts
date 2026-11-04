import type {
  ClassLoadoutView,
  ClientMessage,
  DirectMessagePreferences,
  HarvestStartAuthority
} from "@ash-atlas/shared";
import { LEVEL_UP_GLIMMER_FEE } from "@ash-atlas/shared";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GameClient } from "./gameClient.js";

type CommandMethodName = Exclude<
  {
    [Key in keyof GameClient]: GameClient[Key] extends (...args: never[]) => unknown
      ? Key
      : never
  }[keyof GameClient],
  | "connect"
  | "disconnect"
  | "recoverIfNeeded"
  | "suspend"
  | "setNetworkOnline"
  | "markAuthoritativeBootstrapComplete"
  | "markAuthoritativeViewDegraded"
  | "markAuthoritativeViewPreparing"
  | "readinessState"
  | "currentConnectionGeneration"
  | "socketState"
  | "submitBugReport"
  | "synchronizedNow"
  | "noteFrameForTelemetry"
  | "reconnectInPlace"
  | "recordStartupTerminal"
  | "materializeDungeonSnapshot"
  | "clearDungeonScene"
>;

type CommandEquivalenceRow = {
  method: CommandMethodName;
  invoke(client: GameClient): unknown[];
  messages: ClientMessage[];
  success: unknown[];
  expectedUuidCalls?: number;
};

const uuid = (index: number): `${string}-${string}-${string}-${string}-${string}` =>
  `00000000-0000-4000-8000-${index.toString().padStart(12, "0")}`;
const U1 = uuid(1);
const U2 = uuid(2);
const MARKET_STRUCTURE_ID = uuid(101);
const WAREHOUSE_STRUCTURE_ID = "warehouse-structure-1";
const MARKET_SESSION_ID = uuid(102);
const VISIBLE_FLAG_ID = "11111111-1111-4111-8111-111111111111";
const HARVEST_AUTHORITY: HarvestStartAuthority = {
  presentationOwner: "population",
  entityRevision: 7,
  relocationRevision: 11,
  resourceVisionRevision: 13,
  gameplayViewGeneration: 17
};
const sentAttempt = (requestId: string) => ({
  requestId,
  outcome: {
    status: "sent",
    readiness: "ready",
    connectionGeneration: 3
  }
});

const LOADOUT: ClassLoadoutView = {
  resetActives: ["reset-one"],
  normalActives: ["normal-one", null],
  passiveTiers: ["passive-zero", null, "passive-twenty"],
  ultimateActive: null
};
const DM_PREFERENCES: DirectMessagePreferences = {
  soundsEnabled: true,
  suppressBannersDuringCombat: false
};

function row(
  method: CommandMethodName,
  invoke: (client: GameClient) => unknown[],
  messages: ClientMessage[],
  success: unknown[],
  expectedUuidCalls?: number
): CommandEquivalenceRow {
  return {
    method,
    invoke,
    messages,
    success,
    ...(expectedUuidCalls === undefined ? {} : { expectedUuidCalls })
  };
}

const COMMAND_EQUIVALENCE_MATRIX: readonly CommandEquivalenceRow[] = [
  row(
    "dungeonPuzzleActive",
    (client) => [client.dungeonPuzzleActive("session-1", "vault_r1", true)],
    [{ type: "DUNGEON_PUZZLE_ACTIVE", requestId: U1, sessionId: "session-1", roomId: "vault_r1", active: true }],
    [U1]
  ),
  row(
    "dungeonPuzzleSolve",
    (client) => [client.dungeonPuzzleSolve("session-1", "vault_r1", 12000)],
    [{ type: "DUNGEON_PUZZLE_SOLVE", requestId: U1, sessionId: "session-1", roomId: "vault_r1", clientSolveMs: 12000 }],
    [U1]
  ),
  row(
    "dungeonInteract",
    (client) => [client.dungeonInteract("session-1", "lever-1")],
    [{ type: "DUNGEON_INTERACT", requestId: U1, sessionId: "session-1", objectId: "lever-1" }],
    [U1]
  ),
  row(
    "dungeonTorchLobbyJoin",
    (client) => [client.dungeonTorchLobbyJoin("cave-a")],
    [{ type: "DUNGEON_TORCH_LOBBY_JOIN", requestId: U1, entranceId: "cave-a" }],
    [U1]
  ),
  row(
    "dungeonTorchLobbySetTorches",
    (client) => [client.dungeonTorchLobbySetTorches("lobby-1", 3)],
    [{ type: "DUNGEON_TORCH_LOBBY_SET_TORCHES", requestId: U1, lobbyId: "lobby-1", torches: 3 }],
    [U1]
  ),
  row(
    "dungeonTorchLobbyReady",
    (client) => [client.dungeonTorchLobbyReady("lobby-1", true)],
    [{ type: "DUNGEON_TORCH_LOBBY_READY", requestId: U1, lobbyId: "lobby-1", ready: true }],
    [U1]
  ),
  row(
    "dungeonTorchLobbyStart",
    (client) => [client.dungeonTorchLobbyStart("lobby-1")],
    [{ type: "DUNGEON_TORCH_LOBBY_START", requestId: U1, lobbyId: "lobby-1" }],
    [U1]
  ),
  row(
    "dungeonTorchLobbyLeave",
    (client) => [client.dungeonTorchLobbyLeave("lobby-1")],
    [{ type: "DUNGEON_TORCH_LOBBY_LEAVE", requestId: U1, lobbyId: "lobby-1" }],
    [U1]
  ),
  row(
    "openGoblinMarket",
    (client) => [client.openGoblinMarket("goblin-market-1")],
    [{ type: "OPEN_GOBLIN_MARKET", requestId: U1, marketStructureId: "goblin-market-1" }],
    [true]
  ),
  row(
    "sellToGoblinMarket",
    (client) => [client.sellToGoblinMarket("goblin-market-1", {
      kind: "resource", identity: "wood", displayName: "Wood", quantity: 3, offerGold: "12"
    })],
    [{ type: "SELL_TO_GOBLIN_MARKET", requestId: U1, marketStructureId: "goblin-market-1",
      itemKind: "resource", itemIdentity: "wood", quantity: 3, expectedOfferGold: "12" }],
    [true]
  ),
  row(
    "buyFromGoblinMarket",
    (client) => [client.buyFromGoblinMarket("goblin-market-1", {
      kind: "resource", itemId: "wheat_seed", identity: "wheat_seed", displayName: "Wheat Seed",
      quantity: 250, unitPriceGold: "10"
    })],
    [{ type: "BUY_FROM_GOBLIN_MARKET", requestId: U1, marketStructureId: "goblin-market-1",
      itemId: "wheat_seed", quantity: 1, expectedUnitPriceGold: "10" }],
    [true]
  ),
  row(
    "visitWorldMapHollinHut",
    (client) => [client.visitWorldMapHollinHut("hollin-hut:00000000-0000-0000-0000-000000000001")],
    [{ type: "VISIT_WORLD_MAP_HOLLIN_HUT", requestId: U1, hutId: "hollin-hut:00000000-0000-0000-0000-000000000001" }],
    [U1]
  ),
  row(
    "visitRecordedLocation",
    (client) => [client.visitRecordedLocation("00000000-0000-0000-0000-000000000002")],
    [{ type: "VISIT_RECORDED_LOCATION", requestId: U1, locationId: "00000000-0000-0000-0000-000000000002" }],
    [U1]
  ),
  row(
    "visitOpenLand",
    (client) => [client.visitOpenLand()],
    [{ type: "VISIT_OPEN_LAND", requestId: U1 }],
    [U1]
  ),
  row(
    "mapMarkerCommand",
    (client) => [client.mapMarkerCommand({ action: "list" })],
    [{ type: "MAP_MARKER_COMMAND", requestId: U1, command: { action: "list" } }],
    [U1]
  ),
  row(
    "openHollinHut",
    (client) => [client.openHollinHut("hollin-hut:1")],
    [{ type: "OPEN_HOLLIN_HUT", requestId: U1, hutId: "hollin-hut:1" }],
    [true]
  ),
  row(
    "buyFromHollinHut",
    (client) => [client.buyFromHollinHut("hollin-hut:1", "simple_food", 2, "30")],
    [{ type: "BUY_FROM_HOLLIN_HUT", requestId: U1, hutId: "hollin-hut:1", itemId: "simple_food", quantity: 2, expectedUnitPriceGold: "30" }],
    [true]
  ),
  row(
    "offerBerryToHollins",
    (client) => [client.offerBerryToHollins("hollin-hut:1")],
    [{ type: "OFFER_BERRY_TO_HOLLINS", requestId: U1, hutId: "hollin-hut:1" }],
    [true]
  ),
  row(
    "useHollinHutService",
    (client) => [client.useHollinHutService("hollin-hut:1", "heal")],
    [{ type: "USE_HOLLIN_HUT_SERVICE", requestId: U1, hutId: "hollin-hut:1", service: "heal" }],
    [true]
  ),
  row(
    "listWanderingMerchants",
    (client) => [client.listWanderingMerchants()],
    [{ type: "LIST_WANDERING_MERCHANTS", requestId: U1 }],
    [true]
  ),
  row(
    "openWanderingMerchant",
    (client) => [client.openWanderingMerchant("wandering-merchant:1")],
    [{ type: "OPEN_WANDERING_MERCHANT", requestId: U1, merchantId: "wandering-merchant:1" }],
    [true]
  ),
  row(
    "buyFromWanderingMerchant",
    (client) => [client.buyFromWanderingMerchant("wandering-merchant:1", "lamp_sheath", 1, "20000")],
    [{ type: "BUY_FROM_WANDERING_MERCHANT", requestId: U1, merchantId: "wandering-merchant:1", itemId: "lamp_sheath", quantity: 1, expectedUnitPriceGold: "20000" }],
    [true]
  ),
  row(
    "craftCinderLantern",
    (client) => [client.craftCinderLantern()],
    [{ type: "CRAFT_CINDER_LANTERN", requestId: U1 }],
    [true]
  ),
  row(
    "claimMine",
    (client) => [client.claimMine("mine-1", 7)],
    [{ type: "CLAIM_MINE", requestId: U1, nodeId: "mine-1", expectedAuthorityRevision: 7 }],
    [U1]
  ),
  row(
    "dropEquipment",
    (client) => [client.dropEquipment("equipment-1", 9)],
    [{ type: "DROP_EQUIPMENT", requestId: U1, equipmentInstanceId: "equipment-1", expectedEquipmentRevision: 9 }],
    [true]
  ),
  row(
    "commandPet",
    (client) => [client.commandPet("pet-1", "stay"), client.commandPet("pet-1", "follow")],
    [
      { type: "COMMAND_PET", requestId: U1, petId: "pet-1", command: "stay" },
      { type: "COMMAND_PET", requestId: U2, petId: "pet-1", command: "follow" }
    ],
    [U1, U2]
  ),
  row(
    "startXoralEvent",
    (client) => [client.startXoralEvent("xoral-1")],
    [{ type: "START_XORAL_EVENT", requestId: U1, xoralEntityId: "xoral-1" }],
    [sentAttempt(U1)]
  ),
  row(
    "confirmXoralExit",
    (client) => [client.confirmXoralExit()],
    [{ type: "CONFIRM_XORAL_EXIT", requestId: U1 }],
    [sentAttempt(U1)]
  ),
  row(
    "pickupXoralRingDrop",
    (client) => [client.pickupXoralRingDrop("drop-1")],
    [{ type: "PICKUP_XORAL_RING_DROP", requestId: U1, dropId: "drop-1" }],
    [sentAttempt(U1)]
  ),
  row(
    "spawnDungeonEntrance",
    (client) => [client.spawnDungeonEntrance("cistern_warrens_world_entrance", 35.1, -106.6)],
    [{
      type: "DEV_SPAWN_DUNGEON_ENTRANCE",
      requestId: U1,
      templateId: "cistern_warrens_world_entrance",
      lat: 35.1,
      lon: -106.6
    }],
    [U1]
  ),
  row(
    "listDungeonEntrances",
    (client) => [client.listDungeonEntrances()],
    [{ type: "DEV_LIST_DUNGEON_ENTRANCES", requestId: U1 }],
    [U1]
  ),
  row(
    "deleteDungeonEntrance",
    (client) => [client.deleteDungeonEntrance("dev-dungeon-1")],
    [{ type: "DEV_DELETE_DUNGEON_ENTRANCE", requestId: U1, entranceId: "dev-dungeon-1" }],
    [U1]
  ),
  row(
    "listGoblinVillages",
    (client) => [client.listGoblinVillages()],
    [{ type: "DEV_LIST_GOBLIN_VILLAGES", requestId: U1 }],
    [U1]
  ),
  row(
    "foundCapital",
    (client) => [client.foundCapital({ requestId: "capital-1", dryRun: true, leaveCurrentCity: false })],
    [{ type: "DEV_FOUND_CAPITAL", requestId: "capital-1", dryRun: true, leaveCurrentCity: false }],
    [true],
    0
  ),
  row(
    "collapseTerritory",
    (client) => [client.collapseTerritory({ requestId: "collapse-1", kind: "city" })],
    [{ type: "DEV_COLLAPSE_TERRITORY", requestId: "collapse-1", kind: "city" }],
    [true],
    0
  ),
  row(
    "deleteGoblinVillage",
    (client) => [client.deleteGoblinVillage("city-1")],
    [{ type: "DEV_DELETE_GOBLIN_VILLAGE", requestId: U1, cityId: "city-1" }],
    [U1]
  ),
  row(
    "respecSkillTreeV3Build",
    (client) => [client.respecSkillTreeV3Build(7), client.respecSkillTreeV3Build(8, "respec-2")],
    [
      { type: "RESPEC_SKILL_BUILD", requestId: U1, expectedRevision: 7 },
      { type: "RESPEC_SKILL_BUILD", requestId: "respec-2", expectedRevision: 8 }
    ],
    [U1, "respec-2"]
  ),
  row(
    "unlockClass",
    (client) => [client.unlockClass("warrior")],
    [{ type: "UNLOCK_CLASS", requestId: U1, classId: "warrior" }],
    [true]
  ),
  row(
    "craftEquipment",
    (client) => [client.craftEquipment("sword", "craft-1", "manor-session-1", 7)],
    [{ type: "CRAFT_EQUIPMENT", requestId: "craft-1", familyId: "sword", manorSessionId: "manor-session-1", manorMovementSequence: 7 }],
    ["craft-1"],
    0
  ),
  row(
    "purchaseLimitedEquipment",
    (client) => [client.purchaseLimitedEquipment("god_sword", "purchase-1", "manor-session-1", 8)],
    [{ type: "PURCHASE_LIMITED_EQUIPMENT", requestId: "purchase-1", definitionId: "god_sword", manorSessionId: "manor-session-1", manorMovementSequence: 8 }],
    ["purchase-1"],
    0
  ),
  row(
    "requestCreatureBook",
    (client) => [client.requestCreatureBook()],
    [{ type: "REQUEST_CREATURE_BOOK" }],
    [true],
    0
  ),
  row(
    "moveTo",
    (client) => [
      client.moveTo(35.1, -106.6),
      client.moveTo(35.2, -106.7, "travel-bound")
    ],
    [
      { type: "MOVE_TO", requestId: U1, lat: 35.1, lon: -106.6 },
      {
        type: "MOVE_TO",
        requestId: U2,
        boundTravelRequestId: "travel-bound",
        lat: 35.2,
        lon: -106.7
      }
    ],
    [U1, U2]
  ),
  row(
    "requestBiomeDiscovery",
    (client) => [client.requestBiomeDiscovery()],
    [{ type: "REQUEST_BIOME_DISCOVERY" }],
    [true],
    0
  ),
  row(
    "requestWorldMapDestinations",
    (client) => [client.requestWorldMapDestinations()],
    [{ type: "REQUEST_WORLD_MAP_DESTINATIONS", requestId: U1 }],
    [true]
  ),
  row(
    "setWorldMapDestinationVisibility",
    (client) => [client.setWorldMapDestinationVisibility({
      kind: "city",
      id: MARKET_STRUCTURE_ID
    }, false)],
    [{
      type: "SET_WORLD_MAP_DESTINATION_VISIBILITY",
      requestId: U1,
      destinationKind: "city",
      destinationId: MARKET_STRUCTURE_ID,
      visible: false
    }],
    [true],
    1
  ),
  row(
    "requestWorldResync",
    (client) => [client.requestWorldResync(8, 13)],
    [{
      type: "REQUEST_WORLD_RESYNC",
      requestId: U1,
      combatSequence: 8,
      playerSequence: 13
    }],
    [true]
  ),
  row(
    "requestPopulationResync",
    (client) => [client.requestPopulationResync({
      connectionId: "connection-1",
      connectionGeneration: 3,
      preparationGeneration: 8,
      relocationRevision: 5,
      resourceVisionRevision: 7,
      preparationTrigger: "flag-placement",
      preparationScope: "required-visible"
    })],
    [{
      type: "REQUEST_POPULATION_RESYNC",
      requestId: U1,
      connectionId: "connection-1",
      connectionGeneration: 3,
      preparationGeneration: 8,
      relocationRevision: 5,
      resourceVisionRevision: 7,
      preparationTrigger: "flag-placement",
      preparationScope: "required-visible"
    }],
    [U1]
  ),
  row(
    "jumpToManor",
    (client) => [client.jumpToManor("manor-1")],
    [{ type: "JUMP_TO_MANOR", requestId: U1, manorId: "manor-1" }],
    [U1]
  ),
  row(
    "enterManor",
    (client) => [client.enterManor("manor-1")],
    [{
      type: "USE_PORTAL",
      requestId: U1,
      portalId: "manor:manor-1:world-to-main",
      expectedLocationRevision: 0
    }],
    [U1]
  ),
  row(
    "cancelManorEntry",
    (client) => {
      client.enterManor("manor-1");
      return [client.cancelManorEntry()];
    },
    [{
      type: "USE_PORTAL",
      requestId: U1,
      portalId: "manor:manor-1:world-to-main",
      expectedLocationRevision: 0
    }],
    [true]
  ),
  row(
    "requestManorGuests",
    (client) => [client.requestManorGuests("manor-1")],
    [{ type: "REQUEST_MANOR_GUESTS", requestId: U1, manorId: "manor-1" }],
    [true]
  ),
  row(
    "kickManorGuest",
    (client) => [client.kickManorGuest("manor-1", "player-2")],
    [{
      type: "KICK_MANOR_GUEST",
      requestId: U1,
      manorId: "manor-1",
      targetPlayerId: "player-2"
    }],
    [true]
  ),
  row(
    "banManorGuest",
    (client) => [client.banManorGuest("manor-1", "player-2")],
    [{
      type: "BAN_MANOR_GUEST",
      requestId: U1,
      manorId: "manor-1",
      targetPlayerId: "player-2"
    }],
    [true]
  ),
  row(
    "unbanManorGuest",
    (client) => [client.unbanManorGuest("manor-1", "player-2")],
    [{
      type: "UNBAN_MANOR_GUEST",
      requestId: U1,
      manorId: "manor-1",
      targetPlayerId: "player-2"
    }],
    [true]
  ),
  row(
    "buildGreenhouse",
    (client) => [client.buildGreenhouse()],
    [{ type: "BUILD_GREENHOUSE", requestId: U1 }],
    [U1]
  ),
  row(
    "previewGreenhouseBuild",
    (client) => [client.previewGreenhouseBuild()],
    [{ type: "PREVIEW_GREENHOUSE_BUILD", requestId: U1 }],
    [U1]
  ),
  row(
    "cancelGreenhouseBuild",
    (client) => [client.cancelGreenhouseBuild()],
    [{ type: "CANCEL_GREENHOUSE_BUILD", requestId: U1 }],
    [U1]
  ),
  row(
    "destroyGreenhouse",
    (client) => [client.destroyGreenhouse("greenhouse-1")],
    [{ type: "DESTROY_GREENHOUSE", requestId: U1, greenhouseId: "greenhouse-1" }],
    [U1]
  ),
  row(
    "openGreenhouse",
    (client) => [client.openGreenhouse("greenhouse-1")],
    [{ type: "OPEN_GREENHOUSE", requestId: U1, greenhouseId: "greenhouse-1" }],
    [U1]
  ),
  row(
    "enterGreenhouse",
    (client) => [client.enterGreenhouse("greenhouse-1")],
    [{
      type: "USE_PORTAL",
      requestId: U1,
      portalId: "greenhouse:greenhouse-1:world-to-main",
      expectedLocationRevision: 0
    }],
    [U1]
  ),
  row(
    "exitGreenhouse",
    (client) => {
      client.enterGreenhouse("greenhouse-1");
      return [client.exitGreenhouse("session-1")];
    },
    [{
      type: "USE_PORTAL",
      requestId: U1,
      portalId: "greenhouse:greenhouse-1:world-to-main",
      expectedLocationRevision: 0
    }, {
      type: "USE_PORTAL",
      requestId: U2,
      portalId: "greenhouse:greenhouse-1:main-to-world",
      expectedLocationRevision: 0,
      approach: "immediate"
    }],
    [U2]
  ),
  row(
    "rememberGreenhouse",
    (client) => [client.rememberGreenhouse("greenhouse-1")],
    [],
    [undefined]
  ),
  row(
    "greenhouseMoveTo",
    (client) => [client.greenhouseMoveTo("session-1", 3, 4)],
    [{ type: "GREENHOUSE_MOVE_TO", requestId: U1, greenhouseSessionId: "session-1", x: 3, y: 4 }],
    [U1]
  ),
  row(
    "waterGreenhouse",
    (client) => [client.waterGreenhouse("session-1", "anchor-1")],
    [{ type: "WATER_GREENHOUSE", requestId: U1, greenhouseSessionId: "session-1", anchorId: "anchor-1" }],
    [U1]
  ),
  row(
    "clipGreenhouse",
    (client) => [client.clipGreenhouse("session-1", "anchor-1")],
    [{ type: "CLIP_GREENHOUSE", requestId: U1, greenhouseSessionId: "session-1", anchorId: "anchor-1" }],
    [U1]
  ),
  row(
    "harvestGreenhouse",
    (client) => [client.harvestGreenhouse("session-1", "anchor-1")],
    [{ type: "HARVEST_GREENHOUSE", requestId: U1, greenhouseSessionId: "session-1", anchorId: "anchor-1" }],
    [U1]
  ),
  row(
    "tapGreenhouseTree",
    (client) => [client.tapGreenhouseTree("session-1", "anchor-1")],
    [{ type: "TAP_GREENHOUSE_TREE", requestId: U1, greenhouseSessionId: "session-1", anchorId: "anchor-1" }],
    [U1]
  ),
  row(
    "plantGreenhouse",
    (client) => [client.plantGreenhouse("session-1", "anchor-1", "giving_berry_tree")],
    [{ type: "PLANT_GREENHOUSE", requestId: U1, greenhouseSessionId: "session-1", anchorId: "anchor-1", cropId: "giving_berry_tree", packId: "0".repeat(64) }],
    [U1]
  ),
  row(
    "craftWaterBucket",
    (client) => [client.craftWaterBucket()],
    [{ type: "CRAFT_WATER_BUCKET", requestId: U1 }],
    [U1]
  ),
  row(
    "craftFertilizer",
    (client) => [client.craftFertilizer()],
    [{ type: "CRAFT_FERTILIZER", requestId: U1 }],
    [U1]
  ),
  row(
    "fillWaterBucket",
    (client) => [client.fillWaterBucket(1.5, 2.5, 3)],
    [{ type: "FILL_WATER_BUCKET", requestId: U1, lat: 1.5, lon: 2.5, gallons: 3 }],
    [U1]
  ),
  row(
    "cancelWaterBucketFill",
    (client) => [client.cancelWaterBucketFill()],
    [{ type: "CANCEL_WATER_BUCKET_FILL", requestId: U1 }],
    [U1]
  ),
  row(
    "depositGreenhouseWater",
    (client) => [client.depositGreenhouseWater("session-1")],
    [{ type: "DEPOSIT_GREENHOUSE_WATER", requestId: U1, greenhouseSessionId: "session-1" }],
    [U1]
  ),
  row(
    "refillGardeningBucket",
    (client) => [client.refillGardeningBucket("session-1")],
    [{ type: "REFILL_GARDENING_BUCKET", requestId: U1, greenhouseSessionId: "session-1" }],
    [U1]
  ),
  row(
    "advanceAllGreenhouseCrops",
    (client) => [client.advanceAllGreenhouseCrops()],
    [{ type: "DEV_ADVANCE_ALL_GREENHOUSE_CROPS", requestId: U1 }],
    [U1]
  ),
  row(
    "buildDevManor",
    (client) => [client.buildDevManor()],
    [{ type: "DEV_BUILD_MANOR", requestId: U1 }],
    [U1]
  ),
  row(
    "buildDevSalon",
    (client) => [client.buildDevSalon()],
    [{ type: "DEV_BUILD_SALON", requestId: U1 }],
    [U1]
  ),
  row(
    "grantMetalEquipment",
    (client) => [client.grantMetalEquipment("sword", "fire")],
    [{ type: "DEV_GRANT_METAL_EQUIPMENT", requestId: U1, kind: "sword", metal: "fire" }],
    [U1]
  ),
  row(
    "waterAllGreenhouseCrops",
    (client) => [client.waterAllGreenhouseCrops()],
    [{ type: "DEV_WATER_ALL_GREENHOUSE_CROPS", requestId: U1 }],
    [U1]
  ),
  row(
    "buildManor",
    (client) => [client.buildManor()],
    [{ type: "BUILD_MANOR", requestId: U1 }],
    [U1]
  ),
  row(
    "destroyManor",
    (client) => [client.destroyManor()],
    [{ type: "DESTROY_MANOR", requestId: U1 }],
    [U1]
  ),
  row(
    "attackManor",
    (client) => [client.attackManor("manor-1")],
    [{ type: "ATTACK_MANOR", requestId: U1, manorId: "manor-1" }],
    [U1]
  ),
  row(
    "startManorRepair",
    (client) => [client.startManorRepair("manor-1")],
    [{ type: "START_MANOR_REPAIR", requestId: U1, manorId: "manor-1" }],
    [U1]
  ),
  row(
    "stopManorRepair",
    (client) => [client.stopManorRepair()],
    [{ type: "STOP_MANOR_REPAIR", requestId: U1 }],
    [U1]
  ),
  row(
    "installManorSkin",
    (client) => [client.installManorSkin("samurai_manor")],
    [{ type: "INSTALL_MANOR_SKIN", requestId: U1, manorTypeId: "samurai_manor" }],
    [U1]
  ),
  row(
    "exitManor",
    (client) => {
      client.enterManor("manor-1");
      return [client.exitManor("session-1")];
    },
    [{
      type: "USE_PORTAL",
      requestId: U1,
      portalId: "manor:manor-1:world-to-main",
      expectedLocationRevision: 0
    }, {
      type: "USE_PORTAL",
      requestId: U2,
      portalId: "manor:manor-1:main-to-world",
      expectedLocationRevision: 0
    }],
    [U2]
  ),
  row(
    "manorMoveTo",
    (client) => [client.manorMoveTo("session-1", 3, 4)],
    [{
      type: "MANOR_MOVE_TO",
      requestId: U1,
      manorSessionId: "session-1",
      x: 3,
      y: 4
    }],
    [U1]
  ),
  row(
    "placeFlag",
    (client) => [client.placeFlag(), client.placeFlag("North", "quote-1")],
    [
      { type: "PLACE_FLAG", requestId: U1 },
      {
        type: "PLACE_FLAG",
        requestId: U2,
        name: "North",
        quoteId: "quote-1"
      }
    ],
    [U1, U2]
  ),
  row(
    "cancelFlagBuild",
    (client) => [client.cancelFlagBuild("build-1")],
    [{ type: "CANCEL_FLAG_BUILD", requestId: U1, buildId: "build-1" }],
    [true]
  ),
  row(
    "startFlagBurn",
    (client) => [client.startFlagBurn("flag-1")],
    [{ type: "START_FLAG_BURN", requestId: U1, flagId: "flag-1" }],
    [U1]
  ),
  row(
    "attackFlag",
    (client) => [client.attackFlag("flag-1")],
    [{ type: "ATTACK_FLAG", requestId: U1, flagId: "flag-1" }],
    [U1]
  ),
  row(
    "attackWarCamp",
    (client) => [client.attackWarCamp("camp-1", "hand")],
    [{ type: "ATTACK_WAR_CAMP", requestId: U1, campId: "camp-1", mode: "hand" }],
    [U1]
  ),
  row(
    "attackCityStructure",
    (client) => [client.attackCityStructure("structure-1")],
    [{ type: "ATTACK_CITY_STRUCTURE", requestId: U1, structureId: "structure-1" }],
    [U1]
  ),
  row(
    "startCityStructureRepair",
    (client) => [client.startCityStructureRepair("structure-1")],
    [{ type: "START_CITY_STRUCTURE_REPAIR", requestId: U1, structureId: "structure-1" }],
    [U1]
  ),
  row(
    "stopCityStructureRepair",
    (client) => [client.stopCityStructureRepair()],
    [{ type: "STOP_CITY_STRUCTURE_REPAIR", requestId: U1 }],
    [U1]
  ),
  row(
    "buyCityMarketDaily",
    (client) => [client.buyCityMarketDaily("city-1")],
    [{ type: "BUY_CITY_MARKET_DAILY", requestId: U1, cityId: "city-1" }],
    [U1]
  ),
  row(
    "craftTorch",
    (client) => [client.craftTorch()],
    [{ type: "CRAFT_TORCH", requestId: U1 }],
    [U1]
  ),
  row(
    "reinforceFlag",
    (client) => [client.reinforceFlag("flag-1")],
    [{ type: "REINFORCE_FLAG", requestId: U1, flagId: "flag-1", targetTier: "stone" }],
    [true]
  ),
  row(
    "upgradeFlag",
    (client) => [client.upgradeFlag("flag-1", "tower")],
    [{ type: "REINFORCE_FLAG", requestId: U1, flagId: "flag-1", targetTier: "tower" }],
    [true]
  ),
  row(
    "surveyArea",
    (client) => [client.surveyArea()],
    [{ type: "SURVEY_AREA", requestId: U1 }],
    [undefined]
  ),
  row(
    "devTeleport",
    (client) => [client.devTeleport(35.1, -106.6)],
    [{
      type: "DEV_TELEPORT",
      requestId: U1,
      lat: 35.1,
      lon: -106.6
    }],
    [U1]
  ),
  row(
    "devVisitMine",
    (client) => [client.devVisitMine("mine-1")],
    [{ type: "DEV_VISIT_MINE", requestId: U1, mineId: "mine-1" }],
    [U1]
  ),
  row(
    "spawnMob",
    (client) => [client.spawnMob("wolf", 35.1, -106.6)],
    [{
      type: "DEV_SPAWN_MOB",
      requestId: U1,
      archetype: "wolf",
      lat: 35.1,
      lon: -106.6
    }],
    [true]
  ),
  row(
    "spawnPlant",
    (client) => [client.spawnPlant("flax", 35.1, -106.6)],
    [{
      type: "DEV_SPAWN_PLANT",
      requestId: U1,
      plantKey: "flax",
      lat: 35.1,
      lon: -106.6
    }],
    [true]
  ),
  row(
    "spawnGoblinVillage",
    (client) => [client.spawnGoblinVillage(35.1, -106.6)],
    [{
      type: "DEV_SPAWN_GOBLIN_VILLAGE",
      requestId: U1,
      lat: 35.1,
      lon: -106.6
    }],
    [U1]
  ),
  row(
    "clearMobs",
    (client) => [client.clearMobs()],
    [{ type: "DEV_CLEAR_MOBS", requestId: U1 }],
    [true]
  ),
  row(
    "resetDevDungeonRun",
    (client) => [client.resetDevDungeonRun()],
    [{ type: "DEV_RESET_DUNGEON_RUN", requestId: U1 }],
    [U1]
  ),
  row(
    "clearPlants",
    (client) => [client.clearPlants()],
    [{ type: "DEV_CLEAR_PLANTS", requestId: U1 }],
    [true]
  ),
  row(
    "resetOwnDevClassCooldowns",
    (client) => [client.resetOwnDevClassCooldowns()],
    [{ type: "RESET_OWN_DEV_CLASS_COOLDOWNS", requestId: U1 }],
    [U1]
  ),
  row(
    "grantOwnDevelopmentAssets",
    (client) => [
      client.grantOwnDevelopmentAssets({}, "grant-empty"),
      client.grantOwnDevelopmentAssets({
        gold: 12,
        materials: [{ itemId: "wood", quantity: 3 }]
      })
    ],
    [
      { type: "GRANT_OWN_DEV_ASSETS", requestId: "grant-empty" },
      {
        type: "GRANT_OWN_DEV_ASSETS",
        requestId: U1,
        gold: "12",
        materials: [{ itemId: "wood", quantity: "3" }]
      }
    ],
    ["grant-empty", U1]
  ),
  row(
    "visitFlag",
    (client) => [
      client.visitFlag("flag-1"),
      client.visitFlag("flag-2", "visit-2", "15")
    ],
    [
      { type: "VISIT_FLAG", requestId: U1, flagId: "flag-1", source: "visible_map" },
      {
        type: "VISIT_FLAG",
        requestId: "visit-2",
        flagId: "flag-2",
        source: "visible_map",
        expectedTollGold: "15"
      }
    ],
    [U1, "visit-2"]
  ),
  row(
    "prepareVisibleFlagVisit",
    (client) => [client.prepareVisibleFlagVisit(
      VISIBLE_FLAG_ID,
      {
        expectedConnectionGeneration: 3,
        expectedGameplayViewGeneration: 5,
        expectedResourceVisionRevision: 7,
        expectedFlagSetRevision: 11,
        expectedDestination: {
          lat: 39.7392,
          lon: -104.9903,
          claimRadiusM: 700,
          resourceVisionRadiusM: 1_000,
          personalFlagId: VISIBLE_FLAG_ID
        }
      },
      "visible-prepare",
      "15"
    )],
    [{
      type: "PREPARE_VISIBLE_FLAG_VISIT",
      requestId: "visible-prepare",
      flagId: VISIBLE_FLAG_ID,
      expectedConnectionGeneration: 3,
      expectedGameplayViewGeneration: 5,
      expectedResourceVisionRevision: 7,
      expectedFlagSetRevision: 11,
      expectedDestination: {
        lat: 39.7392,
        lon: -104.9903,
        claimRadiusM: 700,
        resourceVisionRadiusM: 1_000,
        personalFlagId: VISIBLE_FLAG_ID
      },
      expectedTollGold: "15"
    }],
    ["visible-prepare"]
  ),
  row(
    "commitVisibleFlagVisit",
    (client) => [client.commitVisibleFlagVisit(
      VISIBLE_FLAG_ID,
      {
        expectedConnectionGeneration: 3,
        expectedGameplayViewGeneration: 5,
        expectedResourceVisionRevision: 7,
        expectedFlagSetRevision: 11,
        expectedDestination: {
          lat: 39.7392,
          lon: -104.9903,
          claimRadiusM: 700,
          resourceVisionRadiusM: 1_000,
          personalFlagId: VISIBLE_FLAG_ID
        }
      },
      "visible-commit",
      "visible-prepare",
      "15"
    )],
    [{
      type: "COMMIT_VISIBLE_FLAG_VISIT",
      requestId: "visible-commit",
      preparationId: "visible-prepare",
      flagId: VISIBLE_FLAG_ID,
      expectedConnectionGeneration: 3,
      expectedGameplayViewGeneration: 5,
      expectedResourceVisionRevision: 7,
      expectedFlagSetRevision: 11,
      expectedDestination: {
        lat: 39.7392,
        lon: -104.9903,
        claimRadiusM: 700,
        resourceVisionRadiusM: 1_000,
        personalFlagId: VISIBLE_FLAG_ID
      },
      expectedTollGold: "15"
    }],
    ["visible-commit"]
  ),
  row(
    "cancelVisibleFlagVisit",
    (client) => [client.cancelVisibleFlagVisit("visible-prepare")],
    [{
      type: "CANCEL_VISIBLE_FLAG_VISIT",
      requestId: "visible-prepare"
    }],
    [true]
  ),
  row(
    "visitWorldMapKingdom",
    (client) => [
      client.visitWorldMapKingdom("seat-1"),
      client.visitWorldMapKingdom("seat-2", "kingdom-visit-2")
    ],
    [
      {
        type: "VISIT_WORLD_MAP_KINGDOM",
        requestId: U1,
        seatId: "seat-1"
      },
      {
        type: "VISIT_WORLD_MAP_KINGDOM",
        requestId: "kingdom-visit-2",
        seatId: "seat-2"
      }
    ],
    [U1, "kingdom-visit-2"]
  ),
  row(
    "visitWorldMapAtlasShrine",
    (client) => [
      client.visitWorldMapAtlasShrine("shrine-1"),
      client.visitWorldMapAtlasShrine("shrine-2", "shrine-visit-2")
    ],
    [
      {
        type: "VISIT_WORLD_MAP_ATLAS_SHRINE",
        requestId: U1,
        flagId: "shrine-1"
      },
      {
        type: "VISIT_WORLD_MAP_ATLAS_SHRINE",
        requestId: "shrine-visit-2",
        flagId: "shrine-2"
      }
    ],
    [U1, "shrine-visit-2"]
  ),
  row(
    "prepareWorldMapTravel",
    (client) => [client.prepareWorldMapTravel({
      kind: "manor",
      id: "manor-1",
      name: "Your Manor",
      lat: 35,
      lon: -106
    })],
    [{
      type: "PREPARE_WORLD_MAP_TRAVEL",
      requestId: U1,
      destinationKind: "manor",
      destinationId: "manor-1"
    }],
    [U1]
  ),
  row(
    "visitCity",
    (client) => [client.visitCity("city-1")],
    [{ type: "VISIT_CITY", requestId: U1, cityId: "city-1" }],
    [U1]
  ),
  row(
    "visitCityHouse",
    (client) => [client.visitCityHouse("house-1")],
    [{ type: "VISIT_CITY_HOUSE", requestId: U1, structureId: "house-1" }],
    [U1]
  ),
  row(
    "visitCityWarehouse",
    (client) => [
      client.visitCityWarehouse(WAREHOUSE_STRUCTURE_ID, "7"),
      client.visitCityWarehouse(WAREHOUSE_STRUCTURE_ID, "8", "warehouse-visit-2")
    ],
    [
      {
        type: "VISIT_CITY_WAREHOUSE",
        requestId: U1,
        structureId: WAREHOUSE_STRUCTURE_ID,
        expectedPlacementRevision: "7"
      },
      {
        type: "VISIT_CITY_WAREHOUSE",
        requestId: "warehouse-visit-2",
        structureId: WAREHOUSE_STRUCTURE_ID,
        expectedPlacementRevision: "8"
      }
    ],
    [U1, "warehouse-visit-2"]
  ),
  row(
    "visitWorldMapCity",
    (client) => [client.visitWorldMapCity("city-1")],
    [{ type: "VISIT_WORLD_MAP_CITY", requestId: U1, cityId: "city-1" }],
    [U1]
  ),
  row(
    "sendTravelInvite",
    (client) => [client.sendTravelInvite("player-2")],
    [{
      type: "SEND_TRAVEL_INVITE",
      requestId: U1,
      targetPlayerId: "player-2"
    }],
    [U1]
  ),
  row(
    "relocateToCurrentLocation",
    (client) => [
      client.relocateToCurrentLocation(35.1, -106.6, 12),
      client.relocateToCurrentLocation(35.1, -106.6, undefined, "relocate-2", "America/Denver")
    ],
    [{
      type: "RELOCATE_TO_CURRENT_LOCATION",
      requestId: U1,
      lat: 35.1,
      lon: -106.6,
      accuracy: 12
    }, {
      type: "RELOCATE_TO_CURRENT_LOCATION",
      requestId: "relocate-2",
      lat: 35.1,
      lon: -106.6,
      deviceTimeZone: "America/Denver"
    }],
    [U1, "relocate-2"]
  ),
  row(
    "sendLocationFix",
    (client) => [
      client.sendLocationFix(35.1, -106.6, 40, "America/Denver"),
      client.sendLocationFix(35.1, -106.6)
    ],
    [
      { type: "LOCATION_FIX", lat: 35.1, lon: -106.6, accuracy: 40, deviceTimeZone: "America/Denver" },
      { type: "LOCATION_FIX", lat: 35.1, lon: -106.6 }
    ],
    [true, true],
    0
  ),
  row(
    "respondTravelInvite",
    (client) => [
      client.respondTravelInvite("invite-1", "accept"),
      client.respondTravelInvite("invite-2", "decline", "respond-2")
    ],
    [
      {
        type: "RESPOND_TRAVEL_INVITE",
        requestId: U1,
        inviteId: "invite-1",
        response: "accept"
      },
      {
        type: "RESPOND_TRAVEL_INVITE",
        requestId: "respond-2",
        inviteId: "invite-2",
        response: "decline"
      }
    ],
    [U1, "respond-2"]
  ),
  row(
    "cancelTravelInvite",
    (client) => [client.cancelTravelInvite("invite-1")],
    [{
      type: "CANCEL_TRAVEL_INVITE",
      requestId: U1,
      inviteId: "invite-1"
    }],
    [true]
  ),
  row(
    "cancelTravelInviteRequest",
    (client) => [client.cancelTravelInviteRequest("invite-1")],
    [{
      type: "CANCEL_TRAVEL_INVITE",
      requestId: U1,
      inviteId: "invite-1"
    }],
    [U1]
  ),
  row(
    "requestTravelInbox",
    (client) => [client.requestTravelInbox()],
    [{ type: "REQUEST_TRAVEL_INBOX", requestId: U1 }],
    [true]
  ),
  row(
    "travelToPartyLeader",
    (client) => [
      client.travelToPartyLeader(),
      client.travelToPartyLeader("leader-2")
    ],
    [
      { type: "TRAVEL_TO_PARTY_LEADER", requestId: U1 },
      {
        type: "TRAVEL_TO_PARTY_LEADER",
        requestId: "leader-2"
      }
    ],
    [U1, "leader-2"]
  ),
  row(
    "previewCityFounding",
    (client) => [client.previewCityFounding("flag-1")],
    [{
      type: "PREVIEW_CITY_FOUNDING",
      requestId: U1,
      flagId: "flag-1"
    }],
    [undefined]
  ),
  row(
    "foundCity",
    (client) => [client.foundCity("flag-1")],
    [{ type: "FOUND_CITY", requestId: U1, flagId: "flag-1" }],
    [undefined]
  ),
  row(
    "advanceCityConstruction",
    (client) => [client.advanceCityConstruction("city-1", "build_foundation")],
    [{
      type: "ADVANCE_CITY_CONSTRUCTION",
      requestId: U1,
      cityId: "city-1",
      action: "build_foundation"
    }],
    [U1]
  ),
  row(
    "requestCityInfo",
    (client) => [client.requestCityInfo("city-1")],
    [{ type: "REQUEST_CITY_INFO", requestId: U1, cityId: "city-1" }],
    [undefined]
  ),
  row(
    "requestCityApp",
    (client) => [client.requestCityApp()],
    [{ type: "REQUEST_CITY_APP", requestId: U1 }],
    [undefined]
  ),
  row(
    "buildCityHouse",
    (client) => [client.buildCityHouse()],
    [{ type: "BUILD_CITY_HOUSE", requestId: U1 }],
    [U1]
  ),
  row(
    "destroyCityHouse",
    (client) => [client.destroyCityHouse("house-1", "7")],
    [{
      type: "DESTROY_CITY_HOUSE",
      requestId: U1,
      structureId: "house-1",
      expectedPlacementRevision: "7"
    }],
    [true]
  ),
  row(
    "buildCityFacility",
    (client) => [client.buildCityFacility("city-1", "warehouse")],
    [{
      type: "BUILD_CITY_FACILITY",
      requestId: U1,
      cityId: "city-1",
      facilityType: "warehouse"
    }],
    [U1]
  ),
  row(
    "upgradeCityFacility",
    (client) => [client.upgradeCityFacility("structure-1", 1)],
    [{
      type: "UPGRADE_CITY_FACILITY",
      requestId: U1,
      structureId: "structure-1",
      expectedTier: 1
    }],
    [U1]
  ),
  row(
    "destroyCityFacility",
    (client) => [client.destroyCityFacility("structure-1", "9")],
    [{
      type: "DESTROY_CITY_FACILITY",
      requestId: U1,
      structureId: "structure-1",
      expectedPlacementRevision: "9"
    }],
    [true]
  ),
  row(
    "openCityWarehouse",
    (client) => [client.openCityWarehouse("structure-1")],
    [{
      type: "OPEN_CITY_WAREHOUSE",
      requestId: U1,
      structureId: "structure-1"
    }],
    [U1]
  ),
  row(
    "donateCityWarehouse",
    (client) => [client.donateCityWarehouse("structure-1", "stack-1", 4)],
    [{
      type: "DONATE_CITY_WAREHOUSE",
      requestId: U1,
      structureId: "structure-1",
      stackId: "stack-1",
      quantity: 4
    }],
    [U1]
  ),
  row(
    "donateAllCityWarehouse",
    (client) => [client.donateAllCityWarehouse("structure-1")],
    [{
      type: "DONATE_ALL_CITY_WAREHOUSE",
      requestId: U1,
      structureId: "structure-1"
    }],
    [U1]
  ),
  row(
    "moveCityWarehouseStack",
    (client) => [client.moveCityWarehouseStack("structure-1", "stack-1", 7)],
    [{
      type: "MOVE_CITY_WAREHOUSE_STACK",
      requestId: U1,
      structureId: "structure-1",
      stackId: "stack-1",
      targetSlot: 7
    }],
    [U1]
  ),
  row(
    "reorganizeCityWarehouse",
    (client) => [client.reorganizeCityWarehouse("structure-1")],
    [{
      type: "REORGANIZE_CITY_WAREHOUSE",
      requestId: U1,
      structureId: "structure-1"
    }],
    [U1]
  ),
  row(
    "joinCity",
    (client) => [client.joinCity("city-1")],
    [{ type: "JOIN_CITY", requestId: U1, cityId: "city-1" }],
    [undefined]
  ),
  row(
    "leaveCity",
    (client) => [client.leaveCity("city-1")],
    [{ type: "LEAVE_CITY", requestId: U1, cityId: "city-1" }],
    [undefined]
  ),
  row(
    "claimCityMayor",
    (client) => [client.claimCityMayor("city-1")],
    [{ type: "CLAIM_CITY_MAYOR", requestId: U1, cityId: "city-1" }],
    [undefined]
  ),
  row(
    "relinquishCityMayor",
    (client) => [client.relinquishCityMayor("city-1")],
    [{
      type: "RELINQUISH_CITY_MAYOR",
      requestId: U1,
      cityId: "city-1"
    }],
    [undefined]
  ),
  row(
    "convertCityFlag",
    (client) => [client.convertCityFlag("flag-1")],
    [{ type: "CONVERT_CITY_FLAG", requestId: U1, flagId: "flag-1" }],
    [U1]
  ),
  row(
    "requestKingdomState",
    (client) => [client.requestKingdomState()],
    [{ type: "REQUEST_KINGDOM_STATE", requestId: U1 }],
    [true]
  ),
  row(
    "sendKingdomChat",
    (client) => [
      client.sendKingdomChat("hello"),
      client.sendKingdomChat("again", "kingdom-chat-2")
    ],
    [
      { type: "KINGDOM_CHAT_SEND", requestId: U1, content: "hello" },
      {
        type: "KINGDOM_CHAT_SEND",
        requestId: "kingdom-chat-2",
        content: "again"
      }
    ],
    [true, true]
  ),
  row(
    "requestNearbyCollectibles",
    (client) => [client.requestNearbyCollectibles()],
    [{ type: "REQUEST_NEARBY_COLLECTIBLES", requestId: U1 }],
    [undefined]
  ),
  row(
    "startHarvest",
    (client) => [
      client.startHarvest("node-1", HARVEST_AUTHORITY),
      client.startHarvest("node-2", HARVEST_AUTHORITY, "resin")
    ],
    [
      {
        type: "START_HARVEST",
        requestId: U1,
        nodeId: "node-1",
        expectedPresentationOwner: "population",
        expectedEntityRevision: 7,
        expectedRelocationRevision: 11,
        expectedResourceVisionRevision: 13,
        expectedGameplayViewGeneration: 17
      },
      {
        type: "START_HARVEST",
        requestId: U2,
        nodeId: "node-2",
        expectedPresentationOwner: "population",
        expectedEntityRevision: 7,
        expectedRelocationRevision: 11,
        expectedResourceVisionRevision: 13,
        expectedGameplayViewGeneration: 17,
        action: "resin"
      }
    ],
    [sentAttempt(U1), sentAttempt(U2)]
  ),
  row(
    "useBalsamResin",
    (client) => [client.useBalsamResin()],
    [{
      type: "USE_CONSUMABLE",
      requestId: U1,
      itemId: "giving_berry"
    }],
    [true]
  ),
  row(
    "completeHarvest",
    (client) => [client.completeHarvest("harvest-1")],
    [{
      type: "COMPLETE_HARVEST",
      requestId: U1,
      sessionId: "harvest-1"
    }],
    [sentAttempt(U1)]
  ),
  row(
    "cancelHarvest",
    (client) => [client.cancelHarvest("harvest-1")],
    [{
      type: "CANCEL_HARVEST",
      requestId: U1,
      sessionId: "harvest-1"
    }],
    [undefined]
  ),
  row(
    "dropItem",
    (client) => [
      client.dropItem("wood", null),
      client.dropItem("stone", "rough", 4)
    ],
    [
      {
        type: "DROP_ITEM",
        requestId: U1,
        itemId: "wood",
        variant: null,
        quantity: 1
      },
      {
        type: "DROP_ITEM",
        requestId: U2,
        itemId: "stone",
        variant: "rough",
        quantity: 4
      }
    ],
    [true, true]
  ),
  row(
    "updateMaterialKeep",
    (client) => [client.updateMaterialKeep("wood", null, 12, 4)],
    [{
      type: "UPDATE_MATERIAL_KEEP",
      requestId: U1,
      itemId: "wood",
      variant: null,
      keepQuantity: 12,
      expectedRevision: 4
    }],
    [U1]
  ),
  row(
    "updateUniqueItemProtection",
    (client) => [client.updateUniqueItemProtection("equipment-1", true, 6)],
    [{
      type: "UPDATE_UNIQUE_ITEM_PROTECTION",
      requestId: U1,
      equipmentInstanceId: "equipment-1",
      protected: true,
      expectedRevision: 6
    }],
    [U1]
  ),
  row(
    "pickupDroppedItem",
    (client) => [
      client.pickupDroppedItem("drop-1", { mode: "all" }),
      client.pickupDroppedItem("drop-2", { mode: "quantity", quantity: 3 })
    ],
    [
      {
        type: "PICKUP_DROPPED_ITEM",
        requestId: U1,
        dropId: "drop-1",
        pickup: { mode: "all" }
      },
      {
        type: "PICKUP_DROPPED_ITEM",
        requestId: U2,
        dropId: "drop-2",
        pickup: { mode: "quantity", quantity: 3 }
      }
    ],
    [true, true]
  ),
  row(
    "splitInventoryStack",
    (client) => [client.splitInventoryStack("stack-1", 3)],
    [{
      type: "SPLIT_INVENTORY_STACK",
      requestId: U1,
      stackId: "stack-1",
      quantity: 3
    }],
    [U1]
  ),
  row(
    "restackInventoryStack",
    (client) => [client.restackInventoryStack("stack-1")],
    [{
      type: "RESTACK_INVENTORY_STACK",
      requestId: U1,
      stackId: "stack-1"
    }],
    [U1]
  ),
  row(
    "moveInventoryStack",
    (client) => [client.moveInventoryStack("stack-1", 4)],
    [{
      type: "MOVE_INVENTORY_STACK",
      requestId: U1,
      stackId: "stack-1",
      targetSlot: 4
    }],
    [U1]
  ),
  row(
    "reorganizeInventory",
    (client) => [client.reorganizeInventory()],
    [{
      type: "REORGANIZE_INVENTORY",
      requestId: U1
    }],
    [U1]
  ),
  row(
    "collectWaterAtCoordinate",
    (client) => [client.collectWaterAtCoordinate(35.1, -106.6)],
    [{
      type: "COLLECT_WATER_AT_COORDINATE",
      requestId: U1,
      lat: 35.1,
      lon: -106.6
    }],
    [undefined]
  ),
  row(
    "requestPetState",
    (client) => [client.requestPetState()],
    [{ type: "REQUEST_PET_STATE", requestId: U1 }],
    [U1]
  ),
  row(
    "startAttack",
    (client) => [client.startAttack("mob-1")],
    [{ type: "START_ATTACK", requestId: U1, targetEntityId: "mob-1" }],
    [sentAttempt(U1)]
  ),
  row(
    "respawnPlayer",
    (client) => [client.respawnPlayer()],
    [{ type: "RESPAWN_PLAYER", requestId: U1 }],
    [sentAttempt(U1)]
  ),
  row(
    "requestProgressionSnapshot",
    (client) => [client.requestProgressionSnapshot()],
    [{ type: "REQUEST_PROGRESSION_SNAPSHOT", requestId: U1 }],
    [true]
  ),
  row(
    "confirmLevelUp",
    (client) => [client.confirmLevelUp(5, LEVEL_UP_GLIMMER_FEE), client.confirmLevelUp(6, LEVEL_UP_GLIMMER_FEE, "level-6")],
    [
      { type: "CONFIRM_LEVEL_UP", requestId: U1, targetLevel: 5, expectedGlimmerCost: LEVEL_UP_GLIMMER_FEE },
      { type: "CONFIRM_LEVEL_UP", requestId: "level-6", targetLevel: 6, expectedGlimmerCost: LEVEL_UP_GLIMMER_FEE }
    ],
    [U1, "level-6"]
  ),
  row(
    "requestClassSnapshot",
    (client) => [client.requestClassSnapshot()],
    [{ type: "REQUEST_CLASS_SNAPSHOT", requestId: U1 }],
    [true]
  ),
  row(
    "requestSkillTreeV3Snapshot",
    (client) => [client.requestSkillTreeV3Snapshot()],
    [{ type: "REQUEST_SKILL_TREE_SNAPSHOT", requestId: U1 }],
    [U1]
  ),
  row(
    "spendSkillTreeV3Point",
    (client) => [client.spendSkillTreeV3Point(7, { kind: "general_skill", skillId: "cleave" })],
    [{ type: "SPEND_SKILL_POINT", requestId: U1, expectedRevision: 7, target: { kind: "general_skill", skillId: "cleave" } }],
    [U1]
  ),
  row(
    "refundSkillTreeV3Rank",
    (client) => [client.refundSkillTreeV3Rank(8, { kind: "specialization", specializationId: "warrior" })],
    [{ type: "REFUND_SKILL_RANK", requestId: U1, expectedRevision: 8, target: { kind: "specialization", specializationId: "warrior" } }],
    [U1]
  ),
  row(
    "resetOwnDevSkillTreeV3",
    (client) => [client.resetOwnDevSkillTreeV3(8)],
    [{ type: "RESET_OWN_DEV_SKILL_TREE", requestId: U1, expectedRevision: 8 }],
    [U1]
  ),
  row(
    "offerSkillTreeV3Unlock",
    (client) => [client.offerSkillTreeV3Unlock("pierce_armor")],
    [{ type: "OFFER_SKILL_UNLOCK", requestId: U1, skillId: "pierce_armor" }],
    [U1]
  ),
  row(
    "activateSkillTreeV3Specialization",
    (client) => [client.activateSkillTreeV3Specialization(9, "warrior")],
    [{ type: "ACTIVATE_SPECIALIZATION", requestId: U1, expectedRevision: 9, specializationId: "warrior" }],
    [U1]
  ),
  row(
    "equipSkillTreeV3GeneralActive",
    (client) => [client.equipSkillTreeV3GeneralActive(10, 2, "cleanse")],
    [{ type: "EQUIP_GENERAL_ACTIVE", requestId: U1, expectedRevision: 10, slot: 2, skillId: "cleanse" }],
    [U1]
  ),
  row(
    "useSkillTreeV3GeneralActive",
    (client) => [client.useSkillTreeV3GeneralActive(11, "cleanse", { targetEntityId: "player-2", targetMode: "friendly" })],
    [{ type: "USE_GENERAL_ACTIVE", requestId: U1, expectedRevision: 11, skillId: "cleanse", targetEntityId: "player-2", targetMode: "friendly" }],
    [U1]
  ),
  row(
    "adjustOwnDevProgression",
    (client) => [client.adjustOwnDevProgression("character_level", 9)],
    [{
      type: "ADJUST_OWN_DEV_PROGRESSION",
      operationId: U1,
      progressionType: "character_level",
      targetRank: 9
    }],
    [true]
  ),
  row(
    "setOwnDevSubclassUnlock",
    (client) => [client.setOwnDevSubclassUnlock("reaver", true)],
    [{
      type: "SET_OWN_DEV_SUBCLASS_UNLOCK",
      operationId: U1,
      subclassId: "reaver",
      unlocked: true
    }],
    [true]
  ),
  row(
    "updateClassLoadout",
    (client) => [client.updateClassLoadout(LOADOUT)],
    [{
      type: "UPDATE_CLASS_LOADOUT",
      requestId: U1,
      loadout: {
        resetActives: ["reset-one", null],
        normalActives: ["normal-one", null],
        passiveTiers: ["passive-zero", null, "passive-twenty"],
        ultimateActive: null
      }
    }],
    [true]
  ),
  row(
    "activateSubclass",
    (client) => [
      client.activateSubclass(null),
      client.activateSubclass("warden")
    ],
    [
      { type: "ACTIVATE_SUBCLASS", requestId: U1, subclassId: null },
      { type: "ACTIVATE_SUBCLASS", requestId: U2, subclassId: "warden" }
    ],
    [true, true]
  ),
  row(
    "activateClass",
    (client) => [client.activateClass("warrior")],
    [{ type: "ACTIVATE_CLASS", requestId: U1, classId: "warrior" }],
    [true]
  ),
  row(
    "useNormalAbility",
    (client) => [
      client.useNormalAbility("ability-1"),
      client.useNormalAbility("ability-2", "mob-1", "hostile", { lat: 35.1, lon: -106.6 })
    ],
    [
      { type: "USE_NORMAL_ABILITY", requestId: U1, abilityId: "ability-1" },
      {
        type: "USE_NORMAL_ABILITY",
        requestId: U2,
        abilityId: "ability-2",
        targetEntityId: "mob-1",
        targetMode: "hostile",
        targetPosition: { lat: 35.1, lon: -106.6 }
      }
    ],
    [true, true]
  ),
  row(
    "useResetAbility",
    (client) => [
      client.useResetAbility("reset-1"),
      client.useResetAbility("reset-2", "player-2", "friendly")
    ],
    [
      { type: "USE_RESET_ABILITY", requestId: U1, abilityId: "reset-1" },
      {
        type: "USE_RESET_ABILITY",
        requestId: U2,
        abilityId: "reset-2",
        targetEntityId: "player-2",
        targetMode: "friendly"
      }
    ],
    [true, true]
  ),
  row(
    "useUniversalTaunt",
    (client) => [client.useUniversalTaunt()],
    [{ type: "USE_UNIVERSAL_TAUNT", requestId: U1 }],
    [true]
  ),
  row(
    "equipItem",
    (client) => [
      client.equipItem("instance-1", "melee"),
      client.equipItem("instance-2", "secondary", "equip-2")
    ],
    [
      {
        type: "EQUIP_ITEM",
        requestId: U1,
        instanceId: "instance-1",
        slot: "melee"
      },
      {
        type: "EQUIP_ITEM",
        requestId: "equip-2",
        instanceId: "instance-2",
        slot: "secondary"
      }
    ],
    [U1, "equip-2"]
  ),
  row(
    "unequipItem",
    (client) => [
      client.unequipItem("instance-1"),
      client.unequipItem("instance-2", "unequip-2")
    ],
    [
      { type: "UNEQUIP_ITEM", requestId: U1, instanceId: "instance-1" },
      {
        type: "UNEQUIP_ITEM",
        requestId: "unequip-2",
        instanceId: "instance-2"
      }
    ],
    [U1, "unequip-2"]
  ),
  row(
    "upgradeEquipment",
    (client) => [
      client.upgradeEquipment(
        "instance-1",
        0,
        "upgrade-1",
        "95000000-0000-4000-8000-000000000004",
        4
      ),
      client.upgradeEquipment(
        "instance-2",
        3,
        "upgrade-2",
        "95000000-0000-4000-8000-000000000004",
        5
      )
    ],
    [
      {
        type: "UPGRADE_EQUIPMENT",
        requestId: "upgrade-1",
        instanceId: "instance-1",
        expectedLevel: 0,
        manorSessionId: "95000000-0000-4000-8000-000000000004",
        manorMovementSequence: 4
      },
      {
        type: "UPGRADE_EQUIPMENT",
        requestId: "upgrade-2",
        instanceId: "instance-2",
        expectedLevel: 3,
        manorSessionId: "95000000-0000-4000-8000-000000000004",
        manorMovementSequence: 5
      }
    ],
    ["upgrade-1", "upgrade-2"]
  ),
  row(
    "saveCombatKit",
    (client) => [
      client.saveCombatKit(1, 4),
      client.saveCombatKit(2, 5, "save-2")
    ],
    [
      {
        type: "SAVE_COMBAT_KIT",
        requestId: U1,
        kitIndex: 1,
        expectedInventoryRevision: 4
      },
      {
        type: "SAVE_COMBAT_KIT",
        requestId: "save-2",
        kitIndex: 2,
        expectedInventoryRevision: 5
      }
    ],
    [U1, "save-2"]
  ),
  row(
    "renameCombatKit",
    (client) => [
      client.renameCombatKit(1, "Alpha"),
      client.renameCombatKit(2, "Beta", "rename-2")
    ],
    [
      {
        type: "RENAME_COMBAT_KIT",
        requestId: U1,
        kitIndex: 1,
        name: "Alpha"
      },
      {
        type: "RENAME_COMBAT_KIT",
        requestId: "rename-2",
        kitIndex: 2,
        name: "Beta"
      }
    ],
    [U1, "rename-2"]
  ),
  row(
    "clearCombatKit",
    (client) => [
      client.clearCombatKit(1, 4),
      client.clearCombatKit(2, 5, "clear-2")
    ],
    [
      {
        type: "CLEAR_COMBAT_KIT",
        requestId: U1,
        kitIndex: 1,
        expectedInventoryRevision: 4
      },
      {
        type: "CLEAR_COMBAT_KIT",
        requestId: "clear-2",
        kitIndex: 2,
        expectedInventoryRevision: 5
      }
    ],
    [U1, "clear-2"]
  ),
  row(
    "activateCombatKit",
    (client) => [
      client.activateCombatKit(1, 4),
      client.activateCombatKit(2, 5, "activate-kit-2")
    ],
    [
      {
        type: "ACTIVATE_COMBAT_KIT",
        requestId: U1,
        kitIndex: 1,
        expectedInventoryRevision: 4
      },
      {
        type: "ACTIVATE_COMBAT_KIT",
        requestId: "activate-kit-2",
        kitIndex: 2,
        expectedInventoryRevision: 5
      }
    ],
    [U1, "activate-kit-2"]
  ),
  row(
    "toggleReadiedWeapon",
    (client) => [
      client.toggleReadiedWeapon("melee", 4),
      client.toggleReadiedWeapon("secondary", 5, "ready-2")
    ],
    [
      {
        type: "TOGGLE_READIED_WEAPON",
        requestId: U1,
        readiedWeaponSlot: "melee",
        expectedInventoryRevision: 4
      },
      {
        type: "TOGGLE_READIED_WEAPON",
        requestId: "ready-2",
        readiedWeaponSlot: "secondary",
        expectedInventoryRevision: 5
      }
    ],
    [U1, "ready-2"]
  ),
  row(
    "createParty",
    (client) => [client.createParty()],
    [{ type: "CREATE_PARTY", requestId: U1 }],
    [true]
  ),
  row(
    "invitePartyMember",
    (client) => [client.invitePartyMember("player-2")],
    [{
      type: "ADD_PARTY_MEMBER",
      requestId: U1,
      targetPlayerId: "player-2"
    }],
    [true]
  ),
  row(
    "acceptPartyInvite",
    (client) => [client.acceptPartyInvite("00000000-0000-4000-8000-000000000001")],
    [{ type: "ACCEPT_PARTY_INVITE", requestId: U1, invitationId: "00000000-0000-4000-8000-000000000001" }],
    [true]
  ),
  row(
    "acceptPartyInviteRequest",
    (client) => [client.acceptPartyInviteRequest("00000000-0000-4000-8000-000000000001")],
    [{
      type: "ACCEPT_PARTY_INVITE",
      requestId: U1,
      invitationId: "00000000-0000-4000-8000-000000000001"
    }],
    [U1]
  ),
  row(
    "forwardPartyInvite",
    (client) => [client.forwardPartyInvite("00000000-0000-4000-8000-000000000001")],
    [{ type: "FORWARD_PARTY_INVITE", requestId: U1, invitationId: "00000000-0000-4000-8000-000000000001" }],
    [true]
  ),
  row(
    "forwardPartyInviteRequest",
    (client) => [client.forwardPartyInviteRequest("00000000-0000-4000-8000-000000000001")],
    [{
      type: "FORWARD_PARTY_INVITE",
      requestId: U1,
      invitationId: "00000000-0000-4000-8000-000000000001"
    }],
    [U1]
  ),
  row(
    "declinePartyInvite",
    (client) => [client.declinePartyInvite("00000000-0000-4000-8000-000000000001")],
    [{ type: "DECLINE_PARTY_INVITE", requestId: U1, invitationId: "00000000-0000-4000-8000-000000000001" }],
    [true]
  ),
  row(
    "declinePartyInviteRequest",
    (client) => [client.declinePartyInviteRequest("00000000-0000-4000-8000-000000000001")],
    [{
      type: "DECLINE_PARTY_INVITE",
      requestId: U1,
      invitationId: "00000000-0000-4000-8000-000000000001"
    }],
    [U1]
  ),
  row(
    "cancelPartyInvite",
    (client) => [client.cancelPartyInvite("00000000-0000-4000-8000-000000000001")],
    [{
      type: "CANCEL_PARTY_INVITE",
      requestId: U1,
      invitationId: "00000000-0000-4000-8000-000000000001"
    }],
    [true]
  ),
  row(
    "cancelPartyInviteRequest",
    (client) => [client.cancelPartyInviteRequest("00000000-0000-4000-8000-000000000001")],
    [{
      type: "CANCEL_PARTY_INVITE",
      requestId: U1,
      invitationId: "00000000-0000-4000-8000-000000000001"
    }],
    [U1]
  ),
  row(
    "setPartyTravelAllowed",
    (client) => [client.setPartyTravelAllowed(true)],
    [{ type: "SET_PARTY_TRAVEL_ALLOWED", requestId: U1, allowed: true }],
    [true]
  ),
  row(
    "setPartyAutoFollow",
    (client) => [client.setPartyAutoFollow(false)],
    [{ type: "SET_PARTY_AUTO_FOLLOW", requestId: U1, enabled: false }],
    [true]
  ),
  row(
    "removePartyMember",
    (client) => [client.removePartyMember("player-2")],
    [{
      type: "REMOVE_PARTY_MEMBER",
      requestId: U1,
      targetPlayerId: "player-2"
    }],
    [true]
  ),
  row(
    "leaveParty",
    (client) => [client.leaveParty()],
    [{ type: "LEAVE_PARTY", requestId: U1 }],
    [true]
  ),
  row(
    "changePartyLeader",
    (client) => [client.changePartyLeader("player-2")],
    [{
      type: "CHANGE_PARTY_LEADER",
      requestId: U1,
      targetPlayerId: "player-2"
    }],
    [true]
  ),
  row(
    "selectChatChannel",
    (client) => [
      client.selectChatChannel("general"),
      client.selectChatChannel("trading", 44)
    ],
    [
      {
        type: "CHAT_SELECT_CHANNEL",
        requestId: U1,
        channelKey: "general"
      },
      {
        type: "CHAT_SELECT_CHANNEL",
        requestId: U2,
        channelKey: "trading",
        afterSequence: 44
      }
    ],
    [U1, U2]
  ),
  row(
    "requestChatBootstrap",
    (client) => [client.requestChatBootstrap()],
    [{ type: "REQUEST_CHAT_BOOTSTRAP" }],
    [true]
  ),
  row(
    "sendChatMessage",
    (client) => [
      client.sendChatMessage("general", "hello"),
      client.sendChatMessage("trading", "again", "chat-2")
    ],
    [
      {
        type: "CHAT_SEND",
        requestId: U1,
        channelKey: "general",
        body: "hello"
      },
      {
        type: "CHAT_SEND",
        requestId: "chat-2",
        channelKey: "trading",
        body: "again"
      }
    ],
    [U1, "chat-2"]
  ),
  row(
    "bootstrapDirectMessages",
    (client) => [
      client.bootstrapDirectMessages(),
      client.bootstrapDirectMessages("80")
    ],
    [
      { type: "DM_BOOTSTRAP", requestId: U1 },
      {
        type: "DM_BOOTSTRAP",
        requestId: U2,
        afterEventSequence: "80"
      }
    ],
    [U1, U2]
  ),
  row(
    "listDirectMessages",
    (client) => [
      client.listDirectMessages(),
      client.listDirectMessages("cursor_2", "Ash", 10)
    ],
    [
      { type: "DM_LIST", requestId: U1, cursor: null, limit: 25 },
      {
        type: "DM_LIST",
        requestId: U2,
        cursor: "cursor_2",
        search: "Ash",
        limit: 10
      }
    ],
    [U1, U2]
  ),
  row(
    "openDirectMessage",
    (client) => [client.openDirectMessage("player-2")],
    [{ type: "DM_OPEN", requestId: U1, peerPlayerId: "player-2" }],
    [U1]
  ),
  row(
    "requestDirectMessageHistory",
    (client) => [
      client.requestDirectMessageHistory("conversation-1", null),
      client.requestDirectMessageHistory("conversation-2", "50", 10)
    ],
    [
      {
        type: "DM_HISTORY",
        requestId: U1,
        conversationId: "conversation-1",
        beforeSequence: null,
        limit: 50
      },
      {
        type: "DM_HISTORY",
        requestId: U2,
        conversationId: "conversation-2",
        beforeSequence: "50",
        limit: 10
      }
    ],
    [U1, U2]
  ),
  row(
    "sendDirectMessage",
    (client) => [
      client.sendDirectMessage("conversation-1", "client-message-1", "hello")
    ],
    [{
      type: "DM_SEND",
      requestId: U1,
      conversationId: "conversation-1",
      clientMessageId: "client-message-1",
      body: "hello"
    }],
    [U1]
  ),
  row(
    "updateDirectMessageRead",
    (client) => [client.updateDirectMessageRead("conversation-1", "8")],
    [{
      type: "DM_READ",
      requestId: U1,
      conversationId: "conversation-1",
      throughSequence: "8"
    }],
    [U1]
  ),
  row(
    "acknowledgeDirectMessageDelivery",
    (client) => [
      client.acknowledgeDirectMessageDelivery("conversation-1", "8")
    ],
    [{
      type: "DM_DELIVERED",
      requestId: U1,
      conversationId: "conversation-1",
      throughSequence: "8"
    }],
    [true]
  ),
  row(
    "setDirectMessageMute",
    (client) => [client.setDirectMessageMute("conversation-1", true)],
    [{
      type: "DM_MUTE",
      requestId: U1,
      conversationId: "conversation-1",
      muted: true
    }],
    [true]
  ),
  row(
    "setDirectMessagePreferences",
    (client) => [client.setDirectMessagePreferences(DM_PREFERENCES)],
    [{
      type: "DM_PREFERENCES",
      requestId: U1,
      preferences: DM_PREFERENCES
    }],
    [true]
  ),
  row(
    "syncDirectMessages",
    (client) => [
      client.syncDirectMessages("80"),
      client.syncDirectMessages("90", 25)
    ],
    [
      {
        type: "DM_SYNC",
        requestId: U1,
        afterEventSequence: "80",
        limit: 100
      },
      {
        type: "DM_SYNC",
        requestId: U2,
        afterEventSequence: "90",
        limit: 25
      }
    ],
    [U1, U2]
  ),
  row(
    "acknowledgeDirectMessageEvents",
    (client) => [client.acknowledgeDirectMessageEvents("90")],
    [{
      type: "DM_EVENT_ACK",
      requestId: U1,
      throughEventSequence: "90"
    }],
    [true]
  ),
  row(
    "requestChatHistory",
    (client) => [
      client.requestChatHistory("general", "older", null),
      client.requestChatHistory("local", "newer", 44, 10)
    ],
    [
      {
        type: "CHAT_HISTORY_REQUEST",
        requestId: U1,
        channelKey: "general",
        direction: "older",
        cursorSequence: null,
        limit: 50
      },
      {
        type: "CHAT_HISTORY_REQUEST",
        requestId: U2,
        channelKey: "local",
        direction: "newer",
        cursorSequence: 44,
        limit: 10
      }
    ],
    [U1, U2]
  ),
  row(
    "updateChatRead",
    (client) => [client.updateChatRead("general", 44)],
    [{
      type: "CHAT_READ_UPDATE",
      requestId: U1,
      channelKey: "general",
      lastReadSequence: 44
    }],
    [true]
  ),
  row(
    "enterSalon",
    (client) => [client.enterSalon("salon-1", "placement-7")],
    [{
      type: "USE_PORTAL",
      requestId: U1,
      portalId: "salon:salon-1:world-to-main",
      expectedLocationRevision: 0,
      expectedPortalRevision: "placement-7"
    }],
    [U1]
  ),
  row(
    "salonMoveTo",
    (client) => [client.salonMoveTo("salon-session-1", 4, 5)],
    [{
      type: "SALON_MOVE_TO",
      requestId: U1,
      salonSessionId: "salon-session-1",
      x: 4,
      y: 5
    }],
    [U1]
  ),
  row(
    "beginSalonCustomize",
    (client) => [client.beginSalonCustomize("salon-session-1", 8)],
    [{
      type: "BEGIN_SALON_CUSTOMIZE",
      requestId: U1,
      salonSessionId: "salon-session-1",
      movementSequence: 8
    }],
    [U1]
  ),
  row(
    "saveSalonAppearance",
    (client) => [client.saveSalonAppearance({
      editorSessionId: "editor-1",
      expectedAppearanceRevision: 3,
      catalogRevision: 11,
      changes: { hair: "hair-short" }
    })],
    [{
      type: "SAVE_SALON_APPEARANCE",
      requestId: U1,
      editorSessionId: "editor-1",
      expectedAppearanceRevision: 3,
      catalogRevision: 11,
      changes: { hair: "hair-short" }
    }],
    [U1]
  ),
  row(
    "cancelSalonCustomize",
    (client) => [client.cancelSalonCustomize("editor-1")],
    [{
      type: "CANCEL_SALON_CUSTOMIZE",
      requestId: U1,
      editorSessionId: "editor-1"
    }],
    [U1]
  ),
  row(
    "exitSalon",
    (client) => {
      client.portals.installLocation({
        kind: "interior",
        locationType: "salon",
        locationId: "salon-1",
        instanceId: "salon:salon-1",
        spaceId: "salon_main_room",
        regionCode: "interior:salon:salon-1",
        zoneId: "interior:salon:salon-1:salon_main_room",
        position: { x: 4, y: 5 },
        revision: 7,
        lastPortalId: "salon:salon-1:world-to-main"
      });
      return [client.exitSalon("salon-session-1")];
    },
    [{
      type: "USE_PORTAL",
      requestId: U1,
      portalId: "salon:salon-1:main-to-world",
      expectedLocationRevision: 7
    }],
    [U1]
  ),
  row(
    "requestDungeonEntrances",
    (client) => [client.requestDungeonEntrances()],
    [{ type: "REQUEST_DUNGEON_ENTRANCES", requestId: U1 }],
    [U1]
  ),
  row(
    "dungeonMoveTo",
    (client) => [client.dungeonMoveTo("dungeon-session-1", 8, 9)],
    [{
      type: "DUNGEON_MOVE_TO",
      requestId: U1,
      sessionId: "dungeon-session-1",
      x: 8,
      y: 9
    }],
    [U1]
  ),
  row(
    "usePortal",
    (client) => [
      client.usePortal("portal-1"),
      client.usePortal("portal-2", "portal-revision-2")
    ],
    [{
      type: "USE_PORTAL",
      requestId: U1,
      portalId: "portal-1",
      expectedLocationRevision: 0
    }, {
      type: "USE_PORTAL",
      requestId: U2,
      portalId: "portal-2",
      expectedLocationRevision: 0,
      expectedPortalRevision: "portal-revision-2"
    }],
    [U1, U2]
  ),
  row(
    "portalDestinationReady",
    (client) => [client.portalDestinationReady("transition-1", "scene-1")],
    [{
      type: "PORTAL_DESTINATION_READY",
      transitionId: "transition-1",
      sceneKey: "scene-1"
    }],
    [true],
    0
  ),
  row(
    "cancelPortalTransition",
    (client) => {
      client.portals.notePlan("portal-request-1", "transition-1");
      return [client.cancelPortalTransition()];
    },
    [{
      type: "CANCEL_PORTAL_TRANSITION",
      requestId: U1,
      transitionId: "transition-1"
    }],
    [true]
  ),
  row(
    "cancelWorldMapTravel",
    (client) => [client.cancelWorldMapTravel("world-map-request-1")],
    [{ type: "CANCEL_WORLD_MAP_TRAVEL", requestId: "world-map-request-1" }],
    [true],
    0
  ),
  row(
    "buildOilWell",
    (client) => [client.buildOilWell("city-1")],
    [{ type: "BUILD_OIL_WELL", requestId: U1, cityId: "city-1" }],
    [U1]
  ),
  row(
    "openOilWell",
    (client) => [client.openOilWell("oil-well-1")],
    [{ type: "OPEN_OIL_WELL", requestId: U1, structureId: "oil-well-1" }],
    [U1]
  ),
  row(
    "harvestOilWell",
    (client) => [client.harvestOilWell("oil-well-1")],
    [{ type: "HARVEST_OIL_WELL", requestId: U1, structureId: "oil-well-1" }],
    [U1]
  ),
  row(
    "openLibrary",
    (client) => [client.openLibrary("library-1")],
    [{ type: "OPEN_LIBRARY", requestId: U1, structureId: "library-1" }],
    [U1]
  ),
  row(
    "studyLibrary",
    (client) => [client.studyLibrary("library-1")],
    [{ type: "STUDY_LIBRARY", requestId: U1, structureId: "library-1" }],
    [U1]
  ),
  row(
    "destroyOilWell",
    (client) => [client.destroyOilWell("oil-well-1", "placement-4")],
    [{
      type: "DESTROY_OIL_WELL",
      requestId: U1,
      structureId: "oil-well-1",
      expectedPlacementRevision: "placement-4"
    }],
    [true]
  ),
  row(
    "donateCityGold",
    (client) => [client.donateCityGold("warehouse-1", "25")],
    [{
      type: "DONATE_CITY_GOLD",
      requestId: U1,
      structureId: "warehouse-1",
      amount: "25"
    }],
    [U1]
  ),
  row(
    "visitCityMarket",
    (client) => [client.visitCityMarket("market-1", "placement-5")],
    [{
      type: "VISIT_CITY_MARKET",
      requestId: U1,
      structureId: "market-1",
      expectedPlacementRevision: "placement-5"
    }],
    [U1]
  ),
  row(
    "inviteToParty",
    (client) => [client.inviteToParty("player-2")],
    [{ type: "INVITE_TO_PARTY", requestId: U1, targetPlayerId: "player-2" }],
    [true]
  ),
  row(
    "disbandParty",
    (client) => [client.disbandParty()],
    [{ type: "DISBAND_PARTY", requestId: U1 }],
    [true]
  ),
  row(
    "requestPartyCombatSnapshot",
    (client) => [client.requestPartyCombatSnapshot()],
    [{ type: "REQUEST_PARTY_COMBAT_SNAPSHOT", requestId: U1 }],
    [true]
  ),
  row(
    "startPartyReadyCheck",
    (client) => [client.startPartyReadyCheck()],
    [{ type: "START_PARTY_READY_CHECK", requestId: U1 }],
    [true]
  ),
  row(
    "respondPartyReadyCheck",
    (client) => [client.respondPartyReadyCheck("ready-check-1", "ready")],
    [{
      type: "RESPOND_PARTY_READY_CHECK",
      requestId: U1,
      readyCheckId: "ready-check-1",
      response: "ready"
    }],
    [true]
  ),
  row(
    "cancelPartyReadyCheck",
    (client) => [client.cancelPartyReadyCheck("ready-check-1")],
    [{
      type: "CANCEL_PARTY_READY_CHECK",
      requestId: U1,
      readyCheckId: "ready-check-1"
    }],
    [true]
  ),
  row(
    "marketBrowse",
    (client) => [client.marketBrowse("browse-1", MARKET_SESSION_ID, {
      search: "sword",
      category: "equipment",
      cursor: "cursor-1",
      limit: 25
    })],
    [{
      type: "MARKET_BROWSE",
      requestId: "browse-1",
      marketSessionId: MARKET_SESSION_ID,
      search: "sword",
      category: "equipment",
      cursor: "cursor-1",
      limit: 25
    }],
    [true],
    0
  ),
  row(
    "buildCityMarket",
    (client) => [client.buildCityMarket("city-1", "city-revision-2")],
    [{
      type: "BUILD_CITY_MARKET",
      requestId: U1,
      cityId: "city-1",
      expectedCityRevision: "city-revision-2"
    }],
    [U1]
  ),
  row(
    "buildCityMonument",
    (client) => [client.buildCityMonument(
      "city-1",
      "hunting",
      "city-revision-2",
      "district-revision-3"
    )],
    [{
      type: "BUILD_CITY_MONUMENT",
      requestId: U1,
      cityId: "city-1",
      districtType: "hunting",
      expectedCityRevision: "city-revision-2",
      expectedDistrictRevision: "district-revision-3"
    }],
    [U1]
  ),
  row(
    "upgradeCityMonument",
    (client) => [client.upgradeCityMonument(
      "monument-1",
      1,
      "placement-revision-4",
      "district-revision-3"
    )],
    [{
      type: "UPGRADE_CITY_MONUMENT",
      requestId: U1,
      structureId: "monument-1",
      expectedTier: 1,
      expectedPlacementRevision: "placement-revision-4",
      expectedDistrictRevision: "district-revision-3"
    }],
    [U1]
  ),
  row(
    "destroyCityMonument",
    (client) => [client.destroyCityMonument(
      "monument-1",
      "placement-revision-4",
      "district-revision-3"
    )],
    [{
      type: "DESTROY_CITY_MONUMENT",
      requestId: U1,
      structureId: "monument-1",
      expectedPlacementRevision: "placement-revision-4",
      expectedDistrictRevision: "district-revision-3"
    }],
    [true]
  ),
  row(
    "marketCreateEquipmentListing",
    (client) => [client.marketCreateEquipmentListing(
      "listing-create-1",
      MARKET_SESSION_ID,
      "equipment-1",
      "150",
      "7"
    )],
    [{
      type: "MARKET_CREATE_EQUIPMENT_LISTING",
      requestId: "listing-create-1",
      marketSessionId: MARKET_SESSION_ID,
      equipmentInstanceId: "equipment-1",
      askingPrice: "150",
      expectedEquipmentRevision: "7"
    }],
    [true],
    0
  ),
  row(
    "marketPurchaseEquipmentListing",
    (client) => [client.marketPurchaseEquipmentListing(
      "listing-purchase-1",
      MARKET_SESSION_ID,
      "listing-1",
      "2",
      "180",
      "4",
      "glimmer"
    )],
    [{
      type: "MARKET_PURCHASE_EQUIPMENT_LISTING",
      requestId: "listing-purchase-1",
      marketSessionId: MARKET_SESSION_ID,
      listingId: "listing-1",
      expectedPriceCurrency: "glimmer",
      expectedListingVersion: "2",
      maximumBuyerTotal: "180",
      expectedTaxRevision: "4"
    }],
    [true],
    0
  ),
  row(
    "marketCancelEquipmentListing",
    (client) => [client.marketCancelEquipmentListing(
      "listing-cancel-1",
      MARKET_SESSION_ID,
      "listing-1",
      "2"
    )],
    [{
      type: "MARKET_CANCEL_EQUIPMENT_LISTING",
      requestId: "listing-cancel-1",
      marketSessionId: MARKET_SESSION_ID,
      listingId: "listing-1",
      expectedListingVersion: "2"
    }],
    [true],
    0
  ),
  row(
    "marketOpen",
    (client) => [
      client.marketOpen("market-open-1", MARKET_STRUCTURE_ID, "1"),
      client.marketOpen("market-open-2", MARKET_STRUCTURE_ID, "2")
    ],
    [
      {
        type: "MARKET_OPEN",
        requestId: "market-open-1",
        marketStructureId: MARKET_STRUCTURE_ID,
        expectedPlacementRevision: "1"
      },
      {
        type: "MARKET_OPEN",
        requestId: "market-open-2",
        marketStructureId: MARKET_STRUCTURE_ID,
        expectedPlacementRevision: "2"
      }
    ],
    [true, true],
    0
  ),
  row(
    "marketGetBook",
    (client) => [
      client.marketGetBook("market-book-1", MARKET_SESSION_ID, "wood"),
      client.marketGetBook("market-book-2", MARKET_SESSION_ID, "stone", 20)
    ],
    [
      {
        type: "MARKET_GET_BOOK",
        requestId: "market-book-1",
        marketSessionId: MARKET_SESSION_ID,
        itemIdentity: "wood"
      },
      {
        type: "MARKET_GET_BOOK",
        requestId: "market-book-2",
        marketSessionId: MARKET_SESSION_ID,
        itemIdentity: "stone",
        depth: 20
      }
    ],
    [true, true],
    0
  ),
  row(
    "marketRequestQuote",
    (client) => [client.marketRequestQuote("quote-1", MARKET_SESSION_ID, "wood", "3", "10")],
    [{
      type: "MARKET_REQUEST_QUOTE",
      requestId: "quote-1",
      marketSessionId: MARKET_SESSION_ID,
      itemIdentity: "wood",
      quantity: "3",
      maximumUnitPrice: "10"
    }],
    [true],
    0
  ),
  row(
    "marketCreateOrder",
    (client) => [
      client.marketCreateOrder(
        "order-1",
        MARKET_SESSION_ID,
        "merchant",
        "sell",
        "wood",
        "3",
        "10"
      )
    ],
    [{
      type: "MARKET_CREATE_ORDER",
      requestId: "order-1",
      marketSessionId: MARKET_SESSION_ID,
      interface: "merchant",
      side: "sell",
      itemIdentity: "wood",
      quantity: "3",
      unitPrice: "10"
    }],
    [true],
    0
  ),
  row(
    "marketSimpleBuy",
    (client) => [client.marketSimpleBuy("buy-1", MARKET_SESSION_ID, "quote-1", "30")],
    [{
      type: "MARKET_SIMPLE_BUY",
      requestId: "buy-1",
      marketSessionId: MARKET_SESSION_ID,
      quoteId: "quote-1",
      maximumTotal: "30"
    }],
    [true],
    0
  ),
  row(
    "marketCancelOrder",
    (client) => [client.marketCancelOrder("cancel-1", MARKET_SESSION_ID, "order-1")],
    [{
      type: "MARKET_CANCEL_ORDER",
      requestId: "cancel-1",
      marketSessionId: MARKET_SESSION_ID,
      orderId: "order-1"
    }],
    [true],
    0
  ),
  row(
    "marketClaim",
    (client) => [client.marketClaim("claim-1", MARKET_SESSION_ID, "all")],
    [{ type: "MARKET_CLAIM", requestId: "claim-1", marketSessionId: MARKET_SESSION_ID, scope: "all" }],
    [true],
    0
  ),
  row(
    "marketSetSubscriptions",
    (client) => [
      client.marketSetSubscriptions(
        "subscriptions-1",
        MARKET_SESSION_ID,
        ["wood", "stone"],
        "wood",
        true,
        7
      )
    ],
    [{
      type: "MARKET_SET_SUBSCRIPTIONS",
      requestId: "subscriptions-1",
      marketSessionId: MARKET_SESSION_ID,
      visibleItemIdentities: ["wood", "stone"],
      focusedItemIdentity: "wood",
      privateState: true,
      revision: 7
    }],
    [true],
    0
  ),
  row(
    "setWorldMapSocialVisibility",
    (client) => [client.setWorldMapSocialVisibility("friends", true)],
    [{ type: "SET_WORLD_MAP_SOCIAL_VISIBILITY", requestId: U1, audience: "friends", visible: true }],
    [true]
  ),
  row(
    "buildMilitaryFacility",
    (client) => [client.buildMilitaryFacility("city-1", "barracks")],
    [{ type: "BUILD_MILITARY_FACILITY", requestId: U1, cityId: "city-1", facilityType: "barracks" }],
    [U1]
  ),
  row(
    "buildLodge",
    (client) => [client.buildLodge()],
    [{ type: "BUILD_LODGE", requestId: U1 }],
    [U1]
  ),
  row(
    "upgradeLodge",
    (client) => [client.upgradeLodge(2)],
    [{ type: "UPGRADE_LODGE", requestId: U1, expectedLevel: 2 }],
    [U1]
  ),
  row(
    "destroyLodge",
    (client) => [client.destroyLodge()],
    [{ type: "DESTROY_LODGE", requestId: U1 }],
    [true]
  ),
  row(
    "requestMilitaryIndustry",
    (client) => [client.requestMilitaryIndustry()],
    [{ type: "REQUEST_MILITARY_INDUSTRY", requestId: U1 }],
    [U1]
  ),
  row(
    "trainSiegeCrew",
    (client) => [client.trainSiegeCrew("barracks-1")],
    [{ type: "TRAIN_SIEGE_CREW", requestId: U1, facilityStructureId: "barracks-1" }],
    [U1]
  ),
  row(
    "trainMilitaryUnit",
    (client) => [client.trainMilitaryUnit("barracks-1", "infantry")],
    [{ type: "TRAIN_MILITARY_UNIT", requestId: U1, facilityStructureId: "barracks-1", unitType: "infantry" }],
    [U1]
  ),
  row(
    "manufactureFieldBallista",
    (client) => [client.manufactureFieldBallista("barracks-1")],
    [{ type: "MANUFACTURE_FIELD_BALLISTA", requestId: U1, facilityStructureId: "barracks-1" }],
    [U1]
  ),
  row(
    "startMilitaryProduction",
    (client) => [client.startMilitaryProduction("barracks-1", "repair_kit_batch", 2)],
    [{ type: "START_MILITARY_PRODUCTION", requestId: U1, facilityStructureId: "barracks-1", production: "repair_kit_batch", quantity: 2 }],
    [U1]
  ),
  row(
    "combineMilitaryGroups",
    (client) => [client.combineMilitaryGroups(["group-1", "group-2"])],
    [{ type: "COMBINE_MILITARY_GROUPS", requestId: U1, groupIds: ["group-1", "group-2"] }],
    [U1]
  ),
  row(
    "splitMilitaryGroup",
    (client) => [client.splitMilitaryGroup("group-1", [2, 3])],
    [{ type: "SPLIT_MILITARY_GROUP", requestId: U1, groupId: "group-1", splitSizes: [2, 3] }],
    [U1]
  ),
  row(
    "buildWarCamp",
    (client) => [client.buildWarCamp()],
    [{ type: "BUILD_WAR_CAMP", requestId: U1 }],
    [U1]
  ),
  row(
    "relocateWarCamp",
    (client) => [client.relocateWarCamp()],
    [{ type: "RELOCATE_WAR_CAMP", requestId: U1 }],
    [U1]
  ),
  row(
    "removeWarCamp",
    (client) => [client.removeWarCamp()],
    [{ type: "REMOVE_WAR_CAMP", requestId: U1 }],
    [U1]
  ),
  row(
    "callTroops",
    (client) => [client.callTroops()],
    [{ type: "CALL_TROOPS", requestId: U1 }],
    [U1]
  ),
  row(
    "followMilitaryGroup",
    (client) => [client.followMilitaryGroup("group-1")],
    [{ type: "FOLLOW_MILITARY_GROUP", requestId: U1, groupId: "group-1" }],
    [U1]
  ),
  row(
    "stayMilitaryGroup",
    (client) => [client.stayMilitaryGroup("group-1")],
    [{ type: "STAY_MILITARY_GROUP", requestId: U1, groupId: "group-1" }],
    [U1]
  ),
  row(
    "packUpMilitaryGroup",
    (client) => [client.packUpMilitaryGroup("group-1")],
    [{ type: "PACK_UP_MILITARY_GROUP", requestId: U1, groupId: "group-1" }],
    [U1]
  ),
  row(
    "deployMilitaryGroup",
    (client) => [client.deployMilitaryGroup("group-1", { lat: 35.1, lon: -106.6 })],
    [{ type: "DEPLOY_MILITARY_GROUP", requestId: U1, groupId: "group-1", position: { lat: 35.1, lon: -106.6 } }],
    [U1]
  ),
  row(
    "defendMilitaryGroup",
    (client) => [client.defendMilitaryGroup("group-1")],
    [{ type: "DEFEND_MILITARY_GROUP", requestId: U1, groupId: "group-1" }],
    [U1]
  ),
  row(
    "returnMilitaryGroup",
    (client) => [client.returnMilitaryGroup("group-1")],
    [{ type: "RETURN_MILITARY_GROUP", requestId: U1, groupId: "group-1" }],
    [U1]
  ),
  row(
    "stopMilitaryGroup",
    (client) => [client.stopMilitaryGroup("group-1")],
    [{ type: "STOP_MILITARY_GROUP", requestId: U1, groupId: "group-1" }],
    [U1]
  ),
  row(
    "moveMilitaryGroup",
    (client) => [client.moveMilitaryGroup("group-1", { lat: 35.1, lon: -106.6 })],
    [{ type: "MOVE_MILITARY_GROUP", requestId: U1, groupId: "group-1", position: { lat: 35.1, lon: -106.6 } }],
    [U1]
  ),
  row(
    "attackMilitaryGroup",
    (client) => [client.attackMilitaryGroup("group-1", "target-1")],
    [{ type: "ATTACK_MILITARY_GROUP", requestId: U1, groupId: "group-1", targetEntityId: "target-1" }],
    [U1]
  ),
  row(
    "attackMilitarySiege",
    (client) => [client.attackMilitarySiege("group-1")],
    [{ type: "ATTACK_MILITARY_SIEGE", requestId: U1, groupId: "group-1" }],
    [U1]
  ),
  row(
    "demolishFlag",
    (client) => [client.demolishFlag("group-1", "flag-1")],
    [{ type: "DEMOLISH_FLAG", requestId: U1, groupId: "group-1", targetFlagId: "flag-1" }],
    [U1]
  ),
  row(
    "fireBallistaVolley",
    (client) => [client.fireBallistaVolley("group-1", "flag-1")],
    [{ type: "FIRE_BALLISTA_VOLLEY", requestId: U1, groupId: "group-1", targetFlagId: "flag-1" }],
    [U1]
  ),
  row(
    "repairBallista",
    (client) => [client.repairBallista("ballista-1")],
    [{ type: "REPAIR_BALLISTA", requestId: U1, unitId: "ballista-1" }],
    [U1]
  ),
  row(
    "collectMilitaryJob",
    (client) => [client.collectMilitaryJob("job-1")],
    [{ type: "COLLECT_MILITARY_JOB", requestId: U1, jobId: "job-1" }],
    [U1]
  ),
  row(
    "spawnTestFlag",
    (client) => [client.spawnTestFlag("soft_flag", 35.1, -106.6)],
    [{ type: "DEV_SPAWN_TEST_FLAG", requestId: U1, targetKind: "soft_flag", lat: 35.1, lon: -106.6 }],
    [U1]
  ),
  row(
    "spawnTestUnit",
    (client) => [client.spawnTestUnit("infantry", 35.1, -106.6)],
    [{ type: "DEV_SPAWN_TEST_UNIT", requestId: U1, unitType: "infantry", lat: 35.1, lon: -106.6 }],
    [U1]
  ),
  row(
    "startFlagRepair",
    (client) => [client.startFlagRepair("flag-1", U1)],
    [{ type: "START_FLAG_REPAIR", requestId: U1, flagId: "flag-1" }],
    [U1],
    0
  ),
  row(
    "cancelFlagRepair",
    (client) => [client.cancelFlagRepair("flag-1", "repair-1", U1)],
    [{ type: "CANCEL_FLAG_REPAIR", requestId: U1, flagId: "flag-1", operationId: "repair-1" }],
    [true],
    0
  ),
  row(
    "startFlagRepairDisrupt",
    (client) => [client.startFlagRepairDisrupt("flag-1", "repair-1", U1)],
    [{ type: "START_FLAG_REPAIR_DISRUPT", requestId: U1, flagId: "flag-1", repairOperationId: "repair-1" }],
    [U1],
    0
  ),
  row(
    "cancelFlagRepairDisrupt",
    (client) => [client.cancelFlagRepairDisrupt("flag-1", "disrupt-1", U1)],
    [{ type: "CANCEL_FLAG_REPAIR_DISRUPT", requestId: U1, flagId: "flag-1", operationId: "disrupt-1" }],
    [true],
    0
  ),
  row(
    "useSimpleFood",
    (client) => [client.useSimpleFood("food-stack-1")],
    [{ type: "USE_CONSUMABLE", requestId: U1, itemId: "simple_food", stackId: "food-stack-1" }],
    [true]
  ),
  row(
    "useFieldConsumable",
    (client) => [client.useFieldConsumable("field_net", "net-stack-1", "mob:wolf")],
    [{ type: "USE_CONSUMABLE", requestId: U1, itemId: "field_net", stackId: "net-stack-1", targetEntityId: "mob:wolf" }],
    [true]
  ),
  row(
    "craftFieldConsumable",
    (client) => [client.craftFieldConsumable("ember_flask")],
    [{ type: "CRAFT_FIELD_CONSUMABLE", requestId: U1, itemId: "ember_flask" }],
    [true]
  ),
  row(
    "requestWaterSites",
    (client) => [client.requestWaterSites()],
    [{ type: "REQUEST_WATER_SITES", requestId: U1 }],
    [true]
  ),
  row(
    "waterSiteAction",
    (client) => [client.waterSiteAction("DIVE_PEARL_BED", "pearl:1:2")],
    [{ type: "DIVE_PEARL_BED", requestId: U1, siteId: "pearl:1:2" }],
    [U1]
  )
];

class FakeWebSocket {
  static readonly OPEN = 1;
  static instances: FakeWebSocket[] = [];

  readyState = 0;
  sent: string[] = [];
  sendError: Error | null = null;
  private readonly listeners = new Map<
    string,
    Array<(event: { data?: unknown; code?: number }) => void>
  >();

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  addEventListener(
    type: string,
    listener: (event: { data?: unknown; code?: number }) => void
  ): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(
    type: string,
    listener: (event: { data?: unknown; code?: number }) => void
  ): void {
    const listeners = this.listeners.get(type) ?? [];
    this.listeners.set(
      type,
      listeners.filter((candidate) => candidate !== listener)
    );
  }

  send(value: string): void {
    if (this.sendError) throw this.sendError;
    this.sent.push(value);
  }

  close(): void {
    this.readyState = 3;
  }

  emit(
    type: string,
    event: { data?: unknown; code?: number } = {}
  ): void {
    if (type === "open") this.readyState = FakeWebSocket.OPEN;
    if (type === "close") this.readyState = 3;
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

afterEach(() => {
  FakeWebSocket.instances = [];
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("GameClient public command equivalence matrix", () => {
  it("contains every actual public command method exactly once", () => {
    const sourceText = readFileSync(
      new URL("./gameClient.ts", import.meta.url),
      "utf8"
    );
    const source = ts.createSourceFile(
      "gameClient.ts",
      sourceText,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS
    );
    const gameClientClass = source.statements.find(
      (statement): statement is ts.ClassDeclaration =>
        ts.isClassDeclaration(statement) &&
        statement.name?.text === "GameClient"
    );
    expect(gameClientClass).toBeDefined();
    const actualMethods = gameClientClass!.members
      .filter(
        (member): member is ts.MethodDeclaration =>
          ts.isMethodDeclaration(member) &&
          ts.isIdentifier(member.name) &&
          !member.modifiers?.some(
            (modifier) => modifier.kind === ts.SyntaxKind.PrivateKeyword
          )
      )
      .map((member) => (member.name as ts.Identifier).text)
      .filter(
        (method) =>
          method !== "connect" &&
          method !== "disconnect" &&
          method !== "recoverIfNeeded" &&
          method !== "suspend" &&
          method !== "setNetworkOnline" &&
          method !== "markAuthoritativeBootstrapComplete" &&
          method !== "markAuthoritativeViewDegraded" &&
          method !== "markAuthoritativeViewPreparing" &&
          method !== "readinessState" &&
          method !== "currentConnectionGeneration" &&
          method !== "currentServerConnectionGeneration" &&
          method !== "craftRepairKit" &&
          method !== "deleteChatMessage" &&
          method !== "repairEquipment" &&
          method !== "socketState" &&
          method !== "submitBugReport" &&
          method !== "synchronizedNow" &&
          method !== "noteFrameForTelemetry" &&
          method !== "reconnectInPlace" &&
          method !== "recordStartupTerminal" &&
          method !== "materializeDungeonSnapshot" &&
          method !== "clearDungeonScene"
      )
      .sort();
    const matrixMethods = COMMAND_EQUIVALENCE_MATRIX
      .map(({ method }) => method)
      .sort();

    expect(new Set(matrixMethods).size).toBe(matrixMethods.length);
    expect(matrixMethods).toEqual(actualMethods);
  });

  it.each(COMMAND_EQUIVALENCE_MATRIX)(
    "$method preserves payload, defaults, returns, failure containment, and no replay",
    (command) => {
      const expectedFailure = command.success.map((value) =>
        typeof value === "string"
          ? null
          : value === true
            ? false
            : value && typeof value === "object" && "requestId" in value
              ? {
                  requestId: value.requestId,
                  outcome: { status: "intentionally-disconnected" }
                }
              : value
      );
      const expectedConnecting = command.success.map((value) =>
        value && typeof value === "object" && "requestId" in value
          ? {
              requestId: value.requestId,
              outcome: { status: "connecting" }
            }
          : typeof value === "string"
            ? null
            : value === true
              ? false
              : value
      );
      const expectedAttempts = (
        status:
          | "protocol-incompatible"
          | "send-failed",
        failure?: "serialization" | "transport"
      ) => command.success.map((value) =>
        value && typeof value === "object" && "requestId" in value
          ? {
              requestId: value.requestId,
              outcome: status === "send-failed"
                ? expect.objectContaining({ status, failure })
                : { status }
            }
          : typeof value === "string"
            ? null
            : value === true
              ? false
              : value
      );
      const expectedUuidCalls = command.expectedUuidCalls
        ?? highestUuidIndex(command.messages);

      {
        const randomUUID = stubEnvironment();
        const { client, socket } = openClient();
        socket.sent = [];
        expect(command.invoke(client)).toEqual(command.success);
        expect(socket.sent.map((message) => JSON.parse(message))).toEqual(
          command.messages
        );
        expect(randomUUID).toHaveBeenCalledTimes(expectedUuidCalls);
      }

      {
        const randomUUID = stubEnvironment();
        const client = new GameClient("ws://server", handlers());
        expect(command.invoke(client)).toEqual(expectedConnecting);
        expect(randomUUID).toHaveBeenCalledTimes(expectedUuidCalls);
        client.connect();
        const socket = FakeWebSocket.instances.at(-1)!;
        socket.emit("open");
        expect(socket.sent.map((message) => JSON.parse(message))).toEqual([
          { type: "HELLO" }
        ]);
      }

      {
        stubEnvironment();
        const { client, socket } = openClient();
        socket.sent = [];
        client.disconnect();
        expect(command.invoke(client)).toEqual(expectedFailure);
        expect(socket.sent).toEqual([]);
      }

      {
        stubEnvironment();
        const { client, socket } = openClient();
        socket.sent = [];
        const state = client as unknown as { protocolIncompatible: boolean };
        state.protocolIncompatible = true;
        expect(command.invoke(client)).toEqual(
          expectedAttempts("protocol-incompatible")
        );
        expect(socket.sent).toEqual([]);
      }

      {
        stubEnvironment();
        const onError = vi.fn();
        const { client, socket } = openClient(onError);
        socket.sent = [];
        const stringify = vi.spyOn(JSON, "stringify").mockImplementation(() => {
          throw new TypeError("serialization failed");
        });
        const result = command.invoke(client);
        stringify.mockRestore();
        expect(result).toEqual(expectedAttempts("send-failed", "serialization"));
        expect(socket.sent).toEqual([]);
        expect(onError).toHaveBeenCalledTimes(command.messages.length);
      }

      {
        stubEnvironment();
        const onError = vi.fn();
        const { client, socket } = openClient(onError);
        socket.sent = [];
        socket.sendError = new Error("send failed");
        expect(command.invoke(client)).toEqual(
          expectedAttempts("send-failed", "transport")
        );
        expect(socket.sent).toEqual([]);
        expect(onError).toHaveBeenCalledTimes(command.messages.length);
      }
    }
  );
});

function highestUuidIndex(messages: readonly ClientMessage[]): number {
  const matches = JSON.stringify(messages).match(
    /00000000-0000-4000-8000-(\d{12})/g
  ) ?? [];
  return matches.reduce((highest, value) => {
    const index = Number(value.slice(-12));
    return Math.max(highest, index);
  }, 0);
}

function stubEnvironment() {
  let requestId = 0;
  const randomUUID = vi.fn(() => uuid(++requestId));
  vi.stubGlobal("crypto", { randomUUID });
  vi.stubGlobal("WebSocket", FakeWebSocket);
  vi.stubGlobal("window", {
    setInterval: vi.fn(() => 1),
    clearInterval: vi.fn(),
    setTimeout: vi.fn(() => 2),
    clearTimeout: vi.fn()
  });
  return randomUUID;
}

function openClient(onError = vi.fn()) {
  const client = new GameClient("ws://server", {
    ...handlers(),
    onError
  });
  client.connect();
  const socket = FakeWebSocket.instances.at(-1)!;
  socket.emit("open");
  client.markAuthoritativeBootstrapComplete();
  return { client, socket };
}

function handlers() {
  return {
    onOpen: vi.fn(),
    onClose: vi.fn(),
    onMessage: vi.fn(),
    onError: vi.fn(),
    onSessionInvalid: vi.fn()
  };
}
