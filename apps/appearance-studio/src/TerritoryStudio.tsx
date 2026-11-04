import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import {
  TERRITORY_STRUCTURE_TYPES, WORLD_OBJECT_ZOOM_POLICY,
  cloneTerritoryFlagPack, territoryStructureValidationIssues, territoryStructureVisual,
  type TerritoryStructureCatalog, type TerritoryStructureType
} from "@ash-atlas/shared";
import type { StudioApi } from "./studioApi.js";
import type { TerritoryStructureInventory } from "./bridgeTypes.js";
import { TerritoryPreview } from "./TerritoryPreview.js";
import { TerritoryComponentEditor, TerritoryNumberField as NumberField } from "./TerritoryComponentEditor.js";

export type TerritoryStudioHandle = { save(): Promise<void>; revert(): Promise<void> };
type Props = {
  api: StudioApi; visible: boolean; writesAllowed: boolean;
  onDirtyChange(dirty: boolean): void;
  onBusyChange(busy: boolean): void;
  onMessage(message: string): void;
};

export const TerritoryStudio = forwardRef<TerritoryStudioHandle, Props>(function TerritoryStudio(props, ref) {
  const [inventory, setInventory] = useState<TerritoryStructureInventory | null>(null);
  const [catalog, setCatalog] = useState<TerritoryStructureCatalog | null>(null);
  const [saved, setSaved] = useState<TerritoryStructureCatalog | null>(null);
  const [packId, setPackId] = useState("stock");
  const [structureType, setStructureType] = useState<TerritoryStructureType>("soft_flag");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showBounds, setShowBounds] = useState(true);
  const [showAnchor, setShowAnchor] = useState(true);
  const [showPieces, setShowPieces] = useState(false);
  const [burning, setBurning] = useState(false);
  const [emblem, setEmblem] = useState(false);
  const [tint, setTint] = useState("#66bb6a");
  const [mapZoom, setMapZoom] = useState(WORLD_OBJECT_ZOOM_POLICY.baseZoom);
  const [magnification, setMagnification] = useState(3);
  const [selectedComponent, setSelectedComponent] = useState<string | null>(null);
  const [soloComponent, setSoloComponent] = useState(false);
  const [newPackOpen, setNewPackOpen] = useState(false);
  const [newPackId, setNewPackId] = useState("");
  const [newPackName, setNewPackName] = useState("");
  const [newPackFixedColor, setNewPackFixedColor] = useState(false);
  const [newPackColor, setNewPackColor] = useState("#b65de3");
  const [packError, setPackError] = useState<string | null>(null);
  const operation = useRef(false);
  const dirty = Boolean(catalog && saved && JSON.stringify(catalog) !== JSON.stringify(saved));
  useEffect(() => props.onDirtyChange(dirty), [dirty, props.onDirtyChange]);
  useEffect(() => props.onBusyChange(busy), [busy, props.onBusyChange]);
  useEffect(() => { setSelectedComponent(null); setSoloComponent(false); }, [packId, structureType]);

  const load = useCallback(async () => {
    if (operation.current) return;
    operation.current = true; setBusy(true); setError(null);
    try {
      const loaded = await props.api.loadTerritoryStructures();
      setInventory(loaded); setCatalog(structuredClone(loaded.catalog)); setSaved(structuredClone(loaded.catalog));
      setPackId((current) => Object.hasOwn(loaded.catalog.packs, current) ? current : loaded.catalog.defaultPackId);
    } catch (caught) { setError(errorMessage(caught)); }
    finally { operation.current = false; setBusy(false); }
  }, [props.api]);
  useEffect(() => { if (props.visible && !inventory && !error) void load(); }, [props.visible, inventory, error, load]);

  const issues = catalog ? territoryStructureValidationIssues(catalog, new Set(inventory?.availableAssets ?? [])) : [];
  const save = async () => {
    if (!catalog || !dirty || !props.writesAllowed || operation.current || issues.length) return;
    operation.current = true; setBusy(true); setError(null);
    try {
      const result = await props.api.publishTerritoryStructures(catalog);
      setCatalog(structuredClone(result.catalog)); setSaved(structuredClone(result.catalog)); setInventory(result.inventory);
      props.onMessage(`Saved Flags revision ${result.catalog.revision} to this worktree. Reload the game to use the saved definition.`);
    } catch (caught) {
      const message = errorMessage(caught);
      setError(message); props.onMessage(message);
    } finally { operation.current = false; setBusy(false); }
  };
  const revert = async () => {
    if (operation.current) return;
    // Re-read the canonical file so a revision-conflict recovery does not repeat a stale save.
    await load();
    props.onMessage("Reloaded Flags from the worktree.");
  };
  useImperativeHandle(ref, () => ({ save, revert }));

  const disabled = !props.writesAllowed || busy;
  const edit = (update: (next: TerritoryStructureCatalog) => void) => {
    if (disabled) return;
    setCatalog((current) => { if (!current) return current; const next = structuredClone(current); update(next); return next; });
  };
  const visual = catalog ? territoryStructureVisual(structureType, packId, catalog) : null;
  const definition = catalog?.structures[structureType];
  const createPack = () => {
    if (!catalog || disabled) return;
    try {
      const created = cloneTerritoryFlagPack(catalog, newPackId.trim(), newPackName, newPackFixedColor ? newPackColor : undefined);
      edit((next) => { next.packs[newPackId.trim()] = created; });
      setPackId(newPackId.trim()); setNewPackOpen(false); setPackError(null);
      props.onMessage(`Created ${created.displayName} as an unsaved draft with all four structures. Save to Worktree when ready.`);
    } catch (caught) { setPackError(errorMessage(caught)); }
  };
  const refreshAssets = async () => {
    if (operation.current) return;
    operation.current = true; setBusy(true);
    try { const loaded = await props.api.loadTerritoryStructures(); setInventory(loaded); setError(null); }
    catch (caught) { setError(errorMessage(caught)); }
    finally { operation.current = false; setBusy(false); }
  };
  return <section className="territory-studio" data-testid="flags-workspace" hidden={!props.visible} aria-label="Flags workspace">
    <aside className="panel territory-library" data-testid="flags-library">
      <p className="eyebrow">Territory structures</p><h2>Flags</h2>
      {catalog && <label className="field"><span>Flag pack</span><select value={packId} data-testid="flags-pack-select" title={catalog.packs[packId]?.displayName ?? packId} onChange={(event) => setPackId(event.target.value)}>
        {Object.entries(catalog.packs).map(([id, pack]) => <option key={id} value={id}>{pack.displayName}{id === catalog.defaultPackId ? " · Active" : ""}</option>)}
      </select></label>}
      {catalog && <div className="territory-pack-actions">
        <button type="button" data-testid="flags-new-pack" disabled={disabled} aria-expanded={newPackOpen} onClick={() => { setNewPackOpen(!newPackOpen); setPackError(null); }}>New pack / Clone Stock</button>
        {newPackOpen && <fieldset disabled={disabled}><legend>Clone Stock templates</legend>
          <label className="field"><span>New pack ID</span><input value={newPackId} maxLength={64} placeholder="violet-banner" onChange={(event) => setNewPackId(event.target.value)} /></label>
          <label className="field"><span>New pack name</span><input value={newPackName} maxLength={80} placeholder="Violet Banner" onChange={(event) => setNewPackName(event.target.value)} /></label>
          <label className="territory-checkbox"><input type="checkbox" checked={newPackFixedColor} onChange={(event) => setNewPackFixedColor(event.target.checked)} />Use fixed cloth color</label>
          {newPackFixedColor && <label className="field"><span>New pack cloth color</span><input type="color" value={newPackColor} onChange={(event) => setNewPackColor(event.target.value)} /></label>}
          <p className="empty-copy">Creates Soft Flag, Bastion Flag, Tower and Atlas Shrine together. Fixed color recolors cloth only; unchecked preserves ownership/control tint.</p>
          {packError && <p role="alert" className="connection-error">{packError}</p>}
          <button type="button" className="primary" onClick={createPack}>Create draft pack</button>
          <button type="button" onClick={() => setNewPackOpen(false)}>Cancel</button>
        </fieldset>}
        <button type="button" data-testid="flags-use-pack" disabled={disabled || catalog.defaultPackId === packId}
          onClick={() => edit((next) => { next.defaultPackId = packId; })}>{catalog.defaultPackId === packId ? "Active game pack" : "Use pack in game"}</button>
        <small>Active pack is the global cosmetic default after saving and reloading the game. It does not grant player ownership or change gameplay.</small>
      </div>}
      <nav className="territory-structure-list" data-testid="flags-structure-list" aria-label="Pack structures">
        {TERRITORY_STRUCTURE_TYPES.map((type) => <button type="button" key={type} data-testid={`flags-structure-${type}`}
          className={type === structureType ? "primary" : ""} aria-pressed={type === structureType}
          onClick={() => setStructureType(type)}>{catalog?.structures[type]?.displayName ?? type.replaceAll("_", " ")}</button>)}
      </nav>
      <p className="empty-copy">One root moves every artwork piece. Tap bounds belong to the structure type and are shared by all packs.</p>
      <small>Game PNGs still owns the original PNG files.</small>
    </aside>
    <section className="panel territory-editor" data-testid="flags-editor">
      {busy && !catalog && <p role="status">Loading Flags…</p>}
      {error && <div className="connection-error" role="alert">{error} <button type="button" disabled={busy} onClick={() => void load()}>Reload Flags</button></div>}
      {catalog && visual && definition && <>
        <div className="territory-heading"><div><p className="eyebrow">{catalog.packs[packId]?.displayName}</p><h2>{definition.displayName}</h2></div>
          <span role="status">{dirty ? "Unsaved changes" : `Saved · revision ${catalog.revision}`}</span></div>
        <div className="territory-editor-grid">
          <div className="territory-preview-panel" data-testid="flags-preview">
            {props.visible && <TerritoryPreview catalog={catalog} structureType={structureType} packId={packId}
              showBounds={showBounds} showAnchor={showAnchor} showPieces={showPieces} burning={burning} emblem={emblem}
              tint={tint} mapZoom={mapZoom} magnification={magnification} selectedComponent={selectedComponent} soloComponent={soloComponent} />}
            <div className="territory-toggles">
              <Toggle label="Interaction bounds" value={showBounds} set={setShowBounds} />
              <Toggle label="Ground anchor" value={showAnchor} set={setShowAnchor} />
              <Toggle label="Individual piece bounds" value={showPieces} set={setShowPieces} />
              <Toggle label="Solo selected component (preview only)" value={soloComponent} set={setSoloComponent} />
              <Toggle label="Burning preview" value={burning} set={setBurning} />
              <Toggle label="Kingdom emblem preview" value={emblem} set={setEmblem} />
            </div>
            <div className="territory-fields">
              <NumberField label="Map zoom" value={mapZoom} min={4} max={20} step={0.5} set={setMapZoom} />
              <NumberField label="Inspection magnification" value={magnification} min={0.5} max={6} step={0.5} set={setMagnification} />
              <label className="field"><span>Control color preview</span><input type="color" value={tint} onChange={(event) => setTint(event.target.value)} /></label>
            </div>
          </div>
          <div className="territory-controls" data-testid="flags-controls">
            <fieldset disabled={disabled}><legend>Master transform</legend>
              <div className="territory-fields">
                <NumberField label="Master Scale" value={visual.root.scale} min={0.1} max={4} step={0.01}
                  set={(value) => edit((next) => { next.packs[packId]!.structures[structureType]!.root.scale = value; })} />
                {(["offsetX", "offsetY"] as const).map((key) => <NumberField key={key} label={key === "offsetX" ? "Master X offset" : "Master Y offset"}
                  value={visual.root[key]} set={(value) => edit((next) => { next.packs[packId]!.structures[structureType]!.root[key] = value; })} />)}
              </div>
              <small>Ground contact: (0, 0). Offsets are visual only; the map position stays fixed.</small>
            </fieldset>
            <fieldset disabled={disabled}><legend>Complete interaction area</legend>
              <div className="territory-fields">
                {(["width", "height", "offsetX", "offsetY"] as const).map((key) => <NumberField key={key}
                  label={`Interaction ${key === "offsetX" ? "X offset" : key === "offsetY" ? "Y offset" : key}`}
                  value={definition.interaction[key]} min={key === "width" || key === "height" ? 0.1 : -2048}
                  set={(value) => edit((next) => { next.structures[structureType]!.interaction[key] = value; })} />)}
              </div>
              <small>Widths and offsets use the renderer's local pixels, before map zoom. Visual scale never changes these bounds.</small>
            </fieldset>
            <TerritoryComponentEditor visual={visual} availableAssets={inventory?.availableAssets ?? []} revision={catalog.revision}
              disabled={disabled} selected={selectedComponent} onSelect={setSelectedComponent}
              onChange={(update) => edit((next) => update(next.packs[packId]!.structures[structureType]!))} />
            <button type="button" data-testid="flags-reload-assets" disabled={busy} onClick={() => void refreshAssets()}>Reload asset list</button>
          </div>
        </div>
        {issues.length ? <div role="alert" className="connection-error"><strong>Fix before saving</strong><ul>{issues.map((issue) => <li key={issue}>{issue}</li>)}</ul></div>
          : <p className="empty-copy">Definition valid · all PNG pieces available · one shared interaction area</p>}
      </>}
    </section>
  </section>;
});

function Toggle({ label, value, set }: { label: string; value: boolean; set(value: boolean): void }) {
  return <label><input type="checkbox" checked={value} onChange={(event) => set(event.target.checked)} />{label}</label>;
}
function errorMessage(error: unknown) { return error instanceof Error ? error.message : "Flags could not be loaded or saved."; }
