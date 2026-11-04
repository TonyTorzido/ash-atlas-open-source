// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { HarvestTollsPanel } from "./HarvestTollsPanel.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const snapshot = {
  settings: [
    { harvestType: "stone_mine", tollGold: "1", revision: "0" },
    { harvestType: "coal_mine", tollGold: "2", revision: "0" },
    { harvestType: "iron_mine", tollGold: "3", revision: "0" },
    { harvestType: "sulfur_mine", tollGold: "3", revision: "0" },
    { harvestType: "oil_well", tollGold: "4", revision: "0" }
  ],
  assets: [{
    assetId: "asset",
    harvestType: "stone_mine",
    label: "Stone Mine",
    accessMode: "private",
    accessRevision: "0"
  }]
} as const;

describe("HarvestTollsPanel", () => {
  it("uses canonical tabs and type-wide price cards without owned-asset controls", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ tolls: snapshot }), {
      status: 200,
      headers: { "content-type": "application/json" }
    }));
    vi.stubGlobal("fetch", fetchMock);
    render(<HarvestTollsPanel
      open
      layout="desktop"
      serverHttpBase="https://example.test"
      csrfToken="csrf"
      onClose={vi.fn()}
    />);

    expect(await screen.findByRole("tab", { name: "Mines" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Oil Wells" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Stone Mine" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Coal Mine" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Iron Mine" })).toBeTruthy();
    expect(screen.getAllByText("TYPE-WIDE PRICE")).toHaveLength(4);
    expect(screen.getByTitle("Stone Mine").getAttribute("src")).toContain("stone-mine.png");
    expect(screen.getByTitle("Sulfur Mine").getAttribute("src")).toContain("sulfur-mine.png");
    expect(screen.getAllByText(/Public\/private access is changed in person at this structure\./i)).toHaveLength(4);
    expect(screen.queryByText("Public/private access is changed in person at each mine or Oil Well.")).toBeNull();
    expect(screen.queryByText("Owned harvest structures")).toBeNull();
    expect(screen.queryByRole("button", { name: /Make Public|Make Private/ })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Flag travel tolls" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Open Flag Tolls" })).toBeNull();

    fireEvent.click(screen.getByRole("tab", { name: "Oil Wells" }));
    expect(screen.getByRole("heading", { name: "Oil Well" })).toBeTruthy();
    expect(screen.getByTitle("Oil Well").getAttribute("src")).toContain("OilWell1.png");
    expect(screen.getByText("Applies to every public Oil Well you own.")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Stone Mine" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Flag travel tolls" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Open Flag Tolls" })).toBeNull();
  });

  it("saves a type-wide price", async () => {
    const next = {
      ...snapshot,
      settings: snapshot.settings.map((setting) => setting.harvestType === "stone_mine"
        ? { ...setting, tollGold: "9", revision: "1" }
        : setting)
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ tolls: snapshot }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ tolls: next }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    render(<HarvestTollsPanel
      open
      layout="desktop"
      serverHttpBase="https://example.test"
      csrfToken="csrf"
      onClose={vi.fn()}
    />);

    const input = await screen.findByRole("textbox", { name: "Stone Mine public price in Gold" });
    fireEvent.change(input, { target: { value: "9" } });
    fireEvent.click(screen.getAllByRole("button", { name: "Save Price" })[0]!);
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Stone Mine public price saved."));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
