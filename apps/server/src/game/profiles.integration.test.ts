import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { runMigrations } from "../db/migrate.js";
import { PostgresPartyAuthority } from "./party/PostgresPartyAuthority.js";
import { ProfileSocialError, ProfileSocialService } from "./profiles.js";

const databaseUrl = process.env.PROFILE_TEST_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;
const { Pool } = pg;

describeDatabase("profile/social PostgreSQL integration", () => {
  let pool: pg.Pool;
  let service: ProfileSocialService;

  beforeAll(async () => {
    await runMigrations(databaseUrl!);
    pool = new Pool({ connectionString: databaseUrl!, max: 12 });
    service = new ProfileSocialService(pool);
  }, 30_000);

  beforeEach(async () => {
    await pool.query("TRUNCATE players CASCADE");
    await createPlayers(pool, "a", "b", "c");
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("executes the migration with all tables, indexes, triggers, and live constraints", async () => {
    await runMigrations(databaseUrl!);
    expect((await pool.query<{ body_variant_id: string }>(
      "SELECT body_variant_id FROM players WHERE id = 'a'"
    )).rows[0]?.body_variant_id).toBe("default");
    await expect(pool.query(
      "UPDATE players SET body_variant_id = 'unsupported' WHERE id = 'a'"
    )).rejects.toMatchObject({ code: "23514" });
    const tables = await pool.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables
       WHERE schemaname = 'public' AND tablename = ANY($1::text[])`,
      [[
        "player_profiles",
        "friend_requests",
        "friendships",
        "player_enemy_marks",
        "enemy_neutrality_requests",
        "player_blocks"
      ]]
    );
    expect(tables.rows.map((row) => row.tablename).sort()).toEqual([
      "enemy_neutrality_requests",
      "friend_requests",
      "friendships",
      "player_blocks",
      "player_enemy_marks",
      "player_profiles"
    ]);
    const indexes = await pool.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND indexname LIKE ANY($1::text[])`,
      [["friend_requests_%", "friendships_%", "player_enemy_marks_%", "player_blocks_%"]]
    );
    expect(indexes.rowCount).toBeGreaterThanOrEqual(11);
    const trigger = await pool.query(
      `SELECT 1 FROM pg_trigger WHERE tgname = 'player_profiles_set_updated_at' AND NOT tgisinternal`
    );
    expect(trigger.rowCount).toBe(1);

    await expect(pool.query(
      "INSERT INTO friend_requests (requester_id, recipient_id) VALUES ('a', 'a')"
    )).rejects.toMatchObject({ code: "23514" });
    await expect(pool.query(
      "INSERT INTO player_blocks (blocker_id, blocked_id) VALUES ('a', 'missing')"
    )).rejects.toMatchObject({ code: "23503" });
    await pool.query("INSERT INTO player_blocks (blocker_id, blocked_id) VALUES ('a', 'b')");
    await expect(pool.query(
      "INSERT INTO player_blocks (blocker_id, blocked_id) VALUES ('a', 'b')"
    )).rejects.toMatchObject({ code: "23505" });
    await expect(pool.query(
      "INSERT INTO friendships (player_low_id, player_high_id) VALUES ('b', 'a')"
    )).rejects.toMatchObject({ code: "23514" });
  });

  it("views own/other profiles, preserves omitted fields, and returns only public plain text", async () => {
    expect((await service.getProfile("a", "a")).portrait.bodyVariantId).toBe("default");
    await service.updateProfile("a", { title: "Alpha Tester", biography: "Initial biography" });
    const titleOnly = await service.updateProfile("a", { title: "Noob" });
    expect(titleOnly).toMatchObject({
      playerId: "a", title: "Noob", biography: "Initial biography", isSelf: true
    });
    const biographyOnly = await service.updateProfile("a", { biography: "<script>plain</script>" });
    expect(biographyOnly).toMatchObject({ title: "Noob", biography: "<script>plain</script>" });
    const viewedByOther = await service.getProfile("b", "a");
    expect(viewedByOther.isSelf).toBe(false);
    expect(viewedByOther).not.toHaveProperty("email");
    expect(viewedByOther).not.toHaveProperty("accountId");
    expect(viewedByOther).not.toHaveProperty("lastSeenAt");
    await pool.query("UPDATE players SET body_variant_id = 'female' WHERE id = 'a'");
    expect((await service.getProfile("b", "a")).portrait.bodyVariantId).toBe("default");
    await expect(service.updateProfile("a", { title: `bad\u0000title` as never })).rejects.toBeInstanceOf(ProfileSocialError);
    await expect(service.updateProfile("a", { title: "Guardian" as never })).rejects.toBeInstanceOf(ProfileSocialError);
  });

  it("keeps simultaneous partial profile edits canonical", async () => {
    await service.updateProfile("a", { title: "Alpha Tester", biography: "Old bio" });
    await Promise.all([
      service.updateProfile("a", { title: "Yo Mama" }),
      service.updateProfile("a", { biography: "New biography" })
    ]);
    expect(await service.getProfile("a", "a")).toMatchObject({
      title: "Yo Mama", biography: "New biography"
    });
  });

  it("handles send, duplicate, crossed, accept, and canonical friendship idempotently", async () => {
    expect((await service.mutate("a", "b", "send_friend_request")).relationship.friendship)
      .toBe("outgoing_request");
    await service.mutate("a", "b", "send_friend_request");
    expect(await count(pool, "friend_requests")).toBe(1);
    await Promise.all([
      service.mutate("a", "b", "send_friend_request"),
      service.mutate("b", "a", "send_friend_request")
    ]);
    expect(await pairCounts(pool, "a", "b")).toEqual({ friends: 1, requests: 0, blocks: 0, enemies: 0 });
    await service.mutate("b", "a", "accept_friend_request");
    expect(await count(pool, "friendships")).toBe(1);
    const rows = await pool.query("SELECT player_low_id, player_high_id FROM friendships");
    expect(rows.rows).toEqual([{ player_low_id: "a", player_high_id: "b" }]);
  });

  it("keeps friend and enemy Messages durable, synchronized, and idempotent for offline reads", async () => {
    await service.mutate("a", "b", "send_friend_request");
    await service.mutate("a", "b", "send_friend_request");
    await service.mutate("c", "b", "send_friend_request");

    const offlineInbox = await new ProfileSocialService(pool).inbox("b");
    expect(offlineInbox.pendingIncomingFriendRequestCount).toBe(2);
    expect(offlineInbox.entries.filter((entry) => entry.kind === "friend_request")).toMatchObject([
      { actorPlayerId: "c", actorDisplayName: "Player C", state: "pending" },
      { actorPlayerId: "a", actorDisplayName: "Player A", state: "pending" }
    ]);

    await service.mutate("b", "a", "accept_friend_request");
    let synchronized = await service.inbox("b");
    expect(synchronized.pendingIncomingFriendRequestCount).toBe(1);
    expect(synchronized.entries.find((entry) => entry.actorPlayerId === "a")).toMatchObject({
      kind: "friend_request",
      state: "accepted"
    });

    await service.mutate("b", "c", "decline_friend_request");
    synchronized = await service.inbox("b");
    expect(synchronized.pendingIncomingFriendRequestCount).toBe(0);
    expect(synchronized.entries.find((entry) => entry.actorPlayerId === "c")).toMatchObject({
      kind: "friend_request",
      state: "declined"
    });

    await service.mutate("a", "c", "mark_enemy");
    await service.mutate("a", "c", "mark_enemy");
    const enemyEntries = (await new ProfileSocialService(pool).inbox("c")).entries
      .filter((entry) => entry.kind === "enemy_declaration");
    expect(enemyEntries).toHaveLength(1);
    expect(enemyEntries[0]).toMatchObject({
      actorPlayerId: "a",
      actorDisplayName: "Player A",
      state: "notice"
    });
  });

  it("allows only the recipient to accept and scopes decline/cancel to the intended direction", async () => {
    await service.mutate("a", "b", "send_friend_request");
    await service.mutate("c", "a", "accept_friend_request");
    expect(await count(pool, "friendships")).toBe(0);
    expect(await count(pool, "friend_requests")).toBe(1);

    await service.mutate("c", "b", "send_friend_request");
    await service.mutate("b", "a", "decline_friend_request");
    expect(await requestExists(pool, "a", "b")).toBe(false);
    expect(await requestExists(pool, "c", "b")).toBe(true);
    await service.mutate("b", "a", "decline_friend_request");

    await service.mutate("a", "b", "send_friend_request");
    await service.mutate("a", "c", "send_friend_request");
    await service.mutate("a", "b", "cancel_friend_request");
    expect(await requestExists(pool, "a", "b")).toBe(false);
    expect(await requestExists(pool, "a", "c")).toBe(true);
    await service.mutate("a", "b", "cancel_friend_request");
  });

  it("removes friendship mutually and replays remove safely", async () => {
    await becomeFriends(service, "a", "b");
    await service.mutate("a", "b", "remove_friend");
    await service.mutate("b", "a", "remove_friend");
    expect(await count(pool, "friendships")).toBe(0);
  });

  it("creates one mutual enemy relationship idempotently across simultaneous declarations and reconnects", async () => {
    await becomeFriends(service, "a", "b");
    await Promise.all([
      service.mutate("a", "b", "mark_enemy"),
      service.mutate("b", "a", "mark_enemy"),
      service.mutate("a", "b", "mark_enemy")
    ]);
    expect(await pairCounts(pool, "a", "b")).toEqual({ friends: 0, requests: 0, blocks: 0, enemies: 1 });
    expect((await service.getProfile("a", "b")).relationship.enemyMarkedByViewer).toBe(true);
    expect((await service.getProfile("b", "a")).relationship.enemyMarkedByViewer).toBe(true);
    expect((await service.getProfile("b", "b")).relationship.enemyMarkedByViewer).toBe(false);
    expect((await service.getProfile("c", "b")).relationship.enemyMarkedByViewer).toBe(false);
    expect((await service.list("a", "enemies", 0, 25)).entries.map((entry) => entry.playerId)).toEqual(["b"]);
    expect((await service.list("b", "enemies", 0, 25)).entries.map((entry) => entry.playerId)).toEqual(["a"]);
    const reconnected = new ProfileSocialService(pool);
    expect((await reconnected.getProfile("a", "b")).relationship.enemyMarkedByViewer).toBe(true);
  });

  it("requires recipient-approved neutrality and keeps duplicate or crossing requests canonical", async () => {
    await service.mutate("a", "b", "mark_enemy");
    await service.mutate("a", "b", "request_neutrality");
    await service.mutate("a", "b", "request_neutrality");
    await service.mutate("b", "a", "request_neutrality");
    expect(await count(pool, "enemy_neutrality_requests")).toBe(1);
    expect((await service.getProfile("a", "b")).relationship).toMatchObject({
      enemyMarkedByViewer: true,
      neutralityRequest: "outgoing"
    });
    expect((await service.getProfile("b", "a")).relationship).toMatchObject({
      enemyMarkedByViewer: true,
      neutralityRequest: "incoming"
    });

    await service.mutate("b", "a", "reject_neutrality");
    expect(await count(pool, "enemy_neutrality_requests")).toBe(0);
    expect((await service.getProfile("a", "b")).relationship.enemyMarkedByViewer).toBe(true);

    await service.mutate("a", "b", "request_neutrality");
    await service.mutate("b", "a", "accept_neutrality");
    expect(await count(pool, "enemy_neutrality_requests")).toBe(0);
    expect(await count(pool, "player_enemy_marks")).toBe(0);
    expect((await service.getProfile("a", "b")).relationship.enemyMarkedByViewer).toBe(false);
    expect((await service.getProfile("b", "a")).relationship.enemyMarkedByViewer).toBe(false);
    expect((await service.mutate("a", "b", "send_friend_request")).relationship.friendship)
      .toBe("outgoing_request");
  });

  it("leaves enemies intact when neutrality is canceled or expires", async () => {
    await service.mutate("a", "b", "mark_enemy");
    await service.mutate("a", "b", "request_neutrality");
    await service.mutate("a", "b", "cancel_neutrality");
    expect((await service.getProfile("a", "b")).relationship.enemyMarkedByViewer).toBe(true);

    await service.mutate("b", "a", "request_neutrality");
    await pool.query("UPDATE enemy_neutrality_requests SET expires_at = now() - interval '1 second'");
    const expired = await service.expireNeutralityRequests();
    expect(expired).toEqual([{
      playerLowId: "a",
      playerHighId: "b",
      requesterId: "b"
    }]);
    expect((await service.getProfile("a", "b")).relationship).toMatchObject({
      enemyMarkedByViewer: true,
      neutralityRequest: "none"
    });
  });

  it("blocks durable party invitations while enemies or neutrality-pending, then allows them after acceptance", async () => {
    await pool.query(
      `UPDATE players
       SET lat = -45, lon = 120,
           geom = ST_SetSRID(ST_MakePoint(120, -45), 4326)
       WHERE id = 'b'`
    );
    const parties = new PostgresPartyAuthority(pool);
    await parties.initialize();
    try {
      const party = await parties.createParty("party:far-enemy-test", "a", "create-far-party");
      expect(party.memberPlayerIds).toEqual(["a"]);

      await service.mutate("a", "b", "mark_enemy");
      await service.mutate("a", "b", "request_neutrality");
      await expect(parties.inviteMember("b", "a", "invite-while-pending")).rejects.toMatchObject({
        code: "PARTY_TARGET_ENEMY",
        message: "You cannot invite an enemy to your party."
      });

      await service.mutate("b", "a", "accept_neutrality");
      await expect(parties.inviteMember("b", "a", "invite-after-neutral"))
        .resolves.toMatchObject({ leaderPlayerId: "a", inviterPlayerId: "a" });

      await service.mutate("b", "a", "mark_enemy");
      await expect(parties.acceptInvite("party:far-enemy-test", "b", "accept-while-enemy"))
        .rejects.toMatchObject({ code: "PARTY_TARGET_ENEMY" });

      await service.mutate("b", "a", "request_neutrality");
      await service.mutate("a", "b", "accept_neutrality");
      await service.mutate("a", "b", "block");
      await expect(parties.acceptInvite("party:far-enemy-test", "b", "accept-while-blocked"))
        .rejects.toMatchObject({ code: "PARTY_TARGET_BLOCKED" });
      await service.mutate("a", "b", "unblock");
      await expect(parties.acceptInvite("party:far-enemy-test", "b", "accept-after-neutral"))
        .resolves.toMatchObject({ memberPlayerIds: ["a", "b"] });
    } finally {
      await parties.close();
    }
  });

  it("makes blocks one-sided, private, replay-safe, and dominant over friendship/requests", async () => {
    await becomeFriends(service, "a", "b");
    await service.mutate("a", "b", "block");
    await service.mutate("a", "b", "block");
    expect(await pairCounts(pool, "a", "b")).toEqual({ friends: 0, requests: 0, blocks: 1, enemies: 0 });
    expect((await service.getProfile("a", "b")).relationship.friendship).toBe("blocked_by_viewer");
    expect((await service.getProfile("b", "a")).relationship.friendship).toBe("unavailable");
    expect((await service.list("a", "blocked", 0, 25)).entries.map((entry) => entry.playerId)).toEqual(["b"]);
    expect((await service.list("b", "blocked", 0, 25)).entries).toEqual([]);
    await expect(service.mutate("b", "a", "send_friend_request")).rejects.toMatchObject({ code: "RELATIONSHIP_UNAVAILABLE" });
    await expect(service.mutate("b", "a", "accept_friend_request")).rejects.toMatchObject({ code: "RELATIONSHIP_UNAVAILABLE" });
    await service.mutate("a", "b", "unblock");
    await service.mutate("a", "b", "unblock");
    expect(await count(pool, "player_blocks")).toBe(0);
    await pool.query(
      `INSERT INTO friend_requests (requester_id, recipient_id)
       VALUES ('a', 'b'), ('b', 'a')`
    );
    await service.mutate("a", "b", "block");
    expect(await pairCounts(pool, "a", "b")).toEqual({ friends: 0, requests: 0, blocks: 1, enemies: 0 });
    await service.mutate("a", "b", "unblock");
  });

  it("serializes accept versus cancel and returns committed state", async () => {
    await service.mutate("a", "b", "send_friend_request");
    await Promise.allSettled([
      service.mutate("b", "a", "accept_friend_request"),
      service.mutate("a", "b", "cancel_friend_request")
    ]);
    const state = await pairCounts(pool, "a", "b");
    expect(state.friends).toBeLessThanOrEqual(1);
    if (state.friends === 1) expect(state.requests).toBe(0);
    expect((await service.getProfile("a", "b")).relationship.friendship)
      .toBe(state.friends === 1 ? "friends" : "none");
  });

  it("serializes accept/send versus block with no surviving friendship or request", async () => {
    await service.mutate("a", "b", "send_friend_request");
    await Promise.allSettled([
      service.mutate("b", "a", "accept_friend_request"),
      service.mutate("a", "b", "block")
    ]);
    expect(await pairCounts(pool, "a", "b")).toEqual({ friends: 0, requests: 0, blocks: 1, enemies: 0 });

    await service.mutate("a", "b", "unblock");
    await Promise.allSettled([
      service.mutate("b", "a", "send_friend_request"),
      service.mutate("a", "b", "block")
    ]);
    expect(await pairCounts(pool, "a", "b")).toEqual({ friends: 0, requests: 0, blocks: 1, enemies: 0 });
  });

  it("serializes remove versus enemy and duplicate tab requests without duplicates", async () => {
    await becomeFriends(service, "a", "b");
    await Promise.all([
      service.mutate("a", "b", "remove_friend"),
      service.mutate("a", "b", "mark_enemy")
    ]);
    expect(await pairCounts(pool, "a", "b")).toEqual({ friends: 0, requests: 0, blocks: 0, enemies: 1 });
    await service.mutate("a", "b", "request_neutrality");
    await service.mutate("b", "a", "accept_neutrality");
    await Promise.all(Array.from({ length: 8 }, () => service.mutate("a", "b", "send_friend_request")));
    expect(await count(pool, "friend_requests")).toBe(1);
  });

  it("shows another player's friends and enemies, and denies them across a block", async () => {
    await becomeFriends(service, "a", "b");
    await service.mutate("a", "c", "mark_enemy");
    const friends = await service.listForPlayer("c", "a", "friends", 0, 25);
    expect(friends.entries.map((entry) => entry.playerId)).toEqual(["b"]);
    // c is not b's friend, so b's presence stays hidden from c.
    expect(friends.entries[0]?.presence).toBe("hidden");
    const enemies = await service.listForPlayer("b", "a", "enemies", 0, 25);
    expect(enemies.entries.map((entry) => entry.playerId)).toEqual(["c"]);

    await service.mutate("a", "c", "block");
    await expect(service.listForPlayer("c", "a", "friends", 0, 25))
      .rejects.toMatchObject({ code: "RELATIONSHIP_UNAVAILABLE", statusCode: 403 });
  });
});

async function createPlayers(pool: pg.Pool, ...playerIds: string[]): Promise<void> {
  for (const playerId of playerIds) {
    await pool.query(
      `INSERT INTO players (
         id, username, display_color, region_code, lat, lon, anchor_lat, anchor_lon,
         move_leash_radius_m, online, geom
       ) VALUES ($1, $2, NULL, 'NM', 35, -106, 35, -106, 900, false,
                 ST_SetSRID(ST_MakePoint(-106, 35), 4326))`,
      [playerId, `Player ${playerId.toUpperCase()}`]
    );
  }
}

async function becomeFriends(service: ProfileSocialService, left: string, right: string): Promise<void> {
  await service.mutate(left, right, "send_friend_request");
  await service.mutate(right, left, "accept_friend_request");
}

async function count(pool: pg.Pool, table: string): Promise<number> {
  const allowed = new Set([
    "friend_requests",
    "friendships",
    "player_enemy_marks",
    "enemy_neutrality_requests",
    "player_blocks"
  ]);
  if (!allowed.has(table)) throw new Error("Unsafe test table");
  const result = await pool.query<{ count: string }>(`SELECT count(*)::text AS count FROM ${table}`);
  return Number(result.rows[0]?.count ?? 0);
}

async function requestExists(pool: pg.Pool, requesterId: string, recipientId: string): Promise<boolean> {
  const result = await pool.query(
    "SELECT 1 FROM friend_requests WHERE requester_id = $1 AND recipient_id = $2",
    [requesterId, recipientId]
  );
  return result.rowCount === 1;
}

async function pairCounts(pool: pg.Pool, left: string, right: string) {
  const result = await pool.query<{
    friends: string;
    requests: string;
    blocks: string;
    enemies: string;
  }>(
    `SELECT
       (SELECT count(*) FROM friendships WHERE player_low_id = LEAST($1, $2) AND player_high_id = GREATEST($1, $2))::text AS friends,
       (SELECT count(*) FROM friend_requests WHERE (requester_id = $1 AND recipient_id = $2) OR (requester_id = $2 AND recipient_id = $1))::text AS requests,
       (SELECT count(*) FROM player_blocks WHERE (blocker_id = $1 AND blocked_id = $2) OR (blocker_id = $2 AND blocked_id = $1))::text AS blocks,
       (SELECT count(*) FROM player_enemy_marks
        WHERE owner_id = LEAST($1, $2) AND target_id = GREATEST($1, $2))::text AS enemies`,
    [left, right]
  );
  const row = result.rows[0]!;
  return {
    friends: Number(row.friends),
    requests: Number(row.requests),
    blocks: Number(row.blocks),
    enemies: Number(row.enemies)
  };
}
