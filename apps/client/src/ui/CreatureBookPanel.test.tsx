// @vitest-environment jsdom

import { WORLD_MAP_MIN_ZOOM, type CreatureBookSnapshot } from "@ash-atlas/shared";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mapMocks = vi.hoisted(() => {
  const map = {
    jumpTo: vi.fn(),
    loaded: vi.fn(() => true),
    once: vi.fn(),
    off: vi.fn(),
    remove: vi.fn()
  };
  const presenter = { sync: vi.fn(), destroy: vi.fn() };
  return {
    map,
    presenter,
    createWorldMap: vi.fn(() => ({ map })),
    installWorldEnvironmentOverlays: vi.fn(() => presenter)
  };
});

vi.mock("../map/worldMap.js", () => ({ createWorldMap: mapMocks.createWorldMap }));
vi.mock("../map/worldEnvironmentOverlays.js", () => ({ installWorldEnvironmentOverlays: mapMocks.installWorldEnvironmentOverlays }));
vi.mock("../map/mobArtwork.js", () => ({
  mobArtworkSource: (archetype: string) => `/art/${archetype}-normal.png`
}));

import { CreatureBookPanel } from "./CreatureBookPanel.js";

beforeEach(() => {
  vi.clearAllMocks();
  mapMocks.map.loaded.mockReturnValue(true);
});
afterEach(cleanup);

describe("CreatureBookPanel", () => {
  it("keeps unseen slots redacted and inaccessible", () => {
    render(<CreatureBookPanel snapshot={{ slots: [{ bookOrder: 0, unlocked: false }] }} onBack={() => undefined} />);
    const unknown = screen.getByRole("button", { name: "Unknown creature 1" });
    expect((unknown as HTMLButtonElement).disabled).toBe(true);
    expect(unknown.textContent).toContain("???");
    expect(unknown.textContent).not.toContain("Deer");
  });

  it("houses plants beside beasts and keeps undiscovered plants redacted", () => {
    render(<CreatureBookPanel snapshot={{
      slots: [],
      plants: [{ bookOrder: 0, unlocked: false }]
    }} onBack={() => undefined} />);
    expect(screen.getByRole("tab", { name: "Beasts" })).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "Plants" }));
    const unknown = screen.getByRole("button", { name: "Unknown plant 1" });
    expect((unknown as HTMLButtonElement).disabled).toBe(true);
    expect(unknown.textContent).toContain("???");
    expect(unknown.textContent).not.toContain("Flax");
  });

  it("shows Flax harvest progress before its habitat threshold", () => {
    render(<CreatureBookPanel snapshot={{
      slots: [],
      plants: [{
        bookOrder: 0,
        unlocked: true,
        plantKey: "flax",
        name: "Wild Flax",
        rarity: "common",
        active: 12,
        totalHarvests: 1,
        habitat: { kind: "natural", progress: 1, threshold: 5, restrictions: null }
      }]
    }} onBack={() => undefined} />);
    fireEvent.click(screen.getByRole("tab", { name: "Plants" }));
    fireEvent.click(screen.getByRole("button", { name: "Open Wild Flax" }));
    expect(screen.getByText("Wild Flax")).toBeTruthy();
    expect(screen.getByText("12")).toBeTruthy();
    expect(screen.getByText("1")).toBeTruthy();
    expect(screen.getByText("1 / 5 harvests")).toBeTruthy();
    expect(screen.queryByLabelText("Plant habitat map")).toBeNull();
  });

  it("shows Flax habitat after the fifth successful harvest", async () => {
    render(<CreatureBookPanel snapshot={{
      slots: [],
      plants: [{
        bookOrder: 0,
        unlocked: true,
        plantKey: "flax",
        name: "Wild Flax",
        rarity: "common",
        active: 12,
        totalHarvests: 5,
        habitat: {
          kind: "natural",
          progress: 5,
          threshold: 5,
          restrictions: [{
            groupId: "environment",
            categoryIds: ["jungle", "greenwood", "plains", "marsh"],
            label: "Ordinary temperate land; wetlands reduced"
          }]
        }
      }]
    }} onBack={() => undefined} />);
    fireEvent.click(screen.getByRole("tab", { name: "Plants" }));
    fireEvent.click(screen.getByRole("button", { name: "Open Wild Flax" }));
    expect(screen.getByLabelText("Plant habitat map")).toBeTruthy();
    expect(screen.getByText("Environment · Ordinary temperate land; wetlands reduced")).toBeTruthy();
    await waitFor(() => {
      expect(mapMocks.createWorldMap).toHaveBeenCalled();
      expect(mapMocks.presenter.sync).toHaveBeenCalledWith("environment", [
        "jungle", "greenwood", "plains", "marsh"
      ]);
    });
  });

  it("shows legendary habitat as N/A immediately after discovery", () => {
    render(<CreatureBookPanel snapshot={snapshot({
      bookOrder: 12,
      unlocked: true,
      archetypeKey: "fire_bird",
      name: "Fire Bird",
      rarity: "legendary",
      ashenUnlocked: false,
      habitat: { kind: "legendary", habitat: "N/A", active: "any_time" },
      killCount: null,
      drops: [{ slotOrder: 0, observed: false }]
    })} onBack={() => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: "Open Fire Bird" }));
    expect(screen.getAllByText("N/A", { selector: "dd" })).toHaveLength(2);
    expect(screen.getAllByText("Any Time")).toHaveLength(1);
    expect(screen.getByText("Not yet observed")).toBeTruthy();
  });

  it("keeps natural habitat locked until the authoritative kill threshold", () => {
    render(<CreatureBookPanel snapshot={snapshot({
      bookOrder: 0,
      unlocked: true,
      archetypeKey: "deer",
      name: "Deer",
      rarity: "common",
      ashenUnlocked: false,
      habitat: { kind: "natural", progress: 37, threshold: 100, restrictions: null, active: "any_time" },
      killCount: 37,
      drops: []
    })} onBack={() => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: "Open Deer" }));
    expect(screen.getByText("37 / 100 kills")).toBeTruthy();
    expect(screen.queryByLabelText("Creature habitat map")).toBeNull();
  });

  it("shows an unlocked natural habitat immediately at the full zoom-out", async () => {
    render(<CreatureBookPanel snapshot={snapshot({
      bookOrder: 0,
      unlocked: true,
      archetypeKey: "deer",
      name: "Deer",
      rarity: "common",
      ashenUnlocked: false,
      habitat: {
        kind: "natural",
        progress: 100,
        threshold: 100,
        restrictions: [{
          groupId: "environment",
          categoryIds: ["jungle", "pinewild", "greenwood", "frostwood"],
          label: "Forest"
        }],
        active: "any_time"
      },
      killCount: 100,
      drops: []
    })} onBack={() => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: "Open Deer" }));
    expect(screen.getByLabelText("Creature habitat map")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /View Habitat|Hide Habitat/ })).toBeNull();
    const habitatTabs = screen.getByRole("tablist", { name: "Habitat groups" });
    expect(habitatTabs.classList.contains("game-app-tabs-housed")).toBe(true);
    expect(within(habitatTabs).getAllByRole("tab")).toHaveLength(4);
    expect((screen.getByRole("tab", { name: "Biomes" }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole("tab", { name: "Elevation" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("tab", { name: "Terrain" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("tab", { name: "Sea" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Environment · Forest")).toBeTruthy();
    expect(screen.queryByText(/Approximate habitat/i)).toBeNull();
    expect(screen.queryByLabelText(["Approximate", "habitat", "map"].join(" "))).toBeNull();
    await waitFor(() => {
      expect(mapMocks.createWorldMap).toHaveBeenCalled();
      expect(mapMocks.map.jumpTo).toHaveBeenCalledWith({ zoom: WORLD_MAP_MIN_ZOOM });
      expect(mapMocks.installWorldEnvironmentOverlays).toHaveBeenCalledWith(mapMocks.map, expect.any(Function));
      expect(mapMocks.presenter.sync).toHaveBeenCalledWith("environment", [
        "jungle",
        "pinewild",
        "greenwood",
        "frostwood"
      ]);
    });
  });

  it("switches a multi-restriction habitat without recreating the map", async () => {
    render(<CreatureBookPanel snapshot={snapshot({
      bookOrder: 0,
      unlocked: true,
      archetypeKey: "deer",
      name: "Deer",
      rarity: "common",
      ashenUnlocked: false,
      habitat: {
        kind: "natural",
        progress: 100,
        threshold: 100,
        restrictions: [
          { groupId: "environment", categoryIds: ["greenwood"], label: "Forest" },
          { groupId: "elevation", categoryIds: ["moderate", "high"], label: "High Country" }
        ],
        active: "any_time"
      },
      killCount: 100,
      drops: []
    })} onBack={() => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: "Open Deer" }));

    await waitFor(() => {
      expect(mapMocks.presenter.sync).toHaveBeenCalledWith("environment", ["greenwood"]);
    });
    fireEvent.click(screen.getByRole("tab", { name: "Elevation" }));

    expect(screen.getByText("Elevation · High Country")).toBeTruthy();
    await waitFor(() => {
      expect(mapMocks.presenter.sync).toHaveBeenCalledWith("elevation", ["moderate", "high"]);
    });
    expect(mapMocks.createWorldMap).toHaveBeenCalledTimes(1);
  });

  it("installs the latest selected restriction when the map load finishes", async () => {
    mapMocks.map.loaded.mockReturnValue(false);
    render(<CreatureBookPanel snapshot={snapshot({
      bookOrder: 0,
      unlocked: true,
      archetypeKey: "deer",
      name: "Deer",
      rarity: "common",
      ashenUnlocked: false,
      habitat: {
        kind: "natural",
        progress: 100,
        threshold: 100,
        restrictions: [
          { groupId: "environment", categoryIds: ["greenwood"], label: "Forest" },
          { groupId: "elevation", categoryIds: ["high"], label: "High Country" }
        ],
        active: "any_time"
      },
      killCount: 100,
      drops: []
    })} onBack={() => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: "Open Deer" }));
    await waitFor(() => expect(mapMocks.map.once).toHaveBeenCalledWith("load", expect.any(Function)));

    fireEvent.click(screen.getByRole("tab", { name: "Elevation" }));
    const install = mapMocks.map.once.mock.calls[0]?.[1] as (() => void) | undefined;
    install?.();

    expect(mapMocks.presenter.sync).toHaveBeenCalledTimes(1);
    expect(mapMocks.presenter.sync).toHaveBeenCalledWith("elevation", ["high"]);
    expect(mapMocks.createWorldMap).toHaveBeenCalledTimes(1);
  });

  it("uses the footer Back action for detail navigation and preserves the root callback", () => {
    const onBack = vi.fn();
    render(<CreatureBookPanel snapshot={snapshot({
      bookOrder: 0,
      unlocked: true,
      archetypeKey: "deer",
      name: "Deer",
      rarity: "common",
      ashenUnlocked: false,
      habitat: { kind: "natural", progress: 37, threshold: 100, restrictions: null, active: "any_time" },
      killCount: 37,
      drops: []
    })} onBack={onBack} />);

    expect(screen.getByRole("button", { name: "Back to Game Menu" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open Deer" }));
    expect(screen.queryByRole("button", { name: /Creature Index/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /^Back$/ }));
    expect(screen.getByRole("button", { name: "Open Deer" })).toBeTruthy();
    expect(onBack).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Back to Game Menu" }));
    expect(onBack).toHaveBeenCalledOnce();
  });

  it("shows no Ashen appearance tab, even when an Ashen sighting was recorded earlier", () => {
    render(<CreatureBookPanel snapshot={snapshot({
      bookOrder: 0, unlocked: true, archetypeKey: "deer", name: "Deer", rarity: "common",
      ashenUnlocked: true,
      habitat: { kind: "natural", progress: 1, threshold: 100, restrictions: null, active: "any_time" },
      killCount: 1, drops: []
    })} onBack={() => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: "Open Deer" }));
    expect(screen.queryByRole("tab", { name: "Ashen" })).toBeNull();
    expect(screen.queryByText("Ashen Deer")).toBeNull();
  });
});

function snapshot(slot: CreatureBookSnapshot["slots"][number]): CreatureBookSnapshot {
  return { slots: [slot] };
}
