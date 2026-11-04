import { describe, expect, it } from "vitest";

import {
  POPULATION_VISIBLE_PREPARATION_TERMINAL_MS,
  WORLD_PRESENTATION_CLIENT_TIMEOUT_MS
} from "./worldView.js";

describe("world presentation timing contract", () => {
  it("degrades server-side with clear headroom before the client watchdog", () => {
    expect(POPULATION_VISIBLE_PREPARATION_TERMINAL_MS)
      .toBeLessThan(WORLD_PRESENTATION_CLIENT_TIMEOUT_MS);
    expect(
      WORLD_PRESENTATION_CLIENT_TIMEOUT_MS
      - POPULATION_VISIBLE_PREPARATION_TERMINAL_MS
    ).toBeGreaterThanOrEqual(5_000);
  });
});
