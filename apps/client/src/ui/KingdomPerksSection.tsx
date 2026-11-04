import {
  BRICKS_ITEM_ID,
  GLIMMER_OIL_ITEM_ID,
  KINGDOM_PERK_CHANGE_COST,
  KINGDOM_PERK_CHOOSE_COST,
  KINGDOM_PERK_LEVELS,
  kingdomPerkIsInert,
  kingdomPerksForLevel,
  type KingdomPerkLevel,
  type KingdomPerkState,
  type KingdomStateSnapshot
} from "@ash-atlas/shared";
import React, { useEffect, useState } from "react";

import { hasPermission } from "../kingdom/kingdomPanelModel.js";

export type KingdomPerkChoiceRequest = Readonly<{
  perk: KingdomPerkState;
  currentPerk: KingdomPerkState | null;
  bricks: number;
  glimmerOil: number;
}>;

function treasuryQuantity(snapshot: KingdomStateSnapshot, resourceType: string): number {
  return snapshot.treasury.find((balance) =>
    balance.resourceType === resourceType && (balance.variant ?? "default") === "default"
  )?.quantity ?? 0;
}

function useNow(enabled: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return undefined;
    const interval = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(interval);
  }, [enabled]);
  return now;
}

function formatRemaining(ms: number): string {
  const totalMinutes = Math.max(0, Math.ceil(ms / 60_000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0 ? `${hours} h ${minutes} min` : `${minutes} min`;
}

/**
 * Perks tab: levels 2-8, four cards each. The chosen perk of a level is
 * highlighted; choosing or changing goes through the panel's confirmation
 * prompt with the exact treasury price. Effects that are not built yet are
 * labelled "Coming soon"; the server never applies them.
 */
export function KingdomPerksSection({
  snapshot,
  connected,
  busy,
  onChoose,
  onActivate
}: {
  snapshot: KingdomStateSnapshot;
  connected: boolean;
  busy: boolean;
  onChoose(request: KingdomPerkChoiceRequest): void;
  onActivate(perk: KingdomPerkState): void;
}): React.JSX.Element {
  const progression = snapshot.progression;
  const selections = progression?.perkSelections ?? [];
  const runningBuff = selections.some((selection) => selection.activeUntil !== null || selection.nextActivationAt !== null);
  const now = useNow(runningBuff);
  if (!progression) return <div className="kingdom-empty">Kingdom perks are unavailable.</div>;
  const mayManage = hasPermission(snapshot.permissions, "manage_perks");
  const bricks = treasuryQuantity(snapshot, BRICKS_ITEM_ID);
  const glimmerOil = treasuryQuantity(snapshot, GLIMMER_OIL_ITEM_ID);
  const perksForLevel = (level: KingdomPerkLevel) => progression.perks.filter((perk) => perk.level === level);
  return (
    <div className="kingdom-stack">
      <article className="kingdom-card">
        <p className="kingdom-section-label">Kingdom perks</p>
        <p>
          One perk per level. Choosing costs {KINGDOM_PERK_CHOOSE_COST.bricks.toLocaleString()} Bricks and{" "}
          {KINGDOM_PERK_CHOOSE_COST.glimmerOil.toLocaleString()} Glimmer Oil from the treasury; changing a chosen perk
          costs {KINGDOM_PERK_CHANGE_COST.bricks.toLocaleString()} Bricks and{" "}
          {KINGDOM_PERK_CHANGE_COST.glimmerOil.toLocaleString()} Glimmer Oil.
        </p>
        <dl className="kingdom-facts">
          <dt>Treasury Bricks</dt><dd>{bricks.toLocaleString()}</dd>
          <dt>Treasury Glimmer Oil</dt><dd>{glimmerOil.toLocaleString()}</dd>
        </dl>
        {!mayManage ? <p className="kingdom-note">Only the leader chooses kingdom perks.</p> : null}
        <p className="kingdom-note">
          Members benefit after the qualification period ({Math.round(snapshot.perkQualificationSeconds / 3600)} h).
        </p>
      </article>
      {KINGDOM_PERK_LEVELS.map((level) => {
        const perks = perksForLevel(level);
        const unlocked = progression.level >= level;
        const selection = selections.find((candidate) => candidate.level === level) ?? null;
        const currentPerk = selection ? perks.find((perk) => perk.id === selection.perkId) ?? null : null;
        const cost = currentPerk ? KINGDOM_PERK_CHANGE_COST : KINGDOM_PERK_CHOOSE_COST;
        const affordable = bricks >= cost.bricks && glimmerOil >= cost.glimmerOil;
        if (kingdomPerksForLevel(level).length === 0) {
          return (
            <article className="kingdom-card kingdom-perk-level-locked" key={level}>
              <div className="kingdom-card-heading">
                <h3>Level {level}</h3>
                <span className="kingdom-chip">No perks yet</span>
              </div>
              <p className="kingdom-note">Perks for this level are coming soon.</p>
            </article>
          );
        }
        return (
          <article className={unlocked ? "kingdom-card" : "kingdom-card kingdom-perk-level-locked"} key={level}>
            <div className="kingdom-card-heading">
              <h3>Level {level}</h3>
              <span className="kingdom-chip">
                {!unlocked ? `Unlocks at kingdom level ${level}` : currentPerk ? currentPerk.displayName : "No perk chosen"}
              </span>
            </div>
            <div className="kingdom-perk-grid">
              {perks.map((perk) => (
                <PerkCard
                  key={perk.id}
                  perk={perk}
                  chosen={currentPerk?.id === perk.id}
                  actionLabel={currentPerk ? "Change to this" : "Choose"}
                  costLabel={`${cost.bricks.toLocaleString()} Bricks + ${cost.glimmerOil.toLocaleString()} Glimmer Oil`}
                  disabled={!connected || busy || !mayManage || !unlocked || !affordable}
                  showAction={mayManage && unlocked}
                  onChoose={() => onChoose({ perk, currentPerk, bricks: cost.bricks, glimmerOil: cost.glimmerOil })}
                  activation={perk.activated && currentPerk?.id === perk.id ? {
                    activeUntilMs: selection?.activeUntil ? Date.parse(selection.activeUntil) : null,
                    readyAtMs: selection?.nextActivationAt ? Date.parse(selection.nextActivationAt) : null,
                    now,
                    canActivate: connected && !busy && mayManage,
                    onActivate: () => onActivate(perk)
                  } : null}
                />
              ))}
            </div>
            {mayManage && unlocked && !affordable ? (
              <p className="kingdom-note">The treasury needs {cost.bricks.toLocaleString()} Bricks and {cost.glimmerOil.toLocaleString()} Glimmer Oil.</p>
            ) : null}
          </article>
        );
      })}
    </div>
  );
}

function PerkCard({
  perk,
  chosen,
  actionLabel,
  costLabel,
  disabled,
  showAction,
  onChoose,
  activation
}: {
  perk: KingdomPerkState;
  chosen: boolean;
  actionLabel: string;
  costLabel: string;
  disabled: boolean;
  showAction: boolean;
  onChoose(): void;
  activation: {
    activeUntilMs: number | null;
    readyAtMs: number | null;
    now: number;
    canActivate: boolean;
    onActivate(): void;
  } | null;
}): React.JSX.Element {
  const inert = kingdomPerkIsInert(perk);
  const status = chosen
    ? perk.activated
      ? activation?.activeUntilMs && activation.activeUntilMs > activation.now ? "Buff running" : "Chosen"
      : perk.qualified ? "Active" : "Chosen, qualifying"
    : perk.unlocked ? "Available" : "Locked";
  const buffRunning = activation?.activeUntilMs != null && activation.activeUntilMs > activation.now;
  const cooling = activation?.readyAtMs != null && activation.readyAtMs > activation.now;
  return (
    <div className={chosen ? "kingdom-perk active" : "kingdom-perk"} aria-current={chosen ? "true" : undefined}>
      <div><strong>{perk.displayName}</strong><span>{status}</span></div>
      <p>{perk.description}</p>
      <ul className="kingdom-perk-effects">
        {perk.effects.map((line) => (
          <li key={line.text} className={line.live ? undefined : "coming-soon"}>
            {line.text}
            {line.live ? null : <span className="kingdom-perk-soon">Coming soon</span>}
          </li>
        ))}
      </ul>
      {activation ? (
        <>
          {buffRunning ? <small>Buff ends in {formatRemaining(activation.activeUntilMs! - activation.now)}.</small> : null}
          {!buffRunning && cooling ? <small>Ready again in {formatRemaining(activation.readyAtMs! - activation.now)}.</small> : null}
          <button
            type="button"
            className="kingdom-primary"
            disabled={!activation.canActivate || cooling}
            onClick={activation.onActivate}
          >
            Activate for 24 h
          </button>
        </>
      ) : null}
      {showAction && !chosen ? (
        <>
          <small>{costLabel}{inert ? " (effect coming soon)" : ""}</small>
          <button type="button" className="kingdom-secondary" disabled={disabled} onClick={onChoose}>
            {actionLabel}
          </button>
        </>
      ) : null}
    </div>
  );
}

export function kingdomPerkChoiceMessage(request: KingdomPerkChoiceRequest): string {
  const price = `${request.bricks.toLocaleString()} Bricks and ${request.glimmerOil.toLocaleString()} Glimmer Oil`;
  const comingSoon = kingdomPerkIsInert(request.perk)
    ? ` Its effect is not built yet and starts working when it ships.`
    : "";
  return request.currentPerk
    ? `${request.currentPerk.displayName} stops working and ${request.perk.displayName} replaces it. The treasury pays ${price}.${comingSoon}`
    : `${request.perk.displayName} becomes this level's perk. The treasury pays ${price}.${comingSoon}`;
}
