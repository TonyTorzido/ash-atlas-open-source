import {
  DEFAULT_PLAYER_APPEARANCE_CATALOG,
  playerMainAnchor,
  type PlayerAttachmentAnchorId,
  type PlayerTemplateTransform,
  type AppearanceDefinition,
  type AppearanceDefinitionId,
  type PlayerCombatPoseId,
  type PlayerAppearanceCatalog,
  type PlayerSkinToneId
} from "@ash-atlas/shared";
import { pushPast, resolveGroup, type ActiveGroup, type EditGroup } from "./historyCore.js";

export type StudioHistory = {
  past: PlayerAppearanceCatalog[];
  present: PlayerAppearanceCatalog;
  future: PlayerAppearanceCatalog[];
  saved: PlayerAppearanceCatalog;
  selectedId: AppearanceDefinitionId | null;
  revision: number;
  /** The open coalescing group, if the previous action was a grouped edit. */
  group: ActiveGroup | null;
};

export type StudioAction =
  | {
      type: "load";
      catalog: PlayerAppearanceCatalog;
      selectedId?: AppearanceDefinitionId | null;
    }
  | {
      type: "restoreDraft";
      catalog: PlayerAppearanceCatalog;
      saved: PlayerAppearanceCatalog;
      selectedId: AppearanceDefinitionId | null;
    }
  | { type: "select"; appearanceId: AppearanceDefinitionId | null }
  | {
      type: "edit";
      catalog: PlayerAppearanceCatalog;
      selectedId?: AppearanceDefinitionId | null;
      /** Merge into the previous undo step when it has the same group (see historyCore.ts). */
      group?: EditGroup;
      at?: number;
    }
  | { type: "endGroup" }
  | { type: "cancelGroup"; key: string }
  | { type: "undo" }
  | { type: "redo" }
  | {
      type: "markSaved";
      catalog: PlayerAppearanceCatalog;
      submittedRevision: number;
    }
  | { type: "revert" };

export function createStudioHistory(
  catalog: PlayerAppearanceCatalog
): StudioHistory {
  const clone = structuredClone(catalog);
  return {
    past: [],
    present: clone,
    future: [],
    saved: structuredClone(clone),
    selectedId: clone.appearances[0]?.appearanceId ?? null,
    revision: 0,
    group: null
  };
}

export function studioReducer(
  state: StudioHistory,
  action: StudioAction
): StudioHistory {
  switch (action.type) {
    case "load":
      return {
        ...createStudioHistory(action.catalog),
        selectedId: "selectedId" in action
          ? action.selectedId ?? null
          : action.catalog.appearances[0]?.appearanceId ?? null
      };
    case "restoreDraft":
      return {
        past: [],
        present: structuredClone(action.catalog),
        future: [],
        saved: structuredClone(action.saved),
        selectedId: action.selectedId,
        revision: 1,
        group: null
      };
    case "select":
      return { ...state, selectedId: action.appearanceId, group: null };
    case "edit": {
      const selectedId = "selectedId" in action ? action.selectedId ?? null : state.selectedId;
      // A no-op edit is not an undo step and does not disturb an open group.
      if (JSON.stringify(action.catalog) === JSON.stringify(state.present)) {
        return selectedId === state.selectedId ? state : { ...state, selectedId };
      }
      const { coalesce, active } = resolveGroup(state.group, action.group, action.at ?? Date.now());
      return {
        ...state,
        past: coalesce ? state.past : pushPast(state.past, structuredClone(state.present)),
        present: structuredClone(action.catalog),
        future: coalesce ? state.future : [],
        selectedId,
        revision: state.revision + 1,
        group: active
      };
    }
    case "endGroup":
      return state.group ? { ...state, group: null } : state;
    case "cancelGroup": {
      // Pointercancel / Escape mid-drag: restore the pre-gesture state without leaving a step.
      if (!state.group || state.group.key !== action.key) return state;
      const previous = state.past.at(-1);
      if (!previous) return { ...state, group: null };
      return {
        ...state,
        past: state.past.slice(0, -1),
        present: structuredClone(previous),
        revision: state.revision + 1,
        group: null
      };
    }
    case "undo": {
      const previous = state.past.at(-1);
      if (!previous) return state;
      return {
        ...state,
        past: state.past.slice(0, -1),
        present: structuredClone(previous),
        future: [structuredClone(state.present), ...state.future],
        revision: state.revision + 1,
        group: null
      };
    }
    case "redo": {
      const next = state.future[0];
      if (!next) return state;
      return {
        ...state,
        past: [...state.past, structuredClone(state.present)],
        present: structuredClone(next),
        future: state.future.slice(1),
        revision: state.revision + 1,
        group: null
      };
    }
    case "markSaved":
      if (state.revision === action.submittedRevision) {
        return {
          ...state,
          present: structuredClone(action.catalog),
          saved: structuredClone(action.catalog),
          revision: state.revision + 1,
          group: null
        };
      }
      return {
        ...state,
        present: {
          ...structuredClone(state.present),
          catalogRevision: action.catalog.catalogRevision
        },
        saved: structuredClone(action.catalog),
        revision: state.revision + 1,
        group: null
      };
    case "revert":
      return {
        ...state,
        past: pushPast(state.past, structuredClone(state.present)),
        present: structuredClone(state.saved),
        future: [],
        revision: state.revision + 1,
        group: null
      };
  }
}

export function studioIsDirty(state: StudioHistory): boolean {
  return JSON.stringify(state.present) !== JSON.stringify(state.saved);
}

export function replaceAppearance(
  catalog: PlayerAppearanceCatalog,
  appearance: AppearanceDefinition
): PlayerAppearanceCatalog {
  return {
    ...catalog,
    appearances: catalog.appearances.map((candidate) =>
      candidate.appearanceId === appearance.appearanceId
        ? appearance
        : candidate
    )
  };
}

export function duplicateAppearance(
  catalog: PlayerAppearanceCatalog,
  appearanceId: AppearanceDefinitionId
): { catalog: PlayerAppearanceCatalog; appearance: AppearanceDefinition } {
  const source = catalog.appearances.find(
    (appearance) => appearance.appearanceId === appearanceId
  );
  if (!source) throw new Error("Select an appearance to duplicate");
  const base = `${source.appearanceId}_copy`;
  let nextId = base;
  let suffix = 2;
  while (catalog.appearances.some((appearance) => appearance.appearanceId === nextId)) {
    nextId = `${base}_${suffix++}`;
  }
  const appearance: AppearanceDefinition = {
    ...structuredClone(source),
    appearanceId: nextId,
    displayName: `${source.displayName} Copy`,
    inheritAppearanceId: source.appearanceId,
    placements: {}
  };
  delete appearance.retired;
  return {
    catalog: {
      ...catalog,
      appearances: [...catalog.appearances, appearance]
    },
    appearance
  };
}

export function resetAppearancePose(
  catalog: PlayerAppearanceCatalog,
  appearanceId: AppearanceDefinitionId,
  poseId: PlayerCombatPoseId
): PlayerAppearanceCatalog {
  const appearance = catalog.appearances.find(
    (candidate) => candidate.appearanceId === appearanceId
  );
  if (!appearance) throw new Error("Select an appearance to reset");
  const placements = { ...appearance.placements };
  delete placements[poseId];
  return replaceAppearance(catalog, {
    ...appearance,
    ...(Object.keys(placements).length > 0 ? { placements } : { placements: {} })
  });
}

export function withImportedPlayerTemplateAsset(
  catalog: PlayerAppearanceCatalog,
  poseId: PlayerCombatPoseId,
  assetKey: string
): PlayerAppearanceCatalog {
  return {
    ...catalog,
    bodyVariants: catalog.bodyVariants.map((body) =>
      body.bodyVariantId === "default"
        ? {
            ...body,
            bodyAssetKeys: {
              ...body.bodyAssetKeys,
              [poseId]: assetKey
            }
          }
        : body
    )
  };
}

export function withImportedPlayerSkinToneAsset(
  catalog: PlayerAppearanceCatalog,
  skinToneId: PlayerSkinToneId,
  assetKey: string
): PlayerAppearanceCatalog {
  return {
    ...catalog,
    bodyVariants: catalog.bodyVariants.map((body) =>
      body.bodyVariantId === "default"
        ? {
            ...body,
            skinToneAssetKeys: {
              ...body.skinToneAssetKeys,
              [skinToneId]: assetKey
            }
          }
        : body
    )
  };
}

export function withImportedPlayerHeadAsset(
  catalog: PlayerAppearanceCatalog,
  poseId: PlayerCombatPoseId,
  assetKey: string
): PlayerAppearanceCatalog {
  return {
    ...catalog,
    bodyVariants: catalog.bodyVariants.map((body) =>
      body.bodyVariantId === "default"
        ? { ...body, headAssetKeys: { ...body.headAssetKeys, [poseId]: assetKey } }
        : body
    )
  };
}

export function withImportedPlayerHeadSkinToneAsset(
  catalog: PlayerAppearanceCatalog,
  skinToneId: PlayerSkinToneId,
  assetKey: string
): PlayerAppearanceCatalog {
  return {
    ...catalog,
    bodyVariants: catalog.bodyVariants.map((body) =>
      body.bodyVariantId === "default"
        ? {
            ...body,
            headSkinToneAssetKeys: { ...body.headSkinToneAssetKeys, [skinToneId]: assetKey }
          }
        : body
    )
  };
}

export function withPlayerTemplateTransform(
  catalog: PlayerAppearanceCatalog,
  poseId: PlayerCombatPoseId,
  transform: PlayerTemplateTransform
): PlayerAppearanceCatalog {
  return {
    ...catalog,
    bodyVariants: catalog.bodyVariants.map((body) =>
      body.bodyVariantId === "default"
        ? {
            ...body,
            bodyTransforms: {
              ...body.bodyTransforms,
              [poseId]: transform
            }
          }
        : body
    )
  };
}

export function withPlayerOverallScale(
  catalog: PlayerAppearanceCatalog,
  overallScale: number
): PlayerAppearanceCatalog {
  return {
    ...catalog,
    bodyVariants: catalog.bodyVariants.map((body) =>
      body.bodyVariantId === "default"
        ? { ...body, overallScale }
        : body
    )
  };
}

export function withPlayerMainAnchor(
  catalog: PlayerAppearanceCatalog,
  x: number,
  y: number
): PlayerAppearanceCatalog {
  return {
    ...catalog,
    bodyVariants: catalog.bodyVariants.map((body) =>
      body.bodyVariantId === "default"
        ? { ...body, mainAnchor: { x, y } }
        : body
    )
  };
}

export function resetPlayerMainAnchor(
  catalog: PlayerAppearanceCatalog
): PlayerAppearanceCatalog {
  const main = playerMainAnchor(DEFAULT_PLAYER_APPEARANCE_CATALOG, "default");
  return withPlayerMainAnchor(catalog, main.x, main.y);
}

export function withPlayerAnchorPosition(
  catalog: PlayerAppearanceCatalog,
  _poseId: PlayerCombatPoseId,
  anchorId: PlayerAttachmentAnchorId,
  x: number,
  y: number
): PlayerAppearanceCatalog {
  return {
    ...catalog,
    bodyVariants: catalog.bodyVariants.map((body) =>
      body.bodyVariantId === "default"
        ? {
            ...body,
            poses: body.poses.map((pose) => ({
              ...pose,
              anchors: {
                ...pose.anchors,
                [anchorId]: { x, y }
              }
            }))
          }
        : body
    )
  };
}
