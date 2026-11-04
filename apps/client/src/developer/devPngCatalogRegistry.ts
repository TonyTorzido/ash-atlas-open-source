import type { DevPngAsset } from "./devPngCatalog.js";

/**
 * The PNG Lab catalog is large and developer-only, so it is not part of the main bundle:
 * `devPngCatalog.ts` loads with the lazy PNG Lab panel and registers itself here. Everything
 * else reads it through this registry and sees an empty catalog until the Lab has been opened.
 */
let assets: readonly DevPngAsset[] = [];

export function registerDevPngAssets(loaded: readonly DevPngAsset[]): void {
  assets = loaded;
}

export function registeredDevPngAssets(): readonly DevPngAsset[] {
  return assets;
}

export function findRegisteredDevPngAsset(assetId: string): DevPngAsset | null {
  return assets.find(({ id }) => id === assetId) ?? null;
}
