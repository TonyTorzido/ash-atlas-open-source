import { describe, expect, it } from "vitest";

import { UNIVERSAL_TAUNT_PULSE_DURATION_MS, type CombatEvent } from "@ash-atlas/shared";

import { TauntPulseState } from "./tauntPulse.js";

function activation(overrides: Partial<CombatEvent> = {}): CombatEvent {
  return {
    eventId: "taunt-1",
    type: "TAUNT_ACTIVATED",
    tick: 10,
    sourceEntityId: "player-1",
    targetEntityId: null,
    position: { lat: 35.0844, lon: -106.6504 },
    radiusM: 75,
    ...overrides
  };
}

describe("TauntPulseState", () => {
  it("uses the authoritative activation radius and frozen position", () => {
    const state = new TauntPulseState();
    const event = activation();
    state.enqueue([event], "player-1", 1_000);
    event.position!.lat = 0;

    expect(state.presentation(1_100)).toMatchObject({
      eventId: "taunt-1",
      position: { lat: 35.0844, lon: -106.6504 },
      radiusM: 75
    });
  });

  it("does not create a success pulse for failures or another player's activation", () => {
    const state = new TauntPulseState();
    state.enqueue([
      {
        eventId: "damage-1",
        type: "DAMAGE",
        tick: 10,
        sourceEntityId: "mob-1",
        targetEntityId: "player-1",
        amount: 5,
        currentHealth: 95
      },
      activation({ sourceEntityId: "player-2" })
    ], "player-1", 1_000);

    expect(state.presentation(1_000)).toBeNull();
  });

  it("replaces repeated pulses and cleans up after the brief duration", () => {
    const state = new TauntPulseState();
    state.enqueue([activation()], "player-1", 1_000);
    state.enqueue([activation({ eventId: "taunt-2", radiusM: 90 })], "player-1", 1_200);

    expect(state.presentation(1_200)).toMatchObject({ eventId: "taunt-2", radiusM: 90, progress: 0 });
    expect(state.presentation(1_200 + UNIVERSAL_TAUNT_PULSE_DURATION_MS - 1)).not.toBeNull();
    expect(state.presentation(1_200 + UNIVERSAL_TAUNT_PULSE_DURATION_MS)).toBeNull();
    expect(state.presentation(10_000)).toBeNull();
  });

  it("clears immediately", () => {
    const state = new TauntPulseState();
    state.enqueue([activation()], "player-1", 0);
    state.clear();
    expect(state.presentation(0)).toBeNull();
  });
});
