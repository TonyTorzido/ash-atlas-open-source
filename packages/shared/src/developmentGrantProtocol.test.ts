import { describe, expect, it } from "vitest";

import { parseClientMessage } from "./protocol.js";

describe("development asset grant protocol", () => {
  it.each([
    "DEV_ADVANCE_ALL_GREENHOUSE_CROPS",
    "DEV_WATER_ALL_GREENHOUSE_CROPS",
    "DEV_BUILD_MANOR",
    "DEV_BUILD_SALON"
  ] as const)("accepts the greenhouse test command %s", (type) => {
    const message = { type, requestId: `greenhouse-${type}` };
    expect(parseClientMessage(JSON.stringify(message))).toEqual(message);
  });

  it("rejects a client-chosen city or position on the dev Salon build", () => {
    expect(() => parseClientMessage(JSON.stringify({ type: "DEV_BUILD_SALON", requestId: "salon-1", cityId: "city-1" }))).toThrow();
    expect(() => parseClientMessage(JSON.stringify({ type: "DEV_BUILD_SALON", requestId: "salon-1", lat: 1, lon: 2 }))).toThrow();
  });

  it("accepts a developer metal equipment grant and rejects unknown metals", () => {
    const message = { type: "DEV_GRANT_METAL_EQUIPMENT", requestId: "metal-1", kind: "chest", metal: "revenant" };
    expect(parseClientMessage(JSON.stringify(message))).toEqual(message);
    expect(() => parseClientMessage(JSON.stringify({ ...message, metal: "gold" }))).toThrow();
  });

  it("accepts bounded self-grant intents without a target identity", () => {
    const message = { type: "GRANT_OWN_DEV_ASSETS", requestId: "grant-1", gold: "1000", materials: [{ itemId: "wood", quantity: "500" }] };
    expect(parseClientMessage(JSON.stringify(message))).toEqual(message);
  });

  it("accepts the complete six-material market test kit", () => {
    const message = {
      type: "GRANT_OWN_DEV_ASSETS",
      requestId: "test-kit-1",
      gold: "10000",
      materials: ["wood", "stone", "food", "ore", "water", "leather"].map(
        (itemId) => ({ itemId, quantity: "500" })
      )
    };
    expect(parseClientMessage(JSON.stringify(message))).toEqual(message);
  });

  it("accepts a durable Fishing Rod self-grant item identity", () => {
    const message = {
      type: "GRANT_OWN_DEV_ASSETS",
      requestId: "rod-grant-1",
      materials: [{ itemId: "fishing_rod", quantity: "1" }]
    };
    expect(parseClientMessage(JSON.stringify(message))).toEqual(message);
  });

  it("accepts a bounded City Coin grant without accepting client city identity", () => {
    const message = {
      type: "GRANT_OWN_DEV_ASSETS",
      requestId: "city-grant-1",
      cityCoins: "1000"
    };
    expect(parseClientMessage(JSON.stringify(message))).toEqual(message);
  });

  it.each([
    { gold: "0" },
    { gold: "-1" },
    { gold: "1000001" },
    { gold: "1.5" },
    { cityCoins: "0" },
    { cityCoins: "-1" },
    { cityCoins: "1.5" },
    { cityCoins: "1000001" },
    { materials: [{ itemId: "diamonds", quantity: "1" }] },
    { cityCoins: "1000", cityId: "client-city" },
    { gold: "1000", playerId: "someone-else" }
  ])("rejects invalid or identity-bearing input %#", (grant) => {
    expect(() => parseClientMessage(JSON.stringify({ type: "GRANT_OWN_DEV_ASSETS", requestId: "grant-bad", ...grant }))).toThrow();
  });
});
