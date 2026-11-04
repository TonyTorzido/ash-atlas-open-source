import type {
  TerritoryStructureCatalog,
  BossAppearanceCatalog,
  ItemVariantCatalog,
  PlayerAppearanceCatalog,
  ProgressionIconPresentationCatalog,
  RuntimePngPresentationCatalog
} from "@ash-atlas/shared";

import type {
  TerritoryStructureInventory,
  TerritoryStructurePublishResponse,
  ImportedAsset,
  DungeonAssetImportOptions,
  InteriorCatalogSnapshot,
  InteriorSpacePublishRequest,
  InteriorSpacePublishResponse,
  RemoteStudioInfo,
  RuntimeAssetInbox,
  RuntimeAssetInboxImportResponse,
  RuntimeAssetInventory,
  RuntimeAssetPublishResponse,
  ProgressionIconInventory,
  ProgressionIconPublishResponse,
  StudioPublishResponse,
  StudioSession
} from "./bridgeTypes.js";
import type {
  CreateContentBatchResponse,
  DesktopReleaseStatus,
  DesktopStudioStatus,
  FinishContentBatchResponse,
  IntegrateContentBatchResponse,
  PublishIntegrationTestResponse
} from "./desktopContracts.js";
import type { CreatePlaytestInput, PlaytestCommand, PlaytestValidationIssue } from "./dungeonPlaytestContracts.js";
import type { SequencedPlaytestFrame } from "./dungeonPlaytestRoutes.js";

export class StudioApi {
  private session: StudioSession | null = null;
  private sessionRequestGeneration = 0;

  async loadSession(): Promise<StudioSession> {
    const generation = ++this.sessionRequestGeneration;
    const session = await json<StudioSession>("/api/session");
    if (generation !== this.sessionRequestGeneration) {
      throw new StaleStudioResponseError();
    }
    this.session = session;
    return session;
  }

  loadCatalog(): Promise<PlayerAppearanceCatalog> {
    return json("/api/catalog");
  }

  loadItemVariants(): Promise<ItemVariantCatalog> {
    return json("/api/item-variants");
  }

  loadBossCatalog(): Promise<BossAppearanceCatalog> {
    return json("/api/boss-catalog");
  }

  loadInteriorCatalog(): Promise<InteriorCatalogSnapshot> {
    return json("/api/interior-catalog", { cache: "no-store" });
  }

  /** Save one interior space (plus any companion spaces and library edits) into the unified interior files. */
  publishInteriorSpace(
    input: Omit<InteriorSpacePublishRequest, "expectedWorkspace">
  ): Promise<InteriorSpacePublishResponse> {
    const session = this.requireSession();
    return this.mutate(`/api/interior-catalog/${encodeURIComponent(input.space.id)}/publish`, "POST", {
      ...input,
      expectedWorkspace: {
        worktreePath: session.workspace.worktreePath,
        branch: session.workspace.branch,
        commitSha: session.workspace.commitSha
      }
    });
  }

  startDungeonPlaytest(input: CreatePlaytestInput): Promise<SequencedPlaytestFrame> {
    return this.mutate("/api/dungeon-playtest/start", "POST", input);
  }

  advanceDungeonPlaytest(runId: string): Promise<SequencedPlaytestFrame> {
    return this.mutate(`/api/dungeon-playtest/${encodeURIComponent(runId)}/advance`, "POST", {});
  }

  commandDungeonPlaytest(runId: string, command: PlaytestCommand): Promise<SequencedPlaytestFrame> {
    return this.mutate(`/api/dungeon-playtest/${encodeURIComponent(runId)}/command`, "POST", command);
  }

  async stopDungeonPlaytest(runId: string): Promise<void> {
    await this.mutate(`/api/dungeon-playtest/${encodeURIComponent(runId)}/stop`, "POST", {});
  }

  async importManorPng(file: File): Promise<ImportedAsset> {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const binary = binaryStringFromBytes(bytes);
    return this.mutate("/api/manor-assets/import", "POST", {
      fileName: file.name,
      dataBase64: btoa(binary)
    });
  }

  async importDungeonPng(file: File, options: DungeonAssetImportOptions): Promise<ImportedAsset> {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const binary = binaryStringFromBytes(bytes);
    return this.mutate("/api/dungeon-assets/import", "POST", { ...options, fileName: file.name, dataBase64: btoa(binary) });
  }

  async replaceDungeonPng(file: File, prefabId: string): Promise<ImportedAsset> {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const binary = binaryStringFromBytes(bytes);
    return this.mutate("/api/dungeon-assets/replace", "POST", { prefabId, fileName: file.name, dataBase64: btoa(binary) });
  }

  async discardDungeonAssets(tokens: string[]): Promise<void> {
    if (tokens.length === 0) return;
    await this.mutate("/api/dungeon-assets/discard", "POST", { tokens });
  }

  loadRuntimeAssets(): Promise<RuntimeAssetInventory> {
    return json("/api/runtime-assets", { cache: "no-store" });
  }

  loadRuntimeAssetInbox(): Promise<RuntimeAssetInbox> {
    return json("/api/runtime-assets/inbox");
  }

  importRuntimeAssetFromInbox(sourceFile: string): Promise<RuntimeAssetInboxImportResponse> {
    return this.mutate("/api/runtime-assets/inbox/import", "POST", { sourceFile });
  }

  loadProgressionIcons(): Promise<ProgressionIconInventory> {
    return json("/api/progression-icons");
  }

  loadTerritoryStructures(): Promise<TerritoryStructureInventory> {
    return json("/api/territory-structures");
  }

  publishTerritoryStructures(catalog: TerritoryStructureCatalog): Promise<TerritoryStructurePublishResponse> {
    const session = this.requireSession();
    return this.mutate("/api/territory-structures/publish", "POST", {
      catalog,
      expectedRevision: catalog.revision,
      expectedWorkspace: {
        worktreePath: session.workspace.worktreePath,
        branch: session.workspace.branch,
        commitSha: session.workspace.commitSha
      }
    });
  }

  publishProgressionIcons(
    catalog: ProgressionIconPresentationCatalog
  ): Promise<ProgressionIconPublishResponse> {
    const session = this.requireSession();
    return this.mutate("/api/progression-icons/publish", "POST", {
      catalog,
      expectedRevision: catalog.revision,
      expectedWorkspace: {
        worktreePath: session.workspace.worktreePath,
        branch: session.workspace.branch,
        commitSha: session.workspace.commitSha
      }
    });
  }

  async replaceRuntimeAsset(assetId: string, file: File): Promise<ImportedAsset> {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const binary = binaryStringFromBytes(bytes);
    return this.mutate("/api/runtime-assets/replace", "POST", {
      assetId,
      fileName: file.name,
      dataBase64: btoa(binary)
    });
  }

  publishRuntimeAssets(
    presentation: RuntimePngPresentationCatalog
  ): Promise<RuntimeAssetPublishResponse> {
    const session = this.requireSession();
    return this.mutate("/api/runtime-assets/publish", "POST", {
      presentation,
      expectedPresentationRevision: presentation.revision,
      expectedWorkspace: {
        worktreePath: session.workspace.worktreePath,
        branch: session.workspace.branch,
        commitSha: session.workspace.commitSha
      }
    });
  }

  async discardRuntimeAssetChanges(): Promise<RuntimeAssetInventory> {
    return this.mutate("/api/runtime-assets/discard", "POST", {});
  }

  publish(
    catalog: PlayerAppearanceCatalog,
    itemVariants: ItemVariantCatalog,
    bossCatalog: BossAppearanceCatalog
  ): Promise<StudioPublishResponse> {
    const session = this.requireSession();
    return this.mutate("/api/publish", "POST", {
      catalog,
      bossCatalog,
      itemVariants,
      expectedCatalogRevision: catalog.catalogRevision,
      expectedBossCatalogRevision: bossCatalog.catalogRevision,
      expectedWorkspace: {
        worktreePath: session.workspace.worktreePath,
        branch: session.workspace.branch,
        commitSha: session.workspace.commitSha
      }
    });
  }

  async importPng(file: File, category: string): Promise<ImportedAsset> {
    return this.importAsset(file, { category, assetScope: "player" });
  }

  async importBossWeaponPng(
    file: File,
    bossId: string
  ): Promise<ImportedAsset> {
    return this.importAsset(file, {
      category: "weapons",
      assetScope: "boss",
      bossId
    });
  }

  private async importAsset(
    file: File,
    target: { category: string; assetScope: "player" | "boss"; bossId?: string }
  ): Promise<ImportedAsset> {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const binary = binaryStringFromBytes(bytes);
    return this.mutate("/api/assets/import", "POST", {
      fileName: file.name,
      ...target,
      dataBase64: btoa(binary)
    });
  }

  async connectRemote(serverBase: string): Promise<RemoteStudioInfo | null> {
    const response = await this.mutate<{ authorizeUrl: string }>(
      "/api/remote/connect",
      "POST",
      { serverBase }
    );
    const desktop = await this.desktopStatus();
    if (!desktop.available) {
      window.location.assign(response.authorizeUrl);
      return null;
    }
    await this.mutate("/api/desktop/open-external", "POST", {
      url: response.authorizeUrl
    });
    for (let attempt = 0; attempt < 120; attempt += 1) {
      await delay(1_000);
      const status = await this.remoteStatus();
      if (status.connected) return status;
    }
    throw new Error("Remote authorization timed out");
  }

  desktopStatus(): Promise<DesktopStudioStatus> {
    return json("/api/desktop/status");
  }

  createContentBatch(slug: string): Promise<CreateContentBatchResponse> {
    return this.mutate("/api/desktop/create-batch", "POST", { slug });
  }

  finishContentBatch(summary: string): Promise<FinishContentBatchResponse> {
    return this.mutate("/api/desktop/finish-batch", "POST", { summary });
  }

  releaseStatus(): Promise<DesktopReleaseStatus> {
    return json("/api/desktop/release-status");
  }

  integrateContentBatch(): Promise<IntegrateContentBatchResponse> {
    return this.mutate("/api/desktop/integrate-batch", "POST", {});
  }

  publishIntegrationTest(
    approvedGeneration: string,
    approvedSha: string
  ): Promise<PublishIntegrationTestResponse> {
    return this.mutate("/api/desktop/publish-integration", "POST", {
      approvedGeneration,
      approvedSha
    });
  }

  remoteStatus(): Promise<RemoteStudioInfo> {
    return json("/api/remote/status");
  }

  async disconnectRemote(): Promise<void> {
    await this.mutate("/api/remote/disconnect", "POST", {});
  }

  private async mutate<T>(
    url: string,
    method: "POST" | "PUT",
    body: unknown
  ): Promise<T> {
    const request = (): Promise<T> => json<T>(url, {
      method,
      headers: {
        "content-type": "application/json",
        "x-appearance-studio-token": this.requireSession().csrfToken
      },
      body: JSON.stringify(body)
    });
    try {
      return await request();
    } catch (error) {
      if (!(error instanceof StudioApiError) || error.code !== "STUDIO_SESSION_INVALID") {
        throw error;
      }
      await this.loadSession();
      return request();
    }
  }

  private requireSession(): StudioSession {
    if (!this.session) throw new Error("Appearance Studio session is not loaded");
    return this.session;
  }
}

export class StudioApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null,
    readonly issues: readonly PlaytestValidationIssue[] = []
  ) {
    super(message);
    this.name = "StudioApiError";
  }
}

export class StaleStudioResponseError extends Error {
  constructor() {
    super("A newer Appearance Studio session replaced this response");
    this.name = "StaleStudioResponseError";
  }
}

function binaryStringFromBytes(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return binary;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const payload = await response.json() as T | { error?: string; code?: string; issues?: unknown };
  if (!response.ok) {
    const failure = payload as { error?: unknown; code?: unknown };
    const issues = Array.isArray((payload as { issues?: unknown }).issues)
      ? (payload as { issues: unknown[] }).issues.filter((issue): issue is PlaytestValidationIssue =>
        typeof issue === "object" && issue !== null &&
        typeof (issue as { path?: unknown }).path === "string" &&
        typeof (issue as { message?: unknown }).message === "string")
      : [];
    throw new StudioApiError(
      typeof failure.error === "string"
        ? failure.error
        : `Appearance Studio request failed (${response.status})`,
      response.status,
      typeof failure.code === "string" ? failure.code : null,
      issues
    );
  }
  return payload as T;
}
