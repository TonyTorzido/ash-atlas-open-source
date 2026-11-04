import { CHAT_LOCAL_CHANNEL_KEY, type ServerMessage } from "@ash-atlas/shared";
import { randomUUID } from "node:crypto";
import cookie from "@fastify/cookie";
import Fastify from "fastify";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { installAuthGuard } from "../auth/authGuard.js";
import type { AuthService } from "../auth/authService.js";
import { loadConfig } from "../config.js";
import { runMigrations } from "../db/migrate.js";
import type { FlagService } from "../game/flags.js";
import { CombatEngine } from "../game/combat/combatEngine.js";
import { InventoryService } from "../game/inventory.js";
import type { PlayerService } from "../game/players.js";
import { GameState, type PlayerRecord } from "../game/state.js";
import { createLogger } from "../logger.js";
import { ConnectionRegistry, type SocketLike } from "../realtime/connectionRegistry.js";
import { registerRealtime } from "../realtime/websocket.js";
import { worldBootstrapLocationFixtures } from "../realtime/worldBootstrapTestFixtures.js";
import { BoundedChatRateLimiter } from "./boundedMemory.js";
import { ChatRealtimeCoordinator } from "./chatRealtime.js";
import { ChatService } from "./chatService.js";
import { PostgresModerationDecisionService } from "./moderation.js";

const databaseUrl = process.env.CHAT_TEST_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;
const { Pool } = pg;

describeDatabase("chat PostgreSQL integration", () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    await runMigrations(databaseUrl!);
    pool = new Pool({ connectionString: databaseUrl!, max: 30 });
  }, 30_000);

  beforeEach(async () => {
    await pool.query("TRUNCATE players CASCADE");
    await pool.query("UPDATE chat_channel_sequences SET last_sequence = 0");
    await createPlayers(pool, 24);
  });

  afterAll(async () => {
    if (pool) {
      await pool.query("TRUNCATE players CASCADE");
      await pool.query("UPDATE chat_channel_sequences SET last_sequence = 0");
    }
    await pool?.end();
  });

  it("retains one deterministic copy of each public channel and all live indexes", async () => {
    await expect(runMigrations(databaseUrl!)).resolves.toEqual([]);
    const channels = await pool.query<{ channel_key: string }>(
      `SELECT channel_key FROM chat_channels
       WHERE channel_type IN ('public', 'local') ORDER BY channel_key`
    );
    expect(channels.rows.map(({ channel_key }) => channel_key)).toEqual([
      CHAT_LOCAL_CHANNEL_KEY,
      "public:general",
      "public:hunting",
      "public:trading"
    ]);
    const indexes = await pool.query<{ indexname: string }>(
      "SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND indexname LIKE 'chat_%'"
    );
    expect(indexes.rows.map(({ indexname }) => indexname)).toEqual(expect.arrayContaining([
      "chat_messages_channel_sequence_unique_idx",
      "chat_messages_sender_request_unique_idx",
      "chat_mutes_active_global_idx",
      "chat_mutes_active_channel_idx"
    ]));
  });

  it("serializes concurrent channel sends into unique monotonic sequences", async () => {
    const sends = await Promise.all(Array.from({ length: 20 }, (_, index) =>
      service().send({
        channelKey: "public:general",
        senderPlayerId: `player-${index}`,
        senderDisplayName: `Player ${index}`,
        clientRequestId: requestId(index + 1),
        body: `message ${index}`
      })
    ));
    expect(sends.map(({ message }) => message.sequence).sort((a, b) => a - b))
      .toEqual(Array.from({ length: 20 }, (_, index) => index + 1));
    const stored = await pool.query<{ count: string; distinct_sequences: string }>(
      `SELECT count(*)::text AS count,
              count(DISTINCT sequence_number)::text AS distinct_sequences
       FROM chat_messages`
    );
    expect(stored.rows[0]).toEqual({ count: "20", distinct_sequences: "20" });
  });

  it("makes simultaneous duplicate request IDs durably idempotent", async () => {
    const chat = service();
    const input = {
      channelKey: "public:general",
      senderPlayerId: "player-0",
      senderDisplayName: "Player 0",
      clientRequestId: requestId(200),
      body: "one accepted message"
    } as const;
    const results = await Promise.all([chat.send(input), chat.send(input), chat.send(input)]);
    expect(new Set(results.map(({ message }) => message.id)).size).toBe(1);
    expect(results.filter(({ replayed }) => replayed)).toHaveLength(2);
    const count = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM chat_messages"
    );
    expect(count.rows[0]?.count).toBe("1");
  });

  it("persists Local for moderation and idempotency without player-facing history", async () => {
    const chat = service();
    const input = {
      channelKey: CHAT_LOCAL_CHANNEL_KEY,
      senderPlayerId: "player-0",
      senderDisplayName: "Player 0",
      clientRequestId: requestId(250),
      body: "live nearby only"
    } as const;
    const first = await chat.send(input);
    const replay = await chat.send(input);
    expect(first).toMatchObject({ replayed: false, message: { channelKey: CHAT_LOCAL_CHANNEL_KEY } });
    expect(replay).toMatchObject({ replayed: true, message: { id: first.message.id } });
    const stored = await pool.query<{ count: string; channel_type: string }>(
      `SELECT count(*) OVER ()::text AS count, channel.channel_type
       FROM chat_messages message JOIN chat_channels channel ON channel.id = message.channel_id
       WHERE message.id = $1`,
      [first.message.id]
    );
    expect(stored.rows[0]).toEqual({ count: "1", channel_type: "local" });
    await expect(chat.history({ playerId: "player-0", channelKey: CHAT_LOCAL_CHANNEL_KEY }))
      .rejects.toMatchObject({ code: "CHAT_ACCESS_DENIED" });
  });

  it("uses bounded cursor history and persists monotonic read state", async () => {
    for (let index = 0; index < 60; index += 1) {
      await service().send({
        channelKey: "public:hunting",
        senderPlayerId: `player-${index % 24}`,
        senderDisplayName: `Player ${index % 24}`,
        clientRequestId: requestId(1_000 + index),
        body: `hunt ${index}`
      });
    }
    const chat = service();
    const newest = await chat.history({ playerId: "player-0", channelKey: "public:hunting" });
    expect(newest.messages).toHaveLength(50);
    expect(newest.messages[0]?.sequence).toBe(11);
    const older = await chat.history({
      playerId: "player-0",
      channelKey: "public:hunting",
      beforeSequence: 11
    });
    expect(older.messages.map(({ sequence }) => sequence)).toEqual([1,2,3,4,5,6,7,8,9,10]);
    expect(await chat.markRead("player-0", "public:hunting", 55)).toMatchObject({ unreadCount: 5 });
    expect(await chat.markRead("player-0", "public:hunting", 20)).toMatchObject({
      lastReadSequence: 55,
      unreadCount: 5
    });
  });

  it("migrates legacy Kingdom history once without changing representative data", async () => {
    const kingdomId = randomUUID();
    const messageId = randomUUID();
    await pool.query(
      `INSERT INTO kingdoms (
         id, normalized_name, display_name, founder_player_id,
         leader_player_id, founding_request_id
       ) VALUES ($1, $2, 'Legacy Chat Kingdom', 'player-4', 'player-4', $3)`,
      [kingdomId, `legacy-${kingdomId.slice(0, 16)}`, `found-${kingdomId}`]
    );
    await pool.query(
      `INSERT INTO kingdom_chat_messages (
         id, kingdom_id, sender_player_id, request_id, content, created_at
       ) VALUES ($1, $2, 'player-4', 'legacy-request', $3, '2026-01-02T03:04:05Z')`,
      [messageId, kingdomId, "x".repeat(500)]
    );
    await pool.query("DROP TABLE account_chat_preferences");
    await pool.query(
      "DELETE FROM schema_migrations WHERE version = '0700_atlas_chats_presence.sql'"
    );

    await expect(runMigrations(databaseUrl!)).resolves.toEqual(["0700_atlas_chats_presence.sql"]);
    await expect(runMigrations(databaseUrl!)).resolves.toEqual([]);
    const migrated = await pool.query<{
      id: string;
      body: string;
      sequence_number: string;
      username: string;
    }>(
      `SELECT message.id, message.body, message.sequence_number, player.username
       FROM chat_messages message
       JOIN players player ON player.id = message.sender_player_id
       JOIN chat_channels channel ON channel.id = message.channel_id
       WHERE channel.channel_key = $1`,
      [`kingdom:${kingdomId}`]
    );
    expect(migrated.rows).toEqual([{
      id: messageId,
      body: "x".repeat(500),
      sequence_number: "1",
      username: "Player 4"
    }]);
  });

  it("enforces City membership, join-time history, and immediate revocation", async () => {
    const cityId = randomUUID();
    const seatFlagId = randomUUID();
    await pool.query(
      `INSERT INTO flags (
         id, owner_id, name, lat, lon, claim_radius_m,
         resource_vision_radius_m, access_mode, geom
       ) VALUES ($1, 'player-1', 'Chat City Center', 35, -106, 1000, 1250,
                 'public', ST_SetSRID(ST_MakePoint(-106,35),4326))`,
      [seatFlagId]
    );
    await pool.query(
      `INSERT INTO cities (
         id, world_id, canonical_municipality_id, world_settlement_id, world_settlement_source,
         world_source_settlement_id, name, country_code, founder_player_id,
         founding_request_id, seat_flag_id, hall_lat, hall_lon, hall_geom, founding_annex_radius_m
       ) VALUES ($1, 'global', $2, $2, 'test', $2, 'Chat City', 'US', $3, $4,
                 $5, 35, -106, ST_SetSRID(ST_MakePoint(-106,35),4326), 750)`,
      [cityId, `settlement-${cityId}`, "player-1", `found-${cityId}`, seatFlagId]
    );
    await addCityMember(pool, cityId, "player-1");
    const key = `city:${cityId}` as const;
    const chat = service();
    expect((await chat.listChannels("player-0")).some((channel) => channel.key === key)).toBe(false);
    expect((await chat.listChannels("player-1")).some((channel) => channel.key === key)).toBe(true);
    await chat.send({
      channelKey: key,
      senderPlayerId: "player-1",
      senderDisplayName: "Player 1",
      clientRequestId: requestId(2_000),
      body: "before join"
    });
    await addCityMember(pool, cityId, "player-0");
    expect((await chat.history({ playerId: "player-0", channelKey: key })).messages).toEqual([]);
    await chat.send({
      channelKey: key,
      senderPlayerId: "player-1",
      senderDisplayName: "Player 1",
      clientRequestId: requestId(2_001),
      body: "after join"
    });
    expect((await chat.history({ playerId: "player-0", channelKey: key })).messages)
      .toEqual([expect.objectContaining({ body: "after join" })]);
    await pool.query(
      "UPDATE city_memberships SET left_at = clock_timestamp() WHERE city_id = $1 AND player_id = 'player-0'",
      [cityId]
    );
    await expect(chat.history({ playerId: "player-0", channelKey: key }))
      .rejects.toMatchObject({ code: "CHAT_ACCESS_DENIED" });
    await expect(chat.send({
      channelKey: key,
      senderPlayerId: "player-0",
      senderDisplayName: "Player 0",
      clientRequestId: requestId(2_002),
      body: "after leave"
    })).rejects.toMatchObject({ code: "CHAT_ACCESS_DENIED" });
  });

  it("enforces Kingdom membership and revocation on shared durable chat", async () => {
    const kingdomId = randomUUID();
    await pool.query(
      `INSERT INTO kingdoms (
         id, normalized_name, display_name, founder_player_id,
         leader_player_id, founding_request_id
       ) VALUES ($1, $2, 'Chat Kingdom', 'player-2', 'player-2', $3)`,
      [kingdomId, `chat-${kingdomId.slice(0, 18)}`, `found-${kingdomId}`]
    );
    await pool.query(
      `INSERT INTO kingdom_memberships (
         id, kingdom_id, player_id, role, status, joined_at, perk_qualified_at
       ) VALUES (gen_random_uuid(), $1, 'player-2', 'leader', 'active', now(), now())`,
      [kingdomId]
    );
    const key = `kingdom:${kingdomId}` as const;
    const chat = service();
    expect((await chat.listChannels("player-2")).some((channel) => channel.key === key)).toBe(true);
    await expect(chat.history({ playerId: "player-3", channelKey: key }))
      .rejects.toMatchObject({ code: "CHAT_ACCESS_DENIED" });
    await pool.query(
      `INSERT INTO kingdom_memberships (
         id, kingdom_id, player_id, role, status, joined_at, perk_qualified_at
       ) VALUES (gen_random_uuid(), $1, 'player-3', 'member', 'active', now(), now())`,
      [kingdomId]
    );
    await chat.send({
      channelKey: key,
      senderPlayerId: "player-3",
      senderDisplayName: "Player 3",
      clientRequestId: requestId(2_100),
      body: "kingdom member"
    });
    await pool.query(
      `UPDATE kingdom_memberships
       SET status = 'removed', ended_at = clock_timestamp(), end_reason = 'test removal'
       WHERE kingdom_id = $1 AND player_id = 'player-3'`,
      [kingdomId]
    );
    await expect(chat.history({ playerId: "player-3", channelKey: key }))
      .rejects.toMatchObject({ code: "CHAT_ACCESS_DENIED" });
  });

  it("authorizes Party history by current membership and revokes it immediately", async () => {
    const partyId = `party:${randomUUID()}`;
    await pool.query("BEGIN");
    try {
      await pool.query("SET CONSTRAINTS ALL DEFERRED");
      await pool.query(
        `INSERT INTO parties (
           party_id, leader_player_id, revision, membership_revision
         ) VALUES ($1, 'player-4', 1, 1)`,
        [partyId]
      );
      await pool.query(
        `INSERT INTO party_members (party_id, player_id, slot_index)
         VALUES ($1, 'player-4', 0)`,
        [partyId]
      );
      await pool.query("COMMIT");
    } catch (error) {
      await pool.query("ROLLBACK");
      throw error;
    }
    const key = partyId as `party:${string}`;
    const chat = service();
    expect((await chat.listChannels("player-4")).some((channel) => channel.key === key)).toBe(true);
    await expect(chat.history({ playerId: "player-5", channelKey: key }))
      .rejects.toMatchObject({ code: "CHAT_ACCESS_DENIED" });

    await pool.query(
      `INSERT INTO party_members (party_id, player_id, slot_index)
       VALUES ($1, 'player-5', 1)`,
      [partyId]
    );
    await chat.send({
      channelKey: key,
      senderPlayerId: "player-5",
      senderDisplayName: "Player 5",
      clientRequestId: requestId(2_200),
      body: "party member"
    });
    expect((await chat.history({ playerId: "player-5", channelKey: key })).messages)
      .toEqual([expect.objectContaining({ body: "party member" })]);

    await pool.query(
      "DELETE FROM party_members WHERE party_id = $1 AND player_id = 'player-5'",
      [partyId]
    );
    await expect(chat.history({ playerId: "player-5", channelKey: key }))
      .rejects.toMatchObject({ code: "CHAT_ACCESS_DENIED" });
    await expect(chat.send({
      channelKey: key,
      senderPlayerId: "player-5",
      senderDisplayName: "Player 5",
      clientRequestId: requestId(2_201),
      body: "after leave"
    })).rejects.toMatchObject({ code: "CHAT_ACCESS_DENIED" });
  });

  it("enforces scoped durable mute expiry and revocation", async () => {
    const chat = service();
    const mute = await chat.createMute({
      playerId: "player-0",
      scope: "channel",
      channelKey: "public:trading",
      source: "human_moderator",
      reasonCategory: "test",
      reason: "Temporary test mute",
      actorType: "human_moderator",
      actorId: "moderator",
      idempotencyKey: "live-muted-once",
      durationSeconds: 60
    });
    await expect(chat.send({
      channelKey: "public:trading",
      senderPlayerId: "player-0",
      senderDisplayName: "Player 0",
      clientRequestId: requestId(3_000),
      body: "blocked"
    })).rejects.toMatchObject({ code: "CHAT_MUTED" });
    await expect(chat.send({
      channelKey: "public:general",
      senderPlayerId: "player-0",
      senderDisplayName: "Player 0",
      clientRequestId: requestId(3_001),
      body: "allowed elsewhere"
    })).resolves.toMatchObject({ message: { sequence: 1 } });
    expect(await chat.revokeMute(mute.id, "moderator", "Test complete")).toBe(true);
    await expect(chat.send({
      channelKey: "public:trading",
      senderPlayerId: "player-0",
      senderDisplayName: "Player 0",
      clientRequestId: requestId(3_002),
      body: "allowed again"
    })).resolves.toMatchObject({ message: { sequence: 1 } });
  });

  it("applies one capped severe automated mute, audits it, and reverses it", async () => {
    const message = (await service().send({
      channelKey: "public:general",
      senderPlayerId: "player-1",
      senderDisplayName: "Player 1",
      clientRequestId: requestId(4_000),
      body: "message for moderation"
    })).message;
    const moderation = new PostgresModerationDecisionService(pool, 2, 0.92);
    const decision = {
      decisionId: requestId(4_001),
      messageId: message.id,
      playerId: "player-1",
      categories: ["credible_threat"],
      confidence: 0.99,
      recommendedAction: "temporary_global_mute" as const,
      requestedMuteScope: "global" as const,
      requestedDurationSeconds: 86_400,
      reason: "Severe high-confidence test",
      policyVersion: "public_chat_v1",
      modelVersion: "local-test-v1"
    };
    const [first, replay] = await Promise.all([
      moderation.apply(decision),
      moderation.apply(decision)
    ]);
    expect(first.appliedMuteDurationSeconds).toBe(2);
    expect(replay.decisionId).toBe(first.decisionId);
    const audit = await pool.query<{ decisions: string; mutes: string }>(
      `SELECT
        (SELECT count(*) FROM chat_moderation_decisions WHERE decision_id = $1)::text AS decisions,
        (SELECT count(*) FROM chat_mutes WHERE moderation_decision_id = $1)::text AS mutes`,
      [decision.decisionId]
    );
    expect(audit.rows[0]).toEqual({ decisions: "1", mutes: "1" });
    await expect(moderation.apply({ ...decision, reason: "Conflicting replay" }))
      .rejects.toMatchObject({ code: "DECISION_ID_CONFLICT" });
    expect(moderation.metricsSnapshot()).toEqual({
      automatedMuteActions: 1,
      automatedMuteReversals: 0
    });
    await expect(service().send({
      channelKey: "public:hunting",
      senderPlayerId: "player-1",
      senderDisplayName: "Player 1",
      clientRequestId: requestId(4_002),
      body: "muted globally"
    })).rejects.toMatchObject({ code: "CHAT_MUTED" });
    await expect(moderation.reverse(decision.decisionId, "reviewer", "Reversed test"))
      .resolves.toMatchObject({ processingStatus: "reversed" });
    expect(moderation.metricsSnapshot().automatedMuteReversals).toBe(1);
  });

  it("makes moderation-decision mute creation idempotent and rejects semantic conflicts", async () => {
    const chat = service();
    const message = (await chat.send({
      channelKey: "public:general",
      senderPlayerId: "player-2",
      senderDisplayName: "Player 2",
      clientRequestId: requestId(4_100),
      body: "audit anchor"
    })).message;
    const decisionId = requestId(4_101);
    await new PostgresModerationDecisionService(pool, 2).apply({
      decisionId,
      messageId: message.id,
      playerId: "player-2",
      categories: [],
      confidence: 0.1,
      recommendedAction: "no_action",
      reason: "No action audit anchor",
      policyVersion: "public_chat_v1"
    });
    const muteInput = {
      playerId: "player-2",
      scope: "global" as const,
      source: "automated_moderation" as const,
      reasonCategory: "automated_policy",
      reason: "Idempotent temporary mute",
      actorType: "moderation_service" as const,
      actorId: decisionId,
      moderationDecisionId: decisionId,
      durationSeconds: 99
    };
    const [first, replay] = await Promise.all([
      chat.createMute(muteInput),
      chat.createMute(muteInput)
    ]);
    expect(replay.id).toBe(first.id);
    await expect(chat.createMute({ ...muteInput, reason: "Different reason" }))
      .rejects.toMatchObject({ code: "CHAT_IDEMPOTENCY_CONFLICT" });
    const count = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM chat_mutes WHERE moderation_decision_id = $1",
      [decisionId]
    );
    expect(count.rows[0]?.count).toBe("1");
  });

  it("keeps a message hidden until every applied hide decision is reversed", async () => {
    const message = (await service().send({
      channelKey: "public:general",
      senderPlayerId: "player-3",
      senderDisplayName: "Player 3",
      clientRequestId: requestId(4_200),
      body: "hide decision target"
    })).message;
    const moderation = new PostgresModerationDecisionService(pool, 2, 0.92);
    const hideDecision = (value: number) => ({
      decisionId: requestId(value),
      messageId: message.id,
      playerId: "player-3",
      categories: ["credible_threat"],
      confidence: 0.99,
      recommendedAction: "hide_message" as const,
      reason: `Hide decision ${value}`,
      policyVersion: "public_chat_v1"
    });
    const first = hideDecision(4_201);
    const second = hideDecision(4_202);
    await moderation.apply(first);
    await moderation.apply(second);
    await moderation.reverse(first.decisionId, "reviewer", "First reversal");
    expect((await pool.query<{ message_status: string }>(
      "SELECT message_status FROM chat_messages WHERE id = $1",
      [message.id]
    )).rows[0]?.message_status).toBe("hidden");
    await moderation.reverse(second.decisionId, "reviewer", "Second reversal");
    expect((await pool.query<{ message_status: string }>(
      "SELECT message_status FROM chat_messages WHERE id = $1",
      [message.id]
    )).rows[0]?.message_status).toBe("visible");
  });

  it("delivers full messages only to the active room, previews all rooms, and cleans subscribers", async () => {
    const registry = new ConnectionRegistry();
    const firstSocket = new RecordingSocket();
    const secondSocket = new RecordingSocket();
    const firstConnection = registry.add({
      playerId: "player-0",
      username: "Player 0",
      regionCode: "NM",
      zoneId: "world:NM",
      socket: firstSocket
    });
    const secondConnection = registry.add({
      playerId: "player-1",
      username: "Player 1",
      regionCode: "NM",
      zoneId: "world:NM",
      socket: secondSocket
    });
    const realtime = new ChatRealtimeCoordinator(service(), registry);
    await realtime.connect(firstConnection, "player-0");
    await realtime.connect(secondConnection, "player-1");
    await realtime.select(firstConnection, "player-0", "public:general");
    await realtime.select(secondConnection, "player-1", "public:general");
    await realtime.send(firstConnection, "player-0", "Player 0", {
      requestId: requestId(5_000),
      channelKey: "public:general",
      body: "live general"
    });
    expect(firstSocket.messagesOfType("CHAT_MESSAGE")).toHaveLength(1);
    expect(secondSocket.messagesOfType("CHAT_MESSAGE")).toHaveLength(1);

    await realtime.select(secondConnection, "player-1", "public:trading");
    firstSocket.clear();
    secondSocket.clear();
    await realtime.send(firstConnection, "player-0", "Player 0", {
      requestId: requestId(5_001),
      channelKey: "public:general",
      body: "preview only for trading viewer"
    });
    expect(firstSocket.messagesOfType("CHAT_MESSAGE")).toHaveLength(1);
    expect(secondSocket.messagesOfType("CHAT_MESSAGE")).toHaveLength(0);
    expect(secondSocket.messagesOfType("CHAT_PREVIEW_UPDATE")).toHaveLength(1);
    realtime.disconnect(secondConnection);
    expect(realtime.subscriptions.metrics()).toMatchObject({
      connections: 1,
      activeSubscriptions: 1,
      previewSubscriptions: 3
    });
  });

  it("runs two authenticated WebSocket players through live send, room isolation, and reconnect catch-up", async () => {
    const app = Fastify();
    const config = loadConfig({ NODE_ENV: "test" });
    const logger = createLogger("test");
    const registry = new ConnectionRegistry();
    const realtime = new ChatRealtimeCoordinator(service(), registry);
    const records = new Map([
      ["player-0", playerRecord("player-0", "Player 0")],
      ["player-1", playerRecord("player-1", "Player 1")]
    ]);
    const playerService = {
      loadPlayer: vi.fn(async (playerId: string) => records.get(playerId) ?? null),
      markOnline: vi.fn(async () => undefined),
      persistPlayerSnapshot: vi.fn(async () => undefined),
      markOffline: vi.fn(async () => undefined)
    } as unknown as PlayerService;
    const authService = {
      sessionCookieName: "aa_session_dev",
      assertOrigin: vi.fn(),
      authenticateSession: vi.fn(async (token: string | null) => {
        const suffix = token === "session-a" ? "0" : token === "session-b" ? "1" : null;
        return suffix === null ? null : authSession(suffix);
      }),
      requireGameplayReady: vi.fn(),
      recordConnectionEvent: vi.fn(async () => undefined),
      developerCapabilities: vi.fn(() => [])
    } as unknown as AuthService;
    await app.register(cookie);
    installAuthGuard(app, config, authService);
    await registerRealtime({
        infrastructure: {
            app: app,
            registry: registry,
            logger: logger,
            config: config
        },
        authority: {
            gameState: new GameState(config, logger),
            flagService: { listFlags: vi.fn(async () => []) } as unknown as FlagService,
            playerService: playerService,
            auth: authService,
        },
        capabilities: {
            ...worldBootstrapLocationFixtures(),
            chats: realtime,
            combat: new CombatEngine({ tickRateHz: 20 })
        }
    });
    await app.ready();
    const first = await app.injectWS("/ws", {
      headers: { origin: config.CLIENT_ORIGIN, cookie: "aa_session_dev=session-a" }
    });
    const second = await app.injectWS("/ws", {
      headers: { origin: config.CLIENT_ORIGIN, cookie: "aa_session_dev=session-b" }
    });
    const firstMessages: ServerMessage[] = [];
    const secondMessages: ServerMessage[] = [];
    const reconnectedMessages: ServerMessage[] = [];
    let reconnected: Awaited<ReturnType<typeof app.injectWS>> | null = null;
    type ChannelsSnapshot = Extract<ServerMessage, { type: "CHAT_CHANNELS_SNAPSHOT" }>;
    let resolveFirstSnapshot!: (snapshot: ChannelsSnapshot) => void;
    let resolveSecondSnapshot!: (snapshot: ChannelsSnapshot) => void;
    const firstSnapshotPromise = new Promise<ChannelsSnapshot>((resolve) => {
      resolveFirstSnapshot = resolve;
    });
    const secondSnapshotPromise = new Promise<ChannelsSnapshot>((resolve) => {
      resolveSecondSnapshot = resolve;
    });
    first.on("message", (data) => {
      const message = JSON.parse(data.toString()) as ServerMessage;
      firstMessages.push(message);
      if (message.type === "CHAT_CHANNELS_SNAPSHOT") resolveFirstSnapshot(message);
    });
    second.on("message", (data) => {
      const message = JSON.parse(data.toString()) as ServerMessage;
      secondMessages.push(message);
      if (message.type === "CHAT_CHANNELS_SNAPSHOT") resolveSecondSnapshot(message);
    });
    try {
      first.send(JSON.stringify({ type: "HELLO" }));
      second.send(JSON.stringify({ type: "HELLO" }));
      const [firstSnapshot, secondSnapshot] = await Promise.all([
        firstSnapshotPromise,
        secondSnapshotPromise
      ]);
      expect(firstSnapshot.channels.map(({ key }) => key)).toEqual([
        "public:general",
        "public:trading",
        "public:hunting",
        CHAT_LOCAL_CHANNEL_KEY
      ]);
      expect(secondSnapshot.channels.map(({ key }) => key)).toEqual([
        "public:general",
        "public:trading",
        "public:hunting",
        CHAT_LOCAL_CHANNEL_KEY
      ]);
      first.send(JSON.stringify({
        type: "CHAT_SELECT_CHANNEL",
        requestId: "select-a",
        channelKey: "public:general"
      }));
      second.send(JSON.stringify({
        type: "CHAT_SELECT_CHANNEL",
        requestId: "select-b",
        channelKey: "public:trading"
      }));
      await vi.waitFor(() => {
        expect(firstMessages.some(({ type }) => type === "CHAT_CHANNEL_SELECTED")).toBe(true);
        expect(secondMessages.some((message) =>
          message.type === "CHAT_CHANNEL_SELECTED" && message.channelKey === "public:trading"
        )).toBe(true);
      });
      first.send(JSON.stringify({
        type: "CHAT_SEND",
        requestId: requestId(6_000),
        channelKey: "public:general",
        body: "authenticated live message"
      }));
      await vi.waitFor(() => {
        expect(firstMessages.some(({ type }) => type === "CHAT_SEND_RESULT")).toBe(true);
        expect(secondMessages.some(({ type }) => type === "CHAT_PREVIEW_UPDATE")).toBe(true);
      });
      expect(secondMessages.some(({ type }) => type === "CHAT_MESSAGE")).toBe(false);
      const firstGeneralMessage = firstMessages.find((message) =>
        message.type === "CHAT_SEND_RESULT" && message.requestId === requestId(6_000)
      );
      expect(firstGeneralMessage?.type).toBe("CHAT_SEND_RESULT");

      second.send(JSON.stringify({
        type: "CHAT_SEND",
        requestId: requestId(6_001),
        channelKey: "public:trading",
        body: "isolated trading message"
      }));
      await vi.waitFor(() => {
        expect(secondMessages.some((message) =>
          message.type === "CHAT_SEND_RESULT" && message.requestId === requestId(6_001)
        )).toBe(true);
        expect(firstMessages.some((message) =>
          message.type === "CHAT_PREVIEW_UPDATE" && message.preview.channelKey === "public:trading"
        )).toBe(true);
      });
      expect(firstMessages.some((message) =>
        message.type === "CHAT_MESSAGE" && message.message.channelKey === "public:trading"
      )).toBe(false);

      second.send(JSON.stringify({
        type: "CHAT_SELECT_CHANNEL",
        requestId: "select-hunting-b",
        channelKey: "public:hunting"
      }));
      await vi.waitFor(() => {
        expect(secondMessages.some((message) =>
          message.type === "CHAT_CHANNEL_SELECTED" && message.channelKey === "public:hunting"
        )).toBe(true);
      });
      second.send(JSON.stringify({
        type: "CHAT_SEND",
        requestId: requestId(6_002),
        channelKey: "public:hunting",
        body: "isolated hunting message"
      }));
      await vi.waitFor(() => {
        expect(secondMessages.some((message) =>
          message.type === "CHAT_SEND_RESULT" && message.requestId === requestId(6_002)
        )).toBe(true);
        expect(firstMessages.some((message) =>
          message.type === "CHAT_PREVIEW_UPDATE" && message.preview.channelKey === "public:hunting"
        )).toBe(true);
      });
      expect(firstMessages.some((message) =>
        message.type === "CHAT_MESSAGE" && message.message.channelKey === "public:hunting"
      )).toBe(false);

      second.terminate();
      await vi.waitFor(() => expect(registry.connectionCountForPlayer("player-1")).toBe(0));
      first.send(JSON.stringify({
        type: "CHAT_SEND",
        requestId: requestId(6_003),
        channelKey: "public:general",
        body: "missed while player b was offline"
      }));
      await vi.waitFor(() => {
        expect(firstMessages.some((message) =>
          message.type === "CHAT_SEND_RESULT" && message.requestId === requestId(6_003)
        )).toBe(true);
      });

      reconnected = await app.injectWS("/ws", {
        headers: { origin: config.CLIENT_ORIGIN, cookie: "aa_session_dev=session-b" }
      });
      reconnected.on("message", (data) => {
        reconnectedMessages.push(JSON.parse(data.toString()) as ServerMessage);
      });
      reconnected.send(JSON.stringify({ type: "HELLO" }));
      await vi.waitFor(() => {
        expect(reconnectedMessages.some(({ type }) => type === "CHAT_CHANNELS_SNAPSHOT")).toBe(true);
      });
      const afterSequence = firstGeneralMessage?.type === "CHAT_SEND_RESULT"
        ? firstGeneralMessage.message.sequence
        : 0;
      reconnected.send(JSON.stringify({
        type: "CHAT_SELECT_CHANNEL",
        requestId: "reconnect-b",
        channelKey: "public:general",
        afterSequence
      }));
      await vi.waitFor(() => {
        expect(reconnectedMessages.some((message) =>
          message.type === "CHAT_HISTORY_RESULT" &&
          message.requestId === "reconnect-b" &&
          message.direction === "newer" &&
          message.messages.some(({ body }) => body === "missed while player b was offline")
        )).toBe(true);
      });
    } finally {
      first.terminate();
      second.terminate();
      reconnected?.terminate();
      await app.close();
    }
  });

  it("accepts Trade Buy/Sell listings only in Trade and only when a seller owns the quantity", async () => {
    const chat = service();
    const sell = { kind: "sell", itemId: "stone", quantity: 5, price: 100, currency: "gold" } as const;
    await expect(chat.send({
      channelKey: "public:general",
      senderPlayerId: "player-0",
      senderDisplayName: "Player 0",
      clientRequestId: requestId(900),
      body: "ignored",
      tradeListing: { ...sell, kind: "buy" }
    })).rejects.toMatchObject({ code: "CHAT_LISTING_INVALID" });

    const inventory = new InventoryService(pool);
    const grantStone = (key: string, quantity: number) => inventory.grantItemsForOperation({
      playerId: "player-0",
      operationKey: key,
      source: "chat_listing_test",
      grants: [{ itemId: "stone", variant: null, quantity }]
    });
    await grantStone("chat-listing-stone-1", 3);
    await expect(chat.send({
      channelKey: "public:trading",
      senderPlayerId: "player-0",
      senderDisplayName: "Player 0",
      clientRequestId: requestId(901),
      body: "ignored",
      tradeListing: sell
    })).rejects.toMatchObject({ code: "CHAT_LISTING_INVALID" });
    const rejected = await pool.query<{ count: string }>("SELECT count(*)::text AS count FROM chat_messages");
    expect(rejected.rows[0]?.count).toBe("0");

    await grantStone("chat-listing-stone-2", 2);
    const accepted = await chat.send({
      channelKey: "public:trading",
      senderPlayerId: "player-0",
      senderDisplayName: "Player 0",
      clientRequestId: requestId(902),
      body: "ignored",
      tradeListing: sell
    });
    expect(accepted.message).toMatchObject({
      body: "SELLING Stone ×5 · 100 gold each",
      tradeListing: sell
    });
    const buy = await chat.send({
      channelKey: "public:trading",
      senderPlayerId: "player-1",
      senderDisplayName: "Player 1",
      clientRequestId: requestId(903),
      body: "ignored",
      tradeListing: { kind: "buy", itemId: "stone", quantity: 20, price: 3, currency: "glimmer" }
    });
    expect(buy.message.body).toBe("BUYING Stone ×20 · 3 Glimmer each");
    const history = await chat.history({ playerId: "player-2", channelKey: "public:trading" });
    expect(history.messages.map((message) => message.tradeListing?.kind)).toEqual(["sell", "buy"]);
  });

  it("stores Hunting party cards only in Hunting and closes them only for their poster", async () => {
    const chat = service();
    const card = { kind: "leader", dungeonId: "the_eyrie", partyId: "party:hunting-test" } as const;
    await expect(chat.send({
      channelKey: "public:general",
      senderPlayerId: "player-0",
      senderDisplayName: "Player 0",
      clientRequestId: requestId(950),
      body: "ignored",
      partyListing: card
    })).rejects.toMatchObject({ code: "CHAT_LISTING_INVALID" });
    const posted = await chat.send({
      channelKey: "public:hunting",
      senderPlayerId: "player-0",
      senderDisplayName: "Player 0",
      clientRequestId: requestId(951),
      body: "ignored",
      partyListing: card
    });
    expect(posted.message).toMatchObject({ body: "HAVE The Eyrie · Looking for party", partyListing: card });
    const recent = await chat.recentPartyListings(new Date(Date.now() - 60_000));
    expect(recent.map((entry) => entry.messageId)).toEqual([posted.message.id]);
    expect(await chat.cancelPartyListing("player-1", posted.message.id)).toBe(false);
    expect(await chat.cancelPartyListing("player-0", posted.message.id)).toBe(true);
    expect(await chat.cancelPartyListing("player-0", posted.message.id)).toBe(false);
    const history = await chat.history({ playerId: "player-2", channelKey: "public:hunting" });
    expect(history.messages[0]?.partyListing).toEqual({ ...card, cancelled: true });
  });

  function service(): ChatService {
    return new ChatService(pool, {
      rateLimiter: new BoundedChatRateLimiter(10_000, 60_000),
      automatedMuteMaxDurationSeconds: 2
    });
  }
});

async function createPlayers(pool: pg.Pool, count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await pool.query(
      `INSERT INTO players (
         id, username, region_code, lat, lon, anchor_lat, anchor_lon,
         move_leash_radius_m, geom
       ) VALUES ($1, $2, 'NM', 35.0844, -106.6504, 35.0844, -106.6504, 900,
                 ST_SetSRID(ST_MakePoint(-106.6504, 35.0844), 4326))`,
      [`player-${index}`, `Player ${index}`]
    );
  }
}

async function addCityMember(pool: pg.Pool, cityId: string, playerId: string): Promise<void> {
  await pool.query(
    `WITH house AS (
       INSERT INTO city_structures (
         structure_id, city_id, structure_type, tier, owner_player_id, world_id,
         lat, lon, geom, footprint_geom, footprint_radius_m, state,
         build_operation_key, built_at
       ) VALUES (
         gen_random_uuid(), $1, 'city_house', 1, $2, 'global', 35, -106,
         ST_SetSRID(ST_MakePoint(-106,35),4326),
         ST_Buffer(ST_SetSRID(ST_MakePoint(-106,35),4326)::geography,10)::geometry,
         10, 'active', $3, clock_timestamp()
       ) RETURNING structure_id
     )
     INSERT INTO city_memberships (
       city_id, player_id, world_id, role, house_structure_id, joined_at
     )
     SELECT $1, $2, 'global', 'member', structure_id, clock_timestamp() FROM house`,
    [cityId, playerId, `chat-house-${cityId}-${playerId}`]
  );
}

function requestId(value: number): string {
  return `05000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
}

function playerRecord(playerId: string, username: string): PlayerRecord {
  return {
    playerId,
    username,
    displayColor: "#38bdf8",
    regionCode: "NM",
    position: { lat: 35.0844, lon: -106.6504 },
    anchor: { lat: 35.0844, lon: -106.6504 },
    moveLeashRadiusM: 900,
    movementRevision: 0,
    target: null,
    online: true,
    updatedAt: new Date("2026-07-10T00:00:00.000Z")
  };
}

function authSession(suffix: string) {
  return {
    sessionId: `session-${suffix}`,
    account: {
      id: `account-${suffix}`,
      status: "active" as const,
      trustTier: "new" as const,
      riskScore: 0,
      createdAt: new Date(),
      lastLoginAt: null
    },
    player: {
      id: `player-${suffix}`,
      accountId: `account-${suffix}`,
      displayName: `Player ${suffix}`
    },
    deviceInstallationId: `device-${suffix}`,
    csrfToken: `csrf-${suffix}`
  };
}

class RecordingSocket implements SocketLike {
  readyState = 1;
  bufferedAmount = 0;
  private messages: ServerMessage[] = [];

  send(data: string): void {
    this.messages.push(JSON.parse(data) as ServerMessage);
  }

  close(): void {
    this.readyState = 3;
  }

  messagesOfType<T extends ServerMessage["type"]>(type: T): Array<Extract<ServerMessage, { type: T }>> {
    return this.messages.filter(
      (message): message is Extract<ServerMessage, { type: T }> => message.type === type
    );
  }

  clear(): void {
    this.messages = [];
  }
}
