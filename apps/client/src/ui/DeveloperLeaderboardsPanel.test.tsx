// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DeveloperLeaderboardsPanel } from "./DeveloperLeaderboardsPanel.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("DeveloperLeaderboardsPanel", () => {
  it("renders arbitrary server-described public and owner metrics and selects ranked players", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/players")) {
        return json({
          players: [{ playerId: "owner", displayName: "Owner", eligible: true }]
        });
      }
      if (url.pathname.includes("/player/")) {
        const playerId = decodeURIComponent(url.pathname.split("/").at(-1)!);
        return json({
          period: period(),
          player: { playerId, displayName: playerId === "rival" ? "Rival" : "Owner", eligible: true },
          metrics: [
            {
              key: "future_public_metric",
              label: "Arbitrary Public Metric",
              group: "overall",
              visibility: "public",
              value: 17,
              rank: 4,
              reachedAt: "2026-07-14T12:00:00.000Z"
            },
            {
              key: "private_metric_from_server",
              label: "Private Label From Server",
              group: "owner_metrics",
              visibility: "owner_only",
              value: 8,
              rank: 2,
              reachedAt: "2026-07-14T13:00:00.000Z",
              breakdown: [{ key: "part", label: "Server Breakdown", value: 8 }]
            }
          ]
        });
      }
      return json({
        period: period(),
        metric: { key: "private_metric_from_server", label: "Private Label From Server" },
        entries: [{
          rank: 1,
          playerId: "rival",
          displayName: "Rival",
          value: 10,
          reachedAt: "2026-07-14T11:00:00.000Z"
        }]
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<DeveloperLeaderboardsPanel serverHttpBase="https://game.example" />);

    expect(await screen.findByText("Arbitrary Public Metric")).toBeTruthy();
    expect(screen.getAllByText("Private Label From Server").length).toBeGreaterThan(0);
    expect(screen.getByText("Server Breakdown")).toBeTruthy();
    expect(screen.getByText("Rank #4")).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: /#1 Rival 10/ }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      expect.objectContaining({ pathname: "/api/dev/leaderboards/player/rival" }),
      expect.anything()
    ));
  });
});

function period(): object {
  return {
    timezone: "America/Denver",
    weekStart: "2026-07-13",
    weekStartAt: "2026-07-13T06:00:00.000Z",
    nextWeekStart: "2026-07-20T06:00:00.000Z",
    archived: false
  };
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}
