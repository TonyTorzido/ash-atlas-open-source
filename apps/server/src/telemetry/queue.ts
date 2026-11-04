export type TelemetryPriority = "critical" | "important" | "routine";

export type TelemetryTable =
  | "server_samples"
  | "world_samples"
  | "gameplay_events"
  | "player_snapshots"
  | "player_inventory_snapshots"
  | "client_samples"
  | "session_summaries";

export type TelemetryQueueItem = {
  readonly id: number;
  readonly table: TelemetryTable;
  readonly priority: TelemetryPriority;
  readonly eventType: string;
  readonly coalesceKey: string | null;
  readonly record: Readonly<Record<string, unknown>>;
  readonly attempt: number;
};

export type TelemetryQueueSnapshot = Readonly<{
  maximumRows: number;
  depth: number;
  depthByPriority: Readonly<Record<TelemetryPriority, number>>;
  droppedByPriority: Readonly<Record<TelemetryPriority, number>>;
  droppedByEventType: Readonly<Record<string, number>>;
  coalesced: number;
}>;

type EnqueueInput = Omit<TelemetryQueueItem, "id" | "attempt" | "coalesceKey"> & {
  coalesceKey?: string;
};

export class BoundedTelemetryQueue {
  private readonly queues: Record<TelemetryPriority, TelemetryQueueItem[]> = {
    critical: [],
    important: [],
    routine: []
  };
  private readonly coalescedItems = new Map<string, TelemetryQueueItem>();
  private readonly droppedByPriority: Record<TelemetryPriority, number> = {
    critical: 0,
    important: 0,
    routine: 0
  };
  private readonly droppedByEventType: Record<string, number> = {};
  private nextId = 1;
  private coalesced = 0;

  constructor(readonly maximumRows: number) {
    if (!Number.isInteger(maximumRows) || maximumRows <= 0) {
      throw new Error("telemetry queue maximum must be a positive integer");
    }
  }

  enqueue(input: EnqueueInput): { accepted: boolean; reason?: "queue-full" } {
    return this.enqueueItem({
      ...input,
      id: this.nextId++,
      attempt: 0,
      coalesceKey: input.coalesceKey ?? null
    });
  }

  take(maximumRows: number): TelemetryQueueItem[] {
    const result: TelemetryQueueItem[] = [];
    let remaining = Math.max(0, Math.floor(maximumRows));
    for (const priority of ["critical", "important", "routine"] as const) {
      if (remaining === 0) break;
      const taken = this.queues[priority].splice(0, remaining);
      for (const item of taken) {
        if (item.coalesceKey) this.coalescedItems.delete(item.coalesceKey);
      }
      result.push(...taken);
      remaining -= taken.length;
    }
    return result;
  }

  requeue(items: readonly TelemetryQueueItem[]): void {
    for (const item of [...items].reverse()) {
      const retried = { ...item, attempt: item.attempt + 1 };
      if (this.depth >= this.maximumRows && !this.makeRoom(retried.priority)) {
        this.recordDrop(retried);
        continue;
      }
      this.queues[retried.priority].unshift(retried);
      if (retried.coalesceKey) this.coalescedItems.set(retried.coalesceKey, retried);
    }
  }

  drop(items: readonly TelemetryQueueItem[]): void {
    for (const item of items) this.recordDrop(item);
  }

  snapshot(): TelemetryQueueSnapshot {
    return {
      maximumRows: this.maximumRows,
      depth: this.depth,
      depthByPriority: {
        critical: this.queues.critical.length,
        important: this.queues.important.length,
        routine: this.queues.routine.length
      },
      droppedByPriority: { ...this.droppedByPriority },
      droppedByEventType: { ...this.droppedByEventType },
      coalesced: this.coalesced
    };
  }

  get depth(): number {
    return this.queues.critical.length +
      this.queues.important.length +
      this.queues.routine.length;
  }

  private enqueueItem(item: TelemetryQueueItem): {
    accepted: boolean;
    reason?: "queue-full";
  } {
    if (item.coalesceKey) {
      const existing = this.coalescedItems.get(item.coalesceKey);
      if (existing) {
        const queue = this.queues[existing.priority];
        const index = queue.findIndex((candidate) => candidate.id === existing.id);
        if (index >= 0) {
          queue[index] = item;
          this.coalescedItems.set(item.coalesceKey, item);
          this.coalesced += 1;
          return { accepted: true };
        }
        this.coalescedItems.delete(item.coalesceKey);
      }
    }
    if (this.depth >= this.maximumRows && !this.makeRoom(item.priority)) {
      this.recordDrop(item);
      return { accepted: false, reason: "queue-full" };
    }
    this.queues[item.priority].push(item);
    if (item.coalesceKey) this.coalescedItems.set(item.coalesceKey, item);
    return { accepted: true };
  }

  private makeRoom(incomingPriority: TelemetryPriority): boolean {
    if (this.evictOldest("routine")) return true;
    if (incomingPriority === "critical" && this.evictOldest("important")) return true;
    return false;
  }

  private evictOldest(priority: TelemetryPriority): boolean {
    const evicted = this.queues[priority].shift();
    if (!evicted) return false;
    if (evicted.coalesceKey) this.coalescedItems.delete(evicted.coalesceKey);
    this.recordDrop(evicted);
    return true;
  }

  private recordDrop(item: Pick<TelemetryQueueItem, "priority" | "eventType">): void {
    this.droppedByPriority[item.priority] += 1;
    this.droppedByEventType[item.eventType] =
      (this.droppedByEventType[item.eventType] ?? 0) + 1;
  }
}
