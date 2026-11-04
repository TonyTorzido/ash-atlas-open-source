import type pg from "pg";
import { describe, expect, it, vi } from "vitest";

import { DevelopmentEconomyService } from "./developmentEconomy.js";

describe("DevelopmentEconomyService", () => {
  it("commits wallet and material ledger operations together with scoped audit intent", async () => {
    const harness = createHarness();
    const result = await harness.service.grant("player", "account", "request-1", {
      gold: 10_000n,
      materials: [{ itemId: "balsam_resin", quantity: 500n }]
    });
    expect(result.walletGold).toBe(10_000n);
    expect(harness.commands).toEqual(["BEGIN", "COMMIT"]);
    expect(harness.wallet).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ playerId: "player", accountId: "account", operationKey: "dev-grant:request-1:gold", reason: "development_market_testing_grant" }));
    expect(harness.inventory).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      playerId: "player",
      operationKey: "dev-grant:request-1:materials",
      sourceEntityId: "account",
      grants: [{
        itemId: "balsam_resin",
        variant: null,
        quantity: 500n
      }]
    }));
  });

  it("reports a duplicate operation as replayed without claiming another grant", async () => {
    const harness = createHarness({ replayed: true });
    const result = await harness.service.grant("player", "account", "same-request", { gold: 1_000n, materials: [{ itemId: "stone", quantity: 5n }] });
    expect(result.replayed).toBe(true);
    expect(harness.commands).toEqual(["BEGIN", "COMMIT"]);
  });

  it("routes Fishing Rod self-grants through the durable rod authority", async () => {
    const harness = createHarness({ fishing: true });
    const result = await harness.service.grant("player", "account", "rod-request", {
      materials: [{ itemId: "fishing_rod", quantity: 1n }]
    });
    expect(harness.fishing).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        operationKey: "dev-grant:rod-request:fishing-rods",
        playerId: "player",
        quantity: 1n,
        source: "development_market_testing_grant"
      })
    );
    expect(result.grants).toEqual([
      expect.objectContaining({
        itemId: "fishing_rod",
        requestedQuantity: 1,
        grantedQuantity: 1,
        remainderQuantity: 0
      })
    ]);
  });

  it("accepts Fertilizer as an active developer material grant", async () => {
    const harness = createHarness();
    await harness.service.grant("player", "account", "fertilizer-request", {
      materials: [{ itemId: "fertilizer", quantity: 1n }]
    });
    expect(harness.inventory).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      operationKey: "dev-grant:fertilizer-request:materials",
      grants: [{ itemId: "fertilizer", variant: null, quantity: 1n }]
    }));
  });

  it("rolls back the complete transaction when either authoritative mutation fails", async () => {
    const harness = createHarness({ inventoryFailure: true });
    await expect(harness.service.grant("player", "account", "request-fail", { gold: 1_000n, materials: [{ itemId: "ore", quantity: 2n }] })).rejects.toThrow("inventory failure");
    expect(harness.commands).toEqual(["BEGIN", "ROLLBACK"]);
  });

  it("resolves active membership and credits the city contribution in the grant transaction", async () => {
    const harness = createHarness({ cityMembership: true });
    const result = await harness.service.grant(
      "player",
      "account",
      "city-request",
      { gold: 1n, cityCoins: 750n }
    );
    expect(harness.membership).toHaveBeenCalledWith(
      expect.anything(),
      "player"
    );
    expect(harness.cityCredit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        operationKey: "dev-grant:city-request:city-coins",
        cityId: "city",
        playerId: "player",
        membershipId: "membership",
        amount: 750,
        ledgerEntryType: "development_grant"
      })
    );
    expect(result.cityCoins).toEqual({
      creditedAmount: 750,
      cityId: "city",
      cityName: "Atlas City",
      treasuryBalance: "1750",
      playerContribution: "750"
    });
    expect(harness.commands).toEqual(["BEGIN", "COMMIT"]);
  });

  it("rejects a City Coin grant without active membership and rolls back every asset", async () => {
    const harness = createHarness({ cityMembership: false });
    await expect(harness.service.grant(
      "player",
      "account",
      "no-city",
      { gold: 100n, cityCoins: 100n }
    )).rejects.toMatchObject({
      code: "DEV_CITY_MEMBERSHIP_REQUIRED",
      message: "Join a city before granting City Coins."
    });
    expect(harness.commands).toEqual(["BEGIN", "ROLLBACK"]);
  });

  it.each([0n, -1n, 1_000_001n])("rejects out-of-range quantities (%s)", async (quantity) => {
    const harness = createHarness();
    await expect(harness.service.grant("player", "account", "bad", { gold: quantity })).rejects.toThrow(/between 1 and 1000000/i);
    expect(harness.commands).toEqual([]);
  });

  it.each(["food", "water"] as const)("rejects retired %s developer grants", async (itemId) => {
    const harness = createHarness();
    await expect(harness.service.grant("player", "account", "retired", {
      materials: [{ itemId, quantity: 1n }]
    })).rejects.toThrow(/not currently grantable/);
    expect(harness.commands).toEqual([]);
  });
});

function createHarness(options: {
  replayed?: boolean;
  inventoryFailure?: boolean;
  cityMembership?: boolean;
  fishing?: boolean;
} = {}) {
  const commands: string[] = [];
  const client = { query: vi.fn(async (sql: string) => { commands.push(sql); return { rows: [{ gold_balance: "10000" }], rowCount: 1 }; }), release: vi.fn() };
  const pool = { connect: vi.fn(async () => client) } as unknown as pg.Pool;
  const wallet = vi.fn(async () => ({ applied: !options.replayed, goldBalance: 10_000n, version: 1n }));
  const inventory = vi.fn(async () => {
    if (options.inventoryFailure) throw new Error("inventory failure");
    return {
      applied: !options.replayed,
      inventory: snapshot(),
      grants: [{
        itemId: "balsam_resin" as const,
        variant: null,
        requestedQuantity: 500,
        grantedQuantity: 500,
        remainderQuantity: 0
      }]
    };
  });
  const fishing = vi.fn(async () => ({
    applied: true,
    inventory: snapshot(),
    grants: [{
      itemId: "fishing_rod" as const,
      variant: "rod-1",
      requestedQuantity: 1,
      grantedQuantity: 1,
      remainderQuantity: 0
    }]
  }));
  const membership = vi.fn(async () => options.cityMembership
    ? { membershipId: "membership", cityId: "city", cityName: "Atlas City" }
    : null);
  const cityCredit = vi.fn(async () => ({
    applied: !options.replayed,
    balance: "1750",
    contribution: "750"
  }));
  const contributionOperation = vi.fn(async () => null);
  const service = new DevelopmentEconomyService(pool, {
    wallet: { creditForOperationInTransaction: wallet },
    inventory: { grantItemsForOperationInTransaction: inventory, snapshotInTransaction: vi.fn(async () => snapshot()) },
    ...(options.fishing ? { fishing: { grantDurableRodsInTransaction: fishing } } : {}),
    cityTreasury: {
      activeMembershipForPlayerInTransaction: membership,
      contributionOperationInTransaction: contributionOperation,
      creditContributionInTransaction: cityCredit
    }
  });
  return {
    service,
    commands,
    wallet,
    inventory,
    fishing,
    membership,
    contributionOperation,
    cityCredit
  };
}
function snapshot() {
  return {
    playerId: "player",
    revision: 0,
    items: [],
    totals: {
      wood: 0,
      stone: 0,
      coal: 0,
      iron: 0,
      sulfur: 0,
      iron_bar: 0,
      venomsteel_bar: 0,
      venomsteel_core: 0,
      fire_feather: 0, tempest_quill: 0, ice_feather: 0,
      fire_bar: 0, fire_core: 0, lightning_bar: 0, lightning_core: 0, ice_bar: 0, ice_core: 0,
      food: 0,
      ore: 0,
      water: 0,
      leather: 0,
      deer_hide: 0,
      hog_hide: 0,
      wolf_pelt: 0,
      bear_hide: 0,
      alligator_hide: 0,
      squid_flesh: 0,
      crab_carapace: 0,
      raw_meat: 0,
      shell: 0,
      giving_berry: 0,
      balsam_resin: 500,
      crude_oil: 0,
      jellyfish_venom: 0, brood_silk: 0, refined_oil: 0, raptor_scale: 0, giant_egg: 0, brood_egg: 0, clutch_egg: 0, crawler_egg: 0, broken_whistle: 0, bonewrought_blade: 0, bonewrought_mail: 0, anti_venom_tonic: 0, battle_draught: 0, ember_flask: 0, spark_tonic: 0, field_net: 0, field_trap: 0, lamp_sheath: 0, cinder_lantern: 0, challengers_lantern: 0, survey_stake_kit: 0, compass: 0, elder_acorn: 0, zephyr: 0, cave_lichen: 0, gale_plume: 0, heartsap: 0, wyrm_egg: 0, dragon_scale: 0, maw_bloom_petal: 0, giving_tree_sapling: 0, edict_seal: 0, prison_key_fragment: 0,
      crystal: 0, pearl: 0, atlas_shrine_shard: 0,
      enchantment_stone: 0
    }
  };
}
