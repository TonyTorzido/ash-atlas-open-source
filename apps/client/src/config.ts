export type ClientConfig = {
  serverHttpBase: string;
  serverWsBase: string;
  worldApiBase: string;
  osmTileUrl: string;
  googleClientId: string;
  buildSha: string | null;
  runtimeIdentity: { label: string; branch: string; sha: string } | null;
  nativePlatform?: boolean;
  nativePlatformName?: "ios" | "android" | undefined;
  nativeVersion?: string | undefined;
  nativeBuild?: string | undefined;
  // The store binary's seed bundle (src/native/nativeSeedBundle.ts).
  nativeSeedBundle?: boolean;
  populationFrameBatchingEnabled?: boolean;
};

export function sameOriginServiceBases(location: Pick<Location, "origin">): {
  http: string;
  websocket: string;
} {
  const websocket = new URL(location.origin);
  websocket.protocol = websocket.protocol === "https:" ? "wss:" : "ws:";
  return { http: location.origin, websocket: websocket.origin };
}

const browserLocation = typeof window === "undefined"
  ? { origin: "http://ash-atlas.invalid" }
  : window.location;
const sameOriginBases = sameOriginServiceBases(browserLocation);
const buildSha = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(import.meta.env.VITE_GAME_BUILD_SHA ?? "")
  ? import.meta.env.VITE_GAME_BUILD_SHA
  : null;
const runtimeIdentity = import.meta.env.DEV &&
  import.meta.env.VITE_RUNTIME_LABEL &&
  import.meta.env.VITE_RUNTIME_BRANCH &&
  buildSha
  ? {
      label: import.meta.env.VITE_RUNTIME_LABEL,
      branch: import.meta.env.VITE_RUNTIME_BRANCH,
      sha: buildSha
    }
  : null;

export const clientConfig: ClientConfig = {
  serverHttpBase: import.meta.env.VITE_SERVER_HTTP_BASE ?? sameOriginBases.http,
  serverWsBase: import.meta.env.VITE_SERVER_WS_BASE ?? sameOriginBases.websocket,
  worldApiBase: import.meta.env.VITE_WORLD_API_BASE ?? sameOriginBases.http,
  googleClientId: import.meta.env.VITE_GOOGLE_CLIENT_ID ?? "",
  buildSha,
  runtimeIdentity,
  nativePlatform: import.meta.env.VITE_CAPACITOR === "true" ||
    import.meta.env.VITE_CAPACITOR_IOS === "true" ||
    import.meta.env.VITE_CAPACITOR_PLATFORM === "ios" ||
    import.meta.env.VITE_CAPACITOR_PLATFORM === "android",
  nativePlatformName: import.meta.env.VITE_CAPACITOR_PLATFORM === "android" ? "android" :
    import.meta.env.VITE_CAPACITOR_PLATFORM === "ios" || import.meta.env.VITE_CAPACITOR_IOS === "true"
      ? "ios"
      : undefined,
  nativeVersion: import.meta.env.VITE_NATIVE_APP_VERSION ?? "1.0.0",
  nativeBuild: import.meta.env.VITE_NATIVE_APP_BUILD ?? buildSha ?? "development",
  nativeSeedBundle: import.meta.env.VITE_NATIVE_SEED_BUNDLE === "true",
  populationFrameBatchingEnabled:
    import.meta.env.VITE_POPULATION_FRAME_BATCHING_ENABLED === "true",
  osmTileUrl:
    import.meta.env.VITE_OSM_TILE_URL ??
    "https://tile.openstreetmap.org/{z}/{x}/{y}.png"
};

export function runtimeDocumentTitle(
  baseTitle: string,
  identity: ClientConfig["runtimeIdentity"]
): string {
  return identity ? `${baseTitle} · ${identity.label} · ${identity.sha.slice(0, 8)}` : baseTitle;
}
