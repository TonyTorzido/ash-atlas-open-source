export const PERSONAL_FLAG_COLORS = ["red", "blue", "green", "gold", "purple"] as const;
export type PersonalFlagColor = (typeof PERSONAL_FLAG_COLORS)[number];

export const PERSONAL_FLAG_COLOR_HEX: Readonly<Record<PersonalFlagColor, string>> = {
  red: "#d83a3a",
  blue: "#3366cc",
  green: "#22a447",
  gold: "#c58a16",
  purple: "#7c3aed"
};

export const CITY_FLAG_COLOR = "#000000";

export function isPersonalFlagColor(value: unknown): value is PersonalFlagColor {
  return typeof value === "string" &&
    (PERSONAL_FLAG_COLORS as readonly string[]).includes(value);
}

export function personalFlagColorHex(color: PersonalFlagColor): string {
  return PERSONAL_FLAG_COLOR_HEX[color];
}

export function personalFlagColorFromHex(value: string): PersonalFlagColor | null {
  const normalized = value.toLowerCase();
  for (const color of PERSONAL_FLAG_COLORS) {
    if (PERSONAL_FLAG_COLOR_HEX[color] === normalized) return color;
  }
  return null;
}
