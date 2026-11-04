import { structureWarfareProfileForFlag, type FlagSnapshot } from "@ash-atlas/shared";
import { useEffect, useState } from "react";

import { repairBurningStoneFlag } from "./atlasShrines.js";
import type { FlagPresentationAllies } from "./flagDisplay.js";

export type FlagRepairAction = Readonly<{
  visible: boolean;
  label: "Repair Flag" | "Repairing…";
  enabled: boolean;
  busy: boolean;
  repairing: boolean;
  disabledReason: string | null;
  error: string | null;
  repair(): void;
  cancel(): void;
}>;

export function useFlagRepairAction({
  flag,
  playerId,
  connected,
  serverHttpBase,
  csrfToken,
  onFlagSnapshot,
  onRepair,
  repairing = false,
  onCancel,
  allies,
}: Readonly<{
  flag: FlagSnapshot | null;
  playerId: string | undefined;
  connected: boolean;
  serverHttpBase: string;
  csrfToken: string;
  onFlagSnapshot?(flag: FlagSnapshot): void;
  onRepair?(flagId: string): boolean;
  repairing?: boolean;
  onCancel?(flagId: string): void;
  /** The viewer's own city / kingdom: members repair their structures. */
  allies?: FlagPresentationAllies;
}>): FlagRepairAction {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tier = flag?.upgradeTier ?? (
    (flag?.reinforcementLevel ?? 0) === 3
      ? "tower"
      : (flag?.reinforcementLevel ?? 0) === 2
        ? "atlas_shrine"
        : (flag?.reinforcementLevel ?? 0) === 1 ? "stone" : "base"
  );
  const profile = flag
    ? structureWarfareProfileForFlag({
        controlType: flag.controlType,
        anchorKind: flag.anchorKind ?? "flag",
        systemControlled: flag.systemControlled === true,
        cityId: flag.cityId ?? null,
        kingdomId: flag.kingdomId ?? null,
        reinforcementLevel: tier === "tower" ? 3 : tier === "atlas_shrine" ? 2 : tier === "stone" ? 1 : 0
      })
    : null;
  const organizationMember = Boolean(
    profile?.organization && flag && (
      (flag.cityId && flag.cityId === allies?.cityId) ||
      (flag.kingdomId && flag.kingdomId === allies?.kingdomId)
    )
  );
  // Progressive repair: any damaged repairable structure (burning or not)
  // that the viewer owns, or that belongs to the viewer's city / kingdom.
  const visible = Boolean(
    flag && profile?.repairable &&
    (profile.organization
      ? organizationMember
      : flag.ownerId === playerId && flag.developerTestTarget !== true) &&
    ((flag.health !== undefined && flag.health !== null && flag.health > 0 &&
      flag.health < profile.maximumHealth) || repairing) &&
    flag.legendaryBirdSpecies == null
  );

  useEffect(() => {
    setBusy(false);
    setError(null);
  }, [flag?.id]);

  const repair = (): void => {
    if (!flag || !visible || !connected || busy || repairing) return;
    if (onRepair) {
      onRepair(flag.id);
      return;
    }
    setBusy(true);
    setError(null);
    void repairBurningStoneFlag(serverHttpBase, csrfToken, flag.id)
      .then((result) => onFlagSnapshot?.(result.flag))
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : "Flag repair failed.");
      })
      .finally(() => setBusy(false));
  };

  const cancel = (): void => {
    if (!flag || !visible || !repairing) return;
    onCancel?.(flag.id);
  };

  return {
    visible,
    label: busy || repairing ? "Repairing…" : "Repair Flag",
    enabled: connected && !busy && !repairing,
    busy: busy || repairing,
    repairing,
    disabledReason: !connected
      ? "Cannot repair a flag while disconnected."
      : null,
    error,
    repair,
    cancel,
  };
}
