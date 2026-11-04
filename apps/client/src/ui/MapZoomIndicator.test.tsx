// @vitest-environment jsdom

import { act, cleanup, render, screen } from "@testing-library/react";
import type maplibregl from "maplibre-gl";
import { afterEach, describe, expect, it } from "vitest";

import { MapZoomIndicator } from "./MapZoomIndicator.js";

afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute("data-ui-profile");
});

describe("developer map zoom indicator", () => {
  it("is hidden by default and unavailable without developer access", () => {
    const map = new FakeMap(12.47);
    const view = render(
      <MapZoomIndicator map={map.asMap()} enabled={false} developerAccessEnabled />
    );

    expect(screen.queryByLabelText("Current map zoom level")).toBeNull();
    expect(map.listenerCount()).toBe(0);

    view.rerender(
      <MapZoomIndicator map={map.asMap()} enabled developerAccessEnabled={false} />
    );
    expect(screen.queryByLabelText("Current map zoom level")).toBeNull();
    expect(map.listenerCount()).toBe(0);
  });

  it("reads live zoom from the active map, updates, disables immediately, and does not intercept pointers", () => {
    const map = new FakeMap(12.47);
    const view = render(
      <MapZoomIndicator map={map.asMap()} enabled developerAccessEnabled />
    );

    const indicator = screen.getByLabelText("Current map zoom level");
    expect(indicator.textContent).toBe("Zoom: 12.47");
    expect((indicator as HTMLElement).style.pointerEvents).toBe("none");

    act(() => map.setZoom(13.125));
    expect(indicator.textContent).toBe("Zoom: 13.13");

    act(() => {
      map.setZoomSilently(14.875);
      window.dispatchEvent(new PageTransitionEvent("pageshow"));
    });
    expect(indicator.textContent).toBe("Zoom: 14.88");

    view.rerender(
      <MapZoomIndicator map={map.asMap()} enabled={false} developerAccessEnabled />
    );
    expect(screen.queryByLabelText("Current map zoom level")).toBeNull();
    expect(map.listenerCount()).toBe(0);
  });

  it("does not duplicate listeners and cleans up replaced maps and unmounts", () => {
    const firstMap = new FakeMap(9);
    const secondMap = new FakeMap(15.5);
    const view = render(
      <MapZoomIndicator map={firstMap.asMap()} enabled developerAccessEnabled />
    );

    expect(firstMap.listenerCount()).toBe(1);
    view.rerender(
      <MapZoomIndicator map={firstMap.asMap()} enabled developerAccessEnabled />
    );
    expect(firstMap.listenerCount()).toBe(1);

    view.rerender(
      <MapZoomIndicator map={secondMap.asMap()} enabled developerAccessEnabled />
    );
    expect(firstMap.listenerCount()).toBe(0);
    expect(secondMap.listenerCount()).toBe(1);
    expect(screen.getByLabelText("Current map zoom level").textContent).toBe("Zoom: 15.50");

    view.unmount();
    expect(secondMap.listenerCount()).toBe(0);
  });

  it.each(["desktop", "tablet", "phone"])("remains available in the %s layout", (profile) => {
    document.documentElement.dataset.uiProfile = profile;
    const map = new FakeMap(11);
    render(<MapZoomIndicator map={map.asMap()} enabled developerAccessEnabled />);
    expect(screen.getByLabelText("Current map zoom level").textContent).toBe("Zoom: 11.00");
  });
});

class FakeMap {
  private readonly zoomListeners = new Set<() => void>();

  constructor(private zoom: number) {}

  asMap(): maplibregl.Map {
    return this as unknown as maplibregl.Map;
  }

  getZoom(): number {
    return this.zoom;
  }

  /** Equator: ground zoom equals camera zoom. */
  getCenter(): { lat: number } {
    return { lat: 0 };
  }

  on(type: string, listener: () => void): this {
    if (type === "zoom") this.zoomListeners.add(listener);
    return this;
  }

  off(type: string, listener: () => void): this {
    if (type === "zoom") this.zoomListeners.delete(listener);
    return this;
  }

  setZoom(zoom: number): void {
    this.zoom = zoom;
    for (const listener of this.zoomListeners) listener();
  }

  setZoomSilently(zoom: number): void {
    this.zoom = zoom;
  }

  listenerCount(): number {
    return this.zoomListeners.size;
  }
}
