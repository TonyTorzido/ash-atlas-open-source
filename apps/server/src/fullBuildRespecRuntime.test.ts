import { describe, expect, it } from "vitest";

import { isFullBuildRespecRuntime, skillSystemV3RuntimeCapabilities } from "./config.js";

describe("full build respec runtime capability", () => {
  it("allows local development and test runtimes", () => {
    expect(isFullBuildRespecRuntime({ NODE_ENV: "development" })).toBe(true);
    expect(isFullBuildRespecRuntime({ NODE_ENV: "test" })).toBe(true);
    expect(skillSystemV3RuntimeCapabilities({ NODE_ENV: "development" })).toEqual({
      fullBuildRespecAvailable: true,
      fullClassRosterEnabled: false,
      ultimatesEnabled: false
    });
    expect(skillSystemV3RuntimeCapabilities({ NODE_ENV: "test" })).toEqual({
      fullBuildRespecAvailable: true,
      fullClassRosterEnabled: false,
      ultimatesEnabled: false
    });
  });

  it("allows only the immutable public test-server production identity", () => {
    const identity = {
      NODE_ENV: "production" as const,
      RUNTIME_LABEL: "production",
      RUNTIME_BRANCH: "master",
      RUNTIME_SHA: "a".repeat(40)
    };
    expect(isFullBuildRespecRuntime(identity)).toBe(true);
    expect(skillSystemV3RuntimeCapabilities(identity)).toEqual({
      fullBuildRespecAvailable: true,
      fullClassRosterEnabled: false,
      ultimatesEnabled: false
    });
    expect(isFullBuildRespecRuntime({ ...identity, RUNTIME_LABEL: "feature-runtime" })).toBe(false);
    expect(isFullBuildRespecRuntime({ ...identity, RUNTIME_BRANCH: "integration/test" })).toBe(false);
    const { RUNTIME_SHA: _sha, ...withoutSha } = identity;
    void _sha;
    expect(isFullBuildRespecRuntime(withoutSha)).toBe(false);
    expect(skillSystemV3RuntimeCapabilities({
      ...identity,
      RUNTIME_BRANCH: "release/production"
    })).toEqual({
      fullBuildRespecAvailable: false,
      fullClassRosterEnabled: false,
      ultimatesEnabled: false
    });
  });
});
