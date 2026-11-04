// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  GameplayLatencyTraceClient,
  type GameplayTraceSnapshot
} from "./gameplayLatencyTrace.js";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("GameplayLatencyTraceClient", () => {
  it("records an App-initiated flag click before transport owns the request", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => activeSnapshot()
    }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new GameplayLatencyTraceClient();
    client.configure("http://127.0.0.1:3001", "csrf");
    await client.start();
    const record = vi.spyOn(client, "record");
    const requestId = "22222222-2222-4222-8222-222222222222";

    expect(client.recordFlagTravelClicked(
      { arrivalKind: "warm" },
      requestId
    )).toBe(true);

    expect(record).toHaveBeenCalledWith(
      "population",
      "flag_travel_clicked",
      { arrivalKind: "warm" },
      { traceId: requestId }
    );
  });

  it("retains flag_visited_received when bounded pending traffic is full", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => activeSnapshot()
    }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new GameplayLatencyTraceClient();
    client.configure("http://127.0.0.1:3001", "csrf");
    await client.start();

    for (let index = 0; index < 199; index += 1) {
      expect(client.record("networking", "ordinary_noise", { index })).toBe(true);
    }
    expect(client.record("networking", "ordinary_overflow")).toBe(false);
    expect(client.recordFlagVisitedReceived({
      flagId: "11111111-1111-4111-8111-111111111111",
      arrivalKind: "warm",
      transitionDurationMs: 42,
      movementBuffered: true,
      worldCalled: false
    }, "22222222-2222-4222-8222-222222222222")).toBe(true);
  });
});

function activeSnapshot(): GameplayTraceSnapshot {
  return {
    schemaVersion: 2,
    active: true,
    sessionTraceId: "11111111-1111-4111-8111-111111111111",
    startedAtIso: "2026-07-19T12:00:00.000Z",
    stoppedAtIso: null,
    events: [],
    failures: [],
    droppedEvents: 0,
    droppedEventsByCategory: {
      movement: 0,
      networking: 0,
      "flag-preparation": 0,
      build: 0,
      world: 0,
      population: 0,
      database: 0,
      ui: 0
    },
    droppedCriticalEvents: 0,
    expiresAtIso: "2026-07-19T12:30:00.000Z",
    releaseIdentity: {
      gameReleaseSha: "a".repeat(40),
      releaseGeneration: "test/t473",
      worldPipelineSha: "b".repeat(40)
    }
  };
}
