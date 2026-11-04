import { describe, expect, it, vi } from "vitest";

import {
  checkNativeCompatibility,
  nativeCompatibilityPresentation
} from "./nativeCompatibility.js";

const identity = {
  platform: "ios" as const,
  version: "1.0.0",
  build: 1,
  wsMin: 3,
  wsMax: 3
};

describe("native compatibility client", () => {
  it("sends platform, bundle identity, and protocol range", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const query = new URL(String(input)).searchParams;
      expect(query.get("platform")).toBe("ios");
      expect(query.get("build")).toBe("1");
      expect(query.get("wsMin")).toBe("3");
      return new Response(JSON.stringify({
        contractVersion: 1,
        ...identity,
        build: String(identity.build),
        minVersion: "0.0.0",
        recommendedVersion: "1.0.0",
        currentVersion: "1.0.0",
        hardMinimum: { version: "0.0.0", build: 0 },
        recommendedMinimum: { version: "1.0.0", build: 1 },
        latest: { version: "1.0.0", build: 1 },
        storeUrl: null,
        serverSha: "a".repeat(40),
        status: "supported"
      }), { status: 200 });
    });
    await expect(checkNativeCompatibility("https://playashatlas.com", identity, fetcher))
      .resolves.toMatchObject({ platform: "ios", status: "supported" });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("presents required updates as blocking and recommended updates as optional", () => {
    const base = {
      contractVersion: 1 as const,
      ...identity,
      build: String(identity.build),
      minVersion: "1.0.0",
      recommendedVersion: "1.1.0",
      currentVersion: "1.1.0",
      hardMinimum: { version: "1.0.0", build: 1 },
      recommendedMinimum: { version: "1.1.0", build: 2 },
      latest: { version: "1.1.0", build: 2 },
      storeUrl: "https://apps.example/update",
      wsMin: 3,
      wsMax: 3,
      serverSha: null
    };
    expect(nativeCompatibilityPresentation({ ...base, status: "required" })).toMatchObject({
      status: "required",
      storeUrl: "https://apps.example/update"
    });
    expect(nativeCompatibilityPresentation({ ...base, status: "recommended" }).message)
      .toContain("recommended");
  });
});
