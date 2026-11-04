import { FIELD_BUFF_LABELS, type FieldBuffId } from "@ash-atlas/shared";
import { useEffect, useState } from "react";

/** One active field buff; `endsAtLocalMs` is the server deadline translated to the local clock once. */
export type FieldBuffDisplay = Readonly<{
  buffId: FieldBuffId;
  endsAtLocalMs: number | null;
}>;

function remainingLabel(endsAtLocalMs: number | null, nowMs: number): string {
  if (endsAtLocalMs === null) return "While Aggressive";
  const seconds = Math.max(0, Math.ceil((endsAtLocalMs - nowMs) / 1_000));
  if (seconds >= 3_600) return `${Math.floor(seconds / 3_600)}h ${Math.floor((seconds % 3_600) / 60)}m`;
  if (seconds >= 60) return `${Math.ceil(seconds / 60)}m`;
  return `${seconds}s`;
}

/** Potion buff indicators in the gameplay status stack. Text only until approved art exists. */
export function FieldBuffStrip({ buffs }: Readonly<{ buffs: readonly FieldBuffDisplay[] }>): React.JSX.Element | null {
  const [nowMs, setNowMs] = useState(() => Date.now());
  const timed = buffs.some((buff) => buff.endsAtLocalMs !== null);
  useEffect(() => {
    if (!timed) return undefined;
    const timer = window.setInterval(() => setNowMs(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [timed]);
  const live = buffs.filter((buff) => buff.endsAtLocalMs === null || buff.endsAtLocalMs > nowMs);
  if (live.length === 0) return null;
  return <ul className="field-buff-strip" aria-label="Active potion effects">
    {live.map((buff) => {
      const label = FIELD_BUFF_LABELS[buff.buffId];
      const remaining = remainingLabel(buff.endsAtLocalMs, nowMs);
      return <li
        key={buff.buffId}
        className="field-buff-chip"
        data-buff={buff.buffId}
        title={label.detail}
        aria-label={`${label.name}: ${label.detail} ${remaining}.`}
      >
        <strong>{label.name}</strong>
        <span>{remaining}</span>
      </li>;
    })}
  </ul>;
}
