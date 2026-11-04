import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runMigrations } from "../../db/migrate.js";
import { FlagAccessService } from "../../game/flagAccess.js";
import { DestinationAnchoring } from "./anchoring.js";
import { DestinationAnchorGate, PostgresDestinationAnchorStore } from "./destinationAnchorGate.js";
import { PostgresTrustZoneStore } from "./trustStore.js";

const databaseUrl = testDatabaseUrl(process.env.DEVELOPER_AUTH_TEST_DATABASE_URL);
const describeDatabase = databaseUrl ? describe : describe.skip;
// Open ocean, away from other fixtures in the shared disposable database.
const BASE = { lat: -10.5, lon: -150.5 };

describeDatabase("destination anchoring store (PostgreSQL)", () => {
  let pool: pg.Pool;
  let store: PostgresDestinationAnchorStore;

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
      [id, accountId, `A${randomUUID().slice(0, 10)}`]
    );
    return id;
  };
  const flag = async (playerId: string, lat: number, lon: number, accessMode: string) => {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO flags (id, owner_id, name, lat, lon, claim_radius_m, geom, access_mode)
       VALUES ($1, $2, 'Anchor Test', $3, $4, 100, ST_SetSRID(ST_MakePoint($4, $3), 4326), $5)`,
      [id, playerId, lat, lon, accessMode]
    );
    return id;
  };
  const gate = (mode: "shadow" | "enforce") => new DestinationAnchorGate(
    store,
    new DestinationAnchoring(new PostgresTrustZoneStore(pool), { TRUST_HOME_DESTINATION_RADIUS_KM: 50 }),
    { TRUST_ANCHOR_MODE: mode }
  );

  beforeAll(async () => {
    await runMigrations(databaseUrl!);
    pool = new pg.Pool({ connectionString: databaseUrl!, max: 4 });
    store = new PostgresDestinationAnchorStore(pool);
    await pool.query("DELETE FROM flags WHERE name = 'Anchor Test'");
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
  });

  it("resolves personal flags and never anchors them, even for an unsettled owner", async () => {
    const ownerAccount = await account();
    const owner = await player(ownerAccount);
    const stranger = await player(await account());
    const publicFlag = await flag(owner, BASE.lat, BASE.lon, "public");
    const privateFlag = await flag(owner, BASE.lat + 0.01, BASE.lon, "private");

    expect(await store.resolveDestination({ kind: "flag", id: publicFlag })).toMatchObject({
      kind: "flag",
      anchorPlayerId: owner,
      anchorAccountId: ownerAccount,
      openToOthers: true,
      personalFlag: true
    });
    expect(await store.resolveDestination({ kind: "flag", id: privateFlag })).toMatchObject({
      openToOthers: false,
      personalFlag: true
    });
    // Unknown ids fall through the flag, Castle and city lookups.
    expect(await store.resolveDestination({ kind: "flag", id: randomUUID() })).toBeNull();
    expect(await store.resolveDestination({ kind: "city", id: randomUUID() })).toBeNull();

    const travel = (travellerPlayerId: string, flagId: string) => ({
      travellerPlayerId,
      kind: "flag",
      destination: { kind: "flag", id: flagId, personalFlagId: flagId }
    });
    // Owner decision 2026-10-15: an unsettled owner's public flag is jumpable in enforce.
    const enforce = gate("enforce");
    expect(await enforce.checkTravel(travel(owner, publicFlag))).toBeNull();
    expect(await enforce.checkTravel(travel(stranger, publicFlag))).toBeNull();
    expect(await enforce.checkTravel(travel(stranger, privateFlag))).toBeNull();
    // City and kingdom flags keep the founder anchor (unit tests cover the refusal).
  });

  it("lets an unsettled owner open flags and leaves them open on revocation", async () => {
    const ownerAccount = await account();
    const owner = await player(ownerAccount);
    const ownFlag = await flag(owner, BASE.lat + 0.3, BASE.lon, "private");

    const flagAccess = new FlagAccessService(pool);
    await flagAccess.updateSettings({ ownerPlayerId: owner, flagId: ownFlag, mode: "public", jumpTollGold: "5" });
    expect((await pool.query("SELECT access_mode FROM flags WHERE id = $1", [ownFlag])).rows[0].access_mode).toBe("public");

    expect(await store.countOpenStructures(ownerAccount)).toEqual({ harvestAssets: 0 });
    await gate("shadow").onRevoked(ownerAccount);
    await gate("enforce").onRevoked(ownerAccount);
    const after = await pool.query("SELECT access_mode, jump_toll_gold::text AS toll FROM flags WHERE id = $1", [ownFlag]);
    expect(after.rows[0]).toEqual({ access_mode: "public", toll: "5" });
  });

  it("reports unanchored routes from recorded signals", async () => {
    const traveller = await account();
    const owner = await account();
    const destinationId = randomUUID();
    await pool.query(
      `INSERT INTO account_trust_state (account_id) VALUES ($1) ON CONFLICT DO NOTHING`,
      [traveller]
    );
    for (const day of ["2026-09-30", "2026-10-01"]) {
      await pool.query(
        `INSERT INTO account_trust_events (id, account_id, kind, rule, weight, logodds_after, dedupe_key, metadata, created_at)
         VALUES ($1, $2, 'signal', 'travel_unanchored_destination', 0, 0, $3, $4::jsonb, $5)`,
        [
          randomUUID(),
          traveller,
          `travel_unanchored_destination:${traveller}:flag:${destinationId}:${day}`,
          JSON.stringify({ destinationKind: "flag", destinationId, ownerAccountId: owner, mode: "shadow" }),
          new Date(`${day}T12:00:00Z`)
        ]
      );
    }
    const report = await store.unanchoredRoutesReport(new Date("2026-09-29T00:00:00Z"), 1000);
    expect(report.find((row) => row.destinationId === destinationId)).toMatchObject({
      destinationKind: "flag",
      ownerAccountId: owner,
      attempts: 2,
      travellers: 1
    });
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
