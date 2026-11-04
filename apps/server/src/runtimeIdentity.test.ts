import { describe, expect, it } from "vitest";

import { loadConfig } from "./config.js";
import { developmentRuntimeIdentity, runtimeIdentity } from "./runtimeIdentity.js";

describe("development runtime identity", () => {
  const identity = {
    RUNTIME_LABEL: "water-visuals",
    RUNTIME_BRANCH: "feature/water-visuals",
    RUNTIME_SHA: "7a865825b7979afc1b83fe806aa94a5ff09a5c4c"
  };

  it("exposes an explicit launcher identity only in development", () => {
    expect(developmentRuntimeIdentity(loadConfig({ NODE_ENV: "development", ...identity })))
      .toEqual({
        label: "water-visuals",
        branch: "feature/water-visuals",
        sha: identity.RUNTIME_SHA
      });
  });

  it("does not expose development metadata in production", () => {
    expect(developmentRuntimeIdentity({ NODE_ENV: "production", ...identity })).toBeNull();
    expect(runtimeIdentity(identity)).toEqual({
      label: "water-visuals",
      branch: "feature/water-visuals",
      sha: identity.RUNTIME_SHA
    });
  });
});
