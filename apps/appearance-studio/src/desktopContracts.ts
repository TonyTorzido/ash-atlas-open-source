export const MIN_APPEARANCE_STUDIO_CONTRACT_VERSION = 4;
export const APPEARANCE_STUDIO_CONTRACT_VERSION = 56;
export const APPEARANCE_STUDIO_MINIMUM_DESKTOP_VERSION = "1.56.0";
export const MASTER_SCALE_CONTRACT_VERSION = 5;
export const BOSS_AUTHORING_CONTRACT_VERSION = 8;
export const BOSS_MASTER_SCALE_CONTRACT_VERSION = 9;
export const PROJECTILE_AUTHORING_CONTRACT_VERSION = 10;
export const PROJECTILE_TRANSFORM_CONTRACT_VERSION = 11;
export const EQUIPMENT_ENHANCEMENT_CONTRACT_VERSION = 16;
export const EXPANDED_GEMSTONE_CONTRACT_VERSION = 17;
export const MAIN_ANCHOR_CONTRACT_VERSION = 33;
export const PLAYER_HIT_GEOMETRY_CONTRACT_VERSION = 34;
/** Eyes/Nose/Mouth artist anchors and per-category movement areas. */
export const FACE_FEATURE_CONTRACT_VERSION = 56;

export type DesktopStudioStatus = {
  available: boolean;
  appVersion?: string;
  contractVersion?: number;
};

export type CreateContentBatchRequest = {
  slug: string;
};

export type CreateContentBatchResponse = {
  worktreePath: string;
  branch: string;
  baseGeneration: string;
  baseSha: string;
};

export type FinishContentBatchRequest = {
  summary: string;
};

export type FinishContentBatchResponse = {
  branch: string;
  commitSha: string;
  changedFiles: string[];
  pushed: true;
};

export type DesktopReleaseStatus = {
  branch: string | null;
  commitSha: string;
  worktreeClean: boolean;
  featurePushed: boolean;
  featureIntegrated: boolean;
  featurePublished: boolean;
  integrationGeneration: string;
  integrationSha: string;
  masterSha: string;
  integrationPublished: boolean;
};

export type IntegrateContentBatchResponse = {
  generation: string;
  integrationSha: string;
  featureIntegrated: true;
};

export type PublishIntegrationTestRequest = {
  approvedGeneration: string;
  approvedSha: string;
};

export type PublishIntegrationTestResponse = {
  generation: string;
  deployedSha: string;
  verified: true;
};

export type AppearanceStudioDesktopController = {
  readonly appVersion: string;
  createContentBatch(input: CreateContentBatchRequest): Promise<CreateContentBatchResponse>;
  finishContentBatch(input: FinishContentBatchRequest): Promise<FinishContentBatchResponse>;
  releaseStatus(): Promise<DesktopReleaseStatus>;
  integrateContentBatch(): Promise<IntegrateContentBatchResponse>;
  publishIntegrationTest(
    input: PublishIntegrationTestRequest
  ): Promise<PublishIntegrationTestResponse>;
  openExternal(url: string): Promise<void>;
  requestWorkspaceSwitch(worktreePath: string): void;
};
