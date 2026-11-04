import type { DroppedItemSnapshot } from "@ash-atlas/shared";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { clampDroppedItemPickupQuantity } from "../droppedItems/droppedItemModel.js";
import { PickupDroppedItemDialog } from "./PickupDroppedItemDialog.js";

describe("PickupDroppedItemDialog", () => {
  it("shows synchronized bounded controls for the known available quantity", () => {
    const html = renderToStaticMarkup(
      <PickupDroppedItemDialog
        drop={DROP}
        amount={3}
        onAmountChange={() => undefined}
        onCancel={() => undefined}
        onConfirm={() => undefined}
      />
    );
    expect(html).toContain("CHOOSE AMOUNT");
    expect(html).toContain("leather.png");
    expect(html).toContain("8 available");
    expect(html).toContain('aria-label="Pickup amount slider"');
    expect(html).toContain('aria-label="Pickup amount"');
    expect(html).toContain('max="8"');
    expect(html).toContain("Take 3");
  });

  it("bounds manual values from one through the current remainder", () => {
    expect(clampDroppedItemPickupQuantity(-4, 8)).toBe(1);
    expect(clampDroppedItemPickupQuantity(20, 8)).toBe(8);
    expect(clampDroppedItemPickupQuantity(4.9, 8)).toBe(4);
  });
});

const DROP: DroppedItemSnapshot = {
  dropId: "drop-1",
  droppedBy: "player-1",
  regionCode: "NM",
  itemId: "leather",
  variant: null,
  quantity: 8,
  status: "active",
  lat: 35,
  lon: -106,
  createdAt: "2026-07-09T12:00:00.000Z",
  expiresAt: "2026-07-09T12:10:00.000Z",
  pickedUpBy: null,
  pickedUpAt: null
};
