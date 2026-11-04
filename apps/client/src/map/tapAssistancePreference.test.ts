// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_TAP_ASSISTANCE,
  persistTapAssistancePreference,
  readTapAssistancePreference,
  tapAssistancePaddingPx
} from "./tapAssistancePreference.js";

beforeEach(() => window.localStorage.clear());

describe("tap assistance preference", () => {
  it("defaults missing and invalid preferences to standard", () => {
    expect(readTapAssistancePreference("one")).toBe(DEFAULT_TAP_ASSISTANCE);
    window.localStorage.setItem("ashAtlas.player.one.tapAssistance.v1", "extra-large");
    expect(readTapAssistancePreference("one")).toBe("standard");
  });

  it("persists separately for each player", () => {
    expect(persistTapAssistancePreference("one", "large")).toBe("large");
    expect(readTapAssistancePreference("one")).toBe("large");
    expect(readTapAssistancePreference("two")).toBe("standard");
  });

  it("maps precise, standard, and large to their exact padding", () => {
    expect(tapAssistancePaddingPx("precise")).toBe(6);
    expect(tapAssistancePaddingPx("standard")).toBe(12);
    expect(tapAssistancePaddingPx("large")).toBe(20);
  });
});
