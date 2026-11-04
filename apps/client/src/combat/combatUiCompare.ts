import type { CombatEntitySnapshot } from "@ash-atlas/shared";

/** Fields that change on nearly every server tick for a moving entity and are not shown by the target card. */
const SELECTED_IGNORED_KEYS: ReadonlySet<string> = new Set(["lat", "lon", "revision"]);

/** Structural equality for plain JSON-like data; no allocation. Key order does not matter. */
export function deepEqualJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  const aIsArray = Array.isArray(a);
  if (aIsArray !== Array.isArray(b)) return false;
  if (aIsArray) {
    const left = a as readonly unknown[];
    const right = b as readonly unknown[];
    if (left.length !== right.length) return false;
    for (let index = 0; index < left.length; index += 1) {
      if (!deepEqualJson(left[index], right[index])) return false;
    }
    return true;
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  let leftCount = 0;
  for (const key in left) {
    if (!Object.hasOwn(left, key) || left[key] === undefined) continue;
    leftCount += 1;
    if (!deepEqualJson(left[key], right[key])) return false;
  }
  let rightCount = 0;
  for (const key in right) {
    if (Object.hasOwn(right, key) && right[key] !== undefined) rightCount += 1;
  }
  return leftCount === rightCount;
}

/** The local player's HUD state: health, life/activity, target, protection windows, class and PvE combat. */
export function sameLocalCombatUi(
  current: CombatEntitySnapshot | null,
  next: CombatEntitySnapshot | null
): boolean {
  return (
    current?.entityId === next?.entityId &&
    current?.currentHealth === next?.currentHealth &&
    current?.maxHealth === next?.maxHealth &&
    current?.lifeState === next?.lifeState &&
    current?.activityState === next?.activityState &&
    current?.targetEntityId === next?.targetEntityId &&
    current?.aggressiveUntil === next?.aggressiveUntil &&
    current?.flagArrivalProtectionUntil === next?.flagArrivalProtectionUntil &&
    deepEqualJson(current?.classCombat ?? null, next?.classCombat ?? null) &&
    deepEqualJson(current?.pveCombat ?? null, next?.pveCombat ?? null)
  );
}

/**
 * The selected target as shown by the target card and prompts. Every field is compared except position and
 * revision: the server bumps revision whenever a chasing mob moves, which re-rendered the whole app at the
 * delta rate. Position is covered separately by the whole-metre distance the card prints.
 */
export function sameSelectedCombatUi(
  current: CombatEntitySnapshot | null,
  next: CombatEntitySnapshot | null
): boolean {
  if (current === next) return true;
  if (!current || !next) return false;
  const left = current as unknown as Record<string, unknown>;
  const right = next as unknown as Record<string, unknown>;
  let leftCount = 0;
  for (const key in left) {
    if (!Object.hasOwn(left, key) || SELECTED_IGNORED_KEYS.has(key) || left[key] === undefined) continue;
    leftCount += 1;
    if (!deepEqualJson(left[key], right[key])) return false;
  }
  let rightCount = 0;
  for (const key in right) {
    if (Object.hasOwn(right, key) && !SELECTED_IGNORED_KEYS.has(key) && right[key] !== undefined) rightCount += 1;
  }
  return leftCount === rightCount;
}
