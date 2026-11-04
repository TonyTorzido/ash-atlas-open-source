import {
  healTargetSettingsResponseSchema,
  type HealTargetSettings,
  PROFILE_API_CONTRACT_HEADER,
  PROFILE_API_CONTRACT_VERSION,
  publicProfileSchema,
  recentPlayersResponseSchema,
  socialPlayerSummarySchema,
  socialInboxResponseSchema,
  socialListResponseSchema,
  HOTBAR_ACTION_BINDINGS_QUERY,
  hotbarSettingsResponseSchema,
  type ProfileTextUpdate,
  type HotbarUpdate,
  type HotbarSettings,
  type PublicProfile,
  type RecentPlayersResponse,
  type SocialAction,
  type SocialInboxResponse,
  type SocialListKind,
  type SocialListResponse,
  type SocialPlayerSummary
} from "@ash-atlas/shared";

export class ProfileApiError extends Error {
  constructor(readonly code: string, message: string, readonly status: number) {
    super(message);
    this.name = "ProfileApiError";
  }
}

export class ProfileApiClient {
  constructor(
    private readonly serverHttpBase: string,
    private readonly csrfToken: string
  ) {}

  async getProfile(playerId: string): Promise<PublicProfile> {
    const payload = await this.request<unknown>(
      `/api/profile/${encodeURIComponent(playerId)}`,
      { method: "GET" }
    );
    return publicProfileSchema.parse(profileFromPayload(payload));
  }

  async updateProfile(input: ProfileTextUpdate): Promise<PublicProfile> {
    const payload = await this.request<unknown>("/api/profile/me", {
      method: "PATCH",
      headers: this.mutationHeaders(),
      body: JSON.stringify(input)
    });
    return publicProfileSchema.parse(profileFromPayload(payload));
  }

  async getHotbar(): Promise<HotbarSettings> {
    const payload = await this.request<unknown>(`/api/profile/me/hotbar?${HOTBAR_ACTION_BINDINGS_QUERY}`, { method: "GET" });
    return hotbarSettingsResponseSchema.parse(payload).hotbar;
  }

  async updateHotbar(input: HotbarUpdate): Promise<HotbarSettings> {
    const payload = await this.request<unknown>(`/api/profile/me/hotbar?${HOTBAR_ACTION_BINDINGS_QUERY}`, {
      method: "PATCH",
      headers: this.mutationHeaders(),
      body: JSON.stringify(input)
    });
    return hotbarSettingsResponseSchema.parse(payload).hotbar;
  }

  async getHealTargets(): Promise<HealTargetSettings> {
    const payload = await this.request<unknown>("/api/profile/me/heal-targets", { method: "GET" });
    return healTargetSettingsResponseSchema.parse(payload).healTargets;
  }

  async updateHealTargets(update: Partial<HealTargetSettings>): Promise<HealTargetSettings> {
    const payload = await this.request<unknown>("/api/profile/me/heal-targets", {
      method: "PATCH",
      headers: this.mutationHeaders(),
      body: JSON.stringify(update)
    });
    return healTargetSettingsResponseSchema.parse(payload).healTargets;
  }

  async mutate(targetPlayerId: string, action: SocialAction): Promise<PublicProfile> {
    const payload = await this.request<unknown>("/api/social/relationship", {
      method: "POST",
      headers: this.mutationHeaders(),
      body: JSON.stringify({ targetPlayerId, action })
    });
    return publicProfileSchema.parse(profileFromPayload(payload));
  }

  async list(kind: SocialListKind, offset = 0, limit = 25): Promise<SocialListResponse> {
    const query = new URLSearchParams({ offset: String(offset), limit: String(limit) });
    const payload = await this.request<unknown>(
      `/api/social/lists/${encodeURIComponent(kind)}?${query}`,
      { method: "GET" }
    );
    return socialListResponseSchema.parse(payload);
  }

  /** Another player's Friends or Enemies, shown on their profile. */
  async listForPlayer(
    playerId: string,
    kind: "friends" | "enemies",
    offset = 0,
    limit = 50
  ): Promise<SocialListResponse> {
    const query = new URLSearchParams({ offset: String(offset), limit: String(limit) });
    const payload = await this.request<unknown>(
      `/api/social/player/${encodeURIComponent(playerId)}/lists/${kind}?${query}`,
      { method: "GET" }
    );
    return socialListResponseSchema.parse(payload);
  }

  async listRecent(limit = 25): Promise<RecentPlayersResponse> {
    const query = new URLSearchParams({ limit: String(limit) });
    const payload = await this.request<unknown>(`/api/social/recent?${query}`, { method: "GET" });
    return recentPlayersResponseSchema.parse(payload);
  }

  async getSocialPlayer(playerId: string): Promise<SocialPlayerSummary> {
    const payload = await this.request<unknown>(
      `/api/social/player/${encodeURIComponent(playerId)}`,
      { method: "GET" }
    );
    if (!payload || typeof payload !== "object" || !("player" in payload)) {
      throw new ProfileApiError("INVALID_SOCIAL_PLAYER_RESPONSE", "Invalid player response", 500);
    }
    return socialPlayerSummarySchema.parse(payload.player);
  }

  async inbox(): Promise<SocialInboxResponse> {
    const payload = await this.request<unknown>("/api/social/inbox", { method: "GET" });
    return socialInboxResponseSchema.parse(payload);
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
      const headers = new Headers(init.headers);
      headers.set(PROFILE_API_CONTRACT_HEADER, PROFILE_API_CONTRACT_VERSION);
      response = await fetch(new URL(path, this.serverHttpBase), {
        ...init,
        headers,
        credentials: "include"
      });
    } catch {
      throw new ProfileApiError("SERVER_UNAVAILABLE", "Profile service unavailable", 0);
    }
    const payload = await readJson(response);
    if (!response.ok) {
      const error = errorFromPayload(payload);
      throw new ProfileApiError(
        error?.code ?? "PROFILE_REQUEST_FAILED",
        error?.message ?? "Profile request failed",
        response.status
      );
    }
    return payload as T;
  }
}

function profileFromPayload(payload: unknown): unknown {
  if (!payload || typeof payload !== "object" || !("profile" in payload)) {
    throw new ProfileApiError("INVALID_PROFILE_RESPONSE", "Invalid profile response", 500);
  }
  return payload.profile;
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
