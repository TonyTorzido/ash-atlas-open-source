import type {
  AtlasShrineProgressionSnapshot,
  FlagSnapshot,
  PlayerInventorySnapshot
} from "@ash-atlas/shared";

export type AtlasShrineMutationResult = Readonly<{
  progression: AtlasShrineProgressionSnapshot;
  inventory: PlayerInventorySnapshot;
  replayed: boolean;
  flag?: FlagSnapshot;
}>;

export async function fetchAtlasShrineProgression(
  serverHttpBase: string,
  signal?: AbortSignal
): Promise<AtlasShrineProgressionSnapshot> {
  const result = await request<{ progression: AtlasShrineProgressionSnapshot }>(
    serverHttpBase,
    "/api/flags/atlas-shrines/status",
    { method: "GET", ...(signal ? { signal } : {}) }
  );
  return result.progression;
}

export function unlockNextAtlasShrineSlot(
  serverHttpBase: string,
  csrfToken: string
): Promise<AtlasShrineMutationResult> {
  return request(serverHttpBase, "/api/flags/atlas-shrines/unlock", {
    method: "POST",
    csrfToken,
    body: { requestId: crypto.randomUUID() }
  });
}

export function upgradeFlagTier(
  serverHttpBase: string,
  csrfToken: string,
  flagId: string,
  targetTier: "stone" | "atlas_shrine"
): Promise<AtlasShrineMutationResult & { flag: FlagSnapshot }> {
  return request(serverHttpBase, `/api/flags/${encodeURIComponent(flagId)}/upgrade`, {
    method: "POST",
    csrfToken,
    body: { requestId: crypto.randomUUID(), targetTier }
  });
}

export function repairBurningStoneFlag(
  serverHttpBase: string,
  csrfToken: string,
  flagId: string
): Promise<{ flag: FlagSnapshot; replayed: boolean }> {
  return request(serverHttpBase, `/api/flags/${encodeURIComponent(flagId)}/repair`, {
    method: "POST",
    csrfToken,
    body: { requestId: crypto.randomUUID() }
  });
}

async function request<Result>(
  serverHttpBase: string,
  path: string,
  options: Readonly<{
    method: "GET" | "POST";
    csrfToken?: string;
    body?: unknown;
    signal?: AbortSignal;
  }>
): Promise<Result> {
  const response = await fetch(`${serverHttpBase}${path}`, {
    method: options.method,
    credentials: "include",
    headers: {
      ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(options.csrfToken ? { "x-csrf-token": options.csrfToken } : {})
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    ...(options.signal ? { signal: options.signal } : {})
  });
  const payload = await response.json().catch(() => null) as
    | (Result & { error?: { message?: string } })
    | null;
  if (!response.ok || !payload) {
    throw new Error(payload?.error?.message ?? `Atlas Shrine request failed: HTTP ${response.status}`);
  }
  return payload;
}
