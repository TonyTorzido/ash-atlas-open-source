import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import {
  RUNTIME_PNG_CONTENT_SCHEMA_VERSION,
  canonicalRuntimePngContentManifest,
  runtimePngContentManifestSchema,
  type RuntimePngContentManifest
} from "@ash-atlas/shared";

import { registerRuntimePngContentRoutes } from "./runtimePngContentRoutes.js";

const contentRoots: string[] = [];

afterEach(async () => {
  await Promise.all(contentRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("runtime PNG content routes", () => {
  it("selects the active compatible pack and serves verified immutable PNG blobs", async () => {
    const contentRoot = await createContentRoot();
    const lion = await readFile(resolve(process.cwd(), "../client/src/assets/chat-crests/lion.png"));
    const leaf = await readFile(resolve(process.cwd(), "../client/src/assets/chat-crests/leaf.png"));
    const first = await writePack(contentRoot, lion);
    const second = await writePack(contentRoot, leaf);
    await writeFile(resolve(contentRoot, "active.json"), JSON.stringify({ packId: first.packId }));
    const app = Fastify({ logger: false });
    registerRuntimePngContentRoutes(app, { contentDirectory: contentRoot });

    const firstManifest = await app.inject({
      method: "GET",
      url: `/api/runtime-png/v2/manifest/chat-crest-lion?schemaVersion=${RUNTIME_PNG_CONTENT_SCHEMA_VERSION}`
    });
    expect(firstManifest.statusCode).toBe(200);
    expect(firstManifest.headers["cache-control"]).toBe("no-store");
    expect(firstManifest.json<RuntimePngContentManifest>().packId).toBe(first.packId);

    const firstBlob = await app.inject({
      method: "GET",
      url: `/api/runtime-png/v2/blobs/${first.packId}/${first.sha256}`
    });
    expect(firstBlob.statusCode).toBe(200);
    expect(firstBlob.headers["content-type"]).toContain("image/png");
    expect(firstBlob.headers["cache-control"]).toContain("immutable");
    expect(firstBlob.rawPayload).toEqual(lion);

    await writeFile(resolve(contentRoot, "active.json"), JSON.stringify({ packId: second.packId }));
    const secondManifest = await app.inject({
      method: "GET",
      url: `/api/runtime-png/v2/manifest/chat-crest-lion?schemaVersion=${RUNTIME_PNG_CONTENT_SCHEMA_VERSION}`
    });
    expect(secondManifest.json<RuntimePngContentManifest>().packId).toBe(second.packId);
    const secondBlob = await app.inject({
      method: "GET",
      url: `/api/runtime-png/v2/blobs/${second.packId}/${second.sha256}`
    });
    expect(secondBlob.rawPayload).toEqual(leaf);

    await writeFile(resolve(contentRoot, "active.json"), JSON.stringify({ packId: first.packId }));
    const restoredManifest = await app.inject({
      method: "GET",
      url: `/api/runtime-png/v2/manifest/chat-crest-lion?schemaVersion=${RUNTIME_PNG_CONTENT_SCHEMA_VERSION}`
    });
    expect(restoredManifest.json<RuntimePngContentManifest>().packId).toBe(first.packId);

    const incompatible = await app.inject({
      method: "GET",
      url: "/api/runtime-png/v2/manifest/chat-crest-lion?schemaVersion=1"
    });
    expect(incompatible.statusCode).toBe(204);
    await app.close();
  });

  it("does not serve a blob whose bytes no longer match its manifest", async () => {
    const contentRoot = await createContentRoot();
    const source = await readFile(resolve(process.cwd(), "../client/src/assets/chat-crests/lion.png"));
    const pack = await writePack(contentRoot, source);
    await writeFile(resolve(contentRoot, "blobs", `${pack.sha256}.png`), Buffer.from("tampered"));
    const app = Fastify({ logger: false });
    registerRuntimePngContentRoutes(app, {
      contentDirectory: contentRoot,
      selectedPackId: () => pack.packId
    });

    const response = await app.inject({
      method: "GET",
      url: `/api/runtime-png/v2/blobs/${pack.packId}/${pack.sha256}`
    });
    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it("serves an author-added skin content ID through the existing dark tone target", async () => {
    const contentRoot = await createContentRoot();
    const crest = await readFile(resolve(process.cwd(), "../client/src/assets/chat-crests/lion.png"));
    const skin = await readFile(resolve(process.cwd(), "../../packages/player-renderer/src/assets/player-appearance/bodies/template7b-clean.png"));
    const pack = await writePack(contentRoot, crest, skin);
    const app = Fastify({ logger: false });
    registerRuntimePngContentRoutes(app, { contentDirectory: contentRoot });

    const response = await app.inject({
      method: "GET",
      url: `/api/runtime-png/v2/manifest/chat-crest-lion?schemaVersion=${RUNTIME_PNG_CONTENT_SCHEMA_VERSION}`
    });
    const manifest = response.json<RuntimePngContentManifest>();
    expect(response.statusCode).toBe(200);
    expect(manifest.assets).toContainEqual(expect.objectContaining({
      assetId: "winter-dusk-2030",
      target: { kind: "player-skin-tone", skinToneId: "dark" }
    }));

    const skinAsset = manifest.assets.find((asset) => asset.assetId === "winter-dusk-2030")!;
    const blob = await app.inject({
      method: "GET",
      url: `/api/runtime-png/v2/blobs/${pack.packId}/${skinAsset.sha256}`
    });
    expect(blob.statusCode).toBe(200);
    expect(blob.rawPayload).toEqual(skin);
    await app.close();
  });
});

async function createContentRoot(): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), "ash-atlas-runtime-png-"));
  contentRoots.push(root);
  await mkdir(resolve(root, "blobs"), { recursive: true });
  await mkdir(resolve(root, "manifests"), { recursive: true });
  return root;
}

async function writePack(contentRoot: string, bytes: Buffer, skinBytes?: Buffer): Promise<{
  packId: string;
  sha256: string;
  skinSha256?: string;
}> {
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const assets: RuntimePngContentManifest["assets"][number][] = [{
    assetId: "chat-crest-lion",
    target: {
      kind: "runtime-png",
      registrationId: "chat-crest-lion",
      relativeFile: "apps/client/src/assets/chat-crests/lion.png"
    },
    sha256,
    byteLength: bytes.byteLength
  }];
  const blobs = [{ sha256, bytes }];
  let skinSha256: string | undefined;
  if (skinBytes) {
    skinSha256 = createHash("sha256").update(skinBytes).digest("hex");
    assets.push({
      assetId: "winter-dusk-2030",
      target: { kind: "player-skin-tone", skinToneId: "dark" },
      sha256: skinSha256,
      byteLength: skinBytes.byteLength
    });
    blobs.push({ sha256: skinSha256, bytes: skinBytes });
  }
  const manifestData = {
    schemaVersion: RUNTIME_PNG_CONTENT_SCHEMA_VERSION,
    totalByteLength: blobs.reduce((total, blob) => total + blob.bytes.byteLength, 0),
    assets,
    greenhouseCropPresentations: []
  };
  const packId = createHash("sha256")
    .update(canonicalRuntimePngContentManifest(manifestData))
    .digest("hex");
  const manifest: RuntimePngContentManifest = runtimePngContentManifestSchema.parse({ ...manifestData, packId });
  await Promise.all(blobs.map(({ sha256: blobSha, bytes: blobBytes }) =>
    writeFile(resolve(contentRoot, "blobs", `${blobSha}.png`), blobBytes)
  ));
  await writeFile(resolve(contentRoot, "manifests", `${packId}.json`), JSON.stringify(manifest));
  await writeFile(resolve(contentRoot, "active.json"), JSON.stringify({ packId }));
  return { packId, sha256, ...(skinSha256 ? { skinSha256 } : {}) };
}
