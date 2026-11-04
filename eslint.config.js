import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/coverage/**",
      "**/playwright/.cache/**",
      "**/test-results/**",
      "**/playwright-report/**"
    ]
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["*.js", "tools/**/*.mjs", "scripts/**/*.mjs", "apps/server/tools/**/*.mjs"],
    languageOptions: { globals: globals.node }
  },
  {
    files: ["apps/client/public/sw.js"],
    languageOptions: { globals: globals.serviceworker }
  },
  {
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: [
            "tools/simulation/persistentPopulationV2Simulation.ts",
            "tools/simulation/persistentPopulationV2Simulation.test.ts",
            "tools/benchmarks/populationStreamingLoadHarness.ts",
            "tools/benchmarks/populationV2BootstrapBaseline.ts",
            "tools/appearance-studio/verify-catalog.ts",
            "tools/wiki/sync.ts",
            "capacitor.config.ts",
            "tools/flag-pack/flag-pack.ts"
          ]
        },
        tsconfigRootDir: import.meta.dirname
      },
      globals: {
        ...globals.browser,
        ...globals.node
      }
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/consistent-type-imports": "error"
    }
  }
);

