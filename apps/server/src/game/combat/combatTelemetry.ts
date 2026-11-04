import { createHash } from "node:crypto";

import type pg from "pg";
import { z } from "zod";
import { CURRENT_LEVEL_CAP, MAX_EQUIPMENT_LEVEL } from "@ash-atlas/shared";

export const COMBAT_TELEMETRY_SCHEMA_VERSION = 3 as const;
export const MAX_COMBAT_ACTION_TRACE_ENTRIES = 500;
export const MAX_COMBAT_TELEMETRY_QUEUE_DEPTH = 1_024;
export const MAX_RECENT_COMBAT_SUMMARIES = 200;
export const MAX_COMBAT_SUMMARY_BYTES = 262_144;
export const MAX_COMBAT_ACTION_TRACE_BYTES = 524_288;
export const COMBAT_TELEMETRY_MAX_ATTEMPTS = 5;
export const COMBAT_TELEMETRY_INITIAL_RETRY_DELAY_MS = 1_000;
export const COMBAT_TELEMETRY_MAX_RETRY_DELAY_MS = 30_000;
export const MAX_COMBAT_TELEMETRY_QUARANTINE_ENTRIES = 100;

const stableIdSchema = z.string().min(1).max(160).regex(/^[A-Za-z0-9._:-]+$/);
const shortStableIdSchema = z.string().min(1).max(80).regex(/^[A-Za-z0-9._:-]+$/);
const nonnegativeFiniteSchema = z.number().finite().nonnegative().max(1_000_000_000);
const nonnegativeIntegerSchema = z.number().int().nonnegative().max(1_000_000_000);
const timestampMsSchema = z.number().finite().nonnegative().max(10_000_000_000_000);
const equipmentLevelSchema = z.number().int().min(0).max(MAX_EQUIPMENT_LEVEL);
const effectiveEquipmentLevelSchema = z.number().finite().min(0).max(28);
const combatPowerSchema = nonnegativeFiniteSchema;
const metricMapSchema = z
  .record(stableIdSchema, nonnegativeFiniteSchema)
  .refine((value) => Object.keys(value).length <= 64, "metric maps are limited to 64 keys");

export const COMBAT_MITIGATION_SOURCES = [
  "armor",
  "queue_discipline",
  "crowd_breaker",
  "fortify",
  "ironhide",
  "last_stand",
  "guard",
  "guardians_reprisal"
] as const;
// Sources and resources of the removed Paladin and Cleric classes still appear in stored summaries.
const RETIRED_MITIGATION_SOURCES = [
  "paladin_guard", "protectors_resolve", "class_rotation_protection", "hold_the_line", "paladin_guardians_reprisal"
] as const;
const RETIRED_RESOURCE_IDS: readonly unknown[] = ["conviction", "faith"];
export type CombatMitigationSource = (typeof COMBAT_MITIGATION_SOURCES)[number];

const mitigationSchema = z.object({
  armor: nonnegativeFiniteSchema,
  queue_discipline: nonnegativeFiniteSchema,
  crowd_breaker: nonnegativeFiniteSchema,
  fortify: nonnegativeFiniteSchema,
  ironhide: nonnegativeFiniteSchema,
  last_stand: nonnegativeFiniteSchema,
  guard: nonnegativeFiniteSchema,
  guardians_reprisal: nonnegativeFiniteSchema
}).strict();

export const combatActionTraceEntrySchema = z.object({
  sequence: nonnegativeIntegerSchema,
  elapsedMs: nonnegativeIntegerSchema,
  actor: z.enum(["player", "enemy", "system"]),
  action: shortStableIdSchema,
  result: z.enum(["resolved", "approached", "buffered", "expired", "removed", "defeated"]),
  abilityId: stableIdSchema.optional(),
  enemyArchetype: stableIdSchema.optional(),
  damage: nonnegativeFiniteSchema.optional(),
  rageDelta: z.number().finite().min(-1_000_000).max(1_000_000).optional(),
  queueSize: nonnegativeIntegerSchema.optional()
}).strict();

export type CombatActionTraceEntry = z.infer<typeof combatActionTraceEntrySchema>;

export const combatBalanceSummarySchema = z.object({
  schemaVersion: z.literal(COMBAT_TELEMETRY_SCHEMA_VERSION),
  combatSessionId: stableIdSchema,
  playerId: stableIdSchema,
  activeClassId: shortStableIdSchema,
  activeSubclassId: shortStableIdSchema.nullable(),
  activeClassLevel: z.number().int().min(0).max(25),
  primaryResourceId: z.enum(["rage", "focus"]),
  weaponMode: z.enum(["ranged", "melee"]).nullable(),
  warriorLevel: z.number().int().min(0).max(25),
  characterLevel: z.number().int().min(0).max(CURRENT_LEVEL_CAP),
  warriorRank: z.number().int().min(0).max(15),
  activeKitIndex: z.number().int().min(1).max(6).nullable(),
  readiedWeaponSlot: z.enum(["melee", "secondary"]),
  weaponCategory: shortStableIdSchema.nullable(),
  weaponItemLevel: equipmentLevelSchema.nullable(),
  effectiveWeaponLevel: effectiveEquipmentLevelSchema.nullable(),
  weightedArmorLevel: effectiveEquipmentLevelSchema,
  shieldLevel: equipmentLevelSchema.nullable(),
  pvpOffense: combatPowerSchema,
  pvpGuard: combatPowerSchema,
  kitSwitchCount: nonnegativeIntegerSchema,
  latestKitActivationTick: nonnegativeIntegerSchema.nullable(),
  timeFromKitActivationToNextResolvedActionTicks: nonnegativeIntegerSchema.nullable(),
  invalidKitActivationAttempts: nonnegativeIntegerSchema,
  damageBeforePowerScaling: nonnegativeFiniteSchema,
  powerMultiplier: z.number().finite().min(0).max(10),
  finalPowerScaledDamage: nonnegativeFiniteSchema,
  equippedResetActives: z.tuple([stableIdSchema.nullable(), stableIdSchema.nullable()]),
  equippedNormalActives: z.tuple([stableIdSchema.nullable(), stableIdSchema.nullable()]),
  selectedTierPassives: z.object({
    tier0: stableIdSchema.nullable(),
    tier10: stableIdSchema.nullable(),
    tier20: stableIdSchema.nullable()
  }).strict(),
  startedAt: z.string().datetime({ offset: true }),
  endedAt: z.string().datetime({ offset: true }),
  durationMs: nonnegativeIntegerSchema,
  initialEnemyQueueSize: nonnegativeIntegerSchema,
  maximumEnemyQueueSize: nonnegativeIntegerSchema,
  enemyArchetypeCounts: metricMapSchema,
  playerActionCount: nonnegativeIntegerSchema,
  enemyActionCount: nonnegativeIntegerSchema,
  enemyApproachActionCount: nonnegativeIntegerSchema,
  basicAttacks: nonnegativeIntegerSchema,
  resetStrikesByAbility: metricMapSchema,
  normalActivesByAbility: metricMapSchema,
  tauntUses: nonnegativeIntegerSchema,
  tauntEligibleCandidates: nonnegativeIntegerSchema.default(0),
  tauntEnemiesAdded: nonnegativeIntegerSchema.default(0),
  tauntEnemiesExcludedByCap: nonnegativeIntegerSchema.default(0),
  resetWindowOpportunities: nonnegativeIntegerSchema,
  resetWindowSuccesses: nonnegativeIntegerSchema,
  preAutoResetBufferSuccesses: nonnegativeIntegerSchema,
  postAutoResetWindowSuccesses: nonnegativeIntegerSchema,
  rageGenerated: nonnegativeFiniteSchema,
  rageSpent: nonnegativeFiniteSchema,
  rageWastedAtCap: nonnegativeFiniteSchema,
  resourceGenerated: nonnegativeFiniteSchema,
  resourceSpent: nonnegativeFiniteSchema,
  resourceWastedAtCap: nonnegativeFiniteSchema,
  classMetrics: metricMapSchema,
  damageBySource: metricMapSchema,
  damageReceived: nonnegativeFiniteSchema,
  mitigationBySource: mitigationSchema,
  bloodPriceHealthSpent: nonnegativeFiniteSchema,
  reaverHealing: nonnegativeFiniteSchema,
  executionerRefunds: nonnegativeIntegerSchema,
  focusSwitches: nonnegativeIntegerSchema,
  queueInsertions: nonnegativeIntegerSchema,
  queueRemovals: nonnegativeIntegerSchema,
  playerSurvived: z.boolean(),
  enemiesDefeated: nonnegativeIntegerSchema,
  combatEndReason: shortStableIdSchema,
  traceEntriesObserved: nonnegativeIntegerSchema,
  actionTraceTruncated: z.boolean(),
  actionTrace: z.array(combatActionTraceEntrySchema).max(MAX_COMBAT_ACTION_TRACE_ENTRIES)
}).strict().superRefine((summary, context) => {
  const startedAt = Date.parse(summary.startedAt);
  const endedAt = Date.parse(summary.endedAt);
  if (endedAt < startedAt) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["endedAt"], message: "endedAt precedes startedAt" });
  }
  if (summary.durationMs !== Math.max(0, Math.trunc(endedAt - startedAt))) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["durationMs"], message: "durationMs must match the session timestamps" });
  }
  if (summary.maximumEnemyQueueSize < summary.initialEnemyQueueSize) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["maximumEnemyQueueSize"], message: "maximum queue size cannot be below the initial size" });
  }
  if (summary.enemyApproachActionCount > summary.enemyActionCount) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["enemyApproachActionCount"], message: "approaches cannot exceed enemy actions" });
  }
  if (summary.resetWindowSuccesses > summary.resetWindowOpportunities) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["resetWindowSuccesses"], message: "reset successes cannot exceed opportunities" });
  }
  if (summary.tauntEnemiesAdded + summary.tauntEnemiesExcludedByCap > summary.tauntEligibleCandidates) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["tauntEnemiesAdded"],
      message: "Taunt additions and cap exclusions cannot exceed eligible candidates"
    });
  }
  if (summary.traceEntriesObserved < summary.actionTrace.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["traceEntriesObserved"], message: "observed trace count cannot be below the retained count" });
  }
  if (summary.actionTraceTruncated !== (summary.traceEntriesObserved > summary.actionTrace.length)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["actionTraceTruncated"], message: "trace truncation flag does not match retained data" });
  }
});

export type CombatBalanceSummary = z.infer<typeof combatBalanceSummarySchema>;

export function parseCombatBalanceSummary(stored: unknown): CombatBalanceSummary {
  const input = withoutRetiredClassFields(stored);
  if (
    input &&
    typeof input === "object" &&
    ((input as { schemaVersion?: unknown }).schemaVersion === 1 ||
      (input as { schemaVersion?: unknown }).schemaVersion === 2)
  ) {
    const legacy = input as Record<string, unknown>;
    return combatBalanceSummarySchema.parse({
      ...legacy,
      schemaVersion: COMBAT_TELEMETRY_SCHEMA_VERSION,
      activeClassLevel: legacy.warriorLevel,
      primaryResourceId: "rage",
      weaponMode: null,
      resourceGenerated: legacy.rageGenerated ?? 0,
      resourceSpent: legacy.rageSpent ?? 0,
      resourceWastedAtCap: legacy.rageWastedAtCap ?? 0,
      classMetrics: legacy.classMetrics ?? {},
      characterLevel: legacy.activeClassLevel ?? legacy.warriorLevel ?? 0,
      warriorRank: Math.min(15, Number(legacy.warriorLevel ?? 0)),
      activeKitIndex: null,
      readiedWeaponSlot: "melee",
      weaponCategory: null,
      weaponItemLevel: null,
      effectiveWeaponLevel: null,
      weightedArmorLevel: 0,
      shieldLevel: null,
      pvpOffense: 0,
      pvpGuard: 0,
      kitSwitchCount: 0,
      latestKitActivationTick: null,
      timeFromKitActivationToNextResolvedActionTicks: null,
      invalidKitActivationAttempts: 0,
      damageBeforePowerScaling: 0,
      powerMultiplier: 1,
      finalPowerScaledDamage: 0
    });
  }
  return combatBalanceSummarySchema.parse(input);
}

function withoutRetiredClassFields(input: unknown): unknown {
  if (!input || typeof input !== "object") return input;
  const summary = { ...(input as Record<string, unknown>) };
  const mitigation = summary.mitigationBySource;
  if (mitigation && typeof mitigation === "object") {
    const kept = { ...(mitigation as Record<string, unknown>) };
    for (const source of RETIRED_MITIGATION_SOURCES) delete kept[source];
    summary.mitigationBySource = kept;
  }
  if (RETIRED_RESOURCE_IDS.includes(summary.primaryResourceId)) summary.primaryResourceId = "rage";
  return summary;
}

const sessionSeedSchema = z.object({
  combatSessionId: stableIdSchema,
  playerId: stableIdSchema,
  activeClassId: shortStableIdSchema,
  activeSubclassId: shortStableIdSchema.nullable(),
  activeClassLevel: z.number().int().min(0).max(25).optional(),
  primaryResourceId: z.enum(["rage", "focus"]).optional(),
  weaponMode: z.enum(["ranged", "melee"]).nullable().optional(),
  warriorLevel: z.number().int().min(0).max(25),
  characterLevel: z.number().int().min(0).max(CURRENT_LEVEL_CAP).optional(),
  warriorRank: z.number().int().min(0).max(15).optional(),
  activeKitIndex: z.number().int().min(1).max(6).nullable().optional(),
  readiedWeaponSlot: z.enum(["melee", "secondary"]).optional(),
  weaponCategory: shortStableIdSchema.nullable().optional(),
  weaponItemLevel: equipmentLevelSchema.nullable().optional(),
  effectiveWeaponLevel: effectiveEquipmentLevelSchema.nullable().optional(),
  weightedArmorLevel: effectiveEquipmentLevelSchema.optional(),
  shieldLevel: equipmentLevelSchema.nullable().optional(),
  pvpOffense: combatPowerSchema.optional(),
  pvpGuard: combatPowerSchema.optional(),
  equippedResetActives: z.tuple([stableIdSchema.nullable(), stableIdSchema.nullable()]),
  equippedNormalActives: z.tuple([stableIdSchema.nullable(), stableIdSchema.nullable()]),
  selectedTierPassives: z.object({
    tier0: stableIdSchema.nullable(),
    tier10: stableIdSchema.nullable(),
    tier20: stableIdSchema.nullable()
  }).strict(),
  initialEnemyQueueSize: nonnegativeIntegerSchema,
  enemyArchetypeCounts: metricMapSchema,
  startedAtMs: timestampMsSchema
}).strict();

export type CombatTelemetrySessionSeed = z.infer<typeof sessionSeedSchema>;
export type PlayerTelemetryAction = "basic_attack" | "reset_strike" | "normal_active" | "taunt";

export class CombatTelemetryAccumulator {
  private readonly seed: CombatTelemetrySessionSeed;
  private initialEnemyQueueSize: number;
  private initialQueueSizeCaptured: boolean;
  private maximumEnemyQueueSize: number;
  private readonly enemyArchetypeCounts: Record<string, number>;
  private playerActionCount = 0;
  private enemyActionCount = 0;
  private enemyApproachActionCount = 0;
  private basicAttacks = 0;
  private readonly resetStrikesByAbility: Record<string, number> = {};
  private readonly normalActivesByAbility: Record<string, number> = {};
  private tauntUses = 0;
  private tauntEligibleCandidates = 0;
  private tauntEnemiesAdded = 0;
  private tauntEnemiesExcludedByCap = 0;
  private resetWindowOpportunities = 0;
  private resetWindowSuccesses = 0;
  private preAutoResetBufferSuccesses = 0;
  private postAutoResetWindowSuccesses = 0;
  private rageGenerated = 0;
  private rageSpent = 0;
  private rageWastedAtCap = 0;
  private readonly classMetrics: Record<string, number> = {};
  private readonly damageBySource: Record<string, number> = {};
  private damageReceived = 0;
  private readonly mitigationBySource = emptyMitigation();
  private bloodPriceHealthSpent = 0;
  private reaverHealing = 0;
  private executionerRefunds = 0;
  private focusSwitches = 0;
  private activeKitIndex: number | null;
  private readiedWeaponSlot: "melee" | "secondary";
  private weaponCategory: string | null;
  private weaponItemLevel: number | null;
  private effectiveWeaponLevel: number | null;
  private weightedArmorLevel: number;
  private shieldLevel: number | null;
  private pvpOffense: number;
  private pvpGuard: number;
  private kitSwitchCount = 0;
  private latestKitActivationTick: number | null = null;
  private pendingKitActivationTick: number | null = null;
  private timeFromKitActivationToNextResolvedActionTicks: number | null = null;
  private invalidKitActivationAttempts = 0;
  private damageBeforePowerScaling = 0;
  private powerMultiplier = 1;
  private finalPowerScaledDamage = 0;
  private queueInsertions = 0;
  private queueRemovals = 0;
  private enemiesDefeated = 0;
  private traceEntriesObserved = 0;
  private readonly actionTrace: CombatActionTraceEntry[] = [];
  private finished = false;

  constructor(seed: CombatTelemetrySessionSeed) {
    this.seed = sessionSeedSchema.parse(seed);
    this.initialEnemyQueueSize = this.seed.initialEnemyQueueSize;
    this.initialQueueSizeCaptured = this.seed.initialEnemyQueueSize > 0;
    this.maximumEnemyQueueSize = this.seed.initialEnemyQueueSize;
    this.enemyArchetypeCounts = { ...this.seed.enemyArchetypeCounts };
    this.activeKitIndex = this.seed.activeKitIndex ?? null;
    this.readiedWeaponSlot = this.seed.readiedWeaponSlot ?? "melee";
    this.weaponCategory = this.seed.weaponCategory ?? null;
    this.weaponItemLevel = this.seed.weaponItemLevel ?? null;
    this.effectiveWeaponLevel = this.seed.effectiveWeaponLevel ?? null;
    this.weightedArmorLevel = this.seed.weightedArmorLevel ?? 0;
    this.shieldLevel = this.seed.shieldLevel ?? null;
    this.pvpOffense = this.seed.pvpOffense ?? 0;
    this.pvpGuard = this.seed.pvpGuard ?? 0;
  }

  captureInitialQueueSize(size: number): void {
    this.assertOpen();
    const normalized = requireNonnegativeInteger(size, "initial queue size");
    if (this.initialQueueSizeCaptured) return;
    this.initialEnemyQueueSize = normalized;
    this.initialQueueSizeCaptured = true;
    this.observeQueueSize(normalized);
  }

  observeQueueSize(size: number): void {
    this.assertOpen();
    const normalized = requireNonnegativeInteger(size, "queue size");
    this.maximumEnemyQueueSize = Math.max(this.maximumEnemyQueueSize, normalized);
  }

  recordQueueInsertion(archetype: string, queueSize: number, atMs: number, count = 1): void {
    this.assertOpen();
    const stableArchetype = stableIdSchema.parse(archetype);
    const normalizedCount = requireNonnegativeInteger(count, "queue insertion count");
    const normalizedSize = requireNonnegativeInteger(queueSize, "queue size");
    requireNonnegative(atMs, "queue insertion time");
    this.queueInsertions += normalizedCount;
    increment(this.enemyArchetypeCounts, stableArchetype, normalizedCount);
    this.observeQueueSize(normalizedSize);
    this.trace({ actor: "system", action: "queue_insertion", result: "resolved", enemyArchetype: stableArchetype, queueSize: normalizedSize }, atMs);
  }

  recordQueueRemoval(queueSize: number, atMs: number, count = 1): void {
    this.assertOpen();
    const normalizedCount = requireNonnegativeInteger(count, "queue removal count");
    const normalizedSize = requireNonnegativeInteger(queueSize, "queue size");
    requireNonnegative(atMs, "queue removal time");
    this.queueRemovals += normalizedCount;
    this.trace({ actor: "system", action: "queue_removal", result: "removed", queueSize: normalizedSize }, atMs);
  }

  recordPlayerAction(input: {
    action: PlayerTelemetryAction;
    atMs: number;
    abilityId?: string;
    damage?: number;
    rageDelta?: number;
  }): void {
    this.assertOpen();
    const abilityId = input.abilityId === undefined ? undefined : stableIdSchema.parse(input.abilityId);
    const damage = input.damage === undefined ? undefined : requireNonnegative(input.damage, "action damage");
    if (input.action === "reset_strike") {
      if (!abilityId) throw new Error("reset telemetry requires an ability id");
    }
    if (input.action === "normal_active") {
      if (!abilityId) throw new Error("normal-active telemetry requires an ability id");
    }
    requireNonnegative(input.atMs, "player action time");
    if (input.rageDelta !== undefined) {
      z.number().finite().min(-1_000_000).max(1_000_000).parse(input.rageDelta);
    }
    this.playerActionCount += 1;
    if (input.action === "basic_attack") this.basicAttacks += 1;
    if (input.action === "taunt") this.tauntUses += 1;
    if (input.action === "reset_strike") {
      increment(this.resetStrikesByAbility, abilityId!, 1);
    }
    if (input.action === "normal_active") {
      increment(this.normalActivesByAbility, abilityId!, 1);
    }
    this.trace({
      actor: "player",
      action: input.action,
      result: "resolved",
      ...(abilityId ? { abilityId } : {}),
      ...(damage === undefined ? {} : { damage }),
      ...(input.rageDelta === undefined ? {} : { rageDelta: input.rageDelta })
    }, input.atMs);
  }

  recordTauntResult(input: {
    eligibleCandidates: number;
    enemiesAdded: number;
    excludedByCap: number;
  }): void {
    this.assertOpen();
    const eligibleCandidates = requireNonnegativeInteger(input.eligibleCandidates, "eligible Taunt candidates");
    const enemiesAdded = requireNonnegativeInteger(input.enemiesAdded, "Taunt enemies added");
    const excludedByCap = requireNonnegativeInteger(input.excludedByCap, "Taunt enemies excluded by cap");
    if (enemiesAdded + excludedByCap > eligibleCandidates) {
      throw new Error("Taunt additions and cap exclusions cannot exceed eligible candidates");
    }
    this.tauntEligibleCandidates += eligibleCandidates;
    this.tauntEnemiesAdded += enemiesAdded;
    this.tauntEnemiesExcludedByCap += excludedByCap;
  }

  recordEnemyAction(input: {
    action: "attack" | "approach";
    atMs: number;
    enemyArchetype: string;
    damage?: number;
  }): void {
    this.assertOpen();
    const enemyArchetype = stableIdSchema.parse(input.enemyArchetype);
    const damage = input.damage === undefined ? undefined : requireNonnegative(input.damage, "enemy damage");
    requireNonnegative(input.atMs, "enemy action time");
    this.enemyActionCount += 1;
    if (input.action === "approach") this.enemyApproachActionCount += 1;
    this.trace({
      actor: "enemy",
      action: input.action === "approach" ? "enemy_approach" : "enemy_attack",
      result: input.action === "approach" ? "approached" : "resolved",
      enemyArchetype,
      ...(damage === undefined ? {} : { damage })
    }, input.atMs);
  }

  recordResetWindow(outcome: "missed" | "pre_auto_success" | "post_auto_success"): void {
    this.assertOpen();
    this.resetWindowOpportunities += 1;
    if (outcome === "missed") return;
    this.resetWindowSuccesses += 1;
    if (outcome === "pre_auto_success") this.preAutoResetBufferSuccesses += 1;
    if (outcome === "post_auto_success") this.postAutoResetWindowSuccesses += 1;
  }

  recordRage(input: { generated?: number; spent?: number; wastedAtCap?: number }): void {
    this.recordResource(input);
  }

  recordResource(input: { generated?: number; spent?: number; wastedAtCap?: number }): void {
    this.assertOpen();
    const generated = requireNonnegative(input.generated ?? 0, "generated Rage");
    const spent = requireNonnegative(input.spent ?? 0, "spent Rage");
    const wastedAtCap = requireNonnegative(input.wastedAtCap ?? 0, "wasted Rage");
    this.rageGenerated += generated;
    this.rageSpent += spent;
    this.rageWastedAtCap += wastedAtCap;
  }

  recordClassMetric(metric: string, amount = 1): void {
    this.assertOpen();
    increment(this.classMetrics, stableIdSchema.parse(metric), requireNonnegative(amount, "class metric"));
  }

  recordClassMetricMaximum(metric: string, value: number): void {
    this.assertOpen();
    const key = stableIdSchema.parse(metric);
    this.classMetrics[key] = Math.max(this.classMetrics[key] ?? 0, requireNonnegative(value, "class metric maximum"));
  }

  recordDamageDealt(source: string, amount: number): void {
    this.assertOpen();
    increment(this.damageBySource, stableIdSchema.parse(source), requireNonnegative(amount, "damage dealt"));
  }

  recordDamageReceived(
    amount: number,
    mitigatedBy: Partial<Record<CombatMitigationSource, number>> = {}
  ): void {
    this.assertOpen();
    const received = requireNonnegative(amount, "damage received");
    const normalizedMitigation = emptyMitigation();
    for (const source of COMBAT_MITIGATION_SOURCES) {
      normalizedMitigation[source] = requireNonnegative(mitigatedBy[source] ?? 0, `${source} mitigation`);
    }
    this.damageReceived += received;
    for (const source of COMBAT_MITIGATION_SOURCES) {
      this.mitigationBySource[source] += normalizedMitigation[source];
    }
  }

  recordBloodPriceHealthSpent(amount: number): void {
    this.assertOpen();
    this.bloodPriceHealthSpent += requireNonnegative(amount, "Blood Price health spent");
  }

  recordReaverHealing(amount: number): void {
    this.assertOpen();
    this.reaverHealing += requireNonnegative(amount, "Reaver healing");
  }

  recordExecutionerRefund(count = 1): void {
    this.assertOpen();
    this.executionerRefunds += requireNonnegativeInteger(count, "Executioner refunds");
  }

  recordFocusSwitch(atMs: number): void {
    this.assertOpen();
    requireNonnegative(atMs, "focus switch time");
    this.focusSwitches += 1;
    this.trace({ actor: "system", action: "focus_switch", result: "resolved" }, atMs);
  }

  recordEquipmentState(input: {
    activeKitIndex: number | null;
    readiedWeaponSlot: "melee" | "secondary";
    weaponCategory: string | null;
    weaponItemLevel: number | null;
    effectiveWeaponLevel: number | null;
    weightedArmorLevel: number;
    shieldLevel: number | null;
    pvpOffense: number;
    pvpGuard: number;
  }): void {
    this.assertOpen();
    this.activeKitIndex = input.activeKitIndex === null
      ? null
      : z.number().int().min(1).max(6).parse(input.activeKitIndex);
    this.readiedWeaponSlot = z.enum(["melee", "secondary"]).parse(input.readiedWeaponSlot);
    this.weaponCategory = input.weaponCategory === null
      ? null
      : shortStableIdSchema.parse(input.weaponCategory);
    this.weaponItemLevel = input.weaponItemLevel === null
      ? null
      : equipmentLevelSchema.parse(input.weaponItemLevel);
    this.effectiveWeaponLevel = input.effectiveWeaponLevel === null
      ? null
      : effectiveEquipmentLevelSchema.parse(input.effectiveWeaponLevel);
    this.weightedArmorLevel = effectiveEquipmentLevelSchema.parse(input.weightedArmorLevel);
    this.shieldLevel = input.shieldLevel === null
      ? null
      : equipmentLevelSchema.parse(input.shieldLevel);
    this.pvpOffense = combatPowerSchema.parse(input.pvpOffense);
    this.pvpGuard = combatPowerSchema.parse(input.pvpGuard);
  }

  recordKitActivation(input: {
    activationTick: number;
    atMs: number;
    equipment: Parameters<CombatTelemetryAccumulator["recordEquipmentState"]>[0];
  }): void {
    this.assertOpen();
    const activationTick = requireNonnegativeInteger(input.activationTick, "kit activation tick");
    requireNonnegative(input.atMs, "kit activation time");
    this.recordEquipmentState(input.equipment);
    this.kitSwitchCount += 1;
    this.latestKitActivationTick = activationTick;
    this.pendingKitActivationTick = activationTick;
    this.trace({ actor: "system", action: "kit_activation", result: "resolved" }, input.atMs);
  }

  recordInvalidKitActivation(count = 1): void {
    this.assertOpen();
    this.invalidKitActivationAttempts += requireNonnegativeInteger(
      count,
      "invalid kit activation count"
    );
  }

  recordPowerResolution(input: {
    damageBeforePowerScaling: number;
    powerMultiplier: number;
    finalPowerScaledDamage: number;
    resolvedTick: number;
  }): void {
    this.assertOpen();
    this.damageBeforePowerScaling = requireNonnegative(
      input.damageBeforePowerScaling,
      "damage before power scaling"
    );
    this.powerMultiplier = z.number().finite().min(0).max(10).parse(input.powerMultiplier);
    this.finalPowerScaledDamage = requireNonnegative(
      input.finalPowerScaledDamage,
      "final power-scaled damage"
    );
    const resolvedTick = requireNonnegativeInteger(input.resolvedTick, "resolved action tick");
    if (this.pendingKitActivationTick !== null) {
      this.timeFromKitActivationToNextResolvedActionTicks = Math.max(
        0,
        resolvedTick - this.pendingKitActivationTick
      );
      this.pendingKitActivationTick = null;
    }
  }

  recordEnemyDefeated(archetype: string, atMs: number): void {
    this.assertOpen();
    const enemyArchetype = stableIdSchema.parse(archetype);
    requireNonnegative(atMs, "enemy defeat time");
    this.enemiesDefeated += 1;
    this.trace({ actor: "system", action: "enemy_defeated", result: "defeated", enemyArchetype }, atMs);
  }

  finish(input: {
    endedAtMs: number;
    playerSurvived: boolean;
    combatEndReason: string;
  }): CombatBalanceSummary {
    this.assertOpen();
    const endedAtMs = requireNonnegative(input.endedAtMs, "combat end time");
    if (endedAtMs < this.seed.startedAtMs) throw new Error("combat end time precedes start time");
    const summary = {
      schemaVersion: COMBAT_TELEMETRY_SCHEMA_VERSION,
      combatSessionId: this.seed.combatSessionId,
      playerId: this.seed.playerId,
      activeClassId: this.seed.activeClassId,
      activeSubclassId: this.seed.activeSubclassId,
      activeClassLevel: this.seed.activeClassLevel ?? this.seed.warriorLevel,
      primaryResourceId: this.seed.primaryResourceId ?? (this.seed.activeClassId === "hunter" ? "focus" : "rage"),
      weaponMode: this.seed.weaponMode ?? null,
      warriorLevel: this.seed.warriorLevel,
      characterLevel: this.seed.characterLevel ?? this.seed.activeClassLevel ?? this.seed.warriorLevel,
      warriorRank: this.seed.warriorRank ?? Math.min(15, this.seed.warriorLevel),
      activeKitIndex: this.activeKitIndex,
      readiedWeaponSlot: this.readiedWeaponSlot,
      weaponCategory: this.weaponCategory,
      weaponItemLevel: this.weaponItemLevel,
      effectiveWeaponLevel: this.effectiveWeaponLevel,
      weightedArmorLevel: this.weightedArmorLevel,
      shieldLevel: this.shieldLevel,
      pvpOffense: this.pvpOffense,
      pvpGuard: this.pvpGuard,
      kitSwitchCount: this.kitSwitchCount,
      latestKitActivationTick: this.latestKitActivationTick,
      timeFromKitActivationToNextResolvedActionTicks:
        this.timeFromKitActivationToNextResolvedActionTicks,
      invalidKitActivationAttempts: this.invalidKitActivationAttempts,
      damageBeforePowerScaling: this.damageBeforePowerScaling,
      powerMultiplier: this.powerMultiplier,
      finalPowerScaledDamage: this.finalPowerScaledDamage,
      equippedResetActives: this.seed.equippedResetActives,
      equippedNormalActives: this.seed.equippedNormalActives,
      selectedTierPassives: this.seed.selectedTierPassives,
      startedAt: new Date(this.seed.startedAtMs).toISOString(),
      endedAt: new Date(endedAtMs).toISOString(),
      durationMs: Math.trunc(endedAtMs - this.seed.startedAtMs),
      initialEnemyQueueSize: this.initialEnemyQueueSize,
      maximumEnemyQueueSize: this.maximumEnemyQueueSize,
      enemyArchetypeCounts: { ...this.enemyArchetypeCounts },
      playerActionCount: this.playerActionCount,
      enemyActionCount: this.enemyActionCount,
      enemyApproachActionCount: this.enemyApproachActionCount,
      basicAttacks: this.basicAttacks,
      resetStrikesByAbility: { ...this.resetStrikesByAbility },
      normalActivesByAbility: { ...this.normalActivesByAbility },
      tauntUses: this.tauntUses,
      tauntEligibleCandidates: this.tauntEligibleCandidates,
      tauntEnemiesAdded: this.tauntEnemiesAdded,
      tauntEnemiesExcludedByCap: this.tauntEnemiesExcludedByCap,
      resetWindowOpportunities: this.resetWindowOpportunities,
      resetWindowSuccesses: this.resetWindowSuccesses,
      preAutoResetBufferSuccesses: this.preAutoResetBufferSuccesses,
      postAutoResetWindowSuccesses: this.postAutoResetWindowSuccesses,
      rageGenerated: this.rageGenerated,
      rageSpent: this.rageSpent,
      rageWastedAtCap: this.rageWastedAtCap,
      resourceGenerated: this.rageGenerated,
      resourceSpent: this.rageSpent,
      resourceWastedAtCap: this.rageWastedAtCap,
      classMetrics: { ...this.classMetrics },
      damageBySource: { ...this.damageBySource },
      damageReceived: this.damageReceived,
      mitigationBySource: { ...this.mitigationBySource },
      bloodPriceHealthSpent: this.bloodPriceHealthSpent,
      reaverHealing: this.reaverHealing,
      executionerRefunds: this.executionerRefunds,
      focusSwitches: this.focusSwitches,
      queueInsertions: this.queueInsertions,
      queueRemovals: this.queueRemovals,
      playerSurvived: input.playerSurvived,
      enemiesDefeated: this.enemiesDefeated,
      combatEndReason: shortStableIdSchema.parse(input.combatEndReason),
      traceEntriesObserved: this.traceEntriesObserved,
      actionTraceTruncated: this.traceEntriesObserved > this.actionTrace.length,
      actionTrace: [...this.actionTrace]
    };
    const completed = combatBalanceSummarySchema.parse(summary);
    this.finished = true;
    return completed;
  }

  private trace(
    input: Omit<CombatActionTraceEntry, "sequence" | "elapsedMs">,
    atMs: number
  ): void {
    const elapsedMs = Math.max(0, Math.trunc(requireNonnegative(atMs, "trace time") - this.seed.startedAtMs));
    const sequence = this.traceEntriesObserved;
    this.traceEntriesObserved += 1;
    if (this.actionTrace.length >= MAX_COMBAT_ACTION_TRACE_ENTRIES) return;
    this.actionTrace.push(combatActionTraceEntrySchema.parse({ sequence, elapsedMs, ...input }));
  }

  private assertOpen(): void {
    if (this.finished) throw new Error("combat telemetry session is already complete");
  }
}

export type CombatTelemetryPersistResult = {
  combatSessionId: string;
  replayed: boolean;
};

export type CombatTelemetryEnqueueResult =
  | { accepted: true; duplicate: boolean }
  | { accepted: false; reason: "capacity" };

export type CombatTelemetryMetrics = {
  queueDepth: number;
  queued: number;
  persisted: number;
  replayed: number;
  failures: number;
  retried: number;
  quarantined: number;
  transientFailures: number;
  permanentFailures: number;
  droppedAtCapacity: number;
};

type QueuedSummary = {
  summary: CombatBalanceSummary;
  payloadHash: string;
  attemptCount: number;
  nextAttemptAt: number;
  lastFailureClass: "transient" | "permanent" | null;
};

type QuarantinedSummary = {
  combatSessionId: string;
  payloadHash: string;
  attemptCount: number;
  errorClass: string;
};

type TelemetryLogger = {
  error(context: Record<string, unknown>, message: string): void;
};

type ExistingSummaryRow = {
  player_id: string;
  payload_sha256: string;
};

type RecentSummaryRow = {
  summary: unknown;
  action_trace: unknown;
};

export class CombatTelemetryService {
  private readonly queue: QueuedSummary[] = [];
  private readonly queuedHashes = new Map<string, string>();
  private readonly quarantine: QuarantinedSummary[] = [];
  private activeFlush: Promise<number> | null = null;
  private readonly metrics: CombatTelemetryMetrics = {
    queueDepth: 0,
    queued: 0,
    persisted: 0,
    replayed: 0,
    failures: 0,
    retried: 0,
    quarantined: 0,
    transientFailures: 0,
    permanentFailures: 0,
    droppedAtCapacity: 0
  };

  constructor(
    private readonly pool: pg.Pool,
    private readonly maximumQueueDepth = MAX_COMBAT_TELEMETRY_QUEUE_DEPTH,
    private readonly logger?: TelemetryLogger
  ) {
    if (!Number.isInteger(maximumQueueDepth) || maximumQueueDepth <= 0) {
      throw new Error("combat telemetry queue depth must be a positive integer");
    }
  }

  enqueue(input: CombatBalanceSummary): CombatTelemetryEnqueueResult {
    const summary = combatBalanceSummarySchema.parse(input);
    const payloadHash = combatTelemetryPayloadHash(summary);
    const existingHash = this.queuedHashes.get(summary.combatSessionId);
    if (existingHash) {
      if (existingHash !== payloadHash) throw new Error("combat telemetry session id was reused with different data");
      return { accepted: true, duplicate: true };
    }
    if (this.queue.length >= this.maximumQueueDepth) {
      this.metrics.droppedAtCapacity += 1;
      return { accepted: false, reason: "capacity" };
    }
    this.queue.push({
      summary,
      payloadHash,
      attemptCount: 0,
      nextAttemptAt: 0,
      lastFailureClass: null
    });
    this.queuedHashes.set(summary.combatSessionId, payloadHash);
    this.metrics.queued += 1;
    this.metrics.queueDepth = this.queue.length;
    return { accepted: true, duplicate: false };
  }

  flush(maximum = this.queue.length): Promise<number> {
    const limit = requireNonnegativeInteger(maximum, "combat telemetry flush limit");
    if (this.activeFlush) {
      return this.activeFlush.then(() => this.flush(limit));
    }
    const pending = this.flushQueued(limit).finally(() => {
      this.activeFlush = null;
    });
    this.activeFlush = pending;
    return pending;
  }

  async persistSummary(input: CombatBalanceSummary): Promise<CombatTelemetryPersistResult> {
    const summary = combatBalanceSummarySchema.parse(input);
    const payloadHash = combatTelemetryPayloadHash(summary);
    const { actionTrace, ...summaryWithoutTrace } = summary;
    const summaryJson = JSON.stringify(summaryWithoutTrace);
    const traceJson = JSON.stringify(actionTrace);
    assertPayloadSize(summaryJson, MAX_COMBAT_SUMMARY_BYTES, "combat summary");
    assertPayloadSize(traceJson, MAX_COMBAT_ACTION_TRACE_BYTES, "combat action trace");
    const inserted = await this.pool.query<{ combat_session_id: string }>(
      `INSERT INTO combat_balance_summaries (
         combat_session_id, player_id, schema_version, active_class_id, active_subclass_id,
         warrior_level, active_class_level, started_at, ended_at, duration_ms, initial_enemy_queue_size,
         maximum_enemy_queue_size, player_survived, enemies_defeated, combat_end_reason,
         payload_sha256, summary, action_trace
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb,$18::jsonb)
       ON CONFLICT (combat_session_id) DO NOTHING
       RETURNING combat_session_id`,
      [
        summary.combatSessionId,
        summary.playerId,
        summary.schemaVersion,
        summary.activeClassId,
        summary.activeSubclassId,
        summary.warriorLevel,
        summary.activeClassLevel,
        summary.startedAt,
        summary.endedAt,
        summary.durationMs,
        summary.initialEnemyQueueSize,
        summary.maximumEnemyQueueSize,
        summary.playerSurvived,
        summary.enemiesDefeated,
        summary.combatEndReason,
        payloadHash,
        summaryJson,
        traceJson
      ]
    );
    if (inserted.rows[0]) {
      this.metrics.persisted += 1;
      return { combatSessionId: summary.combatSessionId, replayed: false };
    }
    const existing = await this.pool.query<ExistingSummaryRow>(
      `SELECT player_id, payload_sha256
       FROM combat_balance_summaries
       WHERE combat_session_id = $1`,
      [summary.combatSessionId]
    );
    const row = existing.rows[0];
    if (!row || row.player_id !== summary.playerId || row.payload_sha256 !== payloadHash) {
      throw new Error("combat telemetry session id collides with different authoritative data");
    }
    this.metrics.replayed += 1;
    return { combatSessionId: summary.combatSessionId, replayed: true };
  }

  async recentForPlayer(playerId: string, requestedLimit = 50): Promise<CombatBalanceSummary[]> {
    const safePlayerId = stableIdSchema.parse(playerId);
    const limit = Math.max(1, Math.min(MAX_RECENT_COMBAT_SUMMARIES, Math.trunc(requestedLimit)));
    const result = await this.pool.query<RecentSummaryRow>(
      `SELECT summary, action_trace
       FROM combat_balance_summaries
       WHERE player_id = $1
       ORDER BY ended_at DESC, combat_session_id
       LIMIT $2`,
      [safePlayerId, limit]
    );
    return result.rows.map((row) => parseCombatBalanceSummary({
      ...recordValue(row.summary, "stored combat summary"),
      actionTrace: row.action_trace
    }));
  }

  async exportRecentForPlayer(
    playerId: string,
    requestedLimit = 50,
    generatedAt = new Date()
  ): Promise<string> {
    const summaries = await this.recentForPlayer(playerId, requestedLimit);
    return JSON.stringify({
      schemaVersion: COMBAT_TELEMETRY_SCHEMA_VERSION,
      generatedAt: generatedAt.toISOString(),
      playerId: stableIdSchema.parse(playerId),
      summaries
    }, null, 2);
  }

  metricsSnapshot(): CombatTelemetryMetrics {
    return { ...this.metrics, queueDepth: this.queue.length };
  }

  private async flushQueued(maximum: number): Promise<number> {
    let completed = 0;
    let inspected = 0;
    const inspectionLimit = Math.min(this.queue.length, maximum);
    while (inspected < inspectionLimit) {
      const next = this.queue.shift();
      if (!next) break;
      inspected += 1;
      if (next.nextAttemptAt > Date.now()) {
        this.queue.push(next);
        continue;
      }
      try {
        await this.persistSummary(next.summary);
      } catch (error) {
        this.metrics.failures += 1;
        next.attemptCount += 1;
        const failureClass = classifyTelemetryFailure(error);
        next.lastFailureClass = failureClass;
        if (failureClass === "permanent") this.metrics.permanentFailures += 1;
        else this.metrics.transientFailures += 1;
        if (failureClass === "permanent" || next.attemptCount >= COMBAT_TELEMETRY_MAX_ATTEMPTS) {
          this.quarantineSummary(next, error);
        } else {
          next.nextAttemptAt = Date.now() + Math.min(
            COMBAT_TELEMETRY_MAX_RETRY_DELAY_MS,
            COMBAT_TELEMETRY_INITIAL_RETRY_DELAY_MS * 2 ** (next.attemptCount - 1)
          );
          this.metrics.retried += 1;
          this.queue.push(next);
        }
        continue;
      }
      this.queuedHashes.delete(next.summary.combatSessionId);
      completed += 1;
      this.metrics.queueDepth = this.queue.length;
    }
    return completed;
  }

  private quarantineSummary(next: QueuedSummary, error: unknown): void {
    const errorClass = telemetryErrorClass(error);
    this.queuedHashes.delete(next.summary.combatSessionId);
    this.metrics.quarantined += 1;
    this.quarantine.push({
      combatSessionId: next.summary.combatSessionId,
      payloadHash: next.payloadHash,
      attemptCount: next.attemptCount,
      errorClass
    });
    if (this.quarantine.length > MAX_COMBAT_TELEMETRY_QUARANTINE_ENTRIES) this.quarantine.shift();
    this.logger?.error({
      combatSessionId: next.summary.combatSessionId,
      payloadHash: next.payloadHash,
      attemptCount: next.attemptCount,
      errorClass
    }, "combat telemetry record quarantined");
  }
}

function classifyTelemetryFailure(error: unknown): "transient" | "permanent" {
  const code = typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code ?? "")
    : "";
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  return code.startsWith("22") || code.startsWith("23") ||
    /collid|constraint|malformed|invalid|validation/.test(message)
    ? "permanent"
    : "transient";
}

function telemetryErrorClass(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = String((error as { code?: unknown }).code ?? "");
    if (code) return code.slice(0, 40);
  }
  return error instanceof Error ? error.name.slice(0, 40) : "UnknownError";
}

export function combatTelemetryPayloadHash(summary: CombatBalanceSummary): string {
  const canonical = canonicalJson(combatBalanceSummarySchema.parse(summary));
  return createHash("sha256").update(canonical).digest("hex");
}

function emptyMitigation(): Record<CombatMitigationSource, number> {
  return {
    armor: 0,
    queue_discipline: 0,
    crowd_breaker: 0,
    fortify: 0,
    ironhide: 0,
    last_stand: 0,
    guard: 0,
    guardians_reprisal: 0
  };
}

function increment(target: Record<string, number>, key: string, amount: number): void {
  target[key] = (target[key] ?? 0) + amount;
}

function requireNonnegative(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${label} must be a nonnegative finite number`);
  return value;
}

function requireNonnegativeInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 0) throw new Error(`${label} must be a nonnegative integer`);
  return value;
}

function recordValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is invalid`);
  return value as Record<string, unknown>;
}

function assertPayloadSize(json: string, maximum: number, label: string): void {
  if (Buffer.byteLength(json, "utf8") > maximum) throw new Error(`${label} exceeds its bounded storage size`);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
