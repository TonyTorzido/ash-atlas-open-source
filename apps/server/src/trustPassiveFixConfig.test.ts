import { describe, expect, it } from "vitest";

import { loadConfig } from "./config.js";

describe("passive location fix interval configuration", () => {
  it("defaults to a random 180-420 s window", () => {
    expect(loadConfig({ NODE_ENV: "test" })).toMatchObject({
      TRUST_PASSIVE_FIX_MIN_SECONDS: 180,
      TRUST_PASSIVE_FIX_MAX_SECONDS: 420
    });
  });

  it("accepts a custom window, including min equal to max", () => {
    expect(loadConfig({
      NODE_ENV: "test",
      TRUST_PASSIVE_FIX_MIN_SECONDS: "60",
      TRUST_PASSIVE_FIX_MAX_SECONDS: "60"
    })).toMatchObject({ TRUST_PASSIVE_FIX_MIN_SECONDS: 60, TRUST_PASSIVE_FIX_MAX_SECONDS: 60 });
  });

  it("rejects a min or max below 60 s and a max below the min", () => {
    expect(() => loadConfig({ NODE_ENV: "test", TRUST_PASSIVE_FIX_MIN_SECONDS: "59" })).toThrow();
    expect(() => loadConfig({ NODE_ENV: "test", TRUST_PASSIVE_FIX_MAX_SECONDS: "59" })).toThrow();
    expect(() => loadConfig({
      NODE_ENV: "test",
      TRUST_PASSIVE_FIX_MIN_SECONDS: "300",
      TRUST_PASSIVE_FIX_MAX_SECONDS: "200"
    })).toThrow(/TRUST_PASSIVE_FIX_MAX_SECONDS/);
    // Default max (420) is below a larger explicit min.
    expect(() => loadConfig({ NODE_ENV: "test", TRUST_PASSIVE_FIX_MIN_SECONDS: "500" })).toThrow();
  });
});
