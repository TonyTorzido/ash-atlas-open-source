import {
  WORLD_ENVIRONMENT_OVERLAY_DEFINITION,
  type WorldEnvironmentOverlayGroupId
} from "@ash-atlas/shared";
import {
  WORLD_ENVIRONMENT_OVERLAY_GROUPS,
  type WorldEnvironmentOverlaySelections
} from "../map/worldEnvironmentOverlays.js";
import { GameAppTabs } from "./GameAppShell.js";
type Props = {
  layout?: "desktop" | "phone";
  open: boolean;
  activePanelId: WorldEnvironmentOverlayGroupId;
  activeOverlayGroupId: WorldEnvironmentOverlayGroupId | null;
  selections: WorldEnvironmentOverlaySelections;
  error: string | null;
  onPanelChange(panelId: WorldEnvironmentOverlayGroupId): void;
  onActiveGroupChange(groupId: WorldEnvironmentOverlayGroupId): void;
  onCategoryChange(groupId: WorldEnvironmentOverlayGroupId, categoryId: string, enabled: boolean): void;
};

const { moderate, high, extreme, summit } = WORLD_ENVIRONMENT_OVERLAY_DEFINITION.elevationThresholdsM;
const elevationRanges: Record<string, string> = {
  low: `< ${moderate.toLocaleString()} m`,
  moderate: `${moderate.toLocaleString()}–< ${high.toLocaleString()} m`,
  high: `${high.toLocaleString()}–< ${extreme.toLocaleString()} m`,
  extreme: `${extreme.toLocaleString()}–< ${summit.toLocaleString()} m`,
  summit: `≥ ${summit.toLocaleString()} m`
};

export function WorldMapLayerControl({
  layout = "desktop",
  open,
  activePanelId,
  activeOverlayGroupId,
  selections,
  error,
  onPanelChange,
  onActiveGroupChange,
  onCategoryChange
}: Props): React.JSX.Element | null {
  const activeGroup = WORLD_ENVIRONMENT_OVERLAY_GROUPS.find(
    (candidate) => candidate.id === activePanelId
  ) ?? null;
  if (!open) return null;
  const selected = activeGroup ? selections[activeGroup.id] ?? [] : [];
  const allSelected = activeGroup ? activeGroup.categories.every((category) => selected.includes(category.id)) : false;
  return <div className={`world-map-layer-control world-map-layer-control--${layout}`}>
  <section
    id="world-map-layer-menu"
    className="world-map-layer-menu"
    aria-label="Layers"
    onPointerDown={(event) => event.stopPropagation()}
    onClick={(event) => event.stopPropagation()}
    onWheel={(event) => event.stopPropagation()}
  >
    <GameAppTabs
      variant="subtabs"
      scrollable
      ariaLabel="Layer groups"
      activeTab={activePanelId}
      tabs={WORLD_ENVIRONMENT_OVERLAY_GROUPS.map((overlayGroup) => ({
        id: overlayGroup.id,
        label: overlayGroup.label
      }))}
      onChange={(id) => {
        const next = id as WorldEnvironmentOverlayGroupId;
        onPanelChange(next);
        if (next !== activeOverlayGroupId) onActiveGroupChange(next);
      }}
    />
    {activeGroup ? <>
      <div className="world-map-layer-toolbar">
        <strong>{activeGroup.label}</strong>
        <button
          type="button"
          onClick={() => {
            for (const category of activeGroup.categories) {
              if (selected.includes(category.id) !== !allSelected) {
                onCategoryChange(activeGroup.id, category.id, !allSelected);
              }
            }
          }}
        >{allSelected ? "None" : "All"}</button>
      </div>
      <div className="world-map-layer-categories" role="tabpanel" aria-label={`${activeGroup.label} categories`}>
        {activeGroup.categories.map((category) => <label key={category.id}>
          <input
            type="checkbox"
            checked={selected.includes(category.id)}
            onChange={(event) => onCategoryChange(
              activeGroup.id,
              category.id,
              event.currentTarget.checked
            )}
          />
          <i style={{ backgroundColor: category.color }} aria-hidden="true" />
          <span>{category.label}{activeGroup.id === "elevation"
            ? <small className="world-map-layer-range">{elevationRanges[category.id]}</small>
            : null}</span>
        </label>)}
      </div>
    </> : <p className="world-map-layer-empty">Choose a layer group.</p>}
    {error ? <p className="world-map-layer-error" role="status">{error}</p> : null}
  </section>
  </div>;
}
