import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runMigrations } from "../../db/migrate.js";
import { DestinationAnchoring } from "./anchoring.js";
import { PostgresTrustZoneStore } from "./trustStore.js";

const databaseUrl = testDatabaseUrl(process.env.DEVELOPER_AUTH_TEST_DATABASE_URL);
const describeDatabase = databaseUrl ? describe : describe.skip;
const CONFIG = { TRUST_HOME_DESTINATION_RADIUS_KM: 50 };
// Fixtures sit in the open ocean near (0.5, 100.5) so unrelated rows in the
// shared disposable database cannot fall inside the search radius.
const BASE = { lat: 0.5, lon: 100.5 };

describeDatabase("trust zone store (PostgreSQL)", () => {
  let pool: pg.Pool;
  let store: PostgresTrustZoneStore;

  const account = async () => {
    const id = randomUUID();
    await pool.query(`INSERT INTO accounts (id, status, trust_tier) VALUES ($1, 'active', 'standard')`, [id]);
    return id;
  };
  const player = async (accountId: string) => {
    const id = `p-${randomUUID()}`;
    await pool.query(
      `INSERT INTO players (id, account_id, username, username_normalized, display_color, region_code,
         lat, lon, anchor_lat, anchor_lon, move_leash_radius_m, geom)
       VALUES ($1, $2, $3, lower($3), '#3366cc', 'CO', 40, -105, 40, -105, 600, ST_SetSRID(ST_MakePoint(-105, 40), 4326))`,
      [id, accountId, `Z${randomUUID().slice(0, 10)}`]
    );
    return id;
  };
  const flag = async (playerId: string, lat: number, lon: number, claimRadiusM = 500) => {
    await pool.query(
      `INSERT INTO flags (id, owner_id, name, lat, lon, claim_radius_m, geom)
       VALUES ($1, $2, 'Zone Test', $3, $4, $5, ST_SetSRID(ST_MakePoint($4, $3), 4326))`,
      [randomUUID(), playerId, lat, lon, claimRadiusM]
    );
  };

  beforeAll(async () => {
    await runMigrations(databaseUrl!);
    pool = new pg.Pool({ connectionString: databaseUrl!, max: 4 });
    store = new PostgresTrustZoneStore(pool);
    // Earlier runs on the shared database leave fixture flags whose claims
    // would reject this run's flags.
    await pool.query("DELETE FROM flags WHERE name = 'Zone Test'");
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
  });

  it("yellowOwners returns distinct other accounts within the radius, counting claim edges", async () => {
    const self = await account();
    const near = await account();
    const nearTwice = await account();
    const claimEdge = await account();
    const far = await account();
    const selfPlayer = await player(self);
    await flag(selfPlayer, BASE.lat, BASE.lon);
    await flag(await player(near), BASE.lat + 0.045, BASE.lon); // about 5 km
    const nearTwicePlayer = await player(nearTwice);
    await flag(nearTwicePlayer, BASE.lat, BASE.lon + 0.05);
    await flag(nearTwicePlayer, BASE.lat, BASE.lon - 0.05);
    // Centre about 12.2 km away; a 3 km claim reaches inside the 10 km radius.
    await flag(await player(claimEdge), BASE.lat + 0.11, BASE.lon, 3000);
    await flag(await player(far), BASE.lat + 0.3, BASE.lon, 500); // about 33 km

    const owners = await store.yellowOwners(BASE.lat, BASE.lon, 10, self);
    expect([...owners].sort()).toEqual([near, nearTwice, claimEdge].sort());
    expect(await store.yellowOwners(BASE.lat, BASE.lon, 10, null)).toContain(self);
    expect(await store.yellowOwners(BASE.lat, BASE.lon, 10, self, 1)).toHaveLength(1);
    expect(await store.yellowOwners(BASE.lat, BASE.lon, 1, near)).not.toContain(near);
  });

  it("kingdomOwners finds other accounts' kingdom seats and kingdom flags within the radius", async () => {
    const at = { lat: BASE.lat + 1, lon: BASE.lon + 1 };
    // Earlier runs on the shared database leave fixture kingdoms here.
    await pool.query("DELETE FROM flags WHERE name = 'Zone Test' AND kingdom_id IS NOT NULL");
    await pool.query("DELETE FROM kingdom_seats WHERE kingdom_id IN (SELECT id FROM kingdoms WHERE normalized_name LIKE 'zk%')");
    await pool.query("DELETE FROM kingdoms WHERE normalized_name LIKE 'zk%'");
    const self = await account();
    const king = await account();
    const vassal = await account();
    const farKing = await account();
    const kingPlayer = await player(king);
    const kingdom = async (founder: string, lat: number, lon: number) => {
      const id = randomUUID();
      const name = `zk${randomUUID().replaceAll("-", "").slice(0, 10)}`;
      await pool.query(
        `INSERT INTO kingdoms (id, normalized_name, display_name, founder_player_id, leader_player_id, founding_request_id)
         VALUES ($1, $2, $2, $3, $3, $4)`,
        [id, name, founder, randomUUID()]
      );
      await pool.query(
        `INSERT INTO kingdom_seats (id, kingdom_id, lat, lon, geom, territory_radius_m, is_land, is_saltwater,
           inside_major_lake, environment_rules_version, environment_lookup_at, construction_state, completed_at)
         VALUES ($1, $2, $3, $4, ST_SetSRID(ST_MakePoint($4, $3), 4326), 500, true, false, false, 1, now(), 'complete', now())`,
        [randomUUID(), id, lat, lon]
      );
      return id;
    };
    const kingdomId = await kingdom(kingPlayer, at.lat + 0.02, at.lon); // about 2.2 km
    await kingdom(await player(farKing), at.lat + 0.2, at.lon); // about 22 km
    const vassalPlayer = await player(vassal);
    await pool.query(
      `INSERT INTO flags (id, owner_id, name, lat, lon, claim_radius_m, geom, kingdom_id, control_type,
         kingdom_affiliated_at, original_owner_player_id)
       VALUES ($1, $2, 'Zone Test', $3, $4, 200, ST_SetSRID(ST_MakePoint($4, $3), 4326), $5, 'kingdom', now(), $2)`,
      [randomUUID(), vassalPlayer, at.lat, at.lon + 0.02, kingdomId]
    );
    expect([...await store.kingdomOwners(at.lat, at.lon, 3, self)].sort()).toEqual([king, vassal].sort());
    expect(await store.kingdomOwners(at.lat, at.lon, 3, king)).toEqual([vassal]);
    expect(await store.kingdomOwners(at.lat, at.lon, 0.5, self)).toEqual([]);
  });

  it("yellowOwners is empty where nobody owns land", async () => {
    expect(await store.yellowOwners(-45, -130, 10, randomUUID())).toEqual([]);
  });

  it("anchors against account_settlement: Settled, provisional, unsettled and missing owners", async () => {
    const insert = (accountId: string, settledAt: string, provisional: string, homeLat: number | null) =>
      pool.query(
        `INSERT INTO account_settlement (account_id, settled_home_lat, settled_home_lon, target_checks, target_days, settled_at, provisional_until)
         VALUES ($1, $2, $3, 25, 5, ${settledAt}, ${provisional})`,
        [accountId, homeLat, homeLat === null ? null : -105]
      );
    const settled = await account();
    const provisionalLive = await account();
    const provisionalExpired = await account();
    const unsettled = await account();
    const noRow = await account();
    await insert(settled, "now() - interval '20 days'", "NULL", 40);
    await insert(provisionalLive, "now() - interval '20 days'", "now() + interval '5 days'", 40);
    await insert(provisionalExpired, "now() - interval '20 days'", "now() - interval '1 day'", 40);
    await insert(unsettled, "NULL", "NULL", null);

    const check = (id: string, lat: number) =>
      new DestinationAnchoring(store, CONFIG).isDestinationAnchored(id, lat, -105);
    expect(await check(settled, 40.2)).toBe(true);
    expect(await check(settled, 41)).toBe(false);
    expect(await check(provisionalLive, 40.2)).toBe(true);
    expect(await check(provisionalExpired, 40.2)).toBe(false);
    expect(await check(unsettled, 40.2)).toBe(false);
    expect(await check(noRow, 40.2)).toBe(false);

    // Revocation shows after the cache window or an explicit invalidate.
    const anchoring = new DestinationAnchoring(store, CONFIG);
    expect(await anchoring.isDestinationAnchored(settled, 40.2, -105)).toBe(true);
    await pool.query(`UPDATE account_settlement SET settled_at = NULL WHERE account_id = $1`, [settled]);
    expect(await anchoring.isDestinationAnchored(settled, 40.2, -105)).toBe(true);
    anchoring.invalidate(settled);
    expect(await anchoring.isDestinationAnchored(settled, 40.2, -105)).toBe(false);
  });
});

function testDatabaseUrl(value: string | undefined): string | null {
  if (!value) return null;
  const parsed = new URL(value);
  if (!["127.0.0.1", "localhost"].includes(parsed.hostname)) {
    throw new Error("DEVELOPER_AUTH_TEST_DATABASE_URL must use local PostgreSQL");
  }
  if (!parsed.pathname.slice(1).startsWith("ash_atlas_stability")) {
    throw new Error("DEVELOPER_AUTH_TEST_DATABASE_URL must target an ash_atlas_stability* database");
  }
  return value;
}
