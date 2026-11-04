import { describe, expect, it } from "vitest";

import { BoundedTelemetryQueue } from "./queue.js";

function item(
  eventType: string,
  priority: "critical" | "important" | "routine",
  coalesceKey?: string
) {
  return {
    table: "gameplay_events" as const,
    eventType,
    priority,
    record: { event_type: eventType },
    ...(coalesceKey ? { coalesceKey } : {})
  };
}

describe("bounded telemetry queue", () => {
  it("coalesces routine samples without growing the queue", () => {
    const queue = new BoundedTelemetryQueue(2);
    queue.enqueue(item("first", "routine", "server"));
    queue.enqueue(item("latest", "routine", "server"));

    expect(queue.snapshot()).toMatchObject({ depth: 1, coalesced: 1 });
    expect(queue.take(1)[0]?.eventType).toBe("latest");
  });

  it("evicts routine data before important or critical data", () => {
    const queue = new BoundedTelemetryQueue(2);
    queue.enqueue(item("routine-a", "routine"));
    queue.enqueue(item("routine-b", "routine"));
    expect(queue.enqueue(item("important", "important")).accepted).toBe(true);
    expect(queue.take(2).map((entry) => entry.eventType)).toEqual([
      "important",
      "routine-b"
    ]);
    expect(queue.snapshot().droppedByPriority.routine).toBe(1);
  });

  it("only lets critical data displace important data", () => {
    const queue = new BoundedTelemetryQueue(1);
    queue.enqueue(item("important", "important"));
    expect(queue.enqueue(item("another-important", "important"))).toEqual({
      accepted: false,
      reason: "queue-full"
    });
    expect(queue.enqueue(item("critical", "critical")).accepted).toBe(true);
    expect(queue.take(1)[0]?.eventType).toBe("critical");
  });

  it("retries important rows ahead of routine rows and increments attempts", () => {
    const queue = new BoundedTelemetryQueue(3);
    queue.enqueue(item("important", "important"));
    queue.enqueue(item("routine", "routine"));
    const batch = queue.take(2);
    queue.requeue(batch);

    expect(queue.take(2).map(({ eventType, attempt }) => [eventType, attempt])).toEqual([
      ["important", 1],
      ["routine", 1]
    ]);
  });

  it("counts unavoidable critical loss instead of hiding it", () => {
    const queue = new BoundedTelemetryQueue(1);
    expect(queue.enqueue(item("first-critical", "critical")).accepted).toBe(true);
    expect(queue.enqueue(item("overflow-critical", "critical"))).toEqual({
      accepted: false,
      reason: "queue-full"
    });
    expect(queue.snapshot()).toMatchObject({
      depth: 1,
      droppedByPriority: { critical: 1 },
      droppedByEventType: { "overflow-critical": 1 }
    });
  });
});
