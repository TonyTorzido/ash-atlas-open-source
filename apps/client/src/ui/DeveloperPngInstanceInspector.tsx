import { useSyncExternalStore } from "react";

import { findRegisteredDevPngAsset } from "../developer/devPngCatalogRegistry.js";
import type { DevPngLabController } from "../developer/devPngLabController.js";
import {
  calculateDevPngSize,
  devPngSpecNote,
  devPngMeasurementSummary,
  formatDevPngDimensions
} from "../developer/devPngSizing.js";
import type maplibregl from "maplibre-gl";
import { DeveloperPngSizeControls } from "./DeveloperPngSizeControls.js";
import { useMapZoom } from "./useMapZoom.js";

type Props = {
  controller: DevPngLabController;
  mapZoom?: number;
  /** When given, the inspector follows this map's zoom itself instead of re-rendering its parent. */
  map?: maplibregl.Map | null;
  onCenter(longitude: number, latitude: number): void;
};

export function DeveloperPngInstanceInspector({
  controller,
  mapZoom: mapZoomProp,
  map,
  onCenter
}: Props): React.JSX.Element | null {
  const mapZoom = useMapZoom(map, mapZoomProp ?? 14);
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const placement = state.placements.find(({ id }) => id === state.selectedPlacementId) ?? null;
  const asset = placement ? findRegisteredDevPngAsset(placement.assetId) : null;
  if (!placement || !asset) return null;
  const imageFailure = state.imageFailures[placement.id] ?? null;
  const size = calculateDevPngSize(
    asset,
    state.intrinsicSizes[asset.id] ?? null,
    mapZoom,
    placement.scaleMultiplier
  );

  return (
    <aside className="developer-png-instance-inspector" aria-label="Selected PNG instance">
      <header>
        {imageFailure ? (
          <span className="developer-png-instance-warning-icon" aria-label="Image unavailable">⚠</span>
        ) : (
          <img
            src={asset.url}
            alt=""
            onLoad={(event) => controller.registerIntrinsicSize(asset.id, event.currentTarget.naturalWidth, event.currentTarget.naturalHeight)}
          />
        )}
        <div><span>Selected local PNG</span><h2>{asset.label}</h2><small>{asset.usageLabel}</small></div>
        <button type="button" className="menu-text-close" aria-label="Close selected PNG inspector" onClick={() => controller.selectPlacement(null)}>Close</button>
      </header>
      <dl className="developer-png-instance-facts">
        <div><dt>Map position</dt><dd>{placement.latitude.toFixed(5)}, {placement.longitude.toFixed(5)}</dd></div>
        <div><dt>Effective size</dt><dd>{formatDevPngDimensions(size)}</dd></div>
        <div><dt>Sizing basis</dt><dd>{size.basis}</dd></div>
        <div><dt>Anchor</dt><dd>{asset.anchor.label}</dd></div>
      </dl>
      {imageFailure ? (
        <p className="developer-png-instance-failure" role="status">
          <strong>⚠ Image unavailable</strong>
          <span>This PNG failed to load. The small map marker is diagnostic only and does not represent the asset’s real dimensions.</span>
          <span>{imageFailure.message}</span>
          <code>{imageFailure.sourcePath}</code>
          <code>{imageFailure.url}</code>
        </p>
      ) : null}
      <DeveloperPngSizeControls
        asset={asset}
        controller={controller}
        mapZoom={mapZoom}
        placement={placement}
        state={state}
        idPrefix="png-map-instance"
      />
      <div className="developer-png-instance-actions">
        <button type="button" onClick={() => onCenter(placement.longitude, placement.latitude)}>Center</button>
        <button type="button" onClick={() => controller.duplicateSelected()}>Duplicate</button>
        <button type="button" onClick={() => controller.deleteSelected()}>Delete</button>
        <button type="button" onClick={() => void navigator.clipboard?.writeText(devPngMeasurementSummary(asset, size, placement.scaleMultiplier, mapZoom))}>Copy Measurements</button>
        <button type="button" onClick={() => void navigator.clipboard?.writeText(devPngSpecNote(asset, size, placement.scaleMultiplier, mapZoom))}>Copy Spec Note</button>
      </div>
    </aside>
  );
}
