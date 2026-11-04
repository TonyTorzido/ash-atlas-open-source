import { BITTER_BLOOD_ACHIEVEMENT_ID, POISON_DAMAGE_TAKEN_STAT_KEY, legendJournalSnapshotSchema, legendObjectiveValue, type AchievementSnapshot, type LegendJournalSnapshot } from "@ash-atlas/shared";

export async function loadLegendJournal(serverHttpBase: string, signal: AbortSignal): Promise<LegendJournalSnapshot> {
  let response: Response;
  try {
    response = await fetch(new URL("/api/legends", serverHttpBase), { credentials: "include", signal });
  } catch (error) {
    if (signal.aborted) throw error;
    throw new Error("The journal is unavailable while disconnected.");
  }
  if (!response.ok) {
    throw new Error(response.status === 401
      ? "Your session has ended. Reconnect to load the journal."
      : "The journal could not be refreshed. Try again.");
  }
  const parsed = legendJournalSnapshotSchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) throw new Error("Journal progress could not be read. Try again.");
  return parsed.data;
}

export const LEGEND_PIN_LIMIT = 3;
const pinKey = (playerId: string): string => "ash-atlas:legend-pins:v1:" + encodeURIComponent(playerId);

export function readLegendPins(playerId: string, validIds: ReadonlySet<string>): string[] {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(pinKey(playerId)) ?? "[]");
    return Array.isArray(stored)
      ? [...new Set(stored.filter((id): id is string => typeof id === "string" && validIds.has(id)))].slice(0, LEGEND_PIN_LIMIT)
      : [];
  } catch {
    return [];
  }
}

export function saveLegendPins(playerId: string, ids: readonly string[]): boolean {
  try {
    localStorage.setItem(pinKey(playerId), JSON.stringify(ids.slice(0, LEGEND_PIN_LIMIT)));
    return true;
  } catch {
    return false;
  }
}

/** Keep gameplay-confirmed Bitter Blood progress monotonic without awarding it from a counter. */
export function mergeLiveAchievements(
  snapshot: LegendJournalSnapshot,
  achievements: AchievementSnapshot | null,
  previous?: LegendJournalSnapshot | null
): LegendJournalSnapshot {
  const retained = previous?.playerId === snapshot.playerId ? previous : null;
  const live = achievements?.playerId === snapshot.playerId
    ? achievements.achievements.find((entry) => entry.achievementId === BITTER_BLOOD_ACHIEVEMENT_ID)
    : undefined;
  const value = Math.max(
    legendObjectiveValue(snapshot.metrics, POISON_DAMAGE_TAKEN_STAT_KEY),
    legendObjectiveValue(retained?.metrics ?? {}, POISON_DAMAGE_TAKEN_STAT_KEY),
    legendObjectiveValue({ [POISON_DAMAGE_TAKEN_STAT_KEY]: live?.value ?? 0 }, POISON_DAMAGE_TAKEN_STAT_KEY)
  );
  const completedAt = snapshot.completed[BITTER_BLOOD_ACHIEVEMENT_ID]
    ?? retained?.completed[BITTER_BLOOD_ACHIEVEMENT_ID]
    ?? (live?.completed && live.completedAt ? live.completedAt : undefined);
  if (value === (snapshot.metrics[POISON_DAMAGE_TAKEN_STAT_KEY] ?? 0)
    && completedAt === snapshot.completed[BITTER_BLOOD_ACHIEVEMENT_ID]) return snapshot;
  return {
    ...snapshot,
    metrics: { ...snapshot.metrics, [POISON_DAMAGE_TAKEN_STAT_KEY]: value },
    completed: completedAt ? { ...snapshot.completed, [BITTER_BLOOD_ACHIEVEMENT_ID]: completedAt } : snapshot.completed
  };
}
