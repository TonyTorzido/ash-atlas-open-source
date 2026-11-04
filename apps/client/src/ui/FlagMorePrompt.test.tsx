// @vitest-environment jsdom

import type { FlagAccessSnapshot, FlagSnapshot } from "@ash-atlas/shared";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { FlagMorePrompt } from "./FlagMorePrompt.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("FlagMorePrompt", () => {
  it("shows only the ordered alternative actions and saves access immediately", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PATCH") {
        const body = JSON.parse(String(init.body)) as { mode: FlagAccessSnapshot["mode"]; jumpTollGold: string };
        return response({ access: access(body.mode, body.jumpTollGold) });
      }
      return response({
        progression: progression({ currentShards: 28, requiredShards: 5, availableCapacity: 0 })
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const onAccessSaved = vi.fn();
    const onClose = vi.fn();
    const view = render(<FlagMorePrompt {...baseProps()} onAccessSaved={onAccessSaved} onClose={onClose} />);

    await screen.findByText("28/5 shards");
    const labels = screen.getAllByRole("button").map((button) => button.textContent);
    expect(labels).toEqual([
      "Upgrade to Atlas Shrine", "Public", "Private", "Destroy Flag", "Cancel"
    ]);
    expect(screen.getByRole("group", { name: "Access" }).querySelector("[aria-pressed]")).toBeNull();
    expect(view.container.querySelector(".phone-menu-layer")).toBeNull();
    expect(screen.queryByText(/Rename|Tower|Player Details|Contribute|toll|Save Access/i)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Public" }));
    await waitFor(() => expect(onAccessSaved).toHaveBeenCalledOnce());
    expect(fetchMock).toHaveBeenCalledWith(
      new URL(`https://game.example/api/flags/${flag().id}/access`),
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ mode: "public", jumpTollGold: "12" })
      })
    );
    expect(onClose).toHaveBeenCalledOnce();
  });

  it.each([
    ["public", ["Normal", "Private"]],
    ["normal", ["Public", "Private"]],
    ["private", ["Public", "Normal"]]
  ] as const)("omits the current %s mode and keeps canonical order", (mode, expected) => {
    vi.stubGlobal("fetch", vi.fn(async () => response({ progression: progression() })));
    render(<FlagMorePrompt
      {...baseProps()}
      access={access(mode, "12")}
    />);
    expect(screen.getByRole("group", { name: "Access" }).querySelectorAll("button")).toHaveLength(2);
    expect(Array.from(
      screen.getByRole("group", { name: "Access" }).querySelectorAll("button"),
      (button) => button.textContent
    )).toEqual(expected);
  });

  it("sends zero for Private and preserves the current toll for Public or Normal", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PATCH") {
        const body = JSON.parse(String(init.body)) as { mode: FlagAccessSnapshot["mode"]; jumpTollGold: string };
        return response({ access: access(body.mode, body.jumpTollGold) });
      }
      return response({ progression: progression() });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<FlagMorePrompt {...baseProps()} onAccessSaved={vi.fn()} onClose={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Private" }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([, init]) =>
      init?.body === JSON.stringify({ mode: "private", jumpTollGold: "0" })
    )).toBe(true));
  });

  it("upgrades a Stone Flag directly when capacity is available", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/status")) return response({ progression: progression() });
      return response({ progression: progression({ builtShrines: 1, availableCapacity: 0 }), inventory: {}, replayed: false, flag: { ...flag(), upgradeTier: "atlas_shrine" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const onMutation = vi.fn();
    const onClose = vi.fn();
    render(<FlagMorePrompt {...baseProps()} onAtlasShrineMutation={onMutation} onClose={onClose} />);

    const upgradeButton = await screen.findByRole("button", { name: "Upgrade to Atlas Shrine" });
    await waitFor(() => expect((upgradeButton as HTMLButtonElement).disabled).toBe(false));
    expect(screen.getByText("Slot ready")).toBeTruthy();
    fireEvent.click(upgradeButton);

    await waitFor(() => expect(onMutation).toHaveBeenCalledOnce());
    expect(fetchMock.mock.calls.map(([input]) => String(input))).not.toContain(
      "https://game.example/api/flags/atlas-shrines/unlock"
    );
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("confirms permanent spend then unlocks and upgrades sequentially", async () => {
    const calls: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith("/status")) return response({ progression: progression({ availableCapacity: 0 }) });
      if (url.endsWith("/unlock")) return response({ progression: progression(), inventory: { step: "unlock" }, replayed: false });
      return response({ progression: progression({ builtShrines: 1, availableCapacity: 0 }), inventory: { step: "upgrade" }, replayed: false, flag: { ...flag(), upgradeTier: "atlas_shrine" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    const onMutation = vi.fn();
    render(<FlagMorePrompt {...baseProps()} onAtlasShrineMutation={onMutation} />);

    const upgradeButton = await screen.findByRole("button", { name: "Upgrade to Atlas Shrine" });
    await waitFor(() => expect((upgradeButton as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(upgradeButton);
    fireEvent.click(screen.getByRole("button", { name: "Unlock and Upgrade" }));

    await waitFor(() => expect(onMutation).toHaveBeenCalledTimes(2));
    expect(calls.findIndex((url) => url.endsWith("/unlock"))).toBeLessThan(
      calls.findIndex((url) => url.endsWith("/upgrade"))
    );
  });

  it("confirms destruction and prevents double submission", () => {
    vi.stubGlobal("fetch", vi.fn(async () => response({ progression: progression() })));
    const onDestroy = vi.fn();
    render(<FlagMorePrompt {...baseProps()} onDestroy={onDestroy} />);

    fireEvent.click(screen.getByRole("button", { name: "Destroy Flag" }));
    const confirm = screen.getByRole("button", { name: "Destroy Flag" });
    fireEvent.click(confirm);
    fireEvent.click(confirm);

    expect(onDestroy).toHaveBeenCalledOnce();
    expect((screen.getByRole("button", { name: "Destroying…" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("restores destruction controls after the parent reports a failed deletion", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response({ progression: progression() })));
    const props = { ...baseProps(), onDestroy: vi.fn(), deleting: false };
    const view = render(<FlagMorePrompt {...props} />);

    fireEvent.click(screen.getByRole("button", { name: "Destroy Flag" }));
    fireEvent.click(screen.getByRole("button", { name: "Destroy Flag" }));
    view.rerender(<FlagMorePrompt {...props} deleting />);
    view.rerender(<FlagMorePrompt {...props} deleting={false} />);

    await waitFor(() => expect(
      (screen.getByRole("button", { name: "Destroy Flag" }) as HTMLButtonElement).disabled
    ).toBe(false));
  });
});

function baseProps() {
  return {
    flag: flag(),
    access: access("normal", "12"),
    displayName: "Ash's Flag (Normal) · 12 Gold",
    serverHttpBase: "https://game.example",
    csrfToken: "csrf",
    connected: true,
    onAccessSaved: vi.fn(),
    onDestroy: vi.fn(),
    onClose: vi.fn()
  };
}

function progression(overrides: Record<string, unknown> = {}) {
  return {
    unlockedSlots: 1, builtShrines: 0, availableCapacity: 1, nextSlot: 2,
    requiredLevel: 2, playerLevel: 2, requiredShards: 2, currentShards: 2,
    levelRequirementMet: true, shardRequirementMet: true, ...overrides
  };
}

function access(mode: FlagAccessSnapshot["mode"], jumpTollGold: string): FlagAccessSnapshot {
  return {
    flagId: flag().id, ownerPlayerId: "owner-1", mode, jumpTollGold, accessRevision: "1",
    requestPending: false,
    decision: { allowed: true, requestable: false, reasonCode: "ALLOWED_OWNER", tollGold: "0" },
    management: null
  };
}

function flag(): FlagSnapshot {
  return {
    id: "11111111-1111-4111-8111-111111111111", controlType: "personal",
    ownerId: "owner-1", ownerUsername: "Ash", ownerColor: "#38bdf8", name: "Flag 1",
    lat: 1, lon: 2, packageId: "world", elevationM: 0, terrainClass: "flat",
    biome: "Forest", ecoregion: "Forest", claimRadiusM: 1000, cityId: null,
    reinforcementLevel: 1, upgradeTier: "stone", createdAt: "2026-01-01T00:00:00.000Z"
  };
}

function response(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as Response;
}
