import type { OnlinePlayerSummary } from "@ash-atlas/shared";

import { GameAppCard, GameAppShell } from "./GameAppShell.js";

export function OnlinePlayersPanel({
  open,
  layout,
  players,
  phoneBackLabel,
  onBack,
  onReturnToGame
}: Readonly<{
  open: boolean;
  layout: "desktop" | "phone";
  players: readonly OnlinePlayerSummary[];
  phoneBackLabel: string;
  onBack(): void;
  onReturnToGame(): void;
}>): React.JSX.Element | null {
  return (
    <GameAppShell
      open={open}
      layout={layout}
      title="Online Players"
      closeLabel="Close Online Players"
      className="online-players-shell"
      phoneBackLabel={phoneBackLabel}
      phoneOnBack={onBack}
      phoneOnReturnToGame={onReturnToGame}
      onClose={onBack}
    >
      <GameAppCard
        title="Realm"
        badge={String(players.length)}
      >
        {players.length > 0 ? (
          <ol className="online-players-list" aria-label="Players online">
            {players.map((player) => (
              <li key={player.playerId}>
                <span className="online-player-dot" aria-hidden="true" />
                <span>{player.displayName}</span>
              </li>
            ))}
          </ol>
        ) : (
          <p className="online-players-empty">No players are online right now.</p>
        )}
      </GameAppCard>
    </GameAppShell>
  );
}
