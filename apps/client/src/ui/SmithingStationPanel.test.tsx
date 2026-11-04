// @vitest-environment jsdom

import {
  emptyEquipmentSlots,
  emptyInventoryTotals,
  requireEquipmentDefinition,
  resolveEquipmentCombatStats,
  resolveEquipmentItemDerivedStats,
  type EquipmentDefinitionId,
  type EquipmentInstanceV2,
  type EquipmentLocation,
  type EquipmentSnapshotV2,
  type PlayerInventorySnapshot
} from "@ash-atlas/shared";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  SmithingStationPanel,
  type SmithingStationUpgradeFeedback
} from "./SmithingStationPanel.js";

afterEach(cleanup);

const SWORD_ID = "00000000-0000-4000-8000-000000000001";
const TUNIC_ID = "00000000-0000-4000-8000-000000000003";

describe("SmithingStationPanel", () => {
  it("shows character-level gating without calling an item maximum", () => {
    const view = renderPanel({
      equipment: snapshot([
        item("starter_sword", SWORD_ID, 12, "Personal Sword", "equipped", {
          nextUpgradeLevel: 13,
          nextUpgradeCost: "450",
          upgradeDisabledReason: "character_level_required"
        })
      ], 12)
    });
    expect(screen.getByText("Requires character level 13.")).toBeTruthy();
    expect(screen.queryByText("Maximum level")).toBeNull();
    expect(screen.getByRole("button", { name: "Upgrade to level 13" }))
      .toHaveProperty("disabled", true);

    view.rerender(panel({
      equipment: snapshot([
        item("starter_sword", SWORD_ID, 12, "Personal Sword", "equipped", {
          nextUpgradeLevel: 13,
          nextUpgradeCost: "450",
          upgradeDisabledReason: null
        })
      ], 13)
    }));
    expect(screen.getAllByRole("img", { name: "Can craft" }).length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Upgrade to level 13" }))
      .toHaveProperty("disabled", false);
  });

  it("labels only Level-25 equipment as maximum", () => {
    renderPanel({
      equipment: snapshot([
        item("starter_sword", SWORD_ID, 25, "Personal Sword", "equipped", {
          nextUpgradeLevel: null,
          nextUpgradeCost: null,
          upgradeDisabledReason: "maximum_level"
        })
      ], 25)
    });
    expect(screen.getByText("Maximum level")).toBeTruthy();
    expect(screen.getByText("This item is already at the global maximum level."))
      .toBeTruthy();
  });

  it.each(["OWNER", "PARTY", "TRAVEL_INVITE"] as const)(
    "shows only the %s occupant's carried and equipped equipment",
    (accessSource) => {
      const onUpgrade = vi.fn(() => "manor-upgrade");
      renderPanel({
        manorSession: { sessionId: "manor-session", accessSource },
        equipment: snapshot([
          item("starter_sword", SWORD_ID, 2, "Personal Sword", "equipped"),
          item("padded_tunic", TUNIC_ID, 3, "Personal Tunic", "inventory")
        ]),
        onUpgrade
      });

      expect(screen.getByRole("dialog", { name: "Smithing Station" })).toBeTruthy();
      expect(itemButton("Personal Sword")).toBeTruthy();
      expect(itemButton("Personal Tunic")).toBeTruthy();
      expect(screen.queryByText(/city|armory|weaponsmith|membership|facility tier/i))
        .toBeNull();

      fireEvent.click(screen.getByRole("button", { name: "Upgrade to level 3" }));
      fireEvent.click(screen.getByRole("button", { name: "Confirm Upgrade" }));
      expect(onUpgrade).toHaveBeenCalledWith(
        expect.objectContaining({ ownerPlayerId: "player-1" }),
        "manor-session"
      );
    }
  );

  it.each([
    "manor_storage",
    "world_drop",
    "market_escrow",
    "market_collection",
    "destroyed"
  ] as const)("does not offer %s equipment for upgrade", (location) => {
    renderPanel({
      equipment: snapshot([
        item("starter_staff", SWORD_ID, 2, "Unavailable Staff", location),
        item("padded_tunic", TUNIC_ID, 3, "Carried Tunic", "inventory")
      ])
    });

    expect(screen.queryByText("Unavailable Staff")).toBeNull();
    expect(itemButton("Carried Tunic")).toBeTruthy();
  });

  it("requires a manor session and retains the last snapshot during refresh", () => {
    const view = renderPanel({
      equipment: snapshot([
        item("starter_sword", SWORD_ID, 2, "Personal Sword", "equipped")
      ])
    });
    view.rerender(panel({ equipment: null }));
    expect(screen.getAllByText("Personal Sword")).toHaveLength(2);

    view.rerender(panel({ manorSession: null }));
    expect(screen.getByText(
      "Upgrade equipment at a Smithing Station inside a manor."
    )).toBeTruthy();
  });

  it("shows authoritative success and error feedback", () => {
    const success: SmithingStationUpgradeFeedback = {
      kind: "success",
      requestId: "upgrade-1",
      instanceId: SWORD_ID,
      displayName: "Personal Sword",
      levelAfter: 3
    };
    const view = renderPanel({ feedback: success });
    expect(screen.getByText("Personal Sword upgraded to level 3.")).toBeTruthy();

    view.rerender(panel({
      feedback: {
        kind: "error",
        requestId: "upgrade-2",
        instanceId: SWORD_ID,
        code: "MANOR_SMITH_ACCESS_DENIED",
        message: "Move closer to the Smithing Station."
      }
    }));
    expect(screen.getByText("Move closer to the Smithing Station.")).toBeTruthy();
  });

  it("confirms stock crafting only when the required materials are available", () => {
    const onCraft = vi.fn(() => "craft-request");
    renderPanel({
      inventory: {
        playerId: "player-1",
        revision: 1,
        items: [],
        totals: { ...emptyInventoryTotals(), iron_bar: 10, wood: 50 }
      },
      onCraft
    });

    fireEvent.click(screen.getByRole("tab", { name: "Craft" }));
    fireEvent.click(screen.getAllByRole("button", { name: "Craft" })[0]!);
    fireEvent.click(screen.getByRole("button", { name: "Craft item" }));
    expect(onCraft).toHaveBeenCalledWith(
      expect.objectContaining({ familyId: "sword", definitionId: "starter_sword" }),
      "manor-session"
    );
    expect(screen.getAllByRole("button", { name: "Craft" })[1])
      .toHaveProperty("disabled", true);
  });

  it("groups swag recipes under their base weapon and crafts them with the swag recipe", () => {
    const onCraft = vi.fn(() => "craft-request");
    renderPanel({
      inventory: {
        playerId: "player-1",
        revision: 1,
        items: [],
        totals: { ...emptyInventoryTotals(), iron_bar: 10, wood: 50, rusted_legion_blade: 3, ancient_coin: 3 }
      },
      onCraft
    });

    fireEvent.click(screen.getByRole("tab", { name: "Craft" }));
    const swordGroup = screen.getByRole("region", { name: "Sword swag recipes" });
    expect(swordGroup.querySelectorAll("article")).toHaveLength(3);
    expect(screen.getByRole("group", { name: "Barrow Blade materials" })).toBeTruthy();
    const gladius = screen.getByRole("heading", { name: "Legion Gladius" }).closest("article")!;
    fireEvent.click(gladius.querySelector("button")!);
    fireEvent.click(screen.getByRole("button", { name: "Craft item" }));
    expect(onCraft).toHaveBeenCalledWith(
      expect.objectContaining({
        familyId: "sword",
        definitionId: "legion_gladius",
        baseDefinitionId: "starter_sword"
      }),
      "manor-session"
    );
    const barrow = screen.getByRole("heading", { name: "Barrow Blade" }).closest("article")!;
    expect(barrow.querySelector("button")).toHaveProperty("disabled", true);
  });

  it("keeps the Limited tab with an empty state when no sales are active", () => {
    renderPanel();
    fireEvent.click(screen.getByRole("tab", { name: "Limited" }));
    expect(screen.getByText("No limited equipment is for sale")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Buy" })).toBeNull();
  });
});

type PanelOverrides = Partial<{
  equipment: EquipmentSnapshotV2 | null;
  inventory: PlayerInventorySnapshot;
  walletGold: string | null;
  online: boolean;
  busy: boolean;
  feedback: SmithingStationUpgradeFeedback | null;
  manorSession: {
    sessionId: string;
    accessSource: "OWNER" | "PARTY" | "TRAVEL_INVITE";
  } | null;
  onUpgrade: (item: EquipmentInstanceV2, manorSessionId: string) => string | null;
  onCraft: NonNullable<ComponentProps<typeof SmithingStationPanel>["onCraft"]>;
  onPurchase: NonNullable<ComponentProps<typeof SmithingStationPanel>["onPurchase"]>;
}>;

function renderPanel(overrides: PanelOverrides = {}) {
  return render(panel(overrides));
}

function panel(overrides: PanelOverrides = {}) {
  return (
    <SmithingStationPanel
      open
      equipment={overrides.equipment === undefined
        ? snapshot([
            item("starter_sword", SWORD_ID, 2, "Personal Sword", "equipped")
          ])
        : overrides.equipment}
      {...(overrides.inventory === undefined ? {} : { inventory: overrides.inventory })}
      walletGold={overrides.walletGold === undefined ? "500" : overrides.walletGold}
      online={overrides.online ?? true}
      busy={overrides.busy ?? false}
      feedback={overrides.feedback ?? null}
      layout="desktop"
      manorSession={overrides.manorSession === undefined
        ? { sessionId: "manor-session", accessSource: "OWNER" }
        : overrides.manorSession}
      onUpgrade={overrides.onUpgrade ?? vi.fn(() => "upgrade-request")}
      {...(overrides.onCraft === undefined ? {} : { onCraft: overrides.onCraft })}
      {...(overrides.onPurchase === undefined ? {} : { onPurchase: overrides.onPurchase })}
      onRetryData={vi.fn()}
      onClose={vi.fn()}
    />
  );
}

function itemButton(name: string): HTMLButtonElement {
  return screen.getByRole("button", { name: new RegExp(name) }) as HTMLButtonElement;
}

function item(
  definitionId: EquipmentDefinitionId,
  instanceId: string,
  level: number,
  displayName: string,
  location: EquipmentLocation,
  upgrade: Pick<
    EquipmentInstanceV2,
    "nextUpgradeLevel" | "nextUpgradeCost" | "upgradeDisabledReason"
  > = {
    nextUpgradeCost: "10",
    nextUpgradeLevel: level + 1,
    upgradeDisabledReason: null
  }
): EquipmentInstanceV2 {
  const definition = requireEquipmentDefinition(definitionId);
  const derived = resolveEquipmentItemDerivedStats({
    item: { instanceId, definition, itemLevel: level },
    slot: definition.slot,
    classId: "warrior"
  });
  return {
    instanceId,
    definitionId,
    displayName,
    ownerPlayerId: "player-1",
    location,
    ...(location === "inventory" ? { inventorySlotIndex: 1 } : {}),
    equippedSlot: location === "equipped" ? definition.slot : null,
    itemLevel: level,
    maximumItemLevel: 25,
    category: definition.category,
    balanceVersion: 1,
    enchantmentIdentity: null,
    attackPowerBonus: Math.round(derived.pveAttackContribution),
    defenseBonus: Math.round(derived.pveDefenseContribution),
    weaponCategory: definition.weaponCategory,
    armorCategory: definition.armorCategory,
    twoHanded: definition.twoHanded,
    savedKitIndices: [],
    derived,
    ...upgrade,
    createdAt: "2026-07-27T00:00:00.000Z",
    updatedAt: "2026-07-27T00:00:00.000Z"
  };
}

function snapshot(
  instances: EquipmentInstanceV2[],
  characterLevel = 25
): EquipmentSnapshotV2 {
  return {
    snapshotVersion: 2,
    balanceVersion: 2,
    playerId: "player-1",
    characterLevel,
    repairMessage: null,
    instances,
    active: emptyEquipmentSlots(null),
    readiedWeaponSlot: "melee",
    activeKitIndex: null,
    kits: [],
    inventoryRevision: 1,
    activeRevision: 0,
    checkpointRevision: 0,
    derivedStats: resolveEquipmentCombatStats({
      context: "pvp_open_world",
      characterLevel,
      classId: "warrior",
      classRank: 0,
      loadout: {
        active: emptyEquipmentSlots(null),
        readiedWeaponSlot: "melee"
      }
    }),
    weapon: null,
    chest: null,
    totalAttackPowerBonus: 0,
    totalDefenseBonus: 0
  };
}
