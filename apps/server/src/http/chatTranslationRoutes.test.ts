import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { installAuthGuard } from "../auth/authGuard.js";
import type { AuthenticatedSession } from "../auth/types.js";
import { ChatServiceError } from "../chat/types.js";
import type { ChatMessage } from "@ash-atlas/shared";
import { ChatTranslationUnavailableError } from "../chat/googleCloudTranslation.js";
import type {
  ChatTranslationExecutor
} from "../chat/chatTranslationService.js";
import { registerChatTranslationRoutes } from "./chatTranslationRoutes.js";

const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("chat translation HTTP authority", () => {
  it("requires the authenticated playable session before reading a message", async () => {
    const chatService = { getMessageForTranslation: vi.fn() };
    const provider = configuredTranslationService();
    const { app } = await buildApp(chatService, provider);

    const response = await app.inject({
      method: "POST",
      url: "/api/chat/translate",
      payload: { messageId: validMessageId(), targetLanguage: "en" }
    });

    expect(response.statusCode).toBe(401);
    expect(chatService.getMessageForTranslation).not.toHaveBeenCalled();
    expect(provider.translate).not.toHaveBeenCalled();
  });

  it("validates identity and target language without accepting arbitrary text", async () => {
    const chatService = { getMessageForTranslation: vi.fn() };
    const provider = configuredTranslationService();
    const { app } = await buildApp(chatService, provider);
    const headers = authHeaders();

    const invalidTarget = await app.inject({
      method: "POST",
      url: "/api/chat/translate",
      headers,
      payload: { messageId: validMessageId(), targetLanguage: "xx", text: "arbitrary" }
    });
    expect(invalidTarget.statusCode).toBe(400);
    expect(chatService.getMessageForTranslation).not.toHaveBeenCalled();
    expect(provider.translate).not.toHaveBeenCalled();
  });

  it("translates the authoritative message and returns provider detected language", async () => {
    const message = authoritativeMessage("Hola");
    const chatService = {
      getMessageForTranslation: vi.fn(async (_playerId: string, messageId: string) => ({
        ...message,
        id: messageId
      }))
    };
    const provider = configuredTranslationService({ translatedText: "Hello", sourceLanguage: "ES" });
    const { app } = await buildApp(chatService, provider);

    const response = await app.inject({
      method: "POST",
      url: "/api/chat/translate",
      headers: authHeaders(),
      payload: { messageId: validMessageId(), targetLanguage: "en" }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ translatedText: "Hello", sourceLanguage: "ES" });
    expect(chatService.getMessageForTranslation).toHaveBeenCalledWith("player-a", validMessageId());
    expect(provider.translate).toHaveBeenCalledWith(
      expect.objectContaining({ id: validMessageId(), body: "Hola" }),
      "en"
    );
  });

  it("returns unavailable for missing configuration and provider failures without leaking details", async () => {
    const chatService = {
      getMessageForTranslation: vi.fn(async () => authoritativeMessage("Hola"))
    };
    const missing = unavailableTranslationService();
    const { app } = await buildApp(chatService, missing);
    const missingResponse = await app.inject({
      method: "POST",
      url: "/api/chat/translate",
      headers: authHeaders(),
      payload: { messageId: validMessageId(), targetLanguage: "en" }
    });
    expect(missingResponse.statusCode).toBe(503);
    expect(missingResponse.json().error).toEqual({
      code: "CHAT_TRANSLATION_UNAVAILABLE",
      message: "Translation is temporarily unavailable."
    });
    expect(missingResponse.body).not.toContain("secret");

    missing.translate.mockRejectedValueOnce(new Error("provider secret detail"));
    const providerResponse = await app.inject({
      method: "POST",
      url: "/api/chat/translate",
      headers: authHeaders(),
      payload: { messageId: validMessageId(), targetLanguage: "en" }
    });
    expect(providerResponse.statusCode).toBe(503);
    expect(providerResponse.body).not.toContain("provider secret detail");
  });

  it("preserves access errors from the authoritative chat lookup", async () => {
    const chatService = {
      getMessageForTranslation: vi.fn(async () => {
        throw new ChatServiceError("CHAT_ACCESS_DENIED", "Chat membership is required");
      })
    };
    const { app } = await buildApp(chatService, configuredTranslationService());
    const response = await app.inject({
      method: "POST",
      url: "/api/chat/translate",
      headers: authHeaders(),
      payload: { messageId: validMessageId(), targetLanguage: "en" }
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("CHAT_ACCESS_DENIED");
  });
});

async function buildApp(
  chatService: { getMessageForTranslation: ReturnType<typeof vi.fn> },
  translationService: ChatTranslationExecutor
): Promise<{ app: FastifyInstance }> {
  const app = Fastify();
  apps.push(app);
  await app.register(cookie);
  await app.register(rateLimit, { global: false });
  const auth = {
    sessionCookieName: "session",
    authenticateSession: vi.fn(async (value: string | null) => value === "valid" ? session() : null),
    assertOrigin: vi.fn(),
    assertCsrf: vi.fn(),
    requireApprovedTestAccess: vi.fn(),
    requireGameplayReady: vi.fn()
  };
  installAuthGuard(app, { AUTH_REQUIRED: true } as never, auth as never);
  registerChatTranslationRoutes(app, chatService, translationService);
  await app.ready();
  return { app };
}

function configuredTranslationService(result = { translatedText: "translated", sourceLanguage: "ES" }) {
  return {
    translate: vi.fn(async () => result)
  } as unknown as ChatTranslationExecutor & {
    translate: ReturnType<typeof vi.fn>;
  };
}

function unavailableTranslationService() {
  return {
    translate: vi.fn(async () => {
      throw new ChatTranslationUnavailableError();
    })
  } as unknown as ChatTranslationExecutor & {
    translate: ReturnType<typeof vi.fn>;
  };
}

function session(): AuthenticatedSession {
  return {
    sessionId: "session-player-a",
    verifiedEmail: "player-a@example.com",
    account: {} as AuthenticatedSession["account"],
    player: { id: "player-a" } as AuthenticatedSession["player"],
    deviceInstallationId: null,
    csrfToken: "csrf"
  };
}

function authHeaders(): Record<string, string> {
  return {
    cookie: "session=valid",
    origin: "http://127.0.0.1:5173",
    "x-csrf-token": "csrf"
  };
}

function validMessageId(): string {
  return "05000000-0000-4000-8000-000000000001";
}

function authoritativeMessage(body: string): ChatMessage {
  return {
    id: validMessageId(),
    channelId: "05000000-0000-4000-8000-000000000002",
    channelKey: "public:general",
    sequence: 1,
    senderPlayerId: "player-b",
    senderDisplayName: "Other",
    body,
    serverCreatedAt: "2026-09-15T00:00:00.000Z",
    clientRequestId: validMessageId(),
    status: "confirmed",
    moderationStatus: "clear",
    editedAt: null,
    deletedAt: null,
    createdAt: "2026-09-15T00:00:00.000Z",
    updatedAt: "2026-09-15T00:00:00.000Z"
  };
}
