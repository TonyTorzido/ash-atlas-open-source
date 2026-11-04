import {
  CHAT_MESSAGE_MAX_LENGTH,
  CHAT_TRANSLATION_TARGET_LANGUAGES,
  type ChatTranslationTargetLanguage
} from "@ash-atlas/shared";

const GOOGLE_CLOUD_TRANSLATE_V2_ENDPOINT =
  "https://translation.googleapis.com/language/translate/v2";
const DEFAULT_TIMEOUT_MS = 5_000;

export const CHAT_TRANSLATION_PROVIDER = "google-cloud-translation-basic-v2" as const;
export const CHAT_TRANSLATION_MODEL = "nmt" as const;
export const CHAT_TRANSLATION_VERSION = "v1" as const;

export type ChatTranslationResult = {
  translatedText: string;
  sourceLanguage?: string;
};

export class ChatTranslationUnavailableError extends Error {
  constructor() {
    super("Translation is temporarily unavailable.");
    this.name = "ChatTranslationUnavailableError";
  }
}

export type ChatTranslationProvider = {
  isConfigured(): boolean;
  translate(body: string, targetLanguage: ChatTranslationTargetLanguage): Promise<ChatTranslationResult>;
};

type GoogleCloudTranslationProviderOptions = {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  endpoint?: string;
};

type GoogleTranslateResponse = {
  data?: {
    translations?: Array<{
      translatedText?: unknown;
      detectedSourceLanguage?: unknown;
    }>;
  };
};

export class GoogleCloudTranslationProvider implements ChatTranslationProvider {
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly endpoint: string;

  constructor(
    private readonly apiKey: string | undefined,
    options: GoogleCloudTranslationProviderOptions = {}
  ) {
    this.timeoutMs = Number.isFinite(options.timeoutMs) && (options.timeoutMs ?? 0) > 0
      ? Math.floor(options.timeoutMs!)
      : DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.endpoint = options.endpoint ?? GOOGLE_CLOUD_TRANSLATE_V2_ENDPOINT;
  }

  isConfigured(): boolean {
    return Boolean(this.apiKey);
  }

  async translate(
    body: string,
    targetLanguage: ChatTranslationTargetLanguage
  ): Promise<ChatTranslationResult> {
    if (!this.apiKey || !isSupportedTargetLanguage(targetLanguage)) {
      throw new ChatTranslationUnavailableError();
    }
    const sourceCharacters = Array.from(body).length;
    if (sourceCharacters < 1 || sourceCharacters > CHAT_MESSAGE_MAX_LENGTH) {
      throw new ChatTranslationUnavailableError();
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const endpoint = new URL(this.endpoint);
      endpoint.searchParams.set("key", this.apiKey);
      const response = await this.fetchImpl(endpoint.toString(), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          q: body,
          target: targetLanguage,
          format: "text",
          model: CHAT_TRANSLATION_MODEL
        }),
        signal: controller.signal
      });
      if (!response.ok) throw new ChatTranslationUnavailableError();
      const payload: unknown = await response.json();
      const translation = readTranslation(payload);
      if (!translation) throw new ChatTranslationUnavailableError();
      return translation;
    } catch (error) {
      if (error instanceof ChatTranslationUnavailableError) throw error;
      throw new ChatTranslationUnavailableError();
    } finally {
      clearTimeout(timeout);
    }
  }
}

function isSupportedTargetLanguage(value: string): value is ChatTranslationTargetLanguage {
  return (CHAT_TRANSLATION_TARGET_LANGUAGES as readonly string[]).includes(value);
}

function readTranslation(payload: unknown): ChatTranslationResult | null {
  if (!payload || typeof payload !== "object") return null;
  const data = (payload as GoogleTranslateResponse).data;
  const first = data?.translations?.[0];
  if (!first || typeof first.translatedText !== "string" || first.translatedText.trim().length === 0) {
    return null;
  }
  return {
    translatedText: first.translatedText,
    ...(typeof first.detectedSourceLanguage === "string" && first.detectedSourceLanguage.trim()
      ? { sourceLanguage: first.detectedSourceLanguage }
      : {})
  };
}
