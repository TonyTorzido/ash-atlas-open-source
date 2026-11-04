import type { LocationFixAssurance, NativeLocationSignals } from "@ash-atlas/shared";

// Device attestation verdicts and per-fix assurance
// (docs/architecture/NATIVE_ANTISPOOF_BUILD_PLAN.md §8.1, §8.5, §8.6).

export type AttestMethod = "play_integrity" | "app_attest" | "devicecheck" | "none";
export type AttestOutcome = "pass" | "fail" | "unavailable";
export type TrustFamilyMode = "off" | "shadow" | "enforce";

export type AttestSignalRule =
  | "attest_pass"
  | "attest_device_fail"
  | "attest_app_fail"
  | "attest_tamper"
  | "attest_risky_env";

/** Signal weights (§8.6). Per-day rules dedupe per account and UTC day. */
export const ATTEST_SIGNAL_WEIGHTS: Readonly<Record<AttestSignalRule, number>> = {
  attest_pass: -0.5,
  attest_device_fail: 2,
  attest_app_fail: 3,
  attest_tamper: 4,
  attest_risky_env: 1
};
const PER_DAY_RULES: ReadonlySet<AttestSignalRule> = new Set([
  "attest_pass",
  "attest_device_fail",
  "attest_app_fail",
  "attest_risky_env"
]);

export const LOCATION_MOCK_WEIGHT = 3;
export const RELOCATION_MOCK_WEIGHT = 4;

export type AttestVerdict = Readonly<{
  outcome: AttestOutcome;
  // Fix assurance this verdict grants while it is valid.
  assurance: LocationFixAssurance;
  reason: string | null;
  signals: readonly AttestSignalRule[];
  // Summarized verdict only (never raw tokens), stored in device_attestations.verdict.
  summary: Record<string, unknown>;
}>;

export function attestPass(
  assurance: "attested" | "device_checked",
  summary: Record<string, unknown> = {},
  extraSignals: readonly AttestSignalRule[] = []
): AttestVerdict {
  return { outcome: "pass", assurance, reason: null, signals: ["attest_pass", ...extraSignals], summary };
}

/** Device integrity not met (emulator, basic-only, rooted): not proven, not tamper. */
export function attestDeviceFail(reason: string, summary: Record<string, unknown> = {}): AttestVerdict {
  return { outcome: "fail", assurance: "unverified", reason, signals: ["attest_device_fail"], summary };
}

/** The app is not our genuine build: revocation for cause in enforce. */
export function attestAppFail(reason: string, summary: Record<string, unknown> = {}): AttestVerdict {
  return { outcome: "fail", assurance: "flagged", reason, signals: ["attest_app_fail"], summary };
}

/** Replay, binding mismatch or counter regression: revocation for cause in enforce. */
export function attestTamper(reason: string, summary: Record<string, unknown> = {}): AttestVerdict {
  return { outcome: "fail", assurance: "flagged", reason, signals: ["attest_tamper"], summary };
}

/** Outage, quota, UNEVALUATED or client error: neutral. */
export function attestUnavailable(reason: string, summary: Record<string, unknown> = {}): AttestVerdict {
  return { outcome: "unavailable", assurance: "unverified", reason, signals: [], summary };
}

/** Hard causes revoke Settled when their family mode is enforce. */
export function attestRevocationReason(
  signals: readonly AttestSignalRule[]
): "attest_tamper" | "attest_app_fail" | null {
  if (signals.includes("attest_tamper")) return "attest_tamper";
  if (signals.includes("attest_app_fail")) return "attest_app_fail";
  return null;
}

export function attestSignal(
  rule: AttestSignalRule,
  accountId: string,
  at: Date,
  eventId: string,
  metadata: Record<string, unknown> = {}
): { rule: string; weight: number; metadata: Record<string, unknown> } {
  const dedupeKey = PER_DAY_RULES.has(rule)
    ? `${rule}:${accountId}:${at.toISOString().slice(0, 10)}`
    : `${rule}:${eventId}`;
  return { rule, weight: ATTEST_SIGNAL_WEIGHTS[rule], metadata: { ...metadata, dedupeKey } };
}

/** The attestation a fix carried, after scoping and the bound-fix check. */
export type FixAttestation = Readonly<{
  id: string;
  method: AttestMethod;
  outcome: AttestOutcome;
  assurance: LocationFixAssurance;
  // Relocation bound-fix mismatch (the fix is not the attested one).
  tamper: boolean;
}>;

export type FixAssuranceInput = Readonly<{
  clientPlatform: "web" | "ios" | "android" | null | undefined;
  // Parsed native block; null when absent or malformed (legacy treatment).
  native: NativeLocationSignals | null;
  attestation: FixAttestation | null;
  mockMode: TrustFamilyMode;
  attestationMode: TrustFamilyMode;
}>;

export type FixAssurance = Readonly<{
  assurance: LocationFixAssurance | null;
  // Mock or simulated location reported by the native shell (mock mode not off).
  mock: boolean;
}>;

/** Whether the native block reports a mock provider or software-simulated fix. */
export function nativeReportsMock(native: NativeLocationSignals | null): boolean {
  return native?.mock === true || native?.simulated === true;
}

/**
 * Per-fix assurance (§8.1): web; mock/tamper ⇒ flagged; a valid attestation's
 * assurance; plugin without attestation ⇒ unverified; else native_legacy.
 */
export function fixAssurance(input: FixAssuranceInput): FixAssurance {
  const platform = input.clientPlatform;
  if (platform === "web") return { assurance: "web", mock: false };
  if (platform !== "ios" && platform !== "android") return { assurance: null, mock: false };
  const mock = input.mockMode !== "off" && nativeReportsMock(input.native);
  if (mock) return { assurance: "flagged", mock };
  const attestation = input.attestationMode === "off" ? null : input.attestation;
  if (attestation) {
    return { assurance: attestation.tamper ? "flagged" : attestation.assurance, mock };
  }
  if (input.native?.plugin === true) return { assurance: "unverified", mock };
  return { assurance: "native_legacy", mock };
}
