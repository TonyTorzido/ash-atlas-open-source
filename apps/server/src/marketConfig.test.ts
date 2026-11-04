import { describe, expect, it } from "vitest";

import { loadConfig } from "./config.js";

describe("market fail-closed configuration", () => {
  it.each(["development", "test"] as const)(
    "defaults global access off in %s",
    (nodeEnv) => {
      expect(loadConfig({ NODE_ENV: nodeEnv }).MARKET_GLOBAL_ACCESS).toBe(false);
    }
  );

  it("allows an explicit non-production development/test opt-in", () => {
    expect(loadConfig({ NODE_ENV: "development", MARKET_GLOBAL_ACCESS: "true" }))
      .toMatchObject({ MARKET_GLOBAL_ACCESS: true });
    expect(loadConfig({ NODE_ENV: "test", MARKET_GLOBAL_ACCESS: "true" }))
      .toMatchObject({ MARKET_GLOBAL_ACCESS: true });
  });

  it("rejects production global access without a separate acknowledgement", () => {
    expect(() => loadConfig({
      ...validProductionEnv(),
      MARKET_GLOBAL_ACCESS: "true"
    })).toThrow(/global market access requires explicit acknowledgement/i);
  });

  it("accepts production global access only with explicit acknowledgement", () => {
    expect(loadConfig({
      ...validProductionEnv(),
      MARKET_GLOBAL_ACCESS: "true",
      MARKET_ALLOW_GLOBAL_ACCESS_IN_PRODUCTION: "true"
    })).toMatchObject({
      MARKET_GLOBAL_ACCESS: true,
      MARKET_ALLOW_GLOBAL_ACCESS_IN_PRODUCTION: true
    });
  });

  it("validates payload and resting-order bounds", () => {
    expect(() => loadConfig({
      NODE_ENV: "test",
      WS_MAX_PAYLOAD_BYTES: "524289"
    })).toThrow(/payload limit/i);
    expect(() => loadConfig({
      NODE_ENV: "test",
      MARKET_MAX_OPEN_ORDERS_PER_ITEM: "4",
      MARKET_MAX_RESTING_ORDERS_PER_ACCOUNT_BOOK: "5"
    })).toThrow(/per-account book limit/i);
    expect(() => loadConfig({
      NODE_ENV: "test",
      MARKET_RECONCILIATION_INTERVAL_MS: "60000",
      MARKET_RECONCILIATION_STALE_AFTER_MS: "60000"
    })).toThrow(/stale threshold/i);
  });
});

function validProductionEnv(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "production",
    AUTH_MODE: "google",
    GOOGLE_CLIENT_ID: "google-client-id.apps.googleusercontent.com",
    APP_PUBLIC_ORIGIN: "https://game.example",
    AUTH_ALLOWED_ORIGINS: "https://game.example",
    AUTH_TRUST_PROXY: "127.0.0.1,::1",
    AUTH_SESSION_TOKEN_HMAC_KEY: "session-key-aaaaaaaaaaaaaaaaaaaaaaaa",
    AUTH_DEVICE_TOKEN_HMAC_KEY: "device-key-bbbbbbbbbbbbbbbbbbbbbbbbb",
    AUTH_NETWORK_HMAC_KEY: "network-key-ccccccccccccccccccccccccc",
    INITIAL_SPAWN_HMAC_KEY: "spawn-key-ddddddddddddddddddddddddd",
    DOG_GENETICS_HMAC_KEY: "genetics-key-eeeeeeeeeeeeeeeeeeeeee",
    TEST_ACCESS_ADMIN_GOOGLE_SUBJECTS: "test-admin-subject",
    AUTH_REQUIRE_GMAIL: "true",
    ALLOW_UNRESOLVED_FLAGS_IN_DEV: "false",
    DEV_TOOLS_ENABLED: "false"
  };
}
