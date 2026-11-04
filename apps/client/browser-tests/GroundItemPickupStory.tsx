import type { DroppedItemSnapshot } from "@ash-atlas/shared";
import { useEffect, useState } from "react";

import { ItemArtwork } from "../src/ui/ItemArtwork.js";
import { MobileWorldActionSheet } from "../src/ui/MobileWorldActionSheet.js";
import { PickupDroppedItemDialog } from "../src/ui/PickupDroppedItemDialog.js";

declare global {
  interface Window {
    groundPickupRequests: Array<"all" | number>;
  }
}

const DROP: DroppedItemSnapshot = {
  dropId: "11111111-1111-4111-8111-111111111111",
  droppedBy: "player-2",
  regionCode: "NM",
  itemId: "leather",
  variant: null,
  quantity: 83,
  status: "active",
  lat: 35,
  lon: -106,
  createdAt: "2026-07-25T00:00:00.000Z",
  expiresAt: "2026-07-25T00:10:00.000Z",
  pickedUpBy: null,
  pickedUpAt: null
};

export function GroundItemPickupStory(): React.JSX.Element {
  const [selectorOpen, setSelectorOpen] = useState(false);
  const [amount, setAmount] = useState(83);
  window.groundPickupRequests ??= [];

  useEffect(() => {
    document.documentElement.dataset.uiProfile = "phone";
    return () => {
      delete document.documentElement.dataset.uiProfile;
    };
  }, []);

  return (
    <main className="mobile-app" style={{ minHeight: "100vh" }}>
      <MobileWorldActionSheet
        displayName="Leather"
        artwork={<ItemArtwork itemId="leather" label="Leather" />}
        detail="Quantity: 83"
        primaryActionLabel="Pick Up"
        primaryActionEnabled
        secondaryActionLabel="Pick Up All"
        onPrimaryAction={() => setSelectorOpen(true)}
        onSecondaryAction={() => window.groundPickupRequests.push("all")}
        onClose={() => undefined}
      />
      {selectorOpen ? (
        <PickupDroppedItemDialog
          drop={DROP}
          amount={amount}
          onAmountChange={setAmount}
          onCancel={() => setSelectorOpen(false)}
          onConfirm={() => {
            window.groundPickupRequests.push(amount);
            setSelectorOpen(false);
          }}
        />
      ) : null}
      <footer
        data-testid="phone-dock"
        style={{
          position: "fixed",
          right: 0,
          bottom: 0,
          left: 0,
          height: 64,
          background: "#17110d"
        }}
      />
    </main>
  );
}
