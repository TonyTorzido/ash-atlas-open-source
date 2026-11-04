import { describe, expect, it, vi } from "vitest";
import { GreenhouseService } from "./greenhouses.js";
import type { PlayerRecord } from "./state.js";

function makeService() {
  const query = vi.fn(async () => ({ rows: [] as unknown[] }));
  const pool = { connect: async () => ({ query, release: () => undefined }) };
  const inventory = { snapshotInTransaction: async () => ({}) };
  const service = new GreenhouseService(
    pool as never,
    "world",
    inventory as never,
    {} as never
  );
  return { service, query };
}

const player = { playerId: "p1", position: { lat: 35, lon: -106 } } as unknown as PlayerRecord;

describe("greenhouse water-fill idle tracking", () => {
  it("checks the DB until a cancel observes no active fill, then skips", async () => {
    const { service } = makeService();
    expect(service.mayHaveActiveWaterFill("p1")).toBe(true);
    await service.cancelWaterBucketFill(player, "cancel-1");
    expect(service.mayHaveActiveWaterFill("p1")).toBe(false);
    expect(service.mayHaveActiveWaterFill("other")).toBe(true);
  });

  it("marks the player possibly-filling as soon as a fill start begins, before any DB write", async () => {
    const { service, query } = makeService();
    await service.cancelWaterBucketFill(player, "cancel-1");
    query.mockClear();
    await expect(service.startWaterBucketFill(player, "fill-1", { lat: 35, lon: -106 }, 99))
      .rejects.toThrow();
    expect(service.mayHaveActiveWaterFill("p1")).toBe(true);
    expect(query).not.toHaveBeenCalled();
  });

  it("does not record idle when a fill started while the cancel was in flight", async () => {
    const { service, query } = makeService();
    query.mockImplementationOnce(async () => {
      await expect(service.startWaterBucketFill(player, "fill-1", { lat: 35, lon: -106 }, 99))
        .rejects.toThrow();
      return { rows: [] };
    });
    await service.cancelWaterBucketFill(player, "cancel-1");
    expect(service.mayHaveActiveWaterFill("p1")).toBe(true);
  });
});
