/**
 * Library study. A Library is a player-owned city building (citySystem.ts
 * `library`). A player pays Gold to study at it and gains Folios (a per-player
 * counter, not XP or skill points):
 *  - once per Library ever (the owner's own included) and once per UTC day
 *    across all Libraries;
 *  - the Folios per study grow gently with the player's lifetime study count;
 *  - the owner earns a cut of the fee in Gold, nothing at their own Library.
 * Studying never costs premium currency.
 */
export const LIBRARY_STUDY_FEE_GOLD = 100;
/** Owner share of the fee in basis points. */
export const LIBRARY_OWNER_CUT_BPS = 5_000;
export const LIBRARY_BASE_PAGES = 10;
export const LIBRARY_MAX_PAGES_PER_STUDY = 60;

/** Folios for the next study given completed studies: 10 at 0, 14 at 4, 20 at 25, 30 at 100, capped at 60. */
export function libraryFoliosForStudy(priorStudyCount: number): number {
  const count = Math.max(0, Math.trunc(priorStudyCount) || 0);
  return Math.min(LIBRARY_MAX_PAGES_PER_STUDY, LIBRARY_BASE_PAGES + Math.floor(2 * Math.sqrt(count)));
}

export function libraryOwnerCutGold(feeGold: bigint): bigint {
  return (feeGold * BigInt(LIBRARY_OWNER_CUT_BPS)) / 10_000n;
}

export type LibraryUnavailableReason =
  | "studied_here"
  | "studied_today"
  | "insufficient_gold";

export type LibrarySnapshot = Readonly<{
  structureId: string;
  ownerPlayerId: string;
  ownerUsername: string | null;
  isOwner: boolean;
  feeGold: string;
  /** Gold the owner receives from this study (0 at your own Library). */
  ownerCutGold: string;
  /** Folios the next study would grant. */
  foliosPerStudy: number;
  studyCount: number;
  totalFolios: number;
  canStudy: boolean;
  unavailableReason: LibraryUnavailableReason | null;
  /** UTC day (YYYY-MM-DD) the daily limit resets at the end of. */
  day: string;
  serverTime: number;
}>;

export type LibraryStudyResult = Readonly<{
  foliosGained: number;
  feeGold: string;
  replayed: boolean;
}>;

export const LIBRARY_UNAVAILABLE_TEXT: Readonly<Record<LibraryUnavailableReason, string>> = Object.freeze({
  studied_here: "You have already studied at this Library.",
  studied_today: "You have already studied today. Come back tomorrow.",
  insufficient_gold: "Not enough Gold to study."
});
