import {
  MOB_ARCHETYPE_KEYS,
  dungeonCatalogFromInterior,
  type DungeonCatalog,
  type DungeonColliderDefinition,
  type DungeonDefinition,
  type DungeonEncounterDefinition,
  type DungeonPrefabDefinition,
  type DungeonResourceNodeDefinition,
  type DungeonResourceSpawnZoneDefinition,
  type DungeonRoomDefinition,
  type DungeonTriggerDefinition,
  type IndoorPoint
} from "@ash-atlas/shared";
import { DUNGEON_BOSS_DEFINITIONS, DUNGEON_MESSAGE_MAX_LENGTH, DUNGEON_NOTICE_TONES, DUNGEON_RESOURCE_TYPES, type BossAppearanceCatalog, type DungeonResourceType } from "@ash-atlas/shared";
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useId,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent
} from "react";


import type { DungeonAssetImportOptions, RuntimeAsset, StudioSession } from "./bridgeTypes.js";
import type { StudioApi } from "./studioApi.js";
import { DungeonChestTools, DungeonCompletionTools, DungeonMobBatchTools } from "./DungeonStarterTools.js";
import {
  DEFAULT_DUNGEON_ENTRANCE_ASSET_KEY,
  ONE_ROOM_CHEST_REWARD_TABLE_ID,
  createDungeonFromWizard,
  createDungeonRoom,
  duplicateDungeon,
  createDungeonObject,
  createDungeonResourceNode,
  createDungeonResourceSpawnZone,
  createDungeonRewardTable,
  updateDungeonRewardTable,
  createLayerPlacement,
  createMobPlacement,
  disconnectDungeonWorldEntrance,
  assignMobToEncounterWave,
  defaultTriggerAction,
  defaultTriggerEvent,
  oneRoomCombatReadiness,
  prefabArtSpec,
  removeEncounterWave,
  moveDungeonMobGroup,
  replaceDungeonPrefabArt,
  selectDungeonBossTemplate,
  runtimeDungeonAssetUrl,
  safeDungeonId,
  dungeonAssetId,
  resourceShapeFromZone,
  archiveCreatorDungeon,
  saveDungeonWorldEntrance,
  wireOneRoomCombatFlow,
  type DungeonWizardInput
} from "./dungeonStudioV2.js";
import { DungeonPlayTest } from "./DungeonPlayTest.js";
import { DungeonTopology } from "./DungeonTopologyView.js";
import { buildDungeonTopology, connectDungeonRooms, retireDungeonPortalConnection } from "./dungeonTopology.js";
import {
  INTERIOR_KINDS,
  INTERIOR_KIND_GROUP_LABELS,
  INTERIOR_KIND_LABELS,
  bumpInteriorRevisions,
  changedInteriorSpaceIds,
  createInteriorSpace,
  editableDefinitions,
  interiorCatalogOf,
  interiorEditingView,
  interiorFromEditingView,
  interiorLibraryChanged,
  interiorSpaceKind,
  interiorViewIssues,
  takenInteriorIds,
  type InteriorSeedSpaces
} from "./interiorStudioModel.js";
import { InteriorWalkTest } from "./InteriorWalkTestCanvas.js";
import { GREENHOUSE_WATER_TANK_PREFAB_ID, type InteriorCatalog, type InteriorSpaceKind } from "@ash-atlas/shared";
import { GreenhousePlantersPanel } from "./GreenhouseTemplateEditors.js";
import { editDecorations, editStageArt, effectiveDecorations, effectiveManorExterior, effectiveStageArt, hasDecorationModule, moduleAssetKeys, plantersPotPrefabId, setManorExterior, storedDecorationIds, type ManorExterior } from "./interiorModules.js";
import { InteriorDecorationTest } from "./InteriorDecorationTest.js";
import { decorationSurfacesOf, decorationsAfterRoomEdit } from "./interiorDecorationModel.js";
import type { ViewPrefab } from "./interiorStudioModel.js";
import { AnchorInspector, SHAPE_SELECTION_KINDS, ShapeTools } from "./InteriorShapeTools.js";
import {
  DRAW_SHAPE_LABELS,
  addPolygonShape,
  anchorRoleOf,
  effectiveRoomAuthoring,
  moveShapeVertex,
  retireAnchor,
  retireShape,
  shapeVertices,
  translateShape,
  type AuthoringSources,
  type DrawShapeKind,
  type RoomAuthoring,
  type ShapeRef
} from "./interiorAuthoring.js";
import { shouldClosePolygon, snapPoint } from "./interiorCanvasAuthoring.js";
import {
  CANVAS_TOOLS,
  SHORTCUT_SHEET,
  TOOL_GLYPHS,
  anchorNames,
  describeSelection,
  friendlyId,
  friendlyLayer,
  friendlyObjectType,
  roomChecklist,
  layoutLabels,
  movementProfileText,
  panToPoint,
  prefabMatchesInteriorKind,
  selectionPoint,
  toolForKey,
  type CanvasTool,
  type LabelCandidate,
  type NamingContext
} from "./interiorStudioUx.js";
import { HISTORY_LIMIT, resolveGroup, runOnce, type ActiveGroup, type EditGroup } from "./historyCore.js";
import { useEditGrouping } from "./useEditGrouping.js";

const LAYERS = ["background", "below_player", "actors", "above_player", "ceiling"] as const;
const OBJECT_TYPES = [
  "portal", "door", "ladder", "chest", "valve", "switch", "shrine",
  "harvestable", "destructible", "npc", "decoration", "exit_ladder"
] as const;
type PortalCondition = "always" | "dungeon_active" | "unlocked" | "boss_defeated";
type LayerId = (typeof LAYERS)[number];
type EditorSelection = { kind: "anchor" | "collider" | "zone" | "resourceZone" | "object" | "mob" | "placement" | "floor" | "wall" | "clickArea"; id: string } | null;
type CanvasEntitySelection = Exclude<EditorSelection, null>;
type DungeonLayerPlacement = DungeonRoomDefinition["layers"][keyof DungeonRoomDefinition["layers"]][number];
type PolygonDraft = { kind: DrawShapeKind | "zone"; points: IndoorPoint[] } | null;
const EMPTY_AUTHORING: RoomAuthoring = { autoFloors: true, floors: [], walls: [], clickAreas: [], anchors: {} };
const SHAPE_DEBUG_KEYS: readonly string[] = ["floors", "walls", "clickAreas"];
type PlacementTool = "anchor" | "collider" | "zone" | "object" | "resource" | "resource_zone" | null;
type InspectorTab = "interior" | "room" | "selected" | "shapes" | "portals" | "planters" | "encounters" | "resources" | "rewards" | "logic" | "advanced";
type LibraryCategory = "all" | "art" | "objects" | "doors" | "mobs";
type AuthoringLevel = "simple" | "advanced";
type SimpleStep = "art" | "mobs" | "chest" | "finish" | "test";
const SNAP_STORAGE_KEY = "ash-atlas-interior-studio-snap";
const DEFAULT_WIZARD: DungeonWizardInput = { name: "New Dungeon", themeId: "stone", backgroundColor: "#071116", floorColor: "#182a2d", wallColor: "#405052", accentColor: "#8fbc8f", instancePolicy: "party_ephemeral", resetPolicy: "when_empty", width: 1000, height: 1000 };

export type DungeonStudioHandle = {
  save(): Promise<void>;
  revert(): Promise<void>;
  undo(): void;
  redo(): void;
};

export type InteriorStudioHandle = DungeonStudioHandle;

/** The tabs of the room inspector a space kind offers: gameplay modules are dungeon-only. */
function inspectorTabsFor(kind: InteriorSpaceKind, simple: boolean, shapes: boolean): readonly InspectorTab[] {
  if (kind === "greenhouse") return shapes ? ["interior", "room", "selected", "shapes", "portals", "planters", "advanced"] : ["interior", "room", "selected", "portals", "planters", "advanced"];
  if (kind !== "dungeon") return shapes ? ["interior", "room", "selected", "shapes", "portals", "advanced"] : ["interior", "room", "selected", "portals", "advanced"];
  if (simple) return ["interior", "room", "selected", "portals", "encounters", "resources", "rewards"];
  return shapes
    ? ["interior", "room", "selected", "shapes", "portals", "encounters", "resources", "rewards", "logic", "advanced"]
    : ["interior", "room", "selected", "portals", "encounters", "resources", "rewards", "logic", "advanced"];
}
function interiorTabLabel(tab: InspectorTab): string {
  return tab === "interior" ? "Interior" : tab === "room" ? "Room" : tab === "selected" ? "Objects & Doors" : tab === "portals" ? "Doors & Exits" : tab === "shapes" ? "Floors & Walls" : tab === "advanced" ? "Layout" : tab === "planters" ? "Planters" : tab[0]!.toUpperCase() + tab.slice(1);
}

type DungeonStudioProps = {
  api: StudioApi;
  session: StudioSession;
  visible: boolean;
  writesAllowed: boolean;
  onDirtyChange(dirty: boolean): void;
  onBusyChange(busy: boolean): void;
  onHistoryChange?(history: Readonly<{ undo: number; redo: number }>): void;
  /** The host header owns Undo / Redo / Revert / Save / Publish, so the workspace toolbar omits them. */
  hosted?: boolean;
  onValidationErrorsChange?(errors: number): void;
  onMessage(message: string): void;
};

export type InteriorStudioProps = DungeonStudioProps;

type RecoveryDraft = {
  baseCatalogRevision: number;
  /** Fingerprint of the saved catalog the draft was made on; a draft on other data is never applied silently. */
  baseFingerprint?: string;
  catalog: DungeonCatalog;
  /** Interiors created (and not yet saved) in the draft, keyed by space id. */
  seeds?: InteriorSeedSpaces;
  pendingDungeonAssets?: PendingDungeonAsset[];
  savedAt: string;
};
/** A staged PNG: a dungeon prefab's art (`prefabId`), or a module PNG published by asset key (Greenhouse template and stage art, Manor decoration art). */
type PendingDungeonAsset = { stagingToken: string; prefabId: string; assetKey?: string };

export const InteriorStudio = forwardRef<DungeonStudioHandle, DungeonStudioProps>(
  function InteriorStudio(props, ref) {
    const studioName = "Interior Studio";
    const viewKey = `${recoveryKey(props.session.workspace.worktreePath, props.session.workspace.branch)}:view`;
    const initialView = useMemo(() => readDungeonView(viewKey), [viewKey]);
    const [catalog, setCatalog] = useState<DungeonCatalog | null>(null);
    const [savedCatalog, setSavedCatalog] = useState<DungeonCatalog | null>(null);
    const [interiorBase, setInteriorBase] = useState<InteriorCatalog | null>(null);
    const [seeds, setSeeds] = useState<InteriorSeedSpaces>({});
    const [newInteriorOpen, setNewInteriorOpen] = useState(false);
    const [newInteriorKind, setNewInteriorKind] = useState<InteriorSpaceKind>("dungeon");
    const [newInteriorName, setNewInteriorName] = useState("New Interior");
    const [bossAppearanceCatalog, setBossAppearanceCatalog] = useState<BossAppearanceCatalog | null>(null);
    const [selectedDungeonId, setSelectedDungeonId] = useState("");
    const [selectedRoomId, setSelectedRoomId] = useState("");
    const [selection, setSelection] = useState<EditorSelection>(null);
    const [layerId, setLayerId] = useState<LayerId>("actors");
    const [mode, setMode] = useState<"author" | "walk" | "floorwalk">("author");
    const [playKind, setPlayKind] = useState<"full" | "room">("full");
    const [editorView, setEditorView] = useState<"room" | "topology" | "decoration">("room");
    const authorViewZoomRef = useRef(1);
    const [authorViewZoom, setAuthorViewZoom] = useState(1);
    const [authorViewPan, setAuthorViewPan] = useState<IndoorPoint>({ x: 0, y: 0 });
    authorViewZoomRef.current = authorViewZoom;
    const [canvasFocused, setCanvasFocused] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [showRetired, setShowRetired] = useState(false);
    const [authoringLevel, setAuthoringLevel] = useState<AuthoringLevel>(initialView.authoringLevel === "advanced" ? "advanced" : "simple");
    const [simpleStep, setSimpleStep] = useState<SimpleStep>(["art", "mobs", "chest", "finish", "test"].includes(String(initialView.simpleStep ?? "")) ? initialView.simpleStep as SimpleStep : "art");
    const [authorDebug, setAuthorDebug] = useState({ anchors: true, colliders: false, zones: false, portals: true, route: false, floors: true, walls: true, clickAreas: true });
    const [selectedVertex, setSelectedVertex] = useState<number | null>(null);
    const [panTool, setPanTool] = useState(false);
    const [spaceHeld, setSpaceHeld] = useState(false);
    const [wallKind, setWallKind] = useState<"back_wall" | "left_wall" | "right_wall">("back_wall");
    const [shortcutsOpen, setShortcutsOpen] = useState(false);
    const lastPickRef = useRef<{ prefabId: string | null; mob: (typeof MOB_ARCHETYPE_KEYS)[number] | null }>({ prefabId: null, mob: null });
    const [selectedPrefabId, setSelectedPrefabId] = useState<string | null>(null);
    const [selectedMobArchetype, setSelectedMobArchetype] = useState<(typeof MOB_ARCHETYPE_KEYS)[number] | null>(null);
    const [placementEncounterId, setPlacementEncounterId] = useState<string | null>(null);
    const [placementWaveIndex, setPlacementWaveIndex] = useState(1);
    // Snap is off by default (dragging follows the cursor); the choice is remembered per browser.
    const [snapToGrid, setSnapToGridState] = useState(() => { try { return localStorage.getItem(SNAP_STORAGE_KEY) === "on"; } catch { return false; } });
    const setSnapToGrid = (value: boolean): void => { setSnapToGridState(value); try { localStorage.setItem(SNAP_STORAGE_KEY, value ? "on" : "off"); } catch { /* storage unavailable */ } };
    const [polygonDraft, setPolygonDraft] = useState<PolygonDraft>(null);
    const [placementTool, setPlacementTool] = useState<PlacementTool>(null);
    const [resourceType, setResourceType] = useState<DungeonResourceType>(DUNGEON_RESOURCE_TYPES[0]);
    const [portalDestinationRoomId, setPortalDestinationRoomId] = useState("");
    const [wizardOpen, setWizardOpen] = useState(false);
    const [draftDungeonDeleteId, setDraftDungeonDeleteId] = useState<string | null>(null);
    const [addAreaOpen, setAddAreaOpen] = useState(false);
    const [inspectorTab, setInspectorTab] = useState<InspectorTab>(["interior", "room", "selected", "shapes", "portals", "planters", "encounters", "resources", "rewards", "logic", "advanced"].includes(String(initialView.inspectorTab ?? "")) ? initialView.inspectorTab as InspectorTab : "room");
    const [roomFormOpen, setRoomFormOpen] = useState(false);
    const [railCollapsed, setRailCollapsed] = useState(() => typeof window !== "undefined" && window.innerWidth >= 1024 && window.innerWidth < 1280);
    const [inspectorCollapsed, setInspectorCollapsed] = useState(false);
    const [validationOpen, setValidationOpen] = useState(false);
    const [roomDraft, setRoomDraft] = useState({ name: "New Room", preset: "medium", width: 1000, height: 1000 });
    const [librarySearch, setLibrarySearch] = useState("");
    const [showAllArt, setShowAllArt] = useState(false);
    const [checklistHidden, setChecklistHidden] = useState<readonly string[]>([]);
    const [libraryCategory, setLibraryCategory] = useState<LibraryCategory>("art");
    const [wizard, setWizard] = useState<DungeonWizardInput>(DEFAULT_WIZARD);
    const [historyVersion, setHistoryVersion] = useState(0);
    const [pendingDungeonAssets, setPendingDungeonAssets] = useState<PendingDungeonAsset[]>([]);
    const [runtimeAssets, setRuntimeAssets] = useState<RuntimeAsset[]>([]);
    /** Blob previews of the decoration PNGs staged this session, by the asset key they publish under. */
    const [decorationPreviews, setDecorationPreviews] = useState<Record<string, string>>({});
    const [selectedDecorationId, setSelectedDecorationId] = useState<string | null>(null);
    const pastRef = useRef<DungeonCatalog[]>([]);
    const futureRef = useRef<DungeonCatalog[]>([]);
    const canvasDragHistoryRef = useRef<{ snapshot: DungeonCatalog; recorded: boolean; cancelled?: boolean } | null>(null);
    // The open undo group (one pointer gesture, nudge run or field session); see historyCore.ts.
    const groupRef = useRef<ActiveGroup | null>(null);
    const grouping = useEditGrouping({
      onEnd: () => { groupRef.current = null; },
      onCancel: (key) => {
        // Pointercancel / Escape mid-drag restores the pre-gesture catalog and leaves no undo step.
        const drag = canvasDragHistoryRef.current;
        if (drag && !drag.cancelled) {
          drag.cancelled = true;
          if (drag.recorded) { pastRef.current.pop(); drag.recorded = false; }
          setCatalog(structuredClone(drag.snapshot));
          setHistoryVersion((value) => value + 1);
          return;
        }
        if (groupRef.current?.key !== key) return;
        groupRef.current = null;
        const previous = pastRef.current.pop();
        if (previous) { setCatalog(previous); setHistoryVersion((value) => value + 1); }
      }
    });
    const addAreaRef = useRef<HTMLElement>(null);
    const quickSetupRef = useRef<HTMLElement>(null);
    const validationRef = useRef<HTMLElement>(null);
    const previousRoomIdentityRef = useRef<string | null>(null);
    const draftRecoveryKey = recoveryKey(props.session.workspace.worktreePath, props.session.workspace.branch);
    /** An unsaved draft made on other data than what is on disk now: offered, never applied silently. */
    const [staleDraft, setStaleDraft] = useState<RecoveryDraft | null>(null);
    /** The editing view of what is on disk: every interior space as a dungeon-shaped definition. */
    const loadSource = async (): Promise<{ view: DungeonCatalog; base: InteriorCatalog }> => {
      const base = interiorCatalogOf(await props.api.loadInteriorCatalog());
      return { view: interiorEditingView(base), base };
    };

    useEffect(() => {
      let active = true;
      void loadSource().then(({ view: loaded, base }) => {
        if (!active) return;
        const recovery = readRecoveryDraft(draftRecoveryKey);
        // A draft is restored silently only onto the exact catalog it was made on.
        // (Drafts written before fingerprints existed are trusted on their revision alone.)
        const recoveryMatches = recovery?.baseCatalogRevision === loaded.catalogRevision &&
          (recovery.baseFingerprint === undefined || recovery.baseFingerprint === catalogFingerprint(normalizeDungeonCatalog(loaded)));
        const restored = normalizeDungeonCatalog(recoveryMatches
          ? recovery.catalog
          : loaded);
        setCatalog(structuredClone(restored));
        setSavedCatalog(structuredClone(normalizeDungeonCatalog(loaded)));
        setInteriorBase(base);
        setSeeds(recoveryMatches ? recovery.seeds ?? {} : {});
        pastRef.current = [];
        futureRef.current = [];
        setHistoryVersion((value) => value + 1);
        const restoredSeeds = recoveryMatches ? recovery.seeds ?? {} : {};
        // Interiors open on the first space in picker order (dungeons first) unless the last session's space is still there.
        const pickerOrder = INTERIOR_KINDS.flatMap((kind) => restored.dungeons.filter((value) => interiorSpaceKind(base, restoredSeeds, value.id) === kind));
        const selected = restored.dungeons.find((value) => value.id === initialView.dungeonId && !value.retired) ?? pickerOrder.find((value) => !value.retired);
        setSelectedDungeonId(selected?.id ?? "");
        setSelectedRoomId(selected?.rooms.find((value) => value.id === initialView.roomId && !value.retired)?.id ?? selected?.rooms[0]?.id ?? "");
        if (props.visible && !recoveryMatches && initialView.savedRevision === loaded.catalogRevision) props.onMessage(`Saved ${studioName} revision ${loaded.catalogRevision}.`);
        setPendingDungeonAssets(recoveryMatches ? recovery.pendingDungeonAssets ?? [] : []);
        if (recoveryMatches) {
          props.onMessage(`Recovered unsaved ${studioName} edits from ${formatTime(recovery.savedAt)}.`);
        } else if (recovery) {
          // Made on older data (or before fingerprints): ask instead of applying it.
          setStaleDraft(recovery);
        }
      }).catch((caught) => setError(errorMessage(caught)));
      return () => { active = false; };
    }, [draftRecoveryKey, props.api]);
    useEffect(() => {
      // Older embedded StudioApi test doubles and hosts may not expose the optional
      // boss catalog endpoint. Dungeon authoring remains usable without the library
      // preview; runtime still validates shared boss package references.
      if (typeof props.api.loadBossCatalog !== "function") return;
      let active = true;
      void props.api.loadBossCatalog().then((loaded) => { if (active) setBossAppearanceCatalog(loaded); }).catch(() => { if (active) setBossAppearanceCatalog(null); });
      return () => { active = false; };
    }, [props.api]);

    useEffect(() => {
      if (!catalog || !selectedDungeonId) return;
      try { sessionStorage.setItem(viewKey, JSON.stringify({ dungeonId: selectedDungeonId, roomId: selectedRoomId, mode, authoringLevel, simpleStep, inspectorTab, savedRevision: savedCatalog?.catalogRevision })); } catch { /* Optional navigation persistence. */ }
    }, [viewKey, catalog, savedCatalog, selectedDungeonId, selectedRoomId, mode, authoringLevel, simpleStep, inspectorTab]);

    const dirty = Boolean(catalog && savedCatalog && (stable(catalog) !== stable(savedCatalog) || pendingDungeonAssets.length > 0));
    const savedFingerprint = useMemo(() => savedCatalog ? catalogFingerprint(savedCatalog) : "", [savedCatalog]);
    const discardStaleDraft = (): void => {
      const stale = staleDraft;
      setStaleDraft(null);
      removeRecoveryDraft(draftRecoveryKey);
      if (stale?.pendingDungeonAssets?.length) {
        void props.api.discardDungeonAssets(stale.pendingDungeonAssets.map((pending) => pending.stagingToken))
          .catch((caught) => setError(errorMessage(caught)));
      }
      props.onMessage("Discarded the old unsaved draft.");
    };
    const restoreStaleDraft = (): void => {
      const stale = staleDraft;
      if (!stale) return;
      setStaleDraft(null);
      setCatalog(structuredClone(normalizeDungeonCatalog(stale.catalog)));
      setSeeds(stale.seeds ?? {});
      setPendingDungeonAssets(stale.pendingDungeonAssets ?? []);
      pastRef.current = [];
      futureRef.current = [];
      setHistoryVersion((value) => value + 1);
      props.onMessage(`Restored the old draft from ${formatTime(stale.savedAt)}. Check it before saving: it was made on older data.`);
    };
    const reloadFromDisk = async (): Promise<void> => {
      if (busy) return;
      if (dirty && !window.confirm(`Discard your unsaved ${studioName} edits and reload the catalog from disk?`)) return;
      try {
        const source = await loadSource();
        const loaded = normalizeDungeonCatalog(source.view);
        setInteriorBase(source.base);
        setSeeds({});
        const staged = pendingDungeonAssets.map((pending) => pending.stagingToken);
        if (staged.length > 0) await props.api.discardDungeonAssets(staged).catch(() => undefined);
        removeRecoveryDraft(draftRecoveryKey);
        setCatalog(structuredClone(loaded));
        setSavedCatalog(structuredClone(loaded));
        setPendingDungeonAssets([]);
        pastRef.current = [];
        futureRef.current = [];
        setHistoryVersion((value) => value + 1);
        const kept = loaded.dungeons.find((value) => value.id === selectedDungeonId && !value.retired) ?? loaded.dungeons.find((value) => !value.retired);
        setSelectedDungeonId(kept?.id ?? "");
        setSelectedRoomId(kept?.rooms.find((value) => value.id === selectedRoomId && !value.retired)?.id ?? kept?.rooms[0]?.id ?? "");
        setError(null);
        props.onMessage(`Reloaded ${studioName} catalog revision ${loaded.catalogRevision} from disk.`);
      } catch (caught) { setError(errorMessage(caught)); }
    };
    useEffect(() => props.onDirtyChange(dirty), [dirty, props.onDirtyChange]);
    useEffect(() => props.onBusyChange(busy), [busy, props.onBusyChange]);
    useEffect(() => {
      if (!catalog || !savedCatalog) return;
      if (!dirty) {
        removeRecoveryDraft(draftRecoveryKey);
        return;
      }
      if (staleDraft) return;
      writeRecoveryDraft(draftRecoveryKey, {
        baseCatalogRevision: savedCatalog.catalogRevision,
        baseFingerprint: savedFingerprint,
        catalog,
        seeds,
        pendingDungeonAssets,
        savedAt: new Date().toISOString()
      });
    }, [catalog, dirty, draftRecoveryKey, pendingDungeonAssets, savedCatalog, savedFingerprint, seeds, staleDraft]);

    const dungeon = catalog?.dungeons.find((value) => value.id === selectedDungeonId) ??
      catalog?.dungeons[0] ?? null;
    const room = dungeon?.rooms.find((value) => value.id === selectedRoomId) ??
      dungeon?.rooms[0] ?? null;
    const spaceKind: InteriorSpaceKind = interiorBase && dungeon ? interiorSpaceKind(interiorBase, seeds, dungeon.id) : "dungeon";
    const isDungeonKind = spaceKind === "dungeon";
    const simpleMode = authoringLevel !== "advanced" && isDungeonKind;
    const shapesAvailable = Boolean(interiorBase);
    const inspectorTabs = inspectorTabsFor(spaceKind, simpleMode, shapesAvailable);
    const authoringSources = useMemo<AuthoringSources>(() => ({ base: interiorBase, seeds }), [interiorBase, seeds]);
    const authoringFor = (dungeonId: string, target: DungeonRoomDefinition): RoomAuthoring | null => catalog && interiorBase ? effectiveRoomAuthoring(catalog, authoringSources, dungeonId, target) : null;
    /** The room's floors, walls, click areas and anchor roles; null where shape authoring is not offered (Simple dungeon mode). */
    const authoring = shapesAvailable && !simpleMode && catalog && dungeon && room ? effectiveRoomAuthoring(catalog, authoringSources, dungeon.id, room) : null;
    /** The Decoration Test is offered for spaces that carry the Manor decoration module. */
    const hasDecoration = dungeon ? hasDecorationModule(authoringSources, dungeon.id) : false;
    useEffect(() => {
      if (!inspectorTabs.includes(inspectorTab)) setInspectorTab("room");
      if (!isDungeonKind && editorView === "topology") setEditorView("room");
      if (!hasDecoration && editorView === "decoration") setEditorView("room");
      if (!isDungeonKind && libraryCategory === "mobs") setLibraryCategory("art");
    }, [inspectorTab, spaceKind, editorView, libraryCategory, hasDecoration]);
    const isGreenhouse = spaceKind === "greenhouse";
    const refreshRuntimeAssets = async (): Promise<void> => {
      // Older embedded StudioApi doubles and hosts may not expose the runtime inventory; the editors then show fallbacks.
      if (typeof props.api.loadRuntimeAssets !== "function") return;
      try { setRuntimeAssets((await props.api.loadRuntimeAssets()).assets); } catch { /* Previews are optional. */ }
    };
    useEffect(() => {
      if (isGreenhouse) void refreshRuntimeAssets();
    }, [isGreenhouse, props.api]);
    const topology = useMemo(() => dungeon ? buildDungeonTopology(dungeon) : null, [dungeon]);
    const issues = useMemo(() => !catalog || !interiorBase ? [] : interiorViewIssues(interiorBase, seeds, catalog), [catalog, interiorBase, seeds]);
    const saveBlockedRef = useRef(false);
    useEffect(() => {
      if (saveBlockedRef.current && issues.length === 0) {
        saveBlockedRef.current = false; setError(null);
        props.onMessage("Validation recovered. Ready to save.");
      }
    }, [issues.length]);
    const oneRoomReadiness = useMemo(() => room && dungeon && isDungeonKind
      ? oneRoomCombatReadiness(dungeon, room, catalog ?? undefined)
      : null, [dungeon, room, isDungeonKind]);

    useEffect(() => {
      if (room) {
        const roomIdentity = `${dungeon?.id ?? ""}:${room.id}`;
        if (previousRoomIdentityRef.current !== null && previousRoomIdentityRef.current !== roomIdentity) {
          setSelectedPrefabId(null); setSelectedMobArchetype(null); setPolygonDraft(null); setPlacementTool(null);
        }
        previousRoomIdentityRef.current = roomIdentity;
        setAuthorViewZoom(1); setAuthorViewPan({ x: 0, y: 0 }); setCanvasFocused(false);
        const encounter = dungeon?.encounters.find((value) => !value.retired && value.roomId === room.id);
        setPlacementEncounterId(encounter?.id ?? null); setPlacementWaveIndex(1);
      }
    }, [dungeon?.id, room?.id]);
    useEffect(() => {
      if (selection) setInspectorTab((current) => selection.kind === "resourceZone" ? "resources" : current === "shapes" && ["anchor", "collider", "zone", "floor", "wall", "clickArea"].includes(selection.kind) ? current : "selected");
    }, [selection]);
    useEffect(() => {
      if (simpleMode && (inspectorTab === "logic" || inspectorTab === "advanced")) {
        setInspectorTab("room");
      }
    }, [authoringLevel, inspectorTab]);

    useEffect(() => {
      if (!dungeon) return;
      if (!dungeon.rooms.some((value) => value.id === selectedRoomId)) {
        setSelectedRoomId(dungeon.rooms[0]?.id ?? "");
      }
    }, [dungeon, selectedRoomId]);
    const updateCatalog = (edit: (draft: DungeonCatalog) => void, explicitGroup?: EditGroup): void => {
      if (!props.writesAllowed || busy || grouping.isCancelled()) return;
      const spec = grouping.groupForEdit(explicitGroup);
      setError(null);
      setCatalog(runOnce((current: DungeonCatalog | null) => {
        if (!current) return current;
        const draft = structuredClone(current);
        edit(draft);
        // A no-op edit is not an undo step and leaves an open group alone.
        if (stable(draft) === stable(current)) return current;
        const { coalesce, active } = resolveGroup(groupRef.current, spec, Date.now());
        groupRef.current = active;
        if (!coalesce) {
          pastRef.current = [...pastRef.current.slice(-(HISTORY_LIMIT - 1)), structuredClone(current)];
          futureRef.current = [];
          setHistoryVersion((value) => value + 1);
        }
        return draft;
      }));
    };
    const openValidationContext = (context: ReturnType<typeof validationIssueContext>): void => {
      setEditorView("room"); setMode("author"); setValidationOpen(true);
      if (context.dungeonId) setSelectedDungeonId(context.dungeonId);
      if (context.roomId) setSelectedRoomId(context.roomId);
      setSelection(context.selection ?? null);
      const targetTab = simpleMode && (context.inspectorTab === "logic" || context.inspectorTab === "advanced") ? "room" : context.inspectorTab;
      setInspectorTab(targetTab);
      if (simpleMode) setSimpleStep(targetTab === "encounters" ? "mobs" : "finish");
      requestAnimationFrame(() => {
        const card = context.resourceId ? document.querySelector<HTMLElement>(`[data-resource-id="${context.resourceId}"]`) : context.inspectorTab === "rewards" ? document.querySelector<HTMLElement>("[aria-label='Chest setup']") : null;
        const focus = (context.fieldLabel ? Array.from(card?.querySelectorAll<HTMLLabelElement>("label") ?? []).find((label) => label.querySelector("span")?.textContent === context.fieldLabel)?.querySelector<HTMLElement>("input, select") : null) ?? card?.querySelector<HTMLElement>("input, select");
        (card ?? validationRef.current)?.scrollIntoView?.({ behavior: "smooth", block: "center" }); focus?.focus();
      });
    };
    // Selecting something else never makes an undo step, but it ends any open group.
    useEffect(() => { groupRef.current = null; }, [selection, selectedRoomId, selectedDungeonId]);
    const undo = (): void => setCatalog(runOnce((current: DungeonCatalog | null) => {
      groupRef.current = null;
      const previous = pastRef.current.pop();
      if (!current || !previous) return current;
      futureRef.current = [structuredClone(current), ...futureRef.current].slice(0, HISTORY_LIMIT);
      setHistoryVersion((value) => value + 1);
      return previous;
    }));
    const redo = (): void => setCatalog(runOnce((current: DungeonCatalog | null) => {
      groupRef.current = null;
      const next = futureRef.current.shift();
      if (!current || !next) return current;
      pastRef.current = [...pastRef.current.slice(-(HISTORY_LIMIT - 1)), structuredClone(current)];
      setHistoryVersion((value) => value + 1);
      return next;
    }));
    useEffect(() => {
      props.onValidationErrorsChange?.(issues.length);
    }, [issues.length, props.onValidationErrorsChange]);
    useEffect(() => {
      props.onHistoryChange?.({ undo: pastRef.current.length, redo: futureRef.current.length });
    }, [historyVersion, props.onHistoryChange]);
    const updateDungeon = (edit: (draft: DungeonDefinition) => void): void => {
      updateCatalog((draft) => {
        const value = draft.dungeons.find((candidate) => candidate.id === selectedDungeonId);
        if (value) edit(value);
      });
    };
    const updateRoom = (edit: (draft: DungeonRoomDefinition) => void): void => {
      updateDungeon((draft) => {
        const value = draft.rooms.find((candidate) => candidate.id === selectedRoomId);
        if (value) edit(value);
      });
    };
    const wireOneRoomFlow = (): void => {
      updateCatalog((draft) => {
        const dungeon = draft.dungeons.find((candidate) => candidate.id === selectedDungeonId);
        const draftRoom = dungeon?.rooms.find((candidate) => candidate.id === room?.id);
        if (!dungeon || !draftRoom || !wireOneRoomCombatFlow(dungeon, draftRoom)) return;
        if (!draft.rewardTableIds.includes(ONE_ROOM_CHEST_REWARD_TABLE_ID)) {
          draft.rewardTableIds.push(ONE_ROOM_CHEST_REWARD_TABLE_ID);
        }
      });
    };
    const clearPlacementTools = (): void => {
      setSelectedPrefabId(null); setSelectedMobArchetype(null); setPolygonDraft(null); setPlacementTool(null);
    };
    const openSimpleStep = (step: SimpleStep): void => {
      clearPlacementTools();
      setSimpleStep(step);
      if (step === "test") { setPlayKind("full"); setMode("walk"); return; }
      setMode("author");
      if (step === "art" || step === "mobs") { setLibraryCategory(step); setLibrarySearch(""); setAddAreaOpen(true); }
      if (step === "chest") { setLibraryCategory("objects"); setLibrarySearch("chest"); setAddAreaOpen(true); setInspectorTab("rewards"); }
      if (step === "art") setInspectorTab("room");
      if (step === "mobs") setInspectorTab("encounters");
      if (step === "finish") {
        setInspectorTab("room");
        requestAnimationFrame(() => { quickSetupRef.current?.focus(); quickSetupRef.current?.scrollIntoView?.({ behavior: "smooth", block: "center" }); });
      }
    };
    const recordDragStep = (): void => {
      const dragHistory = canvasDragHistoryRef.current;
      if (dragHistory && !dragHistory.recorded) {
        pastRef.current = [...pastRef.current.slice(-(HISTORY_LIMIT - 1)), dragHistory.snapshot];
        futureRef.current = [];
        dragHistory.recorded = true;
        setHistoryVersion((value) => value + 1);
      }
    };
    const moveVertexOnCanvas = (index: number, point: IndoorPoint): void => {
      if (!props.writesAllowed || busy || !selection || !room || canvasDragHistoryRef.current?.cancelled) return;
      const ref = selection as ShapeRef;
      const current = shapeVertices(room, authoring ?? EMPTY_AUTHORING, ref)?.[index];
      if (!current || (current.x === point.x && current.y === point.y)) return;
      recordDragStep();
      setCatalog((value) => {
        if (!value) return value;
        const draft = structuredClone(value);
        moveShapeVertex(draft, authoringSources, selectedDungeonId, selectedRoomId, ref, index, point);
        return draft;
      });
    };
    const moveCanvasEntity = (entity: CanvasEntitySelection, point: IndoorPoint): void => {
      if (!props.writesAllowed || busy || canvasDragHistoryRef.current?.cancelled) return;
      if (room && (entity.kind === "floor" || entity.kind === "wall" || entity.kind === "clickArea" || entity.kind === "collider" || entity.kind === "zone")) {
        const origin = shapeVertices(room, authoring ?? EMPTY_AUTHORING, entity as ShapeRef)?.[0];
        if (origin) {
          if (origin.x === point.x && origin.y === point.y) return;
          recordDragStep();
          const delta = { x: point.x - origin.x, y: point.y - origin.y };
          setCatalog((value) => {
            if (!value) return value;
            const draft = structuredClone(value);
            translateShape(draft, authoringSources, selectedDungeonId, selectedRoomId, entity as ShapeRef, delta);
            return draft;
          });
          return;
        }
      }
      const currentTarget = entity.kind === "anchor" ? room?.anchors.find((value) => value.id === entity.id)
        : entity.kind === "object" ? room?.anchors.find((value) => value.id === room.objects.find((object) => object.id === entity.id)?.anchorId)
        : entity.kind === "mob" ? room?.anchors.find((value) => value.id === room.mobs.find((mob) => mob.id === entity.id)?.anchorId)
        : entity.kind === "placement" ? Object.values(room?.layers ?? {}).flat().find((value) => value.id === entity.id)
        : entity.kind === "collider" ? room?.colliders.find((value) => value.id === entity.id)
        : entity.kind === "zone" ? room?.zones.find((value) => value.id === entity.id)
        : entity.kind === "resourceZone" ? room?.resourceSpawnZones?.find((value) => value.id === entity.id)?.shape
        : undefined;
      const currentOrigin = currentTarget && "x" in currentTarget
        ? currentTarget
        : currentTarget && "points" in currentTarget ? currentTarget.points[0] : undefined;
      if (!currentOrigin || (currentOrigin.x === point.x && currentOrigin.y === point.y)) return;
      const dragHistory = canvasDragHistoryRef.current;
      if (dragHistory && !dragHistory.recorded) {
        pastRef.current = [...pastRef.current.slice(-(HISTORY_LIMIT - 1)), dragHistory.snapshot];
        futureRef.current = [];
        dragHistory.recorded = true;
        setHistoryVersion((value) => value + 1);
      }
      setCatalog((current) => {
        if (!current) return current;
        const draft = structuredClone(current);
        const draftRoom = draft.dungeons.find((candidate) => candidate.id === selectedDungeonId)
          ?.rooms.find((candidate) => candidate.id === selectedRoomId);
        if (!draftRoom) return current;
        const target = entity.kind === "anchor" ? draftRoom.anchors.find((value) => value.id === entity.id)
          : entity.kind === "object" ? draftRoom.anchors.find((value) => value.id === draftRoom.objects.find((object) => object.id === entity.id)?.anchorId)
          : entity.kind === "mob" ? draftRoom.anchors.find((value) => value.id === draftRoom.mobs.find((mob) => mob.id === entity.id)?.anchorId)
          : entity.kind === "placement" ? Object.values(draftRoom.layers).flat().find((value) => value.id === entity.id)
          : entity.kind === "collider" ? draftRoom.colliders.find((value) => value.id === entity.id)
          : entity.kind === "zone" ? draftRoom.zones.find((value) => value.id === entity.id)
          : entity.kind === "resourceZone" ? draftRoom.resourceSpawnZones?.find((value) => value.id === entity.id)?.shape
          : undefined;
        const targetOrigin = target && "x" in target
          ? target
          : target && "points" in target ? target.points[0] : undefined;
        if (!target || !targetOrigin || (targetOrigin.x === point.x && targetOrigin.y === point.y)) return current;
        if (entity.kind === "mob") {
          const mob = draftRoom.mobs.find((value) => value.id === entity.id);
          const draftDungeon = draft.dungeons.find((value) => value.id === selectedDungeonId);
          if (mob && draftDungeon) {
            moveDungeonMobGroup(draftDungeon, draftRoom.id, mob.spawnGroupId, {
              x: point.x - targetOrigin.x,
              y: point.y - targetOrigin.y
            });
            return draft;
          }
        }
        if (entity.kind === "resourceZone" && "points" in target) {
          const delta = { x: point.x - targetOrigin.x, y: point.y - targetOrigin.y };
          target.points = target.points.map((value) => ({ x: value.x + delta.x, y: value.y + delta.y }));
          return draft;
        }
        if ("x" in target) {
          target.x = point.x;
          target.y = point.y;
        }
        return draft;
      });
    };

    const save = async (): Promise<void> => {
      groupRef.current = null;
      if (!catalog || busy || !dirty) return;
      if (issues.length > 0) {
        const firstIssue = issues[0]!;
        const context = validationIssueContext(catalog, firstIssue.path, authoringFor);
        saveBlockedRef.current = true;
        const message = `Save blocked: fix ${issues.length} map ${issues.length === 1 ? "issue" : "issues"}. ${context.label} — ${friendlyValidationMessage(firstIssue.path, firstIssue.message)}`;
        setError(message);
        props.onMessage(message);
        openValidationContext(context);
        return;
      }
      setBusy(true);
      setError(null);
      props.onMessage(`Saving ${studioName} catalog to the worktree…`);
      try {
        const assembledForSave = interiorBase ? interiorFromEditingView(interiorBase, seeds, catalog) : null;
        const referencedModuleKeys = new Set(assembledForSave?.spaces.flatMap(moduleAssetKeys) ?? []);
        const activePending = pendingDungeonAssets.filter((pending) => pending.assetKey
          ? referencedModuleKeys.has(pending.assetKey) || catalog.prefabs.some((prefab) => prefab.assetKey === pending.assetKey)
          : catalog.prefabs.some((prefab) => prefab.id === pending.prefabId));
        const abandonedTokens = pendingDungeonAssets.filter((pending) => !activePending.includes(pending)).map((pending) => pending.stagingToken);
        await props.api.discardDungeonAssets(abandonedTokens);
        if (stable(catalog) === stable(savedCatalog) && activePending.length === 0) { setPendingDungeonAssets([]); return; }
        const pendingTokens = activePending.map((pending) => pending.stagingToken);
        let saved: { catalog: DungeonCatalog; modifiedFiles: string[] };
        if (interiorBase && assembledForSave) {
          // Single-space publish: the selected changed space is the primary, other changed spaces ride along atomically.
          const assembled = assembledForSave;
          const proposed = bumpInteriorRevisions(interiorBase, assembled);
          const changedIds = changedInteriorSpaceIds(interiorBase, assembled);
          const primaryId = changedIds.includes(selectedDungeonId) ? selectedDungeonId : changedIds[0] ?? selectedDungeonId;
          const spaceIds = [primaryId, ...changedIds.filter((id) => id !== primaryId)];
          const response = await props.api.publishInteriorSpace({
            space: proposed.spaces.find((space) => space.id === primaryId)!,
            alsoSpaces: spaceIds.slice(1).map((id) => proposed.spaces.find((space) => space.id === id)!),
            ...(interiorLibraryChanged(interiorBase.library, proposed.library) ? { library: proposed.library } : {}),
            expectedCatalogRevision: interiorBase.library.catalogRevision,
            expectedSpaceRevisions: Object.fromEntries(spaceIds.map((id) => [id, interiorBase.spaces.find((space) => space.id === id)?.revision ?? null])),
            pendingAssetTokens: pendingTokens
          });
          const nextBase = interiorCatalogOf(response);
          setInteriorBase(nextBase);
          setSeeds({});
          saved = { catalog: interiorEditingView(nextBase), modifiedFiles: response.modifiedFiles };
        } else {
          throw new Error("The interior catalog has not loaded yet.");
        }
        const result = saved;
        setCatalog(structuredClone(result.catalog));
        setSavedCatalog(structuredClone(result.catalog));
        pastRef.current = [];
        futureRef.current = [];
        setPendingDungeonAssets([]); if (activePending.some((pending) => pending.assetKey)) void refreshRuntimeAssets();
        setHistoryVersion((value) => value + 1);
        removeRecoveryDraft(draftRecoveryKey);
        props.onMessage(result.modifiedFiles.length > 0
          ? `Saved ${studioName} revision ${result.catalog.catalogRevision}.`
          : `${studioName} had no content changes to write.`);
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
      groupRef.current = null;
      await props.api.discardDungeonAssets(pendingDungeonAssets.map((pending) => pending.stagingToken));
      setPendingDungeonAssets([]); if (pendingDungeonAssets.some((pending) => pending.assetKey)) void refreshRuntimeAssets();
      setCatalog(structuredClone(savedCatalog));
      setSeeds({});
      setSelection(null);
      pastRef.current = [];
      futureRef.current = [];
      setHistoryVersion((value) => value + 1);
      removeRecoveryDraft(draftRecoveryKey);
      setStaleDraft(null);
      props.onMessage(`Reverted unsaved ${studioName} changes.`);
    };
    useImperativeHandle(ref, () => ({ save, revert, undo, redo }), [authoringLevel, busy, catalog, dirty, draftRecoveryKey, interiorBase, issues, savedCatalog, seeds, selectedDungeonId]);
    useEffect(() => {
      const onKeyDown = (event: KeyboardEvent): void => {
        if (!props.visible || mode === "walk" || mode === "floorwalk") return;
        if (event.key === "Escape") { setCanvasFocused(false); setSelectedPrefabId(null); setSelectedMobArchetype(null); setPolygonDraft(null); setPlacementTool(null); setPanTool(false); setShortcutsOpen(false); return; }
        const target = event.target as HTMLElement | null;
        const typing = Boolean(target && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)));
        if (!typing && !event.ctrlKey && !event.metaKey && shapesAvailable) {
          if (event.key === "Enter" && polygonDraft && polygonDraft.points.length >= 3) { event.preventDefault(); finishPolygon(); return; }
          if (event.key === "Delete" && selection && !polygonDraft) { event.preventDefault(); retireSelection(); return; }
        }
        if (!typing && !event.ctrlKey && !event.metaKey && !event.altKey && editorView === "room" && catalog) {
          if (event.key === "?") { event.preventDefault(); setShortcutsOpen((value) => !value); return; }
          const tool = toolForKey(event.key);
          if (tool && toolAvailable(tool)) { event.preventDefault(); selectTool(tool); return; }
        }
        if (!event.ctrlKey && !event.metaKey) return;
        // When hosted, the Studio header owns Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z and Ctrl+Y for every workspace.
        if (!props.hosted && event.key.toLowerCase() === "z") { event.preventDefault(); if (event.shiftKey) redo(); else undo(); }
        if (!props.hosted && event.key.toLowerCase() === "y") { event.preventDefault(); redo(); }
        if (event.key.toLowerCase() === "s") { event.preventDefault(); void save(); }
      };
      window.addEventListener("keydown", onKeyDown);
      return () => window.removeEventListener("keydown", onKeyDown);
    }, [props.visible, save]);
    useEffect(() => {
      const busyTarget = (event: KeyboardEvent): boolean => { const target = event.target as HTMLElement | null; return Boolean(target && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT", "BUTTON"].includes(target.tagName))); };
      const down = (event: KeyboardEvent): void => { if (event.key !== " " || event.repeat || !props.visible || busyTarget(event)) return; event.preventDefault(); setSpaceHeld(true); };
      const up = (event: KeyboardEvent): void => { if (event.key === " ") setSpaceHeld(false); };
      const release = (): void => setSpaceHeld(false);
      window.addEventListener("keydown", down); window.addEventListener("keyup", up); window.addEventListener("blur", release);
      return () => { window.removeEventListener("keydown", down); window.removeEventListener("keyup", up); window.removeEventListener("blur", release); };
    }, [props.visible]);
    useEffect(() => {
      if (selectedPrefabId) lastPickRef.current = { prefabId: selectedPrefabId, mob: null };
      else if (selectedMobArchetype) lastPickRef.current = { prefabId: null, mob: selectedMobArchetype };
    }, [selectedPrefabId, selectedMobArchetype]);
    /** Whether a canvas tool can be armed right now (shape tools are hidden in Simple dungeon mode). */
    const toolAvailable = (tool: CanvasTool): boolean => {
      if (tool === "select" || tool === "pan") return true;
      if (tool === "place") return props.writesAllowed && Boolean(selectedPrefabId || selectedMobArchetype || lastPickRef.current.prefabId || lastPickRef.current.mob);
      return props.writesAllowed && authoring !== null && !busy;
    };

    if (!props.visible) return null;
    if (!catalog || !dungeon || !room || !topology) {
      return <section className="panel dungeon-loading" role="status">Loading interior catalog…</section>;
    }

    const savedRoom = savedCatalog?.dungeons.find((value) => value.id === dungeon.id)
      ?.rooms.find((value) => value.id === room.id);
    const savedDungeon = savedCatalog?.dungeons.find((value) => value.id === dungeon.id);
    const selectedPrefab = selectedPrefabId ? catalog.prefabs.find((value) => value.id === selectedPrefabId && !value.retired) : undefined;
    const activePortalDestinations = dungeon.rooms.filter((value) => !value.retired && value.active && value.id !== room.id);
    const configuredWorldExit = dungeon.portals.find((portal) => portal.id === dungeon.escape.portalId && !portal.retired && portal.enabled
      && portal.source.kind === "room" && portal.source.roomId === room.id && portal.destination.kind === "world");
    const portalPlacementAvailable = activePortalDestinations.length > 0 || Boolean(configuredWorldExit);
    const effectivePortalDestinationRoomId = activePortalDestinations.some((value) => value.id === portalDestinationRoomId)
      ? portalDestinationRoomId
      : activePortalDestinations[0]?.id ?? "";
    const addRoom = (): void => {
      const created = createDungeonRoom(dungeon, { id: nextId(safeDungeonId(roomDraft.name) || "draft_room", dungeon.rooms.map((value) => value.id)), name: roomDraft.name, width: roomDraft.width, height: roomDraft.height });
      updateDungeon((draft) => draft.rooms.push(created));
      setSelectedRoomId(created.id);
      setRoomFormOpen(false);
    };
    const retireOrRemoveRoom = (): void => {
      updateDungeon((draft) => {
        const index = draft.rooms.findIndex((value) => value.id === room.id);
        if (index < 0) return;
        if (!savedRoom) draft.rooms.splice(index, 1);
        else Object.assign(draft.rooms[index]!, { retired: true, active: false });
      });
      setSelectedRoomId(dungeon.rooms.find((value) => value.id !== room.id)?.id ?? "");
    };
    const copyDungeon = (): void => {
      const copy = duplicateDungeon(catalog, dungeon.id);
      updateCatalog((draft) => Object.assign(draft, copy.catalog));
      setSelectedDungeonId(copy.dungeonId);
      setSelectedRoomId(dungeon.rooms[0]!.id);
      setError(null);
    };
    const createDungeon = (): void => {
      try {
        const created = createDungeonFromWizard(catalog, wizard);
        updateCatalog((draft) => { draft.dungeons.push(created); });
        setSelectedDungeonId(created.id);
        setSelectedRoomId(created.rooms[0]!.id);
        setWizardOpen(false);
      } catch (caught) { setError(errorMessage(caught)); }
    };
    const createInterior = (): void => {
      if (!interiorBase) return;
      try {
        if (newInteriorKind === "dungeon") {
          setWizard((value) => ({ ...value, name: newInteriorName.trim() || value.name }));
          setNewInteriorOpen(false);
          setWizardOpen(true);
          return;
        }
        const space = createInteriorSpace(newInteriorKind, newInteriorName, interiorBase.library, takenInteriorIds(interiorBase, catalog));
        const [definition] = editableDefinitions(interiorBase.library, [space]);
        updateCatalog((draft) => { draft.dungeons.push(definition!); });
        setSeeds((current) => ({ ...current, [space.id]: space }));
        setSelectedDungeonId(space.id);
        setSelectedRoomId(space.defaultRoomId);
        setAuthoringLevel("advanced");
        setNewInteriorOpen(false);
        setError(null);
      } catch (caught) { setError(errorMessage(caught)); }
    };
    const importDungeonArt = async (file: File, options: DungeonAssetImportOptions, onImported?: (assetKey: string) => void): Promise<boolean> => {
      if (catalog.prefabs.some((prefab) => prefab.id === options.prefabId)) { setError("That prefab ID already exists."); return false; }
      setBusy(true); setError(null);
      try {
        const imported = await props.api.importDungeonPng(file, options);
        setCatalog((current) => {
          if (!current) return current;
          const draft = structuredClone(current);
          draft.prefabs.push({
          id: options.prefabId, revision: `${options.prefabId}-v1`, name: options.displayName.trim(),
          type: options.kind, retired: false, defaultWidth: options.defaultWidth,
          defaultHeight: options.defaultHeight, defaultLayerId: options.layer,
          assetKey: imported.assetKey, renderMode: options.renderMode,
          nativeWidth: imported.width, nativeHeight: imported.height,
          pivotX: options.kind === "surface" ? 0 : 0.5,
          pivotY: options.kind === "surface" ? 0 : 1,
          defaultOpacity: 1, defaultRotationDeg: 0, defaultFlipX: false,
          defaultFlipY: false, stateAssets: [], defaultColliders: [],
          ...((options.kind === "object" || options.kind === "portal") ? { interactionRadius: 80 } : {})
          });
          pastRef.current = [...pastRef.current.slice(-(HISTORY_LIMIT - 1)), structuredClone(current)]; futureRef.current = []; setHistoryVersion((value) => value + 1);
          return draft;
        });
        setPendingDungeonAssets((current) => [...current, { stagingToken: imported.stagingToken, prefabId: options.prefabId }]);
        setSelectedPrefabId(onImported ? null : options.prefabId); setLayerId(options.layer); setSelectedMobArchetype(null); setPolygonDraft(null); setPlacementTool(null);
        onImported?.(imported.assetKey);
        props.onMessage(`Staged ${options.displayName.trim()} until Save.${onImported ? " Picture assigned." : " Click the canvas to place it."}`);
        return true;
      } catch (caught) { setError(errorMessage(caught)); return false; }
      finally { setBusy(false); }
    };
    /** Stages a replacement for a runtime PNG (Greenhouse template and plant stage art); Save publishes it with the space. */
    const replaceRuntimePng = async (assetKey: string, file: File): Promise<boolean> => {
      if (!props.writesAllowed || busy || !file.name.toLowerCase().endsWith(".png")) return false;
      if (typeof props.api.replaceRuntimeAsset !== "function") { setError("This host cannot stage runtime PNG replacements."); return false; }
      setBusy(true); setError(null);
      try {
        const staged = await props.api.replaceRuntimeAsset(assetKey, file);
        setPendingDungeonAssets((current) => [...current.filter((pending) => pending.assetKey !== assetKey), { stagingToken: staged.stagingToken, prefabId: "", assetKey }]);
        await refreshRuntimeAssets();
        props.onMessage(`Staged ${file.name}; Save publishes it with the interior.`);
        return true;
      } catch (caught) { setError(errorMessage(caught)); return false; }
      finally { setBusy(false); }
    };
    const replaceDungeonArt = async (file: File, prefab: DungeonPrefabDefinition): Promise<boolean> => {
      if (!props.writesAllowed || busy) return false;
      setBusy(true); setError(null);
      try {
        const imported = await props.api.replaceDungeonPng(file, prefab.id);
        updateCatalog((draft) => Object.assign(draft, replaceDungeonPrefabArt(draft, prefab.id, imported.assetKey, imported.width, imported.height)));
        setPendingDungeonAssets((current) => [...current.filter((pending) => pending.prefabId !== prefab.id), { stagingToken: imported.stagingToken, prefabId: prefab.id }]);
        props.onMessage(`Staged replacement art for ${prefab.name}. Save to publish it while keeping placements and state variants.`);
        return true;
      } catch (caught) { setError(errorMessage(caught)); return false; }
      finally { setBusy(false); }
    };
    /**
     * Manor "Floor art": a PNG from disk becomes this room's floor. It is the
     * room's `<room>_floor_art` background placement (the game reads exactly
     * that), backed by a `<room>_floor_art` prefab that is created or replaced.
     */
    const importRoomFloorArt = async (file: File): Promise<void> => {
      if (!catalog || !dungeon || !room || !props.writesAllowed || busy) return;
      const dungeonId = dungeon.id;
      const roomId = room.id;
      const floorId = `${roomId}_floor_art`;
      const assign = (): void => updateCatalog((draft) => {
        const prefab = draft.prefabs.find((candidate) => candidate.id === floorId);
        const target = draft.dungeons.find((candidate) => candidate.id === dungeonId)?.rooms.find((candidate) => candidate.id === roomId);
        if (!prefab || !target) return;
        target.layers.background = [
          createLayerPlacement(prefab, floorId, { x: 0, y: 0 }, target),
          ...target.layers.background.filter((placement) => placement.id !== floorId && placement.prefabId !== floorId)
        ];
      });
      const existing = catalog.prefabs.find((candidate) => candidate.id === floorId);
      if (existing) {
        if (await replaceDungeonArt(file, existing)) assign();
        return;
      }
      await importDungeonArt(file, {
        prefabId: floorId, displayName: `${room.name} floor`, kind: "surface", layer: "background",
        renderMode: "stretch", defaultWidth: room.width, defaultHeight: room.height
      }, () => assign());
    };
    /** Manor type overworld building: staged like decoration art, saved as `modules.manor`. */
    const importManorExterior = async (file: File): Promise<void> => {
      if (!dungeon || !props.writesAllowed || busy) return;
      const spaceId = dungeon.id;
      setBusy(true); setError(null);
      try {
        const named = new File([file], `${spaceId}-exterior-${Date.now().toString(36)}.png`, { type: "image/png" });
        const asset = await props.api.importManorPng(named);
        setDecorationPreviews((current) => ({ ...current, [asset.assetKey]: URL.createObjectURL(file) }));
        setPendingDungeonAssets((current) => [...current.filter((pending) => pending.assetKey !== asset.assetKey), { stagingToken: asset.stagingToken, prefabId: "", assetKey: asset.assetKey }]);
        const previous = catalog ? effectiveManorExterior(catalog, authoringSources, spaceId) : null;
        updateCatalog((draft) => setManorExterior(draft, authoringSources, spaceId, { ...(previous ?? {}), exteriorAssetKey: asset.assetKey }));
        props.onMessage(`Staged ${file.name} as the overworld building. Save to publish it.`);
      } catch (caught) { setError(errorMessage(caught)); }
      finally { setBusy(false); }
    };
    const placeAtPoint = (rawPoint: IndoorPoint): void => {
      const point = snapPoint(rawPoint, snapToGrid);
      if (polygonDraft) {
        if (shouldClosePolygon(polygonDraft.points, point)) { finishPolygon(); return; }
        setPolygonDraft((draft) => draft ? { ...draft, points: [...draft.points, point] } : draft);
        return;
      }
      if (placementTool) {
        const tool = placementTool;
        updateRoom((draft) => {
          if (tool === "anchor") { const id = nextId("anchor", draft.anchors.map((value) => value.id)); draft.anchors.push({ id, retired: false, ...point }); setSelection({ kind: tool, id }); }
          if (tool === "collider") { const id = nextId(tool, draft.colliders.map((value) => value.id)); draft.colliders.push({ id, retired: false, kind: "rectangle", x: clamp(point.x - 50, 0, Math.max(0, draft.width - 100)), y: clamp(point.y - 50, 0, Math.max(0, draft.height - 100)), width: 100, height: 100 }); setSelection({ kind: tool, id }); }
          if (tool === "zone") { const id = nextId(tool, draft.zones.map((value) => value.id)); draft.zones.push({ id, retired: false, kind: "rectangle", purpose: "trigger", x: clamp(point.x - 50, 0, Math.max(0, draft.width - 100)), y: clamp(point.y - 50, 0, Math.max(0, draft.height - 100)), width: 100, height: 100 }); setSelection({ kind: tool, id }); }
          if (tool === "resource") {
            const nodes = draft.resourceNodes ?? (draft.resourceNodes = []);
            const anchorId = nextId("resource_anchor", draft.anchors.map((value) => value.id));
            const id = nextId("resource", nodes.map((value) => value.id));
            draft.anchors.push({ id: anchorId, retired: false, ...point });
            nodes.push(createDungeonResourceNode({ id, anchorId, resourceType, minYield: 1, maxYield: 3, respawnSeconds: 300, resetOnRun: true, interactionRadius: 72 }));
            setSelection({ kind: "anchor", id: anchorId });
          }
          if (tool === "resource_zone") {
            const zones = draft.resourceSpawnZones ?? (draft.resourceSpawnZones = []);
            const id = nextId("resource_zone", zones.map((value) => value.id));
            zones.push(createDungeonResourceSpawnZone({
              id,
              shape: { id, retired: false, kind: "rectangle", x: clamp(point.x - 150, 0, Math.max(0, draft.width - 300)), y: clamp(point.y - 100, 0, Math.max(0, draft.height - 200)), width: Math.min(300, draft.width), height: Math.min(200, draft.height) },
              resourceTypes: [resourceType],
               minCount: 2,
               maxCount: 5,
               minYield: 1,
               maxYield: 3,
               minimumSpacing: 80,
              seed: Math.floor(point.x * 31 + point.y * 17),
              respawnSeconds: 300,
              resetOnRun: true,
              interactionRadius: 72
            }));
             setSelection({ kind: "resourceZone", id });
          }
          if (tool === "object") { const prefab = catalog.prefabs.find((value) => !value.retired && value.type === "object"); if (!prefab) return; const anchorId = nextId("object_anchor", draft.anchors.map((value) => value.id)); draft.anchors.push({ id: anchorId, retired: false, ...point }); const id = nextId("object", draft.objects.map((value) => value.id)); draft.objects.push(createDungeonObject(prefab, id, anchorId, "Draft Object")); setSelection({ kind: tool, id }); }
        });
        setPlacementTool(null);
        return;
      }
      const prefab = selectedPrefab;
      if (prefab) {
        if (prefab.type === "surface" || prefab.type === "decoration") updateRoom((draft) => {
          const id = nextId(prefab.id, Object.values(draft.layers).flat().map((value) => value.id));
          const placement = createLayerPlacement(prefab, id, point, draft);
          draft.layers[layerId].push(placement);
          if (!applyPrefabDefaultColliders(draft, prefab, placement)) setError("Default colliders were skipped because rotated prefab collision is not supported.");
          setSelection({ kind: "placement", id });
        });
        else if (prefab.type === "portal") {
          if (!portalPlacementAvailable) { setError("This room needs an enabled dungeon exit or another active room before placing a door."); return; }
          updateDungeon((draftDungeon) => {
            if (effectivePortalDestinationRoomId) {
              const connection = createRoomPortalConnection(draftDungeon, room.id, effectivePortalDestinationRoomId, prefab, point, true);
              if ("sourceObjectId" in connection) { setSelection({ kind: "object", id: connection.sourceObjectId }); setSelectedPrefabId(null); }
              else setError(connection.error);
              return;
            }
            const placedExit = placeConfiguredWorldExit(draftDungeon, room.id, prefab, point);
            if (placedExit) { setSelection({ kind: "object", id: placedExit.sourceObjectId }); setSelectedPrefabId(null); }
            else setError("The dungeon exit could not be placed. Check its portal setup and try again.");
          });
          return;
        } else updateDungeon((draftDungeon) => {
          const draft = draftDungeon.rooms.find((value) => value.id === room.id)!;
          const anchorId = nextId(`${prefab.id}_anchor`, draft.anchors.map((value) => value.id));
          draft.anchors.push({ id: anchorId, retired: false, ...point });
          const id = nextId(prefab.id, draft.objects.map((value) => value.id));
          draft.objects.push(createDungeonObject(prefab, id, anchorId, prefab.name));
          if (!applyPrefabDefaultColliders(draft, prefab, { id, x: point.x - prefab.defaultWidth * prefab.pivotX, y: point.y - prefab.defaultHeight * prefab.pivotY, width: prefab.defaultWidth, height: prefab.defaultHeight, rotationDeg: prefab.defaultRotationDeg, flipX: prefab.defaultFlipX, flipY: prefab.defaultFlipY })) setError("Default colliders were skipped because rotated prefab collision is not supported.");
          setSelection({ kind: "object", id });
        });
        setSelectedPrefabId(null);
        return;
      }
      if (selectedMobArchetype) updateDungeon((draftDungeon) => {
        const draft = draftDungeon.rooms.find((value) => value.id === room.id)!;
        draft.active = true;
        const boundaryId = nextId("encounter_boundary", draft.zones.map((value) => value.id));
        const leashId = nextId("leash", [...draft.zones.map((value) => value.id), boundaryId]);
        let encounter = draftDungeon.encounters.find((value) => !value.retired && value.roomId === room.id && value.id === placementEncounterId)
          ?? draftDungeon.encounters.find((value) => !value.retired && value.roomId === room.id);
        if (!encounter) {
          draft.zones.push({ id: boundaryId, retired: false, kind: "rectangle", purpose: "encounter_boundary", x: 20, y: 20, width: Math.max(1, draft.width - 40), height: Math.max(1, draft.height - 40) });
          draft.zones.push({ id: leashId, retired: false, kind: "rectangle", purpose: "leash", x: 40, y: 40, width: Math.max(1, draft.width - 80), height: Math.max(1, draft.height - 80) });
          const encounterId = nextId(`${room.id}_encounter`, draftDungeon.encounters.map((value) => value.id));
          encounter = { id: encounterId, retired: false, name: `${room.name} Encounter`, roomId: room.id, boundaryZoneId: boundaryId, leashZoneId: leashId, waves: [{ id: "wave_1", mobSpawnIds: [], delayMs: 0 }], completion: "all_spawned_mobs_defeated", reset: { onPartyWipe: true, delayMs: 1500 }, retry: { allowed: true, maxAttempts: null }, lockPortalIds: [] };
          draftDungeon.encounters.push(encounter);
          setPlacementEncounterId(encounter.id); setPlacementWaveIndex(1);
        }
        const requestedWaveIndex = Math.max(1, Math.round(placementWaveIndex));
        if (requestedWaveIndex > encounter.waves.length) {
          encounter.waves.push({ id: nextId("wave", encounter.waves.map((value) => value.id)), mobSpawnIds: [], delayMs: 0 });
        }
        const waveIndex = clamp(requestedWaveIndex, 1, encounter.waves.length);
        const anchorId = nextId("mob_anchor", draft.anchors.map((value) => value.id));
        const mobId = nextId(selectedMobArchetype, draftDungeon.rooms.flatMap((value) => value.mobs).map((value) => value.id));
        draft.anchors.push({ id: anchorId, retired: false, ...point });
        const mob = createMobPlacement(selectedMobArchetype, mobId, anchorId, encounter.id, encounter.leashZoneId); mob.waveIndex = waveIndex;
        draft.mobs.push(mob);
        encounter.waves[waveIndex - 1]!.mobSpawnIds.push(mobId);
        setSelection({ kind: "mob", id: mobId });
      });
      if (selectedMobArchetype) setSelectedMobArchetype(null);
    };
    const finishPolygon = (): void => {
      if (!polygonDraft || polygonDraft.points.length < 3) return;
      const completed = polygonDraft;
      if (completed.kind !== "zone" && interiorBase) {
        updateCatalog((draft) => {
          const result = addPolygonShape(draft, authoringSources, selectedDungeonId, selectedRoomId, completed.kind as DrawShapeKind, completed.points);
          if (!result.ok) { queueMicrotask(() => setError(result.error)); return; }
          setSelection({ kind: result.ref.kind as CanvasEntitySelection["kind"], id: result.ref.id });
          setSelectedVertex(null);
          if (result.ref.kind !== "collider") setInspectorTab("shapes");
        });
        setPolygonDraft(null);
        return;
      }
      updateRoom((draft) => {
        const kind = completed.kind === "zone" ? "zone" : "collider";
        const list = kind === "collider" ? draft.colliders : draft.zones;
        const id = nextId(`${kind}_polygon`, list.map((value) => value.id));
        if (kind === "collider") draft.colliders.push({ id, retired: false, kind: "polygon", points: completed.points });
        else draft.zones.push({ id, retired: false, kind: "polygon", purpose: "trigger", points: completed.points });
        setSelection({ kind, id });
      });
      setPolygonDraft(null);
    };
    const startShape = (kind: DrawShapeKind): void => {
      clearPlacementTools();
      setSelection(null);
      setSelectedVertex(null);
      setPolygonDraft({ kind, points: [] });
    };
    const selectTool = (tool: CanvasTool): void => {
      setPanTool(false);
      if (tool === "select") { clearPlacementTools(); return; }
      if (tool === "pan") { clearPlacementTools(); setPanTool(true); return; }
      if (tool === "floor") { startShape("floor"); return; }
      if (tool === "wall") { startShape(wallKind); return; }
      if (tool === "collider") { startShape("collider"); return; }
      if (tool === "clickArea") { startShape("click_area"); return; }
      if (tool === "anchor") { clearPlacementTools(); setSelection(null); setPlacementTool("anchor"); return; }
      const pick = lastPickRef.current;
      const prefab = pick.prefabId ? catalog.prefabs.find((value) => value.id === pick.prefabId && !value.retired) : undefined;
      clearPlacementTools();
      if (prefab) { setSelectedPrefabId(prefab.id); setLayerId(prefab.defaultLayerId); }
      else if (pick.mob) setSelectedMobArchetype(pick.mob);
    };
    const chooseWallKind = (kind: "back_wall" | "left_wall" | "right_wall"): void => { setWallKind(kind); startShape(kind); };
    /** Brings the room point of a selection to the middle of the canvas (after any room switch has rendered). */
    const focusCanvasOn = (point: IndoorPoint | null, roomSize: { width: number; height: number }): void => {
      if (!point) return;
      requestAnimationFrame(() => {
        const svg = document.querySelector<SVGSVGElement>(".interior-app .dungeon-stage svg");
        const size = svg ? { width: svg.clientWidth, height: svg.clientHeight } : null;
        if (!size || size.width === 0 || size.height === 0) return;
        const zoom = Math.max(authorViewZoomRef.current, 1);
        setAuthorViewZoom(zoom);
        setAuthorViewPan(panToPoint(point, roomSize, size, zoom));
      });
    };
    /** Click on a validation row: open its room and selection, then bring the offending item to the middle of the canvas. */
    const jumpToValidation = (context: ReturnType<typeof validationIssueContext>): void => {
      openValidationContext(context);
      const target = catalog?.dungeons.find((value) => value.id === context.dungeonId)?.rooms.find((value) => value.id === context.roomId);
      if (target && context.selection) focusCanvasOn(selectionPoint(target, authoringFor(context.dungeonId!, target), context.selection), target);
    };
    const retireSelection = (): void => {
      if (!selection) return;
      if (interiorBase && (selection.kind === "floor" || selection.kind === "wall" || selection.kind === "clickArea" || selection.kind === "collider" || selection.kind === "zone" || selection.kind === "anchor")) {
        const target = selection;
        updateCatalog((draft) => {
          if (target.kind === "anchor") {
            const result = retireAnchor(draft, authoringSources, selectedDungeonId, selectedRoomId, target.id);
            if (!result.ok) queueMicrotask(() => setError(result.error));
          } else if (!retireShape(draft, authoringSources, selectedDungeonId, selectedRoomId, target as ShapeRef)) queueMicrotask(() => setError("That shape could not be retired."));
        });
        setSelection(null);
        setSelectedVertex(null);
        return;
      }
      if (selection.kind === "mob") {
        const selectedMob = room.mobs.find((value) => value.id === selection.id);
        const deletionBlocker = selectedMob ? encounterDeletionBlocker(dungeon, selectedMob.encounterId, selectedMob.id) : null;
        if (deletionBlocker) { setError(deletionBlocker); return; }
        updateDungeon((draftDungeon) => {
          const draft = draftDungeon.rooms.find((value) => value.id === room.id);
          const mob = draft?.mobs.find((value) => value.id === selection.id);
          if (!mob) return;
          const affectedEncounterIds = new Set(draftDungeon.encounters
            .filter((encounter) => encounter.waves.some((wave) => wave.mobSpawnIds.includes(mob.id)))
            .map((encounter) => encounter.id));
          affectedEncounterIds.add(mob.encounterId);
          mob.retired = true;
          for (const encounter of draftDungeon.encounters) for (const wave of encounter.waves) wave.mobSpawnIds = wave.mobSpawnIds.filter((value) => value !== mob.id);
          for (const encounterId of affectedEncounterIds) {
            const encounter = draftDungeon.encounters.find((value) => value.id === encounterId && !value.retired);
            if (!encounter || !draft) continue;
            if (!draft.mobs.some((value) => !value.retired && value.encounterId === encounter.id)) {
              retireEmptyEncounter(draftDungeon, encounter.id);
              continue;
            }
            for (let index = encounter.waves.length - 1; index >= 0 && encounter.waves.length > 1; index -= 1) {
              if (encounter.waves[index]?.mobSpawnIds.length === 0) removeEncounterWave(draftDungeon, encounter.id, index + 1);
            }
          }
        });
        setSelection(null);
        return;
      }
      if (selection.kind === "object") {
        const selectedObject = room.objects.find((value) => value.id === selection.id);
        if (selectedObject?.type === "portal" && selectedObject.portalId) {
          updateDungeon((draftDungeon) => { retireDungeonPortalConnection(draftDungeon, selectedObject.portalId!); });
          setSelection(null);
          return;
        }
      }
      if (selection.kind === "resourceZone") {
        updateRoom((draft) => { const value = draft.resourceSpawnZones?.find((candidate) => candidate.id === selection.id); if (value) value.retired = true; });
        setSelection(null);
        return;
      }
      updateRoom((draft) => {
        const values = selection.kind === "anchor" ? draft.anchors : selection.kind === "collider" ? draft.colliders : selection.kind === "zone" ? draft.zones : selection.kind === "object" ? draft.objects : Object.values(draft.layers).flat();
        const value = values.find((candidate) => candidate.id === selection.id);
        if (value) value.retired = true;
      });
      setSelection(null);
    };
    const duplicateSelection = (): void => {
      if (!selection) return;
      updateDungeon((draftDungeon) => {
        const draft = draftDungeon.rooms.find((value) => value.id === room.id)!;
        if (selection.kind === "placement") {
          for (const placements of Object.values(draft.layers)) { const source = placements.find((value) => value.id === selection.id); if (source) { const copy = structuredClone(source); copy.id = nextId(source.id, Object.values(draft.layers).flat().map((value) => value.id)); copy.x = clamp(copy.x + 25, 0, draft.width - copy.width); copy.y = clamp(copy.y + 25, 0, draft.height - copy.height); placements.push(copy); setSelection({ kind: "placement", id: copy.id }); return; } }
        }
        if (selection.kind === "collider" || selection.kind === "zone") {
          const list = selection.kind === "collider" ? draft.colliders : draft.zones;
          const source = list.find((value) => value.id === selection.id); if (!source) return;
          const copy = structuredClone(source); copy.id = nextId(source.id, list.map((value) => value.id));
          if (copy.kind === "rectangle") { copy.x = clamp(copy.x + 25, 0, draft.width - copy.width); copy.y = clamp(copy.y + 25, 0, draft.height - copy.height); } else copy.points = copy.points.map((value) => ({ x: clamp(value.x + 25, 0, draft.width), y: clamp(value.y + 25, 0, draft.height) }));
          list.push(copy as never); setSelection({ kind: selection.kind, id: copy.id }); return;
        }
        if (selection.kind === "resourceZone") {
          const list = draft.resourceSpawnZones ?? (draft.resourceSpawnZones = []);
          const source = list.find((value) => value.id === selection.id); if (!source) return;
          const copy = structuredClone(source); copy.id = nextId(source.id, list.map((value) => value.id));
          if (copy.shape.kind === "rectangle") { copy.shape.x = clamp(copy.shape.x + 25, 0, draft.width - copy.shape.width); copy.shape.y = clamp(copy.shape.y + 25, 0, draft.height - copy.shape.height); } else copy.shape.points = copy.shape.points.map((value) => ({ x: clamp(value.x + 25, 0, draft.width), y: clamp(value.y + 25, 0, draft.height) }));
          list.push(copy); setSelection({ kind: "resourceZone", id: copy.id }); return;
        }
        if (selection.kind === "anchor") { const source = draft.anchors.find((value) => value.id === selection.id); if (!source) return; const copy = { ...source, id: nextId(source.id, draft.anchors.map((value) => value.id)), x: clamp(source.x + 25, 0, draft.width), y: clamp(source.y + 25, 0, draft.height) }; draft.anchors.push(copy); setSelection({ kind: "anchor", id: copy.id }); return; }
        if (selection.kind === "object") { const source = draft.objects.find((value) => value.id === selection.id); if (!source || source.type === "portal") return; const anchor = draft.anchors.find((value) => value.id === source.anchorId); if (!anchor) return; const anchorId = nextId(`${source.id}_anchor`, draft.anchors.map((value) => value.id)); draft.anchors.push({ ...anchor, id: anchorId, x: clamp(anchor.x + 25, 0, draft.width), y: clamp(anchor.y + 25, 0, draft.height) }); const copy = { ...source, id: nextId(source.id, draft.objects.map((value) => value.id)), anchorId }; draft.objects.push(copy); setSelection({ kind: "object", id: copy.id }); return; }
        if (selection.kind === "mob") { const source = draft.mobs.find((value) => value.id === selection.id); if (!source) return; const anchor = draft.anchors.find((value) => value.id === source.anchorId); const encounter = draftDungeon.encounters.find((value) => value.id === source.encounterId); if (!anchor || !encounter) return; const anchorId = nextId(`${source.id}_anchor`, draft.anchors.map((value) => value.id)); draft.anchors.push({ ...anchor, id: anchorId, x: clamp(anchor.x + 25, 0, draft.width), y: clamp(anchor.y + 25, 0, draft.height) }); const copy = { ...source, id: nextId(source.id, draftDungeon.rooms.flatMap((value) => value.mobs).map((value) => value.id)), anchorId }; draft.mobs.push(copy); encounter.waves[source.waveIndex - 1]?.mobSpawnIds.push(copy.id); setSelection({ kind: "mob", id: copy.id }); }
      });
    };
    const selectOnCanvas = (value: EditorSelection): void => {
      setSelection(value);
      setSelectedVertex(null);
      if (!value || !authoring) return;
      const shape = value.kind === "floor" || value.kind === "wall" || value.kind === "clickArea" || ((value.kind === "collider" || value.kind === "zone") && shapeVertices(room, authoring, value as ShapeRef));
      if (shape) setInspectorTab("shapes");
    };
    const normalizedLibrarySearch = librarySearch.trim().toLowerCase();
    const kindMatches = (prefab: DungeonPrefabDefinition): boolean => showAllArt || prefabMatchesInteriorKind(prefab, spaceKind) || pendingDungeonAssets.some((pending) => pending.prefabId === prefab.id);
    const libraryCandidates = catalog.prefabs.filter((prefab) => {
      if (!showRetired && prefab.retired) return false;
      if (libraryCategory === "art") return prefab.type === "surface" || prefab.type === "decoration";
      if (libraryCategory === "objects") return prefab.type === "object";
      if (libraryCategory === "doors") return prefab.type === "portal";
      return libraryCategory === "all";
    });
    const hiddenArtCount = libraryCandidates.filter((prefab) => !kindMatches(prefab)).length;
    const visiblePrefabs = catalog.prefabs.filter((prefab) => {
      if (!showRetired && prefab.retired) return false;
      if (!kindMatches(prefab)) return false;
      if (normalizedLibrarySearch && !`${prefab.name} ${prefab.type}`.toLowerCase().includes(normalizedLibrarySearch)) return false;
      if (libraryCategory === "art") return prefab.type === "surface" || prefab.type === "decoration";
      if (libraryCategory === "objects") return prefab.type === "object";
      if (libraryCategory === "doors") return prefab.type === "portal";
      return libraryCategory === "all";
    });
    const collapsedValidationRows = [...issues.reduce((rows, issue) => {
      const context = validationIssueContext(catalog, issue.path, authoringFor);
      const message = friendlyValidationMessage(issue.path, issue.message);
      const key = [context.category, context.label, context.dungeonId, context.roomId, context.inspectorTab, context.selection?.kind, context.selection?.id, message].join("\0");
      const existing = rows.get(key);
      if (existing) { if (!existing.paths.includes(issue.path)) existing.paths.push(issue.path); existing.count += 1; }
      else rows.set(key, { context, message, paths: [issue.path], count: 1 });
      return rows;
    }, new Map<string, { context: ReturnType<typeof validationIssueContext>; message: string; paths: string[]; count: number }>()).values()];
    const validationGroups = [...collapsedValidationRows.reduce((groups, row) => { const category = row.context.category; groups.set(category, [...groups.get(category) ?? [], row]); return groups; }, new Map<string, typeof collapsedValidationRows>()).entries()];
    const hasOneActiveRoom = dungeon.rooms.filter((candidate) => !candidate.retired && candidate.active).length === 1
      && room.active && !room.retired;
    const simple = simpleMode;
    const activeTool: CanvasTool = polygonDraft
      ? polygonDraft.kind === "floor" ? "floor" : polygonDraft.kind === "collider" ? "collider" : polygonDraft.kind === "click_area" ? "clickArea" : polygonDraft.kind === "zone" ? "select" : "wall"
      : placementTool === "anchor" ? "anchor"
        : selectedPrefabId || selectedMobArchetype || placementTool ? "place"
          : panTool || spaceHeld ? "pan" : "select";
    const anchorRoleMap = authoring ? Object.fromEntries(room.anchors.map((anchor) => [anchor.id, anchorRoleOf(catalog, authoringSources, dungeon.id, room, anchor.id)])) : {};
    const namingContext: NamingContext = { room, dungeon, prefabs: catalog.prefabs, authoring, anchorRoles: anchorRoleMap };
    const checklist = roomChecklist({ room, dungeon, authoring });
    const showChecklist = editorView === "room" && mode === "author" && !checklistHidden.includes(`${dungeon.id}:${room.id}`) && checklist.some((item) => (item.id === "art" || item.id === "floor") && !item.done);
    const runChecklistStep = (id: (typeof checklist)[number]["id"]): void => {
      if (id === "art") { clearPlacementTools(); setLibraryCategory("art"); setLibrarySearch(""); setAddAreaOpen(true); setRailCollapsed(false); props.onMessage("Pick room art in the library, then click the room to place it."); return; }
      if (id === "floor" || id === "spawn" || (id === "exit" && authoring)) { selectTool(id === "floor" ? "floor" : "anchor"); return; }
      setInspectorTab("portals");
    };
    const selectionSummary = selection ? describeSelection({ ...namingContext, authoring: authoring ?? effectiveRoomAuthoring(catalog, authoringSources, dungeon.id, room) }, selection) : null;
    const simpleCategoryLabel: Record<LibraryCategory, string> = { all: "Everything", art: "Room Art", objects: "Objects", doors: "Doors", mobs: "Enemies" };
    const deleteDraftDungeon = (): void => {
      if (dungeon.id === "cistern_warrens" || catalog.dungeons.length <= 1) return;
      const nextDungeon = catalog.dungeons.find((candidate) => candidate.id !== dungeon.id && !candidate.retired)
        ?? catalog.dungeons.find((candidate) => candidate.id !== dungeon.id);
      if (!nextDungeon) return;
      updateCatalog((draft) => {
        if (savedDungeon) archiveCreatorDungeon(draft, dungeon.id);
        else draft.dungeons = draft.dungeons.filter((candidate) => candidate.id !== dungeon.id);
        draft.entrances = draft.entrances.filter((entrance) => entrance.dungeonId !== dungeon.id);
      });
      if (!savedDungeon) setSeeds((current) => Object.fromEntries(Object.entries(current).filter(([id]) => id !== dungeon.id)));
      clearPlacementTools();
      setSelection(null);
      setSelectedDungeonId(nextDungeon.id);
      setSelectedRoomId(nextDungeon.rooms.find((candidate) => !candidate.retired)?.id ?? nextDungeon.rooms[0]?.id ?? "");
      setDraftDungeonDeleteId(null);
      setMode("author");
      setError(null);
      props.onMessage(`${savedDungeon ? "Archived" : "Removed unfinished"} dungeon “${dungeon.name}”. Save to keep this change.`);
    };

    const testView = mode === "floorwalk" && interiorBase
      ? <InteriorWalkTest key={dungeon.id} space={interiorFromEditingView(interiorBase, seeds, catalog).spaces.find((space) => space.id === dungeon.id) ?? interiorBase.spaces[0]!} roomId={room.id} onExit={() => setMode("author")} />
      : mode === "walk"
        ? <DungeonPlayTest key={`${dungeon.id}:${playKind}`} api={props.api} catalog={interiorBase ? dungeonCatalogFromInterior(interiorFromEditingView(interiorBase, seeds, catalog)) : catalog} dungeonId={dungeon.id} mode={playKind} roomId={room.id} onExit={() => { setMode("author"); if (simpleStep === "test") setSimpleStep("art"); }} />
        : null;

    const roomFlowIssues = isDungeonKind ? topology.issues.filter((issue) => issue.roomId === room.id) : [];
    const warningCount = isDungeonKind ? topology.issues.filter((issue) => issue.severity === "warning").length : 0;
    const flowErrors = isDungeonKind ? topology.issues.filter((issue) => issue.severity === "error").length : 0;
    const saveConflict = Boolean(error && /conflict|out of date|stale|changed on disk|expected .*revision|revision .*(mismatch|changed)/iu.test(error));
    const saveState = busy ? "saving" : saveConflict ? "conflict" : dirty ? "unsaved" : "saved";
    const saveLabel = saveState === "saving" ? "Saving\u2026" : saveState === "conflict" ? "Conflict" : saveState === "unsaved" ? "Unsaved changes \u2022" : "Saved";
    const editActive = !testView && editorView === "room";
    const goEdit = (): void => { setEditorView("room"); setMode("author"); if (simple && simpleStep === "test") setSimpleStep("art"); };
    const closeMenu = (event: { currentTarget: HTMLElement }): void => { event.currentTarget.closest("details")?.removeAttribute("open"); };
    const KIND_GLYPH: Record<InteriorSpaceKind, string> = { dungeon: "\u2694", manor: "\u2302", greenhouse: "\u2740", salon: "\u2702" };

    return (
      <section className={`dungeon-studio interior-app ${railCollapsed ? "rail-collapsed" : ""} ${inspectorCollapsed ? "inspector-collapsed" : ""} ${testView ? "testing" : ""}`} aria-label={studioName} aria-busy={busy} data-testid="interiors-workspace">
        <header className="interior-toolbar" data-testid="interiors-toolbar" aria-label="Interior toolbar">
          {props.hosted ? null : <div className="interior-toolbar-group">
            <button type="button" disabled={pastRef.current.length === 0} onClick={undo}>Undo</button>
            <button type="button" disabled={futureRef.current.length === 0} onClick={redo}>Redo</button>
          </div>}
          <div className="dungeon-mode interior-mode-switch" role="tablist" aria-label="Dungeon preview mode">
            <button type="button" role="tab" aria-selected={editActive} className={editActive ? "active" : ""} onClick={goEdit}>Edit</button>
            {!simple ? <button type="button" role="tab" aria-selected={mode === "floorwalk"} className={mode === "floorwalk" ? "active" : ""} onClick={() => { clearPlacementTools(); setPolygonDraft(null); setSelection(null); setMode("floorwalk"); }}>Walk Test</button> : null}
            <button type="button" role="tab" aria-selected={mode === "walk"} className={mode === "walk" ? "active" : ""} disabled={!isDungeonKind} title={isDungeonKind ? undefined : "Play Test runs the dungeon systems; other interiors are not playable here yet."} onClick={() => { clearPlacementTools(); setPlayKind("full"); setMode("walk"); if (simple) setSimpleStep("test"); }}>Play Test</button>
            {isDungeonKind ? <button type="button" role="tab" aria-selected={!testView && editorView === "topology"} className={!testView && editorView === "topology" ? "active" : ""} onClick={() => { setMode("author"); setEditorView("topology"); }}>Flow{flowErrors > 0 ? <span className="interior-count-badge" title={`${flowErrors} structural error${flowErrors === 1 ? "" : "s"}`}>{flowErrors}</span> : null}</button> : null}
            {hasDecoration ? <button type="button" role="tab" aria-selected={!testView && editorView === "decoration"} className={!testView && editorView === "decoration" ? "active" : ""} onClick={() => { clearPlacementTools(); setPolygonDraft(null); setSelection(null); setEditorView("decoration"); setMode("author"); }}>Decoration Test</button> : null}
          </div>
          {mode === "walk" ? <div className="dungeon-mode interior-play-scope" role="tablist" aria-label="Play Test scope">
            <button type="button" role="tab" aria-selected={playKind === "full"} className={playKind === "full" ? "active" : ""} onClick={() => setPlayKind("full")}>Whole dungeon</button>
            <button type="button" role="tab" aria-selected={playKind === "room"} className={playKind === "room" ? "active" : ""} onClick={() => setPlayKind("room")}>This room only</button>
          </div> : null}
          {isDungeonKind && !testView ? <div className="dungeon-authoring-level" title={simple ? "Simple shows only the steps needed for a basic dungeon." : "Advanced shows connections, encounter details, rules, collision, zones, and technical fields."}><div className="dungeon-mode" role="tablist" aria-label="Authoring detail"><button type="button" role="tab" aria-selected={simple} className={simple ? "active" : ""} onClick={() => { setAuthoringLevel("simple"); if (inspectorTab === "encounters") setSimpleStep("mobs"); else if (inspectorTab === "room") setSimpleStep("finish"); else if (libraryCategory === "mobs") setSimpleStep("mobs"); else if (libraryCategory === "objects") setSimpleStep("chest"); else setSimpleStep("art"); if (inspectorTab === "logic" || inspectorTab === "advanced") setInspectorTab("room"); }}>Simple</button><button type="button" role="tab" aria-selected={!simple} className={!simple ? "active" : ""} onClick={() => setAuthoringLevel("advanced")}>Advanced</button></div></div> : null}
          <div className="interior-toolbar-spacer" />
          <span className="interior-save-status" data-state={saveState} aria-live="polite" data-testid="interiors-save-status">{saveLabel}</span>
          <button type="button" className="interior-validation-badge" data-testid="interiors-validation" data-state={issues.length === 0 ? "ok" : "issues"} aria-expanded={validationOpen} aria-label={issues.length === 0 ? warningCount === 0 ? "Validation: no issues" : `Validation: ${warningCount} warning${warningCount === 1 ? "" : "s"}` : `Validation: ${issues.length} error${issues.length === 1 ? "" : "s"}${warningCount ? `, ${warningCount} warning${warningCount === 1 ? "" : "s"}` : ""}`} title="Show validation details" onClick={() => { if (testView) goEdit(); setValidationOpen((value) => !value); }}>{issues.length === 0 ? warningCount === 0 ? "\u2713 Valid" : `\u2713 Valid \u00b7 ${warningCount} warning${warningCount === 1 ? "" : "s"}` : `${issues.length} error${issues.length === 1 ? "" : "s"}${warningCount ? ` \u00b7 ${warningCount} warning${warningCount === 1 ? "" : "s"}` : ""}`}</button>
          {props.hosted ? null : <>
            <button type="button" disabled={!dirty || busy} onClick={() => void revert()}>Revert</button>
            <button type="button" className="primary" disabled={!props.writesAllowed || !dirty || busy || issues.length > 0} title={issues.length > 0 ? `Fix ${issues.length} error${issues.length === 1 ? "" : "s"} first (see the validation badge)` : undefined} onClick={() => void save()}>Save to Worktree</button>
          </>}
        </header>

        {draftDungeonDeleteId === dungeon.id ? <section className="panel inline-confirmation dungeon-delete-confirmation" role="alertdialog" aria-label={savedDungeon ? "Archive dungeon confirmation" : "Delete unfinished dungeon confirmation"}>
          <strong>{savedDungeon ? "Archive" : "Delete unfinished"} {isDungeonKind ? "dungeon" : "interior"} “{dungeon.name}”?</strong>
          <p>{savedDungeon ? "Archive hides this dungeon and removes its world entrance. Rooms, art and reward identities are retained. Finish live test runs before publishing an archive. Save publishes the archive; Revert cancels it." : "This removes only this unsaved dungeon. Your other dungeon edits stay exactly as they are."}</p>
          <div className="dungeon-author-actions"><button type="button" onClick={() => setDraftDungeonDeleteId(null)}>Cancel</button><button type="button" className="danger" onClick={deleteDraftDungeon}>{savedDungeon ? "Archive dungeon" : isDungeonKind ? "Delete unfinished dungeon" : "Discard new interior"}</button></div>
        </section> : null}

        {newInteriorOpen ? <section className="panel dungeon-wizard" role="dialog" aria-label="New interior">
          <PanelHeading title="New Interior" meta="Choose what kind of space to build" />
          <label className="field compact"><span>Interior kind</span><select value={newInteriorKind} onChange={(event) => setNewInteriorKind(event.target.value as InteriorSpaceKind)}>{INTERIOR_KINDS.map((kind) => <option key={kind} value={kind}>{INTERIOR_KIND_LABELS[kind]}</option>)}</select></label>
          <TextField label="Interior name" value={newInteriorName} onChange={setNewInteriorName} />
          <small>{newInteriorKind === "dungeon" ? "Continue to the dungeon setup for theme, size and reset rules." : "Starts with one room, a spawn and a world exit. Only one Greenhouse and one Salon are used by the game today."}</small>
          <div className="dungeon-author-actions"><button type="button" onClick={() => setNewInteriorOpen(false)}>Cancel</button><button type="button" className="primary" disabled={!newInteriorName.trim()} onClick={createInterior}>{newInteriorKind === "dungeon" ? "Continue" : "Create interior"}</button></div>
        </section> : null}

        {wizardOpen ? <DungeonWizard value={wizard} proposedId={safeDungeonId(wizard.name)} onChange={setWizard} onCancel={() => setWizardOpen(false)} onCreate={createDungeon} /> : null}

        {testView ? <div className="interior-workspace testing"><div className="interior-center interior-test-view">{testView}</div></div> : <div className="interior-workspace">
          <div className="interior-rail" data-testid="interiors-rail" data-collapsed={railCollapsed}>
            <button type="button" className="interior-collapse-btn" aria-expanded={!railCollapsed} aria-label={railCollapsed ? "Show interiors and rooms" : "Hide interiors and rooms"} title={railCollapsed ? "Show interiors and rooms" : "Hide interiors and rooms"} onClick={() => setRailCollapsed((value) => !value)}>{railCollapsed ? "\u00BB" : "\u00AB"}</button>
            <div className="interior-rail-inner">
              <section className="interior-picker" aria-label="Interior picker">
                  <label className="field compact">
                    <span>Interior</span>
                    <select value={dungeon.id} data-testid="interiors-picker" onChange={(event) => {
                      setSelectedPrefabId(null); setSelectedMobArchetype(null); setPolygonDraft(null); setPlacementTool(null);
                      setDraftDungeonDeleteId(null);
                      setSelectedDungeonId(event.target.value);
                      setSelectedRoomId(catalog.dungeons.find((value) => value.id === event.target.value)?.rooms[0]?.id ?? "");
                    }}>
                      {INTERIOR_KINDS.map((kind) => {
                          const members = catalog.dungeons.filter((value) => interiorSpaceKind(interiorBase!, seeds, value.id) === kind && (showRetired || !value.retired || value.id === dungeon.id));
                          return members.length === 0 ? null : <optgroup key={kind} label={INTERIOR_KIND_GROUP_LABELS[kind]}>{members.map((value) => <option key={value.id} value={value.id}>{value.name}{value.retired ? " (retired)" : ""}</option>)}</optgroup>;
                      })}
                    </select>
                  </label>
                <span className="dungeon-revision interior-kind-badge" data-kind={spaceKind}><i aria-hidden="true">{KIND_GLYPH[spaceKind]}</i>{INTERIOR_KIND_LABELS[spaceKind]}</span>
                <div className="interior-picker-actions">
                  <button type="button" className="primary" data-testid="interiors-new" disabled={!props.writesAllowed || busy} onClick={() => setNewInteriorOpen(true)}>+ New interior</button>
                  <details className="interior-menu">
                    <summary aria-label="More interior actions" title="More interior actions">{"\u22EF"}</summary>
                    <div className="interior-menu-list" onClick={(event) => { if ((event.target as HTMLElement).closest("button")) closeMenu({ currentTarget: event.currentTarget }); }}>
                      {isDungeonKind ? <button type="button" disabled={!props.writesAllowed || busy} onClick={copyDungeon}>Duplicate dungeon</button> : null}
                      {dungeon.id !== "cistern_warrens" && !dungeon.retired && (isDungeonKind || !savedDungeon) ? <button type="button" className="danger" disabled={!props.writesAllowed || busy || catalog.dungeons.length <= 1} onClick={() => setDraftDungeonDeleteId(dungeon.id)}>{savedDungeon ? "Archive dungeon" : isDungeonKind ? "Delete unfinished dungeon" : "Discard new interior"}</button> : null}
                      {!simple ? <><label className="toggle"><input type="checkbox" checked={showRetired} onChange={(event) => setShowRetired(event.target.checked)} /><span>Show retired</span></label><span className="dungeon-revision">Catalog revision {catalog.catalogRevision}</span><button type="button" disabled={busy} onClick={() => void reloadFromDisk()}>Reload from disk</button></> : null}
                    </div>
                  </details>
                </div>
              </section>
              <section className="interior-rooms" data-testid="interiors-rooms" aria-label="Rooms">
                <div className="interior-section-title"><strong>Rooms</strong><small>{dungeon.rooms.filter((value) => showRetired || !value.retired).length}</small></div>
                <div className="dungeon-room-rail" data-testid="interiors-room-list" role="listbox" aria-label="Dungeon room graph">
                  {dungeon.rooms.filter((value) => showRetired || !value.retired).map((value) => {
                    const links = dungeon.portals.filter((portal) => !portal.retired && portal.source.kind === "room" && portal.source.roomId === value.id && portal.destination.kind === "room").length;
                    return <button key={value.id} data-testid={`interiors-room-${value.id}`} type="button" role="option" aria-selected={value.id === room.id} className={value.id === room.id ? "selected" : ""} onClick={() => { setSelectedPrefabId(null); setSelectedMobArchetype(null); setPolygonDraft(null); setPlacementTool(null); setSelectedRoomId(value.id); setSelection(null); }}>
              <strong>{value.name}</strong><small>{value.width}×{value.height} · {links} link{links === 1 ? "" : "s"}</small>{value.retired ? <em>Retired</em> : null}
            </button>;
                  })}
                </div>
                <button type="button" className="add-room" data-testid="interiors-add-room" aria-expanded={roomFormOpen} disabled={!props.writesAllowed} onClick={() => setRoomFormOpen(true)}>+ Room</button>
          {roomFormOpen ? <section className="panel dungeon-room-form" aria-label="Create room">
            <PanelHeading title="Create Room" meta="Inactive until you activate it" />
            <TextField label="Room name" value={roomDraft.name} onChange={(name) => setRoomDraft((value) => ({ ...value, name }))} />
            <label className="field compact"><span>Room size</span><select value={roomDraft.preset} onChange={(event) => { const preset = event.target.value; const size = roomSizePreset(preset); setRoomDraft((value) => ({ ...value, preset, ...(size ?? {}) })); }}><option value="small">Small · 720 × 540</option><option value="medium">Medium · 1000 × 1000</option><option value="large">Large · 1440 × 1080</option><option value="custom">Custom</option></select></label>
            {roomDraft.preset === "custom" ? <div className="field-grid"><NumberField label="Room width" value={roomDraft.width} min={320} onChange={(width) => setRoomDraft((value) => ({ ...value, width }))} /><NumberField label="Room height" value={roomDraft.height} min={320} onChange={(height) => setRoomDraft((value) => ({ ...value, height }))} /></div> : null}
            <div className="dungeon-author-actions"><button type="button" onClick={() => setRoomFormOpen(false)}>Cancel</button><button type="button" className="primary" disabled={!roomDraft.name.trim()} onClick={addRoom}>Create room</button></div>
          </section> : null}
              </section>
              <aside ref={addAreaRef} id="dungeon-prefab-library" tabIndex={-1} className={`panel dungeon-library ${addAreaOpen ? "mobile-add-focus" : ""}`} hidden={editorView !== "room"} aria-label={simple ? "Things to Add" : "Prefab add library"}>
                <PanelHeading title={simple ? "Things to Add" : "Prefab Library"} meta={showAllArt ? `${catalog.prefabs.length} pieces` : `${INTERIOR_KIND_LABELS[spaceKind]} art`} />
                <div className="dungeon-scroll">
                  <label className="field compact"><span>Search library</span><input type="search" value={librarySearch} onChange={(event) => setLibrarySearch(event.target.value)} /></label>
                  <div className="dungeon-library-categories" role="tablist" aria-label="Library categories">{(["all", "art", "objects", "doors", "mobs"] as const).filter((category) => isDungeonKind || category !== "mobs").map((category) => <button key={category} type="button" role="tab" aria-selected={libraryCategory === category} onClick={() => { setLibraryCategory(category); if (simple) { setLibrarySearch(""); if (category === "mobs") setSimpleStep("mobs"); else if (category === "objects") setSimpleStep("chest"); else if (category === "art" || category === "all" || category === "doors") setSimpleStep("art"); } }}>{simpleCategoryLabel[category]}</button>)}</div>
                  <DungeonAssetImportCard simple={simple} disabled={!props.writesAllowed || busy} onImport={importDungeonArt} />
                  <label className="toggle dungeon-library-all" title="Art made for other kinds of interior is hidden by default"><input type="checkbox" checked={showAllArt} onChange={(event) => setShowAllArt(event.target.checked)} /><span>Show all art{!showAllArt && hiddenArtCount > 0 ? ` (${hiddenArtCount} hidden)` : ""}</span></label>
                  {selectedPrefab || selectedMobArchetype ? <div className="dungeon-library-armed" role="status"><strong>Click the room to place {selectedPrefab ? selectedPrefab.name : friendlyId(selectedMobArchetype!)}</strong><span>Esc cancels</span><button type="button" onClick={clearPlacementTools}>Cancel</button></div> : null}
                  {libraryCategory !== "mobs" && visiblePrefabs.length === 0 ? <p className="empty-copy">{hiddenArtCount > 0 ? `No ${INTERIOR_KIND_LABELS[spaceKind].toLowerCase()} pieces here yet. Turn on Show all art to see ${hiddenArtCount} more, or use Add art.` : "Nothing matches. Try another category or search, or use Add art."}</p> : null}
                  {libraryCategory !== "mobs" ? <div className="dungeon-library-grid">{visiblePrefabs.map((prefab) => {
                    return <article key={prefab.id} className={`${prefab.retired ? "retired" : ""} ${selectedPrefabId === prefab.id ? "selected" : ""}`}>
                      <img className="dungeon-prefab-thumbnail" loading="lazy" src={runtimeDungeonAssetUrl(prefab.assetKey)} alt="" />
                      <strong>{prefab.name}</strong><span>{friendlyPrefabKind(prefab.type)} · {prefab.defaultWidth}×{prefab.defaultHeight}</span>
                      {!simple ? <details><summary>Advanced metadata</summary><small>{prefab.id} · {prefab.revision} · {prefab.defaultLayerId}</small></details> : null}
                      <button type="button" aria-pressed={selectedPrefabId === prefab.id} disabled={!props.writesAllowed || prefab.retired || (prefab.type === "portal" && !portalPlacementAvailable)} title={prefab.type === "portal" && !portalPlacementAvailable ? "This room needs an enabled dungeon exit or another active room before placing a door." : undefined} onClick={() => { setSelectedPrefabId((value) => { if (value !== prefab.id) setLayerId(prefab.defaultLayerId); return value === prefab.id ? null : prefab.id; }); setSelectedMobArchetype(null); setPolygonDraft(null); setPlacementTool(null); }}>{selectedPrefabId === prefab.id ? simple ? "Click room to place" : "Placing · click canvas" : simple ? "Place" : prefab.type === "object" ? "Create object" : "Click to place"}</button>
                      {!simple ? <DungeonAssetReplacementCard prefab={prefab} disabled={!props.writesAllowed || busy} onReplace={replaceDungeonArt} /> : null}
                      {pendingDungeonAssets.some((pending) => pending.prefabId === prefab.id) ? <em className="dungeon-staged-art">Staged until Save</em> : null}
                    </article>})}</div> : null}
                  {isDungeonKind && (libraryCategory === "all" || libraryCategory === "mobs") ? <><div className="divider"><span>{simple ? "ENEMIES" : "MOBS"}</span></div><div className="dungeon-mob-library">{MOB_ARCHETYPE_KEYS.filter((archetype) => !normalizedLibrarySearch || friendlyId(archetype).toLowerCase().includes(normalizedLibrarySearch)).map((archetype) => <button key={archetype} type="button" aria-pressed={selectedMobArchetype === archetype} onClick={() => { setSelectedMobArchetype((value) => value === archetype ? null : archetype); setSelectedPrefabId(null); setPolygonDraft(null); setPlacementTool(null); }}>{friendlyId(archetype)}{!simple ? <small>Mob</small> : null}</button>)}</div></> : null}
                </div>
              </aside>
            </div>
          </div>

          <div className="interior-center" data-testid="interiors-center">
          {editorView === "topology" ? <DungeonTopology dungeon={dungeon} prefabs={catalog.prefabs} selectedRoomId={room.id} selectedAnchorId={selection?.kind === "anchor" ? selection.id : null} disabled={!props.writesAllowed || busy} preferenceKey={`${props.session.workspace.worktreePath}|${dungeon.id}`} onSelectRoom={(id) => { setSelectedRoomId(id); setSelection(null); }} onSelectAnchor={(roomId, anchorId) => { setSelectedRoomId(roomId); setSelection({ kind: "anchor", id: anchorId }); }} onEditRoom={(id) => { setSelectedRoomId(id); setEditorView("room"); }} onChangeDungeon={updateDungeon} /> : null}
          {editorView === "decoration" && hasDecoration ? <section className="dungeon-decoration-test" aria-label="Decoration Test">
            <label className="field compact"><span>Decoration room</span><select value={room.id} onChange={(event) => { setSelectedRoomId(event.target.value); setSelectedDecorationId(null); }}>{dungeon.rooms.filter((value) => showRetired || !value.retired).map((value) => <option key={value.id} value={value.id}>{value.name}</option>)}</select></label>
            <InteriorDecorationTest
              room={{ id: room.id, width: room.width, height: room.height, placementSurfaces: decorationSurfacesOf(effectiveRoomAuthoring(catalog, authoringSources, dungeon.id, room)) }}
              decorations={effectiveDecorations(catalog, authoringSources, dungeon.id).filter((value) => value.roomId === room.id && !value.retired)}
              previews={decorationPreviews} selectedId={selectedDecorationId} writesAllowed={props.writesAllowed && !busy} api={props.api}
              onSelect={setSelectedDecorationId}
              onChange={(next) => {
                // Drags and typed edits arrive as a burst of changes; the shared grouping makes them one undo step.
                updateCatalog((draft) => editDecorations(draft, authoringSources, dungeon.id, (definitions) => {
                  definitions.splice(0, definitions.length, ...decorationsAfterRoomEdit(definitions, storedDecorationIds(authoringSources, dungeon.id), room.id, next));
                }));
              }}
              onPreview={(assetKey, url) => setDecorationPreviews((current) => ({ ...current, [assetKey]: url }))}
              onPendingAsset={(stagingToken, assetKey) => setPendingDungeonAssets((current) => [...current.filter((pending) => pending.assetKey !== assetKey), { stagingToken, prefabId: "", assetKey }])} />
          </section> : null}
            <section className={`panel dungeon-canvas-panel ${canvasFocused ? "focused" : ""}`} data-testid="interiors-canvas" hidden={editorView !== "room"}>
              {selectedPrefab?.type === "portal" ? <div className="dungeon-placement-banner" role="status"><strong>Placing {selectedPrefab.name}</strong>{activePortalDestinations.length > 0 ? <label className="field compact"><span>Destination room</span><select value={effectivePortalDestinationRoomId} onChange={(event) => setPortalDestinationRoomId(event.target.value)}>{activePortalDestinations.map((value) => <option key={value.id} value={value.id}>{value.name}</option>)}</select></label> : configuredWorldExit ? <span>This places or moves the dungeon exit to the game world.</span> : <span>This room needs an enabled dungeon exit or another active room.</span>}<span>Click room to place · Esc to finish</span></div> : null}
              {selectedPrefab && selectedPrefab.type !== "portal" ? <div className="dungeon-placement-banner" role="status"><strong>Placing {selectedPrefab.name}</strong><span>Click room to place one · Esc to cancel</span></div> : null}
              {placementTool ? <div className="dungeon-placement-banner" role="status"><strong>Placing {friendlyId(placementTool)}</strong><span>Click room to place one · Esc to cancel</span></div> : null}
              {selectedMobArchetype ? <div className="dungeon-placement-banner" role="status"><strong>Placing {friendlyId(selectedMobArchetype)}{simple ? " enemy" : ""}</strong><span>{simple ? "Click in the room where this enemy should appear." : placementEncounterId ? `${dungeon.encounters.find((value) => value.id === placementEncounterId)?.name ?? "Encounter"} · Wave ${placementWaveIndex}` : "First click creates an encounter, wave, boundary, leash, and anchor."}</span><span>Click room to place · Esc to finish</span></div> : null}
              {polygonDraft ? <div className="dungeon-placement-banner" role="status"><strong>Drawing {polygonDraft.kind === "zone" ? "a zone" : DRAW_SHAPE_LABELS[polygonDraft.kind]}</strong><span>Click dots to outline it. Enter or the gold first dot closes it. Esc cancels.</span><button type="button" disabled={polygonDraft.points.length < 3} onClick={finishPolygon}>Close Shape · {polygonDraft.points.length} points</button><button type="button" onClick={() => setPolygonDraft(null)}>Cancel shape</button></div> : null}
              <div className="canvas-frame">
              {<AuthoringCanvas room={room} dungeon={dungeon} prefabs={catalog.prefabs} viewZoom={authorViewZoom} viewPan={authorViewPan} debug={authorDebug} selection={selection} snapToGrid={snapToGrid} polygonDraft={polygonDraft} placementMode={Boolean(selectedPrefabId || selectedMobArchetype || polygonDraft || placementTool)} panMode={activeTool === "pan"} namingContext={namingContext} showAnchorLabels={authorDebug.anchors} authoring={authoring} anchorRoles={anchorRoleMap} selectedVertex={selectedVertex} onSelectVertex={setSelectedVertex} onMoveVertex={moveVertexOnCanvas} onSelect={selectOnCanvas} onPlace={placeAtPoint} onDragStart={() => { canvasDragHistoryRef.current = { snapshot: structuredClone(catalog), recorded: false }; }} onMoveEntity={moveCanvasEntity} onDragEnd={() => { canvasDragHistoryRef.current = null; }} onViewZoom={setAuthorViewZoom} onViewPan={setAuthorViewPan} />}
                <div className="canvas-tools" role="toolbar" aria-label="Canvas tools" aria-orientation="vertical">
                  {CANVAS_TOOLS.filter((definition) => !definition.needsShapes || authoring !== null).map((definition) => <button key={definition.tool} type="button" aria-label={definition.label} aria-pressed={activeTool === definition.tool} className={activeTool === definition.tool ? "active" : ""} disabled={!toolAvailable(definition.tool)} title={`${definition.label} (${definition.key}): ${definition.hint}`} onClick={(event) => { selectTool(definition.tool); event.currentTarget.blur(); }}><span className="canvas-tool-glyph" aria-hidden="true">{TOOL_GLYPHS[definition.tool]}</span><span className="canvas-tool-name" aria-hidden="true">{definition.short}</span><kbd aria-hidden="true">{definition.key}</kbd></button>)}
                </div>
                {activeTool === "wall" ? <div className="canvas-subtools" role="group" aria-label="Wall side">{(["back_wall", "left_wall", "right_wall"] as const).map((kind) => <button key={kind} type="button" aria-pressed={wallKind === kind} className={wallKind === kind ? "active" : ""} onClick={() => chooseWallKind(kind)}>{DRAW_SHAPE_LABELS[kind]}</button>)}</div> : null}
                <div className="canvas-top-right">
                  {authoring ? <label className="toggle canvas-snap" title="Snap drawn points and dragged items to a 5-unit grid. Hold Shift while dragging to switch snapping for that drag."><input type="checkbox" checked={snapToGrid} onChange={(event) => setSnapToGrid(event.target.checked)} /><span>Snap</span></label> : null}
                  {!simple ? <details className="dungeon-layers-menu"><summary>Layers</summary><div className="dungeon-debug-toggles">
                  {(Object.keys(authorDebug) as Array<keyof typeof authorDebug>).filter((key) => authoring || !SHAPE_DEBUG_KEYS.includes(key)).map((key) => { const values = authorDebug; const update = setAuthorDebug; return <label className="toggle" key={key}><input type="checkbox" checked={values[key]} onChange={(event) => update((value) => ({ ...value, [key]: event.target.checked }))} /><span>{key}</span></label>; })}
                  </div></details> : null}
                  <button type="button" className="canvas-help-btn" aria-label="Keyboard shortcuts" aria-pressed={shortcutsOpen} title="Keyboard shortcuts (?)" onClick={() => setShortcutsOpen((value) => !value)}>?</button>
                </div>
                <div className="canvas-zoom" role="group" aria-label="View controls">
                  <button type="button" aria-label="View zoom out" onClick={() => setAuthorViewZoom((value) => clamp(value - 0.1, 0.5, 3))}>−</button>
                  <span aria-live="off">{Math.round(authorViewZoom * 100)}%</span>
                  <button type="button" aria-label="View zoom in" onClick={() => setAuthorViewZoom((value) => clamp(value + 0.1, 0.5, 3))}>+</button>
                  <button type="button" title="Reset zoom and centre the room" onClick={() => { setAuthorViewZoom(1); setAuthorViewPan({ x: 0, y: 0 }); }}>Fit</button>
                  <button type="button" title="Give the canvas the whole window" onClick={() => setCanvasFocused((value) => !value)}>{canvasFocused ? "Exit focus" : "Focus canvas"}</button>
                </div>
                {showChecklist ? <section className="canvas-checklist" aria-label="Room setup checklist"><div className="canvas-checklist-head"><strong>Set up this room</strong><button type="button" aria-label="Hide checklist" title="Hide checklist" onClick={() => setChecklistHidden((value) => [...value, `${dungeon.id}:${room.id}`])}>×</button></div><ul>{checklist.map((item) => <li key={item.id} data-done={item.done}><span aria-hidden="true">{item.done ? "✓" : "○"}</span><button type="button" disabled={!props.writesAllowed || busy} onClick={() => runChecklistStep(item.id)}>{item.label}</button></li>)}</ul></section> : null}
                {shortcutsOpen ? <section className="canvas-shortcuts" role="dialog" aria-label="Keyboard shortcuts"><div className="canvas-shortcuts-head"><strong>Keyboard shortcuts</strong><button type="button" aria-label="Close shortcuts" onClick={() => setShortcutsOpen(false)}>×</button></div><dl>{SHORTCUT_SHEET.map((row) => <div key={row.keys}><dt><kbd>{row.keys}</kbd></dt><dd>{row.action}</dd></div>)}</dl></section> : null}
              </div>
            </section>
            <div className="interior-dock" data-testid="interiors-dock">
          <section ref={validationRef} className={`panel dungeon-validation ${issues.length > 0 ? "has-issues" : ""} ${validationOpen ? "open" : ""}`} aria-label="Dungeon validation issues">
            <div className="dungeon-validation-heading" onClick={() => setValidationOpen((value) => !value)}><PanelHeading title={simple ? "Map status" : "Validation"} meta={issues.length === 0 ? simple ? "No setup errors" : "Catalog valid" : `${issues.length} issue${issues.length === 1 ? "" : "s"}`} /></div>
            <dl className="dungeon-readiness-summary" aria-label="Dungeon readiness summary"><div><dt>{simple ? "Map file" : "Catalog"}</dt><dd>{issues.length === 0 ? simple ? "Ready to save" : "Valid and saveable" : simple ? "Fix the items below" : "Resolve validation issues"}</dd></div><div><dt>{simple ? "Play Test" : "Play Test logic"}</dt><dd>{hasOneActiveRoom ? oneRoomReadiness?.walkTestReady ? "Ready" : simple ? "Finish room setup" : "Needs combat flow setup" : simple ? "Check each room" : "Review multi-room logic"}</dd></div><div><dt>{simple ? "Game entrance" : "Live world binding"}</dt><dd>{oneRoomReadiness?.liveWorldBound ? simple ? "Connected" : "Ready" : simple ? "Needs final game hookup" : "Needs world entrance binding"}</dd></div></dl>
            {issues.length === 0 ? <p>{simple ? "No setup problems found." : "No catalog validation issues."}</p> : <div className="dungeon-validation-groups">{validationGroups.map(([category, grouped]) => <section key={category}><h3>{category} · {grouped.reduce((total, row) => total + row.count, 0)}</h3><ul>{grouped.map((row) => { const context = row.context; const body = <><strong>{context.label}</strong> {row.message}{row.count > 1 ? <em> ×{row.count}</em> : null}{!simple ? row.paths.map((path) => <code key={path} className="validation-path">{path}</code>) : null}</>; return <li key={`${category}:${context.label}:${row.message}`}>{context.dungeonId ? <button type="button" className="validation-row" title="Jump to this on the canvas" onClick={() => jumpToValidation(context)}>{body}</button> : <div className="validation-row">{body}</div>}</li>; })}</ul></section>)}</div>}
            {staleDraft ? <div className="dungeon-stale-draft" role="alertdialog" aria-label="Old unsaved draft"><p>An unsaved draft from {formatTime(staleDraft.savedAt)} was made on older interior data than what is saved now. Restoring it would bring back that older layout.</p><div className="dungeon-author-actions"><button type="button" className="primary" onClick={discardStaleDraft}>Discard old draft</button><button type="button" onClick={restoreStaleDraft}>Restore anyway</button></div></div> : null}
            {error ? <p className="connection-error" role="alert">{error}</p> : null}
          </section>
            </div>
          </div>

          <aside className="panel dungeon-inspector" data-testid="interiors-inspector" hidden={editorView !== "room"} data-collapsed={inspectorCollapsed}>
            <button type="button" className="interior-collapse-btn" aria-expanded={!inspectorCollapsed} aria-label={inspectorCollapsed ? "Show inspector" : "Hide inspector"} title={inspectorCollapsed ? "Show inspector" : "Hide inspector"} onClick={() => setInspectorCollapsed((value) => !value)}>{inspectorCollapsed ? "\u00AB" : "\u00BB"}</button>
            <div className="interior-inspector-inner">
            {roomFlowIssues.length > 0 ? <details className="dungeon-room-flow-issues"><summary>{roomFlowIssues.length} flow issue{roomFlowIssues.length === 1 ? "" : "s"} in this room</summary><ul>{roomFlowIssues.map((issue) => <li key={issue.id}><strong>{issue.severity.toUpperCase()}</strong> {issue.message}<button type="button" onClick={() => { if (issue.anchorId) setSelection({ kind: "anchor", id: issue.anchorId }); setEditorView("topology"); }}>Show in flow</button></li>)}</ul></details> : null}
            <PanelHeading title={simple ? "Room Tools" : "Room Inspector"} meta={simple ? room.active ? "Room is in use" : "Room is not in use" : room.retired ? "Retired" : room.spatialProfileId} />
            {simple ? <nav className="dungeon-simple-steps" aria-label="Basic dungeon steps"><button type="button" data-done={oneRoomReadiness?.roomArtPlaced} aria-current={simpleStep === "art" ? "step" : undefined} onClick={() => openSimpleStep("art")}>1 Room Look</button><button type="button" data-done={oneRoomReadiness?.mobBackedEncounter} aria-current={simpleStep === "mobs" ? "step" : undefined} onClick={() => openSimpleStep("mobs")}>2 Enemies</button><button type="button" data-done={Boolean(oneRoomReadiness?.chestObjectId)} aria-current={simpleStep === "chest" ? "step" : undefined} onClick={() => openSimpleStep("chest")}>3 Chest</button><button type="button" data-done={oneRoomReadiness?.walkTestReady} aria-current={simpleStep === "finish" ? "step" : undefined} onClick={() => openSimpleStep("finish")}>4 Finish Room</button><button type="button" aria-current={simpleStep === "test" ? "step" : undefined} onClick={() => openSimpleStep("test")}>5 Play Test</button></nav> : null}
            <div className="dungeon-inspector-tabs" role="tablist" aria-label="Room inspector tasks">{inspectorTabs.map((tab) => <button key={tab} type="button" role="tab" aria-selected={inspectorTab === tab} data-testid={`interiors-inspector-tab-${tab}`} data-done={simple ? (tab === "encounters" ? oneRoomReadiness?.mobBackedEncounter : tab === "rewards" ? Boolean(oneRoomReadiness?.chestObjectId) : tab === "room" ? oneRoomReadiness?.walkTestReady : undefined) : undefined} onClick={() => { setInspectorTab(tab); if (simple) { if (tab === "room") setSimpleStep("finish"); else if (tab === "encounters") setSimpleStep("mobs"); } }}>{!isDungeonKind ? interiorTabLabel(tab) : tab === "interior" ? "Interior" : tab === "room" ? "Room" : tab === "selected" ? "Selected" : tab === "portals" ? "Connections" : tab === "encounters" ? "Enemies" : tab === "rewards" ? "Chests & Loot" : tab === "shapes" ? "Floors & Walls" : tab === "advanced" ? "Geometry" : tab[0]!.toUpperCase() + tab.slice(1)}</button>)}</div>
            <div key={`${room.id}:${inspectorTab}`} className="dungeon-scroll dungeon-inspector-body" role="tabpanel">
              {inspectorTab === "interior" ? <>
                {isDungeonKind ? <TextField label="Interior name" value={dungeon.name} disabled={!props.writesAllowed || busy} onChange={(name) => updateDungeon((draft) => { draft.name = name; })} /> : <InteriorSpaceCard kind={spaceKind} dungeon={dungeon} writesAllowed={props.writesAllowed && !busy} onUpdate={updateDungeon} />}
                {spaceKind === "manor" ? <ManorExteriorCard exterior={effectiveManorExterior(catalog, authoringSources, dungeon.id)} previews={decorationPreviews} disabled={!props.writesAllowed || busy} onImport={(file) => { void importManorExterior(file); }} onScale={(exteriorScale) => { const current = effectiveManorExterior(catalog, authoringSources, dungeon.id); if (current) updateCatalog((draft) => setManorExterior(draft, authoringSources, dungeon.id, { ...current, exteriorScale })); }} onPrice={(skinPriceGlimmer) => { const current = effectiveManorExterior(catalog, authoringSources, dungeon.id); if (current) updateCatalog((draft) => setManorExterior(draft, authoringSources, dungeon.id, { ...current, skinPriceGlimmer })); }} /> : null}
                {isDungeonKind && !simple ? <DungeonSettings onImport={importDungeonArt} catalog={catalog} dungeon={dungeon} writesAllowed={props.writesAllowed && !busy} onUpdate={updateDungeon} onUpdateCatalog={updateCatalog} /> : null}
                {isDungeonKind && simple ? <DungeonEntranceCard onImport={importDungeonArt} catalog={catalog} dungeon={dungeon} writesAllowed={props.writesAllowed && !busy} onUpdateCatalog={updateCatalog} /> : null}
                {isDungeonKind ? <details className="interior-live-test"><summary>How to test this dungeon in the game</summary>{isDungeonKind ? <section className="panel dungeon-live-checklist" aria-label="Saved game test checklist"><h3>Test this saved dungeon in the game</h3><p>Play Test runs the game’s movement, combat, AI and dungeon systems in an isolated sandbox. A saved game run verifies world entry, networking and durable reward delivery.</p><ol>{dungeon.id !== "cistern_warrens" && !catalog.entrances.some((entrance) => entrance.dungeonId === dungeon.id && !entrance.retired) && <li>This template is not placed in the world. Duplicate it, then open Dungeon settings → Game entrance → Add entrance and choose the test location before saving.</li>}<li>Save to Worktree, then open this feature’s Game launcher on its latest saved version.</li><li>{dungeon.id === "cistern_warrens" ? "Sign in as a disposable developer player and use a Cistern Warrens entrance at its bound structure." : `Sign in as a disposable developer player. Open World Map → DEV → Spawning → Dungeon entrances, choose “${dungeon.name}”, and place an entrance on eligible land near your player.`}</li><li>Select the entrance and choose Enter. Fight each wave; damage the miniboss below the add threshold and defeat its adds.</li><li>Check that the chest stays hidden until the final fight clears. Open it once, reconnect, and confirm the inventory reward remains and cannot be claimed twice.</li><li>Gather the resources. Retry the same run to check stable random positions; leave/reset and enter a new run to check a fresh layout.</li></ol><p>{dirty ? "Unsaved changes: save before the game test." : `Saved catalog revision ${savedCatalog?.catalogRevision}. The game must be running this saved version.`}</p></section> : null}</details> : null}
              </> : null}
              {inspectorTab === "encounters" ? <DungeonMobBatchTools catalog={catalog} dungeon={dungeon} room={room} disabled={!props.writesAllowed || busy} onUpdate={updateCatalog} /> : null}
              {inspectorTab === "rewards" ? <DungeonChestTools onImport={importDungeonArt} catalog={catalog} dungeon={dungeon} room={room} disabled={!props.writesAllowed || busy} onUpdate={updateCatalog} /> : null}
              {inspectorTab === "logic" || (simple && simpleStep === "finish") ? <DungeonCompletionTools catalog={catalog} dungeon={dungeon} room={room} disabled={!props.writesAllowed || busy} onUpdate={updateCatalog} /> : null}
              {inspectorTab === "room" ? <><TextField label="Room name" value={room.name} onChange={(name) => updateRoom((draft) => { draft.name = name; })} />{spaceKind === "manor" ? <ManorFloorArtField room={room} catalog={catalog} previews={decorationPreviews} disabled={!props.writesAllowed || busy} onImport={(file) => { void importRoomFloorArt(file); }} /> : null}<label className="toggle"><input type="checkbox" checked={room.active} onChange={(event) => updateRoom((draft) => { draft.active = event.target.checked; })} /><span>{simple ? "Use this room in the dungeon" : "Active runtime room"}</span></label>{hasOneActiveRoom && oneRoomReadiness ? <section ref={quickSetupRef} tabIndex={-1} className={`dungeon-one-room-setup ${oneRoomReadiness.walkTestReady ? "ready" : ""}`} aria-label={simple ? "Finish this room" : "One-room quick setup"}><h3>{simple ? "Finish this room" : "One-room quick setup"}</h3><ol><li data-ready={oneRoomReadiness.roomArtPlaced}>Place floor or room art</li><li data-ready={oneRoomReadiness.mobBackedEncounter}>Place one or more {simple ? "enemies" : "mobs"}</li><li data-ready={Boolean(oneRoomReadiness.chestObjectId)}>Place a Treasure Chest</li></ol><button type="button" className="primary" disabled={!props.writesAllowed || busy || oneRoomReadiness.missingPrerequisites.length > 0 || oneRoomReadiness.walkTestReady} onClick={wireOneRoomFlow}>{simple ? oneRoomReadiness.walkTestReady ? "Combat and chest are set up" : "Set up combat and chest" : oneRoomReadiness.walkTestReady ? "One-room combat flow wired" : "Wire one-room combat flow"}</button>{oneRoomReadiness.missingPrerequisites.length > 0 ? <p>{simple ? "First: " : "Before wiring: "}{oneRoomReadiness.missingPrerequisites.map((value) => simple ? value.replace("mobs", "enemies") : value).join(" · ")}.</p> : oneRoomReadiness.walkTestReady ? <ul>{simple ? <><li>Enemies appear when the player enters.</li><li>The exit stays closed during the fight.</li><li>The chest opens after the fight.</li><li>Finishing the fight completes the dungeon.</li></> : <><li>Room entry starts combat.</li><li>The world exit is locked during combat.</li><li>The chest unlocks when combat clears.</li><li>The dungeon completes when the encounter completes.</li></>}</ul> : <p>{simple ? "Everything is placed. Set up the fight and chest." : "Ready to wire the combat flow."}</p>} {!oneRoomReadiness.lootRuntimeReady ? <p className="dungeon-deployment-note">{simple ? "Chest rewards still need final game hookup." : oneRoomReadiness.lootRewardConfigured ? "Loot table selected; durable runtime hookup still required." : "Loot reward needs a reward table and runtime hookup."}</p> : null}</section> : null}{room.active && room.id !== dungeon.entrance.roomId && !dungeon.portals.some((portal) => !portal.retired && portal.source.kind === "room" && portal.source.roomId === room.id && portal.destination.kind === "room") ? <p className="dungeon-authority-note">This active room has no room connection. Open {"Connections"} to connect it.</p> : null}{!simple ? <p className="dungeon-profile">{movementProfileText(spaceKind)}</p> : null}</> : null}
              {inspectorTab === "selected" ? <>{selectionSummary ? <div className="selection-header" aria-label="Selected item"><span className="selection-glyph" aria-hidden="true">{selectionSummary.glyph}</span><div><strong>{selectionSummary.name}</strong><small>{selectionSummary.type}</small></div></div> : <p className="inspector-empty">Select something on the canvas or pick a tool.</p>}<div className="dungeon-author-actions"><button type="button" disabled={!selection} onClick={duplicateSelection}>Duplicate selected</button><button type="button" disabled={!selection} onClick={retireSelection}>Delete selected</button></div>{selection?.kind === "anchor" && authoring ? <AnchorInspector view={catalog} sources={authoringSources} spaceId={dungeon.id} room={room} authoring={authoring} selection={selection} writesAllowed={props.writesAllowed && !busy} snapToGrid={snapToGrid} selectedVertex={selectedVertex} debug={authorDebug} onDebug={(key) => setAuthorDebug((value) => ({ ...value, [key]: !value[key] }))} onSnap={setSnapToGrid} onSelect={(value) => { setSelection(value as EditorSelection); setSelectedVertex(null); }} onSelectVertex={setSelectedVertex} onEdit={updateCatalog} onError={(message) => queueMicrotask(() => setError(message))} onRevealAnchor={(roomId, anchorId) => { setSelectedRoomId(roomId); setSelection({ kind: "anchor", id: anchorId }); setSelectedVertex(null); }} anchorId={selection.id} /> : null}<EntitySection simple={simple} room={room} dungeon={dungeon} prefabs={catalog.prefabs} selection={selection?.kind === "anchor" && authoring ? null : selection} onSelect={setSelection} onArmPlacement={(tool) => { setPlacementTool(tool); setSelectedPrefabId(null); setSelectedMobArchetype(null); setPolygonDraft(null); }} onUpdateRoom={updateRoom} onUpdateDungeon={updateDungeon} onUpdateCatalog={updateCatalog} /></> : null}
              {inspectorTab === "shapes" && authoring ? <ShapeTools view={catalog} sources={authoringSources} spaceId={dungeon.id} room={room} authoring={authoring} selection={selection} writesAllowed={props.writesAllowed && !busy} snapToGrid={snapToGrid} selectedVertex={selectedVertex} debug={authorDebug} onDebug={(key) => setAuthorDebug((value) => ({ ...value, [key]: !value[key] }))} onSnap={setSnapToGrid} onSelect={(value) => { setSelection(value as EditorSelection); setSelectedVertex(null); }} onSelectVertex={setSelectedVertex} onEdit={updateCatalog} onError={(message) => queueMicrotask(() => setError(message))} onRevealAnchor={(roomId, anchorId) => { setSelectedRoomId(roomId); setSelection({ kind: "anchor", id: anchorId }); setSelectedVertex(null); }} /> : null}
              {inspectorTab === "planters" && isGreenhouse ? (() => {
                const pot = catalog.prefabs.find((prefab) => prefab.id === plantersPotPrefabId(authoringSources, dungeon.id)) as ViewPrefab | undefined;
                const tank = catalog.prefabs.find((prefab) => prefab.id === GREENHOUSE_WATER_TANK_PREFAB_ID) as ViewPrefab | undefined;
                if (!pot) return <p className="empty-copy">This greenhouse has no Farm Plot template in the library.</p>;
                const stored = interiorBase?.spaces.find((space) => space.id === dungeon.id) ?? seeds[dungeon.id];
                return <GreenhousePlantersPanel pot={pot} tank={tank ?? null} stageArt={effectiveStageArt(catalog, authoringSources, dungeon.id)} capacity={stored?.modules?.planters?.capacity ?? null} assets={runtimeAssets} disabled={!props.writesAllowed || busy}
                  onEditPrefab={(prefabId, edit) => updateCatalog((draft) => { const target = draft.prefabs.find((prefab) => prefab.id === prefabId); if (target) edit(target as ViewPrefab); })}
                  onEditStageArt={(edit) => updateCatalog((draft) => editStageArt(draft, authoringSources, dungeon.id, edit))}
                  onReplacePng={replaceRuntimePng} />;
              })() : null}
              {inspectorTab === "portals" ? <PortalSection simple={simple} dungeon={dungeon} room={room} prefabs={catalog.prefabs} onUpdateDungeon={updateDungeon} onError={setError} /> : null}
              {inspectorTab === "encounters" ? <EncounterEditor simple={simple} dungeon={dungeon} room={room} rewardTableIds={catalog.rewardTableIds} bossTemplateIds={catalog.bossTemplateIds} placementEncounterId={placementEncounterId} placementWaveIndex={placementWaveIndex} onPlacementTarget={(encounterId, waveIndex) => { setPlacementEncounterId(encounterId); setPlacementWaveIndex(waveIndex); setSelectedPrefabId(null); setPolygonDraft(null); setPlacementTool(null); setLibraryCategory("mobs"); setLibrarySearch(""); setAddAreaOpen(true); if (simple) setSimpleStep("mobs"); }} onUpdateDungeon={updateDungeon} /> : null}
              {inspectorTab === "resources" ? <ResourceAuthoringPanel prefabs={catalog.prefabs} room={room} resourceType={resourceType} writesAllowed={props.writesAllowed && !busy} onResourceTypeChange={setResourceType} onArmPlacement={(tool) => { setPlacementTool(tool); setSelectedPrefabId(null); setSelectedMobArchetype(null); setPolygonDraft(null); }} onUpdateRoom={updateRoom} /> : null}
              {inspectorTab === "rewards" && !simple ? <><RewardTableEditor catalog={catalog} writesAllowed={props.writesAllowed && !busy} onUpdateCatalog={updateCatalog} /><BossLibraryPanel catalog={catalog} dungeon={dungeon} appearanceCatalog={bossAppearanceCatalog} writesAllowed={props.writesAllowed && !busy} onUpdateCatalog={updateCatalog} /><PortalGateEditor dungeon={dungeon} writesAllowed={props.writesAllowed && !busy} onUpdateDungeon={updateDungeon} /></> : null}
              {inspectorTab === "logic" ? <TriggerRecipeEditor dungeon={dungeon} room={room} rewardTableIds={catalog.rewardTableIds} onUpdateDungeon={updateDungeon} /> : null}
              {inspectorTab === "advanced" ? <><div className="field-grid"><NumberField label="Width" unit="px" value={room.width} min={100} onChange={(width) => updateRoom((draft) => { draft.width = width; draft.camera.center.x = width / 2; })} /><NumberField label="Height" unit="px" value={room.height} min={100} onChange={(height) => updateRoom((draft) => { draft.height = height; draft.camera.center.y = height / 2; })} /></div><div className="field-grid"><NumberField label="Default zoom" value={room.camera.defaultZoom} step={0.1} onChange={(defaultZoom) => updateRoom((draft) => { draft.camera.defaultZoom = defaultZoom; })} /><NumberField label="Min zoom" value={room.camera.minZoom} step={0.1} onChange={(minZoom) => updateRoom((draft) => { draft.camera.minZoom = minZoom; })} /><NumberField label="Max zoom" value={room.camera.maxZoom} step={0.1} onChange={(maxZoom) => updateRoom((draft) => { draft.camera.maxZoom = maxZoom; })} /></div><TextField label="Environment ID" value={room.environment.environmentId} onChange={(environmentId) => updateRoom((draft) => { draft.environment.environmentId = environmentId; })} /><TextField label="Visual treatment" value={room.environment.visualTreatmentId ?? ""} onChange={(value) => updateRoom((draft) => { draft.environment.visualTreatmentId = value || null; })} /><TextField label="Music asset" value={room.environment.musicAssetKey ?? ""} onChange={(value) => updateRoom((draft) => { draft.environment.musicAssetKey = value || null; })} /><TextField label="Ambience asset" value={room.environment.ambienceAssetKey ?? ""} onChange={(value) => updateRoom((draft) => { draft.environment.ambienceAssetKey = value || null; })} /><label className="field compact"><span>Active layer</span><select value={layerId} onChange={(event) => setLayerId(event.target.value as LayerId)}>{LAYERS.map((value) => <option key={value} value={value}>{friendlyLayer(value)}</option>)}</select></label><label className="toggle"><input type="checkbox" checked={snapToGrid} onChange={(event) => setSnapToGrid(event.target.checked)} /><span>Snap to 25-unit grid</span></label><div className="dungeon-author-actions"><button type="button" onClick={() => { setPolygonDraft({ kind: "collider", points: [] }); setSelectedPrefabId(null); setSelectedMobArchetype(null); setPlacementTool(null); }}>Polygon collider</button><button type="button" onClick={() => { setPolygonDraft({ kind: "zone", points: [] }); setSelectedPrefabId(null); setSelectedMobArchetype(null); setPlacementTool(null); }}>Polygon zone</button>{polygonDraft ? <button type="button" disabled={polygonDraft.points.length < 3} onClick={finishPolygon}>Finish polygon · {polygonDraft.points.length} points</button> : null}</div><button type="button" className="danger wide" disabled={!props.writesAllowed || dungeon.rooms.length <= 1} onClick={retireOrRemoveRoom}>{savedRoom ? "Retire Room" : "Remove Draft Room"}</button></> : null}
            </div>
            </div>
          </aside>
        </div>}
        <nav className="dungeon-mobile-actions" aria-label="Dungeon quick actions"><button type="button" onClick={() => { setEditorView("room"); setMode("author"); if (simple && simpleStep === "test") setSimpleStep("art"); }}>{simple ? "Build" : "Tool"}</button><button type="button" aria-controls="dungeon-prefab-library" aria-expanded={addAreaOpen} onClick={() => { setEditorView("room"); setMode("author"); if (simple && simpleStep === "test") setSimpleStep("art"); setAddAreaOpen(true); requestAnimationFrame(() => { addAreaRef.current?.focus(); addAreaRef.current?.scrollIntoView?.({ behavior: "smooth", block: "start" }); }); }}>Add{selectedPrefabId ? ` · ${catalog.prefabs.find((value) => value.id === selectedPrefabId)?.name ?? (simple ? "piece" : "prefab")}` : ""}</button><button type="button" onClick={() => { clearPlacementTools(); setAddAreaOpen(false); setEditorView("room"); setMode("author"); if (simple && simpleStep === "test") setSimpleStep("art"); }}>Select</button><button type="button" onClick={() => { clearPlacementTools(); setPlayKind("full"); setMode("walk"); if (simple) setSimpleStep("test"); }}>{simple ? "Play" : "Test"}</button><button type="button" disabled={!dirty || busy} onClick={() => void save()}>Save</button></nav>
      </section>
    );
  }
);

function AuthoringCanvas(props: { room: DungeonRoomDefinition; dungeon: DungeonDefinition; prefabs: DungeonCatalog["prefabs"]; viewZoom: number; viewPan: IndoorPoint; debug: Record<string, boolean>; selection: EditorSelection; snapToGrid: boolean; polygonDraft: PolygonDraft; placementMode: boolean; panMode?: boolean; namingContext: NamingContext; showAnchorLabels?: boolean; authoring?: RoomAuthoring | null; anchorRoles?: Record<string, string>; selectedVertex?: number | null; onSelectVertex?(index: number | null): void; onMoveVertex?(index: number, point: IndoorPoint): void; onSelect(value: EditorSelection): void; onPlace(point: IndoorPoint): void; onDragStart(): void; onMoveEntity(entity: CanvasEntitySelection, point: IndoorPoint): void; onDragEnd(): void; onViewZoom(value: number): void; onViewPan(value: IndoorPoint): void }) {
  const canvasRef = useRef<SVGSVGElement>(null);
  const dragRef = useRef<{ entity: CanvasEntitySelection; offset: IndoorPoint } | null>(null);
  const panStartRef = useRef<{ startX: number; startY: number; origin: IndoorPoint } | null>(null);
  const vertexDragRef = useRef<number | null>(null);
  const [hovered, setHovered] = useState<CanvasEntitySelection | null>(null);
  const [pxPerUnit, setPxPerUnit] = useState(0.6);
  useEffect(() => {
    const svg = canvasRef.current;
    if (!svg) return;
    const measure = (): void => { const width = svg.getBoundingClientRect().width; if (width > 0) setPxPerUnit(width / props.room.width); };
    measure();
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(measure) : null;
    observer?.observe(svg);
    return () => observer?.disconnect();
  }, [props.room.width, props.viewZoom]);
  const hover = (entity: CanvasEntitySelection) => ({ onPointerEnter: () => setHovered(entity), onPointerLeave: () => setHovered((current) => current?.kind === entity.kind && current.id === entity.id ? null : current) });
  const labelFontSize = clamp(12 / pxPerUnit, 10, 90);
  const canvasLabels = (() => {
    const readable = pxPerUnit >= 0.4;
    const names = anchorNames(props.namingContext);
    const forced = new Map<string, number>();
    const extras: LabelCandidate[] = [];
    for (const [ref, priority] of [[props.selection, 100], [hovered, 90]] as const) {
      if (!ref) continue;
      const anchorId = ref.kind === "anchor" ? ref.id : ref.kind === "object" ? props.room.objects.find((value) => value.id === ref.id)?.anchorId : ref.kind === "mob" ? props.room.mobs.find((value) => value.id === ref.id)?.anchorId : undefined;
      if (anchorId) { forced.set(anchorId, Math.max(forced.get(anchorId) ?? 0, priority)); continue; }
      const point = selectionPoint(props.room, props.authoring, ref);
      const summary = describeSelection(props.namingContext, ref);
      if (point && summary) extras.push({ key: `focus:${ref.kind}:${ref.id}`, text: summary.type === "Room art" || summary.type === "Decoration" ? summary.name : summary.type, x: point.x, y: point.y, priority });
    }
    const anchorLabels = props.room.anchors.filter((value) => !value.retired).flatMap((anchor): LabelCandidate[] => {
      const text = names.get(anchor.id);
      const priority = forced.get(anchor.id);
      if (!text || (priority === undefined && !(readable && props.showAnchorLabels !== false))) return [];
      return [{ key: `anchor:${anchor.id}`, text, x: anchor.x, y: anchor.y, priority: priority ?? (/^(Spawn|Exit|Door)/u.test(text) ? 50 : 30) }];
    });
    return layoutLabels([...extras, ...anchorLabels], { fontSize: labelFontSize, roomWidth: props.room.width, roomHeight: props.room.height });
  })();
  const selectedVertices = props.selection && SHAPE_SELECTION_KINDS.has(props.selection.kind) ? shapeVertices(props.room, props.authoring ?? EMPTY_AUTHORING, props.selection as ShapeRef) : null;
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const handleWheel = (event: globalThis.WheelEvent): void => {
      event.preventDefault();
      props.onViewZoom(clamp(props.viewZoom - event.deltaY * 0.001, 0.5, 3));
    };
    canvas.addEventListener("wheel", handleWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", handleWheel);
  }, [props.viewZoom, props.onViewZoom]);
  const point = (svg: SVGSVGElement, event: Pick<ReactPointerEvent<SVGElement>, "clientX" | "clientY">): IndoorPoint => {
    const bounds = svg.getBoundingClientRect();
    return { x: clamp((event.clientX - bounds.left) / bounds.width * props.room.width, 0, props.room.width), y: clamp((event.clientY - bounds.top) / bounds.height * props.room.height, 0, props.room.height) };
  };
  const entityOrigin = (entity: CanvasEntitySelection): IndoorPoint | null => {
    if (entity.kind === "floor" || entity.kind === "wall" || entity.kind === "clickArea") return shapeVertices(props.room, props.authoring ?? EMPTY_AUTHORING, entity as ShapeRef)?.[0] ?? null;
    if (entity.kind === "anchor") return props.room.anchors.find((value) => value.id === entity.id) ?? null;
    if (entity.kind === "object") {
      const object = props.room.objects.find((value) => value.id === entity.id);
      return props.room.anchors.find((value) => value.id === object?.anchorId) ?? null;
    }
    if (entity.kind === "mob") {
      const mob = props.room.mobs.find((value) => value.id === entity.id);
      return props.room.anchors.find((value) => value.id === mob?.anchorId) ?? null;
    }
    if (entity.kind === "placement") return Object.values(props.room.layers).flat().find((value) => value.id === entity.id) ?? null;
    const shape = entity.kind === "resourceZone"
      ? props.room.resourceSpawnZones?.find((value) => value.id === entity.id)?.shape
      : (entity.kind === "collider" ? props.room.colliders : props.room.zones).find((value) => value.id === entity.id);
    if (!shape) return null;
    return shape.kind === "rectangle" ? shape : shape.points[0] ?? null;
  };
  const clampedDragPoint = (entity: CanvasEntitySelection, rawPoint: IndoorPoint, snap: boolean): IndoorPoint => {
    const snapped = snapPoint(rawPoint, snap);
    const sized = entity.kind === "placement"
      ? Object.values(props.room.layers).flat().find((value) => value.id === entity.id)
      : entity.kind === "collider"
        ? props.room.colliders.find((value) => value.id === entity.id && value.kind === "rectangle")
        : entity.kind === "zone"
          ? props.room.zones.find((value) => value.id === entity.id && value.kind === "rectangle")
          : entity.kind === "resourceZone"
            ? props.room.resourceSpawnZones?.find((value) => value.id === entity.id)?.shape
          : undefined;
    const width = sized && "width" in sized ? sized.width : 0;
    const height = sized && "height" in sized ? sized.height : 0;
    if (entity.kind === "resourceZone" && sized && "points" in sized && sized.points.length > 0) {
      const first = sized.points[0]!;
      const minX = Math.min(...sized.points.map((value) => value.x));
      const maxX = Math.max(...sized.points.map((value) => value.x));
      const minY = Math.min(...sized.points.map((value) => value.y));
      const maxY = Math.max(...sized.points.map((value) => value.y));
      return {
        x: first.x + clamp(snapped.x - first.x, -minX, props.room.width - maxX),
        y: first.y + clamp(snapped.y - first.y, -minY, props.room.height - maxY)
      };
    }
    return { x: clamp(snapped.x, 0, Math.max(0, props.room.width - width)), y: clamp(snapped.y, 0, Math.max(0, props.room.height - height)) };
  };
  const startEntityDrag = (event: ReactPointerEvent<SVGElement>, entity: CanvasEntitySelection): void => {
    if (props.placementMode || props.panMode) return;
    event.stopPropagation();
    props.onSelect(entity);
    const origin = entityOrigin(entity);
    const svg = event.currentTarget.ownerSVGElement;
    if (!origin || !svg) return;
    svg.setPointerCapture(event.pointerId);
    const pointer = point(svg, event);
    dragRef.current = { entity, offset: { x: pointer.x - origin.x, y: pointer.y - origin.y } };
    props.onDragStart();
  };
  const finishGesture = (): void => {
    if (dragRef.current || vertexDragRef.current !== null) props.onDragEnd();
    dragRef.current = null;
    vertexDragRef.current = null;
    panStartRef.current = null;
  };
  return <div className="dungeon-stage"><svg ref={canvasRef} aria-label={`${props.room.name} authoring canvas`} viewBox={`0 0 ${props.room.width} ${props.room.height}`} style={{ cursor: props.panMode ? "grab" : props.placementMode ? "crosshair" : undefined, aspectRatio: `${props.room.width} / ${props.room.height}`, transform: `translate(${props.viewPan.x}px, ${props.viewPan.y}px) scale(${props.viewZoom})` }} onPointerDown={(event) => { if (props.placementMode && !props.panMode) { event.preventDefault(); props.onPlace(point(event.currentTarget, event)); return; } event.currentTarget.setPointerCapture(event.pointerId); panStartRef.current = { startX: event.clientX, startY: event.clientY, origin: props.viewPan }; }} onPointerMove={(event) => { if (vertexDragRef.current !== null) { props.onMoveVertex?.(vertexDragRef.current, snapPoint(point(event.currentTarget, event), props.snapToGrid !== event.shiftKey)); } else if (dragRef.current) { const pointer = point(event.currentTarget, event); props.onMoveEntity(dragRef.current.entity, clampedDragPoint(dragRef.current.entity, { x: pointer.x - dragRef.current.offset.x, y: pointer.y - dragRef.current.offset.y }, props.snapToGrid !== event.shiftKey)); } else if (panStartRef.current) { props.onViewPan({ x: panStartRef.current.origin.x + event.clientX - panStartRef.current.startX, y: panStartRef.current.origin.y + event.clientY - panStartRef.current.startY }); } }} onPointerUp={finishGesture} onPointerCancel={finishGesture}>
    <defs><pattern id="dungeon-grid" width="25" height="25" patternUnits="userSpaceOnUse"><path d="M 25 0 L 0 0 0 25" fill="none" stroke="#ffffff" strokeOpacity="0.08" strokeWidth="1" /></pattern></defs>
    <rect width={props.room.width} height={props.room.height} fill={props.dungeon.environment.floorColor} />
    {props.snapToGrid ? <rect width={props.room.width} height={props.room.height} fill="url(#dungeon-grid)" /> : null}
    {Object.entries(props.room.layers).flatMap(([layer, placements]) => placements.filter((value) => !value.retired).sort((a, b) => a.zIndex - b.zIndex).map((value) => { const prefab = props.prefabs.find((candidate) => candidate.id === value.prefabId); return prefab ? <SvgPrefabArt key={`${layer}:${value.id}`} prefab={prefab} x={value.x} y={value.y} transform={value} selected={props.selection?.kind === "placement" && props.selection.id === value.id} placementMode={Boolean(props.placementMode || props.panMode)} onPointerDown={prefab.type === "surface" ? () => props.onSelect({ kind: "placement", id: value.id }) : (event) => startEntityDrag(event, { kind: "placement", id: value.id })} /> : <rect key={`${layer}:${value.id}`} x={value.x} y={value.y} width={value.width} height={value.height} className="dungeon-invalid-reference" />; }))}
    {props.debug.zones && props.room.zones.filter((value) => !value.retired).map((value) => { const selected = props.selection?.kind === "zone" && props.selection.id === value.id; return value.kind === "rectangle" ? <rect key={value.id} x={value.x} y={value.y} width={value.width} height={value.height} className={`dungeon-zone ${selected ? "selected" : ""}`} onPointerDown={(event) => startEntityDrag(event, { kind: "zone", id: value.id })} /> : <polygon key={value.id} points={value.points.map((point) => `${point.x},${point.y}`).join(" ")} className={`dungeon-zone ${selected ? "selected" : ""}`} onPointerDown={(event) => { if (props.placementMode || props.panMode) return; event.stopPropagation(); props.onSelect({ kind: "zone", id: value.id }); }} />; })}
    {props.debug.colliders && props.room.colliders.filter((value) => !value.retired).map((value) => { const selected = props.selection?.kind === "collider" && props.selection.id === value.id; return value.kind === "rectangle" ? <rect key={value.id} x={value.x} y={value.y} width={value.width} height={value.height} className={`dungeon-collider ${selected ? "selected" : ""}`} onPointerDown={(event) => startEntityDrag(event, { kind: "collider", id: value.id })} /> : <polygon key={value.id} points={value.points.map((point) => `${point.x},${point.y}`).join(" ")} className={`dungeon-collider ${selected ? "selected" : ""}`} onPointerDown={(event) => { if (props.placementMode || props.panMode) return; event.stopPropagation(); props.onSelect({ kind: "collider", id: value.id }); }} />; })}
    {props.authoring && props.debug.floors && props.authoring.floors.filter((value) => !value.retired).map((value) => <polygon key={`floor:${value.id}`} points={value.polygon.map((point) => `${point.x},${point.y}`).join(" ")} className={`interior-floor ${props.selection?.kind === "floor" && props.selection.id === value.id ? "selected" : ""}`} {...hover({ kind: "floor", id: value.id })} onPointerDown={(event) => startEntityDrag(event, { kind: "floor", id: value.id })} />)}
    {props.authoring && props.debug.walls && props.authoring.walls.filter((value) => !value.retired).map((value) => <polygon key={`wall:${value.id}`} points={value.roomPolygon.map((point) => `${point.x},${point.y}`).join(" ")} className={`interior-wall ${value.kind} ${props.selection?.kind === "wall" && props.selection.id === value.id ? "selected" : ""}`} {...hover({ kind: "wall", id: value.id })} onPointerDown={(event) => startEntityDrag(event, { kind: "wall", id: value.id })} />)}
    {props.authoring && props.debug.clickAreas && props.authoring.clickAreas.filter((value) => !value.retired).map((value) => <polygon key={`click:${value.id}`} points={value.polygon.map((point) => `${point.x},${point.y}`).join(" ")} className={`interior-click-area ${props.selection?.kind === "clickArea" && props.selection.id === value.id ? "selected" : ""}`} {...hover({ kind: "clickArea", id: value.id })} onPointerDown={(event) => startEntityDrag(event, { kind: "clickArea", id: value.id })} />)}
    {props.debug.anchors && props.room.anchors.filter((value) => !value.retired).map((value) => <g key={value.id} transform={`translate(${value.x} ${value.y})`} className={`${props.selection?.kind === "anchor" && props.selection.id === value.id ? "selected" : ""} role-${props.anchorRoles?.[value.id] ?? "point"}`.trim()} {...hover({ kind: "anchor", id: value.id })} onPointerDown={(event) => startEntityDrag(event, { kind: "anchor", id: value.id })}><circle r="13" /></g>)}
    {props.room.objects.filter((value) => !value.retired && (props.debug.portals || value.type !== "portal")).map((value) => { const anchor = props.room.anchors.find((candidate) => candidate.id === value.anchorId); const prefab = props.prefabs.find((candidate) => candidate.id === value.prefabId); const selected = props.selection?.kind === "object" && props.selection.id === value.id; return anchor && prefab ? <SvgPrefabArt key={value.id} prefab={prefab} x={anchor.x - prefab.defaultWidth * prefab.pivotX} y={anchor.y - prefab.defaultHeight * prefab.pivotY} transform={{ ...value, width: prefab.defaultWidth, height: prefab.defaultHeight }} selected={selected} placementMode={Boolean(props.placementMode || props.panMode)} hover={hover({ kind: "object", id: value.id })} onPointerDown={(event) => startEntityDrag(event, { kind: "object", id: value.id })} /> : anchor ? <g key={value.id} transform={`translate(${anchor.x} ${anchor.y})`} className={`dungeon-no-art ${selected ? "selected" : ""}`} {...hover({ kind: "object", id: value.id })} onPointerDown={(event) => startEntityDrag(event, { kind: "object", id: value.id })}><rect x="-16" y="-16" width="32" height="32" rx="4" /><text x="21" y="5">{value.name}</text></g> : null; })}
    {props.room.mobs.filter((value) => !value.retired).map((value) => { const anchor = props.room.anchors.find((candidate) => candidate.id === value.anchorId); return anchor ? <g key={value.id} transform={`translate(${anchor.x} ${anchor.y}) scale(${value.visualScale})`} className={`dungeon-mob-marker ${props.selection?.kind === "mob" && props.selection.id === value.id ? "selected" : ""}`} {...hover({ kind: "mob", id: value.id })} onPointerDown={(event) => startEntityDrag(event, { kind: "mob", id: value.id })}><circle r="20" /></g> : null; })}
    {(props.room.resourceSpawnZones ?? []).filter((value) => !value.retired).map((value) => { const shape = value.shape; const selected = props.selection?.kind === "resourceZone" && props.selection.id === value.id; return shape.kind === "rectangle" ? <rect key={`resource-zone:${value.id}`} x={shape.x} y={shape.y} width={shape.width} height={shape.height} className={`dungeon-resource-zone ${selected ? "selected" : ""}`} onPointerDown={(event) => startEntityDrag(event, { kind: "resourceZone", id: value.id })} /> : <polygon key={`resource-zone:${value.id}`} points={shape.points.map((point) => `${point.x},${point.y}`).join(" ")} className={`dungeon-resource-zone ${selected ? "selected" : ""}`} onPointerDown={(event) => startEntityDrag(event, { kind: "resourceZone", id: value.id })} />; })}
    {(props.room.resourceNodes ?? []).filter((value) => !value.retired).map((value) => { const anchor = props.room.anchors.find((candidate) => candidate.id === value.anchorId); return anchor ? <g key={`resource:${value.id}`} transform={`translate(${anchor.x} ${anchor.y})`} className="dungeon-resource-marker" {...hover({ kind: "anchor", id: anchor.id })} onPointerDown={(event) => startEntityDrag(event, { kind: "anchor", id: anchor.id })}><circle r="15" /></g> : null; })}
    <g className="canvas-labels" aria-hidden="true">{canvasLabels.map((label) => <text key={label.key} x={label.tx} y={label.ty} textAnchor={label.textAnchor} style={{ fontSize: labelFontSize, strokeWidth: labelFontSize / 3 }}>{label.text}</text>)}</g>
    {props.polygonDraft ? <><polyline points={props.polygonDraft.points.map((value) => `${value.x},${value.y}`).join(" ")} className="dungeon-polygon-draft" />{props.polygonDraft.points.map((value, index) => <circle key={`draft:${index}`} cx={value.x} cy={value.y} r={index === 0 && props.polygonDraft!.points.length >= 3 ? 16 : 9} className={index === 0 ? "polygon-first-vertex" : "polygon-draft-vertex"} />)}</> : null}
    {selectedVertices && !props.placementMode ? selectedVertices.map((value, index) => <circle key={`vertex:${index}`} cx={value.x} cy={value.y} r="9" className={`polygon-vertex ${props.selectedVertex === index ? "selected" : ""}`} onPointerDown={(event) => { event.stopPropagation(); event.currentTarget.ownerSVGElement?.setPointerCapture(event.pointerId); vertexDragRef.current = index; props.onSelectVertex?.(index); props.onDragStart(); }} />) : null}
  </svg></div>;
}

function SvgPrefabArt(props: { hover?: { onPointerEnter(): void; onPointerLeave(): void }; prefab: DungeonPrefabDefinition; x: number; y: number; transform: { width: number; height: number; rotationDeg: number; opacity: number; flipX: boolean; flipY: boolean }; selected: boolean; placementMode?: boolean; onPointerDown(event: ReactPointerEvent<SVGGElement>): void }) {
  const patternId = useId().replace(/:/gu, "_");
  const art = prefabArtSpec(props.prefab, props.transform);
  const originX = props.x + art.width * art.pivotX;
  const originY = props.y + art.height * art.pivotY;
  const left = -art.width * art.pivotX; const top = -art.height * art.pivotY;
  return <g className={`dungeon-prefab-art ${props.selected ? "selected" : ""}`} transform={`translate(${originX} ${originY}) rotate(${art.rotationDeg}) scale(${art.flipX ? -1 : 1} ${art.flipY ? -1 : 1})`} opacity={art.opacity} {...props.hover} onPointerDown={(event) => { if (props.placementMode) return; props.onPointerDown(event); }}>{props.prefab.renderMode === "tile" ? <><defs><pattern id={patternId} width={props.prefab.defaultWidth} height={props.prefab.defaultHeight} patternUnits="userSpaceOnUse"><image href={art.href} width={props.prefab.defaultWidth} height={props.prefab.defaultHeight} preserveAspectRatio="none" /></pattern></defs><rect className="dungeon-prefab-tile" x={left} y={top} width={art.width} height={art.height} fill={`url(#${patternId})`} /></> : <image href={art.href} x={left} y={top} width={art.width} height={art.height} preserveAspectRatio={props.prefab.renderMode === "stretch" ? "none" : "xMidYMid meet"} />}<rect className="dungeon-prefab-hitbox" x={left} y={top} width={art.width} height={art.height} /></g>;
}

function DungeonEntranceCard(props: { onImport(file: File, options: DungeonAssetImportOptions, onImported?: (assetKey: string) => void): Promise<boolean>; catalog: DungeonCatalog; dungeon: DungeonDefinition; writesAllowed: boolean; onUpdateCatalog(edit: (catalog: DungeonCatalog) => void): void }) {
  const binding = props.catalog.entrances?.find((candidate) => candidate.dungeonId === props.dungeon.id && !candidate.retired);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [lat, setLat] = useState("");
  const [lon, setLon] = useState("");
  const [assetKey, setAssetKey] = useState(DEFAULT_DUNGEON_ENTRANCE_ASSET_KEY);
  const syncForm = (): void => {
    setName(binding?.name ?? `${props.dungeon.name} Entrance`);
    setDescription(binding?.description ?? `Entrance to ${props.dungeon.name}.`);
    setLat(binding ? String(binding.lat) : "");
    setLon(binding ? String(binding.lon) : "");
    setAssetKey(binding?.assetKey ?? DEFAULT_DUNGEON_ENTRANCE_ASSET_KEY);
  };
  useEffect(() => {
    if (!editing) syncForm();
  }, [editing, props.dungeon.id, props.dungeon.name, binding?.id, binding?.name, binding?.description, binding?.lat, binding?.lon, binding?.assetKey]);
  const parsedLat = Number(lat);
  const parsedLon = Number(lon);
  const coordinatesValid = lat.trim() !== "" && lon.trim() !== ""
    && Number.isFinite(parsedLat) && parsedLat >= -90 && parsedLat <= 90
    && Number.isFinite(parsedLon) && parsedLon >= -180 && parsedLon <= 180;
  const pictureChoices = [...new Set([
    DEFAULT_DUNGEON_ENTRANCE_ASSET_KEY,
    ...props.catalog.prefabs.filter((prefab) => !prefab.retired && prefab.type === "portal" && prefab.assetKey.toLowerCase().endsWith(".png"))
      .map((prefab) => prefab.assetKey)
  ])];
  const structureBound = props.dungeon.id === "cistern_warrens";
  return <section className="panel dungeon-entrance-card" aria-label="Game entrance">
    <div><h3>Game entrance</h3><strong>{structureBound ? "Structure-bound" : binding ? "Connected" : "Not connected"}</strong></div>
    {structureBound ? <>
      <p>Constructed Cistern Warrens structures provide this entrance through the universal portal system. Do not enter fake overworld coordinates here.</p>
      <p className="dungeon-authority-note">Extend the canonical Cistern Warrens room graph below: add rooms and connect them from Sewer Entrance, Sewer Depths, or another authored sewer space with Portals/Connections. Every constructed Cistern Warrens uses this graph.</p>
    </> : <>
      <p>This controls where the cave picture appears on the overworld and what players see before entering.</p>
      {!editing ? <div className="dungeon-author-actions"><button type="button" disabled={!props.writesAllowed} onClick={() => { syncForm(); setEditing(true); }}>{binding ? "Edit entrance" : "Add entrance"}</button>{binding ? <button type="button" className="danger" disabled={!props.writesAllowed} onClick={() => props.onUpdateCatalog((catalog) => disconnectDungeonWorldEntrance(catalog, props.dungeon.id))}>Remove from overworld</button> : null}</div> : <form aria-label="Game entrance form" onSubmit={(event) => { event.preventDefault(); if (!coordinatesValid) return; props.onUpdateCatalog((catalog) => saveDungeonWorldEntrance(catalog, props.dungeon.id, { name, description, lat: parsedLat, lon: parsedLon, assetKey })); setEditing(false); }}>
      <TextField label="Entrance name" value={name} onChange={setName} />
      <TextField label="Short description" value={description} onChange={setDescription} />
      <div className="field-grid"><label className="field compact"><span>Latitude</span><input type="number" value={lat} min={-90} max={90} step="any" onChange={(event) => setLat(event.target.value)} /></label><label className="field compact"><span>Longitude</span><input type="number" value={lon} min={-180} max={180} step="any" onChange={(event) => setLon(event.target.value)} /></label></div>
      <small>Coordinates choose where this cave picture appears on the overworld.</small>
      <label className="field compact"><span>Entrance picture</span><select value={assetKey} onChange={(event) => setAssetKey(event.target.value)}>{pictureChoices.map((value) => <option key={value} value={value}>{value === DEFAULT_DUNGEON_ENTRANCE_ASSET_KEY ? "Orc cave entrance" : props.catalog.prefabs.find((prefab) => prefab.assetKey === value)?.name ?? value}</option>)}</select></label>
      <img className="dungeon-prefab-thumbnail" src={runtimeDungeonAssetUrl(assetKey)} alt="Selected entrance picture" />
      <label className="field compact"><span>Upload entrance PNG</span><input type="file" accept="image/png" disabled={!props.writesAllowed} onChange={(event) => {
        const file = event.target.files?.[0]; if (!file) return;
        const prefabId = dungeonAssetId(`entrance_${props.dungeon.id}`, props.catalog.prefabs.map((prefab) => prefab.id));
        void props.onImport(file, { prefabId, displayName: `${props.dungeon.name} Entrance`.slice(0, 80), kind: "portal", layer: "above_player", renderMode: "sprite", defaultWidth: 180, defaultHeight: 180 }, setAssetKey);
      }} /></label>
      <small>Use World Map → DEV → Spawning → Dungeon entrances to place the saved entrance on eligible land near lakes. The entrance picture and authored rooms remain linked.</small>
      <div className="dungeon-author-actions"><button type="submit" className="primary" disabled={!props.writesAllowed || !name.trim() || !description.trim() || !coordinatesValid}>Save entrance</button><button type="button" onClick={() => setEditing(false)}>Cancel</button></div>
      </form>}
    </>}
  </section>;
}

function DungeonSettings(props: { onImport(file: File, options: DungeonAssetImportOptions, onImported?: (assetKey: string) => void): Promise<boolean>; catalog: DungeonCatalog; dungeon: DungeonDefinition; writesAllowed: boolean; onUpdate(edit: (dungeon: DungeonDefinition) => void): void; onUpdateCatalog(edit: (catalog: DungeonCatalog) => void): void }) {
  const entranceRoom = props.dungeon.rooms.find((room) => room.id === props.dungeon.entrance.roomId) ?? props.dungeon.rooms[0]!;
  const recoveryRoom = props.dungeon.rooms.find((room) => room.id === props.dungeon.deathRecovery.roomId) ?? props.dungeon.rooms[0]!;
  const entrancePortal = props.dungeon.portals.find((portal) => portal.id === props.dungeon.entrance.portalId);
  const instanceLabels: Record<DungeonDefinition["instancePolicy"], string> = { shared_persistent: "Shared persistent", party_ephemeral: "New for each party", solo_ephemeral: "New for each player" };
  const resetLabels: Record<DungeonDefinition["reset"]["policy"], string> = { when_empty: "When empty", manual: "Manual (not available yet)", never: "Never" };
  return <details className="panel dungeon-settings" open><summary>Dungeon settings · {instanceLabels[props.dungeon.instancePolicy]} · reset {resetLabels[props.dungeon.reset.policy].toLowerCase()}</summary><DungeonEntranceCard onImport={props.onImport} catalog={props.catalog} dungeon={props.dungeon} writesAllowed={props.writesAllowed} onUpdateCatalog={props.onUpdateCatalog} /><div className="dungeon-settings-grid">
    <label className="field compact"><span>Instance policy</span><select value={props.dungeon.instancePolicy} onChange={(event) => props.onUpdate((draft) => { draft.instancePolicy = event.target.value as DungeonDefinition["instancePolicy"]; })}>{(Object.entries(instanceLabels) as Array<[DungeonDefinition["instancePolicy"], string]>).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
    <label className="field compact"><span>Reset policy</span><select value={props.dungeon.reset.policy} onChange={(event) => props.onUpdate((draft) => { draft.reset.policy = event.target.value as DungeonDefinition["reset"]["policy"]; })}>{(Object.entries(resetLabels) as Array<[DungeonDefinition["reset"]["policy"], string]>).map(([value, label]) => <option key={value} value={value} disabled={value === "manual"}>{label}</option>)}</select></label>
    <TextField label="Reset revision" value={props.dungeon.reset.revision} onChange={(revision) => props.onUpdate((draft) => { draft.reset.revision = revision; })} />
    <label className="field compact"><span>Despawn seconds</span><input type="number" min="0" value={props.dungeon.reset.despawnAfterSeconds ?? ""} placeholder="None" onChange={(event) => props.onUpdate((draft) => { const value = Number(event.target.value); draft.reset.despawnAfterSeconds = event.target.value === "" || !Number.isFinite(value) ? null : Math.max(0, value); })} /></label>
    {(["resetEnemies", "resetLoot", "resetDoors", "resetBoss"] as const).map((key) => <label className="toggle" key={key}><input type="checkbox" checked={props.dungeon.reset[key]} onChange={(event) => props.onUpdate((draft) => { draft.reset[key] = event.target.checked; })} /><span>{key.replace(/^reset/u, "Reset ")}</span></label>)}
    <label className="field compact"><span>Entrance room</span><select value={entranceRoom.id} onChange={(event) => props.onUpdate((draft) => { const room = draft.rooms.find((value) => value.id === event.target.value)!; draft.entrance.roomId = room.id; draft.entrance.arrivalAnchorId = room.spawnAnchorId; })}>{props.dungeon.rooms.filter((room) => !room.retired).map((room) => <option key={room.id} value={room.id}>{room.name}</option>)}</select></label>
    <label className="field compact"><span>Entrance arrival</span><select value={props.dungeon.entrance.arrivalAnchorId} onChange={(event) => props.onUpdate((draft) => { draft.entrance.arrivalAnchorId = event.target.value; })}>{entranceRoom.anchors.filter((anchor) => !anchor.retired).map((anchor) => <option key={anchor.id}>{anchor.id}</option>)}</select></label>
    <label className="field compact"><span>Entrance portal</span><select value={props.dungeon.entrance.portalId} onChange={(event) => props.onUpdate((draft) => { draft.entrance.portalId = event.target.value; })}>{props.dungeon.portals.filter((portal) => !portal.retired).map((portal) => <option key={portal.id}>{portal.id}</option>)}</select></label>
    {entrancePortal?.source.kind === "world" && !entrancePortal.enabled ? <p className="dungeon-authority-note">Draft portal disabled — needs world entrance binding before it can be enabled.</p> : null}
    <label className="field compact"><span>Exit portal</span><select value={props.dungeon.escape.portalId} onChange={(event) => props.onUpdate((draft) => { draft.escape.portalId = event.target.value; })}>{props.dungeon.portals.filter((portal) => !portal.retired).map((portal) => <option key={portal.id}>{portal.id}</option>)}</select></label>
    <label className="field compact"><span>Recovery room</span><select value={recoveryRoom.id} onChange={(event) => props.onUpdate((draft) => { const room = draft.rooms.find((value) => value.id === event.target.value)!; draft.deathRecovery = { roomId: room.id, anchorId: room.spawnAnchorId }; })}>{props.dungeon.rooms.filter((room) => !room.retired).map((room) => <option key={room.id} value={room.id}>{room.name}</option>)}</select></label>
    <label className="field compact"><span>Recovery anchor</span><select value={props.dungeon.deathRecovery.anchorId} onChange={(event) => props.onUpdate((draft) => { draft.deathRecovery.anchorId = event.target.value; })}>{recoveryRoom.anchors.filter((anchor) => !anchor.retired).map((anchor) => <option key={anchor.id}>{anchor.id}</option>)}</select></label>
    <TextField label="Dungeon environment" value={props.dungeon.environment.environmentId} onChange={(environmentId) => props.onUpdate((draft) => { draft.environment.environmentId = environmentId; })} />
    {(["backgroundColor", "floorColor", "wallColor", "accentColor"] as const).map((key) => <TextField key={key} label={key.replace(/Color$/u, " color")} value={props.dungeon.environment[key]} onChange={(value) => props.onUpdate((draft) => { draft.environment[key] = value; })} />)}
    <TextField label="Dungeon music" value={props.dungeon.environment.musicAssetKey ?? ""} onChange={(value) => props.onUpdate((draft) => { draft.environment.musicAssetKey = value || null; })} />
    <TextField label="Dungeon ambience" value={props.dungeon.environment.ambienceAssetKey ?? ""} onChange={(value) => props.onUpdate((draft) => { draft.environment.ambienceAssetKey = value || null; })} />
    <TextField label="Reward table manifest" value={props.dungeon.rewardTableIds.join(", ")} onChange={(value) => props.onUpdate((draft) => { draft.rewardTableIds = idList(value); })} />
    <TextField label="Boss template manifest" value={props.dungeon.bossTemplateIds.join(", ")} onChange={(value) => props.onUpdate((draft) => { draft.bossTemplateIds = idList(value); })} />
  </div></details>;
}

function MobGroupControlsPanel(props: { room: DungeonRoomDefinition; dungeon: DungeonDefinition; onUpdateDungeon(edit: (dungeon: DungeonDefinition) => void): void }) {
  const entries = props.dungeon.encounters.filter((encounter) => !encounter.retired && encounter.roomId === props.room.id).map((encounter) => {
    const encounterMobIds = new Set(encounter.waves.flatMap((wave) => wave.mobSpawnIds));
    const groups = [...new Set(props.room.mobs.filter((mob) => !mob.retired && encounterMobIds.has(mob.id)).map((mob) => mob.spawnGroupId))];
    return { encounter, groups };
  }).filter((entry) => entry.groups.length > 0);
  if (entries.length === 0) return null;
  return <section className="dungeon-group-controls" aria-label="Mob group controls">
    <div className="divider"><span>MOB GROUP CONTROLS</span></div>
    <p className="dungeon-authority-note">Dragging a mob moves its whole spawn group. Use these small encounter controls for formation and linked aggro.</p>
    {entries.map(({ encounter, groups }) => <article className="dungeon-group-control-card" key={encounter.id}>
      <strong>{encounter.name}</strong>
      <small>Groups: {groups.join(", ")}</small>
      <label className="field compact"><span>Formation</span><select value={encounter.groupControls?.formation ?? "scatter"} onChange={(event) => props.onUpdateDungeon((dungeon) => {
        const draft = dungeon.encounters.find((value) => value.id === encounter.id);
        if (!draft) return;
        draft.groupControls = { formation: event.target.value as "scatter" | "line" | "wedge" | "circle", linkedAggro: draft.groupControls?.linkedAggro ?? false };
      })}><option value="scatter">Scatter</option><option value="line">Line</option><option value="wedge">Wedge</option><option value="circle">Circle</option></select></label>
      <label className="toggle"><input type="checkbox" checked={encounter.groupControls?.linkedAggro ?? false} onChange={(event) => props.onUpdateDungeon((dungeon) => {
        const draft = dungeon.encounters.find((value) => value.id === encounter.id);
        if (!draft) return;
        draft.groupControls = { formation: draft.groupControls?.formation ?? "scatter", linkedAggro: event.target.checked };
      })} /><span>Linked aggro for this encounter</span></label>
    </article>)}
  </section>;
}

function EntitySection(props: { simple: boolean; room: DungeonRoomDefinition; dungeon: DungeonDefinition; prefabs: DungeonCatalog["prefabs"]; selection: EditorSelection; onSelect(value: EditorSelection): void; onArmPlacement(value: Exclude<PlacementTool, null>): void; onUpdateRoom(edit: (room: DungeonRoomDefinition) => void): void; onUpdateDungeon(edit: (dungeon: DungeonDefinition) => void): void; onUpdateCatalog(edit: (catalog: DungeonCatalog) => void): void }) {
  const genericObjectPrefab = props.prefabs.find((value) => !value.retired && value.type === "object");
  return <>{!props.simple ? <><div className="divider"><span>ROOM ENTITIES</span></div><div className="entity-add-row">{(["anchor", "collider", "zone", "object"] as const).map((kind) => <button key={kind} type="button" disabled={kind === "object" && !genericObjectPrefab} title={kind === "object" && !genericObjectPrefab ? "Add an object prefab to the catalog first" : undefined} onClick={() => props.onArmPlacement(kind)}>+ {kind}</button>)}</div><MobGroupControlsPanel room={props.room} dungeon={props.dungeon} onUpdateDungeon={props.onUpdateDungeon} /></> : null}{props.selection ? <SelectedEntityEditor {...props} selection={props.selection} /> : <p className="empty-copy">{props.simple ? "Select something in the room to change it." : "Select an anchor, collider, zone, or object on the canvas."}</p>}</>;
}

function SelectedEntityEditor(props: { simple: boolean; room: DungeonRoomDefinition; dungeon: DungeonDefinition; prefabs: DungeonCatalog["prefabs"]; selection: NonNullable<EditorSelection>; onSelect(value: EditorSelection): void; onUpdateRoom(edit: (room: DungeonRoomDefinition) => void): void; onUpdateDungeon(edit: (dungeon: DungeonDefinition) => void): void; onUpdateCatalog(edit: (catalog: DungeonCatalog) => void): void }) {
  const selected = props.selection.kind === "anchor" ? props.room.anchors.find((value) => value.id === props.selection.id) : props.selection.kind === "collider" ? props.room.colliders.find((value) => value.id === props.selection.id) : props.selection.kind === "zone" ? props.room.zones.find((value) => value.id === props.selection.id) : props.selection.kind === "resourceZone" ? props.room.resourceSpawnZones?.find((value) => value.id === props.selection.id) : props.selection.kind === "object" ? props.room.objects.find((value) => value.id === props.selection.id) : props.selection.kind === "mob" ? props.room.mobs.find((value) => value.id === props.selection.id) : Object.values(props.room.layers).flat().find((value) => value.id === props.selection.id);
  if (!selected) return null;
  const update = (patch: Record<string, unknown>): void => {
    if (props.selection.kind === "resourceZone") {
      props.onUpdateRoom((room) => { const value = room.resourceSpawnZones?.find((candidate) => candidate.id === props.selection.id); if (value) Object.assign(value, patch); });
      return;
    }
    props.onUpdateRoom((room) => { const list = props.selection.kind === "anchor" ? room.anchors : props.selection.kind === "collider" ? room.colliders : props.selection.kind === "zone" ? room.zones : props.selection.kind === "object" ? room.objects : props.selection.kind === "mob" ? room.mobs : Object.values(room.layers).flat(); Object.assign(list.find((value) => value.id === props.selection.id)!, patch); });
  };
  const selectedPlacement = props.selection.kind === "placement" && "prefabId" in selected && "width" in selected
    ? selected as DungeonLayerPlacement
    : null;
  const selectedPlacementPrefab = selectedPlacement
    ? props.prefabs.find((prefab) => prefab.id === selectedPlacement.prefabId)
    : undefined;
  const updatePlacement = (patch: Partial<DungeonLayerPlacement>, renderMode?: DungeonPrefabDefinition["renderMode"], moveToBackground = false): void => {
    if (!selectedPlacement) return;
    props.onUpdateCatalog((catalog) => {
      const dungeon = catalog.dungeons.find((candidate) => candidate.id === props.dungeon.id);
      const room = dungeon?.rooms.find((candidate) => candidate.id === props.room.id);
      if (!room) return;
      let sourceLayer: LayerId | null = null;
      let sourceIndex = -1;
      for (const layer of LAYERS) {
        const index = room.layers[layer].findIndex((candidate) => candidate.id === selectedPlacement.id);
        if (index >= 0) { sourceLayer = layer; sourceIndex = index; break; }
      }
      if (sourceLayer === null) return;
      const placement = room.layers[sourceLayer][sourceIndex];
      if (!placement) return;
      Object.assign(placement, patch);
      if (moveToBackground && sourceLayer !== "background") {
        room.layers[sourceLayer].splice(sourceIndex, 1);
        room.layers.background.push(placement);
      }
      if (renderMode) {
        const prefab = catalog.prefabs.find((candidate) => candidate.id === placement.prefabId);
        if (prefab) prefab.renderMode = renderMode;
      }
    });
  };
  const selectedPlacementControls = selectedPlacement && selectedPlacementPrefab ? <>
    <label className="field compact"><span>Render mode</span><select value={selectedPlacementPrefab.renderMode} onChange={(event) => props.onUpdateCatalog((catalog) => {
      const prefab = catalog.prefabs.find((candidate) => candidate.id === selectedPlacementPrefab.id);
      if (prefab) prefab.renderMode = event.target.value as DungeonPrefabDefinition["renderMode"];
    })}><option value="sprite">Sprite · preserve aspect</option><option value="tile">Tile</option><option value="stretch">Stretch · fill bounds</option></select></label>
    <small>Render mode is shared by every placement of {selectedPlacementPrefab.name}. Sprite keeps the PNG aspect ratio; Stretch fills the selected bounds.</small>
    <div className="dungeon-author-actions"><button type="button" onClick={() => updatePlacement({ x: 0, y: 0, width: props.room.width, height: props.room.height }, "stretch", true)}>Stretch to fill room as backdrop</button></div>
    <small>Full-room art moves this placement to Background so it stays behind players and room objects.</small>
  </> : null;
  const retireSelected = (): void => {
    if (props.selection.kind === "object" && "type" in selected && selected.type === "portal" && selected.portalId) {
      props.onUpdateDungeon((dungeon) => { retireDungeonPortalConnection(dungeon, selected.portalId!); });
    } else {
      update({ retired: true, ...(props.selection.kind === "object" ? { available: false } : {}) });
    }
    props.onSelect(null);
  };
  if (props.selection.kind === "mob" && "archetype" in selected) {
    const encounters = props.dungeon.encounters.filter((value) => !value.retired && value.roomId === props.room.id);
    const encounter = encounters.find((value) => value.id === selected.encounterId) ?? encounters[0];
    if (props.simple) return <div className="selected-entity"><strong>Enemy · {friendlyId(selected.archetype)}</strong><label className="field compact"><span>Enemy type</span><select value={selected.archetype} onChange={(event) => update({ archetype: event.target.value })}>{MOB_ARCHETYPE_KEYS.map((value) => <option key={value} value={value}>{friendlyId(value)}</option>)}</select></label></div>;
    return <div className="selected-entity"><strong>Mob · {selected.archetype}</strong><label className="field compact"><span>Archetype</span><select value={selected.archetype} onChange={(event) => update({ archetype: event.target.value })}>{MOB_ARCHETYPE_KEYS.map((value) => <option key={value}>{value}</option>)}</select></label><label className="field compact"><span>Encounter</span><select value={selected.encounterId} onChange={(event) => props.onUpdateDungeon((dungeon) => assignMobToEncounterWave(dungeon, props.room.id, selected.id, event.target.value, 1))}>{encounters.map((value) => <option key={value.id} value={value.id}>{value.name}</option>)}</select></label><label className="field compact"><span>Wave assignment</span><select value={selected.waveIndex} onChange={(event) => props.onUpdateDungeon((dungeon) => assignMobToEncounterWave(dungeon, props.room.id, selected.id, selected.encounterId, Number(event.target.value)))}>{encounter?.waves.map((wave, index) => <option key={wave.id} value={index + 1}>Wave {index + 1}</option>)}</select></label><div className="field-grid"><NumberField label="Facing (degrees)" value={Math.round(selected.facing * 180 / Math.PI)} step={1} onChange={(degrees) => update({ facing: degrees * Math.PI / 180 })} /><NumberField label="Visual scale" value={selected.visualScale} min={0.1} step={0.1} onChange={(visualScale) => update({ visualScale })} /></div><TextField label="Spawn group" value={selected.spawnGroupId} onChange={(spawnGroupId) => update({ spawnGroupId })} /><label className="field compact"><span>Leash zone</span><select value={selected.leashZoneId ?? ""} onChange={(event) => update({ leashZoneId: event.target.value || undefined })}>{props.room.zones.filter((value) => !value.retired && value.purpose === "leash").map((value) => <option key={value.id}>{value.id}</option>)}</select></label></div>;
  }
  if (props.simple && props.selection.kind === "object" && "type" in selected) return <div className="selected-entity"><strong>{selected.name}</strong>{props.prefabs.some((value) => value.id === selected.prefabId) ? null : <small className="no-art-note">No art yet</small>}<TextField label="Name" value={selected.name} onChange={(name) => update({ name })} /><label className="toggle"><input type="checkbox" checked={selected.available} onChange={(event) => update({ available: event.target.checked })} /><span>Player can use this</span></label></div>;
  if (props.selection.kind === "resourceZone") return <div className="selected-entity"><strong>Resource spawn zone</strong><p>Use Resources to edit its shape, yield, and respawn settings.</p><button type="button" className="danger wide" onClick={retireSelected}>Retire resource zone</button></div>;
  if (props.simple) {
    if (selectedPlacement && selectedPlacementPrefab) return <div className="selected-entity"><strong>Selected art · {selectedPlacementPrefab.name}</strong><div className="field-grid"><NumberField label="Left / right" unit="px" value={selectedPlacement.x} onChange={(x) => updatePlacement({ x })} /><NumberField label="Up / down" unit="px" value={selectedPlacement.y} onChange={(y) => updatePlacement({ y })} /><NumberField label="Width" unit="px" value={selectedPlacement.width} min={1} onChange={(width) => updatePlacement({ width })} /><NumberField label="Height" unit="px" value={selectedPlacement.height} min={1} onChange={(height) => updatePlacement({ height })} /></div>{selectedPlacementControls}</div>;
    return <div className="selected-entity"><strong>Selected room piece</strong>{"x" in selected ? <div className="field-grid"><NumberField label="Left / right" unit="px" value={selected.x} onChange={(x) => update({ x })} /><NumberField label="Up / down" unit="px" value={selected.y} onChange={(y) => update({ y })} /></div> : null}</div>;
  }
  if (props.selection.kind !== "object" || !("type" in selected)) {
    return <div className="selected-entity"><small className="entity-id">ID · {selected.id}</small>{"x" in selected ? <div className="field-grid"><NumberField label="X" unit="px" value={selected.x} onChange={(x) => update({ x })} /><NumberField label="Y" unit="px" value={selected.y} onChange={(y) => update({ y })} />{"width" in selected ? <><NumberField label="Width" unit="px" value={selected.width} min={1} onChange={(width) => update({ width })} /><NumberField label="Height" unit="px" value={selected.height} min={1} onChange={(height) => update({ height })} /></> : null}</div> : "points" in selected ? <p>{selected.points.length} polygon points</p> : null}{selectedPlacementControls}{"rotationDeg" in selected ? <><div className="field-grid"><NumberField label="Rotation" value={selected.rotationDeg} onChange={(rotationDeg) => update({ rotationDeg })} /><NumberField label="Opacity" value={selected.opacity} min={0} step={0.1} onChange={(opacity) => update({ opacity: clamp(opacity, 0, 1) })} /><NumberField label="Z index" value={selected.zIndex} onChange={(zIndex) => update({ zIndex: Math.round(zIndex) })} /></div><label className="toggle"><input type="checkbox" checked={selected.flipX} onChange={(event) => update({ flipX: event.target.checked })} /><span>Flip horizontally</span></label></> : null}<button type="button" className="danger wide" onClick={retireSelected}>Retire {props.selection.kind}</button></div>;
  }
  const anchorLabels = anchorNames({ room: props.room, dungeon: props.dungeon, prefabs: props.prefabs });
  const portalPrefabs = props.prefabs.filter((value) => !value.retired && value.type === "portal");
  const interactionPrefabs = props.prefabs.filter((value) => !value.retired && value.type === "object");
  const sourcePortals = props.dungeon.portals.filter((portal) => !portal.retired && portal.source.kind === "room" && portal.source.roomId === props.room.id);
  const prefabChoices = selected.type === "portal" ? portalPrefabs : interactionPrefabs;
  const selectedPortal = selected.type === "portal" ? props.dungeon.portals.find((portal) => portal.id === selected.portalId) : undefined;
  const selectedDestination = selectedPortal?.destination;
  const portalDestinationName = selectedDestination?.kind === "room"
    ? props.dungeon.rooms.find((room) => room.id === selectedDestination.roomId)?.name ?? selectedDestination.roomId
    : selectedDestination?.kind === "world" ? "World" : "Not assigned";
  const portalOptionLabel = (portal: DungeonDefinition["portals"][number]): string => {
    const destination = portal.destination;
    const destinationName = destination.kind === "room"
      ? props.dungeon.rooms.find((room) => room.id === destination.roomId)?.name ?? destination.roomId
      : "World";
    return `${portal.interactionLabel} → ${destinationName}`;
  };
  return <div className="selected-entity"><small className="entity-id">ID · {selected.id}</small>{props.prefabs.some((value) => value.id === selected.prefabId) ? null : <small className="no-art-note">No art yet</small>}<TextField label="Name" value={selected.name} onChange={(name) => update({ name })} />{selected.type === "portal" ? <><small>Name is this object&apos;s display name; it does not choose the destination.</small><p><strong>Destination room:</strong> {portalDestinationName}</p></> : null}<label className="field compact"><span>Object type</span><select value={selected.type} onChange={(event) => {
    const type = event.target.value as DungeonRoomDefinition["objects"][number]["type"];
    if (type === "portal") {
      const portal = sourcePortals[0]; const prefab = portalPrefabs[0];
      if (portal?.source.kind === "room" && prefab) update({ type, prefabId: prefab.id, prefabRevision: prefab.revision, portalId: portal.id, anchorId: portal.source.anchorId });
    } else {
      const prefab = interactionPrefabs[0]; if (prefab) update({ type, prefabId: prefab.id, prefabRevision: prefab.revision, portalId: undefined });
    }
  }}>{OBJECT_TYPES.map((value) => <option key={value} value={value} disabled={value === "portal" ? portalPrefabs.length === 0 || sourcePortals.length === 0 : interactionPrefabs.length === 0}>{friendlyObjectType(value)}</option>)}</select></label><label className="field compact"><span>Prefab</span><select value={selected.prefabId} onChange={(event) => { const prefab = prefabChoices.find((value) => value.id === event.target.value); if (prefab) update({ prefabId: prefab.id, prefabRevision: prefab.revision, interactionRadius: prefab.interactionRadius ?? selected.interactionRadius }); }}>{prefabChoices.map((value) => <option key={value.id} value={value.id}>{value.name} · {value.revision}</option>)}</select></label><div className="divider"><span>BEHAVIOUR</span></div><label className="field compact"><span>Initial state</span><select value={selected.initialState} onChange={(event) => update({ initialState: event.target.value })}>{["idle", "open", "closed", "on", "off", "pressed", "released", "intact", "destroyed", "looted"].map((value) => <option key={value} value={value}>{friendlyId(value)}</option>)}</select></label><NumberField label="Interaction radius" unit="px" help="How close a player must stand to use it." value={selected.interactionRadius} min={1} onChange={(interactionRadius) => update({ interactionRadius })} /><div className="divider"><span>APPEARANCE</span></div><div className="field-grid"><NumberField label="Rotation" unit="°" value={selected.rotationDeg} onChange={(rotationDeg) => update({ rotationDeg })} /><NumberField label="Opacity" help="0 is invisible, 1 is solid." value={selected.opacity} min={0} step={0.1} onChange={(opacity) => update({ opacity: clamp(opacity, 0, 1) })} /><NumberField label="Draw order" help="Higher draws on top within its layer." value={selected.zIndex} onChange={(zIndex) => update({ zIndex: Math.round(zIndex) })} /></div><label className="field compact"><span>Layer</span><select value={selected.layerId} onChange={(event) => update({ layerId: event.target.value })}>{LAYERS.map((value) => <option key={value} value={value}>{friendlyLayer(value)}</option>)}</select></label><div className="divider"><span>PLACEMENT</span></div><label className="field compact"><span>Anchor</span><select value={selected.anchorId} disabled={selected.type === "portal"} onChange={(event) => update({ anchorId: event.target.value })}>{props.room.anchors.filter((value) => !value.retired).map((value) => <option key={value.id} value={value.id}>{anchorLabels.get(value.id) ?? friendlyId(value.id)}</option>)}</select></label>{selected.type === "portal" ? <label className="field compact"><span>Portal</span><select value={selected.portalId ?? ""} onChange={(event) => { const portal = sourcePortals.find((value) => value.id === event.target.value); if (portal?.source.kind === "room") update({ portalId: portal.id, anchorId: portal.source.anchorId }); }}>{sourcePortals.map((value) => <option key={value.id} value={value.id}>{portalOptionLabel(value)}</option>)}</select></label> : null}<label className="toggle"><input type="checkbox" checked={selected.available} onChange={(event) => update({ available: event.target.checked })} /><span>Available</span></label><button type="button" className="danger wide" onClick={retireSelected}>Retire object</button></div>;
}

function PortalSection(props: { simple: boolean; dungeon: DungeonDefinition; room: DungeonRoomDefinition; prefabs: DungeonCatalog["prefabs"]; onUpdateDungeon(edit: (dungeon: DungeonDefinition) => void): void; onError(message: string): void }) {
  const portals = props.dungeon.portals.filter((portal) => portal.source.kind === "room" && portal.source.roomId === props.room.id);
  const destinations = props.dungeon.rooms.filter((room) => !room.retired && room.id !== props.room.id);
  const [destinationRoomId, setDestinationRoomId] = useState(destinations[0]?.id ?? "");
  useEffect(() => { setDestinationRoomId(destinations[0]?.id ?? ""); }, [props.room.id]);
  const effectiveDestinationRoomId = destinations.some((room) => room.id === destinationRoomId)
    ? destinationRoomId
    : destinations[0]?.id ?? "";
  const portalPrefab = props.prefabs.find((prefab) => !prefab.retired && prefab.type === "portal");
  // A door that already leads somewhere can lead to more rooms: each destination gets its own typed label.
  const doorAnchorIds = [...new Set(portals.flatMap((portal) => portal.source.kind === "room" && !portal.retired && portal.destination.kind === "room" ? [portal.source.anchorId] : []))];
  const [fromDoorAnchorId, setFromDoorAnchorId] = useState("");
  const [connectionLabel, setConnectionLabel] = useState("");
  useEffect(() => { setFromDoorAnchorId(""); setConnectionLabel(""); }, [props.room.id]);
  const effectiveFromDoor = doorAnchorIds.includes(fromDoorAnchorId) ? fromDoorAnchorId : "";
  const createConnection = (reciprocal: boolean): void => {
    if (!effectiveDestinationRoomId || !portalPrefab) return;
    const label = connectionLabel.trim();
    props.onUpdateDungeon((dungeon) => {
      const connection = createRoomPortalConnection(dungeon, props.room.id, effectiveDestinationRoomId, portalPrefab, { x: props.room.width / 2, y: props.room.height / 2 }, reciprocal,
        effectiveFromDoor || undefined, label || undefined);
      if ("error" in connection) props.onError(connection.error);
    });
    setConnectionLabel("");
  };
  const simpleDestinationLabel = (portal: DungeonDefinition["portals"][number]): string => {
    const destination = portal.destination;
    return destination.kind === "room"
      ? props.dungeon.rooms.find((room) => room.id === destination.roomId)?.name ?? "another room"
      : "the game world";
  };
  if (props.simple) return <><div className="divider"><span>ROOM CONNECTIONS</span></div>{destinations.length > 0 ? <div className="portal-create"><label className="field compact"><span>Connect this room to</span><select value={effectiveDestinationRoomId} onChange={(event) => setDestinationRoomId(event.target.value)}>{destinations.map((room) => <option key={room.id} value={room.id}>{room.name}</option>)}</select></label><button type="button" disabled={!effectiveDestinationRoomId || !portalPrefab} onClick={() => createConnection(true)}>Connect rooms</button></div> : <p>This is the only room. Its game entrance and exit are managed outside this basic setup.</p>}{portals.map((portal) => <article className="portal-editor" key={portal.id}><strong>{portal.interactionLabel}</strong><span>Goes to {simpleDestinationLabel(portal)}</span><label className="toggle"><input type="checkbox" checked={portal.enabled} onChange={(event) => props.onUpdateDungeon((dungeon) => { dungeon.portals.find((value) => value.id === portal.id)!.enabled = event.target.checked; })} /><span>Connection works</span></label></article>)}</>;
  return <><div className="divider"><span>PORTAL CONNECTIONS</span></div><div className="portal-create"><label className="field compact"><span>From door</span><select aria-label="From door" value={effectiveFromDoor} onChange={(event) => setFromDoorAnchorId(event.target.value)}><option value="">New door</option>{doorAnchorIds.map((anchorId) => <option key={anchorId} value={anchorId}>{`Existing door ${anchorId} (add a destination)`}</option>)}</select></label><label className="field compact"><span>Connect to room</span><select value={effectiveDestinationRoomId} onChange={(event) => setDestinationRoomId(event.target.value)}>{destinations.map((room) => <option key={room.id} value={room.id}>{room.name}</option>)}</select></label><label className="field compact"><span>Door label</span><input aria-label="Door label" placeholder="Upstairs, Basement, Patio..." maxLength={80} value={connectionLabel} onChange={(event) => setConnectionLabel(event.target.value)} /></label><button type="button" disabled={!effectiveDestinationRoomId || !portalPrefab} title={!portalPrefab ? "A portal prefab is required" : undefined} onClick={() => createConnection(true)}>Connect rooms</button><details><summary>Advanced</summary><button type="button" disabled={!effectiveDestinationRoomId || !portalPrefab} onClick={() => createConnection(false)}>One-way directed connection</button></details></div>{portals.map((portal) => {
    const destinationRoomId = portal.destination.kind === "room" ? portal.destination.roomId : null;
    const destinationAnchorId = portal.destination.kind === "room" ? portal.destinationArrivalAnchorId ?? portal.destination.anchorId : "";
    const destinationRoom = destinationRoomId ? props.dungeon.rooms.find((room) => room.id === destinationRoomId) : undefined;
     return <article className="portal-editor" key={portal.id}><strong>{portal.interactionLabel}</strong><small>{portal.source.kind === "room" ? `Door ${portal.source.anchorId}` : portal.id} → {destinationRoom?.name ?? destinationRoomId ?? "world"}</small><TextField label="Door label" value={portal.interactionLabel} onChange={(interactionLabel) => props.onUpdateDungeon((dungeon) => { dungeon.portals.find((value) => value.id === portal.id)!.interactionLabel = interactionLabel; })} /><label className="field compact"><span>Destination</span><select value={destinationRoomId ?? "world"} onChange={(event) => props.onUpdateDungeon((dungeon) => { const draft = dungeon.portals.find((value) => value.id === portal.id)!; if (event.target.value === "world") draft.destination = { kind: "world" }; else { const nextRoom = dungeon.rooms.find((value) => !value.retired && value.id === event.target.value && value.id !== props.room.id); if (!nextRoom) return; draft.destination = { kind: "room", roomId: nextRoom.id, anchorId: nextRoom.spawnAnchorId }; draft.destinationArrivalAnchorId = nextRoom.spawnAnchorId; } })}><option value="world">World</option>{props.dungeon.rooms.filter((value) => !value.retired && value.id !== props.room.id).map((value) => <option key={value.id} value={value.id}>{value.name}</option>)}</select></label>{destinationRoom ? <label className="field compact"><span>Arrival anchor</span><select value={destinationAnchorId} onChange={(event) => props.onUpdateDungeon((dungeon) => { const draft = dungeon.portals.find((value) => value.id === portal.id)!; if (draft.destination.kind !== "room") return; draft.destination.anchorId = event.target.value; draft.destinationArrivalAnchorId = event.target.value; })}>{destinationRoom.anchors.filter((anchor) => !anchor.retired).map((anchor) => <option key={anchor.id} value={anchor.id}>{anchor.id}</option>)}</select></label> : null}<label className="toggle"><input type="checkbox" checked={portal.enabled} onChange={(event) => props.onUpdateDungeon((dungeon) => { dungeon.portals.find((value) => value.id === portal.id)!.enabled = event.target.checked; })} /><span>Enabled</span></label><label className="field compact"><span>Conditions</span><select value={portal.conditions[0] ?? "always"} onChange={(event) => props.onUpdateDungeon((dungeon) => { const draft = dungeon.portals.find((value) => value.id === portal.id)!; draft.conditions = [event.target.value as PortalCondition]; })}><option value="always">always</option><option value="dungeon_active">dungeon active</option><option value="unlocked">unlocked</option><option value="boss_defeated">boss defeated</option></select><small>Use encounter portal locks or a "set portal locked" trigger action for encounter gating; direct legacy/future unavailable conditions are not offered. Conditions also combine with explicit item/quest/dungeon-flag gates. Leave a connection non-reciprocal for one-way travel.</small></label><button type="button" className="danger wide" onClick={() => props.onUpdateDungeon((dungeon) => retireDungeonPortalConnection(dungeon, portal.id))}>Retire connection</button></article>;
  })}</>;
}

function createRoomPortalConnection(dungeon: DungeonDefinition, sourceRoomId: string, destinationRoomId: string, portalPrefab: DungeonPrefabDefinition, sourcePoint: IndoorPoint, reciprocal: boolean,
  fromAnchorId?: string, label?: string): { sourceObjectId: string } | { error: string } {
  try {
    const connection = connectDungeonRooms(dungeon, fromAnchorId ? { roomId: sourceRoomId, anchorId: fromAnchorId } : { roomId: sourceRoomId, point: sourcePoint },
      { roomId: destinationRoomId }, portalPrefab, reciprocal, label ? { label } : {});
    return { sourceObjectId: connection.sourceObjectId };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "The room connection could not be created." };
  }
}

function placeConfiguredWorldExit(dungeon: DungeonDefinition, roomId: string, portalPrefab: DungeonPrefabDefinition, point: IndoorPoint): { sourceObjectId: string } | null {
  const portal = dungeon.portals.find((candidate) => candidate.id === dungeon.escape.portalId && !candidate.retired && candidate.enabled
    && candidate.source.kind === "room" && candidate.source.roomId === roomId && candidate.destination.kind === "world");
  const room = dungeon.rooms.find((candidate) => candidate.id === roomId);
  if (!portal || portal.source.kind !== "room" || !room || portalPrefab.retired || portalPrefab.type !== "portal") return null;
  const sourceAnchorId = portal.source.anchorId;
  let anchor = room.anchors.find((candidate) => candidate.id === sourceAnchorId);
  if (!anchor) {
    anchor = { id: sourceAnchorId, retired: false, ...point };
    room.anchors.push(anchor);
  }
  anchor.retired = false;
  anchor.x = point.x;
  anchor.y = point.y;

  const linkedObjects = room.objects.filter((object) => !object.retired && object.portalId === portal.id);
  let sourceObject = linkedObjects[0];
  if (!sourceObject) {
    const sourceObjectId = nextId(`${portalPrefab.id}_object`, room.objects.map((object) => object.id));
    sourceObject = createDungeonObject(portalPrefab, sourceObjectId, sourceAnchorId, portal.interactionLabel, portal.id);
    room.objects.push(sourceObject);
  } else {
    sourceObject.prefabId = portalPrefab.id;
    sourceObject.prefabRevision = portalPrefab.revision;
    sourceObject.anchorId = sourceAnchorId;
  }
  for (const duplicate of linkedObjects.slice(1)) {
    duplicate.retired = true;
    duplicate.available = false;
  }
  return { sourceObjectId: sourceObject.id };
}

function DungeonWizard(props: { value: DungeonWizardInput; proposedId: string; onChange(value: DungeonWizardInput): void; onCancel(): void; onCreate(): void }) {
  const update = <K extends keyof DungeonWizardInput>(key: K, value: DungeonWizardInput[K]): void => props.onChange({ ...props.value, [key]: value });
  const preset = props.value.width === 720 && props.value.height === 540 ? "small" : props.value.width === 1000 && props.value.height === 1000 ? "medium" : props.value.width === 1440 && props.value.height === 1080 ? "large" : "custom";
  return <section className="panel dungeon-wizard" aria-label="Create dungeon wizard">
    <PanelHeading title="Create a Dungeon" meta="Guided setup" />
    <p>Name it, choose its look, and start with one safe room.</p>
    <div className="dungeon-settings-grid">
      <TextField label="Dungeon name" value={props.value.name} onChange={(value) => update("name", value)} />
      <label className="field compact"><span>Theme</span><select value={["stone", "sewer", "cavern", "crypt"].includes(props.value.themeId) ? props.value.themeId : "advanced"} onChange={(event) => update("themeId", event.target.value)}>{!["stone", "sewer", "cavern", "crypt"].includes(props.value.themeId) ? <option value="advanced" disabled>Custom · edit in Advanced</option> : null}<option value="stone">Ancient stone</option><option value="sewer">Underground sewer</option><option value="cavern">Natural cavern</option><option value="crypt">Haunted crypt</option></select></label>
      <label className="field compact"><span>First room size</span><select value={preset === "custom" ? "advanced" : preset} onChange={(event) => { const size = roomSizePreset(event.target.value); if (size) props.onChange({ ...props.value, ...size }); }}>{preset === "custom" ? <option value="advanced" disabled>Custom · edit in Advanced</option> : null}<option value="small">Small · 720 × 540</option><option value="medium">Medium · 1000 × 1000</option><option value="large">Large · 1440 × 1080</option></select></label>
    </div>
    <details><summary>Advanced</summary><div className="dungeon-settings-grid">
      <TextField label="Technical theme ID" value={props.value.themeId} onChange={(value) => update("themeId", safeDungeonId(value))} />
      <p>Dungeon ID · <code>{props.proposedId}</code></p>
      {(["backgroundColor", "floorColor", "wallColor", "accentColor"] as const).map((key) => <label className="field compact" key={key}><span>{key.replace(/Color$/u, " color")}</span><input type="color" value={props.value[key]} onChange={(event) => update(key, event.target.value)} /></label>)}
      <label className="field compact"><span>Instance policy</span><select value={props.value.instancePolicy} onChange={(event) => update("instancePolicy", event.target.value as DungeonWizardInput["instancePolicy"])}><option value="shared_persistent">Shared persistent</option><option value="party_ephemeral">New for each party</option><option value="solo_ephemeral">New for each player</option></select></label>
      <label className="field compact"><span>Reset policy</span><select value={props.value.resetPolicy} onChange={(event) => update("resetPolicy", event.target.value as DungeonWizardInput["resetPolicy"])}><option value="when_empty">When empty</option><option value="manual" disabled>Manual (not available yet)</option><option value="never">Never</option></select></label>
      <NumberField label="Exact room width" value={props.value.width} min={320} onChange={(value) => update("width", value)} /><NumberField label="Exact room height" value={props.value.height} min={320} onChange={(value) => update("height", value)} />
    </div></details>
    <p>Creates entrance, escape, recovery, and reciprocal world portal definitions.</p>
    <div className="dungeon-author-actions"><button type="button" onClick={props.onCancel}>Cancel</button><button type="button" className="primary" disabled={!props.value.name.trim()} onClick={props.onCreate}>Create dungeon</button></div>
  </section>;
}

function DungeonAssetImportCard(props: { simple: boolean; disabled: boolean; onImport(file: File, options: DungeonAssetImportOptions): Promise<boolean> }) {
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState("New Dungeon Art");
  const [kind, setKind] = useState<DungeonAssetImportOptions["kind"]>("decoration");
  const [layer, setLayer] = useState<DungeonAssetImportOptions["layer"]>("above_player");
  const [renderMode, setRenderMode] = useState<DungeonAssetImportOptions["renderMode"]>("sprite");
  const [width, setWidth] = useState(96); const [height, setHeight] = useState(96);
  const id = safeDungeonId(name);
  const chooseKind = (value: DungeonAssetImportOptions["kind"]): void => {
    setKind(value);
    if (value === "surface") { setLayer("background"); setRenderMode("tile"); }
    else if (value === "decoration") { setLayer("above_player"); setRenderMode("sprite"); }
    else { setLayer("actors"); setRenderMode("sprite"); }
  };
  const technicalOptions = <><label className="field compact"><span>Layer</span><select value={layer} onChange={(event) => setLayer(event.target.value as DungeonAssetImportOptions["layer"])}>{LAYERS.map((value) => <option key={value} value={value}>{friendlyLayer(value)}</option>)}</select></label><label className="field compact"><span>Render mode</span><select value={renderMode} onChange={(event) => setRenderMode(event.target.value as DungeonAssetImportOptions["renderMode"])}>{["sprite", "tile", "stretch"].map((value) => <option key={value}>{value}</option>)}</select></label><div className="field-grid"><NumberField label="World width" value={width} min={1} onChange={setWidth} /><NumberField label="World height" value={height} min={1} onChange={setHeight} /></div>{kind === "portal" ? <p>Portal art is staged without creating a connection.</p> : null}</>;
  return <article className="dungeon-import-card">
    <button type="button" aria-expanded={open} aria-controls="dungeon-add-art-form" disabled={props.disabled} onClick={() => setOpen((value) => !value)}>{props.simple ? "+ Add PNG" : "+ Add art"}</button>
    {open ? <form id="dungeon-add-art-form" aria-label={props.simple ? "Add PNG" : "Add dungeon art"} onSubmit={(event) => { event.preventDefault(); if (file && name.trim()) void props.onImport(file, { displayName: name, prefabId: id, kind, layer, renderMode, defaultWidth: width, defaultHeight: height }).then((imported) => { if (imported) setOpen(false); }); }}>
      <TextField label="Name" value={name} onChange={setName} />
      {!props.simple ? <p>Prefab ID · <code>{id}</code></p> : null}
      <label className="field compact"><span>PNG file</span><input type="file" accept="image/png,.png" required onChange={(event) => { const chosen = event.target.files?.[0] ?? null; setFile(chosen?.type === "image/png" || chosen?.name.toLowerCase().endsWith(".png") ? chosen : null); }} /></label>
      <label className="field compact"><span>{props.simple ? "Use as" : "Kind"}</span><select value={kind} onChange={(event) => chooseKind(event.target.value as DungeonAssetImportOptions["kind"])}><option value="surface">Floor</option><option value="decoration">Decoration</option><option value="object">{props.simple ? "Object" : "Interactable"}</option><option value="portal">{props.simple ? "Door" : "Portal"}</option></select></label>
      {props.simple ? <details><summary>More options</summary><p>Prefab ID · <code>{id}</code></p>{technicalOptions}</details> : technicalOptions}
      <button type="submit" className="primary" disabled={!file || !name.trim()}>{props.simple ? "Add PNG to library" : "Stage PNG & create prefab"}</button>
    </form> : null}
  </article>;
}

function DungeonAssetReplacementCard(props: { prefab: DungeonPrefabDefinition; disabled: boolean; onReplace(file: File, prefab: DungeonPrefabDefinition): Promise<boolean> }) {
  const [file, setFile] = useState<File | null>(null);
  const [open, setOpen] = useState(false);
  return <details className="dungeon-asset-replacement" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}><summary>Replace art · preserve placement</summary><label className="field compact"><span>Replacement PNG</span><input type="file" accept="image/png,.png" disabled={props.disabled} onChange={(event) => { const chosen = event.target.files?.[0] ?? null; setFile(chosen?.type === "image/png" || chosen?.name.toLowerCase().endsWith(".png") ? chosen : null); }} /></label><button type="button" disabled={props.disabled || !file} onClick={() => { if (file) void props.onReplace(file, props.prefab).then((replaced) => { if (replaced) { setFile(null); setOpen(false); } }); }}>Stage replacement</button><small>Collider sizing assistance scales default rectangles; authored object state art and placements keep their IDs.</small></details>;
}

function EncounterEditor(props: { simple: boolean; dungeon: DungeonDefinition; room: DungeonRoomDefinition; rewardTableIds: readonly string[]; bossTemplateIds: readonly string[]; placementEncounterId: string | null; placementWaveIndex: number; onPlacementTarget(encounterId: string, waveIndex: number): void; onUpdateDungeon(edit: (dungeon: DungeonDefinition) => void): void }) {
  const encounters = props.dungeon.encounters.filter((value) => !value.retired && value.roomId === props.room.id);
  const startLogicCount = (encounterId: string): number => props.dungeon.triggers.filter((trigger) => !trigger.retired && trigger.actions.some((action) => action.type === "start_encounter" && action.encounterId === encounterId)).length;
  const update = (id: string, edit: (encounter: DungeonEncounterDefinition) => void): void => props.onUpdateDungeon((dungeon) => { const encounter = dungeon.encounters.find((value) => value.id === id); if (encounter) edit(encounter); });
  const addEncounter = (): void => {
    const id = nextId(`${props.room.id}_encounter`, props.dungeon.encounters.map((encounter) => encounter.id));
    props.onUpdateDungeon((dungeon) => {
    const room = dungeon.rooms.find((candidate) => candidate.id === props.room.id); if (!room) return;
    const boundaryZoneId = nextId("encounter_boundary", room.zones.map((zone) => zone.id));
    const leashZoneId = nextId("leash", [...room.zones.map((zone) => zone.id), boundaryZoneId]);
    const inset = Math.min(80, 20 + encounters.length * 10);
    room.zones.push({ id: boundaryZoneId, retired: false, kind: "rectangle", purpose: "encounter_boundary", x: inset, y: inset, width: Math.max(1, room.width - inset * 2), height: Math.max(1, room.height - inset * 2) });
    room.zones.push({ id: leashZoneId, retired: false, kind: "rectangle", purpose: "leash", x: inset + 20, y: inset + 20, width: Math.max(1, room.width - (inset + 20) * 2), height: Math.max(1, room.height - (inset + 20) * 2) });
    dungeon.encounters.push({ id, retired: false, name: `${room.name} Encounter ${encounters.length + 1}`, roomId: room.id, boundaryZoneId, leashZoneId, waves: [{ id: "wave_1", mobSpawnIds: [], delayMs: 0 }], completion: "all_spawned_mobs_defeated", reset: { onPartyWipe: true, delayMs: 1500 }, retry: { allowed: true, maxAttempts: null }, lockPortalIds: [] });
    });
    props.onPlacementTarget(id, 1);
  };
  const deleteEmptyEncounter = (encounter: DungeonEncounterDefinition): void => props.onUpdateDungeon((dungeon) => { retireEmptyEncounter(dungeon, encounter.id); });
  if (props.simple) return <><div className="divider"><span>ENEMIES IN THIS ROOM</span></div>{encounters.length === 0 ? <p className="empty-copy">Choose Enemies in the steps above, pick an enemy, then click the room.</p> : encounters.map((encounter) => { const enemyCount = props.room.mobs.filter((enemy) => !enemy.retired && enemy.encounterId === encounter.id).length; return <article className="dungeon-recipe-card" key={encounter.id}><strong>{encounter.name}</strong><span>{enemyCount} enemies placed</span><button type="button" onClick={() => props.onPlacementTarget(encounter.id, 1)}>Place more enemies</button>{enemyCount === 0 ? <button type="button" className="danger" onClick={() => deleteEmptyEncounter(encounter)}>Delete empty encounter</button> : null}</article>; })}</>;
  return <><div className="divider"><span>ENCOUNTERS</span></div><button type="button" onClick={addEncounter}>+ Encounter</button>{encounters.length === 0 ? <p className="empty-copy">Click a Mob, then click the room to create an encounter and its first wave.</p> : encounters.map((encounter) => <details className="dungeon-recipe-card" key={encounter.id}><summary>{encounter.name} · {encounter.waves.length} wave{encounter.waves.length === 1 ? "" : "s"}</summary><TextField label="Encounter name" value={encounter.name} onChange={(name) => update(encounter.id, (draft) => { draft.name = name; })} /><p>{startLogicCount(encounter.id)} start logic recipe{startLogicCount(encounter.id) === 1 ? "" : "s"} · edit in Logic</p><details><summary>Advanced boundaries and leash</summary><label className="field compact"><span>Boundary</span><select value={encounter.boundaryZoneId} onChange={(event) => update(encounter.id, (draft) => { draft.boundaryZoneId = event.target.value; })}>{props.room.zones.filter((value) => !value.retired && value.purpose === "encounter_boundary").map((value) => <option key={value.id}>{value.id}</option>)}</select></label><label className="field compact"><span>Leash</span><select value={encounter.leashZoneId} onChange={(event) => update(encounter.id, (draft) => { draft.leashZoneId = event.target.value; })}>{props.room.zones.filter((value) => !value.retired && value.purpose === "leash").map((value) => <option key={value.id}>{value.id}</option>)}</select></label></details>{encounter.waves.map((wave, index) => <div className="dungeon-wave" key={wave.id}><strong>Wave {index + 1}</strong><button type="button" aria-pressed={props.placementEncounterId === encounter.id && props.placementWaveIndex === index + 1} onClick={() => props.onPlacementTarget(encounter.id, index + 1)}>{props.placementEncounterId === encounter.id && props.placementWaveIndex === index + 1 ? `Placing mobs here · Wave ${index + 1}` : `Place mobs here · Wave ${index + 1}`}</button><small>{wave.mobSpawnIds.length} mob placements</small><details><summary>Advanced wave timing</summary><NumberField label={`Wave ${index + 1} delay (seconds)`} value={wave.delayMs / 1000} step={0.1} min={0} onChange={(seconds) => update(encounter.id, (draft) => { draft.waves[index]!.delayMs = Math.round(seconds * 1000); })} /></details>{encounter.waves.length > 1 ? <button type="button" onClick={() => props.onUpdateDungeon((dungeon) => removeEncounterWave(dungeon, encounter.id, index + 1))}>Remove wave {index + 1} · move mobs safely</button> : null}</div>)}<button type="button" onClick={() => props.onPlacementTarget(encounter.id, encounter.waves.length + 1)}>+ Wave · choose first mob for Wave {encounter.waves.length + 1}</button>{props.room.mobs.filter((mob) => !mob.retired && mob.encounterId === encounter.id).map((mob) => <label className="field compact" key={`${encounter.id}:${mob.id}`}><span>Wave for {mob.id}</span><select value={mob.waveIndex} onChange={(event) => props.onUpdateDungeon((dungeon) => assignMobToEncounterWave(dungeon, props.room.id, mob.id, encounter.id, Number(event.target.value)))}>{encounter.waves.map((wave, index) => <option key={wave.id} value={index + 1}>Wave {index + 1}</option>)}</select></label>)}<div className="dungeon-lock-portals"><span>Lock portals while active</span>{props.dungeon.portals.filter((value) => !value.retired).map((portal) => <label className="toggle" key={portal.id}><input type="checkbox" checked={encounter.lockPortalIds.includes(portal.id)} onChange={(event) => update(encounter.id, (draft) => { draft.lockPortalIds = event.target.checked ? [...draft.lockPortalIds, portal.id] : draft.lockPortalIds.filter((value) => value !== portal.id); })} /><span>{portal.interactionLabel}</span></label>)}</div><details><summary>Advanced encounter settings</summary><div className="field-grid"><NumberField label="Wipe reset delay" value={encounter.reset.delayMs} min={0} onChange={(delayMs) => update(encounter.id, (draft) => { draft.reset.delayMs = delayMs; })} /><NumberField label="Max attempts" value={encounter.retry.maxAttempts ?? 1} min={1} onChange={(maxAttempts) => update(encounter.id, (draft) => { draft.retry.maxAttempts = Math.round(maxAttempts); })} /></div><label className="toggle"><input type="checkbox" checked={encounter.reset.onPartyWipe} onChange={(event) => update(encounter.id, (draft) => { draft.reset.onPartyWipe = event.target.checked; })} /><span>Reset on party wipe</span></label><label className="toggle"><input type="checkbox" checked={encounter.retry.allowed} onChange={(event) => update(encounter.id, (draft) => { draft.retry.allowed = event.target.checked; })} /><span>Retry allowed</span></label><p>Encounter rewards are added in Logic as a grant reward action.</p><ManifestSelect label="Boss template" value={encounter.bossTemplateId ?? ""} values={props.bossTemplateIds} onChange={(value) => props.onUpdateDungeon((dungeon) => { const draft = dungeon.encounters.find((candidate) => candidate.id === encounter.id)!; draft.bossTemplateId = value || undefined; if (value && !dungeon.bossTemplateIds.includes(value)) dungeon.bossTemplateIds.push(value); })} /><p role={encounter.bossTemplateId && props.room.mobs.filter((mob) => !mob.retired && mob.encounterId === encounter.id && !mob.summonedByMobSpawnId).length !== 1 ? "alert" : undefined}>Boss rule: a boss encounter has exactly one non-summoned mob (the boss). Put trash waves in a separate encounter and start the boss when it completes.{encounter.bossTemplateId && props.room.mobs.filter((mob) => !mob.retired && mob.encounterId === encounter.id && !mob.summonedByMobSpawnId).length !== 1 ? ` This encounter currently has ${props.room.mobs.filter((mob) => !mob.retired && mob.encounterId === encounter.id && !mob.summonedByMobSpawnId).length}.` : ""}</p>{props.room.mobs.some((mob) => !mob.retired && mob.encounterId === encounter.id) ? <p>Reassign or retire this encounter’s active mobs before retiring it.</p> : null}<button type="button" disabled={props.room.mobs.some((mob) => !mob.retired && mob.encounterId === encounter.id)} onClick={() => deleteEmptyEncounter(encounter)}>Delete empty encounter</button></details></details>)}</>;
}

const TRIGGER_EVENTS: DungeonTriggerDefinition["event"]["type"][] = ["room_enter", "room_exit", "zone_enter", "zone_exit", "all_players_present", "object_interact", "object_state", "object_sequence", "portal_used", "timer", "encounter_state", "room_clear", "object_destroyed", "player_count", "dungeon_flag"];
const TRIGGER_ACTIONS: DungeonTriggerDefinition["actions"][number]["type"][] = ["start_encounter", "start_wave", "set_object_state", "set_object_available", "set_portal_locked", "enable_trigger", "play_cue", "show_message", "set_dungeon_flag", "grant_reward", "complete_dungeon"];
const TRIGGER_CONDITIONS: DungeonTriggerDefinition["conditions"]["items"][number]["type"][] = ["encounter_state", "object_state", "dungeon_flag", "player_count", "item_owned", "quest_flag"];

function defaultTriggerCondition(type: DungeonTriggerDefinition["conditions"]["items"][number]["type"], dungeon: DungeonDefinition, room: DungeonRoomDefinition): DungeonTriggerDefinition["conditions"]["items"][number] {
  const encounterId = dungeon.encounters.find((value) => !value.retired)?.id ?? "missing_encounter";
  const objectId = room.objects.find((value) => !value.retired)?.id ?? "missing_object";
  switch (type) {
    case "encounter_state": return { type, encounterId, state: "completed" };
    case "object_state": return { type, roomId: room.id, objectId, state: "open" };
    case "player_count": return { type, operator: "at_least", count: 1 };
    case "item_owned": return { type, itemId: "item", quantity: 1 };
    case "quest_flag": return { type, flagId: "quest_flag", value: true };
    case "dungeon_flag": return { type, flagId: "dungeon_flag", value: true };
  }
}

const OBJECT_STATES = ["idle", "open", "closed", "on", "off", "pressed", "released", "intact", "destroyed", "looted"] as const;
const ENCOUNTER_STATES = ["idle", "active", "completed", "failed", "resetting"] as const;
const COUNT_OPERATORS = ["at_least", "at_most", "exactly"] as const;

function ReferenceSelect(props: { label: string; value: string; values: Array<{ id: string; name?: string }>; onChange(value: string): void }) {
  return <label className="field compact"><span>{props.label}</span><select value={props.value} onChange={(event) => props.onChange(event.target.value)}>{props.values.length === 0 ? <option value="">No valid references available</option> : props.values.map((value) => <option key={value.id} value={value.id}>{value.name ?? value.id}</option>)}</select></label>;
}

function ManifestSelect(props: { label: string; value: string; values: readonly string[]; onChange(value: string): void }) {
  return <><label className="field compact"><span>{props.label}</span><select value={props.value} onChange={(event) => props.onChange(event.target.value)}><option value="">None</option>{props.values.map((value) => <option key={value} value={value}>{value}</option>)}</select>{props.values.length === 0 ? <small>No catalog manifest entries are available.</small> : null}</label>{props.label === "Boss template" ? <p className="dungeon-authority-note">Boss template encounters need exactly one active non-summoned boss; summoned adds are allowed. Put normal guards in a separate encounter.</p> : null}</>;
}

function TriggerEventParameters(props: { value: DungeonTriggerDefinition["event"]; dungeon: DungeonDefinition; room: DungeonRoomDefinition; onChange(value: DungeonTriggerDefinition["event"]): void }) {
  const value = props.value;
  const legacyType = (value as unknown as { type: string }).type;
  if (legacyType === "item_owned" || legacyType === "quest_flag") return <p className="dungeon-authority-note">This legacy event is preserved but is not supported by runtime matching. Choose a supported event before enabling the recipe.</p>;
  const rooms = props.dungeon.rooms.filter((room) => !room.retired).map((room) => ({ id: room.id, name: room.name }));
  const selectedRoom = "roomId" in value ? props.dungeon.rooms.find((room) => room.id === value.roomId) ?? props.room : props.room;
  const objects = selectedRoom.objects.filter((object) => !object.retired).map((object) => ({ id: object.id, name: object.name }));
  const zones = selectedRoom.zones.filter((zone) => !zone.retired).map((zone) => ({ id: zone.id }));
  if (value.type === "room_enter" || value.type === "room_exit" || value.type === "room_clear") return <ReferenceSelect label="Event room" value={value.roomId} values={rooms} onChange={(roomId) => props.onChange({ ...value, roomId })} />;
  if (value.type === "zone_enter" || value.type === "zone_exit" || value.type === "all_players_present") return <div className="field-grid"><ReferenceSelect label="Event room" value={value.roomId} values={rooms} onChange={(roomId) => { const room = props.dungeon.rooms.find((candidate) => candidate.id === roomId); props.onChange({ ...value, roomId, zoneId: room?.zones.find((zone) => !zone.retired)?.id ?? "missing_zone" }); }} /><ReferenceSelect label="Event zone" value={value.zoneId} values={zones} onChange={(zoneId) => props.onChange({ ...value, zoneId })} /></div>;
  if (value.type === "object_interact" || value.type === "object_destroyed") return <div className="field-grid"><ReferenceSelect label="Event room" value={value.roomId} values={rooms} onChange={(roomId) => { const room = props.dungeon.rooms.find((candidate) => candidate.id === roomId); props.onChange({ ...value, roomId, objectId: room?.objects.find((object) => !object.retired)?.id ?? "missing_object" }); }} /><ReferenceSelect label="Event object" value={value.objectId} values={objects} onChange={(objectId) => props.onChange({ ...value, objectId })} /></div>;
  if (value.type === "object_state") return <><div className="field-grid"><ReferenceSelect label="Event room" value={value.roomId} values={rooms} onChange={(roomId) => { const room = props.dungeon.rooms.find((candidate) => candidate.id === roomId); props.onChange({ ...value, roomId, objectId: room?.objects.find((object) => !object.retired)?.id ?? "missing_object" }); }} /><ReferenceSelect label="Event object" value={value.objectId} values={objects} onChange={(objectId) => props.onChange({ ...value, objectId })} /></div><EnumSelect label="Required object state" value={value.state} values={OBJECT_STATES} onChange={(state) => props.onChange({ ...value, state })} /></>;
  if (value.type === "object_sequence") return <><ReferenceSelect label="Event room" value={value.roomId} values={rooms} onChange={(roomId) => { const room = props.dungeon.rooms.find((candidate) => candidate.id === roomId); props.onChange({ ...value, roomId, objectIds: room?.objects.filter((object) => !object.retired).slice(0, 1).map((object) => object.id) ?? [] }); }} /><div className="dungeon-reference-checks"><span>Object sequence</span>{objects.map((object) => <label className="toggle" key={object.id}><input type="checkbox" checked={value.objectIds.includes(object.id)} onChange={(event) => props.onChange({ ...value, objectIds: event.target.checked ? [...value.objectIds, object.id] : value.objectIds.filter((id) => id !== object.id) })} /><span>{object.name}</span></label>)}</div></>;
  if (value.type === "portal_used") return <ReferenceSelect label="Event portal" value={value.portalId} values={props.dungeon.portals.filter((portal) => !portal.retired).map((portal) => ({ id: portal.id, name: portal.interactionLabel }))} onChange={(portalId) => props.onChange({ ...value, portalId })} />;
  if (value.type === "timer") return <NumberField label="Timer delay ms" value={value.delayMs} min={0} onChange={(delayMs) => props.onChange({ ...value, delayMs })} />;
  if (value.type === "encounter_state") return <div className="field-grid"><ReferenceSelect label="Event encounter" value={value.encounterId} values={props.dungeon.encounters.filter((encounter) => !encounter.retired).map((encounter) => ({ id: encounter.id, name: encounter.name }))} onChange={(encounterId) => props.onChange({ ...value, encounterId })} /><EnumSelect label="Encounter state" value={value.state} values={ENCOUNTER_STATES} onChange={(state) => props.onChange({ ...value, state })} /></div>;
  if (value.type === "player_count") return <div className="field-grid"><EnumSelect label="Player count rule" value={value.operator} values={COUNT_OPERATORS} onChange={(operator) => props.onChange({ ...value, operator })} /><NumberField label="Player count" value={value.count} min={0} onChange={(count) => props.onChange({ ...value, count: Math.round(count) })} /></div>;
  return <><TextField label="Dungeon flag ID" value={value.flagId} onChange={(flagId) => props.onChange({ ...value, flagId: safeDungeonId(flagId) })} /><BooleanSelect label="Required flag value" value={value.value} onChange={(flagValue) => props.onChange({ ...value, value: flagValue })} /></>;
}

function TriggerConditionParameters(props: { value: DungeonTriggerDefinition["conditions"]["items"][number]; dungeon: DungeonDefinition; room: DungeonRoomDefinition; onChange(value: DungeonTriggerDefinition["conditions"]["items"][number]): void }) {
  const value = props.value;
  if (value.type === "encounter_state") return <div className="field-grid"><ReferenceSelect label="Condition encounter" value={value.encounterId} values={props.dungeon.encounters.filter((encounter) => !encounter.retired).map((encounter) => ({ id: encounter.id, name: encounter.name }))} onChange={(encounterId) => props.onChange({ ...value, encounterId })} /><EnumSelect label="Condition state" value={value.state} values={ENCOUNTER_STATES} onChange={(state) => props.onChange({ ...value, state })} /></div>;
  if (value.type === "object_state") { const room = props.dungeon.rooms.find((candidate) => candidate.id === value.roomId) ?? props.room; return <><div className="field-grid"><ReferenceSelect label="Condition room" value={value.roomId} values={props.dungeon.rooms.filter((candidate) => !candidate.retired).map((candidate) => ({ id: candidate.id, name: candidate.name }))} onChange={(roomId) => { const next = props.dungeon.rooms.find((candidate) => candidate.id === roomId); props.onChange({ ...value, roomId, objectId: next?.objects.find((object) => !object.retired)?.id ?? "missing_object" }); }} /><ReferenceSelect label="Condition object" value={value.objectId} values={room.objects.filter((object) => !object.retired).map((object) => ({ id: object.id, name: object.name }))} onChange={(objectId) => props.onChange({ ...value, objectId })} /></div><EnumSelect label="Condition object state" value={value.state} values={OBJECT_STATES} onChange={(state) => props.onChange({ ...value, state })} /></>; }
  if (value.type === "player_count") return <div className="field-grid"><EnumSelect label="Condition count rule" value={value.operator} values={COUNT_OPERATORS} onChange={(operator) => props.onChange({ ...value, operator })} /><NumberField label="Condition player count" value={value.count} min={0} onChange={(count) => props.onChange({ ...value, count: Math.round(count) })} /></div>;
  if (value.type === "item_owned") return <><TextField label="Condition item ID" value={value.itemId} onChange={(itemId) => props.onChange({ ...value, itemId: safeDungeonId(itemId) })} /><NumberField label="Condition quantity" value={value.quantity} min={1} onChange={(quantity) => props.onChange({ ...value, quantity: Math.max(1, Math.round(quantity)) })} /><p className="dungeon-authority-note">Item authority is not exposed to Appearance Studio; enter an existing item ID.</p></>;
  return <><TextField label={value.type === "quest_flag" ? "Condition quest flag ID" : "Condition dungeon flag ID"} value={value.flagId} onChange={(flagId) => props.onChange({ ...value, flagId: safeDungeonId(flagId) })} /><BooleanSelect label="Condition flag value" value={value.value} onChange={(flagValue) => props.onChange({ ...value, value: flagValue })} />{value.type === "quest_flag" ? <p className="dungeon-authority-note">Quest authority is not exposed to Appearance Studio; enter an existing quest flag ID.</p> : null}</>;
}

function TriggerActionParameters(props: { value: DungeonTriggerDefinition["actions"][number]; dungeon: DungeonDefinition; room: DungeonRoomDefinition; rewardTableIds: readonly string[]; onChange(value: DungeonTriggerDefinition["actions"][number]): void }) {
  const value = props.value;
  const encounters = props.dungeon.encounters.filter((encounter) => !encounter.retired);
  if (value.type === "start_encounter") return <ReferenceSelect label="Encounter to start" value={value.encounterId} values={encounters.map((encounter) => ({ id: encounter.id, name: encounter.name }))} onChange={(encounterId) => props.onChange({ ...value, encounterId })} />;
  if (value.type === "start_wave") { const encounter = encounters.find((candidate) => candidate.id === value.encounterId) ?? encounters[0]; return <div className="field-grid"><ReferenceSelect label="Wave encounter" value={value.encounterId} values={encounters.map((candidate) => ({ id: candidate.id, name: candidate.name }))} onChange={(encounterId) => { const next = encounters.find((candidate) => candidate.id === encounterId); props.onChange({ ...value, encounterId, waveId: next?.waves[0]?.id ?? "missing_wave" }); }} /><ReferenceSelect label="Wave to start" value={value.waveId} values={encounter?.waves.map((wave) => ({ id: wave.id })) ?? []} onChange={(waveId) => props.onChange({ ...value, waveId })} /></div>; }
  if (value.type === "set_object_state" || value.type === "set_object_available") { const room = props.dungeon.rooms.find((candidate) => candidate.id === value.roomId) ?? props.room; const roomAndObject = <div className="field-grid"><ReferenceSelect label="Action room" value={value.roomId} values={props.dungeon.rooms.filter((candidate) => !candidate.retired).map((candidate) => ({ id: candidate.id, name: candidate.name }))} onChange={(roomId) => { const next = props.dungeon.rooms.find((candidate) => candidate.id === roomId); props.onChange({ ...value, roomId, objectId: next?.objects.find((object) => !object.retired)?.id ?? "missing_object" }); }} /><ReferenceSelect label={value.type === "set_object_available" ? "Object availability target" : "Object to change"} value={value.objectId} values={room.objects.filter((object) => !object.retired).map((object) => ({ id: object.id, name: object.name }))} onChange={(objectId) => props.onChange({ ...value, objectId })} /></div>; return value.type === "set_object_state" ? <>{roomAndObject}<EnumSelect label="New object state" value={value.state} values={OBJECT_STATES} onChange={(state) => props.onChange({ ...value, state })} /></> : <>{roomAndObject}<BooleanSelect label="Object available" value={value.available} onChange={(available) => props.onChange({ ...value, available })} /></>; }
  if (value.type === "set_portal_locked") return <div className="field-grid"><ReferenceSelect label="Portal to lock" value={value.portalId} values={props.dungeon.portals.filter((portal) => !portal.retired).map((portal) => ({ id: portal.id, name: portal.interactionLabel }))} onChange={(portalId) => props.onChange({ ...value, portalId })} /><BooleanSelect label="Locked" value={value.locked} onChange={(locked) => props.onChange({ ...value, locked })} /></div>;
  if (value.type === "enable_trigger") return <div className="field-grid"><ReferenceSelect label="Trigger to change" value={value.triggerId} values={props.dungeon.triggers.filter((trigger) => !trigger.retired).map((trigger) => ({ id: trigger.id }))} onChange={(triggerId) => props.onChange({ ...value, triggerId })} /><BooleanSelect label="Trigger enabled" value={value.enabled} onChange={(enabled) => props.onChange({ ...value, enabled })} /></div>;
  if (value.type === "show_message") return <div className="field-grid"><TextField label="Message" value={value.text} onChange={(text) => props.onChange({ ...value, text: text.slice(0, DUNGEON_MESSAGE_MAX_LENGTH) })} /><EnumSelect label="Tone" value={value.tone ?? "info"} values={DUNGEON_NOTICE_TONES} onChange={(tone) => props.onChange({ ...value, tone })} /><p className="dungeon-recipe-result">Shown to players as a short HUD notice ({value.text.length}/{DUNGEON_MESSAGE_MAX_LENGTH}). It replaces the automatic notice for the same trigger.</p></div>;
  if (value.type === "play_cue") return <TextField label="Cue ID" value={value.cueId} onChange={(cueId) => props.onChange({ ...value, cueId: safeDungeonId(cueId) })} />;
  if (value.type === "set_dungeon_flag") return <div className="field-grid"><TextField label="Dungeon flag ID" value={value.flagId} onChange={(flagId) => props.onChange({ ...value, flagId: safeDungeonId(flagId) })} /><BooleanSelect label="Flag value" value={value.value} onChange={(flagValue) => props.onChange({ ...value, value: flagValue })} /></div>;
  if (value.type === "grant_reward") return <ManifestSelect label="Reward to grant" value={value.rewardTableId} values={props.rewardTableIds} onChange={(rewardTableId) => props.onChange({ ...value, rewardTableId })} />;
  return <p className="dungeon-recipe-result">Completes this dungeon instance.</p>;
}

function EnumSelect<T extends string>(props: { label: string; value: T; values: readonly T[]; onChange(value: T): void }) { return <label className="field compact"><span>{props.label}</span><select value={props.value} onChange={(event) => props.onChange(event.target.value as T)}>{props.values.map((value) => <option key={value} value={value}>{value.replace(/_/gu, " ")}</option>)}</select></label>; }
function BooleanSelect(props: { label: string; value: boolean; onChange(value: boolean): void }) { return <label className="field compact"><span>{props.label}</span><select value={String(props.value)} onChange={(event) => props.onChange(event.target.value === "true")}><option value="true">Yes</option><option value="false">No</option></select></label>; }

function TriggerActionsEditor(props: { actions: DungeonTriggerDefinition["actions"]; dungeon: DungeonDefinition; room: DungeonRoomDefinition; rewardTableIds: readonly string[]; onChange(actions: DungeonTriggerDefinition["actions"]): void }) {
  const replace = (index: number, action: DungeonTriggerDefinition["actions"][number]): void => {
    const actions = [...props.actions]; actions[index] = action; props.onChange(actions);
  };
  const move = (index: number, direction: -1 | 1): void => {
    const target = index + direction; if (target < 0 || target >= props.actions.length) return;
    const actions = [...props.actions]; [actions[index], actions[target]] = [actions[target]!, actions[index]!]; props.onChange(actions);
  };
  return <section className="dungeon-trigger-actions" aria-label="Ordered trigger actions">
    {props.actions.map((action, index) => <article className="dungeon-condition" key={`${index}:${action.type}`}>
      <label className="field compact"><span>Action {index + 1} type</span><select value={action.type} onChange={(event) => {
        const next = defaultTriggerAction(event.target.value as DungeonTriggerDefinition["actions"][number]["type"], props.dungeon, props.room);
        if (next.type === "grant_reward" && props.rewardTableIds[0]) next.rewardTableId = props.rewardTableIds[0];
        replace(index, next);
      }}>{TRIGGER_ACTIONS.map((value) => <option key={value} value={value}>{value.replace(/_/gu, " ")}</option>)}</select></label>
      <TriggerActionParameters value={action} dungeon={props.dungeon} room={props.room} rewardTableIds={props.rewardTableIds} onChange={(value) => replace(index, value)} />
      <div className="dungeon-author-actions">
        <button type="button" disabled={index === 0} onClick={() => move(index, -1)}>Move action {index + 1} up</button>
        <button type="button" disabled={index === props.actions.length - 1} onClick={() => move(index, 1)}>Move action {index + 1} down</button>
        <button type="button" disabled={props.actions.length === 1} onClick={() => props.onChange(props.actions.filter((_, actionIndex) => actionIndex !== index))}>Remove action {index + 1}</button>
      </div>
    </article>)}
    <button type="button" onClick={() => props.onChange([...props.actions, { type: "play_cue", cueId: "authoring_placeholder" }])}>+ Action</button>
  </section>;
}

function TriggerRecipeEditor(props: { dungeon: DungeonDefinition; room: DungeonRoomDefinition; rewardTableIds: readonly string[]; onUpdateDungeon(edit: (dungeon: DungeonDefinition) => void): void }) {
  const [chooserOpen, setChooserOpen] = useState(false);
  const [showOtherRecipes, setShowOtherRecipes] = useState(false);
  const [editingRecipeId, setEditingRecipeId] = useState<string | null>(null);
  useEffect(() => { setEditingRecipeId(null); setShowOtherRecipes(false); setChooserOpen(false); }, [props.room.id]);
  const roomEncounters = props.dungeon.encounters.filter((value) => !value.retired && value.roomId === props.room.id);
  const encounter = roomEncounters[0]; const previousEncounter = roomEncounters[1];
  const object = props.room.objects.find((value) => !value.retired && value.type !== "portal");
  const exitPortal = props.dungeon.portals.find((value) => !value.retired && value.source.kind === "room" && value.source.roomId === props.room.id);
  const boundaryZone = encounter ? props.room.zones.find((value) => !value.retired && value.id === encounter.boundaryZoneId) : undefined;
  const add = (template: "area" | "object" | "room" | "previous" | "unlock" | "custom"): void => {
    const id = nextId("trigger", props.dungeon.triggers.map((value) => value.id));
    props.onUpdateDungeon((dungeon) => {
      let event: DungeonTriggerDefinition["event"] = { type: "room_enter", roomId: props.room.id };
      let action: DungeonTriggerDefinition["actions"][number] = { type: "play_cue", cueId: "authoring_placeholder" };
      if (template === "area" && encounter && boundaryZone) { event = { type: "zone_enter", roomId: props.room.id, zoneId: boundaryZone.id }; action = { type: "start_encounter", encounterId: encounter.id }; }
      if (template === "object" && encounter && object) { event = { type: "object_interact", roomId: props.room.id, objectId: object.id }; action = { type: "start_encounter", encounterId: encounter.id }; }
      if (template === "room" && encounter) action = { type: "start_encounter", encounterId: encounter.id };
      if (template === "previous" && encounter && previousEncounter) { event = { type: "encounter_state", encounterId: previousEncounter.id, state: "completed" }; action = { type: "start_encounter", encounterId: encounter.id }; }
      if (template === "unlock" && exitPortal) { event = { type: "room_clear", roomId: props.room.id }; action = { type: "set_portal_locked", portalId: exitPortal.id, locked: false }; }
      dungeon.triggers.push({ id, retired: false, enabled: template !== "custom", scope: "party", repetition: "once", cooldownMs: 0, event, conditions: { mode: "all", items: [] }, actions: [action] });
    });
    setEditingRecipeId(id);
    setShowOtherRecipes(false);
    setChooserOpen(false);
  };
  const update = (triggerId: string, edit: (trigger: DungeonTriggerDefinition, dungeon: DungeonDefinition) => void): void => props.onUpdateDungeon((dungeon) => { const trigger = dungeon.triggers.find((value) => value.id === triggerId); if (trigger) edit(trigger, dungeon); });
  const duplicateRecipe = (trigger: DungeonTriggerDefinition): void => {
    const id = nextId(`${trigger.id}_copy`, props.dungeon.triggers.map((value) => value.id));
    props.onUpdateDungeon((dungeon) => { dungeon.triggers.push({ ...structuredClone(trigger), id, retired: false }); });
    setEditingRecipeId(id);
    setShowOtherRecipes(false);
  };
  const retireRecipe = (triggerId: string): void => {
    update(triggerId, (trigger) => { trigger.retired = true; trigger.enabled = false; });
    if (editingRecipeId === triggerId) setEditingRecipeId(null);
  };
  const belongsToCurrentRoom = (trigger: DungeonTriggerDefinition): boolean => {
    const event = trigger.event;
    if ("roomId" in event) return event.roomId === props.room.id;
    if (event.type === "encounter_state") return props.dungeon.encounters.find((value) => value.id === event.encounterId)?.roomId === props.room.id;
    if (event.type === "portal_used") { const portal = props.dungeon.portals.find((value) => value.id === event.portalId); return portal?.source.kind === "room" && portal.source.roomId === props.room.id; }
    return trigger.actions.some((action) => {
      if (action.type === "start_encounter" || action.type === "start_wave") return props.dungeon.encounters.find((value) => value.id === action.encounterId)?.roomId === props.room.id;
      if (action.type === "set_object_state" || action.type === "set_object_available") return action.roomId === props.room.id;
      if (action.type === "set_portal_locked") { const portal = props.dungeon.portals.find((value) => value.id === action.portalId); return portal?.source.kind === "room" && portal.source.roomId === props.room.id; }
      return false;
    });
  };
  const activeRecipes = props.dungeon.triggers.filter((value) => !value.retired);
  const currentRecipes = activeRecipes.filter((value) => value.id === editingRecipeId || belongsToCurrentRoom(value));
  const otherRecipes = activeRecipes.filter((value) => value.id !== editingRecipeId && !belongsToCurrentRoom(value));
  const visibleRecipes = showOtherRecipes ? otherRecipes : currentRecipes;
  return <><div className="divider"><span>TRIGGER RECIPES</span></div><button type="button" aria-expanded={chooserOpen} onClick={() => setChooserOpen((value) => !value)}>+ Trigger recipe</button>{chooserOpen ? <section className="dungeon-trigger-templates" aria-label="Trigger recipe templates"><p>Choose a safe starting recipe. Nothing is created until you choose.</p><button type="button" disabled={!encounter || !boundaryZone} onClick={() => add("area")}>Player enters encounter area → Start encounter</button><button type="button" disabled={!encounter || !object} onClick={() => add("object")}>Object or button used → Start encounter</button><button type="button" disabled={!encounter} onClick={() => add("room")}>Room entered → Start encounter</button><button type="button" disabled={!encounter || !previousEncounter} onClick={() => add("previous")}>Previous encounter clears → Start encounter</button><button type="button" disabled={!exitPortal} onClick={() => add("unlock")}>Room clears → Unlock an exit</button><button type="button" onClick={() => add("custom")}>Custom advanced · disabled</button></section> : null}<div className="dungeon-recipe-groups"><strong>{showOtherRecipes ? "Other room and global recipes" : `This room · ${currentRecipes.length}`}</strong>{otherRecipes.length > 0 ? <details><summary>Other room and global recipes · {otherRecipes.length}</summary><button type="button" onClick={() => setShowOtherRecipes((value) => !value)}>{showOtherRecipes ? "Back to this room" : "Edit other recipes"}</button></details> : null}</div>{visibleRecipes.map((trigger) => <details className="dungeon-recipe-card" key={trigger.id}><summary>When {trigger.event.type.replace(/_/gu, " ")} → {trigger.actions[0]!.type.replace(/_/gu, " ")}{trigger.actions.length > 1 ? ` (+${trigger.actions.length - 1} more)` : ""}</summary><div className="dungeon-author-actions"><button type="button" onClick={() => duplicateRecipe(trigger)}>Duplicate recipe</button><button type="button" className="danger" onClick={() => retireRecipe(trigger.id)}>Retire recipe</button></div><div className="dungeon-recipe-flow"><label className="field compact"><span>When this happens</span><select value={trigger.event.type} onChange={(event) => update(trigger.id, (draft, dungeon) => { draft.event = defaultTriggerEvent(event.target.value as DungeonTriggerDefinition["event"]["type"], dungeon, props.room); })}>{!TRIGGER_EVENTS.includes(trigger.event.type) ? <option value={trigger.event.type}>{trigger.event.type.replace(/_/gu, " ")} · legacy unsupported event</option> : null}{TRIGGER_EVENTS.map((value) => <option key={value} value={value}>{value.replace(/_/gu, " ")}</option>)}</select></label><span aria-hidden="true">→</span><span>{trigger.actions.length} ordered {trigger.actions.length === 1 ? "action" : "actions"}</span></div><TriggerEventParameters value={trigger.event} dungeon={props.dungeon} room={props.room} onChange={(value) => update(trigger.id, (draft) => { draft.event = value; })} /><TriggerActionsEditor actions={trigger.actions} dungeon={props.dungeon} room={props.room} rewardTableIds={props.rewardTableIds} onChange={(actions) => update(trigger.id, (draft, dungeon) => { draft.actions = actions; for (const action of actions) if (action.type === "grant_reward" && action.rewardTableId && !dungeon.rewardTableIds.includes(action.rewardTableId)) dungeon.rewardTableIds.push(action.rewardTableId); })} /><details><summary>Advanced recipe controls</summary><div className="field-grid"><label className="field compact"><span>Scope</span><select value={trigger.scope} onChange={(event) => update(trigger.id, (draft) => { draft.scope = event.target.value as DungeonTriggerDefinition["scope"]; })}>{["player", "party", "instance"].map((value) => <option key={value}>{value}</option>)}</select></label><label className="field compact"><span>Repeat</span><select value={trigger.repetition} onChange={(event) => update(trigger.id, (draft) => { draft.repetition = event.target.value as DungeonTriggerDefinition["repetition"]; })}>{["once", "repeat", "cooldown"].map((value) => <option key={value}>{value}</option>)}</select></label><NumberField label="Cooldown ms" value={trigger.cooldownMs} min={0} onChange={(cooldownMs) => update(trigger.id, (draft) => { draft.cooldownMs = cooldownMs; })} /></div><label className="field compact"><span>Condition match</span><select value={trigger.conditions.mode} onChange={(event) => update(trigger.id, (draft) => { draft.conditions.mode = event.target.value as "all" | "any"; })}><option value="all">All conditions</option><option value="any">Any condition</option></select></label>{trigger.conditions.items.map((condition, index) => <div className="dungeon-condition" key={`${trigger.id}:condition:${index}`}><label className="field compact"><span>Condition type</span><select value={condition.type} onChange={(event) => update(trigger.id, (draft, dungeon) => { draft.conditions.items[index] = defaultTriggerCondition(event.target.value as DungeonTriggerDefinition["conditions"]["items"][number]["type"], dungeon, props.room); })}>{TRIGGER_CONDITIONS.map((value) => <option key={value} value={value}>{value.replace(/_/gu, " ")}</option>)}</select></label><TriggerConditionParameters value={condition} dungeon={props.dungeon} room={props.room} onChange={(value) => update(trigger.id, (draft) => { draft.conditions.items[index] = value; })} /><button type="button" onClick={() => update(trigger.id, (draft) => { draft.conditions.items.splice(index, 1); })}>Remove condition</button></div>)}<button type="button" onClick={() => update(trigger.id, (draft, dungeon) => { draft.conditions.items.push(defaultTriggerCondition("dungeon_flag", dungeon, props.room)); })}>+ Condition</button><label className="toggle"><input type="checkbox" checked={trigger.enabled} onChange={(event) => update(trigger.id, (draft) => { draft.enabled = event.target.checked; })} /><span>Recipe enabled</span></label></details></details>)}</>;
}

function PortalGateEditor(props: { dungeon: DungeonDefinition; writesAllowed: boolean; onUpdateDungeon(edit: (dungeon: DungeonDefinition) => void): void }) {
  type Gate = NonNullable<DungeonDefinition["portals"][number]["gates"]>[number];
  const portals = props.dungeon.portals.filter((portal) => !portal.retired);
  const addGate = (portalId: string): void => props.onUpdateDungeon((dungeon) => {
    const portal = dungeon.portals.find((candidate) => candidate.id === portalId);
    if (portal) portal.gates = [...(portal.gates ?? []), { type: "dungeon_flag", flagId: "required_flag", value: true }];
  });
  const updateGate = (portalId: string, index: number, edit: (gate: Gate) => Gate): void => props.onUpdateDungeon((dungeon) => {
    const portal = dungeon.portals.find((candidate) => candidate.id === portalId);
    if (!portal?.gates?.[index]) return;
    portal.gates[index] = edit(portal.gates[index]!);
  });
  return <section className="dungeon-resource-editor" aria-label="Portal condition gates"><PanelHeading title="Portal condition gates" meta="Fail closed at runtime" /><p className="dungeon-authority-note">Gates use production dungeon flags, inventory ownership, and quest flags. A missing authority denies traversal.</p>{portals.map((portal) => <details className="dungeon-resource-card" key={portal.id}><summary>{portal.interactionLabel} · {portal.gates?.length ?? 0} gate{portal.gates?.length === 1 ? "" : "s"}</summary>{(portal.gates ?? []).map((gate, index) => <div className="dungeon-condition" key={`${portal.id}:gate:${index}`}><label className="field compact"><span>Gate type</span><select disabled={!props.writesAllowed} value={gate.type} onChange={(event) => updateGate(portal.id, index, () => event.target.value === "item_owned" ? { type: "item_owned", itemId: "required_item", quantity: 1 } : { type: event.target.value as "dungeon_flag" | "quest_flag", flagId: "required_flag", value: true })}><option value="dungeon_flag">Dungeon flag</option><option value="item_owned">Item owned</option><option value="quest_flag">Quest flag</option></select></label>{gate.type === "item_owned" ? <div className="field-grid"><TextField label="Item ID" value={gate.itemId} disabled={!props.writesAllowed} onChange={(itemId) => updateGate(portal.id, index, (current) => current.type === "item_owned" ? { ...current, itemId: safeDungeonId(itemId) } : current)} /><NumberField label="Quantity" value={gate.quantity} min={1} disabled={!props.writesAllowed} onChange={(quantity) => updateGate(portal.id, index, (current) => current.type === "item_owned" ? { ...current, quantity: Math.max(1, Math.round(quantity)) } : current)} /></div> : <div className="field-grid"><TextField label={gate.type === "quest_flag" ? "Quest flag ID" : "Dungeon flag ID"} value={gate.flagId} disabled={!props.writesAllowed} onChange={(flagId) => updateGate(portal.id, index, (current) => current.type === "dungeon_flag" || current.type === "quest_flag" ? { ...current, flagId: safeDungeonId(flagId) } : current)} /><BooleanSelect label="Required value" value={gate.value} onChange={(value) => updateGate(portal.id, index, (current) => current.type === "dungeon_flag" || current.type === "quest_flag" ? { ...current, value } : current)} /></div>}<button type="button" disabled={!props.writesAllowed} onClick={() => props.onUpdateDungeon((dungeon) => { const draft = dungeon.portals.find((candidate) => candidate.id === portal.id); if (draft?.gates) draft.gates.splice(index, 1); })}>Remove gate</button></div>)}<button type="button" disabled={!props.writesAllowed} onClick={() => addGate(portal.id)}>+ Gate</button></details>)}</section>;
}

function BossLibraryPanel(props: { catalog: DungeonCatalog; dungeon: DungeonDefinition; appearanceCatalog: BossAppearanceCatalog | null; writesAllowed: boolean; onUpdateCatalog(edit: (catalog: DungeonCatalog) => void): void }) {
  const [definitionId, setDefinitionId] = useState(DUNGEON_BOSS_DEFINITIONS[0]?.id ?? "");
  const [templateId, setTemplateId] = useState("");
  const selected = DUNGEON_BOSS_DEFINITIONS.find((value) => value.id === definitionId);
  const appearance = selected?.appearanceId ? props.appearanceCatalog?.bosses.find((value) => value.bossId === selected.appearanceId) : undefined;
  const add = (): void => {
    if (!selected) return;
    const id = safeDungeonId(templateId || selected.id);
    if (!id || props.catalog.bossTemplates.some((template) => template.id === id && !template.retired)) return;
    try {
      props.onUpdateCatalog((catalog) => {
        const next = selectDungeonBossTemplate(catalog, { id, definition: selected });
        Object.assign(catalog, next);
        const dungeon = catalog.dungeons.find((value) => value.id === props.dungeon.id);
        if (dungeon && !dungeon.bossTemplateIds.includes(id)) dungeon.bossTemplateIds.push(id);
      });
      setTemplateId("");
    } catch {
      // The catalog validation panel reports duplicate/invalid IDs; keep the editor open.
    }
  };
  return <section className="dungeon-resource-editor" aria-label="Reusable boss library">
    <PanelHeading title="Boss library" meta={`${props.catalog.bossTemplates.filter((value) => !value.retired).length} selected`} />
    <p className="dungeon-authority-note">Choose a boss the game server registers for dungeons. Its controller and reward policy come from that registration; dungeon encounters reference the template. Reward tables on the encounter add dungeon-specific rewards.</p>
    <label className="field compact"><span>Registered dungeon boss</span><select value={definitionId} onChange={(event) => setDefinitionId(event.target.value)}>{DUNGEON_BOSS_DEFINITIONS.map((value) => <option key={value.id} value={value.id}>{value.displayName ?? value.id} · {value.id}</option>)}</select></label>
    {selected ? <small>Mob {selected.archetypeKey} · controller {selected.controllerId} · reward policy {selected.rewardPolicy.id} · {appearance ? `boss appearance ${appearance.displayName}` : "no dedicated boss appearance (uses the mob's art)"}</small> : null}
    <div className="field-grid"><TextField label="Dungeon template ID" value={templateId} onChange={setTemplateId} /></div>
    <button type="button" className="primary" disabled={!props.writesAllowed || !selected} onClick={add}>Add to Boss Library</button>
    {props.catalog.bossTemplates.filter((value) => !value.retired).map((template) => <article className="dungeon-resource-card" key={template.id}><strong>{template.displayName ?? template.id}</strong><small>{template.bossDefinitionId} · controller {template.controllerId} · reward {template.rewardPolicyId}</small></article>)}
  </section>;
}

function RewardTableEditor(props: { catalog: DungeonCatalog; writesAllowed: boolean; onUpdateCatalog(edit: (catalog: DungeonCatalog) => void): void }) {
  const [newId, setNewId] = useState("dungeon_reward");
  const [newGold, setNewGold] = useState(100);
  const [newItemId, setNewItemId] = useState("");
  const [newItemQuantity, setNewItemQuantity] = useState(1);
  const activeTables = props.catalog.rewardTables.filter((table) => !table.retired);
  const create = (): void => {
    const id = safeDungeonId(newId);
    if (!id || activeTables.some((table) => table.id === id) || (newGold <= 0 && !newItemId.trim())) return;
    props.onUpdateCatalog((catalog) => Object.assign(catalog, createDungeonRewardTable(catalog, {
      id,
      gold: Math.max(0, Math.floor(newGold)),
      items: newItemId.trim() ? [{ itemId: safeDungeonId(newItemId), quantity: Math.max(1, Math.floor(newItemQuantity)) }] : []
    })));
    setNewId(`${id}_next`);
    setNewItemId("");
  };
  return <section className="dungeon-resource-editor" aria-label="Dungeon reward table editor">
    <PanelHeading title="Reward tables" meta={`${activeTables.length} active table${activeTables.length === 1 ? "" : "s"}`} />
    <p className="dungeon-authority-note">Rewards settle through the durable inventory and Gold contracts. Tables are shared by encounters and trigger actions.</p>
    <div className="field-grid"><TextField label="New table ID" value={newId} onChange={setNewId} /><NumberField label="Gold" value={newGold} min={0} onChange={setNewGold} /><TextField label="Item ID (optional)" value={newItemId} onChange={setNewItemId} /><NumberField label="Item quantity" value={newItemQuantity} min={1} onChange={setNewItemQuantity} /></div>
    <button type="button" className="primary" disabled={!props.writesAllowed || (!safeDungeonId(newId) || (newGold <= 0 && !newItemId.trim()))} onClick={create}>Create reward table</button>
    {activeTables.map((table) => <details className="dungeon-resource-card" key={table.id}><summary>{table.id} · revision {table.revision}</summary><div className="field-grid"><NumberField label="Gold" value={table.gold ?? 0} min={0} disabled={!props.writesAllowed} onChange={(gold) => props.onUpdateCatalog((catalog) => Object.assign(catalog, updateDungeonRewardTable(catalog, table.id, { gold })))} /><TextField label="First item ID" value={table.items[0]?.itemId ?? ""} disabled={!props.writesAllowed} onChange={(itemId) => props.onUpdateCatalog((catalog) => Object.assign(catalog, updateDungeonRewardTable(catalog, table.id, { items: itemId.trim() ? [{ itemId: safeDungeonId(itemId), quantity: table.items[0]?.quantity ?? 1 }, ...table.items.slice(1)] : table.items.slice(1) })))} /><NumberField label="First item quantity" value={table.items[0]?.quantity ?? 1} min={1} disabled={!props.writesAllowed || table.items.length === 0} onChange={(quantity) => props.onUpdateCatalog((catalog) => Object.assign(catalog, updateDungeonRewardTable(catalog, table.id, { items: table.items.length > 0 ? [{ itemId: table.items[0]!.itemId, quantity }, ...table.items.slice(1)] : [] })))} /></div><small>Used by: {props.catalog.dungeons.filter((dungeon) => dungeon.rewardTableIds.includes(table.id)).map((dungeon) => dungeon.name).join(", ") || "not assigned yet"}</small></details>)}
  </section>;
}

function ResourceAuthoringPanel(props: {
  prefabs: DungeonPrefabDefinition[];
  room: DungeonRoomDefinition;
  resourceType: DungeonResourceType;
  writesAllowed: boolean;
  onResourceTypeChange(value: DungeonResourceType): void;
  onArmPlacement(tool: Exclude<PlacementTool, null>): void;
  onUpdateRoom(edit: (room: DungeonRoomDefinition) => void): void;
}) {
  const nodes = props.room.resourceNodes ?? [];
  const zones = props.room.resourceSpawnZones ?? [];
  const addNode = (): void => props.onUpdateRoom((room) => {
    const resourceNodes = room.resourceNodes ?? (room.resourceNodes = []);
    const anchorId = nextId("resource_anchor", room.anchors.map((value) => value.id));
    const id = nextId("resource", resourceNodes.map((value) => value.id));
    room.anchors.push({ id: anchorId, retired: false, x: room.width / 2, y: room.height / 2 });
    resourceNodes.push(createDungeonResourceNode({ id, anchorId, resourceType: props.resourceType, minYield: 1, maxYield: 3, respawnSeconds: 300, resetOnRun: true, interactionRadius: 72 }));
  });
  const addZone = (): void => props.onUpdateRoom((room) => {
    const resourceZones = room.resourceSpawnZones ?? (room.resourceSpawnZones = []);
    const id = nextId("resource_zone", resourceZones.map((value) => value.id));
    resourceZones.push(createDungeonResourceSpawnZone({
      id,
      shape: { id, retired: false, kind: "rectangle", x: Math.max(0, room.width / 2 - 150), y: Math.max(0, room.height / 2 - 100), width: Math.min(300, room.width), height: Math.min(200, room.height) },
       resourceTypes: [props.resourceType], minCount: 2, maxCount: 5, minimumSpacing: 80,
       minYield: 1, maxYield: 3,
       seed: room.resourceSpawnZones?.length ?? 0, respawnSeconds: 300, resetOnRun: true, interactionRadius: 72
    }));
  });
  return <section className="dungeon-resource-editor" aria-label="Dungeon resource authoring">
    <PanelHeading title="Resource nodes & spawn zones" meta={`${nodes.filter((value) => !value.retired).length} nodes · ${zones.filter((value) => !value.retired).length} zones`} />
    <p className="dungeon-authority-note">Resources use the shared inventory harvest authority. A node is a fixed placement; a zone creates deterministic randomized nodes when a run starts.</p>
    <label className="field compact"><span>Resource type</span><select value={props.resourceType} onChange={(event) => props.onResourceTypeChange(event.target.value as DungeonResourceType)}>{DUNGEON_RESOURCE_TYPES.map((value) => <option key={value} value={value}>{friendlyId(value)}</option>)}</select></label>
    <div className="dungeon-author-actions"><button type="button" disabled={!props.writesAllowed} onClick={() => props.onArmPlacement("resource")}>Place node on canvas</button><button type="button" disabled={!props.writesAllowed} onClick={addNode}>Add node at center</button><button type="button" disabled={!props.writesAllowed} onClick={() => props.onArmPlacement("resource_zone")}>Place spawn zone</button><button type="button" disabled={!props.writesAllowed} onClick={addZone}>Add zone at center</button></div>
    {nodes.map((node) => <ResourceNodeEditor prefabs={props.prefabs} key={node.id} node={node} room={props.room} writesAllowed={props.writesAllowed} onUpdate={(edit) => props.onUpdateRoom((room) => { const target = room.resourceNodes?.find((value) => value.id === node.id); if (target) edit(target); })} onRetire={() => props.onUpdateRoom((room) => { const target = room.resourceNodes?.find((value) => value.id === node.id); if (target) target.retired = true; })} />)}
    {zones.map((zone) => <ResourceZoneEditor prefabs={props.prefabs} room={props.room} key={zone.id} zone={zone} writesAllowed={props.writesAllowed} onUpdate={(edit) => props.onUpdateRoom((room) => { const target = room.resourceSpawnZones?.find((value) => value.id === zone.id); if (target) edit(target); })} onRetire={() => props.onUpdateRoom((room) => { const target = room.resourceSpawnZones?.find((value) => value.id === zone.id); if (target) target.retired = true; })} />)}
  </section>;
}

function ResourceArtSelector(props: { prefabs: DungeonPrefabDefinition[]; value: string | undefined; disabled: boolean; onChange(prefab: DungeonPrefabDefinition | undefined): void }) {
  return <label className="field compact"><span>Tree, plant, ore or mine picture</span><select disabled={props.disabled} value={props.value ?? ""} onChange={(event) => props.onChange(props.prefabs.find((prefab) => prefab.id === event.target.value))}><option value="">No picture assigned · resource marker</option>{props.prefabs.filter((prefab) => !prefab.retired && prefab.type === "object").map((prefab) => <option key={prefab.id} value={prefab.id}>{prefab.name}</option>)}</select><small>Import your tree, plant or mining PNG as Object art, then choose it here. Until then the game uses a labelled resource marker.</small></label>;
}

function ResourceNodeEditor(props: { prefabs: DungeonPrefabDefinition[]; node: DungeonResourceNodeDefinition; room: DungeonRoomDefinition; writesAllowed: boolean; onUpdate(edit: (node: DungeonResourceNodeDefinition) => void): void; onRetire(): void }) {
  const anchor = props.room.anchors.find((value) => value.id === props.node.anchorId);
  return <details className="dungeon-resource-card" open={!props.node.retired} data-resource-id={props.node.id}><summary>{friendlyId(props.node.resourceType)}{props.node.retired ? " · retired" : ""}</summary><ResourceArtSelector prefabs={props.prefabs} value={props.node.prefabId} disabled={!props.writesAllowed} onChange={(prefab) => props.onUpdate((node) => { node.prefabId = prefab?.id; node.prefabRevision = prefab?.revision; })} /><div className="field-grid"><label className="field compact"><span>Type</span><select disabled={!props.writesAllowed} value={props.node.resourceType} onChange={(event) => props.onUpdate((node) => { node.resourceType = event.target.value as DungeonResourceType; })}>{DUNGEON_RESOURCE_TYPES.map((value) => <option key={value} value={value}>{friendlyId(value)}</option>)}</select></label><NumberField label="Min yield" value={props.node.minYield} min={1} onChange={(value) => props.onUpdate((node) => { node.minYield = Math.min(value, node.maxYield); })} /><NumberField label="Max yield" value={props.node.maxYield} min={props.node.minYield} onChange={(value) => props.onUpdate((node) => { node.maxYield = Math.max(node.minYield, value); })} /><NumberField label="Respawn seconds" value={props.node.respawnSeconds ?? 0} min={0} onChange={(value) => props.onUpdate((node) => { node.respawnSeconds = value; })} /><NumberField label="Interaction radius" value={props.node.interactionRadius} min={1} onChange={(value) => props.onUpdate((node) => { node.interactionRadius = value; })} /></div><label className="toggle"><input type="checkbox" disabled={!props.writesAllowed} checked={props.node.resetOnRun} onChange={(event) => props.onUpdate((node) => { node.resetOnRun = event.target.checked; })} /><span>Reset when a run resets</span></label>{anchor ? <small>Anchor {anchor.id} · {Math.round(anchor.x)}, {Math.round(anchor.y)}</small> : <small className="connection-error">Missing anchor {props.node.anchorId}</small>}<button type="button" className="danger" disabled={!props.writesAllowed || props.node.retired} onClick={props.onRetire}>Retire node</button></details>;
}

function ResourceZoneEditor(props: { prefabs: DungeonPrefabDefinition[]; room: DungeonRoomDefinition; zone: DungeonResourceSpawnZoneDefinition; writesAllowed: boolean; onUpdate(edit: (zone: DungeonResourceSpawnZoneDefinition) => void): void; onRetire(): void }) {
  const shape = props.zone.shape;
  const minYield = props.zone.minYield ?? 1;
  const maxYield = props.zone.maxYield ?? Math.max(minYield, 3);
  return <details className="dungeon-resource-card" open={!props.zone.retired} data-resource-id={props.zone.id}><summary>{props.zone.resourceTypes.map(friendlyId).join(", ")} · spawn zone{props.zone.retired ? " · retired" : ""}</summary><ResourceArtSelector prefabs={props.prefabs} value={props.zone.prefabId} disabled={!props.writesAllowed} onChange={(prefab) => props.onUpdate((zone) => { zone.prefabId = prefab?.id; })} /><label className="field compact"><span>Copy drawn spawnable polygon</span><select value="" disabled={!props.writesAllowed} onChange={(event) => { const drawn = props.room.zones.find((zone) => zone.id === event.target.value); if (drawn) props.onUpdate((zone) => { zone.shape = resourceShapeFromZone(drawn, zone.id); }); }}><option value="">Choose a room zone (draw in Advanced)</option>{props.room.zones.filter((zone) => !zone.retired).map((zone) => <option key={zone.id} value={zone.id}>{zone.id}</option>)}</select></label><div className="field-grid"><label className="field compact"><span>Type</span><select disabled={!props.writesAllowed} value={props.zone.resourceTypes[0]} onChange={(event) => props.onUpdate((zone) => { zone.resourceTypes = [event.target.value as DungeonResourceType]; })}>{DUNGEON_RESOURCE_TYPES.map((value) => <option key={value} value={value}>{friendlyId(value)}</option>)}</select></label><NumberField label="Min count" value={props.zone.minCount} min={0} onChange={(value) => props.onUpdate((zone) => { zone.minCount = Math.min(Math.floor(value), zone.maxCount); })} /><NumberField label="Max count" value={props.zone.maxCount} min={Math.max(1, props.zone.minCount)} onChange={(value) => props.onUpdate((zone) => { zone.maxCount = Math.max(zone.minCount, Math.floor(value)); })} /><NumberField label="Min yield" value={minYield} min={1} onChange={(value) => props.onUpdate((zone) => { zone.minYield = Math.min(Math.max(1, Math.floor(value)), zone.maxYield ?? maxYield); })} /><NumberField label="Max yield" value={maxYield} min={minYield} onChange={(value) => props.onUpdate((zone) => { zone.maxYield = Math.max(zone.minYield ?? minYield, Math.floor(value)); })} /><NumberField label="Spacing" value={props.zone.minimumSpacing} min={0} onChange={(value) => props.onUpdate((zone) => { zone.minimumSpacing = value; })} /><NumberField label="Seed" value={props.zone.seed} min={0} onChange={(value) => props.onUpdate((zone) => { zone.seed = Math.max(0, Math.floor(value)); })} /><NumberField label="Respawn seconds" value={props.zone.respawnSeconds ?? 0} min={0} onChange={(value) => props.onUpdate((zone) => { zone.respawnSeconds = value; })} /></div>{shape.kind === "rectangle" ? <div className="field-grid"><NumberField label="Width" unit="px" value={shape.width} min={1} onChange={(value) => props.onUpdate((zone) => { if (zone.shape.kind === "rectangle") zone.shape.width = value; })} /><NumberField label="Height" unit="px" value={shape.height} min={1} onChange={(value) => props.onUpdate((zone) => { if (zone.shape.kind === "rectangle") zone.shape.height = value; })} /></div> : <small>Polygon zone · {shape.points.length} points</small>}<label className="toggle"><input type="checkbox" disabled={!props.writesAllowed} checked={props.zone.resetOnRun} onChange={(event) => props.onUpdate((zone) => { zone.resetOnRun = event.target.checked; })} /><span>Reset when a run resets</span></label><button type="button" className="danger" disabled={!props.writesAllowed || props.zone.retired} onClick={props.onRetire}>Retire spawn zone</button></details>;
}

function InteriorSpaceCard(props: { kind: InteriorSpaceKind; dungeon: DungeonDefinition; writesAllowed: boolean; onUpdate(edit: (dungeon: DungeonDefinition) => void): void }) {
  return <section className="panel dungeon-settings" aria-label="Interior details">
    <PanelHeading title={`${INTERIOR_KIND_LABELS[props.kind]} details`} meta={props.dungeon.id} />
    <div className="field-grid">
      <TextField label="Interior name" value={props.dungeon.name} disabled={!props.writesAllowed} onChange={(name) => props.onUpdate((draft) => { draft.name = name; })} />
      <TextField label="Description" value={props.dungeon.description} disabled={!props.writesAllowed} onChange={(description) => props.onUpdate((draft) => { draft.description = description; })} />
    </div>
  </section>;
}
/** Manor room "Floor art": the PNG drawn as this room's floor in the game (the `<room>_floor_art` background). */
function ManorFloorArtField(props: { room: DungeonRoomDefinition; catalog: DungeonCatalog; previews: Record<string, string>; disabled: boolean; onImport(file: File): void }) {
  const floorId = `${props.room.id}_floor_art`;
  const placement = props.room.layers.background.find((candidate) => !candidate.retired && candidate.id === floorId) ??
    props.room.layers.background.find((candidate) => !candidate.retired && candidate.prefabId === floorId);
  const assetKey = placement ? props.catalog.prefabs.find((prefab) => prefab.id === placement.prefabId)?.assetKey : undefined;
  return <section className="panel dungeon-settings" aria-label="Floor art">
    <PanelHeading title="Floor art" meta={assetKey ? "Set" : "Not set"} />
    {assetKey ? <img className="dungeon-prefab-thumbnail" src={props.previews[assetKey] ?? runtimeDungeonAssetUrl(assetKey)} alt={`${props.room.name} floor art`} /> : <p>No floor picture yet: the game shows a plain placeholder floor.</p>}
    <label className="field compact"><span>{assetKey ? "Replace floor PNG" : "Choose floor PNG"}</span><input type="file" accept="image/png" aria-label="Floor art PNG" disabled={props.disabled} onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; if (file) props.onImport(file); }} /></label>
    <p>The picture is stretched over the whole room ({props.room.width} × {props.room.height}). Draw the floor, walls and doors on top of it in Floors &amp; Walls and Doors &amp; Exits.</p>
  </section>;
}
/** Manor type overworld building: the PNG drawn on the map for every Manor of this type. */
function ManorExteriorCard(props: { exterior: ManorExterior | null; previews: Record<string, string>; disabled: boolean; onImport(file: File): void; onScale(scale: number): void; onPrice(price: number): void }) {
  const assetKey = props.exterior?.exteriorAssetKey;
  return <section className="panel dungeon-settings" aria-label="Overworld building">
    <PanelHeading title="Overworld building" meta={assetKey ? "Set" : "Shared Manor art"} />
    {assetKey ? <img className="dungeon-prefab-thumbnail" src={props.previews[assetKey] ?? runtimeDungeonAssetUrl(assetKey)} alt="Overworld building" /> : <p>No building picture yet: the map draws the shared Manor sprite.</p>}
    <label className="field compact"><span>{assetKey ? "Replace building PNG" : "Choose building PNG"}</span><input type="file" accept="image/png" aria-label="Overworld building PNG" disabled={props.disabled} onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; if (file) props.onImport(file); }} /></label>
    {assetKey ? <NumberField label="Map size" value={props.exterior?.exteriorScale ?? 1} min={0.25} max={4} step={0.05} unit="×" disabled={props.disabled} help="1 = the timber Manor size on the map." onChange={(value) => props.onScale(Math.min(4, Math.max(0.25, value)))} /> : null}
    {assetKey ? <NumberField label="Skin price" value={props.exterior?.skinPriceGlimmer ?? 500} min={1} max={1_000_000} step={1} unit="Glimmer" disabled={props.disabled} help="What players pay for this Manor skin (default 500 Glimmer)." onChange={(value) => props.onPrice(Math.min(1_000_000, Math.max(1, Math.round(value))))} /> : <p>Set a building picture first; then this Manor type can be sold as a skin.</p>}
    <p>Use a square PNG (1254 × 1254 like the timber Manor) with the building standing on the bottom edge.</p>
  </section>;
}
function PanelHeading(props: { title: string; meta: string }) { return <div className="panel-title"><h2>{props.title}</h2><span>{props.meta}</span></div>; }
function TextField(props: { label: string; value: string; disabled?: boolean; onChange(value: string): void }) { return <label className="field compact"><span>{props.label}</span><input disabled={props.disabled} value={props.value} onChange={(event) => props.onChange(event.target.value)} /></label>; }
function NumberField(props: { label: string; value: number; min?: number; max?: number; step?: number; disabled?: boolean; unit?: string; help?: string; onChange(value: number): void }) { const input = <input type="number" disabled={props.disabled} value={props.value} min={props.min} max={props.max} step={props.step ?? 1} onChange={(event) => { const value = Number(event.target.value); if (Number.isFinite(value)) props.onChange(value); }} />; return <label className="field compact" title={props.help} {...(props.help ? { "data-help": props.help } : {})}><span>{props.label}</span>{props.unit ? <span className="field-input" data-unit={props.unit}>{input}</span> : input}</label>; }
function roomSizePreset(value: string): { width: number; height: number } | null { if (value === "small") return { width: 720, height: 540 }; if (value === "medium") return { width: 1000, height: 1000 }; if (value === "large") return { width: 1440, height: 1080 }; return null; }
function friendlyPrefabKind(value: DungeonPrefabDefinition["type"]): string { return value === "surface" ? "Room art" : value === "decoration" ? "Decoration" : value === "portal" ? "Door or portal" : "Interactive object"; }
export function validationIssueContext(catalog: DungeonCatalog, path: string, authoringOf?: (dungeonId: string, room: DungeonRoomDefinition) => RoomAuthoring | null): { label: string; category: string; inspectorTab: InspectorTab; selection?: CanvasEntitySelection; dungeonId?: string; roomId?: string; resourceId?: string; fieldLabel?: string } {
  const rewardToken = /^rewardTables\.([^.]+)/u.exec(path)?.[1];
  const reward = rewardToken == null ? undefined : /^\d+$/u.test(rewardToken) ? catalog.rewardTables[Number(rewardToken)] : catalog.rewardTables.find((value) => value.id === rewardToken);
  if (reward) for (const dungeon of catalog.dungeons) for (const room of dungeon.rooms) {
    const chest = room.objects.find((object) => object.rewardTableId === reward.id);
    if (chest) return { label: `${dungeon.name} · ${room.name} · ${chest.name}`, category: "Chests & Loot", inspectorTab: "rewards", dungeonId: dungeon.id, roomId: room.id };
  }
  const dungeonToken = /dungeons\.([^.]+)/u.exec(path)?.[1];
  const dungeon = dungeonToken == null ? undefined : /^\d+$/u.test(dungeonToken) ? catalog.dungeons[Number(dungeonToken)] : catalog.dungeons.find((value) => value.id === dungeonToken);
  const roomToken = /\.rooms\.([^.]+)/u.exec(path)?.[1];
  let room = !dungeon || roomToken == null ? undefined : /^\d+$/u.test(roomToken) ? dungeon.rooms[Number(roomToken)] : dungeon.rooms.find((value) => value.id === roomToken);
  if (dungeon && !room) {
    const encounterToken = /\.encounters\.([^.]+)/u.exec(path)?.[1];
    const encounter = encounterToken == null ? undefined : /^\d+$/u.test(encounterToken) ? dungeon.encounters[Number(encounterToken)] : dungeon.encounters.find((value) => value.id === encounterToken);
    const portalToken = /\.portals\.([^.]+)/u.exec(path)?.[1];
    const portal = portalToken == null ? undefined : /^\d+$/u.test(portalToken) ? dungeon.portals[Number(portalToken)] : dungeon.portals.find((value) => value.id === portalToken);
    const triggerToken = /\.triggers\.([^.]+)/u.exec(path)?.[1];
    const trigger = triggerToken == null ? undefined : /^\d+$/u.test(triggerToken) ? dungeon.triggers[Number(triggerToken)] : dungeon.triggers.find((value) => value.id === triggerToken);
    const triggerRoomId = trigger ? triggerRoom(trigger, dungeon) : undefined;
    const inferredRoomId = encounter?.roomId ?? (portal?.source.kind === "room" ? portal.source.roomId : portal?.destination.kind === "room" ? portal.destination.roomId : undefined) ?? triggerRoomId;
    room = dungeon.rooms.find((value) => value.id === inferredRoomId);
  }
  const resourceMatch = /\.(resourceNodes|resourceSpawnZones)\.([^.]+)/u.exec(path);
  if (room && dungeon && resourceMatch) {
    const values = resourceMatch[1] === "resourceNodes" ? room.resourceNodes : room.resourceSpawnZones;
    const token = resourceMatch[2]!;
    const resource = /^\d+$/u.test(token) ? values?.[Number(token)] : values?.find((value) => value.id === token);
    return { label: `${dungeon.name} · ${room.name} · Resources`, category: "Resources", inspectorTab: "resources", dungeonId: dungeon.id, roomId: room.id, ...(resource ? { resourceId: resource.id } : {}), fieldLabel: ({ minCount: "Min count", maxCount: "Max count", minYield: "Min yield", maxYield: "Max yield", width: "Width", height: "Height", minimumSpacing: "Spacing", seed: "Seed", interactionRadius: "Interaction radius", respawnSeconds: "Respawn seconds" } as Record<string, string>)[path.split(".").at(-1)!] ?? "Copy drawn spawnable polygon" };
  }
  const entityKinds = [["anchors", "anchor"], ["colliders", "collider"], ["zones", "zone"], ["objects", "object"], ["mobs", "mob"]] as const;
  let selection: CanvasEntitySelection | undefined;
  for (const [segment, kind] of entityKinds) {
    const token = new RegExp(`\\.${segment}\\.([^.]+)`, "u").exec(path)?.[1];
    const values = room?.[segment];
    const entity = token == null || !values ? undefined : /^\d+$/u.test(token) ? values[Number(token)] : values.find((value) => value.id === token);
    if (entity) { selection = { kind, id: entity.id }; break; }
  }
  if (!selection && room) {
    const placementMatch = /\.(?:layers\.)?(background|below_player|actors|above_player|ceiling)\.([^.]+)/u.exec(path);
    const token = placementMatch?.[2]; const values = placementMatch ? room.layers[placementMatch[1] as LayerId] : undefined;
    const entity = token == null || !values ? undefined : /^\d+$/u.test(token) ? values[Number(token)] : values.find((value) => value.id === token);
    if (entity) selection = { kind: "placement", id: entity.id };
  }
  if (!selection && room && dungeon && authoringOf) {
    const shapeMatch = /\.(floors|walls|clickAreas)\.([^.]+)/u.exec(path);
    const shapeAuthoring = shapeMatch ? authoringOf(dungeon.id, room) : null;
    if (shapeMatch && shapeAuthoring) {
      const values = shapeAuthoring[shapeMatch[1] as "floors" | "walls" | "clickAreas"];
      const token = shapeMatch[2]!;
      const entity = /^\d+$/u.test(token) ? values[Number(token)] : values.find((value) => value.id === token);
      if (entity) selection = { kind: shapeMatch[1] === "floors" ? "floor" : shapeMatch[1] === "walls" ? "wall" : "clickArea", id: entity.id };
    }
  }
  const shapePath = /\.(floors|walls|clickAreas)(\.|$)/u.test(path);
  const category = path.includes(".triggers.") ? "Logic"
    : path.includes(".encounters.") ? "Encounters"
      : path.includes(".portals.") || path.includes(".entrance.") || path.includes(".escape.") ? "Portals"
        : shapePath ? "Shapes"
        : selection ? `${friendlyId(selection.kind)}s`
          : room ? "Rooms" : dungeon ? "Dungeon settings" : "Catalog";
  const shapeSelected = selection?.kind === "floor" || selection?.kind === "wall" || selection?.kind === "clickArea";
  const inspectorTab: InspectorTab = shapeSelected ? "shapes" : selection ? "selected" : category === "Logic" ? "logic" : category === "Encounters" ? "encounters" : category === "Portals" ? "portals" : category === "Shapes" ? "shapes" : "advanced";
  return { label: room ? `${dungeon!.name} · ${room.name}` : dungeon?.name ?? "Dungeon catalog", category, inspectorTab, ...(selection ? { selection } : {}), ...(dungeon ? { dungeonId: dungeon.id } : {}), ...(room ? { roomId: room.id } : {}) };
}
function friendlyValidationMessage(path: string, message: string): string {
  if (/\.encounters\.[^.]+\.waves\.[^.]+\.mobSpawnIds$/u.test(path) && /at least 1|>=\s*1|too small/iu.test(message)) {
    return "has an empty encounter. Add an enemy or delete the empty encounter.";
  }
  return message;
}
function triggerReferencesEncounter(trigger: DungeonTriggerDefinition, encounterId: string): boolean {
  return (trigger.event.type === "encounter_state" && trigger.event.encounterId === encounterId)
    || trigger.conditions.items.some((condition) => condition.type === "encounter_state" && condition.encounterId === encounterId)
    || trigger.actions.some((action) => (action.type === "start_encounter" || action.type === "start_wave") && action.encounterId === encounterId);
}
function encounterDeletionBlocker(dungeon: DungeonDefinition, encounterId: string, removedMobId?: string): string | null {
  const encounter = dungeon.encounters.find((value) => value.id === encounterId);
  if (!encounter || encounter.retired) return "This enemy's encounter is missing or retired. Repair the encounter before deleting the enemy.";
  const room = dungeon.rooms.find((candidate) => candidate.id === encounter.roomId);
  if (!room) return "This enemy's room is missing. Repair the room before deleting the enemy.";
  if (removedMobId && room.mobs.some((mob) => !mob.retired && mob.summonedByMobSpawnId === removedMobId)) {
    return "Cannot delete a summoning leader while active summoned adds reference it. Retire or reassign those adds first.";
  }
  const activeMobs = room.mobs.filter((mob) => !mob.retired && mob.encounterId === encounter.id);
  if (removedMobId ? activeMobs.length <= 1 : activeMobs.length > 0) {
    if (dungeon.triggers.some((trigger) => !trigger.retired && triggerReferencesEncounter(trigger, encounter.id))) {
      return "Cannot remove the last enemy while this encounter has trigger recipes. Retire or edit those recipes first, then delete the empty encounter.";
    }
  }
  return null;
}
function retireEmptyEncounter(dungeon: DungeonDefinition, encounterId: string): boolean {
  const encounter = dungeon.encounters.find((value) => value.id === encounterId);
  if (!encounter || encounter.retired || encounterDeletionBlocker(dungeon, encounterId)) return false;
  const room = dungeon.rooms.find((candidate) => candidate.id === encounter.roomId);
  if (!room || room.mobs.some((mob) => !mob.retired && mob.encounterId === encounter.id)) return false;
  dungeon.encounters = dungeon.encounters.filter((candidate) => candidate.id !== encounter.id);
  return true;
}
function triggerRoom(trigger: DungeonTriggerDefinition, dungeon: DungeonDefinition): string | undefined {
  const event = trigger.event;
  if ("roomId" in event) return event.roomId;
  if (event.type === "encounter_state") return dungeon.encounters.find((value) => value.id === event.encounterId)?.roomId;
  if (event.type === "portal_used") { const portal = dungeon.portals.find((value) => value.id === event.portalId); return portal?.source.kind === "room" ? portal.source.roomId : undefined; }
  for (const action of trigger.actions) {
    if (action.type === "set_object_state" || action.type === "set_object_available") return action.roomId;
    if (action.type === "start_encounter" || action.type === "start_wave") return dungeon.encounters.find((value) => value.id === action.encounterId)?.roomId;
    if (action.type === "set_portal_locked") { const portal = dungeon.portals.find((value) => value.id === action.portalId); if (portal?.source.kind === "room") return portal.source.roomId; }
  }
  return undefined;
}
function applyPrefabDefaultColliders(room: DungeonRoomDefinition, prefab: DungeonPrefabDefinition, transform: { id: string; x: number; y: number; width: number; height: number; rotationDeg: number; flipX: boolean; flipY: boolean }): boolean {
  if (prefab.defaultColliders.length === 0) return true;
  if (((transform.rotationDeg % 360) + 360) % 360 !== 0) return false;
  const scaleX = transform.width / prefab.defaultWidth; const scaleY = transform.height / prefab.defaultHeight;
  for (const source of prefab.defaultColliders) {
    const localX = transform.flipX ? prefab.defaultWidth - source.x - source.width : source.x;
    const localY = transform.flipY ? prefab.defaultHeight - source.y - source.height : source.y;
    const collider: DungeonColliderDefinition = {
      id: nextId(`${transform.id}_${source.id}`, room.colliders.map((value) => value.id)), retired: false, kind: "rectangle",
      x: transform.x + localX * scaleX, y: transform.y + localY * scaleY,
      width: source.width * scaleX, height: source.height * scaleY
    };
    room.colliders.push(collider);
  }
  return true;
}
function nextId(prefix: string, ids: readonly string[]): string { let index = 1; while (ids.includes(`${prefix}_${index}`)) index += 1; return `${prefix}_${index}`; }
function clamp(value: number, minimum: number, maximum: number): number { return Math.min(maximum, Math.max(minimum, value)); }
function stable(value: unknown): string { return JSON.stringify(value); }
/** FNV-1a fingerprint of a catalog's JSON (enough to tell drafts made on other data apart). */
function catalogFingerprint(value: unknown): string {
  const text = stable(value);
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${text.length.toString(36)}-${hash.toString(36)}`;
}
function normalizeDungeonCatalog(catalog: DungeonCatalog): DungeonCatalog {
  const legacy = catalog as DungeonCatalog & { entrances?: DungeonCatalog["entrances"]; rewardTables?: DungeonCatalog["rewardTables"] };
  return { ...catalog, entrances: legacy.entrances ?? [], rewardTables: legacy.rewardTables ?? [] };
}
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : "Dungeon Studio operation failed"; }
function idList(value: string): string[] { return [...new Set(value.split(",").map((item) => safeDungeonId(item)).filter(Boolean))]; }
function recoveryKey(worktreePath: string, branch: string | null): string { return `ash-atlas-interior-studio-draft:${encodeURIComponent(`${worktreePath}|${branch ?? "detached"}`)}`; }
function readDungeonView(key: string): Record<string, string | number> { try { const value: unknown = JSON.parse(sessionStorage.getItem(key) ?? "{}"); return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, string | number> : {}; } catch { return {}; } }
function readRecoveryDraft(key: string): RecoveryDraft | null { try { const value = JSON.parse(localStorage.getItem(key) ?? "null") as RecoveryDraft | null; const pending = value?.pendingDungeonAssets; return value && Number.isInteger(value.baseCatalogRevision) && plausibleRecoveryCatalog(value.catalog) && (pending === undefined || (Array.isArray(pending) && pending.every((asset) => typeof asset?.stagingToken === "string" && asset.stagingToken.length > 0 && typeof asset.prefabId === "string" && (asset.prefabId.length > 0 || (typeof asset.assetKey === "string" && asset.assetKey.length > 0))))) ? value : null; } catch { localStorage.removeItem(key); return null; } }
function plausibleRecoveryCatalog(value: unknown): value is DungeonCatalog { if (!value || typeof value !== "object" || Array.isArray(value)) return false; const catalog = value as Partial<DungeonCatalog>; return catalog.schemaVersion === 2 && Number.isInteger(catalog.catalogRevision) && (catalog.catalogRevision ?? -1) >= 0 && Array.isArray(catalog.prefabs) && Array.isArray(catalog.dungeons) && catalog.dungeons.length > 0; }
function writeRecoveryDraft(key: string, draft: RecoveryDraft): void { try { localStorage.setItem(key, JSON.stringify(draft)); } catch { /* Worktree save remains available. */ } }
function removeRecoveryDraft(key: string): void { try { localStorage.removeItem(key); } catch { /* Best effort. */ } }
function formatTime(value: string): string { const parsed = Date.parse(value); return Number.isFinite(parsed) ? new Date(parsed).toLocaleTimeString() : "an earlier session"; }
