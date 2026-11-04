// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";

import {
  clearSafePresentationState,
  persistSafePresentationState,
  readSafePresentationState
} from "./presentationState.js";

describe("safe PWA presentation state", () => {
  beforeEach(() => localStorage.clear());

  it("round-trips only a bounded map view per player", () => {
    persistSafePresentationState("p1", {
      map: { lat: 35.0844, lon: -106.6504, zoom: 14 }
    });

    expect(readSafePresentationState("p1")).toEqual({
      version: 2,
      map: { lat: 35.0844, lon: -106.6504, zoom: 14 }
    });
    expect(readSafePresentationState("p2")).toBeNull();
  });

  it("migrates a retained v1 map while discarding its transient mobile destination", () => {
    localStorage.setItem("ash-atlas:presentation:v1:p1", JSON.stringify({
      version: 1,
      map: { lat: 35.0844, lon: -106.6504, zoom: 14 },
      mobileView: "messages"
    }));

    expect(readSafePresentationState("p1")).toEqual({
      version: 2,
      map: { lat: 35.0844, lon: -106.6504, zoom: 14 }
    });
    expect(localStorage.getItem("ash-atlas:presentation:v1:p1")).toBeNull();
    expect(JSON.parse(localStorage.getItem("ash-atlas:presentation:v2:p1")!))
      .not.toHaveProperty("mobileView");
  });

  it("bounds malformed state and clears both versions on terminal logout", () => {
    localStorage.setItem("ash-atlas:presentation:v1:p1", JSON.stringify({
      version: 1,
      map: { lat: 900, lon: 0, zoom: 14 },
      mobileView: "not-a-panel"
    }));
    expect(readSafePresentationState("p1")).toEqual({ version: 2, map: null });
    clearSafePresentationState("p1");
    expect(localStorage.length).toBe(0);
  });
});
