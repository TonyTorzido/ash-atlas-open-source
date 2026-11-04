// @vitest-environment jsdom

import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  getKeyboardDiagnosticReport,
  getMobileChatProtectionActive,
  getMobileKeyboardDockingSnapshot,
  handleMobileChatInputFocus,
  MOBILE_KEYBOARD_COMMITTED_EVENT,
  MOBILE_KEYBOARD_SETTLED_EVENT,
  MobileChatOverlay,
  prepareMobileChatInputPointerDown,
  reconcileMobileChatProtectionState,
  resetMobileKeyboardDockingForTests,
  sanitizeTransientMobileChatState,
  setKeyboardDiagnosticsEnabled,
  startMobileKeyboardDocking
} from "./mobileKeyboardDocking.js";

type FrameCallback = (timestamp: number) => void;

let frames: FrameCallback[] = [];
let stopController: (() => void) | null = null;
let visualListeners = new Map<string, EventListener>();
let visual: {
  width: number;
  height: number;
  offsetTop: number;
  offsetLeft: number;
  addEventListener(name: string, listener: EventListener): void;
  removeEventListener(name: string): void;
};

beforeEach(() => {
  frames = [];
  visualListeners = new Map();
  visual = {
    width: 390,
    height: 844,
    offsetTop: 0,
    offsetLeft: 0,
    addEventListener: (name, listener) => visualListeners.set(name, listener),
    removeEventListener: (name) => visualListeners.delete(name)
  };
  Object.defineProperty(window, "visualViewport", { configurable: true, value: visual });
  Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 390 });
  Object.defineProperty(window, "innerHeight", { configurable: true, writable: true, value: 844 });
  Object.defineProperty(window, "scrollX", { configurable: true, writable: true, value: 0 });
  Object.defineProperty(window, "scrollY", { configurable: true, writable: true, value: 0 });
  document.documentElement.scrollLeft = 0;
  document.documentElement.scrollTop = 0;
  Object.defineProperty(window.screen, "width", { configurable: true, value: 390 });
  Object.defineProperty(window.screen, "height", { configurable: true, value: 844 });
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn((query: string) => ({
      matches: query === "(display-mode: standalone)",
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    }))
  });
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    frames.push(callback);
    return frames.length;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
  document.documentElement.dataset.uiProfile = "phone";
  stopController = startMobileKeyboardDocking();
  flushFrames();
});

afterEach(() => {
  cleanup();
  stopController?.();
  stopController = null;
  resetMobileKeyboardDockingForTests();
  delete document.documentElement.dataset.uiProfile;
  window.history.replaceState(null, "", "/");
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("mobile keyboard docking", () => {
  it("leaves the screen edge to native history navigation", () => {
    const view = render(
      <MobileChatOverlay open type="public" aria-label="Native edge overlay">
        <button data-mobile-chat-close="true">Close</button>
      </MobileChatOverlay>
    );

    expect(view.container.querySelector("[data-mobile-chat-edge-swipe]")).toBeNull();
    expect(view.getByLabelText("Native edge overlay").dataset.mobileChatGesture).toBeUndefined();
  });

  it("stays open when Back from a screen opened over the chat returns to the chat's entry", () => {
    const onClose = vi.fn();
    render(
      <MobileChatOverlay open type="public" aria-label="Covered chat overlay" onRequestClose={onClose}>
        <form data-mobile-chat-composer><textarea aria-label="Covered draft" /></form>
      </MobileChatOverlay>
    );
    flushFrames();
    const chatEntry = window.history.state as Record<string, unknown>;
    expect(chatEntry.ashAtlasChatOverlay).toBeTruthy();

    // A profile pushed over the chat, then Back lands on the chat's own entry.
    act(() => {
      window.dispatchEvent(new PopStateEvent("popstate", { state: chatEntry }));
    });
    expect(onClose).not.toHaveBeenCalled();

    act(() => {
      window.dispatchEvent(new PopStateEvent("popstate", { state: null }));
    });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("dismisses focused chat and restores gameplay protection when native back pops history", () => {
    const back = vi.spyOn(window.history, "back").mockImplementation(() => undefined);
    const onClose = vi.fn();
    const hud = document.createElement("div");
    hud.className = "phone-hud";
    document.body.append(hud);
    const Harness = (): React.JSX.Element => {
      const [open, setOpen] = useState(true);
      return (
        <MobileChatOverlay
          open={open}
          type="public"
          aria-label="Native back overlay"
          onRequestClose={() => {
            onClose();
            setOpen(false);
          }}
        >
          <form data-mobile-chat-composer>
            <textarea aria-label="Native back draft" />
          </form>
        </MobileChatOverlay>
      );
    };
    const view = render(<Harness />);
    flushFrames();
    const draft = view.getByLabelText("Native back draft");
    act(() => draft.focus());
    visual.height = 500;
    act(() => visualListeners.get("resize")?.(new Event("resize")));
    flushFrames();

    expect(window.history.state.ashAtlasChatOverlay).toBeTruthy();
    expect(document.activeElement).toBe(draft);
    expect(getMobileChatProtectionActive()).toBe(true);
    expect(hud.hasAttribute("inert")).toBe(true);

    const popstate = new PopStateEvent("popstate", { state: null });
    Object.defineProperty(popstate, "hasUAVisualTransition", { value: true });
    act(() => {
      window.dispatchEvent(popstate);
    });

    const exiting = view.container.querySelector<HTMLElement>('[aria-label="Native back overlay"]');
    expect(onClose).toHaveBeenCalledOnce();
    expect(back).not.toHaveBeenCalled();
    expect(document.activeElement).not.toBe(draft);
    expect(exiting?.dataset.mobileChatPresence).toBe("exiting");
    expect(exiting?.hasAttribute("inert")).toBe(true);
    expect(exiting?.getAttribute("aria-hidden")).toBe("true");
    expect(getMobileChatProtectionActive()).toBe(false);
    expect(document.documentElement.dataset.mobileChatProtected).toBeUndefined();
    expect(hud.hasAttribute("inert")).toBe(false);

    visual.height = 844;
    act(() => visualListeners.get("resize")?.(new Event("resize")));
    flushFrames();
    flushFrames();
    expect(getMobileKeyboardDockingSnapshot().phase).toBe("closed");
    expect(view.queryByLabelText("Native back overlay")).toBeNull();
    hud.remove();
  });

  it("does not back out of a phone destination when public chat closes during navigation", () => {
    const back = vi.spyOn(window.history, "back").mockImplementation(() => undefined);
    const view = render(
      <MobileChatOverlay open type="public" aria-label="Public navigation overlay" onRequestClose={vi.fn()}>
        <div>Chat</div>
      </MobileChatOverlay>
    );
    flushFrames();
    expect(window.history.state.ashAtlasChatOverlay).toBeTruthy();
    window.history.replaceState({
      ...window.history.state,
      ashAtlasMobileMenuView: "profile",
      ashAtlasMobileMenuDepth: 2
    }, "");

    view.rerender(
      <MobileChatOverlay open={false} type="public" aria-label="Public navigation overlay" onRequestClose={vi.fn()}>
        <div>Chat</div>
      </MobileChatOverlay>
    );

    expect(back).not.toHaveBeenCalled();
    expect(window.history.state).toMatchObject({
      ashAtlasMobileMenuView: "profile",
      ashAtlasMobileMenuDepth: 2
    });
    expect(window.history.state).not.toHaveProperty("ashAtlasChatOverlay");
  });

  it("repairs an ownerless retained root lock and restores the HUD", () => {
    const hud = document.createElement("div");
    hud.className = "phone-hud";
    hud.dataset.chatSuppressed = "true";
    hud.setAttribute("inert", "");
    hud.setAttribute("aria-hidden", "true");
    document.body.append(hud);
    document.documentElement.dataset.mobileChatProtected = "true";

    expect(reconcileMobileChatProtectionState("retained-profile-test")).toBe(false);
    expect(document.documentElement.dataset.mobileChatProtected).toBeUndefined();
    expect(hud.hasAttribute("inert")).toBe(false);
    expect(hud.getAttribute("aria-hidden")).toBe("false");
    expect(hud.dataset.chatSuppressed).toBe("false");
    hud.remove();
  });

  it("sanitizes stale transient chat locks without touching durable browser storage", () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const removeItem = vi.spyOn(Storage.prototype, "removeItem");
    const hud = document.createElement("div");
    hud.className = "phone-hud";
    hud.setAttribute("inert", "");
    document.body.append(hud);
    document.documentElement.dataset.mobileChatProtected = "true";
    document.documentElement.dataset.mobileKeyboardPhase = "opening";
    document.documentElement.dataset.iosStandaloneChatLocked = "true";

    sanitizeTransientMobileChatState();

    expect(document.documentElement.dataset.mobileChatProtected).toBeUndefined();
    expect(document.documentElement.dataset.mobileKeyboardPhase).toBeUndefined();
    expect(document.documentElement.dataset.iosStandaloneChatLocked).toBeUndefined();
    expect(hud.hasAttribute("inert")).toBe(false);
    expect(setItem).not.toHaveBeenCalled();
    expect(removeItem).not.toHaveBeenCalled();
    hud.remove();
  });

  it.each(["public", "direct"] as const)(
    "focuses the iOS standalone %s input before ensuring the root lock without saving focus-induced scroll",
    (type) => {
      mockIosEnvironment(true);
      window.scrollX = 12;
      window.scrollY = 34;
      const view = render(
        <MobileChatOverlay open type={type} aria-label={`${type} root lock overlay`}>
          <textarea
            aria-label={`${type} root lock draft`}
            onPointerDown={prepareMobileChatInputPointerDown}
            onFocus={handleMobileChatInputFocus}
          />
        </MobileChatOverlay>
      );
      const draft = view.getByLabelText(`${type} root lock draft`) as HTMLTextAreaElement;
      const nativeFocus = draft.focus.bind(draft);
      let lockAtFocus: string | undefined;
      const focus = vi.spyOn(draft, "focus").mockImplementation(() => {
        lockAtFocus = document.documentElement.dataset.iosStandaloneChatLocked;
        window.scrollX = 90;
        window.scrollY = 140;
        nativeFocus();
      });

      expect(document.documentElement.dataset.mobileChatProtected).toBe("true");
      expect(document.documentElement.dataset.iosStandaloneChatLocked).toBeUndefined();

      expect(fireEvent.pointerDown(draft)).toBe(true);
      expect(document.documentElement.dataset.iosStandaloneChatLocked).toBe("true");
      expect(getKeyboardDiagnosticReport().current).toMatchObject({
        lockedScrollPosition: { x: 12, y: 34 }
      });
      expect(lockAtFocus).toBeUndefined();
      expect(focus).toHaveBeenCalledWith();
      expect(document.activeElement).toBe(draft);
      expect(fireEvent.pointerDown(draft)).toBe(true);
      expect(focus).toHaveBeenCalledTimes(1);
    }
  );

  it("does not lock prematurely when focus is ignored and locks on later native focus", () => {
    mockIosEnvironment(true);
    const view = render(
      <MobileChatOverlay open type="public">
        <textarea
          aria-label="Fallback draft"
          onPointerDown={prepareMobileChatInputPointerDown}
          onFocus={handleMobileChatInputFocus}
        />
      </MobileChatOverlay>
    );
    const draft = view.getByLabelText("Fallback draft") as HTMLTextAreaElement;
    const nativeFocus = draft.focus.bind(draft);
    const focus = vi.spyOn(draft, "focus").mockImplementation(() => undefined);

    expect(fireEvent.pointerDown(draft)).toBe(true);
    expect(focus).toHaveBeenCalledWith();
    expect(document.documentElement.dataset.iosStandaloneChatLocked).toBeUndefined();
    expect(document.activeElement).not.toBe(draft);

    act(() => nativeFocus());
    expect(document.activeElement).toBe(draft);
    expect(document.documentElement.dataset.iosStandaloneChatLocked).toBe("true");
  });

  it.each(["public", "direct"] as const)(
    "does not fight focus, scrolling, or typing in the iOS standalone %s overlay",
    (type) => {
      mockIosEnvironment(true);
      const scrollTo = vi.spyOn(window, "scrollTo");
      const view = render(
        <MobileChatOverlay open type={type} aria-label={`${type} passive lock overlay`}>
          <textarea
            aria-label={`${type} passive lock draft`}
            onFocus={handleMobileChatInputFocus}
          />
        </MobileChatOverlay>
      );
      const overlay = view.getByLabelText(`${type} passive lock overlay`);
      const draft = view.getByLabelText(`${type} passive lock draft`) as HTMLTextAreaElement;
      act(() => draft.focus());
      const committedUpdates = getMobileKeyboardDockingSnapshot().committedInsetUpdateCount;

      window.scrollX = 90;
      window.scrollY = 140;
      act(() => {
        window.dispatchEvent(new Event("scroll"));
        document.dispatchEvent(new Event("scroll"));
      });
      fireEvent.input(draft, { target: { value: "still typing" } });

      expect(scrollTo).not.toHaveBeenCalled();
      expect(document.documentElement.dataset.iosStandaloneChatLocked).toBe("true");
      expect(view.getByLabelText(`${type} passive lock overlay`)).toBe(overlay);
      expect(getMobileKeyboardDockingSnapshot().committedInsetUpdateCount).toBe(committedUpdates);
    }
  );

  it.each(["public", "direct"] as const)(
    "contains %s composer-frame drags without blocking text or message-history gestures",
    (type) => {
      mockIosEnvironment(true);
      const view = render(
        <MobileChatOverlay open type={type} aria-label={`${type} composer containment overlay`}>
          <div data-mobile-chat-message-region aria-label={`${type} message history`} />
          <form data-mobile-chat-composer aria-label={`${type} composer`}>
            <span aria-label={`${type} composer frame`} />
            <textarea
              aria-label={`${type} composer draft`}
              onFocus={handleMobileChatInputFocus}
            />
          </form>
        </MobileChatOverlay>
      );
      const draft = view.getByLabelText(`${type} composer draft`);
      act(() => draft.focus());
      expect(document.documentElement.dataset.iosStandaloneChatLocked).toBe("true");

      const frameMove = new Event("touchmove", { bubbles: true, cancelable: true });
      view.getByLabelText(`${type} composer frame`).dispatchEvent(frameMove);
      expect(frameMove.defaultPrevented).toBe(true);

      const draftMove = new Event("touchmove", { bubbles: true, cancelable: true });
      draft.dispatchEvent(draftMove);
      expect(draftMove.defaultPrevented).toBe(false);

      const historyMove = new Event("touchmove", { bubbles: true, cancelable: true });
      view.getByLabelText(`${type} message history`).dispatchEvent(historyMove);
      expect(historyMove.defaultPrevented).toBe(false);
    }
  );

  it("releases the root lock on confirmed dismissal and normalizes document scroll", () => {
    vi.useFakeTimers();
    mockIosEnvironment(true);
    Object.defineProperty(window, "scrollX", { configurable: true, writable: true, value: 12 });
    Object.defineProperty(window, "scrollY", { configurable: true, writable: true, value: 34 });
    const scrollTo = vi.spyOn(window, "scrollTo").mockImplementation((x, y) => {
      Object.defineProperty(window, "scrollX", { configurable: true, writable: true, value: x });
      Object.defineProperty(window, "scrollY", { configurable: true, writable: true, value: y });
    });
    const view = render(
      <MobileChatOverlay open type="direct" aria-label="Closing root lock overlay">
        <textarea
          aria-label="Closing root lock draft"
          onFocus={handleMobileChatInputFocus}
        />
      </MobileChatOverlay>
    );
    const draft = view.getByLabelText("Closing root lock draft");
    act(() => draft.focus());
    visual.height = 500;
    act(() => void vi.advanceTimersByTime(250));
    flushFrames();
    window.scrollX = 90;
    window.scrollY = 140;
    act(() => {
      window.dispatchEvent(new Event("scroll"));
    });
    expect(scrollTo).not.toHaveBeenCalled();

    act(() => draft.blur());
    expect(document.documentElement.dataset.iosStandaloneChatLocked).toBe("true");
    flushNextFrame();
    expect(getMobileKeyboardDockingSnapshot().phase).toBe("closing");
    expect(document.documentElement.dataset.iosStandaloneChatLocked).toBeUndefined();
    expect(document.documentElement.dataset.mobileKeyboardCommitted).toBe("false");
    expect(scrollTo).toHaveBeenCalledTimes(1);
    expect(scrollTo).toHaveBeenCalledWith(0, 0);
    expect(view.queryByLabelText("Closing root lock overlay")).toBeTruthy();

    visual.height = 844;
    visual.offsetTop = 0;
    act(() => visualListeners.get("resize")?.(new Event("resize")));
    flushFrames();
    flushFrames();
    flushFrames();

    expect(getMobileKeyboardDockingSnapshot().phase).toBe("closed");
    expect(view.queryByLabelText("Closing root lock overlay")).toBeTruthy();
    expect(view.container.querySelector('[data-mobile-chat-protection="direct"]')).toBeTruthy();
    expect(document.documentElement.dataset.iosStandaloneChatLocked).toBeUndefined();
    expect(scrollTo).toHaveBeenCalledTimes(1);
    act(() => {
      window.dispatchEvent(new Event("scroll"));
    });
    flushFrames();
    expect(scrollTo).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["regular Safari", (): void => { mockIosEnvironment(false); }],
    ["Android", (): void => {}]
  ] as const)("does not apply the iOS root lock or pointer override in %s", (_name, configure) => {
    configure();
    const view = render(
      <MobileChatOverlay open type="public" aria-label="Other platform overlay">
        <textarea
          aria-label="Other platform draft"
          onPointerDown={prepareMobileChatInputPointerDown}
        />
      </MobileChatOverlay>
    );
    const draft = view.getByLabelText("Other platform draft") as HTMLTextAreaElement;
    const focus = vi.spyOn(draft, "focus");

    expect(document.documentElement.dataset.iosStandaloneChatLocked).toBeUndefined();
    expect(fireEvent.pointerDown(draft)).toBe(true);
    expect(focus).not.toHaveBeenCalled();
  });

  it.each(["public", "direct"] as const)(
    "uses forced delayed iOS standalone samples for the %s composer",
    (type) => {
      vi.useFakeTimers();
      let now = 1_000;
      vi.spyOn(performance, "now").mockImplementation(() => now);
      mockIosEnvironment(true);
      const view = render(
        <MobileChatOverlay open type={type} aria-label={`${type} standalone overlay`}>
          <div data-mobile-chat-message-region />
          <form data-mobile-chat-composer>
            <textarea aria-label={`${type} standalone draft`} />
          </form>
        </MobileChatOverlay>
      );
      flushFrames();
      const draft = view.getByLabelText(`${type} standalone draft`);

      act(() => draft.focus());
      flushNextFrame();

      visual.height = 400;
      visual.offsetTop = 0;
      now = 1_050;
      act(() => void vi.advanceTimersByTime(50));
      expect(getMobileKeyboardDockingSnapshot()).toMatchObject({
        phase: "opening",
        lastEvent: "ios-standalone-opening-sample:50",
        committedKeyboardInset: 0,
        committedInsetUpdateCount: 0
      });

      now = 1_100;
      act(() => void vi.advanceTimersByTime(50));
      expect(getMobileKeyboardDockingSnapshot()).toMatchObject({
        lastEvent: "ios-standalone-opening-sample:100",
        committedKeyboardInset: 0,
        committedInsetUpdateCount: 0
      });

      visual.height = 400;
      visual.offsetTop = 120;
      now = 1_150;
      act(() => void vi.advanceTimersByTime(50));
      expect(getMobileKeyboardDockingSnapshot()).toMatchObject({
        lastEvent: "ios-standalone-opening-sample:150",
        committedKeyboardInset: 0,
        committedInsetUpdateCount: 0
      });

      now = 1_250;
      act(() => void vi.advanceTimersByTime(100));
      expect(getMobileKeyboardDockingSnapshot()).toMatchObject({
        phase: "open",
        lastEvent: "ios-standalone-opening-sample:250",
        committedKeyboardInset: 324,
        committedInsetUpdateCount: 1,
        focusToCommittedInsetMs: 250
      });
      expect(document.documentElement.style.getPropertyValue("--mobile-chat-committed-keyboard-inset")).toBe("324px");
      expect(view.getByLabelText(`${type} standalone overlay`).getAttribute("style")).toBeNull();
      expect(view.container.querySelector(`[data-mobile-chat-protection="${type}"]`)).toBeTruthy();
    }
  );

  it("uses the median of the latest valid iOS standalone samples at 250 ms", () => {
    vi.useFakeTimers();
    let now = 2_000;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    mockIosEnvironment(true);
    const view = render(
      <MobileChatOverlay open type="public" aria-label="Standalone fallback overlay">
        <form data-mobile-chat-composer>
          <textarea aria-label="Standalone fallback draft" />
        </form>
      </MobileChatOverlay>
    );
    flushFrames();

    act(() => view.getByLabelText("Standalone fallback draft").focus());
    flushNextFrame();
    for (const sample of [
      { elapsed: 50, height: 500, offsetTop: 0 },
      { elapsed: 100, height: 510, offsetTop: 20 },
      { elapsed: 150, height: 489, offsetTop: 21 },
      { elapsed: 250, height: 468, offsetTop: 22 }
    ]) {
      visual.height = sample.height;
      visual.offsetTop = sample.offsetTop;
      const advance = sample.elapsed - (now - 2_000);
      now = 2_000 + sample.elapsed;
      act(() => void vi.advanceTimersByTime(advance));
    }

    expect(getMobileKeyboardDockingSnapshot()).toMatchObject({
      phase: "open",
      committedKeyboardInset: 334,
      committedInsetUpdateCount: 1,
      focusToCommittedInsetMs: 250
    });
  });

  it("reuses the portrait iOS standalone inset and retains it through closing", () => {
    vi.useFakeTimers();
    let now = 3_000;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    mockIosEnvironment(true);
    const view = render(
      <MobileChatOverlay open type="direct" aria-label="Cached DM overlay">
        <form data-mobile-chat-composer>
          <textarea aria-label="Cached DM draft" />
        </form>
      </MobileChatOverlay>
    );
    flushFrames();
    const draft = view.getByLabelText("Cached DM draft");

    act(() => draft.focus());
    flushNextFrame();
    visual.height = 480;
    visual.offsetTop = 20;
    now = 3_150;
    act(() => void vi.advanceTimersByTime(150));
    now = 3_250;
    act(() => void vi.advanceTimersByTime(100));
    expect(getMobileKeyboardDockingSnapshot().committedKeyboardInset).toBe(344);

    act(() => draft.blur());
    flushNextFrame();
    expect(getMobileKeyboardDockingSnapshot()).toMatchObject({
      phase: "closing",
      committedKeyboardInset: 344
    });
    visual.height = 844;
    visual.offsetTop = 0;
    act(() => visualListeners.get("resize")?.(new Event("resize")));
    flushFrames();
    expect(getMobileKeyboardDockingSnapshot()).toMatchObject({
      phase: "closed",
      committedKeyboardInset: 0
    });

    now = 4_000;
    act(() => draft.focus());
    expect(getMobileKeyboardDockingSnapshot()).toMatchObject({
      phase: "opening",
      committedKeyboardInset: 344,
      committedInsetUpdateCount: 1
    });
  });

  it.each(["public", "direct"] as const)(
    "puts the iOS standalone %s composer in its final frame before viewport telemetry settles",
    (type) => {
      vi.useFakeTimers();
      let now = 5_000;
      vi.spyOn(performance, "now").mockImplementation(() => now);
      mockIosEnvironment(true);
      const view = render(
        <MobileChatOverlay open type={type} aria-label={`${type} settled dismissal overlay`}>
          <form data-mobile-chat-composer>
            <textarea
              aria-label={`${type} settled dismissal draft`}
              onFocus={handleMobileChatInputFocus}
            />
          </form>
        </MobileChatOverlay>
      );
      flushFrames();
      const draft = view.getByLabelText(`${type} settled dismissal draft`);
      const overlay = view.getByLabelText(`${type} settled dismissal overlay`);
      const composer = view.container.querySelector<HTMLElement>("[data-mobile-chat-composer]")!;
      mockRect(overlay, () => {
        const bottom = document.documentElement.dataset.iosStandaloneChatLocked === "true"
          ? visual.offsetTop + visual.height
          : 844;
        return { top: 0, bottom, height: bottom };
      });
      mockRect(composer, () => {
        const bottom = document.documentElement.dataset.iosStandaloneChatLocked === "true"
          ? visual.offsetTop + visual.height
          : 844;
        return { top: bottom - 60, bottom, height: 60 };
      });

      act(() => draft.focus());
      visual.height = 500;
      for (const elapsed of [50, 100, 150, 250]) {
        const advance = elapsed - (now - 5_000);
        now = 5_000 + elapsed;
        act(() => void vi.advanceTimersByTime(advance));
      }
      flushFrames();
      expect(getMobileKeyboardDockingSnapshot()).toMatchObject({
        phase: "open",
        committedKeyboardInset: 344
      });

      act(() => draft.blur());
      flushNextFrame();
      expect(getMobileKeyboardDockingSnapshot().phase).toBe("closing");
      expect(document.documentElement.dataset.iosStandaloneChatLocked).toBeUndefined();
      expect(document.documentElement.dataset.mobileKeyboardCommitted).toBe("false");
      expect(composer.getBoundingClientRect().bottom).toBe(844);

      visual.height = 810;
      act(() => visualListeners.get("resize")?.(new Event("resize")));
      flushFrames();

      expect(getMobileKeyboardDockingSnapshot()).toMatchObject({
        phase: "closing",
        acceptedCandidateInset: 34,
        committedKeyboardInset: 344
      });
      expect(document.documentElement.dataset.iosStandaloneChatLocked).toBeUndefined();
      expect(document.documentElement.dataset.mobileKeyboardCommitted).toBe("false");
      expect(composer.getBoundingClientRect().bottom).toBe(844);

      act(() => void vi.advanceTimersByTime(650));

      expect(getMobileKeyboardDockingSnapshot()).toMatchObject({
        phase: "closed",
        acceptedCandidateInset: 0,
        committedKeyboardInset: 0
      });
      expect(document.documentElement.dataset.iosStandaloneChatLocked).toBeUndefined();
      expect(document.documentElement.dataset.mobileKeyboardCommitted).toBe("false");
      expect(composer.getBoundingClientRect().bottom).toBe(844);
    }
  );

  it("keeps the animation-frame opening path for regular iOS Safari", () => {
    mockIosEnvironment(false);
    const view = render(
      <MobileChatOverlay open type="public" aria-label="Safari overlay">
        <form data-mobile-chat-composer>
          <textarea aria-label="Safari draft" />
        </form>
      </MobileChatOverlay>
    );
    flushFrames();

    act(() => view.getByLabelText("Safari draft").focus());
    visual.height = 500;
    act(() => visualListeners.get("resize")?.(new Event("resize")));
    flushFrames();

    expect(getMobileKeyboardDockingSnapshot()).toMatchObject({
      standalone: false,
      phase: "open",
      committedKeyboardInset: 344,
      committedInsetUpdateCount: 1
    });
  });

  it.each(["public", "direct"] as const)(
    "commits one stable composer inset after focus and transient %s viewport samples",
    (type) => {
      const view = render(
        <MobileChatOverlay open type={type} aria-label={`${type} overlay`}>
          <div data-mobile-chat-message-region />
          <form data-mobile-chat-composer>
            <textarea aria-label={`${type} draft`} />
            <button type="button">Send</button>
          </form>
        </MobileChatOverlay>
      );
      flushFrames();
      const draft = view.getByLabelText(`${type} draft`);

      act(() => draft.focus());
      flushNextFrame();
      expect(getMobileKeyboardDockingSnapshot()).toMatchObject({
        phase: "opening",
        focused: true,
        committedKeyboardInset: 0,
        committedInsetUpdateCount: 0
      });
      expect(document.documentElement.style.getPropertyValue("--mobile-chat-committed-keyboard-inset")).toBe("0px");
      expect(document.documentElement.dataset.mobileKeyboardCommitted).toBe("false");
      expect(view.getByLabelText(`${type} overlay`).getAttribute("style")).toBeNull();

      for (const sample of [
        { height: 812, offsetTop: 0 },
        { height: 700, offsetTop: 100 },
        { height: 650, offsetTop: 0 }
      ]) {
        visual.height = sample.height;
        visual.offsetTop = sample.offsetTop;
        act(() => visualListeners.get("resize")?.(new Event("resize")));
        flushNextFrame();
        expect(getMobileKeyboardDockingSnapshot().committedKeyboardInset).toBe(0);
        expect(document.documentElement.style.getPropertyValue("--mobile-chat-committed-keyboard-inset")).toBe("0px");
      }

      visual.height = 500;
      visual.offsetTop = 0;
      act(() => visualListeners.get("resize")?.(new Event("resize")));
      flushNextFrame();
      flushNextFrame();
      expect(getMobileKeyboardDockingSnapshot().committedKeyboardInset).toBe(0);
      flushNextFrame();

      expect(getMobileKeyboardDockingSnapshot()).toMatchObject({
        phase: "open",
        acceptedCandidateInset: 344,
        committedKeyboardInset: 344,
        committedInsetUpdateCount: 1,
        fullOverlayGeometryStable: true
      });
      expect(getMobileKeyboardDockingSnapshot().rawCandidateChangeCount).toBeGreaterThan(1);
      expect(document.documentElement.style.getPropertyValue("--mobile-chat-committed-keyboard-inset")).toBe("344px");
      expect(document.documentElement.dataset.mobileKeyboardCommitted).toBe("true");
      expect(view.getByLabelText(`${type} overlay`).getAttribute("style")).toBeNull();
      expect(view.container.querySelector(".mobile-chat-protection")).toBeTruthy();
    }
  );

  it("uses the bounded opening fallback when contracted candidates keep changing", () => {
    let now = 1_000;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const view = render(
      <MobileChatOverlay open type="public" aria-label="Fallback overlay">
        <div data-mobile-chat-message-region />
        <form data-mobile-chat-composer>
          <textarea aria-label="Fallback draft" />
        </form>
      </MobileChatOverlay>
    );
    flushFrames();
    const draft = view.getByLabelText("Fallback draft");
    act(() => draft.focus());
    flushNextFrame();

    now = 1_050;
    visual.height = 610;
    act(() => visualListeners.get("resize")?.(new Event("resize")));
    flushNextFrame();
    expect(getMobileKeyboardDockingSnapshot().committedKeyboardInset).toBe(0);

    now = 1_200;
    visual.height = 590;
    act(() => visualListeners.get("resize")?.(new Event("resize")));
    flushNextFrame();
    expect(getMobileKeyboardDockingSnapshot()).toMatchObject({
      phase: "open",
      committedKeyboardInset: 254,
      committedInsetUpdateCount: 1,
      focusToCommittedInsetMs: 200
    });
  });

  it("releases public protection immediately while keyboard geometry settles", () => {
    const view = render(
      <MobileChatOverlay open type="public" aria-label="Public overlay">
        <form data-mobile-chat-composer>
          <textarea aria-label="Public draft" />
        </form>
      </MobileChatOverlay>
    );
    flushFrames();
    const draft = view.getByLabelText("Public draft");

    act(() => draft.focus());
    visual.offsetTop = 18;
    visual.height = 500;
    act(() => visualListeners.get("resize")?.(new Event("resize")));
    flushFrames();
    expect(getMobileKeyboardDockingSnapshot().phase).toBe("open");
    expect(document.documentElement.style.getPropertyValue("--mobile-chat-viewport-top")).toBe("");
    expect(document.documentElement.style.getPropertyValue("--mobile-chat-viewport-height")).toBe("");
    expect(document.documentElement.style.getPropertyValue("--mobile-chat-keyboard-boundary")).toBe("518px");
    expect(document.documentElement.style.getPropertyValue("--mobile-chat-keyboard-inset")).toBe("326px");
    expect(document.documentElement.style.getPropertyValue("--mobile-chat-committed-keyboard-inset")).toBe("326px");
    expect(view.getByLabelText("Public overlay").getAttribute("style")).toBeNull();
    expect(view.container.querySelector(".mobile-chat-protection")).toBeTruthy();
    expect(document.documentElement.dataset.mobileChatProtected).toBe("true");
    expect(getMobileChatProtectionActive()).toBe(true);

    view.rerender(
      <MobileChatOverlay open={false} type="public" aria-label="Public overlay">
        <form data-mobile-chat-composer>
          <textarea aria-label="Public draft" />
        </form>
      </MobileChatOverlay>
    );
    const exiting = view.container.querySelector<HTMLElement>('[aria-label="Public overlay"]');
    expect(exiting).toBeTruthy();
    expect(exiting?.dataset.mobileChatPresence).toBe("exiting");
    expect(exiting?.hasAttribute("inert")).toBe(true);
    expect(exiting?.getAttribute("aria-hidden")).toBe("true");
    expect(document.activeElement).not.toBe(draft);
    expect(document.documentElement.dataset.mobileChatProtected).toBeUndefined();
    expect(getMobileChatProtectionActive()).toBe(false);

    flushNextFrame();
    expect(getMobileKeyboardDockingSnapshot()).toMatchObject({
      phase: "closing",
      committedKeyboardInset: 326
    });
    expect(view.container.querySelector('[aria-label="Public overlay"]')).toBeTruthy();
    expect(view.container.querySelector(".mobile-chat-protection")).toBeTruthy();
    visual.offsetTop = 0;
    visual.height = 844;
    act(() => visualListeners.get("resize")?.(new Event("resize")));
    flushFrames();
    flushFrames();

    expect(getMobileKeyboardDockingSnapshot().phase).toBe("closed");
    expect(view.queryByLabelText("Public overlay")).toBeNull();
    expect(document.documentElement.style.getPropertyValue("--mobile-chat-keyboard-boundary")).toBe("844px");
    expect(document.documentElement.style.getPropertyValue("--mobile-chat-keyboard-inset")).toBe("0px");
    expect(document.documentElement.style.getPropertyValue("--mobile-chat-committed-keyboard-inset")).toBe("0px");
    expect(document.documentElement.dataset.mobileChatProtected).toBeUndefined();
    expect(getMobileChatProtectionActive()).toBe(false);
  });

  it("uses the same committed docking lifecycle for a generic Android-sized viewport", () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 412 });
    Object.defineProperty(window, "innerHeight", { configurable: true, writable: true, value: 915 });
    Object.defineProperty(window.screen, "width", { configurable: true, value: 412 });
    Object.defineProperty(window.screen, "height", { configurable: true, value: 915 });
    visual.width = 412;
    visual.height = 915;
    act(() => {
      window.dispatchEvent(new Event("resize"));
    });
    flushFrames();

    const view = render(
      <MobileChatOverlay open type="public" aria-label="Android public overlay">
        <div data-mobile-chat-message-region />
        <form data-mobile-chat-composer>
          <textarea aria-label="Android draft" defaultValue="kept" />
        </form>
      </MobileChatOverlay>
    );
    flushFrames();
    const draft = view.getByLabelText("Android draft");
    act(() => draft.focus());
    visual.height = 560;
    act(() => visualListeners.get("resize")?.(new Event("resize")));
    flushFrames();
    expect(getMobileKeyboardDockingSnapshot()).toMatchObject({
      baselineHeight: 915,
      committedKeyboardInset: 355,
      committedInsetUpdateCount: 1,
      phase: "open"
    });

    act(() => draft.blur());
    visual.height = 915;
    act(() => visualListeners.get("resize")?.(new Event("resize")));
    flushFrames();
    expect(getMobileKeyboardDockingSnapshot()).toMatchObject({
      committedKeyboardInset: 0,
      phase: "closed"
    });
    expect((view.getByLabelText("Android draft") as HTMLTextAreaElement).value).toBe("kept");
  });

  it.each([
    ["public", "visual-only", 915, 355],
    ["direct", "visual-only", 915, 355],
    ["public", "layout-and-visual", 560, 0],
    ["direct", "layout-and-visual", 560, 0]
  ] as const)(
    "applies one in-flow dock for %s chat with the Android %s viewport model",
    (type, _model, keyboardOverlayBottom, expectedDock) => {
      Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 412 });
      Object.defineProperty(window, "innerHeight", { configurable: true, writable: true, value: 915 });
      visual.width = 412;
      visual.height = 915;
      act(() => {
        window.dispatchEvent(new Event("resize"));
      });
      flushFrames();

      let overlayBottom = 915;
      const view = render(
        <MobileChatOverlay open type={type} aria-label={`${type} Android geometry overlay`}>
          <div data-mobile-chat-dock-layout>
            <div data-mobile-chat-message-region />
            <form data-mobile-chat-composer>
              <textarea aria-label={`${type} Android geometry draft`} defaultValue="preserved" />
            </form>
          </div>
        </MobileChatOverlay>
      );
      flushFrames();
      const overlay = view.getByLabelText(`${type} Android geometry overlay`);
      const composer = view.container.querySelector<HTMLElement>("[data-mobile-chat-composer]")!;
      const messageRegion = view.container.querySelector<HTMLElement>("[data-mobile-chat-message-region]")!;
      mockRect(overlay, () => ({ top: 0, bottom: overlayBottom, height: overlayBottom }));
      mockRect(composer, () => {
        const dock = Number.parseFloat(
          document.documentElement.style.getPropertyValue("--mobile-chat-applied-keyboard-inset")
        ) || 0;
        return { top: overlayBottom - dock - 60, bottom: overlayBottom - dock, height: 60 };
      });
      mockRect(messageRegion, () => {
        const composerTop = composer.getBoundingClientRect().top;
        return { top: 100, bottom: composerTop, height: Math.max(0, composerTop - 100) };
      });
      flushFrames();

      act(() => view.getByLabelText(`${type} Android geometry draft`).focus());
      overlayBottom = keyboardOverlayBottom;
      if (_model === "layout-and-visual") {
        Object.defineProperty(window, "innerHeight", {
          configurable: true,
          writable: true,
          value: 560
        });
      }
      visual.height = 560;
      act(() => visualListeners.get("resize")?.(new Event("resize")));
      flushFrames();

      const current = getMobileKeyboardDockingSnapshot();
      expect(current).toMatchObject({
        phase: "open",
        keyboardOcclusion: 355,
        committedKeyboardInset: 355,
        appliedDockInset: expectedDock,
        overlayHeightChanged: _model === "layout-and-visual"
      });
      expect(current.appliedDockInset).toBeLessThanOrEqual(
        Math.max(0, current.overlayRect!.bottom - current.viewport.bottom)
      );
      expect(Math.abs(current.composerGap ?? Number.POSITIVE_INFINITY)).toBeLessThanOrEqual(1);
      expect(current.messageRegionRect!.bottom).toBeLessThanOrEqual(current.composerRect!.top);
      expect(document.documentElement.style.getPropertyValue("--mobile-chat-applied-keyboard-inset"))
        .toBe(`${expectedDock}px`);
      expect((view.getByLabelText(`${type} Android geometry draft`) as HTMLTextAreaElement).value)
        .toBe("preserved");
    }
  );

  it("removes a stale Android dock after the layout viewport finishes resizing", () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 412 });
    Object.defineProperty(window, "innerHeight", { configurable: true, writable: true, value: 915 });
    visual.width = 412;
    visual.height = 915;
    act(() => {
      window.dispatchEvent(new Event("resize"));
    });
    flushFrames();

    let overlayBottom = 915;
    const view = render(
      <MobileChatOverlay open type="public" aria-label="Delayed Android layout overlay">
        <div data-mobile-chat-message-region />
        <form data-mobile-chat-composer>
          <textarea aria-label="Delayed Android draft" />
        </form>
      </MobileChatOverlay>
    );
    flushFrames();
    const overlay = view.getByLabelText("Delayed Android layout overlay");
    const composer = view.container.querySelector<HTMLElement>("[data-mobile-chat-composer]")!;
    mockRect(overlay, () => ({ top: 0, bottom: overlayBottom, height: overlayBottom }));
    mockRect(composer, () => {
      const dock = Number.parseFloat(
        document.documentElement.style.getPropertyValue("--mobile-chat-applied-keyboard-inset")
      ) || 0;
      return { top: overlayBottom - dock - 60, bottom: overlayBottom - dock, height: 60 };
    });

    act(() => view.getByLabelText("Delayed Android draft").focus());
    visual.height = 560;
    act(() => visualListeners.get("resize")?.(new Event("resize")));
    flushNextFrame();
    flushNextFrame();
    flushNextFrame();
    expect(getMobileKeyboardDockingSnapshot().appliedDockInset).toBe(355);

    overlayBottom = 560;
    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      writable: true,
      value: 560
    });
    flushNextFrame();

    expect(getMobileKeyboardDockingSnapshot()).toMatchObject({
      phase: "open",
      committedKeyboardInset: 355,
      appliedDockInset: 0,
      composerGap: 355
    });
    flushNextFrame();
    expect(getMobileKeyboardDockingSnapshot().composerGap).toBe(0);
    expect(document.documentElement.style.getPropertyValue("--mobile-chat-applied-keyboard-inset"))
      .toBe("0px");
  });

  it("rebases closed browser-toolbar geometry without manufacturing keyboard occlusion", () => {
    visual.height = 800;
    visual.offsetTop = 12;
    act(() => visualListeners.get("scroll")?.(new Event("scroll")));
    flushFrames();

    expect(getMobileKeyboardDockingSnapshot()).toMatchObject({
      phase: "closed",
      baselineHeight: 812,
      keyboardOcclusion: 0,
      committedKeyboardInset: 0,
      appliedDockInset: 0
    });
  });

  it.each(["public", "direct"] as const)(
    "forces terminal closed geometry for %s chat when Android sends no final viewport resize",
    (type) => {
      vi.useFakeTimers();
      const committed = vi.fn();
      const settled = vi.fn();
      window.addEventListener(MOBILE_KEYBOARD_COMMITTED_EVENT, committed);
      window.addEventListener(MOBILE_KEYBOARD_SETTLED_EVENT, settled);
      const overlayBottom = 844;
      const view = render(
        <MobileChatOverlay open type={type} aria-label={`${type} fallback overlay`}>
          <div data-mobile-chat-dock-layout>
            <div data-mobile-chat-message-region />
            <form data-mobile-chat-composer>
              <textarea aria-label={`${type} fallback draft`} defaultValue="still here" />
            </form>
          </div>
        </MobileChatOverlay>
      );
      flushFrames();
      const overlay = view.getByLabelText(`${type} fallback overlay`);
      mockRect(overlay, () => ({ top: 0, bottom: overlayBottom, height: overlayBottom }));
      const draft = view.getByLabelText(`${type} fallback draft`) as HTMLTextAreaElement;

      act(() => draft.focus());
      visual.height = 500;
      act(() => visualListeners.get("resize")?.(new Event("resize")));
      flushFrames();
      expect(getMobileKeyboardDockingSnapshot()).toMatchObject({
        phase: "open",
        committedKeyboardInset: 344,
        appliedDockInset: 344
      });

      view.rerender(
        <MobileChatOverlay open={false} type={type} aria-label={`${type} fallback overlay`}>
          <div data-mobile-chat-dock-layout>
            <div data-mobile-chat-message-region />
            <form data-mobile-chat-composer>
              <textarea aria-label={`${type} fallback draft`} defaultValue="still here" />
            </form>
          </div>
        </MobileChatOverlay>
      );
      act(() => draft.blur());
      flushNextFrame();
      expect(getMobileKeyboardDockingSnapshot().phase).toBe("closing");
      expect(document.documentElement.dataset.mobileKeyboardCommitted).toBe("true");
      act(() => void vi.advanceTimersByTime(650));

      expect(getMobileKeyboardDockingSnapshot()).toMatchObject({
        phase: "closed",
        focused: false,
        committedKeyboardInset: 0,
        appliedDockInset: 0,
        keyboardOcclusion: 0
      });
      expect(document.documentElement.dataset.mobileKeyboardCommitted).toBe("false");
      expect(document.documentElement.style.getPropertyValue("--mobile-chat-applied-keyboard-inset"))
        .toBe("0px");
      expect(draft.value).toBe("still here");
      expect(settled).toHaveBeenCalledTimes(1);
      expect(committed).toHaveBeenCalledTimes(2);
      flushNextFrame();
      expect(view.queryByLabelText(`${type} fallback overlay`)).toBeNull();

      visual.height = 844;
      act(() => visualListeners.get("resize")?.(new Event("resize")));
      flushFrames();
      expect(getMobileKeyboardDockingSnapshot().phase).toBe("closed");
      expect(getMobileKeyboardDockingSnapshot().appliedDockInset).toBe(0);
      expect(settled).toHaveBeenCalledTimes(1);
      expect(committed).toHaveBeenCalledTimes(2);
      window.removeEventListener(MOBILE_KEYBOARD_COMMITTED_EVENT, committed);
      window.removeEventListener(MOBILE_KEYBOARD_SETTLED_EVENT, settled);
    }
  );

  it("settles dismissal from window.resize alone and ignores a transient closing reversal", () => {
    vi.useFakeTimers();
    const view = render(
      <MobileChatOverlay open type="public" aria-label="Window resize overlay">
        <form data-mobile-chat-composer>
          <textarea aria-label="Window resize draft" />
        </form>
      </MobileChatOverlay>
    );
    const overlay = view.getByLabelText("Window resize overlay");
    mockRect(overlay, () => ({ top: 0, bottom: 844, height: 844 }));
    flushFrames();
    const draft = view.getByLabelText("Window resize draft");

    act(() => draft.focus());
    visual.height = 500;
    act(() => visualListeners.get("resize")?.(new Event("resize")));
    flushFrames();
    act(() => draft.blur());
    flushNextFrame();

    visual.height = 460;
    act(() => visualListeners.get("resize")?.(new Event("resize")));
    flushFrames();
    expect(getMobileKeyboardDockingSnapshot().phase).toBe("closing");

    visual.height = 844;
    act(() => {
      window.dispatchEvent(new Event("resize"));
    });
    flushFrames();
    expect(getMobileKeyboardDockingSnapshot()).toMatchObject({
      phase: "closed",
      committedKeyboardInset: 0,
      appliedDockInset: 0
    });
    act(() => void vi.advanceTimersByTime(650));
    expect(getMobileKeyboardDockingSnapshot().phase).toBe("closed");
  });

  it("cancels stale closure on immediate refocus and keeps one session across chat text inputs", () => {
    vi.useFakeTimers();
    const view = render(
      <MobileChatOverlay open type="direct" aria-label="Refocus overlay">
        <form data-mobile-chat-composer>
          <textarea aria-label="First draft" />
          <textarea aria-label="Second draft" />
        </form>
      </MobileChatOverlay>
    );
    const overlay = view.getByLabelText("Refocus overlay");
    mockRect(overlay, () => ({ top: 0, bottom: 844, height: 844 }));
    flushFrames();
    const first = view.getByLabelText("First draft");
    const second = view.getByLabelText("Second draft");

    act(() => first.focus());
    visual.height = 500;
    act(() => visualListeners.get("resize")?.(new Event("resize")));
    flushFrames();
    const openGeneration = getMobileKeyboardDockingSnapshot().keyboardGeneration;

    act(() => {
      first.blur();
      second.focus();
    });
    flushFrames();
    expect(getMobileKeyboardDockingSnapshot()).toMatchObject({
      phase: "open",
      keyboardGeneration: openGeneration,
      activeTextElement: "direct:textarea:textarea"
    });

    act(() => second.blur());
    flushNextFrame();
    expect(getMobileKeyboardDockingSnapshot().phase).toBe("closing");
    act(() => first.focus());
    flushFrames();
    const refocused = getMobileKeyboardDockingSnapshot();
    expect(refocused.phase).toBe("open");
    expect(refocused.keyboardGeneration).toBeGreaterThan(openGeneration);
    act(() => void vi.advanceTimersByTime(650));
    expect(getMobileKeyboardDockingSnapshot().phase).toBe("open");
    expect(getMobileKeyboardDockingSnapshot().appliedDockInset).toBe(344);
  });

  it("recomputes the shared dock when Realm Chat and direct messages trade active ownership", () => {
    const panels = (publicOpen: boolean, directOpen: boolean) => (
      <>
        <MobileChatOverlay open={publicOpen} type="public" aria-label="Transition public overlay">
          <form data-mobile-chat-composer>
            <textarea aria-label="Transition public draft" defaultValue="public draft" />
          </form>
        </MobileChatOverlay>
        <MobileChatOverlay open={directOpen} type="direct" aria-label="Transition direct overlay">
          <form data-mobile-chat-composer>
            <textarea aria-label="Transition direct draft" defaultValue="direct draft" />
          </form>
        </MobileChatOverlay>
      </>
    );
    const view = render(panels(true, false));
    const publicOverlay = view.getByLabelText("Transition public overlay");
    mockRect(publicOverlay, () => ({ top: 0, bottom: 844, height: 844 }));
    flushFrames();
    const publicDraft = view.getByLabelText("Transition public draft");
    act(() => publicDraft.focus());
    visual.height = 500;
    act(() => visualListeners.get("resize")?.(new Event("resize")));
    flushFrames();
    expect(getMobileKeyboardDockingSnapshot()).toMatchObject({
      activeChatType: "public",
      appliedDockInset: 344
    });

    view.rerender(panels(false, true));
    const directOverlay = view.getByLabelText("Transition direct overlay");
    mockRect(directOverlay, () => ({ top: 0, bottom: 500, height: 500 }));
    act(() => view.getByLabelText("Transition direct draft").focus());
    flushFrames();
    expect(getMobileKeyboardDockingSnapshot()).toMatchObject({
      phase: "open",
      activeChatType: "direct",
      appliedDockInset: 0
    });

    view.rerender(panels(true, false));
    act(() => view.getByLabelText("Transition public draft").focus());
    flushFrames();
    expect(getMobileKeyboardDockingSnapshot()).toMatchObject({
      phase: "open",
      activeChatType: "public",
      appliedDockInset: 344
    });
    expect((view.getByLabelText("Transition public draft") as HTMLTextAreaElement).value)
      .toBe("public draft");
  });

  it("rejects broken visual-viewport candidates without moving the selected composer boundary", () => {
    const view = render(
      <MobileChatOverlay open type="public" aria-label="Public overlay">
        <form data-mobile-chat-composer>
          <textarea aria-label="Public draft" />
        </form>
      </MobileChatOverlay>
    );
    flushFrames();
    const draft = view.getByLabelText("Public draft");

    act(() => draft.focus());
    visual.height = 500;
    act(() => visualListeners.get("resize")?.(new Event("resize")));
    flushFrames();
    expect(getMobileKeyboardDockingSnapshot().keyboardBoundary).toBe(500);

    visual.width = 1;
    visual.height = 20;
    visual.offsetTop = 600;
    act(() => visualListeners.get("resize")?.(new Event("resize")));
    flushFrames();
    expect(getMobileKeyboardDockingSnapshot()).toMatchObject({
      rawCandidateBoundary: 620,
      candidateAccepted: false,
      candidateDecisionReason: "rejected-outside-layout-bounds",
      keyboardBoundary: 500,
      keyboardInset: 344
    });
    expect(document.documentElement.style.getPropertyValue("--mobile-chat-keyboard-boundary")).toBe("500px");
    expect(view.getByLabelText("Public overlay").getAttribute("style")).toBeNull();
    expect(view.container.querySelector(".mobile-chat-protection")).toBeTruthy();
  });

  it("keeps protection invariant across delayed, stale, scroll-only, rotation, and multi-frame closing events", () => {
    const view = render(
      <MobileChatOverlay open type="direct" aria-label="DM overlay">
        <form data-mobile-chat-composer>
          <textarea aria-label="DM draft" />
        </form>
      </MobileChatOverlay>
    );
    flushFrames();
    const draft = view.getByLabelText("DM draft");
    const expectProtectedSurface = (): void => {
      expect(view.getByLabelText("DM overlay").getAttribute("style")).toBeNull();
      expect(view.container.querySelector('[data-mobile-chat-protection="direct"]')).toBeTruthy();
      expect(document.documentElement.dataset.mobileChatProtected).toBe("true");
    };

    act(() => draft.focus());
    visual.offsetTop = 18;
    visual.offsetLeft = 4;
    visual.width = 382;
    visual.height = 500;
    act(() => visualListeners.get("resize")?.(new Event("resize")));
    flushFrames();
    expectProtectedSurface();

    visual.offsetTop = 0;
    act(() => visualListeners.get("scroll")?.(new Event("scroll")));
    flushFrames();
    expectProtectedSurface();

    visual.height = 844;
    act(() => visualListeners.get("resize")?.(new Event("resize")));
    flushFrames();
    expectProtectedSurface();

    visual.offsetTop = 22;
    visual.height = 478;
    act(() => visualListeners.get("scroll")?.(new Event("scroll")));
    flushFrames();
    expectProtectedSurface();

    Object.defineProperty(window.screen, "width", { configurable: true, value: 844 });
    Object.defineProperty(window.screen, "height", { configurable: true, value: 390 });
    act(() => {
      window.dispatchEvent(new Event("orientationchange"));
    });
    flushFrames();
    expect(getMobileKeyboardDockingSnapshot().orientation).toBe("landscape");
    expectProtectedSurface();

    act(() => draft.blur());
    for (const height of [610, 720, 844]) {
      visual.offsetTop = 0;
      visual.offsetLeft = 0;
      visual.width = 390;
      visual.height = height;
      act(() => visualListeners.get("resize")?.(new Event("resize")));
      flushFrames();
      expectProtectedSurface();
    }
  });

  it("applies identical transition continuity to direct messages and bounds diagnostic history", () => {
    setKeyboardDiagnosticsEnabled(true);
    const view = render(
      <MobileChatOverlay open type="direct" aria-label="DM overlay">
        <form data-mobile-chat-composer>
          <textarea aria-label="DM draft" defaultValue="unsent" />
          <button type="button">Send</button>
        </form>
      </MobileChatOverlay>
    );
    flushFrames();
    const draft = view.getByLabelText("DM draft") as HTMLTextAreaElement;

    act(() => draft.focus());
    visual.height = 460;
    act(() => visualListeners.get("resize")?.(new Event("resize")));
    flushFrames();
    expect(getMobileKeyboardDockingSnapshot().activeChatType).toBe("direct");

    view.rerender(
      <MobileChatOverlay open={false} type="direct" aria-label="DM overlay">
        <form data-mobile-chat-composer>
          <textarea aria-label="DM draft" defaultValue="unsent" />
          <button type="button">Send</button>
        </form>
      </MobileChatOverlay>
    );
    expect(view.queryByLabelText("DM overlay")).toBeTruthy();
    expect((view.getByLabelText("DM draft") as HTMLTextAreaElement).value).toBe("unsent");
    act(() => draft.blur());
    expect(getKeyboardDiagnosticReport().events.some((event) => event.event === "input-focus")).toBe(true);
    expect(getKeyboardDiagnosticReport().events.some((event) => event.event === "focusin")).toBe(true);
    expect(getKeyboardDiagnosticReport().events.some((event) => event.event === "input-blur")).toBe(true);
    expect(getKeyboardDiagnosticReport().events.some((event) => event.event === "focusout")).toBe(true);
    expect(getKeyboardDiagnosticReport().events.some((event) => event.event === "chat-close-request:direct")).toBe(true);

    for (let index = 0; index < 190; index += 1) {
      act(() => visualListeners.get("scroll")?.(new Event("scroll")));
    }
    expect(getKeyboardDiagnosticReport().events.length).toBeLessThanOrEqual(160);
  });
});

function flushFrames(): void {
  act(() => {
    let count = 0;
    while (frames.length > 0 && count < 50) {
      const pending = frames;
      frames = [];
      for (const callback of pending) callback(performance.now() + count * 16);
      count += 1;
    }
  });
}

function flushNextFrame(): void {
  act(() => {
    const pending = frames;
    frames = [];
    for (const callback of pending) callback(performance.now());
  });
}

function mockRect(
  element: Element,
  read: () => { top: number; bottom: number; height: number }
): void {
  vi.spyOn(element, "getBoundingClientRect").mockImplementation(() => {
    const rect = read();
    return {
      x: 0,
      y: rect.top,
      top: rect.top,
      right: 390,
      bottom: rect.bottom,
      left: 0,
      width: 390,
      height: rect.height,
      toJSON: () => ({})
    } as DOMRect;
  });
}

function mockIosEnvironment(standalone: boolean): void {
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue(
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15"
  );
  vi.spyOn(navigator, "platform", "get").mockReturnValue("iPhone");
  vi.mocked(window.matchMedia).mockImplementation((query: string) => ({
    matches: standalone && query === "(display-mode: standalone)",
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn()
  }));
}
