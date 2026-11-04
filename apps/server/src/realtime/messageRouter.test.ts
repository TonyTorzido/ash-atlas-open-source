import { describe, expect, it, vi } from "vitest";

import { createRealtimeMessageRouter } from "./handlers/registerHandlers.js";
import { CLIENT_MESSAGE_FAMILIES, RealtimeMessageRouter } from "./messageRouter.js";

describe("RealtimeMessageRouter", () => {
  it("classifies every client message and dispatches exactly once", async () => {
    expect(Object.keys(CLIENT_MESSAGE_FAMILIES).length).toBeGreaterThan(0);
    const dispatch = vi.fn();
    const router = createRealtimeMessageRouter({
      session: dispatch,
      worldGameplay: dispatch,
      flag: dispatch,
      travel: dispatch,
      settlement: dispatch,
      party: dispatch,
      manor: dispatch,
      salon: dispatch,
      harvesting: dispatch,
      combatEquipment: dispatch,
      backpack: dispatch,
      social: dispatch,
      market: dispatch,
      pet: dispatch,
      sapling: dispatch,
      packages: dispatch,
      gifts: dispatch,
      shop: dispatch,
      developer: dispatch,
      dungeon: dispatch,
      portal: dispatch
    });

    await router.dispatch({ type: "PING", clientTime: 1 });

    expect(dispatch).toHaveBeenCalledOnce();
    expect(dispatch).toHaveBeenCalledWith({ type: "PING", clientTime: 1 });
  });

  it("fails duplicate registration and incomplete startup", () => {
    const router = new RealtimeMessageRouter();
    router.register("session", vi.fn());
    expect(() => router.register("session", vi.fn()))
      .toThrow("registered more than once");
    expect(() => router.assertComplete()).toThrow("missing handlers");
  });

  it("keeps every message implementation in its declared family module", () => {
    const handlerFiles = {
      session: "sessionHandler.ts",
      "world-gameplay": "worldGameplayHandler.ts",
      flag: "flagHandler.ts",
      travel: "travelHandler.ts",
      settlement: "settlementHandler.ts",
      party: "partyHandler.ts",
      manor: "manorHandler.ts",
      salon: "salonHandler.ts",
      harvesting: "harvestingHandler.ts",
      "combat-equipment": "combatEquipmentHandler.ts",
      backpack: "backpackHandler.ts",
      social: "socialHandler.ts",
      market: "marketHandler.ts",
      pet: "petHandler.ts",
      sapling: "saplingHandler.ts",
      packages: "playerPackageHandler.ts",
      gifts: "playerGiftHandler.ts",
      shop: "shopHandler.ts",
      developer: "developerHandler.ts",
      dungeon: "dungeonHandler.ts"
    } as const;
    for (const [family, fileName] of Object.entries(handlerFiles)) {
      const source = readFileSync(fileURLToPath(new URL(`handlers/${fileName}`, import.meta.url)), "utf8");
      const implemented = [...source.matchAll(/\bcase\s+"([A-Z][A-Z0-9_]+)"\s*:/g)]
        .map((match) => match[1]!)
        .sort();
      const expected = Object.entries(CLIENT_MESSAGE_FAMILIES)
        .filter(([, owner]) => owner === family)
        .map(([messageType]) => messageType)
        .sort();
      expect(implemented).toEqual(expected);
    }
    const compatibilityHost = readFileSync(
      fileURLToPath(new URL("realtimeApplication.ts", import.meta.url)),
      "utf8"
    );
    expect(compatibilityHost).not.toMatch(/\bcase\s+"[A-Z][A-Z0-9_]+"\s*:/);
  });
});
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
