// @vitest-environment jsdom
import {
  emptyInventoryTotals,
  MANOR_DOOR,
  MANOR_SMITH,
  type PlayerSnapshot
} from "@ash-atlas/shared";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ManorClient } from "../../client/domains/manorClient.js";
import { useManorFeature } from "./useManorFeature.js";
import { manorInteractionApproachPoint } from "./manorInteraction.js";

afterEach(cleanup);

describe("useManorFeature", () => {
  it("owns pending requests, authoritative manor state, and disconnect cleanup", () => {
    const commands = { buildManor: vi.fn(() => "build-1") } as unknown as ManorClient;
    const showActionError = vi.fn();
    const { result } = renderHook(() => useManorFeature({
      connectionStatus: "online",
      ownPlayerId: "player-1",
      getCommands: () => commands,
      showActionError,
      onEntered: vi.fn(),
      onExited: vi.fn(),
      onBeforeEnter: vi.fn()
    }));

    act(() => result.current.actions.requestBuild());
    act(() => result.current.handleServerMessage({
      type: "MANOR_BUILD_RESULT",
      requestId: "build-1",
      replayed: false,
      manor: {
        manorId: "00000000-0000-4000-8000-000000000001",
        ownerPlayerId: "player-1",
        ownerUsername: "Owner",
        regionCode: "test",
        lat: 1,
        lon: 2,
        builtAt: new Date(0).toISOString(),
        placementRevision: 1
      }
    }));

    expect(result.current.view.ownManor?.ownerPlayerId).toBe("player-1");
    expect(result.current.view.manors).toHaveLength(1);
    expect(showActionError).not.toHaveBeenCalled();

    act(() => result.current.onDisconnected());
    expect(result.current.view.pending.build).toBeNull();
  });

  it("surfaces a disconnected build attempt as an actionable error", () => {
    const showActionError = vi.fn();
    const { result } = renderHook(() => useManorFeature({
      connectionStatus: "online",
      ownPlayerId: "player-1",
      getCommands: () => null,
      showActionError,
      onEntered: vi.fn(),
      onExited: vi.fn(),
      onBeforeEnter: vi.fn()
    }));

    act(() => result.current.actions.requestBuild());

    expect(showActionError).toHaveBeenCalledWith(
      "Cannot build the manor while disconnected."
    );
  });

  it("forwards a matching manor jump error to World Map travel recovery", () => {
    const commands = {
      jumpToManor: vi.fn(() => "jump-1")
    } as unknown as ManorClient;
    const observeWorldMapTravelError = vi.fn();
    const { result } = renderHook(() => useManorFeature({
      connectionStatus: "online",
      ownPlayerId: "player-1",
      getCommands: () => commands,
      observeWorldMapTravelError,
      showActionError: vi.fn(),
      onEntered: vi.fn(),
      onExited: vi.fn(),
      onBeforeEnter: vi.fn()
    }));

    act(() => {
      result.current.actions.requestJump("manor-1");
    });
    const error = {
      type: "MANOR_ERROR" as const,
      requestId: "jump-1",
      code: "MANOR_JUMP_FAILED",
      message: "The manor is unavailable."
    };
    act(() => result.current.handleServerMessage(error));

    expect(observeWorldMapTravelError).toHaveBeenCalledWith(error);
    expect(result.current.view.pending.jump).toBeNull();
  });

  it("dismisses the selected manor prompt for an owner jump and does not reopen it", () => {
    const commands = {
      jumpToManor: vi.fn(() => "jump-1")
    } as unknown as ManorClient;
    const { result } = renderHook(() => useManorFeature({
      connectionStatus: "online",
      ownPlayerId: "player-1",
      getCommands: () => commands,
      showActionError: vi.fn(),
      onEntered: vi.fn(),
      onExited: vi.fn(),
      onBeforeEnter: vi.fn()
    }));

    act(() => {
      result.current.actions.setSelectedManorId("manor-1");
      result.current.actions.setPanelOpen(true);
    });
    act(() => {
      result.current.actions.requestJump("manor-1");
    });
    expect(result.current.view.panelOpen).toBe(false);
    expect(result.current.view.selectedManorId).toBeNull();
    act(() => result.current.handleTravelResult({
      type: "TRAVEL_RESULT",
      requestId: "jump-1",
      kind: "manor_jump",
      success: true,
      message: "Arrived at your manor."
    }));

    expect(result.current.view.panelOpen).toBe(false);
    expect(result.current.view.pending.jump).toBeNull();
  });

  it("accepts a bootstrap restoration without a pending entry request", () => {
    const onEntered = vi.fn();
    const { result } = renderHook(() => useManorFeature({
      connectionStatus: "online",
      ownPlayerId: "player-1",
      getCommands: () => null,
      showActionError: vi.fn(),
      onEntered,
      onExited: vi.fn(),
      onBeforeEnter: vi.fn()
    }));

    act(() => result.current.handleServerMessage({
      type: "MANOR_ENTERED",
      manorId: "manor-1",
      manorSessionId: "fresh-session",
      displayColor: "#38bdf8",
      appearance: {
        schemaVersion: 1,
        catalogRevision: 1,
        revision: 7,
        bodyVariantId: "default",
        poseId: "melee_idle",
        slots: {},
        activeHand: "melee"
      },
      position: {
        x: 500,
        y: 790,
        targetX: null,
        targetY: null,
        moving: false,
        revision: 0
      },
      movementSequence: 0,
      serverTime: performance.now(),
      accessSource: "OWNER",
      storage: {
        manorId: "manor-1",
        unlockedSlots: 60,
        stacks: [],
        equipment: [],
        backpacks: [],
        slots: [],
        overflowStacks: []
      }
    }));

    expect(result.current.view).toMatchObject({
      locationMode: "manor",
      session: {
        manorId: "manor-1",
        sessionId: "fresh-session",
        accessSource: "OWNER",
        appearance: { revision: 7, bodyVariantId: "default" }
      }
    });
    act(() => result.current.handleServerMessage({
      type: "MANOR_OCCUPANTS",
      manorId: "manor-1",
      serverTime: performance.now(),
      occupants: [{
        playerId: "guest-1",
        displayName: "Guest",
        displayColor: "#f59e0b",
        accessSource: "PARTY",
        spaceId: "manor_main_room",
        position: {
          x: 430, y: 790, targetX: null, targetY: null, moving: false, revision: 0
        },
        movementSequence: 0
      }]
    }));
    expect(result.current.view.occupants).toHaveLength(1);
    expect(onEntered).toHaveBeenCalledOnce();
  });

  it("tracks Manor movement through authoritative success, rejection, and reconnect cleanup", () => {
    const manorMoveTo = vi.fn()
      .mockReturnValueOnce("move-success")
      .mockReturnValueOnce("move-rejected")
      .mockReturnValueOnce("move-disconnect");
    const showActionError = vi.fn();
    const { result } = renderHook(() => useManorFeature({
      connectionStatus: "online",
      ownPlayerId: "player-1",
      getCommands: () => ({ manorMoveTo } as unknown as ManorClient),
      showActionError,
      onEntered: vi.fn(),
      onExited: vi.fn(),
      onBeforeEnter: vi.fn()
    }));

    act(() => result.current.handleServerMessage({
      type: "MANOR_ENTERED",
      manorId: "manor-1",
      manorSessionId: "session-1",
      displayColor: null,
      position: { x: 500, y: 790, targetX: null, targetY: null, moving: false, revision: 0 },
      movementSequence: 0,
      serverTime: 1_000,
      accessSource: "OWNER",
      storage: null
    }));

    expect(result.current.view.locationMode).toBe("manor");
    void act(() => result.current.actions.requestMove(560, 760));
    expect(manorMoveTo).toHaveBeenCalledWith("session-1", 560, 760);

    act(() => result.current.handleServerMessage({
      type: "MANOR_POSITION",
      manorSessionId: "session-1",
      position: { x: 560, y: 760, targetX: 560, targetY: 760, moving: true, revision: 1 },
      movementSequence: 1,
      serverTime: 1_100
    }));
    expect(result.current.view.pending.move).toBeNull();
    expect(showActionError).not.toHaveBeenCalled();

    void act(() => result.current.actions.requestMove(570, 750));
    act(() => result.current.handleServerMessage({
      type: "MANOR_ERROR",
      requestId: "move-rejected",
      code: "BLOCKED_TARGET",
      message: "That target is blocked by a manor fixture."
    }));
    expect(result.current.view.pending.move).toBeNull();
    expect(result.current.view.feedback).toBe("That target is blocked by a manor fixture.");
    expect(showActionError).toHaveBeenCalledWith("That target is blocked by a manor fixture.");

    act(() => result.current.handleServerMessage({
      type: "MANOR_ERROR",
      requestId: "stale-move",
      code: "BLOCKED_TARGET",
      message: "A stale movement error."
    }));
    expect(showActionError).toHaveBeenCalledTimes(1);

    void act(() => result.current.actions.requestMove(580, 740));
    act(() => result.current.onDisconnected());
    expect(result.current.view.pending.move).toBeNull();
  });

  it.each(["door"] as const)(
    "sends one %s action only after authoritative arrival",
    (kind) => {
      const commands = {
        manorMoveTo: vi.fn(() => "move-1"),
        exitManor: vi.fn(() => "exit-1")
      } as unknown as ManorClient;
      const { result } = renderHook(() => useManorFeature({
        connectionStatus: "online",
        ownPlayerId: "player-1",
        getCommands: () => commands,
        showActionError: vi.fn(),
        onEntered: vi.fn(),
        onExited: vi.fn(),
        onBeforeEnter: vi.fn()
      }));
      act(() => result.current.handleServerMessage({
        type: "MANOR_ENTERED",
        manorId: "manor-1",
        manorSessionId: "session-1",
        displayColor: null,
        position: {
          x: 500, y: 790, targetX: null, targetY: null, moving: false, revision: 0
        },
        movementSequence: 0,
        serverTime: 1_000,
        accessSource: "OWNER",
        storage: null
      }));
      const [x, y] = manorInteractionApproachPoint(
        kind,
        result.current.refs.movementTimeline.current.latestAuthorityPosition()
      );

      act(() => {
        result.current.actions.requestInteraction(kind);
        result.current.actions.requestInteraction(kind);
      });
      expect(commands.manorMoveTo).toHaveBeenCalledOnce();
      expect(commands.exitManor).not.toHaveBeenCalled();

      act(() => result.current.handleServerMessage({
        type: "MANOR_POSITION",
        manorSessionId: "session-1",
        position: { x, y, targetX: null, targetY: null, moving: false, revision: 1 },
        movementSequence: 1,
        serverTime: 1_100
      }));
      expect(commands.exitManor).toHaveBeenCalledOnce();
      expect(result.current.view.pending.exit).toBe("exit-1");
      expect(result.current.view.interactionIntent).toMatchObject({
        kind,
        phase: "requesting"
      });
    }
  );

  it.each([
    ["smith", "OWNER"], ["smith", "PARTY"], ["smith", "TRAVEL_INVITE"],
    ["jewel", "OWNER"], ["jewel", "PARTY"], ["jewel", "TRAVEL_INVITE"]
  ] as const)(
    "opens the %s for every occupant only after authoritative arrival",
    (kind, accessSource) => {
      const commands = {
        manorMoveTo: vi.fn(() => "move-1"),
        exitManor: vi.fn()
      } as unknown as ManorClient;
      const { result } = renderHook(() => useManorFeature({
        connectionStatus: "online",
        ownPlayerId: "player-1",
        getCommands: () => commands,
        showActionError: vi.fn(),
        onEntered: vi.fn(),
        onExited: vi.fn(),
        onBeforeEnter: vi.fn()
      }));
      act(() => result.current.handleServerMessage({
        type: "MANOR_ENTERED",
        manorId: "manor-1",
        manorSessionId: "session-1",
        displayColor: null,
        position: {
          x: 500, y: 790, targetX: null, targetY: null, moving: false, revision: 0
        },
        movementSequence: 0,
        serverTime: 1_000,
        accessSource,
        storage: null
      }));
      const [x, y] = manorInteractionApproachPoint(
        kind,
        result.current.refs.movementTimeline.current.latestAuthorityPosition()
      );

      act(() => { void result.current.actions.requestInteraction(kind); });
      expect(commands.manorMoveTo).toHaveBeenCalledOnce();
      expect(kind === "smith" ? result.current.view.smithOpen : result.current.view.jewelOpen).toBe(false);

      act(() => result.current.handleServerMessage({
        type: "MANOR_POSITION",
        manorSessionId: "session-1",
        position: { x, y, targetX: null, targetY: null, moving: false, revision: 1 },
        movementSequence: 1,
        serverTime: 1_100
      }));
      expect(kind === "smith" ? result.current.view.smithOpen : result.current.view.jewelOpen).toBe(true);
      expect(result.current.view.interactionIntent).toBeNull();
      expect(commands.exitManor).not.toHaveBeenCalled();
    }
  );

  it("cancels an approach on manual movement and never completes the stale intent", () => {
    const commands = {
      manorMoveTo: vi.fn(() => "move")
    } as unknown as ManorClient;
    const { result } = renderHook(() => useManorFeature({
      connectionStatus: "online",
      ownPlayerId: "player-1",
      getCommands: () => commands,
      showActionError: vi.fn(),
      onEntered: vi.fn(),
      onExited: vi.fn(),
      onBeforeEnter: vi.fn()
    }));
    act(() => result.current.handleServerMessage({
      type: "MANOR_ENTERED",
      manorId: "manor-1",
      manorSessionId: "session-1",
      displayColor: null,
      position: { x: 500, y: 790, targetX: null, targetY: null, moving: false, revision: 0 },
      movementSequence: 0,
      serverTime: 1_000,
      accessSource: "OWNER",
      storage: null
    }));
    act(() => void result.current.actions.requestInteraction("smith"));
    void act(() => result.current.actions.requestMove(600, 600));
    expect(result.current.view.interactionIntent).toBeNull();
    act(() => result.current.handleServerMessage({
      type: "MANOR_POSITION",
      manorSessionId: "session-1",
      position: { x: MANOR_SMITH.x, y: MANOR_SMITH.y, targetX: null, targetY: null, moving: false, revision: 2 },
      movementSequence: 2,
      serverTime: 1_200
    }));
    expect(result.current.view.smithOpen).toBe(false);
  });

  it("makes one corrective approach after an authoritative range rejection", () => {
    const manorMoveTo = vi.fn<
      (sessionId: string, x: number, y: number) => string
    >(() => "move-1");
    const exitManor = vi.fn()
      .mockReturnValueOnce("exit-1")
      .mockReturnValueOnce("exit-2");
    const commands = {
      manorMoveTo,
      exitManor
    } as unknown as ManorClient;
    const { result } = renderHook(() => useManorFeature({
      connectionStatus: "online",
      ownPlayerId: "player-1",
      getCommands: () => commands,
      showActionError: vi.fn(),
      onEntered: vi.fn(),
      onExited: vi.fn(),
      onBeforeEnter: vi.fn()
    }));
    act(() => result.current.handleServerMessage({
      type: "MANOR_ENTERED",
      manorId: "manor-1",
      manorSessionId: "session-1",
      displayColor: null,
      position: { x: MANOR_DOOR.x, y: MANOR_DOOR.y, targetX: null, targetY: null, moving: false, revision: 0 },
      movementSequence: 0,
      serverTime: 1_000,
      accessSource: "OWNER",
      storage: null
    }));
    act(() => void result.current.actions.requestInteraction("door"));
    expect(exitManor).toHaveBeenCalledTimes(1);

    act(() => result.current.handleServerMessage({
      type: "MANOR_ERROR",
      requestId: "exit-1",
      code: "DOOR_OUT_OF_RANGE",
      message: "Move closer to the door first."
    }));
    expect(manorMoveTo).toHaveBeenCalledTimes(1);
    expect(exitManor).toHaveBeenCalledTimes(1);
    const [, x, y] = manorMoveTo.mock.calls[0]!;

    act(() => result.current.handleServerMessage({
      type: "MANOR_POSITION",
      manorSessionId: "session-1",
      position: { x, y, targetX: null, targetY: null, moving: false, revision: 1 },
      movementSequence: 1,
      serverTime: 1_100
    }));
    expect(exitManor).toHaveBeenCalledTimes(2);

    act(() => result.current.handleServerMessage({
      type: "MANOR_ERROR",
      requestId: "exit-2",
      code: "DOOR_OUT_OF_RANGE",
      message: "Move closer to the door first."
    }));
    expect(manorMoveTo).toHaveBeenCalledTimes(1);
    expect(result.current.view.interactionIntent).toBeNull();
  });

  it("replaces a station approach with a door intent and ignores the older arrival", () => {
    const commands = {
      manorMoveTo: vi.fn(() => "move"),
      exitManor: vi.fn(() => "exit")
    } as unknown as ManorClient;
    const { result } = renderHook(() => useManorFeature({
      connectionStatus: "online",
      ownPlayerId: "player-1",
      getCommands: () => commands,
      showActionError: vi.fn(),
      onEntered: vi.fn(),
      onExited: vi.fn(),
      onBeforeEnter: vi.fn()
    }));
    act(() => result.current.handleServerMessage({
      type: "MANOR_ENTERED",
      manorId: "manor-1",
      manorSessionId: "session-1",
      displayColor: null,
      position: { x: 500, y: 790, targetX: null, targetY: null, moving: false, revision: 0 },
      movementSequence: 0,
      serverTime: 1_000,
      accessSource: "OWNER",
      storage: null
    }));
    act(() => {
      void result.current.actions.requestInteraction("smith");
      void result.current.actions.requestInteraction("door");
    });
    expect(commands.manorMoveTo).toHaveBeenCalledTimes(2);
    expect(result.current.view.interactionIntent).toMatchObject({ kind: "door", phase: "moving" });

    act(() => result.current.handleServerMessage({
      type: "MANOR_POSITION",
      manorSessionId: "session-1",
      position: { x: MANOR_SMITH.x, y: MANOR_SMITH.y, targetX: null, targetY: null, moving: false, revision: 1 },
      movementSequence: 1,
      serverTime: 1_100
    }));
    expect(result.current.view.smithOpen).toBe(false);
    expect(commands.exitManor).not.toHaveBeenCalled();

    act(() => result.current.actions.cancelInteraction());
    act(() => result.current.handleServerMessage({
      type: "MANOR_POSITION",
      manorSessionId: "session-1",
      position: { x: 760, y: 830, targetX: null, targetY: null, moving: false, revision: 2 },
      movementSequence: 2,
      serverTime: 1_200
    }));
    expect(commands.exitManor).not.toHaveBeenCalled();
  });
});

function playerSnapshot(): PlayerSnapshot {
  return {
    playerId: "player-1",
    username: "Owner",
    displayColor: null,
    regionCode: "test",
    zoneId: "world:test",
    lat: 1,
    lon: 2,
    anchorLat: 1,
    anchorLon: 2,
    moveLeashRadiusM: 900,
    movementRevision: 1,
    targetLat: null,
    targetLon: null,
    moving: false,
    online: true,
    updatedAt: new Date(0).toISOString()
  };
}
