import type { AuthSessionResponse, PersonalFlagColor } from "@ash-atlas/shared";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  AuthApiClient,
  AuthApiError,
  type DevelopmentProfileKey
} from "../auth/authClient.js";
import { consumeAppleCallbackMessage } from "../auth/appleCallbackResult.js";
import { initializeNativeLogout,NativeLogoutPersistenceError,nativeLogoutPending, setNativeLogoutPending } from "../native/nativeLogout.js";
import { nativeAuthNeedsReconciliation } from "../native/nativeRequest.js";
import { clearNativePushForLogout } from "../native/nativePush.js";
import {
  authErrorMessage,
  authViewFromError,
  authViewFromSession,
  isAuthenticatedClientSession,
  sessionEndedView,
  type AuthenticatedClientSession,
  type ClientAuthView
} from "../auth/authState.js";
import { updatesPanelMode, updatesSignupSource } from "../auth/updatesSignup.js";
import { clientConfig } from "../config.js";
import { applyClientUpdate, navigateToFreshClient } from "../freshClientNavigation.js";
import {
  beginNativeBrowserAuthorization,
  isNativeApp,
  nativePlatform,
  nativeAuthorizationEndpoint,
  readNativeAuthorizationRequest,
  refreshNativeWebSocketProtocols
} from "../native/nativeApp.js";
import { BootScreen } from "./BootScreen.js";
import { AshAtlasBrandLogo } from "./AshAtlasBrandLogo.js";
import { PwaInstallPrompt } from "../pwa/PwaInstallPrompt.js";
import { LoginScreen } from "./LoginScreen.js";
import { PlayerNameScreen } from "./PlayerNameScreen.js";
import { PreferencesScreen } from "./PreferencesScreen.js";
import { UpdatesSignupPanel } from "./UpdatesSignupPanel.js";
import { WelcomeCrawl } from "./WelcomeCrawl.js";

export type GameplaySessionEndReason =
  | "SESSION_EXPIRED"
  | "SESSION_REVOKED"
  | "SESSION_REPLACED"
  | "ACCOUNT_SUSPENDED"
  | "TEST_ACCESS_PENDING"
  | "TEST_ACCESS_DENIED"
  | "TEST_ACCESS_REVOKED";

type AuthGateProps = {
  onNativeCompatibilityCheck?(): Promise<void>;
  renderGame(input: {
    session: AuthenticatedClientSession;
    onLogout(): Promise<void>;
    onSessionEnded(reason: GameplaySessionEndReason, message?: string): void;
    verifySession(): Promise<boolean>;
    refreshNativeWebSocketProtocols?(): Promise<readonly string[]>;
  }): React.JSX.Element;
};

const initialView: ClientAuthView = {
  status: "checking_session",
  session: null,
  developmentAuthEnabled: false,
  message: null
};

export function AuthGate({ renderGame, onNativeCompatibilityCheck }: AuthGateProps): React.JSX.Element {
  const api = useMemo(() => new AuthApiClient(clientConfig.serverHttpBase), []);
  const nativeAuthorizationRequest = useMemo(() => readNativeAuthorizationRequest(), []);
  const appleCallbackMessage = useMemo(() => consumeAppleCallbackMessage(), []);
  const [view, setView] = useState<ClientAuthView>(initialView);
  const [onboardingBusy, setOnboardingBusy] = useState(false);
  // New players see Preferences, then the welcome crawl. ?preferences / ?welcome replay them.
  const [newPlayerStep, setNewPlayerStep] = useState<"preferences" | "welcome" | null>(() => {
    const params = new URLSearchParams(window.location.search);
    return params.has("preferences") ? "preferences" : params.has("welcome") ? "welcome" : null;
  });
  const accessCheckInFlight = useRef(false);
  const accessPollFailures = useRef(0);
  const authGeneration = useRef(0);
  const nativeAuthorizationAbort = useRef<AbortController | null>(null);
  const [nativeAccountConfirmed, setNativeAccountConfirmed] = useState(false);
  // While the server is developer-only, sign-in sits behind the update sign-up; an Apple callback
  // result means a sign-in was already under way, so it goes straight back to sign-in.
  const [developerSignInRequested, setDeveloperSignInRequested] = useState(() => appleCallbackMessage !== null);

  const applySession = useCallback((session: AuthSessionResponse): void => {
    const next = authViewFromSession(session);
    setView(next.status === "unauthenticated" && appleCallbackMessage
      ? { ...next, message: appleCallbackMessage }
      : next);
  }, [appleCallbackMessage]);

  const checkSession = useCallback(async (): Promise<void> => {
    const generation = ++authGeneration.current;
    setView((current) => ({ ...current, status: "checking_session", message: null }));
    try {
      await initializeNativeLogout();
      if(generation!==authGeneration.current) return;
      let session = await api.getSession();
      if(generation!==authGeneration.current) return;
      if (nativeLogoutPending()) {
        if (session.authenticated && session.csrfToken) await api.logout(session.csrfToken);
        if(generation!==authGeneration.current) return;
        session = await api.getSession();
        if(generation!==authGeneration.current) return;
        if (session.authenticated) throw new Error("Sign-out is still being checked. Try again when connected.");
        await setNativeLogoutPending(false);
      }
      if (generation === authGeneration.current) applySession(session);
    } catch (error) {
      if (generation === authGeneration.current) setView(authViewFromError(error instanceof NativeLogoutPersistenceError ? new AuthApiError("SERVER_UNAVAILABLE",error.message,0) : error));
    }
  }, [api, applySession]);

  const verifySession = useCallback(async (): Promise<boolean> => {
    if (nativeLogoutPending()) return false;
    const generation = authGeneration.current;
    try {
      const session = await api.getSession();
      if (generation !== authGeneration.current || nativeLogoutPending()) return false;
      const next = authViewFromSession(session);
      if (next.status === "authenticated") return true;
      setView(next.status === "unauthenticated"
        ? { ...next, status: "session_expired", message: "Please sign in again to continue." }
        : next);
      return false;
    } catch {
      return generation === authGeneration.current && !nativeLogoutPending();
    }
  }, [api]);

  const refreshAccess = useCallback(async (): Promise<void> => {
    if (accessCheckInFlight.current) return;
    const generation = authGeneration.current;
    accessCheckInFlight.current = true;
    try {
      const session = await api.getSession();
      if (generation === authGeneration.current && !nativeLogoutPending()) applySession(session);
      accessPollFailures.current = 0;
    } catch {
      accessPollFailures.current += 1;
    } finally {
      accessCheckInFlight.current = false;
    }
  }, [api, applySession]);

  useEffect(() => {
    void checkSession();
    return () => { ++authGeneration.current; nativeAuthorizationAbort.current?.abort(); };
  }, [checkSession]);

  useEffect(() => {
    if (
      !nativeAuthorizationRequest ||
      !view.session?.authenticated ||
      view.status === "client_update_required" ||
      (nativeAuthorizationRequest.chooseAccount && !nativeAccountConfirmed) ||
      isNativeApp()
    ) return;
    window.location.replace(nativeAuthorizationEndpoint(
      clientConfig.serverHttpBase,
      { ...nativeAuthorizationRequest, chooseAccount: false }
    ));
  }, [nativeAccountConfirmed, nativeAuthorizationRequest, view.session?.authenticated, view.status]);

  useEffect(() => {
    if (view.status !== "test_access_pending" && view.status !== "test_access_dev_only") return;
    let timeout: number | null = null;
    let stopped = false;
    const schedule = (): void => {
      if (stopped || document.hidden) return;
      const delay = Math.min(60_000, 7_000 * (2 ** accessPollFailures.current));
      timeout = window.setTimeout(async () => {
        await refreshAccess();
        schedule();
      }, delay);
    };
    const onVisibilityChange = (): void => {
      if (document.hidden) {
        if (timeout !== null) window.clearTimeout(timeout);
        timeout = null;
        return;
      }
      void refreshAccess().finally(schedule);
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    schedule();
    return () => {
      stopped = true;
      if (timeout !== null) window.clearTimeout(timeout);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [refreshAccess, view.status]);

  const loginWithGoogle = useCallback(
    async (credential: string): Promise<void> => {
      const generation = ++authGeneration.current;
      setView((current) => ({ ...current, status: "authenticating", message: null }));
      try {
        const session=await api.loginWithGoogle(credential);
        if(generation===authGeneration.current && !nativeLogoutPending()) applySession(session);
      } catch (error) {
        if(generation!==authGeneration.current || nativeLogoutPending()) return;
        const message = authErrorMessage(error);
        const next = authViewFromError(error, view.developmentAuthEnabled);
        setView(
          next.status === "auth_error"
            ? { ...next, status: "unauthenticated", message }
            : { ...next, message }
        );
      }
    },
    [api, applySession, view.developmentAuthEnabled]
  );

  const startEmailLogin = useCallback(
    (email: string) => api.startEmailLogin(email),
    [api]
  );

  // Failures throw back to the email form (inline message); success applies the
  // session exactly like the other providers, so the native_auth return effect fires.
  const verifyEmailLogin = useCallback(
    async (email: string, code: string): Promise<void> => {
      const generation = ++authGeneration.current;
      try {
        const session = await api.verifyEmailLogin(email, code);
        if (generation === authGeneration.current && !nativeLogoutPending()) applySession(session);
      } catch (error) {
        if (generation !== authGeneration.current || nativeLogoutPending()) return;
        const code = error instanceof AuthApiError ? error.code : "";
        if (code === "ACCOUNT_SUSPENDED" || code.startsWith("TEST_ACCESS_")) {
          setView({ ...authViewFromError(error, view.developmentAuthEnabled), message: authErrorMessage(error) });
          return;
        }
        throw error;
      }
    },
    [api, applySession, view.developmentAuthEnabled]
  );

  const loginAsDeveloper = useCallback(async (profile: DevelopmentProfileKey): Promise<void> => {
    const generation = ++authGeneration.current;
    setView((current) => ({ ...current, status: "authenticating", message: null }));
    try {
      const session=await api.loginAsDeveloper(profile);
      if(generation===authGeneration.current && !nativeLogoutPending()) applySession(session);
    } catch (error) {
      if(generation!==authGeneration.current || nativeLogoutPending()) return;
      setView((current) => ({
        ...current,
        status: "unauthenticated",
        message: authErrorMessage(error)
      }));
    }
  }, [api, applySession]);

  const loginNative = useCallback(async (): Promise<void> => {
    if (nativeLogoutPending() || nativeAuthNeedsReconciliation()) {
      await checkSession();
      return;
    }
    const generation = ++authGeneration.current;
    nativeAuthorizationAbort.current?.abort();
    const controller = new AbortController();
    nativeAuthorizationAbort.current = controller;
    setView((current) => ({ ...current, status: "authenticating", message: null }));
    try {
      await onNativeCompatibilityCheck?.();
      if (generation !== authGeneration.current) return;
      const authorization = await beginNativeBrowserAuthorization(clientConfig.serverHttpBase, controller.signal);
      if (generation !== authGeneration.current || nativeLogoutPending()) return;
      const session = await api.loginNative(authorization);
      if (generation === authGeneration.current && !nativeLogoutPending()) applySession(session);
    } catch (error) {
      if (generation !== authGeneration.current) return;
      if (nativeAuthNeedsReconciliation()) {
        await checkSession();
        return;
      }
      setView((current) => ({
        ...current,
        status: "unauthenticated",
        message: error instanceof Error ? error.message : "Native sign-in could not be completed."
      }));
    }
  }, [api, applySession, checkSession, onNativeCompatibilityCheck]);

  const startAppleLogin = useCallback((): void => {
    const returnTo = `${window.location.pathname}${window.location.search}`;
    const url = new URL("/api/auth/apple/start", clientConfig.serverHttpBase);
    url.searchParams.set("return_to", returnTo);
    window.location.assign(url.toString());
  }, []);

  const logout = useCallback(async (): Promise<void> => {
    const csrfToken = view.session?.csrfToken;
    ++authGeneration.current;
    nativeAuthorizationAbort.current?.abort();
    const persistedLogout=setNativeLogoutPending(true);
    void clearNativePushForLogout();
    if (isNativeApp()) setView({ ...initialView, message: "Signing out…" });
    try {
      await persistedLogout;
      if (csrfToken) {
        await api.logout(csrfToken);
      }
    } catch (error) {
      if(error instanceof NativeLogoutPersistenceError) {
        setView(authViewFromError(new AuthApiError("SERVER_UNAVAILABLE",error.message,0)));
        return;
      }
      // Session reconciliation below preserves the local lock if remote revocation is unknown.
    }
    await checkSession();
  }, [api, checkSession, view.session?.csrfToken]);

  const completeOnboarding = useCallback(
    async (
      displayName: string,
      personalFlagColor: PersonalFlagColor
    ): Promise<void> => {
      const session = view.session;
      const generation = authGeneration.current;
      if (!session?.authenticated || !session.csrfToken) {
        setView(sessionEndedView("SESSION_EXPIRED"));
        return;
      }
      setView((current) => ({ ...current, message: null }));
      setOnboardingBusy(true);
      try {
        const player = await api.completeOnboarding(
          displayName,
          personalFlagColor,
          session.csrfToken
        );
        if (generation !== authGeneration.current || nativeLogoutPending()) return;
        setNewPlayerStep("preferences");
        applySession({
          ...session,
          player,
          onboardingRequired: false
        });
      } catch (error) {
        if (generation !== authGeneration.current || nativeLogoutPending()) return;
        if (error instanceof AuthApiError && error.code === "AUTHENTICATION_REQUIRED") {
          setView((current) => authViewFromError(error, current.developmentAuthEnabled));
        } else {
          setView((current) => ({ ...current, message: authErrorMessage(error) }));
        }
      } finally {
        setOnboardingBusy(false);
      }
    },
    [api, applySession, view.session]
  );

  const sessionEnded = useCallback(
    (reason: GameplaySessionEndReason, message?: string): void => {
      if (nativeLogoutPending()) return;
      const generation = ++authGeneration.current;
      if (reason === "SESSION_REPLACED") {
        setView((current) => ({
          ...sessionEndedView(reason, message, current.developmentAuthEnabled),
          session: current.session
        }));
        return;
      }
      if (reason === "ACCOUNT_SUSPENDED") {
        setView(sessionEndedView(reason, message, view.developmentAuthEnabled));
        return;
      }
      setView((current) => ({ ...current, status: "checking_session", message: null }));
      void api.getSession().then((session) => {
        if (generation !== authGeneration.current || nativeLogoutPending()) return;
        if (session.authenticated) {
          applySession(session);
          return;
        }
        setView({
          ...authViewFromSession(session),
          status: "session_expired",
          message: "Please sign in again to continue."
        });
      }).catch((error: unknown) => { if (generation === authGeneration.current && !nativeLogoutPending()) setView(authViewFromError(error)); });
    },
    [api, applySession, view.developmentAuthEnabled]
  );

  if (view.status === "checking_session") {
    return <BootScreen title="Starting Ash Atlas…" detail="Checking your session." />;
  }
  if (view.status === "client_update_required") {
    return (
      <AuthStatusScreen
        title="Updating Ash Atlas"
        message="Refresh the cached game files to continue. Your existing player and progress are safe."
      >
        <button
          type="button"
          className="auth-primary"
          onClick={() => void applyClientUpdate({
            platform: isNativeApp() ? nativePlatform() ?? "ios" : "web",
            reason: "manual",
            clientSha: clientConfig.buildSha
          })}
        >
          Refresh Game
        </button>
      </AuthStatusScreen>
    );
  }
  if (
    nativeAuthorizationRequest &&
    view.session?.authenticated &&
    !isNativeApp()
  ) {
    if (nativeAuthorizationRequest.chooseAccount && !nativeAccountConfirmed) {
      return <AuthStatusScreen title="Sign in to Ash Atlas" message="Choose the account to use in the app.">
        <p className="auth-identity">{view.session.verifiedEmail}</p>
        <button type="button" className="auth-primary" onClick={() => setNativeAccountConfirmed(true)}>Continue with this account</button>
        <button type="button" className="auth-secondary" onClick={() => void logout()}>Use another account</button>
      </AuthStatusScreen>;
    }
    return (
      <AuthStatusScreen
        title="Returning to Ash Atlas"
        message="Finishing sign-in in the app…"
      />
    );
  }
  if (view.status === "account_suspended") {
    return (
      <AuthStatusScreen
        title="Account unavailable"
        message="This account is suspended and cannot enter the game."
      />
    );
  }
  const updatesPanel = updatesPanelMode({
    status: view.status,
    session: view.session,
    developerSignInRequested,
    nativeAuthorizationPending: nativeAuthorizationRequest !== null
  });
  if (updatesPanel) {
    return (
      <UpdatesSignupPanel
        mode={updatesPanel}
        serverHttpBase={clientConfig.serverHttpBase}
        source={updatesSignupSource(nativePlatform())}
        signedInEmail={view.session?.verifiedEmail ?? null}
        onDeveloperSignIn={() => setDeveloperSignInRequested(true)}
        onCheckAccess={() => void refreshAccess()}
        onSignOut={() => void logout()}
      />
    );
  }
  if (
    view.status === "test_access_pending" ||
    view.status === "test_access_denied" ||
    view.status === "test_access_revoked" ||
    view.status === "test_access_dev_only"
  ) {
    const content = view.status === "test_access_dev_only"
      ? {
          title: "Developer Access Only",
          message: "Only developer accounts can enter Ash Atlas.",
          detail:
            "Ash Atlas is temporarily limited to the development team. Your player data is safe, and this screen will let you in as soon as access opens again."
        }
      : view.status === "test_access_pending"
      ? {
          title: "Test Access Pending",
          message:
            "Ash Atlas is currently running a closed test. Your account has been submitted for approval.",
          detail:
            "You can create your player and enter the world after the test administrator approves this email."
        }
      : view.status === "test_access_denied"
        ? {
            title: "Test Access Not Approved",
            message: "This account was not approved for the current Ash Atlas closed test.",
            detail: "You may sign out and use a different approved Google account."
          }
        : {
            title: "Test Access Removed",
            message: "Test access for this account has been removed.",
            detail: "Your player data has been preserved."
          };
    return (
      <AuthStatusScreen title={content.title} message={content.message} detail={content.detail}>
        {view.session?.verifiedEmail ? (
          <p className="auth-identity">
            You are signed in as:<strong>{view.session.verifiedEmail}</strong>
          </p>
        ) : null}
        <button type="button" className="auth-primary" onClick={() => void refreshAccess()}>
          Check Access
        </button>
        <button type="button" className="auth-secondary" onClick={() => void logout()}>
          Sign Out
        </button>
      </AuthStatusScreen>
    );
  }
  if (
    view.status === "needs_onboarding" &&
    view.session
  ) {
    return (
      <PlayerNameScreen
        busy={onboardingBusy}
        message={view.message}
        onSubmit={completeOnboarding}
        onLogout={logout}
      />
    );
  }
  if (view.status === "authenticated" && isAuthenticatedClientSession(view.session)) {
    if (newPlayerStep === "preferences") {
      return (
        <PreferencesScreen
          playerId={view.session.player.id}
          csrfToken={view.session.csrfToken}
          onContinue={() => setNewPlayerStep("welcome")}
        />
      );
    }
    return (
      <>
        {renderGame({
          session: view.session,
          onLogout: logout,
          onSessionEnded: sessionEnded,
          verifySession,
          ...(isNativeApp()
            ? {
                refreshNativeWebSocketProtocols: () =>
                  refreshNativeWebSocketProtocols(clientConfig.serverHttpBase)
              }
            : {})
        })}
        {newPlayerStep === "welcome" ? <WelcomeCrawl playerId={view.session.player.id} onDone={() => setNewPlayerStep(null)} /> : null}
        <PwaInstallPrompt placement="game" />
      </>
    );
  }
  if (view.status === "session_replaced") {
    return (
      <AuthStatusScreen
        title="Session Moved"
        message="Ash Atlas was opened on another device."
        detail="Reconnect Here will make this device the active game session."
      >
        <button
          type="button"
          className="auth-primary"
          onClick={() => navigateToFreshClient({ reason: "reconnect" })}
        >
          Reconnect Here
        </button>
      </AuthStatusScreen>
    );
  }
  if (view.status === "session_expired") {
    return (
      <AuthStatusScreen
        title="Session Expired"
        message="Please sign in again to continue."
      >
        <button type="button" className="auth-primary" onClick={() => void checkSession()}>
          Sign In
        </button>
      </AuthStatusScreen>
    );
  }
  if (view.status === "auth_error") {
    return (
      <AuthStatusScreen title="Unable to connect" message={view.message ?? "Server unavailable"}>
        <button type="button" className="auth-primary" onClick={() => void checkSession()}>
          Try again
        </button>
      </AuthStatusScreen>
    );
  }
  return (
    <LoginScreen
      googleClientId={clientConfig.googleClientId}
      appleSignInEnabled={view.session?.appleSignInEnabled === true}
      emailSignInEnabled={view.session?.emailSignInEnabled === true}
      nativeLoginEnabled={isNativeApp()}
      nativeWebsiteBase={clientConfig.serverHttpBase}
      developmentAuthEnabled={view.developmentAuthEnabled}
      busy={view.status === "authenticating"}
      message={view.message}
      onGoogleCredential={loginWithGoogle}
      onAppleLogin={startAppleLogin}
      onEmailStart={startEmailLogin}
      onEmailVerify={verifyEmailLogin}
      onNativeLogin={loginNative}
      onDeveloperLogin={loginAsDeveloper}
    />
  );
}

function AuthStatusScreen({
  title,
  message,
  detail,
  children
}: {
  title: string;
  message: string;
  detail?: string;
  children?: React.ReactNode;
}): React.JSX.Element {
  return (
    <main className="auth-screen">
      <section className="auth-card">
        <div className="auth-brand">
          <AshAtlasBrandLogo className="auth-brand-logo" />
          <span>Ash Atlas</span>
        </div>
        <h1>{title}</h1>
        <p className="auth-copy">{message}</p>
        {children}
        {detail ? <small className="auth-detail">{detail}</small> : null}
      </section>
    </main>
  );
}
