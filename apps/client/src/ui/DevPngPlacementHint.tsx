import type maplibregl from "maplibre-gl";

import { calculateDevPngSize, formatDevPngDimensions } from "../developer/devPngSizing.js";
import { useMapZoom } from "./useMapZoom.js";

type SizingAsset = Parameters<typeof calculateDevPngSize>[0];

type Props = {
  map: maplibregl.Map | null;
  asset: SizingAsset & { label: string; usageLabel: string };
  intrinsic: Parameters<typeof calculateDevPngSize>[1];
  multiplier: number;
  fallbackZoom: number;
};

/** PNG Lab placement hint. Reads the live zoom itself so a pinch never re-renders GameApp. */
export function DevPngPlacementHint({ map, asset, intrinsic, multiplier, fallbackZoom }: Props): React.JSX.Element | null {
  const zoom = useMapZoom(map, fallbackZoom);
  const size = calculateDevPngSize(asset, intrinsic, zoom, multiplier);
  if (!size) return null;
  return (
    <div className="teleport-mode-instruction" role="status">PNG Lab · {asset.label} ({asset.usageLabel}) · {multiplier.toFixed(2)}× · {formatDevPngDimensions(size)}. Click repeatedly to add copies; Esc or right-click stops.</div>
  );
}
