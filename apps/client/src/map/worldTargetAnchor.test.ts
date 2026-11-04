import { describe, expect, it } from "vitest";

import {
  currentWorldTargetAnchor,
  resolveWorldTargetAnchor
} from "./worldTargetAnchor.js";

describe("resolveWorldTargetAnchor", () => {
  it("gives an explicit selection priority over active quick actions", () => {
    expect(resolveWorldTargetAnchor({
      explicit: [null, {
        position: { lat: 35.1, lon: -106.1 },
        entityId: "selected-mob"
      }],
      harvest: { position: { lat: 35.2, lon: -106.2 } },
      hostileCombat: {
        position: { lat: 35.3, lon: -106.3 },
        entityId: "combat-focus"
      }
    })).toEqual({
      position: { lat: 35.1, lon: -106.1 },
      entityId: "selected-mob"
    });
  });

  it("keeps harvest ahead of hostile combat and clears without active state", () => {
    expect(resolveWorldTargetAnchor({
      explicit: [],
      harvest: { position: { lat: 35.2, lon: -106.2 } },
      hostileCombat: { position: { lat: 35.3, lon: -106.3 } }
    })).toEqual({ position: { lat: 35.2, lon: -106.2 } });
    expect(resolveWorldTargetAnchor({
      explicit: [{ position: { lat: Number.NaN, lon: -106 } }],
      harvest: null,
      hostileCombat: null
    })).toBeNull();
  });

  it("refreshes a dynamic target from current coordinates instead of its picked snapshot", () => {
    const current = { lat: 35.4, lon: -106.4 };
    expect(currentWorldTargetAnchor(
      { lat: 35.1, lon: -106.1 },
      "moving-mob",
      (entityId) => entityId === "moving-mob" ? current : null
    )).toBe(current);
    expect(currentWorldTargetAnchor(
      { lat: 35.1, lon: -106.1 },
      "removed-mob",
      () => null
    )).toBeNull();
  });
});
