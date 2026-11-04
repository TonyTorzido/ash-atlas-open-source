import {
  CHAT_CRESTS,
  isChatCrestId,
  type ChatCrestSelection
} from "@ash-atlas/shared";

export class ChatCrestApiError extends Error {
  constructor(readonly code: string, message: string, readonly status: number) {
    super(message);
    this.name = "ChatCrestApiError";
  }
}

export class ChatCrestApi {
  constructor(
    private readonly serverHttpBase: string,
    private readonly csrfToken: string
  ) {}

  async list(): Promise<ChatCrestSelection> {
    const payload = await this.request<unknown>("/api/chat/crests", { method: "GET" });
    return parseSelection(payload);
  }

  async equip(crestId: string): Promise<ChatCrestSelection> {
    if (!isChatCrestId(crestId)) {
      throw new ChatCrestApiError("CHAT_CREST_INVALID", "Choose a registered chat crest.", 400);
    }
    const payload = await this.request<unknown>("/api/chat/crests", {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        "x-csrf-token": this.csrfToken
      },
      body: JSON.stringify({ crestId })
    });
    return parseSelection(payload);
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
      throw new ChatCrestApiError("SERVER_UNAVAILABLE", "Chat crest settings are unavailable.", 0);
    }
    const payload = await readJson(response);
    if (!response.ok) {
      const error = errorFromPayload(payload);
      throw new ChatCrestApiError(
        error?.code ?? "CHAT_CREST_UNAVAILABLE",
        error?.message ?? "Chat crest settings are unavailable.",
        response.status
      );
    }
    return payload as T;
  }
}

function parseSelection(payload: unknown): ChatCrestSelection {
  if (!payload || typeof payload !== "object") {
    throw new ChatCrestApiError("INVALID_CHAT_CREST_RESPONSE", "Chat crest settings were invalid.", 500);
  }
  const candidate = payload as Partial<ChatCrestSelection>;
  if (!Array.isArray(candidate.crests) ||
      !candidate.crests.every((crest) =>
        Boolean(crest) && typeof crest === "object" &&
        isChatCrestId((crest as { id?: unknown }).id) &&
        typeof (crest as { label?: unknown }).label === "string" &&
        typeof (crest as { assetKey?: unknown }).assetKey === "string"
      ) ||
      !isChatCrestId(candidate.equippedCrestId)) {
    throw new ChatCrestApiError("INVALID_CHAT_CREST_RESPONSE", "Chat crest settings were invalid.", 500);
  }
  return {
    crests: candidate.crests.filter((crest) => CHAT_CRESTS.some((known) => known.id === crest.id)),
    equippedCrestId: candidate.equippedCrestId
  };
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
