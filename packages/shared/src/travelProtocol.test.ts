import { describe, expect, it } from "vitest";

import { clientMessageSchema } from "./protocol.js";
import {
  TRAVEL_INVITE_PAIR_COOLDOWN_MS,
  TRAVEL_INVITE_TTL_MS,
  travelInboxSnapshotSchema
} from "./travel.js";

const requestId = "00000000-0000-4000-8000-000000000001";
const inviteId = "00000000-0000-4000-8000-000000000002";

describe("travel protocol", () => {
  it.each([
    { type: "SEND_TRAVEL_INVITE", requestId, targetPlayerId: "player-b" },
    { type: "RESPOND_TRAVEL_INVITE", requestId, inviteId, response: "accept" },
    { type: "RESPOND_TRAVEL_INVITE", requestId, inviteId, response: "decline" },
    { type: "CANCEL_TRAVEL_INVITE", requestId, inviteId },
    { type: "REQUEST_TRAVEL_INBOX", requestId }
  ])("accepts strict authenticated $type intent", (message) => {
    expect(clientMessageSchema.parse(message)).toEqual(message);
  });

  it("accepts GPS relocation intent without exposing a manual destination contract", () => {
    const message = {
      type: "RELOCATE_TO_CURRENT_LOCATION",
      requestId,
      lat: 40.015,
      lon: -105.27,
      accuracy: 12
    } as const;
    expect(clientMessageSchema.parse(message)).toEqual(message);
    expect(clientMessageSchema.safeParse({
      ...message,
      destination: { lat: 1, lon: 2 }
    }).success).toBe(false);
  });

  it("accepts an optional device time zone on relocation and stays compatible without it", () => {
    const legacy = { type: "RELOCATE_TO_CURRENT_LOCATION", requestId, lat: 40, lon: -105 } as const;
    expect(clientMessageSchema.parse(legacy)).toEqual(legacy);
    const withZone = { ...legacy, deviceTimeZone: "America/Denver" };
    expect(clientMessageSchema.parse(withZone)).toEqual(withZone);
  });

  it("accepts a passive LOCATION_FIX without a request id and rejects extra fields", () => {
    const fix = {
      type: "LOCATION_FIX",
      lat: 40.015,
      lon: -105.27,
      accuracy: 30,
      deviceTimeZone: "America/Denver"
    } as const;
    expect(clientMessageSchema.parse(fix)).toEqual(fix);
    expect(clientMessageSchema.parse({ type: "LOCATION_FIX", lat: 1, lon: 2 }))
      .toEqual({ type: "LOCATION_FIX", lat: 1, lon: 2 });
    // Coordinates stay unknown at the wire so the server can ignore bad values quietly.
    expect(clientMessageSchema.safeParse({ type: "LOCATION_FIX", lat: "x", lon: null }).success).toBe(true);
    expect(clientMessageSchema.safeParse({ ...fix, requestId }).success).toBe(false);
    expect(clientMessageSchema.safeParse({ ...fix, source: "relocation" }).success).toBe(false);
  });

  it("keeps an unknown LOCATION_FIX reason parseable so the server can ignore it", () => {
    for (const reason of ["periodic", "pre_action", "bogus", 7, null, { nested: true }]) {
      const fix = { type: "LOCATION_FIX", lat: 1, lon: 2, reason };
      expect(clientMessageSchema.parse(fix)).toEqual(fix);
    }
  });

  it("does not accept client-selected invite destinations or identities", () => {
    expect(clientMessageSchema.safeParse({
      type: "SEND_TRAVEL_INVITE",
      requestId,
      targetPlayerId: "player-b",
      inviterPlayerId: "forged",
      sourceFlagId: inviteId,
      lat: 1,
      lon: 2
    }).success).toBe(false);
    expect(clientMessageSchema.safeParse({
      type: "RESPOND_TRAVEL_INVITE",
      requestId,
      inviteId,
      response: "accept",
      targetPlayerId: "forged"
    }).success).toBe(false);
    expect(clientMessageSchema.safeParse({
      type: "RESPOND_TRAVEL_INVITE",
      requestId,
      inviteId,
      response: "accept",
      expectedTollGold: "7"
    }).success).toBe(false);
  });

  it("accepts only a bounded request correlation on first post-travel movement", () => {
    expect(clientMessageSchema.parse({
      type: "MOVE_TO",
      requestId: "move-1",
      boundTravelRequestId: requestId,
      lat: 35.09,
      lon: -106.66
    })).toMatchObject({
      type: "MOVE_TO",
      boundTravelRequestId: requestId
    });
    expect(clientMessageSchema.safeParse({
      type: "MOVE_TO",
      requestId: "move-1",
      boundTravelRequestId: "",
      lat: 35.09,
      lon: -106.66
    }).success).toBe(false);
  });

  it("validates linked inbox projections and the exact ten-minute contract", () => {
    expect(TRAVEL_INVITE_TTL_MS).toBe(600_000);
    expect(TRAVEL_INVITE_PAIR_COOLDOWN_MS).toBe(30_000);
    const createdAt = "2026-07-13T12:00:00.000Z";
    const expiresAt = "2026-07-13T12:10:00.000Z";
    const snapshot = {
      type: "TRAVEL_INBOX_SNAPSHOT",
      serverTime: Date.parse(createdAt),
      entries: [{
        entryId: "00000000-0000-4000-8000-000000000003",
        inviteId,
        perspective: "recipient",
        counterpartPlayerId: "player-a",
        counterpartName: "Ariadne",
        message: "Ariadne invited you to travel to their current area.",
        status: "pending",
        invalidationReason: null,
        sourceType: "city",
        sourceId: "00000000-0000-4000-8000-000000000004",
        createdAt,
        expiresAt,
        respondedAt: null
      }]
    } as const;
    expect(travelInboxSnapshotSchema.parse(snapshot)).toEqual(snapshot);
  });
});
