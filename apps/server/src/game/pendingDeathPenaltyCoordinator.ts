import type { DeathPenaltyInput } from "./progression.js";

type PendingDeathPenalty = {
  input: DeathPenaltyInput;
  attempt: (input: DeathPenaltyInput) => Promise<void>;
  inFlight: Promise<void> | null;
  completionInFlight: Promise<boolean> | null;
};

export class PendingDeathPenaltyCoordinator {
  private readonly pendingByPlayer = new Map<string, PendingDeathPenalty>();

  begin(
    playerId: string,
    input: DeathPenaltyInput,
    attempt: (input: DeathPenaltyInput) => Promise<void>
  ): Promise<void> {
    const pending: PendingDeathPenalty = { input, attempt, inFlight: null, completionInFlight: null };
    this.pendingByPlayer.set(playerId, pending);
    return this.run(pending);
  }

  ensure(
    playerId: string,
    input: DeathPenaltyInput,
    attempt: (input: DeathPenaltyInput) => Promise<void>
  ): void {
    const existing = this.pendingByPlayer.get(playerId);
    if (existing) {
      if (existing.input.operationKey !== input.operationKey) {
        throw new Error("Pending death penalty operation does not match the active death");
      }
      return;
    }
    this.pendingByPlayer.set(playerId, { input, attempt, inFlight: null, completionInFlight: null });
  }

  async settle(playerId: string): Promise<boolean> {
    const pending = this.pendingByPlayer.get(playerId);
    if (!pending) return false;
    await this.run(pending);
    return true;
  }

  async settleAndComplete(
    playerId: string,
    complete: (input: DeathPenaltyInput) => boolean | Promise<boolean>
  ): Promise<boolean> {
    const pending = this.pendingByPlayer.get(playerId);
    if (!pending) return false;
    if (pending.completionInFlight) return pending.completionInFlight;
    const completionInFlight = (async () => {
      await this.run(pending);
      if (!await complete(pending.input)) return false;
      if (this.pendingByPlayer.get(playerId) === pending) this.complete(playerId);
      return true;
    })();
    pending.completionInFlight = completionInFlight;
    try {
      return await completionInFlight;
    } finally {
      if (pending.completionInFlight === completionInFlight) {
        pending.completionInFlight = null;
      }
    }
  }

  complete(playerId: string): void {
    this.pendingByPlayer.delete(playerId);
  }

  private run(pending: PendingDeathPenalty): Promise<void> {
    if (pending.inFlight) return pending.inFlight;
    const inFlight = pending.attempt(pending.input).finally(() => {
      if (pending.inFlight === inFlight) pending.inFlight = null;
    });
    pending.inFlight = inFlight;
    return inFlight;
  }
}
