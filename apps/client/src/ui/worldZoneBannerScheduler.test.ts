import type { WorldZoneBannerContent } from "@ash-atlas/shared";
import { describe, expect, it } from "vitest";

import {
  INITIAL_WORLD_ZONE_BANNER_STATE,
  markWorldZoneArrival,
  observeWorldZone,
  WORLD_ZONE_BANNER_ARRIVAL_DWELL_MS,
  WORLD_ZONE_BANNER_DWELL_MS,
  WORLD_ZONE_BANNER_REPEAT_COOLDOWN_MS,
  WORLD_ZONE_BANNER_SETTLE_MS,
  type WorldZoneBannerSchedulerState
} from "./worldZoneBannerScheduler.js";

const pinewild: WorldZoneBannerContent = { key: "pinewild", title: "Pinewild", detail: "Early Autumn · Highland" };
const plains: WorldZoneBannerContent = { key: "plains", title: "Plains", detail: "Early Autumn · Lowland" };

function run(
  steps: ReadonlyArray<readonly [number, WorldZoneBannerContent | null, boolean?]>,
  initial: WorldZoneBannerSchedulerState = INITIAL_WORLD_ZONE_BANNER_STATE
) {
  let state = initial;
  const shown: Array<[number, string]> = [];
  for (const [now, content, suppressed = false] of steps) {
    const decision = observeWorldZone(state, { now, content, suppressed });
    state = decision.state;
    if (decision.show) shown.push([now, decision.show.key]);
  }
  return { state, shown };
}

describe("world zone banner scheduler", () => {
  it("shows the first zone shortly after login", () => {
    expect(run([[0, pinewild], [WORLD_ZONE_BANNER_ARRIVAL_DWELL_MS, pinewild]]).shown)
      .toEqual([[WORLD_ZONE_BANNER_ARRIVAL_DWELL_MS, "pinewild"]]);
  });

  it("ignores a border crossing that does not last the dwell", () => {
    const { state } = run([[0, pinewild], [1_000, pinewild]]);
    const { shown } = run([
      [10_000, plains],
      [10_000 + WORLD_ZONE_BANNER_DWELL_MS - 1, pinewild],
      [20_000, pinewild]
    ], state);
    expect(shown).toEqual([]);
  });

  it("announces a zone that is held for the dwell", () => {
    const { state } = run([[0, pinewild], [1_000, pinewild]]);
    expect(run([[10_000, plains], [10_000 + WORLD_ZONE_BANNER_DWELL_MS, plains]], state).shown)
      .toEqual([[10_000 + WORLD_ZONE_BANNER_DWELL_MS, "plains"]]);
  });

  it("waits through combat and shows once play has settled", () => {
    const { state } = run([[0, pinewild], [1_000, pinewild]]);
    expect(run([
      [10_000, plains, true],
      [20_000, plains, true],
      [30_000, plains, false],
      [30_000 + WORLD_ZONE_BANNER_SETTLE_MS - 1, plains, false],
      [30_000 + WORLD_ZONE_BANNER_SETTLE_MS, plains, false]
    ], state).shown).toEqual([[30_000 + WORLD_ZONE_BANNER_SETTLE_MS, "plains"]]);
  });

  it("does not repeat a zone within the cooldown after going back and forth", () => {
    const { state } = run([[0, pinewild], [1_000, pinewild], [5_000, plains], [9_000, plains]]);
    expect(run([[20_000, pinewild], [24_000, pinewild]], state).shown).toEqual([]);
    const later = 1_000 + WORLD_ZONE_BANNER_REPEAT_COOLDOWN_MS;
    const back = run([[20_000, pinewild], [24_000, pinewild], [30_000, plains], [34_000, plains]], state);
    expect(run([[later, pinewild], [later + WORLD_ZONE_BANNER_DWELL_MS, pinewild]], back.state).shown)
      .toEqual([[later + WORLD_ZONE_BANNER_DWELL_MS, "pinewild"]]);
  });

  it("re-announces the same zone after travel once the cooldown has passed", () => {
    const { state } = run([[0, pinewild], [1_000, pinewild]]);
    const arrived = markWorldZoneArrival(state);
    const now = 1_000 + WORLD_ZONE_BANNER_REPEAT_COOLDOWN_MS;
    expect(run([[now, pinewild]], arrived).shown).toEqual([[now, "pinewild"]]);
  });
});
