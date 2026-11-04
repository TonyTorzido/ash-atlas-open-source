import { describe, expect, it } from "vitest";

import { loadConfig } from "../config.js";

describe("Kingdom configuration safety", () => {
  it("defaults free construction on only outside production", () => {
    const development = loadConfig({ NODE_ENV: "test" });
    expect(development.KINGDOMS_FREE_CONSTRUCTION).toBe(true);
    expect(development.KINGDOM_INITIAL_TERRITORY_RADIUS_M).toBe(200);
    expect(development.KINGDOM_MIN_SEAT_SPACING_M).toBe(650);
    expect(development.KINGDOM_PERK_QUALIFICATION_SECONDS).toBe(60);
    expect(development.KINGDOM_CHAT_RETENTION_LIMIT).toBe(500);
    expect(development.KINGDOM_COT_FOOTPRINT_RADIUS_M).toBe(2.5);
  });

  it("loads every supported hardening setting through the real schema", () => {
    expect(loadConfig({
      NODE_ENV: "test",
      KINGDOM_CHAT_HISTORY_LIMIT: "12",
      KINGDOM_CHAT_RETENTION_LIMIT: "24",
      KINGDOM_DONATION_HISTORY_LIMIT: "7",
      KINGDOM_SEAT_SPACING_BUFFER_M: "75",
      KINGDOM_SEAT_FOOTPRINT_RADIUS_M: "11",
      KINGDOM_COT_FOOTPRINT_RADIUS_M: "3",
      KINGDOM_REPLAY_RETENTION_DAYS: "14"
    })).toMatchObject({
      KINGDOM_CHAT_HISTORY_LIMIT: 12,
      KINGDOM_CHAT_RETENTION_LIMIT: 24,
      KINGDOM_DONATION_HISTORY_LIMIT: 7,
      KINGDOM_SEAT_SPACING_BUFFER_M: 75,
      KINGDOM_SEAT_FOOTPRINT_RADIUS_M: 11,
      KINGDOM_COT_FOOTPRINT_RADIUS_M: 3,
      KINGDOM_REPLAY_RETENTION_DAYS: 14
    });
  });

  it("supports shortening membership qualification in tests", () => {
    expect(loadConfig({
      NODE_ENV: "test",
      KINGDOMS_FREE_CONSTRUCTION: "false",
      KINGDOM_PERK_QUALIFICATION_SECONDS: "0"
    })).toMatchObject({
      KINGDOMS_FREE_CONSTRUCTION: false,
      KINGDOM_PERK_QUALIFICATION_SECONDS: 0
    });
  });

  it("rejects free construction in production", () => {
    expect(() => loadConfig({
      ...productionEnv(),
      KINGDOMS_FREE_CONSTRUCTION: "true"
    })).toThrow(/free Kingdom construction/);
    expect(loadConfig(productionEnv())).toMatchObject({
      KINGDOMS_FREE_CONSTRUCTION: false,
      KINGDOM_PERK_QUALIFICATION_SECONDS: 86_400
    });
  });
});

function productionEnv(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "production",
    AUTH_MODE: "google",
    GOOGLE_CLIENT_ID: "google-client-id.apps.googleusercontent.com",
    APP_PUBLIC_ORIGIN: "https://game.example",
    AUTH_ALLOWED_ORIGINS: "https://game.example",
    AUTH_TRUST_PROXY: "127.0.0.1",
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
