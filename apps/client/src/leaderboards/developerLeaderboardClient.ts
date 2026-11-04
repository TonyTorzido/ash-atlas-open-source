import {
  developerLeaderboardPlayerInspectorSchema,
  developerLeaderboardPlayerSearchSchema,
  developerLeaderboardPrivateRankingSchema,
  type DeveloperLeaderboardPlayerInspector,
  type DeveloperLeaderboardPrivateRanking
} from "@ash-atlas/shared";

export class DeveloperLeaderboardClient {
  constructor(private readonly serverHttpBase: string) {}

  async search(search: string, signal: AbortSignal): Promise<ReturnType<
    typeof developerLeaderboardPlayerSearchSchema.parse
  >> {
    const url = new URL("/api/dev/leaderboards/players", this.serverHttpBase);
    url.searchParams.set("search", search);
    return developerLeaderboardPlayerSearchSchema.parse(
      await requestJson(url, signal)
    );
  }

  async inspect(
    playerId: string,
    week: "current" | "previous",
    signal: AbortSignal
  ): Promise<DeveloperLeaderboardPlayerInspector> {
    const url = new URL(
      `/api/dev/leaderboards/player/${encodeURIComponent(playerId)}`,
      this.serverHttpBase
    );
    url.searchParams.set("week", week);
    return developerLeaderboardPlayerInspectorSchema.parse(
      await requestJson(url, signal)
    );
  }

  async ranking(
    metricKey: string,
    week: "current" | "previous",
    signal: AbortSignal
  ): Promise<DeveloperLeaderboardPrivateRanking> {
    const url = new URL(
      `/api/dev/leaderboards/ranking/${encodeURIComponent(metricKey)}`,
      this.serverHttpBase
    );
    url.searchParams.set("week", week);
    return developerLeaderboardPrivateRankingSchema.parse(
      await requestJson(url, signal)
    );
  }
}

async function requestJson(url: URL, signal: AbortSignal): Promise<unknown> {
  const response = await fetch(url, { credentials: "include", signal });
  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    // The common error below deliberately avoids exposing server internals.
  }
  if (!response.ok) {
    throw new Error(errorMessage(payload) ?? "Developer leaderboard request failed.");
  }
  return payload;
}

function errorMessage(payload: unknown): string | null {
  if (!payload || typeof payload !== "object" || !("error" in payload)) return null;
  const error = payload.error;
  if (!error || typeof error !== "object" || !("message" in error)) return null;
  return typeof error.message === "string" ? error.message : null;
}
