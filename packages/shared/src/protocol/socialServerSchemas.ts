import { z } from "zod";

import { CHAT_TRANSLATION_TARGET_LANGUAGES } from "../chat.js";
import {
  directMessageServerMessageSchema,
  type DirectMessageServerMessage
} from "../directMessages.js";
import type { SocialServerMessage } from "./socialMessages.js";
import {
  optionalRequestIdSchema,
  requestIdSchema,
  serverFrame,
  wireBooleanSchema,
  wireNonnegativeIntegerSchema,
  wireObjectArraySchema,
  wireObjectSchema,
  wireStringSchema
} from "./serverSchemaPrimitives.js";

type SocialDomainServerMessage = SocialServerMessage | DirectMessageServerMessage;

export const socialServerMessageSchemas = {
  DM_BOOTSTRAP_RESULT: directMessageServerMessageSchema,
  DM_LIST_RESULT: directMessageServerMessageSchema,
  DM_OPEN_RESULT: directMessageServerMessageSchema,
  DM_HISTORY_RESULT: directMessageServerMessageSchema,
  DM_SEND_RESULT: directMessageServerMessageSchema,
  DM_READ_RESULT: directMessageServerMessageSchema,
  DM_DELIVERED_RESULT: directMessageServerMessageSchema,
  DM_MUTE_RESULT: directMessageServerMessageSchema,
  DM_PREFERENCES_RESULT: directMessageServerMessageSchema,
  DM_SYNC_RESULT: directMessageServerMessageSchema,
  DM_EVENT: directMessageServerMessageSchema,
  DM_EVENT_ACKED: directMessageServerMessageSchema,
  DM_ERROR: directMessageServerMessageSchema,
  SOCIAL_STATE_CHANGED: serverFrame("SOCIAL_STATE_CHANGED", { playerId: wireStringSchema, message: wireStringSchema.optional() }),
  CHAT_CHANNELS_SNAPSHOT: serverFrame("CHAT_CHANNELS_SNAPSHOT", { channels: wireObjectArraySchema, readStates: wireObjectArraySchema, previews: wireObjectArraySchema, selectedChannelKey: wireStringSchema, pinnedChannelCategories: wireStringSchema.array(), onlinePlayerCount: wireObjectSchema }),
  ONLINE_PLAYER_COUNT: serverFrame("ONLINE_PLAYER_COUNT", { onlinePlayerCount: wireObjectSchema }),
  CHAT_PINNED_CHANNELS_UPDATED: serverFrame("CHAT_PINNED_CHANNELS_UPDATED", { requestId: requestIdSchema, pinnedChannelCategories: wireStringSchema.array() }),
  CHAT_UNAVAILABLE: serverFrame("CHAT_UNAVAILABLE", { message: wireStringSchema, retryable: z.literal(true) }),
  CHAT_CHANNEL_SELECTED: serverFrame("CHAT_CHANNEL_SELECTED", { requestId: optionalRequestIdSchema, channelKey: wireStringSchema, messages: wireObjectArraySchema, latestSequence: wireNonnegativeIntegerSchema, hasOlder: wireBooleanSchema, reset: wireBooleanSchema, deletionRevision: wireNonnegativeIntegerSchema.optional(), readState: wireObjectSchema, mute: wireObjectSchema }),
  CHAT_SEND_RESULT: serverFrame("CHAT_SEND_RESULT", { requestId: requestIdSchema, replayed: wireBooleanSchema, message: wireObjectSchema }),
  CHAT_MESSAGE: serverFrame("CHAT_MESSAGE", { message: wireObjectSchema }),
  CHAT_MESSAGE_TRANSLATION: serverFrame("CHAT_MESSAGE_TRANSLATION", { channelId: wireStringSchema, channelKey: wireStringSchema, messageId: wireStringSchema, targetLanguage: z.enum(CHAT_TRANSLATION_TARGET_LANGUAGES), translatedText: wireStringSchema, sourceLanguage: wireStringSchema.optional() }),
  CHAT_MESSAGE_DELETED: serverFrame("CHAT_MESSAGE_DELETED", { requestId: optionalRequestIdSchema, message: wireObjectSchema, deletionRevision: wireNonnegativeIntegerSchema, replayed: wireBooleanSchema }),
  CHAT_HISTORY_RESULT: serverFrame("CHAT_HISTORY_RESULT", { requestId: requestIdSchema, channelKey: wireStringSchema, direction: z.enum(["older", "newer"]), messages: wireObjectArraySchema, hasMore: wireBooleanSchema, latestSequence: wireNonnegativeIntegerSchema, reset: wireBooleanSchema, maximumCatchUp: wireNonnegativeIntegerSchema, deletionRevision: wireNonnegativeIntegerSchema.optional() }),
  CHAT_PREVIEW_UPDATE: serverFrame("CHAT_PREVIEW_UPDATE", { preview: wireObjectSchema, latestSequence: wireNonnegativeIntegerSchema, unreadCount: wireNonnegativeIntegerSchema }),
  CHAT_READ_STATE: serverFrame("CHAT_READ_STATE", { requestId: optionalRequestIdSchema, readState: wireObjectSchema }),
  CHAT_MUTE_SNAPSHOT: serverFrame("CHAT_MUTE_SNAPSHOT", { channelKey: wireStringSchema, mute: wireObjectSchema }),
  CHAT_PARTY_LISTING_STATES: serverFrame("CHAT_PARTY_LISTING_STATES", { states: wireObjectArraySchema }),
  CHAT_PARTY_JOIN_REQUESTS: serverFrame("CHAT_PARTY_JOIN_REQUESTS", { requests: wireObjectArraySchema }),
  CHAT_PARTY_LISTING_NOTICE: serverFrame("CHAT_PARTY_LISTING_NOTICE", { requestId: optionalRequestIdSchema, tone: z.enum(["info", "success", "warning"]), text: wireStringSchema }),
} satisfies Record<SocialDomainServerMessage["type"], z.ZodTypeAny>;
