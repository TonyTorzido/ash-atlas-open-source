import type { FlagSnapshot } from "@ash-atlas/shared";

import type { AppConfig } from "../config.js";

export type ResourceVisionJobReason =
  | "flag-build"
  | "flag-created"
  | "flag-visit"
  | "dev-prewarm";

export type ResourceVisionJobPayload = {
  flag: FlagSnapshot;
  regionCode: string;
  movementLeashRadiusM: number;
  reason: ResourceVisionJobReason;
};

export type ResourceVisionJobContract = {
  jobKey: string;
  flagId: string;
  layoutVersion: string;
  radiusM: number;
  worldReleaseId: string;
  profileSetFingerprint: string;
  buildContractFingerprint: string;
  boundaryReleaseId: string;
  priority: number;
  payload: ResourceVisionJobPayload;
};

export type ClaimedResourceVisionJob = ResourceVisionJobContract & {
  ownerId: string;
  ownerGeneration: number;
  attemptCount: number;
};

export type ResourceVisionJobStatus = "pending" | "processing" | "completed" | "failed";

export type ResourceVisionJobAdmission = {
  admitted: boolean;
  status: ResourceVisionJobStatus;
};

export type ResourceVisionJobFailure = {
  accepted: boolean;
  terminal: boolean;
};

export type DurableResourceVisionJobMetrics = {
  pending: number;
  processing: number;
  retrying: number;
  terminalFailed: number;
  completed: number;
  oldestPendingAgeMs: number;
  expiredLeases: number;
};

export interface ResourceVisionJobStore {
  status(jobKey: string): Promise<ResourceVisionJobStatus | null>;
  submit(job: ResourceVisionJobContract): Promise<ResourceVisionJobAdmission>;
  claim(ownerId: string, leaseMs: number): Promise<ClaimedResourceVisionJob | null>;
  claimByKey(
    jobKey: string,
    ownerId: string,
    leaseMs: number
  ): Promise<ClaimedResourceVisionJob | null>;
  heartbeat(job: ClaimedResourceVisionJob, leaseMs: number): Promise<boolean>;
  isOwned(job: ClaimedResourceVisionJob): Promise<boolean>;
  complete(job: ClaimedResourceVisionJob): Promise<boolean>;
  fail(
    job: ClaimedResourceVisionJob,
    error: unknown,
    maxAttempts: number
  ): Promise<ResourceVisionJobFailure>;
  recoverExpired(): Promise<number>;
  metrics(): Promise<DurableResourceVisionJobMetrics>;
}

export function resourceVisionJobIdentity(
  input: ResourceVisionJobPayload,
  radiusM: number,
  config: Pick<
    AppConfig,
    | "WORLD_REQUIRED_RELEASE_ID"
    | "WORLD_REQUIRED_PROFILE_SET_FINGERPRINT"
    | "WORLD_REQUIRED_BUILD_CONTRACT_FINGERPRINT"
    | "WORLD_REQUIRED_BOUNDARY_RELEASE_ID"
  >,
  layoutVersion: string
): ResourceVisionJobContract {
  const parts = [
    input.flag.id,
    layoutVersion,
    radiusM.toFixed(3),
    config.WORLD_REQUIRED_RELEASE_ID,
    config.WORLD_REQUIRED_PROFILE_SET_FINGERPRINT,
    config.WORLD_REQUIRED_BUILD_CONTRACT_FINGERPRINT,
    config.WORLD_REQUIRED_BOUNDARY_RELEASE_ID
  ];
  return {
    jobKey: parts.join(":"),
    flagId: input.flag.id,
    layoutVersion,
    radiusM,
    worldReleaseId: config.WORLD_REQUIRED_RELEASE_ID,
    profileSetFingerprint: config.WORLD_REQUIRED_PROFILE_SET_FINGERPRINT,
    buildContractFingerprint: config.WORLD_REQUIRED_BUILD_CONTRACT_FINGERPRINT,
    boundaryReleaseId: config.WORLD_REQUIRED_BOUNDARY_RELEASE_ID,
    priority: reasonPriority(input.reason),
    payload: input
  };
}

function reasonPriority(reason: ResourceVisionJobReason): number {
  switch (reason) {
    case "flag-visit": return 0;
    case "flag-build":
    case "flag-created": return 1;
    case "dev-prewarm": return 2;
  }
}
