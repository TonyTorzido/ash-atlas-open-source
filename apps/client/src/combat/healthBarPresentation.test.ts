import { describe, expect, it } from "vitest";

import {
  CRITICAL_HEALTH_RATIO,
  criticalHealthFrameEmphasis,
  damagedHealthLabel,
  HEALTH_BAR_TIMING,
  HealthBarTransitionState,
  healthPercent,
  healthRatio,
  isCriticalHealth,
  wardBarPresentation,
  worldHealthBarOffsetBelowAnchor,
  worldHealthBarTone,
  WORLD_HEALTH_BAR_METRICS
} from "./healthBarPresentation.js";

describe("health bar presentation", () => {
  it("labels only damaged health with compact current/maximum values", () => {
    expect(damagedHealthLabel(14, 200)).toBe("14/200");
    expect(damagedHealthLabel(200, 200)).toBeNull();
    expect(damagedHealthLabel(undefined, 200)).toBeNull();
    expect(damagedHealthLabel(0, 200)).toBe("0/200");
  });

  it("attaches Ward after partial health and overlays the edge at full health", () => {
    expect(wardBarPresentation(60, 100, 8)).toEqual({ leftRatio: 0.6, widthRatio: 0.08 });
    expect(wardBarPresentation(100, 100, 8)).toEqual({ leftRatio: 0.92, widthRatio: 0.08 });
    expect(wardBarPresentation(50, 100, 0)).toEqual({ leftRatio: 0.5, widthRatio: 0 });
  });
  it("clamps full, partial, zero, underflow, and overheal values", () => {
    expect(healthRatio(100, 100)).toBe(1);
    expect(healthRatio(42, 100)).toBe(0.42);
    expect(healthPercent(42, 100)).toBe(42);
    expect(healthRatio(0, 100)).toBe(0);
    expect(healthRatio(-10, 100)).toBe(0);
    expect(healthRatio(140, 100)).toBe(1);
    expect(healthRatio(10, 0)).toBe(0);
    expect(healthRatio(Number.NaN, 100)).toBe(0);
  });

  it("shares one critical threshold without treating zero health as a pulsing warning", () => {
    expect(CRITICAL_HEALTH_RATIO).toBe(0.25);
    expect(isCriticalHealth(25, 100)).toBe(true);
    expect(isCriticalHealth(26, 100)).toBe(false);
    expect(isCriticalHealth(0, 100)).toBe(false);
    expect(criticalHealthFrameEmphasis(900, true)).toBe(0.68);
    expect(criticalHealthFrameEmphasis(0, false)).toBeGreaterThanOrEqual(0.5);
    expect(criticalHealthFrameEmphasis(1_200, false)).toBeLessThanOrEqual(0.78);
  });

  it("moves the green fill quickly while holding and then draining damage trail", () => {
    const state = new HealthBarTransitionState(100, 100, 0);
    expect(state.setHealth(50, 100, 0)).toBe(true);
    expect(state.snapshot()).toMatchObject({
      fillRatio: 1,
      damageTrailRatio: 1,
      damageTrailActive: true,
      targetRatio: 0.5
    });

    state.advance(HEALTH_BAR_TIMING.fillMs);
    expect(state.snapshot().fillRatio).toBe(0.5);
    expect(state.snapshot().damageTrailRatio).toBe(1);

    state.advance(HEALTH_BAR_TIMING.damageTrailHoldMs);
    expect(state.snapshot().damageTrailRatio).toBe(1);

    state.advance(
      HEALTH_BAR_TIMING.damageTrailHoldMs + HEALTH_BAR_TIMING.damageTrailDrainMs / 2
    );
    expect(state.snapshot().damageTrailRatio).toBeCloseTo(0.625, 4);

    state.advance(
      HEALTH_BAR_TIMING.damageTrailHoldMs + HEALTH_BAR_TIMING.damageTrailDrainMs
    );
    expect(state.snapshot()).toMatchObject({
      fillRatio: 0.5,
      damageTrailRatio: 0.5,
      damageTrailActive: false
    });
  });

  it("starts at the first authoritative health without presenting fake damage", () => {
    const state = new HealthBarTransitionState();
    expect(state.setInitialHealth(35, 100, 10)).toBe(true);
    expect(state.snapshot()).toEqual({
      fillRatio: 0.35,
      damageTrailRatio: 0.35,
      damageTrailActive: false,
      targetRatio: 0.35
    });
  });

  it("grows on healing without exposing a damage trail", () => {
    const state = new HealthBarTransitionState(50, 100, 0);
    state.setHealth(80, 100, 0);
    state.advance(HEALTH_BAR_TIMING.fillMs / 2);
    expect(state.snapshot().fillRatio).toBeCloseTo(0.725, 4);
    expect(state.snapshot().damageTrailRatio).toBe(state.snapshot().fillRatio);
    expect(state.snapshot().damageTrailActive).toBe(false);
    state.advance(HEALTH_BAR_TIMING.fillMs);
    expect(state.snapshot().fillRatio).toBe(0.8);
  });

  it("retargets rapid damage without stacking and always converges", () => {
    const state = new HealthBarTransitionState(100, 100, 0);
    state.setHealth(80, 100, 0);
    state.advance(80);
    state.setHealth(60, 100, 80);
    state.advance(160);
    state.setHealth(40, 100, 160);
    state.advance(
      160 + HEALTH_BAR_TIMING.damageTrailHoldMs + HEALTH_BAR_TIMING.damageTrailDrainMs
    );
    expect(state.snapshot()).toMatchObject({
      fillRatio: 0.4,
      damageTrailRatio: 0.4,
      damageTrailActive: false,
      targetRatio: 0.4
    });
  });

  it("snaps authoritative health under reduced motion", () => {
    const state = new HealthBarTransitionState(100, 100, 0);
    state.setHealth(20, 100, 10, true);
    expect(state.snapshot()).toEqual({
      fillRatio: 0.2,
      damageTrailRatio: 0.2,
      damageTrailActive: false,
      targetRatio: 0.2
    });
  });

  it("preserves distinct compact player and creature world sizes", () => {
    expect(WORLD_HEALTH_BAR_METRICS.player)
      .toMatchObject({ width: 50, height: 7, inset: 1.5, cornerCut: 1.5 });
    expect(WORLD_HEALTH_BAR_METRICS.mob)
      .toMatchObject({ width: 54, height: 7, inset: 1.5, cornerCut: 1.5 });
  });

  it("colors mob bars by server hostility, turning red once a mob engages", () => {
    const idle = { targetEntityId: null, activityState: "idle", aiPresentation: null, companion: null } as const;
    expect(worldHealthBarTone("mob", { ...idle, hostility: "aggressive" })).toBe("hostile");
    expect(worldHealthBarTone("mob", { ...idle, hostility: "passive" })).toBe("passive");
    expect(worldHealthBarTone("mob", { ...idle, hostility: "observer" })).toBe("passive");
    expect(worldHealthBarTone("mob", { ...idle, hostility: "passive", targetEntityId: "me" })).toBe("hostile");
    expect(worldHealthBarTone("mob", { ...idle, hostility: "passive", activityState: "attacking" })).toBe("hostile");
    expect(worldHealthBarTone("player", { ...idle, hostility: "aggressive" })).toBe("friendly");
  });

  it("places world health bars below the authored artwork anchor", () => {
    expect(worldHealthBarOffsetBelowAnchor(100, 0.75)).toBe(29);
    expect(worldHealthBarOffsetBelowAnchor(100, 1)).toBe(4);
    expect(worldHealthBarOffsetBelowAnchor(Number.NaN, 0.5)).toBe(4);
  });
});
