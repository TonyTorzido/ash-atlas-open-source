import {
  PERSONAL_FLAG_COLORS,
  PERSONAL_FLAG_COLOR_HEX,
  type PersonalFlagColor
} from "@ash-atlas/shared";
import { useState } from "react";

import { AshAtlasBrandLogo } from "./AshAtlasBrandLogo.js";

type PlayerNameScreenProps = {
  busy: boolean;
  message: string | null;
  onSubmit(displayName: string, personalFlagColor: PersonalFlagColor): Promise<void>;
  onLogout(): Promise<void>;
};

export function PlayerNameScreen({
  busy,
  message,
  onSubmit,
  onLogout
}: PlayerNameScreenProps): React.JSX.Element {
  const [displayName, setDisplayName] = useState("");
  const [personalFlagColor, setPersonalFlagColor] =
    useState<PersonalFlagColor | null>(null);
  const nameValid = /^[A-Za-z]{3,20}$/.test(displayName);
  return (
    <main className="auth-screen">
      <form
        className="auth-card"
        onSubmit={(event) => {
          event.preventDefault();
          if (nameValid && personalFlagColor) {
            void onSubmit(displayName, personalFlagColor);
          }
        }}
      >
        <div className="auth-brand">
          <AshAtlasBrandLogo className="auth-brand-logo" />
          <span>Ash Atlas</span>
        </div>
        <h1>Create your player</h1>
        <p className="auth-copy">
          This is your public in-game name. Your Google profile name and email stay private.
        </p>
        <label className="auth-field">
          Display name
          <input
            autoFocus
            autoComplete="off"
            value={displayName}
            minLength={3}
            maxLength={20}
            pattern="[A-Za-z]{3,20}"
            placeholder="3-20 English letters"
            disabled={busy}
            onChange={(event) => setDisplayName(event.currentTarget.value)}
          />
          {displayName && !nameValid ? (
            <span className="auth-field-error">Use 3-20 English letters only.</span>
          ) : null}
        </label>
        <fieldset className="flag-color-options">
          <legend>Personal flag color</legend>
          <div className="flag-color-grid">
            {PERSONAL_FLAG_COLORS.map((color) => (
              <label
                key={color}
                className={`flag-color-option${personalFlagColor === color ? " selected" : ""}`}
              >
                <input
                  type="radio"
                  name="personalFlagColor"
                  value={color}
                  checked={personalFlagColor === color}
                  disabled={busy}
                  onChange={() => setPersonalFlagColor(color)}
                />
                <span
                  className="personal-flag-preview"
                  style={{ "--personal-flag-color": PERSONAL_FLAG_COLOR_HEX[color] } as React.CSSProperties}
                  aria-hidden="true"
                />
                <span>{color[0]!.toUpperCase() + color.slice(1)}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <button
          type="submit"
          className="auth-primary"
          disabled={busy || !nameValid || !personalFlagColor}
        >
          {busy ? "Saving..." : "Create Player"}
        </button>
        <button type="button" className="auth-secondary" disabled={busy} onClick={() => void onLogout()}>
          Sign out
        </button>
        {message ? <div className="auth-error" role="alert">{message}</div> : null}
      </form>
    </main>
  );
}
