import { describe, expect, it } from "vitest";

import {
  LOOM_BUILD_COST,
  LOOM_BUILD_DURATION_MS,
  LOOM_MAX_BATCH_SIZE,
  LOOM_PROCESS_DURATION_MS,
  LOOM_QUEUE_CAPACITY,
  LOOM_RECIPES,
  loomOutputQuantity
} from "./loom.js";

describe("Loom textile economy contract", () => {
  it("uses a bounded outdoor station with a shared 30-second build duration", () => {
    expect(LOOM_BUILD_COST).toEqual({ wood: 25, stone: 10 });
    expect(LOOM_BUILD_DURATION_MS).toBe(30_000);
    expect(LOOM_PROCESS_DURATION_MS).toBe(5_000);
    expect(LOOM_MAX_BATCH_SIZE).toBe(24);
    expect(LOOM_QUEUE_CAPACITY).toBe(5);
  });

  it("weaves Flax Fiber into Cloth at an exact two-to-one ratio", () => {
    expect(LOOM_RECIPES.flax_fiber.outputPerInput).toBe(0.5);
    expect(loomOutputQuantity("flax_fiber", 2)).toBe(1);
    expect(loomOutputQuantity("flax_fiber", 24)).toBe(12);
    expect(() => loomOutputQuantity("flax_fiber", 3)).toThrow(/even number/iu);
    expect(() => loomOutputQuantity("flax_fiber", 25)).toThrow();
  });
});
