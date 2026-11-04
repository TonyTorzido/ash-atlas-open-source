// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const plugins = vi.hoisted(() => ({
  appAddListener: vi.fn(),
  appGetInfo: vi.fn(),
  browserAddListener: vi.fn(),
  browserClose: vi.fn(),
  browserOpen: vi.fn(),
  systemBarsHide: vi.fn()
}));
const platform = vi.hoisted(() => ({ isNative: true, name: "ios" }));
const pixi = vi.hoisted(() => {
  const originalLoad = vi.fn();
  return {
    loadTextures: { load: originalLoad },
    originalLoad,
    resolver: { basePath: "", rootPath: "" },
    setPreferences: vi.fn()
  };
});

vi.mock("@capacitor/core", () => ({
  registerPlugin: () => ({}),
  Capacitor: {
    getPlatform: () => platform.name,
    isNativePlatform: () => platform.isNative
  },
  SystemBars: { hide: plugins.systemBarsHide },
  SystemBarType: { NavigationBar: "NavigationBar" }
}));

vi.mock("pixi.js", () => ({
  Assets: { resolver: pixi.resolver, setPreferences: pixi.setPreferences },
  loadTextures: pixi.loadTextures
}));

vi.mock("@capacitor/app", () => ({
  App: { addListener: plugins.appAddListener, getInfo: plugins.appGetInfo }
}));

vi.mock("@capacitor/browser", () => ({
  Browser: {
    addListener: plugins.browserAddListener,
    close: plugins.browserClose,
    open: plugins.browserOpen
  }
}));

import {
  beginNativeBrowserAuthorization,
  CAPACITOR_IOS_CALLBACK,
  CAPACITOR_IOS_WEBSOCKET_PROTOCOL_PREFIX,
  CAPACITOR_LOCAL_ASSET_ORIGIN,
  configureNativeSystemBars,
  configureNativeTextureLoading,
  initializeNativeViewportRootState,
  NATIVE_AUTHORIZATION_UNAVAILABLE_MESSAGE,
  nativeAuthorizationEndpoint,
  nativeAuthorizationStatusEndpoint,
  nativeWebSocketProtocols,
  readNativeAuthorizationRequest,
  readNativeAppInfo
} from "./nativeApp.js";

beforeEach(() => {
  for (const plugin of Object.values(plugins)) plugin.mockReset();
  pixi.originalLoad.mockReset();
  pixi.setPreferences.mockReset();
  platform.isNative = true;
  platform.name = "ios";
  plugins.browserClose.mockResolvedValue(undefined);
  plugins.systemBarsHide.mockResolvedValue(undefined);
  plugins.appGetInfo.mockResolvedValue({ version: "1.2.3", build: "42" });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("native app URL contracts", () => {
  it("reads the installed native shell identity from Capacitor App info", async () => {
    await expect(readNativeAppInfo()).resolves.toEqual({
      platform: "ios",
      version: "1.2.3",
      build: 42
    });
    expect(plugins.appGetInfo).toHaveBeenCalledOnce();
  });

  it("marks native documents for the full-screen large viewport", () => {
    document.documentElement.removeAttribute("data-native-app");
    document.documentElement.removeAttribute("data-native-platform");

    initializeNativeViewportRootState();

    expect(document.documentElement.dataset.nativeApp).toBe("true");
    expect(document.documentElement.dataset.nativePlatform).toBe("ios");

    platform.isNative = false;
    document.documentElement.removeAttribute("data-native-app");
    document.documentElement.removeAttribute("data-native-platform");
    initializeNativeViewportRootState();
    expect(document.documentElement.dataset.nativeApp).toBeUndefined();
    expect(document.documentElement.dataset.nativePlatform).toBeUndefined();
  });

  it("hides the iOS home indicator without changing Android or web system bars", async () => {
    await configureNativeSystemBars();
    expect(plugins.systemBarsHide).toHaveBeenCalledWith({ bar: "NavigationBar" });

    plugins.systemBarsHide.mockClear();
    platform.name = "android";
    await configureNativeSystemBars();
    expect(plugins.systemBarsHide).not.toHaveBeenCalled();

    platform.name = "ios";
    platform.isNative = false;
    await configureNativeSystemBars();
    expect(plugins.systemBarsHide).not.toHaveBeenCalled();
  });

  it("continues starting when iOS declines the home-indicator request", async () => {
    plugins.systemBarsHide.mockRejectedValueOnce(new Error("unavailable"));
    await expect(configureNativeSystemBars()).resolves.toBeUndefined();
  });

  it("leaves Pixi's browser texture loader and preferences unchanged", () => {
    platform.isNative = false;
    const browserLoad = pixi.loadTextures.load;
    const browserBasePath = pixi.resolver.basePath;
    const browserRootPath = pixi.resolver.rootPath;

    configureNativeTextureLoading();

    expect(pixi.setPreferences).not.toHaveBeenCalled();
    expect(pixi.loadTextures.load).toBe(browserLoad);
    expect(pixi.resolver.basePath).toBe(browserBasePath);
    expect(pixi.resolver.rootPath).toBe(browserRootPath);
  });

  it("settles zero-size WebView images and installs the native loader only once", async () => {
    const image = document.createElement("img");
    let naturalWidth = 0;
    let naturalHeight = 0;
    Object.defineProperties(image, {
      naturalHeight: { configurable: true, get: () => naturalHeight },
      naturalWidth: { configurable: true, get: () => naturalWidth }
    });
    const decode = vi.fn(async () => {
      naturalWidth = 1_254;
      naturalHeight = 1_254;
    });
    Object.defineProperty(image, "decode", { configurable: true, value: decode });
    const resize = vi.fn();
    const texture = {
      source: { height: 0, resource: image, resize, width: 0 }
    };
    pixi.originalLoad.mockResolvedValue(texture);

    configureNativeTextureLoading();

    expect(pixi.setPreferences).toHaveBeenCalledWith({
      crossOrigin: null,
      preferCreateImageBitmap: false,
      preferWorkers: false
    });
    expect(pixi.resolver.basePath).toBe(CAPACITOR_LOCAL_ASSET_ORIGIN);
    expect(pixi.resolver.rootPath).toBe(CAPACITOR_LOCAL_ASSET_ORIGIN);
    const nativeLoad = pixi.loadTextures.load;

    configureNativeTextureLoading();
    const result = await pixi.loadTextures.load("capacitor://localhost/assets/tree.png");

    expect(pixi.setPreferences).toHaveBeenCalledOnce();
    expect(pixi.loadTextures.load).toBe(nativeLoad);
    expect(result).toBe(texture);
    expect(decode).toHaveBeenCalledOnce();
    expect(resize).toHaveBeenCalledWith(1_254, 1_254);
  });

  it("parses and forwards an exact iOS authorization request", () => {
    const state = "s".repeat(43);
    const challenge = "c".repeat(43);
    const search = new URLSearchParams({
      native_auth: "ios",
      state,
      code_challenge: challenge,
      redirect_uri: CAPACITOR_IOS_CALLBACK
    });
    const request = readNativeAuthorizationRequest({ search: `?${search}` });

    expect(request).toEqual({
      state,
      codeChallenge: challenge,
      redirectUri: CAPACITOR_IOS_CALLBACK
    });
    expect(nativeAuthorizationEndpoint("https://playashatlas.com", request!)).toBe(
      `https://playashatlas.com/api/auth/native/authorize?state=${state}&code_challenge=${challenge}&redirect_uri=com.ashatlas.game%3A%2F%2Fauth%2Fcallback`
    );
    expect(nativeAuthorizationStatusEndpoint("https://playashatlas.com")).toBe(
      "https://playashatlas.com/api/auth/native/status"
    );
  });

  it("rejects callbacks and websocket tickets outside the exact contract", () => {
    expect(readNativeAuthorizationRequest({ search: "?native_auth=ios" })).toBeNull();
    expect(nativeWebSocketProtocols("short")).toEqual([]);
    const ticket = "t".repeat(43);
    expect(nativeWebSocketProtocols(ticket)).toEqual([
      `${CAPACITOR_IOS_WEBSOCKET_PROTOCOL_PREFIX}${ticket}`
    ]);
  });

  it("checks protocol compatibility before opening a browser", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 404 })));

    await expect(beginNativeBrowserAuthorization("https://playashatlas.com")).rejects.toThrow(
      NATIVE_AUTHORIZATION_UNAVAILABLE_MESSAGE
    );
    expect(plugins.browserOpen).not.toHaveBeenCalled();
  });

  it("opens the authorization bridge full-screen and accepts its app callback", async () => {
    let appUrlOpen: ((event: { url: string }) => void) | undefined;
    const listener = { remove: vi.fn(async () => undefined) };
    plugins.appAddListener.mockImplementation(async (event, callback) => {
      if (event === "appUrlOpen") appUrlOpen = callback;
      return listener;
    });
    plugins.browserAddListener.mockResolvedValue(listener);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ protocol: "ios-pkce-v1" }),
      { status: 200, headers: { "content-type": "application/json" } }
    )));
    plugins.browserOpen.mockImplementation(async ({ url }) => {
      const authorization = new URL(url);
      queueMicrotask(() => appUrlOpen?.({
        url: `${CAPACITOR_IOS_CALLBACK}?code=${"c".repeat(43)}&state=${authorization.searchParams.get("state")}`
      }));
    });

    const result = await beginNativeBrowserAuthorization("https://playashatlas.com");

    expect(result).toMatchObject({
      code: "c".repeat(43),
      redirectUri: CAPACITOR_IOS_CALLBACK
    });
    expect(result.codeVerifier).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(plugins.browserOpen).toHaveBeenCalledOnce();
    const options = plugins.browserOpen.mock.calls[0]![0];
    expect(options.presentationStyle).toBe("fullscreen");
    expect(new URL(options.url).pathname).toBe("/api/auth/native/authorize");
  });

  it("does not cancel Android authorization when browserFinished precedes app resume", async () => {
    vi.useFakeTimers();
    let appUrlOpen: ((event: { url: string }) => void) | undefined;
    let appStateChange: ((state: { isActive: boolean }) => void) | undefined;
    let browserFinished: (() => void) | undefined;
    const listener = { remove: vi.fn(async () => undefined) };
    platform.isNative = true;
    platform.name = "android";
    plugins.appAddListener.mockImplementation(async (event, callback) => {
      if (event === "appUrlOpen") appUrlOpen = callback;
      if (event === "appStateChange") appStateChange = callback;
      return listener;
    });
    plugins.browserAddListener.mockImplementation(async (event, callback) => {
      if (event === "browserFinished") browserFinished = callback;
      return listener;
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ protocol: "ios-pkce-v1" }),
      { status: 200, headers: { "content-type": "application/json" } }
    )));
    plugins.browserOpen.mockImplementation(async ({ url }) => {
      const authorization = new URL(url);
      appStateChange?.({ isActive: false });
      browserFinished?.();
      await vi.advanceTimersByTimeAsync(300);
      appStateChange?.({ isActive: true });
      appUrlOpen?.({
        url: `${CAPACITOR_IOS_CALLBACK}?code=${"c".repeat(43)}&state=${authorization.searchParams.get("state")}`
      });
    });

    const result = await beginNativeBrowserAuthorization("https://playashatlas.com");

    expect(result).toMatchObject({
      code: "c".repeat(43),
      redirectUri: CAPACITOR_IOS_CALLBACK
    });
  });
});
