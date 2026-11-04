import type {
  TerritoryStructureCatalog,
  BossAppearanceCatalog,
  ItemVariantCatalog,
  PlayerAppearanceCatalog,
  PlayerAppearanceSnapshot,
  ProgressionIconPresentationCatalog,
  ProgressionIconRegistryEntry,
  RuntimePngPresentationCatalog
} from "@ash-atlas/shared";
import type { InteriorLibrary, InteriorSpace } from "@ash-atlas/shared";
import type { InteriorCatalogSnapshot } from "./interiorStudioModel.js";

export type { InteriorCatalogSnapshot } from "./interiorStudioModel.js";

export type StudioWorkspaceStatus = {
  repositoryPath: string;
  worktreePath: string;
  branch: string | null;
  commitSha: string;
  writesAllowed: boolean;
  writeBlockReason: string | null;
  catalogRevision: number;
  isLinkedWorktree: boolean;
  compatibility: {
    contractVersion: number | null;
    supportedContractVersion: number;
    minimumDesktopVersion: string | null;
    compatible: boolean;
  };
};

export type StudioServerIdentity = {
  pid: number;
  worktreePath: string;
  branch: string | null;
  commitSha: string;
  port: number;
  startedAt: string;
};

export type StudioSession = {
  csrfToken: string;
  origin: string;
  workspace: StudioWorkspaceStatus;
  server: StudioServerIdentity;
};

export type StudioPublishRequest = {
  catalog: PlayerAppearanceCatalog;
  bossCatalog: BossAppearanceCatalog;
  itemVariants: ItemVariantCatalog;
  expectedCatalogRevision: number;
  expectedBossCatalogRevision: number;
  expectedWorkspace: Pick<
    StudioWorkspaceStatus,
    "worktreePath" | "branch" | "commitSha"
  >;
};

export type StudioPublishResponse = {
  catalog: PlayerAppearanceCatalog;
  bossCatalog: BossAppearanceCatalog;
  itemVariants: ItemVariantCatalog;
  modifiedFiles: string[];
};

/**
 * `POST /api/interior-catalog/:spaceId/publish`: one space saved under the
 * catalog lock. `alsoSpaces` are further changed spaces saved in the same
 * transaction (needed when a shared library prefab change touches several).
 */
export type InteriorSpacePublishRequest = {
  space: InteriorSpace;
  alsoSpaces?: InteriorSpace[];
  /** The whole library after the edit; omitted when only spaces changed. */
  library?: InteriorLibrary;
  expectedCatalogRevision: number;
  /** Per published space id: the revision it was loaded at, or null for a new space. */
  expectedSpaceRevisions: Record<string, string | null>;
  pendingAssetTokens?: string[];
  expectedWorkspace: Pick<
    StudioWorkspaceStatus,
    "worktreePath" | "branch" | "commitSha"
  >;
};

export type InteriorSpacePublishResponse = InteriorCatalogSnapshot & {
  modifiedFiles: string[];
};

export type ImportedAsset = {
  stagingToken: string;
  assetKey: string;
  relativeFile: string;
  width: number;
  height: number;
  bytes: number;
  contentHash: string;
};

export type DungeonAssetImportOptions = {
  displayName: string;
  prefabId: string;
  kind: "surface" | "decoration" | "object" | "portal";
  layer: "background" | "below_player" | "actors" | "above_player" | "ceiling";
  renderMode: "sprite" | "tile" | "stretch";
  defaultWidth: number;
  defaultHeight: number;
};

export type RuntimeAssetUsage = {
  id: string;
  label: string;
  context: string;
  editor:
    | { kind: "sprite"; key: string }
    | { kind: "fixed"; key: string }
    | { kind: "world-object"; key: string }
    | { kind: "appearance"; domain: "player" | "boss" }
    | { kind: "readonly"; reason: string };
};

export type RuntimeAsset = {
  id: string;
  label: string;
  category: string;
  relativeFile: string;
  imageUrl: string;
  width: number;
  height: number;
  bytes: number;
  contentHash: string;
  usages: RuntimeAssetUsage[];
  staged: boolean;
  missing: boolean;
};

export type RuntimeAssetInventory = {
  assets: RuntimeAsset[];
  presentation: RuntimePngPresentationCatalog;
};

export type RuntimeAssetInboxEntry = {
  id: string;
  sourceFile: string;
  label: string;
  destinationFile: string;
  width: number;
  height: number;
  bytes: number;
  contentHash: string;
  status: "ready" | "staged" | "imported" | "conflict";
  statusReason: string | null;
};

export type RuntimeAssetInbox = {
  sourceDirectory: string;
  entries: RuntimeAssetInboxEntry[];
};

export type RuntimeAssetInboxImportResponse = ImportedAsset & {
  sourceFile: string;
};

export type RuntimeAssetPublishRequest = {
  presentation: RuntimePngPresentationCatalog;
  expectedPresentationRevision: number;
  expectedWorkspace: Pick<
    StudioWorkspaceStatus,
    "worktreePath" | "branch" | "commitSha"
  >;
};

export type RuntimeAssetPublishResponse = {
  presentation: RuntimePngPresentationCatalog;
  inventory: RuntimeAssetInventory;
  modifiedFiles: string[];
};

export type ProgressionIconInventory = {
  catalog: ProgressionIconPresentationCatalog;
  icons: readonly (ProgressionIconRegistryEntry & { imageUrl: string })[];
};

export type TerritoryStructureInventory = {
  catalog: TerritoryStructureCatalog;
  availableAssets: string[];
};
export type TerritoryStructurePublishRequest = {
  catalog: TerritoryStructureCatalog;
  expectedRevision: number;
  expectedWorkspace: Pick<StudioWorkspaceStatus, "worktreePath" | "branch" | "commitSha">;
};
export type TerritoryStructurePublishResponse = {
  catalog: TerritoryStructureCatalog;
  inventory: TerritoryStructureInventory;
  modifiedFiles: string[];
};

export type ProgressionIconPublishRequest = {
  catalog: ProgressionIconPresentationCatalog;
  expectedRevision: number;
  expectedWorkspace: Pick<StudioWorkspaceStatus, "worktreePath" | "branch" | "commitSha">;
};

export type ProgressionIconPublishResponse = {
  catalog: ProgressionIconPresentationCatalog;
  inventory: ProgressionIconInventory;
  modifiedFiles: string[];
};

export type RemoteStudioInfo = {
  connected: boolean;
  serverBase?: string;
  serverSha?: string | null;
  catalogRevision?: number;
  compatibility?: {
    schemaVersion: number;
    minimumStudioVersion: number;
  };
  equipmentDefinitions?: Array<{
    definitionId: string;
    displayName: string;
    slot: string;
    category: string;
  }>;
  bodyVariants?: string[];
  poses?: string[];
  appearance?: PlayerAppearanceSnapshot | null;
  error?: string;
};
