import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { DestinationShell } from "./DestinationShell.js";
import { PhoneMenuDestinationShell } from "./PhoneMenuDestinationShell.js";

describe("shared destination shell contract", () => {
  it("marks the shared shell for phone and desktop treatment", () => {
    const html = renderToStaticMarkup(
      <DestinationShell open title="Example" eyebrow="Ledger" closeLabel="Close" onClose={() => undefined}>
        <p>Content</p>
      </DestinationShell>
    );
    expect(html).toContain("destination-shell phone-destination-shell desktop-destination-shell");
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');

    const phone = renderToStaticMarkup(
      <PhoneMenuDestinationShell eyebrow="Ledger" title="Example" onBack={() => undefined}>
        <p>Content</p>
      </PhoneMenuDestinationShell>
    );
    expect(phone).toContain("phone-menu-layer phone-destination-shell");
    expect(phone).toContain("phone-menu-header");
    expect(phone).toContain("phone-destination-body");
    expect(phone).toContain("phone-menu-footer");
    expect(phone).toContain("Back to Game Menu");
    expect(phone).toContain("Return to Game");
    expect(phone).not.toContain("destination-shell-close");
  });

  it("can keep a destination-specific Back action without a duplicate Return to Game action", () => {
    const phone = renderToStaticMarkup(
      <DestinationShell
        open
        title="Manor Storage"
        eyebrow="Owner chest"
        closeLabel="Close"
        layout="phone"
        phoneBackLabel="Back to Manor"
        phoneShowReturnToGame={false}
        onClose={() => undefined}
      >
        <p>Storage</p>
      </DestinationShell>
    );
    expect(phone).toContain("Back to Manor");
    expect(phone).not.toContain("Return to Game");
  });

  it("uses the contract across every major non-menu destination root", () => {
    const directory = fileURLToPath(new URL(".", import.meta.url));
    const files = [
      "CharacterPanel.tsx",
      "InventoryPanel.tsx",
      "FlagListPanel.tsx",
      "SocialProfileOverlay.tsx",
      "WarriorClassPanel.tsx",
      "WorldMapOverlay.tsx",
      "PetPanel.tsx",
      "DirectMessagesPanel.tsx"
    ];
    for (const file of files) {
      const source = readFileSync(`${directory}/${file}`, "utf8");
      expect(source, file).toMatch(/(?:GameAppShell|PhoneMenuDestinationShell|DestinationShell)/);
    }
    const phoneHud = readFileSync(`${directory}/PhoneHud.tsx`, "utf8");
    expect((phoneHud.match(/<PhoneMenuDestinationShell/g) ?? [])).toHaveLength(1);
  });

  it("makes the contract full-viewport on phone and intentional on desktop", () => {
    const directory = fileURLToPath(new URL(".", import.meta.url));
    const theme = readFileSync(`${directory}/../ashAtlasTheme.css`, "utf8");
    expect(theme).toMatch(/data-ui-profile="phone"\] \.phone-destination-shell\s*\{[^}]*width: 100%;[^}]*height: var\(--app-viewport-height\);[^}]*border-radius: 0;/s);
    expect(theme).toMatch(/data-ui-profile="phone"\] \.phone-destination-body\s*\{[^}]*min-height: 0;[^}]*overflow: hidden auto;/s);
    expect(theme).toMatch(/\.destination-shell\s*\{[^}]*width: min\(1080px,[^}]*height: min\(760px,/s);
  });

  it("keeps Profile, Character, and Inventory responsibilities separate", () => {
    const directory = fileURLToPath(new URL(".", import.meta.url));
    const profile = readFileSync(`${directory}/SocialProfileOverlay.tsx`, "utf8");
    const character = readFileSync(`${directory}/CharacterPanel.tsx`, "utf8");
    const inventory = readFileSync(`${directory}/InventoryPanel.tsx`, "utf8");
    expect(profile).not.toContain("character-slot-grid");
    expect(profile).not.toContain("inventory-item-grid");
    expect(character).toContain("character-slot-grid");
    expect(character).not.toContain("inventoryPanelRows");
    expect(inventory).toContain("inventory-carry-list");
    expect(inventory).not.toContain("character-slot-grid");
  });
});
