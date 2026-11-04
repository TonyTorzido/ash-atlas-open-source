import { describe, expect, it } from "vitest";

import { filterChatBody } from "./contentPolicy.js";

describe("chat content policy", () => {
  it("masks common profanity before durable storage", () => {
    expect(filterChatBody("A shit answer")).toEqual({
      allowed: true,
      body: "A **** answer",
      masked: true
    });
  });

  it("normalizes hidden separators before checking high-risk phrases", () => {
    expect(filterChatBody("k.y.s")).toEqual({ allowed: false, reason: "high_risk_content" });
  });

  it("does not reject ordinary fantasy gameplay text", () => {
    expect(filterChatBody("The goblin dropped a sword")).toEqual({
      allowed: true,
      body: "The goblin dropped a sword",
      masked: false
    });
  });
});
