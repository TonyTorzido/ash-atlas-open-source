import { describe, expect, it, vi } from "vitest";

import {
  CLIENT_UPDATE_GUARD_KEY,
  MAX_FRESH_CLIENT_ATTEMPTS,
  MAX_CLIENT_UPDATE_ATTEMPTS,
  applyClientUpdate,
  blockClientUpdateBundle,
  clientUpdateHelpRequired,
  hasAttemptedRequiredUpdate,
  navigateToFreshClient,
  normalizeExpectedGameReleaseMarker,
  readExpectedGameRelease
} from "./freshClientNavigation.js";

describe("fresh client navigation", () => {
  it("replaces the canonical game URL exactly once with one current reconnect parameter", () => {
    const location = {
      origin: "https://playashatlas.com",
      search: "?update=obsolete&reconnect=obsolete",
      replace: vi.fn()
    };

    expect(navigateToFreshClient({ reason: "reconnect" }, location, () => 1234)).toBe(true);
    expect(navigateToFreshClient({ reason: "reconnect" }, location, () => 5678)).toBe(false);
    expect(location.replace).toHaveBeenCalledOnce();

    const target = new URL(location.replace.mock.calls[0]![0]);
    expect(target.pathname).toBe("/play/");
    expect([...target.searchParams.entries()]).toEqual([["reconnect", "1234"]]);
  });

  it("uses a cache-busting index reload and repairs caches on the second attempt only", async () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: vi.fn((key: string) => values.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => { values.set(key, value); }),
      removeItem: vi.fn((key: string) => { values.delete(key); })
    };
    const location = {
      origin: "https://playashatlas.com",
      search: "?return=world",
      replace: vi.fn()
    };
    const cacheDelete = vi.fn(async () => true);
    const unregister = vi.fn(async () => true);
    const environment = {
      location,
      storage,
      caches: { keys: vi.fn(async () => ["old-assets"]), delete: cacheDelete },
      serviceWorker: { getRegistrations: vi.fn(async () => [{ unregister }]) } as never,
      now: () => 1_234,
      random: () => 0.5
    };
    const target = { platform: "web" as const, reason: "client-release" as const, clientSha: "a".repeat(64) };

    await expect(applyClientUpdate(target, environment)).resolves.toBe("reloading");
    const firstUrl = new URL(location.replace.mock.calls[0]![0]);
    expect(firstUrl.pathname).toBe("/play/index.html");
    expect(firstUrl.searchParams.get("return")).toBe("world");
    expect(firstUrl.searchParams.get("aa-client-update-attempt")).toBe("1");
    expect(cacheDelete).not.toHaveBeenCalled();

    await expect(applyClientUpdate(target, environment)).resolves.toBe("reloading");
    const secondUrl = new URL(location.replace.mock.calls[1]![0]);
    expect(secondUrl.searchParams.get("aa-client-update-attempt")).toBe("2");
    expect(secondUrl.searchParams.get("aa-client-update")).not.toBe(firstUrl.searchParams.get("aa-client-update"));
    expect(cacheDelete).toHaveBeenCalledWith("old-assets");
    expect(unregister).toHaveBeenCalledOnce();
    expect(storage.removeItem).not.toHaveBeenCalled();
    expect(JSON.parse(values.get(CLIENT_UPDATE_GUARD_KEY) ?? "{}")).toMatchObject({
      attempts: MAX_CLIENT_UPDATE_ATTEMPTS,
      targetId: target.clientSha
    });
  });

  it("keeps the two-attempt limit when sessionStorage is unavailable", async () => {
    let search = "";
    const location = {
      origin: "https://playashatlas.com",
      get search() { return search; },
      replace: vi.fn((value: string) => { search = new URL(value).search; })
    };
    const environment = {
      location,
      storage: null,
      caches: null,
      serviceWorker: null,
      now: () => 12,
      random: () => 0.25
    };
    const target = { platform: "web" as const, reason: "preload-error" as const };

    await expect(applyClientUpdate(target, environment)).resolves.toBe("reloading");
    expect(new URLSearchParams(search).get("aa-client-update-attempt")).toBe("1");
    await expect(applyClientUpdate(target, environment)).resolves.toBe("reloading");
    expect(new URLSearchParams(search).get("aa-client-update-attempt")).toBe("2");
    await expect(applyClientUpdate(target, environment)).resolves.toBe("exhausted");
    expect(clientUpdateHelpRequired(null, location)).toBe(true);
    expect(location.replace).toHaveBeenCalledTimes(2);
  });

  it("allows a user-requested retry after a bundle has been blocked", async () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
      removeItem: (key: string) => { values.delete(key); }
    };
    const location = { origin: "https://playashatlas.com", search: "", replace: vi.fn() };
    const environment = {
      location,
      storage,
      caches: null,
      serviceWorker: null,
      now: Date.now,
      random: Math.random
    };
    const target = { platform: "web" as const, reason: "client-release" as const, clientSha: "b".repeat(64) };
    blockClientUpdateBundle(target.clientSha, storage);

    await expect(applyClientUpdate(target, environment)).resolves.toBe("exhausted");
    await expect(applyClientUpdate({ ...target, restartAttempts: true }, environment)).resolves.toBe("reloading");
    expect(location.replace).toHaveBeenCalledOnce();
  });

  it("keeps native updates as a no-op placeholder", async () => {
    const location = { origin: "capacitor://localhost", search: "", replace: vi.fn() };
    await expect(applyClientUpdate({ platform: "ios", reason: "client-release" }, {
      location,
      storage: null,
      caches: null,
      serviceWorker: null,
      now: Date.now,
      random: Math.random
    })).resolves.toBe("native_noop");
    expect(location.replace).not.toHaveBeenCalled();
  });

  it("records a required build in the sole update parameter without touching browser state", () => {
    const build = "a".repeat(40);
    const location = {
      origin: "https://playashatlas.com",
      search: "",
      replace: vi.fn()
    };
    const storage = { clear: vi.fn(), removeItem: vi.fn() };

    navigateToFreshClient({ reason: "update", requiredGameSha: build }, location, () => 99);

    const target = new URL(location.replace.mock.calls[0]![0]);
    expect([...target.searchParams.entries()]).toEqual([["update", `${build}.1.99`]]);
    expect(storage.clear).not.toHaveBeenCalled();
    expect(storage.removeItem).not.toHaveBeenCalled();
    expect(hasAttemptedRequiredUpdate(build, { search: target.search })).toBe(true);
  });

  it("carries a bounded retry attempt and removes the marker only after convergence", () => {
    const build = "b".repeat(40);
    expect(readExpectedGameRelease({ search: `?update=${build}.123456789` })).toEqual({
      gameSha: build,
      attempt: 1
    });
    expect(readExpectedGameRelease({ search: `?update=${build}.99.123` })).toEqual({
      gameSha: build,
      attempt: MAX_FRESH_CLIENT_ATTEMPTS + 1
    });
    const history = { state: { kept: true }, replaceState: vi.fn() };
    expect(normalizeExpectedGameReleaseMarker(
      build,
      { href: `https://playashatlas.com/play/?update=${build}.2.123&kept=yes`, search: `?update=${build}.2.123&kept=yes` },
      history
    )).toBe(true);
    expect(history.replaceState).toHaveBeenCalledWith(
      history.state,
      "",
      "/play/?kept=yes"
    );
    expect(normalizeExpectedGameReleaseMarker(
      "c".repeat(40),
      { href: `https://playashatlas.com/play/?update=${build}.2.123`, search: `?update=${build}.2.123` },
      history
    )).toBe(false);
  });
});
