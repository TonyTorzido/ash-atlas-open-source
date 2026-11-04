const bundledAppearanceAssets = import.meta.glob(
  "./assets/player-appearance/**/*.png",
  {
    eager: true,
    query: "?url",
    import: "default"
  }
) as Record<string, string>;

export const PLAYER_APPEARANCE_ASSET_URLS: Readonly<Record<string, string>> =
  Object.freeze(Object.fromEntries(
    Object.entries(bundledAppearanceAssets).map(([modulePath, url]) => [
      modulePath.replace("./assets/player-appearance/", ""),
      url
    ])
  ));

const runtimePlayerAppearanceAssetUrlOverrides = new Map<string, string>();

export function setRuntimePlayerAppearanceAssetUrlOverrides(
  overrides: readonly Readonly<{ assetKey: string; url: string }>[]
): void {
  for (const url of runtimePlayerAppearanceAssetUrlOverrides.values()) {
    if (url.startsWith("blob:")) URL.revokeObjectURL(url);
  }
  runtimePlayerAppearanceAssetUrlOverrides.clear();
  for (const { assetKey, url } of overrides) {
    if (assetKey in PLAYER_APPEARANCE_ASSET_URLS && url.startsWith("blob:")) {
      runtimePlayerAppearanceAssetUrlOverrides.set(assetKey, url);
    }
  }
}

export function playerAppearanceAssetUrl(assetKey: string): string | null {
  return runtimePlayerAppearanceAssetUrlOverrides.get(assetKey) ?? PLAYER_APPEARANCE_ASSET_URLS[assetKey] ?? null;
}

const bundledBossAppearanceAssets = import.meta.glob(
  "./assets/boss-appearance/**/*.png",
  {
    eager: true,
    query: "?url",
    import: "default"
  }
) as Record<string, string>;

export const BOSS_APPEARANCE_ASSET_URLS: Readonly<Record<string, string>> =
  Object.freeze(Object.fromEntries(
    Object.entries(bundledBossAppearanceAssets).map(([modulePath, url]) => [
      modulePath.replace("./assets/boss-appearance/", ""),
      url
    ])
  ));

export function bossAppearanceAssetUrl(assetKey: string): string | null {
  return BOSS_APPEARANCE_ASSET_URLS[assetKey] ?? null;
}
