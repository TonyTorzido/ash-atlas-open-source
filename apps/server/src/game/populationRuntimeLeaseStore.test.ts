import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  type PopulationZoneV2RuntimeLease,
  PostgresPopulationZonesV2Store
} from "./populationZonesV2Store.js";

const lease: PopulationZoneV2RuntimeLease = {
  entityId: randomUUID(),
  runtimeId: "lease-retry-test",
  ownerToken: randomUUID(),
  fencingGeneration: 1,
  cutoverRevision: 1,
  stateRevision: 0,
  leaseExpiresAt: new Date(Date.now() + 30_000)
};

describe("population runtime lease store", () => {
  it.each(["40P01", "40001"])(
    "retries a %s renewal with the same fenced request",
    async (code) => {
      const query = vi.fn()
        .mockRejectedValueOnce(Object.assign(new Error("retryable"), { code }))
        .mockResolvedValueOnce({
          rows: [{ entity_id: lease.entityId, renewal_status: "renewed" }],
          rowCount: 1
        });
      const warn = vi.fn();
      const store = new PostgresPopulationZonesV2Store(
        { query } as never,
        undefined,
        undefined,
        { logger: { warn } }
      );

      await expect(store.renewRuntimeEntityLeases([lease], 30_000))
        .resolves.toEqual([{ entityId: lease.entityId, status: "renewed" }]);

      expect(query).toHaveBeenCalledTimes(2);
      expect(query.mock.calls[1]).toEqual(query.mock.calls[0]);
      expect(String(query.mock.calls[0]?.[0])).toContain(
        "ORDER BY lease.entity_id\n         FOR UPDATE OF lease"
      );
      expect(warn).toHaveBeenCalledOnce();
    }
  );

  it("retries a deadlocked release without widening its fence", async () => {
    const query = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error("deadlock"), {
        code: "40P01"
      }))
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });
    const store = new PostgresPopulationZonesV2Store({ query } as never);

    await expect(store.releaseRuntimeEntityLeases([lease])).resolves.toBe(1);

    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[1]).toEqual(query.mock.calls[0]);
    expect(String(query.mock.calls[0]?.[0])).toContain(
      "ORDER BY lease.entity_id\n         FOR UPDATE OF lease"
    );
  });

  it("does not retry an unrelated database failure", async () => {
    const failure = Object.assign(new Error("constraint"), { code: "23505" });
    const query = vi.fn().mockRejectedValue(failure);
    const store = new PostgresPopulationZonesV2Store({ query } as never);

    await expect(store.renewRuntimeEntityLeases([lease], 30_000))
      .rejects.toBe(failure);
    expect(query).toHaveBeenCalledOnce();
  });

  it("stops after two retries when database conflicts continue", async () => {
    const failure = Object.assign(new Error("deadlock"), { code: "40P01" });
    const query = vi.fn().mockRejectedValue(failure);
    const store = new PostgresPopulationZonesV2Store({ query } as never);

    await expect(store.releaseRuntimeEntityLeases([lease]))
      .rejects.toBe(failure);
    expect(query).toHaveBeenCalledTimes(3);
  });
});
