import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runMigrations } from "./migrate.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;

describeDatabase("flag-set revision PostgreSQL characterization", () => {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 2 });

  beforeAll(async () => {
    await runMigrations(databaseUrl!);
    await pool.query("SELECT nextval('flag_set_revision_sequence')");
  });

  afterAll(async () => {
    await pool.end();
  });

  it("advances for a flag update that matched no rows", async () => {
    const before = await currentRevision();

    const result = await pool.query(
      "UPDATE flags SET name = name WHERE id = $1",
      [randomUUID()]
    );

    expect(result.rowCount).toBe(0);
    await expect(currentRevision()).resolves.toBe(before + 1n);
  });

  it("retains a phantom advance after the flag update rolls back", async () => {
    const before = await currentRevision();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query(
        "UPDATE flags SET name = name WHERE id = $1",
        [randomUUID()]
      );
      expect(result.rowCount).toBe(0);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }

    await expect(currentRevision()).resolves.toBe(before + 1n);
  });

  it("advances for an unrelated kingdom update that matched no rows", async () => {
    const before = await currentRevision();

    const result = await pool.query(
      "UPDATE kingdoms SET description = description WHERE id = $1",
      [randomUUID()]
    );

    expect(result.rowCount).toBe(0);
    await expect(currentRevision()).resolves.toBe(before + 1n);
  });

  async function currentRevision(): Promise<bigint> {
    const result = await pool.query<{ revision: string }>(
      "SELECT last_value::text AS revision FROM flag_set_revision_sequence"
    );
    return BigInt(result.rows[0]!.revision);
  }
});
