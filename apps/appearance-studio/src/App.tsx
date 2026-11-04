import {
  DEFAULT_BOSS_APPEARANCE_CATALOG,
  DEFAULT_BOSS_WEAPON_TRANSFORM,
  DEFAULT_PLAYER_APPEARANCE_CATALOG,
  DEFAULT_PLAYER_SKIN_TONE_ID,
  DEFAULT_PROJECTILE_TRANSFORM,
  EQUIPMENT_DEFINITIONS,
  EQUIPMENT_CORE_IDS,
  EQUIPMENT_GAMEPLAY_FAMILIES,
  ENCHANTMENT_STONE_VARIANTS,
  ITEM_VARIANT_CATALOG,
  PLAYER_AUTHORABLE_OVERLAY_SLOT_IDS,
  PLAYER_ATTACHMENT_ANCHOR_IDS,
  PLAYER_COMBAT_POSE_IDS,
  PLAYER_OVERLAY_SLOT_IDS,
  PLAYER_SKIN_TONE_IDS,
  PLAYER_SKIN_TONE_LABELS,
  appearanceAssetParts,
  appearanceCategory,
  appearanceAuthoringLayer,
  equipmentGemSocket,
  faceFeatureArea,
  faceFeaturePointInPolygon,
  faceFeaturePolygonIssue,
  isFaceFeatureCategory,
  salonAppearanceCategory,
  equipmentEffectDisplayName,
  equipmentMetalDisplayName,
  bossOverallScale,
  playerBodyPose,
  playerMainAnchor,
  playerOverallScale,
  playerOverlaySlotForFamily,
  playerTemplateTransform,
  resolveBossWeaponTransform,
  resolveAppearancePlacement,
  equipmentDefinitionFromItemVariant,
  venomsteelImbuementKind,
  type AppearanceTransform,
  type AppearanceDefinition,
  type AppearanceDefinitionId,
  type AppearancePartId,
  type AppearancePlacement,
  type AppearancePlacementOverride,
  type BossAppearanceDefinition,
  type BossAppearanceId,
  type EquipmentDefinitionId,
  type EquipmentCoreId,
  type EquipmentGameplayFamilyId,
  type EnchantmentStoneVariant,
  type FaceFeatureArea,
  type ItemVariantCatalog,
  type PlayerAttachmentAnchorId,
  type PlayerCombatPoseId,
  type PlayerAppearanceCatalog,
  type PlayerAppearanceCategoryId,
  type PlayerAuthorableOverlaySlotId,
  type PlayerOverlaySlotId,
  type PlayerSkinToneId,
  type PlayerTemplateTransform,
  type ProjectileTransform
} from "@ash-atlas/shared";
import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type Ref
} from "react";

import type {
  RemoteStudioInfo,
  StudioSession
} from "./bridgeTypes.js";
import type {
  DesktopReleaseStatus,
  DesktopStudioStatus
} from "./desktopContracts.js";
import {
  BOSS_AUTHORING_CONTRACT_VERSION,
  BOSS_MASTER_SCALE_CONTRACT_VERSION,
  EQUIPMENT_ENHANCEMENT_CONTRACT_VERSION,
  EXPANDED_GEMSTONE_CONTRACT_VERSION,
  FACE_FEATURE_CONTRACT_VERSION,
  MAIN_ANCHOR_CONTRACT_VERSION,
  MASTER_SCALE_CONTRACT_VERSION,
  PLAYER_HIT_GEOMETRY_CONTRACT_VERSION,
  PROJECTILE_AUTHORING_CONTRACT_VERSION,
  PROJECTILE_TRANSFORM_CONTRACT_VERSION
} from "./desktopContracts.js";
import {
  PreviewCanvas,
  type PreviewEditTarget
} from "./PreviewCanvas.js";
import {
  BossPreviewCanvas,
  type BossPreviewEditTarget
} from "./BossPreviewCanvas.js";
import {
  AssetStudio,
  HitGeometryFields,
  type AssetStudioHandle,
  type PlayerHitGeometryState
} from "./AssetStudio.js";
import { restoreStudioWorkspace, type StudioWorkspace } from "./studioWorkspace.js";
import { InteriorStudio, type InteriorStudioHandle } from "./InteriorStudio.js";
import { ProgressionIconStudio, type ProgressionIconStudioHandle } from "./ProgressionIconStudio.js";
import { TerritoryStudio, type TerritoryStudioHandle } from "./TerritoryStudio.js";
import { StaleStudioResponseError, StudioApi } from "./studioApi.js";
import {
  createStudioHistory,
  duplicateAppearance,
  resetAppearancePose,
  studioIsDirty,
  studioReducer,
  type StudioAction,
  withImportedPlayerTemplateAsset,
  withImportedPlayerSkinToneAsset,
  withImportedPlayerHeadAsset,
  withImportedPlayerHeadSkinToneAsset,
  withPlayerTemplateTransform,
  withPlayerOverallScale,
  withPlayerMainAnchor,
  resetPlayerMainAnchor,
  withPlayerAnchorPosition
} from "./studioState.js";
import {
  bossStudioIsDirty,
  bossStudioReducer,
  createBossStudioHistory,
  type BossStudioAction
} from "./bossStudioState.js";
import { burstGroup } from "./historyCore.js";
import { useEditGrouping } from "./useEditGrouping.js";
import {
  createStyleAppearanceDraft,
  createPlayerOverlayAppearanceDraft,
  createItemVariantDraft,
  familyForCategory,
  itemAppearanceForDefinition,
  saveFamilyPosePreset,
  setFamilyPlayerOverlaySlot,
  updateExistingItemAppearance
} from "./itemAuthoring.js";

import {
  readRecoveryDraft,
  writeRecoveryDraft,
  removeRecoveryDraft,
  type StudioDomain
} from "./recoveryDraft.js";

export {
  withImportedPlayerTemplateAsset,
  withImportedPlayerSkinToneAsset,
  withImportedPlayerHeadAsset,
  withImportedPlayerHeadSkinToneAsset,
  withPlayerTemplateTransform,
  withPlayerOverallScale,
  withPlayerMainAnchor,
  resetPlayerMainAnchor,
  withPlayerAnchorPosition
} from "./studioState.js";

const equipmentEntries = Object.values(EQUIPMENT_DEFINITIONS);
const gameplayFamilyEntries = Object.values(EQUIPMENT_GAMEPLAY_FAMILIES);
type ImportTarget = "appearance" | "base-body" | "skin-tone" | "head" | "head-skin-tone";
type PlayerLibraryMode = "overlays" | "gear";
type WorkspacePhase =
  | "loading"
  | "ready"
  | "disconnected"
  | "incompatible"
  | "server-mismatch"
  | "unavailable";
type SavePhase = "idle" | "saving" | "failed";

const CATEGORY_LABELS: Readonly<Record<PlayerAppearanceCategoryId, string>> = {
  hair: "Hair",
  eyes: "Eyes",
  nose_mouth: "Nose & Mouth (legacy)",
  nose: "Nose",
  mouth: "Mouth",
  mask: "Mask",
  body_armor: "Body Armor",
  gloves: "Gloves",
  boots: "Boots",
  weapon: "Weapons",
  shield: "Shields"
};

const STYLE_CATEGORIES = new Set<PlayerAppearanceCategoryId>([
  "hair",
  "eyes",
  "nose_mouth",
  "nose",
  "mouth",
  "mask"
]);
const GEAR_CATEGORIES: readonly PlayerAppearanceCategoryId[] = [
  "weapon", "shield", "body_armor", "gloves", "boots"
];
const OVERLAY_SLOT_LABELS: Readonly<Record<PlayerOverlaySlotId, string>> = {
  face: "Face",
  mask: "Mask",
  hair: "Hair",
  beard: "Beard",
  chest: "Chest",
  hands: "Hands",
  legs: "Legs",
  feet: "Feet",
  shield: "Shield"
};

export function App() {
  const api = useMemo(() => new StudioApi(), []);
  const [history, rawDispatch] = useReducer(
    studioReducer,
    DEFAULT_PLAYER_APPEARANCE_CATALOG,
    createStudioHistory
  );
  const [bossHistory, rawDispatchBoss] = useReducer(
    bossStudioReducer,
    DEFAULT_BOSS_APPEARANCE_CATALOG,
    createBossStudioHistory
  );
  // Undo steps follow what the author is doing: one pointer gesture, one nudge run or one field
  // session is one step (see historyCore.ts); everything else is a discrete step.
  const grouping = useEditGrouping({
    onEnd: () => { rawDispatch({ type: "endGroup" }); rawDispatchBoss({ type: "endGroup" }); },
    onCancel: (key) => { rawDispatch({ type: "cancelGroup", key }); rawDispatchBoss({ type: "cancelGroup", key }); }
  });
  const dispatch = useCallback((action: StudioAction) => {
    if (action.type !== "edit") { rawDispatch(action); return; }
    if (grouping.isCancelled()) return;
    const group = grouping.groupForEdit(action.group);
    rawDispatch(group ? { ...action, group, at: Date.now() } : action);
  }, [grouping]);
  const dispatchBoss = useCallback((action: BossStudioAction) => {
    if (action.type !== "edit") { rawDispatchBoss(action); return; }
    if (grouping.isCancelled()) return;
    const group = grouping.groupForEdit(action.group);
    rawDispatchBoss(group ? { ...action, group, at: Date.now() } : action);
  }, [grouping]);
  const runHistoryRef = useRef<(direction: "undo" | "redo") => void>(() => undefined);
  const [studioDomain, setStudioDomain] = useState<StudioDomain>("player");
  const [studioWorkspace, setStudioWorkspace] = useState<StudioWorkspace>(() => {
    try {
      const saved = sessionStorage.getItem("studio-workspace");
      return restoreStudioWorkspace(saved);
    } catch { return "appearance"; }
  });
  useEffect(() => { try { sessionStorage.setItem("studio-workspace", studioWorkspace); } catch { /* Storage is optional. */ } }, [studioWorkspace]);
  const [assetDirty, setAssetDirty] = useState(false);
  const [assetBusy, setAssetBusy] = useState(false);
  const [interiorDirty, setInteriorDirty] = useState(false);
  const [interiorBusy, setInteriorBusy] = useState(false);
  const [interiorHistory, setInteriorHistory] = useState({ undo: 0, redo: 0 });
  const [interiorIssueCount, setInteriorIssueCount] = useState(0);
  // One slide-over for the rarely used publish workflow and server connection, shared by every workspace.
  const [drawer, setDrawer] = useState<"publish" | "server" | null>(null);
  useEffect(() => {
    if (!drawer) return;
    const onKeyDown = (event: KeyboardEvent): void => { if (event.key === "Escape") setDrawer(null); };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [drawer]);
  const [playerHitGeometryState, setPlayerHitGeometryState] =
    useState<PlayerHitGeometryState | null>(null);
  const [progressionIconDirty, setProgressionIconDirty] = useState(false);
  const [progressionIconBusy, setProgressionIconBusy] = useState(false);
  const [territoryDirty, setTerritoryDirty] = useState(false);
  const [territoryBusy, setTerritoryBusy] = useState(false);
  const [selectedBossId, setSelectedBossId] =
    useState<BossAppearanceId>("xoral");
  const [session, setSession] = useState<StudioSession | null>(null);
  const [workspacePhase, setWorkspacePhase] = useState<WorkspacePhase>("loading");
  const [contentLoaded, setContentLoaded] = useState(false);
  const [savePhase, setSavePhase] = useState<SavePhase>("idle");
  const [itemVariants, setItemVariants] = useState<ItemVariantCatalog>(
    ITEM_VARIANT_CATALOG
  );
  const [savedItemVariants, setSavedItemVariants] = useState<ItemVariantCatalog>(
    ITEM_VARIANT_CATALOG
  );
  const [remote, setRemote] = useState<RemoteStudioInfo>({ connected: false });
  const [desktop, setDesktop] = useState<DesktopStudioStatus>({ available: false });
  const [releaseStatus, setReleaseStatus] = useState<DesktopReleaseStatus | null>(null);
  const [batchSlug, setBatchSlug] = useState("");
  const [batchSummary, setBatchSummary] = useState("");
  const [serverBase, setServerBase] = useState("http://127.0.0.1:3001");
  const [search, setSearch] = useState("");
  const [showRetired, setShowRetired] = useState(false);
  const [selectedCategoryId, setSelectedCategoryId] =
    useState<PlayerAppearanceCategoryId>("weapon");
  const [playerLibraryMode, setPlayerLibraryMode] =
    useState<PlayerLibraryMode>("gear");
  const [selectedOverlaySlot, setSelectedOverlaySlot] =
    useState<PlayerAuthorableOverlaySlotId>("face");
  const [selectedFamilyId, setSelectedFamilyId] = useState("one_handed_sword");
  const [selectedPartId, setSelectedPartId] = useState<AppearancePartId>("main");
  const [authoringMode, setAuthoringMode] = useState<"new" | "edit">("edit");
  const [selectedItemId, setSelectedItemId] =
    useState<EquipmentDefinitionId>("starter_sword");
  const [newGameplayFamilyId, setNewGameplayFamilyId] =
    useState<EquipmentGameplayFamilyId>("sword");
  const [newItemId, setNewItemId] = useState("");
  const [newDisplayName, setNewDisplayName] = useState("");
  const [importTarget, setImportTarget] = useState<ImportTarget>("appearance");
  const [selectedSkinToneId, setSelectedSkinToneId] =
    useState<PlayerSkinToneId>(DEFAULT_PLAYER_SKIN_TONE_ID);
  const [zoom, setZoom] = useState(1);
  const [actualScale, setActualScale] = useState(false);
  const [showGuides, setShowGuides] = useState(true);
  const [showAnchors, setShowAnchors] = useState(true);
  const [showOverlayPicker, setShowOverlayPicker] = useState(false);
  const [showGemPreview, setShowGemPreview] = useState(false);
  const [previewGemstone, setPreviewGemstone] =
    useState<EnchantmentStoneVariant>("diamond");
  const [previewCoreId, setPreviewCoreId] = useState<EquipmentCoreId | "">("");
  const [overlayAppearanceIds, setOverlayAppearanceIds] =
    useState<AppearanceDefinitionId[]>([]);
  const [overlayCandidateId, setOverlayCandidateId] =
    useState<AppearanceDefinitionId | "">("");
  const [selectedPose, setSelectedPose] =
    useState<PlayerCombatPoseId>("idle");
  const [previewEditTarget, setPreviewEditTarget] =
    useState<PreviewEditTarget>("item");
  const [projectileAimDegrees, setProjectileAimDegrees] = useState(0);
  const [showProjectileTarget, setShowProjectileTarget] = useState(true);
  const [bossPreviewEditTarget, setBossPreviewEditTarget] =
    useState<BossPreviewEditTarget>("weapon");
  const [selectedAnchorId, setSelectedAnchorId] =
    useState<PlayerAttachmentAnchorId>("face");
  const [message, setMessage] = useState("Loading workspace…");
  const [busy, setBusy] = useState(false);
  const [authorizing, setAuthorizing] = useState(false);
  const [clipboard, setClipboard] = useState<AppearancePlacementOverride | null>(null);
  const [pendingDeleteId, setPendingDeleteId] = useState<AppearanceDefinitionId | null>(null);
  const [projectileDraftAppearanceId, setProjectileDraftAppearanceId] =
    useState<AppearanceDefinitionId | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const projectileFileInputRef = useRef<HTMLInputElement>(null);
  const bossFileInputRef = useRef<HTMLInputElement>(null);
  const newItemIdInputRef = useRef<HTMLInputElement>(null);
  const saveInFlightRef = useRef(false);
  const assetStudioRef = useRef<AssetStudioHandle>(null);
  const interiorStudioRef = useRef<InteriorStudioHandle>(null);
  const progressionIconStudioRef = useRef<ProgressionIconStudioHandle>(null);
  const territoryStudioRef = useRef<TerritoryStudioHandle>(null);
  const itemVariantsRef = useRef(itemVariants);
  const historyRevisionRef = useRef(history.revision);
  const bossHistoryRevisionRef = useRef(bossHistory.revision);
  const selectionByContextRef = useRef<Record<string, AppearanceDefinitionId>>({});
  itemVariantsRef.current = itemVariants;
  historyRevisionRef.current = history.revision;
  bossHistoryRevisionRef.current = bossHistory.revision;

  const catalog = history.present;
  const bossCatalog = bossHistory.present;
  const selectedBoss = bossCatalog.bosses.find(
    (boss) => boss.bossId === selectedBossId
  ) ?? bossCatalog.bosses[0] ?? null;
  const selected = catalog.appearances.find(
    (appearance) => appearance.appearanceId === history.selectedId
  ) ?? null;
  const selectedAppearanceFamily = selected
    ? catalog.families.find((family) => family.familyId === selected.familyId) ?? null
    : null;
  const selectedSupportsGem = selected
    ? appearanceSupportsGem(catalog, selected)
    : false;
  const selectedGemSocket = selectedSupportsGem && selected
    ? equipmentGemSocket(catalog, selected.appearanceId)
    : null;
  const selectedSalonCategory = selected ? salonAppearanceCategory(catalog, selected) : null;
  const selectedFaceFeature = isFaceFeatureCategory(selectedSalonCategory)
    ? selectedSalonCategory
    : null;
  const selectedFeatureArea = selectedFaceFeature
    ? faceFeatureArea(catalog, selectedFaceFeature)
    : null;
  const [selectedFeatureVertex, setSelectedFeatureVertex] = useState<number | null>(null);
  const previewFeature = useMemo(() => ({
    area: selectedFeatureArea,
    selectedVertex: selectedFeatureVertex
  }), [selectedFeatureArea, selectedFeatureVertex]);
  const selectedPart = selectedPartId === "main"
    ? null
    : selected?.parts?.find((part) => part.partId === selectedPartId) ?? null;
  const selectedPoseOverride = selectedPose === "idle"
    ? null
    : selectedPartId === "main"
      ? selected?.placements?.[selectedPose]
      : selectedPart?.placements?.[selectedPose];
  const poseHasOverride = Boolean(
    selectedPoseOverride && Object.keys(selectedPoseOverride).length > 0
  );
  const bossPoseHasOverride = Boolean(
    selectedBoss && selectedPose !== "idle" &&
      selectedBoss.weapon.placements[selectedPose] &&
      Object.keys(selectedBoss.weapon.placements[selectedPose] ?? {}).length > 0
  );
  const resolvedBossWeaponTransform = selectedBoss
    ? resolveBossWeaponTransform(bossCatalog, selectedBoss.bossId, selectedPose)
    : null;
  const previewSelected = previewEditTarget === "item" || previewEditTarget === "pivot" ||
    previewEditTarget === "gem" ||
    previewEditTarget === "feature_anchor" || previewEditTarget === "feature_area" ||
    previewEditTarget === "main" ||
    previewEditTarget === "projectile" || previewEditTarget === "projectile_impact" ||
    previewEditTarget === "projectile_tail"
    ? selected
    : null;
  const selectedProjectileTransform = selected?.projectileAssetKey
    ? selected.projectileTransform ?? DEFAULT_PROJECTILE_TRANSFORM
    : null;
  const projectilePreviewMode = previewEditTarget === "projectile" ||
    previewEditTarget === "projectile_impact" ||
    previewEditTarget === "projectile_tail";
  const resolvedPlacement = selected
    ? resolveAppearancePlacement(
        catalog,
        selected.appearanceId,
        selectedPose,
        selectedPartId
      )
    : null;
  const selectedTemplateTransform = previewEditTarget === "template"
    ? playerTemplateTransform(catalog, "default", selectedPose)
    : null;
  const selectedAnchorPoint =
    playerBodyPose(catalog, "default", selectedPose).anchors[selectedAnchorId];
  const selectedMainAnchor = playerMainAnchor(catalog, "default");
  const overallScale = playerOverallScale(catalog, "default");
  const selectedBossOverallScale = selectedBoss
    ? bossOverallScale(bossCatalog, selectedBoss.bossId)
    : 1;
  const selectedOppositeAnchorId = oppositeAnchorId(selectedAnchorId);
  const masterScaleSupported =
    (session?.workspace.compatibility.contractVersion ?? 0) >=
      MASTER_SCALE_CONTRACT_VERSION;
  const bossStudioSupported =
    (session?.workspace.compatibility.contractVersion ?? 0) >=
      BOSS_AUTHORING_CONTRACT_VERSION;
  const bossMasterScaleSupported =
    (session?.workspace.compatibility.contractVersion ?? 0) >=
      BOSS_MASTER_SCALE_CONTRACT_VERSION;
  const projectileAuthoringSupported =
    (session?.workspace.compatibility.contractVersion ?? 0) >=
      PROJECTILE_AUTHORING_CONTRACT_VERSION;
  const projectileTransformSupported =
    (session?.workspace.compatibility.contractVersion ?? 0) >=
      PROJECTILE_TRANSFORM_CONTRACT_VERSION;
  const equipmentEnhancementSupported =
    (session?.workspace.compatibility.contractVersion ?? 0) >=
      EQUIPMENT_ENHANCEMENT_CONTRACT_VERSION;
  const expandedGemstonesSupported =
    (session?.workspace.compatibility.contractVersion ?? 0) >=
      EXPANDED_GEMSTONE_CONTRACT_VERSION;
  const mainAnchorSupported =
    (session?.workspace.compatibility.contractVersion ?? 0) >=
      MAIN_ANCHOR_CONTRACT_VERSION;
  const playerHitGeometrySupported =
    (session?.workspace.compatibility.contractVersion ?? 0) >=
      PLAYER_HIT_GEOMETRY_CONTRACT_VERSION;
  const faceFeatureAuthoringSupported =
    (session?.workspace.compatibility.contractVersion ?? 0) >=
      FACE_FEATURE_CONTRACT_VERSION;
  const featureEditing = previewEditTarget === "feature_anchor" ||
    previewEditTarget === "feature_area";
  const featureEditingAvailable = faceFeatureAuthoringSupported &&
    Boolean(selectedFaceFeature && selectedFeatureArea);
  useEffect(() => {
    if (featureEditing && !featureEditingAvailable) setPreviewEditTarget("item");
  }, [featureEditing, featureEditingAvailable]);
  useEffect(() => {
    if (session && !mainAnchorSupported && previewEditTarget === "main") {
      setPreviewEditTarget("item");
    }
  }, [mainAnchorSupported, previewEditTarget, session]);
  const previewGemstones = expandedGemstonesSupported
    ? ENCHANTMENT_STONE_VARIANTS
    : ENCHANTMENT_STONE_VARIANTS.filter((gemstone) =>
        gemstone !== "onyx" && gemstone !== "topaz"
      );
  const previewEditTargets: PreviewEditTarget[] = ["item", "pivot"];
  if (selectedSupportsGem && equipmentEnhancementSupported) previewEditTargets.push("gem");
  if (featureEditingAvailable) previewEditTargets.push("feature_anchor", "feature_area");
  if (selectedProjectileTransform && projectileTransformSupported) {
    previewEditTargets.push("projectile", "projectile_impact", "projectile_tail");
  }
  previewEditTargets.push("overall", "template");
  if (mainAnchorSupported) previewEditTargets.push("main");
  previewEditTargets.push("anchors");
  const playerCatalogDirty = studioIsDirty(history) ||
    JSON.stringify(itemVariants) !== JSON.stringify(savedItemVariants);
  const playerHitGeometryDirty = playerHitGeometrySupported &&
    Boolean(playerHitGeometryState?.dirty);
  const playerDirty = playerCatalogDirty || playerHitGeometryDirty;
  const bossDirty = bossStudioIsDirty(bossHistory);
  const appearanceDirty = playerDirty || bossDirty;
  const dirty = appearanceDirty || assetDirty || interiorDirty || progressionIconDirty || territoryDirty;

  useEffect(() => {
    if (!bossMasterScaleSupported && bossPreviewEditTarget === "overall") {
      setBossPreviewEditTarget("weapon");
    }
  }, [bossMasterScaleSupported, bossPreviewEditTarget]);

  useEffect(() => {
    if (projectilePreviewMode && !selectedProjectileTransform) {
      setPreviewEditTarget("item");
    }
  }, [projectilePreviewMode, selectedProjectileTransform]);

  useEffect(() => {
    if (
      previewEditTarget === "gem" &&
      (!selectedSupportsGem || !equipmentEnhancementSupported)
    ) {
      setPreviewEditTarget("item");
    }
  }, [equipmentEnhancementSupported, previewEditTarget, selectedSupportsGem]);

  useEffect(() => {
    if (studioDomain === "hues" && !equipmentEnhancementSupported) {
      setStudioDomain("player");
    }
  }, [equipmentEnhancementSupported, studioDomain]);

  const showGemstonePreview = previewEditTarget === "gem" || showGemPreview;
  const enhancementPreview = equipmentEnhancementSupported && selectedSupportsGem && (
    showGemstonePreview || previewCoreId !== ""
  ) ? {
      gemstone: previewGemstone,
      coreId: selected && appearanceCategory(catalog, selected.appearanceId) === "weapon"
        ? previewCoreId || null
        : null
    } : null;

  const itemEntries = [
    ...equipmentEntries
      .filter((definition) => {
        const liveVariant = itemVariants.variants.find((variant) =>
          variant.definitionId === definition.definitionId
        );
        if (!liveVariant && definition.retired) return false;
        return showRetired || (
          !liveVariant?.retired &&
          !itemAppearanceForDefinition(catalog, itemVariants, definition.definitionId)?.retired
        );
      }),
    ...itemVariants.variants
      .filter((variant) => showRetired || (
        !variant.retired &&
        !catalog.appearances.find((appearance) =>
          appearance.appearanceId === variant.appearanceId
        )?.retired
      ))
      .filter((variant) => !Object.hasOwn(EQUIPMENT_DEFINITIONS, variant.definitionId))
      .map(equipmentDefinitionFromItemVariant)
  ];
  const categoryFamilies = catalog.families.filter((family) =>
    family.familyId !== "back_item" && (playerLibraryMode === "overlays"
      ? playerOverlaySlotForFamily(family) === selectedOverlaySlot &&
        family.compatibleEquipmentDefinitionIds.length === 0
      : family.categoryId === selectedCategoryId)
  );
  const selectedFamily = categoryFamilies.find((family) =>
    family.familyId === selectedFamilyId
  ) ?? categoryFamilies[0] ?? null;
  const categoryGameplayFamilies = selectedFamily
    ? gameplayFamilyEntries.filter((family) =>
        selectedFamily.compatibleEquipmentDefinitionIds.includes(
          family.authoringBaseDefinitionId
        )
      )
    : [];
  const categoryItemEntries = selectedFamily
    ? itemEntries.filter((definition) => {
        const baseId = EQUIPMENT_GAMEPLAY_FAMILIES[
          definition.gameplayFamilyId
        ].authoringBaseDefinitionId;
        return selectedFamily.compatibleEquipmentDefinitionIds.includes(
          baseId
        );
      })
    : [];
  const isStyleCategory = STYLE_CATEGORIES.has(selectedCategoryId);
  const isPairedCategory = selectedCategoryId === "gloves" || selectedCategoryId === "boots";
  const effectivePartId: AppearancePartId = isPairedCategory ? selectedPartId : "main";
  const selectedAppearanceDefinitionId = selected?.equipmentDefinitionId ??
    selected?.compatibleEquipmentDefinitionIds?.[0];
  const selectedAppearanceBaseId = selectedAppearanceDefinitionId
    ? EQUIPMENT_GAMEPLAY_FAMILIES[
        EQUIPMENT_DEFINITIONS[selectedAppearanceDefinitionId]?.gameplayFamilyId ?? "sword"
      ].authoringBaseDefinitionId
    : null;
  const inspectorFamilies = selected
    ? catalog.families.filter((family) =>
        family.categoryId === appearanceCategory(catalog, selected.appearanceId) &&
        family.familyId !== "back_item" &&
        (
          selectedAppearanceBaseId === null ||
          family.compatibleEquipmentDefinitionIds.includes(selectedAppearanceBaseId)
        )
      )
    : [];
  const overlayAppearances = overlayAppearanceIds
    .map((appearanceId) => catalog.appearances.find((appearance) =>
      appearance.appearanceId === appearanceId
    ))
    .filter((appearance): appearance is AppearanceDefinition => Boolean(appearance));
  const availableOverlayAppearances = catalog.appearances.filter((appearance) =>
    appearance.appearanceId !== selected?.appearanceId &&
    !overlayAppearanceIds.includes(appearance.appearanceId) &&
    (showRetired || !appearance.retired)
  );
  const effectiveOverlayCandidateId = availableOverlayAppearances.some((appearance) =>
    appearance.appearanceId === overlayCandidateId
  )
    ? overlayCandidateId
    : availableOverlayAppearances[0]?.appearanceId ?? "";
  const selectedIsDraftVariant = Boolean(selected) &&
    !history.saved.appearances.some((appearance) =>
      appearance.appearanceId === selected!.appearanceId
    );
  const selectedLinkedVariant = selected
    ? itemVariants.variants.find((variant) => variant.appearanceId === selected.appearanceId)
    : undefined;
  const selectedIsRetired = Boolean(selected?.retired || selectedLinkedVariant?.retired);
  const selectedCanRemoveAppearance = Boolean(selected) && !selectedIsDraftVariant;
  const selectedGearItemHasNoAppearance = playerLibraryMode === "gear" &&
    authoringMode === "edit" && !selected;
  const selectedGearItemDisplayName =
    EQUIPMENT_DEFINITIONS[selectedItemId]?.displayName ?? selectedItemId;

  useEffect(() => {
    const family = categoryFamilies.find((candidate) =>
      candidate.familyId === selectedFamilyId
    ) ?? categoryFamilies[0];
    if (!family) return;
    if (family.familyId !== selectedFamilyId) setSelectedFamilyId(family.familyId);
    const firstGameplayFamily = gameplayFamilyEntries.find((definition) =>
      family.compatibleEquipmentDefinitionIds.includes(definition.authoringBaseDefinitionId)
    );
    if (firstGameplayFamily?.stockDefinitionId) {
      setNewGameplayFamilyId(firstGameplayFamily.familyId);
      setSelectedItemId(firstGameplayFamily.stockDefinitionId);
    }
    setSelectedPartId(
      selectedCategoryId === "gloves" || selectedCategoryId === "boots" ? "right" : "main"
    );
  }, [selectedCategoryId, selectedFamilyId]);

  const bootstrap = useCallback(async (): Promise<void> => {
    setWorkspacePhase("loading");
    setMessage("Loading workspace…");
    try {
      const loadedSession = await api.loadSession();
      setSession(loadedSession);
      if (!loadedSession.workspace.compatibility.compatible) {
        setWorkspacePhase("incompatible");
        setMessage(appearanceStudioUpdateMessage(loadedSession));
        return;
      }
      if (loadedSession.server.commitSha !== loadedSession.workspace.commitSha) {
        setWorkspacePhase("server-mismatch");
        setMessage(studioServerMismatchMessage(loadedSession));
        return;
      }
      const [loadedCatalog, loadedItemVariants, loadedBossCatalog] = await Promise.all([
        api.loadCatalog(),
        api.loadItemVariants(),
        api.loadBossCatalog()
      ]);
      const recoveryDraft = readRecoveryDraft(loadedSession);
      if (
        recoveryDraft &&
        recoveryDraft.baseCatalogRevision === loadedCatalog.catalogRevision &&
        (
          recoveryDraft.bossCatalog === undefined ||
          recoveryDraft.baseBossCatalogRevision === loadedBossCatalog.catalogRevision
        )
      ) {
        dispatch({
          type: "restoreDraft",
          catalog: recoveryDraft.catalog,
          saved: loadedCatalog,
          selectedId: recoveryDraft.selectedId
        });
        setItemVariants(recoveryDraft.itemVariants);
        setSavedItemVariants(loadedItemVariants);
        dispatchBoss(recoveryDraft.bossCatalog
          ? {
              type: "restoreDraft",
              catalog: recoveryDraft.bossCatalog,
              saved: loadedBossCatalog
            }
          : { type: "load", catalog: loadedBossCatalog });
        const recoveredDomain = recoveryDraft.studioDomain;
        setStudioDomain(
          recoveredDomain === "boss" &&
            (loadedSession.workspace.compatibility.contractVersion ?? 0) >=
              BOSS_AUTHORING_CONTRACT_VERSION
            ? "boss"
            : recoveredDomain === "hues" &&
              (loadedSession.workspace.compatibility.contractVersion ?? 0) >=
                EQUIPMENT_ENHANCEMENT_CONTRACT_VERSION
              ? "hues"
              : "player"
        );
        setSelectedBossId(
          recoveryDraft.selectedBossId ?? loadedBossCatalog.bosses[0]!.bossId
        );
        setSelectedCategoryId(recoveryDraft.selectedCategoryId);
        setSelectedFamilyId(recoveryDraft.selectedFamilyId);
        if (recoveryDraft.selectedId) {
          selectionByContextRef.current[
            selectionContextKey(
              recoveryDraft.selectedCategoryId,
              recoveryDraft.selectedFamilyId
            )
          ] = recoveryDraft.selectedId;
        }
        setMessage(`Recovered unsaved changes from ${formatRecoveryTime(recoveryDraft.savedAt)}.`);
      } else {
        if (recoveryDraft) removeRecoveryDraft(loadedSession);
        const initialId = firstAppearanceForContext(
          loadedCatalog,
          "weapon",
          "one_handed_sword"
        );
        dispatch({ type: "load", catalog: loadedCatalog, selectedId: initialId });
        setItemVariants(loadedItemVariants);
        setSavedItemVariants(loadedItemVariants);
        dispatchBoss({ type: "load", catalog: loadedBossCatalog });
        setSelectedBossId(loadedBossCatalog.bosses[0]!.bossId);
        if (initialId) {
          selectionByContextRef.current[
            selectionContextKey("weapon", "one_handed_sword")
          ] = initialId;
        }
        setMessage(
          loadedSession.workspace.writesAllowed
            ? "Workspace ready."
            : loadedSession.workspace.writeBlockReason ?? "Writes are blocked."
        );
      }
      setContentLoaded(true);
      setWorkspacePhase("ready");

      const [remoteResult, desktopResult] = await Promise.allSettled([
        api.remoteStatus(),
        api.desktopStatus()
      ]);
      if (remoteResult.status === "fulfilled") setRemote(remoteResult.value);
      if (desktopResult.status === "fulfilled") {
        setDesktop(desktopResult.value);
        if (desktopResult.value.available) {
          try {
            setReleaseStatus(await api.releaseStatus());
          } catch (error) {
            setMessage(errorMessage(error));
          }
        }
      }
    } catch (error) {
      if (error instanceof StaleStudioResponseError) return;
      setWorkspacePhase("unavailable");
      setMessage(errorMessage(error));
    }
  }, [api]);

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  useEffect(() => {
    if (!contentLoaded || !session) return;
    if (appearanceDirty) {
      writeRecoveryDraft(session, {
        baseCatalogRevision: history.saved.catalogRevision,
        baseBossCatalogRevision: bossHistory.saved.catalogRevision,
        catalog: history.present,
        itemVariants,
        bossCatalog: bossHistory.present,
        studioDomain,
        selectedBossId,
        selectedId: history.selectedId,
        selectedCategoryId,
        selectedFamilyId,
        savedAt: new Date().toISOString()
      });
    } else {
      removeRecoveryDraft(session);
    }
  }, [
    contentLoaded,
    appearanceDirty,
    history.present,
    history.saved.catalogRevision,
    history.selectedId,
    itemVariants,
    bossHistory.present,
    studioDomain,
    selectedBossId,
    selectedCategoryId,
    selectedFamilyId,
    session
  ]);

  useEffect(() => {
    if (!contentLoaded) return;
    let cancelled = false;
    const timer = window.setInterval(() => {
      void api.loadSession().then((nextSession) => {
        if (cancelled) return;
        if (nextSession.server.commitSha !== nextSession.workspace.commitSha) {
          setSession(nextSession);
          setWorkspacePhase("server-mismatch");
          setMessage(studioServerMismatchMessage(nextSession));
          return;
        }
        const recovered = workspacePhase !== "ready";
        setSession(nextSession);
        setWorkspacePhase("ready");
        if (recovered) setMessage("Workspace connection restored. Unsaved changes were preserved.");
      }).catch((error: unknown) => {
        if (cancelled || error instanceof StaleStudioResponseError) return;
        setWorkspacePhase("disconnected");
        setMessage(`Workspace disconnected: ${errorMessage(error)}`);
      });
    }, 3_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [api, contentLoaded, workspacePhase]);

  useEffect(() => {
    if (!remote.connected) return;
    const timer = window.setInterval(() => {
      void api.remoteStatus().then(setRemote).catch((error: unknown) => {
        setRemote((current) => ({ ...current, error: errorMessage(error) }));
      });
    }, 5_000);
    return () => window.clearInterval(timer);
  }, [api, remote.connected]);

  useEffect(() => {
    if (!session) return;
    const worktree = worktreeName(session.workspace.worktreePath);
    const branch = session.workspace.branch ?? "detached";
    document.title = `Ash Atlas Appearance Studio — ${worktree} — ${branch}`;
  }, [session]);

  useEffect(() => {
    if (authoringMode === "new") newItemIdInputRef.current?.focus();
  }, [authoringMode]);

  const editSelected = useCallback((
    update: (appearance: AppearanceDefinition) => AppearanceDefinition
  ) => {
    if (!selected) return;
    const previousId = selected.appearanceId;
    const appearance = update(structuredClone(selected));
    dispatch({
      type: "edit",
      catalog: {
        ...catalog,
        appearances: catalog.appearances.map((candidate) => {
          if (candidate.appearanceId === previousId) return appearance;
          if (
            appearance.appearanceId !== previousId &&
            candidate.inheritAppearanceId === previousId
          ) {
            return {
              ...candidate,
              inheritAppearanceId: appearance.appearanceId
            };
          }
          return candidate;
        })
      },
      selectedId: appearance.appearanceId
    });
  }, [catalog, selected]);

  const editSelectedPlacement = useCallback((
    appearance: AppearanceDefinition,
    values: AppearancePlacementOverride
  ): AppearanceDefinition => {
    if (effectivePartId === "main") {
      return {
        ...appearance,
        placements: {
          ...appearance.placements,
          [selectedPose]: {
            ...appearance.placements?.[selectedPose],
            ...values
          }
        }
      };
    }
    if (!appearance.parts) return appearance;
    return {
      ...appearance,
      parts: appearance.parts.map((part) => part.partId === effectivePartId
        ? {
            ...part,
            placements: {
              ...part.placements,
              [selectedPose]: {
                ...part.placements?.[selectedPose],
                ...values
              }
            }
          }
        : part)
    };
  }, [effectivePartId, selectedPose]);

  const editPlacement = useCallback(<Key extends keyof AppearancePlacement>(
    key: Key,
    value: AppearancePlacement[Key]
  ) => {
    editSelected((appearance) => editSelectedPlacement(appearance, { [key]: value }));
  }, [editSelected, editSelectedPlacement]);

  const editProjectileTransform = useCallback((
    values: Partial<ProjectileTransform>
  ) => {
    if (!selected?.projectileAssetKey) return;
    editSelected((appearance) => ({
      ...appearance,
      projectileTransform: {
        ...(appearance.projectileTransform ?? DEFAULT_PROJECTILE_TRANSFORM),
        ...values
      }
    }));
  }, [editSelected, selected?.projectileAssetKey]);

  const nudgeProjectile = useCallback((x: number, y: number) => {
    if (!selectedProjectileTransform) return;
    const aimRadians = projectileAimDegrees * Math.PI / 180;
    const cosine = Math.cos(aimRadians);
    const sine = Math.sin(aimRadians);
    editProjectileTransform({
      offsetX: Math.round((selectedProjectileTransform.offsetX +
        cosine * x + sine * y) * 100) / 100,
      offsetY: Math.round((selectedProjectileTransform.offsetY -
        sine * x + cosine * y) * 100) / 100
    });
  }, [editProjectileTransform, projectileAimDegrees, selectedProjectileTransform]);

  const moveProjectilePoint = useCallback((
    point: "impact" | "tail",
    x: number,
    y: number
  ) => {
    if (!selectedProjectileTransform) return;
    const roundedX = Math.round(x * 10_000) / 10_000;
    const roundedY = Math.round(y * 10_000) / 10_000;
    const otherX = point === "impact"
      ? selectedProjectileTransform.tailX
      : selectedProjectileTransform.impactX;
    const otherY = point === "impact"
      ? selectedProjectileTransform.tailY
      : selectedProjectileTransform.impactY;
    if (Math.hypot(roundedX - otherX, roundedY - otherY) < 0.001) return;
    editProjectileTransform(point === "impact"
      ? { impactX: roundedX, impactY: roundedY }
      : { tailX: roundedX, tailY: roundedY });
  }, [editProjectileTransform, selectedProjectileTransform]);

  const nudge = useCallback((x: number, y: number) => {
    if (!resolvedPlacement) return;
    editSelected((appearance) => editSelectedPlacement(appearance, {
      offsetX: Math.round((resolvedPlacement.offsetX + x) * 100) / 100,
      offsetY: Math.round((resolvedPlacement.offsetY + y) * 100) / 100
    }));
  }, [editSelected, editSelectedPlacement, resolvedPlacement]);

  const editPivot = useCallback((
    offsetX: number,
    offsetY: number,
    pivotX: number,
    pivotY: number
  ) => {
    if (!selected) return;
    editSelected((appearance) => editSelectedPlacement(appearance, {
      offsetX: Math.round(offsetX * 100) / 100,
      offsetY: Math.round(offsetY * 100) / 100,
      pivotX: Math.round(pivotX * 10_000) / 10_000,
      pivotY: Math.round(pivotY * 10_000) / 10_000
    }));
  }, [editSelected, editSelectedPlacement, selected]);

  const editGemSocket = useCallback((x: number, y: number) => {
    if (!selected || !selectedGemSocket) return;
    editSelected((appearance) => ({
      ...appearance,
      gemSocket: {
        partId: selectedGemSocket.partId,
        x: clamp(Math.round(x * 10_000) / 10_000, 0, 1),
        y: clamp(Math.round(y * 10_000) / 10_000, 0, 1)
      }
    }));
  }, [editSelected, selected, selectedGemSocket]);

  const editFeatureAnchor = useCallback((x: number, y: number) => {
    editSelected((appearance) => ({
      ...appearance,
      featureAnchor: {
        x: clamp(Math.round(x * 10_000) / 10_000, 0, 1),
        y: clamp(Math.round(y * 10_000) / 10_000, 0, 1)
      }
    }));
  }, [editSelected]);

  const clearFeatureAnchor = useCallback(() => {
    editSelected(({ featureAnchor: _featureAnchor, ...appearance }) => appearance);
  }, [editSelected]);

  /** Replaces the selected category's one feature area; invalid areas are ignored. */
  const editFeatureArea = useCallback((
    area: FaceFeatureArea,
    selectedVertex: number | null = selectedFeatureVertex
  ) => {
    if (!selectedFeatureArea) return;
    if (faceFeaturePolygonIssue(area.polygon) ||
      !faceFeaturePointInPolygon(area.defaultPoint, area.polygon)) return;
    setSelectedFeatureVertex(selectedVertex);
    dispatch({
      type: "edit",
      catalog: {
        ...catalog,
        families: catalog.families.map((family) =>
          family.featureArea === selectedFeatureArea
            ? { ...family, featureArea: structuredClone(area) }
            : family)
      }
    });
  }, [catalog, selectedFeatureArea, selectedFeatureVertex]);

  const editEnhancementPresentation = useCallback((
    update: Partial<PlayerAppearanceCatalog["enhancementPresentation"]>
  ) => {
    dispatch({
      type: "edit",
      catalog: {
        ...catalog,
        enhancementPresentation: {
          ...catalog.enhancementPresentation,
          ...update
        }
      }
    });
  }, [catalog]);

  const editTemplateTransform = useCallback((
    transform: PlayerTemplateTransform
  ) => {
    dispatch({
      type: "edit",
      catalog: withPlayerTemplateTransform(catalog, selectedPose, transform)
    });
  }, [catalog, selectedPose]);

  const editAnchor = useCallback((
    anchorId: PlayerAttachmentAnchorId,
    x: number,
    y: number
  ) => {
    dispatch({
      type: "edit",
      catalog: withPlayerAnchorPosition(catalog, selectedPose, anchorId, x, y)
    });
  }, [catalog, selectedPose]);

  const editMainAnchor = useCallback((x: number, y: number) => {
    if (!mainAnchorSupported) return;
    dispatch({
      type: "edit",
      catalog: withPlayerMainAnchor(catalog, x, y)
    });
  }, [catalog, mainAnchorSupported]);

  const editOverallScale = useCallback((scale: number) => {
    dispatch({
      type: "edit",
      catalog: withPlayerOverallScale(catalog, scale)
    });
  }, [catalog]);

  const nudgePreview = useCallback((
    x: number,
    y: number,
    draggedAnchorId?: PlayerAttachmentAnchorId
  ) => {
    if (previewEditTarget === "projectile") {
      nudgeProjectile(x, y);
      return;
    }
    if (
      previewEditTarget === "projectile_impact" ||
      previewEditTarget === "projectile_tail"
    ) return;
    if (previewEditTarget === "item") {
      nudge(x, y);
      return;
    }
    if (
      previewEditTarget === "pivot" || previewEditTarget === "gem" ||
      previewEditTarget === "overall"
    ) return;
    if (previewEditTarget === "main") {
      if (!mainAnchorSupported) return;
      const anchor = playerMainAnchor(catalog, "default");
      editMainAnchor(anchor.x - x, anchor.y - y);
      return;
    }
    if (previewEditTarget === "anchors") {
      const anchorId = draggedAnchorId ?? selectedAnchorId;
      const anchor = playerBodyPose(catalog, "default", selectedPose).anchors[anchorId];
      editAnchor(anchorId, anchor.x + x, anchor.y + y);
      return;
    }
    const transform = playerTemplateTransform(
      catalog,
      "default",
      selectedPose
    );
    editTemplateTransform({
      ...transform,
      offsetX: Math.round((transform.offsetX + x) * 100) / 100,
      offsetY: Math.round((transform.offsetY + y) * 100) / 100
    });
  }, [
    catalog,
    editAnchor,
    editMainAnchor,
    editTemplateTransform,
    nudge,
    nudgeProjectile,
    previewEditTarget,
    mainAnchorSupported,
    selectedAnchorId,
    selectedPose
  ]);

  const editSelectedBoss = useCallback((
    update: (boss: BossAppearanceDefinition) => BossAppearanceDefinition
  ) => {
    if (!selectedBoss) return;
    dispatchBoss({
      type: "edit",
      catalog: {
        ...bossCatalog,
        bosses: bossCatalog.bosses.map((boss) =>
          boss.bossId === selectedBoss.bossId
            ? update(structuredClone(boss))
            : boss
        )
      }
    });
  }, [bossCatalog, selectedBoss]);

  const editBossWeaponPlacement = useCallback((
    values: Partial<AppearanceTransform>
  ) => {
    editSelectedBoss((boss) => ({
      ...boss,
      weapon: {
        ...boss.weapon,
        placements: {
          ...boss.weapon.placements,
          [selectedPose]: {
            ...boss.weapon.placements[selectedPose],
            ...values
          }
        }
      }
    }));
  }, [editSelectedBoss, selectedPose]);

  const nudgeBossWeapon = useCallback((x: number, y: number) => {
    if (!resolvedBossWeaponTransform) return;
    editBossWeaponPlacement({
      offsetX: Math.round((resolvedBossWeaponTransform.offsetX + x) * 100) / 100,
      offsetY: Math.round((resolvedBossWeaponTransform.offsetY + y) * 100) / 100
    });
  }, [editBossWeaponPlacement, resolvedBossWeaponTransform]);

  const editBossWeaponPivot = useCallback((
    offsetX: number,
    offsetY: number,
    pivotX: number,
    pivotY: number
  ) => {
    editBossWeaponPlacement({
      offsetX: Math.round(offsetX * 100) / 100,
      offsetY: Math.round(offsetY * 100) / 100,
      pivotX: Math.round(pivotX * 10_000) / 10_000,
      pivotY: Math.round(pivotY * 10_000) / 10_000
    });
  }, [editBossWeaponPlacement]);

  const editBossOverallScale = useCallback((overallScale: number) => {
    editSelectedBoss((boss) => ({ ...boss, overallScale }));
  }, [editSelectedBoss]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented) return;
      // Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z and Ctrl+Y work on every workspace, including while a field is focused.
      if ((event.ctrlKey || event.metaKey) && !event.altKey) {
        const key = event.key.toLowerCase();
        if (key === "z" || key === "y") {
          event.preventDefault();
          runHistoryRef.current(key === "y" || event.shiftKey ? "redo" : "undo");
          return;
        }
      }
      if (studioWorkspace !== "appearance") return;
      const target = event.target;
      const editingText =
        target instanceof HTMLElement &&
        Boolean(target.closest("input, select, textarea, [contenteditable=true]"));
      if (editingText) return;
      if (studioDomain === "boss") {
        if (
          editingText ||
          bossPreviewEditTarget !== "weapon" ||
          !selectedBoss?.weapon.assetKey
        ) return;
        const amount = event.shiftKey ? 5 : 1;
        const delta = event.key === "ArrowLeft" ? [-amount, 0]
          : event.key === "ArrowRight" ? [amount, 0]
          : event.key === "ArrowUp" ? [0, -amount]
          : event.key === "ArrowDown" ? [0, amount]
          : null;
        if (!delta) return;
        event.preventDefault();
        grouping.runGrouped(
          burstGroup(`nudge:boss:${selectedBoss?.bossId}:${bossPreviewEditTarget}`),
          () => nudgeBossWeapon(delta[0]!, delta[1]!)
        );
        return;
      }
      if (
        editingText ||
        previewEditTarget === "pivot" ||
        previewEditTarget === "gem" ||
        previewEditTarget === "overall" ||
        previewEditTarget === "projectile_impact" ||
        previewEditTarget === "projectile_tail" ||
        (previewEditTarget === "item" && !selected)
      ) return;
      const amount = event.shiftKey ? 5 : 1;
      const delta = event.key === "ArrowLeft" ? [-amount, 0]
        : event.key === "ArrowRight" ? [amount, 0]
        : event.key === "ArrowUp" ? [0, -amount]
        : event.key === "ArrowDown" ? [0, amount]
        : null;
      if (!delta) return;
      event.preventDefault();
      grouping.runGrouped(
        burstGroup(`nudge:${selected?.appearanceId}:${previewEditTarget}:${effectivePartId}:${selectedPose}:${previewEditTarget === "anchors" ? selectedAnchorId : ""}`),
        () => nudgePreview(delta[0]!, delta[1]!)
      );
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    grouping,
    effectivePartId,
    selectedAnchorId,
    selectedPose,
    selectedBoss?.bossId,
    bossPreviewEditTarget,
    nudgeBossWeapon,
    nudgePreview,
    previewEditTarget,
    selected,
    selectedBoss?.weapon.assetKey,
    studioDomain,
    studioWorkspace
  ]);

  const importFile = async (file: File): Promise<void> => {
    setBusy(true);
    try {
      if (file.type && file.type !== "image/png") {
        throw new Error("Appearance Studio accepts only transparent PNG assets.");
      }
      const family = importTarget === "appearance"
        ? familyForCategory(catalog, selectedCategoryId, selectedFamily?.familyId)
        : null;
      const category = importTarget !== "appearance"
        ? "bodies"
        : categoryForFamily(family!.familyId);
      if (authoringMode === "new" && importTarget === "appearance") {
        if (isStyleCategory) {
          createStyleAppearanceDraft({
            catalog,
            appearanceId: newItemId,
            displayName: newDisplayName,
            familyId: family!.familyId,
            assetKey: `${category}/staged.png`
          });
        } else if (playerLibraryMode === "overlays") {
          createPlayerOverlayAppearanceDraft({
            catalog,
            appearanceId: newItemId,
            displayName: newDisplayName,
            familyId: family!.familyId,
            assetKey: `${category}/staged.png`
          });
        } else {
          createItemVariantDraft({
            catalog,
            itemVariants,
            definitionId: newItemId,
            displayName: newDisplayName,
            familyId: newGameplayFamilyId,
            assetKey: `${category}/staged.png`,
            authoringLayer: family!.authoringLayer,
            partId: isPairedCategory ? "right" : effectivePartId
          });
        }
      }
      const imported = await api.importPng(file, category);
      if (importTarget === "base-body") {
        dispatch({
          type: "edit",
          catalog: withImportedPlayerTemplateAsset(catalog, selectedPose, imported.assetKey)
        });
        setMessage(
          `Imported ${imported.relativeFile} as the ${poseLabel(selectedPose)} Base Body / Player Base asset.`
        );
        return;
      }
      if (importTarget === "head") {
        dispatch({
          type: "edit",
          catalog: withImportedPlayerHeadAsset(catalog, selectedPose, imported.assetKey)
        });
        setMessage(
          `Imported ${imported.relativeFile} as the ${poseLabel(selectedPose)} Head asset. It shares the Base Body transform.`
        );
        return;
      }
      if (importTarget === "head-skin-tone") {
        dispatch({
          type: "edit",
          catalog: withImportedPlayerHeadSkinToneAsset(
            catalog,
            selectedSkinToneId,
            imported.assetKey
          )
        });
        setMessage(
          `Imported ${imported.relativeFile} as the ${PLAYER_SKIN_TONE_LABELS[selectedSkinToneId]} Head variant. It shares the Base Body transform.`
        );
        return;
      }
      if (importTarget === "skin-tone") {
        dispatch({
          type: "edit",
          catalog: withImportedPlayerSkinToneAsset(
            catalog,
            selectedSkinToneId,
            imported.assetKey
          )
        });
        setMessage(
          `Imported ${imported.relativeFile} as the ${PLAYER_SKIN_TONE_LABELS[selectedSkinToneId]} skin-tone variant. Shared Base Body transforms and overlays were preserved.`
        );
        return;
      }
      if (authoringMode === "new") {
        if (isStyleCategory) {
          const draft = createStyleAppearanceDraft({
            catalog,
            appearanceId: newItemId,
            displayName: newDisplayName,
            familyId: family!.familyId,
            assetKey: imported.assetKey
          });
          dispatch({
            type: "edit",
            catalog: draft.catalog,
            selectedId: draft.appearance.appearanceId
          });
          setMessage(`Staged ${draft.appearance.displayName} in ${CATEGORY_LABELS[selectedCategoryId]}.`);
        } else if (playerLibraryMode === "overlays") {
          const draft = createPlayerOverlayAppearanceDraft({
            catalog,
            appearanceId: newItemId,
            displayName: newDisplayName,
            familyId: family!.familyId,
            assetKey: imported.assetKey
          });
          dispatch({
            type: "edit",
            catalog: draft.catalog,
            selectedId: draft.appearance.appearanceId
          });
          setMessage(`Staged ${draft.appearance.displayName} in ${OVERLAY_SLOT_LABELS[selectedOverlaySlot]}.`);
        } else {
          const draft = createItemVariantDraft({
            catalog,
            itemVariants,
            definitionId: newItemId,
            displayName: newDisplayName,
            familyId: newGameplayFamilyId,
            assetKey: imported.assetKey,
            authoringLayer: family!.authoringLayer,
            partId: isPairedCategory ? "right" : effectivePartId
          });
          setItemVariants(draft.itemVariants);
          dispatch({
            type: "edit",
            catalog: draft.catalog,
            selectedId: draft.appearance.appearanceId
          });
          setSelectedItemId(draft.itemVariants.variants.at(-1)!.definitionId);
          setMessage(
            `Staged ${draft.appearance.displayName}; save to write its item and PNG files.`
          );
        }
        setAuthoringMode("edit");
      } else {
        if (playerLibraryMode === "overlays" || isStyleCategory) {
          if (!selected) throw new Error(`Select a ${CATEGORY_LABELS[selectedCategoryId]} variant first.`);
          editSelected((appearance) => ({ ...appearance, assetKey: imported.assetKey }));
          setMessage(`Staged ${imported.relativeFile} for ${selected.displayName}.`);
        } else {
          const updated = updateExistingItemAppearance({
            catalog,
            itemVariants,
            definitionId: selectedItemId,
            assetKey: imported.assetKey,
            partId: isPairedCategory ? "right" : effectivePartId
          });
          dispatch({
            type: "edit",
            catalog: updated.catalog,
            selectedId: updated.appearance.appearanceId
          });
          setMessage(`Staged ${imported.relativeFile} for ${selectedItemId}.`);
        }
      }
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const openPngPicker = (): void => {
    const input = fileInputRef.current;
    if (
      !input || busy ||
      (authoringMode === "edit" && !selected &&
        (playerLibraryMode === "overlays" || isStyleCategory))
    ) return;
    input.value = "";
    input.click();
  };

  const importProjectile = async (file: File): Promise<void> => {
    if (!selected || !projectileAuthoringSupported) return;
    setBusy(true);
    try {
      if (file.type && file.type !== "image/png") {
        throw new Error("Appearance Studio accepts only transparent PNG assets.");
      }
      const imported = await api.importPng(file, "projectiles");
      editSelected((appearance) => ({
        ...appearance,
        projectileAssetKey: imported.assetKey
      }));
      setProjectileDraftAppearanceId(null);
      setMessage(`Staged ${imported.relativeFile} as ${selected.displayName}'s hit projectile.`);
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const openProjectilePicker = (): void => {
    const input = projectileFileInputRef.current;
    if (!input || busy || !selected) return;
    input.value = "";
    input.click();
  };

  const importBossWeapon = async (file: File): Promise<void> => {
    if (!selectedBoss) return;
    setBusy(true);
    try {
      if (file.type && file.type !== "image/png") {
        throw new Error("Appearance Studio accepts only transparent PNG assets.");
      }
      const imported = await api.importBossWeaponPng(file, selectedBoss.bossId);
      editSelectedBoss((boss) => ({
        ...boss,
        weapon: {
          ...boss.weapon,
          assetKey: imported.assetKey
        }
      }));
      setMessage(`Staged ${imported.relativeFile} as ${selectedBoss.displayName}'s weapon.`);
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const openBossWeaponPicker = (): void => {
    const input = bossFileInputRef.current;
    if (!input || busy || !selectedBoss) return;
    input.value = "";
    input.click();
  };

  const publish = async (): Promise<void> => {
    if (saveInFlightRef.current || workspacePhase !== "ready") return;
    const shouldPublishCatalogs = playerCatalogDirty || bossDirty;
    const shouldPublishPlayerHitGeometry = playerHitGeometryDirty;
    if (!shouldPublishCatalogs && !shouldPublishPlayerHitGeometry) return;
    if (shouldPublishPlayerHitGeometry && assetBusy) return;
    saveInFlightRef.current = true;
    const submittedRevision = history.revision;
    const submittedBossRevision = bossHistory.revision;
    const submittedItemVariants = JSON.stringify(itemVariants);
    setBusy(true);
    setSavePhase("saving");
    setMessage("Saving changes to the worktree…");
    const failures: string[] = [];
    let catalogSavedMessage: string | null = null;
    let hitGeometrySaved = false;
    if (shouldPublishCatalogs) {
      try {
        const result = await api.publish(catalog, itemVariants, bossCatalog);
        dispatch({
          type: "markSaved",
          catalog: result.catalog,
          submittedRevision
        });
        dispatchBoss({
          type: "markSaved",
          catalog: result.bossCatalog,
          submittedRevision: submittedBossRevision
        });
        if (JSON.stringify(itemVariantsRef.current) === submittedItemVariants) {
          setItemVariants(result.itemVariants);
        }
        setSavedItemVariants(result.itemVariants);
        const newerEditsRemain = historyRevisionRef.current !== submittedRevision ||
          bossHistoryRevisionRef.current !== submittedBossRevision ||
          JSON.stringify(itemVariantsRef.current) !== submittedItemVariants;
        catalogSavedMessage =
          `Saved player revision ${result.catalog.catalogRevision} / ` +
          `boss revision ${result.bossCatalog.catalogRevision}: ` +
          `${result.modifiedFiles.join(", ")}` +
          (newerEditsRemain ? ". Newer edits remain unsaved." : "");
      } catch (error) {
        failures.push(errorMessage(error));
      }
    }
    if (shouldPublishPlayerHitGeometry) {
      try {
        hitGeometrySaved = await assetStudioRef.current!.save();
        if (!hitGeometrySaved) failures.push("Player touch box could not be saved.");
      } catch (error) {
        failures.push(errorMessage(error));
      }
    }
    try {
      if (failures.length === 0) {
        const nextSession = await api.loadSession();
        setSession(nextSession);
        setWorkspacePhase("ready");
        if (desktop.available) setReleaseStatus(await api.releaseStatus());
      }
    } catch (error) {
      failures.push(errorMessage(error));
    } finally {
      if (failures.length > 0) {
        setMessage(`Save failed — changes retained: ${failures.join(" ")}`);
        setSavePhase("failed");
      } else {
        setMessage(catalogSavedMessage ??
          (hitGeometrySaved ? "Saved player touch box to the worktree." : "Changes saved."));
        setSavePhase("idle");
      }
      saveInFlightRef.current = false;
      setBusy(false);
    }
  };

  const createBatch = async (): Promise<void> => {
    setBusy(true);
    try {
      const created = await api.createContentBatch(batchSlug);
      setReleaseStatus(null);
      setWorkspacePhase("loading");
      setMessage(`Created ${created.branch}; switching to ${created.worktreePath}…`);
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const refreshReleaseStatus = async (): Promise<string | null> => {
    try {
      setReleaseStatus(await api.releaseStatus());
      return null;
    } catch (error) {
      setReleaseStatus(null);
      return `Workflow status could not be refreshed. Reload Appearance Studio before continuing. (${errorMessage(error)})`;
    }
  };

  const finishBatch = async (): Promise<void> => {
    setBusy(true);
    try {
      const finished = await api.finishContentBatch(batchSummary);
      const successMessage =
        `Finished and pushed ${finished.branch}@${finished.commitSha.slice(0, 10)}: ` +
        finished.changedFiles.join(", ");
      setBatchSummary("");
      const refreshWarnings: string[] = [];
      try {
        setSession(await api.loadSession());
        setWorkspacePhase("ready");
      } catch (error) {
        refreshWarnings.push(
          `Workspace status could not be refreshed. Reload Appearance Studio before continuing. (${errorMessage(error)})`
        );
      }
      const releaseWarning = await refreshReleaseStatus();
      if (releaseWarning) refreshWarnings.push(releaseWarning);
      setMessage(
        `${successMessage}${refreshWarnings.length > 0 ? ` ${refreshWarnings.join(" ")}` : ""}`
      );
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const integrateBatch = async (): Promise<void> => {
    setBusy(true);
    setMessage("Integrating the pushed feature into Integration Test…");
    try {
      const integrated = await api.integrateContentBatch();
      const releaseWarning = await refreshReleaseStatus();
      setMessage(
        `Integrated into ${integrated.generation}@${integrated.integrationSha.slice(0, 10)}. ` +
        "This is in Integration Test, but is not automatically live." +
        (releaseWarning ? ` ${releaseWarning}` : "")
      );
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const deployIntegration = async (): Promise<void> => {
    if (!releaseStatus) return;
    setBusy(true);
    setMessage(`Publishing all of ${releaseStatus.integrationGeneration} to the public server…`);
    try {
      const deployed = await api.publishIntegrationTest(
        releaseStatus.integrationGeneration,
        releaseStatus.integrationSha
      );
      const releaseWarning = await refreshReleaseStatus();
      setMessage(
        `Public test server verified at ${deployed.generation}@${
          deployed.deployedSha.slice(0, 10)
        }.` + (releaseWarning ? ` ${releaseWarning}` : "")
      );
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const deleteSelectedVariant = (): void => {
    if (!selected || !selectedIsDraftVariant) return;
    const selectedId = selected.appearanceId;
    const linkedVariant = itemVariants.variants.find((variant) =>
      variant.appearanceId === selectedId
    );
    dispatch({
      type: "edit",
      catalog: {
        ...catalog,
        appearances: catalog.appearances
          .filter((appearance) => appearance.appearanceId !== selectedId)
          .map((appearance) => {
            if (appearance.inheritAppearanceId !== selectedId) return appearance;
            const next = { ...appearance };
            delete next.inheritAppearanceId;
            return next;
          })
      },
      selectedId: null
    });
    if (linkedVariant) {
      setItemVariants({
        ...itemVariants,
        variants: itemVariants.variants.filter((variant) =>
          variant.definitionId !== linkedVariant.definitionId
        )
      });
      setSelectedItemId(
        EQUIPMENT_GAMEPLAY_FAMILIES[linkedVariant.familyId].stockDefinitionId ??
          EQUIPMENT_GAMEPLAY_FAMILIES[linkedVariant.familyId].authoringBaseDefinitionId
      );
    }
    setOverlayAppearanceIds((appearanceIds) =>
      appearanceIds.filter((appearanceId) => appearanceId !== selectedId)
    );
    setAuthoringMode("new");
    setNewItemId("");
    setNewDisplayName("");
    setPendingDeleteId(null);
    setMessage(`Staged deletion of ${selected.displayName}. Click Save to Worktree to keep it.`);
  };

  const setSelectedAppearanceRemoved = (retired: boolean): void => {
    if (!selected || !selectedCanRemoveAppearance) return;
    const selectedId = selected.appearanceId;
    dispatch({
      type: "edit",
      catalog: {
        ...catalog,
        appearances: catalog.appearances.map((appearance) => {
          if (appearance.appearanceId !== selectedId) return appearance;
          const next = { ...appearance };
          if (retired) next.retired = true;
          else delete next.retired;
          if (next.salon) {
            next.salon = {
              ...next.salon,
              state: retired
                ? "retired"
                : next.salon.state === "retired" ? "selectable" : next.salon.state
            };
          }
          return next;
        })
      },
      selectedId: retired ? null : selectedId
    });
    setItemVariants({
      ...itemVariants,
      variants: itemVariants.variants.map((variant) => {
        if (variant.definitionId !== selectedLinkedVariant?.definitionId) {
          return variant;
        }
        const next = { ...variant };
        if (retired) next.retired = true;
        else delete next.retired;
        return next;
      })
    });
    setPendingDeleteId(null);
    if (retired) {
      setAuthoringMode("new");
      setMessage(
        `Staged removal of ${selected.displayName}. ${selectedLinkedVariant
          ? "Existing owned items and artwork remain valid."
          : "Existing player selections and artwork remain valid."}`
      );
    } else {
      setMessage(`Restored ${selected.displayName} to active appearance menus.`);
    }
  };

  const setSelectedVariantLimitedSale = (
    limitedSale: ItemVariantCatalog["variants"][number]["limitedSale"]
  ): void => {
    if (!selectedLinkedVariant || selectedLinkedVariant.role !== "cosmetic") return;
    setItemVariants({
      ...itemVariants,
      variants: itemVariants.variants.map((variant) => {
        if (variant.definitionId !== selectedLinkedVariant.definitionId) return variant;
        const next = { ...variant };
        if (limitedSale) next.limitedSale = limitedSale;
        else delete next.limitedSale;
        return next;
      })
    });
  };

  const filteredAppearances = catalog.appearances.filter((appearance) => {
    const query = search.trim().toLowerCase();
    const searchMatches = !query ||
      appearance.appearanceId.includes(query) ||
      appearance.displayName.toLowerCase().includes(query) ||
      appearanceAssetParts(appearance).some((part) =>
        part.assetKey.toLowerCase().includes(query)
      );
    return searchMatches &&
      (playerLibraryMode !== "overlays" || selectedFamily !== null) &&
      appearanceCategory(catalog, appearance.appearanceId) === selectedCategoryId &&
      (!selectedFamily || appearance.familyId === selectedFamily.familyId) &&
      (showRetired || !appearance.retired);
  });

  const drift = remote.connected && (
    remote.catalogRevision !== catalog.catalogRevision ||
    (
      remote.serverSha &&
      session?.workspace.commitSha &&
      remote.serverSha !== session.workspace.commitSha
    )
  );

  if (!contentLoaded) {
    return (
      <main className="studio-shell bootstrap-shell">
        <section className="panel bootstrap-panel" role="status">
          <p className="eyebrow">Ash Atlas authoring tools</p>
          <h1>Ash Atlas Studio</h1>
          <strong>{workspacePhase === "incompatible"
            ? "Appearance Studio update required"
            : workspacePhase === "server-mismatch"
              ? "Studio server mismatch"
              : workspacePhase === "unavailable"
                ? "Workspace unavailable"
                : "Loading workspace…"}</strong>
          <p>{message}</p>
          {(workspacePhase === "unavailable" || workspacePhase === "server-mismatch") && (
            <button type="button" className="primary" onClick={() => void bootstrap()}>
              Retry workspace connection
            </button>
          )}
        </section>
      </main>
    );
  }

  const serverStatus = authorizing
    ? "Authorizing…"
    : remote.error
      ? remote.connected ? "Unavailable" : "Authorization required"
      : remote.connected ? "Connected" : "Optional";

  const primaryStatus = workspacePhase === "server-mismatch"
    ? "Studio server mismatch"
    : workspacePhase === "disconnected"
    ? "Workspace disconnected"
    : workspacePhase === "loading"
      ? "Switching worktree…"
    : session && !session.workspace.writesAllowed
      ? dirty ? "Read-only workspace — edits cannot be saved" : "Read-only workspace — saving is disabled"
    : studioWorkspace === "interiors" && interiorBusy
      ? "Working with interiors…"
      : studioWorkspace === "interiors" && interiorDirty
        ? "Unsaved Interior Studio changes"
        : studioWorkspace === "interiors"
          ? "Interior catalog saved to worktree"
    : studioWorkspace === "assets" && assetBusy
      ? "Working with game PNGs…"
      : studioWorkspace === "assets" && assetDirty
        ? "Unsaved Asset Studio changes"
        : studioWorkspace === "assets"
          ? "Game PNGs saved to worktree"
    : studioWorkspace === "progression-icons" && progressionIconBusy
      ? "Saving progression icons…"
      : studioWorkspace === "progression-icons" && progressionIconDirty
        ? "Unsaved progression icon changes"
        : studioWorkspace === "progression-icons"
          ? "Progression icons saved to worktree"
    : studioWorkspace === "flags"
      ? territoryBusy ? "Working with Flags…" : territoryDirty ? "Unsaved Flags changes" : "Flags saved to worktree"
    : savePhase === "saving"
      ? "Saving to worktree…"
      : savePhase === "failed"
        ? "Save failed — changes retained"
        : dirty
          ? "Unsaved changes"
          : `Saved to worktree · revision ${catalog.catalogRevision}`;

  const activeHistory = studioDomain === "boss" ? bossHistory : history;
  const activeDomainDirty = studioDomain === "boss" ? bossDirty : playerDirty;
  // Global header actions: one definition of what Undo / Redo / Revert / Save mean on each workspace.
  const historySupported = studioWorkspace === "appearance" || studioWorkspace === "interiors";
  const workspaceHistory = studioWorkspace === "interiors"
    ? interiorHistory
    : studioWorkspace === "appearance"
      ? { undo: activeHistory.past.length, redo: activeHistory.future.length }
      : { undo: 0, redo: 0 };
  const revertDisabled = studioWorkspace === "flags" ? !territoryDirty || territoryBusy
    : studioWorkspace === "assets" ? !assetDirty || assetBusy
    : studioWorkspace === "progression-icons" ? !progressionIconDirty || progressionIconBusy
    : studioWorkspace === "interiors" ? !interiorDirty || interiorBusy
    : !activeDomainDirty || (studioDomain === "player" && playerHitGeometryDirty && assetBusy);
  const nothingToSave = studioWorkspace === "flags" ? !territoryDirty || territoryBusy
    : studioWorkspace === "assets" ? !assetDirty || assetBusy
    : studioWorkspace === "progression-icons" ? !progressionIconDirty || progressionIconBusy
    : studioWorkspace === "interiors" ? !interiorDirty || interiorBusy
    : !appearanceDirty || busy || (playerHitGeometryDirty && assetBusy);
  const saveBlockedReason = !session?.workspace.writesAllowed
    ? session?.workspace.writeBlockReason ?? "This workspace is read-only."
    : workspacePhase !== "ready"
      ? "The workspace is not connected."
      : studioWorkspace === "interiors" && interiorIssueCount > 0
        ? `Fix ${interiorIssueCount} validation error${interiorIssueCount === 1 ? "" : "s"} first.`
        : null;
  const saveDisabled = nothingToSave || saveBlockedReason !== null;
  const saveTitle = saveBlockedReason !== null
    ? `Cannot save: ${saveBlockedReason}`
    : nothingToSave ? "Nothing to save yet" : "Save changes to this worktree";
  const runRevert = (): void => {
    if (studioWorkspace === "flags") { void territoryStudioRef.current?.revert(); return; }
    if (studioWorkspace === "assets") { void assetStudioRef.current?.revert(); return; }
    if (studioWorkspace === "progression-icons") { void progressionIconStudioRef.current?.revert(); return; }
    if (studioWorkspace === "interiors") { void interiorStudioRef.current?.revert(); return; }
    if (studioDomain === "boss") {
      dispatchBoss({ type: "revert" });
    } else {
      dispatch({ type: "revert" });
      setItemVariants(structuredClone(savedItemVariants));
      if (playerHitGeometryDirty) assetStudioRef.current?.revertPlayerHitGeometry();
    }
  };
  const runSave = (): void => {
    if (studioWorkspace === "flags") void territoryStudioRef.current?.save();
    else if (studioWorkspace === "assets") void assetStudioRef.current?.save();
    else if (studioWorkspace === "progression-icons") void progressionIconStudioRef.current?.save();
    else if (studioWorkspace === "interiors") void interiorStudioRef.current?.save();
    else void publish();
  };
  const runHistory = (direction: "undo" | "redo"): void => {
    if (!historySupported) return;
    if (studioWorkspace === "interiors") {
      if (direction === "undo") interiorStudioRef.current?.undo(); else interiorStudioRef.current?.redo();
    } else if (studioDomain === "boss") dispatchBoss({ type: direction });
    else dispatch({ type: direction });
  };
  runHistoryRef.current = runHistory;
  const workspaceTabs: ReadonlyArray<{ id: StudioWorkspace; label: string }> = [
    { id: "appearance", label: "Appearance" },
    { id: "assets", label: "Game PNGs" },
    { id: "flags", label: "Flags" },
    { id: "interiors", label: "Interiors" },
    { id: "progression-icons", label: "Progression Icons" }
  ];

  return (
    <main className="studio-shell" data-workspace={studioWorkspace} data-testid="studio-shell">
      <header className="studio-header" data-testid="studio-header">
        <div className="studio-brand">
          <h1>Ash Atlas Studio</h1>
          {session ? (
            <div
              className="studio-worktree-identity"
              aria-label="Studio worktree identity"
              data-testid="studio-worktree-chip"
              title={`${session.workspace.worktreePath}\n${session.workspace.branch ?? "detached"}@${session.workspace.commitSha.slice(0, 10)}`}
            >
              <strong>{worktreeName(session.workspace.worktreePath)}</strong>
              <code>{session.workspace.branch ?? "detached"}@{
                session.workspace.commitSha.slice(0, 10)
              }</code>
              <span className="sr-only">{session.workspace.worktreePath}</span>
            </div>
          ) : null}
        </div>
        <nav className="workspace-switch segmented" aria-label="Studio workspace" data-testid="studio-workspace-tabs">
          {workspaceTabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              className={studioWorkspace === tab.id ? "active" : ""}
              aria-current={studioWorkspace === tab.id ? "page" : undefined}
              data-testid={`studio-tab-${tab.id}`}
              onClick={() => setStudioWorkspace(tab.id)}
            >{tab.label}</button>
          ))}
        </nav>
        <div className="header-actions" role="group" aria-label="Studio actions" data-testid="studio-actions">
          <button
            type="button"
            className="ghost"
            data-testid="studio-undo"
            disabled={!historySupported || workspaceHistory.undo === 0}
            title={historySupported ? "Undo the last edit" : "Undo is not available in this workspace"}
            onClick={() => runHistory("undo")}
          >Undo</button>
          <button
            type="button"
            className="ghost"
            data-testid="studio-redo"
            disabled={!historySupported || workspaceHistory.redo === 0}
            title={historySupported ? "Redo the last undone edit" : "Redo is not available in this workspace"}
            onClick={() => runHistory("redo")}
          >Redo</button>
          <button
            type="button"
            className="secondary"
            data-testid="studio-revert"
            disabled={revertDisabled}
            title={revertDisabled ? "No unsaved changes to revert" : "Discard unsaved changes"}
            onClick={runRevert}
          >Revert</button>
          <button
            type="button"
            className="primary"
            data-testid="studio-save"
            disabled={saveDisabled}
            title={saveTitle}
            onClick={runSave}
          >Save to Worktree</button>
          <span className="header-divider" aria-hidden="true" />
          {desktop.available ? <button
            type="button"
            className="secondary"
            data-testid="studio-publish"
            aria-expanded={drawer === "publish"}
            title="Commit, integrate and deploy your saved Studio changes"
            onClick={() => setDrawer(drawer === "publish" ? null : "publish")}
          >Publish…</button> : null}
          <button
            type="button"
            className="ghost"
            data-testid="studio-server"
            aria-expanded={drawer === "server"}
            title={`Selected server: ${serverStatus}`}
            onClick={() => setDrawer(drawer === "server" ? null : "server")}
          >Server<span className={`server-dot ${remote.connected && !remote.error ? "on" : ""}`} aria-hidden="true" /></button>
        </div>
      </header>

      {!session?.workspace.writesAllowed && session && (
        <div className="warning-banner" role="alert" data-testid="studio-readonly-banner" title={session.workspace.writeBlockReason ?? undefined}>
          <strong>Read-only workspace.</strong> {session.workspace.writeBlockReason}
        </div>
      )}

      {drift && (
        <div className="warning-banner drift" role="alert">
          <strong>Server content mismatch.</strong> Local revision {catalog.catalogRevision}
          {" · "}remote revision {remote.catalogRevision ?? "unknown"}. Preview locally before
          integrating; the remote API never writes appearance files.
        </div>
      )}

      <div className="appearance-workspace" data-testid="appearance-workspace" hidden={studioWorkspace !== "appearance"}>
      <section className="studio-domain-switch panel" aria-label="Authoring section" data-testid="appearance-section-bar">
        <div>
          <strong>{studioDomain === "player"
            ? "Player appearance"
            : studioDomain === "hues" ? "Core hues" : "Designated bosses"}</strong>
          <small>
            {studioDomain === "player"
              ? "Player bodies, styles, armor, and equipment"
              : studioDomain === "hues"
                ? "Universal weapon colors for every equipment core"
                : "Boss-only bodies and pose-driven weapon animation"}
          </small>
        </div>
        <div className="segmented domain-tabs" data-testid="appearance-domain-tabs" role="tablist" aria-label="Player or boss authoring">
          <button
            type="button"
            role="tab"
            aria-selected={studioDomain === "player"}
            className={studioDomain === "player" ? "active" : ""}
            onClick={() => setStudioDomain("player")}
          >Player</button>
          <button
            type="button"
            role="tab"
            disabled={!equipmentEnhancementSupported}
            title={equipmentEnhancementSupported
              ? "Author universal equipment core hues"
              : "Core hues require an Appearance Studio 1.16 content batch"}
            aria-selected={studioDomain === "hues"}
            className={studioDomain === "hues" ? "active" : ""}
            onClick={() => setStudioDomain("hues")}
          >Core Hues</button>
          <button
            type="button"
            role="tab"
            disabled={!bossStudioSupported}
            title={bossStudioSupported
              ? "Author designated boss weapons"
              : "Boss authoring requires an Appearance Studio 1.8 content batch"}
            aria-selected={studioDomain === "boss"}
            className={studioDomain === "boss" ? "active" : ""}
            onClick={() => setStudioDomain("boss")}
          >Bosses</button>
        </div>
      </section>

      {studioDomain === "player" ? (
      <section className="studio-grid" aria-label="Player appearance authoring">
        <aside className="panel library-panel" data-testid="appearance-library">
          <PanelTitle title="Library" meta={`${catalog.appearances.length} appearances`} />
          <div className="segmented authoring-mode" data-testid="appearance-library-mode" role="tablist" aria-label="Player library area">
            <button
              type="button"
              role="tab"
              aria-selected={playerLibraryMode === "overlays"}
              className={playerLibraryMode === "overlays" ? "active" : ""}
              onClick={() => {
                setPlayerLibraryMode("overlays");
                const family = catalog.families.find((candidate) =>
                  playerOverlaySlotForFamily(candidate) === selectedOverlaySlot &&
                  candidate.compatibleEquipmentDefinitionIds.length === 0
                );
                if (family) {
                  setSelectedCategoryId(family.categoryId);
                  setSelectedFamilyId(family.familyId);
                  dispatch({
                    type: "select",
                    appearanceId: firstAppearanceForContext(
                      catalog, family.categoryId, family.familyId
                    )
                  });
                }
              }}
            >Player Overlays</button>
            <button
              type="button"
              role="tab"
              aria-selected={playerLibraryMode === "gear"}
              className={playerLibraryMode === "gear" ? "active" : ""}
              onClick={() => {
                const familyId = "one_handed_sword";
                setPlayerLibraryMode("gear");
                setSelectedCategoryId("weapon");
                setSelectedFamilyId(familyId);
                dispatch({
                  type: "select",
                  appearanceId: firstAppearanceForContext(
                    catalog,
                    "weapon",
                    familyId,
                    selectionByContextRef.current[selectionContextKey("weapon", familyId)]
                  )
                });
              }}
            >Gear</button>
          </div>
          <nav className="category-list" data-testid="appearance-categories" aria-label="Appearance categories">
            {playerLibraryMode === "overlays" ? PLAYER_AUTHORABLE_OVERLAY_SLOT_IDS.map((overlaySlot) => (
              <button
                key={overlaySlot}
                type="button"
                className={selectedOverlaySlot === overlaySlot ? "selected" : ""}
                onClick={() => {
                  const family = catalog.families.find((candidate) =>
                    playerOverlaySlotForFamily(candidate) === overlaySlot &&
                    candidate.compatibleEquipmentDefinitionIds.length === 0
                  );
                setSelectedOverlaySlot(overlaySlot);
                  if (!family) {
                    dispatch({ type: "select", appearanceId: null });
                    return;
                  }
                  setSelectedCategoryId(family.categoryId);
                  setSelectedFamilyId(family.familyId);
                  dispatch({
                    type: "select",
                    appearanceId: firstAppearanceForContext(
                      catalog, family.categoryId, family.familyId
                    )
                  });
                }}
              >{OVERLAY_SLOT_LABELS[overlaySlot]}</button>
            )) : GEAR_CATEGORIES.map((categoryId) => (
              <button
                key={categoryId}
                type="button"
                className={selectedCategoryId === categoryId ? "selected" : ""}
                onClick={() => {
                  if (selected) {
                    selectionByContextRef.current[
                      selectionContextKey(selectedCategoryId, selectedFamily?.familyId)
                    ] = selected.appearanceId;
                  }
                  const nextFamilyId = catalog.families.find((family) =>
                    family.categoryId === categoryId && family.familyId !== "back_item"
                  )?.familyId;
                  setSelectedCategoryId(categoryId);
                  if (nextFamilyId) setSelectedFamilyId(nextFamilyId);
                  const context = selectionContextKey(categoryId, nextFamilyId);
                  dispatch({
                    type: "select",
                    appearanceId: firstAppearanceForContext(
                      catalog,
                      categoryId,
                      nextFamilyId,
                      selectionByContextRef.current[context]
                    )
                  });
                }}
              >{CATEGORY_LABELS[categoryId]}</button>
            ))}
          </nav>
          {((playerLibraryMode === "overlays" && categoryFamilies.length > 0) ||
            selectedCategoryId === "weapon" ||
            selectedCategoryId === "shield" ||
            selectedCategoryId === "body_armor") && (
            <label className="field">
              <span>{playerLibraryMode === "overlays"
                ? "Overlay family"
                : selectedCategoryId === "weapon"
                ? "Weapon type"
                : selectedCategoryId === "shield"
                  ? "Shield type"
                  : "Armor type"}</span>
              <select
                value={selectedFamily?.familyId ?? ""}
                onChange={(event) => {
                  const nextFamilyId = event.target.value;
                  const nextFamily = catalog.families.find((family) =>
                    family.familyId === nextFamilyId
                  );
                  if (selected) {
                    selectionByContextRef.current[
                      selectionContextKey(selectedCategoryId, selectedFamily?.familyId)
                    ] = selected.appearanceId;
                  }
                  setSelectedFamilyId(nextFamilyId);
                  if (nextFamily) setSelectedCategoryId(nextFamily.categoryId);
                  const context = selectionContextKey(selectedCategoryId, nextFamilyId);
                  dispatch({
                    type: "select",
                    appearanceId: firstAppearanceForContext(
                      catalog,
                      selectedCategoryId,
                      nextFamilyId,
                      selectionByContextRef.current[context]
                    )
                  });
                }}
              >
                {categoryFamilies.map((family) => (
                  <option key={family.familyId} value={family.familyId}>
                    {family.displayName}
                  </option>
                ))}
              </select>
            </label>
          )}
          {playerLibraryMode === "overlays" && !selectedFamily && (
            <p className="empty-copy">
              {OVERLAY_SLOT_LABELS[selectedOverlaySlot]} gear is authored under Gear. No standalone
              {` ${OVERLAY_SLOT_LABELS[selectedOverlaySlot]} overlay family exists.`}
            </p>
          )}
          <div className="segmented authoring-mode" data-testid="appearance-item-mode" aria-label="Item authoring mode">
            <button
              type="button"
              disabled={playerLibraryMode === "overlays" && !selectedFamily}
              className={authoringMode === "new" ? "active" : ""}
              onClick={() => setAuthoringMode("new")}
            >Create New Variant</button>
            <button
              type="button"
              className={authoringMode === "edit" ? "active" : ""}
              onClick={() => setAuthoringMode("edit")}
            >Edit Existing</button>
          </div>
          {authoringMode === "new" ? (
            <div className="authoring-fields">
              {playerLibraryMode === "gear" && !isStyleCategory && (
                <>
                  <label className="field">
                    <span>Mechanical family</span>
                    <select
                      value={newGameplayFamilyId}
                      onChange={(event) => {
                        const next = event.target.value as EquipmentGameplayFamilyId;
                        setNewGameplayFamilyId(next);
                      }}
                    >
                      {categoryGameplayFamilies.map((family) => (
                        <option key={family.familyId} value={family.familyId}>
                          {family.displayName} · {family.slot}
                        </option>
                      ))}
                    </select>
                  </label>
                  <p className="category-help">
                    New items are cosmetic and inherit every combat, matrix, and upgrade rule from
                    {" "}{EQUIPMENT_GAMEPLAY_FAMILIES[newGameplayFamilyId].displayName}.
                  </p>
                </>
              )}
              <TextField
                label={playerLibraryMode === "overlays" || isStyleCategory
                  ? "New appearance ID"
                  : "New item ID"}
                value={newItemId}
                inputRef={newItemIdInputRef}
                onChange={(value) => setNewItemId(
                  value
                    .toLowerCase()
                    .replace(/[^a-z0-9_-]+/gu, "-")
                    .replace(/^[^a-z0-9]+/u, "")
                    .slice(0, 64)
                )}
              />
              <p className="category-help">
                IDs are formatted automatically; for example, Hair 1 becomes hair-1.
              </p>
              <TextField
                label="Display name"
                value={newDisplayName}
                onChange={setNewDisplayName}
              />
            </div>
          ) : playerLibraryMode === "gear" && !isStyleCategory ? (
            <label className="field">
              <span>Existing item</span>
              <select
                value={selectedItemId}
                onChange={(event) => {
                  const next = event.target.value as EquipmentDefinitionId;
                  setSelectedItemId(next);
                  const appearance = itemAppearanceForDefinition(
                    catalog,
                    itemVariants,
                    next
                  );
                  dispatch({
                    type: "select",
                    appearanceId: appearance?.appearanceId ?? null
                  });
                  if (appearance) {
                    selectionByContextRef.current[
                      selectionContextKey(selectedCategoryId, selectedFamily?.familyId)
                    ] = appearance.appearanceId;
                  }
                }}
              >
                {categoryItemEntries.map((definition) => (
                  <option key={definition.definitionId} value={definition.definitionId}>
                    {definition.displayName} · {definition.slot}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <p className="category-help">
              Select an existing {CATEGORY_LABELS[selectedCategoryId].toLowerCase()} variant below,
              or switch to Create New Variant.
            </p>
          )}
          {playerLibraryMode === "gear" && authoringMode === "edit" &&
            selectedLinkedVariant?.role === "cosmetic" ? (
            <div className="authoring-fields">
              <label className="toggle">
                <input
                  type="checkbox"
                  checked={Boolean(selectedLinkedVariant.limitedSale)}
                  onChange={(event) => {
                    if (!event.target.checked) {
                      setSelectedVariantLimitedSale(undefined);
                      return;
                    }
                    const startsAt = new Date();
                    const endsAt = new Date(startsAt);
                    endsAt.setUTCDate(endsAt.getUTCDate() + 30);
                    setSelectedVariantLimitedSale({
                      priceGold: "5000",
                      startsAt: startsAt.toISOString(),
                      endsAt: endsAt.toISOString()
                    });
                  }}
                />
                <span>Limited personal-Gold sale</span>
              </label>
              {selectedLinkedVariant.limitedSale ? (
                <>
                  <TextField
                    label="Price (Gold)"
                    value={selectedLinkedVariant.limitedSale.priceGold}
                    onChange={(priceGold) => setSelectedVariantLimitedSale({
                      ...selectedLinkedVariant.limitedSale!,
                      priceGold: priceGold.replace(/\D/gu, "").slice(0, 19)
                    })}
                  />
                  <TextField
                    label="Sale starts (ISO 8601)"
                    value={selectedLinkedVariant.limitedSale.startsAt}
                    onChange={(startsAt) => setSelectedVariantLimitedSale({
                      ...selectedLinkedVariant.limitedSale!, startsAt
                    })}
                  />
                  <TextField
                    label="Sale ends (ISO 8601)"
                    value={selectedLinkedVariant.limitedSale.endsAt}
                    onChange={(endsAt) => setSelectedVariantLimitedSale({
                      ...selectedLinkedVariant.limitedSale!, endsAt
                    })}
                  />
                </>
              ) : null}
              <p className="category-help">
                Limited items keep their family mechanics. The game validates the price and active
                UTC sale window again when each purchase commits.
              </p>
            </div>
          ) : null}
          <label className="field">
            <span>Search</span>
            <input
              data-testid="appearance-search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="ID, name, or asset"
            />
          </label>
          <label className="toggle">
            <input
              type="checkbox"
              checked={showRetired}
              onChange={(event) => setShowRetired(event.target.checked)}
            />
            <span>Show removed appearances</span>
          </label>
          <div className="appearance-list" data-testid="appearance-list">
            {filteredAppearances.map((appearance) => (
              <button
                type="button"
                key={appearance.appearanceId}
                data-testid={`appearance-item-${appearance.appearanceId}`}
                className={appearance.appearanceId === history.selectedId ? "selected" : ""}
                onClick={() => {
                  dispatch({
                    type: "select",
                    appearanceId: appearance.appearanceId
                  });
                  selectionByContextRef.current[
                    selectionContextKey(selectedCategoryId, selectedFamily?.familyId)
                  ] = appearance.appearanceId;
                  const variant = itemVariants.variants.find((candidate) =>
                    candidate.appearanceId === appearance.appearanceId
                  );
                  const definitionId = variant?.definitionId ?? appearance.equipmentDefinitionId;
                  if (definitionId) setSelectedItemId(definitionId);
                  if (isPairedCategory) {
                    setSelectedPartId("right");
                  }
                }}
              >
                <span>{appearance.displayName}</span>
                <small>{appearanceAuthoringLayer(catalog, appearance.appearanceId)} · {
                  itemVariants.variants.some(
                    (variant) => variant.appearanceId === appearance.appearanceId
                  ) ? "item variant" : isStyleCategory ? "appearance variant" : "stock item"
                }{appearance.retired ? " · removed" : ""}</small>
              </button>
            ))}
            {filteredAppearances.length === 0 && (
              <p className="empty-copy">{selectedGearItemHasNoAppearance
                ? `No artwork exists yet for ${selectedGearItemDisplayName}. Drop or choose a PNG below to create its first appearance.`
                : "Drop a PNG below to create the first appearance."}</p>
            )}
          </div>
          <div className="library-actions">
            <button
              type="button"
              disabled={!selected}
              onClick={() => {
                if (!selected) return;
                const duplicate = duplicateAppearance(catalog, selected.appearanceId);
                dispatch({
                  type: "edit",
                  catalog: duplicate.catalog,
                  selectedId: duplicate.appearance.appearanceId
                });
              }}
            >Duplicate</button>
            <button
              type="button"
              disabled={!selected}
              onClick={() => {
                if (selected) {
                  setClipboard(structuredClone(
                    effectivePartId === "main"
                      ? selected.placements?.[selectedPose] ?? {}
                      : selected.parts?.find((part) => part.partId === effectivePartId)
                          ?.placements?.[selectedPose] ?? {}
                  ));
                }
              }}
            >Copy transform</button>
            <button
              type="button"
              disabled={!selected || !clipboard}
              onClick={() => {
                if (clipboard) {
                  editSelected((appearance) => editSelectedPlacement(
                    appearance,
                    structuredClone(clipboard)
                  ));
                }
              }}
            >Paste transform</button>
            {selectedIsDraftVariant && (
              <button
                type="button"
                className="danger"
                onClick={() => setPendingDeleteId(selected?.appearanceId ?? null)}
              >Delete Variant</button>
            )}
            {selectedCanRemoveAppearance && !selectedIsRetired && (
              <button
                type="button"
                className="danger"
                onClick={() => setPendingDeleteId(selected?.appearanceId ?? null)}
              >Remove Appearance</button>
            )}
            {selectedCanRemoveAppearance && selectedIsRetired && (
              <button type="button" onClick={() => setSelectedAppearanceRemoved(false)}>
                Restore Appearance
              </button>
            )}
          </div>
          {selected && pendingDeleteId === selected.appearanceId && (
            <div
              className="inline-confirmation"
              role="alertdialog"
              aria-label={`${selectedIsDraftVariant ? "Delete" : "Remove"} ${selected.displayName}?`}
            >
              <p>
                {selectedIsDraftVariant
                  ? `Stage deletion of ${selected.displayName}? Nothing is removed from the worktree until you save.`
                  : `Remove ${selected.displayName} from appearance menus? ${selectedLinkedVariant
                    ? "Existing owned items and PNGs stay valid."
                    : "Existing player selections and PNGs stay valid."}`}
              </p>
              <div className="inspector-actions">
                <button type="button" onClick={() => setPendingDeleteId(null)}>Cancel</button>
                <button
                  type="button"
                  className="danger"
                  onClick={() => selectedIsDraftVariant
                    ? deleteSelectedVariant()
                    : setSelectedAppearanceRemoved(true)}
                >
                  {selectedIsDraftVariant ? "Stage deletion" : "Stage removal"}
                </button>
              </div>
            </div>
          )}
          {isPairedCategory && (
            <>
              <p className="category-help">
                Upload one right-side PNG. Right is unmirrored; Left starts mirrored. Each side
                keeps its own placement transforms.
              </p>
              <div className="segmented part-tabs" aria-label={`${CATEGORY_LABELS[selectedCategoryId]} side`}>
              <button
                type="button"
                className={selectedPartId === "right" ? "active" : ""}
                onClick={() => setSelectedPartId("right")}
              >Right</button>
                <button
                  type="button"
                  className={selectedPartId === "left" ? "active" : ""}
                  onClick={() => setSelectedPartId("left")}
                >Left</button>
              </div>
            </>
          )}
          <div
            className={`drop-zone ${busy ? "busy" : ""}`}
            role="button"
            aria-disabled={playerLibraryMode === "overlays" && !selectedFamily}
            tabIndex={playerLibraryMode === "overlays" && !selectedFamily ? -1 : 0}
            aria-label={selectedGearItemHasNoAppearance
              ? `No artwork exists yet for ${selectedGearItemDisplayName}; dropping or choosing a PNG creates the first appearance`
              : authoringMode === "edit" && selected
              ? `${isPairedCategory ? "Replace both sides from right-side" : "Replace"} PNG for ${selected.displayName}`
              : `Choose ${isPairedCategory ? "one right-side " : ""}PNG for new ${CATEGORY_LABELS[selectedCategoryId]} variant`}
            onDragOver={(event) => {
              event.preventDefault();
              event.dataTransfer.dropEffect = "copy";
            }}
            onDrop={(event) => {
              event.preventDefault();
              if (playerLibraryMode === "overlays" && !selectedFamily) return;
              const file = event.dataTransfer.files[0];
              if (file) void importFile(file);
            }}
            onClick={() => {
              if (playerLibraryMode !== "overlays" || selectedFamily) openPngPicker();
            }}
            onKeyDown={(event) => {
              if (event.key !== "Enter" && event.key !== " ") return;
              event.preventDefault();
              if (playerLibraryMode === "overlays" && !selectedFamily) return;
              openPngPicker();
            }}
          >
            <strong>{busy ? "Working…" : selectedGearItemHasNoAppearance
              ? "Drop or choose the first transparent PNG"
              : isPairedCategory
              ? "Drop one transparent right-side PNG"
              : "Drop transparent PNG"}</strong>
            <span>{selectedGearItemHasNoAppearance
              ? `No artwork exists yet for ${selectedGearItemDisplayName}; this creates its first appearance`
              : authoringMode === "edit" && selected
              ? isPairedCategory
                ? `Replace both ${selected.displayName} sides; side transforms stay independent`
                : `Replace PNG for ${selected.displayName}; only this variant changes`
              : "Validated and staged until Save"}</span>
            <input
              ref={fileInputRef}
              hidden
              type="file"
              disabled={playerLibraryMode === "overlays" && !selectedFamily}
              accept="image/png,.png"
              onClick={(event) => event.stopPropagation()}
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void importFile(file);
                event.target.value = "";
              }}
            />
          </div>
          <label className="field">
            <span>Import target</span>
            <select
              value={importTarget}
              onChange={(event) => setImportTarget(event.target.value as ImportTarget)}
            >
              <option value="appearance">{CATEGORY_LABELS[selectedCategoryId]} appearance</option>
              <option value="base-body">Base Body / Player Base</option>
              <option value="skin-tone">Skin-tone variant</option>
              <option value="head">Head / Player Head</option>
              <option value="head-skin-tone">Head skin-tone variant</option>
            </select>
          </label>
          {(importTarget === "skin-tone" || importTarget === "head-skin-tone") && (
            <label className="field">
              <span>Skin-tone variant</span>
              <select
                aria-label="Skin-tone variant"
                value={selectedSkinToneId}
                onChange={(event) => setSelectedSkinToneId(
                  event.target.value as PlayerSkinToneId
                )}
              >
                {PLAYER_SKIN_TONE_IDS.map((skinToneId) => (
                  <option key={skinToneId} value={skinToneId}>
                    {PLAYER_SKIN_TONE_LABELS[skinToneId]}
                  </option>
                ))}
              </select>
            </label>
          )}
          {importTarget === "appearance" ? (
            <p className="category-help">
              Saves under {CATEGORY_LABELS[selectedCategoryId]}
              {selectedFamily ? ` / ${selectedFamily.displayName}` : ""}
              {isPairedCategory ? ` / editing ${selectedPartId}; upload source Right` : ""}.
            </p>
          ) : importTarget === "base-body" ? (
            <p className="category-help">
              Replaces the canonical Base Body / Player Base asset for {poseLabel(selectedPose)}.
              Shared transforms, rig anchors, and overlays stay unchanged.
            </p>
          ) : importTarget === "head" ? (
            <p className="category-help">
              Replaces the separate Head image for {poseLabel(selectedPose)}. It must share the
              Base Body canvas; it uses the Base Body transform and draws over chest armor, under
              face, mask, and hair layers.
            </p>
          ) : importTarget === "head-skin-tone" ? (
            <p className="category-help">
              Replaces only the {PLAYER_SKIN_TONE_LABELS[selectedSkinToneId]} Head image link.
              It uses the Base Body transform.
            </p>
          ) : (
            <p className="category-help">
              Replaces only the {PLAYER_SKIN_TONE_LABELS[selectedSkinToneId]} skin-tone link.
              The Base Body transform, rig, other tones, overlays, and equipment stay unchanged.
            </p>
          )}
        </aside>

        <section className="panel preview-panel" data-testid="appearance-preview">
          <div className="preview-toolbar" data-testid="appearance-preview-toolbar">
            <div className="segmented pose-tabs" aria-label="Combat pose">
              {PLAYER_COMBAT_POSE_IDS.map((poseId) => (
                <button
                  key={poseId}
                  type="button"
                  className={selectedPose === poseId ? "active" : ""}
                  onClick={() => setSelectedPose(poseId)}
                >
                  {poseLabel(poseId)}
                </button>
              ))}
            </div>
            <span
              className={`pose-lock-indicator ${poseHasOverride ? "unlocked" : "locked"}`}
              aria-label={selectedPose === "idle"
                ? "Idle is the source frame"
                : poseHasOverride
                  ? `${poseLabel(selectedPose)} has a local override`
                  : `${poseLabel(selectedPose)} follows Idle`}
              title={selectedPose === "idle"
                ? "Idle is the source frame for item placement"
                : poseHasOverride
                  ? "This pose has local changes. Reset it to follow Idle again."
                  : "This pose automatically follows Idle until you change it."}
            >
              <span aria-hidden="true">{poseHasOverride ? "🔓" : "🔒"}</span>
              {selectedPose === "idle"
                ? "Idle source"
                : poseHasOverride ? "Pose override" : "Follows Idle"}
            </span>
            <div className="segmented edit-tabs" aria-label="Preview edit target">
              {previewEditTargets.map((target) => (
                <button
                  key={target}
                  type="button"
                  className={previewEditTarget === target ? "active" : ""}
                  disabled={target === "overall" && !masterScaleSupported}
                  title={target === "overall" && !masterScaleSupported
                    ? `Requires game renderer contract ${MASTER_SCALE_CONTRACT_VERSION}. ` +
                      "Start a batch from a newer Integration Test generation."
                    : undefined}
                  onClick={() => {
                    if (target === "overall" && !masterScaleSupported) return;
                    setPreviewEditTarget(target);
                    if (target === "anchors") setShowAnchors(true);
                  }}
                >
                  {target === "anchors"
                    ? "Anchors"
                    : target === "main"
                      ? "MAIN"
                    : target === "projectile"
                      ? "Projectile"
                    : target === "projectile_impact"
                      ? "Impact Point"
                    : target === "projectile_tail"
                      ? "Tail Point"
                    : target === "overall"
                      ? "Master Scale"
                    : target === "gem"
                      ? "Gem"
                    : target === "feature_anchor"
                      ? "Feature Anchor"
                    : target === "feature_area"
                      ? "Feature Area"
                    : target === "pivot"
                      ? "Item Pivot"
                      : target === "template"
                        ? "Base Body"
                      : target[0]!.toUpperCase() + target.slice(1)}
                </button>
              ))}
            </div>
            <button type="button" onClick={() => setZoom((value) => Math.max(0.25, value - 0.25))}>−</button>
            <span className="zoom-readout">{Math.round(zoom * 100)}%</span>
            <button type="button" onClick={() => setZoom((value) => Math.min(8, value + 0.25))}>+</button>
            <Toggle label="Actual scale" checked={actualScale} onChange={setActualScale} />
            <Toggle
              label="Show guides"
              checked={showGuides}
              onChange={setShowGuides}
              title="Show or hide authoring markers, bounds, and preview badges without changing the player or overlays"
            />
            <Toggle label="Anchors" checked={showAnchors} onChange={setShowAnchors} />
            {selectedSupportsGem && equipmentEnhancementSupported && (
              <>
                <label className="preview-core-select">
                  <span>Gem preview</span>
                  <select
                    value={previewGemstone}
                    onChange={(event) => setPreviewGemstone(
                      event.target.value as EnchantmentStoneVariant
                    )}
                  >
                    {previewGemstones.map((gemstone) => (
                      <option key={gemstone} value={gemstone}>
                        {gemstone[0]!.toUpperCase() + gemstone.slice(1)}
                      </option>
                    ))}
                  </select>
                </label>
                <Toggle
                  label="Gem overlay"
                  checked={showGemPreview || previewEditTarget === "gem"}
                  disabled={previewEditTarget === "gem"}
                  onChange={setShowGemPreview}
                />
              </>
            )}
            {equipmentEnhancementSupported && selected &&
            appearanceCategory(catalog, selected.appearanceId) === "weapon" && (
              <label className="preview-core-select">
                <span>Core hue preview</span>
                <select
                  value={previewCoreId}
                  onChange={(event) => setPreviewCoreId(
                    event.target.value as EquipmentCoreId | ""
                  )}
                >
                  <option value="">None</option>
                  {EQUIPMENT_CORE_IDS.map((coreId) => (
                    <option key={coreId} value={coreId}>
                      {coreId === "venomsteel"
                        ? `${equipmentMetalDisplayName(coreId)} · ${equipmentEffectDisplayName("poison")}`
                        : equipmentMetalDisplayName(coreId)}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <button
              type="button"
              className={overlayAppearances.length > 0 ? "overlay-active" : ""}
              aria-expanded={showOverlayPicker}
              onClick={() => setShowOverlayPicker((value) => !value)}
            >Preview Overlays ({overlayAppearances.length})</button>
          </div>
          {showOverlayPicker && (
            <div className="overlay-picker" aria-label="Preview overlays">
              <div className="overlay-picker-heading">
                <strong>PREVIEW ONLY — overlays are never attached to the variant you save</strong>
                <span>Use unpublished variants from this worktree as positioning references.</span>
              </div>
              <div className="overlay-picker-add">
                <select
                  aria-label="Overlay appearance"
                  value={effectiveOverlayCandidateId}
                  disabled={availableOverlayAppearances.length === 0}
                  onChange={(event) => setOverlayCandidateId(
                    event.target.value as AppearanceDefinitionId
                  )}
                >
                  {availableOverlayAppearances.map((appearance) => (
                    <option key={appearance.appearanceId} value={appearance.appearanceId}>
                      {CATEGORY_LABELS[appearanceCategory(catalog, appearance.appearanceId)]}
                      {" — "}{appearance.displayName}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  disabled={!effectiveOverlayCandidateId}
                  onClick={() => {
                    const candidate = catalog.appearances.find((appearance) =>
                      appearance.appearanceId === effectiveOverlayCandidateId
                    );
                    if (!candidate) return;
                    const layerKey = previewLayerKey(catalog, candidate);
                    setOverlayAppearanceIds((appearanceIds) => [
                      ...appearanceIds.filter((appearanceId) => {
                        const appearance = catalog.appearances.find((entry) =>
                          entry.appearanceId === appearanceId
                        );
                        return appearance && previewLayerKey(catalog, appearance) !== layerKey;
                      }),
                      candidate.appearanceId
                    ]);
                    setOverlayCandidateId("");
                  }}
                >Add Overlay</button>
              </div>
              <div className="overlay-chips">
                {overlayAppearances.map((appearance) => (
                  <button
                    key={appearance.appearanceId}
                    type="button"
                    title={`Remove ${appearance.displayName} preview overlay`}
                    onClick={() => setOverlayAppearanceIds((appearanceIds) =>
                      appearanceIds.filter((appearanceId) =>
                        appearanceId !== appearance.appearanceId
                      )
                    )}
                  >{CATEGORY_LABELS[appearanceCategory(catalog, appearance.appearanceId)]}
                    {": "}{appearance.displayName} ×</button>
                ))}
                {overlayAppearances.length === 0 && <span>No preview overlays selected.</span>}
              </div>
            </div>
          )}
          <div className="preview-checker">
            {showGuides && overlayAppearances.length > 0 && (
              <div className="overlay-watermark" role="status">
                PREVIEW OVERLAY — NOT SAVED WITH {selected?.displayName ?? "CURRENT EDIT"}
              </div>
            )}
            <PreviewCanvas
              catalog={catalog}
              selected={previewSelected}
              selectedPartId={effectivePartId}
              revision={history.revision}
              zoom={zoom}
              actualScale={actualScale}
              showGuides={showGuides}
              showAnchors={showAnchors}
              overlayAppearanceIds={overlayAppearanceIds}
              enhancementPreview={enhancementPreview}
              showGemstonePreview={showGemstonePreview}
              skinToneId={selectedSkinToneId}
              poseId={selectedPose}
              editTarget={previewEditTarget}
              selectedAnchorId={selectedAnchorId}
              mainAnchorSupported={mainAnchorSupported}
              playerHitGeometry={playerHitGeometrySupported
                ? playerHitGeometryState?.value ?? null
                : null}
              playerHitAnchorX={playerHitGeometryState?.anchorX ?? 0.5}
              playerHitAnchorY={playerHitGeometryState?.anchorY ?? 1}
              projectileAimDegrees={projectileAimDegrees}
              showProjectileTarget={showProjectileTarget}
              onSelectAnchor={setSelectedAnchorId}
              onDrag={nudgePreview}
              onDragPivot={editPivot}
              onMoveProjectilePoint={moveProjectilePoint}
              onMoveGemSocket={editGemSocket}
              feature={previewFeature}
              onMoveFeatureAnchor={editFeatureAnchor}
              onEditFeatureArea={editFeatureArea}
              onMovePlayerHitCenter={(centerX, centerY) => {
                const current = playerHitGeometryState?.value;
                if (!current || assetBusy) return;
                assetStudioRef.current?.setPlayerHitGeometry({
                  ...current,
                  centerX,
                  centerY
                });
              }}
            />
          </div>
          <div className="preview-hint">
            {previewEditTarget === "anchors"
              ? "Drag a cyan anchor · arrows nudge selected anchor 1 px · Shift for 5 px"
              : previewEditTarget === "main"
                ? "MAIN is the single world/map interaction point · drag the player until the marker sits between the feet"
              : previewEditTarget === "pivot"
                ? "Drag the red item pivot onto its attachment point (for a sword, the hilt)"
                : previewEditTarget === "gem"
                  ? "Drag the diamond to its socket on the selected equipment PNG · middle-drag to pan"
                : previewEditTarget === "feature_anchor"
                  ? "Drag the PNG until the spot that should follow the player sits on the yellow cross"
                : previewEditTarget === "feature_area"
                  ? "Drag the red default point or a vertex · click empty space to add a vertex · middle-drag to pan"
                : previewEditTarget === "projectile_impact"
                  ? "Drag the red Impact Point onto the projectile tip that strikes the target"
                : previewEditTarget === "projectile_tail"
                  ? "Drag the cyan Tail Point to define the projectile's forward axis"
                : previewEditTarget === "projectile"
                  ? "Drag the projectile to adjust impact offset · arrows nudge 1 px · Shift for 5 px"
                : previewEditTarget === "overall"
                  ? "Master Scale enlarges the complete character around Main"
                : previewEditTarget === "template"
                  ? "Drag the Base Body to align the canonical player template with authored layers and anchors"
                : `Drag ${previewEditTarget} to position · arrows nudge 1 px · Shift for 5 px`}
          </div>
        </section>

        <aside className="panel inspector-panel" data-testid="appearance-inspector">
          <PanelTitle
            title="Inspector"
            meta={previewEditTarget === "item" || previewEditTarget === "pivot" ||
              previewEditTarget === "gem" || featureEditing
              ? selected?.appearanceId ?? "No selection"
              : projectilePreviewMode
                ? `${selected?.displayName ?? "No selection"} projectile`
              : previewEditTarget === "overall"
                ? "Complete character"
              : `${poseLabel(selectedPose)} ${previewEditTarget === "template"
                ? "Base Body"
                : previewEditTarget}`}
          />
          {previewEditTarget !== "item" && previewEditTarget !== "pivot" &&
          previewEditTarget !== "gem" ? (
            <>
              <div className="inspector-scroll">
                {featureEditing && selected && selectedFeatureArea ? (
                  previewEditTarget === "feature_anchor" ? (
                    <>
                      <Divider label="Feature Anchor" />
                      <p className="empty-copy">
                        This point of the PNG snaps to each player's chosen spot. Without an
                        anchor the item keeps its normal placement and cannot be moved in the Salon.
                      </p>
                      {selected.featureAnchor ? (
                        <>
                          <div className="field-grid">
                            <NumberField
                              label="Anchor X"
                              value={selected.featureAnchor.x}
                              step={0.01}
                              min={0}
                              max={1}
                              onChange={(x) => editFeatureAnchor(x, selected.featureAnchor!.y)}
                            />
                            <NumberField
                              label="Anchor Y"
                              value={selected.featureAnchor.y}
                              step={0.01}
                              min={0}
                              max={1}
                              onChange={(y) => editFeatureAnchor(selected.featureAnchor!.x, y)}
                            />
                          </div>
                          <button type="button" className="wide" onClick={clearFeatureAnchor}>
                            Remove anchor
                          </button>
                        </>
                      ) : (
                        <p className="empty-copy">Drag in the preview to set the anchor.</p>
                      )}
                    </>
                  ) : (
                    <>
                      <Divider label={`${CATEGORY_LABELS[selectedFaceFeature!]} Area`} />
                      <p className="empty-copy">
                        One area for every {CATEGORY_LABELS[selectedFaceFeature!].toLowerCase()} PNG.
                        Players can move the feature anywhere inside it; the red point is where it starts.
                      </p>
                      <div className="field-grid">
                        <NumberField
                          label="Default X"
                          value={selectedFeatureArea.defaultPoint.x}
                          step={0.1}
                          onChange={(x) => editFeatureArea({
                            ...selectedFeatureArea,
                            defaultPoint: { ...selectedFeatureArea.defaultPoint, x }
                          })}
                        />
                        <NumberField
                          label="Default Y"
                          value={selectedFeatureArea.defaultPoint.y}
                          step={0.1}
                          onChange={(y) => editFeatureArea({
                            ...selectedFeatureArea,
                            defaultPoint: { ...selectedFeatureArea.defaultPoint, y }
                          })}
                        />
                      </div>
                      <p className="empty-copy">
                        {selectedFeatureArea.polygon.length} vertices
                        {selectedFeatureVertex !== null &&
                          selectedFeatureVertex < selectedFeatureArea.polygon.length
                          ? ` · vertex ${selectedFeatureVertex + 1} selected`
                          : ""}
                      </p>
                      <button
                        type="button"
                        className="wide"
                        disabled={selectedFeatureVertex === null ||
                          selectedFeatureVertex >= selectedFeatureArea.polygon.length ||
                          selectedFeatureArea.polygon.length <= 3}
                        onClick={() => {
                          if (selectedFeatureVertex === null) return;
                          editFeatureArea({
                            ...selectedFeatureArea,
                            polygon: selectedFeatureArea.polygon.filter((_, index) =>
                              index !== selectedFeatureVertex)
                          }, null);
                        }}
                      >Delete selected vertex</button>
                    </>
                  )
                ) : projectilePreviewMode && selectedProjectileTransform ? (
                  <>
                    <p className="empty-copy">
                      {previewEditTarget === "projectile_impact" ||
                      previewEditTarget === "projectile_tail"
                        ? "Point placement locks the PNG in place. Drag the red point to the tip and the cyan point to the back, then use Projectile to preview the final aim."
                        : "The red Impact Point stays on the struck target. The cyan Tail Point defines which way this PNG points before the game aims it."}
                    </p>
                    <Divider label="Projectile preview" />
                    <Toggle
                      label="Target character overlay"
                      checked={showProjectileTarget}
                      onChange={setShowProjectileTarget}
                    />
                    <NumberField
                      label="Preview direction°"
                      value={projectileAimDegrees}
                      step={15}
                      min={-180}
                      max={180}
                      onChange={(value) => setProjectileAimDegrees(clamp(value, -180, 180))}
                    />
                    <div className="library-actions projectile-direction-actions">
                      {([
                        ["From left", 0],
                        ["Diagonal", 45],
                        ["From above", 90],
                        ["From right", 180]
                      ] as const).map(([label, degrees]) => (
                        <button
                          key={label}
                          type="button"
                          onClick={() => setProjectileAimDegrees(degrees)}
                        >{label}</button>
                      ))}
                    </div>
                    <Divider label="Transform" />
                    <div className="field-grid">
                      <NumberField label="Offset X" value={selectedProjectileTransform.offsetX} step={1} onChange={(offsetX) => editProjectileTransform({ offsetX })} />
                      <NumberField label="Offset Y" value={selectedProjectileTransform.offsetY} step={1} onChange={(offsetY) => editProjectileTransform({ offsetY })} />
                      <NumberField label="Rotation°" value={selectedProjectileTransform.rotationDegrees} step={0.5} onChange={(rotationDegrees) => editProjectileTransform({ rotationDegrees })} />
                      <NumberField label="Scale X" value={selectedProjectileTransform.scaleX} step={0.01} onChange={(scaleX) => editProjectileTransform({ scaleX: nonZeroScale(scaleX) })} />
                      <NumberField label="Scale Y" value={selectedProjectileTransform.scaleY} step={0.01} onChange={(scaleY) => editProjectileTransform({ scaleY: nonZeroScale(scaleY) })} />
                    </div>
                    <Divider label="Aim points" />
                    <div className="field-grid">
                      <NumberField label="Impact X" value={selectedProjectileTransform.impactX} step={0.01} min={0} max={1} onChange={(impactX) => moveProjectilePoint("impact", clamp(impactX, 0, 1), selectedProjectileTransform.impactY)} />
                      <NumberField label="Impact Y" value={selectedProjectileTransform.impactY} step={0.01} min={0} max={1} onChange={(impactY) => moveProjectilePoint("impact", selectedProjectileTransform.impactX, clamp(impactY, 0, 1))} />
                      <NumberField label="Tail X" value={selectedProjectileTransform.tailX} step={0.01} min={0} max={1} onChange={(tailX) => moveProjectilePoint("tail", clamp(tailX, 0, 1), selectedProjectileTransform.tailY)} />
                      <NumberField label="Tail Y" value={selectedProjectileTransform.tailY} step={0.01} min={0} max={1} onChange={(tailY) => moveProjectilePoint("tail", selectedProjectileTransform.tailX, clamp(tailY, 0, 1))} />
                    </div>
                    <div className="library-actions">
                      <button type="button" onClick={() => editProjectileTransform({ scaleX: -selectedProjectileTransform.scaleX })}>Flip horizontal</button>
                      <button type="button" onClick={() => editProjectileTransform({ scaleY: -selectedProjectileTransform.scaleY })}>Flip vertical</button>
                    </div>
                  </>
                ) : previewEditTarget === "overall" ? (
                  <>
                    <p className="empty-copy">
                      Scales the Base Body, anchors, equipment, and every item together without
                      changing their saved individual transforms.
                    </p>
                    <Divider label="Complete character" />
                    <NumberField
                      label="Master scale"
                      value={overallScale}
                      step={0.05}
                      min={0.05}
                      max={20}
                      onChange={(scale) => editOverallScale(clamp(scale, 0.05, 20))}
                    />
                  </>
                ) : previewEditTarget === "template" ? (
                  selectedTemplateTransform && (
                    <>
                      <p className="empty-copy">
                        Align the canonical Base Body with the authored layers and attachment
                        anchors. Main separately controls map ground contact.
                      </p>
                      <Divider label={`${poseLabel(selectedPose)} ${previewEditTarget}`} />
                      <div className="field-grid">
                        <NumberField
                          label="Offset X"
                          value={selectedTemplateTransform.offsetX}
                          step={1}
                          onChange={(offsetX) => editTemplateTransform({
                            ...selectedTemplateTransform,
                            offsetX
                          })}
                        />
                        <NumberField
                          label="Offset Y"
                          value={selectedTemplateTransform.offsetY}
                          step={1}
                          onChange={(offsetY) => editTemplateTransform({
                            ...selectedTemplateTransform,
                            offsetY
                          })}
                        />
                      </div>
                      <NumberField
                        label="Uniform scale"
                        value={selectedTemplateTransform.scale}
                        step={0.05}
                        min={0.05}
                        max={20}
                        onChange={(scale) => editTemplateTransform({
                          ...selectedTemplateTransform,
                          scale: clamp(scale, 0.05, 20)
                        })}
                      />
                    </>
                  )
                ) : previewEditTarget === "main" ? (
                  <>
                    <p className="empty-copy">
                      MAIN is the single player world/map interaction point. Drag the whole
                      character beneath the fixed marker until it sits between the feet.
                    </p>
                    <Divider label="PLAYER MAIN" />
                    <div className="field-grid">
                      <NumberField
                        label="Main X"
                        value={selectedMainAnchor.x}
                        step={1}
                        acceptIntermediateSign
                        onChange={(x) => editMainAnchor(x, selectedMainAnchor.y)}
                      />
                      <NumberField
                        label="Main Y"
                        value={selectedMainAnchor.y}
                        step={1}
                        acceptIntermediateSign
                        onChange={(y) => editMainAnchor(selectedMainAnchor.x, y)}
                      />
                    </div>
                    {playerHitGeometrySupported && playerHitGeometryState ? (
                      <>
                        <Divider label="PLAYER TOUCH BOX" />
                        <p className="empty-copy">
                          Gold marks the gameplay click/touch area. Drag its diamond handle to
                          move the normalized hit center without moving MAIN.
                        </p>
                        <div className="field-grid">
                          <HitGeometryFields
                            value={playerHitGeometryState.value}
                            disabled={busy || assetBusy || !session?.workspace.writesAllowed}
                            centerMin={0}
                            centerMax={1}
                            onChange={(value) => assetStudioRef.current
                              ?.setPlayerHitGeometry({
                                ...value,
                                centerX: clamp(value.centerX, 0, 1),
                                centerY: clamp(value.centerY, 0, 1)
                              })}
                          />
                        </div>
                      </>
                    ) : null}
                  </>
                ) : (
                  <>
                    <p className="empty-copy">
                      Drag any cyan attachment anchor in the preview. The selected anchor is
                      yellow and can also be positioned numerically.
                    </p>
                    <label className="field">
                      <span>Selected anchor</span>
                      <select
                        value={selectedAnchorId}
                        onChange={(event) => setSelectedAnchorId(
                          event.target.value as PlayerAttachmentAnchorId
                        )}
                      >
                        {PLAYER_ATTACHMENT_ANCHOR_IDS.map((anchorId) => (
                          <option key={anchorId} value={anchorId}>{anchorLabel(anchorId)}</option>
                        ))}
                      </select>
                    </label>
                    <div className="field-grid">
                      <NumberField
                        label="Anchor X"
                        value={selectedAnchorPoint.x}
                        step={1}
                        acceptIntermediateSign
                        onChange={(x) => editAnchor(
                          selectedAnchorId,
                          x,
                          selectedAnchorPoint.y
                        )}
                      />
                      <NumberField
                        label="Anchor Y"
                        value={selectedAnchorPoint.y}
                        step={1}
                        acceptIntermediateSign
                        onChange={(y) => editAnchor(
                          selectedAnchorId,
                          selectedAnchorPoint.x,
                          y
                        )}
                      />
                    </div>
                    {selectedOppositeAnchorId ? (
                      <button
                        type="button"
                        onClick={() => {
                          const source = playerBodyPose(
                            catalog,
                            "default",
                            selectedPose
                          ).anchors[selectedOppositeAnchorId];
                          editAnchor(selectedAnchorId, -source.x, source.y);
                        }}
                      >Mirror from {anchorLabel(selectedOppositeAnchorId)}</button>
                    ) : null}
                  </>
                )}
              </div>
              <div className="inspector-footer">
                <button
                  type="button"
                  onClick={() => {
                    if (projectilePreviewMode) {
                      editProjectileTransform({ ...DEFAULT_PROJECTILE_TRANSFORM });
                      return;
                    }
                    if (previewEditTarget === "overall") {
                      editOverallScale(1);
                      return;
                    }
                    if (previewEditTarget === "template") {
                      editTemplateTransform({
                        offsetX: 0,
                        offsetY: 0,
                        scale: 1
                      });
                      return;
                    }
                    if (previewEditTarget === "main") {
                      dispatch({
                        type: "edit",
                        catalog: resetPlayerMainAnchor(catalog)
                      });
                      return;
                    }
                    const fallback = playerBodyPose(
                      DEFAULT_PLAYER_APPEARANCE_CATALOG,
                      "default",
                      selectedPose
                    );
                    const anchor = fallback.anchors[selectedAnchorId];
                    editAnchor(selectedAnchorId, anchor.x, anchor.y);
                  }}
                >Reset Current {
                  projectilePreviewMode ? "Projectile" :
                    previewEditTarget === "anchors" ? "Anchor" :
                    previewEditTarget === "main" ? "Main" :
                    previewEditTarget === "overall" ? "Master Scale" : "Layer"
                }</button>
              </div>
            </>
          ) : !selected || !resolvedPlacement ? (
            <p className="empty-copy">Import or select an appearance to edit its placement.</p>
          ) : (
            <>
              <div className="inspector-scroll">
                <TextField
                  label="Appearance ID"
                  value={selected.appearanceId}
                  onChange={(value) => editSelected((appearance) => ({
                    ...appearance,
                    appearanceId: value as AppearanceDefinitionId
                  }))}
                />
                <TextField
                  label="Display name"
                  value={selected.displayName}
                  onChange={(value) => editSelected((appearance) => ({
                    ...appearance,
                    displayName: value
                  }))}
                />
                <TextField
                  label={effectivePartId === "main" ? "Asset key" : `${effectivePartId} asset key`}
                  value={effectivePartId === "main"
                    ? selected.assetKey ?? ""
                    : selectedPart?.assetKey ?? "Not imported yet"}
                  readOnly
                />
                <button
                  type="button"
                  className="wide"
                  onClick={openPngPicker}
                >{isPairedCategory ? "Replace Both Sides from Right-side PNG" : "Replace Current PNG"}</button>
                <p className="category-help">
                  {CATEGORY_LABELS[appearanceCategory(catalog, selected.appearanceId)]}
                  {effectivePartId === "main" ? "" : ` / ${effectivePartId}`}
                </p>
                {previewEditTarget === "gem" && selectedGemSocket && (
                  <>
                    <Divider label="Gem Socket" />
                    <p className="empty-copy">
                      The selected gem is preview-only. The equipped gemstone supplies the final art.
                    </p>
                    {appearanceAssetParts(selected).length > 1 && (
                      <label className="field">
                        <span>Gem target part</span>
                        <select
                          value={selectedGemSocket.partId}
                          onChange={(event) => editSelected((appearance) => ({
                            ...appearance,
                            gemSocket: {
                              ...selectedGemSocket,
                              partId: event.target.value as AppearancePartId
                            }
                          }))}
                        >
                          {appearanceAssetParts(selected).map((part) => (
                            <option key={part.partId} value={part.partId}>{part.partId}</option>
                          ))}
                        </select>
                      </label>
                    )}
                    <div className="field-grid">
                      <NumberField
                        label="Socket X"
                        value={selectedGemSocket.x}
                        step={0.01}
                        min={0}
                        max={1}
                        onChange={(x) => editGemSocket(x, selectedGemSocket.y)}
                      />
                      <NumberField
                        label="Socket Y"
                        value={selectedGemSocket.y}
                        step={0.01}
                        min={0}
                        max={1}
                        onChange={(y) => editGemSocket(selectedGemSocket.x, y)}
                      />
                    </div>
                    <NumberField
                      label="Universal gem size (player px)"
                      value={catalog.enhancementPresentation.gemSizePx}
                      step={0.25}
                      min={0.25}
                      max={32}
                      onChange={(gemSizePx) => editEnhancementPresentation({
                        gemSizePx: clamp(gemSizePx, 0.25, 32)
                      })}
                    />
                    <button
                      type="button"
                      className="wide"
                      onClick={() => editSelected((appearance) => {
                        const next = { ...appearance };
                        delete next.gemSocket;
                        return next;
                      })}
                    >Reset Gem to {appearanceCategory(catalog, selected.appearanceId) === "weapon"
                        ? "Item Pivot" : "PNG Center"}</button>
                  </>
                )}
                <label className="field">
                  <span>Appearance family (advanced)</span>
                  <select
                    value={selected.familyId}
                    onChange={(event) => editSelected((appearance) => ({
                      ...appearance,
                      familyId: event.target.value
                    }))}
                  >
                    {inspectorFamilies.map((family) => (
                      <option key={family.familyId} value={family.familyId}>
                        {family.displayName}
                      </option>
                    ))}
                  </select>
                </label>
                {playerLibraryMode === "gear" && selectedAppearanceFamily && (
                  <label className="field">
                    <span>Player overlay</span>
                    <select
                      aria-label="Player overlay"
                      value={playerOverlaySlotForFamily(selectedAppearanceFamily) ?? ""}
                      disabled={selectedAppearanceFamily.categoryId === "weapon" ||
                        selectedAppearanceFamily.categoryId === "shield"}
                      onChange={(event) => dispatch({
                        type: "edit",
                        catalog: setFamilyPlayerOverlaySlot(
                          catalog,
                          selectedAppearanceFamily.familyId,
                          event.target.value
                            ? event.target.value as PlayerOverlaySlotId
                            : null
                        )
                      })}
                    >
                      {selectedAppearanceFamily.categoryId === "weapon" && (
                        <option value="">None</option>
                      )}
                      {PLAYER_OVERLAY_SLOT_IDS.map((overlaySlot) => (
                        <option key={overlaySlot} value={overlaySlot}>
                          {OVERLAY_SLOT_LABELS[overlaySlot]}
                        </option>
                      ))}
                    </select>
                    <small className="category-help">
                      {selectedAppearanceFamily.categoryId === "weapon"
                        ? "Weapons use hand anchors and do not occupy a body overlay."
                        : selectedAppearanceFamily.categoryId === "shield"
                          ? "Shields always use the Shield overlay."
                          : "Visual authoring only; equipment slots and stats are unchanged."}
                    </small>
                  </label>
                )}
                {isStyleCategory ? (
                  <p className="category-help">Avatar style — independent of equipment.</p>
                ) : (
                  <>
                    <label className="field">
                      <span>Base equipment</span>
                      <select
                        value={selected.equipmentDefinitionId ?? ""}
                        onChange={(event) => editSelected((appearance) => {
                          const next = { ...appearance };
                          if (event.target.value) {
                            next.equipmentDefinitionId =
                              event.target.value as EquipmentDefinitionId;
                          } else {
                            delete next.equipmentDefinitionId;
                          }
                          return next;
                        })}
                      >
                        <option value="">Family compatibility</option>
                        {equipmentEntries.map((definition) => (
                          <option key={definition.definitionId} value={definition.definitionId}>
                            {definition.displayName}
                          </option>
                        ))}
                      </select>
                    </label>
                    <Toggle
                      label="Cosmetic appearance"
                      checked={selected.cosmetic}
                      onChange={(cosmetic) => editSelected((appearance) => ({
                        ...appearance,
                        cosmetic
                      }))}
                    />
                    {appearanceCategory(catalog, selected.appearanceId) === "weapon" && (
                      <>
                        <Divider label="Projectile" />
                        <Toggle
                          label="Ranged visual (projectile on hit)"
                          checked={Boolean(selected.projectileAssetKey) ||
                            projectileDraftAppearanceId === selected.appearanceId}
                          onChange={(enabled) => {
                            if (enabled) {
                              setProjectileDraftAppearanceId(selected.appearanceId);
                              return;
                            }
                            setProjectileDraftAppearanceId(null);
                            editSelected((appearance) => {
                              const next = { ...appearance };
                              delete next.projectileAssetKey;
                              delete next.projectileTransform;
                              return next;
                            });
                          }}
                          disabled={!projectileAuthoringSupported}
                          {...(projectileAuthoringSupported ? {} : {
                            title: `Requires game renderer contract ${PROJECTILE_AUTHORING_CONTRACT_VERSION}. Start a batch from a newer Integration Test generation.`
                          })}
                        />
                        <p className="category-help">
                          Visual only. Combat range, damage, and targeting do not change.
                        </p>
                        {(selected.projectileAssetKey ||
                          projectileDraftAppearanceId === selected.appearanceId) && (
                          <div
                            className={`drop-zone projectile-drop-zone ${busy ? "busy" : ""}`}
                            role="button"
                            tabIndex={0}
                            aria-label={`${selected.projectileAssetKey ? "Replace" : "Add"} projectile PNG for ${selected.displayName}`}
                            onDragOver={(event) => {
                              event.preventDefault();
                              event.dataTransfer.dropEffect = "copy";
                            }}
                            onDrop={(event) => {
                              event.preventDefault();
                              const file = event.dataTransfer.files[0];
                              if (file) void importProjectile(file);
                            }}
                            onClick={openProjectilePicker}
                            onKeyDown={(event) => {
                              if (event.key !== "Enter" && event.key !== " ") return;
                              event.preventDefault();
                              openProjectilePicker();
                            }}
                          >
                            {selected.projectileAssetKey && (
                              <img
                                src={`/appearance-assets/${selected.projectileAssetKey}`}
                                alt=""
                              />
                            )}
                            <strong>{busy
                              ? "Working…"
                              : selected.projectileAssetKey
                                ? "Replace projectile PNG"
                                : "Drop projectile PNG"}</strong>
                            <span>{selected.projectileAssetKey ??
                              "Set its Impact and Tail points after import; the game aims that axis."}</span>
                            <input
                              ref={projectileFileInputRef}
                              hidden
                              type="file"
                              accept="image/png,.png"
                              onClick={(event) => event.stopPropagation()}
                              onChange={(event) => {
                                const file = event.target.files?.[0];
                                if (file) void importProjectile(file);
                                event.target.value = "";
                              }}
                            />
                          </div>
                        )}
                      </>
                    )}
                  </>
                )}
                <label className="field">
                  <span>Inherit placement</span>
                  <select
                    value={selected.inheritAppearanceId ?? ""}
                    onChange={(event) => editSelected((appearance) => {
                      const inheritAppearanceId = event.target.value as AppearanceDefinitionId;
                      const next = { ...appearance };
                      if (inheritAppearanceId) next.inheritAppearanceId = inheritAppearanceId;
                      else delete next.inheritAppearanceId;
                      return next;
                    })}
                  >
                    <option value="">Family default</option>
                    {catalog.appearances
                      .filter((appearance) => appearance.appearanceId !== selected.appearanceId)
                      .map((appearance) => (
                        <option key={appearance.appearanceId} value={appearance.appearanceId}>
                          {appearance.displayName}
                        </option>
                      ))}
                  </select>
                </label>

                {previewEditTarget === "pivot" && (
                  <p className="empty-copy">
                    Drag the red pivot dot onto the point that should meet the body anchor. The
                    item stays visually in place while its pivot changes.
                  </p>
                )}
                <Divider label="Attachment" />
                <label className="field">
                  <span>Anchor</span>
                  <select
                    value={resolvedPlacement.anchorId}
                    onChange={(event) => editPlacement(
                      "anchorId",
                      event.target.value as AppearancePlacement["anchorId"]
                    )}
                  >
                    {PLAYER_ATTACHMENT_ANCHOR_IDS.map((anchor) => (
                      <option key={anchor} value={anchor}>{anchorLabel(anchor)}</option>
                    ))}
                  </select>
                </label>
                <button
                  type="button"
                  className="wide"
                  onClick={() => editSelected((appearance) => editSelectedPlacement(
                    appearance,
                    {
                      anchorId: resolvedPlacement.anchorId,
                      offsetX: 0,
                      offsetY: 0
                    }
                  ))}
                >Snap to selected anchor</button>
                <div className="field-grid">
                  <NumberField label="Offset X" value={resolvedPlacement.offsetX} step={1} onChange={(value) => editPlacement("offsetX", value)} />
                  <NumberField label="Offset Y" value={resolvedPlacement.offsetY} step={1} onChange={(value) => editPlacement("offsetY", value)} />
                  <NumberField label="Rotation°" value={resolvedPlacement.rotationDegrees} step={0.5} onChange={(value) => editPlacement("rotationDegrees", value)} />
                  <NumberField label="Scale X" value={resolvedPlacement.scaleX} step={0.01} onChange={(value) => editPlacement("scaleX", nonZeroScale(value))} />
                  <NumberField label="Scale Y" value={resolvedPlacement.scaleY} step={0.01} onChange={(value) => editPlacement("scaleY", nonZeroScale(value))} />
                  <NumberField label="Pivot X" value={resolvedPlacement.pivotX} step={0.01} min={0} max={1} onChange={(value) => editPlacement("pivotX", clamp(value, 0, 1))} />
                  <NumberField label="Pivot Y" value={resolvedPlacement.pivotY} step={0.01} min={0} max={1} onChange={(value) => editPlacement("pivotY", clamp(value, 0, 1))} />
                </div>
                <div className="library-actions">
                  <button type="button" onClick={() => editPlacement("scaleX", -resolvedPlacement.scaleX)}>Flip horizontal</button>
                  <button type="button" onClick={() => editPlacement("scaleY", -resolvedPlacement.scaleY)}>Flip vertical</button>
                </div>
                {!isPairedCategory && (
                  <button
                    type="button"
                    className="wide"
                    onClick={() => dispatch({
                      type: "edit",
                      catalog: saveFamilyPosePreset(
                        catalog,
                        selected.familyId,
                        selectedPose,
                        resolvedPlacement
                      )
                    })}
                  >Save Current Transform as Default Preset</button>
                )}
                <TextField label="Fixed render layer" value={resolvedPlacement.layer} readOnly />
                <Toggle
                  label="Visible"
                  checked={resolvedPlacement.visible}
                  onChange={(visible) => editPlacement("visible", visible)}
                />
              </div>
              <div className="inspector-footer">
                <button
                  type="button"
                  disabled={selectedPose !== "idle" && !poseHasOverride}
                  onClick={() => {
                    if (!selected) return;
                    if (effectivePartId !== "main") {
                      if (!selected.parts) return;
                      editSelected((appearance) => ({
                        ...appearance,
                        parts: appearance.parts!.map((part) => {
                          if (part.partId !== effectivePartId) return part;
                          const placements = { ...part.placements };
                          delete placements[selectedPose];
                          return { ...part, placements };
                        })
                      }));
                      return;
                    }
                    dispatch({
                      type: "edit",
                      catalog: resetAppearancePose(
                        catalog,
                        selected.appearanceId,
                        selectedPose
                      )
                    });
                  }}
                >{selectedPose === "idle"
                    ? "Reset Idle to Family Default"
                    : `Reset ${poseLabel(selectedPose)} to Idle`}</button>
              </div>
            </>
          )}
        </aside>
      </section>
      ) : studioDomain === "hues" ? (
      <section className="panel core-hue-panel" aria-label="Core hue authoring">
        <PanelTitle title="Universal Core Hues" meta={`${EQUIPMENT_CORE_IDS.length} core`} />
        <p className="connection-copy">
          Each color is applied to every weapon using that core. Gemstone artwork keeps its
          original color.
        </p>
        <div className="core-hue-list">
          {EQUIPMENT_CORE_IDS.map((coreId) => {
            const hue = catalog.enhancementPresentation.coreHues[coreId];
            return <label className="core-hue-row" key={coreId}>
              <span>
                <strong>{equipmentMetalDisplayName(coreId)}</strong>
                <small>{coreId === "venomsteel" ? equipmentEffectDisplayName("poison") : "Core weapon color"}</small>
              </span>
              <input
                type="color"
                aria-label={`${coreId} hue`}
                value={hue}
                onChange={(event) => editEnhancementPresentation({
                  coreHues: {
                    ...catalog.enhancementPresentation.coreHues,
                    [coreId]: event.target.value
                  }
                })}
              />
              <code>{hue}</code>
            </label>;
          })}
        </div>
      </section>
      ) : (
      <section className="studio-grid boss-studio-grid" aria-label="Boss appearance authoring">
        <aside className="panel library-panel boss-library-panel" data-testid="boss-library">
          <PanelTitle
            title="Designated bosses"
            meta={`${bossCatalog.bosses.length} official boss${
              bossCatalog.bosses.length === 1 ? "" : "es"
            }`}
          />
          <p className="category-help">
            Only official boss archetypes appear here. Player appearances remain in the Player
            section.
          </p>
          <div className="appearance-list boss-list" data-testid="boss-list">
            {bossCatalog.bosses.map((boss) => (
              <button
                type="button"
                key={boss.bossId}
                data-testid={`boss-item-${boss.bossId}`}
                className={boss.bossId === selectedBoss?.bossId ? "selected" : ""}
                onClick={() => setSelectedBossId(boss.bossId)}
              >
                <span>{boss.displayName}</span>
                <small>OFFICIAL BOSS - {boss.archetypeKey}</small>
              </button>
            ))}
          </div>
          {selectedBoss && (
            <>
              <Divider label="Weapon slot" />
              <div className="boss-slot-card">
                <strong>{selectedBoss.weapon.assetKey ? "Weapon assigned" : "Weapon slot empty"}</strong>
                <span>{selectedBoss.weapon.assetKey ?? "Drop a transparent PNG to add one."}</span>
              </div>
              <div
                className={`drop-zone ${busy ? "busy" : ""}`}
                role="button"
                tabIndex={0}
                aria-label={`${selectedBoss.weapon.assetKey ? "Replace" : "Add"} weapon for ${
                  selectedBoss.displayName
                }`}
                onDragOver={(event) => {
                  event.preventDefault();
                  event.dataTransfer.dropEffect = "copy";
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  const file = event.dataTransfer.files[0];
                  if (file) void importBossWeapon(file);
                }}
                onClick={openBossWeaponPicker}
                onKeyDown={(event) => {
                  if (event.key !== "Enter" && event.key !== " ") return;
                  event.preventDefault();
                  openBossWeaponPicker();
                }}
              >
                <strong>{busy ? "Working..." : "Drop boss weapon PNG"}</strong>
                <span>{selectedBoss.weapon.assetKey
                  ? "Replaces only this boss weapon"
                  : "Adds the pose-driven weapon layer"}</span>
                <input
                  ref={bossFileInputRef}
                  hidden
                  type="file"
                  accept="image/png,.png"
                  onClick={(event) => event.stopPropagation()}
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) void importBossWeapon(file);
                    event.target.value = "";
                  }}
                />
              </div>
              {selectedBoss.weapon.assetKey && (
                <button
                  type="button"
                  className="quiet wide"
                  onClick={() => editSelectedBoss((boss) => ({
                    ...boss,
                    weapon: { ...boss.weapon, assetKey: null }
                  }))}
                >Clear Weapon Slot</button>
              )}
            </>
          )}
        </aside>

        <section className="panel preview-panel">
          <div className="preview-toolbar">
            <div className="segmented pose-tabs" aria-label="Boss combat pose">
              {PLAYER_COMBAT_POSE_IDS.map((poseId) => (
                <button
                  key={poseId}
                  type="button"
                  className={selectedPose === poseId ? "active" : ""}
                  onClick={() => setSelectedPose(poseId)}
                >{poseLabel(poseId)}</button>
              ))}
            </div>
            <span
              className={`pose-lock-indicator ${bossPoseHasOverride ? "unlocked" : "locked"}`}
              aria-label={selectedPose === "idle"
                ? "Idle is the boss weapon source frame"
                : bossPoseHasOverride
                  ? `${poseLabel(selectedPose)} has a boss weapon override`
                  : `${poseLabel(selectedPose)} follows the boss weapon Idle frame`}
            >
              {selectedPose === "idle"
                ? "Idle source"
                : bossPoseHasOverride ? "Pose override" : "Follows Idle"}
            </span>
            <span className="boss-context-badge">
              {bossPreviewEditTarget === "overall" ? "BOSS MASTER SIZE" : "BOSS WEAPON"}
            </span>
            <div className="segmented edit-tabs" aria-label="Boss preview edit target">
              {(["weapon", "pivot", "overall"] as const).map((target) => (
                <button
                  key={target}
                  type="button"
                  className={bossPreviewEditTarget === target ? "active" : ""}
                  disabled={target === "overall" && !bossMasterScaleSupported}
                  title={target === "overall" && !bossMasterScaleSupported
                    ? `Requires boss renderer contract ${BOSS_MASTER_SCALE_CONTRACT_VERSION}. ` +
                      "Start a batch from a newer Integration Test generation."
                    : undefined}
                  onClick={() => {
                    if (target === "overall" && !bossMasterScaleSupported) return;
                    setBossPreviewEditTarget(target);
                  }}
                >{target === "weapon"
                    ? "Weapon"
                    : target === "pivot" ? "Weapon Pivot" : "Master Size"}</button>
              ))}
            </div>
            <button type="button" onClick={() => setZoom((value) => Math.max(0.25, value - 0.25))}>-</button>
            <span className="zoom-readout">{Math.round(zoom * 100)}%</span>
            <button type="button" onClick={() => setZoom((value) => Math.min(8, value + 0.25))}>+</button>
            <Toggle label="Actual scale" checked={actualScale} onChange={setActualScale} />
          </div>
          <div className="preview-checker boss-preview-checker">
            {selectedBoss ? (
              <BossPreviewCanvas
                catalog={bossCatalog}
                bossId={selectedBoss.bossId}
                poseId={selectedPose}
                revision={bossHistory.revision}
                zoom={zoom}
                actualScale={actualScale}
                editTarget={bossPreviewEditTarget}
                onDrag={nudgeBossWeapon}
                onDragPivot={editBossWeaponPivot}
              />
            ) : (
              <p className="empty-copy">No designated boss is available.</p>
            )}
            {selectedBoss && !selectedBoss.weapon.assetKey && (
              <div className="boss-empty-weapon" role="status">
                <strong>Weapon slot ready</strong>
                <span>Drop a transparent weapon PNG in the Boss library.</span>
              </div>
            )}
          </div>
          <div className="preview-hint">
            {bossPreviewEditTarget === "pivot" && selectedBoss?.weapon.assetKey
              ? "Drag the red weapon pivot onto the rotation point (for a sword, the hilt)"
              : bossPreviewEditTarget === "overall"
                ? "Master Size scales this boss body and weapon together around the gray origin"
              : selectedBoss?.weapon.assetKey
                ? "Drag the boss weapon to position - arrows nudge 1 px - Shift for 5 px"
              : "The boss body is fixed; add one weapon PNG, then author Idle, Ready, and Action."}
          </div>
        </section>

        <aside className="panel inspector-panel boss-inspector-panel" data-testid="boss-inspector">
          <PanelTitle
            title="Boss Inspector"
            meta={selectedBoss
              ? bossPreviewEditTarget === "overall" ? "Complete boss" : selectedBoss.bossId
              : "No boss"}
          />
          {selectedBoss && resolvedBossWeaponTransform ? (
            <>
              <div className="inspector-scroll">
                <div className="boss-identity-card">
                  <span>OFFICIAL DESIGNATED BOSS</span>
                  <strong>{selectedBoss.displayName}</strong>
                  <code>{selectedBoss.archetypeKey}</code>
                </div>
                <TextField label="Boss ID" value={selectedBoss.bossId} readOnly />
                <TextField label="Body asset" value={selectedBoss.bodyAssetKey} readOnly />
                <TextField
                  label="Weapon asset"
                  value={selectedBoss.weapon.assetKey ?? "Not assigned"}
                  readOnly
                />
                {bossPreviewEditTarget === "overall" ? (
                  <>
                    <p className="empty-copy">
                      Scales only this designated boss body and weapon together. Player Master
                      Scale remains separate.
                    </p>
                    <Divider label="Complete boss" />
                    <NumberField
                      label="Boss master size"
                      value={selectedBossOverallScale}
                      step={0.05}
                      min={0.05}
                      max={20}
                      onChange={(overallScale) => editBossOverallScale(
                        clamp(overallScale, 0.05, 20)
                      )}
                    />
                  </>
                ) : (
                  <>
                    <Divider label={`${
                      poseLabel(selectedPose)
                    } weapon`} />
                    {bossPreviewEditTarget === "pivot" && (
                      <p className="empty-copy">
                        Drag the red pivot dot onto the weapon point that should rotate around. The
                        weapon stays visually in place while its pivot changes.
                      </p>
                    )}
                    {!selectedBoss.weapon.assetKey && (
                      <p className="empty-copy">
                        Add a weapon PNG from the Boss library to see and position this layer.
                      </p>
                    )}
                    <div className="field-grid">
                      <NumberField label="Offset X" value={resolvedBossWeaponTransform.offsetX} step={1} onChange={(offsetX) => editBossWeaponPlacement({ offsetX })} />
                      <NumberField label="Offset Y" value={resolvedBossWeaponTransform.offsetY} step={1} onChange={(offsetY) => editBossWeaponPlacement({ offsetY })} />
                      <NumberField label="Rotation (deg)" value={resolvedBossWeaponTransform.rotationDegrees} step={1} onChange={(rotationDegrees) => editBossWeaponPlacement({ rotationDegrees })} />
                      <NumberField label="Scale X" value={resolvedBossWeaponTransform.scaleX} step={0.01} min={0.001} onChange={(scaleX) => editBossWeaponPlacement({ scaleX: Math.max(0.001, scaleX) })} />
                      <NumberField label="Scale Y" value={resolvedBossWeaponTransform.scaleY} step={0.01} min={0.001} onChange={(scaleY) => editBossWeaponPlacement({ scaleY: Math.max(0.001, scaleY) })} />
                      <NumberField label="Pivot X" value={resolvedBossWeaponTransform.pivotX} step={0.01} min={0} max={1} onChange={(pivotX) => editBossWeaponPlacement({ pivotX: clamp(pivotX, 0, 1) })} />
                      <NumberField label="Pivot Y" value={resolvedBossWeaponTransform.pivotY} step={0.01} min={0} max={1} onChange={(pivotY) => editBossWeaponPlacement({ pivotY: clamp(pivotY, 0, 1) })} />
                    </div>
                    <Toggle
                      label="Weapon visible"
                      checked={resolvedBossWeaponTransform.visible}
                      onChange={(visible) => editBossWeaponPlacement({ visible })}
                    />
                  </>
                )}
              </div>
              <div className="inspector-footer">
                <button
                  type="button"
                  disabled={bossPreviewEditTarget !== "overall" &&
                    selectedPose !== "idle" && !bossPoseHasOverride}
                  onClick={() => {
                    if (bossPreviewEditTarget === "overall") {
                      editSelectedBoss((boss) => {
                        const resetBoss = { ...boss };
                        delete resetBoss.overallScale;
                        return resetBoss;
                      });
                      return;
                    }
                    editSelectedBoss((boss) => {
                      const placements = { ...boss.weapon.placements };
                      if (selectedPose === "idle") {
                        placements.idle = { ...DEFAULT_BOSS_WEAPON_TRANSFORM };
                      } else {
                        delete placements[selectedPose];
                      }
                      return {
                        ...boss,
                        weapon: { ...boss.weapon, placements }
                      };
                    });
                  }}
                >{bossPreviewEditTarget === "overall"
                    ? "Reset Boss Master Size"
                    : selectedPose === "idle"
                    ? "Reset Idle Weapon Transform"
                    : `Reset ${poseLabel(selectedPose)} to Idle`}</button>
              </div>
            </>
          ) : (
            <p className="empty-copy">Select a designated boss.</p>
          )}
        </aside>
      </section>
      )}
      </div>

      <AssetStudio
        ref={assetStudioRef}
        api={api}
        visible={studioWorkspace === "assets"}
        writesAllowed={Boolean(session?.workspace.writesAllowed) && workspacePhase === "ready"}
        onDirtyChange={setAssetDirty}
        onBusyChange={setAssetBusy}
        onMessage={setMessage}
        onPlayerHitGeometryChange={setPlayerHitGeometryState}
        onOpenAppearance={(domain) => {
          setStudioDomain(domain);
          setStudioWorkspace("appearance");
        }}
      />

      {session ? <InteriorStudio
        ref={interiorStudioRef}
        api={api}
        session={session}
        visible={studioWorkspace === "interiors"}
        writesAllowed={Boolean(session.workspace.writesAllowed) && workspacePhase === "ready"}
        onDirtyChange={setInteriorDirty}
        onBusyChange={setInteriorBusy}
        onHistoryChange={setInteriorHistory}
        hosted
        onValidationErrorsChange={setInteriorIssueCount}
        onMessage={setMessage}
      /> : null}

      <ProgressionIconStudio
        ref={progressionIconStudioRef}
        api={api}
        visible={studioWorkspace === "progression-icons"}
        writesAllowed={Boolean(session?.workspace.writesAllowed) && workspacePhase === "ready"}
        onDirtyChange={setProgressionIconDirty}
        onBusyChange={setProgressionIconBusy}
        onMessage={setMessage}
      />

      {session && <TerritoryStudio
        key={session.workspace.worktreePath}
        ref={territoryStudioRef}
        api={api}
        visible={studioWorkspace === "flags"}
        writesAllowed={session.workspace.writesAllowed && workspacePhase === "ready"}
        onDirtyChange={setTerritoryDirty}
        onBusyChange={setTerritoryBusy}
        onMessage={setMessage}
      />}


      {drawer ? (
        <>
          <div className="studio-drawer-backdrop" data-testid="studio-drawer-backdrop" onClick={() => setDrawer(null)} />
          <aside
            className="studio-drawer"
            role="dialog"
            aria-label={drawer === "publish" ? "Publish workflow" : "Selected server"}
            data-testid="studio-drawer"
          >
            <button type="button" className="ghost studio-drawer-close" data-testid="studio-drawer-close" onClick={() => setDrawer(null)}>Close</button>
      {drawer === "publish" && desktop.available && (
        <section className="desktop-workflow panel" aria-label="Desktop content workflow">
          <div className="workflow-heading">
            <PanelTitle
              title="Content publishing workflow"
              meta={`Desktop ${desktop.appVersion ?? "app"}`}
            />
            <p className="connection-copy">
              Each step is separate. Committing does not merge. Integrating does not deploy.
            </p>
          </div>
          <div className="workflow-branch" role="status">
            <strong>FEATURE BRANCH — NOT AUTOMATICALLY LIVE</strong>
            <code>{session?.workspace.branch ?? "No feature branch"}</code>
            <span>{session?.workspace.worktreePath}</span>
          </div>
          <div className="workflow-new-batch">
            <label className="field">
              <span>Need a separate batch?</span>
              <input
                aria-label="New content batch name"
                placeholder="ember-weapons"
                value={batchSlug}
                onChange={(event) => setBatchSlug(event.target.value)}
              />
            </label>
            <button
              type="button"
              disabled={busy || workspacePhase !== "ready" || batchSlug.trim().length === 0}
              onClick={() => void createBatch()}
            >Start Separate Batch</button>
          </div>
          <ol className="workflow-steps">
            <li className={dirty ? "current" : "complete"}>
              <span className="workflow-number">1</span>
              <div>
                <strong>Save draft to this worktree</strong>
                <p>Writes PNGs and settings locally. No commit, merge, or deployment.</p>
              </div>
              <span className="workflow-state">{dirty ? "Unsaved edits" : "Saved locally"}</span>
            </li>
            <li className={releaseStatus?.featurePushed ? "complete" : "current"}>
              <span className="workflow-number">2</span>
              <div>
                <strong>Commit and push the feature branch</strong>
                <p>Backs up this batch on GitHub. It is still not in Integration Test or live.</p>
                <label className="field workflow-summary">
                  <span>Commit summary</span>
                  <input
                    aria-label="Content batch commit summary"
                    placeholder="add ember weapons"
                    value={batchSummary}
                    onChange={(event) => setBatchSummary(event.target.value)}
                  />
                </label>
              </div>
              <button
                type="button"
                className="primary"
                disabled={
                  busy || workspacePhase !== "ready" || dirty || !session?.workspace.writesAllowed ||
                  batchSummary.trim().length === 0
                }
                onClick={() => void finishBatch()}
              >Commit &amp; Push Branch — Not Live</button>
            </li>
            <li className={releaseStatus?.featureIntegrated ? "complete" : "pending"}>
              <span className="workflow-number">3</span>
              <div>
                <strong>Integrate this batch into the test build</strong>
                <p>
                  Creates the next numbered test generation. This still does not deploy the
                  public server.
                </p>
              </div>
              <button
                type="button"
                disabled={
                  busy || dirty || !releaseStatus?.worktreeClean ||
                  !releaseStatus.featurePushed || releaseStatus.featureIntegrated
                }
                onClick={() => void integrateBatch()}
              >{releaseStatus?.featureIntegrated
                  ? `Included in ${releaseStatus.integrationGeneration}`
                  : "Integrate This Batch into Test"}</button>
            </li>
            <li className={releaseStatus?.integrationPublished ? "complete" : "pending"}>
              <span className="workflow-number">4</span>
              <div>
                <strong>Publish Integration Test to the public server</strong>
                <p>
                  Deploys <em>every change</em> currently in {
                    releaseStatus?.integrationGeneration ?? "Integration Test"
                  }, not only this appearance batch.
                </p>
                {releaseStatus && (
                  <code>{releaseStatus.integrationGeneration}@{
                    releaseStatus.integrationSha.slice(0, 10)
                  }</code>
                )}
              </div>
              <button
                type="button"
                className="danger"
                disabled={
                  busy || !releaseStatus?.featureIntegrated ||
                  releaseStatus.integrationPublished
                }
                onClick={() => void deployIntegration()}
              >{releaseStatus?.integrationPublished
                  ? `${releaseStatus.integrationGeneration} Is Live`
                  : `Publish ${releaseStatus?.integrationGeneration ?? "Test"} to Public Server`}</button>
            </li>
          </ol>
        </section>
      )}
      {drawer === "server" && (
      <section className="connection-panel panel" aria-label="Selected server" data-testid="studio-server-panel">
        <PanelTitle
          title="Selected server"
          meta={serverStatus}
        />
        <p className="connection-copy">
          Uses the normal logged-in Ash Atlas browser session, PKCE, and the narrow
          <code> developer:appearance-studio</code> capability. Tokens remain only in this process.
        </p>
        <input
          aria-label="Ash Atlas server URL"
          value={serverBase}
          onChange={(event) => setServerBase(event.target.value)}
        />
        {remote.connected ? (
          <button
            type="button"
            onClick={() => {
              void api.disconnectRemote().then(() => {
                setRemote({ connected: false });
                setMessage("Remote studio session disconnected and erased.");
              }).catch((error: unknown) => setMessage(errorMessage(error)));
            }}
          >Disconnect</button>
        ) : (
          <button
            type="button"
            disabled={authorizing || workspacePhase !== "ready"}
            onClick={() => {
              setAuthorizing(true);
              setMessage("Waiting for authorization in your browser…");
              void api.connectRemote(serverBase).then((status) => {
                if (status) {
                  setRemote(status);
                  setMessage("Remote studio session connected.");
                }
              }).catch((error: unknown) => setMessage(errorMessage(error)))
                .finally(() => setAuthorizing(false));
            }}
          >{authorizing ? "Authorizing…" : "Authorize"}</button>
        )}
        {remote.error && <p className="connection-error" role="alert">{remote.error}</p>}
        <div className="connection-facts">
          <span>Local SHA <code>{shortSha(session?.workspace.commitSha)}</code></span>
          <span>Server SHA <code>{shortSha(remote.serverSha)}</code></span>
          <span>Catalog {catalog.catalogRevision} / {remote.catalogRevision ?? "—"}</span>
        </div>
      </section>
      )}
          </aside>
        </>
      ) : null}

      <footer className="status-bar" data-testid="studio-status-bar">
        <span className={session && !session.workspace.writesAllowed ? "readonly-dot" : dirty || workspacePhase !== "ready" ? "dirty-dot" : "saved-dot"} />
        <strong>{primaryStatus}</strong>
        <span>{session?.workspace.branch ?? "Resolving branch"}</span>
        <span>{shortSha(session?.workspace.commitSha)}</span>
        <span className="status-message">{message}</span>
        <span>{workspaceHistory.undo} undo · {workspaceHistory.redo} redo</span>
      </footer>
    </main>
  );
}

function anchorLabel(anchorId: PlayerAttachmentAnchorId): string {
  const labels: Record<PlayerAttachmentAnchorId, string> = {
    face: "Middle of face",
    chest: "Middle of chest",
    legs: "Middle of legs",
    left_hand: "Left hand",
    right_hand: "Right hand",
    left_foot: "Left foot",
    right_foot: "Right foot"
  };
  return labels[anchorId];
}

function oppositeAnchorId(
  anchorId: PlayerAttachmentAnchorId
): PlayerAttachmentAnchorId | null {
  const opposites: Partial<Record<PlayerAttachmentAnchorId, PlayerAttachmentAnchorId>> = {
    left_hand: "right_hand",
    right_hand: "left_hand",
    left_foot: "right_foot",
    right_foot: "left_foot"
  };
  return opposites[anchorId] ?? null;
}

function previewLayerKey(
  catalog: PlayerAppearanceCatalog,
  appearance: AppearanceDefinition
): string {
  const family = catalog.families.find((candidate) =>
    candidate.familyId === appearance.familyId
  );
  const overlaySlot = family ? playerOverlaySlotForFamily(family) : null;
  if (overlaySlot === "beard") return "overlay:beard";
  const categoryId = appearanceCategory(catalog, appearance.appearanceId);
  if (STYLE_CATEGORIES.has(categoryId)) return `style:${categoryId}`;
  const equipmentId = appearance.equipmentDefinitionId ??
    appearance.compatibleEquipmentDefinitionIds?.[0] ??
    catalog.families.find((family) => family.familyId === appearance.familyId)
      ?.compatibleEquipmentDefinitionIds[0];
  const slot = equipmentId ? EQUIPMENT_DEFINITIONS[equipmentId]?.slot : undefined;
  return slot ? `slot:${slot}` : `category:${categoryId}`;
}

export function poseLabel(poseId: PlayerCombatPoseId): string {
  if (poseId === "idle") return "Idle";
  if (poseId === "combat_ready") return "Ready";
  if (poseId === "attack_action") return "Action";
  return "Downed";
}

function PanelTitle({ title, meta }: { title: string; meta: string }) {
  return (
    <div className="panel-title">
      <h2>{title}</h2>
      <span>{meta}</span>
    </div>
  );
}

function Divider({ label }: { label: string }) {
  return <div className="divider"><span>{label}</span></div>;
}

function TextField({
  label,
  value,
  onChange,
  inputRef,
  readOnly = false
}: {
  label: string;
  value: string;
  onChange?: (value: string) => void;
  inputRef?: Ref<HTMLInputElement>;
  readOnly?: boolean;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      <input
        ref={inputRef}
        value={value}
        readOnly={readOnly}
        onChange={(event) => onChange?.(event.target.value)}
      />
    </label>
  );
}

function NumberField({
  label,
  value,
  onChange,
  step,
  min,
  max,
  acceptIntermediateSign = false
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  step: number;
  min?: number;
  max?: number;
  acceptIntermediateSign?: boolean;
}) {
  const [draft, setDraft] = useState(String(value));

  useEffect(() => {
    setDraft(String(value));
  }, [value]);

  const commit = (next: string): void => {
    const parsed = Number(next);
    if (next.trim() !== "" && Number.isFinite(parsed)) {
      onChange(parsed);
      return;
    }
    setDraft(String(value));
  };

  return (
    <label className="field compact">
      <span>{label}</span>
      <input
        type={acceptIntermediateSign ? "text" : "number"}
        {...(acceptIntermediateSign ? { inputMode: "decimal" as const } : {})}
        value={draft}
        step={step}
        {...(min === undefined ? {} : { min })}
        {...(max === undefined ? {} : { max })}
        onChange={(event) => {
          const next = event.target.value;
          setDraft(next);
          const parsed = Number(next);
          if (next.trim() !== "" && Number.isFinite(parsed)) onChange(parsed);
        }}
        onBlur={(event) => commit(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
        }}
      />
    </label>
  );
}

function Toggle({
  label,
  checked,
  onChange,
  disabled = false,
  title
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <label className="toggle" title={title}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span>{label}</span>
    </label>
  );
}

function categoryForFamily(familyId: string): string {
  if (familyId === "hair") return "hair";
  if (familyId === "eyes") return "eyes";
  if (familyId === "nose_mouth") return "nose-mouth";
  if (familyId === "nose") return "nose";
  if (familyId === "mouth") return "mouth";
  if (familyId === "beard") return "cosmetics";
  if (familyId === "mask") return "masks";
  if (["chest", "hands", "legs", "feet", "player_shield"].includes(familyId)) {
    return "cosmetics";
  }
  if (familyId === "head_armor") return "armor/head";
  if (familyId.startsWith("chest_")) return "armor/chest";
  if (familyId === "gloves") return "armor/gloves";
  if (familyId === "boots") return "armor/boots";
  if (familyId === "shield") return "shields";
  if (familyId === "back_item") return "cosmetics";
  return "weapons";
}

export function appearanceSupportsGem(
  catalog: PlayerAppearanceCatalog,
  appearance: AppearanceDefinition
): boolean {
  const family = catalog.families.find((candidate) =>
    candidate.familyId === appearance.familyId
  );
  const definitionIds = new Set([
    ...(appearance.equipmentDefinitionId ? [appearance.equipmentDefinitionId] : []),
    ...(appearance.compatibleEquipmentDefinitionIds ?? []),
    ...(family?.compatibleEquipmentDefinitionIds ?? [])
  ]);
  return [...definitionIds].some((definitionId) => {
    const definition = EQUIPMENT_DEFINITIONS[definitionId];
    return definition ? venomsteelImbuementKind(definition.category) !== null : false;
  });
}

function nonZeroScale(value: number): number {
  if (Math.abs(value) >= 0.01) return clamp(value, -20, 20);
  return value < 0 ? -0.01 : 0.01;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function firstAppearanceForContext(
  catalog: PlayerAppearanceCatalog,
  categoryId: PlayerAppearanceCategoryId,
  familyId?: string,
  preferredId?: AppearanceDefinitionId
): AppearanceDefinitionId | null {
  const candidates = catalog.appearances.filter((appearance) =>
    !appearance.retired &&
    appearanceCategory(catalog, appearance.appearanceId) === categoryId &&
    (!familyId || appearance.familyId === familyId)
  );
  return candidates.find((appearance) => appearance.appearanceId === preferredId)
    ?.appearanceId ?? candidates[0]?.appearanceId ?? null;
}

function selectionContextKey(
  categoryId: PlayerAppearanceCategoryId,
  familyId?: string
): string {
  return `${categoryId}:${familyId ?? "all"}`;
}

function formatRecoveryTime(value: string): string {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toLocaleTimeString() : "an earlier session";
}

function shortSha(value: string | null | undefined): string {
  return value ? value.slice(0, 10) : "—";
}

function appearanceStudioUpdateMessage(session: StudioSession): string {
  const compatibility = session.workspace.compatibility;
  return `This worktree requires Appearance Studio ${
    compatibility.minimumDesktopVersion ?? "with a newer contract"
  } or newer (contract ${compatibility.contractVersion ?? "missing"}). ` +
    `This app supports through contract ${compatibility.supportedContractVersion}. ` +
    "The catalog was not opened or changed.";
}

function studioServerMismatchMessage(session: StudioSession): string {
  return `This Studio server is running ${shortSha(session.server.commitSha)}, but the selected workspace is ${shortSha(session.workspace.commitSha)}. Writes are disabled; open the exact-tip Studio instance or restart this server before authoring.`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Appearance Studio operation failed";
}

function worktreeName(worktreePath: string): string {
  return worktreePath.split(/[\\/]/u).filter(Boolean).at(-1) ?? worktreePath;
}
