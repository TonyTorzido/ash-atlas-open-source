// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  handlePendingGoblinVillageSpawnError,
  isDeveloperServerMessage,
  useDeveloperFrameHandler
} from "./useDeveloperFrameHandler.js";

describe("useDeveloperFrameHandler", () => {
  it("announces a confirmed class ability cooldown reset", () => {
    const showActionSuccess = vi.fn();
    const { result } = renderHook(() => useDeveloperFrameHandler({
      showActionSuccess
    } as never));

    act(() => result.current({
      type: "DEV_CLASS_COOLDOWNS_RESET",
      requestId: "reset-1",
      serverTime: 1_000
    }));

    expect(showActionSuccess).toHaveBeenCalledOnce();
    expect(showActionSuccess).toHaveBeenCalledWith(
      "Class ability cooldowns reset."
    );
  });

  it("owns the Goblin Village completion frame and clears spawn mode", () => {
    expect(isDeveloperServerMessage({ type: "DEV_GOBLIN_VILLAGE_SPAWNED" })).toBe(true);
    const showActionSuccess = vi.fn();
    const setGoblinVillageSpawnMode = vi.fn();
    const onGoblinVillageSpawned = vi.fn();
    const goblinVillageSpawnRequestRef = { current: "spawn-1" };
    const { result } = renderHook(() => useDeveloperFrameHandler({
      showActionSuccess,
      setGoblinVillageSpawnMode,
      goblinVillageSpawnRequestRef,
      onGoblinVillageSpawned
    } as never));

    act(() => result.current({
      type: "DEV_GOBLIN_VILLAGE_SPAWNED",
      requestId: "spawn-1",
      replayed: false
    } as never));

    expect(setGoblinVillageSpawnMode).toHaveBeenCalledWith(false);
    expect(goblinVillageSpawnRequestRef.current).toBeNull();
    expect(onGoblinVillageSpawned).toHaveBeenCalledOnce();
    expect(showActionSuccess).toHaveBeenCalledWith("Goblin Village spawned.");
  });

  it("ignores stale village completions and exposes the exact matching rejection", () => {
    const showActionSuccess = vi.fn();
    const showActionError = vi.fn();
    const setGoblinVillageSpawnMode = vi.fn();
    const requestRef: { current: string | null } = { current: "spawn-current" };
    const { result } = renderHook(() => useDeveloperFrameHandler({
      showActionSuccess,
      setGoblinVillageSpawnMode,
      goblinVillageSpawnRequestRef: requestRef
    } as never));

    act(() => result.current({
      type: "DEV_GOBLIN_VILLAGE_SPAWNED",
      requestId: "spawn-stale",
      replayed: false
    } as never));
    expect(requestRef.current).toBe("spawn-current");
    expect(setGoblinVillageSpawnMode).not.toHaveBeenCalled();

    expect(handlePendingGoblinVillageSpawnError(
      { requestId: "spawn-current", message: "Village footprint overlaps an existing city" },
      requestRef,
      showActionError
    )).toBe(true);
    expect(requestRef.current).toBeNull();
    expect(showActionError).toHaveBeenCalledWith(
      "Village footprint overlaps an existing city"
    );
    expect(setGoblinVillageSpawnMode).not.toHaveBeenCalled();
  });

  it("removes a deleted Goblin Village from the Developer App list", () => {
    const setGoblinVillages = vi.fn();
    const { result } = renderHook(() => useDeveloperFrameHandler({
      showActionSuccess: vi.fn(),
      setGoblinVillages,
      setGoblinVillageDeleteBusy: vi.fn()
    } as never));

    act(() => result.current({
      type: "DEV_GOBLIN_VILLAGE_DELETED",
      requestId: "delete-1",
      result: {
        replayed: false,
        city: {
          cityId: "11111111-1111-4111-8111-111111111111",
          name: "Goblin Village",
          hallLat: 35.0844,
          hallLon: -106.6504
        },
        removedFlagIds: [],
        structureIds: [],
        affectedZoneIds: []
      }
    }));

    const update = setGoblinVillages.mock.calls[0]?.[0] as (villages: Array<{
      cityId: string;
    }>) => Array<{ cityId: string }>;
    expect(update([
      { cityId: "11111111-1111-4111-8111-111111111111" },
      { cityId: "22222222-2222-4222-8222-222222222222" }
    ])).toEqual([{ cityId: "22222222-2222-4222-8222-222222222222" }]);
  });
});
