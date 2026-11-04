import type { CombatEntitySnapshot } from "@ash-atlas/shared";
import { describe, expect, it } from "vitest";

import { playerProtectionGlowPresentation } from "./pixiOverlay.js";

const combat = (flagArrivalProtectionUntil: number | null | undefined) =>
  ({ flagArrivalProtectionUntil }) as unknown as CombatEntitySnapshot;

describe("playerProtectionGlowPresentation", () => {
  it("glows only while flag-arrival protection is active", () => {
    expect(playerProtectionGlowPresentation(combat(12_000), 10_000)).toEqual({ remainingMs: 2_000 });
    expect(playerProtectionGlowPresentation(combat(12_000), 12_000)).toBeNull();
    expect(playerProtectionGlowPresentation(combat(null), 10_000)).toBeNull();
    expect(playerProtectionGlowPresentation(combat(undefined), 10_000)).toBeNull();
    expect(playerProtectionGlowPresentation(null, 10_000)).toBeNull();
  });
});
