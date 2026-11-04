import { existsSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const source = (relative: string): string =>
  readFileSync(new URL(relative, import.meta.url), "utf8");

describe("Population v2-only live architecture", () => {
  it("does not compose the legacy generator or rollout-derived v1 authority", () => {
    const application = source("../application.ts");

    expect(application).not.toContain("EnvironmentalPopulationService");
    expect(application).not.toContain("populationV1Authority");
    expect(application).not.toContain("environmentalPopulation");
  });

  it("has no legacy collectible or mine generation switch in production", () => {
    const application = source("../application.ts");
    const collectibles = source("./collectibles.ts");
    const repeatableResources = source("./repeatableResources.ts");

    expect(application).toMatch(/new CollectibleService\([\s\S]*?logger\s*\)/u);
    expect(application).toMatch(
      /new RepeatableResourceService\(\s*pool,\s*inventory,\s*masteries,\s*undefined,\s*new PermanentResourceLifecycleService\(pool,\s*undefined,\s*logger\)\s*\)/u
    );
    expect(collectibles).not.toContain("legacyGenerationEnabled");
    expect(collectibles).not.toContain("generateNodesForVision");
    expect(repeatableResources).not.toContain("legacyGenerationEnabled");
    expect(repeatableResources).not.toContain("materializeForVision");
    expect(source("../http/routes.ts")).not.toContain("environmentalPopulation");
    expect(source("../realtime/websocket.ts")).not.toContain("environmentalPopulation");
  });

  it("has no selectable, serving, restoration, or generation implementation for v1", () => {
    for (const relative of [
      "./environmentalPopulation.ts",
      "./populationZonesV2Rollout.ts",
      "./populationZonesV2Operations.ts",
      "../http/populationZonesV2RolloutRoutes.ts"
    ]) {
      expect(existsSync(new URL(relative, import.meta.url))).toBe(false);
    }
    const backend = source("./populationZonesV2Backend.ts");
    expect(backend).not.toContain("PopulationZoneV1");
    expect(backend).not.toContain("reconcileServingChange");
    expect(backend).not.toContain("servingVersion");
  });

  it("requires a real backend from production composition", () => {
    const application = source("../application.ts");
    const composition = source("./populationZonesV2Composition.ts");

    expect(application).not.toContain(
      "createDisabledDevelopmentPopulationZonesV2Composition"
    );
    expect(composition).toContain(
      "Population v2 production composition requires an exact game RUNTIME_SHA"
    );
    expect(composition).not.toContain("EXPLICIT_DISABLED_DEVELOPMENT_BACKEND");
    expect(composition).not.toContain("createDisabledDevelopment");
  });

  it("deploys an explicit population-only reset while retaining unrelated data", () => {
    const migration = source(
      "../../../../db/migrations/0671_population_v2_generation_lifecycle.sql"
    );

    expect(migration).toContain("DROP TABLE IF EXISTS environmental_population_areas");
    expect(migration).toContain("CREATE TABLE population_zone_generations_v2");
    expect(migration).not.toContain("DELETE FROM players");
    expect(migration).not.toContain("DELETE FROM flags");
    expect(migration).not.toContain("DELETE FROM player_inventory");
  });
});
