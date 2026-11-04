// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DeveloperEconomyObservatory } from "./DeveloperEconomyObservatory.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const metadata = {
  snapshotAsOf: "2026-09-11T12:00:00.000Z",
  isolationLevel: "REPEATABLE READ",
  historicalBaselineAvailable: true,
  reconciliation: { status: "ok", imbalancedGroups: 0 },
  staleness: { isStale: false, staleSources: [], maxAgeSeconds: 0 }
};

function response(payload: unknown): Response {
  return { ok: true, json: async () => payload } as Response;
}

function overviewPayload(): unknown {
  return { metadata, scopes: [], flow: [], coverage: [], sessions: { connected: 0, active: 0, afk: 0, activePlayers: 0 } };
}

function reportPayload(): unknown {
  return {
    metadata: {
      windowStart: "2026-09-10T12:00:00.000Z",
      windowEnd: "2026-09-11T12:00:00.000Z",
      snapshotStart: "2026-09-10T12:00:00.000Z",
      snapshotEnd: "2026-09-11T12:00:00.000Z",
      durationSeconds: 86400,
      generation: "test",
      releaseSha: "sha",
      runtimeLabel: "test",
      coverageStatus: "complete",
      reconciliationStatus: "ok",
      activePlayerCount: 0,
      totalActiveGameplaySeconds: 0
    },
    items: [], sourceBreakdown: [], playerItemRows: [], cohorts: [], coverage: [], dataQuality: []
  };
}

function itemsPayload(): unknown {
  return {
    metadata,
    items: [{ assetId: "wood", variant: "default", assetKind: "fungible", displayName: "Wood", category: "resource", quantity: "0", holderCount: 0, scope: "existing_world_supply" }],
    pagination: { page: 1, pageSize: 50, total: 1, hasNext: false }
  };
}

function itemDetailPayload(): unknown {
  return {
    metadata,
    item: { assetId: "wood", variant: "default", assetKind: "fungible", displayName: "Wood", category: "resource", quantity: "0", holderCount: 0, scope: "existing_world_supply" },
    holders: [],
    pagination: { page: 1, pageSize: 50, total: 0, hasNext: false },
    report: null
  };
}

describe("DeveloperEconomyObservatory", () => {
  beforeEach(() => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }))
    });
  });

  it("renders the canonical desktop shell and paged item explorer", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("/overview")) return response(overviewPayload());
      if (url.includes("/report")) return response(reportPayload());
      if (url.includes("/items/wood")) return response(itemDetailPayload());
      if (url.includes("/items")) return response(itemsPayload());
      throw new Error(`unexpected request ${url}`);
    });

    render(<DeveloperEconomyObservatory open serverHttpBase="http://localhost:3001" onClose={vi.fn()} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("dialog").className).toContain("desktop-destination-shell");
    fireEvent.click(screen.getByRole("tab", { name: "Items" }));
    await waitFor(() => expect(screen.getByRole("rowheader", { name: /Wood/ })).toBeTruthy());
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes("pageSize=50"))).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Inspect" }));
    await waitFor(() => expect(screen.getByRole("heading", { name: "Wood · holders" })).toBeTruthy());
  });

  it("uses the same app state in the canonical phone shell", async () => {
    vi.mocked(window.matchMedia).mockReturnValue({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() } as unknown as MediaQueryList);
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      return response(url.includes("/report") ? reportPayload() : overviewPayload());
    });

    render(<DeveloperEconomyObservatory open serverHttpBase="http://localhost:3001" onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole("dialog").className).toContain("phone-menu-layer"));
    expect(screen.getByRole("tablist", { name: "Economy Observatory sections" })).toBeTruthy();
  });
});
