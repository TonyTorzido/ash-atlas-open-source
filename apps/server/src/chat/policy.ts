import {
  CHAT_CATCH_UP_LIMIT,
  CHAT_HISTORY_PAGE_SIZE,
  CHAT_MESSAGE_MAX_LENGTH,
  type ChatChannelKey
} from "@ash-atlas/shared";

export const CHAT_SERVER_LIMITS = Object.freeze({
  messageMaxCharacters: CHAT_MESSAGE_MAX_LENGTH,
  historyPageSize: CHAT_HISTORY_PAGE_SIZE,
  catchUpLimit: CHAT_CATCH_UP_LIMIT,
  recentMessagesPerChannel: 100,
  recentChannelCacheEntries: 256,
  recentChannelCacheTtlMs: 10 * 60_000,
  rateLimitKeys: 50_000,
  rateLimitIdleTtlMs: 10 * 60_000,
  aggregateRateLimitKeys: 25_000,
  previewSubscriptionsPerConnection: 32,
  moderationQueueDepth: 1_024,
  moderationRetryCount: 2,
  automatedMuteMaxDurationSeconds: 60 * 60
});

export const AGGREGATE_RATE_POLICY: Readonly<Omit<ResolvedChatRatePolicy, "key">> = {
  burst: 8,
  refillIntervalMs: 1_500,
  duplicateWindowMs: 12_000
};

export type ResolvedChatRatePolicy = {
  key: "public_standard_v1" | "public_trading_v1";
  burst: number;
  refillIntervalMs: number;
  duplicateWindowMs: number;
};

export const CHAT_RATE_POLICIES: Readonly<Record<ResolvedChatRatePolicy["key"], ResolvedChatRatePolicy>> = {
  public_standard_v1: {
    key: "public_standard_v1",
    burst: 5,
    refillIntervalMs: 1_500,
    duplicateWindowMs: 12_000
  },
  public_trading_v1: {
    key: "public_trading_v1",
    burst: 3,
    refillIntervalMs: 2_500,
    duplicateWindowMs: 30_000
  }
};

export const PUBLIC_CHAT_CHANNEL_POLICIES: Readonly<Record<string, ResolvedChatRatePolicy["key"]>> = {
  "public:general": "public_standard_v1",
  "public:trading": "public_trading_v1",
  "public:hunting": "public_standard_v1"
};

export const CHAT_AUTOMATION_POLICY = Object.freeze({
  version: "public_chat_v1",
  automaticActionMinimumConfidence: 0.92,
  severeCategories: new Set(["credible_threat", "doxxing", "hate_targeted", "sexual_minors"]),
  maximumMuteDurationSeconds: CHAT_SERVER_LIMITS.automatedMuteMaxDurationSeconds
});

export function resolveRatePolicy(
  channelKey: ChatChannelKey,
  storedPolicy?: string
): ResolvedChatRatePolicy {
  const key = storedPolicy ?? PUBLIC_CHAT_CHANNEL_POLICIES[channelKey];
  if (key !== "public_standard_v1" && key !== "public_trading_v1") {
    throw new Error(`Unsupported chat rate-limit policy: ${key ?? "missing"}`);
  }
  return CHAT_RATE_POLICIES[key];
}
