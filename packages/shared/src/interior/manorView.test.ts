import { describe, expect, it } from "vitest";

import { INTERIOR_DATA } from "../data/interiors/index.js";
import {
  MANOR_BREEDER, MANOR_BREEDER_INTERACTION_RADIUS,
  MANOR_JEWEL, MANOR_JEWEL_INTERACTION_RADIUS, MANOR_SMITH, MANOR_SMITH_INTERACTION_RADIUS,
  DEFAULT_MANOR_TYPE_ID, MANOR_INTERIOR_SPACE, MANOR_TYPES, manorAuthoredRoom, manorAuthoredSpaceId, manorTypeTemplate
} from "../manor.js";
import { DEFAULT_MANOR_TEMPLATE_CATALOG, validateManorTemplateCatalog } from "../manorTemplateCatalog.js";
import {
  SALON_CHAIR, SALON_CHAIR_APPROACH, SALON_CHAIR_INTERACTION_RADIUS, SALON_DOOR, SALON_SPAWN
} from "../salon.js";
import type { InteriorCatalog } from "./interiorCatalog.js";
import { interiorCatalogSchema, validateInteriorCatalog } from "./interiorCatalog.js";
import { manorRoomFloorAssetKey, manorTemplateCatalogInputFromInterior } from "./manorView.js";
import { salonSpace } from "./transforms.js";

const catalog = INTERIOR_DATA as unknown as InteriorCatalog;

const jsonRoundTrip = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

describe("Manor and Salon on the unified interior data", () => {
  it("resolves the default Manor type by id, never by catalog order", () => {
    const template = manorTypeTemplate(DEFAULT_MANOR_TYPE_ID);
    expect(DEFAULT_MANOR_TYPE_ID).toBe("manor_lobby");
    expect(template).toMatchObject({ id: "manor_lobby", defaultRoomId: "manor_lobby_room" });
    expect(manorTypeTemplate("no_such_type").id).toBe(DEFAULT_MANOR_TYPE_ID);
    expect(MANOR_TYPES[0]!.id).toBe(DEFAULT_MANOR_TYPE_ID);
    expect(MANOR_INTERIOR_SPACE.id).toBe(DEFAULT_MANOR_TYPE_ID);
    // Every type's entrance room is the runtime `manor_main_room`; other rooms keep their ids.
    for (const type of MANOR_TYPES) {
      const typeTemplate = manorTypeTemplate(type.id);
      expect(manorAuthoredSpaceId(typeTemplate.defaultRoomId, type.id)).toBe("manor_main_room");
      expect(manorAuthoredRoom("manor_main_room", type.id)?.id).toBe(typeTemplate.defaultRoomId);
    }
  });

  it("projects each room's floor art, the visible world exit and the exterior from the interior data", () => {
    const view = validateManorTemplateCatalog(manorTemplateCatalogInputFromInterior(catalog));
    expect(view).toEqual(DEFAULT_MANOR_TEMPLATE_CATALOG);
    for (const space of catalog.spaces.filter((candidate) => candidate.kind === "manor")) {
      const template = view.templates.find((candidate) => candidate.id === space.id)!;
      for (const room of space.rooms) {
        expect(template.rooms.find((candidate) => candidate.id === room.id)?.floorAssetKey)
          .toBe(manorRoomFloorAssetKey(room, catalog.library.prefabs));
      }
      const lobby = template.rooms.find((room) => room.id === template.defaultRoomId)!;
      const exit = space.portals.find((portal) => portal.destination.kind === "world" && !portal.retired)!;
      expect(lobby.worldExit?.anchorId).toBe(exit.source.kind === "room" ? exit.source.anchorId : null);
      expect(lobby.anchors.some((anchor) => anchor.id === lobby.worldExit!.anchorId)).toBe(false);
      expect(template.exterior?.assetKey ?? null).toBe(space.modules?.manor?.exteriorAssetKey ?? null);
    }
  });

  it("commits the Salon exactly as the transform authors it and the whole catalog validates", () => {
    expect(catalog.spaces.find((space) => space.kind === "salon")).toEqual(jsonRoundTrip(salonSpace()));
    expect(() => interiorCatalogSchema.parse(catalog)).not.toThrow();
    expect(() => validateInteriorCatalog(catalog)).not.toThrow();
    const salon = catalog.spaces.find((space) => space.kind === "salon")!;
    expect(salon.rooms[0]).toMatchObject({ width: 1000, height: 1000 });
  });

  it("authors the stations and the salon chair at their gameplay positions and radii", () => {
    const lobby = catalog.spaces.find((space) => space.id === "manor_lobby")!.rooms.find((room) => room.id === "manor_lobby_room")!;
    const station = (kind: string) => {
      const object = lobby.objects.find((candidate) => candidate.type === "station" && candidate.stationKind === kind)!;
      const anchor = lobby.anchors.find((candidate) => candidate.id === object.anchorId)!;
      return { x: anchor.x, y: anchor.y, radius: object.interactionRadius };
    };
    expect(station("smith")).toEqual({ ...MANOR_SMITH, radius: MANOR_SMITH_INTERACTION_RADIUS });
    expect(station("jewel")).toEqual({ ...MANOR_JEWEL, radius: MANOR_JEWEL_INTERACTION_RADIUS });
    expect(station("breeder")).toEqual({ ...MANOR_BREEDER, radius: MANOR_BREEDER_INTERACTION_RADIUS });
    expect({ ...SALON_CHAIR, radius: SALON_CHAIR_INTERACTION_RADIUS }).toEqual({ x: 500, y: 170, radius: 110 });
    expect(SALON_CHAIR_APPROACH).toEqual({ x: 500, y: 255 });
    expect(SALON_SPAWN).toEqual({ x: 500, y: 790 });
    expect(SALON_DOOR).toEqual({ x: 830, y: 830 });
  });
});
