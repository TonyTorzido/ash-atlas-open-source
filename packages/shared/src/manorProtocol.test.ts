import { describe, expect, it } from "vitest";
import { MANOR_BUILD_DURATION_MS } from "./manor.js";
import { clientMessageSchema, parseClientMessage, parseServerMessage } from "./protocol.js";

const session = "11111111-1111-4111-8111-111111111111";
const manor = "22222222-2222-4222-8222-222222222222";

describe("manor protocol", () => {
  it("uses the shared 30-second player construction duration", () => {
    expect(MANOR_BUILD_DURATION_MS).toBe(30_000);
  });

  it("validates optional authoritative station placement suggestions", () => {
    const message = {
      type: "FURNACE_ERROR",
      requestId: "build-furnace",
      code: "OUTDOOR_STATION_CLEARANCE_REQUIRED",
      message: "Outdoor stations must be at least 30 meters apart.",
      suggestedPosition: { lat: 35.0845, lon: -106.6504 }
    };
    expect(parseServerMessage(JSON.stringify(message))).toEqual(message);
    expect(() => parseServerMessage(JSON.stringify({
      ...message,
      suggestedPosition: { lat: "nearby", lon: -106.6504 }
    }))).toThrow();
  });

  it("preserves the authoritative local appearance when restoring a manor session", () => {
    const message = {
      type: "MANOR_ENTERED",
      manorId: manor,
      spaceId: "manor_foyer",
      manorSessionId: session,
      displayColor: "#38bdf8",
      appearance: {
        schemaVersion: 1,
        catalogRevision: 1,
        revision: 7,
        bodyVariantId: "default",
        poseId: "melee_idle",
        slots: {},
        activeHand: "melee"
      },
      position: { x: 500, y: 880, targetX: null, targetY: null, moving: false, revision: 1 },
      movementSequence: 1,
      serverTime: 1,
      accessSource: "OWNER",
      storage: null
    };
    expect(parseServerMessage(JSON.stringify(message))).toEqual(message);
  });

  it("parses greenhouse snapshots with data-defined crop IDs", () => {
    const message = {
      type: "GREENHOUSES_SNAPSHOT",
      greenhouses: [{
        greenhouseId: "greenhouse-1",
        ownerPlayerId: "owner-1",
        regionCode: "world-test",
        lat: 35,
        lon: -106,
        builtAt: "2026-01-01T00:00:00.000Z",
        placementRevision: 0,
        roomCount: 1,
        planterCapacity: 15,
        tankWaterTenths: 5,
        tankCapacityTenths: 200,
        eligibility: {},
        anchors: [{
          anchorId: "anchor-1",
          roomId: "greenhouse_main_room",
          row: 0,
          column: 0,
          x: 100,
          y: 100,
          active: true,
          plant: {
            anchorId: "anchor-1",
            cropId: "moonbean",
            stage: 1,
            artId: "moonbean_seedling",
            plantedAt: "2026-01-01T00:00:00.000Z",
            wateredAt: null,
            nextStageAt: null,
            dry: true
          }
        }]
      }]
    };
    expect(parseServerMessage(JSON.stringify(message))).toMatchObject({
      type: "GREENHOUSES_SNAPSHOT",
      greenhouses: [{ anchors: [{ plant: { cropId: "moonbean" } }] }]
    });
  });

  it.each([
    { type: "BUILD_MANOR", requestId: "build" },
    { type: "OPEN_MANOR_UPGRADES", requestId: "open-upgrades" },
    { type: "UPGRADE_MANOR_STORAGE", requestId: "upgrade-storage", targetLevel: 1 },
    { type: "BUILD_TANNERY", requestId: "build-tannery" },
    { type: "OPEN_TANNERY", requestId: "open-tannery", tanneryId: manor },
    { type: "START_TANNERY_BATCH", requestId: "tan", tanneryId: manor, recipeId: "bear_hide", quantity: 25 },
    { type: "COLLECT_TANNERY_OUTPUT", requestId: "collect-tannery", tanneryId: manor },
    { type: "DESTROY_MANOR", requestId: "destroy" },
    { type: "JUMP_TO_MANOR", requestId: "jump", manorId: manor },
    { type: "ENTER_MANOR", requestId: "enter", manorId: manor },
    { type: "CANCEL_MANOR_ENTRY", requestId: "cancel-entry" },
    { type: "REQUEST_MANOR_GUESTS", requestId: "guests", manorId: manor },
    { type: "KICK_MANOR_GUEST", requestId: "kick", manorId: manor, targetPlayerId: "guest" },
    { type: "BAN_MANOR_GUEST", requestId: "ban", manorId: manor, targetPlayerId: "guest" },
    { type: "UNBAN_MANOR_GUEST", requestId: "unban", manorId: manor, targetPlayerId: "guest" },
    { type: "EXIT_MANOR", requestId: "exit", manorSessionId: session },
    { type: "MANOR_MOVE_TO", requestId: "move", manorSessionId: session, x: 500, y: 700 },
    { type: "OPEN_MANOR_STORAGE", requestId: "open", manorSessionId: session },
    { type: "REQUEST_MANOR_STORAGE_VIEW", requestId: "view" },
    { type: "MOVE_MANOR_STACK", requestId: "move-stack", manorSessionId: session, stackId: manor, targetSlot: 59 },
    { type: "SPLIT_MANOR_STACK", requestId: "split", manorSessionId: session, stackId: manor, quantity: 2 },
    { type: "RESTACK_MANOR_STACK", requestId: "restack", manorSessionId: session, stackId: manor },
    { type: "REORGANIZE_MANOR_STORAGE", requestId: "reorganize", manorSessionId: session },
    { type: "TRANSFER_MANOR_STACK", requestId: "deposit", manorSessionId: session, direction: "deposit", sourceStackId: manor, quantity: 2 },
    { type: "BULK_STORE_MANOR_ITEMS", requestId: "store-all", manorSessionId: session },
    { type: "BULK_TAKE_MANOR_ITEMS", requestId: "take-all", manorSessionId: session }
  ])("accepts strict $type intent", (message) => {
    expect(clientMessageSchema.parse(message)).toEqual(message);
  });

  it.each([
    { type: "BUILD_MANOR", requestId: "x", lat: 35, lon: -106 },
    { type: "BUILD_TANNERY", requestId: "x", lat: 35 },
    { type: "OPEN_TANNERY", requestId: "x", tanneryId: "not-a-uuid" },
    { type: "START_TANNERY_BATCH", requestId: "x", tanneryId: manor, recipeId: "raw_meat", quantity: 1 },
    { type: "START_TANNERY_BATCH", requestId: "x", tanneryId: manor, recipeId: "deer_hide", quantity: 26 },
    { type: "COLLECT_TANNERY_OUTPUT", requestId: "x", tanneryId: manor, playerId: "victim" },
    { type: "BUILD_MANOR", requestId: "x", ownerPlayerId: "victim" },
    { type: "BUILD_MANOR", requestId: "x", regionCode: "NM" },
    { type: "BUILD_MANOR", requestId: "x", flagId: session },
    { type: "UPGRADE_MANOR_STORAGE", requestId: "x", targetLevel: 0 },
    { type: "UPGRADE_MANOR_STORAGE", requestId: "x", targetLevel: 4 },
    { type: "UPGRADE_MANOR_STORAGE", requestId: "x", targetLevel: 1.5 },
    { type: "OPEN_MANOR_UPGRADES", requestId: "x", manorId: manor },
    { type: "DESTROY_MANOR", requestId: "x", manorId: session },
    { type: "DESTROY_MANOR", requestId: "x", ownerPlayerId: "victim" },
    { type: "DESTROY_MANOR", requestId: "x", placementRevision: 4 },
    { type: "ENTER_MANOR", requestId: "", manorId: manor },
    { type: "ENTER_MANOR", requestId: "x" },
    { type: "ENTER_MANOR", requestId: "x", manorId: manor, returnLat: 0 },
    { type: "JUMP_TO_MANOR", requestId: "x", manorId: "not-a-uuid" },
    { type: "KICK_MANOR_GUEST", requestId: "x", manorId: manor, targetPlayerId: "" },
    { type: "MANOR_MOVE_TO", requestId: "x", manorSessionId: session, x: Number.NaN, y: 0 },
    { type: "REQUEST_MANOR_STORAGE_VIEW", requestId: "x", manorId: manor },
    { type: "MOVE_MANOR_STACK", requestId: "x", manorSessionId: session, stackId: manor, targetSlot: -1 },
    { type: "SPLIT_MANOR_STACK", requestId: "x", manorSessionId: session, stackId: manor, quantity: 1.5 },
    { type: "RESTACK_MANOR_STACK", requestId: "x", manorSessionId: session, stackId: "not-a-uuid" },
    { type: "TRANSFER_MANOR_STACK", requestId: "x", manorSessionId: session, direction: "steal", sourceStackId: manor, quantity: 1 },
    { type: "TRANSFER_MANOR_STACK", requestId: "x", manorSessionId: session, direction: "withdrawal", sourceStackId: manor, quantity: Number.MAX_SAFE_INTEGER + 1 },
    { type: "BULK_STORE_MANOR_ITEMS", requestId: "x", manorSessionId: session, playerId: "victim" },
    { type: "BULK_TAKE_MANOR_ITEMS", requestId: "x", manorSessionId: session, manorId: manor }
  ])("rejects malformed or authority-spoofing input", (message) => {
    expect(clientMessageSchema.safeParse(message).success).toBe(false);
  });

  it("never accepts fuzzed malformed payloads and only throws parse errors", () => {
    for (const raw of ["", "{", "null", "[]", JSON.stringify({ type: "MANOR_MOVE_TO" }), "x".repeat(70_000)]) {
      expect(() => parseClientMessage(raw)).toThrow();
    }
  });
});
