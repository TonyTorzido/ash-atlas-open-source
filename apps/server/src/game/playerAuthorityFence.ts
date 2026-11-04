export class PlayerAuthorityFence {
  private readonly tails = new Map<string, Promise<void>>();

  run<T>(playerId: string, operation: () => Promise<T>): Promise<T> {
    const prior = this.tails.get(playerId) ?? Promise.resolve();
    const scheduled = prior.then(operation, operation);
    const tail = scheduled.then(
      () => undefined,
      () => undefined
    );
    this.tails.set(playerId, tail);
    void tail.finally(() => {
      if (this.tails.get(playerId) === tail) this.tails.delete(playerId);
    });
    return scheduled;
  }

  runMany<T>(playerIds: readonly string[], operation: () => Promise<T>): Promise<T> {
    const ordered = [...new Set(playerIds)].sort();
    const schedule = (index: number): Promise<T> => {
      const playerId = ordered[index];
      return playerId
        ? this.run(playerId, () => schedule(index + 1))
        : operation();
    };
    return schedule(0);
  }

  pendingPlayers(): number {
    return this.tails.size;
  }
}
