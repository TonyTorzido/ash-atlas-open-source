import type { ProgressionSnapshot } from "@ash-atlas/shared";

/**
 * Glimmer level-up fee: with the fee on, the server keeps the paid level and banks XP, so the
 * next level is ready once total XP reaches its threshold. Returns that level, or null.
 */
export function readyLevelUpTarget(
  progression: ProgressionSnapshot | null,
  levelUpGlimmer: number | null | undefined
): number | null {
  if (!progression || levelUpGlimmer == null || progression.atCap) return null;
  const next = progression.nextLevelTotalXp;
  return next !== null && progression.totalXp >= next ? progression.level + 1 : null;
}

/** Activity-slot button: "Level up ready · 70 Glimmer". Opens the paid confirm. */
export function LevelUpReadyButton({ glimmer, busy, onOpen }: Readonly<{
  glimmer: number;
  busy: boolean;
  onOpen(): void;
}>): React.JSX.Element {
  return (
    <button
      type="button"
      className="level-up-ready-button"
      disabled={busy}
      aria-busy={busy}
      onClick={onOpen}
    >
      <span>Level up ready</span>
      <small>{glimmer} Glimmer</small>
    </button>
  );
}
