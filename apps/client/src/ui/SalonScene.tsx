import {
  DEFAULT_PLAYER_FACE_APPEARANCE_ID,
  DEFAULT_PLAYER_APPEARANCE_CATALOG,
  DEFAULT_PLAYER_BODY_VARIANT_ID,
  PLAYER_SKIN_TONE_IDS,
  PLAYER_SKIN_TONE_LABELS,
  SALON_SELECTABLE_APPEARANCE_CATEGORY_IDS,
  SALON_CHAIR,
  SALON_DOOR,
  SALON_FLOOR_SIZE,
  faceFeatureArea,
  isFaceFeatureCategory,
  playerBodyAssetKey,
  playerHeadAssetKey,
  playerSkinToneAssetKey,
  resolveFaceFeaturePoint,
  salonAppearanceOptions,
  type FaceFeatureCategoryId,
  type PlayerAnchorPoint,
  type PlayerAppearanceSnapshot,
  type PlayerSalonStyles,
  type SalonAppearanceCategoryId,
  type IndoorPoint,
  type SalonEditorSnapshot,
  type SalonSessionSnapshot
} from "@ash-atlas/shared";
import { playerAppearanceAssetUrl } from "@ash-atlas/player-renderer/asset-registry";
import { useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";

import { salonFixtureAt } from "../features/interiorMap/salonMapInterior.js";

import { useIndoorMovementInput } from "../movement/indoorMovementInput.js";
import type { SalonMovementTimeline } from "../movement/salonMovementTimeline.js";
import { GameActionPrompt } from "./GameActionPrompt.js";
import { IndoorSceneStage } from "./IndoorSceneStage.js";
import { IndoorSceneViewport } from "./IndoorSceneViewport.js";
import {
  GameAppShell,
  GameAppTabs
} from "./GameAppShell.js";
import {
  clampFeaturePointToArea,
  SalonPlayerLayer,
  SalonPlayerPreview,
  type PreviewFeatureEdit
} from "./SalonPlayerLayer.js";

type Props = {
  session: SalonSessionSnapshot;
  timeline: SalonMovementTimeline;
  editor: SalonEditorSnapshot | null;
  disabled: boolean;
  movementDisabled: boolean;
  saving: boolean;
  customizing: boolean;
  error: string | null;
  layout: "desktop" | "phone";
  onMove(x: number, y: number): void;
  onCustomize(): void;
  onSave(styles: PlayerSalonStyles): void;
  onCancelEditor(): void;
  onExit(): void;
  /** The map renderer draws the room and player; the scene keeps the prompts and the styling editor. */
  mapRendered?: boolean;
  /** Map taps in room units: selects the chair or door there, true when something was hit. */
  mapPickRef?: MutableRefObject<((local: IndoorPoint) => boolean) | null>;
};

type SalonEditorCategoryId = SalonAppearanceCategoryId | "skin-tone";

const CATEGORY_LABELS = {
  hair: "Hair",
  eyes: "Eyes",
  nose: "Nose",
  mouth: "Mouth",
  beard: "Beard",
  mask: "Mask",
  legs: "Legs"
} as const;
const CATEGORIES = [
  // Masks are worn from the inventory, never picked in the Salon.
  ...SALON_SELECTABLE_APPEARANCE_CATEGORY_IDS.filter((id) => id !== "mask").map((id) => ({
  id,
  label: CATEGORY_LABELS[id]
  })),
  { id: "skin-tone" as const, label: "Skin Color" }
] as const;
/** Share of the area's larger side one nudge tap moves a face feature. */
const FEATURE_NUDGE_FRACTION = 0.02;
const NUDGES = [
  { key: "left", label: "left", x: -1, y: 0, points: "15 5 8 12 15 19" },
  { key: "up", label: "up", x: 0, y: -1, points: "5 15 12 8 19 15" },
  { key: "down", label: "down", x: 0, y: 1, points: "5 9 12 16 19 9" },
  { key: "right", label: "right", x: 1, y: 0, points: "9 5 16 12 9 19" }
] as const;

/** The draggable feature for a face tab, or null when its art has no artist anchor. */
function salonFeatureEdit(
  categoryId: SalonEditorCategoryId,
  draft: PlayerSalonStyles,
  label: string,
  onChange: (categoryId: FaceFeatureCategoryId, point: PlayerAnchorPoint) => void
): PreviewFeatureEdit | null {
  if (!isFaceFeatureCategory(categoryId)) return null;
  const area = faceFeatureArea(DEFAULT_PLAYER_APPEARANCE_CATALOG, categoryId);
  const appearanceId = categoryId === "eyes"
    ? draft.eyes ?? DEFAULT_PLAYER_FACE_APPEARANCE_ID
    : draft[categoryId];
  const appearance = appearanceId
    ? DEFAULT_PLAYER_APPEARANCE_CATALOG.appearances.find((candidate) =>
      candidate.appearanceId === appearanceId)
    : undefined;
  const point = resolveFaceFeaturePoint(
    DEFAULT_PLAYER_APPEARANCE_CATALOG,
    categoryId,
    draft.featurePoints
  );
  if (!area || !point || !appearance?.featureAnchor) return null;
  return {
    label,
    point,
    polygon: area.polygon,
    onChange: (next) => onChange(categoryId, next)
  };
}

export function SalonScene(props: Props): React.JSX.Element {
  const [draft, setDraft] = useState<PlayerSalonStyles>({});
  const [selected, setSelected] = useState<"chair" | "door" | null>(null);
  const [activeCategory, setActiveCategory] = useState<SalonEditorCategoryId>("hair");
  const floorRef = useRef<HTMLDivElement>(null);
  const styleOptionsRef = useRef<HTMLDivElement>(null);

  useEffect(() => setDraft(props.editor ? {
    ...props.editor.styles,
    eyes: props.editor.styles.eyes ?? DEFAULT_PLAYER_FACE_APPEARANCE_ID,
    skinToneId: props.editor.styles.skinToneId ?? "light",
    featurePoints: { ...props.editor.styles.featurePoints }
  } : {}), [props.editor]);
  useEffect(() => {
    if (props.editor) setSelected(null);
  }, [props.editor]);
  useEffect(() => {
    if (styleOptionsRef.current) styleOptionsRef.current.scrollTop = 0;
  }, [activeCategory]);

  const movementInput = useIndoorMovementInput({
    stageRef: floorRef,
    roomWidth: SALON_FLOOR_SIZE,
    roomHeight: SALON_FLOOR_SIZE,
    movementDisabled: props.movementDisabled || Boolean(props.editor),
    onBeforeMove: () => setSelected(null),
    onMove: props.onMove
  });

  const previewAppearance = useMemo<PlayerAppearanceSnapshot | undefined>(() => {
    if (!props.session.appearance) return undefined;
    return {
      ...props.session.appearance,
      styles: { ...props.session.appearance.styles, ...draft }
    };
  }, [draft, props.session.appearance]);
  const options = activeCategory === "skin-tone"
    ? []
    : salonAppearanceOptions(DEFAULT_PLAYER_APPEARANCE_CATALOG, activeCategory);
  const selectedStyle = activeCategory === "skin-tone"
    ? null
    : draft[activeCategory as SalonAppearanceCategoryId] ?? null;
  const activeCategoryLabel = CATEGORIES.find(({ id }) => id === activeCategory)?.label ?? "Styles";
  const featureEdit = useMemo(() => salonFeatureEdit(
    activeCategory,
    draft,
    activeCategoryLabel.toLowerCase(),
    (categoryId, point) => setDraft((current) => ({
      ...current,
      featurePoints: { ...current.featurePoints, [categoryId]: point }
    }))
  ), [activeCategory, activeCategoryLabel, draft]);
  const nudgeFeature = (x: number, y: number): void => {
    if (!featureEdit) return;
    const xs = featureEdit.polygon.map((vertex) => vertex.x);
    const ys = featureEdit.polygon.map((vertex) => vertex.y);
    const step = FEATURE_NUDGE_FRACTION * Math.max(
      Math.max(...xs) - Math.min(...xs),
      Math.max(...ys) - Math.min(...ys)
    );
    const next = clampFeaturePointToArea(featureEdit.point, {
      x: featureEdit.point.x + x * step,
      y: featureEdit.point.y + y * step
    }, featureEdit.polygon);
    if (next !== featureEdit.point) featureEdit.onChange(next);
  };
  const resetFeature = (): void => {
    if (!isFaceFeatureCategory(activeCategory)) return;
    setDraft((current) => {
      const featurePoints = { ...current.featurePoints };
      delete featurePoints[activeCategory];
      return { ...current, featurePoints };
    });
  };
  const featureMoved = isFaceFeatureCategory(activeCategory) &&
    Boolean(draft.featurePoints?.[activeCategory]);
  const point = (value: number): string => `${value / SALON_FLOOR_SIZE * 100}%`;
  const chooseObject = (kind: "chair" | "door") => (event: React.MouseEvent): void => {
    event.stopPropagation();
    setSelected(kind);
  };

  const prompts = <>
      {selected === "chair" && !props.editor ? <GameActionPrompt
        title="Styling Chair"
        category="SALON"
        message={props.error ? { text: props.error, tone: "error" } : null}
        actions={[{
          key: "customize",
          label: props.customizing ? "Approaching Chair" : "Customize Appearance",
          enabled: !props.disabled,
          busy: props.customizing,
          disabledReason: props.disabled ? "The Salon is unavailable while disconnected." : null,
          onSelect: () => {
            setSelected(null);
            props.onCustomize();
          }
        }]}
        onCancel={() => setSelected(null)}
      /> : null}

      {selected === "door" && !props.editor ? <GameActionPrompt
        title="Salon Door"
        category="PORTAL"
        actions={[{
          key: "leave",
          label: "Leave Salon",
          enabled: !props.disabled,
          disabledReason: props.disabled ? "The doorway is unavailable while disconnected." : null,
          onSelect: () => {
            setSelected(null);
            props.onExit();
          }
        }]}
        onCancel={() => setSelected(null)}
      /> : null}
  </>;
  const editorShell = (
    <GameAppShell
      open={Boolean(props.editor)}
      title="Choose Your Look"
      closeLabel="Cancel styling"
      className="salon-editor-shell"
      layout={props.layout}
      phoneBackLabel="Back to Salon"
      closeDisabled={props.saving}
      onClose={props.onCancelEditor}
    >
      <div className="salon-editor-layout">
        <section className="salon-preview-panel" aria-label="Character preview">
          <SalonPlayerPreview
            displayColor={props.session.displayColor}
            {...(previewAppearance ? { appearance: previewAppearance } : {})}
            featureEdit={featureEdit}
          />
          {featureEdit ? <div
            className="salon-feature-controls"
            role="group"
            aria-label={`Move ${featureEdit.label}`}
          >
            {NUDGES.map((nudge) => <button
              key={nudge.key}
              type="button"
              aria-label={`Move ${featureEdit.label} ${nudge.label}`}
              onClick={() => nudgeFeature(nudge.x, nudge.y)}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <polyline points={nudge.points} />
              </svg>
            </button>)}
            <button
              type="button"
              className="salon-feature-reset"
              disabled={!featureMoved}
              onClick={resetFeature}
            >Reset</button>
          </div> : null}
          <button
            type="button"
            className="salon-save-button"
            disabled={props.saving}
            onClick={() => props.onSave(draft)}
          >{props.saving ? "Saving…" : "Save"}</button>
        </section>
        <section className="salon-style-browser" aria-label="Salon style categories">
          <GameAppTabs
            tabs={CATEGORIES.map(({ id, label }) => ({ id, label }))}
            activeTab={activeCategory}
            ariaLabel="Salon style categories"
            variant="housed"
            scrollable
            onChange={(id) => setActiveCategory(id as SalonEditorCategoryId)}
          />
          <div
            ref={styleOptionsRef}
            className="salon-style-options"
            role="tabpanel"
            aria-label={`${activeCategoryLabel} styles`}
          >
              {activeCategory === "skin-tone" ? PLAYER_SKIN_TONE_IDS.map((skinToneId) => {
                const assetKey = playerSkinToneAssetKey(
                  DEFAULT_PLAYER_APPEARANCE_CATALOG,
                  DEFAULT_PLAYER_BODY_VARIANT_ID,
                  skinToneId
                ) ?? playerBodyAssetKey(
                  DEFAULT_PLAYER_APPEARANCE_CATALOG,
                  DEFAULT_PLAYER_BODY_VARIANT_ID,
                  "idle"
                );
                const headAssetKey = assetKey ? playerHeadAssetKey(
                  DEFAULT_PLAYER_APPEARANCE_CATALOG,
                  DEFAULT_PLAYER_BODY_VARIANT_ID,
                  "idle",
                  skinToneId
                ) : null;
                return <label
                  key={skinToneId}
                  className={draft.skinToneId === skinToneId ? "selected" : undefined}
                >
                  <input
                    type="radio"
                    name="salon-skin-tone"
                    checked={draft.skinToneId === skinToneId}
                    onChange={() => setDraft((current) => ({ ...current, skinToneId }))}
                  />
                  {assetKey ? headAssetKey ? <span className="salon-option-preview salon-option-stack" aria-hidden="true">
                    <img src={playerAppearanceAssetUrl(assetKey) ?? undefined} alt="" />
                    <img src={playerAppearanceAssetUrl(headAssetKey) ?? undefined} alt="" />
                  </span> : <img
                    className="salon-option-preview"
                    src={playerAppearanceAssetUrl(assetKey) ?? undefined}
                    alt=""
                  /> : <span className="salon-option-default" aria-hidden="true" />}
                  <strong>{PLAYER_SKIN_TONE_LABELS[skinToneId]}</strong>
                </label>;
              }) : activeCategory !== "eyes" ? <label
                className={selectedStyle === null ? "selected" : undefined}
              >
                <input
                  type="radio"
                  name={`salon-${activeCategory}`}
                  checked={selectedStyle === null}
                  onChange={() => setDraft((current) => ({
                    ...current,
                    [activeCategory as SalonAppearanceCategoryId]: null
                  }))}
                />
                <span className="salon-option-default" aria-hidden="true">{activeCategory === "nose" || activeCategory === "mouth" ? "None" : "Default"}</span>
                <strong>{activeCategory === "nose" || activeCategory === "mouth" ? "None" : "Default"}</strong>
              </label> : null}
              {options.map((option) => <label
                key={option.appearanceId}
                className={selectedStyle === option.appearanceId ? "selected" : undefined}
              >
                <input
                  type="radio"
                  name={`salon-${activeCategory}`}
                  checked={selectedStyle === option.appearanceId}
                  onChange={() => setDraft((current) => ({
                    ...current,
                    [activeCategory as SalonAppearanceCategoryId]: option.appearanceId
                  }))}
                />
                {option.assetKey ? <img
                  className="salon-option-preview"
                  src={playerAppearanceAssetUrl(option.assetKey) ?? undefined}
                  alt=""
                /> : <span className="salon-option-default" aria-hidden="true" />}
                <strong>{option.displayName}</strong>
              </label>)}
          </div>
        </section>
      </div>
    </GameAppShell>
  );
  if (props.mapPickRef) {
    props.mapPickRef.current = props.mapRendered ? (local: IndoorPoint): boolean => {
      if (props.editor) return true;
      const fixture = salonFixtureAt(local);
      // Disabled fixtures let the tap through, like the DOM scene's disabled buttons.
      if (fixture === "chair" && !props.disabled && !props.customizing) {
        setSelected("chair");
        return true;
      }
      if (fixture === "door" && !props.disabled) {
        setSelected("door");
        return true;
      }
      setSelected(null);
      return false;
    } : null;
  }
  if (props.mapRendered) {
    // The map renderer draws the floor, mirror, door, chair and player (INTERIOR_MAP_RENDERER.md P4).
    return <>
      <IndoorSceneViewport className="interior-map-hud salon-map-hud" ariaLabel="Salon interior">
        {prompts}
      </IndoorSceneViewport>
      {editorShell}
    </>;
  }
  return <>
    <IndoorSceneViewport className="salon-scene" ariaLabel="Salon interior">
      <IndoorSceneStage
      roomWidth={SALON_FLOOR_SIZE}
      roomHeight={SALON_FLOOR_SIZE}
      innerClassName="salon-room"
      stageRef={floorRef}
      onClick={movementInput.onClick}
      onDoubleClick={movementInput.onDoubleClick}
      onPointerDownCapture={movementInput.onPointerDownCapture}
      onPointerMove={movementInput.onPointerMove}
      onPointerUp={movementInput.onPointerUp}
      onPointerCancel={movementInput.onPointerCancel}
      onLostPointerCapture={movementInput.onLostPointerCapture}
      >
        <div className="salon-mirror" aria-hidden="true"><span>SALON</span></div>
        <button
        className="salon-chair"
        type="button"
        disabled={props.disabled || props.customizing}
        style={{ left: point(SALON_CHAIR.x), top: point(SALON_CHAIR.y) }}
        onPointerDown={(event) => event.stopPropagation()}
        onPointerUp={(event) => event.stopPropagation()}
        onDoubleClick={(event) => event.stopPropagation()}
        onClick={chooseObject("chair")}
        aria-label="Styling chair"
        ><span aria-hidden="true" /></button>
        <button
        className="salon-door"
        type="button"
        disabled={props.disabled}
        style={{ left: point(SALON_DOOR.x), top: point(SALON_DOOR.y) }}
        onPointerDown={(event) => event.stopPropagation()}
        onPointerUp={(event) => event.stopPropagation()}
        onDoubleClick={(event) => event.stopPropagation()}
        onClick={chooseObject("door")}
        aria-label="Salon door"
        ><span aria-hidden="true" /></button>
        <SalonPlayerLayer
          timeline={props.timeline}
          displayColor={props.session.displayColor}
          {...(props.session.appearance ? { appearance: props.session.appearance } : {})}
        />
      </IndoorSceneStage>

      {prompts}
    </IndoorSceneViewport>

    {editorShell}
  </>;
}
