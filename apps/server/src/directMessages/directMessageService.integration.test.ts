import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { runMigrations } from "../db/migrate.js";
import { DirectMessageService } from "./directMessageService.js";

const databaseUrl = directMessageTestDatabaseUrl(process.env.DIRECT_MESSAGE_TEST_DATABASE_URL);
const describeDatabase = databaseUrl ? describe : describe.skip;

describeDatabase("direct-message PostgreSQL authority", () => {
  let pool: pg.Pool;
  let service: DirectMessageService;
  let first: string;
  let second: string;
  let outsider: string;

  beforeAll(async () => {
    await runMigrations(databaseUrl!);
    pool = new pg.Pool({ connectionString: databaseUrl!, max: 12 });
  }, 30_000);

  beforeEach(async () => {
    await pool.query("TRUNCATE players CASCADE");
    first = randomUUID();
    second = randomUUID();
    outsider = randomUUID();
    await Promise.all([
      createPlayer(pool, first, "First Ranger"),
      createPlayer(pool, second, "Second Ranger"),
      createPlayer(pool, outsider, "Outsider")
    ]);
    service = new DirectMessageService(pool);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("serializes opposite-direction opens into one exact canonical conversation", async () => {
    const [left, right] = await Promise.all([
      service.openConversation(first, second),
      service.openConversation(second, first)
    ]);
    expect(left.id).toBe(right.id);
    expect(left.peer.playerId).toBe(second);
    expect(right.peer.playerId).toBe(first);
    await expect(pool.query(
      "SELECT count(*)::int AS count FROM direct_conversations"
    )).resolves.toMatchObject({ rows: [{ count: 1 }] });
    await expect(pool.query(
      "SELECT count(*)::int AS count FROM direct_conversation_participants"
    )).resolves.toMatchObject({ rows: [{ count: 2 }] });
  });

  it("persists ordered messages, replays lost acknowledgements, and pages without gaps", async () => {
    const conversation = await service.openConversation(first, second);
    const ids = [randomUUID(), randomUUID(), randomUUID()];
    const sent = [];
    for (const [index, clientMessageId] of ids.entries()) {
      sent.push(await service.send({
        senderPlayerId: first,
        recipientPlayerId: second,
        clientMessageId,
        body: `message ${index + 1}`
      }));
    }
    expect(sent.map((result) => result.message.sequence)).toEqual(["1", "2", "3"]);
    const replay = await service.send({
      senderPlayerId: first,
      recipientPlayerId: second,
      clientMessageId: ids[1]!,
      body: "message 2"
    });
    expect(replay.replayed).toBe(true);
    expect(replay.message.id).toBe(sent[1]!.message.id);

    const newest = await service.history(second, conversation.id, { limit: 2 });
    expect(newest.messages.map((message) => message.sequence)).toEqual(["2", "3"]);
    expect(newest.hasMore).toBe(true);
    const older = await service.history(second, conversation.id, {
      limit: 2,
      beforeSequence: newest.beforeSequence
    });
    expect(older.messages.map((message) => message.sequence)).toEqual(["1"]);
    expect(new Set([...older.messages, ...newest.messages].map((message) => message.id)).size).toBe(3);
    await expect(service.history(outsider, conversation.id))
      .rejects.toMatchObject({ code: "conversation_unavailable" });
  });

  it("tracks offline sent, delivered, read, unread, mute, preferences, and cursor recovery", async () => {
    const conversation = await service.openConversation(first, second);
    const sent = await service.send({
      senderPlayerId: first,
      recipientPlayerId: second,
      clientMessageId: randomUUID(),
      body: "offline durable"
    });
    expect(sent.message.status).toBe("sent");
    expect((await service.listConversations(second)).conversations[0]?.unreadCount).toBe(1);

    expect(await service.markDelivered(second, conversation.id, sent.message.sequence)).toBe("1");
    expect((await service.history(first, conversation.id)).messages[0]?.status).toBe("delivered");
    expect(await service.markRead(second, conversation.id, sent.message.sequence)).toBe("1");
    expect(await service.markRead(second, conversation.id, sent.message.sequence)).toBe("1");
    expect((await service.listConversations(second)).conversations[0]?.unreadCount).toBe(0);
    expect((await service.history(first, conversation.id)).messages[0]?.status).toBe("read");

    await expect(service.setMuted(second, conversation.id, true)).resolves.toBe(true);
    await expect(service.updatePreferences(second, {
      soundsEnabled: false,
      suppressBannersDuringCombat: true
    })).resolves.toEqual({ soundsEnabled: false, suppressBannersDuringCombat: true });
    const events = await service.syncEvents(second, "0");
    expect(events.events.some((event) => event.kind === "message_created")).toBe(true);
    expect(events.events.some((event) => event.kind === "message_read")).toBe(true);
    expect(events.events.some((event) => event.kind === "mute_updated")).toBe(true);
    expect(await service.acknowledgeEvents(second, events.nextCursor)).toBe(events.nextCursor);
    expect((await service.syncEvents(second)).events).toEqual([]);
  });

  it("retains history after a block while denying new sends with a privacy-safe error", async () => {
    const conversation = await service.openConversation(first, second);
    await service.send({
      senderPlayerId: first,
      recipientPlayerId: second,
      clientMessageId: randomUUID(),
      body: "before block"
    });
    await pool.query(
      "INSERT INTO player_blocks (blocker_id,blocked_id) VALUES ($1,$2)",
      [second, first]
    );
    await expect(service.send({
      senderPlayerId: first,
      recipientPlayerId: second,
      clientMessageId: randomUUID(),
      body: "after block"
    })).rejects.toMatchObject({
      code: "not_allowed",
      message: "You cannot perform that action."
    });
    expect((await service.history(first, conversation.id)).messages).toHaveLength(1);
  });

  it("shares rate limits across service instances and rejects idempotency conflicts", async () => {
    const firstWorker = new DirectMessageService(pool, { rateMaximum: 1 });
    const secondWorker = new DirectMessageService(pool, { rateMaximum: 1 });
    const clientMessageId = randomUUID();
    await firstWorker.send({
      senderPlayerId: first,
      recipientPlayerId: second,
      clientMessageId,
      body: "one"
    });
    await expect(firstWorker.send({
      senderPlayerId: first,
      recipientPlayerId: second,
      clientMessageId,
      body: "changed"
    })).rejects.toMatchObject({ code: "idempotency_conflict" });
    await expect(secondWorker.send({
      senderPlayerId: first,
      recipientPlayerId: second,
      clientMessageId: randomUUID(),
      body: "two"
    })).rejects.toMatchObject({ code: "rate_limited" });
    await expect(secondWorker.send({
      senderPlayerId: first,
      recipientPlayerId: second,
      clientMessageId: randomUUID(),
      body: "x".repeat(401)
    })).rejects.toMatchObject({ code: "message_too_long" });
  });
});

function directMessageTestDatabaseUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const databaseName = new URL(value).pathname.slice(1);
  if (!databaseName.startsWith("ash_atlas_stability")) {
    throw new Error("DIRECT_MESSAGE_TEST_DATABASE_URL must use an ash_atlas_stability* database");
  }
  return value;
}

async function createPlayer(pool: pg.Pool, id: string, username: string): Promise<void> {
  await pool.query(
    `INSERT INTO players (
       id,username,region_code,lat,lon,anchor_lat,anchor_lon,
       move_leash_radius_m,online,geom
     ) VALUES ($1,$2,'GLOBAL',0,0,0,0,1250,false,
               ST_SetSRID(ST_MakePoint(0,0),4326))`,
    [id, username]
  );
}
