import type { ReactNode } from "react";
import "./RankLadder.css";

/**
 * Rank ladder rows: the one parchment/brass list for "what each rank gives" (Class rank effects,
 * profession ranks). Each row shows a state, so a player can read earned, current, next and
 * upcoming ranks at a glance. Documented in Developer App -> UI Standards ("Rank ladder").
 *
 * - earned: rank reached (brass plaque); the highest earned rank is `current` and says so.
 * - next: the rank being worked toward (solid brass edge).
 * - upcoming: later ranks (muted paper).
 * Render inside a section that owns the heading; this component is just the `<ol>`.
 */
export type RankLadderState = "earned" | "current" | "next" | "upcoming";

export type RankLadderLine = Readonly<{
  key: string;
  content: ReactNode;
  /** Effect not live yet: dimmed and tagged "Coming soon". */
  soon?: boolean;
}>;

export type RankLadderEntry = Readonly<{
  key: string | number;
  title: string;
  state: RankLadderState;
  /** Right-aligned detail: SP cost, XP threshold. */
  meta?: string;
  /** Milestone tier label (for example "Tier I"). */
  badge?: string;
  /** Milestone rank number, exposed as data-milestone. */
  milestone?: number;
  /** Name of what the rank grants. */
  name?: string;
  lines?: readonly RankLadderLine[];
  note?: string;
}>;

const STATE_LABEL: Readonly<Record<RankLadderState, string>> = { earned: "Earned", current: "Current", next: "Next", upcoming: "Upcoming" };

export function RankLadder({ entries, className = "", label }: Readonly<{ entries: readonly RankLadderEntry[]; className?: string; label?: string }>): React.JSX.Element {
  return <ol className={`rank-ladder ${className}`.trim()} {...(label ? { "aria-label": label } : {})}>
    {entries.map((entry) => <li
      key={entry.key}
      className="rank-ladder-row"
      data-state={entry.state}
      data-earned={entry.state === "earned" || entry.state === "current"}
      data-next={entry.state === "next"}
      data-milestone={entry.milestone}
    >
      <header>
        <strong>{entry.title}</strong>
        {entry.badge ? <span className="rank-ladder-badge">{entry.badge}</span> : null}
        <span className="rank-ladder-state">{STATE_LABEL[entry.state]}</span>
        {entry.meta ? <small>{entry.meta}</small> : null}
      </header>
      {entry.name ? <h4>{entry.name}</h4> : null}
      {entry.lines?.length ? <ul>
        {entry.lines.map((line) => <li key={line.key} data-live={!line.soon}>{line.content}{line.soon ? <em className="skill-v3-soon">Coming soon</em> : null}</li>)}
      </ul> : null}
      {entry.note ? <small className="rank-ladder-note">{entry.note}</small> : null}
    </li>)}
  </ol>;
}
