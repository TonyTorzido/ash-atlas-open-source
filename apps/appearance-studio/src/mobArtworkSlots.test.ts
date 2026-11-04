import { CREATURE_BOOK_ROSTER } from "@ash-atlas/shared";
import { describe, expect, it } from "vitest";

import { MOB_ARTWORK_SLOTS, mobArtworkSlotForPath } from "./mobArtworkSlots.js";

describe("Appearance Studio mob artwork slots", () => {
  it("has exact roster parity and resolves each slot by its production PNG path", () => {
    expect(MOB_ARTWORK_SLOTS.map((slot) => slot.archetypeKey))
      .toEqual(CREATURE_BOOK_ROSTER.map((entry) => entry.archetypeKey));
    for (const slot of MOB_ARTWORK_SLOTS) {
      expect(mobArtworkSlotForPath(slot.normalPath)?.slot).toBe(slot);
      expect(mobArtworkSlotForPath(`apps/client/src/assets/mobs/ashen/${slot.archetypeKey}.png`)).toBeNull();
    }
  });
});
