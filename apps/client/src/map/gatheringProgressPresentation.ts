export const GATHERING_PROGRESS_STYLE = {
  width: 126,
  height: 38,
  radius: 3,
  plate: 0x0d0b08,
  border: 0xb49d75,
  iron: 0x3d3b36,
  parchment: 0xe7dcc2,
  track: 0x1c1b18,
  fill: 0x98703d
} as const;

export function formatGatheringRemainingTime(remainingMs: number): string {
  return `${(Math.max(0, remainingMs) / 1_000).toFixed(1)}s`;
}
