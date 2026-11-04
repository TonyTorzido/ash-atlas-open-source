import type { AppLogger } from "../logger.js";

export type ReconnectLeaseClaim = Readonly<{
  previousAuthSessionId: string | null;
  closingConnectionGeneration: number;
  worldPresenceEnded: boolean;
  elapsedMs: number;
}>;

type Lease = {
  accountId: string;
  playerId: string;
  authSessionId: string | null;
  connectionGeneration: number;
  startedAtMs: number;
  worldPresenceDeadlineMs: number;
  expiryDeadlineMs: number;
  worldPresenceEnded: boolean;
  presenceTimer: ReturnType<typeof setTimeout> | null;
  expiryTimer: ReturnType<typeof setTimeout> | null;
  finalizing: Promise<void> | null;
  endWorldPresence(): void | Promise<void>;
  finalize(): Promise<void>;
};

export type ReconnectLeaseCoordinatorOptions = Readonly<{
  graceMs: number;
  worldPresenceMs: number;
  logger: Pick<AppLogger, "info" | "warn">;
  now?: () => number;
}>;

export class ReconnectLeaseCoordinator {
  private readonly leasesByPlayer = new Map<string, Lease>();
  private readonly now: () => number;

  constructor(private readonly options: ReconnectLeaseCoordinatorOptions) {
    this.now = options.now ?? Date.now;
  }

  start(input: {
    accountId: string;
    playerId: string;
    authSessionId: string | null;
    connectionGeneration: number;
    endWorldPresence(): void | Promise<void>;
    finalize(): Promise<void>;
  }): void {
    const previous = this.leasesByPlayer.get(input.playerId);
    if (previous) {
      this.clearTimers(previous);
      this.ignoreRejection(this.finalizeLease(previous, "superseded"));
    }
    const startedAtMs = this.now();
    const lease: Lease = {
      ...input,
      startedAtMs,
      worldPresenceDeadlineMs:
        startedAtMs + Math.min(this.options.worldPresenceMs, this.options.graceMs),
      expiryDeadlineMs: startedAtMs + this.options.graceMs,
      worldPresenceEnded: false,
      presenceTimer: null,
      expiryTimer: null,
      finalizing: null
    };
    this.leasesByPlayer.set(input.playerId, lease);
    this.armPresenceTimer(lease);
    this.armExpiryTimer(lease);
    this.options.logger.info(
      { activeLeaseCount: this.leasesByPlayer.size, graceMs: this.options.graceMs },
      "reconnect lease started"
    );
  }

  async claim(input: {
    accountId: string;
    playerId: string;
    isAuthorized?: () => boolean;
  }): Promise<ReconnectLeaseClaim | null> {
    if (input.isAuthorized && !input.isAuthorized()) return null;
    const lease = this.leasesByPlayer.get(input.playerId);
    if (
      !lease ||
      lease.accountId !== input.accountId ||
      lease.finalizing
    ) {
      return null;
    }
    if (this.now() >= lease.expiryDeadlineMs) {
      if (input.isAuthorized && !input.isAuthorized()) return null;
      await this.finalizeLease(lease, "expired");
      return null;
    }
    if (input.isAuthorized && !input.isAuthorized()) return null;
    this.leasesByPlayer.delete(input.playerId);
    this.clearTimers(lease);
    const elapsedMs = Math.max(0, this.now() - lease.startedAtMs);
    this.options.logger.info(
      {
        activeLeaseCount: this.leasesByPlayer.size,
        elapsedMs,
        worldPresenceEnded: lease.worldPresenceEnded
      },
      "reconnect lease claimed"
    );
    return {
      previousAuthSessionId: lease.authSessionId,
      closingConnectionGeneration: lease.connectionGeneration,
      worldPresenceEnded: lease.worldPresenceEnded,
      elapsedMs
    };
  }

  async finalizeAccount(accountId: string): Promise<void> {
    await Promise.all(
      [...this.leasesByPlayer.values()]
        .filter((lease) => lease.accountId === accountId)
        .map((lease) => this.finalizeLease(lease, "logout"))
    );
  }

  async drain(): Promise<void> {
    await Promise.all(
      [...this.leasesByPlayer.values()].map((lease) =>
        this.finalizeLease(lease, "shutdown")
      )
    );
  }

  activeLeaseCount(): number {
    return this.leasesByPlayer.size;
  }

  private armPresenceTimer(lease: Lease): void {
    lease.presenceTimer = setTimeout(
      () => this.ignoreRejection(this.endPresenceAtDeadline(lease)),
      Math.max(0, lease.worldPresenceDeadlineMs - this.now())
    );
    lease.presenceTimer.unref?.();
  }

  private armExpiryTimer(lease: Lease): void {
    lease.expiryTimer = setTimeout(
      () => this.ignoreRejection(this.expireAtDeadline(lease)),
      Math.max(0, lease.expiryDeadlineMs - this.now())
    );
    lease.expiryTimer.unref?.();
  }

  private async endPresenceAtDeadline(lease: Lease): Promise<void> {
    if (this.leasesByPlayer.get(lease.playerId) !== lease || lease.finalizing) return;
    if (this.now() < lease.worldPresenceDeadlineMs) {
      this.armPresenceTimer(lease);
      return;
    }
    if (!lease.worldPresenceEnded) {
      try {
        await lease.endWorldPresence();
        lease.worldPresenceEnded = true;
      } catch (error: unknown) {
        this.options.logger.warn(
          { err: error },
          "link-dead world presence cleanup failed"
        );
        throw error;
      }
      this.options.logger.info(
        { activeLeaseCount: this.leasesByPlayer.size },
        "link-dead world presence ended"
      );
    }
  }

  private async expireAtDeadline(lease: Lease): Promise<void> {
    if (this.leasesByPlayer.get(lease.playerId) !== lease || lease.finalizing) return;
    if (this.now() < lease.expiryDeadlineMs) {
      this.armExpiryTimer(lease);
      return;
    }
    await this.finalizeLease(lease, "expired");
  }

  private finalizeLease(lease: Lease, reason: string): Promise<void> {
    if (lease.finalizing) return lease.finalizing;
    this.leasesByPlayer.delete(lease.playerId);
    this.clearTimers(lease);
    lease.finalizing = (async () => {
      if (!lease.worldPresenceEnded) {
        await lease.endWorldPresence();
        lease.worldPresenceEnded = true;
      }
      await lease.finalize();
      this.options.logger.info(
        { activeLeaseCount: this.leasesByPlayer.size, reason },
        reason === "expired"
          ? "reconnect lease expired"
          : reason === "logout"
            ? "reconnect lease finalized by logout"
            : "reconnect lease finalized"
      );
    })().catch((error: unknown) => {
      this.options.logger.warn(
        { err: error, reason },
        "reconnect lease finalization failed"
      );
      throw error;
    });
    return lease.finalizing;
  }

  private clearTimers(lease: Lease): void {
    if (lease.presenceTimer) clearTimeout(lease.presenceTimer);
    if (lease.expiryTimer) clearTimeout(lease.expiryTimer);
    lease.presenceTimer = null;
    lease.expiryTimer = null;
  }

  private ignoreRejection(operation: Promise<void>): void {
    void operation.catch(() => undefined);
  }
}
