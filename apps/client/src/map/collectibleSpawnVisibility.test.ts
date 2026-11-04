import { describe, expect, it } from "vitest";

import {
  COLLECTIBLE_SPAWN_FADE_MS,
  CollectibleFirstAppearanceTracker
} from "./collectibleSpawnVisibility.js";

describe("collectible first-appearance visibility", () => {
  it("smoothly fades a newly observed authoritative id", () => {
    const tracker = new CollectibleFirstAppearanceTracker();
    tracker.observeAuthoritativeIds(["mine"], 1_000);
    expect(tracker.alphaFor("mine", 1_000, false)).toBe(0);
    expect(tracker.alphaFor(
      "mine",
      1_000 + COLLECTIBLE_SPAWN_FADE_MS / 2,
      false
    )).toBeCloseTo(0.5);
    expect(tracker.alphaFor(
      "mine",
      1_000 + COLLECTIBLE_SPAWN_FADE_MS,
      false
    )).toBe(1);
  });

  it("does not restart a stable id across repeated authoritative observations", () => {
    const tracker = new CollectibleFirstAppearanceTracker();
    tracker.observeAuthoritativeIds(["mine"], 1_000);
    tracker.observeAuthoritativeIds(["mine"], 1_250);
    expect(tracker.alphaFor("mine", 1_300, false)).toBeCloseTo(0.5);
  });

  it("fades an id again after authoritative removal and re-add", () => {
    const tracker = new CollectibleFirstAppearanceTracker();
    tracker.observeAuthoritativeIds(["mine"], 1_000);
    tracker.observeAuthoritativeIds([], 2_000);
    tracker.observeAuthoritativeIds(["mine"], 3_000);
    expect(tracker.alphaFor("mine", 3_000, false)).toBe(0);
  });

  it("is immediately opaque and inactive for reduced motion", () => {
    const tracker = new CollectibleFirstAppearanceTracker();
    tracker.observeAuthoritativeIds(["mine"], 1_000);
    expect(tracker.alphaFor("mine", 1_000, true)).toBe(1);
    expect(tracker.hasActiveFade(1_000, true)).toBe(false);
  });
});
