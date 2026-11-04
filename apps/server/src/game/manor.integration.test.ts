import { randomUUID } from "node:crypto";

import {
  DEFAULT_MANOR_TEMPLATE_CATALOG,
  MANOR_STORAGE_BASE_CAPACITY_GRAMS,
  MANOR_STORAGE_CAPACITY_GRAMS,
  MANOR_STORAGE_UPGRADES,
  projectMaterialProtection
} from "@ash-atlas/shared";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../db/migrate.js";
import { randomShopTag } from "./glimmerShop.js";
import { EquipmentService } from "./equipment.js";
import { FlagService } from "./flags.js";
import { InventoryService } from "./inventory.js";
import { InventoryProtectionService } from "./inventoryProtection.js";
import { ManorPresenceService, ManorStorageService } from "./manor.js";
import { ManorDecorationService } from "./manorDecorations.js";
import { WalletService } from "./wallet.js";
import { PremiumWalletService } from "./premiumWallet.js";
import type { PlayerRecord } from "./state.js";

const databaseUrl = process.env.MANOR_TEST_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;

describeDatabase("player manor PostgreSQL integration", () => {
  let pool: pg.Pool;
  let presence: ManorPresenceService;
  let storage: ManorStorageService;
  let inventory: InventoryService;
  let equipment: EquipmentService;
  let protection: InventoryProtectionService;

  beforeAll(async () => {
    await runMigrations(databaseUrl!);
    await runMigrations(databaseUrl!);
    pool = new pg.Pool({ connectionString: databaseUrl!, max: 30 });
    const flags = new FlagService(pool, {} as never, {} as never, {} as never);
    presence = new ManorPresenceService(pool, flags);
  }, 60_000);

  beforeEach(async () => {
    await pool.query("TRUNCATE players CASCADE");
    await createPlayer(pool, "a", "Ash");
    await createPlayer(pool, "b", "Bex");
    inventory = new InventoryService(pool);
    equipment = new EquipmentService(pool);
    protection = new InventoryProtectionService(pool);
    storage = new ManorStorageService(pool, inventory, undefined, equipment);
  });

  afterAll(async () => { await pool?.end(); });

  it("creates exactly one manor under concurrent first use", async () => {
    const ids = await Promise.all(Array.from({ length: 20 }, () => presence.ensureManor("a")));
    expect(new Set(ids).size).toBe(1);
    const count = await pool.query<{ count: string }>("SELECT count(*)::text AS count FROM player_manors WHERE owner_player_id='a'");
    expect(count.rows[0]?.count).toBe("1");
    await expect(presence.status("a")).resolves.toBeNull();
  });

  it("treats new and existing pre-placement manor rows as unbuilt and rejects entry", async () => {
    await expect(presence.status("a")).resolves.toBeNull();
    await expect(presence.enter(player("a", 35, -106))).rejects.toMatchObject({ code: "MANOR_NOT_BUILT" });
    const manorId = await presence.ensureManor("a");
    await expect(presence.status("a")).resolves.toBeNull();
    await expect(presence.enter(player("a", 35, -106))).rejects.toMatchObject({ code: "MANOR_NOT_BUILT" });
    const row = await pool.query("SELECT built_at,world_lat,world_lon,geom FROM player_manors WHERE id=$1", [manorId]);
    expect(row.rows[0]).toMatchObject({ built_at: null, world_lat: null, world_lon: null, geom: null });
  });

  it("builds once at the authoritative position in personally owned territory", async () => {
    await createFlag(pool, "a", 35.123, -106.456);
    await grant("a", "wood", null, 100, "build-owned-cost");
    const authoritative = player("a", 35.123, -106.456);
    const result = await presence.build(authoritative, "build-owned");
    expect(result).toMatchObject({ replayed: false, manor: {
      ownerPlayerId: "a", ownerUsername: "Ash", regionCode: "world-test", lat: 35.123, lon: -106.456
    } });
    const world = await presence.listBuiltNear(authoritative);
    expect(world).toEqual([result.manor]);
    expect(Object.keys(world[0]!).sort()).toEqual([
      "builtAt", "lat", "lon", "manorId", "manorTypeId", "ownerPlayerId", "ownerUsername", "placementRevision", "regionCode"
    ]);
    const savedPlayer = await pool.query<{ lat: number; lon: number }>("SELECT lat,lon FROM players WHERE id='a'");
    expect(savedPlayer.rows[0]).toEqual({ lat: 35, lon: -106 });
  });

  it("charges exactly 100 wood for construction and replays without charging twice", async () => {
    await createFlag(pool, "a", 35, -106);
    await expect(presence.build(player("a", 35, -106), "build-without-wood"))
      .rejects.toMatchObject({
        code: "MANOR_INSUFFICIENT_WOOD",
        message: "Manor construction requires 100 wood."
      });
    await expect(pool.query("SELECT 1 FROM player_manors WHERE owner_player_id='a'"))
      .resolves.toMatchObject({ rowCount: 0 });

    await grant("a", "wood", null, 100, "exact-build-cost");
    const first = await presence.build(player("a", 35, -106), "exact-build");
    expect(first.replayed).toBe(false);
    const inventoryAfterBuild = await pool.query<{ quantity: string }>(
      "SELECT quantity::text FROM player_inventory WHERE player_id='a' AND resource_type='wood' AND variant='default'"
    );
    expect(inventoryAfterBuild.rows[0]?.quantity).toBe("0");

    await expect(presence.build(player("a", 35, -106), "exact-build"))
      .resolves.toEqual({ manor: first.manor, inventory: first.inventory, replayed: true });
    const debitEvents = await pool.query<{ delta: string }>(
      `SELECT delta_quantity::text AS delta
       FROM inventory_events
       WHERE player_id='a' AND source_entity_type='manor_build' AND source_entity_id=$1`,
      [first.manor.manorId]
    );
    expect(debitEvents.rows).toEqual([{ delta: "-100" }]);
  });

  it("authorizes the owner, applies sequential storage tiers, and replays upgrades idempotently", async () => {
    await attachAccount("a");
    await seedBuiltManor("a", 35, -106);
    await grant("a", "wood", null, 3_500, "upgrade-all-wood");
    await grant("a", "stone", null, 1_750, "upgrade-all-stone");
    await creditWallet("a", 55_000n, "upgrade-all-gold");

    const initial = await presence.storageUpgradeSnapshotForOwner("a");
    expect(initial).toMatchObject({
      capacityGrams: String(MANOR_STORAGE_BASE_CAPACITY_GRAMS),
      maximumLevel: 3
    });
    await expect(presence.upgradeStorage({ playerId: "b", requestId: "other-owner", targetLevel: 1 }))
      .rejects.toMatchObject({ code: "MANOR_NOT_BUILT" });
    await expect(presence.upgradeStorage({ playerId: "a", requestId: "skip-tier", targetLevel: 2 }))
      .rejects.toMatchObject({ code: "MANOR_UPGRADE_SEQUENCE" });

    const tierOne = await presence.upgradeStorage({ playerId: "a", requestId: "upgrade-tier-1", targetLevel: 1 });
    expect(tierOne).toMatchObject({
      replayed: false,
      targetLevel: 1,
      snapshot: { capacityGrams: "15000000" }
    });
    const tierOneReplay = await presence.upgradeStorage({ playerId: "a", requestId: "upgrade-tier-1", targetLevel: 1 });
    expect(tierOneReplay).toMatchObject({ replayed: true, targetLevel: 1, snapshot: { capacityGrams: "15000000" } });

    await expect(presence.upgradeStorage({ playerId: "a", requestId: "upgrade-tier-2", targetLevel: 2 }))
      .resolves.toMatchObject({ replayed: false, snapshot: { capacityGrams: "25000000" } });
    await expect(presence.upgradeStorage({ playerId: "a", requestId: "upgrade-tier-3", targetLevel: 3 }))
      .resolves.toMatchObject({ replayed: false, snapshot: { capacityGrams: "40000000" } });

    const final = await presence.storageUpgradeSnapshotForOwner("a");
    expect(final).toMatchObject({ capacityGrams: "40000000", maximumLevel: 3 });
    expect(final.upgrades).toEqual(MANOR_STORAGE_UPGRADES);
    const balances = await pool.query<{ item_id: string; quantity: string }>(
      `SELECT resource_type AS item_id,quantity::text
       FROM player_inventory WHERE player_id='a' AND resource_type IN ('wood','stone') ORDER BY resource_type`
    );
    expect(balances.rows).toEqual([
      { item_id: "stone", quantity: "0" },
      { item_id: "wood", quantity: "0" }
    ]);
    await expect(pool.query<{ gold: string }>(
      "SELECT gold_balance::text AS gold FROM player_wallets WHERE player_id='a'"
    )).resolves.toMatchObject({ rows: [{ gold: "0" }] });
    await expect(pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM manor_storage_upgrade_events WHERE player_id='a'"
    )).resolves.toMatchObject({ rows: [{ count: "3" }] });
  });

  it("rejects missing upgrade materials without spending gold", async () => {
    await attachAccount("a");
    await seedBuiltManor("a", 35, -106);
    await creditWallet("a", 5_000n, "missing-materials-gold");

    await expect(presence.upgradeStorage({ playerId: "a", requestId: "missing-materials", targetLevel: 1 }))
      .rejects.toMatchObject({ code: "MANOR_INSUFFICIENT_MATERIALS" });
    await expect(pool.query<{ gold: string }>(
      "SELECT gold_balance::text AS gold FROM player_wallets WHERE player_id='a'"
    )).resolves.toMatchObject({ rows: [{ gold: "5000" }] });
    await expect(pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM manor_storage_upgrade_operations WHERE player_id='a'"
    )).resolves.toMatchObject({ rows: [{ count: "0" }] });
  });

  it("rolls back material spending when upgrade gold is insufficient", async () => {
    await attachAccount("a");
    await seedBuiltManor("a", 35, -106);
    await grant("a", "wood", null, 500, "insufficient-gold-wood");
    await grant("a", "stone", null, 250, "insufficient-gold-stone");

    await expect(presence.upgradeStorage({ playerId: "a", requestId: "insufficient-gold", targetLevel: 1 }))
      .rejects.toMatchObject({ code: "MANOR_INSUFFICIENT_GOLD" });
    const materials = await pool.query<{ item_id: string; quantity: string }>(
      `SELECT resource_type AS item_id,quantity::text
       FROM player_inventory WHERE player_id='a' AND resource_type IN ('wood','stone') ORDER BY resource_type`
    );
    expect(materials.rows).toEqual([
      { item_id: "stone", quantity: "250" },
      { item_id: "wood", quantity: "500" }
    ]);
    await expect(pool.query<{ level: number }>(
      "SELECT storage_upgrade_level AS level FROM player_manors WHERE owner_player_id='a'"
    )).resolves.toMatchObject({ rows: [{ level: 0 }] });
    await expect(pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM manor_storage_upgrade_events WHERE player_id='a'"
    )).resolves.toMatchObject({ rows: [{ count: "0" }] });
  });

  it("rejects unclaimed and other-player territory without partial placement", async () => {
    await expect(presence.build(player("a", 35, -106), "unclaimed")).rejects.toMatchObject({
      code: "MANOR_TERRITORY_REQUIRED",
      message: "You must build your manor inside territory you own."
    });
    await createFlag(pool, "b", 35, -106);
    await expect(presence.build(player("a", 35, -106), "owned-by-b")).rejects.toMatchObject({
      code: "MANOR_TERRITORY_OWNED_BY_OTHER",
      message: "This territory belongs to another player."
    });
    const rows = await pool.query("SELECT built_at,world_region_code,world_lat,world_lon,geom FROM player_manors WHERE owner_player_id='a'");
    expect(rows.rows).toHaveLength(0);
  });

  it("serializes concurrent builds and replays the exact successful request", async () => {
    await createFlag(pool, "a", 35, -106);
    await grant("a", "wood", null, 100, "concurrent-build-cost");
    const authoritative = player("a", 35, -106);
    const attempts = await Promise.allSettled(Array.from({ length: 16 }, (_, index) =>
      presence.build(authoritative, `concurrent-${index}`)));
    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === "rejected")).toHaveLength(15);
    const count = await pool.query<{ count: string }>("SELECT count(*)::text AS count FROM player_manors WHERE owner_player_id='a' AND built_at IS NOT NULL");
    expect(count.rows[0]?.count).toBe("1");

    await pool.query("TRUNCATE players CASCADE");
    await createPlayer(pool, "a", "Ash");
    await createFlag(pool, "a", 35, -106);
    await grant("a", "wood", null, 100, "replay-build-cost");
    const first = await presence.build(authoritative, "replay-build");
    const replay = await presence.build(player("a", 36, -105), "replay-build");
    expect(replay).toEqual({ manor: first.manor, inventory: first.inventory, replayed: true });
    await expect(presence.build(authoritative, "second-manor")).rejects.toMatchObject({ code: "MANOR_ALREADY_BUILT" });
  });

  it("places the existing manor without losing its ID or storage", async () => {
    const manorId = await presence.ensureManor("a");
    await pool.query(
      "INSERT INTO manor_storage_stacks (manor_id,slot_index,item_id,variant,quantity,version) VALUES ($1,0,'wood','default',17,3)",
      [manorId]
    );
    await createFlag(pool, "a", 35, -106);
    await grant("a", "wood", null, 100, "place-preserved-cost");
    const built = await presence.build(player("a", 35, -106), "place-preserved");
    expect(built.manor.manorId).toBe(manorId);
    const stack = await pool.query<{ quantity: string; version: string }>(
      "SELECT quantity::text,version::text FROM manor_storage_stacks WHERE manor_id=$1", [manorId]
    );
    expect(stack.rows[0]).toEqual({ quantity: "17", version: "3" });
  });

  it("destroys and rebuilds the same manor at a new authoritative owned location without losing storage", async () => {
    const manorId = await presence.ensureManor("a");
    await pool.query(
      "INSERT INTO manor_storage_stacks (manor_id,slot_index,item_id,variant,quantity,version) VALUES ($1,0,'wood','default',17,3)",
      [manorId]
    );
    await createFlag(pool, "a", 35, -106);
    await grant("a", "wood", null, 100, "lifecycle-build-1-cost");
    const built = await presence.build(player("a", 35, -106), "lifecycle-build-1");
    expect(built.manor).toMatchObject({ manorId, placementRevision: 1, lat: 35, lon: -106 });
    const destroyed = await presence.destroy("a", "lifecycle-destroy-1");
    expect(destroyed).toEqual({ manorId, placementRevision: 2, ejected: [], replayed: false });
    await expect(presence.status("a")).resolves.toBeNull();
    await expect(presence.enter(player("a", 35, -106))).rejects.toMatchObject({ code: "MANOR_NOT_BUILT" });

    await createFlag(pool, "a", 35.2, -106.2);
    await grant("a", "wood", null, 100, "lifecycle-build-2-cost");
    const rebuilt = await presence.build(player("a", 35.2, -106.2), "lifecycle-build-2");
    expect(rebuilt.manor).toMatchObject({ manorId, placementRevision: 3, lat: 35.2, lon: -106.2 });
    const stack = await pool.query<{ quantity: string; version: string }>(
      "SELECT quantity::text,version::text FROM manor_storage_stacks WHERE manor_id=$1", [manorId]
    );
    expect(stack.rows[0]).toEqual({ quantity: "17", version: "3" });
    const events = await pool.query<{ event_type: string; placement_revision: string }>(
      "SELECT event_type,placement_revision::text FROM manor_placement_events WHERE manor_id=$1 ORDER BY placement_revision", [manorId]
    );
    expect(events.rows).toEqual([
      { event_type: "built", placement_revision: "1" },
      { event_type: "destroyed", placement_revision: "2" },
      { event_type: "built", placement_revision: "3" }
    ]);
  });

  it("makes placement replays lifecycle-safe and serializes destroy against build", async () => {
    await createFlag(pool, "a", 35, -106);
    await grant("a", "wood", null, 100, "old-build-cost");
    await presence.build(player("a", 35, -106), "old-build");
    const firstDestroy = await presence.destroy("a", "old-destroy");
    await expect(presence.destroy("a", "old-destroy")).resolves.toEqual({ ...firstDestroy, replayed: true });
    await expect(presence.build(player("a", 35, -106), "old-build"))
      .rejects.toMatchObject({ code: "STALE_PLACEMENT_REPLAY" });
    await grant("a", "wood", null, 100, "new-build-cost");
    const rebuilt = await presence.build(player("a", 35, -106), "new-build");
    await expect(presence.destroy("a", "old-destroy"))
      .rejects.toMatchObject({ code: "STALE_PLACEMENT_REPLAY" });
    expect((await presence.status("a"))?.placementRevision).toBe(rebuilt.manor.placementRevision);

    await grant("a", "wood", null, 100, "concurrent-build-cost");
    const concurrent = await Promise.allSettled([
      presence.destroy("a", "concurrent-destroy"),
      presence.build(player("a", 35, -106), "concurrent-build")
    ]);
    const fulfilled = concurrent.filter((result) => result.status === "fulfilled");
    expect(fulfilled.length).toBeGreaterThanOrEqual(1);
    expect(fulfilled.length).toBeLessThanOrEqual(2);
    const placement = await pool.query<{
      built_at: Date | null; world_lat: number | null; world_lon: number | null; placement_revision: string;
    }>("SELECT built_at,world_lat,world_lon,placement_revision::text FROM player_manors WHERE owner_player_id='a'");
    const current = placement.rows[0]!;
    expect(current.built_at === null).toBe(current.world_lat === null && current.world_lon === null);
    expect(Number(current.placement_revision)).toBe(rebuilt.manor.placementRevision + fulfilled.length);
  });

  it("rejects nonowner destruction and conflicting request reuse", async () => {
    await createFlag(pool, "a", 35, -106);
    await grant("a", "wood", null, 100, "build-a-cost");
    await presence.build(player("a", 35, -106), "build-a");
    await expect(presence.destroy("b", "destroy-a")).rejects.toMatchObject({ code: "MANOR_NOT_BUILT" });
    await presence.destroy("a", "destroy-a");
    await expect(presence.build(player("a", 35, -106), "destroy-a"))
      .rejects.toMatchObject({ code: "REPLAY_CONFLICT" });
  });

  it("keeps unbuilt rows out of bounded snapshots and rejects forged nonowner entry", async () => {
    await presence.ensureManor("b");
    await createFlag(pool, "a", 35, -106);
    await grant("a", "wood", null, 100, "public-marker-cost");
    const built = await presence.build(player("a", 35, -106), "public-marker");
    expect(await presence.listBuiltNear(player("a", 35, -106))).toEqual([built.manor]);
    await expect(presence.enter(player("b", 35, -106))).rejects.toMatchObject({ code: "MANOR_NOT_BUILT" });
  });

  it("captures only authoritative world return state and restores durable presence", async () => {
    await seedBuiltManor("a", 35.123, -106.456);
    const entered = await presence.enter(player("a", 35.123, -106.456));
    expect(entered).toMatchObject({ playerId: "a", returnRegionCode: "world-test", returnLat: 35.123, returnLon: -106.456 });
    await expect(presence.enter(player("a", 0, 0))).rejects.toMatchObject({ code: "ALREADY_INSIDE" });
    await expect(presence.load("a")).resolves.toEqual(entered);
    await expect(presence.reconnectAllowed(entered, false)).resolves.toBe(true);
    await expect(presence.exit("a")).resolves.toEqual(entered);
    await expect(presence.load("a")).resolves.toBeNull();
  });

  it("persists each occupant's bounded local manor position independently", async () => {
    const manorId = await seedBuiltManor("a", 35.123, -106.456);
    await presence.enter(player("a", 35.123, -106.456));
    const guestAuthorization = await presence.authorizeEntry({
      playerId: "b",
      manorId,
      activePartyMember: true,
      activeTravelInviteId: null
    });
    await presence.enter(player("b", 35.123, -106.456), guestAuthorization);

    await expect(presence.persistLocalPosition("a", manorId, 310, 320)).resolves.toBe(true);
    await expect(presence.persistLocalPosition("b", manorId, 610, 620)).resolves.toBe(true);
    await expect(presence.load("a")).resolves.toMatchObject({
      localPositionX: 310,
      localPositionY: 320
    });
    await expect(presence.load("b")).resolves.toMatchObject({
      localPositionX: 610,
      localPositionY: 620
    });
    await expect(
      presence.persistLocalPosition("a", manorId, Number.POSITIVE_INFINITY, 320)
    ).rejects.toMatchObject({ code: "INVALID_POSITION" });
  });

  it("returns only the authenticated owner's built manor in the remote read path", async () => {
    const manorId = await seedBuiltManor("a", 35, -106);
    const inserted = await pool.query<{ stack_id: string }>(
      `INSERT INTO manor_storage_stacks
        (manor_id,slot_index,item_id,variant,quantity,version)
       VALUES ($1,0,'wood','default',17,3)
       RETURNING stack_id::text`,
      [manorId]
    );

    await expect(storage.snapshotForOwner("a")).resolves.toMatchObject({
      manorId,
      stacks: [{ itemId: "wood", quantity: 17 }]
    });
    await expect(storage.snapshotForOwner("b")).rejects.toMatchObject({
      code: "MANOR_NOT_BUILT"
    });
    await expect(
      storage.moveStack("a", "remote-mutation", inserted.rows[0]!.stack_id, 1)
    ).rejects.toMatchObject({ code: "NOT_INSIDE" });
    const retained = await pool.query<{ quantity: string; version: string }>(
      `SELECT quantity::text,version::text
       FROM manor_storage_stacks WHERE manor_id=$1`,
      [manorId]
    );
    expect(retained.rows).toEqual([{ quantity: "17", version: "3" }]);
  });

  it("admits an active party guest, keeps owner storage private, and applies a temporary kick", async () => {
    const manorId = await seedBuiltManor("a", 35.123, -106.456);
    await presence.enter(player("a", 35.123, -106.456));
    const authorization = await presence.authorizeEntry({
      playerId: "b", manorId, activePartyMember: true, activeTravelInviteId: null
    });
    const guest = await presence.enter(player("b", 35.123, -106.456), authorization);
    expect(guest).toMatchObject({ ownerPlayerId: "a", accessSource: "PARTY" });
    await expect(presence.reconnectAllowed(guest, true)).resolves.toBe(true);
    await expect(presence.reconnectAllowed(guest, false)).resolves.toBe(false);
    await expect(storage.snapshotForPlayer("b")).rejects.toMatchObject({ code: "NOT_INSIDE" });
    await expect(presence.managementSnapshot("b", manorId, ["a", "b"]))
      .rejects.toMatchObject({ code: "MANOR_OWNER_REQUIRED" });
    await expect(presence.kick("a", manorId, "a"))
      .rejects.toMatchObject({ code: "MANOR_SELF_MODERATION" });
    await expect(presence.kick("a", manorId, "b")).resolves.toMatchObject({ playerId: "b" });
    await expect(presence.load("b")).resolves.toBeNull();
    await expect(presence.authorizeEntry({
      playerId: "b", manorId, activePartyMember: true, activeTravelInviteId: null
    })).rejects.toMatchObject({ code: "MANOR_TEMPORARILY_KICKED" });
    await expect(presence.isBanned(manorId, "b")).resolves.toBe(false);
  });

  it("persists ban precedence, unbans without admission, and destroys all presence and bans", async () => {
    const manorId = await seedBuiltManor("a", 35.123, -106.456);
    await presence.enter(player("a", 35.123, -106.456));
    const authorization = await presence.authorizeEntry({
      playerId: "b", manorId, activePartyMember: true, activeTravelInviteId: null
    });
    await presence.enter(player("b", 35.123, -106.456), authorization);
    await expect(presence.ban("a", manorId, "b")).resolves.toMatchObject({ playerId: "b" });
    await expect(presence.authorizeEntry({
      playerId: "b", manorId, activePartyMember: true, activeTravelInviteId: "invite"
    })).rejects.toMatchObject({ code: "MANOR_BANNED" });
    await presence.unban("a", manorId, "b");
    await expect(presence.isBanned(manorId, "b")).resolves.toBe(false);
    await expect(presence.load("b")).resolves.toBeNull();
    await presence.ban("a", manorId, "b");
    const destroyed = await presence.destroy("a", "destroy-guests");
    expect(destroyed.ejected.map(({ playerId }) => playerId)).toEqual(["a"]);
    await expect(presence.load("a")).resolves.toBeNull();
    await expect(presence.isBanned(manorId, "b")).resolves.toBe(false);
  });

  it("serves authored defaults and preserves universal placement custody across overrides", async () => {
    const manorId = await seedBuiltManor("a", 35, -106);
    await presence.enter(player("a", 35, -106));
    const decorations = new ManorDecorationService(pool);
    const bed = DEFAULT_MANOR_TEMPLATE_CATALOG.templates.find((candidate) => candidate.id === "manor_lobby")!.decorations.find((definition) =>
      definition.id === "simple_double_bed"
    )!;
    const before = await inventory.getInventorySnapshot("a");
    const initial = await decorations.snapshotForPlayer("a", manorId);
    expect(initial.placements).toEqual([
      expect.objectContaining({
        definitionId: bed.id,
        itemId: null,
        itemVariant: null,
        authoredDefault: true,
        transform: bed.transform
      })
    ]);
    expect(initial.definitions.find((entry) => entry.definition.id === bed.id))
      .toMatchObject({ ownedQuantity: 1, availableQuantity: 0 });
    const input = {
      playerId: "a",
      requestId: "free-starter-bed",
      manorSessionId: "session",
      spaceId: "manor_main_room",
      definitionId: bed.id,
      x: bed.transform.x,
      y: bed.transform.y
    } as const;

    const placed = await decorations.place(input);
    expect(placed).toMatchObject({
      replayed: false,
      placement: { definitionId: bed.id, itemId: null, itemVariant: null },
      inventory: before
    });
    expect(placed.snapshot.definitions.find((entry) => entry.definition.id === bed.id))
      .toMatchObject({ ownedQuantity: 1, availableQuantity: 0 });
    await expect(inventory.getInventorySnapshot("a")).resolves.toEqual(before);
    await expect(pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM manor_decoration_operations WHERE player_id='a' AND request_id='free-starter-bed'"
    )).resolves.toMatchObject({ rows: [{ count: "1" }] });

    await expect(decorations.place(input)).resolves.toMatchObject({ replayed: true, inventory: before });
    await expect(decorations.place({ ...input, requestId: "free-starter-bed-again" }))
      .rejects.toMatchObject({ code: "MANOR_DECORATION_UNAVAILABLE" });

    const removed = await decorations.remove({
      playerId: "a",
      requestId: "remove-free-starter-bed",
      manorSessionId: "session",
      placementId: placed.placement!.placementId
    });
    expect(removed.inventory).toEqual(before);
    await expect(inventory.getInventorySnapshot("a")).resolves.toEqual(before);
    await expect(decorations.snapshotForPlayer("a", manorId)).resolves.toMatchObject({
      placements: [expect.objectContaining({ definitionId: bed.id, authoredDefault: true })]
    });
  });

  describe("manor skins", () => {
    // Skins are tagged per-copy items (1202): the inventory variant is the copy id, the look is the type.
    const skinCopies = async (playerId: string, look: string) =>
      (await inventory.getInventorySnapshot(playerId)).items
        .filter((item) => String(item.resourceType) === "manor_skin" && item.look === look && item.quantity > 0);
    const skinCount = async (playerId: string, look: string): Promise<number> =>
      (await skinCopies(playerId, look)).length;
    const giveSkin = async (playerId: string, look: string, key: string) => {
      const copyId = randomUUID();
      await pool.query(
        `INSERT INTO shop_item_copies (copy_id,item_id,look,tag,original_buyer_player_id,original_buyer_name)
         VALUES ($1,'manor_skin',$2,$3,$4,'Tester')`,
        [copyId, look, randomShopTag(), playerId]
      );
      return inventory.grantItemsForOperation({
        operationKey: `test:${key}`, playerId, source: "manor_test_seed",
        grants: [{ itemId: "manor_skin", variant: copyId, quantity: 1 }]
      });
    };
    const debitSkin = async (playerId: string, look: string, key: string): Promise<void> => {
      // An unequipped copy first, so only the last (equipped) copy is refused.
      const copies = await skinCopies(playerId, look);
      const variant = (copies.find((item) => !item.equipped) ?? copies[0])?.variant ?? randomUUID();
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await inventory.debitItemsForOperationInTransaction(client, {
          operationKey: `test:${key}`, playerId, source: "manor_test_drop",
          debits: [{ itemId: "manor_skin", variant, quantity: 1 }]
        });
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    };
    const manorType = async (manorId: string): Promise<string> =>
      (await pool.query<{ manor_type_id: string }>("SELECT manor_type_id FROM player_manors WHERE id=$1", [manorId])).rows[0]!.manor_type_id;

    const equip = async (requestId: string, manorTypeId: string) => {
      const copyId = manorTypeId === "manor_lobby"
        ? null
        : (await skinCopies("a", manorTypeId))[0]?.variant ?? randomUUID();
      return presence.equipSkin({ playerId: "a", requestId, manorTypeId, copyId });
    };

    it("equips and unequips a skin that stays in the inventory, replays, and refuses missing skins", async () => {
      const manorId = await seedBuiltManor("a", 35, -106);
      await expect(equip("no-skin", "samurai_manor")).rejects.toMatchObject({ code: "MANOR_SKIN_NOT_OWNED" });
      await giveSkin("a", "samurai_manor", "skin-a");
      const equipped = await equip("equip-1", "samurai_manor");
      expect(equipped).toMatchObject({ replayed: false, ownerRespawn: null, manor: { manorId, manorTypeId: "samurai_manor" } });
      expect(await skinCount("a", "samurai_manor")).toBe(1);
      await expect(equip("equip-1", "samurai_manor")).resolves.toMatchObject({ replayed: true });
      await expect(equip("equip-1", "manor_lobby")).rejects.toMatchObject({ code: "REPLAY_CONFLICT" });
      // Equipping another skin just switches; the first stays in the inventory, unequipped.
      await giveSkin("a", "haunted_manor", "skin-h");
      await equip("equip-2", "haunted_manor");
      expect(await manorType(manorId)).toBe("haunted_manor");
      expect(await skinCount("a", "samurai_manor")).toBe(1);
      expect(await skinCount("a", "haunted_manor")).toBe(1);
      await debitSkin("a", "samurai_manor", "drop-unequipped");
      expect(await skinCount("a", "samurai_manor")).toBe(0);
      const unequipped = await equip("unequip-1", "manor_lobby");
      expect(unequipped.message).toMatch(/unequipped/u);
      expect(await manorType(manorId)).toBe("manor_lobby");
      expect(await skinCount("a", "haunted_manor")).toBe(1);
      await debitSkin("a", "haunted_manor", "drop-after-unequip");
      expect(await skinCount("a", "haunted_manor")).toBe(0);
    });

    it("keeps an equipped skin in the inventory against every removal path", async () => {
      const manorId = await seedBuiltManor("a", 35, -106);
      await giveSkin("a", "samurai_manor", "skin-lock");
      await equip("lock", "samurai_manor");
      // Debits (drop, market listing, gift, bulk store all debit through here) refuse with the reason.
      await expect(debitSkin("a", "samurai_manor", "drop-equipped")).rejects.toMatchObject({
        code: "INVENTORY_ITEM_EQUIPPED", message: expect.stringMatching(/equipped on your Manor. Unequip it first/u)
      });
      // Drop, city warehouse and death drops read it as protected, with the reason.
      const allocation = await protection.snapshot("a");
      expect(allocation.stackAllocations.find((stack) => stack.itemId === "manor_skin")).toMatchObject({
        status: "protected", movableQuantity: 0, reason: expect.stringMatching(/Unequip it first/u)
      });
      // Any direct, otherwise well-formed write is refused by the database at commit.
      const raw = await pool.connect();
      try {
        await raw.query("BEGIN");
        await raw.query("INSERT INTO inventory_operations (operation_key,player_id,source) VALUES ('test:raw-remove','a','manor_test_raw')");
        const row = await raw.query<{ quantity: string; version: string; variant: string }>(
          `UPDATE player_inventory SET quantity=quantity-1,version=version+1
           WHERE player_id='a' AND resource_type='manor_skin'
             AND variant=(SELECT skin_copy_id FROM player_manors WHERE owner_player_id='a')
           RETURNING quantity::text,version::text,variant`
        );
        await raw.query(
          `INSERT INTO inventory_events (operation_key,player_id,item_id,variant,delta_quantity,quantity_after,version_after,source)
           VALUES ('test:raw-remove','a','manor_skin',$3,-1,$1,$2,'manor_test_raw')`,
          [row.rows[0]!.quantity, row.rows[0]!.version, row.rows[0]!.variant]
        );
        await expect(raw.query("COMMIT")).rejects.toMatchObject({ constraint: "player_manor_skin_equipped" });
      } finally {
        await raw.query("ROLLBACK").catch(() => undefined);
        raw.release();
      }
      await expect(pool.query("UPDATE player_manors SET manor_type_id='haunted_manor' WHERE id=$1", [manorId]))
        .rejects.toMatchObject({ constraint: "player_manor_skin_equipped" });
      expect(await skinCount("a", "samurai_manor")).toBe(1);
      // A second copy may leave; the last one may not.
      await giveSkin("a", "samurai_manor", "skin-lock-2");
      await debitSkin("a", "samurai_manor", "drop-spare");
      expect(await skinCount("a", "samurai_manor")).toBe(1);
      await expect(debitSkin("a", "samurai_manor", "drop-last")).rejects.toMatchObject({ code: "INVENTORY_ITEM_EQUIPPED" });
    });

    it("never leaves a skin equipped without owning it under concurrent equip and drop", async () => {
      const manorId = await seedBuiltManor("a", 35, -106);
      for (let round = 0; round < 6; round += 1) {
        await giveSkin("a", "samurai_manor", `race-skin-${round}`);
        const results = await Promise.allSettled([
          equip(`race-equip-${round}`, "samurai_manor"),
          debitSkin("a", "samurai_manor", `race-drop-${round}`)
        ]);
        const equippedNow = await manorType(manorId) === "samurai_manor";
        const held = await skinCount("a", "samurai_manor");
        // Exactly one side wins: equipped and kept, or dropped and not equipped.
        expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
        expect(equippedNow ? held : 1 - held).toBe(1);
        if (equippedNow) await equip(`race-reset-${round}`, "manor_lobby");
        if (held) await debitSkin("a", "samurai_manor", `race-clean-${round}`);
      }
    });

    it("refuses while guests are inside and moves an owner inside to the new lobby spawn", async () => {
      const manorId = await seedBuiltManor("a", 35, -106);
      await giveSkin("a", "samurai_manor", "skin-inside");
      await presence.enter(player("a", 35, -106));
      await pool.query(
        `UPDATE players SET location_kind='interior',location_type='manor',location_id=$1,location_instance_id=$1,
           location_space_id='upstairs_room_2',location_local_x=10,location_local_y=10,last_portal_id='test'
         WHERE id='a'`,
        [manorId]
      );
      const before = await pool.query<{ location_revision: string }>("SELECT location_revision::text FROM players WHERE id='a'");
      await pool.query(
        `INSERT INTO player_manor_presence (player_id,manor_id,access_source,return_region_code,return_lat,return_lon)
         VALUES ('b',$1,'PARTY','world-test',35,-106)`,
        [manorId]
      );
      await expect(equip("guests", "samurai_manor")).rejects.toMatchObject({ code: "MANOR_OCCUPIED" });
      expect(await manorType(manorId)).toBe("manor_lobby");
      await pool.query("DELETE FROM player_manor_presence WHERE player_id='b'");
      const switched = await equip("owner-inside", "samurai_manor");
      expect(switched.ownerRespawn).toEqual({ manorId, manorTypeId: "samurai_manor" });
      const location = await pool.query<{ location_space_id: string; location_local_x: number; location_revision: string }>(
        "SELECT location_space_id,location_local_x,location_revision::text FROM players WHERE id='a'"
      );
      expect(location.rows[0]).toMatchObject({ location_space_id: "manor_main_room" });
      expect(Number(location.rows[0]!.location_revision)).toBe(Number(before.rows[0]!.location_revision) + 1);
      // The presence row falls back to the normal spawn of the new type.
      const inside = await pool.query<{ local_position_x: number | null }>(
        "SELECT local_position_x FROM player_manor_presence WHERE player_id='a'"
      );
      expect(inside.rows[0]!.local_position_x).toBeNull();
    });

    it("hides decorations of an unequipped skin and restores them when it is equipped again", async () => {
      const manorId = await seedBuiltManor("a", 35, -106);
      await giveSkin("a", "samurai_manor", "skin-d");
      await equip("d-1", "samurai_manor");
      await presence.enter(player("a", 35, -106));
      const decorations = new ManorDecorationService(pool);
      const placed = await decorations.place({
        playerId: "a", requestId: "bed-in-private-room", manorSessionId: "session",
        spaceId: "samurai_manor_room_2", definitionId: "simple_double_bed", x: 600, y: 600
      });
      expect(placed.placement).toMatchObject({ roomId: "samurai_manor_room_2", surfaceId: "floor" });
      await expect(decorations.place({
        playerId: "a", requestId: "bed-in-other-type", manorSessionId: "session",
        spaceId: "upstairs_room_2", definitionId: "simple_double_bed", x: 600, y: 600
      })).rejects.toMatchObject({ code: "MANOR_DECORATION_INVALID" });
      await presence.exit("a");
      // Switching is allowed with decorations placed; they stay stored but hidden.
      await equip("d-2", "manor_lobby");
      await presence.enter(player("a", 35, -106));
      const timber = await decorations.snapshotForPlayer("a", manorId);
      expect(timber.placements.some((placement) => placement.placementId === placed.placement!.placementId)).toBe(false);
      expect(timber.placements.every((placement) => !placement.roomId.startsWith("samurai_manor"))).toBe(true);
      await presence.exit("a");
      await equip("d-3", "samurai_manor");
      await presence.enter(player("a", 35, -106));
      const samurai = await decorations.snapshotForPlayer("a", manorId);
      expect(samurai.placements.filter((placement) => placement.placementId === placed.placement!.placementId)).toHaveLength(1);
      const stored = await pool.query<{ count: string }>("SELECT count(*)::text AS count FROM manor_decoration_placements WHERE manor_id=$1", [manorId]);
      expect(stored.rows[0]!.count).toBe("1");
    });
  });

  it("upgrades a populated legacy decoration row and is empty on the second run", async () => {
    const manorId = await seedBuiltManor("a", 35, -106);
    await pool.query(
      `INSERT INTO manor_decoration_placements
         (manor_id,definition_id,item_id,item_variant,room_id,surface_id,x,y,rotation_deg,width,height,scale_x,scale_y,anchor_x,anchor_y)
       VALUES ($1,'decoration','wood','default','manor_lobby_room','floor_surface',224,347,0,120,120,3.5,3.5,.5,.5)`,
      [manorId]
    );
    await pool.query("DELETE FROM schema_migrations WHERE version='0844_manor_universal_starter_decorations.sql'");

    await expect(runMigrations(databaseUrl!)).resolves.toEqual([
      "0844_manor_universal_starter_decorations.sql"
    ]);
    await expect(pool.query<{ definition_id: string; item_id: string | null; item_variant: string | null }>(
      `SELECT definition_id,item_id,item_variant
       FROM manor_decoration_placements WHERE manor_id=$1`,
      [manorId]
    )).resolves.toMatchObject({ rows: [{ definition_id: "simple_double_bed", item_id: null, item_variant: null }] });
    await expect(runMigrations(databaseUrl!)).resolves.toEqual([]);
  }, 60_000);

  describe("authoritative manor storage", () => {
    it("keeps the historical count for compatibility while accepting any nonnegative position", async () => {
      await enterA();
      const empty = await storage.snapshotForPlayer("a");
      expect(empty).toMatchObject({ unlockedSlots: 60, stacks: [] });
      await grant("a", "wood", null, 2, "slot-seed");
      await storage.transfer(await transfer("slot-store", "deposit", "wood", null, 2));
      const stack = (await storage.snapshotForPlayer("a")).stacks[0]!;
      await expect(storage.moveStack("a", "slot-59", stack.stackId, 59))
        .resolves.toMatchObject({ storage: { stacks: [expect.objectContaining({ slotIndex: 59 })] } });
      await expect(storage.moveStack("a", "slot-60", stack.stackId, 60))
        .resolves.toMatchObject({ storage: { stacks: [expect.objectContaining({ slotIndex: 60 })] } });
    });

    it("fills compatible automatic stacks first and splits at item maxStack", async () => {
      await enterA();
      await grant("a", "iron_bar", null, 75, "stack-seed");
      await storage.bulkTransfer("a", "stack-store", "deposit");
      expect((await storage.snapshotForPlayer("a")).stacks.map((stack) => ({
        slot: stack.slotIndex, quantity: stack.quantity, manual: stack.manualSplit
      }))).toEqual([
        { slot: 0, quantity: 50, manual: false },
        { slot: 1, quantity: 25, manual: false }
      ]);
    });

    it("normalizes grandfathered oversized stacks on open without changing the total", async () => {
      await enterA();
      const manorId = (await storage.snapshotForPlayer("a")).manorId;
      try {
        await pool.query("UPDATE item_definitions SET max_stack=1000 WHERE item_id='iron_bar'");
        await pool.query(
          `INSERT INTO manor_storage_stacks
             (manor_id,slot_index,item_id,variant,quantity)
           VALUES ($1,0,'iron_bar','default',125)`,
          [manorId]
        );
      } finally {
        await pool.query("UPDATE item_definitions SET max_stack=50 WHERE item_id='iron_bar'");
      }

      const normalized = await storage.snapshotForPlayer("a");
      expect(normalized.stacks.map(({ quantity }) => quantity)).toEqual([50, 50, 25]);
      expect(normalized.stacks.reduce((total, stack) => total + stack.quantity, 0)).toBe(125);
      await expect(storage.snapshotForPlayer("a")).resolves.toEqual(normalized);
    });

    it("reorganizes legacy automatic stacks to current limits without absorbing manual splits or variants", async () => {
      await enterA();
      const manorId = (await storage.snapshotForPlayer("a")).manorId;
      const inserted = await pool.query<{
        stack_id: string;
        slot_index: number;
      }>(
        `INSERT INTO manor_storage_stacks (
           manor_id,slot_index,item_id,variant,quantity,manual_split
         ) VALUES
           ($1,0,'wood','default',200,false),
           ($1,1,'wood','default',200,false),
           ($1,2,'wood','default',100,true),
           ($1,3,'wood','oak',125,false)
         RETURNING stack_id::text,slot_index`,
        [manorId]
      );
      const bySlot = new Map(inserted.rows.map((row) => [row.slot_index, row.stack_id]));

      const reorganized = await storage.reorganize("a", "legacy-stack-reorganize");

      expect(reorganized.storage.stacks.map((stack) => ({
        stackId: stack.stackId,
        variant: stack.variant,
        quantity: stack.quantity,
        manual: stack.manualSplit,
        slot: stack.slotIndex
      }))).toEqual([
        { stackId: bySlot.get(0), variant: null, quantity: 400, manual: false, slot: 0 },
        { stackId: bySlot.get(3), variant: "oak", quantity: 125, manual: false, slot: 1 },
        { stackId: bySlot.get(2), variant: null, quantity: 100, manual: true, slot: 2 }
      ]);
      expect(reorganized.storage.stacks.reduce((total, stack) => total + stack.quantity, 0))
        .toBe(625);
      expect(reorganized.storage.stacks.some((stack) => stack.stackId === bySlot.get(1)))
        .toBe(false);
      const consolidationEvents = await pool.query<{
        stack_id: string;
        quantity_after: string | null;
        deleted: boolean;
      }>(
        `SELECT event.stack_id::text,event.quantity_after::text,
                (event.metadata->>'deleted')::boolean AS deleted
         FROM manor_storage_stack_events event
         JOIN manor_storage_operations operation USING (operation_key)
         WHERE operation.player_id='a' AND operation.request_id='legacy-stack-reorganize'`,
      );
      expect(consolidationEvents.rows).toEqual(expect.arrayContaining([
        expect.objectContaining({
          stack_id: bySlot.get(0),
          quantity_after: "400",
          deleted: false
        }),
        expect.objectContaining({
          stack_id: bySlot.get(1),
          quantity_after: null,
          deleted: true
        })
      ]));
      const eventCount = consolidationEvents.rowCount;
      await expect(storage.reorganize("a", "legacy-stack-reorganize"))
        .resolves.toMatchObject({ replayed: true, storage: reorganized.storage });
      await expect(pool.query<{ count: number }>(
        `SELECT count(*)::integer AS count
         FROM manor_storage_stack_events event
         JOIN manor_storage_operations operation USING (operation_key)
         WHERE operation.player_id='a' AND operation.request_id='legacy-stack-reorganize'`
      )).resolves.toMatchObject({ rows: [{ count: eventCount }] });
    });

    it("splits, restacks, moves, swaps, and reorganizes without changing identity or totals", async () => {
      await enterA();
      await grant("a", "wood", null, 40, "controls-wood");
      await grant("a", "water", "fresh", 5, "controls-water");
      await storage.bulkTransfer("a", "controls-store", "deposit");
      let snapshot = await storage.snapshotForPlayer("a");
      const wood = snapshot.stacks.find((stack) => stack.itemId === "wood")!;
      await storage.splitStack("a", "controls-split", wood.stackId, 10);
      snapshot = await storage.snapshotForPlayer("a");
      const manual = snapshot.stacks.find((stack) => stack.manualSplit)!;
      expect(manual).toMatchObject({ quantity: 10, slotIndex: 2 });
      const water = snapshot.stacks.find((stack) => stack.itemId === "water")!;
      await storage.moveStack("a", "controls-swap", manual.stackId, water.slotIndex);
      const swapped = await storage.snapshotForPlayer("a");
      expect(swapped.stacks.find((stack) => stack.stackId === manual.stackId)?.slotIndex)
        .toBe(water.slotIndex);
      await storage.restackStack("a", "controls-restack", manual.stackId);
      const beforeReorganize = await storage.snapshotForPlayer("a");
      const identities = beforeReorganize.stacks.map((stack) => [
        stack.stackId, stack.quantity, stack.manualSplit
      ]).sort();
      await storage.reorganize("a", "controls-reorganize");
      const reorganized = await storage.snapshotForPlayer("a");
      expect(reorganized.stacks.map((stack) => stack.slotIndex)).toEqual([0, 1]);
      expect(reorganized.stacks.map((stack) => [
        stack.stackId, stack.quantity, stack.manualSplit
      ]).sort()).toEqual(identities);
      expect(reorganized.stacks.map((stack) => stack.itemId)).toEqual(["water", "wood"]);
    });

    it("reorganizes materials around stored equipment with replay, rollback, and conservation", async () => {
      await enterA();
      await grant("a", "wood", null, 10, "mixed-reorganize-wood");
      await storage.transfer(await transfer(
        "mixed-reorganize-store-wood",
        "deposit",
        "wood",
        null,
        10
      ));
      const starter = await equipment.ensureStarterLoadout("a");
      const bow = starter.equipment.instances.find(
        (item) => item.definitionId === "starter_bow"
      )!;
      const storedEquipment = await storage.transferEquipment({
        playerId: "a",
        requestId: "mixed-reorganize-store-equipment",
        direction: "deposit",
        equipmentInstanceId: bow.instanceId
      });
      expect(storedEquipment.storage.equipment).toEqual([
        expect.objectContaining({
          equipmentInstanceId: bow.instanceId,
          slotIndex: 1
        })
      ]);
      await grant("a", "water", "fresh", 5, "mixed-reorganize-water");
      await storage.transfer(await transfer(
        "mixed-reorganize-store-water",
        "deposit",
        "water",
        "fresh",
        5
      ));
      const beforeMove = await storage.snapshotForPlayer("a");
      const wood = beforeMove.stacks.find((stack) => stack.itemId === "wood")!;
      await storage.splitStack(
        "a",
        "mixed-reorganize-manual-split",
        wood.stackId,
        3
      );
      await storage.moveStack("a", "mixed-reorganize-scatter", wood.stackId, 10);
      const before = await storage.snapshotForPlayer("a");
      const identities = before.stacks.map((stack) => [
        stack.stackId,
        stack.quantity,
        stack.manualSplit
      ]).sort();
      const totals = {
        wood: await combinedTotal("a", "wood", "default"),
        water: await combinedTotal("a", "water", "fresh")
      };

      const reorganized = await storage.reorganize("a", "mixed-reorganize");
      expect(reorganized.storage.equipment).toEqual([
        expect.objectContaining({
          equipmentInstanceId: bow.instanceId,
          slotIndex: 1
        })
      ]);
      expect(reorganized.storage.stacks.map(({ itemId, slotIndex }) => ({
        itemId,
        slotIndex
      }))).toEqual([
        { itemId: "water", slotIndex: 0 },
        { itemId: "wood", slotIndex: 1 },
        { itemId: "wood", slotIndex: 2 }
      ]);
      expect(reorganized.storage.stacks.find((stack) => stack.slotIndex === 2))
        .toMatchObject({ itemId: "wood", quantity: 3, manualSplit: true });
      expect(reorganized.storage.stacks.map((stack) => [
        stack.stackId,
        stack.quantity,
        stack.manualSplit
      ]).sort()).toEqual(identities);
      expect(await combinedTotal("a", "wood", "default")).toBe(totals.wood);
      expect(await combinedTotal("a", "water", "fresh")).toBe(totals.water);

      const eventsBeforeReplay = await pool.query<{ count: number }>(
        "SELECT count(*)::integer AS count FROM manor_storage_stack_events"
      );
      const replay = await storage.reorganize("a", "mixed-reorganize");
      expect(replay).toMatchObject({
        replayed: true,
        storage: reorganized.storage
      });
      const eventsAfterReplay = await pool.query<{ count: number }>(
        "SELECT count(*)::integer AS count FROM manor_storage_stack_events"
      );
      expect(eventsAfterReplay.rows[0]?.count).toBe(eventsBeforeReplay.rows[0]?.count);

      const reorganizedWood = reorganized.storage.stacks.find(
        (stack) => stack.itemId === "wood"
      )!;
      await storage.moveStack(
        "a",
        "mixed-reorganize-rollback-scatter",
        reorganizedWood.stackId,
        10
      );
      const beforeRollback = await storage.snapshotForPlayer("a");
      const failing = new ManorStorageService(
        pool,
        inventory,
        (point) => {
          if (point === "after-destination-write") throw new Error("injected failure");
        },
        equipment
      );
      await expect(failing.reorganize("a", "mixed-reorganize-rollback"))
        .rejects.toThrow("injected failure");
      await expect(storage.snapshotForPlayer("a")).resolves.toEqual(beforeRollback);
      expect(await combinedTotal("a", "wood", "default")).toBe(totals.wood);
      expect(await combinedTotal("a", "water", "fresh")).toBe(totals.water);
      const rolledBackOperation = await pool.query(
        `SELECT 1
         FROM manor_storage_operations
         WHERE player_id='a' AND request_id='mixed-reorganize-rollback'`
      );
      expect(rolledBackOperation.rowCount).toBe(0);
    });

    it("stores legacy equipped backpacks and preserves identity through replay and withdrawal", async () => {
      await enterA();
      await grant("a", "wood", null, 1, "backpack-storage-wood");
      await storage.transfer(await transfer(
        "backpack-storage-store-wood",
        "deposit",
        "wood",
        null,
        1
      ));
      const operationKey = "test:backpack-storage-create";
      const created = await pool.query<{ instance_id: string }>(
        `WITH operation AS (
           INSERT INTO backpack_operations (
             operation_key,player_id,account_id,request_id,action,request_hash
           ) VALUES ($1,'a','test-account','backpack-storage-create','create',$2)
           RETURNING operation_key
         )
         INSERT INTO player_backpack_instances (
           owner_player_id,definition_id,location,inventory_slot_index,created_by_operation_key
         )
         SELECT 'a','starter_backpack','inventory',NULL,operation_key FROM operation
         RETURNING instance_id::text`,
        [operationKey, "0".repeat(64)]
      );
      const instanceId = created.rows[0]!.instance_id;

      const stored = await storage.transferBackpack({
        playerId: "a",
        requestId: "backpack-storage-deposit",
        direction: "deposit",
        backpackInstanceId: instanceId
      });
      expect(stored.storage.backpacks).toEqual([
        expect.objectContaining({
          backpackInstanceId: instanceId,
          slotIndex: 1,
          backpack: expect.objectContaining({
            instanceId,
            definitionId: "starter_backpack",
            location: "manor_storage"
          })
        })
      ]);
      await expect(storage.transferBackpack({
        playerId: "a",
        requestId: "backpack-storage-deposit",
        direction: "deposit",
        backpackInstanceId: instanceId
      })).resolves.toMatchObject({ replayed: true });

      const taken = await storage.transferBackpack({
        playerId: "a",
        requestId: "backpack-storage-withdraw",
        direction: "withdrawal",
        backpackInstanceId: instanceId
      });
      expect(taken.backpacks!.instances).toEqual([
        expect.objectContaining({
          instanceId,
          location: "inventory"
        })
      ]);
      expect(taken.storage.backpacks).toEqual([]);

      await pool.query(
        `UPDATE player_backpack_instances
         SET location='equipped',inventory_slot_index=NULL,equipped_slot=0
         WHERE instance_id=$1::uuid`,
        [instanceId]
      );
      const storedLegacyEquipped = await storage.transferBackpack({
        playerId: "a",
        requestId: "backpack-storage-equipped-compatible",
        direction: "deposit",
        backpackInstanceId: instanceId
      });
      expect(storedLegacyEquipped.storage.backpacks).toEqual([
        expect.objectContaining({
          backpackInstanceId: instanceId,
          backpack: expect.objectContaining({
            instanceId,
            location: "manor_storage"
          })
        })
      ]);
    });

    it("debits the exact selected inventory entry and never a compatible variant", async () => {
      await enterA();
      await grant("a", "wood", null, 20, "exact-seed");
      await grant("a", "wood", "weathered", 7, "exact-compatible-variant-seed");
      const chosen = await playerStackFor("a", "wood", "default");
      const other = await playerStackFor("a", "wood", "weathered");
      await storage.transfer({
        playerId: "a",
        requestId: "exact-store",
        direction: "deposit",
        sourceStackId: chosen.stack_id,
        quantity: 3
      });
      const after = await playerStacksFor("a", "wood", "default");
      expect(after.find((stack) => stack.stack_id === chosen.stack_id)?.quantity).toBe("17");
      expect((await playerStacksFor("a", "wood", "weathered"))
        .find((stack) => stack.stack_id === other.stack_id)?.quantity).toBe(other.quantity);
      expect(await combinedTotal("a", "wood", "default")).toBe(20);
      expect(await combinedTotal("a", "wood", "weathered")).toBe(7);
    });

    it("bulk Store All and Take All are atomic and report partial destination capacity", async () => {
      await enterA();
      await grant("a", "wood", null, 600, "bulk-seed");
      const stored = await storage.bulkTransfer("a", "bulk-store", "deposit");
      expect(stored.transfer).toMatchObject({
        stacksRequested: 1, stacksMoved: 1, quantityMoved: 600, partial: false
      });
      expect(await combinedTotal("a", "wood", "default")).toBe(600);

      const initialStorage = await storage.snapshotForPlayer("a");
      const waterDefinition = await pool.query<{ unit_weight_grams: string }>(
        "SELECT unit_weight_grams::text FROM item_definitions WHERE item_id='water'"
      );
      const waterWeight = BigInt(waterDefinition.rows[0]!.unit_weight_grams);
      const targetWeight = BigInt(initialStorage.maximumWeightGrams!) - 25_000n;
      const waterQuantity = (targetWeight - BigInt(initialStorage.currentWeightGrams!)) / waterWeight;
      await pool.query(
        `WITH definition AS (
           SELECT max_stack::bigint FROM item_definitions WHERE item_id='water'
         ), desired AS (
           SELECT $2::bigint AS quantity, max_stack FROM definition
         ), parts AS (
           SELECT generate_series(0::bigint, ((quantity + max_stack - 1) / max_stack) - 1) AS part,
                  quantity,max_stack
           FROM desired WHERE quantity > 0
         )
         INSERT INTO manor_storage_stacks
           (manor_id,slot_index,item_id,variant,quantity,manual_split)
         SELECT manor.id,1000 + parts.part::integer,'water','fresh',
                LEAST(parts.max_stack,parts.quantity - (parts.part * parts.max_stack)),false
         FROM player_manors manor CROSS JOIN parts
         WHERE manor.owner_player_id=$1`,
        ["a", waterQuantity.toString()]
      );
      await grant("a", "wood", null, 500, "bulk-partial-seed");
      const partial = await storage.bulkTransfer("a", "bulk-partial", "deposit");
      expect(partial.transfer).toMatchObject({
        partial: true,
        capacityReason: "Manor Storage is full."
      });
      expect(partial.transfer!.quantityMoved).toBeGreaterThan(0);
      expect(partial.transfer!.quantityRemaining).toBeGreaterThan(0);
      expect(BigInt(partial.storage.currentWeightGrams!)).toBeLessThanOrEqual(BigInt(MANOR_STORAGE_CAPACITY_GRAMS));
    });

    it("replays once, rejects request conflicts, and rolls back both sides after injected failures", async () => {
      await enterA();
      await grant("a", "wood", null, 10, "replay-seed");
      const request = await transfer("same", "deposit", "wood", null, 3);
      const first = await storage.transfer(request);
      const replay = await storage.transfer(request);
      expect(first.replayed).toBe(false);
      expect(replay.replayed).toBe(true);
      await expect(storage.transfer({ ...request, quantity: 4 }))
        .rejects.toMatchObject({ code: "REPLAY_CONFLICT" });
      const before = await combinedTotal("a", "wood", "default");
      const source = await playerStackFor("a", "wood", "default");
      const failing = new ManorStorageService(pool, inventory, (point) => {
        if (point === "after-inventory-debit") throw new Error("injected failure");
      });
      await expect(failing.transfer({
        playerId: "a",
        requestId: "rollback",
        direction: "deposit",
        sourceStackId: source.stack_id,
        quantity: 2
      })).rejects.toThrow("injected failure");
      expect(await combinedTotal("a", "wood", "default")).toBe(before);
    });

    it("serializes opposite-direction transfers without losing or duplicating quantity", async () => {
      await enterA();
      await grant("a", "wood", null, 100, "concurrent-seed");
      await storage.transfer(await transfer("concurrent-initial", "deposit", "wood", null, 50));
      const operations = Array.from({ length: 8 }, async (_, index) => {
        const playerSource = await playerStackFor("a", "wood", "default");
        const manorSource = (await storage.snapshotForPlayer("a")).stacks
          .find((stack) => stack.itemId === "wood")!;
        return Promise.all([
          storage.transfer({
            playerId: "a", requestId: `concurrent-store-${index}`, direction: "deposit",
            sourceStackId: playerSource.stack_id, quantity: 1
          }),
          storage.transfer({
            playerId: "a", requestId: `concurrent-take-${index}`, direction: "withdrawal",
            sourceStackId: manorSource.stackId, quantity: 1
          })
        ]);
      });
      await Promise.all(operations);
      expect(await combinedTotal("a", "wood", "default")).toBe(100);
      const ghosts = await pool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM manor_storage_stacks WHERE quantity<=0"
      );
      expect(ghosts.rows[0]?.count).toBe("0");
    }, 30_000);

    it("keeps owner storage private and makes the new audit trail immutable", async () => {
      await enterA();
      await grant("a", "wood", null, 3, "private-seed");
      await storage.transfer(await transfer("private-store", "deposit", "wood", null, 3));
      await seedBuiltManor("b", 36, -105);
      await presence.enter(player("b", 36, -105));
      expect((await storage.snapshotForPlayer("b")).stacks).toEqual([]);
      await expect(pool.query(
        "UPDATE manor_storage_stack_events SET metadata='{}' WHERE player_id='a'"
      )).rejects.toThrow(/append-only/);
    });

    it("preserves deterministic material keep amounts across exact and replay-safe bulk stores", async () => {
      await enterA();
      await grant("a", "wood", null, 2_000, "protected-wood");

      const updated = await protection.setMaterialKeep({
        playerId: "a",
        requestId: "keep-wood-500",
        itemId: "wood",
        variant: null,
        keepQuantity: 500,
        expectedRevision: 0
      });
      expect(updated.protection.stackAllocations.map((allocation) => ({
        slot: allocation.stackId,
        protected: allocation.protectedQuantity,
        movable: allocation.movableQuantity
      }))).toEqual([
        expect.objectContaining({ protected: 500, movable: 1_500 })
      ]);
      expect(updated.protection.stackAllocations).toEqual(
        projectMaterialProtection(
          await inventory.getInventorySnapshot("a"),
          updated.protection.materialPolicies
        ).stackAllocations
      );
      await expect(protection.setMaterialKeep({
        playerId: "a",
        requestId: "keep-wood-500",
        itemId: "wood",
        variant: null,
        keepQuantity: 500,
        expectedRevision: 0
      })).resolves.toMatchObject({ replayed: true });
      await expect(protection.setMaterialKeep({
        playerId: "a",
        requestId: "stale-keep",
        itemId: "wood",
        variant: null,
        keepQuantity: 100,
        expectedRevision: 0
      })).rejects.toMatchObject({ code: "INVENTORY_PROTECTION_STALE_REVISION" });

      const protectedStack = updated.protection.stackAllocations[0]!;
      await expect(storage.transfer({
        playerId: "a",
        requestId: "exact-protected-store",
        direction: "deposit",
        sourceStackId: protectedStack.stackId,
        quantity: 1_501
      })).rejects.toMatchObject({ code: "ITEM_PROTECTED" });

      const bulk = await storage.bulkTransfer("a", "bulk-protected-store", "deposit");
      expect(bulk.transfer).toMatchObject({
        quantityRequested: 2_000,
        quantityMoved: 1_500,
        quantityRemaining: 500,
        partial: true
      });
      expect(bulk.inventory.totals.wood).toBe(500);
      expect(bulk.inventory.items).toEqual([
        expect.objectContaining({
          stackId: protectedStack.stackId,
          quantity: 500
        })
      ]);
      expect(bulk.storage.stacks.reduce((sum, stack) => sum + stack.quantity, 0)).toBe(1_500);

      const replay = await storage.bulkTransfer("a", "bulk-protected-store", "deposit");
      expect(replay).toMatchObject({ replayed: true });
      expect(replay.inventory.totals.wood).toBe(500);
      expect(replay.storage.stacks.reduce((sum, stack) => sum + stack.quantity, 0)).toBe(1_500);
      await expect(pool.query(
        "UPDATE inventory_protection_events SET next_value='{}' WHERE player_id='a'"
      )).rejects.toThrow(/append-only/);
    });

    it("skips ineligible gear and preserves equipment identity, level, slots, and audit history", async () => {
      await enterA();
      const starter = await equipment.ensureStarterLoadout("a");
      const bow = starter.equipment.instances.find(
        (item) => item.definitionId === "starter_bow"
      )!;
      const staff = starter.equipment.instances.find(
        (item) => item.definitionId === "starter_staff"
      )!;
      await pool.query(
        "UPDATE equipment_instances SET item_level=7 WHERE instance_id=$1::uuid",
        [bow.instanceId]
      );
      await protection.setUniqueProtection({
        playerId: "a",
        requestId: "protect-bow",
        equipmentInstanceId: bow.instanceId,
        protected: true,
        expectedRevision: 0
      });
      await pool.query(
        "UPDATE item_definitions SET manor_storable=false WHERE item_id='starter_staff'"
      );
      try {
        const skipped = await storage.bulkTransfer(
          "a",
          "bulk-skip-ineligible-equipment",
          "deposit"
        );
        expect(skipped.storage.equipment).toEqual([]);
        expect(skipped.transfer?.skipped.map((item) => item.reason)).toEqual(
          expect.arrayContaining([
            "Equipped equipment.",
            "Protected equipment.",
            "This equipment cannot be stored."
          ])
        );
      } finally {
        await pool.query(
          "UPDATE item_definitions SET manor_storable=true WHERE item_id='starter_staff'"
        );
      }

      await protection.setUniqueProtection({
        playerId: "a",
        requestId: "unprotect-bow",
        equipmentInstanceId: bow.instanceId,
        protected: false,
        expectedRevision: 1
      });
      const stored = await storage.transferEquipment({
        playerId: "a",
        requestId: "store-bow",
        direction: "deposit",
        equipmentInstanceId: bow.instanceId
      });
      expect(stored.storage.equipment).toEqual([
        expect.objectContaining({
          equipmentInstanceId: bow.instanceId,
          slotIndex: 0,
          equipment: expect.objectContaining({
            instanceId: bow.instanceId,
            definitionId: "starter_bow",
            itemLevel: 7,
            location: "manor_storage"
          })
        })
      ]);
      await expect(storage.transferEquipment({
        playerId: "a",
        requestId: "store-equipped-sword",
        direction: "deposit",
        equipmentInstanceId: starter.equipment.active.melee!.instanceId
      })).rejects.toMatchObject({ code: "EQUIPMENT_NOT_STORABLE" });

      const taken = await storage.transferEquipment({
        playerId: "a",
        requestId: "take-bow",
        direction: "withdrawal",
        equipmentInstanceId: bow.instanceId
      });
      const returnedBow = taken.equipment?.instances.find(
        (item) => item.instanceId === bow.instanceId
      );
      expect(returnedBow).toMatchObject({
        instanceId: bow.instanceId,
        definitionId: "starter_bow",
        itemLevel: 7,
        location: "inventory"
      });
      expect(returnedBow).not.toHaveProperty("manorId");
      expect(returnedBow).not.toHaveProperty("manorSlotIndex");
      const events = await pool.query<{
        equipment_instance_id: string;
        direction: string;
      }>(
        `SELECT equipment_instance_id::text,direction
         FROM manor_storage_equipment_events
         WHERE equipment_instance_id=$1::uuid
         ORDER BY id`,
        [bow.instanceId]
      );
      expect(events.rows).toEqual([
        { equipment_instance_id: bow.instanceId, direction: "deposit" },
        { equipment_instance_id: bow.instanceId, direction: "withdrawal" }
      ]);
      await expect(pool.query(
        "DELETE FROM manor_storage_equipment_events WHERE equipment_instance_id=$1::uuid",
        [bow.instanceId]
      )).rejects.toThrow(/append-only/);
      expect(staff.location).toBe("inventory");
    });
  });

  it("upgrades populated inventory, equipment, and manor storage without loss and is empty on rerun", async () => {
    const manorId = await seedBuiltManor("a", 35, -106);
    await grant("a", "wood", null, 37, "migration-preserved-inventory");
    const starter = await equipment.ensureStarterLoadout("a");
    await pool.query(
      `INSERT INTO manor_storage_stacks
         (manor_id,slot_index,item_id,variant,quantity,version)
       VALUES ($1,0,'water','fresh',19,4)`,
      [manorId]
    );

    await pool.query("DROP TABLE IF EXISTS manor_storage_equipment_events");
    await pool.query("DROP TABLE IF EXISTS inventory_protection_events");
    await pool.query("DROP TABLE IF EXISTS inventory_protection_operations");
    await pool.query("DROP TABLE IF EXISTS player_unique_item_protections");
    await pool.query("DROP TABLE IF EXISTS player_item_keep_policies");
    await pool.query("DROP TABLE IF EXISTS player_inventory_protection_state");
    await pool.query("DROP VIEW IF EXISTS economy_current_holdings");
    await pool.query(
      "DROP TRIGGER IF EXISTS manor_storage_material_slot_clear ON manor_storage_stacks"
    );
    await pool.query(
      "DROP TRIGGER IF EXISTS manor_storage_equipment_slot_clear ON equipment_instances"
    );
    await pool.query("DROP FUNCTION IF EXISTS validate_manor_material_slot()");
    await pool.query("DROP FUNCTION IF EXISTS validate_manor_equipment_slot()");
    await pool.query(
      `ALTER TABLE equipment_instances
         DROP CONSTRAINT equipment_instances_location_fields_check,
         DROP CONSTRAINT equipment_instances_location_check,
         DROP COLUMN manor_slot_index,
         DROP COLUMN manor_id`
    );
    await pool.query(
      "ALTER TABLE item_definitions DROP COLUMN manor_storable, DROP COLUMN droppable"
    );
    await pool.query(
      "DELETE FROM schema_migrations WHERE version='0677_manor_inventory_protection.sql'"
    );

    await expect(runMigrations(databaseUrl!)).resolves.toEqual([
      "0677_manor_inventory_protection.sql"
    ]);
    await expect(runMigrations(databaseUrl!)).resolves.toEqual([]);

    const inventoryRows = await pool.query<{ total: string }>(
      `SELECT sum(quantity)::text AS total
       FROM player_inventory
       WHERE player_id='a' AND resource_type='wood'`
    );
    expect(inventoryRows.rows[0]?.total).toBe("37");
    const equipmentRows = await pool.query<{
      instance_id: string;
      location: string;
      inventory_slot_index: number | null;
    }>(
      `SELECT instance_id::text,location,inventory_slot_index
       FROM equipment_instances
       WHERE owner_player_id='a'
       ORDER BY instance_id`
    );
    expect(equipmentRows.rows).toHaveLength(starter.equipment.instances.length);
    expect(equipmentRows.rows.every(
      (row) =>
        (row.location === "inventory" || row.location === "equipped") &&
        row.inventory_slot_index === null
    )).toBe(true);
    const storageRows = await pool.query<{
      quantity: string;
      version: string;
      slot_index: number;
    }>(
      `SELECT quantity::text,version::text,slot_index
       FROM manor_storage_stacks
       WHERE manor_id=$1`,
      [manorId]
    );
    expect(storageRows.rows).toEqual([
      { quantity: "19", version: "4", slot_index: 0 }
    ]);
  }, 60_000);

  it("upgrades populated owner presence without loss and is empty on the second migration run", async () => {
    const manorId = await seedBuiltManor("a", 35, -106);
    await presence.enter(player("a", 35, -106));
    await pool.query("DROP TABLE manor_jump_operations");
    await pool.query("DROP TABLE manor_bans");
    await pool.query("ALTER TABLE player_manor_presence DROP CONSTRAINT player_manor_presence_access_source_check");
    await pool.query("ALTER TABLE player_manor_presence DROP COLUMN admission_travel_invite_id");
    await pool.query("ALTER TABLE player_manor_presence DROP COLUMN access_source");
    await pool.query(
      "ALTER TABLE player_manor_presence ADD CONSTRAINT player_manor_presence_manor_id_key UNIQUE (manor_id)"
    );
    await pool.query("DELETE FROM schema_migrations WHERE version='0662_manor_guest_access.sql'");

    await expect(runMigrations(databaseUrl!)).resolves.toEqual(["0662_manor_guest_access.sql"]);
    const preserved = await pool.query<{
      player_id: string; manor_id: string; access_source: string; admission_travel_invite_id: string | null;
    }>(
      `SELECT player_id,manor_id,access_source,admission_travel_invite_id
       FROM player_manor_presence WHERE player_id='a'`
    );
    expect(preserved.rows).toEqual([{
      player_id: "a", manor_id: manorId, access_source: "OWNER", admission_travel_invite_id: null
    }]);
    await expect(runMigrations(databaseUrl!)).resolves.toEqual([]);
  }, 60_000);

  it("adds nullable local positions to populated presence without changing retained rows", async () => {
    const manorId = await seedBuiltManor("a", 35, -106);
    await presence.enter(player("a", 35, -106));
    await pool.query(`
      ALTER TABLE player_manor_presence
        DROP CONSTRAINT player_manor_presence_local_position_pair_check,
        DROP CONSTRAINT player_manor_presence_local_position_bounds_check,
        DROP COLUMN local_position_x,
        DROP COLUMN local_position_y
    `);
    await pool.query(
      "DELETE FROM schema_migrations WHERE version='0706_manor_local_position.sql'"
    );

    await expect(runMigrations(databaseUrl!)).resolves.toEqual([
      "0706_manor_local_position.sql"
    ]);
    const preserved = await pool.query<{
      player_id: string;
      manor_id: string;
      local_position_x: number | null;
      local_position_y: number | null;
    }>(
      `SELECT player_id,manor_id,local_position_x,local_position_y
       FROM player_manor_presence WHERE player_id='a'`
    );
    expect(preserved.rows).toEqual([{
      player_id: "a",
      manor_id: manorId,
      local_position_x: null,
      local_position_y: null
    }]);
    await expect(runMigrations(databaseUrl!)).resolves.toEqual([]);
  }, 60_000);

  it("upgrades populated legacy storage without loss and retains excess as immutable overflow", async () => {
    const manorId = await seedBuiltManor("a", 35, -106);
    const legacyQuantity = (500 * 61) + 7;
    await pool.query("DROP TABLE IF EXISTS manor_storage_equipment_events");
    await pool.query("DROP TABLE IF EXISTS manor_storage_stack_events");
    await pool.query("DROP TABLE IF EXISTS manor_storage_backpack_events");
    await pool.query("DROP TABLE IF EXISTS manor_storage_operations");
    await pool.query("DROP VIEW IF EXISTS economy_current_holdings");
    await pool.query("DROP TABLE IF EXISTS manor_storage_overflow");
    await pool.query("DROP TABLE manor_storage_stacks");
    await pool.query(`
      CREATE TABLE manor_storage_stacks (
        manor_id uuid NOT NULL REFERENCES player_manors(id) ON DELETE CASCADE,
        item_id text NOT NULL REFERENCES item_definitions(item_id),
        variant text NOT NULL DEFAULT 'default',
        quantity bigint NOT NULL CHECK (quantity BETWEEN 0 AND 9007199254740991),
        version bigint NOT NULL DEFAULT 1 CHECK (version BETWEEN 1 AND 9007199254740991),
        updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (manor_id, item_id, variant)
      )
    `);
    await pool.query(
      `INSERT INTO manor_storage_stacks (manor_id,item_id,variant,quantity,version)
       VALUES ($1,'wood','default',$2,4),($1,'water','fresh',0,2)`,
      [manorId, legacyQuantity]
    );
    await pool.query("DELETE FROM schema_migrations WHERE version='0676_manor_grid_storage.sql'");

    await expect(runMigrations(databaseUrl!)).resolves.toEqual(["0676_manor_grid_storage.sql"]);
    const live = await pool.query<{
      count: string; total: string; minimum: number; maximum: number; largest: string;
    }>(
      `SELECT count(*)::text AS count,sum(quantity)::text AS total,
              min(slot_index) AS minimum,max(slot_index) AS maximum,max(quantity)::text AS largest
       FROM manor_storage_stacks WHERE manor_id=$1`,
      [manorId]
    );
    const overflow = await pool.query<{ count: string; total: string }>(
      `SELECT count(*)::text AS count,sum(quantity)::text AS total
       FROM manor_storage_overflow WHERE manor_id=$1`,
      [manorId]
    );
    expect(live.rows[0]).toEqual({
      count: "60", total: String(500 * 60), minimum: 0, maximum: 59, largest: "500"
    });
    expect(overflow.rows[0]).toEqual({ count: "2", total: "507" });
    expect(Number(live.rows[0]!.total) + Number(overflow.rows[0]!.total)).toBe(legacyQuantity);
    await expect(pool.query(
      `INSERT INTO manor_storage_overflow
         (manor_id,source_order,item_id,variant,quantity,legacy_version)
       VALUES ($1,62,'wood','default',1,1)`,
      [manorId]
    )).rejects.toThrow(/read-only/);
    await expect(pool.query(
      "DELETE FROM manor_storage_overflow WHERE manor_id=$1",
      [manorId]
    )).rejects.toThrow(/read-only/);
    await expect(runMigrations(databaseUrl!)).resolves.toEqual([]);
  }, 60_000);

  async function enterA(): Promise<void> {
    await seedBuiltManor("a", 35, -106);
    await presence.enter(player("a", 35, -106));
  }
  async function seedBuiltManor(playerId: string, lat: number, lon: number): Promise<string> {
    const result = await pool.query<{ id: string }>(
      `INSERT INTO player_manors (owner_player_id,world_region_code,world_lat,world_lon,geom,built_at,placement_revision)
       VALUES ($1,'world-test',$2,$3,ST_SetSRID(ST_MakePoint($3,$2),4326),now(),1)
       ON CONFLICT (owner_player_id) DO UPDATE SET
         world_region_code=EXCLUDED.world_region_code,world_lat=EXCLUDED.world_lat,world_lon=EXCLUDED.world_lon,
         geom=EXCLUDED.geom,built_at=COALESCE(player_manors.built_at,EXCLUDED.built_at),
         placement_revision=GREATEST(player_manors.placement_revision,1)
       RETURNING id`,
      [playerId, lat, lon]
    );
    return result.rows[0]!.id;
  }
  async function attachAccount(playerId: string): Promise<string> {
    const accountId = randomUUID();
    await pool.query(
      "INSERT INTO accounts (id,status,trust_tier) VALUES ($1,'active','standard')",
      [accountId]
    );
    await pool.query("UPDATE players SET account_id=$2 WHERE id=$1", [playerId, accountId]);
    return accountId;
  }
  async function creditWallet(playerId: string, amount: bigint, key: string): Promise<void> {
    const account = await pool.query<{ account_id: string }>(
      "SELECT account_id FROM players WHERE id=$1",
      [playerId]
    );
    const accountId = account.rows[0]?.account_id;
    if (!accountId) throw new Error(`Missing account for ${playerId}`);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await new WalletService().creditForOperationInTransaction(client, {
        playerId,
        accountId,
        amount,
        operationKey: `test:wallet:${key}`,
        reason: "manor_test_seed"
      });
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  async function grant(playerId: string, itemId: "wood" | "stone" | "water" | "iron_bar", variant: string | null, quantity: number, key: string): Promise<void> {
    await inventory.grantItemsForOperation({ operationKey: `test:${key}`, playerId, source: "manor_test_seed", grants: [{ itemId, variant, quantity }] });
  }
  async function transfer(
    requestId: string,
    direction: "deposit" | "withdrawal",
    itemId: "wood" | "water",
    variant: string | null,
    quantity: number
  ) {
    const sourceStackId = direction === "deposit"
      ? (await playerStackFor("a", itemId, variant ?? "default")).stack_id
      : (await storage.snapshotForPlayer("a")).stacks.find((stack) =>
          stack.itemId === itemId && stack.variant === variant
        )!.stackId;
    return { playerId: "a", requestId, direction, sourceStackId, quantity } as const;
  }
  async function playerStacksFor(
    playerId: string,
    itemId: string,
    variant: string
  ): Promise<Array<{
    stack_id: string;
    quantity: string;
  }>> {
    const result = await pool.query<{
      stack_id: string;
      quantity: string;
    }>(
      `SELECT entry_id::text AS stack_id,quantity::text
       FROM player_inventory
       WHERE player_id=$1 AND resource_type=$2 AND variant=$3
       ORDER BY entry_id`,
      [playerId, itemId, variant]
    );
    return result.rows;
  }
  async function playerStackFor(playerId: string, itemId: string, variant: string) {
    const stack = (await playerStacksFor(playerId, itemId, variant))[0];
    if (!stack) throw new Error(`Missing player stack ${itemId}:${variant}`);
    return stack;
  }
  async function combinedTotal(playerId: string, itemId: string, variant: string): Promise<number> {
    const result = await pool.query<{ total: string }>(
      `SELECT (
         COALESCE((SELECT quantity FROM player_inventory
           WHERE player_id=$1 AND resource_type=$2 AND variant=$3),0) +
         COALESCE((SELECT sum(stack.quantity)
           FROM manor_storage_stacks stack
           JOIN player_manors manor ON manor.id=stack.manor_id
           WHERE manor.owner_player_id=$1 AND stack.item_id=$2 AND stack.variant=$3),0)
       )::text AS total`,
      [playerId, itemId, variant]
    );
    return Number(result.rows[0]!.total);
  }
});

async function createPlayer(pool: pg.Pool, id: string, username: string): Promise<void> {
  await pool.query(
    `INSERT INTO players (id,username,region_code,lat,lon,anchor_lat,anchor_lon,move_leash_radius_m,online,geom)
     VALUES ($1,$2,'world-test',35,-106,35,-106,2000,true,ST_SetSRID(ST_MakePoint(-106,35),4326))`, [id, username]
  );
}

async function createFlag(pool: pg.Pool, ownerId: string, lat: number, lon: number): Promise<void> {
  await pool.query(
    `INSERT INTO flags (id,owner_id,name,lat,lon,claim_radius_m,geom)
     VALUES (gen_random_uuid(),$1,$2,$3,$4,700,ST_SetSRID(ST_MakePoint($4,$3),4326))`,
    [ownerId, `${ownerId} flag`, lat, lon]
  );
}
function player(id: string, lat: number, lon: number): PlayerRecord {
  return { playerId: id, username: id === "a" ? "Ash" : "Bex", displayColor: null, regionCode: "world-test", position: { lat, lon }, anchor: { lat: 35, lon: -106 }, moveLeashRadiusM: 2000, movementRevision: 0, target: null, online: true, updatedAt: new Date() };
}
