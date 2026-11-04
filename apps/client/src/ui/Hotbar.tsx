import {
  FIELD_CONSUMABLE_NAMES,
  HOTBAR_PLAYER_SLOT_IDS,
  type HotbarActionId,
  type HotbarBinding,
  type HotbarPlayerSlot,
  type PlayerInventorySnapshot
} from "@ash-atlas/shared";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { GameActionPrompt, GamePromptButton } from "./GameActionPrompt.js";
import { GearSlot, type GearSlotSet } from "./GearSlot.js";
import { ItemArtwork } from "./ItemArtwork.js";
import { ProtectionLockIcon } from "./ProtectionLockIcon.js";
import { UtilityHotbarLayoutEditor } from "./UtilityHotbarLayoutEditor.js";
import {
  HOTBAR_DEFAULT_KEYBINDS,
  type HotbarKeybind
} from "../input/keybindRegistry.js";
import {
  HOTBAR_DESKTOP_ROW_HEIGHT_PX,
  HOTBAR_DEFAULT_ROW_HEIGHT_PX,
  HOTBAR_DEFAULT_ROW_POSITIONS,
  HOTBAR_DEFAULT_VISIBLE_ROWS,
  HOTBAR_ROW_VISUAL_GAP_PX,
  fitHotbarLayoutGeometry,
  type HotbarLayoutGeometry,
  normalizeHotbarRowPositions
} from "@ash-atlas/shared";
import {
  activateHotbarBinding,
  HOTBAR_CHOICE_CATEGORIES,
  hotbarBindingKey,
  hotbarChoiceCategory,
  hotbarHealNextTickAt,
  hotbarHealTicksDone,
  hotbarItemChoices,
  isHotbarSlotUnlocked,
  HOTBAR_SLOT_LAYOUT,
  resolveHotbarBinding,
  sameHotbarSlots,
  type HotbarActivatableItem,
  type HotbarChoiceCategory,
  type HotbarHealEffect,
  type HotbarItemChoice
} from "../hotbar/hotbarModel.js";
import { activeUiScale } from "./uiScale.js";
import { useUiPresentation } from "../uiEnvironment.js";

export type { HotbarKeybind } from "../input/keybindRegistry.js";

export type HotbarProps = Readonly<{
  slots: readonly HotbarPlayerSlot[];
  inventory: PlayerInventorySnapshot;
  inventorySnapshotAvailable: boolean;
  online: boolean;
  keybinds?: readonly HotbarKeybind[];
  showKeyLabels?: boolean;
  visible?: boolean;
  /** Number of paired rows to render (0 hides the hotbar in the parent). */
  visibleRows?: number;
  /** One percentage anchor per possible row, top to bottom. */
  rowPositions?: readonly number[];
  disabled?: boolean;
  saveState?: "loading" | "ready" | "saving" | "error";
  saveError?: string | null;
  layoutEdit?: Readonly<{ rowCount: number; rowPositions: readonly number[] }> | null;
  onSlotsChange(next: HotbarPlayerSlot[]): void;
  onLayoutEditDone?(rowCount: number, rowPositions: readonly number[]): void;
  onLayoutEditCancel?(): void;
  onUseConsumable(itemId: string, stackId: string): boolean;
  onFishWithRod(rodId: string): boolean;
  /** Server-driven heal-over-time timers by consumable id; the slot shows a draining ring while one runs. */
  healEffects?: Readonly<Record<string, HotbarHealEffect | null>> | undefined;
  /** Flag/buoy build state for the anchor_build action slot; null where building is unavailable. */
  anchorBuild?: HotbarAnchorBuild | null;
  /** Press handlers for the Plant Sapling and Shovel (dig) action slots; a missing entry means unavailable here. */
  utilityActions?: HotbarUtilityActions | undefined;
  /** Developer preview of the Gear slot gesture (sample sets, local only, nothing is equipped). */
  gearPreview?: boolean;
  /** Carried Loadout Scrolls fanned by the Gear slot (positions 1..count, at most three). */
  gearScrolls?: Readonly<{ count: number; currentPosition: number | null; onEquip(position: number): boolean }> | undefined;
}>;

const GEAR_SCROLL_COLORS = ["#5b7fa6", "#b8453a", "#c9a24a"] as const;

/** Sample sets for the developer Gear slot preview until gear sets exist. */
const PREVIEW_GEAR_SETS: readonly GearSlotSet[] = [
  { name: "Set 1 · Tank", color: "#5b7fa6" },
  { name: "Set 2 · Striker", color: "#b8453a" },
  { name: "Set 3 · Scout", color: "#c9a24a" }
];

export type HotbarAnchorBuild = Readonly<{
  /** What this spot supports; null while the surface is still being checked. */
  kind: "flag" | "buoy" | null;
  /** The player's chosen personal flag color (hex); null falls back to the theme text color. */
  color?: string | null;
  /** A press does something (places, or explains missing materials). */
  pressable: boolean;
  /** Short reason shown when a press would do nothing. */
  unavailableReason: string | null;
  onPlace(): void;
  onPlan(): void;
}>;

export type HotbarUtilityActions = Partial<Record<Exclude<HotbarActionId, "anchor_build">, Readonly<{
  /** A press can do something right now (the action explains itself when it cannot). */
  pressable: boolean;
  onPress(): void;
  /** Hold opens this instead of the slot options (Plant Sapling opens the tree planting grid). */
  onHold?: (() => void) | undefined;
}>>>;
type HotbarUtilityActionId = keyof HotbarUtilityActions;
const UTILITY_ACTION_ITEM: Readonly<Record<HotbarUtilityActionId, { itemId: string; name: string; hint: string }>> = {
  plant_sapling: { itemId: "giving_berry", name: "Plant Sapling", hint: "Plants a Giving Tree where you stand; hold for the planting grid" },
  dig_treasure: { itemId: "shovel", name: "Shovel", hint: "Digs the nearest buried treasure within reach" }
};
const UTILITY_ACTION_IDS = Object.keys(UTILITY_ACTION_ITEM) as HotbarUtilityActionId[];
function utilityActionId(binding: HotbarBinding | null): HotbarUtilityActionId | null {
  return binding?.kind === "action" && binding.actionId !== "anchor_build" ? binding.actionId : null;
}

const ANCHOR_BUILD_BINDING: HotbarBinding = { kind: "action", actionId: "anchor_build" };

export function Hotbar({
  slots,
  inventory,
  inventorySnapshotAvailable,
  online,
  keybinds = HOTBAR_DEFAULT_KEYBINDS,
  showKeyLabels = true,
  visible = true,
  visibleRows = HOTBAR_DEFAULT_VISIBLE_ROWS,
  rowPositions = HOTBAR_DEFAULT_ROW_POSITIONS,
  disabled = false,
  saveState = "ready",
  saveError = null,
  layoutEdit = null,
  onSlotsChange,
  onLayoutEditDone,
  onLayoutEditCancel,
  onUseConsumable,
  onFishWithRod,
  healEffects,
  anchorBuild = null,
  utilityActions,
  gearPreview = false,
  gearScrolls
}: HotbarProps): React.JSX.Element {
  const [previewGearSet, setPreviewGearSet] = useState(0);
  const safeSlots = useMemo(() => {
    const byId = new Map(slots.map((slot) => [slot.slotId, slot]));
    return HOTBAR_PLAYER_SLOT_IDS.map((slotId) => byId.get(slotId) ?? ({ slotId, binding: null }));
  }, [slots]);
  const safeVisibleRows = Math.min(5, Math.max(0, Math.trunc(visibleRows)));
  const hotbarRef = useRef<HTMLElement | null>(null);
  const naturalRowHeightRef = useRef<number | null>(null);
  const viewportProfileRef = useRef<boolean | null>(null);
  const [layoutGeometry, setLayoutGeometry] = useState<HotbarLayoutGeometry | null>(null);
  const [layoutEditDraft, setLayoutEditDraft] = useState<{
    rowCount: number;
    rowPositions: number[];
  } | null>(null);
  const layoutEditDraftRef = useRef(layoutEditDraft);
  useLayoutEffect(() => {
    if (!layoutEdit) {
      layoutEditDraftRef.current = null;
      setLayoutEditDraft(null);
      return;
    }
    const next = {
      rowCount: Math.min(5, Math.max(0, Math.trunc(layoutEdit.rowCount))),
      rowPositions: [...layoutEdit.rowPositions]
    };
    layoutEditDraftRef.current = next;
    setLayoutEditDraft(next);
  }, [layoutEdit]);
  const editingLayout = layoutEditDraft !== null;
  const renderedRowCount = editingLayout
    ? Math.min(5, Math.max(0, Math.trunc(layoutEditDraft.rowCount)))
    : safeVisibleRows;
  const renderedRowPositions = editingLayout ? layoutEditDraft.rowPositions : rowPositions;
  const safeRowPositions = useMemo(
    () => normalizeHotbarRowPositions(renderedRowCount, renderedRowPositions, layoutGeometry ?? undefined),
    [layoutGeometry, renderedRowCount, renderedRowPositions]
  );
  const choices = useMemo(() => hotbarItemChoices(inventory), [inventory]);
  const [pickerSlotId, setPickerSlotId] = useState<HotbarPlayerSlot["slotId"] | null>(null);
  const [draggedSlotId, setDraggedSlotId] = useState<HotbarPlayerSlot["slotId"] | null>(null);
  const draggedBindingRef = useRef<HotbarBinding | null>(null);
  const onSlotsChangeRef = useRef(onSlotsChange);
  const onUseConsumableRef = useRef(onUseConsumable);
  const onFishWithRodRef = useRef(onFishWithRod);
  onSlotsChangeRef.current = onSlotsChange;
  onUseConsumableRef.current = onUseConsumable;
  onFishWithRodRef.current = onFishWithRod;

  useEffect(() => {
    if (pickerSlotId && !HOTBAR_PLAYER_SLOT_IDS.includes(pickerSlotId)) setPickerSlotId(null);
  }, [pickerSlotId]);

  useEffect(() => {
    if (!visible) {
      setPickerSlotId(null);
      setDraggedSlotId(null);
      draggedBindingRef.current = null;
    }
  }, [visible]);

  // Hidden rails stay laid out (they slide off-screen), so geometry keeps measuring.
  useLayoutEffect(() => {
    if (renderedRowCount === 0) {
      setLayoutGeometry(null);
      return;
    }
    const hotbar = hotbarRef.current;
    if (!hotbar) return;
    const measure = (): void => {
      // Geometry is written back as CSS inside the zoomed track, so measure in
      // interface-size scaled pixels rather than screen pixels.
      const scale = activeUiScale();
      const trackHeight = hotbar.getBoundingClientRect().height / scale;
      const slotHeight = (hotbar.querySelector<HTMLElement>(".ash-hotbar-slot")?.getBoundingClientRect().height ?? 0) / scale;
      if (trackHeight <= 0 || slotHeight <= 0) {
        setLayoutGeometry(null);
        return;
      }
      const phoneViewport = typeof window.matchMedia === "function"
        ? window.matchMedia("(max-width: 700px)").matches
        : null;
      const profileChanged = phoneViewport !== null && viewportProfileRef.current !== phoneViewport;
      if (phoneViewport !== null) viewportProfileRef.current = phoneViewport;
      const profileRowHeight = phoneViewport === null
        ? slotHeight
        : phoneViewport ? HOTBAR_DEFAULT_ROW_HEIGHT_PX : HOTBAR_DESKTOP_ROW_HEIGHT_PX;
      if (profileChanged || naturalRowHeightRef.current === null) {
        naturalRowHeightRef.current = profileRowHeight;
      } else if (slotHeight > naturalRowHeightRef.current) {
        naturalRowHeightRef.current = slotHeight;
      }
      const naturalRowHeight = phoneViewport === null
        ? slotHeight
        : profileChanged
          ? profileRowHeight
          : Math.max(profileRowHeight, naturalRowHeightRef.current ?? profileRowHeight);
      const measuredGeometry = fitHotbarLayoutGeometry({
        trackHeight,
        rowHeight: naturalRowHeight,
        rowGap: HOTBAR_ROW_VISUAL_GAP_PX
      }, renderedRowCount);
      setLayoutGeometry((current) => current && current.trackHeight === measuredGeometry.trackHeight && current.rowHeight === measuredGeometry.rowHeight && current.rowGap === measuredGeometry.rowGap && current.compactTrackHeight === measuredGeometry.compactTrackHeight
        ? current
        : measuredGeometry);
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(hotbar);
    hotbar.querySelectorAll<HTMLElement>(".ash-hotbar-row, .ash-hotbar-slot").forEach((element) => observer?.observe(element));
    window.addEventListener("resize", measure);
    const scaleObserver = typeof MutationObserver === "undefined" ? null : new MutationObserver(measure);
    scaleObserver?.observe(document.documentElement, { attributes: true, attributeFilter: ["data-ui-scale", "data-presentation"] });
    window.addEventListener("orientationchange", measure);
    window.visualViewport?.addEventListener("resize", measure);
    const frame = window.requestAnimationFrame(measure);
    return () => {
      window.cancelAnimationFrame(frame);
      observer?.disconnect();
      scaleObserver?.disconnect();
      window.removeEventListener("resize", measure);
      window.removeEventListener("orientationchange", measure);
      window.visualViewport?.removeEventListener("resize", measure);
    };
  }, [editingLayout, renderedRowCount]);

  const updateBinding = (slotId: HotbarPlayerSlot["slotId"], binding: HotbarBinding | null): void => {
    const next = safeSlots.map((slot) => slot.slotId === slotId ? { ...slot, binding } : slot);
    if (!sameHotbarSlots(next, safeSlots)) onSlotsChangeRef.current(next);
    setPickerSlotId(null);
  };

  const moveBinding = (targetSlotId: HotbarPlayerSlot["slotId"], sourceBinding: HotbarBinding): void => {
    const sourceSlot = draggedSlotId ? safeSlots.find((slot) => slot.slotId === draggedSlotId) : null;
    const next = safeSlots.map((slot) => {
      if (slot.slotId === targetSlotId) return { ...slot, binding: sourceBinding };
      if (sourceSlot && slot.slotId === sourceSlot.slotId) return { ...slot, binding: safeSlots.find((candidate) => candidate.slotId === targetSlotId)?.binding ?? null };
      return slot;
    });
    if (!sameHotbarSlots(next, safeSlots)) onSlotsChangeRef.current(next);
    setDraggedSlotId(null);
    draggedBindingRef.current = null;
  };

  const moveSlot = (
    sourceSlotId: HotbarPlayerSlot["slotId"],
    targetSlotId: HotbarPlayerSlot["slotId"]
  ): void => {
    if (sourceSlotId === targetSlotId) return;
    const source = safeSlots.find((slot) => slot.slotId === sourceSlotId);
    const target = safeSlots.find((slot) => slot.slotId === targetSlotId);
    if (!source?.binding || !target || !isSlotUnlocked(sourceSlotId, renderedRowCount) || !isSlotUnlocked(targetSlotId, renderedRowCount)) return;
    const next = safeSlots.map((slot) =>
      slot.slotId === sourceSlotId
        ? { ...slot, binding: target.binding }
        : slot.slotId === targetSlotId
          ? { ...slot, binding: source.binding }
          : slot
    );
    if (!sameHotbarSlots(next, safeSlots)) onSlotsChangeRef.current(next);
  };

  const pickerSlot = visible && !editingLayout && pickerSlotId && isSlotUnlocked(pickerSlotId, safeVisibleRows)
    ? safeSlots.find((slot) => slot.slotId === pickerSlotId) ?? null
    : null;

  const rowLayouts = (side: "left" | "right") => Array.from({ length: renderedRowCount }, (_, row) => ({
    row,
    slot: HOTBAR_SLOT_LAYOUT.find((candidate) => candidate.side === side && candidate.index === row)!
  }));

  return <>
    <aside
      id="player-utility-hotbar"
      className="ash-hotbar"
      ref={hotbarRef}
      aria-label="Utility hotbar"
      data-save-state={saveState}
      data-layout-measured={layoutGeometry ? "true" : "false"}
      data-layout-editing={editingLayout ? "true" : "false"}
      hidden={renderedRowCount === 0}
      data-shown={visible || editingLayout ? "true" : "false"}
      inert={!visible && !editingLayout}
      style={layoutGeometry ? {
        "--ash-hotbar-row-height": `${layoutGeometry.rowHeight}px`
      } as React.CSSProperties : undefined}
    >
      {(["left", "right"] as const).map((side) => <div key={side} className={`ash-hotbar-rail ash-hotbar-rail-${side}`} aria-label={`${side === "left" ? "Left" : "Right"} utility slots`}>
        {rowLayouts(side).map(({ row, slot: layout }) => (
          <div
            key={layout.slotId}
            className={`ash-hotbar-row${editingLayout ? " is-layout-editing" : ""}`}
            data-hotbar-row={row + 1}
            style={{ "--ash-hotbar-row-position": `${safeRowPositions[row] ?? 0}%` } as React.CSSProperties}
          >
            {(gearScrolls || gearPreview) && !editingLayout && side === "left" && row === Math.max(0, renderedRowCount - 2) ? <GearSlot
              side={side}
              sets={gearScrolls
                ? Array.from({ length: gearScrolls.count }, (_, index) => ({ name: `Scroll ${index + 1}`, color: GEAR_SCROLL_COLORS[index] ?? GEAR_SCROLL_COLORS[0] }))
                : PREVIEW_GEAR_SETS}
              currentIndex={gearScrolls ? Math.max(0, (gearScrolls.currentPosition ?? 1) - 1) : previewGearSet}
              disabled={disabled || (gearScrolls !== undefined && !online)}
              onEquip={gearScrolls ? (index) => { gearScrolls.onEquip(index + 1); } : setPreviewGearSet}
            /> : <HotbarSlotButton
              onActivateGearScroll={(position) => { gearScrolls?.onEquip(position); }}
              layout={layout}
              slot={safeSlots.find((candidate) => candidate.slotId === layout.slotId)!}
              inventory={inventory}
              inventorySnapshotAvailable={inventorySnapshotAvailable}
              online={online}
              unlocked={isSlotUnlocked(layout.slotId, renderedRowCount)}
              disabled={disabled || editingLayout}
              editing={editingLayout}
              showKeyLabel={showKeyLabels}
              keybind={keybinds[layout.side === "left" ? layout.index : layout.index + 5] ?? layout.keyLabel}
              onOpenPicker={setPickerSlotId}
              onDragStart={(slotId, binding) => {
                setDraggedSlotId(slotId);
                draggedBindingRef.current = binding;
              }}
              onDragEnd={() => {
                setDraggedSlotId(null);
                draggedBindingRef.current = null;
              }}
              onDrop={(slotId) => {
                const binding = draggedBindingRef.current;
                if (binding && !editingLayout && isSlotUnlocked(slotId, renderedRowCount)) moveBinding(slotId, binding);
              }}
              onActivate={(binding, item) => activateHotbarBinding(binding, item, onUseConsumableRef.current, onFishWithRodRef.current)}
              anchorBuild={anchorBuild}
              utilityActions={utilityActions}
              healEffects={healEffects}
            />}
          </div>
        ))}
      </div>)}
      {saveState === "saving" ? <span className="ash-hotbar-status" role="status">Saving hotbar…</span> : null}
      {saveState === "error" && saveError ? <span className="ash-hotbar-status ash-hotbar-status-error" role="alert">{saveError}</span> : null}
    </aside>
    {editingLayout ? <UtilityHotbarLayoutEditor
      rowCount={renderedRowCount}
      rowPositions={layoutEditDraft.rowPositions}
      trackRef={hotbarRef}
      {...(layoutGeometry ? { geometry: layoutGeometry } : {})}
      onLayoutChange={(nextPositions) => {
        const current = layoutEditDraftRef.current;
        if (!current) return;
        const next = { rowCount: current.rowCount, rowPositions: [...nextPositions] };
        layoutEditDraftRef.current = next;
        setLayoutEditDraft(next);
      }}
      onDone={() => {
        const current = layoutEditDraftRef.current;
        if (!current) return;
        onLayoutEditDone?.(current.rowCount, [...current.rowPositions]);
      }}
      onCancel={() => onLayoutEditCancel?.()}
    /> : null}
    {pickerSlot ? <HotbarPicker
      key={pickerSlot.slotId}
      slot={pickerSlot}
      choices={choices}
      anchorBuild={anchorBuild}
      onSelectBinding={(binding) => updateBinding(pickerSlot.slotId, binding)}
      onPlan={() => {
        setPickerSlotId(null);
        anchorBuild?.onPlan();
      }}
      onSelect={(choice) => updateBinding(pickerSlot.slotId, choice.binding)}
      onClear={() => updateBinding(pickerSlot.slotId, null)}
      onCancel={() => setPickerSlotId(null)}
      onMove={(targetSlotId) => {
        moveSlot(pickerSlot.slotId, targetSlotId);
        setPickerSlotId(null);
      }}
      onDragStart={(binding) => {
        setDraggedSlotId(null);
        draggedBindingRef.current = binding;
      }}
      onDragEnd={() => {
        setDraggedSlotId(null);
        draggedBindingRef.current = null;
      }}
    /> : null}
  </>;
}

function HotbarSlotButton({
  layout,
  slot,
  inventory,
  inventorySnapshotAvailable,
  online,
  unlocked,
  disabled,
  editing,
  showKeyLabel,
  keybind,
  onOpenPicker,
  onDragStart,
  onDragEnd,
  onDrop,
  onActivate,
  onActivateGearScroll,
  anchorBuild,
  utilityActions,
  healEffects
}: Readonly<{
  layout: (typeof HOTBAR_SLOT_LAYOUT)[number];
  slot: HotbarPlayerSlot;
  inventory: PlayerInventorySnapshot;
  inventorySnapshotAvailable: boolean;
  online: boolean;
  unlocked: boolean;
  disabled: boolean;
  editing: boolean;
  showKeyLabel: boolean;
  keybind: string;
  onOpenPicker(slotId: HotbarPlayerSlot["slotId"]): void;
  onDragStart(slotId: HotbarPlayerSlot["slotId"], binding: HotbarBinding): void;
  onDragEnd(): void;
  onDrop(slotId: HotbarPlayerSlot["slotId"]): void;
  onActivate(binding: HotbarBinding, item: HotbarActivatableItem): void;
  onActivateGearScroll?(position: number): void;
  anchorBuild: HotbarAnchorBuild | null;
  utilityActions: HotbarUtilityActions | undefined;
  healEffects: HotbarProps["healEffects"];
}>): React.JSX.Element {
  const longPressTimerRef = useRef<number | null>(null);
  const longPressedRef = useRef(false);
  /** A touch tap that activated the slot on pointerup (see onPointerUp): the click that may follow is the same tap. */
  const tapHandledRef = useRef(false);
  const tapStartRef = useRef<{ id: number; x: number; y: number } | null>(null);
  const clearLongPress = (): void => {
    if (longPressTimerRef.current !== null) {
      window.clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  };
  useEffect(() => () => {
    if (longPressTimerRef.current !== null) window.clearTimeout(longPressTimerRef.current);
  }, []);
  const resolution = resolveHotbarBinding(slot.binding, inventory);
  const item = resolution?.item ?? null;
  const hasUsableItem = resolution?.actionable === true && item !== null;
  const buildSlot = slot.binding?.kind === "action" && slot.binding.actionId === "anchor_build";
  const buildPressable = buildSlot && unlocked && !disabled && online && anchorBuild?.pressable === true;
  const utilityId = utilityActionId(slot.binding);
  const utility = utilityId ? utilityActions?.[utilityId] ?? null : null;
  const utilityPressable = utilityId !== null && unlocked && !disabled && online && utility?.pressable === true;
  const actionable = buildSlot ? buildPressable : utilityId ? utilityPressable : unlocked && !disabled && online && inventorySnapshotAvailable && hasUsableItem;
  const desktop = useUiPresentation() === "desktop";
  const planHint = desktop ? "hold the mouse button for planning mode" : "hold for planning mode";
  const buildLabel = !anchorBuild
    ? "Flag or buoy builder, unavailable here"
    : anchorBuild.kind === null
      ? `Flag or buoy builder, checking this spot; ${planHint}`
      : `Place ${anchorBuild.kind} where you are standing${buildPressable ? "" : `, unavailable${anchorBuild.unavailableReason ? `: ${anchorBuild.unavailableReason}` : ""}`}; ${planHint}`;
  // Hold opens the planner (as the former floating flag did); where building is unavailable,
  // hold opens the slot options instead. A mouse right-click always opens options.
  const holdOpensPlanner = buildSlot && anchorBuild !== null;
  const utilityHold = utilityId !== null && unlocked && !disabled && online ? utility?.onHold ?? null : null;
  const label = buildSlot ? buildLabel : utilityId
    ? `${UTILITY_ACTION_ITEM[utilityId].name}${utilityPressable ? "" : unlocked ? ", unavailable" : ", locked"}`
    : slot.binding
    ? actionable && item
      ? `${displayName(item.resourceType, item.variant)}, ${slot.binding.kind === "fishing_rod" ? `${item.usesRemaining ?? 0} casts remaining` : `quantity ${item.quantity}`}`
      : `${bindingName(slot.binding)}, ${unlocked ? "unavailable" : "locked"}${!inventorySnapshotAvailable ? ": Inventory is still loading" : !online ? ": Disconnected" : resolution?.reason ? `: ${resolution.reason}` : ""}`
    : unlocked
      ? `Empty utility slot${showKeyLabel ? ` ${layout.keyLabel}` : ""}; choose an item`
      : `Locked utility slot ${layout.keyLabel}`;
  const healEffect = unlocked && slot.binding?.kind === "consumable" ? healEffects?.[slot.binding.itemId] ?? null : null;
  const [healTicksShown, setHealTicksShown] = useState(0);
  const healTicksShownRef = useRef(0);
  healTicksShownRef.current = healTicksShown;
  useEffect(() => {
    if (!healEffect) {
      setHealTicksShown(0);
      return undefined;
    }
    let timer: number | null = null;
    // First render of a ring starts empty so the opening tick animates; later updates apply at once.
    const apply = (): void => setHealTicksShown(hotbarHealTicksDone(healEffect, Date.now()));
    const frame = healTicksShownRef.current === 0 ? window.requestAnimationFrame(apply) : (apply(), 0);
    const arm = (): void => {
      const next = hotbarHealNextTickAt(healEffect, Date.now());
      if (next === null) return;
      timer = window.setTimeout(() => {
        setHealTicksShown(hotbarHealTicksDone(healEffect, Date.now()));
        arm();
      }, Math.max(0, next - Date.now()) + 4);
    };
    arm();
    return () => {
      window.cancelAnimationFrame(frame);
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [healEffect]);
  const subline = utilityId
    ? !unlocked ? "Locked" : !online ? "Offline" : utilityPressable ? "Ready" : "Unavailable"
    : !inventorySnapshotAvailable
    ? "Inventory loading…"
    : !unlocked
      ? "Locked"
      : !slot.binding
      ? "Choose item"
      : actionable && item
        ? slot.binding.kind === "fishing_rod" ? `${item.usesRemaining ?? 0} casts` : `×${item.quantity.toLocaleString()}`
        : !online ? "Offline" : "Unavailable";
  const activate = (): void => {
    if (!unlocked || disabled) return;
    if (longPressedRef.current) {
      longPressedRef.current = false;
      return;
    }
    if (buildSlot) {
      if (buildPressable) anchorBuild?.onPlace();
      else if (!anchorBuild) onOpenPicker(slot.slotId);
      return;
    }
    if (utilityId) {
      if (utility && online) utility.onPress();
      else onOpenPicker(slot.slotId);
      return;
    }
    if (actionable && resolution?.binding?.kind === "gear_scroll") onActivateGearScroll?.(Number(resolution.binding.scrollId));
    else if (actionable && resolution?.binding && item) onActivate(resolution.binding, item);
    else onOpenPicker(slot.slotId);
  };
  return <button
    type="button"
    className={`ash-hotbar-slot${slot.binding ? " has-binding" : " empty"}${actionable ? " ready" : " unavailable"}${unlocked ? " unlocked" : " locked"}${editing ? " is-layout-editing" : ""}`}
    data-hotbar-slot={slot.slotId}
    data-hotbar-side={layout.side}
    data-layout-editing={editing ? "true" : "false"}
    aria-label={label}
    aria-keyshortcuts={showKeyLabel ? keybind : undefined}
    aria-disabled={!unlocked || disabled}
    disabled={!unlocked || disabled}
    draggable={unlocked && !disabled && Boolean(slot.binding)}
    onDragStart={(event) => {
      if (!slot.binding || !unlocked || disabled) return;
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", hotbarBindingKey(slot.binding));
      onDragStart(slot.slotId, slot.binding);
    }}
    onDragEnd={onDragEnd}
    onDragOver={(event) => event.preventDefault()}
    onDrop={(event) => { event.preventDefault(); onDrop(slot.slotId); }}
    onContextMenu={(event) => {
      event.preventDefault();
      // Touch long-presses also raise contextmenu; the hold timer owns those.
      if (longPressTimerRef.current !== null || longPressedRef.current) return;
      if (unlocked && !disabled) onOpenPicker(slot.slotId);
    }}
    onPointerDown={(event) => {
      clearLongPress();
      longPressedRef.current = false;
      tapHandledRef.current = false;
      tapStartRef.current = event.pointerType === "mouse" ? null : { id: event.pointerId, x: event.clientX, y: event.clientY };
      if (!unlocked || disabled) return;
      // PointerEvent.pointerType is empty in a few embedded WebViews. Treat
      // that as a long-press-capable pointer while keeping ordinary mouse
      // clicks/dragging on desktop unchanged. The builder's hold-to-plan
      // also works with a held primary mouse button.
      if (event.pointerType !== "mouse" || ((holdOpensPlanner || utilityHold) && event.button === 0)) {
        longPressTimerRef.current = window.setTimeout(() => {
          longPressTimerRef.current = null;
          longPressedRef.current = true;
          if (holdOpensPlanner) anchorBuild?.onPlan();
          else if (utilityHold) utilityHold();
          else onOpenPicker(slot.slotId);
        }, 500);
      }
    }}
    onPointerUp={(event) => {
      const start = tapStartRef.current;
      tapStartRef.current = null;
      const held = longPressedRef.current;
      clearLongPress();
      // A browser does not synthesize a click for a tap made while another finger is down (the joystick thumb), so a touch
      // tap activates the slot here; the click that follows an ordinary single-finger tap is then ignored (tapHandledRef).
      if (!start || start.id !== event.pointerId || held || event.pointerType === "mouse") return;
      if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > 10) return;
      tapHandledRef.current = true;
      activate();
    }}
    onPointerCancel={() => { tapStartRef.current = null; clearLongPress(); }}
    onPointerLeave={clearLongPress}
    onClick={() => {
      if (tapHandledRef.current) {
        tapHandledRef.current = false;
        return;
      }
      activate();
    }}
  >
    {!unlocked
      ? <span className="ash-hotbar-locked-glyph" aria-hidden="true"><ProtectionLockIcon /></span>
      : buildSlot
        ? <span className="ash-hotbar-action-glyph" aria-hidden="true"><AnchorBuildGlyph kind={anchorBuild?.kind ?? "flag"} color={anchorBuild?.color ?? null} /></span>
      : utilityId
        ? <ItemArtwork itemId={UTILITY_ACTION_ITEM[utilityId].itemId} variant={null} label={UTILITY_ACTION_ITEM[utilityId].name} nameTooltip="hover-only" />
      : item && slot.binding
        ? <ItemArtwork itemId={String(item.resourceType)} variant={item.variant} label={bindingName(slot.binding)} nameTooltip="hover-only" />
        : <span className="ash-hotbar-empty-glyph" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg></span>}
    <span className="ash-hotbar-copy"><strong>{utilityId ? UTILITY_ACTION_ITEM[utilityId].name : item && slot.binding ? displayName(item.resourceType, item.variant) : slot.binding ? bindingName(slot.binding) : "Empty"}</strong><small>{subline}</small></span>
    {healEffect ? <span
      className="ash-hotbar-heal-ring"
      data-heal-ring="active"
      data-finished={healTicksShown >= healEffect.tickCount ? "true" : "false"}
      aria-hidden="true"
      style={{ "--heal-done": healTicksShown / healEffect.tickCount } as React.CSSProperties}
    ><svg viewBox="0 0 40 40"><circle className="ash-heal-track" cx="20" cy="20" r="17" /><circle className="ash-heal-arc" cx="20" cy="20" r="17" pathLength="100" /></svg>{healTicksShown > 0 ? <i key={healTicksShown} className="ash-heal-pulse" /> : null}</span> : null}
    {showKeyLabel ? <kbd aria-hidden="true">{keybind}</kbd> : null}
  </button>;
}

function HotbarPicker({
  slot,
  choices,
  anchorBuild,
  onSelectBinding,
  onPlan,
  onSelect,
  onClear,
  onCancel,
  onMove,
  onDragStart,
  onDragEnd
}: Readonly<{
  slot: HotbarPlayerSlot;
  choices: readonly HotbarItemChoice[];
  anchorBuild: HotbarAnchorBuild | null;
  onSelectBinding(binding: HotbarBinding): void;
  onPlan(): void;
  onSelect(choice: HotbarItemChoice): void;
  onClear(): void;
  onCancel(): void;
  onMove(targetSlotId: HotbarPlayerSlot["slotId"]): void;
  onDragStart(binding: HotbarBinding): void;
  onDragEnd(): void;
}>): React.JSX.Element {
  const desktop = useUiPresentation() === "desktop";
  const slotIndex = HOTBAR_SLOT_LAYOUT.findIndex((layout) => layout.slotId === slot.slotId);
  const slotLabel = HOTBAR_SLOT_LAYOUT[slotIndex]?.keyLabel ?? "";
  const previousSlotId = slotIndex > 0 ? HOTBAR_SLOT_LAYOUT[slotIndex - 1]?.slotId : null;
  const nextSlotId = slotIndex >= 0 && slotIndex < HOTBAR_SLOT_LAYOUT.length - 1
    ? HOTBAR_SLOT_LAYOUT[slotIndex + 1]?.slotId
    : null;
  const [category, setCategory] = useState<HotbarChoiceCategory | null>(null);
  const selectedKey = hotbarBindingKey(slot.binding);
  const buildSelected = selectedKey === hotbarBindingKey(ANCHOR_BUILD_BINDING);
  const byCategory = new Map<HotbarChoiceCategory, HotbarItemChoice[]>();
  for (const choice of choices) {
    const id = hotbarChoiceCategory(choice.binding);
    byCategory.set(id, [...(byCategory.get(id) ?? []), choice]);
  }
  // Building, Healing, and Fishing always show (greyed when empty); the rest only when carried.
  const categories = HOTBAR_CHOICE_CATEGORIES.filter((entry) =>
    entry.id === "building" || entry.id === "tools" || entry.id === "healing" || entry.id === "fishing" || byCategory.has(entry.id));
  const countFor = (id: HotbarChoiceCategory): number => id === "building" ? 1 : id === "tools" ? UTILITY_ACTION_IDS.length : byCategory.get(id)?.length ?? 0;
  const openCategory = HOTBAR_CHOICE_CATEGORIES.find((entry) => entry.id === category) ?? null;
  const actions = category !== null ? [] : [
    ...(buildSelected && anchorBuild ? [{ key: "plan", label: "Planning mode", enabled: true, tone: "primary" as const, onSelect: onPlan }] : []),
    ...(slot.binding && previousSlotId ? [{ key: "move-earlier", label: "Move earlier", enabled: true, tone: "secondary" as const, onSelect: () => onMove(previousSlotId) }] : []),
    ...(slot.binding && nextSlotId ? [{ key: "move-later", label: "Move later", enabled: true, tone: "secondary" as const, onSelect: () => onMove(nextSlotId) }] : []),
    ...(slot.binding ? [{ key: "clear", label: "Clear binding", enabled: true, tone: "danger" as const, onSelect: onClear }] : [])
  ];
  const choiceButton = (choice: HotbarItemChoice): React.JSX.Element => (
    <GamePromptButton
      key={hotbarBindingKey(choice.binding)}
      tone={selectedKey === hotbarBindingKey(choice.binding) ? "secondary" : "primary"}
      className="ash-hotbar-picker-choice"
      role="option"
      aria-selected={selectedKey === hotbarBindingKey(choice.binding)}
      draggable
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = "copy";
        event.dataTransfer.setData("text/plain", hotbarBindingKey(choice.binding));
        onDragStart(choice.binding);
      }}
      onDragEnd={onDragEnd}
      onClick={() => onSelect(choice)}
    >
      <ItemArtwork itemId={String(choice.item.resourceType)} variant={choice.item.variant} label={choice.name} nameTooltip="hover-only" />
      <span><strong>{choice.name}</strong><small>{choice.actionable ? "" : "Unavailable · "}{choice.binding.kind === "fishing_rod" ? `${choice.usesRemaining ?? 0} casts` : `×${choice.quantity.toLocaleString()}`}</small></span>
    </GamePromptButton>
  );
  const categoryIcon = (id: HotbarChoiceCategory): React.JSX.Element => {
    if (id === "tools") return <ItemArtwork itemId={UTILITY_ACTION_ITEM.dig_treasure.itemId} variant={null} label="" nameTooltip={false} />;
    if (id === "building") return <span className="ash-hotbar-action-glyph"><AnchorBuildGlyph kind={anchorBuild?.kind ?? "flag"} color={anchorBuild?.color ?? null} /></span>;
    const first = byCategory.get(id)?.[0];
    const fallback = id === "healing" ? "giving_berry" : id === "fishing" ? "fishing_rod" : null;
    const itemId = first ? String(first.item.resourceType) : fallback;
    return itemId ? <ItemArtwork itemId={itemId} variant={first?.item.variant ?? null} label="" nameTooltip={false} /> : <span className="ash-hotbar-empty-glyph" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg></span>;
  };
  return <GameActionPrompt
    title={openCategory ? openCategory.label : `Quick slot ${slotLabel}`}
    ariaLabel={`Choose item for ${slot.slotId} actions`}
    category="QUICK SLOTS"
    detail={openCategory
      ? `What you have for ${openCategory.label.toLowerCase()}.`
      : slot.binding
        ? `Holding ${bindingName(slot.binding)}. Pick a group to swap it.`
        : "Pick a group, then choose what goes in this slot."}
    className="ash-hotbar-picker"
    dismissOnOutsideClick
    actions={actions}
    content={openCategory === null
      ? <div className="ash-hotbar-picker-categories">
        {categories.map((entry) => {
          const count = countFor(entry.id);
          return <GamePromptButton
            key={entry.id}
            tone="primary"
            className={`ash-hotbar-picker-category${count === 0 ? " is-empty" : ""}`}
            disabled={count === 0}
            aria-label={`${entry.label}: ${count === 0 ? "none on you" : `${count} available`}`}
            onClick={() => setCategory(entry.id)}
          >
            <span className="ash-hotbar-picker-category-icon" aria-hidden="true">{categoryIcon(entry.id)}</span>
            <strong>{entry.label}</strong>
            <small>{count === 0 ? "None on you" : entry.hint}</small>
          </GamePromptButton>;
        })}
      </div>
      : <div className="ash-hotbar-picker-list" role="listbox" aria-label={`Available ${openCategory.label.toLowerCase()}`}>
        <GamePromptButton tone="secondary" className="ash-hotbar-picker-back" onClick={() => setCategory(null)}>‹ All groups</GamePromptButton>
        {openCategory.id === "building"
          ? <GamePromptButton
            tone={buildSelected ? "secondary" : "primary"}
            className="ash-hotbar-picker-choice"
            role="option"
            aria-selected={buildSelected}
            onClick={() => onSelectBinding(ANCHOR_BUILD_BINDING)}
          >
            <span className="ash-hotbar-action-glyph" aria-hidden="true"><AnchorBuildGlyph kind={anchorBuild?.kind ?? "flag"} color={anchorBuild?.color ?? null} /></span>
            <span><strong>Flag / Buoy builder</strong><small>{desktop ? "Click to place · hold to plan" : "Tap to place · hold for planning mode"}</small></span>
          </GamePromptButton>
          : openCategory.id === "tools"
            ? UTILITY_ACTION_IDS.map((actionId) => {
              const binding: HotbarBinding = { kind: "action", actionId };
              const selected = selectedKey === hotbarBindingKey(binding);
              const info = UTILITY_ACTION_ITEM[actionId];
              return <GamePromptButton
                key={actionId}
                tone={selected ? "secondary" : "primary"}
                className="ash-hotbar-picker-choice"
                role="option"
                aria-selected={selected}
                onClick={() => onSelectBinding(binding)}
              >
                <ItemArtwork itemId={info.itemId} variant={null} label={info.name} nameTooltip="hover-only" />
                <span><strong>{info.name}</strong><small>{info.hint}</small></span>
              </GamePromptButton>;
            })
            : (byCategory.get(openCategory.id) ?? []).map(choiceButton)}
      </div>}
    onCancel={onCancel}
  />;
}

function bindingName(binding: HotbarBinding): string {
  switch (binding.kind) {
    case "consumable": return INVENTORY_NAME[binding.itemId] ?? humanize(binding.itemId);
    case "fishing_rod": return "Fishing Rod";
    case "gear_scroll": return "Gear Scroll";
    case "action": return binding.actionId === "anchor_build" ? "Flag / Buoy builder" : UTILITY_ACTION_ITEM[binding.actionId].name;
  }
}

/** A plain flag (or buoy on water) in the player's chosen flag color. */
function AnchorBuildGlyph({ kind, color }: Readonly<{ kind: "flag" | "buoy"; color: string | null }>): React.JSX.Element {
  const fill = color ?? "currentColor";
  return kind === "buoy"
    ? <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3v5" /><path d="M9 8h6l1.5 9h-9z" fill={fill} /><path d="M3 20c2 1.3 4 1.3 6 0s4-1.3 6 0 4 1.3 6 0" />
    </svg>
    : <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 22V3" strokeWidth="2" /><path d="M6.5 4h12l-3 4.5 3 4.5h-12z" fill={fill} stroke={fill} />
    </svg>;
}

function displayName(resourceType: string, variant: string | null): string {
  if (resourceType === "fishing_rod") return "Fishing Rod";
  const base = INVENTORY_NAME[resourceType] ?? humanize(resourceType);
  const prefix = variant && variant !== "default" ? humanize(variant) : "";
  return prefix ? `${prefix} ${base}` : base;
}

function humanize(value: string): string {
  return value.replaceAll(/[_-]+/g, " ").replace(/\b\w/g, (character) => character.toUpperCase());
}

const INVENTORY_NAME: Readonly<Record<string, string>> = {
  ...FIELD_CONSUMABLE_NAMES,
  giving_berry: "Giving Berry",
  balsam_resin: "Frond Sap",
  simple_food: "Simple Food",
  fishing_rod: "Fishing Rod"
};

function isSlotUnlocked(slotId: HotbarPlayerSlot["slotId"], visibleRows: number): boolean {
  return isHotbarSlotUnlocked(slotId, visibleRows);
}
