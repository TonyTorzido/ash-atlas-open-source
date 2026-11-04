import type { DroppedItemSnapshot } from "@ash-atlas/shared";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { DroppedItemInteraction } from "../droppedItems/droppedItemModel.js";
import { DroppedItemPrompt } from "./DroppedItemPrompt.js";

describe("DroppedItemPrompt", () => {
  it("shows an idle selected stack without implying movement or pickup", () => {
    const html = renderPrompt(null);
    expect(html).toContain("Wood");
    expect(html).toContain("Take All (3)");
    expect(html).toContain("Take Some");
    expect(html).not.toContain("secondary");
    expect(html).toContain("wood.png");
    expect(html).toContain("Cancel");
    expect(html).not.toContain("GROUND LOOT");
    expect(html).not.toContain("available");
    expect(html).not.toContain("m away");
    expect(html).not.toContain("pickup range");
    expect(html).not.toContain("Moving into pickup range");
    expect(html).not.toContain("Picking up…");
  });

  it("closes instead of showing an approach status after pickup starts", () => {
    const html = renderPrompt({
      dropId: "drop-1",
      phase: "approaching",
      intent: { mode: "all" }
    });
    expect(html).toBe("");
  });

  it("stays closed while a pickup request is in flight", () => {
    const html = renderPrompt({
      dropId: "drop-1",
      phase: "requesting",
      intent: { mode: "quantity", quantity: 2 }
    });
    expect(html).toBe("");
  });

  it("combines identical rows and offers item-wide plus pile-wide pickup actions", () => {
    const leatherOne = {
      ...DROP,
      dropId: "drop-leather-1",
      itemId: "leather" as const,
      quantity: 2,
      pileId: "combat:mob-1:defeat:1",
      pileOrder: 0
    };
    const wood = { ...DROP, quantity: 5, pileId: leatherOne.pileId, pileOrder: 1 };
    const leatherTwo = {
      ...leatherOne,
      dropId: "drop-leather-2",
      quantity: 4,
      pileOrder: 2
    };
    const prompt = <DroppedItemPrompt
      drops={[leatherTwo, wood, leatherOne]}
      disabled={false}
      interaction={null}
      onPickupStack={() => undefined}
      onPickupPile={() => undefined}
      onChooseAmount={() => undefined}
      onCancel={() => undefined}
    />;
    const html = renderToStaticMarkup(prompt);

    expect(html.indexOf("Leather")).toBeLessThan(html.indexOf("Wood"));
    expect(html.match(/>Leather</g)).toHaveLength(1);
    expect(html).toContain("Take All (6)");
    expect(html).toContain("Take All (5)");
    expect(html).toContain("Take All (11)");
    expect(html.match(/Take All/g)).toHaveLength(3);
    expect(html).toContain("Choose an item");
    expect(html).toContain(`<h2 aria-label="Choose Item">Choose Item`);
    expect(html).not.toContain("Ground Loot");
  });
});

describe("DroppedItemPrompt unique drops", () => {
  it("offers one Pick Up for a dropped backpack, named by its level", () => {
    const backpackDrop: DroppedItemSnapshot = {
      ...DROP,
      dropId: "drop-pack",
      itemId: "starter_backpack",
      quantity: 1,
      backpackInstanceId: "11111111-1111-4111-8111-111111111111",
      backpack: {
        instanceId: "11111111-1111-4111-8111-111111111111",
        ownerPlayerId: "player-1",
        definitionId: "starter_backpack",
        displayName: "Backpack +2",
        location: "world_drop",
        upgradeLevel: 2,
        equippedSlot: null,
        manorId: null,
        manorSlotIndex: null,
        version: 2,
        createdAt: DROP.createdAt,
        updatedAt: DROP.createdAt
      }
    };
    const html = renderToStaticMarkup(<DroppedItemPrompt
      drops={[backpackDrop]}
      disabled={false}
      interaction={null}
      onPickupStack={() => undefined}
      onPickupPile={() => undefined}
      onChooseAmount={() => undefined}
      onCancel={() => undefined}
    />);
    expect(html).toContain("Backpack +2");
    expect(html).toContain("Pick Up");
    expect(html).not.toContain("Take Some");
    expect(html).not.toContain("Take All");
  });
});

function renderPrompt(interaction: DroppedItemInteraction | null): string {
  return renderToStaticMarkup(
    <DroppedItemPrompt
      drops={[DROP]}
      disabled={false}
      interaction={interaction}
      onPickupStack={() => undefined}
      onPickupPile={() => undefined}
      onChooseAmount={() => undefined}
      onCancel={() => undefined}
    />
  );
}

const DROP: DroppedItemSnapshot = {
  dropId: "drop-1",
  droppedBy: "player-1",
  regionCode: "NM",
  itemId: "wood",
  variant: null,
  quantity: 3,
  status: "active",
  lat: 35,
  lon: -106,
  createdAt: "2026-07-09T12:00:00.000Z",
  expiresAt: "2026-07-09T12:10:00.000Z",
  pickedUpBy: null,
  pickedUpAt: null
};
