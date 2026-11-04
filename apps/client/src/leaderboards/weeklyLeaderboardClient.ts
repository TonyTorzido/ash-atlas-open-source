import {
  weeklyLeaderboardSnapshotSchema,
  type WeeklyLeaderboardSnapshot
} from "@ash-atlas/shared";

export class WeeklyLeaderboardClient {
  constructor(private readonly serverHttpBase: string) {}

  async load(
    week: "current" | "previous",
    signal?: AbortSignal
  ): Promise<WeeklyLeaderboardSnapshot> {
    let response: Response;
    try {
      const query = new URLSearchParams({ week });
      response = await fetch(
        new URL(`/api/leaderboards/weekly?${query}`, this.serverHttpBase),
        {
          credentials: "include",
          ...(signal ? { signal } : {})
        }
      );
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new Error("Weekly leaderboards are unavailable while disconnected.");
    }
    const payload = await readJson(response);
    if (!response.ok) {
      throw new Error(errorMessage(payload) ?? "Weekly leaderboards could not be loaded.");
    }
    return weeklyLeaderboardSnapshotSchema.parse(payload);
  }
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function errorMessage(payload: unknown): string | null {
  if (!payload || typeof payload !== "object" || !("error" in payload)) return null;
  const error = payload.error;
  if (!error || typeof error !== "object" || !("message" in error)) return null;
  return typeof error.message === "string" ? error.message : null;
}
