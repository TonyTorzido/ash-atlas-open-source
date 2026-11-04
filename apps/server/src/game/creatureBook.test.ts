import { describe, expect, it, vi } from "vitest";
import type pg from "pg";

import { CREATURE_BOOK_ROSTER, PLANT_BOOK_ROSTER, parseClientMessage } from "@ash-atlas/shared";
import {
  CreatureBookService,
  recordCreatureBookKillInTransaction,
  recordCreatureBookPlantHarvestInTransaction
} from "./creatureBook.js";

describe("CreatureBookService", () => {
  it("keeps the fixed roster redacted until sighted and unlocks habitat from kills", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [
        { mob_archetype: "deer", count: "1" },
        { mob_archetype: "fire_bird", count: "1" }
      ] })
      .mockResolvedValueOnce({ rows: [{ mob_archetype: "deer", count: "100" }] })
      .mockResolvedValueOnce({ rows: [{ mob_archetype: "deer", item_id: "deer_hide", count: "25" }] })
      .mockResolvedValueOnce({ rows: [{ plant_key: "flax", count: "5" }] })
      .mockResolvedValueOnce({ rows: [{ count: "7" }] });
    const service = new CreatureBookService({ query } as unknown as pg.Pool);

    const snapshot = await service.snapshot("player-1");

    expect(snapshot.slots).toHaveLength(214);
    expect(snapshot.slots.map(({ bookOrder }) => bookOrder)).toEqual(
      CREATURE_BOOK_ROSTER.map(({ bookOrder }) => bookOrder)
    );
    expect(snapshot.slots[0]).toMatchObject({
      unlocked: true,
      archetypeKey: "deer",
      ashenUnlocked: false,
      habitat: {
        progress: 100,
        threshold: 100,
        // Deer no longer spawns on the overworld, so it has no habitat once unlocked.
        restrictions: [],
        active: "any_time"
      },
      killCount: 100
    });
    expect(snapshot.slots[0]?.unlocked && snapshot.slots[0].drops).toContainEqual({
      slotOrder: expect.any(Number),
      observed: true,
      itemId: "deer_hide",
      displayName: "Deer Hide",
      occurrenceCount: 25,
      observedRate: 0.25
    });
    expect(snapshot.slots[1]).toEqual({ bookOrder: 1, unlocked: false });
    expect(snapshot.slots[48]).toMatchObject({
      unlocked: true,
      archetypeKey: "fire_bird",
      ashenUnlocked: false,
      habitat: { kind: "legendary", habitat: "N/A", active: "any_time" },
      killCount: null,
      drops: [{ slotOrder: 0, observed: false }]
    });
    expect(snapshot.plants).toEqual([{
      bookOrder: PLANT_BOOK_ROSTER[0].bookOrder,
      unlocked: true,
      plantKey: "flax",
      name: "Wild Flax",
      rarity: "common",
      active: 7,
      totalHarvests: 5,
      habitat: {
        kind: "natural",
        progress: 5,
        threshold: 5,
        restrictions: PLANT_BOOK_ROSTER[0].habitatRestrictions
      }
    }]);
  });

  it("records only living roster mobs from authoritative presentation upserts", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const service = new CreatureBookService({ query } as unknown as pg.Pool);
    await service.recordVisibleCreatures("player-1", [
      entity("deer", "deer-1", "alive"),
      entity("deer", "deer-dead", "defeated"),
      entity("goblin", "goblin-1", "alive")
    ]);
    expect(query).toHaveBeenCalledOnce();
    expect(query.mock.calls[0]?.[1]).toEqual(["player-1", ["deer"], ["deer-1"]]);

    await service.recordVisibleCreatures("player-1", [entity("deer", "deer-1", "alive")]);
    expect(query).toHaveBeenCalledOnce();
  });

  it("records only normal sightings, even for a legacy Ashen entity", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const service = new CreatureBookService({ query } as unknown as pg.Pool);
    await service.recordVisibleCreatures("player-1", [entity("deer", "deer-normal", "alive")]);
    await service.recordVisibleCreatures("player-1", [
      entity("deer", "deer-ashen", "alive", "ashen")
    ]);
    expect(query).toHaveBeenCalledOnce();
    expect(String(query.mock.calls[0]?.[0])).not.toContain("ashen");
  });

  it("retries a sighting after a failed database write instead of poisoning the bounded cache", async () => {
    const query = vi.fn()
      .mockRejectedValueOnce(new Error("database unavailable"))
      .mockResolvedValueOnce({ rows: [] });
    const service = new CreatureBookService({ query } as unknown as pg.Pool);
    const deer = entity("deer", "deer-1", "alive");

    await expect(service.recordVisibleCreatures("player-1", [deer])).rejects.toThrow("database unavailable");
    await expect(service.recordVisibleCreatures("player-1", [deer])).resolves.toBeUndefined();
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("admits only the exact creature book request protocol frame", () => {
    expect(parseClientMessage('{"type":"REQUEST_CREATURE_BOOK"}')).toEqual({
      type: "REQUEST_CREATURE_BOOK"
    });
    expect(() => parseClientMessage('{"type":"REQUEST_CREATURE_BOOK","playerId":"other"}'))
      .toThrow();
  });

  it("writes kill, implied sight, and distinct drop occurrences through one transaction client", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    await recordCreatureBookKillInTransaction({ query } as unknown as pg.PoolClient, {
      playerId: "player-1",
      sourceKind: "xoral_event",
      sourceId: "event-1",
      mobArchetype: "xoral",
      itemIds: ["attack_ring", "attack_ring"]
    });
    expect(query).toHaveBeenCalledTimes(3);
    expect(query.mock.calls[2]?.[1]).toEqual([
      "player-1", "xoral_event", "event-1", ["attack_ring"]
    ]);
    expect(query.mock.calls.every(([sql]) => String(sql).includes("ON CONFLICT DO NOTHING")))
      .toBe(true);
  });

  it("records a successful plant harvest idempotently by authoritative source", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    await recordCreatureBookPlantHarvestInTransaction({ query } as unknown as pg.PoolClient, {
      playerId: "player-1",
      plantKey: "flax",
      sourceId: "harvest-operation-1"
    });
    expect(query).toHaveBeenCalledOnce();
    expect(query.mock.calls[0]?.[1]).toEqual([
      "player-1", "flax", "harvest-operation-1"
    ]);
    expect(String(query.mock.calls[0]?.[0])).toContain("ON CONFLICT DO NOTHING");
  });
});

function entity(
  archetypeKey: "deer" | "goblin",
  entityId: string,
  lifeState: "alive" | "defeated",
  appearanceVariant: "normal" | "ashen" = "normal"
) {
  return {
    entityId,
    kind: "mob" as const,
    archetypeKey,
    appearanceVariant,
    lifeState
  } as Parameters<CreatureBookService["recordVisibleCreatures"]>[1][number];
}
