import {
  RUNTIME_PNG_CLIENT_ASSET_ROOT,
  type RuntimePngGreenhouseCropPresentation
} from "@ash-atlas/shared";

const runtimePngAssetModules = import.meta.glob<string>("../assets/**/*.png", {
  eager: true,
  import: "default",
  query: "?url"
});
const runtimePngAssetUrlOverrides = new Map<string, string>();
const greenhouseCropStageAssetUrls = new Map<string, string>();
let selectedPackId: string | null = null;
let greenhouseCropPresentations: readonly RuntimePngGreenhouseCropPresentation[] = [];

export function setRuntimePngAssetUrlOverrides(
  overrides: readonly Readonly<{ relativeFile: string; url: string }>[],
  packId: string | null = null,
  cropPresentations: readonly RuntimePngGreenhouseCropPresentation[] = [],
  cropStageOverrides: readonly Readonly<{ cropId: string; stage: number; url: string }>[] = []
): void {
  for (const url of [...runtimePngAssetUrlOverrides.values(), ...greenhouseCropStageAssetUrls.values()]) {
    if (url.startsWith("blob:")) URL.revokeObjectURL(url);
  }
  runtimePngAssetUrlOverrides.clear();
  greenhouseCropStageAssetUrls.clear();
  for (const { relativeFile, url } of overrides) {
    if (relativeFile.startsWith(RUNTIME_PNG_CLIENT_ASSET_ROOT) && url.startsWith("blob:")) {
      runtimePngAssetUrlOverrides.set(relativeFile, url);
    }
  }
  for (const { cropId, stage, url } of cropStageOverrides) {
    if (/^[a-z][a-z0-9_]{0,47}$/u.test(cropId) && Number.isInteger(stage) && stage >= 1 && stage <= 4 && url.startsWith("blob:")) {
      greenhouseCropStageAssetUrls.set(`${cropId}:${stage}`, url);
    }
  }
  selectedPackId = packId;
  greenhouseCropPresentations = cropPresentations;
}

export function greenhouseCropStageAssetUrl(cropId: string, stage: number): string | null {
  return greenhouseCropStageAssetUrls.get(`${cropId}:${stage}`) ?? null;
}

export function selectedRuntimePngContentPack(): Readonly<{
  packId: string | null;
  greenhouseCropPresentations: readonly RuntimePngGreenhouseCropPresentation[];
}> {
  return { packId: selectedPackId, greenhouseCropPresentations };
}

/**
 * Resolve a production registry path to the bundled client URL. Missing
 * registered art intentionally resolves to null so callers can retain their
 * renderer-owned fallback texture.
 */
export function runtimePngAssetUrl(relativeFile: string): string | null {
  if (!relativeFile.startsWith(RUNTIME_PNG_CLIENT_ASSET_ROOT)) return null;
  const override = runtimePngAssetUrlOverrides.get(relativeFile);
  if (override) return override;
  const assetPath = `../assets/${relativeFile.slice(RUNTIME_PNG_CLIENT_ASSET_ROOT.length)}`;
  return runtimePngAssetModules[assetPath] ?? null;
}

/**
 * Resolve a Studio asset key under either client asset root: bundled
 * `apps/client/src/assets/...` art, or `apps/client/public/assets/...` art the
 * Studio imports (served from the app base URL).
 */
export function clientAssetKeyUrl(assetKey: string): string | null {
  const publicPrefix = "apps/client/public/";
  if (assetKey.startsWith(publicPrefix)) {
    return `${import.meta.env.BASE_URL}${assetKey.slice(publicPrefix.length)}`;
  }
  return runtimePngAssetUrl(assetKey);
}
