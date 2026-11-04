import { describe, expect, it, vi } from "vitest";

import { AccountRiskService, clampRiskScore } from "./riskService.js";

describe("AccountRiskService", () => {
  it("clamps deterministic scores between zero and one hundred", () => {
    expect(clampRiskScore(-11)).toBe(0);
    expect(clampRiskScore(44.6)).toBe(45);
    expect(clampRiskScore(135)).toBe(100);
  });

  it("recomputes from stored evidence even when a duplicate is ignored", async () => {
    const events = [{ eventType: "device", weight: 25 }];
    const store = {
      insertRiskEvent: vi.fn(async () => false),
      recomputeAccountRiskScore: vi.fn(async () =>
        clampRiskScore(events.reduce((total, event) => total + event.weight, 0))
      )
    };
    const risk = new AccountRiskService(store);

    await expect(
      risk.record({ accountId: "account-1", eventType: "device", weight: 25 })
    ).resolves.toBe(25);
    expect(store.recomputeAccountRiskScore).toHaveBeenCalledWith("account-1");
  });

  it("supports negative trusted evidence without producing a negative score", async () => {
    const store = {
      insertRiskEvent: vi.fn(async () => true),
      recomputeAccountRiskScore: vi.fn(async () => 0)
    };
    await expect(
      new AccountRiskService(store).record({
        accountId: "account-1",
        eventType: "trusted",
        weight: -10
      })
    ).resolves.toBe(0);
  });

  it("keeps concurrent duplicate evidence idempotent", async () => {
    const dedupeKeys = new Set<string>();
    const events: Array<{ eventType: string; weight: number }> = [];
    const store = {
      insertRiskEvent: vi.fn(async (input: { eventType: string; weight: number; dedupeKey?: string | null }) => {
        if (input.dedupeKey && dedupeKeys.has(input.dedupeKey)) {
          return false;
        }
        if (input.dedupeKey) {
          dedupeKeys.add(input.dedupeKey);
        }
        events.push({ eventType: input.eventType, weight: input.weight });
        return true;
      }),
      recomputeAccountRiskScore: vi.fn(async () =>
        clampRiskScore(events.reduce((total, event) => total + event.weight, 0))
      )
    };
    const risk = new AccountRiskService(store);

    await Promise.all([
      risk.record({
        accountId: "account-1",
        eventType: "same-device",
        weight: 25,
        dedupeKey: "same-device:account-1"
      }),
      risk.record({
        accountId: "account-1",
        eventType: "same-device",
        weight: 25,
        dedupeKey: "same-device:account-1"
      })
    ]);

    expect(events).toHaveLength(1);
    expect(store.recomputeAccountRiskScore).toHaveBeenLastCalledWith("account-1");
  });
});
