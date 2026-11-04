// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  BROWSER_STATE_SCHEMA_KEY,
  BROWSER_STATE_SCHEMA_VERSION,
  isAshAtlasOwnedCache,
  migrateBrowserStateBeforeGameplay
} from "./browserStateMigration.js";

describe("browser state migration", () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    history.replaceState({}, "", "/play/");
  });

  it("removes only Ash Atlas transient history, scoped workers, and owned caches", async () => {
    history.replaceState({
      ashAtlasMobileMenuView: "messages",
      ashAtlasChatOverlay: true,
      unrelated: "preserved"
    }, "", "/play/");
    localStorage.setItem("unrelated", "preserved");

    const unregisterPlay = vi.fn(async () => true);
    const unregisterOther = vi.fn(async () => true);
    const origin = window.location.origin;
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: {
        getRegistrations: vi.fn(async () => [
          registration(`${origin}/play/`, `${origin}/play/sw.js`, unregisterPlay),
          registration(`${origin}/other/`, `${origin}/other/sw.js`, unregisterOther)
        ])
      }
    });
    const deleteCache = vi.fn(async () => true);
    vi.stubGlobal("caches", {
      keys: vi.fn(async () => ["ash-atlas-shell-v1", "other-app-cache"]),
      delete: deleteCache
    });

    const result = await migrateBrowserStateBeforeGameplay();

    expect(result).toMatchObject({
      version: BROWSER_STATE_SCHEMA_VERSION,
      historyKeysRemoved: 2,
      serviceWorkersRemoved: 1,
      cachesRemoved: 1,
      refreshRequired: false,
      failures: []
    });
    expect(history.state).toEqual({ unrelated: "preserved" });
    expect(unregisterPlay).toHaveBeenCalledOnce();
    expect(unregisterOther).not.toHaveBeenCalled();
    expect(deleteCache).toHaveBeenCalledExactlyOnceWith("ash-atlas-shell-v1");
    expect(localStorage.getItem("unrelated")).toBe("preserved");
    expect(localStorage.getItem(BROWSER_STATE_SCHEMA_KEY))
      .toBe(String(BROWSER_STATE_SCHEMA_VERSION));
  });

  it("recognizes only explicitly owned cache namespaces", () => {
    expect(isAshAtlasOwnedCache("ash-atlas-assets-v1")).toBe(true);
    expect(isAshAtlasOwnedCache("workbox-precache-ash-atlas")).toBe(true);
    expect(isAshAtlasOwnedCache("atlas-of-another-app")).toBe(false);
  });

  it("fully retires a controlling play worker and requests one fresh navigation", async () => {
    const unregisterPlay = vi.fn(async () => true);
    const origin = window.location.origin;
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: {
        controller: { scriptURL: `${origin}/play/sw.js` },
        getRegistrations: vi.fn(async () => [
          registration(`${origin}/play/`, `${origin}/play/sw.js`, unregisterPlay)
        ])
      }
    });
    const deleteCache = vi.fn(async () => true);
    vi.stubGlobal("caches", {
      keys: vi.fn(async () => ["legacy-precache-v1", "ash-atlas-shell-v1"]),
      delete: deleteCache
    });

    const result = await migrateBrowserStateBeforeGameplay();

    expect(result).toMatchObject({
      serviceWorkersRemoved: 1,
      cachesRemoved: 2,
      refreshRequired: true,
      failures: []
    });
    expect(deleteCache).toHaveBeenCalledTimes(2);
  });
});

function registration(
  scope: string,
  scriptURL: string,
  unregister: () => Promise<boolean>
): ServiceWorkerRegistration {
  return {
    scope,
    active: { scriptURL },
    unregister
  } as unknown as ServiceWorkerRegistration;
}
