import { describe, expect, it } from "vitest";

import {
  DEFAULT_MOBILE_MENU_ORDER,
  MOBILE_MENU_DESTINATIONS,
  MOBILE_MENU_ROOT_FOOTER,
  MOBILE_MENU_ROOT_UTILITIES,
  MOBILE_MENU_ROOT_PRIMARY,
  MOBILE_MENU_ROOT_SECTIONS,
  MOBILE_MENU_ROOT_REALM,
  MOBILE_MENU_ROOT,
  mobileMenuHistoryFromState,
  mobileMenuViewFromHistoryState
} from "./mobileGameMenu.js";

describe("mobile game menu order", () => {
  it("keeps the canonical order and the legacy equipment route stable", () => {
    expect(MOBILE_MENU_DESTINATIONS.find(({ id }) => id === "equipment")?.label).toBe("Inventory");
    expect(MOBILE_MENU_DESTINATIONS.find(({ id }) => id === "profile")?.label).toBe("Profile");
    expect(MOBILE_MENU_DESTINATIONS.find(({ id }) => id === "character")?.label).toBe("Character");
    expect(MOBILE_MENU_DESTINATIONS.find(({ id }) => id === "party")?.label).toBe("Party");
    expect(MOBILE_MENU_DESTINATIONS.find(({ id }) => id === "classes")?.label).toBe("Progression");
    expect(MOBILE_MENU_DESTINATIONS.map(({ id }) => String(id))).not.toContain("professions");
    expect(new Set(MOBILE_MENU_DESTINATIONS.map(({ id }) => id)).size).toBe(23);
    expect(MOBILE_MENU_DESTINATIONS.find(({ id }) => id === "city")?.label).toBe("City");
    expect(MOBILE_MENU_DESTINATIONS.find(({ id }) => id === "kingdom")?.label).toBe("Kingdom");
    expect(MOBILE_MENU_DESTINATIONS.find(({ id }) => id === "flags")?.label).toBe("Land Management");
    expect(MOBILE_MENU_DESTINATIONS.find(({ id }) => id === "leaderboards")?.label).toBe("Leaderboards");
    expect(MOBILE_MENU_DESTINATIONS.find(({ id }) => id === "creature-book")?.label).toBe("Encyclopedia");
    expect(MOBILE_MENU_DESTINATIONS.find(({ id }) => id === "miscellaneous")?.label).toBe("Settings & Support");
    expect(MOBILE_MENU_DESTINATIONS.find(({ id }) => id === "announcements")?.label).toBe("Announcements");
    expect(MOBILE_MENU_DESTINATIONS.find(({ id }) => id === "patch-notes")?.label).toBe("Patch Notes");
    expect(DEFAULT_MOBILE_MENU_ORDER).toEqual(MOBILE_MENU_DESTINATIONS.map(({ id }) => id));
  });

  it("keeps the shallow root grids and header utility destinations in canonical order", () => {
    expect(MOBILE_MENU_ROOT_PRIMARY.map(({ id }) => id)).toEqual([
      "equipment", "classes", "pet-chamber", "creature-book",
      "messages", "contacts", "party", "leaderboards",
      "world-map", "crafting", "build", "flags",
      "shop"
    ]);
    expect(MOBILE_MENU_ROOT_SECTIONS.map(({ label, entries }) => [label, entries.length])).toEqual([
      ["Adventurer", 4], ["Fellowship", 4], ["Realm", 4], ["Store", 1]
    ]);
    expect(MOBILE_MENU_ROOT_REALM).toEqual([]);
    expect(MOBILE_MENU_ROOT.map(({ id }) => id)).toEqual([
      ...MOBILE_MENU_ROOT_PRIMARY.map(({ id }) => id),
      ...MOBILE_MENU_ROOT_REALM.map(({ id }) => id)
    ]);
    expect(MOBILE_MENU_ROOT_PRIMARY.map(({ label }) => label)).toEqual([
      "Inventory", "Progression", "Pets", "Encyclopedia",
      "Messages", "Contacts", "Party", "Rankings",
      "Atlas", "Crafting", "Construction", "Land",
      "Shop"
    ]);
    expect(MOBILE_MENU_ROOT_UTILITIES.map(({ id, label }) => [id, label])).toEqual([
      ["announcements", "Notice Board"],
      ["miscellaneous", "Settings & Support"]
    ]);
    expect(MOBILE_MENU_ROOT_FOOTER).toBe(MOBILE_MENU_ROOT_UTILITIES);
    expect(MOBILE_MENU_DESTINATIONS.map(({ id }) => id)).toEqual(expect.arrayContaining([
      "character", "achievements", "bug-report", "miscellaneous"
    ]));
  });

  it("parses only owned history markers", () => {
    expect(mobileMenuViewFromHistoryState({ ashAtlasMobileMenuView: "classes" })).toBe("classes");
    expect(mobileMenuViewFromHistoryState({ ashAtlasMobileMenuView: "unknown" })).toBe("gameplay");
  });

  it("ignores retired category markers while retaining destination history", () => {
    expect(mobileMenuHistoryFromState({
      ashAtlasMobileMenuView: "messages",
      ashAtlasMobileMenuCategory: "social",
      ashAtlasMobileMenuDepth: 3
    })).toMatchObject({ view: "messages", category: null, ownedDepth: 3 });
    expect(mobileMenuHistoryFromState({
      ashAtlasMobileMenuView: "character",
      ashAtlasMobileMenuCategory: "adventurer",
      ashAtlasMobileMenuDepth: 3
    })).toMatchObject({ view: "character", category: null });
  });
});
