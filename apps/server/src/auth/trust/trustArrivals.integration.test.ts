import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runMigrations } from "../../db/migrate.js";
import { PostgresTrustArrivalStore, TrustArrivalLog, farArrivalGuests } from "./trustArrivals.js";

const databaseUrl = testDatabaseUrl(process.env.DEVELOPER_AUTH_TEST_DATABASE_URL);
const describeDatabase = databaseUrl ? describe : describe.skip;
const NOW = new Date("2026-10-02T12:00:00.000Z");
const HOME = { lat: 40, lon: -105 };
const FAR_DESTINATION = { lat: 45.123, lon: -100.456 }; // about 700 km from HOME
const NEAR_DESTINATION = { lat: 40.2, lon: -105 }; // about 22 km from HOME

describe("farArrivalGuests", () => {
  it("counts distinct guests far from home or without a home anchor", () => {
    expect(farArrivalGuests([
      { guestAccountId: "a", destination: FAR_DESTINATION, guestHome: HOME },
      { guestAccountId: "a", destination: FAR_DESTINATION, guestHome: HOME },
      { guestAccountId: "b", destination: FAR_DESTINATION, guestHome: null },
      { guestAccountId: "c", destination: NEAR_DESTINATION, guestHome: HOME }
    ])).toEqual(["a", "b"]);
  });
});

describeDatabase("trust arrivals (PostgreSQL)", () => {
  let pool: pg.Pool;
  let store: PostgresTrustArrivalStore;

  const account = async () => {
    const id = randomUUID();
    await pool.query(`INSERT INTO accounts (id, status, trust_tier) VALUES ($1, 'active', 'standard')`, [id]);
    return id;
  };
  const player = async (accountId: string, home: { lat: number; lon: number } | null = HOME) => {
    const id = `p-${randomUUID()}`;
    await pool.query(
      `INSERT INTO players (id, account_id, username, username_normalized, display_color, region_code,
         lat, lon, anchor_lat, anchor_lon, move_leash_radius_m, geom)
       VALUES ($1, $2, $3, lower($3), '#3366cc', 'CO', 40, -105, 40, -105, 600, ST_SetSRID(ST_MakePoint(-105, 40), 4326))`,
      [id, accountId, `R${randomUUID().slice(0, 10)}`]
    );
    if (home) {
      await pool.query(
        `INSERT INTO account_settlement (account_id, home_lat, home_lon, target_checks, target_days)
         VALUES ($1, $2, $3, 25, 5)`,
        [accountId, home.lat, home.lon]
      );
    }
    return id;
  };
  const log = (now = NOW) => new TrustArrivalLog(store, { TRUST_MASS_ARRIVAL_COUNT: 3 }, {
    now: () => now,
    classify: () => "rural"
  });
  const alerts = (accountId: string) => pool.query<{ severity: number; details: Record<string, unknown>; lat_rounded: number }>(
    "SELECT severity, details, lat_rounded FROM trust_alerts WHERE account_id = $1 AND kind = 'mass_arrival'",
    [accountId]
  );

  beforeAll(async () => {
    await runMigrations(databaseUrl!);
    pool = new pg.Pool({ connectionString: databaseUrl!, max: 4 });
    store = new PostgresTrustArrivalStore(pool);
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
  });

  it("records who brought whom with a rounded destination", async () => {
    const hostAccount = await account();
    const guestAccount = await account();
    const host = await player(hostAccount);
    const guest = await player(guestAccount);
    expect(await log().recordArrival({ guestPlayerId: guest, hostPlayerId: host, kind: "invite", destination: FAR_DESTINATION }))
      .toBe(false);
    const [brought] = await store.arrivalsBroughtBy(hostAccount, new Date(NOW.getTime() - 1000));
    expect(brought).toMatchObject({
      hostAccountId: hostAccount,
      guestAccountId: guestAccount,
      kind: "invite",
      latRounded: 45.12,
      lonRounded: -100.46
    });
    expect((await store.arrivalsBroughtIn(guestAccount, new Date(0)))[0]?.hostAccountId).toBe(hostAccount);
    // Self or missing hosts are not arrivals.
    expect(await log().recordArrival({ guestPlayerId: guest, hostPlayerId: guest, kind: "invite", destination: null })).toBe(false);
    expect(await log().recordArrival({ guestPlayerId: guest, hostPlayerId: undefined, kind: "invite", destination: null })).toBe(false);
  });

  it("files one mass-arrival alert at three distinct far arrivals within the hour", async () => {
    const hostAccount = await account();
    const host = await player(hostAccount);
    const guests = await Promise.all([0, 1, 2, 3].map(async (index) => player(await account(), index === 2 ? null : HOME)));
    const arrive = (guest: string, at: Date) =>
      log(at).recordArrival({ guestPlayerId: guest, hostPlayerId: host, kind: "party_auto_follow", destination: FAR_DESTINATION });

    expect(await arrive(guests[0]!, NOW)).toBe(false);
    expect(await arrive(guests[0]!, new Date(NOW.getTime() + 60_000))).toBe(false); // same guest again
    expect(await arrive(guests[1]!, new Date(NOW.getTime() + 120_000))).toBe(false);
    expect(await arrive(guests[2]!, new Date(NOW.getTime() + 180_000))).toBe(true);
    // One per host per 6 hours.
    expect(await arrive(guests[3]!, new Date(NOW.getTime() + 240_000))).toBe(false);
    const filed = await alerts(hostAccount);
    expect(filed.rows).toHaveLength(1);
    expect(filed.rows[0]).toMatchObject({ severity: 3, lat_rounded: 45.12 });
    expect(filed.rows[0]!.details).toMatchObject({ hostAccountId: hostAccount, arrivalCount: 3, zoneClass: "rural" });
  });

  it("raises nothing for arrivals near the guests' homes", async () => {
    const hostAccount = await account();
    const host = await player(hostAccount);
    for (const index of [0, 1, 2, 3]) {
      const guest = await player(await account());
      await log(new Date(NOW.getTime() + index * 60_000)).recordArrival({
        guestPlayerId: guest,
        hostPlayerId: host,
        kind: "party_manual",
        destination: NEAR_DESTINATION
      });
    }
    expect((await alerts(hostAccount)).rows).toHaveLength(0);
  });

  it("deletes arrivals past retention", async () => {
    const hostAccount = await account();
    const guestAccount = await account();
    await store.recordArrival({
      hostAccountId: hostAccount,
      guestAccountId: guestAccount,
      kind: "invite",
      destination: null,
      now: new Date("2020-01-01T00:00:00Z")
    });
    expect(await store.deleteArrivalsBefore(new Date("2020-02-01T00:00:00Z"))).toBeGreaterThanOrEqual(1);
    expect(await store.arrivalsBroughtBy(hostAccount, new Date(0))).toHaveLength(0);
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
