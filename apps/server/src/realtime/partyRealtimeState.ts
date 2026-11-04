import { PartyAuthorityError } from "../game/party/PartyAuthority.js";

type PartyMutationFence = Readonly<{
  promise: Promise<void>;
  release(): void;
}>;

export class PartyRealtimeState {
  private readonly activeMutations = new Map<string, PartyMutationFence>();
  private readonly completedFollowEvents = new Map<string, number>();

  async runMutation<T>(playerId: string, operation: () => Promise<T>): Promise<T> {
    if (this.activeMutations.has(playerId)) {
      throw new PartyAuthorityError("PARTY_UNAVAILABLE", "Another party request is still pending");
    }
    let release!: () => void;
    const fence: PartyMutationFence = {
      promise: new Promise<void>((resolve) => {
        release = resolve;
      }),
      release: () => release()
    };
    this.activeMutations.set(playerId, fence);
    try {
      return await operation();
    } finally {
      if (this.activeMutations.get(playerId) === fence) {
        this.activeMutations.delete(playerId);
      }
      fence.release();
    }
  }

  /**
   * Fences several players for one mutation, always in sorted player-id order, so two
   * requests over the same pair (A then B, B then A) cannot each hold one fence and fail
   * on the other: the second to arrive is refused on the first id and the first one wins.
   */
  async runMutations<T>(playerIds: readonly string[], operation: () => Promise<T>): Promise<T> {
    const ordered = [...new Set(playerIds)].sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
    const run = (index: number): Promise<T> => index >= ordered.length
      ? operation()
      : this.runMutation(ordered[index]!, () => run(index + 1));
    return run(0);
  }

  async waitForMutation(playerId: string): Promise<void> {
    while (this.activeMutations.has(playerId)) {
      await this.activeMutations.get(playerId)!.promise;
    }
  }

  claimFollowEvent(eventKey: string, now = Date.now()): boolean {
    if (this.completedFollowEvents.has(eventKey)) return false;
    this.completedFollowEvents.set(eventKey, now);
    if (this.completedFollowEvents.size > 2_000) {
      const cutoff = now - 60 * 60_000;
      for (const [key, createdAt] of this.completedFollowEvents) {
        if (createdAt < cutoff) this.completedFollowEvents.delete(key);
      }
    }
    return true;
  }

  clearPlayer(playerId: string): void {
    const fence = this.activeMutations.get(playerId);
    this.activeMutations.delete(playerId);
    fence?.release();
  }
}
