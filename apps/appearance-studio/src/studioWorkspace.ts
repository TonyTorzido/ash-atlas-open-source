export type StudioWorkspace = "appearance" | "assets" | "interiors" | "progression-icons" | "flags";

const WORKSPACES: readonly string[] = ["appearance", "assets", "interiors", "progression-icons", "flags"];
/** Workspaces removed in favour of the unified Interiors workspace. */
const LEGACY_INTERIOR_WORKSPACES: readonly string[] = ["dungeons", "manors", "greenhouses"];

/** Restores a saved workspace id; retired interior workspaces open Interiors. */
export function restoreStudioWorkspace(saved: string | null | undefined): StudioWorkspace {
  if (saved && LEGACY_INTERIOR_WORKSPACES.includes(saved)) return "interiors";
  return saved && WORKSPACES.includes(saved) ? (saved as StudioWorkspace) : "appearance";
}
