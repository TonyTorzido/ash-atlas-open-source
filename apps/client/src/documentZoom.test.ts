// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { preventDocumentGestureZoom, preventDocumentWheelZoom } from "./documentZoom.js";

beforeEach(() => {
  vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
  vi.stubGlobal("navigator", Object.assign(Object.create(navigator), { maxTouchPoints: 0 }));
  document.body.innerHTML = '<div class="map-root maplibregl-map"><div class="maplibregl-canvas-container"><canvas class="maplibregl-canvas"></canvas></div><button class="maplibregl-ctrl">Zoom</button></div><div class="gameplay-status-stack" id="hud"></div><div role="dialog"><p id="panel-text">Menu</p></div><div id="opaque" style="background: rgb(10, 10, 10)">Panel</div>';
  document.addEventListener("gesturestart", preventDocumentGestureZoom, { passive: false });
  document.addEventListener("gesturechange", preventDocumentGestureZoom, { passive: false });
  document.addEventListener("wheel", preventDocumentWheelZoom, { passive: false });
});

afterEach(() => {
  document.removeEventListener("gesturestart", preventDocumentGestureZoom);
  document.removeEventListener("gesturechange", preventDocumentGestureZoom);
  document.removeEventListener("wheel", preventDocumentWheelZoom);
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe.each(["gesturestart", "gesturechange"])("document %s guard", (type) => {
  it("allows Mac trackpad gestures on the map canvas to produce native pinch wheel input", () => {
    const event = new Event(type, { bubbles: true, cancelable: true });
    document.querySelector("canvas")!.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });

  it.each(["[role=dialog]", "#panel-text", "button", "#opaque"])("blocks page zoom over %s", (selector) => {
    const event = new Event(type, { bubbles: true, cancelable: true });
    document.querySelector(selector)!.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it("allows gestures over a transparent HUD layer above the map", () => {
    const event = new Event(type, { bubbles: true, cancelable: true });
    document.querySelector("#hud")!.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });

  it("blocks gestures on a map behind an inert interface", () => {
    document.querySelector(".map-root")!.setAttribute("inert", "");
    const event = new Event(type, { bubbles: true, cancelable: true });
    document.querySelector("canvas")!.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it.each([
    ["iPhone", 5], ["iPad", 5], ["MacIntel", 5], ["Win32", 0]
  ])("keeps the gesture guard for %s with %i touch points", (platform, maxTouchPoints) => {
    vi.stubGlobal("navigator", { platform, maxTouchPoints });
    const event = new Event(type, { bubbles: true, cancelable: true });
    document.querySelector("canvas")!.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });
});

describe("document wheel guard", () => {
  it.each(["canvas", "[role=dialog]"])("cancels ctrl-wheel page zoom after %s receives the event", (selector) => {
    const target = document.querySelector(selector)!;
    const received = vi.fn((event: Event) => expect(event.defaultPrevented).toBe(false));
    const propagated = vi.fn();
    target.addEventListener("wheel", received);
    window.addEventListener("wheel", propagated, { once: true });
    const event = new WheelEvent("wheel", { bubbles: true, cancelable: true, ctrlKey: true, deltaY: -10 });
    target.dispatchEvent(event);
    expect(received).toHaveBeenCalledOnce();
    expect(propagated).toHaveBeenCalledOnce();
    expect(event.defaultPrevented).toBe(true);
  });

  it("leaves ctrl-wheel page zoom to the browser in desktop presentation", () => {
    document.documentElement.dataset.presentation = "desktop";
    const event = new WheelEvent("wheel", { bubbles: true, cancelable: true, ctrlKey: true, deltaY: -10 });
    document.querySelector("[role=dialog]")!.dispatchEvent(event);
    delete document.documentElement.dataset.presentation;
    expect(event.defaultPrevented).toBe(false);
  });

  it.each(["canvas", "[role=dialog]"])("preserves ordinary wheel input on %s", (selector) => {
    const event = new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: 100 });
    document.querySelector(selector)!.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });

  describe("gameplay map routing", () => {
    const wheel = (extra: WheelEventInit = {}) =>
      new WheelEvent("wheel", { bubbles: true, cancelable: true, ctrlKey: true, deltaY: -10, clientX: 40, clientY: 50, ...extra });

    it.each(["desktop", undefined])("forwards ctrl-wheel over a transparent HUD layer to the map and cancels page zoom (%s)", (presentation) => {
      if (presentation) document.documentElement.dataset.presentation = presentation;
      const received = vi.fn();
      document.querySelector(".maplibregl-canvas-container")!.addEventListener("wheel", received);
      const event = wheel();
      document.querySelector("#hud")!.dispatchEvent(event);
      delete document.documentElement.dataset.presentation;
      expect(event.defaultPrevented).toBe(true);
      expect(received).toHaveBeenCalledOnce();
      const forwarded = received.mock.calls[0]![0] as WheelEvent;
      expect([forwarded.deltaY, forwarded.clientX, forwarded.clientY, forwarded.ctrlKey]).toEqual([-10, 40, 50, true]);
    });

    it("cancels but does not duplicate ctrl-wheel already targeting the map", () => {
      document.documentElement.dataset.presentation = "desktop";
      const received = vi.fn();
      document.querySelector(".maplibregl-canvas-container")!.addEventListener("wheel", received);
      const event = wheel();
      document.querySelector("canvas")!.dispatchEvent(event);
      delete document.documentElement.dataset.presentation;
      expect(event.defaultPrevented).toBe(true);
      expect(received).toHaveBeenCalledOnce();
    });

    it("keeps desktop browser zoom over panels and over an inert map", () => {
      document.documentElement.dataset.presentation = "desktop";
      const panel = wheel();
      document.querySelector("#panel-text")!.dispatchEvent(panel);
      document.querySelector(".map-root")!.setAttribute("inert", "");
      const inert = wheel();
      document.querySelector("#hud")!.dispatchEvent(inert);
      delete document.documentElement.dataset.presentation;
      expect(panel.defaultPrevented).toBe(false);
      expect(inert.defaultPrevented).toBe(false);
    });
  });
});
