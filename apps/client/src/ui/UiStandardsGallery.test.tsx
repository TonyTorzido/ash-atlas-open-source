// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { UiStandardsGallery } from "./UiStandardsGallery.js";

afterEach(cleanup);

describe("UiStandardsGallery", () => {
  it("documents the HUD lanes with live notice and loot feed rows", () => {
    render(<UiStandardsGallery />);
    expect(screen.getByRole("heading", { name: "HUD lanes" })).toBeTruthy();
    const notices = screen.getByRole("status", { name: "Notice lane example" });
    expect(within(notices).getAllByRole("listitem")).toHaveLength(3);
    const feed = screen.getByRole("group", { name: "Loot feed example" });
    expect(feed.textContent).toContain("Iron Shield ×1");
    expect(feed.textContent).toContain("+14 Gold");
    expect(feed.textContent).toContain("+20 Hunter XP");
  });

  it("renders the production achievement journal with its category grid", () => {
    render(<UiStandardsGallery />);
    const journal = screen.getByRole("region", { name: "Atlas Legends journal" });
    expect(within(journal).queryByRole("tablist", { name: "Journal views" })).toBeNull();
    expect(within(journal).getByRole("region", { name: "Pinned goals" })).toBeTruthy();
    expect(within(journal).getByRole("region", { name: "Journal categories" })).toBeTruthy();
    expect(within(journal).getByRole("progressbar", { name: "Prestige toward next rank" }).getAttribute("aria-valuemax")).toBe("100");
    const inventory = screen.getByRole("tablist", { name: "Inventory category example" });
    expect(within(inventory).getByRole("tab", { name: "Consumables" })).toBeTruthy();
    expect(within(inventory).getByRole("tab", { name: "Backpacks" })).toBeTruthy();
    expect(within(inventory).queryByRole("tab", { name: "Supplies" })).toBeNull();
  });

  it("keeps the full-screen app example on the canonical equal-width housed tab rail", () => {
    render(<UiStandardsGallery />);

    const appSections = screen.getByRole("tablist", { name: "App sections" });
    expect(appSections.classList.contains("game-app-tabs-housed")).toBe(true);
    expect(appSections.classList.contains("game-app-tabs-housed-scrollable")).toBe(false);
    expect(appSections.style.getPropertyValue("--game-app-tab-columns")).toBe("3");

    const longSections = screen.getByRole("tablist", { name: "Long app sections" });
    expect(longSections.classList.contains("game-app-tabs-housed")).toBe(true);
    expect(longSections.classList.contains("game-app-tabs-housed-scrollable")).toBe(true);
    const subsections = screen.getByRole("tablist", { name: "App subsection example" });
    expect(subsections.classList.contains("game-app-tabs-subtabs")).toBe(true);
    expect(subsections.classList.contains("game-app-tabs-subtabs-scrollable")).toBe(true);
    expect(screen.getByText(/Primary app sections use the housed rail; every secondary choice beneath it uses the canonical compact subtabs rail, including Inventory's horizontally scrollable mobile categories, Market category and order views, and Encyclopedia Normal versus Ashen appearances/)).toBeTruthy();
    const menu = document.querySelector<HTMLElement>(".skill-v3-ledger")!;
    const cleaveNode = within(menu).getByRole("button", { name: /Cleave, Rank 3 of 3/ });
    const cleaveIcon = cleaveNode.querySelector(".progression-icon-sprite");
    expect(cleaveIcon).toBeTruthy();
    expect(cleaveIcon?.getAttribute("data-sprite-key")).toBe("cleave");
    expect(cleaveNode.textContent).toContain("Cleave");
    expect(cleaveNode.dataset.state).toBe("learned");
    expect(cleaveNode.querySelector(".skill-v3-ledger-rank")?.textContent).toBe("3");
    const locked = within(menu).getByRole("button", { name: /Blight Strike, Rank 0 of 3, Locked/ });
    expect(locked.dataset.state).toBe("locked");
    expect(locked.getAttribute("aria-label")).toContain("Requires Pierce Armor 0/3");
    expect(cleaveNode.querySelector(".progression-icon-fallback")).toBeNull();
    expect(screen.getByRole("heading", { name: "World labels" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "World PNG zoom" })).toBeTruthy();
    expect(screen.getByText(/Touch and trackpad pinch do not scale document UI; pinch over the game map and wheel zoom remain map-owned, including Safari on Mac/)).toBeTruthy();
    expect(screen.getByText(/titled Progression and has five housed tabs.*bottom sheet on phone or a docked side panel on desktop.*Level columns/)).toBeTruthy();
    expect(document.querySelector(".ui-standards-app-preview .game-app-footer > .phone-menu-back")).toBeTruthy();
    expect(document.querySelector(".ui-standards-app-preview .game-app-footer > .phone-menu-return")).toBeTruthy();
    expect(document.querySelector(".ui-standards-app-preview .game-app-footer .game-app-action-bar")).toBeNull();
    const menuPreview = document.querySelector<HTMLElement>(".ui-standards-menu-preview");
    expect(menuPreview).toBeTruthy();
    const menuHeader = menuPreview!.querySelector<HTMLElement>(".phone-menu-root-header");
    expect(menuHeader).toBeTruthy();
    expect(menuHeader!.querySelector(".phone-menu-world-time")).toBeTruthy();
    expect(menuHeader!.querySelectorAll(".phone-menu-header-action")).toHaveLength(2);
    expect(within(menuHeader!).getByRole("button", { name: "Notice Board" }).getAttribute("title")).toBe("Notice Board");
    expect(within(menuHeader!).getByRole("button", { name: "Settings & Support" }).getAttribute("title")).toBe("Settings & Support");
    expect(menuPreview!.querySelectorAll(".phone-menu-root-footer button")).toHaveLength(2);
    expect(within(menuPreview!.querySelector(".phone-menu-root-footer")!).getByRole("button", { name: "Return to Game" })).toBeTruthy();
    expect(screen.getByText(/parchment atlas index/)).toBeTruthy();
    expect(screen.getByText(/Settings & Support exposes the Account → Delete Account entry/)).toBeTruthy();
    expect(screen.getByText(/Settings & Support is one canonical shell: housed Gameplay, Support, Account, and About sections expose contextual subtabs/)).toBeTruthy();
    expect(screen.getByText(/touch HUD uses a 52px three-zone footprint/)).toBeTruthy();
    expect(screen.getByText(/Desktop has no full-width bar: a top-left unit frame/)).toBeTruthy();
    expect(screen.getByText(/Messages and Atlas Chats float above the world without a mobile protection sheet/)).toBeTruthy();
    expect(within(screen.getByRole("navigation", { name: "Game commands" })).getAllByRole("button")).toHaveLength(15);
    expect(screen.getByText(/Settings & Support is a canonical GameAppShell with housed Gameplay, Support, Account, and About sections plus contextual subtabs.*Opening the shell focuses its container/)).toBeTruthy();
    expect(screen.getByRole("status", { name: "Server updating… · Back in a moment" })).toBeTruthy();
    expect(screen.getByRole("status", { name: "Reconnecting…" })).toBeTruthy();
    const constructionHeading = screen.getByRole("heading", { name: "Player construction countdown" });
    const constructionSection = constructionHeading.closest("section");
    expect(constructionSection).toBeTruthy();
    expect(screen.getByText(/ordinary player-built structures—Manor; Furnace, Tannery, Loom, and Kitchen; and city houses, facilities, and upgrades—share one authoritative 30-second duration/i)).toBeTruthy();
    expect(within(constructionSection!).getAllByRole("status").some((status) => status.textContent?.includes("Constructing · 30.0s remaining"))).toBe(true);
    const timerPreview = constructionSection!.querySelector<HTMLElement>(".world-activity-timer-plate");
    expect(timerPreview).toBeTruthy();
    expect(timerPreview!.querySelector("output")?.getAttribute("aria-label")).toBe("Furnace construction time remaining");
    expect(within(timerPreview!).getByRole("progressbar", { name: "Furnace construction progress" }).getAttribute("aria-valuenow")).toBe("58");
    expect(screen.getByText(/12px labels.*10px labels.*8px supporting text.*2px below the exact unassisted hitbox/)).toBeTruthy();
    expect(screen.getByText(/map zoom 13 or below.*remote player names.*eligible mob overhead health bars.*every active city-structure label.*local player never receives a world-space health bar.*City labels, including NPC Goblin Villages, stay visible.*transient combat feedback remains independent/)).toBeTruthy();
    expect(screen.getByText(/Tannery.*Loom.*Cistern Warrens/)).toBeTruthy();
    expect(screen.getByText(/one shared map zoom curve.*authored anchor and hit geometry/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Example"), { target: { value: "targets" } });
    expect(screen.getByText(/Map gesture ownership follows explicit intent/)).toBeTruthy();
    expect(screen.getByText(/native map panning begins immediately after its small movement threshold instead of waiting for click recognition/)).toBeTruthy();
  });
});
