import { describe, expect, it, vi } from "vitest";

import { GREENHOUSE_ROOM_HEIGHT, GREENHOUSE_ROOM_WIDTH, GREENHOUSE_STUDIO_CATALOG, SALON_CHAIR, SALON_DOOR, SALON_FLOOR_SIZE } from "@ash-atlas/shared";

vi.mock("../../map/runtimePngAssetUrl.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  runtimePngAssetUrl: (path: string) => `/runtime/${path}`
}));

import { GREENHOUSE_ROOM, greenhouseMapSpaceKey, greenhouseSprites } from "./greenhouseMapInterior.js";
import { SALON_ROOM, salonFixtureAt, salonMapSpaceKey, salonSprites } from "./salonMapInterior.js";

describe("salon map interior", () => {
  it("keys the space by structure and sizes the room to the authored floor", () => {
    expect(salonMapSpaceKey("s1")).toBe("salon:s1");
    expect(SALON_ROOM).toEqual({ width: SALON_FLOOR_SIZE, height: SALON_FLOOR_SIZE });
  });

  it("finds the chair and door under a room-unit tap, and nothing on open floor", () => {
    expect(salonFixtureAt(SALON_CHAIR)).toBe("chair");
    expect(salonFixtureAt(SALON_DOOR)).toBe("door");
    expect(salonFixtureAt({ x: 20, y: 20 })).toBeNull();
  });

  it("draws floor, mirror, door and chair with the floor at the back", () => {
    const sprites = salonSprites();
    expect(sprites.map((sprite) => sprite.key)).toEqual(["salon-floor", "salon-mirror", "salon-door", "salon-chair"]);
    expect(sprites[0]).toMatchObject({ layerId: "background", x: 0, y: 0, width: SALON_FLOOR_SIZE, height: SALON_FLOOR_SIZE });
    expect(sprites.find((sprite) => sprite.key === "salon-chair")).toMatchObject({ x: SALON_CHAIR.x, y: SALON_CHAIR.y });
  });
});

describe("greenhouse map interior", () => {
  const state = {
    greenhouse: {
      greenhouseId: "g1",
      anchors: [],
      waterStorage: { ...GREENHOUSE_STUDIO_CATALOG.waterStorage, placed: false },
      tankWaterTenths: 0
    },
    cropCatalog: { packId: null, crops: [] }
  } as never;

  it("keys the space by greenhouse and uses the authored room size", () => {
    expect(greenhouseMapSpaceKey("g1")).toBe("greenhouse:g1");
    expect(GREENHOUSE_ROOM).toEqual({ width: GREENHOUSE_ROOM_WIDTH, height: GREENHOUSE_ROOM_HEIGHT });
  });

  it("draws the floor and every authored overlay at its catalog position", () => {
    const sprites = greenhouseSprites({ state, preview: null });
    expect(sprites[0]).toMatchObject({ key: "greenhouse-floor", layerId: "background", width: GREENHOUSE_ROOM_WIDTH, height: GREENHOUSE_ROOM_HEIGHT });
    for (const overlay of GREENHOUSE_STUDIO_CATALOG.overlays) {
      expect(sprites.find((sprite) => sprite.key === `greenhouse-overlay:${overlay.overlayId}`))
        .toMatchObject({ x: overlay.x, y: overlay.y, width: overlay.width, height: overlay.height });
    }
  });
});
