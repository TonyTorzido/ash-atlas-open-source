import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  INTERIOR_DATA_RELATIVE_DIR,
  interiorCatalogValidationIssues,
  manorCatalogValidationIssues,
  manorTemplateCatalogInputFromInterior,
  type InteriorCatalog,
  type InteriorSpace
} from "@ash-atlas/shared";
import { describe, expect, it } from "vitest";

import { applyStageArtChange, applyTemplateChange, plantStageArtFrame, templateFromPrefab } from "./GreenhouseTemplateEditors.js";
import { readDungeonInteriorFiles } from "./dungeonInteriorStore.js";
import { editStageArt } from "./interiorModules.js";
import {
  bumpInteriorRevisions,
  changedInteriorSpaceIds,
  createInteriorSpace,
  editableDefinitions,
  interiorEditingView,
  interiorFromEditingView,
  interiorViewIssues,
  nextRevision,
  takenInteriorIds,
  type ViewPrefab
} from "./interiorStudioModel.js";

const committed = path.join(fileURLToPath(new URL("../../..", import.meta.url)), INTERIOR_DATA_RELATIVE_DIR);

async function committedInterior(): Promise<InteriorCatalog> {
  return structuredClone((await readDungeonInteriorFiles(committed)).interior);
}

describe("interior studio model", () => {
  it("round-trips every committed space through the editing view without changing it", async () => {
    const base = await committedInterior();
    const view = interiorEditingView(base);
    expect(view.dungeons.map((dungeon) => dungeon.id)).toEqual(base.spaces.map((space) => space.id));
    const back = interiorFromEditingView(base, {}, view);
    for (const space of base.spaces) {
      expect(back.spaces.find((candidate) => candidate.id === space.id), space.id).toEqual(space);
    }
    expect(back.library).toEqual(base.library);
    expect(changedInteriorSpaceIds(base, back)).toEqual([]);
    expect(interiorViewIssues(base, {}, view)).toEqual([]);
  });

  it("keeps floors, walls, click areas and modules of non-dungeon rooms when the editor changes them", async () => {
    const base = await committedInterior();
    const view = interiorEditingView(base);
    const manor = view.dungeons.find((dungeon) => dungeon.id === "manor_lobby")!;
    manor.rooms[0]!.name = "Grand Foyer";
    manor.rooms[0]!.anchors.push({ id: "test_point", retired: false, x: 400, y: 900 });
    const proposed = interiorFromEditingView(base, {}, view);
    const before = base.spaces.find((space) => space.id === "manor_lobby")!;
    const after = proposed.spaces.find((space) => space.id === "manor_lobby")!;
    expect(after.rooms[0]).toMatchObject({ name: "Grand Foyer", floors: before.rooms[0]!.floors, walls: before.rooms[0]!.walls, clickAreas: before.rooms[0]!.clickAreas });
    expect(after.rooms[0]!.anchors.find((anchor) => anchor.id === "test_point")).toMatchObject({ role: "point" });
    expect(after.modules).toEqual(before.modules);
    expect(changedInteriorSpaceIds(base, proposed)).toEqual(["manor_lobby"]);
  });

  it("bumps the revision of changed rooms and spaces only", async () => {
    const base = await committedInterior();
    const view = interiorEditingView(base);
    view.dungeons.find((dungeon) => dungeon.id === "manor_lobby")!.rooms[0]!.name = "Grand Foyer";
    view.dungeons.find((dungeon) => dungeon.id === "cistern_warrens")!.description = "A wetter sewer.";
    const bumped = bumpInteriorRevisions(base, interiorFromEditingView(base, {}, view));
    const manorBefore = base.spaces.find((space) => space.id === "manor_lobby")!;
    const manor = bumped.spaces.find((space) => space.id === "manor_lobby")!;
    expect(manor.revision).toBe(nextRevision(manorBefore.revision));
    expect(manor.publishedRevisionId).toBe(nextRevision(manorBefore.publishedRevisionId!));
    expect(manor.rooms[0]!.revision).toBe(nextRevision(manorBefore.rooms[0]!.revision));
    expect(manor.rooms[1]!.revision).toBe(manorBefore.rooms[1]!.revision);
    const sewerBefore = base.spaces.find((space) => space.id === "cistern_warrens")!;
    const sewer = bumped.spaces.find((space) => space.id === "cistern_warrens")!;
    expect(sewer.revision).toBe(nextRevision(sewerBefore.revision));
    expect(new Set(sewer.rooms.map((room) => room.revision))).toEqual(new Set([sewer.revision]));
    expect(bumped.spaces.find((space) => space.id === "salon")).toBe(base.spaces.find((space) => space.id === "salon"));
    expect(interiorCatalogValidationIssues(bumped)).toEqual([]);
  });

  it("creates a valid space for every non-dungeon kind, with an authored world exit", async () => {
    const base = await committedInterior();
    const view = interiorEditingView(base);
    for (const kind of ["manor", "greenhouse", "salon"] as const) {
      const space = createInteriorSpace(kind, `Test ${kind}`, base.library, takenInteriorIds(base, view));
      expect(space.kind).toBe(kind);
      expect(space.portals).toHaveLength(1);
      const proposed: InteriorCatalog = { library: base.library, spaces: [...base.spaces, space] };
      expect(interiorCatalogValidationIssues(proposed), kind).toEqual([]);
      if (kind === "manor") {
        expect(manorCatalogValidationIssues(manorTemplateCatalogInputFromInterior(proposed))).toEqual([]);
      }
      // The new space edits and merges back through the editing view.
      const seeds = { [space.id]: space };
      const editing = interiorEditingView(proposed);
      expect(interiorViewIssues(proposed, seeds, editing)).toEqual([]);
      const back = interiorFromEditingView(proposed, seeds, editing);
      expect(back.spaces.find((candidate) => candidate.id === space.id)).toEqual(space);
    }
  });

  it("projects non-dungeon spaces with placeholder dungeon modules the editor can read", async () => {
    const base = await committedInterior();
    const salon = editableDefinitions(base.library, base.spaces.filter((space): space is InteriorSpace => space.kind === "salon"))[0]!;
    expect(salon.encounters).toEqual([]);
    expect(salon.escape.portalId).toBe("salon_main_room-world_exit");
    expect(salon.rooms[0]!.anchors.some((anchor) => anchor.id === salon.rooms[0]!.spawnAnchorId)).toBe(true);
  });

  describe("Greenhouse module authoring", () => {
    it("round-trips untouched greenhouse templates and stage art byte-identically", async () => {
      const base = await committedInterior();
      const back = interiorFromEditingView(base, {}, interiorEditingView(base));
      expect(back.library).toEqual(base.library);
      expect(back.spaces.find((space) => space.kind === "greenhouse")).toEqual(base.spaces.find((space) => space.kind === "greenhouse"));
      expect(interiorViewIssues(base, {}, interiorEditingView(base))).toEqual([]);
    });

    it("edits a template prefab in the view and carries footprint, touch area and frame back into the library and a new greenhouse revision", async () => {
      const base = await committedInterior();
      const greenhouse = base.spaces.find((space) => space.kind === "greenhouse")!;
      const potId = greenhouse.modules!.planters!.potPrefabId;
      const view = interiorEditingView(base);
      const pot = view.prefabs.find((prefab) => prefab.id === potId) as ViewPrefab;
      expect(templateFromPrefab(pot).physicalFootprint.length).toBeGreaterThanOrEqual(3);
      applyTemplateChange(pot, "width", "140");
      applyTemplateChange(pot, "renderWidth", "222");
      applyTemplateChange(pot, "pivotX", "9");
      applyTemplateChange(pot, "touchShape", "rectangle");
      applyTemplateChange(pot, "touchHeight", "77");
      applyTemplateChange(pot, "height", "-3");
      const assembled = interiorFromEditingView(base, {}, view);
      const saved = assembled.library.prefabs.find((prefab) => prefab.id === potId)!;
      expect(saved).toMatchObject({ defaultWidth: 222, pivotX: 1, touchArea: { kind: "polygon" } });
      expect(Math.max(...saved.footprint!.map((point) => point.x)) - Math.min(...saved.footprint!.map((point) => point.x))).toBe(140);
      expect(saved.touchArea!.kind === "polygon" ? Math.max(...saved.touchArea!.points.map((point) => point.y)) * 2 : 0).toBe(77);
      // The template is part of the greenhouse the runtime reads, so the space gets a new revision.
      expect(changedInteriorSpaceIds(base, assembled)).toEqual([greenhouse.id]);
      const bumped = bumpInteriorRevisions(base, assembled);
      expect(bumped.spaces.find((space) => space.id === greenhouse.id)!.revision).toBe(nextRevision(greenhouse.revision));
      expect(bumped.spaces.filter((space) => space.id !== greenhouse.id)).toEqual(base.spaces.filter((space) => space.id !== greenhouse.id));
      expect(interiorViewIssues(base, {}, view)).toEqual([]);
    });

    it("keeps stage art edits in the sidecar, clamps them and merges them into modules.planters", async () => {
      const base = await committedInterior();
      const greenhouse = base.spaces.find((space) => space.kind === "greenhouse")!;
      const view = interiorEditingView(base);
      editStageArt(view, { base, seeds: {} }, greenhouse.id, (art) => {
        applyStageArtChange(art, "wheat", 2, "pivotY", "4");
        applyStageArtChange(art, "wheat", 2, "scale", "0");
        applyStageArtChange(art, "wheat", 2, "offsetX", "-6.5");
        applyStageArtChange(art, "wheat", 2, "offsetY", "not a number");
      });
      const assembled = interiorFromEditingView(base, {}, view);
      const before = greenhouse.modules!.planters!.stageArt.find((art) => art.cropId === "wheat" && art.stage === 2)!;
      const after = assembled.spaces.find((space) => space.id === greenhouse.id)!.modules!.planters!.stageArt.find((art) => art.cropId === "wheat" && art.stage === 2)!;
      expect(after).toEqual({ ...before, pivotY: 1, scale: 0.01, offsetX: -6.5 });
      expect(assembled.spaces.find((space) => space.id === greenhouse.id)!.modules!.planters!.stageArt.filter((art) => !(art.cropId === "wheat" && art.stage === 2)))
        .toEqual(greenhouse.modules!.planters!.stageArt.filter((art) => !(art.cropId === "wheat" && art.stage === 2)));
      // An edit that changes nothing leaves no sidecar entry behind.
      const untouched = interiorEditingView(base);
      editStageArt(untouched, { base, seeds: {} }, greenhouse.id, (art) => applyStageArtChange(art, "wheat", 2, "scale", String(before.scale)));
      expect((untouched as { interiorModules?: unknown }).interiorModules).toBeUndefined();
    });

    it("places a plant stage on the Farm Plot render frame around the plot anchor and offset", () => {
      expect(plantStageArtFrame({ renderWidth: 200, renderHeight: 100 }, { pivotX: 0.5, pivotY: 1, offsetX: 10, offsetY: -20, scale: 0.5 }, 100, 60))
        .toEqual({ x: 60, y: -10, width: 100, height: 50 });
    });
  });
});
