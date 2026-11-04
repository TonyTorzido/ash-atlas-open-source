// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";

const mapHarness = vi.hoisted(() => ({
  options: [] as Array<Record<string, unknown>>,
  controls: [] as string[]
}));

vi.mock("maplibre-gl", () => {
  class MapMock {
    doubleClickZoom = { disable: vi.fn() };
    touchZoomRotate = { disableRotation: vi.fn() };
    private readonly container: HTMLElement;
    constructor(options: Record<string, unknown>) {
      mapHarness.options.push(options);
      this.container = options.container as HTMLElement;
      if (options.attributionControl !== false) {
        const container = options.container as HTMLElement;
        const attribution = document.createElement("div");
        attribution.className = "maplibregl-ctrl-attrib";
        const button = document.createElement("button");
        button.className = "maplibregl-ctrl-attrib-button";
        attribution.append(button);
        container.append(attribution);
      }
    }
    getContainer(): HTMLElement { return this.container; }
    getZoom(): number { return 0; }
    addControl(control: object): this {
      mapHarness.controls.push(control.constructor.name);
      return this;
    }
    on(): this { return this; }
  }
  class NavigationControlMock {}
  class AttributionControlMock {}
  return {
    default: {
      Map: MapMock,
      NavigationControl: NavigationControlMock,
      AttributionControl: AttributionControlMock,
      addProtocol: vi.fn()
    }
  };
});

import { createMap } from "./createMap.js";
import { createWorldMap } from "./worldMap.js";

beforeEach(() => {
  mapHarness.options.length = 0;
  mapHarness.controls.length = 0;
  document.body.replaceChildren();
});

describe("MapLibre attribution control", () => {
  it("never constructs attribution UI for phone, desktop, recreation, or the alternate world map", () => {
    const phone = document.createElement("div");
    const desktop = document.createElement("div");
    const recreated = document.createElement("div");
    const world = document.createElement("div");
    document.body.append(phone, desktop, recreated, world);
    const config = {
      serverHttpBase: "http://localhost",
      serverWsBase: "ws://localhost",
      worldApiBase: "http://localhost/world",
      osmTileUrl: "/tiles/{z}/{x}/{y}.png",
      googleClientId: "",
      buildSha: null,
      runtimeIdentity: null
    };

    createMap(phone, config);
    createMap(desktop, config);
    createMap(recreated, config);
    createWorldMap(world, { lat: 0, lon: 0 });

    expect(mapHarness.options).toHaveLength(4);
    expect(mapHarness.options.every((options) => options.attributionControl === false)).toBe(true);
    expect(mapHarness.controls).toEqual([
      "NavigationControlMock",
      "NavigationControlMock",
      "NavigationControlMock",
      "NavigationControlMock"
    ]);
    expect(document.querySelector(".maplibregl-ctrl-attrib")).toBeNull();
    expect(document.querySelector(".maplibregl-ctrl-attrib-button")).toBeNull();
    expect(document.querySelector("[href*='openstreetmap.org']")).toBeNull();
  });

  it("uses retained authority instead of an authored city fallback", () => {
    const container = document.createElement("div");
    const config = {
      serverHttpBase: "http://localhost",
      serverWsBase: "ws://localhost",
      worldApiBase: "http://localhost/world",
      osmTileUrl: "/tiles/{z}/{x}/{y}.png",
      googleClientId: "",
      buildSha: null,
      runtimeIdentity: null
    };

    createMap(container, config, undefined, { lat: 19.4326, lon: -99.1332 });
    createMap(container, config);

    expect(mapHarness.options[0]?.center).toEqual([-99.1332, 19.4326]);
    expect(mapHarness.options[1]).not.toHaveProperty("center");
  });

  it("gives World Map drags a faster pan response", () => {
    createWorldMap(document.createElement("div"), { lat: 35, lon: -106 });

    expect(mapHarness.options[0]?.dragPan).toEqual({
      linearity: 0.5,
      maxSpeed: 2200,
      deceleration: 1800
    });
  });
});
