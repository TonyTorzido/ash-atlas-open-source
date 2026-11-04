import { describe, expect, it, vi } from "vitest";

import {
  PermanentResourceLifecycleService,
  PermanentResourceRegistry,
  permanentResourceYield,
  STONE_MINE_DEFINITION,
  SULFUR_MINE_DEFINITION
} from "./permanentResourceLifecycle.js";

describe("permanent-resource registry", () => {
  it("registers Sulfur with the canonical mine yield and regeneration", () => {
    expect(SULFUR_MINE_DEFINITION).toMatchObject({
      nodeType: "sulfur_mine",
      populationEntityKind: "sulfur",
      populationArchetype: "sulfur_mine",
      yieldedItem: "sulfur",
      yieldQuantity: 1,
      regenerationMs: 5 * 60 * 60_000 + 50 * 60_000,
      timerProfessionId: "miner",
      timerVisibilityRank: 2
    });
  });

  it("accepts a non-production iron fixture without stone-specific lifecycle code", () => {
    const ironFixture = {
      nodeType: "iron_mine",
      populationEntityKind: "iron",
      populationArchetype: "iron_mine",
      yieldedItem: "ore",
      yieldQuantity: 2,
      regenerationMs: 7 * 60 * 60_000,
      timerProfessionId: "miner",
      timerVisibilityRank: 3
    } as const;
    const registry = new PermanentResourceRegistry([
      STONE_MINE_DEFINITION,
      ironFixture
    ]);

    expect(registry.requireDefinition("iron_mine")).toEqual(ironFixture);
    expect(registry.requireDefinition("stone_mine").regenerationMs)
      .toBe(5 * 60 * 60_000 + 50 * 60_000);
  });

  it("rejects unsupported permanent-resource projection definitions", () => {
    expect(() => permanentResourceYield("stone_mine", "stone", 2))
      .toThrow("stone_mine projection does not match its permanent-resource definition");
    expect(() => permanentResourceYield("stone_mine", "wood", 1))
      .toThrow("stone_mine projection does not match its permanent-resource definition");
  });

  it("publishes a legacy stone projection with the current reward", () => {
    const lifecycle = new PermanentResourceLifecycleService({} as never);
    const row = {
      id: "00000000-0000-4000-8000-000000000001",
      node_type: "stone_mine" as const,
      region_code: "test",
      lat: 35,
      lon: -106,
      yield_item_id: "stone" as const,
      yield_quantity: 1,
      harvest_revision: 4,
      ready_at: "2026-07-29T05:50:00.000Z",
      public_state: "depleted" as const,
      canonical_state: "harvested" as const,
      canonical_actor_player_id: "player-1",
      canonical_harvested_at: "2026-07-29T00:00:00.000Z",
      population_v2_entity_id:
        "00000000-0000-4000-8000-000000000001",
      physical_population_zone_v2_id: "ppz2-eag1/000/000",
      population_v2_state_revision: 4,
      population_cutover_revision: 1,
      population_v2_suppressed: false
    };

    expect(lifecycle.publicNode({ ...row, timer_visible: true }))
      .toMatchObject({
        state: "depleted",
        authorityRevision: 8,
        yieldQuantity: 3,
        readyAt: "2026-07-29T05:50:00.000Z",
        timerVisibility: "visible"
      });
    expect(lifecycle.publicNode({ ...row, timer_visible: false }))
      .toMatchObject({
        state: "depleted",
        authorityRevision: 8,
        yieldQuantity: 3,
        readyAt: null,
        timerVisibility: "redacted"
      });
  });

  it("diagnoses an impossible null-deadline life and never presents projection readiness", () => {
    const warn = vi.fn();
    const lifecycle = new PermanentResourceLifecycleService(
      {} as never,
      undefined,
      { warn } as never
    );
    const node = lifecycle.publicNode({
      id: "00000000-0000-4000-8000-000000000001",
      node_type: "stone_mine",
      region_code: "test",
      lat: 35,
      lon: -106,
      yield_item_id: "stone",
      yield_quantity: 1,
      harvest_revision: 4,
      ready_at: null,
      public_state: "ready",
      canonical_state: "harvested",
      canonical_actor_player_id: "player-1",
      canonical_harvested_at: null,
      timer_visible: true,
      population_v2_entity_id:
        "00000000-0000-4000-8000-000000000001",
      physical_population_zone_v2_id: "ppz2-eag1/000/000",
      population_v2_state_revision: 4,
      population_cutover_revision: 1,
      population_v2_suppressed: false
    });

    expect(node).toMatchObject({
      state: "depleted",
      readyAt: null,
      timerVisibility: "visible"
    });
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "canonical-lifecycle-invalid",
        lifecycleIssue: "harvested-without-harvest-timestamp"
      }),
      "impossible canonical permanent resource state"
    );
  });
});
