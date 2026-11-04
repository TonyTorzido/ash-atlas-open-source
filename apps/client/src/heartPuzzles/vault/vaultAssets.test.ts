import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("pixi.js", () => ({ Texture: { from: vi.fn(() => ({ fake: true })) } }));

type FakeImage = { onload: (() => void) | null; onerror: (() => void) | null; src: string };

describe("vault texture loading", () => {
  let images: FakeImage[];
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetModules();
    images = [];
    vi.stubGlobal("Image", class { onload: (() => void) | null = null; onerror: (() => void) | null = null; src = "";
      constructor() { images.push(this as FakeImage); } });
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it("retries a failed load with backoff and then loads", async () => {
    const assets = await import("./vaultAssets.js");
    expect(assets.vaultTexture("hole")).toBeNull();
    images[0]!.onerror!();
    expect(images).toHaveLength(1);
    vi.advanceTimersByTime(assets.VAULT_TEXTURE_RETRY_DELAYS_MS[0]!);
    expect(images).toHaveLength(2);
    images[1]!.onload!();
    expect(assets.vaultTexture("hole")).toEqual({ fake: true });
    expect(assets.vaultTextureFailures()).toEqual([]);
  });

  it("after every retry fails the key is reported, then dropped after the cooldown so a later draw retries", async () => {
    const assets = await import("./vaultAssets.js");
    assets.vaultTexture("seal");
    for (const delay of assets.VAULT_TEXTURE_RETRY_DELAYS_MS) {
      images.at(-1)!.onerror!();
      vi.advanceTimersByTime(delay);
    }
    images.at(-1)!.onerror!();
    expect(assets.vaultTextureFailures()).toEqual(["seal"]);
    const before = images.length;
    expect(assets.vaultTexture("seal")).toBeNull();
    expect(images).toHaveLength(before); // still cooling down
    vi.advanceTimersByTime(assets.VAULT_TEXTURE_COOLDOWN_MS);
    assets.vaultTexture("seal");
    expect(images).toHaveLength(before + 1);
    images.at(-1)!.onload!();
    expect(assets.vaultTextureFailures()).toEqual([]);
  });
});
