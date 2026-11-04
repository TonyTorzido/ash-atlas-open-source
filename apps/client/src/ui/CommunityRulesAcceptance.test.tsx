// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CommunityRulesAcceptance } from "./CommunityRulesAcceptance.js";

const canonicalTermsHtml = `<!doctype html><html><body><main class="account-page-main">
<h2>Play fairly and keep the shared world safe</h2><p>Example community rules text.</p>
<h2>Reporting, blocking, and moderation</h2><p>Example community rules text.</p>
<h2>Accounts and changes</h2><p>Example community rules text.</p>
</main></body></html>`;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("CommunityRulesAcceptance", () => {
  it("renders the complete canonical terms and unlocks Accept only at the bottom", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      text: async () => canonicalTermsHtml
    } as Response)));
    const onAcceptTerms = vi.fn(async () => true);
    const onClose = vi.fn();
    render(
      <CommunityRulesAcceptance
        open
        layout="desktop"
        termsLoading={false}
        termsError={null}
        onAcceptTerms={onAcceptTerms}
        onClose={onClose}
      />
    );

    const dialog = screen.getByRole("dialog", { name: "Terms & Community Rules" });
    expect(dialog.id).toBe("community-rules-acceptance");
    const region = await screen.findByRole("region", { name: "Community Rules content" });
    expect(region.textContent).toContain("Play fairly and keep the shared world safe");
    expect(region.textContent).toContain("Reporting, blocking, and moderation");
    expect(region.textContent).toContain("Accounts and changes");

    const accept = screen.getByRole("button", { name: "Accept Community Rules" }) as HTMLButtonElement;
    expect(accept.disabled).toBe(true);
    expect(accept.getAttribute("aria-describedby")).toBe("community-rules-acceptance-status");
    expect(screen.getByText("Scroll to the end of the Community Rules to enable Accept.")).toBeTruthy();

    setScrollMetrics(region, 400, 1_200, 700);
    fireEvent.scroll(region);
    expect(accept.disabled).toBe(true);

    setScrollMetrics(region, 400, 1_200, 800);
    fireEvent.scroll(region);
    await waitFor(() => expect(accept.disabled).toBe(false));

    fireEvent.click(accept);
    await waitFor(() => expect(onAcceptTerms).toHaveBeenCalledOnce());
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("backs out without accepting", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      text: async () => canonicalTermsHtml
    } as Response)));
    const onAcceptTerms = vi.fn(async () => true);
    const onClose = vi.fn();
    render(
      <CommunityRulesAcceptance
        open
        layout="phone"
        termsLoading={false}
        termsError={null}
        onAcceptTerms={onAcceptTerms}
        onClose={onClose}
      />
    );

    await screen.findByRole("region", { name: "Community Rules content" });
    fireEvent.click(screen.getByRole("button", { name: "Back to Chat" }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(onAcceptTerms).not.toHaveBeenCalled();
  });
});

function setScrollMetrics(element: HTMLElement, clientHeight: number, scrollHeight: number, scrollTop: number): void {
  Object.defineProperties(element, {
    clientHeight: { configurable: true, value: clientHeight },
    scrollHeight: { configurable: true, value: scrollHeight },
    scrollTop: { configurable: true, writable: true, value: scrollTop }
  });
}
