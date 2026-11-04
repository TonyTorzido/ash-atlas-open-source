import {
  progressionIconTransformCss,
  type ProgressionIconPresentationCatalog,
  type ProgressionIconRegistryEntry,
  type ProgressionIconTransform
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

import type { ProgressionIconInventory } from "./bridgeTypes.js";
import type { StudioApi } from "./studioApi.js";

export type ProgressionIconStudioHandle = { save(): Promise<void>; revert(): Promise<void> };

type Props = {
  api: StudioApi;
  visible: boolean;
  writesAllowed: boolean;
  onDirtyChange(dirty: boolean): void;
  onBusyChange(busy: boolean): void;
  onMessage(message: string): void;
};

const GROUP_LABELS = {
  general: "General skills",
  class: "Classes",
  profession: "Professions",
  "profession-skill": "Profession skills"
} as const;

export const ProgressionIconStudio = forwardRef<ProgressionIconStudioHandle, Props>(
  function ProgressionIconStudio(props, ref) {
    const [inventory, setInventory] = useState<ProgressionIconInventory | null>(null);
    const [catalog, setCatalog] = useState<ProgressionIconPresentationCatalog | null>(null);
    const [savedCatalog, setSavedCatalog] = useState<ProgressionIconPresentationCatalog | null>(null);
    const [selectedKey, setSelectedKey] = useState<string | null>(null);
    const [search, setSearch] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [artReady, setArtReady] = useState(false);
    useEffect(() => {
      if (!inventory) return;
      let cancelled = false;
      const urls = [...new Set(inventory.icons.map((icon) => icon.imageUrl))];
      void Promise.all(urls.map((url) => new Promise<void>((resolve) => {
        const image = new Image();
        image.onload = () => resolve();
        image.onerror = () => resolve();
        image.src = url;
      }))).then(() => { if (!cancelled) setArtReady(true); });
      return () => { cancelled = true; };
    }, [inventory]);
    const drag = useRef<{ x: number; y: number; offsetX: number; offsetY: number } | null>(null);

    useEffect(() => {
      if (!props.visible || inventory) return;
      void props.api.loadProgressionIcons().then((loaded) => {
        setInventory(loaded);
        setCatalog(structuredClone(loaded.catalog));
        setSavedCatalog(structuredClone(loaded.catalog));
        setSelectedKey(loaded.icons[0]?.key ?? null);
      }).catch((caught: unknown) => setError(errorMessage(caught)));
    }, [inventory, props.api, props.visible]);

    const dirty = Boolean(catalog && savedCatalog && JSON.stringify(catalog) !== JSON.stringify(savedCatalog));
    useEffect(() => props.onDirtyChange(dirty), [dirty, props.onDirtyChange]);
    useEffect(() => props.onBusyChange(busy), [busy, props.onBusyChange]);

    const save = async (): Promise<void> => {
      if (!catalog || busy || !dirty) return;
      setBusy(true);
      setError(null);
      props.onMessage("Saving progression icon alignment to this worktree…");
      try {
        const result = await props.api.publishProgressionIcons(catalog);
        setInventory(result.inventory);
        setCatalog(structuredClone(result.catalog));
        setSavedCatalog(structuredClone(result.catalog));
        props.onMessage(result.modifiedFiles.length
          ? `Saved progression icon revision ${result.catalog.revision}.`
          : "Progression icon alignment already matched the worktree.");
      } catch (caught) {
        const message = errorMessage(caught);
        setError(message);
        props.onMessage(message);
      } finally {
        setBusy(false);
      }
    };

    const revert = async (): Promise<void> => {
      if (!savedCatalog || busy) return;
      setCatalog(structuredClone(savedCatalog));
      setError(null);
      props.onMessage("Reverted unsaved progression icon alignment changes.");
    };
    useImperativeHandle(ref, () => ({ save, revert }), [catalog, savedCatalog, busy, dirty]);

    const selected = inventory?.icons.find((icon) => icon.key === selectedKey) ?? null;
    const transform = selectedKey ? catalog?.transforms[selectedKey] ?? null : null;
    const visibleIcons = useMemo(() => {
      const query = search.trim().toLowerCase();
      return inventory?.icons.filter((icon) => !query || `${icon.label} ${icon.key}`.toLowerCase().includes(query)) ?? [];
    }, [inventory, search]);
    const editingDisabled = !props.writesAllowed || busy;

    const edit = (patch: Partial<ProgressionIconTransform>): void => {
      if (!selectedKey || editingDisabled) return;
      setCatalog((current) => current ? {
        ...current,
        transforms: {
          ...current.transforms,
          [selectedKey]: { ...current.transforms[selectedKey]!, ...patch }
        }
      } : current);
    };

    const pointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
      if (!transform || editingDisabled) return;
      event.currentTarget.setPointerCapture(event.pointerId);
      drag.current = { x: event.clientX, y: event.clientY, offsetX: transform.offsetX, offsetY: transform.offsetY };
    };
    const pointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
      if (!drag.current) return;
      const size = event.currentTarget.getBoundingClientRect().width;
      edit({
        offsetX: clamp(drag.current.offsetX + (event.clientX - drag.current.x) / size, -1, 1),
        offsetY: clamp(drag.current.offsetY + (event.clientY - drag.current.y) / size, -1, 1)
      });
    };
    const pointerUp = (): void => { drag.current = null; };

    return (
      <section className="progression-icon-studio" data-testid="progression-workspace" hidden={!props.visible} aria-label="Progression Icons workspace">
        <aside className="panel progression-icon-library" data-testid="progression-library">
          <div><p className="eyebrow">Progression artwork</p><h2>Progression Icons</h2></div>
          <p className="empty-copy">Choose any skill, class, profession, or profession skill.</p>
          <input aria-label="Search progression icons" data-testid="progression-search" placeholder="Search icons" value={search}
            onChange={(event) => setSearch(event.target.value)} />
          {inventory && !artReady ? <p className="empty-copy" role="status">Loading icon artwork…</p> : null}
          <div className="progression-icon-list" data-testid="progression-list">
            {Object.entries(GROUP_LABELS).map(([group, label]) => {
              const icons = visibleIcons.filter((icon) => icon.group === group);
              if (!icons.length) return null;
              return <div className="progression-icon-group" key={group}>
                <h3>{label}</h3>
                <div className="progression-icon-grid">
                  {icons.map((icon) => <button type="button" key={icon.key} data-testid={`progression-icon-${icon.key}`}
                    className={selectedKey === icon.key ? "selected" : ""}
                    onClick={() => setSelectedKey(icon.key)}>
                    <Sprite icon={icon} transform={catalog?.transforms[icon.key]} size={54} />
                    <span>{icon.label}</span>
                  </button>)}
                </div>
              </div>;
            })}
          </div>
        </aside>
        <section className="panel progression-icon-editor" data-testid="progression-editor">
          {selected && transform ? <>
            <div className="progression-icon-editor-heading">
              <div><p className="eyebrow">{GROUP_LABELS[selected.group]}</p><h2>{selected.label}</h2></div>
              <code>{selected.key}</code>
            </div>
            <p className="empty-copy">Drag the artwork inside the square. Resize it with the scale controls. The frame always clips exactly like the game.</p>
            <div className="progression-icon-edit-frame" data-testid="progression-edit-frame" aria-label={`Move ${selected.label} artwork`}
              onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp}
              onPointerCancel={pointerUp} onLostPointerCapture={pointerUp}>
              <Sprite icon={selected} transform={transform} size={320} bare />
              <span className="progression-icon-crosshair" aria-hidden="true" />
            </div>
            <div className="progression-icon-fields">
              <label><span>X offset (% of frame)</span><input aria-label="X offset" data-testid="progression-offset-x" type="number" min="-100" max="100" step="0.5"
                disabled={editingDisabled} value={round(transform.offsetX * 100)} onChange={(event) => edit({ offsetX: clamp(Number(event.target.value) / 100, -1, 1) })} /></label>
              <label><span>Y offset (% of frame)</span><input aria-label="Y offset" data-testid="progression-offset-y" type="number" min="-100" max="100" step="0.5"
                disabled={editingDisabled} value={round(transform.offsetY * 100)} onChange={(event) => edit({ offsetY: clamp(Number(event.target.value) / 100, -1, 1) })} /></label>
              <label><span>Scale</span><input aria-label="Scale value" data-testid="progression-scale-value" type="number" min="0.25" max="3" step="0.01"
                disabled={editingDisabled} value={round(transform.scale)} onChange={(event) => edit({ scale: clamp(Number(event.target.value), 0.25, 3) })} /></label>
            </div>
            <label className="progression-icon-scale"><span>Scale</span><input aria-label="Scale slider" data-testid="progression-scale-slider" type="range" min="0.25" max="3" step="0.01"
              disabled={editingDisabled} value={transform.scale} onChange={(event) => edit({ scale: Number(event.target.value) })} /></label>
            <div className="progression-icon-nudges" data-testid="progression-nudges" aria-label="Nudge artwork">
              <button disabled={editingDisabled} type="button" onClick={() => edit({ offsetX: clamp(transform.offsetX - 0.01, -1, 1) })}>← Nudge</button>
              <button disabled={editingDisabled} type="button" onClick={() => edit({ offsetY: clamp(transform.offsetY - 0.01, -1, 1) })}>↑ Nudge</button>
              <button disabled={editingDisabled} type="button" onClick={() => edit({ offsetY: clamp(transform.offsetY + 0.01, -1, 1) })}>↓ Nudge</button>
              <button disabled={editingDisabled} type="button" onClick={() => edit({ offsetX: clamp(transform.offsetX + 0.01, -1, 1) })}>Nudge →</button>
              <button disabled={editingDisabled} type="button" className="ghost" data-testid="progression-reset" onClick={() => edit({ offsetX: 0, offsetY: 0, scale: 1 })}>Reset selected</button>
            </div>
            <div className="progression-icon-previews">
              {[32, 48, 64].map((size) => <div key={size}><Sprite icon={selected} transform={transform} size={size} /><span>{size}px</span></div>)}
            </div>
          </> : <p className="empty-copy">Select an icon to begin.</p>}
          {error && <p className="connection-error" role="alert">{error}</p>}
        </section>
      </section>
    );
  }
);

function Sprite({ icon, transform, size, bare = false }: {
  icon: ProgressionIconRegistryEntry & { imageUrl: string };
  transform: ProgressionIconTransform | undefined;
  size: number;
  bare?: boolean;
}): React.JSX.Element {
  const resolved = transform ?? { offsetX: 0, offsetY: 0, scale: 1 };
  const x = (icon.index % icon.columns) * icon.cellSize;
  const y = Math.floor(icon.index / icon.columns) * icon.cellSize;
  const art = {
    position: "absolute", left: "50%", top: "50%", marginLeft: -icon.cellSize / 2,
    marginTop: -icon.cellSize / 2, width: icon.cellSize, height: icon.cellSize,
    backgroundImage: `url(${JSON.stringify(icon.imageUrl)})`, backgroundPosition: `${-x}px ${-y}px`,
    backgroundRepeat: "no-repeat", transform: progressionIconTransformCss(resolved, size, icon.cellSize),
    transformOrigin: "center"
  } as CSSProperties;
  return <span className={bare ? "progression-icon-sprite-bare" : "progression-icon-sprite-preview"}
    style={{ width: size, height: size }}><span style={art} /></span>;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));
}
function round(value: number): number { return Math.round(value * 1000) / 1000; }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : "Progression icon editor failed"; }
