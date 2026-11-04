import type {
  FlagAccessMode,
  FlagManagementDashboardSnapshot,
  FlagSnapshot
} from "@ash-atlas/shared";
import { useEffect, useRef, useState } from "react";

import {
  fetchFlagManagement,
  resolveFlagPassage,
  saveBulkFlagToll,
  saveFlagPreferences,
  searchFlagAccessPlayers,
  setNormalFlagGrant
} from "../flags/flagAccess.js";
import { renameFlag } from "../flags/renameFlag.js";
import { ThemedSelect } from "./ThemedSelect.js";
import { AtlasShrineControls } from "./AtlasShrineControls.js";
import { GameConfirmationPrompt } from "./GameActionPrompt.js";
import type { AtlasShrineMutationResult } from "../flags/atlasShrines.js";

export type FlagManagementTab = "defaults" | "atlas_shrines" | "normal";

const FLAG_MODE_OPTIONS = [
  { value: "public", label: "Public" },
  { value: "normal", label: "Normal" },
  { value: "private", label: "Private" }
] as const;

type Props = Readonly<{
  tab: FlagManagementTab;
  serverHttpBase: string;
  csrfToken: string;
  revision: number;
  onTravelAtlasShrine(flagId: string): void;
  onAtlasShrineMutation?(result: AtlasShrineMutationResult): void;
  onAtlasShrineRenamed?(flag: FlagSnapshot): void;
}>;

export function FlagManagementView(props: Props): React.JSX.Element {
  const [dashboard, setDashboard] = useState<FlagManagementDashboardSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [results, setResults] = useState<Array<{ playerId: string; playerName: string }>>([]);
  const [editingFlagId, setEditingFlagId] = useState<string | null>(null);
  const [editingFlagName, setEditingFlagName] = useState("");
  const [bulkConfirmation, setBulkConfirmation] = useState<Readonly<{
    mode: "public" | "normal";
    toll: string;
    count: number;
  }> | null>(null);
  const reloadGeneration = useRef(0);

  const reload = (): void => {
    const generation = ++reloadGeneration.current;
    const controller = new AbortController();
    setError(null);
    void fetchFlagManagement(props.serverHttpBase, controller.signal)
      .then((nextDashboard) => {
        if (reloadGeneration.current === generation) setDashboard(nextDashboard);
      })
      .catch((cause: unknown) => {
        if (reloadGeneration.current === generation) setError(message(cause));
      });
  };

  useEffect(reload, [props.revision, props.serverHttpBase]);

  useEffect(() => {
    const query = search.trim();
    if (query.length < 2) {
      setResults([]);
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void searchFlagAccessPlayers(props.serverHttpBase, query, controller.signal)
        .then(setResults)
        .catch(() => setResults([]));
    }, 250);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [props.serverHttpBase, search]);
  useEffect(() => setBulkConfirmation(null), [props.tab]);

  const run = async (operation: () => Promise<unknown>, success: string): Promise<void> => {
    setBusy(true);
    setError(null);
    setFeedback(null);
    try {
      await operation();
      setFeedback(success);
      reload();
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  };

  const saveAtlasShrineName = async (flagId: string): Promise<void> => {
    setBusy(true);
    setError(null);
    setFeedback(null);
    try {
      const result = await renameFlag(
        props.serverHttpBase,
        flagId,
        editingFlagName.trim(),
        props.csrfToken
      );
      if (!result.ok) throw new Error(result.message);
      reloadGeneration.current += 1;
      setDashboard((current) => current ? {
        ...current,
        flags: current.flags.map((flag) => flag.flagId === result.flag.id
          ? { ...flag, flagName: result.flag.name }
          : flag)
      } : current);
      props.onAtlasShrineRenamed?.(result.flag);
      setEditingFlagId(null);
      setFeedback("Atlas Shrine renamed.");
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  };

  if (!dashboard) {
    return <div className="empty-state" role={error ? "alert" : "status"}>
      {error ?? "Loading flag management…"}
    </div>;
  }

  if (props.tab === "atlas_shrines") {
    const atlasShrineFlags = dashboard.flags.filter((flag) =>
      Number.isInteger(flag.atlasShrineSlotNumber) &&
      (flag.atlasShrineSlotNumber ?? 0) >= 1 &&
      (flag.atlasShrineSlotNumber ?? 0) <= 25
    );
    return <section className="flag-management-section" aria-label="Atlas Shrines">
      <AtlasShrineControls
        compact
        serverHttpBase={props.serverHttpBase}
        csrfToken={props.csrfToken}
        revision={props.revision}
        {...(props.onAtlasShrineMutation
          ? { onMutation: props.onAtlasShrineMutation }
          : {})}
      />
      {dashboard.truncated
        ? <p className="kingdom-note">Showing the first bounded set of owned Atlas Shrines.</p>
        : null}
      {atlasShrineFlags.length ? <div className="flag-list">
        {atlasShrineFlags.map((flag) => <section key={flag.flagId} className="flag-list-row">
          <div className="flag-organizer-name">
            {editingFlagId === flag.flagId
              ? <input
                  aria-label="Atlas Shrine name"
                  value={editingFlagName}
                  maxLength={15}
                  onChange={(event) => setEditingFlagName(event.currentTarget.value)}
                />
              : <span>
                  <strong>{flag.flagName.trim() || "Atlas Shrine"}</strong>
                  <small>
                    {flag.areaLabel || `${flag.lat.toFixed(4)}, ${flag.lon.toFixed(4)}`}
                    {" · "}{modeLabel(flag.mode)}
                    {flag.jumpTollGold === "0" ? "" : ` · ${flag.jumpTollGold} gold`}
                  </small>
                </span>}
            {editingFlagId === flag.flagId
              ? <button disabled={busy} onClick={() =>
                  void saveAtlasShrineName(flag.flagId)
                }>Save</button>
              : <button disabled={busy} onClick={() => {
                  setEditingFlagId(flag.flagId);
                  setEditingFlagName(
                    flag.flagName.trim() ||
                    `Atlas Shrine ${flag.atlasShrineSlotNumber ?? ""}`.trim()
                  );
                }}>Rename</button>}
            <button
              disabled={busy}
              onClick={() => props.onTravelAtlasShrine(flag.flagId)}
            >
              Travel
            </button>
          </div>
        </section>)}
      </div> : <div className="empty-state">No Atlas Shrines built yet.</div>}
      <Status error={error} feedback={feedback} />
    </section>;
  }

  if (props.tab === "defaults") {
    const preferences = dashboard.preferences;
    return <section className="flag-management-section" aria-labelledby="flag-defaults-title">
      <h3 id="flag-defaults-title">New Flag Defaults</h3>
      <ThemedSelect
        label="Default access"
        value={preferences.defaultFlagAccessMode}
        options={FLAG_MODE_OPTIONS}
        disabled={busy}
        onChange={(mode: FlagAccessMode) => setDashboard({
          ...dashboard,
          preferences: { ...preferences, defaultFlagAccessMode: mode }
        })}
      />
      <label>Default Public visit price
        <input
          type="number"
          min={0}
          max={1_000_000}
          value={preferences.defaultPublicTollGold}
          onChange={(event) => setDashboard({
            ...dashboard,
            preferences: {
              ...preferences,
              defaultPublicTollGold: digits(event.currentTarget.value)
            }
          })}
        />
      </label>
      <label>Default Normal visit price
        <input
          type="number"
          min={0}
          max={1_000_000}
          value={preferences.defaultNormalTollGold}
          onChange={(event) => setDashboard({
            ...dashboard,
            preferences: {
              ...preferences,
              defaultNormalTollGold: digits(event.currentTarget.value)
            }
          })}
        />
      </label>
      <button className="panel-action" disabled={busy} onClick={() => void run(
        () => saveFlagPreferences(props.serverHttpBase, props.csrfToken, preferences),
        "Flag defaults saved."
      )}>Save Defaults</button>
      <div className="flag-management-bulk">
        <h3>Bulk Toll Tools</h3>
        {(["public", "normal"] as const).map((mode) => {
          const toll = mode === "public"
            ? preferences.defaultPublicTollGold
            : preferences.defaultNormalTollGold;
          const count = dashboard.ownedFlagCountsByMode?.[mode]
            ?? dashboard.flags.filter((flag) => flag.mode === mode).length;
          return <button key={mode} disabled={busy} onClick={() =>
            setBulkConfirmation({ mode, toll, count })
          }>Apply to all {modeLabel(mode)} flags</button>;
        })}
      </div>
      {bulkConfirmation ? <GameConfirmationPrompt
        title={`Apply ${bulkConfirmation.toll} gold to ${bulkConfirmation.count} ${modeLabel(bulkConfirmation.mode)} flag${bulkConfirmation.count === 1 ? "" : "s"}?`}
        confirmLabel={`Apply to all ${modeLabel(bulkConfirmation.mode)} flags`}
        onCancel={() => setBulkConfirmation(null)}
        onConfirm={() => {
          const { mode, toll, count } = bulkConfirmation;
          setBulkConfirmation(null);
          void run(
            () => saveBulkFlagToll(props.serverHttpBase, props.csrfToken, mode, toll),
            `Updated ${count} ${modeLabel(mode)} flag${count === 1 ? "" : "s"}.`
          );
        }}
      /> : null}
      <Status error={error} feedback={feedback} />
    </section>;
  }

  return <section className="flag-management-section" aria-labelledby="normal-passage-title">
    <h3 id="normal-passage-title">Normal Passage</h3>
    <p className="kingdom-note">A Normal grant covers all current and future Normal flags for this owner. Each flag can still charge its own toll.</p>
    <label>Find player
      <input value={search} placeholder="Search player name" onChange={(event) => setSearch(event.currentTarget.value)} />
    </label>
    {results.length ? <ul className="flag-access-search-results">
      {results.map((entry) => <li key={entry.playerId}>
        <span>{entry.playerName}</span>
        <button disabled={busy} onClick={() => void run(
          () => setNormalFlagGrant(props.serverHttpBase, props.csrfToken, entry.playerId, true),
          `${entry.playerName} has Normal passage.`
        )}>Grant passage</button>
      </li>)}
    </ul> : null}
    <h3>Current grants</h3>
    {dashboard.normalGrants.length ? <ul className="flag-access-list">
      {dashboard.normalGrants.map((entry) => <li key={entry.granteePlayerId}>
        <span><strong>{entry.granteeName}</strong><br /><small>Granted {new Date(entry.grantedAt).toLocaleString()}</small></span>
        <button disabled={busy} onClick={() => void run(
          () => setNormalFlagGrant(props.serverHttpBase, props.csrfToken, entry.granteePlayerId, false),
          `${entry.granteeName}'s Normal passage was revoked.`
        )}>Revoke</button>
      </li>)}
    </ul> : <p className="kingdom-note">No Normal passage grants.</p>}
    <h3>Pending requests</h3>
    {dashboard.normalRequests.length ? <div className="flag-passage-requests">
      {dashboard.normalRequests.map((entry) => <div key={entry.id}>
        <span>
          <strong>{entry.requesterName}</strong><br />
          <small>From {entry.sourceFlagName ?? "a Normal flag"} · Expires {new Date(entry.expiresAt).toLocaleString()}</small>
        </span>
        <button disabled={busy || !entry.sourceFlagId} onClick={() =>
          entry.sourceFlagId && void run(
            () => resolveFlagPassage(props.serverHttpBase, props.csrfToken, entry.sourceFlagId!, {
              passageRequestId: entry.id,
              action: "approve"
            }),
            `${entry.requesterName} approved.`
          )
        }>Approve</button>
        <button disabled={busy || !entry.sourceFlagId} onClick={() =>
          entry.sourceFlagId && void run(
            () => resolveFlagPassage(props.serverHttpBase, props.csrfToken, entry.sourceFlagId!, {
              passageRequestId: entry.id,
              action: "deny"
            }),
            `${entry.requesterName} denied.`
          )
        }>Deny</button>
      </div>)}
    </div> : <p className="kingdom-note">No pending Normal requests.</p>}
    <Status error={error} feedback={feedback} />
  </section>;
}

function Status({ error, feedback }: {
  error: string | null;
  feedback: string | null;
}): React.JSX.Element | null {
  if (error) return <p className="panel-error" role="alert">{error}</p>;
  if (feedback) return <p className="flag-access-feedback" role="status">{feedback}</p>;
  return null;
}

function digits(value: string): string {
  return value.replace(/[^0-9]/g, "");
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : "Flag management failed.";
}

function modeLabel(mode: FlagAccessMode): string {
  return mode[0]!.toUpperCase() + mode.slice(1);
}
