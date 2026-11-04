// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AchievementSnapshot, LegendJournalSnapshot } from "@ash-atlas/shared";
import { loadLegendJournal, mergeLiveAchievements, readLegendPins, saveLegendPins } from "./legendJournalClient.js";

afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); });

const journal = (playerId: string): LegendJournalSnapshot => ({
  playerId, metrics: {}, completed: {}, newlyCompletedIds: [], serverTime: 0
});
const poison = (playerId: string, value: number, completedAt: string | null = null): AchievementSnapshot => ({
  playerId, serverTime: 0, achievements: [{
    achievementId: "bitter_blood", title: "Bitter Blood", badgeId: "bitter_blood",
    completed: !!completedAt, completedAt, statKey: "poison_damage_taken", value, requiredValue: 250
  }]
});

describe("legend journal client", () => {
  it("merges live poison progress without inferring completion or announcing the existing unlock", () => {
    const live = mergeLiveAchievements(journal("one"), poison("one", 300));
    expect(live.metrics.poison_damage_taken).toBe(300);
    expect(live.completed.bitter_blood).toBeUndefined();
    expect(live.newlyCompletedIds).toEqual([]);
    const earned = mergeLiveAchievements(live, poison("one", 300, "2026-09-01T00:00:00.000Z"));
    expect(earned.completed.bitter_blood).toBe("2026-09-01T00:00:00.000Z");
    expect(earned.newlyCompletedIds).toEqual([]);
  });

  it("retains a persisted completion and the larger poison counter across stale responses", () => {
    const persisted = { ...journal("one"), metrics: { poison_damage_taken: 400 }, completed: { bitter_blood: "2026-08-01T00:00:00.000Z" } };
    const merged = mergeLiveAchievements(journal("one"), poison("one", 184), persisted);
    expect(merged.completed.bitter_blood).toBe(persisted.completed.bitter_blood);
    expect(merged.metrics.poison_damage_taken).toBe(400);
    expect(mergeLiveAchievements(persisted, poison("one", 500, "2026-09-01T00:00:00.000Z")).completed.bitter_blood).toBe(persisted.completed.bitter_blood);
  });

  it("ignores live and retained progress from a different character", () => {
    const other = { ...journal("one"), metrics: { poison_damage_taken: 500 }, completed: { bitter_blood: "2026-08-01T00:00:00.000Z" } };
    const current = journal("two");
    expect(mergeLiveAchievements(current, poison("one", 500, "2026-09-01T00:00:00.000Z"), other)).toBe(current);
  });
  it("loads the authenticated journal, passes abort, and rejects malformed progress", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ playerId: "one", metrics: {}, completed: {}, newlyCompletedIds: [], serverTime: 0 }) });
    vi.stubGlobal("fetch", fetchMock);
    const signal = new AbortController().signal;
    expect((await loadLegendJournal("https://atlas.example", signal)).playerId).toBe("one");
    expect(fetchMock).toHaveBeenCalledWith(new URL("https://atlas.example/api/legends"), { credentials: "include", signal });
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ playerId: "one" }) });
    await expect(loadLegendJournal("https://atlas.example", signal)).rejects.toThrow("could not be read");
  });

  it("keeps pins isolated by account and discards corrupt, duplicate, unknown, and excessive pins", () => {
    const ids = new Set(["a", "b", "c", "d"]);
    saveLegendPins("one", ["a", "b"]);
    saveLegendPins("two", ["c"]);
    expect(readLegendPins("one", ids)).toEqual(["a", "b"]);
    expect(readLegendPins("two", ids)).toEqual(["c"]);
    localStorage.setItem("ash-atlas:legend-pins:v1:one", JSON.stringify(["a", "a", "unknown", 7, "b", "c", "d"]));
    expect(readLegendPins("one", ids)).toEqual(["a", "b", "c"]);
    localStorage.setItem("ash-atlas:legend-pins:v1:two", "not json");
    expect(readLegendPins("two", ids)).toEqual([]);
  });
});
