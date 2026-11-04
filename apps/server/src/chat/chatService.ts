import {
  CHAT_CATCH_UP_LIMIT,
  CHAT_DEFAULT_PINNED_CATEGORIES,
  CHAT_CHANNEL_KEYS,
  CHAT_HISTORY_PAGE_SIZE,
  CHAT_LOCAL_CHANNEL_KEY,
  CHAT_HUNTING_CHANNEL_KEY,
  CHAT_TRADE_CHANNEL_KEY,
  CHAT_TRANSLATION_TARGET_LANGUAGES,
  chatPartyListingFallbackBody,
  chatTradeListingFallbackBody,
  chatTradeListingItemName,
  normalizeChatCrestId,
  normalizeChatPartyListing,
  normalizeChatTradeListing,
  isChatChannelCategory,
  parseChatChannelKey,
  scopedChatChannelKey,
  type ChatChannel,
  type ChatChannelCategory,
  type ChatChannelKey,
  type ChatMessage,
  type ChatMessageTranslations,
  type ChatMuteSnapshot,
  type ChatPartyListing,
  type ChatReadState,
  type ChatTradeListing,
  type ChatTranslationTargetLanguage
} from "@ash-atlas/shared";
import type pg from "pg";

import {
  BoundedChatRateLimiter,
  BoundedRecentChatCache,
  type ChatRateLimitReservation
} from "./boundedMemory.js";
import {
  CHAT_TRANSLATION_MODEL,
  CHAT_TRANSLATION_PROVIDER,
  CHAT_TRANSLATION_VERSION
} from "./googleCloudTranslation.js";
import { CHAT_SERVER_LIMITS, resolveRatePolicy } from "./policy.js";
import { filterChatBody } from "./contentPolicy.js";
import type {
  ChatChannelsSnapshot,
  ChatHistoryMode,
  ChatHistoryResult,
  ChatMessageDeleteResult,
  ChatModerationEvent,
  ChatSendInput,
  ChatSendResult
} from "./types.js";
import { ChatServiceError } from "./types.js";
import { normalizeChatBody, normalizeChatSenderDisplayName } from "./validation.js";

type Queryable = Pick<pg.Pool | pg.PoolClient, "query">;

type ChannelRow = {
  id: string;
  channel_key: string;
  channel_type: string;
  display_name: string;
  visibility_policy: string;
  send_access_policy: string;
  history_retention_policy: string;
  rate_limit_policy: string;
  moderation_policy: string;
  active: boolean;
  latest_sequence: string | number;
  deletion_revision?: string | number;
  created_at: Date | string;
  updated_at: Date | string;
};

type MessageRow = {
  id: string;
  channel_id: string;
  channel_key: string;
  sequence_number: string | number;
  sender_player_id: string;
  sender_display_name: string;
  equipped_chat_crest_id: string | null | undefined;
  body: string;
  trade_listing?: unknown;
  party_listing?: unknown;
  client_request_id: string;
  message_status: string;
  moderation_status: string;
  edited_at: Date | string | null;
  deleted_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

type DeletionTargetRow = MessageRow & {
  channel_id: string;
  channel_key: string;
  channel_type: string;
  display_name: string;
  visibility_policy: string;
  send_access_policy: string;
  history_retention_policy: string;
  rate_limit_policy: string;
  moderation_policy: string;
  active: boolean;
  latest_sequence: string | number;
  deletion_revision: string | number;
};

type InsertedMessageRow = Omit<MessageRow, "channel_key">;

type MuteRow = {
  id: string;
  scope: "global" | "channel";
  channel_key: string | null;
  reason: string;
  expires_at: Date | string;
};

export type ChatServiceMetrics = {
  acceptedMessages: number;
  replayedMessages: number;
  rejectedMessages: number;
  rateLimitEvents: number;
  moderationQueueOverflows: number;
  databaseInsertLatencyMs: number;
  historyQueries: number;
  historyQueryLatencyMs: number;
  reconnectCatchUps: number;
  boundedSnapshots: number;
};

export type ChatMuteCreateInput = {
  playerId: string;
  scope: "global" | "channel";
  channelKey?: ChatChannelKey;
  source: "system" | "automated_moderation" | "human_moderator";
  reasonCategory: string;
  reason: string;
  actorType: "system" | "moderation_service" | "human_moderator";
  actorId?: string | null;
  actorMetadata?: Record<string, unknown>;
  moderationDecisionId?: string | null;
  idempotencyKey?: string | null;
  durationSeconds: number;
};

export type ChatMuteRecord = {
  id: string;
  playerId: string;
  scope: "global" | "channel";
  channelId: string | null;
  source: ChatMuteCreateInput["source"];
  reason: string;
  expiresAt: string;
  revokedAt: string | null;
};

export type ChatServiceOptions = {
  rateLimiter?: BoundedChatRateLimiter;
  recentCache?: BoundedRecentChatCache;
  moderationDispatcher?: { enqueue(event: ChatModerationEvent): boolean };
  logger?: {
    info(metadata: Record<string, unknown>, message: string): void;
    warn(metadata: Record<string, unknown>, message: string): void;
  };
  now?: () => number;
  automatedMuteMaxDurationSeconds?: number;
  messageMaxLength?: number;
  historyPageSize?: number;
  catchUpLimit?: number;
  worldId?: string;
  requireCurrentTermsAcceptance?: (playerId: string) => Promise<boolean>;
};

export class ChatService {
  readonly rateLimiter: BoundedChatRateLimiter;
  readonly recentCache: BoundedRecentChatCache;
  readonly historyPageSize: number;
  readonly catchUpLimit: number;
  private readonly now: () => number;
  private readonly automatedMuteMaxDurationSeconds: number;
  private readonly messageMaxLength: number;
  private readonly worldId: string;
  private readonly metrics: ChatServiceMetrics = {
    acceptedMessages: 0,
    replayedMessages: 0,
    rejectedMessages: 0,
    rateLimitEvents: 0,
    moderationQueueOverflows: 0,
    databaseInsertLatencyMs: 0,
    historyQueries: 0,
    historyQueryLatencyMs: 0,
    reconnectCatchUps: 0,
    boundedSnapshots: 0
  };

  constructor(private readonly pool: pg.Pool, private readonly options: ChatServiceOptions = {}) {
    this.rateLimiter = options.rateLimiter ?? new BoundedChatRateLimiter();
    this.recentCache = options.recentCache ?? new BoundedRecentChatCache();
    this.now = options.now ?? Date.now;
    this.automatedMuteMaxDurationSeconds =
      options.automatedMuteMaxDurationSeconds ?? CHAT_SERVER_LIMITS.automatedMuteMaxDurationSeconds;
    this.messageMaxLength = options.messageMaxLength ?? CHAT_SERVER_LIMITS.messageMaxCharacters;
    this.worldId = options.worldId ?? "global";
    this.historyPageSize = configuredBound(
      options.historyPageSize,
      CHAT_HISTORY_PAGE_SIZE,
      "Chat history page size"
    );
    this.catchUpLimit = configuredBound(
      options.catchUpLimit,
      CHAT_CATCH_UP_LIMIT,
      "Chat catch-up limit"
    );
    if (this.catchUpLimit < this.historyPageSize) {
      throw new Error("Chat catch-up limit cannot be smaller than the history page size");
    }
  }

  async listChannels(playerId = ""): Promise<ChatChannel[]> {
    const scoped = playerId ? await this.ensureScopedChannels(playerId) : [];
    const result = await this.pool.query<ChannelRow>(
      `${CHANNEL_SELECT}
       WHERE c.active = true
         AND (
           c.channel_type IN ('public', 'local')
           OR c.channel_key = ANY($1::text[])
         )
       ORDER BY array_position(
         ARRAY['${CHAT_CHANNEL_KEYS.join("','")}']::text[],
         c.channel_key
       ) NULLS LAST, c.channel_key
       LIMIT $2`,
      [scoped.map(({ channelKey }) => channelKey), CHAT_SERVER_LIMITS.previewSubscriptionsPerConnection]
    );
    return result.rows.map(channelFromRow);
  }

  async channelsSnapshot(
    playerId: string,
    selectedChannelKey: ChatChannelKey = CHAT_CHANNEL_KEYS[0]
  ): Promise<ChatChannelsSnapshot> {
    const [channels, mute, pinnedChannelCategories] = await Promise.all([
      this.listChannels(playerId),
      this.activeMute(playerId, selectedChannelKey)
      ,
      this.pinnedChannelCategories(playerId)
    ]);
    const states = await this.readStates(
      playerId,
      channels.filter((channel) => channel.historyRetentionPolicy === "durable")
    );
    return { channels, readStates: states, mute, pinnedChannelCategories };
  }

  async assertDurableChannelAccess(
    playerId: string,
    channelKey: ChatChannelKey
  ): Promise<ChatChannel> {
    const authorized = await this.requireAuthorizedChannel(this.pool, playerId, channelKey);
    if (authorized.channel.historyRetentionPolicy !== "durable") {
      throw new ChatServiceError("CHAT_CHANNEL_NOT_FOUND", "Chat channel does not exist");
    }
    return authorized.channel;
  }

  async assertLocalChannelAccess(
    playerId: string,
    channelKey: ChatChannelKey
  ): Promise<ChatChannel> {
    const { channel } = await this.requireAuthorizedChannel(this.pool, playerId, channelKey);
    if (channel.type !== "local") {
      throw new ChatServiceError("CHAT_CHANNEL_NOT_FOUND", "Chat channel does not exist");
    }
    return channel;
  }

  async readState(playerId: string, channelKey: ChatChannelKey): Promise<ChatReadState> {
    if (!playerId) {
      throw new ChatServiceError("CHAT_ACCESS_DENIED", "Authenticated player is required");
    }
    const { channel } = await this.requireAuthorizedChannel(this.pool, playerId, channelKey);
    if (channel.historyRetentionPolicy !== "durable") {
      throw new ChatServiceError("CHAT_ACCESS_DENIED", "Chat read state is unavailable");
    }
    const [state] = await this.readStates(playerId, [channel]);
    if (!state) throw new Error("Chat read state is unavailable");
    return state;
  }

  async send(input: ChatSendInput): Promise<ChatSendResult> {
    assertUuid(input.clientRequestId, "Client request id");
    if (!input.senderPlayerId) {
      throw new ChatServiceError("CHAT_REQUEST_INVALID", "Authenticated sender is required");
    }
    if (input.tradeListing !== undefined && input.partyListing !== undefined) {
      throw new ChatServiceError("CHAT_LISTING_INVALID", "A message can carry only one card.");
    }
    const tradeListing = input.tradeListing === undefined
      ? null
      : requireTradeListing(input.channelKey, input.tradeListing);
    const partyListing = input.partyListing === undefined
      ? null
      : requirePartyListing(input.channelKey, input.partyListing);
    // A listing's body is always the server-built fallback text, never client-supplied text.
    const normalizedBody = normalizeChatBody(
      tradeListing
        ? chatTradeListingFallbackBody(tradeListing)
        : partyListing ? chatPartyListingFallbackBody(partyListing) : input.body,
      this.messageMaxLength
    );
    const filteredBody = filterChatBody(normalizedBody);
    if (!filteredBody.allowed) {
      throw new ChatServiceError(
        "CHAT_REQUEST_INVALID",
        "That message cannot be sent. Please revise it and try again."
      );
    }
    const body = filteredBody.body;
    const senderDisplayName = normalizeChatSenderDisplayName(input.senderDisplayName);
    await this.requireAuthorizedChannel(this.pool, input.senderPlayerId, input.channelKey);
    const initialReplay = await this.findReplay(this.pool, input.senderPlayerId, input.clientRequestId);
    if (initialReplay) return this.replayResult(initialReplay, input.channelKey, body);
    if (
      this.options.requireCurrentTermsAcceptance &&
      !(await this.options.requireCurrentTermsAcceptance(input.senderPlayerId))
    ) {
      throw new ChatServiceError(
        "CHAT_TERMS_REQUIRED",
        "Accept the current Community Rules before sending chat messages."
      );
    }

    const client = await this.pool.connect();
    const insertStarted = performance.now();
    let committed: ChatMessage | null = null;
    let rateReservation: ChatRateLimitReservation | null = null;
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
        [`chat-send:${input.senderPlayerId}:${input.clientRequestId}`]
      );
      const { channel: lockedChannel } = await this.requireAuthorizedChannel(
        client,
        input.senderPlayerId,
        input.channelKey
      );
      const replay = await this.findReplay(client, input.senderPlayerId, input.clientRequestId);
      if (replay) {
        const result = this.replayResult(replay, input.channelKey, body);
        await client.query("COMMIT");
        return result;
      }
      const mute = await this.findActiveMute(client, input.senderPlayerId, lockedChannel.id);
      if (mute) {
        throw new ChatServiceError(
          "CHAT_MUTED",
          mute.reason,
          Math.max(1, asDate(mute.expires_at).getTime() - this.now())
        );
      }
      if (tradeListing?.kind === "sell") {
        await assertListingOwnership(client, input.senderPlayerId, tradeListing);
      }
      const rate = this.rateLimiter.reserve(
        input.senderPlayerId,
        lockedChannel.key,
        body,
        resolveRatePolicy(lockedChannel.key, storedRatePolicy(lockedChannel)),
        this.now()
      );
      if (!rate.allowed) {
        this.metrics.rateLimitEvents += 1;
        throw new ChatServiceError(
          rate.reason === "duplicate" ? "CHAT_DUPLICATE_SPAM" : "CHAT_RATE_LIMITED",
          rate.reason === "duplicate" ? "Repeated chat message rejected" : "Chat rate limit exceeded",
          rate.retryAfterMs
        );
      }
      rateReservation = rate.reservation;
      const sequenceResult = await client.query<{ last_sequence: string | number }>(
        `UPDATE chat_channel_sequences
         SET last_sequence = last_sequence + 1
         WHERE channel_id = $1
         RETURNING last_sequence`,
        [lockedChannel.id]
      );
      const sequence = safeSequence(sequenceResult.rows[0]?.last_sequence);
      if (sequence === null) throw new Error("Chat channel sequence row is missing");
      const inserted = await client.query<InsertedMessageRow>(
        `${MESSAGE_INSERT}
         RETURNING id, channel_id, sequence_number,
                   sender_player_id, sender_display_name, body, client_request_id,
                   message_status, moderation_status, edited_at, deleted_at, created_at, updated_at`,
        [
          crypto.randomUUID(),
          lockedChannel.id,
          sequence,
          input.senderPlayerId,
          senderDisplayName,
          body,
          input.clientRequestId,
          tradeListing ? JSON.stringify(tradeListing) : null,
          partyListing ? JSON.stringify(partyListing) : null
        ]
      );
      const row = inserted.rows[0];
      if (!row) throw new Error("Chat message insert returned no row");
      const projected = await client.query<MessageRow>(
        `${MESSAGE_SELECT} WHERE m.id = $1`,
        [row.id]
      );
      const projectedRow = projected.rows[0];
      if (!projectedRow) throw new Error("Chat message projection returned no row");
      committed = messageFromRow(projectedRow);
      await client.query("COMMIT");
      rateReservation.commit();
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Preserve the originating failure; the connection will be released below.
      }
      rateReservation?.rollback();
      this.metrics.rejectedMessages += 1;
      if (isUniqueViolation(error)) {
        const replay = await this.findReplay(this.pool, input.senderPlayerId, input.clientRequestId);
        if (replay) return this.replayResult(replay, input.channelKey, body);
      }
      throw error;
    } finally {
      client.release();
      this.metrics.databaseInsertLatencyMs += performance.now() - insertStarted;
    }

    if (!committed) throw new Error("Chat send did not commit a message");
    this.metrics.acceptedMessages += 1;
    if (committed.channelKey !== CHAT_LOCAL_CHANNEL_KEY) {
      this.recentCache.append(committed, this.now());
    }
    const moderationQueued = this.options.moderationDispatcher?.enqueue({
      messageId: committed.id,
      channelId: committed.channelId,
      channelKey: committed.channelKey,
      channelType: parseChatChannelKey(committed.channelKey)?.type ?? "public",
      senderPlayerId: committed.senderPlayerId,
      body: committed.body,
      serverCreatedAt: committed.serverCreatedAt,
      moderationPolicyVersion: "public_chat_v1"
    }) ?? false;
    if (this.options.moderationDispatcher && !moderationQueued) {
      this.metrics.moderationQueueOverflows += 1;
      this.options.logger?.warn(
        { messageId: committed.id, channelId: committed.channelId },
        "chat moderation queue is full; delivery remains accepted"
      );
    }
    this.options.logger?.info(
      {
        messageId: committed.id,
        channelId: committed.channelId,
        senderPlayerId: committed.senderPlayerId,
        sequence: committed.sequence
      },
      "chat message accepted"
    );
    return { message: committed, replayed: false, moderationQueued };
  }

  /** Visible Hunting cards posted since `since`, oldest first, for the live-state projector. */
  async recentPartyListings(since: Date): Promise<Array<{
    messageId: string;
    senderPlayerId: string;
    createdAt: string;
    listing: ChatPartyListing;
  }>> {
    const result = await this.pool.query<{
      id: string;
      sender_player_id: string;
      created_at: Date | string;
      party_listing: unknown;
    }>(
      `SELECT id, sender_player_id, created_at, party_listing
       FROM chat_messages
       WHERE party_listing IS NOT NULL AND created_at >= $1 AND message_status = 'visible'
       ORDER BY created_at, id`,
      [since]
    );
    return result.rows.flatMap((row) => {
      const listing = normalizeChatPartyListing(row.party_listing);
      return listing
        ? [{ messageId: row.id, senderPlayerId: row.sender_player_id, createdAt: asIso(row.created_at), listing }]
        : [];
    });
  }

  /** The poster closes their own Hunting card early; false when it was not theirs or already closed. */
  async cancelPartyListing(playerId: string, messageId: string): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE chat_messages
       SET party_listing = party_listing || '{"cancelled": true}'::jsonb, updated_at = now()
       WHERE id = $1 AND sender_player_id = $2 AND party_listing IS NOT NULL
         AND message_status = 'visible'
         AND (party_listing->>'cancelled') IS DISTINCT FROM 'true'`,
      [messageId, playerId]
    );
    return Boolean(result.rowCount);
  }

  async deleteMessage(playerId: string, messageId: string): Promise<ChatMessageDeleteResult> {
    if (!playerId) {
      throw new ChatServiceError("CHAT_ACCESS_DENIED", "Authenticated developer is required");
    }
    assertUuid(messageId, "Chat message id");

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const targetResult = await client.query<DeletionTargetRow>(
        `SELECT m.id, m.channel_id, c.channel_key, m.sequence_number,
                m.sender_player_id, m.sender_display_name, m.body, m.client_request_id,
                m.message_status, m.moderation_status, m.edited_at, m.deleted_at,
                m.created_at, m.updated_at,
                profile.equipped_chat_crest_id,
                c.channel_type, c.display_name, c.visibility_policy,
                c.send_access_policy, c.history_retention_policy,
                c.rate_limit_policy, c.moderation_policy, c.active,
                COALESCE(sequence.last_sequence, 0) AS latest_sequence,
                COALESCE(c.deletion_revision, 0) AS deletion_revision
           FROM chat_messages m
           JOIN chat_channels c ON c.id = m.channel_id
           LEFT JOIN player_profiles profile ON profile.player_id = m.sender_player_id
           LEFT JOIN chat_channel_sequences sequence ON sequence.channel_id = c.id
          WHERE m.id = $1
          FOR UPDATE OF m, c`,
        [messageId]
      );
      const target = targetResult.rows[0];
      if (!target) {
        throw new ChatServiceError("CHAT_MESSAGE_NOT_FOUND", "Chat message does not exist");
      }

      const channel = channelFromRow(target);
      const supportedTypes = new Set(["public", "city", "kingdom", "party"]);
      if (!channel.active || channel.historyRetentionPolicy !== "durable" || !supportedTypes.has(channel.type)) {
        throw new ChatServiceError("CHAT_MESSAGE_DELETE_UNAVAILABLE", "This chat message cannot be deleted");
      }

      if (target.message_status === "deleted") {
        await client.query("COMMIT");
        return {
          message: messageFromRow(target),
          deletionRevision: safeSequence(target.deletion_revision) ?? 0,
          replayed: true
        };
      }
      if (target.message_status !== "visible" || target.deleted_at !== null) {
        throw new ChatServiceError("CHAT_MESSAGE_DELETE_UNAVAILABLE", "This chat message cannot be deleted");
      }

      const updated = await client.query<MessageRow>(
        `UPDATE chat_messages
            SET message_status = 'deleted',
                deleted_at = now(),
                deletion_reason = 'developer_chat_delete'
          WHERE id = $1 AND message_status = 'visible'
          RETURNING id, channel_id, sequence_number, sender_player_id,
                    sender_display_name, body, client_request_id,
                    message_status, moderation_status, edited_at, deleted_at,
                    created_at, updated_at`,
        [messageId]
      );
      const updatedRow = updated.rows[0];
      if (!updatedRow) {
        throw new ChatServiceError("CHAT_MESSAGE_DELETE_UNAVAILABLE", "This chat message cannot be deleted");
      }
      const revisionResult = await client.query<{ deletion_revision: string | number }>(
        `UPDATE chat_channels
            SET deletion_revision = COALESCE(deletion_revision, 0) + 1
          WHERE id = $1
          RETURNING deletion_revision`,
        [target.channel_id]
      );
      const deletionRevision = safeSequence(revisionResult.rows[0]?.deletion_revision);
      if (deletionRevision === null) throw new Error("Chat deletion revision update returned no row");
      await client.query("COMMIT");

      const message = messageFromRow({
        ...updatedRow,
        channel_key: target.channel_key,
        equipped_chat_crest_id: target.equipped_chat_crest_id
      });
      this.recentCache.append(message, this.now());
      return { message, deletionRevision, replayed: false };
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Preserve the originating failure; the connection is released below.
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async history(input: {
    playerId: string;
    channelKey: ChatChannelKey;
    beforeSequence?: number | undefined;
    afterSequence?: number | undefined;
    limit?: number | undefined;
  }): Promise<ChatHistoryResult> {
    if (!input.playerId) {
      throw new ChatServiceError("CHAT_ACCESS_DENIED", "Authenticated player is required");
    }
    if (input.beforeSequence !== undefined && input.afterSequence !== undefined) {
      throw new ChatServiceError("CHAT_HISTORY_CURSOR_INVALID", "Use only one chat history cursor");
    }
    assertCursor(input.beforeSequence);
    assertCursor(input.afterSequence);
    const started = performance.now();
    try {
      const authorized = await this.requireAuthorizedChannel(
        this.pool,
        input.playerId,
        input.channelKey
      );
      const channel = authorized.channel;
      if (channel.historyRetentionPolicy !== "durable") {
        throw new ChatServiceError("CHAT_ACCESS_DENIED", "Chat history is unavailable");
      }
      let mode: ChatHistoryMode;
      let resetRequired = false;
      let descending = false;
      const values: unknown[] = [channel.id];
      let predicate: string;
      let maximum: number;

      predicate = "m.channel_id = $1";
      if (authorized.membershipStartedAt) {
        values.push(authorized.membershipStartedAt);
        predicate += ` AND m.created_at >= $${values.length}`;
      }

      if (input.afterSequence !== undefined) {
        this.metrics.reconnectCatchUps += 1;
        if (channel.latestSequence - input.afterSequence > this.catchUpLimit) {
          mode = "bounded-snapshot";
          resetRequired = true;
          descending = true;
          maximum = this.historyPageSize;
          this.metrics.boundedSnapshots += 1;
        } else {
          mode = "catch-up";
          maximum = boundedLimit(input.limit, this.catchUpLimit, this.historyPageSize);
          values.push(input.afterSequence);
          predicate += ` AND m.sequence_number > $${values.length}`;
        }
      } else if (input.beforeSequence !== undefined) {
        mode = "older";
        descending = true;
        maximum = boundedLimit(input.limit, this.historyPageSize, this.historyPageSize);
        values.push(input.beforeSequence);
        predicate += ` AND m.sequence_number < $${values.length}`;
      } else {
        mode = "initial";
        descending = true;
        maximum = boundedLimit(input.limit, this.historyPageSize, this.historyPageSize);
      }

      const order = descending ? "DESC" : "ASC";
      values.push(maximum + 1);
      const result = await this.pool.query<MessageRow>(
        `${MESSAGE_SELECT}
         WHERE ${predicate}
         ORDER BY m.sequence_number ${order}
         LIMIT $${values.length}`,
        values
      );
      const hasMore = result.rows.length > maximum;
      const selected = result.rows.slice(0, maximum).map(messageFromRow);
      if (descending) selected.reverse();
      return {
        channel,
        messages: await this.withSharedTranslations(selected),
        mode,
        latestSequence: channel.latestSequence,
        hasMore,
        resetRequired
      };
    } finally {
      this.metrics.historyQueries += 1;
      this.metrics.historyQueryLatencyMs += performance.now() - started;
    }
  }

  /** Attach cached shared translations (one query per page) to visible messages only. */
  private async withSharedTranslations(messages: ChatMessage[]): Promise<ChatMessage[]> {
    const visibleIds = messages
      .filter((message) => message.status === "confirmed" && message.moderationStatus !== "hidden")
      .map((message) => message.id);
    if (visibleIds.length === 0) return messages;
    const result = await this.pool.query<{
      message_id: string;
      target_language: string;
      translated_text: string;
      source_language: string | null;
    }>(
      `SELECT message_id, target_language, translated_text, source_language
         FROM chat_translation_cache
        WHERE message_id = ANY($1::uuid[])
          AND provider = $2
          AND model = $3
          AND version = $4`,
      [
        visibleIds,
        CHAT_TRANSLATION_PROVIDER,
        CHAT_TRANSLATION_MODEL,
        CHAT_TRANSLATION_VERSION
      ]
    );
    if (!Array.isArray(result?.rows) || result.rows.length === 0) return messages;
    const byMessage = new Map<string, ChatMessageTranslations>();
    for (const row of result.rows) {
      if (!isTranslationLanguage(row.target_language)) continue;
      const translations = byMessage.get(row.message_id) ?? {};
      translations[row.target_language] = {
        translatedText: row.translated_text,
        ...(row.source_language ? { sourceLanguage: row.source_language } : {})
      };
      byMessage.set(row.message_id, translations);
    }
    return messages.map((message) => {
      const translations = byMessage.get(message.id);
      return translations ? { ...message, translations } : message;
    });
  }

  /**
   * Return the authoritative visible message after applying the same channel and membership
   * checks used by history. Translation callers must never provide arbitrary message text.
   */
  async getMessageForTranslation(playerId: string, messageId: string): Promise<ChatMessage> {
    if (!playerId) {
      throw new ChatServiceError("CHAT_ACCESS_DENIED", "Authenticated player is required");
    }
    assertUuid(messageId, "Chat message id");
    const result = await this.pool.query<MessageRow>(
      `${MESSAGE_SELECT} WHERE m.id = $1`,
      [messageId]
    );
    const row = result.rows[0];
    if (!row) {
      throw new ChatServiceError("CHAT_MESSAGE_NOT_FOUND", "Chat message does not exist");
    }
    const authorized = await this.requireAuthorizedChannel(this.pool, playerId, row.channel_key);
    if (authorized.channel.historyRetentionPolicy !== "durable") {
      throw new ChatServiceError("CHAT_MESSAGE_NOT_FOUND", "Chat message does not exist");
    }
    if (
      authorized.membershipStartedAt &&
      asDate(row.created_at).getTime() < authorized.membershipStartedAt.getTime()
    ) {
      throw new ChatServiceError("CHAT_MESSAGE_NOT_FOUND", "Chat message does not exist");
    }
    if (row.message_status !== "visible" || row.deleted_at !== null) {
      throw new ChatServiceError("CHAT_MESSAGE_NOT_FOUND", "Chat message does not exist");
    }
    if (Array.from(row.body).length > this.messageMaxLength) {
      throw new ChatServiceError(
        "CHAT_REQUEST_INVALID",
        "Chat messages over 400 characters cannot be translated"
      );
    }
    return messageFromRow(row);
  }

  async markRead(playerId: string, channelKey: ChatChannelKey, requestedSequence: number): Promise<ChatReadState> {
    assertCursor(requestedSequence);
    const authorized = await this.requireAuthorizedChannel(this.pool, playerId, channelKey);
    const channel = authorized.channel;
    if (channel.historyRetentionPolicy !== "durable") {
      throw new ChatServiceError("CHAT_ACCESS_DENIED", "Chat read state is unavailable");
    }
    const floor = await this.membershipSequenceFloor(channel, authorized.membershipStartedAt);
    const clamped = Math.max(floor, Math.min(requestedSequence, channel.latestSequence));
    const result = await this.pool.query<{ last_read_sequence: string | number; updated_at: Date | string }>(
      `INSERT INTO chat_channel_read_states (player_id, channel_id, last_read_sequence)
       VALUES ($1, $2, $3)
       ON CONFLICT (player_id, channel_id) DO UPDATE
       SET last_read_sequence = GREATEST(chat_channel_read_states.last_read_sequence, EXCLUDED.last_read_sequence)
       RETURNING last_read_sequence, updated_at`,
      [playerId, channel.id, clamped]
    );
    const row = result.rows[0];
    const lastReadSequence = safeSequence(row?.last_read_sequence) ?? 0;
    return {
      channelKey: channel.key,
      lastReadSequence,
      latestSequence: channel.latestSequence,
      unreadCount: Math.max(0, channel.latestSequence - lastReadSequence),
      updatedAt: row ? asIso(row.updated_at) : channel.updatedAt
    };
  }

  async activeMute(playerId: string, channelKey?: ChatChannelKey): Promise<ChatMuteSnapshot> {
    const channel = channelKey
      ? (await this.requireAuthorizedChannel(this.pool, playerId, channelKey)).channel
      : null;
    const mute = await this.findActiveMute(this.pool, playerId, channel?.id ?? null);
    return mute
      ? {
          muted: true,
          channelKey: mute.channel_key,
          scope: mute.scope,
          reason: mute.reason,
          expiresAt: asIso(mute.expires_at)
        }
      : { muted: false, channelKey: null, scope: null, reason: null, expiresAt: null };
  }

  async createMute(input: ChatMuteCreateInput): Promise<ChatMuteRecord> {
    if (!Number.isSafeInteger(input.durationSeconds) || input.durationSeconds <= 0) {
      throw new ChatServiceError("CHAT_REQUEST_INVALID", "Mute duration must be positive");
    }
    const duration = input.source === "automated_moderation"
      ? Math.min(input.durationSeconds, this.automatedMuteMaxDurationSeconds)
      : input.durationSeconds;
    const channel = input.scope === "channel"
      ? await this.requireStoredChannel(this.pool, input.channelKey ?? "")
      : null;
    if (input.moderationDecisionId) assertUuid(input.moderationDecisionId, "Moderation decision id");
    const actorMetadataJson = JSON.stringify(input.actorMetadata ?? {}) ?? "{}";
    const replay = await this.findMuteReplay(input);
    if (replay) return this.replayMute(replay, input, channel?.id ?? null, duration, actorMetadataJson);
    try {
      const result = await this.pool.query<MuteRecordRow>(
        `INSERT INTO chat_mutes (
           id, player_id, scope, channel_id, source, reason_category, reason,
           actor_type, actor_id, actor_metadata, moderation_decision_id,
           idempotency_key, expires_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,
                   now() + ($13 * interval '1 second'))
         RETURNING id, player_id, scope, channel_id, source, reason_category, reason,
                   actor_type, actor_id, actor_metadata, moderation_decision_id,
                   idempotency_key, created_at, expires_at, revoked_at,
                   EXTRACT(EPOCH FROM (expires_at - created_at)) AS duration_seconds`,
        [
          crypto.randomUUID(), input.playerId, input.scope, channel?.id ?? null, input.source,
          input.reasonCategory.trim(), input.reason.trim(), input.actorType, input.actorId ?? null,
          actorMetadataJson, input.moderationDecisionId ?? null,
          input.idempotencyKey ?? null, duration
        ]
      );
      return muteRecordFromRow(requireRow(result.rows[0], "Mute insert returned no row"));
    } catch (error) {
      if (isUniqueViolation(error) && (input.idempotencyKey || input.moderationDecisionId)) {
        const racedReplay = await this.findMuteReplay(input);
        if (racedReplay) {
          return this.replayMute(
            racedReplay,
            input,
            channel?.id ?? null,
            duration,
            actorMetadataJson
          );
        }
      }
      throw error;
    }
  }

  async revokeMute(muteId: string, revokedBy: string, reason: string): Promise<boolean> {
    assertUuid(muteId, "Mute id");
    const result = await this.pool.query(
      `UPDATE chat_mutes
       SET revoked_at = now(), revoked_by = $2, revocation_reason = $3
       WHERE id = $1 AND revoked_at IS NULL`,
      [muteId, revokedBy.trim(), reason.trim()]
    );
    return (result.rowCount ?? 0) > 0;
  }

  async blockedSenderIds(playerId: string, maximum = 5_000): Promise<string[]> {
    const limit = Math.max(1, Math.min(maximum, 5_000));
    const result = await this.pool.query<{ blocked_id: string }>(
      `SELECT blocked_id FROM player_blocks
       WHERE blocker_id = $1 ORDER BY created_at DESC, blocked_id LIMIT $2`,
      [playerId, limit]
    );
    return result.rows.map((row) => row.blocked_id);
  }

  async pinnedChannelCategories(playerId: string): Promise<ChatChannelCategory[]> {
    const result = await this.pool.query<{ pinned_categories: string[] }>(
      `SELECT preference.pinned_categories
       FROM players player
       LEFT JOIN account_chat_preferences preference
         ON preference.account_id = player.account_id
       WHERE player.id = $1`,
      [playerId]
    );
    const stored = result.rows[0]?.pinned_categories;
    return validPinnedCategories(stored)
      ? [...stored]
      : [...CHAT_DEFAULT_PINNED_CATEGORIES];
  }

  async updatePinnedChannelCategories(
    playerId: string,
    categories: readonly ChatChannelCategory[]
  ): Promise<ChatChannelCategory[]> {
    if (!validPinnedCategories(categories)) {
      throw new ChatServiceError("CHAT_REQUEST_INVALID", "Choose four different pinned chats");
    }
    const result = await this.pool.query<{ pinned_categories: string[] }>(
      `INSERT INTO account_chat_preferences (account_id, pinned_categories)
       SELECT account_id, $2::text[]
       FROM players
       WHERE id = $1 AND account_id IS NOT NULL
       ON CONFLICT (account_id) DO UPDATE
       SET pinned_categories = EXCLUDED.pinned_categories
       RETURNING pinned_categories`,
      [playerId, categories]
    );
    const stored = result.rows[0]?.pinned_categories;
    if (!validPinnedCategories(stored)) {
      throw new ChatServiceError("CHAT_ACCESS_DENIED", "Account chat preferences are unavailable");
    }
    return [...stored];
  }

  async authorizedRecipientPlayerIds(
    channelKey: ChatChannelKey,
    playerIds: readonly string[],
    /** When set, only members who joined at or before this time (they can see that message). */
    messageCreatedAt?: Date
  ): Promise<Set<string>> {
    const parsed = parseChatChannelKey(channelKey);
    const unique = [...new Set(playerIds)];
    const joinedBefore = messageCreatedAt ?? null;
    if (!parsed) return new Set();
    if (parsed.type === "public" || parsed.type === "local") return new Set(unique);
    const result = parsed.type === "city"
      ? await this.pool.query<{ player_id: string }>(
          `SELECT membership.player_id
           FROM city_memberships membership
           JOIN cities city ON city.id = membership.city_id
           WHERE membership.city_id = $1
             AND membership.player_id = ANY($2::text[])
             AND membership.left_at IS NULL
             AND membership.world_id = $3
             AND city.active
             AND ($4::timestamptz IS NULL OR membership.joined_at <= $4)`,
          [parsed.scopeId, unique, this.worldId, joinedBefore]
        )
      : parsed.type === "kingdom"
        ? await this.pool.query<{ player_id: string }>(
          `SELECT membership.player_id
           FROM kingdom_memberships membership
           JOIN kingdoms kingdom ON kingdom.id = membership.kingdom_id
           WHERE membership.kingdom_id = $1
             AND membership.player_id = ANY($2::text[])
             AND membership.status = 'active'
             AND kingdom.status = 'active'
             AND ($3::timestamptz IS NULL OR membership.joined_at <= $3)`,
            [parsed.scopeId, unique, joinedBefore]
          )
        : await this.pool.query<{ player_id: string }>(
            `SELECT membership.player_id
             FROM party_members membership
             WHERE membership.party_id = $1
               AND membership.player_id = ANY($2::text[])
               AND ($3::timestamptz IS NULL OR membership.joined_at <= $3)`,
            [parsed.key, unique, joinedBefore]
          );
    return new Set(result.rows.map((row) => row.player_id));
  }

  metricsSnapshot(): ChatServiceMetrics & {
    recentCacheChannels: number;
    recentCacheMessages: number;
    rateLimitKeys: number;
  } {
    const now = this.now();
    this.recentCache.prune(now);
    this.rateLimiter.prune(now);
    const cache = this.recentCache.metrics();
    return {
      ...this.metrics,
      recentCacheChannels: cache.channels,
      recentCacheMessages: cache.messages,
      rateLimitKeys: this.rateLimiter.size
    };
  }

  private async requireStoredChannel(
    queryable: Queryable,
    channelKey: ChatChannelKey
  ): Promise<ChatChannel> {
    const result = await queryable.query<ChannelRow>(`${CHANNEL_SELECT} WHERE c.channel_key = $1`, [channelKey]);
    const row = result.rows[0];
    if (!row || !parseChatChannelKey(row.channel_key)) {
      throw new ChatServiceError("CHAT_CHANNEL_NOT_FOUND", "Chat channel does not exist");
    }
    if (!row.active) throw new ChatServiceError("CHAT_CHANNEL_INACTIVE", "Chat channel is inactive");
    return channelFromRow(row);
  }

  private async requireAuthorizedChannel(
    queryable: Queryable,
    playerId: string,
    channelKey: ChatChannelKey
  ): Promise<{ channel: ChatChannel; membershipStartedAt: Date | null }> {
    if (!playerId) {
      throw new ChatServiceError("CHAT_ACCESS_DENIED", "Authenticated player is required");
    }
    const parsed = parseChatChannelKey(channelKey);
    if (!parsed) {
      throw new ChatServiceError("CHAT_CHANNEL_NOT_FOUND", "Chat channel does not exist");
    }
    const channel = await this.requireStoredChannel(queryable, parsed.key);
    if (parsed.type === "public" || parsed.type === "local") {
      return { channel, membershipStartedAt: null };
    }
    const membership = parsed.type === "city"
      ? await queryable.query<{ joined_at: Date | string }>(
          `SELECT membership.joined_at
           FROM city_memberships membership
           JOIN cities city ON city.id = membership.city_id
           WHERE membership.player_id = $1
             AND membership.city_id = $2
             AND membership.left_at IS NULL
             AND membership.world_id = $3
             AND city.active
           LIMIT 1`,
          [playerId, parsed.scopeId, this.worldId]
        )
      : parsed.type === "kingdom"
        ? await queryable.query<{ joined_at: Date | string }>(
          `SELECT membership.joined_at
           FROM kingdom_memberships membership
           JOIN kingdoms kingdom ON kingdom.id = membership.kingdom_id
           WHERE membership.player_id = $1
             AND membership.kingdom_id = $2
             AND membership.status = 'active'
             AND kingdom.status = 'active'
           LIMIT 1`,
            [playerId, parsed.scopeId]
          )
        : await queryable.query<{ joined_at: Date | string }>(
            `SELECT membership.joined_at
             FROM party_members membership
             WHERE membership.player_id = $1
               AND membership.party_id = $2
             LIMIT 1`,
            [playerId, parsed.key]
          );
    const row = membership.rows[0];
    if (!row) {
      throw new ChatServiceError("CHAT_ACCESS_DENIED", "Chat membership is required");
    }
    return { channel, membershipStartedAt: asDate(row.joined_at) };
  }

  private async ensureScopedChannels(
    playerId: string
  ): Promise<Array<{ channelKey: ChatChannelKey; joinedAt: Date }>> {
    const result = await this.pool.query<{
      scope_type: "city" | "kingdom" | "party";
      scope_id: string;
      joined_at: Date | string;
    }>(
      `SELECT 'city'::text AS scope_type, membership.city_id::text AS scope_id,
              membership.joined_at
       FROM city_memberships membership
       JOIN cities city ON city.id = membership.city_id
       WHERE membership.player_id = $1
         AND membership.left_at IS NULL
         AND membership.world_id = $2
         AND city.active
       UNION ALL
       SELECT 'kingdom'::text AS scope_type, membership.kingdom_id::text AS scope_id,
              membership.joined_at
       FROM kingdom_memberships membership
       JOIN kingdoms kingdom ON kingdom.id = membership.kingdom_id
       WHERE membership.player_id = $1
         AND membership.status = 'active'
         AND kingdom.status = 'active'
       UNION ALL
       SELECT 'party'::text AS scope_type,
              substring(membership.party_id FROM 7) AS scope_id,
              membership.joined_at
       FROM party_members membership
       WHERE membership.player_id = $1`,
      [playerId, this.worldId]
    );
    const scopes = result.rows.flatMap((row) => {
      const channelKey = scopedChatChannelKey(row.scope_type, row.scope_id);
      return channelKey ? [{ channelKey, joinedAt: asDate(row.joined_at) }] : [];
    });
    for (const scope of scopes) {
      const parsed = parseChatChannelKey(scope.channelKey)!;
      const displayName = parsed.type === "city"
        ? "City"
        : parsed.type === "kingdom"
          ? "Kingdom"
          : "Party";
      const policy = `current_${parsed.type}_member_v1`;
      const inserted = await this.pool.query<{ id: string }>(
        `INSERT INTO chat_channels (
           id, channel_key, channel_type, display_name, visibility_policy,
           send_access_policy, history_retention_policy, rate_limit_policy,
           moderation_policy, active
         ) VALUES (gen_random_uuid(), $1, $2, $3, $4, $4, 'bounded_scoped_v1',
                   'public_standard_v1', 'public_chat_v1', true)
         ON CONFLICT (channel_key) DO UPDATE SET active = true
         RETURNING id`,
        [scope.channelKey, parsed.type, displayName, policy]
      );
      await this.pool.query(
        `INSERT INTO chat_channel_sequences (channel_id, last_sequence)
         VALUES ($1, 0) ON CONFLICT (channel_id) DO NOTHING`,
        [inserted.rows[0]!.id]
      );
    }
    return scopes;
  }

  private async membershipSequenceFloor(
    channel: ChatChannel,
    membershipStartedAt: Date | null
  ): Promise<number> {
    if (!membershipStartedAt) return 0;
    const result = await this.pool.query<{ sequence_floor: string | number }>(
      `SELECT COALESCE(max(sequence_number), 0) AS sequence_floor
       FROM chat_messages
       WHERE channel_id = $1 AND created_at < $2`,
      [channel.id, membershipStartedAt]
    );
    return safeSequence(result.rows[0]?.sequence_floor) ?? 0;
  }

  private async findReplay(queryable: Queryable, playerId: string, requestId: string): Promise<MessageRow | null> {
    const result = await queryable.query<MessageRow>(
      `${MESSAGE_SELECT} WHERE m.sender_player_id = $1 AND m.client_request_id = $2`,
      [playerId, requestId]
    );
    return result.rows[0] ?? null;
  }

  private replayResult(row: MessageRow, expectedChannelKey: string, expectedBody: string): ChatSendResult {
    if (row.channel_key !== expectedChannelKey || row.body !== expectedBody) {
      throw new ChatServiceError(
        "CHAT_IDEMPOTENCY_CONFLICT",
        "Client request id was already used for a different chat message"
      );
    }
    const message = messageFromRow(row);
    this.metrics.replayedMessages += 1;
    return { message, replayed: true, moderationQueued: false };
  }

  private async findActiveMute(
    queryable: Queryable,
    playerId: string,
    channelId: string | null
  ): Promise<MuteRow | null> {
    const result = await queryable.query<MuteRow>(
      `SELECT mute.id, mute.scope, channel.channel_key, mute.reason, mute.expires_at
       FROM chat_mutes mute
       LEFT JOIN chat_channels channel ON channel.id = mute.channel_id
       WHERE mute.player_id = $1
         AND mute.revoked_at IS NULL
         AND mute.expires_at > now()
         AND (mute.scope = 'global' OR ($2::uuid IS NOT NULL AND mute.channel_id = $2::uuid))
       ORDER BY CASE mute.scope WHEN 'global' THEN 0 ELSE 1 END, mute.expires_at DESC
       LIMIT 1`,
      [playerId, channelId]
    );
    return result.rows[0] ?? null;
  }

  private async readStates(playerId: string, channels: ChatChannel[]): Promise<ChatReadState[]> {
    if (channels.length === 0) return [];
    const result = await this.pool.query<{
      channel_id: string;
      last_read_sequence: string | number;
      updated_at: Date | string;
    }>(
      `SELECT channel_id, last_read_sequence, updated_at
       FROM chat_channel_read_states WHERE player_id = $1 AND channel_id = ANY($2::uuid[])`,
      [playerId, channels.map((channel) => channel.id)]
    );
    const byChannel = new Map(result.rows.map((row) => [row.channel_id, row]));
    return Promise.all(channels.map(async (channel) => {
      const row = byChannel.get(channel.id);
      const authorized = await this.requireAuthorizedChannel(this.pool, playerId, channel.key);
      const floor = await this.membershipSequenceFloor(
        channel,
        authorized.membershipStartedAt
      );
      const lastReadSequence = Math.max(
        floor,
        safeSequence(row?.last_read_sequence) ?? 0
      );
      return {
        channelKey: channel.key,
        lastReadSequence,
        latestSequence: channel.latestSequence,
        unreadCount: Math.max(0, channel.latestSequence - lastReadSequence),
        updatedAt: row ? asIso(row.updated_at) : channel.updatedAt
      };
    }));
  }

  private async findMuteReplay(input: ChatMuteCreateInput): Promise<MuteRecordRow | null> {
    if (!input.idempotencyKey && !input.moderationDecisionId) return null;
    const result = await this.pool.query<MuteRecordRow>(
      `${MUTE_RECORD_SELECT}
       WHERE ($1::text IS NOT NULL AND source = $2 AND idempotency_key = $1)
          OR ($3::uuid IS NOT NULL AND moderation_decision_id = $3::uuid)
       LIMIT 2`,
      [input.idempotencyKey ?? null, input.source, input.moderationDecisionId ?? null]
    );
    if (result.rows.length > 1 && result.rows[0]?.id !== result.rows[1]?.id) {
      throw new ChatServiceError(
        "CHAT_IDEMPOTENCY_CONFLICT",
        "Mute idempotency keys identify different existing mutes"
      );
    }
    return result.rows[0] ?? null;
  }

  private replayMute(
    row: MuteRecordRow,
    input: ChatMuteCreateInput,
    channelId: string | null,
    durationSeconds: number,
    actorMetadataJson: string
  ): ChatMuteRecord {
    const semanticallyEqual =
      row.player_id === input.playerId &&
      row.scope === input.scope &&
      row.channel_id === channelId &&
      row.source === input.source &&
      row.reason_category === input.reasonCategory.trim() &&
      row.reason === input.reason.trim() &&
      row.actor_type === input.actorType &&
      row.actor_id === (input.actorId ?? null) &&
      row.moderation_decision_id === (input.moderationDecisionId ?? null) &&
      (input.idempotencyKey == null || row.idempotency_key === input.idempotencyKey) &&
      Number(row.duration_seconds) === durationSeconds &&
      stableJson(row.actor_metadata) === stableJson(JSON.parse(actorMetadataJson) as unknown);
    if (!semanticallyEqual) {
      throw new ChatServiceError(
        "CHAT_IDEMPOTENCY_CONFLICT",
        "Mute idempotency key was already used for different mute parameters"
      );
    }
    return muteRecordFromRow(row);
  }
}

type MuteRecordRow = {
  id: string;
  player_id: string;
  scope: "global" | "channel";
  channel_id: string | null;
  source: ChatMuteCreateInput["source"];
  reason_category: string;
  reason: string;
  actor_type: ChatMuteCreateInput["actorType"];
  actor_id: string | null;
  actor_metadata: unknown;
  moderation_decision_id: string | null;
  idempotency_key: string | null;
  created_at: Date | string;
  expires_at: Date | string;
  revoked_at: Date | string | null;
  duration_seconds: string | number;
};

const MUTE_RECORD_SELECT = `SELECT id, player_id, scope, channel_id, source,
  reason_category, reason, actor_type, actor_id, actor_metadata,
  moderation_decision_id, idempotency_key, created_at, expires_at, revoked_at,
  EXTRACT(EPOCH FROM (expires_at - created_at)) AS duration_seconds
  FROM chat_mutes`;

const CHANNEL_SELECT = `SELECT c.id, c.channel_key, c.channel_type, c.display_name,
  c.visibility_policy, c.send_access_policy, c.history_retention_policy,
  c.rate_limit_policy, c.moderation_policy, c.active, c.created_at, c.updated_at,
  COALESCE(c.deletion_revision, 0) AS deletion_revision,
  COALESCE(sequence.last_sequence, 0) AS latest_sequence
  FROM chat_channels c
  LEFT JOIN chat_channel_sequences sequence ON sequence.channel_id = c.id`;

const MESSAGE_SELECT = `SELECT m.id, m.channel_id, c.channel_key, m.sequence_number,
  m.sender_player_id, m.sender_display_name, m.body, m.client_request_id,
  m.message_status, m.moderation_status, m.edited_at, m.deleted_at,
  m.created_at, m.updated_at, profile.equipped_chat_crest_id, m.trade_listing, m.party_listing
  FROM chat_messages m JOIN chat_channels c ON c.id = m.channel_id
  LEFT JOIN player_profiles profile ON profile.player_id = m.sender_player_id`;

const MESSAGE_INSERT = `INSERT INTO chat_messages (
  id, channel_id, sequence_number, sender_player_id, sender_display_name, body,
  client_request_id, message_status, moderation_status, trade_listing, party_listing
) VALUES ($1,$2,$3,$4,$5,$6,$7,'visible','pending',$8::jsonb,$9::jsonb)`;

function requirePartyListing(channelKey: ChatChannelKey, value: unknown): ChatPartyListing {
  if (channelKey !== CHAT_HUNTING_CHANNEL_KEY) {
    throw new ChatServiceError("CHAT_LISTING_INVALID", "Party cards can only be posted in Hunting.");
  }
  const listing = normalizeChatPartyListing(value);
  if (!listing || (listing.kind === "leader" && !listing.partyId)) {
    throw new ChatServiceError("CHAT_LISTING_INVALID", "That party card is not valid.");
  }
  return listing;
}

function requireTradeListing(channelKey: ChatChannelKey, value: unknown): ChatTradeListing {
  if (channelKey !== CHAT_TRADE_CHANNEL_KEY) {
    throw new ChatServiceError("CHAT_LISTING_INVALID", "Buy and Sell listings can only be posted in Trade.");
  }
  const listing = normalizeChatTradeListing(value);
  if (!listing) {
    throw new ChatServiceError("CHAT_LISTING_INVALID", "That listing is not valid.");
  }
  return listing;
}

/** Selling needs the carried or worn quantity at post time; nothing is reserved or escrowed. */
async function assertListingOwnership(
  queryable: Queryable,
  playerId: string,
  listing: ChatTradeListing
): Promise<void> {
  const result = await queryable.query<{ owned: string }>(
    `SELECT (
       COALESCE((SELECT sum(quantity) FROM player_inventory
                  WHERE player_id = $1 AND resource_type = $2), 0)
       + (SELECT count(*) FROM equipment_instances
           WHERE owner_player_id = $1 AND definition_id = $2
             AND location IN ('inventory', 'equipped'))
     )::text AS owned`,
    [playerId, listing.itemId]
  );
  if (BigInt(result.rows[0]?.owned ?? "0") < BigInt(listing.quantity)) {
    throw new ChatServiceError(
      "CHAT_LISTING_INVALID",
      `You don't have ${listing.quantity.toLocaleString("en-US")} ${chatTradeListingItemName(listing.itemId)} to sell.`
    );
  }
}

function channelFromRow(row: ChannelRow): ChatChannel {
  const parsed = parseChatChannelKey(row.channel_key);
  if (!parsed || parsed.type !== row.channel_type) {
    throw new ChatServiceError("CHAT_ACCESS_DENIED", "Unsupported chat channel identity");
  }
  const publicPolicies = row.channel_type === "public" &&
    row.visibility_policy === "authenticated_public_v1" &&
    row.send_access_policy === "authenticated_public_v1" &&
    row.history_retention_policy === "bounded_public_v1";
  const localPolicies = row.channel_type === "local" &&
    row.channel_key === CHAT_LOCAL_CHANNEL_KEY &&
    row.visibility_policy === "authoritative_aoi_v1" &&
    row.send_access_policy === "authenticated_local_v1" &&
    row.history_retention_policy === "live_session_v1";
  const scopedPolicies = (
    row.channel_type === "city" ||
    row.channel_type === "kingdom" ||
    row.channel_type === "party"
  ) &&
    row.visibility_policy === `current_${row.channel_type}_member_v1` &&
    row.send_access_policy === `current_${row.channel_type}_member_v1` &&
    row.history_retention_policy === "bounded_scoped_v1";
  if (
    (!publicPolicies && !localPolicies && !scopedPolicies) ||
    row.moderation_policy !== "public_chat_v1"
  ) {
    throw new ChatServiceError("CHAT_ACCESS_DENIED", "Unsupported chat channel policy");
  }
  resolveRatePolicy(row.channel_key, row.rate_limit_policy);
  const latestSequence = safeSequence(row.latest_sequence);
  if (latestSequence === null) throw new Error("Invalid chat channel sequence");
  const deletionRevision = safeSequence(row.deletion_revision ?? 0);
  if (deletionRevision === null) throw new Error("Invalid chat channel deletion revision");
  return {
    id: row.id,
    key: row.channel_key,
    type: parsed.type,
    category: parsed.category,
    displayName: row.display_name,
    visibilityPolicy: "authenticated",
    sendAccessPolicy: "authenticated",
    historyRetentionPolicy: parsed.type === "local" ? "live-session" : "durable",
    rateLimitPolicy: row.rate_limit_policy === "public_trading_v1" ? "strict-repeat" : "normal",
    moderationPolicy: "public-v1",
    active: row.active,
    latestSequence,
    deletionRevision,
    createdAt: asIso(row.created_at),
    updatedAt: asIso(row.updated_at)
  };
}

function storedRatePolicy(channel: ChatChannel): string {
  return channel.rateLimitPolicy === "strict-repeat" ? "public_trading_v1" : "public_standard_v1";
}

function isTranslationLanguage(value: string): value is ChatTranslationTargetLanguage {
  return (CHAT_TRANSLATION_TARGET_LANGUAGES as readonly string[]).includes(value);
}

function messageFromRow(row: MessageRow): ChatMessage {
  const hidden = row.message_status === "hidden";
  const deleted = row.message_status === "deleted";
  const createdAt = asIso(row.created_at);
  const tradeListing = deleted || hidden ? null : normalizeChatTradeListing(row.trade_listing);
  const partyListing = deleted || hidden ? null : normalizeChatPartyListing(row.party_listing);
  return {
    id: row.id,
    channelId: row.channel_id,
    channelKey: row.channel_key,
    sequence: requireSequence(row.sequence_number),
    senderPlayerId: row.sender_player_id,
    senderDisplayName: row.sender_display_name,
    chatCrestId: normalizeChatCrestId(row.equipped_chat_crest_id),
    body: deleted ? "[Message deleted]" : hidden ? "[Message hidden]" : row.body,
    serverCreatedAt: createdAt,
    clientRequestId: row.client_request_id,
    status: deleted ? "deleted" : "confirmed",
    moderationStatus: hidden
      ? "hidden"
      : row.moderation_status === "clear"
        ? "clear"
        : row.moderation_status === "flagged" || row.moderation_status === "actioned"
          ? "flagged"
          : "pending",
    editedAt: row.edited_at ? asIso(row.edited_at) : null,
    deletedAt: row.deleted_at ? asIso(row.deleted_at) : null,
    createdAt,
    updatedAt: asIso(row.updated_at),
    ...(tradeListing ? { tradeListing } : {}),
    ...(partyListing ? { partyListing } : {})
  };
}

function muteRecordFromRow(row: MuteRecordRow): ChatMuteRecord {
  return {
    id: row.id,
    playerId: row.player_id,
    scope: row.scope,
    channelId: row.channel_id,
    source: row.source,
    reason: row.reason,
    expiresAt: asIso(row.expires_at),
    revokedAt: row.revoked_at ? asIso(row.revoked_at) : null
  };
}

function boundedLimit(value: number | undefined, maximum: number, defaultValue: number): number {
  if (value === undefined) return Math.min(defaultValue, maximum);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new ChatServiceError("CHAT_HISTORY_CURSOR_INVALID", "Chat history limit is invalid");
  }
  return Math.min(value, maximum);
}

function configuredBound(value: number | undefined, maximum: number, label: string): number {
  const configured = value ?? maximum;
  if (!Number.isSafeInteger(configured) || configured < 1 || configured > maximum) {
    throw new Error(`${label} must be an integer between 1 and ${maximum}`);
  }
  return configured;
}

function assertCursor(value: number | undefined): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
    throw new ChatServiceError("CHAT_HISTORY_CURSOR_INVALID", "Chat history cursor is invalid");
  }
}

function assertUuid(value: string, label: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)) {
    throw new ChatServiceError("CHAT_REQUEST_INVALID", `${label} must be a UUID`);
  }
}

function safeSequence(value: string | number | undefined): number | null {
  const number = typeof value === "string" ? Number(value) : value;
  return number !== undefined && Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function requireSequence(value: string | number): number {
  const sequence = safeSequence(value);
  if (sequence === null || sequence < 1) throw new Error("Invalid chat message sequence");
  return sequence;
}

function asDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function asIso(value: Date | string): string {
  return asDate(value).toISOString();
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}

function requireRow<T>(row: T | undefined, message: string): T {
  if (!row) throw new Error(message);
  return row;
}

function stableJson(value: unknown): string {
  return JSON.stringify(canonicalJson(value));
}

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (typeof value !== "object" || value === null) return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record).sort().map((key) => [key, canonicalJson(record[key])])
  );
}

function validPinnedCategories(
  value: readonly string[] | null | undefined
): value is readonly ChatChannelCategory[] {
  return value != null && value.length <= 4 &&
    new Set(value).size === value.length &&
    value.every(isChatChannelCategory);
}
