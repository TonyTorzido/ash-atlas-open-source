import { randomUUID } from "node:crypto";

import {
  ENCHANTMENT_STONE_VARIANTS,
  PLAYER_PACKAGE_ADMIN_API_BASE
} from "@ash-atlas/shared";
import Fastify from "fastify";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { DisposableTestPool } from "../db/disposableTestPool.js";
import type { AuthService } from "../auth/authService.js";
import type { AuthenticatedSession } from "../auth/types.js";
import { runMigrations } from "../db/migrate.js";
import { registerPlayerPackageRoutes } from "../http/playerPackageRoutes.js";
import { InboxReadReceiptService } from "./inboxReadReceipts.js";
import { CityTreasuryService } from "./cityTreasury.js";
import { DevelopmentEconomyService } from "./developmentEconomy.js";
import { FishingService } from "./fishing.js";
import { InventoryService } from "./inventory.js";
import { PlayerPackageService } from "./playerPackages.js";

const adminUrl =
  process.env.PLAYER_PACKAGE_TEST_ADMIN_URL ??
  process.env.MIGRATION_RUNNER_TEST_ADMIN_URL;
const describeDatabase = adminUrl ? describe : describe.skip;

describeDatabase("durable owner player packages", () => {
  const databaseName = `ash_atlas_stability_packages_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const admin = new pg.Pool({ connectionString: adminUrl, max: 2 });
  let databaseUrl = "";
  let pool: pg.Pool;
  let service: PlayerPackageService;
  const players = ["package-owner-a", "package-owner-b", "package-owner-c"];
  const accountIds = players.map(() => randomUUID());

  beforeAll(async () => {
    const parsed = disposableDatabaseUrl(adminUrl!);
    parsed.pathname = `/${databaseName}`;
    databaseUrl = parsed.toString();
    await admin.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    await runMigrations(databaseUrl);
    const repeatedMigrations = await runMigrations(databaseUrl);
    if (repeatedMigrations.length !== 0) {
      throw new Error("Player Package migration second run was not empty");
    }
    pool = new DisposableTestPool({ connectionString: databaseUrl, max: 8 });
    const inventory = new InventoryService(pool);
    const fishing = new FishingService(pool, "test-world", inventory, {} as never);
    service = new PlayerPackageService(pool, { inventory, fishing });
  }, 120_000);

  beforeEach(async () => {
    await pool.query("TRUNCATE accounts CASCADE");
    for (const [index, playerId] of players.entries()) {
      await pool.query(
        "INSERT INTO accounts (id,trust_tier) VALUES ($1,'standard')",
        [accountIds[index]]
      );
      await pool.query(
        `INSERT INTO players (
           id,account_id,username,region_code,lat,lon,anchor_lat,anchor_lon,
           move_leash_radius_m,online,geom
         ) VALUES ($1,$2,$3,'GLOBAL',0,0,0,0,1250,$4,
                   ST_SetSRID(ST_MakePoint(0,0),4326))`,
        [
          playerId,
          accountIds[index],
          `Package Ranger ${index + 1}`,
          index === 0
        ]
      );
    }
  });

  afterAll(async () => {
    await pool?.end();
    await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`);
    await admin.end();
  });

  it("serves the actual player count, exact and partial search, creation, and history through Fastify", async () => {
    const app = Fastify();
    app.decorateRequest("authSession", null);
    app.addHook("preHandler", async (request) => {
      request.authSession = ownerSession(players[0]!);
    });
    registerPlayerPackageRoutes(
      app,
      {
        authorizeDeveloperCommand: async () => {},
        recordDeveloperCommandResult: async () => {}
      } as unknown as AuthService,
      service,
      { send: () => {} } as never,
      { warn: () => {} } as never
    );

    try {
      const catalog = await app.inject({
        method: "GET",
        url: `${PLAYER_PACKAGE_ADMIN_API_BASE}/catalog`
      });
      const exact = await app.inject({
        method: "GET",
        url: `${PLAYER_PACKAGE_ADMIN_API_BASE}/characters?search=Package%20Ranger%202`
      });
      const partial = await app.inject({
        method: "GET",
        url: `${PLAYER_PACKAGE_ADMIN_API_BASE}/characters?search=Ranger`
      });
      expect(catalog.json()).toMatchObject({ eligibleCharacterCount: 3 });
      expect(exact.json().characters[0]).toMatchObject({
        playerId: players[1],
        displayName: "Package Ranger 2",
        online: false
      });
      expect(partial.json().characters.map(
        ({ playerId }: { playerId: string }) => playerId
      )).toEqual(players);

      const created = await app.inject({
        method: "POST",
        url: `${PLAYER_PACKAGE_ADMIN_API_BASE}/campaigns`,
        payload: {
          operationKey: randomUUID(),
          targetMode: "specific",
          recipientPlayerIds: [players[0]!],
          title: "History package",
          message: "",
          items: [{ itemKind: "resource", itemId: "stone", variant: "default", quantity: 1 }]
        }
      });
      const history = await app.inject({
        method: "GET",
        url: `${PLAYER_PACKAGE_ADMIN_API_BASE}/campaigns`
      });
      expect(created.statusCode).toBe(200);
      expect(history.json().campaigns).toEqual([expect.objectContaining({
        campaignId: created.json().campaignId,
        title: "History package",
        recipientCount: 1,
        unopenedCount: 1
      })]);
    } finally {
      await app.close();
    }
  });

  it("delivers one durable Fishing Rod through a package and replays without duplication", async () => {
    const created = await service.createCampaign(
      { subject: "verified-owner", playerId: players[0]! },
      {
        operationKey: randomUUID(),
        targetMode: "specific",
        recipientPlayerIds: [players[0]!],
        title: "Rod delivery",
        message: "",
        items: [{ itemKind: "resource", itemId: "fishing_rod", quantity: 1 }]
      }
    );
    const playerPackage = created.packages[0]!;
    const requestId = randomUUID();
    const claimed = await service.claim(
      players[0]!,
      playerPackage.packageId,
      requestId,
      playerPackage.revision
    );
    expect(claimed.lines).toEqual([
      expect.objectContaining({
        itemId: "fishing_rod",
        requestedQuantity: 1,
        grantedQuantity: 1,
        remainingQuantity: 0
      })
    ]);
    const rodRows = await pool.query<{ rod_id: string; uses_remaining: number }>(
      "SELECT rod_id::text,uses_remaining FROM fishing_rods WHERE player_id=$1",
      [players[0]]
    );
    expect(rodRows.rows).toHaveLength(1);
    expect(rodRows.rows[0]?.uses_remaining).toBe(100);
    expect(claimed.inventory.items).toEqual([
      expect.objectContaining({
        itemId: "fishing_rod",
        variant: rodRows.rows[0]?.rod_id,
        rodId: rodRows.rows[0]?.rod_id,
        usesRemaining: 100
      })
    ]);
    const replay = await service.claim(
      players[0]!,
      playerPackage.packageId,
      requestId,
      playerPackage.revision
    );
    expect(replay.replayed).toBe(true);
    expect(await pool.query(
      "SELECT count(*)::int AS count FROM fishing_rods WHERE player_id=$1",
      [players[0]]
    )).toMatchObject({ rows: [{ count: 1 }] });
  });

  it("refuses tagged mask and Manor skin copies in a campaign", async () => {
    for (const itemId of ["face_mask", "manor_skin"]) {
      await expect(service.createCampaign(
        { subject: "verified-owner", playerId: players[0]! },
        {
          operationKey: randomUUID(),
          targetMode: "specific" as const,
          recipientPlayerIds: [players[0]!, players[1]!],
          title: "Copies",
          message: "Same copy for everyone.",
          items: [{ itemKind: "resource" as const, itemId, variant: randomUUID(), quantity: 1 }]
        }
      )).rejects.toMatchObject({ code: "PLAYER_PACKAGE_ITEM_INVALID" });
    }
    expect(await pool.query("SELECT count(*)::int AS count FROM player_packages")).toMatchObject({ rows: [{ count: 0 }] });
  });

  it("snapshots immutable recipients without granting, fences ownership, and replays claims exactly once", async () => {
    const operationKey = randomUUID();
    const input = {
      operationKey,
      targetMode: "specific" as const,
      recipientPlayerIds: [players[0]!, players[1]!],
      title: "Founder supplies",
      message: "Welcome.",
      items: [
        { itemKind: "resource" as const, itemId: "wood", variant: "default", quantity: 10 },
        ...ENCHANTMENT_STONE_VARIANTS.map((variant) => ({
          itemKind: "resource" as const,
          itemId: "enchantment_stone",
          variant,
          quantity: 1
        })),
        { itemKind: "equipment" as const, itemId: "starter_sword", variant: "default", quantity: 2 }
      ]
    };
    const campaignResults = await Promise.all([
      service.createCampaign(
        { subject: "verified-owner", playerId: players[0]! },
        input
      ),
      service.createCampaign(
        { subject: "verified-owner", playerId: players[0]! },
        input
      )
    ]);
    const created = campaignResults.find((result) => !result.replayed)!;
    expect(created).toMatchObject({ recipientCount: 2, packageCount: 2, replayed: false });
    expect(campaignResults.filter((result) => result.replayed)).toHaveLength(1);
    expect(await pool.query("SELECT count(*)::int AS count FROM player_inventory")).toMatchObject({
      rows: [{ count: 0 }]
    });
    expect(await pool.query("SELECT count(*)::int AS count FROM equipment_instances")).toMatchObject({
      rows: [{ count: 0 }]
    });

    const owned = created.packages.find(
      (playerPackage) => created.recipientPlayerIds[created.packages.indexOf(playerPackage)] === players[0]
    )!;
    await new InboxReadReceiptService(pool).markRead(players[0]!, [{
      entryKey: `package:${owned.packageId}`,
      revision: owned.revision
    }]);
    expect((await service.inbox(players[0]!))[0]).toMatchObject({
      packageId: owned.packageId,
      status: "unopened",
      readAt: expect.any(String)
    });
    expect(await pool.query("SELECT count(*)::int AS count FROM player_inventory")).toMatchObject({
      rows: [{ count: 0 }]
    });
    await expect(service.claim(players[1]!, owned.packageId, randomUUID(), owned.revision))
      .rejects.toMatchObject({ code: "PLAYER_PACKAGE_NOT_FOUND", statusCode: 404 });

    const requestId = randomUUID();
    const claimResults = await Promise.all([
      service.claim(players[0]!, owned.packageId, requestId, owned.revision),
      service.claim(players[0]!, owned.packageId, requestId, owned.revision)
    ]);
    const claimed = claimResults.find((result) => !result.replayed)!;
    expect(claimResults.filter((result) => result.replayed)).toHaveLength(1);
    expect(claimed.package.status).toBe("claimed");
    expect(Object.fromEntries(claimed.lines
      .filter((line) => line.itemId !== "enchantment_stone")
      .map((line) => [line.itemId, line.grantedQuantity])))
      .toEqual({ starter_sword: 2, wood: 10 });
    expect(claimed.inventory.totals.wood).toBe(10);
    expect(claimed.inventory.totals.enchantment_stone).toBe(8);
    expect(claimed.inventory.items
      .filter((item) => item.resourceType === "enchantment_stone")
      .map((item) => item.variant)
      .sort()).toEqual([...ENCHANTMENT_STONE_VARIANTS].sort());
    expect(claimed.equipment.instances.filter(
      (item) => item.definitionId === "starter_sword" && item.location === "inventory"
    )).toHaveLength(2);
    expect(claimed.package.readAt).toEqual(expect.any(String));
    expect((await new InboxReadReceiptService(pool).list(players[0]!)).find(
      ({ entryKey }) => entryKey === `package:${owned.packageId}`
    )?.revision).toBe(claimed.package.revision);

    const replayedClaim = await service.claim(players[0]!, owned.packageId, requestId, owned.revision);
    expect(replayedClaim.replayed).toBe(true);
    expect(replayedClaim.lines).toEqual(claimed.lines);
    expect(await pool.query(
      "SELECT count(*)::int AS count FROM equipment_instances WHERE owner_player_id = $1",
      [players[0]]
    )).toMatchObject({ rows: [{ count: 2 }] });
    expect(await pool.query(
      `SELECT count(*)::int AS count FROM player_inventory_slots
       WHERE player_id = $1 AND resource_type = 'enchantment_stone'`,
      [players[0]]
    )).toMatchObject({ rows: [{ count: 8 }] });
    await expect(service.claim(players[0]!, owned.packageId, randomUUID(), owned.revision))
      .rejects.toMatchObject({ code: "PLAYER_PACKAGE_ALREADY_CLAIMED", statusCode: 409 });
  });

  it("keeps exact leftovers durable when capacity is partial or fully blocked", async () => {
    await pool.query(
      "INSERT INTO player_inventory_capacities (player_id) VALUES ($1)",
      [players[2]]
    );
    await pool.query(
      `INSERT INTO player_inventory_slots (
         player_id, slot_index, resource_type, variant, quantity, manual_split
       )
       SELECT $1, slot_index, 'food', 'default', 100, true
       FROM generate_series(0,38) slot_index`,
      [players[2]]
    );
    const created = await service.createCampaign(
      { subject: "verified-owner", playerId: null },
      {
        operationKey: randomUUID(),
        targetMode: "specific",
        recipientPlayerIds: [players[2]!],
        title: "Lumber delivery",
        message: "",
        items: [{ itemKind: "resource", itemId: "wood", variant: "default", quantity: 550 }]
      }
    );
    const playerPackage = created.packages[0]!;
    const receipts = new InboxReadReceiptService(pool);
    expect(playerPackage).toMatchObject({ status: "unopened", readAt: null, revision: "1" });
    await receipts.markRead(players[2]!, [{
      entryKey: `package:${playerPackage.packageId}`,
      revision: playerPackage.revision
    }]);
    const partial = await service.claim(
      players[2]!,
      playerPackage.packageId,
      randomUUID(),
      playerPackage.revision
    );
    expect(partial.package.status).toBe("partial");
    expect(partial.package.items[0]).toMatchObject({ remainingQuantity: 50 });
    expect(partial.lines[0]).toMatchObject({ grantedQuantity: 500, remainingQuantity: 50 });
    expect((await service.inbox(players[2]!))[0]).toMatchObject({
      packageId: playerPackage.packageId,
      status: "partial",
      readAt: expect.any(String),
      revision: partial.package.revision
    });
    expect((await receipts.list(players[2]!)).find(
      ({ entryKey }) => entryKey === `package:${playerPackage.packageId}`
    )?.revision).toBe(partial.package.revision);
    await expect(service.claim(
      players[2]!,
      playerPackage.packageId,
      randomUUID(),
      playerPackage.revision
    )).rejects.toMatchObject({
      code: "PLAYER_PACKAGE_STALE",
      currentPackage: {
        revision: partial.package.revision,
        status: "partial"
      }
    });

    const blocked = await service.claim(
      players[2]!,
      playerPackage.packageId,
      randomUUID(),
      partial.package.revision
    );
    expect(blocked.message).toContain("inventory is full");
    expect(blocked.package).toMatchObject({ status: "partial", revision: partial.package.revision });
    expect(blocked.package.items[0]).toMatchObject({ remainingQuantity: 50 });

    await pool.query(
      "DELETE FROM player_inventory_slots WHERE player_id = $1 AND slot_index = 0",
      [players[2]]
    );
    const finalRequestId = randomUUID();
    const completed = await service.claim(
      players[2]!,
      playerPackage.packageId,
      finalRequestId,
      partial.package.revision
    );
    expect(completed.package).toMatchObject({
      status: "claimed",
      revision: "3",
      readAt: expect.any(String)
    });
    expect(completed.lines[0]).toMatchObject({ grantedQuantity: 50, remainingQuantity: 0 });
    expect(completed.inventory.totals.wood).toBe(550);
    const replay = await service.claim(
      players[2]!,
      playerPackage.packageId,
      finalRequestId,
      partial.package.revision
    );
    expect(replay).toMatchObject({
      replayed: true,
      package: { status: "claimed", revision: completed.package.revision }
    });
    expect(replay.inventory.totals.wood).toBe(550);
    expect((await receipts.list(players[2]!)).find(
      ({ entryKey }) => entryKey === `package:${playerPackage.packageId}`
    )?.revision).toBe(completed.package.revision);
  });

  it("delivers rings and the God Sword as equipment without crediting Gold", async () => {
    const created = await service.createCampaign(
      { subject: "verified-owner", playerId: players[0]! },
      {
        operationKey: randomUUID(),
        targetMode: "specific",
        recipientPlayerIds: [players[0]!],
        title: "Equipment test package",
        message: "",
        items: [
          { itemKind: "equipment", itemId: "chopping_ring", variant: "default", quantity: 1 },
          { itemKind: "equipment", itemId: "god_sword", variant: "default", quantity: 1 }
        ]
      }
    );
    const playerPackage = created.packages[0]!;
    const claimed = await service.claim(
      players[0]!,
      playerPackage.packageId,
      randomUUID(),
      playerPackage.revision
    );

    expect(claimed.walletGold).toBe("0");
    expect(claimed.lines).toEqual(expect.arrayContaining([
      expect.objectContaining({
        itemKind: "equipment",
        itemId: "chopping_ring",
        grantedQuantity: 1
      }),
      expect.objectContaining({
        itemKind: "equipment",
        itemId: "god_sword",
        grantedQuantity: 1
      })
    ]));
    expect(claimed.equipment.instances).toEqual(expect.arrayContaining([
      expect.objectContaining({ definitionId: "chopping_ring", location: "inventory" }),
      expect.objectContaining({ definitionId: "god_sword", location: "inventory" })
    ]));
    expect(await pool.query(
      "SELECT gold_balance::text FROM player_wallets WHERE player_id=$1",
      [players[0]]
    )).toMatchObject({ rows: [] });
  });

  it("claims Gold and City Coins transactionally, keeps no-city lines available, and replays exactly once", async () => {
    const firstCity = await createActiveCityMembership(
      pool,
      players[0]!,
      "First Package City"
    );
    const activeMemberCampaign = await service.createCampaign(
      { subject: "verified-owner", playerId: players[0]! },
      {
        operationKey: randomUUID(),
        targetMode: "specific",
        recipientPlayerIds: [players[0]!],
        title: "City value",
        message: "",
        items: [
          { itemKind: "gold", itemId: "gold", quantity: 100 },
          { itemKind: "gold", itemId: "gold", quantity: 50 },
          { itemKind: "city_coins", itemId: "city_coins", quantity: 40 },
          { itemKind: "city_coins", itemId: "city_coins", quantity: 35 },
          { itemKind: "resource", itemId: "wood", variant: "default", quantity: 5 }
        ]
      }
    );
    expect(activeMemberCampaign.packages[0]!.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          itemKind: "gold",
          itemId: "gold",
          originalQuantity: 150
        }),
        expect.objectContaining({
          itemKind: "city_coins",
          itemId: "city_coins",
          originalQuantity: 75
        })
      ])
    );
    expect(await pool.query(
      "SELECT count(*)::int AS count FROM item_definitions WHERE item_id IN ('gold','city_coins')"
    )).toMatchObject({ rows: [{ count: 0 }] });

    const activePackage = activeMemberCampaign.packages[0]!;
    const requestId = randomUUID();
    const claimed = await service.claim(
      players[0]!,
      activePackage.packageId,
      requestId,
      activePackage.revision
    );
    expect(claimed).toMatchObject({
      replayed: false,
      walletGold: "150",
      cityCredit: {
        creditedAmount: 75,
        cityId: firstCity.cityId,
        cityName: "First Package City",
        treasuryBalance: "75",
        playerContribution: "75"
      },
      package: { status: "claimed" }
    });
    expect(claimed.lines).toEqual(expect.arrayContaining([
      expect.objectContaining({ itemKind: "gold", status: "granted" }),
      expect.objectContaining({ itemKind: "city_coins", status: "granted" })
    ]));
    expect(await pool.query(
      "SELECT gold_balance::text FROM player_wallets WHERE player_id=$1",
      [players[0]]
    )).toMatchObject({ rows: [{ gold_balance: "150" }] });
    expect(await pool.query(
      `SELECT treasury.balance::text,treasury.lifetime_earned::text,
              contribution.lifetime_contributed::text
       FROM city_treasuries treasury
       JOIN city_coin_contributions contribution
         ON contribution.city_id=treasury.city_id AND contribution.player_id=$2
       WHERE treasury.city_id=$1`,
      [firstCity.cityId, players[0]]
    )).toMatchObject({
      rows: [{
        balance: "75",
        lifetime_earned: "75",
        lifetime_contributed: "75"
      }]
    });
    expect(await service.claim(
      players[0]!,
      activePackage.packageId,
      requestId,
      activePackage.revision
    )).toMatchObject({ replayed: true, walletGold: "150" });

    const blockedCampaign = await service.createCampaign(
      { subject: "verified-owner", playerId: players[0]! },
      {
        operationKey: randomUUID(),
        targetMode: "specific",
        recipientPlayerIds: [players[1]!],
        title: "Join later",
        message: "",
        items: [
          { itemKind: "gold", itemId: "gold", quantity: 25 },
          { itemKind: "city_coins", itemId: "city_coins", quantity: 60 }
        ]
      }
    );
    const blockedPackage = blockedCampaign.packages[0]!;
    const partial = await service.claim(
      players[1]!,
      blockedPackage.packageId,
      randomUUID(),
      blockedPackage.revision
    );
    expect(partial).toMatchObject({
      walletGold: "25",
      cityCredit: null,
      package: { status: "partial" }
    });
    expect(partial.message).toBe(
      "Other contents were claimed. Join a city before claiming the City Coins in this package."
    );
    expect(partial.lines).toEqual(expect.arrayContaining([
      expect.objectContaining({
        itemKind: "city_coins",
        status: "blocked_city_membership",
        blockedReason: "CITY_MEMBERSHIP_REQUIRED",
        remainingQuantity: 60
      })
    ]));

    const laterCity = await createActiveCityMembership(
      pool,
      players[1]!,
      "Later Package City"
    );
    const completed = await service.claim(
      players[1]!,
      blockedPackage.packageId,
      randomUUID(),
      partial.package.revision
    );
    expect(completed).toMatchObject({
      walletGold: "25",
      cityCredit: {
        creditedAmount: 60,
        cityId: laterCity.cityId,
        treasuryBalance: "60",
        playerContribution: "60"
      },
      package: { status: "claimed" }
    });
    expect(completed.lines).toEqual(expect.arrayContaining([
      expect.objectContaining({
        itemKind: "gold",
        status: "already_consumed"
      })
    ]));
    await pool.query(
      "UPDATE city_memberships SET left_at=now(),ended_reason='house_destroyed' WHERE membership_id=$1",
      [laterCity.membershipId]
    );
    expect(await pool.query(
      "SELECT balance::text,lifetime_earned::text FROM city_treasuries WHERE city_id=$1",
      [laterCity.cityId]
    )).toMatchObject({
      rows: [{ balance: "60", lifetime_earned: "60" }]
    });
  });

  it("keeps a City-Coin-only package unopened until a current city exists", async () => {
    const campaign = await service.createCampaign(
      { subject: "verified-owner", playerId: null },
      {
        operationKey: randomUUID(),
        targetMode: "specific",
        recipientPlayerIds: [players[2]!],
        title: "Future city value",
        message: "",
        items: [{
          itemKind: "city_coins",
          itemId: "city_coins",
          quantity: 90
        }]
      }
    );
    const playerPackage = campaign.packages[0]!;
    const blocked = await service.claim(
      players[2]!,
      playerPackage.packageId,
      randomUUID(),
      playerPackage.revision
    );
    expect(blocked).toMatchObject({
      package: {
        status: "unopened",
        revision: playerPackage.revision,
        items: [expect.objectContaining({ remainingQuantity: 90 })]
      },
      message: "Join a city before claiming the City Coins in this package."
    });

    const formerCity = await createActiveCityMembership(
      pool,
      players[2]!,
      "Former Claim City"
    );
    await pool.query(
      "UPDATE city_memberships SET left_at=now(),ended_reason='house_destroyed' WHERE membership_id=$1",
      [formerCity.membershipId]
    );
    await pool.query(
      `UPDATE city_structures
       SET state='destroyed',destroyed_at=now()
       WHERE city_id=$1 AND owner_player_id=$2 AND state='active'`,
      [formerCity.cityId, players[2]]
    );
    const currentCity = await createActiveCityMembership(
      pool,
      players[2]!,
      "Current Claim City"
    );
    const claimed = await service.claim(
      players[2]!,
      playerPackage.packageId,
      randomUUID(),
      playerPackage.revision
    );
    expect(claimed).toMatchObject({
      package: { status: "claimed" },
      cityCredit: { cityId: currentCity.cityId, creditedAmount: 90 }
    });
    expect(await pool.query(
      "SELECT count(*)::int AS count FROM city_treasuries WHERE city_id=$1",
      [formerCity.cityId]
    )).toMatchObject({ rows: [{ count: 0 }] });
  });

  it("enforces physical and virtual package asset shapes in PostgreSQL", async () => {
    const campaign = await service.createCampaign(
      { subject: "verified-owner", playerId: null },
      {
        operationKey: randomUUID(),
        targetMode: "specific",
        recipientPlayerIds: [players[0]!],
        title: "Constraint probe",
        message: "",
        items: [{
          itemKind: "resource",
          itemId: "wood",
          variant: "default",
          quantity: 1
        }]
      }
    );
    const packageId = campaign.packages[0]!.packageId;
    await expect(pool.query(
      `INSERT INTO player_package_items (
         package_id,line_number,item_kind,canonical_item_id,
         original_quantity,remaining_quantity
       ) VALUES ($1,2,'gold','wood',1,1)`,
      [packageId]
    )).rejects.toThrow();
    await expect(pool.query(
      `INSERT INTO player_package_items (
         package_id,line_number,item_kind,canonical_item_id,
         original_quantity,remaining_quantity
       ) VALUES ($1,3,'resource','starter_sword',1,1)`,
      [packageId]
    )).rejects.toThrow();
  });

  it("includes virtual assets in campaign idempotency hashing", async () => {
    const operationKey = randomUUID();
    const base = {
      operationKey,
      targetMode: "specific" as const,
      recipientPlayerIds: [players[0]!],
      title: "Hash currencies",
      message: ""
    };
    await service.createCampaign(
      { subject: "verified-owner", playerId: null },
      {
        ...base,
        items: [{ itemKind: "gold", itemId: "gold", quantity: 10 }]
      }
    );
    await expect(service.createCampaign(
      { subject: "verified-owner", playerId: null },
      {
        ...base,
        items: [{ itemKind: "gold", itemId: "gold", quantity: 11 }]
      }
    )).rejects.toMatchObject({
      code: "PLAYER_PACKAGE_IDEMPOTENCY_CONFLICT"
    });
  });

  it("grants developer City Coins to the active city with rollback and replay safety", async () => {
    const membership = await createActiveCityMembership(
      pool,
      players[0]!,
      "Developer Grant City"
    );
    const economy = new DevelopmentEconomyService(pool, {
      cityTreasury: new CityTreasuryService(pool)
    });
    const first = await economy.grant(
      players[0]!,
      accountIds[0]!,
      "developer-city-grant",
      { cityCoins: 250n }
    );
    expect(first).toMatchObject({
      replayed: false,
      cityCoins: {
        creditedAmount: 250,
        cityId: membership.cityId,
        treasuryBalance: "250",
        playerContribution: "250"
      }
    });
    expect(await economy.grant(
      players[0]!,
      accountIds[0]!,
      "developer-city-grant",
      { cityCoins: 250n }
    )).toMatchObject({
      replayed: true,
      cityCoins: { treasuryBalance: "250", playerContribution: "250" }
    });

    await expect(economy.grant(
      players[1]!,
      accountIds[1]!,
      "developer-no-city",
      { gold: 100n, cityCoins: 100n }
    )).rejects.toMatchObject({
      code: "DEV_CITY_MEMBERSHIP_REQUIRED"
    });
    expect(await pool.query(
      "SELECT count(*)::int AS count FROM wallet_events WHERE operation_key='dev-grant:developer-no-city:gold'"
    )).toMatchObject({ rows: [{ count: 0 }] });

    await pool.query(
      "UPDATE city_memberships SET left_at=now(),ended_reason='house_destroyed' WHERE membership_id=$1",
      [membership.membershipId]
    );
    expect(await pool.query(
      "SELECT balance::text,lifetime_earned::text FROM city_treasuries WHERE city_id=$1",
      [membership.cityId]
    )).toMatchObject({
      rows: [{ balance: "250", lifetime_earned: "250" }]
    });
    expect(await economy.grant(
      players[0]!,
      accountIds[0]!,
      "developer-city-grant",
      { cityCoins: 250n }
    )).toMatchObject({
      replayed: true,
      cityCoins: { treasuryBalance: "250", playerContribution: "250" }
    });
  });

  it("converges a concurrent claim and package mark-read on the resulting revision", async () => {
    const created = await service.createCampaign(
      { subject: "verified-owner", playerId: null },
      {
        operationKey: randomUUID(),
        targetMode: "specific",
        recipientPlayerIds: [players[1]!],
        title: "Race-safe delivery",
        message: "",
        items: [{ itemKind: "resource", itemId: "wood", variant: "default", quantity: 7 }]
      }
    );
    const playerPackage = created.packages[0]!;
    const receipts = new InboxReadReceiptService(pool);
    const claimPromise = service.claim(
      players[1]!,
      playerPackage.packageId,
      randomUUID(),
      playerPackage.revision
    );
    const readPromise = receipts.markRead(players[1]!, [{
      entryKey: `package:${playerPackage.packageId}`,
      revision: playerPackage.revision
    }]);
    const [claim] = await Promise.all([claimPromise, readPromise]);

    expect(claim).toMatchObject({
      replayed: false,
      package: { status: "claimed", readAt: expect.any(String), revision: "2" }
    });
    expect(claim.inventory.totals.wood).toBe(7);
    expect((await service.inbox(players[1]!))[0]).toMatchObject({
      status: "claimed",
      readAt: expect.any(String),
      revision: claim.package.revision
    });
    expect((await receipts.list(players[1]!)).find(
      ({ entryKey }) => entryKey === `package:${playerPackage.packageId}`
    )?.revision).toBe(claim.package.revision);
  });

  it("snapshots every existing character for an all-character campaign", async () => {
    const result = await service.createCampaign(
      { subject: "verified-owner", playerId: null },
      {
        operationKey: randomUUID(),
        targetMode: "all",
        recipientPlayerIds: [],
        title: "Community package",
        message: "",
        items: [{ itemKind: "resource", itemId: "stone", variant: "default", quantity: 1 }],
        allCharactersConfirmation: "SEND"
      }
    );
    expect(result.recipientCount).toBe(3);
    expect(new Set(result.recipientPlayerIds)).toEqual(new Set(players));
  });
});

function disposableDatabaseUrl(value: string): URL {
  const parsed = new URL(value);
  const database = parsed.pathname.slice(1);
  if (!database || database === "ash_atlas_game" || database.startsWith("ash_atlas_world")) {
    throw new Error("PLAYER_PACKAGE_TEST_ADMIN_URL must not target a retained database");
  }
  return parsed;
}

function ownerSession(playerId: string): AuthenticatedSession {
  return {
    sessionId: "owner-session",
    verifiedGoogleSubject: "verified-owner",
    verifiedEmail: "owner@example.com",
    account: {
      id: "owner-account",
      status: "active",
      trustTier: "standard",
      riskScore: 0,
      testAccessStatus: "approved",
      testAccessRequestedAt: new Date(0),
      testAccessDecidedAt: new Date(0),
      createdAt: new Date(0),
      lastLoginAt: null
    },
    player: {
      id: playerId,
      accountId: "owner-account",
      displayName: "Package Ranger 1",
      personalFlagColor: "blue",
      onboardingCompletedAt: new Date(0)
    },
    deviceInstallationId: null,
    csrfToken: "owner-csrf"
  };
}

async function createActiveCityMembership(
  pool: pg.Pool,
  playerId: string,
  cityName: string
): Promise<{ cityId: string; membershipId: string }> {
  const cityId = randomUUID();
  const flagId = randomUUID();
  const structureId = randomUUID();
  const settlementId = `package-settlement-${cityId}`;
  const cityCount = await pool.query<{ count: number }>(
    "SELECT count(*)::int AS count FROM cities"
  );
  const coordinate = (cityCount.rows[0]?.count ?? 0) + 1;
  await pool.query(
    `INSERT INTO flags (
       id,owner_id,name,lat,lon,claim_radius_m,geom
     ) VALUES (
       $1,$2,$3,$4,$4,1000,ST_SetSRID(ST_MakePoint($4,$4),4326)
     )`,
    [flagId, playerId, `${cityName} Seat`, coordinate]
  );
  await pool.query(
    `INSERT INTO cities (
       id,world_id,canonical_municipality_id,world_settlement_id,
       world_settlement_source,world_source_settlement_id,name,country_code,
       region_code,founder_player_id,founding_request_id,seat_flag_id,
       hall_lat,hall_lon,hall_geom,founding_annex_radius_m
     ) VALUES (
       $1,'main',$2,$2,'package_test',$2,$3,'US','US-NM',$4,$5,$6,
       $7,$7,ST_SetSRID(ST_MakePoint($7,$7),4326),1000
     )`,
    [
      cityId,
      settlementId,
      cityName,
      playerId,
      `package-city-${cityId}`,
      flagId,
      coordinate
    ]
  );
  await pool.query(
    `INSERT INTO city_structures (
       structure_id,city_id,structure_type,tier,owner_player_id,world_id,
       region_code,lat,lon,geom,footprint_geom,footprint_radius_m,
       state,build_operation_key,built_at
     ) VALUES (
       $1,$2,'city_house',1,$3,'main','US-NM',$5,$5,
       ST_SetSRID(ST_MakePoint($5,$5),4326),
       ST_Buffer(
         ST_SetSRID(ST_MakePoint($5,$5),4326)::geography,
         10
       )::geometry,
       10,'active',$4,now()
     )`,
    [
      structureId,
      cityId,
      playerId,
      `package-house-${structureId}`,
      coordinate
    ]
  );
  const membership = await pool.query<{ membership_id: string }>(
    `INSERT INTO city_memberships (
       city_id,player_id,world_id,role,house_structure_id
     ) VALUES ($1,$2,'main','member',$3)
     RETURNING membership_id::text`,
    [cityId, playerId, structureId]
  );
  return {
    cityId,
    membershipId: membership.rows[0]!.membership_id
  };
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}
