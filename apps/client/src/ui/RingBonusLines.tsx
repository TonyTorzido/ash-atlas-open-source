import { ringStateLabel, type RingBonusPresentation } from "../inventory/ringPresentation.js";

/** Ring bonus lines shared by the item popup, the Character panel and the market. */
export function RingBonusLines({ lines, rough = false }: {
  lines: readonly RingBonusPresentation[];
  rough?: boolean;
}): React.JSX.Element {
  if (rough) {
    return <p className="ring-rough-note">Rough · Polish to reveal its bonuses. A Rough ring cannot be worn, dropped, traded or sold.</p>;
  }
  return <ul className="ring-bonus-list">{lines.map((bonus) => {
    const state = ringStateLabel(bonus.state);
    return <li key={bonus.key} className={`ring-bonus ring-bonus-${bonus.state}`}>
      <span>{bonus.label}</span> <strong>{bonus.value}</strong>
      {bonus.note ? <small> {bonus.note}</small> : null}
      {state ? <em> ({state})</em> : null}
    </li>;
  })}</ul>;
}

/** One-line summary for list rows, e.g. "Max HP +5 · Land speed +1%". */
export function ringBonusSummary(lines: readonly RingBonusPresentation[]): string {
  return lines.map((line) => `${line.label} ${line.value}`).join(" · ");
}
