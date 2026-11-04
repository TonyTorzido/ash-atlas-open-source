import { describe, expect, it } from "vitest";

import { DEV_MATERIALS } from "./DeveloperToolsPanel.js";

describe("Developer Economy material picker", () => {
  it("offers Fertilizer while keeping retired Food out", () => {
    expect(DEV_MATERIALS).toContain("fertilizer");
    expect(DEV_MATERIALS).not.toContain("food");
    expect(DEV_MATERIALS).toContain("simple_food");
  });
});
