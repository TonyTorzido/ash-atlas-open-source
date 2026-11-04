export type ScheduledWorkKind = "attack" | "downed-recovery" | "status-expiry";

export type ScheduledWork = {
  dueTick: number;
  sequence: number;
  kind: ScheduledWorkKind;
  entityId: string;
  generation: number;
};

export class DueTickScheduler {
  private readonly buckets = new Map<number, ScheduledWork[]>();
  private nextSequence = 1;
  private scheduledCount = 0;

  schedule(input: Omit<ScheduledWork, "sequence">): ScheduledWork {
    const work: ScheduledWork = { ...input, sequence: this.nextSequence++ };
    const bucket = this.buckets.get(work.dueTick) ?? [];
    bucket.push(work);
    this.buckets.set(work.dueTick, bucket);
    this.scheduledCount += 1;
    return work;
  }

  takeDue(tick: number): ScheduledWork[] {
    const work = this.buckets.get(tick) ?? [];
    this.buckets.delete(tick);
    this.scheduledCount -= work.length;
    return work.sort(
      (left, right) =>
        left.sequence - right.sequence || left.entityId.localeCompare(right.entityId)
    );
  }

  get size(): number {
    return this.scheduledCount;
  }
}
