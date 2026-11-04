#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash, createSign } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const bundleRoot = process.env.ASH_ATLAS_NATIVE_BUNDLE_ROOT ?? "/srv/ash-atlas/native-bundles";
const publicRoot = process.env.ASH_ATLAS_NATIVE_PUBLIC_ROOT ?? "/srv/www/playashatlas/native-bundles";
const signingKey = process.env.ASH_ATLAS_NATIVE_SIGNING_KEY ?? "/etc/ash-atlas/ota-signing.pem";
const shaPattern = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u;
const clientShaPattern = /^[a-f0-9]{64}$/u;
const platforms = ["ios", "android"];
const manifestName = "capawesome-live-update-manifest.json";

function required(options, name, pattern) {
  const value = options[name];
  if (typeof value !== "string" || !pattern.test(value)) throw new Error(`${name} is missing or malformed`);
  return value;
}

function optionsFromArgs(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    if (!name?.startsWith("--") || !args[index + 1]) throw new Error("malformed arguments");
    options[name.slice(2)] = args[index + 1];
  }
  return options;
}

function run(command, args, logPath) {
  return new Promise((resolve, reject) => {
    const output = logPath ? fs.openSync(logPath, "w") : "inherit";
    const child = spawn(command, args, { stdio: ["ignore", output, output] });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`${command} failed with exit ${code}${logPath ? `; see ${logPath}` : ""}`)));
    if (logPath) child.on("close", () => fs.closeSync(output));
  });
}

async function checksumAndSignature(file, key) {
  const checksum = createHash("sha256");
  // Capawesome 8.4.3 verifies each manifest-mode response independently.
  const signer = createSign("RSA-SHA256");
  for await (const chunk of fs.createReadStream(file)) {
    checksum.update(chunk);
    signer.update(chunk);
  }
  return {
    checksum: checksum.digest("hex"),
    signature: signer.sign(key).toString("base64")
  };
}

function artifactFiles(root) {
  const files = [];
  function visit(directory) {
    for (const name of fs.readdirSync(directory).sort()) {
      const file = path.join(directory, name);
      const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) throw new Error(`native bundle contains a symlink: ${file}`);
      if (stat.isDirectory()) visit(file);
      else if (stat.isFile()) files.push(path.relative(root, file).split(path.sep).join("/"));
      else throw new Error(`native bundle contains a non-file entry: ${file}`);
    }
  }
  visit(root);
  return files;
}

export async function packageManifest(output, artifactDirectory, key) {
  const files = artifactFiles(output);
  if (!files.includes("index.html") || !files.includes(manifestName)) {
    throw new Error("native build lacks index.html or live-update manifest");
  }
  if (files.includes("headers.json")) throw new Error("native build conflicts with reserved headers.json");
  const manifest = readJson(path.join(output, manifestName));
  if (!Array.isArray(manifest) || manifest.length !== files.length - 1) {
    throw new Error("native build manifest file list differs");
  }
  const expected = new Map(manifest.map((entry) => [entry.href, entry]));
  if (expected.size !== manifest.length) throw new Error("native build manifest has duplicate hrefs");
  const headers = Object.create(null);
  for (const href of files) {
    const file = path.join(output, ...href.split("/"));
    const signed = await checksumAndSignature(file, key);
    if (href !== manifestName) {
      const entry = expected.get(href);
      if (entry?.checksum !== signed.checksum || entry?.sizeInBytes !== fs.statSync(file).size) {
        throw new Error(`native build manifest differs from ${href}`);
      }
    }
    headers[href] = signed;
  }
  const staged = `${artifactDirectory}.new.${process.pid}`;
  try {
    fs.mkdirSync(staged, { recursive: false });
    for (const href of files) {
      const target = path.join(staged, ...href.split("/"));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(path.join(output, ...href.split("/")), target, fs.constants.COPYFILE_EXCL);
    }
    fs.writeFileSync(path.join(staged, "headers.json"), `${JSON.stringify(headers)}\n`, { flag: "wx" });
    if (fs.existsSync(artifactDirectory)) {
      const existing = artifactFiles(artifactDirectory);
      if (existing.length !== files.length + 1 || !existing.includes("headers.json")) {
        throw new Error(`immutable native artifact file list differs: ${artifactDirectory}`);
      }
      for (const href of files) {
        if (!assertSafeArtifact(path.join(artifactDirectory, ...href.split("/")), headers[href].checksum)) {
          throw new Error(`immutable native artifact is missing: ${href}`);
        }
      }
      if (fs.readFileSync(path.join(artifactDirectory, "headers.json"), "utf8") !== `${JSON.stringify(headers)}\n`) {
        throw new Error(`immutable native artifact signatures differ: ${artifactDirectory}`);
      }
    } else {
      for (const href of files) fs.chmodSync(path.join(staged, ...href.split("/")), 0o444);
      fs.chmodSync(path.join(staged, "headers.json"), 0o444);
      for (const href of files) {
        let directory = path.dirname(path.join(staged, ...href.split("/")));
        while (directory !== staged) {
          fs.chmodSync(directory, 0o555);
          directory = path.dirname(directory);
        }
      }
      fs.chmodSync(staged, 0o555);
      fs.renameSync(staged, artifactDirectory);
    }
  } finally {
    if (fs.existsSync(staged)) fs.rmSync(staged, { recursive: true });
  }
  return { ...headers[manifestName], sizeBytes: fs.statSync(path.join(artifactDirectory, manifestName)).size };
}

function writeAtomic(file, value, mode = 0o640, gid) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.new.${process.pid}`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode, flag: "wx" });
    // The updater runs under umask 0077; set the mode explicitly so the game server can read it.
    fs.chmodSync(temporary, mode);
    if (gid !== undefined) fs.chownSync(temporary, 0, gid);
    fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function assertSafeArtifact(file, expectedChecksum) {
  if (!fs.existsSync(file)) return false;
  if (!fs.statSync(file).isFile() || fs.lstatSync(file).isSymbolicLink()) throw new Error(`unsafe artifact: ${file}`);
  const actual = createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  if (actual !== expectedChecksum) throw new Error(`immutable artifact differs: ${file}`);
  return true;
}

async function build(options) {
  const source = path.resolve(required(options, "source", /^.+$/u));
  const buildRoot = path.resolve(required(options, "build-root", /^.+$/u));
  const gameSha = required(options, "game-sha", shaPattern);
  const clientSha = required(options, "client-sha", clientShaPattern);
  const serverSha = required(options, "server-sha", shaPattern);
  const generation = required(options, "generation", /^test\/t[0-9]{3,}$/u);
  const selected = required(options, "platforms", /^(?:ios|android)(?:,(?:ios|android))?$/u).split(",");
  if (new Set(selected).size !== selected.length) throw new Error("duplicate platform");
  const protocol = readJson(path.join(source, "config/protocol-versions.json"));
  if (!Number.isSafeInteger(protocol.min_protocol) || !Number.isSafeInteger(protocol.max_protocol)) {
    throw new Error("protocol range is malformed");
  }
  const started = process.hrtime.bigint();
  fs.mkdirSync(buildRoot, { recursive: true });
  fs.mkdirSync(bundleRoot, { recursive: true, mode: 0o750 });
  await run("chown", ["root:ash-atlas", bundleRoot]);
  fs.chmodSync(bundleRoot, 0o750);
  const viteArguments = (platform) => [
    "-u", "debian", "env", "HOME=/home/debian",
    `VITE_GOOGLE_CLIENT_ID=${required(options, "google-client-id", /^.+$/u)}`,
    "VITE_CLOSED_TEST_TELEMETRY_ENABLED=true",
    `VITE_POPULATION_FRAME_BATCHING_ENABLED=${required(options, "population-frame-batching", /^(?:true|false)$/u)}`,
    `VITE_CLIENT_BUILD_SHA=${clientSha}`,
    "pnpm", "--dir", path.join(source, "apps/client"), "exec", "vite", "build",
    "--mode", platform === "ios" ? "capacitor" : "capacitor-android",
    "--outDir", path.join(buildRoot, platform)
  ];
  await Promise.all(selected.map((platform) => run("sudo", viteArguments(platform),
    path.join(buildRoot, `${platform}.log`))));
  const descriptors = {};
  for (const platform of selected) {
    const output = path.join(buildRoot, platform);
    await run("sudo", ["-u", "debian", "env", "HOME=/home/debian", process.execPath,
      path.join(source, "apps/client/src/native/writeNativeLiveUpdateManifest.mjs"), output]);
    const artifactDirectory = path.join(publicRoot, platform, clientSha);
    fs.mkdirSync(path.dirname(artifactDirectory), { recursive: true, mode: 0o555 });
    fs.chmodSync(publicRoot, 0o555);
    const { checksum, signature, sizeBytes } = await packageManifest(output, artifactDirectory, fs.readFileSync(signingKey));
    descriptors[platform] = {
        bundleId: `${platform}-${clientSha}`,
        platform,
        url: `https://playashatlas.com/play/native-bundles/${platform}/${clientSha}/bundle`,
        checksum,
        signature,
        sizeBytes,
        artifactType: "manifest",
        clientSha,
        serverSha,
        generation,
        minShellBuild: 8,
        protocolMin: protocol.min_protocol,
        protocolMax: protocol.max_protocol
      };
    fs.chmodSync(path.join(publicRoot, platform), 0o555);
  }
  const buildSeconds = Number(process.hrtime.bigint() - started) / 1e9;
  const candidateDirectory = path.join(bundleRoot, "candidates");
  fs.mkdirSync(candidateDirectory, { recursive: true, mode: 0o750 });
  // ACTIVATE may use the previous server checkout for a client-only release.
  fs.copyFileSync(process.argv[1], path.join(candidateDirectory, `${gameSha}.mjs`));
  fs.chmodSync(path.join(candidateDirectory, `${gameSha}.mjs`), 0o440);
  writeAtomic(path.join(candidateDirectory, `${gameSha}.json`), { descriptors, buildSeconds });
  process.stdout.write(`Native bundles: ${selected.join(",")}; build and package ${buildSeconds.toFixed(1)} s\n`);
}

async function activate(options) {
  const gameSha = required(options, "game-sha", shaPattern);
  const candidateFile = path.join(bundleRoot, "candidates", `${gameSha}.json`);
  if (!fs.existsSync(candidateFile)) return;
  const { descriptors } = readJson(candidateFile);
  const pointerFile = path.join(bundleRoot, "pointer.json");
  const pointer = fs.existsSync(pointerFile) ? readJson(pointerFile) : {};
  for (const platform of platforms) {
    const descriptor = descriptors[platform];
    if (!descriptor) continue;
    if (descriptor.platform !== platform || descriptor.generation !== options.generation) {
      throw new Error(`${platform} candidate identity differs`);
    }
    const existing = pointer[platform];
    if (existing?.current?.bundleId === descriptor.bundleId) continue;
    pointer[platform] = { current: descriptor, previous: existing?.current ?? null };
  }
  if (!platforms.every((platform) => pointer[platform]?.current)) {
    throw new Error("both platform pointers are required");
  }
  prune(pointer);
  writeAtomic(pointerFile, pointer, 0o640, fs.statSync(bundleRoot).gid);
  process.stdout.write(`Native bundle pointer activated for ${gameSha}\n`);
}

function prune(pointer = readJson(path.join(bundleRoot, "pointer.json"))) {
  const retained = new Set(platforms.flatMap((platform) =>
    [pointer[platform]?.current, pointer[platform]?.previous].filter(Boolean).map((entry) => `${platform}/${entry.clientSha}`)));
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  for (const platform of platforms) {
    const platformRoot = path.join(publicRoot, platform);
    if (!fs.existsSync(platformRoot)) continue;
    for (const name of fs.readdirSync(platformRoot)) {
      if (!clientShaPattern.test(name) || retained.has(`${platform}/${name}`)) continue;
      const directory = path.join(platformRoot, name);
      if (fs.lstatSync(directory).isSymbolicLink()) throw new Error(`unsafe native bundle directory: ${directory}`);
      if (fs.statSync(directory).mtimeMs < cutoff) fs.rmSync(directory, { recursive: true });
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, ...args] = process.argv.slice(2);
  try {
    const options = optionsFromArgs(args);
    if (command === "build") await build(options);
    else if (command === "activate") await activate(options);
    else if (command === "prune") prune();
    else throw new Error("usage: build-native-bundles.mjs <build|activate|prune> [--key value ...]");
  } catch (error) {
    process.stderr.write(`Native bundle ${command} failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
