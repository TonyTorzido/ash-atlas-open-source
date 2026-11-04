export const PHONE_PLAYER_ACTIONS_HISTORY_KEY = "ashAtlasPhonePlayerActions";

export function clearPhonePlayerActionsHistory(): void {
  const state = window.history.state as Record<string, unknown> | null;
  if (!state || !(PHONE_PLAYER_ACTIONS_HISTORY_KEY in state)) return;
  const nextState = { ...state };
  delete nextState[PHONE_PLAYER_ACTIONS_HISTORY_KEY];
  window.history.replaceState(nextState, "");
}

export function closeAndNavigateFromPlayerActions(
  close: () => void,
  navigate: () => void
): void {
  clearPhonePlayerActionsHistory();
  close();
  navigate();
}
