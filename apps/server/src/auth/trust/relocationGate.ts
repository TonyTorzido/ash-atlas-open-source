import { DEFAULT_TRUST_RISK_SIGNAL_WEIGHTS, type AppConfig } from "../../config.js";
import type { AppLogger } from "../../logger.js";
import type { PopulationClass } from "./populationGrid.js";
import { SETTLED_REVIEW_HOLD_MESSAGE, type SettlementService } from "./settlement.js";
import type { TrustAdminOps } from "./trustAdminOps.js";
import { ZONE_ALERT_SEVERITY, alertCellKey, type RedAllowance, type TrustAlertWriter } from "./trustAlerts.js";
import { isTrustReviewAccount, type TrustReviewConfig } from "./trustReviewAccounts.js";
import type { TrustSignalSink } from "./trustService.js";

// Relocation trust gate (docs/architecture/NATIVE_ANTISPOOF_BUILD_PLAN.md 4.3,
// 4.5, 6): phone-only relocation and population alert zones. Runs in the GPS
// relocation path before the authoritative travel; a refusal never consumes the
// cooldown or a free re-pick (the caller releases its claim).

export const RELOCATION_NATIVE_ONLY_MESSAGE =
  "Relocating uses your phone's location. Open the Ash Atlas app on your phone to move your home.";
export const RELOCATION_RED_REFUSED_MESSAGE = "You can't relocate here.";

export const ORANGE_ZONE_DIFFICULTY = 2;
export const YELLOW_ZONE_DIFFICULTY = 1.5;
export const RELOCATION_RED_ZONE_WEIGHT = 3;
export const RELOCATION_RED_REPEAT_WEIGHT = 1;
const YELLOW_OWNER_DETAIL_LIMIT = 25;

export type RelocationGateConfig = Pick<
  AppConfig,
  | "TRUST_ALERT_ZONE_MODE"
  | "TRUST_RELOCATION_NATIVE_ONLY_MODE"
  | "TRUST_KINGDOM_ALERT_RADIUS_KM"
  | "TRUST_RED_ZONE_LOCK_MAX_AGE_DAYS"
> & Partial<Pick<AppConfig, "TRUST_KINGDOM_PROXIMITY_RED_KM" | "TRUST_RISK_SIGNAL_WEIGHTS">> & TrustReviewConfig;

const DEFAULT_KINGDOM_PROXIMITY_RED_KM = 3;

export type RelocationZoneDecision =
  | Readonly<{
      allowed: false;
      message: string;
      // Set when the account was locked: closes its live connections. The
      // caller runs it after answering the request and does not await it.
      afterRefusal?: () => Promise<void>;
    }>
  | Readonly<{
      allowed: true;
      // Undo a consumed admin allowance when the relocation did not commit.
      release(): Promise<void>;
      // Alerts, signals and difficulty for a committed relocation. Never throws.
      committed(): Promise<void>;
    }>;

export type RelocationGateDependencies = Readonly<{
  config: RelocationGateConfig;
  classify(lat: number, lon: number): PopulationClass;
  yellowOwners(lat: number, lon: number, radiusKm: number, excludeAccountId: string, limit: number): Promise<string[]>;
  // Other accounts whose kingdom seat/territory is within radiusKm (owner decision B).
  kingdomOwners?(lat: number, lon: number, radiusKm: number, excludeAccountId: string, limit: number): Promise<string[]>;
  alerts: TrustAlertWriter;
  // Brand-new account red lock (enforce). Absent = every account is refused only.
  redZoneLock?: Pick<TrustAdminOps, "lockNewAccountForRedZone"> | undefined;
  settlement?: (Pick<SettlementService, "raiseDifficulty">
    & Partial<Pick<SettlementService, "isSettled" | "suspendForReview">>) | undefined;
  sink?: TrustSignalSink | undefined;
  logger?: Pick<AppLogger, "warn"> | undefined;
  now?: () => Date;
}>;

const NOOP_DECISION: RelocationZoneDecision = {
  allowed: true,
  release: async () => undefined,
  committed: async () => undefined
};

function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

export class RelocationGate {
  private readonly now: () => Date;

  constructor(private readonly deps: RelocationGateDependencies) {
    this.now = deps.now ?? (() => new Date());
  }

  /**
   * Phone-only relocation (TRUST_RELOCATION_NATIVE_ONLY_MODE). Returns the
   * refusal copy in enforce; shadow records a 0-weight signal and allows.
   */
  async checkPlatform(input: Readonly<{
    accountId: string;
    clientPlatform: "web" | "ios" | "android" | undefined;
  }>): Promise<string | null> {
    const mode = this.deps.config.TRUST_RELOCATION_NATIVE_ONLY_MODE;
    if (mode === "off" || input.clientPlatform !== "web") return null;
    if (mode === "enforce") return RELOCATION_NATIVE_ONLY_MESSAGE;
    await this.signal(input.accountId, "relocation_web", 0, {
      mode,
      dedupeKey: `relocation_web:${input.accountId}:${utcDay(this.now())}`
    });
    return null;
  }

  /**
   * Alert zones (TRUST_ALERT_ZONE_MODE). Red in enforce is refused unless an
   * admin allowance for this cell is left, which is consumed here. A brand-new
   * account (younger than TRUST_RED_ZONE_LOCK_MAX_AGE_DAYS, never Settled) is
   * locked; any other gets a pending alert (one per account). Everything else
   * proceeds; its alerts and difficulty land in committed().
   */
  async checkDestination(input: Readonly<{ accountId: string; lat: number; lon: number }>): Promise<RelocationZoneDecision> {
    const mode = this.deps.config.TRUST_ALERT_ZONE_MODE;
    if (mode === "off") return NOOP_DECISION;
    const { accountId, lat, lon } = input;
    const now = this.now();
    const zone = this.deps.classify(lat, lon);
    let allowance: RedAllowance | null = null;
    let shadowRed = false;
    if (zone === "red") {
      allowance = await this.deps.alerts.consumeRedAllowance(accountId, alertCellKey(lat, lon), now);
      if (!allowance) {
        // Store-review accounts are never locked or refused: shadow treatment.
        if (mode === "enforce" && !isTrustReviewAccount(this.deps.config, accountId)) {
          const refusal = await this.redRefusal({ accountId, lat, lon, now, zone });
          return { allowed: false, message: refusal.message, ...(refusal.afterRefusal ? { afterRefusal: refusal.afterRefusal } : {}) };
        }
        shadowRed = true;
      }
    }
    const held = allowance;
    return {
      allowed: true,
      release: async () => {
        if (held) await this.deps.alerts.restoreRedAllowance(held);
      },
      committed: () => this.afterCommit({ accountId, lat, lon, zone, shadowRed, allowanceUsed: held !== null, now })
    };
  }

  private async afterCommit(input: Readonly<{
    accountId: string;
    lat: number;
    lon: number;
    zone: PopulationClass;
    shadowRed: boolean;
    allowanceUsed: boolean;
    now: Date;
  }>): Promise<void> {
    const { accountId, lat, lon, zone, now } = input;
    const mode = this.deps.config.TRUST_ALERT_ZONE_MODE;
    if (input.shadowRed) {
      await this.guard(accountId, "red", () => this.fileRed({ accountId, lat, lon, now, zone }));
    }
    let difficulty = 1;
    if (zone === "orange") {
      difficulty = ORANGE_ZONE_DIFFICULTY;
      await this.guard(accountId, "orange", () => this.deps.alerts.fileZoneAlert({
        accountId, kind: "zone_orange", lat, lon, now, details: { mode, populationClass: zone }
      }));
    }
    // Yellow (owner decision B): another player's city or territory within the
    // radius files an alert + territory_proximity in every cell class; the extra
    // settling difficulty stays outside urban cells (plan 4.2).
    await this.guard(accountId, "yellow", async () => {
      const owners = await this.deps.yellowOwners(
        lat, lon, this.deps.config.TRUST_KINGDOM_ALERT_RADIUS_KM, accountId, YELLOW_OWNER_DETAIL_LIMIT
      );
      if (owners.length === 0) return;
      if (zone !== "urban") difficulty = Math.max(difficulty, YELLOW_ZONE_DIFFICULTY);
      await this.deps.alerts.fileZoneAlert({
        accountId, kind: "zone_yellow", lat, lon, now,
        details: { mode, populationClass: zone, owners, ...(input.allowanceUsed ? { allowanceUsed: true } : {}) }
      });
      await this.signal(accountId, "territory_proximity", this.riskWeight("territory_proximity"), {
        mode,
        populationClass: zone,
        owners: owners.length,
        dedupeKey: `territory_proximity:${accountId}:${utcDay(now)}`
      });
    });
    // Kingdom proximity (owner decision B): a major red flag, never a lock or refusal.
    const kingdomRadiusKm = this.deps.config.TRUST_KINGDOM_PROXIMITY_RED_KM ?? DEFAULT_KINGDOM_PROXIMITY_RED_KM;
    const kingdomOwners = this.deps.kingdomOwners;
    if (kingdomOwners && kingdomRadiusKm > 0) {
      await this.guard(accountId, "kingdom", async () => {
        const owners = await kingdomOwners(lat, lon, kingdomRadiusKm, accountId, YELLOW_OWNER_DETAIL_LIMIT);
        if (owners.length === 0) return;
        await this.deps.alerts.fileZoneAlert({
          accountId, kind: "kingdom_proximity", lat, lon, now,
          details: { mode, populationClass: zone, owners, radiusKm: kingdomRadiusKm }
        });
        await this.signal(accountId, "kingdom_proximity", this.riskWeight("kingdom_proximity"), {
          mode,
          owners: owners.length,
          dedupeKey: `kingdom_proximity:${accountId}:${utcDay(now)}`
        });
      });
    }
    if (difficulty > 1 && this.deps.settlement) {
      const settlement = this.deps.settlement;
      await this.guard(accountId, "difficulty", () => settlement.raiseDifficulty(accountId, difficulty));
    }
  }

  /**
   * A relocation refused before the zone check (rejected fix: mock, impossible
   * speed, tamper). The red-zone consequences still apply: alert + signal and,
   * in enforce, the brand-new-account lock. Nothing is consumed or moved.
   * `message` replaces the generic refusal copy when the zone decides it.
   */
  async checkRefusedDestination(input: Readonly<{ accountId: string; lat: number; lon: number }>): Promise<Readonly<{
    message: string | null;
    afterRefusal?: () => Promise<void>;
  }>> {
    const mode = this.deps.config.TRUST_ALERT_ZONE_MODE;
    if (mode === "off") return { message: null };
    const { accountId, lat, lon } = input;
    const zone = this.deps.classify(lat, lon);
    if (zone !== "red") return { message: null };
    const now = this.now();
    if (mode === "enforce" && !isTrustReviewAccount(this.deps.config, accountId)) {
      return this.redRefusal({ accountId, lat, lon, now, zone, refusedFix: true });
    }
    await this.guard(accountId, "red", () => this.fileRed({ accountId, lat, lon, now, zone, refusedFix: true }));
    return { message: null };
  }

  // Enforce red without an allowance: brand-new accounts are locked, any other
  // account gets a pending alert (one per account, plan 4.5).
  private async redRefusal(input: Readonly<{
    accountId: string;
    lat: number;
    lon: number;
    now: Date;
    zone: PopulationClass;
    refusedFix?: boolean;
  }>): Promise<Readonly<{ message: string; afterRefusal?: () => Promise<void> }>> {
    const locked = await this.lockNewAccount(input);
    if (locked) return { message: RELOCATION_RED_REFUSED_MESSAGE, afterRefusal: locked };
    if (await this.settledHold(input)) return { message: SETTLED_REVIEW_HOLD_MESSAGE };
    await this.guard(input.accountId, "red", () => this.fileRed(input));
    return { message: RELOCATION_RED_REFUSED_MESSAGE };
  }

  // Owner decision E: a Settled account (provisional included) trying a red
  // zone gets a severity-4 alert and its Settled status paused until an admin
  // approves. True when the hold applied.
  private async settledHold(input: Readonly<{
    accountId: string;
    lat: number;
    lon: number;
    now: Date;
    zone: PopulationClass;
    refusedFix?: boolean;
  }>): Promise<boolean> {
    const settlement = this.deps.settlement;
    if (!settlement?.isSettled || !settlement.suspendForReview) return false;
    const { accountId, lat, lon, now } = input;
    try {
      if (!(await settlement.isSettled(accountId))) return false;
      const mode = this.deps.config.TRUST_ALERT_ZONE_MODE;
      const filed = await this.deps.alerts.fileRedAlert({
        accountId, lat, lon, now,
        severity: ZONE_ALERT_SEVERITY.zone_red_settled_hold,
        details: { mode, populationClass: input.zone, settledHold: true, ...(input.refusedFix ? { refusedFix: true } : {}) }
      });
      if (!(await settlement.suspendForReview(accountId, filed.alertId))) return false;
      await this.signal(accountId, "relocation_red_zone", RELOCATION_RED_ZONE_WEIGHT, {
        mode,
        settledHold: true,
        dedupeKey: filed.alertId ? `relocation_red_zone:${filed.alertId}` : `relocation_red_zone:${accountId}:${utcDay(now)}`
      });
      return true;
    } catch (error) {
      this.deps.logger?.warn({ err: error, accountId }, "Settled review hold failed");
      return false;
    }
  }

  // Pending red alert + relocation_red_zone, or relocation_red_repeat when rate limited.
  private async fileRed(input: Readonly<{
    accountId: string;
    lat: number;
    lon: number;
    now: Date;
    zone: PopulationClass;
    refusedFix?: boolean;
  }>): Promise<void> {
    const { accountId, lat, lon, now } = input;
    const mode = this.deps.config.TRUST_ALERT_ZONE_MODE;
    const filed = await this.deps.alerts.fileRedAlert({
      accountId, lat, lon, now,
      details: { mode, populationClass: input.zone, ...(input.refusedFix ? { refusedFix: true } : {}) }
    });
    if (filed.created) {
      await this.signal(accountId, "relocation_red_zone", RELOCATION_RED_ZONE_WEIGHT, {
        mode,
        dedupeKey: `relocation_red_zone:${filed.alertId}`
      });
    } else {
      await this.redRepeatSignal(accountId, now);
    }
  }

  // Returns the connection close for a locked account, or null when the account
  // is not brand-new (or the lock failed: the refusal path still applies).
  private async lockNewAccount(input: Readonly<{
    accountId: string;
    lat: number;
    lon: number;
    now: Date;
    zone: PopulationClass;
    refusedFix?: boolean;
  }>): Promise<(() => Promise<void>) | null> {
    const maxAgeDays = this.deps.config.TRUST_RED_ZONE_LOCK_MAX_AGE_DAYS;
    if (!this.deps.redZoneLock || maxAgeDays <= 0) return null;
    const { accountId, lat, lon, now } = input;
    const mode = this.deps.config.TRUST_ALERT_ZONE_MODE;
    let locked: Awaited<ReturnType<TrustAdminOps["lockNewAccountForRedZone"]>>;
    try {
      locked = await this.deps.redZoneLock.lockNewAccountForRedZone({
        accountId, lat, lon, now, maxAgeDays,
        details: { mode, populationClass: input.zone, ...(input.refusedFix ? { refusedFix: true } : {}) }
      });
    } catch (error) {
      this.deps.logger?.warn({ err: error, accountId }, "Relocation red-zone account lock failed");
      return null;
    }
    if (!locked) return null;
    const lock = locked;
    await this.signal(accountId, "relocation_red_zone", RELOCATION_RED_ZONE_WEIGHT, {
      mode,
      autoLocked: true,
      dedupeKey: `relocation_red_zone:${lock.alertId}`
    });
    return () => lock.closeConnections();
  }

  private riskWeight(rule: string): number {
    return this.deps.config.TRUST_RISK_SIGNAL_WEIGHTS?.[rule] ?? DEFAULT_TRUST_RISK_SIGNAL_WEIGHTS[rule] ?? 0;
  }

  private async redRepeatSignal(accountId: string, now: Date): Promise<void> {
    await this.signal(accountId, "relocation_red_repeat", RELOCATION_RED_REPEAT_WEIGHT, {
      dedupeKey: `relocation_red_repeat:${accountId}:${utcDay(now)}`
    });
  }

  private async signal(accountId: string, rule: string, weight: number, metadata: Record<string, unknown>): Promise<void> {
    if (!this.deps.sink) return;
    await this.guard(accountId, rule, () => this.deps.sink!.recordSignals({
      accountId,
      signals: [{ rule, weight, metadata }]
    }));
  }

  private async guard(accountId: string, step: string, run: () => Promise<unknown>): Promise<void> {
    try {
      await run();
    } catch (error) {
      this.deps.logger?.warn({ err: error, accountId, step }, "Relocation alert-zone step failed");
    }
  }
}
