export const TAP_ASSISTANCE_PADDING_PX = {
  precise: 6,
  standard: 12,
  large: 20
} as const;

export type TapAssistancePreference = keyof typeof TAP_ASSISTANCE_PADDING_PX;

export const DEFAULT_TAP_ASSISTANCE: TapAssistancePreference = "standard";

export function readTapAssistancePreference(playerId: string): TapAssistancePreference {
  const stored = window.localStorage.getItem(preferenceKey(playerId));
  return isTapAssistancePreference(stored) ? stored : DEFAULT_TAP_ASSISTANCE;
}

export function persistTapAssistancePreference(
  playerId: string,
  preference: TapAssistancePreference
): TapAssistancePreference {
  window.localStorage.setItem(preferenceKey(playerId), preference);
  return preference;
}

export function tapAssistancePaddingPx(preference: TapAssistancePreference): number {
  return TAP_ASSISTANCE_PADDING_PX[preference];
}

function isTapAssistancePreference(value: string | null): value is TapAssistancePreference {
  return value === "precise" || value === "standard" || value === "large";
}

function preferenceKey(playerId: string): string {
  return `ashAtlas.player.${playerId}.tapAssistance.v1`;
}
