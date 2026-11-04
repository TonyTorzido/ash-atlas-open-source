import { describe, expect, it } from "vitest";

import { loadConfig } from "./config.js";

describe("mobile reconnect configuration", () => {
  it("uses the production reconnect and heartbeat defaults", () => {
    expect(loadConfig({ NODE_ENV: "test" })).toMatchObject({
      RECONNECT_GRACE_MS: 180_000,
      LINKDEAD_WORLD_PRESENCE_MS: 30_000,
      WS_BOOTSTRAP_TIMEOUT_MS: 15_000,
      WS_HEARTBEAT_TIMEOUT_MS: 20_000,
      WS_HEARTBEAT_SWEEP_MS: 5_000
    });
  });

  it("rejects presence or heartbeat intervals outside their parent window", () => {
    expect(() => loadConfig({
      NODE_ENV: "test",
      RECONNECT_GRACE_MS: "29999",
      LINKDEAD_WORLD_PRESENCE_MS: "30000"
    })).toThrow();
    expect(() => loadConfig({
      NODE_ENV: "test",
      WS_HEARTBEAT_TIMEOUT_MS: "4999",
      WS_HEARTBEAT_SWEEP_MS: "5000"
    })).toThrow();
  });
});
