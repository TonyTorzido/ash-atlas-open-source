import {
  CURRENT_LEVEL_CAP,
  MAX_CURRENT_ERA_XP,
  TECHNIQUE_BY_ID,
  CLASS_DEFINITIONS,
  CLASS_MAX_RANK,
  CLASS_XP_THRESHOLDS,
  GENERAL_SKILL_DEFINITIONS,
  LAUNCH_CLASS_IDS,
  SPECIALIZATION_DEFINITIONS,
  SPECIALIZATION_IDS,
  type ClassCombatState,
  type ClassId,
  type LaunchClassId,
  type ClassLoadoutView,
  type ClassSnapshot,
  type DevProgressionType,
  type EquipmentSnapshot,
  type MasterySnapshot,
  type OilWellSnapshot,
  type ProfessionId,
  type ProgressionSnapshot,
  type SubclassId,
  type TechniqueDefinition
} from "@ash-atlas/shared";
import { useEffect, useState } from "react";

import { PhoneMenuDestinationShell } from "./PhoneMenuDestinationShell.js";
import { GameConfirmationPrompt } from "./GameActionPrompt.js";
import { ClassAbilityIcon } from "./ClassAbilityIcon.js";
import { ProfessionTrack, ProgressMeter } from "./ProfessionDetail.js";

type Props = {
  open: boolean;
  initialSection?: string;
  snapshot: ClassSnapshot | null;
  progression?: ProgressionSnapshot | null;
  masteries?: MasterySnapshot | null;
  combatResource?: ClassCombatState["resource"] | null;
  combat?: ClassCombatState | null;
  synchronizedNow?(): number;
  equipment?: EquipmentSnapshot | null;
  busy: boolean;
  devProgressionVisible: boolean;
  devProgressionOpen: boolean;
  devProgressionPendingType: DevProgressionType | null;
  devProgressionError: string | null;
  devSubclassPending: SubclassId | null;
  onClose(): void;
  closeLabel?: string;
  layout?: "desktop" | "phone";
  onLoadout(loadout: ClassLoadoutView): void;
  onClass?(id: ClassId): void;
  onUnlockClass?(id: LaunchClassId): void;
  onSubclass(id: SubclassId | null): void;
  onSetDevSubclassUnlock(id: SubclassId, unlocked: boolean): void;
  onAdjustDevProgression(type: DevProgressionType, targetLevel: number): void;
  onToggleDevProgression(): void;
  oilWell?: OilWellSnapshot | null;
  oilWellStructureId?: string | null;
  onRequestOilWellStatus?(): void;
  onRemoteHarvestOilWell?(): void;
};

type Track = "character" | "warrior" | ProfessionId;
type LaunchClassSection = "innate" | "skills" | "passives" | "mastery";

const TRACK_LABELS: Record<Track, string> = {
  character: "Character",
  warrior: "Classes",
  woodcutter: "Woodcutter",
  miner: "Miner",
  builder: "Builder",
  oil_worker: "Oil Worker",
  metallurgy: "Metallurgy"
};

export function WarriorClassPanel(props: Props): React.JSX.Element | null {
  const initialTrack = isTrack(props.initialSection) ? props.initialSection : "character";
  const [track, setTrack] = useState<Track>(initialTrack);
  useEffect(() => {
    if (props.open) {
      setTrack(isTrack(props.initialSection) ? props.initialSection : "character");
    } else {
      setTrack("character");
    }
  }, [props.initialSection, props.open]);
  useEffect(() => {
    if (props.open && track === "oil_worker" && (props.masteries?.professions.oil_worker.rank ?? 0) >= 4) {
      props.onRequestOilWellStatus?.();
      const interval = window.setInterval(() => props.onRequestOilWellStatus?.(), 60_000);
      return () => window.clearInterval(interval);
    }
  }, [props.open, props.masteries?.professions.oil_worker.rank, props.onRequestOilWellStatus, track]);
  if (!props.open) return null;
  if (!props.snapshot || !props.progression || !props.masteries) {
    if (props.layout === "phone") {
      return <PhoneMenuDestinationShell menuId="classes" title={phoneProgressionTitle(props.initialSection)} onBack={props.onClose}><p className="phone-progression-loading">Loading progression…</p></PhoneMenuDestinationShell>;
    }
    return <div className="class-panel-backdrop"><aside className="class-panel phone-destination-shell desktop-destination-shell" role="dialog" aria-modal="true"><p>Loading progression…</p><button type="button" onClick={props.onClose}>{props.closeLabel ?? "Close"}</button></aside></div>;
  }
  const selected = track === "character" ? null : track === "warrior"
    ? props.masteries.warrior : props.masteries.professions[track];
  if (props.layout === "phone") {
    const title = phoneProgressionTitle(props.initialSection);
    const professionTracks = (Object.keys(props.masteries.professions) as ProfessionId[])
      .filter((id) => props.masteries!.professions[id] !== undefined);
    const selectedProfession = track !== "character" && track !== "warrior" && professionTracks.includes(track)
      ? track
      : professionTracks[0];
    return <PhoneMenuDestinationShell
      menuId="classes"
      title={title}
      bodyClassName="phone-progression-body"
      onBack={props.onClose}
    >
      <div className="class-panel-content progression-panel-content">
        {props.devProgressionOpen && props.devProgressionVisible ? <DevelopmentProgression {...props} scope={title === "Classes" ? "classes" : "professions"} /> : null}
        {title === "Classes" ? (
          <section className="phone-class-destination" aria-label="Class tracks">
            <LaunchClassesView {...props} />
          </section>
        ) : (
          <section className="phone-professions-destination" aria-labelledby="phone-professions-title">
            <header className="phone-progression-destination-heading"><span>Authoritative tracks</span><h2 id="phone-professions-title">Professions</h2><small>{professionTracks.length} available</small></header>
            <nav className="class-selector progression-track-selector" role="tablist" aria-label="Profession tracks">
              {professionTracks.map((id) => <button type="button" role="tab" aria-selected={selectedProfession === id} key={id} className={selectedProfession === id ? "active" : undefined} onClick={() => setTrack(id)}>{TRACK_LABELS[id]}</button>)}
            </nav>
            {selectedProfession ? <ProfessionTrack track={selectedProfession} progress={props.masteries.professions[selectedProfession]} oilWell={props.oilWell} oilWellStructureId={props.oilWellStructureId} onRemoteHarvestOilWell={props.onRemoteHarvestOilWell} /> : <p className="empty-state">No profession data is available.</p>}
          </section>
        )}
      </div>
    </PhoneMenuDestinationShell>;
  }
  return <div className="class-panel-backdrop">
    <aside className="class-panel progression-panel phone-destination-shell desktop-destination-shell" role="dialog" aria-modal="true" aria-label="Progression">
      <header className="class-panel-header">
        <div>
          <span className="eyebrow">{track === "warrior" ? "Combat mastery" : "Launch progression"}</span>
          <h1>{track === "warrior" ? "Classes" : "Character & Professions"}</h1>
          <small>{track === "warrior"
            ? "Five independent Class Rank tracks with free switching between permanently unlocked classes."
            : "Character and profession progression remain independent from class progression."}</small>
        </div>
        <div className="class-panel-header-actions">
          {props.masteries.warrior.mastered && track === "warrior" ? <span className="mastered-badge">Mastered</span> : null}
          {props.devProgressionVisible ? <button type="button" onClick={props.onToggleDevProgression}>Dev Tools</button> : null}
          <button type="button" onClick={props.onClose}>{props.closeLabel ?? "Close"}</button>
        </div>
      </header>
      <div className="class-panel-content progression-panel-content">
        <p><strong>Equipped mastery title:</strong> {props.masteries.equippedTitle ?? "None"}</p>
        <nav className="class-selector progression-track-selector" aria-label="Progression tracks">
          {(Object.keys(TRACK_LABELS) as Track[]).map((id) => <button type="button" key={id} className={track === id ? "active" : undefined} onClick={() => setTrack(id)}>{TRACK_LABELS[id]}</button>)}
        </nav>
        {props.devProgressionOpen && props.devProgressionVisible ? <DevelopmentProgression {...props} /> : null}
        {track === "character"
          ? <CharacterTrack progression={props.progression} />
          : track === "warrior"
            ? <LaunchClassesView {...props} />
            : selected
              ? <ProfessionTrack track={track} progress={selected} oilWell={props.oilWell} oilWellStructureId={props.oilWellStructureId} onRemoteHarvestOilWell={props.onRemoteHarvestOilWell} />
              : null}
      </div>
    </aside>
  </div>;
}

function LaunchClassesView(props: Props): React.JSX.Element {
  const [selectedId, setSelectedId] = useState<LaunchClassId>(
    LAUNCH_CLASS_IDS.includes(props.snapshot!.activeClassId as LaunchClassId)
      ? props.snapshot!.activeClassId as LaunchClassId : "warrior"
  );
  const [confirmUnlock, setConfirmUnlock] = useState<LaunchClassId | null>(null);
  const unlocked = new Set(props.snapshot!.unlockedClassIds ?? ["warrior"]);
  const selectedProgress = props.snapshot!.classes?.find(({ classId }) => classId === selectedId);
  const definition = CLASS_DEFINITIONS[selectedId];
  return <section className="launch-classes-view">
    <nav className="class-selector launch-class-selector" aria-label="Launch classes">
      {LAUNCH_CLASS_IDS.map((classId) => {
        const progress = props.snapshot!.classes?.find((entry) => entry.classId === classId);
        const isUnlocked = unlocked.has(classId);
        const isCurrent = classId === props.snapshot!.activeClassId;
        const name = CLASS_DEFINITIONS[classId].name;
        return <button type="button" key={classId} className={selectedId === classId ? "active" : undefined}
          aria-pressed={selectedId === classId}
          aria-current={isCurrent ? "true" : undefined}
          data-locked={!isUnlocked || undefined}
          onClick={() => setSelectedId(classId)}>
          <span className="launch-class-mark" aria-hidden="true">{name[0]}</span>
          <span className="launch-class-copy"><strong>{name}</strong><small>{isUnlocked ? "Unlocked" : "Locked"}</small></span>
          {isCurrent ? <span className="launch-class-equipped">Equipped</span> : null}
          <span className="launch-class-rank">{isUnlocked ? `Rank ${progress?.level ?? 0}` : "Free"}</span>
        </button>;
      })}
    </nav>
    {!unlocked.has(selectedId) ? <section className="warrior-launch-view class-unlock-card">
      <div className="warrior-mastery-header"><div><span>{definition.name}</span><strong>Locked</strong></div>
        <div><strong>Unlock permanently</strong><small>No Gold required</small></div></div>
      <p>Unlock at no cost. Existing progress is preserved, and switching between unlocked classes is free.</p>
      <button type="button" className="primary" disabled={props.busy} onClick={() => setConfirmUnlock(selectedId)}>Unlock {definition.name}</button>
    </section> : <LaunchClassDetail key={selectedId}
      {...props}
      classId={selectedId}
      rank={selectedId === "warrior" ? props.masteries!.warrior.rank : selectedProgress?.level ?? 0}
      xp={selectedId === "warrior" ? props.masteries!.warrior.xp : selectedProgress?.xp ?? 0}
    />}
    {confirmUnlock ? <GameConfirmationPrompt
      title={`Unlock ${CLASS_DEFINITIONS[confirmUnlock].name} permanently?`}
      category="CLASS UNLOCK"
      detail="No Gold is deducted. The unlock is permanent."
      confirmLabel="Unlock class"
      busy={props.busy}
      onConfirm={() => { props.onUnlockClass?.(confirmUnlock); setConfirmUnlock(null); }}
      onCancel={() => setConfirmUnlock(null)}
    /> : null}
  </section>;
}

function LaunchClassDetail(props: Props & { classId: LaunchClassId; rank: number; xp: number }): React.JSX.Element {
  const [section, setSection] = useState<LaunchClassSection>("innate");
  const [serverNow, setServerNow] = useState(() => props.synchronizedNow?.() ?? Date.now());
  useEffect(() => {
    const update = (): void => setServerNow(props.synchronizedNow?.() ?? Date.now());
    update();
    const timer = window.setInterval(update, 1_000);
    return () => window.clearInterval(timer);
  }, [props.synchronizedNow]);
  const definition = CLASS_DEFINITIONS[props.classId];
  const isCurrent = props.snapshot!.activeClassId === props.classId;
  const rankProgress = classRankXpProgress(props.xp, props.rank, CLASS_XP_THRESHOLDS);
  const activeIds = props.snapshot!.loadout.normalActives;
  const passiveTiers = [0, 10, 20] as const;
  return <section className="warrior-launch-view launch-class-detail">
    <div className="warrior-mastery-header class-overview-card">
      <div><span>{definition.name}</span><strong>Rank {props.rank} / {CLASS_MAX_RANK}</strong></div>
      <div className="class-overview-progress"><strong>{rankProgress.mastered
        ? `${props.xp.toLocaleString()} total ${definition.name} XP`
        : `${rankProgress.earned.toLocaleString()} / ${rankProgress.required.toLocaleString()} Rank XP`}</strong>
        <small>{rankProgress.mastered ? "Mastered" : `${rankProgress.remaining.toLocaleString()} XP to Rank ${props.rank + 1}`}</small></div>
      <div className="class-overview-action">
        {isCurrent
          ? <span className="class-equipped-badge">Equipped class</span>
          : <button type="button" className="primary" disabled={props.busy} onClick={() => props.onClass?.(props.classId)}>Equip {definition.name}</button>}
      </div>
      <ProgressMeter label={`${definition.name} Rank ${props.rank} progress`} maximum={rankProgress.required} value={rankProgress.earned} />
    </div>
    <nav className="class-detail-tabs" role="tablist" aria-label={`${definition.name} details`}>
      {([
        ["innate", "Innate"],
        ["skills", "Class Skills"],
        ["passives", "Passives"],
        ["mastery", "Mastery"]
      ] as const).map(([id, label]) => <button type="button" role="tab" key={id} aria-selected={section === id} onClick={() => setSection(id)}>{label}</button>)}
    </nav>
    {section === "innate" ? <section className="class-innate-section" aria-labelledby={`${props.classId}-innate-title`}>
      <header><span className="warrior-card-label">Permanent class innate</span><h2 id={`${props.classId}-innate-title`}>{definition.innate.name}</h2></header>
      <p>{definition.innate.description}</p>
      <ClassInnateState classId={props.classId} combat={isCurrent ? props.combat ?? null : null} serverNow={serverNow} />
      <small>Always active while {definition.name} is equipped. It does not use an ability or passive slot.</small>
    </section> : null}
    {section === "skills" ? <section className="warrior-active-section"><header><div><h2>Class Skills</h2><p>Equip one skill before Rank 4 and up to two afterward.</p></div></header>
      <div className="warrior-ability-pair">{definition.normals.map((ability) => <article key={ability.id} className={`warrior-active-card launch-class-ability-card ${props.rank < ability.unlockLevel ? "locked" : activeIds.includes(ability.id) ? "equipped" : "available"}`}>
        <div className="warrior-active-card-body"><div className="class-ability-heading"><span className="class-ability-art"><ClassAbilityIcon abilityId={ability.id} /></span><h3>{ability.name}</h3></div><p>{ability.description}</p>
          <div className="class-skill-meta"><span>Rank {ability.unlockLevel}</span><span>{ability.cooldownMs / 1_000}s cooldown</span></div>
          {props.rank < ability.unlockLevel ? <small className="class-skill-lock">Unlocks at {definition.name} Rank {ability.unlockLevel}</small> : null}
          {isCurrent ? <ClassSkillSlotActions classId={props.classId} ability={ability} rank={props.rank} loadout={props.snapshot!.loadout} busy={props.busy} onLoadout={props.onLoadout} /> : null}
        </div>
      </article>)}</div>
    </section> : null}
    {section === "passives" ? <section className="warrior-passive-section"><header><h2>Passive Skills</h2><p>Choose one from each tier at Ranks 2, 7, and 12.</p></header>
      <div className="warrior-passive-list">{passiveTiers.map((tier, index) => definition.passiveTiers[tier].length > 0 ? <section key={tier} className={props.rank >= [2, 7, 12][index]! ? "active" : "locked"}>
        <header><h3>Passive Slot {index + 1}</h3><strong>Rank {[2, 7, 12][index]}</strong></header>
        <div className="warrior-ability-pair">{definition.passiveTiers[tier].map((ability) => {
          const equipped = props.snapshot!.loadout.passiveTiers[index] === ability.id;
          return <article key={ability.id} className={`warrior-active-card launch-class-ability-card ${equipped ? "equipped" : "available"}`}>
            <div className="warrior-active-card-body"><h3>{ability.name}</h3><p>{ability.description}</p><div className="class-skill-meta"><span>Rank {ability.unlockLevel}</span><span>Passive</span></div>
              {props.rank < ability.unlockLevel ? <small className="class-skill-lock">Unlocks at {definition.name} Rank {ability.unlockLevel}</small>
                : isCurrent ? <button type="button" className="class-skill-action primary" disabled={props.busy || equipped} aria-pressed={equipped} onClick={() => props.onLoadout({
                  ...props.snapshot!.loadout,
                  passiveTiers: props.snapshot!.loadout.passiveTiers.map((id, slot) => slot === index ? ability.id : id)
                })}>{equipped ? "Equipped" : "Equip"}</button> : null}
            </div>
          </article>;
        })}</div>
      </section> : null)}</div></section> : null}
    {section === "mastery" ? <section className="warrior-overview-grid class-mastery-view"><article><span className="warrior-card-label">Mastery &amp; inherent traits</span>
      {definition.guaranteedTraits.map((trait) => <EquipmentMasteryTrait key={trait.id} trait={trait} rank={props.rank} />)}
      {definition.guaranteedTraits.length === 0 ? <p className="empty-state">No {definition.name} mastery traits are defined yet.</p> : null}</article>
      <article><span className="warrior-card-label">Master title</span><strong>Master {definition.name}</strong><p>Granted at Rank 15.</p></article></section> : null}
  </section>;
}

function ClassInnateState({ classId, combat, serverNow }: {
  classId: LaunchClassId;
  combat: ClassCombatState | null;
  serverNow: number;
}): React.JSX.Element {
  const innate = combat?.activeClassId === classId ? combat.innate : null;
  if (!innate) return <div className="class-innate-state is-unavailable" role="status">Equip this class to see its live innate state.</div>;
  switch (innate.id) {
    case "warrior_unrelenting_rage":
      return <div className="class-innate-state" role="status">
        <strong>{innate.damageBonus > 0 ? `+${innate.damageBonus} damage tier` : "No low-health damage bonus"}</strong>
        <span>+{innate.maxHealthBonus} maximum HP</span>
      </div>;
    case "ninja_way_of_the_ninja": {
      const invisible = innate.invisibleEndsAt !== null && innate.invisibleEndsAt > serverNow;
      const dodgePercent = innate.dodgeChance <= 1 ? innate.dodgeChance * 100 : innate.dodgeChance;
      return <div className="class-innate-state" role="status">
        <strong>{innate.armorActive ? `${Math.round(dodgePercent)}% Dodge · Tunic active` : "Inactive · Requires Tunic"}</strong>
        <span>{invisible ? `Invisible · ${formatRemaining(innate.invisibleEndsAt ?? serverNow, serverNow)}` : `Emergency stealth ${cooldownText(innate.cooldownEndsAt, serverNow).toLowerCase()}`}</span>
      </div>;
    }
  }
}

function cooldownText(endsAt: number | null, serverNow: number): string {
  return endsAt === null || endsAt <= serverNow ? "Ready" : `Cooldown ${formatRemaining(endsAt, serverNow)}`;
}

function formatRemaining(endsAt: number, serverNow: number): string {
  const seconds = Math.max(0, Math.ceil((endsAt - serverNow) / 1_000));
  return seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`;
}

function phoneProgressionTitle(initialSection: string | undefined): "Classes" | "Professions" {
  return initialSection !== undefined && initialSection in TRACK_LABELS && initialSection !== "character" && initialSection !== "warrior"
    ? "Professions"
    : "Classes";
}

function EquipmentMasteryTrait({ trait, rank }: {
  trait: { name: string; description: string; levels: readonly number[] };
  rank?: number;
}): React.JSX.Element {
  const inherentRank = trait.levels.length === 1 ? trait.levels[0]! : null;
  return <div className="class-mastery-trait"><strong>{trait.name}</strong><p>{trait.description}</p>
    {inherentRank !== null
      ? <div className="class-mastery-levels class-inherent-trait" aria-label={`${trait.name} inherent trait`}>
          <span data-earned={rank !== undefined && rank >= inherentRank || undefined}><small>Inherent trait</small><strong>Rank {inherentRank}</strong></span>
        </div>
      : <div className="class-mastery-levels" aria-label={`${trait.name} bonuses by rank`}>
          {trait.levels.map((requiredRank, index) => <span key={requiredRank} data-earned={rank !== undefined && rank >= requiredRank || undefined}><small>Rank {requiredRank}</small><strong>+{index + 1}</strong></span>)}
        </div>}
  </div>;
}

function ClassSkillSlotActions({ classId, ability, rank, loadout, busy, onLoadout }: {
  classId: LaunchClassId;
  ability: TechniqueDefinition;
  rank: number;
  loadout: ClassLoadoutView;
  busy: boolean;
  onLoadout(loadout: ClassLoadoutView): void;
}): React.JSX.Element {
  const unlocked = rank >= ability.unlockLevel;
  return <div className="class-skill-slot-actions" aria-label={`${ability.name} loadout slots`}>
    {([0, 1] as const).map((slot) => {
      const equipped = loadout.normalActives[slot] === ability.id;
      const slotUnlocked = slot === 0 || rank >= 4;
      const disabledReason = !unlocked
        ? `Unlocks at ${CLASS_DEFINITIONS[classId].name} Rank ${ability.unlockLevel}`
        : !slotUnlocked ? `Skill slot 2 unlocks at ${CLASS_DEFINITIONS[classId].name} Rank 4` : null;
      return <button
        type="button"
        className="class-skill-action primary"
        key={slot}
        disabled={busy || !unlocked || !slotUnlocked || equipped}
        aria-pressed={equipped}
        title={disabledReason ?? undefined}
        onClick={() => onLoadout(equipClassAbilityToSlot(loadout, classId, ability.id, rank, slot))}
      >{equipped ? `Equipped ${slot + 1}` : `Equip ${slot + 1}`}</button>;
    })}
  </div>;
}

function DevelopmentProgression(props: Props & { scope?: "all" | "classes" | "professions" }): React.JSX.Element {
  const scope = props.scope ?? "all";
  return <section className="dev-progression">
    <header><div><strong>Direct progression</strong><small>Development only · adjusts one level or profession rank</small></div></header>
    {props.devProgressionError ? <p className="dev-progression-error" role="alert">{props.devProgressionError}</p> : null}
    <div className="dev-progression-controls">
      {scope !== "professions" ? <DevRankControl label="Character" type="character_level" rank={props.progression!.level} maximum={CURRENT_LEVEL_CAP} {...props} /> : null}
      {scope !== "classes" ? <>
        <DevRankControl label="Woodcutter" type="woodcutter_level" rank={props.masteries!.professions.woodcutter.rank} maximum={8} {...props} />
        <DevRankControl label="Miner" type="miner_level" rank={props.masteries!.professions.miner.rank} maximum={8} {...props} />
        <DevRankControl label="Builder" type="builder_level" rank={props.masteries!.professions.builder.rank} maximum={8} {...props} />
        <DevRankControl label="Oil Worker" type="oil_worker_level" rank={props.masteries!.professions.oil_worker.rank} maximum={8} {...props} />
        <DevRankControl label="Metallurgy" type="metallurgy_level" rank={props.masteries!.professions.metallurgy.rank} maximum={8} {...props} />
      </> : null}
    </div>
    {scope !== "professions" ? <section aria-label="Retained Classes catalog"><h3>Retained Classes</h3><p>Developer-only registry view · all 16 backend definitions</p><div className="dev-retained-class-catalog">{SPECIALIZATION_IDS.map((id) => {
      const definition = SPECIALIZATION_DEFINITIONS[id];
      return <article key={id}><header><strong>{definition.displayName}</strong><code>{id}</code></header><small>Gateway: {definition.gatewaySkillId ? GENERAL_SKILL_DEFINITIONS[definition.gatewaySkillId].displayName : "Pending"}</small><small>{"Class roster"} · {definition.status}</small><ol>{definition.ranks.map((rank) => <li key={rank.rank}>Rank {rank.rank}: {rank.description}</li>)}</ol></article>;
    })}</div></section> : null}
  </section>;
}

function CharacterTrack({ progression }: { progression: ProgressionSnapshot }): React.JSX.Element {
  const next = progression.nextLevelTotalXp;
  return <section><h2>Character Level {progression.level}/{CURRENT_LEVEL_CAP}</h2>
    <p><strong>{progression.totalXp.toLocaleString()} Lifetime Character XP</strong></p>
    <ProgressMeter
      label={progression.atCap ? "Enchantment Stone progress" : "Character progression"}
      maximum={progression.atCap ? progression.xpForNextLevel ?? 1 : MAX_CURRENT_ERA_XP}
      value={progression.atCap ? progression.xpIntoLevel : progression.totalXp}
    />
    <p>{next === null
      ? `${((progression.xpForNextLevel ?? 0) - progression.xpIntoLevel).toLocaleString()} XP to an Enchantment Stone`
      : `${(next - progression.totalXp).toLocaleString()} XP to Level ${progression.level + 1}`}</p>
    <p>Character Progression Curve V3 is independent from Warrior and profession XP.</p>
    <p>Ordinary maximum health is fixed at 100. Character levels improve combat power without increasing health.</p>
  </section>;
}

export { ProfessionTrack };

function classRankXpProgress(xp: number, rank: number, thresholds: readonly number[]): {
  earned: number;
  required: number;
  remaining: number;
  mastered: boolean;
} {
  const currentThreshold = thresholds[Math.max(0, Math.min(rank, thresholds.length - 1))] ?? 0;
  const nextThreshold = thresholds[rank + 1];
  if (nextThreshold === undefined) return { earned: 1, required: 1, remaining: 0, mastered: true };
  const required = Math.max(1, nextThreshold - currentThreshold);
  const earned = Math.max(0, Math.min(required, xp - currentThreshold));
  return { earned, required, remaining: Math.max(0, nextThreshold - xp), mastered: false };
}

export const ClassesPanel = WarriorClassPanel;

function DevRankControl({
  label,
  type,
  rank,
  maximum,
  devProgressionPendingType,
  onAdjustDevProgression
}: Pick<Props, "devProgressionPendingType" | "onAdjustDevProgression"> & {
  label: string;
  type: DevProgressionType;
  rank: number;
  maximum: number;
}): React.JSX.Element {
  const pending = devProgressionPendingType === type;
  const terminology = type === "character_level" ? "Level" : "Rank";
  const accessibleTerminology = terminology.toLowerCase();
  return <div className="dev-rank-control" aria-busy={pending}>
    <strong>{label} {terminology}</strong>
    <div>
      <button type="button" aria-label={`Decrease ${label} ${accessibleTerminology}`} disabled={pending || rank <= 0} onClick={() => onAdjustDevProgression(type, rank - 1)}>−</button>
      <output aria-label={`${label} ${accessibleTerminology}`}>{rank}/{maximum}</output>
      <button type="button" aria-label={`Increase ${label} ${accessibleTerminology}`} disabled={pending || rank >= maximum} onClick={() => onAdjustDevProgression(type, rank + 1)}>+</button>
    </div>
  </div>;
}

export function equipClassAbilityToSlot(
  loadout: ClassLoadoutView,
  classId: LaunchClassId,
  abilityId: string,
  rank: number,
  slot: 0 | 1
): ClassLoadoutView {
  const definition = TECHNIQUE_BY_ID[abilityId];
  if (definition?.classId !== classId || definition.subclassId !== null || definition.kind !== "normal" ||
    rank < definition.unlockLevel || (slot === 1 && rank < 4)) return loadout;
  const skills = [...loadout.normalActives];
  const previousSlot = skills.findIndex((id) => id === abilityId);
  if (previousSlot >= 0 && previousSlot !== slot) skills[previousSlot] = null;
  skills[slot] = abilityId;
  if (rank < 4) skills[1] = null;
  return { resetActives: [null, null], normalActives: skills, passiveTiers: [...loadout.passiveTiers], ultimateActive: loadout.ultimateActive };
}

function isTrack(value: string | undefined): value is Track {
  return value !== undefined && value in TRACK_LABELS;
}
