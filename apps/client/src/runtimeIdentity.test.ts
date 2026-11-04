import { describe, expect, it } from "vitest";

import { runtimeDocumentTitle } from "./config.js";

describe("client runtime identity", () => {
  it("adds an unobtrusive development identity to the title", () => {
    expect(runtimeDocumentTitle("Ash Atlas", {
      label: "water-visuals",
      branch: "feature/water-visuals",
      sha: "7a865825b7979afc1b83fe806aa94a5ff09a5c4c"
    })).toBe("Ash Atlas · water-visuals · 7a865825");
  });

  it("leaves production titles unchanged", () => {
    expect(runtimeDocumentTitle("Ash Atlas", null)).toBe("Ash Atlas");
  });
});
