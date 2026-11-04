import type {
  RuntimeFixedPngPresentation,
  RuntimePngInteractionGeometry,
  RuntimePngPresentationCatalog,
  RuntimeSpritePresentation
} from "@ash-atlas/shared";
import {
  MANOR_MAIN_ROOM,
  MANOR_PLAYER_VISUAL_HEIGHT_UNITS,
  isRuntimePngMasterScaleEligible,
  RUNTIME_PNG_MASTER_SCALE_MAX,
  RUNTIME_PNG_MASTER_SCALE_MIN,
  RUNTIME_PNG_MASTER_SCALE_STEP,
  RUNTIME_PNG_ITEM_INVENTORY_FRAME_PX,
  RUNTIME_PNG_ITEM_DEFAULT_HEIGHT_PX,
  runtimePngItemGroundHitGeometry,
  runtimePngItemGroundVisualHeight,
  runtimePngItemPresentation
} from "@ash-atlas/shared";
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent
} from "react";
import { createPortal } from "react-dom";

import type {
  RuntimeAsset,
  RuntimeAssetInbox,
  RuntimeAssetInboxEntry,
  RuntimeAssetUsage
} from "./bridgeTypes.js";
import { IndoorPlayerLayer } from "../../client/src/ui/IndoorPlayerLayer.js";
import { DUNGEON_WALK_TEST_PRESETS } from "./dungeonStudioV2.js";
import type { StudioApi } from "./studioApi.js";

export type AssetStudioHandle = {
  save(): Promise<boolean>;
  revert(): Promise<void>;
  setPlayerHitGeometry(value: RuntimePngInteractionGeometry): void;
  revertPlayerHitGeometry(): void;
};

export type PlayerHitGeometryState = {
  value: RuntimePngInteractionGeometry;
  anchorX: number;
  anchorY: number;
  dirty: boolean;
};

type AssetStudioProps = {
  api: StudioApi;
  visible: boolean;
  writesAllowed: boolean;
  onDirtyChange(dirty: boolean): void;
  onBusyChange(busy: boolean): void;
  onMessage(message: string): void;
  onOpenAppearance(domain: "player" | "boss"): void;
  onPlayerHitGeometryChange(state: PlayerHitGeometryState | null): void;
};

export const AssetStudio = forwardRef<AssetStudioHandle, AssetStudioProps>(
  function AssetStudio(props, ref) {
    const [assets, setAssets] = useState<RuntimeAsset[]>([]);
    const [inbox, setInbox] = useState<RuntimeAssetInbox | null>(null);
    const [presentation, setPresentation] = useState<RuntimePngPresentationCatalog | null>(null);
    const [savedPresentation, setSavedPresentation] = useState<RuntimePngPresentationCatalog | null>(null);
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [selectedUsageId, setSelectedUsageId] = useState<string | null>(null);
    const [search, setSearch] = useState("");
    const [category, setCategory] = useState("All PNGs");
    const [editableOnly, setEditableOnly] = useState(false);
    const [overlayId, setOverlayId] = useState("");
    const [showOverlay, setShowOverlay] = useState(true);
    const [overlayOffset, setOverlayOffset] = useState({ x: 0, y: 0 });
    const [actualPixels, setActualPixels] = useState(false);
    const [keepStandardized, setKeepStandardized] = useState(false);
    const [proportionsLocked, setProportionsLocked] = useState(true);
    const [zoom, setZoom] = useState(1);
    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const busyRef = useRef(false);
    const replaceInputRef = useRef<HTMLInputElement>(null);
    const overlayDragRef = useRef<{
      pointerId: number;
      clientX: number;
      clientY: number;
      offsetX: number;
      offsetY: number;
    } | null>(null);

    const load = async (): Promise<void> => {
      setLoading(true);
      setError(null);
      try {
        const [inventory, nextInbox] = await Promise.all([
          props.api.loadRuntimeAssets(),
          props.api.loadRuntimeAssetInbox()
        ]);
        setAssets(inventory.assets);
        setInbox(nextInbox);
        setPresentation(structuredClone(inventory.presentation));
        setSavedPresentation(structuredClone(inventory.presentation));
        setSelectedId((current) =>
          inventory.assets.some((asset) => asset.id === current)
            ? current
            : inventory.assets[0]?.id ?? null
        );
        setOverlayId((current) => current ||
          inventory.assets.find((asset) => asset.relativeFile.includes("/bodies/player.png"))?.id ||
          inventory.assets.find((asset) => asset.category === "Player Appearance")?.id || "");
      } catch (caught) {
        setError(errorMessage(caught));
      } finally {
        setLoading(false);
      }
    };

    useEffect(() => {
      void load();
    }, []);

    const selected = assets.find((asset) => asset.id === selectedId) ?? null;
    const selectedSizingAsset = selected;
    const selectedUsage = selected?.usages.find((usage) => usage.id === selectedUsageId) ??
      (selected ? defaultRuntimeAssetUsage(selected) : null);

    useEffect(() => {
      if (!selected) return;
      if (!selected.usages.some((usage) => usage.id === selectedUsageId)) {
        setSelectedUsageId(defaultRuntimeAssetUsage(selected)?.id ?? null);
      }
    }, [selected, selectedUsageId]);

    useEffect(() => {
      setOverlayOffset({ x: 0, y: 0 });
      overlayDragRef.current = null;
    }, [selectedId, overlayId]);

    const categories = useMemo(() => [
      "All PNGs",
      ...new Set(assets.map((asset) => asset.category))
    ], [assets]);
    const visibleAssets = useMemo(() => {
      const query = search.trim().toLowerCase();
      return assets.filter((asset) =>
        (category === "All PNGs" || asset.category === category) &&
        (!editableOnly || asset.usages.some((usage) => isVisualEditor(usage))) &&
        (!query || `${asset.label} ${asset.relativeFile} ${asset.usages.map((usage) => usage.label).join(" ")}`
          .toLowerCase().includes(query))
      );
    }, [assets, category, editableOnly, search]);
    const visibleInboxEntries = useMemo(() => {
      if (!inbox) return [];
      const query = search.trim().toLowerCase();
      return inbox.entries.filter((entry) =>
        !query || `${entry.label} ${entry.sourceFile} ${entry.destinationFile}`
          .toLowerCase().includes(query)
      );
    }, [inbox, search]);
    const dirty = Boolean(
      presentation && savedPresentation &&
      JSON.stringify(presentation) !== JSON.stringify(savedPresentation)
    ) || assets.some((asset) => asset.staged);

    useEffect(() => props.onDirtyChange(dirty), [dirty, props.onDirtyChange]);
    useEffect(() => props.onBusyChange(busy), [busy, props.onBusyChange]);

    const playerHitGeometry = presentation?.sprites.player?.hitGeometry ?? null;
    const playerAnchorX = presentation?.sprites.player?.anchorX ?? null;
    const playerAnchorY = presentation?.sprites.player?.anchorY ?? null;
    const savedPlayerHitGeometry = savedPresentation?.sprites.player?.hitGeometry ?? null;
    const playerHitGeometryDirty = Boolean(
      playerHitGeometry && savedPlayerHitGeometry &&
      JSON.stringify(playerHitGeometry) !== JSON.stringify(savedPlayerHitGeometry)
    );

    useEffect(() => {
      props.onPlayerHitGeometryChange(playerHitGeometry ? {
        value: structuredClone(playerHitGeometry),
        anchorX: playerAnchorX!,
        anchorY: playerAnchorY!,
        dirty: playerHitGeometryDirty
      } : null);
    }, [
      playerAnchorX,
      playerAnchorY,
      playerHitGeometry,
      playerHitGeometryDirty,
      props.onPlayerHitGeometryChange
    ]);

    const save = async (): Promise<boolean> => {
      if (!presentation || busyRef.current) return false;
      if (!dirty) return true;
      busyRef.current = true;
      setBusy(true);
      setError(null);
      props.onMessage("Saving Asset Studio changes to the worktree…");
      try {
        const result = await props.api.publishRuntimeAssets(presentation);
        setAssets(result.inventory.assets);
        setPresentation(structuredClone(result.presentation));
        setSavedPresentation(structuredClone(result.presentation));
        try {
          setInbox(await props.api.loadRuntimeAssetInbox());
        } catch {
          // The save already succeeded; a later Refresh PNGs can retry inbox discovery.
        }
        props.onMessage(
          result.modifiedFiles.length > 0
            ? `Saved Asset Studio revision ${result.presentation.revision}: ${result.modifiedFiles.join(", ")}`
            : "Asset Studio had no byte changes to write."
        );
        return true;
      } catch (caught) {
        const message = errorMessage(caught);
        setError(message);
        props.onMessage(message);
        return false;
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    };

    const setPlayerHitGeometry = (value: RuntimePngInteractionGeometry): void => {
      if (busyRef.current) return;
      editSprite("player", { hitGeometry: structuredClone(value) });
    };

    const revertPlayerHitGeometry = (): void => {
      if (!savedPlayerHitGeometry || busyRef.current) return;
      editSprite("player", { hitGeometry: structuredClone(savedPlayerHitGeometry) });
    };

    const revert = async (): Promise<void> => {
      if (busy || !savedPresentation) return;
      setBusy(true);
      setError(null);
      try {
        const [inventory, nextInbox] = await Promise.all([
          props.api.discardRuntimeAssetChanges(),
          props.api.loadRuntimeAssetInbox()
        ]);
        setAssets(inventory.assets);
        setInbox(nextInbox);
        setPresentation(structuredClone(savedPresentation));
        props.onMessage("Discarded staged PNG replacements and unsaved visual settings.");
      } catch (caught) {
        const message = errorMessage(caught);
        setError(message);
        props.onMessage(message);
      } finally {
        setBusy(false);
      }
    };

    useImperativeHandle(ref, () => ({
      save,
      revert,
      setPlayerHitGeometry,
      revertPlayerHitGeometry
    }), [busy, dirty, presentation, savedPresentation]);

    const replaceSelected = async (file: File): Promise<void> => {
      if (!selected || busy) return;
      setBusy(true);
      setError(null);
      try {
        await props.api.replaceRuntimeAsset(selected.id, file);
        const [inventory, nextInbox] = await Promise.all([
          props.api.loadRuntimeAssets(),
          props.api.loadRuntimeAssetInbox()
        ]);
        setAssets(inventory.assets);
        setInbox(nextInbox);
        props.onMessage(
          `Staged replacement for ${selected.relativeFile}. Save to Worktree to make it official.`
        );
      } catch (caught) {
        const message = errorMessage(caught);
        setError(message);
        props.onMessage(message);
      } finally {
        setBusy(false);
      }
    };

    const importInboxEntry = async (entry: RuntimeAssetInboxEntry): Promise<void> => {
      if (busy || entry.status !== "ready") return;
      setBusy(true);
      setError(null);
      try {
        await props.api.importRuntimeAssetFromInbox(entry.sourceFile);
        const [inventory, nextInbox] = await Promise.all([
          props.api.loadRuntimeAssets(),
          props.api.loadRuntimeAssetInbox()
        ]);
        setAssets(inventory.assets);
        setInbox(nextInbox);
        props.onMessage(
          `Staged ${entry.destinationFile} from AtlasPNGS. Save to Worktree to make it official.`
        );
      } catch (caught) {
        const message = errorMessage(caught);
        setError(message);
        props.onMessage(message);
      } finally {
        setBusy(false);
      }
    };

    const editSprite = (key: string, patch: Partial<RuntimeSpritePresentation>): void => {
      setPresentation((current) => {
        if (!current) return current;
        const baseHeightPx = patch.baseHeightPx ?? current.sprites[key]!.baseHeightPx;
        return {
          ...current,
          sprites: {
            ...current.sprites,
            [key]: {
              ...current.sprites[key]!,
              ...patch,
              minHeightPx: Number((baseHeightPx * current.worldObjectZoomPolicy.minScale).toFixed(6)),
              maxHeightPx: current.worldObjectZoomPolicy.maxScale === null
                ? null
                : Number((baseHeightPx * current.worldObjectZoomPolicy.maxScale).toFixed(6)),
              zoomStrength: current.worldObjectZoomPolicy.zoomStrength
            }
          }
        };
      });
    };
    const editFixed = (key: string, patch: Partial<RuntimeFixedPngPresentation>): void => {
      setPresentation((current) => current ? {
        ...current,
        fixed: {
          ...current.fixed,
          [key]: { ...current.fixed[key]!, ...patch }
        }
      } : current);
    };

    const targetSize = selectedSizingAsset && presentation
      ? previewSize(selectedSizingAsset, selectedUsage, presentation)
      : null;
    const sharedItemUsage = selected
      ? selected.usages.find((usage) => sharedItemPresentationKey(selected, usage) !== null) ?? null
      : null;
    const sharedItemKey = selected && sharedItemUsage
      ? sharedItemPresentationKey(selected, sharedItemUsage)
      : null;
    const sharedItemBaseHeightPx = presentation && sharedItemKey
      ? presentation.sprites[sharedItemKey]?.baseHeightPx ?? null
      : null;
    const itemPreviewTargetSize = selectedSizingAsset && presentation && sharedItemUsage
      ? previewSize(selectedSizingAsset, sharedItemUsage, presentation)
      : null;
    const manorFloorAsset = assets.find((asset) =>
      asset.relativeFile.replaceAll("\\", "/") === "apps/client/src/assets/structures/manor-floor.png" &&
      !asset.missing
    ) ?? null;
    useEffect(() => {
      setProportionsLocked(Boolean(
        selectedSizingAsset && targetSize && dimensionsMatchAspectRatio(
          targetSize.width,
          targetSize.height,
          selectedSizingAsset.width,
          selectedSizingAsset.height
        )
      ));
    }, [
      selectedId,
      selectedUsage?.id,
      selectedSizingAsset?.width,
      selectedSizingAsset?.height,
      Boolean(presentation)
    ]);
    const overlay = assets.find((asset) => asset.id === overlayId && !asset.missing) ?? null;
    const overlayUsage = overlay?.usages.find(isVisualEditor) ?? overlay?.usages[0] ?? null;
    const overlaySize = overlay && presentation
      ? previewSize(overlay, overlayUsage, presentation)
      : null;
    const previewFit = actualPixels || !targetSize
      ? 1
      : Math.min(1, 320 / Math.max(targetSize.width, targetSize.height));
    const previewScale = previewFit * zoom;
    const hasOverlayOffset = overlayOffset.x !== 0 || overlayOffset.y !== 0;
    const selectedUsageCaption = selectedUsage && targetSize?.hitGeometry
      ? `${selectedUsage.label}. Cyan is the production anchor; gold is the gameplay hit area and center.`
      : selectedUsage?.label ?? "Choose a usage to preview its production size.";
    const previewCaption = showOverlay && overlay
      ? `${selectedUsageCaption} ${overlay.label} is shown as a translucent comparison overlay. Drag it to compare placement; Reset position returns it to centered and bottom-aligned.`
      : selectedUsageCaption;

    const startOverlayDrag = (event: ReactPointerEvent<HTMLImageElement>): void => {
      if (event.button !== 0 || event.isPrimary === false) return;
      event.preventDefault();
      event.stopPropagation();
      event.currentTarget.setPointerCapture?.(event.pointerId);
      overlayDragRef.current = {
        pointerId: event.pointerId,
        clientX: event.clientX,
        clientY: event.clientY,
        offsetX: overlayOffset.x,
        offsetY: overlayOffset.y
      };
    };
    const moveOverlay = (event: ReactPointerEvent<HTMLImageElement>): void => {
      const drag = overlayDragRef.current;
      if (!drag || drag.pointerId !== event.pointerId || previewScale === 0) return;
      event.preventDefault();
      event.stopPropagation();
      setOverlayOffset({
        x: drag.offsetX + ((event.clientX - drag.clientX) / previewScale),
        y: drag.offsetY + ((event.clientY - drag.clientY) / previewScale)
      });
    };
    const endOverlayDrag = (event: ReactPointerEvent<HTMLImageElement>): void => {
      if (overlayDragRef.current?.pointerId !== event.pointerId) return;
      overlayDragRef.current = null;
      if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    };

    const updateAnchorFromPointer = (
      event: ReactPointerEvent<HTMLButtonElement>,
      editor: Extract<RuntimeAssetUsage["editor"], { kind: "sprite" | "fixed" | "world-object" }>
    ): void => {
      if (!props.writesAllowed) return;
      const imageFrame = event.currentTarget.parentElement;
      if (!imageFrame) return;
      event.currentTarget.setPointerCapture(event.pointerId);
      const bounds = imageFrame.getBoundingClientRect();
      const anchorX = clamp((event.clientX - bounds.left) / bounds.width, 0, 1);
      const anchorY = clamp((event.clientY - bounds.top) / bounds.height, 0, 1);
      if (editor.kind === "sprite") editSprite(editor.key, { anchorX, anchorY });
      else editFixed(editor.key, { anchorX, anchorY });
    };
    const updateHitCenterFromPointer = (
      event: ReactPointerEvent<HTMLButtonElement>,
      editor: Extract<RuntimeAssetUsage["editor"], { kind: "sprite" | "fixed" | "world-object" }>
    ): void => {
      if (!props.writesAllowed) return;
      if (
        editor.kind === "sprite" &&
        editor.key === sharedItemKey &&
        presentation?.sprites[editor.key]?.hitGeometryMode !== "custom"
      ) return;
      const imageFrame = event.currentTarget.parentElement;
      if (!imageFrame) return;
      event.stopPropagation();
      event.currentTarget.setPointerCapture(event.pointerId);
      const bounds = imageFrame.getBoundingClientRect();
      const hitGeometry = editor.kind === "sprite"
        ? presentation?.sprites[editor.key]?.hitGeometry
        : presentation?.fixed[editor.key]?.hitGeometry;
      if (!hitGeometry) return;
      const nextGeometry = {
        ...hitGeometry,
        centerX: clamp((event.clientX - bounds.left) / bounds.width, 0, 1),
        centerY: clamp((event.clientY - bounds.top) / bounds.height, 0, 1)
      };
      if (editor.kind === "sprite") editSprite(editor.key, { hitGeometry: nextGeometry });
      else editFixed(editor.key, { hitGeometry: nextGeometry });
    };

    if (!props.visible) return null;

    return (
      <section className="asset-studio" data-testid="assets-workspace" aria-label="Game PNG Asset Studio">
        <aside className="panel asset-library-panel" data-testid="assets-library">
          <div className="panel-title">
            <h2>Game PNG Library</h2>
            <div className="panel-title-actions">
              <span>{assets.length} PNGs</span>
              <button
                type="button"
                className="ghost"
                data-testid="assets-refresh"
                disabled={loading || busy || dirty}
                title={dirty ? "Save or revert changes before refreshing." : undefined}
                onClick={() => void load()}
              >Refresh PNGs</button>
            </div>
          </div>
          <p className="asset-discovery-copy">
            File &gt; Open Ash Atlas Worktree switches the branch/worktree and discovers its PNGs.
          </p>
          <label className="field">
            <span>Search</span>
            <input
              aria-label="Search game PNGs"
              data-testid="assets-search"
              placeholder="Name, path, or usage"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </label>
          <label className="field">
            <span>Category</span>
            <select value={category} data-testid="assets-category" onChange={(event) => setCategory(event.target.value)}>
              {categories.map((entry) => <option key={entry}>{entry}</option>)}
            </select>
          </label>
          <label className="toggle">
            <input
              type="checkbox"
              data-testid="assets-editable-only"
              checked={editableOnly}
              onChange={(event) => setEditableOnly(event.target.checked)}
            />
            <span>Official size / anchor editable</span>
          </label>
          <section className="asset-inbox" data-testid="assets-inbox" aria-label="AtlasPNGS source inbox">
            <div className="asset-inbox-heading">
              <strong>AtlasPNGS inbox</strong>
              <small>{inbox?.entries.length ?? 0} valid PNGs</small>
            </div>
            <p>
              Top-level PNGs from <code title={inbox?.sourceDirectory ?? "Documents/AtlasPNGS"}>{inbox?.sourceDirectory ?? "Documents/AtlasPNGS"}</code> appear here.
              Import one to stage it, then Save to Worktree.
            </p>
            {inbox && visibleInboxEntries.length === 0 ? (
              <small className="asset-inbox-empty">No inbox PNGs match this search.</small>
            ) : null}
            {visibleInboxEntries.map((entry) => (
              <div className={`asset-inbox-entry ${entry.status}`} key={entry.id} data-testid={`assets-inbox-entry-${entry.id}`}>
                <div>
                  <strong>{entry.label}</strong>
                  <small>{entry.sourceFile} · {entry.width}×{entry.height}</small>
                  <small>Target: {entry.destinationFile}</small>
                  {entry.statusReason ? <em>{entry.statusReason}</em> : null}
                </div>
                <button
                  type="button"
                  className="ghost"
                  data-testid={`assets-inbox-import-${entry.id}`}
                  disabled={busy || entry.status !== "ready"}
                  onClick={() => void importInboxEntry(entry)}
                >{inboxEntryActionLabel(entry.status)}</button>
              </div>
            ))}
          </section>
          <div className="asset-list" data-testid="assets-list" role="listbox" aria-label="Game PNGs">
            {loading ? <p className="empty-copy">Loading game PNG inventory…</p> : null}
            {!loading && visibleAssets.length === 0
              ? <p className="empty-copy">No PNGs match these filters.</p>
              : null}
            {visibleAssets.map((asset) => (
              <button
                key={asset.id}
                data-testid={`assets-item-${asset.id}`}
                type="button"
                role="option"
                aria-selected={asset.id === selected?.id}
                className={asset.id === selected?.id ? "selected" : ""}
                onClick={() => {
                  setSelectedId(asset.id);
                  setSelectedUsageId(defaultRuntimeAssetUsage(asset)?.id ?? null);
                }}
              >
                {asset.missing ? (
                  <span className="asset-missing-thumbnail" aria-hidden="true">MISSING</span>
                ) : (
                  <img
                    src={`${asset.imageUrl}?v=${asset.contentHash}`}
                    alt=""
                    loading="lazy"
                  />
                )}
                <span>
                  <strong>{asset.label}</strong>
                  <small>{asset.category}{asset.missing ? " · PNG needed" : ` · ${asset.width}×${asset.height}`}</small>
                  {asset.staged ? <em>Replacement staged</em> : null}
                  {asset.missing ? <em className="missing">Missing canonical slot</em> : null}
                </span>
              </button>
            ))}
          </div>
        </aside>

        <section className="panel asset-preview-panel" data-testid="assets-preview">
          <div className="preview-toolbar">
            <strong>PNG Playground</strong>
            <button type="button" onClick={() => setZoom((value) => clamp(value - 0.1, 0.25, 4))}>−</button>
            <span className="zoom-readout">{Math.round(zoom * 100)}%</span>
            <button type="button" onClick={() => setZoom((value) => clamp(value + 0.1, 0.25, 4))}>+</button>
            <label className="toggle">
              <input type="checkbox" checked={actualPixels} onChange={(event) => setActualPixels(event.target.checked)} />
              <span>Actual pixels</span>
            </label>
            <label className="toggle">
              <input type="checkbox" checked={showOverlay} onChange={(event) => setShowOverlay(event.target.checked)} />
              <span>Comparison overlay</span>
            </label>
          </div>
          {presentation ? (
            <section className="asset-master-scale" aria-label="World PNG Master Scale">
              <div>
                <strong>World PNG Master Scale</strong>
                <span>{presentation.masterScale.toFixed(2)}×</span>
              </div>
              <label>
                <span className="sr-only">World PNG Master Scale</span>
                <input
                  type="range"
                  aria-label="World PNG Master Scale"
                  min={RUNTIME_PNG_MASTER_SCALE_MIN}
                  max={RUNTIME_PNG_MASTER_SCALE_MAX}
                  step={RUNTIME_PNG_MASTER_SCALE_STEP}
                  value={presentation.masterScale}
                  disabled={busy || !props.writesAllowed}
                  onChange={(event) => setPresentation((current) => current ? {
                    ...current,
                    masterScale: Number(event.target.value)
                  } : current)}
                />
              </label>
              <label className="field compact">
                <span className="sr-only">World PNG Master Scale value</span>
                <input
                  type="number"
                  aria-label="World PNG Master Scale value"
                  min={RUNTIME_PNG_MASTER_SCALE_MIN}
                  max={RUNTIME_PNG_MASTER_SCALE_MAX}
                  step={RUNTIME_PNG_MASTER_SCALE_STEP}
                  value={presentation.masterScale}
                  disabled={busy || !props.writesAllowed}
                  onChange={(event) => {
                    const value = Number(event.target.value);
                    if (!Number.isFinite(value)) return;
                    setPresentation((current) => current ? {
                      ...current,
                      masterScale: clamp(
                        value,
                        RUNTIME_PNG_MASTER_SCALE_MIN,
                        RUNTIME_PNG_MASTER_SCALE_MAX
                      )
                    } : current);
                  }}
                />
              </label>
              <button
                type="button"
                className="quiet"
                disabled={busy || !props.writesAllowed || presentation.masterScale === 1}
                onClick={() => setPresentation((current) => current ? {
                  ...current,
                  masterScale: 1
                } : current)}
              >Reset to 1.00×</button>
              <label className="toggle asset-standardized-toggle">
                <input
                  type="checkbox"
                  checked={keepStandardized}
                  onChange={(event) => setKeepStandardized(event.target.checked)}
                />
                <span>Keep standardized</span>
              </label>
              <small>Shared PNG scale. Player and territory flag/buoy PNGs are excluded.</small>
            </section>
          ) : null}
          <div className="asset-overlay-picker">
            <label className="field">
              <span>Overlay any game PNG for size comparison</span>
              <select
                value={overlayId}
                onChange={(event) => {
                  setOverlayId(event.target.value);
                  if (event.target.value) setShowOverlay(true);
                }}
              >
                <option value="">None</option>
                {assets.filter((asset) => !asset.missing).map((asset) => (
                  <option key={asset.id} value={asset.id}>{asset.label} · {asset.category}</option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className="quiet asset-overlay-reset"
              disabled={!showOverlay || !overlay || !hasOverlayOffset}
              onClick={() => setOverlayOffset({ x: 0, y: 0 })}
            >Reset position</button>
          </div>
          <div className="asset-preview-checker">
            <div className="asset-ground-line" />
            {selected && targetSize ? (
              <div
                className="asset-target-frame"
                style={{
                  width: targetSize.width * previewScale,
                  height: targetSize.height * previewScale
                }}
              >
                {selected.missing ? (
                  <div className="asset-missing-preview" role="img" aria-label={`${selected.label} PNG is missing`}>
                    <strong>PNG MISSING</strong>
                    <span>Upload the exact canonical PNG to preview this slot.</span>
                  </div>
                ) : (
                  <img
                    className="asset-target-image"
                    src={`${selected.imageUrl}?v=${selected.contentHash}`}
                    alt={`${selected.label} preview`}
                  />
                )}
                {showOverlay && overlay && overlaySize ? (
                  <img
                    className="asset-comparison-image"
                    src={`${overlay.imageUrl}?v=${overlay.contentHash}`}
                    alt={`${overlay.label} comparison overlay`}
                    draggable={false}
                    title="Drag this translucent comparison overlay to compare placement."
                    style={{
                      width: overlaySize.width * previewScale,
                      height: overlaySize.height * previewScale,
                      transform: `translate(calc(-50% + ${overlayOffset.x * previewScale}px), ${overlayOffset.y * previewScale}px)`
                    }}
                    onPointerDown={startOverlayDrag}
                    onPointerMove={moveOverlay}
                    onPointerUp={endOverlayDrag}
                    onPointerCancel={endOverlayDrag}
                    onLostPointerCapture={() => {
                      overlayDragRef.current = null;
                    }}
                  />
                ) : null}
                {targetSize.hitGeometry ? (
                  <div
                    className={`asset-hit-outline ${targetSize.hitGeometry.shape}`}
                    aria-hidden="true"
                    style={hitOutlineStyle(targetSize.hitGeometry, previewScale)}
                  />
                ) : null}
                {targetSize.editor ? (
                  <>
                    <button
                      type="button"
                      className="asset-anchor-handle"
                      aria-label="Drag production anchor"
                      title="Drag to set the production anchor. The art stays still while you place it."
                      style={{
                        left: `${targetSize.anchorX * 100}%`,
                        top: `${targetSize.anchorY * 100}%`
                      }}
                      onPointerDown={(event) => updateAnchorFromPointer(event, targetSize.editor!)}
                      onPointerMove={(event) => {
                        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                          updateAnchorFromPointer(event, targetSize.editor!);
                        }
                      }}
                    />
                    {targetSize.hitGeometry ? (
                      <button
                        type="button"
                        className="asset-hit-center-handle"
                        aria-label="Drag hit center"
                        title="Drag to place the gameplay hit center."
                        style={{
                          left: `${targetSize.hitGeometry.centerX * 100}%`,
                          top: `${targetSize.hitGeometry.centerY * 100}%`
                        }}
                        onPointerDown={(event) => updateHitCenterFromPointer(event, targetSize.editor!)}
                        onPointerMove={(event) => {
                          if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                            updateHitCenterFromPointer(event, targetSize.editor!);
                          }
                        }}
                      />
                    ) : null}
                  </>
                ) : null}
              </div>
            ) : <p className="empty-copy asset-preview-empty">Select a PNG.</p>}
          </div>
          <div className="asset-preview-caption">
            {previewCaption}
          </div>
        </section>

        <aside className="panel asset-inspector-panel" data-testid="assets-inspector">
          {selected && presentation ? (
            <>
              <div className="panel-title">
                <h2>Inspector</h2>
                <span>{selected.staged ? "PNG staged" : selected.missing ? "Missing PNG slot" : "Production asset"}</span>
              </div>
              <div className="asset-identity">
                <strong>{selected.label}</strong>
                <code>{selected.relativeFile}</code>
                {selected.missing ? (
                  <span>No PNG exists at this canonical path.</span>
                ) : (
                  <>
                    <span>{selected.width}×{selected.height}px · {formatBytes(selected.bytes)}</span>
                    <span>SHA-256 {selected.contentHash.slice(0, 12)}</span>
                  </>
                )}
              </div>
              <input
                ref={replaceInputRef}
                type="file"
                accept="image/png,.png"
                hidden
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void replaceSelected(file);
                }}
              />
              <button
                type="button"
                className="wide"
                disabled={busy || !props.writesAllowed}
                onClick={() => {
                  if (!replaceInputRef.current) return;
                  replaceInputRef.current.value = "";
                  replaceInputRef.current.click();
                }}
              >{selected.missing ? "Add Exact PNG" : "Replace Exact PNG"}</button>
              <p className="asset-warning">
                Replacement keeps this path, so every listed usage updates together after save.
              </p>

              <div className="divider"><span>USAGES</span></div>
              <div className="asset-usage-tabs" role="tablist" aria-label="Production usages">
                {selected.usages.map((usage) => (
                  <button
                    key={usage.id}
                    type="button"
                    role="tab"
                    className={usage.id === selectedUsage?.id ? "active" : ""}
                    aria-selected={usage.id === selectedUsage?.id}
                    onClick={() => setSelectedUsageId(usage.id)}
                  >{usage.label}</button>
                ))}
              </div>
              {selectedUsage ? (
                <UsageEditor
                  usage={selectedUsage}
                  presentation={presentation}
                  itemPresentationKey={sharedItemKey}
                  intrinsicWidth={selectedSizingAsset?.width ?? selected.width}
                  intrinsicHeight={selectedSizingAsset?.height ?? selected.height}
                  proportionsLocked={proportionsLocked}
                  keepStandardized={keepStandardized}
                  disabled={busy || !props.writesAllowed}
                  onEditSprite={editSprite}
                  onEditFixed={editFixed}
                  onProportionsLockedChange={setProportionsLocked}
                  onOpenAppearance={props.onOpenAppearance}
                />
              ) : null}
              {itemPreviewTargetSize && sharedItemKey && sharedItemBaseHeightPx !== null ? (
                <>
                  <p className="asset-item-authority-note" role="note">
                    <strong>Permanent item-size owner: Appearance Studio → Game PNGs.</strong>{" "}
                    Inventory/menu size and ground-drop size are saved in the runtime presentation catalog; the same ground size is shared by outdoor, Manor, and dungeon drops.
                  </p>
                  <ItemDisplayPreview
                    asset={selected}
                    targetSize={itemPreviewTargetSize}
                    draftGroundHeightPx={sharedItemBaseHeightPx}
                    draftInventoryHeightPx={presentation.sprites[sharedItemKey]?.inventoryHeightPx ?? sharedItemBaseHeightPx}
                    manorFloorAsset={manorFloorAsset}
                  />
                </>
              ) : null}
              {error ? <p className="connection-error" role="alert">{error}</p> : null}
            </>
          ) : (
            <p className="empty-copy">{error ?? "Select a PNG to inspect it."}</p>
          )}
        </aside>
      </section>
    );
  }
);

type ItemPreviewMode = "phone_portrait" | "desktop";

function ItemDisplayPreview(props: {
  asset: RuntimeAsset;
  targetSize: ReturnType<typeof previewSize>;
  draftGroundHeightPx: number;
  draftInventoryHeightPx: number;
  manorFloorAsset: RuntimeAsset | null;
}) {
  const [mode, setMode] = useState<ItemPreviewMode>("phone_portrait");
  const [companionRoot, setCompanionRoot] = useState<HTMLElement | null>(null);
  const companionWindowRef = useRef<Window | null>(null);
  const companionRootRef = useRef<HTMLElement | null>(null);
  const [companionError, setCompanionError] = useState<string | null>(null);

  const closeCompanion = (): void => {
    const companion = companionWindowRef.current;
    companionWindowRef.current = null;
    companionRootRef.current = null;
    setCompanionRoot(null);
    if (companion && !companion.closed) companion.close();
  };

  useEffect(() => () => {
    const companion = companionWindowRef.current;
    companionWindowRef.current = null;
    companionRootRef.current = null;
    if (companion && !companion.closed) companion.close();
  }, []);

  useEffect(() => {
    if (!companionRoot) return;
    const timer = window.setInterval(() => {
      const companion = companionWindowRef.current;
      if (companion?.closed) {
        companionWindowRef.current = null;
        companionRootRef.current = null;
        setCompanionRoot(null);
      }
    }, 500);
    return () => window.clearInterval(timer);
  }, [companionRoot]);

  const openCompanion = (): void => {
    if (typeof window === "undefined") return;
    const existing = companionWindowRef.current;
    if (existing && !existing.closed) {
      existing.focus();
      return;
    }
    const companion = window.open(
      "",
      "ash-atlas-item-display-preview",
      "popup=yes,width=1200,height=900,resizable=yes,scrollbars=yes"
    );
    if (!companion) {
      setCompanionError("Large preview could not open. Allow pop-ups for Appearance Studio and try again.");
      return;
    }
    try {
      setCompanionError(null);
      const documentRoot = companion.document;
      documentRoot.title = `${props.asset.label} · item display preview`;
      documentRoot.head.querySelectorAll("meta[data-appearance-studio-preview]").forEach((node) => node.remove());
      const viewport = documentRoot.createElement("meta");
      viewport.name = "viewport";
      viewport.content = "width=device-width, initial-scale=1";
      viewport.dataset.appearanceStudioPreview = "true";
      documentRoot.head.appendChild(viewport);
      documentRoot.head.querySelectorAll("link[data-appearance-studio-preview], style[data-appearance-studio-preview]").forEach((node) => node.remove());
      document.querySelectorAll("link[rel='stylesheet'], style").forEach((source) => {
        const clone = source.cloneNode(true) as HTMLLinkElement | HTMLStyleElement;
        clone.dataset.appearanceStudioPreview = "true";
        if (clone instanceof HTMLLinkElement) clone.href = source instanceof HTMLLinkElement ? source.href : clone.getAttribute("href") ?? "";
        documentRoot.head.appendChild(clone);
      });
      const root = documentRoot.createElement("main");
      root.className = "appearance-studio-item-preview-popup-root";
      documentRoot.body.replaceChildren(root);
      documentRoot.body.style.margin = "0";
      documentRoot.body.style.minWidth = "0";
      documentRoot.body.style.minHeight = "100vh";
      documentRoot.body.style.background = "#070d16";
      companionWindowRef.current = companion;
      companionRootRef.current = root;
      setCompanionRoot(root);
      companion.focus();
    } catch (caught) {
      if (!companion.closed) companion.close();
      setCompanionError(`Large preview could not open: ${errorMessage(caught)}`);
    }
  };

  const manorPlayerPositionSource = useMemo(() => ({
    render: () => MANOR_MAIN_ROOM.spawn
  }), []);
  const groundHeightPx = props.draftGroundHeightPx;
  const inventoryHeightPx = props.draftInventoryHeightPx;

  const preset = DUNGEON_WALK_TEST_PRESETS[mode];
  const inventoryScale = inventoryHeightPx / RUNTIME_PNG_ITEM_DEFAULT_HEIGHT_PX;
  const groundScale = groundHeightPx / RUNTIME_PNG_ITEM_DEFAULT_HEIGHT_PX;
  const groundVisualHeight = runtimePngItemGroundVisualHeight(
    groundHeightPx,
    MANOR_PLAYER_VISUAL_HEIGHT_UNITS
  );
  const inventoryArtworkFrame = RUNTIME_PNG_ITEM_INVENTORY_FRAME_PX;
  const itemSource = props.asset.missing
    ? null
    : `${props.asset.imageUrl}?v=${props.asset.contentHash}`;
  const image = (className: string, alt: string, style?: CSSProperties): React.JSX.Element =>
    itemSource ? (
      <img
        className={className}
        src={itemSource}
        alt={alt}
        style={style}
        draggable={false}
      />
    ) : (
      <span className={`${className} item-display-preview-missing`} role="img" aria-label={`${props.asset.label} PNG missing`}>
        PNG missing
      </span>
    );

  const inventoryArtworkStyle = {
    "--item-artwork-scale": inventoryScale,
    transform: `scale(${inventoryScale})`
  } as CSSProperties;
  const groundArtworkStyle = {
    "--item-artwork-scale": 1
  } as CSSProperties;
  const manorFloorSource = props.manorFloorAsset
    ? `${props.manorFloorAsset.imageUrl}?v=${props.manorFloorAsset.contentHash}`
    : null;

  return <>
    <ItemDisplayPreviewContent
      asset={props.asset}
      targetSize={props.targetSize}
      mode={mode}
      onModeChange={setMode}
      large={false}
      preset={preset}
      groundHeightPx={groundHeightPx}
      inventoryHeightPx={inventoryHeightPx}
      groundScale={groundScale}
      inventoryScale={inventoryScale}
      groundVisualHeight={groundVisualHeight}
      inventoryArtworkFrame={inventoryArtworkFrame}
      inventoryArtworkStyle={inventoryArtworkStyle}
      groundArtworkStyle={groundArtworkStyle}
      manorFloorSource={manorFloorSource}
      manorPlayerPositionSource={manorPlayerPositionSource}
      image={image}
      onOpenLargePreview={openCompanion}
      companionError={companionError}
    />
    {companionRoot ? createPortal(
      <ItemDisplayPreviewContent
        asset={props.asset}
        targetSize={props.targetSize}
        mode={mode}
        onModeChange={setMode}
        large
        preset={preset}
        groundHeightPx={groundHeightPx}
        inventoryHeightPx={inventoryHeightPx}
        groundScale={groundScale}
        inventoryScale={inventoryScale}
        groundVisualHeight={groundVisualHeight}
        inventoryArtworkFrame={inventoryArtworkFrame}
        inventoryArtworkStyle={inventoryArtworkStyle}
        groundArtworkStyle={groundArtworkStyle}
        manorFloorSource={manorFloorSource}
        manorPlayerPositionSource={manorPlayerPositionSource}
        image={image}
        onOpenLargePreview={closeCompanion}
        companionError={null}
      />,
      companionRoot
    ) : null}
  </>;
}

function ItemDisplayPreviewContent(props: {
  asset: RuntimeAsset;
  targetSize: ReturnType<typeof previewSize>;
  mode: ItemPreviewMode;
  onModeChange(mode: ItemPreviewMode): void;
  large: boolean;
  preset: (typeof DUNGEON_WALK_TEST_PRESETS)[ItemPreviewMode];
  groundHeightPx: number;
  inventoryHeightPx: number;
  groundScale: number;
  inventoryScale: number;
  groundVisualHeight: number;
  inventoryArtworkFrame: number;
  inventoryArtworkStyle: CSSProperties;
  groundArtworkStyle: CSSProperties;
  manorFloorSource: string | null;
  manorPlayerPositionSource: { render: () => typeof MANOR_MAIN_ROOM.spawn };
  image: (className: string, alt: string, style?: CSSProperties) => React.JSX.Element;
  onOpenLargePreview(): void;
  companionError: string | null;
}) {
  const {
    asset,
    targetSize,
    mode,
    onModeChange,
    large,
    preset,
    groundHeightPx,
    inventoryHeightPx,
    groundScale,
    inventoryScale,
    groundVisualHeight,
    inventoryArtworkFrame,
    inventoryArtworkStyle,
    groundArtworkStyle,
    manorFloorSource,
    manorPlayerPositionSource,
    image,
    onOpenLargePreview,
    companionError
  } = props;
  return (
    <section
      className={`item-display-preview${large ? " item-display-preview--large" : ""}`}
      aria-label="Permanent shared item-size preview"
      data-testid={large ? "item-display-preview-large" : "item-display-preview"}
      data-draft-ground-height-px={groundHeightPx}
      data-draft-inventory-height-px={inventoryHeightPx}
      data-ground-visual-height={groundVisualHeight}
      data-inventory-artwork-scale={inventoryScale}
    >
      <div className="item-display-preview-heading">
        <div>
          <strong>{large ? "Large live item-size preview" : "Permanent shared item-size preview"}</strong>
          <small>{large
            ? "Resizable companion view. It mirrors the unsaved Game PNGs draft; close it when finished."
            : "Live draft examples from the Game PNGs inspector. Save to Worktree publishes both permanent item sizes."}</small>
        </div>
        <div className="item-display-preview-actions">
          {!large ? <div className="segmented" role="tablist" aria-label="Item preview device">
            <button
              type="button"
              role="tab"
              aria-selected={mode === "phone_portrait"}
              className={mode === "phone_portrait" ? "active" : ""}
              onClick={() => onModeChange("phone_portrait")}
            >Phone</button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === "desktop"}
              className={mode === "desktop" ? "active" : ""}
              onClick={() => onModeChange("desktop")}
            >Desktop</button>
          </div> : null}
          <button type="button" className="item-display-preview-large-button" onClick={onOpenLargePreview}>
            {large ? "Close large preview" : "Open large preview"}
          </button>
        </div>
      </div>
      <div
        className={`item-display-preview-device ${mode}`}
        data-testid="item-display-preview-device"
      >
        <div className="item-display-preview-device-bar">
          <strong>{preset.label}</strong>
          <small>{preset.playableWidthPx} × {preset.playableHeightPx} playable px</small>
        </div>
        <div className="item-display-preview-contexts">
          <article className="item-display-preview-context item-display-preview-manor-context" aria-label="Manor floor context">
            <header>
              <strong>Manor floor drop</strong>
              <small>{groundVisualHeight.toFixed(1)}-unit player-relative ground frame · {Math.round(MANOR_PLAYER_VISUAL_HEIGHT_UNITS)}-unit canonical player reference</small>
            </header>
            <div className="item-display-preview-manor-room" data-manor-room-width={MANOR_MAIN_ROOM.roomWidth} data-manor-room-height={MANOR_MAIN_ROOM.roomHeight}>
              {manorFloorSource ? <img className="item-display-preview-manor-floor" src={manorFloorSource} alt="" draggable={false} /> : <span className="item-display-preview-manor-floor-fallback">Manor Lobby floor</span>}
              <div className="item-display-preview-manor-player-reference" data-testid="item-display-preview-manor-player" data-player-model="PlayerRenderer">
                <IndoorPlayerLayer
                  roomWidth={MANOR_MAIN_ROOM.roomWidth}
                  roomHeight={MANOR_MAIN_ROOM.roomHeight}
                  playerVisualHeightUnits={MANOR_PLAYER_VISUAL_HEIGHT_UNITS}
                  positionSource={manorPlayerPositionSource}
                  displayColor="#48c8de"
                  className="item-display-preview-manor-player-layer"
                  canvasClassName="item-display-preview-manor-player-canvas"
                  ariaLabel="Canonical Manor player reference"
                />
                <span
                  className="item-display-preview-manor-player-label"
                  style={{
                    left: `${MANOR_MAIN_ROOM.spawn.x / MANOR_MAIN_ROOM.roomWidth * 100}%`,
                    top: `${MANOR_MAIN_ROOM.spawn.y / MANOR_MAIN_ROOM.roomHeight * 100}%`
                  }}
                >Player reference</span>
              </div>
              <span className="item-display-preview-manor-drop" data-testid="item-display-preview-manor-drop" data-ground-frame={groundVisualHeight} style={{ width: groundVisualHeight, height: groundVisualHeight }}>
                {image(
                  "item-display-preview-artwork item-display-preview-manor-art",
                  `${asset.label} Manor floor preview`,
                  groundArtworkStyle
                )}
                <span className="item-display-preview-manor-quantity">×24</span>
              </span>
              <span className="item-display-preview-manor-location" aria-hidden="true">MANOR LOBBY · FLOOR</span>
            </div>
            <small>Production `ManorScene`, outdoor world drops, and dungeon use this same player-relative ground frame. The canonical `PlayerRenderer` reference is the current Manor model; there is no Manor-specific item size.</small>
          </article>
          <article className="item-display-preview-context item-display-preview-inventory-context" aria-label="Inventory row context">
            <header>
              <strong>Inventory / menu row</strong>
              <small>{inventoryArtworkFrame}px mobile-standard item frame · {inventoryScale.toFixed(2)}× authored inventory size</small>
            </header>
            <div className="item-display-preview-inventory-list">
              <div className="item-display-preview-inventory-row" data-testid="item-display-preview-inventory-row" data-inventory-frame={inventoryArtworkFrame}>
                <span className="item-display-preview-inventory-art-frame">
                  {image(
                    "item-display-preview-artwork item-display-preview-inventory-art",
                    `${asset.label} inventory preview`,
                    inventoryArtworkStyle
                  )}
                </span>
                <span className="item-display-preview-inventory-copy"><strong>{asset.label}</strong><small>Crafting material · ready to use</small></span>
                <span className="item-display-preview-inventory-quantity">×24</span>
                <span className="item-display-preview-inventory-weight">1.2<small> kg</small></span>
                <span className="item-display-preview-inventory-chevron" aria-hidden="true">›</span>
              </div>
              <div className="item-display-preview-inventory-row item-display-preview-inventory-row-secondary" aria-hidden="true">
                <span className="item-display-preview-inventory-art-frame item-display-preview-inventory-art-frame-empty" />
                <span className="item-display-preview-inventory-copy"><strong>Wood</strong><small>Gathered resource</small></span>
                <span className="item-display-preview-inventory-quantity">×437</span>
                <span className="item-display-preview-inventory-weight">437<small> kg</small></span>
                <span className="item-display-preview-inventory-chevron">›</span>
              </div>
            </div>
            <small>Production `InventoryEntryRow` uses this mobile-standard row geometry on Phone and Desktop; the 34px frame makes clipping or undersizing obvious while the authored inventory size stays one cross-device value.</small>
          </article>
        </div>
      </div>
      <small className="item-display-preview-caption">
        Draft inventory/menu size {inventoryHeightPx}px ({inventoryScale.toFixed(2)}×) · ground-drop size {groundHeightPx}px ({groundScale.toFixed(2)}×; {groundVisualHeight.toFixed(1)} indoor units) · `previewSize` reports {Math.round(targetSize.width * 100) / 100} × {Math.round(targetSize.height * 100) / 100}px for the selected PNG. Phone and Desktop share the same 34px inventory frame; outdoor, Manor, and dungeon share the same player-relative ground contract. Both previews update from unsaved edits; Save to Worktree is the permanent publish step and there are no device-specific values.
      </small>
      {companionError ? <small className="item-display-preview-error" role="alert">{companionError}</small> : null}
    </section>
  );
}

function UsageEditor(props: {
  usage: RuntimeAssetUsage;
  presentation: RuntimePngPresentationCatalog;
  itemPresentationKey: string | null;
  intrinsicWidth: number;
  intrinsicHeight: number;
  proportionsLocked: boolean;
  keepStandardized: boolean;
  disabled: boolean;
  onEditSprite(key: string, patch: Partial<RuntimeSpritePresentation>): void;
  onEditFixed(key: string, patch: Partial<RuntimeFixedPngPresentation>): void;
  onProportionsLockedChange(locked: boolean): void;
  onOpenAppearance(domain: "player" | "boss"): void;
}) {
  const { editor } = props.usage;
  if (editor.kind === "appearance") {
    return (
      <div className="asset-usage-editor">
        <p>{props.usage.context}</p>
        <button type="button" className="primary wide" onClick={() => props.onOpenAppearance(editor.domain)}>
          Open in {editor.domain === "player" ? "Player Appearance" : "Boss Studio"}
        </button>
      </div>
    );
  }
  if (editor.kind === "readonly") {
    return (
      <div className="asset-usage-editor">
        <p>{props.usage.context}</p>
        <strong>Replacement is available. Size is read-only here.</strong>
        <small>{editor.reason}</small>
      </div>
    );
  }
  if (editor.kind === "sprite") {
    const value = props.presentation.sprites[editor.key];
    if (!value) return <p className="connection-error">Missing production presentation {editor.key}.</p>;
    const isSharedItem = editor.key === props.itemPresentationKey;
    const itemHitboxLocked = isSharedItem && value.hitGeometryMode !== "custom";
    const rawDimensions = spriteEditorDimensions(
      value,
      props.intrinsicWidth,
      props.intrinsicHeight
    );
    const standardized = props.keepStandardized &&
      isRuntimePngMasterScaleEligible("sprite", editor.key);
    const dimensionScale = standardized ? props.presentation.masterScale : 1;
    const dimensions = {
      width: standardized
        ? normalizePngDimension(rawDimensions.width * dimensionScale)
        : rawDimensions.width,
      height: standardized
        ? normalizePngDimension(rawDimensions.height * dimensionScale)
        : rawDimensions.height
    };
    const dimensionMinimum = standardized ? dimensionScale : 1;
    const dimensionLabelSuffix = standardized ? "final px" : "px";
    const setLocked = (locked: boolean): void => {
      props.onProportionsLockedChange(locked);
      if (locked) props.onEditSprite(editor.key, { horizontalScale: 1 });
    };
    return (
      <div className="asset-usage-editor">
        <p>{props.usage.context}</p>
        <GeometryGuidance />
        {isSharedItem ? (
          <div className="asset-item-editor-sections">
            <section className="asset-item-editor-section" aria-label="Drop Size">
              <h4>Drop Size</h4>
              <small>Ground-drop visual frame shared by outdoor, Manor, and dungeon scenes.</small>
              <div className="field-grid">
                <AssetNumberField label={`Width (${dimensionLabelSuffix})`} value={dimensions.width} min={dimensionMinimum} disabled={props.disabled} onChange={(width) => props.onEditSprite(editor.key, spriteDimensionPatch("width", standardized ? normalizePngDimension(width / dimensionScale) : width, rawDimensions, props.intrinsicWidth, props.intrinsicHeight, props.proportionsLocked))} />
                <AssetNumberField label={`Ground-drop size (${dimensionLabelSuffix})`} value={dimensions.height} min={dimensionMinimum} disabled={props.disabled} onChange={(height) => props.onEditSprite(editor.key, spriteDimensionPatch("height", standardized ? normalizePngDimension(height / dimensionScale) : height, rawDimensions, props.intrinsicWidth, props.intrinsicHeight, props.proportionsLocked))} />
                <label className="toggle"><input type="checkbox" checked={props.proportionsLocked} disabled={props.disabled} onChange={(event) => setLocked(event.target.checked)} /><span>Lock proportions</span></label>
              </div>
            </section>
            <section className="asset-item-editor-section" aria-label="PNG / Inventory Size">
              <h4>PNG / Inventory Size</h4>
              <div className="field-grid">
                <AssetNumberField
                  label="Inventory/menu artwork size (px)"
                  value={value.inventoryHeightPx ?? value.baseHeightPx}
                  min={0.1}
                  max={2048}
                  step={0.1}
                  disabled={props.disabled}
                  onChange={(inventoryHeightPx) => props.onEditSprite(editor.key, { inventoryHeightPx })}
                />
              </div>
              <small>Phone and Desktop use the same mobile-standard inventory frame; this authored value is independent from Drop Size.</small>
            </section>
            <section className="asset-item-editor-section" aria-label="Anchor / Placement">
              <h4>Anchor / Placement</h4>
              <div className="field-grid">
                <AssetNumberField label="Anchor X" value={value.anchorX} min={0} max={1} step={0.001} disabled={props.disabled} onChange={(anchorX) => props.onEditSprite(editor.key, { anchorX })} />
                <AssetNumberField label="Anchor Y" value={value.anchorY} min={0} max={1} step={0.001} disabled={props.disabled} onChange={(anchorY) => props.onEditSprite(editor.key, { anchorY })} />
              </div>
            </section>
            <section className="asset-item-editor-section" aria-label="Tap Area / Hitbox">
              <h4>Tap Area / Hitbox</h4>
              <label className="toggle asset-item-hitbox-lock">
                <input
                  type="checkbox"
                  checked={itemHitboxLocked}
                  disabled={props.disabled}
                  onChange={(event) => props.onEditSprite(editor.key, event.target.checked
                    ? {
                        hitGeometryMode: "locked",
                        hitGeometry: {
                          shape: "rectangle",
                          centerX: 0.5,
                          centerY: 0.5,
                          width: 1,
                          height: 1
                        }
                      }
                    : { hitGeometryMode: "custom" })}
                />
                <span>Lock hitbox to ground size</span>
              </label>
              <div className="field-grid">
                <HitGeometryFields
                  value={runtimePngItemGroundHitGeometry(value)}
                  disabled={props.disabled || itemHitboxLocked}
                  onChange={(hitGeometry) => props.onEditSprite(editor.key, {
                    hitGeometry,
                    hitGeometryMode: "custom"
                  })}
                />
              </div>
              <small>Locked uses the normalized ground visual frame. Unlock to author a custom tap area.</small>
            </section>
          </div>
        ) : (
          <div className="field-grid">
            <AssetNumberField label={`Width (${dimensionLabelSuffix})`} value={dimensions.width} min={dimensionMinimum} disabled={props.disabled} onChange={(width) => props.onEditSprite(editor.key, spriteDimensionPatch("width", standardized ? normalizePngDimension(width / dimensionScale) : width, rawDimensions, props.intrinsicWidth, props.intrinsicHeight, props.proportionsLocked))} />
            <AssetNumberField label={`Height (${dimensionLabelSuffix})`} value={dimensions.height} min={dimensionMinimum} disabled={props.disabled} onChange={(height) => props.onEditSprite(editor.key, spriteDimensionPatch("height", standardized ? normalizePngDimension(height / dimensionScale) : height, rawDimensions, props.intrinsicWidth, props.intrinsicHeight, props.proportionsLocked))} />
            <label className="toggle"><input type="checkbox" checked={props.proportionsLocked} disabled={props.disabled} onChange={(event) => setLocked(event.target.checked)} /><span>Lock proportions</span></label>
            <AssetNumberField label="Anchor X" value={value.anchorX} min={0} max={1} step={0.001} disabled={props.disabled} onChange={(anchorX) => props.onEditSprite(editor.key, { anchorX })} />
            <AssetNumberField label="Anchor Y" value={value.anchorY} min={0} max={1} step={0.001} disabled={props.disabled} onChange={(anchorY) => props.onEditSprite(editor.key, { anchorY })} />
            <HitGeometryFields
              value={value.hitGeometry}
              disabled={props.disabled}
              onChange={(hitGeometry) => props.onEditSprite(editor.key, { hitGeometry })}
            />
          </div>
        )}
        <small aria-label="World object zoom policy">
          Shared zoom: 5% growth per +0.1 zoom; {Math.round(props.presentation.worldObjectZoomPolicy.minScale * 100)}% minimum floor; {props.presentation.worldObjectZoomPolicy.maxScale === null ? "no upper cap" : `${Math.round(props.presentation.worldObjectZoomPolicy.maxScale * 100)}% maximum`}.
        </small>
        <small>{isSharedItem ? "Ground-drop size is the player-relative visual frame shared by outdoor, Manor, and dungeon. Inventory/menu artwork has its own authored size; Phone and Desktop use the same mobile-standard frame." : "Hit center uses normalized PNG coordinates; rectangle size is a frame proportion."}</small>
      </div>
    );
  }
  const isWorldObject = editor.kind === "world-object";
  const value = props.presentation.fixed[editor.key];
  if (!value) return <p className="connection-error">Missing production presentation {editor.key}.</p>;
  const standardized = props.keepStandardized &&
    isRuntimePngMasterScaleEligible("fixed", editor.key);
  const dimensionScale = standardized ? props.presentation.masterScale : 1;
  const dimensionMinimum = standardized ? dimensionScale : 1;
  const dimensionLabelSuffix = standardized ? "final px" : "px";
  return (
    <div className="asset-usage-editor">
      <p>{props.usage.context}</p>
      <GeometryGuidance />
      <div className="field-grid">
        <AssetNumberField label={`Width (${dimensionLabelSuffix})`} value={standardized ? normalizePngDimension(value.width * dimensionScale) : value.width} min={dimensionMinimum} disabled={props.disabled} onChange={(width) => props.onEditFixed(editor.key, fixedDimensionPatch("width", standardized ? normalizePngDimension(width / dimensionScale) : width, props.intrinsicWidth, props.intrinsicHeight, props.proportionsLocked))} />
        <AssetNumberField label={`Height (${dimensionLabelSuffix})`} value={standardized ? normalizePngDimension(value.height * dimensionScale) : value.height} min={dimensionMinimum} disabled={props.disabled} onChange={(height) => props.onEditFixed(editor.key, fixedDimensionPatch("height", standardized ? normalizePngDimension(height / dimensionScale) : height, props.intrinsicWidth, props.intrinsicHeight, props.proportionsLocked))} />
        <label className="toggle"><input type="checkbox" checked={props.proportionsLocked} disabled={props.disabled} onChange={(event) => {
          const locked = event.target.checked;
          props.onProportionsLockedChange(locked);
          if (locked) props.onEditFixed(editor.key, fixedDimensionPatch("height", value.height, props.intrinsicWidth, props.intrinsicHeight, true));
        }} /><span>Lock proportions</span></label>
        <AssetNumberField label="Anchor X" value={value.anchorX} min={0} max={1} step={0.001} disabled={props.disabled} onChange={(anchorX) => props.onEditFixed(editor.key, { anchorX })} />
        <AssetNumberField label="Anchor Y" value={value.anchorY} min={0} max={1} step={0.001} disabled={props.disabled} onChange={(anchorY) => props.onEditFixed(editor.key, { anchorY })} />
        <HitGeometryFields
          value={value.hitGeometry}
          disabled={props.disabled}
          onChange={(hitGeometry) => props.onEditFixed(editor.key, { hitGeometry })}
        />
      </div>
      {isWorldObject ? (
        <small aria-label="World object zoom policy">
          Shared map zoom: 5% growth per +0.1 zoom; {Math.round(props.presentation.worldObjectZoomPolicy.minScale * 100)}% minimum floor; {props.presentation.worldObjectZoomPolicy.maxScale === null ? "no upper cap" : `${Math.round(props.presentation.worldObjectZoomPolicy.maxScale * 100)}% maximum`}.
        </small>
      ) : null}
      <small>Hit center uses normalized PNG coordinates; rectangle size is a frame proportion.</small>
    </div>
  );
}

function GeometryGuidance() {
  return (
    <p className="asset-geometry-guidance">
      <strong>Cyan anchor:</strong> the point on the PNG attached to the object&apos;s map position,
      usually the ground/contact point. <strong>Gold hit/clickable area:</strong> where click/tap
      selects the object; it does not change the art. These controls are independent and may
      overlap. Drag the cyan ring to move the anchor; drag the gold diamond to move the hit center.
    </p>
  );
}

export function HitGeometryFields(props: {
  value: RuntimePngInteractionGeometry;
  disabled: boolean;
  centerMin?: number;
  centerMax?: number;
  onChange(value: RuntimePngInteractionGeometry): void;
}) {
  return (
    <>
      <label className="field compact">
        <span>Hit shape</span>
        <select
          value={props.value.shape}
          disabled={props.disabled}
          onChange={(event) => {
            const { centerX, centerY } = props.value;
            props.onChange(event.target.value === "circle"
              ? { shape: "circle", centerX, centerY, radiusPx: 24 }
              : { shape: "rectangle", centerX, centerY, width: 1, height: 1 });
          }}
        >
          <option value="circle">Circle</option>
          <option value="rectangle">Rectangle</option>
        </select>
      </label>
      <AssetNumberField label="Hit center X" value={props.value.centerX} min={props.centerMin ?? -1} max={props.centerMax ?? 2} step={0.001} disabled={props.disabled} onChange={(centerX) => props.onChange({ ...props.value, centerX })} />
      <AssetNumberField label="Hit center Y" value={props.value.centerY} min={props.centerMin ?? -1} max={props.centerMax ?? 2} step={0.001} disabled={props.disabled} onChange={(centerY) => props.onChange({ ...props.value, centerY })} />
      {props.value.shape === "circle" ? (
        <AssetNumberField label="Hit radius (px)" value={props.value.radiusPx} min={0.1} max={512} disabled={props.disabled} onChange={(radiusPx) => {
          if (props.value.shape === "circle") props.onChange({ ...props.value, radiusPx });
        }} />
      ) : (
        <>
          <AssetNumberField label="Hit width (frame)" value={props.value.width} min={0.001} max={4} step={0.001} disabled={props.disabled} onChange={(width) => {
            if (props.value.shape === "rectangle") props.onChange({ ...props.value, width });
          }} />
          <AssetNumberField label="Hit height (frame)" value={props.value.height} min={0.001} max={4} step={0.001} disabled={props.disabled} onChange={(height) => {
            if (props.value.shape === "rectangle") props.onChange({ ...props.value, height });
          }} />
        </>
      )}
    </>
  );
}

function AssetNumberField(props: {
  label: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
  onChange?(value: number): void;
}) {
  return (
    <label className="field compact">
      <span>{props.label}</span>
      <input
        type="number"
        value={props.value}
        min={props.min}
        max={props.max}
        step={props.step ?? 0.1}
        disabled={props.disabled}
        onChange={(event) => {
          const value = Number(event.target.value);
          if (Number.isFinite(value)) props.onChange?.(value);
        }}
      />
    </label>
  );
}

export function previewSize(
  asset: RuntimeAsset,
  usage: RuntimeAssetUsage | null,
  presentation: RuntimePngPresentationCatalog
): { width: number; height: number; anchorX: number; anchorY: number; hitGeometry: RuntimePngInteractionGeometry | null; editor: Extract<RuntimeAssetUsage["editor"], { kind: "sprite" | "fixed" | "world-object" }> | null } {
  const editor = usage?.editor;
  if (editor?.kind === "sprite") {
    const value = presentation.sprites[editor.key];
    if (value) {
      const masterScale = isRuntimePngMasterScaleEligible("sprite", editor.key)
        ? presentation.masterScale
        : 1;
      return {
        width: value.baseHeightPx * intrinsicAspectRatio(asset.width, asset.height) *
          (value.horizontalScale ?? 1) * masterScale,
        height: value.baseHeightPx * masterScale,
        anchorX: value.anchorX,
        anchorY: value.anchorY,
        hitGeometry: (() => {
          const hitGeometry = runtimePngItemPresentation(editor.key)
            ? runtimePngItemGroundHitGeometry(value)
            : value.hitGeometry;
          return hitGeometry.shape === "circle"
            ? { ...hitGeometry, radiusPx: hitGeometry.radiusPx * masterScale }
            : hitGeometry;
        })(),
        editor
      };
    }
  }
  if (editor?.kind === "fixed" || editor?.kind === "world-object") {
    const value = presentation.fixed[editor.key];
    if (value) {
      const masterScale = isRuntimePngMasterScaleEligible("fixed", editor.key)
        ? presentation.masterScale
        : 1;
      return {
        ...value,
        width: value.width * masterScale,
        height: value.height * masterScale,
        hitGeometry: value.hitGeometry.shape === "circle"
          ? { ...value.hitGeometry, radiusPx: value.hitGeometry.radiusPx * masterScale }
          : value.hitGeometry,
        editor
      };
    }
  }
  return {
    // Registered slots without art still need a visible placeholder frame so
    // the canonical upload action is discoverable for readonly hooks.
    width: asset.width > 0 ? asset.width : 128,
    height: asset.height > 0 ? asset.height : 128,
    anchorX: 0.5,
    anchorY: 0.5,
    hitGeometry: null,
    editor: null
  };
}

function hitOutlineStyle(
  geometry: RuntimePngInteractionGeometry,
  previewScale: number
): CSSProperties {
  const common = {
    left: `${geometry.centerX * 100}%`,
    top: `${geometry.centerY * 100}%`
  };
  return geometry.shape === "circle"
    ? { ...common, width: geometry.radiusPx * 2 * previewScale, height: geometry.radiusPx * 2 * previewScale }
    : { ...common, width: `${geometry.width * 100}%`, height: `${geometry.height * 100}%` };
}

function isVisualEditor(usage: RuntimeAssetUsage): boolean {
  return usage.editor.kind === "sprite" || usage.editor.kind === "fixed" || usage.editor.kind === "world-object";
}

function sharedItemPresentationKey(
  asset: RuntimeAsset,
  usage: RuntimeAssetUsage
): string | null {
  const relativeFile = asset.relativeFile.replaceAll("\\", "/");
  return relativeFile.startsWith("apps/client/src/assets/items/") && usage.editor.kind === "sprite"
    ? usage.editor.key
    : null;
}

export function spriteEditorDimensions(
  value: RuntimeSpritePresentation,
  intrinsicWidth: number,
  intrinsicHeight: number
): { width: number; height: number } {
  const ratio = intrinsicAspectRatio(intrinsicWidth, intrinsicHeight);
  return {
    width: value.baseHeightPx * ratio * (value.horizontalScale ?? 1),
    height: value.baseHeightPx
  };
}

export function dimensionsMatchAspectRatio(
  width: number,
  height: number,
  intrinsicWidth: number,
  intrinsicHeight: number
): boolean {
  const expectedWidth = height * intrinsicAspectRatio(intrinsicWidth, intrinsicHeight);
  return Math.abs(width - expectedWidth) <= Math.max(1e-6, expectedWidth * 1e-6);
}

export function spriteDimensionPatch(
  dimension: "width" | "height",
  nextValue: number,
  current: Readonly<{ width: number; height: number }>,
  intrinsicWidth: number,
  intrinsicHeight: number,
  locked: boolean
): Partial<RuntimeSpritePresentation> {
  const ratio = intrinsicAspectRatio(intrinsicWidth, intrinsicHeight);
  if (dimension === "width") {
    return locked
      ? { baseHeightPx: nextValue / ratio, horizontalScale: 1 }
      : { horizontalScale: nextValue / (current.height * ratio) };
  }
  return locked
    ? { baseHeightPx: nextValue, horizontalScale: 1 }
    : {
        baseHeightPx: nextValue,
        horizontalScale: current.width / (nextValue * ratio)
      };
}

export function fixedDimensionPatch(
  dimension: "width" | "height",
  nextValue: number,
  intrinsicWidth: number,
  intrinsicHeight: number,
  locked: boolean
): Partial<RuntimeFixedPngPresentation> {
  const ratio = intrinsicAspectRatio(intrinsicWidth, intrinsicHeight);
  if (!locked) return { [dimension]: nextValue };
  return dimension === "width"
    ? { width: nextValue, height: nextValue / ratio }
    : { width: nextValue * ratio, height: nextValue };
}

function intrinsicAspectRatio(width: number, height: number): number {
  return Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0
    ? width / height
    : 1;
}

function normalizePngDimension(value: number): number {
  return Number(value.toFixed(6));
}

export function defaultRuntimeAssetUsage(asset: RuntimeAsset): RuntimeAssetUsage | null {
  return asset.usages.find(isVisualEditor) ?? asset.usages[0] ?? null;
}

function inboxEntryActionLabel(status: RuntimeAssetInboxEntry["status"]): string {
  switch (status) {
    case "ready": return "Import to Worktree";
    case "staged": return "Staged";
    case "imported": return "Already in Worktree";
    case "conflict": return "Resolve Conflict";
  }
}

function formatBytes(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Asset Studio operation failed";
}
