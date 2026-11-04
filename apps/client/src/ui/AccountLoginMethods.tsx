import { useEffect, useRef, useState } from "react";

import type { AuthIdentityProviderName } from "@ash-atlas/shared";

import type { EmailCodeIssued } from "../auth/authClient.js";
import { authErrorMessage } from "../auth/authState.js";
import { EmailCodeForm } from "./EmailCodeForm.js";
import { GameAppButton } from "./GameAppShell.js";
import { loadGoogleIdentityServices } from "./LoginScreen.js";

export type AccountLoginMethodsProps = {
  /** Undefined when the server did not report providers (older server). */
  linkedProviders: readonly AuthIdentityProviderName[] | undefined;
  appleSignInEnabled: boolean;
  emailSignInEnabled: boolean;
  /** Empty when Google linking is unavailable on this client (native builds). */
  googleClientId: string;
  onLinkApple(): Promise<void>;
  onStartEmailLink(email: string): Promise<EmailCodeIssued>;
  onVerifyEmailLink(email: string, code: string): Promise<void>;
  onLinkGoogle(credential: string): Promise<void>;
};

const PROVIDER_LABELS: Record<AuthIdentityProviderName, string> = {
  google: "Google",
  apple: "Apple",
  email: "Email"
};

export function AccountLoginMethods({
  linkedProviders,
  appleSignInEnabled,
  emailSignInEnabled,
  googleClientId,
  onLinkApple,
  onStartEmailLink,
  onVerifyEmailLink,
  onLinkGoogle
}: AccountLoginMethodsProps): React.JSX.Element | null {
  const [emailOpen, setEmailOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const linked = linkedProviders ?? [];
  const known = linkedProviders !== undefined;
  const canLinkApple = appleSignInEnabled && !linked.includes("apple");
  const canLinkEmail = emailSignInEnabled && known && !linked.includes("email");
  // Google linking proves ownership of an already-verified email, so it is
  // offered to accounts that signed in with email.
  const canLinkGoogle = Boolean(googleClientId) && known &&
    linked.includes("email") && !linked.includes("google");
  if (!linked.length && !canLinkApple && !canLinkEmail && !canLinkGoogle) return null;

  return (
    <div className="phone-account-login-methods">
      <h4>Login methods</h4>
      {linked.length ? (
        <p>Linked: {linked.map((provider) => PROVIDER_LABELS[provider]).join(", ")}.</p>
      ) : null}
      {canLinkApple ? (
        <>
          <p>Add Apple as a backup way to sign in.</p>
          <GameAppButton onClick={() => void onLinkApple()}>Link Apple</GameAppButton>
        </>
      ) : null}
      {canLinkEmail ? (
        emailOpen ? (
          <EmailCodeForm
            variant="game"
            startLabel="Send code"
            verifyLabel="Link email"
            onStart={onStartEmailLink}
            onVerify={async (email, code) => {
              await onVerifyEmailLink(email, code);
              setEmailOpen(false);
              setError(null);
              setNotice("Email linked. You can now sign in with a one-time code.");
            }}
            onCancel={() => setEmailOpen(false)}
          />
        ) : (
          <>
            <p>Add an email as a backup way to sign in. We'll send you a code.</p>
            <GameAppButton onClick={() => { setNotice(null); setEmailOpen(true); }}>Link email</GameAppButton>
          </>
        )
      ) : null}
      {canLinkGoogle ? (
        <>
          <p>Link the Google account that uses the same email address.</p>
          <GoogleLinkButton
            googleClientId={googleClientId}
            onCredential={async (credential) => {
              setError(null);
              try {
                await onLinkGoogle(credential);
                setNotice("Google linked.");
              } catch (failure) {
                setError(authErrorMessage(failure));
              }
            }}
          />
        </>
      ) : null}
      {notice ? <p className="phone-account-login-notice" role="status">{notice}</p> : null}
      {error ? <div className="auth-error" role="alert">{error}</div> : null}
    </div>
  );
}

function GoogleLinkButton({
  googleClientId,
  onCredential
}: {
  googleClientId: string;
  onCredential(credential: string): Promise<void>;
}): React.JSX.Element {
  const slot = useRef<HTMLDivElement | null>(null);
  const callback = useRef(onCredential);
  callback.current = onCredential;
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    let active = true;
    void loadGoogleIdentityServices()
      .then(() => {
        const element = slot.current;
        if (!active || !window.google || !element) return;
        window.google.accounts.id.initialize({
          client_id: googleClientId,
          callback: (response) => {
            if (response.credential) void callback.current(response.credential);
          }
        });
        element.replaceChildren();
        window.google.accounts.id.renderButton(element, {
          type: "standard",
          theme: "outline",
          size: "large",
          text: "continue_with",
          shape: "rectangular",
          width: Math.max(200, Math.min(320, Math.floor(element.clientWidth)))
        });
      })
      .catch(() => {
        if (active) setLoadError(true);
      });
    return () => {
      active = false;
    };
  }, [googleClientId]);

  return loadError
    ? <div className="auth-error" role="alert">Google Sign-In could not be loaded.</div>
    : <div ref={slot} className="google-button-slot" aria-label="Link Google" />;
}
