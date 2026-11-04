import { describe, expect, it } from "vitest";

import { loadConfig, publicConfigSummary } from "./config.js";

describe("chat translation configuration", () => {
  it("defaults to the conservative Google free-tier ceiling and never exposes the key", () => {
    const config = loadConfig({
      NODE_ENV: "test",
      CHAT_TRANSLATION_GOOGLE_API_KEY: "server-only-secret"
    });

    expect(config.CHAT_TRANSLATION_MONTHLY_CHAR_CAP).toBe(450_000);
    expect(publicConfigSummary(config)).toMatchObject({
      chatTranslationProviderConfigured: true,
      chatTranslationMonthlyCharacterCap: 450_000
    });
    expect(JSON.stringify(publicConfigSummary(config))).not.toContain("server-only-secret");
  });

  it("allows a lower cap but rejects a value above the conservative ceiling", () => {
    expect(loadConfig({
      NODE_ENV: "test",
      CHAT_TRANSLATION_MONTHLY_CHAR_CAP: "120000"
    }).CHAT_TRANSLATION_MONTHLY_CHAR_CAP).toBe(120_000);
    expect(() => loadConfig({
      NODE_ENV: "test",
      CHAT_TRANSLATION_MONTHLY_CHAR_CAP: "450001"
    })).toThrow();
  });
});
