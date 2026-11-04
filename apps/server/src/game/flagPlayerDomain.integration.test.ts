import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runMigrations } from "../db/migrate.js";

const databaseUrl = process.env.FLAG_DOMAIN_TEST_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;

describeDatabase("flag and player PostgreSQL domain constraints", () => {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 4 });
  const ownerId = `flag-domain-${randomUUID()}`;
  const flagId = randomUUID();

  beforeAll(async () => {
    await runMigrations(databaseUrl!);
    await pool.query(
      `INSERT INTO players (
         id,username,region_code,lat,lon,anchor_lat,anchor_lon,
         move_leash_radius_m,online,geom
       ) VALUES ($1,$1,'GLOBAL',10,20,10,20,1250,false,
                 ST_SetSRID(ST_MakePoint(20,10),4326))`,
      [ownerId]
    );
    await pool.query(
      `INSERT INTO flags (id,owner_id,name,lat,lon,claim_radius_m,geom)
       VALUES ($1,$2,'domain flag',10,20,1000,ST_SetSRID(ST_MakePoint(20,10),4326))`,
      [flagId, ownerId]
    );
  });

  afterAll(async () => {
    await pool.query("DELETE FROM flags WHERE id = $1", [flagId]);
    await pool.query("DELETE FROM players WHERE id = $1", [ownerId]);
    await pool.end();
  });

  it("rejects invalid and inconsistent player coordinates", async () => {
    await expect(pool.query(
      "UPDATE players SET lat = 91, geom = ST_SetSRID(ST_MakePoint(lon,91),4326) WHERE id = $1",
      [ownerId]
    )).rejects.toMatchObject({ constraint: "players_coordinate_domain" });
    await expect(pool.query(
      "UPDATE players SET geom = ST_SetSRID(ST_MakePoint(21,10),4326) WHERE id = $1",
      [ownerId]
    )).rejects.toMatchObject({ constraint: "players_coordinate_domain" });
  });

  it("rejects invalid and inconsistent flag coordinates", async () => {
    await expect(pool.query(
      "UPDATE flags SET lon = -181, geom = ST_SetSRID(ST_MakePoint(-181,lat),4326) WHERE id = $1",
      [flagId]
    )).rejects.toMatchObject({ constraint: "flags_coordinate_domain" });
    await expect(pool.query(
      "UPDATE flags SET geom = ST_SetSRID(ST_MakePoint(21,10),4326) WHERE id = $1",
      [flagId]
    )).rejects.toMatchObject({ constraint: "flags_coordinate_domain" });
  });

  it("rejects orphan ownership and restricts owner deletion", async () => {
    const orphan = randomUUID();
    await expect(pool.query(
      `INSERT INTO flags (id,owner_id,name,lat,lon,claim_radius_m,geom)
       VALUES ($1,'missing-owner','orphan',-10,-20,1000,
               ST_SetSRID(ST_MakePoint(-20,-10),4326))`,
      [orphan]
    )).rejects.toMatchObject({ constraint: "flags_owner_id_fkey" });
    await expect(pool.query("DELETE FROM players WHERE id = $1", [ownerId]))
      .rejects.toMatchObject({ constraint: "flags_owner_id_fkey" });
    await expect(pool.query("SELECT count(*)::int AS count FROM flags WHERE id = $1", [orphan]))
      .resolves.toMatchObject({ rows: [{ count: 0 }] });
  });
});
