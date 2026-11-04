import { useCallback, useEffect, useRef, useState } from "react";

import {
  GameAppActionBar,
  GameAppButton,
  GameAppShell,
  GameAppText
} from "./GameAppShell.js";

const BOTTOM_THRESHOLD_PX = 24;

type CommunityRulesAcceptanceProps = Readonly<{
  open: boolean;
  layout: "desktop" | "phone";
  termsLoading: boolean;
  termsStatusReady?: boolean;
  termsError: string | null;
  onAcceptTerms(): Promise<boolean>;
  onClose(): void;
}>;

export function CommunityRulesAcceptance({
  open,
  layout,
  termsLoading,
  termsStatusReady = true,
  termsError,
  onAcceptTerms,
  onClose
}: CommunityRulesAcceptanceProps): React.JSX.Element | null {
  const [documentHtml, setDocumentHtml] = useState<string | null>(null);
  const [documentError, setDocumentError] = useState<string | null>(null);
  const [reachedBottom, setReachedBottom] = useState(false);
  const [accepting, setAccepting] = useState(false);
  const scrollRegionRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    let active = true;
    setDocumentHtml(null);
    setDocumentError(null);
    setReachedBottom(false);
    void fetch("/terms", { headers: { Accept: "text/html" } })
      .then((response) => {
        if (!response.ok) throw new Error("Community Rules could not be loaded.");
        return response.text();
      })
      .then((markup) => extractTermsDocument(markup))
      .then((html) => {
        if (!active) return;
        setDocumentHtml(html);
      })
      .catch((error: unknown) => {
        if (!active) return;
        setDocumentError(error instanceof Error ? error.message : "Community Rules could not be loaded.");
      });
    return () => {
      active = false;
    };
  }, [open]);

  const updateReachedBottom = useCallback((): void => {
    const region = scrollRegionRef.current;
    if (!region || region.scrollHeight <= 0 || region.clientHeight <= 0) {
      setReachedBottom(false);
      return;
    }
    setReachedBottom(
      region.scrollTop + region.clientHeight >= region.scrollHeight - BOTTOM_THRESHOLD_PX
    );
  }, []);

  useEffect(() => {
    if (!open || !documentHtml) return;
    updateReachedBottom();
  }, [documentHtml, open, updateReachedBottom]);

  const acceptDisabled =
    accepting || termsLoading || !termsStatusReady || documentHtml === null || documentError !== null || !reachedBottom;
  const statusId = "community-rules-acceptance-status";
  const statusMessage = documentError
    ? "The Community Rules are unavailable. Acceptance is disabled."
    : termsLoading
      ? "Checking your current Community Rules acceptance status…"
      : !termsStatusReady
        ? "Your Community Rules acceptance status is unavailable. Acceptance is disabled."
        : termsError
          ? termsError
      : documentHtml === null
        ? "Loading the complete Community Rules…"
        : reachedBottom
          ? "You have reached the end of the Community Rules."
          : "Scroll to the end of the Community Rules to enable Accept.";

  const accept = async (): Promise<void> => {
    if (acceptDisabled) return;
    setAccepting(true);
    const accepted = await onAcceptTerms();
    if (accepted) {
      onClose();
      return;
    }
    setAccepting(false);
  };

  return (
    <GameAppShell
      open={open}
      id="community-rules-acceptance"
      title="Terms & Community Rules"
      closeLabel="Back to Chat"
      className="community-rules-app"
      layout={layout}
      phoneBackLabel="Back to Chat"
      phoneShowReturnToGame={false}
      initialFocus="container"
      onClose={onClose}
    >
      <div className="community-rules-layout">
        <div
          ref={scrollRegionRef}
          className="game-app-scroll-region community-rules-scroll"
          role="region"
          aria-label="Community Rules content"
          aria-busy={documentHtml === null && documentError === null}
          tabIndex={0}
          onScroll={updateReachedBottom}
        >
          {documentError ? (
            <GameAppText tone="error" role="alert">{documentError}</GameAppText>
          ) : documentHtml ? (
            <article
              className="community-rules-document"
              dangerouslySetInnerHTML={{ __html: documentHtml }}
            />
          ) : (
            <GameAppText role="status">Loading the complete Community Rules…</GameAppText>
          )}
        </div>
        <div className="community-rules-actions">
          <GameAppText id={statusId} as="small" tone={documentError || termsError ? "error" : "helper"} ariaLive="polite">
            {statusMessage}
          </GameAppText>
          <GameAppActionBar>
            <GameAppButton
              variant="primary"
              type="button"
              disabled={acceptDisabled}
              aria-describedby={statusId}
              onClick={() => void accept()}
            >
              {accepting ? "Accepting…" : "Accept Community Rules"}
            </GameAppButton>
          </GameAppActionBar>
        </div>
      </div>
    </GameAppShell>
  );
}

function extractTermsDocument(markup: string): string {
  if (typeof DOMParser === "undefined") {
    throw new Error("Community Rules could not be loaded.");
  }
  const document = new DOMParser().parseFromString(markup, "text/html");
  const main = document.querySelector("main.account-page-main");
  if (!main) throw new Error("Community Rules could not be loaded.");
  return main.innerHTML;
}
