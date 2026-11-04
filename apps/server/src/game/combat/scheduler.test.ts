import { describe, expect, it } from "vitest";

import { DueTickScheduler } from "./scheduler.js";

describe("DueTickScheduler", () => {
  it("returns only due work in stable sequence order without timers", () => {
    const scheduler = new DueTickScheduler();
    scheduler.schedule({ dueTick: 4, kind: "attack", entityId: "b", generation: 1 });
    scheduler.schedule({ dueTick: 3, kind: "status-expiry", entityId: "p", generation: 2 });
    scheduler.schedule({ dueTick: 4, kind: "attack", entityId: "a", generation: 1 });

    expect(scheduler.takeDue(2)).toEqual([]);
    expect(scheduler.takeDue(3).map((work) => work.entityId)).toEqual(["p"]);
    expect(scheduler.takeDue(4).map((work) => work.entityId)).toEqual(["b", "a"]);
    expect(scheduler.size).toBe(0);
  });
});
