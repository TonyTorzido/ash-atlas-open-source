/**
 * Monastery of the Still Hand (level 22 dungeon). Inside, weapons deal no damage: every player fights
 * unarmed and is granted martial skills for the run. The Grandmaster drops Zephyr; six Zephyr offered at the
 * Zephyr Altar unlock Perfect Strike (still bought with General Skill Points).
 */
export const STILL_HAND_MONASTERY_DUNGEON_ID = "still_hand_monastery";

/** Room ids are unique across the interior catalog, so a room id identifies the dungeon. */
export const STILL_HAND_MONASTERY_ROOM_IDS = [
  "mountain_gate",
  "training_courtyard",
  "bell_hall",
  "still_garden",
  "statue_hall",
  "grandmaster_sanctum"
] as const;

const ROOM_ID_SET: ReadonlySet<string> = new Set(STILL_HAND_MONASTERY_ROOM_IDS);

/** True for a combat zone id (`interior:<instance>:<room>`) inside the Monastery. */
export function isStillHandMonasteryZone(zoneId: string | null | undefined): boolean {
  if (!zoneId || !zoneId.startsWith("interior:")) return false;
  return ROOM_ID_SET.has(zoneId.slice(zoneId.lastIndexOf(":") + 1));
}

/** General skill ranks every player fights with inside the Monastery (higher learned ranks still count). */
export const STILL_HAND_GRANTED_SKILL_RANKS = Object.freeze({ martial_arts: 3, perfect_strike: 1 } as const);

export const ZEPHYR_ITEM_ID = "zephyr";
export const ZEPHYR_ALTAR_COST = 6;
/** The general skill the Zephyr Altar unlocks. */
export const ZEPHYR_ALTAR_SKILL_ID = "perfect_strike";
