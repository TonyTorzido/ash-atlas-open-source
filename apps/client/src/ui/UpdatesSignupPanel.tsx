import { useState, type FormEvent } from "react";

import {
  subscribeToUpdates,
  validUpdatesEmail,
  type UpdatesPanelMode,
  type UpdatesSignupSource
} from "../auth/updatesSignup.js";
import { AshAtlasBrandLogo } from "./AshAtlasBrandLogo.js";

type UpdatesSignupPanelProps = {
  mode: UpdatesPanelMode;
  serverHttpBase: string;
  source: UpdatesSignupSource;
  signedInEmail?: string | null;
  onDeveloperSignIn?(): void;
  onCheckAccess?(): void;
  onSignOut?(): void;
};

type SubmitState = { kind: "idle" | "sending" | "success" | "error"; message: string };

/** Full-screen "Major upgrades in progress" notice with the update-notice email sign-up. */
export function UpdatesSignupPanel({
  mode,
  serverHttpBase,
  source,
  signedInEmail,
  onDeveloperSignIn,
  onCheckAccess,
  onSignOut
}: UpdatesSignupPanelProps): React.JSX.Element {
  const [email, setEmail] = useState("");
  const [state, setState] = useState<SubmitState>({ kind: "idle", message: "" });
  const sending = state.kind === "sending";

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (sending) return;
    if (!validUpdatesEmail(email)) {
      setState({ kind: "error", message: "Enter a valid email address." });
      return;
    }
    setState({ kind: "sending", message: "Sending..." });
    const result = await subscribeToUpdates(serverHttpBase, email, source);
    setState({ kind: result.ok ? "success" : "error", message: result.message });
    if (result.ok) setEmail("");
  };

  return (
    <main className="auth-screen updates-screen">
      <section className="auth-card updates-card" aria-labelledby="updates-title">
        <div className="auth-brand">
          <AshAtlasBrandLogo className="auth-brand-logo" />
          <span>Ash Atlas</span>
        </div>
        <h1 id="updates-title">Major upgrades in progress</h1>
        <p className="auth-copy">
          Ash Atlas is getting a big rework. The game is open to developers only for now. Leave your
          email and we'll tell you when it's back.
        </p>
        <form className="updates-form" onSubmit={(event) => void submit(event)} noValidate aria-busy={sending}>
          <label className="auth-field">
            <span>Email address</span>
            <input
              type="email"
              name="email"
              autoComplete="email"
              inputMode="email"
              maxLength={254}
              placeholder="you@example.com"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </label>
          <button type="submit" className="auth-primary" disabled={sending}>
            Notify me
          </button>
          <p
            className={`updates-result${state.kind === "success" ? " is-success" : state.kind === "error" ? " is-error" : ""}`}
            role="status"
            aria-live="polite"
          >
            {state.message}
          </p>
        </form>
        {mode === "dev_only" ? (
          <div className="updates-account">
            {signedInEmail ? <p className="auth-identity">Signed in as <strong>{signedInEmail}</strong></p> : null}
            <div className="updates-quiet-actions">
              <button type="button" className="updates-quiet-link" onClick={onCheckAccess}>Check access</button>
              <button type="button" className="updates-quiet-link" onClick={onSignOut}>Sign out</button>
            </div>
          </div>
        ) : (
          <div className="updates-quiet-actions">
            <button type="button" className="updates-quiet-link" onClick={onDeveloperSignIn}>
              Developer sign-in
            </button>
          </div>
        )}
      </section>
    </main>
  );
}
