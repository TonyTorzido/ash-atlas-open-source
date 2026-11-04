import { defineConfig } from "@playwright/experimental-ct-react";

export default defineConfig({
  testDir: "./browser-tests",
  timeout: 30_000,
  fullyParallel: false,
  use: {
    trace: "retain-on-failure",
    viewport: { width: 1280, height: 900 },
    ctViteConfig: {
      resolve: {
        conditions: ["browser", "import", "module"]
      }
    }
  }
});
