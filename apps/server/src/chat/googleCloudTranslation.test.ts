import { describe, expect, it, vi } from "vitest";

import {
  CHAT_MESSAGE_MAX_LENGTH,
  type ChatTranslationTargetLanguage
} from "@ash-atlas/shared";

import {
  ChatTranslationUnavailableError,
  GoogleCloudTranslationProvider
} from "./googleCloudTranslation.js";

describe("Google Cloud Translation Basic v2 provider", () => {
  it("sends only the supplied message to NMT and returns detected source language", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify({
        data: {
          translations: [{ translatedText: "Hello", detectedSourceLanguage: "es" }]
        }
      }), { status: 200, headers: { "content-type": "application/json" } }));
    const provider = new GoogleCloudTranslationProvider("secret-key", {
      fetchImpl,
      endpoint: "https://translation.test/language/translate/v2"
    });

    await expect(provider.translate("Hola", "en")).resolves.toEqual({
      translatedText: "Hello",
      sourceLanguage: "es"
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [endpoint, init] = fetchImpl.mock.calls[0]!;
    const url = new URL(String(endpoint));
    expect(url.origin + url.pathname).toBe("https://translation.test/language/translate/v2");
    expect(url.searchParams.get("key")).toBe("secret-key");
    expect(init?.headers).toMatchObject({ "content-type": "application/json" });
    expect(JSON.parse(String(init?.body))).toEqual({
      q: "Hola",
      target: "en",
      format: "text",
      model: "nmt"
    });
  });

  it("fails closed for configuration, targets, and the existing message limit", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const missingKey = new GoogleCloudTranslationProvider(undefined, { fetchImpl });
    await expect(missingKey.translate("Hola", "en")).rejects.toBeInstanceOf(
      ChatTranslationUnavailableError
    );
    await expect(
      new GoogleCloudTranslationProvider("key", { fetchImpl }).translate(
        "Hola",
        "xx" as ChatTranslationTargetLanguage
      )
    ).rejects.toBeInstanceOf(ChatTranslationUnavailableError);
    await expect(
      new GoogleCloudTranslationProvider("key", { fetchImpl }).translate(
        "x".repeat(CHAT_MESSAGE_MAX_LENGTH + 1),
        "en"
      )
    ).rejects.toBeInstanceOf(ChatTranslationUnavailableError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    ["provider status", async () => new Response("quota exceeded", { status: 403 })],
    ["provider network", async () => { throw new Error("network detail"); }],
    ["malformed response", async () => new Response(JSON.stringify({ data: { translations: [] } }), { status: 200 })]
  ])("normalizes %s failures without exposing provider details", async (_name, response) => {
    const fetchImpl = vi.fn(response);
    const provider = new GoogleCloudTranslationProvider("secret-key", { fetchImpl });
    await expect(provider.translate("Hola", "en")).rejects.toBeInstanceOf(
      ChatTranslationUnavailableError
    );
    await expect(provider.translate("Hola", "en")).rejects.not.toThrow("secret-key");
  });
});
