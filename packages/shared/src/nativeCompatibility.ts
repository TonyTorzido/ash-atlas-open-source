import { z } from "zod";

import {
  ASH_ATLAS_MAX_PROTOCOL_VERSION,
  ASH_ATLAS_MIN_PROTOCOL_VERSION
} from "./protocolCompatibility.js";

// Keep v1 on the wire so already-uploaded build 1 clients can parse the extended response.
export const NATIVE_COMPATIBILITY_CONTRACT_VERSION = 1;
export const NATIVE_COMPATIBILITY_DISABLED_MIN_VERSION = "0.0.0";
export const NATIVE_COMPATIBILITY_DEFAULT_VERSION = "1.0.0";
export const NATIVE_COMPATIBILITY_DISABLED_MIN_BUILD = 0;
export const NATIVE_COMPATIBILITY_DEFAULT_BUILD = 1;
export const NATIVE_COMPATIBILITY_WS_MIN_VERSION = ASH_ATLAS_MIN_PROTOCOL_VERSION;
export const NATIVE_COMPATIBILITY_WS_MAX_VERSION = ASH_ATLAS_MAX_PROTOCOL_VERSION;
export const NATIVE_MINIMUM_SHELL_BUILD = 8;

export const NATIVE_PLATFORMS = ["ios", "android"] as const;
export type NativePlatform = (typeof NATIVE_PLATFORMS)[number];

export const nativePlatformSchema = z.enum(NATIVE_PLATFORMS);
export const nativeMarketingVersionSchema = z.string()
  .regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u)
  .max(32);
export const nativeBuildNumberSchema = z.coerce.number().int().nonnegative().max(2_147_483_647);

export const nativeCompatibilityRequestSchema = z.object({
  platform: nativePlatformSchema,
  version: nativeMarketingVersionSchema,
  build: nativeBuildNumberSchema,
  wsMin: z.coerce.number().int().positive().max(1_000_000),
  wsMax: z.coerce.number().int().positive().max(1_000_000)
}).strict().superRefine((request, context) => {
  if (request.wsMin > request.wsMax) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["wsMin"],
      message: "WebSocket minimum exceeds maximum"
    });
  }
});

export type NativeCompatibilityRequest = z.infer<typeof nativeCompatibilityRequestSchema>;
export type NativeCompatibilityStatus = "supported" | "recommended" | "required";
export type NativeCompatibilityUpdateStatus =
  | "ok"
  | "bundle_update_required"
  | "shell_update_required";
export type NativeReleaseIdentity = Readonly<{ version: string; build: number }>;

export type NativeCompatibilityResponse = Readonly<{
  contractVersion: typeof NATIVE_COMPATIBILITY_CONTRACT_VERSION;
  platform: NativePlatform;
  version: string;
  build: string;
  minVersion: string;
  recommendedVersion: string;
  currentVersion: string;
  hardMinimum: NativeReleaseIdentity;
  recommendedMinimum: NativeReleaseIdentity;
  latest: NativeReleaseIdentity;
  storeUrl: string | null;
  wsMin: number;
  wsMax: number;
  serverSha: string | null;
  status: NativeCompatibilityStatus;
  updateStatus?: NativeCompatibilityUpdateStatus;
}>;

export type NativeCompatibilityPolicy = Readonly<{
  hardMinimum?: NativeReleaseIdentity;
  recommendedMinimum?: NativeReleaseIdentity;
  latest?: NativeReleaseIdentity;
  storeUrl?: string | null;
  wsMin?: number;
  wsMax?: number;
  serverSha?: string | null;
}>;

const disabledMinimum: NativeReleaseIdentity = Object.freeze({
  version: NATIVE_COMPATIBILITY_DISABLED_MIN_VERSION,
  build: NATIVE_COMPATIBILITY_DISABLED_MIN_BUILD
});
const defaultRelease: NativeReleaseIdentity = Object.freeze({
  version: NATIVE_COMPATIBILITY_DEFAULT_VERSION,
  build: NATIVE_COMPATIBILITY_DEFAULT_BUILD
});

export function evaluateNativeCompatibility(
  request: NativeCompatibilityRequest,
  policy: NativeCompatibilityPolicy = {}
): NativeCompatibilityResponse {
  const hardMinimum = policy.hardMinimum ?? disabledMinimum;
  const recommendedMinimum = policy.recommendedMinimum ?? defaultRelease;
  const latest = policy.latest ?? defaultRelease;
  const wsMin = policy.wsMin ?? NATIVE_COMPATIBILITY_WS_MIN_VERSION;
  const wsMax = policy.wsMax ?? NATIVE_COMPATIBILITY_WS_MAX_VERSION;
  const requestRelease = { version: request.version, build: request.build };
  const versionStatus = compareNativeReleases(requestRelease, hardMinimum) < 0
    ? "required"
    : compareNativeReleases(requestRelease, recommendedMinimum) < 0
      ? "recommended"
      : "supported";
  const protocolStatus = request.wsMax < wsMin || request.wsMin > wsMax
    ? "required"
    : request.wsMin < wsMin || request.wsMax > wsMax
      ? "recommended"
      : "supported";
  const status: NativeCompatibilityStatus =
    versionStatus === "required" || protocolStatus === "required"
      ? "required"
      : versionStatus === "recommended" || protocolStatus === "recommended"
        ? "recommended"
        : "supported";
  const updateStatus: NativeCompatibilityUpdateStatus = request.build < NATIVE_MINIMUM_SHELL_BUILD
    ? "shell_update_required"
    : protocolStatus === "required"
      ? "bundle_update_required"
      : "ok";
  return {
    contractVersion: NATIVE_COMPATIBILITY_CONTRACT_VERSION,
    platform: request.platform,
    version: request.version,
    build: String(request.build),
    minVersion: hardMinimum.version,
    recommendedVersion: recommendedMinimum.version,
    currentVersion: latest.version,
    hardMinimum,
    recommendedMinimum,
    latest,
    storeUrl: policy.storeUrl ?? null,
    wsMin,
    wsMax,
    serverSha: policy.serverSha ?? null,
    status,
    updateStatus
  };
}

export function compareNativeReleases(left: NativeReleaseIdentity, right: NativeReleaseIdentity): number {
  const versionComparison = compareVersions(left.version, right.version);
  return versionComparison === 0 ? left.build - right.build : versionComparison;
}

export function compareVersions(left: string, right: string): number {
  const leftParts = parseVersion(left);
  const rightParts = parseVersion(right);
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] !== rightParts[index]) return leftParts[index]! - rightParts[index]!;
  }
  return 0;
}

function parseVersion(value: string): [number, number, number] {
  const match = /^(\d+)\.(\d+)\.(\d+)/u.exec(value);
  if (!match) return [0, 0, 0];
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}
