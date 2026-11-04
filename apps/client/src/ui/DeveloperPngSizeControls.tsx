import type { DevPngAsset } from "../developer/devPngCatalog.js";
import {
  DEV_PNG_MAX_MULTIPLIER,
  DEV_PNG_MIN_MULTIPLIER,
  DEV_PNG_MULTIPLIER_STEP,
  type DevPngLabController,
  type DevPngLabState,
  type DevPngPlacement
} from "../developer/devPngLabController.js";
import {
  calculateDevPngSize,
  formatDevPngDimensions
} from "../developer/devPngSizing.js";

type Props = {
  asset: DevPngAsset;
  controller: DevPngLabController;
  mapZoom: number;
  placement: DevPngPlacement | null;
  state: DevPngLabState;
  idPrefix: string;
};

export function DeveloperPngSizeControls({
  asset,
  controller,
  mapZoom,
  placement,
  state,
  idPrefix
}: Props): React.JSX.Element {
  const multiplier = placement?.scaleMultiplier ?? state.nextMultiplier;
  const itemArtworkAsset = asset.sourcePath.replaceAll("\\", "/").startsWith("apps/client/src/assets/items/");
  const size = calculateDevPngSize(
    asset,
    state.intrinsicSizes[asset.id] ?? null,
    mapZoom,
    multiplier
  );
  const update = (value: number): void => {
    if (placement) controller.setSelectedMultiplier(value);
    else controller.setNextMultiplier(value);
  };

  return (
    <div className="developer-png-size-controls">
      <div className="developer-png-size-heading">
        <strong>{itemArtworkAsset
          ? placement ? "Temporary selected placement size" : "Temporary next placement size"
          : placement ? "Selected instance size" : "Next placement size"}</strong>
        <output htmlFor={`${idPrefix}-range ${idPrefix}-number`}>
          {multiplier.toFixed(2)}× · {formatDevPngDimensions(size)}
        </output>
      </div>
      <input
        id={`${idPrefix}-range`}
        aria-label={itemArtworkAsset
          ? placement ? "Temporary selected placement size" : "Temporary next placement size"
          : placement ? "Selected instance size" : "Next placement size"}
        type="range"
        min={DEV_PNG_MIN_MULTIPLIER}
        max={DEV_PNG_MAX_MULTIPLIER}
        step={DEV_PNG_MULTIPLIER_STEP}
        value={multiplier}
        onChange={(event) => update(event.currentTarget.valueAsNumber)}
      />
      <div className="developer-png-size-buttons">
        <button type="button" aria-label="Decrease PNG size" onClick={() => update(multiplier - DEV_PNG_MULTIPLIER_STEP)}>−</button>
        <label>
          Multiplier
          <input
            id={`${idPrefix}-number`}
            type="number"
            min={DEV_PNG_MIN_MULTIPLIER}
            max={DEV_PNG_MAX_MULTIPLIER}
            step={DEV_PNG_MULTIPLIER_STEP}
            value={multiplier}
            onChange={(event) => update(event.currentTarget.valueAsNumber)}
          />
        </label>
        <button type="button" aria-label="Increase PNG size" onClick={() => update(multiplier + DEV_PNG_MULTIPLIER_STEP)}>+</button>
        <button type="button" onClick={() => update(1)}>Reset</button>
      </div>
      {placement ? (
        <button type="button" className="developer-png-use-size" onClick={() => controller.useSelectedSizeForNewCopies()}>
          {itemArtworkAsset ? "Use Temporary Size for New Copies" : "Use This Size for New Copies"}
        </button>
      ) : null}
      {itemArtworkAsset ? <small className="developer-png-item-size-note">Session-only preview multiplier. Permanent item size is authored in Appearance Studio → Game PNGs and is not changed by PNG Lab.</small> : null}
    </div>
  );
}
