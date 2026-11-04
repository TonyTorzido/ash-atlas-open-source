import {
  CLASS_WRITS,
  DUNGEON_SKILL_TURN_INS,
  GENERAL_SKILL_OFFERINGS,
  WORLD_KNOWLEDGE_OVERWORLD_PARTS,
  offeringProgress,
  type SkillUnlockState,
  type UnlockOfferingPart,
  GENERAL_ACTIVE_SLOT_IDS,
  GENERAL_SKILL_DEFINITIONS,
  GENERAL_SKILL_IDS,
  INVENTORY_CATALOG,
  LAUNCH_CLASS_TITLES,
  LAUNCH_SPECIALIZATION_IDS,
  SPECIALIZATION_DEFINITIONS,
  SPECIALIZATION_IDS,
  TRADE_SKILL_IDS,
  VISIBLE_GENERAL_SKILL_IDS,
  WORLD_KNOWLEDGE_SKILL_DEFINITIONS,
  WORLD_KNOWLEDGE_SKILL_IDS,
  dungeonDefinition,
  costForNextGeneralSkillRank,
  costForNextSpecializationRank,
  gatewaySatisfied,
  isStarterSpecializationId,
  isGeneralSkillAvailable,
  isSpecializationAvailable,
  MERCHANT_MAXIMIZE_TACTICS_ABILITY_ID,
  merchantMaximizeTacticsCostGold,
  SPECIALIZATION_RANK_LEVEL_GATES,
  levelGateForNextSpecializationRank,
  type AchievementSnapshot,
  type EquipmentSnapshotV2,
  type GeneralActiveSlotId,
  type GeneralSkillId,
  type MasterySnapshot,
  type OilWellSnapshot,
  type PlayerInventorySnapshot,
  type SkillDefinition,
  type SkillSystemV3Snapshot,
  type SpecializationId,
  type WorldKnowledgeSkillDefinition,
  type WorldKnowledgeSkillId,
  type TradeSkillId,
} from "@ash-atlas/shared";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { GameAppEmptyState, GameAppShell, GameAppTabs } from "./GameAppShell.js";
import { GameConfirmationPrompt } from "./GameActionPrompt.js";
import { AchievementsContent } from "./AchievementsPanel.js";
import { classIconProps } from "./ClassIcons.js";
import { StatGlyph } from "./MenuDestinationGlyph.js";
import { generalSkillIconProps } from "./GeneralSkillIcons.js";
import { ProfessionsContent, type ProfessionBackOverride } from "./ProfessionsDestination.js";
import { PhoneMenuFooterButtons } from "./PhoneMenuDestinationShell.js";
import { DetailHeader, ProgressionStrip } from "./ProgressionDetailHeader.js";
import { ProgressionDetailSheet, useRetainedSheet } from "./ProgressionDetailSheet.js";
import { RankLadder } from "./RankLadder.js";
import { WORLD_KNOWLEDGE_ICON_SRC } from "./WorldKnowledgeIcons.js";
import { ProgressionIcon } from "./ProgressionIcon.js";
import { MaterialChips, type MaterialNeed } from "./MaterialRequirements.js";

import "./SkillTreeV3Panel.css";

/** Every general skill whose shared category is "gateway" is a discipline; new disciplines need no UI code. */
export const DISCIPLINE_IDS: readonly GeneralSkillId[] = GENERAL_SKILL_IDS.filter((id) => GENERAL_SKILL_DEFINITIONS[id].category === "gateway");
/** Mirrors the shared `gatewaySatisfied` rule: a class unlocks at gateway Rank 3. */
const CLASS_GATEWAY_RANK = 3;

/** "general" is the Skills tab (kept for stored and external selections); "class" and "knowledge" are their own tabs. */
export type SkillTreeV3Section = "class" | "general" | "professions" | "knowledge" | "achievements";
export type SkillTreeV3Selection = Readonly<{
  section: SkillTreeV3Section;
  /** Legacy discipline-page selector; the single-scroll skill ledger ignores it. */
  gatewayId?: GeneralSkillId;
  /** A gateway or skill whose detail sheet is open. */
  generalSkillId?: GeneralSkillId;
  /** A class whose detail sheet is open. */
  specializationId?: SpecializationId;
  /** The cross-discipline class overview sheet is open. */
  classOverview?: boolean;
  worldKnowledgeSkillId?: WorldKnowledgeSkillId;
}>;
export type SkillTreeV3RankTarget =
  | Readonly<{ kind: "general"; id: GeneralSkillId }>
  | Readonly<{ kind: "specialization"; id: SpecializationId }>
  | Readonly<{ kind: "knowledge"; id: WorldKnowledgeSkillId }>;
export type SkillTreeV3PanelProps = Readonly<{
  open: boolean;
  layout: "desktop" | "phone";
  snapshot: SkillSystemV3Snapshot | null;
  achievements?: AchievementSnapshot | null;
  /** Token counts for the Knowledge tab (dungeon turn-ins). */
  inventory?: PlayerInventorySnapshot | null;
  serverHttpBase?: string;
  busy: boolean;
  error: string | null;
  selection: SkillTreeV3Selection;
  /** Developer view: list every class, including ones outside the launch roster. */
  revealAllClasses?: boolean;
  equipment?: EquipmentSnapshotV2 | null;
  masteries: MasterySnapshot | null;
  oilWell?: OilWellSnapshot | null;
  oilWellStructureId?: string | null;
  onSelectionChange(selection: SkillTreeV3Selection): void;
  onSpend(target: SkillTreeV3RankTarget): void;
  /** Offerings and writs already made; null until the server reports them. */
  unlocks?: SkillUnlockState | null;
  /** Makes the one-time discovery offering of an Advanced General skill. */
  onOffer?(skillId: GeneralSkillId): void;
  /** Equips a class, or drops back to no class with null (Ronin and Warrior switch freely). */
  onActivate(id: SpecializationId | null): void;
  onEquip(slot: GeneralActiveSlotId, skillId: GeneralSkillId | null): void;
  onUse(techniqueId: string): void;
  onRespec(): void;
  /** Glimmer price of a full build respec (server-reported); null or absent = free. */
  respecGlimmerCost?: number | null;
  onRequestOilWellStatus?(): void;
  onRemoteHarvestOilWell?(): void;
  onRequest(): void;
  onClose(): void;
  onReturnToGame(): void;
}>;

type SkillBranch = Readonly<{ label: string; skills: readonly GeneralSkillId[] }>;
type SkillFamily = Readonly<{
  gateway: GeneralSkillId;
  label: string;
  branches: readonly SkillBranch[];
}>;

/** Presentation grouping only; skills, prerequisites, and classes come from shared definitions. */
const DISCIPLINE_BRANCH_CATALOG: Readonly<Partial<Record<GeneralSkillId, readonly SkillBranch[]>>> = {
  cleave: [
    { label: "Frontline", skills: ["shield_charge", "provoke", "pursuit"] },
    { label: "Assault", skills: ["pierce_armor", "blight_strike"] },
    { label: "Sustain", skills: ["second_wind", "deathburst"] },
  ],
  archery: [{ label: "Marksmanship", skills: ["ricochet", "quarry_sense", "huntsmans_edge", "concentration"] }],
  martial_arts: [{ label: "Precision", skills: ["perfect_strike"] }],
  tactics: [
    { label: "Command", skills: ["taunt", "war_standard", "heroism"] },
    { label: "Survival", skills: ["cleanse", "calm_mind"] },
    { label: "Scavenging", skills: ["scavenge"] },
    { label: "Exploration", skills: ["companion_bond", "delvers_lore"] },
  ],
};

const visibleGeneralSkillIds = new Set<GeneralSkillId>(VISIBLE_GENERAL_SKILL_IDS);
export const GENERAL_SKILL_FAMILIES: readonly SkillFamily[] = DISCIPLINE_IDS.map((gateway) => ({
  gateway,
  label: GENERAL_SKILL_DEFINITIONS[gateway].displayName,
  branches: (DISCIPLINE_BRANCH_CATALOG[gateway] ?? [])
    .map((branch) => ({ ...branch, skills: branch.skills.filter((id) => visibleGeneralSkillIds.has(id)) }))
    .filter((branch) => branch.skills.length > 0),
}));
const mappedGeneralSkillIds = [...GENERAL_SKILL_FAMILIES.flatMap((family) => [family.gateway, ...family.branches.flatMap((branch) => branch.skills)]), ...TRADE_SKILL_IDS];
if (mappedGeneralSkillIds.length !== VISIBLE_GENERAL_SKILL_IDS.length || new Set(mappedGeneralSkillIds).size !== VISIBLE_GENERAL_SKILL_IDS.length) {
  throw new Error("General skill families must map every visible skill exactly once.");
}

const isDisciplineId = (value: GeneralSkillId | undefined | null): value is GeneralSkillId => value !== undefined && value !== null && DISCIPLINE_IDS.includes(value);
const maxRankOf = (id: GeneralSkillId): number => GENERAL_SKILL_DEFINITIONS[id].rankDefinitions.length;
const classMaxRankOf = (id: SpecializationId): number => SPECIALIZATION_DEFINITIONS[id].ranks.length;
const rankOf = (snapshot: SkillSystemV3Snapshot, id: GeneralSkillId): number => snapshot.generalSkills.find((entry) => entry.skillId === id)?.rank ?? 0;
/** Rank 1 of an Advanced skill still waits on its one-time discovery offering. */
const offeringPending = (snapshot: SkillSystemV3Snapshot, unlocks: SkillUnlockState | null | undefined, id: GeneralSkillId): boolean =>
  GENERAL_SKILL_OFFERINGS[id] !== undefined && rankOf(snapshot, id) === 0 && !(unlocks?.discoveredGeneralSkills.includes(id) ?? false);
/** Rank 1 of a class still waits on its one-time writ. */
const writPending = (snapshot: SkillSystemV3Snapshot, unlocks: SkillUnlockState | null | undefined, id: SpecializationId): boolean =>
  CLASS_WRITS[id] !== undefined && (snapshot.specializations.find((entry) => entry.specializationId === id)?.rank ?? 0) === 0
  && !(unlocks?.classWrits.includes(id) ?? false);
const inventoryCount = (inventory: PlayerInventorySnapshot | null | undefined, itemId: string): number =>
  (inventory?.items ?? []).reduce((sum, item) => item.resourceType === itemId && (item.variant ?? null) === null ? sum + item.quantity : sum, 0);
/** Chips for an offering: each item's art, have and need (an "any trophy" part shows the one that would be used). */
function offeringNeeds(parts: readonly UnlockOfferingPart[], inventory: PlayerInventorySnapshot | null | undefined): Readonly<{ needs: MaterialNeed[]; ready: boolean }> {
  const progress = offeringProgress(parts, (itemId) => inventoryCount(inventory, itemId));
  return {
    needs: progress.map((part) => ({ itemId: part.itemId, name: part.label, quantity: part.need, have: part.have })),
    ready: progress.every((part) => part.met)
  };
}
const knowledgeState = (snapshot: SkillSystemV3Snapshot, id: WorldKnowledgeSkillId) => snapshot.worldKnowledge.find((entry) => entry.skillId === id);
const knowledgeSpendReason = (snapshot: SkillSystemV3Snapshot, id: WorldKnowledgeSkillId, busy: boolean): string | null => {
  const definition = WORLD_KNOWLEDGE_SKILL_DEFINITIONS[id];
  const state = knowledgeState(snapshot, id);
  const cost = definition.ranks[state?.rank ?? 0]?.cost ?? null;
  if (busy) return "Waiting for server confirmation.";
  if (!state?.revealed) return "Discover this knowledge in the world first.";
  if (definition.status !== "implemented") return "Coming Soon — this knowledge is not yet available.";
  if (cost === null) return "Maximum rank reached.";
  if (snapshot.pointState.available < cost) return `Requires ${cost} available SP.`;
  return null;
};
const classState = (snapshot: SkillSystemV3Snapshot, id: SpecializationId) => snapshot.specializations.find((entry) => entry.specializationId === id);
const classAvailable = (snapshot: SkillSystemV3Snapshot, id: SpecializationId): boolean => isSpecializationAvailable(id, { fullClassRosterEnabled: snapshot.fullClassRosterEnabled, ultimatesEnabled: false });
/** The old combat skills are hidden unless the dev flag is on; the Trades always show (isGeneralSkillAvailable). */
const skillShown = (snapshot: SkillSystemV3Snapshot, id: GeneralSkillId): boolean => isGeneralSkillAvailable(id, { fullClassRosterEnabled: snapshot.fullClassRosterEnabled, ultimatesEnabled: false });
const classGatewayMet = (snapshot: SkillSystemV3Snapshot, id: SpecializationId): boolean => gatewaySatisfied(
  id,
  snapshot.characterLevel,
  Object.fromEntries(snapshot.generalSkills.map((skill) => [skill.skillId, skill.rank])),
  classState(snapshot, id)?.grandfathered,
);
/** The class the build is committed to; the server makes the committed class active at Rank 1. */
const currentClassId = (snapshot: SkillSystemV3Snapshot): SpecializationId | null => {
  const id = snapshot.committedSpecializationId ?? snapshot.activeSpecializationId;
  return id !== null && classAvailable(snapshot, id) ? id : null;
};

function classIdsForGateway(gatewayId: GeneralSkillId, revealAll: boolean): readonly SpecializationId[] {
  return (revealAll ? SPECIALIZATION_IDS : LAUNCH_SPECIALIZATION_IDS).filter((id) => SPECIALIZATION_DEFINITIONS[id].gatewaySkillId === gatewayId);
}

const formatBaseCooldown = (cooldownMs: number): string => {
  const seconds = Math.round(cooldownMs / 1000);
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return minutes > 0 ? `${minutes}m${remainder ? ` ${remainder}s` : ""}` : `${seconds}s`;
};
const formatRemainingCooldown = (cooldownEndsAt: number | undefined, serverTime: number): string => cooldownEndsAt === undefined || cooldownEndsAt <= serverTime
  ? "Ready"
  : `${Math.ceil((cooldownEndsAt - serverTime) / 1000)}s remaining`;

/** "Archery 1/3" style progress toward a rank requirement. */
const requirementProgress = (snapshot: SkillSystemV3Snapshot, skillId: GeneralSkillId, required: number): string =>
  `${GENERAL_SKILL_DEFINITIONS[skillId].displayName} ${Math.min(rankOf(snapshot, skillId), required)}/${required}`;

function generalSpendReason(snapshot: SkillSystemV3Snapshot, definition: SkillDefinition, busy: boolean, unlocks?: SkillUnlockState | null): string | null {
  const rank = rankOf(snapshot, definition.id);
  const cost = costForNextGeneralSkillRank(definition.id, rank);
  if (busy) return "Waiting for server confirmation.";
  if (cost === null) return "Maximum rank reached.";
  const missing = definition.prerequisites.find((item) => rankOf(snapshot, item.skillId) < item.rank);
  if (missing) return `Requires ${requirementProgress(snapshot, missing.skillId, missing.rank)}.`;
  if (definition.status !== "implemented" || definition.catalogVisibility !== "visible" || !skillShown(snapshot, definition.id)) return "Coming soon.";
  if (definition.worldUnlockRequirement) return `World discovery required: ${definition.worldUnlockRequirement}.`;
  if (offeringPending(snapshot, unlocks, definition.id)) return "Make the discovery offering first.";
  if (snapshot.pointState.available < cost) return `Requires ${cost} available SP.`;
  return null;
}

function generalVisibleState(snapshot: SkillSystemV3Snapshot, definition: SkillDefinition, unlocks?: SkillUnlockState | null): Readonly<{ key: string; label: string; reason: string }> {
  const rank = rankOf(snapshot, definition.id);
  if (rank >= maxRankOf(definition.id)) return { key: "maxed", label: "Maxed", reason: "" };
  if (rank > 0) return { key: "learned", label: "Learned", reason: "" };
  const missing = definition.prerequisites.find((item) => rankOf(snapshot, item.skillId) < item.rank);
  if (missing) return { key: "prerequisite", label: "Locked", reason: `Requires ${requirementProgress(snapshot, missing.skillId, missing.rank)}` };
  if (definition.status !== "implemented" || (rank === 0 && definition.catalogVisibility !== "visible")) return { key: "future", label: "Coming Soon", reason: "" };
  if (definition.worldUnlockRequirement) return { key: "world", label: "World locked", reason: definition.worldUnlockRequirement };
  if (offeringPending(snapshot, unlocks, definition.id)) return { key: "offering", label: "Offering", reason: "Needs offering" };
  return { key: "available", label: "Available", reason: "" };
}

type ClassStatus = "Active Class" | "Available" | "Class Locked" | "Locked" | "Unavailable";

/** One status for a class everywhere it appears. */
function classStatus(snapshot: SkillSystemV3Snapshot, id: SpecializationId): ClassStatus {
  const current = currentClassId(snapshot);
  if (current === id) return "Active Class";
  if (!classAvailable(snapshot, id)) return "Unavailable";
  if (current !== null && classAvailable(snapshot, current)) return "Class Locked";
  return classGatewayMet(snapshot, id) ? "Available" : "Locked";
}

/** What still blocks a class from unlocking, with progress; null once its gateway requirement is met. */
function classUnlockRequirement(snapshot: SkillSystemV3Snapshot, id: SpecializationId): string | null {
  const definition = SPECIALIZATION_DEFINITIONS[id];
  if (classState(snapshot, id)?.grandfathered) return null;
  if (isStarterSpecializationId(id)) return null;
  if (definition.gatewaySkillId === null) return "Class path not revealed yet";
  const parts: string[] = [];
  if (rankOf(snapshot, definition.gatewaySkillId) < CLASS_GATEWAY_RANK) parts.push(requirementProgress(snapshot, definition.gatewaySkillId, CLASS_GATEWAY_RANK));
  const levelGate = levelGateForNextSpecializationRank(0);
  if (levelGate !== null && snapshot.characterLevel < levelGate) parts.push(`Level ${snapshot.characterLevel}/${levelGate}`);
  return parts.length ? `Unlocks at ${parts.join(" · ")}` : null;
}

/** "Needs Archery 1 · Cleave 2": only the prerequisites still unmet, phrased like the ledger chips. */
const needsLine = (snapshot: SkillSystemV3Snapshot, definition: SkillDefinition): string | null => {
  const unmet = definition.prerequisites.filter((item) => rankOf(snapshot, item.skillId) < item.rank).map((item) => `${GENERAL_SKILL_DEFINITIONS[item.skillId].displayName} ${item.rank}`);
  return unmet.length ? `Needs ${unmet.join(" · ")}` : null;
};

/** What still blocks a class, in the same short voice; null once the gateway requirement is met. */
function classNeedsLine(snapshot: SkillSystemV3Snapshot, id: SpecializationId): string | null {
  const definition = SPECIALIZATION_DEFINITIONS[id];
  if (classState(snapshot, id)?.grandfathered) return null;
  if (isStarterSpecializationId(id)) return null;
  if (definition.gatewaySkillId === null) return "Class path not revealed yet";
  const parts: string[] = [];
  if (rankOf(snapshot, definition.gatewaySkillId) < CLASS_GATEWAY_RANK) parts.push(`${GENERAL_SKILL_DEFINITIONS[definition.gatewaySkillId].displayName} ${CLASS_GATEWAY_RANK}`);
  const levelGate = levelGateForNextSpecializationRank(0);
  if (levelGate !== null && snapshot.characterLevel < levelGate) parts.push(`Level ${levelGate}`);
  return parts.length ? `Needs ${parts.join(" · ")}` : null;
}

/** Transient or self-evident reasons (in-flight spend, max rank) stay off screen so a level-up doesn't shift the layout. */
const visibleReason = (reason: string | null): string | null => reason === "Waiting for server confirmation." || reason === "Maximum rank reached." ? null : reason;

function classActionReason(snapshot: SkillSystemV3Snapshot, id: SpecializationId, busy: boolean, writMissing = false): string | null {
  const committed = snapshot.committedSpecializationId;
  if (!classAvailable(snapshot, id)) return "This class is not enabled in the current environment.";
  if (busy) return "Waiting for server confirmation.";
  if (committed !== null && committed !== id) {
    if (classAvailable(snapshot, committed)) {
      return `${SPECIALIZATION_DEFINITIONS[committed].displayName} is your active class. ${snapshot.fullBuildRespecAvailable ? "Use Respec build to choose a different class." : "Class choice is permanent."}`;
    }
  }
  const requirement = classUnlockRequirement(snapshot, id);
  if (requirement !== null) return `${requirement}.`;
  const rank = classState(snapshot, id)?.rank ?? 0;
  if (rank > 0 && committed !== null && !classAvailable(snapshot, committed)) return null;
  const cost = costForNextSpecializationRank(id, rank);
  if (cost === null) return "Maximum rank reached.";
  const gate = levelGateForNextSpecializationRank(rank);
  const refunded = committed !== null && !classAvailable(snapshot, committed) ? classState(snapshot, committed)?.pointsSpent ?? 0 : 0;
  if (gate !== null && snapshot.characterLevel < gate) return `Rank ${rank + 1} unlocks at level ${gate}.`;
  if (snapshot.pointState.available + refunded < cost) return `Requires ${cost} available SP.`;
  if (writMissing) return "Bring the class writ items below.";
  return null;
}

/** The one-active-class rule, stated against the real server behavior. */
export function classRuleCopy(respecAvailable: boolean): string {
  return `Only one class can be active. Buying Rank 1 of any class makes it your active class and locks every other class; general skills stay open. ${respecAvailable
    ? "Respec build resets all skills and classes so you can choose again."
    : "This choice is permanent."}`;
}

function SkillPointSummary({ snapshot }: Readonly<{ snapshot: SkillSystemV3Snapshot | null }>): React.JSX.Element {
  return <ProgressionStrip label="Skill point status" left={<><span className="skill-v3-available"><strong>{snapshot?.pointState.available ?? "—"}</strong> SP available</span><span aria-hidden="true"> · </span><span>Spent <strong>{snapshot?.pointState.totalSpent ?? "—"}</strong></span></>} right={snapshot ? <>Level <strong>{snapshot.characterLevel}</strong></> : null} />;
}

const PROGRESSION_TABS = ["class", "skills", "knowledge", "professions", "achievements"] as const;
type ProgressionTab = (typeof PROGRESSION_TABS)[number];
const progressionTabOf = (section: SkillTreeV3Section): ProgressionTab => section === "general" ? "skills" : section === "knowledge" ? "knowledge" : section;
const sectionOfTab = (tab: ProgressionTab): SkillTreeV3Section => tab === "skills" ? "general" : tab;
const progressionTabStorageKey = (playerId: string | undefined): string => `ash-atlas:progression-tab:${playerId ?? "local"}`;
function readLastProgressionTab(playerId: string | undefined): ProgressionTab | null {
  try {
    const stored = window.localStorage.getItem(progressionTabStorageKey(playerId));
    return PROGRESSION_TABS.find((tab) => tab === stored) ?? null;
  } catch {
    return null;
  }
}
function writeLastProgressionTab(playerId: string | undefined, tab: ProgressionTab): void {
  try { window.localStorage.setItem(progressionTabStorageKey(playerId), tab); } catch { /* the tab still applies for this session */ }
}
/** Short rail labels keep five icon-over-label tabs on one phone row; the accessible names stay in full. */
const PROGRESSION_TAB_META: Readonly<Record<ProgressionTab, Readonly<{ label: string; name: string; icon: "character" | "classes" | "creature-book" | "crafting" | "achievements" }>>> = {
  class: { label: "Class", name: "Class", icon: "character" },
  skills: { label: "Skills", name: "Skills", icon: "classes" },
  knowledge: { label: "Knowledge", name: "Knowledge", icon: "creature-book" },
  professions: { label: "Trades", name: "Professions", icon: "crafting" },
  achievements: { label: "Awards", name: "Achievements", icon: "achievements" },
};

export function SkillTreeV3Panel(props: SkillTreeV3PanelProps): React.JSX.Element | null {
  const selection: SkillTreeV3Selection = props.selection;
  const professionsSelected = selection.section === "professions";
  const achievementsSelected = selection.section === "achievements";
  const skillsSelected = !professionsSelected && !achievementsSelected;
  const activeTab = progressionTabOf(selection.section);
  const sheetOpen = skillsSelected && (selection.classOverview === true || selection.specializationId !== undefined || selection.generalSkillId !== undefined || selection.worldKnowledgeSkillId !== undefined);
  /** Professions and Achievements publish their in-tab Back destination (open sheet, category page). */
  const [tabBackOverride, setTabBackOverride] = useState<ProfessionBackOverride | null>(null);
  const [respecConfirmation, setRespecConfirmation] = useState(false);
  /** The sheet stays mounted for its exit animation, so the docked column outlives `sheetOpen` briefly. */
  const [sheetShown, setSheetShown] = useState(false);

  useLayoutEffect(() => {
    setTabBackOverride(null);
    setRespecConfirmation(false);
  }, [props.open, props.layout, professionsSelected, achievementsSelected]);

  const childBackLabel = professionsSelected || achievementsSelected
    ? tabBackOverride?.label ?? "Back to Game Menu"
    : sheetOpen ? `Back to ${PROGRESSION_TAB_META[activeTab].name}` : "Back to Game Menu";

  const childBack = (): void => {
    if (professionsSelected || achievementsSelected) {
      if (tabBackOverride) tabBackOverride.onBack();
      else props.onClose();
    } else if (sheetOpen) {
      closeSheet();
    } else {
      props.onClose();
    }
  };
  const closeSheet = (): void => props.onSelectionChange({ section: selection.section });
  const playerId = props.snapshot?.playerId;
  const changeTab = (tab: string): void => {
    const next = PROGRESSION_TABS.find((candidate) => candidate === tab);
    if (!next) return;
    writeLastProgressionTab(playerId, next);
    props.onSelectionChange({ section: sectionOfTab(next) });
  };
  /** Reopen on the last tab this player used: once per open, and only when the panel opened on its default (Class, no sheet). */
  const restoredFor = useRef<string | null>(null);
  useEffect(() => {
    if (!props.open) { restoredFor.current = null; return; }
    if (playerId === undefined || restoredFor.current === playerId) return;
    restoredFor.current = playerId;
    const last = readLastProgressionTab(playerId);
    const isDefault = selection.section === "class" && !selection.classOverview && selection.specializationId === undefined && selection.generalSkillId === undefined && selection.worldKnowledgeSkillId === undefined;
    if (last && last !== "class" && isDefault) props.onSelectionChange({ section: sectionOfTab(last) });
  }, [props.open, playerId]); // eslint-disable-line react-hooks/exhaustive-deps

  const respecAction = props.snapshot?.fullBuildRespecAvailable
    ? <button type="button" className="skill-v3-header-respec game-app-button game-app-button-compact" disabled={props.busy} onClick={() => setRespecConfirmation(true)}>Respec build</button>
    : null;
  const headerAction = respecAction;

  return <GameAppShell
    open={props.open}
    layout={props.layout}
    title="Progression"
    menuId="classes"
    headerStatus={!headerAction && props.snapshot ? { value: props.snapshot.pointState.available, label: "Available SP" } : null}
    {...(headerAction ? { headerAction } : {})}
    closeLabel="Close Progression"
    className="skill-v3-shell"
    closeDisabled={props.busy}
    showDesktopClose={false}
    phoneBackLabel={childBackLabel}
    phoneOnBack={childBack}
    phoneOnEscape={sheetOpen ? closeSheet : childBack}
    phoneOnReturnToGame={props.onReturnToGame}
    footer={props.layout === "desktop" ? <PhoneMenuFooterButtons
      backLabel={childBackLabel}
      onBack={childBack}
      onReturnToGame={props.onReturnToGame}
      navigationDisabled={props.busy}
    /> : undefined}
    onClose={props.onClose}
  >
    <GameAppTabs
      variant="housed"
      className="skill-v3-section-tabs"
      ariaLabel="Progression sections"
      activeTab={activeTab}
      onChange={changeTab}
      tabs={PROGRESSION_TABS.map((tab) => ({
        id: tab,
        label: PROGRESSION_TAB_META[tab].label,
        ariaLabel: PROGRESSION_TAB_META[tab].name,
        icon: <StatGlyph icon={PROGRESSION_TAB_META[tab].icon} />,
      }))}
    />
    <div className={`skill-v3-app${professionsSelected ? " professions-section" : ""}${achievementsSelected ? " achievements-section" : ""}`} data-layout={props.layout}>
      {achievementsSelected ? <AchievementsContent achievements={props.achievements ?? null} layout={props.layout} onBackChange={setTabBackOverride} {...(props.serverHttpBase ? { serverHttpBase: props.serverHttpBase } : {})} {...(props.snapshot?.playerId ? { playerId: props.snapshot.playerId } : {})} /> : professionsSelected ? (
        <ProfessionsContent
          open={props.open}
          layout={props.layout}
          masteries={props.masteries}
          onBackChange={setTabBackOverride}
          {...(props.oilWell !== undefined ? { oilWell: props.oilWell } : {})}
          {...(props.oilWellStructureId !== undefined ? { oilWellStructureId: props.oilWellStructureId } : {})}
          {...(props.onRequestOilWellStatus ? { onRequestOilWellStatus: props.onRequestOilWellStatus } : {})}
          {...(props.onRemoteHarvestOilWell ? { onRemoteHarvestOilWell: props.onRemoteHarvestOilWell } : {})}
        />
      ) : <>
        <SkillPointSummary snapshot={props.snapshot} />
        <div className={`skill-v3-content${sheetOpen || sheetShown ? " has-sheet" : ""}`}>
          {props.error ? <div className="skill-v3-error" role="alert"><span>{props.error}</span><button type="button" onClick={props.onRequest} disabled={props.busy}>Retry</button></div> : null}
          {!props.snapshot ? <div className="skill-v3-loading" role="status"><span>Loading skills…</span><button className="primary" type="button" onClick={props.onRequest} disabled={props.busy}>Request Skills</button></div> : <SkillContent {...props} selection={selection} snapshot={props.snapshot} onCloseSheet={closeSheet} onSheetShownChange={setSheetShown} />}
        </div>
      </>}
      {respecConfirmation ? <GameConfirmationPrompt
        title="Reset this skill build?"
        category={props.respecGlimmerCost ? "Full skill reset" : "Free respec · Test server"}
        detail={`Resets general skills, class ranks, active class, commitment, loadout, cooldowns, effects, counters, and queued build actions. Preserves level, XP, items, currency, professions, world progress, discoveries, and achievements.${props.respecGlimmerCost ? ` Costs ${props.respecGlimmerCost} Glimmer.` : ""}`}
        confirmLabel={props.respecGlimmerCost ? `Reset build · ${props.respecGlimmerCost} Glimmer` : "Reset build"}
        destructive
        busy={props.busy}
        onConfirm={() => { setRespecConfirmation(false); props.onRespec(); }}
        onCancel={() => setRespecConfirmation(false)}
      /> : null}
    </div>
  </GameAppShell>;
}

type SkillContentProps = SkillTreeV3PanelProps & Readonly<{ snapshot: SkillSystemV3Snapshot; onCloseSheet(): void; onSheetShownChange?(shown: boolean): void }>;

function SkillContent(props: SkillContentProps): React.JSX.Element {
  const { snapshot, selection } = props;
  const revealAll = props.revealAllClasses === true;
  const tabSection: SkillTreeV3Section = selection.section === "class" || selection.section === "knowledge" ? selection.section : "general";
  const select = (next: Omit<SkillTreeV3Selection, "section">, section: SkillTreeV3Section = tabSection): void => props.onSelectionChange({ section, ...next });
  const openClass = (id: SpecializationId): void => select({ specializationId: id }, "class");

  const sheetKey = selection.classOverview ? "class-overview" : selection.specializationId ?? selection.generalSkillId ?? selection.worldKnowledgeSkillId ?? null;
  const sheet = selection.classOverview
    ? <ClassOverview snapshot={snapshot} revealAll={revealAll || snapshot.fullClassRosterEnabled} onOpenClass={openClass} />
    : selection.specializationId !== undefined
      ? <ClassDetail {...props} id={selection.specializationId} />
      : selection.worldKnowledgeSkillId !== undefined && selection.generalSkillId === undefined
        ? <DiscoveryDetail {...props} id={selection.worldKnowledgeSkillId} />
      : selection.generalSkillId !== undefined && LEDGER_SKILL_IDS.has(selection.generalSkillId) && skillShown(snapshot, selection.generalSkillId)
        ? isDisciplineId(selection.generalSkillId)
          ? <GatewayDetail snapshot={snapshot} gatewayId={selection.generalSkillId} busy={props.busy} unlocks={props.unlocks ?? null} onSpend={props.onSpend} />
          : <GeneralDetail {...props} definition={GENERAL_SKILL_DEFINITIONS[selection.generalSkillId]} />
        : null;

  const shownSheet = useRetainedSheet(sheetKey, sheet);
  const hasShownSheet = shownSheet !== null;
  const { onSheetShownChange } = props;
  useEffect(() => {
    onSheetShownChange?.(hasShownSheet);
    return () => onSheetShownChange?.(false);
  }, [hasShownSheet, onSheetShownChange]);
  return <>
    {tabSection === "class" && !revealAll && !snapshot.fullClassRosterEnabled
      ? <ClassPicker snapshot={snapshot} busy={props.busy} onChoose={props.onActivate} />
      : tabSection === "class"
      ? <ClassTab snapshot={snapshot} busy={props.busy} onOpenClass={openClass} onOpenClassOverview={() => select({ classOverview: true }, "class")} onOpenSkills={() => select({}, "general")} onUse={props.onUse} />
      : tabSection === "knowledge"
        ? <KnowledgeTab snapshot={snapshot} inventory={props.inventory ?? null} onSelect={(id) => select({ worldKnowledgeSkillId: id }, "knowledge")} />
        : <SkillLedger snapshot={snapshot} unlocks={props.unlocks ?? null} onSelectSkill={(id) => select({ generalSkillId: id }, "general")} />}
    {shownSheet ? <ProgressionDetailSheet key={shownSheet.key} layout={props.layout} closing={shownSheet.closing} onClose={props.onCloseSheet}>{shownSheet.node}</ProgressionDetailSheet> : null}
  </>;
}

/**
 * Explicit ledger tiers (by power, not prerequisite depth), lane order cleave, archery, martial, tactics.
 * Every prerequisite of a skill must sit in a strictly lower tier (asserted in the panel tests).
 */
export const LEDGER_TIERS: readonly (readonly GeneralSkillId[])[] = [
  ["cleave", "archery", "martial_arts", "tactics"],
  ["second_wind", "pierce_armor", "ricochet", "taunt", "calm_mind", "scavenge"],
  ["shield_charge", "provoke", "quarry_sense", "cleanse", "companion_bond", "delvers_lore"],
  ["pursuit", "huntsmans_edge", "perfect_strike", "war_standard"],
  ["blight_strike", "deathburst", "concentration", "heroism"],
];
const LEDGER_SKILL_IDS: ReadonlySet<GeneralSkillId> = new Set([...LEDGER_TIERS.flat(), ...TRADE_SKILL_IDS]);
const CLASS_RANK_COUNT = SPECIALIZATION_RANK_LEVEL_GATES.length;
const TIER_HINTS: readonly string[] = [
  "Discipline",
  "Needs discipline Rank 1",
  "Needs discipline Rank 2",
  "Needs discipline Rank 3",
  "Needs Rank 3 and an earlier skill",
];

/** One section per discipline: its header cell, then its skills grouped by ledger tier (branch labels from the presentation catalog). */
type DisciplineSection = Readonly<{ gateway: GeneralSkillId; tiers: readonly Readonly<{ tier: number; entries: readonly Readonly<{ id: GeneralSkillId; branch: string }>[] }>[] }>;
const LEDGER_TIER_OF: ReadonlyMap<GeneralSkillId, number> = new Map(LEDGER_TIERS.flatMap((ids, tier) => ids.map((id) => [id, tier] as const)));
const DISCIPLINE_SECTIONS: readonly DisciplineSection[] = DISCIPLINE_IDS.map((gateway) => {
  const entries = (DISCIPLINE_BRANCH_CATALOG[gateway] ?? []).flatMap((branch) => branch.skills.map((id) => ({ id, branch: branch.label })));
  return {
    gateway,
    tiers: LEDGER_TIERS.map((ids, tier) => ({
      tier,
      entries: entries.filter((entry) => LEDGER_TIER_OF.get(entry.id) === tier).sort((x, y) => ids.indexOf(x.id) - ids.indexOf(y.id)),
    })).filter((group) => group.tier > 0 && group.entries.length > 0),
  };
});

function WorldKnowledgeIcon({ id, size }: Readonly<{ id: WorldKnowledgeSkillId; size: number }>): React.JSX.Element {
  const src = WORLD_KNOWLEDGE_ICON_SRC[id];
  return src ? <ProgressionIcon alt="" size={size} src={src} iconKey={id} /> : <ProgressionIcon alt="" size={size} iconKey={id} />;
}

function LockGlyph(): React.JSX.Element {
  return <svg className="skill-v3-ledger-lock" viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><path d="M3 5V3.5a3 3 0 0 1 6 0V5h.5v6h-7V5H3Zm1.4 0h3.2V3.5a1.6 1.6 0 0 0-3.2 0V5Z" fill="currentColor" /></svg>;
}

export type SkillLedgerProps = Readonly<{
  snapshot: SkillSystemV3Snapshot;
  unlocks?: SkillUnlockState | null;
  onSelectSkill(id: GeneralSkillId): void;
}>;

/** The Skills tab's last tab: the five trade skills (no discipline gateway, no prerequisites). */
const TRADES_TAB_ID = "trades";
/** While the old disciplines are hidden, the first tab holds the place of the new combat skills. */
const NEW_SKILLS_TAB_ID = "combat";
type LedgerTabId = GeneralSkillId | typeof TRADES_TAB_ID | typeof NEW_SKILLS_TAB_ID;
const TRADE_SKILL_HINTS: Readonly<Record<TradeSkillId, string>> = {
  alchemy: "Crafting", blacksmithing: "Crafting", leatherworking: "Crafting", cartography: "Exploration", tradecraft: "Commerce",
};
const SHORT_DISCIPLINE_NAMES: Readonly<Partial<Record<GeneralSkillId, string>>> = { martial_arts: "Martial" };
const disciplineStorageKey = (playerId: string | undefined): string => `ash-atlas:skills-discipline:${playerId ?? "local"}`;
function readStoredDiscipline(key: string): LedgerTabId | null {
  try {
    const stored = window.localStorage.getItem(key);
    return stored === TRADES_TAB_ID || stored === NEW_SKILLS_TAB_ID ? stored : DISCIPLINE_IDS.find((id) => id === stored) ?? null;
  } catch {
    return null;
  }
}
/** The discipline (gateway plus its skills) with the most points spent; the first discipline when nothing is spent. */
function mostInvestedDiscipline(snapshot: SkillSystemV3Snapshot): GeneralSkillId {
  let best = DISCIPLINE_SECTIONS[0]!.gateway;
  let bestSpent = 0;
  for (const section of DISCIPLINE_SECTIONS) {
    const ids = new Set<GeneralSkillId>([section.gateway, ...section.tiers.flatMap((group) => group.entries.map((entry) => entry.id))]);
    const spent = snapshot.generalSkills.reduce((sum, entry) => ids.has(entry.skillId) ? sum + entry.pointsSpent : sum, 0);
    if (spent > bestSpent) { best = section.gateway; bestSpent = spent; }
  }
  return best;
}

/** One cell's presentation state, shared by the cell and the "ready" count on the discipline tabs. */
function ledgerCellInfo(snapshot: SkillSystemV3Snapshot, id: GeneralSkillId, unlocks?: SkillUnlockState | null) {
  const definition = GENERAL_SKILL_DEFINITIONS[id];
  const rank = rankOf(snapshot, id);
  const maxRank = maxRankOf(id);
  const visible = generalVisibleState(snapshot, definition, unlocks);
  const reason = generalSpendReason(snapshot, definition, false, unlocks);
  const nextCost = costForNextGeneralSkillRank(id, rank);
  const locked = rank === 0 && ["prerequisite", "future", "world", "offering"].includes(visible.key);
  const state = rank > 0 ? "learned" : locked ? "locked" : reason === null ? "purchasable" : "available";
  return { definition, rank, maxRank, visible, reason, nextCost, locked, state } as const;
}
const readyCount = (snapshot: SkillSystemV3Snapshot, section: DisciplineSection, unlocks?: SkillUnlockState | null): number =>
  [section.gateway, ...section.tiers.flatMap((group) => group.entries.map((entry) => entry.id))]
    .filter((id) => { const info = ledgerCellInfo(snapshot, id, unlocks); return !info.locked && info.reason === null && info.nextCost !== null; }).length;

/** One discipline at a time behind a picker: a parchment card with its tiers stacked, requirements stated once per tier. */
export function SkillLedger({ snapshot, unlocks, onSelectSkill }: SkillLedgerProps): React.JSX.Element {
  const storageKey = disciplineStorageKey(snapshot.playerId);
  const [picked, setPicked] = useState<LedgerTabId | null>(() => readStoredDiscipline(storageKey));
  const oldSkillsShown = snapshot.fullClassRosterEnabled;
  const selected = oldSkillsShown
    ? picked !== null && picked !== NEW_SKILLS_TAB_ID ? picked : mostInvestedDiscipline(snapshot)
    : picked === TRADES_TAB_ID ? TRADES_TAB_ID : NEW_SKILLS_TAB_ID;
  const section = DISCIPLINE_SECTIONS.find((candidate) => candidate.gateway === selected) ?? DISCIPLINE_SECTIONS[0]!;
  const tradesOpen = selected === TRADES_TAB_ID;
  const tradeReady = TRADE_SKILL_IDS.filter((id) => { const info = ledgerCellInfo(snapshot, id, unlocks); return !info.locked && info.reason === null && info.nextCost !== null; }).length;
  const tradeRanks = TRADE_SKILL_IDS.reduce((sum, id) => sum + rankOf(snapshot, id), 0);
  const pick = (id: string): void => {
    const next = id === TRADES_TAB_ID || id === NEW_SKILLS_TAB_ID ? id : DISCIPLINE_IDS.find((candidate) => candidate === id);
    if (!next) return;
    setPicked(next);
    try { window.localStorage.setItem(storageKey, next); } catch { /* the pick still applies for this session */ }
  };
  const tradesTab = {
    id: TRADES_TAB_ID,
    label: "Trades",
    ariaLabel: `Trades, ${tradeRanks} of ${TRADE_SKILL_IDS.length * 3} ranks learned${tradeReady > 0 ? `, ${tradeReady} ready` : ""}`,
    detail: `${tradeRanks}/${TRADE_SKILL_IDS.length * 3}`,
    icon: <ProgressionIcon alt="" size={32} {...generalSkillIconProps("tradecraft")} />,
    ...(tradeReady > 0 ? { badge: String(tradeReady) } : {}),
  };
  const tradesPanel = <div className="skill-v3-discipline-list" role="tabpanel" aria-label="Trades skills">
    <section className="skill-v3-discipline" data-discipline={TRADES_TAB_ID} aria-label="Trades">
      <div className="skill-v3-ledger-tier"><h4><span>Trades</span><small className="skill-v3-ledger-hint">Open to everyone, 1 SP per rank</small></h4>
        <ol className="skill-v3-ledger-grid">
          {TRADE_SKILL_IDS.map((id) => <li key={id}><LedgerCell id={id} snapshot={snapshot} unlocks={unlocks} variant="skill" hint={TRADE_SKILL_HINTS[id]} onSelect={() => onSelectSkill(id)} /></li>)}
        </ol>
      </div>
    </section>
  </div>;
  if (!oldSkillsShown) {
    // The old combat disciplines are hidden (no effect server-side, spent SP back as available); their place waits for the new skills.
    return <section className="skill-v3-ledger" aria-label="Skill ledger">
      <GameAppTabs
        variant="housed"
        className="skill-v3-discipline-tabs"
        ariaLabel="Disciplines"
        activeTab={selected}
        onChange={pick}
        tabs={[{
          id: NEW_SKILLS_TAB_ID,
          label: "Combat",
          ariaLabel: "Combat skills, coming soon",
          detail: "Soon",
          icon: <StatGlyph icon="classes" />,
        }, tradesTab]}
      />
      {tradesOpen ? tradesPanel : <div className="skill-v3-discipline-list" role="tabpanel" aria-label="Combat skills">
        <section className="skill-v3-discipline" data-discipline={NEW_SKILLS_TAB_ID} aria-label="Combat">
          <GameAppEmptyState className="skill-v3-new-skills" title="New skills coming soon">
            The old combat skills are retired. Skill Points you spent on them are back to spend.
          </GameAppEmptyState>
        </section>
      </div>}
    </section>;
  }
  return <section className="skill-v3-ledger" aria-label="Skill ledger">
    <GameAppTabs
      variant="housed"
      className="skill-v3-discipline-tabs"
      ariaLabel="Disciplines"
      activeTab={tradesOpen ? TRADES_TAB_ID : section.gateway}
      onChange={pick}
      tabs={[...DISCIPLINE_SECTIONS.map((entry) => {
        const definition = GENERAL_SKILL_DEFINITIONS[entry.gateway];
        const rank = rankOf(snapshot, entry.gateway);
        const ready = readyCount(snapshot, entry, unlocks);
        return {
          id: entry.gateway,
          label: SHORT_DISCIPLINE_NAMES[entry.gateway] ?? definition.displayName,
          ariaLabel: `${definition.displayName}, discipline rank ${rank} of ${maxRankOf(entry.gateway)}${ready > 0 ? `, ${ready} ready` : ""}`,
          detail: `${rank}/${maxRankOf(entry.gateway)}`,
          icon: <ProgressionIcon alt="" size={32} {...generalSkillIconProps(entry.gateway)} />,
          ...(ready > 0 ? { badge: String(ready) } : {}),
        };
      }), tradesTab]}
    />
    {tradesOpen ? tradesPanel : <div className="skill-v3-discipline-list" role="tabpanel" aria-label={`${GENERAL_SKILL_DEFINITIONS[section.gateway].displayName} skills`}>
      <section key={section.gateway} className="skill-v3-discipline" data-discipline={section.gateway} aria-label={`${GENERAL_SKILL_DEFINITIONS[section.gateway].displayName} discipline`}>
        <LedgerCell id={section.gateway} snapshot={snapshot} unlocks={unlocks} variant="discipline" hint={TIER_HINTS[0] ?? ""} onSelect={() => onSelectSkill(section.gateway)} />
        <DisciplineClasses gateway={section.gateway} snapshot={snapshot} />
        {section.tiers.map((group) => <div key={group.tier} className="skill-v3-ledger-tier" data-tier={group.tier}>
          <h4><span>Tier {group.tier}</span><small className="skill-v3-ledger-hint">{TIER_HINTS[group.tier] ?? ""}</small></h4>
          <ol className="skill-v3-ledger-grid" data-tier={group.tier}>
            {group.entries.map((entry) => <li key={entry.id}><LedgerCell id={entry.id} snapshot={snapshot} unlocks={unlocks} variant="skill" hint={entry.branch} onSelect={() => onSelectSkill(entry.id)} /></li>)}
          </ol>
        </div>)}
      </section>
    </div>}
  </section>;
}

/** Which classes a discipline opens, shown once under its card so the Class tab never repeats the Skills tab. */
function DisciplineClasses({ gateway, snapshot }: Readonly<{ gateway: GeneralSkillId; snapshot: SkillSystemV3Snapshot }>): React.JSX.Element | null {
  const names = classIdsForGateway(gateway, snapshot.fullClassRosterEnabled).filter((id) => !isStarterSpecializationId(id)).map((id) => SPECIALIZATION_DEFINITIONS[id].displayName);
  if (names.length === 0) return null;
  const open = rankOf(snapshot, gateway) >= CLASS_GATEWAY_RANK;
  return <p className="skill-v3-discipline-classes">{open ? "Classes open: " : `Rank ${CLASS_GATEWAY_RANK} opens: `}<b>{names.join(" · ")}</b></p>;
}

function LedgerCell({ id, snapshot, unlocks, variant, hint, onSelect }: Readonly<{ id: GeneralSkillId; snapshot: SkillSystemV3Snapshot; unlocks?: SkillUnlockState | null | undefined; variant: "discipline" | "skill"; hint: string; onSelect(): void }>): React.JSX.Element {
  const { definition, rank, maxRank, visible, reason, nextCost, locked, state } = ledgerCellInfo(snapshot, id, unlocks);
  const activeSlotIndex = snapshot.generalActiveLoadout.findIndex((skillId) => skillId === id);
  const status = rank >= maxRank ? "MAX" : reason === null && nextCost !== null ? `${nextCost} SP` : visible.label;
  const label = [definition.displayName, `Rank ${rank} of ${maxRank}`, visible.label, status, visible.reason || reason].filter(Boolean).join(", ");
  const statusText = rank >= maxRank ? "Maxed"
    : locked ? (visible.key === "prerequisite" ? "Locked" : visible.reason || visible.label)
      : rank > 0 ? (reason === null && nextCost !== null ? `Ready · ${nextCost} SP` : "Learned")
        : reason === null && nextCost !== null ? `Ready · ${nextCost} SP` : nextCost !== null ? `${nextCost} SP` : visible.label;
  const prerequisites = definition.prerequisites.map((item) => ({
    key: item.skillId,
    text: `Needs ${GENERAL_SKILL_DEFINITIONS[item.skillId].displayName}${item.rank > 1 ? ` ${item.rank}` : ""}`,
    met: rankOf(snapshot, item.skillId) >= item.rank,
  }));
  return <button className={`skill-v3-ledger-cell${variant === "discipline" ? " skill-v3-discipline-head" : ""}`} type="button" data-node-id={id} data-state={state} data-ready={!locked && reason === null && nextCost !== null} data-maxed={rank >= maxRank} aria-label={label} onClick={onSelect}>
    <span className="skill-v3-ledger-icon">
      <ProgressionIcon alt={`${definition.displayName} icon`} size={variant === "discipline" ? 48 : 44} {...generalSkillIconProps(id)} />
      {rank > 0 ? <b className="skill-v3-ledger-rank" aria-hidden="true">{rank}</b> : null}
      {locked ? <LockGlyph /> : null}
    </span>
    <span className="skill-v3-ledger-copy">
      <strong>{definition.displayName}</strong>
      <small className="skill-v3-ledger-hint-line">{hint}</small>
      <span className="skill-v3-ledger-meter"><RankDots rank={rank} maximumRank={maxRank} /><small className="skill-v3-ledger-status">{statusText}</small></span>
      {prerequisites.length ? <span className="skill-v3-prereqs">{prerequisites.map((item) => <small key={item.key} className="skill-v3-prereq" data-met={item.met}>{item.text}</small>)}</span> : null}
      {activeSlotIndex >= 0 ? <b className="skill-v3-node-badge">Equipped {activeSlotIndex + 1}</b> : null}
    </span>
  </button>;
}

/**
 * The Class tab on the launch roster: Ronin, Warrior or no class, one tap each. Switching is free and instant
 * (the server's free class switch); the classes have no ranks or perks yet.
 */
export function ClassPicker({ snapshot, busy, onChoose }: Readonly<{ snapshot: SkillSystemV3Snapshot; busy: boolean; onChoose(id: SpecializationId | null): void }>): React.JSX.Element {
  const active = snapshot.activeSpecializationId !== null && classAvailable(snapshot, snapshot.activeSpecializationId) ? snapshot.activeSpecializationId : null;
  const options: readonly (SpecializationId | null)[] = [...LAUNCH_SPECIALIZATION_IDS, null];
  const activeName = active ? SPECIALIZATION_DEFINITIONS[active].displayName : "No class";
  return <section className="skill-v3-class-tab skill-v3-class-picker" aria-label="Class">
    <div className="skill-v3-class-picker-status" role="status" aria-label={`Active class: ${activeName}`}>
      <span className="skill-v3-eyebrow">Active class</span>
      <strong role="heading" aria-level={2}>{activeName}</strong>
      <small>Tap to equip or unequip. Switching is free and instant.</small>
    </div>
    <div className="skill-v3-class-cards" role="group" aria-label="Choose a class">
      {options.map((id) => {
        const equipped = id === active;
        const name = id ? SPECIALIZATION_DEFINITIONS[id].displayName : "No class";
        return <button key={id ?? "none"} type="button" className="skill-v3-class-card" data-class-id={id ?? "none"} data-class-state={equipped ? "active-class" : "available"} aria-pressed={equipped} disabled={busy} onClick={() => { if (!equipped) onChoose(id); }}>
          {id
            ? <ProgressionIcon alt="" size={40} {...classIconProps(id)} />
            : <span className="skill-v3-class-card-mark" aria-hidden="true"><StatGlyph icon="character" /></span>}
          <span className="skill-v3-class-card-copy"><strong>{name}</strong><b>{equipped ? "Equipped" : id ? "Tap to equip" : "Tap to unequip"}</b></span>
        </button>;
      })}
    </div>
  </section>;
}

const effectLive = (status: string | undefined): boolean => status === undefined || status === "implemented";

/** The Class tab: the committed class as a hero card (rank track, next rank), then every rank's effects and any live class action. */
export function ClassTab({ snapshot, busy, onOpenClass, onOpenClassOverview, onOpenSkills, onUse }: Readonly<{ snapshot: SkillSystemV3Snapshot; busy: boolean; onOpenClass(id: SpecializationId): void; onOpenClassOverview(): void; onOpenSkills(): void; onUse?(techniqueId: string): void }>): React.JSX.Element {
  const current = currentClassId(snapshot);
  const retiredId = snapshot.committedSpecializationId !== null && !classAvailable(snapshot, snapshot.committedSpecializationId) ? snapshot.committedSpecializationId : null;
  if (current === null) {
    return <section className="skill-v3-class-tab" aria-label="Class">
      <article className="skill-v3-hero skill-v3-hero-empty" data-state={retiredId ? "retired" : "none"}>
        <span className="skill-v3-hero-mark" aria-hidden="true"><StatGlyph icon="character" /></span>
        <div className="skill-v3-hero-copy">
          <span className="skill-v3-eyebrow">{retiredId ? "Class retired" : "No class yet"}</span>
          <h2>{retiredId ? `${SPECIALIZATION_DEFINITIONS[retiredId].displayName} is retired` : "Choose your class"}</h2>
          <p>{retiredId
            ? "Pick a replacement class. Its spent class SP are refunded and your general skills stay as they are."
            : "A class is your lasting specialty. Warrior and Ranger come unlocked; reach Rank 3 in a discipline on the Skills tab to open its other classes. Class ranks open at levels 9, 14, 21, 27 and 33."}</p>
          <p className="skill-v3-class-rule">{classRuleCopy(snapshot.fullBuildRespecAvailable)}</p>
        </div>
        <div className="skill-v3-hero-actions"><button type="button" className="game-app-button" disabled={busy} onClick={onOpenClassOverview}>{retiredId ? "Choose a replacement" : "Browse classes"}</button>{retiredId ? null : <button type="button" className="game-app-button" onClick={onOpenSkills}>Open Skills</button>}</div>
      </article>
    </section>;
  }

  const definition = SPECIALIZATION_DEFINITIONS[current];
  const rank = classState(snapshot, current)?.rank ?? 0;
  const maxRank = classMaxRankOf(current);
  const maxed = rank >= maxRank;
  const masterTitle = (LAUNCH_CLASS_TITLES as Readonly<Record<string, string>>)[current];
  const title = maxed && masterTitle ? masterTitle : definition.displayName;
  const nextRank = definition.ranks[rank];
  const nextCost = costForNextSpecializationRank(current, rank);
  const gate = levelGateForNextSpecializationRank(rank);
  const nextReason = maxed ? null : classActionReason(snapshot, current, busy);
  return <section className="skill-v3-class-tab" aria-label="Class">
    <article className="skill-v3-hero" data-state={maxed ? "maxed" : "active"} aria-label={`${title}, Rank ${rank} of ${maxRank}`}>
      <ProgressionIcon alt={`${definition.displayName} icon`} size={72} {...classIconProps(current)} />
      <div className="skill-v3-hero-copy">
        <span className="skill-v3-eyebrow">Active class · Level {snapshot.characterLevel}</span>
        <h2>{title}</h2>
        <p className="skill-v3-hero-sub">{maxed ? `${definition.displayName} mastered` : `${definition.displayName} · Rank ${rank} of ${maxRank}`}</p>
        <ol className="skill-v3-rank-track" aria-label={`Class rank progress, ${rank} of ${maxRank}`}>
          {definition.ranks.map((entry) => <li key={entry.rank} data-state={rank >= entry.rank ? "earned" : entry.rank === rank + 1 ? "next" : "locked"}><span>{entry.rank}</span></li>)}
        </ol>
      </div>
      <div className="skill-v3-hero-next" aria-label="Next rank">
        {nextRank ? <>
          <span className="skill-v3-eyebrow">Next · Rank {nextRank.rank}</span>
          <p className="skill-v3-hero-gate">{nextCost !== null ? `${nextCost} SP` : ""}{gate !== null ? `${nextCost !== null ? " · " : ""}${snapshot.characterLevel >= gate ? `Level ${gate}` : `Unlocks at level ${gate}`}` : ""}</p>
          <EffectLines descriptions={nextRank.effects.filter((effect) => effectLive(effect.status)).map((effect) => effect.description)} />
          {nextRank.effects.some((effect) => !effectLive(effect.status)) ? <small className="skill-v3-soon">Part of this rank is coming soon</small> : null}
          {visibleReason(nextReason) ? <small className="skill-v3-hero-reason">{visibleReason(nextReason)}</small> : null}
        </> : <>
          <span className="skill-v3-eyebrow">Mastery</span>
          <p>Every rank of this class is earned.</p>
        </>}
      </div>
      <div className="skill-v3-hero-actions">
        <button type="button" className="game-app-button" onClick={() => onOpenClass(current)}>{maxed ? "Class details" : "Rank up"}</button>
        <button type="button" className="game-app-button" disabled={busy} onClick={onOpenClassOverview}>Change class</button>
      </div>
    </article>
    <section className="skill-v3-class-block" aria-label="Rank effects">
      <h3>Rank effects</h3>
      <RankLadder entries={definition.ranks.map((entry) => {
        const gateFor = levelGateForNextSpecializationRank(entry.rank - 1);
        return {
          key: entry.rank,
          title: `Rank ${entry.rank}`,
          state: entry.rank === rank ? "current" : rank > entry.rank ? "earned" : entry.rank === rank + 1 ? "next" : "upcoming",
          meta: `${entry.cost} SP${gateFor !== null ? ` · Level ${gateFor}` : ""}`,
          lines: entry.effects.map((effect) => ({ key: effect.effectId, content: <EffectLines descriptions={[effect.description]} />, soon: !effectLive(effect.status) }))
        };
      })} />
    </section>
    {current === "druid" ? <section className="skill-v3-class-block" aria-label="Druid Replenish">
      <h3>Replenish</h3>
      <p>Spend 5 Giving Berries to transfer your HP to an injured ally in melee range. You stop at 1 HP; using it makes you aggressive. Select the ally in the world first.</p>
      <button type="button" disabled={busy || snapshot.activeSpecializationId !== current || rank < 1} onClick={() => onUse?.("v3_druid_replenish")}>Use Replenish</button>
    </section> : null}
    {current === "merchant" ? <section className="skill-v3-class-block" aria-label="Merchant Maximize Tactics">
      <h3>Maximize Tactics</h3>
      <p>Pay {merchantMaximizeTacticsCostGold(snapshot.characterLevel)} Gold to fill your stored Tactics to its maximum.</p>
      <button type="button" disabled={busy || snapshot.activeSpecializationId !== current || rank < 1} onClick={() => onUse?.(MERCHANT_MAXIMIZE_TACTICS_ABILITY_ID)}>Maximize Tactics</button>
    </section> : null}
    <p className="skill-v3-class-rule">{classRuleCopy(snapshot.fullBuildRespecAvailable)}</p>
  </section>;
}

const knowledgeTokenCount = (inventory: PlayerInventorySnapshot | null, itemId: string): number =>
  (inventory?.items ?? []).reduce((sum, item) => item.resourceType === itemId ? sum + item.quantity : sum, 0);

/** Turn-in places that are not dungeons yet (the Drowned City dungeon is still to come). */
const KNOWLEDGE_SOURCE_NAMES: Readonly<Record<string, string>> = { drowned_city: "Drowned City sites (open sea)" };
const knowledgeSourceName = (dungeonId: string): string =>
  dungeonDefinition(dungeonId)?.name ?? KNOWLEDGE_SOURCE_NAMES[dungeonId] ?? dungeonId;

type KnowledgeGroup = Readonly<{ key: string; title: string; ids: readonly WorldKnowledgeSkillId[] }>;
const KNOWLEDGE_GROUPS: readonly KnowledgeGroup[] = (() => {
  const groups: { key: string; title: string; ids: WorldKnowledgeSkillId[] }[] = [];
  const turnInIds = new Set<string>(Object.keys(DUNGEON_SKILL_TURN_INS));
  for (const id of WORLD_KNOWLEDGE_SKILL_IDS) {
    const turnIn = (DUNGEON_SKILL_TURN_INS as Readonly<Record<string, (typeof DUNGEON_SKILL_TURN_INS)[keyof typeof DUNGEON_SKILL_TURN_INS]>>)[id];
    if (!turnIn || WORLD_KNOWLEDGE_SKILL_DEFINITIONS[id].status !== "implemented") continue;
    const existing = groups.find((group) => group.key === turnIn.dungeonId);
    if (existing) existing.ids.push(id);
    else groups.push({ key: turnIn.dungeonId, title: knowledgeSourceName(turnIn.dungeonId), ids: [id] });
  }
  const soon = WORLD_KNOWLEDGE_SKILL_IDS.filter((id) => !(turnInIds.has(id) && WORLD_KNOWLEDGE_SKILL_DEFINITIONS[id].status === "implemented"));
  if (soon.length) groups.push({ key: "soon", title: "Coming soon", ids: [...soon] });
  return groups;
})();

/** The Knowledge tab: every World Knowledge entry grouped by the dungeon that issues its token, with the player's token progress. */
export function KnowledgeTab({ snapshot, inventory, onSelect }: Readonly<{ snapshot: SkillSystemV3Snapshot; inventory: PlayerInventorySnapshot | null; onSelect(id: WorldKnowledgeSkillId): void }>): React.JSX.Element {
  return <section className="skill-v3-knowledge" aria-label="Knowledge">
    <p className="skill-v3-knowledge-intro">Bring dungeon tokens to their turn-in to discover a field of knowledge, then spend Skill Points to deepen it. Discovered knowledge is yours for good.</p>
    {KNOWLEDGE_GROUPS.map((group) => <section key={group.key} className="skill-v3-knowledge-group" data-group={group.key} aria-label={group.title}>
      <h3><span>{group.title}</span><small className="skill-v3-ledger-hint">{group.key === "soon" ? "Not available yet" : "Token source"}</small></h3>
      <ol className="skill-v3-knowledge-list">
        {group.ids.map((id) => {
          const definition = WORLD_KNOWLEDGE_SKILL_DEFINITIONS[id];
          const entryState = knowledgeState(snapshot, id);
          const revealed = entryState?.revealed === true;
          const rank = entryState?.rank ?? 0;
          const maxRank = definition.ranks.length;
          const soon = definition.status !== "implemented";
          const turnIn = (DUNGEON_SKILL_TURN_INS as Readonly<Record<string, (typeof DUNGEON_SKILL_TURN_INS)[keyof typeof DUNGEON_SKILL_TURN_INS]>>)[id];
          const tokenName = turnIn ? INVENTORY_CATALOG[turnIn.tokenItemId]?.displayName ?? turnIn.tokenItemId : null;
          const have = turnIn ? Math.min(knowledgeTokenCount(inventory, turnIn.tokenItemId), turnIn.tokenCost) : 0;
          const dungeonName = turnIn ? knowledgeSourceName(turnIn.dungeonId) : null;
          const nextCost = definition.ranks[rank]?.cost ?? null;
          const state = soon ? "soon" : revealed ? (rank >= maxRank ? "maxed" : rank > 0 ? "learned" : "available") : "locked";
          const overworldParts = WORLD_KNOWLEDGE_OVERWORLD_PARTS[id];
          const overworld = overworldParts ? offeringNeeds(overworldParts.parts, inventory) : null;
          const ready = !soon && !revealed && turnIn !== undefined && have >= turnIn.tokenCost && (overworld?.ready ?? true);
          const chip = soon ? "Coming soon"
            : state === "maxed" ? "Maxed"
              : state === "learned" ? `Learned · ${rank}/${maxRank}`
                : state === "available" ? (nextCost !== null && snapshot.pointState.available >= nextCost ? `Can learn · ${nextCost} SP` : `Needs ${nextCost ?? 1} SP`)
                  : ready ? "Ready to turn in" : "Locked";
          const effect = soon ? null : effectLines(definition.ranks[Math.max(0, rank - 1)]?.description ?? "")[0] ?? null;
          const iconSrc = WORLD_KNOWLEDGE_ICON_SRC[id];
          const body = <>
            <span className="skill-v3-knowledge-icon" data-empty={iconSrc ? undefined : "true"}>{iconSrc ? <ProgressionIcon alt="" size={44} src={iconSrc} iconKey={id} /> : null}</span>
            <span className="skill-v3-knowledge-copy">
              <strong>{definition.displayName}</strong>
              {effect ? <span className="skill-v3-knowledge-effect">{effect}</span> : null}
              {!soon && !revealed && turnIn ? <span className="skill-v3-knowledge-token"><span>{tokenName}</span> <strong>{have}/{turnIn.tokenCost}</strong>{dungeonName ? <small> · from {dungeonName}</small> : null}</span> : null}
              {!soon && !revealed && overworld ? <MaterialChips label={`${definition.displayName} overworld part`} materials={overworld.needs} /> : null}
              {!soon && revealed ? <span className="skill-v3-ledger-meter"><RankDots rank={rank} maximumRank={maxRank} /></span> : null}
            </span>
            <span className="skill-v3-knowledge-chip" data-state={ready ? "ready" : state}>{chip}</span>
          </>;
          return <li key={id}>
            {soon
              ? <div className="skill-v3-knowledge-card" data-state={state} data-knowledge-id={id} aria-label={`${definition.displayName}, ${chip}`}>{body}</div>
              : <button type="button" className="skill-v3-knowledge-card" data-state={ready ? "ready" : state} data-knowledge-id={id} aria-label={`${definition.displayName}, ${chip}${!revealed && turnIn ? `, ${tokenName} ${have} of ${turnIn.tokenCost}` : ""}`} onClick={() => onSelect(id)}>{body}</button>}
          </li>;
        })}
      </ol>
    </section>)}
  </section>;
}

function ClassCard({ id, snapshot, busy, onSelect }: Readonly<{ id: SpecializationId; snapshot: SkillSystemV3Snapshot; busy: boolean; onSelect(): void }>): React.JSX.Element {
  const definition = SPECIALIZATION_DEFINITIONS[id];
  const rank = classState(snapshot, id)?.rank ?? 0;
  const maxRank = classMaxRankOf(id);
  const status = classStatus(snapshot, id);
  const reason = classActionReason(snapshot, id, busy);
  const current = currentClassId(snapshot);
  const note = status === "Locked" ? classUnlockRequirement(snapshot, id)
    : status === "Class Locked" && current ? `Locked while ${SPECIALIZATION_DEFINITIONS[current].displayName} is active`
      : status === "Unavailable" ? "Not enabled in this environment"
        : status === "Available" ? "Ready to choose"
          : null;
  return <button type="button" className="skill-v3-class-card" data-class-id={id} data-class-state={status.toLowerCase().replaceAll(" ", "-")} onClick={onSelect} aria-label={`${definition.displayName}, ${status}, Rank ${rank} of ${maxRank}${reason ? `, ${reason}` : ""}`}>
    <ProgressionIcon alt={`${definition.displayName} icon`} size={52} {...classIconProps(id)} />
    <span className="skill-v3-class-card-copy"><strong>{status === "Active Class" ? "★ " : ""}{definition.displayName}</strong><b>{status}</b><small>Rank {rank}/{maxRank}</small>{note ? <small>{note}</small> : null}</span>
    <span aria-hidden="true">›</span>
  </button>;
}

function ClassOverview({ snapshot, revealAll, onOpenClass }: Readonly<{ snapshot: SkillSystemV3Snapshot; revealAll: boolean; onOpenClass(id: SpecializationId): void }>): React.JSX.Element {
  const current = currentClassId(snapshot);
  const retired = snapshot.committedSpecializationId && !classAvailable(snapshot, snapshot.committedSpecializationId)
    ? snapshot.committedSpecializationId : null;
  return <aside className="skill-v3-detail skill-v3-class-overview" aria-label="All classes">
    <header><div className="skill-v3-detail-identity"><span>Active class</span><h3>{current ? SPECIALIZATION_DEFINITIONS[current].displayName : "None chosen"}</h3></div></header>
    {retired ? <p className="skill-v3-class-rule">{SPECIALIZATION_DEFINITIONS[retired].displayName} is retired. Choose an available class to refund its spent class SP and keep your General Skills.</p> : null}
    <p className="skill-v3-class-rule">{classRuleCopy(snapshot.fullBuildRespecAvailable)}</p>
    {GENERAL_SKILL_FAMILIES.map((family) => {
      const ids = classIdsForGateway(family.gateway, revealAll);
      if (ids.length === 0) return null;
      return <section key={family.gateway} aria-label={`${family.label} classes`}>
        <h4>{family.label}</h4>
        <div className="skill-v3-class-cards">{ids.map((id) => <ClassCard key={id} id={id} snapshot={snapshot} busy={false} onSelect={() => onOpenClass(id)} />)}</div>
      </section>;
    })}
  </aside>;
}

function RankDots({ rank, maximumRank }: Readonly<{ rank: number; maximumRank: number }>): React.JSX.Element {
  return <span className="skill-v3-rank-dots" aria-hidden="true">{Array.from({ length: maximumRank }, (_, index) => <i key={index} data-filled={index < rank} />)}</span>;
}

/**
 * Presentation only: one perk per line. Splits on semicolons, sentence breaks, and
 * list joins ("," / "and") that start a new signed bonus ("+10 Max HP and +1 Axe Attack").
 * Plain phrases such as "Longbow and Crossbow" stay whole.
 */
export function effectLines(description: string): string[] {
  return description
    .split(/;\s+|\.\s+(?=[A-Z+\-−\d])|,?\s+and\s+(?=[+\-−]\d)|,\s+(?=[+\-−]\d)/)
    .map((line) => line.trim().replace(/\.$/, ""))
    .filter(Boolean)
    .map((line) => line.charAt(0).toUpperCase() + line.slice(1));
}

function EffectLines({ descriptions }: Readonly<{ descriptions: readonly string[] }>): React.JSX.Element {
  return <span className="skill-v3-effect-lines">{descriptions.flatMap(effectLines).map((line, index) => <span key={index}>{line}</span>)}</span>;
}

/** Level 1 / 2 / 3 side by side (stacked on narrow sheets): earned levels lit, future levels muted. */
function RankLedger({ definition, rank }: Readonly<{ definition: SkillDefinition; rank: number }>): React.JSX.Element {
  return <section className="skill-v3-rank-ledger-section" aria-label={`${definition.displayName} ranks`}><h4>Ranks</h4><div className="skill-v3-rank-ledger" data-layout="columns">{definition.rankDefinitions.map((entry) => <div className="skill-v3-rank-row" key={entry.rank} data-earned={rank >= entry.rank}><strong className="skill-v3-rank-title">Level {entry.rank}</strong><small className="skill-v3-rank-cost">{entry.cost} SP{entry.cooldownMs === undefined ? "" : ` · ${formatBaseCooldown(entry.cooldownMs)} base cooldown`}</small><span className="skill-v3-rank-content"><EffectLines descriptions={entry.effects.map((effect) => effect.description)} /></span></div>)}</div></section>;
}

function GatewayDetail({ snapshot, gatewayId, busy, unlocks, onSpend }: Readonly<{ snapshot: SkillSystemV3Snapshot; gatewayId: GeneralSkillId; busy: boolean; unlocks: SkillUnlockState | null; onSpend(target: SkillTreeV3RankTarget): void }>): React.JSX.Element {
  const definition = GENERAL_SKILL_DEFINITIONS[gatewayId];
  const rank = rankOf(snapshot, gatewayId);
  const nextCost = costForNextGeneralSkillRank(gatewayId, rank);
  const rawReason = generalSpendReason(snapshot, definition, busy, unlocks);
  const reason = visibleReason(rawReason);
  const reasonId = `skill-v3-spend-${gatewayId}`;
  return <aside className="skill-v3-detail skill-v3-gateway-detail" aria-label={`${definition.displayName} details`}>
    <DetailHeader icon={<ProgressionIcon alt={`${definition.displayName} icon`} size={56} {...generalSkillIconProps(gatewayId)} />} name={definition.displayName} state={`Rank ${rank} / ${maxRankOf(gatewayId)}`} reason={reason} reasonId={reasonId}
      spend={{ label: nextCost === null ? "Max rank" : "Level Up", cost: nextCost, ariaLabel: nextCost === null ? "Maximum Rank" : `Level Up · ${nextCost} SP`, disabled: rawReason !== null, describedBy: reason ? reasonId : undefined, onClick: () => onSpend({ kind: "general", id: gatewayId }) }} />
    <p>{definition.description}</p>
    <RankLedger definition={definition} rank={rank} />
  </aside>;
}

function GeneralDetail(props: SkillContentProps & { definition: SkillDefinition }): React.JSX.Element {
  const { snapshot, definition } = props;
  const rank = rankOf(snapshot, definition.id);
  const nextCost = costForNextGeneralSkillRank(definition.id, rank);
  const rawReason = generalSpendReason(snapshot, definition, props.busy, props.unlocks);
  const visibleState = generalVisibleState(snapshot, definition, props.unlocks);
  const offering = offeringPending(snapshot, props.unlocks, definition.id) ? GENERAL_SKILL_OFFERINGS[definition.id] ?? null : null;
  const offeringState = offering ? offeringNeeds(offering.parts, props.inventory) : null;
  // Locks read as one short line in the header; the spend plaque's reason only covers what that line does not.
  const needs = needsLine(snapshot, definition) ?? (visibleState.key === "world" ? `Discover: ${definition.worldUnlockRequirement}` : null);
  const reason = needs ? null : visibleReason(rawReason);
  const reasonId = `skill-v3-spend-${definition.id}`;
  const equipment = definition.useEquipmentRequirement === undefined ? null : `Uses ${definition.useEquipmentRequirement.map((category) => category.replaceAll("_", " ")).join(", ").replace(/, ([^,]*)$/, " or $1")}`;
  const meta = [needs ?? (visibleState.label === "Available" ? null : visibleState.label), equipment].filter((line): line is string => line !== null);
  const activeSlotIndex = snapshot.generalActiveLoadout.findIndex((id) => id === definition.id);
  const activeSlot = activeSlotIndex >= 0 ? GENERAL_ACTIVE_SLOT_IDS[activeSlotIndex]! : null;
  const usable = definition.kind === "active" && rank > 0 && definition.status === "implemented";
  return <aside className="skill-v3-detail" aria-label={`${definition.displayName} details`}>
    <DetailHeader icon={<ProgressionIcon alt={`${definition.displayName} icon`} size={52} {...generalSkillIconProps(definition.id)} />} eyebrow={`${definition.category} · ${definition.kind}`} name={definition.displayName} state={`Rank ${rank} / ${maxRankOf(definition.id)}`} meta={meta} reason={reason} reasonId={reasonId}
      spend={{ label: nextCost === null ? "Max rank" : "Level Up", cost: nextCost, ariaLabel: nextCost === null ? "Maximum Rank" : `Level Up · ${nextCost} SP`, disabled: rawReason !== null, describedBy: reason ? reasonId : undefined, onClick: () => props.onSpend({ kind: "general", id: definition.id }) }} />
    <p>{definition.description}</p>
    {offering && offeringState ? <section className="skill-v3-offering" aria-label="Discovery offering">
      <h4>Discovery offering</h4>
      <p>A one-time offering opens Rank 1. The items are used up; the discovery is yours for good.</p>
      <MaterialChips label={`${definition.displayName} offering`} materials={offeringState.needs} />
      {offering.where ? <small className="skill-v3-offering-where">Drops from: {offering.where}</small> : null}
      <button type="button" className="game-app-button" disabled={!offeringState.ready || props.busy || !props.onOffer} onClick={() => props.onOffer?.(definition.id)}>Offer</button>
    </section> : null}
    <RankLedger definition={definition} rank={rank} />
    {definition.kind === "active" ? <div className="skill-v3-loadout-actions" aria-label="General active slots">{GENERAL_ACTIVE_SLOT_IDS.map((slot) => <button key={slot} type="button" className="game-app-button" aria-pressed={activeSlot === slot} disabled={!usable || props.busy || activeSlot === slot} onClick={() => props.onEquip(slot, definition.id)}>{activeSlot === slot ? `Equipped ${slot}` : `Equip Slot ${slot}`}</button>)}<button type="button" className="game-app-button" disabled={!usable || props.busy || activeSlot === null} title={activeSlot === null ? "Equip this skill before using it." : undefined} onClick={() => props.onUse(definition.id)}>Use</button><small className="skill-v3-cooldown-state">Cooldown: {formatRemainingCooldown(snapshot.cooldownEndsAt[definition.id], snapshot.serverTime)}</small></div> : null}
  </aside>;
}

function DiscoveryDetail(props: SkillContentProps & { id: WorldKnowledgeSkillId }): React.JSX.Element {
  const { snapshot, id } = props;
  const definition: WorldKnowledgeSkillDefinition = WORLD_KNOWLEDGE_SKILL_DEFINITIONS[id];
  const state = knowledgeState(snapshot, id);
  const revealed = state?.revealed === true;
  const rank = state?.rank ?? 0;
  const nextCost = definition.ranks[rank]?.cost ?? null;
  const rawReason = knowledgeSpendReason(snapshot, id, props.busy);
  // Undiscovered: the requirement block under the header already says what to do, so the reason is not repeated.
  const reason = revealed ? visibleReason(rawReason) : null;
  const reasonId = `skill-v3-spend-${id}`;
  const turnIn = (DUNGEON_SKILL_TURN_INS as Readonly<Record<string, (typeof DUNGEON_SKILL_TURN_INS)[keyof typeof DUNGEON_SKILL_TURN_INS]>>)[id];
  const discoveryParts: UnlockOfferingPart[] = [
    ...(turnIn ? [{ kind: "item" as const, itemId: turnIn.tokenItemId, quantity: turnIn.tokenCost }] : []),
    ...(WORLD_KNOWLEDGE_OVERWORLD_PARTS[id]?.parts ?? [])
  ];
  const discovery = !revealed && definition.status === "implemented" && discoveryParts.length > 0 ? offeringNeeds(discoveryParts, props.inventory) : null;
  return <aside className="skill-v3-detail" aria-label={`${definition.displayName} details`}>
    <DetailHeader icon={<WorldKnowledgeIcon id={id} size={52} />} name={definition.displayName} state={revealed ? `Rank ${rank} / ${definition.ranks.length}` : "Undiscovered"} meta={revealed ? undefined : [definition.unlockRequirement]} reason={reason} reasonId={reasonId}
      spend={{ label: nextCost === null ? "Max rank" : "Level Up", cost: nextCost, ariaLabel: nextCost === null ? "Maximum Rank" : `Level Up · ${nextCost} SP`, disabled: rawReason !== null, describedBy: reason ? reasonId : undefined, onClick: () => props.onSpend({ kind: "knowledge", id }) }} />
    {discovery ? <section className="skill-v3-offering" aria-label="Discovery items">
      <h4>Discovery items</h4>
      <MaterialChips label={`${definition.displayName} discovery`} materials={discovery.needs} />
    </section> : null}
    <section className="skill-v3-rank-ledger-section" aria-label={`${definition.displayName} ranks`}><h4>Ranks</h4><div className="skill-v3-rank-ledger" data-layout="columns">{definition.ranks.map((entry) => <div className="skill-v3-rank-row" key={entry.rank} data-earned={rank >= entry.rank ? "true" : "false"}><strong className="skill-v3-rank-title">Level {entry.rank}</strong><small className="skill-v3-rank-cost">{entry.cost} SP</small><span className="skill-v3-rank-content"><EffectLines descriptions={[entry.description]} />{entry.pending?.length ? <small className="skill-v3-rank-pending">Pending: {entry.pending.join("; ")}</small> : null}</span></div>)}</div></section>
  </aside>;
}

function ClassDetail(props: SkillContentProps & { id: SpecializationId }): React.JSX.Element {
  const definition = SPECIALIZATION_DEFINITIONS[props.id];
  const state = classState(props.snapshot, props.id);
  const rank = state?.rank ?? 0;
  const maxRank = classMaxRankOf(props.id);
  const writ = writPending(props.snapshot, props.unlocks, props.id) ? CLASS_WRITS[props.id] ?? null : null;
  const writState = writ ? offeringNeeds(writ.parts, props.inventory) : null;
  const spendReason = classActionReason(props.snapshot, props.id, props.busy, writState !== null && !writState.ready);
  const nextCost = costForNextSpecializationRank(props.id, rank);
  const active = props.snapshot.activeSpecializationId === props.id;
  const replacingRetired = props.snapshot.committedSpecializationId !== null && !classAvailable(props.snapshot, props.snapshot.committedSpecializationId);
  const activateExisting = replacingRetired && rank > 0;
  const status = classStatus(props.snapshot, props.id);
  const needs = classNeedsLine(props.snapshot, props.id);
  // The lock reads as one short header line; any other blocker (another class is active, SP) is the plain reason beneath.
  const meta = [needs ?? (status === "Available" ? null : state?.grandfathered ? "Grandfathered" : status)].filter((line): line is string => line !== null);
  const reason = needs ? null : visibleReason(spendReason);
    const respecAvailable = props.snapshot.fullBuildRespecAvailable;
  const [commitConfirmation, setCommitConfirmation] = useState(false);
  useEffect(() => { setCommitConfirmation(false); }, [props.id, rank, props.snapshot.committedSpecializationId]);
  const spend = (): void => {
    if (activateExisting || (rank === 0 && (props.snapshot.committedSpecializationId === null || replacingRetired))) setCommitConfirmation(true);
    else props.onSpend({ kind: "specialization", id: props.id });
  };
  return <aside className="skill-v3-detail" aria-label={`${definition.displayName} class details`}>
    <DetailHeader icon={<ProgressionIcon alt={`${definition.displayName} icon`} size={52} {...classIconProps(props.id)} />} name={definition.displayName} state={`Rank ${rank} / ${maxRank}`} meta={meta} reason={reason}
      spend={{ label: activateExisting ? "Choose class" : nextCost === null ? "Max rank" : rank === 0 ? "Choose" : "Rank Up", cost: activateExisting ? null : nextCost, ariaLabel: activateExisting ? "Choose class" : nextCost === null ? "Maximum Rank" : `Spend ${nextCost} SP`, disabled: spendReason !== null, onClick: spend }} />
    <p className="skill-v3-class-rule">{classRuleCopy(respecAvailable)}</p>
    {writ && writState ? <section className="skill-v3-offering" aria-label={`${definition.displayName} writ`}>
      <h4>Class writ</h4>
      <p>Rank 1 also takes this one-time writ. The items are used up when you choose the class.</p>
      <MaterialChips label={`${definition.displayName} writ`} materials={writState.needs} />
      {writ.where ? <small className="skill-v3-offering-where">Drops from: {writ.where}</small> : null}
    </section> : null}
    <section aria-label={`${definition.displayName} rank effects`}><h4>Rank progression</h4><div className="skill-v3-rank-ledger">{definition.ranks.map((entry) => { const gate = levelGateForNextSpecializationRank(entry.rank - 1); return <div className="skill-v3-rank-row" key={entry.rank} data-earned={rank >= entry.rank}><strong className="skill-v3-rank-title">Rank {entry.rank}{entry.rank === 1 ? " · Becomes your class" : ""}</strong><small className="skill-v3-rank-cost">{entry.cost} SP · {gate !== null ? `Level ${gate}` : "—"}</small><span className="skill-v3-rank-content skill-v3-rank-effects">{entry.effects.map((effect) => <span key={effect.effectId}><EffectLines descriptions={[effect.description]} /><small data-effect-support={effect.status === undefined || effect.status === "implemented" ? "supported" : "dormant"}>{effect.status === undefined || effect.status === "implemented" ? "Supported" : "Dormant"}</small></span>)}</span></div>; })}</div></section>
    {props.id === "merchant" ? <section aria-label="Merchant Maximize Tactics"><h4>Maximize Tactics</h4><p>Pay {merchantMaximizeTacticsCostGold(props.snapshot.characterLevel)} Gold to fill your stored Tactics to its maximum.</p><button type="button" disabled={props.busy || !active || rank < 1} onClick={() => props.onUse(MERCHANT_MAXIMIZE_TACTICS_ABILITY_ID)}>Maximize Tactics</button></section> : null}
    {props.id === "druid" ? <section aria-label="Druid Replenish"><h4>Replenish</h4><p>Spend 5 Giving Berries to transfer your HP to an injured ally in melee range. You stop at 1 HP; using it makes you aggressive. Select the ally in the world first.</p><button type="button" disabled={props.busy || !active || rank < 1} onClick={() => props.onUse("v3_druid_replenish")}>Use Replenish</button></section> : null}
    {commitConfirmation ? <GameConfirmationPrompt title={`Choose ${definition.displayName} as your class?`} category={activateExisting ? "Retired class replacement" : "Rank 1 · Class choice"} detail={`${replacingRetired ? `${SPECIALIZATION_DEFINITIONS[props.snapshot.committedSpecializationId!].displayName} is retired. Its ${classState(props.snapshot, props.snapshot.committedSpecializationId!)?.pointsSpent ?? 0} spent class SP will be refunded; its rank record is retained. ` : ""}${activateExisting ? `Activate your existing ${definition.displayName} Rank ${rank} with no additional rank charge.` : `Spend ${nextCost ?? 0} SP${writ ? " and the class writ" : ""} on ${definition.displayName} Rank 1.`} ${definition.displayName} becomes your active class and every other class locks. General skills are not affected. ${respecAvailable ? "Respec build undoes this by resetting all skills and classes." : "This cannot be undone."}`} confirmLabel={`Choose ${definition.displayName}`} busy={props.busy} onConfirm={() => { setCommitConfirmation(false); if (activateExisting) props.onActivate(props.id); else props.onSpend({ kind: "specialization", id: props.id }); }} onCancel={() => setCommitConfirmation(false)} /> : null}
  </aside>;
}
