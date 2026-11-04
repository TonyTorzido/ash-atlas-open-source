import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createPopulationRealtimeOperations,
  type PopulationV2RealtimeHooks
} from "./populationRealtimeOperations.js";
import { TravelRuntimeState } from "./travelRuntimeState.js";

describe("population realtime recovery", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("republishes once, rate limits repeats, and rejects stale connection authority", () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const resync = vi.fn(() => republishResult("republished"));
    const sendToConnection = vi.fn();
    const operations = createOperations({ resync, sendToConnection });
    const request = recoveryRequest();

    expect(operations.requestPopulationResync(request)).toBe("republished");
    expect(operations.requestPopulationResync(request)).toBe("rate-limited");
    expect(resync).toHaveBeenCalledOnce();
    expect(sendToConnection).toHaveBeenNthCalledWith(
      1,
      "connection-1",
      expect.objectContaining({
        type: "POPULATION_RESYNC_RESULT",
        requestId: "request-1",
        outcome: "republished",
        currentPreparationGeneration: 5,
        preparationResult: "pending",
        visibleZoneCount: 4,
        readyVisibleZoneCount: 2,
        terminal: false
      })
    );
    expect(sendToConnection).toHaveBeenNthCalledWith(
      2,
      "connection-1",
      expect.objectContaining({
        requestId: "request-1",
        outcome: "rate-limited"
      })
    );

    vi.setSystemTime(12_001);
    expect(operations.requestPopulationResync({
      ...request,
      connectionGeneration: 2
    })).toBe("ignored");
    expect(operations.requestPopulationResync({
      ...request,
      relocationRevision: 8
    })).toBe("ignored");
    expect(resync).toHaveBeenCalledOnce();
    expect(sendToConnection).toHaveBeenLastCalledWith(
      "connection-1",
      expect.objectContaining({ outcome: "ignored-stale" })
    );
  });

  it("starts one new fenced relocation after retryable failure and holds a single flight", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(20_000);
    let resolveCompletion!: () => void;
    const completion = new Promise<void>((resolve) => {
      resolveCompletion = resolve;
    });
    const resync = vi.fn()
      .mockReturnValueOnce(republishResult("retry-required"))
      .mockReturnValue(republishResult("republished"));
    const relocate = vi.fn(() => ({
      visibleReady: Promise.resolve({
        status: "ready" as const,
        pendingVisibleZoneCount: 0
      }),
      presentationReady: Promise.resolve({
        status: "ready" as const,
        pendingVisibleZoneCount: 0
      }),
      completion,
      pendingVisibleZoneCount: () => 0
    }));
    const refreshFlagLocality = vi.fn();
    const releaseFlagLocality = vi.fn();
    const onPresentationRelocation = vi.fn();
    const operations = createOperations({
      resync,
      relocate,
      refreshFlagLocality,
      releaseFlagLocality,
      onPresentationRelocation,
      gameplayRadiusM: 950
    });
    const request = recoveryRequest();

    expect(operations.requestPopulationResync(request)).toBe("started");
    expect(operations.requestPopulationResync(request)).toBe("ignored");
    expect(resync).toHaveBeenCalledOnce();
    expect(relocate).toHaveBeenCalledOnce();
    expect(relocate).toHaveBeenCalledWith(expect.objectContaining({
      playerId: "player-1",
      connectionId: "connection-1",
      connectionGeneration: 3,
      relocationRevision: 7,
      resourceVisionRevision: 11,
      area: expect.objectContaining({
        certifiedVisibleRadiusM: 950,
        preparedRadiusM: 1_050
      }),
      trigger: "explicit-relocation"
    }));
    expect(releaseFlagLocality).toHaveBeenCalledWith("player-1");
    expect(onPresentationRelocation).toHaveBeenCalledOnce();
    expect(onPresentationRelocation).toHaveBeenCalledWith(
      expect.objectContaining({
        playerId: "player-1",
        connectionId: "connection-1",
        connectionGeneration: 3,
        trigger: "explicit-relocation"
      })
    );
    expect(refreshFlagLocality).not.toHaveBeenCalled();

    resolveCompletion();
    await completion;
    await Promise.resolve();
    expect(refreshFlagLocality).toHaveBeenCalledOnce();
    expect(refreshFlagLocality).toHaveBeenCalledWith({
      playerId: "player-1",
      generation: 4,
      center: { lat: 35, lon: -106 }
    });
    vi.setSystemTime(22_001);
    expect(operations.requestPopulationResync(request)).toBe("republished");
    expect(resync).toHaveBeenCalledTimes(2);
    expect(relocate).toHaveBeenCalledOnce();
  });

  it("reissues a safe presentation checkpoint when terminal population is already ready", () => {
    const onPresentationRelocation = vi.fn();
    const operations = createOperations({
      resync: vi.fn(readyRepublishResult),
      onPresentationRelocation
    });
    operations.schedulePopulationV2RelocationForActivePlayer(
      "player-1",
      "world-entry"
    );

    expect(operations.requestPopulationResync(recoveryRequest()))
      .toBe("republished");
    expect(onPresentationRelocation).toHaveBeenCalledOnce();
    expect(onPresentationRelocation).toHaveBeenCalledWith(
      expect.objectContaining({ trigger: "world-entry" })
    );
  });

  it("keeps a degraded terminal current instead of starting another relocation", () => {
    const onPresentationRelocation = vi.fn();
    const relocate = vi.fn(() => ({
      visibleReady: Promise.resolve({
        status: "ready" as const,
        pendingVisibleZoneCount: 0
      }),
      presentationReady: Promise.resolve({
        status: "ready" as const,
        pendingVisibleZoneCount: 0
      }),
      completion: Promise.resolve(),
      pendingVisibleZoneCount: () => 0
    }));
    const operations = createOperations({
      resync: vi.fn(() => ({
        status: "republished" as const,
        state: {
          preparationGeneration: 5,
          relocationRevision: 7,
          resourceVisionRevision: 11,
          preparationResult: "degraded" as const,
          preparationReason: "generation-missing" as const,
          visibleZoneCount: 4,
          readyVisibleZoneCount: 3,
          terminal: true
        }
      })),
      relocate,
      onPresentationRelocation
    });
    operations.schedulePopulationV2RelocationForActivePlayer(
      "player-1",
      "world-entry"
    );

    expect(operations.requestPopulationResync(recoveryRequest()))
      .toBe("republished");
    expect(relocate).toHaveBeenCalledOnce();
    expect(onPresentationRelocation).toHaveBeenCalledOnce();
  });

  it("keeps committed travel preparing until the full presentation is terminal", async () => {
    vi.useFakeTimers();
    const resync = vi.fn(() => republishResult("republished"));
    const operations = createOperations({ resync });
    let settled = false;
    const readiness = operations.waitForRelocationPopulationV2({
      playerId: "player-1",
      requestId: "cold-travel",
      destination: { lat: 35, lon: -106 },
      transitionToken: Symbol("cold-travel"),
      relocation: {
        playerId: "player-1",
        connectionId: "connection-1",
        connectionGeneration: 3,
        relocationRevision: 7,
        resourceVisionRevision: 11,
        gameplayViewGeneration: 4,
        area: {
          center: { lat: 35, lon: -106 },
          certifiedVisibleRadiusM: 650,
          preparedRadiusM: 750,
          sourceType: "flag",
          sourceId: "flag-1",
          generation: 4
        },
        preparationGeneration: 5,
        trigger: "flag-travel",
        startedAtMs: performance.now(),
        visibleReady: Promise.resolve({
          status: "ready",
          pendingVisibleZoneCount: 1
        }),
        presentationReady: new Promise((resolve) => {
          setTimeout(() => resolve({
            status: "ready",
            pendingVisibleZoneCount: 0
          }), 750);
        }),
        completion: Promise.resolve(),
        pendingVisibleZoneCount: () => 1,
        isCurrent: () => true
      }
    }).finally(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(500);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(250);
    await expect(readiness).resolves.toBe("ready");
    expect(resync).toHaveBeenCalledOnce();
  });
});

function createOperations(overrides: Readonly<{
  resync: NonNullable<PopulationV2RealtimeHooks["resync"]>;
  sendToConnection?: ReturnType<typeof vi.fn>;
  gameplayRadiusM?: number;
  refreshFlagLocality?: ReturnType<typeof vi.fn>;
  releaseFlagLocality?: ReturnType<typeof vi.fn>;
  onPresentationRelocation?: ReturnType<typeof vi.fn>;
  relocate?: () => Readonly<{
    visibleReady: Promise<Readonly<{
      status: "ready";
      pendingVisibleZoneCount: number;
    }>>;
    presentationReady: Promise<Readonly<{
      status: "ready";
      pendingVisibleZoneCount: number;
    }>>;
    completion: Promise<void>;
    pendingVisibleZoneCount(): number;
  }>;
}>) {
  return createPopulationRealtimeOperations({
    logger: { warn: vi.fn() } as never,
    registry: {
      activeConnectionIdForPlayer: vi.fn(() => "connection-1"),
      sendToConnection: overrides.sendToConnection ?? vi.fn()
    } as never,
    gameState: {
      isWorldPresent: vi.fn(() => true),
      getPlayer: vi.fn(() => ({
        playerId: "player-1",
        anchor: { lat: 35, lon: -106 },
        relocationRevision: 7
      })),
      getResourceVisionRevision: vi.fn(() => 11),
      getGameplayViewCircle: vi.fn(() => ({
        radiusM: overrides.gameplayRadiusM ?? 650,
        generation: 4
      })),
      getResourceVision: vi.fn(() => ({
        destinationKind: "flag",
        flagId: "flag-1"
      }))
    } as never,
    connectionGenerations: {
      current: vi.fn(() => 3)
    } as never,
    travelRuntimeState: new TravelRuntimeState(),
    ...(overrides.onPresentationRelocation
      ? { onPresentationRelocation: overrides.onPresentationRelocation }
      : {}),
    populationV2: {
      resync: overrides.resync,
      relocate: overrides.relocate ?? vi.fn(() => ({
        visibleReady: Promise.resolve({
          status: "ready" as const,
          pendingVisibleZoneCount: 0
        }),
        presentationReady: Promise.resolve({
          status: "ready" as const,
          pendingVisibleZoneCount: 0
        }),
        completion: Promise.resolve(),
        pendingVisibleZoneCount: () => 0
      })),
      releaseConnection: vi.fn(),
      refreshFlagLocality: overrides.refreshFlagLocality ?? vi.fn(),
      releaseFlagLocality: overrides.releaseFlagLocality ?? vi.fn()
    }
  });
}

function republishResult(
  status: "republished" | "retry-required" | "missing"
) {
  return {
    status,
    state: status === "missing"
      ? null
      : {
          preparationGeneration: 5,
          relocationRevision: 7,
          resourceVisionRevision: 11,
          preparationResult: status === "retry-required"
            ? "retryable-failure" as const
            : "pending" as const,
          preparationReason: status === "retry-required"
            ? "backpressure-retry" as const
            : "durable-rehydration" as const,
          visibleZoneCount: 4,
          readyVisibleZoneCount: 2,
          terminal: status === "retry-required"
        }
  };
}

function readyRepublishResult() {
  return {
    status: "republished" as const,
    state: {
      preparationGeneration: 5,
      relocationRevision: 7,
      resourceVisionRevision: 11,
      preparationResult: "ready" as const,
      preparationReason: "durable-rehydration" as const,
      visibleZoneCount: 4,
      readyVisibleZoneCount: 4,
      terminal: true
    }
  };
}

function recoveryRequest() {
  return {
    requestId: "request-1",
    playerId: "player-1",
    connectionId: "connection-1",
    connectionGeneration: 3,
    preparationGeneration: 5,
    relocationRevision: 7,
    resourceVisionRevision: 11,
    preparationTrigger: "flag-travel" as const,
    preparationScope: "required-visible" as const
  };
}
