import { describe, expect, it, vi } from "vitest";
import {
  HOLLIN_HELPER_BERRY_INTERVAL_MS,
  HOLLIN_HELPER_FOLLOW_DISTANCE_M,
  HOLLIN_HELPER_FORAGE_INTERVAL_MS,
  distanceMeters,
  hollinHelperEntityId
} from "@ash-atlas/shared";

import { HollinHelperService, type HollinForageEvent, type HollinHelperDeps } from "./hollinHelper.js";

type Mob = { entityId: string; lat: number; lon: number };

function setup(rank: number) {
  let clock = 5_000_000;
  const owner = { playerId: "p1", regionCode: "r", position: { lat: 35, lon: -106 } };
  let online = true;
  const mobs = new Map<string, Mob>();
  const combat = {
    spawnMob: vi.fn((input: { entityId: string; position: { lat: number; lon: number } }) => {
      mobs.set(input.entityId, { entityId: input.entityId, ...input.position });
    }),
    despawnMob: vi.fn((id: string) => mobs.delete(id)),
    entity: vi.fn((id: string) => mobs.get(id) ?? null),
    relocateMob: vi.fn((id: string, position: { lat: number; lon: number }) => {
      const mob = mobs.get(id);
      if (mob) { mob.lat = position.lat; mob.lon = position.lon; }
      return Boolean(mob);
    })
  };
  const drops: Array<Record<string, unknown>> = [];
  const droppedItems = {
    listActive: vi.fn(async () => drops),
    pickupDroppedItem: vi.fn(async (_p: unknown, _r: string, dropId: string) => {
      const index = drops.findIndex((drop) => drop.dropId === dropId);
      if (index >= 0) drops.splice(index, 1);
      return { pickedUpQuantity: 3, inventory: { totals: {} } };
    })
  };
  const granted = new Set<string>();
  const inventory = {
    grantItemsForOperationInTransaction: vi.fn(async (_c: unknown, input: { operationKey: string }) => {
      const applied = !granted.has(input.operationKey);
      granted.add(input.operationKey);
      return { applied, inventory: { totals: {} }, grants: [] };
    })
  };
  const events: HollinForageEvent[] = [];
  const service = new HollinHelperService({
    combat, droppedItems, inventory,
    ranks: { ensureLoaded: async () => undefined, rankOf: () => rank },
    players: { onlineWorldPlayers: () => (online ? [owner] : []) },
    transaction: async (work: (client: never) => Promise<unknown>) => work({} as never),
    playerSpeedMps: 5,
    onForaged: (event: HollinForageEvent) => events.push(event),
    now: () => clock
  } as unknown as HollinHelperDeps);
  const advance = async (ms: number) => { clock += ms; await service.tick(); await new Promise((resolve) => setTimeout(resolve, 0)); };
  return { service, owner, mobs, drops, events, inventory, droppedItems, advance, setOnline: (v: boolean) => { online = v; } };
}

describe("Hollin helper (Hollin Lore rank 3)", () => {
  it("only appears for rank 3 and follows its owner", async () => {
    const low = setup(2);
    await low.advance(500);
    expect(low.mobs.size).toBe(0);

    const t = setup(3);
    await t.advance(500);
    const id = hollinHelperEntityId("p1");
    expect(t.mobs.has(id)).toBe(true);
    t.owner.position = { lat: 35.0005, lon: -106 };
    for (let i = 0; i < 40; i += 1) await t.advance(500);
    const helper = t.mobs.get(id)!;
    expect(distanceMeters(helper, t.owner.position)).toBeLessThanOrEqual(HOLLIN_HELPER_FOLLOW_DISTANCE_M + 1);
  });

  it("picks up the owner's own nearby dropped items but not other players'", async () => {
    const t = setup(3);
    await t.advance(500);
    t.drops.push(
      { dropId: "theirs", droppedBy: "other", itemId: "wood", lat: 35, lon: -106 },
      { dropId: "mine", droppedBy: "p1", itemId: "wood", lat: 35, lon: -106 }
    );
    await t.advance(HOLLIN_HELPER_FORAGE_INTERVAL_MS);
    expect(t.droppedItems.pickupDroppedItem).toHaveBeenCalledTimes(1);
    expect(t.droppedItems.pickupDroppedItem.mock.calls[0]![2]).toBe("mine");
    expect(t.events).toMatchObject([{ kind: "pickup", itemId: "wood", quantity: 3 }]);
  });

  it("gathers a berry at most once per window, idempotently", async () => {
    const t = setup(3);
    await t.advance(500);
    let berries = 0;
    for (let elapsed = 0; elapsed < HOLLIN_HELPER_BERRY_INTERVAL_MS * 2; elapsed += HOLLIN_HELPER_FORAGE_INTERVAL_MS) {
      await t.advance(HOLLIN_HELPER_FORAGE_INTERVAL_MS);
    }
    berries = t.events.filter((event) => event.kind === "berry").length;
    expect(berries).toBeGreaterThanOrEqual(1);
    expect(berries).toBeLessThanOrEqual(3);
    const keys = t.inventory.grantItemsForOperationInTransaction.mock.calls.map((call) => (call[1] as { operationKey: string }).operationKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("dismisses the helper when the owner goes offline", async () => {
    const t = setup(3);
    await t.advance(500);
    expect(t.service.hasHelper("p1")).toBe(true);
    t.setOnline(false);
    await t.advance(500);
    expect(t.service.hasHelper("p1")).toBe(false);
    expect(t.mobs.size).toBe(0);
  });
});
