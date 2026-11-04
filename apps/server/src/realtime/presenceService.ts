import type { OnlinePlayerCount, PlayerPresenceState } from "@ash-atlas/shared";

export const PRESENCE_ONLINE_THRESHOLD_MS = 5 * 60_000;
export const PRESENCE_OFFLINE_THRESHOLD_MS = 15 * 60_000;
export const PRESENCE_AGGREGATE_BROADCAST_MS = 20_000;

export type PresenceActivitySink = {
  recordAuthoritativeLogin(
    playerId: string,
    accountId: string | null,
    displayName: string
  ): void;
  recordAuthoritativeActivity(playerId: string, accountId: string | null): void;
};

type PresenceRecord = {
  accountId: string;
  displayName: string;
  loginOrder: number;
  lastActivityAt: number;
  status: Exclude<PlayerPresenceState, "hidden">;
};

export type PresenceServiceMetrics = {
  uniquePlayersOnline: number;
  recentlyActivePlayers: number;
  offlineTransitions: number;
  presenceRecordsHeld: number;
  aggregateBroadcasts: number;
};

export class PresenceService implements PresenceActivitySink {
  private readonly records = new Map<string, PresenceRecord>();
  private readonly playerByAccount = new Map<string, string>();
  private readonly now: () => number;
  private readonly onAggregate: (snapshot: OnlinePlayerCount) => void;
  private readonly onTransition: (
    playerId: string,
    status: Exclude<PlayerPresenceState, "hidden">
  ) => void | Promise<void>;
  private aggregateRevision = 0;
  private aggregateCount = 0;
  private aggregatePlayers: OnlinePlayerCount["players"] = [];
  private aggregateDirty = false;
  private loginOrder = 0;
  private offlineTransitions = 0;
  private aggregateBroadcasts = 0;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(options: {
    now?: () => number;
    onAggregate?: (snapshot: OnlinePlayerCount) => void;
    onTransition?: (
      playerId: string,
      status: Exclude<PlayerPresenceState, "hidden">
    ) => void | Promise<void>;
  } = {}) {
    this.now = options.now ?? Date.now;
    this.onAggregate = options.onAggregate ?? (() => undefined);
    this.onTransition = options.onTransition ?? (() => undefined);
  }

  start(intervalMs = PRESENCE_AGGREGATE_BROADCAST_MS): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.sweep();
    }, intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  recordAuthoritativeLogin(
    playerId: string,
    accountId: string | null,
    displayName: string
  ): void {
    if (!playerId || !accountId) return;
    const now = this.now();
    const priorPlayerId = this.playerByAccount.get(accountId);
    if (priorPlayerId && priorPlayerId !== playerId) {
      this.records.delete(priorPlayerId);
      this.noteTransition(priorPlayerId, "offline");
    }
    const previous = this.records.get(playerId);
    this.records.set(playerId, {
      accountId,
      displayName,
      loginOrder: ++this.loginOrder,
      lastActivityAt: now,
      status: "online"
    });
    this.playerByAccount.set(accountId, playerId);
    if (!previous || previous.status !== "online") {
      this.noteTransition(playerId, "online");
    }
    this.recalculateAggregate(now);
  }

  recordAuthoritativeActivity(playerId: string, accountId: string | null): void {
    if (!playerId || !accountId) return;
    const record = this.records.get(playerId);
    if (!record || record.accountId !== accountId) return;
    const now = this.now();
    const previousStatus = statusAt(record.lastActivityAt, now);
    record.lastActivityAt = now;
    record.status = "online";
    if (previousStatus !== "online") {
      this.noteTransition(playerId, "online");
      this.recalculateAggregate(now);
    }
  }

  statusFor(playerId: string, now = this.now()): Exclude<PlayerPresenceState, "hidden"> {
    const record = this.records.get(playerId);
    return record ? statusAt(record.lastActivityAt, now) : "offline";
  }

  aggregateSnapshot(now = this.now()): OnlinePlayerCount {
    this.recalculateAggregate(now);
    return {
      count: this.aggregateCount,
      revision: this.aggregateRevision,
      observedAt: new Date(now).toISOString(),
      players: this.aggregatePlayers.map((player) => ({ ...player }))
    };
  }

  async sweep(now = this.now()): Promise<void> {
    for (const [playerId, record] of this.records) {
      const status = statusAt(record.lastActivityAt, now);
      if (status === record.status) continue;
      record.status = status;
      if (status === "offline") {
        this.offlineTransitions += 1;
        this.records.delete(playerId);
        if (this.playerByAccount.get(record.accountId) === playerId) {
          this.playerByAccount.delete(record.accountId);
        }
      }
      this.noteTransition(playerId, status);
    }
    this.recalculateAggregate(now);
    if (this.aggregateDirty) {
      this.aggregateDirty = false;
      this.aggregateBroadcasts += 1;
      this.onAggregate(this.aggregateSnapshot(now));
    }
  }

  metricsSnapshot(now = this.now()): PresenceServiceMetrics {
    let online = 0;
    let recentlyActive = 0;
    for (const record of this.records.values()) {
      const status = statusAt(record.lastActivityAt, now);
      if (status === "online") online += 1;
      else if (status === "recently_active") recentlyActive += 1;
    }
    return {
      uniquePlayersOnline: online,
      recentlyActivePlayers: recentlyActive,
      offlineTransitions: this.offlineTransitions,
      presenceRecordsHeld: this.records.size,
      aggregateBroadcasts: this.aggregateBroadcasts
    };
  }

  private recalculateAggregate(now: number): void {
    const nextPlayers = [...this.records.entries()]
      .filter(([, record]) => statusAt(record.lastActivityAt, now) === "online")
      .sort(([playerIdA, a], [playerIdB, b]) =>
        b.loginOrder - a.loginOrder ||
        compareText(a.displayName, b.displayName) ||
        compareText(playerIdA, playerIdB)
      )
      .map(([playerId, record]) => ({ playerId, displayName: record.displayName }));
    const rosterChanged = nextPlayers.length !== this.aggregatePlayers.length ||
      nextPlayers.some((player, index) => {
        const previous = this.aggregatePlayers[index];
        return previous?.playerId !== player.playerId || previous.displayName !== player.displayName;
      });
    if (!rosterChanged) return;
    this.aggregateCount = nextPlayers.length;
    this.aggregatePlayers = nextPlayers;
    this.aggregateRevision += 1;
    this.aggregateDirty = true;
  }

  private noteTransition(
    playerId: string,
    status: Exclude<PlayerPresenceState, "hidden">
  ): void {
    void Promise.resolve(this.onTransition(playerId, status)).catch(() => undefined);
  }
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function statusAt(
  lastActivityAt: number,
  now: number
): Exclude<PlayerPresenceState, "hidden"> {
  const elapsed = Math.max(0, now - lastActivityAt);
  if (elapsed < PRESENCE_ONLINE_THRESHOLD_MS) return "online";
  if (elapsed < PRESENCE_OFFLINE_THRESHOLD_MS) return "recently_active";
  return "offline";
}
