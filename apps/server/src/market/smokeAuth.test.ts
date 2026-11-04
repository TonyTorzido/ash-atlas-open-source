import { describe, expect, it } from "vitest";

import { resolveAuthenticatedMarketSmokeMode, smokeConfig } from "./smokeAuth.js";

const externalDatabaseUrl =
  "postgres://ash_atlas:ash_atlas@127.0.0.1:55432/ash_atlas_markets_dev";
const externalRuntimeWsUrl = "ws://127.0.0.1:3011/ws";

describe("authenticated market smoke mode safety", () => {
  it("enables isolated development authentication for its authenticated identities", () => {
    expect(smokeConfig(
      "postgres://ash_atlas:ash_atlas@127.0.0.1:55432/ash_atlas_stability_smoke_validation",
      {}
    )).toMatchObject({
      NODE_ENV: "development",
      AUTH_MODE: "dev",
      AUTH_DEV_LOGIN_ENABLED: true,
      AUTH_REQUIRED: true
    });
  });

  it("keeps the disposable in-process validation mode as the default", () => {
    expect(resolveAuthenticatedMarketSmokeMode({})).toEqual({
      boundary: "in-process-fastify-websocket",
      databaseUrl:
        "postgres://ash_atlas:ash_atlas@127.0.0.1:55432/ash_atlas_markets_smoke_validation",
      databaseName: "ash_atlas_markets_smoke_validation",
      keepDatabase: false,
      runtimeWsUrl: null
    });
  });

  it("accepts only the explicit launched Markets runtime opt-in", () => {
    expect(resolveAuthenticatedMarketSmokeMode({
      MARKET_SMOKE_RUNTIME_WS_URL: externalRuntimeWsUrl,
      MARKET_SMOKE_DATABASE_URL: externalDatabaseUrl,
      MARKET_SMOKE_KEEP_DB: "true"
    })).toEqual({
      boundary: "launched-network-websocket",
      databaseUrl: externalDatabaseUrl,
      databaseName: "ash_atlas_markets_dev",
      keepDatabase: true,
      runtimeWsUrl: externalRuntimeWsUrl
    });
  });

  it("rejects external mode unless database preservation is explicit", () => {
    expect(() => resolveAuthenticatedMarketSmokeMode({
      MARKET_SMOKE_RUNTIME_WS_URL: externalRuntimeWsUrl,
      MARKET_SMOKE_DATABASE_URL: externalDatabaseUrl
    })).toThrow(/requires MARKET_SMOKE_KEEP_DB=true/);
  });

  it("rejects external mode without an explicit database URL", () => {
    expect(() => resolveAuthenticatedMarketSmokeMode({
      MARKET_SMOKE_RUNTIME_WS_URL: externalRuntimeWsUrl,
      MARKET_SMOKE_KEEP_DB: "true"
    })).toThrow(/requires an explicit MARKET_SMOKE_DATABASE_URL/);
  });

  it.each([
    "postgres://ash_atlas:ash_atlas@127.0.0.1:55432/ash_atlas_markets_smoke_validation",
    "postgres://ash_atlas:ash_atlas@127.0.0.1:55432/ash_atlas_game",
    "postgres://ash_atlas:ash_atlas@example.com:55432/ash_atlas_markets_dev",
    "postgres://ash_atlas:ash_atlas@127.0.0.1:5432/ash_atlas_markets_dev"
  ])("rejects unsafe external database target %s", (databaseUrl) => {
    expect(() => resolveAuthenticatedMarketSmokeMode({
      MARKET_SMOKE_RUNTIME_WS_URL: externalRuntimeWsUrl,
      MARKET_SMOKE_DATABASE_URL: databaseUrl,
      MARKET_SMOKE_KEEP_DB: "true"
    })).toThrow(/local PostgreSQL database 'ash_atlas_markets_dev'/);
  });

  it.each([
    "ws://127.0.0.1:3012/ws",
    "ws://localhost:3011/ws",
    "ws://127.0.0.1:3011/not-ws",
    "wss://127.0.0.1:3011/ws",
    "ws://example.com:3011/ws"
  ])("rejects unsafe external WebSocket target %s", (runtimeWsUrl) => {
    expect(() => resolveAuthenticatedMarketSmokeMode({
      MARKET_SMOKE_RUNTIME_WS_URL: runtimeWsUrl,
      MARKET_SMOKE_DATABASE_URL: externalDatabaseUrl,
      MARKET_SMOKE_KEEP_DB: "true"
    })).toThrow(/requires MARKET_SMOKE_RUNTIME_WS_URL=ws:\/\/127\.0\.0\.1:3011\/ws/);
  });

  it("does not allow the normal in-process path to target the retained dev database", () => {
    expect(() => resolveAuthenticatedMarketSmokeMode({
      MARKET_SMOKE_DATABASE_URL: externalDatabaseUrl,
      MARKET_SMOKE_KEEP_DB: "true"
    })).toThrow(/database must end in _validation/);
  });
});
