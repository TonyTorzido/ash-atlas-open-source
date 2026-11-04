import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NativeBundleDescriptor } from "@ash-atlas/shared";

import { registerNativeBundleRoutes } from "./nativeBundleRoutes.js";

const apps: ReturnType<typeof Fastify>[] = [];
const roots: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("native bundle route", () => {
  it("serves the current descriptor for the selected platform when the shell is compatible", async () => {
    const pointerPath = await createPointerFile();
    vi.stubEnv("NATIVE_OTA_ENABLED", "true");
    const app = buildApp(pointerPath);

    const response = await app.inject({
      method: "GET",
      url: "/api/native/bundle?platform=android&shellBuild=8&bundle=android-old"
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toEqual(descriptor("android", "android-current"));

    const builtInBundle = await app.inject({
      method: "GET",
      url: "/api/native/bundle?platform=android&shellBuild=8&bundle="
    });
    expect(builtInBundle.statusCode).toBe(200);
    expect(builtInBundle.json()).toEqual(descriptor("android", "android-current"));
  });

  it("returns 204 when the caller has the current bundle or an unsupported shell build", async () => {
    const pointerPath = await createPointerFile();
    vi.stubEnv("NATIVE_OTA_ENABLED", "true");
    const app = buildApp(pointerPath);

    const alreadyCurrent = await app.inject({
      method: "GET",
      url: "/api/native/bundle?platform=ios&shellBuild=8&bundle=ios-current"
    });
    const shellTooOld = await app.inject({
      method: "GET",
      url: "/api/native/bundle?platform=ios&shellBuild=7&bundle=ios-old"
    });

    expect(alreadyCurrent.statusCode).toBe(204);
    expect(shellTooOld.statusCode).toBe(204);
  });

  it("keeps the endpoint disabled by default, including before request validation", async () => {
    vi.stubEnv("NATIVE_OTA_ENABLED", undefined);
    const app = buildApp(resolve(tmpdir(), "missing-native-bundle-pointer.json"));

    const response = await app.inject({ method: "GET", url: "/api/native/bundle" });

    expect(response.statusCode).toBe(204);
  });

  it("serves only listed manifest files with their exact signed headers", async () => {
    const pointerPath = await createPointerFile();
    const publicRoot = await createManifestFixture();
    const app = buildApp(pointerPath, publicRoot);
    const base = `/play/native-bundles/ios/${"a".repeat(64)}/bundle`;

    const manifest = await app.inject({
      method: "GET",
      url: `${base}?href=capawesome-live-update-manifest.json`
    });
    expect(manifest.statusCode).toBe(200);
    expect(manifest.headers["content-type"]).toMatch(/^application\/json/u);
    expect(manifest.headers["cache-control"]).toBe("public, max-age=31536000, immutable, no-transform");
    expect(manifest.headers["x-checksum"]).toBe("b".repeat(64));
    expect(manifest.headers["x-signature"]).toBe("c2lnbmF0dXJl");
    expect(manifest.body).toBe("[]");

    const png = await app.inject({ method: "GET", url: `${base}?href=assets%2Fskin.png` });
    expect(png.statusCode).toBe(200);
    expect(png.headers["content-type"]).toBe("image/png");
    expect(png.body).toBe("png-bytes");

    for (const href of ["headers.json", "assets/missing.png", "../outside.txt", "/outside.txt"]) {
      const denied = await app.inject({ method: "GET", url: `${base}?href=${encodeURIComponent(href)}` });
      expect(denied.statusCode).toBe(404);
    }
  });
});

function buildApp(pointerPath: string, publicRoot?: string) {
  const app = Fastify({ logger: false });
  apps.push(app);
  registerNativeBundleRoutes(app, { pointerPath, ...(publicRoot ? { publicRoot } : {}) });
  return app;
}

async function createManifestFixture(): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), "ash-atlas-native-assets-"));
  roots.push(root);
  const directory = resolve(root, "ios", "a".repeat(64));
  await mkdir(resolve(directory, "assets"), { recursive: true });
  await writeFile(resolve(directory, "capawesome-live-update-manifest.json"), "[]");
  await writeFile(resolve(directory, "assets", "skin.png"), "png-bytes");
  await writeFile(resolve(directory, "headers.json"), JSON.stringify({
    "capawesome-live-update-manifest.json": {
      checksum: "b".repeat(64), signature: "c2lnbmF0dXJl"
    },
    "assets/skin.png": { checksum: "c".repeat(64), signature: "c2lnbmF0dXJl" }
  }));
  return root;
}

async function createPointerFile(): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), "ash-atlas-native-bundle-"));
  roots.push(root);
  const pointerPath = resolve(root, "pointer.json");
  await writeFile(pointerPath, JSON.stringify({
    ios: { current: descriptor("ios", "ios-current"), previous: descriptor("ios", "ios-previous") },
    android: { current: descriptor("android", "android-current"), previous: null }
  }));
  return pointerPath;
}

function descriptor(platform: "ios" | "android", bundleId: string): NativeBundleDescriptor {
  return {
    bundleId,
    platform,
    url: `https://playashatlas.com/play/native-bundles/${platform}/${bundleId}.zip`,
    checksum: "a".repeat(64),
    signature: Buffer.from("signature").toString("base64"),
    sizeBytes: 1024,
    artifactType: "zip",
    clientSha: "b".repeat(40),
    serverSha: "c".repeat(40),
    generation: "test/t1274",
    minShellBuild: 8,
    protocolMin: 3,
    protocolMax: 3
  };
}
