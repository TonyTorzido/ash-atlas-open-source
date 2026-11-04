import { describe, expect, it } from "vitest";

import {
  GameplayLatencyTraceStore,
  PROTECTED_GAMEPLAY_TRACE_EVENT_NAMES,
  resolveGameplayTraceReleaseIdentity
} from "./gameplayLatencyTrace.js";

const RELEASE_IDENTITY = {
  gameReleaseSha: "a".repeat(40),
  releaseGeneration: "test/t473",
  worldPipelineSha: "b".repeat(40)
};

describe("GameplayLatencyTraceStore", () => {
  it("ignores stale telemetry generation and uses deployed runtime identity", () => {
    expect(resolveGameplayTraceReleaseIdentity({
      runtimeSha: "2".repeat(40),
      runtimeGeneration: "test/t474",
      telemetryReleaseGeneration: "test/t217",
      worldPipelineSha: "9".repeat(40)
    })).toEqual({
      gameReleaseSha: "2".repeat(40),
      releaseGeneration: "test/t474",
      worldPipelineSha: "9".repeat(40)
    });
    expect(resolveGameplayTraceReleaseIdentity({
      runtimeSha: "2".repeat(40),
      telemetryReleaseGeneration: "test/t217",
      worldPipelineSha: "9".repeat(40)
    })).toBeNull();
    expect(resolveGameplayTraceReleaseIdentity({
      runtimeSha: "3".repeat(40),
      runtimeGeneration: "test/t1000",
      worldPipelineSha: "8".repeat(40)
    })?.releaseGeneration).toBe("test/t1000");
  });

  it("does no work while tracing is disabled", () => {
    const store = new GameplayLatencyTraceStore();
    expect(store.record("player", {
      source: "game",
      category: "movement",
      name: "movement_received"
    })).toBe(false);
    expect(store.snapshot("player").events).toEqual([]);
  });

  it("bounds events and failures and strips private detail keys", () => {
    const store = new GameplayLatencyTraceStore();
    store.start("owner", RELEASE_IDENTITY);
    for (let index = 0; index < 1_100; index += 1) {
      store.record("owner", {
        traceId: `trace-${index}`,
        source: "game",
        category: "flag-preparation",
        name: "quote_failed",
        details: {
          index,
          email: "private@example.test",
          oauthToken: "secret",
          message: "private text",
          outcome: "POSITION_STALE"
        },
        failure: true
      });
    }
    const snapshot = store.snapshot("owner");
    expect(snapshot.events).toHaveLength(1_000);
    expect(snapshot.failures).toHaveLength(25);
    expect(snapshot.droppedEvents).toBeGreaterThan(0);
    expect(snapshot.droppedEventsByCategory["flag-preparation"]).toBeGreaterThan(0);
    expect(snapshot.droppedCriticalEvents).toBeGreaterThan(0);
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain("private@example.test");
    expect(serialized).not.toContain("secret");
    expect(snapshot.failures.at(-1)?.details).toMatchObject({
      index: 1_099,
      outcome: "POSITION_STALE"
    });
  });

  it("reserves bounded retention for quote, Build, and failure events", () => {
    const store = new GameplayLatencyTraceStore();
    store.start("owner", RELEASE_IDENTITY);
    for (let index = 0; index < 2_000; index += 1) {
      store.record("owner", {
        source: "client",
        category: "networking",
        name: "websocket_traffic_summary",
        details: { messageCount: 10 }
      });
    }
    for (let index = 0; index < 300; index += 1) {
      store.record("owner", {
        traceId: `quote-${index}`,
        source: "game",
        category: "flag-preparation",
        name: "quote_response_received",
        details: { totalMs: index }
      });
    }
    store.record("owner", {
      source: "game",
      category: "world",
      name: "world_request_failed",
      details: { wireType: "ERROR" },
      failure: true
    });

    const snapshot = store.snapshot("owner");
    expect(snapshot.events.length).toBeLessThanOrEqual(1_000);
    expect(snapshot.events.filter((event) =>
      event.name === "quote_response_received"
    )).toHaveLength(300);
    expect(snapshot.events).toContainEqual(expect.objectContaining({
      name: "world_request_failed",
      failure: true,
      details: { wireType: "ERROR" }
    }));
    expect(snapshot.droppedEventsByCategory.networking).toBeGreaterThan(0);
    expect(snapshot.droppedCriticalEvents).toBe(0);
  });

  it("stops accepting events after recording is stopped", () => {
    const store = new GameplayLatencyTraceStore();
    store.start("owner", RELEASE_IDENTITY);
    store.stop("owner");
    expect(store.record("owner", {
      source: "game",
      category: "build",
      name: "late_event"
    })).toBe(false);
    expect(store.snapshot("owner").active).toBe(false);
  });

  it("does not evict mandated travel or population boundaries for lower-priority noise", () => {
    const store = new GameplayLatencyTraceStore();
    store.start("owner", RELEASE_IDENTITY);
    for (const name of PROTECTED_GAMEPLAY_TRACE_EVENT_NAMES) {
      store.record("owner", {
        source: name === "flag_visited_received" ? "client" : "game",
        category: name.startsWith("population_") ? "population" : "movement",
        name,
        details: {
          zoneId: "ppz2-eag1/abc/def",
          transitionDurationMs: 42,
          entityPayload: "x".repeat(10_000),
          email: "private@example.test"
        }
      });
    }
    for (let index = 0; index < 2_000; index += 1) {
      store.record("owner", {
        source: "game",
        category: "flag-preparation",
        name: "generic_critical_noise",
        details: { index }
      });
    }
    for (let index = 0; index < 2_000; index += 1) {
      store.record("owner", {
        source: "game",
        category: "population",
        name: "population_zone_retained",
        details: { zoneCount: 1, relocationRevision: index }
      });
    }

    const snapshot = store.snapshot("owner");
    for (const name of PROTECTED_GAMEPLAY_TRACE_EVENT_NAMES) {
      expect(snapshot.events.some((event) => event.name === name)).toBe(true);
    }
    const protectedEvent = snapshot.events.find((event) =>
      event.name === "population_zone_plan_lookup"
    );
    expect(protectedEvent?.details).toEqual({
      zoneId: "ppz2-eag1/abc/def",
      transitionDurationMs: 42
    });
    expect(JSON.stringify(snapshot)).not.toContain("entityPayload");
    expect(JSON.stringify(snapshot)).not.toContain("private@example.test");
  });
});
