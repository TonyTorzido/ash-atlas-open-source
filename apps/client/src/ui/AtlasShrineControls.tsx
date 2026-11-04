import type {
  AtlasShrineProgressionSnapshot,
  FlagSnapshot
} from "@ash-atlas/shared";
import { useEffect, useState } from "react";

import {
  fetchAtlasShrineProgression,
  repairBurningStoneFlag,
  unlockNextAtlasShrineSlot,
  upgradeFlagTier,
  type AtlasShrineMutationResult
} from "../flags/atlasShrines.js";
import { GameConfirmationPrompt } from "./GameActionPrompt.js";

type Props = Readonly<{
  serverHttpBase: string;
  csrfToken: string;
  flag?: FlagSnapshot;
  canUpgrade?: boolean;
  connected?: boolean;
  compact?: boolean;
  showStoneUpgrade?: boolean;
  revision?: number;
  onMutation?(result: AtlasShrineMutationResult): void;
  onRepair?(flagId: string): boolean;
  hardening?: boolean;
  anotherHardeningActive?: boolean;
  onHarden?(flagId: string): boolean;
}>;

export function AtlasShrineControls(props: Props): React.JSX.Element {
  const [progression, setProgression] = useState<AtlasShrineProgressionSnapshot | null>(null);
  const [activeAction, setActiveAction] = useState<"unlock" | "stone" | "shrine" | "repair" | null>(null);
  const [confirmUnlock, setConfirmUnlock] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setError(null);
    void fetchAtlasShrineProgression(props.serverHttpBase, controller.signal)
      .then(setProgression)
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) {
          setError(cause instanceof Error ? cause.message : "Atlas Shrine progression is unavailable.");
        }
      });
    return () => controller.abort();
  }, [props.flag?.id, props.flag?.upgradeTier, props.revision, props.serverHttpBase]);

  const run = async (
    action: "unlock" | "stone" | "shrine" | "repair",
    operation: () => Promise<AtlasShrineMutationResult>
  ): Promise<void> => {
    setActiveAction(action);
    setError(null);
    try {
      const result = await operation();
      setProgression(result.progression);
      props.onMutation?.(result);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Atlas Shrine action failed.");
    } finally {
      setActiveAction(null);
    }
  };

  const repair = async (): Promise<void> => {
    if (!props.flag) return;
    if (props.onRepair) {
      props.onRepair(props.flag.id);
      return;
    }
    setActiveAction("repair");
    setError(null);
    try {
      const result = await repairBurningStoneFlag(
        props.serverHttpBase, props.csrfToken, props.flag.id
      );
      void result;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Flag repair failed.");
    } finally {
      setActiveAction(null);
    }
  };

  const nextSlot = progression?.nextSlot ?? null;
  const canUnlock = Boolean(
    nextSlot &&
    progression?.levelRequirementMet &&
    progression.shardRequirementMet &&
    props.connected !== false &&
    activeAction === null
  );
  const flag = props.flag;
  const tier = flag?.upgradeTier ?? (
    (flag?.reinforcementLevel ?? 0) === 3
      ? "tower"
      : (flag?.reinforcementLevel ?? 0) === 2
        ? "atlas_shrine"
        : (flag?.reinforcementLevel ?? 0) === 1 ? "stone" : "base"
  );
  const personal = flag?.controlType === "personal";
  const canConstructShrine = Boolean(
    flag &&
    personal &&
    tier === "stone" &&
    progression &&
    progression.availableCapacity > 0 &&
    progression.currentShards >= 0 &&
    props.canUpgrade &&
    props.connected !== false &&
    activeAction === null
  );

  return <><section
    className={`flag-access-card atlas-shrine-controls${props.compact ? " compact" : ""}`}
    aria-label="Atlas Shrine progression"
  >
    <h3>Atlas Shrines</h3>
    {progression ? <>
      {props.compact ? <dl className="atlas-shrine-progression-grid">
        <div><dt>Unlocked</dt><dd>{progression.unlockedSlots} / 25</dd></div>
        <div><dt>Built</dt><dd>{progression.builtShrines}</dd></div>
        <div><dt>Available</dt><dd>{progression.availableCapacity}</dd></div>
      </dl> : <p>
        <strong>Atlas Shrines unlocked: {progression.unlockedSlots} / 25</strong><br />
        Atlas Shrines currently built: {progression.builtShrines} / {progression.unlockedSlots}<br />
        Available shrine capacity: {progression.availableCapacity}
      </p>}
      {nextSlot ? <p className="kingdom-note">
        Slot {nextSlot} requires level {progression.requiredLevel} and {progression.requiredShards} Atlas Shrine
        Shard{progression.requiredShards === 1 ? "" : "s"}. You have level {progression.playerLevel} and{" "}
        {progression.currentShards} shard{progression.currentShards === 1 ? "" : "s"}. Level:{" "}
        {progression.levelRequirementMet ? "met" : "not met"}. Shards:{" "}
        {progression.shardRequirementMet ? "met" : "not met"}.
      </p> : <p className="kingdom-note">All 8 Atlas Shrine slots are unlocked.</p>}
      {nextSlot ? <button
        type="button"
        className="panel-action"
        disabled={!canUnlock}
        onClick={() => setConfirmUnlock(true)}
      >{activeAction === "unlock" ? "Unlocking…" : `Unlock Slot ${nextSlot}`}</button> : null}
    </> : <p>Loading shrine progression…</p>}
    {props.showStoneUpgrade !== false && flag && props.canUpgrade && tier === "base" &&
      flag.controlType !== "city_seat" && flag.controlType !== "kingdom_seat" ? <button
        type="button"
        className="panel-action"
        disabled={activeAction !== null || props.hardening === true ||
          props.anotherHardeningActive === true || props.connected === false}
        title={props.anotherHardeningActive
          ? "Another flag is already being hardened."
          : undefined}
        onClick={() => props.onHarden?.(flag.id)}
      >{props.hardening ? "Hardening…" : "Build Stone Flag · 5 Stone"}</button> : null}
    {flag && tier === "stone" && personal ? <button
      type="button"
      className="panel-action"
      disabled={!canConstructShrine}
      title={progression?.availableCapacity === 0
        ? "Unlock an available Atlas Shrine slot first."
        : undefined}
      onClick={() => void run("shrine", () =>
        upgradeFlagTier(props.serverHttpBase, props.csrfToken, flag.id, "atlas_shrine")
      )}
    >{activeAction === "shrine" ? "Constructing…" : "Build Atlas Shrine · 12 Wood + 8 Stone"}</button> : null}
    {flag && tier === "stone" && personal && flag.burning ? <button
      type="button"
      className="panel-action"
      disabled={activeAction !== null || props.connected === false}
      onClick={() => void repair()}
    >{activeAction === "repair" ? "Repairing…" : "Repair and extinguish Stone Flag"}</button> : null}
    {flag && tier === "stone" && !personal ? <p className="kingdom-note">
      City and Kingdom Flags remain stone flags and cannot become Atlas Shrines.
    </p> : null}
    {flag && tier === "atlas_shrine" ? <p className="kingdom-note">
      Atlas Shrine · owner-only World Map destination
    </p> : null}
    {error ? <p className="panel-error" role="alert">{error}</p> : null}
  </section>
  {confirmUnlock && nextSlot ? <GameConfirmationPrompt
    title={`Permanently unlock Atlas Shrine slot ${nextSlot}?`}
    detail={`This consumes ${nextSlot} Atlas Shrine Shard${nextSlot === 1 ? "" : "s"}.`}
    confirmLabel={`Unlock Slot ${nextSlot}`}
    destructive
    onCancel={() => setConfirmUnlock(false)}
    onConfirm={() => {
      setConfirmUnlock(false);
      void run("unlock", () =>
        unlockNextAtlasShrineSlot(props.serverHttpBase, props.csrfToken)
      );
    }}
  /> : null}</>;
}
