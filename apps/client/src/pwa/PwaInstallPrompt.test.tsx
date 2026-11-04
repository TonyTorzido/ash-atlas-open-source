// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PwaInstallPrompt } from "./PwaInstallPrompt.js";

const originalUserAgent = navigator.userAgent;

describe("PWA install prompt", () => {
  beforeEach(() => {
    localStorage.clear();
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn().mockReturnValue({ matches: false })
    });
  });

  afterEach(() => {
    cleanup();
    Object.defineProperty(navigator, "userAgent", { configurable: true, value: originalUserAgent });
  });

  it("offers Chrome's saved install event only after the user taps Install Ash Atlas", async () => {
    setUserAgent("Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 Chrome/136.0.0.0 Mobile Safari/537.36");
    const prompt = vi.fn().mockResolvedValue(undefined);
    const userChoice = Promise.resolve({ outcome: "accepted" as const, platform: "web" });
    render(<PwaInstallPrompt />);

    const event = new Event("beforeinstallprompt", { cancelable: true }) as Event & {
      prompt: typeof prompt;
      userChoice: typeof userChoice;
    };
    Object.defineProperties(event, {
      prompt: { value: prompt },
      userChoice: { value: userChoice }
    });
    window.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    const button = await screen.findByRole("button", { name: "Install Ash Atlas" });
    expect(prompt).not.toHaveBeenCalled();
    fireEvent.click(button);

    await waitFor(() => expect(prompt).toHaveBeenCalledOnce());
    expect((await screen.findByRole("status")).textContent).toContain("Ash Atlas is installed");
  });

  it("shows a dismissible iPhone Safari hint with the Share icon", () => {
    setUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1");
    render(<PwaInstallPrompt />);

    expect(screen.getByRole("note").textContent).toContain("Install: tap Share, then Add to Home Screen.");
    expect(document.querySelector(".pwa-share-icon")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss install instructions" }));
    expect(screen.queryByRole("note")).toBeNull();
    expect(localStorage.getItem("ash-atlas:pwa-install-hint-dismissed")).toBe("1");
  });

  it("opens the detailed iPhone instructions page for ?install=1", () => {
    setUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1");
    window.history.replaceState(null, "", "/play/?install=1");
    render(<PwaInstallPrompt instructionsPage />);

    expect(screen.getByRole("heading", { name: "Install Ash Atlas" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "On iPhone" })).toBeTruthy();
    expect(document.querySelector(".pwa-share-icon")).not.toBeNull();
    expect(screen.getByRole("link", { name: "Continue to Ash Atlas" }).getAttribute("href")).toBe("/play/");
  });

  it("hides all install prompts inside an installed app", () => {
    setUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1");
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn().mockReturnValue({ matches: true })
    });
    const { container } = render(<PwaInstallPrompt instructionsPage />);

    expect(container.firstChild).toBeNull();
  });

  it("keeps install UI off desktop Chrome even if an install event is available", async () => {
    setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/136.0.0.0 Safari/537.36");
    const { container } = render(<PwaInstallPrompt />);
    const event = new Event("beforeinstallprompt", { cancelable: true });
    Object.defineProperties(event, {
      prompt: { value: vi.fn().mockResolvedValue(undefined) },
      userChoice: { value: Promise.resolve({ outcome: "dismissed", platform: "web" }) }
    });
    window.dispatchEvent(event);

    await waitFor(() => expect(container.firstChild).toBeNull());
    expect(screen.queryByRole("button", { name: "Install Ash Atlas" })).toBeNull();
  });

  it("keeps the Safari hint available after a player signs in", () => {
    setUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1");
    render(<PwaInstallPrompt placement="game" />);

    expect(screen.getByRole("note").textContent).toContain("Install: tap Share, then Add to Home Screen.");
    expect(document.querySelector(".pwa-install-prompt-game")).not.toBeNull();
  });
});

function setUserAgent(userAgent: string): void {
  Object.defineProperty(navigator, "userAgent", { configurable: true, value: userAgent });
}
