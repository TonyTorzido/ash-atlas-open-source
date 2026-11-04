import { describe, expect, it } from "vitest";

import {
  WORLD_TIME_ANCHOR_ISO,
  WORLD_TIME_CYCLE_MS,
  worldTimeAt
} from "./worldTime.js";

const anchor = Date.parse(WORLD_TIME_ANCHOR_ISO);

describe("world time", () => {
  it.each([
    ["2026-01-01T07:00:00.000Z", 360, "6:00 AM", "day", "DAY", 1],
    ["2026-01-01T11:45:00.000Z", 1215, "8:15 PM", "dusk", "DAY", 0.25],
    ["2026-01-01T12:00:00.000Z", 1260, "9:00 PM", "night", "NIGHT", 0],
    ["2026-01-01T14:45:00.000Z", 315, "5:15 AM", "dawn", "NIGHT", 0.75],
    ["2026-01-01T15:00:00.000Z", 360, "6:00 AM", "day", "DAY", 1]
  ])("maps %s to the exact game clock", (
    iso,
    gameMinutes,
    formattedLabel,
    phase,
    mechanicalPhase,
    daylightIntensity
  ) => {
    expect(worldTimeAt(new Date(iso))).toEqual({
      gameMinutes,
      formattedLabel,
      phase,
      mechanicalPhase,
      daylightIntensity
    });
  });

  it.each([
    [4 * 60, "6:00 PM", "dusk", "DAY"],
    [5 * 60, "9:00 PM", "night", "NIGHT"],
    [7 * 60, "3:00 AM", "dawn", "NIGHT"],
    [8 * 60, "6:00 AM", "day", "DAY"]
  ])("uses exact phase boundaries after %i elapsed minutes", (
    elapsedMinutes,
    formattedLabel,
    phase,
    mechanicalPhase
  ) => {
    expect(worldTimeAt(anchor + elapsedMinutes * 60_000))
      .toMatchObject({ formattedLabel, phase, mechanicalPhase });
  });

  it("is invariant for the same instant and repeats every exact eight hours", () => {
    const instant = Date.parse("2032-08-26T19:17:43.812Z");
    expect(worldTimeAt(new Date(instant))).toEqual(worldTimeAt(instant));
    expect(worldTimeAt(instant + WORLD_TIME_CYCLE_MS)).toEqual(
      worldTimeAt(instant)
    );
  });
});
