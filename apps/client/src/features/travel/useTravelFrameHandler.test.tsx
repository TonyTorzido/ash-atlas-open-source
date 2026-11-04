// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { HarvestPhase, HarvestTask } from "../../collectibles/harvest.js";
import { useTravelFrameHandler } from "./useTravelFrameHandler.js";

describe("useTravelFrameHandler global notice policy", () => {
  it("delivers the server-reserved flag arrival slot before commit", () => {
    const onVisibleFlagVisitPrepared = vi.fn();
    const { result } = renderHook(() => useTravelFrameHandler({
      onVisibleFlagVisitPrepared,
      observeManorTravelResult: vi.fn(),
      completedTravelArrivalRequestIdsRef: { current: new Set() }
    } as never));
    const frame = {
      type: "VISIBLE_FLAG_VISIT_PREPARED",
      requestId: "prepare-flag-1",
      flagId: "flag-1",
      playerSpawnPosition: { lat: 39.7397, lon: -104.9903 },
      expiresInMs: 15_000
    } as const;

    act(() => result.current(frame));

    expect(onVisibleFlagVisitPrepared).toHaveBeenCalledWith(frame);
  });

  it("reports authoritative travel frames to the World Map coordinator", () => {
    const observeWorldMapTravelFrame = vi.fn();
    const { result } = renderHook(() => useTravelFrameHandler({
      observeWorldMapTravelFrame,
      observeManorTravelResult: vi.fn(),
      completedTravelArrivalRequestIdsRef: { current: new Set() }
    } as never));
    const frame = {
      type: "TRAVEL_RESULT",
      requestId: "manor-1",
      kind: "manor_jump",
      success: true,
      message: "Jumped to manor."
    } as const;

    act(() => result.current(frame));

    expect(observeWorldMapTravelFrame).toHaveBeenCalledOnce();
    expect(observeWorldMapTravelFrame).toHaveBeenCalledWith(frame);
  });

  it("shows a military leave-behind warning on successful GPS relocation", () => {
    const setWarning = vi.fn();
    const warning = "Your troops will remain behind.";
    const { result } = renderHook(() => useTravelFrameHandler({
      observeManorTravelResult: vi.fn(),
      setWarning
    } as never));

    act(() => result.current({
      type: "TRAVEL_RESULT",
      requestId: "gps-relocate-1",
      kind: "gps_relocate",
      success: true,
      message: `Relocated to your current location. ${warning}`,
      warning
    }));

    expect(setWarning).toHaveBeenCalledWith(warning);
  });

  it.each(["flag_visit", "city_visit", "manor_jump"])(
    "does not report successful %s travel as an action error",
    (kind) => {
      const showActionError = vi.fn();
      const { result } = renderHook(() => useTravelFrameHandler({
        observeManorTravelResult: vi.fn(),
        pendingTravelRequestIdRef: { current: null },
        postArrivalTravelRequestIdRef: { current: null },
        postArrivalTravelRequestExpiresAtRef: { current: 0 },
        completedTravelArrivalRequestIdsRef: { current: new Set() },
        localMovementRequests: { discardBoundTo: vi.fn() },
        showActionError
      } as never));

      act(() => result.current({
        type: "TRAVEL_RESULT",
        requestId: `request-${kind}`,
        kind,
        success: true,
        message: "Travel completed."
      } as never));

      expect(showActionError).not.toHaveBeenCalled();
    }
  );

  it("shows the authoritative Travel Invite sent confirmation", () => {
    const onTravelInviteSent = vi.fn();
    const { result } = renderHook(() => useTravelFrameHandler({
      observeManorTravelResult: vi.fn(),
      pendingTravelRequestIdRef: { current: null },
      postArrivalTravelRequestIdRef: { current: null },
      postArrivalTravelRequestExpiresAtRef: { current: 0 },
      completedTravelArrivalRequestIdsRef: { current: new Set() },
      localMovementRequests: { discardBoundTo: vi.fn() },
      onTravelInviteSent
    } as never));

    act(() => result.current({
      type: "TRAVEL_RESULT",
      requestId: "send-invite",
      kind: "invite_sent",
      success: true,
      message: "Travel Invite sent."
    }));

    expect(onTravelInviteSent).toHaveBeenCalledWith(expect.objectContaining({
      requestId: "send-invite",
      kind: "invite_sent",
      success: true
    }));
  });

  it("surfaces a rejected travel result as an actionable error", () => {
    const showActionError = vi.fn();
    const setWarning = vi.fn();
    const discardBoundTo = vi.fn();
    const { result } = renderHook(() => useTravelFrameHandler({
      observeManorTravelResult: vi.fn(),
      pendingTravelRequestIdRef: { current: "request-1" },
      postArrivalTravelRequestIdRef: { current: null },
      postArrivalTravelRequestExpiresAtRef: { current: 0 },
      completedTravelArrivalRequestIdsRef: { current: new Set() },
      localMovementRequests: { discardBoundTo },
      setWarning,
      showActionError
    } as never));

    act(() => result.current({
      type: "TRAVEL_RESULT",
      requestId: "request-1",
      kind: "flag_visit",
      success: false,
      message: "The destination is no longer available."
    } as never));

    expect(discardBoundTo).toHaveBeenCalledWith("request-1");
    expect(setWarning).toHaveBeenCalledWith(
      "The destination is no longer available."
    );
    expect(showActionError).toHaveBeenCalledWith(
      "The destination is no longer available."
    );
  });

  it("limits a duplicate same-epoch flag arrival to repeatable UI metadata", () => {
    const setWalletGold = vi.fn();
    const setFlagListOpen = vi.fn();
    const setPlayers = vi.fn();
    const cancelActiveHarvest = vi.fn();
    const clearDroppedItemInteraction = vi.fn();
    const setSelectedCityId = vi.fn();
    const setSelectedFlagId = vi.fn();
    const completed = new Set(["flag-request"]);
    const { result } = renderHook(() => useTravelFrameHandler({
      observeManorTravelResult: vi.fn(),
      installCommittedWorldViewEpoch: vi.fn(
        () => "same-epoch-already-installed"
      ),
      completedTravelArrivalRequestIdsRef: { current: completed },
      pendingTravelRequestIdRef: { current: null },
      localPlayerRef: { current: null },
      setWalletGold,
      setFlagListOpen,
      setPlayers,
      cancelActiveHarvest,
      clearDroppedItemInteraction,
      setSelectedCityId,
      setSelectedFlagId,
      setWarning: vi.fn()
    } as never));

    act(() => result.current({
      type: "FLAG_VISITED",
      requestId: "flag-request",
      flagId: "flag-1",
      resourceVisionRevision: 9,
      player: {
        playerId: "player-1",
        relocationRevision: 7
      },
      walletGold: "42"
    } as never));

    expect(setWalletGold).toHaveBeenCalledWith("42");
    expect(setFlagListOpen).toHaveBeenCalledOnce();
    expect(setPlayers).toHaveBeenCalledOnce();
    expect(cancelActiveHarvest).not.toHaveBeenCalled();
    expect(clearDroppedItemInteraction).not.toHaveBeenCalled();
    expect(setSelectedCityId).not.toHaveBeenCalled();
    expect(setSelectedFlagId).not.toHaveBeenCalled();
  });

  it.each(["approaching", "starting"] satisfies HarvestPhase[])(
    "releases %s gathering intent when a flag arrival commits a new epoch",
    (phase) => {
      const harvestTaskRef = {
        current: {
          nodeId: "tree-after-flag",
          action: "primary",
          phase,
          sessionId: null,
          completesAtMs: null,
          startedAtMs: null,
          startRequestedAtMs: phase === "starting" ? 1 : null
        } as HarvestTask | null
      };
      const requestHarvestCancellation = vi.fn((stopMovement?: boolean) => {
        expect(stopMovement).toBe(false);
        harvestTaskRef.current = null;
      });
      const { result } = renderHook(() => useTravelFrameHandler({
        observeManorTravelResult: vi.fn(),
        installCommittedWorldViewEpoch: vi.fn(() => "new-epoch-installed"),
        completedTravelArrivalRequestIdsRef: { current: new Set() },
        pendingTravelRequestIdRef: { current: null },
        localMovementRequests: { resetUnlessBoundTo: vi.fn(() => null) },
        localPlayerRef: { current: null },
        playerRenderTimeline: { snapPlayer: vi.fn(() => false) },
        harvestTaskRef,
        requestHarvestCancellation,
        setPlayers: vi.fn(),
        setSelectedCityId: vi.fn(),
        setSelectedFlagId: vi.fn(),
        setFlagListOpen: vi.fn(),
        setWarning: vi.fn(),
        centerCamera: vi.fn()
      } as never));

      act(() => result.current({
        type: "FLAG_VISITED",
        requestId: "flag-request",
        flagId: "destination-flag",
        resourceVisionRevision: 9,
        player: {
          playerId: "player-1",
          relocationRevision: 7,
          lat: 35.101,
          lon: -106.602
        }
      } as never));

      expect(requestHarvestCancellation).toHaveBeenCalledOnce();
      expect(requestHarvestCancellation).toHaveBeenCalledWith(false);
      expect(harvestTaskRef.current).toBeNull();
    }
  );

  it.each(["harvesting", "completing"] satisfies HarvestPhase[])(
    "preserves an authoritative %s session across a flag arrival",
    (phase) => {
      const activeTask: HarvestTask = {
        nodeId: "tree-active",
        action: "primary",
        phase,
        sessionId: "harvest-session",
        completesAtMs: 10_000,
        startedAtMs: 1,
        startRequestedAtMs: 1
      };
      const harvestTaskRef = { current: activeTask as HarvestTask | null };
      const requestHarvestCancellation = vi.fn();
      const { result } = renderHook(() => useTravelFrameHandler({
        observeManorTravelResult: vi.fn(),
        installCommittedWorldViewEpoch: vi.fn(() => "new-epoch-installed"),
        completedTravelArrivalRequestIdsRef: { current: new Set() },
        pendingTravelRequestIdRef: { current: null },
        localMovementRequests: { resetUnlessBoundTo: vi.fn(() => null) },
        localPlayerRef: { current: null },
        playerRenderTimeline: { snapPlayer: vi.fn(() => false) },
        harvestTaskRef,
        requestHarvestCancellation,
        setPlayers: vi.fn(),
        setSelectedCityId: vi.fn(),
        setSelectedFlagId: vi.fn(),
        setFlagListOpen: vi.fn(),
        setWarning: vi.fn(),
        centerCamera: vi.fn()
      } as never));

      act(() => result.current({
        type: "FLAG_VISITED",
        requestId: "flag-request",
        flagId: "destination-flag",
        resourceVisionRevision: 9,
        player: {
          playerId: "player-1",
          relocationRevision: 7,
          lat: 35.101,
          lon: -106.602
        }
      } as never));

      expect(requestHarvestCancellation).not.toHaveBeenCalled();
      expect(harvestTaskRef.current).toBe(activeTask);
    }
  );

  it.each(["approaching", "starting"] satisfies HarvestPhase[])(
    "clears stale selection and releases %s gathering intent on generic travel",
    (phase) => {
      const harvestTaskRef = {
        current: {
          nodeId: "tree-before-party-travel",
          action: "primary",
          phase,
          sessionId: null,
          completesAtMs: null,
          startedAtMs: null,
          startRequestedAtMs: phase === "starting" ? 1 : null
        } as HarvestTask | null
      };
      const requestHarvestCancellation = vi.fn((stopMovement?: boolean) => {
        expect(stopMovement).toBe(false);
        harvestTaskRef.current = null;
      });
      const setSelectedFlagId = vi.fn();
      const setSelectedCityId = vi.fn();
      const setFlagListOpen = vi.fn();
      const { result } = renderHook(() => useTravelFrameHandler({
        observeManorTravelResult: vi.fn(),
        installCommittedWorldViewEpoch: vi.fn(() => "new-epoch-installed"),
        completedTravelArrivalRequestIdsRef: { current: new Set() },
        pendingTravelRequestIdRef: { current: null },
        postArrivalTravelRequestIdRef: { current: null },
        postArrivalTravelRequestExpiresAtRef: { current: 0 },
        localMovementRequests: { resetUnlessBoundTo: vi.fn(() => null) },
        localPlayerRef: { current: null },
        playerRenderTimeline: { snapPlayer: vi.fn(() => false) },
        harvestTaskRef,
        requestHarvestCancellation,
        setPlayers: vi.fn(),
        setSelectedFlagId,
        setSelectedCityId,
        setFlagListOpen,
        centerCamera: vi.fn()
      } as never));

      act(() => result.current({
        type: "TRAVEL_RESULT",
        requestId: "party-follow-request",
        kind: "party_auto_follow",
        success: true,
        message: "Travelled to the party leader.",
        resourceVisionRevision: 9,
        player: {
          playerId: "player-1",
          relocationRevision: 7,
          anchorLat: 35.101,
          anchorLon: -106.602
        }
      } as never));

      expect(requestHarvestCancellation).toHaveBeenCalledOnce();
      expect(harvestTaskRef.current).toBeNull();
      expect(setSelectedFlagId).toHaveBeenCalledWith(null);
      expect(setSelectedCityId).toHaveBeenCalledWith(null);
      expect(setFlagListOpen).toHaveBeenCalledWith(false);
    }
  );

  it.each(["harvesting", "completing"] satisfies HarvestPhase[])(
    "preserves an authoritative %s session across generic travel",
    (phase) => {
      const activeTask: HarvestTask = {
        nodeId: "tree-active",
        action: "primary",
        phase,
        sessionId: "harvest-session",
        completesAtMs: 10_000,
        startedAtMs: 1,
        startRequestedAtMs: 1
      };
      const harvestTaskRef = { current: activeTask as HarvestTask | null };
      const requestHarvestCancellation = vi.fn();
      const { result } = renderHook(() => useTravelFrameHandler({
        observeManorTravelResult: vi.fn(),
        installCommittedWorldViewEpoch: vi.fn(() => "new-epoch-installed"),
        completedTravelArrivalRequestIdsRef: { current: new Set() },
        pendingTravelRequestIdRef: { current: null },
        postArrivalTravelRequestIdRef: { current: null },
        postArrivalTravelRequestExpiresAtRef: { current: 0 },
        localMovementRequests: { resetUnlessBoundTo: vi.fn(() => null) },
        localPlayerRef: { current: null },
        playerRenderTimeline: { snapPlayer: vi.fn(() => false) },
        harvestTaskRef,
        requestHarvestCancellation,
        setPlayers: vi.fn(),
        setSelectedFlagId: vi.fn(),
        setSelectedCityId: vi.fn(),
        setFlagListOpen: vi.fn(),
        centerCamera: vi.fn()
      } as never));

      act(() => result.current({
        type: "TRAVEL_RESULT",
        requestId: "invite-request",
        kind: "invite",
        success: true,
        message: "Travel Invite accepted.",
        player: {
          playerId: "player-1",
          relocationRevision: 7,
          anchorLat: 35.101,
          anchorLon: -106.602
        }
      } as never));

      expect(requestHarvestCancellation).not.toHaveBeenCalled();
      expect(harvestTaskRef.current).toBe(activeTask);
    }
  );

  it("uses the protected jump presentation for a Manor arrival", () => {
    const beginFlagTravelPresentation = vi.fn(() => ({
      id: 1,
      newlyFrozen: true
    }));
    const centerCamera = vi.fn();
    const player = {
      playerId: "player-1",
      relocationRevision: 7,
      anchorLat: 35.101,
      anchorLon: -106.602,
      currentFlagId: null
    };
    const { result } = renderHook(() => useTravelFrameHandler({
      observeManorTravelResult: vi.fn(),
      installCommittedWorldViewEpoch: vi.fn(() => "new-epoch-installed"),
      beginFlagTravelPresentation,
      completedTravelArrivalRequestIdsRef: { current: new Set() },
      pendingTravelRequestIdRef: { current: "manor-request" },
      postArrivalTravelRequestIdRef: { current: null },
      postArrivalTravelRequestExpiresAtRef: { current: 0 },
      localMovementRequests: { resetUnlessBoundTo: vi.fn(() => null) },
      localPlayerRef: { current: null },
      playerRenderTimeline: { snapPlayer: vi.fn(() => false) },
      harvestTaskRef: { current: null },
      requestHarvestCancellation: vi.fn(),
      setPlayers: vi.fn(),
      setSelectedFlagId: vi.fn(),
      setSelectedCityId: vi.fn(),
      setFlagListOpen: vi.fn(),
      centerCamera
    } as never));

    act(() => result.current({
      type: "TRAVEL_RESULT",
      requestId: "manor-request",
      kind: "manor_jump",
      success: true,
      message: "Jumped to manor.",
      resourceVisionRevision: 9,
      arrivalPresentation: "jump",
      player
    } as never));

    expect(beginFlagTravelPresentation).toHaveBeenCalledWith(
      player,
      9,
      null,
      "manor-request"
    );
    expect(centerCamera).toHaveBeenCalledWith(
      "visit-flag",
      { lat: player.anchorLat, lon: player.anchorLon },
      420,
      620,
      "arrival",
      "manor-request"
    );
  });

  it("does not reapply a duplicate same-epoch travel result", () => {
    const installCommittedWorldViewEpoch = vi.fn(
      () => "same-epoch-already-installed"
    );
    const setPlayers = vi.fn();
    const requestHarvestCancellation = vi.fn();
    const setSelectedFlagId = vi.fn();
    const setSelectedCityId = vi.fn();
    const setFlagListOpen = vi.fn();
    const { result } = renderHook(() => useTravelFrameHandler({
      observeManorTravelResult: vi.fn(),
      installCommittedWorldViewEpoch,
      completedTravelArrivalRequestIdsRef: {
        current: new Set(["travel-request"])
      },
      pendingTravelRequestIdRef: { current: null },
      postArrivalTravelRequestIdRef: { current: null },
      postArrivalTravelRequestExpiresAtRef: { current: 0 },
      localMovementRequests: { discardBoundTo: vi.fn() },
      harvestTaskRef: { current: null },
      requestHarvestCancellation,
      setSelectedFlagId,
      setSelectedCityId,
      setFlagListOpen,
      setPlayers
    } as never));
    const frame = {
      type: "TRAVEL_RESULT",
      requestId: "travel-request",
      kind: "flag_visit",
      success: true,
      message: "Travel completed.",
      resourceVisionRevision: 9,
      player: {
        playerId: "player-1",
        relocationRevision: 7
      }
    } as const;

    act(() => result.current(frame as never));
    act(() => result.current(frame as never));

    expect(installCommittedWorldViewEpoch).toHaveBeenCalledTimes(2);
    expect(setPlayers).not.toHaveBeenCalled();
    expect(requestHarvestCancellation).not.toHaveBeenCalled();
    expect(setSelectedFlagId).not.toHaveBeenCalled();
    expect(setSelectedCityId).not.toHaveBeenCalled();
    expect(setFlagListOpen).not.toHaveBeenCalled();
  });

  it("ignores a stale arrival before it can update UI or projection state", () => {
    const setWalletGold = vi.fn();
    const setPlayers = vi.fn();
    const { result } = renderHook(() => useTravelFrameHandler({
      observeManorTravelResult: vi.fn(),
      installCommittedWorldViewEpoch: vi.fn(
        () => "stale-epoch-ignored"
      ),
      completedTravelArrivalRequestIdsRef: { current: new Set() },
      pendingTravelRequestIdRef: { current: null },
      setWalletGold,
      setPlayers
    } as never));

    act(() => result.current({
      type: "FLAG_VISITED",
      requestId: "old-request",
      flagId: "old-flag",
      resourceVisionRevision: 8,
      player: {
        playerId: "player-1",
        relocationRevision: 6
      },
      walletGold: "1"
    } as never));

    expect(setWalletGold).not.toHaveBeenCalled();
    expect(setPlayers).not.toHaveBeenCalled();
  });

  it("leaves the origin presentation untouched when travel fails before FLAG_VISITED", () => {
    const beginFlagTravelPresentation = vi.fn();
    const cancelPendingFlagTravelCamera = vi.fn();
    const { result } = renderHook(() => useTravelFrameHandler({
      observeManorTravelResult: vi.fn(),
      beginFlagTravelPresentation,
      cancelPendingFlagTravelCamera,
      pendingTravelRequestIdRef: { current: "request-1" },
      postArrivalTravelRequestIdRef: { current: null },
      postArrivalTravelRequestExpiresAtRef: { current: 0 },
      completedTravelArrivalRequestIdsRef: { current: new Set() },
      localMovementRequests: { discardBoundTo: vi.fn() },
      setWarning: vi.fn(),
      showActionError: vi.fn()
    } as never));

    act(() => result.current({
      type: "TRAVEL_RESULT",
      requestId: "request-1",
      kind: "invite",
      success: false,
      message: "Travel failed."
    } as never));

    expect(beginFlagTravelPresentation).not.toHaveBeenCalled();
    expect(cancelPendingFlagTravelCamera).toHaveBeenCalledWith("request-1");
  });

  it("captures the presented origin before epoch installation and cancels a stale arrival", () => {
    const order: string[] = [];
    const capture = { id: 1, newlyFrozen: true } as const;
    const beginFlagTravelPresentation = vi.fn(() => {
      order.push("capture");
      return capture;
    });
    const cancelFlagTravelPresentation = vi.fn(() => {
      order.push("cancel");
    });
    const { result } = renderHook(() => useTravelFrameHandler({
      observeManorTravelResult: vi.fn(),
      beginFlagTravelPresentation,
      cancelFlagTravelPresentation,
      installCommittedWorldViewEpoch: vi.fn(() => {
        order.push("install");
        return "stale-epoch-ignored";
      }),
      completedTravelArrivalRequestIdsRef: { current: new Set() },
      pendingTravelRequestIdRef: { current: null }
    } as never));

    act(() => result.current({
      type: "FLAG_VISITED",
      requestId: "stale-request",
      flagId: "stale-flag",
      resourceVisionRevision: 8,
      player: {
        playerId: "player-1",
        relocationRevision: 6,
        lat: 35.101,
        lon: -106.602
      }
    } as never));

    expect(order).toEqual(["capture", "install", "cancel"]);
    expect(beginFlagTravelPresentation).toHaveBeenCalledWith(
      expect.objectContaining({
        lat: 35.101,
        lon: -106.602
      }),
      8,
      "stale-flag",
      "stale-request"
    );
    expect(cancelFlagTravelPresentation).toHaveBeenCalledWith(capture);
  });

  it("clears a matching pending Atlas Shrine arrival even when its epoch is stale", () => {
    const pendingTravelRequestIdRef = { current: "shrine-request" as string | null };
    const { result } = renderHook(() => useTravelFrameHandler({
      observeManorTravelResult: vi.fn(),
      installCommittedWorldViewEpoch: vi.fn(() => "stale-epoch-ignored"),
      pendingTravelRequestIdRef,
      completedTravelArrivalRequestIdsRef: { current: new Set() }
    } as never));

    act(() => result.current({
      type: "FLAG_VISITED",
      requestId: "shrine-request",
      flagId: "atlas-shrine",
      resourceVisionRevision: 8,
      player: {
        playerId: "player-1",
        relocationRevision: 6
      }
    } as never));

    expect(pendingTravelRequestIdRef.current).toBeNull();
  });

  it("snaps the player before starting one camera pan to the flag anchor", () => {
    const order: string[] = [];
    const centerCamera = vi.fn(() => {
      order.push("camera");
    });
    const player = {
      playerId: "player-1",
      relocationRevision: 7,
      movementRevision: 1,
      updatedAt: new Date().toISOString(),
      lat: 35.1014,
      lon: -106.6024,
      anchorLat: 35.101,
      anchorLon: -106.602
    };
    const { result } = renderHook(() => useTravelFrameHandler({
      observeManorTravelResult: vi.fn(),
      pendingTravelRequestIdRef: { current: "flag-request" },
      postArrivalTravelRequestIdRef: { current: null },
      postArrivalTravelRequestExpiresAtRef: { current: 0 },
      completedTravelArrivalRequestIdsRef: { current: new Set() },
      localMovementRequests: {
        resetUnlessBoundTo: vi.fn(() => null)
      },
      localPlayerRef: { current: null },
      playerRenderTimeline: {
        snapPlayer: vi.fn(() => {
          order.push("player-snap");
          return false;
        })
      },
      installCommittedWorldViewEpoch: vi.fn(() => "new-epoch-installed"),
      beginFlagTravelPresentation: vi.fn(() => ({ id: 1, newlyFrozen: true })),
      harvestTaskRef: { current: null },
      requestHarvestCancellation: vi.fn(),
      setPlayers: vi.fn(() => {
        order.push("player-state");
      }),
      setSelectedCityId: vi.fn(),
      setSelectedFlagId: vi.fn(),
      setFlagListOpen: vi.fn(),
      setWarning: vi.fn(),
      centerCamera
    } as never));

    act(() => result.current({
      type: "FLAG_VISITED",
      requestId: "flag-request",
      flagId: "destination-flag",
      resourceVisionRevision: 9,
      player
    } as never));

    expect(order).toEqual(["player-snap", "player-state", "camera"]);
    expect(centerCamera).toHaveBeenCalledWith(
      "visit-flag",
      { lat: player.anchorLat, lon: player.anchorLon },
      420,
      620,
      "arrival",
      "flag-request"
    );
  });

  it("settles a matching City structure arrival and preserves the movement binding", () => {
    const pendingTravelRequestIdRef = { current: "warehouse-request" as string | null };
    const localMovementRequests = {
      resetUnlessBoundTo: vi.fn(() => null),
      reset: vi.fn()
    };
    const setPlayers = vi.fn();
    const centerCamera = vi.fn();
    const beginFlagTravelPresentation = vi.fn(() => ({
      id: 1,
      newlyFrozen: true
    }));
    const harvestTaskRef = {
      current: {
        nodeId: "tree-before-city-travel",
        action: "primary",
        phase: "starting",
        sessionId: null,
        completesAtMs: null,
        startedAtMs: null,
        startRequestedAtMs: 1
      } as HarvestTask | null
    };
    const requestHarvestCancellation = vi.fn();
    const player = {
      playerId: "player-1",
      relocationRevision: 8,
      updatedAt: new Date().toISOString(),
      lat: 35.085,
      lon: -106.65,
      anchorLat: 35.085,
      anchorLon: -106.65,
      currentFlagId: null
    };
    const { result } = renderHook(() => useTravelFrameHandler({
      observeManorTravelResult: vi.fn(),
      pendingTravelRequestIdRef,
      postArrivalTravelRequestIdRef: { current: null },
      postArrivalTravelRequestExpiresAtRef: { current: 0 },
      completedTravelArrivalRequestIdsRef: { current: new Set() },
      localMovementRequests: localMovementRequests as never,
      localPlayerRef: { current: null },
      playerRenderTimeline: {
        snapPlayer: vi.fn(() => true),
        beginLocalAnticipation: vi.fn()
      } as never,
      installCommittedWorldViewEpoch: vi.fn(() => "new-epoch-installed"),
      beginFlagTravelPresentation,
      harvestTaskRef,
      requestHarvestCancellation,
      setPlayers,
      setSelectedFlagId: vi.fn(),
      centerCamera,
      setWarning: vi.fn()
    } as never));

    act(() => result.current({
      type: "CITY_VISITED",
      requestId: "warehouse-request",
      cityId: "city-1",
      player,
      resourceVisionRevision: 9,
      arrivalPresentation: "jump"
    } as never));

    expect(pendingTravelRequestIdRef.current).toBeNull();
    expect(localMovementRequests.resetUnlessBoundTo).toHaveBeenCalledWith(
      "warehouse-request"
    );
    expect(setPlayers).toHaveBeenCalledOnce();
    expect(requestHarvestCancellation).toHaveBeenCalledWith(false);
    expect(beginFlagTravelPresentation).toHaveBeenCalledWith(
      player,
      9,
      null,
      "warehouse-request"
    );
    expect(centerCamera).toHaveBeenCalledWith(
      "visit-flag",
      { lat: player.anchorLat, lon: player.anchorLon },
      420,
      620,
      "arrival",
      "warehouse-request"
    );
  });

  it("does not settle a newer pending request from an unrelated City arrival", () => {
    const pendingTravelRequestIdRef = { current: "newer-request" as string | null };
    const { result } = renderHook(() => useTravelFrameHandler({
      observeManorTravelResult: vi.fn(),
      pendingTravelRequestIdRef,
      postArrivalTravelRequestIdRef: { current: null },
      postArrivalTravelRequestExpiresAtRef: { current: 0 },
      completedTravelArrivalRequestIdsRef: { current: new Set() },
      localMovementRequests: { reset: vi.fn() } as never,
      localPlayerRef: { current: null },
      playerRenderTimeline: {
        snapPlayer: vi.fn(() => false)
      } as never,
      installCommittedWorldViewEpoch: vi.fn(() => "new-epoch-installed"),
      harvestTaskRef: { current: null },
      requestHarvestCancellation: vi.fn(),
      setPlayers: vi.fn(),
      setSelectedFlagId: vi.fn(),
      centerCamera: vi.fn(),
      setWarning: vi.fn()
    } as never));

    act(() => result.current({
      type: "CITY_VISITED",
      requestId: "older-request",
      cityId: "city-1",
      player: {
        playerId: "player-1",
        relocationRevision: 7,
        updatedAt: new Date().toISOString(),
        lat: 35.085,
        lon: -106.65
      }
    } as never));

    expect(pendingTravelRequestIdRef.current).toBe("newer-request");
  });
});
