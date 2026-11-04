import react from "@vitejs/plugin-react";
import { execFileSync } from "node:child_process";
import { createReadStream, statSync } from "node:fs";
import { readdir, rm, rmdir, stat } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import { defineConfig, loadEnv, type Connect, type Logger, type Plugin, type UserConfig } from "vite";

import {
  WATER_VISUAL_TILES_ARTIFACT_FILE,
  WATER_VISUAL_TILES_ARTIFACT_SIZE,
  WATER_VISUAL_TILES_HTTP_PATH
} from "./src/map/waterVisualTiles.js";
import { overlaySpriteDerivatives } from "./overlaySpriteDerivativesPlugin.js";
import { optimizePngAssets } from "./src/bundling/optimizePngAssets.js";
import { nativeBundleFileClass } from "./src/native/nativeSeedBundle.js";

export function configureLauncherProcessEnvironment(env: NodeJS.ProcessEnv = process.env): void {
  if (env.VITE_RUNTIME_LABEL) env.CI = "true";
}

// Launcher-owned Vite processes have redirected output and no stable interactive
// stdin. Disable Vite's readline shortcuts before the CLI finishes startup.
configureLauncherProcessEnvironment();

export function createViteConfig(env: NodeJS.ProcessEnv = process.env): UserConfig {
  const frontendPort = parsePort(env.ASH_ATLAS_FRONTEND_PORT, 5270);
  const gameServerTarget = env.ASH_ATLAS_GAME_SERVER_TARGET ?? "http://127.0.0.1:3001";
  const worldApiTarget = env.ASH_ATLAS_WORLD_API_TARGET ?? "http://127.0.0.1:8765";
  const buildSha = /^[a-f0-9]{64}$/.test(env.VITE_CLIENT_BUILD_SHA ?? "")
    ? env.VITE_CLIENT_BUILD_SHA!
    : resolveClientBuildSha(env);

  return {
    plugins: [
      react(),
      overlaySpriteDerivatives(),
      nativeContentSecurityPolicy(env),
      nativeBuildIdentity(env),
      stripServerOnlyInteriorData(),
      clientUpdateSize(env, buildSha),
      accountPagesDevRoute(),
      waterVisualTilesDevRoute(env),
      // Seed pruning runs first so only the files that ship get optimized.
      nativeSeedBundle(env),
      optimizePngAssets(env)
    ],
    define: {
      "import.meta.env.VITE_GAME_BUILD_SHA": JSON.stringify(buildSha)
    },
    server: {
      host: "0.0.0.0",
      port: frontendPort,
      proxy: {
        "/api/lookup": { target: worldApiTarget },
        "/api/overlays.geojson": { target: worldApiTarget },
        "/api": { target: gameServerTarget },
        "/ws": { target: gameServerTarget, ws: true }
      }
    },
    ...fastPhonePreviewConfig(env)
  };
}

// Opt-in "fast phone test" (tools/dev/feature-fast.ps1): `vite preview` over a production build
// behind Tailscale. Inert unless the script sets ASH_ATLAS_PREVIEW_ALLOWED_HOSTS. Preview reuses
// server.proxy for /api and /ws; only the host allow-list needs configuring.
export function fastPhonePreviewConfig(env: NodeJS.ProcessEnv): Pick<UserConfig, "preview"> {
  const hosts = (env.ASH_ATLAS_PREVIEW_ALLOWED_HOSTS ?? "").split(",").map((host) => host.trim()).filter(Boolean);
  return hosts.length > 0 ? { preview: { allowedHosts: hosts } } : {};
}

// The server rolls dungeon rewards and owns boss templates, so the client bundle ships the interior
// library without them. Vitest keeps the full library so shared catalog tests see the real data.
export function stripServerOnlyInteriorData(): Plugin {
  return {
    name: "ash-atlas-strip-server-only-interior-data",
    enforce: "pre",
    apply: (_config, { mode }) => mode !== "test",
    transform(code, id) {
      if (!id.split("?")[0]!.replaceAll("\\", "/").endsWith("/data/interiors/_library.json")) return null;
      const library = JSON.parse(code) as Record<string, unknown>;
      return { code: JSON.stringify({ ...library, rewardTables: [], bossTemplates: [] }), map: null };
    }
  };
}

export function nativeBuildIdentity(env: NodeJS.ProcessEnv): Plugin {
  return {
    name: "ash-atlas-native-build-identity",
    generateBundle() {
      if (env.VITE_CAPACITOR !== "true") return;
      const platform = env.VITE_CAPACITOR_PLATFORM === "android" ? "android" : "ios";
      const version = env.VITE_NATIVE_APP_VERSION;
      const build = Number(env.VITE_NATIVE_APP_BUILD);
      if (!version || !/^\d+\.\d+\.\d+$/.test(version) || !Number.isSafeInteger(build) || build <= 0) {
        throw new Error("Native builds require an explicit version and positive numeric build identity");
      }
      this.emitFile({ type: "asset", fileName: "native-build.json", source: JSON.stringify({
        schemaVersion: 1, platform, version, build, pushMode: env.VITE_NATIVE_PUSH_ENABLED === "true" ? "enabled" : "disabled"
      }) });
    }
  };
}

// The store binary's seed bundle keeps only the files src/native/nativeSeedBundle.ts
// classes as seed. OTA bundles and web builds never set VITE_NATIVE_SEED_BUNDLE.
export function nativeSeedBundle(env: NodeJS.ProcessEnv): Plugin {
  let outDir: string | null = null;
  let logger: Logger | null = null;
  return {
    name: "ash-atlas-native-seed-bundle",
    apply: "build",
    configResolved(config) {
      if (env.VITE_NATIVE_SEED_BUNDLE !== "true") return;
      if (env.VITE_CAPACITOR !== "true") throw new Error("A seed bundle is only for native builds");
      outDir = config.build.write ? resolve(config.root, config.build.outDir) : null;
      logger = config.logger;
    },
    writeBundle: {
      sequential: true,
      async handler() {
        if (!outDir) return;
        const totals = { seed: 0, full: 0, removed: 0 };
        const prune = async (directory: string): Promise<void> => {
          for (const entry of await readdir(directory, { withFileTypes: true })) {
            const path = join(directory, entry.name);
            if (entry.isDirectory()) {
              await prune(path);
              if ((await readdir(path)).length === 0) await rmdir(path);
              continue;
            }
            const href = relative(outDir!, path).split("\\").join("/");
            const bytes = (await stat(path)).size;
            if (nativeBundleFileClass(href) === "seed") {
              totals.seed += bytes;
              continue;
            }
            totals.full += bytes;
            totals.removed += 1;
            await rm(path);
          }
        };
        await prune(outDir);
        logger?.info(
          `Native seed bundle: kept ${(totals.seed / 1048576).toFixed(1)} MB; left ${totals.removed} files ` +
          `(${(totals.full / 1048576).toFixed(1)} MB) for the first-run download`
        );
      }
    }
  };
}

// Published web builds describe their own code size so an older client can
// tell the player how large the update is before it reloads.
export function clientUpdateSize(env: NodeJS.ProcessEnv, buildSha: string | null): Plugin {
  return {
    name: "ash-atlas-client-update-size",
    generateBundle(_options, bundle) {
      if (env.VITE_CAPACITOR === "true" || !buildSha || !/^[a-f0-9]{64}$/.test(buildSha)) return;
      // Code is what a reload fetches again; hashed images are usually cached.
      let downloadBytes = 0;
      for (const output of Object.values(bundle)) {
        if (!/\.(?:js|css|html)$/.test(output.fileName)) continue;
        downloadBytes += output.type === "chunk"
          ? Buffer.byteLength(output.code)
          : typeof output.source === "string" ? Buffer.byteLength(output.source) : output.source.byteLength;
      }
      this.emitFile({
        type: "asset",
        fileName: "client-update.json",
        source: `${JSON.stringify({ client_sha: buildSha, download_bytes: downloadBytes })}
`
      });
    }
  };
}

export function nativeContentSecurityPolicy(env: NodeJS.ProcessEnv): Plugin {
  return {
    name: "ash-atlas-native-content-security-policy",
    ...(env.VITE_CAPACITOR === "true"
      ? { transformIndexHtml: {
          order: "pre",
          handler: () => [{
            tag: "meta",
            attrs: {
              "http-equiv": "Content-Security-Policy",
              content: [
                "default-src 'self'",
                "script-src 'self'",
                "script-src-attr 'none'",
                "frame-src 'none'",
                "frame-ancestors 'none'",
                "connect-src 'self' data: https://playashatlas.com wss://playashatlas.com https://tile.openstreetmap.org https://cloudflareinsights.com",
                "img-src 'self' data: blob: https://tile.openstreetmap.org",
                "style-src 'self' 'unsafe-inline'",
                "worker-src 'self' blob:",
                "object-src 'none'",
                "base-uri 'self'",
                "form-action 'none'"
              ].join("; ")
            },
            injectTo: "head-prepend"
          }]
        } }
      : {})
  };
}

export function resolveClientBuildSha(env: NodeJS.ProcessEnv = process.env): string | null {
  for (const candidate of [env.VITE_RUNTIME_SHA, env.RUNTIME_SHA]) {
    if (/^[a-f0-9]{40}$/.test(candidate ?? "")) return candidate!;
  }
  try {
    const candidate = execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
    return /^[a-f0-9]{40}$/.test(candidate) ? candidate : null;
  } catch {
    return null;
  }
}

export function resolveDevProxyService(pathname: string): "game" | "world" | "game-ws" | null {
  if (pathname === "/api/lookup" || pathname.startsWith("/api/lookup?")) return "world";
  if (pathname === "/api/overlays.geojson" || pathname.startsWith("/api/overlays.geojson?")) return "world";
  if (pathname === "/api" || pathname.startsWith("/api/")) return "game";
  if (pathname === "/ws" || pathname.startsWith("/ws?")) return "game-ws";
  return null;
}

export function waterVisualTilesDevRoute(env: NodeJS.ProcessEnv = process.env): Plugin {
  return visualTilesDevRoute({
    name: "ash-atlas-water-visual-tiles",
    artifactPath: env.ASH_ATLAS_WATER_VISUAL_TILES_PATH,
    artifactFile: WATER_VISUAL_TILES_ARTIFACT_FILE,
    artifactSize: WATER_VISUAL_TILES_ARTIFACT_SIZE,
    httpPath: WATER_VISUAL_TILES_HTTP_PATH,
    label: "Water"
  });
}

export function accountPagesDevRoute(): Plugin {
  const pageFiles = new Map([
    ["/delete-account", "delete-account.html"],
    ["/privacy", "privacy.html"],
    ["/terms", "terms.html"]
  ]);

  return {
    name: "ash-atlas-account-pages",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
        const pageFile = pageFiles.get(pathname);
        const assetPrefix = "/play/landing/";
        const assetFile = pathname.startsWith(assetPrefix)
          ? pathname.slice(assetPrefix.length)
          : null;
        const fileName = pageFile ?? (assetFile && /^[A-Za-z0-9._-]+$/u.test(assetFile) ? assetFile : null);
        if (!fileName) return next();
        if (request.method !== "GET" && request.method !== "HEAD") {
          response.statusCode = 405;
          response.setHeader("Allow", "GET, HEAD");
          return response.end();
        }

        const filePath = join(process.cwd(), "public", "landing", fileName);
        try {
          const size = statSync(filePath).size;
          response.statusCode = 200;
          response.setHeader("Cache-Control", "no-store");
          response.setHeader("Content-Length", String(size));
          response.setHeader(
            "Content-Type",
            fileName.endsWith(".css") ? "text/css; charset=utf-8" :
              fileName.endsWith(".js") ? "text/javascript; charset=utf-8" :
                "text/html; charset=utf-8"
          );
          if (request.method === "HEAD") return response.end();
          const stream = createReadStream(filePath);
          stream.on("error", (error) => response.destroy(error));
          return stream.pipe(response);
        } catch {
          response.statusCode = 404;
          return response.end();
        }
      });
    }
  };
}

function visualTilesDevRoute(options: {
  name: string;
  artifactPath: string | undefined;
  artifactFile: string;
  artifactSize: number;
  httpPath: string;
  label: string;
}): Plugin {
  const install = (server: { middlewares: Connect.Server }): void => {
      server.middlewares.use((request, response, next) => {
        const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
        if (pathname !== options.httpPath) return next();
        if (request.method !== "GET" && request.method !== "HEAD") {
          response.statusCode = 405;
          response.setHeader("Allow", "GET, HEAD");
          return response.end();
        }
        if (!options.artifactPath || basename(options.artifactPath) !== options.artifactFile) {
          response.statusCode = 404;
          return response.end();
        }
        let size: number;
        try {
          size = statSync(options.artifactPath).size;
        } catch {
          response.statusCode = 404;
          return response.end();
        }
        if (size !== options.artifactSize) {
          response.statusCode = 500;
          return response.end(`${options.label} visual tile artifact identity mismatch`);
        }
        const range = parseByteRange(request.headers.range, size);
        if (request.headers.range && !range) {
          response.statusCode = 416;
          response.setHeader("Content-Range", `bytes */${size}`);
          return response.end();
        }
        const start = range?.start ?? 0;
        const end = range?.end ?? size - 1;
        response.statusCode = range ? 206 : 200;
        response.setHeader("Accept-Ranges", "bytes");
        response.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        response.setHeader("Content-Type", "application/octet-stream");
        response.setHeader("Content-Length", String(end - start + 1));
        if (range) response.setHeader("Content-Range", `bytes ${start}-${end}/${size}`);
        if (request.method === "HEAD") return response.end();
        const stream = createReadStream(options.artifactPath, { start, end });
        stream.on("error", (error) => response.destroy(error));
        stream.pipe(response);
      });
  };
  return {
    name: options.name,
    configureServer: install,
    // `vite preview` (fast phone test) serves the same artifact route.
    configurePreviewServer: install
  };
}

export function parseByteRange(
  value: string | undefined,
  size: number
): { start: number; end: number } | null {
  const match = /^bytes=(\d+)-(\d*)$/u.exec(value ?? "");
  if (!match) return null;
  const start = Number(match[1]);
  const requestedEnd = match[2] ? Number(match[2]) : size - 1;
  const end = Math.min(requestedEnd, size - 1);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end) {
    return null;
  }
  return { start, end };
}

function parsePort(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65_535 ? parsed : fallback;
}

export default defineConfig(({ mode }) => createViteConfig({
  ...loadEnv(mode, process.cwd(), ""),
  ...process.env
}));
