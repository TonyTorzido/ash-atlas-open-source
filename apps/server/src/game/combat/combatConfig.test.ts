import { describe, expect, it } from "vitest";

import {
  DEFAULT_COMBAT_DELTA_HZ,
  DEFAULT_COMBAT_INTEREST_RADIUS_M,
  DEFAULT_COMBAT_SPATIAL_CELL_M,
  DEFAULT_PLAYER_BASIC_DAMAGE,
  DEFAULT_PLAYER_MAX_HEALTH
} from "@ash-atlas/shared";
import { loadConfig } from "../../config.js";

describe("combat configuration", () => {
  it("uses centralized production-shaped defaults", () => {
    const config = loadConfig({ NODE_ENV: "test" });
    expect(config.COMBAT_PLAYER_MAX_HEALTH).toBe(DEFAULT_PLAYER_MAX_HEALTH);
    expect(config.COMBAT_PLAYER_BASIC_DAMAGE).toBe(DEFAULT_PLAYER_BASIC_DAMAGE);
    expect(config.COMBAT_SPATIAL_CELL_M).toBe(DEFAULT_COMBAT_SPATIAL_CELL_M);
    expect(config.COMBAT_INTEREST_RADIUS_M).toBe(DEFAULT_COMBAT_INTEREST_RADIUS_M);
    expect(config.COMBAT_DELTA_HZ).toBe(DEFAULT_COMBAT_DELTA_HZ);
    expect(config.WORLD_DELTA_HZ).toBe(20);
    expect(config.WORLD_COMMAND_QUEUE_GLOBAL_MAX).toBe(4_096);
    expect(config.WORLD_COMMAND_QUEUE_PER_PLAYER_MAX).toBe(32);
    expect(config.WORLD_COMMANDS_PER_TICK_MAX).toBe(1_024);
    expect(config.WS_BACKPRESSURE_HARD_BYTES).toBeGreaterThan(
      config.WS_BACKPRESSURE_SOFT_BYTES
    );
  });
});
