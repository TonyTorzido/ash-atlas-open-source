import { afterEach, describe, expect, it, vi } from "vitest";

import { ChatTranslationApi } from "./chatTranslationClient.js";
import type { ChatTranslationApiError } from "./chatTranslationClient.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ChatTranslationApi", () => {
  it("sends message identity and target language with the session CSRF token", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      translatedText: "Hello",
      sourceLanguage: "ES"
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const api = new ChatTranslationApi("https://server.test", "csrf-token");

    await expect(api.translate("message-id", "en")).resolves.toEqual({
      translatedText: "Hello",
      sourceLanguage: "ES"
    });
    const [input, init] = fetchMock.mock.calls[0]!;
    expect(String(input)).toBe("https://server.test/api/chat/translate");
    expect(init?.method).toBe("POST");
    expect(init?.credentials).toBe("include");
    expect((init?.headers as Headers).get("x-csrf-token")).toBe("csrf-token");
    expect(JSON.parse(String(init?.body))).toEqual({ messageId: "message-id", targetLanguage: "en" });
    expect(String(init?.body)).not.toContain("Hello");
  });

  it("surfaces unavailable responses and rejects unsupported targets before network access", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      ok: false,
      error: { code: "CHAT_TRANSLATION_UNAVAILABLE", message: "Translation is temporarily unavailable." }
    }), { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);
    const api = new ChatTranslationApi("https://server.test", "csrf-token");

    await expect(api.translate("message-id", "en")).rejects.toMatchObject({
      code: "CHAT_TRANSLATION_UNAVAILABLE",
      status: 503
    } satisfies Partial<ChatTranslationApiError>);
    await expect(api.translate("message-id", "xx")).rejects.toMatchObject({
      code: "CHAT_TRANSLATION_INVALID",
      status: 400
    } satisfies Partial<ChatTranslationApiError>);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("reports server/network and malformed success responses without inventing a translation", async () => {
    const networkFailure = vi.fn(async () => { throw new Error("network detail"); });
    vi.stubGlobal("fetch", networkFailure);
    const api = new ChatTranslationApi("https://server.test", "csrf-token");
    await expect(api.translate("message-id", "en")).rejects.toMatchObject({
      code: "SERVER_UNAVAILABLE",
      status: 0
    });

    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ translatedText: "" }), { status: 200 })));
    await expect(api.translate("message-id", "en")).rejects.toMatchObject({
      code: "INVALID_TRANSLATION_RESPONSE",
      status: 500
    });
  });
});
