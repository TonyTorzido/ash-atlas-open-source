import { useEffect, useRef, useState } from "react";

import type { DevelopmentProfileKey, EmailCodeIssued } from "../auth/authClient.js";
import { PwaInstallPrompt } from "../pwa/PwaInstallPrompt.js";
import { AshAtlasBrandLogo } from "./AshAtlasBrandLogo.js";
import { EmailCodeForm } from "./EmailCodeForm.js";

type GoogleCredentialResponse = { credential?: string };

type GoogleIdentityServices = {
  accounts: {
    id: {
      initialize(options: {
        client_id: string;
        callback(response: GoogleCredentialResponse): void;
      }): void;
      renderButton(
        parent: HTMLElement,
        options: {
          type: "standard";
          theme: "outline";
          size: "large";
          text: "continue_with";
          shape: "rectangular";
          width: number;
        }
      ): void;
    };
  };
};

declare global {
  interface Window {
    google?: GoogleIdentityServices;
  }
}

type LoginScreenProps = {
  googleClientId: string;
  appleSignInEnabled?: boolean;
  emailSignInEnabled?: boolean;
  nativeLoginEnabled?: boolean;
  nativeWebsiteBase?: string;
  developmentAuthEnabled: boolean;
  busy: boolean;
  message: string | null;
  onGoogleCredential(credential: string): Promise<void>;
  onAppleLogin?(): void;
  onEmailStart?(email: string): Promise<EmailCodeIssued>;
  onEmailVerify?(email: string, code: string): Promise<void>;
  onNativeLogin?(): Promise<void>;
  onDeveloperLogin(profile: DevelopmentProfileKey): Promise<void>;
};

const GOOGLE_SCRIPT_ID = "google-identity-services";
let googleScriptPromise: Promise<void> | null = null;

export function LoginScreen({
  googleClientId,
  appleSignInEnabled = false,
  emailSignInEnabled = false,
  nativeLoginEnabled = false,
  nativeWebsiteBase,
  developmentAuthEnabled,
  busy,
  message,
  onGoogleCredential,
  onAppleLogin,
  onEmailStart,
  onEmailVerify,
  onNativeLogin,
  onDeveloperLogin
}: LoginScreenProps): React.JSX.Element {
  const googleButtonRef = useRef<HTMLDivElement | null>(null);
  const [googleLoadError, setGoogleLoadError] = useState<string | null>(null);
  const [emailOpen, setEmailOpen] = useState(false);
  // Native builds sign in through the web login page in the system browser,
  // which renders this same screen with the email option.
  const emailAvailable = emailSignInEnabled && !nativeLoginEnabled && Boolean(onEmailStart && onEmailVerify);
  const showEmailForm = emailAvailable && emailOpen;

  useEffect(() => {
    const button = googleButtonRef.current;
    if (nativeLoginEnabled || showEmailForm || !googleClientId || !button) {
      return;
    }
    let active = true;
    void loadGoogleIdentityServices()
      .then(() => {
        if (!active || !window.google || !googleButtonRef.current) {
          return;
        }
        window.google.accounts.id.initialize({
          client_id: googleClientId,
          callback: (response) => {
            let credential = response.credential ?? "";
            if (!credential) {
              setGoogleLoadError("Login canceled. Please try again.");
              return;
            }
            void onGoogleCredential(credential)
              .catch(() => setGoogleLoadError("Login verification could not be started."))
              .finally(() => {
                credential = "";
              });
          }
        });
        googleButtonRef.current.replaceChildren();
        const buttonWidth = Math.max(
          200,
          Math.min(320, Math.floor(googleButtonRef.current.clientWidth))
        );
        window.google.accounts.id.renderButton(googleButtonRef.current, {
          type: "standard",
          theme: "outline",
          size: "large",
          text: "continue_with",
          shape: "rectangular",
          width: buttonWidth
        });
      })
      .catch(() => {
        if (active) {
          setGoogleLoadError("Google Sign-In could not be loaded.");
        }
      });
    return () => {
      active = false;
    };
  }, [
    googleClientId,
    nativeLoginEnabled,
    showEmailForm,
    onGoogleCredential
  ]);

  const visibleMessage = message ?? googleLoadError;
  const legalHref = (path: string): string => nativeLoginEnabled && nativeWebsiteBase
    ? new URL(path, nativeWebsiteBase).toString()
    : path;
  return (
    <main className="auth-screen">
      <section className="auth-card" aria-labelledby="auth-title">
        <div className="auth-brand">
          <AshAtlasBrandLogo className="auth-brand-logo" />
          <span>Ash Atlas</span>
        </div>
        <h1 id="auth-title">Enter the atlas</h1>
        <p className="auth-copy">
          {showEmailForm
            ? "Enter your email and we will send a one-time code. No password needed."
            : emailAvailable
            ? "Continue with Google, Apple, or a one-time email code. Ash Atlas uses your identity only for account sign-in."
            : appleSignInEnabled
            ? "Continue with Google or Apple. Ash Atlas uses your provider identity only for account sign-in."
            : "Continue with your Google account. Ash Atlas uses Google only to verify your identity and does not request Gmail, contacts, or Drive access."}
        </p>
        {nativeLoginEnabled ? (
          <div className={busy ? "google-button-slot busy" : "google-button-slot"}>
            <button
              type="button"
              className="auth-primary"
              disabled={busy}
              onClick={() => void onNativeLogin?.()}
            >
              {appleSignInEnabled ? "Continue with Google or Apple" : "Continue with Google"}
            </button>
          </div>
        ) : showEmailForm && onEmailStart && onEmailVerify ? (
          <EmailCodeForm
            variant="auth"
            disabled={busy}
            onStart={onEmailStart}
            onVerify={onEmailVerify}
            onCancel={() => setEmailOpen(false)}
          />
        ) : (
          <div className="auth-provider-options" aria-label="Sign-in options">
            <div className={busy ? "google-button-slot busy" : "google-button-slot"}>
              {googleClientId ? (
                <div ref={googleButtonRef} aria-label="Continue with Google" />
              ) : developmentAuthEnabled ? null : (
                <span>Google Sign-In is not configured.</span>
              )}
            </div>
            {appleSignInEnabled ? (
              <button
                type="button"
                className="auth-provider-button apple-provider-button"
                aria-label="Continue with Apple"
                disabled={busy}
                onClick={onAppleLogin}
              >
                <img
                  className="apple-provider-image"
                  src="/brand/sign-in-with-apple-continue-white@3x.png"
                  width="320"
                  height="44"
                  alt=""
                />
              </button>
            ) : null}
            {emailAvailable ? (
              <button
                type="button"
                className="auth-secondary auth-email-option"
                disabled={busy}
                onClick={() => setEmailOpen(true)}
              >
                Continue with email
              </button>
            ) : null}
          </div>
        )}
        <PwaInstallPrompt />
        {developmentAuthEnabled ? (
          <section className="developer-login-panel" aria-labelledby="developer-login-title">
            <strong id="developer-login-title">Local development accounts</strong>
            <span>Each button opens a separate persistent local player.</span>
            <div className="developer-login-grid">
              {([
                ["default", "Default Dev"],
                ["player2", "Dev Player 2"],
                ["player3", "Dev Player 3"],
                ["player4", "Dev Player 4"]
              ] as const).map(([profile, label]) => (
                <button
                  key={profile}
                  type="button"
                  className="developer-login-button"
                  disabled={busy}
                  onClick={() => void onDeveloperLogin(profile)}
                >
                  {label}
                </button>
              ))}
            </div>
          </section>
        ) : null}
        {busy ? <div className="auth-status">Authenticating...</div> : null}
        {visibleMessage ? <div className="auth-error" role="alert">{visibleMessage}</div> : null}
        <div className="auth-links">
          <a href={legalHref("/privacy")}>Privacy</a>
          <a href={legalHref("/terms")}>Terms</a>
        </div>
      </section>
    </main>
  );
}

export function loadGoogleIdentityServices(): Promise<void> {
  if (window.google) {
    return Promise.resolve();
  }
  if (googleScriptPromise) {
    return googleScriptPromise;
  }
  googleScriptPromise = new Promise<void>((resolve, reject) => {
    const existing = document.getElementById(GOOGLE_SCRIPT_ID) as HTMLScriptElement | null;
    const script = existing ?? document.createElement("script");
    const handleLoad = (): void => resolve();
    const handleError = (): void => {
      googleScriptPromise = null;
      reject(new Error("Google Identity Services failed to load"));
    };
    script.addEventListener("load", handleLoad, { once: true });
    script.addEventListener("error", handleError, { once: true });
    if (!existing) {
      script.id = GOOGLE_SCRIPT_ID;
      script.src = "https://accounts.google.com/gsi/client";
      script.async = true;
      script.defer = true;
      document.head.appendChild(script);
    }
  });
  return googleScriptPromise;
}
