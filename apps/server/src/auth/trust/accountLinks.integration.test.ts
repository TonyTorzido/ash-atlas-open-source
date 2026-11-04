import { createHash, randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runMigrations } from "../../db/migrate.js";
import { PostgresAccountLinkStore } from "./accountLinks.js";

const databaseUrl = testDatabaseUrl(process.env.DEVELOPER_AUTH_TEST_DATABASE_URL);
const describeDatabase = databaseUrl ? describe : describe.skip;

describeDatabase("account link store (PostgreSQL)", () => {
  let pool: pg.Pool;
  let store: PostgresAccountLinkStore;

  const account = async () => {
    const id = randomUUID();
    await pool.query(`INSERT INTO accounts (id, status, trust_tier) VALUES ($1, 'active', 'standard')`, [id]);
    return id;
  };
  const device = async () => {
    const id = randomUUID();
    await pool.query("INSERT INTO device_installations (id, token_hash) VALUES ($1, $2)", [id, createHash("sha256").update(id).digest("hex")]);
    return id;
  };
  const environment = async (accountId: string, installHash: string) => {
    await pool.query(
      `INSERT INTO device_environment_reports (id, account_id, platform, install_id_hash) VALUES ($1, $2, 'android', $3)`,
      [randomUUID(), accountId, installHash]
    );
  };

  beforeAll(async () => {
    await runMigrations(databaseUrl!);
    pool = new pg.Pool({ connectionString: databaseUrl!, max: 4 });
    store = new PostgresAccountLinkStore(pool);
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
  });

  it("links accounts by install id and by login device, from both sides", async () => {
    const since = new Date(Date.now() - 24 * 60 * 60_000);
    const [main, alt, loginAlt, stranger] = [await account(), await account(), await account(), await account()];
    const install = createHash("sha256").update(randomUUID()).digest("hex");
    await environment(main, install);
    await environment(alt, install);
    await environment(stranger, createHash("sha256").update(randomUUID()).digest("hex"));
    const shared = await device();
    await pool.query(
      "INSERT INTO account_device_links (account_id, device_installation_id) VALUES ($1, $3), ($2, $3)",
      [main, loginAlt, shared]
    );

    const fromMain = await store.linkedAccounts(main, since, 10);
    expect(fromMain.map((entry) => [entry.accountId, entry.via]).sort()).toEqual([
      [alt, ["install"]],
      [loginAlt, ["login_device"]]
    ].sort());
    expect((await store.linkedAccounts(alt, since, 10)).map((entry) => entry.accountId)).toEqual([main]);
    expect((await store.linkedAccounts(loginAlt, since, 10)).map((entry) => entry.accountId)).toEqual([main]);
    expect(await store.linkedAccounts(stranger, since, 10)).toEqual([]);
  });

  it("counts native installs and finds the latest fix from another device", async () => {
    const since = new Date(Date.now() - 60 * 60_000);
    const sharedAccount = await account();
    await environment(sharedAccount, createHash("sha256").update(randomUUID()).digest("hex"));
    await environment(sharedAccount, createHash("sha256").update(randomUUID()).digest("hex"));
    expect(await store.nativeInstallCount(sharedAccount, since)).toBe(2);

    const [phone, tablet] = [await device(), await device()];
    const report = async (deviceId: string, lat: number, verdict: string, minutesAgo: number, seq: number) => pool.query(
      `INSERT INTO location_reports (id, account_id, seq, source, lat, lon, device_installation_id, received_at, verdict, features, score)
       VALUES ($1, $2, $3, 'passive', $4, -105, $5, now() - ($6::int * interval '1 minute'), $7, '{}'::jsonb, 0)`,
      [randomUUID(), sharedAccount, seq, lat, deviceId, minutesAgo, verdict]
    );
    await report(tablet, 41.88, "accepted", 30, 1);
    await report(tablet, 42.5, "rejected", 5, 2);
    await report(phone, 39.74, "accepted", 1, 3);
    const other = await store.latestFixFromOtherDevice(sharedAccount, phone, since);
    // The newest claim from the other device counts, refused or not.
    expect(other).toMatchObject({ lat: 42.5, deviceInstallationId: tablet });
    expect(await store.latestFixFromOtherDevice(sharedAccount, tablet, since)).toMatchObject({ deviceInstallationId: phone });
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
