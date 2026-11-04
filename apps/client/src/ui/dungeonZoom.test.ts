// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  clampDungeonZoom,
  dungeonPinchZoom,
  dungeonWheelZoom,
  initialDungeonZoom,
  persistDungeonZoomPreference
} from "./dungeonZoom.js";

const limits = { minZoom: 0.75, defaultZoom: 1.1, maxZoom: 1.5 };

beforeEach(() => window.localStorage.clear());

describe("dungeon zoom", () => {
  it("starts at the room default and clamps a device preference for each room", () => {
    expect(initialDungeonZoom(limits)).toBe(1.1);
    persistDungeonZoomPreference(1.4);
    expect(initialDungeonZoom({ ...limits, maxZoom: 1.2 })).toBe(1.2);
    expect(clampDungeonZoom(Number.NaN, limits)).toBe(1.1);
  });

  it("clamps wheel and pinch changes without introducing translation", () => {
    expect(dungeonWheelZoom(1, -10_000, limits)).toBe(1.5);
    expect(dungeonWheelZoom(1, 10_000, limits)).toBe(0.75);
    expect(dungeonPinchZoom(1, 100, 140, limits)).toBe(1.4);
    expect(dungeonPinchZoom(1, 100, 20, limits)).toBe(0.75);
  });

  it("keeps working when local storage is unavailable", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
    expect(initialDungeonZoom(limits)).toBe(1.1);
    expect(() => persistDungeonZoomPreference(1.2)).not.toThrow();
  });
});
