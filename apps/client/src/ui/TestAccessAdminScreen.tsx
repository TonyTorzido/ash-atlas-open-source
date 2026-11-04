import type {
  DevAccessAccountAdminView,
  TestAccessAccountAdminView,
  TestAccessAdminListResponse,
  TestAccessEmailGrantAdminView,
  TestAccessMode
} from "@ash-atlas/shared";
import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";

import {
  TestAccessAdminClient,
  type TestAccessFilter
} from "../auth/testAccessClient.js";
import { AshAtlasBrandLogo } from "./AshAtlasBrandLogo.js";
import { GameConfirmationPrompt } from "./GameActionPrompt.js";
import { useModalBehavior } from "./useModalBehavior.js";

const FILTERS: ReadonlyArray<{ value: TestAccessFilter; label: string }> = [
  { value: "pending", label: "Pending" },
  { value: "approved", label: "Approved" },
  { value: "denied", label: "Denied" },
  { value: "revoked", label: "Revoked" },
  { value: "unclaimed", label: "Pre-approvals" },
  { value: "dev", label: "Dev list" }
];

const MODE_CHOICES: ReadonlyArray<{ mode: TestAccessMode; label: string }> = [
  { mode: "open", label: "Open" },
  { mode: "closed", label: "Closed" },
  { mode: "dev", label: "Dev" }
];

const MODE_COPY: Record<TestAccessMode, {
  summary: string;
  title: string;
  detail: string;
  confirm: string;
}> = {
  open: {
    summary: "Anyone with a verified Google account can currently create an account and play Ash Atlas.",
    title: "Enable Open Access?",
    detail: "Any user with a verified Google account will be able to register and play without manual approval.",
    confirm: "Enable Open Access"
  },
  closed: {
    summary: "Only approved or pre-approved accounts can currently enter Ash Atlas.",
    title: "Enable Closed Access?",
    detail: "Accounts without approval or pre-approval will no longer be able to enter, and anyone among them who is playing now is disconnected. Existing approval records and player data will remain unchanged.",
    confirm: "Enable Closed Access"
  },
  dev: {
    summary: "Only developer accounts can enter Ash Atlas.",
    title: "Enable Dev Access?",
    detail: "Only developer accounts and accounts you approved on the Dev list will be able to enter. Everyone else playing now is disconnected. Approval records and player data will remain unchanged.",
    confirm: "Enable Dev Access"
  }
};

type PendingConfirmation =
  | { kind: "account"; id: string; action: "deny" | "revoke"; label: string }
  | { kind: "grant"; id: string; action: "revoke"; label: string }
  | { kind: "dev"; id: string; action: "deny" | "revoke"; label: string }
  | { kind: "mode"; mode: TestAccessMode };

export function TestAccessAdminScreen({
  serverHttpBase,
  csrfToken,
  escapeStage = false,
  onClose
}: {
  serverHttpBase: string;
  csrfToken: string;
  escapeStage?: boolean;
  onClose(): void;
}): React.JSX.Element {
  const api = useMemo(
    () => new TestAccessAdminClient(serverHttpBase, csrfToken),
    [csrfToken, serverHttpBase]
  );
  const [filter, setFilter] = useState<TestAccessFilter>("pending");
  const [searchDraft, setSearchDraft] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<TestAccessAdminListResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preapproveEmail, setPreapproveEmail] = useState("");
  const [preapproveResult, setPreapproveResult] = useState<string | null>(null);
  const [devGrantEmail, setDevGrantEmail] = useState("");
  const [devGrantResult, setDevGrantResult] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<PendingConfirmation | null>(null);
  const [accessMode, setAccessMode] = useState<TestAccessMode | null>(null);
  const [modeLoading, setModeLoading] = useState(true);
  const [modeSaving, setModeSaving] = useState(false);
  const dialogRef = useModalBehavior<HTMLElement>({ open: true, onClose });

  const load = useCallback(async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      setResult(await api.list({ status: filter, search, page }));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Unable to load test access");
    } finally {
      setBusy(false);
    }
  }, [api, filter, page, search]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    let active = true;
    setModeLoading(true);
    void api.getAccessMode().then((response) => {
      if (active) setAccessMode(response.mode);
    }).catch((modeError: unknown) => {
      if (active) {
        setError(modeError instanceof Error ? modeError.message : "Unable to load access mode");
      }
    }).finally(() => {
      if (active) setModeLoading(false);
    });
    return () => { active = false; };
  }, [api]);

  const runModeChange = async (mode: TestAccessMode): Promise<void> => {
    if (modeSaving) return;
    setModeSaving(true);
    setError(null);
    try {
      const authoritative = await api.setAccessMode(mode);
      setAccessMode(authoritative.mode);
      setConfirmation(null);
    } catch (modeError) {
      setError(modeError instanceof Error ? modeError.message : "Access mode change failed");
    } finally {
      setModeSaving(false);
    }
  };

  const runAccountAction = async (
    accountId: string,
    action: "approve" | "deny" | "revoke" | "restore"
  ): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await api.decide(accountId, action);
      setConfirmation(null);
      await load();
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : "Decision failed");
      setBusy(false);
    }
  };

  const runDevAction = async (
    accountId: string,
    action: "approve" | "deny" | "revoke"
  ): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await api.decideDevAccess(accountId, action);
      setConfirmation(null);
      await load();
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : "Dev access change failed");
      setBusy(false);
    }
  };

  const runGrantRevocation = async (grantId: string): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await api.revokeGrant(grantId);
      setConfirmation(null);
      await load();
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : "Revocation failed");
      setBusy(false);
    }
  };

  const content = (
    <div className="test-access-admin-backdrop">
      <section
        ref={dialogRef}
        className="test-access-admin"
        role="dialog"
        aria-modal="true"
        aria-label="Ash Atlas Test Access"
        tabIndex={-1}
      >
        <header className="test-access-admin-header">
          <div>
            <span className="auth-brand">
              <AshAtlasBrandLogo className="auth-brand-logo" />
              <span>Ash Atlas</span>
            </span>
            <h2>Test Access</h2>
          </div>
          <button type="button" className="auth-secondary" onClick={onClose}>Close</button>
        </header>

        <section
          className={`test-access-mode-panel${accessMode ? ` is-${accessMode}` : " is-loading"}`}
          aria-busy={modeLoading || modeSaving}
          aria-live="polite"
        >
          {modeLoading || !accessMode ? (
            <>
              <span className="test-access-mode-label">ACCESS MODE</span>
              <strong>Loading authoritative mode...</strong>
            </>
          ) : (
            <>
              <div className="test-access-mode-copy">
                <span className="test-access-mode-label">ACCESS MODE</span>
                <strong>{accessMode.toUpperCase()}</strong>
                <p>{MODE_COPY[accessMode].summary}</p>
              </div>
              <div className="test-access-mode-choices" role="group" aria-label="Choose access mode">
                {MODE_CHOICES.map((choice) => (
                  <button
                    key={choice.mode}
                    type="button"
                    className="test-access-mode-action"
                    aria-pressed={accessMode === choice.mode}
                    disabled={modeSaving || accessMode === choice.mode}
                    onClick={() => setConfirmation({ kind: "mode", mode: choice.mode })}
                  >
                    {modeSaving && confirmation?.kind === "mode" && confirmation.mode === choice.mode
                      ? "Saving..."
                      : choice.label}
                  </button>
                ))}
              </div>
            </>
          )}
        </section>

        <form
          className="test-access-preapprove"
          onSubmit={(event) => {
            event.preventDefault();
            setBusy(true);
            setError(null);
            setPreapproveResult(null);
            void api.preapprove(preapproveEmail).then((response) => {
              const outcome = String(response.outcome ?? "updated");
              setPreapproveResult(outcome.replaceAll("_", " "));
              setPreapproveEmail("");
              return load();
            }).catch((preapproveError: unknown) => {
              setError(
                preapproveError instanceof Error
                  ? preapproveError.message
                  : "Pre-approval failed"
              );
              setBusy(false);
            });
          }}
        >
          <label className="auth-field">
            Pre-approve verified Google email
            <input
              type="email"
              autoComplete="off"
              value={preapproveEmail}
              disabled={busy}
              placeholder="tester@example.com"
              onChange={(event) => setPreapproveEmail(event.currentTarget.value)}
            />
          </label>
          <button type="submit" className="auth-primary" disabled={busy || !preapproveEmail.trim()}>
            Pre-approve
          </button>
          {preapproveResult ? <p className="test-access-inline-result">{preapproveResult}</p> : null}
        </form>

        <nav className="test-access-tabs" aria-label="Access status filters">
          {FILTERS.map((entry) => (
            <button
              key={entry.value}
              type="button"
              aria-pressed={filter === entry.value}
              onClick={() => {
                setFilter(entry.value);
                setPage(1);
              }}
            >
              {entry.label}
            </button>
          ))}
        </nav>

        <form
          className="test-access-search"
          onSubmit={(event) => {
            event.preventDefault();
            setSearch(searchDraft.trim().toLowerCase());
            setPage(1);
          }}
        >
          <input
            type="search"
            value={searchDraft}
            placeholder="Search verified email"
            aria-label="Search verified email"
            onChange={(event) => setSearchDraft(event.currentTarget.value)}
          />
          <button type="submit" className="auth-secondary">Search</button>
        </form>

        {filter === "dev" ? (
          <form
            className="test-access-preapprove"
            onSubmit={(event) => {
              event.preventDefault();
              setBusy(true);
              setError(null);
              setDevGrantResult(null);
              void api.grantDevAccess(devGrantEmail).then(() => {
                setDevGrantResult("Added to the Dev list");
                setDevGrantEmail("");
                return load();
              }).catch((grantError: unknown) => {
                setError(grantError instanceof Error ? grantError.message : "Dev access grant failed");
                setBusy(false);
              });
            }}
          >
            <label className="auth-field">
              Add an existing approved account to the Dev list
              <input
                type="email"
                autoComplete="off"
                value={devGrantEmail}
                disabled={busy}
                placeholder="player@example.com"
                onChange={(event) => setDevGrantEmail(event.currentTarget.value)}
              />
            </label>
            <button type="submit" className="auth-primary" disabled={busy || !devGrantEmail.trim()}>
              Add to Dev list
            </button>
            {devGrantResult ? <p className="test-access-inline-result">{devGrantResult}</p> : null}
          </form>
        ) : null}

        {error ? <div className="auth-error" role="alert">{error}</div> : null}
        <div className="test-access-list" aria-busy={busy}>
          {result?.items.map((item) => item.kind === "account"
            ? (
                <AccountRow
                  key={item.accountId}
                  account={item}
                  busy={busy}
                  onApprove={(action) => void runAccountAction(item.accountId, action)}
                  onAddToDevList={() => void runDevAction(item.accountId, "approve")}
                  onConfirm={(action) => setConfirmation({
                    kind: "account",
                    id: item.accountId,
                    action,
                    label: item.verifiedEmail
                  })}
                />
              )
            : item.kind === "dev"
              ? (
                  <DevRow
                    key={item.accountId}
                    entry={item}
                    busy={busy}
                    onApprove={() => void runDevAction(item.accountId, "approve")}
                    onConfirm={(action) => setConfirmation({
                      kind: "dev",
                      id: item.accountId,
                      action,
                      label: item.verifiedEmail
                    })}
                  />
                )
              : (
                  <GrantRow
                    key={item.grantId}
                    grant={item}
                    busy={busy}
                    onConfirm={() => setConfirmation({
                      kind: "grant",
                      id: item.grantId,
                      action: "revoke",
                      label: item.email
                    })}
                  />
                ))}
          {!busy && result?.items.length === 0 ? (
            <p className="auth-detail">No matching records.</p>
          ) : null}
        </div>

        <footer className="test-access-pagination">
          <span>{result?.total ?? 0} records</span>
          <button
            type="button"
            disabled={busy || page <= 1}
            onClick={() => setPage((current) => Math.max(1, current - 1))}
          >
            Previous
          </button>
          <span>Page {page}</span>
          <button
            type="button"
            disabled={busy || !result || page * result.pageSize >= result.total}
            onClick={() => setPage((current) => current + 1)}
          >
            Next
          </button>
        </footer>
      </section>

      {confirmation?.kind === "mode" ? (
        <GameConfirmationPrompt
          title={MODE_COPY[confirmation.mode].title}
          category="TEST ACCESS"
          detail={MODE_COPY[confirmation.mode].detail}
          confirmLabel={MODE_COPY[confirmation.mode].confirm}
          busy={modeSaving}
          onConfirm={() => void runModeChange(confirmation.mode)}
          onCancel={() => setConfirmation(null)}
        />
      ) : confirmation ? (
        <div className="test-access-confirm-backdrop">
          <section className="test-access-confirm" role="dialog" aria-modal="true">
            <h3>
              {confirmation.kind === "dev"
                ? confirmation.action === "deny" ? "Deny Dev Access?" : "Remove from Dev List?"
                : confirmation.action === "deny" ? "Deny Test Access?" : "Revoke Access?"}
            </h3>
            <p>{confirmation.label}</p>
            <div>
              <button
                type="button"
                className="danger-action"
                disabled={busy}
                onClick={() => {
                  if (confirmation.kind === "grant") {
                    void runGrantRevocation(confirmation.id);
                  } else if (confirmation.kind === "dev") {
                    void runDevAction(confirmation.id, confirmation.action);
                  } else {
                    void runAccountAction(confirmation.id, confirmation.action);
                  }
                }}
              >
                Confirm
              </button>
              <button
                type="button"
                className="auth-secondary"
                disabled={busy}
                onClick={() => setConfirmation(null)}
              >
                Cancel
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
  return escapeStage ? createPortal(content, document.body) : content;
}

function AccountRow({
  account,
  busy,
  onApprove,
  onAddToDevList,
  onConfirm
}: {
  account: TestAccessAccountAdminView;
  busy: boolean;
  onApprove(action: "approve" | "restore"): void;
  onAddToDevList(): void;
  onConfirm(action: "deny" | "revoke"): void;
}): React.JSX.Element {
  const onDevList = account.devAccessStatus === "approved";
  const pendingAge = account.status === "pending"
    ? formatAge(Date.now() - Date.parse(account.requestedAt))
    : null;
  return (
    <article className="test-access-row">
      <div className="test-access-row-main">
        <strong>{account.verifiedEmail}</strong>
        <span>
          {account.status}{pendingAge ? ` · pending ${pendingAge}` : ""}
          {onDevList ? " · Dev list" : ""}
        </span>
        <small>
          Created {formatTimestamp(account.createdAt)}
          {account.lastLoginAt ? ` · Last login ${formatTimestamp(account.lastLoginAt)}` : ""}
        </small>
        {account.playerName ? <small>Player: {account.playerName}</small> : null}
        <small className="mono">{account.accountId}</small>
      </div>
      <div className="test-access-row-actions">
        {account.status === "pending" ? (
          <>
            <button type="button" disabled={busy} onClick={() => onApprove("approve")}>Approve</button>
            <button type="button" disabled={busy} onClick={() => onConfirm("deny")}>Deny</button>
          </>
        ) : account.status === "approved" ? (
          <>
            {onDevList ? null : (
              <button type="button" disabled={busy} onClick={onAddToDevList}>Add to Dev list</button>
            )}
            <button type="button" disabled={busy} onClick={() => onConfirm("revoke")}>Revoke Access</button>
          </>
        ) : (
          <button type="button" disabled={busy} onClick={() => onApprove("restore")}>
            Approve / Restore
          </button>
        )}
      </div>
    </article>
  );
}

function DevRow({
  entry,
  busy,
  onApprove,
  onConfirm
}: {
  entry: DevAccessAccountAdminView;
  busy: boolean;
  onApprove(): void;
  onConfirm(action: "deny" | "revoke"): void;
}): React.JSX.Element {
  const statusLabel = entry.devAccessStatus === "pending"
    ? `Requested dev access${entry.requestedAt ? ` ${formatAge(Date.now() - Date.parse(entry.requestedAt))} ago` : ""}`
    : entry.devAccessStatus === "approved"
      ? "On the Dev list"
      : entry.devAccessStatus === "denied"
        ? "Dev access denied"
        : "Removed from the Dev list";
  const testAccessBlocked = entry.testAccessStatus !== "approved";
  return (
    <article className="test-access-row">
      <div className="test-access-row-main">
        <strong>{entry.verifiedEmail}</strong>
        <span>{statusLabel}</span>
        {testAccessBlocked ? (
          <small>Test access is {entry.testAccessStatus}; approve it before granting dev access.</small>
        ) : null}
        {entry.decidedAt ? <small>Decided {formatTimestamp(entry.decidedAt)}</small> : null}
        {entry.playerName ? <small>Player: {entry.playerName}</small> : null}
        <small className="mono">{entry.accountId}</small>
      </div>
      <div className="test-access-row-actions">
        {entry.devAccessStatus === "pending" ? (
          <>
            <button type="button" disabled={busy || testAccessBlocked} onClick={onApprove}>Approve</button>
            <button type="button" disabled={busy} onClick={() => onConfirm("deny")}>Deny</button>
          </>
        ) : entry.devAccessStatus === "approved" ? (
          <button type="button" disabled={busy} onClick={() => onConfirm("revoke")}>Remove</button>
        ) : (
          <button type="button" disabled={busy || testAccessBlocked} onClick={onApprove}>Approve</button>
        )}
      </div>
    </article>
  );
}

function GrantRow({
  grant,
  busy,
  onConfirm
}: {
  grant: TestAccessEmailGrantAdminView;
  busy: boolean;
  onConfirm(): void;
}): React.JSX.Element {
  return (
    <article className="test-access-row">
      <div className="test-access-row-main">
        <strong>{grant.email}</strong>
        <span>Unclaimed pre-approval</span>
        <small>Created {formatTimestamp(grant.createdAt)}</small>
      </div>
      <div className="test-access-row-actions">
        <button type="button" disabled={busy} onClick={onConfirm}>Revoke</button>
      </div>
    </article>
  );
}

function formatTimestamp(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(value));
}

function formatAge(milliseconds: number): string {
  const minutes = Math.max(0, Math.floor(milliseconds / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}
