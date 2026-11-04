import { describe, expect, it } from "vitest";

import { wanderingMerchantUnitPrice } from "./wanderingMerchant.js";
import {
  FIELD_CRAFT_TRADE_GATES,
  TRADE_SKILL_GATES,
  blacksmithingWearLoss,
  equipmentCraftTradeGate,
  generalSkillRankIn,
  tradeSkillGateMessage,
  tradeSkillGateMet
} from "./tradeSkills.js";

describe("trade skill gates", () => {
  it("allows an action at its rank and denies it below (Cartography, Blacksmithing)", () => {
    expect(tradeSkillGateMet(TRADE_SKILL_GATES.artisan_compass, 0)).toBe(false);
    expect(tradeSkillGateMet(TRADE_SKILL_GATES.artisan_compass, 1)).toBe(true);
    expect(tradeSkillGateMet(TRADE_SKILL_GATES.artisan_shovel, 1)).toBe(false);
    expect(tradeSkillGateMet(TRADE_SKILL_GATES.artisan_shovel, 2)).toBe(true);
    expect(tradeSkillGateMet(TRADE_SKILL_GATES.repair_gear, 0)).toBe(false);
    expect(tradeSkillGateMet(TRADE_SKILL_GATES.repair_gear, 1)).toBe(true);
    expect(tradeSkillGateMet(TRADE_SKILL_GATES.craft_field_trap, 2)).toBe(false);
    expect(tradeSkillGateMet(TRADE_SKILL_GATES.craft_field_trap, 3)).toBe(true);
    expect(tradeSkillGateMessage(TRADE_SKILL_GATES.artisan_shovel)).toBe("Needs Cartography rank 2 to craft a Shovel.");
  });

  it("allows an action at its rank and denies it below (Leatherworking, Alchemy)", () => {
    const gate = (id: keyof typeof TRADE_SKILL_GATES, rank: number) => tradeSkillGateMet(TRADE_SKILL_GATES[id], rank);
    expect([0, 1].map((rank) => gate("craft_sling", rank))).toEqual([false, true]);
    expect([0, 1].map((rank) => gate("craft_backpack", rank))).toEqual([false, true]);
    expect([1, 2].map((rank) => gate("craft_field_net", rank))).toEqual([false, true]);
    expect([2, 3].map((rank) => gate("craft_leather_armor", rank))).toEqual([false, true]);
    expect([0, 1].map((rank) => gate("craft_spark_tonic", rank))).toEqual([false, true]);
    expect([0, 1].map((rank) => gate("craft_anti_venom_tonic", rank))).toEqual([false, true]);
    expect([1, 2].map((rank) => gate("craft_battle_draught", rank))).toEqual([false, true]);
    expect([2, 3].map((rank) => gate("craft_ember_flask", rank))).toEqual([false, true]);
    expect(tradeSkillGateMessage(TRADE_SKILL_GATES.craft_leather_armor)).toBe("Needs Leatherworking rank 3 to craft Leather Armor.");
    expect(tradeSkillGateMessage(TRADE_SKILL_GATES.craft_ember_flask)).toBe("Needs Alchemy rank 3 to craft Ember Bombs.");
    expect(equipmentCraftTradeGate("sling")).toBe("craft_sling");
    expect(equipmentCraftTradeGate("leather")).toBe("craft_leather_armor");
    expect(equipmentCraftTradeGate("sword")).toBeNull();
    expect(FIELD_CRAFT_TRADE_GATES.field_net).toBe("craft_field_net");
    expect(FIELD_CRAFT_TRADE_GATES.stillwater_orb).toBeUndefined();
  });

  it("scales equipped-gear wear by Blacksmithing rank to 10, 7, 6, 4", () => {
    expect([0, 1, 2, 3].map((rank) => blacksmithingWearLoss(10, rank))).toEqual([10, 7, 6, 4]);
  });

  it("prices NPC shops 0, 18, 27, 37 percent lower by Tradecraft rank", () => {
    expect([0, 1, 2, 3].map((rank) => wanderingMerchantUnitPrice(100, rank))).toEqual([100, 82, 73, 63]);
  });

  it("reads a rank from a snapshot list and treats a missing skill as 0", () => {
    expect(generalSkillRankIn([{ skillId: "cartography", rank: 2 }], "cartography")).toBe(2);
    expect(generalSkillRankIn([{ skillId: "cartography", rank: 2 }], "tradecraft")).toBe(0);
    expect(generalSkillRankIn(null, "tradecraft")).toBe(0);
  });
});
