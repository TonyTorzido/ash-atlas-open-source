import {
  TRUST_LAB_ATTESTATIONS,
  TRUST_LAB_NETWORKS,
  TRUST_LAB_SETTLED_STATES,
  type TrustLabDoorway,
  type TrustLabDryRunResponse,
  type TrustLabProfileInput,
  type TrustLabRun
} from "@ash-atlas/shared";
import { useState } from "react";

import type { TrustAdminClient } from "../auth/trustAdminClient.js";

// Developer Trust Lab: fake a location + device profile and dry-run a relocation
// through the live trust code. The server stores nothing (no travel, signals,
// alerts, locks or cooldown).

type LatLon = Readonly<{ lat: number; lon: number }>;

type Draft = {
  lat: string;
  lon: string;
  accuracyM: string;
  platform: "web" | "ios" | "android";
  plugin: boolean;
  attestation: (typeof TRUST_LAB_ATTESTATIONS)[number];
  mock: boolean;
  emulator: boolean;
  root: boolean;
  vpnActive: boolean;
  gnssSatellitesUsed: string;
  simCountry: string;
  networkCountry: string;
  deviceTimeZone: string;
  network: (typeof TRUST_LAB_NETWORKS)[number];
  ipLat: string;
  ipLon: string;
  accountAgeDays: string;
  settled: (typeof TRUST_LAB_SETTLED_STATES)[number];
  homeLat: string;
  homeLon: string;
  lastFixMinutesAgo: string;
  lastRelocatedHoursAgo: string;
  priorRelocations: string;
  installAccounts: string;
  pendingRedAlert: boolean;
  hardMismatchFixes24h: string;
};

const BASE: Draft = {
  lat: "39.7392",
  lon: "-104.9903",
  accuracyM: "15",
  platform: "android",
  plugin: true,
  attestation: "pass",
  mock: false,
  emulator: false,
  root: false,
  vpnActive: false,
  gnssSatellitesUsed: "",
  simCountry: "US",
  networkCountry: "US",
  deviceTimeZone: "America/Denver",
  network: "mobile",
  ipLat: "",
  ipLon: "",
  accountAgeDays: "30",
  settled: "unsettled",
  homeLat: "39.7392",
  homeLon: "-104.9903",
  lastFixMinutesAgo: "120",
  lastRelocatedHoursAgo: "",
  priorRelocations: "1",
  installAccounts: "1",
  pendingRedAlert: false,
  hardMismatchFixes24h: "0"
};

const PRESETS: ReadonlyArray<Readonly<{ label: string; draft: Partial<Draft> }>> = [
  { label: "Honest veteran", draft: { settled: "settled", accountAgeDays: "200", lastRelocatedHoursAgo: "500" } },
  { label: "New honest player", draft: { accountAgeDays: "0.2", priorRelocations: "0", homeLat: "", homeLon: "", lastFixMinutesAgo: "" } },
  { label: "Web player", draft: { platform: "web", plugin: false, attestation: "none", network: "fixed" } },
  {
    label: "Emulator spoofer",
    draft: {
      lat: "40.2", lon: "-117.6", accountAgeDays: "0.5", mock: true, emulator: true, attestation: "basic_only",
      gnssSatellitesUsed: "0", lastFixMinutesAgo: "20", network: "vpn"
    }
  },
  {
    label: "Veteran into red zone",
    draft: { lat: "40.2", lon: "-117.6", settled: "settled", accountAgeDays: "200", lastFixMinutesAgo: "6000", lastRelocatedHoursAgo: "500" }
  },
  {
    label: "Spoofing veteran",
    draft: {
      lat: "48.8566", lon: "2.3522", settled: "provisional", accountAgeDays: "400", lastFixMinutesAgo: "600",
      lastRelocatedHoursAgo: "300", hardMismatchFixes24h: "2"
    }
  }
];

const DOORWAY_HINT = "Doorways are checked an hour after the relocation (or as entered when it is refused).";

function numberOrNull(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function toProfile(draft: Draft): TrustLabProfileInput | string {
  const lat = numberOrNull(draft.lat);
  const lon = numberOrNull(draft.lon);
  if (lat === null || lon === null) return "Enter a latitude and longitude.";
  const pair = (a: string, b: string, label: string): [number | null, number | null] | string => {
    const first = numberOrNull(a);
    const second = numberOrNull(b);
    if ((first === null) !== (second === null)) return `${label} needs both latitude and longitude.`;
    return [first, second];
  };
  const home = pair(draft.homeLat, draft.homeLon, "Home");
  if (typeof home === "string") return home;
  const ip = pair(draft.ipLat, draft.ipLon, "IP location");
  if (typeof ip === "string") return ip;
  return {
    lat,
    lon,
    accuracyM: numberOrNull(draft.accuracyM) ?? 15,
    platform: draft.platform,
    plugin: draft.plugin,
    attestation: draft.attestation,
    mock: draft.mock,
    emulator: draft.emulator,
    root: draft.root,
    vpnActive: draft.vpnActive,
    gnssSatellitesUsed: numberOrNull(draft.gnssSatellitesUsed),
    simCountry: draft.simCountry.trim() || null,
    networkCountry: draft.networkCountry.trim() || null,
    deviceTimeZone: draft.deviceTimeZone.trim() || null,
    network: draft.network,
    ipLat: ip[0],
    ipLon: ip[1],
    accountAgeDays: numberOrNull(draft.accountAgeDays) ?? 0,
    settled: draft.settled,
    homeLat: home[0],
    homeLon: home[1],
    lastFixMinutesAgo: numberOrNull(draft.lastFixMinutesAgo),
    lastRelocatedHoursAgo: numberOrNull(draft.lastRelocatedHoursAgo),
    priorRelocations: numberOrNull(draft.priorRelocations) ?? 0,
    installAccounts: numberOrNull(draft.installAccounts) ?? 1,
    pendingRedAlert: draft.pendingRedAlert,
    hardMismatchFixes24h: numberOrNull(draft.hardMismatchFixes24h) ?? 0
  };
}

export function TrustLabPanel({
  api,
  getMapCenter
}: {
  api: TrustAdminClient;
  getMapCenter?: (() => LatLon | null) | undefined;
}): React.JSX.Element {
  const [draft, setDraft] = useState<Draft>(BASE);
  const [result, setResult] = useState<TrustLabDryRunResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof Draft>(key: K, value: Draft[K]): void => setDraft((current) => ({ ...current, [key]: value }));

  const run = async (): Promise<void> => {
    const profile = toProfile(draft);
    if (typeof profile === "string") {
      setError(profile);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      setResult(await api.labDryRun(profile));
    } catch (runError) {
      setError(runError instanceof Error ? runError.message : "Dry run failed");
    } finally {
      setBusy(false);
    }
  };

  const useMapCenter = (): void => {
    const center = getMapCenter?.();
    if (!center) {
      setError("The map center is not available here.");
      return;
    }
    setDraft((current) => ({ ...current, lat: center.lat.toFixed(5), lon: center.lon.toFixed(5) }));
  };

  const text = (key: keyof Draft, label: string, inputMode: "decimal" | "text" = "decimal") => (
    <label className="trust-lab-field">
      <span>{label}</span>
      <input
        type="text"
        inputMode={inputMode}
        value={String(draft[key])}
        onChange={(event) => set(key, event.currentTarget.value as never)}
      />
    </label>
  );
  const toggle = (key: keyof Draft, label: string) => (
    <label className="trust-lab-check">
      <input type="checkbox" checked={Boolean(draft[key])} onChange={(event) => set(key, event.currentTarget.checked as never)} />
      <span>{label}</span>
    </label>
  );
  const choice = <K extends keyof Draft>(key: K, label: string, options: readonly string[]) => (
    <label className="trust-lab-field">
      <span>{label}</span>
      <select className="trust-admin-select" value={String(draft[key])} onChange={(event) => set(key, event.currentTarget.value as Draft[K])}>
        {options.map((option) => <option key={option} value={option}>{option.replaceAll("_", " ")}</option>)}
      </select>
    </label>
  );

  return (
    <div className="trust-lab">
      <p className="auth-detail">
        Fake a location and device, then dry-run a relocation through the live trust code. Nothing is saved: no travel,
        signals, alerts, locks or cooldown.
      </p>
      <nav className="test-access-tabs" aria-label="Trust Lab presets">
        {PRESETS.map((preset) => (
          <button key={preset.label} type="button" onClick={() => setDraft({ ...BASE, ...preset.draft })}>
            {preset.label}
          </button>
        ))}
      </nav>
      <form
        className="trust-lab-form"
        onSubmit={(event) => {
          event.preventDefault();
          void run();
        }}
      >
        <fieldset>
          <legend>Location</legend>
          {text("lat", "Latitude")}
          {text("lon", "Longitude")}
          {text("accuracyM", "Accuracy (m)")}
          <div className="test-access-row-actions">
            <button type="button" onClick={useMapCenter} disabled={!getMapCenter}>Use map center</button>
            <button type="button" onClick={() => setDraft((current) => ({ ...current, homeLat: current.lat, homeLon: current.lon }))}>
              Set home here
            </button>
          </div>
        </fieldset>
        <fieldset>
          <legend>Device</legend>
          {choice("platform", "Platform", ["android", "ios", "web"])}
          {choice("attestation", "Attestation", TRUST_LAB_ATTESTATIONS)}
          {toggle("plugin", "Native trust plugin")}
          {toggle("mock", "Mock / simulated location")}
          {toggle("emulator", "Emulator hints")}
          {toggle("root", "Root / jailbreak hints")}
          {toggle("vpnActive", "VPN active")}
          {text("gnssSatellitesUsed", "GNSS satellites used")}
        </fieldset>
        <fieldset>
          <legend>Network</legend>
          {text("simCountry", "SIM country", "text")}
          {text("networkCountry", "Carrier country", "text")}
          {text("deviceTimeZone", "Device time zone", "text")}
          {choice("network", "IP network", TRUST_LAB_NETWORKS)}
          {text("ipLat", "IP latitude (blank = GPS)")}
          {text("ipLon", "IP longitude (blank = GPS)")}
        </fieldset>
        <fieldset>
          <legend>Account</legend>
          {text("accountAgeDays", "Account age (days)")}
          {choice("settled", "Settled", TRUST_LAB_SETTLED_STATES)}
          {text("homeLat", "Home latitude")}
          {text("homeLon", "Home longitude")}
          {text("lastFixMinutesAgo", "Last fix at home (min ago)")}
          {text("lastRelocatedHoursAgo", "Last relocated (h ago)")}
          {text("priorRelocations", "Relocations so far")}
          {text("installAccounts", "Accounts on this install")}
          {text("hardMismatchFixes24h", "Hard mismatches (24 h)")}
          {toggle("pendingRedAlert", "Red alert already pending")}
        </fieldset>
        <div className="trust-lab-submit">
          <button type="submit" className="auth-primary" disabled={busy}>{busy ? "Running…" : "Dry-run relocate"}</button>
        </div>
      </form>
      {error ? <div className="auth-error" role="alert">{error}</div> : null}
      {result ? <TrustLabResult result={result} /> : null}
    </div>
  );
}

function TrustLabResult({ result }: { result: TrustLabDryRunResponse }): React.JSX.Element {
  return (
    <div className="trust-lab-results" aria-live="polite">
      <p className="auth-detail">
        Zone: <strong>{result.zone}</strong>
        {result.zoneGridLoaded ? "" : " (population grid not loaded: everything classifies urban)"}
        {" "}· territory owners within the yellow radius: {result.yellowOwners}
        {" "}· kingdoms within the proximity radius: {result.kingdomOwners}
      </p>
      {result.runs.map((run) => <TrustLabRunView key={run.config} run={run} />)}
    </div>
  );
}

function TrustLabRunView({ run }: { run: TrustLabRun }): React.JSX.Element {
  const relocation = run.relocation;
  const weight = relocation.signals.reduce((total, signal) => total + signal.weight, 0);
  return (
    <section className={`trust-lab-run trust-lab-run--${relocation.outcome}`}>
      <h3 className="trust-admin-heading">{run.config === "current" ? "Current config" : "Everything enforced"}</h3>
      <div className="test-access-row">
        <div className="test-access-row-main">
          <small>A real player would see:</small>
          <strong className="trust-lab-message">“{relocation.playerMessage}”</strong>
          <span>
            {relocation.outcome === "relocated" ? "Relocation goes through" : relocation.outcome === "locked"
              ? "Refused and the account is locked"
              : "Refused"}
            {" "}· {relocation.settledBefore} → {relocation.settledAfter}
            {relocation.settlementEvent ? ` (${relocation.settlementEvent.replaceAll("_", " ")})` : ""}
          </span>
          <small>
            Cooldown {relocation.cooldown.consumed ? "starts (7 days)" : "not used"}
            {relocation.cooldown.exemption ? ` · exemption: ${relocation.cooldown.exemption.replaceAll("_", " ")}` : ""}
            {relocation.holdMinutes !== null ? ` · land-action hold ${relocation.holdMinutes} min` : ""}
            {` · difficulty ${relocation.difficulty.toFixed(2)}`}
          </small>
          {relocation.alerts.length > 0 ? (
            <small>
              Alerts: {relocation.alerts.map((alert) =>
                `${alert.kind.replace("zone_", "")} (${alert.status}${alert.severity !== null ? `, severity ${alert.severity}` : ""})`).join(", ")}
            </small>
          ) : <small>No alerts</small>}
          {relocation.revocations.length > 0 ? (
            <small className="trust-lab-bad">Settled revoked for cause: {relocation.revocations.join(", ")}</small>
          ) : null}
        </div>
      </div>

      <h4 className="trust-lab-subheading">Doorways</h4>
      <p className="auth-detail">{DOORWAY_HINT}</p>
      <div className="test-access-list">
        {run.doorways.map((doorway) => <DoorwayRow key={doorway.action} doorway={doorway} />)}
      </div>

      <details className="trust-lab-details">
        <summary>Technical breakdown</summary>
        <h4 className="trust-lab-subheading">Steps</h4>
        <ol className="trust-lab-steps">
          {relocation.steps.map((step, index) => (
            <li key={`${step.step}-${index}`}>
              <strong>{step.step}:</strong> {step.result}{step.detail ? ` · ${step.detail}` : ""}
            </li>
          ))}
        </ol>
        <h4 className="trust-lab-subheading">Signals (total {weight >= 0 ? "+" : ""}{weight.toFixed(2)})</h4>
        <ul className="trust-lab-steps">
          {relocation.signals.map((signal, index) => (
            <li key={`${signal.rule}-${index}`}>
              {signal.rule} · {signal.weight >= 0 ? "+" : ""}{signal.weight.toFixed(2)} · {signal.source}
            </li>
          ))}
          {relocation.signals.length === 0 ? <li>No signals.</li> : null}
        </ul>
        <p className="auth-detail">Verdict {relocation.verdict ?? "not evaluated"} · assurance {relocation.assurance ?? "none"}</p>
        <h4 className="trust-lab-subheading">Modes</h4>
        <p className="auth-detail mono">
          {Object.entries(run.modes).map(([key, value]) => `${key.replace(/^TRUST_|_MODE$/gu, "")}=${value}`).join(" · ")}
        </p>
      </details>
    </section>
  );
}

function DoorwayRow({ doorway }: { doorway: TrustLabDoorway }): React.JSX.Element {
  const state = !doorway.allowed ? "refused" : doorway.shadowOnly ? "shadow" : "allowed";
  return (
    <article className={`test-access-row trust-lab-doorway trust-lab-doorway--${state}`}>
      <div className="test-access-row-main">
        <strong>{doorway.action}</strong>
        <span>
          {state === "refused" ? `Refused · ${doorway.code ?? ""}` : state === "shadow" ? "Allowed now (shadow: enforce refuses)" : "Allowed"}
        </span>
        {doorway.message ? <small>“{doorway.message}”</small> : null}
        {doorway.signals.length > 0 ? (
          <small>{doorway.signals.map((signal) => `${signal.rule} ${signal.weight >= 0 ? "+" : ""}${signal.weight}`).join(", ")}</small>
        ) : null}
      </div>
    </article>
  );
}
