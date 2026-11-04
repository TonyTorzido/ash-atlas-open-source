// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";

import {
  normalizeMobileDefaultZoom,
  persistMobileDefaultZoom,
  readMobileDefaultZoom
} from "./mobileZoomPreference.js";

beforeEach(() => window.localStorage.clear());

describe("mobile default zoom preference", () => {
  it("defaults to 15 and persists separately for each player", () => {
    expect(readMobileDefaultZoom("one")).toBe(15);
    expect(persistMobileDefaultZoom("one", 14.75)).toBe(14.75);
    expect(readMobileDefaultZoom("one")).toBe(14.75);
    expect(readMobileDefaultZoom("two")).toBe(15);
  });

  it("normalizes invalid and out-of-range values", () => {
    expect(normalizeMobileDefaultZoom(Number.NaN)).toBe(15);
    expect(normalizeMobileDefaultZoom(1)).toBe(2);
    expect(normalizeMobileDefaultZoom(18)).toBe(18);
    expect(normalizeMobileDefaultZoom(19)).toBe(18);
    expect(normalizeMobileDefaultZoom(15.123)).toBe(15.12);
  });

  it("accepts and restores the new maximum zoom preference", () => {
    expect(persistMobileDefaultZoom("one", 18)).toBe(18);
    expect(readMobileDefaultZoom("one")).toBe(18);
  });

});
