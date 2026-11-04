import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./full-app-tests",
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  use: {
    trace: "retain-on-failure"
  }
});
