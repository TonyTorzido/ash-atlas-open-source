import type { ReactNode } from "react";

export type WorldActivityTimerKind =
  | "flag"
  | "gathering-chopping"
  | "gathering-mining"
  | "gathering-harvesting"
  | "greenhouse-planting"
  | "flag-hardening"
  | "furnace"
  | "tannery"
  | "loom"
  | "kitchen"
  | "fishing-hut"
  | "manor"
  | "greenhouse"
  | "kingdom-seat"
  | "city-construction"
  | "city-flag-conversion";

export type WorldActivityTimerCandidate = Readonly<{
  kind: WorldActivityTimerKind;
  ariaLabel: string;
  remainingTimeLabel: string;
  progress: number;
  priority: number;
}>;

export function selectPrimaryWorldActivityTimer(
  candidates: readonly (WorldActivityTimerCandidate | null)[]
): WorldActivityTimerCandidate | null {
  return candidates
    .filter((candidate): candidate is WorldActivityTimerCandidate => candidate !== null)
    .sort((left, right) => left.priority - right.priority)[0] ?? null;
}

export function worldActivityKindForGatheringLabel(
  label: "Chopping" | "Mining" | "Harvesting"
): WorldActivityTimerKind {
  switch (label) {
    case "Chopping":
      return "gathering-chopping";
    case "Mining":
      return "gathering-mining";
    case "Harvesting":
      return "gathering-harvesting";
  }
}

function WorldActivityTimerGlyph({ kind }: Readonly<{ kind: WorldActivityTimerKind }>): ReactNode {
  const path = (() => {
    switch (kind) {
      case "flag":
      case "city-flag-conversion":
        return <><path d="M6 21V3M7 4h10l-2 4 2 4H7" /><path d="M3 21h8" /></>;
      case "gathering-chopping":
        return <><path d="m5 19 9-9" /><path d="m12 6 6 6" /><path d="M15 3c2.8 0 4.9 1.4 6 3.4-2.1.7-3.9.5-5.4-.6C14.5 4.9 14.3 4 15 3Z" /></>;
      case "gathering-mining":
        return <><path d="m4 18 8-8" /><path d="m11 5 3-3 8 8-3 3" /><path d="m3 21 3-3" /></>;
      case "gathering-harvesting":
        return <><path d="M4 14h16l-1.5 6h-13L4 14Z" /><path d="M7 14c.2-4.2 2.5-7 6.5-8.5.3 3.8-1.8 7-6.5 8.5Z" /><path d="M8 17h8" /></>;
      case "greenhouse-planting":
        return <><path d="M12 21V10" /><path d="M12 14c-4.2 0-6.5-2.2-7-6 3.8-.1 6.3 1.8 7 6Z" /><path d="M12 12c.7-4.2 3.2-6.1 7-6-.5 3.8-2.8 6-7 6Z" /></>;
      case "flag-hardening":
        return <><path d="m12 3 7 3v5c0 4.7-3 7.9-7 10-4-2.1-7-5.3-7-10V6l7-3Z" /><path d="m8.5 12 2.2 2.2 4.8-5" /></>;
      case "furnace":
        return <><path d="M5 8h14v12H5zM8 8V4h8v4" /><path d="M9 13h6v7H9z" /></>;
      case "tannery":
        return <><path d="M4 5c2.3 2.1 4.7 2.1 7 0s4.7-2.1 7 0v13c-2.3-2.1-4.7-2.1-7 0s-4.7 2.1-7 0V5Z" /><path d="M8 8h8M8 12h5" /></>;
      case "loom":
        return <><path d="M5 3v18M19 3v18M5 6h14M5 18h14" /><path d="m8 6 8 12M12 6l7 10M8 18l8-12" /></>;
      case "kitchen":
        return <><path d="M5 10h14l-1 9H6l-1-9Z" /><path d="M8 10V7a4 4 0 0 1 8 0v3M3 10h18" /></>;
      case "fishing-hut":
        return <><path d="M3 18h18M5 18v-7l7-5 7 5v7" /><path d="M9 18v-4h6v4M3 21h18" /></>;
      case "manor":
        return <><path d="m3 11 9-8 9 8v9H3v-9Z" /><path d="M9 20v-5h6v5M8 10h8" /></>;
      case "greenhouse":
        return <><path d="M3 20h18M5 20V8l7-5 7 5v12" /><path d="M9 20v-5h6v5M8 10h8" /></>;
      case "kingdom-seat":
        return <><path d="M4 20V9l4 3 4-7 4 7 4-3v11H4Z" /><path d="M7 20v-4h10v4" /></>;
      case "city-construction":
        return <><path d="M4 21V9l7-4v16M11 21V3l9 4v14" /><path d="M7 12h1M7 16h1M15 10h1M15 14h1M15 18h1" /></>;
    }
  })();
  return (
    <span className="world-activity-timer-icon" data-world-activity-icon={kind} aria-hidden="true">
      <svg viewBox="0 0 24 24" focusable="false">
        {path}
      </svg>
    </span>
  );
}

export function WorldActivityTimerPlate(
  props: WorldActivityTimerCandidate
): React.JSX.Element {
  const progress = Math.max(0, Math.min(1, props.progress));
  const percent = Math.round(progress * 100);
  return (
    <div
      className="world-activity-timer-plate"
      data-world-activity={props.kind}
      role="status"
    >
      <div className="world-activity-timer-heading">
        <span className="world-activity-timer-copy">
          <WorldActivityTimerGlyph kind={props.kind} />
          <span className="sr-only">{props.ariaLabel}</span>
        </span>
        <output aria-label={`${props.ariaLabel} time remaining`}>
          {props.remainingTimeLabel}
        </output>
      </div>
      <div
        className="world-activity-timer-progress"
        role="progressbar"
        aria-label={`${props.ariaLabel} progress`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
      >
        <i style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}
