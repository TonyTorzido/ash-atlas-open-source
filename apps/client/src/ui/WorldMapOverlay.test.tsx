// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type {
  PlayerAppearanceSnapshot,
  WorldMapDestinationSnapshot
} from "@ash-atlas/shared";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  removeMap: vi.fn(),
  removeMarker: vi.fn(),
  createMap: vi.fn(),
  frame: vi.fn(),
  resize: vi.fn(),
  stop: vi.fn(),
  easeTo: vi.fn(),
  flyTo: vi.fn(),
  jumpTo: vi.fn(),
  getCenter: vi.fn(() => ({ lng: -97.25, lat: 41.5 })),
  getZoom: vi.fn(() => 6),
  setMarkerLngLat: vi.fn(),
  markerAnchors: new Map<HTMLElement, string | undefined>(),
  markerElements: [] as HTMLElement[],
  interactionDisable: vi.fn(),
  interactionEnable: vi.fn(),
  destroyPlayerMarker: vi.fn(),
  createPlayerMarker: vi.fn(),
  mapHandlers: new Map<string, (event: {
    lngLat: { lat: number; lng: number };
    preventDefault(): void;
    originalEvent?: { target: EventTarget | null };
  }) => void>()
}));

vi.mock("./worldMapPlayerMarker.js", () => ({
  createWorldMapPlayerMarkerElement: (
    displayColor: string | null,
    appearance?: unknown,
    options?: {
      ariaLabel?: string;
      className?: string;
      label?: string;
      local?: boolean;
      scaleMultiplier?: number;
    }
  ) => {
    if (options) mocks.createPlayerMarker(displayColor, appearance, options);
    else mocks.createPlayerMarker(displayColor, appearance);
    const outer = document.createElement("div");
    outer.className = options?.className ?? "world-map-player-marker";
    outer.setAttribute("role", "img");
    outer.setAttribute(
      "aria-label",
      options?.ariaLabel ?? "Your approximate location"
    );
    const inner = document.createElement("div");
    inner.className = "world-map-player-marker-model";
    inner.style.setProperty(
      "--player-display-color",
      displayColor ?? "#38bdf8"
    );
    outer.append(inner);
    if (options?.label) {
      const label = document.createElement("strong");
      label.textContent = options.label;
      outer.append(label);
    }
    return {
      outer,
      inner,
      destroy: mocks.destroyPlayerMarker
    };
  },
  WORLD_MAP_REMOTE_PLAYER_SCALE: 0.75
}));

vi.mock("maplibre-gl", () => ({
  default: {
    Marker: class {
      private readonly element: HTMLElement;
      constructor(options: { element: HTMLElement; anchor?: string }) {
        this.element = options.element;
        mocks.markerElements.push(options.element);
        mocks.markerAnchors.set(options.element, options.anchor);
      }
      setLngLat(position: [number, number]): this {
        mocks.setMarkerLngLat(this.element, position);
        return this;
      }
      setOffset(): this { return this; }
      addTo(): this { return this; }
      remove(): void {
        const index = mocks.markerElements.indexOf(this.element);
        if (index >= 0) mocks.markerElements.splice(index, 1);
        mocks.markerAnchors.delete(this.element);
        mocks.removeMarker();
      }
    }
  }
}));

vi.mock("../map/worldMap.js", () => ({
  createWorldMap: (_container: HTMLElement, fallbackCenter: { lat: number; lon: number }) => {
    mocks.createMap(fallbackCenter);
    return { map: {
      once: (_event: string, callback: () => void) => callback(),
      remove: mocks.removeMap,
      triggerRepaint: vi.fn(),
      resize: mocks.resize,
      stop: mocks.stop,
      easeTo: mocks.easeTo,
      flyTo: mocks.flyTo,
      jumpTo: mocks.jumpTo,
      getCenter: mocks.getCenter,
      getZoom: mocks.getZoom,
      project: ([lon, lat]: [number, number]) => ({ x: lon * 100, y: lat * 100 }),
      unproject: ([x, y]: [number, number]) => ({ lng: x / 100, lat: y / 100 }),
      getCanvas: () => document.createElement("canvas"),
      addSource: vi.fn(),
      getSource: vi.fn(() => ({})),
      removeSource: vi.fn(),
      addLayer: vi.fn(),
      getLayer: vi.fn(() => ({})),
      removeLayer: vi.fn(),
      setLayoutProperty: vi.fn(),
      dragPan: { disable: mocks.interactionDisable, enable: mocks.interactionEnable },
      scrollZoom: { disable: mocks.interactionDisable, enable: mocks.interactionEnable },
      boxZoom: { disable: mocks.interactionDisable, enable: mocks.interactionEnable },
      keyboard: { disable: mocks.interactionDisable, enable: mocks.interactionEnable },
      touchZoomRotate: {
        disable: mocks.interactionDisable,
        enable: mocks.interactionEnable,
        disableRotation: vi.fn()
      },
      on: (event: string, callback: (event: {
        lngLat: { lat: number; lng: number };
        preventDefault(): void;
        originalEvent?: { target: EventTarget | null };
      }) => void) => {
        mocks.mapHandlers.set(event, callback);
      },
      off: (event: string) => {
        mocks.mapHandlers.delete(event);
      }
    } };
  },
  frameWorldMapDestinations: mocks.frame
}));

import { WorldMapOverlay } from "./WorldMapOverlay.js";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  mocks.markerElements.length = 0;
  mocks.markerAnchors.clear();
  mocks.mapHandlers.clear();
  vi.unstubAllGlobals();
});

const snapshot: WorldMapDestinationSnapshot = {
  destinations: [
    { kind: "city", id: "city-a", name: "Albuquerque", lat: 35, lon: -106 },
    { kind: "manor", id: "manor-a", name: "Your Manor", lat: 36, lon: -105 },
    {
      kind: "kingdom",
      id: "kingdom-a",
      seatId: "seat-a",
      name: "Ash Realm",
      lat: 37,
      lon: -104
    }
  ],
  serverTime: 1
};

const shrineDestination = {
  kind: "atlas_shrine" as const,
  id: "shrine-a",
  name: "North Shrine",
  lat: 38,
  lon: -103
};

const remoteAppearance: PlayerAppearanceSnapshot = {
  schemaVersion: 1,
  catalogRevision: 1,
  revision: 4,
  bodyVariantId: "default",
  poseId: "idle",
  slots: {
    chest: {
      equipmentDefinitionId: "padded_tunic",
      appearanceId: "padded_tunic",
      cosmeticAppearanceId: null
    }
  },
  styles: {},
  activeHand: "melee"
};

const socialSnapshot: WorldMapDestinationSnapshot = {
  ...snapshot,
  socialPlayers: [{
    playerId: "remote-player",
    username: "Bex",
    displayColor: "#c85a8b",
    lat: 39,
    lon: -102,
    publishedAt: "2026-09-11T00:00:00.000Z",
    appearance: remoteAppearance
  }]
};

function destinationMarker(name: string): HTMLElement {
  const marker = mocks.markerElements.find((element) =>
    element.getAttribute("aria-label") === name
  );
  if (!marker) throw new Error(`Missing destination marker: ${name}`);
  return marker;
}

describe("WorldMapOverlay", () => {
  beforeEach(() => {
    window.localStorage.setItem("ash-atlas.world-map.view", "globe");
  });

  it("opens on the list view by default with major then personal destinations", () => {
    window.localStorage.removeItem("ash-atlas.world-map.view");
    const travel = vi.fn(() => "travel-list");
    const city = (id: string, name: string, extra: object) => ({
      kind: "city" as const, id, name, lat: 35, lon: -106, visible: true, ...extra
    });
    render(<WorldMapOverlay
      open snapshot={{
        serverTime: 1,
        destinations: [
          city("c-found", "Foundtown", { discovered: true }),
          city("c-top", "Bigburg", { featured: "top", memberCount: 12, discovered: false }),
          city("c-cap", "Albuquerque", { featured: "capital", memberCount: 3, discovered: false }),
          { kind: "manor" as const, id: "m1", name: "Your Manor", lat: 35, lon: -106, visible: true }
        ]
      }}
      fallbackCenter={{ lat: 35, lon: -106 }}
      travelDisabled={false} developerAccessEnabled={false} developerMenuOpen={false}
      teleportMode="idle" onClose={vi.fn()} onTravel={travel} onOpenDeveloperTools={vi.fn()}
      onTeleportTarget={vi.fn()} onCancelTeleport={vi.fn()}
    />);
    const headings = screen.getAllByRole("heading", { level: 3 }).map((heading) => heading.textContent);
    expect(headings).toEqual(["Major destinations", "Your destinations"]);
    const rows = screen.getAllByRole("button", { name: /^Travel to / }).map((b) => b.getAttribute("aria-label"));
    expect(rows).toEqual(["Travel to Albuquerque", "Travel to Bigburg", "Travel to Your Manor", "Travel to Foundtown"]);
    expect(screen.queryByText(/capital|market/i)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Travel to Albuquerque" }));
    expect(travel).toHaveBeenCalledWith(expect.objectContaining({ id: "c-cap" }));
    fireEvent.click(screen.getByRole("tab", { name: "Globe view" }));
    expect(screen.queryByRole("heading", { level: 3, name: "Major destinations" })).toBeNull();
    expect(window.localStorage.getItem("ash-atlas.world-map.view")).toBe("globe");
  });

  it("uses dots at far zoom, icons at mid zoom and labels only up close", () => {
    const props = {
      open: true, snapshot, fallbackCenter: { lat: 35, lon: -106 },
      travelDisabled: false, developerAccessEnabled: false, developerMenuOpen: false,
      teleportMode: "idle" as const, onClose: vi.fn(), onTravel: vi.fn(),
      onOpenDeveloperTools: vi.fn(), onTeleportTarget: vi.fn(), onCancelTeleport: vi.fn()
    };
    mocks.getZoom.mockReturnValue(3);
    const far = render(<WorldMapOverlay {...props} />);
    expect(destinationMarker("Albuquerque").classList.contains("world-map-marker--dot")).toBe(true);
    expect(destinationMarker("Albuquerque").querySelector("img")).toBeNull();
    far.unmount();
    mocks.getZoom.mockReturnValue(6);
    const mid = render(<WorldMapOverlay {...props} />);
    expect(destinationMarker("Albuquerque").querySelector("img")).toBeTruthy();
    expect(destinationMarker("Albuquerque").dataset.labelVisible).toBe("false");
    mid.unmount();
    mocks.getZoom.mockReturnValue(9);
    render(<WorldMapOverlay {...props} />);
    expect(destinationMarker("Albuquerque").dataset.labelVisible).toBe("true");
    mocks.getZoom.mockReturnValue(6);
  });

  it("waits for and auto-starts the matching Atlas Shrine through the existing travel callback", async () => {
    const travel = vi.fn(() => "travel-shrine");
    const started = vi.fn();
    const view = render(<WorldMapOverlay
      open snapshot={snapshot} fallbackCenter={{ lat: 35, lon: -106 }}
      autoTravelDestination={{ kind: "atlas_shrine", id: shrineDestination.id }}
      travelDisabled={false} developerAccessEnabled={false} developerMenuOpen={false}
      teleportMode="idle" onClose={vi.fn()} onTravel={travel}
      onAutoTravelStarted={started} onOpenDeveloperTools={vi.fn()}
      onTeleportTarget={vi.fn()} onCancelTeleport={vi.fn()}
    />);
    expect(travel).not.toHaveBeenCalled();
    view.rerender(<WorldMapOverlay
      open snapshot={{ ...snapshot, destinations: [...snapshot.destinations, shrineDestination] }}
      fallbackCenter={{ lat: 35, lon: -106 }}
      autoTravelDestination={{ kind: "atlas_shrine", id: shrineDestination.id }}
      travelDisabled={false} developerAccessEnabled={false} developerMenuOpen={false}
      teleportMode="idle" onClose={vi.fn()} onTravel={travel}
      onAutoTravelStarted={started} onOpenDeveloperTools={vi.fn()}
      onTeleportTarget={vi.fn()} onCancelTeleport={vi.fn()}
    />);
    await waitFor(() => expect(travel).toHaveBeenCalledWith(shrineDestination));
    expect(travel).toHaveBeenCalledOnce();
    expect(started).toHaveBeenCalledOnce();
  });
  it("uses the shared phone shell and resizes MapLibre within its body", () => {
    vi.stubGlobal("ResizeObserver", class {
      constructor(private readonly callback: ResizeObserverCallback) {}
      observe(): void { this.callback([], this as unknown as ResizeObserver); }
      disconnect(): void {}
      unobserve(): void {}
    });
    render(<WorldMapOverlay
      open layout="phone" snapshot={snapshot} fallbackCenter={{ lat: 35, lon: -106 }}
      travelDisabled={false} developerAccessEnabled={false} developerMenuOpen={false} teleportMode="idle"
      onClose={vi.fn()} onTravel={vi.fn()} onOpenDeveloperTools={vi.fn()} onTeleportTarget={vi.fn()} onCancelTeleport={vi.fn()}
    />);
    expect(screen.getByRole("dialog", { name: "Atlas" }).classList.contains("phone-menu-layer")).toBe(true);
    expect(screen.getByRole("button", { name: "Back to Game Menu" })).toBeTruthy();
    expect(mocks.resize).toHaveBeenCalled();
  });

  it("contains desktop focus and applies nested Escape priority", () => {
    const close = vi.fn();
    function Harness(): React.JSX.Element {
      const [open, setOpen] = useState(false);
      return <>
        <button type="button" onClick={() => setOpen(true)}>Open World Map</button>
        <WorldMapOverlay
          open={open} layout="desktop" snapshot={snapshot} fallbackCenter={{ lat: 35, lon: -106 }}
          travelDisabled={false} developerAccessEnabled={false} developerMenuOpen={false} teleportMode="idle"
          onClose={() => {
            close();
            setOpen(false);
          }}
          onTravel={vi.fn()} onOpenDeveloperTools={vi.fn()} onTeleportTarget={vi.fn()} onCancelTeleport={vi.fn()}
        />
      </>;
    }
    render(<Harness />);
    const launcher = screen.getByRole("button", { name: "Open World Map" });
    launcher.focus();
    fireEvent.click(launcher);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Search destinations" }));

    const layers = screen.getByRole("button", { name: "Layers" });
    layers.focus();
    fireEvent.click(layers);
    expect(screen.queryByRole("button", { name: "Back to Game Menu" })).toBeNull();
    expect(screen.getByRole("button", { name: "Close" })).toBeTruthy();
    expect(screen.queryByText("Discovered travel destinations")).toBeNull();
    expect(screen.queryByRole("button", { name: "Close World Map" })).toBeNull();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("region", { name: "Layers" })).toBeNull();
    expect(close).not.toHaveBeenCalled();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(close).toHaveBeenCalledOnce();
    expect(screen.queryByRole("dialog", { name: "World Map" })).toBeNull();
    expect(document.activeElement).toBe(launcher);
  });

  it("recreates MapLibre when responsive layout replaces its container", () => {
    const props = {
      open: true,
      snapshot,
      fallbackCenter: { lat: 35, lon: -106 },
      travelDisabled: false,
      developerAccessEnabled: false,
      developerMenuOpen: false,
      teleportMode: "idle" as const,
      onClose: vi.fn(),
      onTravel: vi.fn(),
      onOpenDeveloperTools: vi.fn(),
      onTeleportTarget: vi.fn(),
      onCancelTeleport: vi.fn()
    };
    const view = render(<WorldMapOverlay {...props} layout="desktop" />);
    expect(mocks.frame).not.toHaveBeenCalled();
    expect(mocks.removeMap).not.toHaveBeenCalled();
    view.rerender(<WorldMapOverlay {...props} layout="phone" />);
    expect(mocks.removeMap).toHaveBeenCalledOnce();
    expect(mocks.jumpTo).toHaveBeenCalledWith({
      center: [-97.25, 41.5],
      zoom: 6
    });
    expect(mocks.frame).not.toHaveBeenCalled();
    expect(destinationMarker("Albuquerque")).toBeTruthy();
    expect(destinationMarker("Your Manor")).toBeTruthy();
    expect(destinationMarker("Ash Realm")).toBeTruthy();
    expect(screen.getByRole("dialog", { name: "Atlas" }).classList.contains("phone-menu-layer")).toBe(true);
  });

  it("closes phone Layers with Escape before closing the World Map", () => {
    const close = vi.fn();
    render(<WorldMapOverlay
      open layout="phone" snapshot={snapshot} fallbackCenter={{ lat: 35, lon: -106 }}
      travelDisabled={false} developerAccessEnabled={false} developerMenuOpen={false} teleportMode="idle"
      onClose={close} onTravel={vi.fn()} onOpenDeveloperTools={vi.fn()} onTeleportTarget={vi.fn()} onCancelTeleport={vi.fn()}
    />);
    fireEvent.click(destinationMarker("Albuquerque"));
    fireEvent.click(screen.getByRole("button", { name: "Layers" }));
    expect(screen.queryByRole("button", { name: "Travel" })).toBeNull();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("region", { name: "Layers" })).toBeNull();
    expect(screen.getByRole("button", { name: "Travel" })).toBeTruthy();
    expect(close).not.toHaveBeenCalled();
  });

  it("preserves explicit social audience choices through the map-side control", () => {
    const setSocialVisibility = vi.fn(() => true);
    render(<WorldMapOverlay
      open layout="desktop"
      snapshot={{ ...snapshot, socialVisibility: { friends: false, kingdom_members: true, city_members: false } }}
      fallbackCenter={{ lat: 35, lon: -106 }}
      travelDisabled={false} developerAccessEnabled={false} developerMenuOpen={false} teleportMode="idle"
      onClose={vi.fn()} onTravel={vi.fn()} onOpenDeveloperTools={vi.fn()}
      onTeleportTarget={vi.fn()} onCancelTeleport={vi.fn()}
      onSetSocialVisibility={setSocialVisibility}
    />);
    fireEvent.click(screen.getByRole("button", { name: "Social visibility" }));
    expect(screen.getByRole("button", { name: "Social visibility" }).closest(
      ".world-map-header-shortcuts"
    )).toBeTruthy();
    expect((screen.getByRole("checkbox", { name: "Friends" }) as HTMLInputElement).checked).toBe(false);
    expect((screen.getByRole("checkbox", { name: "Kingdom Members" }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByRole("checkbox", { name: "Friends" }));
    expect(setSocialVisibility).toHaveBeenCalledWith("friends", true);
  });

  it("defaults every social audience on when the snapshot has no saved preference", () => {
    render(<WorldMapOverlay
      open layout="phone" snapshot={snapshot} fallbackCenter={{ lat: 35, lon: -106 }}
      travelDisabled={false} developerAccessEnabled={false} developerMenuOpen={false} teleportMode="idle"
      onClose={vi.fn()} onTravel={vi.fn()} onOpenDeveloperTools={vi.fn()} onTeleportTarget={vi.fn()} onCancelTeleport={vi.fn()}
    />);
    fireEvent.click(screen.getByRole("button", { name: "Social visibility" }));
    for (const label of ["Friends", "Kingdom Members", "City Members"]) {
      expect((screen.getByRole("checkbox", { name: label }) as HTMLInputElement).checked).toBe(true);
    }
  });

  it("keeps map-side Layers and Social controls mutually exclusive on both layouts", () => {
    for (const layout of ["desktop", "phone"] as const) {
      const view = render(<WorldMapOverlay
        open layout={layout} snapshot={snapshot} fallbackCenter={{ lat: 35, lon: -106 }}
        travelDisabled={false} developerAccessEnabled={false} developerMenuOpen={false} teleportMode="idle"
        onClose={vi.fn()} onTravel={vi.fn()} onOpenDeveloperTools={vi.fn()} onTeleportTarget={vi.fn()} onCancelTeleport={vi.fn()}
      />);
      const controls = screen.getByRole("button", { name: "Layers" });
      expect(controls.closest(layout === "phone"
        ? ".world-map-phone-map-region"
        : ".world-map-desktop-map-region"
      )).toBeTruthy();
      fireEvent.click(controls);
      expect(screen.getByRole("region", { name: "Layers" })).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Social visibility" }));
      expect(screen.queryByRole("region", { name: "Layers" })).toBeNull();
      expect(screen.getByRole("region", { name: "Social visibility" })).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Layers" }));
      expect(screen.queryByRole("region", { name: "Social visibility" })).toBeNull();
      expect(screen.getByRole("region", { name: "Layers" })).toBeTruthy();
      view.unmount();
    }
  });

  it("keeps Recenter as the sole World Map map-corner action on both layouts", () => {
    for (const layout of ["desktop", "phone"] as const) {
      const view = render(<WorldMapOverlay
        open layout={layout} snapshot={snapshot} fallbackCenter={{ lat: 35, lon: -106 }}
        travelDisabled={false} developerAccessEnabled={false} developerMenuOpen={false} teleportMode="idle"
        onClose={vi.fn()} onTravel={vi.fn()} onOpenDeveloperTools={vi.fn()} onTeleportTarget={vi.fn()} onCancelTeleport={vi.fn()}
      />);
      const corner = document.querySelector(".world-map-map-corner-controls");
      expect(corner?.querySelectorAll("button")).toHaveLength(1);
      expect(screen.getByRole("button", { name: "Recenter map" }).closest(
        layout === "phone" ? ".world-map-phone-map-region" : ".world-map-desktop-map-region"
      )).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Relocate" })).toBeNull();
      view.unmount();
    }
  });

  it("keeps the header minimal: only globe search, with Manor and Kingdom travel as list rows", () => {
    render(<WorldMapOverlay
      open layout="desktop" snapshot={snapshot} fallbackCenter={{ lat: 35, lon: -106 }}
      travelDisabled={false} developerAccessEnabled={false} developerMenuOpen={false} teleportMode="idle"
      onClose={vi.fn()} onTravel={vi.fn()} onOpenDeveloperTools={vi.fn()} onTeleportTarget={vi.fn()} onCancelTeleport={vi.fn()}
    />);
    expect(Array.from(document.querySelectorAll(".world-map-header-shortcuts > button")).map(
      (button) => button.getAttribute("aria-label")
    )).toEqual(["Search destinations"]);
    expect(screen.queryByRole("button", { name: /Show (Manor|Kingdom) on map/ })).toBeNull();
  });

  it("offers Relocate as a header action with its cooldown semantics", () => {
    const onRelocate = vi.fn();
    const props = {
      open: true, layout: "desktop" as const, snapshot, fallbackCenter: { lat: 35, lon: -106 },
      travelDisabled: false, developerAccessEnabled: false, developerMenuOpen: false, teleportMode: "idle" as const,
      onClose: vi.fn(), onTravel: vi.fn(() => null), onOpenDeveloperTools: vi.fn(), onTeleportTarget: vi.fn(), onCancelTeleport: vi.fn()
    };
    const view = render(<WorldMapOverlay {...props} relocateAction={{
      label: "Relocate — 17h 42m", enabled: false, disabledReason: "You can relocate again in 17h 42m.", onSelect: onRelocate
    }} />);
    const cooldown = screen.getByRole("button", { name: /Relocate — 17h 42m/ });
    expect(cooldown.hasAttribute("disabled")).toBe(true);
    expect(cooldown.getAttribute("title")).toBe("You can relocate again in 17h 42m.");
    view.rerender(<WorldMapOverlay {...props} relocateAction={{ label: "Relocate", enabled: true, disabledReason: null, onSelect: onRelocate }} />);
    fireEvent.click(screen.getByRole("button", { name: "Relocate" }));
    expect(onRelocate).toHaveBeenCalledOnce();
  });

  it("uses the shared smooth recenter plan for the standalone globe", () => {
    render(<WorldMapOverlay
      open layout="desktop" snapshot={snapshot} fallbackCenter={{ lat: 35, lon: -106 }}
      travelDisabled={false} developerAccessEnabled={false} developerMenuOpen={false} teleportMode="idle"
      onClose={vi.fn()} onTravel={vi.fn()} onOpenDeveloperTools={vi.fn()} onTeleportTarget={vi.fn()} onCancelTeleport={vi.fn()}
    />);

    const recenter = screen.getByRole("button", { name: "Recenter map" });
    expect(recenter.closest(".world-map-map-corner-controls")).toBeTruthy();
    expect(recenter.closest(".world-map-header-shortcuts")).toBeNull();
    fireEvent.click(recenter);

    expect(mocks.stop).toHaveBeenCalledOnce();
    expect(mocks.easeTo).toHaveBeenLastCalledWith({
      center: [-106, 35],
      zoom: 6,
      duration: 420,
      easing: expect.any(Function)
    });
  });

  it("does not auto-fit destinations on the initial snapshot or after selection", () => {
    render(<WorldMapOverlay
      open layout="phone" snapshot={snapshot} fallbackCenter={{ lat: 35, lon: -106 }}
      travelDisabled={false} developerAccessEnabled={false} developerMenuOpen={false} teleportMode="idle"
      onClose={vi.fn()} onTravel={vi.fn()} onOpenDeveloperTools={vi.fn()} onTeleportTarget={vi.fn()} onCancelTeleport={vi.fn()}
    />);
    expect(mocks.createMap).toHaveBeenCalledWith({ lat: 35, lon: -106 });
    expect(mocks.frame).not.toHaveBeenCalled();

    fireEvent.click(destinationMarker("Albuquerque"));

    expect(screen.getByRole("button", { name: "Travel" })).toBeTruthy();
    expect(mocks.frame).not.toHaveBeenCalled();
    expect(mocks.easeTo).not.toHaveBeenCalled();
    expect(mocks.jumpTo).not.toHaveBeenCalled();
  });

  it("restores every environment category on each fresh World Map open", () => {
    const props = {
      snapshot,
      fallbackCenter: { lat: 35, lon: -106 },
      travelDisabled: false,
      developerAccessEnabled: false,
      developerMenuOpen: false,
      teleportMode: "idle" as const,
      onClose: vi.fn(),
      onTravel: vi.fn(),
      onOpenDeveloperTools: vi.fn(),
      onTeleportTarget: vi.fn(),
      onCancelTeleport: vi.fn()
    };
    const view = render(<WorldMapOverlay {...props} open />);
    fireEvent.click(screen.getByRole("button", { name: "Layers" }));
    fireEvent.click(screen.getByRole("tab", { name: "Biomes" }));
    const tropicalForest = screen.getByRole("checkbox", { name: "Jungle" }) as HTMLInputElement;
    expect(tropicalForest.checked).toBe(true);
    fireEvent.click(tropicalForest);
    expect(tropicalForest.checked).toBe(false);
    view.rerender(<WorldMapOverlay {...props} open={false} />);
    view.rerender(<WorldMapOverlay {...props} open />);
    fireEvent.click(screen.getByRole("button", { name: "Layers" }));
    fireEvent.click(screen.getByRole("tab", { name: "Biomes" }));
    expect((screen.getByRole("checkbox", { name: "Jungle" }) as HTMLInputElement).checked).toBe(true);
  });

  it("uses the canonical phone prompt and gates duplicate Travel taps", () => {
    const travel = vi.fn(() => "travel-1");
    const view = render(<WorldMapOverlay
      open layout="phone" snapshot={snapshot} fallbackCenter={{ lat: 35, lon: -106 }}
      travelDisabled={false} developerAccessEnabled={false} developerMenuOpen={false} teleportMode="idle"
      onClose={vi.fn()} onTravel={travel} onOpenDeveloperTools={vi.fn()} onTeleportTarget={vi.fn()} onCancelTeleport={vi.fn()}
    />);
    expect(view.container.querySelector(".world-map-destination-tray")).toBeNull();
    expect(view.container.querySelector(".world-map-destinations")).toBeNull();
    expect(view.container.querySelector(".world-map-selection")).toBeNull();
    fireEvent.click(destinationMarker("Albuquerque"));
    expect(screen.getByText("Travel cost: 1 Hunger")).toBeTruthy();
    const button = screen.getByRole("button", { name: "Travel" });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(travel).toHaveBeenCalledOnce();
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });

  it("creates one colored, accessible local-player marker at the fallback center", () => {
    const appearance: PlayerAppearanceSnapshot = {
      schemaVersion: 1,
      catalogRevision: 1,
      revision: 7,
      bodyVariantId: "default",
      poseId: "idle",
      slots: {},
      styles: {},
      activeHand: null
    };
    render(<WorldMapOverlay
      open snapshot={snapshot} fallbackCenter={{ lat: 35, lon: -106 }}
      displayColor="#4a8ed8"
      appearance={appearance}
      travelDisabled={false} developerAccessEnabled={false} developerMenuOpen={false} teleportMode="idle"
      onClose={vi.fn()} onTravel={vi.fn()} onOpenDeveloperTools={vi.fn()} onTeleportTarget={vi.fn()} onCancelTeleport={vi.fn()}
    />);
    const playerMarkers = mocks.markerElements.filter((element) =>
      element.classList.contains("world-map-player-marker")
    );
    expect(playerMarkers).toHaveLength(1);
    const playerMarker = playerMarkers[0]!;
    expect(playerMarker.getAttribute("role")).toBe("img");
    expect(playerMarker.getAttribute("aria-label")).toBe(
      "Your approximate location"
    );
    expect(
      (playerMarker.querySelector(".world-map-player-marker-model") as HTMLElement)
        .style.getPropertyValue("--player-display-color")
    ).toBe("#4a8ed8");
    expect(mocks.setMarkerLngLat).toHaveBeenCalledWith(
      playerMarker,
      [-106, 35]
    );
    expect(mocks.createPlayerMarker).toHaveBeenCalledWith("#4a8ed8", appearance);
  });

  it("renders remote players through the shared appearance renderer at three-quarter scale", () => {
    render(<WorldMapOverlay
      open snapshot={socialSnapshot} fallbackCenter={{ lat: 35, lon: -106 }}
      displayColor="#4a8ed8" appearance={remoteAppearance}
      travelDisabled={false} developerAccessEnabled={false} developerMenuOpen={false} teleportMode="idle"
      onClose={vi.fn()} onTravel={vi.fn()} onOpenDeveloperTools={vi.fn()} onTeleportTarget={vi.fn()} onCancelTeleport={vi.fn()}
    />);
    const remote = mocks.markerElements.find((element) =>
      element.classList.contains("world-map-social-player-marker")
    );
    expect(remote).toBeTruthy();
    expect(remote?.classList.contains("world-map-player-marker")).toBe(true);
    expect(remote?.getAttribute("role")).toBe("img");
    expect(remote?.getAttribute("aria-label")).toBe("Bex approximate location");
    expect(remote?.querySelector(".world-map-player-marker-model")).toBeTruthy();
    expect(remote?.querySelector("strong")?.textContent).toBe("Bex");
    expect(remote?.textContent).not.toContain("●");
    expect(mocks.setMarkerLngLat).toHaveBeenCalledWith(remote, [-102, 39]);
    expect(mocks.createPlayerMarker).toHaveBeenCalledWith(
      "#c85a8b",
      remoteAppearance,
      expect.objectContaining({
        className: "world-map-player-marker world-map-social-player-marker",
        local: false,
        label: "Bex",
        scaleMultiplier: 0.75
      })
    );
  });

  it("keeps natural map colors and forbids phone tint presentation", () => {
    const sourceDirectory = resolve(process.cwd(), "src");
    const styles = readFileSync(resolve(sourceDirectory, "styles.css"), "utf8");
    const theme = readFileSync(resolve(sourceDirectory, "ashAtlasTheme.css"), "utf8");
    const mapSource = readFileSync(resolve(sourceDirectory, "map/worldMap.ts"), "utf8");
    expect(mapSource).toContain('"fill-color": "#9fc4d1"');
    expect(mapSource).toContain('"fill-color": "#d8d0bb"');
    expect(styles).toMatch(/\.world-map-phone-map-region \.world-map-canvas\s*\{[^}]*opacity: 1;[^}]*filter: none;[^}]*mix-blend-mode: normal;/s);
    expect(theme).toMatch(/\.world-map-overlay--phone-content\s*\{[^}]*opacity: 1;[^}]*filter: none;[^}]*mix-blend-mode: normal;/s);
    expect(theme).toMatch(/\.world-map-overlay--phone-content::before,[\s\S]*?content: none;/);
  });

  it("renders only authorized destination markers without a permanent list", () => {
    render(<WorldMapOverlay
      open
      snapshot={snapshot}
      fallbackCenter={{ lat: 35, lon: -106 }}
      travelDisabled={false}
      developerAccessEnabled={false}
      developerMenuOpen={false}
      teleportMode="idle"
      onClose={vi.fn()}
      onTravel={vi.fn()}
      onOpenDeveloperTools={vi.fn()}
      onTeleportTarget={vi.fn()}
      onCancelTeleport={vi.fn()}
    />);
    expect(destinationMarker("Albuquerque")).toBeTruthy();
    expect(destinationMarker("Your Manor")).toBeTruthy();
    expect(destinationMarker("Ash Realm")).toBeTruthy();
    expect(document.querySelector(".world-map-destination-list")).toBeNull();
    expect(document.querySelector(".world-map-destination-tray")).toBeNull();
  });

  it("centers each destination PNG on its coordinate without label-driven layout", () => {
    render(<WorldMapOverlay
      open
      snapshot={snapshot}
      fallbackCenter={{ lat: 35, lon: -106 }}
      travelDisabled={false}
      developerAccessEnabled={false}
      developerMenuOpen={false}
      teleportMode="idle"
      onClose={vi.fn()}
      onTravel={vi.fn()}
      onOpenDeveloperTools={vi.fn()}
      onTeleportTarget={vi.fn()}
      onCancelTeleport={vi.fn()}
    />);
    const city = destinationMarker("Albuquerque");
    const manor = destinationMarker("Your Manor");
    expect(mocks.markerAnchors.get(city)).toBe("center");
    expect(city.classList.contains("world-map-marker--destination")).toBe(true);
    // Authored destination markers retain their fixed production dimensions.
    expect(city.style.width).toBe("50px");
    expect(city.style.height).toBe("50px");
    expect(manor.style.width).toBe("44px");
    expect(manor.style.height).toBe("44px");
    expect((manor.querySelector("img") as HTMLImageElement).style.width).toBe("42px");

    const styles = readFileSync(resolve(process.cwd(), "src/styles.css"), "utf8");
    expect(styles).toMatch(/button\.world-map-marker--destination\s*\{[^}]*position: absolute;[^}]*display: grid;[^}]*place-items: center;/s);
    expect(styles).toMatch(/\.world-map-player-marker\s*\{[^}]*position: absolute;/s);
    expect(styles).toMatch(/\.world-map-marker strong\s*\{[^}]*position: absolute;[^}]*left: 50%;/s);
    expect(styles).toMatch(/\.world-map-destination-search\s*\{[^}]*z-index: 10;/s);
    expect(styles).toMatch(/\.world-map-layer-control\s*\{[^}]*z-index: 10;/s);
    expect(styles).toMatch(/\.world-map-player-marker\s*\{[^}]*z-index: 8;/s);
    expect(styles).toMatch(/\.world-map-map-controls\s*\{[^}]*z-index: 10;/s);
    expect(styles).toMatch(/\.world-map-overlay \.maplibregl-marker\.world-map-social-player-marker\s*\{[^}]*z-index: 1000 !important;/s);
    expect(styles).toMatch(/\.world-map-map-corner-controls\s*\{[^}]*bottom: 10px;[^}]*left: 10px;/s);
    expect(styles).toMatch(/data-ui-profile="phone"\] \.world-map-destination-search-input input\s*\{[^}]*font-size: 16px;/s);
  });

  it("excludes MapLibre-owned marker transforms from phone transitions", () => {
    const theme = readFileSync(
      resolve(process.cwd(), "src/ashAtlasTheme.css"),
      "utf8"
    );
    expect(theme).toMatch(/data-ui-profile="phone"\] \.phone-destination-shell button\.world-map-marker\s*\{[^}]*transition: opacity \.2s;/s);
  });

  it("travels through the selected durable destination and releases map resources on close", () => {
    const travel = vi.fn(() => "travel-1");
    const view = render(<WorldMapOverlay
      open
      snapshot={snapshot}
      fallbackCenter={{ lat: 35, lon: -106 }}
      travelDisabled={false}
      developerAccessEnabled={false}
      developerMenuOpen={false}
      teleportMode="idle"
      onClose={vi.fn()}
      onTravel={travel}
      onOpenDeveloperTools={vi.fn()}
      onTeleportTarget={vi.fn()}
      onCancelTeleport={vi.fn()}
    />);
    fireEvent.click(destinationMarker("Ash Realm"));
    fireEvent.click(screen.getByRole("button", { name: "Travel" }));
    expect(travel).toHaveBeenCalledWith(snapshot.destinations[2]);
    view.rerender(<WorldMapOverlay
      open={false}
      snapshot={snapshot}
      fallbackCenter={{ lat: 35, lon: -106 }}
      travelDisabled={false}
      developerAccessEnabled={false}
      developerMenuOpen={false}
      teleportMode="idle"
      onClose={vi.fn()}
      onTravel={travel}
      onOpenDeveloperTools={vi.fn()}
      onTeleportTarget={vi.fn()}
      onCancelTeleport={vi.fn()}
    />);
    expect(mocks.removeMap).toHaveBeenCalledOnce();
  });

  it("keeps the World Map open and locks interaction during active travel", () => {
    const close = vi.fn();
    const cancelTravel = vi.fn();
    const presentationComplete = vi.fn();
    const startedAtMs = performance.now();
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    }));
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const view = render(<WorldMapOverlay
      open
      snapshot={snapshot}
      fallbackCenter={{ lat: 35, lon: -106 }}
      travelState={{
        phase: "travelling",
        requestId: "travel-1",
        origin: { lat: 35, lon: -106 },
        destination: snapshot.destinations[0]!,
        startedAtMs,
        durationMs: 5_000,
        authoritativeSuccess: false,
        presentationComplete: false
      }}
      travelDisabled={false}
      developerAccessEnabled={false}
      developerMenuOpen={false}
      teleportMode="idle"
      onClose={close}
      onTravel={vi.fn()}
      onCancelTravel={cancelTravel}
      onPresentationComplete={presentationComplete}
      onArrivalComplete={vi.fn()}
      onOpenDeveloperTools={vi.fn()}
      onTeleportTarget={vi.fn()}
      onCancelTeleport={vi.fn()}
    />);
    expect(screen.getByRole("dialog", { name: "World Map" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Close World Map" })).toBeNull();
    expect((screen.getByRole("button", {
      name: "Close"
    }) as HTMLButtonElement).disabled).toBe(true);
    expect(close).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(cancelTravel).toHaveBeenCalledOnce();
    expect(mocks.interactionDisable).toHaveBeenCalledTimes(5);
    expect(view.container.querySelectorAll(".world-map-travel-route")).toHaveLength(1);
    expect(mocks.markerElements.find((element) =>
      element.classList.contains("world-map-player-marker--travelling")
    )).toBeTruthy();

    // Drive the actual route frames: reaching its midpoint cannot request
    // arrival, and reaching the endpoint reports completion exactly once.
    expect(mocks.flyTo).toHaveBeenCalledWith(expect.objectContaining({ duration: 1_100, essential: true }));
    // The 1.1s camera intro holds the line at the origin before the route animates.
    act(() => frames.shift()!(startedAtMs + 500));
    expect(Number(view.container.querySelector<SVGPathElement>(".world-map-travel-route-completed")!
      .style.strokeDashoffset)).toBeCloseTo(1, 10);
    act(() => frames.shift()!(startedAtMs + 3_050));
    expect(presentationComplete).not.toHaveBeenCalled();
    expect(Number(view.container.querySelector<SVGPathElement>(".world-map-travel-route-completed")!
      .style.strokeDashoffset)).toBeCloseTo(0.5, 10);
    act(() => frames.shift()!(startedAtMs + 5_000));
    expect(presentationComplete).toHaveBeenCalledExactlyOnceWith("travel-1");
    // The finished route must not linger while the arrival camera moves.
    expect(view.container.querySelectorAll(".world-map-travel-route")).toHaveLength(0);
    expect(mocks.setMarkerLngLat).toHaveBeenLastCalledWith(
      expect.any(HTMLElement), [-106, 35]
    );

    view.unmount();
    expect(window.cancelAnimationFrame).toHaveBeenCalled();
    expect(mocks.interactionEnable).toHaveBeenCalledTimes(5);
    expect(document.querySelector(".world-map-travel-route")).toBeNull();
  });

  it("locks map markers without native disabled state and restores interaction after travel", () => {
    const baseProps = {
      open: true,
      snapshot,
      fallbackCenter: { lat: 35, lon: -106 },
      travelDisabled: false,
      developerAccessEnabled: false,
      developerMenuOpen: false,
      teleportMode: "idle" as const,
      onClose: vi.fn(),
      onTravel: vi.fn(),
      onOpenDeveloperTools: vi.fn(),
      onTeleportTarget: vi.fn(),
      onCancelTeleport: vi.fn()
    };
    vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1));
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const view = render(<WorldMapOverlay {...baseProps} />);
    const idleManorMarker = mocks.markerElements.find((element) =>
      element.getAttribute("aria-label") === "Your Manor"
    ) as HTMLButtonElement;
    const manorAssetUrl = idleManorMarker.querySelector("img")?.src;
    expect(idleManorMarker.disabled).toBe(false);
    expect(idleManorMarker.getAttribute("aria-disabled")).toBe("false");
    expect(idleManorMarker.dataset.travelLocked).toBe("false");
    expect(idleManorMarker.tabIndex).toBe(0);

    view.rerender(<WorldMapOverlay
      {...baseProps}
      travelState={{
        phase: "travelling",
        requestId: "travel-1",
        origin: { lat: 35, lon: -106 },
        destination: snapshot.destinations[0]!,
        startedAtMs: performance.now(),
        durationMs: 5_000,
        authoritativeSuccess: false,
        presentationComplete: false
      }}
    />);
    const lockedManorMarker = mocks.markerElements.find((element) =>
      element.getAttribute("aria-label") === "Your Manor"
    ) as HTMLButtonElement;
    expect(lockedManorMarker.disabled).toBe(false);
    expect(lockedManorMarker.getAttribute("aria-disabled")).toBe("true");
    expect(lockedManorMarker.dataset.travelLocked).toBe("true");
    expect(lockedManorMarker.tabIndex).toBe(-1);
    expect(lockedManorMarker.querySelector("img")?.src).toBe(manorAssetUrl);
    fireEvent.click(lockedManorMarker);
    expect(screen.queryByRole("button", { name: "Travel" })).toBeNull();

    view.rerender(<WorldMapOverlay {...baseProps} />);
    const restoredManorMarker = mocks.markerElements.find((element) =>
      element.getAttribute("aria-label") === "Your Manor"
    ) as HTMLButtonElement;
    expect(restoredManorMarker.disabled).toBe(false);
    expect(restoredManorMarker.getAttribute("aria-disabled")).toBe("false");
    expect(restoredManorMarker.dataset.travelLocked).toBe("false");
    expect(restoredManorMarker.tabIndex).toBe(0);
    fireEvent.click(restoredManorMarker);
    expect(screen.getByRole("complementary", { name: "Your Manor actions" })).toBeTruthy();
    expect(screen.queryByText(/Travel cost:/)).toBeNull();
  });

  it("keeps transparent marker presentation while travel is locked", () => {
    const styles = readFileSync(
      resolve(process.cwd(), "src/styles.css"),
      "utf8"
    );
    expect(styles).toMatch(/button\.world-map-marker\s*\{[^}]*appearance: none;[^}]*background: transparent;[^}]*box-shadow: none;/s);
    expect(styles).toMatch(/button\.world-map-marker\[data-travel-locked="true"\]\s*\{[^}]*background: transparent;[^}]*box-shadow: none;[^}]*pointer-events: none;/s);
    expect(styles).toMatch(/\.world-map-marker img\s*\{[^}]*background: transparent;[^}]*filter: none;[^}]*opacity: 1;/s);
    expect(styles).toMatch(/\.world-map-overlay:not\(\.world-map-overlay--phone-content\) button\.world-map-marker[\s\S]*?background: transparent;[\s\S]*?background-image: none;[\s\S]*?box-shadow: none;/s);
  });

  it("renders the Layers and Social popovers on one opaque parchment surface above the map", () => {
    const styles = readFileSync(resolve(process.cwd(), "src/styles.css"), "utf8");
    const start = styles.indexOf("html:root[data-ui-profile] .world-map-layer-control .world-map-layer-menu,");
    expect(start).toBeGreaterThan(0);
    const block = styles.slice(start, styles.indexOf("}", start));
    expect(block).toContain(".world-map-social-control .world-map-social-menu");
    expect(block).toContain("background: var(--aa-menu-paper);");
    expect(block).toContain("backdrop-filter: none;");
    expect(block).toContain("z-index: 2000;");
    expect(styles).toMatch(/html:root \.world-map-map-controls,[^{]*\{[^}]*z-index: 2000;/s);
  });

  it("uses the reduced-motion marker treatment without changing travel timing", () => {
    vi.stubGlobal("matchMedia", vi.fn(() => ({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    })));
    vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1));
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    render(<WorldMapOverlay
      open
      snapshot={snapshot}
      fallbackCenter={{ lat: 35, lon: -106 }}
      travelState={{
        phase: "travelling",
        requestId: "travel-1",
        origin: { lat: 35, lon: -106 },
        destination: snapshot.destinations[0]!,
        startedAtMs: performance.now(),
        durationMs: 5_000,
        authoritativeSuccess: false,
        presentationComplete: false
      }}
      travelDisabled={false}
      developerAccessEnabled={false}
      developerMenuOpen={false}
      teleportMode="idle"
      onClose={vi.fn()}
      onTravel={vi.fn()}
      onPresentationComplete={vi.fn()}
      onArrivalComplete={vi.fn()}
      onOpenDeveloperTools={vi.fn()}
      onTeleportTarget={vi.fn()}
      onCancelTeleport={vi.fn()}
    />);
    expect(mocks.markerElements.find((element) =>
      element.classList.contains("world-map-player-marker--reduced-motion")
    )).toBeTruthy();
    expect(screen.getByText(/5 seconds remaining/)).toBeTruthy();
  });

  it("shows a matching failure inline, restores the origin marker, and re-enables Travel", () => {
    render(<WorldMapOverlay
      open
      snapshot={snapshot}
      fallbackCenter={{ lat: 40, lon: -100 }}
      travelState={{
        phase: "failed",
        requestId: "travel-1",
        origin: { lat: 35, lon: -106 },
        destination: snapshot.destinations[0]!,
        message: "Travel is blocked while harvesting."
      }}
      travelDisabled={false}
      developerAccessEnabled={false}
      developerMenuOpen={false}
      teleportMode="idle"
      onClose={vi.fn()}
      onTravel={vi.fn(() => "travel-2")}
      onPresentationComplete={vi.fn()}
      onArrivalComplete={vi.fn()}
      onOpenDeveloperTools={vi.fn()}
      onTeleportTarget={vi.fn()}
      onCancelTeleport={vi.fn()}
    />);
    expect(screen.getByText("Travel is blocked while harvesting.")).toBeTruthy();
    fireEvent.click(destinationMarker("Albuquerque"));
    expect((screen.getByRole("button", { name: "Travel" }) as HTMLButtonElement).disabled).toBe(false);
    const playerMarker = mocks.markerElements.find((element) =>
      element.classList.contains("world-map-player-marker--failed")
    );
    expect(playerMarker).toBeTruthy();
    expect(mocks.setMarkerLngLat).toHaveBeenCalledWith(
      playerMarker,
      [-106, 35]
    );
  });

  it("opens developer tools and routes targeting clicks through the World Map", () => {
    const openDeveloperTools = vi.fn();
    const teleport = vi.fn();
    render(<WorldMapOverlay
      open
      snapshot={snapshot}
      fallbackCenter={{ lat: 35, lon: -106 }}
      travelDisabled={false}
      developerAccessEnabled
      developerMenuOpen={false}
      teleportMode="targeting"
      onClose={vi.fn()}
      onTravel={vi.fn()}
      onOpenDeveloperTools={openDeveloperTools}
      onTeleportTarget={teleport}
      onCancelTeleport={vi.fn()}
    />);
    fireEvent.click(screen.getByRole("button", { name: "DEV" }));
    expect(openDeveloperTools).toHaveBeenCalledOnce();
    fireEvent.click(destinationMarker("Albuquerque"));
    expect(screen.queryByRole("button", { name: "Travel" })).toBeNull();
    mocks.mapHandlers.get("click")?.({
      lngLat: { lat: 35.0844, lng: -106.6504 },
      preventDefault: vi.fn()
    });
    expect(teleport).toHaveBeenCalledWith(35.0844, -106.6504);
    expect(screen.getByText(/Teleport mode: click the World Map/)).toBeTruthy();
  });

  it("opens the canonical picker for exact-coordinate destinations", () => {
    const closeSnapshot: WorldMapDestinationSnapshot = {
      ...snapshot,
      destinations: [
        snapshot.destinations[0]!,
        { ...snapshot.destinations[1]!, lat: 35.0004, lon: -106.0004 },
        snapshot.destinations[2]!
      ]
    };
    render(<WorldMapOverlay
      open
      snapshot={closeSnapshot}
      fallbackCenter={{ lat: 35, lon: -106 }}
      travelDisabled={false}
      developerAccessEnabled={false}
      developerMenuOpen={false}
      teleportMode="idle"
      onClose={vi.fn()}
      onTravel={vi.fn()}
      onOpenDeveloperTools={vi.fn()}
      onTeleportTarget={vi.fn()}
      onCancelTeleport={vi.fn()}
    />);
    const groupMarker = mocks.markerElements.find((element) =>
      element.classList.contains("world-map-marker--group")
    );
    expect(groupMarker).toBeTruthy();
    fireEvent.click(groupMarker!);
    expect(mocks.easeTo).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "2 nearby destinations" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Choose Destination" })).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: /Albuquerque/ }));
    fireEvent.click(screen.getByRole("button", { name: /Your Manor/ }));
    expect(screen.getByRole("complementary", { name: "Your Manor actions" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Travel" })).toBeTruthy();
  });

  it("searches every authorized destination and toggles map visibility", () => {
    const setVisibility = vi.fn(() => true);
    const searchableSnapshot: WorldMapDestinationSnapshot = {
      ...snapshot,
      destinations: [
        ...snapshot.destinations,
        {
          kind: "city",
          id: "city-mexico",
          name: "Ciudad de México",
          lat: 19.4326,
          lon: -99.1332,
          visible: false
        },
        { ...shrineDestination, visible: true }
      ]
    };
    render(<WorldMapOverlay
      open layout="phone" snapshot={searchableSnapshot}
      fallbackCenter={{ lat: 35, lon: -106 }}
      travelDisabled={false} developerAccessEnabled={false} developerMenuOpen={false}
      teleportMode="idle" onClose={vi.fn()} onTravel={vi.fn()}
      onOpenDeveloperTools={vi.fn()} onTeleportTarget={vi.fn()} onCancelTeleport={vi.fn()}
      onSetDestinationVisibility={setVisibility}
    />);
    expect(mocks.markerElements.some((element) =>
      element.getAttribute("aria-label") === "Ciudad de México"
    )).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Search destinations" }));
    const searchbox = screen.getByRole("searchbox", { name: "Search travel destinations" });
    expect(document.activeElement).not.toBe(searchbox);
    searchbox.focus();
    fireEvent(window, new Event("pagehide"));
    expect(document.activeElement).not.toBe(searchbox);

    const albuquerqueVisibility = screen.getByRole("checkbox", {
      name: "Show Albuquerque on World Map"
    }) as HTMLInputElement;
    expect(albuquerqueVisibility.checked).toBe(true);
    fireEvent.click(albuquerqueVisibility);
    expect(albuquerqueVisibility.checked).toBe(false);
    expect(albuquerqueVisibility.disabled).toBe(true);
    expect(setVisibility).toHaveBeenCalledWith(
      expect.objectContaining({ id: "city-a", kind: "city" }),
      false
    );

    const mexicoVisibility = screen.getByRole("checkbox", {
      name: "Show Ciudad de México on World Map"
    }) as HTMLInputElement;
    expect(mexicoVisibility.checked).toBe(false);
    fireEvent.click(mexicoVisibility);
    expect(mexicoVisibility.checked).toBe(true);
    expect(mexicoVisibility.disabled).toBe(true);
    expect(setVisibility).toHaveBeenCalledWith(
      expect.objectContaining({ id: "city-mexico", kind: "city" }),
      true
    );
    expect(screen.getByRole("dialog", { name: "Search destinations" })).toBeTruthy();
    expect(mocks.easeTo).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("tab", { name: "Personal" }));
    expect(screen.getByRole("button", { name: /North Shrine/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Your Manor/ })).toBeTruthy();
    expect(Array.from(document.querySelectorAll(".world-map-destination-search-target strong")).map(
      (element) => element.textContent
    )).toEqual(["Your Manor", "North Shrine"]);
    fireEvent.click(screen.getByRole("tab", { name: "Kingdom" }));
    expect(screen.getByRole("button", { name: /Ash Realm/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "Cities" }));
    fireEvent.change(searchbox, { target: { value: "mexico" } });
    expect(screen.getByText("City")).toBeTruthy();
    expect(screen.queryByText("Discovered city")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Ciudad de México/ }));
    expect(mocks.easeTo).toHaveBeenLastCalledWith({
      center: [-99.1332, 19.4326],
      duration: 300
    });
    expect(screen.queryByRole("dialog", { name: "Search destinations" })).toBeNull();

    expect(setVisibility).toHaveBeenCalledTimes(2);
  });

  it("uses compact phone loading, empty, offline-error, and clustered states", () => {
    const base = {
      open: true,
      layout: "phone" as const,
      fallbackCenter: { lat: 35, lon: -106 },
      travelDisabled: false,
      developerAccessEnabled: false,
      developerMenuOpen: false,
      teleportMode: "idle" as const,
      onClose: vi.fn(),
      onTravel: vi.fn(),
      onOpenDeveloperTools: vi.fn(),
      onTeleportTarget: vi.fn(),
      onCancelTeleport: vi.fn()
    };
    const view = render(<WorldMapOverlay {...base} snapshot={null} />);
    expect(screen.getByRole("status").textContent).toContain("Loading authorized destinations");
    view.rerender(<WorldMapOverlay {...base} snapshot={{ destinations: [], serverTime: 1 }} />);
    expect(screen.queryByRole("status")).toBeNull();
    view.rerender(<WorldMapOverlay
      {...base}
      snapshot={null}
      connectionStatus="offline"
    />);
    expect(screen.getByRole("alert").textContent).toContain("unavailable while offline");
    view.rerender(<WorldMapOverlay {...base} snapshot={{
      serverTime: 1,
      destinations: Array.from({ length: 30 }, (_, index) => ({
        kind: "city" as const,
        id: `city-${index}`,
        name: `Town ${index}`,
        lat: 35 + index * 0.01,
        lon: -106
      }))
    }} />);
    expect(mocks.markerElements.some((element) =>
      element.classList.contains("world-map-marker--group")
    )).toBe(true);
    const groupMarker = mocks.markerElements.find((element) =>
      element.classList.contains("world-map-marker--group")
    );
    fireEvent.click(groupMarker!);
    expect(screen.getByRole("dialog", { name: "30 nearby destinations" })).toBeTruthy();
    expect(mocks.easeTo).not.toHaveBeenCalled();
    expect(view.container.querySelector(".game-target-list")).toBeTruthy();
    expect(view.container.querySelector(".world-map-tray-list")).toBeNull();
    expect(view.container.querySelector("select")).toBeNull();
  });
});
