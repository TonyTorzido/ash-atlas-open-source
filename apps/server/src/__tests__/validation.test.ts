import { clientMessageSchema, serializeServerMessage } from "@ash-atlas/shared";
import { describe, expect, it } from "vitest";

import {
  sanitizeFlagName,
  sanitizeFlagRename,
  sanitizePlayerColor,
  sanitizeUsername,
  validateMoveTarget
} from "../game/validation.js";

describe("validation", () => {
  it("accepts finite global move targets", () => {
    expect(validateMoveTarget(35.0844, -106.6504)).toEqual({
      lat: 35.0844,
      lon: -106.6504
    });
    expect(validateMoveTarget(35.68, 139.69)).toEqual({ lat: 35.68, lon: 139.69 });
    expect(validateMoveTarget(-33.87, 151.21)).toEqual({ lat: -33.87, lon: 151.21 });
    expect(validateMoveTarget(0, -180)).toEqual({ lat: 0, lon: -180 });
  });

  it("rejects move targets outside geographic coordinate bounds", () => {
    expect(() => validateMoveTarget(91, -106.6504)).toThrow(/finite latitude/);
    expect(() => validateMoveTarget(40, 181)).toThrow(/finite latitude/);
  });

  it("normalizes usernames and flag names", () => {
    expect(sanitizeUsername("  Ash   Atlas  ")).toBe("Ash Atlas");
    expect(sanitizeFlagName(undefined, 3)).toBe("Flag 3");
    expect(sanitizeFlagName("  Mesa   Claim  ", 1)).toBe("Mesa Claim");
    expect(sanitizeFlagRename("  Canyon   Watch  ")).toBe("Canyon Watch");
    expect(sanitizePlayerColor("  #ABCDEF  ")).toBe("#abcdef");
    expect(() => sanitizePlayerColor("blue")).toThrow(/#RRGGBB/);
    expect(() => sanitizeFlagRename("   ")).toThrow(/required/);
    expect(() => sanitizeFlagRename("x".repeat(41))).toThrow(/40/);
  });

  it("validates websocket protocol messages with zod", () => {
    expect(
      clientMessageSchema.parse({
        type: "MOVE_TO",
        requestId: "move-1",
        lat: 35.1,
        lon: -106.6
      })
    ).toEqual({
      type: "MOVE_TO",
      requestId: "move-1",
      lat: 35.1,
      lon: -106.6
    });

    expect(() =>
      clientMessageSchema.parse({
        type: "MOVE_TO",
        requestId: "move-1",
        lat: "bad",
        lon: -106.6
      })
    ).toThrow();
  });

  it("validates visit flag protocol messages with zod", () => {
    expect(
      clientMessageSchema.parse({
        type: "VISIT_FLAG",
        requestId: "visit-1",
        flagId: "00000000-0000-4000-8000-000000900001"
      })
    ).toEqual({
      type: "VISIT_FLAG",
      requestId: "visit-1",
      flagId: "00000000-0000-4000-8000-000000900001"
    });

    expect(() =>
      clientMessageSchema.parse({
        type: "VISIT_FLAG",
        requestId: "visit-1",
        flagId: "not-a-uuid"
      })
    ).toThrow();
  });

  it("validates collectible protocol messages with zod", () => {
    expect(
      clientMessageSchema.parse({
        type: "SURVEY_AREA",
        requestId: "survey-1"
      })
    ).toEqual({
      type: "SURVEY_AREA",
      requestId: "survey-1"
    });
    expect(
      clientMessageSchema.parse({
        type: "START_HARVEST",
        requestId: "harvest-start-1",
        nodeId: "NM:-32500:15622:wood",
        expectedPresentationOwner: "population",
        expectedEntityRevision: 7,
        expectedRelocationRevision: 3,
        expectedResourceVisionRevision: 4,
        expectedGameplayViewGeneration: 5
      })
    ).toMatchObject({
      type: "START_HARVEST",
      nodeId: "NM:-32500:15622:wood",
      expectedEntityRevision: 7
    });
    expect(
      clientMessageSchema.parse({
        type: "COMPLETE_HARVEST",
        requestId: "harvest-complete-1",
        sessionId: "11111111-1111-4111-8111-111111111111"
      })
    ).toMatchObject({ type: "COMPLETE_HARVEST" });
    expect(
      clientMessageSchema.parse({
        type: "CANCEL_HARVEST",
        requestId: "harvest-cancel-1",
        sessionId: "11111111-1111-4111-8111-111111111111"
      })
    ).toMatchObject({ type: "CANCEL_HARVEST" });
    expect(
      clientMessageSchema.parse({
        type: "COLLECT_WATER_AT_COORDINATE",
        requestId: "water-1",
        lat: 35.073775,
        lon: -106.664932
      })
    ).toMatchObject({
      type: "COLLECT_WATER_AT_COORDINATE",
      lat: 35.073775
    });

    expect(() =>
      clientMessageSchema.parse({
        type: "START_HARVEST",
        requestId: "harvest-start-1",
        nodeId: ""
      })
    ).toThrow();
    expect(() =>
      clientMessageSchema.parse({
        type: "START_HARVEST",
        requestId: "pickup-forged-grant",
        nodeId: "NM:-32500:15622:wood",
        itemId: "stone",
        quantity: 50
      })
    ).toThrow();
    expect(() =>
      clientMessageSchema.parse({
        type: "PICKUP_COLLECTIBLE",
        requestId: "legacy-direct-pickup",
        nodeId: "NM:-32500:15622:wood"
      })
    ).toThrow();
  });

  it("strictly validates dropped item protocol messages", () => {
    expect(
      clientMessageSchema.parse({
        type: "DROP_ITEM",
        requestId: "drop-1",
        itemId: "wood",
        variant: null,
        quantity: 1
      })
    ).toMatchObject({ type: "DROP_ITEM", itemId: "wood", quantity: 1 });
    expect(
      clientMessageSchema.parse({
        type: "PICKUP_DROPPED_ITEM",
        requestId: "pickup-1",
        dropId: "11111111-1111-4111-8111-111111111111",
        pickup: { mode: "all" }
      })
    ).toMatchObject({ type: "PICKUP_DROPPED_ITEM", pickup: { mode: "all" } });
    expect(
      clientMessageSchema.parse({
        type: "PICKUP_DROPPED_ITEM",
        requestId: "pickup-quantity",
        dropId: "11111111-1111-4111-8111-111111111111",
        pickup: { mode: "quantity", quantity: 3 }
      })
    ).toMatchObject({ pickup: { mode: "quantity", quantity: 3 } });
    expect(() =>
      clientMessageSchema.parse({
        type: "PICKUP_DROPPED_ITEM",
        requestId: "pickup-invalid",
        dropId: "11111111-1111-4111-8111-111111111111",
        pickup: { mode: "quantity", quantity: 0 }
      })
    ).toThrow();

    for (const quantity of [0, -1, 1.5]) {
      expect(() =>
        clientMessageSchema.parse({
          type: "DROP_ITEM",
          requestId: "drop-invalid",
          itemId: "wood",
          variant: null,
          quantity
        })
      ).toThrow();
    }
    expect(() =>
      clientMessageSchema.parse({
        type: "DROP_ITEM",
        requestId: "drop-unknown",
        itemId: "not_a_real_item",
        variant: null,
        quantity: 1
      })
    ).toThrow();
    expect(() =>
      clientMessageSchema.parse({
        type: "DROP_ITEM",
        requestId: "drop-forged-position",
        itemId: "wood",
        variant: null,
        quantity: 1,
        lat: 35,
        lon: -106
      })
    ).toThrow();
  });

  it("serializes flag deleted protocol messages", () => {
    expect(
      JSON.parse(
        serializeServerMessage({
          type: "FLAG_DELETED",
          flagId: "00000000-0000-4000-8000-000000900001"
        })
      )
    ).toEqual({
      type: "FLAG_DELETED",
      flagId: "00000000-0000-4000-8000-000000900001"
    });
  });

  it("serializes flag updated protocol messages", () => {
    expect(
      JSON.parse(
        serializeServerMessage({
          type: "FLAG_UPDATED",
          flag: {
            id: "00000000-0000-4000-8000-000000900001",
            controlType: "personal",
            ownerId: "player-1",
            name: "Renamed Flag",
            lat: 35.0844,
            lon: -106.6504,
            packageId: "nm-core",
            elevationM: 1500,
            terrainClass: "urban",
            biome: "desert",
            ecoregion: "Chihuahuan Desert",
            claimRadiusM: 700,
            cityId: null,
            createdAt: "2026-07-08T09:00:00.000Z"
          }
        })
      )
    ).toMatchObject({
      type: "FLAG_UPDATED",
      flag: {
        id: "00000000-0000-4000-8000-000000900001",
        name: "Renamed Flag"
      }
    });
  });

  it("serializes multiplayer player snapshots", () => {
    expect(
      JSON.parse(
        serializeServerMessage({
          type: "PLAYER_SNAPSHOT",
          serverTime: 123,
          sequence: 0,
          players: [
            {
              playerId: "player-1",
              username: "Ash",
              displayColor: "#38bdf8",
              regionCode: "NM",
              zoneId: "world:NM",
              lat: 35.0844,
              lon: -106.6504,
              anchorLat: 35.0844,
              anchorLon: -106.6504,
              moveLeashRadiusM: 900,
              movementRevision: 0,
              targetLat: null,
              targetLon: null,
              moving: false,
              online: true,
              updatedAt: "2026-07-08T09:00:00.000Z"
            },
            {
              playerId: "player-2",
              username: "Bex",
              displayColor: "#34d399",
              regionCode: "NM",
              zoneId: "world:NM",
              lat: 35.085,
              lon: -106.651,
              anchorLat: 35.085,
              anchorLon: -106.651,
              moveLeashRadiusM: 900,
              movementRevision: 1,
              targetLat: 35.086,
              targetLon: -106.652,
              moving: true,
              online: true,
              updatedAt: "2026-07-08T09:00:01.000Z"
            }
          ]
        })
      )
    ).toMatchObject({
      type: "PLAYER_SNAPSHOT",
      sequence: 0,
      players: [
        {
          playerId: "player-1",
          online: true,
          zoneId: "world:NM"
        },
        {
          playerId: "player-2",
          moving: true
        }
      ]
    });
  });
});
