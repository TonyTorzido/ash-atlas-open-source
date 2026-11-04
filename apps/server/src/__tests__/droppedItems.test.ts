import {
  distanceMeters,
  emptyInventoryTotals,
  type PlayerInventorySnapshot,
  type ResourceType
} from "@ash-atlas/shared";
import type pg from "pg";
import { describe, expect, it } from "vitest";

import {
  DROPPED_ITEM_PILE_MERGE_RADIUS_M,
  DROPPED_ITEM_PICKUP_RADIUS_M,
  DROPPED_ITEM_TTL_MS,
  DroppedItemService,
  createSystemGroundDropsInTransaction,
  settlePhysicalItemRewardInTransaction,
  type DropItemInput
} from "../game/droppedItems.js";
import type {
  InventoryDebitInput,
  InventoryOperationInput,
  InventoryOperationResult
} from "../game/inventory.js";
import type { PlayerRecord } from "../game/state.js";

const NOW = new Date("2026-07-09T12:00:00.000Z");
const PLAYER = player("player-1", 35, -106);

describe("DroppedItemService", () => {
  it("rejects unknown items and invalid quantities before changing inventory", async () => {
    const fixture = createFixture();
    fixture.database.seedStack(PLAYER.playerId, "wood", "default", 2);

    await expect(
      fixture.service.dropItem(PLAYER, dropInput("unknown", 1))
    ).rejects.toMatchObject({ code: "DROP_UNKNOWN_ITEM" });
    for (const quantity of [0, -1, 1.5]) {
      await expect(
        fixture.service.dropItem(PLAYER, dropInput("wood", quantity))
      ).rejects.toMatchObject({ code: "DROP_INVALID_QUANTITY" });
    }

    expect(fixture.database.stack(PLAYER.playerId, "wood")).toBe(2);
    expect(fixture.database.drops()).toHaveLength(0);
  });

  it("rejects missing variants and quantities greater than the owned stack", async () => {
    const fixture = createFixture();
    fixture.database.seedStack(PLAYER.playerId, "water", "fresh", 2);

    await expect(
      fixture.service.dropItem(PLAYER, {
        ...dropInput("water", 1),
        variant: "salt"
      })
    ).rejects.toMatchObject({ code: "DROP_VARIANT_NOT_OWNED" });
    await expect(
      fixture.service.dropItem(PLAYER, {
        ...dropInput("water", 3),
        variant: "fresh"
      })
    ).rejects.toMatchObject({ code: "DROP_NOT_ENOUGH_ITEMS" });

    expect(fixture.database.stack(PLAYER.playerId, "water", "fresh")).toBe(2);
  });

  it("subtracts inventory, writes a negative ledger event, and creates one durable drop", async () => {
    const fixture = createFixture();
    fixture.database.seedStack(PLAYER.playerId, "wood", "default", 5);
    const forged = {
      ...dropInput("wood", 3, "drop-position"),
      lat: 0,
      lon: 0
    } as DropItemInput;

    const result = await fixture.service.dropItem(PLAYER, forged);

    expect(result.replayed).toBe(false);
    expect(result.inventory.totals.wood).toBe(2);
    expect(result.drop).toMatchObject({
      droppedBy: PLAYER.playerId,
      itemId: "wood",
      quantity: 3,
      status: "active",
      lat: PLAYER.position.lat,
      lon: PLAYER.position.lon
    });
    expect(Date.parse(result.drop.expiresAt) - Date.parse(result.drop.createdAt)).toBe(
      DROPPED_ITEM_TTL_MS
    );
    expect(fixture.database.events()).toEqual([
      expect.objectContaining({ itemId: "wood", deltaQuantity: -3, quantityAfter: 2 })
    ]);
    expect(fixture.database.drops()).toHaveLength(1);
  });

  it("allows partial and full drops from a previously oversized stack without item loss", async () => {
    const fixture = createFixture();
    fixture.database.seedStack(PLAYER.playerId, "leather", "default", 583);

    const partial = await fixture.service.dropItem(
      PLAYER,
      dropInput("leather", 250, "oversized-partial")
    );
    expect(partial).toMatchObject({
      inventory: { totals: { leather: 333 } },
      drop: { itemId: "leather", quantity: 250 }
    });

    const remainder = await fixture.service.dropItem(
      PLAYER,
      dropInput("leather", 333, "oversized-full")
    );
    expect(remainder).toMatchObject({
      inventory: { totals: { leather: 0 } },
      drop: { itemId: "leather", quantity: 333 }
    });
    expect(fixture.database.drops().map(({ remaining_quantity }) => Number(remaining_quantity)))
      .toEqual([250, 333]);
    expect(fixture.database.events().map(({ deltaQuantity }) => deltaQuantity))
      .toEqual([-250, -333]);
  });

  it("drops a partial quantity above the old maximum and replays without a second debit", async () => {
    const fixture = createFixture();
    fixture.database.seedStack(PLAYER.playerId, "leather", "default", 583);
    const input = dropInput("leather", 501, "large-ground-quantity");
    const result = await fixture.service.dropItem(PLAYER, input);
    expect(result.drop.quantity).toBe(501);
    expect(fixture.database.stack(PLAYER.playerId, "leather")).toBe(82);
    const replay = await fixture.service.dropItem(PLAYER, input);
    expect(replay.replayed).toBe(true);
    expect(fixture.database.stack(PLAYER.playerId, "leather")).toBe(82);
    expect(fixture.database.drops()).toHaveLength(1);
  });

  it("places matching nearby drops into one anchored pile within 100 meters", async () => {
    const fixture = createFixture();
    fixture.database.seedStack(PLAYER.playerId, "wood", "default", 3);

    const first = await fixture.service.dropItem(
      PLAYER,
      dropInput("wood", 1, "pile-first")
    );
    const nearby = await fixture.service.dropItem(
      { ...PLAYER, position: { lat: 35.0007, lon: -106 } },
      dropInput("wood", 1, "pile-nearby")
    );
    const far = await fixture.service.dropItem(
      { ...PLAYER, position: { lat: 35.0025, lon: -106 } },
      dropInput("wood", 1, "pile-far")
    );

    expect(DROPPED_ITEM_PILE_MERGE_RADIUS_M).toBe(100);
    expect(nearby.drop).toMatchObject({
      pileId: first.drop.pileId,
      pileOrder: 1,
      lat: first.drop.lat,
      lon: first.drop.lon
    });
    expect(far.drop.pileId).not.toBe(first.drop.pileId);
  });

  it("cannot drop the quantity reserved by an authoritative keep policy", async () => {
    const fixture = createFixture();
    fixture.database.seedStack(PLAYER.playerId, "wood", "default", 5);
    fixture.database.seedKeep(PLAYER.playerId, "wood", "default", 3);

    await expect(
      fixture.service.dropItem(PLAYER, dropInput("wood", 3, "protected-drop"))
    ).rejects.toMatchObject({ code: "DROP_ITEM_PROTECTED" });
    await expect(
      fixture.service.dropItem(PLAYER, dropInput("wood", 2, "movable-drop"))
    ).resolves.toMatchObject({
      replayed: false,
      inventory: { totals: { wood: 3 } }
    });
    expect(fixture.database.stack(PLAYER.playerId, "wood")).toBe(3);
  });

  it("rolls back the inventory decrement if drop creation fails", async () => {
    const fixture = createFixture();
    fixture.database.seedStack(PLAYER.playerId, "stone", "default", 1);
    fixture.database.failNextDropInsert();

    await expect(
      fixture.service.dropItem(PLAYER, dropInput("stone", 1))
    ).rejects.toThrow(/drop insert failed/i);

    expect(fixture.database.stack(PLAYER.playerId, "stone")).toBe(1);
    expect(fixture.database.events()).toHaveLength(0);
    expect(fixture.database.drops()).toHaveLength(0);
  });

  it("replays a repeated drop request without subtracting or creating twice", async () => {
    const fixture = createFixture();
    fixture.database.seedStack(PLAYER.playerId, "food", "default", 2);
    const input = dropInput("food", 1, "same-drop");

    const first = await fixture.service.dropItem(PLAYER, input);
    const replay = await fixture.service.dropItem(PLAYER, input);

    expect(first.replayed).toBe(false);
    expect(replay.replayed).toBe(true);
    expect(replay.drop.dropId).toBe(first.drop.dropId);
    expect(fixture.database.stack(PLAYER.playerId, "food")).toBe(1);
    expect(fixture.database.drops()).toHaveLength(1);
    expect(fixture.database.events()).toHaveLength(1);
  });

  it("picks up an active in-range drop in one transaction", async () => {
    const fixture = createFixture();
    fixture.database.seedStack(PLAYER.playerId, "ore", "default", 1);
    const dropped = await fixture.service.dropItem(PLAYER, dropInput("ore", 1));
    const picker = player("player-2", PLAYER.position.lat, PLAYER.position.lon);

    const result = await fixture.service.pickupDroppedItem(
      picker,
      "pickup-1",
      dropped.drop.dropId
    );

    expect(result.replayed).toBe(false);
    expect(result.drop).toMatchObject({ status: "picked_up", pickedUpBy: picker.playerId });
    expect(result.inventory.totals.ore).toBe(1);
    expect(fixture.database.stack(picker.playerId, "ore")).toBe(1);
  });

  it("picks up the full chosen quantity instantly without a harvest session", async () => {
    const fixture = createFixture();
    fixture.database.seedStack(PLAYER.playerId, "food", "default", 4);
    const dropped = await fixture.service.dropItem(PLAYER, dropInput("food", 3));
    const picker = player("player-2", PLAYER.position.lat, PLAYER.position.lon);

    const result = await fixture.service.pickupDroppedItem(
      picker,
      "pickup-quantity",
      dropped.drop.dropId
    );

    expect(result.inventory.totals.food).toBe(3);
    expect(fixture.database.stack(picker.playerId, "food")).toBe(3);
    expect(result.drop).toMatchObject({ quantity: 0, status: "picked_up" });
  });

  it("partially picks up the selected quantity and keeps the remaining drop active", async () => {
    const fixture = createFixture();
    fixture.database.seedStack(PLAYER.playerId, "stone", "default", 10);
    const dropped = await fixture.service.dropItem(PLAYER, dropInput("stone", 10));
    const picker = player("partial-picker", PLAYER.position.lat, PLAYER.position.lon);

    const result = await fixture.service.pickupDroppedItem(
      picker,
      "partial-4",
      dropped.drop.dropId,
      { mode: "quantity", quantity: 4 }
    );

    expect(result).toMatchObject({
      requestedQuantity: 4,
      pickedUpQuantity: 4,
      remainingQuantity: 6,
      removed: false,
      drop: { quantity: 6, status: "active" }
    });
    expect(fixture.database.stack(picker.playerId, "stone")).toBe(4);
  });

  it("accepts only the legal inventory capacity and leaves the authoritative remainder", async () => {
    const fixture = createFixture();
    fixture.database.seedStack(PLAYER.playerId, "balsam_resin", "default", 10);
    const dropped = await fixture.service.dropItem(PLAYER, dropInput("balsam_resin", 10));
    const picker = player("capacity-picker", PLAYER.position.lat, PLAYER.position.lon);
    fixture.database.setGrantLimit(picker.playerId, "balsam_resin", "default", 4);

    const result = await fixture.service.pickupDroppedItem(
      picker,
      "capacity-partial",
      dropped.drop.dropId,
      { mode: "all" }
    );

    expect(result).toMatchObject({
      requestedQuantity: 10,
      pickedUpQuantity: 4,
      remainingQuantity: 6,
      removed: false,
      drop: { quantity: 6, status: "active" }
    });
    expect(fixture.database.stack(picker.playerId, "balsam_resin")).toBe(4);
  });

  it("rejects a stale oversized partial request and exposes the locked remainder", async () => {
    const fixture = createFixture();
    fixture.database.seedStack(PLAYER.playerId, "ore", "default", 5);
    const dropped = await fixture.service.dropItem(PLAYER, dropInput("ore", 5));
    const first = player("first-partial", PLAYER.position.lat, PLAYER.position.lon);
    const stale = player("stale-partial", PLAYER.position.lat, PLAYER.position.lon);
    await fixture.service.pickupDroppedItem(first, "take-3", dropped.drop.dropId, {
      mode: "quantity",
      quantity: 3
    });

    await expect(
      fixture.service.pickupDroppedItem(stale, "stale-4", dropped.drop.dropId, {
        mode: "quantity",
        quantity: 4
      })
    ).rejects.toMatchObject({
      code: "DROPPED_ITEM_QUANTITY_UNAVAILABLE",
      details: { dropId: dropped.drop.dropId, remainingQuantity: 2 }
    });
    expect(fixture.database.stack(stale.playerId, "ore")).toBe(0);
    expect(fixture.database.drop(dropped.drop.dropId)).toMatchObject({
      remaining_quantity: "2",
      status: "active"
    });
  });

  it("serializes competing partial pickups without overdrawing the stack", async () => {
    const fixture = createFixture();
    fixture.database.seedStack(PLAYER.playerId, "stone", "default", 10);
    const dropped = await fixture.service.dropItem(PLAYER, dropInput("stone", 10));
    const first = player("partial-a", PLAYER.position.lat, PLAYER.position.lon);
    const second = player("partial-b", PLAYER.position.lat, PLAYER.position.lon);

    const results = await Promise.allSettled([
      fixture.service.pickupDroppedItem(first, "partial-a-7", dropped.drop.dropId, {
        mode: "quantity",
        quantity: 7
      }),
      fixture.service.pickupDroppedItem(second, "partial-b-6", dropped.drop.dropId, {
        mode: "quantity",
        quantity: 6
      })
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(fixture.database.stack(first.playerId, "stone") + fixture.database.stack(second.playerId, "stone")).toBeLessThanOrEqual(10);
    expect(Number(fixture.database.drop(dropped.drop.dropId)?.remaining_quantity)).toBeGreaterThan(0);
  });

  it("lets Pick Up All take the authoritative remainder after a partial pickup", async () => {
    const fixture = createFixture();
    fixture.database.seedStack(PLAYER.playerId, "food", "default", 10);
    const dropped = await fixture.service.dropItem(PLAYER, dropInput("food", 10));
    const partial = player("partial-first", PLAYER.position.lat, PLAYER.position.lon);
    const all = player("all-second", PLAYER.position.lat, PLAYER.position.lon);
    await fixture.service.pickupDroppedItem(partial, "partial-first-3", dropped.drop.dropId, {
      mode: "quantity",
      quantity: 3
    });

    const result = await fixture.service.pickupDroppedItem(
      all,
      "all-remainder",
      dropped.drop.dropId,
      { mode: "all" }
    );

    expect(result).toMatchObject({ pickedUpQuantity: 7, remainingQuantity: 0, removed: true });
    expect(fixture.database.stack(partial.playerId, "food") + fixture.database.stack(all.playerId, "food")).toBe(10);
  });

  it("conserves the stack when a partial pickup races Pick Up All", async () => {
    const fixture = createFixture();
    fixture.database.seedStack(PLAYER.playerId, "ore", "default", 10);
    const dropped = await fixture.service.dropItem(PLAYER, dropInput("ore", 10));
    const partial = player("race-partial", PLAYER.position.lat, PLAYER.position.lon);
    const all = player("race-all", PLAYER.position.lat, PLAYER.position.lon);

    await Promise.allSettled([
      fixture.service.pickupDroppedItem(partial, "race-partial-7", dropped.drop.dropId, {
        mode: "quantity",
        quantity: 7
      }),
      fixture.service.pickupDroppedItem(all, "race-all", dropped.drop.dropId, { mode: "all" })
    ]);

    expect(
      fixture.database.stack(partial.playerId, "ore") +
        fixture.database.stack(all.playerId, "ore")
    ).toBe(10);
    expect(fixture.database.drop(dropped.drop.dropId)?.status).toBe("picked_up");
  });

  it("replays partial and Pick Up All requests without granting twice", async () => {
    const fixture = createFixture();
    fixture.database.seedStack(PLAYER.playerId, "wood", "default", 6);
    const dropped = await fixture.service.dropItem(PLAYER, dropInput("wood", 6));
    const picker = player("replay-picker", PLAYER.position.lat, PLAYER.position.lon);
    const intent = { mode: "quantity", quantity: 2 } as const;
    await fixture.service.pickupDroppedItem(picker, "partial-replay", dropped.drop.dropId, intent);
    const replay = await fixture.service.pickupDroppedItem(picker, "partial-replay", dropped.drop.dropId, intent);
    expect(replay.replayed).toBe(true);
    expect(replay.requestedQuantity).toBe(2);
    expect(fixture.database.stack(picker.playerId, "wood")).toBe(2);

    await fixture.service.pickupDroppedItem(picker, "all-replay", dropped.drop.dropId, { mode: "all" });
    const allReplay = await fixture.service.pickupDroppedItem(picker, "all-replay", dropped.drop.dropId, { mode: "all" });
    expect(allReplay.replayed).toBe(true);
    expect(allReplay.requestedQuantity).toBe(4);
    expect(fixture.database.stack(picker.playerId, "wood")).toBe(6);
  });

  it("rejects out-of-range and expired pickups without granting", async () => {
    const fixture = createFixture();
    fixture.database.seedStack(PLAYER.playerId, "wood", "default", 2);
    const first = await fixture.service.dropItem(PLAYER, dropInput("wood", 1, "range"));
    const farPlayer = player("player-far", 35.001, -106);

    await expect(
      fixture.service.pickupDroppedItem(farPlayer, "pickup-far", first.drop.dropId)
    ).rejects.toMatchObject({ code: "DROPPED_ITEM_OUT_OF_RANGE" });
    expect(fixture.database.stack(farPlayer.playerId, "wood")).toBe(0);

    await expect(
      fixture.service.pickupDroppedItem(
        { ...PLAYER, playerId: "player-interior", zoneId: "interior:sewer:1:depths" },
        "pickup-wrong-zone",
        first.drop.dropId
      )
    ).rejects.toMatchObject({ code: "DROPPED_ITEM_OUT_OF_RANGE" });

    const second = await fixture.service.dropItem(PLAYER, dropInput("wood", 1, "expired"));
    fixture.clock.advance(DROPPED_ITEM_TTL_MS);
    await expect(
      fixture.service.pickupDroppedItem(PLAYER, "pickup-expired", second.drop.dropId)
    ).rejects.toMatchObject({ code: "DROPPED_ITEM_EXPIRED" });
    expect(fixture.database.drop(second.drop.dropId)?.status).toBe("expired");
  });

  it("allows a nearby outdoor pickup across a package boundary", async () => {
    const fixture = createFixture();
    fixture.database.seedStack(PLAYER.playerId, "leather", "default", 15);
    const dropped = await fixture.service.dropItem(
      { ...PLAYER, regionCode: "adjacent-package" },
      dropInput("leather", 15, "cross-boundary-pickup")
    );
    const picker = player("cross-boundary-picker", PLAYER.position.lat, PLAYER.position.lon);

    const result = await fixture.service.pickupDroppedItem(
      picker,
      "cross-boundary-pickup",
      dropped.drop.dropId
    );

    expect(result.pickedUpQuantity).toBe(15);
    expect(result.removed).toBe(true);
    expect(fixture.database.stack(picker.playerId, "leather")).toBe(15);
  });

  it("serializes concurrent pickup attempts so the item is granted once", async () => {
    const fixture = createFixture();
    fixture.database.seedStack(PLAYER.playerId, "stone", "default", 1);
    const dropped = await fixture.service.dropItem(PLAYER, dropInput("stone", 1));
    const firstPicker = player("picker-1", PLAYER.position.lat, PLAYER.position.lon);
    const secondPicker = player("picker-2", PLAYER.position.lat, PLAYER.position.lon);

    const results = await Promise.allSettled([
      fixture.service.pickupDroppedItem(firstPicker, "pickup-a", dropped.drop.dropId),
      fixture.service.pickupDroppedItem(secondPicker, "pickup-b", dropped.drop.dropId)
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(
      fixture.database.stack(firstPicker.playerId, "stone") +
        fixture.database.stack(secondPicker.playerId, "stone")
    ).toBe(1);
  });

  it("returns only active, unexpired drops in region snapshots", async () => {
    const fixture = createFixture();
    fixture.database.seedStack(PLAYER.playerId, "food", "default", 2);
    const first = await fixture.service.dropItem(PLAYER, dropInput("food", 1, "active"));
    await fixture.service.dropItem(PLAYER, dropInput("food", 1, "expires"));
    fixture.clock.advance(DROPPED_ITEM_TTL_MS);

    expect(await fixture.service.listActive("NM")).toEqual([]);
    expect(fixture.database.drop(first.drop.dropId)?.status).toBe("expired");
  });

  it("lists active drops by the exact gameplay circle across region boundaries", async () => {
    const fixture = createFixture();
    const adjacentRegionPlayer = {
      ...PLAYER,
      regionCode: "adjacent-package"
    };
    fixture.database.seedStack(PLAYER.playerId, "food", "default", 1);
    const dropped = await fixture.service.dropItem(
      adjacentRegionPlayer,
      dropInput("food", 1, "cross-boundary")
    );

    expect(await fixture.service.listActiveInGameplayCircle(PLAYER.anchor, 650)).toEqual([
      dropped.drop
    ]);
  });

  it("uses a short server-owned pickup radius", () => {
    expect(DROPPED_ITEM_PICKUP_RADIUS_M).toBe(20);
  });

  it("creates ordered replay-safe system loot in one visible pile", async () => {
    const fixture = createFixture();
    const client = await fixture.database.pool.connect();
    await client.query("BEGIN");
    const input = {
      operationKey: "combat:mob-1:defeat:1",
      droppedByPlayerId: PLAYER.playerId,
      regionCode: PLAYER.regionCode,
      zoneId: "world:NM",
      pileId: "combat:mob-1:defeat:1",
      sourceEntityType: "combat_settlement",
      sourceEntityId: "mob-1",
      position: PLAYER.position,
      reason: "combat_reward",
      lines: [
        { itemId: "balsam_resin", variant: null, quantity: 2, pileOrder: 0 },
        { itemId: "wood", variant: null, quantity: 3, pileOrder: 1 }
      ],
      now: NOW
    } as const;
    const first = await createSystemGroundDropsInTransaction(client, input);
    const replay = await createSystemGroundDropsInTransaction(client, input);
    await client.query("COMMIT");
    client.release();

    expect(first.map(({ itemId, quantity, pileId, pileOrder }) => ({
      itemId, quantity, pileId, pileOrder
    }))).toEqual([
      { itemId: "balsam_resin", quantity: 2, pileId: input.pileId, pileOrder: 0 },
      { itemId: "wood", quantity: 3, pileId: input.pileId, pileOrder: 1 }
    ]);
    expect(replay.map((drop) => drop.dropId)).toEqual(first.map((drop) => drop.dropId));
    expect(fixture.database.drops()).toHaveLength(2);
  });

  it("settles a physical reward into inventory first and drops only overflow at its source", async () => {
    const fixture = createFixture();
    fixture.database.setGrantLimit(PLAYER.playerId, "leather", "default", 1);
    const sourcePosition = { lat: 35.002, lon: -106.003 };
    const inventory = new FakeInventoryGateway(fixture.database);
    const client = await fixture.database.pool.connect();
    await client.query("BEGIN");
    const settled = await settlePhysicalItemRewardInTransaction(client, inventory, {
      delivery: "inventory_then_ground",
      lines: [
        { itemId: "leather", variant: null, quantity: 2 },
        { itemId: "wood", variant: null, quantity: 3 }
      ],
      inventoryOperation: {
        operationKey: "physical-reward:wolf-1",
        playerId: PLAYER.playerId,
        source: "combat_wolf_reward",
        sourceEntityType: "combat_settlement",
        sourceEntityId: "wolf-1"
      },
      groundDrop: {
        operationKey: "physical-reward-overflow:wolf-1",
        droppedByPlayerId: PLAYER.playerId,
        regionCode: PLAYER.regionCode,
        zoneId: "world:NM",
        pileId: "combat:wolf-1",
        sourceEntityType: "combat_settlement",
        sourceEntityId: "wolf-1",
        position: sourcePosition,
        reason: "combat_wolf_loot",
        now: NOW
      }
    });
    await client.query("COMMIT");
    client.release();

    expect(settled.inventory.totals).toMatchObject({ leather: 1, wood: 3 });
    expect(settled.droppedItems).toEqual([
      expect.objectContaining({
        itemId: "leather",
        quantity: 1,
        lat: sourcePosition.lat,
        lon: sourcePosition.lon
      })
    ]);
  });

  it("joins a nearby system drop to a pile containing the same item", async () => {
    const fixture = createFixture();
    const client = await fixture.database.pool.connect();
    await client.query("BEGIN");
    const first = await createSystemGroundDropsInTransaction(client, {
      operationKey: "combat:first",
      droppedByPlayerId: PLAYER.playerId,
      regionCode: PLAYER.regionCode,
      zoneId: "world:NM",
      pileId: "combat:first",
      position: PLAYER.position,
      reason: "combat_reward",
      lines: [{ itemId: "wood", variant: null, quantity: 1 }],
      now: NOW
    });
    const nearby = await createSystemGroundDropsInTransaction(client, {
      operationKey: "combat:nearby",
      droppedByPlayerId: PLAYER.playerId,
      regionCode: PLAYER.regionCode,
      zoneId: "world:NM",
      pileId: "combat:nearby",
      position: { lat: 35.0005, lon: -106 },
      reason: "combat_reward",
      lines: [
        { itemId: "balsam_resin", variant: null, quantity: 2, pileOrder: 0 },
        { itemId: "wood", variant: null, quantity: 1, pileOrder: 1 }
      ],
      now: NOW
    });
    await client.query("COMMIT");
    client.release();

    expect(nearby.every((drop) => drop.pileId === first[0]!.pileId)).toBe(true);
    expect(nearby.every((drop) => drop.lat === first[0]!.lat && drop.lon === first[0]!.lon))
      .toBe(true);
  });

  it("merges nearby matching combat contributions into one replay-safe ground stack", async () => {
    const fixture = createFixture();
    const client = await fixture.database.pool.connect();
    await client.query("BEGIN");
    const first = await createSystemGroundDropsInTransaction(client, {
      operationKey: "combat:wolf-1",
      droppedByPlayerId: PLAYER.playerId,
      regionCode: PLAYER.regionCode,
      zoneId: "world:NM",
      position: PLAYER.position,
      reason: "combat_reward",
      lines: [{ itemId: "leather", variant: null, quantity: 2 }],
      now: NOW
    });
    const secondInput = {
      operationKey: "combat:wolf-2",
      droppedByPlayerId: PLAYER.playerId,
      regionCode: PLAYER.regionCode,
      zoneId: "world:NM",
      position: { lat: 35.0007, lon: -106 },
      reason: "combat_reward",
      lines: [{ itemId: "leather", variant: null, quantity: 4 }],
      now: NOW
    } as const;
    const second = await createSystemGroundDropsInTransaction(client, secondInput);
    const replay = await createSystemGroundDropsInTransaction(client, secondInput);
    await client.query("COMMIT");
    client.release();

    expect(second[0]).toMatchObject({
      dropId: first[0]!.dropId,
      quantity: 6,
      lat: first[0]!.lat,
      lon: first[0]!.lon
    });
    expect(replay[0]).toMatchObject({ dropId: first[0]!.dropId, quantity: 6 });
    expect(fixture.database.drops()).toHaveLength(1);
    expect(fixture.database.drops()[0]).toMatchObject({
      original_quantity: "6",
      remaining_quantity: "6"
    });
  });
});

function createFixture() {
  const database = new DroppedItemTestDatabase();
  const clock = new TestClock(NOW);
  const inventory = new FakeInventoryGateway(database);
  return {
    database,
    clock,
    service: new DroppedItemService(database.pool, inventory, () => clock.now())
  };
}

function dropInput(
  itemId: string,
  quantity: number,
  requestId = `drop-${itemId}-${quantity}`
): DropItemInput {
  return { requestId, itemId, variant: null, quantity };
}

function player(playerId: string, lat: number, lon: number): PlayerRecord {
  return {
    playerId,
    username: playerId,
    displayColor: null,
    regionCode: "NM",
    position: { lat, lon },
    anchor: { lat, lon },
    moveLeashRadiusM: 900,
    movementRevision: 0,
    target: null,
    online: true,
    updatedAt: NOW
  };
}

class TestClock {
  constructor(private value: Date) {}

  now(): Date {
    return new Date(this.value);
  }

  advance(milliseconds: number): void {
    this.value = new Date(this.value.getTime() + milliseconds);
  }
}

type Operation = { playerId: string; source: string };
type Event = {
  operationKey: string;
  playerId: string;
  itemId: string;
  variant: string;
  deltaQuantity: number;
  quantityAfter: number;
};
type DropRow = {
  id: string;
  operation_key: string;
  dropped_by: string;
  region_code: string;
  zone_id: string;
  pile_id: string;
  pile_order: number;
  item_id: string;
  variant: string;
  original_quantity: string;
  remaining_quantity: string;
  status: "active" | "picked_up" | "expired" | "cancelled";
  lat: number;
  lon: number;
  created_at: Date;
  expires_at: Date;
  expired_at: Date | null;
  pickup_operation_key: string | null;
  picked_up_by: string | null;
  picked_up_at: Date | null;
};
type PickupRow = {
  operation_key: string;
  drop_id: string;
  player_id: string;
  pickup_mode: "all" | "quantity";
  requested_quantity: number | null;
  granted_quantity: number;
  remaining_quantity: number;
  resulting_status: "active" | "picked_up";
};
type State = {
  operations: Map<string, Operation>;
  stacks: Map<string, number>;
  grantLimits: Map<string, number>;
  keepPolicies: Map<string, number>;
  events: Event[];
  drops: Map<string, DropRow>;
  pickups: Map<string, PickupRow>;
  requests: Map<string, {
    request_hash: string;
    original_result: { drop: unknown; inventory: PlayerInventorySnapshot };
  }>;
  movements: Set<string>;
  systemSources: Map<string, string>;
  systemContributionQuantities: Map<string, number>;
};

class DroppedItemTestDatabase {
  private committed = emptyState();
  private transactionTail = Promise.resolve();
  private readonly transactions = new WeakMap<object, State>();
  private failDrop = false;

  readonly pool = {
    connect: async () => this.connect(),
    query: async <T>(text: string, values?: readonly unknown[]) =>
      this.queryState<T>(this.committed, text, values)
  } as unknown as pg.Pool;

  seedStack(playerId: string, itemId: string, variant: string, quantity: number): void {
    this.committed.stacks.set(stackKey(playerId, itemId, variant), quantity);
  }

  seedKeep(playerId: string, itemId: string, variant: string, quantity: number): void {
    this.committed.keepPolicies.set(stackKey(playerId, itemId, variant), quantity);
  }

  setGrantLimit(playerId: string, itemId: string, variant: string, quantity: number): void {
    this.committed.grantLimits.set(stackKey(playerId, itemId, variant), quantity);
  }

  stack(playerId: string, itemId: string, variant = "default"): number {
    return this.committed.stacks.get(stackKey(playerId, itemId, variant)) ?? 0;
  }

  drops(): DropRow[] {
    return [...this.committed.drops.values()].map(cloneDrop);
  }

  drop(dropId: string): DropRow | null {
    const row = this.committed.drops.get(dropId);
    return row ? cloneDrop(row) : null;
  }

  events(): Event[] {
    return this.committed.events.map((event) => ({ ...event }));
  }

  failNextDropInsert(): void {
    this.failDrop = true;
  }

  stateFor(queryable: object): State {
    const state = this.transactions.get(queryable);
    if (!state) {
      throw new Error("Inventory gateway requires an active transaction");
    }
    return state;
  }

  private async connect() {
    let releaseTransaction: (() => void) | null = null;
    const client = {
      query: async <T>(text: string, values?: readonly unknown[]) => {
        if (text === "BEGIN") {
          releaseTransaction = await this.acquireTransaction();
          this.transactions.set(client, cloneState(this.committed));
          return emptyResult<T>();
        }
        if (text === "COMMIT") {
          this.committed = cloneState(this.stateFor(client));
          this.transactions.delete(client);
          releaseTransaction?.();
          releaseTransaction = null;
          return emptyResult<T>();
        }
        if (text === "ROLLBACK") {
          this.transactions.delete(client);
          releaseTransaction?.();
          releaseTransaction = null;
          return emptyResult<T>();
        }
        return this.queryState<T>(this.stateFor(client), text, values);
      },
      release: () => undefined
    };
    return client;
  }

  private async acquireTransaction(): Promise<() => void> {
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const previous = this.transactionTail;
    this.transactionTail = previous.then(() => gate);
    await previous;
    return release;
  }

  private async queryState<T>(
    state: State,
    text: string,
    values?: readonly unknown[]
  ): Promise<{ rows: T[]; rowCount: number }> {
    if (text.includes("pg_advisory_xact_lock")) {
      return oneResult<T>({ pg_advisory_xact_lock: null });
    }
    if (text.includes("ash_atlas.system_ground_drop_merge")) {
      return oneResult<T>({ set_config: values?.[0] });
    }
    if (text.includes("FROM world_item_system_drop_sources") && text.includes("operation_key = $1")) {
      const dropId = state.systemSources.get(String(values?.[0]));
      return dropId ? oneResult<T>({ drop_id: dropId }) : emptyResult<T>();
    }
    if (text.includes("movement_kind = 'system_to_world'") && text.includes("quantity::text")) {
      const quantity = state.systemContributionQuantities.get(String(values?.[1]));
      return quantity === undefined ? emptyResult<T>() : oneResult<T>({ quantity: String(quantity) });
    }
    if (text.includes("FROM player_inventory") && text.includes("ORDER BY resource_type")) {
      const playerId = String(values?.[0]);
      const rows = stackEntriesForPlayer(state, playerId).map(([key, quantity], slotIndex) => {
        const [, itemId, variant] = key.split("\u0000");
        return {
          stack_id: key,
          slot_index: slotIndex,
          resource_type: itemId,
          variant,
          quantity: String(quantity)
        };
      });
      return { rows: rows as T[], rowCount: rows.length };
    }
    if (text.includes("FROM player_item_keep_policies")) {
      const playerId = String(values?.[0]);
      const rows = [...state.keepPolicies.entries()]
        .filter(([key]) => key.startsWith(`${playerId}\u0000`))
        .map(([key, quantity]) => {
          const [, itemId, variant] = key.split("\u0000");
          return {
            item_id: itemId,
            variant,
            keep_quantity: String(quantity)
          };
        });
      return { rows: rows as T[], rowCount: rows.length };
    }
    if (text.includes("INSERT INTO inventory_operations")) {
      const operationKey = String(values?.[0]);
      if (state.operations.has(operationKey)) {
        return emptyResult<T>();
      }
      state.operations.set(operationKey, {
        playerId: String(values?.[1]),
        source: "drop_item"
      });
      return oneResult<T>({ operation_key: operationKey });
    }
    if (text.includes("FROM player_inventory") && text.includes("FOR UPDATE")) {
      const key = stackKey(String(values?.[0]), String(values?.[1]), String(values?.[2]));
      const quantity = state.stacks.get(key);
      return quantity === undefined
        ? emptyResult<T>()
        : oneResult<T>({
            player_id: values?.[0],
            resource_type: values?.[1],
            variant: values?.[2],
            quantity
          });
    }
    if (text.includes("UPDATE player_inventory")) {
      const key = stackKey(String(values?.[0]), String(values?.[1]), String(values?.[2]));
      const current = state.stacks.get(key);
      const quantity = Number(values?.[3]);
      if (current === undefined || current < quantity) {
        return emptyResult<T>();
      }
      const next = current - quantity;
      state.stacks.set(key, next);
      return oneResult<T>({
        player_id: values?.[0],
        resource_type: values?.[1],
        variant: values?.[2],
        quantity: next
      });
    }
    if (text.includes("INSERT INTO inventory_events")) {
      state.events.push({
        operationKey: String(values?.[0]),
        playerId: String(values?.[1]),
        itemId: String(values?.[2]),
        variant: String(values?.[3]),
        deltaQuantity: Number(values?.[4]),
        quantityAfter: Number(values?.[5])
      });
      return emptyResult<T>();
    }
    if (text.includes("INSERT INTO world_item_drops")) {
      if (this.failDrop) {
        this.failDrop = false;
        throw new Error("drop insert failed");
      }
      const row: DropRow = {
        id: String(values?.[0]),
        operation_key: String(values?.[1]),
        dropped_by: String(values?.[2]),
        region_code: String(values?.[3]),
        zone_id: String(values?.[4]),
        pile_id: String(values?.[5]),
        pile_order: Number(values?.[6]),
        item_id: String(values?.[7]),
        variant: String(values?.[8]),
        original_quantity: String(values?.[9]),
        remaining_quantity: String(values?.[9]),
        status: "active",
        lat: Number(values?.[10]),
        lon: Number(values?.[11]),
        created_at: date(values?.[12]),
        expires_at: date(values?.[13]),
        expired_at: null,
        pickup_operation_key: null,
        picked_up_by: null,
        picked_up_at: null
      };
      state.drops.set(row.id, row);
      return oneResult<T>(row);
    }
    if (text.includes("SELECT candidate.pile_id")) {
      const center = { lat: Number(values?.[2]), lon: Number(values?.[3]) };
      const itemIds = values?.[4] as readonly string[];
      const variants = values?.[5] as readonly string[];
      const compatible = new Set(itemIds.map((itemId, index) =>
        `${itemId}\u0000${variants[index]}`
      ));
      const now = date(values?.[6]);
      const radiusM = Number(values?.[7]);
      const candidate = [...state.drops.values()]
        .filter((row) =>
          row.region_code === values?.[0] &&
          row.zone_id === values?.[1] &&
          row.status === "active" &&
          row.expires_at > now &&
          compatible.has(`${row.item_id}\u0000${row.variant}`) &&
          distanceMeters(center, { lat: row.lat, lon: row.lon }) <= radiusM
        )
        .sort((left, right) =>
          distanceMeters(center, { lat: left.lat, lon: left.lon }) -
            distanceMeters(center, { lat: right.lat, lon: right.lon }) ||
          left.created_at.getTime() - right.created_at.getTime() ||
          left.id.localeCompare(right.id)
        )[0];
      if (!candidate) return emptyResult<T>();
      const nextPileOrder = Math.max(...[...state.drops.values()]
        .filter((row) =>
          row.zone_id === candidate.zone_id &&
          row.pile_id === candidate.pile_id &&
          row.status === "active"
        )
        .map((row) => row.pile_order)) + 1;
      return oneResult<T>({
        pile_id: candidate.pile_id,
        next_pile_order: nextPileOrder,
        lat: candidate.lat,
        lon: candidate.lon
      });
    }
    if (text.includes("FROM world_item_drops candidate") && text.includes("FOR UPDATE")) {
      const candidate = [...state.drops.values()]
        .filter((row) =>
          row.zone_id === values?.[0] &&
          row.pile_id === values?.[1] &&
          row.item_id === values?.[2] &&
          row.variant === values?.[3] &&
          row.status === "active" &&
          row.expires_at > date(values?.[4]) &&
          Number(row.original_quantity) < Number(values?.[5]) &&
          [...state.systemSources.values()].includes(row.id) &&
          ![...state.pickups.values()].some((pickup) => pickup.drop_id === row.id)
        )
        .sort((left, right) => left.pile_order - right.pile_order)[0];
      return candidate ? oneResult<T>(candidate) : emptyResult<T>();
    }
    if (text.includes("FROM world_item_drop_requests")) {
      const row = state.requests.get(String(values?.[0]));
      return row ? oneResult<T>(row) : emptyResult<T>();
    }
    if (text.includes("INSERT INTO world_item_drop_requests")) {
      state.requests.set(String(values?.[0]), {
        request_hash: String(values?.[3]),
        original_result: JSON.parse(String(values?.[4])) as {
          drop: unknown;
          inventory: PlayerInventorySnapshot;
        }
      });
      return emptyResult<T>();
    }
    if (text.includes("INSERT INTO world_item_movements") && !text.includes("WITH due AS MATERIALIZED")) {
      const kind = text.includes("world_to_player")
        ? "pickup"
        : text.includes("world_to_destruction")
          ? "destruction"
          : "creation";
      const key = `${String(values?.[0])}:${kind}:${String(values?.[1] ?? "")}`;
      if (state.movements.has(key) && text.includes("ON CONFLICT DO NOTHING")) {
        return emptyResult<T>();
      }
      state.movements.add(key);
      if (text.includes("system_to_world")) {
        state.systemContributionQuantities.set(String(values?.[1]), Number(values?.[5]));
      }
      return oneResult<T>({ movement_id: state.movements.size });
    }
    if (text.includes("INSERT INTO world_item_system_drop_sources")) {
      state.systemSources.set(String(values?.[1]), String(values?.[0]));
      return emptyResult<T>();
    }
    if (text.includes("FROM world_item_pickups") && !text.includes("UPDATE world_item_drops")) {
      const row = state.pickups.get(String(values?.[0]));
      return row ? oneResult<T>(row) : emptyResult<T>();
    }
    if (text.includes("FROM world_item_drops") && text.includes("WHERE id = $1")) {
      const row = state.drops.get(String(values?.[0]));
      return row ? oneResult<T>(row) : emptyResult<T>();
    }
    if (text.includes("UPDATE world_item_drops") && text.includes("picked_up_at = $4")) {
      const row = state.drops.get(String(values?.[0]));
      if (!row || row.status !== "active") {
        return emptyResult<T>();
      }
      row.status = "picked_up";
      row.remaining_quantity = "0";
      row.pickup_operation_key = String(values?.[1]);
      row.picked_up_by = String(values?.[2]);
      row.picked_up_at = date(values?.[3]);
      return oneResult<T>(row);
    }
    if (text.includes("SET original_quantity = original_quantity + $2")) {
      const row = state.drops.get(String(values?.[0]));
      if (!row || row.status !== "active") return emptyResult<T>();
      const added = Number(values?.[1]);
      row.original_quantity = String(Number(row.original_quantity) + added);
      row.remaining_quantity = String(Number(row.remaining_quantity) + added);
      row.expires_at = new Date(Math.max(row.expires_at.getTime(), date(values?.[2]).getTime()));
      return oneResult<T>(row);
    }
    if (text.includes("UPDATE world_item_drops") && text.includes("SET remaining_quantity = $2")) {
      const row = state.drops.get(String(values?.[0]));
      const remaining = Number(values?.[1]);
      const granted = Number(values?.[2]);
      if (!row || row.status !== "active" || Number(row.remaining_quantity) < granted) {
        return emptyResult<T>();
      }
      row.remaining_quantity = String(remaining);
      return oneResult<T>(row);
    }
    if (text.includes("INSERT INTO world_item_pickups")) {
      const row: PickupRow = {
        operation_key: String(values?.[0]),
        drop_id: String(values?.[1]),
        player_id: String(values?.[2]),
        pickup_mode: String(values?.[3]) as PickupRow["pickup_mode"],
        requested_quantity: values?.[4] === null ? null : Number(values?.[4]),
        granted_quantity: Number(values?.[5]),
        remaining_quantity: Number(values?.[6]),
        resulting_status: String(values?.[7]) as PickupRow["resulting_status"]
      };
      state.pickups.set(row.operation_key, row);
      return emptyResult<T>();
    }
    if (text.includes("UPDATE world_item_drops") && text.includes("expired_at = $2")) {
      const row = state.drops.get(String(values?.[0]));
      if (row?.status === "active") {
        row.status = "expired";
        row.remaining_quantity = "0";
        row.expired_at = date(values?.[1]);
        return oneResult<T>({ id: row.id });
      }
      return emptyResult<T>();
    }
    if (text.includes("WITH due AS MATERIALIZED")) {
      const now = date(values?.[0]);
      const limit = Number(values?.[1]);
      let expired = 0;
      for (const row of state.drops.values()) {
        if (expired < limit && row.status === "active" && row.expires_at <= now) {
          const remaining = row.remaining_quantity;
          row.status = "expired";
          row.remaining_quantity = "0";
          row.expired_at = now;
          state.movements.add(`${row.id}:destruction:${remaining}`);
          expired += 1;
        }
      }
      return oneResult<T>({ expired_count: String(expired) });
    }
    if (text.includes("FROM world_item_drops") && text.includes("region_code = $1")) {
      const now = date(values?.[1]);
      const rows = [...state.drops.values()]
        .filter(
          (row) =>
            row.region_code === values?.[0] && row.status === "active" && row.expires_at > now
        )
        .sort((left, right) => left.created_at.getTime() - right.created_at.getTime());
      return { rows: rows.map(cloneDrop) as T[], rowCount: rows.length };
    }
    if (text.includes("FROM world_item_drops") && text.includes("ST_DWithin")) {
      const center = { lat: Number(values?.[0]), lon: Number(values?.[1]) };
      const now = date(values?.[2]);
      const radiusM = Number(values?.[3]);
      const eligibleRegionCodes = values?.[4] as readonly string[] | undefined;
      const eligibleZoneIds = values?.[5] as readonly string[] | undefined;
      const rows = [...state.drops.values()]
        .filter((row) =>
          row.status === "active" &&
          row.expires_at > now &&
          (!eligibleRegionCodes?.length || eligibleRegionCodes.includes(row.region_code)) &&
          (!eligibleZoneIds?.length || eligibleZoneIds.includes(row.zone_id)) &&
          distanceMeters(center, { lat: row.lat, lon: row.lon }) <= radiusM
        )
        .sort((left, right) => left.created_at.getTime() - right.created_at.getTime());
      return { rows: rows.map(cloneDrop) as T[], rowCount: rows.length };
    }
    if (text.includes("FROM world_equipment_drops")) return { rows: [] as T[], rowCount: 0 };
    if (text.includes("FROM world_backpack_drops")) return { rows: [] as T[], rowCount: 0 };
    throw new Error(`Unhandled dropped item test query: ${text}`);
  }
}

class FakeInventoryGateway {
  constructor(private readonly database: DroppedItemTestDatabase) {}

  async snapshotInTransaction(
    queryable: object,
    playerId: string
  ): Promise<PlayerInventorySnapshot> {
    return inventorySnapshot(this.database.stateFor(queryable), playerId);
  }

  async grantItemsForOperationInTransaction(
    queryable: object,
    input: InventoryOperationInput
  ): Promise<InventoryOperationResult> {
    const state = this.database.stateFor(queryable);
    if (state.operations.has(input.operationKey)) {
      return {
        applied: false,
        grants: input.grants.map((grant) => ({
          itemId: grant.itemId,
          variant: grant.variant ?? null,
          requestedQuantity: Number(grant.quantity),
          grantedQuantity: Number(grant.quantity),
          remainderQuantity: 0
        })),
        inventory: inventorySnapshot(state, input.playerId)
      };
    }
    state.operations.set(input.operationKey, {
      playerId: input.playerId,
      source: input.source
    });
    const grantResults: InventoryOperationResult["grants"] = [];
    for (const grant of input.grants) {
      const variant = grant.variant ?? "default";
      const key = stackKey(input.playerId, grant.itemId, variant);
      const requestedQuantity = Number(grant.quantity);
      const limit = state.grantLimits.get(key);
      const quantity = Math.min(requestedQuantity, limit ?? requestedQuantity);
      if (limit !== undefined) state.grantLimits.set(key, Math.max(0, limit - quantity));
      const next = (state.stacks.get(key) ?? 0) + quantity;
      state.stacks.set(key, next);
      if (quantity > 0) {
        state.events.push({
          operationKey: input.operationKey,
          playerId: input.playerId,
          itemId: grant.itemId,
          variant,
          deltaQuantity: quantity,
          quantityAfter: next
        });
      }
      grantResults.push({
        itemId: grant.itemId,
        variant: grant.variant ?? null,
        requestedQuantity,
        grantedQuantity: quantity,
        remainderQuantity: requestedQuantity - quantity
      });
    }
    return {
      applied: true,
      grants: grantResults,
      inventory: inventorySnapshot(state, input.playerId)
    };
  }

  async debitItemsForOperationInTransaction(
    queryable: object,
    input: InventoryDebitInput
  ): Promise<InventoryOperationResult> {
    const state = this.database.stateFor(queryable);
    if (state.operations.has(input.operationKey)) {
      return {
        applied: false,
        grants: input.debits.map((debit) => ({
          itemId: debit.itemId,
          variant: debit.variant ?? null,
          requestedQuantity: Number(debit.quantity),
          grantedQuantity: Number(debit.quantity),
          remainderQuantity: 0
        })),
        inventory: inventorySnapshot(state, input.playerId)
      };
    }
    for (const debit of input.debits) {
      const variant = debit.variant ?? "default";
      const key = stackKey(input.playerId, debit.itemId, variant);
      if ((state.stacks.get(key) ?? 0) < Number(debit.quantity)) {
        throw new Error("Inventory does not contain enough items");
      }
    }
    state.operations.set(input.operationKey, {
      playerId: input.playerId,
      source: input.source
    });
    for (const debit of input.debits) {
      const variant = debit.variant ?? "default";
      const key = stackKey(input.playerId, debit.itemId, variant);
      const quantity = Number(debit.quantity);
      const next = (state.stacks.get(key) ?? 0) - quantity;
      state.stacks.set(key, next);
      state.events.push({
        operationKey: input.operationKey,
        playerId: input.playerId,
        itemId: debit.itemId,
        variant,
        deltaQuantity: -quantity,
        quantityAfter: next
      });
    }
    return {
      applied: true,
      grants: input.debits.map((debit) => ({
        itemId: debit.itemId,
        variant: debit.variant ?? null,
        requestedQuantity: Number(debit.quantity),
        grantedQuantity: Number(debit.quantity),
        remainderQuantity: 0
      })),
      inventory: inventorySnapshot(state, input.playerId)
    };
  }
}

function inventorySnapshot(state: State, playerId: string): PlayerInventorySnapshot {
  const totals = emptyInventoryTotals();
  const items = stackEntriesForPlayer(state, playerId)
    .map(([key, quantity], slotIndex) => {
      const [, itemId, variant] = key.split("\u0000");
      totals[itemId as ResourceType] += quantity;
      return {
        playerId,
        stackId: key,
        slotIndex,
        resourceType: itemId as ResourceType,
        variant: variant === "default" ? null : (variant ?? null),
        quantity
      };
    });
  return { playerId, revision: 0, items, totals };
}

function emptyState(): State {
  return {
    operations: new Map(),
    stacks: new Map(),
    grantLimits: new Map(),
    keepPolicies: new Map(),
    events: [],
    drops: new Map(),
    pickups: new Map(),
    requests: new Map(),
    movements: new Set(),
    systemSources: new Map(),
    systemContributionQuantities: new Map()
  };
}

function cloneState(state: State): State {
  return {
    operations: new Map([...state.operations].map(([key, value]) => [key, { ...value }])),
    stacks: new Map(state.stacks),
    grantLimits: new Map(state.grantLimits),
    keepPolicies: new Map(state.keepPolicies),
    events: state.events.map((event) => ({ ...event })),
    drops: new Map([...state.drops].map(([key, value]) => [key, cloneDrop(value)])),
    pickups: new Map([...state.pickups].map(([key, value]) => [key, { ...value }])),
    requests: new Map([...state.requests].map(([key, value]) => [key, {
      request_hash: value.request_hash,
      original_result: structuredClone(value.original_result)
    }])),
    movements: new Set(state.movements),
    systemSources: new Map(state.systemSources),
    systemContributionQuantities: new Map(state.systemContributionQuantities)
  };
}

function cloneDrop(row: DropRow): DropRow {
  return {
    ...row,
    created_at: new Date(row.created_at),
    expires_at: new Date(row.expires_at),
    expired_at: row.expired_at ? new Date(row.expired_at) : null,
    picked_up_at: row.picked_up_at ? new Date(row.picked_up_at) : null
  };
}

function stackKey(playerId: string, itemId: string, variant: string): string {
  return `${playerId}\u0000${itemId}\u0000${variant}`;
}

function stackEntriesForPlayer(
  state: State,
  playerId: string
): Array<[string, number]> {
  return [...state.stacks.entries()]
    .filter(([key]) => key.startsWith(`${playerId}\u0000`))
    .sort(([left], [right]) => left.localeCompare(right));
}

function date(value: unknown): Date {
  return value instanceof Date ? new Date(value) : new Date(String(value));
}

function oneResult<T>(row: unknown): { rows: T[]; rowCount: number } {
  return { rows: [{ ...(row as object) } as T], rowCount: 1 };
}

function emptyResult<T>(): { rows: T[]; rowCount: number } {
  return { rows: [], rowCount: 0 };
}
