import type {
  FlagAccessMode,
  FlagAccessPlayerSearchResult,
  FlagAccessSnapshot,
  FlagManagementDashboardSnapshot,
  FlagOwnerPreferencesSnapshot,
  JewelStationState
} from "@ash-atlas/shared";

export async function fetchFlagAccess(
  serverHttpBase: string,
  flagId: string,
  signal?: AbortSignal
): Promise<FlagAccessSnapshot> {
  return accessRequest(serverHttpBase, `/api/flags/${encodeURIComponent(flagId)}/access`, {
    method: "GET",
    ...(signal ? { signal } : {})
  });
}

export async function saveFlagAccess(
  serverHttpBase: string,
  csrfToken: string,
  flagId: string,
  input: Readonly<{
    mode: FlagAccessMode;
    jumpTollGold: string;
  }>
): Promise<FlagAccessSnapshot> {
  return accessRequest(serverHttpBase, `/api/flags/${encodeURIComponent(flagId)}/access`, {
    method: "PATCH",
    csrfToken,
    body: input
  });
}

export async function requestFlagPassage(
  serverHttpBase: string,
  csrfToken: string,
  flagId: string
): Promise<void> {
  await accessRequest(serverHttpBase, `/api/flags/${encodeURIComponent(flagId)}/passage-requests`, {
    method: "POST",
    csrfToken,
    body: { requestId: crypto.randomUUID() },
    resultKey: "request"
  });
}

export async function resolveFlagPassage(
  serverHttpBase: string,
  csrfToken: string,
  flagId: string,
  input: Readonly<{
    passageRequestId: string;
    action: "approve" | "deny";
  }>
): Promise<FlagAccessSnapshot> {
  return accessRequest(serverHttpBase, `/api/flags/${encodeURIComponent(flagId)}/passage-requests/resolve`, {
    method: "POST",
    csrfToken,
    body: { requestId: crypto.randomUUID(), ...input }
  });
}

/** Pathfinder Boot: adds this building to the player's travel destinations for 31 hours. */
export async function markFlagForPathfinderBoot(
  serverHttpBase: string,
  csrfToken: string,
  flagId: string
): Promise<void> {
  await accessRequest(serverHttpBase, `/api/flags/${encodeURIComponent(flagId)}/pathfinder-mark`, {
    method: "POST",
    csrfToken,
    body: { requestId: crypto.randomUUID() },
    resultKey: "mark"
  });
}

/** Jewel Station: inscribes a +18 or higher item for 140 Lumen; returns the refreshed station state. */
export async function inscribeEquipmentRequest(
  serverHttpBase: string,
  csrfToken: string,
  instanceId: string,
  name: string
): Promise<JewelStationState> {
  return accessRequest<JewelStationState>(serverHttpBase, "/api/jewel-station/inscribe", {
    method: "POST",
    csrfToken,
    body: { requestId: crypto.randomUUID(), instanceId, name },
    resultKey: "state"
  });
}

export async function searchFlagAccessPlayers(
  serverHttpBase: string,
  query: string,
  signal?: AbortSignal
): Promise<FlagAccessPlayerSearchResult[]> {
  const url = new URL("/api/flags/access/player-search", serverHttpBase);
  url.searchParams.set("query", query);
  const response = await fetch(url, {
    credentials: "include",
    ...(signal ? { signal } : {})
  });
  const body = await response.json() as {
    players?: FlagAccessPlayerSearchResult[];
    error?: { message?: string };
  };
  if (!response.ok || !body.players) {
    throw new Error(body.error?.message ?? "Player search failed.");
  }
  return body.players;
}

export async function fetchFlagManagement(serverHttpBase: string, signal?: AbortSignal): Promise<FlagManagementDashboardSnapshot> {
  return accessRequest(serverHttpBase, "/api/flags/management", {
    method: "GET", resultKey: "management", ...(signal ? { signal } : {})
  });
}

export async function saveFlagPreferences(serverHttpBase: string, csrfToken: string, preferences: FlagOwnerPreferencesSnapshot): Promise<FlagOwnerPreferencesSnapshot> {
  return accessRequest(serverHttpBase, "/api/flags/management/preferences", {
    method: "PATCH", csrfToken, body: preferences, resultKey: "preferences"
  });
}

export async function saveBulkFlagToll(serverHttpBase: string, csrfToken: string, mode: "public" | "normal", tollGold: string): Promise<number> {
  return accessRequest(serverHttpBase, "/api/flags/management/bulk-toll", {
    method: "POST", csrfToken, body: { mode, tollGold }, resultKey: "updated"
  });
}

export async function setNormalFlagGrant(serverHttpBase: string, csrfToken: string, playerId: string, allowed: boolean): Promise<void> {
  await accessRequest(serverHttpBase, `/api/flags/management/normal-grants/${encodeURIComponent(playerId)}`, {
    method: allowed ? "PUT" : "DELETE", csrfToken, resultKey: "ok"
  });
}

async function accessRequest<T = FlagAccessSnapshot>(
  serverHttpBase: string,
  path: string,
  options: Readonly<{
    method: "GET" | "PATCH" | "PUT" | "POST" | "DELETE";
    csrfToken?: string;
    body?: unknown;
    signal?: AbortSignal;
    resultKey?: string;
  }>
): Promise<T> {
  const response = await fetch(new URL(path, serverHttpBase), {
    method: options.method,
    credentials: "include",
    ...(options.body === undefined && !options.csrfToken ? {} : { headers: {
      "content-type": "application/json",
      ...(options.csrfToken ? { "x-csrf-token": options.csrfToken } : {})
    }}),
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    ...(options.signal ? { signal: options.signal } : {})
  });
  const body = await response.json() as Record<string, unknown> & {
    access?: T;
    error?: { message?: string };
  };
  const value = options.resultKey ? body[options.resultKey] : body.access;
  if (!response.ok || value === undefined) {
    throw new Error(body.error?.message ?? "Flag access request failed.");
  }
  return value as T;
}
