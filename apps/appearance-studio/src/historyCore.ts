/**
 * Shared undo-step rules for every Studio history (Appearance, Bosses, Interiors).
 *
 * An edit may name a `group`. Consecutive edits that share a group key merge into the undo step the
 * first of them created:
 *  - gesture groups (no `idleMs`) stay open until they are explicitly ended, so one pointer drag is one
 *    step however long it lasts or pauses;
 *  - burst groups (`idleMs`) also merge, but start a new step after that much idle time. Keyboard nudges
 *    and typing/scrubbing in one field use them.
 * Edits without a group are discrete steps. Anything that is not an edit ends the open group.
 */
export const HISTORY_LIMIT = 200;
export const IDLE_GROUP_MS = 1000;

export type EditGroup = { key: string; idleMs?: number };
export type ActiveGroup = EditGroup & { at: number };

/** The one place that decides whether an edit merges into the previous undo step. */
export function resolveGroup(
  active: ActiveGroup | null,
  spec: EditGroup | undefined,
  at: number
): { coalesce: boolean; active: ActiveGroup | null } {
  if (!spec) return { coalesce: false, active: null };
  const coalesce = active !== null &&
    active.key === spec.key &&
    (active.idleMs === undefined || at - active.at <= active.idleMs);
  return {
    coalesce,
    active: { key: spec.key, at, ...(spec.idleMs !== undefined ? { idleMs: spec.idleMs } : {}) }
  };
}

export function pushPast<T>(past: readonly T[], entry: T): T[] {
  return [...past.slice(-(HISTORY_LIMIT - 1)), entry];
}

/** A group id for one pointer gesture, one nudge target, or one field. */
export function gestureGroup(id: number): EditGroup {
  return { key: `gesture:${id}` };
}

export function burstGroup(key: string): EditGroup {
  return { key, idleMs: IDLE_GROUP_MS };
}

/**
 * Wraps a state updater that also mutates history refs so React's development double-invocation
 * (StrictMode) cannot apply those side effects twice.
 */
export function runOnce<T>(update: (current: T) => T): (current: T) => T {
  let done = false;
  let result: T;
  return (current) => {
    if (done) return result;
    done = true;
    result = update(current);
    return result;
  };
}
