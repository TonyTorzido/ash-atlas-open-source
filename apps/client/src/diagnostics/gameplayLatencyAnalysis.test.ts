import { describe, expect, it } from "vitest";

import type {
  GameplayTraceEvent,
  GameplayTraceSnapshot
} from "./gameplayLatencyTrace.js";
import {
  analyzeGameplayTraceBoundaries,
  createGameplayTraceExport
} from "./gameplayLatencyAnalysis.js";

const T473 = {
  gameReleaseSha: "5".repeat(40),
  releaseGeneration: "test/t473",
  worldPipelineSha: "9".repeat(40)
};
const T472 = {
  ...T473,
  gameReleaseSha: "0".repeat(40),
  releaseGeneration: "test/t472"
};

describe("gameplay latency boundary analysis", () => {
  it("uses deterministic nearest-rank p95 and reports the exact sample count", () => {
    const events: GameplayTraceEvent[] = [];
    for (let sample = 1; sample <= 20; sample += 1) {
      const traceId = `warm-${sample}`;
      events.push(
        event(events.length + 1, traceId, "flag_travel_clicked", 1_000, {
          arrivalKind: "warm"
        }),
        event(
          events.length + 2,
          traceId,
          "population_required_visible_applied",
          1_000 + sample / 2,
          { populationState: "warm" }
        ),
        event(
          events.length + 3,
          traceId,
          "flag_visited_received",
          1_000 + sample
        )
      );
    }

    const analysis = analyzeGameplayTraceBoundaries(events);
    expect(analysis).toMatchObject({
      percentileMethod: "nearest-rank",
      durationClock: "same-source-monotonic-otherwise-wall"
    });
    expect(analysis.boundaries.find(({ boundaryId }) =>
      boundaryId === "flag-travel-client-warm"
    )).toMatchObject({
      sampleCount: 20,
      incompleteStartCount: 0,
      minimumMs: 1,
      medianMs: 10,
      p95Ms: 19,
      maximumMs: 20,
      targetP95Ms: 200,
      targetMet: true
    });
  });

  it("accounts for cold click-to-paint and required-visible presentation", () => {
    const events = [
      event(1, "cold-a", "flag_travel_clicked", 100),
      event(2, "cold-a", "population_required_visible_applied", 450, {
        populationState: "cold",
        preparationReason: "initial-world-generation"
      }),
      event(3, "cold-a", "flag_visited_received", 600),
      event(4, "cold-a", "destination_state_committed", 1_180),
      event(5, "cold-a", "first_destination_pixi_paint", 1_185),
      event(6, "cold-a", "population_required_visible_presented", 1_400),
      event(7, "cold-a", "first_post_arrival_move_accepted", 1_450, {}, "game")
    ];

    const boundaries = analyzeGameplayTraceBoundaries(events).boundaries;
    expect(boundaries.find(({ boundaryId }) =>
      boundaryId === "flag-travel-client-cold-first-paint"
    )).toMatchObject({ sampleCount: 1, p95Ms: 1_085 });
    expect(boundaries.find(({ boundaryId }) =>
      boundaryId === "flag-travel-client-required-visible"
    )).toMatchObject({ sampleCount: 1, p95Ms: 1_300 });
    expect(boundaries.find(({ boundaryId }) =>
      boundaryId === "flag-travel-controls-accepted"
    )).toMatchObject({ sampleCount: 1, p95Ms: 1_350 });
  });

  it("pairs boundaries by trace ID and keeps incomplete attempts visible", () => {
    const events = [
      event(1, "server-a", "flag_travel_transition_started", 100, {}, "game"),
      event(2, "server-b", "flag_travel_transition_started", 200, {}, "game"),
      event(3, "server-a", "flag_visited_published", 180, {}, "game"),
      event(4, "zone-a", "population_zone_plan_lookup", 400, {}, "game"),
      event(5, "zone-a", "population_zone_plan_reused", 425, {}, "game"),
      event(6, "zone-b", "population_zone_activation_started", 500, {}, "game"),
      event(7, "zone-b", "population_zone_runtime_rehydrated", 530, {}, "game")
    ];

    const analysis = analyzeGameplayTraceBoundaries(events);
    expect(analysis.boundaries.find(({ boundaryId }) =>
      boundaryId === "flag-travel-server-commit"
    )).toMatchObject({
      sampleCount: 1,
      incompleteStartCount: 1,
      p95Ms: 80,
      targetMet: true
    });
    expect(analysis.boundaries.find(({ boundaryId }) =>
      boundaryId === "population-plan-lookup"
    )).toMatchObject({
      sampleCount: 1,
      p95Ms: 25
    });
    expect(analysis.boundaries.find(({ boundaryId }) =>
      boundaryId === "population-runtime-rehydrate"
    )).toMatchObject({
      sampleCount: 1,
      p95Ms: 30
    });
  });

  it("rejects the cross-release Flag 164 contamination from t472", () => {
    const traceId = "00000000-0000-4000-8000-0000000000b1";
    const events = [
      event(1, traceId, "flag_travel_clicked", 0, {
        arrivalKind: "cold",
        flagId: "00000000-0000-4000-8000-0000000000b2",
        destinationLat: -8.539,
        destinationLon: 115.0023
      }),
      event(2, traceId, "population_required_visible_applied", 3_445, {
        populationState: "cold",
        preparationAuthority: "destination-critical",
        destinationZoneId: "ppz2-eag1/flag/164",
        populationOwnerRequestId: traceId
      }),
      event(3, traceId, "flag_visited_published", 3_500, {
        requestId: traceId,
        flagId: "00000000-0000-4000-8000-0000000000b2",
        destinationLat: -8.539,
        destinationLon: 115.0023,
        destinationZoneId: "ppz2-eag1/flag/164",
        populationOwnerRequestId: traceId,
        relocationRevision: 13
      }, "game")
    ].map((item) => ({ ...item, releaseIdentity: T472 }));
    const snapshot: GameplayTraceSnapshot = {
      schemaVersion: 2,
      active: false,
      sessionTraceId: "session-t473",
      startedAtIso: "2026-08-07T00:00:00.000Z",
      stoppedAtIso: "2026-08-07T00:01:00.000Z",
      events,
      failures: [],
      droppedEvents: 0,
      droppedEventsByCategory: {
        movement: 0, networking: 0, "flag-preparation": 0, build: 0,
        world: 0, population: 0, database: 0, ui: 0
      },
      droppedCriticalEvents: 0,
      expiresAtIso: null,
      releaseIdentity: T473
    };

    const exported = createGameplayTraceExport(snapshot);
    expect(exported.coldVisitValidation.acceptedTraceIds).toEqual([]);
    expect(exported.coldVisitValidation.samples[0]).toMatchObject({
      traceId,
      valid: false,
      rejectionReasons: ["release_or_deployment_boundary_mismatch"]
    });
    expect(exported.boundaryAnalysis.boundaries.find(({ boundaryId }) =>
      boundaryId === "flag-travel-client-cold-first-paint"
    )?.sampleCount).toBe(0);
  });
});

function event(
  sequence: number,
  traceId: string,
  name: string,
  monotonicMs: number,
  details: GameplayTraceEvent["details"] = {},
  source: GameplayTraceEvent["source"] = "client"
): GameplayTraceEvent {
  return {
    sequence,
    sessionTraceId: "session",
    traceId,
    source,
    category: name.startsWith("population_") ? "population" : "movement",
    name,
    wallTimeIso: new Date(1_700_000_000_000 + monotonicMs).toISOString(),
    monotonicMs,
    details,
    failure: false,
    releaseIdentity: T473
  };
}
