import { trustLabProfileSchema, type TrustLabProfileInput, type TrustLabRun } from "@ash-atlas/shared";
import { describe, expect, it, vi } from "vitest";

import { loadConfig } from "../../config.js";
import { DOORWAY_UNSETTLED_INVITE_MESSAGE } from "./altDoorway.js";
import { HOSTILE_UNSETTLED_CODE } from "./hostileGate.js";
import type { PopulationClass } from "./populationGrid.js";
import { RELOCATION_NATIVE_ONLY_MESSAGE, RELOCATION_RED_REFUSED_MESSAGE } from "./relocationGate.js";
import { SETTLED_REVIEW_HOLD_MESSAGE } from "./settlement.js";
import { TrustLab, enforceAllTrustModes } from "./trustLab.js";

const NOW = new Date("2026-10-04T12:00:00.000Z");
// Denver (urban) and a far point (red in the stubbed grid).
const DENVER = { lat: 39.7392, lon: -104.9903 };
const NEARBY = { lat: 39.75, lon: -104.98 };
const SAHARA = { lat: 23.4, lon: 11.2 };

function lab(zones: Record<string, PopulationClass> = {}) {
  const config = loadConfig({
    NODE_ENV: "development",
    AUTH_MODE: "google",
    GOOGLE_CLIENT_ID: "client-id",
    // Production today: phone-only relocation enforced, the rest at their defaults.
    TRUST_RELOCATION_NATIVE_ONLY_MODE: "enforce"
  });
  const yellowOwners = vi.fn(async () => [] as string[]);
  const instance = new TrustLab({
    config,
    classify: (lat, lon) => zones[`${lat},${lon}`] ?? "urban",
    zoneGridLoaded: () => true,
    yellowOwners,
    now: () => NOW
  });
  return { instance, config, yellowOwners };
}

function profile(input: Partial<TrustLabProfileInput>) {
  return trustLabProfileSchema.parse({ ...NEARBY, platform: "android", ...input });
}

function run(result: Awaited<ReturnType<TrustLab["dryRun"]>>, config: "current" | "enforce"): TrustLabRun {
  return result.runs.find((entry) => entry.config === config)!;
}

function doorway(entry: TrustLabRun, action: string) {
  return entry.doorways.find((item) => item.action === action)!;
}

describe("trust weight defaults (owner decision F)", () => {
  it("ships non-zero default weights and lets the env override single rules", () => {
    const base = { NODE_ENV: "development", AUTH_MODE: "google", GOOGLE_CLIENT_ID: "client-id" } as const;
    const defaults = loadConfig({ ...base });
    for (const rule of [
      "env_emulator", "env_root", "env_vpn_active", "gnss_zero_satellites", "env_sim_country_mismatch",
      "env_network_country_mismatch", "env_cell_country_mismatch", "env_timezone_country_mismatch",
      "install_multi_account", "pi_virtual_integrity"
    ]) {
      expect(defaults.TRUST_ENVIRONMENT_SIGNAL_WEIGHTS[rule], rule).toBeGreaterThan(0);
    }
    for (const rule of ["account_shared", "state_hopping", "kingdom_proximity"]) {
      expect(defaults.TRUST_RISK_SIGNAL_WEIGHTS[rule], rule).toBeGreaterThan(0);
    }
    expect(defaults.TRUST_INSTALL_ALT_ACCOUNT_THRESHOLD).toBe(2);
    expect(defaults.TRUST_MISMATCH_REVOKE_WEIGHT).toBe(5);
    const tuned = loadConfig({ ...base, TRUST_ENVIRONMENT_SIGNAL_WEIGHTS: "env_vpn_active=0", TRUST_RISK_SIGNAL_WEIGHTS: "state_hopping=6" });
    expect(tuned.TRUST_ENVIRONMENT_SIGNAL_WEIGHTS.env_vpn_active).toBe(0);
    expect(tuned.TRUST_ENVIRONMENT_SIGNAL_WEIGHTS.env_emulator).toBe(2);
    expect(tuned.TRUST_RISK_SIGNAL_WEIGHTS.state_hopping).toBe(6);
    expect(() => loadConfig({ ...base, TRUST_RISK_SIGNAL_WEIGHTS: "state_hopping=99" })).toThrow();
  });
});

describe("Trust Lab dry run", () => {
  it("switches every trust mode to enforce for the enforce run", () => {
    const { config } = lab();
    const enforced = enforceAllTrustModes(config);
    expect(enforced.TRUST_HOSTILE_GATE_MODE).toBe("enforce");
    expect(enforced.TRUST_SETTLE_ASSURANCE_MODE).toBe("enforce");
    expect(enforced.TRUST_KINGDOM_ALERT_RADIUS_KM).toBe(config.TRUST_KINGDOM_ALERT_RADIUS_KM);
  });

  it("lets a Settled attested veteran relocate home and open every doorway", async () => {
    const { instance } = lab();
    const result = await instance.dryRun(profile({
      settled: "settled",
      accountAgeDays: 200,
      homeLat: DENVER.lat,
      homeLon: DENVER.lon,
      lastRelocatedHoursAgo: 2,
      network: "mobile"
    }));
    for (const entry of result.runs) {
      expect(entry.relocation).toMatchObject({
        outcome: "relocated",
        playerMessage: "Relocated to your current location.",
        cooldown: { exemption: "return_home", consumed: false },
        assurance: "attested",
        settledAfter: "Settled",
        revocations: []
      });
      expect(doorway(entry, "Send a Travel Invite (open world)")).toMatchObject({ allowed: true, shadowOnly: false });
      expect(doorway(entry, "Others travel to my public flag here").allowed).toBe(true);
      expect(doorway(entry, "Invite an account on the same device")).toMatchObject({
        allowed: false,
        code: "TRAVEL_LINKED_ACCOUNT"
      });
    }
    expect(result.runs[0]!.relocation.signals.map((signal) => signal.rule)).toContain("attest_pass");
  });

  it("refuses a web relocation while phone-only relocation is enforced", async () => {
    const { instance } = lab();
    const result = await instance.dryRun(profile({ platform: "web" }));
    expect(run(result, "current").relocation).toMatchObject({
      outcome: "refused",
      playerMessage: RELOCATION_NATIVE_ONLY_MESSAGE,
      signals: []
    });
    expect(doorway(run(result, "current"), "Send a Travel Invite (open world)")).toMatchObject({
      allowed: false,
      code: "TRAVEL_DOORWAY_UNCONFIRMED"
    });
  });

  it("locks a brand-new spoofer in a red zone, also when enforce rejects the mock fix first", async () => {
    const { instance } = lab({ [`${SAHARA.lat},${SAHARA.lon}`]: "red" });
    const result = await instance.dryRun(profile({
      ...SAHARA,
      accountAgeDays: 0.5,
      mock: true,
      emulator: true,
      attestation: "basic_only",
      homeLat: DENVER.lat,
      homeLon: DENVER.lon,
      lastFixMinutesAgo: 30
    }));
    const current = run(result, "current").relocation;
    expect(current).toMatchObject({
      outcome: "locked",
      playerMessage: RELOCATION_RED_REFUSED_MESSAGE,
      verdict: "shadow_rejected",
      alerts: [{ kind: "zone_red", status: "locked", severity: 4 }]
    });
    expect(current.signals.map((signal) => signal.rule)).toEqual(expect.arrayContaining([
      "attest_device_fail",
      "env_emulator",
      "relocation_red_zone",
      "relocation_mock"
    ]));
    const enforced = run(result, "enforce").relocation;
    expect(enforced).toMatchObject({
      outcome: "locked",
      playerMessage: RELOCATION_RED_REFUSED_MESSAGE,
      verdict: "rejected",
      alerts: [{ kind: "zone_red", status: "locked", severity: 4 }]
    });
    expect(enforced.revocations).toContain("relocation_mock");
  });

  it("shows unsettled doorways as shadow-only now and refused in enforce", async () => {
    const { instance } = lab();
    const result = await instance.dryRun(profile({ accountAgeDays: 3 }));
    const current = run(result, "current");
    expect(doorway(current, "Send a Travel Invite (open world)")).toMatchObject({
      allowed: false,
      message: DOORWAY_UNSETTLED_INVITE_MESSAGE
    });
    expect(doorway(current, "Burn or attack another player's flag")).toMatchObject({ allowed: true, shadowOnly: true });
    expect(doorway(run(result, "enforce"), "Burn or attack another player's flag")).toMatchObject({
      allowed: false,
      code: HOSTILE_UNSETTLED_CODE
    });
    expect(doorway(run(result, "enforce"), "Found a city")).toMatchObject({ allowed: false, code: "PRIVATE_UNTIL_SETTLED" });
    // Owner decision 2026-10-15: others may jump to a new player's public flag.
    expect(doorway(run(result, "enforce"), "Others travel to my public flag here")).toMatchObject({ allowed: true, shadowOnly: false });
  });

  it("drops Settled when a veteran relocates far from the Settled home", async () => {
    const { instance } = lab();
    const result = await instance.dryRun(profile({
      lat: 48.8566,
      lon: 2.3522,
      settled: "provisional",
      accountAgeDays: 400,
      homeLat: DENVER.lat,
      homeLon: DENVER.lon,
      lastFixMinutesAgo: 600,
      networkCountry: "US"
    }));
    expect(run(result, "current").relocation).toMatchObject({
      outcome: "relocated",
      settledBefore: "Settled (provisional)",
      settledAfter: "Not settled (moved away)",
      settlementEvent: "moved_away",
      cooldown: { exemption: null, consumed: true }
    });
    expect(run(result, "current").relocation.signals.map((signal) => signal.rule)).toContain("carrier_country_mismatch");
  });

  it("holds a Settled veteran trying a red zone: Settled paused, doorways closed", async () => {
    const { instance } = lab({ [`${SAHARA.lat},${SAHARA.lon}`]: "red" });
    const result = await instance.dryRun(profile({
      ...SAHARA,
      settled: "settled",
      accountAgeDays: 300,
      homeLat: DENVER.lat,
      homeLon: DENVER.lon,
      lastFixMinutesAgo: 6000
    }));
    const current = run(result, "current");
    expect(current.relocation).toMatchObject({
      outcome: "refused",
      playerMessage: SETTLED_REVIEW_HOLD_MESSAGE,
      settledBefore: "Settled",
      settledAfter: "Settled paused for review",
      alerts: [{ kind: "zone_red", status: "pending", severity: 4 }]
    });
    expect(doorway(current, "Send a Travel Invite (open world)")).toMatchObject({ allowed: false, code: "TRAVEL_DOORWAY_UNCONFIRMED" });
  });
});
