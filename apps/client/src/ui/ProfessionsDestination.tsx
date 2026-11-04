import {
  professionXpThresholds,
  type MasteryProgress,
  type MasterySnapshot,
  type OilWellSnapshot,
  type ProfessionId
} from "@ash-atlas/shared";
import { useEffect, useMemo, useState } from "react";

import { GameAppShell } from "./GameAppShell.js";
import { professionIconProps } from "./ProfessionIcons.js";
import { ProfessionTrack } from "./ProfessionDetail.js";
import { PhoneMenuFooterButtons } from "./PhoneMenuDestinationShell.js";
import { ProgressionStrip } from "./ProgressionDetailHeader.js";
import { ProgressionDetailSheet, useRetainedSheet } from "./ProgressionDetailSheet.js";
import { ProgressionIcon } from "./ProgressionIcon.js";
import "./ProfessionsDestination.css";

type ProfessionCategoryId = "gathering" | "crafting" | "trade_world";
type ProfessionSelection = Readonly<{ kind: "live"; id: ProfessionId }>;
type ProfessionEntry = Readonly<{ label: string; selection: ProfessionSelection }>;

export type ProfessionBackOverride = Readonly<{
  label: string;
  onBack(): void;
}>;

export type ProfessionsDestinationProps = Readonly<{
  open: boolean;
  layout?: "desktop" | "phone";
  masteries: MasterySnapshot | null;
  oilWell?: OilWellSnapshot | null;
  oilWellStructureId?: string | null;
  onRequestOilWellStatus?(): void;
  onRemoteHarvestOilWell?(): void;
  onReturnToGame?(): void;
  onClose(): void;
}>;

export type ProfessionsContentProps = Readonly<{
  open: boolean;
  layout: "desktop" | "phone";
  masteries: MasterySnapshot | null;
  onBackChange?(override: ProfessionBackOverride | null): void;
  oilWell?: OilWellSnapshot | null;
  oilWellStructureId?: string | null;
  onRequestOilWellStatus?(): void;
  onRemoteHarvestOilWell?(): void;
}>;

const CATEGORIES = [
  { id: "gathering", label: "Gathering" },
  { id: "crafting", label: "Crafting" },
  { id: "trade_world", label: "Trade & World" }
] as const;

const LIVE_PROFESSIONS: ReadonlyArray<Readonly<{
  id: ProfessionId;
  label: string;
  category: ProfessionCategoryId;
}>> = [
  { id: "woodcutter", label: "Woodcutter", category: "gathering" },
  { id: "miner", label: "Miner", category: "gathering" },
  { id: "oil_worker", label: "Oil Worker", category: "gathering" },
  { id: "builder", label: "Builder", category: "trade_world" },
  { id: "metallurgy", label: "Metallurgy", category: "crafting" }
];

export function ProfessionsDestination(props: ProfessionsDestinationProps): React.JSX.Element | null {
  const [backOverride, setBackOverride] = useState<ProfessionBackOverride | null>(null);
  useEffect(() => {
    if (!props.open) setBackOverride(null);
  }, [props.open]);
  if (!props.open) return null;
  return <GameAppShell
    open
    title="Professions"
    menuId="classes"
    closeLabel="Close Professions"
    className="professions-destination"
    layout={props.layout ?? "desktop"}
    phoneBackLabel={backOverride?.label ?? "Back to Game Menu"}
    phoneOnBack={backOverride?.onBack ?? props.onClose}
    phoneOnEscape={backOverride?.onBack ?? props.onClose}
    footer={props.layout !== "phone" ? <PhoneMenuFooterButtons
      backLabel={backOverride?.label ?? "Back to Game Menu"}
      onBack={backOverride?.onBack ?? props.onClose}
      onReturnToGame={props.onReturnToGame ?? props.onClose}
    /> : undefined}
    onClose={props.onClose}
  >
    <ProfessionsContent
      {...props}
      layout={props.layout ?? "desktop"}
      onBackChange={setBackOverride}
    />
  </GameAppShell>;
}

/** Every profession on one page, grouped by category; details open in the shared sheet. */
export function ProfessionsContent(props: ProfessionsContentProps): React.JSX.Element {
  const [selection, setSelection] = useState<ProfessionSelection | null>(null);
  const backOverride = useMemo<ProfessionBackOverride | null>(() => selection === null
    ? null
    : { label: "Back to Professions", onBack: () => setSelection(null) }, [selection]);

  useEffect(() => {
    if (!props.open) setSelection(null);
  }, [props.open]);

  useEffect(() => {
    props.onBackChange?.(backOverride);
    return () => props.onBackChange?.(null);
  }, [backOverride, props.layout, props.onBackChange]);

  useEffect(() => {
    if (!props.open || !selection || selection.kind !== "live" || selection.id !== "oil_worker") return;
    if ((props.masteries?.professions.oil_worker.rank ?? 0) < 4) return;
    props.onRequestOilWellStatus?.();
    const interval = window.setInterval(() => props.onRequestOilWellStatus?.(), 60_000);
    return () => window.clearInterval(interval);
  }, [props.masteries?.professions.oil_worker.rank, props.onRequestOilWellStatus, props.open, selection]);

  const detail = props.masteries && selection
    ? <ProfessionDetail selection={selection} masteries={props.masteries} {...oilProps(props)} />
    : selection ? <p className="professions-loading">Loading professions…</p> : null;

  const sheetNode = detail && selection ? <div className="profession-detail-child" data-profession-view="detail">{detail}</div> : null;
  const shownSheet = useRetainedSheet(selection ? `${selection.kind}-${selection.id}` : null, sheetNode);

  const tradeProgress = props.masteries ? Object.values(props.masteries.professions) : null;
  const practiced = tradeProgress?.filter((entry) => entry.xp > 0).length ?? 0;
  const topRank = tradeProgress?.reduce((best, entry) => Math.max(best, entry.rank), 0) ?? 0;
  return <div className={`professions-app-layout ${props.layout === "phone" ? "phone-layout" : "desktop-layout"}${shownSheet ? " has-sheet" : ""}`}>
    <ProgressionStrip label="Trade status" left={<><span className="skill-v3-available"><strong>{tradeProgress ? practiced : "—"}</strong> of {tradeProgress?.length ?? "—"} trades practiced</span></>} right={tradeProgress ? <>Top rank <strong>{topRank}</strong></> : null} />
    <nav className="professions-list" aria-label="Professions" data-profession-view="list">
      {CATEGORIES.map((category) => {
        const entries = entriesForCategory(category.id);
        const card = (entry: ProfessionEntry) => <ProfessionEntryCard
          key={`${entry.selection.kind}-${entry.selection.id}`}
          entry={entry}
          masteries={props.masteries}
          selected={selection !== null && sameSelection(entry.selection, selection)}
          onSelect={setSelection}
        />;
        return <section key={category.id} className="professions-entry-group" aria-label={`${category.label} professions`}>
          <h3 className="skill-v3-section-title">{category.label}</h3>
          {entries.length ? <div className="professions-entry-grid" data-content-state="live">{entries.map(card)}</div> : null}
        </section>;
      })}
    </nav>
    {shownSheet ? <ProgressionDetailSheet key={shownSheet.key} layout={props.layout} closing={shownSheet.closing} onClose={() => setSelection(null)}>{shownSheet.node}</ProgressionDetailSheet> : null}
  </div>;
}

function ProfessionDetail({ selection, masteries, ...oil }: Readonly<{
  selection: ProfessionSelection;
  masteries: MasterySnapshot;
  oilWell?: OilWellSnapshot | null;
  oilWellStructureId?: string | null;
  onRemoteHarvestOilWell?: () => void;
}>): React.JSX.Element {
  return <ProfessionTrack track={selection.id} progress={masteries.professions[selection.id]} {...oil} />;
}

function entriesForCategory(category: ProfessionCategoryId): readonly ProfessionEntry[] {
  return LIVE_PROFESSIONS
    .filter((entry) => entry.category === category)
    .map((entry) => ({ label: entry.label, selection: { kind: "live" as const, id: entry.id } }));
}

/** Share of the way from this rank's XP threshold to the next; 1 once mastered. */
function rankProgressRatio(track: ProfessionId, progress: MasteryProgress): number {
  if (progress.mastered || progress.nextRankXp === null) return 1;
  const floor = professionXpThresholds(track)[progress.rank] ?? 0;
  const span = progress.nextRankXp - floor;
  return span > 0 ? Math.min(1, Math.max(0, (progress.xp - floor) / span)) : 0;
}

function ProfessionEntryCard({ entry, masteries, selected, onSelect }: Readonly<{
  entry: ProfessionEntry;
  masteries: MasterySnapshot | null;
  selected: boolean;
  onSelect(selection: ProfessionSelection): void;
}>): React.JSX.Element {
  const live = true;
  const liveProgress = masteries?.professions[entry.selection.id];
  const maximumRank = liveProgress?.maximumRank ?? 1;
  const rank = liveProgress?.rank ?? 0;
  const loading = !liveProgress;
  const ratio = liveProgress ? rankProgressRatio(entry.selection.id, liveProgress) : 0;
  const status = loading ? "Loading mastery"
    : liveProgress?.mastered ? "Mastered"
        : liveProgress?.nextRankXp != null ? `${Math.max(0, liveProgress.nextRankXp - liveProgress.xp).toLocaleString()} XP to Rank ${rank + 1}`
          : "";
  return <button
    type="button"
    className="profession-entry-card"
    data-content-state={live ? "live" : "future"}
    data-selected={selected}
    onClick={() => onSelect(entry.selection)}
    aria-label={`${entry.label}, ${live ? (loading ? "Loading mastery" : "Live mastery") : "Future Content"}, Rank ${rank}/${maximumRank}`}
  >
    <ProgressionIcon
      alt={`${entry.label} icon`}
      size={48}
      {...professionIconProps(entry.selection.id)}
    />
    <span className="profession-entry-card-copy">
      <strong>{entry.label}</strong>
      {live && !loading ? <span className="profession-entry-card-rank"><small>Rank {rank}/{maximumRank}</small>{liveProgress?.mastered ? <em>{liveProgress.title}</em> : null}</span> : null}
      {live && !loading ? <span className="profession-entry-card-meter" aria-hidden="true"><i style={{ width: `${ratio * 100}%` }} /></span> : null}
      {status ? <small className="profession-entry-card-status">{status}</small> : null}
    </span>
    <span aria-hidden="true" className="profession-entry-card-chevron">›</span>
  </button>;
}

function sameSelection(left: ProfessionSelection, right: ProfessionSelection): boolean {
  return left.kind === right.kind && left.id === right.id;
}

function oilProps(props: ProfessionsDestinationProps | ProfessionsContentProps): Pick<ProfessionsDestinationProps, "oilWell" | "oilWellStructureId" | "onRemoteHarvestOilWell"> {
  return {
    ...(props.oilWell !== undefined ? { oilWell: props.oilWell } : {}),
    ...(props.oilWellStructureId !== undefined ? { oilWellStructureId: props.oilWellStructureId } : {}),
    ...(props.onRemoteHarvestOilWell ? { onRemoteHarvestOilWell: props.onRemoteHarvestOilWell } : {})
  };
}
