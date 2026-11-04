import type pg from "pg";
import { describe, expect, it, vi } from "vitest";

import { CityTreasuryService } from "./cityTreasury.js";

describe("CityTreasuryService contribution credits", () => {
  it("keeps combat settlement behavior on the generalized contribution primitive", async () => {
    const service = new CityTreasuryService({} as pg.Pool);
    const client = {} as pg.PoolClient;
    const contribution = vi.spyOn(
      service,
      "creditContributionInTransaction"
    ).mockResolvedValue({
      applied: true,
      balance: "12",
      contribution: "7"
    });

    await expect(service.creditCombatInTransaction(client, {
      operationKey: "combat-key",
      cityId: "city",
      playerId: "player",
      membershipId: "membership",
      amount: 7,
      settlementKey: "settlement",
      mobArchetype: "wolf"
    })).resolves.toEqual({
      applied: true,
      balance: "12",
      contribution: "7"
    });
    expect(contribution).toHaveBeenCalledWith(client, {
      operationKey: "combat-key",
      cityId: "city",
      playerId: "player",
      membershipId: "membership",
      amount: 7,
      sourceType: "combat_settlement",
      sourceId: "settlement",
      ledgerEntryType: "combat_contribution",
      metadata: { mobArchetype: "wolf" }
    });
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid contribution amounts (%s)",
    async (amount) => {
      const service = new CityTreasuryService({} as pg.Pool);
      const client = { query: vi.fn() } as unknown as pg.PoolClient;
      await expect(service.creditContributionInTransaction(client, {
        operationKey: "invalid",
        cityId: "city",
        playerId: "player",
        membershipId: "membership",
        amount,
        sourceType: "development_grant",
        sourceId: "request",
        ledgerEntryType: "development_grant"
      })).rejects.toMatchObject({ code: "CITY_COIN_AMOUNT_INVALID" });
      expect(client.query).not.toHaveBeenCalled();
    }
  );
});
