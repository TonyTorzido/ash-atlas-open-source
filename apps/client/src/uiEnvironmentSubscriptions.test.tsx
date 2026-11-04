// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useRef } from "react";

import { resetMobileKeyboardDockingForTests } from "./mobileKeyboardDocking.js";
import { subscribeUiEnvironment, UiEnvironmentProvider, useUiEnvironment } from "./uiEnvironment.js";

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  resetMobileKeyboardDockingForTests();
  vi.restoreAllMocks();
});

describe("UI environment subscriptions", () => {
  it("keeps high-frequency focus and visual viewport events out of the game-wide environment", () => {
    const media = { matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() };
    const visual = {
      width: 390,
      height: 844,
      offsetTop: 0,
      offsetLeft: 0,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    };
    Object.defineProperty(window, "matchMedia", { configurable: true, value: vi.fn(() => media) });
    Object.defineProperty(window, "visualViewport", { configurable: true, value: visual });
    const add = vi.spyOn(window, "addEventListener");
    const remove = vi.spyOn(window, "removeEventListener");
    const onChange = vi.fn();
    const unsubscribe = subscribeUiEnvironment(onChange);

    expect(add.mock.calls.filter(([name]) => name === "resize")).toHaveLength(1);
    expect(add.mock.calls.filter(([name]) => name === "orientationchange")).toHaveLength(1);
    expect(add.mock.calls.filter(([name]) => name === "ashatlas:mobile-keyboard-settled")).toHaveLength(1);
    expect(add.mock.calls.filter(([name]) => name === "focusin")).toHaveLength(0);
    expect(add.mock.calls.filter(([name]) => name === "focusout")).toHaveLength(0);
    expect(visual.addEventListener).not.toHaveBeenCalled();
    expect(media.addEventListener).toHaveBeenCalledTimes(3);

    unsubscribe();
    expect(remove.mock.calls.filter(([name]) => name === "resize")).toHaveLength(1);
    expect(remove.mock.calls.filter(([name]) => name === "orientationchange")).toHaveLength(1);
    expect(remove.mock.calls.filter(([name]) => name === "ashatlas:mobile-keyboard-settled")).toHaveLength(1);
    expect(visual.removeEventListener).not.toHaveBeenCalled();
    expect(media.removeEventListener).toHaveBeenCalledTimes(3);
  });

  it("does not rerender the whole game for visual viewport keyboard frames", () => {
    const visualListeners = new Map<string, EventListener>();
    const visual = {
      width: 390,
      height: 844,
      offsetTop: 0,
      offsetLeft: 0,
      addEventListener: vi.fn((name: string, listener: EventListener) => visualListeners.set(name, listener)),
      removeEventListener: vi.fn()
    };
    installPhoneEnvironment(visual);
    let renders = 0;
    const Probe = (): React.JSX.Element => {
      const value = useUiEnvironment();
      renders += 1;
      return <span>{value.profile}:{value.orientation}:{value.visualViewport?.height}</span>;
    };
    render(<UiEnvironmentProvider><Probe /></UiEnvironmentProvider>);
    expect(screen.getByText("phone:portrait:844")).toBeTruthy();
    expect(renders).toBe(1);

    visual.height = 360;
    act(() => visualListeners.get("resize")?.(new Event("resize")));
    expect(screen.getByText("phone:portrait:844")).toBeTruthy();
    expect(renders).toBe(1);
  });

  it("suppresses standalone window resize churn while a text entry transition is active", () => {
    const visual = {
      width: 390,
      height: 844,
      offsetTop: 0,
      offsetLeft: 0,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    };
    installPhoneEnvironment(visual);
    const Probe = (): React.JSX.Element => {
      const value = useUiEnvironment();
      return <textarea aria-label="Chat entry" data-height={value.viewport.height} />;
    };
    render(<UiEnvironmentProvider><Probe /></UiEnvironmentProvider>);
    const entry = screen.getByLabelText("Chat entry");
    expect(entry.getAttribute("data-height")).toBe("844");

    act(() => entry.focus());
    expect(document.documentElement.dataset.mobileKeyboardPhase).toBe("opening");
    Object.defineProperty(window, "innerHeight", { configurable: true, writable: true, value: 360 });
    act(() => {
      window.dispatchEvent(new Event("resize"));
    });

    expect(entry.getAttribute("data-height")).toBe("844");
    expect(document.documentElement.dataset.virtualKeyboard).toBe("open");
  });

  it("updates compact and wide modes without remounting and persists each manual preference", () => {
    const visual = {
      width: 390,
      height: 844,
      offsetTop: 0,
      offsetLeft: 0,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    };
    installPhoneEnvironment(visual);
    let mounts = 0;
    const Probe = (): React.JSX.Element => {
      const value = useUiEnvironment();
      const mounted = useRef(false);
      if (!mounted.current) {
        mounted.current = true;
        mounts += 1;
      }
      return (
        <div>
          <output>{value.layoutMode}:{value.layoutPreference}:{value.inputMode}</output>
          <button onClick={() => value.setLayoutPreference("compact")}>Compact</button>
          <button onClick={() => value.setLayoutPreference("wide")}>Wide</button>
          <button onClick={() => value.setLayoutPreference("automatic")}>Automatic</button>
        </div>
      );
    };
    render(<UiEnvironmentProvider><Probe /></UiEnvironmentProvider>);
    expect(screen.getByText("compact:automatic:touch")).toBeTruthy();

    Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 1024 });
    Object.defineProperty(window, "innerHeight", { configurable: true, writable: true, value: 768 });
    act(() => {
      window.dispatchEvent(new Event("resize"));
    });
    expect(screen.getByText("wide:automatic:touch")).toBeTruthy();
    expect(mounts).toBe(1);

    fireEvent.click(screen.getByRole("button", { name: "Compact" }));
    expect(screen.getByText("compact:compact:touch")).toBeTruthy();
    expect(window.localStorage.getItem("ashAtlas.ui.layout")).toBe("compact");
    fireEvent.click(screen.getByRole("button", { name: "Wide" }));
    expect(screen.getByText("wide:wide:touch")).toBeTruthy();
    expect(window.localStorage.getItem("ashAtlas.ui.layout")).toBe("wide");
    fireEvent.click(screen.getByRole("button", { name: "Automatic" }));
    expect(screen.getByText("wide:automatic:touch")).toBeTruthy();
    expect(window.localStorage.getItem("ashAtlas.ui.layout")).toBeNull();
    expect(mounts).toBe(1);
  });

  it("updates touch to hybrid when a fine pointer appears and removes every media listener", () => {
    let finePointer = false;
    const listeners = new Map<string, EventListener>();
    const media = new Map<string, Array<{
      matches: boolean;
      addEventListener: ReturnType<typeof vi.fn>;
      removeEventListener: ReturnType<typeof vi.fn>;
    }>>();
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1024 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 768 });
    Object.defineProperty(navigator, "maxTouchPoints", { configurable: true, value: 5 });
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn((query: string) => {
        const item = {
          get matches() {
            return query === "(any-pointer: fine)"
              ? finePointer
              : query === "(any-pointer: coarse)";
          },
          addEventListener: vi.fn((_name: string, listener: EventListener) => listeners.set(query, listener)),
          removeEventListener: vi.fn()
        };
        media.set(query, [...(media.get(query) ?? []), item]);
        return item;
      })
    });
    const Probe = (): React.JSX.Element => {
      const value = useUiEnvironment();
      return <span>{value.layoutMode}:{value.inputMode}</span>;
    };
    const view = render(<UiEnvironmentProvider><Probe /></UiEnvironmentProvider>);
    expect(screen.getByText("wide:touch")).toBeTruthy();

    finePointer = true;
    act(() => listeners.get("(any-pointer: fine)")?.(new Event("change")));
    expect(screen.getByText("wide:hybrid")).toBeTruthy();

    view.unmount();
    for (const query of [
      "(display-mode: standalone)",
      "(any-pointer: fine)",
      "(any-pointer: coarse)"
    ]) {
      expect(media.get(query)?.some((item) =>
        item.removeEventListener.mock.calls.length === 1
      )).toBe(true);
    }
  });
});

function installPhoneEnvironment(visual: {
  width: number;
  height: number;
  offsetTop: number;
  offsetLeft: number;
  addEventListener: ReturnType<typeof vi.fn>;
  removeEventListener: ReturnType<typeof vi.fn>;
}): void {
  Object.defineProperty(window, "visualViewport", { configurable: true, value: visual });
  Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: 390 });
  Object.defineProperty(window, "innerHeight", { configurable: true, writable: true, value: 844 });
  Object.defineProperty(window.screen, "width", { configurable: true, value: 390 });
  Object.defineProperty(window.screen, "height", { configurable: true, value: 844 });
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn((query: string) => ({
      matches:
        query === "(display-mode: standalone)" ||
        query === "(any-pointer: coarse)",
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    }))
  });
  Object.defineProperty(navigator, "maxTouchPoints", { configurable: true, value: 5 });
}
