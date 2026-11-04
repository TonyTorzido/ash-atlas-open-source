export type NativeBackState = Readonly<{
  keyboardOpen: boolean;
  modalOpen: boolean;
  chatOpen: boolean;
  /** The open screen shows its own Back button (a step back, not Return to Game). */
  screenBackAvailable?: boolean;
  /** A full-screen phone app is open; with no Back button its only exit is closing it. */
  appOpen?: boolean;
  menuView: string;
  canGoBack: boolean;
}>;

export type NativeBackAction =
  | "dismiss-keyboard"
  | "close-modal"
  | "close-chat"
  | "screen-back"
  | "menu-back"
  | "close-menu"
  | "confirm-exit"
  | "ignore";

/** Android back follows the same dismissal order as the web escape affordance. */
export function resolveNativeBackAction(state: NativeBackState): NativeBackAction {
  if (state.keyboardOpen) return "dismiss-keyboard";
  if (state.modalOpen) return "close-modal";
  if (state.chatOpen) return "close-chat";
  if (state.screenBackAvailable) return "screen-back";
  if (state.appOpen) return "close-modal";
  if (state.menuView !== "gameplay" && state.canGoBack) return "menu-back";
  if (state.menuView !== "gameplay") return "close-menu";
  return "confirm-exit";
}
