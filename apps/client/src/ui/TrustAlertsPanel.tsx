import type {
  TrustAdminAlertView,
  TrustAlertAction,
  TrustAlertKind,
  TrustAlertStatus
} from "@ash-atlas/shared";
import { useCallback, useEffect, useState } from "react";

import type { TrustAdminClient } from "../auth/trustAdminClient.js";
import { GameConfirmationPrompt } from "./GameActionPrompt.js";

export const ALERT_PAGE_SIZE = 25;
const HOUR_MS = 60 * 60_000;

const STATUS_FILTERS: ReadonlyArray<{ value: TrustAlertStatus | null; label: string }> = [
  { value: "pending", label: "Pending" },
  { value: "approved", label: "Approved" },
  { value: "locked", label: "Locked" },
  { value: "dismissed", label: "Dismissed" },
  { value: null, label: "All" }
];

const KIND_LABELS: Readonly<Record<TrustAlertKind, string>> = {
  zone_red: "Red zone relocation",
  zone_orange: "Orange zone relocation",
  zone_yellow: "Yellow zone relocation",
  mismatch: "Location mismatch",
  settled_revoked: "Settled revoked",
  mass_arrival: "Mass arrival",
  kingdom_proximity: "Next to a kingdom",
  multi_account: "Several accounts on one device",
  account_shared: "Account shared between devices",
  state_hopping: "Location hopping"
};

export function formatTimestamp(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(value));
}

function toLocalInput(date: Date): string {
  const shifted = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return shifted.toISOString().slice(0, 16);
}

type Confirmation =
  | { kind: "lock"; alert: TrustAdminAlertView }
  | { kind: "unlock"; alert: TrustAdminAlertView }
  | { kind: "quarantine"; alert: TrustAdminAlertView };

export function TrustAlertsPanel({
  api,
  onOpenAccount
}: {
  api: TrustAdminClient;
  onOpenAccount(accountId: string): void;
}): React.JSX.Element {
  const [status, setStatus] = useState<TrustAlertStatus | null>("pending");
  const [kind, setKind] = useState<TrustAlertKind | null>(null);
  const [offset, setOffset] = useState(0);
  const [alerts, setAlerts] = useState<readonly TrustAdminAlertView[] | null>(null);
  const [total, setTotal] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const result = await api.listAlerts({ status, kind, limit: ALERT_PAGE_SIZE, offset });
      setAlerts(result.alerts);
      setTotal(result.total);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Unable to load alerts");
    } finally {
      setBusy(false);
    }
  }, [api, status, kind, offset]);

  useEffect(() => {
    void load();
  }, [load]);

  const decide = async (alert: TrustAdminAlertView, action: TrustAlertAction): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await api.decideAlert(alert.id, action);
      setConfirmation(null);
      await load();
    } catch (decisionError) {
      setConfirmation(null);
      setError(decisionError instanceof Error ? decisionError.message : "Unable to update the alert");
      setBusy(false);
    }
  };

  return (
    <>
      <nav className="test-access-tabs" aria-label="Alert status filters">
        {STATUS_FILTERS.map((entry) => (
          <button
            key={entry.label}
            type="button"
            aria-pressed={status === entry.value}
            onClick={() => {
              setStatus(entry.value);
              setOffset(0);
            }}
          >
            {entry.label}
          </button>
        ))}
      </nav>
      <select
        className="trust-admin-select"
        aria-label="Alert kind"
        value={kind ?? ""}
        onChange={(event) => {
          setKind((event.currentTarget.value || null) as TrustAlertKind | null);
          setOffset(0);
        }}
      >
        <option value="">All kinds</option>
        {(Object.keys(KIND_LABELS) as TrustAlertKind[]).map((value) => (
          <option key={value} value={value}>{KIND_LABELS[value]}</option>
        ))}
      </select>
      {error ? <div className="auth-error" role="alert">{error}</div> : null}
      <div className="test-access-list" aria-busy={busy}>
        {alerts?.map((alert) => (
          <article key={alert.id} className="test-access-row trust-alert-row">
            <div className="test-access-row-main">
              <strong>
                <span className={`trust-alert-badge trust-alert-badge--${alert.severity}`}>
                  Severity {alert.severity}
                </span>
                {" "}{KIND_LABELS[alert.kind]} · {alert.playerName ?? "No player"}
              </strong>
              <span>
                {alert.status}
                {alert.details.autoLocked === true ? " · auto-locked new account" : ""}
                {typeof alert.details.unlockedAt === "string" ? " · unlocked" : ""}
                {alert.lat !== null && alert.lon !== null ? ` · ${alert.lat.toFixed(2)}, ${alert.lon.toFixed(2)}` : ""}
                {alert.count > 1 ? ` · ${alert.count} times` : ""}
              </span>
              <small>
                {formatTimestamp(alert.createdAt)}
                {alert.allowanceExpiresAt ? ` · one relocation allowed until ${formatTimestamp(alert.allowanceExpiresAt)}` : ""}
              </small>
              <small className="mono">{alert.accountId}</small>
            </div>
            <div className="test-access-row-actions">
              <button type="button" disabled={busy} onClick={() => onOpenAccount(alert.accountId)}>Details</button>
              {alert.status === "pending" ? (
                <button type="button" disabled={busy} onClick={() => void decide(alert, "approve")}>Approve</button>
              ) : null}
              {alert.status === "pending" || alert.status === "approved" ? (
                <button type="button" disabled={busy} onClick={() => setConfirmation({ kind: "lock", alert })}>Lock</button>
              ) : null}
              {alert.status === "pending" ? (
                <button type="button" disabled={busy} onClick={() => void decide(alert, "dismiss")}>Dismiss</button>
              ) : null}
              {alert.status === "locked" ? (
                <button type="button" disabled={busy} onClick={() => setConfirmation({ kind: "unlock", alert })}>Unlock</button>
              ) : null}
              {alert.kind === "mass_arrival" ? (
                <button type="button" disabled={busy} onClick={() => setConfirmation({ kind: "quarantine", alert })}>
                  Quarantine arrivals
                </button>
              ) : null}
            </div>
          </article>
        ))}
        {!busy && alerts?.length === 0 ? <p className="auth-detail">No matching alerts.</p> : null}
      </div>
      <footer className="test-access-pagination">
        <span>{total} alerts</span>
        <button type="button" disabled={busy || offset <= 0} onClick={() => setOffset((current) => Math.max(0, current - ALERT_PAGE_SIZE))}>
          Previous
        </button>
        <span>Page {Math.floor(offset / ALERT_PAGE_SIZE) + 1}</span>
        <button type="button" disabled={busy || offset + ALERT_PAGE_SIZE >= total} onClick={() => setOffset((current) => current + ALERT_PAGE_SIZE)}>
          Next
        </button>
      </footer>
      {confirmation?.kind === "lock" ? (
        <GameConfirmationPrompt
          title="Lock this account?"
          category="TRUST"
          detail="Locking suspends the account and signs it out. Use Quarantine arrivals separately for guests it brought in."
          confirmLabel="Lock account"
          destructive
          busy={busy}
          onConfirm={() => void decide(confirmation.alert, "lock")}
          onCancel={() => setConfirmation(null)}
        />
      ) : null}
      {confirmation?.kind === "unlock" ? (
        <GameConfirmationPrompt
          title="Unlock this account?"
          category="TRUST"
          detail="Unlocking reactivates the account if a trust lock suspended it; the player signs in again. The alert moves to Dismissed."
          confirmLabel="Unlock account"
          busy={busy}
          onConfirm={() => void decide(confirmation.alert, "unlock")}
          onCancel={() => setConfirmation(null)}
        />
      ) : null}
      {confirmation?.kind === "quarantine" ? (
        <QuarantineArrivalsPrompt
          api={api}
          hostAccountId={confirmation.alert.accountId}
          defaultSince={new Date(new Date(confirmation.alert.createdAt).getTime() - HOUR_MS)}
          onDone={() => {
            setConfirmation(null);
            void load();
          }}
          onCancel={() => setConfirmation(null)}
        />
      ) : null}
    </>
  );
}

/**
 * Quarantine arrivals since T: a dry run reports how many guests would be
 * suspended; only then can the count be confirmed (the confirm carries it so a
 * changed set is refused rather than applied).
 */
export function QuarantineArrivalsPrompt({
  api,
  hostAccountId,
  defaultSince,
  onDone,
  onCancel
}: {
  api: TrustAdminClient;
  hostAccountId: string;
  defaultSince: Date;
  onDone(suspended: number): void;
  onCancel(): void;
}): React.JSX.Element {
  const [sinceInput, setSinceInput] = useState(toLocalInput(defaultSince));
  const [previewCount, setPreviewCount] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const parsedSince = new Date(sinceInput);
  const sinceIso = Number.isNaN(parsedSince.getTime()) ? null : parsedSince.toISOString();

  const preview = async (): Promise<void> => {
    if (!sinceIso) return;
    setBusy(true);
    setError(null);
    try {
      setPreviewCount((await api.quarantineArrivals(hostAccountId, { since: sinceIso, confirm: false })).guestCount);
    } catch (previewError) {
      setPreviewCount(null);
      setError(previewError instanceof Error ? previewError.message : "Unable to count arrivals");
    } finally {
      setBusy(false);
    }
  };

  const confirm = async (): Promise<void> => {
    if (!sinceIso || previewCount === null) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.quarantineArrivals(hostAccountId, {
        since: sinceIso,
        confirm: true,
        expectedCount: previewCount
      });
      onDone(result.suspendedCount);
    } catch (confirmError) {
      setPreviewCount(null);
      setError(confirmError instanceof Error ? confirmError.message : "Unable to quarantine arrivals");
      setBusy(false);
    }
  };

  return (
    <GameConfirmationPrompt
      title="Quarantine arrivals"
      category="TRUST"
      detail="Suspends every active account this player brought in since the chosen time. Count them first."
      confirmLabel={previewCount === null ? "Count arrivals first" : `Suspend ${previewCount} account${previewCount === 1 ? "" : "s"}`}
      confirmEnabled={previewCount !== null && previewCount > 0}
      disabledReason={previewCount === 0 ? "No active arrivals since that time." : null}
      destructive
      busy={busy}
      content={
        <div className="trust-quarantine-form">
          <label>
            <span>Arrivals since</span>
            <input
              type="datetime-local"
              value={sinceInput}
              onChange={(event) => {
                setSinceInput(event.currentTarget.value);
                setPreviewCount(null);
              }}
            />
          </label>
          <button type="button" className="auth-secondary" disabled={busy || !sinceIso} onClick={() => void preview()}>
            Count arrivals
          </button>
          {previewCount !== null ? (
            <p role="status">
              {previewCount} active account{previewCount === 1 ? "" : "s"} would be suspended.
            </p>
          ) : null}
          {error ? <p className="auth-error" role="alert">{error}</p> : null}
        </div>
      }
      onConfirm={() => void confirm()}
      onCancel={onCancel}
    />
  );
}
