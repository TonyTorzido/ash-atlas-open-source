import { useCallback, useEffect, useRef, useState } from "react";

import {
  MOBILE_MENU_RETURN_EVENT,
  mobileMenuHistoryFromState,
  withoutMobileMenuHistoryState,
  type MobileMenuChild,
  type MobileMenuCategoryId,
  type MobileMenuDestinationId,
  type MobileMenuView
} from "./mobileGameMenu.js";

export type MobileGameMenuNavigation = {
  view: MobileMenuView;
  category: MobileMenuCategoryId | null;
  child: MobileMenuChild | null;
  messagePeerId: string | null;
  messageNotificationKey: string | null;
  /** The open destination came from a HUD shortcut, so its only exit is Return to Game. */
  shortcut: boolean;
  openMenu(): void;
  openCategory(id: MobileMenuCategoryId): void;
  openDestination(id: MobileMenuDestinationId): void;
  /** Opens a destination directly from gameplay, without the Game Menu underneath. */
  openShortcut(id: MobileMenuDestinationId): void;
  replaceDestination(id: MobileMenuDestinationId): void;
  openChild(child: MobileMenuChild): void;
  openMessagePeer(peerId: string): void;
  openMessageNotification(entryKey: string): void;
  backMessageDetail(): void;
  back(): void;
  close(onSettled?: () => void): void;
};

export function useMobileGameMenuNavigation(
  enabled: boolean,
  initialView: MobileMenuView = "gameplay"
): MobileGameMenuNavigation {
  const [view, setView] = useState<MobileMenuView>(initialView);
  const [category, setCategory] = useState<MobileMenuCategoryId | null>(null);
  const [child, setChild] = useState<MobileMenuChild | null>(null);
  const [messagePeerId, setMessagePeerId] = useState<string | null>(null);
  const [shortcut, setShortcutState] = useState(false);
  const shortcutRef = useRef(false);
  const setShortcut = (next: boolean): void => {
    shortcutRef.current = next;
    setShortcutState(next);
  };
  const viewRef = useRef(view);
  const categoryRef = useRef(category);
  const childRef = useRef(child);
  const ownedDepthRef = useRef(0);
  const destinationTransitionRef = useRef(0);
  const messageBackPendingRef = useRef(false);
  const closeSettledRef = useRef<(() => void) | null>(null);
  viewRef.current = view;
  categoryRef.current = category;
  childRef.current = child;

  const close = useCallback((onSettled?: () => void): void => {
    if (!enabled) return;
    if (viewRef.current === "gameplay") {
      onSettled?.();
      return;
    }
    destinationTransitionRef.current += 1;
    messageBackPendingRef.current = false;
    closeSettledRef.current = onSettled ?? null;
    const depth = ownedDepthRef.current || mobileMenuHistoryFromState(window.history.state).ownedDepth;
    if (depth > 0) {
      window.history.go(-depth);
    } else {
      const settled = closeSettledRef.current;
      closeSettledRef.current = null;
      settled?.();
    }
    viewRef.current = "gameplay";
    categoryRef.current = null;
    childRef.current = null;
    ownedDepthRef.current = 0;
    setView("gameplay");
    setCategory(null);
    setChild(null);
    setMessagePeerId(null);
    setShortcut(false);
  }, [enabled]);

  useEffect(() => {
    if (!enabled) {
      destinationTransitionRef.current += 1;
      messageBackPendingRef.current = false;
      closeSettledRef.current = null;
      setView("gameplay");
      setCategory(null);
      setChild(null);
      setMessagePeerId(null);
      ownedDepthRef.current = 0;
      return;
    }
    const cleanState = withoutMobileMenuHistoryState(window.history.state);
    if (Object.keys(cleanState).length !== Object.keys(window.history.state ?? {}).length) {
      window.history.replaceState(cleanState, "");
    }
    const onPopState = (event: PopStateEvent): void => {
      destinationTransitionRef.current += 1;
      messageBackPendingRef.current = false;
      const next = mobileMenuHistoryFromState(event.state);
      viewRef.current = next.view;
      categoryRef.current = next.category;
      childRef.current = next.child;
      ownedDepthRef.current = next.ownedDepth;
      setView(next.view);
      setCategory(next.category);
      setChild(next.child);
      setMessagePeerId(messagePeerIdFromChild(next.child));
      setShortcut(next.shortcut);
      if (next.view === "gameplay") {
        const settled = closeSettledRef.current;
        closeSettledRef.current = null;
        settled?.();
      }
    };
    const onReturnToGame = (): void => close();
    window.addEventListener("popstate", onPopState);
    window.addEventListener(MOBILE_MENU_RETURN_EVENT, onReturnToGame);
    return () => {
      destinationTransitionRef.current += 1;
      closeSettledRef.current = null;
      window.removeEventListener("popstate", onPopState);
      window.removeEventListener(MOBILE_MENU_RETURN_EVENT, onReturnToGame);
    };
  }, [close, enabled]);

  const pushViewHistory = useCallback((
    next: Exclude<MobileMenuView, "gameplay">,
    depth: number,
    nextCategory: MobileMenuCategoryId | null = null
  ): void => {
    const nextState = {
      ...window.history.state,
      ashAtlasMobileMenuView: next,
      ashAtlasMobileMenuDepth: depth
    };
    if (nextCategory) nextState.ashAtlasMobileMenuCategory = nextCategory;
    else delete nextState.ashAtlasMobileMenuCategory;
    delete nextState.ashAtlasMobileMenuChild;
    delete nextState.ashAtlasMobileMessagePeerId;
    delete nextState.ashAtlasMobileMenuShortcut;
    window.history.pushState(nextState, "");
  }, []);

  const renderView = useCallback((
    next: Exclude<MobileMenuView, "gameplay">,
    depth: number,
    nextCategory: MobileMenuCategoryId | null = null
  ): void => {
    viewRef.current = next;
    categoryRef.current = nextCategory;
    childRef.current = null;
    messageBackPendingRef.current = false;
    ownedDepthRef.current = depth;
    setView(next);
    setCategory(nextCategory);
    setChild(null);
    setMessagePeerId(null);
    setShortcut(false);
  }, []);

  const pushView = useCallback((
    next: Exclude<MobileMenuView, "gameplay">,
    depth: number,
    nextCategory: MobileMenuCategoryId | null = null
  ): void => {
    pushViewHistory(next, depth, nextCategory);
    renderView(next, depth, nextCategory);
  }, [pushViewHistory, renderView]);

  const openMenu = useCallback((): void => {
    if (!enabled || viewRef.current !== "gameplay") return;
    pushView("menu", 1);
  }, [enabled, pushView]);

  const openCategory = useCallback((): void => {
    // Category directories were retired from the player flow. Keep this
    // callback as a compatibility surface for older callers without adding a
    // second menu history entry.
  }, []);

  const openDestination = useCallback((id: MobileMenuDestinationId): void => {
    if (!enabled) return;
    const transition = ++destinationTransitionRef.current;
    if (viewRef.current === "menu") {
      pushView(id, categoryRef.current ? 3 : 2, null);
      return;
    }
    if (viewRef.current !== "gameplay") {
      if (viewRef.current === id && childRef.current === null) return;
      pushView(id, Math.max(2, ownedDepthRef.current + 1), null);
      return;
    }
    if (document.documentElement.dataset.presentation === "desktop") {
      // Desktop windows would paint the Game Menu root for the frames between the two
      // pushes: record both history entries now and render the target directly. Back
      // still lands on the Game Menu entry underneath.
      pushViewHistory("menu", 1);
      pushViewHistory(id, 2);
      renderView(id, 2);
      return;
    }
    pushView("menu", 1);
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        if (
          destinationTransitionRef.current !== transition ||
          viewRef.current !== "menu"
        ) return;
        pushViewHistory(id, 2);
        window.requestAnimationFrame(() => {
          if (
            destinationTransitionRef.current !== transition ||
            viewRef.current !== "menu"
          ) return;
          renderView(id, 2);
        });
      });
    });
  }, [enabled, pushView, pushViewHistory, renderView]);

  const openShortcut = useCallback((id: MobileMenuDestinationId): void => {
    if (!enabled) return;
    if (viewRef.current !== "gameplay") {
      openDestination(id);
      return;
    }
    destinationTransitionRef.current += 1;
    const nextState: Record<string, unknown> = {
      ...window.history.state,
      ashAtlasMobileMenuView: id,
      ashAtlasMobileMenuDepth: 1,
      ashAtlasMobileMenuShortcut: true
    };
    delete nextState.ashAtlasMobileMenuCategory;
    delete nextState.ashAtlasMobileMenuChild;
    delete nextState.ashAtlasMobileMessagePeerId;
    window.history.pushState(nextState, "");
    renderView(id, 1);
    setShortcut(true);
  }, [enabled, openDestination, renderView]);

  const replaceDestination = useCallback((id: MobileMenuDestinationId): void => {
    if (!enabled || viewRef.current === "gameplay" || viewRef.current === "menu") return;
    destinationTransitionRef.current += 1;
    const depth = Math.max(2, ownedDepthRef.current || 2);
    const nextState = {
      ...window.history.state,
      ashAtlasMobileMenuView: id,
      ashAtlasMobileMenuDepth: depth
    };
    delete nextState.ashAtlasMobileMenuCategory;
    delete nextState.ashAtlasMobileMenuChild;
    delete nextState.ashAtlasMobileMessagePeerId;
    window.history.replaceState(nextState, "");
    renderView(id, depth, null);
  }, [enabled, renderView]);

  const openChild = useCallback((nextChild: MobileMenuChild): void => {
    if (
      !enabled ||
      viewRef.current !== nextChild.destination ||
      childRef.current !== null
    ) return;
    // A shortcut destination sits one step above gameplay, so its detail sits at two.
    const depth = Math.max(shortcutRef.current ? 2 : 3, ownedDepthRef.current + 1);
    const nextState: Record<string, unknown> = {
      ...window.history.state,
      ashAtlasMobileMenuView: nextChild.destination,
      ashAtlasMobileMenuChild: nextChild,
      ashAtlasMobileMenuDepth: depth
    };
    if (categoryRef.current) nextState.ashAtlasMobileMenuCategory = categoryRef.current;
    else delete nextState.ashAtlasMobileMenuCategory;
    if (nextChild.destination === "messages" && nextChild.screen === "peer") {
      nextState.ashAtlasMobileMessagePeerId = nextChild.id;
    } else {
      delete nextState.ashAtlasMobileMessagePeerId;
    }
    window.history.pushState(nextState, "");
    childRef.current = nextChild;
    messageBackPendingRef.current = false;
    ownedDepthRef.current = depth;
    setChild(nextChild);
    setMessagePeerId(messagePeerIdFromChild(nextChild));
  }, [enabled]);

  const openMessagePeer = useCallback((peerId: string): void => {
    if (
      !enabled ||
      viewRef.current !== "messages" ||
      childRef.current !== null ||
      mobileMenuHistoryFromState({
        ashAtlasMobileMenuView: "messages",
        ashAtlasMobileMenuChild: { destination: "messages", screen: "peer", id: peerId }
      }).child === null
    ) return;
    openChild({ destination: "messages", screen: "peer", id: peerId });
  }, [enabled, openChild]);

  const openMessageNotification = useCallback((entryKey: string): void => {
    if (
      !enabled ||
      viewRef.current !== "messages" ||
      childRef.current !== null ||
      !entryKey.trim()
    ) return;
    openChild({ destination: "messages", screen: "notification", id: entryKey });
  }, [enabled, openChild]);

  const backMessageDetail = useCallback((): void => {
    if (
      !enabled ||
      childRef.current?.destination !== "messages" ||
      messageBackPendingRef.current
    ) return;
    messageBackPendingRef.current = true;
    window.history.back();
  }, [enabled]);

  const back = useCallback((): void => {
    if (!enabled || viewRef.current === "gameplay") return;
    // Desktop windows are top-level: Back from one (no in-app sub-page open) closes it
    // instead of landing on a Game Menu window that was never shown.
    if (
      document.documentElement.dataset.presentation === "desktop" &&
      viewRef.current !== "menu" &&
      childRef.current === null
    ) {
      close();
      return;
    }
    destinationTransitionRef.current += 1;
    window.history.back();
  }, [close, enabled]);

  return {
    view,
    category,
    child,
    messagePeerId,
    messageNotificationKey: child?.destination === "messages" && child.screen === "notification"
      ? child.id
      : null,
    shortcut,
    openMenu,
    openCategory,
    openDestination,
    openShortcut,
    replaceDestination,
    openChild,
    openMessagePeer,
    openMessageNotification,
    backMessageDetail,
    back,
    close
  };
}

function messagePeerIdFromChild(child: MobileMenuChild | null): string | null {
  return child?.destination === "messages" && child.screen === "peer" ? child.id : null;
}
