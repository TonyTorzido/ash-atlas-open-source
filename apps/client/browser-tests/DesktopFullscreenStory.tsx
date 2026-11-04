import { UiEnvironmentProvider, useUiEnvironment } from "../src/uiEnvironment.js";
import { PresentationShell } from "../src/PresentationShell.js";
import { LoginScreen } from "../src/ui/LoginScreen.js";
import { PhoneHudLayoutStory } from "./PhoneHudLayoutStory.js";
import { ChatProtectionStory } from "./ChatProtectionStory.js";
export function DesktopFullscreenStory(): React.JSX.Element {
  return <UiEnvironmentProvider><EnvironmentHud /></UiEnvironmentProvider>;
}
function EnvironmentHud(): React.JSX.Element {
  const ui = useUiEnvironment();
  return <><output data-testid="effective-viewport" style={{ position: "absolute", opacity: 0 }}>{ui.viewport.width}x{ui.viewport.height}</output>
    <PhoneHudLayoutStory presentation={ui.presentation} layoutMode={ui.layoutMode} safeAreaBottom={0} walletGold="12480" inventoryUsed={8700} inventoryTotal={1000000} />
    <select aria-label="Preview presentation" style={{ position: "absolute", top: 0, left: 400, zIndex: 99999 }} value={ui.presentationPreview} onChange={(event) => ui.setPresentationPreview(event.target.value as "auto" | "desktop" | "touch")}><option value="auto">Auto</option><option value="desktop">Desktop</option><option value="touch">Mobile</option></select>
  </>;
}
export function AuthContrastStory(): React.JSX.Element {
  return <UiEnvironmentProvider><PresentationShell><LoginScreen googleClientId="" developmentAuthEnabled busy={false} message={null} onGoogleCredential={async () => {}} onDeveloperLogin={async () => {}} /></PresentationShell></UiEnvironmentProvider>;
}
export function DesktopAtlasChatStory(): React.JSX.Element {
  return <UiEnvironmentProvider><ChatProtectionStory /></UiEnvironmentProvider>;
}
