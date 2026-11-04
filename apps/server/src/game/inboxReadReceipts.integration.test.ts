import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { runMigrations } from "../db/migrate.js";
import { InboxReadReceiptService } from "./inboxReadReceipts.js";

const databaseUrl = inboxTestDatabaseUrl(process.env.INBOX_READ_TEST_DATABASE_URL);
const describeDatabase = databaseUrl ? describe : describe.skip;

describeDatabase("durable Messages read receipts", () => {
  let pool: pg.Pool;
  let playerId: string;

  beforeAll(async () => {
    await runMigrations(databaseUrl!);
    pool = new pg.Pool({ connectionString: databaseUrl!, max: 4 });
  }, 30_000);

  beforeEach(async () => {
    await pool.query("TRUNCATE players CASCADE");
    playerId = randomUUID();
    await pool.query(
      `INSERT INTO players (
         id,username,region_code,lat,lon,anchor_lat,anchor_lon,
         move_leash_radius_m,online,geom
       ) VALUES ($1,'Inbox Ranger','GLOBAL',0,0,0,0,1250,false,
                 ST_SetSRID(ST_MakePoint(0,0),4326))`,
      [playerId]
    );
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("persists bounded exact revisions idempotently across service instances", async () => {
    const first = new InboxReadReceiptService(pool);
    const initial = await first.markRead(playerId, [
      { entryKey: "travel:one", revision: "revision-1" },
      { entryKey: "travel:one", revision: "revision-1" },
      { entryKey: "party:two", revision: "revision-4" }
    ]);
    expect(initial.map(({ entryKey, revision }) => ({ entryKey, revision }))).toEqual([
      { entryKey: "party:two", revision: "revision-4" },
      { entryKey: "travel:one", revision: "revision-1" }
    ]);

    const reconnected = new InboxReadReceiptService(pool);
    expect(await reconnected.list(playerId)).toMatchObject(initial);
    const repeated = await reconnected.markRead(playerId, [
      { entryKey: "travel:one", revision: "revision-1" }
    ]);
    expect(repeated.find(({ entryKey }) => entryKey === "travel:one")?.revision).toBe("revision-1");
  });

  it("records only the submitted revision so a later notification remains unread", async () => {
    const service = new InboxReadReceiptService(pool);
    await service.markRead(playerId, [
      { entryKey: "travel:race", revision: "pending-updated-at" }
    ]);
    const receipt = (await service.list(playerId)).find(
      ({ entryKey }) => entryKey === "travel:race"
    );
    expect(receipt?.revision).toBe("pending-updated-at");
    expect(receipt?.revision).not.toBe("cancelled-updated-at");
  });

  it("lists only the player's durable game notices newest first", async () => {
    const otherPlayerId = randomUUID();
    await pool.query(
      `INSERT INTO players (
         id,username,region_code,lat,lon,anchor_lat,anchor_lon,
         move_leash_radius_m,online,geom
       ) VALUES ($1,'Other Ranger','GLOBAL',0,0,0,0,1250,false,
                 ST_SetSRID(ST_MakePoint(0,0),4326))`,
      [otherPlayerId]
    );
    const olderEventId = randomUUID();
    const newerEventId = randomUUID();
    await pool.query(
      `INSERT INTO player_inbox_entries (
         id,player_id,entry_kind,message,created_at,status,event_kind,event_id
       ) VALUES
         ($1,$2,'game_notice','A Phoenix is attacking your flag!','2026-08-20T10:00:00Z','notice','legendary_bird_event',$3),
         ($4,$2,'game_notice','A Thunderbird is attacking your flag!','2026-08-20T11:00:00Z','notice','legendary_bird_event',$5),
         ($6,$7,'game_notice','Not yours','2026-08-20T12:00:00Z','notice','legendary_bird_event',$8)`,
      [randomUUID(), playerId, olderEventId, randomUUID(), newerEventId,
        randomUUID(), otherPlayerId, randomUUID()]
    );

    await expect(new InboxReadReceiptService(pool).listGameNotices(playerId)).resolves.toEqual([
      {
        eventKind: "legendary_bird_event",
        eventId: newerEventId,
        message: "A Thunderbird is attacking your flag!",
        createdAt: "2026-08-20T11:00:00.000Z"
      },
      {
        eventKind: "legendary_bird_event",
        eventId: olderEventId,
        message: "A Phoenix is attacking your flag!",
        createdAt: "2026-08-20T10:00:00.000Z"
      }
    ]);
  });
});

function inboxTestDatabaseUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const databaseName = new URL(value).pathname.slice(1);
  if (!databaseName.startsWith("ash_atlas_stability")) {
    throw new Error("INBOX_READ_TEST_DATABASE_URL must use an ash_atlas_stability* database");
  }
  return value;
}
