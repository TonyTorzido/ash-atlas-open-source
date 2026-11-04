// Relocate during a cooldown: the server may still allow some moves (it says
// so with relocationExemptionAvailable) and decides each request itself, so
// the client only blocks when no exemption can apply.
export function relocationCooldownBlocksRelocate(
  cooldownSeconds: number,
  exemptionAvailable: boolean
): boolean {
  return cooldownSeconds > 0 && !exemptionAvailable;
}

// Web client while the server enforces phone-only relocation (session
// `trustRelocationPhoneOnly`): Relocate is shown as a phone-app state, not a button that fails.
export const RELOCATE_PHONE_ONLY_LABEL = "Relocate from the Ash Atlas app on your phone";
export const RELOCATE_PHONE_ONLY_MESSAGE =
  "Relocating uses your phone's location. Open the Ash Atlas app on your phone to move your home.";
