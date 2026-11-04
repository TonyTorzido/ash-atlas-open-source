import { useEffect, useRef, useState } from "react";

import type { EmailCodeIssued } from "../auth/authClient.js";
import { authErrorMessage } from "../auth/authState.js";

const MAX_RESEND_WAIT_MS = 120_000;

type EmailCodeFormProps = {
  /** Visual host: the sign-in card or the in-game account settings. */
  variant: "auth" | "game";
  startLabel?: string;
  verifyLabel?: string;
  disabled?: boolean;
  onStart(email: string): Promise<EmailCodeIssued>;
  onVerify(email: string, code: string): Promise<void>;
  onCancel(): void;
};

/**
 * Two-step email one-time-code form shared by sign-in and account linking.
 * Failures render inline with the friendly auth messages; callers never need
 * to know whether an address already has an account.
 */
export function EmailCodeForm({
  variant,
  startLabel = "Send code",
  verifyLabel = "Verify",
  disabled = false,
  onStart,
  onVerify,
  onCancel
}: EmailCodeFormProps): React.JSX.Element {
  const [step, setStep] = useState<"email" | "code">("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resendDeadline, setResendDeadline] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (step !== "code" || resendDeadline <= Date.now()) return;
    const interval = window.setInterval(() => {
      const current = Date.now();
      setNow(current);
      if (current >= resendDeadline) window.clearInterval(interval);
    }, 1000);
    return () => window.clearInterval(interval);
  }, [step, resendDeadline]);

  const resendSeconds = Math.max(0, Math.ceil((resendDeadline - now) / 1000));
  const locked = busy || disabled;
  const trimmedEmail = email.trim();

  const requestCode = async (): Promise<void> => {
    if (locked || !trimmedEmail) return;
    setBusy(true);
    setError(null);
    try {
      const issued = await onStart(trimmedEmail);
      if (!mounted.current) return;
      const wait = Math.min(
        MAX_RESEND_WAIT_MS,
        Math.max(0, Number(issued.resendAvailableAt) - Date.now() || 0)
      );
      const started = Date.now();
      setNow(started);
      setResendDeadline(started + wait);
      setCode("");
      setStep("code");
    } catch (failure) {
      if (mounted.current) setError(authErrorMessage(failure));
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  const submitCode = async (): Promise<void> => {
    if (locked || !/^\d{6}$/.test(code)) return;
    setBusy(true);
    setError(null);
    try {
      await onVerify(trimmedEmail, code);
    } catch (failure) {
      if (mounted.current) {
        setCode("");
        setError(authErrorMessage(failure));
      }
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  const fieldClass = variant === "auth" ? "auth-field" : "auth-field email-code-field";
  const primaryClass = variant === "auth" ? "auth-primary" : "game-app-button game-app-button-primary";
  const secondaryClass = variant === "auth" ? "auth-secondary" : "game-app-button game-app-button-quiet";

  return (
    <form
      className={`email-code-form email-code-form-${variant}`}
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void (step === "email" ? requestCode() : submitCode());
      }}
    >
      {step === "email" ? (
        <label className={fieldClass}>
          Email address
          <input
            type="email"
            inputMode="email"
            autoComplete="email"
            autoCapitalize="none"
            spellCheck={false}
            maxLength={320}
            placeholder="you@example.com"
            value={email}
            disabled={locked}
            onChange={(event) => setEmail(event.currentTarget.value)}
          />
        </label>
      ) : (
        <>
          <p className="email-code-hint">
            If that address can receive mail, a 6-digit code is on its way to {trimmedEmail}.
          </p>
          <label className={fieldClass}>
            6-digit code
            <input
              className="email-code-input"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]{6}"
              maxLength={6}
              placeholder="123456"
              value={code}
              disabled={locked}
              onChange={(event) => setCode(event.currentTarget.value.replace(/\D/g, "").slice(0, 6))}
            />
          </label>
        </>
      )}
      {error ? <div className="auth-error" role="alert">{error}</div> : null}
      <div className="email-code-actions">
        <button
          type="submit"
          className={primaryClass}
          disabled={locked || (step === "email" ? !trimmedEmail : code.length !== 6)}
        >
          {busy ? "Working..." : step === "email" ? startLabel : verifyLabel}
        </button>
        {step === "code" ? (
          <button
            type="button"
            className={secondaryClass}
            disabled={locked || resendSeconds > 0}
            onClick={() => void requestCode()}
          >
            {resendSeconds > 0 ? `Resend in ${resendSeconds}s` : "Resend code"}
          </button>
        ) : null}
        <button
          type="button"
          className={secondaryClass}
          disabled={busy}
          onClick={() => {
            if (step === "code") {
              setStep("email");
              setCode("");
              setError(null);
            } else {
              onCancel();
            }
          }}
        >
          {step === "code" ? "Use a different email" : "Back"}
        </button>
      </div>
    </form>
  );
}
