import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { BIOME_DISCOVERY_MIN_INTERVAL_MS, BiomeDiscoveryService } from "./biomeDiscovery.js";

const databaseUrl = process.env.MANOR_TEST_DATABASE_URL;
const databaseSuite = databaseUrl ? describe : describe.skip;

// A private schema on a disposable database exercises the real migration, conflict handling,
// and biome constraint without touching a gameplay character.
databaseSuite("biome discovery persistence", () => {
  const schema = "biome_discovery_test_" + randomUUID().replaceAll("-", "");
  let admin: pg.Pool;
  let pool: pg.Pool;
  beforeAll(async () => {
    const url = new URL(databaseUrl!);
    if (!url.pathname.slice(1).startsWith("ash_atlas_stability")) {
      throw new Error("Biome discovery tests require a disposable ash_atlas_stability database");
    }
    admin = new pg.Pool({ connectionString: databaseUrl! });
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new pg.Pool({ connectionString: databaseUrl!, options: `-c search_path=${schema}`, max: 4 });
    await pool.query("CREATE TABLE players (id text PRIMARY KEY)");
    await pool.query("INSERT INTO players VALUES ('p'),('q')");
    await pool.query(await readFile(
      new URL("../../../../db/migrations/0878_player_biome_discoveries.sql", import.meta.url),
      "utf8"
    ));
  });
  afterAll(async () => {
    await pool?.end();
    if (admin) {
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
    }
  });

  it("records a biome once per player, even when requests replay", async () => {
    let now = 0;
    const legends = { snapshot: async () => { evaluations += 1; return { newlyCompletedIds: ["legend_region_plains"] }; } };
    let evaluations = 0;
    const service = new BiomeDiscoveryService(pool, { codeAt: () => 36, nearestCodeAt: () => null }, null, () => now, legends);
    // No World client: fallback land is still recorded, fallback water never is.
    const first = await service.discover("p", { lat: 0, lon: -150 });
    now += BIOME_DISCOVERY_MIN_INTERVAL_MS;
    const replay = await service.discover("p", { lat: 0, lon: -150 });
    const concurrent = await Promise.all([
      new BiomeDiscoveryService(pool, { codeAt: () => 36, nearestCodeAt: () => null }, null, Date.now, legends).discover("q", { lat: 0, lon: -150 }),
      new BiomeDiscoveryService(pool, { codeAt: () => 36, nearestCodeAt: () => null }, null, Date.now, legends).discover("q", { lat: 0, lon: -150 })
    ]);
    expect(first).toEqual({ biomes: ["plains"], newlyDiscovered: "plains", celebration: { biome: "plains", achievements: [expect.objectContaining({ id: "legend_region_plains" })] }, current: expect.objectContaining({ biome: "plains" }) });
    expect(replay).toEqual({ biomes: ["plains"], newlyDiscovered: null, celebration: null, current: expect.objectContaining({ biome: "plains" }) });
    expect(concurrent.map((result) => result?.newlyDiscovered).sort()).toEqual([null, "plains"]);
    expect(concurrent.map((result) => result?.celebration?.biome ?? null).sort()).toEqual([null, "plains"]);
    // One evaluation per winning insert: p once, q once; replays and losers never evaluate.
    expect(evaluations).toBe(2);
    const rows = await pool.query("SELECT player_id,biome_id FROM player_biome_discoveries ORDER BY 1,2");
    expect(rows.rows).toEqual([
      { player_id: "p", biome_id: "plains" },
      { player_id: "q", biome_id: "plains" }
    ]);
  });

  it("rejects biomes outside the sixteen discoverable regions", async () => {
    await expect(pool.query("INSERT INTO player_biome_discoveries (player_id,biome_id) VALUES ('p','wilds')"))
      .rejects.toThrow(/player_biome_discoveries_biome_id_check/);
  });
});
