import { ATTEST_PURPOSES } from "@ash-atlas/shared";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";

import { requireRequestSession, sendAuthError } from "../auth/authGuard.js";
import type { AttestationService, AttestOutcomeResult } from "../auth/trust/attestation/attestationService.js";
import { sendError } from "./errors.js";

// Device attestation endpoints (NATIVE_ANTISPOOF_BUILD_PLAN.md §8.3). The shared
// auth guard checks the session cookie, origin and CSRF before these handlers.

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/u;
const TOKEN = /^[A-Za-z0-9_.=+/-]+$/u;
const base64 = (max: number) => z.string().min(4).max(max).regex(BASE64);

const fixSchema = z.object({
  lat: z.number().finite().min(-90).max(90),
  lon: z.number().finite().min(-180).max(180),
  accuracy: z.number().finite().nonnegative().optional(),
  fixTimestampMs: z.number().int().nonnegative()
}).strict();
const sessionPurpose = z.enum(["session", "relocation"]);
const shellBuild = z.number().int().nonnegative().max(1_000_000);

const challengeSchema = z.object({
  platform: z.enum(["ios", "android"]),
  purpose: z.enum(ATTEST_PURPOSES)
}).strict();
const androidSchema = z.object({
  challengeId: z.string().uuid(),
  purpose: sessionPurpose,
  shellBuild,
  // Integrity tokens are compact JWE (base64url segments joined by dots).
  token: z.string().min(1).max(16_384).regex(TOKEN).optional(),
  clientError: z.string().max(64).regex(/^[A-Za-z0-9_:.-]*$/u).optional(),
  fix: fixSchema.optional(),
  // Device environment block (plan §8.9); bounds are checked by parseDeviceEnvironment.
  environment: z.unknown().optional()
}).strict().refine((body) => body.token !== undefined || body.clientError !== undefined);
const iosKeySchema = z.object({
  challengeId: z.string().uuid(),
  keyId: base64(64),
  attestationObject: base64(65_536),
  environment: z.unknown().optional(),
  deviceCheckToken: base64(16_384).optional()
}).strict();
const iosAssertSchema = z.object({
  challengeId: z.string().uuid(),
  purpose: sessionPurpose,
  keyId: base64(64),
  assertion: base64(8192),
  shellBuild,
  fix: fixSchema.optional(),
  environment: z.unknown().optional(),
  deviceCheckToken: base64(16_384).optional()
}).strict();
const deviceCheckSchema = z.object({
  challengeId: z.string().uuid(),
  purpose: sessionPurpose,
  deviceToken: base64(16_384),
  shellBuild,
  environment: z.unknown().optional()
}).strict();

const SMALL = { bodyLimit: 32_768, config: { rateLimit: { max: 60, timeWindow: "1 minute" } } };
const LARGE = { bodyLimit: 131_072, config: { rateLimit: { max: 20, timeWindow: "1 minute" } } };

function sendNotFound(reply: FastifyReply): void {
  sendError(reply, 404, "NOT_FOUND", "Not found");
}

function sendOutcome(reply: FastifyReply, result: AttestOutcomeResult) {
  switch (result.status) {
    case "ok":
      return result.body;
    case "not_found":
      sendNotFound(reply);
      return;
    case "invalid_request":
      sendError(reply, 400, "ATTEST_INVALID", "Attestation request is invalid");
      return;
    case "challenge_invalid":
      sendError(reply, 409, "ATTEST_CHALLENGE_INVALID", "Attestation challenge is invalid or expired");
      return;
    case "key_exists":
      sendError(reply, 409, "ATTEST_KEY_EXISTS", "Attestation key is already registered");
      return;
    case "key_unknown":
      sendError(reply, 409, "ATTEST_KEY_UNKNOWN", "Attestation key is not registered");
      return;
  }
}

function sendUnavailable(reply: FastifyReply): void {
  // Never log request bodies, tokens or provider responses.
  sendError(reply, 503, "ATTEST_UNAVAILABLE", "Attestation is temporarily unavailable");
}

/** 404 for every route when TRUST_ATTESTATION_MODE=off (service null) or the platform is disabled. */
export function registerDeviceTrustRoutes(app: FastifyInstance, service: AttestationService | null): void {
  app.post("/api/trust/attest/challenge", SMALL, async (request, reply) => {
    if (!service) return sendNotFound(reply);
    let session;
    try {
      session = requireRequestSession(request);
    } catch (error) {
      return sendAuthError(reply, error);
    }
    const parsed = challengeSchema.safeParse(request.body);
    if (!parsed.success) return sendError(reply, 400, "ATTEST_INVALID", "Attestation request is invalid");
    try {
      const result = await service.createChallenge(session, parsed.data);
      if (result.status === "ok") return result.body;
      if (result.status === "rate_limited") {
        return sendError(reply, 429, "ATTEST_RATE_LIMITED", "Too many attestation requests");
      }
      return sendNotFound(reply);
    } catch {
      return sendUnavailable(reply);
    }
  });

  const handle = <T>(
    url: string,
    options: typeof SMALL,
    schema: z.ZodType<T>,
    run: (session: ReturnType<typeof requireRequestSession>, body: T) => Promise<AttestOutcomeResult>
  ): void => {
    app.post(url, options, async (request, reply) => {
      if (!service) return sendNotFound(reply);
      let session;
      try {
        session = requireRequestSession(request);
      } catch (error) {
        return sendAuthError(reply, error);
      }
      const parsed = schema.safeParse(request.body);
      if (!parsed.success) return sendError(reply, 400, "ATTEST_INVALID", "Attestation request is invalid");
      try {
        return sendOutcome(reply, await run(session, parsed.data));
      } catch {
        return sendUnavailable(reply);
      }
    });
  };

  handle("/api/trust/attest/android", SMALL, androidSchema, (session, body) =>
    service!.attestAndroid(session, body));
  handle("/api/trust/attest/ios/key", LARGE, iosKeySchema, (session, body) =>
    service!.registerIosKey(session, { ...body, attestationObject: Buffer.from(body.attestationObject, "base64") }));
  handle("/api/trust/attest/ios/assert", SMALL, iosAssertSchema, (session, body) =>
    service!.assertIos(session, { ...body, assertion: Buffer.from(body.assertion, "base64") }));
  handle("/api/trust/attest/ios/devicecheck", SMALL, deviceCheckSchema, (session, body) =>
    service!.checkDevice(session, body));
}
