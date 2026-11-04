import { WAR_SURRENDER_DESTROY_PERCENT, WAR_SURRENDER_TRANSFER_PERCENT } from "@ash-atlas/shared";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { ConfirmDialog } from "./ConfirmDialog.js";
import "./OrganizationWarsSection.css";

export type OrganizationWarSide = Readonly<{ kind: "city" | "kingdom"; id: string; name: string }>;

export type OrganizationWar = Readonly<{
  warId: string;
  own: OrganizationWarSide;
  enemy: OrganizationWarSide;
  aggressor: "own" | "enemy";
  declaredVia: "settings" | "attack";
  declaredAt: string;
  peaceOffer: "own" | "enemy" | null;
  canAct: boolean;
}>;

export type OrganizationPeace = Readonly<{
  warId: string;
  own: OrganizationWarSide;
  enemy: OrganizationWarSide;
  endedReason: "surrender" | "mutual_peace";
  surrendered: "own" | "enemy" | null;
  peaceUntil: string;
}>;

type WarState = Readonly<{
  wars: OrganizationWar[];
  peaces: OrganizationPeace[];
  canDeclareAs: OrganizationWarSide[];
  serverTime: string;
}>;

type WarSurrender = Readonly<{
  settled: boolean;
  currency: "bricks" | "city_coins";
  transferred: number;
  destroyed: number;
}>;

type PendingWarAction = Readonly<{ kind: "surrender" | "offer" | "accept"; war: OrganizationWar }>;

async function warRequest<T>(serverHttpBase: string, csrfToken: string, path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(new URL(path, serverHttpBase), {
    ...init,
    credentials: "include",
    headers: {
      ...(init.body ? { "content-type": "application/json" } : {}),
      "x-csrf-token": csrfToken
    }
  });
  const payload = await response.json().catch(() => null) as { error?: { message?: string } } | null;
  if (!response.ok) throw new Error(payload?.error?.message ?? "War request failed.");
  return payload as T;
}

function sideLabel(side: Pick<OrganizationWarSide, "kind" | "name">): string {
  return side.kind === "kingdom" ? `Kingdom of ${side.name}` : `City of ${side.name}`;
}

function formatPeaceRemaining(seconds: number): string {
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m ${seconds % 60}s`;
}

/**
 * Forced-peace countdown. The server deadline is translated to the local
 * display clock once per state snapshot (serverTime offset), and the
 * remaining time is re-derived from it every second. At zero it shows
 * "Ending…" and asks the server for fresh state instead of deciding itself.
 */
function PeaceCountdown({ deadlineMs, onElapsed }: Readonly<{ deadlineMs: number; onElapsed(): void }>) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(interval);
  }, [deadlineMs]);
  const seconds = Math.max(0, Math.ceil((deadlineMs - now) / 1_000));
  const elapsedFor = useRef<number | null>(null);
  useEffect(() => {
    if (seconds > 0 || elapsedFor.current === deadlineMs) return;
    elapsedFor.current = deadlineMs;
    onElapsed();
  }, [deadlineMs, onElapsed, seconds]);
  return <>{seconds === 0 ? "Ending…" : formatPeaceRemaining(seconds)}</>;
}

function surrenderMessage(war: OrganizationWar): string {
  const unit = war.own.kind === "kingdom" ? "Bricks" : "City Coins";
  const share = war.own.kind === war.enemy.kind
    ? `${WAR_SURRENDER_TRANSFER_PERCENT}% of our treasury's ${unit} go to them and another ${WAR_SURRENDER_DESTROY_PERCENT}% are destroyed`
    : `${WAR_SURRENDER_TRANSFER_PERCENT + WAR_SURRENDER_DESTROY_PERCENT}% of our treasury's ${unit} are destroyed, because a ${war.enemy.kind} cannot hold ${unit}`;
  return `Surrender to the ${sideLabel(war.enemy)}? ${share}. A 7-day peace follows.`;
}

const PENDING_ACTION_COPY = {
  surrender: { title: "Surrender", confirmLabel: "Surrender", message: surrenderMessage },
  offer: {
    title: "Offer Peace",
    confirmLabel: "Offer Peace",
    message: (war: OrganizationWar) =>
      `Offer the ${sideLabel(war.enemy)} an end to the war with no penalty? If they accept, a 7-day peace follows.`
  },
  accept: {
    title: "Accept Peace",
    confirmLabel: "Accept Peace",
    message: (war: OrganizationWar) =>
      `Accept the peace offered by the ${sideLabel(war.enemy)}? The war ends with no penalty and a 7-day peace follows.`
  }
} as const;

/**
 * Active wars and forced peaces for one of the player's organizations, plus
 * the leader / Mayor declaration, surrender and mutual peace. War is
 * instant: there is no warm-up. Members of a city or kingdom also start a
 * war automatically by attacking another one's structure, unless a forced
 * peace holds between the two.
 */
export function OrganizationWarsSection({
  side,
  serverHttpBase,
  csrfToken,
  headingClassName,
  className
}: Readonly<{
  side: "city" | "kingdom";
  serverHttpBase: string;
  csrfToken: string;
  headingClassName?: string;
  className?: string;
}>) {
  const [state, setState] = useState<WarState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [targets, setTargets] = useState<OrganizationWarSide[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingWarAction | null>(null);
  const [clockOffsetMs, setClockOffsetMs] = useState(0);

  const applyState = useCallback((next: WarState) => {
    setState(next);
    const serverTime = Date.parse(next.serverTime);
    if (Number.isFinite(serverTime)) setClockOffsetMs(Date.now() - serverTime);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const result = await warRequest<{ state: WarState }>(serverHttpBase, csrfToken, "/api/wars");
      applyState(result.state);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Wars are unavailable.");
    }
  }, [applyState, csrfToken, serverHttpBase]);

  useEffect(() => { void refresh(); }, [refresh]);

  const declaringAs = state?.canDeclareAs.find((candidate) => candidate.kind === side) ?? null;
  const wars = useMemo(
    () => (state?.wars ?? []).filter((war) => war.own.kind === side),
    [side, state?.wars]
  );
  const peaces = useMemo(
    () => (state?.peaces ?? []).filter((peace) => peace.own.kind === side),
    [side, state?.peaces]
  );

  useEffect(() => {
    if (!declaringAs || query.trim().length < 2) {
      setTargets([]);
      return;
    }
    let active = true;
    const timer = setTimeout(() => {
      void warRequest<{ targets: OrganizationWarSide[] }>(
        serverHttpBase, csrfToken, `/api/wars/targets?q=${encodeURIComponent(query.trim())}`
      ).then((result) => {
        if (active) setTargets(result.targets);
      }).catch(() => {
        if (active) setTargets([]);
      });
    }, 250);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [csrfToken, declaringAs, query, serverHttpBase]);

  const declare = async (target: OrganizationWarSide): Promise<void> => {
    if (!declaringAs) return;
    setBusy(true);
    setNotice(null);
    try {
      const result = await warRequest<{ declared: boolean; state: WarState }>(
        serverHttpBase,
        csrfToken,
        "/api/wars/declare",
        {
          method: "POST",
          body: JSON.stringify({
            as: { kind: declaringAs.kind, id: declaringAs.id },
            target: { kind: target.kind, id: target.id }
          })
        }
      );
      applyState(result.state);
      setQuery("");
      setTargets([]);
      setNotice(result.declared ? `War declared on the ${sideLabel(target)}.` : `Already at war with the ${sideLabel(target)}.`);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "War could not be declared.");
    } finally {
      setBusy(false);
    }
  };

  const runWarAction = async ({ kind, war }: PendingWarAction): Promise<void> => {
    setBusy(true);
    setNotice(null);
    try {
      const path = kind === "surrender"
        ? "/api/wars/surrender"
        : kind === "offer" ? "/api/wars/peace/offer" : "/api/wars/peace/accept";
      const result = await warRequest<{ state: WarState; ended?: boolean; surrender?: WarSurrender }>(
        serverHttpBase,
        csrfToken,
        path,
        { method: "POST", body: JSON.stringify({ warId: war.warId, as: { kind: war.own.kind, id: war.own.id } }) }
      );
      applyState(result.state);
      setError(null);
      if (result.surrender) {
        const unit = result.surrender.currency === "bricks" ? "Bricks" : "City Coins";
        setNotice(result.surrender.transferred > 0
          ? `Surrendered. ${result.surrender.transferred.toLocaleString()} ${unit} went to the ${sideLabel(war.enemy)} and ${result.surrender.destroyed.toLocaleString()} were destroyed.`
          : `Surrendered. ${result.surrender.destroyed.toLocaleString()} ${unit} were destroyed.`);
      } else if (result.ended) {
        setNotice(`Peace made with the ${sideLabel(war.enemy)}.`);
      } else {
        setNotice(`Peace offered to the ${sideLabel(war.enemy)}.`);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The war action failed.");
    } finally {
      setPending(null);
      setBusy(false);
    }
  };

  const atWarIds = new Set(wars.map((war) => `${war.enemy.kind}:${war.enemy.id}`));
  const atPeaceIds = new Set(peaces.map((peace) => `${peace.enemy.kind}:${peace.enemy.id}`));

  return (
    <section className={`organization-wars ${className ?? ""}`} aria-labelledby={`${side}-wars-title`}>
      <h3 id={`${side}-wars-title`} className={headingClassName}>Wars</h3>
      {error ? <p className="organization-wars-error" role="alert">{error}</p> : null}
      {notice ? <p className="organization-wars-notice" role="status">{notice}</p> : null}
      {state === null && !error ? <p className="organization-wars-empty">Loading wars…</p> : null}
      {state !== null && wars.length === 0 ? (
        <p className="organization-wars-empty">
          No active wars. Attacking another city or kingdom&apos;s structure declares war on the spot, unless a peace holds.
        </p>
      ) : null}
      {wars.length > 0 ? (
        <ul className="organization-wars-list">
          {wars.map((war) => (
            <li key={war.warId} className="organization-wars-item">
              <strong>{sideLabel(war.enemy)}</strong>
              <span>
                {war.aggressor === "own" ? "Declared by us" : "Declared on us"}
                {war.declaredVia === "attack" ? " · started by an attack" : ""}
                {" · "}
                {new Date(war.declaredAt).toLocaleDateString()}
                {war.peaceOffer === "own" ? " · peace offered" : ""}
                {war.peaceOffer === "enemy" ? " · they offer peace" : ""}
              </span>
              {war.canAct ? (
                <span className="organization-wars-actions">
                  {war.peaceOffer === "enemy" ? (
                    <button
                      type="button"
                      className="panel-action"
                      disabled={busy}
                      onClick={() => setPending({ kind: "accept", war })}
                    >Accept Peace</button>
                  ) : (
                    <button
                      type="button"
                      className="panel-action"
                      disabled={busy || war.peaceOffer === "own"}
                      onClick={() => setPending({ kind: "offer", war })}
                    >{war.peaceOffer === "own" ? "Peace Offered" : "Offer Peace"}</button>
                  )}
                  <button
                    type="button"
                    className="panel-action panel-action-danger"
                    disabled={busy}
                    onClick={() => setPending({ kind: "surrender", war })}
                  >Surrender</button>
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {peaces.length > 0 ? (
        <ul className="organization-wars-list" aria-label="Forced peace">
          {peaces.map((peace) => (
            <li key={peace.warId} className="organization-wars-item organization-wars-peace">
              <strong>{sideLabel(peace.enemy)}</strong>
              <span>
                {peace.endedReason === "mutual_peace"
                  ? "Peace agreed"
                  : peace.surrendered === "own" ? "We surrendered" : "They surrendered"}
                {" · no attacks for "}
                <PeaceCountdown
                  deadlineMs={Date.parse(peace.peaceUntil) + clockOffsetMs}
                  onElapsed={() => void refresh()}
                />
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {declaringAs ? (
        <div className="organization-wars-declare">
          <label>
            Declare war on a city or kingdom
            <input
              type="search"
              value={query}
              maxLength={64}
              placeholder="Search by name"
              onChange={(event) => setQuery(event.currentTarget.value)}
            />
          </label>
          {targets.length > 0 ? (
            <ul className="organization-wars-targets">
              {targets.map((target) => {
                const key = `${target.kind}:${target.id}`;
                const atWar = atWarIds.has(key);
                const atPeace = atPeaceIds.has(key);
                return (
                  <li key={key}>
                    <span>{sideLabel(target)}</span>
                    <button
                      type="button"
                      className="panel-action panel-action-danger"
                      disabled={busy || atWar || atPeace}
                      onClick={() => void declare(target)}
                    >{atWar ? "At War" : atPeace ? "At Peace" : "Declare War"}</button>
                  </li>
                );
              })}
            </ul>
          ) : null}
        </div>
      ) : null}
      {pending ? (
        <ConfirmDialog
          title={PENDING_ACTION_COPY[pending.kind].title}
          message={PENDING_ACTION_COPY[pending.kind].message(pending.war)}
          confirmLabel={PENDING_ACTION_COPY[pending.kind].confirmLabel}
          tone={pending.kind === "surrender" ? "danger" : "primary"}
          busy={busy}
          onCancel={() => setPending(null)}
          onConfirm={() => void runWarAction(pending)}
        />
      ) : null}
    </section>
  );
}
