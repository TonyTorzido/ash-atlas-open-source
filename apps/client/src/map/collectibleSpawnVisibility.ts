export const COLLECTIBLE_SPAWN_FADE_MS = 600;
export const COLLECTIBLE_SPAWN_INTERACTION_ALPHA = 0.08;

export class CollectibleFirstAppearanceTracker {
  private firstSeenAtMs = new Map<string, number>();

  observeAuthoritativeIds(ids: readonly string[], nowMs: number): void {
    const authoritativeIds = new Set(ids);
    for (const id of this.firstSeenAtMs.keys()) {
      if (!authoritativeIds.has(id)) this.firstSeenAtMs.delete(id);
    }
    for (const id of authoritativeIds) {
      if (!this.firstSeenAtMs.has(id)) this.firstSeenAtMs.set(id, nowMs);
    }
  }

  alphaFor(id: string, nowMs: number, reducedMotion: boolean): number {
    if (reducedMotion) return 1;
    const firstSeenAtMs = this.firstSeenAtMs.get(id);
    if (firstSeenAtMs === undefined) return 1;
    const progress = Math.max(
      0,
      Math.min(1, (nowMs - firstSeenAtMs) / COLLECTIBLE_SPAWN_FADE_MS)
    );
    return progress * progress * (3 - 2 * progress);
  }

  hasActiveFade(nowMs: number, reducedMotion: boolean): boolean {
    if (reducedMotion) return false;
    return [...this.firstSeenAtMs.values()].some(
      (startedAtMs) => nowMs - startedAtMs < COLLECTIBLE_SPAWN_FADE_MS
    );
  }
}
