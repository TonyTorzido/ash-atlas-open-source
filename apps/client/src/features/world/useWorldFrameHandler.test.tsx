// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  parseServerMessage,
  type WorldMapDestinationSnapshot,
  type WorldServerMessage
} from "@ash-atlas/shared";

import { WorldResourcePresentationStore } from "../../collectibles/worldResourcePresentationStore.js";
import { gameplayLatencyTrace } from "../../diagnostics/gameplayLatencyTrace.js";
import { emptyPopulationZoneProjection } from "../../population/populationZoneProjection.js";
import { useWorldFrameHandler } from "./useWorldFrameHandler.js";

describe("useWorldFrameHandler population preparation notices", () => {
  it("correlates authoritative cold population progress and presentation", () => {
    const record = vi.spyOn(gameplayLatencyTrace, "record")
      .mockReturnValue(true);
    const { result } = renderHook(() => useWorldFrameHandler({
      ownPlayerId: "player-1",
      relocationRevisionRef: { current: 7 },
      resourceVisionRevisionRef: { current: 9 },
      pendingTravelRequestIdRef: { current: "travel-1" },
      postArrivalTravelRequestIdRef: { current: null },
      populationZoneProjectionRef: {
        current: emptyPopulationZoneProjection()
      },
      setPopulationPreparationProgress: vi.fn(),
      renderStateRef: {
        current: {
          collectibles: [],
          gameplayViewCircle: {
            center: { lat: 35, lon: -106 },
            radiusM: 650
          }
        }
      },
      overlayRef: { current: { update: vi.fn() } },
      setCollectibles: vi.fn(),
      harvestTaskRef: { current: null },
      selectedCollectibleIdRef: { current: null },
      settleHarvestAfterAuthoritativeRemoval: vi.fn(),
      clearOptimisticResinPresentation: vi.fn(),
      setSelectedCollectibleId: vi.fn(),
      setWarning: vi.fn(),
      dispatchStartup: vi.fn()
    } as never));

    act(() => result.current(populationFrame({
      preparationReason: "initial-world-generation"
    })));

    expect(record).toHaveBeenCalledWith(
      "population",
      "population_required_visible_applied",
      expect.objectContaining({
        populationState: "cold",
        preparationReason: "initial-world-generation",
        terminal: true
      }),
      { traceId: "travel-1" }
    );
    expect(record).toHaveBeenCalledWith(
      "ui",
      "population_required_visible_presented",
      expect.objectContaining({ populationState: "cold" }),
      { traceId: "travel-1" }
    );
    record.mockRestore();
  });

  it("clears only the exact legacy warning after authoritative readiness", () => {
    const dispatchStartup = vi.fn();
    const setWarning = vi.fn();
    const setPopulationPreparationProgress = vi.fn();
    const populationZoneProjectionRef = {
      current: emptyPopulationZoneProjection()
    };
    const renderStateRef = {
      current: { collectibles: [] }
    };
    const { result } = renderHook(() => useWorldFrameHandler({
      ownPlayerId: "player-1",
      relocationRevisionRef: { current: 7 },
      resourceVisionRevisionRef: { current: 9 },
      populationZoneProjectionRef,
      setPopulationPreparationProgress,
      renderStateRef,
      overlayRef: { current: null },
      setCollectibles: vi.fn(),
      harvestTaskRef: { current: null },
      selectedCollectibleIdRef: { current: null },
      settleHarvestAfterAuthoritativeRemoval: vi.fn(),
      clearOptimisticResinPresentation: vi.fn(),
      setSelectedCollectibleId: vi.fn(),
      setWarning,
      dispatchStartup
    } as never));

    act(() => result.current({
      type: "POPULATION_ZONE_DELTA",
      playerId: "player-1",
      connectionId: "connection-1",
      connectionGeneration: 2,
      preparationGeneration: 5,
      preparationTrigger: "flag-placement",
      preparationScope: "required-visible",
      requiredForGameplay: true,
      relocationRevision: 7,
      resourceVisionRevision: 9,
      gameplayViewGeneration: 11,
      retainedZoneIds: [],
      activatedZoneIds: [],
      releasedZoneIds: [],
      withheldZoneIds: [],
      upserts: [],
      removedEntityIds: [],
      visibleZoneCount: 4,
      readyVisibleZoneCount: 4,
      backgroundZoneCount: 2,
      readyBackgroundZoneCount: 0,
      zoneSnapshots: [],
      preparationReason: "ready",
      preparationResult: "ready",
      partial: false,
      terminal: true
    }));

    expect(setPopulationPreparationProgress).toHaveBeenCalledWith(
      expect.objectContaining({ status: "ready" })
    );
    const clearExactWarning = setWarning.mock.calls[0]?.[0] as
      ((current: string | null) => string | null);
    expect(clearExactWarning(
      "The land could not be prepared. Try again shortly."
    )).toBeNull();
    expect(clearExactWarning("Another warning")).toBe("Another warning");
    expect(dispatchStartup).not.toHaveBeenCalledWith({ type: "world_ready" });
  });

  it("marks explicitly degraded population as presentation-ready", () => {
    const observePopulation = vi.fn();
    const setPopulationPreparationProgress = vi.fn();
    const { result } = renderHook(() => useWorldFrameHandler({
      ownPlayerId: "player-1",
      relocationRevisionRef: { current: 7 },
      resourceVisionRevisionRef: { current: 9 },
      populationZoneProjectionRef: {
        current: emptyPopulationZoneProjection()
      },
      setPopulationPreparationProgress,
      renderStateRef: { current: { collectibles: [] } },
      presentationStoreRef: {
        current: new WorldResourcePresentationStore()
      },
      worldViewBarrierRef: { current: { observePopulation } },
      overlayRef: { current: null },
      setCollectibles: vi.fn(),
      harvestTaskRef: { current: null },
      selectedCollectibleIdRef: { current: null },
      settleHarvestAfterAuthoritativeRemoval: vi.fn(),
      clearOptimisticResinPresentation: vi.fn(),
      setSelectedCollectibleId: vi.fn(),
      setWarning: vi.fn(),
      dispatchStartup: vi.fn()
    } as never));

    act(() => result.current(populationFrame({
      preparationTrigger: "world-entry",
      retainedZoneIds: ["zone-healthy"],
      releasedZoneIds: ["zone-bad"],
      withheldZoneIds: ["zone-bad"],
      visibleZoneCount: 2,
      readyVisibleZoneCount: 1,
      preparationReason: "generation-missing",
      preparationResult: "degraded",
      partial: false,
      terminal: true
    })));

    expect(setPopulationPreparationProgress).toHaveBeenCalledWith(
      expect.objectContaining({ status: "degraded" })
    );
    expect(observePopulation).toHaveBeenCalledWith(
      expect.objectContaining({
        populationPreparationGeneration: 5
      }),
      true
    );
  });

  it("does not convert an early out-of-circle upsert into a removal", () => {
    const setCollectibles = vi.fn();
    const update = vi.fn();
    const presentationStore = new WorldResourcePresentationStore();
    const removeBatch = vi.spyOn(presentationStore, "removeBatch");
    const renderStateRef = {
      current: {
        collectibles: [],
        gameplayViewCircle: {
          center: { lat: 35, lon: -106 },
          radiusM: 650
        },
        selectedCollectibleId: null
      }
    };
    const { result } = renderHook(() => useWorldFrameHandler({
      ownPlayerId: "player-1",
      relocationRevisionRef: { current: 7 },
      resourceVisionRevisionRef: { current: 9 },
      populationZoneProjectionRef: {
        current: emptyPopulationZoneProjection()
      },
      presentationStoreRef: { current: presentationStore },
      setPopulationPreparationProgress: vi.fn(),
      renderStateRef,
      overlayRef: { current: { update } },
      setCollectibles,
      harvestTaskRef: { current: null },
      selectedCollectibleIdRef: { current: null },
      settleHarvestAfterAuthoritativeRemoval: vi.fn(),
      clearOptimisticResinPresentation: vi.fn(),
      setSelectedCollectibleId: vi.fn(),
      setWarning: vi.fn(),
      dispatchStartup: vi.fn()
    } as never));

    act(() => result.current({
      type: "POPULATION_ZONE_DELTA",
      playerId: "player-1",
      connectionId: "connection-1",
      connectionGeneration: 2,
      preparationGeneration: 5,
      preparationTrigger: "flag-placement",
      preparationScope: "required-visible",
      requiredForGameplay: true,
      relocationRevision: 7,
      resourceVisionRevision: 9,
      gameplayViewGeneration: 11,
      retainedZoneIds: [],
      activatedZoneIds: ["zone-a"],
      releasedZoneIds: [],
      withheldZoneIds: [],
      upserts: [{
        entityId: "outside-tree",
        zoneId: "zone-a",
        generationId: "generation-a",
        kind: "tree",
        archetype: "tree-default",
        position: { lat: 35.01, lon: -106 },
        homePosition: { lat: 35.01, lon: -106 },
        stateRevision: 1
      }],
      removedEntityIds: [],
      visibleZoneCount: 1,
      readyVisibleZoneCount: 1,
      backgroundZoneCount: 0,
      readyBackgroundZoneCount: 0,
      zoneSnapshots: [{
        zoneId: "zone-a",
        generationId: "generation-a",
        entityIds: ["outside-tree"]
      }],
      preparationReason: "ready",
      preparationResult: "ready",
      partial: false,
      terminal: true
    }));

    expect(renderStateRef.current.collectibles).toEqual([]);
    expect(setCollectibles).toHaveBeenLastCalledWith([]);
    expect(update).toHaveBeenLastCalledWith(renderStateRef.current);
    expect(removeBatch).not.toHaveBeenCalled();
  });

  it("applies matching population frames in one animation-frame reconciliation", () => {
    let flush!: FrameRequestCallback;
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      flush = callback;
      return 1;
    });
    const setPopulationPreparationProgress = vi.fn();
    const setCollectibles = vi.fn();
    const update = vi.fn();
    const { result } = renderHook(() => useWorldFrameHandler({
      ownPlayerId: "player-1",
      populationFrameBatchingEnabled: true,
      relocationRevisionRef: { current: 7 },
      resourceVisionRevisionRef: { current: 9 },
      pendingTravelRequestIdRef: { current: null },
      postArrivalTravelRequestIdRef: { current: null },
      populationZoneProjectionRef: {
        current: emptyPopulationZoneProjection()
      },
      setPopulationPreparationProgress,
      renderStateRef: {
        current: {
          collectibles: [],
          gameplayViewCircle: {
            center: { lat: 35, lon: -106 },
            radiusM: 650
          }
        }
      },
      overlayRef: { current: { update } },
      setCollectibles,
      harvestTaskRef: { current: null },
      selectedCollectibleIdRef: { current: null },
      settleHarvestAfterAuthoritativeRemoval: vi.fn(),
      clearOptimisticResinPresentation: vi.fn(),
      setSelectedCollectibleId: vi.fn(),
      setWarning: vi.fn(),
      dispatchStartup: vi.fn()
    } as never));

    const coalescingMs: number[] = [];
    const applyRenderMs: number[] = [];
    for (let sample = 0; sample < 100; sample += 1) {
      const queuedAt = performance.now();
      act(() => {
        result.current(populationFrame({
          activatedZoneIds: [`zone-a-${sample}`],
          readyVisibleZoneCount: 1,
          visibleZoneCount: 2,
          preparationResult: "pending",
          partial: true,
          terminal: false
        }));
        result.current(populationFrame({
          activatedZoneIds: [`zone-b-${sample}`],
          readyVisibleZoneCount: 2,
          visibleZoneCount: 2
        }));
      });
      coalescingMs.push(performance.now() - queuedAt);
      const applyStartedAt = performance.now();
      act(() => flush(sample * 16));
      applyRenderMs.push(performance.now() - applyStartedAt);
    }
    expect(setPopulationPreparationProgress).toHaveBeenCalledTimes(100);
    expect(setCollectibles).toHaveBeenCalledTimes(100);
    expect(update).toHaveBeenCalledTimes(100);

    const payload = JSON.stringify(populationFrame({
      activatedZoneIds: ["zone-a", "zone-b"],
      visibleZoneCount: 2,
      readyVisibleZoneCount: 2
    }));
    const parseValidationMs: number[] = [];
    for (let sample = 0; sample < 100; sample += 1) {
      const startedAt = performance.now();
      expect(parseServerMessage(payload).type).toBe("POPULATION_ZONE_DELTA");
      parseValidationMs.push(performance.now() - startedAt);
    }
    console.info("population-client-apply-benchmark", JSON.stringify({
      payloadBytes: new TextEncoder().encode(payload).byteLength,
      parseValidation: metricSummary(parseValidationMs),
      frameCoalescing: metricSummary(coalescingMs),
      projectionApplyAndOverlayUpdate: metricSummary(applyRenderMs)
    }));
  });

  it.each([
    { currentVisible: false, nextVisible: true },
    { currentVisible: true, nextVisible: false }
  ])(
    "applies a world-map snapshot when visibility changes from $currentVisible to $nextVisible",
    ({ currentVisible, nextVisible }) => {
      const setWorldMapSnapshot = vi.fn();
      const { result } = renderHook(() => useWorldFrameHandler({
        ownPlayerId: "player-1",
        renderStateRef: { current: { collectibles: [] } },
        setWorldMapSnapshot
      } as never));
      const destination = {
        kind: "city" as const,
        id: "11111111-1111-4111-8111-111111111111",
        name: "Baker",
        lat: 44.77,
        lon: -117.83
      };
      const current: WorldMapDestinationSnapshot = {
        destinations: [{ ...destination, visible: currentVisible }],
        serverTime: 1
      };
      const next: WorldMapDestinationSnapshot = {
        destinations: [{ ...destination, visible: nextVisible }],
        serverTime: 2
      };

      act(() => result.current({
        type: "WORLD_MAP_DESTINATIONS",
        requestId: "22222222-2222-4222-8222-222222222222",
        snapshot: next
      }));

      const update = setWorldMapSnapshot.mock.calls[0]?.[0] as
        ((snapshot: WorldMapDestinationSnapshot) => WorldMapDestinationSnapshot);
      expect(update(current)).toBe(next);
    }
  );
});

function metricSummary(values: readonly number[]) {
  const sorted = [...values].sort((left, right) => left - right);
  const percentile = (fraction: number) =>
    sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
  return {
    samples: sorted.length,
    p50: percentile(0.5),
    p95: percentile(0.95),
    p99: percentile(0.99),
    max: sorted.at(-1) ?? 0
  };
}

function populationFrame(
  overrides: Partial<Extract<
    WorldServerMessage,
    { type: "POPULATION_ZONE_DELTA" }
  >> = {}
): Extract<WorldServerMessage, { type: "POPULATION_ZONE_DELTA" }> {
  return {
    type: "POPULATION_ZONE_DELTA",
    playerId: "player-1",
    connectionId: "connection-1",
    connectionGeneration: 2,
    preparationGeneration: 5,
    preparationTrigger: "flag-travel",
    preparationScope: "required-visible",
    requiredForGameplay: true,
    relocationRevision: 7,
    resourceVisionRevision: 9,
    gameplayViewGeneration: 11,
    retainedZoneIds: [],
    activatedZoneIds: [],
    releasedZoneIds: [],
    withheldZoneIds: [],
    upserts: [],
    removedEntityIds: [],
    visibleZoneCount: 1,
    readyVisibleZoneCount: 1,
    backgroundZoneCount: 0,
    readyBackgroundZoneCount: 0,
    zoneSnapshots: [],
    preparationReason: "ready",
    preparationResult: "ready",
    partial: false,
    terminal: true,
    ...overrides
  };
}
