import { describe, expect, it, vi } from "vitest";
import type maplibregl from "maplibre-gl";

import { KingdomMapPresenter } from "./kingdomMap.js";
import { GAMEPLAY_MAP_DETAIL_HIDDEN_ZOOM } from "./mapZoomConfig.js";

describe("Kingdom map objects", () => {
  it("does not create a second Seat marker or territory layer", () => {
    const sources = new Map<string, { setData: ReturnType<typeof vi.fn> }>();
    const layers: Array<{ id: string; minzoom?: number }> = [];
    const map = {
      loaded: () => true,
      once: vi.fn(),
      getSource: (id: string) => sources.get(id),
      addSource: (id: string) => sources.set(id, { setData: vi.fn() }),
      addLayer: (layer: { id: string; minzoom?: number }) => layers.push(layer)
    } as unknown as maplibregl.Map;

    new KingdomMapPresenter(map);

    expect([...sources.keys()]).toEqual(["kingdom-objects"]);
    expect(layers.map(({ id }) => id)).toEqual(["kingdom-objects"]);
    expect(layers[0]).toMatchObject({ minzoom: GAMEPLAY_MAP_DETAIL_HIDDEN_ZOOM });
  });
});
