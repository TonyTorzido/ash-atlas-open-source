// @vitest-environment jsdom

import { act, cleanup, render, renderHook, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HUD_NOTICE_LIFETIME_MS,
  HudNoticeStack,
  pruneHudNotices,
  pushHudNotices,
  useHudNoticeQueue
} from "./HudNoticeLane.js";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("HUD notice lane queue", () => {
  const ids = () => { let id = 0; return () => (id += 1); };

  it("keeps one line per notice, merges only exact duplicates and caps at three", () => {
    const nextId = ids();
    let queue = pushHudNotices([], [
      { text: "Bone Guard defeated.", tone: "success" },
      { text: "Bone Guard defeated.", tone: "success" },
      { text: "Bone Guard defeated.", tone: "warning" }
    ], 0, nextId);
    expect(queue.map((notice) => [notice.text, notice.tone, notice.count]))
      .toEqual([["Bone Guard defeated.", "success", 2], ["Bone Guard defeated.", "warning", 1]]);
    queue = pushHudNotices(queue, [{ text: "A" }, { text: "B" }], 10, nextId);
    expect(queue.map((notice) => notice.text)).toEqual(["Bone Guard defeated.", "A", "B"]);
  });

  it("fades each notice after about 3.5 seconds", () => {
    const queue = pushHudNotices([], [{ text: "Hall cleared." }], 100, ids());
    expect(pruneHudNotices(queue, 100 + HUD_NOTICE_LIFETIME_MS - 1)).toHaveLength(1);
    expect(pruneHudNotices(queue, 100 + HUD_NOTICE_LIFETIME_MS)).toHaveLength(0);
    expect(HUD_NOTICE_LIFETIME_MS).toBe(3_500);
  });

  it("expires notices on its own timer and renders a polite status list", () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useHudNoticeQueue());
    act(() => result.current.push([{ text: "Dungeon complete.", tone: "success" }]));
    render(<HudNoticeStack notices={result.current.notices} label="Dungeon notices" />);
    const status = screen.getByRole("status", { name: "Dungeon notices" });
    expect(status.getAttribute("aria-live")).toBe("polite");
    expect(status.textContent).toBe("Dungeon complete.");
    act(() => { vi.advanceTimersByTime(HUD_NOTICE_LIFETIME_MS + 50); });
    expect(result.current.notices).toHaveLength(0);
  });
});
