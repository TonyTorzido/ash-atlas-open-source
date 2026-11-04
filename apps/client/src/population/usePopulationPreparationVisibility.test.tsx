// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  POPULATION_PREPARATION_STALE_MS,
  POPULATION_PREPARATION_VISIBILITY_DELAY_MS,
  usePopulationPreparationVisibility
} from "./usePopulationPreparationVisibility.js";
import type {
  PopulationPreparationProgress
} from "./populationZoneProjection.js";

type VisibilityProps = {
  completed: number;
  status: "pending" | "ready";
};

const pendingProps: VisibilityProps = {
  completed: 0,
  status: "pending"
};

function progress(props: VisibilityProps): PopulationPreparationProgress {
  return {
    ...props,
    total: 4,
    reason: "durable-rehydration",
    operation: {
      playerId: "player-1",
      connectionId: "connection-1",
      connectionGeneration: 2,
      preparationGeneration: 7,
      trigger: "flag-placement",
      scope: "required-visible",
      requiredForGameplay: true,
      relocationRevision: 3,
      resourceVisionRevision: 4,
      gameplayViewGeneration: 5
    }
  };
}

describe("population preparation visibility", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("does not flash when a warm destination becomes ready inside the delay", () => {
    const { result, rerender } = renderHook(
      ({ completed, status }: VisibilityProps) =>
        usePopulationPreparationVisibility(progress({ completed, status })),
      { initialProps: pendingProps }
    );
    expect(result.current).toBe(false);

    act(() => {
      vi.advanceTimersByTime(
        POPULATION_PREPARATION_VISIBILITY_DELAY_MS - 1
      );
      rerender({ completed: 4, status: "ready" });
      vi.advanceTimersByTime(1);
    });

    expect(result.current).toBe(false);
  });

  it("shows a cold destination after the delay and clears at readiness", () => {
    const { result, rerender } = renderHook(
      ({ completed, status }: VisibilityProps) =>
        usePopulationPreparationVisibility(progress({ completed, status })),
      { initialProps: pendingProps }
    );

    act(() => {
      vi.advanceTimersByTime(
        POPULATION_PREPARATION_VISIBILITY_DELAY_MS
      );
    });
    expect(result.current).toBe(true);

    rerender({ completed: 4, status: "ready" });
    expect(result.current).toBe(false);
  });

  it("hides stale progress and requests one bounded resync without inventing failure", () => {
    const onStale = vi.fn();
    const pending = progress(pendingProps);
    const { result } = renderHook(() =>
      usePopulationPreparationVisibility(pending, onStale)
    );

    act(() => {
      vi.advanceTimersByTime(POPULATION_PREPARATION_STALE_MS);
    });
    expect(result.current).toBe(false);
    expect(onStale).toHaveBeenCalledOnce();
    expect(onStale).toHaveBeenCalledWith(expect.objectContaining({
      status: "pending"
    }));

    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(onStale).toHaveBeenCalledOnce();
  });

  it("measures inactivity from the latest authoritative progress checkpoint", () => {
    const onStale = vi.fn();
    const { result, rerender } = renderHook(
      ({ completed, status }: VisibilityProps) =>
        usePopulationPreparationVisibility(
          progress({ completed, status }),
          onStale
        ),
      { initialProps: pendingProps }
    );
    act(() => {
      vi.advanceTimersByTime(POPULATION_PREPARATION_VISIBILITY_DELAY_MS);
    });
    expect(result.current).toBe(true);

    for (const completed of [1, 2, 3]) {
      act(() => {
        vi.advanceTimersByTime(POPULATION_PREPARATION_STALE_MS - 1_000);
        rerender({ completed, status: "pending" });
      });
      expect(onStale).not.toHaveBeenCalled();
      expect(result.current).toBe(true);
    }
    act(() => {
      vi.advanceTimersByTime(POPULATION_PREPARATION_STALE_MS - 1_000);
      rerender({ completed: 4, status: "ready" });
    });
    expect(onStale).not.toHaveBeenCalled();
    expect(result.current).toBe(false);
  });

  it("never displays or watches optional background preparation", () => {
    const onStale = vi.fn();
    const optional = {
      ...progress(pendingProps),
      operation: {
        ...progress(pendingProps).operation!,
        scope: "neighbor-preload" as const,
        requiredForGameplay: false
      }
    };
    const { result } = renderHook(() =>
      usePopulationPreparationVisibility(optional, onStale)
    );

    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(result.current).toBe(false);
    expect(onStale).not.toHaveBeenCalled();
    expect(optional.status).toBe("pending");
  });
});
