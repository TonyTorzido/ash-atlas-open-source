// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { FlagListPanel } from "./FlagListPanel.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Flags destination", () => {
  it("houses access and harvest management in one direct app", () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => undefined)));
    render(<FlagListPanel
      open
      layout="phone"
      onClose={vi.fn()}
      onTravelAtlasShrine={vi.fn()}
    />);

    const sectionLabels = ["Access & Travel", "Harvest Tolls"];
    expect(screen.getAllByRole("tab")).toHaveLength(5);
    for (const label of sectionLabels) {
      const tab = screen.getByRole("tab", { name: label });
      fireEvent.click(tab);
      expect(tab.getAttribute("aria-selected")).toBe("true");
    }

    fireEvent.click(screen.getByRole("tab", { name: "Access & Travel" }));
    expect(screen.getAllByRole("tab")).toHaveLength(5);
    for (const label of ["Visit Tolls", "Atlas Shrines", "Normal Passage"]) {
      const tab = screen.getByRole("tab", { name: label });
      fireEvent.click(tab);
      expect(tab.getAttribute("aria-selected")).toBe("true");
    }

    fireEvent.click(screen.getByRole("tab", { name: "Harvest Tolls" }));
    expect(screen.getByRole("tab", { name: "Mines" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Oil Wells" })).toBeTruthy();
  });

  it("uses themed controls instead of native selects", () => {
    const management = readFileSync(join(process.cwd(), "src", "ui", "FlagManagementView.tsx"), "utf8");
    const access = readFileSync(join(process.cwd(), "src", "ui", "FlagAccessControls.tsx"), "utf8");
    const css = readFileSync(join(process.cwd(), "src", "ashAtlasTheme.css"), "utf8");

    expect(management).not.toContain("<select");
    expect(access).not.toContain("<select");
    expect(management).toContain("<ThemedSelect");
    expect(access).toContain("flag-access-mode-options");
    expect(access).toContain("aria-pressed");
    expect(css).toMatch(/\.themed-select-trigger,\s*\.themed-select-listbox button\s*\{/s);
    expect(css).toMatch(/\.flag-management-section button,\s*\.flag-access-card button\s*\{/s);
    expect(css).toMatch(/\.flag-management-section input:not\(\[type="checkbox"\]\),\s*\.flag-access-card input:not\(\[type="checkbox"\]\)\s*\{/s);
    expect(css).toMatch(/\.flag-management-section input\[type="checkbox"\],\s*\.flag-access-card input\[type="checkbox"\]\s*\{/s);
  });

  it("requires canonical confirmation before applying a bulk toll", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(managementResponse())
      .mockResolvedValueOnce(jsonResponse({ updated: 2 }))
      .mockResolvedValueOnce(managementResponse());
    vi.stubGlobal("fetch", fetchMock);
    render(<FlagListPanel
      open
      layout="phone"
      serverHttpBase="http://game.test"
      csrfToken="csrf"
      onClose={vi.fn()}
      onTravelAtlasShrine={vi.fn()}
    />);

    await screen.findByText("New Flag Defaults");
    fireEvent.click(screen.getByRole("tab", { name: "Access & Travel" }));
    await screen.findByText("New Flag Defaults");
    fireEvent.click(screen.getByRole("tab", { name: "Visit Tolls" }));
    fireEvent.click(screen.getByRole("button", { name: "Apply to all Public flags" }));
    let prompt = screen.getByText("Apply 0 gold to 2 Public flags?").closest("aside")!;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fireEvent.click(within(prompt).getByRole("button", { name: "Cancel" }));
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Apply to all Public flags" }));
    prompt = screen.getByText("Apply 0 gold to 2 Public flags?").closest("aside")!;
    fireEvent.click(within(prompt).getByRole("button", { name: "Apply to all Public flags" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ method: "POST" });
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
      mode: "public",
      tollGold: "0"
    });
  });
});

function managementResponse(): Response {
  return jsonResponse({ management: {
    preferences: {
      defaultFlagAccessMode: "private",
      defaultPublicTollGold: "0",
      defaultNormalTollGold: "0"
    },
    flags: [],
    ownedFlagCountsByMode: { public: 2, normal: 1, private: 0 },
    normalGrants: [],
    normalRequests: [],
    truncated: false
  } });
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}
