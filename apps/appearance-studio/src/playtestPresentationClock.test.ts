import { describe, expect, it } from "vitest";
import { PlaytestPresentationClock } from "./playtestPresentationClock.js";
describe("sandbox presentation clock", () => {
  it("uses simulation speed, freezes on pause and never catches up paused/background time", () => {
    const clock = new PlaytestPresentationClock();
    clock.sync(1000, 2, false, 500);
    expect(clock.now(550)).toBe(1100);
    clock.sync(1100, 2, true, 550);
    expect(clock.now(10000)).toBe(1100);
    clock.sync(1100, .5, false, 10000);
    expect(clock.now(10050)).toBe(1125);
    expect(clock.now(50000)).toBe(1225);
  });
});
