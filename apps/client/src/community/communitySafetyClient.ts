export type CommunityTermsStatus = {
  version: string;
  accepted: boolean;
};

export const COMMUNITY_REPORT_CATEGORIES = [
  "harassment",
  "hate",
  "sexual",
  "threat",
  "illegal",
  "spam",
  "cheating",
  "other"
] as const;

export type CommunityReportCategory = (typeof COMMUNITY_REPORT_CATEGORIES)[number];

export class CommunitySafetyApiError extends Error {
  constructor(readonly code: string, message: string, readonly status: number) {
    super(message);
    this.name = "CommunitySafetyApiError";
  }
}

export class CommunitySafetyApi {
  constructor(
    private readonly serverHttpBase: string,
    private readonly csrfToken: string
  ) {}

  async terms(): Promise<CommunityTermsStatus> {
    const payload = await this.request<unknown>("/api/community/terms", { method: "GET" });
    if (!payload || typeof payload !== "object" ||
      typeof (payload as { version?: unknown }).version !== "string" ||
      typeof (payload as { accepted?: unknown }).accepted !== "boolean") {
      throw new CommunitySafetyApiError("INVALID_TERMS_RESPONSE", "Community rules status was invalid.", 500);
    }
    return payload as CommunityTermsStatus;
  }

  async acceptTerms(version: string): Promise<CommunityTermsStatus> {
    const payload = await this.request<unknown>("/api/community/terms/accept", {
      method: "POST",
      headers: this.mutationHeaders(),
      body: JSON.stringify({ version })
    });
    if (!payload || typeof payload !== "object" || (payload as { accepted?: unknown }).accepted !== true) {
      throw new CommunitySafetyApiError("INVALID_TERMS_RESPONSE", "Community rules acceptance was invalid.", 500);
    }
    return { version, accepted: true };
  }

  async report(
    targetKind: "message" | "player",
    targetId: string,
    category: CommunityReportCategory,
    explanation?: string | null
  ): Promise<void> {
    await this.request("/api/community/reports", {
      method: "POST",
      headers: this.mutationHeaders(),
      body: JSON.stringify({
        targetKind,
        targetId,
        category,
        ...(explanation?.trim() ? { explanation: explanation.trim() } : {})
      })
    });
  }

  private mutationHeaders(): Record<string, string> {
    return {
      "content-type": "application/json",
      "x-csrf-token": this.csrfToken
    };
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
      throw new CommunitySafetyApiError("SERVER_UNAVAILABLE", "Community safety service unavailable.", 0);
    }
    const payload = await readJson(response);
    if (!response.ok) {
      const error = errorFromPayload(payload);
      throw new CommunitySafetyApiError(
        error?.code ?? "COMMUNITY_SAFETY_REQUEST_FAILED",
        error?.message ?? "Community safety request failed.",
        response.status
      );
    }
    return payload as T;
  }
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
