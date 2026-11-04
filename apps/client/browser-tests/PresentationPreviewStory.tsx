import { UiEnvironmentProvider, useUiEnvironment } from "../src/uiEnvironment.js";
import { DeveloperPresentationControl } from "../src/ui/DeveloperToolsPanel.js";
import { PhoneHudLayoutStory } from "./PhoneHudLayoutStory.js";
import { InventoryInteractionStory } from "./InventoryInteractionStory.js";
import { PartyPolishStory } from "./InventoryPartyPolishStory.js";
import { FloatingMessagesStory } from "./MessagesNavigationStory.js";

type Surface = "inventory" | "inventory-route" | "settings" | "party" | "chat";
export function PresentationPreviewStory({ surface = "inventory" }: { surface?: Surface }): React.JSX.Element {
  return <UiEnvironmentProvider><Preview surface={surface} /></UiEnvironmentProvider>;
}
function Preview({ surface }: { surface: Surface }): React.JSX.Element {
  const ui = useUiEnvironment();
  const layout = ui.presentation === "desktop" ? "desktop" : "phone";
  return <>
    <div className="developer-tools-panel" style={{ position: "fixed", zIndex: 99999, top: 0, left: 0, width: 330 }}>
      <DeveloperPresentationControl value={ui.presentationPreview} onChange={ui.setPresentationPreview} />
    </div>
    <PhoneHudLayoutStory presentation={ui.presentation} layoutMode="wide" safeAreaBottom={0} menuView={surface === "settings" ? "miscellaneous" : "gameplay"}>
      {surface === "settings" ? null : surface === "inventory-route" ? <InventoryInteractionStory layout="phone" /> : surface === "inventory" ? <InventoryInteractionStory layout={layout} /> : surface === "party" ? <PartyPolishStory layout={layout} /> : <FloatingMessagesStory layout={layout} />}
    </PhoneHudLayoutStory>
  </>;
}
