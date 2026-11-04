import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const launcher = readFileSync(
  fileURLToPath(new URL("../../../../../tools/dev/run-main.ps1", import.meta.url)),
  "utf8"
);

describe("Classes launcher development progression environment", () => {
  it("starts both children in the normal development environment", () => {
    expect(launcher).toContain("${childDollar}env:NODE_ENV = 'development'");
    expect(launcher).toContain('$env:NODE_ENV = "development"');
  });
});
