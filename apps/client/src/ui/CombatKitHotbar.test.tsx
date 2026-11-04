// @vitest-environment jsdom

import { emptyEquipmentSlots, type CombatKitSnapshot } from "@ash-atlas/shared";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CombatKitHotbar,
  reconcileEquipmentSnapshot
} from "./CombatKitHotbar.js";

afterEach(cleanup);

function kit(
  kitIndex: CombatKitSnapshot["kitIndex"],
  valid = true
): CombatKitSnapshot {
  return {
    kitIndex,
    name: `Kit ${kitIndex}`,
    readiedWeaponSlot: "melee",
    items: emptyEquipmentSlots(null),
    valid,
    invalidReason: valid ? null : "incomplete",
    revision: 0
  };
}

describe("CombatKitHotbar", () => {
  it("always renders six controls with active, pending, and invalid state", () => {
    render(
      <CombatKitHotbar
        kits={[kit(1), kit(2, false)]}
        activeKitIndex={1}
        pendingKitIndex={null}
        disabled={false}
        onActivate={() => undefined}
      />
    );

    expect(screen.getAllByRole("button")).toHaveLength(6);
    expect(screen.getByRole("button", { name: "Kit 1: Active" }).getAttribute(
      "aria-pressed"
    )).toBe("true");
    expect((screen.getByRole("button", {
      name: "Kit 2: Save equipped items to this kit first."
    }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", {
      name: "Kit 6: Waiting for equipment snapshot."
    }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("activates valid kits with non-conflicting Shift+1 through Shift+6", () => {
    const onActivate = vi.fn();
    render(
      <div>
        <input aria-label="Kit name" />
        <CombatKitHotbar
          kits={[kit(6)]}
          activeKitIndex={null}
          pendingKitIndex={null}
          disabled={false}
          onActivate={onActivate}
        />
      </div>
    );

    fireEvent.keyDown(window, { code: "Digit6", key: "6" });
    fireEvent.keyDown(window, { code: "Digit6", key: "^", shiftKey: true });
    fireEvent.keyDown(screen.getByLabelText("Kit name"), {
      code: "Digit6",
      key: "^",
      shiftKey: true
    });

    expect(onActivate).toHaveBeenCalledOnce();
    expect(onActivate).toHaveBeenCalledWith(6);
  });

  it("does not activate while another switch is pending", () => {
    const onActivate = vi.fn();
    render(
      <CombatKitHotbar
        kits={[kit(1), kit(2)]}
        activeKitIndex={1}
        pendingKitIndex={2}
        disabled={false}
        onActivate={onActivate}
      />
    );

    fireEvent.keyDown(window, { code: "Digit1", key: "!", shiftKey: true });
    fireEvent.click(screen.getByRole("button", { name: "Kit 2: Switching…" }));
    expect(onActivate).not.toHaveBeenCalled();
  });

  it("reverts the optimistic active indicator after a rejected activation", () => {
    const view = render(
      <CombatKitHotbar
        kits={[kit(1), kit(2)]}
        activeKitIndex={2}
        pendingKitIndex={2}
        disabled={false}
        onActivate={() => undefined}
      />
    );
    expect(screen.getByRole("button", { name: "Kit 2: Switching…" }).getAttribute(
      "aria-pressed"
    )).toBe("true");

    view.rerender(
      <CombatKitHotbar
        kits={[kit(1), kit(2)]}
        activeKitIndex={1}
        pendingKitIndex={null}
        disabled={false}
        onActivate={() => undefined}
      />
    );

    expect(screen.getByRole("button", { name: "Kit 1: Active" }).getAttribute(
      "aria-pressed"
    )).toBe("true");
    expect(screen.getByRole("button", { name: "Kit 2: Shift+2" }).getAttribute(
      "aria-pressed"
    )).toBe("false");
  });

  it("ignores stale mutation snapshots across every monotonic revision", () => {
    const current = { inventoryRevision: 4, activeRevision: 7, checkpointRevision: 3 };
    expect(reconcileEquipmentSnapshot(current, {
      inventoryRevision: 3,
      activeRevision: 8,
      checkpointRevision: 4
    })).toBe(current);
    expect(reconcileEquipmentSnapshot(current, {
      inventoryRevision: 5,
      activeRevision: 6,
      checkpointRevision: 4
    })).toBe(current);
    expect(reconcileEquipmentSnapshot(current, {
      inventoryRevision: 5,
      activeRevision: 8,
      checkpointRevision: 4
    })).toEqual({
      inventoryRevision: 5,
      activeRevision: 8,
      checkpointRevision: 4
    });
  });

  it("accepts a lower-revision authoritative snapshot after the connection epoch resets", () => {
    const priorConnection = {
      inventoryRevision: 9,
      activeRevision: 8,
      checkpointRevision: 8
    };
    const restartedServer = {
      inventoryRevision: 9,
      activeRevision: 7,
      checkpointRevision: 7
    };

    expect(reconcileEquipmentSnapshot(priorConnection, restartedServer)).toBe(priorConnection);
    expect(reconcileEquipmentSnapshot(null, restartedServer)).toBe(restartedServer);
  });
});
