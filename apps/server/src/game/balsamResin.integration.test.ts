import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, copyFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runMigrations } from "../db/migrate.js";
import {
  BalsamResinError,
  BalsamResinService
} from "./balsamResin.js";
import { validateItemDefinitionCatalog } from "./items.js";
import { InventoryService } from "./inventory.js";

const databaseUrl = process.env.BALSAM_RESIN_TEST_DATABASE_URL;
const describeLive = databaseUrl ? describe : describe.skip;

describeLive("Giving Berry durable consumption", () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    const databaseName = new URL(databaseUrl!).pathname.slice(1);
    if (!databaseName.startsWith("ash_atlas_stability_")) {
      throw new Error("Balsam Resin integration tests require a disposable database");
    }
    const baseline = await mkdtemp(path.join(os.tmpdir(), "ash-atlas-berry-migrations-"));
    try {
      const source = path.resolve("../../db/migrations");
      for (const file of await readdir(source)) {
        if (file.endsWith(".sql") && file !== "0866_giving_berries.sql")
          await copyFile(path.join(source, file), path.join(baseline, file));
      }
      await runMigrations(databaseUrl!, { migrationsDirectory: baseline });
      pool = new pg.Pool({ connectionString: databaseUrl, max: 4 });
      const playerId = `berry-upgrade-${randomUUID()}`;
      await pool.query(`INSERT INTO players(id,username,lat,lon,anchor_lat,anchor_lon,geom)
        VALUES($1,$1,35,-106,35,-106,ST_SetSRID(ST_MakePoint(-106,35),4326))`, [playerId]);
      const inventory = new InventoryService(pool);
      await inventory.grantItemsForOperation({ operationKey: `berry-upgrade-seed:${playerId}`,
        playerId, source: "berry-upgrade-test", grants: [{ itemId: "balsam_resin", variant: null, quantity: 2 }] });
      expect(await runMigrations(databaseUrl!)).toEqual(["0866_giving_berries.sql"]);
      expect((await inventory.getInventorySnapshot(playerId)).totals.balsam_resin).toBe(2);
      await validateItemDefinitionCatalog(pool);
      expect(await runMigrations(databaseUrl!)).toEqual([]);
    } finally {
      await rm(baseline, { recursive: true, force: true });
    }
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
  });

  it("serializes activation, replays one request, and consumes exactly once", async () => {
    const playerId = `balsam-test-${randomUUID()}`;
    await pool.query(
      `INSERT INTO players (
         id, username, lat, lon, anchor_lat, anchor_lon, geom
       )
       VALUES (
         $1, $2, 35, -106, 35, -106,
         ST_SetSRID(ST_MakePoint(-106, 35), 4326)
       )`,
      [playerId, playerId]
    );
    const inventory = new InventoryService(pool);
    await inventory.grantItemsForOperation({
      operationKey: `balsam-test-seed:${playerId}`,
      playerId,
      source: "balsam-resin-integration-test",
      grants: [{ itemId: "giving_berry", variant: null, quantity: 2 }]
    });
    const service = new BalsamResinService(pool, inventory);

    const attempts = await Promise.allSettled([
      service.consume(playerId, "request-a"),
      service.consume(playerId, "request-b")
    ]);
    const completed = attempts.filter(
      (attempt): attempt is PromiseFulfilledResult<
        Awaited<ReturnType<BalsamResinService["consume"]>>
      > => attempt.status === "fulfilled"
    );
    const rejected = attempts.filter(
      (attempt): attempt is PromiseRejectedResult =>
        attempt.status === "rejected"
    );
    expect(completed).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toBeInstanceOf(BalsamResinError);
    expect(completed[0]!.value.inventory.totals.giving_berry).toBe(1);

    const winningRequest = attempts[0]?.status === "fulfilled"
      ? "request-a"
      : "request-b";
    const replay = await service.consume(
      playerId,
      winningRequest,
      undefined,
      { atFullHealth: true }
    );
    expect(replay.replayed).toBe(true);
    expect(replay.inventory.totals.giving_berry).toBe(1);

    await service.finish(
      playerId,
      completed[0]!.value.effect.effectId,
      "death"
    );
    await expect(service.consume(
      playerId,
      "request-full-health",
      undefined,
      { atFullHealth: true }
    )).rejects.toMatchObject({
      code: "BALSAM_RESIN_FULL_HEALTH"
    });
    expect(
      (await inventory.getInventorySnapshot(playerId)).totals.giving_berry
    ).toBe(1);

    const second = await service.consume(playerId, "request-c");
    expect(second.replayed).toBe(false);
    expect(second.inventory.totals.giving_berry).toBe(0);
  });
});
