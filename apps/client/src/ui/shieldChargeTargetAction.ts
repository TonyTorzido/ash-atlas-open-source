export type ShieldChargeTargetActionState = Readonly<{
  visible: boolean;
  enabled: boolean;
  disabledReason: string | null;
  cooldownRemainingMs: number;
}>;

export function resolveShieldChargeTargetAction(input: Readonly<{
  rank: number;
  /** Shield Charge occupies one of the two general-active slots. */
  equipped: boolean;
  connected: boolean;
  actorAlive: boolean;
  targetAlive: boolean;
  targetHostile: boolean;
  busy: boolean;
  cooldownEndsAt: number;
  now: number;
  shieldEquipped: boolean;
  rangedStance: boolean;
}>): ShieldChargeTargetActionState {
  if (input.rank < 1 || !input.equipped) {
    return { visible: false, enabled: false, disabledReason: null, cooldownRemainingMs: 0 };
  }
  const cooldownRemainingMs = Math.max(0, input.cooldownEndsAt - input.now);
  const disabledReason = !input.connected
    ? "Shield Charge is unavailable while disconnected."
    : !input.actorAlive
      ? "You must be alive to use Shield Charge."
      : !input.targetAlive
        ? "Shield Charge requires a living target."
        : !input.targetHostile
          ? "Shield Charge requires a hostile attack target."
          : input.busy
            ? "Waiting for server confirmation."
            : cooldownRemainingMs > 0
              ? `Shield Charge is on cooldown for ${Math.max(1, Math.ceil(cooldownRemainingMs / 1_000))}s.`
              : input.rangedStance
                ? "Switch to melee stance to use Shield Charge."
                : !input.shieldEquipped
                  ? "Equip a Shield to use Shield Charge."
                  : null;
  return { visible: true, enabled: disabledReason === null, disabledReason, cooldownRemainingMs };
}

export function dispatchShieldChargeTargetAction(input: Readonly<{
  revision: number;
  targetEntityId: string;
  send(
    expectedRevision: number,
    skillId: "shield_charge",
    options: Readonly<{ targetEntityId: string; targetMode: "hostile" }>
  ): string | null;
}>): string | null {
  return input.send(input.revision, "shield_charge", {
    targetEntityId: input.targetEntityId,
    targetMode: "hostile"
  });
}
