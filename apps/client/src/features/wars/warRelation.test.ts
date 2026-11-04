import { describe, expect, it } from "vitest";

import type { OrganizationWar } from "../../ui/OrganizationWarsSection.js";
import { isAtWarWith } from "./warRelation.js";

const war = (kind: "city" | "kingdom", id: string): OrganizationWar => ({
  warId: "w", own: { kind, id: "own", name: "Own" }, enemy: { kind, id, name: "Enemy" },
  aggressor: "own", declaredVia: "settings", declaredAt: "2026-01-01T00:00:00.000Z", peaceOffer: null, canAct: true
});

describe("isAtWarWith", () => {
  it("matches the enemy kingdom or city of an active war", () => {
    const kingdom = { id: "k1", name: "K" };
    expect(isAtWarWith([war("kingdom", "k1")], { kingdom, settlement: null })).toBe(true);
    expect(isAtWarWith([war("city", "c1")], { kingdom: null, settlement: { id: "c1", name: "C" } })).toBe(true);
    expect(isAtWarWith([war("kingdom", "k2")], { kingdom, settlement: null })).toBe(false);
    expect(isAtWarWith([], { kingdom, settlement: null })).toBe(false);
  });
});
