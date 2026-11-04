import {
  evaluateNativeCompatibility,
  nativeCompatibilityRequestSchema,
  type NativeCompatibilityRequest,
  type NativeCompatibilityResponse,
  type NativeCompatibilityStatus,
  type NativePlatform
} from "@ash-atlas/shared";
import { boundedFetch } from "./nativeRequest.js";

export type { NativeCompatibilityResponse } from "@ash-atlas/shared";

export type NativeCompatibilityUpdateStatus = "ok" | "bundle_update_required" | "shell_update_required";
export type NativeCompatibilityClientResponse = NativeCompatibilityResponse & Readonly<{
  updateStatus?: NativeCompatibilityUpdateStatus;
}>;

export type NativeClientIdentity = Readonly<{
  platform: NativePlatform;
  version: string;
  build: number;
  wsMin: number;
  wsMax: number;
}>;

export type NativeCompatibilityPresentation = Readonly<{
  status: NativeCompatibilityStatus;
  title: string;
  message: string;
  detail: string;
  storeUrl: string | null;
}>;

export function nativeCompatibilityEndpoint(serverHttpBase: string): string {
  return new URL("/api/auth/native/compatibility", serverHttpBase).toString();
}

export async function checkNativeCompatibility(
  serverHttpBase: string,
  identity: NativeClientIdentity,
  fetcher: typeof fetch = globalThis.fetch.bind(globalThis),
  signal?: AbortSignal
): Promise<NativeCompatibilityClientResponse> {
  const query = new URLSearchParams({
    platform: identity.platform,
    version: identity.version,
    build: String(identity.build),
    wsMin: String(identity.wsMin),
    wsMax: String(identity.wsMax)
  });
  let response: Response;
  try {
    response = await boundedFetch(`${nativeCompatibilityEndpoint(serverHttpBase)}?${query}`, {
      method: "GET",
      cache: "no-store",
      credentials: "include",
      ...(signal ? { signal } : {})
    }, fetcher);
  } catch {
    throw new NativeCompatibilityError("Native compatibility is unavailable", 0);
  }
  if (!response.ok) {
    throw new NativeCompatibilityError("Native compatibility is unavailable", response.status);
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new NativeCompatibilityError("Native compatibility returned an invalid response", response.status);
  }
  const parsed = nativeCompatibilityResponse(payload);
  if (!parsed) {
    throw new NativeCompatibilityError("Native compatibility returned an invalid response", response.status);
  }
  return parsed;
}

export function nativeCompatibilityResponse(value: unknown): NativeCompatibilityClientResponse | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const status = record.status;
  const updateStatus = record.updateStatus;
  const request = nativeCompatibilityRequestSchema.safeParse({
    platform: record.platform,
    version: record.version,
    build: record.build,
    wsMin: record.wsMin,
    wsMax: record.wsMax
  });
  if (!request.success) return null;
  if (
    record.contractVersion !== 1 ||
    typeof record.minVersion !== "string" ||
    typeof record.recommendedVersion !== "string" ||
    typeof record.currentVersion !== "string" ||
    !nativeReleaseIdentity(record.hardMinimum) ||
    !nativeReleaseIdentity(record.recommendedMinimum) ||
    !nativeReleaseIdentity(record.latest) ||
    (record.storeUrl !== null && typeof record.storeUrl !== "string") ||
    (record.serverSha !== null && typeof record.serverSha !== "string") ||
    (status !== "supported" && status !== "recommended" && status !== "required") ||
    (updateStatus !== undefined && updateStatus !== "ok" &&
      updateStatus !== "bundle_update_required" && updateStatus !== "shell_update_required")
  ) return null;
  return {
    contractVersion: 1,
    platform: request.data.platform,
    version: request.data.version,
    build: String(request.data.build),
    minVersion: record.minVersion,
    recommendedVersion: record.recommendedVersion,
    currentVersion: record.currentVersion,
    hardMinimum: nativeReleaseIdentity(record.hardMinimum)!,
    recommendedMinimum: nativeReleaseIdentity(record.recommendedMinimum)!,
    latest: nativeReleaseIdentity(record.latest)!,
    storeUrl: record.storeUrl as string | null,
    wsMin: request.data.wsMin,
    wsMax: request.data.wsMax,
    serverSha: record.serverSha as string | null,
    status,
    ...(updateStatus ? { updateStatus } : {})
  };
}

function nativeReleaseIdentity(value: unknown): { version: string; build: number } | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  return typeof record.version === "string" && Number.isInteger(record.build) &&
    (record.build as number) >= 0
    ? { version: record.version, build: record.build as number }
    : null;
}

export function nativeCompatibilityPresentation(
  compatibility: NativeCompatibilityClientResponse
): NativeCompatibilityPresentation {
  if (compatibility.status === "required") {
    return {
      status: "required",
      title: "Update Ash Atlas",
      message: "This version of Ash Atlas is no longer supported.",
      detail: "Update the app to continue playing. Your player and progress are safe.",
      storeUrl: compatibility.storeUrl
    };
  }
  if (compatibility.status === "recommended") {
    return {
      status: "recommended",
      title: "Ash Atlas update available",
      message: "A newer version of Ash Atlas is recommended.",
      detail: "You can keep playing, but update when convenient for the best experience.",
      storeUrl: compatibility.storeUrl
    };
  }
  return {
    status: "supported",
    title: "Ash Atlas",
    message: "",
    detail: "",
    storeUrl: null
  };
}

export function nativeCompatibilityRequest(
  identity: NativeClientIdentity
): NativeCompatibilityRequest {
  return nativeCompatibilityRequestSchema.parse(identity);
}

export class NativeCompatibilityError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "NativeCompatibilityError";
  }
}

export { evaluateNativeCompatibility };
