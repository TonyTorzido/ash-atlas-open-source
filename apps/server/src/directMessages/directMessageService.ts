import { randomUUID } from "node:crypto";
import { enqueueNativePush, type NativePushAudience } from "../notifications/nativePushOutbox.js";

import type pg from "pg";

import type {
  DirectConversationPage,
  DirectMessage,
  DirectMessageConversationSummary,
  DirectMessageEvent,
  DirectMessageEventPage,
  DirectMessageHistoryPage,
  DirectMessagePreferences,
  DirectMessageSendInput,
  DirectMessageSendResult
} from "./types.js";
import { DirectMessageError } from "./types.js";
import {
  assertDirectMessageUuid,
  DIRECT_MESSAGE_MAX_CHARACTERS,
  normalizeDirectMessageBody
} from "./validation.js";
import { filterChatBody } from "../chat/contentPolicy.js";

type StoredDirectMessageEventType =
  | "conversation_opened"
  | "message"
  | "delivered"
  | "read"
  | "conversation_muted"
  | "preferences_updated";

type Queryable = Pick<pg.Pool | pg.PoolClient, "query">;

type ConversationRow = {
  conversation_id: string;
  other_player_id: string;
  other_display_name: string;
  other_online: boolean;
  last_active_at: Date | string;
  latest_sequence: string | number;
  unread_count: string | number;
  last_read_sequence: string | number;
  last_delivered_sequence: string | number;
  muted: boolean;
  can_send: boolean;
  message_id: string | null;
  message_sequence: string | number | null;
  sender_player_id: string | null;
  sender_display_name: string | null;
  body: string | null;
  client_request_id: string | null;
  message_created_at: Date | string | null;
  message_recipient_read_sequence: string | number | null;
  message_recipient_delivered_sequence: string | number | null;
  message_recipient_read_at: Date | string | null;
  message_recipient_delivered_at: Date | string | null;
};

type MessageRow = {
  id: string;
  conversation_id: string;
  sequence_number: string | number;
  sender_player_id: string;
  sender_display_name: string;
  body: string;
  client_request_id: string;
  created_at: Date | string;
  recipient_read_sequence: string | number;
  recipient_delivered_sequence: string | number;
  recipient_read_at: Date | string | null;
  recipient_delivered_at: Date | string | null;
};

type ReplayRow = MessageRow & {
  recipient_player_id: string | null;
};

type EventRow = ConversationRow & {
  event_id: string | number;
  event_type: StoredDirectMessageEventType;
  conversation_id: string | null;
  actor_player_id: string | null;
  position_sequence: string | number | null;
  created_at: Date | string;
  event_message_id: string | null;
  event_message_sequence: string | number | null;
  event_message_sender_id: string | null;
  event_message_sender_name: string | null;
  event_message_body: string | null;
  event_message_client_id: string | null;
  event_message_created_at: Date | string | null;
  recipient_read_sequence: string | number | null;
  recipient_delivered_sequence: string | number | null;
  recipient_read_at: Date | string | null;
  recipient_delivered_at: Date | string | null;
  preference_sounds_enabled: boolean | null;
  preference_suppress_banners_in_combat: boolean | null;
};

export type DirectMessageServiceOptions = {
  pushEnqueueEnabled?: boolean;
  pushAudience?: NativePushAudience;
  messageMaxCharacters?: number;
  conversationPageSize?: number;
  historyPageSize?: number;
  eventPageSize?: number;
  rateWindowMs?: number;
  rateMaximum?: number;
  /** Conservative local presence adapter; omit to fall back to persisted presence. */
  isPlayerOnline?: (playerId: string) => boolean;
  requireCurrentTermsAcceptance?: (playerId: string) => Promise<boolean>;
};

export type ListDirectConversationsOptions = {
  search?: string;
  limit?: number;
  cursor?: string | null;
};

export type DirectMessageHistoryOptions = {
  beforeSequence?: string | null;
  limit?: number;
};

/**
 * PostgreSQL authority for one-to-one messages. The class intentionally has no
 * socket knowledge: WebSocket handlers can acknowledge/push its returned event
 * records without moving correctness into process-local state.
 */
export class DirectMessageService {
  private readonly pushEnqueueEnabled: boolean;
  private readonly pushAudience: NativePushAudience | undefined;
  readonly messageMaxCharacters: number;
  readonly conversationPageSize: number;
  readonly historyPageSize: number;
  readonly eventPageSize: number;
  readonly rateWindowMs: number;
  readonly rateMaximum: number;
  private readonly isPlayerOnline: ((playerId: string) => boolean) | undefined;
  private readonly requireCurrentTermsAcceptance:
    ((playerId: string) => Promise<boolean>) | undefined;

  constructor(private readonly pool: pg.Pool, options: DirectMessageServiceOptions = {}) {
    this.pushEnqueueEnabled = options.pushEnqueueEnabled ?? false;
    this.pushAudience = options.pushAudience;
    this.isPlayerOnline = options.isPlayerOnline;
    this.requireCurrentTermsAcceptance = options.requireCurrentTermsAcceptance;
    this.messageMaxCharacters = boundedPositive(
      options.messageMaxCharacters,
      DIRECT_MESSAGE_MAX_CHARACTERS,
      DIRECT_MESSAGE_MAX_CHARACTERS,
      "Direct-message maximum length"
    );
    this.conversationPageSize = boundedPositive(options.conversationPageSize, 25, 25, "Conversation page size");
    this.historyPageSize = boundedPositive(options.historyPageSize, 50, 50, "History page size");
    this.eventPageSize = boundedPositive(options.eventPageSize, 100, 100, "Event page size");
    this.rateWindowMs = boundedPositive(options.rateWindowMs, 10_000, 60_000, "Rate window");
    if (this.rateWindowMs % 1_000 !== 0) throw new Error("Rate window must use whole seconds");
    this.rateMaximum = boundedPositive(options.rateMaximum, 8, 100, "Rate maximum");
  }

  async openConversation(playerId: string, otherPlayerId: string): Promise<DirectMessageConversationSummary> {
    assertPlayers(playerId, otherPlayerId);
    const [low, high] = canonicalPair(playerId, otherPlayerId);
    const client = await this.pool.connect();
    let conversationId: string | null = null;
    try {
      await client.query("BEGIN");
      await lockPlayerPair(client, low, high);
      await requirePlayers(client, low, high);
      const ensured = await ensureConversation(client, low, high);
      conversationId = ensured.conversationId;
      if (ensured.created) {
        await client.query(
          `INSERT INTO direct_message_events
             (player_id,event_type,conversation_id,actor_player_id)
           VALUES ($1,'conversation_opened',$3,$1),($2,'conversation_opened',$3,$1)`,
          [low, high, conversationId]
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await rollbackQuietly(client);
      throw mapDatabaseError(error);
    } finally {
      client.release();
    }
    if (!conversationId) throw new Error("Direct conversation creation did not return an id");
    return this.getConversation(playerId, conversationId);
  }

  async getConversation(playerId: string, conversationId: string): Promise<DirectMessageConversationSummary> {
    assertAuthenticated(playerId);
    assertDirectMessageUuid(conversationId, "Conversation id");
    const result = await this.pool.query<ConversationRow>(
      `${CONVERSATION_SELECT}
       WHERE me.player_id = $1 AND conversation.id = $2`,
      [playerId, conversationId]
    );
    const row = result.rows[0];
    if (!row) throw new DirectMessageError("conversation_unavailable", "Conversation is unavailable.");
    return conversationFromRow(row, this.isPlayerOnline);
  }

  async listConversations(
    playerId: string,
    options: ListDirectConversationsOptions = {}
  ): Promise<DirectConversationPage> {
    assertAuthenticated(playerId);
    const search = normalizeSearch(options.search ?? "");
    const limit = requestedLimit(options.limit, this.conversationPageSize, 25);
    const cursor = decodeListCursor(options.cursor ?? null);
    const result = await this.pool.query<ConversationRow>(
      `${CONVERSATION_SELECT}
       WHERE me.player_id = $1
         AND ($2::text = '' OR other_player.username ILIKE '%' || $2 || '%')
         AND ($3::timestamptz IS NULL
           OR (me.last_active_at, conversation.id) < ($3::timestamptz, $4::uuid))
       ORDER BY me.last_active_at DESC, conversation.id DESC
       LIMIT $5`,
      [
        playerId,
        search,
        cursor?.lastActivityAt ?? null,
        cursor?.conversationId ?? null,
        limit + 1
      ]
    );
    const conversations = result.rows.slice(0, limit).map((row) =>
      conversationFromRow(row, this.isPlayerOnline)
    );
    const last = result.rows.length > limit ? result.rows[limit - 1] : undefined;
    return {
      conversations,
      nextCursor: last
        ? encodeListCursor(iso(last.last_active_at), last.conversation_id)
        : null
    };
  }

  async history(
    playerId: string,
    conversationId: string,
    options: DirectMessageHistoryOptions = {}
  ): Promise<DirectMessageHistoryPage> {
    assertAuthenticated(playerId);
    assertDirectMessageUuid(conversationId, "Conversation id");
    const limit = requestedLimit(options.limit, this.historyPageSize, 50);
    const before = optionalSequence(options.beforeSequence, "History cursor");
    const membership = await this.pool.query<{
      channel_id: string;
      latest_sequence: string | number;
      my_read: string | number;
      my_delivered: string | number;
      other_read: string | number;
      other_delivered: string | number;
      my_read_at: Date | string | null;
      my_delivered_at: Date | string | null;
      other_read_at: Date | string | null;
      other_delivered_at: Date | string | null;
    }>(
      `SELECT conversation.channel_id, conversation.latest_sequence,
              me.last_read_sequence AS my_read,
              me.last_delivered_sequence AS my_delivered,
              other.last_read_sequence AS other_read,
              other.last_delivered_sequence AS other_delivered,
              me.last_read_at AS my_read_at,me.last_delivered_at AS my_delivered_at,
              other.last_read_at AS other_read_at,
              other.last_delivered_at AS other_delivered_at
       FROM direct_conversations conversation
       JOIN direct_conversation_participants me
         ON me.conversation_id = conversation.id AND me.player_id = $1
       JOIN direct_conversation_participants other
         ON other.conversation_id = conversation.id AND other.player_id <> $1
       WHERE conversation.id = $2`,
      [playerId, conversationId]
    );
    const state = membership.rows[0];
    if (!state) throw new DirectMessageError("conversation_unavailable", "Conversation is unavailable.");
    const rows = await this.pool.query<MessageRow>(
      `SELECT message.id, $2::uuid AS conversation_id, message.sequence_number,
              message.sender_player_id, message.sender_display_name, message.body,
              message.client_request_id, message.created_at,
              CASE WHEN message.sender_player_id = $1 THEN $5::bigint ELSE $3::bigint END
                AS recipient_read_sequence,
              CASE WHEN message.sender_player_id = $1 THEN $6::bigint ELSE $4::bigint END
                AS recipient_delivered_sequence,
              CASE WHEN message.sender_player_id = $1 THEN $10::timestamptz ELSE $11::timestamptz END
                AS recipient_read_at,
              CASE WHEN message.sender_player_id = $1 THEN $12::timestamptz ELSE $13::timestamptz END
                AS recipient_delivered_at
       FROM chat_messages message
       WHERE message.channel_id = $7
         AND message.message_status = 'visible'
         AND ($8::bigint IS NULL OR message.sequence_number < $8)
       ORDER BY message.sequence_number DESC
       LIMIT $9`,
      [
        playerId,
        conversationId,
        state.my_read,
        state.my_delivered,
        state.other_read,
        state.other_delivered,
        state.channel_id,
        before,
        limit + 1,
        state.other_read_at,
        state.my_read_at,
        state.other_delivered_at,
        state.my_delivered_at
      ]
    );
    const selected = rows.rows.slice(0, limit).reverse().map(messageFromRow);
    return {
      conversationId,
      messages: selected,
      hasMore: rows.rows.length > limit,
      beforeSequence: selected[0]?.sequence ?? null,
      latestSequence: decimalString(state.latest_sequence, "conversation sequence")
    };
  }

  async send(input: DirectMessageSendInput): Promise<DirectMessageSendResult> {
    assertPlayers(input.senderPlayerId, input.recipientPlayerId);
    assertDirectMessageUuid(input.clientMessageId);
    const normalizedBody = normalizeDirectMessageBody(input.body, this.messageMaxCharacters);
    const filteredBody = filterChatBody(normalizedBody);
    if (!filteredBody.allowed) {
      throw new DirectMessageError("message_invalid", "Message contains unsupported text.");
    }
    const body = filteredBody.body;
    const earlyReplay = await findReplay(this.pool, input.senderPlayerId, input.clientMessageId);
    if (earlyReplay) return replayResult(earlyReplay, input.recipientPlayerId, body);
    if (
      this.requireCurrentTermsAcceptance &&
      !(await this.requireCurrentTermsAcceptance(input.senderPlayerId))
    ) {
      throw new DirectMessageError(
        "terms_required",
        "Accept the current Community Rules before sending messages."
      );
    }

    const [low, high] = canonicalPair(input.senderPlayerId, input.recipientPlayerId);
    const client = await this.pool.connect();
    let committed: DirectMessage | null = null;
    try {
      await client.query("BEGIN");
      // This is deliberately byte-for-byte the same canonical pair lock used by
      // ProfileSocialService.block, preventing a block/send check-then-write race.
      await lockPlayerPair(client, low, high);
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [`direct-message-send:${input.senderPlayerId}:${input.clientMessageId}`]
      );
      const replay = await findReplay(client, input.senderPlayerId, input.clientMessageId);
      if (replay) {
        const result = replayResult(replay, input.recipientPlayerId, body);
        await client.query("COMMIT");
        return result;
      }
      const players = await requirePlayers(client, low, high);
      const blocked = await client.query<{ blocked: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM player_blocks
           WHERE (blocker_id = $1 AND blocked_id = $2)
              OR (blocker_id = $2 AND blocked_id = $1)
         ) AS blocked`,
        [input.senderPlayerId, input.recipientPlayerId]
      );
      if (blocked.rows[0]?.blocked) {
        throw new DirectMessageError("not_allowed", "You cannot perform that action.");
      }
      await reserveRateWindow(
        client,
        input.senderPlayerId,
        this.rateWindowMs,
        this.rateMaximum
      );
      const conversation = await ensureConversation(client, low, high);
      const sequenceResult = await client.query<{ last_sequence: string | number }>(
        `UPDATE chat_channel_sequences
         SET last_sequence = last_sequence + 1
         WHERE channel_id = $1
         RETURNING last_sequence`,
        [conversation.channelId]
      );
      const sequence = decimalString(sequenceResult.rows[0]?.last_sequence, "message sequence", true);
      const senderDisplayName = players.get(input.senderPlayerId);
      if (!senderDisplayName) throw new DirectMessageError("recipient_unavailable", "That player cannot receive messages.");
      const inserted = await client.query<MessageRow>(
        `INSERT INTO chat_messages (
           id,channel_id,sequence_number,sender_player_id,sender_display_name,
           body,client_request_id,message_status,moderation_status
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,'visible','clear')
         RETURNING id,$8::uuid AS conversation_id,sequence_number,sender_player_id,
                   sender_display_name,body,client_request_id,created_at,
                   0::bigint AS recipient_read_sequence,
                   0::bigint AS recipient_delivered_sequence,
                   NULL::timestamptz AS recipient_read_at,
                   NULL::timestamptz AS recipient_delivered_at`,
        [
          randomUUID(),
          conversation.channelId,
          sequence,
          input.senderPlayerId,
          senderDisplayName,
          body,
          input.clientMessageId,
          conversation.conversationId
        ]
      );
      const messageRow = inserted.rows[0];
      if (!messageRow) throw new Error("Direct message insert returned no row");
      await client.query(
        `UPDATE direct_conversations
         SET latest_sequence = $2, last_activity_at = now()
         WHERE id = $1`,
        [conversation.conversationId, sequence]
      );
      await client.query(
        `UPDATE direct_conversation_participants
         SET last_active_at = now(),
             unread_count = unread_count + CASE WHEN player_id = $3 THEN 1 ELSE 0 END
         WHERE conversation_id = $1 AND player_id IN ($2,$3)`,
        [conversation.conversationId, input.senderPlayerId, input.recipientPlayerId]
      );
      await client.query(
        `INSERT INTO direct_message_events
           (player_id,event_type,conversation_id,message_id,actor_player_id,position_sequence)
         VALUES
           ($1,'message',$3,$4,$1,$5),
           ($2,'message',$3,$4,$1,$5)`,
        [
          input.senderPlayerId,
          input.recipientPlayerId,
          conversation.conversationId,
          messageRow.id,
          sequence
        ]
      );
      committed = messageFromRow(messageRow);
      await enqueueNativePush(client, { enabled: this.pushEnqueueEnabled, audience:this.pushAudience, kind: "direct_message", playerId: input.recipientPlayerId,
        sourceId: messageRow.id, eventKey: `dm:${messageRow.id}`, collapseKey: `dm:${conversation.conversationId}` });
      await client.query("COMMIT");
    } catch (error) {
      await rollbackQuietly(client);
      if (isUniqueViolation(error)) {
        const replay = await findReplay(this.pool, input.senderPlayerId, input.clientMessageId);
        if (replay) return replayResult(replay, input.recipientPlayerId, body);
        throw new DirectMessageError("idempotency_conflict", "That message identifier was already used.");
      }
      throw mapDatabaseError(error);
    } finally {
      client.release();
    }
    if (!committed) throw new Error("Direct message did not commit");
    return { message: committed, replayed: false };
  }

  /** Adapter for the authenticated DM_SEND transport, which addresses an existing conversation. */
  async sendToConversation(input: {
    senderPlayerId: string;
    conversationId: string;
    clientMessageId: string;
    body: string;
  }): Promise<DirectMessageSendResult> {
    assertAuthenticated(input.senderPlayerId);
    assertDirectMessageUuid(input.conversationId, "Conversation id");
    const membership = await this.pool.query<{ recipient_player_id: string }>(
      `SELECT CASE WHEN conversation.player_low_id = $1
                THEN conversation.player_high_id ELSE conversation.player_low_id END
                AS recipient_player_id
       FROM direct_conversations conversation
       JOIN direct_conversation_participants participant
         ON participant.conversation_id = conversation.id AND participant.player_id = $1
       WHERE conversation.id = $2`,
      [input.senderPlayerId, input.conversationId]
    );
    const recipientPlayerId = membership.rows[0]?.recipient_player_id;
    if (!recipientPlayerId) {
      throw new DirectMessageError("conversation_unavailable", "Conversation is unavailable.");
    }
    return this.send({
      senderPlayerId: input.senderPlayerId,
      recipientPlayerId,
      clientMessageId: input.clientMessageId,
      body: input.body
    });
  }

  async markDelivered(playerId: string, conversationId: string, sequence: string): Promise<string> {
    return this.advanceParticipantState(playerId, conversationId, sequence, "delivered");
  }

  async markRead(playerId: string, conversationId: string, sequence: string): Promise<string> {
    return this.advanceParticipantState(playerId, conversationId, sequence, "read");
  }

  async setMuted(playerId: string, conversationId: string, muted: boolean): Promise<boolean> {
    assertAuthenticated(playerId);
    assertDirectMessageUuid(conversationId, "Conversation id");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query(
        `UPDATE direct_conversation_participants SET muted = $3
         WHERE conversation_id = $1 AND player_id = $2 AND muted IS DISTINCT FROM $3
         RETURNING muted`,
        [conversationId, playerId, muted]
      );
      if (result.rowCount === 0) {
        const membership = await client.query(
          `SELECT muted FROM direct_conversation_participants
           WHERE conversation_id = $1 AND player_id = $2`,
          [conversationId, playerId]
        );
        if (membership.rowCount === 0) {
          throw new DirectMessageError("conversation_unavailable", "Conversation is unavailable.");
        }
      } else {
        await client.query(
          `INSERT INTO direct_message_events
             (player_id,event_type,conversation_id,actor_player_id)
           VALUES ($1,'conversation_muted',$2,$1)`,
          [playerId, conversationId]
        );
      }
      await client.query("COMMIT");
      return muted;
    } catch (error) {
      await rollbackQuietly(client);
      throw mapDatabaseError(error);
    } finally {
      client.release();
    }
  }

  async getPreferences(playerId: string): Promise<DirectMessagePreferences> {
    assertAuthenticated(playerId);
    const result = await this.pool.query<{
      sounds_enabled: boolean;
      suppress_banners_in_combat: boolean;
    }>(
      `SELECT sounds_enabled,suppress_banners_in_combat
       FROM player_direct_message_preferences WHERE player_id = $1`,
      [playerId]
    );
    return preferencesFromRow(result.rows[0]);
  }

  async updatePreferences(
    playerId: string,
    update: Partial<DirectMessagePreferences>
  ): Promise<DirectMessagePreferences> {
    assertAuthenticated(playerId);
    if (update.soundsEnabled === undefined && update.suppressBannersDuringCombat === undefined) {
      return this.getPreferences(playerId);
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<{
        sounds_enabled: boolean;
        suppress_banners_in_combat: boolean;
      }>(
        `INSERT INTO player_direct_message_preferences (
           player_id,sounds_enabled,suppress_banners_in_combat
         ) VALUES ($1,COALESCE($2,true),COALESCE($3,false))
         ON CONFLICT (player_id) DO UPDATE SET
           sounds_enabled = COALESCE($2,player_direct_message_preferences.sounds_enabled),
           suppress_banners_in_combat = COALESCE(
             $3,player_direct_message_preferences.suppress_banners_in_combat
           )
         RETURNING sounds_enabled,suppress_banners_in_combat`,
        [
          playerId,
          update.soundsEnabled ?? null,
          update.suppressBannersDuringCombat ?? null
        ]
      );
      await client.query(
        `INSERT INTO direct_message_events (player_id,event_type,actor_player_id)
         VALUES ($1,'preferences_updated',$1)`,
        [playerId]
      );
      await client.query("COMMIT");
      return preferencesFromRow(result.rows[0]);
    } catch (error) {
      await rollbackQuietly(client);
      throw mapDatabaseError(error);
    } finally {
      client.release();
    }
  }

  async syncEvents(
    playerId: string,
    afterCursor?: string,
    requestedPageSize?: number
  ): Promise<DirectMessageEventPage> {
    assertAuthenticated(playerId);
    const cursorState = await this.pool.query<{ last_ack_event_id: string | number }>(
      `SELECT last_ack_event_id FROM direct_message_event_cursors WHERE player_id = $1`,
      [playerId]
    );
    const acknowledgedCursor = decimalString(
      cursorState.rows[0]?.last_ack_event_id ?? 0,
      "acknowledged event cursor"
    );
    const cursor = afterCursor === undefined
      ? acknowledgedCursor
      : decimalString(afterCursor, "Event cursor");
    const limit = requestedLimit(requestedPageSize, this.eventPageSize, 100);
    const result = await this.pool.query<EventRow>(
      `${EVENT_SELECT}
       WHERE event.player_id = $1 AND event.event_id > $2
       ORDER BY event.event_id
       LIMIT $3`,
      [playerId, cursor, limit + 1]
    );
    const events = result.rows.slice(0, limit).map((row) => eventFromRow(row, this.isPlayerOnline));
    return {
      events,
      acknowledgedCursor,
      nextCursor: events.at(-1)?.eventSequence ?? cursor,
      hasMore: result.rows.length > limit
    };
  }

  async acknowledgeEvents(playerId: string, requestedCursor: string): Promise<string> {
    assertAuthenticated(playerId);
    const cursor = decimalString(requestedCursor, "Event cursor");
    const result = await this.pool.query<{ last_ack_event_id: string | number }>(
      `INSERT INTO direct_message_event_cursors (player_id,last_ack_event_id)
       VALUES (
         $1,
         LEAST($2::bigint,COALESCE((
           SELECT max(event_id) FROM direct_message_events WHERE player_id = $1
         ),0))
       )
       ON CONFLICT (player_id) DO UPDATE SET last_ack_event_id = GREATEST(
         direct_message_event_cursors.last_ack_event_id,
         LEAST($2::bigint,COALESCE((
           SELECT max(event_id) FROM direct_message_events WHERE player_id = $1
         ),0))
       )
       RETURNING last_ack_event_id`,
      [playerId, cursor]
    );
    return decimalString(result.rows[0]?.last_ack_event_id, "acknowledged event cursor");
  }

  async cleanupRateWindows(olderThanMs = 86_400_000): Promise<number> {
    const result = await this.pool.query(
      `DELETE FROM direct_message_rate_windows
       WHERE window_started_at < clock_timestamp() - ($1::bigint * interval '1 millisecond')`,
      [boundedPositive(olderThanMs, 86_400_000, 604_800_000, "Rate window retention")]
    );
    return result.rowCount ?? 0;
  }

  private async advanceParticipantState(
    playerId: string,
    conversationId: string,
    requestedSequence: string,
    kind: "delivered" | "read"
  ): Promise<string> {
    assertAuthenticated(playerId);
    assertDirectMessageUuid(conversationId, "Conversation id");
    const sequence = decimalString(requestedSequence, "Message sequence", true);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const state = await client.query<{
        channel_id: string;
        latest_sequence: string | number;
        last_read_sequence: string | number;
        last_delivered_sequence: string | number;
        other_player_id: string;
      }>(
        `SELECT conversation.channel_id,conversation.latest_sequence,
                participant.last_read_sequence,participant.last_delivered_sequence,
                CASE WHEN conversation.player_low_id = $2
                  THEN conversation.player_high_id ELSE conversation.player_low_id END AS other_player_id
         FROM direct_conversations conversation
         JOIN direct_conversation_participants participant
           ON participant.conversation_id = conversation.id AND participant.player_id = $2
         WHERE conversation.id = $1
         FOR UPDATE OF participant`,
        [conversationId, playerId]
      );
      const current = state.rows[0];
      if (!current) throw new DirectMessageError("conversation_unavailable", "Conversation is unavailable.");
      const latest = decimalString(current.latest_sequence, "conversation sequence");
      const target = BigInt(sequence) < BigInt(latest) ? sequence : latest;
      const existing = decimalString(
        kind === "read" ? current.last_read_sequence : current.last_delivered_sequence,
        `${kind} sequence`
      );
      if (BigInt(target) > BigInt(existing)) {
        if (kind === "read") {
          await client.query(
            `UPDATE direct_conversation_participants participant
             SET last_read_sequence = GREATEST(last_read_sequence,$3),
                 last_delivered_sequence = GREATEST(last_delivered_sequence,$3),
                 last_read_at = now(),
                 last_delivered_at = now(),
                 unread_count = (
                   SELECT count(*)::integer FROM chat_messages message
                   WHERE message.channel_id = $4
                     AND message.sender_player_id <> $2
                     AND message.sequence_number > $3
                     AND message.message_status = 'visible'
                 )
             WHERE participant.conversation_id = $1 AND participant.player_id = $2`,
            [conversationId, playerId, target, current.channel_id]
          );
        } else {
          await client.query(
            `UPDATE direct_conversation_participants
             SET last_delivered_sequence = GREATEST(last_delivered_sequence,$3),
                 last_delivered_at = now()
             WHERE conversation_id = $1 AND player_id = $2`,
            [conversationId, playerId, target]
          );
        }
        await client.query(
          `INSERT INTO direct_message_events
             (player_id,event_type,conversation_id,actor_player_id,position_sequence)
           VALUES ($1,$3,$4,$1,$5),($2,$3,$4,$1,$5)`,
          [playerId, current.other_player_id, kind, conversationId, target]
        );
      }
      await client.query("COMMIT");
      return BigInt(existing) > BigInt(target) ? existing : target;
    } catch (error) {
      await rollbackQuietly(client);
      throw mapDatabaseError(error);
    } finally {
      client.release();
    }
  }
}

const CONVERSATION_SELECT = `
  SELECT conversation.id AS conversation_id,
         other.player_id AS other_player_id,
         other_player.username AS other_display_name,
         other_player.online AS other_online,
         me.last_active_at,conversation.latest_sequence,
         me.unread_count,me.last_read_sequence,me.last_delivered_sequence,me.muted,
         NOT EXISTS (
           SELECT 1 FROM player_blocks block
           WHERE (block.blocker_id = me.player_id AND block.blocked_id = other.player_id)
              OR (block.blocker_id = other.player_id AND block.blocked_id = me.player_id)
         ) AS can_send,
         latest.id AS message_id,latest.sequence_number AS message_sequence,
         latest.sender_player_id,latest.sender_display_name,latest.body,
         latest.client_request_id,latest.created_at AS message_created_at,
         CASE WHEN latest.sender_player_id = me.player_id
           THEN other.last_read_sequence ELSE me.last_read_sequence END
           AS message_recipient_read_sequence,
         CASE WHEN latest.sender_player_id = me.player_id
           THEN other.last_delivered_sequence ELSE me.last_delivered_sequence END
           AS message_recipient_delivered_sequence,
         CASE WHEN latest.sender_player_id = me.player_id
           THEN other.last_read_at ELSE me.last_read_at END
           AS message_recipient_read_at,
         CASE WHEN latest.sender_player_id = me.player_id
           THEN other.last_delivered_at ELSE me.last_delivered_at END
           AS message_recipient_delivered_at
  FROM direct_conversation_participants me
  JOIN direct_conversations conversation ON conversation.id = me.conversation_id
  JOIN direct_conversation_participants other
    ON other.conversation_id = conversation.id AND other.player_id <> me.player_id
  JOIN players other_player ON other_player.id = other.player_id
  LEFT JOIN chat_messages latest
    ON latest.channel_id = conversation.channel_id
   AND latest.sequence_number = conversation.latest_sequence`;

const EVENT_SELECT = `
  SELECT event.event_id,event.event_type,event.conversation_id,event.actor_player_id,
         event.position_sequence,event.created_at,
         message.id AS event_message_id,
         message.sequence_number AS event_message_sequence,
         message.sender_player_id AS event_message_sender_id,
         message.sender_display_name AS event_message_sender_name,
         message.body AS event_message_body,
         message.client_request_id AS event_message_client_id,
         message.created_at AS event_message_created_at,
         CASE WHEN message.sender_player_id = event.player_id
           THEN other.last_read_sequence ELSE me.last_read_sequence END AS recipient_read_sequence,
         CASE WHEN message.sender_player_id = event.player_id
           THEN other.last_delivered_sequence ELSE me.last_delivered_sequence END
           AS recipient_delivered_sequence,
         CASE WHEN message.sender_player_id = event.player_id
           THEN other.last_read_at ELSE me.last_read_at END AS recipient_read_at,
         CASE WHEN message.sender_player_id = event.player_id
           THEN other.last_delivered_at ELSE me.last_delivered_at END AS recipient_delivered_at,
         other.player_id AS other_player_id,other_player.username AS other_display_name,
         COALESCE(other_player.online,false) AS other_online,
         me.last_active_at,conversation.latest_sequence,me.unread_count,
         me.last_read_sequence,me.last_delivered_sequence,me.muted,
         NOT EXISTS (
           SELECT 1 FROM player_blocks block
           WHERE (block.blocker_id = me.player_id AND block.blocked_id = other.player_id)
              OR (block.blocker_id = other.player_id AND block.blocked_id = me.player_id)
         ) AS can_send,
         latest.id AS message_id,latest.sequence_number AS message_sequence,
         latest.sender_player_id,latest.sender_display_name,
         latest.body,latest.client_request_id,
         latest.created_at AS message_created_at,
         CASE WHEN latest.sender_player_id = event.player_id
           THEN other.last_read_sequence ELSE me.last_read_sequence END
           AS message_recipient_read_sequence,
         CASE WHEN latest.sender_player_id = event.player_id
           THEN other.last_delivered_sequence ELSE me.last_delivered_sequence END
           AS message_recipient_delivered_sequence,
         CASE WHEN latest.sender_player_id = event.player_id
           THEN other.last_read_at ELSE me.last_read_at END AS message_recipient_read_at,
         CASE WHEN latest.sender_player_id = event.player_id
           THEN other.last_delivered_at ELSE me.last_delivered_at END
           AS message_recipient_delivered_at,
         preferences.sounds_enabled AS preference_sounds_enabled,
         preferences.suppress_banners_in_combat AS preference_suppress_banners_in_combat
  FROM direct_message_events event
  LEFT JOIN chat_messages message ON message.id = event.message_id
  LEFT JOIN direct_conversations conversation ON conversation.id = event.conversation_id
  LEFT JOIN direct_conversation_participants me
    ON me.conversation_id = event.conversation_id AND me.player_id = event.player_id
  LEFT JOIN direct_conversation_participants other
    ON other.conversation_id = event.conversation_id AND other.player_id <> event.player_id
  LEFT JOIN players other_player ON other_player.id = other.player_id
  LEFT JOIN chat_messages latest
    ON latest.channel_id = conversation.channel_id
   AND latest.sequence_number = conversation.latest_sequence
  LEFT JOIN player_direct_message_preferences preferences
    ON preferences.player_id = event.player_id`;

async function ensureConversation(
  client: pg.PoolClient,
  playerLowId: string,
  playerHighId: string
): Promise<{ conversationId: string; channelId: string; created: boolean }> {
  const existing = await client.query<{ id: string; channel_id: string }>(
    `SELECT id,channel_id FROM direct_conversations
     WHERE player_low_id = $1 AND player_high_id = $2`,
    [playerLowId, playerHighId]
  );
  const found = existing.rows[0];
  if (found) return { conversationId: found.id, channelId: found.channel_id, created: false };
  const id = randomUUID();
  await client.query(
    `INSERT INTO chat_channels (
       id,channel_key,channel_type,display_name,visibility_policy,send_access_policy,
       history_retention_policy,rate_limit_policy,moderation_policy,active
     ) VALUES (
       $1,$2,'direct','Private message','direct_participants_v1','direct_participants_v1',
       'durable_direct_v1','direct_standard_v1','plain_text_direct_v1',true
     )`,
    [id, `direct:${id}`]
  );
  await client.query(
    "INSERT INTO chat_channel_sequences (channel_id,last_sequence) VALUES ($1,0)",
    [id]
  );
  await client.query(
    `INSERT INTO direct_conversations (id,channel_id,player_low_id,player_high_id)
     VALUES ($1,$1,$2,$3)`,
    [id, playerLowId, playerHighId]
  );
  await client.query(
    `INSERT INTO direct_conversation_participants (conversation_id,player_id)
     VALUES ($1,$2),($1,$3)`,
    [id, playerLowId, playerHighId]
  );
  return { conversationId: id, channelId: id, created: true };
}

async function requirePlayers(
  queryable: Queryable,
  low: string,
  high: string
): Promise<Map<string, string>> {
  const result = await queryable.query<{ id: string; username: string }>(
    "SELECT id,username FROM players WHERE id IN ($1,$2) ORDER BY id",
    [low, high]
  );
  if (result.rows.length !== 2) {
    throw new DirectMessageError("recipient_unavailable", "That player cannot receive messages.");
  }
  return new Map(result.rows.map((row) => [row.id, row.username]));
}

async function findReplay(
  queryable: Queryable,
  senderPlayerId: string,
  clientMessageId: string
): Promise<ReplayRow | null> {
  const result = await queryable.query<ReplayRow>(
    `SELECT message.id,conversation.id AS conversation_id,message.sequence_number,
            message.sender_player_id,message.sender_display_name,message.body,
            message.client_request_id,message.created_at,
            CASE WHEN conversation.player_low_id = message.sender_player_id
              THEN conversation.player_high_id ELSE conversation.player_low_id END AS recipient_player_id,
            COALESCE(recipient.last_read_sequence,0) AS recipient_read_sequence,
            COALESCE(recipient.last_delivered_sequence,0) AS recipient_delivered_sequence,
            recipient.last_read_at AS recipient_read_at,
            recipient.last_delivered_at AS recipient_delivered_at
     FROM chat_messages message
     LEFT JOIN direct_conversations conversation ON conversation.channel_id = message.channel_id
     LEFT JOIN direct_conversation_participants recipient
       ON recipient.conversation_id = conversation.id
      AND recipient.player_id <> message.sender_player_id
     WHERE message.sender_player_id = $1 AND message.client_request_id = $2`,
    [senderPlayerId, clientMessageId]
  );
  return result.rows[0] ?? null;
}

function replayResult(row: ReplayRow, recipientPlayerId: string, body: string): DirectMessageSendResult {
  if (!row.conversation_id || row.recipient_player_id !== recipientPlayerId || row.body !== body) {
    throw new DirectMessageError(
      "idempotency_conflict",
      "That message identifier was already used."
    );
  }
  return { message: messageFromRow(row), replayed: true };
}

async function reserveRateWindow(
  queryable: Queryable,
  playerId: string,
  windowMs: number,
  maximum: number
): Promise<void> {
  const windowSeconds = windowMs / 1_000;
  const result = await queryable.query(
    `INSERT INTO direct_message_rate_windows (player_id,window_started_at,request_count)
     VALUES (
       $1,
       to_timestamp(floor(extract(epoch FROM clock_timestamp()) / $2) * $2),
       1
     )
     ON CONFLICT (player_id,window_started_at)
     DO UPDATE SET request_count = direct_message_rate_windows.request_count + 1
     WHERE direct_message_rate_windows.request_count < $3
     RETURNING request_count`,
    [playerId, windowSeconds, maximum]
  );
  if (result.rowCount !== 1) {
    throw new DirectMessageError("rate_limited", "Too many messages. Please wait and try again.", windowMs);
  }
}

async function lockPlayerPair(queryable: Queryable, left: string, right: string): Promise<void> {
  await queryable.query(
    `SELECT pg_advisory_xact_lock(
       hashtextextended(LEAST($1, $2) || chr(31) || GREATEST($1, $2), 0)
     )`,
    [left, right]
  );
}

function conversationFromRow(
  row: ConversationRow,
  isPlayerOnline?: (playerId: string) => boolean
): DirectMessageConversationSummary {
  const latestMessage = row.message_id === null ? null : messageFromRow({
    id: row.message_id,
    conversation_id: row.conversation_id,
    sequence_number: row.message_sequence,
    sender_player_id: row.sender_player_id,
    sender_display_name: row.sender_display_name,
    body: row.body,
    client_request_id: row.client_request_id,
    created_at: row.message_created_at,
    recipient_read_sequence: row.message_recipient_read_sequence ?? 0,
    recipient_delivered_sequence: row.message_recipient_delivered_sequence ?? 0,
    recipient_read_at: row.message_recipient_read_at,
    recipient_delivered_at: row.message_recipient_delivered_at
  } as MessageRow);
  return {
    id: row.conversation_id,
    peer: {
      playerId: row.other_player_id,
      displayName: row.other_display_name,
      online: isPlayerOnline?.(row.other_player_id) ?? row.other_online
    },
    canSend: row.can_send,
    latestMessage: latestMessage === null ? null : {
      id: latestMessage.id,
      sequence: latestMessage.sequence,
      senderPlayerId: latestMessage.senderPlayerId,
      body: truncatePreview(latestMessage.body),
      status: latestMessage.status,
      serverCreatedAt: latestMessage.serverCreatedAt
    },
    latestSequence: decimalString(row.latest_sequence, "conversation sequence"),
    lastReadSequence: decimalString(row.last_read_sequence, "read sequence"),
    deliveredThroughSequence: decimalString(row.last_delivered_sequence, "delivered sequence"),
    unreadCount: safeInteger(row.unread_count, "unread count"),
    muted: row.muted,
    updatedAt: iso(row.last_active_at)
  };
}

function messageFromRow(row: MessageRow): DirectMessage {
  const sequence = decimalString(row.sequence_number, "message sequence", true);
  const delivered = decimalString(row.recipient_delivered_sequence, "delivered sequence");
  const read = decimalString(row.recipient_read_sequence, "read sequence");
  const status = deliveryState(sequence, delivered, read);
  return {
    id: row.id,
    conversationId: row.conversation_id,
    sequence,
    senderPlayerId: row.sender_player_id,
    body: row.body,
    clientMessageId: row.client_request_id,
    status,
    serverCreatedAt: iso(row.created_at)
  };
}

function eventFromRow(
  row: EventRow,
  isPlayerOnline?: (playerId: string) => boolean
): DirectMessageEvent {
  const eventSequence = decimalString(row.event_id, "event cursor", true);
  const occurredAt = iso(row.created_at);
  if (row.event_type === "message") {
    if (row.event_message_id === null || row.conversation_id === null) {
      throw new Error("Message event is missing its durable message");
    }
    return {
      kind: "message_created",
      eventSequence,
      occurredAt,
      conversation: conversationFromRow(row, isPlayerOnline),
      message: messageFromRow({
      id: row.event_message_id,
      conversation_id: row.conversation_id!,
      sequence_number: row.event_message_sequence!,
      sender_player_id: row.event_message_sender_id!,
      sender_display_name: row.event_message_sender_name!,
      body: row.event_message_body!,
      client_request_id: row.event_message_client_id!,
      created_at: row.event_message_created_at!,
      recipient_read_sequence: row.recipient_read_sequence ?? 0,
      recipient_delivered_sequence: row.recipient_delivered_sequence ?? 0,
      recipient_read_at: row.recipient_read_at,
      recipient_delivered_at: row.recipient_delivered_at
      })
    };
  }
  if (row.event_type === "delivered") {
    return {
      kind: "message_delivered",
      eventSequence,
      occurredAt,
      conversationId: requireEventConversation(row),
      deliveredThroughSequence: decimalString(row.position_sequence, "delivered sequence", true)
    };
  }
  if (row.event_type === "read") {
    return {
      kind: "message_read",
      eventSequence,
      occurredAt,
      conversationId: requireEventConversation(row),
      readThroughSequence: decimalString(row.position_sequence, "read sequence", true)
    };
  }
  if (row.event_type === "conversation_opened") {
    return {
      kind: "conversation_updated",
      eventSequence,
      occurredAt,
      conversation: conversationFromRow(row, isPlayerOnline)
    };
  }
  if (row.event_type === "conversation_muted") {
    return {
      kind: "mute_updated",
      eventSequence,
      occurredAt,
      conversationId: requireEventConversation(row),
      muted: row.muted
    };
  }
  return {
    kind: "preferences_updated",
    eventSequence,
    occurredAt,
    preferences: {
      soundsEnabled: row.preference_sounds_enabled ?? true,
      suppressBannersDuringCombat: row.preference_suppress_banners_in_combat ?? false
    }
  };
}

function deliveryState(sequence: string, delivered: string, read: string): DirectMessage["status"] {
  if (BigInt(read) >= BigInt(sequence)) return "read";
  if (BigInt(delivered) >= BigInt(sequence)) return "delivered";
  return "sent";
}

function preferencesFromRow(row?: {
  sounds_enabled: boolean;
  suppress_banners_in_combat: boolean;
}): DirectMessagePreferences {
  return {
    soundsEnabled: row?.sounds_enabled ?? true,
    suppressBannersDuringCombat: row?.suppress_banners_in_combat ?? false
  };
}

function canonicalPair(left: string, right: string): [string, string] {
  return left < right ? [left, right] : [right, left];
}

function assertPlayers(playerId: string, otherPlayerId: string): void {
  assertAuthenticated(playerId);
  assertAuthenticated(otherPlayerId);
  if (playerId === otherPlayerId) {
    throw new DirectMessageError("recipient_unavailable", "That player cannot receive messages.");
  }
}

function assertAuthenticated(playerId: string): void {
  if (typeof playerId !== "string" || playerId.length === 0) {
    throw new DirectMessageError("invalid_request", "Private messaging request was invalid.");
  }
}

function normalizeSearch(value: string): string {
  if (typeof value !== "string") throw new DirectMessageError("invalid_request", "Private messaging request was invalid.");
  const normalized = value.normalize("NFC").trim().replace(/\s+/gu, " ");
  if (Array.from(normalized).length > 64 || /\p{Cc}/u.test(normalized)) {
    throw new DirectMessageError("invalid_request", "Private messaging request was invalid.");
  }
  return normalized;
}

function assertIsoDate(value: string): void {
  if (!value || !Number.isFinite(Date.parse(value))) {
    throw new DirectMessageError("invalid_request", "Private messaging request was invalid.");
  }
}

function optionalSequence(value: string | null | undefined, label: string): string | null {
  return value == null ? null : decimalString(value, label, true);
}

function requestedLimit(value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new DirectMessageError("invalid_request", "Private messaging request was invalid.");
  }
  return value;
}

function boundedPositive(value: number | undefined, fallback: number, maximum: number, label: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0 || resolved > maximum) {
    throw new Error(`${label} must be a positive integer no greater than ${maximum}`);
  }
  return resolved;
}

function safeInteger(value: string | number | null | undefined, label: string): number {
  const converted = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(converted) || converted < 0) {
    throw new Error(`Database returned an invalid ${label}`);
  }
  return converted;
}

function decimalString(
  value: string | number | null | undefined,
  label: string,
  positive = false
): string {
  const text = typeof value === "number" && Number.isSafeInteger(value) ? String(value) : value;
  const pattern = positive ? /^[1-9]\d{0,18}$/ : /^(0|[1-9]\d{0,18})$/;
  if (typeof text !== "string" || !pattern.test(text) || BigInt(text) > 9_223_372_036_854_775_807n) {
    throw new DirectMessageError("invalid_request", `Invalid ${label}`);
  }
  return text;
}

function encodeListCursor(lastActivityAt: string, conversationId: string): string {
  return Buffer.from(JSON.stringify({ lastActivityAt, conversationId }), "utf8").toString("base64url");
}

function decodeListCursor(cursor: string | null): {
  lastActivityAt: string;
  conversationId: string;
} | null {
  if (cursor === null) return null;
  try {
    if (!/^[A-Za-z0-9_-]{1,512}$/.test(cursor)) throw new Error("invalid encoding");
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
    if (typeof value !== "object" || value === null) throw new Error("invalid cursor");
    const candidate = value as Record<string, unknown>;
    if (typeof candidate.lastActivityAt !== "string" || typeof candidate.conversationId !== "string") {
      throw new Error("invalid cursor fields");
    }
    assertIsoDate(candidate.lastActivityAt);
    assertDirectMessageUuid(candidate.conversationId, "Conversation cursor id");
    return {
      lastActivityAt: candidate.lastActivityAt,
      conversationId: candidate.conversationId
    };
  } catch {
    throw new DirectMessageError("invalid_request", "Private messaging request was invalid.");
  }
}

function truncatePreview(body: string): string {
  const characters = Array.from(body);
  return characters.length <= 120 ? body : characters.slice(0, 120).join("");
}

function requireEventConversation(row: EventRow): string {
  if (row.conversation_id === null) throw new Error("Conversation event is missing its conversation");
  return row.conversation_id;
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

async function rollbackQuietly(client: pg.PoolClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Preserve the authoritative operation failure.
  }
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error
    && String((error as { code: unknown }).code) === "23505";
}

function mapDatabaseError(error: unknown): Error {
  if (error instanceof DirectMessageError) return error;
  const code = typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : "";
  if (code === "23503") {
    return new DirectMessageError("recipient_unavailable", "That player cannot receive messages.");
  }
  if (code === "23514" || code === "22P02") {
    return new DirectMessageError("invalid_request", "Private messaging request was invalid.");
  }
  return error instanceof Error ? error : new Error("Direct-message operation failed");
}
