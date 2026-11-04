import { useState } from "react";
import { fallenPrisonHuntDirectionDegrees, type FallenPrisonHuntHint } from "@ash-atlas/shared";

import "./FallenPrisonHuntIndicator.css";

const BAND_TEXT: Readonly<Record<FallenPrisonHuntHint["band"], string>> = {
  far: "far",
  closer: "closer",
  near: "near"
};

/** The one-line hint text, e.g. "North-east, far". */
export function fallenPrisonHuntLabel(hint: FallenPrisonHuntHint): string {
  const direction = hint.direction.charAt(0).toUpperCase() + hint.direction.slice(1);
  return hint.smokeInSight ? `${direction}, near. Look for the smoke.` : `${direction}, ${BAND_TEXT[hint.band]}`;
}

/**
 * The Fallen Prison hunt (level 40 only, server-sent): a small persistent pill with a compass arrow
 * and a coarse distance band towards the crash, and the landing line when it first falls. The chevron
 * collapses it to the arrow alone. No scrollbars: the text wraps inside a fixed-width pill.
 */
export function FallenPrisonHuntIndicator(props: Readonly<{
  hint: FallenPrisonHuntHint;
  announcement: string | null;
}>) {
  const [open, setOpen] = useState(true);
  const { hint, announcement } = props;
  return (
    <aside className="fallen-prison-hunt" aria-label="Fallen Prison hunt" data-band={hint.band}>
      <button type="button" className="fallen-prison-hunt-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="fallen-prison-hunt-arrow" style={{ transform: `rotate(${fallenPrisonHuntDirectionDegrees(hint.direction)}deg)` }}
          aria-hidden="true">↑</span>
        <span className="fallen-prison-hunt-title">{open ? "Fallen Prison" : BAND_TEXT[hint.band]}</span>
        <span className="fallen-prison-hunt-chevron" aria-hidden="true">{open ? "⌃" : "⌄"}</span>
      </button>
      {open ? (
        <div className="fallen-prison-hunt-body">
          {announcement ? <p className="fallen-prison-hunt-announcement">{announcement}</p> : null}
          <p className="fallen-prison-hunt-hint" role="status">{fallenPrisonHuntLabel(hint)}</p>
        </div>
      ) : null}
    </aside>
  );
}
