import { spriteHeightForZoom, SPRITE_BASE_ZOOM } from "../map/spritePresentation.js";
import type { DevPngAsset } from "./devPngCatalog.js";

export type DevPngIntrinsicSize = Readonly<{ width: number; height: number }>;

export type DevPngRenderedSize = Readonly<{
  width: number | null;
  height: number | null;
  basis: "fixed production" | "zoom-scaled production" | "item production" | "intrinsic fallback";
}>;

export function calculateDevPngSize(
  asset: DevPngAsset,
  intrinsic: DevPngIntrinsicSize | null,
  zoom: number,
  multiplier: number
): DevPngRenderedSize {
  const production = asset.productionSize;
  if (production?.kind === "fixed") {
    const masterScale = production.masterScale();
    return {
      width: production.width * multiplier * masterScale,
      height: production.height * multiplier * masterScale,
      basis: "fixed production"
    };
  }
  if (production?.kind === "zoom-scaled") {
    const height = spriteHeightForZoom(
      zoom,
      SPRITE_BASE_ZOOM,
      production.presentation
    ) * multiplier;
    return {
      width: intrinsic && intrinsic.height > 0
        ? intrinsic.width * height / intrinsic.height
        : null,
      height,
      basis: "zoom-scaled production"
    };
  }
  if (production?.kind === "item-scaled") {
    const height = production.presentation.baseHeightPx * multiplier;
    return {
      width: intrinsic && intrinsic.height > 0
        ? intrinsic.width * height / intrinsic.height
        : null,
      height,
      basis: "item production"
    };
  }
  return {
    width: intrinsic ? intrinsic.width * multiplier : null,
    height: intrinsic ? intrinsic.height * multiplier : null,
    basis: "intrinsic fallback"
  };
}

export function formatDevPngDimension(value: number | null): string {
  if (value === null) return "loading";
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

export function formatDevPngDimensions(size: DevPngRenderedSize): string {
  return `${formatDevPngDimension(size.width)} × ${formatDevPngDimension(size.height)} px`;
}

export function devPngMeasurementSummary(
  asset: DevPngAsset,
  size: DevPngRenderedSize,
  multiplier: number,
  zoom: number
): string {
  const zoomText = asset.productionSize?.kind === "zoom-scaled"
    ? ` at map zoom ${zoom.toFixed(2)}`
    : "";
  return `${asset.label} — ${formatDevPngDimensions(size)} at ${multiplier.toFixed(2)}×${zoomText} (${size.basis})`;
}

export function devPngSpecNote(
  asset: DevPngAsset,
  size: DevPngRenderedSize,
  multiplier: number,
  zoom: number
): string {
  return `Ash Atlas PNG Lab: use ${asset.sourcePath} for ${asset.usageLabel}. Temporary target is ${formatDevPngDimensions(size)} at ${multiplier.toFixed(2)}×${asset.productionSize?.kind === "zoom-scaled" ? ` and zoom ${zoom.toFixed(2)}` : ""}; production authority: ${asset.productionSize?.source ?? "intrinsic PNG fallback"}.`;
}
