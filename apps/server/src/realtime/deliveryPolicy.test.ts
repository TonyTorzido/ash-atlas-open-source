import type { ServerMessage } from "@ash-atlas/shared";
import { describe, expect, it } from "vitest";

import {
  SERVER_MESSAGE_DELIVERY_POLICY,
  deliveryClassFor,
  sendModeForDeliveryClass
} from "./deliveryPolicy.js";

describe("realtime delivery policy", () => {
  type PopulationFrame = Extract<
    ServerMessage,
    { type: "POPULATION_ZONE_DELTA" }
  >;
  it("classifies every server message family exactly once", () => {
    const messageTypes = Object.keys(SERVER_MESSAGE_DELIVERY_POLICY);
    expect(messageTypes.length).toBeGreaterThan(0);
    expect(new Set(messageTypes).size).toBe(messageTypes.length);
  });

  it("keeps authoritative and terminal results critical", () => {
    expect(SERVER_MESSAGE_DELIVERY_POLICY.DUNGEON_REWARD_GRANTED).toBe("critical");
    expect(deliveryClassFor({
      type: "TRAVEL_RESULT",
      kind: "party_manual",
      success: false,
      message: "blocked"
    })).toBe("critical");
    const terminal: PopulationFrame = {
      type: "POPULATION_ZONE_DELTA",
      playerId: "player-1",
      connectionId: "connection-1",
      connectionGeneration: 1,
      preparationGeneration: 1,
      preparationTrigger: "world-entry",
      preparationScope: "required-visible",
      requiredForGameplay: true,
      relocationRevision: 1,
      resourceVisionRevision: 1,
      gameplayViewGeneration: 1,
      retainedZoneIds: [],
      activatedZoneIds: [],
      releasedZoneIds: [],
      withheldZoneIds: [],
      upserts: [],
      removedEntityIds: [],
      visibleZoneCount: 0,
      readyVisibleZoneCount: 0,
      backgroundZoneCount: 0,
      readyBackgroundZoneCount: 0,
      zoneSnapshots: [],
      preparationReason: "ready",
      preparationResult: "ready",
      partial: false,
      terminal: true
    };
    expect(deliveryClassFor(terminal)).toBe("terminal-population");
    expect(deliveryClassFor(terminal, "replaceable"))
      .toBe("terminal-population");
    expect(sendModeForDeliveryClass("terminal-population")).toBe("critical");
    expect(deliveryClassFor({
      type: "POPULATION_RESYNC_RESULT",
      requestId: "population-resync-1",
      outcome: "republished",
      playerId: "player-1",
      connectionId: "connection-1",
      connectionGeneration: 1,
      requestedPreparationGeneration: 1,
      currentPreparationGeneration: 1,
      requestedRelocationRevision: 1,
      currentRelocationRevision: 1,
      requestedResourceVisionRevision: 1,
      currentResourceVisionRevision: 1,
      preparationReason: "durable-rehydration",
      preparationResult: "pending",
      visibleZoneCount: 2,
      readyVisibleZoneCount: 1,
      terminal: false
    })).toBe("critical");
  });

  it("coalesces partial population progress without downgrading terminals", () => {
    const pending: PopulationFrame = {
      type: "POPULATION_ZONE_DELTA",
      playerId: "player-1",
      connectionId: "connection-1",
      connectionGeneration: 1,
      preparationGeneration: 2,
      preparationTrigger: "world-entry",
      preparationScope: "required-visible",
      requiredForGameplay: true,
      relocationRevision: 1,
      resourceVisionRevision: 1,
      gameplayViewGeneration: 1,
      retainedZoneIds: [],
      activatedZoneIds: [],
      releasedZoneIds: [],
      withheldZoneIds: [],
      upserts: [],
      removedEntityIds: [],
      visibleZoneCount: 5,
      readyVisibleZoneCount: 2,
      backgroundZoneCount: 3,
      readyBackgroundZoneCount: 1,
      zoneSnapshots: [],
      preparationReason: "initial-world-generation",
      preparationResult: "pending",
      partial: true,
      terminal: false
    };
    expect(deliveryClassFor(pending)).toBe("replaceable-population");
    expect(sendModeForDeliveryClass(deliveryClassFor(pending)))
      .toBe("replaceable");
    for (const preparationResult of [
      "retryable-failure",
      "stale",
      "cancelled"
    ] as const) {
      expect(deliveryClassFor({
        ...pending,
        preparationResult,
        partial: false,
        terminal: true
      })).toBe("terminal-population");
    }
  });

  it("preserves explicit local-social and state-stream overrides", () => {
    expect(deliveryClassFor(
      { type: "PONG", clientTime: 1, serverTime: 2 },
      "replaceable"
    )).toBe("replaceable-world");
    expect(deliveryClassFor(
      { type: "CHAT_MESSAGE", message: {} as never },
      "transient-social"
    )).toBe("transient-social");
  });

  it("keeps loot snapshots replaceable while pickup results stay critical", () => {
    expect(deliveryClassFor({
      type: "DROPPED_ITEMS_SNAPSHOT",
      drops: [],
      serverTime: 1
    })).toBe("replaceable-world");
    expect(SERVER_MESSAGE_DELIVERY_POLICY.DROPPED_ITEM_PICKUP_RESULT).toBe("critical");
  });
});
