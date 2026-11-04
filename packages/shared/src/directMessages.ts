import { z } from "zod";

export const DIRECT_MESSAGE_LIST_LIMIT = 25;
export const DIRECT_MESSAGE_HISTORY_LIMIT = 50;
export const DIRECT_MESSAGE_BODY_MAX_LENGTH = 400;
export const DIRECT_MESSAGE_SYNC_LIMIT = 100;
export const DIRECT_MESSAGE_PREVIEW_MAX_LENGTH = 120;

const MAX_SIGNED_BIGINT = 9_223_372_036_854_775_807n;
const UNSIGNED_BIGINT_PATTERN = /^(0|[1-9]\d{0,18})$/;
const POSITIVE_BIGINT_PATTERN = /^[1-9]\d{0,18}$/;

function isSignedBigint(value: string, pattern: RegExp): boolean {
  return pattern.test(value) && BigInt(value) <= MAX_SIGNED_BIGINT;
}

/** Canonical JSON representation for PostgreSQL bigint cursors and sequences. */
export const directMessageCursorSchema = z.string()
  .regex(UNSIGNED_BIGINT_PATTERN)
  .refine(
    (value) => isSignedBigint(value, UNSIGNED_BIGINT_PATTERN),
    "Direct-message cursor exceeds signed bigint range"
  );

/** Canonical JSON representation for positive PostgreSQL bigint sequences. */
export const directMessageSequenceSchema = z.string()
  .regex(POSITIVE_BIGINT_PATTERN)
  .refine(
    (value) => isSignedBigint(value, POSITIVE_BIGINT_PATTERN),
    "Direct-message sequence exceeds signed bigint range"
  );

const requestIdSchema = z.string().min(1).max(128);
const playerIdSchema = z.string().uuid();
const conversationIdSchema = z.string().uuid();
const clientMessageIdSchema = z.string().uuid();
const serverTimestampSchema = z.string().datetime({ offset: true });
const listCursorSchema = z.string().min(1).max(512).regex(/^[A-Za-z0-9_-]+$/);

export const DIRECT_MESSAGE_RESULT_CODES = [
  "ok",
  "created",
  "existing",
  "duplicate",
  "updated",
  "unchanged"
] as const;
export type DirectMessageResultCode = (typeof DIRECT_MESSAGE_RESULT_CODES)[number];

export const DIRECT_MESSAGE_ERROR_CODES = [
  "invalid_request",
  "recipient_unavailable",
  "conversation_unavailable",
  "not_allowed",
  "rate_limited",
  "message_invalid",
  "message_too_long",
  "terms_required",
  "idempotency_conflict",
  "sync_required",
  "internal_error"
] as const;
export type DirectMessageErrorCode = (typeof DIRECT_MESSAGE_ERROR_CODES)[number];

/** Fixed copy prevents transport errors from leaking player or database details. */
export const DIRECT_MESSAGE_ERROR_MESSAGES = [
  "Private messaging request was invalid.",
  "That player cannot receive messages.",
  "Conversation is unavailable.",
  "You cannot perform that action.",
  "Too many messages. Please wait and try again.",
  "Message contains unsupported text.",
  "Message is too long.",
  "Accept the current Community Rules before sending messages.",
  "That message identifier was already used.",
  "Message history must be synchronized.",
  "Private messaging is temporarily unavailable."
] as const;

export const directMessagePeerSummarySchema = z.object({
  playerId: playerIdSchema,
  displayName: z.string().min(1).max(64),
  online: z.boolean()
}).strict();
export type DirectMessagePeerSummary = z.infer<typeof directMessagePeerSummarySchema>;

export const DIRECT_MESSAGE_SERVER_STATUSES = ["sent", "delivered", "read"] as const;
export type DirectMessageServerStatus = (typeof DIRECT_MESSAGE_SERVER_STATUSES)[number];
export const DIRECT_MESSAGE_CLIENT_STATUSES = [
  "sending",
  "sent",
  "delivered",
  "read",
  "failed"
] as const;
export type DirectMessageClientStatus = (typeof DIRECT_MESSAGE_CLIENT_STATUSES)[number];

export const directMessageSchema = z.object({
  id: z.string().uuid(),
  conversationId: conversationIdSchema,
  sequence: directMessageSequenceSchema,
  senderPlayerId: playerIdSchema,
  clientMessageId: clientMessageIdSchema,
  body: z.string().min(1).max(DIRECT_MESSAGE_BODY_MAX_LENGTH),
  status: z.enum(DIRECT_MESSAGE_SERVER_STATUSES),
  serverCreatedAt: serverTimestampSchema
}).strict();
export type DirectMessage = z.infer<typeof directMessageSchema>;

export const directMessagePreviewSchema = directMessageSchema.pick({
  id: true,
  sequence: true,
  senderPlayerId: true,
  body: true,
  status: true,
  serverCreatedAt: true
}).extend({
  body: z.string().min(1).max(DIRECT_MESSAGE_PREVIEW_MAX_LENGTH)
}).strict();
export type DirectMessagePreview = z.infer<typeof directMessagePreviewSchema>;

export const directMessageConversationSummarySchema = z.object({
  id: conversationIdSchema,
  peer: directMessagePeerSummarySchema,
  canSend: z.boolean(),
  latestMessage: directMessagePreviewSchema.nullable(),
  latestSequence: directMessageCursorSchema,
  lastReadSequence: directMessageCursorSchema,
  deliveredThroughSequence: directMessageCursorSchema,
  unreadCount: z.number().int().nonnegative().safe(),
  muted: z.boolean(),
  updatedAt: serverTimestampSchema
}).strict();
export type DirectMessageConversationSummary = z.infer<typeof directMessageConversationSummarySchema>;

export const directMessagePreferencesSchema = z.object({
  soundsEnabled: z.boolean(),
  suppressBannersDuringCombat: z.boolean()
}).strict();
export type DirectMessagePreferences = z.infer<typeof directMessagePreferencesSchema>;

export const directMessageEventSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("message_created"),
    eventSequence: directMessageSequenceSchema,
    occurredAt: serverTimestampSchema,
    conversation: directMessageConversationSummarySchema,
    message: directMessageSchema
  }).strict(),
  z.object({
    kind: z.literal("message_delivered"),
    eventSequence: directMessageSequenceSchema,
    occurredAt: serverTimestampSchema,
    conversationId: conversationIdSchema,
    deliveredThroughSequence: directMessageSequenceSchema
  }).strict(),
  z.object({
    kind: z.literal("message_read"),
    eventSequence: directMessageSequenceSchema,
    occurredAt: serverTimestampSchema,
    conversationId: conversationIdSchema,
    readThroughSequence: directMessageSequenceSchema
  }).strict(),
  z.object({
    kind: z.literal("conversation_updated"),
    eventSequence: directMessageSequenceSchema,
    occurredAt: serverTimestampSchema,
    conversation: directMessageConversationSummarySchema
  }).strict(),
  z.object({
    kind: z.literal("mute_updated"),
    eventSequence: directMessageSequenceSchema,
    occurredAt: serverTimestampSchema,
    conversationId: conversationIdSchema,
    muted: z.boolean()
  }).strict(),
  z.object({
    kind: z.literal("preferences_updated"),
    eventSequence: directMessageSequenceSchema,
    occurredAt: serverTimestampSchema,
    preferences: directMessagePreferencesSchema
  }).strict(),
  z.object({
    kind: z.literal("presence_updated"),
    eventSequence: directMessageSequenceSchema,
    occurredAt: serverTimestampSchema,
    peer: directMessagePeerSummarySchema
  }).strict()
]);
export type DirectMessageEvent = z.infer<typeof directMessageEventSchema>;

export const directMessageBootstrapMessageSchema = z.object({
  type: z.literal("DM_BOOTSTRAP"),
  requestId: requestIdSchema,
  afterEventSequence: directMessageCursorSchema.optional()
}).strict();

export const directMessageListMessageSchema = z.object({
  type: z.literal("DM_LIST"),
  requestId: requestIdSchema,
  cursor: listCursorSchema.nullable().optional(),
  limit: z.number().int().min(1).max(DIRECT_MESSAGE_LIST_LIMIT).optional(),
  search: z.string().trim().max(64).optional()
}).strict();

export const directMessageOpenMessageSchema = z.object({
  type: z.literal("DM_OPEN"),
  requestId: requestIdSchema,
  peerPlayerId: playerIdSchema
}).strict();

export const directMessageHistoryMessageSchema = z.object({
  type: z.literal("DM_HISTORY"),
  requestId: requestIdSchema,
  conversationId: conversationIdSchema,
  beforeSequence: directMessageSequenceSchema.nullable().optional(),
  limit: z.number().int().min(1).max(DIRECT_MESSAGE_HISTORY_LIMIT).optional()
}).strict();

export const directMessageSendMessageSchema = z.object({
  type: z.literal("DM_SEND"),
  requestId: requestIdSchema,
  conversationId: conversationIdSchema,
  clientMessageId: clientMessageIdSchema,
  body: z.string().trim().min(1).max(DIRECT_MESSAGE_BODY_MAX_LENGTH)
}).strict();

export const directMessageReadMessageSchema = z.object({
  type: z.literal("DM_READ"),
  requestId: requestIdSchema,
  conversationId: conversationIdSchema,
  throughSequence: directMessageSequenceSchema
}).strict();

export const directMessageDeliveredMessageSchema = z.object({
  type: z.literal("DM_DELIVERED"),
  requestId: requestIdSchema,
  conversationId: conversationIdSchema,
  throughSequence: directMessageSequenceSchema
}).strict();

export const directMessageMuteMessageSchema = z.object({
  type: z.literal("DM_MUTE"),
  requestId: requestIdSchema,
  conversationId: conversationIdSchema,
  muted: z.boolean()
}).strict();

export const directMessagePreferencesMessageSchema = z.object({
  type: z.literal("DM_PREFERENCES"),
  requestId: requestIdSchema,
  preferences: directMessagePreferencesSchema
}).strict();

export const directMessageSyncMessageSchema = z.object({
  type: z.literal("DM_SYNC"),
  requestId: requestIdSchema,
  afterEventSequence: directMessageCursorSchema,
  limit: z.number().int().min(1).max(DIRECT_MESSAGE_SYNC_LIMIT).optional()
}).strict();

export const directMessageEventAckMessageSchema = z.object({
  type: z.literal("DM_EVENT_ACK"),
  requestId: requestIdSchema,
  throughEventSequence: directMessageSequenceSchema
}).strict();

export const directMessageClientMessageSchema = z.discriminatedUnion("type", [
  directMessageBootstrapMessageSchema,
  directMessageListMessageSchema,
  directMessageOpenMessageSchema,
  directMessageHistoryMessageSchema,
  directMessageSendMessageSchema,
  directMessageReadMessageSchema,
  directMessageDeliveredMessageSchema,
  directMessageMuteMessageSchema,
  directMessagePreferencesMessageSchema,
  directMessageSyncMessageSchema,
  directMessageEventAckMessageSchema
]);
export type DirectMessageClientMessage = z.infer<typeof directMessageClientMessageSchema>;

const resultCodeSchema = z.enum(DIRECT_MESSAGE_RESULT_CODES);
const eventBatchFields = {
  afterEventSequence: directMessageCursorSchema,
  latestEventSequence: directMessageCursorSchema,
  events: z.array(directMessageEventSchema).max(DIRECT_MESSAGE_SYNC_LIMIT),
  hasMore: z.boolean()
} as const;

export const directMessageServerMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("DM_BOOTSTRAP_RESULT"),
    requestId: requestIdSchema,
    result: resultCodeSchema,
    conversations: z.array(directMessageConversationSummarySchema).max(DIRECT_MESSAGE_LIST_LIMIT),
    nextCursor: listCursorSchema.nullable(),
    preferences: directMessagePreferencesSchema,
    ...eventBatchFields
  }).strict(),
  z.object({
    type: z.literal("DM_LIST_RESULT"),
    requestId: requestIdSchema,
    result: resultCodeSchema,
    conversations: z.array(directMessageConversationSummarySchema).max(DIRECT_MESSAGE_LIST_LIMIT),
    nextCursor: listCursorSchema.nullable()
  }).strict(),
  z.object({
    type: z.literal("DM_OPEN_RESULT"),
    requestId: requestIdSchema,
    result: resultCodeSchema,
    conversation: directMessageConversationSummarySchema,
    messages: z.array(directMessageSchema).max(DIRECT_MESSAGE_HISTORY_LIMIT),
    beforeSequence: directMessageSequenceSchema.nullable(),
    hasMore: z.boolean()
  }).strict(),
  z.object({
    type: z.literal("DM_HISTORY_RESULT"),
    requestId: requestIdSchema,
    result: resultCodeSchema,
    conversationId: conversationIdSchema,
    messages: z.array(directMessageSchema).max(DIRECT_MESSAGE_HISTORY_LIMIT),
    beforeSequence: directMessageSequenceSchema.nullable(),
    hasMore: z.boolean()
  }).strict(),
  z.object({
    type: z.literal("DM_SEND_RESULT"),
    requestId: requestIdSchema,
    result: resultCodeSchema,
    replayed: z.boolean(),
    message: directMessageSchema
  }).strict(),
  z.object({
    type: z.literal("DM_READ_RESULT"),
    requestId: requestIdSchema,
    result: resultCodeSchema,
    conversationId: conversationIdSchema,
    readThroughSequence: directMessageCursorSchema
  }).strict(),
  z.object({
    type: z.literal("DM_DELIVERED_RESULT"),
    requestId: requestIdSchema,
    result: resultCodeSchema,
    conversationId: conversationIdSchema,
    deliveredThroughSequence: directMessageCursorSchema
  }).strict(),
  z.object({
    type: z.literal("DM_MUTE_RESULT"),
    requestId: requestIdSchema,
    result: resultCodeSchema,
    conversationId: conversationIdSchema,
    muted: z.boolean()
  }).strict(),
  z.object({
    type: z.literal("DM_PREFERENCES_RESULT"),
    requestId: requestIdSchema,
    result: resultCodeSchema,
    preferences: directMessagePreferencesSchema
  }).strict(),
  z.object({
    type: z.literal("DM_SYNC_RESULT"),
    requestId: requestIdSchema,
    result: resultCodeSchema,
    ...eventBatchFields
  }).strict(),
  z.object({
    type: z.literal("DM_EVENT"),
    ...eventBatchFields
  }).strict(),
  z.object({
    type: z.literal("DM_EVENT_ACKED"),
    requestId: requestIdSchema,
    result: resultCodeSchema,
    acknowledgedThroughEventSequence: directMessageCursorSchema
  }).strict(),
  z.object({
    type: z.literal("DM_ERROR"),
    requestId: requestIdSchema.optional(),
    code: z.enum(DIRECT_MESSAGE_ERROR_CODES),
    message: z.enum(DIRECT_MESSAGE_ERROR_MESSAGES),
    retryable: z.boolean(),
    retryAfterMs: z.number().int().positive().safe().optional()
  }).strict()
]);
export type DirectMessageServerMessage = z.infer<typeof directMessageServerMessageSchema>;
