import type { FlagAccessSnapshot, FlagSnapshot } from "@ash-atlas/shared";

import { flagVisitLockLabel } from "../combat/aggressive.js";

export type FlagVisitAction = Readonly<{
  kind: "visit" | "request_access";
  label: string;
  enabled: boolean;
  disabledReason?: string;
  busy: boolean;
  expectedTollGold?: string;
}>;

type Options = Readonly<{
  flag: Pick<FlagSnapshot, "controlType" | "developerTestTarget">;
  access?: FlagAccessSnapshot | null;
  connected: boolean;
  travelPending: boolean;
  aggressiveRemainingMs: number;
  busy?: boolean;
  walletGold?: string | null;
}>;

export function resolveFlagVisitAction(options: Options): FlagVisitAction {
  const busy = options.busy === true;
  const personalAccess = options.flag.controlType === "personal"
    ? options.access ?? null
    : null;
  const requestable = Boolean(
    personalAccess &&
    !personalAccess.decision.allowed &&
    personalAccess.decision.requestable
  );
  const expectedTollGold = personalAccess?.decision.tollGold;
  const shortfall = personalAccess &&
    expectedTollGold !== undefined &&
    expectedTollGold !== "0" &&
    options.walletGold !== null &&
    options.walletGold !== undefined &&
    BigInt(expectedTollGold) > BigInt(options.walletGold)
    ? BigInt(expectedTollGold) - BigInt(options.walletGold)
    : 0n;
  const disabledReason = flagVisitDisabledReason({
    access: personalAccess,
    developerTestTarget: options.flag.developerTestTarget === true,
    busy,
    travelPending: options.travelPending,
    connected: options.connected,
    aggressiveRemainingMs: options.aggressiveRemainingMs,
    shortfall
  });
  const enabled = disabledReason === null;

  return {
    kind: requestable ? "request_access" : "visit",
    label: options.travelPending
      ? "Traveling..."
      : flagVisitActionLabel(personalAccess, busy, options.aggressiveRemainingMs),
    enabled,
    ...(disabledReason ? { disabledReason } : {}),
    busy: busy || options.travelPending,
    ...(expectedTollGold === undefined ? {} : { expectedTollGold })
  };
}

export function flagVisitActionLabel(
  access: FlagAccessSnapshot | null,
  busy: boolean,
  aggressiveRemainingMs: number
): string {
  if (aggressiveRemainingMs > 0) return flagVisitLockLabel(aggressiveRemainingMs);
  if (busy) return "Requesting Access";
  if (!access) return "Travel";
  if (!access.decision.allowed) {
    if (access.requestPending) return "Request Pending";
    if (access.decision.requestable) return "Request Access";
    if (access.mode === "normal") return "Passage Required";
    if (access.mode === "private") return "Private Flag";
    return "Travel";
  }
  return BigInt(access.decision.tollGold) > 0n
    ? `Travel · ${access.decision.tollGold} Gold`
    : "Travel";
}

function flagVisitDisabledReason(options: Readonly<{
  access: FlagAccessSnapshot | null;
  developerTestTarget: boolean;
  busy: boolean;
  travelPending: boolean;
  connected: boolean;
  aggressiveRemainingMs: number;
  shortfall: bigint;
}>): string | null {
  if (options.developerTestTarget) return "Test fortifications are hostile targets and cannot be visited.";
  if (!options.connected) return "Cannot travel while disconnected.";
  if (options.travelPending) return "Travel is already in progress.";
  if (options.aggressiveRemainingMs > 0) return "Flag travel is locked while Aggressive.";
  if (options.busy) return "Sending the access request.";
  if (options.shortfall > 0n) return `You need ${options.shortfall.toString()} more gold.`;
  if (options.access && !options.access.decision.allowed && !options.access.decision.requestable) {
    return options.access.requestPending
      ? "Your access request is pending."
      : "You do not have access to this flag.";
  }
  return null;
}
