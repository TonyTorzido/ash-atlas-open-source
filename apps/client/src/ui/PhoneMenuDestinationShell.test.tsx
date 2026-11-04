// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MOBILE_MENU_DESTINATIONS } from "../mobileGameMenu.js";
import { DestinationShell } from "./DestinationShell.js";
import { PhoneMenuDestinationShell, PhoneMenuFooterButtons } from "./PhoneMenuDestinationShell.js";

const directory = resolve(process.cwd(), "src", "ui");

afterEach(cleanup);

describe("PhoneMenuDestinationShell", () => {
  it("owns the locked Build and Achievements structure and Back control", () => {
    const html = renderToStaticMarkup(
      <PhoneMenuDestinationShell eyebrow="Game Menu" title="Achievements" subtitle="A ledger" onBack={() => undefined}>
        <p>Coming soon</p>
      </PhoneMenuDestinationShell>
    );
    expect(html).toMatch(/^<section[^>]*class="phone-menu-layer phone-destination-shell/);
    expect(html).toContain('<header class="phone-menu-header">');
    expect(html).toContain('<div class="phone-destination-body">');
    expect(html).toContain('<footer class="phone-menu-footer">');
    expect(html).toContain('class="phone-menu-back"');
    expect(html).toContain("Back to Game Menu");
    expect(html).toContain('class="phone-menu-return"');
    expect(html).toContain("Return to Game");
    expect(html).not.toContain("×");
  });

  it("keeps the hard-coded top-level destination list synchronized", () => {
    expect(MOBILE_MENU_DESTINATIONS.map(({ id }) => id)).toEqual([
      "profile", "contacts", "messages", "party", "classes", "character",
      "equipment", "crafting", "city", "kingdom", "build", "flags", "tolls", "world-map", "pet-chamber", "leaderboards", "achievements", "creature-book",
      "bug-report", "miscellaneous", "announcements", "patch-notes"
    ]);
  });

  it("exposes reusable footer buttons without introducing a nested footer", () => {
    const html = renderToStaticMarkup(
      <PhoneMenuFooterButtons backLabel="Back to Main Menu" onBack={() => undefined} onReturnToGame={() => undefined} />
    );
    expect(html).toContain('class="phone-menu-back"');
    expect(html).toContain('class="phone-menu-return"');
    expect(html).not.toContain("<footer");
  });

  it("does not forward the click event to footer navigation callbacks", () => {
    const onBack = vi.fn();
    const onReturnToGame = vi.fn();
    render(<PhoneMenuFooterButtons onBack={onBack} onReturnToGame={onReturnToGame} />);

    fireEvent.click(screen.getByRole("button", { name: "Back to Game Menu" }));
    fireEvent.click(screen.getByRole("button", { name: "Return to Game" }));

    expect(onBack).toHaveBeenCalledOnce();
    expect(onBack).toHaveBeenCalledWith();
    expect(onReturnToGame).toHaveBeenCalledOnce();
    expect(onReturnToGame).toHaveBeenCalledWith();
  });

  it("keeps the shared Back chevron as a visible current-color stroke", () => {
    const html = renderToStaticMarkup(
      <PhoneMenuFooterButtons backLabel="Back" onBack={() => undefined} onReturnToGame={() => undefined} />
    );
    expect(html).toMatch(/<svg[^>]*fill="none"[^>]*stroke="currentColor"[^>]*stroke-width="2"[^>]*stroke-linecap="round"[^>]*stroke-linejoin="round"/);
  });

  it("uses the shared phone shell for every current top-level destination", () => {
    const contracts: Record<string, RegExp> = {
      "PhoneHud.tsx": /<PhoneMenuDestinationShell/g,
      "SocialProfileOverlay.tsx": /<GameAppShell/g,
      "DirectMessagesPanel.tsx": /<PhoneMenuDestinationShell/g,
      "WarriorClassPanel.tsx": /<PhoneMenuDestinationShell/g,
      "CharacterPanel.tsx": /layout=\{layout\}/,
      "InventoryPanel.tsx": /layout=\{layout\}/,
      "KingdomPanel.tsx": /<DestinationShell/g,
      "FlagListPanel.tsx": /<GameAppShell/g,
      "WorldMapOverlay.tsx": /<PhoneMenuDestinationShell/g,
      "PetPanel.tsx": /<GameAppShell/g,
      "WeeklyLeaderboardsPanel.tsx": /<DestinationShell/g,
      "AnnouncementsPanel.tsx": /<GameAppShell/g,
      "PatchNotesPanel.tsx": /<GameAppShell/g
    };
    for (const [file, contract] of Object.entries(contracts)) {
      expect(readFileSync(`${directory}/${file}`, "utf8"), file).toMatch(contract);
    }
  });

  it("keeps desktop DestinationShell free of the phone footer", () => {
    const desktop = renderToStaticMarkup(
      <DestinationShell open title="Inventory" eyebrow="Travel Pack" closeLabel="Close" onClose={() => undefined}>
        <p>Items</p>
      </DestinationShell>
    );
    const phone = renderToStaticMarkup(
      <DestinationShell open layout="phone" title="Inventory" eyebrow="Travel Pack" closeLabel="Close" onClose={() => undefined}>
        <p>Items</p>
      </DestinationShell>
    );
    expect(desktop).not.toContain("phone-menu-footer");
    expect(desktop).toContain("destination-shell-close");
    expect(phone).toContain("phone-menu-footer");
    expect(phone).not.toContain("destination-shell-close");
  });

  it("retains the exact shared geometry and scroll ownership", () => {
    const styles = readFileSync(`${directory}/../styles.css`, "utf8");
    const theme = readFileSync(`${directory}/../ashAtlasTheme.css`, "utf8");
    expect(styles).toMatch(/\.phone-menu-layer\s*\{[^}]*box-sizing: border-box;[^}]*width: 100%;[^}]*max-width: 100%;[^}]*height: var\(--app-viewport-height\);[^}]*grid-template-columns: minmax\(0, 1fr\);[^}]*grid-template-rows: auto minmax\(0, 1fr\) auto;/s);
    expect(styles).toMatch(/\.phone-menu-header\s*\{[^}]*min-height: 64px;[^}]*padding: 8px 12px;/s);
    expect(styles).toMatch(/\.phone-menu-footer\s*\{[^}]*min-height: calc\(56px \+ var\(--hud-safe-bottom\)\);[^}]*align-items: flex-end;[^}]*padding: 6px 10px max\(2px, calc\(var\(--hud-safe-bottom\) - 4px\)\);/s);
    expect(styles).toMatch(/\.phone-menu-back,[\s\S]*?min-height: 44px;/);
    expect(styles).toMatch(/\.phone-menu-utility,[\s\S]*?min-height: 44px;/);
    expect(theme).toMatch(/\.phone-destination-body\s*\{[^}]*min-height: 0;[^}]*overflow: hidden auto;/s);
    expect(styles).toMatch(/\.phone-menu-layer\s*\{[^}]*overscroll-behavior-y: contain;/s);
    expect(styles).not.toMatch(/\.phone-menu-layer\s*\{[^}]*(?:overscroll-behavior-x|overscroll-behavior:\s*(?:contain|none))/s);
    expect(theme).toMatch(/\.character-slot-selector\s*\{[^}]*position: absolute;[^}]*inset: 0;/s);
    expect(theme).toMatch(/\.phone-flags-body\s*\{[^}]*min-width: 0;[^}]*grid-template-rows: auto minmax\(0, 1fr\);[^}]*overflow: hidden;/s);
  });
});
