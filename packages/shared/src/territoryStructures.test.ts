import { describe, expect, it } from "vitest";
import { TERRITORY_STRUCTURE_CATALOG, TERRITORY_STRUCTURE_TYPES, cloneTerritoryFlagPack, parseTerritoryStructureCatalog, territoryStructureValidationIssues, territoryStructureVisual } from "./territoryStructures.js";

describe("territory catalog validation", () => {
  it("accepts the migrated Stock pack", () => {
    expect(parseTerritoryStructureCatalog(TERRITORY_STRUCTURE_CATALOG)).toEqual(TERRITORY_STRUCTURE_CATALOG);
  });
  it.each(["root", "pieces", "anchor", "interaction", "width", "scale", "structure"] as const)("rejects missing or invalid %s", (field) => {
    const draft = structuredClone(TERRITORY_STRUCTURE_CATALOG);
    const visual = draft.packs.stock!.structures.soft_flag!;
    if (field === "root") delete (visual as Partial<typeof visual>).root;
    if (field === "pieces") visual.pieces = [];
    if (field === "anchor") delete (draft.structures.soft_flag as Record<string, unknown>).anchor;
    if (field === "interaction") delete (draft.structures.soft_flag as Record<string, unknown>).interaction;
    if (field === "width") draft.structures.soft_flag!.interaction.width = 0;
    if (field === "scale") visual.root.scale = -1;
    if (field === "structure") delete draft.packs.stock!.structures.tower;
    expect(territoryStructureValidationIssues(draft).length).toBeGreaterThan(0);
  });
  it("identifies missing child PNGs without needing pixel-perfect geometry", () => {
    const issues = territoryStructureValidationIssues(TERRITORY_STRUCTURE_CATALOG, new Set());
    expect(issues).toHaveLength(7);
    expect(issues[0]).toContain("missing PNG");
  });

  it("clones every Stock type independently, recolors only cloth, and keeps gameplay data untouched", () => {
    const catalog = structuredClone(TERRITORY_STRUCTURE_CATALOG);
    const geometry = structuredClone(catalog.structures);
    const stock = structuredClone(catalog.packs.stock);
    catalog.packs.violet = cloneTerritoryFlagPack(catalog, "violet", "Violet Banner", "#9933cc");
    for (const type of TERRITORY_STRUCTURE_TYPES) {
      const visual = catalog.packs.violet.structures[type]!;
      expect(visual.id).toBe(`violet.${type}`);
      for (const piece of visual.pieces) {
        expect(piece.tint).toBe(piece.role === "cloth" ? "fixed" : "none");
        if (piece.role === "cloth") expect(piece.tintColor).toBe("#9933cc");
      }
    }
    catalog.packs.violet.structures.soft_flag!.pieces[0]!.offsetX = 20;
    expect(catalog.packs.stock).toEqual(stock);
    expect(catalog.structures).toEqual(geometry);
    expect(catalog.defaultPackId).toBe("stock");
    catalog.defaultPackId = "violet";
    expect(territoryStructureVisual("soft_flag", undefined, catalog).id).toBe("violet.soft_flag");
    expect(territoryStructureVisual("soft_flag", "stock", catalog).id).toBe("stock.soft_flag");
    expect(parseTerritoryStructureCatalog(JSON.parse(JSON.stringify(catalog)))).toEqual(catalog);
    expect(() => cloneTerritoryFlagPack(catalog, "violet", "Again")).toThrow("already exists");
    expect(() => cloneTerritoryFlagPack(catalog, "constructor", "Bad")).toThrow();
    expect(() => cloneTerritoryFlagPack(catalog, "bad", "Bad", "red")).toThrow();
  });

  it.each(["role", "hidden", "tint", "default", "duplicate", "identity", "overlay"] as const)("rejects invalid component/pack %s", (caseName) => {
    const draft = structuredClone(TERRITORY_STRUCTURE_CATALOG);
    const visual = draft.packs.stock!.structures.soft_flag!;
    if (caseName === "role") visual.pieces[0]!.role = "decoration";
    if (caseName === "hidden") visual.pieces[1]!.visible = false;
    if (caseName === "tint") visual.pieces[1]!.tintColor = "not-a-color";
    if (caseName === "default") draft.defaultPackId = "missing";
    if (caseName === "duplicate") visual.pieces.push(structuredClone(visual.pieces[0]!));
    if (caseName === "identity") visual.id = "other.soft_flag";
    if (caseName === "overlay") visual.pieces[0]!.id = "burning";
    expect(territoryStructureValidationIssues(draft).length).toBeGreaterThan(0);
  });

  it("upgrades v1 saved transforms and interaction bounds without losing registration", () => {
    const legacy = JSON.parse(JSON.stringify(TERRITORY_STRUCTURE_CATALOG));
    legacy.schemaVersion = 1; delete legacy.defaultPackId;
    for (const visual of Object.values(legacy.packs.stock.structures) as Array<{ pieces: Record<string, unknown>[] }>) {
      for (const piece of visual.pieces) {
        for (const key of ["name", "role", "scale", "visible", "tintColor"]) delete piece[key];
      }
    }
    legacy.packs.stock.structures.soft_flag.root.offsetX = 3;
    const upgraded = parseTerritoryStructureCatalog(legacy);
    expect(upgraded.schemaVersion).toBe(2);
    expect(upgraded.defaultPackId).toBe("stock");
    expect(upgraded.packs.stock!.structures.soft_flag!.root.offsetX).toBe(3);
    expect(upgraded.packs.stock!.structures.soft_flag!.pieces[1]).toMatchObject({ role: "cloth", scale: 1, visible: true });
    expect(upgraded.structures).toEqual(TERRITORY_STRUCTURE_CATALOG.structures);
  });
});
