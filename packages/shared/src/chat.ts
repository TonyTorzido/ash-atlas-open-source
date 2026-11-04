import type { ChatCrestId } from "./chatCrests.js";
import { dungeonDefinition, effectiveDungeonMinimumLevel } from "./dungeonCatalog.js";
import { INVENTORY_CATALOG } from "./inventoryCatalog.js";
import { SPECIALIZATION_IDS, type SpecializationId } from "./skillSystemV3.js";

export const CHAT_PUBLIC_CHANNEL_KEYS = [
  "public:general",
  "public:trading",
  "public:hunting"
] as const;

export const CHAT_LOCAL_CHANNEL_KEY = "local:map" as const;

export const CHAT_CHANNEL_CATEGORIES = [
  "general",
  "trading",
  "hunting",
  "local",
  "city",
  "kingdom",
  "party"
] as const;

export const CHAT_DEFAULT_PINNED_CATEGORIES = [
  "general",
  "trading",
  "hunting",
  "local"
] as const;

export const CHAT_CHANNEL_KEYS = [
  ...CHAT_PUBLIC_CHANNEL_KEYS,
  CHAT_LOCAL_CHANNEL_KEY
] as const;

export type PublicChatChannelKey = (typeof CHAT_PUBLIC_CHANNEL_KEYS)[number];
export type ChatChannelKey = string;
export type ChatChannelCategory = (typeof CHAT_CHANNEL_CATEGORIES)[number];
export type ChatChannelType = "public" | "local" | "city" | "kingdom" | "party";

export type ParsedChatChannelKey = {
  key: ChatChannelKey;
  category: ChatChannelCategory;
  type: ChatChannelType;
  scopeId: string | null;
};

export const CHAT_MESSAGE_MAX_LENGTH = 400;
/** Target languages exposed by the chat translation control and accepted by the server. */
export const CHAT_TRANSLATION_TARGET_LANGUAGES = [
  "en",
  "es",
  "fr",
  "de",
  "pt",
  "ja"
] as const;
export type ChatTranslationTargetLanguage = (typeof CHAT_TRANSLATION_TARGET_LANGUAGES)[number];
export type ChatMessageTranslation = {
  translatedText: string;
  sourceLanguage?: string;
};
/** Cached shared translations keyed by target language; absent when none exist. */
export type ChatMessageTranslations = Partial<
  Record<ChatTranslationTargetLanguage, ChatMessageTranslation>
>;
export const CHAT_HISTORY_PAGE_SIZE = 50;
export const CHAT_CATCH_UP_LIMIT = 100;
export const CHAT_ACTIVE_MESSAGE_LIMIT = 200;
export const CHAT_INACTIVE_MESSAGE_LIMIT = 10;
export const CHAT_PENDING_MESSAGE_LIMIT = 20;
export const CHAT_FAILED_MESSAGE_LIMIT = 20;
export const CHAT_DEDUPE_LIMIT = 1_000;
export const CHAT_PREVIEW_MAX_LENGTH = 120;

export type ChatRateLimitPolicy = "normal" | "strict-repeat";

export type ChatChannel = {
  id: string;
  key: ChatChannelKey;
  type: ChatChannelType;
  category: ChatChannelCategory;
  displayName: string;
  visibilityPolicy: "authenticated";
  sendAccessPolicy: "authenticated";
  historyRetentionPolicy: "durable" | "live-session";
  rateLimitPolicy: ChatRateLimitPolicy;
  moderationPolicy: "public-v1";
  active: boolean;
  latestSequence: number;
  /** Monotonic soft-delete revision used to detect deletion gaps during bootstrap. */
  deletionRevision?: number;
  createdAt: string;
  updatedAt: string;
};

/** Buy/Sell listing cards are allowed only in the public Trade room. */
export const CHAT_TRADE_CHANNEL_KEY = "public:trading" as const;
export const CHAT_TRADE_LISTING_KINDS = ["buy", "sell"] as const;
export const CHAT_TRADE_LISTING_CURRENCIES = ["gold", "glimmer"] as const;
export const CHAT_TRADE_LISTING_MAX_QUANTITY = 1_000_000;
export const CHAT_TRADE_LISTING_MAX_PRICE = 1_000_000_000;

export type ChatTradeListingKind = (typeof CHAT_TRADE_LISTING_KINDS)[number];
export type ChatTradeListingCurrency = (typeof CHAT_TRADE_LISTING_CURRENCIES)[number];

/** Structured Buy/Sell post. The message body keeps a readable text fallback for older clients. */
export type ChatTradeListing = {
  kind: ChatTradeListingKind;
  itemId: string;
  quantity: number;
  /** Price per unit, in the chosen currency. */
  price: number;
  currency: ChatTradeListingCurrency;
};

/** Normalizes an untrusted listing; null when any field is outside the allowed shape. */
export function normalizeChatTradeListing(value: unknown): ChatTradeListing | null {
  if (!value || typeof value !== "object") return null;
  const input = value as Record<string, unknown>;
  const { kind, itemId, quantity, price, currency } = input;
  if (!(CHAT_TRADE_LISTING_KINDS as readonly unknown[]).includes(kind)) return null;
  if (!(CHAT_TRADE_LISTING_CURRENCIES as readonly unknown[]).includes(currency)) return null;
  if (typeof itemId !== "string" || !Object.hasOwn(INVENTORY_CATALOG, itemId)) return null;
  if (!Number.isSafeInteger(quantity) || (quantity as number) < 1 ||
    (quantity as number) > CHAT_TRADE_LISTING_MAX_QUANTITY) return null;
  if (!Number.isSafeInteger(price) || (price as number) < 1 ||
    (price as number) > CHAT_TRADE_LISTING_MAX_PRICE) return null;
  return {
    kind: kind as ChatTradeListingKind,
    itemId,
    quantity: quantity as number,
    price: price as number,
    currency: currency as ChatTradeListingCurrency
  };
}

export function chatTradeListingItemName(itemId: string): string {
  return INVENTORY_CATALOG[itemId]?.displayName ?? itemId;
}

/** Readable body stored with a listing, e.g. "SELLING Stone ×5 · 100 gold each". */
export function chatTradeListingFallbackBody(listing: ChatTradeListing): string {
  const verb = listing.kind === "sell" ? "SELLING" : "BUYING";
  const currency = listing.currency === "gold" ? "gold" : "Glimmer";
  return `${verb} ${chatTradeListingItemName(listing.itemId)} ×${listing.quantity.toLocaleString("en-US")} · ` +
    `${listing.price.toLocaleString("en-US")} ${currency} each`;
}

/** Party-finder cards are allowed only in the public Hunting room. */
export const CHAT_HUNTING_CHANNEL_KEY = "public:hunting" as const;
export const CHAT_PARTY_LISTING_KINDS = ["leader", "seeker"] as const;
/** A listed party is full at this size (the party itself may hold more through ordinary invites). */
export const CHAT_PARTY_LISTING_TARGET_SIZE = 4;
export const CHAT_PARTY_LISTING_TTL_MS = 15 * 60_000;
/** Player-facing dungeons offered by the party finder, in level order. */
export const CHAT_PARTY_LISTING_DUNGEON_IDS = [
  "ashen_crypt",
  "fangrock_cavern",
  "the_eyrie",
  "blightwood_grove",
  "still_hand_monastery",
  "drowned_city",
  "golem_forge",
  "fallen_prison"
] as const;

export type ChatPartyListingKind = (typeof CHAT_PARTY_LISTING_KINDS)[number];
export type ChatPartyListingDungeonId = (typeof CHAT_PARTY_LISTING_DUNGEON_IDS)[number];

/** What the client posts; everything else on a listing is projected by the server. */
export type ChatPartyListingInput = {
  kind: ChatPartyListingKind;
  dungeonId: ChatPartyListingDungeonId;
};

/** Stored Hunting card. Leader cards carry the party; seeker cards carry the poster's class and level. */
export type ChatPartyListing = ChatPartyListingInput & {
  partyId?: string;
  /** The poster's active class (specialization) when they have one. */
  classId?: SpecializationId;
  level?: number;
  /** Set when the poster closes the card early. */
  cancelled?: boolean;
};

export type ChatPartyListingStatus = "open" | "full" | "closed";

/** Live projection of a Hunting card, derived from party state and expiry. */
export type ChatPartyListingState = {
  messageId: string;
  status: ChatPartyListingStatus;
  /** Leader cards: current party size. Seeker cards: 0. */
  memberCount: number;
};

/** A pending request to join a listed party, shown to the leader in party chat. */
export type ChatPartyJoinRequest = {
  joinRequestId: string;
  listingMessageId: string;
  dungeonId: ChatPartyListingDungeonId;
  requesterPlayerId: string;
  requesterName: string;
  classId: SpecializationId | null;
  level: number;
  createdAt: string;
};

export function isChatPartyListingDungeonId(value: unknown): value is ChatPartyListingDungeonId {
  return (CHAT_PARTY_LISTING_DUNGEON_IDS as readonly unknown[]).includes(value);
}

export function chatPartyListingDungeonName(dungeonId: string): string {
  return dungeonDefinition(dungeonId)?.name ?? dungeonId;
}

/** The level actually required to enter the dungeon (1 when it has no gate). */
export function chatPartyListingRequiredLevel(dungeonId: string): number {
  return effectiveDungeonMinimumLevel(dungeonDefinition(dungeonId)?.access) ?? 1;
}

/** Normalizes an untrusted or stored listing; null when any field is outside the allowed shape. */
export function normalizeChatPartyListing(value: unknown): ChatPartyListing | null {
  if (!value || typeof value !== "object") return null;
  const { kind, dungeonId, partyId, classId, level, cancelled } = value as Record<string, unknown>;
  if (!(CHAT_PARTY_LISTING_KINDS as readonly unknown[]).includes(kind)) return null;
  if (!isChatPartyListingDungeonId(dungeonId)) return null;
  const listing: ChatPartyListing = { kind: kind as ChatPartyListingKind, dungeonId };
  if (typeof partyId === "string" && partyId.length > 0 && partyId.length <= 200) listing.partyId = partyId;
  if ((SPECIALIZATION_IDS as readonly unknown[]).includes(classId)) listing.classId = classId as SpecializationId;
  if (Number.isSafeInteger(level) && (level as number) >= 1 && (level as number) <= 1_000) {
    listing.level = level as number;
  }
  if (cancelled === true) listing.cancelled = true;
  return listing;
}

/** Readable body stored with a Hunting card, e.g. "HAVE Fangrock Cavern · Looking for party". */
export function chatPartyListingFallbackBody(listing: ChatPartyListing): string {
  const dungeon = chatPartyListingDungeonName(listing.dungeonId);
  if (listing.kind === "leader") return `HAVE ${dungeon} · Looking for party`;
  const who = listing.level ? ` · Level ${listing.level}${listing.classId ? ` ${listing.classId}` : ""}` : "";
  return `LOOKING FOR ${dungeon}${who}`;
}

/** Expiry alone; the server's live state adds Party full and early closes. */
export function chatPartyListingExpired(createdAt: string, now = Date.now()): boolean {
  const created = Date.parse(createdAt);
  return !Number.isFinite(created) || now - created >= CHAT_PARTY_LISTING_TTL_MS;
}

export type ChatMessageStatus = "confirmed" | "deleted";
export type ChatModerationStatus = "pending" | "clear" | "flagged" | "hidden";

export type ChatMessage = {
  id: string;
  channelId: string;
  channelKey: ChatChannelKey;
  sequence: number;
  senderPlayerId: string;
  senderDisplayName: string;
  /** Server-projected equipped Chat Crest; absent only for legacy clients/fixtures. */
  chatCrestId?: ChatCrestId;
  body: string;
  serverCreatedAt: string;
  clientRequestId: string;
  status: ChatMessageStatus;
  moderationStatus: ChatModerationStatus;
  editedAt: string | null;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** Existing shared translations for visible messages; optional for backward compatibility. */
  translations?: ChatMessageTranslations;
  /** Trade-room Buy/Sell card; absent on ordinary, deleted, and hidden messages. */
  tradeListing?: ChatTradeListing;
  /** Hunting-room party-finder card; absent on ordinary, deleted, and hidden messages. */
  partyListing?: ChatPartyListing;
};

export type ChatMessagePreview = Pick<
  ChatMessage,
  "id" | "channelKey" | "sequence" | "senderPlayerId" | "senderDisplayName" | "chatCrestId" | "body" | "serverCreatedAt"
>;

export type ChatReadState = {
  channelKey: ChatChannelKey;
  lastReadSequence: number;
  latestSequence: number;
  unreadCount: number;
  updatedAt: string;
};

export type ChatMuteSnapshot = {
  muted: boolean;
  channelKey: ChatChannelKey | null;
  scope: "global" | "channel" | null;
  reason: string | null;
  expiresAt: string | null;
};

export type ChatConstructionState = "pending" | "confirmed" | "failed";

export type PendingChatMessage = {
  localId: string;
  requestId: string;
  channelKey: ChatChannelKey;
  body: string;
  senderPlayerId: string;
  senderDisplayName: string;
  clientCreatedAt: string;
  state: ChatConstructionState;
  errorCode: string | null;
  retryAfterMs: number | null;
  tradeListing?: ChatTradeListing;
  partyListing?: ChatPartyListing;
};

export function isPublicChatChannelKey(value: string): value is PublicChatChannelKey {
  return (CHAT_PUBLIC_CHANNEL_KEYS as readonly string[]).includes(value);
}

export function parseChatChannelKey(value: string): ParsedChatChannelKey | null {
  switch (value) {
    case "public:general":
      return { key: value, category: "general", type: "public", scopeId: null };
    case "public:trading":
      return { key: value, category: "trading", type: "public", scopeId: null };
    case "public:hunting":
      return { key: value, category: "hunting", type: "public", scopeId: null };
    case CHAT_LOCAL_CHANNEL_KEY:
      return { key: value, category: "local", type: "local", scopeId: null };
    default: {
      const match = /^(city|kingdom|party):([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/iu.exec(value);
      if (!match) return null;
      const type = match[1]!.toLowerCase() as "city" | "kingdom" | "party";
      return {
        key: `${type}:${match[2]!.toLowerCase()}`,
        category: type,
        type,
        scopeId: match[2]!.toLowerCase()
      };
    }
  }
}

export function chatChannelCategory(value: string): ChatChannelCategory | null {
  return parseChatChannelKey(value)?.category ?? null;
}

export function isScopedChatChannelKey(
  value: string
): value is `city:${string}` | `kingdom:${string}` | `party:${string}` {
  const parsed = parseChatChannelKey(value);
  return parsed?.type === "city" || parsed?.type === "kingdom" || parsed?.type === "party";
}

export function scopedChatChannelKey(
  type: "city" | "kingdom" | "party",
  scopeId: string
): ChatChannelKey | null {
  return parseChatChannelKey(`${type}:${scopeId}`)?.key ?? null;
}

export function isChatChannelCategory(value: string): value is ChatChannelCategory {
  return (CHAT_CHANNEL_CATEGORIES as readonly string[]).includes(value);
}

export function isLiveSessionChatChannel(
  channel: Pick<ChatChannel, "historyRetentionPolicy">
): boolean {
  return channel.historyRetentionPolicy === "live-session";
}

export function boundedChatPreview(body: string): string {
  const compact = body.replace(/\s+/g, " ").trim();
  const characters = Array.from(compact);
  return characters.length <= CHAT_PREVIEW_MAX_LENGTH
    ? compact
    : `${characters.slice(0, CHAT_PREVIEW_MAX_LENGTH - 1).join("")}…`;
}
