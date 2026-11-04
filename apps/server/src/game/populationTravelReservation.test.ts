import { describe, expect, it, vi } from "vitest";

import {
  PopulationSoftTravelReservationManager,
  classifyPopulationTravelPreparationReasons,
  populationTravelSourceId,
  reservePopulationTravelArea
} from "./populationTravelReservation.js";

const AREA = {
  center: { lat: 35.123, lon: -106.456 },
  certifiedVisibleRadiusM: 650,
  preparedRadiusM: 750,
  sourceType: "flag" as const,
  sourceId: "flag-1",
  generation: 8
};

describe("population travel reservation", () => {
  it("cannot adopt before destination preparation completes", async () => {
    let resolvePreparation!: (value: {
      sourceId: string;
      zoneIds: [];
      outcomes: [];
    }) => void;
    const releaseSource = vi.fn(() => true);
    const reservation = reservePopulationTravelArea({
      hooks: {
        prepareArea: vi.fn(() => new Promise((resolve) => {
          resolvePreparation = resolve;
        })),
        releaseSource,
        adoptSource: vi.fn(() => "adopted")
      } as never,
      area: AREA,
      kind: "flag-travel",
      playerId: "player-1",
      connectionId: "connection-1",
      connectionGeneration: 4,
      travelId: "travel-early",
      expectedRelocationRevision: 9,
      expectedResourceVisionRevision: 11,
      expectedGameplayViewGeneration: 8
    });

    expect(reservation.adopt({
      relocationRevision: 9,
      resourceVisionRevision: 11,
      gameplayViewGeneration: 8,
      area: AREA
    })).toBe("pending");
    expect(releaseSource).not.toHaveBeenCalled();
    resolvePreparation({
      sourceId: reservation.sourceId,
      zoneIds: [],
      outcomes: []
    });
    await expect(reservation.preparation).resolves.toEqual({
      status: "ready",
      zoneIds: [],
      authorities: []
    });
    expect(reservation.adopt({
      relocationRevision: 9,
      resourceVisionRevision: 11,
      gameplayViewGeneration: 8,
      area: AREA
    })).toBe("adopted");
  });

  it("prepares only the exact visible destination at durable readiness", async () => {
    const prepareArea = vi.fn(async () => ({
      sourceId: "source",
      zoneIds: [],
      outcomes: []
    }));
    const reservation = reservePopulationTravelArea({
      hooks: {
        prepareArea,
        releaseSource: vi.fn(() => true),
        adoptSource: vi.fn(() => "adopted")
      } as never,
      area: AREA,
      kind: "shrine-travel",
      playerId: "player-1",
      connectionId: "connection-1",
      connectionGeneration: 4,
      travelId: "travel-1",
      expectedRelocationRevision: 9,
      expectedResourceVisionRevision: 11,
      expectedGameplayViewGeneration: 8,
      now: 1_000
    });

    await reservation.preparation;

    const sourceId = populationTravelSourceId("player-1", 4, "travel-1");
    expect(reservation.sourceId).toBe(sourceId);
    expect(prepareArea).toHaveBeenCalledTimes(1);
    expect(prepareArea).toHaveBeenCalledWith(expect.objectContaining({
      area: AREA,
      source: expect.objectContaining({
        sourceId,
        kind: "shrine-travel",
        targetStage: "DURABLE_READY",
        priority: 1,
        playerId: "player-1",
        connectionId: "connection-1",
        connectionGeneration: 4,
        travelId: "travel-1"
      })
    }));
  });

  it("adopts only the matching committed visible source", async () => {
    const adoptSource = vi.fn(() => "adopted" as const);
    const releaseSource = vi.fn(() => true);
    const reservation = reservePopulationTravelArea({
      hooks: {
        prepareArea: vi.fn(async () => ({
          sourceId: "source",
          zoneIds: [],
          outcomes: []
        })),
        releaseSource,
        adoptSource
      } as never,
      area: AREA,
      kind: "city-travel",
      playerId: "player-1",
      connectionId: "connection-1",
      connectionGeneration: 4,
      travelId: "travel-2",
      expectedRelocationRevision: 9,
      expectedResourceVisionRevision: 11,
      expectedGameplayViewGeneration: 8,
      now: 1_000
    });
    await reservation.preparation;

    expect(reservation.adopt({
      relocationRevision: 9,
      resourceVisionRevision: 11,
      gameplayViewGeneration: 8,
      area: AREA
    })).toBe("adopted");
    expect(adoptSource).toHaveBeenCalledTimes(1);
    expect(adoptSource).toHaveBeenCalledWith(expect.objectContaining({
      adoptedSourceId: "player-visible:player-1:4:9:travel-2",
      adoptedKind: "player-visible",
      expectedTravelId: "travel-2",
      requireReadyAuthority: true
    }));
    expect(releaseSource).not.toHaveBeenCalled();
  });

  it("keeps one exact source while an expired generation rolls over", async () => {
    const releaseSource = vi.fn(() => true);
    let attempt = 0;
    const prepareArea = vi.fn(async (input: {
      source: { sourceId: string; authorityToken: string };
    }) => {
      attempt += 1;
      return attempt === 1
        ? {
            sourceId: input.source.sourceId,
            zoneIds: ["zone-pending"],
            outcomes: [{
              zoneId: "zone-pending",
              requestedStage: "DURABLE_READY",
              completedStage: "PLAN_READY",
              status: "deferred",
              reason: "generation-expired",
              authority: null,
              durationMs: 12
            }]
          }
        : {
            sourceId: input.source.sourceId,
            zoneIds: [],
            outcomes: []
          };
    });
    const reservation = reservePopulationTravelArea({
      hooks: {
        prepareArea,
        releaseSource,
        adoptSource: vi.fn(() => "adopted")
      } as never,
      area: AREA,
      kind: "flag-travel",
      playerId: "player-1",
      connectionId: "connection-1",
      connectionGeneration: 4,
      travelId: "travel-pending",
      expectedRelocationRevision: 9,
      expectedResourceVisionRevision: 11,
      expectedGameplayViewGeneration: 8,
      now: 1_000
    });

    await expect(reservation.preparation).resolves.toEqual({
      status: "not-ready",
      reasons: ["generation-expired"],
      pendingZoneIds: ["zone-pending"]
    });
    expect(releaseSource).not.toHaveBeenCalled();
    await expect(reservation.ensureDurable()).resolves.toEqual({
      status: "ready",
      zoneIds: [],
      authorities: []
    });
    expect(prepareArea).toHaveBeenCalledTimes(2);
    expect(new Set(prepareArea.mock.calls.map(
      ([request]) => request.source.sourceId
    ))).toEqual(new Set([reservation.sourceId]));
    expect(new Set(prepareArea.mock.calls.map(
      ([request]) => request.source.authorityToken
    )).size).toBe(1);
  });

  it("promotes an occupied expired generation without waiting on durable readiness", async () => {
    const prepareArea = vi.fn(async (input: {
      source: { sourceId: string; targetStage: string };
    }) => input.source.targetStage === "DURABLE_READY"
      ? {
          sourceId: input.source.sourceId,
          zoneIds: ["zone-expired"],
          outcomes: [{
            zoneId: "zone-expired",
            requestedStage: "DURABLE_READY",
            completedStage: "PLAN_READY",
            status: "deferred",
            reason: "generation-expired",
            authority: null,
            durationMs: 2
          }]
        }
      : {
          sourceId: input.source.sourceId,
          zoneIds: [],
          outcomes: []
        });
    const reservation = reservePopulationTravelArea({
      hooks: {
        prepareArea,
        releaseSource: vi.fn(() => true),
        adoptSource: vi.fn(() => "adopted")
      } as never,
      area: AREA,
      kind: "flag-travel",
      playerId: "player-1",
      connectionId: "connection-1",
      connectionGeneration: 4,
      travelId: "travel-expired-generation",
      expectedRelocationRevision: 9,
      expectedResourceVisionRevision: 11,
      expectedGameplayViewGeneration: 8
    });

    await expect(reservation.ensureSimulation(challengeProfile(7))).resolves
      .toMatchObject({ status: "ready" });
    expect(prepareArea.mock.calls.map(
      ([request]) => request.source.targetStage
    )).toEqual(["DURABLE_READY", "SIMULATION_READY"]);
  });

  it("retries simulation with the same frozen profile and shares each in-flight attempt", async () => {
    const simulation = deferred<{
      sourceId: string;
      zoneIds: ["zone-pending"];
      outcomes: [{
        zoneId: "zone-pending";
        requestedStage: "SIMULATION_READY";
        completedStage: "DURABLE_READY";
        status: "pending";
        reason: "simulation-activation";
        authority: null;
        durationMs: 3;
      }];
    }>();
    let simulationAttempt = 0;
    const prepareArea = vi.fn((input: {
      source: { sourceId: string; targetStage: string; challengeProfile?: unknown };
    }) => {
      if (input.source.targetStage === "DURABLE_READY") {
        return Promise.resolve({
          sourceId: input.source.sourceId,
          zoneIds: [],
          outcomes: []
        });
      }
      simulationAttempt += 1;
      if (simulationAttempt === 1) return simulation.promise;
      return Promise.resolve({
        sourceId: input.source.sourceId,
        zoneIds: [],
        outcomes: []
      });
    });
    const releaseSource = vi.fn(() => true);
    const reservation = reservePopulationTravelArea({
      hooks: {
        prepareArea,
        releaseSource,
        adoptSource: vi.fn(() => "adopted")
      } as never,
      area: AREA,
      kind: "flag-travel",
      playerId: "player-1",
      connectionId: "connection-1",
      connectionGeneration: 4,
      travelId: "travel-simulation-retry",
      expectedRelocationRevision: 9,
      expectedResourceVisionRevision: 11,
      expectedGameplayViewGeneration: 8
    });
    await reservation.ensureDurable();
    const profile = challengeProfile(7);
    const first = reservation.ensureSimulation(profile);
    const shared = reservation.ensureSimulation(profile);
    expect(shared).toBe(first);
    simulation.resolve({
      sourceId: reservation.sourceId,
      zoneIds: ["zone-pending"],
      outcomes: [{
        zoneId: "zone-pending",
        requestedStage: "SIMULATION_READY",
        completedStage: "DURABLE_READY",
        status: "pending",
        reason: "simulation-activation",
        authority: null,
        durationMs: 3
      }]
    });
    await expect(first).resolves.toMatchObject({ status: "not-ready" });
    await expect(reservation.ensureSimulation(challengeProfile(7))).resolves
      .toMatchObject({ status: "ready" });
    expect(releaseSource).not.toHaveBeenCalled();
    const simulationCalls = prepareArea.mock.calls.filter(
      ([request]) => request.source.targetStage === "SIMULATION_READY"
    );
    expect(simulationCalls).toHaveLength(2);
    expect(simulationCalls.map(
      ([request]) => request.source.challengeProfile
    )).toEqual([profile, profile]);
  });

  it("caches ready stages and preserves the original expiry across retries", async () => {
    const prepareArea = vi.fn(async (input: {
      source: { sourceId: string; expiresAtMs: number };
    }) => ({
      sourceId: input.source.sourceId,
      zoneIds: [],
      outcomes: []
    }));
    const reservation = reservePopulationTravelArea({
      hooks: {
        prepareArea,
        releaseSource: vi.fn(() => true),
        adoptSource: vi.fn(() => "adopted")
      } as never,
      area: AREA,
      kind: "flag-travel",
      playerId: "player-1",
      connectionId: "connection-1",
      connectionGeneration: 4,
      travelId: "travel-cache",
      expectedRelocationRevision: 9,
      expectedResourceVisionRevision: 11,
      expectedGameplayViewGeneration: 8,
      now: 1_000,
      ttlMs: 500
    });
    const durable = await reservation.ensureDurable();
    expect(await reservation.ensureDurable()).toBe(durable);
    const simulation = await reservation.ensureSimulation(challengeProfile(10));
    expect(await reservation.ensureSimulation(challengeProfile(10)))
      .toBe(simulation);
    expect(new Set(prepareArea.mock.calls.map(
      ([request]) => request.source.expiresAtMs
    ))).toEqual(new Set([1_500]));
    expect(prepareArea).toHaveBeenCalledTimes(2);
  });

  it("never returns cached readiness after release or adoption", async () => {
    const readyHooks = () => ({
      prepareArea: vi.fn(async (input: {
        source: { sourceId: string };
      }) => ({
        sourceId: input.source.sourceId,
        zoneIds: [],
        outcomes: []
      })),
      releaseSource: vi.fn(() => true),
      adoptSource: vi.fn(() => "adopted" as const)
    });
    const createReservation = (
      travelId: string,
      hooks: ReturnType<typeof readyHooks>
    ) => reservePopulationTravelArea({
      hooks: hooks as never,
      area: AREA,
      kind: "flag-travel",
      playerId: "player-1",
      connectionId: "connection-1",
      connectionGeneration: 4,
      travelId,
      expectedRelocationRevision: 9,
      expectedResourceVisionRevision: 11,
      expectedGameplayViewGeneration: 8
    });

    const releasedHooks = readyHooks();
    const released = createReservation("travel-cache-released", releasedHooks);
    await released.ensureSimulation(challengeProfile(10));
    expect(released.release("test-release")).toBe(true);
    await expect(released.ensureDurable()).resolves.toEqual({
      status: "not-ready",
      reasons: ["cancelled"],
      pendingZoneIds: []
    });
    await expect(
      released.ensureSimulation(challengeProfile(10))
    ).resolves.toEqual({
      status: "not-ready",
      reasons: ["cancelled"],
      pendingZoneIds: []
    });
    expect(releasedHooks.prepareArea).toHaveBeenCalledTimes(2);

    const adoptedHooks = readyHooks();
    const adopted = createReservation("travel-cache-adopted", adoptedHooks);
    await adopted.ensureSimulation(challengeProfile(10));
    expect(adopted.adopt({
      relocationRevision: 9,
      resourceVisionRevision: 11,
      gameplayViewGeneration: 8,
      area: AREA
    })).toBe("adopted");
    await expect(adopted.ensureDurable()).resolves.toMatchObject({
      status: "not-ready",
      reasons: ["cancelled"]
    });
    await expect(
      adopted.ensureSimulation(challengeProfile(10))
    ).resolves.toMatchObject({
      status: "not-ready",
      reasons: ["cancelled"]
    });
    expect(adoptedHooks.prepareArea).toHaveBeenCalledTimes(2);
  });

  it("checks profile identity before returning cached simulation readiness", async () => {
    const releaseSource = vi.fn(() => true);
    const prepareArea = vi.fn(async (input: {
      source: { sourceId: string };
    }) => ({
      sourceId: input.source.sourceId,
      zoneIds: [],
      outcomes: []
    }));
    const reservation = reservePopulationTravelArea({
      hooks: {
        prepareArea,
        releaseSource,
        adoptSource: vi.fn(() => "adopted")
      } as never,
      area: AREA,
      kind: "flag-travel",
      playerId: "player-1",
      connectionId: "connection-1",
      connectionGeneration: 4,
      travelId: "travel-cache-profile-mismatch",
      expectedRelocationRevision: 9,
      expectedResourceVisionRevision: 11,
      expectedGameplayViewGeneration: 8
    });

    await expect(
      reservation.ensureSimulation(challengeProfile(10))
    ).resolves.toMatchObject({ status: "ready" });
    await expect(
      reservation.ensureSimulation(challengeProfile(11))
    ).resolves.toEqual({
      status: "not-ready",
      reasons: ["stale-authority"],
      pendingZoneIds: []
    });
    expect(prepareArea).toHaveBeenCalledTimes(2);
    expect(releaseSource).toHaveBeenCalledOnce();
  });

  it("classifies retryable and terminal reasons exhaustively and fails closed", () => {
    expect(classifyPopulationTravelPreparationReasons([
      "plan-pending",
      "guarded-materialization"
    ])).toBe("retryable");
    expect(classifyPopulationTravelPreparationReasons([
      "simulation-activation",
      "stale-authority"
    ])).toBe("terminal");
    expect(classifyPopulationTravelPreparationReasons([
      "plan-terminal-failure"
    ])).toBe("terminal");
    expect(classifyPopulationTravelPreparationReasons(["ready"]))
      .toBe("invariant");
    expect(classifyPopulationTravelPreparationReasons([
      "future-reason" as never
    ])).toBe("unknown");
    expect(classifyPopulationTravelPreparationReasons([])).toBe("unknown");
  });

  it("releases a mixed terminal result exactly once", async () => {
    const releaseSource = vi.fn(() => true);
    const reservation = reservePopulationTravelArea({
      hooks: {
        prepareArea: vi.fn(async (input) => ({
          sourceId: input.source.sourceId,
          zoneIds: ["retryable-zone", "terminal-zone"],
          outcomes: [{
            zoneId: "retryable-zone",
            requestedStage: "DURABLE_READY",
            completedStage: "PLAN_READY",
            status: "pending",
            reason: "plan-pending",
            authority: null,
            durationMs: 1
          }, {
            zoneId: "terminal-zone",
            requestedStage: "DURABLE_READY",
            completedStage: "PLAN_READY",
            status: "stale",
            reason: "stale-authority",
            authority: null,
            durationMs: 1
          }]
        })),
        releaseSource,
        adoptSource: vi.fn(() => "adopted")
      } as never,
      area: AREA,
      kind: "flag-travel",
      playerId: "player-1",
      connectionId: "connection-1",
      connectionGeneration: 4,
      travelId: "travel-terminal",
      expectedRelocationRevision: 9,
      expectedResourceVisionRevision: 11,
      expectedGameplayViewGeneration: 8
    });
    await expect(reservation.ensureDurable()).resolves.toMatchObject({
      status: "not-ready",
      reasons: ["plan-pending", "stale-authority"]
    });
    expect(releaseSource).toHaveBeenCalledOnce();
    expect(reservation.release()).toBe(false);
  });

  it("aborts once and adopts exact ownership once", async () => {
    const abort = new AbortController();
    const releaseSource = vi.fn(() => true);
    const pending = deferred<{
      sourceId: string;
      zoneIds: [];
      outcomes: [];
    }>();
    const aborted = reservePopulationTravelArea({
      hooks: {
        prepareArea: vi.fn(() => pending.promise),
        releaseSource,
        adoptSource: vi.fn(() => "adopted")
      } as never,
      area: AREA,
      kind: "flag-travel",
      playerId: "player-1",
      connectionId: "connection-1",
      connectionGeneration: 4,
      travelId: "travel-abort",
      expectedRelocationRevision: 9,
      expectedResourceVisionRevision: 11,
      expectedGameplayViewGeneration: 8,
      signal: abort.signal
    });
    abort.abort();
    expect(releaseSource).toHaveBeenCalledOnce();
    pending.resolve({
      sourceId: aborted.sourceId,
      zoneIds: [],
      outcomes: []
    });
    await aborted.preparation;
    expect(releaseSource).toHaveBeenCalledOnce();

    const adoptSource = vi.fn(() => "adopted" as const);
    const adopted = reservePopulationTravelArea({
      hooks: {
        prepareArea: vi.fn(async (input) => ({
          sourceId: input.source.sourceId,
          zoneIds: [],
          outcomes: []
        })),
        releaseSource: vi.fn(() => true),
        adoptSource
      } as never,
      area: AREA,
      kind: "flag-travel",
      playerId: "player-1",
      connectionId: "connection-1",
      connectionGeneration: 4,
      travelId: "travel-adopt-once",
      expectedRelocationRevision: 9,
      expectedResourceVisionRevision: 11,
      expectedGameplayViewGeneration: 8
    });
    await adopted.ensureDurable();
    await adopted.ensureSimulation(challengeProfile(7));
    const adoption = {
      relocationRevision: 9,
      resourceVisionRevision: 11,
      gameplayViewGeneration: 8,
      area: AREA
    };
    expect(adopted.adopt(adoption)).toBe("adopted");
    expect(adopted.adopt(adoption)).toBe("adopted");
    expect(adoptSource).toHaveBeenCalledOnce();
  });

  it("releases stale or cancelled reservations without publishing", async () => {
    const releaseSource = vi.fn(() => true);
    const reservation = reservePopulationTravelArea({
      hooks: {
        prepareArea: vi.fn(async () => ({
          sourceId: "source",
          zoneIds: [],
          outcomes: []
        })),
        releaseSource,
        adoptSource: vi.fn(() => "adopted")
      } as never,
      area: AREA,
      kind: "party-travel",
      playerId: "player-1",
      connectionId: "connection-1",
      connectionGeneration: 4,
      travelId: "travel-3",
      expectedRelocationRevision: 9,
      expectedResourceVisionRevision: 11,
      expectedGameplayViewGeneration: 8,
      now: 1_000
    });
    await reservation.preparation;

    expect(reservation.adopt({
      relocationRevision: 9,
      resourceVisionRevision: 11,
      gameplayViewGeneration: 7,
      area: AREA
    })).toBe("rejected");
    expect(releaseSource).toHaveBeenCalledTimes(1);
    expect(reservation.release()).toBe(false);
  });
});

describe("soft population travel reservations", () => {
  it("admits visible durable work without speculative simulation activation", async () => {
    vi.useFakeTimers();
    try {
      const durable = deferred<{
        sourceId: string;
        zoneIds: [];
        outcomes: [];
      }>();
      const prepareArea = vi.fn(() => durable.promise);
      const manager = softManager(
        { prepareArea },
        { autoPromote: false }
      );

      expect(manager.prepare(softInput("travel-1"))).toBe("admitted");
      expect(prepareArea).toHaveBeenCalledTimes(1);
      expect(prepareArea).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          area: AREA,
          source: expect.objectContaining({
            targetStage: "DURABLE_READY"
          })
        })
      );
      expect(manager.snapshot()).toMatchObject({
        reservations: 1,
        durableFlights: 1,
        promotions: 0,
        referencedZones: 1
      });

      await vi.advanceTimersByTimeAsync(3_750);
      expect(prepareArea).toHaveBeenCalledTimes(1);
      durable.resolve({
        sourceId: "source",
        zoneIds: [],
        outcomes: []
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(prepareArea).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("limits Castle preparation to the destination-containing zone", () => {
    const manager = softManager();

    expect(manager.prepare({
      ...softInput("kingdom-travel"),
      kind: "kingdom-travel"
    })).toBe("admitted");
    expect(manager.snapshot().referencedZones).toBe(1);
    manager.close();
  });

  it("supersedes, cancels, and disconnects one player reservation", () => {
    const releaseSource = vi.fn(() => true);
    const manager = softManager({
      prepareArea: vi.fn(async () => ({
        sourceId: "source",
        zoneIds: [],
        outcomes: []
      })),
      releaseSource
    });

    expect(manager.prepare(softInput("travel-1"))).toBe("admitted");
    expect(manager.prepare(softInput("travel-1"))).toBe("reused");
    expect(releaseSource).not.toHaveBeenCalled();
    expect(manager.prepare(softInput("travel-2"))).toBe("admitted");
    expect(releaseSource).toHaveBeenCalledWith(
      populationTravelSourceId("player-1", 4, "travel-1")
    );
    expect(manager.releasePlayer("player-1", "travel-2")).toBe(true);
    expect(manager.snapshot().reservations).toBe(0);

    expect(manager.prepare(softInput("travel-3"))).toBe("admitted");
    expect(manager.releaseConnection("connection-1", 4)).toBe(1);
    expect(releaseSource).toHaveBeenCalledTimes(3);
    expect(manager.snapshot()).toMatchObject({
      reservations: 0,
      durableFlights: 0,
      promotions: 0,
      referencedZones: 0
    });
  });

  it("expires one reservation and releases its source exactly once", async () => {
    vi.useFakeTimers();
    try {
      const releaseSource = vi.fn(() => true);
      const manager = softManager(
        {
          prepareArea: vi.fn(async () => ({
            sourceId: "source",
            zoneIds: [],
            outcomes: []
          })),
          releaseSource
        },
        { reservationTtlMs: 500 }
      );

      expect(manager.prepare(softInput("travel-timeout"))).toBe("admitted");
      await vi.advanceTimersByTimeAsync(500);
      expect(releaseSource).toHaveBeenCalledTimes(1);
      expect(releaseSource).toHaveBeenCalledWith(
        populationTravelSourceId("player-1", 4, "travel-timeout")
      );
      await vi.advanceTimersByTimeAsync(500);
      expect(releaseSource).toHaveBeenCalledTimes(1);
      expect(manager.snapshot().reservations).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("skips optional cold work at capacity or under pressure", () => {
    const durable = deferred<{
      sourceId: string;
      zoneIds: [];
      outcomes: [];
    }>();
    const manager = softManager({
      prepareArea: vi.fn(() => durable.promise)
    }, { durableConcurrency: 1 });

    expect(manager.prepare(softInput("travel-1"))).toBe("admitted");
    expect(manager.prepare({
      ...softInput("travel-2"),
      playerId: "player-2",
      connectionId: "connection-2",
      area: {
        ...AREA,
        center: { lat: 40, lon: -120 },
        sourceId: "flag-2"
      }
    })).toBe("skipped");

    const pressured = softManager({
      canAdmitSpeculative: () => false
    });
    expect(pressured.prepare(softInput("travel-pressure"))).toBe("skipped");
  });
});

function softManager(
  overrides: Partial<ConstructorParameters<
    typeof PopulationSoftTravelReservationManager
  >[0]> = {},
  optionOverrides: Partial<ConstructorParameters<
    typeof PopulationSoftTravelReservationManager
  >[1]> = {}
): PopulationSoftTravelReservationManager {
  return new PopulationSoftTravelReservationManager({
    prepareArea: vi.fn(async () => ({
      sourceId: "source",
      zoneIds: [],
      outcomes: []
    })),
    releaseSource: vi.fn(() => true),
    adoptSource: vi.fn(() => "adopted"),
    hasPreparedZones: () => false,
    canAdmitSpeculative: () => true,
    ...overrides
  } as never, {
    durableConcurrency: 2,
    promotionConcurrency: 1,
    reservationTtlMs: 25_000,
    activationLeadMs: 1_250,
    ...optionOverrides
  });
}

function softInput(travelId: string) {
  return {
    area: AREA,
    kind: "flag-travel" as const,
    playerId: "player-1",
    connectionId: "connection-1",
    connectionGeneration: 4,
    travelId,
    expectedRelocationRevision: 9,
    expectedResourceVisionRevision: 11,
    expectedGameplayViewGeneration: 8,
    expectedPresentationDurationMs: 5_000
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function challengeProfile(level: number) {
  return Object.freeze({
    currentGearLevel: level,
    unlockedGearLevel: level,
    tier: level >= 25 ? "legendary" as const : "common" as const,
    contributors: Object.freeze({
      melee: level,
      chest: level,
      secondary: level
    }),
    balanceVersion: 2 as const
  });
}
