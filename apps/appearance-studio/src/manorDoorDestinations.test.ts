import path from "node:path";
import { fileURLToPath } from "node:url";

import { manorTemplateCatalogInputFromInterior, validateManorTemplateCatalog, manorAnchorDestinations } from "@ash-atlas/shared";
import { describe, expect, it } from "vitest";

import { readDungeonInteriorFiles } from "./dungeonInteriorStore.js";
import { connectDungeonRooms } from "./dungeonTopology.js";
import { interiorEditingView, interiorFromEditingView } from "./interiorStudioModel.js";
import { setDoorDestinations, WORLD_DESTINATION, type AuthoringView } from "./interiorAuthoring.js";

const interiors = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/shared/src/data/interiors");

describe("Manor door with several destinations", () => {
  it("turns fresh anchors into a two-destination door and the front door from the Anchor inspector", async () => {
    const { interior } = await readDungeonInteriorFiles(interiors);
    const sources = { base: interior, seeds: {} };
    const view = interiorEditingView(interior) as AuthoringView;
    const haunted = view.dungeons.find((dungeon) => dungeon.id === "haunted_manor")!;
    const lobby = haunted.rooms.find((room) => room.id === "haunted_manor_lobby")!;
    lobby.anchors.push({ id: "new_left_door", retired: false, x: 110, y: 1000 }, { id: "new_right_door", retired: false, x: 1150, y: 1000 });
    const left = setDoorDestinations(view, sources, "haunted_manor", lobby.id, "new_left_door", [
      { roomId: "haunted_manor_hallway", anchorId: "return_to_manor", label: "Upstairs" },
      { roomId: "haunted_manor_lower_room", label: "Crypt" }
    ]);
    expect(left).toMatchObject({ ok: true });
    // No door in the lower room led back to this new door yet, so a return anchor is created there (and selected in Studio).
    expect(left.ok && left.createdAnchors).toEqual([{ roomId: "haunted_manor_lower_room", anchorId: expect.any(String) }]);
    expect(setDoorDestinations(view, sources, "haunted_manor", lobby.id, "new_right_door", [{ roomId: WORLD_DESTINATION, label: "" }])).toMatchObject({ ok: true });
    expect(setDoorDestinations(view, sources, "haunted_manor", "haunted_manor_hallway", "return_to_manor", [{ roomId: WORLD_DESTINATION, label: "Out" }]))
      .toMatchObject({ ok: false });
    const saved = interiorFromEditingView(interior, {}, view);
    const catalog = validateManorTemplateCatalog(manorTemplateCatalogInputFromInterior(saved));
    const room = catalog.templates.find((template) => template.id === "haunted_manor")!.rooms.find((candidate) => candidate.id === lobby.id)!;
    expect(manorAnchorDestinations(room.anchors.find((anchor) => anchor.id === "new_left_door")!).map((destination) => destination.label))
      .toEqual(["Upstairs", "Crypt"]);
    expect(room.worldExit).toMatchObject({ anchorId: "new_right_door", label: "Leave Manor" });
  });


  it("adds a typed destination to an existing door and the game view lists both", async () => {
    const { interior } = await readDungeonInteriorFiles(interiors);
    const view = interiorEditingView(interior);
    const samurai = view.dungeons.find((dungeon) => dungeon.id === "samurai_manor")!;
    const portalPrefab = view.prefabs.find((prefab) => !prefab.retired && prefab.type === "portal")!;
    // "From door: left_door" -> Private Room 1, typed label "Patio".
    connectDungeonRooms(samurai, { roomId: "samurai_manor_lobby", anchorId: "left_door" }, { roomId: "samurai_manor_room_1" },
      portalPrefab, true, { label: "Patio" });
    const saved = interiorFromEditingView(interior, {}, view);
    const catalog = validateManorTemplateCatalog(manorTemplateCatalogInputFromInterior(saved));
    const lobby = catalog.templates.find((template) => template.id === "samurai_manor")!.rooms
      .find((room) => room.id === "samurai_manor_lobby")!;
    const door = lobby.anchors.find((anchor) => anchor.id === "left_door")!;
    expect(manorAnchorDestinations(door).map((destination) => destination.label)).toEqual(["Upstairs", "Courtyard", "Patio"]);
  });
});
