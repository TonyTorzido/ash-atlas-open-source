import {
  PROFESSION_DESCRIPTIONS as PROFESSION_RANK_DESCRIPTIONS,
  PROFESSION_RANKS,
  professionMaxXp,
  professionXpThresholds,
  type MasteryProgress,
  type OilWellSnapshot,
  type ProfessionId
} from "@ash-atlas/shared";
import { professionIconProps } from "./ProfessionIcons.js";
import { ProgressionIcon } from "./ProgressionIcon.js";
import { DetailHeader } from "./ProgressionDetailHeader.js";
import { RankLadder, type RankLadderEntry } from "./RankLadder.js";
import "./ProfessionsDestination.css";

export const PROFESSION_TRACK_DESCRIPTIONS: Readonly<Record<ProfessionId, string>> = {
  woodcutter: "Harvest trees and refine your chopping craft through reliable timber work.",
  miner: "Extract stone from discovered mines and improve the speed and yield of each session.",
  builder: "Raise durable structures and earn mastery by completing useful construction.",
  oil_worker: "Harvest crude from your personal Oil Well to improve storage and unlock remote management.",
  metallurgy: "Smelt Iron Ore, manage smelting risk, and recover Iron Bars from Slag."
};

export type ProfessionTrackProps = Readonly<{
  track: ProfessionId;
  progress: MasteryProgress;
  oilWell?: OilWellSnapshot | null | undefined;
  oilWellStructureId?: string | null | undefined;
  onRemoteHarvestOilWell?: (() => void) | undefined;
}>;

export function ProfessionTrack({ track, progress, ...oilProps }: ProfessionTrackProps): React.JSX.Element {
  return <ProfessionDetail
    track={track}
    progress={progress}
    {...oilProps}
  />;
}

function ProfessionDetail(props: ProfessionTrackProps): React.JSX.Element {
  const displayName = TRACK_LABELS[props.track];
  const detailId = `profession-detail-${props.track}`;
  const rows: readonly RankLadderEntry[] = liveRankRows(props.track, props.progress);
  const state = liveRankLabel(props.track, props.progress.rank, props.progress.maximumRank);
  const meta = props.progress.mastered ? [props.progress.title] : undefined;
  const icon = <ProgressionIcon alt={`${displayName} icon`} size={56} {...professionIconProps(props.track)} />;
  return <section className="profession-detail skill-v3-detail profession-detail-live" aria-label={`${displayName} details`}>
    <DetailHeader className="profession-detail-header" icon={icon} eyebrow="Trade" name={displayName} state={state} meta={meta} />
    <p className="profession-detail-description">{PROFESSION_TRACK_DESCRIPTIONS[props.track]}</p>
    <LiveProgressSummary track={props.track} progress={props.progress} />
    {props.track === "oil_worker" && props.progress.rank >= 2 ? <OilWellProfessionStatus
      progress={props.progress}
      {...(props.oilWell !== undefined ? { oilWell: props.oilWell } : {})}
      {...(props.oilWellStructureId !== undefined ? { oilWellStructureId: props.oilWellStructureId } : {})}
      {...(props.onRemoteHarvestOilWell ? { onRemoteHarvestOilWell: props.onRemoteHarvestOilWell } : {})}
    /> : null}
    <section className="profession-detail-ranks" aria-labelledby={`${detailId}-ranks`}>
      <h4 id={`${detailId}-ranks`}>Rank progression</h4>
      <RankLadder entries={rows} />
    </section>
  </section>;
}

function LiveProgressSummary({ track, progress }: Readonly<{ track: ProfessionId; progress: MasteryProgress }>): React.JSX.Element {
  const maximumXp = professionMaxXp(track);
  const thresholds = professionXpThresholds(track);
  const nextThreshold = progress.nextRankXp ?? thresholds[progress.rank + 1] ?? maximumXp;
  const status = progress.mastered
    ? `${progress.xp.toLocaleString()} / ${maximumXp.toLocaleString()} XP · Mastered`
    : `${progress.xp.toLocaleString()} / ${maximumXp.toLocaleString()} XP · ${Math.max(0, nextThreshold - progress.xp).toLocaleString()} XP to Rank ${publicRank(track, Math.min(progress.rank + 1, progress.maximumRank))}`;
  return <div className="profession-detail-progress">
    <ProgressMeter label={`${TRACK_LABELS[track]} mastery progress`} maximum={maximumXp} value={progress.xp} />
    <p className="profession-detail-status">{status}</p>
  </div>;
}

function liveRankRows(track: ProfessionId, progress: MasteryProgress): readonly RankLadderEntry[] {
  const descriptions = PROFESSION_RANK_DESCRIPTIONS[track];
  const thresholds = professionXpThresholds(track);
  return thresholds.map((threshold, rank) => {
    const milestone = professionMilestoneLabel(rank);
    const description = descriptions[rank] ?? "Base activity available.";
    return {
      key: rank,
      title: `Rank ${publicRank(track, rank)}`,
      state: rank === progress.rank ? "current" : rank < progress.rank ? "earned" : rank === progress.rank + 1 ? "next" : "upcoming",
      meta: `${threshold.toLocaleString()} XP`,
      ...(milestone ? { badge: milestone, milestone: rank } : {}),
      name: PROFESSION_RANKS[track][rank] ?? "Profession benefit",
      ...(description !== PROFESSION_RANKS[track][rank] ? { lines: [{ key: "effect", content: description }] } : {})
    };
  });
}

function liveRankLabel(track: ProfessionId, rank: number, maximumRank: number): string {
  return `Rank ${publicRank(track, rank)}/${publicRank(track, maximumRank)}`;
}

function publicRank(track: ProfessionId, rank: number): string {
  void track;
  return String(rank);
}

function professionMilestoneLabel(rank: number): string | null {
  if (rank === 2) return "Tier I";
  if (rank === 5) return "Tier II";
  if (rank === 8) return "Tier III / Master";
  return null;
}

function OilWellProfessionStatus({ progress, oilWell, oilWellStructureId, onRemoteHarvestOilWell }: Readonly<{
  progress: MasteryProgress;
  oilWell?: OilWellSnapshot | null | undefined;
  oilWellStructureId?: string | null | undefined;
  onRemoteHarvestOilWell?: (() => void) | undefined;
}>): React.JSX.Element {
  const full = oilWell ? oilWell.storedCrudeOil >= oilWell.capacity : false;
  const fullIn = progress.rank >= 2 && oilWell?.fullAt
    ? formatDuration(Math.max(0, Date.parse(oilWell.fullAt) - oilWell.serverTime))
    : null;
  return <section className="profession-oil-well-status" aria-label="Oil Well profession status">
    <h4>{progress.rank >= 4 ? "Oil Well" : "Well Gauge"}</h4>
    {!oilWell ? <p>{oilWellStructureId
      ? progress.rank >= 4 ? "Loading authoritative well status…" : "Inspect your Oil Well in person for authoritative gauge timing."
      : "No personal Oil Well found."}</p> : <>
      <strong>{oilWell.storedCrudeOil} / {oilWell.capacity} Crude</strong>
      <p>{full ? "FULL — production is capped until harvested." : `Producing${fullIn ? ` · Full in ${fullIn}` : ""}`}</p>
      {progress.rank >= 8 ? <button type="button" className="game-app-button" disabled={!oilWell.canHarvest} onClick={onRemoteHarvestOilWell}>Harvest Crude</button> : null}
    </>}
  </section>;
}

function formatDuration(milliseconds: number): string {
  const minutes = Math.ceil(milliseconds / 60_000);
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return hours > 0 ? `${hours}h ${remainder}m` : `${remainder}m`;
}

export function ProgressMeter({ label, maximum, value }: Readonly<{ label: string; maximum: number; value: number }>): React.JSX.Element {
  const safeMaximum = Math.max(1, maximum);
  const safeValue = Math.max(0, Math.min(value, safeMaximum));
  return <div
    className="ash-progress-meter game-app-progress"
    role="progressbar"
    aria-label={label}
    aria-valuemin={0}
    aria-valuemax={safeMaximum}
    aria-valuenow={safeValue}
  ><span style={{ width: `${safeValue / safeMaximum * 100}%` }} /></div>;
}

const TRACK_LABELS: Readonly<Record<ProfessionId, string>> = {
  woodcutter: "Woodcutter",
  miner: "Miner",
  builder: "Builder",
  oil_worker: "Oil Worker",
  metallurgy: "Metallurgy"
};
