import type { HarvestAccessMode, HarvestTollType, HarvestTollsSnapshot } from "@ash-atlas/shared";

export function fetchHarvestTolls(serverHttpBase: string, signal?: AbortSignal): Promise<HarvestTollsSnapshot> {
  return request(serverHttpBase, "/api/harvest-tolls", { method: "GET", ...(signal ? { signal } : {}) });
}
export function saveHarvestToll(serverHttpBase: string, csrfToken: string, input: { harvestType: HarvestTollType; tollGold: string; expectedRevision: string }): Promise<HarvestTollsSnapshot> {
  return request(serverHttpBase, "/api/harvest-tolls", { method: "PATCH", csrfToken, body: input });
}
export function saveHarvestAccess(serverHttpBase: string, csrfToken: string, assetId: string, input: { harvestType: HarvestTollType; accessMode: HarvestAccessMode; expectedRevision: string }): Promise<HarvestTollsSnapshot> {
  return request(serverHttpBase, `/api/harvest-tolls/assets/${encodeURIComponent(assetId)}`, { method: "PATCH", csrfToken, body: input });
}
async function request(serverHttpBase: string, path: string, options: { method: "GET" | "PATCH"; csrfToken?: string; body?: unknown; signal?: AbortSignal }): Promise<HarvestTollsSnapshot> {
  const response = await fetch(new URL(path, serverHttpBase), {
    method: options.method, credentials: "include",
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    ...(options.body === undefined && !options.csrfToken ? {} : { headers: {
      "content-type": "application/json", ...(options.csrfToken ? { "x-csrf-token": options.csrfToken } : {})
    }}),
    ...(options.signal ? { signal: options.signal } : {})
  });
  const body = await response.json() as { tolls?: HarvestTollsSnapshot; error?: { message?: string } };
  if (!response.ok || !body.tolls) throw new Error(body.error?.message ?? "Tolls could not be loaded.");
  return body.tolls;
}
