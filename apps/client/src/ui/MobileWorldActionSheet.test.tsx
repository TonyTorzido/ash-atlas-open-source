import type { CollectibleNode } from "@ash-atlas/shared";
import { fireEvent, render } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  collectibleDisplayName,
  harvestActionLabel
} from "../collectibles/harvest.js";
import { ItemArtwork } from "./ItemArtwork.js";
import { MobileWorldActionSheet } from "./MobileWorldActionSheet.js";

describe("MobileWorldActionSheet", () => {
  it("uses contextual primary labels for current and future resource rows", () => {
    expect(harvestActionLabel(node())).toBe("Chop");
    expect(harvestActionLabel({ ...node(), repeatableNodeType: "stone_mine" })).toBe("Gather");
    expect(harvestActionLabel({ ...node(), type: "food" })).toBe("Gather");
  });

  it("renders only the compact Giving Tree action content", () => {
    const tree = node();
    const html = renderToStaticMarkup(
      <MobileWorldActionSheet
        displayName={collectibleDisplayName(tree)}
        primaryActionLabel={harvestActionLabel(tree)}
        primaryActionEnabled
        onPrimaryAction={vi.fn()}
        onClose={vi.fn()}
      />
    );

    expect(html).toContain(">Giving Tree<");
    expect(html).toContain(">Chop<");
    expect(html).toContain(">Cancel<");
    expect(html).toContain("game-compact-cancel");
    expect(html).not.toMatch(/Type|Available|Distance|Interaction range/);
    expect(html).toContain('aria-label="Giving Tree actions"');
  });

  it("offers resin harvesting as a separate mobile action", () => {
    const onSecondaryAction = vi.fn();
    const view = render(
      <MobileWorldActionSheet
        displayName="Giving Tree"
        primaryActionLabel="Chop"
        primaryActionEnabled
        secondaryActionLabel="Gather Resin"
        onPrimaryAction={vi.fn()}
        onSecondaryAction={onSecondaryAction}
        onClose={vi.fn()}
      />
    );

    fireEvent.click(view.getByRole("button", { name: "Gather Resin" }));
    expect(onSecondaryAction).toHaveBeenCalledOnce();
    view.unmount();
  });

  it("hides an unavailable Shield Charge and keeps the split layout with a full-width Cancel row", () => {
    const view = render(<MobileWorldActionSheet
      displayName="Dire Wolf"
      primaryActionLabel="Attack"
      primaryActionEnabled
      secondaryActionLabel="Shield Charge"
      secondaryActionEnabled={false}
      secondaryDisabledReason="Switch to melee stance to use Shield Charge."
      splitActionLayout
      onPrimaryAction={vi.fn()}
      onSecondaryAction={vi.fn()}
      onClose={vi.fn()}
    />);

    const actions = view.container.querySelector(".game-compact-actions--primary-quick")!;
    expect(actions).toBeTruthy();
    expect(view.queryByRole("button", { name: "Shield Charge" })).toBeNull();
    expect(view.queryByText("Switch to melee stance to use Shield Charge.")).toBeNull();
    expect(view.getByRole("button", { name: "Cancel" }).classList.contains("game-compact-cancel")).toBe(true);
    view.unmount();
  });

  it("renders an optional middle action between primary and secondary", () => {
    const view = render(
      <MobileWorldActionSheet
        displayName="Flag"
        primaryActionLabel="Visit"
        primaryActionEnabled
        middleActionLabel="Harden"
        middleActionEnabled
        secondaryActionLabel="More"
        onPrimaryAction={vi.fn()}
        onMiddleAction={vi.fn()}
        onSecondaryAction={vi.fn()}
        onClose={vi.fn()}
      />
    );

    expect(view.getAllByRole("button").slice(0, 3).map((button) => button.textContent))
      .toEqual(["Visit", "Harden", "More"]);
    view.unmount();
  });

  it("locks every compact action while Visit or the middle action is busy", () => {
    const props = {
      displayName: "Flag",
      primaryActionLabel: "Visit",
      primaryActionEnabled: true,
      middleActionLabel: "Harden",
      middleActionEnabled: true,
      secondaryActionLabel: "More",
      onPrimaryAction: vi.fn(),
      onMiddleAction: vi.fn(),
      onSecondaryAction: vi.fn(),
      onClose: vi.fn()
    };
    const view = render(<MobileWorldActionSheet {...props} middleActionBusy />);

    for (const label of ["Visit", "Harden", "More", "Cancel"]) {
      expect((view.getByRole("button", { name: label }) as HTMLButtonElement).disabled).toBe(true);
    }

    view.rerender(<MobileWorldActionSheet {...props} actionBusy />);
    expect((view.getByRole("button", { name: "Harden" }) as HTMLButtonElement).disabled).toBe(true);
    expect(view.getAllByRole("button").slice(0, 3).map((button) => button.textContent))
      .toEqual(["Visit", "Harden", "More"]);
    view.unmount();
  });

  it("shows authoritative ground-item artwork, quantity, and both pickup actions", () => {
    const html = renderToStaticMarkup(
      <MobileWorldActionSheet
        displayName="Leather"
        artwork={<ItemArtwork itemId="leather" label="Leather" />}
        detail="Quantity: 83"
        primaryActionLabel="Pick Up"
        primaryActionEnabled
        secondaryActionLabel="Pick Up All"
        onPrimaryAction={vi.fn()}
        onSecondaryAction={vi.fn()}
        onClose={vi.fn()}
      />
    );

    expect(html).toContain("leather.png");
    expect(html).toContain(">Leather<");
    expect(html).toContain("Quantity: 83");
    expect(html).toContain(">Pick Up<");
    expect(html).toContain(">Pick Up All<");
    expect(html).toContain(">Cancel<");
  });

  it("keeps close separate from the primary action", () => {
    const onPrimaryAction = vi.fn();
    const onClose = vi.fn();
    const view = render(
      <MobileWorldActionSheet
        displayName="Stone Mine"
        primaryActionLabel="Mine"
        primaryActionEnabled
        onPrimaryAction={onPrimaryAction}
        onClose={onClose}
      />
    );

    fireEvent.click(view.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(onPrimaryAction).not.toHaveBeenCalled();
  });

  it("closes on a tap outside the sheet, not on a drag outside or a tap inside", () => {
    const onClose = vi.fn();
    const view = render(
      <MobileWorldActionSheet
        displayName="Giving Tree (Fruiting)"
        primaryActionLabel="Chop"
        primaryActionEnabled
        secondaryActionLabel="Gather Berries"
        onPrimaryAction={vi.fn()}
        onSecondaryAction={vi.fn()}
        onClose={onClose}
      />
    );

    // jsdom's pointer events drop coordinates, so send mouse-shaped ones.
    const pointer = (target: Element, type: string, x: number, y: number): void => {
      target.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: x, clientY: y }));
    };
    const heading = view.container.querySelector(".game-compact-prompt--sheet h2")!;
    pointer(heading, "pointerdown", 10, 10);
    pointer(heading, "pointerup", 10, 10);
    expect(onClose).not.toHaveBeenCalled();
    pointer(document.body, "pointerdown", 10, 10);
    pointer(document.body, "pointerup", 80, 90);
    expect(onClose).not.toHaveBeenCalled();
    pointer(document.body, "pointerdown", 10, 10);
    pointer(document.body, "pointerup", 12, 11);
    expect(onClose).toHaveBeenCalledOnce();
    // Cancel comes after the actions in reading and tab order.
    const buttons = Array.from(view.container.querySelectorAll("button"), (button) => button.getAttribute("aria-label") ?? button.textContent);
    expect(buttons).toEqual(["Chop", "Gather Berries", "Cancel"]);
  });

  it("hides an unavailable primary action and shows no reason text", () => {
    const view = render(
      <MobileWorldActionSheet
        displayName="Stone Mine"
        primaryActionLabel="Mine"
        primaryActionEnabled={false}
        disabledReason="Finish the current gathering action first."
        onPrimaryAction={vi.fn()}
        onClose={vi.fn()}
      />
    );

    expect(view.container.querySelector(".mobile-world-action-primary")).toBeNull();
    expect(view.container.querySelector(".game-compact-disabled-reason")).toBeNull();
    expect(view.queryByText("Finish the current gathering action first.")).toBeNull();
  });
});

function node(): CollectibleNode {
  return {
    id: "tree-a",
    type: "wood",
    lat: 35,
    lon: -106,
    quantity: 4,
    state: "available",
    createdAt: "2026-07-23T00:00:00.000Z",
    harvestedAt: null,
    sourceCellId: "cell",
    waterKind: null
  };
}
// @vitest-environment jsdom
