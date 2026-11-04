import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { runMigrations } from "../db/migrate.js";
import { ProfileSocialService } from "./profiles.js";
import { RecentPlayersService } from "./recentPlayers.js";

const databaseUrl = process.env.PROFILE_TEST_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;
const { Pool } = pg;

describeDatabase("recent players PostgreSQL integration", () => {
  let pool: pg.Pool;
  let now: Date;

  beforeAll(async () => {
    await runMigrations(databaseUrl!);
    pool = new Pool({ connectionString: databaseUrl!, max: 12 });
  }, 30_000);

  beforeEach(async () => {
    await pool.query("TRUNCATE players CASCADE");
    now = new Date("2026-07-15T12:00:00.000Z");
    await createPlayers(pool, ...Array.from({ length: 36 }, (_, index) => `p${index}`));
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("coalesces continuous visibility and enforces the nearby cooldown across restart", async () => {
    const service = recentService(pool, () => now);
    service.recordMutualVisibility([["p0", "p1"]]);
    service.recordMutualVisibility([["p0", "p1"]]);
    await service.flushPending();
    expect(await pairRows(pool, "p0", "p1")).toEqual([
      ["p0", "p1", "nearby", now.toISOString()],
      ["p1", "p0", "nearby", now.toISOString()]
    ]);

    now = new Date(now.getTime() + 4 * 60_000);
    const restartedInsideCooldown = recentService(pool, () => now);
    restartedInsideCooldown.recordMutualVisibility([["p0", "p1"]]);
    await restartedInsideCooldown.flushPending();
    expect((await pairRows(pool, "p0", "p1"))[0]?.[3]).toBe("2026-07-15T12:00:00.000Z");

    now = new Date(now.getTime() + 2 * 60_000);
    const restartedAfterCooldown = recentService(pool, () => now);
    restartedAfterCooldown.recordMutualVisibility([["p0", "p1"]]);
    await restartedAfterCooldown.flushPending();
    expect((await pairRows(pool, "p0", "p1"))[0]?.[3]).toBe(now.toISOString());
  });

  it("prioritizes meaningful Local and party interactions over a nearby re-entry", async () => {
    const service = recentService(pool, () => now);
    service.recordMutualVisibility([["p0", "p1"]]);
    await service.flushPending();
    now = new Date(now.getTime() + 1_000);
    service.recordLocalDelivery("p0", ["p1"]);
    await service.flushPending();
    now = new Date(now.getTime() + 1_000);
    service.recordMutualVisibility([["p0", "p1"]]);
    await service.flushPending();
    expect((await pairRows(pool, "p0", "p1")).every((row) => row[2] === "local_chat")).toBe(true);

    now = new Date(now.getTime() + 1_000);
    service.recordPartyJoin("p1", ["p0"]);
    await service.flushPending();
    expect((await pairRows(pool, "p0", "p1")).every((row) => row[2] === "party")).toBe(true);
  });

  it("returns only the authenticated owner's newest bounded summaries without location fields", async () => {
    const service = recentService(pool, () => now);
    for (let index = 1; index < 36; index += 1) {
      now = new Date(now.getTime() + 1_000);
      service.recordLocalDelivery("p0", [`p${index}`]);
    }
    await service.flushPending();
    const list = await service.list("p0", 30);
    expect(list.entries).toHaveLength(30);
    expect(list.entries[0]?.playerId).toBe("p35");
    expect(list.entries.at(-1)?.playerId).toBe("p6");
    expect(Object.keys(list.entries[0] ?? {})).not.toEqual(expect.arrayContaining([
      "lat", "lon", "location", "regionCode", "zoneId", "flagId"
    ]));
    expect(await service.list("p1", 30)).toEqual({ entries: [
      expect.objectContaining({ playerId: "p0" })
    ] });
  });

  it("serializes block cleanup against recent upserts and does not restore rows on unblock", async () => {
    const recent = recentService(pool, () => now);
    const social = new ProfileSocialService(pool);
    recent.recordLocalDelivery("p0", ["p1"]);
    await recent.flushPending();
    expect(await pairRows(pool, "p0", "p1")).toHaveLength(2);

    await social.mutate("p0", "p1", "block");
    expect(await pairRows(pool, "p0", "p1")).toEqual([]);
    expect(await recent.list("p0", 30)).toEqual({ entries: [] });
    expect(await recent.list("p1", 30)).toEqual({ entries: [] });

    recent.recordMutualVisibility([["p0", "p1"]]);
    await recent.flushPending();
    expect(await pairRows(pool, "p0", "p1")).toEqual([]);
    await social.mutate("p0", "p1", "unblock");
    expect(await pairRows(pool, "p0", "p1")).toEqual([]);

    const queuedBeforeBlock = recentService(pool, () => now);
    queuedBeforeBlock.recordLocalDelivery("p2", ["p3"]);
    await social.mutate("p2", "p3", "block");
    await social.mutate("p2", "p3", "unblock");
    await queuedBeforeBlock.flushPending();
    expect(await pairRows(pool, "p2", "p3")).toEqual([]);

    const suppression = await pool.query<{ suppressed_at: Date }>(
      `SELECT suppressed_at FROM recent_player_pair_suppressions
       WHERE player_low_id = $1 AND player_high_id = $2`,
      ["p2", "p3"]
    );
    now = new Date(suppression.rows[0]!.suppressed_at.getTime() + 1);
    const encounteredAfterUnblock = recentService(pool, () => now);
    encounteredAfterUnblock.recordLocalDelivery("p2", ["p3"]);
    await encounteredAfterUnblock.flushPending();
    expect(await pairRows(pool, "p2", "p3")).toHaveLength(2);
  });
});

function recentService(pool: pg.Pool, now: () => Date): RecentPlayersService {
  return new RecentPlayersService(pool, { now, scheduleFlush: () => undefined });
}

async function createPlayers(pool: pg.Pool, ...playerIds: string[]): Promise<void> {
  for (const playerId of playerIds) {
    await pool.query(
      `INSERT INTO players (
         id, username, display_color, region_code, lat, lon, anchor_lat, anchor_lon,
         move_leash_radius_m, online, geom
       ) VALUES ($1, $2, $3, 'NM', 35, -106, 35, -106, 900, false,
                 ST_SetSRID(ST_MakePoint(-106, 35), 4326))`,
      [playerId, `Player ${playerId.toUpperCase()}`, "#38bdf8"]
    );
  }
}

async function pairRows(pool: pg.Pool, left: string, right: string): Promise<string[][]> {
  const result = await pool.query<{
    owner_player_id: string;
    recent_player_id: string;
    interaction_type: string;
    interaction_at: Date;
  }>(
    `SELECT owner_player_id, recent_player_id, interaction_type, interaction_at
     FROM recent_players
     WHERE (owner_player_id = $1 AND recent_player_id = $2)
        OR (owner_player_id = $2 AND recent_player_id = $1)
     ORDER BY owner_player_id`,
    [left, right]
  );
  return result.rows.map((row) => [
    row.owner_player_id,
    row.recent_player_id,
    row.interaction_type,
    row.interaction_at.toISOString()
  ]);
}
