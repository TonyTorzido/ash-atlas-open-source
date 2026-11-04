import type { BossAppearanceCatalog } from "@ash-atlas/shared";
import { pushPast, resolveGroup, type ActiveGroup, type EditGroup } from "./historyCore.js";

export type BossStudioHistory = {
  past: BossAppearanceCatalog[];
  present: BossAppearanceCatalog;
  future: BossAppearanceCatalog[];
  saved: BossAppearanceCatalog;
  revision: number;
  group: ActiveGroup | null;
};

export type BossStudioAction =
  | { type: "load"; catalog: BossAppearanceCatalog }
  | {
      type: "restoreDraft";
      catalog: BossAppearanceCatalog;
      saved: BossAppearanceCatalog;
    }
  | { type: "edit"; catalog: BossAppearanceCatalog; group?: EditGroup; at?: number }
  | { type: "endGroup" }
  | { type: "cancelGroup"; key: string }
  | { type: "undo" }
  | { type: "redo" }
  | { type: "revert" }
  | { type: "markSaved"; catalog: BossAppearanceCatalog; submittedRevision: number };

export function createBossStudioHistory(
  catalog: BossAppearanceCatalog
): BossStudioHistory {
  return {
    past: [],
    present: structuredClone(catalog),
    future: [],
    saved: structuredClone(catalog),
    revision: 0,
    group: null
  };
}

export function bossStudioReducer(
  history: BossStudioHistory,
  action: BossStudioAction
): BossStudioHistory {
  if (action.type === "load") return createBossStudioHistory(action.catalog);
  if (action.type === "restoreDraft") {
    return {
      past: [],
      present: structuredClone(action.catalog),
      future: [],
      saved: structuredClone(action.saved),
      revision: 1,
      group: null
    };
  }
  if (action.type === "edit") {
    if (JSON.stringify(action.catalog) === JSON.stringify(history.present)) return history;
    const { coalesce, active } = resolveGroup(history.group, action.group, action.at ?? Date.now());
    return {
      ...history,
      past: coalesce ? history.past : pushPast(history.past, structuredClone(history.present)),
      present: structuredClone(action.catalog),
      future: coalesce ? history.future : [],
      revision: history.revision + 1,
      group: active
    };
  }
  if (action.type === "endGroup") return history.group ? { ...history, group: null } : history;
  if (action.type === "cancelGroup") {
    if (!history.group || history.group.key !== action.key) return history;
    const previous = history.past.at(-1);
    if (!previous) return { ...history, group: null };
    return {
      ...history,
      past: history.past.slice(0, -1),
      present: structuredClone(previous),
      revision: history.revision + 1,
      group: null
    };
  }
  if (action.type === "undo") {
    const previous = history.past.at(-1);
    if (!previous) return history;
    return {
      ...history,
      past: history.past.slice(0, -1),
      present: structuredClone(previous),
      future: [structuredClone(history.present), ...history.future],
      revision: history.revision + 1,
      group: null
    };
  }
  if (action.type === "redo") {
    const next = history.future[0];
    if (!next) return history;
    return {
      ...history,
      past: [...history.past, structuredClone(history.present)],
      present: structuredClone(next),
      future: history.future.slice(1),
      revision: history.revision + 1,
      group: null
    };
  }
  if (action.type === "revert") {
    return {
      ...history,
      past: pushPast(history.past, structuredClone(history.present)),
      present: structuredClone(history.saved),
      future: [],
      revision: history.revision + 1,
      group: null
    };
  }
  if (history.revision === action.submittedRevision) {
    return {
      ...history,
      present: structuredClone(action.catalog),
      saved: structuredClone(action.catalog),
      revision: history.revision + 1,
      group: null
    };
  }
  return {
    ...history,
    present: {
      ...structuredClone(history.present),
      catalogRevision: action.catalog.catalogRevision
    },
    saved: structuredClone(action.catalog),
    revision: history.revision + 1,
    group: null
  };
}

export function bossStudioIsDirty(history: BossStudioHistory): boolean {
  return JSON.stringify(history.present) !== JSON.stringify(history.saved);
}
