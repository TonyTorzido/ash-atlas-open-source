export function friendlyDungeonCue(cueId: string): string {
  return cueId.replace(/[-_]+/gu, " ").trim().replace(/^./u, (char) => char.toUpperCase());
}

/** Cues appended since `previous`; the server keeps a capped history, so match the longest overlap. */
export function newDungeonCues(previous: readonly string[], current: readonly string[]): string[] {
  for (let overlap = Math.min(previous.length, current.length); overlap > 0; overlap -= 1) {
    if (previous.slice(previous.length - overlap).every((cue, index) => cue === current[index])) return current.slice(overlap);
  }
  return [...current];
}

/** Notices appended since the last seen id (ids rise monotonically per run); oldest first. */
export function newDungeonNotices<T extends Readonly<{ id: number }>>(
  lastSeenId: number | null,
  notices: readonly T[] | undefined
): T[] {
  if (!notices || lastSeenId === null) return [];
  return notices.filter((notice) => notice.id > lastSeenId);
}
