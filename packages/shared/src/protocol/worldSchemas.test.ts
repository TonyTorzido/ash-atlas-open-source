import { describe, expect, it } from "vitest";

import {
  prepareWorldMapTravelMessageSchema,
  setWorldMapDestinationVisibilityMessageSchema
} from "./worldSchemas.js";
import { clientMessageSchema } from "./clientMessages.js";
import { parseServerMessage } from "./serverMessageParser.js";
import { combatEventSchema } from "./combatEquipmentServerSchemas.js";

const uuid = "00000000-0000-4000-8000-000000000001";

describe("world destination protocol validation", () => {
  it("keeps durable destination ids UUID-only", () => {
    expect(prepareWorldMapTravelMessageSchema.safeParse({
      type: "PREPARE_WORLD_MAP_TRAVEL", requestId: "r", destinationKind: "city", destinationId: uuid
    }).success).toBe(true);
    expect(prepareWorldMapTravelMessageSchema.safeParse({
      type: "PREPARE_WORLD_MAP_TRAVEL", requestId: "r", destinationKind: "city", destinationId: "NA-2"
    }).success).toBe(false);
    expect(clientMessageSchema.safeParse({
      type: "PREPARE_WORLD_MAP_TRAVEL", requestId: "r", destinationKind: "city", destinationId: "NA-2"
    }).success).toBe(false);
  });

  it("rejects retired beacon destination writes", () => {
    expect(setWorldMapDestinationVisibilityMessageSchema.safeParse({
      type: "SET_WORLD_MAP_DESTINATION_VISIBILITY", requestId: "r",
      destinationKind: "beacon", destinationId: "NA-2", visible: true
    }).success).toBe(false);
    expect(setWorldMapDestinationVisibilityMessageSchema.safeParse({
      type: "SET_WORLD_MAP_DESTINATION_VISIBILITY", requestId: "r",
      destinationKind: "beacon", destinationId: uuid, visible: true
    }).success).toBe(false);
    expect(clientMessageSchema.safeParse({
      type: "SET_WORLD_MAP_DESTINATION_VISIBILITY", requestId: "r",
      destinationKind: "beacon", destinationId: uuid, visible: true
    }).success).toBe(false);
    expect(clientMessageSchema.safeParse({
      type: "VISIT_WORLD_MAP_BEACON", requestId: "r", beaconId: "NA-2"
    }).success).toBe(false);
  });
});

describe("DASH protocol validation", () => {
  const base = { type: "DASH", requestId: "dash-1" } as const;

  it("accepts a world-space unit vector", () => {
    expect(clientMessageSchema.safeParse({ ...base, dirX: 0, dirY: 1 }).success).toBe(true);
    expect(clientMessageSchema.safeParse({ ...base, dirX: Math.SQRT1_2, dirY: -Math.SQRT1_2 }).success).toBe(true);
    expect(clientMessageSchema.safeParse({
      ...base, dirX: 1, dirY: 0, lastDash: { requestId: "dash-0", pressToAcceptMs: 84, correctionM: 1.5 }
    }).success).toBe(true);
  });

  it("rejects non-unit, non-finite, positional, or extra fields", () => {
    for (const message of [
      { ...base, dirX: 0, dirY: 0 },
      { ...base, dirX: 0.5, dirY: 0.5 },
      { ...base, dirX: 3, dirY: 4 },
      { ...base, dirX: Number.NaN, dirY: 1 },
      { ...base, dirX: 0, dirY: 1, lat: 1, lon: 2 },
      { ...base, dirX: 0, dirY: 1, lastDash: { requestId: "x", pressToAcceptMs: -1, correctionM: 0 } },
      { type: "DASH", dirX: 0, dirY: 1 }
    ]) {
      expect(clientMessageSchema.safeParse(message).success).toBe(false);
    }
  });
});

describe("SWING protocol validation", () => {
  const base = { type: "SWING", requestId: "swing-1", seq: 0, lagMs: 60 } as const;

  it("accepts a world-space unit vector with a bounded lag hint", () => {
    expect(clientMessageSchema.safeParse({ ...base, dirX: 0, dirY: 1 }).success).toBe(true);
    expect(clientMessageSchema.safeParse({ ...base, dirX: -Math.SQRT1_2, dirY: Math.SQRT1_2 }).success).toBe(true);
    expect(clientMessageSchema.safeParse({ ...base, seq: 41, dirX: 1, dirY: 0, lagMs: 0 }).success).toBe(true);
    expect(clientMessageSchema.safeParse({ ...base, dirX: 1, dirY: 0, lagMs: 1_000 }).success).toBe(true);
  });

  it("rejects a non-unit or non-finite direction", () => {
    for (const message of [
      { ...base, dirX: 0, dirY: 0 },
      { ...base, dirX: 0.5, dirY: 0.5 },
      { ...base, dirX: 1.05, dirY: 1.05 },
      { ...base, dirX: 3, dirY: 4 },
      { ...base, dirX: Number.NaN, dirY: 1 }
    ]) {
      expect(clientMessageSchema.safeParse(message).success).toBe(false);
    }
  });

  it("rejects an out-of-range lag hint or sequence", () => {
    expect(clientMessageSchema.safeParse({ ...base, dirX: 0, dirY: 1, lagMs: 1_000.5 }).success).toBe(false);
    expect(clientMessageSchema.safeParse({ ...base, dirX: 0, dirY: 1, lagMs: 5_000 }).success).toBe(false);
    expect(clientMessageSchema.safeParse({ ...base, dirX: 0, dirY: 1, lagMs: -1 }).success).toBe(false);
    expect(clientMessageSchema.safeParse({ ...base, dirX: 0, dirY: 1, seq: -1 }).success).toBe(false);
    expect(clientMessageSchema.safeParse({ ...base, dirX: 0, dirY: 1, seq: 1.5 }).success).toBe(false);
  });

  it("rejects extra or missing fields (no positions, targets or combo from the client)", () => {
    for (const message of [
      { ...base, dirX: 0, dirY: 1, lat: 1, lon: 2 },
      { ...base, dirX: 0, dirY: 1, targetEntityId: "mob-1" },
      { ...base, dirX: 0, dirY: 1, comboIndex: 2 },
      { type: "SWING", seq: 0, lagMs: 0, dirX: 0, dirY: 1 },
      { type: "SWING", requestId: "swing-1", lagMs: 0, dirX: 0, dirY: 1 },
      { type: "SWING", requestId: "swing-1", seq: 0, dirX: 0, dirY: 1 }
    ]) {
      expect(clientMessageSchema.safeParse(message).success).toBe(false);
    }
  });
});

describe("SWING_RESULT and SWING event validation", () => {
  const result = {
    type: "SWING_RESULT", requestId: "swing-1", seq: 3, serverTick: 1200, comboIndex: 2,
    nextSwingAt: 1_760_000_000_000,
    hits: [{ entityId: "mob-1", damage: 14, currentHealth: 40 }]
  };

  it("parses a confirmed and a rejected SWING_RESULT", () => {
    expect(parseServerMessage(JSON.stringify(result)).type).toBe("SWING_RESULT");
    expect(parseServerMessage(JSON.stringify({ ...result, hits: [], rejected: "disabled" })).type).toBe("SWING_RESULT");
  });

  it("rejects a bad combo index, too many hits or an unknown reject reason", () => {
    // A profile combo may run to ATTACK_COMBO_MAX_LENGTH (6) steps: indices 0..5 parse, 6 does not.
    expect(parseServerMessage(JSON.stringify({ ...result, comboIndex: 5 })).type).toBe("SWING_RESULT");
    expect(() => parseServerMessage(JSON.stringify({ ...result, comboIndex: 6 }))).toThrow();
    expect(() => parseServerMessage(JSON.stringify({ ...result, hits: Array(5).fill(result.hits[0]) }))).toThrow();
    expect(() => parseServerMessage(JSON.stringify({ ...result, rejected: "nope" }))).toThrow();
  });

  it("accepts a SWING combat event with facingDegrees", () => {
    expect(combatEventSchema.safeParse({
      eventId: "e1", type: "SWING", tick: 10, sourceEntityId: "player-1", targetEntityId: null,
      position: { lat: 35, lon: -106 }, radiusM: 110, abilityId: "swing_1", facingDegrees: 270
    }).success).toBe(true);
    expect(combatEventSchema.safeParse({
      eventId: "e1", type: "SWING", tick: 10, sourceEntityId: "player-1", targetEntityId: null,
      facingDegrees: 400
    }).success).toBe(false);
  });
});
