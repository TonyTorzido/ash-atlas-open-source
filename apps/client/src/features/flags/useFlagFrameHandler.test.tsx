// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { useFlagFrameHandler } from "./useFlagFrameHandler.js";

describe("useFlagFrameHandler convergence", () => {
  it("shows exact structure HP loss once, never for baselines, repair, zero damage, or stale/replayed frames", () => {
    const enqueueFloatingFeedback = vi.fn();
    const options = {
      overlayRef: { current: { enqueueFloatingFeedback } },
      firstFlagsSnapshotRef: { current: true },
      setFlags: vi.fn(), setWarning: vi.fn(),
      flagSetRevisionRef: { current: 0 },
      connectionGenerationRef: { current: 1 }
    };
    const { result } = renderHook(() => useFlagFrameHandler(options as never));
    const flag = { id: "tower-1", health: 200, maximumHealth: 2700, lat: 35, lon: -106 };
    const update = (health: number, revision: number) => result.current({
      type: "FLAG_UPDATED", flag: { ...flag, health }, flagSetRevision: revision
    } as never);
    act(() => result.current({ type: "FLAGS_SNAPSHOT", flags: [flag], flagSetRevision: 1 } as never));
    act(() => {
      update(200, 2); // A zero-damage minute bucket.
      update(199, 3);
      update(199, 3);
      update(150, 2); // Stale lower HP must not create damage.
      update(250, 4); // Repair.
      update(244, 5);
      update(244, 6); // Re-publication with a newer global revision.
    });
    expect(enqueueFloatingFeedback).toHaveBeenCalledTimes(2);
    expect(enqueueFloatingFeedback).toHaveBeenNthCalledWith(1, expect.objectContaining({
      targetEntityId: "flag:tower-1", kind: "damage_other", amount: 1
    }));
    expect(enqueueFloatingFeedback).toHaveBeenNthCalledWith(2, expect.objectContaining({ amount: 6 }));
    expect(enqueueFloatingFeedback.mock.calls[0]![0].eventId).not.toBe(enqueueFloatingFeedback.mock.calls[1]![0].eventId);
    act(() => result.current({ type: "FLAGS_SNAPSHOT", flags: [{ ...flag, health: 100 }], flagSetRevision: 7 } as never));
    act(() => update(100, 7));
    options.connectionGenerationRef.current = 2;
    act(() => update(50, 8)); // A reconnect has no damage baseline yet.
    expect(enqueueFloatingFeedback).toHaveBeenCalledTimes(2);
  });

  it("retains the world anchor for lethal damage but never invents damage for ordinary deletion", () => {
    const enqueueFloatingFeedback = vi.fn();
    const { result } = renderHook(() => useFlagFrameHandler({
      overlayRef: { current: { enqueueFloatingFeedback } },
      firstFlagsSnapshotRef: { current: true }, setFlags: vi.fn(), setWarning: vi.fn(),
      setSelectedFlagId: vi.fn(), setResourceVision: vi.fn(), setResourceVisionStatus: vi.fn(),
      requestHarvestCancellation: vi.fn(), setWaterHighlights: vi.fn()
    } as never));
    const flag = { id: "tower-1", health: 3, maximumHealth: 2700, lat: 35, lon: -106 };
    act(() => result.current({ type: "FLAGS_SNAPSHOT", flags: [flag], flagSetRevision: 1 } as never));
    act(() => {
      result.current({ type: "FLAG_DELETED", flagId: flag.id, reason: "destroyed", flagSetRevision: 2 });
      result.current({ type: "FLAG_DELETED", flagId: flag.id, reason: "destroyed", flagSetRevision: 2 });
    });
    expect(enqueueFloatingFeedback).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      targetEntityId: "flag:tower-1", amount: 3, worldPosition: { lat: 35, lon: -106 }
    }));
    act(() => result.current({ type: "FLAGS_SNAPSHOT", flags: [flag], flagSetRevision: 3 } as never));
    act(() => result.current({ type: "FLAG_DELETED", flagId: flag.id, reason: "deleted", flagSetRevision: 4 }));
    expect(enqueueFloatingFeedback).toHaveBeenCalledTimes(1);
  });

  it("removes a collapse batch in one state update without cancelling unrelated harvests", () => {
    let flagsState: Array<{ id: string }> = [];
    const setFlags = vi.fn((update: (current: typeof flagsState) => typeof flagsState) => {
      flagsState = update(flagsState);
    });
    const requestHarvestCancellation = vi.fn();
    const setWaterHighlights = vi.fn();
    const onFlagsCollapsed = vi.fn();
    const resourceVisionFlagIdRef = { current: "own-flag" as string | null };
    const { result } = renderHook(() => useFlagFrameHandler({
      overlayRef: { current: { enqueueFloatingFeedback: vi.fn() } },
      firstFlagsSnapshotRef: { current: true }, setFlags, setWarning: vi.fn(),
      setSelectedFlagId: vi.fn(), setResourceVision: vi.fn(), setResourceVisionStatus: vi.fn(),
      requestHarvestCancellation, setWaterHighlights, onFlagsCollapsed, resourceVisionFlagIdRef
    } as never));
    const ids = Array.from({ length: 20 }, (_, index) => `city-${index}`);
    act(() => result.current({
      type: "FLAGS_SNAPSHOT",
      flags: [...ids, "own-flag"].map((id) => ({ id, lat: 35, lon: -106 })),
      flagSetRevision: 1
    } as never));
    setFlags.mockClear();
    act(() => result.current({
      type: "FLAGS_COLLAPSED", flagIds: ids, collapseId: "c-1", reason: "city_destroyed",
      completed: false, flagSetRevision: 2
    }));
    expect(setFlags).toHaveBeenCalledTimes(1);
    expect(flagsState.map(({ id }) => id)).toEqual(["own-flag"]);
    expect(onFlagsCollapsed).toHaveBeenCalledExactlyOnceWith(ids);
    expect(requestHarvestCancellation).not.toHaveBeenCalled();
    expect(setWaterHighlights).not.toHaveBeenCalled();

    act(() => result.current({
      type: "FLAGS_COLLAPSED", flagIds: ["own-flag"], collapseId: "c-1", reason: "city_destroyed",
      completed: true, flagSetRevision: 3
    }));
    expect(flagsState).toEqual([]);
    expect(requestHarvestCancellation).toHaveBeenCalledTimes(1);
    expect(setWaterHighlights).toHaveBeenCalledExactlyOnceWith([]);
  });

  it("surfaces authoritative burn acceptance and Torch craft output", () => {
    const receiveInventorySnapshot = vi.fn();
    const onFlagBurnStarted = vi.fn();
    const onTorchesCrafted = vi.fn();
    const { result } = renderHook(() => useFlagFrameHandler({
      firstFlagsSnapshotRef: { current: true },
      flagPlacementValidationGateRef: { current: null },
      flagBuildIntentRef: { current: null },
      receiveInventorySnapshot,
      onFlagBurnStarted,
      onTorchesCrafted
    } as never));

    act(() => result.current({
      type: "FLAG_BURN_STARTED",
      operationId: "operation-1",
      requestId: "request-1",
      flagId: "flag-1",
      flagName: "North Watch",
      startedAt: 1_000,
      completesAt: 26_000,
      durationMs: 25_000,
      serverTime: 1_001,
      position: { lat: 40, lon: -105 }
    }));
    act(() => result.current({
      type: "TORCHES_CRAFTED",
      requestId: "request-2",
      quantity: 25,
      replayed: false,
      inventory: { playerId: "burner-1", revision: 2, items: [], totals: {} }
    } as never));

    expect(onFlagBurnStarted).toHaveBeenCalledOnce();
    expect(receiveInventorySnapshot).toHaveBeenCalledOnce();
    expect(onTorchesCrafted).toHaveBeenCalledWith(25);
  });

  it("starts and clears the authoritative flag hardening countdown", () => {
    const setFlagHardening = vi.fn();
    const setFlagBuildClock = vi.fn();
    const { result } = renderHook(() => useFlagFrameHandler({
      firstFlagsSnapshotRef: { current: true },
      flagPlacementValidationGateRef: { current: null },
      flagBuildIntentRef: { current: null },
      setFlagHardening,
      setFlagBuildClock
    } as never));
    act(() => result.current({
      type: "FLAG_REINFORCEMENT_STARTED", requestId: "request-1", flagId: "flag-1",
      flagName: "Home", startedAt: 1_000, completesAt: 16_000, durationMs: 15_000,
      serverTime: 1_001, position: { lat: 40, lon: -105 }, targetTier: "stone"
    }));
    expect(setFlagHardening).toHaveBeenCalledWith(expect.objectContaining({ flagId: "flag-1" }));
    expect(setFlagBuildClock).toHaveBeenCalledOnce();
    act(() => result.current({
      type: "FLAG_REINFORCEMENT_CANCELLED", requestId: "request-1", flagId: "flag-1",
      reason: "disconnect", serverTime: 2_000
    }));
    expect(setFlagHardening).toHaveBeenCalledTimes(2);
  });
  it("completes flag creation without changing player or Resource Vision authority", () => {
    const setFlags = vi.fn();
    const setFlagBuild = vi.fn();
    const setWarning = vi.fn();
    const setResourceVision = vi.fn();
    const setResourceVisionStatus = vi.fn();
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    const { result } = renderHook(() => useFlagFrameHandler({
      firstFlagsSnapshotRef: { current: true },
      flagPlacementValidationGateRef: { current: null },
      flagBuildIntentRef: { current: null },
      setFlags,
      setFlagBuild,
      setWarning,
      setResourceVision,
      setResourceVisionStatus
    } as never));

    act(() => result.current({
      type: "FLAG_CREATED",
      requestId: "request-1",
      buildId: "build-1",
      serverTime: Date.now(),
      flag: {
        id: "flag-1",
        name: "North Watch",
        lat: 35,
        lon: -106
      },
    } as never));

    expect(setResourceVision).not.toHaveBeenCalled();
    expect(setResourceVisionStatus).not.toHaveBeenCalled();
    expect(setFlags).toHaveBeenCalledOnce();
    expect(setFlagBuild).toHaveBeenCalledOnce();
    expect(setWarning).toHaveBeenCalledWith(null);
  });

  it("silently clears queued or active flag construction when canceled", () => {
    const setFlagBuild = vi.fn();
    const setFlagBuildQueued = vi.fn();
    const complete = vi.fn();
    const { result } = renderHook(() => useFlagFrameHandler({
      firstFlagsSnapshotRef: { current: true },
      flagPlacementValidationGateRef: {
        current: {
          pending: () => ({ requestId: "request-1" }),
          complete
        }
      },
      flagBuildIntentRef: { current: { complete: vi.fn() } },
      setFlagBuild,
      setFlagBuildQueued
    } as never));

    act(() => result.current({
      type: "FLAG_BUILD_CANCELLED",
      buildId: "build-1",
      requestId: "request-1",
      reason: "player-moved"
    } as never));

    expect(complete).toHaveBeenCalledWith("request-1");
    expect(setFlagBuild).toHaveBeenCalledOnce();
    expect(setFlagBuildQueued).toHaveBeenCalledOnce();
  });

  it("shows authoritative material deductions once after a successful build", () => {
    const enqueueFloatingFeedback = vi.fn();
    const receiveInventorySnapshot = vi.fn();
    const { result } = renderHook(() => useFlagFrameHandler({
      ownPlayerId: "player-1",
      overlayRef: { current: { enqueueFloatingFeedback } },
      firstFlagsSnapshotRef: { current: true },
      flagPlacementValidationGateRef: { current: null },
      flagBuildIntentRef: { current: null },
      setFlags: vi.fn(),
      setFlagBuild: vi.fn(),
      setWarning: vi.fn(),
      receiveInventorySnapshot
    } as never));
    const message = {
      type: "FLAG_CREATED",
      requestId: "request-1",
      buildId: "build-1",
      flag: { id: "flag-1", name: "Flag", lat: 35, lon: -106 },
      consumedMaterials: [
        { itemId: "wood", quantity: 3 },
        { itemId: "leather", quantity: 2 }
      ],
      inventory: {
        playerId: "player-1",
        items: [],
        totals: { wood: 41, leather: 6 }
      }
    };

    act(() => {
      result.current(message as never);
      result.current(message as never);
    });

    expect(receiveInventorySnapshot).toHaveBeenCalledOnce();
    expect(enqueueFloatingFeedback).toHaveBeenCalledTimes(2);
    expect(enqueueFloatingFeedback).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        icon: "wood",
        label: "\u22123 \u00b7 41"
      })
    );
    expect(enqueueFloatingFeedback).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        icon: "leather",
        label: "\u22122 \u00b7 6"
      })
    );
  });

  it("does not show deduction feedback for cancellation or stale success replays", () => {
    const enqueueFloatingFeedback = vi.fn();
    const { result } = renderHook(() => useFlagFrameHandler({
      ownPlayerId: "player-1",
      overlayRef: { current: { enqueueFloatingFeedback } },
      firstFlagsSnapshotRef: { current: true },
      flagPlacementValidationGateRef: { current: null },
      flagBuildIntentRef: { current: null },
      setFlags: vi.fn(),
      setFlagBuild: vi.fn(),
      setFlagBuildQueued: vi.fn(),
      setWarning: vi.fn(),
      receiveInventorySnapshot: vi.fn()
    } as never));

    act(() => {
      result.current({
        type: "FLAG_BUILD_CANCELLED",
        buildId: "build-1",
        requestId: "request-1",
        reason: "explicit"
      } as never);
      result.current({
        type: "FLAG_CREATED",
        requestId: "request-1",
        buildId: "build-1",
        flag: { id: "flag-1", name: "Flag", lat: 35, lon: -106 }
      } as never);
    });

    expect(enqueueFloatingFeedback).not.toHaveBeenCalled();
  });

  it("ignores a stale cancellation while a newer placement validates", () => {
    const completeIntent = vi.fn();
    const setFlagBuild = vi.fn();
    const setFlagBuildQueued = vi.fn();
    const { result } = renderHook(() => useFlagFrameHandler({
      firstFlagsSnapshotRef: { current: true },
      flagPlacementValidationGateRef: {
        current: {
          pending: () => ({ requestId: "request-new" }),
          complete: vi.fn()
        }
      },
      flagBuildIntentRef: { current: { complete: completeIntent } },
      setFlagBuild,
      setFlagBuildQueued
    } as never));

    act(() => result.current({
      type: "FLAG_BUILD_CANCELLED",
      buildId: "build-old",
      requestId: "request-old",
      reason: "superseded"
    } as never));

    expect(completeIntent).not.toHaveBeenCalled();
    expect(setFlagBuild).not.toHaveBeenCalled();
    expect(setFlagBuildQueued).not.toHaveBeenCalled();
  });

  it("preserves a revision 11 creation across both snapshot orderings", () => {
    for (const snapshotFirst of [true, false]) {
      const harness = revisionHarness(
        vi.fn(),
        snapshotFirst ? [] : [flag("flag-10")],
        snapshotFirst ? 0 : 10
      );
      const snapshot = {
        type: "FLAGS_SNAPSHOT",
        flags: [flag("flag-10")],
        flagSetRevision: 10,
        complete: true,
        truncated: false
      } as const;
      const created = {
        type: "FLAG_CREATED",
        requestId: "request-11",
        buildId: "build-11",
        flag: flag("flag-11"),
        flagSetRevision: 11
      } as const;

      act(() => {
        if (snapshotFirst) {
          harness.send(snapshot as never);
          harness.send(created as never);
        } else {
          harness.send(created as never);
          harness.send(snapshot as never);
        }
      });

      expect(harness.flagIds()).toEqual(["flag-10", "flag-11"]);
      expect(harness.revision.current).toBe(11);
    }
  });

  it("makes duplicate revision 11 upserts idempotent and ignores revision 11 after snapshot 12", () => {
    const harness = revisionHarness();
    const revision11 = {
      type: "FLAG_UPSERTED",
      flag: flag("flag-11"),
      serverTime: 1,
      flagSetRevision: 11
    } as const;
    act(() => {
      harness.send(revision11 as never);
      harness.send(revision11 as never);
      harness.send({
        type: "FLAGS_SNAPSHOT",
        flags: [flag("flag-11")],
        flagSetRevision: 11,
        complete: true,
        truncated: false
      } as never);
      harness.send({
        type: "FLAGS_SNAPSHOT",
        flags: [flag("flag-12")],
        flagSetRevision: 12,
        complete: true,
        truncated: false
      } as never);
      harness.send(revision11 as never);
    });

    expect(harness.flagIds()).toEqual(["flag-12"]);
    expect(harness.revision.current).toBe(12);
  });

  it("accepts a global revision leap without requesting a resync", () => {
    const requestFlagResync = vi.fn();
    const harness = revisionHarness(requestFlagResync);
    act(() => {
      harness.send({
        type: "FLAGS_SNAPSHOT",
        flags: [flag("flag-1")],
        flagSetRevision: 1,
        complete: true,
        truncated: false
      } as never);
      harness.send({
        type: "FLAGS_SNAPSHOT",
        flags: [flag("flag-4")],
        flagSetRevision: 4,
        complete: false,
        truncated: true
      } as never);
      harness.send({
        type: "FLAG_UPSERTED",
        flag: flag("flag-4"),
        serverTime: 1,
        flagSetRevision: 4
      } as never);
    });

    expect(harness.flagIds()).toEqual(["flag-1", "flag-4"]);
    expect(requestFlagResync).not.toHaveBeenCalled();
    expect(harness.revision.current).toBe(4);
  });

  it("renames a globally catalogued flag without changing catalogue membership", () => {
    const harness = revisionHarness();
    act(() => {
      harness.send(scopedChunk(
        "global-baseline",
        0,
        true,
        [flag("flag-near"), flag("flag-far", { name: "Old Name" })],
        1,
        10
      ) as never);
      harness.send({
        type: "FLAG_UPDATED",
        flag: flag("flag-far", { name: "New Name" }),
        flagSetRevision: 11
      } as never);
    });

    expect(harness.flagIds()).toEqual(["flag-far", "flag-near"]);
    expect(harness.flagById("flag-far")?.name).toBe("New Name");
  });

  it("applies a lower concurrent mutation when no accepted snapshot covers it", () => {
    const harness = revisionHarness();
    act(() => {
      harness.send({
        type: "FLAG_UPSERTED",
        flag: flag("flag-11"),
        serverTime: 1,
        flagSetRevision: 11
      } as never);
      harness.send({
        type: "FLAG_UPSERTED",
        flag: flag("flag-10"),
        serverTime: 2,
        flagSetRevision: 10
      } as never);
    });

    expect(harness.flagIds()).toEqual(["flag-10", "flag-11"]);
    expect(harness.revision.current).toBe(11);
  });

  it("requests one resync for a true missing scoped snapshot chunk", () => {
    const requestFlagResync = vi.fn();
    const harness = revisionHarness(requestFlagResync);
    act(() => {
      harness.send(scopedChunk("snapshot-1", 0, false, [flag("flag-1")]) as never);
      harness.send(scopedChunk(
        "snapshot-1",
        2,
        true,
        [flag("flag-3")],
        3
      ) as never);
    });

    expect(harness.flagIds()).toEqual([]);
    expect(requestFlagResync).toHaveBeenCalledOnce();
    expect(requestFlagResync).toHaveBeenCalledWith(
      "flag-snapshot-missing-chunk"
    );
  });

  it("atomically installs chunks and preserves a newer creation during assembly", () => {
    const harness = revisionHarness();
    act(() => {
      harness.send(scopedChunk("snapshot-2", 0, false, [flag("flag-100")], undefined, 100) as never);
      harness.send({
        type: "FLAG_CREATED",
        flag: flag("flag-111"),
        flagSetRevision: 111
      } as never);
      harness.send(scopedChunk("snapshot-2", 1, true, [flag("flag-101")], 2, 100) as never);
    });

    expect(harness.flagIds()).toEqual(["flag-100", "flag-101", "flag-111"]);
    expect(harness.revision.current).toBe(111);
  });

  it("reports readiness only after a complete scoped snapshot commits", () => {
    const onSnapshotCommitted = vi.fn();
    const harness = revisionHarness(vi.fn(), [], 0, onSnapshotCommitted);

    act(() => {
      harness.send(scopedChunk(
        "initial-snapshot",
        0,
        false,
        [flag("flag-1")],
        2
      ) as never);
    });
    expect(onSnapshotCommitted).not.toHaveBeenCalled();

    act(() => {
      harness.send(scopedChunk(
        "initial-snapshot",
        1,
        true,
        [flag("flag-2")],
        2
      ) as never);
    });
    expect(harness.flagIds()).toEqual(["flag-1", "flag-2"]);
    expect(onSnapshotCommitted).toHaveBeenCalledOnce();
  });

  it("installs an older baseline when a newer creation arrives before chunk zero", () => {
    const requestFlagResync = vi.fn();
    const harness = revisionHarness(requestFlagResync);
    act(() => {
      harness.send({
        type: "FLAG_CREATED",
        flag: flag("flag-111"),
        flagSetRevision: 111
      } as never);
      harness.send(scopedChunk(
        "snapshot-before-zero",
        0,
        false,
        [flag("flag-100-a")],
        2,
        100
      ) as never);
      harness.send(scopedChunk(
        "snapshot-before-zero",
        1,
        true,
        [flag("flag-100-b")],
        2,
        100
      ) as never);
    });

    expect(harness.flagIds()).toEqual([
      "flag-100-a",
      "flag-100-b",
      "flag-111"
    ]);
    expect(harness.revision.current).toBe(111);
    expect(requestFlagResync).not.toHaveBeenCalled();
  });

  it.each([
    ["before chunk zero", false],
    ["during assembly", true]
  ])("replays a deletion received %s without resurrecting the flag", (
    _label,
    chunkFirst
  ) => {
    const harness = revisionHarness(vi.fn(), [flag("flag-a")]);
    act(() => {
      if (chunkFirst) {
        harness.send(scopedChunk(
          "snapshot-delete",
          0,
          false,
          [flag("flag-a")],
          2,
          100
        ) as never);
      }
      harness.send({
        type: "FLAG_DELETED",
        flagId: "flag-a",
        flagSetRevision: 111
      } as never);
      if (!chunkFirst) {
        harness.send(scopedChunk(
          "snapshot-delete",
          0,
          false,
          [flag("flag-a")],
          2,
          100
        ) as never);
      }
      harness.send(scopedChunk(
        "snapshot-delete",
        1,
        true,
        [flag("flag-b")],
        2,
        100
      ) as never);
    });

    expect(harness.flagIds()).toEqual(["flag-b"]);
  });

  it.each([
    ["before chunk zero", false],
    ["during assembly", true]
  ])("replays complete access, toll, reinforcement, owner, city, and kingdom updates %s", (
    _label,
    chunkFirst
  ) => {
    const harness = revisionHarness();
    const updated = flag("flag-a", {
      accessMode: "public",
      jumpTollGold: "15",
      reinforcementLevel: 3,
      ownerUsername: "New Owner",
      ownerColor: "#112233",
      controlType: "kingdom",
      cityId: "city-1",
      kingdomId: "kingdom-1",
      kingdomName: "North"
    });
    act(() => {
      if (chunkFirst) {
        harness.send(scopedChunk(
          "snapshot-update",
          0,
          false,
          [flag("flag-a")],
          2,
          100
        ) as never);
      }
      harness.send({
        type: "FLAG_REINFORCED",
        flag: flag("flag-a", { reinforcementLevel: 3 }),
        inventory: {},
        flagSetRevision: 110
      } as never);
      harness.send({
        type: "FLAG_UPDATED",
        flag: updated,
        flagSetRevision: 111
      } as never);
      if (!chunkFirst) {
        harness.send(scopedChunk(
          "snapshot-update",
          0,
          false,
          [flag("flag-a")],
          2,
          100
        ) as never);
      }
      harness.send(scopedChunk(
        "snapshot-update",
        1,
        true,
        [flag("flag-b")],
        2,
        100
      ) as never);
    });

    expect(harness.flagById("flag-a")).toEqual(updated);
  });

  it("keeps a newer completed snapshot when an older assembly finishes afterward", () => {
    const requestFlagResync = vi.fn();
    const harness = revisionHarness(requestFlagResync);
    act(() => {
      harness.send(scopedChunk(
        "snapshot-100",
        0,
        false,
        [flag("old-a")],
        2,
        100
      ) as never);
      harness.send(scopedChunk(
        "snapshot-120",
        0,
        true,
        [flag("new-a")],
        1,
        120
      ) as never);
      harness.send(scopedChunk(
        "snapshot-100",
        1,
        true,
        [flag("old-b")],
        2,
        100
      ) as never);
    });

    expect(harness.flagIds()).toEqual(["new-a"]);
    expect(harness.setFlags).toHaveBeenCalledOnce();
    expect(requestFlagResync).not.toHaveBeenCalled();
  });

  it("applies equal-revision mutations for multiple flags", () => {
    const harness = revisionHarness();
    act(() => {
      harness.send({
        type: "FLAG_UPDATED",
        flag: flag("flag-a", { name: "A updated" }),
        flagSetRevision: 111
      } as never);
      harness.send({
        type: "FLAG_UPDATED",
        flag: flag("flag-b", { name: "B updated" }),
        flagSetRevision: 111
      } as never);
    });

    expect(harness.flagIds()).toEqual(["flag-a", "flag-b"]);
    expect(harness.flagById("flag-a")?.name).toBe("A updated");
    expect(harness.flagById("flag-b")?.name).toBe("B updated");
  });

  it("deduplicates identical upserts and tombstones without extra renders", () => {
    const harness = revisionHarness();
    const updated = {
      type: "FLAG_UPDATED",
      flag: flag("flag-a", { name: "updated" }),
      flagSetRevision: 111
    } as const;
    const deleted = {
      type: "FLAG_DELETED",
      flagId: "flag-a",
      flagSetRevision: 112
    } as const;
    act(() => {
      harness.send(updated as never);
      harness.send(updated as never);
      harness.send(deleted as never);
      harness.send(deleted as never);
    });

    expect(harness.flagIds()).toEqual([]);
    expect(harness.setFlags).toHaveBeenCalledTimes(2);
  });

  it("installs a targeted inventory refund delivered with flag destruction", () => {
    const harness = revisionHarness();
    const inventory = { totals: { stone: 3 } };
    act(() => {
      harness.send({
        type: "FLAG_DELETED",
        flagId: "flag-a",
        inventory
      } as never);
    });
    expect(harness.receiveInventorySnapshot).toHaveBeenCalledWith(inventory);
  });

  it("ignores old connection, scope, and assembly-epoch chunks", () => {
    const requestFlagResync = vi.fn();
    const harness = revisionHarness(requestFlagResync, [flag("current")]);
    act(() => {
      harness.send(scopedChunk(
        "old-connection",
        0,
        true,
        [flag("stale")],
        1,
        100,
        { connectionGeneration: 1 }
      ) as never);
      harness.send(scopedChunk(
        "old-scope",
        0,
        true,
        [flag("stale")],
        1,
        100,
        { scopeId: "other-flags" }
      ) as never);
      harness.send(scopedChunk(
        "old-epoch",
        0,
        false,
        [flag("stale")],
        2,
        100
      ) as never);
      harness.snapshotAssemblyEpoch.current += 1;
      harness.send(scopedChunk(
        "old-epoch",
        1,
        true,
        [flag("stale-2")],
        2,
        100
      ) as never);
    });

    expect(harness.flagIds()).toEqual(["current"]);
    expect(requestFlagResync).toHaveBeenCalledTimes(1);
  });

  it("does not discard a global assembly when gameplay generation changes", () => {
    const harness = revisionHarness();
    act(() => {
      harness.send(scopedChunk(
        "global-across-jump",
        0,
        false,
        [flag("flag-a")],
        2,
        100,
        { gameplayViewGeneration: 3 }
      ) as never);
      harness.send(scopedChunk(
        "global-across-jump",
        1,
        true,
        [flag("flag-b")],
        2,
        100,
        { gameplayViewGeneration: 4 }
      ) as never);
    });

    expect(harness.flagIds()).toEqual(["flag-a", "flag-b"]);
  });

  it("rejects an old gameplay-circle snapshot after relocation", () => {
    const requestFlagResync = vi.fn();
    const harness = revisionHarness(requestFlagResync, [flag("current")]);
    harness.scopedFlagSnapshots.current = true;
    harness.relocationRevision.current = 4;
    harness.gameplayViewGeneration.current = 9;
    act(() => {
      harness.send(scopedChunk(
        "current-circle",
        0,
        true,
        [flag("nearby")],
        1,
        100,
        {
          scopeKind: "gameplay-circle-flags",
          scopeId: "gameplay-circle-flags:4:9",
          relocationRevision: 4,
          gameplayViewGeneration: 9
        }
      ) as never);
    });
    expect(harness.flagIds()).toEqual(["nearby"]);

    harness.relocationRevision.current = 5;
    harness.gameplayViewGeneration.current = 10;
    act(() => {
      harness.send(scopedChunk(
        "old-circle",
        0,
        true,
        [flag("stale")],
        1,
        101,
        {
          scopeKind: "gameplay-circle-flags",
          scopeId: "gameplay-circle-flags:4:9",
          relocationRevision: 4,
          gameplayViewGeneration: 9
        }
      ) as never);
      harness.send(scopedChunk(
        "new-circle",
        0,
        true,
        [flag("destination")],
        1,
        101,
        {
          scopeKind: "gameplay-circle-flags",
          scopeId: "gameplay-circle-flags:5:10",
          relocationRevision: 5,
          gameplayViewGeneration: 10
        }
      ) as never);
    });

    expect(harness.flagIds()).toEqual(["destination"]);
    expect(requestFlagResync).toHaveBeenCalledWith(
      "flag-snapshot-authority-mismatch"
    );
  });

  it("preserves strategic flags while replacing the previous gameplay circle", () => {
    const strategicFlagIds = { current: new Set(["strategic"]) };
    const harness = revisionHarness(
      vi.fn(),
      [flag("old-gameplay"), flag("strategic")],
      0,
      vi.fn(),
      strategicFlagIds
    );
    harness.scopedFlagSnapshots.current = true;
    harness.relocationRevision.current = 4;
    harness.gameplayViewGeneration.current = 9;

    act(() => {
      harness.send(scopedChunk(
        "new-circle",
        0,
        true,
        [flag("new-gameplay")],
        1,
        100,
        {
          scopeKind: "gameplay-circle-flags",
          scopeId: "gameplay-circle-flags:4:9",
          relocationRevision: 4,
          gameplayViewGeneration: 9
        }
      ) as never);
    });

    expect(harness.flagIds()).toEqual(["new-gameplay", "strategic"]);
  });

  it("resets accepted revisions when the connection authority changes", () => {
    const harness = revisionHarness();
    act(() => {
      harness.send(scopedChunk(
        "connection-1-snapshot",
        0,
        true,
        [flag("old-authority")],
        1,
        100
      ) as never);
      harness.connectionId.current = "connection-2";
      harness.connectionGeneration.current = 3;
      harness.send(scopedChunk(
        "connection-2-snapshot",
        0,
        true,
        [flag("new-authority")],
        1,
        1,
        {
          connectionId: "connection-2",
          connectionGeneration: 3
        }
      ) as never);
    });

    expect(harness.flagIds()).toEqual(["new-authority"]);
  });

  it("rejects old replacement chunks and installs the new connection baseline", () => {
    const harness = revisionHarness();
    act(() => {
      harness.send(scopedChunk(
        "old-assembly",
        0,
        false,
        [flag("old-partial")],
        2,
        100
      ) as never);
      harness.connectionId.current = "connection-2";
      harness.connectionGeneration.current = 3;
      harness.snapshotAssemblyEpoch.current += 1;
      harness.send(scopedChunk(
        "old-assembly",
        1,
        true,
        [flag("old-final")],
        2,
        100
      ) as never);
      harness.send(scopedChunk(
        "new-baseline",
        0,
        true,
        [flag("new-global")],
        1,
        1,
        {
          connectionId: "connection-2",
          connectionGeneration: 3
        }
      ) as never);
    });

    expect(harness.flagIds()).toEqual(["new-global"]);
  });

  it("keeps rendered flags and requests one resync for conflicting chunks", () => {
    const requestFlagResync = vi.fn();
    const harness = revisionHarness(requestFlagResync, [flag("current")]);
    act(() => {
      harness.send(scopedChunk(
        "snapshot-conflict",
        0,
        false,
        [flag("flag-a")],
        2,
        100
      ) as never);
      harness.send(scopedChunk(
        "snapshot-conflict",
        0,
        false,
        [flag("flag-b")],
        2,
        100
      ) as never);
      harness.send(scopedChunk(
        "snapshot-conflict",
        0,
        false,
        [flag("flag-c")],
        2,
        100
      ) as never);
    });

    expect(harness.flagIds()).toEqual(["current"]);
    expect(requestFlagResync).toHaveBeenCalledOnce();
  });

  it("renders no partial chunks and atomically installs a 1,001-mutation replay once", () => {
    const harness = revisionHarness();
    act(() => {
      harness.send(scopedChunk(
        "snapshot-linear",
        0,
        false,
        [flag("baseline-a")],
        2,
        100
      ) as never);
    });
    expect(harness.setFlags).not.toHaveBeenCalled();

    act(() => {
      for (let index = 0; index < 1_001; index += 1) {
        harness.send({
          type: "FLAG_UPDATED",
          flag: flag(`mutation-${index}`),
          flagSetRevision: 101 + index
        } as never);
      }
    });
    const mutationRenderCount = harness.setFlags.mock.calls.length;

    act(() => {
      harness.send(scopedChunk(
        "snapshot-linear",
        1,
        true,
        [flag("baseline-b")],
        2,
        100
      ) as never);
    });

    expect(harness.setFlags).toHaveBeenCalledTimes(mutationRenderCount + 1);
    expect(harness.flagIds()).toHaveLength(1_003);
    expect(new Set(harness.flagIds()).size).toBe(1_003);
  });

  it("bounds the mutation journal and keeps the rendered flag on recovery", () => {
    const requestFlagResync = vi.fn();
    const harness = revisionHarness(requestFlagResync);
    act(() => {
      for (let index = 0; index <= 8_192; index += 1) {
        harness.send({
          type: "FLAG_UPDATED",
          flag: flag("flag-a", { name: `revision-${index}` }),
          flagSetRevision: index + 1
        } as never);
      }
    });

    expect(harness.flagById("flag-a")?.name).toBe("revision-8192");
    expect(requestFlagResync).toHaveBeenCalledOnce();
    expect(requestFlagResync).toHaveBeenCalledWith(
      "flag-mutation-journal-bounds-exceeded"
    );
  });

  it("bounds deletion tombstones and keeps the current rendered state", () => {
    const requestFlagResync = vi.fn();
    const harness = revisionHarness(requestFlagResync);
    act(() => {
      for (let index = 0; index <= 2_048; index += 1) {
        harness.send({
          type: "FLAG_DELETED",
          flagId: `flag-${index}`,
          flagSetRevision: index + 1
        } as never);
      }
    });

    expect(harness.flagIds()).toEqual([]);
    expect(requestFlagResync).toHaveBeenCalledOnce();
    expect(requestFlagResync).toHaveBeenCalledWith(
      "flag-mutation-journal-bounds-exceeded"
    );
  });

  it("expires an old journal into a bounded resync without blanking flags", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-26T18:00:00.000Z"));
    try {
      const requestFlagResync = vi.fn();
      const harness = revisionHarness(requestFlagResync);
      act(() => {
        harness.send({
          type: "FLAG_UPDATED",
          flag: flag("flag-a", { name: "first" }),
          flagSetRevision: 111
        } as never);
      });
      vi.setSystemTime(new Date("2026-07-26T18:05:00.001Z"));
      act(() => {
        harness.send({
          type: "FLAG_UPDATED",
          flag: flag("flag-a", { name: "second" }),
          flagSetRevision: 112
        } as never);
      });

      expect(harness.flagById("flag-a")?.name).toBe("second");
      expect(requestFlagResync).toHaveBeenCalledOnce();
      expect(requestFlagResync).toHaveBeenCalledWith(
        "flag-mutation-journal-expired"
      );
    } finally {
      vi.useRealTimers();
    }
  });
});

function revisionHarness(
  requestFlagResync = vi.fn(),
  initialFlags: TestFlag[] = [],
  initialRevision = 0,
  onSnapshotCommitted = vi.fn(),
  strategicFlagIdsRef?: { current: ReadonlySet<string> }
) {
  let flags = [...initialFlags];
  const revision = { current: initialRevision };
  const connectionId = { current: "connection-1" as string | null };
  const connectionGeneration = { current: 2 };
  const scopedFlagSnapshots = { current: false };
  const relocationRevision = { current: 0 };
  const gameplayViewGeneration = { current: 0 };
  const snapshotAssemblyEpoch = { current: 1 };
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  const setFlags = vi.fn((update: unknown) => {
    flags = typeof update === "function"
      ? (update as (current: TestFlag[]) => TestFlag[])(flags)
      : update as TestFlag[];
  });
  const receiveInventorySnapshot = vi.fn();
  const { result } = renderHook(() => useFlagFrameHandler({
    firstFlagsSnapshotRef: { current: true },
    flagPlacementValidationGateRef: { current: null },
    flagBuildIntentRef: { current: null },
    flagSetRevisionRef: revision,
    connectionIdRef: connectionId,
    connectionGenerationRef: connectionGeneration,
    scopedFlagSnapshotsRef: scopedFlagSnapshots,
    relocationRevisionRef: relocationRevision,
    gameplayViewGenerationRef: gameplayViewGeneration,
    snapshotAssemblyEpochRef: snapshotAssemblyEpoch,
    strategicFlagIdsRef,
    requestFlagResync,
    onSnapshotCommitted,
    setFlags,
    setFlagBuild: vi.fn(),
    setSelectedFlagId: vi.fn(),
    setResourceVision: vi.fn(),
    setResourceVisionStatus: vi.fn(),
    setWaterHighlights: vi.fn(),
    requestHarvestCancellation: vi.fn(),
    setWarning: vi.fn(),
    receiveInventorySnapshot
  } as never));
  return {
    send: result.current,
    revision,
    connectionId,
    connectionGeneration,
    scopedFlagSnapshots,
    relocationRevision,
    gameplayViewGeneration,
    snapshotAssemblyEpoch,
    setFlags,
    receiveInventorySnapshot,
    flagIds: () => flags.map((entry) => entry.id).sort(),
    flagById: (id: string) => flags.find((entry) => entry.id === id)
  };
}

function scopedChunk(
  snapshotId: string,
  chunkIndex: number,
  finalChunk: boolean,
  flags: Array<{ id: string }>,
  chunkCount?: number,
  flagSetRevision = 10,
  authorityOverrides: Record<string, unknown> = {}
) {
  return {
    type: "FLAGS_SNAPSHOT",
    flags,
    flagSetRevision,
    complete: true,
    truncated: false,
    authority: {
      connectionId: "connection-1",
      connectionGeneration: 2,
      scopeKind: "global-flags",
      scopeId: "global-flags",
      snapshotId,
      chunkIndex,
      ...(chunkCount === undefined ? {} : { chunkCount }),
      finalChunk,
      ...authorityOverrides
    }
  };
}

type TestFlag = { id: string } & Record<string, unknown>;

function flag(id: string, overrides: Record<string, unknown> = {}): TestFlag {
  return {
    id,
    name: id,
    lat: 35,
    lon: -106,
    ...overrides
  };
}
