import {
  WEEKLY_LEADERBOARD_CATEGORY_DEFINITIONS,
  type WeeklyLeaderboardCategory,
  type WeeklyLeaderboardEntry,
  type WeeklyLeaderboardSnapshot,
  type FishingRecordSnapshot,
  type FishingStateSnapshot
} from "@ash-atlas/shared";
import { useEffect, useMemo, useRef, useState } from "react";

import { WeeklyLeaderboardClient } from "../leaderboards/weeklyLeaderboardClient.js";
import { DestinationShell } from "./DestinationShell.js";
import { GameAppTabs } from "./GameAppShell.js";
import { FishingRecordsCards } from "./FishingPrompt.js";
import type { PlayerActionsTarget } from "./PlayerActionsSurface.js";

type Props = {
  open: boolean;
  layout: "desktop" | "phone";
  serverHttpBase: string;
  ownPlayerId: string;
  connected: boolean;
  onClose(): void;
  onOpenPlayer(
    playerId: string,
    displayName: string,
    anchorRect: PlayerActionsTarget["anchorRect"]
  ): void;
  fishingRecords?: FishingRecordSnapshot | null;
  fishingRecordsState?: FishingStateSnapshot | null;
  fishingRecordsBusy?: boolean;
  /** Retained for callers that still track a selected hut; records are now universal. */
  fishingHutSelected?: boolean;
  onRequestFishingRecords?(): void;
};

const CATEGORY_BY_KEY = new Map(
  WEEKLY_LEADERBOARD_CATEGORY_DEFINITIONS.map((definition) => [
    definition.key,
    definition
  ] as const)
);
const OVERALL = WEEKLY_LEADERBOARD_CATEGORY_DEFINITIONS
  .filter(({ group }) => group === "overall")
  .map(({ key }) => key);
const HUNTING = WEEKLY_LEADERBOARD_CATEGORY_DEFINITIONS
  .filter(({ group }) => group === "hunting")
  .map(({ key }) => key);
type LeaderboardGroup = "overall" | "hunting";

export function WeeklyLeaderboardsPanel(props: Props): React.JSX.Element | null {
  const client = useMemo(
    () => new WeeklyLeaderboardClient(props.serverHttpBase),
    [props.serverHttpBase]
  );
  const [week, setWeek] = useState<"current" | "previous">("current");
  const [view, setView] = useState<"weekly" | "fishing">("weekly");
  const [group, setGroup] = useState<LeaderboardGroup>("overall");
  const [category, setCategory] = useState<WeeklyLeaderboardCategory>("flags_built");
  const [snapshot, setSnapshot] = useState<WeeklyLeaderboardSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [remaining, setRemaining] = useState(0);
  const receivedAt = useRef(0);
  const visibleSnapshot = snapshot?.archived === (week === "previous")
    ? snapshot
    : null;

  useEffect(() => {
    if (!props.open || view !== "weekly") return;
    if (!props.connected) {
      setError("Reconnect to load the weekly leaderboards.");
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    void client.load(week, controller.signal)
      .then((next) => {
        setSnapshot(next);
        setRemaining(next.remainingSeconds);
        receivedAt.current = performance.now();
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) {
          setError(reason instanceof Error ? reason.message : "Weekly leaderboards could not be loaded.");
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [client, props.connected, props.open, refreshKey, view, week]);

  useEffect(() => {
    if (!props.open || week !== "current" || !visibleSnapshot) return;
    const update = (): void => {
      const elapsed = Math.floor((performance.now() - receivedAt.current) / 1_000);
      setRemaining(Math.max(0, visibleSnapshot.remainingSeconds - elapsed));
    };
    update();
    const timer = window.setInterval(update, 1_000);
    return () => window.clearInterval(timer);
  }, [props.open, visibleSnapshot, week]);

  useEffect(() => {
    if (!props.open || !props.connected) return;
    const timer = window.setInterval(() => setRefreshKey((value) => value + 1), 60_000);
    return () => window.clearInterval(timer);
  }, [props.connected, props.open]);

  if (!props.open) return null;
  const board = visibleSnapshot?.boards.find(
    (candidate) => candidate.category === category
  ) ?? null;
  const topPlayerIds = new Set(board?.top.map(({ playerId }) => playerId) ?? []);
  const pinned = board !== null &&
    board.personal.rank !== null &&
    board.personal.rank > 100 &&
    !topPlayerIds.has(props.ownPlayerId);
  const periodContext = week === "current"
    ? "Current week"
    : visibleSnapshot
      ? `Week of ${visibleSnapshot.weekStart}`
      : "Previous week";
  const rankedPlayerCount = board?.top.length ?? 0;
  const showFishingRecords = view === "fishing";

  return (
    <DestinationShell
      open
      layout={props.layout}
      menuId="leaderboards"
      title="Rankings"
      headerStatus={!showFishingRecords && board?.personal.rank != null ? { value: `#${board.personal.rank}`, label: "Your rank" } : null}
      subtitle={showFishingRecords
        ? "Fishing records and notable catches"
        : week === "current"
        ? "Resets Sunday at 11:59 PM Mountain Time"
        : `Archived week of ${visibleSnapshot?.weekStart ?? "the previous Monday"}`}
      closeLabel="Close weekly leaderboards"
      className="weekly-leaderboards-shell"
      onClose={props.onClose}
    >
      <div className="weekly-leaderboards-view-rail">
        <GameAppTabs
          variant="housed"
          tabs={[
            { id: "weekly", label: "Weekly Leaderboards" },
            { id: "fishing", label: "Fishing Records" }
          ]}
          activeTab={view}
          ariaLabel="Rankings views"
          onChange={(next) => {
            const nextView = next as "weekly" | "fishing";
            setView(nextView);
            if (nextView === "fishing") props.onRequestFishingRecords?.();
          }}
        />
      </div>

      {showFishingRecords ? (
        <>
          {!props.connected ? <div className="weekly-leaderboards-notice" role="status">
            Reconnect to load fishing records.
          </div> : null}
          {props.connected ? <FishingRecordsCards
            records={props.fishingRecords ?? null}
            state={props.fishingRecordsState ?? null}
            busy={props.fishingRecordsBusy ?? false}
            onRecords={() => props.onRequestFishingRecords?.()}
          /> : null}
        </>
      ) : <>
      <div className="weekly-leaderboards-period-rail">
        <GameAppTabs
          variant="subtabs"
          tabs={[
            { id: "current", label: "Current Week" },
            { id: "previous", label: "Previous Week" }
          ]}
          activeTab={week}
          ariaLabel="Leaderboard week"
          onChange={(next) => setWeek(next as "current" | "previous")}
        />
      </div>

      {!props.connected ? (
        <div className="weekly-leaderboards-notice" role="status">
          Reconnecting… Rankings may be up to one minute old.
        </div>
      ) : null}
      {error ? (
        <div className="weekly-leaderboards-error" role="alert">
          <p>{error}</p>
          <button type="button" className="game-app-button game-app-button-compact" onClick={() => setRefreshKey((value) => value + 1)}>Try Again</button>
        </div>
      ) : null}

      <LeaderboardSelector
        group={group}
        category={category}
        week={week}
        remaining={remaining}
        onSelectGroup={(nextGroup) => {
          setGroup(nextGroup);
          setCategory((nextGroup === "overall" ? OVERALL : HUNTING)[0] ?? "flags_built");
        }}
        onSelectCategory={setCategory}
      />

      <section className="weekly-leaderboard-board" aria-label={categoryLabel(category)}>
        <header>
          <div>
            <h2>{categoryLabel(category)}</h2>
            <small>
              {loading && !visibleSnapshot
                ? `${periodContext} · Loading ranked players…`
                : `${periodContext} · ${rankedPlayerCount} ranked ${rankedPlayerCount === 1 ? "player" : "players"} shown`}
            </small>
          </div>
          {loading && visibleSnapshot ? <small role="status">Refreshing…</small> : null}
        </header>
        {loading && !visibleSnapshot ? (
          <div className="weekly-leaderboards-state" role="status">Loading weekly rankings…</div>
        ) : board?.top.length ? (
          <div className="weekly-leaderboard-rows" role="table" aria-label={`${categoryLabel(category)} rankings`}>
            <div className="weekly-leaderboard-heading" role="row">
              <span role="columnheader">Rank</span>
              <span role="columnheader">Player</span>
              <span role="columnheader">Weekly Value</span>
            </div>
            {board.top.map((entry) => (
              <LeaderboardRow
                key={entry.playerId}
                entry={entry}
                category={category}
                own={entry.playerId === props.ownPlayerId}
                onOpenPlayer={props.onOpenPlayer}
              />
            ))}
          </div>
        ) : (
          <div className="weekly-leaderboards-state">
            No one has recorded {categoryLabel(category).toLowerCase()} for this leaderboard period.
          </div>
        )}
      </section>

      {pinned && board ? (
        <button
          type="button"
          className="weekly-leaderboard-personal"
          onClick={(event) => {
            const ownEntry = board.personal.nearby.find(
              ({ playerId }) => playerId === props.ownPlayerId
            );
            if (ownEntry) {
              props.onOpenPlayer(
                ownEntry.playerId,
                ownEntry.displayName,
                event.currentTarget.getBoundingClientRect()
              );
            }
          }}
        >
          <strong>You</strong>
          <span>#{board.personal.rank}</span>
          <span>{board.personal.value.toLocaleString()} {categoryLabel(category)}</span>
        </button>
      ) : null}
      </>}
    </DestinationShell>
  );
}

function LeaderboardSelector({
  group,
  category,
  week,
  remaining,
  onSelectGroup,
  onSelectCategory
}: {
  group: LeaderboardGroup;
  category: WeeklyLeaderboardCategory;
  week: "current" | "previous";
  remaining: number;
  onSelectGroup(group: LeaderboardGroup): void;
  onSelectCategory(category: WeeklyLeaderboardCategory): void;
}): React.JSX.Element {
  const categories = group === "overall" ? OVERALL : HUNTING;
  return (
    <section className="weekly-leaderboard-selector" aria-label="Choose leaderboard">
      <header>
        <h2>Choose Leaderboard</h2>
        <span className="weekly-leaderboards-remaining">
          {week === "current" ? `${formatRemaining(remaining)} remaining` : "Archived"}
        </span>
      </header>
      <div className="weekly-leaderboard-selector-level">
        <span>Category</span>
        <div role="group" aria-label="Leaderboard category">
          <button
            type="button"
            className="game-app-button game-app-button-compact"
            aria-pressed={group === "overall"}
            onClick={() => onSelectGroup("overall")}
          >Overall</button>
          <button
            type="button"
            className="game-app-button game-app-button-compact"
            aria-pressed={group === "hunting"}
            onClick={() => onSelectGroup("hunting")}
          >Hunting</button>
        </div>
      </div>
      <div className="weekly-leaderboard-selector-level">
        <span>Leaderboard</span>
        <div role="group" aria-label={`${group === "overall" ? "Overall" : "Hunting"} leaderboards`}>
          {categories.map((metric) => (
            <button
              key={metric}
              type="button"
              className="game-app-button game-app-button-compact"
              aria-pressed={category === metric}
              onClick={() => onSelectCategory(metric)}
            >{categoryLabel(metric)}</button>
          ))}
        </div>
      </div>
    </section>
  );
}

function LeaderboardRow({
  entry,
  category,
  own,
  onOpenPlayer
}: {
  entry: WeeklyLeaderboardEntry;
  category: WeeklyLeaderboardCategory;
  own: boolean;
  onOpenPlayer: Props["onOpenPlayer"];
}): React.JSX.Element {
  return (
    <button
      type="button"
      role="row"
      className={`weekly-leaderboard-row${own ? " own-player" : ""}${entry.rank <= 3 ? ` podium podium-${entry.rank}` : ""}`}
      onClick={(event) => onOpenPlayer(
        entry.playerId,
        entry.displayName,
        event.currentTarget.getBoundingClientRect()
      )}
    >
      <span role="cell">#{entry.rank}</span>
      <span role="cell">{own ? `${entry.displayName} (You)` : entry.displayName}</span>
      <strong role="cell">{entry.value.toLocaleString()} <small>{categoryLabel(category)}</small></strong>
    </button>
  );
}

function categoryLabel(category: WeeklyLeaderboardCategory): string {
  return CATEGORY_BY_KEY.get(category)?.label ?? category;
}

export function formatRemaining(totalSeconds: number): string {
  const safe = Math.max(0, Math.floor(totalSeconds));
  const days = Math.floor(safe / 86_400);
  const hours = Math.floor((safe % 86_400) / 3_600);
  const minutes = Math.floor((safe % 3_600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}
