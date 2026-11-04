import { App, type URLOpenListenerEvent } from "@capacitor/app";
import { Browser } from "@capacitor/browser";
import {
  Capacitor,
  SystemBars,
  SystemBarType,
  type PluginListenerHandle
} from "@capacitor/core";
import { Assets, loadTextures } from "pixi.js";
import type { NativePlatform } from "@ash-atlas/shared";
import { boundedFetch } from "./nativeRequest.js";
import { recordNativeDiagnostic } from "./nativeDiagnostics.js";

export const CAPACITOR_IOS_CALLBACK = "com.ashatlas.game://auth/callback";
export const CAPACITOR_ANDROID_CALLBACK = CAPACITOR_IOS_CALLBACK;
export const CAPACITOR_NATIVE_CALLBACK = CAPACITOR_IOS_CALLBACK;
export const CAPACITOR_IOS_REQUEST_HEADER = "x-ash-atlas-native-client";
export const CAPACITOR_IOS_REQUEST_HEADER_VALUE = "capacitor-ios";
export const CAPACITOR_ANDROID_REQUEST_HEADER = CAPACITOR_IOS_REQUEST_HEADER;
export const CAPACITOR_ANDROID_REQUEST_HEADER_VALUE = "capacitor-android";
export const CAPACITOR_NATIVE_REQUEST_HEADER = CAPACITOR_IOS_REQUEST_HEADER;
export const CAPACITOR_IOS_WEBSOCKET_PROTOCOL_PREFIX = "ash-atlas-native.";
export const CAPACITOR_NATIVE_WEBSOCKET_PROTOCOL_PREFIX = CAPACITOR_IOS_WEBSOCKET_PROTOCOL_PREFIX;
export const CAPACITOR_LOCAL_ASSET_ORIGIN = "capacitor://localhost/";
export const CAPACITOR_ANDROID_LOCAL_ASSET_ORIGIN = "https://localhost/";
export const CAPACITOR_NATIVE_LOCAL_ASSET_ORIGINS = Object.freeze([
  CAPACITOR_LOCAL_ASSET_ORIGIN,
  CAPACITOR_ANDROID_LOCAL_ASSET_ORIGIN
] as const);

const AUTHORIZATION_TIMEOUT_MS = 5 * 60_000;
const NATIVE_AUTHORIZATION_PROTOCOLS = new Set(["native-pkce-v1", "ios-pkce-v1"]);
let nativeTextureLoadingConfigured = false;

export const NATIVE_AUTHORIZATION_UNAVAILABLE_MESSAGE =
  "Native sign-in is waiting for the matching Ash Atlas server update.";

type NativeAuthorizationRequest = Readonly<{
  state: string;
  codeChallenge: string;
  redirectUri: string;
  platform?: NativePlatform;
  chooseAccount?: boolean;
}>;

export type NativeAuthorizationResult = Readonly<{
  code: string;
  codeVerifier: string;
  redirectUri: string;
}>;

export function isNativeApp(): boolean {
  return Capacitor.isNativePlatform();
}

export function nativePlatform(): NativePlatform | null {
  if (!isNativeApp()) return null;
  const platform = typeof Capacitor.getPlatform === "function"
    ? Capacitor.getPlatform()
    : "ios";
  return platform === "android" ? "android" : "ios";
}

export type NativeAppInfo = Readonly<{
  platform: NativePlatform;
  version: string;
  build: number;
}>;

let nativeAppInfoPromise: Promise<NativeAppInfo> | undefined;

/**
 * Read the identity embedded in the installed native shell. The web build's
 * environment values describe the bundle that was built, so they are not a
 * safe source for native compatibility checks after a live update.
 */
export function readNativeAppInfo(): Promise<NativeAppInfo | null> {
  if (!isNativeApp()) return Promise.resolve(null);
  return nativeAppInfoPromise ??= App.getInfo().then((info) => {
    const platform = nativePlatform();
    const version = typeof info.version === "string" ? info.version.trim() : "";
    const build = Number.parseInt(info.build, 10);
    if (!platform || !version || !Number.isSafeInteger(build) || build < 0) {
      throw new Error("Native app identity is invalid");
    }
    return { platform, version, build };
  });
}

export function nativeLocalAssetOrigin(): string {
  return nativePlatform() === "android"
    ? CAPACITOR_ANDROID_LOCAL_ASSET_ORIGIN
    : CAPACITOR_LOCAL_ASSET_ORIGIN;
}

export function nativeRequestHeaderValue(
  platform: NativePlatform | null = nativePlatform()
): string {
  return platform === "android"
    ? CAPACITOR_ANDROID_REQUEST_HEADER_VALUE
    : CAPACITOR_IOS_REQUEST_HEADER_VALUE;
}

/**
 * Mark the document before the React tree mounts so native WebViews can opt into
 * the large viewport. Capacitor's WKWebView does not expose a browser
 * `display-mode: standalone` media query, even though the app is full-screen.
 */
export function initializeNativeViewportRootState(): void {
  if (!isNativeApp()) return;
  document.documentElement.dataset.nativeApp = "true";
  document.documentElement.dataset.nativePlatform = nativePlatform() ?? "ios";
}

/**
 * Ask iOS to keep the home indicator out of the game surface. UIKit retains
 * final control of protected system gestures, so this is intentionally
 * best-effort and must never prevent the client from starting.
 */
export async function configureNativeSystemBars(): Promise<void> {
  if (nativePlatform() !== "ios") return;
  await SystemBars.hide({ bar: SystemBarType.NavigationBar }).catch(() => undefined);
}

export function configureNativeTextureLoading(): void {
  if (!isNativeApp() || nativeTextureLoadingConfigured) return;
  const localAssetOrigin = nativeLocalAssetOrigin();
  Assets.resolver.basePath = localAssetOrigin;
  Assets.resolver.rootPath = localAssetOrigin;
  Assets.setPreferences({
    crossOrigin: null,
    preferCreateImageBitmap: false,
    preferWorkers: false
  });
  const originalLoad = loadTextures.load;
  if (!originalLoad) return;
  const nativeLoad = async (...args: Parameters<typeof originalLoad>): Promise<unknown> => {
    const texture = await originalLoad.apply(loadTextures, args);
    if (
      typeof HTMLImageElement !== "undefined" &&
      texture &&
      typeof texture === "object" &&
      "source" in texture
    ) {
      const source = texture.source as {
        height?: unknown;
        resource?: unknown;
        resize?: unknown;
        width?: unknown;
      };
      if (
        source.resource instanceof HTMLImageElement &&
        typeof source.width === "number" &&
        typeof source.height === "number" &&
        typeof source.resize === "function" &&
        (source.width <= 0 || source.height <= 0)
      ) {
        await source.resource.decode();
        if (source.resource.naturalWidth > 0 && source.resource.naturalHeight > 0) {
          source.resize(source.resource.naturalWidth, source.resource.naturalHeight);
        }
      }
    }
    return texture;
  };
  loadTextures.load = nativeLoad as typeof originalLoad;
  nativeTextureLoadingConfigured = true;
}

export function installNativeFetchBridge(serviceBases: readonly string[]): void {
  if (!isNativeApp()) return;
  const serviceOrigins = new Set(serviceBases.map((base) => new URL(base).origin));
  const nativeFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = requestUrl(input);
    if (!url || !serviceOrigins.has(url.origin)) return nativeFetch(input, init);
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
    headers.set(CAPACITOR_NATIVE_REQUEST_HEADER, nativeRequestHeaderValue());
    return nativeFetch(input, {
      ...init,
      headers,
      credentials: init?.credentials ?? "include"
    });
  };
}

export async function beginNativeBrowserAuthorization(
  serverHttpBase: string,
  signal?: AbortSignal
): Promise<NativeAuthorizationResult> {
  if (!isNativeApp()) throw new Error("Native authorization is unavailable in this browser");
  await requireNativeAuthorizationSupport(serverHttpBase);
  signal?.throwIfAborted();
  const codeVerifier = randomBase64Url(32);
  const state = randomBase64Url(32);
  const codeChallenge = await sha256Base64Url(codeVerifier);
  const platform = nativePlatform() ?? "ios";
  const authorizationUrl = nativeAuthorizationEndpoint(serverHttpBase, {
    state,
    codeChallenge,
    redirectUri: CAPACITOR_NATIVE_CALLBACK,
    platform,
    chooseAccount: true
  });

  let timeout: number | null = null;
  let browserFinishedTimeout: number | null = null;
  let appUrlListener: PluginListenerHandle | null = null;
  let appStateListener: PluginListenerHandle | null = null;
  let browserFinishedListener: PluginListenerHandle | null = null;
  let nativeAppActive = false;
  let browserFinished = false;
  let resolveCallback!: (result: NativeAuthorizationResult) => void;
  let rejectCallback!: (error: unknown) => void;
  const callback = new Promise<NativeAuthorizationResult>((resolve, reject) => {
    resolveCallback = resolve;
    rejectCallback = reject;
  });
  const aborted = (): void => rejectCallback(new Error("Sign-in was canceled"));
  signal?.addEventListener("abort", aborted, { once: true });
  // Observe rejection even if cancellation happens while listener installation is pending.
  void callback.catch(() => undefined);
  try {
    appUrlListener = await App.addListener("appUrlOpen", (event: URLOpenListenerEvent) => {
      const result = authorizationResultFromCallback(event.url, state, codeVerifier);
      if (result) {
        if (browserFinishedTimeout !== null) window.clearTimeout(browserFinishedTimeout);
        resolveCallback(result);
      }
    });
    if (platform === "android") {
      appStateListener = await App.addListener("appStateChange", (appState: { isActive: boolean }) => {
        nativeAppActive = appState.isActive === true;
        if (nativeAppActive && browserFinished && browserFinishedTimeout === null) {
          browserFinishedTimeout = window.setTimeout(
            () => rejectCallback(new Error("Sign-in was canceled")),
            250
          );
        }
      });
    }
    browserFinishedListener = await Browser.addListener("browserFinished", () => {
      browserFinished = true;
      if (platform !== "android" || nativeAppActive) {
        browserFinishedTimeout = window.setTimeout(
          () => rejectCallback(new Error("Sign-in was canceled")),
          250
        );
      }
    });
    timeout = window.setTimeout(
      () => rejectCallback(new Error("Native sign-in timed out")),
      AUTHORIZATION_TIMEOUT_MS
    );
    signal?.throwIfAborted();
    await Browser.open({
      url: authorizationUrl,
      presentationStyle: "fullscreen"
    });
    return await callback;
  } finally {
    signal?.removeEventListener("abort", aborted);
    if (timeout !== null) window.clearTimeout(timeout);
    if (browserFinishedTimeout !== null) window.clearTimeout(browserFinishedTimeout);
    await appUrlListener?.remove();
    await appStateListener?.remove();
    await browserFinishedListener?.remove();
    await Browser.close().catch(() => undefined);
  }
}

export function nativeAuthorizationStatusEndpoint(serverHttpBase: string): string {
  return new URL("/api/auth/native/status", serverHttpBase).toString();
}

export function nativeWebSocketTicketEndpoint(serverHttpBase: string): string {
  return new URL("/api/auth/native/ticket", serverHttpBase).toString();
}

export async function refreshNativeWebSocketProtocols(
  serverHttpBase: string,
  fetcher: typeof fetch = globalThis.fetch.bind(globalThis)
): Promise<readonly string[]> {
  if (!isNativeApp()) return [];
  let response: Response;
  try {
    response = await boundedFetch(nativeWebSocketTicketEndpoint(serverHttpBase), {
      method: "GET",
      cache: "no-store",
      credentials: "include",
      headers: { [CAPACITOR_NATIVE_REQUEST_HEADER]: nativeRequestHeaderValue() }
    }, fetcher);
  } catch {
    throw new Error("Native WebSocket ticket refresh failed");
  }
  if (!response.ok) throw new Error("Native WebSocket ticket refresh failed");
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error("Native WebSocket ticket refresh returned an invalid response");
  }
  const ticket = payload && typeof payload === "object"
    ? (payload as { webSocketTicket?: unknown }).webSocketTicket
    : null;
  if (typeof ticket !== "string") throw new Error("Native WebSocket ticket is missing");
  const protocols = nativeWebSocketProtocols(ticket);
  if (protocols.length === 0) throw new Error("Native WebSocket ticket is invalid");
  return protocols;
}

export function subscribeNativeAppStateChange(
  handler: (isActive: boolean) => void
): () => void {
  if (!isNativeApp()) return () => undefined;
  let removed = false;
  let listener: PluginListenerHandle | null = null;
  void App.addListener("appStateChange", (state: { isActive: boolean }) => {
    if (!removed) {
      recordNativeDiagnostic(state.isActive === true ? "active" : "inactive");
      handler(state.isActive === true);
    }
  }).then((next) => {
    if (removed) void next.remove();
    else listener = next;
  });
  return () => {
    removed = true;
    void listener?.remove();
  };
}

export function subscribeNativeBackButton(
  handler: (event: { canGoBack: boolean }) => void
): () => void {
  if (!isNativeApp()) return () => undefined;
  let removed = false;
  let listener: PluginListenerHandle | null = null;
  void App.addListener("backButton", (event: { canGoBack: boolean }) => {
    if (!removed) handler(event);
  }).then((next) => {
    if (removed) void next.remove();
    else listener = next;
  });
  return () => {
    removed = true;
    void listener?.remove();
  };
}

export async function exitNativeApp(): Promise<void> {
  if (isNativeApp()) await App.exitApp();
}

export function readNativeAuthorizationRequest(
  location: Pick<Location, "search"> = window.location
): NativeAuthorizationRequest | null {
  const query = new URLSearchParams(location.search);
  const state = query.get("state") ?? "";
  const codeChallenge = query.get("code_challenge") ?? "";
  const redirectUri = query.get("redirect_uri") ?? "";
  if (
    !["ios", "android"].includes(query.get("native_auth") ?? "") ||
    !/^[A-Za-z0-9_-]{43}$/u.test(state) ||
    !/^[A-Za-z0-9_-]{43}$/u.test(codeChallenge) ||
    redirectUri !== CAPACITOR_NATIVE_CALLBACK
  ) {
    return null;
  }
  return { state, codeChallenge, redirectUri, ...(query.get("choose_account") === "true" ? { chooseAccount: true } : {}) };
}

export function nativeAuthorizationEndpoint(
  serverHttpBase: string,
  request: NativeAuthorizationRequest
): string {
  const url = new URL("/api/auth/native/authorize", serverHttpBase);
  url.searchParams.set("state", request.state);
  url.searchParams.set("code_challenge", request.codeChallenge);
  url.searchParams.set("redirect_uri", request.redirectUri);
  if (request.platform) url.searchParams.set("platform", request.platform);
  if (request.chooseAccount) url.searchParams.set("choose_account", "true");
  return url.toString();
}

export function nativeWebSocketProtocols(ticket: string | undefined): string[] {
  return ticket && /^[A-Za-z0-9_-]{43}$/u.test(ticket)
    ? [`${CAPACITOR_NATIVE_WEBSOCKET_PROTOCOL_PREFIX}${ticket}`]
    : [];
}

function authorizationResultFromCallback(
  value: string,
  expectedState: string,
  codeVerifier: string
): NativeAuthorizationResult | null {
  try {
    const url = new URL(value);
    if (`${url.protocol}//${url.host}${url.pathname}` !== CAPACITOR_NATIVE_CALLBACK) return null;
    const code = url.searchParams.get("code") ?? "";
    const state = url.searchParams.get("state") ?? "";
    if (state !== expectedState || !/^[A-Za-z0-9_-]{43}$/u.test(code)) return null;
    return { code, codeVerifier, redirectUri: CAPACITOR_NATIVE_CALLBACK };
  } catch {
    return null;
  }
}

async function requireNativeAuthorizationSupport(serverHttpBase: string): Promise<void> {
  try {
    const response = await boundedFetch(nativeAuthorizationStatusEndpoint(serverHttpBase), {
      method: "GET",
      cache: "no-store"
    });
    if (!response.ok) throw new Error("unsupported");
    const payload = await response.json() as { protocol?: unknown };
    if (typeof payload.protocol !== "string" || !NATIVE_AUTHORIZATION_PROTOCOLS.has(payload.protocol)) {
      throw new Error("unsupported");
    }
  } catch {
    throw new Error(NATIVE_AUTHORIZATION_UNAVAILABLE_MESSAGE);
  }
}

function requestUrl(input: RequestInfo | URL): URL | null {
  try {
    if (input instanceof URL) return input;
    if (input instanceof Request) return new URL(input.url);
    return new URL(input, window.location.href);
  } catch {
    return null;
  }
}

function randomBase64Url(byteLength: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  return bytesToBase64Url(bytes);
}

async function sha256Base64Url(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return bytesToBase64Url(new Uint8Array(digest));
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}
