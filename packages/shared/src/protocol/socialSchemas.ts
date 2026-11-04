import { z } from "zod";

import {
  CHAT_CHANNEL_CATEGORIES,
  CHAT_HISTORY_PAGE_SIZE,
  CHAT_MESSAGE_MAX_LENGTH,
  CHAT_PARTY_LISTING_DUNGEON_IDS,
  CHAT_PARTY_LISTING_KINDS,
  CHAT_TRADE_LISTING_CURRENCIES,
  CHAT_TRADE_LISTING_KINDS,
  CHAT_TRADE_LISTING_MAX_PRICE,
  CHAT_TRADE_LISTING_MAX_QUANTITY
} from "../chat.js";

const requestIdSchema = z.string().min(1).max(128);
export const chatChannelKeySchema = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[a-z][a-z0-9-]*:[A-Za-z0-9][A-Za-z0-9:_-]*$/);

export const chatSelectChannelMessageSchema = z.object({
  type: z.literal("CHAT_SELECT_CHANNEL"),
  requestId: requestIdSchema,
  channelKey: chatChannelKeySchema,
  afterSequence: z.number().int().nonnegative().optional()
}).strict();

export const requestChatBootstrapMessageSchema = z.object({
  type: z.literal("REQUEST_CHAT_BOOTSTRAP")
}).strict();

export const chatTradeListingSchema = z.object({
  kind: z.enum(CHAT_TRADE_LISTING_KINDS),
  itemId: z.string().min(1).max(128),
  quantity: z.number().int().min(1).max(CHAT_TRADE_LISTING_MAX_QUANTITY),
  price: z.number().int().min(1).max(CHAT_TRADE_LISTING_MAX_PRICE),
  currency: z.enum(CHAT_TRADE_LISTING_CURRENCIES)
}).strict();

/** Client input only: the server projects the party, class and level itself. */
export const chatPartyListingInputSchema = z.object({
  kind: z.enum(CHAT_PARTY_LISTING_KINDS),
  dungeonId: z.enum(CHAT_PARTY_LISTING_DUNGEON_IDS)
}).strict();

export const chatSendMessageSchema = z.object({
  type: z.literal("CHAT_SEND"),
  requestId: z.string().uuid(),
  channelKey: chatChannelKeySchema,
  body: z.string().max(CHAT_MESSAGE_MAX_LENGTH * 4),
  tradeListing: chatTradeListingSchema.optional(),
  partyListing: chatPartyListingInputSchema.optional()
}).strict();

export const chatDeleteMessageSchema = z.object({
  type: z.literal("CHAT_MESSAGE_DELETE"),
  requestId: requestIdSchema,
  messageId: z.string().uuid()
}).strict();

export const chatHistoryRequestMessageSchema = z.object({
  type: z.literal("CHAT_HISTORY_REQUEST"),
  requestId: requestIdSchema,
  channelKey: chatChannelKeySchema,
  direction: z.enum(["older", "newer"]),
  cursorSequence: z.number().int().nonnegative().nullable(),
  limit: z.number().int().min(1).max(CHAT_HISTORY_PAGE_SIZE).default(CHAT_HISTORY_PAGE_SIZE)
}).strict();

export const chatReadUpdateMessageSchema = z.object({
  type: z.literal("CHAT_READ_UPDATE"),
  requestId: requestIdSchema,
  channelKey: chatChannelKeySchema,
  lastReadSequence: z.number().int().nonnegative()
}).strict();

export const chatPinnedChannelsUpdateMessageSchema = z.object({
  type: z.literal("CHAT_PINNED_CHANNELS_UPDATE"),
  requestId: requestIdSchema,
  categories: z.array(z.enum(CHAT_CHANNEL_CATEGORIES)).max(4)
    .refine((categories) => new Set(categories).size === categories.length)
}).strict();
