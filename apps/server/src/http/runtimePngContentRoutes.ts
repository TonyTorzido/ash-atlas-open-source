import type { FastifyInstance } from "fastify";
import {
  RUNTIME_PNG_CONTENT_SCHEMA_VERSION,
  runtimePngAssetRegistrationById,
  type RuntimePngContentManifest
} from "@ash-atlas/shared";
import {
  activeRuntimePngContentPack,
  loadRuntimePngContentPack,
  runtimePngContentDirectory
} from "../content/runtimePngContentPack.js";

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
type RuntimePngContentRoutesOptions = Readonly<{
  contentDirectory?: string;
  selectedPackId?: () => string | null;
}>;

type LoadedPack = Readonly<{
  manifest: RuntimePngContentManifest;
  blobs: ReadonlyMap<string, Buffer>;
}>;

export function registerRuntimePngContentRoutes(
  app: FastifyInstance,
  options: RuntimePngContentRoutesOptions = {}
): void {
  const contentDirectory = options.contentDirectory ?? process.env.RUNTIME_PNG_CONTENT_DIRECTORY ?? runtimePngContentDirectory();
  const selectedPackId = options.selectedPackId ?? (() =>
    process.env.RUNTIME_PNG_CONTENT_PACK?.trim() || null
  );

  app.get<{
    Params: { registrationId: string };
    Querystring: { schemaVersion?: string };
  }>("/api/runtime-png/v2/manifest/:registrationId", {
    config: { rateLimit: { max: 60, timeWindow: "1 minute", groupId: "runtime-png-manifest" } }
  }, async (request, reply) => {
    const registration = runtimePngAssetRegistrationById(request.params.registrationId);
    if (!registration) return reply.code(404).send({ error: "Unknown PNG registration" });
    if (request.query.schemaVersion !== String(RUNTIME_PNG_CONTENT_SCHEMA_VERSION)) {
      return reply.code(204).send();
    }

    try {
      const pack = await activeRuntimePngContentPack(contentDirectory, selectedPackId);
      if (!pack) return reply.code(204).send();
      const compatible = pack.manifest.assets.some((asset) =>
        asset.target.kind === "runtime-png" &&
        asset.target.registrationId === registration.id &&
        asset.target.relativeFile === registration.relativeFile
      );
      if (!compatible) return reply.code(204).send();

      return reply
        .header("Cache-Control", "no-store")
        .header("X-Content-Type-Options", "nosniff")
        .send(pack.manifest);
    } catch (error) {
      request.log.warn({ err: error }, "runtime PNG content pack unavailable");
      return reply.code(503).send({ error: "PNG content is temporarily unavailable" });
    }
  });

  app.get<{
    Params: { packId: string; sha256: string };
  }>("/api/runtime-png/v2/blobs/:packId/:sha256", {
    config: { rateLimit: { max: 60, timeWindow: "1 minute", groupId: "runtime-png-blob" } }
  }, async (request, reply) => {
    const { packId, sha256 } = request.params;
    if (!SHA256_PATTERN.test(packId) || !SHA256_PATTERN.test(sha256)) {
      return reply.code(404).send();
    }
    try {
      const pack = await loadRuntimePngContentPack(contentDirectory, packId);
      const blob = pack.blobs.get(sha256);
      if (!blob) return reply.code(404).send();
      return reply
        .type("image/png")
        // Signed-in content only: browsers may keep it, shared caches must not.
        .header("Cache-Control", "private, max-age=31536000, immutable")
        .header("X-Content-Type-Options", "nosniff")
        .send(blob);
    } catch (error) {
      request.log.warn({ err: error, packId }, "runtime PNG content blob unavailable");
      return reply.code(404).send();
    }
  });
}
