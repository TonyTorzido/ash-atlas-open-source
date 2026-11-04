import { describe, expect, it } from "vitest";

import { POPULATION_VISIBLE_PREPARATION_TERMINAL_MS } from "@ash-atlas/shared";

import { loadConfig } from "./config.js";

describe("population travel rollout configuration", () => {
  it("keeps hard preflight and new soft-path behavior disabled by default", () => {
    expect(loadConfig({ NODE_ENV: "test" })).toMatchObject({
      POPULATION_TRAVEL_PREFLIGHT_ENABLED: false,
      FLAG_VISIBLE_VISIT_PREPARATION_TTL_MS: 15_000,
      POPULATION_INFLIGHT_RESULT_REUSE_ENABLED: true,
      POPULATION_PROFILE_CLAIM_NOOP_FAST_PATH_ENABLED: true,
      POPULATION_SOFT_TRAVEL_PREPARE_ENABLED: false,
      POPULATION_SOFT_TRAVEL_ACTIVATION_LEAD_MS: 1_250,
      POPULATION_SOFT_TRAVEL_DURABLE_CONCURRENCY: 2,
      POPULATION_SOFT_TRAVEL_PROMOTION_CONCURRENCY: 1,
      POPULATION_SOFT_TRAVEL_RESERVATION_TTL_MS: 25_000,
      POPULATION_TELEPORT_PUBLICATION_COALESCING_ENABLED: false,
      POPULATION_TRAVEL_OPTIONAL_ARRIVAL_SEQUENCING_ENABLED: false
    });
  });

  it("keeps both measured cold-path fast paths independently reversible", () => {
    expect(loadConfig({
      NODE_ENV: "test",
      POPULATION_INFLIGHT_RESULT_REUSE_ENABLED: "false",
      POPULATION_PROFILE_CLAIM_NOOP_FAST_PATH_ENABLED: "false"
    })).toMatchObject({
      POPULATION_INFLIGHT_RESULT_REUSE_ENABLED: false,
      POPULATION_PROFILE_CLAIM_NOOP_FAST_PATH_ENABLED: false
    });
  });

  it("keeps the server presentation deadline ahead of the client watchdog", () => {
    expect(loadConfig({ NODE_ENV: "test" })).toMatchObject({
      POPULATION_V2_VISIBLE_PREPARATION_TERMINAL_MS:
        POPULATION_VISIBLE_PREPARATION_TERMINAL_MS
    });
    expect(() => loadConfig({
      NODE_ENV: "test",
      POPULATION_V2_VISIBLE_PREPARATION_TERMINAL_MS: "30000"
    })).toThrow();
  });

  it("allows each soft-path server switch to roll out independently", () => {
    const base = { NODE_ENV: "test" };
    expect(loadConfig({
      ...base,
      POPULATION_SOFT_TRAVEL_PREPARE_ENABLED: "true"
    })).toMatchObject({
      POPULATION_SOFT_TRAVEL_PREPARE_ENABLED: true,
      POPULATION_TELEPORT_PUBLICATION_COALESCING_ENABLED: false,
      POPULATION_TRAVEL_OPTIONAL_ARRIVAL_SEQUENCING_ENABLED: false
    });
    expect(loadConfig({
      ...base,
      POPULATION_TELEPORT_PUBLICATION_COALESCING_ENABLED: "true"
    })).toMatchObject({
      POPULATION_SOFT_TRAVEL_PREPARE_ENABLED: false,
      POPULATION_TELEPORT_PUBLICATION_COALESCING_ENABLED: true,
      POPULATION_TRAVEL_OPTIONAL_ARRIVAL_SEQUENCING_ENABLED: false
    });
    expect(loadConfig({
      ...base,
      POPULATION_TRAVEL_OPTIONAL_ARRIVAL_SEQUENCING_ENABLED: "true"
    })).toMatchObject({
      POPULATION_SOFT_TRAVEL_PREPARE_ENABLED: false,
      POPULATION_TELEPORT_PUBLICATION_COALESCING_ENABLED: false,
      POPULATION_TRAVEL_OPTIONAL_ARRIVAL_SEQUENCING_ENABLED: true
    });
  });
});
