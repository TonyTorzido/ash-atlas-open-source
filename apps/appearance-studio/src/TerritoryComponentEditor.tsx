import {
  TERRITORY_PIECE_ROLES, TERRITORY_PIECE_ROLE_LABELS,
  type TerritoryStructurePiece, type TerritoryStructureVisual
} from "@ash-atlas/shared";

type Props = {
  visual: TerritoryStructureVisual;
  availableAssets: string[];
  revision: number;
  disabled: boolean;
  selected: string | null;
  onSelect(id: string): void;
  onChange(update: (visual: TerritoryStructureVisual) => void): void;
};

export function TerritoryComponentEditor(props: Props) {
  const { visual, disabled, onChange } = props;
  const layers = [
    ...visual.pieces.map((piece) => ({ id: piece.id, name: piece.name, zIndex: piece.zIndex, piece })),
    ...(["burning", "emblem"] as const).map((id) => ({ id, name: id === "burning" ? "Burning indicator" : "Kingdom emblem", zIndex: visual.attachments[id].zIndex, piece: null }))
  ].sort((a, b) => a.zIndex - b.zIndex);
  const selected = layers.find((layer) => layer.id === props.selected) ?? null;
  const piece = selected?.piece;
  const attachmentId = selected && !piece ? selected.id as "burning" | "emblem" : null;
  const attachment = attachmentId ? visual.attachments[attachmentId] : null;
  const editPiece = (update: (next: TerritoryStructurePiece) => void) => {
    if (!piece) return;
    onChange((next) => { const target = next.pieces.find((entry) => entry.id === piece.id); if (target) update(target); });
  };
  const addPiece = (duplicate: boolean) => {
    if (disabled || visual.pieces.length >= 32) return;
    const template = duplicate && piece ? piece : visual.pieces[0]!;
    let suffix = 1;
    const prefix = duplicate ? `${template.id.slice(0, 48)}-copy` : "decoration";
    while (visual.pieces.some((entry) => entry.id === `${prefix}-${suffix}`)) suffix++;
    const id = `${prefix}-${suffix}`;
    onChange((next) => next.pieces.push({
      ...structuredClone(template), id,
      name: duplicate ? `${template.name.slice(0, 65)} copy ${suffix}` : `Decoration ${suffix}`,
      role: duplicate ? template.role : "decoration",
      visible: true, zIndex: Math.min(2048, Math.max(...layers.map((layer) => layer.zIndex)) + 1)
    }));
    props.onSelect(id);
  };
  const move = (direction: -1 | 1) => {
    const index = layers.findIndex((layer) => layer.id === selected?.id);
    const target = index + direction;
    if (disabled || index < 0 || target < 0 || target >= layers.length) return;
    const ordered = [...layers];
    [ordered[index], ordered[target]] = [ordered[target]!, ordered[index]!];
    onChange((next) => ordered.forEach((layer, zIndex) => {
      const png = next.pieces.find((entry) => entry.id === layer.id);
      if (png) png.zIndex = zIndex;
      else next.attachments[layer.id as "burning" | "emblem"].zIndex = zIndex;
    }));
  };
  return <section className="territory-components" aria-label="Components and layers">
    <h3>Components / Layers</h3>
    <p className="empty-copy">Back to front. PNG alpha supplies transparency; there is no separate mask or perimeter layer. Cloth tint multiplies the PNG colors, preserving its shading.</p>
    <div className="territory-layer-list" aria-label="Structure components">
      {layers.map((layer) => <button type="button" key={layer.id} aria-pressed={selected?.id === layer.id}
        className={`territory-layer ${selected?.id === layer.id ? "selected" : ""}`}
        onClick={() => props.onSelect(layer.id)}>
        {layer.piece ? <img src={`/runtime-assets/${layer.piece.asset}?revision=${props.revision}`} alt="" />
          : <span className="territory-generated-preview" aria-hidden="true">{layer.id === "burning" ? "Fire" : "K"}</span>}
        <span><strong>{layer.name}</strong><small>{layer.piece ? TERRITORY_PIECE_ROLE_LABELS[layer.piece.role] : "State overlay"} · layer {layer.zIndex}</small>
          <small>{layer.piece ? layer.piece.visible ? "Visible" : "Hidden" : layer.id === "burning" ? "Visible while burning" : "Visible with a kingdom emblem"}</small></span>
      </button>)}
    </div>
    <div className="territory-layer-actions">
      <button type="button" disabled={disabled || visual.pieces.length >= 32} onClick={() => addPiece(false)}>Add PNG component</button>
      <button type="button" disabled={disabled || !piece || visual.pieces.length >= 32} onClick={() => addPiece(true)}>Duplicate component</button>
    </div>
    {selected ? <fieldset disabled={disabled} className="territory-component-properties">
      <legend>{selected.name}</legend>
      <div className="territory-layer-actions">
        <button type="button" disabled={disabled || layers[0]?.id === selected.id} onClick={() => move(-1)}>Move backward</button>
        <button type="button" disabled={disabled || layers.at(-1)?.id === selected.id} onClick={() => move(1)}>Move forward</button>
      </div>
      {piece && <>
        <p className="empty-copy">Component key: <code>{piece.id}</code></p>
        <label className="field"><span>Component name</span><input value={piece.name} maxLength={80} onChange={(event) => editPiece((next) => { next.name = event.target.value; })} /></label>
        <label className="field"><span>Component role</span><select value={piece.role} onChange={(event) => editPiece((next) => { next.role = event.target.value as typeof next.role; })}>
          {TERRITORY_PIECE_ROLES.map((role) => <option key={role} value={role}>{TERRITORY_PIECE_ROLE_LABELS[role]}</option>)}
        </select></label>
        <label className="field"><span>PNG asset path</span><select value={piece.asset} onChange={(event) => editPiece((next) => { next.asset = event.target.value; })}>
          {[...new Set([piece.asset, ...props.availableAssets])].sort().map((asset) => <option key={asset} value={asset}>{asset.replace("apps/client/src/assets/", "")}</option>)}
        </select></label>
        <code className="territory-asset-path">{piece.asset}</code>
        <p className="empty-copy">Add replacement PNG files through Game PNGs, then Reload asset list. Flag-pack PNGs live under assets/flags/; existing shrine art keeps its stable path.</p>
        <label className="territory-checkbox"><input type="checkbox" checked={piece.visible} onChange={(event) => editPiece((next) => { next.visible = event.target.checked; })} />Component visible</label>
        <div className="territory-fields">
          <TerritoryNumberField label="Component scale" value={piece.scale} min={0.1} max={4} step={0.01} set={(value) => editPiece((next) => { next.scale = value; })} />
          <TerritoryNumberField label="Layer order" value={piece.zIndex} step={1} set={(value) => editPiece((next) => { next.zIndex = value; })} />
          {(["offsetX", "offsetY", "width", "height", "anchorX", "anchorY"] as const).map((key) => <TerritoryNumberField key={key}
            label={`Component ${key}`} value={piece[key]} min={key.startsWith("anchor") ? 0 : key === "width" || key === "height" ? 0.1 : -2048}
            max={key.startsWith("anchor") ? 1 : 2048} step={key.startsWith("anchor") ? 0.01 : 0.5}
            set={(value) => editPiece((next) => { next[key] = value; })} />)}
        </div>
        <label className="field"><span>Component tint</span><select value={piece.tint} onChange={(event) => editPiece((next) => { next.tint = event.target.value as typeof next.tint; })}>
          <option value="none">Original PNG colors</option><option value="control">Ownership / control color</option><option value="fixed">Fixed cosmetic color</option>
        </select></label>
        {piece.tint === "fixed" && <label className="field"><span>Fixed tint color</span><input type="color" value={piece.tintColor} onChange={(event) => editPiece((next) => { next.tintColor = event.target.value; })} /></label>}
        <button type="button" className="danger" disabled={disabled || visual.pieces.length <= 1}
          onClick={() => onChange((next) => { next.pieces = next.pieces.filter((entry) => entry.id !== piece.id); })}>Remove component</button>
        <small>Removal is an unsaved draft edit. Revert restores disk. Required visible roles must remain before Save.</small>
      </>}
      {attachment && attachmentId && <>
        <p className="empty-copy">{attachmentId === "burning" ? "Generated flame geometry, not a PNG. Visibility and flame colors are owned by the burning state." : "Generated text: the first character of the kingdom emblem, not a PNG. Visibility and white text are owned by kingdom state."}</p>
        <p className="empty-copy">Key: <code>{attachmentId}</code> · no mask · no animation. Use the preview state toggles to inspect it. State overlays cannot be removed or hidden by a cosmetic pack.</p>
        <div className="territory-fields">{(["x", "y", "scale", "zIndex"] as const).map((key) => <TerritoryNumberField key={key}
          label={`Overlay ${key}`} value={attachment[key]} min={key === "scale" ? 0.1 : -2048} max={key === "scale" ? 4 : 2048}
          step={key === "scale" ? 0.01 : 0.5}
          set={(value) => onChange((next) => { next.attachments[attachmentId][key] = value; })} />)}</div>
      </>}
    </fieldset> : <p className="empty-copy">Select a component to inspect its exact PNG, registration and color behavior.</p>}
  </section>;
}

export function TerritoryNumberField({ label, value, set, min = -2048, max = 2048, step = 0.5 }: {
  label: string; value: number; set(value: number): void; min?: number; max?: number; step?: number;
}) {
  return <label className="field"><span>{label}</span><input aria-label={label} type="number" value={value}
    min={min} max={max} step={step} onChange={(event) => {
      const next = event.currentTarget.valueAsNumber;
      if (Number.isFinite(next)) set(next);
    }} /></label>;
}
