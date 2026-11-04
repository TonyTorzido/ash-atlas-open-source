export class OverworldBossParticipantLeaseCoordinator {
  private readonly ownerByPlayerId = new Map<string, string>();
  private readonly playerIdsByLeaseId = new Map<string, Set<string>>();
  private readonly rosterMutationQueue: Array<() => void> = [];
  private rosterMutationActive = false;

  acquire(leaseId: string, participantIds: readonly string[]): boolean {
    if (!leaseId || this.playerIdsByLeaseId.has(leaseId)) {
      throw new Error(`Overworld boss participant lease id is not unique: ${leaseId}`);
    }
    const roster = new Set(participantIds);
    if (roster.size === 0) throw new Error("Overworld boss participant lease roster is empty");
    if (this.rosterMutationActive) return false;
    for (const playerId of roster) {
      if (this.ownerByPlayerId.has(playerId)) return false;
    }
    this.playerIdsByLeaseId.set(leaseId, roster);
    for (const playerId of roster) this.ownerByPlayerId.set(playerId, leaseId);
    return true;
  }

  releaseParticipant(leaseId: string, playerId: string): boolean {
    if (this.ownerByPlayerId.get(playerId) !== leaseId) return false;
    this.ownerByPlayerId.delete(playerId);
    const roster = this.playerIdsByLeaseId.get(leaseId);
    roster?.delete(playerId);
    if (roster?.size === 0) this.playerIdsByLeaseId.delete(leaseId);
    return true;
  }

  release(leaseId: string): boolean {
    const roster = this.playerIdsByLeaseId.get(leaseId);
    if (!roster) return false;
    for (const playerId of roster) {
      if (this.ownerByPlayerId.get(playerId) === leaseId) {
        this.ownerByPlayerId.delete(playerId);
      }
    }
    this.playerIdsByLeaseId.delete(leaseId);
    return true;
  }

  isReserved(playerId: string): boolean {
    return this.ownerByPlayerId.has(playerId);
  }

  runRosterMutation<T>(operation: () => T | Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const run = (): void => {
        let result: T | Promise<T>;
        try {
          result = operation();
        } catch (error) {
          reject(error);
          this.finishRosterMutation();
          return;
        }
        void Promise.resolve(result).then(
          (value) => {
            resolve(value);
            this.finishRosterMutation();
          },
          (error: unknown) => {
            reject(error);
            this.finishRosterMutation();
          }
        );
      };
      this.rosterMutationQueue.push(run);
      if (!this.rosterMutationActive) {
        this.rosterMutationActive = true;
        this.rosterMutationQueue.shift()!();
      }
    });
  }

  private finishRosterMutation(): void {
    const next = this.rosterMutationQueue.shift();
    if (next) {
      next();
      return;
    }
    this.rosterMutationActive = false;
  }
}
