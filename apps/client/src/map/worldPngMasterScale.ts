import {
  clampRuntimePngMasterScale,
  isRuntimePngMasterScaleEligible,
  RUNTIME_PNG_PRESENTATION_CATALOG,
  type RuntimeSpritePresentation
} from "@ash-atlas/shared";

let previewOverride: number | null = null;

export function worldPngMasterScale(): number {
  return previewOverride ?? RUNTIME_PNG_PRESENTATION_CATALOG.masterScale;
}

export function setWorldPngMasterScalePreview(value: number | null): number {
  previewOverride = value === null ? null : clampRuntimePngMasterScale(value);
  return worldPngMasterScale();
}

export function worldPngSpriteMasterScale(
  presentation: RuntimeSpritePresentation & Readonly<{ masterScaleEligible?: boolean }>
): number {
  if (presentation.masterScaleEligible === false) return 1;
  return worldPngMasterScale();
}

export function worldPngFixedMasterScale(key: string): number {
  return isRuntimePngMasterScaleEligible("fixed", key) ? worldPngMasterScale() : 1;
}

export function worldPngSpriteKeyMasterScale(key: string): number {
  return isRuntimePngMasterScaleEligible("sprite", key) ? worldPngMasterScale() : 1;
}
