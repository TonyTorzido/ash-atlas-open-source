// @vitest-environment jsdom

import {
  WEEKLY_LEADERBOARD_CATEGORIES,
  type FishingRecordSnapshot,
  type WeeklyLeaderboardSnapshot
} from "@ash-atlas/shared";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { WeeklyLeaderboardsPanel, formatRemaining } from "./WeeklyLeaderboardsPanel.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("WeeklyLeaderboardsPanel", () => {
  it("loads bounded server rankings, highlights self, pins an outside-top-100 rank, and opens player actions", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(snapshot()), {
      status: 200,
      headers: { "content-type": "application/json" }
    })));
    const openPlayer = vi.fn();
    render(
      <WeeklyLeaderboardsPanel
        open
        layout="desktop"
        serverHttpBase="https://game.example/"
        ownPlayerId="self"
        connected
        onClose={vi.fn()}
        onOpenPlayer={openPlayer}
      />
    );

    expect(screen.getByText("Loading weekly rankings…")).toBeTruthy();
    await waitFor(() => expect(screen.getByText("Rival")).toBeTruthy());
    expect(screen.getByRole("button", { name: "Trees Chopped" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Mysterious Travelers" })).toBeNull();
    expect(screen.queryByText("Public Chat Messages")).toBeNull();
    expect(screen.getByText("Current week · 1 ranked player shown")).toBeTruthy();
    expect(screen.getByText("You")).toBeTruthy();
    expect(screen.getByText("#105")).toBeTruthy();
    expect(screen.getByText("7 Flags Built")).toBeTruthy();
    fireEvent.click(screen.getByRole("row", { name: /Rival/ }));
    expect(openPlayer).toHaveBeenCalledWith(
      "rival",
      "Rival",
      expect.objectContaining({ left: 0, top: 0 })
    );
    fireEvent.click(screen.getByRole("button", { name: "Hunting" }));
    expect(screen.getByRole("button", { name: "Mysterious Travelers" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Trees Chopped" })).toBeNull();
  });

  it("shows reconnect and retry states without replacing an authoritative week locally", () => {
    render(
      <WeeklyLeaderboardsPanel
        open
        layout="desktop"
        serverHttpBase="https://game.example/"
        ownPlayerId="self"
        connected={false}
        onClose={vi.fn()}
        onOpenPlayer={vi.fn()}
      />
    );
    expect(screen.getByText("Reconnect to load the weekly leaderboards.")).toBeTruthy();
    expect(screen.getByText("Reconnecting… Rankings may be up to one minute old.")).toBeTruthy();
  });

  it("does not present current-week rows as archived while the previous week loads", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(snapshot()), {
        status: 200,
        headers: { "content-type": "application/json" }
      }))
      .mockImplementationOnce(() => new Promise<Response>(() => {}));
    vi.stubGlobal("fetch", fetchMock);
    render(
      <WeeklyLeaderboardsPanel
        open
        layout="desktop"
        serverHttpBase="https://game.example/"
        ownPlayerId="self"
        connected
        onClose={vi.fn()}
        onOpenPlayer={vi.fn()}
      />
    );
    await waitFor(() => expect(screen.getByText("Rival")).toBeTruthy());

    fireEvent.click(screen.getByRole("tab", { name: "Previous Week" }));

    await waitFor(() => expect(screen.queryByText("Rival")).toBeNull());
    expect(screen.getByText(/Loading weekly rankings/)).toBeTruthy();
  });

  it("formats live server-derived remaining time compactly", () => {
    expect(formatRemaining(2 * 86_400 + 4 * 3_600)).toBe("2d 4h");
    expect(formatRemaining(4 * 3_600 + 9 * 60)).toBe("4h 9m");
    expect(formatRemaining(-1)).toBe("0m");
  });

  it("houses Fishing Records inside the Rankings destination", () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(snapshot()), {
      status: 200,
      headers: { "content-type": "application/json" }
    })));
    const requestRecords = vi.fn();
    render(
      <WeeklyLeaderboardsPanel
        open
        layout="phone"
        serverHttpBase="https://game.example/"
        ownPlayerId="self"
        connected
        fishingHutSelected={false}
        fishingRecords={recordsSnapshot()}
        onRequestFishingRecords={requestRecords}
        onClose={vi.fn()}
        onOpenPlayer={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole("tab", { name: "Fishing Records" }));
    expect(screen.getByRole("heading", { name: "Personal records" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Universal records" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Refresh records" })).toBeTruthy();
    expect(screen.queryByText("Weekly Value")).toBeNull();
    expect(requestRecords).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Refresh records" }));
    expect(requestRecords).toHaveBeenCalledTimes(2);
  });
});

function snapshot(): WeeklyLeaderboardSnapshot {
  return {
    timezone: "America/Denver",
    weekStart: "2026-07-13",
    weekStartAt: "2026-07-13T06:00:00.000Z",
    nextWeekStart: "2026-07-20T06:00:00.000Z",
    previousWeekStart: "2026-07-06",
    serverNow: "2026-07-16T18:00:00.000Z",
    remainingSeconds: 302_400,
    archived: false,
    boards: WEEKLY_LEADERBOARD_CATEGORIES.map((category) => ({
      category,
      top: category === "flags_built"
        ? [{
            rank: 1,
            playerId: "rival",
            displayName: "Rival",
            value: 12,
            reachedAt: "2026-07-14T12:00:00.000Z"
          }]
        : [],
      personal: {
        category,
        value: category === "flags_built" ? 7 : 0,
        rank: category === "flags_built" ? 105 : null,
        reachedAt: category === "flags_built"
          ? "2026-07-14T13:00:00.000Z"
          : null,
        nearby: category === "flags_built"
          ? [{
              rank: 105,
              playerId: "self",
              displayName: "Self",
              value: 7,
              reachedAt: "2026-07-14T13:00:00.000Z"
            }]
          : []
      }
    }))
  };
}

function recordsSnapshot(): FishingRecordSnapshot {
  return {
    waterbody: { kind: "river", sourceId: "rio-grande", displayName: "Rio Grande", distanceM: 0 },
    heaviest: null,
    highestScore: null,
    personalBestWeight: null,
    personalBestScore: null,
    personalBestPerfect: null,
    ashenCatches: [],
    weeklyBestFiveScore: 0,
    weeklyTopAnglers: [],
    recentCatches: []
  };
}
