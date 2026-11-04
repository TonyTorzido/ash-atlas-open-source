import { configDefaults, defineConfig, mergeConfig } from "vitest/config";

import viteConfig from "./vite.config.js";

export default defineConfig((env) => mergeConfig(viteConfig(env), {
  test: {
    // These suites belong to the dedicated Playwright runners.
    exclude: [...configDefaults.exclude, "browser-tests/**", "full-app-tests/**"]
  }
}));
