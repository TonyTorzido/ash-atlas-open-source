import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, readdir, readFile, rename, stat, unlink, utimes, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { availableParallelism, homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";

import type { Logger, Plugin } from "vite";

// Lossless oxipng pass over every PNG in a build's output (hashed imports and
// public/ art alike). Filenames never change and the same input always yields
// the same bytes, so native live-update manifests stay stable between builds.
// Results are cached by input hash so only new or changed art costs CPU time.
//
// Off by default: turning it on changes every PNG checksum once, so installed
// apps re-download all PNGs with the next live update. Enable it with
// ASH_ATLAS_PNG_OPTIMIZE=true for every build at once (web, OTA, store seed),
// ideally together with any lossy pass, so that cost is paid only once.
const OXIPNG_LEVEL = 2;
const CACHE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// Runs as an eval'd CommonJS worker; it gets the codec location from workerData.
const WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
const { readFileSync } = require("node:fs");
const codec = import(workerData.codecUrl).then((module) => {
  module.initSync(readFileSync(workerData.wasmPath));
  return module;
});
parentPort.on("message", async ({ id, input }) => {
  try {
    const output = (await codec).optimise(new Uint8Array(input), workerData.level, false, false);
    parentPort.postMessage({ id, output }, [output.buffer]);
  } catch (error) {
    parentPort.postMessage({ id, error: String(error && error.message || error) });
  }
});
`;

type OptimizeSummary = Readonly<{
  files: number;
  beforeBytes: number;
  afterBytes: number;
  cached: number;
  seconds: number;
}>;

export function optimizePngAssets(env: NodeJS.ProcessEnv = process.env): Plugin {
  let outDir: string | null = null;
  let logger: Logger | null = null;
  return {
    name: "ash-atlas-optimize-png-assets",
    apply: "build",
    configResolved(config) {
      if (env.ASH_ATLAS_PNG_OPTIMIZE !== "true") return;
      outDir = config.build.write ? resolve(config.root, config.build.outDir) : null;
      logger = config.logger;
    },
    writeBundle: {
      sequential: true,
      async handler() {
        if (!outDir) return;
        const summary = await optimizePngDirectory(outDir, {
          cacheDirectory: env.ASH_ATLAS_PNG_CACHE_DIR || join(homedir(), ".cache", "ash-atlas", "png-optimize"),
          workers: Number(env.ASH_ATLAS_PNG_OPTIMIZE_WORKERS) || Math.max(1, Math.min(availableParallelism() - 1, 4))
        });
        logger?.info(
          `PNG optimize (lossless): ${summary.files} files, ${formatMegabytes(summary.beforeBytes)} -> ` +
          `${formatMegabytes(summary.afterBytes)} (${summary.cached} cached) in ${summary.seconds.toFixed(1)} s`
        );
      }
    }
  };
}

export async function optimizePngDirectory(
  directory: string,
  options: Readonly<{ cacheDirectory: string | null; workers: number }>
): Promise<OptimizeSummary> {
  const started = performance.now();
  const files = (await listFiles(directory)).filter((file) => file.toLowerCase().endsWith(".png"));
  const codec = resolveCodec();
  const cache = options.cacheDirectory
    ? await mkdir(options.cacheDirectory, { recursive: true }).then(() => options.cacheDirectory, () => null)
    : null;
  let beforeBytes = 0;
  let afterBytes = 0;
  let cached = 0;
  const pool: { current: WorkerPool | null } = { current: null };
  try {
    let next = 0;
    const runLane = async (): Promise<void> => {
      for (let index = next++; index < files.length; index = next++) {
        const file = files[index]!;
        const input = await readFile(file);
        const key = createHash("sha256").update(codec.cacheSalt).update(input).digest("hex");
        let output = cache ? await readCachedResult(cache, key, input) : null;
        if (output) {
          cached += 1;
        } else {
          pool.current ??= new WorkerPool(codec, options.workers);
          const optimized = await pool.current.optimize(input).catch(() => null);
          output = optimized && optimized.byteLength < input.byteLength && hasPngSignature(optimized)
            ? optimized
            : input;
          if (cache) await writeCachedResult(cache, key, output === input ? null : output);
        }
        if (output !== input) await writeFile(file, output);
        beforeBytes += input.byteLength;
        afterBytes += output.byteLength;
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, options.workers) * 2 }, runLane));
  } finally {
    await pool.current?.close();
  }
  if (cache) await pruneCache(cache);
  return {
    files: files.length,
    beforeBytes,
    afterBytes,
    cached,
    seconds: (performance.now() - started) / 1000
  };
}

type Codec = Readonly<{ codecUrl: string; wasmPath: string; cacheSalt: string }>;

function resolveCodec(): Codec {
  const require = createRequire(import.meta.url);
  const packageFile = require.resolve("@jsquash/oxipng/package.json");
  const packageDirectory = dirname(packageFile);
  const { version } = JSON.parse(readFileSync(packageFile, "utf8")) as { version: string };
  return {
    codecUrl: pathToFileURL(join(packageDirectory, "codec/pkg/squoosh_oxipng.js")).href,
    wasmPath: join(packageDirectory, "codec/pkg/squoosh_oxipng_bg.wasm"),
    // Any codec or option change must miss the cache.
    cacheSalt: `oxipng@${version};level=${OXIPNG_LEVEL};interlace=0;optimize-alpha=0\n`
  };
}

class WorkerPool {
  private readonly idle: Worker[] = [];
  private readonly waiting: Array<(worker: Worker) => void> = [];
  private readonly workers: Worker[] = [];
  private nextId = 0;

  constructor(codec: Codec, size: number) {
    for (let index = 0; index < Math.max(1, size); index += 1) {
      const worker = new Worker(WORKER_SOURCE, {
        eval: true,
        workerData: { codecUrl: codec.codecUrl, wasmPath: codec.wasmPath, level: OXIPNG_LEVEL }
      });
      this.workers.push(worker);
      this.idle.push(worker);
    }
  }

  async optimize(input: Buffer): Promise<Buffer> {
    const worker = this.idle.pop() ?? await new Promise<Worker>((resolveWorker) => this.waiting.push(resolveWorker));
    const id = this.nextId++;
    try {
      return await new Promise<Buffer>((resolveOutput, reject) => {
        const onMessage = (message: { id: number; output?: Uint8Array; error?: string }): void => {
          if (message.id !== id) return;
          cleanup();
          if (message.output) resolveOutput(Buffer.from(message.output.buffer, message.output.byteOffset, message.output.byteLength));
          else reject(new Error(message.error ?? "PNG optimization failed"));
        };
        const onError = (error: Error): void => {
          cleanup();
          reject(error);
        };
        const cleanup = (): void => {
          worker.off("message", onMessage);
          worker.off("error", onError);
        };
        worker.on("message", onMessage);
        worker.on("error", onError);
        const copy = new Uint8Array(input);
        worker.postMessage({ id, input: copy }, [copy.buffer]);
      });
    } finally {
      const waiter = this.waiting.shift();
      if (waiter) waiter(worker);
      else this.idle.push(worker);
    }
  }

  async close(): Promise<void> {
    await Promise.all(this.workers.map((worker) => worker.terminate()));
  }
}

// A cache entry is the optimized PNG, or an empty file meaning "keep the original".
async function readCachedResult(cache: string, key: string, input: Buffer): Promise<Buffer | null> {
  const file = join(cache, `${key}.png`);
  try {
    const bytes = await readFile(file);
    const now = new Date();
    await utimes(file, now, now).catch(() => undefined);
    if (bytes.byteLength === 0) return input;
    return hasPngSignature(bytes) && bytes.byteLength < input.byteLength ? bytes : null;
  } catch {
    return null;
  }
}

async function writeCachedResult(cache: string, key: string, output: Buffer | null): Promise<void> {
  const file = join(cache, `${key}.png`);
  const temporary = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    await writeFile(temporary, output ?? Buffer.alloc(0));
    await rename(temporary, file);
  } catch {
    await unlink(temporary).catch(() => undefined);
  }
}

async function pruneCache(cache: string): Promise<void> {
  const cutoff = Date.now() - CACHE_RETENTION_MS;
  for (const name of await readdir(cache).catch(() => [] as string[])) {
    const file = join(cache, name);
    const info = await stat(file).catch(() => null);
    if (info?.isFile() && info.mtimeMs < cutoff) await unlink(file).catch(() => undefined);
  }
}

async function listFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(path));
    else if (entry.isFile()) files.push(path);
  }
  return files.sort();
}

function hasPngSignature(bytes: Uint8Array): boolean {
  return bytes.byteLength > PNG_SIGNATURE.byteLength &&
    PNG_SIGNATURE.equals(Buffer.from(bytes.buffer, bytes.byteOffset, PNG_SIGNATURE.byteLength));
}

function formatMegabytes(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
