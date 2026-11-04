import { describe, expect, it } from "vitest";

import {
  clientMessageSchema,
  parseServerMessage,
  serializeServerMessage
} from "./protocol.js";

describe("repeatable resource protocol", () => {
  it("exposes only the public mine readiness boundary needed for countdown presentation", () => {
    expect(clientMessageSchema.parse({
      type: "REINFORCE_FLAG",
      requestId: "reinforce-request",
      flagId: "00000000-0000-4000-8000-000000000001"
    })).toMatchObject({ type: "REINFORCE_FLAG" });

    const serialized = serializeServerMessage({
      type: "COLLECTIBLES_SNAPSHOT",
      playerId: "player-1",
      relocationRevision: 1,
      resourceVisionRevision: 1,
      authority: {
        snapshotId: "snapshot-1",
        snapshotGeneration: 1,
        gameplayViewGeneration: 1,
        scope: { kind: "player-anchor", id: "player-1" },
        includedDomains: [],
        completeness: "partial",
        ordinaryNodesTruncated: false,
        returnedCount: 1,
        authoritativeTotalCount: 1
      },
      serverTime: 1,
      visibleRadiusM: 1_500,
      activationRadiusM: 1_500,
      resourceVision: null,
      resourceVisionStatus: null,
      waterHighlights: [],
      nodes: [],
      repeatableNodes: [{
        id: "00000000-0000-4000-8000-000000000616",
        nodeType: "coal_mine",
        lat: 35.08925,
        lon: -106.6425,
        yieldItemId: "coal",
        yieldQuantity: 1,
        state: "depleted",
        authorityRevision: 2,
        readyAt: "2026-07-15T06:00:00.000Z",
        timerVisibility: "visible"
      }]
    });
    expect(serialized).toContain('"state":"depleted"');
    expect(serialized).toContain('"readyAt":"2026-07-15T06:00:00.000Z"');
    expect(serialized).toContain('"timerVisibility":"visible"');
    expect(serialized).not.toMatch(/lastHarvester|operation|regeneration/i);
    expect(serialized).not.toContain("flagResourceGeneration");

    const publicRemoval = serializeServerMessage({
      type: "COLLECTIBLE_REMOVED",
      nodeId: "ambient-node",
      playerId: "player",
      serverTime: 1
    });
    expect(publicRemoval).not.toContain("inventory");
  });

  it("rejects the removed flag-resource generation frame", () => {
    expect(() => parseServerMessage(JSON.stringify({
      type: "FLAG_RESOURCE_GENERATION_CHANGED",
      flagId: "00000000-0000-4000-8000-000000000001",
      generation: 2,
      expiredTreeIds: ["tree:old"],
      expiredWolfIds: ["wolf:old"],
      serverTime: 2
    }))).toThrow();
  });
});
