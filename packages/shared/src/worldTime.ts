export const WORLD_TIME_ANCHOR_ISO = "2026-01-01T07:00:00.000Z";
export const WORLD_TIME_CYCLE_MS = 8 * 60 * 60_000;

const WORLD_TIME_ANCHOR_MS = Date.parse(WORLD_TIME_ANCHOR_ISO);
const GAME_DAY_MINUTES = 24 * 60;
const GAME_START_MINUTES = 6 * 60;

export type WorldTimePhase = "day" | "dusk" | "night" | "dawn";
export type WorldTimeMechanicalPhase = "DAY" | "NIGHT";

export type WorldTimeSnapshot = Readonly<{
  gameMinutes: number;
  formattedLabel: string;
  phase: WorldTimePhase;
  mechanicalPhase: WorldTimeMechanicalPhase;
  daylightIntensity: number;
}>;

/**
 * Returns the repeating world clock for one absolute instant. The anchor is
 * UTC and deliberately never re-anchors for local time or daylight saving.
 */
export function worldTimeAt(instant: Date | number): WorldTimeSnapshot {
  const instantMs = instant instanceof Date ? instant.getTime() : instant;
  if (!Number.isFinite(instantMs)) {
    throw new Error("world time instant must be finite");
  }
  const elapsedInCycleMs = positiveModulo(
    instantMs - WORLD_TIME_ANCHOR_MS,
    WORLD_TIME_CYCLE_MS
  );
  const gameMinutes = positiveModulo(
    GAME_START_MINUTES
      + Math.floor(elapsedInCycleMs * GAME_DAY_MINUTES / WORLD_TIME_CYCLE_MS),
    GAME_DAY_MINUTES
  );
  const phase = phaseForGameMinutes(gameMinutes);
  return {
    gameMinutes,
    formattedLabel: formatGameMinutes(gameMinutes),
    phase,
    mechanicalPhase: phase === "day" || phase === "dusk" ? "DAY" : "NIGHT",
    daylightIntensity: daylightIntensity(gameMinutes, phase)
  };
}

function phaseForGameMinutes(gameMinutes: number): WorldTimePhase {
  if (gameMinutes >= 6 * 60 && gameMinutes < 18 * 60) return "day";
  if (gameMinutes >= 18 * 60 && gameMinutes < 21 * 60) return "dusk";
  if (gameMinutes >= 21 * 60 || gameMinutes < 3 * 60) return "night";
  return "dawn";
}

function daylightIntensity(
  gameMinutes: number,
  phase: WorldTimePhase
): number {
  if (phase === "day") return 1;
  if (phase === "night") return 0;
  if (phase === "dusk") return (21 * 60 - gameMinutes) / (3 * 60);
  return (gameMinutes - 3 * 60) / (3 * 60);
}

function formatGameMinutes(gameMinutes: number): string {
  const hours = Math.floor(gameMinutes / 60);
  const minutes = gameMinutes % 60;
  const period = hours >= 12 ? "PM" : "AM";
  const twelveHour = hours % 12 || 12;
  return `${twelveHour}:${minutes.toString().padStart(2, "0")} ${period}`;
}

function positiveModulo(value: number, modulus: number): number {
  return ((value % modulus) + modulus) % modulus;
}
