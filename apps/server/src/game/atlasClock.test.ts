import { describe, expect, it } from "vitest";

import {
  AtlasClock,
  daysBetweenIsoDates,
  mountainDateTime,
  mountainWeek,
  shiftIsoDate
} from "./atlasClock.js";

describe("AtlasClock", () => {
  it("uses America/Denver with real MST and MDT offsets", () => {
    expect(mountainDateTime(new Date("2026-01-19T12:00:00.000Z"))).toEqual({
      date: "2026-01-19",
      time: "05:00:00.000",
      offset: "-07:00",
      localIso: "2026-01-19T05:00:00.000-07:00"
    });
    expect(mountainDateTime(new Date("2026-07-19T12:00:00.000Z"))).toEqual({
      date: "2026-07-19",
      time: "06:00:00.000",
      offset: "-06:00",
      localIso: "2026-07-19T06:00:00.000-06:00"
    });
  });

  it("keeps one logical date through DST jumps and changes only at Mountain midnight", () => {
    expect(mountainDateTime(new Date("2026-03-08T08:59:59.999Z")).date).toBe("2026-03-08");
    expect(mountainDateTime(new Date("2026-03-08T09:00:00.000Z")).date).toBe("2026-03-08");
    expect(mountainDateTime(new Date("2026-11-01T07:59:59.999Z")).date).toBe("2026-11-01");
    expect(mountainDateTime(new Date("2026-11-01T08:00:00.000Z")).date).toBe("2026-11-01");
    expect(mountainDateTime(new Date("2026-07-20T05:59:59.999Z")).date).toBe("2026-07-19");
    expect(mountainDateTime(new Date("2026-07-20T06:00:00.000Z")).date).toBe("2026-07-20");
  });

  it("applies debug shifts as calendar days without touching the authoritative instant", () => {
    const clock = new AtlasClock(() => new Date("2026-07-19T12:00:00.000Z"));
    expect(clock.now().toISOString()).toBe("2026-07-19T12:00:00.000Z");
    expect(shiftIsoDate(clock.mountainNow().date, 7)).toBe("2026-07-26");
    expect(daysBetweenIsoDates("2026-07-19", "2026-07-26")).toBe(7);
  });

  it.each([
    ["MST Sunday 11:58 PM", "2026-01-19T06:58:00.000Z", "2026-01-12"],
    ["MST Sunday 11:59 PM", "2026-01-19T06:59:00.000Z", "2026-01-12"],
    ["MST Monday midnight", "2026-01-19T07:00:00.000Z", "2026-01-19"],
    ["MDT Sunday 11:58 PM", "2026-07-20T05:58:00.000Z", "2026-07-13"],
    ["MDT Sunday 11:59 PM", "2026-07-20T05:59:00.000Z", "2026-07-13"],
    ["MDT Monday midnight", "2026-07-20T06:00:00.000Z", "2026-07-20"]
  ])("assigns %s to the deterministic Mountain week", (_label, instant, weekStart) => {
    expect(mountainWeek(new Date(instant)).weekStart).toBe(weekStart);
  });

  it("returns exact half-open week instants across MST, MDT, and restart", () => {
    const mst = mountainWeek(new Date("2026-01-15T18:00:00.000Z"));
    expect(mst.weekStartAt.toISOString()).toBe("2026-01-12T07:00:00.000Z");
    expect(mst.nextWeekStartAt.toISOString()).toBe("2026-01-19T07:00:00.000Z");

    const mdtInstant = new Date("2026-07-16T18:00:00.000Z");
    const beforeRestart = mountainWeek(mdtInstant);
    const afterRestart = mountainWeek(new Date(mdtInstant.toISOString()));
    expect(afterRestart).toEqual(beforeRestart);
    expect(beforeRestart.weekStartAt.toISOString()).toBe("2026-07-13T06:00:00.000Z");
    expect(beforeRestart.nextWeekStartAt.toISOString()).toBe("2026-07-20T06:00:00.000Z");
  });
});
