// @vitest-environment jsdom
import { LEGEND_CATALOG, type AchievementSnapshot, type LegendJournalSnapshot } from "@ash-atlas/shared";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AchievementsContent } from "./AchievementsPanel.js";
import { JournalProgress, LegendJournalView } from "./LegendJournalContent.js";

const snapshot = (playerId = "player-one"): LegendJournalSnapshot => ({
  playerId, metrics: {}, completed: {}, newlyCompletedIds: [], serverTime: 1_800_000_000_000
});
const poison = (value: number, completedAt: string | null = null, playerId = "player-one"): AchievementSnapshot => ({
  playerId, serverTime: 1_800_000_000_000, achievements: [{
    achievementId: "bitter_blood", title: "Bitter Blood", badgeId: "bitter_blood", completed: !!completedAt,
    completedAt, statKey: "poison_damage_taken", value, requiredValue: 250
  }]
});
const response = (data = snapshot()) => ({ ok: true, json: async () => data });
const record = (id: string): HTMLElement => document.querySelector('[data-legend-id="' + id + '"]')!;
/** Opens a goal row and returns its detail sheet. */
const openRecord = (id: string): HTMLElement => {
  fireEvent.click(record(id).querySelector(".legend-journal-record-open")!);
  const title = LEGEND_CATALOG.find((entry) => entry.id === id)!.title;
  return screen.getByRole("complementary", { name: title + " details" });
};
const closeSheet = () => fireEvent.click(document.querySelector(".skill-v3-sheet-scrim")!);
const search = (value: string) => fireEvent.change(screen.getByRole("searchbox", { name: "Search journal" }), { target: { value } });
const pinnedRows = () => screen.getByRole("region", { name: "Pinned goals" }).querySelectorAll("[data-legend-id]");

beforeEach(() => {
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("Legends journal", () => {
  it("integrates Bitter Blood into search, filters, pins, counters and live completion exactly once", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response()));
    const { rerender } = render(<AchievementsContent serverHttpBase="https://atlas.example" playerId="player-one" achievements={poison(184)} />);
    await screen.findByRole("heading", { name: "Wayfarer" });
    expect(screen.getByText(/Each goal completes once.*three chapters/)).toBeTruthy();
    expect(screen.queryByRole("tablist", { name: "Journal views" })).toBeNull();
    expect(document.querySelectorAll('[data-legend-id="bitter_blood"]')).toHaveLength(1);
    search("Venom Core");
    fireEvent.change(screen.getByRole("combobox", { name: "Difficulty" }), { target: { value: "Veteran" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Status" }), { target: { value: "in-progress" } });
    expect(document.querySelectorAll("[data-legend-id]")).toHaveLength(1);
    const sheet = openRecord("bitter_blood");
    expect(within(sheet).getByRole("progressbar").getAttribute("aria-valuenow")).toBe("74");
    expect(within(sheet).getByText(/Venom Core.*Venomsteel/)).toBeTruthy();
    fireEvent.click(within(sheet).getByRole("button", { name: "Pin Bitter Blood" }));
    closeSheet();
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(pinnedRows()).toHaveLength(1);
    rerender(<AchievementsContent serverHttpBase="https://atlas.example" playerId="player-one" achievements={poison(250)} />);
    expect(within(record("bitter_blood")).getByRole("progressbar").getAttribute("aria-valuenow")).toBe("100");
    expect(record("bitter_blood").textContent).toContain("Awaiting confirmation");
    rerender(<AchievementsContent serverHttpBase="https://atlas.example" playerId="player-one" achievements={poison(250, "2026-09-01T00:00:00.000Z")} />);
    expect(record("bitter_blood").dataset.state).toBe("completed");
    expect(screen.queryByText(/Newly recorded: Bitter Blood/)).toBeNull();
    rerender(<AchievementsContent serverHttpBase="https://atlas.example" playerId="player-one" achievements={poison(10)} />);
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await screen.findByRole("button", { name: "Refresh" });
    expect(record("bitter_blood").dataset.state).toBe("completed");
    expect(screen.getByText("25 prestige")).toBeTruthy();
    const count = screen.getByText("Achievements", { selector: "dt" }).nextElementSibling;
    expect(count?.textContent).toBe("1 / " + LEGEND_CATALOG.filter((entry) => entry.kind === "achievement").length);
    search("Bitter Blood");
    fireEvent.change(screen.getByRole("combobox", { name: "Status" }), { target: { value: "completed" } });
    expect(document.querySelectorAll('[data-legend-id="bitter_blood"]')).toHaveLength(1);
  });

  it("does not import another character's poison progress, unlock or pinned goal", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(snapshot("player-two"))));
    localStorage.setItem("ash-atlas:legend-pins:v1:player-one", JSON.stringify(["bitter_blood"]));
    render(<AchievementsContent serverHttpBase="https://atlas.example" playerId="player-two" achievements={poison(250, "2026-09-01T00:00:00.000Z")} />);
    await screen.findByRole("heading", { name: "Wayfarer" });
    expect(screen.getByText("0 prestige")).toBeTruthy();
    expect(screen.getByText(/No pinned goals yet/)).toBeTruthy();
    search("Bitter Blood");
    const row = record("bitter_blood");
    expect(row.dataset.state).toBe("in-progress");
    expect(within(row).getByRole("progressbar").getAttribute("aria-valuenow")).toBe("0");
  });

  it("leaves Bitter Blood unlock announcements to the existing gameplay notification", () => {
    render(<LegendJournalView snapshot={{ ...snapshot(), completed: { bitter_blood: "2026-09-01T00:00:00.000Z" }, newlyCompletedIds: ["bitter_blood"] }} />);
    expect(screen.queryByText(/Newly recorded: Bitter Blood/)).toBeNull();
  });

  it("opens categories as their own page and bounds long result lists", () => {
    const target = LEGEND_CATALOG.find((entry) => entry.kind === "achievement")!;
    const onBackChange = vi.fn();
    render(<LegendJournalView snapshot={{ ...snapshot(), completed: { [target.id]: "2026-09-01T00:00:00.000Z" } }} onBackChange={onBackChange} />);
    const categories = screen.getByRole("region", { name: "Journal categories" });
    const inCategory = LEGEND_CATALOG.filter((entry) => entry.kind === "achievement" && entry.category === target.category);
    fireEvent.click(within(categories).getByRole("button", { name: target.category + ", 1 of " + inCategory.length + " complete" }));
    expect(screen.getByRole("heading", { name: target.category })).toBeTruthy();
    expect(record(target.id).dataset.state).toBe("completed");
    expect(onBackChange).toHaveBeenLastCalledWith(expect.objectContaining({ label: "Back to Achievements" }));
    openRecord(target.id);
    expect(onBackChange).toHaveBeenLastCalledWith(expect.objectContaining({ label: "Back to " + target.category }));
    act(() => onBackChange.mock.lastCall![0].onBack());
    act(() => onBackChange.mock.lastCall![0].onBack());
    expect(screen.getByRole("region", { name: "Journal categories" })).toBeTruthy();

    fireEvent.change(screen.getByRole("combobox", { name: "Status" }), { target: { value: "in-progress" } });
    expect(document.querySelectorAll("[data-legend-id]")).toHaveLength(12);
    fireEvent.click(screen.getByRole("button", { name: "Show 12 more" }));
    expect(document.querySelectorAll("[data-legend-id]")).toHaveLength(24);
    search(target.title);
    fireEvent.change(screen.getByRole("combobox", { name: "Difficulty" }), { target: { value: target.difficulty } });
    expect(screen.getByText("No goals match these filters.")).toBeTruthy();
    fireEvent.change(screen.getByRole("combobox", { name: "Status" }), { target: { value: "completed" } });
    expect(record(target.id)?.dataset.state).toBe("completed");
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(screen.getByRole("region", { name: "Journal categories" })).toBeTruthy();
  });

  it("shows locked quest predecessors and every objective without treating metrics as completion", () => {
    const target = LEGEND_CATALOG.find((entry) => entry.kind === "quest" && entry.requires?.length && entry.objectives.length > 1)!;
    const metrics = Object.fromEntries(target.objectives.map((objective) => [objective.metric, objective.target * 2]));
    render(<LegendJournalView snapshot={{ ...snapshot(), metrics }} />);
    fireEvent.click(within(screen.getByRole("region", { name: "Journal categories" })).getByRole("button", { name: /^Quest journeys/ }));
    search(target.title);
    expect(record(target.id).dataset.state).toBe("locked");
    const sheet = openRecord(target.id);
    expect(within(sheet).getByText(/Chapter locked/)).toBeTruthy();
    for (const id of target.requires!) expect(sheet.textContent).toContain(LEGEND_CATALOG.find((entry) => entry.id === id)!.title);
    const bars = within(sheet).getAllByRole("progressbar");
    expect(bars).toHaveLength(target.objectives.length);
    bars.forEach((bar) => {
      expect(bar.getAttribute("aria-valuenow")).toBe("100");
      expect(bar.getAttribute("aria-valuemax")).toBe("100");
    });
    expect(sheet.textContent).toContain("Recorded progress is kept.");
  });

  it("pins at most three goals, reopens saved pins and isolates a changed character", async () => {
    const first = LEGEND_CATALOG.filter((entry) => entry.kind === "achievement").slice(0, 4);
    const { unmount } = render(<LegendJournalView snapshot={snapshot()} />);
    for (const target of first.slice(0, 3)) {
      search(target.title);
      fireEvent.click(within(openRecord(target.id)).getByRole("button", { name: "Pin " + target.title }));
      closeSheet();
    }
    search(first[3]!.title);
    expect((within(openRecord(first[3]!.id)).getByRole("button", { name: "Pin " + first[3]!.title }) as HTMLButtonElement).disabled).toBe(true);
    closeSheet();
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(pinnedRows()).toHaveLength(3);
    unmount();
    const second = render(<LegendJournalView snapshot={snapshot("player-two")} />);
    expect(screen.getByText(/No pinned goals yet/)).toBeTruthy();
    second.unmount();
    render(<LegendJournalView snapshot={snapshot()} />);
    expect(pinnedRows()).toHaveLength(3);
  });

  it("clamps determinate progress and keeps the original Bitter Blood unlock", () => {
    const { rerender } = render(<JournalProgress label="An objective" value={-5} target={10} />);
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("0");
    rerender(<AchievementsContent achievements={{ playerId: "player-one", serverTime: 0, achievements: [{
      achievementId: "bitter_blood", title: "Bitter Blood", badgeId: "bitter_blood", completed: false, completedAt: null,
      statKey: "poison_damage_taken", value: 184, requiredValue: 250
    }] }} />);
    expect(screen.getByText("Take 250 poison damage")).toBeTruthy();
    expect(screen.getByRole("progressbar", { name: "Bitter Blood progress" }).getAttribute("aria-valuenow")).toBe("74");
    expect(screen.getByText(/Venom Core application and eligibility to equip Venomsteel gear/)).toBeTruthy();
  });

  it("retains stale progress after refresh failure and retries successfully", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(response()).mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(response());
    vi.stubGlobal("fetch", fetchMock);
    render(<AchievementsContent serverHttpBase="https://atlas.example" playerId="player-one" achievements={null} />);
    await screen.findByRole("heading", { name: "Wayfarer" });
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Showing last confirmed progress.");
    expect(screen.getByRole("heading", { name: "Wayfarer" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByRole("button", { name: "Refresh" });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("refreshes every 30 seconds only while visible, reconciles resume and aborts unmount without overlap", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValue(response());
    vi.stubGlobal("fetch", fetchMock);
    const { unmount } = render(<AchievementsContent serverHttpBase="https://atlas.example" playerId="player-one" achievements={null} />);
    await act(async () => {});
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(29_999); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    fireEvent(document, new Event("visibilitychange"));
    await act(async () => { await vi.advanceTimersByTimeAsync(90_000); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    fetchMock.mockImplementationOnce((_url: unknown, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
    }));
    fireEvent(document, new Event("visibilitychange"));
    await act(async () => {});
    expect(fetchMock).toHaveBeenCalledTimes(3);
    fireEvent(window, new Event("online"));
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const signal = fetchMock.mock.calls[2]![1].signal as AbortSignal;
    unmount();
    expect(signal.aborted).toBe(true);
    await act(async () => {});
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("times out a stalled request and allows an explicit retry", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockImplementationOnce((_url: unknown, init: RequestInit) =>
      new Promise((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError"))))
    ).mockResolvedValueOnce(response());
    vi.stubGlobal("fetch", fetchMock);
    render(<AchievementsContent serverHttpBase="https://atlas.example" playerId="player-one" achievements={null} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    expect(screen.getByRole("alert").textContent).toContain("took too long");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await act(async () => {});
    expect(screen.getByRole("heading", { name: "Wayfarer" })).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("aborts the previous character request and never accepts a mismatched identity", async () => {
    let firstSignal: AbortSignal | undefined;
    const fetchMock = vi.fn().mockImplementationOnce((_url: unknown, init: RequestInit) => {
      firstSignal = init.signal as AbortSignal;
      return new Promise((_resolve, reject) => firstSignal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError"))));
    }).mockResolvedValueOnce(response(snapshot("player-one")));
    vi.stubGlobal("fetch", fetchMock);
    const { rerender } = render(<AchievementsContent serverHttpBase="https://atlas.example" playerId="player-one" achievements={null} />);
    rerender(<AchievementsContent serverHttpBase="https://atlas.example" playerId="player-two" achievements={null} />);
    expect(firstSignal?.aborted).toBe(true);
    expect((await screen.findByRole("alert")).textContent).toContain("Your character changed.");
    expect(screen.queryByRole("heading", { name: "Wayfarer" })).toBeNull();
  });
});
