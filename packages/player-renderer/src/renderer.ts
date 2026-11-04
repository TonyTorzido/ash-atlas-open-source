import {
  DEFAULT_PLAYER_FACE_APPEARANCE_ID,
  DEFAULT_PLAYER_BODY_VARIANT_ID,
  DEFAULT_PLAYER_SKIN_TONE_ID,
  DEFAULT_PLAYER_APPEARANCE_CATALOG,
  PLAYER_RENDER_LAYERS,
  SALON_SELECTABLE_APPEARANCE_CATEGORY_IDS,
  appearanceAssetParts,
  appearanceCategory,
  equipmentGemSocket,
  isFaceFeatureCategory,
  playerBodyAssetKey,
  playerHeadAssetKey,
  playerBodyPose,
  playerSkinToneAssetKey,
  playerMainAnchor,
  playerOverallScale,
  playerTemplateTransform,
  resolveAppearanceLocalTransform,
  resolveFaceFeaturePoint,
  salonAppearanceCategory,
  visibleAppearanceForSlot,
  type AppearanceDefinition,
  type AppearanceDefinitionId,
  type AppearancePartId,
  type EquipmentAppearanceEnhancement,
  type PlayerAnchorPoint,
  type PlayerCombatPoseId,
  type PlayerBodyVariantId,
  type PlayerAppearanceCatalog,
  type PlayerAppearanceSnapshot,
  type PlayerRenderLayer,
  type PlayerSkinToneId,
  type PlayerTemplateTransform
} from "@ash-atlas/shared";
import {
  Assets,
  Container,
  Sprite,
  Texture
} from "pixi.js";

import {
  GATHER_PROGRAMS,
  GATHER_TUNING,
  SWING_PROGRAMS,
  REST_ARM_DEGREES,
  armGeometryForBody,
  armPolygonInTexture,
  createArmGeometry,
  createGatherPose,
  defaultArmCutRelease,
  defaultArmCutter,
  gatherProgramId,
  sideX,
  impactsBetween,
  lerpPose,
  reducePose,
  sampleFishPhase,
  sampleProgram,
  sampleSwing,
  toolRotation,
  type ArmCut,
  type ArmGeometry,
  type ArmCutPlacement,
  type ArmCutRelease,
  type ArmCutter,
  type GatherFishPhase,
  type GatherPose,
  type GatherProgramId,
  type GatheringAction,
  type GatherSide,
  type MutablePoint,
  type SwingVariant
} from "./gatherAnimation.js";
import { ArmRig } from "./armRig.js";
import {
  FLAG_BUILD_PROGRAM,
  FLAG_BUILD_TUNING,
  FlagBuildRig,
  createFlagBuildPose,
  reduceFlagBuildPose,
  sampleFlagBuild,
  scaleFlagBuildPose,
  type FlagBuildArt
} from "./flagBuildAnimation.js";
import {
  LegMesh,
  WALK_TUNING,
  deformLegMesh,
  restoreLegMesh,
  strideBob,
  strideLeft,
  strideRight
} from "./walkAnimation.js";
import {
  createProceduralPlayerBody,
  PLAYER_BASE_HEIGHT_PX
} from "./proceduralBody.js";

export type PlayerTextureLoader = {
  load(assetKey: string): Promise<Texture>;
};

export type PlayerAppearanceDiagnostic = (
  message: string,
  detail: Readonly<{ assetKey?: string; appearanceId?: string; error?: unknown }>
) => void;

export type PlayerRendererOptions = {
  local: boolean;
  color: number;
  catalog?: PlayerAppearanceCatalog;
  textureLoader?: PlayerTextureLoader;
  diagnostic?: PlayerAppearanceDiagnostic;
  /** Splits arm-covering textures for gathering swings (defaults to a shared canvas cutter). */
  armCutter?: Readonly<{ cut: ArmCutter; release: ArmCutRelease }>;
};

export type PlayerAppearanceRenderOptions = {
  showGemstones?: boolean;
  skinToneId?: PlayerSkinToneId;
};

/** One display frame; caps the ease step on the frame after a (possibly slow) rig build. */
const NOMINAL_FRAME_MS = 1000 / 60;
/** Local-player arm pre-cut: idle callback deadline, and the delay where idle callbacks are missing. */
const PREWARM_TIMEOUT_MS = 2000;
const PREWARM_FALLBACK_DELAY_MS = 300;

/** Layers whose art can cover an arm; split into armless + bendable arm while gathering. */
const ARM_COVERING_LAYERS: readonly PlayerRenderLayer[] = [
  "body",
  "chest_armor",
  "gloves",
  "hands"
];

type GatherRigPiece = {
  source: Sprite | LegMesh;
  original: Texture;
  cut: ArmCut;
};

type GatherHidden = { sprite: Container; alpha: number };

/** An equipped weapon or shield that follows the arm during an action-combat swing. */
type SwingHeld = {
  kind: "weapon" | "shield";
  sprite: Sprite;
  gem: Sprite | null;
  appearanceId: AppearanceDefinitionId;
  partId: AppearancePartId;
  featurePoint: PlayerAnchorPoint | null;
  /** Side of the body the art holds it on: -1 = left of the body centre, 1 = right. */
  side: number;
  baseX: number;
  baseY: number;
  baseRotation: number;
  baseScaleX: number;
};

type GatherParticle = {
  sprite: Sprite;
  x: number;
  y: number;
  vx: number;
  vy: number;
  spin: number;
  ageMs: number;
  lifeMs: number;
};

/** Layers whose art covers the legs; their sprites are deformable meshes. */
const LEG_COVERING_LAYERS: ReadonlySet<PlayerRenderLayer> = new Set([
  "boots",
  "feet",
  "legs",
  "chest_armor"
]);

export type AppliedAppearanceTransform = ReturnType<
  typeof resolveAppearanceLocalTransform
> & {
  rotationRadians: number;
};

export class PlayerRenderer {
  readonly root = new Container();
  readonly visualRoot = new Container();
  readonly layers: Readonly<Record<PlayerRenderLayer, Container>>;
  readonly baseHeightPx = PLAYER_BASE_HEIGHT_PX;
  private catalog: PlayerAppearanceCatalog;
  private readonly textureLoader: PlayerTextureLoader | null;
  private readonly diagnostic: PlayerAppearanceDiagnostic;
  private readonly sprites = new Map<string, {
    appearanceId: AppearanceDefinitionId;
    partId: AppearancePartId;
    sprite: Sprite;
    enhancement: EquipmentAppearanceEnhancement | null;
    featurePoint: PlayerAnchorPoint | null;
  }>();
  private readonly gemSprites = new Map<string, Sprite>();
  private heldWeaponCache: { texture: Texture; familyId: string } | null = null;
  private readonly diagnosticsEmitted = new Set<string>();
  private body: Container | Sprite;
  private headSprite: Sprite | null = null;
  private readonly local: boolean;
  private readonly color: number;
  private templateRequestIdentity = "procedural";
  /** After a failed texture load the same request is retried, but not before this time (ms epoch); no retry storm. */
  private textureRetryNotBeforeMs = 0;
  private textureFailures = 0;
  private templateUpdateGeneration = 0;
  private updateGeneration = 0;
  private appearanceSignature = "";
  private currentPose: PlayerCombatPoseId = "idle";
  private currentBodyVariantId: PlayerBodyVariantId = DEFAULT_PLAYER_BODY_VARIANT_ID;
  private currentSkinToneId: PlayerSkinToneId = DEFAULT_PLAYER_SKIN_TONE_ID;
  private lastAppearanceSnapshot: PlayerAppearanceSnapshot | undefined;
  private lastAppearanceRenderOptions: PlayerAppearanceRenderOptions = {};
  private _appearanceRevision = -1;
  private _appearanceBuildCount = 0;
  private _appearanceComplete = true;
  private readonly legMeshes: LegMesh[] = [];
  private walkMoving = false;
  private walkSpeedFactor = 1;
  private walkActive = false;
  private walkAmount = 0;
  private walkSwayAmount = 0;
  private walkPhase = 0;
  private walkLastMs = -1;
  private walkProfileDirty = true;
  private swayApplied = false;
  private readonly walkProfile = {
    hipY: 0,
    groundY: 0,
    centerX: 0,
    frontHandX: 0,
    frontHandY: 0,
    rearHandX: 0,
    rearHandY: 0
  };
  private readonly armCutter: ArmCutter;
  private readonly armCutRelease: ArmCutRelease;
  private gatherAction: GatheringAction | null = null;
  /** Action-combat swing in progress (one-shot arm program); null = none. */
  private swingVariant: SwingVariant | null = null;
  private swingStartedAtMs = 0;
  private swingReduced = false;
  private readonly swingHeld: SwingHeld[] = [];
  private gatherProgram: GatherProgramId | null = null;
  private gatherSign = 1;
  private gatherStartedAtMs = 0;
  private gatherReduced = false;
  private gatherActive = false;
  private gatherAmount = 0;
  private gatherLastMs = -1;
  private gatherLastElapsedMs = 0;
  private gatherToolTexture: Texture | null = null;
  private gatherToolKey: string | null = null;
  private gatherToolGeneration = 0;
  private gatherToolSprite: Sprite | null = null;
  /** A held-tool texture is loading: the action holds its rest pose until it arrives. */
  private gatherToolLoading = false;
  /** The next frame after a rig build counts as one nominal frame (the build may be slow). */
  private gatherRigJustBuilt = false;
  /** Local player: arm cuts made ahead of the first action, held until the art changes. */
  private readonly prewarmedCuts: ArmCut[] = [];
  private prewarmHandle: { cancel(): void } | null = null;
  private gatherLineSprite: Sprite | null = null;
  private gatherLineTargetSet = false;
  private readonly gatherLineTarget = { x: 0, y: 0 };
  private gatherRigBuilt = false;
  private gatherRigFailed = false;
  private gatherRigDirty = false;
  private gatherRigSigns: number[] = [];
  private readonly gatherRigPieces: GatherRigPiece[] = [];
  private readonly gatherHidden: GatherHidden[] = [];
  private gatherBodyApplied = false;
  private fishPhase: GatherFishPhase = "wait";
  private fishPreviousPhase: GatherFishPhase = "wait";
  private fishPhaseChangedAtMs = Number.NaN;
  private fishCastStartMs = Number.NaN;
  private fishSinceCastMs = Infinity;
  private readonly gatherPose = createGatherPose();
  private readonly armGeometry: ArmGeometry = createArmGeometry();
  private readonly gatherPoseB = createGatherPose();
  private readonly gatherPoint: MutablePoint = { x: 0, y: 0 };
  private readonly gatherPointB: MutablePoint = { x: 0, y: 0 };
  private gatherParticleLayer: Container | null = null;
  private readonly gatherParticles: GatherParticle[] = [];
  private gatherParticlesAlive = 0;
  private _gatherImpactCount = 0;
  /** Flag building rig (bent arms, held flag, dust); created on the first flag build. */
  private flagRig: FlagBuildRig | null = null;
  private lastFlagBuildArt: FlagBuildArt | null = null;
  private gatherImpactOrigin: { x: number; y: number } | null = null;
  /** A sprite-sheet body owns the flag impacts (its plant clip's contact frame): the work loop counts none. */
  private flagImpactsExternal = false;
  /** Bendable arms (both sides); created on the first bent-arm action. */
  private armRig: ArmRig | null = null;
  private readonly flagPose = createFlagBuildPose();
  private readonly walkDeform = {
    liftLeft: 0,
    liftRight: 0,
    compensation: 0,
    hipY: 0,
    groundY: 0,
    centerX: 0,
    sideBlendUnits: WALK_TUNING.sideBlendUnits
  };

  constructor(options: PlayerRendererOptions) {
    this.local = options.local;
    this.color = options.color;
    this.catalog = options.catalog ?? DEFAULT_PLAYER_APPEARANCE_CATALOG;
    this.textureLoader = options.textureLoader ?? null;
    this.diagnostic = options.diagnostic ?? (() => undefined);
    this.armCutter = options.armCutter?.cut ?? defaultArmCutter;
    this.armCutRelease = options.armCutter?.release ?? defaultArmCutRelease;
    const layers = Object.fromEntries(
      PLAYER_RENDER_LAYERS.map((layer) => [layer, new Container()])
    ) as Record<PlayerRenderLayer, Container>;
    this.layers = layers;
    this.visualRoot.addChild(...PLAYER_RENDER_LAYERS.map((layer) => layers[layer]));
    this.root.addChild(this.visualRoot);
    this.visualRoot.scale.set(playerOverallScale(
      this.catalog,
      DEFAULT_PLAYER_BODY_VARIANT_ID
    ));
    this.applyMainAnchor();
    this.body = createProceduralPlayerBody({
      local: options.local,
      color: options.color
    });
    layers.body.addChild(this.body);
  }

  get appearanceRevision(): number {
    return this._appearanceRevision;
  }

  get appearanceBuildCount(): number {
    return this._appearanceBuildCount;
  }

  get appearanceComplete(): boolean {
    return this._appearanceComplete;
  }

  get overallScale(): number {
    return playerOverallScale(this.catalog, this.currentBodyVariantId);
  }

  equipmentSprite(slot: string): Sprite | null {
    return this.sprites.get(`${slot}:main`)?.sprite ??
      [...this.sprites.entries()].find(([key]) => key.startsWith(`${slot}:`))?.[1].sprite ??
      null;
  }

  appearanceSprite(key: string, partId: AppearancePartId = "main"): Sprite | null {
    return this.sprites.get(`${key}:${partId}`)?.sprite ?? null;
  }

  equipmentGemSprite(slot: string): Sprite | null {
    return [...this.gemSprites.entries()].find(([key]) =>
      key.startsWith(`${slot}:`)
    )?.[1] ?? null;
  }

  /** Global (stage) position of a face-feature point given in face-anchor local units. */
  faceFeatureGlobalPoint(point: PlayerAnchorPoint): { x: number; y: number } {
    const face = playerBodyPose(this.catalog, this.currentBodyVariantId, this.currentPose)
      .anchors.face;
    const global = this.layers.eyes.toGlobal({ x: face.x + point.x, y: face.y + point.y });
    return { x: global.x, y: global.y };
  }

  /** Face-anchor local point under a global (stage) position. */
  faceFeaturePointAt(globalX: number, globalY: number): PlayerAnchorPoint {
    const face = playerBodyPose(this.catalog, this.currentBodyVariantId, this.currentPose)
      .anchors.face;
    const local = this.layers.eyes.toLocal({ x: globalX, y: globalY });
    return { x: local.x - face.x, y: local.y - face.y };
  }

  /** True while a walk cycle is playing or easing out (needs updateAnimation each frame). */
  get walkAnimating(): boolean {
    return this.walkActive;
  }

  /**
   * Starts or stops the procedural walk cycle. It eases in and out; call
   * updateAnimation each frame while walkAnimating. speedFactor scales the
   * stride rate (1 = normal walk).
   */
  setLocomotion(moving: boolean, speedFactor = 1): void {
    const allowed = moving && this.currentPose !== "downed" && !this.gatherAction && !this.swingVariant;
    this.walkMoving = allowed;
    this.walkSpeedFactor = Math.min(2, Math.max(0.5, speedFactor));
    if (allowed && !this.walkActive) {
      this.walkActive = true;
      this.walkPhase = 0;
      this.walkLastMs = -1;
    }
  }

  /** True while a walk cycle or gathering action needs updateAnimation each frame. */
  get animating(): boolean {
    return this.walkActive || this.gatherActive;
  }

  /** Advances the walk cycle and any gathering action to nowMs. Returns whether frames are still needed. */
  updateAnimation(nowMs: number): boolean {
    const walking = this.walkActive ? this.updateWalk(nowMs) : false;
    const gathering = this.gatherActive ? this.updateGather(nowMs) : false;
    return walking || gathering;
  }

  private updateWalk(nowMs: number): boolean {
    const dtMs = this.walkLastMs < 0
      ? 0
      : Math.min(WALK_TUNING.maxFrameMs, Math.max(0, nowMs - this.walkLastMs));
    this.walkLastMs = nowMs;
    const step = dtMs / WALK_TUNING.easeMs;
    this.walkAmount = approach(this.walkAmount, this.walkMoving ? 1 : 0, step);
    const swayWeight = this.walkMoving
      ? WALK_TUNING.swayPoseWeight[this.currentPose] ?? 0
      : 0;
    this.walkSwayAmount = approach(this.walkSwayAmount, swayWeight, step);
    if (
      !this.walkMoving &&
      this.walkAmount <= 0 &&
      this.walkSwayAmount <= 0
    ) {
      this.resetWalkPose();
      return false;
    }
    this.walkPhase = (this.walkPhase +
      Math.PI * 2 * WALK_TUNING.strideHz * this.walkSpeedFactor * dtMs / 1000) %
      (Math.PI * 2);
    this.applyWalkPose();
    return true;
  }

  private applyWalkPose(): void {
    if (this.walkProfileDirty) this.refreshWalkProfile();
    const profile = this.walkProfile;
    const phase = this.walkPhase;
    const amount = this.walkAmount;
    const bob = amount * WALK_TUNING.bobUnits * strideBob(phase);
    this.visualRoot.position.y = -bob * this.overallScale;
    const deform = this.walkDeform;
    deform.liftLeft = amount * WALK_TUNING.liftUnits * strideLeft(phase);
    deform.liftRight = amount * WALK_TUNING.liftUnits * strideRight(phase);
    deform.compensation = bob;
    deform.hipY = profile.hipY;
    deform.groundY = profile.groundY;
    deform.centerX = profile.centerX;
    for (let index = 0; index < this.legMeshes.length; index += 1) {
      deformLegMesh(this.legMeshes[index]!, deform);
    }
    const sway = this.walkSwayAmount * WALK_TUNING.swayDegrees *
      Math.PI / 180 * Math.sin(phase);
    swayLayer(this.layers.front_hand, profile.frontHandX, profile.frontHandY, sway);
    swayLayer(this.layers.rear_hand, profile.rearHandX, profile.rearHandY, -sway);
    this.swayApplied = true;
  }

  /** Restores the exact rest transforms/vertices and stops all per-frame work. */
  private resetWalkPose(): void {
    this.walkActive = false;
    this.walkMoving = false;
    this.walkAmount = 0;
    this.walkSwayAmount = 0;
    this.walkLastMs = -1;
    for (const mesh of this.legMeshes) restoreLegMesh(mesh);
    if (this.swayApplied) {
      swayLayer(this.layers.front_hand, 0, 0, 0);
      swayLayer(this.layers.rear_hand, 0, 0, 0);
      this.swayApplied = false;
    }
    if (this.currentPose !== "downed") this.visualRoot.position.y = 0;
  }

  /** The gathering action set (sprite-sheet bodies draw their own clip for it), or null. */
  get gatheringAction(): GatheringAction | null {
    return this.gatherAction;
  }

  /** The held tool's loaded texture for the current action (null = bare hands or still loading). */
  get gatheringToolTexture(): Texture | null {
    return this.gatherAction?.tool === null ? null : this.gatherToolTexture;
  }

  /**
   * Root-space point gathering impacts spawn from (the tool head / flag base of a sprite-sheet body), or null for
   * the drawn body's own tool and fist.
   */
  setGatherImpactOrigin(point: Readonly<{ x: number; y: number }> | null): void {
    if (!point) this.gatherImpactOrigin = null;
    else if (this.gatherImpactOrigin) { this.gatherImpactOrigin.x = point.x; this.gatherImpactOrigin.y = point.y; }
    else this.gatherImpactOrigin = { x: point.x, y: point.y };
  }

  /** While true the drawn flag work loop spawns no impacts; the sprite-sheet body calls spawnFlagImpact instead. */
  setFlagImpactsExternal(external: boolean): void {
    this.flagImpactsExternal = external;
  }

  /** One flag-build impact now (a sprite-sheet body's plant contact): counted and dusted like the work loop's. */
  spawnFlagImpact(): void {
    if (this.gatherProgram !== "flag") return;
    this._gatherImpactCount += 1;
    this.ensureFlagRig().spawnImpact(this.gatherSign, this.gatherImpactOrigin);
  }

  /** The flag art last handed to setFlagBuildArt. */
  get flagBuildArt(): FlagBuildArt | null {
    return this.lastFlagBuildArt;
  }

  /**
   * The equipped weapon's loaded art and appearance family (a sprite-sheet body draws it in its own hand), or null
   * (none equipped or still loading).
   */
  get heldWeapon(): { texture: Texture; familyId: string } | null {
    for (const entry of this.sprites.values()) {
      if (appearanceCategory(this.catalog, entry.appearanceId) !== "weapon") continue;
      const texture = entry.sprite.texture;
      if (!texture || texture === Texture.EMPTY) return null;
      if (this.heldWeaponCache?.texture !== texture) {
        const familyId = this.catalog.appearances.find((candidate) => candidate.appearanceId === entry.appearanceId)?.familyId ?? "";
        this.heldWeaponCache = { texture, familyId };
      }
      return this.heldWeaponCache;
    }
    return null;
  }

  /** Whether a gathering action is set (it may still be easing in). */
  get gathering(): boolean {
    return this.gatherAction !== null;
  }

  /** Whether an action-combat arm swing is playing. */
  get swinging(): boolean {
    return this.swingVariant !== null;
  }

  /**
   * Plays one action-combat arm swing (about 350 ms) on the arm at `side`, starting at startMs on the
   * updateAnimation clock. The held weapon turns with the arm. A new swing restarts the program.
   * Ignored while a gathering action runs or the player is downed. Returns whether it started.
   */
  playSwing(variant: SwingVariant, side: GatherSide, startMs: number, reducedMotion = false): boolean {
    if (this.currentPose === "downed" || this.gatherAction) return false;
    const sign = side === "left" ? -1 : 1;
    if (this.walkActive) this.resetWalkPose();
    if (this.swingVariant === null || sign !== this.gatherSign) this.gatherRigDirty = true;
    this.swingVariant = variant;
    this.swingStartedAtMs = startMs;
    this.swingReduced = reducedMotion;
    // The rig needs some non-flag program; the swing drives its own pose.
    this.gatherProgram = "chop";
    this.gatherSign = sign;
    this.gatherAmount = 1;
    if (!this.gatherActive) {
      this.gatherActive = true;
      this.gatherLastMs = -1;
    }
    return true;
  }

  /** Stops a swing now (a dash): the arm, weapon and body return to the exact rest pose. */
  cancelSwing(): void {
    if (this.swingVariant === null) return;
    this.swingVariant = null;
    this.resetGatherPose();
  }

  /** Impacts played so far (chop/mine strikes); lets callers shake the worked object. */
  get gatherImpactCount(): number {
    return this._gatherImpactCount;
  }

  /**
   * Starts, updates or (with null) ends a gathering action. Repeating the same
   * action is free; only the fishing phase and reduced-motion flag update in place.
   * startedAtMs uses the updateAnimation clock. The action eases in and out.
   */
  setGatheringAction(action: GatheringAction | null): void {
    const previous = this.gatherAction;
    if (!action) {
      this.gatherAction = null;
      return;
    }
    if (this.currentPose === "downed") return;
    if (this.swingVariant) {
      // Gathering takes over from a swing in progress; the rig is rebuilt for the action.
      this.swingVariant = null;
      this.gatherRigDirty = true;
      this.gatherAmount = 0;
    }
    const program = gatherProgramId(action.kind, action.tool !== null);
    const sign = action.side === "left" ? -1 : 1;
    this.gatherAction = action;
    if (action.kind === "fish") {
      this.setFishPhase(
        action.fishPhase ?? "wait",
        previous?.kind !== "fish" || previous.startedAtMs !== action.startedAtMs,
        action.startedAtMs
      );
    }
    const same = previous !== null &&
      previous.kind === action.kind &&
      previous.side === action.side &&
      previous.tool === action.tool &&
      previous.startedAtMs === action.startedAtMs;
    if (same && this.gatherActive) return;
    if (this.walkActive) this.resetWalkPose();
    if (program !== this.gatherProgram || sign !== this.gatherSign) {
      this.gatherProgram = program;
      this.gatherSign = sign;
      this.gatherRigDirty = true;
    }
    if (!same) {
      this.gatherStartedAtMs = action.startedAtMs;
      this.gatherLastElapsedMs = Number.NaN;
    }
    // Picking is always bare-handed.
    this.setGatherTool(program === "harvest" ? null : action.tool);
    if (!this.gatherActive) {
      this.gatherActive = true;
      this.gatherLastMs = -1;
    }
  }

  /**
   * Root-local point the fishing line runs to (e.g. the projected cast point);
   * null hides the renderer's own line.
   */
  setGatheringLineTarget(point: Readonly<{ x: number; y: number }> | null): void {
    this.gatherLineTargetSet = point !== null;
    if (point) {
      this.gatherLineTarget.x = point.x;
      this.gatherLineTarget.y = point.y;
    }
  }

  /**
   * Flag art held while building a flag (kind "flag"); null shows the arm
   * motion without a pole. Repeating the same art is free.
   */
  setFlagBuildArt(art: FlagBuildArt | null): void {
    this.lastFlagBuildArt = art;
    if (!art && !this.flagRig) return;
    this.ensureFlagRig().setArt(art);
  }

  /** Whether the held flag pole is currently shown (tests and diagnostics). */
  get flagBuildPoleVisible(): boolean {
    return this.flagRig?.flagVisible === true && this.gatherProgram === "flag";
  }

  private ensureFlagRig(): FlagBuildRig {
    // The arms go in first so the held pole is drawn over them.
    this.ensureArmRig();
    this.flagRig ??= new FlagBuildRig(this.root, this.visualRoot, this.layers.head);
    return this.flagRig;
  }

  private ensureArmRig(): ArmRig {
    // Arms sit behind the torso layers: a turned arm comes out from under the
    // torso's own edge, so its root never shows as a cut stub.
    // Shoulder caps go in front of the torso, behind the hands (tool) and head.
    this.armRig ??= new ArmRig(this.visualRoot, this.layers.body, this.layers.hands);
    return this.armRig;
  }

  /** Root-local position of the held tool's tip; false when no tool is shown. */
  gatheringToolTip(out: MutablePoint): boolean {
    const sprite = this.gatherToolSprite;
    if (!sprite || !sprite.visible || !this.gatherActive) return false;
    const tuning = this.toolTuning();
    this.toolPoint(sprite, tuning.tipX, tuning.tipY, out);
    this.visualToRoot(out.x, out.y, out);
    return true;
  }

  private setFishPhase(phase: GatherFishPhase, fresh: boolean, startedAtMs: number): void {
    if (fresh) {
      this.fishPhase = phase;
      this.fishPreviousPhase = phase;
      this.fishPhaseChangedAtMs = -Infinity;
      this.fishCastStartMs = phase === "wait" ? startedAtMs : Number.NaN;
      return;
    }
    if (phase === this.fishPhase) return;
    this.fishPreviousPhase = this.fishPhase;
    this.fishPhase = phase;
    // Stamped with the frame clock on the next update.
    this.fishPhaseChangedAtMs = Number.NaN;
    if (phase === "wait" && this.fishPreviousPhase === "ready") this.fishCastStartMs = Number.NaN;
  }

  private setGatherTool(tool: Texture | string | null): void {
    if (typeof tool === "string") {
      if (tool === this.gatherToolKey) return;
      this.gatherToolKey = tool;
      this.gatherToolTexture = null;
      const generation = ++this.gatherToolGeneration;
      this.gatherToolLoading = false;
      if (!this.textureLoader) return;
      this.gatherToolLoading = true;
      this.textureLoader.load(tool).then((texture) => {
        if (generation !== this.gatherToolGeneration) return;
        this.gatherToolTexture = texture;
        this.gatherToolLoading = false;
      }, (error: unknown) => {
        if (generation === this.gatherToolGeneration) this.gatherToolLoading = false;
        this.emitDiagnosticOnce(
          `tool:${tool}`,
          "Gathering tool texture could not be loaded; showing bare hands.",
          { assetKey: tool, error }
        );
      });
      return;
    }
    this.gatherToolKey = null;
    this.gatherToolGeneration += 1;
    this.gatherToolLoading = false;
    this.gatherToolTexture = tool;
  }

  private updateGather(nowMs: number): boolean {
    let dtMs = this.gatherLastMs < 0
      ? 0
      : Math.min(GATHER_TUNING.maxFrameMs, Math.max(0, nowMs - this.gatherLastMs));
    // A rig build cuts textures and may take a long frame; the ease-in
    // continues from where it was instead of jumping by the stalled time.
    if (this.gatherRigJustBuilt) {
      this.gatherRigJustBuilt = false;
      dtMs = Math.min(dtMs, NOMINAL_FRAME_MS);
    }
    this.gatherLastMs = nowMs;
    const action = this.gatherAction;
    if (this.swingVariant) return this.updateSwing(nowMs);
    // While the held tool's art is still loading the action holds where it is
    // (the rest pose at the start), so no frame shows the swing without the tool.
    const target = action ? (this.gatherToolLoading ? this.gatherAmount : 1) : 0;
    this.gatherAmount = approach(this.gatherAmount, target, dtMs / GATHER_TUNING.easeMs);
    if (this.gatherParticlesAlive > 0) this.updateGatherParticles(dtMs);
    if (this.flagRig?.effectsAlive) this.flagRig.updateEffects(dtMs);
    if ((!action && this.gatherAmount <= 0) || this.gatherProgram === null) {
      this.resetGatherPose();
      return this.gatherActive;
    }
    if (this.gatherRigDirty || !this.gatherRigBuilt) {
      this.rebuildGatherRig();
      this.gatherRigJustBuilt = true;
    }
    const reduced = action ? action.reducedMotion === true : this.gatherReduced;
    this.gatherReduced = reduced;
    const cadence = reduced ? GATHER_TUNING.reducedCadence : 1;
    const elapsedMs = nowMs - this.gatherStartedAtMs;
    const program = this.gatherProgram;
    if (program === "flag") {
      this.updateFlagBuild(nowMs, elapsedMs, cadence, reduced, action !== null);
      this.gatherLastElapsedMs = elapsedMs;
      return true;
    }
    const pose = this.sampleGather(program, nowMs, elapsedMs, cadence, reduced);
    this.applyGather(pose);
    if (
      program !== "fish" &&
      action &&
      !reduced &&
      this.gatherAmount >= 0.9 &&
      !Number.isNaN(this.gatherLastElapsedMs) &&
      impactsBetween(GATHER_PROGRAMS[program], cadence, this.gatherLastElapsedMs, elapsedMs) > 0
    ) {
      this._gatherImpactCount += 1;
      this.spawnGatherParticles(program);
    }
    this.gatherLastElapsedMs = elapsedMs;
    return true;
  }

  private updateSwing(nowMs: number): boolean {
    const variant = this.swingVariant!;
    const elapsedMs = nowMs - this.swingStartedAtMs;
    if (elapsedMs >= SWING_PROGRAMS[variant].cycleMs) {
      this.swingVariant = null;
      this.resetGatherPose();
      return this.gatherActive;
    }
    if (this.gatherRigDirty || !this.gatherRigBuilt) this.rebuildGatherRig();
    this.fadeGatherHidden(1);
    const pose = sampleSwing(variant, elapsedMs, this.gatherPose);
    if (this.swingReduced) reducePose(pose, SWING_PROGRAMS[variant].hold);
    const sign = this.gatherSign;
    const geometry = this.armGeometry;
    const rig = this.armRig;
    if (this.gatherRigBuilt && !this.gatherRigFailed && rig) {
      rig.setBodyScale(1 + pose.squash * 0.5, 1 - pose.squash);
      rig.pose(geometry, -sign, pose.offArm, pose.offBend, this.gatherPointB);
      rig.pose(geometry, sign, pose.arm, pose.bend, this.gatherPoint);
    } else {
      this.gatherPoint.x = sideX(geometry, geometry.fistX, sign);
      this.gatherPoint.y = geometry.fistY;
      this.gatherPointB.x = sideX(geometry, geometry.fistX, -sign);
      this.gatherPointB.y = geometry.fistY;
    }
    this.moveSwingHeld(sign, pose.tool - GATHER_TUNING.tool.restDegrees);
    this.applyGatherBody(sign, pose.lean, pose.squash, pose.lift);
    return true;
  }

  /**
   * Carries the equipped weapon with the swing arm: it is turned about the fist by the tool direction
   * change and moved to the arm's fist; a shield follows the off fist. The maths is in the right-hand
   * frame; a left swing mirrors the result across the body centre.
   */
  private moveSwingHeld(sign: number, toolDeltaDegrees: number): void {
    const held = this.swingHeld;
    if (held.length === 0) return;
    const geometry = this.armGeometry;
    const cx = geometry.centerX;
    // Pixi rotation change of a weapon held in the swing arm (a left arm turns the other way round).
    const delta = -sign * toolDeltaDegrees * Math.PI / 180;
    const cos = Math.cos(delta);
    const sin = Math.sin(delta);
    const restFistX = sideX(geometry, geometry.fistX, sign);
    for (let index = 0; index < held.length; index += 1) {
      const entry = held[index]!;
      const sprite = entry.sprite;
      if (sprite.destroyed) continue;
      if (entry.kind === "shield") {
        // The shield (still side) follows the off fist without turning.
        sprite.position.set(
          entry.baseX + this.gatherPointB.x - sideX(geometry, geometry.fistX, -sign),
          entry.baseY + this.gatherPointB.y - geometry.fistY
        );
      } else {
        // Held on the other side than the swinging arm: mirror it into that hand first.
        const mirror = entry.side !== sign;
        const baseX = mirror ? 2 * cx - entry.baseX : entry.baseX;
        const baseRotation = mirror ? -entry.baseRotation : entry.baseRotation;
        const rx = baseX - restFistX;
        const ry = entry.baseY - geometry.fistY;
        sprite.position.set(this.gatherPoint.x + cos * rx - sin * ry, this.gatherPoint.y + sin * rx + cos * ry);
        sprite.rotation = baseRotation + delta;
        sprite.scale.x = mirror ? -entry.baseScaleX : entry.baseScaleX;
      }
      if (entry.gem && !entry.gem.destroyed) {
        applyGemTransform(entry.gem, sprite, this.catalog, entry.appearanceId, entry.partId);
      }
    }
  }

  /** Puts swing-held sprites back to their catalog transform for the current pose. */
  private restoreSwingHeld(): void {
    const held = this.swingHeld;
    for (let index = 0; index < held.length; index += 1) {
      const entry = held[index]!;
      if (entry.sprite.destroyed) continue;
      applyAppearanceTransform(
        entry.sprite,
        this.catalog,
        entry.appearanceId,
        this.currentPose,
        this.currentBodyVariantId,
        entry.partId,
        entry.featurePoint
      );
      if (entry.gem && !entry.gem.destroyed) {
        applyGemTransform(entry.gem, entry.sprite, this.catalog, entry.appearanceId, entry.partId);
      }
    }
    held.length = 0;
  }

  private sampleGather(
    program: Exclude<GatherProgramId, "flag">,
    nowMs: number,
    elapsedMs: number,
    cadence: number,
    reduced: boolean
  ): GatherPose {
    const pose = this.gatherPose;
    if (program === "fish") {
      if (Number.isNaN(this.fishPhaseChangedAtMs)) this.fishPhaseChangedAtMs = nowMs;
      if (Number.isNaN(this.fishCastStartMs) && this.fishPhase === "wait") this.fishCastStartMs = nowMs;
      const sinceCastMs = Number.isNaN(this.fishCastStartMs) ? Infinity : nowMs - this.fishCastStartMs;
      this.fishSinceCastMs = sinceCastMs;
      sampleFishPhase(this.fishPhase, sinceCastMs, nowMs, pose);
      const blend = (nowMs - this.fishPhaseChangedAtMs) / GATHER_TUNING.fishPhaseBlendMs;
      if (blend < 1) {
        sampleFishPhase(this.fishPreviousPhase, sinceCastMs, nowMs, this.gatherPoseB);
        lerpPose(this.gatherPoseB, pose, Math.max(0, blend), pose);
      }
      if (reduced) reducePose(pose, GATHER_PROGRAMS.fish_cast.hold);
    } else {
      const definition = GATHER_PROGRAMS[program];
      sampleProgram(definition, elapsedMs, cadence, pose);
      if (reduced) reducePose(pose, definition.hold);
    }
    // Blend from the rest pose by the (smoothed) ease amount.
    const w = smoothAmount(this.gatherAmount);
    const restTool = GATHER_TUNING.tool.restDegrees;
    pose.arm = REST_ARM_DEGREES + (pose.arm - REST_ARM_DEGREES) * w;
    pose.bend *= w;
    pose.offBend *= w;
    pose.tool = restTool + (pose.tool - restTool) * w;
    pose.offArm = Number.isNaN(pose.offArm)
      ? REST_ARM_DEGREES
      : REST_ARM_DEGREES + (pose.offArm - REST_ARM_DEGREES) * w;
    pose.lean *= w;
    pose.squash *= w;
    pose.lift *= w;
    return pose;
  }

  private applyGather(pose: GatherPose): void {
    const sign = this.gatherSign;
    const armsMove = this.gatherRigBuilt && !this.gatherRigFailed;
    const program = this.gatherProgram;
    const rig = this.armRig;
    const geometry = this.armGeometry;
    if (armsMove && rig && program !== null && program !== "flag") {
      rig.setBodyScale(1 + pose.squash * 0.5, 1 - pose.squash);
      rig.pose(geometry, -sign, pose.offArm, pose.offBend, this.gatherPointB);
      rig.pose(geometry, sign, pose.arm, pose.bend, this.gatherPoint);
    } else {
      // Arms could not be cut: they stay at rest and the tool sits in the rest fist.
      this.gatherPoint.x = sideX(geometry, geometry.fistX, sign);
      this.gatherPoint.y = geometry.fistY;
    }
    const w = smoothAmount(this.gatherAmount);
    this.fadeGatherHidden(w);
    const toolTexture = this.gatherToolTexture;
    let tool = this.gatherToolSprite;
    // The held tool sits over the fist, in the hands layer (in front of the torso and arms).
    const toolParent = this.layers.hands;
    if (toolTexture) {
      if (!tool) {
        tool = new Sprite(toolTexture);
        this.gatherToolSprite = tool;
        toolParent.addChild(tool);
      }
      if (tool.texture !== toolTexture) tool.texture = toolTexture;
      if (tool.parent !== toolParent) toolParent.addChild(tool);
      const tuning = this.toolTuning();
      const scale = tuning.scale * 1024 / (toolTexture.width || 1024);
      tool.anchor.set(tuning.gripX, tuning.gripY);
      tool.scale.set(sign * scale, scale);
      tool.position.set(this.gatherPoint.x, this.gatherPoint.y);
      tool.rotation = toolRotation(pose.tool, sign);
      tool.alpha = w;
      tool.visible = true;
    } else if (tool) {
      tool.visible = false;
    }
    this.applyGatherLine(w);
    this.applyGatherBody(sign, pose.lean, pose.squash, pose.lift);
  }

  /** Fades the equipped weapon/shield out while an action plays. */
  private fadeGatherHidden(w: number): void {
    const hidden = this.gatherHidden;
    for (let index = 0; index < hidden.length; index += 1) {
      const entry = hidden[index]!;
      entry.sprite.alpha = entry.alpha * (1 - w);
    }
  }

  /** Whole-body lean (degrees toward the action side), squash and lift, pivoting at the feet. */
  private applyGatherBody(sign: number, lean: number, squash: number, lift: number): void {
    const root = this.visualRoot;
    const scale = this.overallScale;
    // "+ 0" turns -0 into 0 so the rest state compares exactly equal.
    root.rotation = sign * lean * Math.PI / 180 + 0;
    root.scale.set(scale * (1 + squash * 0.5), scale * (1 - squash));
    root.position.set(0, 0 - lift * scale);
    this.gatherBodyApplied = true;
  }

  /**
   * Flag building: body motion, both arms bent through the rig, the flag pole
   * held in the build-side fist (rammed into the ground) and impact dust.
   */
  private updateFlagBuild(
    nowMs: number,
    elapsedMs: number,
    cadence: number,
    reduced: boolean,
    acting: boolean
  ): void {
    const sign = this.gatherSign;
    const rig = this.ensureFlagRig();
    const arms = this.armRig!;
    const pose = sampleFlagBuild(elapsedMs, cadence, this.flagPose);
    if (reduced) reduceFlagBuildPose(pose);
    const w = smoothAmount(this.gatherAmount);
    scaleFlagBuildPose(pose, w);
    this.fadeGatherHidden(w);
    // Body first: the pole follows the fist through the visualRoot transform.
    this.applyGatherBody(sign, pose.lean, pose.squash, pose.lift);
    const fist = this.gatherPoint;
    if (this.gatherRigBuilt && !this.gatherRigFailed) {
      arms.setBodyScale(1 + pose.squash * 0.5, 1 - pose.squash);
      arms.pose(this.armGeometry, -sign, REST_ARM_DEGREES + pose.offArm, pose.offBend, this.gatherPointB);
      arms.pose(this.armGeometry, sign, REST_ARM_DEGREES + pose.arm, pose.bend, fist);
    } else {
      ArmRig.fist(this.armGeometry, sign, REST_ARM_DEGREES + pose.arm, pose.bend, fist);
    }
    this.visualToRoot(fist.x, fist.y, fist);
    if (this.walkProfileDirty) this.refreshWalkProfile();
    const scale = this.overallScale;
    const groundLayerY = this.walkProfile.groundY;
    // Grip height that leaves the pole base just under the ground in the neutral hold.
    const hold = FLAG_BUILD_PROGRAM.hold;
    const neutralFistY = ArmRig.fist(
      this.armGeometry, sign, REST_ARM_DEGREES + hold.arm, hold.bend, this.gatherPointB
    ).y;
    const tuning = FLAG_BUILD_TUNING;
    rig.placeFlag({
      gripX: fist.x,
      gripY: fist.y,
      groundY: (groundLayerY - this.visualRoot.pivot.y) * scale,
      gripToBase: (groundLayerY - neutralFistY + tuning.flag.restSinkUnits) * scale,
      unitScale: scale,
      tilt: sign * pose.tilt * Math.PI / 180,
      sign,
      cloth: pose.cloth,
      flutter: w * (reduced ? tuning.reducedCloth : 1),
      nowMs,
      alpha: w
    });
    if (
      acting &&
      !reduced &&
      !this.flagImpactsExternal &&
      this.gatherAmount >= 0.9 &&
      !Number.isNaN(this.gatherLastElapsedMs) &&
      impactsBetween(FLAG_BUILD_PROGRAM, cadence, this.gatherLastElapsedMs, elapsedMs) > 0
    ) {
      this._gatherImpactCount += 1;
      rig.spawnImpact(sign, this.gatherImpactOrigin);
    }
  }

  private applyGatherLine(alpha: number): void {
    const tool = this.gatherToolSprite;
    let line = this.gatherLineSprite;
    if (
      this.gatherProgram !== "fish" ||
      !this.gatherLineTargetSet ||
      !tool ||
      !tool.visible ||
      this.fishPhase === "ready" ||
      this.fishSinceCastMs < GATHER_TUNING.fish.castMs * GATHER_TUNING.fish.lineAt
    ) {
      if (line) line.visible = false;
      return;
    }
    if (!line) {
      line = new Sprite(Texture.WHITE);
      line.anchor.set(0, 0.5);
      line.tint = 0xe7dcc2;
      this.gatherLineSprite = line;
      this.layers.effects.addChild(line);
    }
    const from = this.gatherPointB;
    const tipTuning = this.toolTuning();
    this.toolPoint(tool, tipTuning.tipX, tipTuning.tipY, from);
    const toX = this.gatherLineTarget.x;
    const toY = this.gatherLineTarget.y;
    const to = this.gatherPoint;
    this.rootToVisual(toX, toY, to);
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    line.position.set(from.x, from.y);
    line.rotation = Math.atan2(dy, dx);
    line.width = Math.sqrt(dx * dx + dy * dy);
    line.height = 0.45;
    line.alpha = 0.85 * alpha;
    line.visible = true;
  }

  /** Grip/head/tip/scale of the held tool template for the running program. */
  private toolTuning(): (typeof GATHER_TUNING.tools)["chop" | "mine" | "fish"] {
    const program = this.gatherProgram;
    return program === "fish" ? GATHER_TUNING.tools.fish : program === "mine" ? GATHER_TUNING.tools.mine : GATHER_TUNING.tools.chop;
  }

  /** visualRoot-local position of a normalized texture point of the tool sprite. */
  private toolPoint(sprite: Sprite, u: number, v: number, out: MutablePoint): MutablePoint {
    const texture = sprite.texture;
    const lx = (u - sprite.anchor.x) * texture.width * sprite.scale.x;
    const ly = (v - sprite.anchor.y) * texture.height * sprite.scale.y;
    const c = Math.cos(sprite.rotation);
    const s = Math.sin(sprite.rotation);
    out.x = sprite.position.x + c * lx - s * ly;
    out.y = sprite.position.y + s * lx + c * ly;
    return out;
  }

  private visualToRoot(x: number, y: number, out: MutablePoint): MutablePoint {
    const root = this.visualRoot;
    const lx = (x - root.pivot.x) * root.scale.x;
    const ly = (y - root.pivot.y) * root.scale.y;
    const c = Math.cos(root.rotation);
    const s = Math.sin(root.rotation);
    out.x = root.position.x + c * lx - s * ly;
    out.y = root.position.y + s * lx + c * ly;
    return out;
  }

  private rootToVisual(x: number, y: number, out: MutablePoint): MutablePoint {
    const root = this.visualRoot;
    const dx = x - root.position.x;
    const dy = y - root.position.y;
    const c = Math.cos(-root.rotation);
    const s = Math.sin(-root.rotation);
    out.x = root.pivot.x + (c * dx - s * dy) / (root.scale.x || 1);
    out.y = root.pivot.y + (s * dx + c * dy) / (root.scale.y || 1);
    return out;
  }

  private spawnGatherParticles(program: Exclude<GatherProgramId, "fish" | "flag">): void {
    const config = GATHER_TUNING.particles[program];
    let layer = this.gatherParticleLayer;
    if (!layer) {
      layer = new Container();
      this.gatherParticleLayer = layer;
      this.root.addChild(layer);
      for (let index = 0; index < GATHER_TUNING.particles.poolSize; index += 1) {
        const sprite = new Sprite(Texture.WHITE);
        sprite.anchor.set(0.5);
        sprite.visible = false;
        layer.addChild(sprite);
        this.gatherParticles.push({
          sprite, x: 0, y: 0, vx: 0, vy: 0, spin: 0, ageMs: 0, lifeMs: 0
        });
      }
    }
    const sign = this.gatherSign;
    const origin = this.gatherPointB;
    const tool = this.gatherToolSprite;
    const bareHands = !(tool && tool.visible);
    if (tool && tool.visible) {
      const headTuning = this.toolTuning();
      this.toolPoint(tool, headTuning.headX, headTuning.headY, origin);
    } else if (this.armRig && this.gatherRigBuilt && !this.gatherRigFailed) {
      // Bare hands: chips fly from just past the knuckles, never on top of the fist.
      // Harvest pieces pop off the plant the hand just let go of, further out.
      const reach = program === "harvest"
        ? GATHER_TUNING.particles.harvestReach
        : GATHER_TUNING.particles.knuckleReach;
      this.armRig.knuckles(this.armGeometry, sign, reach, origin);
    } else {
      origin.x = this.gatherPoint.x;
      origin.y = this.gatherPoint.y;
    }
    this.visualToRoot(origin.x, origin.y, origin);
    if (this.gatherImpactOrigin) {
      // A sprite-sheet body (Jacket B) draws the tool elsewhere: chips fly from its tool head.
      origin.x = this.gatherImpactOrigin.x;
      origin.y = this.gatherImpactOrigin.y;
    }
    const scale = this.overallScale;
    let spawned = 0;
    for (let index = 0; index < this.gatherParticles.length && spawned < config.count; index += 1) {
      const particle = this.gatherParticles[index]!;
      if (particle.ageMs < particle.lifeMs) continue;
      const spark = program === "mine" && spawned === config.count - 1;
      const speed = config.speed * scale * (spark ? 1.8 : 0.6 + 0.8 * Math.random());
      // Tool chips spray back toward the player; bare-hand chips spray off the
      // far side of the target so they never cross the fist.
      const dirX = (bareHands ? sign : -sign) * (0.25 + 0.75 * Math.random());
      const dirY = -(0.35 + 0.85 * Math.random());
      const length = Math.sqrt(dirX * dirX + dirY * dirY);
      particle.x = origin.x;
      particle.y = origin.y;
      particle.vx = dirX / length * speed;
      particle.vy = dirY / length * speed;
      particle.spin = (Math.random() - 0.5) * 0.04;
      particle.ageMs = 0;
      particle.lifeMs = GATHER_TUNING.particles.lifeMs * (spark ? 0.45 : 0.7 + 0.5 * Math.random());
      const size = config.size * scale * (spark ? 0.7 : 0.7 + 0.6 * Math.random());
      const sprite = particle.sprite;
      sprite.tint = spark ? 0xffd36b : config.colors[spawned % config.colors.length]!;
      sprite.width = size * (spark ? 1.6 : 1.3);
      sprite.height = size;
      sprite.rotation = Math.random() * Math.PI;
      sprite.position.set(particle.x, particle.y);
      sprite.alpha = 1;
      sprite.visible = true;
      spawned += 1;
      this.gatherParticlesAlive += 1;
    }
  }

  private updateGatherParticles(dtMs: number): void {
    const gravity = GATHER_TUNING.particles.gravity * this.overallScale;
    let alive = 0;
    for (let index = 0; index < this.gatherParticles.length; index += 1) {
      const particle = this.gatherParticles[index]!;
      if (particle.ageMs >= particle.lifeMs) continue;
      particle.ageMs += dtMs;
      const sprite = particle.sprite;
      if (particle.ageMs >= particle.lifeMs) {
        sprite.visible = false;
        continue;
      }
      particle.vy += gravity * dtMs;
      particle.x += particle.vx * dtMs;
      particle.y += particle.vy * dtMs;
      sprite.position.set(particle.x, particle.y);
      sprite.rotation += particle.spin * dtMs;
      const fade = particle.ageMs / particle.lifeMs;
      sprite.alpha = fade < 0.6 ? 1 : 1 - (fade - 0.6) / 0.4;
      alive += 1;
    }
    this.gatherParticlesAlive = alive;
  }

  /** Splits the arm-covering sprites and hides the equipped weapon/shield. */
  private rebuildGatherRig(): void {
    this.teardownGatherRig();
    this.gatherRigDirty = false;
    this.gatherRigBuilt = true;
    const signs = this.gatherRigSigns;
    signs.length = 0;
    signs.push(this.gatherSign);
    const program = this.gatherProgram;
    // Both arms are always cut: the off arm moves too (balance, guards).
    signs.push(-this.gatherSign);
    for (const [key, entry] of this.sprites) {
      const category = appearanceCategory(this.catalog, entry.appearanceId);
      if (category !== "weapon" && category !== "shield") continue;
      const heldSide = entry.sprite.position.x < this.armGeometry.centerX ? -1 : 1;
      if (this.swingVariant && (category === "weapon" || heldSide === -this.gatherSign)) {
        // A swing keeps the equipped weapon (and a shield on the off-arm side) in view and moves it with the arm.
        this.swingHeld.push({
          kind: category === "weapon" ? "weapon" : "shield",
          sprite: entry.sprite,
          gem: this.gemSprites.get(key) ?? null,
          appearanceId: entry.appearanceId,
          partId: entry.partId,
          featurePoint: entry.featurePoint,
          side: heldSide,
          baseX: entry.sprite.position.x,
          baseY: entry.sprite.position.y,
          baseRotation: entry.sprite.rotation,
          baseScaleX: entry.sprite.scale.x
        });
        continue;
      }
      this.gatherHidden.push({ sprite: entry.sprite, alpha: entry.sprite.alpha });
      const gem = this.gemSprites.get(key);
      if (gem) this.gatherHidden.push({ sprite: gem, alpha: gem.alpha });
    }
    this.gatherRigFailed = !this.cutGatherArms(signs);
    if (this.gatherToolSprite) {
      this.layers.hands.addChild(this.gatherToolSprite);
    }
  }

  /**
   * Cuts (or takes from the cutter's cache) every arm-covering sprite for
   * the given sides. False, with nothing held, when any cut fails.
   */
  private collectArmCuts(signs: readonly number[], pieces: GatherRigPiece[]): boolean {
    if (!(this.body instanceof LegMesh) && !(this.body instanceof Sprite)) return false;
    // Arm geometry follows the live body placement (catalog transforms may change).
    armGeometryForBody(
      gatherPlacement(this.body),
      this.body.texture.width,
      this.body.texture.height,
      this.armGeometry
    );
    const geometry = this.armGeometry;
    const scratch: number[] = [];
    const start = pieces.length;
    for (const layerName of ARM_COVERING_LAYERS) {
      for (const child of this.layers[layerName].children) {
        if (child === this.gatherToolSprite || !child.visible) continue;
        if (!(child instanceof LegMesh) && !(child instanceof Sprite)) continue;
        const texture = child.texture;
        if (!texture || texture === Texture.EMPTY) continue;
        const placement = gatherPlacement(child);
        if (!armOverlapsTexture(geometry, placement, texture, signs, scratch)) continue;
        const cut = this.armCutter(texture, placement, signs, geometry);
        if (!cut) {
          for (const piece of pieces.splice(start)) this.armCutRelease(piece.cut);
          return false;
        }
        pieces.push({ source: child, original: texture, cut });
      }
    }
    return true;
  }

  /**
   * Local player: cut the arms once the art is in and the browser is idle,
   * so the first gather of a session takes the cuts from the cache instead
   * of stalling a frame to make them (the cut reads pixels back from canvas).
   */
  private schedulePrewarm(): void {
    this.cancelPrewarm();
    if (!this.local) return;
    const run = (): void => {
      this.prewarmHandle = null;
      if (this.root.destroyed || this.gatherActive) return;
      if (this.walkActive) {
        this.schedulePrewarm();
        return;
      }
      const pieces: GatherRigPiece[] = [];
      if (!this.collectArmCuts([1, -1], pieces)) return;
      for (const piece of pieces) this.prewarmedCuts.push(piece.cut);
    };
    const idle = globalThis as unknown as {
      requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
      cancelIdleCallback?: (handle: number) => void;
    };
    if (typeof idle.requestIdleCallback === "function") {
      const handle = idle.requestIdleCallback(run, { timeout: PREWARM_TIMEOUT_MS });
      this.prewarmHandle = { cancel: () => idle.cancelIdleCallback?.(handle) };
    } else {
      const handle = setTimeout(run, PREWARM_FALLBACK_DELAY_MS);
      this.prewarmHandle = { cancel: () => clearTimeout(handle) };
    }
  }

  private cancelPrewarm(): void {
    this.prewarmHandle?.cancel();
    this.prewarmHandle = null;
    for (const cut of this.prewarmedCuts) this.armCutRelease(cut);
    this.prewarmedCuts.length = 0;
  }

  private cutGatherArms(signs: readonly number[]): boolean {
    const pieces = this.gatherRigPieces;
    if (!this.collectArmCuts(signs, pieces)) return false;
    const geometry = this.armGeometry;
    // Every piece becomes a bendable mesh on the shared arm rig.
    const rig = this.ensureArmRig();
    for (const piece of pieces) {
      const layer = piece.source.parent;
      if (!layer) continue;
      const placement = gatherPlacement(piece.source);
      piece.source.texture = piece.cut.armless;
      const sourceIndex = layer.getChildIndex(piece.source);
      for (let index = 0; index < signs.length; index += 1) {
        rig.attach(
          geometry,
          piece.cut.pieces[index]!,
          piece.cut.pieceSeams?.[index] ?? null,
          piece.cut.caps?.[index] ?? null,
          piece.cut.seams?.[index] ?? null,
          placement,
          signs[index]!,
          piece.source.tint,
          layer,
          sourceIndex
        );
      }
    }
    return true;
  }

  private teardownGatherRig(): void {
    for (const piece of this.gatherRigPieces) {
      if (!piece.source.destroyed && piece.source.texture === piece.cut.armless) {
        piece.source.texture = piece.original;
      }
      this.armCutRelease(piece.cut);
    }
    this.gatherRigPieces.length = 0;
    this.armRig?.detach();
    for (const entry of this.gatherHidden) {
      if (!entry.sprite.destroyed) entry.sprite.alpha = entry.alpha;
    }
    this.gatherHidden.length = 0;
    this.restoreSwingHeld();
    this.gatherRigBuilt = false;
    this.gatherRigFailed = false;
  }

  /** Restores the exact rest state; keeps frames only while particles finish. */
  private resetGatherPose(): void {
    this.teardownGatherRig();
    if (this.gatherToolSprite) this.gatherToolSprite.visible = false;
    if (this.gatherLineSprite) this.gatherLineSprite.visible = false;
    this.flagRig?.hideFlag();
    if (this.gatherBodyApplied) {
      this.gatherBodyApplied = false;
      if (this.currentPose !== "downed") {
        this.visualRoot.rotation = 0;
        this.visualRoot.position.set(0, 0);
      }
      this.visualRoot.scale.set(this.overallScale);
    }
    this.gatherAmount = 0;
    if (!this.gatherAction) this.gatherProgram = null;
    this.gatherRigDirty = false;
    this.gatherActive = this.gatherParticlesAlive > 0 || this.flagRig?.effectsAlive === true;
    if (!this.gatherActive) this.gatherLastMs = -1;
  }

  private refreshWalkProfile(): void {
    const anchors = playerBodyPose(
      this.catalog,
      this.currentBodyVariantId,
      this.currentPose
    ).anchors;
    const profile = this.walkProfile;
    const footY = Math.max(anchors.left_foot.y, anchors.right_foot.y);
    profile.hipY = anchors.legs.y +
      (footY - anchors.legs.y) * WALK_TUNING.hipRampStart;
    profile.groundY = Math.max(
      footY,
      playerMainAnchor(this.catalog, this.currentBodyVariantId).y
    );
    profile.centerX = (anchors.left_foot.x + anchors.right_foot.x) / 2;
    profile.frontHandX = anchors.right_hand.x;
    profile.frontHandY = anchors.right_hand.y;
    profile.rearHandX = anchors.left_hand.x;
    profile.rearHandY = anchors.left_hand.y;
    this.walkProfileDirty = false;
  }

  private createLayerSprite(texture: Texture, deformable: boolean): Sprite {
    if (!deformable) return new Sprite(texture);
    const mesh = new LegMesh(texture);
    this.legMeshes.push(mesh);
    // LegMesh provides the Sprite surface the appearance code uses.
    return mesh as unknown as Sprite;
  }

  private untrackSprite(object: unknown): void {
    const index = this.legMeshes.indexOf(object as LegMesh);
    if (index >= 0) this.legMeshes.splice(index, 1);
  }

  setCatalog(catalog: PlayerAppearanceCatalog): void {
    this.catalog = catalog;
    this.walkProfileDirty = true;
    this.visualRoot.scale.set(this.overallScale);
    this.applyMainAnchor();
  }

  setPose(poseId: PlayerCombatPoseId): boolean {
    if (poseId === this.currentPose) return false;
    if (poseId === "downed" && this.walkActive) this.resetWalkPose();
    if (poseId === "downed" && this.gatherActive) {
      this.gatherAction = null;
      this.resetGatherPose();
    }
    this.gatherRigDirty = true;
    this.currentPose = poseId;
    this.walkProfileDirty = true;
    this.visualRoot.rotation = poseId === "downed" ? Math.PI / 2 : 0;
    this.visualRoot.position.set(
      poseId === "downed" ? -this.baseHeightPx * 0.35 : 0,
      poseId === "downed" ? -4 : 0
    );
    void this.updateTemplateAssets(
      this.currentBodyVariantId,
      poseId,
      this.currentSkinToneId
    );
    for (const [key, current] of this.sprites) {
      const transform = applyAppearanceTransform(
        current.sprite,
        this.catalog,
        current.appearanceId,
        poseId,
        this.currentBodyVariantId,
        current.partId,
        current.featurePoint
      );
      if (current.sprite.parent !== this.layers[transform.layer]) {
        this.layers[transform.layer].addChild(current.sprite);
      }
      applyEnhancementTint(current.sprite, this.catalog, current.appearanceId, current.enhancement);
      const gem = this.gemSprites.get(key);
      if (gem) {
        this.layers[transform.layer].addChild(gem);
        applyGemTransform(
          gem,
          current.sprite,
          this.catalog,
          current.appearanceId,
          current.partId
        );
      }
    }
    // A pose change can invalidate an in-flight appearance commit; retry the
    // same snapshot so startup cannot leave equipment absent until a later update.
    if (!this._appearanceComplete) {
      void this.updateAppearance(
        this.lastAppearanceSnapshot,
        this.lastAppearanceRenderOptions
      );
    }
    return true;
  }

  async updateAppearance(
    snapshot: PlayerAppearanceSnapshot | undefined,
    options: PlayerAppearanceRenderOptions = {}
  ): Promise<boolean> {
    this.lastAppearanceSnapshot = snapshot;
    this.lastAppearanceRenderOptions = { ...options };
    const showGemstones = options.showGemstones ?? true;
    const skinToneId = options.skinToneId ??
      snapshot?.styles?.skinToneId ?? this.currentSkinToneId;
    const desired = snapshot ? desiredAppearances(this.catalog, snapshot) : new Map();
    const bodyVariantId = snapshot?.bodyVariantId ?? DEFAULT_PLAYER_BODY_VARIANT_ID;
    const poseId = this.currentPose;
    const bodyAssetKey = resolvedBodyAssetKey(
      this.catalog,
      bodyVariantId,
      poseId,
      skinToneId
    );
    const bodyTransform = playerTemplateTransform(
      this.catalog,
      bodyVariantId,
      poseId
    );
    const headAssetKey = playerHeadAssetKey(
      this.catalog,
      bodyVariantId,
      poseId,
      skinToneId
    );
    const templateIdentity = templateAssetIdentity(
      bodyVariantId,
      bodyAssetKey,
      bodyTransform,
      headAssetKey
    );
    const signature = `gems:${showGemstones ? "visible" : "hidden"}|` + [...desired.entries()]
      .map(([key, part]) => [
        key,
        part.appearance.appearanceId,
        part.partId,
        enhancementPresentationIdentity(this.catalog, part),
        part.featurePoint ? `${part.featurePoint.x},${part.featurePoint.y}` : "placed"
      ].join(":"))
      .sort()
      .join("|");
    if (
      snapshot &&
      snapshot.revision === this._appearanceRevision &&
      signature === this.appearanceSignature &&
      templateIdentity === this.templateRequestIdentity &&
      this._appearanceComplete
    ) {
      return false;
    }
    if (this.textureRetryNotBeforeMs > Date.now()) return false;
    const generation = ++this.updateGeneration;
    const templateGeneration = ++this.templateUpdateGeneration;
    this._appearanceRevision = snapshot?.revision ?? -1;
    this.appearanceSignature = signature;
    this._appearanceBuildCount += 1;
    this._appearanceComplete = false;

    try {
      const templateAssetsPromise = templateIdentity === this.templateRequestIdentity
        ? Promise.resolve(null)
        : !bodyAssetKey || !this.textureLoader
          ? Promise.resolve(null)
          : Promise.all([
              this.textureLoader.load(bodyAssetKey),
              headAssetKey ? this.textureLoader.load(headAssetKey) : null
            ]).then(([body, head]) => ({ body, head })).catch((error: unknown) => {
              this.emitDiagnosticOnce(
                `body:${bodyAssetKey}:${headAssetKey ?? ""}`,
                "Player template texture could not be loaded.",
                { assetKey: bodyAssetKey, error }
              );
              throw error;
            });
      const loadedSpritesPromise = Promise.all(
        [...desired.entries()].map(async ([key, part]) => {
          const current = this.sprites.get(key);
          if (
            current?.appearanceId === part.appearance.appearanceId &&
            current?.partId === part.partId
          ) {
            return { key, part, texture: null };
          }
          if (!this.textureLoader) return { key, part, texture: null };
          try {
            return {
              key,
              part,
              texture: await this.textureLoader.load(part.assetKey)
            };
          } catch (error) {
            this.emitDiagnosticOnce(
              `appearance:${part.appearance.appearanceId}:${part.assetKey}`,
              "Player appearance texture could not be loaded.",
              {
                appearanceId: part.appearance.appearanceId,
                assetKey: part.assetKey,
                error
              }
            );
            throw error;
          }
        })
      );
      const loadedGemsPromise = Promise.all(
        [...desired.entries()].map(async ([key, part]) => {
          if (!showGemstones) return { key, texture: null };
          const assetKey = enhancementGemAssetKey(this.catalog, part);
          if (!assetKey || !this.textureLoader) return { key, texture: null };
          try {
            return { key, texture: await this.textureLoader.load(assetKey) };
          } catch (error) {
            this.emitDiagnosticOnce(
              `gem:${part.enhancement?.gemstone ?? "unknown"}:${assetKey}`,
              "Equipment gemstone texture could not be loaded.",
              { assetKey, appearanceId: part.appearance.appearanceId, error }
            );
            return { key, texture: null };
          }
        })
      );
      const [templateAssets, loadedSprites, loadedGems] = await Promise.all([
        templateAssetsPromise,
        loadedSpritesPromise,
        loadedGemsPromise
      ]);
      if (
        generation !== this.updateGeneration ||
        templateGeneration !== this.templateUpdateGeneration ||
        poseId !== this.currentPose
      ) {
        return false;
      }

      this.currentBodyVariantId = bodyVariantId;
      this.currentSkinToneId = skinToneId;
      this.walkProfileDirty = true;
      this.visualRoot.scale.set(this.overallScale);
      this.applyMainAnchor();
      if (templateAssets) {
        this.installTemplateBody(templateAssets.body, bodyTransform, templateAssets.head);
        this.templateRequestIdentity = templateIdentity;
      } else if (templateIdentity !== this.templateRequestIdentity) {
        this.installProceduralBody(bodyTransform);
        this.removeHeadSprite();
        this.templateRequestIdentity = templateIdentity;
      }

      for (const [key, current] of this.sprites) {
        const next = desired.get(key);
        if (
          next?.appearance.appearanceId === current.appearanceId &&
          next.partId === current.partId
        ) {
          current.enhancement = next.enhancement;
          current.featurePoint = next.featurePoint;
          const transform = applyAppearanceTransform(
            current.sprite,
            this.catalog,
            current.appearanceId,
            poseId,
            bodyVariantId,
            current.partId,
            current.featurePoint
          );
          if (current.sprite.parent !== this.layers[transform.layer]) {
            this.layers[transform.layer].addChild(current.sprite);
          }
          applyEnhancementTint(
            current.sprite,
            this.catalog,
            current.appearanceId,
            current.enhancement
          );
          continue;
        }
        const gem = this.gemSprites.get(key);
        if (gem) {
          gem.removeFromParent();
          gem.destroy();
          this.gemSprites.delete(key);
        }
        this.untrackSprite(current.sprite);
        current.sprite.removeFromParent();
        current.sprite.destroy();
        this.sprites.delete(key);
      }
      for (const { key, part, texture } of loadedSprites) {
        if (!texture) continue;
        const sprite = this.createLayerSprite(
          texture,
          LEG_COVERING_LAYERS.has(resolveAppearanceLocalTransform(
            this.catalog,
            part.appearance.appearanceId,
            poseId,
            bodyVariantId,
            part.partId
          ).layer)
        );
        const transform = applyAppearanceTransform(
          sprite,
          this.catalog,
          part.appearance.appearanceId,
          poseId,
          bodyVariantId,
          part.partId,
          part.featurePoint
        );
        this.layers[transform.layer].addChild(sprite);
        applyEnhancementTint(
          sprite,
          this.catalog,
          part.appearance.appearanceId,
          part.enhancement
        );
        this.sprites.set(key, {
          appearanceId: part.appearance.appearanceId,
          partId: part.partId,
          sprite,
          enhancement: part.enhancement,
          featurePoint: part.featurePoint
        });
      }
      const gemTextures = new Map(loadedGems.map(({ key, texture }) => [key, texture]));
      for (const [key, gem] of this.gemSprites) {
        if (!gemTextures.get(key) || !this.sprites.has(key)) {
          gem.removeFromParent();
          gem.destroy();
          this.gemSprites.delete(key);
        }
      }
      for (const [key, texture] of gemTextures) {
        if (!texture) continue;
        const current = this.sprites.get(key);
        if (!current) continue;
        let gem = this.gemSprites.get(key);
        if (!gem) {
          gem = new Sprite(texture);
          this.gemSprites.set(key, gem);
        } else {
          gem.texture = texture;
        }
        const transform = resolveAppearanceLocalTransform(
          this.catalog,
          current.appearanceId,
          poseId,
          bodyVariantId,
          current.partId
        );
        this.layers[transform.layer].addChild(gem);
        applyGemTransform(
          gem,
          current.sprite,
          this.catalog,
          current.appearanceId,
          current.partId
        );
      }
      this._appearanceComplete = true;
      this.textureFailures = 0;
      this.gatherRigDirty = true;
      this.schedulePrewarm();
      return true;
    } catch {
      if (
        generation === this.updateGeneration &&
        templateGeneration === this.templateUpdateGeneration
      ) {
        // The constructor's procedural body or the last complete appearance
        // remains usable. Missing optional art is degraded, not a permanent
        // presentation failure. The request is forgotten so a later update retries the load (a failed load used to
        // leave the mannequin until the identity changed).
        this._appearanceComplete = true;
        this.noteTextureFailure();
        this.appearanceSignature = "";
        this.templateRequestIdentity = "";
      }
      return true;
    }
  }

  destroy(): void {
    this.updateGeneration += 1;
    this.templateUpdateGeneration += 1;
    this.sprites.clear();
    this.gemSprites.clear();
    this.legMeshes.length = 0;
    this.walkActive = false;
    this.gatherAction = null;
    this.gatherToolGeneration += 1;
    this.teardownGatherRig();
    this.cancelPrewarm();
    this.flagRig?.destroy();
    this.flagRig = null;
    this.armRig?.destroy();
    this.armRig = null;
    this.gatherActive = false;
    this.root.destroy({ children: true });
  }

  private async updateTemplateAssets(
    bodyVariantId: PlayerBodyVariantId,
    poseId: PlayerCombatPoseId,
    skinToneId: PlayerSkinToneId = this.currentSkinToneId
  ): Promise<void> {
    const bodyAssetKey = resolvedBodyAssetKey(
      this.catalog,
      bodyVariantId,
      poseId,
      skinToneId
    );
    const bodyTransform = playerTemplateTransform(
      this.catalog,
      bodyVariantId,
      poseId
    );
    const headAssetKey = playerHeadAssetKey(
      this.catalog,
      bodyVariantId,
      poseId,
      skinToneId
    );
    const identity = templateAssetIdentity(
      bodyVariantId,
      bodyAssetKey,
      bodyTransform,
      headAssetKey
    );
    if (identity === this.templateRequestIdentity) return;
    if (this.textureRetryNotBeforeMs > Date.now()) return;
    this.templateRequestIdentity = identity;
    const generation = ++this.templateUpdateGeneration;
    if (!bodyAssetKey || !this.textureLoader) {
      this.installProceduralBody(bodyTransform);
      this.removeHeadSprite();
      return;
    }
    try {
      const [bodyTexture, headTexture] = await Promise.all([
        this.textureLoader.load(bodyAssetKey),
        headAssetKey ? this.textureLoader.load(headAssetKey) : null
      ]);
      if (generation !== this.templateUpdateGeneration) return;
      this.installTemplateBody(bodyTexture, bodyTransform, headTexture);
    } catch (error) {
      if (generation !== this.templateUpdateGeneration) return;
      this.emitDiagnosticOnce(
        `body:${bodyAssetKey}:${headAssetKey ?? ""}`,
        "Player template texture could not be loaded; using the procedural mannequin.",
        { assetKey: bodyAssetKey, error }
      );
      this.installProceduralBody(bodyTransform);
      this.removeHeadSprite();
      this.noteTextureFailure();
      this.templateRequestIdentity = "";
    }
  }

  private noteTextureFailure(): void {
    this.textureFailures += 1;
    this.textureRetryNotBeforeMs = Date.now() + Math.min(30_000, 2_000 * 2 ** Math.min(this.textureFailures - 1, 4));
  }

  private applyMainAnchor(): void {
    const anchor = playerMainAnchor(this.catalog, this.currentBodyVariantId);
    this.visualRoot.pivot.set(anchor.x, anchor.y);
  }

  private installTemplateBody(
    texture: Texture,
    transform: PlayerTemplateTransform,
    headTexture: Texture | null = null
  ): void {
    const sprite = templateSprite(
      texture,
      transform,
      (bodyTexture) => this.createLayerSprite(bodyTexture, true)
    );
    this.untrackSprite(this.body);
    this.body.removeFromParent();
    this.body.destroy();
    this.body = sprite;
    this.layers.body.addChild(sprite);
    this.gatherRigDirty = true;
    this.removeHeadSprite();
    if (headTexture) {
      // Identical transform to the body: the head PNG shares the body canvas.
      const head = templateSprite(headTexture, transform);
      this.headSprite = head;
      // Below any other head-layer content, above chest armor/gloves/hands.
      this.layers.head.addChildAt(head, 0);
    }
  }

  private removeHeadSprite(): void {
    if (!this.headSprite) return;
    this.headSprite.removeFromParent();
    this.headSprite.destroy();
    this.headSprite = null;
  }

  private installProceduralBody(
    transform: PlayerTemplateTransform = {
      offsetX: 0,
      offsetY: 0,
      scale: 1
    }
  ): void {
    this.untrackSprite(this.body);
    this.body.removeFromParent();
    this.body.destroy();
    this.body = createProceduralPlayerBody({
      local: this.local,
      color: this.color
    });
    this.body.position.set(transform.offsetX, transform.offsetY);
    this.body.scale.set(transform.scale);
    this.layers.body.addChild(this.body);
    this.gatherRigDirty = true;
  }

  private emitDiagnosticOnce(
    key: string,
    message: string,
    detail: Readonly<{
      assetKey?: string;
      appearanceId?: string;
      error?: unknown;
    }>
  ): void {
    if (this.diagnosticsEmitted.has(key)) return;
    this.diagnosticsEmitted.add(key);
    this.diagnostic(message, detail);
  }
}

function smoothAmount(t: number): number {
  return t * t * (3 - 2 * t);
}

function gatherPlacement(child: Sprite | LegMesh): ArmCutPlacement {
  const texture = child.texture;
  if (child instanceof LegMesh) {
    return {
      x: child.position.x,
      y: child.position.y,
      scaleX: child.scale.x,
      scaleY: child.scale.y,
      rotation: child.rotation,
      pivotX: child.pivot.x,
      pivotY: child.pivot.y
    };
  }
  return {
    x: child.position.x,
    y: child.position.y,
    scaleX: child.scale.x,
    scaleY: child.scale.y,
    rotation: child.rotation,
    pivotX: child.anchor.x * texture.width,
    pivotY: child.anchor.y * texture.height
  };
}

/** Whether the arm polygon of any requested side lands inside the texture. */
function armOverlapsTexture(
  geometry: ArmGeometry,
  placement: ArmCutPlacement,
  texture: Texture,
  signs: readonly number[],
  scratch: number[]
): boolean {
  for (const sign of signs) {
    armPolygonInTexture(geometry, placement, sign, scratch);
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let index = 0; index < scratch.length; index += 2) {
      minX = Math.min(minX, scratch[index]!);
      maxX = Math.max(maxX, scratch[index]!);
      minY = Math.min(minY, scratch[index + 1]!);
      maxY = Math.max(maxY, scratch[index + 1]!);
    }
    if (maxX > 0 && maxY > 0 && minX < texture.width && minY < texture.height) return true;
  }
  return false;
}

function swayLayer(layer: Container, x: number, y: number, radians: number): void {
  layer.pivot.set(x, y);
  layer.position.set(x, y);
  layer.rotation = radians;
}

function approach(value: number, target: number, step: number): number {
  if (value < target) return Math.min(target, value + step);
  if (value > target) return Math.max(target, value - step);
  return value;
}

function templateSprite(
  texture: Texture,
  transform: PlayerTemplateTransform,
  create?: (texture: Texture) => Sprite
): Sprite {
  const sprite = create ? create(texture) : new Sprite(texture);
  sprite.anchor.set(0.5, 1);
  const height = texture.height || PLAYER_BASE_HEIGHT_PX;
  const scale = PLAYER_BASE_HEIGHT_PX / height * transform.scale;
  sprite.position.set(transform.offsetX, transform.offsetY);
  sprite.scale.set(scale);
  return sprite;
}

function resolvedBodyAssetKey(
  catalog: PlayerAppearanceCatalog,
  bodyVariantId: PlayerBodyVariantId,
  poseId: PlayerCombatPoseId,
  skinToneId: PlayerSkinToneId
): string | null {
  return playerSkinToneAssetKey(catalog, bodyVariantId, skinToneId) ??
    playerBodyAssetKey(catalog, bodyVariantId, poseId);
}

function templateAssetIdentity(
  bodyVariantId: PlayerBodyVariantId,
  bodyAssetKey: string | null,
  bodyTransform: PlayerTemplateTransform,
  headAssetKey: string | null = null
): string {
  return [
    bodyVariantId,
    bodyAssetKey ?? "procedural",
    headAssetKey ?? "no-head",
    bodyTransform.offsetX,
    bodyTransform.offsetY,
    bodyTransform.scale
  ].join(":");
}

export async function loadPixiTexture(url: string): Promise<Texture> {
  // Art-pack overrides are extensionless blob: URLs. Pixi finds no parser for
  // them (resolving null), and its fetch path is blocked by the native CSP, so
  // decode them through an <img>, which img-src already allows.
  const texture = url.startsWith("blob:")
    ? await new Promise<Texture>((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(Texture.from(image));
        image.onerror = () => reject(new Error(`Image could not be decoded: ${url}`));
        image.src = url;
      })
    : await Assets.load<Texture>(url);
  if (!texture) throw new Error(`Image has no texture parser: ${url}`);
  return texture;
}

export class PixiTextureCache implements PlayerTextureLoader {
  private readonly textures = new Map<string, Promise<Texture>>();

  constructor(private readonly resolveUrl: (assetKey: string) => string | null) {}

  load(assetKey: string): Promise<Texture> {
    const existing = this.textures.get(assetKey);
    if (existing) return existing;
    const url = this.resolveUrl(assetKey);
    if (!url) return Promise.reject(new Error(`Unknown appearance asset: ${assetKey}`));
    const loading: Promise<Texture> = loadPixiTexture(url).catch((error: unknown) => {
      if (this.textures.get(assetKey) === loading) {
        this.textures.delete(assetKey);
      }
      throw error;
    });
    this.textures.set(assetKey, loading);
    return loading;
  }

  clear(): void {
    this.textures.clear();
  }
}

export function applyAppearanceTransform(
  sprite: Pick<Sprite, "position" | "rotation" | "scale" | "anchor" | "visible">,
  catalog: PlayerAppearanceCatalog,
  appearanceId: AppearanceDefinitionId,
  poseId: PlayerCombatPoseId = "idle",
  bodyVariantId: PlayerBodyVariantId = DEFAULT_PLAYER_BODY_VARIANT_ID,
  partId: AppearancePartId = "main",
  featurePoint: PlayerAnchorPoint | null = null
): AppliedAppearanceTransform {
  const transform = resolveAppearanceLocalTransform(
    catalog,
    appearanceId,
    poseId,
    bodyVariantId,
    partId,
    featurePoint
  );
  const rotationRadians = transform.rotationDegrees * Math.PI / 180;
  sprite.position.set(transform.x, transform.y);
  sprite.rotation = rotationRadians;
  sprite.scale.set(transform.scaleX, transform.scaleY);
  sprite.anchor.set(transform.pivotX, transform.pivotY);
  sprite.visible = transform.visible;
  return { ...transform, rotationRadians };
}

export function applyGemTransform(
  gem: Sprite,
  equipment: Sprite,
  catalog: PlayerAppearanceCatalog,
  appearanceId: AppearanceDefinitionId,
  partId: AppearancePartId
): void {
  const socket = equipmentGemSocket(catalog, appearanceId);
  if (socket.partId !== partId) {
    gem.visible = false;
    return;
  }
  const localX = (socket.x - equipment.anchor.x) *
    equipment.texture.width * equipment.scale.x;
  const localY = (socket.y - equipment.anchor.y) *
    equipment.texture.height * equipment.scale.y;
  const cosine = Math.cos(equipment.rotation);
  const sine = Math.sin(equipment.rotation);
  gem.position.set(
    equipment.position.x + cosine * localX - sine * localY,
    equipment.position.y + sine * localX + cosine * localY
  );
  gem.anchor.set(0.5);
  gem.rotation = equipment.rotation;
  const sourceHeight = gem.texture.height || 1;
  const scale = catalog.enhancementPresentation.gemSizePx / sourceHeight;
  gem.scale.set(scale);
  gem.tint = 0xffffff;
  gem.visible = equipment.visible;
}

function applyEnhancementTint(
  sprite: Sprite,
  catalog: PlayerAppearanceCatalog,
  appearanceId: AppearanceDefinitionId,
  enhancement: EquipmentAppearanceEnhancement | null
): void {
  const hue = enhancement?.coreId && appearanceCategory(catalog, appearanceId) === "weapon"
    ? catalog.enhancementPresentation.coreHues[enhancement.coreId]
    : null;
  sprite.tint = hue ? Number.parseInt(hue.slice(1), 16) : 0xffffff;
}

function enhancementGemAssetKey(
  catalog: PlayerAppearanceCatalog,
  part: DesiredAppearancePart
): string | null {
  if (!part.enhancement) return null;
  const socket = equipmentGemSocket(catalog, part.appearance.appearanceId);
  if (socket.partId !== part.partId) return null;
  return catalog.enhancementPresentation.gemstoneAssetKeys[
    part.enhancement.gemstone
  ];
}

function enhancementPresentationIdentity(
  catalog: PlayerAppearanceCatalog,
  part: DesiredAppearancePart
): string {
  if (!part.enhancement) return "ordinary";
  const socket = equipmentGemSocket(catalog, part.appearance.appearanceId);
  const hue = part.enhancement.coreId
    ? catalog.enhancementPresentation.coreHues[part.enhancement.coreId]
    : "none";
  return [
    part.enhancement.gemstone,
    part.enhancement.coreId ?? "prepared",
    catalog.enhancementPresentation.gemstoneAssetKeys[part.enhancement.gemstone],
    catalog.enhancementPresentation.gemSizePx,
    socket.partId,
    socket.x,
    socket.y,
    hue
  ].join(":");
}

export function playerAnchorPoints(
  catalog: PlayerAppearanceCatalog = DEFAULT_PLAYER_APPEARANCE_CATALOG,
  bodyVariantId: PlayerBodyVariantId = "default",
  poseId = "idle"
) {
  return playerBodyPose(catalog, bodyVariantId, poseId).anchors;
}

type DesiredAppearancePart = {
  appearance: AppearanceDefinition;
  partId: AppearancePartId;
  assetKey: string;
  enhancement: EquipmentAppearanceEnhancement | null;
  /** Anchored face features only: the player's point (face-anchor local units). */
  featurePoint: PlayerAnchorPoint | null;
};

function desiredAppearances(
  catalog: PlayerAppearanceCatalog,
  snapshot: PlayerAppearanceSnapshot
): Map<string, DesiredAppearancePart> {
  const desired = new Map<string, DesiredAppearancePart>();
  const addAppearance = (
    key: string,
    appearance: AppearanceDefinition,
    enhancement: EquipmentAppearanceEnhancement | null = null,
    featurePoint: PlayerAnchorPoint | null = null
  ): void => {
    for (const part of appearanceAssetParts(appearance)) {
      desired.set(`${key}:${part.partId}`, {
        appearance,
        partId: part.partId,
        assetKey: part.assetKey,
        enhancement,
        featurePoint
      });
    }
  };
  for (const [slot, slotSnapshot] of Object.entries(snapshot.slots)) {
    if (!slotSnapshot) continue;
    const appearance = visibleAppearanceForSlot(catalog, slotSnapshot);
    if (appearance) addAppearance(slot, appearance, slotSnapshot.enhancement ?? null);
  }
  for (const categoryId of SALON_SELECTABLE_APPEARANCE_CATEGORY_IDS) {
    const appearanceId = categoryId === "eyes"
      ? snapshot.styles?.eyes ?? DEFAULT_PLAYER_FACE_APPEARANCE_ID
      : snapshot.styles?.[categoryId];
    if (!appearanceId) continue;
    const appearance = catalog.appearances.find(
      (candidate) => candidate.appearanceId === appearanceId
    );
    if (!appearance || salonAppearanceCategory(catalog, appearance) !== categoryId) {
      continue;
    }
    const featurePoint = appearance.featureAnchor && isFaceFeatureCategory(categoryId)
      ? resolveFaceFeaturePoint(catalog, categoryId, snapshot.styles?.featurePoints)
      : null;
    addAppearance(`style:${categoryId}`, appearance, null, featurePoint);
  }
  return desired;
}
