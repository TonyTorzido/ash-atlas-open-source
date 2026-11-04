import { useEffect } from "react";

import {
  MAX_PLANNING_ANCHOR_DISTANCE_M,
  validatePlanningAnchorDistance,
  type PlanningAnchor,
  type PlanningAnchorLayer,
  type PlanningAnchorSource
} from "../map/planningAnchors.js";
import {
  GameActionPrompt,
  GameConfirmationPrompt,
  GamePromptButton
} from "./GameActionPrompt.js";
import { itemArtworkSource } from "./ItemArtwork.js";

export type PlanningBuilderMode = "anchor" | "select" | "pencil" | "trees";

/** Planting planner: plants a Giving Tree at the grid point nearest the player. */
export type PlanningTreePlanting = Readonly<{
  canPlant: boolean;
  /** Why Plant is unavailable (shown instead of the button). */
  status: string;
  onPlant(): void;
}>;

export type PlanningAnchorDraft = Readonly<{
  source: PlanningAnchorSource;
  distanceM: number;
  position: { lat: number; lon: number };
}>;

const PLANNING_ANCHOR_DISTANCE_STEP_M = 0.01;

export type PlanningAnchorBuilderProps = Readonly<{
  mode: PlanningBuilderMode;
  source: PlanningAnchorSource | null;
  distanceInput: string;
  distanceM: number | null;
  draft: PlanningAnchorDraft | null;
  layers: readonly PlanningAnchorLayer[];
  anchors: readonly PlanningAnchor[];
  selectedLayerId: string;
  newLayerName: string;
  canCreateLayer: boolean;
  layersOpen: boolean;
  clearConfirmOpen: boolean;
  onDistanceInputChange(value: string): void;
  onSetDistance(): void;
  onLayerChange(layerId: string): void;
  onToggleLayer(layerId: string, visible: boolean): void;
  onNewLayerNameChange(value: string): void;
  onCreateLayer(): void;
  onClearLayer(): void;
  onCloseLayers(): void;
  onCloseClearConfirmation(): void;
  onAddDraft(): void;
  onCancelDraft(): void;
  treePlanting?: PlanningTreePlanting | undefined;
}>;

/**
 * Builder-only controls shared by the desktop and phone layouts. The map owns
 * pointer geometry; this surface owns only the compact, keyboard-accessible
 * actions and the device-local planning layer settings.
 */
export function PlanningAnchorBuilder({
  mode,
  source,
  distanceInput,
  distanceM,
  draft,
  layers,
  anchors,
  selectedLayerId,
  newLayerName,
  canCreateLayer,
  layersOpen,
  clearConfirmOpen,
  onDistanceInputChange,
  onSetDistance,
  onLayerChange,
  onToggleLayer,
  onNewLayerNameChange,
  onCreateLayer,
  onClearLayer,
  onCloseLayers,
  onCloseClearConfirmation,
  onAddDraft,
  onCancelDraft,
  treePlanting
}: PlanningAnchorBuilderProps): React.JSX.Element {
  const activeLayer = layers.find((layer) => layer.id === selectedLayerId) ?? layers[0] ?? null;
  const activeCount = anchors.filter((anchor) => anchor.layerId === selectedLayerId).length;
  const visibleLayers = layers.slice(0, 3);
  const distanceForAdjustment = validatePlanningAnchorDistance(Number(distanceInput)) ?? distanceM ?? 575;
  const adjustDistance = (delta: number): void => {
    const next = validatePlanningAnchorDistance(distanceForAdjustment + delta);
    if (next === null) return;
    onDistanceInputChange(String(next));
  };
  useEffect(() => {
    if (!draft || mode !== "anchor") return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onCancelDraft();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [draft, mode, onCancelDraft]);

  return <>
    {mode === "trees" && treePlanting ? <section
      className="planning-anchor-builder planning-tree-builder"
      aria-label="Tree planting controls"
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
    >
      {treePlanting.canPlant ? <GamePromptButton className="planning-tree-plant" tone="primary" onClick={treePlanting.onPlant}>
        <span className="planning-tree-plant-icon" aria-hidden="true">
          <img src={itemArtworkSource("giving_berry")} alt="" />
        </span>
        Plant
      </GamePromptButton> : <small role="status">{treePlanting.status}</small>}
    </section> : null}
    {mode === "anchor" ? <section
      className="planning-anchor-builder planning-anchor-builder-top"
      aria-label="Planning anchor controls"
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
    >
      <div className="planning-anchor-meter-box">
        <div className="planning-anchor-distance-stepper" role="group" aria-label="Adjust anchor distance">
          <GamePromptButton
            className="planning-anchor-distance-stepper-button"
            tone="secondary"
            aria-label="Decrease anchor distance"
            title="Decrease anchor distance"
            disabled={distanceForAdjustment <= PLANNING_ANCHOR_DISTANCE_STEP_M}
            onClick={() => adjustDistance(-PLANNING_ANCHOR_DISTANCE_STEP_M)}
          >
            −
          </GamePromptButton>
          <label className="game-compact-field planning-anchor-meter-field">
            <span className="sr-only">Distance (meters)</span>
            <input
              className="planning-anchor-meter-input"
              aria-label="Anchor distance in meters"
              inputMode="decimal"
              min="0.01"
              step="0.01"
              type="number"
              value={distanceInput}
              onChange={(event) => onDistanceInputChange(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  onSetDistance();
                }
              }}
            />
          </label>
          <GamePromptButton
            className="planning-anchor-distance-stepper-button"
            tone="secondary"
            aria-label="Increase anchor distance"
            title="Increase anchor distance"
            disabled={distanceForAdjustment >= MAX_PLANNING_ANCHOR_DISTANCE_M}
            onClick={() => adjustDistance(PLANNING_ANCHOR_DISTANCE_STEP_M)}
          >
            +
          </GamePromptButton>
        </div>
        <GamePromptButton
          className="planning-anchor-meter-apply"
          tone="secondary"
          aria-label="Set distance"
          title="Set distance"
          onClick={onSetDistance}
        >
          Set
        </GamePromptButton>
        <span className="sr-only" role="status">
          {source ? `${source.label}; ${distanceM === null ? "Enter a distance" : `${distanceM} meters`}` : "No source selected"}
        </span>
      </div>
    </section> : null}

    {draft && mode === "anchor" ? <GameConfirmationPrompt
      title="Add Anchor?"
      category="BUILDER"
      detail={`${draft.distanceM}m from ${draft.source.label}.`}
      confirmLabel="Add Anchor"
      cancelLabel="Cancel"
      onConfirm={onAddDraft}
      onCancel={onCancelDraft}
    /> : null}

    {layersOpen ? <GameActionPrompt
      title="Layers"
      category="BUILDER"
      detail={`${visibleLayers.length}/3 · ${activeLayer?.name ?? "Main"}`}
      content={<div className="game-compact-form">
        <div className="planning-anchor-layer-list" role="list" aria-label="Planning anchor layers">
          {visibleLayers.map((layer) => <div className="planning-anchor-layer-row" role="listitem" key={layer.id}>
            <GamePromptButton
              className="planning-anchor-layer-select"
              tone={layer.id === selectedLayerId ? "primary" : "secondary"}
              aria-label={`Select layer ${layer.name}`}
              aria-pressed={layer.id === selectedLayerId}
              onClick={() => onLayerChange(layer.id)}
            >
              <span>{layer.name}</span>
              <small>{anchors.filter((anchor) => anchor.layerId === layer.id).length} anchor{anchors.filter((anchor) => anchor.layerId === layer.id).length === 1 ? "" : "s"}</small>
            </GamePromptButton>
            <GamePromptButton
              className="planning-anchor-layer-visibility"
              tone="secondary"
              aria-label={`${layer.visible ? "Hide" : "Show"} layer ${layer.name}`}
              aria-pressed={layer.visible}
              title={`${layer.visible ? "Hide" : "Show"} ${layer.name}`}
              onClick={() => onToggleLayer(layer.id, !layer.visible)}
            >
              <PlanningLayerVisibilityGlyph visible={layer.visible} />
              <span className="sr-only">{layer.visible ? "Visible" : "Hidden"}</span>
            </GamePromptButton>
          </div>)}
        </div>
        <label className="game-compact-field planning-anchor-layer-name-field">
          <span>New layer</span>
          <input
            aria-label="New planning anchor layer name"
            type="text"
            maxLength={48}
            value={newLayerName}
            onChange={(event) => onNewLayerNameChange(event.target.value)}
          />
        </label>
        {visibleLayers.length >= 3 ? <small className="game-compact-disabled-reason">Layer cap reached (3).</small> : null}
      </div>}
      actions={[{
        key: "create-layer",
        label: "Create layer",
        enabled: canCreateLayer,
        disabledReason: canCreateLayer ? null : visibleLayers.length >= 3 ? "The planning layer cap is three." : "Enter a layer name first.",
        onSelect: onCreateLayer
      }]}
      onCancel={onCloseLayers}
    /> : null}
    {clearConfirmOpen ? <GameConfirmationPrompt
      title="Clear current layer?"
      category="BUILDER"
      detail={`Remove ${activeCount} saved anchor${activeCount === 1 ? "" : "s"} from ${activeLayer?.name ?? "Main"}.`}
      confirmLabel="Clear Current Layer"
      destructive
      onConfirm={() => {
        onCloseClearConfirmation();
        onClearLayer();
      }}
      onCancel={onCloseClearConfirmation}
    /> : null}
  </>;
}

function PlanningLayerVisibilityGlyph({ visible }: Readonly<{ visible: boolean }>): React.JSX.Element {
  return <svg
    viewBox="0 0 24 24"
    aria-hidden="true"
    data-planning-layer-visibility={visible ? "visible" : "hidden"}
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    {visible ? <>
      <path d="M3 12s3.5-6 9-6 9 6 9 6-3.5 6-9 6-9-6-9-6Z" />
      <circle cx="12" cy="12" r="2.5" />
    </> : <>
      <path d="m4 4 16 16" />
      <path d="M6.2 6.8C4.1 8.3 3 10.4 3 12c0 0 3.5 6 9 6 1.6 0 3-.4 4.2-1.1" />
      <path d="M9.5 5.9C10.3 5.6 11.1 5.4 12 5.4c5.5 0 9 6.6 9 6.6a16 16 0 0 1-2.1 2.7" />
    </>}
  </svg>;
}
