import { z } from "zod";
import catalogJson from "./data/territory-structure-catalog.json" with { type: "json" };

export const TERRITORY_STRUCTURE_CATALOG_RELATIVE_PATH =
  "packages/shared/src/data/territory-structure-catalog.json";
export const TERRITORY_STRUCTURE_TYPES = ["soft_flag", "bastion_flag", "tower", "atlas_shrine"] as const;
export type TerritoryStructureType = typeof TERRITORY_STRUCTURE_TYPES[number];
/** Existing flag renderer's local pixel space. World zoom is applied once outside the root. */
export const TERRITORY_STRUCTURE_REFERENCE_HEIGHT = 25;
export const TERRITORY_PIECE_ROLES = ["hardware", "cloth", "shrine", "decoration"] as const;
export const TERRITORY_PIECE_ROLE_LABELS = {
  hardware: "Hardware / pole / base", cloth: "Tintable cloth", shrine: "Shrine body", decoration: "Decoration"
} as const;
export const TERRITORY_REQUIRED_PIECE_ROLES = {
  soft_flag: ["hardware", "cloth"], bastion_flag: ["hardware", "cloth"],
  tower: ["hardware", "cloth"], atlas_shrine: ["shrine"]
} as const;
export const TERRITORY_PNG_ASSET_PATTERN = /^apps\/client\/src\/assets\/(?:flags\/[a-zA-Z0-9_/-]+|structures\/atlas-shrine)\.png$/;
export const TERRITORY_PACK_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

const finite = z.number().finite().min(-2048).max(2048);
const dimension = z.number().finite().positive().max(2048);
const structureType = z.enum(TERRITORY_STRUCTURE_TYPES);
const scale = z.number().finite().min(0.1).max(4);
const attachment = z.object({ x: finite, y: finite, zIndex: finite, scale: scale.default(1) }).strict();
export const territoryPieceSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
  name: z.string().trim().min(1).max(80),
  role: z.enum(TERRITORY_PIECE_ROLES),
  asset: z.string().regex(TERRITORY_PNG_ASSET_PATTERN),
  visible: z.boolean().default(true),
  scale: scale.default(1),
  width: dimension, height: dimension,
  anchorX: z.number().finite().min(0).max(1),
  anchorY: z.number().finite().min(0).max(1),
  offsetX: finite, offsetY: finite, zIndex: finite,
  tint: z.enum(["none", "control", "fixed"]),
  tintColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).default("#ffffff")
}).strict();
export const territoryVisualSchema = z.object({
  id: z.string().min(1),
  structureType,
  root: z.object({
    scale,
    offsetX: finite,
    offsetY: finite
  }).strict(),
  pieces: z.array(territoryPieceSchema).min(1).max(32),
  attachments: z.object({ burning: attachment, emblem: attachment }).strict(),
  // Stock pieces are static. Runtime state overlays are composed beneath the same root.
  animation: z.literal("none")
}).strict();

const structureSchema = z.object({
  displayName: z.string().min(1),
  // Type-owned ground contact cannot be moved by a cosmetic pack.
  anchor: z.object({ x: z.literal(0), y: z.literal(0) }).strict(),
  interaction: z.object({
    width: dimension, height: dimension, offsetX: finite, offsetY: finite
  }).strict()
}).strict();

export const territoryStructureCatalogSchema = z.object({
  schemaVersion: z.literal(2),
  revision: z.number().int().nonnegative(),
  defaultPackId: z.string().regex(TERRITORY_PACK_ID_PATTERN),
  structures: z.record(structureType, structureSchema),
  packs: z.record(z.string().regex(TERRITORY_PACK_ID_PATTERN), z.object({
    displayName: z.string().trim().min(1).max(80),
    structures: z.record(structureType, territoryVisualSchema)
  }).strict())
}).strict().superRefine((catalog, ctx) => {
  if (!catalog.packs.stock) ctx.addIssue({ code: "custom", path: ["packs", "stock"], message: "Stock Flag Pack is required" });
  if (!Object.hasOwn(catalog.packs, catalog.defaultPackId)) ctx.addIssue({ code: "custom", path: ["defaultPackId"], message: "Active game pack must exist" });
  for (const packId of Object.keys(catalog.packs)) {
    if (["__proto__", "constructor", "prototype"].includes(packId)) ctx.addIssue({ code: "custom", path: ["packs", packId], message: "Reserved pack ID" });
  }
  for (const type of TERRITORY_STRUCTURE_TYPES) {
    if (!catalog.structures[type]) ctx.addIssue({ code: "custom", path: ["structures", type], message: "Structure and interaction bounds are required" });
    for (const [packId, pack] of Object.entries(catalog.packs)) {
      const visual = pack.structures[type];
      const path = ["packs", packId, "structures", type];
      if (!visual) {
        ctx.addIssue({ code: "custom", path, message: "Pack is missing a required structure" });
        continue;
      }
      if (visual.structureType !== type) ctx.addIssue({ code: "custom", path, message: "Visual must match its gameplay structure type" });
      if (visual.id !== `${packId}.${type}`) ctx.addIssue({ code: "custom", path: [...path, "id"], message: "Visual ID must be packId.structureType" });
      if (new Set(visual.pieces.map((piece) => piece.id)).size !== visual.pieces.length) {
        ctx.addIssue({ code: "custom", path: [...path, "pieces"], message: "Piece IDs must be unique" });
      }
      for (const piece of visual.pieces) {
        if (piece.asset.includes("..")) ctx.addIssue({ code: "custom", path: [...path, "pieces"], message: "Piece must reference a production PNG" });
        if (["burning", "emblem"].includes(piece.id)) ctx.addIssue({ code: "custom", path: [...path, "pieces"], message: "Burning and emblem IDs are reserved for state overlays" });
      }
      for (const role of TERRITORY_REQUIRED_PIECE_ROLES[type]) {
        if (!visual.pieces.some((piece) => piece.role === role && piece.visible)) {
          ctx.addIssue({ code: "custom", path: [...path, "pieces"], message: `A visible ${role} component is required` });
        }
      }
    }
  }
});

export type TerritoryStructureVisual = z.infer<typeof territoryVisualSchema>;
export type TerritoryStructurePiece = z.infer<typeof territoryPieceSchema>;
export type TerritoryStructureDefinition = z.infer<typeof structureSchema>;
export type TerritoryStructureCatalog = z.infer<typeof territoryStructureCatalogSchema>;
export function parseTerritoryStructureCatalog(value: unknown): TerritoryStructureCatalog {
  return territoryStructureCatalogSchema.parse(upgradeTerritoryCatalog(value));
}
export const TERRITORY_STRUCTURE_CATALOG = parseTerritoryStructureCatalog(catalogJson);

export function territoryStructureValidationIssues(value: unknown, availableAssets?: ReadonlySet<string>): string[] {
  const result = territoryStructureCatalogSchema.safeParse(upgradeTerritoryCatalog(value));
  if (!result.success) return result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
  const issues: string[] = [];
  if (availableAssets) {
    for (const [packId, pack] of Object.entries(result.data.packs)) {
      for (const type of TERRITORY_STRUCTURE_TYPES) {
        for (const piece of pack.structures[type]!.pieces) {
          if (!availableAssets.has(piece.asset)) issues.push(`${packId} / ${type} / ${piece.id}: missing PNG ${piece.asset}`);
        }
      }
    }
  }
  return issues;
}

export function territoryStructureTypeForFlag(upgradeTier?: string): TerritoryStructureType {
  return upgradeTier === "atlas_shrine" ? "atlas_shrine" : upgradeTier === "tower" ? "tower" :
    upgradeTier === "stone" ? "bastion_flag" : "soft_flag";
}

export function territoryStructureVisual(type: TerritoryStructureType, packId?: string,
  catalog = TERRITORY_STRUCTURE_CATALOG): TerritoryStructureVisual {
  return (catalog.packs[packId ?? catalog.defaultPackId] ?? catalog.packs.stock)!.structures[type]!;
}

/** Visual offsets never modify this type-owned interaction rectangle or the world coordinate. */
export function territoryStructureInteractionBounds(type: TerritoryStructureType,
  catalog = TERRITORY_STRUCTURE_CATALOG, x = 0, y = 0, scaleX = 1, scaleY = scaleX) {
  const hit = catalog.structures[type]!.interaction;
  return {
    shape: "rectangle" as const,
    left: x + (hit.offsetX - hit.width / 2) * scaleX,
    right: x + (hit.offsetX + hit.width / 2) * scaleX,
    top: y + (hit.offsetY - hit.height / 2) * scaleY,
    bottom: y + (hit.offsetY + hit.height / 2) * scaleY
  };
}

export function territoryStructurePieceBounds(visual: TerritoryStructureVisual) {
  return visual.pieces.map((piece) => ({
    id: piece.id,
    visible: piece.visible,
    left: visual.root.offsetX + (piece.offsetX - piece.width * piece.scale * piece.anchorX) * visual.root.scale,
    top: visual.root.offsetY + (piece.offsetY - piece.height * piece.scale * piece.anchorY) * visual.root.scale,
    width: piece.width * piece.scale * visual.root.scale,
    height: piece.height * piece.scale * visual.root.scale
  }));
}

/** One template path for Studio and tooling. Cloning never changes shared gameplay geometry. */
export function cloneTerritoryFlagPack(catalog: TerritoryStructureCatalog, id: string, displayName: string, clothColor?: string) {
  if (!TERRITORY_PACK_ID_PATTERN.test(id) || ["constructor", "prototype", "__proto__"].includes(id)) throw new Error("Use a lowercase pack ID with letters, numbers, hyphens or underscores (1–64 characters).");
  if (Object.hasOwn(catalog.packs, id)) throw new Error(`Flag pack ${id} already exists.`);
  const pack = structuredClone(catalog.packs.stock!);
  pack.displayName = displayName.trim();
  for (const type of TERRITORY_STRUCTURE_TYPES) {
    const visual = pack.structures[type]!;
    visual.id = `${id}.${type}`;
    if (clothColor) for (const piece of visual.pieces) if (piece.role === "cloth") {
      piece.tint = "fixed"; piece.tintColor = clothColor;
    }
  }
  // Validate the complete candidate, including required roles and reserved identities.
  parseTerritoryStructureCatalog({ ...catalog, packs: { ...catalog.packs, [id]: pack } });
  return pack;
}

/** Read old feature catalogs without forcing users to discard their saved registration edits. */
function upgradeTerritoryCatalog(value: unknown): unknown {
  if (!value || typeof value !== "object" || (value as { schemaVersion?: unknown }).schemaVersion !== 1) return value;
  const legacy = structuredClone(value) as Record<string, unknown>;
  legacy.schemaVersion = 2;
  legacy.defaultPackId = "stock";
  if (legacy.packs && typeof legacy.packs === "object") for (const pack of Object.values(legacy.packs)) {
    if (!pack?.structures || typeof pack.structures !== "object") continue;
    for (const visual of Object.values(pack.structures) as Array<{ pieces?: Array<Record<string, unknown>> }>) {
      if (!Array.isArray(visual?.pieces)) continue;
      for (const piece of visual.pieces) {
        const role = TERRITORY_PIECE_ROLES.includes(piece.id as typeof TERRITORY_PIECE_ROLES[number]) ? piece.id : "decoration";
        piece.role ??= role;
        piece.name ??= TERRITORY_PIECE_ROLE_LABELS[role as keyof typeof TERRITORY_PIECE_ROLE_LABELS];
      }
    }
  }
  return legacy;
}
