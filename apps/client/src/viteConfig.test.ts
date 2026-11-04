import { describe, expect, it } from "vitest";

import {
  configureLauncherProcessEnvironment,
  accountPagesDevRoute,
  createViteConfig,
  parseByteRange,
  resolveClientBuildSha,
  resolveDevProxyService,
  waterVisualTilesDevRoute
  , nativeBuildIdentity
} from "../vite.config.js";

describe("Vite development networking", () => {
  it("emits the exact compiled native identity and push mode, but no marker for web",() => {
    const emitted:unknown[]=[];
    const emit=(env:NodeJS.ProcessEnv):void => {
      const plugin=nativeBuildIdentity(env);
      const generate=plugin.generateBundle as (this:{emitFile:(value:unknown)=>void})=>void;
      generate.call({emitFile:(value) => emitted.push(value)});
    };
    emit({VITE_CAPACITOR:"true",VITE_CAPACITOR_PLATFORM:"android",VITE_NATIVE_APP_VERSION:"1.2.3",VITE_NATIVE_APP_BUILD:"42",VITE_NATIVE_PUSH_ENABLED:"true"});
    expect(emitted).toEqual([{type:"asset",fileName:"native-build.json",source:JSON.stringify({schemaVersion:1,platform:"android",version:"1.2.3",build:42,pushMode:"enabled"})}]);
    emit({});expect(emitted).toHaveLength(1);
    expect(() => emit({VITE_CAPACITOR:"true",VITE_NATIVE_APP_VERSION:"1.2.3-beta",VITE_NATIVE_APP_BUILD:"42"})).toThrow();
  });
  it("binds to the LAN and routes game, world, and WebSocket traffic", () => {
    const config = createViteConfig({
      ASH_ATLAS_FRONTEND_PORT: "5300",
      ASH_ATLAS_GAME_SERVER_TARGET: "http://127.0.0.1:3200",
      ASH_ATLAS_WORLD_API_TARGET: "http://127.0.0.1:8765"
    });

    expect(config.server?.host).toBe("0.0.0.0");
    expect(config.server?.port).toBe(5300);
    expect(Object.keys(config.server?.proxy ?? {})).toEqual([
      "/api/lookup",
      "/api/overlays.geojson",
      "/api",
      "/ws"
    ]);
    expect(config.server?.proxy).toMatchObject({
      "/api/lookup": { target: "http://127.0.0.1:8765" },
      "/api/overlays.geojson": { target: "http://127.0.0.1:8765" },
      "/api": { target: "http://127.0.0.1:3200" },
      "/ws": { target: "http://127.0.0.1:3200", ws: true }
    });
  });

  it.each([
    ["/api/auth/session", "game"],
    ["/api/auth/dev", "game"],
    ["/api/profile/me", "game"],
    ["/api/kingdom/state", "game"],
    ["/api/lookup?q=Albuquerque", "world"],
    ["/api/overlays.geojson?bbox=1,2,3,4", "world"],
    ["/ws", "game-ws"]
  ] as const)("routes %s to %s", (pathname, service) => {
    expect(resolveDevProxyService(pathname)).toBe(service);
  });

  it("forces launcher-owned Vite processes into noninteractive mode", () => {
    const launcherEnvironment = { VITE_RUNTIME_LABEL: "feature-example", CI: "false" };
    configureLauncherProcessEnvironment(launcherEnvironment);
    expect(launcherEnvironment.CI).toBe("true");

    const ordinaryEnvironment = { CI: "false" };
    configureLauncherProcessEnvironment(ordinaryEnvironment);
    expect(ordinaryEnvironment.CI).toBe("false");
  });

  it("embeds the exact runtime SHA in every client build", () => {
    const sha = "a".repeat(40);
    expect(resolveClientBuildSha({ RUNTIME_SHA: sha })).toBe(sha);
    expect(createViteConfig({ VITE_RUNTIME_SHA: sha }).define).toEqual({
      "import.meta.env.VITE_GAME_BUILD_SHA": JSON.stringify(sha)
    });
  });

  it("prefers the stable production client artifact identity over the game commit", () => {
    const clientSha = "b".repeat(64);
    expect(createViteConfig({
      VITE_CLIENT_BUILD_SHA: clientSha,
      VITE_RUNTIME_SHA: "a".repeat(40)
    }).define).toEqual({
      "import.meta.env.VITE_GAME_BUILD_SHA": JSON.stringify(clientSha)
    });
  });

  it("parses bounded PMTiles range requests and rejects invalid ranges", () => {
    expect(parseByteRange("bytes=0-126", 1_000)).toEqual({ start: 0, end: 126 });
    expect(parseByteRange("bytes=900-", 1_000)).toEqual({ start: 900, end: 999 });
    expect(parseByteRange("bytes=900-1200", 1_000)).toEqual({ start: 900, end: 999 });
    expect(parseByteRange("bytes=1000-", 1_000)).toBeNull();
    expect(parseByteRange("items=0-1", 1_000)).toBeNull();
  });

  it("installs the exact combined water PMTiles development route", () => {
    expect(waterVisualTilesDevRoute({
      ASH_ATLAS_WATER_VISUAL_TILES_PATH:
        "C:\\water-visual-7e4a0ddc7821bfb554d34896bb83d2e35a3304a3e7d75ace73c57f73adfa974a.pmtiles"
    }).name).toBe("ash-atlas-water-visual-tiles");
    expect(createViteConfig().plugins).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "ash-atlas-water-visual-tiles" })
    ]));
  });

  it("installs the public account pages development route", () => {
    expect(accountPagesDevRoute().name).toBe("ash-atlas-account-pages");
    expect(createViteConfig().plugins).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "ash-atlas-account-pages" })
    ]));
  });

  it("serves the water route in vite preview and keeps preview config inert by default", () => {
    const plugin = waterVisualTilesDevRoute({});
    expect(plugin.configurePreviewServer).toBe(plugin.configureServer);
    expect(createViteConfig({}).preview).toBeUndefined();
    expect(createViteConfig({ ASH_ATLAS_PREVIEW_ALLOWED_HOSTS: "a.ts.net, b.ts.net" }).preview)
      .toEqual({ allowedHosts: ["a.ts.net", "b.ts.net"] });
  });
});
