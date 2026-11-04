import type { CombatEvent, LatLon } from "@ash-atlas/shared";
import { describe, expect, it } from "vitest";

import { drawPetAbilityEffect, PetAbilityEffectState, type PetEffectCanvas, type PetEffectView } from "./petAbilityEffects.js";

const DRAKE_AT = { lat: 35, lon: -106 };
const TARGET_AT = { lat: 35.0004, lon: -106 };

function effectEvent(abilityId: string, overrides: Partial<CombatEvent> = {}): CombatEvent {
  return {
    eventId: `fx-${abilityId}`, type: "PET_ABILITY_EFFECT", tick: 1,
    sourceEntityId: "pet-companion:pet-1", targetEntityId: null,
    abilityId, position: DRAKE_AT, ...overrides
  };
}

/** Records the circles/arcs/lines a frame draws. */
function recordingCanvas() {
  const calls: Array<{ op: string; args: number[] }> = [];
  const canvas = {} as PetEffectCanvas;
  for (const op of ["circle", "arc", "moveTo", "lineTo"] as const) {
    (canvas as unknown as Record<string, unknown>)[op] = (...args: number[]) => { calls.push({ op, args }); return canvas; };
  }
  canvas.fill = () => canvas;
  canvas.stroke = () => canvas;
  return { canvas, calls };
}

// 1 m = 1 px; positions project to metres north of the drake.
const view = (reducedMotion = false): PetEffectView => ({
  project: (position: LatLon) => ({ x: 0, y: -(position.lat - DRAKE_AT.lat) * 111_195 }),
  radiusPx: (_position, radiusM) => radiusM,
  reducedMotion,
  opacity: () => 1
});

describe("pet ability effects", () => {
  it("turns a Tail Lash effect event into a ring expanding to the full ground radius, then expires", () => {
    const state = new PetAbilityEffectState();
    state.enqueue([effectEvent("tail_lash", { radiusM: 100, durationMs: 600 }), { ...effectEvent("x"), type: "DAMAGE" }], 1_000, () => null);
    expect(state.size).toBe(1);

    const early = recordingCanvas();
    state.forEach(1_060, (effect, progress) => drawPetAbilityEffect(early.canvas, effect, progress, view()));
    const late = recordingCanvas();
    state.forEach(1_550, (effect, progress) => drawPetAbilityEffect(late.canvas, effect, progress, view()));
    const ringRadius = (calls: typeof early.calls) => calls.find((call) => call.op === "circle")!.args[2]!;
    expect(ringRadius(early.calls)).toBeLessThan(25);
    expect(ringRadius(late.calls)).toBeGreaterThan(99);
    expect(late.calls.some((call) => call.op === "arc")).toBe(true);

    state.forEach(1_600, () => { throw new Error("expired effects must not draw"); });
    expect(state.size).toBe(0);
  });

  it("draws a static full-size fade with reduced motion", () => {
    const state = new PetAbilityEffectState();
    state.enqueue([effectEvent("squall_burst", { radiusM: 30, durationMs: 500 })], 0, () => null);
    const frame = recordingCanvas();
    state.forEach(50, (effect, progress) => drawPetAbilityEffect(frame.canvas, effect, progress, view(true)));
    expect(frame.calls.filter((call) => call.op === "circle").map((call) => call.args[2])).toEqual([30, 30]);
    expect(frame.calls.some((call) => call.op === "arc")).toBe(false);
  });

  it("flies a Ember Spit from the pet to the target, then bursts at the 15 m splash radius", () => {
    const state = new PetAbilityEffectState();
    state.enqueue([effectEvent("ember_spit", { position: TARGET_AT, radiusM: 15, durationMs: 800, targetEntityId: "mob:1" })], 0, () => DRAKE_AT);
    const flight = recordingCanvas();
    state.forEach(160, (effect, progress) => drawPetAbilityEffect(flight.canvas, effect, progress, view()));
    const head = flight.calls.find((call) => call.op === "circle")!;
    expect(head.args[1]).toBeLessThan(0);
    expect(head.args[1]).toBeGreaterThan(-44);
    const burst = recordingCanvas();
    state.forEach(780, (effect, progress) => drawPetAbilityEffect(burst.canvas, effect, progress, view()));
    const ring = burst.calls.find((call) => call.op === "circle")!;
    expect(ring.args[1]).toBeCloseTo(-44.5, 0);
    expect(ring.args[2]).toBeGreaterThan(14);
  });
});
