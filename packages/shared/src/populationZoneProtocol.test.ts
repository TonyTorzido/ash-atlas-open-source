import { describe, expect, it } from "vitest";

import {
  parseClientMessage,
  parseServerMessage,
  ServerMessageParseError,
  serializeServerMessage,
  type ServerMessage
} from "./protocol.js";

describe("population zone protocol", () => {
  it("serializes and parses a revision-bound authoritative activation delta", () => {
    const message = {
      type: "POPULATION_ZONE_DELTA",
      playerId: "player-1",
      connectionId: "connection-1",
      connectionGeneration: 3,
      preparationGeneration: 8,
      preparationTrigger: "flag-placement",
      preparationScope: "required-visible",
      requiredForGameplay: true,
      relocationRevision: 4,
      resourceVisionRevision: 7,
      gameplayViewGeneration: 9,
      retainedZoneIds: ["zone-a"],
      activatedZoneIds: ["zone-b"],
      releasedZoneIds: ["zone-c"],
      withheldZoneIds: [],
      upserts: [{
        entityId: "population:tree:1",
        zoneId: "zone-b",
        generationId: "generation-b",
        kind: "tree",
        archetype: "pine",
        position: { lat: 35.1, lon: -106.6 },
        homePosition: { lat: 35.1, lon: -106.6 },
        stateRevision: 2
      }],
      removedEntityIds: ["population:stone:2"],
      visibleZoneCount: 3,
      readyVisibleZoneCount: 2,
      backgroundZoneCount: 5,
      readyBackgroundZoneCount: 1,
      zoneSnapshots: [{
        zoneId: "zone-b",
        generationId: "generation-b",
        entityIds: ["population:tree:1"]
      }],
      preparationReason: "durable-rehydration",
      preparationResult: "pending",
      partial: true,
      terminal: false
    } satisfies Extract<ServerMessage, { type: "POPULATION_ZONE_DELTA" }>;

    expect(JSON.parse(serializeServerMessage(message))).toEqual(message);
    expect(parseServerMessage(JSON.stringify(message))).toEqual(message);
  });

  it("rejects impossible visible-zone progress", () => {
    const message = {
      type: "POPULATION_ZONE_DELTA",
      playerId: "player-1",
      connectionId: "connection-1",
      connectionGeneration: 3,
      preparationGeneration: 8,
      preparationTrigger: "flag-placement",
      preparationScope: "required-visible",
      requiredForGameplay: true,
      relocationRevision: 4,
      resourceVisionRevision: 7,
      gameplayViewGeneration: 9,
      retainedZoneIds: [],
      activatedZoneIds: [],
      releasedZoneIds: [],
      withheldZoneIds: [],
      upserts: [],
      removedEntityIds: [],
      visibleZoneCount: 1,
      readyVisibleZoneCount: 2,
      backgroundZoneCount: 0,
      readyBackgroundZoneCount: 0,
      zoneSnapshots: [],
      preparationResult: "pending",
      partial: true,
      terminal: false
    };

    expect(() => parseServerMessage(JSON.stringify(message))).toThrow(
      ServerMessageParseError
    );
  });

  it("accepts fenced terminal cancellation and rejects non-terminal failure", () => {
    const cancelled = {
      type: "POPULATION_ZONE_DELTA",
      playerId: "player-1",
      connectionId: "connection-2",
      connectionGeneration: 4,
      preparationGeneration: 9,
      preparationTrigger: "reconnect",
      preparationScope: "required-visible",
      requiredForGameplay: true,
      relocationRevision: 5,
      resourceVisionRevision: 8,
      gameplayViewGeneration: 10,
      retainedZoneIds: [],
      activatedZoneIds: [],
      releasedZoneIds: [],
      withheldZoneIds: [],
      upserts: [],
      removedEntityIds: [],
      visibleZoneCount: 2,
      readyVisibleZoneCount: 1,
      backgroundZoneCount: 3,
      readyBackgroundZoneCount: 0,
      zoneSnapshots: [],
      preparationReason: "cancelled",
      preparationResult: "cancelled",
      partial: false,
      terminal: true
    };

    expect(parseServerMessage(JSON.stringify(cancelled))).toEqual(cancelled);
    expect(() => parseServerMessage(JSON.stringify({
      ...cancelled,
      preparationResult: "retryable-failure",
      terminal: false
    }))).toThrow(ServerMessageParseError);
  });

  it("requires degraded zones to be explicitly withheld and released", () => {
    const degraded = {
      type: "POPULATION_ZONE_DELTA",
      playerId: "player-1",
      connectionId: "connection-2",
      connectionGeneration: 4,
      preparationGeneration: 9,
      preparationTrigger: "world-entry",
      preparationScope: "required-visible",
      requiredForGameplay: true,
      relocationRevision: 5,
      resourceVisionRevision: 8,
      gameplayViewGeneration: 10,
      retainedZoneIds: ["zone-healthy"],
      activatedZoneIds: [],
      releasedZoneIds: ["zone-bad"],
      withheldZoneIds: ["zone-bad"],
      upserts: [],
      removedEntityIds: [],
      visibleZoneCount: 2,
      readyVisibleZoneCount: 1,
      backgroundZoneCount: 0,
      readyBackgroundZoneCount: 0,
      zoneSnapshots: [],
      preparationReason: "generation-missing",
      preparationResult: "degraded",
      partial: false,
      terminal: true
    };
    expect(parseServerMessage(JSON.stringify(degraded))).toEqual(degraded);
    expect(() => parseServerMessage(JSON.stringify({
      ...degraded,
      releasedZoneIds: []
    }))).toThrow(ServerMessageParseError);
  });

  it("accepts a fenced population recovery intent without client player authority", () => {
    const request = {
      type: "REQUEST_POPULATION_RESYNC",
      requestId: "population-resync-1",
      connectionId: "connection-2",
      connectionGeneration: 4,
      preparationGeneration: 9,
      relocationRevision: 5,
      resourceVisionRevision: 8,
      preparationTrigger: "reconnect",
      preparationScope: "required-visible"
    };
    expect(parseClientMessage(JSON.stringify(request))).toEqual(request);
    expect(() => parseClientMessage(JSON.stringify({
      ...request,
      playerId: "forged-player"
    }))).toThrow();
  });

  it("accepts a correlated authoritative population recovery result", () => {
    const result = {
      type: "POPULATION_RESYNC_RESULT",
      requestId: "population-resync-1",
      outcome: "republished",
      playerId: "player-1",
      connectionId: "connection-2",
      connectionGeneration: 4,
      requestedPreparationGeneration: 9,
      currentPreparationGeneration: 10,
      requestedRelocationRevision: 5,
      currentRelocationRevision: 5,
      requestedResourceVisionRevision: 8,
      currentResourceVisionRevision: 8,
      preparationReason: "durable-rehydration",
      preparationResult: "pending",
      visibleZoneCount: 5,
      readyVisibleZoneCount: 3,
      terminal: false
    } satisfies Extract<
      ServerMessage,
      { type: "POPULATION_RESYNC_RESULT" }
    >;
    expect(parseServerMessage(JSON.stringify(result))).toEqual(result);
    expect(() => parseServerMessage(JSON.stringify({
      ...result,
      readyVisibleZoneCount: 6
    }))).toThrow(ServerMessageParseError);
  });
});
