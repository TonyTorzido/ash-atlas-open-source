import type { ChatChannelKey, ChatMessage } from "@ash-atlas/shared";

import { AGGREGATE_RATE_POLICY, CHAT_SERVER_LIMITS, type ResolvedChatRatePolicy } from "./policy.js";

// Covers the largest burst plus every refill possible before the configured
// duplicate window expires (the aggregate policy peaks at 15 messages).
const MAX_RECENT_FINGERPRINTS = 16;

export type ChatRateLimitResult =
  | { allowed: true }
  | { allowed: false; reason: "rate" | "duplicate"; retryAfterMs: number };

type RateBucket = {
  tokens: number;
  refilledAt: number;
  touchedAt: number;
  fingerprints: RateFingerprint[];
};

type RateFingerprint = {
  value: string;
  recordedAt: number;
  state: "pending" | "committed" | "rolled-back";
};

export type ChatRateLimitReservation = {
  commit(): void;
  rollback(): void;
};

export type ChatRateLimitReservationResult =
  | { allowed: true; reservation: ChatRateLimitReservation }
  | { allowed: false; reason: "rate" | "duplicate"; retryAfterMs: number };

export class BoundedChatRateLimiter {
  private readonly buckets = new Map<string, RateBucket>();
  private readonly aggregateBuckets = new Map<string, RateBucket>();
  private lastSweepAt = 0;

  constructor(
    private readonly maximumKeys: number = CHAT_SERVER_LIMITS.rateLimitKeys,
    private readonly idleTtlMs: number = CHAT_SERVER_LIMITS.rateLimitIdleTtlMs,
    private readonly sweepIntervalMs: number = 30_000,
    private readonly aggregateMaximumKeys: number = CHAT_SERVER_LIMITS.aggregateRateLimitKeys
  ) {
    if (maximumKeys < 1 || idleTtlMs < 1 || sweepIntervalMs < 1 || aggregateMaximumKeys < 1) {
      throw new Error("Chat rate limiter bounds must be positive");
    }
  }

  consume(
    playerId: string,
    channelKey: ChatChannelKey,
    body: string,
    policy: ResolvedChatRatePolicy,
    now = Date.now()
  ): ChatRateLimitResult {
    const result = this.reserve(playerId, channelKey, body, policy, now);
    if (!result.allowed) return result;
    result.reservation.commit();
    return { allowed: true };
  }

  reserve(
    playerId: string,
    channelKey: ChatChannelKey,
    body: string,
    policy: ResolvedChatRatePolicy,
    now = Date.now()
  ): ChatRateLimitReservationResult {
    this.sweepIfDue(now);
    const fingerprint = chatSpamFingerprint(body);

    const aggKey = playerId;
    let aggBucket = this.aggregateBuckets.get(aggKey);
    if (!aggBucket) {
      if (this.aggregateBuckets.size >= this.aggregateMaximumKeys) this.evictOldestAggregate();
      aggBucket = {
        tokens: AGGREGATE_RATE_POLICY.burst,
        refilledAt: now,
        touchedAt: now,
        fingerprints: []
      };
      this.aggregateBuckets.set(aggKey, aggBucket);
    }

    const aggElapsed = Math.max(0, now - aggBucket.refilledAt);
    aggBucket.tokens = Math.min(AGGREGATE_RATE_POLICY.burst, aggBucket.tokens + aggElapsed / AGGREGATE_RATE_POLICY.refillIntervalMs);
    aggBucket.refilledAt = now;
    aggBucket.touchedAt = now;

    const aggregateDupWait = duplicateWait(
      aggBucket.fingerprints,
      fingerprint,
      AGGREGATE_RATE_POLICY.duplicateWindowMs,
      now
    );

    const perChannelKey = `${playerId}\u001f${channelKey}`;
    let bucket = this.buckets.get(perChannelKey);
    if (!bucket) {
      if (this.buckets.size >= this.maximumKeys) this.evictOldest();
      bucket = {
        tokens: policy.burst,
        refilledAt: now,
        touchedAt: now,
        fingerprints: []
      };
      this.buckets.set(perChannelKey, bucket);
    }

    const elapsed = Math.max(0, now - bucket.refilledAt);
    bucket.tokens = Math.min(policy.burst, bucket.tokens + elapsed / policy.refillIntervalMs);
    bucket.refilledAt = now;
    bucket.touchedAt = now;

    const channelDupWait = duplicateWait(
      bucket.fingerprints,
      fingerprint,
      policy.duplicateWindowMs,
      now
    );

    const aggregateRateWait =
      aggBucket.tokens < 1
        ? Math.max(1, Math.ceil((1 - aggBucket.tokens) * AGGREGATE_RATE_POLICY.refillIntervalMs))
        : 0;

    const channelRateWait =
      bucket.tokens < 1
        ? Math.max(1, Math.ceil((1 - bucket.tokens) * policy.refillIntervalMs))
        : 0;

    const duplicateBlocked = aggregateDupWait > 0 || channelDupWait > 0;
    const rateBlocked = aggregateRateWait > 0 || channelRateWait > 0;

    if (duplicateBlocked || rateBlocked) {
      return {
        allowed: false,
        reason: duplicateBlocked ? "duplicate" : "rate",
        retryAfterMs: Math.max(
          aggregateDupWait,
          channelDupWait,
          aggregateRateWait,
          channelRateWait
        )
      };
    }

    aggBucket.tokens -= 1;
    bucket.tokens -= 1;

    const aggEntry: RateFingerprint = {
      value: fingerprint,
      recordedAt: now,
      state: "pending"
    };
    aggBucket.fingerprints.push(aggEntry);

    const entry: RateFingerprint = {
      value: fingerprint,
      recordedAt: now,
      state: "pending"
    };
    bucket.fingerprints.push(entry);

    const bucketRef = bucket;
    const aggBucketRef = aggBucket;
    let settled = false;
    return {
      allowed: true,
      reservation: {
        commit: () => {
          if (settled) return;
          settled = true;
          entry.state = "committed";
          aggEntry.state = "committed";
          trimFingerprints(bucketRef.fingerprints, now, policy.duplicateWindowMs);
          trimFingerprints(
            aggBucketRef.fingerprints,
            now,
            AGGREGATE_RATE_POLICY.duplicateWindowMs
          );
        },
        rollback: () => {
          if (settled) return;
          settled = true;
          entry.state = "rolled-back";
          aggEntry.state = "rolled-back";
          bucketRef.tokens = Math.min(policy.burst, bucketRef.tokens + 1);
          aggBucketRef.tokens = Math.min(AGGREGATE_RATE_POLICY.burst, aggBucketRef.tokens + 1);
          removeFingerprint(bucketRef.fingerprints, entry);
          removeFingerprint(aggBucketRef.fingerprints, aggEntry);
        }
      }
    };
  }

  prune(now = Date.now()): void {
    const cutoff = now - this.idleTtlMs;
    for (const [key, bucket] of this.buckets) {
      if (bucket.touchedAt <= cutoff) this.buckets.delete(key);
    }
    for (const [key, bucket] of this.aggregateBuckets) {
      if (bucket.touchedAt <= cutoff) this.aggregateBuckets.delete(key);
    }
    while (this.buckets.size > this.maximumKeys) this.evictOldest();
    while (this.aggregateBuckets.size > this.aggregateMaximumKeys) this.evictOldestAggregate();
    this.lastSweepAt = now;
  }

  get size(): number {
    return this.buckets.size + this.aggregateBuckets.size;
  }

  private sweepIfDue(now: number): void {
    const total = this.buckets.size + this.aggregateBuckets.size;
    if (now - this.lastSweepAt >= this.sweepIntervalMs || total >= this.maximumKeys + this.aggregateMaximumKeys) {
      this.prune(now);
    }
  }

  private evictOldest(): void {
    let oldestKey: string | null = null;
    let oldestAt = Number.POSITIVE_INFINITY;
    for (const [key, bucket] of this.buckets) {
      if (bucket.touchedAt < oldestAt) {
        oldestAt = bucket.touchedAt;
        oldestKey = key;
      }
    }
    if (oldestKey !== null) this.buckets.delete(oldestKey);
  }

  private evictOldestAggregate(): void {
    let oldestKey: string | null = null;
    let oldestAt = Number.POSITIVE_INFINITY;
    for (const [key, bucket] of this.aggregateBuckets) {
      if (bucket.touchedAt < oldestAt) {
        oldestAt = bucket.touchedAt;
        oldestKey = key;
      }
    }
    if (oldestKey !== null) this.aggregateBuckets.delete(oldestKey);
  }
}

export function chatSpamFingerprint(body: string): string {
  return body
    .normalize("NFKC")
    .replace(/\p{Default_Ignorable_Code_Point}/gu, "")
    .replace(/\s+/gu, " ")
    .trim()
    .toLocaleLowerCase("en-US");
}

function duplicateWait(
  fingerprints: RateFingerprint[],
  fingerprint: string,
  windowMs: number,
  now: number
): number {
  trimFingerprints(fingerprints, now, windowMs);
  let wait = 0;
  for (const entry of fingerprints) {
    if (entry.state === "rolled-back" || entry.value !== fingerprint) continue;
    wait = Math.max(wait, windowMs - (now - entry.recordedAt));
  }
  return wait > 0 ? Math.max(1, wait) : 0;
}

function trimFingerprints(
  fingerprints: RateFingerprint[],
  now: number,
  windowMs: number
): void {
  for (let index = fingerprints.length - 1; index >= 0; index -= 1) {
    const entry = fingerprints[index]!;
    if (entry.state === "rolled-back" || now - entry.recordedAt >= windowMs) {
      fingerprints.splice(index, 1);
    }
  }
  while (fingerprints.length > MAX_RECENT_FINGERPRINTS) fingerprints.shift();
}

function removeFingerprint(fingerprints: RateFingerprint[], target: RateFingerprint): void {
  const index = fingerprints.indexOf(target);
  if (index >= 0) fingerprints.splice(index, 1);
}

type RecentChannelEntry = {
  messages: ChatMessage[];
  touchedAt: number;
};

export class BoundedRecentChatCache {
  private readonly channels = new Map<ChatChannelKey, RecentChannelEntry>();

  constructor(
    private readonly maximumMessagesPerChannel: number = CHAT_SERVER_LIMITS.recentMessagesPerChannel,
    private readonly maximumChannels: number = CHAT_SERVER_LIMITS.recentChannelCacheEntries,
    private readonly idleTtlMs: number = CHAT_SERVER_LIMITS.recentChannelCacheTtlMs
  ) {
    if (maximumMessagesPerChannel < 1 || maximumChannels < 1 || idleTtlMs < 1) {
      throw new Error("Recent chat cache bounds must be positive");
    }
  }

  append(message: ChatMessage, now = Date.now()): void {
    let entry = this.channels.get(message.channelKey);
    if (!entry) {
      this.prune(now);
      if (this.channels.size >= this.maximumChannels) this.evictOldestChannel();
      entry = { messages: [], touchedAt: now };
      this.channels.set(message.channelKey, entry);
    }
    entry.touchedAt = now;
    const duplicateIndex = entry.messages.findIndex(
      (candidate) => candidate.id === message.id || candidate.sequence === message.sequence
    );
    if (duplicateIndex >= 0) entry.messages.splice(duplicateIndex, 1);
    entry.messages.push(message);
    entry.messages.sort((left, right) => left.sequence - right.sequence);
    if (entry.messages.length > this.maximumMessagesPerChannel) {
      entry.messages.splice(0, entry.messages.length - this.maximumMessagesPerChannel);
    }
  }

  recent(channelKey: ChatChannelKey, limit = this.maximumMessagesPerChannel, now = Date.now()): ChatMessage[] {
    const entry = this.channels.get(channelKey);
    if (!entry || entry.touchedAt <= now - this.idleTtlMs) {
      this.channels.delete(channelKey);
      return [];
    }
    entry.touchedAt = now;
    const boundedLimit = Math.max(0, Math.min(limit, this.maximumMessagesPerChannel));
    return entry.messages.slice(-boundedLimit);
  }

  prune(now = Date.now()): void {
    const cutoff = now - this.idleTtlMs;
    for (const [key, entry] of this.channels) {
      if (entry.touchedAt <= cutoff) this.channels.delete(key);
    }
    while (this.channels.size > this.maximumChannels) this.evictOldestChannel();
  }

  metrics(): { channels: number; messages: number; maximumChannelSize: number } {
    const sizes = [...this.channels.values()].map((entry) => entry.messages.length);
    return {
      channels: this.channels.size,
      messages: sizes.reduce((total, size) => total + size, 0),
      maximumChannelSize: Math.max(0, ...sizes)
    };
  }

  private evictOldestChannel(): void {
    let oldestKey: ChatChannelKey | null = null;
    let oldestAt = Number.POSITIVE_INFINITY;
    for (const [key, entry] of this.channels) {
      if (entry.touchedAt < oldestAt) {
        oldestAt = entry.touchedAt;
        oldestKey = key;
      }
    }
    if (oldestKey !== null) this.channels.delete(oldestKey);
  }
}

type ConnectionSubscriptions = {
  activeChannel: ChatChannelKey | null;
  previewChannels: Set<ChatChannelKey>;
};

export class ChatSubscriptionRegistry {
  private readonly byConnection = new Map<string, ConnectionSubscriptions>();
  private readonly activeByChannel = new Map<ChatChannelKey, Set<string>>();
  private readonly previewsByChannel = new Map<ChatChannelKey, Set<string>>();

  constructor(
    private readonly maximumConnections: number = 50_000,
    private readonly maximumPreviewChannels: number = CHAT_SERVER_LIMITS.previewSubscriptionsPerConnection
  ) {}

  selectActive(connectionId: string, channelKey: ChatChannelKey | null): void {
    const subscriptions = this.ensureConnection(connectionId);
    if (subscriptions.activeChannel === channelKey) return;
    if (subscriptions.activeChannel !== null) {
      removeFromIndex(this.activeByChannel, subscriptions.activeChannel, connectionId);
    }
    subscriptions.activeChannel = channelKey;
    if (channelKey !== null) addToIndex(this.activeByChannel, channelKey, connectionId);
  }

  replacePreviews(connectionId: string, channelKeys: Iterable<ChatChannelKey>): void {
    const subscriptions = this.ensureConnection(connectionId);
    const next = new Set(channelKeys);
    if (next.size > this.maximumPreviewChannels) {
      throw new Error("Too many chat preview subscriptions");
    }
    for (const channelKey of subscriptions.previewChannels) {
      if (!next.has(channelKey)) removeFromIndex(this.previewsByChannel, channelKey, connectionId);
    }
    for (const channelKey of next) {
      if (!subscriptions.previewChannels.has(channelKey)) {
        addToIndex(this.previewsByChannel, channelKey, connectionId);
      }
    }
    subscriptions.previewChannels = next;
  }

  removeConnection(connectionId: string): boolean {
    const subscriptions = this.byConnection.get(connectionId);
    if (!subscriptions) return false;
    if (subscriptions.activeChannel !== null) {
      removeFromIndex(this.activeByChannel, subscriptions.activeChannel, connectionId);
    }
    for (const channelKey of subscriptions.previewChannels) {
      removeFromIndex(this.previewsByChannel, channelKey, connectionId);
    }
    this.byConnection.delete(connectionId);
    return true;
  }

  activeConnectionIds(channelKey: ChatChannelKey): string[] {
    return [...(this.activeByChannel.get(channelKey) ?? [])];
  }

  previewConnectionIds(channelKey: ChatChannelKey): string[] {
    return [...(this.previewsByChannel.get(channelKey) ?? [])];
  }

  activeChannelForConnection(connectionId: string): ChatChannelKey | null {
    return this.byConnection.get(connectionId)?.activeChannel ?? null;
  }

  metrics(): { connections: number; activeSubscriptions: number; previewSubscriptions: number } {
    return {
      connections: this.byConnection.size,
      activeSubscriptions: sumIndex(this.activeByChannel),
      previewSubscriptions: sumIndex(this.previewsByChannel)
    };
  }

  private ensureConnection(connectionId: string): ConnectionSubscriptions {
    let subscriptions = this.byConnection.get(connectionId);
    if (!subscriptions) {
      if (this.byConnection.size >= this.maximumConnections) {
        throw new Error("Chat subscription registry is full");
      }
      subscriptions = { activeChannel: null, previewChannels: new Set() };
      this.byConnection.set(connectionId, subscriptions);
    }
    return subscriptions;
  }
}

function addToIndex(index: Map<string, Set<string>>, key: string, value: string): void {
  const values = index.get(key) ?? new Set<string>();
  values.add(value);
  index.set(key, values);
}

function removeFromIndex(index: Map<string, Set<string>>, key: string, value: string): void {
  const values = index.get(key);
  values?.delete(value);
  if (values?.size === 0) index.delete(key);
}

function sumIndex(index: Map<string, Set<string>>): number {
  let total = 0;
  for (const values of index.values()) total += values.size;
  return total;
}
