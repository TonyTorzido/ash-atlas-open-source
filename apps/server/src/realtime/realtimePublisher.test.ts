import type { ServerMessage } from "@ash-atlas/shared";
import { describe, expect, it, vi } from "vitest";

import {
  RealtimePublisher,
  directPublisherMetricsSnapshot,
  publishDirectServerMessage
} from "./realtimePublisher.js";

describe("RealtimePublisher", () => {
  it("serializes one broadcast payload and records bounded delivery metrics", () => {
    const publisher = new RealtimePublisher();
    const deliver = vi.fn((connectionId: string, payload: string) => ({
      result: connectionId === "slow" ? "backpressure-skipped" as const : "sent" as const,
      bufferedAmount: connectionId === "slow" ? 200 : 0,
      backpressureClosure: false,
      sendFailure: false,
      payload
    }));

    const results = publisher.publish(
      ["healthy", "slow"],
      { type: "PLAYER_DELTA", serverTime: 1, sequence: 1, upserts: [], removedPlayerIds: [] },
      deliver,
      { broadcast: true }
    );

    expect(results).toEqual(new Map([
      ["healthy", "sent"],
      ["slow", "backpressure-skipped"]
    ]));
    expect(deliver).toHaveBeenCalledTimes(2);
    expect(deliver.mock.calls[0]?.[1]).toBe(deliver.mock.calls[1]?.[1]);
    expect(publisher.metricsSnapshot()).toMatchObject({
      framesByMessageType: { PLAYER_DELTA: 2 },
      framesByDeliveryClass: { "replaceable-world": 2 },
      skippedFrames: 1,
      broadcasts: 1,
      broadcastRecipients: 2,
      maximumBroadcastRecipients: 2,
      maximumBufferedAmount: 200
    });
  });

  it("applies delivery policy and metrics to request-scoped socket replies", () => {
    const sent: string[] = [];
    const socket = {
      readyState: 1,
      bufferedAmount: 0,
      send: (payload: string) => sent.push(payload),
      close: vi.fn()
    };
    const before = directPublisherMetricsSnapshot();

    expect(publishDirectServerMessage(socket, {
      type: "ERROR",
      code: "TEST",
      message: "test reply"
    })).toBe("sent");
    expect(JSON.parse(sent[0]!)).toMatchObject({ type: "ERROR", code: "TEST" });
    const after = directPublisherMetricsSnapshot();
    expect(after.framesByMessageType.ERROR).toBe(
      (before.framesByMessageType.ERROR ?? 0) + 1
    );
    expect(after.framesByDeliveryClass.critical).toBe(
      before.framesByDeliveryClass.critical + 1
    );
  });

  it("allows pending population frames to yield to backpressure but forces terminals critical", () => {
    const publisher = new RealtimePublisher();
    const modes: string[] = [];
    const deliver = vi.fn((
      _connectionId: string,
      _payload: string,
      mode: string
    ) => {
      modes.push(mode);
      return {
        result: mode === "replaceable"
          ? "backpressure-skipped" as const
          : "sent" as const,
        bufferedAmount: 200,
        backpressureClosure: false,
        sendFailure: false
      };
    });
    const pending = populationFrame();

    expect(publisher.publish(["connection-1"], pending, deliver)
      .get("connection-1")).toBe("backpressure-skipped");
    expect(publisher.publish(
      ["connection-1"],
      {
        ...pending,
        preparationResult: "ready",
        partial: false,
        terminal: true
      },
      deliver,
      { mode: "replaceable" }
    ).get("connection-1")).toBe("sent");
    expect(modes).toEqual(["replaceable", "critical"]);
    expect(publisher.metricsSnapshot()).toMatchObject({
      framesByDeliveryClass: {
        "replaceable-population": 1,
        "terminal-population": 1
      },
      skippedFrames: 1
    });
  });
});

function populationFrame(): Extract<
  ServerMessage,
  { type: "POPULATION_ZONE_DELTA" }
> {
  return {
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
    visibleZoneCount: 4,
    readyVisibleZoneCount: 1,
    backgroundZoneCount: 0,
    readyBackgroundZoneCount: 0,
    zoneSnapshots: [],
    preparationReason: "initial-world-generation",
    preparationResult: "pending",
    partial: true,
    terminal: false
  };
}
