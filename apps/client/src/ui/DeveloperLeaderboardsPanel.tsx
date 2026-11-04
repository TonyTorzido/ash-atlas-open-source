import type {
  DeveloperLeaderboardMetric,
  DeveloperLeaderboardPlayer,
  DeveloperLeaderboardPlayerInspector,
  DeveloperLeaderboardPrivateRanking
} from "@ash-atlas/shared";
import { useEffect, useMemo, useState } from "react";

import { DeveloperLeaderboardClient } from "../leaderboards/developerLeaderboardClient.js";

type Props = {
  serverHttpBase: string;
};

export function DeveloperLeaderboardsPanel({
  serverHttpBase
}: Props): React.JSX.Element {
  const client = useMemo(
    () => new DeveloperLeaderboardClient(serverHttpBase),
    [serverHttpBase]
  );
  const [week, setWeek] = useState<"current" | "previous">("current");
  const [search, setSearch] = useState("");
  const [players, setPlayers] = useState<DeveloperLeaderboardPlayer[]>([]);
  const [selectedPlayerId, setSelectedPlayerId] = useState<string | null>(null);
  const [inspector, setInspector] =
    useState<DeveloperLeaderboardPlayerInspector | null>(null);
  const [ranking, setRanking] =
    useState<DeveloperLeaderboardPrivateRanking | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const privateMetricKey = inspector?.metrics.find(
    ({ visibility }) => visibility === "owner_only"
  )?.key ?? null;

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void client.search(search, controller.signal)
        .then(({ players: nextPlayers }) => {
          setPlayers(nextPlayers);
          setSelectedPlayerId((current) => current ?? nextPlayers[0]?.playerId ?? null);
        })
        .catch((reason: unknown) => {
          if (!controller.signal.aborted) setError(message(reason));
        });
    }, 300);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [client, search]);

  useEffect(() => {
    if (!selectedPlayerId) {
      setInspector(null);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    void client.inspect(selectedPlayerId, week, controller.signal)
      .then(setInspector)
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) setError(message(reason));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [client, refreshKey, selectedPlayerId, week]);

  useEffect(() => {
    if (!privateMetricKey) {
      setRanking(null);
      return;
    }
    const controller = new AbortController();
    void client.ranking(privateMetricKey, week, controller.signal)
      .then(setRanking)
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) setError(message(reason));
      });
    return () => controller.abort();
  }, [client, privateMetricKey, refreshKey, week]);

  useEffect(() => {
    const timer = window.setInterval(
      () => setRefreshKey((value) => value + 1),
      30_000
    );
    return () => window.clearInterval(timer);
  }, []);

  const publicMetrics = inspector?.metrics.filter(
    ({ visibility }) => visibility === "public"
  ) ?? [];
  const ownerMetrics = inspector?.metrics.filter(
    ({ visibility }) => visibility === "owner_only"
  ) ?? [];

  return (
    <section className="developer-leaderboards" aria-label="Leaderboard Inspector">
      <header className="developer-leaderboards-header">
        <div>
          <span className="eyebrow">Private read-only tools</span>
          <h3>Leaderboard Inspector</h3>
          <p className="muted">{inspector ? formatPeriod(inspector) : "Select a player to inspect weekly totals."}</p>
        </div>
        <button type="button" onClick={() => setRefreshKey((value) => value + 1)}>
          Refresh
        </button>
      </header>

      <div className="developer-leaderboard-week-tabs" role="group" aria-label="Leaderboard week">
        <button type="button" className={week === "current" ? "active" : undefined} onClick={() => setWeek("current")}>Current Week</button>
        <button type="button" className={week === "previous" ? "active" : undefined} onClick={() => setWeek("previous")}>Previous Week</button>
      </div>

      <div className="developer-leaderboard-layout">
        <aside className="developer-leaderboard-search">
          <label>
            Find player
            <input
              value={search}
              placeholder="Name or player ID"
              onChange={(event) => setSearch(event.currentTarget.value)}
            />
          </label>
          <div className="developer-leaderboard-search-results" role="listbox" aria-label="Players">
            {players.map((player) => (
              <button
                type="button"
                role="option"
                aria-selected={selectedPlayerId === player.playerId}
                className={selectedPlayerId === player.playerId ? "active" : undefined}
                key={player.playerId}
                onClick={() => setSelectedPlayerId(player.playerId)}
              >
                <strong>{player.displayName}</strong>
                <span>{player.playerId}</span>
                {!player.eligible ? <small>Not ranking eligible</small> : null}
              </button>
            ))}
            {players.length === 0 ? <p className="muted">No players found.</p> : null}
          </div>
        </aside>

        <div className="developer-leaderboard-inspector">
          {error ? <p className="dev-feedback" role="alert">{error}</p> : null}
          {loading && !inspector ? <p role="status">Loading leaderboard totals…</p> : null}
          {inspector ? (
            <>
              <div className="developer-leaderboard-player-title">
                <div><strong>{inspector.player.displayName}</strong><span>{inspector.player.playerId}</span></div>
                <span>{inspector.player.eligible ? "Ranking eligible" : "Excluded from rankings"}</span>
              </div>
              <MetricSection title="Public Leaderboards" metrics={publicMetrics} />
              <MetricSection title="Owner Metrics" metrics={ownerMetrics} privateSection />
              {ranking ? (
                <section className="developer-private-ranking" aria-label={`${ranking.metric.label} rankings`}>
                  <header><h4>{ranking.metric.label}</h4><span>Top 100</span></header>
                  <div className="developer-private-ranking-rows">
                    {ranking.entries.map((entry) => (
                      <button
                        type="button"
                        className={selectedPlayerId === entry.playerId ? "active" : undefined}
                        key={entry.playerId}
                        onClick={() => setSelectedPlayerId(entry.playerId)}
                      >
                        <strong>#{entry.rank}</strong>
                        <span>{entry.displayName}</span>
                        <b>{entry.value.toLocaleString()}</b>
                      </button>
                    ))}
                    {ranking.entries.length === 0 ? <p className="muted">No qualifying activity this week.</p> : null}
                  </div>
                </section>
              ) : null}
            </>
          ) : null}
        </div>
      </div>
    </section>
  );
}

function MetricSection({
  title,
  metrics,
  privateSection = false
}: {
  title: string;
  metrics: DeveloperLeaderboardMetric[];
  privateSection?: boolean;
}): React.JSX.Element | null {
  if (metrics.length === 0) return null;
  return (
    <section className={`developer-metric-section${privateSection ? " owner-metrics" : ""}`}>
      <header><h4>{title}</h4></header>
      <div className="developer-metric-grid">
        {metrics.map((metric) => (
          <article key={metric.key} className="developer-metric-card">
            <span>{metric.label}</span>
            <strong>{metric.value.toLocaleString()}</strong>
            <small>{metric.rank === null ? "Unranked" : `Rank #${metric.rank}`}</small>
            {metric.breakdown?.length ? (
              <dl>
                {metric.breakdown.map((part) => (
                  <div key={part.key}><dt>{part.label}</dt><dd>{part.value.toLocaleString()}</dd></div>
                ))}
              </dl>
            ) : null}
          </article>
        ))}
      </div>
    </section>
  );
}

function formatPeriod(inspector: DeveloperLeaderboardPlayerInspector): string {
  const start = new Date(inspector.period.weekStartAt);
  const end = new Date(new Date(inspector.period.nextWeekStart).getTime() - 1);
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: inspector.period.timezone,
    month: "short",
    day: "numeric",
    year: "numeric"
  });
  return `${formatter.format(start)} – ${formatter.format(end)} · Mountain Time`;
}

function message(reason: unknown): string {
  return reason instanceof Error ? reason.message : "Developer leaderboard request failed.";
}
