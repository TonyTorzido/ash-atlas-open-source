import {
  TRAVEL_INVITE_AFTER_RELOCATION_COOLDOWN_MS,
  distanceMeters,
  type LatLon,
  type LocationFixAssurance
} from "@ash-atlas/shared";

import type { AppConfig } from "../../config.js";
import type { AppLogger } from "../../logger.js";
import { assuranceCountsAsNative } from "./settlement.js";
import { noopTrustSignalSink, type TrustSignalSink } from "./trustService.js";
import { isTrustReviewAccount, type TrustReviewConfig } from "./trustReviewAccounts.js";

// Alt doorway protections (NATIVE_ANTISPOOF_BUILD_PLAN.md §2.6, §2.7, §3.1):
// moving yourself is free; bringing others is earned, in person, at home.
// Player-facing copy never contains thresholds or progress numbers.

export type DoorwayKind = "invite" | "party_manual" | "party_auto_follow";

export type DoorwayDestination =
  | Readonly<{ kind: "flag"; id: string }>
  | Readonly<{ kind: "kingdom_seat"; id: string }>
  | Readonly<{ kind: "manor"; ownerPlayerId: string }>
  | Readonly<{ kind: "world" }>;

export type DoorwayPlayerRecord = Readonly<{
  accountId: string | null;
  accountCreatedAt: Date | null;
  devProfile: boolean;
  // Settled now (account_settlement; expired provisional rows are not).
  settled: boolean;
  settledHome: LatLon | null;
  lastFix: Readonly<{ lat: number; lon: number; at: Date }> | null;
  lastFixAssurance: LocationFixAssurance | null;
  lastRelocatedAt: Date | null;
}>;

export interface AltDoorwayStore {
  loadDoorwayPlayer(playerId: string): Promise<DoorwayPlayerRecord | null>;
  // Position of a flag the player owns, or of a kingdom seat whose kingdom the
  // player founded; null when the player does not own it.
  ownedDestinationPosition(
    playerId: string,
    destination: Readonly<{ kind: "flag" | "kingdom_seat"; id: string }>
  ): Promise<LatLon | null>;
  linkedAccounts(
    accountId: string,
    otherAccountId: string,
    networkSince: Date
  ): Promise<Readonly<{ device: boolean; network: boolean }>>;
  // ASN class (A6 asnClasses, stored in location_reports.features.ipAsnClass) of each
  // network prefix both accounts used since `since`; null when none was recorded.
  // Prefixes are stored hashed, so the class comes from the accounts' own fix reports.
  sharedPrefixAsnClasses?(
    accountId: string,
    otherAccountId: string,
    since: Date
  ): Promise<ReadonlyArray<string | null>>;
  loadArrivalHold(playerId: string): Promise<Date | null>;
  setArrivalHold(playerId: string, until: Date): Promise<void>;
  playerOwnsFlag(playerId: string, flagId: string): Promise<boolean>;
  isDevProfile(accountId: string): Promise<boolean>;
}

export type DoorwayRefusal = Readonly<{
  allowed: false;
  code: string;
  message: string;
  retryAfterMs?: number;
}>;

export type DoorwayDecision = Readonly<{ allowed: true }> | DoorwayRefusal;

export type AltDoorwayConfig = Pick<
  AppConfig,
  | "TRUST_DOORWAY_MODE"
  | "TRUST_SETTLED_GATE_MODE"
  | "TRUST_SETTLE_ASSURANCE_MODE"
  | "TRUST_HOME_DESTINATION_RADIUS_KM"
  | "TRUST_PRESENCE_RADIUS_KM"
  | "TRUST_PRESENCE_MAX_FIX_AGE_SECONDS"
  | "TRUST_ARRIVAL_RAID_MODE"
  | "TRUST_ARRIVAL_RAID_HOLD_MINUTES"
  | "TRUST_LINKED_ALT_MODE"
  | "TRUST_YOUNG_INVITER_DAYS"
  | "TRUST_YOUNG_INVITER_ARRIVAL_HOLD_MINUTES"
> & TrustReviewConfig;

type GateMode = AppConfig["TRUST_DOORWAY_MODE"];
const MODE_STRENGTH: Record<GateMode, number> = { off: 0, shadow: 1, enforce: 2 };

function weakerMode(a: GateMode, b: GateMode): GateMode {
  return MODE_STRENGTH[a] <= MODE_STRENGTH[b] ? a : b;
}

// Numberless copy (plan 2.6): thresholds are secret.
export const DOORWAY_UNSETTLED_INVITE_MESSAGE = "Travel Invites unlock as you play Ash Atlas from your home area.";
export const DOORWAY_UNSETTLED_PARTY_MESSAGE = "Party Travel to this leader unlocks as they play from their home area.";
export const DOORWAY_WEB_INVITE_MESSAGE = "Open the Ash Atlas app on your phone to send Travel Invites.";

// Shared-network refusal hook for young inviters (plan 3.1): refuses only when it
// resolves true. The default keeps shared networks signal-only.
export type SharedNetworkBlockCheck = (input: Readonly<{
  hostAccountId: string;
  guestAccountId: string;
}>) => Promise<boolean>;

/**
 * Plan 3.1 / O10: a young inviter's shared network refuses the invite unless every
 * shared prefix is a known mobile ASN (CGNAT carriers put strangers on one prefix).
 * Unknown ASN, no recorded class, or no IP database counts as not mobile. Fails open
 * when the lookup is unavailable.
 */
export function createSharedNetworkBlock(
  store: Pick<AltDoorwayStore, "sharedPrefixAsnClasses">,
  options: Readonly<{ now?: () => Date; logger?: Pick<AppLogger, "warn"> }> = {}
): SharedNetworkBlockCheck {
  return async ({ hostAccountId, guestAccountId }) => {
    if (!store.sharedPrefixAsnClasses) return false;
    try {
      const since = new Date((options.now?.() ?? new Date()).getTime() - LINKED_NETWORK_WINDOW_MS);
      const classes = await store.sharedPrefixAsnClasses(hostAccountId, guestAccountId, since);
      return classes.length > 0 && classes.some((asnClass) => asnClass !== "mobile");
    } catch (error) {
      options.logger?.warn({ err: error, hostAccountId }, "Shared network ASN class could not be checked");
      return false;
    }
  };
}

export const DOORWAY_SIGNAL_WEIGHTS = {
  // Host not Settled (rule name kept for ledger continuity).
  doorway_unconfirmed: 0.25,
  doorway_no_presence: 0.5,
  linked_device: 1.5,
  linked_network: 0.25,
  arrival_raid_blocked: 0.25
} as const;

export type DoorwaySignalRule = keyof typeof DOORWAY_SIGNAL_WEIGHTS;

const DAY_MS = 24 * 60 * 60_000;
const LINKED_NETWORK_WINDOW_MS = 30 * DAY_MS;
// Arrival holds read from the database are trusted this long.
const HOLD_CACHE_TTL_MS = 30_000;
const MAX_CACHED_PLAYERS = 50_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

const ALLOWED: DoorwayDecision = { allowed: true };

type CachedArrivalHold = { untilMs: number | null; loadedAtMs: number };

function minutesText(ms: number): string {
  const minutes = Math.max(1, Math.ceil(ms / 60_000));
  return minutes === 1 ? "1 minute" : `${minutes} minutes`;
}

function partyKind(kind: DoorwayKind): boolean {
  return kind === "party_manual" || kind === "party_auto_follow";
}

export function doorwayDestinationForAnchor(
  anchor: Readonly<{ sourceType: string; sourceId: string | null }>,
  inviterPlayerId: string
): DoorwayDestination {
  if (anchor.sourceType === "manor") return { kind: "manor", ownerPlayerId: inviterPlayerId };
  if ((anchor.sourceType === "flag" || anchor.sourceType === "kingdom_seat") && anchor.sourceId) {
    return { kind: anchor.sourceType, id: anchor.sourceId };
  }
  return { kind: "world" };
}

export function doorwayDestinationForTravel(
  destination: Readonly<{
    kind: string;
    id: string | null;
    travelAnchor?: Readonly<{ sourceType: string; sourceId: string | null }> | undefined;
  }>
): DoorwayDestination {
  if (destination.travelAnchor?.sourceType === "kingdom_seat" && destination.travelAnchor.sourceId) {
    return { kind: "kingdom_seat", id: destination.travelAnchor.sourceId };
  }
  if (destination.kind === "flag" && destination.id) return { kind: "flag", id: destination.id };
  if (destination.travelAnchor?.sourceType === "flag" && destination.travelAnchor.sourceId) {
    return { kind: "flag", id: destination.travelAnchor.sourceId };
  }
  return { kind: "world" };
}

export class AltDoorwayGate {
  private readonly arrivalHolds = new Map<string, CachedArrivalHold>();
  private readonly hydrations = new Map<string, Promise<CachedArrivalHold>>();
  private readonly sink: TrustSignalSink;
  private readonly logger: Pick<AppLogger, "warn"> | undefined;
  private readonly now: () => Date;
  private readonly devProfilesExempt: () => boolean;
  private readonly sharedNetworkBlock: SharedNetworkBlockCheck;

  constructor(
    private readonly store: AltDoorwayStore,
    private readonly config: AltDoorwayConfig,
    options: Readonly<{
      sink?: TrustSignalSink;
      logger?: Pick<AppLogger, "warn">;
      now?: () => Date;
      // True while developer login is enabled: dev profiles skip doorway checks.
      devProfilesExempt?: () => boolean;
      sharedNetworkBlock?: SharedNetworkBlockCheck;
    }> = {}
  ) {
    this.sink = options.sink ?? noopTrustSignalSink;
    this.logger = options.logger;
    this.now = options.now ?? (() => new Date());
    this.devProfilesExempt = options.devProfilesExempt ?? (() => false);
    this.sharedNetworkBlock = options.sharedNetworkBlock ?? (async () => false);
  }

  // Inviter/leader side: party relocation shortcut, Settled, presence.
  async checkHost(input: Readonly<{
    kind: DoorwayKind;
    hostPlayerId: string;
    hostPosition: LatLon | null;
    destination: DoorwayDestination;
    // The host's own client platform when known (invite sender).
    hostClientPlatform?: "web" | "ios" | "android" | undefined;
  }>): Promise<DoorwayDecision> {
    const doorwayMode = this.config.TRUST_DOORWAY_MODE;
    const party = partyKind(input.kind);
    if (!party && doorwayMode === "off") return ALLOWED;
    const host = await this.loadPlayer(input.hostPlayerId);
    if (!host) return ALLOWED;
    const now = this.now();
    const nowMs = now.getTime();

    // Always on: Party Travel must not bypass the invite cooldown after relocating.
    if (party && host.lastRelocatedAt) {
      const availableAtMs = host.lastRelocatedAt.getTime() + TRAVEL_INVITE_AFTER_RELOCATION_COOLDOWN_MS;
      if (availableAtMs > nowMs) {
        const retryAfterMs = availableAtMs - nowMs;
        return {
          allowed: false,
          code: "PARTY_TRAVEL_RELOCATION_COOLDOWN",
          message: `Your party leader just relocated. Party Travel opens in ${minutesText(retryAfterMs)}.`,
          retryAfterMs
        };
      }
    }
    if (doorwayMode === "off" || !host.accountId) return ALLOWED;
    if (host.devProfile && this.devProfilesExempt()) return ALLOWED;
    const day = now.toISOString().slice(0, 10);
    const webInvite = !party && input.hostClientPlatform === "web";

    // Settled replaces the old confirmed-days rule (plan 2.6).
    const settledMode = weakerMode(doorwayMode, this.config.TRUST_SETTLED_GATE_MODE);
    if (settledMode !== "off" && !host.settled && !isTrustReviewAccount(this.config, host.accountId)) {
      this.signal(host.accountId, "doorway_unconfirmed", `doorway_unconfirmed:${host.accountId}:${day}`, {
        kind: input.kind,
        settled: false,
        accountAgeDays: host.accountCreatedAt ? Math.floor((nowMs - host.accountCreatedAt.getTime()) / DAY_MS) : null,
        mode: settledMode
      });
      if (settledMode === "enforce") {
        return {
          allowed: false,
          code: "TRAVEL_DOORWAY_UNCONFIRMED",
          message: party
            ? DOORWAY_UNSETTLED_PARTY_MESSAGE
            : webInvite ? DOORWAY_WEB_INVITE_MESSAGE : DOORWAY_UNSETTLED_INVITE_MESSAGE
        };
      }
    }

    // Presence (plan 2.7): a fresh native fix near the avatar.
    const maxFixAgeMs = this.config.TRUST_PRESENCE_MAX_FIX_AGE_SECONDS * 1000;
    const radiusM = this.config.TRUST_PRESENCE_RADIUS_KM * 1000;
    const fix = host.lastFix;
    const fixAgeMs = fix ? nowMs - fix.at.getTime() : null;
    const fixDistanceM = fix && input.hostPosition ? distanceMeters(fix, input.hostPosition) : null;
    const nativeFix = assuranceCountsAsNative(host.lastFixAssurance, this.config.TRUST_SETTLE_ASSURANCE_MODE);
    const present = fixAgeMs !== null
      && fixAgeMs <= maxFixAgeMs
      && fixDistanceM !== null
      && fixDistanceM <= radiusM
      && nativeFix;
    if (!present && !(await this.destinationAnchoredForHost(input.hostPlayerId, host, input.destination))) {
      this.signal(
        host.accountId,
        "doorway_no_presence",
        `doorway_no_presence:${host.accountId}:${now.toISOString().slice(0, 13)}`,
        {
          kind: input.kind,
          fixAgeSeconds: fixAgeMs === null ? null : Math.round(fixAgeMs / 1000),
          fixDistanceKm: fixDistanceM === null ? null : Math.round(fixDistanceM / 100) / 10,
          fixAssurance: host.lastFixAssurance,
          destination: input.destination.kind,
          mode: doorwayMode
        }
      );
      if (doorwayMode === "enforce") {
        return {
          allowed: false,
          code: "TRAVEL_DOORWAY_NO_PRESENCE",
          message: party
            ? "Your party leader's location could not be confirmed where they are playing. They need to keep Ash Atlas open with location on, then you can try again."
            : webInvite
              ? DOORWAY_WEB_INVITE_MESSAGE
              : "Your location could not be confirmed where you are playing. Keep Ash Atlas open with location on for a few minutes, then try again."
        };
      }
    }
    return ALLOWED;
  }

  // Inviter/leader versus invitee/member: shared device blocks (enforce);
  // a shared network prefix only logs a signal (families, roommates) unless the
  // inviter is young and sharedNetworkBlock confirms a non-mobile network.
  async checkLinked(input: Readonly<{
    kind: DoorwayKind;
    hostPlayerId: string;
    guestPlayerId: string;
  }>): Promise<DoorwayDecision> {
    const mode = this.config.TRUST_LINKED_ALT_MODE;
    if (mode === "off") return ALLOWED;
    const [host, guest] = await Promise.all([
      this.loadPlayer(input.hostPlayerId),
      this.loadPlayer(input.guestPlayerId)
    ]);
    if (!host?.accountId || !guest?.accountId || host.accountId === guest.accountId) return ALLOWED;
    if ((host.devProfile || guest.devProfile) && this.devProfilesExempt()) return ALLOWED;
    const now = this.now();
    const day = now.toISOString().slice(0, 10);
    const linked = await this.store.linkedAccounts(
      host.accountId,
      guest.accountId,
      new Date(now.getTime() - LINKED_NETWORK_WINDOW_MS)
    );
    const pair = [host.accountId, guest.accountId];
    if (linked.network) {
      for (const [self, other] of [pair, [...pair].reverse()] as const) {
        this.signal(self!, "linked_network", `linked_network:${self}:${other}:${day}`, {
          kind: input.kind,
          otherAccountId: other,
          mode
        });
      }
      if (
        mode === "enforce"
        && this.youngAccount(host, now)
        && await this.sharedNetworkBlock({ hostAccountId: host.accountId, guestAccountId: guest.accountId })
      ) {
        return {
          allowed: false,
          code: "TRAVEL_LINKED_ACCOUNT",
          message: partyKind(input.kind)
            ? "Party Travel is not available between these accounts right now."
            : "Travel Invites are not available between these accounts right now."
        };
      }
    }
    if (linked.device) {
      for (const [self, other] of [pair, [...pair].reverse()] as const) {
        this.signal(self!, "linked_device", `linked_device:${self}:${other}:${day}`, {
          kind: input.kind,
          otherAccountId: other,
          mode
        });
      }
      if (mode === "enforce") {
        return {
          allowed: false,
          code: "TRAVEL_LINKED_ACCOUNT",
          message: partyKind(input.kind)
            ? "Party Travel is not available between accounts that share a device."
            : "Travel Invites are not available between accounts that share a device."
        };
      }
    }
    return ALLOWED;
  }

  async check(input: Readonly<{
    kind: DoorwayKind;
    hostPlayerId: string;
    guestPlayerId: string;
    hostPosition: LatLon | null;
    destination: DoorwayDestination;
    hostClientPlatform?: "web" | "ios" | "android" | undefined;
  }>): Promise<DoorwayDecision> {
    const host = await this.checkHost(input);
    if (!host.allowed) return host;
    return this.checkLinked(input);
  }

  // Called after an accepted invite or party travel commits for the arriving
  // player. Arrivals brought by a young inviter/leader wait longer (plan 3.1).
  noteArrival(playerId: string, hostPlayerId?: string): void {
    if (this.config.TRUST_ARRIVAL_RAID_MODE === "off") return;
    const now = this.now();
    const nowMs = now.getTime();
    const untilMs = nowMs + this.config.TRUST_ARRIVAL_RAID_HOLD_MINUTES * 60_000;
    this.cacheArrivalHold(playerId, untilMs, nowMs);
    void (async () => {
      let holdUntilMs = untilMs;
      if (hostPlayerId && hostPlayerId !== playerId) {
        const host = await this.loadPlayer(hostPlayerId);
        if (host && this.youngAccount(host, now) && !(host.devProfile && this.devProfilesExempt())) {
          holdUntilMs = Math.max(
            untilMs,
            nowMs + this.config.TRUST_YOUNG_INVITER_ARRIVAL_HOLD_MINUTES * 60_000
          );
          this.cacheArrivalHold(playerId, holdUntilMs, nowMs);
        }
      }
      await this.store.setArrivalHold(playerId, new Date(holdUntilMs));
    })().catch((error: unknown) => {
      this.logger?.warn({ err: error, playerId }, "Arrival raid hold could not be saved");
    });
  }

  private cacheArrivalHold(playerId: string, untilMs: number, nowMs: number): void {
    const cached = this.arrivalHolds.get(playerId);
    if (!cached && this.arrivalHolds.size >= MAX_CACHED_PLAYERS) this.arrivalHolds.clear();
    this.arrivalHolds.set(playerId, {
      untilMs: Math.max(untilMs, cached?.untilMs ?? 0),
      loadedAtMs: nowMs
    });
  }

  private youngAccount(player: DoorwayPlayerRecord, now: Date): boolean {
    if (!player.accountCreatedAt) return false;
    return now.getTime() - player.accountCreatedAt.getTime() < this.config.TRUST_YOUNG_INVITER_DAYS * DAY_MS;
  }

  // Flag burn/attack right after arriving by invite or party travel. PvP is never checked.
  async checkRaid(input: Readonly<{
    accountId: string | null;
    playerId: string;
    action: "flag_burn" | "flag_attack";
    flagId: string;
  }>): Promise<DoorwayDecision> {
    const mode = this.config.TRUST_ARRIVAL_RAID_MODE;
    if (mode === "off") return ALLOWED;
    try {
      const hold = await this.currentArrivalHold(input.playerId);
      const nowMs = this.now().getTime();
      if (hold.untilMs === null || hold.untilMs <= nowMs) return ALLOWED;
      if (UUID_PATTERN.test(input.flagId) && await this.store.playerOwnsFlag(input.playerId, input.flagId)) {
        return ALLOWED;
      }
      if (input.accountId && this.devProfilesExempt() && await this.store.isDevProfile(input.accountId)) {
        return ALLOWED;
      }
      const retryAfterMs = hold.untilMs - nowMs;
      if (input.accountId) {
        this.signal(input.accountId, "arrival_raid_blocked", `arrival_raid_blocked:${input.accountId}:${hold.untilMs}`, {
          action: input.action,
          flagId: input.flagId,
          holdUntil: new Date(hold.untilMs).toISOString(),
          remainingMs: retryAfterMs,
          mode
        });
      }
      if (mode !== "enforce") return ALLOWED;
      return {
        allowed: false,
        code: "ARRIVAL_RAID_HOLD",
        message: `You just arrived — you can raid flags in ${minutesText(retryAfterMs)}.`,
        retryAfterMs
      };
    } catch (error) {
      // Fail open: the database is unavailable, not the player.
      this.logger?.warn({ err: error, playerId: input.playerId }, "Arrival raid hold could not be checked");
      return ALLOWED;
    }
  }

  private async loadPlayer(playerId: string): Promise<DoorwayPlayerRecord | null> {
    return this.store.loadDoorwayPlayer(playerId);
  }

  // Presence exemption (plan 2.7): only the Settled host's own destination,
  // anchored within TRUST_HOME_DESTINATION_RADIUS_KM of their Settled home.
  // A manor is an interior with no map position and guests leave it where they
  // entered, so the host's own manor needs only Settled.
  private async destinationAnchoredForHost(
    hostPlayerId: string,
    host: DoorwayPlayerRecord,
    destination: DoorwayDestination
  ): Promise<boolean> {
    if (!host.settled || destination.kind === "world") return false;
    if (destination.kind === "manor") return destination.ownerPlayerId === hostPlayerId;
    if (!host.settledHome || !UUID_PATTERN.test(destination.id)) return false;
    const position = await this.store.ownedDestinationPosition(hostPlayerId, destination);
    return position !== null
      && distanceMeters(position, host.settledHome) <= this.config.TRUST_HOME_DESTINATION_RADIUS_KM * 1000;
  }

  private signal(
    accountId: string,
    rule: DoorwaySignalRule,
    dedupeKey: string,
    metadata: Record<string, unknown>
  ): void {
    void this.sink.recordSignals({
      accountId,
      signals: [{ rule, weight: DOORWAY_SIGNAL_WEIGHTS[rule], metadata: { ...metadata, dedupeKey } }]
    }).catch((error: unknown) => {
      this.logger?.warn({ err: error, accountId, rule }, "Alt doorway trust signal could not be recorded");
    });
  }

  private async currentArrivalHold(playerId: string): Promise<CachedArrivalHold> {
    const cached = this.arrivalHolds.get(playerId);
    if (cached && this.now().getTime() - cached.loadedAtMs < HOLD_CACHE_TTL_MS) return cached;
    let pending = this.hydrations.get(playerId);
    if (!pending) {
      pending = this.hydrateArrivalHold(playerId).finally(() => this.hydrations.delete(playerId));
      this.hydrations.set(playerId, pending);
    }
    return pending;
  }

  private async hydrateArrivalHold(playerId: string): Promise<CachedArrivalHold> {
    const loaded = (await this.store.loadArrivalHold(playerId))?.getTime() ?? null;
    // Holds only grow, so a hold noted while loading wins over an older read.
    const existing = this.arrivalHolds.get(playerId);
    const untilMs = existing?.untilMs != null && (loaded === null || existing.untilMs >= loaded)
      ? existing.untilMs
      : loaded;
    if (!existing && this.arrivalHolds.size >= MAX_CACHED_PLAYERS) this.arrivalHolds.clear();
    const next = { untilMs, loadedAtMs: this.now().getTime() };
    this.arrivalHolds.set(playerId, next);
    return next;
  }
}
