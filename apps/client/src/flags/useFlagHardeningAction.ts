import type { FlagSnapshot } from "@ash-atlas/shared";

export type FlagHardeningAction = Readonly<{
  visible: boolean;
  label: "Harden" | "Hardening…";
  enabled: boolean;
  busy: boolean;
  disabledReason: string | null;
  error: string | null;
  harden(): void;
}>;

export function useFlagHardeningAction({
  flag,
  playerId,
  connected,
  hardening,
  anotherHardeningActive,
  approachReachable = true,
  onHarden
}: Readonly<{
  flag: FlagSnapshot | null;
  playerId: string | undefined;
  connected: boolean;
  hardening: boolean;
  anotherHardeningActive?: boolean;
  approachReachable?: boolean;
  onHarden(flagId: string): boolean;
}>): FlagHardeningAction {
  const tier = flag?.upgradeTier ?? (
    (flag?.reinforcementLevel ?? 0) === 3
      ? "tower"
      : (flag?.reinforcementLevel ?? 0) === 2
        ? "atlas_shrine"
        : (flag?.reinforcementLevel ?? 0) === 1 ? "stone" : "base"
  );
  const visible = Boolean(
    flag &&
    flag.controlType === "personal" &&
    flag.ownerId === playerId &&
    flag.developerTestTarget !== true &&
    flag.anchorKind !== "buoy" &&
    tier === "base" &&
    approachReachable
  );

  const harden = (): void => {
    if (!flag || !visible || !connected || hardening || anotherHardeningActive) return;
    onHarden(flag.id);
  };

  return {
    visible,
    label: hardening ? "Hardening…" : "Harden",
    enabled: connected && !hardening && !anotherHardeningActive,
    busy: hardening,
    disabledReason: !connected
      ? "Cannot harden a flag while disconnected."
      : anotherHardeningActive
        ? "Another flag is already being hardened."
        : null,
    error: null,
    harden
  };
}
