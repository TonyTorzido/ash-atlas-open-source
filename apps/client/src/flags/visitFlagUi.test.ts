import { describe, expect, it } from "vitest";

import {
  markFlagVisitCompleted,
  visitFlagFailedUiState,
  visitFlagSucceededUiState
} from "./visitFlagUi.js";

describe("visit flag UI state", () => {
  it("clears selected flag UI when Visit Flag succeeds", () => {
    expect(
      visitFlagSucceededUiState({
        selectedFlagId: "flag-1",
        flagListOpen: true
      })
    ).toEqual({
      selectedFlagId: null,
      flagListOpen: false
    });
  });

  it("keeps selected flag UI open when Visit Flag fails", () => {
    const state = {
      selectedFlagId: "flag-1",
      flagListOpen: true
    };

    expect(visitFlagFailedUiState(state)).toBe(state);
  });

  it("accepts a successful arrival exactly once", () => {
    const completed = new Set<string>();

    expect(markFlagVisitCompleted("travel-1", completed)).toBe(true);
    expect(markFlagVisitCompleted("travel-1", completed)).toBe(false);
    expect(completed).toEqual(new Set(["travel-1"]));
  });

  it("keeps successful-arrival idempotency memory bounded", () => {
    const completed = new Set(["travel-1", "travel-2"]);

    expect(markFlagVisitCompleted("travel-3", completed, 2)).toBe(true);
    expect(completed).toEqual(new Set(["travel-3"]));
  });
});
