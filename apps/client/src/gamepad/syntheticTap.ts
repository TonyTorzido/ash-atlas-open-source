/**
 * Events the gamepad controller fabricates for RT ("tap at the cursor"). They are marked so the map's
 * action-combat click handlers can tell them from a real mouse click: RT opens popups and interacts,
 * it never swings.
 */
const syntheticTaps = new WeakSet<object>();

export function markSyntheticTap<T extends Event>(event: T): T {
  syntheticTaps.add(event);
  return event;
}

export function isSyntheticTap(event: object | null | undefined): boolean {
  return Boolean(event) && syntheticTaps.has(event as object);
}
