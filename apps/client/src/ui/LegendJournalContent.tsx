import {
  LEGEND_CATALOG,
  LEGEND_CATEGORIES,
  LEGEND_DIFFICULTIES,
  legendObjectiveValue,
  legendPrestige,
  legendProgress,
  type AchievementSnapshot,
  type LegendDefinition,
  type LegendJournalSnapshot
} from "@ash-atlas/shared";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { LEGEND_PIN_LIMIT, loadLegendJournal, mergeLiveAchievements, readLegendPins, saveLegendPins } from "../legends/legendJournalClient.js";
import { GameAppActionBar, GameAppCard } from "./GameAppShell.js";
import { ProgressionStrip } from "./ProgressionDetailHeader.js";
import { ProgressionDetailSheet, useRetainedSheet } from "./ProgressionDetailSheet.js";
import "./LegendJournalContent.css";

const REFRESH_MS = 30_000;
const REQUEST_TIMEOUT_MS = 15_000;
const PAGE_SIZE = 12;
const catalogIds = new Set(LEGEND_CATALOG.map((entry) => entry.id));
const catalogById = new Map(LEGEND_CATALOG.map((entry) => [entry.id, entry]));
type JournalStatus = "all" | "in-progress" | "completed" | "locked";

export function LegendJournalContent({ serverHttpBase, playerId, achievements, layout, onBackChange }: Readonly<{
  serverHttpBase: string;
  playerId?: string;
  achievements: AchievementSnapshot | null;
  layout?: "desktop" | "phone";
  onBackChange?(override: JournalBackOverride | null): void;
}>): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<LegendJournalSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [visible, setVisible] = useState(document.visibilityState !== "hidden");
  const refresh = useRef<() => void>(() => {});

  useEffect(() => {
    let disposed = false;
    let controller: AbortController | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let reconcilePending = false;

    const load = async (): Promise<void> => {
      if (disposed || document.visibilityState === "hidden") return;
      if (controller) return;
      clearTimeout(timer);
      const request = new AbortController();
      controller = request;
      setLoading(true);
      let timedOut = false;
      const timeout = setTimeout(() => { timedOut = true; request.abort(); }, REQUEST_TIMEOUT_MS);
      try {
        const next = await loadLegendJournal(serverHttpBase, request.signal);
        if (disposed || request.signal.aborted) return;
        if (playerId && next.playerId !== playerId) {
          setSnapshot(null);
          throw new Error("Your character changed. Reconnect to reload this journal.");
        }
        setSnapshot((previous) => mergeLiveAchievements(next, null, previous));
        setError(null);
      } catch (cause) {
        if (!disposed && (!request.signal.aborted || timedOut)) {
          setError(timedOut ? "The journal took too long to respond. Try again."
            : cause instanceof Error ? cause.message : "The journal could not be refreshed.");
        }
      } finally {
        clearTimeout(timeout);
        controller = null;
        if (!disposed) {
          setLoading(false);
          if (!document.hidden) {
            if (reconcilePending) {
              reconcilePending = false;
              void load();
            } else {
              timer = setTimeout(() => void load(), REFRESH_MS);
            }
          }
        }
      }
    };

    const reconcile = (): void => {
      const nowVisible = document.visibilityState !== "hidden";
      setVisible(nowVisible);
      clearTimeout(timer);
      if (!nowVisible) return;
      if (controller) reconcilePending = true;
      else void load();
    };
    refresh.current = () => { void load(); };
    void load();
    document.addEventListener("visibilitychange", reconcile);
    window.addEventListener("online", reconcile);
    return () => {
      disposed = true;
      clearTimeout(timer);
      controller?.abort();
      refresh.current = () => {};
      document.removeEventListener("visibilitychange", reconcile);
      window.removeEventListener("online", reconcile);
    };
  }, [serverHttpBase, playerId]);

  useEffect(() => {
    setSnapshot((current) => current ? mergeLiveAchievements(current, achievements) : current);
  }, [achievements, snapshot?.playerId]);

  const status = <div className="legend-journal-sync">
    <div>
      {error ? <p role="alert">{error} {snapshot ? "Showing last confirmed progress." : ""}</p>
        : <p role="status">{loading ? snapshot ? "Refreshing progress…" : "Loading your journal…"
          : !visible ? "Updates paused while this window is hidden."
          : snapshot ? "Progress saved · updated " + formatTime(snapshot.serverTime) : "Waiting for journal progress."}</p>}
      {snapshot && error ? <small>Last confirmed {formatTime(snapshot.serverTime)}</small> : null}
    </div>
    <GameAppActionBar>
      <button type="button" disabled={loading || !visible} onClick={() => refresh.current()}>
        {loading ? "Refreshing…" : error ? "Retry" : "Refresh"}
      </button>
    </GameAppActionBar>
  </div>;

  return snapshot
    ? <LegendJournalView key={snapshot.playerId} snapshot={mergeLiveAchievements(snapshot, achievements)} syncStatus={status}
      {...(layout ? { layout } : {})} {...(onBackChange ? { onBackChange } : {})} />
    : <div className="legend-journal"><div className="legend-journal-scroll">
      <GameAppCard title="Atlas Legends" badge={error ? "Unavailable" : "Loading"}>{status}</GameAppCard>
    </div></div>;
}

export type JournalBackOverride = Readonly<{ label: string; onBack(): void }>;
const QUESTS_SECTION = "Quest journeys";

export function LegendJournalView({ snapshot, syncStatus, layout = "phone", onBackChange }: Readonly<{
  snapshot: LegendJournalSnapshot;
  syncStatus?: ReactNode;
  layout?: "desktop" | "phone";
  onBackChange?(override: JournalBackOverride | null): void;
}>): React.JSX.Element {
  /** null = journal overview; otherwise an achievement category or the quest journeys. */
  const [section, setSection] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [difficulty, setDifficulty] = useState("all");
  const [status, setStatus] = useState<JournalStatus>("all");
  const [page, setPage] = useState(1);
  const [pins, setPins] = useState(() => readLegendPins(snapshot.playerId, catalogIds));
  const [pinNotice, setPinNotice] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const prestige = legendPrestige(LEGEND_CATALOG, snapshot.completed);
  const completed = LEGEND_CATALOG.filter((entry) => snapshot.completed[entry.id]);
  const pinned = pins.map((id) => catalogById.get(id)).filter((entry): entry is LegendDefinition => !!entry);
  const earnedHonors = completed.filter((entry) => entry.honor).sort((a, b) =>
    (snapshot.completed[b.id] ?? "").localeCompare(snapshot.completed[a.id] ?? ""));
  const newlyCompleted = snapshot.newlyCompletedIds.map((id) => catalogById.get(id)).filter((entry): entry is LegendDefinition => !!entry && entry.completionAuthority !== "gameplay");
  const nextGoals = LEGEND_CATALOG.filter((entry) => !snapshot.completed[entry.id]
    && !isLocked(entry, snapshot) && !pins.includes(entry.id))
    .sort((a, b) => legendProgress(b, snapshot.metrics) - legendProgress(a, snapshot.metrics)).slice(0, 3);
  const sections = [
    ...LEGEND_CATEGORIES.map((category) => ({ id: category as string, entries: LEGEND_CATALOG.filter((entry) => entry.kind === "achievement" && entry.category === category) })),
    { id: QUESTS_SECTION, entries: LEGEND_CATALOG.filter((entry) => entry.kind === "quest") }
  ].filter((item) => item.entries.length > 0);
  const scoped = section === null ? LEGEND_CATALOG : sections.find((item) => item.id === section)?.entries ?? [];
  const search = query.trim().toLocaleLowerCase();
  const filtersActive = search !== "" || difficulty !== "all" || status !== "all";
  const filtered = scoped.filter((entry) => {
    if (difficulty !== "all" && entry.difficulty !== difficulty) return false;
    if (status === "completed" && !snapshot.completed[entry.id]) return false;
    if (status === "locked" && !isLocked(entry, snapshot)) return false;
    if (status === "in-progress" && (snapshot.completed[entry.id] || isLocked(entry, snapshot))) return false;
    return !search || [entry.title, entry.description, entry.category, entry.difficulty, entry.honor, entry.reward,
      entry.journey?.title, ...entry.objectives.map((objective) => objective.label + " " + objective.hint)]
      .filter(Boolean).join(" ").toLocaleLowerCase().includes(search);
  });
  const selected = selectedId ? catalogById.get(selectedId) ?? null : null;

  const clearFilters = (): void => { setQuery(""); setDifficulty("all"); setStatus("all"); setPage(1); };
  const openSection = (id: string | null): void => {
    setSection(id); setSelectedId(null); clearFilters();
    scrollRef.current?.scrollTo?.({ top: 0 });
  };
  const togglePin = (entry: LegendDefinition): void => {
    const wasPinned = pins.includes(entry.id);
    if (!wasPinned && pins.length >= LEGEND_PIN_LIMIT) return;
    const next = wasPinned ? pins.filter((id) => id !== entry.id) : [...pins, entry.id];
    setPins(next);
    const saved = saveLegendPins(snapshot.playerId, next);
    setPinNotice((wasPinned ? "Unpinned " : "Pinned ") + entry.title + "."
      + (saved ? "" : " Browser storage is unavailable; this change lasts until you close the journal."));
  };

  const backOverride = selectedId !== null
    ? { label: section ? "Back to " + section : "Back to Achievements", onBack: () => setSelectedId(null) }
    : section !== null ? { label: "Back to Achievements", onBack: () => openSection(null) } : null;
  const backKey = backOverride?.label ?? "";
  useEffect(() => {
    onBackChange?.(backOverride);
    return () => onBackChange?.(null);
    // The override closes over the latest state; re-publish only when its destination changes.
  }, [backKey, onBackChange]);

  const records = (entries: readonly LegendDefinition[]): ReactNode => <div className="legend-journal-records">
    {entries.map((entry) => <LegendJournalRecord key={entry.id} entry={entry} snapshot={snapshot}
      pinned={pins.includes(entry.id)} selected={entry.id === selectedId} onOpen={() => setSelectedId(entry.id)} />)}
  </div>;
  const list = <section className="legend-journal-list" aria-label={section ?? "Search results"}>
    <header><h3 className="skill-v3-section-title">{section === null ? "Search results" : section === QUESTS_SECTION ? "Chapters" : "Goals"}</h3>
      <small>{filtered.length ? Math.min(page * PAGE_SIZE, filtered.length) + " of " + filtered.length : "None"}</small></header>
    {filtered.length ? records(filtered.slice(0, page * PAGE_SIZE))
      : <div className="legend-journal-empty"><p>No goals match these filters.</p>
        <GameAppActionBar><button type="button" onClick={clearFilters}>Clear filters</button></GameAppActionBar></div>}
    {filtered.length > page * PAGE_SIZE ? <GameAppActionBar><button type="button" onClick={() => setPage((value) => value + 1)}>Show 12 more</button></GameAppActionBar> : null}
  </section>;
  const scopedDone = scoped.filter((entry) => snapshot.completed[entry.id]).length;

  const shownSheet = useRetainedSheet(selected ? selected.id : null, selected ? <LegendJournalDetail entry={selected} snapshot={snapshot} pinned={pins.includes(selected.id)}
    pinLimitReached={pins.length >= LEGEND_PIN_LIMIT} onTogglePin={() => togglePin(selected)} /> : null);
  return <section className={`legend-journal${shownSheet ? " has-sheet" : ""}`} data-layout={layout} aria-label="Atlas Legends journal">
    <ProgressionStrip label="Journal status" left={<><span className="skill-v3-available"><strong>{prestige.points.toLocaleString()}</strong> prestige</span></>} right={<><strong>{completed.length}</strong> / {LEGEND_CATALOG.length} goals</>} />
    <div className="legend-journal-scroll" ref={scrollRef}>
      {pinNotice ? <p className="legend-journal-notice" role="status">{pinNotice}</p> : null}
      {newlyCompleted.length ? <p className="legend-journal-notice" role="status">Newly recorded: {newlyCompleted.slice(0, 2).map((entry) => entry.title).join(", ")}{newlyCompleted.length > 2 ? " and " + (newlyCompleted.length - 2) + " more" : ""}.</p> : null}
      {section === null ? <GameAppCard title={prestige.rank.title} badge={prestige.points.toLocaleString() + " prestige"}
        description="Each goal completes once. Higher tiers are separate fixed goals, and quest journeys have three chapters.">
        <div className="legend-journal-overview">
          <dl className="legend-journal-totals">
            <div><dt>Achievements</dt><dd>{completed.filter((entry) => entry.kind === "achievement").length}
              <small> / {LEGEND_CATALOG.filter((entry) => entry.kind === "achievement").length}</small></dd></div>
            <div><dt>Quest chapters</dt><dd>{completed.filter((entry) => entry.kind === "quest").length}
              <small> / {LEGEND_CATALOG.filter((entry) => entry.kind === "quest").length}</small></dd></div>
            <div><dt>Journal honors</dt><dd>{earnedHonors.length}
              <small> / {LEGEND_CATALOG.filter((entry) => entry.honor).length}</small></dd></div>
          </dl>
          {prestige.nextRank ? <div className="legend-journal-next-rank">
            <p><strong>Next: {prestige.nextRank.title}</strong><span>{(prestige.nextRank.points - prestige.points).toLocaleString()} prestige to go</span></p>
            <JournalProgress label="Prestige toward next rank" value={prestige.points - prestige.rank.points}
              target={prestige.nextRank.points - prestige.rank.points} />
          </div> : <p className="legend-journal-copy">Living Legend · Highest journal rank earned.</p>}
          {earnedHonors.length ? <ul className="legend-journal-honors" aria-label="Journal honors">{earnedHonors.map((entry) =>
            <li key={entry.id} title={entry.title}>{entry.honor}</li>)}</ul> : null}
          {syncStatus}
        </div>
      </GameAppCard> : <header className="legend-journal-section-header">
        <h3>{section}</h3>
        <span>{scopedDone} / {scoped.length} complete</span>
        <JournalProgress label={section + " progress"} value={scopedDone} target={scoped.length} />
      </header>}
      <div className="legend-journal-filters" role="search" aria-label={section === null ? "Search the journal" : "Filter " + section}>
        <label className="legend-journal-search"><span className="sr-only">Search journal</span><input type="search" value={query} aria-label="Search journal"
          placeholder={section === null ? "Search every goal: name, creature, resource, or honor" : "Search " + section}
          onChange={(event) => { setQuery(event.currentTarget.value); setPage(1); }} /></label>
        <label><span className="sr-only">Difficulty</span><select value={difficulty} aria-label="Difficulty" onChange={(event) => { setDifficulty(event.currentTarget.value); setPage(1); }}>
          <option value="all">Any difficulty</option>{LEGEND_DIFFICULTIES.map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
        <label><span className="sr-only">Status</span><select value={status} aria-label="Status" onChange={(event) => { setStatus(event.currentTarget.value as JournalStatus); setPage(1); }}>
          <option value="all">Any status</option><option value="in-progress">In progress</option>
          <option value="completed">Completed</option><option value="locked">Locked</option></select></label>
        {filtersActive ? <button type="button" className="legend-journal-clear" onClick={clearFilters}>Clear</button> : null}
      </div>
      {section !== null || filtersActive ? list : <>
        <section className="legend-journal-list" aria-label="Pinned goals">
          <header><h3 className="skill-v3-section-title">Pinned</h3><small>{pins.length} / {LEGEND_PIN_LIMIT}</small></header>
          {pinned.length ? records(pinned) : <p className="legend-journal-copy">No pinned goals yet. Open a goal and pin it to follow it here.</p>}
        </section>
        {nextGoals.length ? <section className="legend-journal-list" aria-label="Within reach">
          <header><h3 className="skill-v3-section-title">Within reach</h3></header>
          {records(nextGoals)}
        </section> : null}
        <section className="legend-journal-list" aria-label="Journal categories">
          <header><h3 className="skill-v3-section-title">Categories</h3></header>
          <div className="legend-journal-category-grid">{sections.map((item) => {
            const done = item.entries.filter((entry) => snapshot.completed[entry.id]).length;
            const percent = Math.round((done / item.entries.length) * 100);
            return <button key={item.id} type="button" className="legend-journal-category" data-section={item.id}
              aria-label={`${item.id}, ${done} of ${item.entries.length} complete`} onClick={() => openSection(item.id)}>
              <strong>{item.id}</strong>
              <small>{done} / {item.entries.length} complete</small>
              <span className="achievement-progress" aria-hidden="true"><span style={{ width: percent + "%" }} /></span>
            </button>;
          })}</div>
        </section>
      </>}
    </div>
    {shownSheet ? <ProgressionDetailSheet key={shownSheet.key} layout={layout} closing={shownSheet.closing} onClose={() => setSelectedId(null)}>{shownSheet.node}</ProgressionDetailSheet> : null}
  </section>;
}

function isLocked(entry: LegendDefinition, snapshot: LegendJournalSnapshot): boolean {
  return !snapshot.completed[entry.id] && !!entry.requires?.some((id) => !snapshot.completed[id]);
}

function goalState(entry: LegendDefinition, snapshot: LegendJournalSnapshot): Readonly<{ key: string; label: string; percent: number }> {
  const complete = !!snapshot.completed[entry.id];
  const locked = isLocked(entry, snapshot);
  const percent = Math.round(legendProgress(entry, snapshot.metrics) * 100);
  return {
    key: complete ? "completed" : locked ? "locked" : "in-progress",
    label: complete ? "Completed" : locked ? "Locked" : percent >= 100 ? "Awaiting confirmation" : percent + "%",
    percent: complete ? 100 : percent
  };
}

/** Compact goal row; the full objectives, reward and pin action open in the detail sheet. */
function LegendJournalRecord({ entry, snapshot, pinned, selected, onOpen }: Readonly<{
  entry: LegendDefinition;
  snapshot: LegendJournalSnapshot;
  pinned: boolean;
  selected: boolean;
  onOpen(): void;
}>): React.JSX.Element {
  const state = goalState(entry, snapshot);
  return <div className="legend-journal-record" data-legend-id={entry.id} data-state={state.key} data-selected={selected}>
    <button type="button" className="legend-journal-record-open" onClick={onOpen} aria-label={`${entry.title}, ${state.label}${pinned ? ", pinned" : ""}, open details`}>
      <span className="legend-journal-record-heading">
        <strong>{pinned ? "★ " : ""}{entry.title}</strong>
        <span className="legend-journal-tags">
          <span className="legend-journal-tag" data-difficulty={entry.difficulty}>{entry.difficulty}</span>
          <small>{entry.journey ? <>{entry.journey.title} · <span className="legend-journal-chapter-number">Chapter {entry.journey.chapter} / {entry.journey.chapters}</span></> : entry.category} · {entry.points} prestige</small>
        </span>
      </span>
      <span className="legend-journal-record-state">{state.label}</span>
    </button>
    <JournalProgress label={entry.title + " progress"} value={state.percent} target={100} />
  </div>;
}

function LegendJournalDetail({ entry, snapshot, pinned, pinLimitReached, onTogglePin }: Readonly<{
  entry: LegendDefinition;
  snapshot: LegendJournalSnapshot;
  pinned: boolean;
  pinLimitReached: boolean;
  onTogglePin(): void;
}>): React.JSX.Element {
  const complete = !!snapshot.completed[entry.id];
  const locked = isLocked(entry, snapshot);
  const state = goalState(entry, snapshot);
  const missing = entry.requires?.filter((id) => !snapshot.completed[id]) ?? [];
  return <aside className="skill-v3-detail legend-journal-detail" aria-label={entry.title + " details"}>
    <header><div className="skill-v3-detail-heading"><div className="skill-v3-detail-identity"><span>{entry.kind === "quest" ? "Quest chapter" : entry.category}</span><h3>{entry.title}</h3></div>
      <div className="skill-v3-detail-state"><strong>{complete ? "Completed" : locked ? "Locked" : "In progress"}</strong><small>{entry.difficulty} · {entry.points} prestige</small></div></div></header>
    {entry.journey ? <p className="legend-journal-copy">{entry.journey.title} · Chapter {entry.journey.chapter} / {entry.journey.chapters}</p> : null}
    <p className="legend-journal-copy">{entry.description}</p>
    {locked ? <p className="legend-journal-lock"><strong>Chapter locked.</strong> Complete {missing.map((id) => catalogById.get(id)?.title ?? id).join(" and ")} first. Recorded progress is kept.</p> : null}
    <ul className="legend-journal-objectives">{entry.objectives.map((objective) => {
      const value = legendObjectiveValue(snapshot.metrics, objective.metric);
      return <li key={objective.metric + objective.target}>
        <div><strong>{objective.label}</strong><span>{Math.min(value, objective.target).toLocaleString()} / {objective.target.toLocaleString()}</span></div>
        <JournalProgress label={entry.title + ": " + objective.label} value={value} target={objective.target} />
        <small>{objective.hint}</small>
      </li>;
    })}</ul>
    {entry.reward ? <p className="legend-journal-copy"><strong>Reward: </strong>{entry.reward}</p> : null}
    {entry.honor ? <p className="legend-journal-copy"><strong>Journal honor: {entry.honor}</strong>{complete ? " · Earned" : " · Complete this goal to collect"}</p> : null}
    {complete ? <p className="legend-journal-copy">Completed {formatDate(snapshot.completed[entry.id]!)}</p> : !locked ? <p className="legend-journal-copy">{state.percent}% of objectives</p> : null}
    <div className="skill-v3-actions">
      <GameAppActionBar><button type="button" aria-pressed={pinned} disabled={!pinned && pinLimitReached}
        aria-label={(pinned ? "Unpin " : "Pin ") + entry.title}
        onClick={onTogglePin}>{pinned ? "Unpin goal" : "Pin goal"}</button></GameAppActionBar>
      {!pinned && pinLimitReached ? <small>Three goals pinned. Unpin a goal to make room.</small> : null}
    </div>
  </aside>;
}

export function JournalProgress({ label, value, target }: Readonly<{ label: string; value: number; target: number }>): React.JSX.Element {
  const percent = Number.isFinite(value) && target > 0 ? Math.round(Math.min(1, Math.max(0, value / target)) * 100) : 0;
  return <div className="achievement-progress" role="progressbar" aria-label={label}
    aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}><span style={{ width: percent + "%" }} /></div>;
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "previously" : new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(date);
}
function formatTime(value: number): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "previously" : new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(date);
}
