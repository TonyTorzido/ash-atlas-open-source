// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useMobileGameMenuNavigation } from "./useMobileGameMenuNavigation.js";
import { requestMobileMenuReturnToGame } from "./mobileGameMenu.js";
import {
  closeAndNavigateFromPlayerActions,
  PHONE_PLAYER_ACTIONS_HISTORY_KEY
} from "./playerActionsNavigation.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

describe("mobile Game Menu navigation", () => {
  it("follows gameplay -> root -> destination -> child without category history", () => {
    const { result } = renderHook(() => useMobileGameMenuNavigation(true));
    act(() => result.current.openMenu());
    act(() => result.current.openDestination("character"));
    act(() => result.current.openChild({ destination: "character", screen: "slot", id: "chest" }));

    expect(result.current.category).toBeNull();
    expect(window.history.state).toMatchObject({
      ashAtlasMobileMenuView: "character",
      ashAtlasMobileMenuDepth: 3
    });
    expect(window.history.state).not.toHaveProperty("ashAtlasMobileMenuCategory");

    act(() => {
      window.dispatchEvent(new PopStateEvent("popstate", { state: {
        ashAtlasMobileMenuView: "menu",
        ashAtlasMobileMenuDepth: 1
      } }));
    });
    expect(result.current.view).toBe("menu");
    expect(result.current.category).toBeNull();

    act(() => {
      window.dispatchEvent(new PopStateEvent("popstate", { state: {
        ashAtlasMobileMenuView: "menu",
        ashAtlasMobileMenuDepth: 1
      } }));
    });
    expect(result.current.category).toBeNull();
  });

  it("opens a HUD shortcut straight over gameplay and closes back to gameplay in one step", () => {
    const go = vi.spyOn(window.history, "go").mockImplementation(() => undefined);
    const { result } = renderHook(() => useMobileGameMenuNavigation(true));
    act(() => result.current.openShortcut("equipment"));

    expect(result.current.view).toBe("equipment");
    expect(result.current.shortcut).toBe(true);
    expect(window.history.state).toMatchObject({
      ashAtlasMobileMenuView: "equipment",
      ashAtlasMobileMenuDepth: 1,
      ashAtlasMobileMenuShortcut: true
    });

    act(() => result.current.openChild({ destination: "equipment", screen: "item", id: "sword" } as never));
    expect(window.history.state).toMatchObject({ ashAtlasMobileMenuDepth: 2, ashAtlasMobileMenuShortcut: true });

    act(() => result.current.close());
    expect(go).toHaveBeenCalledWith(-2);
    expect(result.current.view).toBe("gameplay");
    expect(result.current.shortcut).toBe(false);
  });

  it("keeps the Game Menu path when a shortcut is requested from inside the menu", () => {
    const { result } = renderHook(() => useMobileGameMenuNavigation(true));
    act(() => result.current.openMenu());
    act(() => result.current.openShortcut("equipment"));

    expect(result.current.shortcut).toBe(false);
    expect(window.history.state).toMatchObject({ ashAtlasMobileMenuView: "equipment", ashAtlasMobileMenuDepth: 2 });
    expect(window.history.state).not.toHaveProperty("ashAtlasMobileMenuShortcut");
  });

  it("opens a direct World Map at depth two and restores menu then gameplay", () => {
    const { result } = renderHook(() => useMobileGameMenuNavigation(true));
    act(() => {
      result.current.openMenu();
      result.current.openDestination("world-map");
    });
    expect(result.current.view).toBe("world-map");
    expect(window.history.state).toMatchObject({
      ashAtlasMobileMenuView: "world-map",
      ashAtlasMobileMenuDepth: 2
    });

    act(() => {
      window.dispatchEvent(new PopStateEvent("popstate", {
        state: { ashAtlasMobileMenuView: "menu", ashAtlasMobileMenuDepth: 1 }
      }));
    });
    expect(result.current.view).toBe("menu");
    act(() => {
      window.dispatchEvent(new PopStateEvent("popstate", { state: null }));
    });
    expect(result.current.view).toBe("gameplay");
  });

  it("paints Menu for one frame before a gameplay shortcut enters Messages", () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    }));
    const { result } = renderHook(() => useMobileGameMenuNavigation(true));
    act(() => result.current.openDestination("messages"));
    expect(result.current.view).toBe("menu");
    expect(window.history.state).toMatchObject({
      ashAtlasMobileMenuView: "menu",
      ashAtlasMobileMenuDepth: 1
    });

    act(() => frames.shift()?.(0));
    expect(result.current.view).toBe("menu");
    act(() => frames.shift()?.(16));
    expect(result.current.view).toBe("menu");
    expect(window.history.state).toMatchObject({
      ashAtlasMobileMenuView: "messages",
      ashAtlasMobileMenuDepth: 2
    });
    act(() => frames.shift()?.(32));
    expect(result.current.view).toBe("messages");
    expect(window.history.state).toMatchObject({
      ashAtlasMobileMenuView: "messages",
      ashAtlasMobileMenuDepth: 2
    });
  });

  it("keeps a queued gameplay shortcut direct while retired category opens are ignored", () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    }));
    const { result } = renderHook(() => useMobileGameMenuNavigation(true));

    act(() => result.current.openDestination("messages"));
    expect(result.current.view).toBe("menu");
    expect(result.current.category).toBeNull();

    act(() => result.current.openCategory("adventurer"));
    expect(result.current.view).toBe("menu");
    expect(result.current.category).toBeNull();

    act(() => flushFrames(frames));
    expect(result.current.view).toBe("messages");
    expect(result.current.category).toBeNull();
    expect(window.history.state).toMatchObject({
      ashAtlasMobileMenuView: "messages",
      ashAtlasMobileMenuDepth: 2
    });
    expect(window.history.state).not.toHaveProperty("ashAtlasMobileMenuCategory");
  });

  it("follows gameplay -> menu -> Character -> Chest and restores each parent", () => {
    const { result } = renderHook(() => useMobileGameMenuNavigation(true));
    act(() => result.current.openMenu());
    act(() => result.current.openDestination("character"));
    act(() => result.current.openChild({ destination: "character", screen: "slot", id: "chest" }));

    expect(result.current.view).toBe("character");
    expect(result.current.child).toEqual({ destination: "character", screen: "slot", id: "chest" });
    expect(window.history.state).toMatchObject({ ashAtlasMobileMenuDepth: 3 });

    act(() => {
      window.dispatchEvent(new PopStateEvent("popstate", { state: {
        ashAtlasMobileMenuView: "character", ashAtlasMobileMenuDepth: 2
      } }));
    });
    expect(result.current.view).toBe("character");
    expect(result.current.child).toBeNull();

    act(() => {
      window.dispatchEvent(new PopStateEvent("popstate", { state: {
        ashAtlasMobileMenuView: "menu", ashAtlasMobileMenuDepth: 1
      } }));
    });
    expect(result.current.view).toBe("menu");

    act(() => {
      window.dispatchEvent(new PopStateEvent("popstate", { state: null }));
    });
    expect(result.current.view).toBe("gameplay");
  });

  it("returns directly from a child and reopens at the Game Menu root", () => {
    const go = vi.spyOn(window.history, "go").mockImplementation(() => undefined);
    const { result } = renderHook(() => useMobileGameMenuNavigation(true));
    act(() => result.current.openMenu());
    act(() => result.current.openDestination("character"));
    act(() => result.current.openChild({ destination: "character", screen: "slot", id: "chest" }));
    act(() => requestMobileMenuReturnToGame());

    expect(go).toHaveBeenCalledWith(-3);
    expect(result.current.view).toBe("gameplay");
    expect(result.current.child).toBeNull();
    act(() => result.current.openMenu());
    expect(result.current.view).toBe("menu");
    expect(result.current.child).toBeNull();
    expect(window.history.state).not.toHaveProperty("ashAtlasMobileMenuChild");
  });

  it("falls back from invalid child state to its valid destination", () => {
    const { result } = renderHook(() => useMobileGameMenuNavigation(true));
    act(() => {
      window.dispatchEvent(new PopStateEvent("popstate", { state: {
        ashAtlasMobileMenuView: "character",
        ashAtlasMobileMenuChild: { destination: "character", screen: "slot", id: "cape" },
        ashAtlasMobileMenuDepth: 3
      } }));
    });
    expect(result.current.view).toBe("character");
    expect(result.current.child).toBeNull();
  });

  it("gives a Messages peer its own history entry and restores it on forward navigation", () => {
    const peerId = "00000000-0000-4000-8000-000000000002";
    const back = vi.spyOn(window.history, "back").mockImplementation(() => undefined);
    const { result } = renderHook(() => useMobileGameMenuNavigation(true));
    act(() => result.current.openMenu());
    act(() => result.current.openDestination("messages"));
    act(() => result.current.openMessagePeer(peerId));

    expect(result.current.view).toBe("messages");
    expect(result.current.messagePeerId).toBe(peerId);
    expect(window.history.state).toMatchObject({
      ashAtlasMobileMenuView: "messages",
      ashAtlasMobileMessagePeerId: peerId,
      ashAtlasMobileMenuChild: { destination: "messages", screen: "peer", id: peerId }
    });

    act(() => result.current.backMessageDetail());
    expect(back).toHaveBeenCalledTimes(1);
    act(() => {
      window.dispatchEvent(new PopStateEvent("popstate", {
        state: { ashAtlasMobileMenuView: "messages" }
      }));
    });
    expect(result.current.messagePeerId).toBeNull();

    act(() => {
      window.dispatchEvent(new PopStateEvent("popstate", {
        state: {
          ashAtlasMobileMenuView: "messages",
          ashAtlasMobileMessagePeerId: "not-a-player-id"
        }
      }));
    });
    expect(result.current.messagePeerId).toBeNull();

    act(() => {
      window.dispatchEvent(new PopStateEvent("popstate", {
        state: {
          ashAtlasMobileMenuView: "messages",
          ashAtlasMobileMessagePeerId: peerId
        }
      }));
    });
    expect(result.current.messagePeerId).toBe(peerId);
  });

  it("gives a Messages notification its own Back and browser-history level", () => {
    const back = vi.spyOn(window.history, "back").mockImplementation(() => undefined);
    const { result } = renderHook(() => useMobileGameMenuNavigation(true));
    act(() => result.current.openMenu());
    act(() => result.current.openDestination("messages"));
    act(() => result.current.openMessageNotification("travel:declined"));

    expect(result.current.view).toBe("messages");
    expect(result.current.messagePeerId).toBeNull();
    expect(result.current.messageNotificationKey).toBe("travel:declined");
    expect(window.history.state).toMatchObject({
      ashAtlasMobileMenuView: "messages",
      ashAtlasMobileMenuDepth: 3,
      ashAtlasMobileMenuChild: {
        destination: "messages",
        screen: "notification",
        id: "travel:declined"
      }
    });

    act(() => result.current.backMessageDetail());
    act(() => result.current.backMessageDetail());
    expect(back).toHaveBeenCalledTimes(1);
    act(() => {
      window.dispatchEvent(new PopStateEvent("popstate", {
        state: { ashAtlasMobileMenuView: "messages", ashAtlasMobileMenuDepth: 2 }
      }));
    });
    expect(result.current.view).toBe("messages");
    expect(result.current.child).toBeNull();
    expect(result.current.messageNotificationKey).toBeNull();
  });

  it("opens Messages from another destination without dropping back to gameplay", () => {
    const { result } = renderHook(() => useMobileGameMenuNavigation(true));
    act(() => result.current.openMenu());
    act(() => result.current.openDestination("profile"));
    act(() => result.current.openDestination("messages"));

    expect(result.current.view).toBe("messages");
    expect(window.history.state).toMatchObject({
      ashAtlasMobileMenuView: "messages",
      ashAtlasMobileMenuDepth: 3
    });
  });

  it("replaces Realm app tabs without category history", () => {
    const { result } = renderHook(() => useMobileGameMenuNavigation(true));
    act(() => result.current.openMenu());
    act(() => result.current.openDestination("world-map"));
    act(() => result.current.replaceDestination("city"));
    act(() => result.current.replaceDestination("kingdom"));

    expect(result.current.view).toBe("kingdom");
    expect(result.current.category).toBeNull();
    expect(window.history.state).toMatchObject({
      ashAtlasMobileMenuView: "kingdom",
      ashAtlasMobileMenuDepth: 2
    });
    expect(window.history.state).not.toHaveProperty("ashAtlasMobileMenuCategory");
  });

  it("closes phone player actions and opens the selected player's Profile", () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    }));
    const targetPlayerId = "00000000-0000-4000-8000-000000000002";
    window.history.replaceState({
      [PHONE_PLAYER_ACTIONS_HISTORY_KEY]: targetPlayerId
    }, "");
    let sheetOpen = true;
    let selectedProfilePlayerId: string | null = null;
    const back = vi.spyOn(window.history, "back");
    const { result } = renderHook(() => useMobileGameMenuNavigation(true));

    act(() => closeAndNavigateFromPlayerActions(
      () => { sheetOpen = false; },
      () => {
        selectedProfilePlayerId = targetPlayerId;
        result.current.openDestination("profile");
      }
    ));
    act(() => flushFrames(frames));

    expect(sheetOpen).toBe(false);
    expect(result.current.view).toBe("profile");
    expect(selectedProfilePlayerId).toBe(targetPlayerId);
    expect(window.history.state).not.toHaveProperty(PHONE_PLAYER_ACTIONS_HISTORY_KEY);
    expect(back).not.toHaveBeenCalled();
  });

  it("closes phone player actions and opens the selected player's Messages conversation", () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    }));
    const targetPlayerId = "00000000-0000-4000-8000-000000000002";
    window.history.replaceState({
      [PHONE_PLAYER_ACTIONS_HISTORY_KEY]: targetPlayerId
    }, "");
    let sheetOpen = true;
    let selectedMessagePeerId: string | null = null;
    const { result } = renderHook(() => useMobileGameMenuNavigation(true));

    act(() => closeAndNavigateFromPlayerActions(
      () => { sheetOpen = false; },
      () => {
        selectedMessagePeerId = targetPlayerId;
        result.current.openDestination("messages");
      }
    ));
    act(() => flushFrames(frames));
    act(() => result.current.openMessagePeer(targetPlayerId));

    expect(sheetOpen).toBe(false);
    expect(result.current.view).toBe("messages");
    expect(selectedMessagePeerId).toBe(targetPlayerId);
    expect(result.current.messagePeerId).toBe(targetPlayerId);
    expect(window.history.state).not.toHaveProperty(PHONE_PLAYER_ACTIONS_HISTORY_KEY);
  });

  it("does not create menu history while the phone shell is disabled", () => {
    const pushState = vi.spyOn(window.history, "pushState");
    const { result } = renderHook(() => useMobileGameMenuNavigation(false));
    act(() => result.current.openMenu());
    expect(result.current.view).toBe("gameplay");
    expect(pushState).not.toHaveBeenCalled();
  });

  it("closes a destination directly back to gameplay for actions that leave the menu", () => {
    const go = vi.spyOn(window.history, "go").mockImplementation(() => undefined);
    const onSettled = vi.fn();
    const { result } = renderHook(() => useMobileGameMenuNavigation(true));
    act(() => result.current.openMenu());
    act(() => result.current.openDestination("build"));
    act(() => result.current.close(onSettled));
    expect(result.current.view).toBe("gameplay");
    expect(go).toHaveBeenCalledWith(-2);
    expect(onSettled).not.toHaveBeenCalled();

    act(() => {
      window.dispatchEvent(new PopStateEvent("popstate", { state: null }));
    });
    expect(onSettled).toHaveBeenCalledOnce();
  });

  it("clears a stale owned marker on a fresh shell mount", () => {
    window.history.replaceState({
      ashAtlasMobileMenuView: "messages",
      ashAtlasMobileMenuDepth: 3,
      ashAtlasMobileMenuChild: { destination: "messages", screen: "peer", id: "00000000-0000-4000-8000-000000000002" },
      ashAtlasMobileMessagePeerId: "00000000-0000-4000-8000-000000000002",
      unrelated: "kept"
    }, "");
    const { result } = renderHook(() => useMobileGameMenuNavigation(true));
    expect(result.current.view).toBe("gameplay");
    expect(window.history.state).toEqual({ unrelated: "kept" });
  });

  it("preserves unrelated history state on every owned entry", () => {
    window.history.replaceState({ unrelated: "kept" }, "");
    const { result } = renderHook(() => useMobileGameMenuNavigation(true));
    act(() => result.current.openMenu());
    act(() => result.current.openDestination("equipment"));
    act(() => result.current.openChild({ destination: "equipment", screen: "detail", id: "item-1" }));
    expect(window.history.state).toMatchObject({
      unrelated: "kept",
      ashAtlasMobileMenuView: "equipment",
      ashAtlasMobileMenuDepth: 3
    });
  });
});

function flushFrames(frames: FrameRequestCallback[]): void {
  let timestamp = 0;
  while (frames.length > 0) {
    frames.shift()?.(timestamp);
    timestamp += 16;
  }
}
