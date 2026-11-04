import middie from "@fastify/middie";
import { registerDungeonPlaytestRoutes } from "./dungeonPlaytestRoutes.js";
import fastifyStatic from "@fastify/static";
import {
  TERRITORY_STRUCTURE_CATALOG_RELATIVE_PATH,
  TERRITORY_PNG_ASSET_PATTERN,
  parseTerritoryStructureCatalog,
  territoryStructureValidationIssues,
  type TerritoryStructureCatalog,
  appearanceCompatibleWithEquipment,
  appearanceAssetParts,
  bossAppearanceAssetKeys,
  DEFAULT_BOSS_APPEARANCE_CATALOG,
  DEFAULT_EQUIPMENT_ENHANCEMENT_PRESENTATION,
  DEFAULT_PLAYER_APPEARANCE_CATALOG,
  INTERIOR_DATA_RELATIVE_DIR,
  EQUIPMENT_GAMEPLAY_FAMILIES,
  ITEM_VARIANT_CATALOG,
  PROGRESSION_ICON_REGISTRY,
  RUNTIME_PNG_ASSET_REGISTRY,
  isRuntimePngWorldObjectFixedKey,
  parseProgressionIconPresentationCatalog,
  parseRuntimePngPresentationCatalog,
  parseBossAppearanceCatalog,
  parseItemVariantCatalog,
  parsePlayerAppearanceCatalog,
  interiorCatalogValidationIssues,
  interiorIdPreservationIssues,
  interiorLibrarySchema,
  interiorRevisionIdentityIssues,
  interiorSpaceSchema,
  type InteriorLibrary,
  type InteriorSpace,
  type BossAppearanceCatalog,
  type DungeonCatalog,
  type ItemVariantCatalog,
  type PlayerAppearanceCatalog,
  type ProgressionIconPresentationCatalog,
  type RuntimePngPresentationCatalog
} from "@ash-atlas/shared";
import Fastify, {
  type FastifyInstance,
  type FastifyRequest
} from "fastify";
import { createHash, randomBytes } from "node:crypto";
import {
  access,
  copyFile,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  unlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type {
  TerritoryStructureInventory,
  TerritoryStructurePublishRequest,
  TerritoryStructurePublishResponse,
  ImportedAsset,
  InteriorCatalogSnapshot,
  InteriorSpacePublishRequest,
  InteriorSpacePublishResponse,
  RuntimeAsset,
  RuntimeAssetInbox,
  RuntimeAssetInboxImportResponse,
  RuntimeAssetInboxEntry,
  RuntimeAssetInventory,
  RuntimeAssetUsage,
  RuntimeAssetPublishRequest,
  RuntimeAssetPublishResponse,
  ProgressionIconInventory,
  ProgressionIconPublishRequest,
  ProgressionIconPublishResponse,
  StudioServerIdentity,
  StudioSession,
  StudioPublishRequest,
  StudioPublishResponse
} from "./bridgeTypes.js";
import {
  EQUIPMENT_ENHANCEMENT_CONTRACT_VERSION,
  EXPANDED_GEMSTONE_CONTRACT_VERSION,
  FACE_FEATURE_CONTRACT_VERSION,
  type AppearanceStudioDesktopController
} from "./desktopContracts.js";
import {
  loadDungeonCatalogFromInteriors,
  readDungeonInteriorFiles
} from "./dungeonInteriorStore.js";
import { interiorSnapshot, planInteriorSpaceWrites, withInteriorSpaces } from "./interiorCatalogStore.js";
import { validatePng } from "./pngValidation.js";
import { RemoteStudioConnection } from "./remoteConnection.js";
import {
  runtimeAssetMetadata,
  type RuntimeAssetMetadata
} from "./runtimeAssetCatalog.js";
import { inspectWorkspace } from "./workspaceSafety.js";
import {
  DEFAULT_ATLAS_PNG_SOURCE_DIRECTORY,
  discoverAtlasPngSourceAssets
} from "./atlasPngInbox.js";

export const APPEARANCE_STUDIO_HOST = "127.0.0.1";
export const APPEARANCE_STUDIO_PORT = 5285;
export const APPEARANCE_CATALOG_RELATIVE_PATH =
  "packages/shared/src/data/player-appearance-catalog.json";
export const ITEM_VARIANT_CATALOG_RELATIVE_PATH =
  "packages/shared/src/data/item-variant-catalog.json";
export const BOSS_APPEARANCE_CATALOG_RELATIVE_PATH =
  "packages/shared/src/data/boss-appearance-catalog.json";
export const APPEARANCE_ASSET_ROOT_RELATIVE_PATH =
  "packages/player-renderer/src/assets/player-appearance";
export const BOSS_APPEARANCE_ASSET_ROOT_RELATIVE_PATH =
  "packages/player-renderer/src/assets/boss-appearance";
export const RUNTIME_PNG_PRESENTATION_RELATIVE_PATH =
  "packages/shared/src/data/runtime-png-presentation.json";
export const DUNGEON_CUSTOM_ASSET_ROOT_RELATIVE_PATH =
  "apps/client/public/assets/dungeons/custom";
export const MANOR_CUSTOM_ASSET_ROOT_RELATIVE_PATH =
  "apps/client/public/assets/manor";
export const RUNTIME_PNG_ASSET_METADATA_RELATIVE_PATH =
  "packages/shared/src/data/runtime-png-asset-metadata.json";
export const PROGRESSION_ICON_PRESENTATION_RELATIVE_PATH =
  "packages/shared/src/data/progression-icon-presentation.json";

const RUNTIME_ASSET_ROOTS = [
  "apps/client/src/assets",
  "apps/client/public",
  APPEARANCE_ASSET_ROOT_RELATIVE_PATH,
  BOSS_APPEARANCE_ASSET_ROOT_RELATIVE_PATH
] as const;

export const APPEARANCE_ASSET_CATEGORIES = [
  "bodies",
  "heads",
  "hair",
  "eyes",
  "nose-mouth",
  "masks",
  "weapons",
  "projectiles",
  "enhancements/gems",
  "armor/head",
  "armor/chest",
  "armor/gloves",
  "armor/boots",
  "shields",
  "cosmetics"
] as const;

export type AppearanceStudioBridgeOptions = {
  repositoryRoot?: string;
  atlasPngSourceRoot?: string;
  port?: number;
  serveUi?: boolean;
  beforeCatalogReplace?: () => Promise<void>;
  afterFileReplace?: (relativeFile: string, index: number) => Promise<void>;
  serverIdentity?: StudioServerIdentity;
  uiRoot?: string;
  desktop?: AppearanceStudioDesktopController;
};

type StagedAsset = {
  stagingToken: string;
  assetScope: "player" | "boss" | "runtime" | "dungeon" | "manor";
  assetKey: string;
  relativeFile: string;
  buffer: Buffer;
  contentHash: string;
  createdAt: number;
  importSource?: "atlas-png-inbox";
};

type PreparedFile = {
  temporary: string;
  destination: string;
  relativeFile: string;
};

export async function createAppearanceStudioBridge(
  options: AppearanceStudioBridgeOptions = {}
): Promise<FastifyInstance> {
  const repositoryRoot = await realpath(
    options.repositoryRoot ??
    fileURLToPath(new URL("../../..", import.meta.url))
  );
  const atlasPngSourceRoot = path.resolve(
    options.atlasPngSourceRoot ?? DEFAULT_ATLAS_PNG_SOURCE_DIRECTORY
  );
  const port = options.port ?? APPEARANCE_STUDIO_PORT;
  const origin = `http://${APPEARANCE_STUDIO_HOST}:${port}`;
  const csrfToken = randomBytes(32).toString("base64url");
  const catalogPath = path.join(repositoryRoot, APPEARANCE_CATALOG_RELATIVE_PATH);
  const itemVariantCatalogPath = path.join(
    repositoryRoot,
    ITEM_VARIANT_CATALOG_RELATIVE_PATH
  );
  const bossCatalogPath = path.join(
    repositoryRoot,
    BOSS_APPEARANCE_CATALOG_RELATIVE_PATH
  );
  const dungeonCatalogPath = path.join(repositoryRoot, INTERIOR_DATA_RELATIVE_DIR);
  // The interiors directory: the unified interior catalog (InteriorStudio) is loaded from and saved into it.
  const interiorCatalogPath = path.join(repositoryRoot, INTERIOR_DATA_RELATIVE_DIR);
  const assetRoot = path.join(repositoryRoot, APPEARANCE_ASSET_ROOT_RELATIVE_PATH);
  const bossAssetRoot = path.join(
    repositoryRoot,
    BOSS_APPEARANCE_ASSET_ROOT_RELATIVE_PATH
  );
  const runtimePresentationPath = path.join(
    repositoryRoot,
    RUNTIME_PNG_PRESENTATION_RELATIVE_PATH
  );
  const progressionIconPresentationPath = path.join(
    repositoryRoot,
    PROGRESSION_ICON_PRESENTATION_RELATIVE_PATH
  );
  const stagingRoot = path.join(
    tmpdir(),
    "ash-atlas-appearance-studio",
    createHash("sha256").update(repositoryRoot.toLowerCase()).digest("hex")
  );
  await mkdir(assetRoot, { recursive: true });
  await mkdir(bossAssetRoot, { recursive: true });
  await mkdir(stagingRoot, { recursive: true });
  await rejectActivePublishLock(stagingRoot);
  await recoverPublishTransaction(stagingRoot, repositoryRoot);
  const stagedAssets = await loadStagedAssets(stagingRoot);
  const remote = new RemoteStudioConnection();
  let publishInFlight = false;
  const startupWorkspace = await inspectWorkspace(repositoryRoot, 0);
  const serverIdentity = options.serverIdentity ?? {
    pid: process.pid,
    worktreePath: startupWorkspace.worktreePath,
    branch: startupWorkspace.branch,
    commitSha: startupWorkspace.commitSha,
    port,
    startedAt: new Date().toISOString()
  };
  const app = Fastify({
    bodyLimit: 6 * 1024 * 1024,
    logger: process.env.NODE_ENV !== "test"
  });

  app.setErrorHandler((error, _request, reply) => {
    const statusCode = error instanceof StudioBridgeError
      ? error.statusCode
      : 500;
    reply.code(statusCode).send({
      error: error instanceof Error ? error.message : "Appearance Studio request failed",
      ...(error instanceof StudioBridgeError ? { code: error.code } : {})
    });
  });

  app.get("/api/session", async (request): Promise<StudioSession> => {
    assertReadOrigin(request, origin);
    return {
      csrfToken,
      origin,
      workspace: await inspectWorkspace(
        repositoryRoot,
        await inspectCatalogRevision(catalogPath)
      ),
      server: serverIdentity
    };
  });

  app.get("/api/catalog", async (request) => {
    assertReadOrigin(request, origin);
    const workspace = await assertCompatibleWorkspace(repositoryRoot, catalogPath);
    return loadCatalog(catalogPath, workspace);
  });

  app.get("/api/item-variants", async (request) => {
    assertReadOrigin(request, origin);
    await assertCompatibleWorkspace(repositoryRoot, catalogPath);
    return loadItemVariantCatalog(itemVariantCatalogPath);
  });

  app.get("/api/boss-catalog", async (request) => {
    assertReadOrigin(request, origin);
    await assertCompatibleWorkspace(repositoryRoot, catalogPath);
    return loadBossCatalog(bossCatalogPath);
  });

  registerDungeonPlaytestRoutes(app, (request) => assertMutation(request, origin, csrfToken));

  app.get("/api/interior-catalog", async (request, reply): Promise<InteriorCatalogSnapshot> => {
    assertReadOrigin(request, origin);
    await assertCompatibleWorkspace(repositoryRoot, catalogPath);
    reply.header("cache-control", "no-store");
    return loadInteriorCatalog(interiorCatalogPath);
  });

  app.get("/api/runtime-assets", async (request, reply): Promise<RuntimeAssetInventory> => {
    assertReadOrigin(request, origin);
    await assertCompatibleWorkspace(repositoryRoot, catalogPath);
    reply.header("cache-control", "no-store");
    return loadRuntimeAssetInventory(
      repositoryRoot,
      runtimePresentationPath,
      stagedAssets
    );
  });

  app.get("/api/runtime-assets/inbox", async (request): Promise<RuntimeAssetInbox> => {
    assertReadOrigin(request, origin);
    await assertCompatibleWorkspace(repositoryRoot, catalogPath);
    return loadRuntimeAssetInbox(atlasPngSourceRoot, repositoryRoot, stagedAssets);
  });

  app.get("/api/progression-icons", async (request): Promise<ProgressionIconInventory> => {
    assertReadOrigin(request, origin);
    await assertCompatibleWorkspace(repositoryRoot, catalogPath);
    return loadProgressionIconInventory(progressionIconPresentationPath);
  });

  app.get("/api/territory-structures", async (request): Promise<TerritoryStructureInventory> => {
    assertReadOrigin(request, origin);
    await assertCompatibleWorkspace(repositoryRoot, catalogPath);
    return loadTerritoryStructureInventory(repositoryRoot);
  });

  app.get("/api/desktop/status", async (request) => {
    assertReadOrigin(request, origin);
    return options.desktop
      ? {
          available: true,
          appVersion: options.desktop.appVersion,
          contractVersion: startupWorkspace.compatibility.supportedContractVersion
        }
      : { available: false };
  });

  app.post("/api/desktop/create-batch", async (request) => {
    assertMutation(request, origin, csrfToken);
    if (!options.desktop) throw new StudioBridgeError(404, "Desktop workflow is unavailable");
    const body = request.body as { slug?: unknown };
    if (typeof body.slug !== "string") {
      throw new StudioBridgeError(400, "Content batch name is required");
    }
    const created = await options.desktop.createContentBatch({ slug: body.slug });
    setTimeout(() => options.desktop?.requestWorkspaceSwitch(created.worktreePath), 100);
    return created;
  });

  app.post("/api/desktop/finish-batch", async (request) => {
    assertMutation(request, origin, csrfToken);
    if (!options.desktop) throw new StudioBridgeError(404, "Desktop workflow is unavailable");
    await validateRepositoryAppearanceContent(repositoryRoot);
    const body = request.body as { summary?: unknown };
    if (typeof body.summary !== "string") {
      throw new StudioBridgeError(400, "Content batch summary is required");
    }
    // Keep the feature worktree active after commit/push. The next workflow step
    // integrates that branch, so switching back to the permanent checkout here
    // made a successful commit look unavailable to the integration controls.
    return options.desktop.finishContentBatch({ summary: body.summary });
  });

  app.get("/api/desktop/release-status", async (request) => {
    assertReadOrigin(request, origin);
    if (!options.desktop) throw new StudioBridgeError(404, "Desktop workflow is unavailable");
    return options.desktop.releaseStatus();
  });

  app.post("/api/desktop/integrate-batch", async (request) => {
    assertMutation(request, origin, csrfToken);
    if (!options.desktop) throw new StudioBridgeError(404, "Desktop workflow is unavailable");
    return options.desktop.integrateContentBatch();
  });

  app.post("/api/desktop/publish-integration", async (request) => {
    assertMutation(request, origin, csrfToken);
    if (!options.desktop) throw new StudioBridgeError(404, "Desktop workflow is unavailable");
    const body = request.body as {
      approvedGeneration?: unknown;
      approvedSha?: unknown;
    };
    if (
      typeof body.approvedGeneration !== "string" ||
      !/^t\d{3,}$/u.test(body.approvedGeneration) ||
      typeof body.approvedSha !== "string" ||
      !/^[0-9a-f]{40}$/u.test(body.approvedSha)
    ) {
      throw new StudioBridgeError(400, "An exact Integration Test generation and SHA are required");
    }
    return options.desktop.publishIntegrationTest({
      approvedGeneration: body.approvedGeneration,
      approvedSha: body.approvedSha
    });
  });

  app.post("/api/desktop/open-external", async (request) => {
    assertMutation(request, origin, csrfToken);
    if (!options.desktop) throw new StudioBridgeError(404, "Desktop workflow is unavailable");
    const body = request.body as { url?: unknown };
    if (typeof body.url !== "string") throw new StudioBridgeError(400, "URL is required");
    await options.desktop.openExternal(body.url);
    return { opened: true };
  });

  app.post("/api/publish", async (request): Promise<StudioPublishResponse> => {
    assertMutation(request, origin, csrfToken);
    if (publishInFlight) {
      throw new StudioBridgeError(409, "Another save is already in progress", "SAVE_IN_PROGRESS");
    }
    publishInFlight = true;
    try {
      return await publishAppearanceContent({
        body: request.body as Partial<StudioPublishRequest>,
        repositoryRoot,
        catalogPath,
        bossCatalogPath,
        itemVariantCatalogPath,
        assetRoot,
        bossAssetRoot,
        stagingRoot,
        stagedAssets,
        ...(options.beforeCatalogReplace
          ? { beforeCatalogReplace: options.beforeCatalogReplace }
          : {}),
        ...(options.afterFileReplace
          ? { afterFileReplace: options.afterFileReplace }
          : {})
      });
    } finally {
      publishInFlight = false;
    }
  });

  app.post<{ Params: { spaceId: string } }>(
    "/api/interior-catalog/:spaceId/publish",
    async (request): Promise<InteriorSpacePublishResponse> => {
      assertMutation(request, origin, csrfToken);
      if (publishInFlight) {
        throw new StudioBridgeError(409, "Another save is already in progress", "SAVE_IN_PROGRESS");
      }
      publishInFlight = true;
      try {
        return await publishInteriorSpaces({
          body: request.body as Partial<InteriorSpacePublishRequest>,
          spaceId: request.params.spaceId,
          repositoryRoot,
          appearanceCatalogPath: catalogPath,
          interiorCatalogPath,
          stagingRoot,
          stagedAssets,
          ...(options.beforeCatalogReplace ? { beforeCatalogReplace: options.beforeCatalogReplace } : {}),
          ...(options.afterFileReplace ? { afterFileReplace: options.afterFileReplace } : {})
        });
      } finally {
        publishInFlight = false;
      }
    }
  );

  app.post("/api/dungeon-assets/import", async (request): Promise<ImportedAsset> => {
    assertMutation(request, origin, csrfToken);
    await requireWritableWorkspace(repositoryRoot, catalogPath);
    const body = request.body as Record<string, unknown>;
    const kinds = ["surface", "decoration", "object", "portal"];
    const layers = ["background", "below_player", "actors", "above_player", "ceiling"];
    const renderModes = ["sprite", "tile", "stretch"];
    if (typeof body.fileName !== "string" || !/\.png$/iu.test(body.fileName) ||
      typeof body.dataBase64 !== "string" || typeof body.displayName !== "string" ||
      body.displayName.trim().length < 1 || body.displayName.length > 80 ||
      typeof body.prefabId !== "string" || !/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(body.prefabId) ||
      !kinds.includes(String(body.kind)) || !layers.includes(String(body.layer)) ||
      !renderModes.includes(String(body.renderMode)) ||
      typeof body.defaultWidth !== "number" || !Number.isFinite(body.defaultWidth) || body.defaultWidth <= 0 ||
      typeof body.defaultHeight !== "number" || !Number.isFinite(body.defaultHeight) || body.defaultHeight <= 0) {
      throw new StudioBridgeError(400, "PNG import needs a .png file, a name of 1–80 characters, an internal ID of 1–64 lowercase letters/numbers, and positive artwork dimensions. Choose the file again; generated IDs are automatic.");
    }
    const current = await loadDungeonCatalog(dungeonCatalogPath);
    if (current.prefabs.some((prefab) => prefab.id === body.prefabId)) {
      throw new StudioBridgeError(409, "Dungeon prefab ID already exists", "DUNGEON_PREFAB_EXISTS");
    }
    const relativeFile = `${DUNGEON_CUSTOM_ASSET_ROOT_RELATIVE_PATH}/${body.prefabId}.png`;
    const destination = await safePath(repositoryRoot, relativeFile);
    if (await exists(destination) || [...stagedAssets.values()].some((asset) => asset.assetScope === "dungeon" && (asset.assetKey === relativeFile || asset.relativeFile === relativeFile))) {
      throw new StudioBridgeError(409, "Dungeon asset target already exists", "DUNGEON_ASSET_EXISTS");
    }
    const buffer = decodeBase64(body.dataBase64);
    const dimensions = validatePng(buffer);
    const stagingToken = randomBytes(18).toString("base64url");
    const stagedAsset: StagedAsset = { stagingToken, assetScope: "dungeon", assetKey: relativeFile, relativeFile, buffer, contentHash: createHash("sha256").update(buffer).digest("hex"), createdAt: Date.now() };
    await persistStagedAsset(stagingRoot, stagedAsset);
    stagedAssets.set(stagingToken, stagedAsset);
    return { stagingToken, assetKey: relativeFile, relativeFile, ...dimensions, bytes: buffer.length, contentHash: stagedAsset.contentHash };
  });

  app.post("/api/manor-assets/import", async (request): Promise<ImportedAsset> => {
    assertMutation(request, origin, csrfToken);
    await requireWritableWorkspace(repositoryRoot, catalogPath);
    const body = request.body as Record<string, unknown>;
    if (typeof body.fileName !== "string" || !/\.png$/iu.test(body.fileName) ||
      typeof body.dataBase64 !== "string") {
      throw new StudioBridgeError(400, "Manor PNG import payload is invalid");
    }
    const stem = normalizedFileStem(body.fileName);
    const relativeFile = `${MANOR_CUSTOM_ASSET_ROOT_RELATIVE_PATH}/${stem}.png`;
    const destination = await safePath(repositoryRoot, relativeFile);
    if (await exists(destination) || [...stagedAssets.values()].some((asset) =>
      asset.assetScope === "manor" && asset.relativeFile === relativeFile)) {
      throw new StudioBridgeError(409, "Manor asset target already exists", "MANOR_ASSET_EXISTS");
    }
    const buffer = decodeBase64(body.dataBase64);
    const dimensions = validatePng(buffer);
    const stagingToken = randomBytes(18).toString("base64url");
    const stagedAsset: StagedAsset = {
      stagingToken,
      assetScope: "manor",
      assetKey: relativeFile,
      relativeFile,
      buffer,
      contentHash: createHash("sha256").update(buffer).digest("hex"),
      createdAt: Date.now()
    };
    await persistStagedAsset(stagingRoot, stagedAsset);
    stagedAssets.set(stagingToken, stagedAsset);
    return { stagingToken, assetKey: relativeFile, relativeFile, ...dimensions, bytes: buffer.length, contentHash: stagedAsset.contentHash };
  });

  app.post("/api/dungeon-assets/replace", async (request): Promise<ImportedAsset> => {
    assertMutation(request, origin, csrfToken);
    await requireWritableWorkspace(repositoryRoot, catalogPath);
    const body = request.body as Record<string, unknown>;
    if (typeof body.fileName !== "string" || !/\.png$/iu.test(body.fileName) ||
      typeof body.dataBase64 !== "string" || typeof body.prefabId !== "string" ||
      !/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(body.prefabId)) {
      throw new StudioBridgeError(400, "Dungeon PNG replacement payload is invalid");
    }
    const current = await loadDungeonCatalog(dungeonCatalogPath);
    const prefab = current.prefabs.find((candidate) => candidate.id === body.prefabId && !candidate.retired);
    if (!prefab) throw new StudioBridgeError(404, "Dungeon prefab is not in the current catalog", "DUNGEON_PREFAB_NOT_FOUND");
    const buffer = decodeBase64(body.dataBase64);
    const dimensions = validatePng(buffer);
    const previous = [...stagedAssets.values()].find((asset) => asset.assetScope === "dungeon" && asset.assetKey === prefab.assetKey);
    if (previous) {
      stagedAssets.delete(previous.stagingToken);
      await removeStagedAsset(stagingRoot, previous.stagingToken);
    }
    const stagingToken = randomBytes(18).toString("base64url");
    const stagedAsset: StagedAsset = {
      stagingToken,
      assetScope: "dungeon",
      assetKey: prefab.assetKey,
      relativeFile: prefab.assetKey,
      buffer,
      contentHash: createHash("sha256").update(buffer).digest("hex"),
      createdAt: Date.now()
    };
    await persistStagedAsset(stagingRoot, stagedAsset);
    stagedAssets.set(stagingToken, stagedAsset);
    return { stagingToken, assetKey: prefab.assetKey, relativeFile: prefab.assetKey, ...dimensions, bytes: buffer.length, contentHash: stagedAsset.contentHash };
  });

  app.post("/api/dungeon-assets/discard", async (request): Promise<{ discarded: number }> => {
    assertMutation(request, origin, csrfToken);
    await requireWritableWorkspace(repositoryRoot, catalogPath);
    const tokens = (request.body as { tokens?: unknown })?.tokens;
    if (!Array.isArray(tokens) || tokens.some((token) => typeof token !== "string")) throw new StudioBridgeError(400, "Dungeon staging tokens are invalid");
    let discarded = 0;
    for (const token of tokens) {
      const asset = stagedAssets.get(token);
      if (!asset || !isInteriorPublishAsset(asset)) continue;
      stagedAssets.delete(token); await removeStagedAsset(stagingRoot, token); discarded += 1;
    }
    return { discarded };
  });

  app.post("/api/assets/import", async (request): Promise<ImportedAsset> => {
    assertMutation(request, origin, csrfToken);
    await requireWritableWorkspace(repositoryRoot, catalogPath);
    const body = request.body as {
      fileName?: unknown;
      category?: unknown;
      assetScope?: unknown;
      bossId?: unknown;
      dataBase64?: unknown;
    };
    if (
      typeof body?.fileName !== "string" ||
      typeof body.category !== "string" ||
      typeof body.dataBase64 !== "string"
    ) {
      throw new StudioBridgeError(400, "PNG import payload is invalid");
    }
    const assetScope = body.assetScope === "boss" ? "boss" : "player";
    let category: string;
    let selectedAssetRoot: string;
    let selectedAssetRootRelativePath: string;
    if (assetScope === "boss") {
      if (
        body.category !== "weapons" ||
        typeof body.bossId !== "string" ||
        !/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(body.bossId)
      ) {
        throw new StudioBridgeError(400, "Boss weapon asset target is invalid");
      }
      category = `${body.bossId}/weapons`;
      selectedAssetRoot = bossAssetRoot;
      selectedAssetRootRelativePath = BOSS_APPEARANCE_ASSET_ROOT_RELATIVE_PATH;
    } else {
      if (
        !APPEARANCE_ASSET_CATEGORIES.includes(
          body.category as (typeof APPEARANCE_ASSET_CATEGORIES)[number]
        )
      ) {
        throw new StudioBridgeError(400, "Appearance asset category is invalid");
      }
      category = body.category;
      selectedAssetRoot = assetRoot;
      selectedAssetRootRelativePath = APPEARANCE_ASSET_ROOT_RELATIVE_PATH;
    }
    if (!/\.png$/iu.test(body.fileName)) {
      throw new StudioBridgeError(400, "Appearance Studio accepts only PNG files");
    }
    const buffer = decodeBase64(body.dataBase64);
    const dimensions = validatePng(buffer);
    const contentHash = createHash("sha256").update(buffer).digest("hex");
    const stem = normalizedFileStem(body.fileName);
    let fileName = `${stem}.png`;
    let destination = await safePath(selectedAssetRoot, `${category}/${fileName}`);
    const stagedAtBaseName = [...stagedAssets.values()].find(
      (asset) => asset.assetScope === assetScope &&
        asset.assetKey === `${category}/${fileName}`
    );
    if (await exists(destination)) {
      const existingHash = createHash("sha256")
        .update(await readFile(destination))
        .digest("hex");
      if (existingHash !== contentHash) {
        fileName = `${stem}-${contentHash.slice(0, 8)}.png`;
        destination = await safePath(selectedAssetRoot, `${category}/${fileName}`);
      }
    } else if (stagedAtBaseName && stagedAtBaseName.contentHash !== contentHash) {
      fileName = `${stem}-${contentHash.slice(0, 8)}.png`;
      destination = await safePath(selectedAssetRoot, `${category}/${fileName}`);
    }
    const assetKey = `${category}/${fileName}`;
    const stagingToken = randomBytes(18).toString("base64url");
    const stagedAsset: StagedAsset = {
      stagingToken,
      assetScope,
      assetKey,
      relativeFile: `${selectedAssetRootRelativePath}/${assetKey}`,
      buffer,
      contentHash,
      createdAt: Date.now()
    };
    await persistStagedAsset(stagingRoot, stagedAsset);
    stagedAssets.set(stagingToken, stagedAsset);
    return {
      stagingToken,
      assetKey,
      relativeFile: `${selectedAssetRootRelativePath}/${assetKey}`,
      ...dimensions,
      bytes: buffer.length,
      contentHash
    };
  });

  app.post("/api/runtime-assets/replace", async (request): Promise<ImportedAsset> => {
    assertMutation(request, origin, csrfToken);
    await requireWritableWorkspace(repositoryRoot, catalogPath);
    const body = request.body as {
      assetId?: unknown;
      fileName?: unknown;
      dataBase64?: unknown;
    };
    if (
      typeof body.assetId !== "string" ||
      typeof body.fileName !== "string" ||
      typeof body.dataBase64 !== "string" ||
      !/\.png$/iu.test(body.fileName)
    ) {
      throw new StudioBridgeError(400, "Runtime PNG replacement payload is invalid");
    }
    const knownFiles = await knownRuntimeAssetFiles(repositoryRoot);
    if (!knownFiles.has(body.assetId)) {
      throw new StudioBridgeError(404, "Runtime PNG is not in the game asset inventory");
    }
    const buffer = decodeBase64(body.dataBase64);
    const dimensions = validatePng(buffer);
    const contentHash = createHash("sha256").update(buffer).digest("hex");
    const previous = [...stagedAssets.values()].find(
      (asset) => asset.assetScope === "runtime" && asset.assetKey === body.assetId
    );
    if (previous) {
      stagedAssets.delete(previous.stagingToken);
      await removeStagedAsset(stagingRoot, previous.stagingToken);
    }
    const stagingToken = randomBytes(18).toString("base64url");
    const stagedAsset: StagedAsset = {
      stagingToken,
      assetScope: "runtime",
      assetKey: body.assetId,
      relativeFile: body.assetId,
      buffer,
      contentHash,
      createdAt: Date.now()
    };
    await persistStagedAsset(stagingRoot, stagedAsset);
    stagedAssets.set(stagingToken, stagedAsset);
    return {
      stagingToken,
      assetKey: body.assetId,
      relativeFile: body.assetId,
      ...dimensions,
      bytes: buffer.length,
      contentHash
    };
  });

  app.post(
    "/api/runtime-assets/inbox/import",
    async (request): Promise<RuntimeAssetInboxImportResponse> => {
      assertMutation(request, origin, csrfToken);
      await requireWritableWorkspace(repositoryRoot, catalogPath);
      const body = request.body as { sourceFile?: unknown };
      if (typeof body.sourceFile !== "string" || body.sourceFile.trim() === "") {
        throw new StudioBridgeError(400, "AtlasPNGS inbox source file is required", "INVALID_REQUEST");
      }

      const sourceAssets = await discoverAtlasPngSourceAssets(atlasPngSourceRoot);
      const sourceAsset = sourceAssets.find((asset) => asset.sourceFile === body.sourceFile);
      if (!sourceAsset) {
        throw new StudioBridgeError(
          409,
          "The AtlasPNGS file is missing, invalid, or changed; refresh the inbox and try again",
          "INBOX_SOURCE_CHANGED"
        );
      }
      const inbox = await loadRuntimeAssetInbox(atlasPngSourceRoot, repositoryRoot, stagedAssets);
      const entry = inbox.entries.find((candidate) => candidate.sourceFile === sourceAsset.sourceFile);
      if (!entry || entry.status !== "ready") {
        throw new StudioBridgeError(
          409,
          entry?.statusReason ?? "This AtlasPNGS file cannot be imported safely",
          "INBOX_IMPORT_CONFLICT"
        );
      }
      const destination = await safePath(repositoryRoot, sourceAsset.destinationFile);
      if (await exists(destination)) {
        throw new StudioBridgeError(
          409,
          `The target ${sourceAsset.destinationFile} appeared before import; refresh the inbox`,
          "FILESYSTEM_CONFLICT"
        );
      }
      if ([...stagedAssets.values()].some(
        (asset) => asset.assetScope === "runtime" && asset.assetKey === sourceAsset.destinationFile
      )) {
        throw new StudioBridgeError(
          409,
          `The target ${sourceAsset.destinationFile} is already staged; refresh the inbox`,
          "INBOX_IMPORT_CONFLICT"
        );
      }
      const buffer = await readFile(sourceAsset.sourcePath);
      const dimensions = validatePng(buffer);
      const contentHash = createHash("sha256").update(buffer).digest("hex");
      if (contentHash !== sourceAsset.contentHash) {
        throw new StudioBridgeError(
          409,
          "The AtlasPNGS file changed during import; refresh the inbox and try again",
          "INBOX_SOURCE_CHANGED"
        );
      }
      const stagingToken = randomBytes(18).toString("base64url");
      const stagedAsset: StagedAsset = {
        stagingToken,
        assetScope: "runtime",
        assetKey: sourceAsset.destinationFile,
        relativeFile: sourceAsset.destinationFile,
        buffer,
        contentHash,
        createdAt: Date.now(),
        importSource: "atlas-png-inbox"
      };
      await persistStagedAsset(stagingRoot, stagedAsset);
      stagedAssets.set(stagingToken, stagedAsset);
      return {
        stagingToken,
        assetKey: sourceAsset.destinationFile,
        relativeFile: sourceAsset.destinationFile,
        ...dimensions,
        bytes: buffer.length,
        contentHash,
        sourceFile: sourceAsset.sourceFile
      };
    }
  );

  app.post("/api/runtime-assets/publish", async (request): Promise<RuntimeAssetPublishResponse> => {
    assertMutation(request, origin, csrfToken);
    if (publishInFlight) {
      throw new StudioBridgeError(409, "Another save is already in progress", "SAVE_IN_PROGRESS");
    }
    publishInFlight = true;
    try {
      return await publishRuntimeAssets({
        body: request.body as Partial<RuntimeAssetPublishRequest>,
        repositoryRoot,
        catalogPath,
        runtimePresentationPath,
        stagingRoot,
        stagedAssets,
        ...(options.afterFileReplace
          ? { afterFileReplace: options.afterFileReplace }
          : {})
      });
    } finally {
      publishInFlight = false;
    }
  });

  app.post("/api/runtime-assets/discard", async (request): Promise<RuntimeAssetInventory> => {
    assertMutation(request, origin, csrfToken);
    await requireWritableWorkspace(repositoryRoot, catalogPath);
    const runtimeAssets = [...stagedAssets.values()].filter(
      (asset) => asset.assetScope === "runtime"
    );
    await Promise.all(runtimeAssets.map(async (asset) => {
      stagedAssets.delete(asset.stagingToken);
      await removeStagedAsset(stagingRoot, asset.stagingToken);
    }));
    return loadRuntimeAssetInventory(
      repositoryRoot,
      runtimePresentationPath,
      stagedAssets
    );
  });

  app.post("/api/progression-icons/publish", async (request): Promise<ProgressionIconPublishResponse> => {
    assertMutation(request, origin, csrfToken);
    if (publishInFlight) {
      throw new StudioBridgeError(409, "Another save is already in progress", "SAVE_IN_PROGRESS");
    }
    publishInFlight = true;
    try {
      return await publishProgressionIcons({
        body: request.body as Partial<ProgressionIconPublishRequest>,
        repositoryRoot,
        catalogPath,
        progressionIconPresentationPath,
        stagingRoot,
        ...(options.afterFileReplace ? { afterFileReplace: options.afterFileReplace } : {})
      });
    } finally {
      publishInFlight = false;
    }
  });

  app.post("/api/territory-structures/publish", async (request): Promise<TerritoryStructurePublishResponse> => {
    assertMutation(request, origin, csrfToken);
    if (publishInFlight) throw new StudioBridgeError(409, "Another save is already in progress", "SAVE_IN_PROGRESS");
    publishInFlight = true;
    try {
      return await publishTerritoryStructures({
        body: request.body as Partial<TerritoryStructurePublishRequest>,
        repositoryRoot, catalogPath, stagingRoot,
        ...(options.afterFileReplace ? { afterFileReplace: options.afterFileReplace } : {})
      });
    } finally { publishInFlight = false; }
  });

  app.get("/runtime-assets/*", async (request, reply) => {
    const rawKey = (request.params as { "*": string })["*"];
    const staged = [...stagedAssets.values()].find(
      (asset) => (asset.assetScope === "runtime" || asset.assetScope === "dungeon" || asset.assetScope === "manor") && asset.assetKey === rawKey
    );
    // A directory scan per image made every preview wait on full-tree walks; a canonical PNG
    // path under the asset roots is exactly what that scan discovers, so check it directly.
    const registered = RUNTIME_PNG_ASSET_REGISTRY.some((registration) => registration.relativeFile === rawKey);
    if (!staged && !registered && !isCanonicalRuntimeAssetPath(rawKey)) {
      throw new StudioBridgeError(404, "Runtime PNG was not found");
    }
    const assetPath = await safePath(repositoryRoot, rawKey);
    if (!staged && !(await exists(assetPath))) {
      throw new StudioBridgeError(404, "Runtime PNG is not available at its canonical path");
    }
    reply
      .header("content-type", "image/png")
      .header("cache-control", "no-store")
      .send(staged?.buffer ?? await readFile(assetPath));
  });

  // The shared live dungeon renderer retains its canonical public asset URLs.
  app.get("/assets/dungeons/*", async (request, reply) => {
    const relative = `assets/dungeons/${(request.params as { "*": string })["*"]}`;
    const rawKey = `apps/client/public/${relative}`;
    const assetPath = await safePath(path.join(repositoryRoot, "apps/client/public"), relative);
    const staged = [...stagedAssets.values()].find((asset) => asset.assetScope === "dungeon" && asset.assetKey === rawKey);
    if (!relative.endsWith(".png") || (!staged && !(await exists(assetPath)))) {
      throw new StudioBridgeError(404, "Dungeon artwork is not available at its canonical path");
    }
    return reply.header("content-type", "image/png").header("cache-control", "no-store")
      .send(staged?.buffer ?? await readFile(assetPath));
  });

  app.get("/appearance-assets/*", async (request, reply) => {
    const rawKey = (request.params as { "*": string })["*"];
    const assetPath = await safePath(assetRoot, rawKey);
    const staged = [...stagedAssets.values()].find(
      (asset) => asset.assetScope === "player" && asset.assetKey === rawKey
    );
    if (!rawKey.toLowerCase().endsWith(".png") || (!staged && !(await exists(assetPath)))) {
      throw new StudioBridgeError(404, "Appearance asset was not found");
    }
    reply
      .header("content-type", "image/png")
      .header("cache-control", "no-store")
      .send(staged?.buffer ?? await readFile(assetPath));
  });

  app.get("/boss-appearance-assets/*", async (request, reply) => {
    const rawKey = (request.params as { "*": string })["*"];
    const assetPath = await safePath(bossAssetRoot, rawKey);
    const staged = [...stagedAssets.values()].find(
      (asset) => asset.assetScope === "boss" && asset.assetKey === rawKey
    );
    if (!rawKey.toLowerCase().endsWith(".png") || (!staged && !(await exists(assetPath)))) {
      throw new StudioBridgeError(404, "Boss appearance asset was not found");
    }
    reply
      .header("content-type", "image/png")
      .header("cache-control", "no-store")
      .send(staged?.buffer ?? await readFile(assetPath));
  });

  app.post("/api/remote/connect", async (request) => {
    assertMutation(request, origin, csrfToken);
    const body = request.body as { serverBase?: unknown };
    if (typeof body?.serverBase !== "string") {
      throw new StudioBridgeError(400, "Server URL is required");
    }
    return { authorizeUrl: remote.begin(body.serverBase, origin) };
  });

  app.get("/auth/callback", async (request, reply) => {
    const query = request.query as { code?: unknown; state?: unknown };
    if (typeof query.code !== "string" || typeof query.state !== "string") {
      throw new StudioBridgeError(400, "Authorization callback is incomplete");
    }
    await remote.exchange(query.code, query.state, origin);
    if (options.desktop) {
      reply.type("text/html").send(
        "<!doctype html><title>Appearance Studio connected</title>" +
        "<p>Authorization complete. You can close this window and return to Appearance Studio.</p>"
      );
    } else {
      reply.redirect("/?remote=connected");
    }
  });

  app.get("/api/remote/status", async (request) => {
    assertReadOrigin(request, origin);
    return remote.status();
  });

  app.post("/api/remote/disconnect", async (request) => {
    assertMutation(request, origin, csrfToken);
    await remote.disconnect();
    return { disconnected: true };
  });

  app.addHook("onClose", async () => {
    await remote.disconnect();
  });

  if (options.serveUi !== false) {
    await installUi(app, repositoryRoot, options.uiRoot);
  }
  return app;
}

async function installUi(
  app: FastifyInstance,
  repositoryRoot: string,
  uiRoot?: string
): Promise<void> {
  const appRoot = path.join(repositoryRoot, "apps/appearance-studio");
  if (uiRoot || process.env.NODE_ENV === "production") {
    await app.register(fastifyStatic, {
      root: uiRoot ?? path.join(appRoot, "dist"),
      wildcard: false
    });
    app.setNotFoundHandler((_request, reply) => {
      reply.sendFile("index.html");
    });
    return;
  }
  await app.register(middie);
  const { createServer } = await import("vite");
  const vite = await createServer({
    root: appRoot,
    server: { middlewareMode: true, hmr: { server: app.server } },
    appType: "spa"
  });
  app.use((request, response, next) => {
    const requestUrl = request.url ?? "";
    if (
      requestUrl.startsWith("/api/") ||
      requestUrl.startsWith("/appearance-assets/") ||
      requestUrl.startsWith("/boss-appearance-assets/") ||
      requestUrl.startsWith("/runtime-assets/") ||
      requestUrl.startsWith("/assets/dungeons/") ||
      requestUrl.startsWith("/auth/callback")
    ) {
      next();
      return;
    }
    vite.middlewares(request, response, next);
  });
  app.addHook("onClose", async () => {
    await vite.close();
  });
}

async function loadRuntimeAssetInventory(
  repositoryRoot: string,
  runtimePresentationPath: string,
  stagedAssets: ReadonlyMap<string, StagedAsset>
): Promise<RuntimeAssetInventory> {
  const files = [...new Set([
    ...await knownRuntimeAssetFiles(repositoryRoot),
    ...[...stagedAssets.values()]
      .filter((asset) => asset.assetScope === "runtime")
      .map((asset) => asset.assetKey)
  ])].sort();
  const presentation = await loadRuntimePresentation(runtimePresentationPath);
  const metadata = await loadRuntimeAssetMetadata(repositoryRoot, files, presentation);
  const assets = await Promise.all(files.map(async (relativeFile): Promise<RuntimeAsset> => {
    const staged = [...stagedAssets.values()].find(
      (asset) => asset.assetScope === "runtime" && asset.assetKey === relativeFile
    );
    const assetPath = await safePath(repositoryRoot, relativeFile);
    const present = Boolean(staged) || await exists(assetPath);
    const buffer = staged?.buffer ?? (present ? await readFile(assetPath) : null);
    const dimensions = buffer ? validatePng(buffer) : { width: 0, height: 0 };
    const catalogEntry = runtimeAssetMetadata(relativeFile, metadata);
    return {
      id: relativeFile,
      label: catalogEntry.label,
      category: catalogEntry.category,
      relativeFile,
      imageUrl: present ? `/runtime-assets/${relativeFile}` : "",
      ...dimensions,
      bytes: buffer?.length ?? 0,
      contentHash: buffer ? createHash("sha256").update(buffer).digest("hex") : "",
      usages: catalogEntry.usages,
      staged: Boolean(staged),
      missing: !present
    };
  }));
  return {
    assets: assets.sort((left, right) =>
      left.category.localeCompare(right.category) || left.label.localeCompare(right.label)
    ),
    presentation
  };
}

async function loadRuntimeAssetInbox(
  sourceRoot: string,
  repositoryRoot: string,
  stagedAssets: ReadonlyMap<string, StagedAsset>
): Promise<RuntimeAssetInbox> {
  const sourceAssets = await discoverAtlasPngSourceAssets(sourceRoot);
  const destinationCounts = new Map<string, number>();
  for (const asset of sourceAssets) {
    destinationCounts.set(
      asset.destinationFile,
      (destinationCounts.get(asset.destinationFile) ?? 0) + 1
    );
  }
  const stagedByDestination = new Map(
    [...stagedAssets.values()]
      .filter((asset) => asset.assetScope === "runtime")
      .map((asset) => [asset.assetKey, asset] as const)
  );
  const entries = await Promise.all(sourceAssets.map(async (asset): Promise<RuntimeAssetInboxEntry> => {
    const staged = stagedByDestination.get(asset.destinationFile);
    const destination = await safePath(repositoryRoot, asset.destinationFile);
    const destinationExists = await exists(destination);
    const destinationHash = destinationExists ? await fileHash(destination) : null;
    let status: RuntimeAssetInboxEntry["status"] = "ready";
    let statusReason: string | null = null;
    if (asset.mappingStatus === "ambiguous") {
      status = "conflict";
      statusReason = `This filename matches multiple registered PNG slots: ${asset.destinationCandidates.join(", ")}`;
    } else if ((destinationCounts.get(asset.destinationFile) ?? 0) > 1) {
      status = "conflict";
      statusReason = `Multiple AtlasPNGS files map to ${asset.destinationFile}`;
    } else if (staged) {
      if (staged.contentHash === asset.contentHash) {
        status = "staged";
        statusReason = "Import staged; use Save to Worktree to publish it.";
      } else {
        status = "conflict";
        statusReason = `A different PNG is already staged for ${asset.destinationFile}`;
      }
    } else if (destinationHash === asset.contentHash) {
      status = "imported";
      statusReason = "This exact PNG is already in the worktree.";
    } else if (destinationExists) {
      status = "conflict";
      statusReason = `The worktree already has a different PNG at ${asset.destinationFile}`;
    }
    return {
      id: asset.sourceFile,
      sourceFile: asset.sourceFile,
      label: asset.label,
      destinationFile: asset.destinationFile,
      width: asset.width,
      height: asset.height,
      bytes: asset.bytes,
      contentHash: asset.contentHash,
      status,
      statusReason
    };
  }));
  return { sourceDirectory: path.resolve(sourceRoot), entries };
}

async function loadRuntimeAssetMetadata(
  repositoryRoot: string,
  discoveredFiles: readonly string[],
  presentation: RuntimePngPresentationCatalog
): Promise<Readonly<Record<string, RuntimeAssetMetadata>>> {
  const metadataPath = path.join(repositoryRoot, RUNTIME_PNG_ASSET_METADATA_RELATIVE_PATH);
  if (!(await exists(metadataPath))) return {};

  let value: unknown;
  try {
    value = JSON.parse(await readFile(metadataPath, "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new StudioBridgeError(
        500,
        `${RUNTIME_PNG_ASSET_METADATA_RELATIVE_PATH} contains invalid JSON`
      );
    }
    throw error;
  }
  try {
    return parseRuntimeAssetMetadata(value, new Set(discoveredFiles), presentation);
  } catch (error) {
    throw new StudioBridgeError(
      500,
      `${RUNTIME_PNG_ASSET_METADATA_RELATIVE_PATH} is invalid: ${
        error instanceof Error ? error.message : "validation failed"
      }`
    );
  }
}

function parseRuntimeAssetMetadata(
  value: unknown,
  discoveredFiles: ReadonlySet<string>,
  presentation: RuntimePngPresentationCatalog
): Readonly<Record<string, RuntimeAssetMetadata>> {
  const registry = requiredRecord(value, "registry");
  assertExactKeys(registry, ["schemaVersion", "assets"], "registry");
  if (registry.schemaVersion !== 1) throw new Error("schemaVersion must be 1");
  const entries = requiredRecord(registry.assets, "assets");
  const metadata: Record<string, RuntimeAssetMetadata> = {};
  for (const [relativeFile, rawEntry] of Object.entries(entries)) {
    if (!isCanonicalRuntimeAssetPath(relativeFile)) {
      throw new Error(`asset path ${JSON.stringify(relativeFile)} is not a canonical runtime PNG path`);
    }
    if (!discoveredFiles.has(relativeFile)) {
      throw new Error(`asset path ${JSON.stringify(relativeFile)} does not match a discovered PNG`);
    }
    const entry = requiredRecord(rawEntry, `assets.${relativeFile}`);
    assertExactKeys(entry, ["label", "category", "usages"], `assets.${relativeFile}`);
    const parsed: RuntimeAssetMetadata = {};
    if ("label" in entry) parsed.label = requiredNonemptyString(entry.label, `${relativeFile}.label`);
    if ("category" in entry) parsed.category = requiredNonemptyString(entry.category, `${relativeFile}.category`);
    if ("usages" in entry) {
      if (!Array.isArray(entry.usages) || entry.usages.length === 0) {
        throw new Error(`${relativeFile}.usages must be a non-empty array`);
      }
      parsed.usages = entry.usages.map((usage, index) =>
        parseRuntimeAssetUsage(usage, `${relativeFile}.usages[${index}]`, presentation)
      );
      const ids = new Set(parsed.usages.map((usage) => usage.id));
      if (ids.size !== parsed.usages.length) throw new Error(`${relativeFile}.usages IDs must be unique`);
    }
    if (Object.keys(parsed).length === 0) throw new Error(`${relativeFile} metadata cannot be empty`);
    metadata[relativeFile] = parsed;
  }
  return metadata;
}

function parseRuntimeAssetUsage(
  value: unknown,
  location: string,
  presentation: RuntimePngPresentationCatalog
): RuntimeAssetUsage {
  const usage = requiredRecord(value, location);
  assertExactKeys(usage, ["id", "label", "context", "editor"], location);
  const editor = requiredRecord(usage.editor, `${location}.editor`);
  const kind = editor.kind;
  let parsedEditor: RuntimeAssetUsage["editor"];
  if (kind === "sprite" || kind === "fixed" || kind === "world-object") {
    assertExactKeys(editor, ["kind", "key"], `${location}.editor`);
    const key = requiredNonemptyString(editor.key, `${location}.editor.key`);
    const catalog = kind === "sprite" ? presentation.sprites : presentation.fixed;
    if (!(key in catalog)) throw new Error(`${location}.editor key ${JSON.stringify(key)} is not in the ${kind} presentation catalog`);
    if (kind === "fixed" && isRuntimePngWorldObjectFixedKey(key)) {
      throw new Error(`${location}.editor key ${JSON.stringify(key)} must use the world-object editor because it follows the shared map zoom policy`);
    }
    if (kind === "world-object" && !isRuntimePngWorldObjectFixedKey(key)) {
      throw new Error(`${location}.editor key ${JSON.stringify(key)} is not a zoom-scaled world-object presentation`);
    }
    parsedEditor = { kind, key };
  } else if (kind === "appearance") {
    assertExactKeys(editor, ["kind", "domain"], `${location}.editor`);
    if (editor.domain !== "player" && editor.domain !== "boss") {
      throw new Error(`${location}.editor.domain must be player or boss`);
    }
    parsedEditor = { kind, domain: editor.domain };
  } else if (kind === "readonly") {
    assertExactKeys(editor, ["kind", "reason"], `${location}.editor`);
    parsedEditor = {
      kind,
      reason: requiredNonemptyString(editor.reason, `${location}.editor.reason`)
    };
  } else {
    throw new Error(`${location}.editor.kind is invalid`);
  }
  return {
    id: requiredNonemptyString(usage.id, `${location}.id`),
    label: requiredNonemptyString(usage.label, `${location}.label`),
    context: requiredNonemptyString(usage.context, `${location}.context`),
    editor: parsedEditor
  };
}

function isCanonicalRuntimeAssetPath(relativeFile: string): boolean {
  if (relativeFile.includes("\\") || path.posix.isAbsolute(relativeFile)) return false;
  if (path.posix.normalize(relativeFile) !== relativeFile || !/\.png$/iu.test(relativeFile)) return false;
  return RUNTIME_ASSET_ROOTS.some((root) => relativeFile.startsWith(`${root}/`));
}

function requiredRecord(value: unknown, location: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${location} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requiredNonemptyString(value: unknown, location: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${location} must be a non-empty string`);
  }
  return value;
}

function assertExactKeys(
  value: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
  location: string
): void {
  const unexpected = Object.keys(value).find((key) => !allowed.includes(key));
  if (unexpected) throw new Error(`${location}.${unexpected} is not supported`);
}

async function discoverRuntimeAssetFiles(repositoryRoot: string): Promise<string[]> {
  const files: string[] = [];
  for (const relativeRoot of RUNTIME_ASSET_ROOTS) {
    const absoluteRoot = path.join(repositoryRoot, relativeRoot);
    if (!(await exists(absoluteRoot))) continue;
    await collectPngFiles(absoluteRoot, relativeRoot, files);
  }
  return files.sort();
}

async function knownRuntimeAssetFiles(repositoryRoot: string): Promise<Set<string>> {
  return new Set([
    ...await discoverRuntimeAssetFiles(repositoryRoot),
    ...RUNTIME_PNG_ASSET_REGISTRY.map((registration) => registration.relativeFile)
  ]);
}

async function collectPngFiles(
  absoluteDirectory: string,
  relativeDirectory: string,
  files: string[]
): Promise<void> {
  const entries = await readdir(absoluteDirectory, { withFileTypes: true });
  for (const entry of entries) {
    const absoluteEntry = path.join(absoluteDirectory, entry.name);
    const relativeEntry = `${relativeDirectory}/${entry.name}`.replace(/\\/gu, "/");
    if (entry.isDirectory()) {
      await collectPngFiles(absoluteEntry, relativeEntry, files);
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".png")) {
      files.push(relativeEntry);
    }
  }
}

async function loadRuntimePresentation(
  catalogPath: string
): Promise<RuntimePngPresentationCatalog> {
  try {
    return parseRuntimePngPresentationCatalog(JSON.parse(await readFile(catalogPath, "utf8")));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new StudioBridgeError(500, "Runtime PNG presentation catalog contains invalid JSON");
    }
    throw error;
  }
}

async function loadProgressionIconCatalog(
  catalogPath: string
): Promise<ProgressionIconPresentationCatalog> {
  try {
    return parseProgressionIconPresentationCatalog(JSON.parse(await readFile(catalogPath, "utf8")));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new StudioBridgeError(500, "Progression icon presentation catalog contains invalid JSON");
    }
    throw error;
  }
}

async function loadProgressionIconInventory(
  catalogPath: string
): Promise<ProgressionIconInventory> {
  return {
    catalog: await loadProgressionIconCatalog(catalogPath),
    icons: PROGRESSION_ICON_REGISTRY.map((icon) => ({
      ...icon,
      imageUrl: `/runtime-assets/${icon.atlasPath}`
    }))
  };
}

async function publishProgressionIcons(input: {
  body: Partial<ProgressionIconPublishRequest>;
  repositoryRoot: string;
  catalogPath: string;
  progressionIconPresentationPath: string;
  stagingRoot: string;
  afterFileReplace?: (relativeFile: string, index: number) => Promise<void>;
}): Promise<ProgressionIconPublishResponse> {
  const lockPath = path.join(input.stagingRoot, "publish.lock");
  try {
    await writeFile(lockPath, `${process.pid}\n`, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new StudioBridgeError(409, "Another save is already in progress", "SAVE_IN_PROGRESS");
    }
    throw error;
  }

  const prepared: PreparedFile[] = [];
  try {
    const workspace = await requireWritableWorkspace(input.repositoryRoot, input.catalogPath);
    assertExpectedWorkspace(workspace, input.body.expectedWorkspace);
    const current = await loadProgressionIconCatalog(input.progressionIconPresentationPath);
    if (!Number.isInteger(input.body.expectedRevision) || input.body.expectedRevision !== current.revision) {
      throw new StudioBridgeError(
        409,
        `Progression icon revision conflict: expected ${input.body.expectedRevision ?? "missing"}, found ${current.revision}`,
        "CATALOG_REVISION_CONFLICT"
      );
    }
    let proposed: ProgressionIconPresentationCatalog;
    try {
      proposed = parseProgressionIconPresentationCatalog(input.body.catalog);
    } catch (error) {
      throw new StudioBridgeError(
        400,
        `Progression icon catalog is invalid: ${error instanceof Error ? error.message : "validation failed"}`,
        "INVALID_REQUEST"
      );
    }
    assertSameKeys(current.transforms, proposed.transforms, "progression icon");
    const changed = stableJson({ ...proposed, revision: current.revision }) !== stableJson(current);
    const catalog = parseProgressionIconPresentationCatalog({
      ...proposed,
      revision: current.revision + (changed ? 1 : 0)
    });
    if (changed) {
      const temporary = temporarySibling(input.progressionIconPresentationPath);
      await writeFile(temporary, stableJson(catalog), { encoding: "utf8", flag: "wx" });
      prepared.push({
        temporary,
        destination: input.progressionIconPresentationPath,
        relativeFile: PROGRESSION_ICON_PRESENTATION_RELATIVE_PATH
      });
    }
    await replacePreparedFiles({
      repositoryRoot: input.repositoryRoot,
      stagingRoot: input.stagingRoot,
      prepared,
      ...(input.afterFileReplace ? { afterFileReplace: input.afterFileReplace } : {})
    });
    return {
      catalog,
      inventory: {
        catalog,
        icons: PROGRESSION_ICON_REGISTRY.map((icon) => ({
          ...icon,
          imageUrl: `/runtime-assets/${icon.atlasPath}`
        }))
      },
      modifiedFiles: prepared.map((file) => file.relativeFile)
    };
  } finally {
    await Promise.all(prepared.map((file) => unlink(file.temporary).catch(() => undefined)));
    if (!(await exists(transactionPath(input.stagingRoot)))) {
      await unlink(lockPath).catch(() => undefined);
    }
  }
}

async function loadTerritoryStructureInventory(repositoryRoot: string,
  catalog?: TerritoryStructureCatalog): Promise<TerritoryStructureInventory> {
  const loaded = catalog ?? parseTerritoryStructureCatalog(JSON.parse(await readFile(
    path.join(repositoryRoot, TERRITORY_STRUCTURE_CATALOG_RELATIVE_PATH), "utf8"
  )));
  const files: string[] = [];
  const flagRoot = "apps/client/src/assets/flags";
  if (await exists(path.join(repositoryRoot, flagRoot))) await collectPngFiles(path.join(repositoryRoot, flagRoot), flagRoot, files);
  const shrine = "apps/client/src/assets/structures/atlas-shrine.png";
  if (await exists(path.join(repositoryRoot, shrine))) files.push(shrine);
  return { catalog: loaded, availableAssets: files.filter((asset) => TERRITORY_PNG_ASSET_PATTERN.test(asset) && !asset.includes("..")).sort() };
}

async function publishTerritoryStructures(input: {
  body: Partial<TerritoryStructurePublishRequest>;
  repositoryRoot: string; catalogPath: string; stagingRoot: string;
  afterFileReplace?: (relativeFile: string, index: number) => Promise<void>;
}): Promise<TerritoryStructurePublishResponse> {
  const lockPath = path.join(input.stagingRoot, "publish.lock");
  try {
    await writeFile(lockPath, `${process.pid}\n`, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new StudioBridgeError(409, "Another save is already in progress", "SAVE_IN_PROGRESS");
    }
    throw error;
  }
  const prepared: PreparedFile[] = [];
  try {
    const workspace = await requireWritableWorkspace(input.repositoryRoot, input.catalogPath);
    assertExpectedWorkspace(workspace, input.body.expectedWorkspace);
    const current = (await loadTerritoryStructureInventory(input.repositoryRoot)).catalog;
    if (!Number.isInteger(input.body.expectedRevision) || input.body.expectedRevision !== current.revision) {
      throw new StudioBridgeError(409, "Flags changed on disk. Reload Flags before saving.", "CATALOG_REVISION_CONFLICT");
    }
    let proposed: TerritoryStructureCatalog;
    try { proposed = parseTerritoryStructureCatalog(input.body.catalog); }
    catch (error) {
      throw new StudioBridgeError(400, `Invalid Flags definition: ${error instanceof Error ? error.message : "validation failed"}`, "INVALID_REQUEST");
    }
    const inventory = await loadTerritoryStructureInventory(input.repositoryRoot, proposed);
    const issues = territoryStructureValidationIssues(proposed, new Set(inventory.availableAssets));
    if (issues.length) throw new StudioBridgeError(400, issues.join("; "), "INVALID_REQUEST");
    const changed = stableJson({ ...proposed, revision: current.revision }) !== stableJson(current);
    const catalog = parseTerritoryStructureCatalog({ ...proposed, revision: current.revision + (changed ? 1 : 0) });
    if (changed) {
      const destination = path.join(input.repositoryRoot, TERRITORY_STRUCTURE_CATALOG_RELATIVE_PATH);
      const temporary = temporarySibling(destination);
      await writeFile(temporary, stableJson(catalog), { encoding: "utf8", flag: "wx" });
      prepared.push({ temporary, destination, relativeFile: TERRITORY_STRUCTURE_CATALOG_RELATIVE_PATH });
    }
    await replacePreparedFiles({
      repositoryRoot: input.repositoryRoot, stagingRoot: input.stagingRoot, prepared,
      ...(input.afterFileReplace ? { afterFileReplace: input.afterFileReplace } : {})
    });
    return { catalog, inventory: { ...inventory, catalog }, modifiedFiles: prepared.map((file) => file.relativeFile) };
  } finally {
    await Promise.all(prepared.map((file) => unlink(file.temporary).catch(() => undefined)));
    if (!(await exists(transactionPath(input.stagingRoot)))) await unlink(lockPath).catch(() => undefined);
  }
}

async function publishRuntimeAssets(input: {
  body: Partial<RuntimeAssetPublishRequest>;
  repositoryRoot: string;
  catalogPath: string;
  runtimePresentationPath: string;
  stagingRoot: string;
  stagedAssets: Map<string, StagedAsset>;
  afterFileReplace?: (relativeFile: string, index: number) => Promise<void>;
}): Promise<RuntimeAssetPublishResponse> {
  const lockPath = path.join(input.stagingRoot, "publish.lock");
  try {
    await writeFile(lockPath, `${process.pid}\n`, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new StudioBridgeError(409, "Another save is already in progress", "SAVE_IN_PROGRESS");
    }
    throw error;
  }

  const prepared: PreparedFile[] = [];
  try {
    const workspace = await requireWritableWorkspace(input.repositoryRoot, input.catalogPath);
    assertExpectedWorkspace(workspace, input.body.expectedWorkspace);
    const current = await loadRuntimePresentation(input.runtimePresentationPath);
    if (
      !Number.isInteger(input.body.expectedPresentationRevision) ||
      input.body.expectedPresentationRevision !== current.revision
    ) {
      throw new StudioBridgeError(
        409,
        `PNG presentation revision conflict: expected ${
          input.body.expectedPresentationRevision ?? "missing"
        }, found ${current.revision}`,
        "CATALOG_REVISION_CONFLICT"
      );
    }
    const proposed = parseRuntimePngPresentationCatalog(input.body.presentation);
    assertSameKeys(current.sprites, proposed.sprites, "sprite presentation");
    assertSameKeys(current.fixed, proposed.fixed, "fixed presentation");

    const changed = stableJson({
      ...proposed,
      revision: current.revision
    }) !== stableJson(current);
    const presentation = parseRuntimePngPresentationCatalog({
      ...proposed,
      revision: current.revision + (changed ? 1 : 0)
    });
    if (changed) {
      const temporary = temporarySibling(input.runtimePresentationPath);
      await writeFile(temporary, stableJson(presentation), { encoding: "utf8", flag: "wx" });
      prepared.push({
        temporary,
        destination: input.runtimePresentationPath,
        relativeFile: RUNTIME_PNG_PRESENTATION_RELATIVE_PATH
      });
    }

    const runtimeAssets = [...input.stagedAssets.values()].filter(
      (asset) => asset.assetScope === "runtime"
    );
    const knownFiles = await knownRuntimeAssetFiles(input.repositoryRoot);
    for (const asset of runtimeAssets) {
      const isInboxImport = asset.importSource === "atlas-png-inbox";
      if (!knownFiles.has(asset.assetKey) && !isInboxImport) {
        throw new StudioBridgeError(400, `Runtime asset is no longer recognized: ${asset.assetKey}`);
      }
      validatePng(asset.buffer);
      const destination = await safePath(input.repositoryRoot, asset.assetKey);
      if (await exists(destination)) {
        const existingHash = await fileHash(destination);
        if (existingHash === asset.contentHash) continue;
        if (isInboxImport) {
          throw new StudioBridgeError(
            409,
            `The target ${asset.assetKey} changed after inbox import; refresh and import again`,
            "FILESYSTEM_CONFLICT"
          );
        }
      }
      await mkdir(path.dirname(destination), { recursive: true });
      const temporary = temporarySibling(destination);
      await writeFile(temporary, asset.buffer, { flag: "wx" });
      prepared.push({ temporary, destination, relativeFile: asset.relativeFile });
    }

    await replacePreparedFiles({
      repositoryRoot: input.repositoryRoot,
      stagingRoot: input.stagingRoot,
      prepared,
      ...(input.afterFileReplace ? { afterFileReplace: input.afterFileReplace } : {})
    });
    await Promise.all(runtimeAssets.map(async (asset) => {
      input.stagedAssets.delete(asset.stagingToken);
      await removeStagedAsset(input.stagingRoot, asset.stagingToken);
    }));
    return {
      presentation,
      inventory: await loadRuntimeAssetInventory(
        input.repositoryRoot,
        input.runtimePresentationPath,
        input.stagedAssets
      ),
      modifiedFiles: prepared.map((file) => file.relativeFile).sort()
    };
  } finally {
    await Promise.all(prepared.map((file) => unlink(file.temporary).catch(() => undefined)));
    if (!(await exists(transactionPath(input.stagingRoot)))) {
      await unlink(lockPath).catch(() => undefined);
    }
  }
}

function assertExpectedWorkspace(
  workspace: Awaited<ReturnType<typeof inspectWorkspace>>,
  expectedWorkspace: RuntimeAssetPublishRequest["expectedWorkspace"] | undefined
): void {
  if (
    !expectedWorkspace ||
    typeof expectedWorkspace.worktreePath !== "string" ||
    !(typeof expectedWorkspace.branch === "string" || expectedWorkspace.branch === null) ||
    typeof expectedWorkspace.commitSha !== "string"
  ) {
    throw new StudioBridgeError(400, "Expected workspace identity is required", "INVALID_REQUEST");
  }
  if (
    canonicalPath(workspace.worktreePath) !== canonicalPath(expectedWorkspace.worktreePath) ||
    workspace.branch !== expectedWorkspace.branch ||
    workspace.commitSha.toLowerCase() !== expectedWorkspace.commitSha.toLowerCase()
  ) {
    throw new StudioBridgeError(
      409,
      "The worktree branch or commit changed after this editor session loaded",
      "WORKSPACE_CHANGED"
    );
  }
}

function assertSameKeys(
  current: Readonly<Record<string, unknown>>,
  proposed: Readonly<Record<string, unknown>>,
  label: string
): void {
  const currentKeys = Object.keys(current).sort();
  const proposedKeys = Object.keys(proposed).sort();
  if (stableJson(currentKeys) !== stableJson(proposedKeys)) {
    throw new StudioBridgeError(400, `The ${label} key set cannot be changed in Asset Studio`);
  }
}

async function loadDungeonCatalog(catalogPath: string): Promise<DungeonCatalog> {
  try {
    return await loadDungeonCatalogFromInteriors(catalogPath);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new StudioBridgeError(500, "Dungeon catalog contains invalid JSON");
    }
    throw error;
  }
}

async function loadInteriorCatalog(directory: string): Promise<InteriorCatalogSnapshot> {
  try {
    return interiorSnapshot((await readDungeonInteriorFiles(directory)).interior);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new StudioBridgeError(500, "Interior catalog contains invalid JSON");
    }
    throw error;
  }
}

/** Staged PNGs an interior publish may promote: dungeon and Manor art, and Greenhouse runtime PNG replacements. */
function isInteriorPublishAsset(asset: Pick<StagedAsset, "assetScope" | "assetKey">): boolean {
  return asset.assetScope === "dungeon" || asset.assetScope === "manor" || isGreenhouseRuntimeAsset(asset);
}

function isGreenhouseRuntimeAsset(asset: Pick<StagedAsset, "assetScope" | "assetKey">): boolean {
  return asset.assetScope === "runtime" && (
    asset.assetKey === "apps/client/src/assets/structures/greenhouse.png" ||
    asset.assetKey === "apps/client/src/assets/structures/greenhouse-floor.png" ||
    asset.assetKey === "apps/client/src/assets/structures/greenhouse-pot.png" ||
    asset.assetKey === "apps/client/src/assets/structures/greenhouse-water-tank.png" ||
    asset.assetKey.startsWith("apps/client/src/assets/structures/greenhouse-overlays/") ||
    asset.assetKey.startsWith("apps/client/src/assets/plants/wheat-") ||
    asset.assetKey.startsWith("apps/client/src/assets/plants/giving-berry-tree-")
  );
}

async function publishInteriorSpaces(input: {
  body: Partial<InteriorSpacePublishRequest>;
  spaceId: string;
  repositoryRoot: string;
  appearanceCatalogPath: string;
  interiorCatalogPath: string;
  stagingRoot: string;
  stagedAssets: Map<string, StagedAsset>;
  beforeCatalogReplace?: () => Promise<void>;
  afterFileReplace?: (relativeFile: string, index: number) => Promise<void>;
}): Promise<InteriorSpacePublishResponse> {
  const lockPath = path.join(input.stagingRoot, "publish.lock");
  try {
    await writeFile(lockPath, `${process.pid}\n`, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new StudioBridgeError(409, "Another save is already in progress", "SAVE_IN_PROGRESS");
    }
    throw error;
  }

  const prepared: PreparedFile[] = [];
  try {
    const workspace = await requireWritableWorkspace(
      input.repositoryRoot,
      input.appearanceCatalogPath
    );
    assertExpectedWorkspace(workspace, input.body.expectedWorkspace);
    if (!Number.isInteger(input.body.expectedCatalogRevision)) {
      throw new StudioBridgeError(400, "Expected interior catalog revision is required");
    }
    let interiorFiles: Awaited<ReturnType<typeof readDungeonInteriorFiles>>;
    try {
      interiorFiles = await readDungeonInteriorFiles(input.interiorCatalogPath);
    } catch (error) {
      if (error instanceof SyntaxError) throw new StudioBridgeError(500, "Interior catalog contains invalid JSON");
      throw error;
    }
    const { texts, interior: current } = interiorFiles;
    if (input.body.expectedCatalogRevision !== current.library.catalogRevision) {
      throw new StudioBridgeError(
        409,
        `Interior catalog changed on disk: expected ${input.body.expectedCatalogRevision}, ` +
          `found ${current.library.catalogRevision}`,
        "CATALOG_REVISION_CONFLICT"
      );
    }

    const rawSpaces = [input.body.space, ...(input.body.alsoSpaces ?? [])];
    const spaces: InteriorSpace[] = [];
    for (const raw of rawSpaces) {
      const parsed = interiorSpaceSchema.safeParse(raw);
      if (!parsed.success) {
        throw new StudioBridgeError(
          400,
          `Invalid interior space: ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "$"}: ${issue.message}`).join("; ")}`,
          "INTERIOR_SPACE_INVALID"
        );
      }
      spaces.push(parsed.data);
    }
    if (spaces[0]!.id !== input.spaceId) {
      throw new StudioBridgeError(400, "The published space does not match the requested space id", "INTERIOR_SPACE_MISMATCH");
    }
    if (new Set(spaces.map((space) => space.id)).size !== spaces.length) {
      throw new StudioBridgeError(400, "Each space can be published once per save", "INTERIOR_SPACE_MISMATCH");
    }
    const expectedRevisions = input.body.expectedSpaceRevisions;
    if (!expectedRevisions || typeof expectedRevisions !== "object") {
      throw new StudioBridgeError(400, "Expected space revisions are required");
    }
    for (const space of spaces) {
      const existing = current.spaces.find((candidate) => candidate.id === space.id);
      const expected = expectedRevisions[space.id];
      if (expected === undefined) throw new StudioBridgeError(400, `Expected revision for space ${space.id} is required`);
      if (existing ? expected !== existing.revision : expected !== null) {
        throw new StudioBridgeError(
          409,
          `Interior space ${space.id} changed on disk: expected ${expected ?? "a new space"}, found ${existing?.revision ?? "no such space"}`,
          "SPACE_REVISION_CONFLICT"
        );
      }
      if (existing && existing.kind !== space.kind) {
        throw new StudioBridgeError(400, `Interior space ${space.id} cannot change kind from ${existing.kind} to ${space.kind}`, "INTERIOR_KIND_IMMUTABLE");
      }
    }

    let library: InteriorLibrary = current.library;
    if (input.body.library !== undefined) {
      const parsed = interiorLibrarySchema.safeParse(input.body.library);
      if (!parsed.success) {
        throw new StudioBridgeError(
          400,
          `Invalid interior library: ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "$"}: ${issue.message}`).join("; ")}`,
          "INTERIOR_LIBRARY_INVALID"
        );
      }
      library = { ...parsed.data, catalogRevision: current.library.catalogRevision };
    }
    const proposed = withInteriorSpaces(current, library, spaces);
    const deleted = interiorIdPreservationIssues(current, proposed);
    if (deleted.length > 0) {
      throw new StudioBridgeError(
        400,
        `Published interior IDs cannot be deleted: ${deleted.join("; ")}. Retire them instead.`,
        "STABLE_ID_DELETION"
      );
    }
    const issues = interiorCatalogValidationIssues(proposed);
    if (issues.length > 0) {
      throw new StudioBridgeError(
        400,
        `Invalid interior catalog: ${issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ")}`,
        "INTERIOR_CATALOG_INVALID"
      );
    }
    const unbumped = interiorRevisionIdentityIssues(current, proposed);
    for (const space of spaces) {
      if (space.kind !== "manor") continue;
      const existing = current.spaces.find((candidate) => candidate.id === space.id);
      if (!space.publishedRevisionId) {
        unbumped.push(`manor space ${space.id} needs a published revision identity`);
      } else if (existing &&
        stableJson({ ...existing, revision: "", publishedRevisionId: "" }) !== stableJson({ ...space, revision: "", publishedRevisionId: "" }) &&
        existing.publishedRevisionId === space.publishedRevisionId) {
        unbumped.push(`manor space ${space.id} changed without a new published revision identity`);
      }
    }
    if (unbumped.length > 0) {
      throw new StudioBridgeError(
        400,
        `Changed interior rooms and spaces need a new revision: ${unbumped.join("; ")}`,
        "INTERIOR_REVISION_ID_REQUIRED"
      );
    }

    const pendingTokens = input.body.pendingAssetTokens ?? [];
    if (!Array.isArray(pendingTokens) || pendingTokens.some((token) => typeof token !== "string") ||
      new Set(pendingTokens).size !== pendingTokens.length) {
      throw new StudioBridgeError(400, "Pending interior asset tokens are invalid");
    }
    const pendingAssets = pendingTokens.map((token) => input.stagedAssets.get(token));
    if (pendingAssets.some((asset) => !asset || !isInteriorPublishAsset(asset))) {
      throw new StudioBridgeError(400, "Every pending asset token must be a dungeon, Manor or Greenhouse asset", "INTERIOR_ASSET_TOKEN_INVALID");
    }
    const stagedAssets = pendingAssets as StagedAsset[];
    const referencedKeys = new Set<string>();
    for (const prefab of library.prefabs) {
      referencedKeys.add(prefab.assetKey);
      for (const state of prefab.stateAssets) referencedKeys.add(state.assetKey);
    }
    const manorKeys = new Set<string>();
    for (const space of spaces) {
      if (space.kind !== "manor") continue;
      if (space.environment.floorAssetKey) manorKeys.add(space.environment.floorAssetKey);
      if (space.modules?.manor) manorKeys.add(space.modules.manor.exteriorAssetKey);
      for (const decoration of space.modules?.decoration?.definitions ?? []) {
        if (!decoration.retired) manorKeys.add(decoration.assetKey);
      }
    }
    for (const key of manorKeys) referencedKeys.add(key);
    const knownRuntimeFiles = stagedAssets.some((asset) => asset.assetScope === "runtime") ? await knownRuntimeAssetFiles(input.repositoryRoot) : new Set<string>();
    for (const asset of stagedAssets) {
      if (asset.assetScope === "runtime") {
        // An in-place replacement of a registered Greenhouse runtime PNG (template art, plant stage art).
        if (!knownRuntimeFiles.has(asset.assetKey)) {
          throw new StudioBridgeError(400, `Greenhouse runtime asset is not registered: ${asset.assetKey}`, "GREENHOUSE_ASSET_UNREGISTERED");
        }
      } else if (!referencedKeys.has(asset.assetKey)) {
        throw new StudioBridgeError(400, "Staged interior asset is not referenced by a library prefab, Manor decoration or Manor exterior", "INTERIOR_ASSET_UNREFERENCED");
      }
      validatePng(asset.buffer);
    }
    const currentPrefabIds = new Set(current.library.prefabs.map((prefab) => prefab.id));
    const requiredKeys = new Set<string>(manorKeys);
    for (const prefab of library.prefabs) if (!currentPrefabIds.has(prefab.id)) requiredKeys.add(prefab.assetKey);
    for (const key of requiredKeys) {
      if (stagedAssets.some((asset) => asset.assetKey === key)) continue;
      if (!(await exists(await safePath(input.repositoryRoot, key)))) {
        throw new StudioBridgeError(400, `Interior asset is missing: ${key}`, "INTERIOR_ASSET_MISSING");
      }
    }
    const replaceableKeys = new Set<string>();
    for (const prefab of current.library.prefabs) {
      replaceableKeys.add(prefab.assetKey);
      for (const state of prefab.stateAssets) replaceableKeys.add(state.assetKey);
    }

    const changedSpaces = spaces.filter((space) => {
      const existing = current.spaces.find((candidate) => candidate.id === space.id);
      return !existing || stableJson(existing) !== stableJson(space);
    });
    const libraryChanged = stableJson({ ...current.library, catalogRevision: 0 }) !== stableJson({ ...library, catalogRevision: 0 });
    if (changedSpaces.length === 0 && !libraryChanged && stagedAssets.length === 0) return { ...interiorSnapshot(current), modifiedFiles: [] };

    const published = withInteriorSpaces(
      current,
      { ...library, catalogRevision: current.library.catalogRevision + 1 },
      changedSpaces
    );
    for (const asset of stagedAssets) {
      const destination = await safePath(input.repositoryRoot, asset.relativeFile);
      if (await exists(destination) && asset.assetScope !== "runtime" && !replaceableKeys.has(asset.assetKey)) {
        throw new StudioBridgeError(409, "Interior asset target appeared after staging", "FILESYSTEM_CONFLICT");
      }
      await mkdir(path.dirname(destination), { recursive: true });
      const temporary = temporarySibling(destination);
      await writeFile(temporary, asset.buffer, { flag: "wx" });
      prepared.push({ temporary, destination, relativeFile: asset.relativeFile });
    }
    for (const write of planInteriorSpaceWrites(texts, current, changedSpaces, published.library)) {
      const destination = path.join(input.interiorCatalogPath, write.fileName);
      const temporary = temporarySibling(destination);
      await writeFile(temporary, write.text, { encoding: "utf8", flag: "wx" });
      prepared.push({ temporary, destination, relativeFile: `${INTERIOR_DATA_RELATIVE_DIR}/${write.fileName}` });
    }
    await input.beforeCatalogReplace?.();
    await replacePreparedFiles({
      repositoryRoot: input.repositoryRoot,
      stagingRoot: input.stagingRoot,
      prepared,
      ...(input.afterFileReplace ? { afterFileReplace: input.afterFileReplace } : {})
    });
    for (const token of pendingTokens) {
      input.stagedAssets.delete(token);
      await removeStagedAsset(input.stagingRoot, token);
    }
    return { ...interiorSnapshot(published), modifiedFiles: prepared.map((file) => file.relativeFile).sort() };
  } finally {
    await Promise.all(prepared.map((file) => unlink(file.temporary).catch(() => undefined)));
    await unlink(lockPath).catch(() => undefined);
  }
}

async function publishAppearanceContent(input: {
  body: Partial<StudioPublishRequest>;
  repositoryRoot: string;
  catalogPath: string;
  bossCatalogPath: string;
  itemVariantCatalogPath: string;
  assetRoot: string;
  bossAssetRoot: string;
  stagingRoot: string;
  stagedAssets: Map<string, StagedAsset>;
  beforeCatalogReplace?: () => Promise<void>;
  afterFileReplace?: (relativeFile: string, index: number) => Promise<void>;
}): Promise<StudioPublishResponse> {
  const lockPath = path.join(input.stagingRoot, "publish.lock");
  try {
    await writeFile(lockPath, `${process.pid}\n`, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new StudioBridgeError(409, "Another save is already in progress", "SAVE_IN_PROGRESS");
    }
    throw error;
  }

  const prepared: PreparedFile[] = [];
  try {
    const workspace = await requireWritableWorkspace(input.repositoryRoot, input.catalogPath);
    const expectedWorkspace = input.body.expectedWorkspace;
    if (
      !expectedWorkspace ||
      typeof expectedWorkspace.worktreePath !== "string" ||
      !(typeof expectedWorkspace.branch === "string" || expectedWorkspace.branch === null) ||
      typeof expectedWorkspace.commitSha !== "string"
    ) {
      throw new StudioBridgeError(400, "Expected workspace identity is required", "INVALID_REQUEST");
    }
    if (
      canonicalPath(workspace.worktreePath) !== canonicalPath(expectedWorkspace.worktreePath) ||
      workspace.branch !== expectedWorkspace.branch ||
      workspace.commitSha.toLowerCase() !== expectedWorkspace.commitSha.toLowerCase()
    ) {
      throw new StudioBridgeError(
        409,
        "The worktree branch or commit changed after this editor session loaded",
        "WORKSPACE_CHANGED"
      );
    }

    const current = await loadCatalog(input.catalogPath, workspace);
    const currentBossCatalog = await loadBossCatalog(input.bossCatalogPath);
    if (
      !Number.isInteger(input.body.expectedCatalogRevision) ||
      input.body.expectedCatalogRevision !== current.catalogRevision
    ) {
      throw new StudioBridgeError(
        409,
        `Catalog revision conflict: expected ${input.body.expectedCatalogRevision ?? "missing"}, ` +
          `found ${current.catalogRevision}`,
        "CATALOG_REVISION_CONFLICT"
      );
    }
    if (
      !Number.isInteger(input.body.expectedBossCatalogRevision) ||
      input.body.expectedBossCatalogRevision !== currentBossCatalog.catalogRevision
    ) {
      throw new StudioBridgeError(
        409,
        `Boss catalog revision conflict: expected ${
          input.body.expectedBossCatalogRevision ?? "missing"
        }, found ${currentBossCatalog.catalogRevision}`,
        "CATALOG_REVISION_CONFLICT"
      );
    }

    const proposed = parsePlayerAppearanceCatalog(input.body.catalog);
    const supportsEnhancements = workspaceSupportsEquipmentEnhancements(workspace);
    if (!supportsEnhancements) assertLegacyEnhancementContent(proposed);
    const proposedBossCatalog = parseBossAppearanceCatalog(input.body.bossCatalog);
    const itemVariants = parseItemVariantCatalog(input.body.itemVariants);
    validateVariantAppearanceLinks(proposed, itemVariants);
    const playerPublishAssets = await validateCatalogAssets(
      proposed,
      input.assetRoot,
      input.stagedAssets,
      "player",
      enhancementAssetKeysForWorkspace(proposed, workspace)
    );
    const persistedCurrent = catalogForWorkspaceContract(current, workspace);
    const persistedProposed = catalogForWorkspaceContract(proposed, workspace);
    const playerCatalogChanged = stableJson({
      ...persistedProposed,
      catalogRevision: current.catalogRevision
    }) !== stableJson(persistedCurrent) || playerPublishAssets.length > 0;
    const bossContentChanged = stableJson({
      ...proposedBossCatalog,
      catalogRevision: currentBossCatalog.catalogRevision
    }) !== stableJson(currentBossCatalog);
    const bossCatalogExists = await exists(input.bossCatalogPath);
    const bossPublishAssets = bossCatalogExists || bossContentChanged
      ? await validateBossCatalogAssets(
          proposedBossCatalog,
          input.bossAssetRoot,
          input.stagedAssets
        )
      : [];
    const publishAssets = [...playerPublishAssets, ...bossPublishAssets];
    const bossCatalogChanged = bossContentChanged || bossPublishAssets.length > 0;
    const catalog = parsePlayerAppearanceCatalog({
      ...proposed,
      catalogRevision: current.catalogRevision + (playerCatalogChanged ? 1 : 0)
    });
    const bossCatalog = parseBossAppearanceCatalog({
      ...proposedBossCatalog,
      catalogRevision: currentBossCatalog.catalogRevision + (bossCatalogChanged ? 1 : 0)
    });
    const currentItemVariants = await loadItemVariantCatalog(input.itemVariantCatalogPath);
    const catalogOutput = stableJson(catalogForWorkspaceContract(catalog, workspace));
    const bossCatalogOutput = stableJson(bossCatalog);
    const variantOutput = stableJson(itemVariants);
    const currentVariantOutput = stableJson(currentItemVariants);

    for (const asset of publishAssets) {
      const destination = await safePath(
        asset.assetScope === "boss" ? input.bossAssetRoot : input.assetRoot,
        asset.assetKey
      );
      if (await exists(destination)) {
        const existingHash = await fileHash(destination);
        if (existingHash === asset.contentHash) continue;
      }
      await mkdir(path.dirname(destination), { recursive: true });
      const temporary = temporarySibling(destination);
      await writeFile(temporary, asset.buffer, { flag: "wx" });
      prepared.push({ temporary, destination, relativeFile: asset.relativeFile });
    }

    if (playerCatalogChanged) {
      const catalogTemporary = temporarySibling(input.catalogPath);
      await writeFile(catalogTemporary, catalogOutput, { encoding: "utf8", flag: "wx" });
      prepared.push({
        temporary: catalogTemporary,
        destination: input.catalogPath,
        relativeFile: APPEARANCE_CATALOG_RELATIVE_PATH
      });
    }
    if (bossCatalogChanged) {
      const bossCatalogTemporary = temporarySibling(input.bossCatalogPath);
      await writeFile(
        bossCatalogTemporary,
        bossCatalogOutput,
        { encoding: "utf8", flag: "wx" }
      );
      prepared.push({
        temporary: bossCatalogTemporary,
        destination: input.bossCatalogPath,
        relativeFile: BOSS_APPEARANCE_CATALOG_RELATIVE_PATH
      });
    }
    if (variantOutput !== currentVariantOutput) {
      const variantTemporary = temporarySibling(input.itemVariantCatalogPath);
      await writeFile(variantTemporary, variantOutput, { encoding: "utf8", flag: "wx" });
      prepared.push({
        temporary: variantTemporary,
        destination: input.itemVariantCatalogPath,
        relativeFile: ITEM_VARIANT_CATALOG_RELATIVE_PATH
      });
    }

    await input.beforeCatalogReplace?.();
    await replacePreparedFiles({
      repositoryRoot: input.repositoryRoot,
      stagingRoot: input.stagingRoot,
      prepared,
      ...(input.afterFileReplace ? { afterFileReplace: input.afterFileReplace } : {})
    });
    await Promise.all(publishAssets.map(async (asset) => {
      input.stagedAssets.delete(asset.stagingToken);
      await removeStagedAsset(input.stagingRoot, asset.stagingToken);
    }));
    return {
      catalog,
      bossCatalog,
      itemVariants,
      modifiedFiles: prepared.map((file) => file.relativeFile).sort()
    };
  } finally {
    await Promise.all(prepared.map((file) => unlink(file.temporary).catch(() => undefined)));
    if (!(await exists(transactionPath(input.stagingRoot)))) {
      await unlink(lockPath).catch(() => undefined);
    }
  }
}

type PublishTransactionEntry = {
  destination: string;
  backup: string | null;
  existed: boolean;
  oldHash: string | null;
  newHash: string;
};

type PublishTransaction = {
  repositoryRoot: string;
  entries: PublishTransactionEntry[];
};

async function replacePreparedFiles(input: {
  repositoryRoot: string;
  stagingRoot: string;
  prepared: PreparedFile[];
  afterFileReplace?: (relativeFile: string, index: number) => Promise<void>;
}): Promise<void> {
  const transactionId = randomBytes(12).toString("hex");
  const entries: PublishTransactionEntry[] = [];
  try {
    for (const [index, file] of input.prepared.entries()) {
      assertInside(input.repositoryRoot, file.destination);
      const existed = await exists(file.destination);
      const backup = existed
        ? path.join(input.stagingRoot, `publish-${transactionId}-${index}.backup`)
        : null;
      if (backup) await copyFile(file.destination, backup);
      entries.push({
        destination: file.destination,
        backup,
        existed,
        oldHash: existed ? await fileHash(file.destination) : null,
        newHash: await fileHash(file.temporary)
      });
    }
    for (const entry of entries) {
      const stillExists = await exists(entry.destination);
      const unchanged = entry.existed
        ? stillExists && await fileHash(entry.destination) === entry.oldHash
        : !stillExists;
      if (!unchanged) {
        throw new StudioBridgeError(
          409,
          "Appearance files changed while this save was being prepared",
          "FILESYSTEM_CONFLICT"
        );
      }
    }
    await writeTransaction(input.stagingRoot, {
      repositoryRoot: input.repositoryRoot,
      entries
    });
    for (const [index, file] of input.prepared.entries()) {
      await rename(file.temporary, file.destination);
      await input.afterFileReplace?.(file.relativeFile, index);
    }
    await unlink(transactionPath(input.stagingRoot));
    await Promise.all(entries.map((entry) =>
      entry.backup ? unlink(entry.backup).catch(() => undefined) : Promise.resolve()
    ));
  } catch (error) {
    if (await exists(transactionPath(input.stagingRoot))) {
      await recoverPublishTransaction(input.stagingRoot, input.repositoryRoot);
    } else {
      await Promise.all(entries.map((entry) =>
        entry.backup ? unlink(entry.backup).catch(() => undefined) : Promise.resolve()
      ));
    }
    throw error;
  }
}

async function writeTransaction(
  stagingRoot: string,
  transaction: PublishTransaction
): Promise<void> {
  const destination = transactionPath(stagingRoot);
  const temporary = `${destination}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(transaction, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx"
  });
  await rename(temporary, destination);
}

async function recoverPublishTransaction(
  stagingRoot: string,
  repositoryRoot: string
): Promise<void> {
  const journal = transactionPath(stagingRoot);
  if (!(await exists(journal))) {
    await unlink(path.join(stagingRoot, "publish.lock")).catch(() => undefined);
    return;
  }
  const transaction = JSON.parse(await readFile(journal, "utf8")) as PublishTransaction;
  if (canonicalPath(transaction.repositoryRoot) !== canonicalPath(repositoryRoot)) {
    throw new Error("Appearance Studio transaction belongs to a different worktree");
  }
  for (const [index, entry] of transaction.entries.entries()) {
    assertInside(repositoryRoot, entry.destination);
    if (entry.existed) {
      if (!entry.backup || !(await exists(entry.backup))) {
        throw new Error("Appearance Studio transaction backup is missing");
      }
      const restoreTemporary = `${entry.destination}.${process.pid}.${index}.restore`;
      await copyFile(entry.backup, restoreTemporary);
      await rename(restoreTemporary, entry.destination);
    } else if (await exists(entry.destination)) {
      if (await fileHash(entry.destination) !== entry.newHash) {
        throw new Error("Appearance Studio recovery found an unexpected destination file");
      }
      await unlink(entry.destination);
    }
  }
  await unlink(journal);
  await Promise.all(transaction.entries.map((entry) =>
    entry.backup ? unlink(entry.backup).catch(() => undefined) : Promise.resolve()
  ));
  await unlink(path.join(stagingRoot, "publish.lock")).catch(() => undefined);
}

async function rejectActivePublishLock(stagingRoot: string): Promise<void> {
  const activeLockPath = path.join(stagingRoot, "publish.lock");
  try {
    const ownerPid = Number.parseInt(await readFile(activeLockPath, "utf8"), 10);
    if (Number.isInteger(ownerPid) && ownerPid > 0 && processIsRunning(ownerPid)) {
      throw new Error(
        `Another Appearance Studio process (${ownerPid}) is saving this worktree`
      );
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}

function processIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function transactionPath(stagingRoot: string): string {
  return path.join(stagingRoot, "publish-transaction.json");
}

async function loadStagedAssets(stagingRoot: string): Promise<Map<string, StagedAsset>> {
  const assets = new Map<string, StagedAsset>();
  for (const fileName of await readdir(stagingRoot)) {
    const match = /^asset-([A-Za-z0-9_-]+)\.json$/u.exec(fileName);
    if (!match?.[1]) continue;
    const token = match[1];
    const metadataPath = path.join(stagingRoot, fileName);
    const bufferPath = path.join(stagingRoot, `asset-${token}.png`);
    try {
      const metadata = JSON.parse(await readFile(metadataPath, "utf8")) as Omit<StagedAsset, "buffer">;
      const buffer = await readFile(bufferPath);
      const assetScope = metadata.assetScope === "boss" ? "boss" : metadata.assetScope === "runtime" ? "runtime" : metadata.assetScope === "dungeon" ? "dungeon" : metadata.assetScope === "manor" ? "manor" : "player";
      if (
        metadata.stagingToken !== token ||
        typeof metadata.assetKey !== "string" ||
        typeof metadata.relativeFile !== "string" ||
        typeof metadata.contentHash !== "string" ||
        !Number.isFinite(metadata.createdAt) ||
        Date.now() - metadata.createdAt > 7 * 24 * 60 * 60_000 ||
        createHash("sha256").update(buffer).digest("hex") !== metadata.contentHash
      ) {
        throw new Error("Invalid staged asset metadata");
      }
      validatePng(buffer);
      assets.set(token, {
        ...metadata,
        assetScope,
        ...(metadata.importSource === "atlas-png-inbox"
          ? { importSource: "atlas-png-inbox" as const }
          : {}),
        buffer
      });
    } catch {
      await Promise.all([
        unlink(metadataPath).catch(() => undefined),
        unlink(bufferPath).catch(() => undefined)
      ]);
    }
  }
  return assets;
}

async function persistStagedAsset(stagingRoot: string, asset: StagedAsset): Promise<void> {
  const bufferPath = path.join(stagingRoot, `asset-${asset.stagingToken}.png`);
  const metadataPath = path.join(stagingRoot, `asset-${asset.stagingToken}.json`);
  await writeFile(bufferPath, asset.buffer, { flag: "wx" });
  try {
    await writeFile(metadataPath, `${JSON.stringify({
      stagingToken: asset.stagingToken,
      assetScope: asset.assetScope,
      assetKey: asset.assetKey,
      relativeFile: asset.relativeFile,
      contentHash: asset.contentHash,
      createdAt: asset.createdAt,
      ...(asset.importSource ? { importSource: asset.importSource } : {})
    }, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    await unlink(bufferPath).catch(() => undefined);
    throw error;
  }
}

async function removeStagedAsset(stagingRoot: string, token: string): Promise<void> {
  await Promise.all([
    unlink(path.join(stagingRoot, `asset-${token}.json`)).catch(() => undefined),
    unlink(path.join(stagingRoot, `asset-${token}.png`)).catch(() => undefined)
  ]);
}

function temporarySibling(destination: string): string {
  return `${destination}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
}

async function fileHash(filePath: string): Promise<string> {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

function canonicalPath(value: string): string {
  return value.replaceAll("\\", "/").replace(/\/+$/u, "").toLowerCase();
}

async function loadCatalog(
  catalogPath: string,
  workspace?: Awaited<ReturnType<typeof inspectWorkspace>>
): Promise<PlayerAppearanceCatalog> {
  try {
    const value: unknown = JSON.parse(await readFile(catalogPath, "utf8"));
    return parsePlayerAppearanceCatalog(catalogForDesktopParsing(value, workspace));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new StudioBridgeError(500, "Appearance catalog contains invalid JSON");
    }
    throw error;
  }
}

async function loadBossCatalog(
  catalogPath: string
): Promise<BossAppearanceCatalog> {
  try {
    return parseBossAppearanceCatalog(
      JSON.parse(await readFile(catalogPath, "utf8"))
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return structuredClone(DEFAULT_BOSS_APPEARANCE_CATALOG);
    }
    if (error instanceof SyntaxError) {
      throw new StudioBridgeError(500, "Boss appearance catalog contains invalid JSON");
    }
    throw error;
  }
}

async function inspectCatalogRevision(catalogPath: string): Promise<number> {
  try {
    const parsed = JSON.parse(await readFile(catalogPath, "utf8")) as {
      catalogRevision?: unknown;
    };
    return Number.isInteger(parsed.catalogRevision) &&
        (parsed.catalogRevision as number) >= 0
      ? parsed.catalogRevision as number
      : 0;
  } catch {
    return 0;
  }
}

async function assertCompatibleWorkspace(
  repositoryRoot: string,
  catalogPath: string
): Promise<Awaited<ReturnType<typeof inspectWorkspace>>> {
  const workspace = await inspectWorkspace(
    repositoryRoot,
    await inspectCatalogRevision(catalogPath)
  );
  if (workspace.compatibility.compatible) return workspace;
  throw new StudioBridgeError(
    409,
    `Appearance Studio update required: worktree contract ${
      workspace.compatibility.contractVersion ?? "missing"
    } requires desktop ${
      workspace.compatibility.minimumDesktopVersion ?? "metadata unavailable"
    } or newer; this app supports through contract ${
      workspace.compatibility.supportedContractVersion
    }.`
  );
}

export async function validateRepositoryAppearanceContent(
  repositoryRoot: string
): Promise<void> {
  const runtimePresentation = await loadRuntimePresentation(path.join(
    repositoryRoot,
    RUNTIME_PNG_PRESENTATION_RELATIVE_PATH
  ));
  await loadRuntimeAssetMetadata(
    repositoryRoot,
    await discoverRuntimeAssetFiles(repositoryRoot),
    runtimePresentation
  );
  const catalogPath = path.join(repositoryRoot, APPEARANCE_CATALOG_RELATIVE_PATH);
  const workspace = await inspectWorkspace(
    repositoryRoot,
    await inspectCatalogRevision(catalogPath)
  );
  const catalog = await loadCatalog(catalogPath, workspace);
  const itemVariants = await loadItemVariantCatalog(path.join(
    repositoryRoot,
    ITEM_VARIANT_CATALOG_RELATIVE_PATH
  ));
  const bossCatalog = await loadBossCatalog(path.join(
    repositoryRoot,
    BOSS_APPEARANCE_CATALOG_RELATIVE_PATH
  ));
  validateVariantAppearanceLinks(catalog, itemVariants);
  await validateCatalogAssets(
    catalog,
    path.join(repositoryRoot, APPEARANCE_ASSET_ROOT_RELATIVE_PATH),
    new Map(),
    "player",
    enhancementAssetKeysForWorkspace(catalog, workspace)
  );
  await validateBossCatalogAssets(
    bossCatalog,
    path.join(repositoryRoot, BOSS_APPEARANCE_ASSET_ROOT_RELATIVE_PATH),
    new Map()
  );
  for (const relativeFile of await discoverRuntimeAssetFiles(repositoryRoot)) {
    validatePng(await readFile(await safePath(repositoryRoot, relativeFile)));
  }
}

async function loadItemVariantCatalog(
  catalogPath: string
): Promise<ItemVariantCatalog> {
  try {
    return parseItemVariantCatalog(
      JSON.parse(await readFile(catalogPath, "utf8"))
    );
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new StudioBridgeError(500, "Item variant catalog contains invalid JSON");
    }
    throw error;
  }
}

function validateVariantAppearanceLinks(
  catalog: PlayerAppearanceCatalog,
  itemVariants: ItemVariantCatalog
): void {
  for (const variant of itemVariants.variants) {
    const appearance = catalog.appearances.find(
      (candidate) => candidate.appearanceId === variant.appearanceId
    );
    if (!appearance) {
      throw new StudioBridgeError(
        400,
        `Item variant ${variant.definitionId} references missing appearance ${variant.appearanceId}`
      );
    }
    if (appearance.cosmetic) {
      throw new StudioBridgeError(
        400,
        `Item variant ${variant.definitionId} must reference a non-cosmetic appearance`
      );
    }
    if (!appearanceCompatibleWithEquipment(
      catalog,
      appearance.appearanceId,
      EQUIPMENT_GAMEPLAY_FAMILIES[variant.familyId].authoringBaseDefinitionId
    )) {
      const authoringBaseDefinitionId = EQUIPMENT_GAMEPLAY_FAMILIES[
        variant.familyId
      ].authoringBaseDefinitionId;
      throw new StudioBridgeError(
        400,
        `Appearance ${appearance.appearanceId} is not compatible with equipment family ${variant.familyId} (${authoringBaseDefinitionId})`
      );
    }
  }
}

async function requireWritableWorkspace(
  repositoryRoot: string,
  catalogPath: string
): Promise<Awaited<ReturnType<typeof inspectWorkspace>>> {
  const workspace = await inspectWorkspace(
    repositoryRoot,
    await inspectCatalogRevision(catalogPath)
  );
  if (!workspace.writesAllowed) {
    throw new StudioBridgeError(
      403,
      workspace.writeBlockReason ?? "Appearance writes are blocked"
    );
  }
  return workspace;
}

async function validateCatalogAssets(
  catalog: PlayerAppearanceCatalog,
  assetRoot: string,
  stagedAssets: ReadonlyMap<string, StagedAsset>,
  assetScope: "player" | "boss",
  enhancementAssetKeys: readonly string[] = Object.values(
    catalog.enhancementPresentation.gemstoneAssetKeys
  )
): Promise<StagedAsset[]> {
  const keys = new Set([
    ...catalog.appearances.flatMap((appearance) =>
      appearanceAssetParts(appearance).map((part) => part.assetKey)
    ),
    ...catalog.appearances.flatMap((appearance) =>
      appearance.projectileAssetKey ? [appearance.projectileAssetKey] : []
    ),
    ...catalog.bodyVariants.flatMap((body) =>
      [
        ...Object.values(body.bodyAssetKeys ?? {}),
        ...Object.values(body.skinToneAssetKeys ?? {}),
        ...Object.values(body.headAssetKeys ?? {}),
        ...Object.values(body.headSkinToneAssetKeys ?? {})
      ]
        .filter((key): key is string => typeof key === "string")
    ),
    ...enhancementAssetKeys
  ]);
  const publishAssets = new Map<string, StagedAsset>();
  for (const key of keys) {
    const staged = [...stagedAssets.values()].find(
      (asset) => asset.assetScope === assetScope && asset.assetKey === key
    );
    if (staged) {
      validatePng(staged.buffer);
      publishAssets.set(staged.stagingToken, staged);
      continue;
    }
    const file = await safePath(assetRoot, key);
    if (!(await exists(file))) {
      throw new StudioBridgeError(400, `Catalog asset is missing: ${key}`);
    }
    validatePng(await readFile(file));
  }
  return [...publishAssets.values()];
}

async function validateBossCatalogAssets(
  catalog: BossAppearanceCatalog,
  assetRoot: string,
  stagedAssets: ReadonlyMap<string, StagedAsset>
): Promise<StagedAsset[]> {
  const publishAssets = new Map<string, StagedAsset>();
  for (const key of bossAppearanceAssetKeys(catalog)) {
    const staged = [...stagedAssets.values()].find(
      (asset) => asset.assetScope === "boss" && asset.assetKey === key
    );
    if (staged) {
      validatePng(staged.buffer);
      publishAssets.set(staged.stagingToken, staged);
      continue;
    }
    const file = await safePath(assetRoot, key);
    if (!(await exists(file))) {
      throw new StudioBridgeError(400, `Boss appearance asset is missing: ${key}`);
    }
    validatePng(await readFile(file));
  }
  return [...publishAssets.values()];
}

async function safePath(rootInput: string, relativeInput: string): Promise<string> {
  let decoded: string;
  try {
    decoded = decodeURIComponent(relativeInput);
  } catch {
    throw new StudioBridgeError(400, "Encoded asset path is invalid");
  }
  if (
    decoded.includes("\0") ||
    decoded.includes("\\") ||
    path.isAbsolute(decoded) ||
    /^[a-z]:/iu.test(decoded) ||
    decoded.startsWith("//") ||
    decoded.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new StudioBridgeError(400, "Asset path escapes are not allowed");
  }
  const root = await realpath(rootInput);
  const candidate = path.resolve(root, decoded);
  assertInside(root, candidate);
  let existing = path.dirname(candidate);
  while (!(await exists(existing))) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    existing = parent;
  }
  const existingReal = await realpath(existing);
  assertInside(root, existingReal);
  if (await exists(candidate)) {
    assertInside(root, await realpath(candidate));
  }
  return candidate;
}

function assertInside(root: string, candidate: string): void {
  const relative = path.relative(root, candidate);
  if (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  ) return;
  throw new StudioBridgeError(400, "Asset path escapes are not allowed");
}

function assertReadOrigin(request: FastifyRequest, origin: string): void {
  const requestOrigin = request.headers.origin;
  if (requestOrigin !== undefined && requestOrigin !== origin) {
    throw new StudioBridgeError(403, "Request origin is not allowed");
  }
}

function assertMutation(
  request: FastifyRequest,
  origin: string,
  csrfToken: string
): void {
  if (request.headers.origin !== origin) {
    throw new StudioBridgeError(403, "Request origin is not allowed");
  }
  if (request.headers["x-appearance-studio-token"] !== csrfToken) {
    throw new StudioBridgeError(
      403,
      "Appearance Studio session token is invalid",
      "STUDIO_SESSION_INVALID"
    );
  }
}

function normalizedFileStem(fileName: string): string {
  const base = path.basename(fileName, path.extname(fileName))
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 64);
  if (!base) throw new StudioBridgeError(400, "PNG filename has no usable identity");
  return base;
}

function decodeBase64(value: string): Buffer {
  if (!/^[a-z0-9+/]*={0,2}$/iu.test(value) || value.length % 4 !== 0) {
    throw new StudioBridgeError(400, "PNG data is not valid base64");
  }
  const buffer = Buffer.from(value, "base64");
  if (buffer.length === 0) throw new StudioBridgeError(400, "PNG data is empty");
  return buffer;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, stableValue(child)])
    );
  }
  return value;
}

export function stableJson(value: unknown): string {
  return `${JSON.stringify(stableValue(value), null, 2)}\n`;
}

function workspaceSupportsEquipmentEnhancements(
  workspace: Awaited<ReturnType<typeof inspectWorkspace>>
): boolean {
  return (workspace.compatibility.contractVersion ?? 0) >=
    EQUIPMENT_ENHANCEMENT_CONTRACT_VERSION;
}

function workspaceSupportsExpandedGemstones(
  workspace: Awaited<ReturnType<typeof inspectWorkspace>>
): boolean {
  return (workspace.compatibility.contractVersion ?? 0) >=
    EXPANDED_GEMSTONE_CONTRACT_VERSION;
}

function catalogForDesktopParsing(
  value: unknown,
  workspace?: Awaited<ReturnType<typeof inspectWorkspace>>
): unknown {
  if (!workspace || workspaceSupportsExpandedGemstones(workspace)) return value;
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const catalog = structuredClone(value) as Record<string, unknown>;
  const enhancement = catalog.enhancementPresentation;
  if (!enhancement || typeof enhancement !== "object" || Array.isArray(enhancement)) {
    return catalog;
  }
  const presentation = enhancement as Record<string, unknown>;
  const keys = presentation.gemstoneAssetKeys;
  if (!keys || typeof keys !== "object" || Array.isArray(keys)) return catalog;
  const gemstoneAssetKeys = keys as Record<string, unknown>;
  presentation.gemstoneAssetKeys = {
    ...gemstoneAssetKeys,
    ...(!Object.hasOwn(gemstoneAssetKeys, "onyx") ? {
      onyx: DEFAULT_EQUIPMENT_ENHANCEMENT_PRESENTATION.gemstoneAssetKeys.onyx
    } : {}),
    ...(!Object.hasOwn(gemstoneAssetKeys, "topaz") ? {
      topaz: DEFAULT_EQUIPMENT_ENHANCEMENT_PRESENTATION.gemstoneAssetKeys.topaz
    } : {})
  };
  return catalog;
}

function enhancementAssetKeysForWorkspace(
  catalog: PlayerAppearanceCatalog,
  workspace: Awaited<ReturnType<typeof inspectWorkspace>>
): string[] {
  if (!workspaceSupportsEquipmentEnhancements(workspace)) return [];
  return Object.entries(catalog.enhancementPresentation.gemstoneAssetKeys)
    .filter(([gemstone]) => workspaceSupportsExpandedGemstones(workspace) ||
      (gemstone !== "onyx" && gemstone !== "topaz"))
    .map(([, assetKey]) => assetKey);
}

function assertLegacyEnhancementContent(catalog: PlayerAppearanceCatalog): void {
  if (
    catalog.appearances.some((appearance) => appearance.gemSocket !== undefined) ||
    stableJson(catalog.enhancementPresentation) !==
      stableJson(DEFAULT_EQUIPMENT_ENHANCEMENT_PRESENTATION)
  ) {
    throw new StudioBridgeError(
      400,
      `Equipment enhancement authoring requires Appearance Studio contract ${
        EQUIPMENT_ENHANCEMENT_CONTRACT_VERSION
      }`,
      "WORKSPACE_CONTRACT_REQUIRED"
    );
  }
}

function catalogForWorkspaceContract(
  catalog: PlayerAppearanceCatalog,
  workspace: Awaited<ReturnType<typeof inspectWorkspace>>
): Record<string, unknown> {
  if ((workspace.compatibility.contractVersion ?? 0) < FACE_FEATURE_CONTRACT_VERSION) {
    // Older workspaces cannot parse face-feature anchors or areas.
    catalog = {
      ...catalog,
      families: catalog.families.map(({ featureArea: _featureArea, ...family }) => family),
      appearances: catalog.appearances.map(({ featureAnchor: _featureAnchor, ...appearance }) =>
        appearance)
    };
  }
  const persisted = structuredClone(catalog) as unknown as Record<string, unknown>;
  if (workspaceSupportsEquipmentEnhancements(workspace)) {
    if (!workspaceSupportsExpandedGemstones(workspace)) {
      const enhancement = persisted.enhancementPresentation as Record<string, unknown>;
      const keys = enhancement.gemstoneAssetKeys as Record<string, unknown>;
      delete keys.onyx;
      delete keys.topaz;
    }
    return persisted;
  }
  delete persisted.enhancementPresentation;
  persisted.appearances = catalog.appearances.map((appearance) => {
    const legacyAppearance = structuredClone(appearance) as unknown as Record<string, unknown>;
    delete legacyAppearance.gemSocket;
    return legacyAppearance;
  });
  return persisted;
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export class StudioBridgeError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
    readonly code = "STUDIO_OPERATION_FAILED"
  ) {
    super(message);
    this.name = "StudioBridgeError";
  }
}

export async function defaultCatalogForTests(): Promise<PlayerAppearanceCatalog> {
  return structuredClone(DEFAULT_PLAYER_APPEARANCE_CATALOG);
}

export async function defaultItemVariantCatalogForTests(): Promise<ItemVariantCatalog> {
  return structuredClone(ITEM_VARIANT_CATALOG);
}
