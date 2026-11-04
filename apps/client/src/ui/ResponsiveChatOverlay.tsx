import { MobileChatOverlay, type MobileChatOverlayProps } from "../mobileKeyboardDocking.js";
import { useUiPresentation, type UiPresentation } from "../uiEnvironment.js";
import { DesktopWindow } from "./DesktopWindow.js";
export { DesktopWindowTitle } from "./DesktopWindow.js";

/** Desktop shares app-window geometry; touch keeps the keyboard-safe overlay. */
export function ResponsiveChatOverlay({ presentation, ...props }: MobileChatOverlayProps & { presentation?: UiPresentation }): React.JSX.Element | null {
  const environment = useUiPresentation();
  return (presentation ?? environment) === "desktop" ? <DesktopChatWindow {...props} /> : <MobileChatOverlay {...props} />;
}

function DesktopChatWindow({ open, type, onProtectionFailure: _onProtectionFailure, manageHistory: _manageHistory, className, ...props }: MobileChatOverlayProps): React.JSX.Element | null {
  // These callbacks belong only to the touch overlay, never to the DOM frame.
  void _onProtectionFailure;
  void _manageHistory;
  if (!open) return null;
  return <DesktopWindow {...props} windowKey={`chat:${type}`} minimized={className?.includes("--minimized") ?? false}
    className={`desktop-chat-window ${className ?? ""}`} data-chat-window={type} />;
}
