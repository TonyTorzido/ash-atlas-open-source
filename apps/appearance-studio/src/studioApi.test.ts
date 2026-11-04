import {
  DEFAULT_BOSS_APPEARANCE_CATALOG,
  DEFAULT_PLAYER_APPEARANCE_CATALOG,
  ITEM_VARIANT_CATALOG
} from "@ash-atlas/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

import { StudioApi } from "./studioApi.js";
import type { DungeonAssetImportOptions, StudioSession } from "./bridgeTypes.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Appearance Studio API session recovery", () => {
  it("refreshes an explicitly invalid bridge session once and retries the mutation", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(session("old-token")))
      .mockResolvedValueOnce(jsonResponse({
        error: "Invalid Appearance Studio session token",
        code: "STUDIO_SESSION_INVALID"
      }, 403))
      .mockResolvedValueOnce(jsonResponse(session("new-token")))
      .mockResolvedValueOnce(jsonResponse({
        catalog: {
          ...DEFAULT_PLAYER_APPEARANCE_CATALOG,
          catalogRevision: DEFAULT_PLAYER_APPEARANCE_CATALOG.catalogRevision + 1
        },
        bossCatalog: {
          ...DEFAULT_BOSS_APPEARANCE_CATALOG,
          catalogRevision: DEFAULT_BOSS_APPEARANCE_CATALOG.catalogRevision + 1
        },
        itemVariants: ITEM_VARIANT_CATALOG,
        modifiedFiles: ["catalog.json"]
      }));
    const api = new StudioApi();
    await api.loadSession();

    const published = await api.publish(
      DEFAULT_PLAYER_APPEARANCE_CATALOG,
      ITEM_VARIANT_CATALOG,
      DEFAULT_BOSS_APPEARANCE_CATALOG
    );

    expect(published.catalog.catalogRevision)
      .toBe(DEFAULT_PLAYER_APPEARANCE_CATALOG.catalogRevision + 1);
    expect(requestToken(fetchMock.mock.calls[1]!)).toBe("old-token");
    expect(requestToken(fetchMock.mock.calls[3]!)).toBe("new-token");
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("does not retry a mutation after an ambiguous network failure", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(session("valid-token")))
      .mockRejectedValueOnce(new TypeError("Failed to fetch"));
    const api = new StudioApi();
    await api.loadSession();

    await expect(api.publish(
      DEFAULT_PLAYER_APPEARANCE_CATALOG,
      ITEM_VARIANT_CATALOG,
      DEFAULT_BOSS_APPEARANCE_CATALOG
    )).rejects.toThrow("Failed to fetch");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("Appearance Studio asset encoding", () => {
  const dungeonOptions: DungeonAssetImportOptions = {
    displayName: "Floor",
    prefabId: "floor",
    kind: "surface",
    layer: "background",
    renderMode: "tile",
    defaultWidth: 32,
    defaultHeight: 32
  };
  const cases = [
    {
      name: "player asset",
      send: (api: StudioApi, file: File) => api.importPng(file, "weapons"),
      route: "/api/assets/import",
      target: { category: "weapons", assetScope: "player" }
    },
    {
      name: "boss asset",
      send: (api: StudioApi, file: File) => api.importBossWeaponPng(file, "test-boss"),
      route: "/api/assets/import",
      target: { category: "weapons", assetScope: "boss", bossId: "test-boss" }
    },
    {
      name: "runtime replacement",
      send: (api: StudioApi, file: File) => api.replaceRuntimeAsset("test-asset", file),
      route: "/api/runtime-assets/replace",
      target: { assetId: "test-asset" }
    },
    {
      name: "dungeon asset",
      send: (api: StudioApi, file: File) => api.importDungeonPng(file, dungeonOptions),
      route: "/api/dungeon-assets/import",
      target: dungeonOptions
    }
  ];

  it.each(cases)("preserves every byte across encoding chunks for $name", async ({ send, route, target }) => {
    const bytes = Uint8Array.from({ length: 0x10003 }, (_, index) => index % 256);
    let finishRead!: (buffer: ArrayBuffer) => void;
    const read = new Promise<ArrayBuffer>((resolve) => { finishRead = resolve; });
    const file = new File([], "art.png", { type: "image/png" });
    Object.defineProperty(file, "arrayBuffer", { value: () => read });
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse(session("asset-token")))
      .mockResolvedValueOnce(jsonResponse({ stagingToken: "staged" }));
    const api = new StudioApi();
    await api.loadSession();

    const pending = send(api, file);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    finishRead(bytes.buffer);
    await pending;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const request = fetchMock.mock.calls[1]!;
    expect(request[0]).toBe(route);
    expect(request[1]?.method).toBe("POST");
    expect(requestToken(request)).toBe("asset-token");
    expect(JSON.parse(String(request[1]?.body))).toEqual({
      ...target,
      fileName: "art.png",
      dataBase64: Buffer.from(bytes).toString("base64")
    });
  });
});

describe("Appearance Studio mutable inventory reads", () => {
  it("bypasses browser cache after a runtime PNG is staged", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ assets: [] }));
    const api = new StudioApi();

    await api.loadRuntimeAssets();

    expect(fetchMock).toHaveBeenCalledWith("/api/runtime-assets", { cache: "no-store" });
  });
});

function session(csrfToken: string): StudioSession {
  return {
    csrfToken,
    origin: "http://127.0.0.1:5285",
    workspace: {
      repositoryPath: "C:/repo",
      worktreePath: "C:/worktree",
      branch: "feature/studio",
      commitSha: "a".repeat(40),
      writesAllowed: true,
      writeBlockReason: null,
      catalogRevision: DEFAULT_PLAYER_APPEARANCE_CATALOG.catalogRevision,
      isLinkedWorktree: true,
      compatibility: {
        contractVersion: 8,
        supportedContractVersion: 8,
        minimumDesktopVersion: "1.8.0",
        compatible: true
      }
    },
    server: {
      pid: 123,
      worktreePath: "C:/worktree",
      branch: "feature/studio",
      commitSha: "a".repeat(40),
      port: 5285,
      startedAt: "2026-08-09T00:00:00.000Z"
    }
  };
}

function requestToken(call: Parameters<typeof fetch>): string | undefined {
  const headers = call[1]?.headers as Record<string, string> | undefined;
  return headers?.["x-appearance-studio-token"];
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" }
  });
}
