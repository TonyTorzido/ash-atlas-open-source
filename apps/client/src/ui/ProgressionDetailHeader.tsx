/** Shared header for every Progression detail sheet (Class, Skills, Knowledge, Trades). Styles live in SkillTreeV3Panel.css. */
export type DetailSpend = Readonly<{ label: string; cost: number | null; ariaLabel: string; disabled: boolean; describedBy?: string | undefined; onClick(): void }>;

/** One header for every Progression sheet: icon | eyebrow, name, state | spend plaque, then the single blocking reason. */
export function DetailHeader({ icon, eyebrow, name, state, meta, spend, reason, reasonId, className }: Readonly<{ className?: string | undefined; icon: React.ReactNode; eyebrow?: string | undefined; name: string; state: string; meta?: readonly string[] | undefined; spend?: DetailSpend | undefined; reason?: string | null | undefined; reasonId?: string | undefined }>): React.JSX.Element {
  return <header {...(className ? { className } : {})}>{icon}<div className="skill-v3-detail-heading"><div className="skill-v3-detail-identity">{eyebrow ? <span>{eyebrow}</span> : null}<h3>{name}</h3></div><div className="skill-v3-detail-state"><strong>{state}</strong>{meta?.map((line) => <small key={line}>{line}</small>)}</div></div>{spend ? <button className="game-app-button skill-v3-header-action" type="button" disabled={spend.disabled} aria-label={spend.ariaLabel} aria-describedby={spend.describedBy} onClick={spend.onClick}>{spend.cost === null ? spend.label : <>{spend.label}<small>{spend.cost} SP</small></>}</button> : null}{reason ? <small className={`skill-v3-header-reason${/^Requires \d+ available SP\.$/.test(reason) ? " skill-v3-sr-only" : ""}`} id={reasonId}>{reason}</small> : null}</header>;
}

/** The one-line strip at the top of every Progression tab (SP and level, trades practiced, journal prestige), so each tab opens the same way. */
export function ProgressionStrip({ label, left, right }: Readonly<{ label: string; left: React.ReactNode; right?: React.ReactNode }>): React.JSX.Element {
  return <div className="skill-v3-summary" aria-label={label}>
    <p className="skill-v3-summary-points">{left}</p>
    {right ? <p className="skill-v3-summary-level">{right}</p> : null}
  </div>;
}
