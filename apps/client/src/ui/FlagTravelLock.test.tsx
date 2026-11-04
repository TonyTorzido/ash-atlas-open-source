// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { FlagSnapshot } from "@ash-atlas/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

import { FlagListPanel } from "./FlagListPanel.js";
import { FlagPanel } from "./FlagPanel.js";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("Aggressive flag travel feedback", () => {
  it("disables and labels Travel in the selected flag panel until expiry", () => {
    const view = render(<FlagPanel flag={kingdomFlag()} player={null} onVisitFlag={vi.fn()} onDeleteFlag={vi.fn()} deleting={false} onClose={vi.fn()} aggressiveRemainingMs={6_750} />);
    const locked = screen.getByRole("button", { name: "Aggressive · 6.8s" }) as HTMLButtonElement;
    expect(locked.disabled).toBe(true);
    view.rerender(<FlagPanel flag={kingdomFlag()} player={null} onVisitFlag={vi.fn()} onDeleteFlag={vi.fn()} deleting={false} onClose={vi.fn()} aggressiveRemainingMs={0} />);
    expect((screen.getByRole("button", { name: "Travel to Flag" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("offers World Map travel from Atlas Shrines", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => managementResponse()));
    render(<FlagListPanel open onClose={vi.fn()} onTravelAtlasShrine={vi.fn()} />);
    fireEvent.click(screen.getByRole("tab", { name: "Atlas Shrines" }));
    expect(await screen.findByText("Camp")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Travel" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "More" })).toBeNull();
  });

  it("renders phone Flags in the shared shell with every management section and both footer actions", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => managementResponse()));
    const view = render(<FlagListPanel
      open layout="phone" onClose={vi.fn()} onTravelAtlasShrine={vi.fn()}
    />);
    expect(screen.getByRole("dialog", { name: "Land Management" }).classList.contains("phone-menu-layer")).toBe(true);
    for (const name of ["Access & Travel", "Visit Tolls", "Atlas Shrines", "Normal Passage"]) {
      expect(screen.getByRole("tab", { name })).toBeTruthy();
    }
    expect(screen.getByRole("button", { name: "Back to Game Menu" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Return to Game" })).toBeTruthy();
    expect(view.container.querySelectorAll(".phone-menu-header")).toHaveLength(1);
    expect(view.container.querySelectorAll(".phone-menu-footer")).toHaveLength(1);
    expect(screen.getByRole("tab", { name: "Access & Travel" }).getAttribute("aria-selected")).toBe("true");
    fireEvent.click(screen.getByRole("tab", { name: "Atlas Shrines" }));
    await screen.findByText("Camp");
    expect(screen.queryByRole("button", { name: "Quick Jump" })).toBeNull();
  });
});

describe("Atlas Shrine list authority", () => {
  it("only renders the authoritative shrine dashboard rows", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => managementResponse()));
    const props = {
      open: true,
      onClose: vi.fn(),
      onTravelAtlasShrine: vi.fn()
    };
    render(<FlagListPanel {...props} />);
    fireEvent.click(screen.getByRole("tab", { name: "Atlas Shrines" }));
    await screen.findByText("Camp");
    expect(screen.queryByText("Ordinary Flag")).toBeNull();
    expect(screen.queryByRole("button", { name: "Quick Jump" })).toBeNull();
  });

  it("allows a blank 15-character rename and applies the numbered server result", async () => {
    let renameBody: unknown;
    const onAtlasShrineRenamed = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/atlas-shrines/status")) {
        return new Response(JSON.stringify({ progression: progression() }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      if (init?.method === "PATCH") {
        renameBody = JSON.parse(String(init.body));
        return new Response(JSON.stringify({
          ok: true,
          flag: {
            ...flag(),
            name: "Atlas Shrine 1",
            reinforcementLevel: 2,
            upgradeTier: "atlas_shrine",
            atlasShrineSlotNumber: 1
          }
        }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      return managementResponse();
    }));
    render(<FlagListPanel
      open
      onClose={vi.fn()}
      onTravelAtlasShrine={vi.fn()}
      onAtlasShrineRenamed={onAtlasShrineRenamed}
    />);

    fireEvent.click(screen.getByRole("tab", { name: "Atlas Shrines" }));
    await screen.findByText("Camp");
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    const input = screen.getByRole("textbox", { name: "Atlas Shrine name" });
    expect(input.getAttribute("maxlength")).toBe("15");
    fireEvent.change(input, { target: { value: "   " } });
    const save = screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
    expect(save.disabled).toBe(false);
    fireEvent.click(save);

    expect(await screen.findByText("Atlas Shrine 1")).toBeTruthy();
    expect(renameBody).toEqual({ name: "" });
    await waitFor(() => expect(onAtlasShrineRenamed).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Atlas Shrine 1", atlasShrineSlotNumber: 1 })
    ));
  });
});

function flag(): FlagSnapshot {
  return {
    id: "flag-1", controlType: "personal", ownerId: "owner", name: "Camp", lat: 35, lon: -106,
    packageId: null, elevationM: null, terrainClass: null, biome: null, ecoregion: null,
    claimRadiusM: 500, cityId: null, createdAt: "2026-07-08T09:00:00.000Z"
  };
}

function kingdomFlag(): FlagSnapshot {
  return {
    ...flag(),
    controlType: "kingdom",
    kingdomId: "kingdom-1",
    contributedByPlayerId: "contributor",
    contributedByUsername: "Contributor"
  };
}

function managementResponse(): Response {
  return new Response(JSON.stringify({ management: {
    preferences: { defaultFlagAccessMode: "private", defaultPublicTollGold: "0", defaultNormalTollGold: "0" },
    flags: [{
      flagId: "flag-1", flagName: "Camp", mode: "private", jumpTollGold: "0",
      lat: 35, lon: -106,
      areaLabel: "Test camp", accessRevision: "0", atlasShrineSlotNumber: 1
    }, {
      flagId: "ordinary-flag", flagName: "Ordinary Flag", mode: "private", jumpTollGold: "0",
      lat: 36, lon: -107,
      areaLabel: "Ordinary", accessRevision: "0"
    }],
    normalGrants: [], normalRequests: [], truncated: false
  } }), { status: 200, headers: { "content-type": "application/json" } });
}

function progression() {
  return {
    unlockedSlots: 1,
    builtShrines: 1,
    availableCapacity: 0,
    nextSlot: 2,
    requiredLevel: 2,
    playerLevel: 1,
    requiredShards: 2,
    currentShards: 0,
    levelRequirementMet: false,
    shardRequirementMet: false
  };
}
