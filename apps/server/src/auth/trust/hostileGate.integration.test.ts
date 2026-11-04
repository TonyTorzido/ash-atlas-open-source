import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runMigrations } from "../../db/migrate.js";
import { HostileActionGate, PostgresHostileGateStore } from "./hostileGate.js";

const databaseUrl = testDatabaseUrl(process.env.DEVELOPER_AUTH_TEST_DATABASE_URL);
const describeDatabase = databaseUrl ? describe : describe.skip;
// Open ocean, away from other fixtures in the shared disposable database.
const BASE = { lat: -0.5, lon: -140.5 };

describeDatabase("hostile-action gate store (PostgreSQL)", () => {
  let pool: pg.Pool;
  let store: PostgresHostileGateStore;

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
      [id, accountId, `H${randomUUID().slice(0, 10)}`]
    );
    return id;
  };
  const flag = async (playerId: string, lat: number, lon: number) => {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO flags (id, owner_id, name, lat, lon, claim_radius_m, geom)
       VALUES ($1, $2, 'Hostile Test', $3, $4, 100, ST_SetSRID(ST_MakePoint($4, $3), 4326))`,
      [id, playerId, lat, lon]
    );
    return id;
  };
  const group = async (ownerPlayerId: string, unitType: string, lat: number, lon: number) => {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO military_unit_groups (group_id, owner_player_id, unit_type, location_state, lat, lon)
       VALUES ($1, $2, $3, 'DEPLOYED_FIELD', $4, $5)`,
      [id, ownerPlayerId, unitType, lat, lon]
    );
    return id;
  };

  beforeAll(async () => {
    await runMigrations(databaseUrl!);
    pool = new pg.Pool({ connectionString: databaseUrl!, max: 4 });
    store = new PostgresHostileGateStore(pool);
    await pool.query("DELETE FROM military_unit_groups WHERE owner_player_id IN (SELECT owner_id FROM flags WHERE name = 'Hostile Test')");
    await pool.query("DELETE FROM flags WHERE name = 'Hostile Test'");
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
  });

  it("loads Settled status per player and gates an unsettled raider in enforce", async () => {
    const settledAccount = await account();
    const newAccount = await account();
    const settledPlayer = await player(settledAccount);
    const newPlayer = await player(newAccount);
    await pool.query(
      `INSERT INTO account_settlement (account_id, settled_home_lat, settled_home_lon, target_checks, target_days, settled_at)
       VALUES ($1, 40, -105, 25, 5, now() - interval '20 days')`,
      [settledAccount]
    );
    expect(await store.loadPlayerStatus(settledPlayer)).toMatchObject({ accountId: settledAccount, devProfile: false });
    expect((await store.loadPlayerStatus(newPlayer))?.settledAt).toBeNull();
    expect(await store.loadPlayerStatus(`p-${randomUUID()}`)).toBeNull();

    const ownFlag = await flag(newPlayer, BASE.lat, BASE.lon);
    const otherFlag = await flag(settledPlayer, BASE.lat + 0.01, BASE.lon);
    const gate = new HostileActionGate(store, { TRUST_HOSTILE_GATE_MODE: "enforce" });
    expect((await gate.checkFlagRaid({ playerId: newPlayer, flagId: otherFlag, action: "flag_burn" })).allowed).toBe(false);
    expect((await gate.checkFlagRaid({ playerId: newPlayer, flagId: ownFlag, action: "flag_burn" })).allowed).toBe(true);
    expect((await gate.checkFlagRaid({ playerId: settledPlayer, flagId: ownFlag, action: "flag_attack" })).allowed).toBe(true);
    expect((await gate.checkPvp({ attackerPlayerId: settledPlayer, targetPlayerId: newPlayer })).allowed).toBe(false);
  });

  it("reads Siege groups and whether a hostile Siege threatens the player's own flags", async () => {
    const defender = await player(await account());
    const besieger = await player(await account());
    await flag(defender, BASE.lat, BASE.lon + 0.2);
    const ownSiege = await group(defender, "field_ballista", BASE.lat, BASE.lon + 0.3);
    const ownInfantry = await group(defender, "infantry", BASE.lat, BASE.lon + 0.3);
    // About 330 m from the defender's flag (inside the 575 m Siege range).
    const nearSiege = await group(besieger, "field_ballista", BASE.lat + 0.003, BASE.lon + 0.2);
    // About 2.2 km away.
    const farSiege = await group(besieger, "field_ballista", BASE.lat + 0.02, BASE.lon + 0.2);

    expect(await store.militaryGroupUnitType(defender, ownSiege)).toBe("field_ballista");
    expect(await store.militaryGroupUnitType(defender, ownInfantry)).toBe("infantry");
    expect(await store.militaryGroupUnitType(besieger, ownSiege)).toBeNull();
    expect(await store.siegeThreatensOwnFlag(defender, nearSiege)).toBe(true);
    expect(await store.siegeThreatensOwnFlag(defender, farSiege)).toBe(false);
    // Your own Siege never counts as a threat.
    expect(await store.siegeThreatensOwnFlag(defender, ownSiege)).toBe(false);
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
