import type { TravelBlockReason } from "../game/travelEligibility.js";

export type PendingManorEntry = Readonly<{
  requestId: string;
  manorId: string;
  placementRevision: number;
  unsubscribe(): void;
}>;

type ManorJumpResult =
  | { success: true; replayed: boolean }
  | { success: false; reason: TravelBlockReason };

export class ManorRealtimeState {
  private readonly pendingEntries = new Map<string, PendingManorEntry>();
  private readonly activeJumps = new Map<string, Promise<ManorJumpResult>>();

  pending(playerId: string): PendingManorEntry | null {
    return this.pendingEntries.get(playerId) ?? null;
  }

  setPending(playerId: string, entry: PendingManorEntry): void {
    this.pendingEntries.set(playerId, entry);
  }

  takePending(playerId: string): PendingManorEntry | null {
    const entry = this.pendingEntries.get(playerId) ?? null;
    this.pendingEntries.delete(playerId);
    return entry;
  }

  pendingEntriesForManor(manorId: string): readonly Readonly<{
    playerId: string;
    entry: PendingManorEntry;
  }>[] {
    return [...this.pendingEntries]
      .filter(([, entry]) => entry.manorId === manorId)
      .map(([playerId, entry]) => ({ playerId, entry }));
  }

  activeJump(operationKey: string): Promise<ManorJumpResult> | null {
    return this.activeJumps.get(operationKey) ?? null;
  }

  trackJump(operationKey: string, operation: Promise<ManorJumpResult>): void {
    this.activeJumps.set(operationKey, operation);
    const release = (): void => {
      if (this.activeJumps.get(operationKey) === operation) {
        this.activeJumps.delete(operationKey);
      }
    };
    void operation.then(release, release);
  }
}
