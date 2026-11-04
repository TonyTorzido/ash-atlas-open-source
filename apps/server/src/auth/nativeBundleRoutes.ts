import { readFile, realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  validateNativeBundleDescriptor,
  type NativeBundleDescriptor,
  type NativePlatform
} from "@ash-atlas/shared";

const NATIVE_BUNDLE_POINTER_PATH = "/srv/ash-atlas/native-bundles/pointer.json";
const NATIVE_BUNDLE_PUBLIC_ROOT = "/srv/www/playashatlas/native-bundles";
const requestSchema = z.object({
  platform: z.enum(["ios", "android"]),
  shellBuild: z.coerce.number().int().positive().safe(),
  bundle: z.string().regex(/^(?:[A-Za-z0-9][A-Za-z0-9._-]{0,127})?$/u)
}).strict();
const pointerSchema = z.object({ ios: z.unknown(), android: z.unknown() }).strict();
const pointerEntrySchema = z.object({
  current: z.unknown(),
  previous: z.unknown().nullable()
}).strict();
const manifestAssetParamsSchema = z.object({
  platform: z.enum(["ios", "android"]),
  clientSha: z.string().regex(/^[a-f0-9]{64}$/u)
}).strict();
const manifestAssetQuerySchema = z.object({ href: z.string() }).strict();
const signedAssetHeaderSchema = z.object({
  checksum: z.string().regex(/^[a-f0-9]{64}$/u),
  signature: z.string().regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u).min(1)
}).strict();

type NativeBundlePointerEntry = Readonly<{
  current: NativeBundleDescriptor;
  previous: NativeBundleDescriptor | null;
}>;

export type NativeBundleRoutesOptions = Readonly<{
  pointerPath?: string;
  publicRoot?: string;
}>;

export function registerNativeBundleRoutes(
  app: FastifyInstance,
  options: NativeBundleRoutesOptions = {}
): void {
  const pointerPath = options.pointerPath ?? NATIVE_BUNDLE_POINTER_PATH;
  const publicRoot = options.publicRoot ?? NATIVE_BUNDLE_PUBLIC_ROOT;

  app.get("/api/native/bundle", {
    config: { rateLimit: { max: 120, timeWindow: "1 minute" } }
  }, async (request, reply) => {
    if (process.env.NATIVE_OTA_ENABLED !== "true") return reply.code(204).send();

    const parsedQuery = requestSchema.safeParse(request.query);
    if (!parsedQuery.success) {
      return reply.code(400).send({
        error: { code: "NATIVE_BUNDLE_REQUEST_INVALID", message: "Invalid native bundle request" }
      });
    }

    try {
      const pointer = await readNativeBundlePointer(pointerPath);
      const descriptor = pointer[parsedQuery.data.platform].current;
      if (
        parsedQuery.data.shellBuild < descriptor.minShellBuild ||
        parsedQuery.data.bundle === descriptor.bundleId
      ) {
        return reply.code(204).send();
      }
      return reply.header("Cache-Control", "no-store").send(descriptor);
    } catch (error) {
      request.log.warn({ err: error }, "native bundle pointer unavailable");
      return reply.code(503).send({
        error: { code: "NATIVE_BUNDLE_UNAVAILABLE", message: "Native bundle is temporarily unavailable" }
      });
    }
  });

  app.get("/play/native-bundles/:platform/:clientSha/bundle", async (request, reply) => {
    const params = manifestAssetParamsSchema.safeParse(request.params);
    const query = manifestAssetQuerySchema.safeParse(request.query);
    if (!params.success || !query.success || !safeManifestHref(query.data.href)) {
      return reply.code(404).send();
    }

    const directory = resolve(publicRoot, params.data.platform, params.data.clientSha);
    try {
      const headers: unknown = JSON.parse(await readFile(resolve(directory, "headers.json"), "utf8"));
      if (!headers || typeof headers !== "object" || Array.isArray(headers)) {
        throw new Error("native manifest headers are malformed");
      }
      const metadata = signedAssetHeaderSchema.safeParse(
        (headers as Record<string, unknown>)[query.data.href]
      );
      if (!metadata.success) return reply.code(404).send();

      const directoryPath = await realpath(directory);
      const filePath = await realpath(resolve(directory, ...query.data.href.split("/")));
      if (!filePath.startsWith(`${directoryPath}${sep}`)) return reply.code(404).send();
      const bytes = await readFile(filePath);
      return reply
        .header("Cache-Control", "public, max-age=31536000, immutable, no-transform")
        .header("X-Checksum", metadata.data.checksum)
        .header("X-Signature", metadata.data.signature)
        .header("X-Content-Type-Options", "nosniff")
        .type(nativeAssetContentType(query.data.href))
        .send(bytes);
    } catch (error) {
      request.log.warn({ err: error }, "native manifest asset unavailable");
      return reply.code(404).send();
    }
  });
}

function safeManifestHref(href: string): boolean {
  return href.length > 0 && !href.includes("\\") && !href.includes("\0") &&
    !href.startsWith("/") && href.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

function nativeAssetContentType(href: string): string {
  if (href.endsWith(".json")) return "application/json; charset=utf-8";
  if (href.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (href.endsWith(".css")) return "text/css; charset=utf-8";
  if (href.endsWith(".html")) return "text/html; charset=utf-8";
  if (href.endsWith(".svg")) return "image/svg+xml";
  if (href.endsWith(".png")) return "image/png";
  if (href.endsWith(".webp")) return "image/webp";
  if (href.endsWith(".woff2")) return "font/woff2";
  if (href.endsWith(".wasm")) return "application/wasm";
  return "application/octet-stream";
}

async function readNativeBundlePointer(pointerPath: string): Promise<
  Readonly<Record<NativePlatform, NativeBundlePointerEntry>>
> {
  const rawPointer: unknown = JSON.parse(await readFile(pointerPath, "utf8"));
  const pointer = pointerSchema.parse(rawPointer);
  return {
    ios: parsePointerEntry(pointer.ios, "ios"),
    android: parsePointerEntry(pointer.android, "android")
  };
}

function parsePointerEntry(value: unknown, platform: NativePlatform): NativeBundlePointerEntry {
  const entry = pointerEntrySchema.parse(value);
  const current = validateNativeBundleDescriptor(entry.current);
  const previous = entry.previous === null
    ? null
    : validateNativeBundleDescriptor(entry.previous);
  if (
    current.platform !== platform ||
    (previous !== null && previous.platform !== platform)
  ) {
    throw new Error("Native bundle pointer platform does not match its entry");
  }
  return { current, previous };
}
