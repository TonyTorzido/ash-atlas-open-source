import type {
  TrustAdminAccountDetail,
  TrustAdminAccountSummary,
  TrustAdminArrivalView,
  TrustAdminCoordinate,
  TrustAdminEnvironmentView
} from "@ash-atlas/shared";
import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";

import { TrustAdminClient } from "../auth/trustAdminClient.js";
import { AshAtlasBrandLogo } from "./AshAtlasBrandLogo.js";
import { GameConfirmationPrompt } from "./GameActionPrompt.js";
import { formatTimestamp, QuarantineArrivalsPrompt, TrustAlertsPanel } from "./TrustAlertsPanel.js";
import { TrustLabPanel } from "./TrustLabPanel.js";
import { useModalBehavior } from "./useModalBehavior.js";

const LIMIT = 50;
const DAY_MS = 24 * 60 * 60_000;

type TrustTab = "accounts" | "alerts" | "lab";

// One line of environment flags for the admin detail (plan §8.9).
function environmentFlags(env: TrustAdminEnvironmentView): string {
  const flags: string[] = [];
  if (env.emulatorHints.length > 0) flags.push(`emulator: ${env.emulatorHints.join(", ")}`);
  if (env.rootHints.length > 0) flags.push(`root/jailbreak: ${env.rootHints.join(", ")}`);
  if (env.debuggerAttached) flags.push("debugger");
  if (env.vpnActive) flags.push("VPN");
  if (env.devOptions) flags.push("developer options");
  if (env.adbEnabled) flags.push("ADB");
  if (env.autoTimeEnabled === false) flags.push("manual time");
  if (env.deviceCheckBit0) flags.push("DeviceCheck spoof bit");
  const pi = env.playIntegrity;
  if (pi && typeof pi.deviceActivityLevel === "string") flags.push(`device activity ${pi.deviceActivityLevel}`);
  if (pi && typeof pi.playProtectVerdict === "string") flags.push(`Play Protect ${pi.playProtectVerdict}`);
  const recognition = pi && Array.isArray(pi.deviceRecognitionVerdict) ? pi.deviceRecognitionVerdict : [];
  if (recognition.includes("MEETS_VIRTUAL_INTEGRITY") && !recognition.includes("MEETS_DEVICE_INTEGRITY")) {
    flags.push("Google emulator (virtual integrity)");
  }
  return flags.length > 0 ? flags.join(" · ") : "No environment flags";
}

export function TrustAdminScreen({
  serverHttpBase,
  csrfToken = "",
  escapeStage = false,
  getMapCenter,
  onClose
}: {
  serverHttpBase: string;
  csrfToken?: string;
  escapeStage?: boolean;
  // Trust Lab "Use map center".
  getMapCenter?: (() => Readonly<{ lat: number; lon: number }> | null) | undefined;
  onClose(): void;
}): React.JSX.Element {
  const api = useMemo(() => new TrustAdminClient(serverHttpBase, csrfToken), [serverHttpBase, csrfToken]);
  const [tab, setTab] = useState<TrustTab>("accounts");
  const [minDraft, setMinDraft] = useState("0");
  const [minLogodds, setMinLogodds] = useState(0);
  const [accounts, setAccounts] = useState<readonly TrustAdminAccountSummary[] | null>(null);
  const [detail, setDetail] = useState<TrustAdminAccountDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useModalBehavior<HTMLElement>({ open: true, onClose });

  const load = useCallback(async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      setAccounts((await api.listAccounts({ limit: LIMIT, minLogodds })).accounts);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Unable to load trust accounts");
    } finally {
      setBusy(false);
    }
  }, [api, minLogodds]);

  useEffect(() => {
    void load();
  }, [load]);

  const openDetail = useCallback(async (accountId: string): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      setDetail((await api.accountDetail(accountId)).account);
    } catch (detailError) {
      setError(detailError instanceof Error ? detailError.message : "Unable to load account");
    } finally {
      setBusy(false);
    }
  }, [api]);

  const content = (
    <div className="test-access-admin-backdrop">
      <section
        ref={dialogRef}
        className="test-access-admin trust-admin"
        role="dialog"
        aria-modal="true"
        aria-label="Ash Atlas Account Trust"
        tabIndex={-1}
      >
        <header className="test-access-admin-header">
          <div>
            <span className="auth-brand">
              <AshAtlasBrandLogo className="auth-brand-logo" />
              <span>Ash Atlas</span>
            </span>
            <h2>Account Trust</h2>
          </div>
          <button type="button" className="auth-secondary" onClick={onClose}>Close</button>
        </header>

        {error ? <div className="auth-error" role="alert">{error}</div> : null}

        {detail ? (
          <TrustDetail
            api={api}
            detail={detail}
            onBack={() => setDetail(null)}
            onChanged={() => openDetail(detail.accountId)}
          />
        ) : (
          <>
            <nav className="test-access-tabs" aria-label="Trust sections">
              <button type="button" aria-pressed={tab === "accounts"} onClick={() => setTab("accounts")}>
                Accounts
              </button>
              <button type="button" aria-pressed={tab === "alerts"} onClick={() => setTab("alerts")}>
                Alerts
              </button>
              <button type="button" aria-pressed={tab === "lab"} onClick={() => setTab("lab")}>
                Lab
              </button>
            </nav>
            {tab === "lab" ? (
              <TrustLabPanel api={api} getMapCenter={getMapCenter} />
            ) : tab === "alerts" ? (
              <TrustAlertsPanel api={api} onOpenAccount={(accountId) => void openDetail(accountId)} />
            ) : (
              <>
                <form
                  className="test-access-search"
                  onSubmit={(event) => {
                    event.preventDefault();
                    const parsed = Number(minDraft);
                    if (Number.isFinite(parsed)) setMinLogodds(parsed);
                  }}
                >
                  <input
                    type="number"
                    step="0.5"
                    inputMode="decimal"
                    value={minDraft}
                    aria-label="Minimum effective log-odds"
                    onChange={(event) => setMinDraft(event.currentTarget.value)}
                  />
                  <button type="submit" className="auth-secondary">Filter</button>
                </form>
                <p className="auth-detail">
                  Top {LIMIT} accounts by effective log-odds (decayed score plus static prior). Shadow tiers are
                  observational only.
                </p>
                <div className="test-access-list" aria-busy={busy}>
                  {accounts?.map((account) => (
                    <article key={account.accountId} className="test-access-row">
                      <div className="test-access-row-main">
                        <strong>{account.playerName ?? "No player"} · {account.effectiveLogodds.toFixed(2)}</strong>
                        <span>
                          Shadow tier {account.shadowTier} · {account.trustTier}
                          {account.providers.length ? ` · ${account.providers.join(", ")}` : ""}
                        </span>
                        <small>
                          Decayed {account.decayedLogodds.toFixed(2)} + prior {account.priorLogodds.toFixed(2)}
                          {account.lastSignalAt ? ` · Last signal ${formatTimestamp(account.lastSignalAt)}` : ""}
                        </small>
                        <small className="mono">{account.accountId}</small>
                      </div>
                      <div className="test-access-row-actions">
                        <button type="button" disabled={busy} onClick={() => void openDetail(account.accountId)}>
                          Details
                        </button>
                      </div>
                    </article>
                  ))}
                  {!busy && accounts?.length === 0 ? <p className="auth-detail">No matching accounts.</p> : null}
                </div>
              </>
            )}
          </>
        )}
      </section>
    </div>
  );
  return escapeStage ? createPortal(content, document.body) : content;
}

type DetailConfirmation = "settle" | "unsettle" | "quarantine";

function TrustDetail({
  api,
  detail,
  onBack,
  onChanged
}: {
  api: TrustAdminClient;
  detail: TrustAdminAccountDetail;
  onBack(): void;
  onChanged(): Promise<void>;
}): React.JSX.Element {
  const [confirmation, setConfirmation] = useState<DetailConfirmation | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const settlement = detail.settlement;

  const runSettlement = async (action: "settle" | "unsettle"): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await (action === "settle" ? api.settle(detail.accountId) : api.unsettle(detail.accountId));
      setConfirmation(null);
      await onChanged();
    } catch (actionError) {
      setConfirmation(null);
      setError(actionError instanceof Error ? actionError.message : "Unable to change Settled status");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="test-access-row">
        <div className="test-access-row-main">
          <strong>{detail.playerName ?? "No player"} · {detail.effectiveLogodds.toFixed(2)}</strong>
          <span>
            Shadow tier {detail.shadowTier} · {detail.trustTier} · peak {detail.peakLogodds.toFixed(2)}
          </span>
          <small>
            Decayed {detail.decayedLogodds.toFixed(2)} + prior {detail.priorLogodds.toFixed(2)}
            {detail.providers.length ? ` · ${detail.providers.join(", ")}` : ""}
          </small>
          {detail.landActionHoldUntil ? (
            <small>
              Land-action hold until {formatTimestamp(detail.landActionHoldUntil)}
              {detail.landActionHoldReason ? ` (${detail.landActionHoldReason})` : ""}
            </small>
          ) : null}
          <small className="mono">{detail.accountId}</small>
        </div>
        <div className="test-access-row-actions">
          <button type="button" onClick={onBack}>Back</button>
        </div>
      </div>
      {error ? <div className="auth-error" role="alert">{error}</div> : null}

      <h3 className="trust-admin-heading">Settled</h3>
      <div className="test-access-row">
        <div className="test-access-row-main">
          {settlement ? (
            <>
              <strong>
                {settlement.settled ? "Settled" : settlement.unsettleReason === "review_hold" ? "Settled paused for review" : "Not settled"}
                {settlement.provisionalUntil ? " (provisional)" : ""}
              </strong>
              <span>
                Checks {settlement.countedChecks}/{settlement.targetChecks} · days {settlement.countedDays}/{settlement.targetDays}
                {" "}· positions {settlement.distinctPositions} · difficulty {settlement.difficulty.toFixed(2)}
              </span>
              <small>Home {formatCoordinate(settlement.home)} · Settled home {formatCoordinate(settlement.settledHome)}</small>
              <small>
                {settlement.settledAt ? `Settled ${formatTimestamp(settlement.settledAt)}` : "Never settled"}
                {settlement.provisionalUntil ? ` · provisional until ${formatTimestamp(settlement.provisionalUntil)}` : ""}
                {settlement.unsettleReason ? ` · last unsettled: ${settlement.unsettleReason}` : ""}
              </small>
            </>
          ) : (
            <>
              <strong>No Settled record</strong>
              <small>No location has been recorded for this account yet.</small>
            </>
          )}
          <small>Last fix assurance: {detail.lastFixAssurance ?? "none"}</small>
        </div>
        <div className="test-access-row-actions">
          {settlement?.settled ? (
            <button type="button" disabled={busy} onClick={() => setConfirmation("unsettle")}>Unsettle</button>
          ) : (
            <button type="button" disabled={busy || !settlement?.home} onClick={() => setConfirmation("settle")}>Settle</button>
          )}
        </div>
      </div>

      <h3 className="trust-admin-heading">Attestations</h3>
      <div className="test-access-list">
        {detail.attestations.map((attestation) => (
          <article key={attestation.id} className="test-access-row">
            <div className="test-access-row-main">
              <strong>{attestation.method} · {attestation.outcome} · {attestation.assurance}</strong>
              <small>
                {formatTimestamp(attestation.createdAt)}
                {attestation.reason ? ` · ${attestation.reason}` : ""}
              </small>
            </div>
          </article>
        ))}
        {detail.attestations.length === 0 ? <p className="auth-detail">No attestations.</p> : null}
      </div>

      <h3 className="trust-admin-heading">Device environment</h3>
      <div className="test-access-list">
        {(detail.environments ?? []).map((env) => (
          <article key={env.id} className="test-access-row">
            <div className="test-access-row-main">
              <strong>
                {env.platform} · install {env.installIdHash}{env.installIdPersistent ? " (persistent)" : ""}
                {env.installSource ? ` · ${env.installSource}` : ""}
              </strong>
              <span>{environmentFlags(env)}</span>
              <small>
                {formatTimestamp(env.createdAt)} · GPS {env.gpsCountries.join(" ") || "?"}
                {env.simCountry ? ` · SIM ${env.simCountry}` : ""}
                {env.networkCountry ? ` · network ${env.networkCountry}` : ""}
                {env.cellCountries.length > 0 ? ` · cells ${env.cellCountries.join(" ")}` : ""}
                {env.timeZoneCountries.length > 0 ? ` · time zone ${env.timeZoneCountries.slice(0, 4).join(" ")}` : ""}
                {env.localeCountry ? ` · locale ${env.localeCountry}` : ""}
              </small>
            </div>
          </article>
        ))}
        {(detail.environments ?? []).length === 0 ? <p className="auth-detail">No environment reports.</p> : null}
        {(detail.installLinkedAccounts ?? []).length > 0 ? (
          <p className="auth-detail">
            Same install as: {(detail.installLinkedAccounts ?? [])
              .map((linked) => `${linked.playerName ?? linked.accountId} (${formatTimestamp(linked.lastSeenAt)})`)
              .join(", ")}
          </p>
        ) : null}
      </div>

      <h3 className="trust-admin-heading">Linked accounts</h3>
      <div className="test-access-list">
        <p className="auth-detail">
          Native devices used: {detail.nativeDeviceCount ?? 0}. Accounts below share an install or a sign-in device
          with this one (each side lists the other).
        </p>
        {(detail.linkedAccounts ?? []).map((linked) => (
          <article key={linked.accountId} className="test-access-row">
            <div className="test-access-row-main">
              <strong>{linked.playerName ?? "No player"}</strong>
              <span>
                {linked.via.map((via) => (via === "install" ? "same app install" : "same sign-in device")).join(" · ")}
              </span>
              <small>Last seen {formatTimestamp(linked.lastSeenAt)}</small>
              <small className="mono">{linked.accountId}</small>
            </div>
          </article>
        ))}
        {(detail.linkedAccounts ?? []).length === 0 ? <p className="auth-detail">No linked accounts.</p> : null}
      </div>

      <h3 className="trust-admin-heading">Brought by</h3>
      <ArrivalList arrivals={detail.broughtBy} empty="Nobody brought this account to a destination." />
      <h3 className="trust-admin-heading">Brought in</h3>
      <div className="test-access-row-actions">
        <button type="button" disabled={busy} onClick={() => setConfirmation("quarantine")}>Quarantine arrivals</button>
      </div>
      <ArrivalList arrivals={detail.broughtIn} empty="This account has not brought anyone in." />

      <h3 className="trust-admin-heading">Ledger</h3>
      <div className="test-access-list">
        {detail.events.map((event) => (
          <article key={event.id} className="test-access-row">
            <div className="test-access-row-main">
              <strong>
                {event.rule} · {event.weight >= 0 ? "+" : ""}{event.weight.toFixed(2)}
                {event.reversedAt ? " · reversed" : ""}
              </strong>
              <span>{event.kind} · log-odds after {event.logoddsAfter.toFixed(2)}</span>
              <small>{formatTimestamp(event.createdAt)}</small>
            </div>
          </article>
        ))}
        {detail.events.length === 0 ? <p className="auth-detail">No ledger events.</p> : null}
      </div>
      <h3 className="trust-admin-heading">Recent location reports</h3>
      <div className="test-access-list">
        {detail.locationReports.map((report) => (
          <article key={report.id} className="test-access-row">
            <div className="test-access-row-main">
              <strong>{report.verdict}{report.verdictReason ? ` · ${report.verdictReason}` : ""}</strong>
              <span>
                {report.source} · {report.speedBucket ?? "no bucket"}
                {report.impliedKmh !== null ? ` · ${report.impliedKmh.toFixed(0)} km/h` : ""}
                {report.distanceM !== null ? ` · ${(report.distanceM / 1000).toFixed(1)} km` : ""}
              </span>
              <small>{formatTimestamp(report.receivedAt)} · score {report.score.toFixed(2)}</small>
            </div>
          </article>
        ))}
        {detail.locationReports.length === 0 ? <p className="auth-detail">No location reports.</p> : null}
      </div>

      {confirmation === "settle" || confirmation === "unsettle" ? (
        <GameConfirmationPrompt
          title={confirmation === "settle" ? "Mark this account Settled?" : "Unsettle this account?"}
          category="TRUST"
          detail={confirmation === "settle"
            ? "Skips the earning period: the current home becomes the Settled home."
            : "Clears progress and the Settled home, and cancels this player's pending Travel Invites."}
          confirmLabel={confirmation === "settle" ? "Settle account" : "Unsettle account"}
          destructive={confirmation === "unsettle"}
          busy={busy}
          onConfirm={() => void runSettlement(confirmation)}
          onCancel={() => setConfirmation(null)}
        />
      ) : null}
      {confirmation === "quarantine" ? (
        <QuarantineArrivalsPrompt
          api={api}
          hostAccountId={detail.accountId}
          defaultSince={new Date(Date.now() - DAY_MS)}
          onDone={() => {
            setConfirmation(null);
            void onChanged();
          }}
          onCancel={() => setConfirmation(null)}
        />
      ) : null}
    </>
  );
}

function ArrivalList({
  arrivals,
  empty
}: {
  arrivals: readonly TrustAdminArrivalView[];
  empty: string;
}): React.JSX.Element {
  return (
    <div className="test-access-list">
      {arrivals.map((arrival) => (
        <article key={arrival.id} className="test-access-row">
          <div className="test-access-row-main">
            <strong>{arrival.otherPlayerName ?? "No player"} · {arrival.kind}</strong>
            <small>
              {formatTimestamp(arrival.createdAt)}
              {arrival.lat !== null && arrival.lon !== null ? ` · ${arrival.lat.toFixed(2)}, ${arrival.lon.toFixed(2)}` : ""}
            </small>
            <small className="mono">{arrival.otherAccountId}</small>
          </div>
        </article>
      ))}
      {arrivals.length === 0 ? <p className="auth-detail">{empty}</p> : null}
    </div>
  );
}

function formatCoordinate(value: TrustAdminCoordinate | null): string {
  return value ? `${value.lat.toFixed(2)}, ${value.lon.toFixed(2)}` : "none";
}
