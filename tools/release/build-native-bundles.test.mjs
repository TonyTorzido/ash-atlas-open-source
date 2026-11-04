import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, verify } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { packageManifest } from "./build-native-bundles.mjs";

test("manifest package signs every file and rejects changes to an immutable release", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ash-native-manifest-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const output = path.join(root, "output");
  const artifact = path.join(root, "published");
  fs.mkdirSync(path.join(output, "assets"), { recursive: true });
  fs.writeFileSync(path.join(output, "index.html"), "<html>ready</html>\n");
  fs.writeFileSync(path.join(output, "assets", "skin.png"), Buffer.from([137, 80, 78, 71]));
  const entries = ["assets/skin.png", "index.html"].map((href) => {
    const bytes = fs.readFileSync(path.join(output, ...href.split("/")));
    return { href, checksum: createHash("sha256").update(bytes).digest("hex"), sizeInBytes: bytes.length };
  });
  fs.writeFileSync(path.join(output, "capawesome-live-update-manifest.json"), `${JSON.stringify(entries)}\n`);
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const first = await packageManifest(output, artifact, privateKey);
  const headers = JSON.parse(fs.readFileSync(path.join(artifact, "headers.json"), "utf8"));
  assert.deepEqual(Object.keys(headers).sort(), [
    "assets/skin.png", "capawesome-live-update-manifest.json", "index.html"
  ]);
  for (const [href, metadata] of Object.entries(headers)) {
    const bytes = fs.readFileSync(path.join(artifact, ...href.split("/")));
    assert.equal(metadata.checksum, createHash("sha256").update(bytes).digest("hex"));
    assert.equal(verify("RSA-SHA256", bytes, publicKey, Buffer.from(metadata.signature, "base64")), true);
  }
  assert.equal(first.checksum, headers["capawesome-live-update-manifest.json"].checksum);
  assert.equal(first.signature, headers["capawesome-live-update-manifest.json"].signature);
  assert.equal(first.sizeBytes, fs.statSync(path.join(artifact, "capawesome-live-update-manifest.json")).size);
  assert.deepEqual(await packageManifest(output, artifact, privateKey), first);
  fs.chmodSync(path.join(artifact, "assets", "skin.png"), 0o644);
  fs.writeFileSync(path.join(artifact, "assets", "skin.png"), "tampered");
  await assert.rejects(packageManifest(output, artifact, privateKey), /immutable artifact differs/);
});

test("manifest package refuses an incomplete manifest", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ash-native-incomplete-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const output = path.join(root, "output");
  fs.mkdirSync(output);
  fs.writeFileSync(path.join(output, "index.html"), "ready");
  fs.writeFileSync(path.join(output, "capawesome-live-update-manifest.json"), "[]\n");
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  await assert.rejects(packageManifest(output, path.join(root, "published"), privateKey), /file list differs/);
});
