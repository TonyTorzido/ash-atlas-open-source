import { useEffect, useState, useSyncExternalStore } from "react";

import {
  persistTapAssistancePreference,
  readTapAssistancePreference,
  type TapAssistancePreference
} from "../map/tapAssistancePreference.js";
import {
  bindNativePushSession,
  enableNativePush,
  nativePushEnabled,
  nativePushSnapshot,
  subscribeNativePush
} from "../native/nativePush.js";
import { useUiPresentation } from "../uiEnvironment.js";
import { AshAtlasBrandLogo } from "./AshAtlasBrandLogo.js";
import { DEFAULT_MENU_THEME, useMenuTheme, type MenuTheme } from "./menuTheme.js";
import { GameAppTabs } from "./GameAppShell.js";
import { useUiScale } from "./uiScale.js";

import "./PreferencesScreen.css";

const THEMES: { id: MenuTheme; label: string }[] = [
  { id: "light", label: "Light parchment" },
  { id: "dark", label: "Dark walnut" }
];
const UI_SIZES: { scale: number; label: string }[] = [
  { scale: 0.85, label: "Smaller" },
  { scale: 1, label: "Standard" },
  { scale: 1.15, label: "Larger" },
  { scale: 1.3, label: "Largest" }
];
const TAP_CHOICES: { id: TapAssistancePreference; label: string }[] = [
  { id: "precise", label: "Precise" },
  { id: "standard", label: "Standard" },
  { id: "large", label: "Large" }
];

// First screen after a new player is created. Every choice starts on its default,
// so Continue alone is always a fine answer; all of it stays in Settings later.
export function PreferencesScreen({
  playerId,
  csrfToken,
  onContinue
}: {
  playerId: string;
  csrfToken: string;
  onContinue(): void;
}): React.JSX.Element {
  const desktop = useUiPresentation() === "desktop";
  const [menuTheme, changeMenuTheme] = useMenuTheme(playerId);
  const [uiScale, changeUiScale] = useUiScale();
  const [tapAssistance, setTapAssistance] = useState(() => readTapAssistancePreference(playerId));
  const pushAvailable = nativePushEnabled();

  return (
    <main className="auth-screen preferences-screen">
      <section className="preferences-card" aria-labelledby="preferences-title">
        <header className="preferences-head">
          <AshAtlasBrandLogo className="preferences-logo" />
          <h1 id="preferences-title">Your preferences</h1>
          <p>Everything starts on our recommended setting. Change what you like, or just continue.</p>
        </header>

        <fieldset className="preferences-group">
          <legend>Color scheme</legend>
          <div className="preferences-themes">
            {THEMES.map((theme) => (
              <button
                key={theme.id}
                type="button"
                className="preferences-theme"
                data-theme-preview={theme.id}
                aria-pressed={menuTheme === theme.id}
                onClick={() => changeMenuTheme(theme.id)}
              >
                <span className="preferences-theme__swatch" aria-hidden="true">
                  <i /><i /><i />
                </span>
                <span className="preferences-theme__label">
                  {theme.label}
                  {theme.id === DEFAULT_MENU_THEME ? <small>Default</small> : null}
                </span>
              </button>
            ))}
          </div>
        </fieldset>

        {desktop ? (
          <fieldset className="preferences-group">
            <legend>Interface size</legend>
            <Segmented
              label="Interface size"
              value={uiScale}
              choices={UI_SIZES.map((size) => ({ id: size.scale, label: size.label }))}
              onChange={changeUiScale}
            />
            <p className="preferences-hint">How large menus and the HUD are drawn over the map. Standard is the default.</p>
          </fieldset>
        ) : (
          <fieldset className="preferences-group">
            <legend>Tap assistance</legend>
            <Segmented
              label="Tap assistance"
              value={tapAssistance}
              choices={TAP_CHOICES}
              onChange={(next) => setTapAssistance(persistTapAssistancePreference(playerId, next))}
            />
            <p className="preferences-hint">How forgiving taps on the map are. Standard is the default; Large makes small targets easier to hit.</p>
          </fieldset>
        )}

        {pushAvailable ? <NotificationsChoice playerId={playerId} csrfToken={csrfToken} /> : null}

        <button type="button" className="preferences-continue" autoFocus onClick={onContinue}>
          Continue
        </button>
        <p className="preferences-foot">You can change these anytime in Settings.</p>
      </section>
    </main>
  );
}

function Segmented<T extends string | number>({
  label,
  value,
  choices,
  onChange
}: {
  label: string;
  value: T;
  choices: { id: T; label: string }[];
  onChange(next: T): void;
}): React.JSX.Element {
  // The canonical compact subtabs rail, like every other secondary choice in the game.
  return (
    <GameAppTabs
      variant="subtabs"
      ariaLabel={label}
      tabs={choices.map((choice) => ({
        id: String(choice.id),
        label: choice.label
      }))}
      activeTab={String(value)}
      onChange={(id) => {
        const next = choices.find((choice) => String(choice.id) === id);
        if (next) onChange(next.id);
      }}
    />
  );
}

function NotificationsChoice({ playerId, csrfToken }: { playerId: string; csrfToken: string }): React.JSX.Element {
  // The game binds this itself once it mounts; bind early so the opt-in works here.
  useEffect(() => bindNativePushSession(playerId, csrfToken), [playerId, csrfToken]);
  const state = useSyncExternalStore(subscribeNativePush, nativePushSnapshot);
  const enabled = state.permission === "granted" && state.status?.preferences.enabled === true;
  return (
    <fieldset className="preferences-group">
      <legend>Notifications</legend>
      <p className="preferences-hint">
        Optional alerts for direct messages, invitations and packages. Off unless you turn them on.
      </p>
      {enabled ? (
        <p className="preferences-status" role="status">Notifications are on for this device.</p>
      ) : (
        <button
          type="button"
          className="preferences-secondary"
          disabled={state.busy || !state.status?.available}
          onClick={() => void enableNativePush()}
        >
          {state.busy ? "Turning on…" : "Turn on notifications"}
        </button>
      )}
      {state.error ? <p className="preferences-status" role="alert">{state.error}</p> : null}
    </fieldset>
  );
}
