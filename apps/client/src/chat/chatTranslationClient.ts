import {
  CHAT_TRANSLATION_TARGET_LANGUAGES,
  type ChatTranslationTargetLanguage
} from "@ash-atlas/shared";

export type ChatTranslationResult = {
  translatedText: string;
  sourceLanguage?: string;
};

export class ChatTranslationApiError extends Error {
  constructor(readonly code: string, message: string, readonly status: number) {
    super(message);
    this.name = "ChatTranslationApiError";
  }
}

export class ChatTranslationApi {
  constructor(
    private readonly serverHttpBase: string,
    private readonly csrfToken: string
  ) {}

  async translate(
    messageId: string,
    targetLanguage: string
  ): Promise<ChatTranslationResult> {
    if (!messageId || !isChatTranslationTargetLanguage(targetLanguage)) {
      throw new ChatTranslationApiError(
        "CHAT_TRANSLATION_INVALID",
        "Translation details are invalid.",
        400
      );
    }
    const payload = await this.request<unknown>("/api/chat/translate", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-csrf-token": this.csrfToken
      },
      body: JSON.stringify({ messageId, targetLanguage })
    });
    if (!payload || typeof payload !== "object" ||
      typeof (payload as { translatedText?: unknown }).translatedText !== "string" ||
      (payload as { translatedText: string }).translatedText.trim().length === 0 ||
      ((payload as { sourceLanguage?: unknown }).sourceLanguage !== undefined &&
        typeof (payload as { sourceLanguage?: unknown }).sourceLanguage !== "string")) {
      throw new ChatTranslationApiError(
        "INVALID_TRANSLATION_RESPONSE",
        "Translation response was invalid.",
        500
      );
    }
    return payload as ChatTranslationResult;
  }

  private async request<T>(path: string, init: RequestInit): Promise<T> {
    let response: Response;
    try {
      response = await fetch(new URL(path, this.serverHttpBase), {
        ...init,
        credentials: "include",
        headers: new Headers(init.headers)
      });
    } catch {
      throw new ChatTranslationApiError(
        "SERVER_UNAVAILABLE",
        "Translation service unavailable.",
        0
      );
    }
    const payload = await readJson(response);
    if (!response.ok) {
      const error = errorFromPayload(payload);
      throw new ChatTranslationApiError(
        error?.code ?? "CHAT_TRANSLATION_UNAVAILABLE",
        error?.message ?? "Translation is temporarily unavailable.",
        response.status
      );
    }
    return payload as T;
  }
}

export function isChatTranslationTargetLanguage(value: string): value is ChatTranslationTargetLanguage {
  return (CHAT_TRANSLATION_TARGET_LANGUAGES as readonly string[]).includes(value);
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function errorFromPayload(payload: unknown): { code?: string; message?: string } | null {
  if (!payload || typeof payload !== "object" || !("error" in payload)) return null;
  const error = payload.error;
  if (!error || typeof error !== "object") return null;
  return {
    ...(typeof (error as { code?: unknown }).code === "string"
      ? { code: (error as { code: string }).code }
      : {}),
    ...(typeof (error as { message?: unknown }).message === "string"
      ? { message: (error as { message: string }).message }
      : {})
  };
}
