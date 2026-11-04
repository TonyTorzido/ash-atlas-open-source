// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DeveloperFlagDiagnostics } from "./DeveloperFlagDiagnostics.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("DeveloperFlagDiagnostics", () => {
  it("uses canonical confirmation for the bounded bulk refresh", async () => {
    const diagnosticsRequest = new Promise<Response>(() => undefined);
    const fetchMock = vi.fn()
      .mockReturnValueOnce(diagnosticsRequest)
      .mockResolvedValueOnce(new Response(JSON.stringify({
        ok: true,
        requested: 2,
        refreshed: 2,
        failures: [],
        truncated: false
      }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockReturnValueOnce(diagnosticsRequest);
    vi.stubGlobal("fetch", fetchMock);
    const onRefreshed = vi.fn();
    render(<DeveloperFlagDiagnostics
      developerAccessEnabled
      flagId="flag-1"
      flagName="Northwatch"
      serverHttpBase="http://game.test"
      csrfToken="csrf"
      onRefreshed={onRefreshed}
      onClose={vi.fn()}
    />);

    fireEvent.click(screen.getByRole("button", { name: "Refresh All Legacy/Incomplete" }));
    const prompt = screen.getByText(
      "Refresh all legacy, stale, incomplete, or unavailable flag snapshots?"
    ).closest("aside")!;
    expect(fetchMock).toHaveBeenCalledOnce();
    fireEvent.click(within(prompt).getByRole("button", { name: "Refresh Eligible Snapshots" }));

    await waitFor(() => expect(onRefreshed).toHaveBeenCalledOnce());
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ method: "POST" });
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
      all: true,
      limit: 100,
      onlyNeedsRefresh: true
    });
  });
});
