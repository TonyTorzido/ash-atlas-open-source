import { useState } from "react";

import { PresentationShell } from "../src/PresentationShell.js";
import { UiEnvironmentProvider, useUiEnvironment } from "../src/uiEnvironment.js";
import { LoginScreen } from "../src/ui/LoginScreen.js";
import { MobileWorldActionSheet } from "../src/ui/MobileWorldActionSheet.js";
import { PlayerNameScreen } from "../src/ui/PlayerNameScreen.js";
import { TestAccessAdminScreen } from "../src/ui/TestAccessAdminScreen.js";
import { TopBar } from "../src/ui/TopBar.js";

export type PresentationShellView = "login" | "pending" | "onboarding" | "gameplay";

export function PresentationShellStory({
  view = "gameplay",
  authorizedAdmin = false
}: {
  view?: PresentationShellView;
  authorizedAdmin?: boolean;
}): React.JSX.Element {
  return (
    <UiEnvironmentProvider>
      <PresentationShell>
        <StoryContent view={view} authorizedAdmin={authorizedAdmin} />
      </PresentationShell>
    </UiEnvironmentProvider>
  );
}

function StoryContent({
  view,
  authorizedAdmin
}: {
  view: PresentationShellView;
  authorizedAdmin: boolean;
}): React.JSX.Element {
  const environment = useUiEnvironment();
  const [adminOpen, setAdminOpen] = useState(false);
  const [actionSheetOpen, setActionSheetOpen] = useState(false);
  const [interactionCount, setInteractionCount] = useState(0);
  const [mapPoint, setMapPoint] = useState("none");
  if (view === "login") {
    return (
      <LoginScreen
        googleClientId=""
        developmentAuthEnabled={false}
        busy={false}
        message={null}
        onGoogleCredential={async () => undefined}
        onDeveloperLogin={async () => undefined}
      />
    );
  }
  if (view === "pending") {
    return (
      <main className="auth-screen">
        <section className="auth-card">
          <div className="auth-brand">Ash Atlas</div>
          <h1>Test Access Pending</h1>
          <p className="auth-copy">Your verified account is waiting for approval.</p>
        </section>
      </main>
    );
  }
  if (view === "onboarding") {
    return (
      <PlayerNameScreen
        busy={false}
        message={null}
        onSubmit={async () => undefined}
        onLogout={async () => undefined}
      />
    );
  }
  return (
    <main
      className="game-shell"
      data-testid="gameplay-root"
      data-mobile-menu-view="gameplay"
    >
      <div
        className="map-root"
        data-testid="map-root"
        onPointerDown={(event) => {
          const bounds = event.currentTarget.getBoundingClientRect();
          setMapPoint(`${Math.round(event.clientX - bounds.left)},${Math.round(event.clientY - bounds.top)}`);
          setActionSheetOpen(true);
        }}
      >
        <canvas className="game-pixi-overlay" data-testid="pixi-canvas" />
      </div>
      <div className="chat-top-bar">
        <div className="chat-top-bar-utility">
          <TopBar
            connectionStatus="online"
            username="Ranger"
            playerId="player-1"
            flagColor="#aa3300"
            colorBusy={false}
            onFlagColorChange={() => undefined}
            onOpenProfile={() => setInteractionCount((value) => value + 1)}
            {...(authorizedAdmin ? { onOpenTestAccess: () => setAdminOpen(true) } : {})}
            onLogout={() => undefined}
          />
        </div>
      </div>
      <button
        type="button"
        className="phone-bottom-bar"
        aria-label="Phone bottom navigation"
        onClick={() => setInteractionCount((value) => value + 1)}
      >
        Open menu
      </button>
      <label className="shell-story-input">
        Chat
        <input onChange={() => setInteractionCount((value) => value + 1)} />
      </label>
      <output data-testid="interaction-count">{interactionCount}</output>
      <output data-testid="map-point">{mapPoint}</output>
      {actionSheetOpen ? (
        <MobileWorldActionSheet
          displayName="Test landmark"
          primaryActionLabel="Inspect"
          primaryActionEnabled
          onPrimaryAction={() => setActionSheetOpen(false)}
          onClose={() => setActionSheetOpen(false)}
        />
      ) : null}
      {authorizedAdmin && adminOpen ? (
        <TestAccessAdminScreen
          serverHttpBase={window.location.origin}
          csrfToken="test-token"
          escapeStage={environment.layoutMode === "wide"}
          onClose={() => setAdminOpen(false)}
        />
      ) : null}
    </main>
  );
}
