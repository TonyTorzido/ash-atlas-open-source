import {
  SPECIALIZATION_DEFINITIONS,
  CURRENT_LEVEL_CAP,
  FLAG_ARRIVAL_PROTECTION_MS,
  HOTBAR_DEFAULT_ROW_POSITIONS,
  formatWeightKg,
  type HungerSnapshot,
  worldTimeAt,
  type TechniqueDefinition
} from "@ash-atlas/shared";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type RefObject,
  type ReactNode
} from "react";
import { createPortal } from "react-dom";
import { AccountLoginMethods, type AccountLoginMethodsProps } from "./AccountLoginMethods.js";
import type {
  AchievementSnapshot,
  ClassSnapshot,
  CombatEntitySnapshot,
  CreatureBookSnapshot,
  EquipmentSnapshot,
  EquipmentSnapshotV2,
  MarketInteger,
  ProgressionSnapshot,
  ResourceType,
  SkillSystemV3Snapshot,
  PlayerSnapshot
} from "@ash-atlas/shared";

import {
  aggressiveDurationMs,
  aggressiveProgressRatio,
  formatAggressiveSeconds
} from "../combat/aggressive.js";
import { CraftStatusMark, MaterialChip } from "./MaterialRequirements.js";
import { resourceDisplayName } from "../collectibles/harvest.js";
import {
  MOBILE_MENU_DESTINATIONS,
  MOBILE_MENU_ROOT_UTILITIES,
  MOBILE_MENU_ROOT_SECTIONS,
  requestMobileMenuReturnToGame,
  type MobileMenuCategoryId,
  type MobileMenuDestinationId,
  type MobileMenuView
} from "../mobileGameMenu.js";
import {
  MOBILE_DEFAULT_MAP_ZOOM,
  MOBILE_MAX_MAP_ZOOM,
  MOBILE_MIN_MAP_ZOOM
} from "../map/mapZoomConfig.js";
import type { TapAssistancePreference } from "../map/tapAssistancePreference.js";
import type { MenuTheme } from "./menuTheme.js";
import { UI_SCALE_MAX, UI_SCALE_MIN, UI_SCALE_STEP, useUiScale } from "./uiScale.js";
import { CLICK_DELAY_STEP_MS, useClickDelayMs } from "../movement/clickDelayPreference.js";
import { useJoystickMovementEnabled } from "../movement/joystickMovementPreference.js";
import { useFlickDashEnabled, useFloatingSticksEnabled, useStickGuidesEnabled } from "../movement/floatingSticksPreference.js";

import { useActionCombatPreference } from "../movement/actionCombatPreference.js";
import { useScreenShakeSetting, type ScreenShakeSetting } from "../combat/hitFeedback.js";
import { useCombatHapticsSetting } from "../combat/combatFeedback.js";
import { useSoundSettings } from "../audio/soundSettings.js";
import {
  MAX_WORLD_MAP_CLICK_CONFIRMATION_MS,
  MIN_WORLD_MAP_CLICK_CONFIRMATION_MS,
  WORLD_MAP_CLICK_CONFIRMATION_MS
} from "../movement/worldMapClickArbitrator.js";
import { useUiPresentation } from "../uiEnvironment.js";
import { DesktopWindow, DesktopWindowTitle } from "./DesktopWindow.js";
import { resetDesktopWindowLayout, setDesktopWindowPlayer } from "./desktopWindowLayout.js";
import { formatMarketInteger } from "../market/marketFormat.js";
import {
  getMobileChatProtectionActive,
  reconcileMobileChatProtectionState,
  subscribeMobileKeyboardDocking
} from "../mobileKeyboardDocking.js";
import { layoutPhoneActions, type PhoneAction, type PhoneActionIcon } from "../phoneActionModel.js";
import type { InputMode, LayoutMode, LayoutPreference, UiPresentation } from "../uiEnvironment.js";
import { PhoneDockHunger, ProgressionHud } from "./ProgressionHud.js";
import { CreatureBookPanel } from "./CreatureBookPanel.js";
import {
  GameAppActionBar,
  GameAppButton,
  GameAppCard,
  GameAppShell,
  GameAppTabs
} from "./GameAppShell.js";
import { RigPortrait } from "./RigPortrait.js";
import { HealTargetSettingsCard, type HealTargetApi } from "./HealTargetSettingsCard.js";
import { GameActionPrompt, GameConfirmationPrompt } from "./GameActionPrompt.js";
import { NativeNotificationSettings } from "./NativeNotificationSettings.js";
import { nativePushEnabled } from "../native/nativePush.js";
import { useCountedGold } from "./useCountedGold.js";
import { PhoneMenuDestinationShell } from "./PhoneMenuDestinationShell.js";
import { MenuDestinationGlyph, StatGlyph } from "./MenuDestinationGlyph.js";
import { useModalBehavior } from "./useModalBehavior.js";
import { useDeadlineRemainingMs } from "./useDeadlineRemainingMs.js";
import {
  MENU_HOLD_SHORTCUT_CHOICES,
  markDockGestureHintSeen,
  readDockGestureHintSeen,
  readMenuHoldShortcut,
  saveMenuHoldShortcut
} from "./menuHoldShortcut.js";
import type {
  ClassAbilityTargetOption,
  ClassAbilityTargetSelection
} from "./classCombatControlModel.js";

export type PhoneMenuDestination = {
  id: MobileMenuDestinationId;
  badge?: string;
  badgeCount?: number;
  badgeAccessibleLabel?: string;
  placeholder?: string;
  disabledReason?: string;
};

export type PhoneMenuAction = Readonly<{
  label: string;
  enabled: boolean;
  disabledReason?: string | null;
  onSelect(): void;
}>;

export type GameMenuPlayer = Pick<PlayerSnapshot, "username" | "displayColor" | "appearance" | "classId">;

/** The adventurer's standing shown on the Game Menu card. */
export type GameMenuAffiliation = Readonly<{
  title?: string | null;
  kingdom?: string | null;
  city?: string | null;
}>;

export type GameMenuProfileSummaryData = Readonly<{
  player: GameMenuPlayer | null;
  titleLabel: string;
  kingdomLabel: string;
  cityLabel: string;
  /** The active class (Ronin, Warrior); null for no class, which also covers a hidden old class. */
  className: string | null;
  levelLabel: string;
  kdLabel: string;
  goldLabel: string;
  healthLabel: string;
  hungerLabel: string;
  hungerPercent: number | null;
  hungerState: "full" | "half" | "small" | "empty";
  xpLabel: string;
  xpPercent: number | null;
  packLabel: string;
}>;

export type PhoneBuildOption = {
  id:
    | `decoration:${string}`
    | "flag"
    | "buoy"
    | "manor"
    | "greenhouse"
    | "greenhouse-destroy"
    | "water-bucket"
    | "furnace"
    | "tannery"
    | "loom"
    | "kitchen"
    | "fishing-hut"
    | "city-house"
    | "city-construction"
    | "oil-well"
    | "quartz-hut"
    | "library"
    | "lodge"
    | "barracks"
    | "demolition-factory"
    | "warehouse"
    | "cistern-warrens"
    | "city-kennel"
    | "salon"
    | "warehouse-upgrade"
    | "market"
    | "monument-mining"
    | "monument-forestry"
    | "monument-hunting"
    | "monument-mining-upgrade"
    | "monument-forestry-upgrade"
    | "monument-hunting-upgrade"
    | "city"
    | "kingdom"
    | "field-engineering"
    | "sapling-plant"
    | "sapling-plant-item"
    | `sapling-tend:${string}`
    | `sapling-pull:${string}`
    | `sapling-gather:${string}`
    | `monolith-build:${string}`
    | `monolith:${string}`
    | "treasure-shovel"
    | `treasure:${string}`;
  category: "personal" | "city" | "kingdom" | "war";
  icon:
    | "flag"
    | "buoy"
    | "manor"
    | "greenhouse"
    | "water-bucket"
    | "furnace"
    | "tannery"
    | "loom"
    | "kitchen"
    | "fishing-hut"
    | "city-house"
    | "city-construction"
    | "oil-well"
    | "lodge"
    | "barracks"
    | "demolition-factory"
    | "warehouse"
    | "salon"
    | "market"
    | "monument"
    | "city"
    | "kingdom"
    | "decoration"
    | "monolith"
    | "treasure"
    | "sapling";
  title: string;
  imageUrl?: string;
  description: string;
  requirements: readonly PhoneBuildRequirement[];
  status?: string;
  guidance: string;
  actionLabel: string;
  enabled: boolean;
  disabledReason: string | null;
  active?: boolean;
  affordable?: boolean;
  execute(): void;
};

/**
 * A material (or currency) requirement. `have` overrides the player's own
 * inventory count; `null` means the balance is not known here (neutral chip).
 */
export type PhoneBuildRequirement =
  | string
  | Readonly<{ itemId: ResourceType; quantity: number; have?: number | null }>
  | Readonly<{ currency: "city_coins" | "city_gold" | "gold"; quantity: number; have?: number | null }>;

type Props = {
  presentation?: UiPresentation;
  actions: readonly PhoneAction[];
  buildOptions: readonly PhoneBuildOption[];
  /** Carried material totals, so Construction can mark each requirement met or short. */
  materialCounts?: Readonly<Partial<Record<string, number>>>;
  destinations: readonly PhoneMenuDestination[];
  player?: GameMenuPlayer | null;
  hunger?: HungerSnapshot | null;
  menuView: MobileMenuView;
  /** The startup/recovery surface owns the screen until gameplay is ready. */
  gameplayReady?: boolean;
  /** Standalone phone destinations render outside the gameplay shell. */
  hideBottomDock?: boolean;
  menuCategory: MobileMenuCategoryId | null;
  progression: ProgressionSnapshot | null;
  /** Compatibility input for callers that still provide the retired standalone view. */
  achievements?: AchievementSnapshot | null;
  creatureBook?: CreatureBookSnapshot | null;
  combat: CombatEntitySnapshot | null;
  classSnapshot: ClassSnapshot | null;
  skillSystemV3Snapshot?: SkillSystemV3Snapshot | null;
  equipment: EquipmentSnapshot | EquipmentSnapshotV2 | null;
  combatControlsDisabled: boolean;
  synchronizedNow(): number;
  combatControlsDisabledReason?: string | null;
  abilityTargetSelection?: ClassAbilityTargetSelection | null;
  friendlyAbilityTargets?: readonly ClassAbilityTargetOption[];
  activationLockoutEndsAt?: number;
  aggressiveRemainingMs?: number;
  flagArrivalProtectionRemainingMs?: number;
  /** Absolute deadlines: when set, this HUD runs its own countdown and ignores the *RemainingMs props. */
  aggressiveUntilMs?: number;
  flagArrivalProtectionUntilMs?: number;
  walletGold: MarketInteger | null;
  adventurerAffiliation?: GameMenuAffiliation;
  /** Water travel: on a raft. Shown in the player-state slot when no combat state is active. */
  afloat?: boolean;
  inventoryUsed: number | string;
  inventoryTotal: number | string;
  developerAccessEnabled: boolean;
  appleSignInEnabled?: boolean;
  onLinkApple?(): Promise<void>;
  accountLoginMethods?: Omit<AccountLoginMethodsProps, "appleSignInEnabled" | "onLinkApple">;
  accountDeletionUrl?: string;
  bugReportsEnabled?: boolean;
  zoomIndicatorEnabled: boolean;
  mobileDefaultZoom: number;
  tapAssistancePreference: TapAssistancePreference;
  menuTheme?: MenuTheme;
  onMenuThemeChange?(theme: MenuTheme): void;
  hotbarVisible?: boolean;
  hotbarRowCount?: number;
  hotbarRowPositions?: readonly number[];
  worldMapAvailable?: boolean;
  rulerMode?: boolean;
  /** App-owned builder surface replaces the legacy planning controls and side rails. */
  planningBuilderSurfaceActive?: boolean;
  planningBuilderMode?: "anchor" | "select" | "pencil" | "trees";
  planningCanUndo?: boolean;
  planningUndoDisabledReason?: string | null;
  onTogglePlanningBuilderMode?(): void;
  onSelectPlanningPencilMode?(): void;
  /** Planting planner: draws the shared tree grid and plants Giving Trees on it. */
  onSelectPlanningTreeMode?(): void;
  onUndoPlanningAnchor?(): void;
  onOpenPlanningLayers?(): void;
  onClearCurrentPlanningLayer?(): void;
  layoutPreference: LayoutPreference;
  automaticLayoutMode: LayoutMode;
  effectiveLayoutMode: LayoutMode;
  inputMode: InputMode;
  wideOverrideBlocked: boolean;
  onOpenMenu(): void;
  onOpenCategory(id: MobileMenuCategoryId): void;
  onOpenDestination(id: MobileMenuDestinationId): void;
  /** Dock shortcuts open their app directly, without the Game Menu underneath. */
  onOpenShortcut?(id: MobileMenuDestinationId): void;
  onOpenBugReport?(): void;
  /** Developer accounts only: opens the Developer App from the Game Menu header. */
  onOpenDeveloperTools?(): void;
  onBack(): void;
  onLogout(): void;
  onZoomIndicatorChange(enabled: boolean): void;
  onMobileDefaultZoomChange(zoom: number): void;
  onResetMobileDefaultZoom(): void;
  onTapAssistancePreferenceChange(preference: TapAssistancePreference): void;
  onLayoutPreferenceChange(preference: LayoutPreference): void;
  onExitRulerMode?(): void;
  onClearRuler?(): void;
  onOpenAnchorSettings?(): void;
  planningTrashMode?: boolean;
  onTogglePlanningTrash?(): void;
  onRecenter(): void;
  onOpenWorldMap(): void;
  onToggleHotbar?(): void;
  /** Character that owns the device-local Menu-hold shortcut. */
  playerId?: string | null;
  onHotbarLayoutChange?(rowCount: number, rowPositions: readonly number[]): void;
  onOpenHotbarLayoutEditor?(): void;
  /** Developer-only Gear slot gesture preview. */
  gearSlotPreview?: boolean;
  /** Holy arc heal-target settings; present only while the server has CLERIC_ARC_ENABLED. */
  healTargetApi?: HealTargetApi;
  /** Action combat is effective (server flag and device preference); drives the joystick default. */
  actionCombatEffective?: boolean;
  onGearSlotPreviewChange?(enabled: boolean): void;
  onUseNormalAbility(abilityId: string, target?: ClassAbilityTargetSelection, targetPosition?: { lat: number; lon: number }): void;
  onUseSkillSystemV3Technique?(techniqueId: string): void;
  onBeginAbilityDragTarget?(kind: "normal", definition: TechniqueDefinition, point: { x: number; y: number } | null): void;
  onUseResetAbility(abilityId: string, target?: ClassAbilityTargetSelection): void;
  onUseUniversalTaunt(): void;
  onDrawerStateChange?(open: boolean, panel: string | null, visibleActions: number, overflowActions: number): void;
};

const DESTINATION_BY_ID = new Map(MOBILE_MENU_DESTINATIONS.map((destination) => [destination.id, destination]));

/** How long a dock control must be held before its hold action fires. */
const DOCK_HOLD_MS = 300;

/**
 * Whatever a hold opens can appear under the still-pressed finger (for example
 * the Game Menu's Back button). Swallow only the click produced by lifting that
 * finger, then disarm.
 */
function swallowClickFromHeldPointer(): void {
  // While the finger is still down, the page ignores pointers (CSS), so the
  // screen the hold opened cannot look pressed or react under that finger.
  const root = document.documentElement;
  root.dataset.dockHoldActive = "true";
  const unshield = (): void => { delete root.dataset.dockHoldActive; };
  const safety = window.setTimeout(unshield, 10_000);
  const swallow = (event: MouseEvent): void => {
    event.preventDefault();
    event.stopPropagation();
    disarm();
  };
  const afterRelease = (): void => {
    window.removeEventListener("pointerup", afterRelease, true);
    window.removeEventListener("pointercancel", afterRelease, true);
    // Stay shielded through the tap the phone synthesizes after lifting, or it
    // gives the control under the finger its hover/pressed look.
    window.setTimeout(disarm, 400);
  };
  const disarm = (): void => {
    window.clearTimeout(safety);
    unshield();
    window.removeEventListener("click", swallow, true);
    window.removeEventListener("pointerup", afterRelease, true);
    window.removeEventListener("pointercancel", afterRelease, true);
  };
  window.addEventListener("click", swallow, true);
  window.addEventListener("pointerup", afterRelease, true);
  window.addEventListener("pointercancel", afterRelease, true);
}

/**
 * Tap vs. hold on one control. A mouse right-click counts as the hold so
 * desktop players reach the same action; the click after a hold is swallowed.
 */
function usePressAndHold(onTap: (() => void) | undefined, onHold: (() => void) | undefined) {
  const timerRef = useRef<number | null>(null);
  const heldRef = useRef(false);
  const startRef = useRef<{ x: number; y: number } | null>(null);
  const onHoldRef = useRef(onHold);
  onHoldRef.current = onHold;
  const clear = (): void => {
    if (timerRef.current === null) return;
    window.clearTimeout(timerRef.current);
    timerRef.current = null;
  };
  useEffect(() => clear, []);
  const hold = (): void => {
    clear();
    heldRef.current = true;
    onHoldRef.current?.();
  };
  return {
    onPointerDown(event: React.PointerEvent<HTMLElement>): void {
      event.stopPropagation();
      heldRef.current = false;
      clear();
      if (!onHoldRef.current || event.button > 0 || event.isPrimary === false) return;
      // Hold the press on this control, not on whatever child is under the
      // finger: live readouts (HP/EXP bars) re-render and would otherwise end it.
      try { event.currentTarget.setPointerCapture?.(event.pointerId); } catch { /* unsupported */ }
      startRef.current = { x: event.clientX, y: event.clientY };
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        swallowClickFromHeldPointer();
        hold();
      }, DOCK_HOLD_MS);
    },
    onPointerMove(event: React.PointerEvent<HTMLElement>): void {
      const start = startRef.current;
      if (timerRef.current === null || !start) return;
      if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > 10) clear();
    },
    onPointerUp: clear,
    onPointerCancel: clear,
    onPointerLeave(event: React.PointerEvent<HTMLElement>): void {
      // Touch "leaves" whenever the node under the finger is replaced; only a
      // mouse leaving the control, or a real slide (onPointerMove), cancels.
      if (event.pointerType === "mouse") clear();
    },
    onContextMenu(event: React.MouseEvent<HTMLElement>): void {
      if (!onHoldRef.current) return;
      event.preventDefault();
      if (!heldRef.current) hold();
    },
    onClick(event: React.MouseEvent<HTMLElement>): void {
      event.stopPropagation();
      if (heldRef.current) {
        heldRef.current = false;
        event.preventDefault();
        return;
      }
      onTap?.();
    }
  };
}

/**
 * Wide presentations use a paint-contained stage, so fixed descendants there
 * use the stage as their containing block. Compact phones stay document-
 * portaled so the dock can paint through the physical safe-area and curved
 * screen edge.
 */
function ViewportHudPortal({
  children,
  stageBound
}: {
  children: ReactNode;
  stageBound: boolean;
}): React.JSX.Element | null {
  const [target, setTarget] = useState<HTMLElement | null>(() => {
    if (typeof document === "undefined") return null;
    if (!stageBound) return document.body;
    return document.querySelector<HTMLElement>(".mobile-app-stage");
  });

  useLayoutEffect(() => {
    if (typeof document === "undefined") return;
    const nextTarget = stageBound
      ? document.querySelector<HTMLElement>(".mobile-app-stage")
      : document.body;
    setTarget((current) => current === nextTarget ? current : nextTarget);
  }, [stageBound]);

  if (typeof document === "undefined") return <>{children}</>;
  if (target === null) return null;
  return createPortal(children, target);
}

export function PhoneHud({
  presentation = "touch",
  actions,
  buildOptions,
  materialCounts,
  destinations,
  player = null,
  hunger = null,
  menuView,
  gameplayReady = true,
  hideBottomDock = false,
  progression,
  creatureBook = null,
  combat,
  classSnapshot,
  skillSystemV3Snapshot = null,
  synchronizedNow,
  aggressiveRemainingMs: aggressiveRemainingMsProp = 0,
  flagArrivalProtectionRemainingMs: flagArrivalProtectionRemainingMsProp = 0,
  aggressiveUntilMs,
  flagArrivalProtectionUntilMs,
  walletGold,
  adventurerAffiliation,
  afloat = false,
  inventoryUsed,
  inventoryTotal,
  developerAccessEnabled,
  appleSignInEnabled = false,
  onLinkApple = async () => undefined,
  accountLoginMethods,
  accountDeletionUrl = "https://playashatlas.com/delete-account",
  bugReportsEnabled = false,
  zoomIndicatorEnabled,
  mobileDefaultZoom,
  tapAssistancePreference,
  menuTheme = "light",
  onMenuThemeChange,
  hotbarVisible = true,
  hotbarRowCount = 4,
  hotbarRowPositions = HOTBAR_DEFAULT_ROW_POSITIONS,
  worldMapAvailable = true,
  rulerMode = false,
  planningBuilderSurfaceActive = false,
  planningBuilderMode = "anchor",
  planningCanUndo = false,
  planningUndoDisabledReason = null,
  effectiveLayoutMode,
  onOpenMenu,
  onOpenDestination,
  onOpenShortcut,
  onOpenBugReport,
  onOpenDeveloperTools,
  onBack,
  onLogout,
  onZoomIndicatorChange,
  onMobileDefaultZoomChange,
  onResetMobileDefaultZoom,
  onTapAssistancePreferenceChange,
  onExitRulerMode = () => undefined,
  onTogglePlanningBuilderMode = () => undefined,
  onSelectPlanningPencilMode = () => undefined,
  onSelectPlanningTreeMode = () => undefined,
  onUndoPlanningAnchor = () => undefined,
  onOpenPlanningLayers = () => undefined,
  onClearCurrentPlanningLayer = () => undefined,
  onClearRuler = () => undefined,
  onOpenAnchorSettings,
  planningTrashMode = false,
  onTogglePlanningTrash,
  onRecenter,
  onOpenWorldMap,
  onToggleHotbar,
  playerId = null,
  onHotbarLayoutChange,
  onOpenHotbarLayoutEditor,
  gearSlotPreview = false,
  healTargetApi,
  actionCombatEffective = false,
  onGearSlotPreviewChange,
  onDrawerStateChange
}: Props): React.JSX.Element {
  const aggressiveRemainingMs = useDeadlineRemainingMs(aggressiveUntilMs, aggressiveRemainingMsProp);
  const flagArrivalProtectionRemainingMs = useDeadlineRemainingMs(
    flagArrivalProtectionUntilMs,
    flagArrivalProtectionRemainingMsProp
  );
  const invokedAt = useRef(new Map<string, number>());
  const hudRef = useRef<HTMLDivElement | null>(null);
  const planningBuildSourceRef = useRef(false);
  const buildDestinationWasOpenRef = useRef(false);
  const [clearRulerConfirmationOpen, setClearRulerConfirmationOpen] = useState(false);
  const chatProtected = useSyncExternalStore(
    subscribeMobileKeyboardDocking,
    getMobileChatProtectionActive,
    () => false
  );
  const layout = useMemo(() => layoutPhoneActions(actions, "right", 4), [actions]);
  const desktopChatOpen = presentation === "desktop" && menuView === "messages";
  const menuUnderlay = menuView === "messages" && !desktopChatOpen;
  useLayoutEffect(() => {
    reconcileMobileChatProtectionState("phone-hud");
  }, []);
  useLayoutInert(hudRef, chatProtected || menuUnderlay);
  // Desktop windows save their moved/resized rects per character on this device.
  setDesktopWindowPlayer(presentation === "desktop" ? playerId : null);
  const [menuHoldShortcut, setMenuHoldShortcut] = useState(() => readMenuHoldShortcut(playerId));
  useEffect(() => { setMenuHoldShortcut(readMenuHoldShortcut(playerId)); }, [playerId]);
  const [menuShortcutPickerOpen, setMenuShortcutPickerOpen] = useState(false);
  const [dockGestureHintVisible, setDockGestureHintVisible] = useState(() => presentation !== "desktop" && !readDockGestureHintSeen());
  const dismissDockGestureHint = (): void => {
    markDockGestureHintSeen();
    setDockGestureHintVisible(false);
  };
  const changeMenuHoldShortcut = (id: MobileMenuDestinationId | null): void => {
    saveMenuHoldShortcut(playerId, id);
    setMenuHoldShortcut(id);
  };
  const openShortcutApp = (id: MobileMenuDestinationId): void => {
    if (onOpenShortcut) {
      onOpenShortcut(id);
      return;
    }
    onOpenMenu();
    onOpenDestination(id);
  };
  const openMenuHoldShortcut = (): void => {
    dismissDockGestureHint();
    if (!menuHoldShortcut) {
      setMenuShortcutPickerOpen(true);
      return;
    }
    openShortcutApp(menuHoldShortcut);
  };
  // Dock gestures: vitals recenter (hold: World Map), bag opens Inventory (hold:
  // show/hide quick slots), Menu opens the menu (hold: the player's shortcut app).
  const vitalsGesture = usePressAndHold(() => {
    dismissDockGestureHint();
    onRecenter();
  }, worldMapAvailable ? () => {
    dismissDockGestureHint();
    onOpenWorldMap();
  } : undefined);
  const economyGesture = usePressAndHold(
    () => (onOpenShortcut ?? onOpenDestination)("equipment"),
    onToggleHotbar && hotbarRowCount > 0 ? () => {
      dismissDockGestureHint();
      onToggleHotbar();
    } : undefined
  );
  const menuGesture = usePressAndHold(onOpenMenu, openMenuHoldShortcut);
  const visibleCount = layout.left.length + layout.right.length;
  const destination = menuView === "gameplay" || menuView === "menu"
    ? null
    : destinations.find(({ id }) => id === menuView) ?? null;
  const buildDestinationOpen = destination?.id === "build";
  const planningBuildDestinationOpen = buildDestinationOpen && planningBuildSourceRef.current;
  const miscellaneousDestinationOpen = destination?.id === "miscellaneous";
  const achievementsDestinationOpen = destination?.id === "achievements";
  const creatureBookDestinationOpen = destination?.id === "creature-book";
  const patchNotesDestinationOpen = destination?.id === "patch-notes";
  const announcementsDestinationOpen = destination?.id === "announcements";
  const safeInventoryUsed = inventoryGrams(inventoryUsed);
  const safeInventoryTotal = inventoryGrams(inventoryTotal);
  const inventoryValue = presentation === "desktop"
    ? `${formatWholeWeightKg(safeInventoryUsed)} / ${formatWholeWeightKg(safeInventoryTotal)} kg`
    : `${formatWholeWeightKg(safeInventoryUsed, true)}/${formatWholeWeightKg(safeInventoryTotal, true)} kg`;
  const inventoryFreeGrams = BigInt(safeInventoryTotal) > BigInt(safeInventoryUsed) ? (BigInt(safeInventoryTotal) - BigInt(safeInventoryUsed)).toString() : "0";
  const inventoryFreeValue = formatWholeWeightKg(inventoryFreeGrams, true);
  const inventoryAccessibleValue = `${formatWeightKg(safeInventoryUsed)} / ${formatWeightKg(safeInventoryTotal)} kg`;
  const inventoryUsedGrams = BigInt(safeInventoryUsed);
  const inventoryTotalGrams = BigInt(safeInventoryTotal);
  const inventoryFull = inventoryTotalGrams > 0n && inventoryUsedGrams >= inventoryTotalGrams;
  const inventoryUsedNumber = Number(safeInventoryUsed);
  const inventoryTotalNumber = Number(safeInventoryTotal);
  const inventoryRatio = inventoryTotalGrams > 0n && Number.isFinite(inventoryUsedNumber)
    && Number.isFinite(inventoryTotalNumber)
    ? Math.min(1, inventoryUsedNumber / inventoryTotalNumber)
    : null;
  const goldAccessibleValue = walletGold === null ? "Gold unavailable" : formatMarketInteger(walletGold);
  const aggressiveValue = formatAggressiveSeconds(aggressiveRemainingMs);
  const flagProtectionValue = `${Math.ceil(flagArrivalProtectionRemainingMs / 1_000)}s`;
  const aggressionDuration = aggressiveDurationMs(skillSystemV3Snapshot);
  // Aggression is the higher-priority combat lock when both authoritative
  // deadlines overlap; otherwise show arrival protection in the same slot.
  const playerState = aggressiveRemainingMs > 0
    ? {
        kind: "aggression" as const,
        label: "Aggression",
        value: aggressiveValue,
        ariaLabel: `Aggression ${aggressiveValue}`
      }
    : flagArrivalProtectionRemainingMs > 0
      ? {
          kind: "protection" as const,
          label: "Protection",
          value: flagProtectionValue,
          ariaLabel: `Protection ${flagProtectionValue}; move or attack to end`
        }
      : {
          kind: "none" as const,
          label: "State",
          value: "Ready",
          ariaLabel: "No active player state"
        };
  const economyLabel = [
    "Open Inventory",
    playerState.kind === "none" ? "No active player state" : playerState.ariaLabel,
    `Carrying ${formatWeightKg(safeInventoryUsed)} of ${formatWeightKg(safeInventoryTotal)} kg, ${formatWeightKg(inventoryFreeGrams)} kg free`,
    `Gold ${goldAccessibleValue}`,
    ...(inventoryFull ? ["Inventory full"] : [])
  ].join(". ") + ".";
  // Both totals are the same configuration consumed by the server grants.
  // Remaining time still comes from the synchronized authoritative deadline.
  const stateDuration = playerState.kind === "protection"
    ? FLAG_ARRIVAL_PROTECTION_MS
    : aggressionDuration;
  const stateRemaining = playerState.kind === "protection"
    ? flagArrivalProtectionRemainingMs
    : aggressiveRemainingMs;
  const stateProgressRatio = playerState.kind === "none"
    ? null
    : aggressiveProgressRatio(stateRemaining, stateDuration);
  const stateProgressValue = stateProgressRatio === null
    ? null
    : Math.min(stateDuration, Math.max(0, stateRemaining));
  const bottomDockHidden = !gameplayReady || hideBottomDock || (menuView !== "gameplay" && presentation !== "desktop");

  useEffect(() => {
    const panel = menuView === "gameplay" ? null : menuView;
    onDrawerStateChange?.(panel !== null, panel, visibleCount, 0);
  }, [menuView, onDrawerStateChange, visibleCount]);
  useEffect(() => {
    if (buildDestinationWasOpenRef.current && !buildDestinationOpen) {
      planningBuildSourceRef.current = false;
    }
    buildDestinationWasOpenRef.current = buildDestinationOpen;
  }, [buildDestinationOpen]);
  useEffect(() => {
    if (!rulerMode || menuView !== "gameplay") setClearRulerConfirmationOpen(false);
  }, [menuView, rulerMode]);
  const execute = (action: PhoneAction): void => {
    if (!action.enabled) return;
    const now = performance.now();
    if (now - (invokedAt.current.get(action.id) ?? -Infinity) < 250) return;
    invokedAt.current.set(action.id, now);
    action.execute();
  };

  return (
    <div
      ref={hudRef}
      className={`phone-hud${menuView === "gameplay" ? "" : " phone-hud-menu-open"}${menuUnderlay ? " phone-hud-menu-underlay" : ""}`}
      aria-label={presentation === "desktop" ? "Desktop gameplay HUD" : "Phone gameplay HUD"}
      data-presentation={presentation}
      aria-hidden={chatProtected || menuUnderlay}
      data-chat-suppressed={chatProtected ? "true" : "false"}
    >
      {!planningBuilderSurfaceActive && visibleCount > 0 ? <>
        <ActionRail side="left" actions={layout.left} execute={execute} />
        <ActionRail side="right" actions={layout.right} execute={execute} />
      </> : null}
      {/* Flag/buoy build and Heal live in quick slots; only planning keeps floating tools. */}
      {menuView === "gameplay" && !chatProtected && rulerMode ? (
        <ViewportHudPortal stageBound={effectiveLayoutMode === "wide"}>
          <div className="legacy-controls-left planning-tools">
            {planningBuilderSurfaceActive ? <PlanningBuilderLegacyControls
              mode={planningBuilderMode}
              canUndo={planningCanUndo}
              undoDisabledReason={planningUndoDisabledReason}
              onToggleMode={onTogglePlanningBuilderMode}
              onSelectPencil={onSelectPlanningPencilMode}
              onSelectTrees={onSelectPlanningTreeMode}
              onUndo={onUndoPlanningAnchor}
              onOpenLayers={onOpenPlanningLayers}
              onClearLayer={onClearCurrentPlanningLayer}
              onExit={onExitRulerMode}
            /> : null}
            {!planningBuilderSurfaceActive ? <>
            {rulerMode ? <button
              type="button"
              className="legacy-control-button legacy-planning-build-button"
              aria-label="Open Build from planning mode"
              title="Open Build from planning mode"
              onClick={(event) => {
                event.stopPropagation();
                planningBuildSourceRef.current = true;
                onOpenDestination("build");
              }}
            >
              <LegacyControlGlyph icon="build" />
            </button> : null}
            {rulerMode && onOpenAnchorSettings ? <button
              type="button"
              className="legacy-control-button legacy-planning-anchor-settings-button"
              aria-label="Anchor Settings"
              title="Anchor Settings"
              onClick={(event) => {
                event.stopPropagation();
                onOpenAnchorSettings();
              }}
            >
              <LegacyControlGlyph icon="anchor" />
            </button> : null}
            {rulerMode ? <button
              type="button"
              className="legacy-control-button legacy-planning-clear-button"
              aria-label={onTogglePlanningTrash
                ? planningTrashMode ? "Exit anchor delete mode" : "Delete saved planning anchor"
                : "Clear all ruler measurements"}
              title={onTogglePlanningTrash
                ? planningTrashMode ? "Exit anchor delete mode" : "Delete saved planning anchor"
                : "Clear all ruler measurements"}
              onClick={(event) => {
                event.stopPropagation();
                if (onTogglePlanningTrash) onTogglePlanningTrash();
                else setClearRulerConfirmationOpen(true);
              }}
            >
              <LegacyControlGlyph icon="clear" />
            </button> : null}
            {rulerMode ? <button
              type="button"
              className="legacy-control-button legacy-flag-button ruler-active"
              aria-label="Exit ruler mode"
              title="Exit planning mode"
              onClick={(event) => {
                event.stopPropagation();
                onExitRulerMode();
              }}
            >
              <LegacyControlGlyph icon="ruler" />
            </button> : null}
            </> : null}
          </div>
        </ViewportHudPortal>
      ) : null}
      {!bottomDockHidden ? <ViewportHudPortal stageBound={effectiveLayoutMode === "wide"}>
        <footer
          className={`phone-bottom-bar${menuView !== "gameplay" && presentation !== "desktop" ? " phone-bottom-bar-menu-hidden" : ""}${chatProtected ? " phone-bottom-bar-chat-hidden" : ""}`}
          aria-label={presentation === "desktop" ? "Desktop command HUD" : "Phone bottom HUD"}
          aria-hidden={chatProtected || (menuView !== "gameplay" && presentation !== "desktop") ? true : undefined}
        >
          <section className="phone-bottom-status phone-bottom-status-actionable">
            <ProgressionHud
              progression={progression}
              combat={combat}
              classSnapshot={classSnapshot}
              hunger={hunger}
              variant="phoneDock"
              omitHunger={presentation !== "desktop"}
            />
            {/* A real button over the vitals: iOS/Android long-press handling
                cancels holds on plain content but leaves buttons alone. */}
            <button
              type="button"
              className="phone-bottom-status-hit"
              aria-label={worldMapAvailable ? "Player resources. Tap to center the map on you; hold for the World Map" : "Player resources. Tap to center the map on you"}
              title={worldMapAvailable ? "Center map · Hold for World Map" : "Center map"}
              {...vitalsGesture}
            />
          </section>
          {presentation === "desktop" ? <button type="button" className="desktop-adventurer-card"
            aria-label={`Open Loadout for ${player?.username ?? "Adventurer"}${playerState.kind === "none" && afloat ? ", afloat" : ""}`} onClick={() => onOpenDestination("profile")}>
            <span className="desktop-adventurer-medallion" aria-hidden="true">
              <span className="desktop-adventurer-portrait">{player?.appearance ? <RigPortrait appearance={player.appearance} focus="bust" ariaLabel="Adventurer appearance" /> : <MenuDestinationGlyph icon="character" />}</span>
              {progression ? <span className="desktop-adventurer-level">{progression.level}</span> : null}
            </span>
            <span><strong>{player?.username ?? "Adventurer"}</strong><small>{progression ? `Level ${progression.level} · ` : ""}Loadout</small></span>
            {playerState.kind === "none" && afloat ? <span className="desktop-adventurer-state desktop-adventurer-state-afloat" data-player-state="afloat" aria-hidden="true">
              <strong>Afloat</strong>
            </span> : null}
            {playerState.kind === "none" ? null : <span className={`desktop-adventurer-state desktop-adventurer-state-${playerState.kind}`} data-player-state={playerState.kind} aria-hidden="true">
              <PhonePlayerStateGlyph state={playerState.kind} />
              <span className="desktop-adventurer-state-track">{stateProgressRatio === null ? null : <span style={{ width: `${stateProgressRatio * 100}%` }} />}</span>
              <strong>{playerState.value}</strong>
            </span>}
          </button> : <div
            className={`phone-bottom-menu-compartment${menuView !== "gameplay" ? " expanded" : ""}`}
          >
            <button
              type="button"
              className="phone-menu-trigger"
              aria-expanded={menuView !== "gameplay"}
              aria-label={menuHoldShortcut
                ? `Open Game Menu; hold for ${MENU_HOLD_SHORTCUT_CHOICES.find((choice) => choice.id === menuHoldShortcut)?.label ?? "your shortcut"}`
                : "Open Game Menu; hold to choose a shortcut"}
              {...menuGesture}
            >
              <MenuGlyph />
              <strong>Menu</strong>
            </button>
            {/* The aggression / protection timer: a ring around the medallion plus a
                hanging seconds tag. Empty (and invisible) at ease. */}
            <span
              className="phone-menu-state"
              role="status"
              aria-label={playerState.kind === "none" ? afloat ? "Afloat" : "No active player state" : playerState.ariaLabel}
              data-player-state={playerState.kind === "none" && afloat ? "afloat" : playerState.kind}
              data-urgent={playerState.kind !== "none" && stateRemaining <= 3_000 ? "true" : undefined}
              style={stateProgressRatio === null ? undefined : { "--combat-progress": stateProgressRatio } as React.CSSProperties}
            >
              {playerState.kind === "none" ? afloat ? <span className="phone-menu-state-tag" aria-hidden="true">Afloat</span> : null : <>
                <span className="phone-menu-state-ring" aria-hidden="true" />
                <span className="phone-menu-state-tag" aria-hidden="true">{playerState.value}</span>
              </>}
            </span>
          </div>}
          <div
            className={`phone-bottom-economy-compartment${inventoryFull ? " inventory-full" : ""}`}
          >
            <button
              type="button"
              className={`phone-bottom-economy${inventoryFull ? " inventory-full" : ""}`}
              aria-label={economyLabel}
              title={inventoryFull ? "Inventory full — open inventory" : onToggleHotbar && hotbarRowCount > 0 ? "Open Inventory · Hold to show or hide quick slots" : "Open Inventory"}
              {...economyGesture}
            >
              {presentation === "desktop" ? null : <PhoneDockHunger hunger={hunger} />}
              <output
                className={`phone-economy-row phone-economy-state phone-economy-state-${playerState.kind}`}
                aria-label={playerState.ariaLabel}
                aria-live="off"
                data-player-state={playerState.kind}
              >
                <PhonePlayerStateGlyph state={playerState.kind} />
                <span className="phone-economy-label" aria-hidden="true">{playerState.kind === "none" ? "At ease" : playerState.label}</span>
                <span className="phone-economy-state-copy">
                  <span
                    className="phone-economy-state-track"
                    role={stateProgressRatio === null ? undefined : "progressbar"}
                    aria-label={stateProgressRatio === null ? undefined : `${playerState.label} time remaining`}
                    aria-valuemin={stateProgressRatio === null ? undefined : 0}
                    aria-valuemax={stateProgressRatio === null ? undefined : stateDuration}
                    aria-valuenow={stateProgressValue ?? undefined}
                    aria-hidden={stateProgressRatio === null ? true : undefined}
                  >
                    {stateProgressRatio === null ? null : <span
                      className="phone-economy-state-fill"
                      aria-hidden="true"
                      style={{ width: `${stateProgressRatio * 100}%` }}
                    />}
                  </span>
                  <span className="sr-only">{playerState.label}</span>
                </span>
                <strong className="phone-economy-state-value">{playerState.value}</strong>
              </output>
              <div className="phone-economy-row phone-economy-storage" data-size="s">
                <span className="phone-economy-label" aria-hidden="true">Carry</span>
                <PhoneEconomyGlyph kind="storage" />
                <span className="sr-only">Carry</span>
                <span
                  className="phone-economy-storage-track"
                  role={inventoryRatio === null ? undefined : "meter"}
                  aria-label={inventoryRatio === null ? undefined : "Storage used"}
                  aria-valuemin={inventoryRatio === null ? undefined : 0}
                  aria-valuemax={inventoryRatio === null ? undefined : inventoryTotalNumber}
                  aria-valuenow={inventoryRatio === null ? undefined : Math.min(inventoryUsedNumber, inventoryTotalNumber)}
                  aria-valuetext={inventoryRatio === null ? undefined : `${formatWeightKg(safeInventoryUsed)} of ${formatWeightKg(safeInventoryTotal)} kg used`}
                  aria-hidden={inventoryRatio === null ? true : undefined}
                >
                  {inventoryRatio === null ? null : <span
                    className="phone-economy-storage-fill"
                    aria-hidden="true"
                    style={{ width: `${inventoryRatio * 100}%` }}
                  />}
                  <strong className="phone-economy-storage-value" title={presentation === "desktop" ? inventoryAccessibleValue : `Carrying ${formatWeightKg(safeInventoryUsed)} of ${formatWeightKg(safeInventoryTotal)} kg, ${inventoryFull ? "no space free" : `${formatWeightKg(inventoryFreeGrams)} kg free`}`}>{presentation === "desktop" ? inventoryValue : inventoryFull ? "Full" : inventoryFreeValue}</strong>
                </span>
              </div>
              <div className="phone-economy-row phone-economy-gold">
                <span className="phone-economy-label" aria-hidden="true">Gold</span>
                <PhoneEconomyGlyph kind="gold" />
                <span className="sr-only">Gold</span>
                <PhoneGoldValue walletGold={walletGold} title={goldAccessibleValue} />
              </div>
            </button>
          </div>
          {presentation === "desktop" ? <DesktopCommandMenu destinations={destinations} onOpenDestination={(id) => (menuView === id ? onBack() : onOpenDestination(id))} /> : null}
        </footer>
      </ViewportHudPortal> : null}
      {menuShortcutPickerOpen ? <GameActionPrompt
        modal
        movable={false}
        className="menu-shortcut-picker"
        title="Pick your Menu shortcut"
        category="Hold Menu"
        detail="Hold Menu to jump straight to this app. Change it any time in Settings & Support › Utility Hotbar."
        content={<div className="menu-shortcut-choices">
          {MENU_HOLD_SHORTCUT_CHOICES.map((choice) => {
            const destination = DESTINATION_BY_ID.get(choice.id);
            return <button key={choice.id} type="button" className="menu-shortcut-choice" onClick={() => {
              changeMenuHoldShortcut(choice.id);
              setMenuShortcutPickerOpen(false);
              openShortcutApp(choice.id);
            }}>
              {destination ? <MenuDestinationGlyph icon={destination.icon} /> : null}
              <span>{choice.label}</span>
            </button>;
          })}
        </div>}
        actions={[]}
        cancelLabel="Not now"
        onCancel={() => setMenuShortcutPickerOpen(false)}
      /> : null}
      {dockGestureHintVisible && !bottomDockHidden && menuView === "gameplay" && !chatProtected ? <ViewportHudPortal stageBound={effectiveLayoutMode === "wide"}>
        <aside className="dock-gesture-hint" role="note" aria-label="Dock shortcuts">
          <p><strong>Tap your stats</strong> to center the map · <strong>hold</strong> for the World Map.</p>
          <p><strong>Hold your bag</strong> to show or hide quick slots · <strong>hold Menu</strong> for your shortcut app.</p>
          <button type="button" onClick={dismissDockGestureHint}>Got it</button>
        </aside>
      </ViewportHudPortal> : null}
      {clearRulerConfirmationOpen ? <GameConfirmationPrompt
        title="Clear measurements?"
        category=""
        confirmLabel="Clear"
        destructive
        onCancel={() => setClearRulerConfirmationOpen(false)}
        onConfirm={() => {
          setClearRulerConfirmationOpen(false);
          onClearRuler();
        }}
      /> : null}
      {menuView === "menu" || menuUnderlay ? (
        <GameMenu
          key="root"
          destinations={destinations}
          affiliation={adventurerAffiliation}
          player={player}
          hunger={hunger}
          progression={progression}
          combat={combat}
          walletGold={walletGold}
          inventoryUsed={safeInventoryUsed}
          inventoryTotal={safeInventoryTotal}
          synchronizedNow={synchronizedNow}
          onOpenDestination={onOpenDestination}
          {...(onOpenDeveloperTools ? { onOpenDeveloperTools } : {})}
          onBack={onBack}
          background={menuUnderlay}
        />
      ) : buildDestinationOpen ? (
        <BuildDestination options={buildOptions} materialCounts={materialCounts} onBack={onBack} openedFromPlanning={planningBuildDestinationOpen} />
      ) : miscellaneousDestinationOpen ? (
        <MiscellaneousDestination
          developerAccessEnabled={developerAccessEnabled}
          appleSignInEnabled={appleSignInEnabled}
          onLinkApple={onLinkApple}
          accountLoginMethods={accountLoginMethods}
          bugReportsEnabled={bugReportsEnabled}
          zoomIndicatorEnabled={zoomIndicatorEnabled}
          mobileDefaultZoom={mobileDefaultZoom}
          tapAssistancePreference={tapAssistancePreference}
          menuTheme={menuTheme}
          onMenuThemeChange={onMenuThemeChange}
          desktop={presentation === "desktop"}
          onBack={onBack}
          onLogout={onLogout}
          accountDeletionUrl={accountDeletionUrl}
          onOpenBugReport={() => onOpenBugReport?.()}
          onZoomIndicatorChange={onZoomIndicatorChange}
          onMobileDefaultZoomChange={onMobileDefaultZoomChange}
          onResetMobileDefaultZoom={onResetMobileDefaultZoom}
          onTapAssistancePreferenceChange={onTapAssistancePreferenceChange}
          hotbarRowCount={hotbarRowCount}
          hotbarRowPositions={hotbarRowPositions}
          {...(onHotbarLayoutChange ? { onHotbarLayoutChange } : {})}
          {...(onOpenHotbarLayoutEditor ? { onOpenHotbarLayoutEditor } : {})}
          menuHoldShortcut={menuHoldShortcut}
          onMenuHoldShortcutChange={changeMenuHoldShortcut}
          gearSlotPreview={gearSlotPreview}
          actionCombatEffective={actionCombatEffective}
          onGearSlotPreviewChange={onGearSlotPreviewChange}
          {...(healTargetApi ? { healTargetApi } : {})}
        />
      ) : achievementsDestinationOpen ? null : creatureBookDestinationOpen ? (
        <CreatureBookPanel snapshot={creatureBook} onBack={onBack} />
      ) : patchNotesDestinationOpen || announcementsDestinationOpen ? null : destination?.placeholder ? (
        <PlaceholderDestination destination={destination} onBack={onBack} />
      ) : null}
    </div>
  );
}

export function DesktopCommandMenu({ destinations, onOpenDestination }: {
  destinations: readonly PhoneMenuDestination[];
  onOpenDestination(id: MobileMenuDestinationId): void;
}): React.JSX.Element {
  return <div className="desktop-command-menu" role="navigation" aria-label="Game commands">
    <GameMenuDirectory destinations={destinations} onOpenDestination={onOpenDestination} />
    {MOBILE_MENU_ROOT_UTILITIES.map(({ id, label }) => <MenuDirectoryDestinationButton key={id} id={id} label={id === "miscellaneous" ? "Settings" : label}
      state={destinations.find((entry) => entry.id === id)} onOpen={onOpenDestination} />)}
  </div>;
}

function MiscellaneousDestination({
  menuTheme,
  onMenuThemeChange,
  desktop,
  developerAccessEnabled,
  appleSignInEnabled,
  onLinkApple,
  accountLoginMethods,
  bugReportsEnabled,
  zoomIndicatorEnabled,
  mobileDefaultZoom,
  tapAssistancePreference,
  onBack,
  onLogout,
  accountDeletionUrl,
  onOpenBugReport,
  onZoomIndicatorChange,
  onMobileDefaultZoomChange,
  onResetMobileDefaultZoom,
  onTapAssistancePreferenceChange,
  hotbarRowCount,
  hotbarRowPositions,
  onHotbarLayoutChange,
  onOpenHotbarLayoutEditor,
  menuHoldShortcut,
  onMenuHoldShortcutChange,
  gearSlotPreview,
  actionCombatEffective,
  onGearSlotPreviewChange,
  healTargetApi
}: {
  menuTheme: MenuTheme;
  onMenuThemeChange: ((theme: MenuTheme) => void) | undefined;
  desktop: boolean;
  developerAccessEnabled: boolean;
  appleSignInEnabled: boolean;
  onLinkApple(): Promise<void>;
  accountLoginMethods: Omit<AccountLoginMethodsProps, "appleSignInEnabled" | "onLinkApple"> | undefined;
  bugReportsEnabled: boolean;
  zoomIndicatorEnabled: boolean;
  mobileDefaultZoom: number;
  tapAssistancePreference: TapAssistancePreference;
  onBack(): void;
  onLogout(): void;
  accountDeletionUrl: string;
  onOpenBugReport(): void;
  onZoomIndicatorChange(enabled: boolean): void;
  onMobileDefaultZoomChange(zoom: number): void;
  onResetMobileDefaultZoom(): void;
  onTapAssistancePreferenceChange(preference: TapAssistancePreference): void;
  hotbarRowCount: number;
  hotbarRowPositions: readonly number[];
  onHotbarLayoutChange?(rowCount: number, rowPositions: readonly number[]): void;
  onOpenHotbarLayoutEditor?(): void;
  menuHoldShortcut: MobileMenuDestinationId | null;
  onMenuHoldShortcutChange(id: MobileMenuDestinationId | null): void;
  gearSlotPreview: boolean;
  actionCombatEffective: boolean;
  onGearSlotPreviewChange: ((enabled: boolean) => void) | undefined;
  healTargetApi?: HealTargetApi;
}): React.JSX.Element {
  const [primaryTab, setPrimaryTab] = useState<"gameplay" | "support" | "account" | "about">("gameplay");
  const [uiScale, changeUiScale] = useUiScale();
  const [uiScaleDraft, setUiScaleDraft] = useState<number | null>(null);
  const commitUiScaleDraft = (): void => {
    if (uiScaleDraft === null) return;
    changeUiScale(uiScaleDraft);
    setUiScaleDraft(null);
  };
  const [windowsReset, setWindowsReset] = useState(false);
  const [clickDelayMs, changeClickDelayMs] = useClickDelayMs();
  const [joystickMovementEnabled, setJoystickMovementEnabled] = useJoystickMovementEnabled(actionCombatEffective);
  const [floatingSticksEnabled, setFloatingSticksEnabled] = useFloatingSticksEnabled();
  const [flickDashEnabled, setFlickDashEnabled] = useFlickDashEnabled();
  const [stickGuidesEnabled, setStickGuidesEnabled] = useStickGuidesEnabled();
  const [actionCombatPreference, setActionCombatPreference] = useActionCombatPreference();
  const [screenShake, setScreenShake] = useScreenShakeSetting();
  const [combatHaptics, setCombatHaptics] = useCombatHapticsSetting();
  const [sound, updateSound] = useSoundSettings();
  const [gameplayTab, setGameplayTab] = useState<"hotbar" | "map" | "appearance">("hotbar");
  const [supportTab, setSupportTab] = useState<"help" | "diagnostics">("help");
  const [accountTab, setAccountTab] = useState<"account" | "notifications" | "delete">("account");
  const [aboutTab, setAboutTab] = useState<"credits" | "legal">("credits");

  const primaryTabs = [
    { id: "gameplay", label: "Gameplay" },
    { id: "support", label: "Support" },
    { id: "account", label: "Account" },
    { id: "about", label: "About" }
  ] as const;
  const supportTabs = developerAccessEnabled
    ? ([
      { id: "help", label: "Help" },
      { id: "diagnostics", label: "Diagnostics" }
    ] as const)
    : ([{ id: "help", label: "Help" }] as const);

  return (
    <GameAppShell
      open
      title="Settings & Support"
      closeLabel="Close Settings & Support"
      className="phone-miscellaneous-layer"
      layout="phone"
      initialFocus="container"
      phoneOnBack={onBack}
      onClose={onBack}
    >
      <div className="phone-settings-app">
        <GameAppTabs
          variant="housed"
          ariaLabel="Settings sections"
          activeTab={primaryTab}
          onChange={(tab) => setPrimaryTab(tab as typeof primaryTab)}
          tabs={primaryTabs}
        />
        {primaryTab === "gameplay" ? (
          <>
            <GameAppTabs
              variant="subtabs"
              ariaLabel="Gameplay settings"
              activeTab={gameplayTab}
              onChange={(tab) => setGameplayTab(tab as typeof gameplayTab)}
              tabs={[
                { id: "hotbar", label: "Utility Hotbar" },
                { id: "appearance", label: "Appearance" },
                { id: "map", label: "Map" }
              ]}
            />
            {gameplayTab === "appearance" ? <GameAppCard title="Appearance" description={desktop ? "Choose the parchment style and how large the interface is drawn over the map on this device." : "Choose the parchment style for menus and controls on this device."}>
              <label className="phone-layout-select"><span>Menu theme</span>
                <select aria-label="Menu theme" value={menuTheme} disabled={!onMenuThemeChange} onChange={(event) => onMenuThemeChange?.(event.currentTarget.value as MenuTheme)}>
                  <option value="light">Light parchment</option><option value="dark">Dark walnut</option>
                </select>
              </label>
              {desktop ? <div className="phone-map-zoom-control">
                <label htmlFor="desktop-interface-size">Interface size</label>
                <output htmlFor="desktop-interface-size">{Math.round((uiScaleDraft ?? uiScale) * 100)}%</output>
                {/* Applied on release so the window does not rescale under the pointer mid-drag. */}
                <input
                  id="desktop-interface-size"
                  type="range"
                  min={UI_SCALE_MIN}
                  max={UI_SCALE_MAX}
                  step={UI_SCALE_STEP}
                  value={uiScaleDraft ?? uiScale}
                  onChange={(event) => setUiScaleDraft(event.currentTarget.valueAsNumber)}
                  onPointerUp={commitUiScaleDraft}
                  onKeyUp={commitUiScaleDraft}
                  onBlur={commitUiScaleDraft}
                />
              </div> : null}
              {desktop ? <>
                <GameAppActionBar><GameAppButton onClick={() => { resetDesktopWindowLayout(); setWindowsReset(true); }}>Reset window positions</GameAppButton></GameAppActionBar>
                <small role="status" aria-live="polite">{windowsReset ? "Windows are back in their default places." : "Chat and Messages open on the right, other menus on the left. Drag a title bar to move a window and a corner to resize it; it is remembered on this device."}</small>
              </> : null}
            </GameAppCard> : gameplayTab === "hotbar" ? (
              <GameAppCard
                title="Utility Hotbar"
                className="phone-map-settings phone-hotbar-settings"
              >
                <label className="phone-layout-select">
                  <span>Visible rows</span>
                  <select
                    value={hotbarRowCount}
                    aria-label="Visible rows"
                    disabled={!onHotbarLayoutChange}
                    onChange={(event) => onHotbarLayoutChange?.(Number(event.currentTarget.value), hotbarRowPositions)}
                  >
                    <option value={0}>Off</option>
                    <option value={1}>1 row</option>
                    <option value={2}>2 rows</option>
                    <option value={3}>3 rows</option>
                    <option value={4}>4 rows</option>
                    <option value={5}>5 rows</option>
                  </select>
                </label>
                {hotbarRowCount > 0 ? <GameAppActionBar>
                  <GameAppButton
                    variant="primary"
                    disabled={!onOpenHotbarLayoutEditor}
                    onClick={() => onOpenHotbarLayoutEditor?.()}
                  >Adjust Slots</GameAppButton>
                </GameAppActionBar> : null}
              </GameAppCard>
            ) : null}
            {gameplayTab === "hotbar" && desktop ? null : gameplayTab === "hotbar" ? (
              <GameAppCard
                title="Menu hold shortcut"
                className="phone-map-settings"
              >
                <label className="phone-layout-select">
                  <span>Hold Menu opens</span>
                  <select
                    aria-label="Hold Menu opens"
                    value={menuHoldShortcut ?? ""}
                    onChange={(event) => onMenuHoldShortcutChange(
                      (event.currentTarget.value || null) as MobileMenuDestinationId | null
                    )}
                  >
                    <option value="">Ask me (off)</option>
                    {MENU_HOLD_SHORTCUT_CHOICES.map((choice) => <option key={choice.id} value={choice.id}>{choice.label}</option>)}
                  </select>
                </label>
              </GameAppCard>
            ) : gameplayTab === "map" ? (
              <GameAppCard
                title="Map"
                className="phone-map-settings"
                description="Set the map interaction defaults used on this device."
              >
                <div className="phone-map-zoom-control">
                  <label htmlFor="phone-default-zoom">Default zoom</label>
                  <output htmlFor="phone-default-zoom">{mobileDefaultZoom.toFixed(2)}</output>
                  <input
                    id="phone-default-zoom"
                    type="range"
                    min={MOBILE_MIN_MAP_ZOOM}
                    max={MOBILE_MAX_MAP_ZOOM}
                    step={0.05}
                    value={mobileDefaultZoom}
                    onChange={(event) => onMobileDefaultZoomChange(event.currentTarget.valueAsNumber)}
                  />
                </div>
                {desktop ? null : <small>Double-tap the map with two fingers to return to this zoom.</small>}
                <GameAppActionBar>
                  <GameAppButton
                    disabled={mobileDefaultZoom === MOBILE_DEFAULT_MAP_ZOOM}
                    onClick={onResetMobileDefaultZoom}
                  >
                    Reset to {MOBILE_DEFAULT_MAP_ZOOM}
                  </GameAppButton>
                </GameAppActionBar>
                <div className="phone-map-zoom-control">
                  <label htmlFor="world-click-delay">{desktop ? "Double-click window" : "Double-tap window"}</label>
                  <output htmlFor="world-click-delay">{clickDelayMs} ms</output>
                  <input
                    id="world-click-delay"
                    type="range"
                    min={MIN_WORLD_MAP_CLICK_CONFIRMATION_MS}
                    max={MAX_WORLD_MAP_CLICK_CONFIRMATION_MS}
                    step={CLICK_DELAY_STEP_MS}
                    value={clickDelayMs}
                    onChange={(event) => changeClickDelayMs(event.currentTarget.valueAsNumber)}
                  />
                </div>
                <small>
                  {desktop
                    ? "How long a click waits for a second one before opening its menu. Shorter feels snappier; longer makes double-click movement onto trees and creatures easier."
                    : "How long a tap or click waits for a second one before opening its menu. Shorter feels snappier; longer makes double-tap movement onto trees and creatures easier."}
                </small>
                <GameAppActionBar>
                  <GameAppButton
                    disabled={clickDelayMs === WORLD_MAP_CLICK_CONFIRMATION_MS}
                    onClick={() => changeClickDelayMs(WORLD_MAP_CLICK_CONFIRMATION_MS)}
                  >
                    Reset to {WORLD_MAP_CLICK_CONFIRMATION_MS} ms
                  </GameAppButton>
                </GameAppActionBar>
                {desktop ? null : <><label className="phone-layout-select">
                  <span>Tap assistance</span>
                  <select
                    value={tapAssistancePreference}
                    aria-label="Tap assistance"
                    onChange={(event) => onTapAssistancePreferenceChange(
                      event.currentTarget.value as TapAssistancePreference
                    )}
                  >
                    <option value="precise">Precise</option>
                    <option value="standard">Standard</option>
                    <option value="large">Large</option>
                  </select>
                </label>
                <small>
                  Larger assistance makes small world objects easier to tap, but may show Choose Target more often in crowded areas.
                </small></>}
              </GameAppCard>
            ) : null}
            {gameplayTab === "map" ? (
              <GameAppCard title="Joystick movement" className="phone-map-settings">
                <label className="developer-tool-toggle">
                  <span>
                    <strong>Joystick movement</strong>
                    <small>Prototype. Shows a thumbstick at the bottom left of the world map; hold and push to walk. WASD also works on PC. A connected game controller always moves you with its left stick.</small>
                  </span>
                  <input
                    type="checkbox"
                    checked={joystickMovementEnabled}
                    onChange={(event) => setJoystickMovementEnabled(event.currentTarget.checked)}
                  />
                </label>
                <label className="developer-tool-toggle">
                  <span>
                    <strong>Floating sticks</strong>
                    <small>The movement stick and the attack stick appear wherever you touch inside the bottom-left and bottom-right areas. Turn off for sticks fixed in the corners.</small>
                  </span>
                  <input
                    type="checkbox"
                    checked={floatingSticksEnabled}
                    onChange={(event) => setFloatingSticksEnabled(event.currentTarget.checked)}
                  />
                </label>
                <label className="developer-tool-toggle">
                  <span>
                    <strong>Show stick areas</strong>
                    <small>Draws a faint dotted line where each floating stick area starts. Only applies while Floating sticks is on.</small>
                  </span>
                  <input
                    type="checkbox"
                    checked={stickGuidesEnabled}
                    disabled={!floatingSticksEnabled}
                    onChange={(event) => setStickGuidesEnabled(event.currentTarget.checked)}
                  />
                </label>
                <label className="developer-tool-toggle">
                  <span>
                    <strong>Flick stick to dash</strong>
                    <small>A quick flick of the movement stick (to the edge and off again in under a fifth of a second) dashes that way. Holding, walking or a quick step never dashes. The dash button still works.</small>
                  </span>
                  <input
                    type="checkbox"
                    checked={flickDashEnabled}
                    onChange={(event) => setFlickDashEnabled(event.currentTarget.checked)}
                  />
                </label>
              </GameAppCard>
            ) : null}
            {gameplayTab === "map" ? (
              <GameAppCard title="Action combat" className="phone-map-settings">
                <label className="developer-tool-toggle">
                  <span>
                    <strong>Action combat</strong>
                    <small>Prototype. When the server has it on, click (or press X on a controller) to swing toward the cursor instead of queueing auto-attacks. Right click moves. Turn off to compare with queued combat.</small>
                  </span>
                  <input
                    type="checkbox"
                    checked={actionCombatPreference}
                    onChange={(event) => setActionCombatPreference(event.currentTarget.checked)}
                  />
                </label>
                <label className="phone-layout-select">
                  <span>Screen shake</span>
                  <select
                    value={screenShake}
                    aria-label="Screen shake"
                    onChange={(event) => setScreenShake(event.currentTarget.value as ScreenShakeSetting)}
                  >
                    <option value="full">Full</option>
                    <option value="reduced">Reduced</option>
                    <option value="off">Off</option>
                  </select>
                </label>
                <small>
                  A small shake on combo finishers and big hits. Always off when your device asks for reduced motion.
                </small>
                <label className="developer-tool-toggle">
                  <span>
                    <strong>Haptics</strong>
                    <small>A light tap when you land a hit or dash, a stronger one on a kill or when you are hit. Phones with the app only.</small>
                  </span>
                  <input
                    type="checkbox"
                    aria-label="Combat haptics"
                    checked={combatHaptics}
                    onChange={(event) => setCombatHaptics(event.currentTarget.checked)}
                  />
                </label>
              </GameAppCard>
            ) : null}
            {gameplayTab === "map" && healTargetApi ? <HealTargetSettingsCard api={healTargetApi} /> : null}
            {gameplayTab === "map" ? (
              <GameAppCard title="Sound" className="phone-map-settings" description="Volume for this device. Music plays on the overworld.">
                <label className="developer-tool-toggle">
                  <span>
                    <strong>Music</strong>
                    <small>Background music on the overworld. It quiets a little while you are in combat.</small>
                  </span>
                  <input
                    type="checkbox"
                    aria-label="Music on"
                    checked={sound.musicOn}
                    onChange={(event) => updateSound({ musicOn: event.currentTarget.checked })}
                  />
                </label>
                {([
                  ["master", "Master volume", sound.master],
                  ["music", "Music volume", sound.music],
                  ["sfx", "Sound effects volume", sound.sfx]
                ] as const).map(([key, label, value]) => (
                  <div className="phone-map-zoom-control" key={key}>
                    <label htmlFor={`sound-volume-${key}`}>{label}</label>
                    <output htmlFor={`sound-volume-${key}`}>{value}</output>
                    <input
                      id={`sound-volume-${key}`}
                      type="range"
                      min={0}
                      max={100}
                      step={1}
                      value={value}
                      onChange={(event) => updateSound({ [key]: event.currentTarget.valueAsNumber })}
                    />
                  </div>
                ))}
              </GameAppCard>
            ) : null}
            {gameplayTab === "hotbar" && developerAccessEnabled && onGearSlotPreviewChange ? (
              <GameAppCard title="Gear slot preview" className="phone-map-settings">
                <label className="developer-tool-toggle">
                  <span>
                    <strong>Preview Gear slot</strong>
                    <small>Developer only. Puts a sample Gear slot on the left rail, second row from the bottom: press, slide to a set, release. Nothing is equipped or saved.</small>
                  </span>
                  <input
                    type="checkbox"
                    checked={gearSlotPreview}
                    onChange={(event) => onGearSlotPreviewChange(event.currentTarget.checked)}
                  />
                </label>
              </GameAppCard>
            ) : null}
          </>
        ) : primaryTab === "support" ? (
          <>
            <GameAppTabs
              variant="subtabs"
              ariaLabel="Support settings"
              activeTab={supportTab}
              onChange={(tab) => setSupportTab(tab as typeof supportTab)}
              tabs={supportTabs}
            />
            {supportTab === "diagnostics" && developerAccessEnabled ? (
              <GameAppCard
                title="Diagnostics"
                className="phone-developer-options"
                description="Developer-only map instrumentation for troubleshooting."
              >
                <label className="developer-tool-toggle">
                  <span>
                    <strong>Show Zoom Level</strong>
                    <small>Show the active map&apos;s live MapLibre zoom level.</small>
                  </span>
                  <input
                    type="checkbox"
                    checked={zoomIndicatorEnabled}
                    onChange={(event) => onZoomIndicatorChange(event.currentTarget.checked)}
                  />
                </label>
              </GameAppCard>
            ) : (
              <GameAppCard
                title="Help &amp; Support"
                className="phone-support-card"
                description="Find help or send a report when something does not look right."
              >
                {bugReportsEnabled ? <GameAppActionBar><GameAppButton variant="primary" className="phone-support-report" onClick={onOpenBugReport}>Report a Bug</GameAppButton></GameAppActionBar> : null}
              </GameAppCard>
            )}
          </>
        ) : primaryTab === "account" ? (
          <>
            <GameAppTabs
              variant="subtabs"
              ariaLabel="Account settings"
              activeTab={accountTab}
              onChange={(tab) => setAccountTab(tab as typeof accountTab)}
              tabs={[
                { id: "account", label: "Account" },
                ...(nativePushEnabled() ? [{ id: "notifications", label: "Notifications" }] : []),
                { id: "delete", label: "Delete Account" }
              ]}
            />
            {accountTab === "notifications" ? <NativeNotificationSettings /> : accountTab === "delete" ? (
              <GameAppCard
                title="Delete Account"
                className="phone-map-settings phone-account-settings"
                description="Request deletion of your Ash Atlas account and associated personal data."
              >
                <p>The secure page verifies ownership before support processes the request.</p>
                <a className="phone-account-delete-link game-app-button game-app-button-destructive" href={accountDeletionUrl}>Delete Account</a>
              </GameAppCard>
            ) : (
              <GameAppCard
                title="Account"
                className="phone-map-settings phone-account-settings"
                description="Manage sign-in methods and this session."
              >
                {accountLoginMethods ? <AccountLoginMethods {...accountLoginMethods} appleSignInEnabled={appleSignInEnabled} onLinkApple={onLinkApple} /> : appleSignInEnabled ? <div className="phone-account-login-methods">
                  <h4>Login methods</h4>
                  <p>Add Apple as a backup way to sign in.</p>
                  <GameAppButton onClick={() => void onLinkApple()}>
                    Link Apple
                  </GameAppButton>
                </div> : null}
                <GameAppActionBar><GameAppButton variant="quiet" onClick={onLogout}>Sign out</GameAppButton></GameAppActionBar>
              </GameAppCard>
            )}
          </>
        ) : (
          <>
            <GameAppTabs
              variant="subtabs"
              ariaLabel="About settings"
              activeTab={aboutTab}
              onChange={(tab) => setAboutTab(tab as typeof aboutTab)}
              tabs={[
                { id: "credits", label: "Credits" },
                { id: "legal", label: "Legal" }
              ]}
            />
            {aboutTab === "credits" ? (
              <GameAppCard
                title="Map &amp; Data Credits"
                className="map-data-credits"
                leading={<MenuDestinationGlyph icon="miscellaneous" />}
              >
                <p>Map data © OpenStreetMap contributors. OpenStreetMap data is available under the Open Database Licence (ODbL).</p>
                <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap copyright &amp; ODbL</a>
                <p>The World Map country overview uses Natural Earth public-domain map data.</p>
                <a href="https://www.naturalearthdata.com/about/terms-of-use/" target="_blank" rel="noopener noreferrer">Natural Earth terms of use</a>
                <p className="map-renderer-notice">Interactive maps are rendered with MapLibre GL JS.</p>
                <p>Population data: GHS-POP R2023A, European Commission Joint Research Centre (CC BY 4.0), summarised into coarse zones.</p>
                <a href="https://ghsl.jrc.ec.europa.eu/" target="_blank" rel="noopener noreferrer">Global Human Settlement Layer</a>
                <p>IP geolocation by DB-IP.com (CC BY 4.0), used on the server for fraud prevention.</p>
                <a href="https://db-ip.com" target="_blank" rel="noopener noreferrer">IP Geolocation by DB-IP</a>
              </GameAppCard>
            ) : (
              <GameAppCard title="Privacy &amp; Community Rules" className="phone-legal-card">
                <a className="phone-support-privacy" href="https://playashatlas.com/privacy" target="_blank" rel="noopener noreferrer">Privacy Policy</a>
                <a className="phone-support-privacy" href="https://playashatlas.com/terms" target="_blank" rel="noopener noreferrer">Terms &amp; Community Rules</a>
              </GameAppCard>
            )}
          </>
        )}
      </div>
    </GameAppShell>
  );
}

function useLayoutInert(
  ref: RefObject<HTMLElement | null>,
  inert: boolean
): void {
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    element.toggleAttribute("inert", inert);
    element.setAttribute("aria-hidden", String(inert));
    element.dataset.chatSuppressed = String(inert);
  }, [inert, ref]);
}

function BuildDestination({ options, materialCounts, onBack, openedFromPlanning }: {
  options: readonly PhoneBuildOption[];
  materialCounts: Readonly<Partial<Record<string, number>>> | undefined;
  onBack(): void;
  openedFromPlanning: boolean;
}): React.JSX.Element {
  const [category, setCategory] =
    useState<PhoneBuildOption["category"]>("personal");
  const visibleOptions = options
    .filter((option) => option.category === category && !isDecorationBuildOption(option))
    .slice()
    .sort(compareBuildOptions);
  return (
    <GameAppShell
      open
      title="Construction"
      menuId="build"
      headerStatus={{ value: options.filter((option) => !isDecorationBuildOption(option)).length, label: "Plans" }}
      closeLabel="Close Construction"
      className="phone-build-layer"
      layout="phone"
      phoneShowBack={!openedFromPlanning}
      phoneShowReturnToGame={openedFromPlanning}
      {...(!openedFromPlanning ? { phoneBackLabel: "Back to Game Menu" } : {})}
      phoneOnBack={onBack}
      {...(openedFromPlanning ? {
        phoneOnEscape: requestMobileMenuReturnToGame,
        phoneOnReturnToGame: requestMobileMenuReturnToGame
      } : {})}
      onClose={onBack}
    >
      <div className="phone-build-list">
        <div className="phone-build-tabs">
        <GameAppTabs
          variant="housed"
          ariaLabel="Construction sections"
          activeTab={category}
          onChange={(tab) => setCategory(tab as PhoneBuildOption["category"])}
          tabs={(["personal", "city", "kingdom", "war"] as const).map((tab) => ({
            id: tab,
            label: tab[0]!.toUpperCase() + tab.slice(1)
          }))}
        />
        </div>
        <section className="game-app-card-grid" aria-label={`${category} construction options`}>
          {visibleOptions.map((option) => (
            <GameAppCard
              key={option.id}
              title={option.title}
              className={`phone-build-card${option.active ? " active" : ""}${option.affordable === false ? " missing-materials" : ""}`}
              leading={option.imageUrl ? (
                <img className="phone-build-artwork" src={option.imageUrl} alt="" aria-hidden="true" />
              ) : <BuildOptionGlyph icon={option.icon} />}
              status={<BuildStatus option={option} />}
              description={option.description}
              {...(option.active ? { badge: "Active" } : {})}
              action={(
                <GameAppActionBar>
                  <GameAppButton
                    variant="primary"
                    disabled={!option.enabled}
                    title={option.disabledReason ?? option.actionLabel}
                    onClick={option.execute}
                  >
                    {option.actionLabel}
                  </GameAppButton>
                </GameAppActionBar>
              )}
            >
              <div className="phone-build-requirements" aria-label={`${option.title} requirements`}>
                {option.requirements.map((requirement) => (
                  typeof requirement === "string"
                    ? <span key={requirement}>{requirement}</span>
                    : "currency" in requirement
                      ? (
                        <MaterialChip
                          key={requirement.currency}
                          itemId="gold"
                          name={CURRENCY_NAMES[requirement.currency]}
                          need={requirement.quantity}
                          have={requirement.have}
                        />
                      )
                      : (
                        <MaterialChip
                          key={requirement.itemId}
                          itemId={requirement.itemId}
                          name={resourceDisplayName(requirement.itemId)}
                          need={requirement.quantity}
                          have={"have" in requirement
                            ? requirement.have
                            : materialCounts ? materialCounts[requirement.itemId] ?? 0 : undefined}
                        />
                      )
                ))}
              </div>
              {buildOptionNote(option) ? <p className="phone-build-note">{buildOptionNote(option)}</p> : null}
            </GameAppCard>
          ))}
        </section>
      </div>
    </GameAppShell>
  );
}

const CURRENCY_NAMES = { city_coins: "City Coins", city_gold: "City Gold", gold: "Gold" } as const;

/**
 * The check/X mark alone says whether the card can be built. A word shows only when there is no mark to
 * show: construction in progress, or something that already exists ("Built" / "Active").
 */
function BuildStatus({ option }: { option: PhoneBuildOption }): React.JSX.Element {
  if (option.active || option.status === "Built" || (option.status === "Active" && !option.enabled)) return <>{option.status}</>;
  return <CraftStatusMark ready={option.enabled} verb="build" />;
}

/** One concise line: the blocking reason, never the material sentence the chips already show. */
function buildOptionNote(option: PhoneBuildOption): string | null {
  if (option.enabled || !option.disabledReason) return option.guidance;
  return option.disabledReason.startsWith("Requires ") ? null : option.disabledReason;
}

function isDecorationBuildOption(option: PhoneBuildOption): boolean {
  return option.icon === "decoration" || option.id.startsWith("decoration:");
}

function compareBuildOptions(left: PhoneBuildOption, right: PhoneBuildOption): number {
  const leftName = left.title.trim().toLowerCase();
  const rightName = right.title.trim().toLowerCase();
  if (leftName < rightName) return -1;
  if (leftName > rightName) return 1;
  const leftTitle = left.title.trim();
  const rightTitle = right.title.trim();
  if (leftTitle < rightTitle) return -1;
  if (leftTitle > rightTitle) return 1;
  const leftId = String(left.id);
  const rightId = String(right.id);
  if (leftId < rightId) return -1;
  if (leftId > rightId) return 1;
  return 0;
}

function BuildOptionGlyph({ icon }: {
  icon: PhoneBuildOption["icon"];
}): React.JSX.Element {
  const paths: Record<PhoneBuildOption["icon"], ReactNode> = {
    flag: <><path d="M6 21V3M7 4h10l-2 4 2 4H7"/><path d="M3 21h8"/></>,
    buoy: <><path d="M12 3v5M9 5h6"/><circle cx="12" cy="12" r="4"/><path d="M5 18c2-2 4 2 7 0s5 2 7 0"/></>,
    manor: <><path d="M4 20h16M6 20V10l6-6 6 6v10"/><path d="M10 20v-6h4v6"/></>,
    greenhouse: <><path d="M3 20h18M5 20V9h14v11"/><path d="M5 9 12 4l7 5M9 9v11M15 9v11"/><path d="M6 13h2M10 13h4M16 13h2M6 17h2M10 17h4M16 17h2"/></>,
    "water-bucket": <><path d="M6 8h12l-1 12H7L6 8Z"/><path d="M8 8a4 4 0 0 1 8 0M9 4h6"/><path d="M10 12h.01M14 15h.01"/></>,
    "city-house": <><path d="M3 21h18M5 21V11l7-6 7 6v10"/><path d="M9 21v-6h6v6M8 12h2M14 12h2"/></>,
    "city-construction": <><path d="M3 21h18M5 21V10l7-6 7 6v11"/><path d="M8 15h8M8 18h8"/></>,
    "oil-well": <><path d="M3 21h18M7 21V9h10v12M5 9h14M8 6h8M10 3h4"/><path d="M10 13h4v4h-4z"/></>,
    lodge: <><path d="M3 21h18M5 21V11l7-7 7 7v10"/><path d="M9 21v-6h6v6M8 11h2M14 11h2"/></>,
    barracks: <><path d="M3 21h18M5 21V9h14v12"/><path d="M8 9V5h8v4M8 13h8M8 17h8"/></>,
    "demolition-factory": <><path d="M3 21h18M5 21V10l6-3 3 2 5-3v15"/><path d="M8 13h2M14 13h2M8 17h8"/></>,
    furnace: <><path d="M4 21h16M6 21V10h12v11M8 10V6h8v4M9 15h6v6"/><path d="M10 3h4"/></>,
    tannery: <rect x="6" y="6" width="12" height="12" />,
    loom: <><path d="M5 4h14M7 4v16M17 4v16M5 20h14"/><path d="M9 8h6M9 12h6M9 16h6"/></>,
    kitchen: <><path d="M4 20h16M6 20V9h12v11M8 9V5h8v4"/><path d="M9 13h6M9 16h6"/></>,
    "fishing-hut": <><path d="M4 20h16M6 20V11l6-6 6 6v9"/><path d="M12 5v-2M9 14c2-2 4-2 6 0M15 14c2 0 3 1 4 3"/></>,
    warehouse: <><path d="M3 9l9-5 9 5v11H3V9z"/><path d="M7 12h10v8H7zM7 15h10"/></>,
    salon: <><path d="M5 21h14M7 21V8h10v13M9 8V5h6v3"/><path d="M9 12h6M12 9v6M9 18h6"/></>,
    market: <><path d="M3 9h18l-2-5H5L3 9Z"/><path d="M5 9v11h14V9M8 20v-6h8v6M3 9c0 2 3 2 3 0 0 2 3 2 3 0 0 2 3 2 3 0 0 2 3 2 3 0 0 2 3 2 3 0"/></>,
    monument: <><path d="M5 21h14M7 18h10M9 18V8h6v10M8 8h8M10 5h4M12 2v3"/></>,
    city: <><path d="M3 21h18M5 21V9h5v12M10 21V5h5v16M15 21v-9h4v9"/><path d="M7 12h1M12 9h1M12 13h1M17 15h1"/></>,
    kingdom: <><path d="M4 21h16M6 21V10l3 2 3-5 3 5 3-2v11"/><path d="M8 17h8M10 21v-5h4v5M9 7l3-4 3 4"/></>,
    decoration: <><path d="M12 3v18M5 8h14M7 8v6h10V8M9 21h6"/><path d="m9 5 3-2 3 2"/></>,
    monolith: <><path d="M9 21V7l3-4 3 4v14"/><path d="M6 21h12M10.5 11h3M10.5 15h3"/></>,
    treasure: <><path d="M14 4l6 6M12 6l6 6-3 3-6-6 3-3Z"/><path d="M9 11 4 20l9-5M3 21h7"/></>,
    sapling: <><path d="M12 21v-9"/><path d="M12 14c-4 0-6-2-6-6 4 0 6 2 6 6Z"/><path d="M12 12c0-4 2-6 6-6 0 4-2 6-6 6Z"/><path d="M8 21h8"/></>
  };
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      data-build-icon={icon}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.65"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {paths[icon]}
    </svg>
  );
}

function LegacyControlGlyph({ icon }: {
  icon: "build" | "clear" | "ruler" | "recenter" | "resin" | "anchor" | "select" | "hotbar";
}): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      data-legacy-icon={icon}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {icon === "hotbar" ? (
        <>
          <rect x="4" y="4" width="6" height="6" rx="1" />
          <rect x="14" y="4" width="6" height="6" rx="1" />
          <rect x="4" y="14" width="6" height="6" rx="1" />
          <rect x="14" y="14" width="6" height="6" rx="1" />
        </>
      ) : icon === "build" ? (
        <>
          <path d="m14 4 6 6-3 3-6-6 3-3Z" />
          <path d="m13 9-8 8 2 2 8-8" />
        </>
      ) : icon === "clear" ? (
        <><path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13"/><path d="M10 11v5M14 11v5"/></>
      ) : icon === "anchor" ? (
        <><circle cx="12" cy="5" r="2" /><path d="M12 7v11M8 11H5a7 7 0 0 0 14 0h-3M8 20h8" /></>
      ) : icon === "select" ? (
        <><path d="m5 3 5.5 14 2.2-5.2L18 9.5 5 3Z"/><path d="m13 14 4 5"/></>
      ) : icon === "ruler" ? (
        <><path d="M4 17 17 4l3 3L7 20 4 17Z"/><path d="m8 15 2 2m1-5 2 2m1-5 2 2M4 4l16 16M20 4 4 20"/></>
      ) : icon === "recenter" ? (
        <>
          <circle cx="12" cy="12" r="6" />
          <circle cx="12" cy="12" r="2" />
          <path d="M12 2v4M12 18v4M2 12h4M18 12h4" />
        </>
      ) : (
        <>
          <path d="M12 3s6 7 6 12a6 6 0 0 1-12 0c0-5 6-12 6-12Z" />
          <path d="M9 16c.7 1.3 1.7 2 3 2" />
          <path d="M12 10v5M9.5 12.5h5" />
        </>
      )}
    </svg>
  );
}

function PlanningToolGlyph({ icon }: Readonly<{ icon: "undo" | "layers" | "pencil" | "trees" }>): React.JSX.Element {
  return <svg
    viewBox="0 0 24 24"
    aria-hidden="true"
    data-planning-tool-icon={icon}
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    {icon === "undo"
      ? <><path d="M9 7H4l3-3"/><path d="M4 7c2-2 4-3 7-3 5 0 8 3 8 7s-3 7-8 7h-3"/></>
      : icon === "layers"
        ? <><path d="m12 3 8 4-8 4-8-4 8-4Z"/><path d="m4 12 8 4 8-4M4 17l8 4 8-4"/></>
        : icon === "trees"
          ? <><path d="m12 3-5 7h3l-4 6h12l-4-6h3l-5-7Z"/><path d="M12 16v5"/></>
          : <><path d="m4 20 4.2-1 10-10-3.2-3.2-10 10L4 20Z"/><path d="m13.8 6.2 3.2 3.2M6 17.8l-1.8-1.8"/></>}
  </svg>;
}

export function GameMenuProfileSummary({ data, onOpen }: {
  data: GameMenuProfileSummaryData;
  onOpen(): void;
}): React.JSX.Element {
  const playerName = data.player?.username.trim() || "Adventurer";
  const experienceAccessibleLabel = data.xpLabel === "MAX"
    ? "Experience maxed"
    : `Experience ${data.xpLabel}`;
  const kdAccessibleLabel = data.kdLabel === "—"
    ? "Lifetime kill death ratio is not tracked yet"
    : `KD ${data.kdLabel}`;
  const accessibleLabel = [
    `Open Loadout for ${playerName}`,
    [data.className, data.levelLabel].filter(Boolean).join(", "),
    `Kingdom ${data.kingdomLabel}, City ${data.cityLabel}`,
    kdAccessibleLabel,
    `Gold ${data.goldLabel}`,
    `Health ${data.healthLabel}`,
    `Pack ${data.packLabel}`,
    `Hunger ${data.hungerLabel}`,
    experienceAccessibleLabel
  ].join(". ");
  const xpPercent = data.xpPercent === null
    ? 0
    : Math.max(0, Math.min(100, data.xpPercent));
  const hungerPercent = data.hungerPercent === null
    ? 0
    : Math.max(0, Math.min(100, data.hungerPercent));
  return <button
    type="button"
    className="phone-menu-profile"
    data-mobile-menu-profile="true"
    data-mobile-menu-id="profile"
    data-mobile-menu-kind="destination"
    aria-label={accessibleLabel}
    onClick={onOpen}
  >
    <span className="phone-menu-profile-art" aria-hidden="true">
      {data.player?.appearance ? <RigPortrait
        appearance={data.player.appearance}
        animate
        className="phone-menu-profile-preview"
        ariaLabel={`${playerName} appearance`}
      /> : <span className="phone-menu-profile-appearance-placeholder">Appearance loading</span>}
    </span>
    <span className="phone-menu-profile-copy">
      <span className="phone-menu-profile-eyebrow">{data.titleLabel}</span>
      <strong className="phone-menu-profile-name">{playerName}</strong>
      <span className="phone-menu-profile-class">{[data.className, data.levelLabel].filter(Boolean).join(" · ")}</span>
      <span className="phone-menu-profile-stats" aria-hidden="true">
        <span className="phone-menu-profile-stat" data-profile-stat="kingdom"><StatGlyph icon="kingdom" /><small>Kingdom</small><b>{data.kingdomLabel}</b></span>
        <span className="phone-menu-profile-stat" data-profile-stat="city"><StatGlyph icon="city" /><small>City</small><b>{data.cityLabel}</b></span>
        <span className="phone-menu-profile-stat" data-profile-stat="gold"><StatGlyph icon="tolls" /><small>Gold</small><b>{data.goldLabel}</b></span>
        <span className="phone-menu-profile-stat" data-profile-stat="storage"><StatGlyph icon="equipment" /><small>Storage</small><b>{data.packLabel}</b></span>
      </span>
      <span
        className={`phone-menu-profile-hunger phone-menu-profile-hunger--${data.hungerState}`}
        data-hunger-state={data.hungerState}
        aria-hidden="true"
      >
        <span className="phone-menu-profile-hunger-heading"><small>Hunger</small><b>{data.hungerLabel}</b></span>
        <span className="phone-menu-profile-hunger-track"><i style={{ width: `${hungerPercent}%` }} /></span>
      </span>
      <span className="phone-menu-profile-xp" aria-hidden="true">
        <span><small>XP</small><b>{data.xpLabel}</b></span>
        <span className="phone-menu-profile-xp-track"><i style={{ width: `${xpPercent}%` }} /></span>
      </span>
    </span>
  </button>;
}

function createGameMenuProfileSummaryData({
  affiliation,
  player,
  progression,
  combat,
  walletGold,
  hunger,
  inventoryUsed,
  inventoryTotal
}: {
  affiliation?: GameMenuAffiliation | undefined;
  player: GameMenuPlayer | null;
  progression: ProgressionSnapshot | null;
  combat: CombatEntitySnapshot | null;
  walletGold: MarketInteger | null;
  hunger: HungerSnapshot | null;
  inventoryUsed: number | string;
  inventoryTotal: number | string;
}): GameMenuProfileSummaryData {
  // The server-authoritative active class (PlayerSnapshot.classId). The legacy class profile still stores old
  // classes such as Ninja, so it is never shown here.
  const className = player?.classId ? SPECIALIZATION_DEFINITIONS[player.classId]?.displayName ?? null : null;
  const levelLabel = progression
    ? `Level ${progression.atCap ? CURRENT_LEVEL_CAP : progression.level}`
    : "Level —";
  const healthCurrent = finiteNonnegative(combat?.currentHealth ?? progression?.pveStats.maxHealth);
  const healthMaximum = finiteNonnegative(combat?.maxHealth ?? progression?.pveStats.maxHealth);
  const healthLabel = healthCurrent !== null && healthMaximum !== null
    ? `${healthCurrent.toLocaleString()} / ${healthMaximum.toLocaleString()}`
    : "—";
  const hungerCurrent = finiteNonnegative(hunger?.current);
  const hungerMaximum = finiteNonnegative(hunger?.baseCapacity);
  const hungerRatio = hungerCurrent !== null && hungerMaximum !== null && hungerMaximum > 0
    ? hungerCurrent / hungerMaximum
    : null;
  const hungerPercent = hungerRatio === null
    ? null
    : Math.round(Math.min(100, hungerRatio * 100));
  const hungerState: GameMenuProfileSummaryData["hungerState"] = hungerRatio === null || hungerCurrent === 0
    ? "empty"
    : hungerRatio >= 1
      ? "full"
      : hungerRatio >= 0.5
        ? "half"
        : "small";
  const hungerLabel = hungerCurrent !== null && hungerMaximum !== null
    ? `${hungerCurrent.toLocaleString()} / ${hungerMaximum.toLocaleString()}`
    : "—";
  const xpCurrent = finiteNonnegative(progression?.xpIntoLevel);
  const xpMaximum = finiteNonnegative(progression?.xpForNextLevel);
  const xpPercent = progression === null
    ? null
    : progression.atCap
      ? 100
      : xpCurrent !== null && xpMaximum !== null && xpMaximum > 0
        ? Math.round(Math.min(100, xpCurrent / xpMaximum * 100))
        : null;
  const xpLabel = progression === null
    ? "—"
    : progression.atCap
      ? "MAX"
      : xpCurrent !== null && xpMaximum !== null
        ? `${xpCurrent.toLocaleString()} / ${xpMaximum.toLocaleString()}`
        : "—";
  const safeInventoryUsed = inventoryGrams(inventoryUsed);
  const safeInventoryTotal = inventoryGrams(inventoryTotal);
  return {
    player,
    titleLabel: affiliation?.title?.trim() || "Adventurer",
    kingdomLabel: affiliation?.kingdom?.trim() || "No kingdom",
    cityLabel: affiliation?.city?.trim() || "No city",
    className,
    levelLabel,
    kdLabel: "—",
    goldLabel: walletGold === null ? "—" : formatMarketInteger(walletGold),
    healthLabel,
    hungerLabel,
    hungerPercent,
    hungerState,
    xpLabel,
    xpPercent,
    packLabel: `${formatWeightKg(safeInventoryUsed)} / ${formatWeightKg(safeInventoryTotal)} kg`
  };
}

function finiteNonnegative(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : null;
}

function GameMenu({
  destinations,
  affiliation,
  player,
  progression,
  combat,
  walletGold,
  hunger,
  inventoryUsed,
  inventoryTotal,
  synchronizedNow,
  onOpenDestination,
  onOpenDeveloperTools,
  onBack,
  background = false
}: {
  destinations: readonly PhoneMenuDestination[];
  affiliation?: GameMenuAffiliation | undefined;
  player: GameMenuPlayer | null;
  progression: ProgressionSnapshot | null;
  combat: CombatEntitySnapshot | null;
  walletGold: MarketInteger | null;
  hunger: HungerSnapshot | null;
  inventoryUsed: number | string;
  inventoryTotal: number | string;
  synchronizedNow(): number;
  onOpenDestination(id: MobileMenuDestinationId): void;
  onOpenDeveloperTools?(): void;
  onBack(): void;
  background?: boolean;
}): React.JSX.Element | null {
  const floating = useUiPresentation() === "desktop";
  const dialogRef = useModalBehavior<HTMLElement>({ open: !background && !floating, onClose: onBack });
  const profileSummary = createGameMenuProfileSummaryData({
    affiliation,
    player,
    progression,
    combat,
    walletGold,
    hunger,
    inventoryUsed,
    inventoryTotal
  });
  const hasProfileDestination = destinations.some(({ id }) => id === "profile");
  const announcementState = destinations.find(({ id }) => id === "announcements");
  const patchNoteState = destinations.find(({ id }) => id === "patch-notes");
  const noticeBadgeCount = (announcementState?.badgeCount ?? 0) + (patchNoteState?.badgeCount ?? 0);
  const noticeBadge = noticeBadgeCount > 0 ? formatMenuBadge(noticeBadgeCount) : null;
  const noticeBadgeAccessibleLabel = [
    announcementState?.badgeAccessibleLabel,
    patchNoteState?.badgeAccessibleLabel
  ].filter(Boolean).join(", ");
  const noticeBoardEntry = MOBILE_MENU_ROOT_UTILITIES[0];
  const settingsEntry = MOBILE_MENU_ROOT_UTILITIES[1];
  const content = <>
      <header className={`phone-menu-header phone-menu-root-header${onOpenDeveloperTools && !floating ? " phone-menu-root-header--developer" : ""}`}>
        <div className="phone-menu-root-heading"><h1 id="phone-game-menu-title" aria-label="Game Menu"><DesktopWindowTitle>Game Menu</DesktopWindowTitle></h1></div>
        {onOpenDeveloperTools && !floating ? <button
          type="button"
          className="phone-menu-header-action phone-menu-developer-tools"
          aria-label="Developer App"
          title="Developer App"
          onClick={onOpenDeveloperTools}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14.7 6.3a4 4 0 0 0 5 5L22 9.6a6.5 6.5 0 0 1-8.6 8.6L6.5 21.5a2.1 2.1 0 0 1-3-3l3.3-6.9A6.5 6.5 0 0 1 14.4 2.8Z" /></svg>
        </button> : null}
        <div className="phone-menu-header-actions" role="group" aria-label="Game Menu utilities">
          <GameMenuWorldTime synchronizedNow={synchronizedNow} />
          <button
            type="button"
            className="phone-menu-header-action phone-menu-notice-board"
            data-mobile-menu-id={noticeBoardEntry.id}
            data-mobile-menu-kind="utility"
            aria-label={[noticeBoardEntry.label, noticeBadgeAccessibleLabel].filter(Boolean).join(", ")}
            title={noticeBoardEntry.label}
            onClick={() => onOpenDestination(noticeBoardEntry.id)}
          >
            <MenuDestinationGlyph icon="announcements" />
            {noticeBadge ? <span className="phone-menu-unread-badge" aria-hidden="true">{noticeBadge}</span> : null}
          </button>
          <button
            type="button"
            className="phone-menu-header-action phone-menu-utility"
            data-mobile-menu-id={settingsEntry.id}
            data-mobile-menu-kind="utility"
            aria-label={settingsEntry.label}
            title={settingsEntry.label}
            onClick={() => onOpenDestination(settingsEntry.id)}
          >
            <MenuDestinationGlyph icon="miscellaneous" />
          </button>
        </div>
      </header>
      <div
        className="phone-menu-scroll"
        data-mobile-menu-profile={hasProfileDestination ? "true" : undefined}
      >
        {hasProfileDestination ? <GameMenuProfileSummary
          data={profileSummary}
          onOpen={() => onOpenDestination("profile")}
        /> : null}
        <GameMenuDirectory
          destinations={destinations}
          onOpenDestination={onOpenDestination}
        />
      </div>
      <footer className="phone-menu-footer phone-menu-root-footer" aria-label="Return to Game">
        <button type="button" className="phone-menu-return" aria-label="Return to Game" onClick={() => onBack()}><span className="phone-menu-nav-label">Return to Game</span></button>
      </footer>
    </>;
  if (floating && background) return null;
  if (floating) return <DesktopWindow windowKey="app:game-menu" className="phone-menu-layer desktop-game-directory" aria-labelledby="phone-game-menu-title" onRequestClose={onBack}>{content}</DesktopWindow>;
  return <section ref={dialogRef} className={`phone-menu-layer${background ? " phone-menu-layer-underlay" : ""}`}
    role={background ? undefined : "dialog"} aria-modal={background ? undefined : "true"}
    aria-labelledby={background ? undefined : "phone-game-menu-title"} aria-hidden={background || undefined}
    inert={background} tabIndex={background ? undefined : -1}
    onPointerDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()}>{content}</section>;
}

export function GameMenuDirectory({
  destinations,
  onOpenDestination
}: {
  destinations: readonly PhoneMenuDestination[];
  onOpenDestination(id: MobileMenuDestinationId): void;
}): React.JSX.Element {
  const destinationState = new Map(destinations.map((destination) => [destination.id, destination]));
  return <nav className="phone-menu-root" aria-label="Game Menu destinations">
    <div className="phone-menu-primary-grid phone-menu-sheet" aria-label="Primary apps">
      {MOBILE_MENU_ROOT_SECTIONS.map((section) => {
        const entries = section.entries.filter((entry) => destinationState.has(entry.id));
        if (entries.length === 0) return null;
        const headingId = `phone-menu-section-${section.id}`;
        return <section key={section.id} className="phone-menu-sheet-section" aria-labelledby={headingId}>
          <h2 id={headingId} className="phone-menu-sheet-heading">{section.label}</h2>
          <div className="phone-menu-sheet-row">
            {entries.map((entry) => <MenuDirectoryDestinationButton
              key={entry.id}
              id={entry.id}
              state={destinationState.get(entry.id)}
              label={entry.label}
              root
              onOpen={onOpenDestination}
            />)}
          </div>
        </section>;
      })}
    </div>
  </nav>;
}

function MenuDirectoryDestinationButton({
  id,
  state,
  label,
  root = false,
  onOpen
}: {
  id: MobileMenuDestinationId;
  state: PhoneMenuDestination | undefined;
  label?: string;
  root?: boolean;
  onOpen(id: MobileMenuDestinationId): void;
}): React.JSX.Element {
  const definition = DESTINATION_BY_ID.get(id)!;
  const visibleLabel = label ?? definition.label;
  const badgeAccessibleLabel = state?.badgeAccessibleLabel
    ?? (state?.badgeCount
      ? id === "party" ? `${state.badgeCount} pending party invites`
        : id === "messages" ? `${state.badgeCount} unread messages`
          : `${state.badgeCount} status`
      : null);
  const ariaLabel = [visibleLabel, badgeAccessibleLabel, state?.disabledReason].filter(Boolean).join(", ");
  return <button
    type="button"
    className={`phone-menu-item${root ? " phone-menu-root-item" : ""}`}
    data-mobile-menu-id={id}
    data-mobile-menu-kind={root ? "destination" : undefined}
    disabled={Boolean(state?.disabledReason)}
    title={state?.disabledReason ?? visibleLabel}
    aria-label={ariaLabel}
    onClick={() => onOpen(id)}
  >
    <MenuDestinationGlyph icon={definition.icon} />
    <span className="phone-menu-label">
      <span className="phone-menu-label-text">{visibleLabel}</span>
      {state?.badge ? <small className="phone-menu-unread-badge" aria-hidden="true">{state.badge}</small> : null}
    </span>
    {state?.disabledReason ? <small className="phone-menu-disabled-reason">{state.disabledReason}</small> : null}
  </button>;
}

function formatMenuBadge(count: number): string {
  return `${Math.min(99, count)}${count > 99 ? "+" : ""}`;
}

export function GameMenuWorldTime({ synchronizedNow }: Readonly<{ synchronizedNow(): number }>): React.JSX.Element {
  const [now, setNow] = useState(() => synchronizedNow());
  useEffect(() => {
    setNow(synchronizedNow());
    const timer = window.setInterval(() => setNow(synchronizedNow()), 30_000);
    return () => window.clearInterval(timer);
  }, [synchronizedNow]);
  const snapshot = worldTimeAt(now);
  const phaseLabel = snapshot.phase[0]!.toUpperCase() + snapshot.phase.slice(1);
  return <time className="phone-menu-world-time" aria-label={`${snapshot.formattedLabel}, ${phaseLabel}`}>
    <strong>{snapshot.formattedLabel}</strong>
    <small>{phaseLabel}</small>
  </time>;
}

function PlaceholderDestination({ destination, onBack }: { destination: PhoneMenuDestination; onBack(): void }): React.JSX.Element {
  const definition = DESTINATION_BY_ID.get(destination.id);
  return (
    <PhoneMenuDestinationShell title={definition?.label ?? destination.id} className="phone-destination-layer" onBack={onBack}>
      <div className="phone-destination-content">
        <MenuDestinationGlyph icon={definition?.icon ?? "achievements"} />
        <p>{destination.placeholder}</p>
        <small>This mobile shell is ready for the feature when its gameplay system is available.</small>
      </div>
    </PhoneMenuDestinationShell>
  );
}

function ActionRail({ side, actions, execute }: { side: "left" | "right"; actions: readonly PhoneAction[]; execute(action: PhoneAction): void }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const stackId = `phone-quick-slot-stack-${side}`;
  const slots = Array.from({ length: 4 }, (_, index) => actions[index] ?? null);
  const toggleLabel = `${open ? "Collapse" : "Expand"} ${side} quick slots`;

  return <aside
    className={`phone-action-rail phone-action-rail-${side} phone-quick-slot-rail phone-quick-slot-rail-${side}${open ? " is-open" : ""}`}
    aria-label={`${side} general quick slots`}
    data-quick-slot-kind="general"
  >
    <button
      type="button"
      className="phone-quick-slot-toggle"
      aria-expanded={open}
      aria-controls={stackId}
      aria-label={toggleLabel}
      title={toggleLabel}
      onPointerDown={(event) => event.stopPropagation()}
      onPointerUp={(event) => event.stopPropagation()}
      onPointerCancel={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation();
        setOpen((current) => !current);
      }}
    >
      <QuickSlotChevron side={side} open={open} />
    </button>
    <div
      id={stackId}
      className="phone-quick-slot-stack"
      aria-label={`${side} general quick slots`}
    >
      {slots.map((action, index) => action
        ? <PhoneQuickSlotButton key={action.id} action={action} index={index} execute={() => execute(action)} />
        : <EmptyQuickSlot key={`empty-${index}`} side={side} index={index} />)}
    </div>
  </aside>;
}

function PlanningBuilderLegacyControls({
  mode,
  canUndo,
  undoDisabledReason,
  onToggleMode,
  onSelectPencil,
  onSelectTrees,
  onUndo,
  onOpenLayers,
  onClearLayer,
  onExit
}: Readonly<{
  mode: "anchor" | "select" | "pencil" | "trees";
  canUndo: boolean;
  undoDisabledReason: string | null;
  onToggleMode(): void;
  onSelectPencil(): void;
  onSelectTrees(): void;
  onUndo(): void;
  onOpenLayers(): void;
  onClearLayer(): void;
  onExit(): void;
}>): React.JSX.Element {
  const modeLabel = mode === "anchor" ? "Anchor" : mode === "select" ? "Select" : mode === "trees" ? "Trees" : "Pencil";
  return <>
    <button
      type="button"
      className={`legacy-control-button planning-builder-mode-button planning-builder-mode-${mode}`}
      aria-label={mode === "anchor" ? "Switch to Select mode" : "Switch to Anchor mode"}
      title={`Switch to ${mode === "anchor" ? "Select" : "Anchor"} mode`}
      aria-pressed={mode === "anchor"}
      onClick={(event) => {
        event.stopPropagation();
        onToggleMode();
      }}
    >
      <LegacyControlGlyph icon={mode === "anchor" ? "anchor" : "select"} />
      <span className="sr-only">{modeLabel} mode</span>
    </button>
    <button
      type="button"
      className={`legacy-control-button planning-builder-pencil-button${mode === "pencil" ? " is-active" : ""}`}
      aria-label="Pencil mode"
      title="Pencil mode"
      aria-pressed={mode === "pencil"}
      onClick={(event) => {
        event.stopPropagation();
        onSelectPencil();
      }}
    >
      <PlanningToolGlyph icon="pencil" />
    </button>
    <button
      type="button"
      className={`legacy-control-button planning-builder-trees-button${mode === "trees" ? " is-active" : ""}`}
      aria-label="Tree planting mode"
      title="Tree planting mode: plant Giving Trees on a shared grid"
      aria-pressed={mode === "trees"}
      onClick={(event) => {
        event.stopPropagation();
        onSelectTrees();
      }}
    >
      <PlanningToolGlyph icon="trees" />
    </button>
    <button
      type="button"
      className="legacy-control-button planning-builder-undo-button"
      aria-label={canUndo ? "Undo last anchor" : `Undo last anchor: ${undoDisabledReason ?? "Nothing to undo in this layer."}`}
      title={canUndo ? "Undo last anchor" : (undoDisabledReason ?? "Nothing to undo in this layer.")}
      disabled={!canUndo}
      onClick={(event) => {
        event.stopPropagation();
        onUndo();
      }}
    >
      <PlanningToolGlyph icon="undo" />
    </button>
    <button
      type="button"
      className="legacy-control-button planning-builder-layers-button"
      aria-label="Layers"
      title="Layers"
      onClick={(event) => {
        event.stopPropagation();
        onOpenLayers();
      }}
    >
      <PlanningToolGlyph icon="layers" />
    </button>
    <button
      type="button"
      className="legacy-control-button legacy-planning-clear-button"
      aria-label="Clear Current Layer"
      title="Clear Current Layer"
      onClick={(event) => {
        event.stopPropagation();
        onClearLayer();
      }}
    >
      <LegacyControlGlyph icon="clear" />
    </button>
    <button
      type="button"
      className="legacy-control-button legacy-flag-button ruler-active planning-builder-exit-button"
      aria-label="Exit builder mode"
      title="Exit builder mode"
      onClick={(event) => {
        event.stopPropagation();
        onExit();
      }}
    >
      <LegacyControlGlyph icon="ruler" />
    </button>
  </>;
}

function PhoneQuickSlotButton({ action, index, execute }: { action: PhoneAction; index: number; execute(): void }): React.JSX.Element {
  return <button
    type="button"
    className={`phone-quick-slot${action.active ? " active" : ""}`}
    data-quick-slot-index={index + 1}
    data-quick-slot-kind="general"
    disabled={!action.enabled}
    aria-label={action.enabled ? action.label : `${action.label}: ${action.disabledReason ?? "Unavailable"}`}
    title={action.disabledReason ?? action.label}
    onPointerDown={(event) => event.stopPropagation()}
    onPointerUp={(event) => event.stopPropagation()}
    onPointerCancel={(event) => event.stopPropagation()}
    onClick={(event) => {
      event.stopPropagation();
      execute();
    }}
  >
    <ActionGlyph icon={action.icon} />
    <span>{action.label}</span>
    {action.count ? <small>{action.count}</small> : null}
    {action.cooldownLabel ? <i>{action.cooldownLabel}</i> : null}
  </button>;
}

function EmptyQuickSlot({ side, index }: { side: "left" | "right"; index: number }): React.JSX.Element {
  return <button
    type="button"
    className="phone-quick-slot empty"
    data-quick-slot-index={index + 1}
    data-quick-slot-kind="general"
    disabled
    aria-label={`${side} quick slot ${index + 1}: Empty`}
    title="Empty quick slot"
    onPointerDown={(event) => event.stopPropagation()}
    onPointerUp={(event) => event.stopPropagation()}
    onPointerCancel={(event) => event.stopPropagation()}
  >
    <QuickSlotEmptyGlyph />
    <span>Empty</span>
  </button>;
}

function PhonePlayerStateGlyph({ state }: { state: "aggression" | "protection" | "none" }): React.JSX.Element {
  return <svg
    className={`phone-player-state-glyph phone-player-state-glyph-${state}`}
    viewBox="0 0 24 24"
    aria-hidden="true"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <circle cx="12" cy={state === "protection" ? "13.5" : "12"} r={state === "protection" ? "7.5" : "8.5"} />
    {state === "aggression" ? <>
      <path d="m8.2 9.6 2.1 1M15.8 9.6l-2.1 1" />
      <circle cx="9.3" cy="12" r=".8" fill="currentColor" stroke="none" />
      <circle cx="14.7" cy="12" r=".8" fill="currentColor" stroke="none" />
      <path d="M8.8 16.1c1.7-1 4.7-1 6.4 0" />
    </> : null}
    {state === "protection" ? <>
      <ellipse cx="12" cy="3.3" rx="5" ry="1.8" />
      <path d="m8.5 12 1.5 1 1-1m2 0 1 1 1.5-1M9 16c1.6 1.5 4.4 1.5 6 0" />
    </> : null}
    {state === "none" ? <>
      <circle cx="9.3" cy="11.1" r=".8" fill="currentColor" stroke="none" />
      <circle cx="14.7" cy="11.1" r=".8" fill="currentColor" stroke="none" />
      <path d="M8.5 14c1.8 2.4 5.2 2.4 7 0" />
    </> : null}
  </svg>;
}

function PhoneEconomyGlyph({ kind }: { kind: "gold" | "storage" }): React.JSX.Element {
  return <StatGlyph className={`phone-economy-row-icon phone-economy-row-icon-${kind}`} icon={kind === "gold" ? "coin" : "equipment"} />;
}

function QuickSlotChevron({ side, open }: { side: "left" | "right"; open: boolean }): React.JSX.Element {
  const pointsInward = side === "left" ? !open : open;
  return <svg className="phone-quick-slot-chevron" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d={pointsInward ? "m9 4 6 8-6 8" : "m15 4-6 8 6 8"} />
  </svg>;
}

function QuickSlotEmptyGlyph(): React.JSX.Element {
  return <svg className="phone-quick-slot-empty-glyph" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
    <path d="M12 7v10M7 12h10" />
  </svg>;
}

function ActionGlyph({ icon }: { icon: PhoneActionIcon }): React.JSX.Element {
  const paths: Record<PhoneActionIcon, ReactNode> = {
    attack: <><path d="M6 18 18 6M12 5l7 7M5 12l7 7"/><path d="m4 20 4-1-3-3-1 4Z"/></>,
    stop: <rect x="6" y="6" width="12" height="12" rx="1"/>,
    harvest: <><path d="M7 20c4-5 6-10 6-16M9 12c-3-1-5-3-5-6 3 0 6 2 7 5M13 9c2-3 4-4 7-4 0 3-2 6-6 7"/></>,
    pickup: <><path d="M12 3v12m-4-4 4 4 4-4"/><path d="M5 19h14"/></>,
    amount: <><path d="M7 7h10M7 12h10M7 17h10"/><path d="M4 7h.01M4 12h.01M4 17h.01"/></>,
    visit: <><path d="M12 21s6-5 6-11a6 6 0 1 0-12 0c0 6 6 11 6 11Z"/><circle cx="12" cy="10" r="2"/></>,
    build: <><path d="m4 20 8-8M14 4l6 6-3 3-6-6 3-3Z"/><path d="m4 16 4 4"/></>,
    water: <path d="M12 3s6 7 6 12a6 6 0 0 1-12 0c0-5 6-12 6-12Z"/>,
    city: <><path d="M4 21V9l5-3v15M9 21V4l6 3v14M15 21v-9l5-2v11"/><path d="M2 21h20"/></>,
    delete: <><path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13"/></>,
    more: <><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></>
  };
  return <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{paths[icon]}</svg>;
}


function MenuGlyph(): React.JSX.Element {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14M5 12h14M5 17h14" /></svg>;
}

function inventoryGrams(value: string | number): string {
  return typeof value === "string" && /^\d+$/.test(value) ? value : typeof value === "number" && Number.isFinite(value) ? String(Math.max(0, Math.floor(value))) : "0";
}

function formatWholeWeightKg(grams: string, compact = false): string {
  const kilograms = (BigInt(grams) + 500n) / 1_000n;
  if (compact && kilograms < 10_000n) return kilograms.toString();
  return formatCompactWholeNumber(kilograms);
}

/** The gold number in the bottom bar: counts up when a loot coin lands (see useCountedGold). */
function PhoneGoldValue({ walletGold, title }: Readonly<{ walletGold: MarketInteger | null; title: string }>): React.JSX.Element {
  const shown = useCountedGold(walletGold);
  return <strong title={title}>{shown === null ? "—" : formatCompactWholeNumber(shown)}</strong>;
}

function formatCompactWholeNumber(value: bigint): string {
  if (value < 10_000n) return value.toLocaleString("en-US");
  const units = [
    { value: 1_000_000_000_000_000_000n, suffix: "E" },
    { value: 1_000_000_000_000_000n, suffix: "Q" },
    { value: 1_000_000_000_000n, suffix: "T" },
    { value: 1_000_000_000n, suffix: "B" },
    { value: 1_000_000n, suffix: "M" },
    { value: 1_000n, suffix: "K" }
  ];
  const unit = units.find(({ value: unitValue }) => value >= unitValue);
  return unit ? `${(value / unit.value).toLocaleString("en-US")}${unit.suffix}` : value.toLocaleString("en-US");
}

export { MenuDestinationGlyph };
