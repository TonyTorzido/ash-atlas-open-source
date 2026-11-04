import type { CombatEvent } from "@ash-atlas/shared";
import { describe, expect, it } from "vitest";

import {
  CLASS_ABILITY_ACTIVATION_PULSE_DURATION_MS,
  ClassAbilityActivationPulseState,
  classAbilityActivationColor
} from "./classAbilityActivationPulse.js";

function activation(
  eventId: string,
  abilityId: string,
  overrides: Partial<CombatEvent> = {}
): CombatEvent {
  return {
    eventId,
    type: "CLASS_ABILITY_ACTIVATED",
    tick: 10,
    sourceEntityId: "player-1",
    targetEntityId: null,
    abilityId,
    position: { lat: 35.0844, lon: -106.6504 },
    ...overrides
  };
}

describe("ClassAbilityActivationPulseState", () => {
  it("keeps simultaneous pulses and clones authoritative positions", () => {
    const state = new ClassAbilityActivationPulseState();
    const first = activation("ability-1", "warrior_v2_faultline", { radiusM: 300 });
    state.enqueue([
      first,
      activation("ability-2", "ninja_v2_smoke_bomb")
    ], 1_000);
    first.position!.lat = 0;

    expect(state.presentations(1_100)).toEqual([
      expect.objectContaining({
        eventId: "ability-1",
        position: { lat: 35.0844, lon: -106.6504 },
        radiusM: 300
      }),
      expect.objectContaining({ eventId: "ability-2", radiusM: null })
    ]);
  });

  it("expires pulses independently and clears immediately", () => {
    const state = new ClassAbilityActivationPulseState();
    state.enqueue([activation("ability-1", "ninja_v2_smoke_bomb")], 1_000);
    state.enqueue([activation("ability-2", "ranger_v2_marked_quarry")], 1_200);

    expect(state.presentations(
      1_000 + CLASS_ABILITY_ACTIVATION_PULSE_DURATION_MS
    ).map((pulse) => pulse.eventId)).toEqual(["ability-2"]);
    state.clear();
    expect(state.presentations(1_201)).toEqual([]);
  });

  it("maps class families and ignores unrelated or incomplete events", () => {
    expect([
      "warrior_v2_faultline",
      "ranger_v2_marked_quarry",
      "ninja_v2_shadowstep"
    ].map(classAbilityActivationColor)).toEqual([
      0xef4444,
      0x22c55e,
      0xa855f7
    ]);
    expect(classAbilityActivationColor("unknown_ability")).toBe(0xf8fafc);

    const state = new ClassAbilityActivationPulseState();
    const missingPosition = activation(
      "missing-position",
      "warrior_v2_faultline"
    );
    delete missingPosition.position;
    state.enqueue([
      activation("damage", "warrior_v2_faultline", { type: "DAMAGE" }),
      missingPosition
    ], 0);
    expect(state.presentations(0)).toEqual([]);
  });
});
