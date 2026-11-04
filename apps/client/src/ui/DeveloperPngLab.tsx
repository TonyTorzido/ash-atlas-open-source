import { useEffect, useMemo, useState, useSyncExternalStore } from "react";

import {
  DEV_PNG_ASSETS,
  DEV_PNG_CATEGORIES,
  filterDevPngAssets,
  findDevPngAsset
} from "../developer/devPngCatalog.js";
import type { DevPngLabController } from "../developer/devPngLabController.js";
import {
  calculateDevPngSize,
  formatDevPngDimensions
} from "../developer/devPngSizing.js";
import type maplibregl from "maplibre-gl";
import { ConfirmDialog } from "./ConfirmDialog.js";
import { useMapZoom } from "./useMapZoom.js";
import { DeveloperPngSizeControls } from "./DeveloperPngSizeControls.js";
import {
  RUNTIME_PNG_MASTER_SCALE_MAX,
  RUNTIME_PNG_MASTER_SCALE_MIN,
  RUNTIME_PNG_MASTER_SCALE_STEP,
  RUNTIME_PNG_PRESENTATION_CATALOG
} from "@ash-atlas/shared";

type Props = {
  controller: DevPngLabController;
  mapZoom: number;
  /** When given, the lab follows this map's zoom itself instead of re-rendering its parent. */
  map?: maplibregl.Map | null;
  playerPosition: Readonly<{ longitude: number; latitude: number }> | null;
  onStartPlacement(): void;
  onCenterSelected(longitude: number, latitude: number): void;
};

export function DeveloperPngLab({
  controller,
  mapZoom: mapZoomProp,
  map,
  playerPosition,
  onStartPlacement,
  onCenterSelected
}: Props): React.JSX.Element {
  const mapZoom = useMapZoom(map, mapZoomProp);
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  useEffect(() => {
    // The catalog loads with this panel, so the controller starts without a default selection.
    if (controller.getSnapshot().selectedAssetId) return;
    const first = DEV_PNG_ASSETS.find(({ placeable }) => placeable);
    if (first) controller.selectAsset(first.id);
  }, [controller]);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("all");
  const [placeableOnly, setPlaceableOnly] = useState(false);
  const [filterPlacements, setFilterPlacements] = useState(false);
  const [confirmClearAll, setConfirmClearAll] = useState(false);
  const [failedUrls, setFailedUrls] = useState<ReadonlySet<string>>(new Set());
  const filtered = useMemo(
    () => filterDevPngAssets(query, category, placeableOnly),
    [category, placeableOnly, query]
  );
  const asset = state.selectedAssetId ? findDevPngAsset(state.selectedAssetId) : DEV_PNG_ASSETS[0] ?? null;
  const selectedPlacement = state.placements.find(({ id }) => id === state.selectedPlacementId) ?? null;
  const inspectedPlacement = selectedPlacement?.assetId === asset?.id ? selectedPlacement : null;
  const intrinsic = asset ? state.intrinsicSizes[asset.id] ?? null : null;
  const productionSize = asset ? calculateDevPngSize(asset, intrinsic, mapZoom, 1) : null;
  const itemArtworkAsset = Boolean(asset?.sourcePath.replaceAll("\\", "/").startsWith("apps/client/src/assets/items/"));
  const instanceCount = asset ? state.placements.filter(({ assetId }) => assetId === asset.id).length : 0;
  const visiblePlacements = filterPlacements && asset
    ? state.placements.filter(({ assetId }) => assetId === asset.id)
    : state.placements;

  return (
    <>
      <section className="developer-png-lab" aria-label="PNG Lab">
        <section className="developer-png-master-scale" aria-label="World PNG Master Scale">
          <div>
            <strong>World PNG Master Scale</strong>
            <span>{state.masterScale.toFixed(2)}×</span>
          </div>
          <label>
            <span className="sr-only">World PNG Master Scale</span>
            <input
              type="range"
              aria-label="World PNG Master Scale"
              min={RUNTIME_PNG_MASTER_SCALE_MIN}
              max={RUNTIME_PNG_MASTER_SCALE_MAX}
              step={RUNTIME_PNG_MASTER_SCALE_STEP}
              value={state.masterScale}
              onChange={(event) => controller.setMasterScale(Number(event.currentTarget.value))}
            />
          </label>
          <label>
            <span className="sr-only">World PNG Master Scale value</span>
            <input
              type="number"
              aria-label="World PNG Master Scale value"
              min={RUNTIME_PNG_MASTER_SCALE_MIN}
              max={RUNTIME_PNG_MASTER_SCALE_MAX}
              step={RUNTIME_PNG_MASTER_SCALE_STEP}
              value={state.masterScale}
              onChange={(event) => controller.setMasterScale(Number(event.currentTarget.value))}
            />
          </label>
          <button
            type="button"
            disabled={state.masterScale === RUNTIME_PNG_PRESENTATION_CATALOG.masterScale}
            onClick={() => controller.resetMasterScale()}
          >Reset to {RUNTIME_PNG_PRESENTATION_CATALOG.masterScale.toFixed(2)}×</button>
          <small>Session-only preview for eligible in-world PNGs. Player and territory flag art remain unchanged.</small>
        </section>
        <div className="developer-png-browser">
          <div className="developer-png-filters">
            <label>Search PNGs<input type="search" value={query} placeholder="Name, usage, or source" onChange={(event) => setQuery(event.currentTarget.value)} /></label>
            <label>Category<select value={category} onChange={(event) => setCategory(event.currentTarget.value)}>
              <option value="all">All categories</option>
              {DEV_PNG_CATEGORIES.map((value) => <option key={value} value={value}>{value}</option>)}
            </select></label>
            <label className="developer-png-check"><input type="checkbox" checked={placeableOnly} onChange={(event) => setPlaceableOnly(event.currentTarget.checked)} />Placeable only</label>
            <span className="developer-png-count" role="status">{filtered.length} usages</span>
          </div>
          {filtered.length === 0 ? <p className="developer-png-empty">No PNG assets match this filter.</p> : (
            <div className="developer-png-grid" aria-label="PNG assets">
              {filtered.map((entry) => (
                <button type="button" key={entry.id} className={asset?.id === entry.id ? "selected" : undefined} aria-pressed={asset?.id === entry.id} onClick={() => controller.selectAsset(entry.id)}>
                  {failedUrls.has(entry.url) ? <span className="developer-png-broken" title={`Missing PNG: ${entry.sourcePath}`}>⚠ Missing PNG</span> : (
                    <img src={entry.url} alt={`${entry.label} thumbnail`} onLoad={(event) => controller.registerIntrinsicSize(entry.id, event.currentTarget.naturalWidth, event.currentTarget.naturalHeight)} onError={() => setFailedUrls((current) => new Set(current).add(entry.url))} />
                  )}
                  <span><strong>{entry.label}</strong><small>{entry.usageLabel}</small><em>{entry.placeable ? "Placeable" : "Browser icon · view only"}</em></span>
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="developer-png-inspector">
          {asset ? (
            <>
              <div className="developer-png-inspector-top">
                <div className="developer-png-preview">
                  {failedUrls.has(asset.url) ? <span className="developer-png-broken" title={asset.sourcePath}>⚠ Missing PNG</span> : (
                    <img key={asset.url} src={asset.url} alt={`${asset.label} preview`} onLoad={(event) => controller.registerIntrinsicSize(asset.id, event.currentTarget.naturalWidth, event.currentTarget.naturalHeight)} onError={() => setFailedUrls((current) => new Set(current).add(asset.url))} />
                  )}
                </div>
                <div className="developer-png-heading"><span>{asset.category}</span><h3>{asset.label}</h3><p>{asset.usageLabel}</p></div>
              </div>
              {failedUrls.has(asset.url) ? <p className="developer-png-missing-note">Preview image failed to load. This marker is diagnostic only and does not represent the asset’s real size.</p> : null}
              {itemArtworkAsset ? <p className="developer-png-item-authority-note" role="note"><strong>Permanent item-size authoring lives in Appearance Studio → Game PNGs.</strong> This PNG Lab only previews temporary browser-session placements; its size controls never save to the runtime presentation catalog.</p> : null}
              <dl className="developer-png-details">
                <div><dt>PNG source</dt><dd>{asset.sourcePath}</dd></div>
                <div><dt>Intrinsic PNG</dt><dd>{intrinsic ? `${intrinsic.width} × ${intrinsic.height} px` : "Loading…"}</dd></div>
                <div><dt>Production size</dt><dd>{productionSize ? `${formatDevPngDimensions(productionSize)}${asset.productionSize?.kind === "zoom-scaled" ? ` at zoom ${mapZoom.toFixed(2)}` : ""}` : "Unknown"}</dd></div>
                <div><dt>Sizing authority</dt><dd>{asset.productionSize?.source ?? "Intrinsic PNG dimensions (fallback; no production authority)"}</dd></div>
                <div><dt>Defined in</dt><dd>{asset.productionSize?.definedIn ?? "Discovered runtime PNG"}</dd></div>
                <div><dt>Anchor</dt><dd>{asset.anchor.label}</dd></div>
              </dl>
              {!asset.productionSize ? <p className="developer-png-fallback-note">No fixed production size is defined. This preview uses the PNG’s intrinsic dimensions as a clearly marked temporary fallback.</p> : null}
              <DeveloperPngSizeControls asset={asset} controller={controller} mapZoom={mapZoom} placement={null} state={state} idPrefix="png-lab-next-size" />
              {inspectedPlacement ? <DeveloperPngSizeControls asset={asset} controller={controller} mapZoom={mapZoom} placement={inspectedPlacement} state={state} idPrefix="png-lab-selected-size" /> : null}
              <div className="developer-png-primary-actions">
                {asset.placeable ? (
                  state.placementMode
                    ? <button type="button" className="primary developer-png-add-screen active" aria-pressed="true" onClick={() => controller.stopPlacement()}>Stop Placing</button>
                    : <button type="button" className="primary developer-png-add-screen" aria-pressed="false" onClick={onStartPlacement}>Add to Screen</button>
                ) : <button type="button" disabled>View-only browser icon</button>}
                <button type="button" disabled={!asset.placeable || !playerPosition} onClick={() => controller.placeAtPlayer(playerPosition)}>Place at Player</button>
              </div>
              <section className="developer-png-placements" aria-label="Placed PNGs">
                <header><div><h3>Placed PNGs</h3><span>{state.placements.length} total · {instanceCount} selected asset</span></div><label><input type="checkbox" checked={filterPlacements} onChange={(event) => setFilterPlacements(event.currentTarget.checked)} />Selected asset only</label></header>
                {visiblePlacements.length === 0 ? <p className="developer-png-empty">No matching local placements yet.</p> : (
                  <div className="developer-png-placement-list">
                    {visiblePlacements.map((placement) => {
                      const placedAsset = findDevPngAsset(placement.assetId);
                      if (!placedAsset) return null;
                      const size = calculateDevPngSize(placedAsset, state.intrinsicSizes[placedAsset.id] ?? null, mapZoom, placement.scaleMultiplier);
                      return <article key={placement.id} className={placement.id === state.selectedPlacementId ? "selected" : undefined}>
                        <img src={placedAsset.url} alt="" />
                        <div><strong>{placedAsset.label}</strong><span>{placement.scaleMultiplier.toFixed(2)}× · {formatDevPngDimensions(size)}</span><small>{placement.latitude.toFixed(4)}, {placement.longitude.toFixed(4)}</small></div>
                        <div><button type="button" onClick={() => controller.selectPlacement(placement.id)}>Select</button><button type="button" onClick={() => onCenterSelected(placement.longitude, placement.latitude)}>Center</button><button type="button" onClick={() => controller.duplicatePlacement(placement.id)}>Duplicate</button><button type="button" onClick={() => controller.deletePlacement(placement.id)}>Delete</button></div>
                      </article>;
                    })}
                  </div>
                )}
              </section>
              <div className="developer-png-clear-actions">
                <button type="button" disabled={instanceCount === 0} onClick={() => controller.clearSelectedAsset()}>Clear Selected Asset</button>
                <button type="button" className="danger-action" disabled={state.placements.length === 0} onClick={() => setConfirmClearAll(true)}>Clear All PNGs</button>
              </div>
              <p className="muted" role="status" aria-live="polite">{state.status}</p>
            </>
          ) : <p className="developer-png-empty">No PNG assets are available.</p>}
        </div>
      </section>
      {confirmClearAll ? <ConfirmDialog title="Clear all local PNGs?" message={`This removes all ${state.placements.length} temporary PNG placements from this browser session.`} confirmLabel="Clear All PNGs" busy={false} onCancel={() => setConfirmClearAll(false)} onConfirm={() => { controller.clearAll(); setConfirmClearAll(false); }} /> : null}
    </>
  );
}
