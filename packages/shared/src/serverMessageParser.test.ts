import { describe, expect, it } from "vitest";

import {
  MAX_SERVER_MESSAGE_BYTES,
  ServerMessageParseError,
  parseServerMessage
} from "./protocol.js";

describe("server message parser", () => {
  it("parses a known frame and preserves additive fields", () => {
    expect(parseServerMessage(JSON.stringify({
      type: "PONG",
      clientTime: 1,
      serverTime: 2,
      additiveCapabilityData: true
    }))).toEqual({
      type: "PONG",
      clientTime: 1,
      serverTime: 2,
      additiveCapabilityData: true
    });
  });

  it("parses a prepared visible-flag arrival position", () => {
    const frame = {
      type: "VISIBLE_FLAG_VISIT_PREPARED",
      requestId: "prepare-flag-1",
      flagId: "flag-1",
      playerSpawnPosition: { lat: 39.7397, lon: -104.9903 },
      expiresInMs: 15_000
    } as const;

    expect(parseServerMessage(JSON.stringify(frame))).toEqual(frame);
  });

  it("parses a canonical greenhouse interior location snapshot", () => {
    const frame = {
      type: "PLAYER_LOCATION_SNAPSHOT",
      location: {
        kind: "interior",
        locationType: "greenhouse",
        locationId: "greenhouse-1",
        instanceId: "greenhouse:greenhouse-1",
        spaceId: "greenhouse_main_room",
        regionCode: "GLOBAL",
        zoneId: "interior:greenhouse:greenhouse-1:greenhouse_main_room",
        position: { x: 500, y: 790 },
        revision: 1,
        lastPortalId: "greenhouse:world-to-interior"
      }
    } as const;

    expect(parseServerMessage(JSON.stringify(frame))).toEqual(frame);
  });

  it.each([
    ["malformed-json", "{"],
    ["malformed-frame", JSON.stringify({ type: "PONG", clientTime: "bad", serverTime: 2 })],
    ["unknown-frame", JSON.stringify({ type: "FUTURE_FRAME" })]
  ] as const)("classifies %s without leaking an unchecked payload", (kind, raw) => {
    try {
      parseServerMessage(raw);
      throw new Error("expected parser failure");
    } catch (error) {
      expect(error).toBeInstanceOf(ServerMessageParseError);
      expect((error as ServerMessageParseError).kind).toBe(kind);
    }
  });

  it("uses the canonical nested market validator", () => {
    expect(parseServerMessage(JSON.stringify({
      type: "MARKET_BOOK_CHANGED",
      itemId: "ore",
      bookVersion: "2"
    }))).toEqual({
      type: "MARKET_BOOK_CHANGED",
      itemId: "ore",
      bookVersion: "2"
    });
    expect(() => parseServerMessage(JSON.stringify({
      type: "MARKET_BOOK_CHANGED",
      itemId: "ore",
      bookVersion: "02"
    }))).toThrow(ServerMessageParseError);
  });

  it("rejects an oversized frame before parsing its payload", () => {
    expect(() => parseServerMessage(" ".repeat(MAX_SERVER_MESSAGE_BYTES + 1))).toThrow(
      /exceeds the size limit/
    );
  });
});
