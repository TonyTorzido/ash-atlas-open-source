import {
  normalizeFlagEnvironmentDiagnostics,
  normalizeFlagEnvironmentDetails,
  type FlagEnvironmentDiagnostics,
  type FlagEnvironmentDetails
} from "@ash-atlas/shared";

export class FlagEnvironmentRequestError extends Error {
  constructor(message: string, readonly status: number | null = null) {
    super(message);
    this.name = "FlagEnvironmentRequestError";
  }
}

export async function fetchFlagEnvironmentDiagnostics(
  serverHttpBase: string,
  flagId: string,
  options: { signal?: AbortSignal } = {}
): Promise<FlagEnvironmentDiagnostics> {
  const response = await request(
    new URL(`/api/dev/flags/${encodeURIComponent(flagId)}/environment-diagnostics`, serverHttpBase),
    options.signal ? { signal: options.signal } : {}
  );
  try {
    return normalizeFlagEnvironmentDiagnostics(await response.json());
  } catch {
    throw new FlagEnvironmentRequestError("Developer diagnostics returned an invalid response.");
  }
}

export type FlagEnvironmentRefreshReport = {
  ok: boolean;
  requested: number;
  refreshed: number;
  failures: Array<{ flagId: string; error: string }>;
  truncated: boolean;
};

export async function refreshFlagEnvironments(
  serverHttpBase: string,
  csrfToken: string,
  body: { flagId: string } | { all: true; limit: number; onlyNeedsRefresh: true }
): Promise<FlagEnvironmentRefreshReport> {
  const response = await request(
    new URL("/api/dev/flags/environment/refresh", serverHttpBase),
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-csrf-token": csrfToken
      },
      body: JSON.stringify(body)
    }
  );
  const payload = await response.json() as FlagEnvironmentRefreshReport;
  return payload;
}

async function request(url: URL, init: RequestInit): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(url, { ...init, credentials: "include" });
  } catch (error) {
    if (init.signal?.aborted) throw error;
    throw new FlagEnvironmentRequestError("Advanced flag details are unavailable.");
  }
  if (!response.ok) {
    throw new FlagEnvironmentRequestError(errorMessageForStatus(response.status), response.status);
  }
  return response;
}

export async function fetchFlagEnvironment(
  serverHttpBase: string,
  flagId: string,
  options: { signal?: AbortSignal } = {}
): Promise<FlagEnvironmentDetails> {
  let response: Response;
  try {
    response = await fetch(
      new URL(`/api/flags/${encodeURIComponent(flagId)}/environment`, serverHttpBase),
      {
        credentials: "include",
        ...(options.signal ? { signal: options.signal } : {})
      }
    );
  } catch (error) {
    if (options.signal?.aborted) throw error;
    throw new FlagEnvironmentRequestError("Advanced flag details are unavailable.");
  }
  if (!response.ok) {
    throw new FlagEnvironmentRequestError(
      errorMessageForStatus(response.status),
      response.status
    );
  }
  try {
    return normalizeFlagEnvironmentDetails(await response.json());
  } catch {
    throw new FlagEnvironmentRequestError("Advanced flag details returned an invalid response.");
  }
}

function errorMessageForStatus(status: number): string {
  if (status === 401) {
    return "Your session expired. Sign in again to view advanced flag details.";
  }
  if (status === 404) {
    return "This flag no longer exists.";
  }
  if (status >= 500) {
    return "The server could not load advanced flag details. Try again shortly.";
  }
  return "Advanced flag details could not be loaded.";
}
