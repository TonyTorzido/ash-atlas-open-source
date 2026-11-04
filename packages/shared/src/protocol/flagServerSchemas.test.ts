import { describe, expect, it } from "vitest";

import { parseServerMessage } from "./serverMessageParser.js";

describe("flag construction server messages", () => {
  it("preserves combat destruction separately from ordinary removal for final HP feedback", () => {
    expect(parseServerMessage(JSON.stringify({
      type: "FLAG_DELETED", flagId: "tower-1", reason: "destroyed", flagSetRevision: 42
    }))).toEqual({ type: "FLAG_DELETED", flagId: "tower-1", reason: "destroyed", flagSetRevision: 42 });
  });

  it("parses the durable Flag burn lifecycle and victim notice", () => {
    expect(parseServerMessage(JSON.stringify({
      type: "FLAG_BURN_STARTED",
      operationId: "op-1",
      requestId: "request-1",
      flagId: "flag-1",
      flagName: "Northwatch",
      startedAt: 1_000,
      completesAt: 26_000,
      durationMs: 25_000,
      serverTime: 1_001,
      position: { lat: 40, lon: -105 }
    }))).toMatchObject({ type: "FLAG_BURN_STARTED", durationMs: 25_000 });
    expect(parseServerMessage(JSON.stringify({
      type: "FLAG_BURN_NOTICE",
      operationId: "op-1",
      flagId: "flag-1",
      flagName: "Northwatch",
      message: "A player began burning your Flag.",
      completesAt: 26_000,
      serverTime: 1_002
    }))).toMatchObject({ type: "FLAG_BURN_NOTICE", flagName: "Northwatch" });
  });

  it("parses reinforcement start and cancellation lifecycle frames", () => {
    expect(parseServerMessage(JSON.stringify({ type: "FLAG_REINFORCEMENT_STARTED", requestId: "request-1", flagId: "flag-1", flagName: "Home", startedAt: 1_000, completesAt: 16_000, durationMs: 15_000, serverTime: 1_001, position: { lat: 40, lon: -105 } }))).toMatchObject({ type: "FLAG_REINFORCEMENT_STARTED", durationMs: 15_000, targetTier: "stone" });
    expect(parseServerMessage(JSON.stringify({ type: "FLAG_REINFORCEMENT_STARTED", requestId: "request-2", flagId: "flag-1", flagName: "Home", startedAt: 1_000, completesAt: 31_000, durationMs: 30_000, serverTime: 1_001, position: { lat: 40, lon: -105 }, targetTier: "tower" }))).toMatchObject({ type: "FLAG_REINFORCEMENT_STARTED", durationMs: 30_000, targetTier: "tower" });
    expect(parseServerMessage(JSON.stringify({ type: "FLAG_REINFORCEMENT_CANCELLED", requestId: "request-1", flagId: "flag-1", reason: "disconnect", serverTime: 2_000 }))).toMatchObject({ type: "FLAG_REINFORCEMENT_CANCELLED", reason: "disconnect" });
  });
  it("preserves an available flag name on queued duplicate-safe state", () => {
    expect(parseServerMessage(JSON.stringify({
      type: "FLAG_BUILD_QUEUED",
      buildId: "build-1",
      requestId: "request-1",
      queuedAt: 1_000,
      flagName: "Northwatch"
    }))).toMatchObject({
      type: "FLAG_BUILD_QUEUED",
      flagName: "Northwatch"
    });
  });

  it("preserves the flag name and authoritative ten-second timing on build start", () => {
    expect(parseServerMessage(JSON.stringify({
      type: "FLAG_BUILD_STARTED",
      buildId: "build-1",
      requestId: "request-1",
      startedAt: 20_000,
      completesAt: 30_000,
      durationMs: 10_000,
      serverTime: 20_000,
      position: { lat: 35.0844, lon: -106.6504 },
      flagName: "Northwatch"
    }))).toMatchObject({
      type: "FLAG_BUILD_STARTED",
      durationMs: 10_000,
      flagName: "Northwatch"
    });
  });
});
