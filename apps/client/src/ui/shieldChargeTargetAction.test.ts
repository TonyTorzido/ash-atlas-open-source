import { describe, expect, it, vi } from "vitest";
import { dispatchShieldChargeTargetAction, resolveShieldChargeTargetAction } from "./shieldChargeTargetAction.js";

const ready = {
  rank: 1,
  equipped: true,
  connected: true,
  actorAlive: true,
  targetAlive: true,
  targetHostile: true,
  busy: false,
  cooldownEndsAt: 0,
  now: 10_000,
  shieldEquipped: true,
  rangedStance: false
} as const;

describe("resolveShieldChargeTargetAction", () => {
  it("is hidden while Shield Charge is unlearned or not in a general-active slot", () => {
    expect(resolveShieldChargeTargetAction({ ...ready, rank: 0 }).visible).toBe(false);
    expect(resolveShieldChargeTargetAction({ ...ready, equipped: false }).visible).toBe(false);
    expect(resolveShieldChargeTargetAction(ready)).toEqual({ visible: true, enabled: true, disabledReason: null, cooldownRemainingMs: 0 });
  });

  it.each([
    [{ connected: false }, "Shield Charge is unavailable while disconnected."],
    [{ actorAlive: false }, "You must be alive to use Shield Charge."],
    [{ targetAlive: false }, "Shield Charge requires a living target."],
    [{ targetHostile: false }, "Shield Charge requires a hostile attack target."],
    [{ busy: true }, "Waiting for server confirmation."],
    [{ rangedStance: true }, "Switch to melee stance to use Shield Charge."],
    [{ shieldEquipped: false }, "Equip a Shield to use Shield Charge."]
  ] as const)("disables with an actionable reason for %o", (override, reason) => {
    expect(resolveShieldChargeTargetAction({ ...ready, ...override })).toMatchObject({ visible: true, enabled: false, disabledReason: reason });
  });

  it("uses the authoritative maximum cooldown end against synchronized time", () => {
    expect(resolveShieldChargeTargetAction({ ...ready, cooldownEndsAt: 12_400 })).toMatchObject({
      enabled: false,
      cooldownRemainingMs: 2_400,
      disabledReason: "Shield Charge is on cooldown for 3s."
    });
  });

  it("dispatches the selected presented entity directly as a hostile target", () => {
    const send = vi.fn(() => "request-1");
    expect(dispatchShieldChargeTargetAction({ revision: 7, targetEntityId: "mob:wolf-3", send })).toBe("request-1");
    expect(send).toHaveBeenCalledWith(7, "shield_charge", { targetEntityId: "mob:wolf-3", targetMode: "hostile" });
  });
});
