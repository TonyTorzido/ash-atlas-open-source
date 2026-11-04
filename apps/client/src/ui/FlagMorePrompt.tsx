import type {
  AtlasShrineProgressionSnapshot,
  FlagAccessMode,
  FlagAccessSnapshot,
  FlagSnapshot
} from "@ash-atlas/shared";
import {
  formatStructureWarfareDuration,
  structureWarfareBreachThresholdForReinforcementLevel,
  structureWarfareBurnDurationForReinforcementLevel
} from "@ash-atlas/shared";
import { useEffect, useId, useRef, useState } from "react";

import {
  fetchAtlasShrineProgression,
  unlockNextAtlasShrineSlot,
  upgradeFlagTier,
  type AtlasShrineMutationResult
} from "../flags/atlasShrines.js";
import { saveFlagAccess } from "../flags/flagAccess.js";
import { damagedHealthLabel } from "../combat/healthBarPresentation.js";
import {
  GameActionPrompt,
  GameConfirmationPrompt,
  GamePromptButton
} from "./GameActionPrompt.js";

const ACCESS_MODES: readonly FlagAccessMode[] = ["public", "normal", "private"];

type Props = Readonly<{
  flag: FlagSnapshot;
  access?: FlagAccessSnapshot | null;
  displayName: string;
  serverHttpBase?: string;
  csrfToken?: string;
  connected: boolean;
  showManagement?: boolean;
  onAttack?(): void;
  onBurn?(): void;
  deleting?: boolean;
  onAccessSaved?(access: FlagAccessSnapshot): void;
  onAtlasShrineMutation?(result: AtlasShrineMutationResult): void;
  onDestroy?(): void;
  onClose(): void;
}>;

export function FlagMorePrompt(props: Props): React.JSX.Element {
  const showManagement = props.showManagement !== false;
  const access = props.access ?? null;
  const serverHttpBase = props.serverHttpBase ?? window.location.origin;
  const csrfToken = props.csrfToken ?? "";
  const [progression, setProgression] = useState<AtlasShrineProgressionSnapshot | null>(null);
  const [progressionError, setProgressionError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"access" | "upgrade" | "destroy" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<"unlock" | "destroy" | "burn" | null>(null);
  const operationInFlightRef = useRef(false);
  const deleteStartedRef = useRef(false);
  const reasonId = useId();
  const isBuoy = props.flag.anchorKind === "buoy";
  const tier = props.flag.upgradeTier ?? (
    (props.flag.reinforcementLevel ?? 0) === 3
      ? "tower"
      : (props.flag.reinforcementLevel ?? 0) === 2
        ? "atlas_shrine"
        : (props.flag.reinforcementLevel ?? 0) === 1 ? "stone" : "base"
  );
  const showUpgrade = showManagement && !isBuoy && tier !== "atlas_shrine" && tier !== "tower";
  const healthLabel = damagedHealthLabel(props.flag.health, props.flag.maximumHealth);
  const reinforcementLevel = typeof props.flag.reinforcementLevel === "number"
    ? props.flag.reinforcementLevel
    : tier === "tower"
      ? 3
      : tier === "atlas_shrine"
        ? 2
        : tier === "stone"
          ? 1
          : 0;
  const burnThreshold = structureWarfareBreachThresholdForReinforcementLevel(reinforcementLevel) ?? 100;

  useEffect(() => {
    if (!showUpgrade) return;
    const controller = new AbortController();
    setProgression(null);
    setProgressionError(null);
    void fetchAtlasShrineProgression(serverHttpBase, controller.signal)
      .then(setProgression)
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) {
          setProgressionError(cause instanceof Error
            ? cause.message
            : "Atlas Shrine progression is unavailable.");
        }
      });
    return () => controller.abort();
  }, [props.flag.id, serverHttpBase, showUpgrade]);

  useEffect(() => {
    if (busy !== "destroy") {
      deleteStartedRef.current = false;
      return;
    }
    if (props.deleting === true) {
      deleteStartedRef.current = true;
      return;
    }
    if (!deleteStartedRef.current || props.deleting !== false) return;
    operationInFlightRef.current = false;
    deleteStartedRef.current = false;
    setBusy(null);
  }, [busy, props.deleting]);

  const upgradeReason = resolveUpgradeDisabledReason({
    connected: props.connected,
    tier,
    burning: props.flag.burning === true,
    progression,
    progressionError,
    busy
  });
  const shardDetail = progression
    ? progression.availableCapacity > 0
      ? "Slot ready"
      : progression.requiredShards === null
        ? `${progression.builtShrines}/${progression.unlockedSlots} built`
        : `${progression.currentShards}/${progression.requiredShards} shards`
    : null;

  const saveMode = async (mode: FlagAccessMode): Promise<void> => {
    if (operationInFlightRef.current || !access || mode === access.mode) return;
    operationInFlightRef.current = true;
    setBusy("access");
    setError(null);
    try {
      const nextAccess = await saveFlagAccess(
        serverHttpBase,
        csrfToken,
        props.flag.id,
        {
          mode,
          jumpTollGold: mode === "private" ? "0" : access.jumpTollGold
        }
      );
      props.onAccessSaved?.(nextAccess);
      props.onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Flag access update failed.");
    } finally {
      operationInFlightRef.current = false;
      setBusy(null);
    }
  };

  const upgrade = async (unlockFirst: boolean): Promise<void> => {
    if (operationInFlightRef.current || !progression) return;
    operationInFlightRef.current = true;
    setConfirmation(null);
    setBusy("upgrade");
    setError(null);
    try {
      if (unlockFirst) {
        const unlockResult = await unlockNextAtlasShrineSlot(
          serverHttpBase,
          csrfToken
        );
        setProgression(unlockResult.progression);
        props.onAtlasShrineMutation?.(unlockResult);
      }
      const upgradeResult = await upgradeFlagTier(
        serverHttpBase,
        csrfToken,
        props.flag.id,
        "atlas_shrine"
      );
      setProgression(upgradeResult.progression);
      props.onAtlasShrineMutation?.(upgradeResult);
      props.onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Atlas Shrine upgrade failed.");
    } finally {
      operationInFlightRef.current = false;
      setBusy(null);
    }
  };

  if (!showManagement) {
    if (confirmation === "burn" && props.onBurn) {
      return <GameConfirmationPrompt
        title="Burn this Flag?"
        category="FLAG BURN"
        detail={`Burning this ${isBuoy ? "Buoy" : tier === "atlas_shrine" ? "Atlas Shrine" : tier === "base" ? "Flag" : "bastion Flag"} takes ${formatStructureWarfareDuration(
          structureWarfareBurnDurationForReinforcementLevel(reinforcementLevel) ?? 14_000
        )}, consumes 1 Torch, and creates an enemy relationship.`}
        confirmLabel="Burn Flag"
        destructive
        confirmEnabled={props.connected}
        disabledReason={props.connected ? null : "Burning a Flag requires an online connection."}
        onCancel={() => setConfirmation(null)}
        onConfirm={() => {
          setConfirmation(null);
          props.onBurn?.();
        }}
      />;
    }
    return <GameActionPrompt
      title={props.displayName}
      category="FLAG OPTIONS"
      detail={healthLabel
        ? `${healthLabel} · Attack bastion Flags to ${burnThreshold} HP before burning them. Burning destroys the Flag and frees its territory.`
        : `Attack bastion Flags to ${burnThreshold} HP before burning them. Burning destroys the Flag and frees its territory.`}
      actions={[
        ...(props.onAttack ? [{
          key: "attack",
          label: "Attack Flag",
          enabled: props.connected,
          disabledReason: props.connected ? null : "Reconnect to attack this Flag.",
          tone: "danger" as const,
          onSelect: props.onAttack
        }] : []),
        ...(props.onBurn ? [{
          key: "burn",
          label: "Burn Flag · 1 Torch",
          enabled: props.connected,
          disabledReason: props.connected ? null : "Reconnect to burn this Flag.",
          tone: "danger" as const,
          onSelect: () => {
            props.onBurn?.();
            props.onClose();
          }
        }] : [])
      ]}
      onCancel={props.onClose}
    />;
  }

  if (!access) {
    return <GameActionPrompt
      title={props.displayName}
      category="FLAG OPTIONS"
      detail={healthLabel}
      message={{ text: "Flag access is still loading.", tone: "muted" }}
      actions={[]}
      onCancel={props.onClose}
    />;
  }

  if (confirmation === "destroy" && props.onDestroy) {
    return <GameConfirmationPrompt
      title={`Destroy this ${isBuoy ? "buoy" : "flag"}?`}
      category="PERMANENT ACTION"
      detail={`This permanently removes the ${isBuoy ? "buoy" : "flag"} and cannot be undone.`}
      confirmLabel={props.deleting || busy === "destroy"
        ? "Destroying…"
        : `Destroy ${isBuoy ? "Buoy" : "Flag"}`}
      busy={props.deleting === true || busy === "destroy"}
      destructive
      onCancel={() => setConfirmation(null)}
      onConfirm={() => {
        if (operationInFlightRef.current || props.deleting) return;
        operationInFlightRef.current = true;
        setBusy("destroy");
        props.onDestroy?.();
      }}
    />;
  }

  if (confirmation === "unlock" && progression?.nextSlot) {
    const requiredShards = progression.requiredShards ?? progression.nextSlot;
    return <GameConfirmationPrompt
      title={`Permanently unlock Atlas Shrine slot ${progression.nextSlot}?`}
      detail={`This permanently consumes ${requiredShards} Atlas Shrine Shards, 12 Wood and 8 Stone.`}
      confirmLabel="Unlock and Upgrade"
      destructive
      onCancel={() => setConfirmation(null)}
      onConfirm={() => void upgrade(true)}
    />;
  }

  return <GameActionPrompt
    title={props.displayName}
    category={isBuoy ? "BUOY OPTIONS" : "FLAG OPTIONS"}
    detail={healthLabel}
    message={error ? { text: error, tone: "error" } : null}
    content={<div className="flag-more-content">
      {showUpgrade && (upgradeReason === null || busy === "upgrade") ? <div className="game-compact-action flag-more-upgrade">
        <GamePromptButton
          disabled={upgradeReason !== null}
          aria-busy={busy === "upgrade"}
          aria-describedby={[
            shardDetail ? `${reasonId}-shards` : null
          ].filter(Boolean).join(" ") || undefined}
          onClick={() => {
            if (!progression || upgradeReason) return;
            if (progression.availableCapacity > 0) void upgrade(false);
            else setConfirmation("unlock");
          }}
        >{busy === "upgrade" ? "Upgrading…" : "Upgrade to Atlas Shrine"}</GamePromptButton>
        {shardDetail ? <small id={`${reasonId}-shards`} className="flag-more-shards">
          {shardDetail}
        </small> : null}
      </div> : null}
      <fieldset className="flag-more-access" disabled={busy !== null}>
        <legend>Access</legend>
        <div className="flag-more-access-options">
          {ACCESS_MODES.filter((mode) => mode !== access.mode).map((mode) => <GamePromptButton
            key={mode}
            aria-busy={busy === "access"}
            disabled={busy !== null}
            onClick={() => void saveMode(mode)}
          >{mode[0]!.toUpperCase() + mode.slice(1)}</GamePromptButton>)}
        </div>
      </fieldset>
    </div>}
    actions={props.onDestroy ? [{
      key: "destroy",
      label: props.deleting ? "Destroying…" : `Destroy ${isBuoy ? "Buoy" : "Flag"}`,
      enabled: busy === null && !props.deleting,
      busy: props.deleting === true || busy !== null,
      tone: "danger",
      onSelect: () => setConfirmation("destroy")
    }] : []}
    onCancel={props.onClose}
  />;
}

function resolveUpgradeDisabledReason(input: Readonly<{
  connected: boolean;
  tier: string;
  burning: boolean;
  progression: AtlasShrineProgressionSnapshot | null;
  progressionError: string | null;
  busy: "access" | "upgrade" | "destroy" | null;
}>): string | null {
  if (input.busy) return "Another flag action is in progress.";
  if (!input.connected) return "Reconnect to upgrade.";
  if (input.tier === "base") return "Build the Stone Flag first.";
  if (input.burning) return "Repair and extinguish the flag first.";
  if (input.progressionError) return input.progressionError;
  if (!input.progression) return "Loading shrine progression…";
  if (input.progression.availableCapacity > 0) return null;
  if (input.progression.nextSlot === null) return "No Atlas Shrine capacity is available.";
  if (!input.progression.levelRequirementMet) {
    return `Requires level ${input.progression.requiredLevel}.`;
  }
  if (!input.progression.shardRequirementMet) {
    return `Requires ${input.progression.requiredShards} Atlas Shrine Shards.`;
  }
  return null;
}
