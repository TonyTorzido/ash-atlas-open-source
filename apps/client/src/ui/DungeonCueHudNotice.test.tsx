import { describe, expect, it } from "vitest";
import {
  friendlyDungeonCue,
  newDungeonCues,
  newDungeonNotices
} from "./DungeonCueHudNotice.js";

describe("dungeon cue notice helpers", () => {
  it("shows friendly text and only reports newly appended cues", () => {
    expect(friendlyDungeonCue("boss_awakens")).toBe("Boss awakens");
    expect(newDungeonCues([], ["a"])).toEqual(["a"]);
    expect(newDungeonCues(["a"], ["a", "a"])).toEqual(["a"]);
    expect(newDungeonCues(["a", "b"], ["a", "b"])).toEqual([]);
    expect(newDungeonCues(["a", "b"], ["b", "c"])).toEqual(["c"]);
  });

  it("only surfaces notices newer than the baseline", () => {
    const notices = [
      { id: 1, text: "Room cleared.", tone: "success" as const },
      { id: 2, text: "The Ossuary door grinds open.", tone: "info" as const }
    ];
    expect(newDungeonNotices(null, notices)).toEqual([]);
    expect(newDungeonNotices(1, notices)).toEqual([notices[1]]);
    expect(newDungeonNotices(2, notices)).toEqual([]);
    expect(newDungeonNotices(0, undefined)).toEqual([]);
  });
});
