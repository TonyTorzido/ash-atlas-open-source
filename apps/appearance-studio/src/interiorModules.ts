import type { InteriorModules, InteriorSpace } from "@ash-atlas/shared";

import type { AuthoringSources, AuthoringView } from "./interiorAuthoring.js";

/**
 * Kind-module authoring for the InteriorStudio. Like the room geometry, module
 * content does not exist in the dungeon-shaped editing view, so it rides along
 * in a sidecar on the view (`interiorModules`, keyed by space id). A space
 * without an entry is exactly what is stored, so untouched spaces never look
 * edited. Every operation mutates a draft view. Browser-safe.
 */

export type PlanterStageArt = NonNullable<InteriorModules["planters"]>["stageArt"][number];
export type InteriorDecoration = NonNullable<InteriorModules["decoration"]>["definitions"][number];

export type ModuleEdits = {
  /** Greenhouse `modules.planters.stageArt`. */
  stageArt?: PlanterStageArt[];
  /** Manor `modules.decoration.definitions` (retired definitions included). */
  decorations?: InteriorDecoration[];
  /** Manor `modules.manor`: the overworld building art of this Manor type. */
  manorExterior?: ManorExterior;
};

export type ManorExterior = NonNullable<InteriorModules["manor"]>;

export type ModuleView = { interiorModules?: Record<string, ModuleEdits> };

function storedSpace(sources: AuthoringSources, spaceId: string): InteriorSpace | undefined {
  return sources.base?.spaces.find((space) => space.id === spaceId) ?? sources.seeds[spaceId];
}

/** True when the space carries the Manor decoration module (the Decoration Test is offered for it). */
export function hasDecorationModule(sources: AuthoringSources, spaceId: string): boolean {
  return storedSpace(sources, spaceId)?.modules?.decoration !== undefined;
}

/** True when the space carries the Greenhouse planters module. */
export function hasPlantersModule(sources: AuthoringSources, spaceId: string): boolean {
  return storedSpace(sources, spaceId)?.modules?.planters !== undefined;
}

/** The library prefab ids of the greenhouse's Farm Plot (stored module) and water tank templates. */
export function plantersPotPrefabId(sources: AuthoringSources, spaceId: string): string | null {
  return storedSpace(sources, spaceId)?.modules?.planters?.potPrefabId ?? null;
}

export function effectiveStageArt(view: AuthoringView, sources: AuthoringSources, spaceId: string): PlanterStageArt[] {
  return structuredClone(view.interiorModules?.[spaceId]?.stageArt ?? storedSpace(sources, spaceId)?.modules?.planters?.stageArt ?? []);
}

export function effectiveDecorations(view: AuthoringView, sources: AuthoringSources, spaceId: string): InteriorDecoration[] {
  return structuredClone(view.interiorModules?.[spaceId]?.decorations ?? storedSpace(sources, spaceId)?.modules?.decoration?.definitions ?? []);
}

/** Decoration ids stored on disk for the space: these can be retired, never removed. */
export function storedDecorationIds(sources: AuthoringSources, spaceId: string): ReadonlySet<string> {
  return new Set((sources.base?.spaces.find((space) => space.id === spaceId)?.modules?.decoration?.definitions ?? []).map((value) => value.id));
}

const same = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);

function setModuleEdit<K extends keyof ModuleEdits>(view: AuthoringView, spaceId: string, key: K, value: ModuleEdits[K]): void {
  view.interiorModules = { ...(view.interiorModules ?? {}), [spaceId]: { ...(view.interiorModules?.[spaceId] ?? {}), [key]: value } };
}

/** Edits a greenhouse's stage art list (materializing its sidecar entry on the first real change). */
export function editStageArt(view: AuthoringView, sources: AuthoringSources, spaceId: string, edit: (art: PlanterStageArt[]) => void): void {
  const before = effectiveStageArt(view, sources, spaceId);
  const draft = structuredClone(before);
  edit(draft);
  if (!same(draft, before)) setModuleEdit(view, spaceId, "stageArt", draft);
}

/** The Manor type overworld building (stored, or the unsaved edit); null when none is set. */
export function effectiveManorExterior(view: AuthoringView, sources: AuthoringSources, spaceId: string): ManorExterior | null {
  const edited = view.interiorModules?.[spaceId]?.manorExterior;
  return structuredClone(edited ?? storedSpace(sources, spaceId)?.modules?.manor ?? null);
}

/** Sets a Manor type overworld building PNG and size (materializing its sidecar entry on a real change). */
export function setManorExterior(view: AuthoringView, sources: AuthoringSources, spaceId: string, exterior: ManorExterior): void {
  if (!same(exterior, effectiveManorExterior(view, sources, spaceId))) setModuleEdit(view, spaceId, "manorExterior", structuredClone(exterior));
}

/** Edits a Manor's decoration definitions (materializing its sidecar entry on the first real change). */
export function editDecorations(view: AuthoringView, sources: AuthoringSources, spaceId: string, edit: (definitions: InteriorDecoration[]) => void): void {
  const before = effectiveDecorations(view, sources, spaceId);
  const draft = structuredClone(before);
  edit(draft);
  if (!same(draft, before)) setModuleEdit(view, spaceId, "decorations", draft);
}

/** The stored space with the sidecar's module edits merged in; the space itself when nothing was edited. */
export function applyModuleEdits(space: InteriorSpace, edits: ModuleEdits | undefined): InteriorSpace {
  if (!edits) return space;
  const modules: NonNullable<InteriorSpace["modules"]> = { ...(space.modules ?? {}) };
  if (edits.decorations && modules.decoration) modules.decoration = { ...modules.decoration, definitions: edits.decorations };
  if (edits.stageArt && modules.planters) modules.planters = { ...modules.planters, stageArt: edits.stageArt };
  if (edits.manorExterior && space.kind === "manor") modules.manor = edits.manorExterior;
  return { ...space, modules };
}

/** Asset keys the modules of `space` reference (staged PNGs must be among these to be published). */
export function moduleAssetKeys(space: InteriorSpace): string[] {
  return [
    ...(space.modules?.decoration?.definitions ?? []).filter((value) => !value.retired).map((value) => value.assetKey),
    ...(space.modules?.planters?.stageArt ?? []).map((value) => value.assetKey),
    ...(space.modules?.manor ? [space.modules.manor.exteriorAssetKey] : [])
  ];
}
