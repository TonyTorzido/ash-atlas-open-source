import { describe, expect, it } from "vitest";

import {
  WORLD_MAP_DEFAULT_ZOOM,
  WORLD_MAP_FIT_MAX_ZOOM,
  WORLD_MAP_MAX_ZOOM,
  WORLD_MAP_MIN_ZOOM,
  WORLD_MAP_SINGLE_DESTINATION_ZOOM
} from "./worldMap.js";
import { clientMessageSchema, parseServerMessage } from "./protocol.js";

describe("world map protocol", () => {
  it("keeps coarse world zoom constants separate from gameplay map constants", () => {
    expect({
      min: WORLD_MAP_MIN_ZOOM,
      max: WORLD_MAP_MAX_ZOOM,
      initial: WORLD_MAP_DEFAULT_ZOOM,
      single: WORLD_MAP_SINGLE_DESTINATION_ZOOM,
      fit: WORLD_MAP_FIT_MAX_ZOOM
    }).toEqual({ min: 0, max: 5, initial: 4, single: 3, fit: 3.75 });
  });

  it("accepts only a request ID when requesting authorized destinations", () => {
    expect(clientMessageSchema.safeParse({
      type: "REQUEST_WORLD_MAP_DESTINATIONS",
      requestId: "world-map"
    }).success).toBe(true);
    expect(clientMessageSchema.safeParse({
      type: "REQUEST_WORLD_MAP_DESTINATIONS",
      requestId: "forged",
      lat: 35,
      lon: -106,
      flagId: "00000000-0000-4000-8000-000000900013"
    }).success).toBe(false);
  });

  it("accepts owner-authorized Atlas Shrine destination snapshots", () => {
    const message = {
      type: "WORLD_MAP_DESTINATIONS",
      snapshot: {
        destinations: [{
          kind: "atlas_shrine",
          id: "00000000-0000-4000-8000-000000900013",
          name: "North Shrine",
          lat: 35,
          lon: -106,
          visible: true
        }],
        serverTime: 1
      }
    };
    expect(parseServerMessage(JSON.stringify(message))).toEqual(message);
  });

  it("accepts social players with their display color and appearance payload", () => {
    const message = {
      type: "WORLD_MAP_DESTINATIONS",
      snapshot: {
        destinations: [],
        serverTime: 1,
        socialPlayers: [{
          playerId: "remote-player",
          username: "Bex",
          displayColor: "#c85a8b",
          lat: 35,
          lon: -106,
          publishedAt: "2026-09-11T00:00:00.000Z",
          appearance: {
            schemaVersion: 1,
            catalogRevision: 1,
            revision: 2,
            bodyVariantId: "default",
            poseId: "idle",
            slots: {},
            styles: {},
            activeHand: null
          }
        }]
      }
    };
    expect(parseServerMessage(JSON.stringify(message))).toEqual(message);
  });

  it("accepts only server-resolved destination visibility changes", () => {
    expect(clientMessageSchema.safeParse({
      type: "SET_WORLD_MAP_DESTINATION_VISIBILITY",
      requestId: "hide-city",
      destinationKind: "city",
      destinationId: "00000000-0000-4000-8000-000000900013",
      visible: false
    }).success).toBe(true);
    expect(clientMessageSchema.safeParse({
      type: "SET_WORLD_MAP_DESTINATION_VISIBILITY",
      requestId: "forged",
      destinationKind: "city",
      destinationId: "00000000-0000-4000-8000-000000900013",
      visible: true,
      lat: 35,
      lon: -106
    }).success).toBe(false);
  });

  it("prepares only a server-resolved World Map destination", () => {
    expect(clientMessageSchema.safeParse({
      type: "PREPARE_WORLD_MAP_TRAVEL",
      requestId: "prepare-travel",
      destinationKind: "manor",
      destinationId: "00000000-0000-4000-8000-000000900013"
    }).success).toBe(true);
    expect(clientMessageSchema.safeParse({
      type: "PREPARE_WORLD_MAP_TRAVEL",
      requestId: "forged",
      destinationKind: "city",
      destinationId: "00000000-0000-4000-8000-000000900013",
      lat: 35,
      lon: -106
    }).success).toBe(false);
  });

  it("accepts only a server-resolved seat ID for World Map Kingdom travel", () => {
    expect(clientMessageSchema.safeParse({
      type: "VISIT_WORLD_MAP_KINGDOM",
      requestId: "kingdom-travel",
      seatId: "00000000-0000-4000-8000-000000900013"
    }).success).toBe(true);
    expect(clientMessageSchema.safeParse({
      type: "VISIT_WORLD_MAP_KINGDOM",
      requestId: "forged",
      seatId: "00000000-0000-4000-8000-000000900013",
      lat: 35,
      lon: -106
    }).success).toBe(false);
  });

  it("accepts only a server-resolved city ID for World Map city travel", () => {
    expect(clientMessageSchema.safeParse({
      type: "VISIT_WORLD_MAP_CITY",
      requestId: "city-travel",
      cityId: "00000000-0000-4000-8000-000000900013"
    }).success).toBe(true);
    expect(clientMessageSchema.safeParse({
      type: "VISIT_WORLD_MAP_CITY",
      requestId: "forged",
      cityId: "00000000-0000-4000-8000-000000900013",
      lat: 35,
      lon: -106
    }).success).toBe(false);
  });
});
